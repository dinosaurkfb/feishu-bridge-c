#!/usr/bin/env node
/**
 * 入站主流程 —— M5Claude 唯一被允许调用的入口。
 *
 * 不接受任何入参：事件字段一律由脚本自己向 Aily 取（见 envelope.mjs），
 * 模型不参与构造。输出一段给 Frank 的回执文本（stdout）和一份机器可读结果（stderr）。
 *
 * 时间契约：这个脚本必须秒级返回。它**不等待**长期任务完成 —— 完成由出站流程负责。
 *
 * 顺序不可调换：先校验、再 claim、再投递。任何一步失败都不进入下一步。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REJECT } from "./selector.mjs";
import { fetchTriggerEvent } from "./envelope.mjs";
import { acquireClaim, claimKey, readClaimState, recordClaimState, watcherExpectEnv } from "./claim.mjs";
import { effectiveBindingId } from "./topic-generation.mjs";
import { moduleRoot } from "./direct-run.mjs";
import {
  MAPPING_DISPOSITION, buildLegacyMappingContext, evaluateMappingAdmission, handleMappingPolicy,
} from "./mapping-policy.mjs";
import {
  DIALOGUE_POLICY_ID, DIALOGUE_REASON, DIALOGUE_TURN_STATUS,
  applyInteractionPolicyToAdmission, handleDialoguePolicy,
} from "./interaction-policy.mjs";
import {
  finalizeClaudeDialogueTurn, loadClaudeInteractionPolicy, reserveClaudeDialogueTurn, setClaudeInteractionMode,
} from "./interaction-policy-store.mjs";
import { controlAckText, parseControlCommand, runControlTransaction } from "./control-command.mjs";
import { claudeControlPrecondition } from "./control-identity.mjs";
import { senderRole } from "./sender-roles.mjs";
import { classifyRisk } from "./risk-class.mjs";
import { authorize } from "./authorize.mjs";
import { handOff, handOffReplyOnly, acquireSessionLock, releaseSessionLock, stampSessionLock } from "./handoff.mjs";
import {
  DELIVERY_REJECT, DELIVERY_REJECT_TEXT,
  deliverToLiveSession, findLiveSessionById, findLiveSessions, hasPriorSession,
  pinAndNote, readDeliveryPin, selectDeliverySession, stampInstruction,
} from "./live-session.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import {
  appendConsumed, buildClaudeSubscriptionProjection, evaluatePromotion, findBindingForSession,
  findPendingBinding, promoteBinding, shadowClaudeFirstClaim,
} from "./inbound-route.mjs";
import { closeClaudeTopicRotation } from "./topic-generation-store.mjs";
import { recordClaudeActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";
import {
  buildLegacyDialogueBoundAuthorizationContext,
} from "./dialogue-binding-authorization.mjs";
import {
  dialogueAuthorizationShadowEnabled, recordDialogueBoundAuthorizationShadow,
} from "./dialogue-authorization-shadow-store.mjs";
import { isDirectRun } from "./direct-run.mjs";
import { composeCrashReceipt } from "./crash-receipt.mjs";
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

const ROOT = moduleRoot(import.meta.url, "..");

// 运行期目录挂在**被路由到的那个项目**下。
//
// 路由之前（取不到信封、认不出话题）没有项目可挂，这批回执落到**机器级**目录，
// 而不是本仓库。原来落本仓库，装到 runtime 之后就是落进
// runtime/versions/<版本>/.runtime-data/ —— 两个后果都不能接受：
// 本该不可变的代码目录变成了状态目录；而且每装一个新版本，路由前的审计证据就
// 换一个地方，排查时得翻遍所有历史版本目录才能拼出完整时间线。
const rtOf = (root) => path.join(root, ".runtime-data", "inbound");
const UNROUTED_RT = path.join(os.homedir(), ".claude", "feishu-bridge", "inbound");
let RT = UNROUTED_RT;
let CLAIMS = path.join(RT, "delivery-claims");
let RECEIPTS = path.join(RT, "receipts");
let RUNS = path.join(RT, "runs");
let LOCK = path.join(RT, "session.lock");

function useProject(root) {
  RT = rtOf(root);
  CLAIMS = path.join(RT, "delivery-claims");
  RECEIPTS = path.join(RT, "receipts");
  RUNS = path.join(RT, "runs");
  LOCK = path.join(RT, "session.lock");
}

function writeReceipt(name, payload) {
  fs.mkdirSync(RECEIPTS, { recursive: true });
  const file = path.join(RECEIPTS, name + ".json");
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: "1.0",
    artifact_type: "claude_bridge_inbound_receipt",
    zone: "work",
    classification: "internal",
    recorded_at: new Date().toISOString(),
    ...payload,
  }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** 三种结局的回执文案。拒绝必须带原因 —— 静默丢弃是不可接受的失败模式。 */
