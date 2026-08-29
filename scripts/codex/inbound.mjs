#!/usr/bin/env node
/** M5Codex 唯一入站入口：确定性校验、原子 claim、精确 thread 非阻塞投递、秒级回执。 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { acquireClaim, claimKey, readClaimState, recordClaimState } from "../claim.mjs";
import { fetchTriggerEvent } from "../envelope.mjs";
import { moduleRoot } from "../direct-run.mjs";
import {
  acquireSessionLock, releaseSessionLock, stampSessionLock,
} from "../handoff.mjs";
import { REJECT } from "../selector.mjs";
import {
  MAPPING_DISPOSITION, buildLegacyMappingContext, evaluateMappingAdmission, handleMappingPolicy,
} from "../mapping-policy.mjs";
import {
  DIALOGUE_POLICY_ID, DIALOGUE_REASON, DIALOGUE_TURN_STATUS,
  applyInteractionPolicyToAdmission, handleDialoguePolicy,
} from "../interaction-policy.mjs";
import { handOffCodex } from "./handoff.mjs";
import { recordCodexActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";
import {
  buildLegacyDialogueBoundAuthorizationContext,
} from "../dialogue-binding-authorization.mjs";
import {
  dialogueAuthorizationShadowEnabled, recordDialogueBoundAuthorizationShadow,
} from "../dialogue-authorization-shadow-store.mjs";
import {
  appendConsumed, bridgeHome, buildCodexSubscriptionProjection, closeTaskTopicRotation,
  evaluatePromotion, findPendingTask,
  finalizeTaskDialogueTurn, findTaskForFeishuSession, interactionPolicyForTask,
  isThreadBusy, loadCodexTemplate, promoteTask, reserveTaskDialogueTurn, setTaskInteractionMode,
  shadowCodexFirstClaim, taskPaths,
} from "./state.mjs";
import { controlAckText, runControlTransaction } from "../control-command.mjs";
import { codexControlPrecondition } from "./control-identity.mjs";
import { senderRole } from "../sender-roles.mjs";
import { classifyRisk } from "../risk-class.mjs";
import { parseInboundIntent, controlRejectText, rejectedControlProjection } from "../inbound-intent.mjs";
import { runRejectTransaction } from "../reject-control.mjs";
import { sameRejectedControl } from "../control-intent.mjs";
import { authorize } from "../authorize.mjs";
import { isDirectRun } from "../direct-run.mjs";
import { composeCrashReceipt } from "../crash-receipt.mjs";
/**
 * 整个入站流程包在 main() 里，只有被直接执行时才跑。
 *
 * 在此之前这个文件是纯顶层脚本：**import 它就等于跑一次入站分发**。做冒烟测试时
 * 我 import 过一次，它真的执行了整条流程并输出了拒绝回执 —— 那次没造成损害只是运气，
 * 换个环境变量组合就会写 claim、写回执、甚至投递。
 *
 * 刻意**不重排函数体的缩进**：这个文件近七百行，重排会让 diff 完全无法评审，
 * 而这次改动的实质只有"加一道守卫"。可读性代价换评审可读性，是有意的取舍。
 */
async function main() {

const BRIDGE_ROOT = moduleRoot(import.meta.url, "../..");
const HOME = bridgeHome();
let receiptDir = path.join(HOME, "receipts");

function writeReceipt(name, payload) {
  try {
    fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const file = path.join(receiptDir, name + ".json");
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      schema_version: "1.0",
      artifact_type: "codex_feishu_bridge_inbound_receipt",
      zone: "work",
      classification: "internal",
      recorded_at: new Date().toISOString(),
      ...payload,
    }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  } catch {
    // 回执是审计证据，不是继续执行的授权闸。前置失败时若沙箱连诊断目录也不允许写，
    // 仍只向 stdout 返回脱敏错误，绝不能把 Node 堆栈原样泄露到飞书。
    return null;
  }
}

