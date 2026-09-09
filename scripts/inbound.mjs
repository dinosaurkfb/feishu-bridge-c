#!/usr/bin/env node
/**
 * 入站主流程 —— M5Claude 唯一被允许调用的入口。
 *
 * 不接受任何入参：事件字段一律由脚本自己向 Aily 取（见 envelope.mjs），
 * 模型不参与构造。输出一段给 Frank 的回执文本（stdout）和一份机器可读结果（stderr）。
 *
 * 时间契约：已绑定路径必须秒级返回，**不等待**长期任务完成 —— 完成由出站流程负责。唯一例外是 chat 默认态（无绑定上下文）：
 * 没有话题可回投，只能在本进程里同步答完再返回，预算 60 秒（contract §14c）。
 *
 * 顺序不可调换：先校验、再 claim、再投递。任何一步失败都不进入下一步。
 */

import { spawn } from "node:child_process";
import { displaySafe } from "./display-safe.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeBody } from "./selector.mjs";
import { fetchTriggerEvent } from "./envelope.mjs";
import { acquireClaim, claimKey, readClaimState, recordClaimState, watcherExpectEnv } from "./claim.mjs";
// 失败回执的 outbox 落点与 Stop 钡 / 兑底定时器同一份判据（outbox vs outbox-<sid>），不另写一份
import { outboxDirOf } from "./drain-outbox.mjs";
import { effectiveBindingId, pendingGeneration } from "./topic-generation.mjs";
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
import { controlAckText, runControlTransaction } from "./control-command.mjs";
import { claudeControlPrecondition } from "./control-identity.mjs";
import { senderRole } from "./sender-roles.mjs";
import { classifyRisk } from "./risk-class.mjs";
import { INTENT, parseInboundIntent, controlRejectText, rejectedControlProjection } from "./inbound-intent.mjs";
import { runRejectTransaction } from "./reject-control.mjs";
import { sameControlIntent, sameRejectedControl } from "./control-intent.mjs";
import { authorize, CAPABILITY } from "./authorize.mjs";
import { handOff, handOffReplyOnly, acquireSessionLock, releaseSessionLock, stampSessionLock } from "./handoff.mjs";
import {
  DELIVERY_REJECT, DELIVERY_REJECT_TEXT,
  deliverToLiveSession, findLiveSessionById, findLiveSessions, hasPriorSession,
  pinAndNote, readDeliveryPin, selectDeliverySession, stampInstruction,
} from "./live-session.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { appendChannelSample, channelDisposition } from "./channel-samples.mjs";
import {
  appendConsumed, buildClaudeSubscriptionProjection, evaluatePromotion, findBindingForSession,
  findPendingBinding, promoteBinding, pendingGenerationIdentity, shadowClaudeFirstClaim, evaluateChatGates, CHAT_FALLBACK_REASONS,
  isPrivateChatTurn,
} from "./inbound-route.mjs";
import { CHAT_POLICY_ID, CHAT_FOOTER, CHAT_BIND_GUIDE, chatReply, chatReplyTimeoutMs, chatFailText } from "./chat-reply.mjs";
import { chatKey, senderRef, inspectChat, admitChat, recordChatOutcome, lockUnclearedText } from "./chat-ledger.mjs";
import { closeClaudeTopicRotation, loadClaudeTopicBinding } from "./topic-generation-store.mjs";
import { recordClaudeActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";
import { wireChatA1, wirePromoteBinding, wireVoid, uncleanWired } from "./m1a/wiring.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import {
  buildLegacyDialogueBoundAuthorizationContext,
} from "./dialogue-binding-authorization.mjs";
import {
  dialogueAuthorizationShadowEnabled, recordDialogueBoundAuthorizationShadow,
} from "./dialogue-authorization-shadow-store.mjs";
import { isDirectRun } from "./direct-run.mjs";
import { composeCrashReceipt } from "./crash-receipt.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import { selectAdmission, selectRejectTextByReason, selectReaffirmSuccessText, executeSelectControl, selectionContextDigestV1, mintSelectCapability } from "./select-admission.mjs";
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
/**
 * R57d 返修三 P1-1：owner_select 的 legacy 提交回调（Claude 链，$feishu-select shadow 期复合双写的 legacy 半笔）。
 *   activate → 复用 promoteBinding（W1）；rebind → 存在与所选 B3 精确绑定的 W2 新代际 pending
 *   （同项目 pending 代际在场 ∧ 其 active 代际 root_om === B3 的 root——B3 正是当前绑定的活跃代际，
 *   新代际认领构成 W2 换绑继承）时复用 promoteBinding 激活新代际到事件会话；不存在 → 结构化拒
 *   select_rebind_legacy_unsupported（不得把任意 orh_ 冒充 W2）。
 */
export function selectClaudeLegacyUpdate(u, { now = Date.now() } = {}) {
  if (!u || typeof u !== "object" || (u.action !== "activate" && u.action !== "rebind")) {
    return { ok: false, reason: "select_rebind_legacy_unsupported", why: "未知 action（" + String(u?.action) + "）" };
  }
  const idy = pendingGenerationIdentity({ root: u.projectRoot, now });
  if (!idy.ok) {
    return u.action === "activate" ? idy
      : { ok: false, reason: "select_rebind_legacy_unsupported", why: "所选 B3 的项目没有 pending 新代际（无 W2 继承），shadow 期换绑拒" };
  }
  if (u.action === "rebind" && (idy.activeRootOm ?? null) !== (u.rootOm ?? null)) {
    return { ok: false, reason: "select_rebind_legacy_unsupported", why: "active 代际 root（" + (idy.activeRootOm ?? "null") + "）与所选 B3 root（" + (u.rootOm ?? "null") + "）不符——不是这个 B3 的 W2 继承" };
  }
  const generationId = u.action === "activate" ? u.lineageId : idy.generationId;
  return promoteBinding({ root: u.projectRoot, generationId, operationId: idy.operationId, sessionId: u.eventSessionId, now });
}

