// scripts/m1a/wiring.mjs
// M1a 双写接线（#R36，T3b 之后）——**封闭 per-writer 包装层**。
// 规格：m1a-reconciliation.md §5 / §5.1（writer→账本事务全映射 + request_key 逐 op 派生 +
// 外层锁无降级 + 多笔序列固定顺序/崩溃续跑 + legacy no-op 仍走 shadow 后缀）。
//
// 结构：每个 legacy 写方一个**具名**函数，内部复用 runWired 骨架：
//   outer 锁（m1a-order.lock，instance-bound）→ legacy 提交回调 → shadow 序列（固定顺序、
//   逐笔 request_key 派生表实现，账本裁定 replay/conflict）→ 释放锁。
//   outer busy → 整笔 binding_busy 拒；shadow 失败**不改变 legacy 成功语义**（回执照常，mismatch 留 doctor）。
//   M1a 逐端点原子启用（收据状态）：never_initialized → 合法 legacy-only（不取 outer、不写 shadow）；
//   已启用点任一取锁失败 → 整笔拒（skip 集为空）；收据说不清 → fail-closed。
// 崩溃续跑：request_key 一律由**持久外部 id**（消息 id / claim key / rotation operation id /
//   控制 claim key）确定性派生，故同 writer 动作重放命中账本幂等重放、跳过已提交后缀。
//
// 边界：本模块不知道具体 legacy 写方（inbound-route / topic-generation / register……）长什么样；
//   它们只经 `legacy` 回调注入自己的提交逻辑。调用方负责在提交点外包本层。
import { acquireOrderLock, requestKeyFor } from "./dual-write.mjs";
import {
  createA1, createB1, activate, attach, voidPending, unbind, restore, retarget,
  resolveLiveId, loadByEndpoint,
} from "../topic-agent-ledger.mjs";
import { endpointReceipt } from "../maintenance/ledger-receipt.mjs";
import { maintenanceDir } from "../maintenance/journal.mjs";
import { legacyEndpointId } from "../subscription.mjs";

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

/* 外层排序锁骨架：legacy → shadow 序列 → 释放。
 * legacy 是权威；shadow 为镜像。已启用点任一取锁失败 → 整笔拒（skip 集为空，不降级）；
 * 仅取得 outer **后** 的 shadow 后半程失败 → 保留已成立的 legacy 结果，shadow[i] 投影失败（mismatch 留 doctor）。 */