const REASON_TEXT = {
  no_pending_binding: "这个话题没有绑定任务，也没有等待绑定的 Codex task",
  multiple_pending_bindings: "同时有多个 Codex task 等待绑定，无法确定目标",
  multiple_binding_tokens: "根消息引用中出现多个绑定码，无法确定目标",
  pending_binding_token_unknown: "根消息引用中的绑定码不对应任何待绑定 Codex task",
  duplicate_pending_binding_token: "多个待绑定 Codex task 使用同一绑定码，无法确定目标",
  pending_binding_expired: "等待绑定已过期，需要重新执行接入",
  sender_not_frank: "发送者不是授权用户",
  transport_not_mentioned: "没有真实 @ M5Codex",
  stale_message: "消息超出时效窗口",
  malformed_event: "消息信封字段不完整",
};

function ackText(kind, detail) {
  if (kind === "accepted") return [
    "已受理 · " + detail.taskName,
    "已投递到绑定的 Codex task。严格确认完成后会自动回复到本话题；失败会发送风险回执。",
    "消息 " + detail.messageId.slice(-8) + " | claim " + detail.key.slice(0, 8),
  ].join("\n");
  if (kind === "bound") return [
    "绑定完成 · " + detail.taskName,
    "这个话题现在精确通向一个 Codex task。之后在这里 @ M5Codex 即可续接。",
  ].join("\n");
  if (kind === "control") return detail.text;
  if (kind === "rejected") return [
    "已拒绝 · " + detail.reasonText,
    detail.taskName ? "本话题通向：" + detail.taskName + "。" : null,
    "本条指令没有被投递给任何任务。",
  ].filter(Boolean).join("\n");
  return "系统错误 · " + detail.detail + "\n本条指令没有被投递，请勿视为已受理。";
}

function finish(kind, detail, _result) {
  process.stdout.write(ackText(kind, detail) + "\n");
  // Aily 的 exec_command 会把 stdout 与 stderr 合并进模型可见输出。结构化诊断若写到
  // stderr，就会被 M5Codex 原样带回飞书并泄露 task locator。机器证据已写入 Git 外
  // receipt/claim/run 文件；进程通道只保留面向用户的 stdout 与退出码。
  process.exit(kind === "error" ? 1 : 0);
}

const dryRun = process.argv.includes("--dry-run");
const template = loadCodexTemplate();
if (!template.ok) {
  writeReceipt("template-" + Date.now(), { status: "error", reason: template.reason });
  finish("error", { detail: "Codex 单智能体链路模板不可用（" + template.reason + "）" },
    { reason: "template_unusable" });
}

// 第 0 道闸必须在取信封之前：只有配置里的 M5Codex 可以调用本入口。
const callerAgent = process.env.AILY_CLI_CALLER_AGENT_UID;
if (callerAgent !== template.template.agent_uid) {
  writeReceipt("wrong-agent-" + Date.now(), {
    status: "rejected", reason: "caller_agent_mismatch", claim_acquired: false, handed_off: false,
  });
  finish("rejected", { reasonText: "调用方不是本链路配置的 M5Codex", taskName: null },
    { reason: "caller_agent_mismatch" });
}

const fetched = fetchTriggerEvent();
if (!fetched.ok) {
  writeReceipt("envelope-" + fetched.reason + "-" + Date.now(), {
    status: "error", reason: fetched.reason, attempts: fetched.attempts ?? 1,
    claim_acquired: false, handed_off: false,
  });
  finish("error", { detail: "取不到本次消息信封（" + fetched.reason + "）" }, { reason: fetched.reason });
}
const event = fetched.event;