function ackText(kind, detail) {
  if (kind === "accepted") {
    // 说清楚落到哪条线上：他在终端里看不看得到这条指令，取决于这个。
    const where = detail.mode === "live_session"
      ? "已送进你正开着的会话（" + detail.targetName + "）"
      : "已起一轮后台执行（沿用本项目最近的对话）";
    return [
      "已受理 · " + detail.taskName,
      where + "。完成后结果会自动发布到本话题。",
      "消息 " + detail.messageId.slice(-8) + " | claim " + detail.key.slice(0, 8),
    ].join("\n");
  }
  if (kind === "bound") {
    return [
      "绑定完成 · " + detail.taskName,
      "这个话题现在通向 " + detail.root + "。",
      "之后在这条消息下面 @ 一下就是给它下指令；它的进展和每一轮回答也会以卡片发回这里。",
    ].join("\n");
  }
  if (kind === "control") return detail.text;
  if (kind === "rejected") {
    const lines = ["已拒绝 · " + detail.reasonText];
    // 说清楚这个话题通向谁。同一个群里有多个项目话题之后，最容易犯的错是
    // 「@ 错了话题」—— 而单看「消息里没有指令正文」，人完全看不出自己站错了地方
    //（2026-08-20 实测：一条本该给 cc2cd 的空 @ 落在了 feishu-bridge-cc 的话题里，
    // 回执如实、正确、且毫无用处）。
    if (detail.taskName) lines.push("本话题通向：" + detail.taskName + "。");
    lines.push("本条指令没有被投递给任何任务。");
    return lines.join("\n");
  }
  return [
    "系统错误 · " + detail.detail,
    "本条指令没有被投递。请勿视为已受理。",
  ].join("\n");
}

function finish(kind, detail, result) {
  process.stdout.write(ackText(kind, detail) + "\n");
  process.stderr.write(JSON.stringify({ kind, ...result }) + "\n");
  process.exit(kind === "error" ? 1 : 0);
}

// ---------- 主流程 ----------

// 第 0 道闸：调用我的这个 agent，是不是配置里那个运输 agent。
//
// 入站技能装在 ~/.claude/skills/，本机每一个 Claude 会话都看得见它 —— 包括另外十几个
// aily agent。任何一个跑了这个脚本，它会去取**那个 agent 自己的**事件，然后拿本机的
// 绑定来判。挡住它的一直是 mention 那道闸（别的 agent 收到的消息 @ 的是它自己），
// 但那是巧合性的安全，不是设计出来的 —— open_id 按 app 隔离得很微妙，
// 把安全建在「碰巧不相等」上，迟早会碰上相等的那天。
//
// 这道闸必须在取信封**之前**，而且只能用**机器级模板**：项目配置要等路由之后才知道读哪份，
// 而路由要靠信封。用项目配置就成了循环。
const bootTpl = loadChainTemplate();
if (!bootTpl.ok) {
  writeReceipt("no-template-" + Date.now(), {
    status: "error", reason: "chain_template_unusable", template_reason: bootTpl.reason,
    missing: bootTpl.missing ?? null, malformed: bootTpl.malformed ?? null,
    claim_acquired: false, handed_off: false,
  });
  finish("error", {
    detail: "这台机器的链路模板不可用（" + bootTpl.reason + "）—— 先跑 init-chain-template.mjs",
  }, { reason: "chain_template_unusable" });
}

const callerAgent = process.env.AILY_CLI_CALLER_AGENT_UID;
if (callerAgent !== bootTpl.template.agent_uid) {
  writeReceipt("wrong-agent-" + Date.now(), {
    status: "rejected", reason: "caller_agent_mismatch",
    caller_agent_uid: callerAgent ?? null,
    expected_agent_uid: bootTpl.template.agent_uid,
    claim_acquired: false, handed_off: false,
  });
  finish("rejected", {
    reasonText: "调用方不是本链路的运输 agent（收到 " + (callerAgent ?? "空") + "）",
    taskName: null,
  }, { reason: "caller_agent_mismatch" });
}

const fetched = fetchTriggerEvent();
if (!fetched.ok) {
  writeReceipt("envelope-" + fetched.reason + "-" + Date.now(), {
    status: "error", reason: fetched.reason,
    claim_acquired: false, handed_off: false,
    // 诊断字段：没有它们，事后只能看到一个原因字符串，查不出当时查的是哪个 run、
    // 重试了几次、看到了几个 envelope。这三次真实失败就是这么难查的。
    attempts: fetched.attempts ?? 1,
    session_id: fetched.session_id ?? null,
    run_id: fetched.run_id ?? null,
    envelopes_seen: fetched.envelopes_seen ?? null,
    detail: fetched.detail ?? null,
  });
  finish("error", { detail: "取不到本次消息信封（" + fetched.reason + "）" }, { reason: fetched.reason });
}
const event = fetched.event;
const dryRun = process.argv.includes("--dry-run");

// ---------- 路由：这条消息属于哪个项目 ----------
//
// 顺序不能反：先有 session_id 才知道读谁的配置。取信封只依赖 daemon 注入的环境变量，
// 不读任何项目配置，所以这里没有死结。

let routed = findBindingForSession({ sessionId: event.session_id });
let justBound = false;
let pendingMatchedBy = null;
let subscriptionClaimShadow = null;