export async function main({ selectAdmissionFn = selectAdmission } = {}) {

// 维护门（issue #81）：确定性回"维护中"，不 claim、不写回执、不重放（stdout 就是给运输 agent 的回复）
{ const gate = gateBlocks(); if (gate.blocked) exitForGate("inbound", gate); }

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
// 采样旁路文件：机器级 inbound 目录（UNROUTED_RT），主链路换项目（useProject）也不换地方。
const CHANNEL_SAMPLES_FILE = path.join(UNROUTED_RT, "channel-samples.jsonl");

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
    // 说清楚落到哪条线上：他在终端里看不看得到这条指令，取决于这个。四种投递方式封闭渲染，说不清的不许冒充其中一种。
    const where = {
      // issue #140：转发是 fire-and-forget（spawn 即返回），结果要等 forward-runner 落盘才知道 ——
      // 回执不许冒充送达（2026-09-08 三条消息拿到送达回执、转发进程秒退、消息从未到达会话）。
      // 措辞里的旧字样已被 R54 测试用 git grep 级全仓扫描禁止 —— 注释里也不许再出现。
      live_session: "正在转发到你正开着的会话（" + detail.targetName + "）；转发结果落在运行目录，doctor 可查",
      resume: "已续起本话题绑定的那条会话，后台执行",
      continue: "已起一轮后台执行（沿用本项目最近的对话）",
      reply_only: "已起一次性回复（零工具、不读任何会话历史，不进 owner 的会话）",
    }[detail.mode] ?? ("已投递（方式：" + String(detail.mode) + "）");
    return [
      "已受理 · " + detail.taskName,
      where + "。完成后结果会自动发布到本话题。",
      "消息 " + detail.messageId.slice(-8) + " | claim " + detail.key.slice(0, 8),
    ].join("\n");
  }
  if (kind === "bound") {
    const lines = [
      "绑定完成 · " + detail.taskName,
      "这个话题现在通向 " + detail.root + "。",
      "之后在这条消息下面 @ 一下就是给它下指令；它的进展和每一轮回答也会以卡片发回这里。",
    ];
    if (detail.bodySkipped) lines.splice(2, 0, "你这条消息里带的正文没有被执行（配对消息只做绑定）；要下指令请再发一条新消息。");
    return lines.join("\n");
  }
  if (kind === "control") return detail.text;
  if (kind === "chat") return detail.text + "\n" + CHAT_FOOTER + (detail.replayed ? "（同一条消息的重放：按记录重出）" : "") + (detail.ledgerNote ?? "");
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

// ---------- 频道定位采样旁路（不承重）----------
// 取到事件之前 sampleCtx 为 null：那几条是系统错误 / 模板不可用 / 信封失败，不是入站消息，不入样本。
let sampleCtx = null; // { event, canonical, template, chain }
function recordChannelSample(kind, reason) {
  if (!sampleCtx) return;
  // appendChannelSample 全包 try/catch，失败静默返回 { ok:false, reason }，绝不阻断主流程，
  // 也绝不污染进程输出（Aily 会把 stdout+stderr 合并进模型上下文）—— 原因只落机器级诊断文件
  // <dir>/channel-samples.diag.log（见 channel-samples.mjs）。
  appendChannelSample({
    file: CHANNEL_SAMPLES_FILE,
    event: sampleCtx.event,
    canonical: sampleCtx.canonical,
    template: sampleCtx.template,
    chain: sampleCtx.chain,
    env: process.env,
    disposition: channelDisposition(kind, reason),
  });
}

function finish(kind, detail, result) {
  recordChannelSample(kind, result?.reason);
  process.stdout.write(ackText(kind, detail) + "\n");
  process.stderr.write(JSON.stringify({ kind, ...result }) + "\n");
  process.exit(kind === "error" ? 1 : 0);
}