let routed = findTaskForFeishuSession({ sessionId: event.session_id, home: HOME });
let justBound = false;
let subscriptionClaimShadow = null;
if (!routed.ok) {
  if (routed.reason !== "no_binding_for_session") {
    finish("error", { detail: "Codex task registry 无法路由（" + routed.reason + "）" }, { reason: routed.reason });
  }
  const promotionNow = Date.now();
  const pending = findPendingTask({ home: HOME, content: event.content, now: promotionNow });
  if (!pending.ok && pending.reason === "pending_binding_expired" && pending.operationId &&
      pending.task?.codex_thread_id) {
    closeTaskTopicRotation({
      threadId: pending.task.codex_thread_id,
      operationId: pending.operationId,
      reason: "expired",
      home: HOME,
      now: promotionNow,
    });
  }
  if (!pending.ok && ![
    "no_pending_binding", "multiple_pending_bindings", "multiple_binding_tokens",
    "pending_binding_token_unknown", "duplicate_pending_binding_token", "pending_binding_expired",
  ].includes(pending.reason)) {
    finish("error", { detail: "Codex task registry 无法读取（" + pending.reason + "）" }, { reason: pending.reason });
  }
  const promotion = evaluatePromotion({
    event, template: template.template, pending, now: promotionNow,
  });
  subscriptionClaimShadow = shadowCodexFirstClaim({
    event,
    template: template.template,
    callerAgentUid: callerAgent,
    legacyPending: pending,
    legacyPromotion: promotion,
    home: HOME,
    now: promotionNow,
  });
  if (!promotion.ok) {
    const reasonText = REASON_TEXT[promotion.reason] ?? promotion.reason;
    writeReceipt("unrouted-" + (event.message_id ?? Date.now()), {
      status: "rejected", reason: promotion.reason, claim_acquired: false, handed_off: false,
      subscription_claim_shadow: subscriptionClaimShadow,
    });
    if (dryRun) finish("rejected", { reasonText: "[dry-run] " + reasonText, taskName: null },
      { dry_run: true, reason: promotion.reason });
    finish("rejected", { reasonText, taskName: null }, { reason: promotion.reason });
  }
  if (dryRun) {
    process.stdout.write("[dry-run] 会把这个话题绑定到 " + promotion.task.task_display_name + "；没有写 registry。\n");
    process.exit(0);
  }
  const promoted = promoteTask({
    logicalTaskKey: promotion.task.logical_task_key,
    sessionId: event.session_id,
    generationId: pending.generationId,
    operationId: pending.operationId,
    home: HOME,
  });
  if (!promoted.ok) {
    writeReceipt("bind-failed-" + (event.message_id ?? Date.now()), {
      status: "error", reason: promoted.reason, message_id: event.message_id ?? null,
      claim_acquired: false, handed_off: false,
      subscription_claim_shadow: subscriptionClaimShadow,
    });
    finish("error", { detail: "绑定没写成（" + promoted.reason + "）" }, { reason: promoted.reason });
  }
  justBound = true;
  routed = findTaskForFeishuSession({ sessionId: event.session_id, home: HOME });
  if (!routed.ok) finish("error", { detail: "绑定写完却读不回来" }, { reason: routed.reason });
}

const task = routed.task;
const paths = taskPaths(task, HOME);
receiptDir = paths.receipts;
const verdict = evaluateMappingAdmission({
  canonicalEvent: fetched.canonical_event,
  event,
  mapping: routed.mapping,
  config: routed.config,
  now: Date.now(),
});
// 与 Claude adapter 相同的 B1 旁路：默认关闭，只留独立 shadow 证据，不参与真实路由。
if (!dryRun && dialogueAuthorizationShadowEnabled()) {
  try {
    const context = buildLegacyDialogueBoundAuthorizationContext({
      runtimeNamespace: "codex",
      model: buildCodexSubscriptionProjection({ home: HOME, template: template.template }),
      legacyKey: task.logical_task_key,
      privateBindingKey: routed.mapping.binding_id,
      bindingStatus: routed.mapping.status,
      verdict,
    });
    if (context.ok) {
      recordDialogueBoundAuthorizationShadow({
        shadowDir: paths.dialoguePlannerShadow,
        authorizationInput: context.authorizationInput,
        canonicalEvent: fetched.canonical_event,
        runtimeNamespace: "codex",
        expectedBindingRef: context.expectedBindingRef,
        legacy: context.legacy,
      });
    }
  } catch { /* shadow 永不承重 */ }
}
const interaction = interactionPolicyForTask(task);
if (!interaction.ok) {
  writeReceipt("policy-state-" + (event.message_id ?? Date.now()), {
    status: "error", reason: interaction.reason, message_id: event.message_id ?? null,
    claim_acquired: false, handed_off: false,
  });
  finish("error", { detail: "交互策略状态不可用（" + interaction.reason + "）" },
    { reason: interaction.reason });
}
const policyEvaluation = applyInteractionPolicyToAdmission(verdict, interaction.state);
const dialogueMode = policyEvaluation.policy_id === DIALOGUE_POLICY_ID;
const handlePolicy = (args = {}) => dialogueMode
  ? handleDialoguePolicy({ evaluation: policyEvaluation, ...args })
  : handleMappingPolicy({ evaluation: policyEvaluation, ...args });