if (!routed.ok) {
  // 没有已绑定的话题对得上 —— 可能是「新话题的第一条 @」，也可能是条不该理的消息。
  // 绑定必然分两段：建话题时 Aily session 还不存在（它是第一条消息流进来才产生的）。
  const tpl = loadChainTemplate();
  const template = tpl.ok ? tpl.template : null;
  // 把正文传进去：绑定码就藏在飞书自动附加的引用块里，Frank 不用打任何东西。
  const promotionNow = Date.now();
  const pending = findPendingBinding({ content: event.content, now: promotionNow });
  const promo = evaluatePromotion({ event, template, pending, now: promotionNow });
  if (!pending.ok && pending.reason === "pending_binding_expired" && pending.operationId) {
    closeClaudeTopicRotation({
      root: pending.root,
      claudeSessionId: pending.claudeSessionId,
      operationId: pending.operationId,
      reason: "expired",
      now: promotionNow,
    });
  }
  subscriptionClaimShadow = shadowClaudeFirstClaim({
    event,
    template,
    callerAgentUid: callerAgent,
    legacyPending: pending,
    legacyPromotion: promo,
    now: promotionNow,
  });

  if (!promo.ok) {
    writeReceipt("unrouted-" + (event.message_id ?? "unknown") + "-" + Date.now(), {
      status: "rejected", reason: promo.reason, reason_text: promo.reasonText,
      message_id: event.message_id ?? null, session_id: event.session_id ?? null,
      claim_acquired: false, handed_off: false,
      subscription_claim_shadow: subscriptionClaimShadow,
    });
    if (dryRun) {
      process.stdout.write("[dry-run] reject · " + promo.reasonText + "\n");
      process.stderr.write(JSON.stringify({ dryRun: true, ...promo }) + "\n");
      process.exit(0);
    }
    finish("rejected", { reasonText: promo.reasonText, taskName: null }, { reason: promo.reason });
  }

  if (dryRun) {
    process.stdout.write("[dry-run] 会把这个话题绑给 " + promo.id +
      "（依据：" + (pending.matchedBy === "quoted_binding_token" ? "根消息引用里的绑定码" : "全机唯一一份待绑定") + "，没有真的写）\n");
    process.stderr.write(JSON.stringify({ dryRun: true, wouldBind: promo.root }) + "\n");
    process.exit(0);
  }

  const wrote = promoteBinding({
    root: promo.root,
    id: promo.id,
    source: promo.source,
    generationId: promo.generationId,
    operationId: pending.operationId,
    sessionId: event.session_id,
  });
  if (!wrote.ok) {
    writeReceipt("bind-failed-" + event.message_id, {
      status: "error", reason: wrote.reason, message_id: event.message_id,
      claim_acquired: false, handed_off: false,
      subscription_claim_shadow: subscriptionClaimShadow,
    });
    finish("error", { detail: "绑定没写成（" + wrote.reason + "）" }, { reason: wrote.reason });
  }

  justBound = true;
  pendingMatchedBy = pending.matchedBy ?? null;
  routed = findBindingForSession({ sessionId: event.session_id });
  if (!routed.ok) {
    // 刚写完就读不回来，说明登记表被并发改了。不猜，如实报。
    finish("error", { detail: "绑定写完却读不回来（" + routed.reason + "）" }, { reason: routed.reason });
  }
}

// 从这里开始，所有运行期路径都挂在被路由到的那个项目下。
useProject(routed.root);

const config = routed.config;
const mapping = routed.mapping;

if (!config) {
  writeReceipt("noconfig-" + (event.message_id ?? "unknown") + "-" + Date.now(), {
    status: "error", reason: "config_unusable", message_id: event.message_id ?? null,
    claim_acquired: false, handed_off: false,
  });
  finish("error", { detail: "这个项目的链路配置不可用，没法投递" }, { reason: "config_unusable" });
}

const verdict = evaluateMappingAdmission({
  canonicalEvent: fetched.canonical_event,
  event,
  mapping,
  config,
  now: Date.now(),
});
// Slice B1：只读旁路。它使用与 legacy 精确路由相同的 binding，写独立 Git 外 sidecar；
// 任意投影/校验/I/O 失败都不得改变本轮 verdict、claim 或 dispatch。
if (!dryRun && dialogueAuthorizationShadowEnabled()) {
  try {
    const context = buildLegacyDialogueBoundAuthorizationContext({
      runtimeNamespace: "claude",
      model: buildClaudeSubscriptionProjection(),
      legacyKey: routed.id,
      privateBindingKey: effectiveBindingId(mapping, { root: routed.root }),
      bindingStatus: mapping.status,
      verdict,
    });
    if (context.ok) {
      recordDialogueBoundAuthorizationShadow({
        shadowDir: path.join(RT, "dialogue-planner-shadow"),
        authorizationInput: context.authorizationInput,
        canonicalEvent: fetched.canonical_event,
        runtimeNamespace: "claude",
        expectedBindingRef: context.expectedBindingRef,
        legacy: context.legacy,
      });
    }
  } catch { /* shadow 永不承重 */ }
}
const interaction = loadClaudeInteractionPolicy({
  root: routed.root,
  claudeSessionId: routed.mapping?.claude_session_id ?? null,
});
if (!interaction.ok) {
  writeReceipt("policy-state-" + (event.message_id ?? "unknown") + "-" + Date.now(), {
    status: "error", reason: interaction.reason, message_id: event.message_id ?? null,
    claim_acquired: false, handed_off: false,
  });
  finish("error", { detail: "交互策略状态不可用（" + interaction.reason + "）" },
    { reason: interaction.reason });
}
const policyEvaluation = applyInteractionPolicyToAdmission(verdict, interaction.state);
const dialogueMode = policyEvaluation.policy_id === DIALOGUE_POLICY_ID;
let authz = null;
// runRequest 带执行边界：authorize 放行时给的 capability（owner full / 其他 reply_only）。这里 authz 还没算出来，所以用惰性读取。
const handlePolicy = (args = {}) => dialogueMode
  ? handleDialoguePolicy({ evaluation: policyEvaluation, capability: authz?.capability ?? null, ...args })
  : handleMappingPolicy({ evaluation: policyEvaluation, capability: authz?.capability ?? null, ...args });

