/**
 * 控制命令事务的显式维护入口（Claude 侧）：一笔 claim 里有控制意图（mode 或 select）、却没记下 consumed 终态时，
 * 在这里续做（幂等执行 + 写终态）。飞书重发是新消息 = 新 claim，补不了旧账 —— 这才是"恢复消费者"。
 * 身份：先从 claim 取会话定位，解析出它所属的精确绑定（项目级或会话级，与出站同一条选择规则），
 * 之后每次读 claim 都带份期望；真正写入前，还要用**写锁内刚读出的记录**重新推导一遍身份再核对。
 * 破坏性 CLI：只认 --project <root>、--key <64位hex>、--apply；未知 / 裸参数一律退出 2；默认只报告。
 */

import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { CLAIM_KEY_SHAPE, readClaimState } from "./claim.mjs";
import { RESUMABLE_CONTROL_STATES, inspectControlClaim, resumeControlClaim, readConsumedRecord, readControlFailedRecord } from "./control-command.mjs";
import { RESUMABLE_REJECT_STATES, describeRejectRepair, inspectRejectedClaim, rejectRepairExitCode, resumeRejectedClaim } from "./reject-control.mjs";
import { setClaudeInteractionMode } from "./interaction-policy-store.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { expectationFromMapping, claudeControlPrecondition } from "./control-identity.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import { executeSelectControl, verifySelectionContext, mintSelectCapability } from "./select-admission.mjs";
import { senderRole } from "./sender-roles.mjs";
import { resolveEndpointDir, loadLedger, ownerSelectReaffirmRequestKey, ID_SHAPE, OM_SHAPE, familyOf, activate, anchor, rebindSessionAlias } from "./topic-agent-ledger.mjs";
import { cleanReaffirmIntent, foldLockReleaseState } from "./maintenance/reaffirm-intents.mjs";
import { acquireOrderLock, requestKeyFor } from "./m1a/dual-write.mjs";
import { readSelectionPlan, recoverSelectionPlanTmp } from "./selection-plan.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { legacyEndpointId } from "./subscription.mjs";

export function parseRepairControlArgs(argv, { target = "--project" } = {}) {
  let root = null; let key = null; let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === target || a === "--key") {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: a + "_value_required" };
      if (a === "--key") key = v; else root = v;
      i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!root) return { ok: false, reason: target + "_required" };
  if (!key || !CLAIM_KEY_SHAPE.test(key)) return { ok: false, reason: "key_shape" };
  return { ok: true, root, key, apply };
}

function describeIntent(intent) {
  if (!intent) return "?";
  if (intent.control === "select") return "选择 " + (intent.handle ?? "默认候选");
  return intent.mode ?? "?";
}

function describeTarget(intent) {
  if (!intent) return "?";
  if (intent.control === "select") return "目标选择 " + (intent.handle ?? "默认候选");
  return "目标模式 " + (intent.mode ?? "?");
}