if (justBound && verdict.decision === "reject" && verdict.reason === REJECT.EMPTY_INSTRUCTION) {
  appendConsumed(task, event.message_id, { home: HOME });
  writeReceipt("bound-" + event.message_id, {
    status: "bound", message_id: event.message_id, logical_task_key: task.logical_task_key,
    claim_acquired: false, handed_off: false,
    subscription_claim_shadow: subscriptionClaimShadow,
  });
  finish("bound", { taskName: task.task_display_name }, { bound: true, logical_task_key: task.logical_task_key });
}

if (dryRun) {
  const detail = verdict.reasonText ?? "校验通过，但没有 claim、没有投递";
  process.stdout.write("[dry-run] " + verdict.decision + " · " + detail + "\n");
  process.exit(0);
}

if (verdict.decision === "reject") {
  const policyOutcome = handlePolicy();
  writeReceipt("reject-" + (event.message_id ?? Date.now()), {
    status: "rejected", reason: verdict.reason, message_id: event.message_id,
    logical_task_key: task.logical_task_key, claim_acquired: false, handed_off: false,
    policy_id: policyOutcome.policy_id,
    policy_version: policyOutcome.policy_version,
    policy_disposition: policyOutcome.disposition,
    ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
    ...(subscriptionClaimShadow ? { subscription_claim_shadow: subscriptionClaimShadow } : {}),
  });
  finish("rejected", { reasonText: verdict.reasonText, taskName: task.task_display_name }, { reason: verdict.reason });
}

const mappingContext = buildLegacyMappingContext({
  runtime: "codex",
  mapping: routed.mapping,
  canonicalEvent: fetched.canonical_event,
  event,
});
if (!mappingContext.ok) {
  writeReceipt("policy-context-" + verdict.messageId, {
    status: "error", reason: mappingContext.reason, message_id: verdict.messageId,
    claim_acquired: false, handed_off: false,
  });
  finish("error", { detail: "映射策略上下文不完整" }, { reason: mappingContext.reason });
}

// 控制命令（$feishu-mode dialogue|mapping）：三道闸之后先解析意图、随 claim 持久化；执行与终态在拿到 claim 之后做（可恢复事务）。
// 第 3 层：正文先落进封闭的意图联合（inbound-intent.mjs），control 只是其中 router_control 那一支；入口按 intent 做确定性处置。
const intent = parseInboundIntent({ instruction: verdict.instruction, chain: "codex" });
const control = intent.control;
const rejectedProjection = rejectedControlProjection(intent);