// 光秃秃一个 @（没有正文）是完成绑定的正常方式 —— 那一下的目的就是让 Aily 产生
// session，好把它写进绑定。这时候回「消息里没有指令正文」是句没用的实话：
// 它描述了现象，却把一次成功说成了失败。
if (justBound && verdict.decision === "reject" && verdict.reason === REJECT.EMPTY_INSTRUCTION) {
  appendConsumed(routed.root, event.message_id, {
    claudeSessionId: routed.mapping?.claude_session_id ?? null,
  });
  writeReceipt("bound-" + event.message_id, {
    status: "bound", message_id: event.message_id, session_id: event.session_id,
    root: routed.root, binding_id: effectiveBindingId(mapping),
    matched_by: pendingMatchedBy,
    claim_acquired: false, handed_off: false,
    subscription_claim_shadow: subscriptionClaimShadow,
    // 为将来的确定性匹配攒证据：根消息里那个绑定码有没有随引用块回来。
    // 现在没有代码依赖它，纯粹是想知道那条路走不走得通。
    pending_token_seen: typeof mapping.pending_token === "string" && mapping.pending_token.length > 0
      ? String(event.content ?? "").includes(mapping.pending_token) : null,
  });
  finish("bound", { taskName: config.task_display_name, root: routed.root },
    { bound: true, root: routed.root });
}

// --dry-run：只跑校验，不 claim、不投递、不写 mapping。用于诊断和联调，
// 免得一次排查就把真实指令送进长期任务。
if (dryRun) {
  process.stdout.write("[dry-run] " + verdict.decision +
    (verdict.reason ? " · " + verdict.reasonText : " · " + String(verdict.instruction).slice(0, 60)) + "\n");
  process.stderr.write(JSON.stringify({ dryRun: true, ...verdict }) + "\n");
  process.exit(0);
}

if (verdict.decision === "reject") {
  const policyOutcome = handlePolicy();
  writeReceipt("reject-" + (event?.message_id ?? "unknown") + "-" + Date.now(), {
    status: "rejected",
    reason: verdict.reason,
    reason_text: verdict.reasonText,
    message_id: event?.message_id ?? null,
    project_root: routed.root,
    binding_source: routed.source,
    claim_acquired: false,
    handed_off: false,
    policy_id: policyOutcome.policy_id,
    policy_version: policyOutcome.policy_version,
    policy_disposition: policyOutcome.disposition,
    ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
    ...(subscriptionClaimShadow ? { subscription_claim_shadow: subscriptionClaimShadow } : {}),
  });
  finish("rejected", { ...verdict, taskName: config.task_display_name },
    { reason: verdict.reason, project_root: routed.root });
}

