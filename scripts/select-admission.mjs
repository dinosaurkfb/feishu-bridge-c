// scripts/select-admission.mjs
// R52a：/feishu-select 的写入准入 —— **可注入**；默认实现接真实状态（R55，issue：准入默认实现接线）：
// readOwnerSelectAdmission（owner-select-state.mjs）按 ledger 根下 campaign / writer_state 投影
// off / partial / on / unreadable —— 缺席 = off，任何读不出/不自洽 = unreadable，两处 fail-closed 方向不变。
//
// selectReject(adm, handle_kind)：给定准入状态联合（off / partial / on / unreadable）与 handle_kind，返回拒绝
//   { reason, text } 或 null（放行）。这是"三态准入"的确定性投影，测试用假 adm 覆盖四支。
//
// R57b：rfh 支接真执行器（owner_select_reaffirm，§8.1 消费编排 consumeReaffirmIntent）；
// osh/orh 支仍落 failed 终态 select_executor_absent（另单，PR #136 二轮裁定：failed 是终态，重做须发新消息）。

import { createHash } from "node:crypto";
import { REAFFIRM_HANDLE_SHAPE } from "./topic-agent-ledger.mjs";
import { readOwnerSelectAdmission } from "./maintenance/owner-select-state.mjs";
import { consumeReaffirmIntent } from "./maintenance/reaffirm-intents.mjs";
import { canonKey } from "./maintenance/canon.mjs";

/**
 * 判定选择控制 outcome 的叶子纯函数（§8.1 / R57b / 与 R57d 返修一共用，不 import 维护编排）。
 * 分别给出三份结果：
 * 1. 账本提交（clean / unclean / not_committed）
 * 2. intent 清理提交（cleared / unclear）
 * 3. 两层锁释放（outer / intent 各 released / residue / unclear）
 * 只有三份都干净才 ok → consumed + 绿色文案；已提交未收净 → control-committed-unclean。
 */
export function classifySelectOutcome({
  ledger = null,
  intentCleanup = null,
  locks = null,
} = {}) {
  let ledgerStatus = "not_committed";
  if (typeof ledger === "string") {
    if (["clean", "unclean", "not_committed"].includes(ledger)) {
      ledgerStatus = ledger;
    }
  } else if (ledger && typeof ledger === "object") {
    const isCleanCommit = ledger.ok === true &&
      ["committed_clean", "replayed", "already"].includes(ledger.commit) &&
      (!ledger.residue || ledger.residue.length === 0) &&
      !ledger.lockUncleared &&
      ledger.lock_state !== "unclear";

    if (isCleanCommit) {
      ledgerStatus = "clean";
    } else if (
      ledger.commit === "committed_durability_uncertain" ||
      ledger.commit === "committed_with_residue" ||
      (typeof ledger.commit === "string" && ledger.commit.startsWith("committed")) ||
      ledger.lockUncleared != null ||
      ledger.lock_state === "unclear" ||
      (ledger.residue && ledger.residue.length > 0)
    ) {
      ledgerStatus = "unclean";
    } else {
      ledgerStatus = "not_committed";
    }
  }

  let intentStatus = "unclear";
  if (intentCleanup === "cleared" || intentCleanup === true) {
    intentStatus = "cleared";
  } else if (intentCleanup === "unclear" || intentCleanup === false || intentCleanup === null) {
    intentStatus = "unclear";
  }

  const outerLock = locks?.outer ?? "released";
  const intentLock = locks?.intent ?? "released";
  const locksStatus = {
    outer: ["released", "residue", "unclear"].includes(outerLock) ? outerLock : "unclear",
    intent: ["released", "residue", "unclear"].includes(intentLock) ? intentLock : "unclear",
  };

  const isAllClean =
    ledgerStatus === "clean" &&
    intentStatus === "cleared" &&
    locksStatus.outer === "released" &&
    locksStatus.intent === "released";

  if (isAllClean) {
    return {
      ok: true,
      status: "consumed",
      ledger: ledgerStatus,
      intent_cleanup: intentStatus,
      locks: locksStatus,
    };
  }

  if (ledgerStatus === "clean" || ledgerStatus === "unclean") {
    return {
      ok: false,
      status: "control-committed-unclean",
      ledger: ledgerStatus,
      intent_cleanup: intentStatus,
      locks: locksStatus,
      reason: "control_committed_unclean",
      why: "已写入但收口不干净（" +
        (ledgerStatus !== "clean" ? "账本未净: " + ledgerStatus : "") +
        (intentStatus !== "cleared" ? "；intent未清" : "") +
        (locksStatus.outer !== "released" ? "；outer锁: " + locksStatus.outer : "") +
        (locksStatus.intent !== "released" ? "；intent锁: " + locksStatus.intent : "") +
        "）",
    };
  }

  return {
    ok: false,
    status: "failed",
    ledger: ledgerStatus,
    intent_cleanup: intentStatus,
    locks: locksStatus,
    reason: (typeof ledger === "object" && ledger?.reason) ? ledger.reason : "not_committed",
    why: (typeof ledger === "object" && ledger?.why) ? ledger.why : null,
  };
}