// ---------- 唯一一处授权判定（角色 × 风险等级 × 模式）：三道闸之后、拿 claim 之前 ----------
// 拒绝必须说清"哪个模式、哪个角色、缺什么权限"，不投递、不静默；不取 claim（重发不算重放）。
const senderRoleValue = senderRole({ frank_sender_id: routed.mapping.frank_sender_id, senders: routed.config?.senders }, event.sender_id);
const risk = classifyRisk({ intent, mode: policyEvaluation.policy_id });
const authz = authorize({ role: senderRoleValue, riskClass: risk.riskClass, mode: policyEvaluation.policy_id, chain: "codex" });
if (!authz.allow) {
  writeReceipt("authz-" + verdict.messageId, {
    status: "rejected", reason: "not_authorized", authz_reason: authz.reason, role: senderRoleValue, risk_class: risk.riskClass, risk_kind: risk.kind,
    policy_id: policyEvaluation.policy_id, required_roles: authz.required, message_id: verdict.messageId, logical_task_key: task.logical_task_key, claim_acquired: false, handed_off: false,
  });
  finish("rejected", { reasonText: authz.text, taskName: task.task_display_name }, { reason: "not_authorized", authz_reason: authz.reason, risk_class: risk.riskClass });
}
// 控制事务用的身份期望 —— 与 claim 里写的身份字段同一算法；换绑 / 换线程之后同 key 的旧 claim 对不上，就不替它执行、不重出回执。
const claimExpect = { logicalTaskKey: task.logical_task_key, codexThreadId: task.codex_thread_id };
// ---------- 近似命中收边（第 3 层）：拒绝事务 —— 与控制命令事务同一套形状（锁内记账、重放按记录重出、损坏指路维护入口） ----------
const rejectControl = (replay) => {
  const tx = runRejectTransaction({ claimsDir: paths.claims, key: claim.key, projection: rejectedProjection, replay, expect: claimExpect });
  const lockNote = tx.lockUncleared ? "；另外这一笔的事务锁没有交还（" + tx.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后处理" : "";
  const base = { reason: intent.intent, word: intent.word, problem: intent.problem, message_id: verdict.messageId, logical_task_key: task.logical_task_key, claim_acquired: !replay, handed_off: false, lock_uncleared: tx.lockUncleared ?? null };
  if (!tx.ok) {
    writeReceipt("malformed-control-" + verdict.messageId, { status: "error", ...base, tx_reason: tx.reason, error: tx.why });
    const broken = tx.reason === "rejected_unreadable" || tx.reason === "rejected_intent_mismatch";
    finish("error", { detail: (broken
      ? "这一笔的拒绝记录" + (tx.reason === "rejected_unreadable" ? "损坏" : "与意图不一致") + "（" + tx.why + "）；没有执行也没有投递。请用维护入口 repair-control-claim 处理这一笔"
      : "拒绝没有记下（" + tx.reason + "：" + tx.why + "）；没有执行也没有投递。同一条消息的运输层重放会补齐") + lockNote }, { reason: tx.reason, intent: intent.intent });
  }
  writeReceipt("malformed-control-" + verdict.messageId, { status: "rejected", ...base, replayed: tx.replayed, resumed: tx.resumed });
  finish("rejected", { reasonText: controlRejectText(intent) + (tx.replayed ? "（同一条消息的重放：按记录重出回执）" : tx.resumed ? "（补齐了上次没记下的拒绝终态）" : "") + lockNote, taskName: task.task_display_name },
    { reason: intent.intent, word: intent.word, replayed: tx.replayed, resumed: tx.resumed });
};
const runControl = (replay) => {
  const tx = runControlTransaction({
    claimsDir: paths.claims, key: claim.key, intent: control ? { control: control.kind, mode: control.mode } : undefined, replay, expect: claimExpect,
    // task 写锁内再核一次身份（与维护入口同一份判据）：事务核验与写入之间换了 task，旧命令不许改新对象。
    execute: (mode) => setTaskInteractionMode({ threadId: task.codex_thread_id, mode, home: HOME,
      precondition: codexControlPrecondition({ claimsDir: paths.claims, key: claim.key, expect: claimExpect }) }),
  });
  // 锁没干净交还的话，不管事务成败都要说出来：之后同一笔会报 control_busy。
  const lockNote = tx.lockUncleared ? "；另外这一笔的事务锁没有交还（" + tx.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后处理" : "";
  const receiptBase = { control: control.kind, mode: control.mode, message_id: verdict.messageId, handed_off: false, lock_uncleared: tx.lockUncleared ?? null };
  if (!tx.ok) {
    const fail = (detail, extra = {}) => {
      writeReceipt("control-" + verdict.messageId, { status: "error", reason: tx.reason, ...receiptBase, claim_acquired: !replay, error: tx.why, ...extra });
      finish("error", { detail: detail + lockNote }, { reason: tx.reason });
    };
    if (tx.reason === "ledger_unwritten") fail("模式已切换，但终态没记下（" + tx.why + "）；重发不会补齐（新消息是新一笔），请用维护入口 repair-control-claim 处理这一笔", { changed: tx.changed });
    if (tx.reason === "control_failed_recorded") fail("这条控制命令之前执行失败（" + tx.why + "）；本次是同一条消息的重放，没有再次尝试。要再切请重新发一条。", { replayed: true });
    if (tx.reason === "control_conflict") fail("这一笔的终态自相矛盾（" + tx.why + "），没有执行；请用维护入口 repair-control-claim 处理这一笔");
    fail("模式没有切换（" + tx.why + "）");
  }
  writeReceipt("control-" + verdict.messageId, { status: "consumed", ...receiptBase, changed: tx.changed, replayed: tx.replayed, resumed: tx.resumed, claim_acquired: !replay });
  finish("control", { text: controlAckText({ taskName: task.task_display_name, mode: control.mode, changed: tx.changed, replayed: tx.replayed, resumed: tx.resumed, lockUncleared: tx.lockUncleared ?? null }) },
    { control: control.kind, mode: control.mode, changed: tx.changed, replayed: tx.replayed, resumed: tx.resumed });
};

