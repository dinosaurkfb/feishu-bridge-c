// scripts/m1a/dual-write.mjs
// M1a 双写（T3b）——**库**：只有「外层排序锁」+「request_key 派生」两个原语。
// 按任务边界（T3b：只 drop 库 + 测试，T3a 合并后才接）**不接任何 concrete legacy 写方**
// （inbound-route / topic-generation / binder……），本模块不知道它们的存在。
//
// #R29 P1.3（取向 a）：本轮删除 runFixedSequence 编排器与固定序列表 —— 库不接 legacy 回调、
// 接受任意步序、只看 key 不核 fingerprint、pause 错做成 unbind→restore 两步，编排器放在这里只会腐化；
// 真正的步序在 T3a 合并接线时按账本事务裁定。本轮只保留锁 + request_key 原语。
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

/**
 * 释放投影（#R30 P2：**结构化 {reason, path, error}**，不折成单字符串；#R29 P1.2 仍把每支折进结果，绝不吞不穿）。
 *   absent        → {ok:false, reason:"lock_lost"}（主锁在持有期间已缺席）；not_owner → {ok:false, reason:"lock_instance_replaced"}（被接管）。
 *   二者都意味着「本次写段的独占性无法证明」，必须让调用方非零收场（评审探针：曾被当作成功）。
 *   release_busy → {ok:false, reason:"release_busy"}；reapUncleared → {ok:false, reason:"reap_uncleared", path:<.reaped-<uuid>>, error}。
 *   释放抛错（EIO / EPERM…）不裸抛（评审探针：EIO 曾从释放阶段穿出去），折成 {ok:false, reason:"release_threw", error}。
 *   `expectedToken`（#R30 P1.3）绑定本次 acquisition：不同 / 陈旧句柄释放 → not_owner → lock_instance_replaced（不碰当前持有者）。
 */
function releaseCore(lock, opts = {}) {
  try {
    const rel = releasePublishLock(lock, { waitMs: opts.waitMs, expectedToken: opts.expectedToken ?? null });
    if (rel?.reapUncleared) return { ok: false, reason: "reap_uncleared", path: rel.reapUncleared.path, error: rel.reapUncleared.error ?? null, why: "reap_uncleared：" + String(rel.reapUncleared.error ?? ""), lock };
    if (rel?.ok && rel.absent) return { ok: false, reason: "lock_lost", path: lock, error: null, why: "lock_lost：主锁在持有期间已缺席（被删除或回收）—— 本次写段的独占性无法证明，请人工核对", lock };
    if (rel?.ok) return { ok: true, lock };
    if (rel?.reason === "not_owner") return { ok: false, reason: "lock_instance_replaced", path: lock, error: null, why: "lock_instance_replaced：锁已被别的实例持有（本次持有期间被接管）—— 本次写段的独占性无法证明，请人工核对", lock };
    if (rel?.reason === "release_busy") return { ok: false, reason: "release_busy", path: lock, error: null, why: "release_busy：归属转换段被别人占用（回收段只有几毫秒），锁未释放—— 请重试或人工核对", lock };
    return { ok: false, reason: "release_failed", path: lock, error: rel?.reason ?? null, why: "release_failed：" + String(rel?.reason ?? "unknown"), lock };
  } catch (err) {
    return { ok: false, reason: "release_threw", path: lock, error: err?.code ?? (err?.message ?? err) ?? null, why: "release_threw：" + String(err?.code ?? err?.message ?? err), lock };
  }
}

/**
 * 取外层排序锁：走 registry 发布锁协议（**带维护门**，门在→取不到锁）。
 * #R30 P1.2：staleMs **硬编码 ∞**（生产不可覆盖）—— **只按持有者 pid 活性接管**（同 install-surface），
 * 时间不构成陈旧判据（m1a 写段可长，活着就不该被抢；探针：活锁+老 at+staleMs:0 曾被接管）。
 * now/afterReap 仅测试注入，不影响 staleMs；reapUnrecognized=false（未知形状交人工）。
 * return 带 `release()` 闭包，**绑定本次 acquisition 的 token**（#R30 P1.3，不透明 instance-bound handle），
 * 只经它释放；拿不到一律受控返回：maintenance | binding_busy | lock_residue | reaped_uncleared/reap_uncleared | io_error。
 * 残骸 reason/path/error **保留原语原样**（#R29 P2.1：.reaped-<uuid> / .reap 不折成主锁路径）。
 */
export function acquireOrderLock(endpointId, env = process.env, opts = {}) {
  const p = m1aOrderLockPath(endpointId, env);
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why ?? null, lock: null };
  let r;
  try {
    r = acquirePublishLock(p.lock, { staleMs: Number.POSITIVE_INFINITY, now: opts.now, afterReap: opts.afterReap, reapUnrecognized: false });
  } catch (err) {
    return { ok: false, reason: "io_error", why: "锁原语抛错：" + String(err?.code ?? err?.message ?? err), path: p.lock };
  }
  if (r.ok) return { ok: true, token: r.token, lock: p.lock, release: () => releaseCore(p.lock, { waitMs: opts.waitMs, expectedToken: r.token }) };
  if (r.reason === "maintenance") return { ok: false, reason: "maintenance", gate: r.gate, text: r.text, lock: p.lock };
  if (r.reason === "publisher_busy") return { ok: false, reason: "binding_busy", path: p.lock, why: "另一个写方正持有 m1a-order 锁" };
  if (r.reason === "lock_residue") return { ok: false, reason: "lock_residue", path: r.path ?? p.lock, error: r.error ?? null, why: "锁位置形状不对（不是本协议的 symlink payload）—— 只人工处置" };
  if (r.reason === "reaped_uncleared" || r.reason === "reap_uncleared") return { ok: false, reason: r.reason, path: r.path ?? p.lock, error: r.error ?? null, why: r.error ?? ("锁被回收后残骸未清（" + r.reason + "）：" + (r.path ?? p.lock)) };
  return { ok: false, reason: r.reason ?? "lock_failed", path: p.lock, error: r.error ?? null, why: r.error ?? null };
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