// M1a 逐端点原子启用（#R37 裁定补充 §5）：判据是**收据状态**（endpointReceipt），不是运行时 root_absent，
//   · never_initialized（无 done ledger_init）→ 合法 legacy-only：不取 outer、不写 shadow。
//   · 收据/账本说不清（冲突/进行中/读不出）→ fail-closed：不得写 legacy-only。
//   · state === "ok"（ledger_init done）→ 双写强制：**任一取锁失败都不得写 legacy**（错误名不能证明无并发写方）。
// 已启用点外层锁无降级（裁定：可 skip 的失败集为空）；只有**取得 outer 后**的 shadow 后半程失败，
// 才保留已成立的 legacy 结果并外显 mismatch（shadow[i] 投影失败）。
function runWired({ endpointId, env = process.env, legacy, submit, lockOnly = false }) {
  const recDir = maintenanceDir(env);
  const receipt = typeof recDir === "string" && recDir.length > 0
    ? endpointReceipt(recDir, endpointId)
    : { ok: false, state: "unreadable", why: "维护目录不可派生，M1a 收据不可读（fail-closed）" };
  if (receipt.state === "never_initialized") {
    // M1a 未启用 → 合法 legacy-only：不取 outer、不写 shadow 后缀。
    let legacyRes;
    try { legacyRes = legacy(); }
    catch (err) { return { ok: false, commit: "not_committed", reason: "legacy_failed", why: String(err?.message ?? err), legacy: null, shadow: null, release: null }; }
    return { ok: true, legacy: legacyRes, shadow: [], release: null };
  }
  if (!receipt.ok) {
    // 收据/账本说不清 → fail-closed：不写 shadow 未镜像的 legacy。
    return { ok: false, commit: "not_committed", reason: "m1a_receipt_fail_closed", why: receipt.why ?? "M1a 收据不可读，fail-closed", legacy: null, shadow: null, release: null };
  }
  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) {
    // 双写强制下任一取锁失败（busy/maintenance/root_*/dir_*/lock_residue/reap_*/io_error）都不得写 legacy。
    return { ok: false, commit: "not_committed", reason: acq.reason ?? "binding_busy", why: acq.why ?? null, lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
  }
  let result;
  try {
    // P1-1（#R37 返修）：已启用点取得 outer 后、legacy 前核账本现场 ——
    //   cutover 已切（authoritative）→ M1a 不得再写 legacy（ledger-only 写方属 M1b）；
    //   账本现场不可读/缺席 → 无法镜像 legacy，整笔拒；authority_mode 非 shadow → 同样拒。
    if (receipt.cutoverDone === true) {
      result = { ok: false, commit: "not_committed", reason: "m1a_mode_not_shadow", why: "已切权威（cutover done）：M1a 代码不得在切换后再写 legacy（ledger-only 写方属 M1b）", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    const ledger = loadByEndpoint(endpointId, { env });
    if (!ledger.ok) {
      result = { ok: false, commit: "not_committed", reason: "m1a_ledger_absent", why: "已启用端点账本现场不可读/缺席（" + (ledger.reason ?? "unknown") + "）：M1a 无法镜像 legacy，fail-closed", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    if (ledger.doc.authority_mode !== "shadow") {
      result = { ok: false, commit: "not_committed", reason: "m1a_mode_not_shadow", why: "账本 authority_mode=" + ledger.doc.authority_mode + "：M1a 代码不得在切换后再写 legacy", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    let legacyRes;
    try { legacyRes = legacy(); }
    catch (err) {
      result = { ok: false, commit: "not_committed", reason: "legacy_failed", why: String(err?.message ?? err), legacy: null, shadow: null, release: null };
      return result;
    }
    // legacy 明确未提交（ok:false）→ 无 legacy 结果可镜像 → 不跑 shadow 后缀（不写幽灵记录/标记）。
    // W4（P1-3③）：lock-only 行（连接暂停/恢复、enabled 翻转）不写 shadow 事务——对账兜底（doctor+repair），
    //   但 outer 锁必须取（绕过 outer 就穿了 cutover 快照窗口）；对账兜底=无双写，**不是无锁**。
    const shadow = lockOnly ? [] : (legacyRes && legacyRes.ok === false ? [] : (submit(legacyRes) ?? []));
    result = { ok: true, legacy: legacyRes, shadow, release: null };
    return result;
  } finally {
    const rel = acq.release();
    if (result && typeof result === "object") result.release = rel;
  }
}

/* ── per-writer 具名函数（§5.1 每一行一个） ─────────────────── */

/* A1 物化（chat）双写接线：把入站 chat 的 endpoint（agent_uid 派生）/oc_ chat_id / Aily
 * session_id / message_id 一并线程进 wireCreateA1，legacy 回调为 admitChat。
 * #R37：wrapper 层面即执行裁定 —— 已启用点任一取锁失败 → 整笔拒、不写 legacy；
 *   never_initialized → 合法 legacy-only；收据说不清 → fail-closed。可用性取 drop（裁定默认）。
 * 这是入站 chat 流的 A1 写入口，专供 inbound.mjs chatTurn 使用（运行时恒为 claude）。 */
export function wireChatA1({ agentUid, chatId, sessionId, messageId, env = process.env, admit, runtime = "claude", now = Date.now() }) {
  return wireCreateA1({
    endpointId: legacyEndpointId({ runtime, agentUid }), env, legacy: admit,
    chatId, sessionId, messageId, now,
  });
}

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
 * wirePromoteBinding —— 认领→绑定（promoteBinding：引用码/@ 配对把 pending 拉成 active）。
 * shadow 由 resolver 按 locator 命中目标，按其事实分叉：
 *   W1（B1 仍 pending）→ create_a1 → activate（标准四项配对证明 + 64hex claimKey）；
 *   W2（B3 已 active 换会话，再认领）→ retarget（同 root，换 ledger 侧 claude_session_id）。
 * locator = 被认领代际的根消息 om（= matched_om）；claimKey = claim.mjs 64hex key（调用方用
 *   claimKey(messageId, logicalTaskKey) 派生）；retargetClaudeSessionId 仅 W2 需要，必须是被
 *   retarget 的目标在 ledger 侧的 claude_session_id（UUID），不是 Aily session locator（不相容）。
 * 目标状态与 locator 对不上（如无 shadow 记录）/读不出）→ fail-closed，不猜。 */
export function wirePromoteBinding({
  endpointId, env = process.env, legacy, locator, claimKey, sessionId, authorizedBy,
  retargetClaudeSessionId = null, now = Date.now(),
}) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(claimKey) || !en(sessionId) || !en(locator)) return [{ op: "promote", ok: false, reason: "bad_external_id", why: "claimKey/sessionId/locator 必填 1..256 字符串" }];
    const resolved = resolveLiveId({ endpointId, locator, env });
    if (!resolved.ok) return [{ op: "promote", ok: false, reason: resolved.reason, why: resolved.why ?? null }];
    const b1Id = resolved.id;
    const l = loadByEndpoint(endpointId, { env });
    if (!l.ok) return [{ op: "promote", ok: false, reason: "ledger_unreadable", why: l.why ?? null }];
    const target = l.doc.records[b1Id];
    if (!target || target.kind !== "live") return [{ op: "promote", ok: false, reason: "target_gone" }];
    if (target.facts.binding === "active") {
      // W2 再认领（B3 已 active 换会话）→ retarget：同 root，换 ledger 侧 claude_session_id。
      if (!en(retargetClaudeSessionId)) return [{ op: "retarget", ok: false, reason: "bad_external_id", why: "retargetClaudeSessionId 必填（ledger 侧 claude_session_id UUID）" }];
      const k = rk("retarget", claimKey, b1Id);
      if (!k.ok) return [{ op: "retarget", ...k }];
      const base = target.binding_target;
      return [capture("retarget", retarget({ endpointId, requestKey: k.request_key, id: b1Id, expectedOldTarget: base, newTarget: { ...base, claude_session_id: retargetClaudeSessionId }, authorizedBy, now, env }))];
    }
    if (target.facts.binding !== "pending") return [{ op: "promote", ok: false, reason: "target_not_pending_or_active", why: "target.facts.binding=" + String(target.facts.binding) }];
    // W1 引用码认领（B1 仍 pending）→ create_a1 → activate（标准四项 + 匹配根 om）。
    const chatId = typeof target.chat_id === "string" ? target.chat_id : null;
    if (!en(chatId)) return [{ op: "create_a1", ok: false, reason: "bad_input", why: "target.chat_id 缺失" }];
    const kA1 = rk("create_a1", claimKey, sessionId);
    if (!kA1.ok) return [{ op: "create_a1", ...kA1 }];
    const a1 = capture("create_a1", createA1({ endpointId, requestKey: kA1.request_key, chatId, sessionId, now, env }));
    if (!a1.ok) return [a1]; // create_a1 失败（如 locator 撞）→ 序列停（activate 需 a1Id）
    const kAct = rk("activate", claimKey, b1Id);
    if (!kAct.ok) return [a1, { op: "activate", ...kAct }];
    return [a1, capture("activate", activate({ endpointId, requestKey: kAct.request_key, b1Id, a1Id: a1.result?.created_id, f4: { matched_om: locator, matched_fields: ["chat_id", "sender", "body", "thread_root"] }, authorizedBy, now, env }))];
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
 * rotateCompositeSubmit —— P1-4（#R37 返修 ①②③）旋转复合体的 shadow 序列：
 *   void(过期的旧 B1, reason=expired) → create_b1(新建代际)，同一笔外锁内两 op。
 * 两个 op 从**同一个** rotation operation id 派生**不同** request_key
 *   （ext=rotationOpId 相同；op_type=void/create_b1、entity=旧 B1 id / lineage id 相异），
 *   逐 op 幂等重放（账本 writeLedger 按 request_key 去重：replay→committed_clean,idempotent）。
 * ② 每 op 各自独立有效：void 失败（旧 B1 缺席/已作废）**不阻断** create_b1；create_b1 失败也不撤销 void。
 * 仅在 legacyRes.supersededRootOm 命中到仍 live 的旧 B1 时才算 void 落账；否则 void 投影 fail-closed 保留在结果里。
 * @returns 影子序列（每项 capture 结果：{op, ok, ...}）
 */
function rotateCompositeSubmit({ endpointId, env, legacyRes, rotationOpId, lineageId, chatId, rootOm = null, bindingTarget, now }) {
  const om = (legacyRes && typeof legacyRes === "object" && legacyRes.root_message_id) ? legacyRes.root_message_id : rootOm;
  if (!en(rotationOpId) || !en(lineageId) || !en(om)) return [{ op: "create_b1", ok: false, reason: "bad_external_id", why: "rotationOpId/lineageId/rootOm 必填 1..256 字符串" }];
  const ops = [];
  const supersededOm = (legacyRes && typeof legacyRes === "object" && legacyRes.supersededRootOm) ? legacyRes.supersededRootOm : null;
  if (en(supersededOm)) {
    const resolved = resolveLiveId({ endpointId, locator: supersededOm, env });
    if (resolved.ok) {
      const kv = rk("void", rotationOpId, resolved.id);
      ops.push(kv.ok ? capture("void", voidPending({ endpointId, requestKey: kv.request_key, b1Id: resolved.id, reason: "expired", now, env })) : { op: "void", ...kv });
    } else {
      // 旧 B1 在 shadow 缺席（legacy-only / 已作废 / 读不出）→ void fail-closed 投影，但不阻断 create_b1。
      ops.push({ op: "void", ok: false, reason: resolved.reason, why: resolved.why ?? null });
    }
  }
  const k = rk("create_b1", rotationOpId, lineageId);
  if (!k.ok) { ops.push({ op: "create_b1", ...k }); return ops; }
  ops.push(capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm: om, lineageId, bindingTarget, now, env })));
  return ops;
}

/**
 * wireRotate —— rotate（建新代际）→ 账本复合体 [void(过期旧 B1) → create_b1(新代际)]（P1-4）。
 * 一笔外锁内两 op；两 op 从同一 persistent rotation operation id 派生不同 request_key；
 * rootOm 二选一：优先从 legacyRes.root_message_id 取（轮转的 topic 根消息在 legacy 闭包里由
 *   sendToChat 创建，锁必须在它之前取——W3），缺省才回退到静态 rootOm 参数。
 * legacyRes.supersededRootOm（可选）= 被作废旧代际根消息 om —— 调用方 legacy 闭包把
 *   prepareClaudeTopicRotation({supersedeExpired:true}).superseded.root_message_id 线程过来。 */
export function wireRotate({ endpointId, env = process.env, legacy, rotationOpId, lineageId, chatId, rootOm = null, bindingTarget, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => rotateCompositeSubmit({ endpointId, env, legacyRes, rotationOpId, lineageId, chatId, rootOm, bindingTarget, now }) });
}

/**
 * wireRotateRecovery —— P1-4 ④（#R37 返修）续跑恢复：legacy 已有新 pending、但 shadow 只写了 void、
 *   create_b1 缺失。**shadow-only、无 legacy 业务副作用**（prepare/sendToChat/register 由首次 run 完成，本次只补镜像）。
 *   前提：void 已提交（这就是本恢复被调用的判定），故**只补缺失的 create_b1**、不重发 void（重发反而因目标已
 *   作废而 resolv 不到）。ext 沿用首次 run 的 rotation operation id，故 create_b1 幂等：已提交——重放命中，
 *   缺失——才真落账。不许被「已有 pending」预检挡掉；调用方检测到缺失时路由到本函数而非重复创建。 */
export function wireRotateRecovery({ endpointId, env = process.env, rotationOpId, lineageId, chatId, rootOm, bindingTarget, now = Date.now() }) {
  return runWired({ endpointId, env, legacy: () => ({ ok: true, root_message_id: rootOm }), submit: (legacyRes) => {
    if (!en(rotationOpId) || !en(lineageId) || !en(rootOm)) return [{ op: "create_b1", ok: false, reason: "bad_external_id", why: "rotationOpId/lineageId/rootOm 必填 1..256 字符串" }];
    const k = rk("create_b1", rotationOpId, lineageId);
    if (!k.ok) return [{ op: "create_b1", ...k }];
    return [capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm, lineageId, bindingTarget, now, env }))];
  } });
}