const claim = acquireClaim({
  claimsDir: paths.claims,
  messageId: verdict.messageId,
  logicalTaskKey: task.logical_task_key,
  meta: {
    ...(control ? { control: { control: control.kind, mode: control.mode } } : {}),
    ...(rejectedProjection ? { rejected_control: rejectedProjection } : {}),
    session_id: event.session_id,
    codex_thread_id: task.codex_thread_id,
    policy_id: policyEvaluation.policy_id,
    policy_version: policyEvaluation.policy_version,
    local_target_id: mappingContext.localTargetId,
    origin_channel_generation_id: mappingContext.originChannelGenerationId,
    mapping_admission_shadow_match: verdict.admission_shadow?.match ?? null,
  },
});
if (!claim.ok && claim.reason === "duplicate" && control) {
  const original = readClaimState({ claimsDir: paths.claims, key: claim.key, expect: claimExpect });
  const intent = original.status === "valid" ? original.claim.control : undefined;
  if (intent && intent.control === control.kind && intent.mode === control.mode) {
    claim.key = claim.key ?? claimKey(verdict.messageId, verdict.logicalTaskKey);
    runControl(true);
  }
}
if (!claim.ok && claim.reason === "duplicate" && rejectedProjection) {
  // 收边的重放：意图从 claim 里恢复；一致才按事务补齐 / 重出（不一致说明是另一条不同正文的消息撞了同一 id，落到通用的幂等命中）。
  const original = readClaimState({ claimsDir: paths.claims, key: claim.key, expect: claimExpect });
  if (original.status === "valid" && sameRejectedControl(original.claim.rejected_control, rejectedProjection)) {
    claim.key = claim.key ?? claimKey(verdict.messageId, verdict.logicalTaskKey);
    rejectControl(true);
  }
}

if (!claim.ok) {
  const duplicate = claim.reason === "duplicate";
  const policyOutcome = handlePolicy({ claim, resolvedContext: mappingContext });
  writeReceipt("claim-" + claim.reason + "-" + verdict.messageId, {
    status: duplicate ? "rejected" : "error",
    reason: claim.reason,
    message_id: verdict.messageId,
    claim_acquired: false,
    handed_off: false,
    policy_id: policyOutcome.policy_id,
    policy_version: policyOutcome.policy_version,
    policy_disposition: policyOutcome.disposition,
    ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
  });
  finish(duplicate ? "rejected" : "error", {
    reasonText: duplicate ? "这条消息已经处理过（幂等命中）" : undefined,
    detail: duplicate ? undefined : "无法取得投递权（" + claim.reason + "）",
    taskName: task.task_display_name,
  }, { reason: claim.reason });
}

// ---------- 近似命中收边（第 3 层）：不开放 / 不精确的命令形状，取 claim 后记拒绝终态、回执差在哪，不投递 ----------
// 能走到这里的只有 owner（非 owner 的 R3 在上面的 authorize 就拒了）；重放同一条消息撞的是 claim 的幂等，不会再记一次。
if (rejectedProjection) rejectControl(false);

// ---------- 控制命令：拿到 claim 之后当场执行（可恢复事务），不投递 ----------
if (control) runControl(false);