const mappingContext = buildLegacyMappingContext({
  runtime: "claude",
  mapping,
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

// 控制命令（/feishu-mode dialogue|mapping）：三道闸之后先**解析意图但不执行**，意图随 claim 持久化；
// 执行与终态在拿到 claim 之后做，重放时按 claim 里的意图续做或按结果重出回执（可恢复事务，goal 第 3 层）。
const control = parseControlCommand(verdict.instruction, { chain: "claude" });

// ---------- 唯一一处授权判定（角色 × 风险等级 × 模式）：三道闸之后、拿 claim 之前 ----------
// 拒绝必须说清"哪个模式、哪个角色、缺什么权限"，不投递、不静默；不取 claim（重发不算重放）。
const senderRoleValue = senderRole({ frank_sender_id: mapping.frank_sender_id, senders: config?.senders }, event.sender_id);
const risk = classifyRisk({ instruction: verdict.instruction, chain: "claude", mode: policyEvaluation.policy_id, control });
authz = authorize({ role: senderRoleValue, riskClass: risk.riskClass, mode: policyEvaluation.policy_id, chain: "claude" });
if (!authz.allow) {
  writeReceipt("authz-" + verdict.messageId, {
    status: "rejected", reason: "not_authorized", authz_reason: authz.reason, role: senderRoleValue, risk_class: risk.riskClass, risk_kind: risk.kind,
    policy_id: policyEvaluation.policy_id, required_roles: authz.required, message_id: verdict.messageId, project_root: routed.root, binding_source: routed.source, claim_acquired: false, handed_off: false,
  });
  finish("rejected", { reasonText: authz.text, taskName: config.task_display_name }, { reason: "not_authorized", authz_reason: authz.reason, risk_class: risk.riskClass });
}
// 控制事务用的身份期望 —— 与 claim 里写的身份字段同一算法；换绑 / 换线程之后同 key 的旧 claim 对不上，就不替它执行、不重出回执。
const claimExpect = { logicalTaskKey: verdict.logicalTaskKey, bindingId: effectiveBindingId(mapping), claudeSessionId: mapping.claude_session_id ?? null };
const runControl = (replay) => {
  const tx = runControlTransaction({
    claimsDir: CLAIMS, key: claim.key, intent: control ? { control: control.kind, mode: control.mode } : undefined, replay, expect: claimExpect,
    // 策略存储层写锁内再核一次身份（与维护入口同一份判据）：事务核验与策略写入之间换了绑定，旧命令不许改新对象。
    execute: (mode) => setClaudeInteractionMode({ root: routed.root, claudeSessionId: mapping.claude_session_id ?? null, mode,
      precondition: claudeControlPrecondition({ claimsDir: CLAIMS, key: claim.key, root: routed.root }) }),
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
  writeReceipt("control-" + verdict.messageId, { status: "consumed", ...receiptBase, changed: tx.changed, replayed: tx.replayed, resumed: tx.resumed, project_root: routed.root, claim_acquired: !replay });
  finish("control", { text: controlAckText({ taskName: config.task_display_name, mode: control.mode, changed: tx.changed, replayed: tx.replayed, resumed: tx.resumed, lockUncleared: tx.lockUncleared ?? null }) },
    { control: control.kind, mode: control.mode, changed: tx.changed, replayed: tx.replayed, resumed: tx.resumed });
};

// 校验通过才允许 claim。claim 是幂等的唯一保证。
const claim = acquireClaim({
  claimsDir: CLAIMS,
  messageId: verdict.messageId,
  logicalTaskKey: verdict.logicalTaskKey,
  meta: {
    ...(control ? { control: { control: control.kind, mode: control.mode } } : {}),
    session_id: event.session_id,
    binding_id: effectiveBindingId(mapping),
    policy_id: policyEvaluation.policy_id,
    policy_version: policyEvaluation.policy_version,
    local_target_id: mappingContext.localTargetId,
    origin_channel_generation_id: mappingContext.originChannelGenerationId,
    claude_session_id: mapping.claude_session_id ?? null,
    mapping_admission_shadow_match: verdict.admission_shadow?.match ?? null,
  },
});

if (!claim.ok && claim.reason === "duplicate" && control) {
  // 控制命令重放：按原 claim 里的意图恢复（意图一致才续做；不一致说明是另一条不同正文的命令撞了同一消息 id，拒）。
  const original = readClaimState({ claimsDir: CLAIMS, key: claim.key, expect: claimExpect });
  const intent = original.status === "valid" ? original.claim.control : undefined;
  if (intent && intent.control === control.kind && intent.mode === control.mode) {
    claim.key = claim.key ?? claimKey(verdict.messageId, verdict.logicalTaskKey);
    runControl(true);
  }
}

if (!claim.ok) {
  const isDup = claim.reason === "duplicate";
  const policyOutcome = handlePolicy({ claim, resolvedContext: mappingContext });
  writeReceipt("claim-" + claim.reason + "-" + verdict.messageId, {
    status: isDup ? "rejected" : "error",
    reason: claim.reason,
    message_id: verdict.messageId,
    claim_acquired: false,
    handed_off: false,
    policy_id: policyOutcome.policy_id,
    policy_version: policyOutcome.policy_version,
    policy_disposition: policyOutcome.disposition,
    ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
  });
  if (isDup) {
    finish("rejected", { reasonText: "这条消息已经处理过（幂等命中）" }, { reason: "duplicate" });
  }
  finish("error", { detail: "无法取得投递权：" + claim.error }, { reason: claim.reason });
}

// ---------- 控制命令：拿到 claim 之后当场执行（可恢复事务），不投递 ----------
if (control) runControl(false);

let policyRun = dialogueMode ? null : handlePolicy({ claim, resolvedContext: mappingContext });
if (!dialogueMode &&
    (policyRun.disposition !== MAPPING_DISPOSITION.ACCEPTED || !policyRun.runRequest)) {
  recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed",
    detail: { reason: policyRun.reason ?? "mapping_policy_rejected" } });
  finish("error", { detail: "映射策略没有生成可执行请求" },
    { reason: policyRun.reason ?? "mapping_policy_rejected" });
}

// 路由：现场有人就投给现场，没人才自己起一轮。
//
// 这两条分支必须互斥。都走 --continue 的话会有两个进程写同一份 transcript ——
// 现在没撞上纯粹是因为旧设计钉的是另一份记录，那是运气不是设计。
// 会话级绑定要投给**它绑的那条线**；项目级绑定原来沿用「现场最近开的那个」。
const boundSession = routed.mapping?.claude_session_id ?? null;
// 那是猜，而它在实机上猜错过：同一个项目开着两条会话，Frank 在先开的那条工作，
// 指令被投给了后开的那条 —— 他看着自己发出去的指令消失在另一个窗口里。
// 现在只有一条会话时才投，多条就拒。理由跟下面那段「不回落到项目行为」一样：
// **投错会话比投不进去更糟** —— 投不进去当场就知道，投错了要等到「它怎么没反应」才知道。
let ambiguousDelivery = null;
let target = null;
if (boundSession) {
  target = findLiveSessionById({ projectRoot: config.project_dir, claudeSessionId: boundSession });
} else {
  const picked = selectDeliverySession({
    pinned: readDeliveryPin(config.project_dir),
    live: findLiveSessions({ projectRoot: config.project_dir }),
  });
  if (picked.ok) {
    target = picked.session;
    // 现场只有一条时顺手钉下来 —— 那一刻没有歧义，钉了下次才不用碰运气。
    // 上一版**声明了这件事却没做**：生产路径固定传 pinned:null，也从不读 picked.pin，
    // 于是"已钉会话"那条分支只活在单测里。
    if (picked.pin) {
      // 写不成不影响这一条的投递（目标已经选定了），但**不能假装钉住了** ——
      // 下一条消息会因为"没钉过"重新走歧义判断，而日志里若无痕迹就查不出为什么。
      // 钉住 + 留痕都是 best-effort：目标已经选定，这两步失败都不该影响这一条的交付。
      pinAndNote({
        root: config.project_dir, sessionId: picked.pin,
        noteFile: path.join(CLAIMS, claim.key + ".notes.log"),
      });
    }
  } else if (picked.reason === DELIVERY_REJECT.AMBIGUOUS) {
    ambiguousDelivery = picked;
  }
}

if (ambiguousDelivery) {
  recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed",
    detail: { reason: DELIVERY_REJECT.AMBIGUOUS, candidates: ambiguousDelivery.candidates } });
  writeReceipt("ambiguous-" + verdict.messageId, {
    status: "rejected", reason: DELIVERY_REJECT.AMBIGUOUS,
    message_id: verdict.messageId, claim_acquired: true, handed_off: false,
  });
  finish("rejected", {
    reasonText: DELIVERY_REJECT_TEXT[DELIVERY_REJECT.AMBIGUOUS],
    taskName: config.task_display_name,
  }, { reason: DELIVERY_REJECT.AMBIGUOUS });
}

