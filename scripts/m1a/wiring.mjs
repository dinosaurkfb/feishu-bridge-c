// scripts/m1a/wiring.mjs
// M1a 双写接线（#R36，T3b 之后）——**封闭 per-writer 包装层**。
// 规格：m1a-reconciliation.md §5 / §5.1（writer→账本事务全映射 + request_key 逐 op 派生 +
// 外层锁无降级 + 多笔序列固定顺序/崩溃续跑 + legacy no-op 仍走 shadow 后缀）。
//
// 结构：每个 legacy 写方一个**具名**函数，内部复用 runWired 骨架：
//   outer 锁（m1a-order.lock，instance-bound）→ legacy 提交回调 → shadow 序列（固定顺序、
//   逐笔 request_key 派生表实现，账本裁定 replay/conflict）→ 释放锁。
//   outer busy → 整笔 binding_busy 拒；shadow 失败**不改变 legacy 成功语义**（回执照常，mismatch 留 doctor）。
// 崩溃续跑：request_key 一律由**持久外部 id**（消息 id / claim key / rotation operation id /
//   控制 claim key）确定性派生，故同 writer 动作重放命中账本幂等重放、跳过已提交后缀。
//
// 边界：本模块不知道具体 legacy 写方（inbound-route / topic-generation / register……）长什么样；
//   它们只经 `legacy` 回调注入自己的提交逻辑。调用方负责在提交点外包本层。
import { acquireOrderLock, requestKeyFor } from "./dual-write.mjs";
import {
  createA1, createB1, activate, attach, voidPending, unbind, restore, retarget,
} from "../topic-agent-ledger.mjs";

const en = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;

/* 逐 op request_key 派生（§5.1 通式；op_type 小写字母/数字/下划线）。 */
function rk(opType, externalRequestId, entityId) {
  return requestKeyFor({ opType, externalRequestId, entityId });
}

/* 捕获一次 shadow 提交，绝不抛出；返回 { op, result } 或 { op, ok:false, reason, why }。 */
function capture(op, res) {
  if (!res || typeof res !== "object") return { op, ok: false, reason: "shadow_nonobject", why: "shadow 提交未返回对象" };
  if (res.ok === true) return { op, ok: true, result: res.result ?? null, idempotent: res.idempotent === true, committed: res.commit ?? null, sha256: res.sha256 ?? null };
  if (res.ok === false) return { op, ok: false, reason: res.reason ?? "shadow_rejected", why: res.why ?? null };
  return { op, ok: false, reason: "shadow_unknown" };
}

/* 外层排序锁骨架：legacy → shadow 序列 → 释放。 */
function runWired({ endpointId, env = process.env, legacy, submit }) {
  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) return { ok: false, commit: "not_committed", reason: acq.reason ?? "binding_busy", why: acq.why ?? null, lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
  let result;
  try {
    let legacyRes;
    try { legacyRes = legacy(); }
    catch (err) { return { ok: false, commit: "not_committed", reason: "legacy_failed", why: String(err?.message ?? err), legacy: null, shadow: null, release: null }; }
    const shadow = submit(legacyRes) ?? [];
    result = { ok: true, legacy: legacyRes, shadow, release: null };
    return result;
  } finally {
    const rel = acq.release();
    if (result && typeof result === "object") result.release = rel;
  }
}

/* ── per-writer 具名函数（§5.1 每一行一个） ─────────────────── */

/**
 * wireCreateA1 —— 两链所有 A1 物化入口（任一受验首条 @ 的 chat 记录）→ 账本 create_a1。
 * ext=入站 message id；entity=受验 Aily session locator；key 一请求一值。
 */
export function wireCreateA1({ endpointId, env = process.env, legacy, chatId, sessionId, messageId, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(messageId) || !en(sessionId)) return [{ op: "create_a1", ok: false, reason: "bad_external_id", why: "messageId/sessionId 必填 1..256 字符串" }];
    const k = rk("create_a1", messageId, sessionId);
    if (!k.ok) return [{ op: "create_a1", ...k }];
    return [capture("create_a1", createA1({ endpointId, requestKey: k.request_key, chatId, sessionId, now, env }))];
  } });
}

/**
 * wireBindClaim —— bind/认领（claim→绑定：引用码、@ 配对）→ create_a1 → activate（固定顺序）。
 * ext=claim key；create_a1 entity=session locator、activate entity=B1 topic_agent_id（两笔 key 不同）。
 * 调用方须能解析出 shadow 侧 b1Id（M1a 期来自 migrate_seed/create_b1 的 B1）。
 */
export function wireBindClaim({ endpointId, env = process.env, legacy, claimKey, chatId, sessionId, b1Id, f4, authorizedBy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(claimKey) || !en(sessionId) || !en(b1Id)) return [{ op: "create_a1", ok: false, reason: "bad_external_id", why: "claimKey/sessionId/b1Id 必填 1..256 字符串" }];
    const kA1 = rk("create_a1", claimKey, sessionId);
    if (!kA1.ok) return [{ op: "create_a1", ...kA1 }];
    const a1 = capture("create_a1", createA1({ endpointId, requestKey: kA1.request_key, chatId, sessionId, now, env }));
    if (!a1.ok) return [a1]; // create_a1 失败（如 locator 撞）→ 序列必须停（activate 需 a1Id）
    const a1Id = a1.result?.created_id;
    const kAct = rk("activate", claimKey, b1Id);
    if (!kAct.ok) return [a1, { op: "activate", ...kAct }];
    return [a1, capture("activate", activate({ endpointId, requestKey: kAct.request_key, b1Id, a1Id, f4, authorizedBy, now, env }))];
  } });
}