let policyRun = dialogueMode ? null : handlePolicy({ claim, resolvedContext: mappingContext });
if (!dialogueMode &&
    (policyRun.disposition !== MAPPING_DISPOSITION.ACCEPTED || !policyRun.runRequest)) {
  recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed",
    detail: { reason: policyRun.reason ?? "mapping_policy_rejected" } });
  finish("error", { detail: "映射策略没有生成可执行请求" },
    { reason: policyRun.reason ?? "mapping_policy_rejected" });
}

if (isThreadBusy(task.codex_thread_id, { home: HOME })) {
  const busyOutcome = handlePolicy({ claim, resolvedContext: mappingContext, targetState: "busy" });
  recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed", detail: { reason: "target_busy" } });
  writeReceipt("busy-" + verdict.messageId, {
    status: "error", reason: "target_busy", message_id: verdict.messageId,
    claim_acquired: true, handed_off: false,
    policy_id: busyOutcome.policy_id,
    policy_version: busyOutcome.policy_version,
    policy_disposition: busyOutcome.disposition,
    ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
  });
  finish("error", { detail: "目标 Codex task 当前正在执行另一轮，请稍后发送一条新消息" }, { reason: "target_busy" });
}

const lock = acquireSessionLock(paths.sessionLock);
if (!lock.ok) {
  const busyOutcome = handlePolicy({ claim, resolvedContext: mappingContext, targetState: "busy" });
  recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed", detail: { reason: lock.reason } });
  writeReceipt("busy-lock-" + verdict.messageId, {
    status: "error", reason: lock.reason, message_id: verdict.messageId,
    claim_acquired: true, handed_off: false,
    policy_id: busyOutcome.policy_id,
    policy_version: busyOutcome.policy_version,
    policy_disposition: busyOutcome.disposition,
    ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
  });
  finish("error", { detail: "目标 Codex task 正忙，上一条飞书指令还没结束" }, { reason: lock.reason });
}

if (dialogueMode) {
  const reservation = reserveTaskDialogueTurn({
    threadId: task.codex_thread_id,
    eventId: verdict.messageId,
    runId: claim.key,
    localTargetId: mappingContext.localTargetId,
    originChannelGenerationId: mappingContext.originChannelGenerationId,
    runtimeTargetId: task.codex_thread_id,
    home: HOME,
  });
  if (!reservation.ok) {
    releaseSessionLock(paths.sessionLock);
    recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed",
      detail: { reason: reservation.reason } });
    const busy = reservation.reason === DIALOGUE_REASON.TURN_ACTIVE;
    finish(busy ? "error" : "rejected", {
      detail: busy ? "Dialogue 当前仍有活动回合，请等待它完成" : undefined,
      reasonText: busy ? undefined : "Dialogue 无法开始新回合（" + reservation.reason + "）",
      taskName: task.task_display_name,
    }, { reason: reservation.reason });
  }
  policyRun = handlePolicy({ claim, resolvedContext: mappingContext, reservation });
  if (policyRun.disposition !== "accepted" || !policyRun.runRequest) {
    releaseSessionLock(paths.sessionLock);
    recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed",
      detail: { reason: policyRun.reason ?? "dialogue_policy_rejected" } });
    finish("rejected", {
      reasonText: "Dialogue 已达到停止条件（" + (policyRun.reason ?? "unknown") + "）",
      taskName: task.task_display_name,
    }, { reason: policyRun.reason ?? "dialogue_policy_rejected" });
  }
}

const stamped = [
  "[飞书 · " + verdict.messageId + " · " + new Date(Number(event.created_at_ms)).toISOString() + "]",
  ...(dialogueMode ? ["[Dialogue · " + policyRun.runRequest.policy.dialogue_id +
    " · turn " + policyRun.runRequest.policy.turn_index + "]"] : []),
  policyRun.runRequest.userInput,
].join("\n");
let run;
try {
  run = handOffCodex({
    projectDir: task.root,
    threadId: task.codex_thread_id,
    instruction: stamped,
    runsDir: paths.runs,
    key: policyRun.runRequest.runId,
    taskKey: task.logical_task_key,
    bridgeHome: HOME,
    codexBin: process.env.FEISHU_CODEX_BIN ?? "codex",
  });
} catch (err) {
  releaseSessionLock(paths.sessionLock);
  if (dialogueMode) {
    finalizeTaskDialogueTurn({
      threadId: task.codex_thread_id, runId: claim.key,
      status: DIALOGUE_TURN_STATUS.FAILED, reason: "handoff_failed", home: HOME,
    });
  }
  recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed", detail: { error: err.message } });
  writeReceipt("handoff-failed-" + verdict.messageId, {
    status: "error", reason: "handoff_failed", message_id: verdict.messageId,
    claim_acquired: true, handed_off: false,
  });
  finish("error", { detail: "投递失败：" + err.message }, { reason: "handoff_failed" });
}

