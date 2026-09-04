// scripts/m1a/dual-write.mjs
// M1a 双写（T3b）——**库**：只有「外层排序锁」+「request_key 派生」+「固定多笔序列编排」。
// 按任务边界（T3b：只 drop 库 + 测试，T3a 合并后才接）**不接任何 concrete legacy 写方**
// （inbound-route / topic-generation / binder……），本模块不知道它们的存在。
import path from "node:path";
import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { resolveEndpointDir, canonKey, sha256 } from "../topic-agent-ledger.mjs";

const REQKEY_LEN = 40; // 通式要求 .slice(0,40)
const en = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;

/* ── 外层排序锁 ─────────────────────────────────────────────── */

/** 锁路径：ledger/<ep>/m1a-order.lock（§5：与账本内锁 ledger.lock 不同路径、不同时持有）。 */
export function m1aOrderLockPath(endpointId, env = process.env) {
  const d = resolveEndpointDir(endpointId, { env, mustExistRoot: true });
  if (!d.ok) return { ok: false, reason: d.reason, why: d.why ?? null, lock: null };
  return { ok: true, lock: path.join(d.dir, "m1a-order.lock") };
}

/** 取外层排序锁：走 registry 发布锁协议（**带维护门**，门在→取不到锁）。contention→publisher_busy→折成 binding_busy（整笔拒，§5）。 */
export function acquireOrderLock(endpointId, env = process.env, opts = {}) {
  const p = m1aOrderLockPath(endpointId, env);
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why, path: null };
  const r = acquirePublishLock(p.lock, { staleMs: opts.staleMs, now: opts.now, afterReap: opts.afterReap, reapUnrecognized: false });
  if (r.ok) return { ok: true, token: r.token, lock: p.lock };
  if (r.reason === "maintenance") return { ok: false, reason: "maintenance", gate: r.gate, text: r.text, lock: p.lock };
  if (r.reason === "publisher_busy") return { ok: false, reason: "binding_busy", path: p.lock };
  if (r.reason === "lock_residue" || r.reason === "reaped_uncleared") return { ok: false, reason: r.reason, path: p.lock };
  return { ok: false, reason: r.reason ?? "lock_failed", path: p.lock, why: r.error ?? null };
}

/** 释放外层排序锁：走 registry releasePublishLock（按 HELD 令牌归属，只放自己的）。 */
export function releaseOrderLock(endpointId, env = process.env, opts = {}) {
  const p = m1aOrderLockPath(endpointId, env);
  if (!p.ok) return { ok: false, reason: p.reason };
  return releasePublishLock(p.lock, opts);
}

/* ── request_key 派生（§5.1 通式） ───────────────────────────── */

/** 通式：`request_key = "m1a_" + sha256(canonKey({ domain:"m1a-rk-1", external_request_id, op_type, entity_id })).slice(0,40)`。 */
export function requestKeyFor({ opType, externalRequestId, entityId }) {
  if (typeof opType !== "string" || !/^[a-z0-9_]+$/.test(opType)) return { ok: false, reason: "bad_op_type", why: "opType 只认小写字母/数字/下划线" };
  if (!en(externalRequestId)) return { ok: false, reason: "bad_external_request_id", why: "externalRequestId 必须是 1..256 字符串" };
  if (!en(entityId)) return { ok: false, reason: "bad_entity_id", why: "entityId 必须是 1..256 字符串" };
  const digest = sha256(Buffer.from(canonKey({ domain: "m1a-rk-1", external_request_id: externalRequestId, op_type: opType, entity_id: entityId }), "utf-8")).slice(0, REQKEY_LEN);
  return { ok: true, request_key: "m1a_" + digest };
}

/* ── §5.1 固定多笔序列表（封闭） ────────────────────────────── */

const SEQUENCES = {
  a1_materialize: ["create_a1"],
  bind_claim: ["create_a1", "activate"], // 固定顺序：先 create_a1 后 activate
  attach: ["attach"],
  rotate: ["create_b1"],
  rotate_cancel: ["void"],
  pause_resume: ["unbind", "restore"],
  retarget: ["retarget"],
  enabled_flip: ["unbind", "restore"],
  migrate_seed: ["migrate_seed"],
  migrate_repair: ["migrate_repair"],
};

/** §5.1 表内某 legacy 写方对应的**固定顺序** op 序列（复制返回，改不脏表）。表外=null，须先补表。 */
export function sequenceFor(kind) {
  const s = SEQUENCES[kind];
  return s ? [...s] : null;
}

/* ── 崩溃续跑多笔编排 ──────────────────────────────────────── */

/**
 * 固定顺序多笔 + 崩溃续跑：**每一笔**都按步骤字面参数确定性派生 request_key；
 * 命中已执行（isExecuted 读账本 request_key 集）→ 跳过该步；否则调用 step.execute(key)。
 * 库既不做 legacy 写、也不自带对账读，`isExecuted` 由调用方注入（T3a 接入运行时才连账本）。
 * 顺序：先取外层排序锁 → 逐笔（派生 key → 查重放 → execute）→ finally 释放。
 * 任何取锁/某笔失败 → { ok:false, reason, step?, request_key? }，不继续（legacy 已提交=权威成立，shadow 缺=mismatch）。
 * 同步执行（execute 须同步，未接线前不引入异步脚手架；T3a 接真实写方时再决定是否 async）。
 */
export function runFixedSequence({ endpointId, env = process.env, steps, acquire = acquireOrderLock, release = releaseOrderLock, isExecuted = null }) {
  const acq = acquire(endpointId, env);
  if (!acq.ok) return { ok: false, reason: acq.reason, why: acq.why ?? null, path: acq.path ?? null, lock: acq.lock ?? null };
  try {
    const executed = [];
    for (const step of steps) {
      const keyRes = requestKeyFor({ opType: step.opType, externalRequestId: step.externalRequestId, entityId: step.entityId });
      if (!keyRes.ok) return { ok: false, reason: keyRes.reason, why: keyRes.why ?? null, step: step.opType };
      const key = keyRes.request_key;
      if (isExecuted && isExecuted(key)) { executed.push({ opType: step.opType, request_key: key, skipped: true }); continue; }
      const r = step.execute(key);
      if (!r || r.ok !== true) return { ok: false, reason: r?.reason ?? "step_failed", step: step.opType, request_key: key, why: r?.why ?? null };
      executed.push({ opType: step.opType, request_key: key, skipped: false, result: r.result ?? null });
    }
    return { ok: true, lock: acq.lock, executed };
  } finally {
    release(endpointId, env);
  }
}