export function describeControlRepair({ seen, result, apply }) {
  if (result) {
    if (!result.ok) return "没有恢复（" + result.reason + (result.why ? "：" + result.why : "") + "）";
    const left = (result.residueUncleared?.length ? "；但有 " + result.residueUncleared.length + " 个临时残骸清不掉，请人工查看" : "") +
      (result.residueUnknown ? "；残骸情况说不清（" + result.residueUnknown + "），请人工查看" : "") +
      (result.lockUncleared ? "；事务锁没有交还（" + result.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后删除锁目录" : "");
    const held = result.quarantined?.length ? "；损坏的 failed 记录已隔离为 " + result.quarantined.join("、") + "，人工查看后删除" : "";
    const targetDesc = describeTarget(result.intent);
    const actionDesc = result.intent?.control === "select"
      ? (result.changed ? "已完成选择" : "选择未变化")
      : (result.changed ? "本次完成切换" : "模式本来就是");
    return (result.already ? "这笔已闭合，无需恢复" : "已补齐终态（" + targetDesc + "，" + actionDesc + "）") + held + left;
  }
  const intentDesc = describeIntent(seen.intent);
  const head = { in_flight: "事务未闭合：控制意图 " + intentDesc + "，终态缺席", consumed: "已闭合，无需恢复", mismatch: "终态与意图不一致：" + (seen.why ?? ""),
    consumed_unreadable: "终态记录损坏（意图 " + intentDesc + "）：" + (seen.why ?? ""), failed_unreadable: "失败记录损坏（意图 " + intentDesc + "）：" + (seen.why ?? ""),
    failed: "已记为失败（" + (seen.intent?.control === "select" ? "当时未执行选择" : "当时没切成") + "），不恢复", conflict: "两份终态并存（" + (seen.why ?? "") + "），请人工查看", not_control: "这张 claim 不是控制命令",
    claim_unreadable: "claim 不属于当前绑定 / 读不出：" + (seen.why ?? ""), claim_absent: "没有这张 claim",
    "control-committed-unclean": "事务已写入账本但收口不干净（意图 " + intentDesc + "）：" + (seen.why ?? seen.record?.why ?? "收口不干净，可恢复") }[seen.state]
    ?? ("说不清：" + seen.state + (seen.why ? "：" + seen.why : ""));
  const resumable = RESUMABLE_CONTROL_STATES.includes(seen.state);
  return (apply ? "" : "[预览] ") + head + (seen.residue?.length ? "；另有 " + seen.residue.length + " 个临时残骸" : "") +
    (seen.quarantined?.length ? "；另有 " + seen.quarantined.length + " 个隔离的损坏 failed 制品待人工查看" : "") +
    (seen.listingProblem ? "；同 key 的临时制品说不清（" + seen.listingProblem + "）" : "") +
    (resumable && !apply ? "\n加 --apply 续做。" : "");
}

/** 退出码：只要还有没闭合的事、清不掉的残骸，就不许报 0 —— 第二次运行也一样。 */
export function repairExitCode({ seen, result, apply }) {
  if (result) return result.ok && !(result.residueUncleared?.length) && !result.residueUnknown && !result.lockUncleared ? 0 : 1;
  if (!apply) return 0;
  return seen.state === "consumed" && !(seen.residue?.length) && !seen.listingProblem ? 0 : 1;
}

/**
 * 两个 repair 消费者的按 kind 穷举分发（Claude 与 Codex 共用）：
 *   - select 支：受验 selection_context，根据状态分派（unclean 走专门路径，in_flight 走真执行器）
 *   - mode 支：走 onMode
 *   - 其它值 fail-closed：结构化拒 unknown_control_kind，不得"否则按 mode"
 */
export function dispatchControlRepair(target, { onMode, onSelect = null } = {}, ctx = {}) {
  const kind = target?.control ?? (typeof target === "string" ? "mode" : null);
  if (kind === "select") {
    if (typeof onSelect === "function") return onSelect(target, ctx);
    const claim = ctx?.claim;
    const vCtx = verifySelectionContext(claim);
    if (!vCtx.ok) return { ok: false, reason: vCtx.reason, why: vCtx.why };
    const sc = vCtx.context;
    if (ctx?.uncleanRecord || claim?.state === "control-committed-unclean") {
      return repairControlCommittedUnclean({
        claim,
        claimsDir: ctx?.claimsDir,
        key: claim?.claim_key ?? ctx?.key,
        uncleanRecord: ctx?.uncleanRecord,
        env: ctx?.env,
        _inject: ctx?._inject,
      });
    }
    // R57d 返修三 P1-2：repair 对 select 支 fail-open——ownerContext 缺席时直接跳过角色/chat 核验并铸 capability。
    //   返修四：select 支 repair 必须拿到完整受验角色表（frank_sender_id + senders）/ chat / 由当前 chain + agent_uid 派生的
    //   endpoint，任一读不出或与 claim 的 selection_context 不符 → 拒（context_missing / sender_mismatch / endpoint_mismatch），不铸 capability。
    const ownerCtx = ctx?.ownerContext ?? null;
    if (!ownerCtx) return { ok: false, reason: "select_repair_context_missing", why: "select 支 repair 拿不到完整受验角色表/chat/endpoint（链路模板读不出或缺 owner/agent_uid 字段）——不铸 capability" };
    const role = senderRole({ frank_sender_id: ownerCtx.frankSenderId, senders: ownerCtx.senders ?? [] }, sc.sender);
    if (role !== "owner") return { ok: false, reason: "select_sender_mismatch", why: "repair 重核角色：claim 登记的 sender 当前不是 owner（角色=" + String(role) + "）" };
    if (ownerCtx.chatId != null && sc.chat !== ownerCtx.chatId) return { ok: false, reason: "select_sender_mismatch", why: "repair 重核 chat：claim 的 chat（" + sc.chat + "）与当前链路登记（" + ownerCtx.chatId + "）不一致" };
    if (ownerCtx.endpoint != null && sc.endpoint !== ownerCtx.endpoint) return { ok: false, reason: "select_endpoint_mismatch", why: "repair 重核 endpoint：claim 的 endpoint（" + sc.endpoint + "）与当前链路派生（" + ownerCtx.endpoint + "）不一致" };
    return executeSelectControl(target, {
      endpointId: sc.endpoint,
      chatId: sc.chat,
      senderId: sc.sender,
      messageId: sc.message,
      eventSessionId: sc.session ?? null,
      capability: mintSelectCapability({ endpoint: sc.endpoint, chat: sc.chat, session: sc.session, message: sc.message, sender: sc.sender, handle: sc.handle, handleKind: sc.kind }),
      txCtx: ctx && ctx.claimsDir && ctx.key ? { claimsDir: ctx.claimsDir, key: ctx.key, claim: ctx.claim ?? null } : null,
      env: ctx?.env,
      _inject: ctx?._inject,
      // R57b 返修六 P1-1：in-flight repair 调执行器也要透传 plan 上下文（缺 → 结构化拒，不进账本）。
      claimsDir: ctx?.claimsDir,
      key: claim?.claim_key ?? ctx?.key,
    });
  }
  if (kind === "mode") return onMode(typeof target === "string" ? target : target.mode);
  return { ok: false, reason: "unknown_control_kind", why: "未知控制命令类型（" + String(kind) + "）" };
}

/**
 * control-committed-unclean 专用恢复路径（§8.1/R57b P1-4）：
 * 重读账本核已提交 → 只做清理/释放收尾 → 转 consumed；核不出 → 保持并点名。
 */
export function repairControlCommittedUnclean({ claim, claimsDir, key, uncleanRecord, env = process.env, _inject = undefined } = {}) {
  // R57d 返修一 B 段 P1-7：kind 判别 —— rfh 走 intent 清理收尾；osh/orh 走「按 sidecar plan + detail 分支」收尾
  //   （目标已消费，不重执行；补得上/核得出 → 转 consumed 交事务层闭合，否则保持并点名）。
  const vCtx = verifySelectionContext(claim);
  if (!vCtx.ok) return { ok: false, reason: vCtx.reason, why: vCtx.why };
  const sc = vCtx.context;

  // R57d 对齐 P1-5：osh/orh 与 rfh 同一 outer 锁序（同 P1-2 签发/消费纪律）——
  //   清理 / 前向补账本都在锁内；两层释放都干净才闭合；outer 取不到/残骸/释放失败 → 非绿、保持 committed-unclean 点名。
  const acq = acquireOrderLock(sc.endpoint, env);
  if (!acq.ok) {
    return { ok: false, reason: acq.reason ?? "outer_lock_unavailable", why: "repair 外层排序锁取不到（" + (acq.why ?? acq.reason ?? "?") + "），保持 control-committed-unclean", lock_state: "unclear" };
  }
  let innerRes;
  let outerRel;
  try {
    innerRes = sc.kind === "rfh"
      ? repairControlCommittedUncleanInner({ claim, claimsDir, key, uncleanRecord, env, _inject, sc })
      : repairUncleanSelectInner({ claim, claimsDir, key, uncleanRecord, env, sc });
  } finally {
    try { outerRel = acq.release(); } catch (err) { outerRel = { ok: false, reason: "release_exception", why: String(err?.code ?? err?.message ?? err) }; }
  }
  // 联合 outer / intent 两层释放结果：任一 residue/unclear → 非绿。
  const outerLockState = foldLockReleaseState(outerRel);
  const intentLockState = innerRes?.lock_state ?? "released";
  if (outerLockState !== "released" || intentLockState !== "released") {
    const reason = outerLockState !== "released" ? "repair_outer_lock_release_unclean" : (innerRes?.reason ?? "intent_cleanup_unclean");
    return {
      ...innerRes,
      ok: false,
      reason,
      why: "repair 收口两侧锁释放不干净（outer=" + outerLockState + ", intent=" + intentLockState + "）：" + (innerRes?.why ?? ""),
      locks: { outer: outerLockState, intent: intentLockState },
      lockUncleared: {
        outer: outerLockState !== "released" ? { reason: outerRel?.reason ?? "outer_lock_release", why: outerRel?.why ?? null, path: outerRel?.path ?? null } : null,
        intent: innerRes?.lockUncleared ?? null,
      },
    };
  }
  return innerRes;
}

/**
 * osh/orh 的 unclean 收尾（R57d 对齐 P1-5）。前提：verifySelectionContext 已过、outer 锁已持。
 * 分支判据 = uncleanRecord.detail（P1-5a 结构化持久证据）+ sidecar plan（P1-4），不重执行选择：
 *   · ledger 已提交 → 只做清理/锁释放收口转 consumed，不补写不重跑；
 *   · ledger 未提交而 legacy 已提交 → 按 plan 前向补 ledger（同 request_key / 冻结 CAS，账本 op 幂等）。
 *     依据写明：legacy 提交是对外事实（映射已改）不可逆，本仓库没有可证明安全的 legacy CAS 回滚原语；
 *     plan 冻结了同一 request_key 与完整 CAS，账本 op 按 request_key 幂等 —— 二选一取前向补。
 *     补不上（CAS 被现场漂移破掉 / 可归并对象不在）→ 保持 unclean 并点名。
 *   · 其它组合（detail.legacy ≠ committed 等）→ 证据不够，保持 unclean 点名。
 *   · unclean 与 consumed/failed 记录共存 → select_state_conflict（判据在 control-command.mjs，盘点/恢复共用）。
 */
function repairUncleanSelectInner({ claim, claimsDir, key, uncleanRecord, env, sc }) {
  const detail = uncleanRecord?.detail;
  if (!detail || typeof detail !== "object" || typeof detail.action !== "string") {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "unclean 记录没有结构化 detail（旧形 unclean），保持 control-committed-unclean" };
  }
  const consumed = readConsumedRecord({ claimsDir, key });
  const failed = readControlFailedRecord({ claimsDir, key });
  if (consumed.status !== "absent" || failed.status !== "absent") {
    return { ok: false, reason: "select_state_conflict", why: "unclean 与 " + (consumed.status !== "absent" ? "consumed" : "failed") + " 记录共存（状态机自相矛盾），不放行，人工核对" };
  }
  const d = resolveEndpointDir(sc.endpoint, { env });
  if (!d.ok) return { ok: false, reason: "endpoint_dir_unresolvable", why: d.why };
  const L = loadLedger(d.dir, { endpointId: sc.endpoint });
  if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: L.why ?? L.reason };
  // sidecar plan（P1-4）：持锁入口先受验恢复 tmp，再读回；plan/target 与 unclean detail 逐字互证。
  const rec = recoverSelectionPlanTmp({ claimsDir, key: claim?.claim_key ?? key });
  if (rec && rec.ok === false) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan tmp 残骸待人工（" + (rec.why ?? "?") + "）" };
  }
  const planRead = readSelectionPlan({ claimsDir, key: claim?.claim_key ?? key });
  if (!planRead.ok || planRead.absent) {
    return { ok: false, reason: "selection_plan_missing", why: "selection plan sidecar 缺席/读不出（" + (planRead.absent ? "absent" : (planRead.problem ?? "?")) + "），保持 control-committed-unclean" };
  }
  const plan = planRead.plan;
  if (typeof plan.target_id !== "string" || !ID_SHAPE.test(plan.target_id) || plan.target_id !== detail.target_id) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.target_id（" + String(plan.target_id) + "）与 unclean detail.target_id（" + String(detail.target_id) + "）不一致，保持 control-committed-unclean" };
  }
  if (sc.kind !== null && plan.kind !== sc.kind) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.kind（" + String(plan.kind) + "）与 claim.kind（" + String(sc.kind) + "）不一致，保持 control-committed-unclean" };
  }
  const opType = detail.action === "rebind" ? "rebind_session_alias" : detail.action;
  // 共用派生：与执行器同一 requestKeyFor（不另抄公式）；detail 自报的 request_key 必须与之逐字等。
  const wantKey = requestKeyFor({ opType, externalRequestId: sc.message, entityId: plan.target_id });
  if (!wantKey.ok) return { ok: false, reason: "select_plan_invalid", why: wantKey.why ?? "request key 派生失败" };
  if (detail.request_key !== wantKey.request_key) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "unclean detail.request_key（" + String(detail.request_key) + "）与共用派生（" + wantKey.request_key + "）不一致，保持 control-committed-unclean" };
  }
  const findCommitted = (doc) => Object.values(doc.operations).find((o) => o.op_type === opType && o.request_key === wantKey.request_key && o.result && typeof o.result_revision === "number");
  // 提交记录与 plan 的逐字绑定：target 随 op type 取 surviving_id/affected_id，selection_message_id 与 CAS 逐字等。
  // （activate 的 target 在 result.surviving_id；anchor/rebind 在 result.affected_id；anchor/rebind 的 expected CAS 在 op.inputs。）
  const committedMismatch = (o) => {
    const target = o.op_type === "activate" ? o.result?.surviving_id : o.result?.affected_id;
    if (target !== plan.target_id) return "target（" + String(target) + "）与 plan.target_id 不一致";
    if (o.result?.selection_message_id !== sc.message) return "selection_message_id（" + String(o.result?.selection_message_id) + "）与 claim message 不一致";
    if (o.op_type === "activate") {
      if (o.result?.selection_handle !== plan.cas.selection_handle) return "selection_handle 与 plan.cas 不一致";
      if (o.result?.selected_session_id !== plan.cas.selected_session_id) return "selected_session_id 与 plan.cas 不一致";
      if (o.result?.selected_root_om !== plan.cas.selected_root_om) return "selected_root_om 与 plan.cas 不一致";
    }
    if (o.op_type === "anchor") {
      for (const k of ["expected_handle", "expected_expires_at", "expected_anchor_candidate"]) {
        if (o.inputs?.[k] !== plan.cas[k]) return "inputs." + k + " 与 plan.cas 不一致";
      }
    }
    if (o.op_type === "rebind_session_alias") {
      if (o.result?.new_session_id !== plan.cas.new_session_id) return "new_session_id 与 plan.cas 不一致";
      if (o.result?.old_session_id !== plan.cas.expected_old_session_id) return "old_session_id 与 plan.cas 不一致";
      if (o.inputs?.expected_expires_at !== plan.cas.expected_expires_at) return "inputs.expected_expires_at 与 plan.cas 不一致";
    }
    return null;
  };
  // 分支一：账本已提交 → 只做清理/收口转 consumed（不重执行、不补写；target/message/CAS 与 plan 逐字一致才认）。
  const committed = findCommitted(L.doc);
  if (committed) {
    const mismatch = committedMismatch(committed);
    if (mismatch !== null) {
      return { ok: false, reason: "ledger_commit_unverifiable", why: "账本 " + opType + " op 与 plan 逐字核不过：" + mismatch + "，保持 control-committed-unclean" };
    }
    return { ok: true, changed: true };
  }
  // 分支二：legacy 已提交、账本未提交 → outer 锁内按 plan 前向补 ledger（同 request_key / 冻结 CAS，幂等）。
  if (detail.ledger === "not_committed" && detail.legacy === "committed") {
    const clock = () => Date.now();
    let r;
    if (opType === "activate") {
      const a1 = Object.values(L.doc.records).find((x) => x?.kind === "live" && familyOf(x.facts) === "A1" && x.chat_id === sc.chat && x.aliases.session_id === plan.cas.selected_session_id);
      if (!a1) {
        return { ok: false, reason: "ledger_forward_fill_failed", why: "前向补 activate 失败：chat（" + sc.chat + "）会话（" + String(plan.cas.selected_session_id) + "）上无可归并 A1，保持 control-committed-unclean" };
      }
      r = activate({ endpointId: sc.endpoint, requestKey: wantKey.request_key, b1Id: plan.target_id, a1Id: a1.topic_agent_id, authorizedBy: sc.sender, selectedSessionId: plan.cas.selected_session_id, selectedRootOm: plan.cas.selected_root_om, selectionHandle: plan.cas.selection_handle, selectionMessageId: sc.message, selectionBasis: plan.basis, clock, env });
    } else if (opType === "anchor") {
      r = anchor({ endpointId: sc.endpoint, requestKey: wantKey.request_key, id: plan.target_id, authorizedBy: sc.sender, selectedSessionId: plan.cas.selected_session_id, selectedRootOm: plan.cas.selected_root_om, selectionHandle: plan.cas.expected_handle, expectedExpiresAt: plan.cas.expected_expires_at, expectedAnchorCandidate: plan.cas.expected_anchor_candidate, selectionMessageId: sc.message, selectionBasis: plan.basis, clock, env });
    } else {
      r = rebindSessionAlias({ endpointId: sc.endpoint, requestKey: wantKey.request_key, id: plan.target_id, expectedOldSessionId: plan.cas.expected_old_session_id, newSessionId: plan.cas.new_session_id, authorizedBy: sc.sender, rebindHandle: plan.cas.rebind_handle, expectedExpiresAt: plan.cas.expected_expires_at, selectionMessageId: sc.message, clock, env });
    }
    if (!r.ok) {
      return { ok: false, reason: "ledger_forward_fill_failed", why: "前向补 " + opType + " 失败（" + (r.reason ?? "?") + (r.why ? "：" + r.why : "") + "），保持 control-committed-unclean" };
    }
    const L2 = loadLedger(d.dir, { endpointId: sc.endpoint });
    if (!L2.ok) return { ok: false, reason: "ledger_unreadable", why: L2.why ?? L2.reason };
    if (!findCommitted(L2.doc)) {
      return { ok: false, reason: "ledger_forward_fill_failed", why: "前向补后仍核不出提交（request_key " + wantKey.request_key + "），保持 control-committed-unclean" };
    }
    return { ok: true, changed: true };
  }
  return { ok: false, reason: "ledger_commit_unverifiable", why: "detail.legacy/ledger=" + String(detail.legacy) + "/" + String(detail.ledger) + "，无安全收口路径，保持 control-committed-unclean" };
}