const reserveDialogue = (runtimeTargetId, { beforeReject = null } = {}) => {
  const reservation = reserveClaudeDialogueTurn({
    root: routed.root,
    claudeSessionId: boundSession,
    eventId: verdict.messageId,
    runId: claim.key,
    localTargetId: mappingContext.localTargetId,
    originChannelGenerationId: mappingContext.originChannelGenerationId,
    runtimeTargetId,
  });
  if (!reservation.ok) {
    if (typeof beforeReject === "function") beforeReject();
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed",
      detail: { reason: reservation.reason } });
    const busy = reservation.reason === DIALOGUE_REASON.TURN_ACTIVE;
    finish(busy ? "error" : "rejected", {
      detail: busy ? "Dialogue 当前仍有活动回合，请等待它完成" : undefined,
      reasonText: busy ? undefined : "Dialogue 无法开始新回合（" + reservation.reason + "）",
      taskName: config.task_display_name,
    }, { reason: reservation.reason });
  }
  const outcome = handlePolicy({ claim, resolvedContext: mappingContext, reservation });
  if (outcome.disposition !== "accepted" || !outcome.runRequest) {
    if (typeof beforeReject === "function") beforeReject();
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed",
      detail: { reason: outcome.reason ?? "dialogue_policy_rejected" } });
    finish("rejected", {
      reasonText: "Dialogue 已达到停止条件（" + (outcome.reason ?? "unknown") + "）",
      taskName: config.task_display_name,
    }, { reason: outcome.reason ?? "dialogue_policy_rejected" });
  }
  return outcome;
};

let run;

// 执行边界：reply_only 永远不进现场会话、不续起任何会话；capability 说不清（缺席）按 fail-closed 拒，不折叠成 full。
const capability = authz.capability;
if (capability !== "full" && capability !== "reply_only") {
  recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: "capability_unknown" } });
  writeReceipt("capability-" + verdict.messageId, { status: "error", reason: "capability_unknown", message_id: verdict.messageId, claim_acquired: true, handed_off: false });
  finish("error", { detail: "这条消息的执行边界说不清，没有投递" }, { reason: "capability_unknown" });
}
const replyOnly = capability === "reply_only";