stampSessionLock(paths.sessionLock, { pid: run.pid, logPath: run.logPath });
const watcherLog = fs.openSync(path.join(paths.runs, claim.key + ".watch.log"), "a");
const watcher = spawn(process.execPath, [
  path.join(BRIDGE_ROOT, "scripts", "codex", "watch-run.mjs"),
  "--claim-key", claim.key,
  "--task-key", task.logical_task_key,
], {
  cwd: BRIDGE_ROOT,
  detached: true,
  stdio: ["ignore", watcherLog, watcherLog],
  env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: HOME },
});
watcher.unref();

recordClaimState({
  claimsDir: paths.claims,
  key: claim.key,
  state: "handed_off",
  detail: { pid: run.pid, log_path: run.logPath, target_thread_id: task.codex_thread_id },
});
appendConsumed(task, verdict.messageId, { home: HOME });
const topicActivity = recordCodexActivityAndMaybeRotate({
  root: task.root,
  threadId: task.codex_thread_id,
  home: HOME,
  generationId: policyRun.runRequest.origin.channelGenerationId,
  eventKey: "inbound:codex:" + verdict.messageId,
  messageDelta: 1,
});
writeReceipt("accepted-" + verdict.messageId, {
  status: "accepted", message_id: verdict.messageId, claim_key: claim.key,
  run_id: policyRun.runRequest.runId,
  local_target_id: policyRun.runRequest.localTargetId,
  origin_channel_generation_id: policyRun.runRequest.origin.channelGenerationId,
  policy_id: policyRun.policy_id,
  policy_version: policyRun.policy_version,
  policy_disposition: policyRun.disposition,
  ...(dialogueMode ? {
    dialogue_id: policyRun.runRequest.policy.dialogue_id,
    dialogue_turn_index: policyRun.runRequest.policy.turn_index,
  } : {}),
  ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
  logical_task_key: task.logical_task_key, claim_acquired: true, handed_off: true,
  completion_observed: false, completion_owner: "codex_stop_hook_and_local_watcher",
  delivery_mode: run.mode, envelope_attempts: fetched.attempts ?? 1,
  topic_activity: topicActivity.ok ? {
    counted: topicActivity.counted === true,
    message_count: topicActivity.messageCount ?? null,
    auto_rotation_requested: topicActivity.shouldAutoRotate === true,
    auto_rotation_launched: topicActivity.rotationLaunch?.ok ?? null,
  } : { counted: false, reason: topicActivity.reason },
  ...(subscriptionClaimShadow ? { subscription_claim_shadow: subscriptionClaimShadow } : {}),
});

finish("accepted", {
  taskName: task.task_display_name,
  messageId: verdict.messageId,
  key: claim.key,
}, { claim_key: claim.key, delivery_mode: run.mode });
}

if (isDirectRun(import.meta.url)) {
  // 用 catch 收口而不是顶层 await —— 后者会让 import 也等它跑完。
  main().catch((err) => {
    // stderr 一个字都不写：Aily 会把进程输出带回模型可见通道。
    // 完整堆栈只进机器级日志，对外只给一个可对照的引用码。
    // bridgeHome() 自己也可能因环境变量非法而抛，所以先兜住再算日志路径。
    let logFile = null;
    try { logFile = path.join(bridgeHome(), "inbound-crash.log"); } catch { /* 下面按未落盘处理 */ }
    const receipt = composeCrashReceipt({ error: err, logFile });
    process.stdout.write(receipt.text);
    process.exit(1);
  });
}