/**
 * wireVoid —— rotate cancel / pending 过期 → 账本 void。
 * ext=rotation operation id；目标由 resolver 按 locator（被作废代际根消息 om）命中。
 * reason 用封闭枚举映射：cancel→"manual"、过期→"expired"（不扩枚举）。resolver 未命中 → 无 B1 可 void，
 *   该笔 shadow fail-closed（locator_absent 等），legacy 照常完成（轮转本来就可能 legacy-only、无 B1）。 */
export function wireVoid({ endpointId, env = process.env, legacy, rotationOpId, locator, reason, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(rotationOpId) || !en(locator)) return [{ op: "void", ok: false, reason: "bad_external_id", why: "rotationOpId/locator 必填 1..256 字符串" }];
    const resolved = resolveLiveId({ endpointId, locator, env });
    if (!resolved.ok) return [{ op: "void", ok: false, reason: resolved.reason, why: resolved.why ?? null }];
    const id = resolved.id;
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
  // 连接暂停/恢复 = W4 对账兜底行（无持久审计 id，不实时双写）：只取 outer 锁、不写 shadow（PX1-3③）。
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(controlClaimKey) || !en(id)) return [{ op: opType, ok: false, reason: "bad_external_id", why: "controlClaimKey/id 必填 1..256 字符串" }];
    const k = rk(opType, controlClaimKey, id);
    if (!k.ok) return [{ op: opType, ...k }];
    const fn = mode === "pause" ? unbind : restore;
    return [capture(opType, fn({ endpointId, requestKey: k.request_key, id, now, env }))];
  }, lockOnly: true });
}

/**
 * wireEnabledFlip —— `enabled` 翻转（§4 行）→ unbind / restore。
 * disabled→unbind（映 paused）、restore 恢复 enabled→restore。历史 B4 不动（账本 self 拒）。
 * ext=同上持久控制 claim key；entity=目标 id。
 */
export function wireEnabledFlip({ endpointId, env = process.env, legacy, controlClaimKey, id, mode, now = Date.now() }) {
  // P1-3③：enum 关闭 —— mode 只认 disable|enable，非法 mode 拒（不默默回落 enable）。
  if (mode !== "disable" && mode !== "enable") return { ok: false, commit: "not_committed", reason: "bad_mode", why: "mode 只认 disable|enable", legacy: null, shadow: null, release: null };
  // 语义与 pause/resume 同构（unbind↔disabled、restore↔enabled）：复用 wirePauseResume（W4 lock-only）。
  return wirePauseResume({ endpointId, env, legacy, controlClaimKey, id, mode: mode === "disable" ? "pause" : "resume", now });
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