if (target && !replyOnly) {
  // 现场路径不需要会话锁：消息进的是一个活着的会话，它自己会把先后顺序排好。
  // 也不需要守望者 —— 那个会话结束时它自己的 Stop 钩子会把进展发出去。
  try {
    if (dialogueMode) policyRun = reserveDialogue(target.sessionId);
    run = deliverToLiveSession({
      target,
      instruction: dialogueMode
        ? "[Dialogue · " + policyRun.runRequest.policy.dialogue_id + " · turn " +
          policyRun.runRequest.policy.turn_index + "]\n" + policyRun.runRequest.userInput
        : policyRun.runRequest.userInput,
      messageId: verdict.messageId,
      createdAtMs: event.created_at_ms,
      projectRoot: config.project_dir,
      runsDir: RUNS,
      key: policyRun.runRequest.runId,
    });
  } catch (err) {
    if (dialogueMode) {
      finalizeClaudeDialogueTurn({
        root: routed.root, claudeSessionId: boundSession, runId: claim.key,
        status: DIALOGUE_TURN_STATUS.FAILED, reason: "forward_failed",
      });
    }
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { error: err.message } });
    writeReceipt("forward-failed-" + verdict.messageId, {
      status: "error", reason: "forward_failed", message_id: verdict.messageId,
      claim_acquired: true, handed_off: false,
    });
    finish("error", { detail: "投递给现场会话失败：" + err.message }, { reason: "forward_failed" });
  }
} else {
  // 没有可续的对话就明确拒绝，不假装受理。
  // 这不该在运行时兜底 —— 「起这个长期任务」本来就是建绑定的一个步骤，
  // 跟建话题、写 mapping、装钩子并列。缺了就该退回去补，而不是让代码猜。
  // 会话级绑定的会话已经关了：**不回落到项目行为**。
  // 回落会把指令投进一条 Frank 没指定的线 —— 那正是当年那个失败方案的形态。
  // 先试 --resume 精确续起原会话（Claude 的 resume 是精确的，不像 --continue 靠猜）；
  // 连记录都没有才如实拒绝。
  if (!replyOnly && boundSession && !hasPriorSession({ projectRoot: config.project_dir })) {
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: "bound_session_gone" } });
    writeReceipt("bound-session-gone-" + verdict.messageId, {
      status: "error", reason: "bound_session_gone", message_id: verdict.messageId,
      bound_claude_session_id: boundSession,
      claim_acquired: true, handed_off: false,
    });
    finish("error", {
      detail: "这个话题绑的那个会话已经关了，本机也没有可续的记录。去项目里重开一个会话，或改绑",
    }, { reason: "bound_session_gone" });
  }

  // 只回复不续任何会话，所以不要求项目里有过会话
  if (!replyOnly && !hasPriorSession({ projectRoot: config.project_dir })) {
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: "no_prior_session" } });
    writeReceipt("no-session-" + verdict.messageId, {
      status: "error", reason: "no_prior_session", message_id: verdict.messageId,
      claim_acquired: true, handed_off: false,
    });
    finish("error", {
      detail: "这个项目还没有长期任务会话，--continue 无从续起。先在项目目录起一个会话再发指令",
    }, { reason: "no_prior_session" });
  }

  // 同一目录不能并发 --continue，否则两轮会互相踩。用目录锁串行化。
  // 只回复的 run 不碰任何会话文件，所以不取这把锁：participant 的对话不该把 owner 的 run 挡住，也不该被挡。
  const lock = replyOnly ? { ok: true, skipped: true } : acquireSessionLock(LOCK);
  if (!lock.ok) {
    const busyOutcome = handlePolicy({ claim, resolvedContext: mappingContext, targetState: "busy" });
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: lock.reason } });
    writeReceipt("busy-" + verdict.messageId, {
      status: "error", reason: lock.reason, message_id: verdict.messageId,
      claim_acquired: true, handed_off: false,
      policy_id: busyOutcome.policy_id,
      policy_version: busyOutcome.policy_version,
      policy_disposition: busyOutcome.disposition,
      ...(verdict.admission_shadow ? { mapping_admission_shadow: verdict.admission_shadow } : {}),
    });
    finish("error", { detail: "长期任务正忙，上一条指令还没跑完" }, { reason: lock.reason });
  }

  try {
    if (dialogueMode) {
      policyRun = reserveDialogue(boundSession ?? null, {
        beforeReject: () => { if (!replyOnly) releaseSessionLock(LOCK); },
      });
    }
    const stamped = stampInstruction({
      instruction: dialogueMode
        ? "[Dialogue · " + policyRun.runRequest.policy.dialogue_id + " · turn " +
          policyRun.runRequest.policy.turn_index + "]\n" + policyRun.runRequest.userInput
        : policyRun.runRequest.userInput,
      messageId: verdict.messageId,
      createdAtMs: event.created_at_ms,
    });
    // 投递层只看 runRequest 里的 capability，不重新判角色
    if (policyRun.runRequest.capability !== capability) throw new Error("runRequest 的执行边界与授权结果不一致");
    run = replyOnly
      ? handOffReplyOnly({ projectDir: config.project_dir, instruction: stamped, runsDir: RUNS, key: policyRun.runRequest.runId })
      : handOff({ projectDir: config.project_dir, resumeSessionId: boundSession ?? undefined, instruction: stamped, runsDir: RUNS, key: policyRun.runRequest.runId });
  } catch (err) {
    if (!replyOnly) releaseSessionLock(LOCK);
    if (dialogueMode) {
      finalizeClaudeDialogueTurn({
        root: routed.root, claudeSessionId: boundSession, runId: claim.key,
        status: DIALOGUE_TURN_STATUS.FAILED, reason: "handoff_failed",
      });
    }
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { error: err.message } });
    writeReceipt("handoff-failed-" + verdict.messageId, {
      status: "error", reason: "handoff_failed", message_id: verdict.messageId,
      claim_acquired: true, handed_off: false,
    });
    finish("error", { detail: "投递失败：" + err.message }, { reason: "handoff_failed" });
  }

  // 把 run 信息盖进锁：锁要活到 run 结束，靠这份信息做陈旧回收。
  if (!replyOnly) stampSessionLock(LOCK, { pid: run.pid, logPath: run.logPath });

  // 起一次性守望者：run 跑完就发布结果并放锁。
  if (dialogueMode || config.auto_publish_on_completion !== false) {
    // 守望者脚本住在本仓库，但它要盯的是**被路由到的那个项目** —— 根目录得传给它。
    const w = spawn(process.execPath,
      [path.join(ROOT, "scripts", "watch-and-publish.mjs"), claim.key, routed.root], {
      cwd: ROOT, detached: true,
      // 期望身份由这里（接受这条消息的一方）独立给守望者，不让它只信 claim 自报。
      env: { ...process.env, ...watcherExpectEnv(mapping) },
      stdio: ["ignore",
        fs.openSync(path.join(RUNS, claim.key + ".watch.log"), "a"),
        fs.openSync(path.join(RUNS, claim.key + ".watch.log"), "a")],
    });
    w.unref();
  }
}