function repairControlCommittedUncleanInner({ claim, claimsDir, key, uncleanRecord, env = process.env, _inject = undefined, sc = undefined } = {}) {
  // sc 由外层 repairControlCommittedUnclean 验证后传入；这里不再重复 verifySelectionContext。
  const d = resolveEndpointDir(sc.endpoint, { env });
  if (!d.ok) return { ok: false, reason: "endpoint_dir_unresolvable", why: d.why };

  // 1. 重读账本核已提交
  const L = loadLedger(d.dir, { endpointId: sc.endpoint });
  if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: L.why ?? L.reason };

  // P1-4b：逐字绑定本 claim 对应的唯一 op——两字段（target_id / selection_message_id）**必须在场**且与
  //   claim / intent **逐字一致**；不再降级（缺席不核 / 在场不比）。缺失或不等 → ledger_commit_unverifiable。
  //   且 request_key 与写入侧共用同一派生函数（P2）。
  //   注：recordClaimState 把 detail 铺平到记录顶层（state/claim_key/recorded_at 并列），result 在记录顶层。
  const unResult = uncleanRecord?.result;
  const unTarget = unResult?.target_id;
  const unMessage = unResult?.selection_message_id;
  if (typeof unTarget !== "string" || !ID_SHAPE.test(unTarget) || typeof unMessage !== "string" || !OM_SHAPE.test(unMessage)) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "uncleanRecord.result 缺 target_id/selection_message_id（均须在场且合法），保持 control-committed-unclean" };
  }
  if (unMessage !== sc.message) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection_message_id 与 claim 的 message 不一致，保持 control-committed-unclean" };
  }
  // P1-4b（续）：核 selection plan 的 target_id——plan 必须在场，且 plan / unclean / 账本 operation 三者
  //   target_id 逐字一致。R57b 返修五：真实 claim 写方把 plan 落盘到 claims/<key>.selection-plan.json（不再
  //   依赖手工拼的 claim.selection_plan）；repair 从盘读回。plan 缺席或任一不等 → ledger_commit_unverifiable。
  // 规则 5：repair 是持锁入口——读 plan 前先调受验恢复（unlink「link 后未 unlink」tmp）；恢复不了（residue）→ 非绿。
  const rec = recoverSelectionPlanTmp({ claimsDir, key });
  if (rec && rec.ok === false) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan tmp 残骸待人工（" + (rec.why ?? "?") + "）" };
  }
  const planRead = readSelectionPlan({ claimsDir, key });
  if (!planRead.ok) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan 读不出（" + (planRead.problem ?? "?") + "），保持 control-committed-unclean" };
  }
  if (planRead.absent) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan 缺席（真实 claim 写方应已落盘），保持 control-committed-unclean" };
  }
  const planTarget = planRead.plan?.target_id;
  if (typeof planTarget !== "string" || !ID_SHAPE.test(planTarget)) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.target_id 缺席/不合法（须在场且 ta_ 形状），保持 control-committed-unclean" };
  }
  if (planTarget !== unTarget) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.target_id（" + planTarget + "）与 uncleanRecord.result.target_id（" + unTarget + "）不一致，保持 control-committed-unclean" };
  }
  // P1-2（续）：repair 也比对 plan.handle === claim.handle 与 plan.kind === claim.kind（不全只比 target）。
  if (planRead.plan?.handle !== sc.handle) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.handle 与 claim.handle 不一致，保持 control-committed-unclean" };
  }
  if (planRead.plan?.kind !== sc.kind) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.kind 与 claim.kind 不一致，保持 control-committed-unclean" };
  }
  // 精确绑定的 request_key 与写入侧共用同一派生函数（P2）；不再保留本地字面拼接。
  const matches = Object.values(L.doc.operations).filter((op) =>
    op.op_type === "owner_select_reaffirm" &&
    op.result && typeof op.result.target_id === "string" &&
    op.request_key === ownerSelectReaffirmRequestKey({ target: op.result.target_id, handle: sc.handle }) &&
    op.result.target_id === unTarget &&
    op.result.selection_message_id === unMessage
  );
  if (matches.length !== 1) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "账本中核不出 handle " + sc.handle + " 的唯一提交记录（命中 " + matches.length + " 笔），保持 control-committed-unclean" };
  }
  const priorOp = matches[0];

  // 2. 只做清理/释放收尾
  const cl = cleanReaffirmIntent({ endpointDir: d.dir, reaffirmHandle: sc.handle, env, _inject });
  // P1-4：cleanReaffirmIntent 可返回 ok:true 但 lock_state: residue | unclear（intent 锁释放不净）；
  //   repair 不能只看 cl.ok 就转 consumed——要求清理提交 + 锁释放全部干净才转，否则保持 committed-unclean 并点名。
  const cleanupClean = cl.ok && cl.lock_state === "released" && !cl.lockUncleared && !cl.lockResidue;
  if (!cleanupClean) {
    return {
      ok: false,
      reason: cl.reason ?? "intent_cleanup_unclean",
      why: cl.why ?? ("清理 intent 收口不干净（ok=" + String(cl.ok) + "，lock_state=" + String(cl.lock_state ?? "?") + "），保持 control-committed-unclean"),
      lock_state: cl.lock_state ?? null,
    };
  }

  return { ok: true, changed: true, lock_state: "released" };
}