// ---------- chat 默认态（无绑定上下文：刚装桥的群话题、私聊、unbind 之后）----------
// 绑定没成不等于该拒：三道闸之后按 authorize 的 chat 行判权，路由器**同步**起零工具一次性回合，把回答当回执返回。
// 这里没有 claim（没有绑定就没有账本），也没有任何异步回投通道（运输 agent 的回复 = 本进程的 stdout）。
function chatTurn({ chain, template, event, dryRun, ledgerDir }) {
  const messageId = event.message_id ?? ("unknown-" + Date.now());
  const gates = evaluateChatGates({ event, template });
  if (!gates.ok) {
    writeReceipt("chat-rejected-" + messageId, { status: "rejected", mode: CHAT_POLICY_ID, reason: gates.reason, reason_text: gates.reasonText, message_id: messageId, session_id: event.session_id ?? null, claim_acquired: false, handed_off: false });
    finish("rejected", { reasonText: gates.reasonText, taskName: null }, { reason: gates.reason, mode: CHAT_POLICY_ID });
  }
  const instruction = normalizeBody(event.content).trim();
  const intent = parseInboundIntent({ instruction, chain });
  const risk = classifyRisk({ intent, mode: CHAT_POLICY_ID });
  const authz = authorize({ role: gates.role, riskClass: risk.riskClass, mode: CHAT_POLICY_ID, chain });
  const base = { mode: CHAT_POLICY_ID, role: gates.role, risk_class: risk.riskClass, intent: intent.intent, message_id: messageId, session_id: event.session_id ?? null, claim_acquired: false, handed_off: false };
  if (!authz.allow) {
    writeReceipt("chat-authz-" + messageId, { status: "rejected", reason: "not_authorized", authz_reason: authz.reason, required_roles: authz.required, ...base });
    finish("rejected", { reasonText: authz.text, taskName: null }, { reason: "not_authorized", authz_reason: authz.reason, mode: CHAT_POLICY_ID });
  }
  // capability 不是装饰字段：chat 只接受 chat_reply，别的值说不清就拒
  if (authz.capability !== CAPABILITY.CHAT_REPLY) {
    writeReceipt("chat-capability-" + messageId, { status: "error", reason: "capability_unknown", capability: authz.capability ?? null, ...base });
    finish("error", { detail: "这条消息的执行边界说不清（" + String(authz.capability) + "），没有回答" }, { reason: "capability_unknown", mode: CHAT_POLICY_ID });
  }
  // 命令命名空间在 chat 里：接入指引 / 不开放 / 形状不对，都是确定性文案，不起模型
  if (intent.intent === INTENT.REJECTED_CONTROL || intent.intent === INTENT.MALFORMED_CONTROL) {
    writeReceipt("chat-control-" + messageId, { status: "rejected", reason: intent.intent, word: intent.word, problem: intent.problem, ...base });
    finish("rejected", { reasonText: controlRejectText(intent), taskName: null }, { reason: intent.intent, word: intent.word, mode: CHAT_POLICY_ID });
  }
  if (intent.intent === INTENT.MODEL_CONTROL || intent.intent === INTENT.ROUTER_CONTROL || intent.intent === INTENT.READONLY) {
    const text = intent.word === "feishu-bind" ? CHAT_BIND_GUIDE : "这个话题还没接入本机项目，" + "/" + intent.word + " 在这里无从执行；" + CHAT_BIND_GUIDE;
    writeReceipt("chat-guide-" + messageId, { status: "chat", kind: "guide", word: intent.word, ...base });
    finish("chat", { text }, { mode: CHAT_POLICY_ID, kind: "guide", word: intent.word });
  }
  if (dryRun) {
    process.stdout.write("[dry-run] chat · 会以零工具一次性回合回答（角色 " + gates.role + "，" + risk.riskClass + "），不写状态\n");
    process.stderr.write(JSON.stringify({ dryRun: true, mode: CHAT_POLICY_ID, role: gates.role, risk: risk.riskClass }) + "\n");
    process.exit(0);
  }
  // 幂等：同一条消息（chain + message_id + session_id）只答一次；重放按记录重出，不再起模型 —— 这一步在任何前置核验之前，已闭合的重放不受当前环境影响
  const key = chatKey({ chain, messageId, sessionId: event.session_id ?? "" });
  const seen = inspectChat({ ledgerDir, key });
  if (seen.state === "answered") {
    writeReceipt("chat-replay-" + messageId, { status: "chat", kind: "replay", ...base });
    finish("chat", { text: displaySafe(seen.record.text), replayed: true }, { mode: CHAT_POLICY_ID, kind: "replay" });
  }
  // 失败重放：文案只从受控 reason 渲染，账本里存的 why 不进用户文案
  if (seen.state === "failed") finish("error", { detail: "这条消息上次就没答出来（" + chatFailText(seen.record.reason, { timeoutMs: seen.record.timeout_ms, exitCode: seen.record.exit_code, signal: seen.record.signal }) + "）；同一条消息不会再答，请再发一条新消息" }, { reason: "chat_replay_failed", mode: CHAT_POLICY_ID });
  if (seen.state === "running") finish("error", { detail: "这条消息还在答，等它答完；不会再起第二个回答" }, { reason: "chat_running", mode: CHAT_POLICY_ID });
  if (seen.state === "stale") finish("error", { detail: "这条消息上次的回答进程没留下结果；同一条消息不会再答，请再发一条新消息" }, { reason: "chat_stale", mode: CHAT_POLICY_ID });
  if (seen.state === "unreadable") finish("error", { detail: "这条消息的 chat 账本读不出（" + seen.why + "），没有回答" }, { reason: "chat_ledger_unreadable", mode: CHAT_POLICY_ID });
  // 准入 —— 一把锁内：盘点（说不清就拒，不折叠成空闲）→ 上界 → 建 claim（闭合转换）。
  // M1a 双写（#R37）：A1 物化入口接 wireChatA1 —— 已启用端点（ledger_init done 收据）以 m1a-order
  //   锁串行、先 legacy 后 create_a1 shadow；未启用端点（无收据）→ 合法 legacy-only、不写 shadow；
  //   已启用点任一取锁失败 → 整笔拒、不写 legacy（见 m1a-reconciliation §5，skip 集为空）。
  //   ponytail: chat 取锁失败即丢本消息（可用性换一致）；若需重试再在外层加退避。
  // P1-5①（#R37）：A1 群锚点用「当场受验 locator」（AILY_CLI_CHANNEL_CHAT_ID），不是 template.chat_id。
  //   依据 channel-locator-verdict §2：AILY_CLI_CHANNEL_CHAT_ID 就是本消息所在的飞书群 chat_id（已对真机核验）；
  //   template.chat_id 是登记群，不是这场对话的现场 —— 拿它当 A1 群就是拿配置冒充现场。
  //   §4 fail-safe：缺 / 空 → || null → create_a1 bad_input → 拒物化（未受验不猜）；形状不对同样被 create_a1 收口。
  //   legacy chat 照答（外层 runWired 返回 outer ok + shadow 失败步），所以不阻断用户得到回答。
  const wired = wireChatA1({
    agentUid: template.agent_uid, chatId: process.env.AILY_CLI_CHANNEL_CHAT_ID || null, sessionId: event.session_id ?? null, messageId,
    admit: () => admitChat({ ledgerDir, key, senderId: event.sender_id, budgetMs: chatReplyTimeoutMs(),
      meta: { chain, message_id: messageId, session_id: event.session_id ?? null, sender_ref: senderRef(event.sender_id), role: gates.role, risk_class: risk.riskClass } }),
  });
  if (!wired.ok) {
    // 双写强制下锁取不到（busy/maintenance/root_*/dir_*/lock_residue/reap_* 等）：整笔拒、不写 legacy、没有回答。
    writeReceipt("chat-m1a-" + messageId, { status: "rejected", reason: wired.reason ?? "m1a_reject", why: wired.why ?? null, lock: wired.lock ?? null, mode: CHAT_POLICY_ID, ...base });
    finish("rejected", { reasonText: "这条消息的 M1a 一致性锁取不到（" + (wired.reason ?? "unknown") + "），未写 legacy、没有回答；稍后再问一次" }, { reason: wired.reason ?? "m1a_reject", mode: CHAT_POLICY_ID });
  }
  const admitted = wired.legacy;
  if (!admitted.ok) {
    const lockNote = admitted.lockUncleared ? "；另外" + lockUnclearedText(admitted.lockUncleared) : "";
    if (admitted.reason === "duplicate") finish("error", { detail: "这条消息刚被另一个进程接手回答；不会再起第二个回答" + lockNote }, { reason: "chat_duplicate_race", mode: CHAT_POLICY_ID });
    if (admitted.reason === "chat_busy_global" || admitted.reason === "chat_busy_sender" || admitted.reason === "chat_admission_busy") {
      writeReceipt("chat-busy-" + messageId, { status: "rejected", reason: admitted.reason, load: admitted.load ?? null, ...base });
      finish("rejected", { reasonText: admitted.text + lockNote, taskName: null }, { reason: admitted.reason, mode: CHAT_POLICY_ID });
    }
    writeReceipt("chat-ledger-" + messageId, { status: "error", reason: admitted.reason, why: admitted.why ?? admitted.text ?? null, load: admitted.load ?? null, ledger_dir: ledgerDir, ...base });
    finish("error", { detail: (admitted.text ?? ("chat 账本不可用（" + admitted.reason + (admitted.why ? "：" + admitted.why : "") + "），没有回答")) + lockNote }, { reason: admitted.reason, mode: CHAT_POLICY_ID });
  }
  // 锁没交还：飞书正文只给状态词与锁协议的指引（主锁不要手删，持有者已死超过 5 分钟由下一笔按协议回收）；路径与原因只进机器回执
  const admitNote = admitted.lockUncleared ? "（" + lockUnclearedText(admitted.lockUncleared) + "）" : "";
  if (admitted.lockUncleared) writeReceipt("chat-lock-" + messageId, { status: "error", reason: "chat_admission_lock_uncleared", why: admitted.lockUncleared, lock_dir: ledgerDir, ...base, claim_acquired: true });
  // 自己的临时文件没清掉（极少见）：不影响这条回答，doctor ⑨ 会点名；只进机器回执
  if (admitted.tmpResidue) writeReceipt("chat-tmp-" + messageId, { status: "error", reason: "chat_ledger_tmp_residue", tmp: admitted.tmpResidue, ...base, claim_acquired: true });
  // #R37 P1-4：legacy 已收但 A1 shadow 不干净（镜像步失败/非干净提交/锁残骸/release 残骸）→ 写持久机器回执，不谎报 clean。
  const chatUnclean = uncleanWired(wired);
  if (!chatUnclean.clean) writeReceipt("chat-unclean-" + messageId, { status: "unclean", ...chatUnclean, mode: CHAT_POLICY_ID, ...base, claim_acquired: true });
  const reply = chatReply({ instruction });
  if (!reply.ok) {
    const recorded = recordChatOutcome({ ledgerDir, key, outcome: { status: "failed", reason: reply.reason, why: reply.why, diagnostic: reply.diagnostic ?? null, elapsed_ms: reply.elapsedMs,
      ...(reply.reason === "timeout" ? { timeout_ms: reply.timeoutMs } : {}), ...(reply.reason === "nonzero_exit" ? { exit_code: reply.exitCode } : {}), ...(reply.reason === "signaled" ? { signal: reply.signal } : {}) } });
    writeReceipt("chat-failed-" + messageId, { status: "error", reason: "chat_reply_failed", why: reply.reason, detail: reply.why, diagnostic: reply.diagnostic ?? null, elapsed_ms: reply.elapsedMs, ledger: recorded.ok ? "recorded" : recorded.reason, ledger_lock_uncleared: recorded.lockUncleared ?? null, ledger_tmp_residue: recorded.tmpResidue ?? null, ...base, claim_acquired: true });
    finish("error", { detail: "chat 没答出来（" + reply.why + "）。这里没有接入，无法稍后补发，请再问一次" + (recorded.ok ? "" : "（账本没记下终态：" + recorded.reason + "）") + admitNote }, { reason: "chat_reply_failed", why: reply.reason, mode: CHAT_POLICY_ID });
  }
  const recorded = recordChatOutcome({ ledgerDir, key, outcome: { status: "answered", text: reply.text, elapsed_ms: reply.elapsedMs } });
  writeReceipt("chat-" + messageId, { status: "chat", kind: "reply", elapsed_ms: reply.elapsedMs, ledger: recorded.ok ? "recorded" : recorded.reason, ledger_lock_uncleared: recorded.lockUncleared ?? null, ledger_tmp_residue: recorded.tmpResidue ?? null, ...base, claim_acquired: true });
  // 回答已经拿到就要给人；账本没记下只影响重放（会按 stale 处理、不再答），如实标注
  finish("chat", { text: displaySafe(reply.text), ledgerNote: (recorded.ok ? "" : "（账本没记下这次回答：" + recorded.reason + "；同一条消息的重放不会再答）") + admitNote || null }, { mode: CHAT_POLICY_ID, kind: "reply", elapsed_ms: reply.elapsedMs, role: gates.role, risk_class: risk.riskClass, ledger: recorded.ok ? "recorded" : recorded.reason, lock_uncleared: admitted.lockUncleared ?? null });
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
// 采样的上下文在事件可取之后才成立；早于事件的那几条 finish 记录不到（不是入站消息）。
sampleCtx = {
  event,
  canonical: fetched.canonical_event ?? null,
  template: bootTpl.ok ? bootTpl.template : null,
  chain: "claude",
};
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
  // 路由结论封闭：bound / 确定未绑定（no_binding_for_session，含暂停的绑定）/ 说不清（歧义、登记表读错、有读不清的候选）。只有第二种能往下走（认领或 chat）。
  if (routed.reason !== "no_binding_for_session") {
    writeReceipt("unresolved-" + (event.message_id ?? Date.now()), { status: "error", reason: routed.reason, candidates: routed.candidates ?? null, skipped: routed.skipped ?? null, message_id: event.message_id ?? null, claim_acquired: false, handed_off: false });
    finish("error", { detail: "这个会话对应的绑定说不清（" + routed.reason + "），既不投递也不回答" }, { reason: routed.reason });
  }
  // 没有已绑定的话题对得上 —— 可能是「新话题的第一条 @」，也可能是条不该理的消息。
  // 绑定必然分两段：建话题时 Aily session 还不存在（它是第一条消息流进来才产生的）。
  const tpl = loadChainTemplate();
  const template = tpl.ok ? tpl.template : null;
  // 私聊（已验证登记表正向命中）早分流：#R11 P1-1 把判据换成模板里的 verified_p2p_chat_ids。
  // 命中 isPrivateChatTurn 的轮次不进认领评估 —— 认领本来就该在群话题里真实 @ 完成，私聊没有 @ 可打，
  // 留着只有一条 transport_not_mentioned 的错拒绝。chatTurn 自带三道闸（角色阈值含 owner full / 其他
  // reply_only 照旧、新鲜度、@ 闸已对私聊豁免），所有出口都 finish，不会落到下面的认领路径。
  // 登记表缺失/空或 chat 未登记时恒 false，按群处理，既有行为不变。
  if (isPrivateChatTurn({ template, env: process.env })) {
    chatTurn({ chain: "claude", template, event, dryRun, ledgerDir: path.join(UNROUTED_RT, "chat-claims") });
  }
  // 把正文传进去：绑定码就藏在飞书自动附加的引用块里，Frank 不用打任何东西。
  const promotionNow = Date.now();
  const pending = findPendingBinding({ content: event.content, now: promotionNow });
  const promo = evaluatePromotion({ event, template, pending, now: promotionNow });
  if (!pending.ok && pending.reason === "pending_binding_expired" && pending.operationId) {
    // P1-3②（#R37 返修）：过期兜底原本只 closeClaudeTopicRotation（不落 M1a 账本），现包成 wireVoid(reason=expired)。
    //   目标由 resolver 按被作废代际根消息 om 命中（从 binding state 读 pending generation 的 root_message_id）；
    //   resolver 未命中（legacy-only、无 B1）→ shadow fail-closed、legacy 照常过期。与 feishu-rotate 不同，
    //   过期分支**只作废、不改账本**（无 create_b1）—— 单笔 void(expired)，取 outer 锁。
    //   P1-6（⑤）：shadow 步/释放失败 → 机器回执，不静默；legacy 已过期，作废镜像缺失留 doctor/repair。
    const wireExpireLegacy = () => closeClaudeTopicRotation({
      root: pending.root,
      claudeSessionId: pending.claudeSessionId,
      operationId: pending.operationId,
      reason: "expired",
      now: promotionNow,
    });
    if (template?.agent_uid) {
      const bound = loadClaudeTopicBinding({ root: pending.root, claudeSessionId: pending.claudeSessionId });
      const expiredGen = bound.ok ? pendingGeneration(bound.state) : null;
      const wiredExpire = wireVoid({
        endpointId: legacyEndpointId({ runtime: "claude", agentUid: template.agent_uid }),
        env: process.env,
        rotationOpId: pending.operationId,
        locator: expiredGen?.root_message_id ?? null,
        reason: "expired",
        legacy: wireExpireLegacy,
      });
      const failedStep = (wiredExpire.shadow ?? []).find((s) => !s.ok);
      const relFail = wiredExpire.release && wiredExpire.release.ok !== true;
      if (failedStep || relFail) {
        writeReceipt("expire-void-" + (event.message_id ?? Date.now()), { status: "shadow_failed", operationId: pending.operationId, locator: expiredGen?.root_message_id ?? null, legacy_committed: true, step: failedStep ?? null, release: wiredExpire.release ?? null, expired_at: promotionNow });
      }
    } else {
      wireExpireLegacy();
    }
  }
  subscriptionClaimShadow = shadowClaudeFirstClaim({
    event,
    template,
    callerAgentUid: callerAgent,
    legacyPending: pending,
    legacyPromotion: promo,
    now: promotionNow,
  });

  // 绑定没成不等于该拒：没有 pending / 多份 / 绑定码对不上 / 过期 / 发送者不是 owner → 落进 chat 默认态重新判
  if (!promo.ok && CHAT_FALLBACK_REASONS.includes(promo.reason)) chatTurn({ chain: "claude", template, event, dryRun, ledgerDir: path.join(UNROUTED_RT, "chat-claims") });

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

  // M1a 双写（#R37 W1/W2）：认领→绑定落盘处接 wirePromoteBinding —— 已启用端点（ledger_init done
  //   收据）以 m1a-order 锁串行、先 legacy promoteBinding 后 create_a1→activate（W1）/ rebind_session_alias（W2）shadow；
  //   未启用端点（无收据）→ 合法 legacy-only、不写 shadow；已启用点任一取锁失败 → 整笔披、不写 legacy（skip 集为空）。
  //   locator=被认领代际根消息 om（matched_om）；claimKey=claim.mjs 64hex；authorizedBy=event.sender_id。
  //   W2（B3 已 active 换会话再认领）只把 aliases.session_id 改到 event.session_id（受验新 Aily 会话 locator）——
  //   认领现场不铸临时 UUID/不碰 binding_target；ledger 侧 claude_session_id 的 retarget 归 Phase 2 配对写方（§5.1）。
  const wired = wirePromoteBinding({
    endpointId: legacyEndpointId({ runtime: "claude", agentUid: template.agent_uid }),
    env: process.env,
    legacy: () => promoteBinding({
      root: promo.root,
      id: promo.id,
      source: promo.source,
      generationId: promo.generationId,
      operationId: pending.operationId,
      sessionId: event.session_id,
    }),
    locator: pending.generation?.root_message_id ?? null,
    claimKey: claimKey(event.message_id ?? "", promo.id ?? ""),
    sessionId: event.session_id ?? null,
    authorizedBy: event.sender_id ?? null,
    f4: promo.f4 ?? null,
    // #R37 P1-1②：锁内重核六件事。调用侧 evaluatePromotion 在取锁前算（只作路由/旁路用，结论可能被竞态
    //   作废）；取得 outer 锁、legacy 前这里重跑 findPendingBinding + evaluatePromotion（用锁内时刻的 now，
    //   重核新鲜度/唯一可认领/来源受验等全部六条）。拒 → 整笔 fail-closed（不跑 legacy、不写 shadow、不归并）。
    //   通过 → 其给出的 f4 全权替代调用侧 f4（锁内结论优先），配合 wirePromoteBinding 侧 f4Ok 的
    //   matched_om===locator 复核，locator 若在锁前被改 → bad_f4 兜底。
    verify: () => {
      const nowVerify = Date.now();
      const pendingVerify = findPendingBinding({ content: event.content, now: nowVerify });
      if (!pendingVerify.ok) return { ok: false, reason: pendingVerify.reason, why: "锁内重核：pending 现场不再可认领（" + (pendingVerify.reason ?? "unknown") + "）" };
      // #守卫①：这里已在锁内 = 端点有 init 收据（已启用）。owner_root_no_token_v1 已停产后，无码认领（only_pending）
      //   没有可写的诚实配对证明 —— 整笔拒（legacy 不跑、shadow 不写、B1 保持 pending）。
      if (pendingVerify.matchedBy === "only_pending") return { ok: false, reason: "no_token_for_enabled", why: "端点已启用：需绑定码或 root attestation（已启用端点不接受无码认领）" };
      const promoVerify = evaluatePromotion({ event, template, pending: pendingVerify, now: nowVerify });
      if (!promoVerify.ok) return { ok: false, reason: promoVerify.reason, why: "锁内重核：认领六件事不再成立（" + (promoVerify.reason ?? "unknown") + "）" };
      if (promoVerify.f4 != null && promoVerify.f4.matched_om !== (pendingVerify.generation?.root_message_id ?? null)) return { ok: false, reason: "f4_changed", why: "锁内重核：matched_om 与锁内 locator 不符" };
      return { ok: true, f4: promoVerify.f4 };
    },
  });
  if (!wired.ok) {
    // 双写强制下锁取不到（busy/maintenance/root_*/dir_*/lock_residue/reap_* 等）：整笔披、不写 legacy、没有绑定。
    writeReceipt("promote-m1a-" + event.message_id, { status: "rejected", reason: wired.reason ?? "m1a_reject", why: wired.why ?? null, lock: wired.lock ?? null, claim_acquired: false, handed_off: false, subscription_claim_shadow: subscriptionClaimShadow });
    // #守卫①：无码认领被已启用端点拒绝 → 用「需绑定码或 root attestation」文案，而不是通用「锁取不到」。
    const finishReason = wired.reason ?? "m1a_reject";
    const reasonText = finishReason === "no_token_for_enabled"
      ? "这条认领没有绑定码，而已启用端点不接受无码认领（需绑定码或 root attestation），未绑定"
      : "这条认领的 M1a 一致性锁取不到（" + finishReason + "），未绑定，请稍后再试一次";
    finish("rejected", { reasonText }, { reason: finishReason });
  }

  const wrote = wired.legacy;
  if (!wrote.ok) {
    writeReceipt("bind-failed-" + event.message_id, {
      status: "error", reason: wrote.reason, message_id: event.message_id,
      claim_acquired: false, handed_off: false,
      subscription_claim_shadow: subscriptionClaimShadow,
    });
    finish("error", { detail: "绑定没写成（" + wrote.reason + "）" }, { reason: wrote.reason });
  }

  // #R37 P1-4：legacy 已成但 shadow 不干净（镜像步失败/非干净提交/锁残骸/release 残骸）→ 写持久机器回执，不谎报 clean。
  const promoteUnclean = uncleanWired(wired);
  if (!promoteUnclean.clean) writeReceipt("m1a-unclean-" + event.message_id, {
    status: "unclean", legacy: "ok", ...promoteUnclean,
    claim_acquired: false, handed_off: false, subscription_claim_shadow: subscriptionClaimShadow,
  });

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

// P1-1③（#R37）：配对复合消息 = bind-only（layers-v2-permissions.md §4/§10-1 拍板）。本条消息若是
//   首条受验 owner @ 的配对尝试（justBound —— 锁内 evaluatePromotion 六件事通过、成功绑定），就**整条
//   只做 R3 配对、正文不执行**（成功或失败都不再处理正文）。旧码只对「光秃秃一个 @」（EMPTY_INSTRUCTION）
//   触发 bound 握手，非空正文在绑定后会继续按新策略执行 —— 那是 §4 明说要收紧的旧差异（配对复合消息只属
//   一个上下文）。这里把 bound 握手提前到 verdict/策略/指令授权 shadow/claim/投递之前：配对消息不需要评估
//   后续正文、不起 claim、不起模型。
if (justBound) {
  const bodySkipped = normalizeBody(event.content).trim().length > 0;
  appendConsumed(routed.root, event.message_id, {
    claudeSessionId: routed.mapping?.claude_session_id ?? null,
  });
  writeReceipt("bound-" + event.message_id, {
    status: "bound", message_id: event.message_id, session_id: event.session_id,
    root: routed.root, binding_id: effectiveBindingId(mapping),
    matched_by: pendingMatchedBy,
    body_skipped: bodySkipped,
    claim_acquired: false, handed_off: false,
    subscription_claim_shadow: subscriptionClaimShadow,
    // 为将来的确定性匹配攒证据：根消息里那个绑定码有没有随引用块回来。
    // 现在没有代码依赖它，纯粹是想知道那条路走不走得通。
    pending_token_seen: typeof mapping.pending_token === "string" && mapping.pending_token.length > 0
      ? String(event.content ?? "").includes(mapping.pending_token) : null,
  });
  finish("bound", { taskName: config.task_display_name, root: routed.root, bodySkipped },
    { bound: true, root: routed.root, body_skipped: bodySkipped });
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
// 第 3 层：正文先落进封闭的意图联合（inbound-intent.mjs），control 只是其中 router_control 那一支；入口按 intent 做确定性处置。
const intent = parseInboundIntent({ instruction: verdict.instruction, chain: "claude" });
const control = intent.control;
const rejectedProjection = rejectedControlProjection(intent);

// ---------- 唯一一处授权判定（角色 × 风险等级 × 模式）：三道闸之后、拿 claim 之前 ----------
// 拒绝必须说清"哪个模式、哪个角色、缺什么权限"，不投递、不静默；不取 claim（重发不算重放）。
const senderRoleValue = senderRole({ frank_sender_id: mapping.frank_sender_id, senders: config?.senders }, event.sender_id);
const risk = classifyRisk({ intent, mode: policyEvaluation.policy_id });
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
// ---------- 近似命中收边（第 3 层）：拒绝事务 —— 与控制命令事务同一套形状（锁内记账、重放按记录重出、损坏指路维护入口） ----------
const rejectControl = (replay) => {
  const tx = runRejectTransaction({ claimsDir: CLAIMS, key: claim.key, projection: rejectedProjection, replay, expect: claimExpect });
  const lockNote = tx.lockUncleared ? "；另外这一笔的事务锁没有交还（" + tx.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后处理" : "";
  const base = { reason: intent.intent, word: intent.word, problem: intent.problem, message_id: verdict.messageId, project_root: routed.root, binding_source: routed.source, claim_acquired: !replay, handed_off: false, lock_uncleared: tx.lockUncleared ?? null };
  if (!tx.ok) {
    writeReceipt("malformed-control-" + verdict.messageId, { status: "error", ...base, tx_reason: tx.reason, error: tx.why });
    const broken = tx.reason === "rejected_unreadable" || tx.reason === "rejected_intent_mismatch";
    finish("error", { detail: (broken
      ? "这一笔的拒绝记录" + (tx.reason === "rejected_unreadable" ? "损坏" : "与意图不一致") + "（" + tx.why + "）；没有执行也没有投递。请用维护入口 repair-control-claim 处理这一笔"
      : "拒绝没有记下（" + tx.reason + "：" + tx.why + "）；没有执行也没有投递。同一条消息的运输层重放会补齐") + lockNote }, { reason: tx.reason, intent: intent.intent });
  }
  writeReceipt("malformed-control-" + verdict.messageId, { status: "rejected", ...base, replayed: tx.replayed, resumed: tx.resumed });
  finish("rejected", { reasonText: controlRejectText(intent) + (tx.replayed ? "（同一条消息的重放：按记录重出回执）" : tx.resumed ? "（补齐了上次没记下的拒绝终态）" : "") + lockNote, taskName: config.task_display_name },
    { reason: intent.intent, word: intent.word, replayed: tx.replayed, resumed: tx.resumed });
};
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

// ---------- /feishu-select 控制命令事务（R52a）：锁内确定性处置准入，落 failed 终态（执行器未接入期不落 consumed，PR #136 P1-4） ----------
const runSelect = (replay) => {
  const tx = runControlTransaction({
    claimsDir: CLAIMS, key: claim.key, intent: control ? { control: "select", handle: control.handle, handle_kind: control.handle_kind } : undefined, replay, expect: claimExpect,
    // R57d 返修一 B 段 P1-3：现算的 selection context digest 传进事务，终态短路前与 claim 里持久化的逐字比对。
    contextDigest: selectionContextDigest,
    execute: (_target, txCtx) => executeSelectControl(control, {
      txCtx,
      selectAdmissionFn,
      // R57b/R57d §8.1 消费侧核验的事件事实：sender=入站发送者；endpoint=本映射的账本 endpoint；
      // chat=链路模板登记群（账本记录的 chat_id 同源派生——wireRotate 建记录用 current.config.chat_id）；
      // messageId=本条命令消息；eventSessionId=选择五元的 session 输入（R57d 返修一 P1-5：root 改由
      // 命中记录现场供给，不再传 mapping 的 transport 根 eventRootOm）。
      senderId: event.sender_id ?? null,
      chatId: bootTpl.template?.chat_id ?? null,
      endpointId: bootTpl.template?.agent_uid ? legacyEndpointId({ runtime: "claude", agentUid: bootTpl.template.agent_uid }) : null,
      messageId: verdict.messageId,
      eventSessionId: event.session_id ?? null,
      // R57d 返修三 P1-2：capability 只由 R3 成功分支（此处）铸造并显式传入；执行器不自铸。
      capability: mintSelectCapability({
        endpoint: bootTpl.template?.agent_uid ? legacyEndpointId({ runtime: "claude", agentUid: bootTpl.template.agent_uid }) : null,
        chat: bootTpl.template?.chat_id ?? null,
        session: event.session_id ?? null,
        message: verdict.messageId,
        sender: event.sender_id ?? null,
        handle: control.handle ?? null,
        handleKind: control.handle_kind ?? null,
      }),
      // R57d 返修二 P1-1：shadow 期的 legacy 提交回调 —— 复用既有 promoteBinding（W1 的 legacy writer），
      //   载荷由执行器带足 generation/CAS 身份；operationId 从目标绑定的 pending 代际读出。
      //   换绑（rebind）没有既有 legacy writer（W2 的 legacy 是新代际认领，非原地换绑）→ 结构化拒，shadow 期 fail-closed。
      mappingUpdate: (u) => selectClaudeLegacyUpdate(u),
      env: process.env,
      // R57b 返修五：真实 claim 写方把 selection plan 落盘到本 claim（账本提交前），repair 才能读回三方绑定。
      claimsDir: CLAIMS,
      key: claim.key,
    }),
  });
  const lockNote = tx.lockUncleared ? "；另外这一笔的事务锁没有交还（" + tx.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后处理" : "";
  const base = { control: "select", handle_kind: control.handle_kind, message_id: verdict.messageId, project_root: routed.root, handed_off: false, lock_uncleared: tx.lockUncleared ?? null };
  if (!tx.ok) {
    if (tx.reason === "control_committed_unclean" || tx.status === "control-committed-unclean") {
      const text = tx.text ?? ("已写入但收口不干净（" + (tx.why ?? "请联系管理员修复") + "）");
      if (!replay && !tx.replayed) {
        writeReceipt("select-" + verdict.messageId, { status: "control-committed-unclean", reason: tx.reason, ...base, claim_acquired: true, error: tx.why });
      }
      finish("control", { text: text + lockNote, taskName: config.task_display_name },
        { reason: tx.reason, control: "select", replayed: tx.replayed, status: "control-committed-unclean" });
      return;
    }
    if (tx.reason === "control_failed" || tx.reason === "control_failed_recorded") {
      const text = selectRejectTextByReason(tx.why);
      if (!replay && !tx.replayed) {
        writeReceipt("select-rejected-" + verdict.messageId, { status: "rejected", reason: tx.why, ...base, claim_acquired: true });
      }
      finish("rejected", { reasonText: text + "。没有执行，也没有投递。" + lockNote, taskName: config.task_display_name },
        { reason: tx.why, control: "select", replayed: tx.replayed });
      return;
    }
    writeReceipt("select-" + verdict.messageId, { status: "error", reason: tx.reason, ...base, claim_acquired: !replay, error: tx.why });
    finish("error", { detail: "选择命令未执行（" + tx.why + "）" + lockNote }, { reason: tx.reason });
    return;
  }
  const rfh = control.handle_kind === "rfh";
  if (!replay && !tx.replayed) {
    // R57d：三支都是真消费 → 落正式 consumed 收据。
    writeReceipt("select-" + verdict.messageId, { status: "consumed", reason: rfh ? "select_reaffirm_consumed" : "select_executed", ...base, claim_acquired: true, changed: tx.changed });
  }
  const doneText = tx.text ?? (rfh ? selectReaffirmSuccessText(null) : "该选择之前已处理（同一条消息的重放）");
  finish("control", { text: doneText + lockNote, taskName: config.task_display_name },
    { control: "select", handle_kind: control.handle_kind, replayed: tx.replayed });
};

const selectionContext = (control && control.kind === "select") ? {
  endpoint: bootTpl.template?.agent_uid ? legacyEndpointId({ runtime: "claude", agentUid: bootTpl.template.agent_uid }) : null,
  chat: bootTpl.template?.chat_id ?? null,
  session: event.session_id ?? null,
  message: verdict.messageId,
  sender: event.sender_id ?? null,
  handle: control.handle,
  kind: control.handle_kind,
} : null;
const selectionContextDigest = selectionContext ? selectionContextDigestV1(selectionContext) : null;

// 校验通过才允许 claim。claim 是幂等的唯一保证。
const claim = acquireClaim({
  claimsDir: CLAIMS,
  messageId: verdict.messageId,
  logicalTaskKey: verdict.logicalTaskKey,
  meta: {
    // R52a 返修一 P1：claim meta 按 kind 投影 —— mode → {control,mode}；select → {control,handle,handle_kind}（避免 controlIntentProblem 以 mode 形状核 select 而拒）。
    ...(control ? { control: control.kind === "select" ? { control: "select", handle: control.handle, handle_kind: control.handle_kind } : { control: control.kind, mode: control.mode } } : {}),
    ...(selectionContext ? {
      selection_context: selectionContext,
      selection_context_digest_v1: selectionContextDigest,
    } : {}),
    ...(rejectedProjection ? { rejected_control: rejectedProjection } : {}),
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
  const currentIntent = control.kind === "select"
    ? { control: "select", handle: control.handle, handle_kind: control.handle_kind }
    : { control: control.kind, mode: control.mode };
  if (intent && sameControlIntent(intent, currentIntent)) {
    claim.key = claim.key ?? claimKey(verdict.messageId, verdict.logicalTaskKey);
    if (control.kind === "select") runSelect(true);
    else runControl(true);
  }
}
if (!claim.ok && claim.reason === "duplicate" && rejectedProjection) {
  // 收边的重放：意图从 claim 里恢复；一致才按事务补齐 / 重出（不一致说明是另一条不同正文的消息撞了同一 id，落到通用的幂等命中）。
  const original = readClaimState({ claimsDir: CLAIMS, key: claim.key, expect: claimExpect });
  if (original.status === "valid" && sameRejectedControl(original.claim.rejected_control, rejectedProjection)) {
    claim.key = claim.key ?? claimKey(verdict.messageId, verdict.logicalTaskKey);
    rejectControl(true);
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

// ---------- 近似命中收边（第 3 层）：不开放 / 不精确的命令形状，取 claim 后记拒绝终态、回执差在哪，不投递 ----------
// 能走到这里的只有 owner（非 owner 的 R3 在上面的 authorize 就拒了）；重放同一条消息撞的是 claim 的幂等，不会再记一次。
if (rejectedProjection) rejectControl(false);

// ---------- 控制命令：拿到 claim 之后当场执行（可恢复事务），不投递 ----------
if (control && control.kind === "select") runSelect(false);
else if (control) runControl(false);

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
// 执行边界：reply_only 永远不进现场会话、不续起任何会话；capability 说不清（缺席）按 fail-closed 拒，不折叠成 full。
const capability = authz.capability;
if (capability !== "full" && capability !== "reply_only") {
  recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: "capability_unknown" } });
  writeReceipt("capability-" + verdict.messageId, { status: "error", reason: "capability_unknown", message_id: verdict.messageId, claim_acquired: true, handed_off: false });
  finish("error", { detail: "这条消息的执行边界说不清，没有投递" }, { reason: "capability_unknown" });
}
const replyOnly = capability === "reply_only";

let ambiguousDelivery = null;
let target = null;
if (replyOnly) {
  // 只回复不进现场：不枚举现场会话、不选、不钉 delivery pin、不判歧义 —— 这些都只属于 full 分支
} else if (boundSession) {
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
      // R58：转发明确失败时 runner 写一条 outbox 失败回执（绑定同一 key / 原消息 / 出站代际）；
      // 落点跟绑定走（会话级绑定 → outbox-<sid>），与该会话 Stop 钡排空的是同一个目录。
      outboxDir: outboxDirOf(config.project_dir, boundSession),
      originGenerationId: policyRun.runRequest.origin.channelGenerationId,
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
      // reply_only 的回合不在任何真实会话里执行：runtime target 用一个与任何会话 id 都不可能相等的值，owner 会话的 Stop 不会误收它的终局（终局只由守望者收）
      policyRun = reserveDialogue(replyOnly ? "reply-only:" + claim.key : (boundSession ?? null), {
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