/**
 * wireAttach —— 显式 attach（终端）→ 账本 attach（内部按当前族拆 attach_a2|attach_a3，一笔 key）。
 * ext=控制 claim key（终端命令 claim 机制既有、持久）；entity=目标 id。
 */
export function wireAttach({ endpointId, env = process.env, legacy, claimKey, id, bindingTarget, authorizedBy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(claimKey) || !en(id)) return [{ op: "attach", ok: false, reason: "bad_external_id", why: "claimKey/id 必填 1..256 字符串" }];
    const k = rk("attach", claimKey, id);
    if (!k.ok) return [{ op: "attach", ...k }];
    return [capture("attach", attach({ endpointId, requestKey: k.request_key, id, bindingTarget, claimKey, authorizedBy, now, env }))];
  } });
}

/**
 * wireRotate —— rotate（建新代际）→ 账本 create_b1。
 * ext=rotation operation id（topic-generation 既有、持久）；entity=lineage id。
 */
export function wireRotate({ endpointId, env = process.env, legacy, rotationOpId, lineageId, chatId, rootOm, bindingTarget, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(rotationOpId) || !en(lineageId)) return [{ op: "create_b1", ok: false, reason: "bad_external_id", why: "rotationOpId/lineageId 必填 1..256 字符串" }];
    const k = rk("create_b1", rotationOpId, lineageId);
    if (!k.ok) return [{ op: "create_b1", ...k }];
    return [capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm, lineageId, bindingTarget, now, env }))];
  } });
}

/**
 * wireVoid —— rotate cancel / pending 过期 → 账本 void。
 * ext=rotation operation id；entity=目标 id（voided binding / B1）。
 */
export function wireVoid({ endpointId, env = process.env, legacy, rotationOpId, id, reason, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(rotationOpId) || !en(id)) return [{ op: "void", ok: false, reason: "bad_external_id", why: "rotationOpId/id 必填 1..256 字符串" }];
    const k = rk("void", rotationOpId, id);
    if (!k.ok) return [{ op: "void", ...k }];
    return [capture("void", voidPending({ endpointId, requestKey: k.request_key, b1Id: id, reason, now, env }))];
  } });
}

/**
 * wirePauseResume —— 连接暂停/恢复（binding_status paused/active 翻转的写方；非 /feishu-mode）。
 * pause=mode"pause"→unbind（只动 current B3）；resume=mode"resume"→restore。历史 B4 由账本 self 拒。
 * ext=该次终端命令的**持久控制 claim key / 命令审计 id**（禁止临时随机）；entity=目标 id。
 */
export function wirePauseResume({ endpointId, env = process.env, legacy, controlClaimKey, id, mode, now = Date.now() }) {
  if (mode !== "pause" && mode !== "resume") return { ok: false, commit: "not_committed", reason: "bad_mode", why: "mode 只认 pause|resume", legacy: null, shadow: null, release: null };
  const opType = mode === "pause" ? "unbind" : "restore";
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(controlClaimKey) || !en(id)) return [{ op: opType, ok: false, reason: "bad_external_id", why: "controlClaimKey/id 必填 1..256 字符串" }];
    const k = rk(opType, controlClaimKey, id);
    if (!k.ok) return [{ op: opType, ...k }];
    const fn = mode === "pause" ? unbind : restore;
    return [capture(opType, fn({ endpointId, requestKey: k.request_key, id, now, env }))];
  } });
}

/**
 * wireEnabledFlip —— `enabled` 翻转（§4 行）→ unbind / restore。
 * disabled→unbind（映 paused）、restore 恢复 enabled→restore。历史 B4 不动（账本 self 拒）。
 * ext=同上持久控制 claim key；entity=目标 id。
 */
export function wireEnabledFlip({ endpointId, env = process.env, legacy, controlClaimKey, id, mode, now = Date.now() }) {
  // 语义与 pause/resume 同构（unbind↔disabled、restore↔enabled）：复用 wirePauseResume。
  return wirePauseResume({ endpointId, env, legacy, controlClaimKey, id, mode: mode === "disable" ? "pause" : mode === "enable" ? "resume" : "resume", now });
}

/**
 * wireRetarget —— retarget（owner 终端）→ 账本 retarget（per-record/per-lineage，CAS 锁内精确）。
 * ext=同上持久控制 claim key；entity=目标 id；expectedOldTarget=new?——新旧 target 由调用方给（CAS 由账本裁决）。
 */
export function wireRetarget({ endpointId, env = process.env, legacy, controlClaimKey, id, expectedOldTarget, newTarget, authorizedBy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(controlClaimKey) || !en(id)) return [{ op: "retarget", ok: false, reason: "bad_external_id", why: "controlClaimKey/id 必填 1..256 字符串" }];
    const k = rk("retarget", controlClaimKey, id);
    if (!k.ok) return [{ op: "retarget", ...k }];
    return [capture("retarget", retarget({ endpointId, requestKey: k.request_key, id, expectedOldTarget, newTarget, authorizedBy, now, env }))];
  } });
}