export { expectationFromMapping, claudeControlPrecondition as controlRepairPrecondition } from "./control-identity.mjs";

/** 当前项目里、这张 claim 所属的精确绑定（claim 带会话定位就选会话级，否则项目级）的身份期望。 */
export function claudeClaimExpectation({ root, claudeSessionId = null, registryFile, templateFile }) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile, templateFile });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, expect: expectationFromMapping(resolved.mapping, { root }) };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairControlArgs(process.argv.slice(2));
  if (!parsed.ok) { process.stderr.write("用法：node repair-control-claim.mjs --project <root> --key <64位hex> [--apply]（" + parsed.reason + "）\n"); process.exit(2); }
  const root = path.resolve(parsed.root);
  const claimsDir = path.join(root, ".runtime-data", "inbound", "delivery-claims");
  // 第一次读 claim 只为拿会话定位（选项目级还是会话级绑定）；身份核对在下面带 expect 再做一遍。
  const located = readClaimState({ claimsDir, key: parsed.key });
  const claudeSessionId = located.status === "valid" ? (located.claim.claude_session_id ?? null) : null;
  const expectation = claudeClaimExpectation({ root, claudeSessionId });
  if (!expectation.ok) { process.stdout.write("当前项目没有可用绑定（" + expectation.reason + "）\n"); process.exit(1); }
  const expect = expectation.expect;
  // R57d 返修三 P1-2：repair 的 owner 重核上下文 —— 当前角色表（frank_sender_id + senders）、链路登记 chat、
  //   由当前 chain(claude) + agent_uid 派生的 endpoint；select 支重核角色 / chat / endpoint 后才重铸 capability。
  //   frank_sender_id 或 agent_uid 其中一个读不出 → ownerContext 缺席（select 支返修四起 fail-closed，不铸 capability）。
  let ownerContext = null;
  try {
    const tpl = loadChainTemplate();
    if (tpl?.ok === true && typeof tpl.template?.frank_sender_id === "string" && typeof tpl.template?.agent_uid === "string") {
      ownerContext = { frankSenderId: tpl.template.frank_sender_id, senders: tpl.template.senders ?? [], chatId: tpl.template.chat_id ?? null, endpoint: legacyEndpointId({ runtime: "claude", agentUid: tpl.template.agent_uid }) };
    }
  } catch { /* 读不出不阻断非 select 支（select 支由 dispatchControlRepair fail-closed） */ }
  const seen = inspectControlClaim({ claimsDir, key: parsed.key, expect });
  let result = null;
  if (parsed.apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）
  if (parsed.apply && (RESUMABLE_CONTROL_STATES.includes(seen.state) || seen.state === "consumed")) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, expect,
      execute: (target, ctx) => dispatchControlRepair(target, {
        onMode: (mode) => setClaudeInteractionMode({ root, claudeSessionId: expect.claudeSessionId, mode,
          precondition: claudeControlPrecondition({ claimsDir, key: parsed.key, root }) }),
      }, { ...ctx, ownerContext }) });
  }
  // 不是控制命令的 claim 也可能是收边的拒绝（第 3 层）：同一个入口，另一套事务。
  if (seen.state === "not_control") {
    const rj = inspectRejectedClaim({ claimsDir, key: parsed.key, expect });
    if (rj.state !== "not_rejected_control") {
      const rr = parsed.apply && (RESUMABLE_REJECT_STATES.includes(rj.state) || rj.state === "rejected") ? resumeRejectedClaim({ claimsDir, key: parsed.key, expect }) : null;
      process.stdout.write(describeRejectRepair({ seen: rj, result: rr, apply: parsed.apply }) + "\n");
      process.exit(rejectRepairExitCode({ seen: rj, result: rr, apply: parsed.apply }));
    }
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