/** selection_context 稳定摘要计算（§8.1/R57b/R57d：不含 root，缺项显式 null）。 */
export function selectionContextDigestV1({
  endpoint = null,
  chat = null,
  session = null,
  message = null,
  sender = null,
  handle = null,
  kind = null,
} = {}) {
  const payload = canonKey({
    domain: "selection_context_v1",
    chat: chat ?? null,
    endpoint: endpoint ?? null,
    handle: handle ?? null,
    kind: kind ?? null,
    message: message ?? null,
    sender: sender ?? null,
    session: session ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** 校验 claim 里的 selection_context 与 digest，fail-closed 点名缺项。 */
export function verifySelectionContext(claim) {
  if (!claim || typeof claim !== "object") {
    return { ok: false, reason: "selection_context_missing", why: "claim 为空或不是对象" };
  }
  const ctx = claim.selection_context;
  if (!ctx || typeof ctx !== "object") {
    return { ok: false, reason: "selection_context_missing", why: "缺 selection_context（旧形 claim）" };
  }
  const digest = claim.selection_context_digest_v1;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    return { ok: false, reason: "selection_context_digest_missing", why: "缺 selection_context_digest_v1（旧形 claim）" };
  }
  const missing = [];
  if (!ctx.endpoint) missing.push("endpoint");
  if (!ctx.chat) missing.push("chat");
  if (!ctx.sender) missing.push("sender");
  if (!ctx.message) missing.push("message");
  if (!ctx.handle) missing.push("handle");
  if (!ctx.kind) missing.push("kind");
  if (missing.length > 0) {
    return { ok: false, reason: "selection_context_incomplete", why: "selection_context 缺项：" + missing.join(", ") };
  }
  const expectedDigest = selectionContextDigestV1(ctx);
  if (digest !== expectedDigest) {
    return { ok: false, reason: "select_context_conflict", why: "selection_context_digest_v1 与内容不一致" };
  }
  return { ok: true, context: ctx };
}

/** 写入准入 —— 默认读真实状态（执行器未接入期准入通过也落 failed(select_executor_absent) 终态，见 executeSelectControl）。 */
export function selectAdmission(env = process.env) {
  return readOwnerSelectAdmission(env);
}

/** 三态准入的确定性投影：返回 { reason, text }（拒绝）或 null（放行）。准入联合以外的任何状态（缺席/未知/非对象）一律投影为 unreadable → 拒。 */
export function selectReject(adm, handle_kind) {
  if (adm === null || typeof adm !== "object" || Array.isArray(adm)) {
    return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
  }
  if (adm.state === "unreadable") return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
  if (adm.state === "off") return { reason: "select_off", text: "选择功能未开放（迁移未开始）" };
  if (adm.state === "partial") {
    if (handle_kind !== "rfh") return { reason: "select_partial_not_rfh", text: "迁移期间只接受 rfh_ 重确认 handle" };
    return null;
  }
  if (adm.state === "on") return null;
  return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
}

/** 拒绝 reason → 说明文案（封闭映射；重放从记录恢复文案时同一份）。 */
export function selectRejectTextByReason(reason) {
  if (reason === "select_executor_absent") return "已收到选择，执行器尚未接入，本条未消费；执行器接入后请重新发送";
  if (reason === "select_writer_state_unreadable") return "选择功能状态读不清，未执行";
  if (reason === "select_off") return "选择功能未开放（迁移未开始）";
  if (reason === "select_partial_not_rfh" || reason === "select_not_partial") return "迁移期间只接受 rfh_ 重确认 handle";
  if (reason === "outer_lock_required") return "外层排序锁未持有，未执行";
  if (reason === "maintenance") return "维护进行中，未执行";
  // R57b：rfh 支的失败映射（全部封闭，不让裸 reason 漏给 owner）
  if (reason === "reaffirm_handle_unknown") return "重确认 handle 不存在或已被消费；要重做请在终端重新签发一条";
  if (reason === "reaffirm_intent_expired") return "重确认 handle 已过期，请在终端重新签发";
  if (reason === "sender_mismatch") return "只有签发时登记的 owner 本人才可消费这个重确认 handle";
  if (reason === "chat_mismatch") return "请在签发时对应的话题里发送这条选择";
  if (reason === "family_changed") return "目标记录在签发后变动过（暂停/恢复），请重新签发重确认";
  if (reason === "digest_cas_mismatch" || reason === "selection_mismatch") return "目标记录在签发后变动过，请重新签发重确认";
  if (reason === "reaffirm_target_missing") return "目标记录已不在账本里，请重新签发";
  if (reason === "reaffirm_intents_unreadable") return "重确认意图文件读不出（fail-closed），未执行；请人工检查";
  if (reason === "reaffirm_intents_busy") return "重确认处理忙，请稍后重发一条新消息";
  if (reason === "reaffirm_intents_unwritable") return "重确认意图写不进（fail-closed），未执行；请人工检查";
  if (reason === "ledger_corrupt" || reason === "ledger_unreadable") return "账本读不出，未执行（fail-closed）";
  if (reason === "schema_not_11") return "账本还没升到 1.1，不能重签";
  return "控制执行失败（" + reason + "）";
}

/** rfh 成功文案（按 result 分支如实说签了什么）。 */
export function selectReaffirmSuccessText(result) {
  const what = result?.new_binding_proof ? "绑定与链路证明" : "链路证明";
  return "已按你的确认重签该目标的" + what + "（target " + String(result?.target_id ?? "?").slice(0, 40) + "）";
}

/**
 * 执行选择控制命令（在控制事务锁内跑）。
 * R52a（PR #136 二轮回带）：准入通过但执行器缺席 → 落普通 failed 终态 select_executor_absent（终态不重试）。
 * R57b（§8.1/§12）：rfh 支接真执行器 —— owner_select_reaffirm 消费 reaffirm intent；入站 sender /
 * endpoint / chat 的消费侧核验在消费编排与 ledger op 内（§8.1 五核），本入口只负责把事件事实带进去。
 * 注入面：selectAdmissionFn / consumeReaffirm（测试密闭，不读环境变量开关）。
 */
export function executeSelectControl(intent, {
  selectAdmissionFn = selectAdmission,
  consumeReaffirm = consumeReaffirmIntent,
  senderId = null, chatId = null, endpointId = null, messageId = null,
  now = Date.now(), env = process.env, _inject = undefined,
} = {}) {
  const adm = selectAdmissionFn(env);
  const ej = selectReject(adm, intent?.handle_kind);
  if (ej) return { ok: false, reason: ej.reason, text: ej.text };
  if (intent?.handle_kind !== "rfh") {
    return { ok: false, reason: "select_executor_absent", text: "已收到选择，执行器尚未接入，本条未消费；执行器接入后请重新发送" };
  }
  if (typeof intent.handle !== "string" || !REAFFIRM_HANDLE_SHAPE.test(intent.handle)) {
    return { ok: false, reason: "reaffirm_handle_unknown", text: selectRejectTextByReason("reaffirm_handle_unknown") };
  }
  const res = consumeReaffirm({ endpointId, reaffirmHandle: intent.handle, sender: senderId, chatId, selectionMessageId: messageId, selectAdmissionFn, now, env, _inject });
  if (res.status === "control-committed-unclean") {
    return {
      ok: false,
      status: "control-committed-unclean",
      reason: "control_committed_unclean",
      text: "已写入但收口不干净（" + (res.why ?? "账本已写入但未收净，请联系管理员修复") + "）",
      ledger: res.ledger,
      intent_cleanup: res.intent_cleanup,
      locks: res.locks,
      result: res.result,
      why: res.why,
    };
  }
  if (!res.ok) {
    return { ok: false, status: "failed", reason: res.reason ?? "reaffirm_failed", text: selectRejectTextByReason(res.reason ?? "reaffirm_failed") };
  }
  return { ok: true, status: "consumed", changed: res.idempotent === true ? false : true, text: selectReaffirmSuccessText(res.result) };
}