// 投递成功。注意 handed_off ≠ 完成，出站流程稍后独立判定完成。
recordClaimState({
  claimsDir: CLAIMS, key: claim.key, state: "handed_off",
  detail: { pid: run.pid, log_path: run.logPath, started_at: run.startedAt },
});

// 幂等列表独立放 sidecar。不能再拿路由时读到的旧 mapping 整份覆盖回去：Dialogue 回合预留
// 和 Topic Generation 可能刚原子更新了同一 binding，旧快照回写会把新状态悄悄抹掉。
appendConsumed(routed.root, verdict.messageId, {
  claudeSessionId: routed.mapping?.claude_session_id ?? null,
  seed: mapping.consumed_message_ids ?? [],
});

// 只有通过全部入站闸门并已经 handoff 的真实人类指令才计入当前话题代际。
// 计数/自动轮转失败不回滚已成功投递的业务指令；结果会留在 accepted receipt 里供诊断。
const topicActivity = recordClaudeActivityAndMaybeRotate({
  root: routed.root,
  claudeSessionId: routed.mapping?.claude_session_id ?? null,
  generationId: policyRun.runRequest.origin.channelGenerationId,
  eventKey: "inbound:claude:" + verdict.messageId,
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
  // 多绑定之后「这条进了哪个项目」是排查的第一个问题。
  project_root: routed.root, binding_source: routed.source,
  binding_level: boundSession ? "session" : "project",
  bound_claude_session_id: boundSession,
  claim_acquired: true, handed_off: true, completion_observed: false,
  completion_owner: "outbound_publisher",
  run_log: run.logPath, pid: run.pid,
  // 成功路径也记重试次数。事件存储的读延迟只在真实消息上暴露 —— 手机发的比电脑发的
  // 慢（2026-08-19 实测：修复前手机 0/2、Mac 1/1），而重试预算只有 4 次。
  // 不在每条成功回执上记下用了几次，就永远不知道余量还剩多少，
  // 只能等它再次不够用、再从零查一遍。
  envelope_attempts: fetched.attempts ?? 1,
  // 落到哪条线上必须留痕：两条路径的结果发布者不同（现场靠它自己的 Stop 钩子，
  // --continue 靠一次性守望者），出问题时第一件事就是问「这条走的哪边」。
  delivery_mode: run.mode,
  target_session_id: run.targetSessionId ?? null,
  target_session_name: run.targetName ?? null,
  topic_activity: topicActivity.ok ? {
    counted: topicActivity.counted === true,
    message_count: topicActivity.messageCount ?? null,
    auto_rotation_requested: topicActivity.shouldAutoRotate === true,
    auto_rotation_launched: topicActivity.rotationLaunch?.ok ?? null,
  } : { counted: false, reason: topicActivity.reason },
  ...(subscriptionClaimShadow ? { subscription_claim_shadow: subscriptionClaimShadow } : {}),
});

finish("accepted", {
  taskName: config.task_display_name, messageId: verdict.messageId, key: claim.key,
  mode: run.mode, targetName: run.targetName,
}, { claim_key: claim.key, run_log: run.logPath, delivery_mode: run.mode });
}

if (isDirectRun(import.meta.url)) {
  // 用 catch 收口而不是顶层 await —— 后者会让 import 也等它跑完。
  main().catch((err) => {
    /**
     * **stderr 只出脱敏信息。**
     *
     * Aily 会把进程输出带回模型可见通道，所以这里写什么等于对外发布什么。
     * 上一版直接写 err.stack —— 那会把本机绝对路径和内部调用栈一起送出去，
     * 而这个仓库为脱敏边界已经付过多次代价（Codex 用受控 ENOTDIR 探针实测复现）。
     *
     * 诊断细节不能丢，只是不能走这条通道：完整堆栈写进机器级日志文件，
     * 那个文件只有本机能读。
     */
    const receipt = composeCrashReceipt({
      error: err,
      logFile: path.join(os.homedir(), ".claude", "feishu-bridge", "inbound-crash.log"),
    });
    process.stdout.write(receipt.text);
    process.exit(1);
  });
}
