#!/usr/bin/env node
/** M5Codex 唯一入站入口：确定性校验、原子 claim、精确 thread 非阻塞投递、秒级回执。 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { acquireClaim, recordClaimState } from "../claim.mjs";
import { fetchTriggerEvent } from "../envelope.mjs";
import {
  acquireSessionLock, releaseSessionLock, stampSessionLock,
} from "../handoff.mjs";
import { evaluateInbound, REJECT } from "../selector.mjs";
import { handOffCodex } from "./handoff.mjs";
import {
  appendConsumed, bridgeHome, evaluatePromotion, findPendingTask, findTaskForFeishuSession,
  isThreadBusy, loadCodexTemplate, promoteTask, taskPaths,
} from "./state.mjs";

const BRIDGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
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
if (!routed.ok) {
  if (routed.reason !== "no_binding_for_session") {
    finish("error", { detail: "Codex task registry 无法路由（" + routed.reason + "）" }, { reason: routed.reason });
  }
  const pending = findPendingTask({ home: HOME });
  if (!pending.ok && !["no_pending_binding", "multiple_pending_bindings", "pending_binding_expired"].includes(pending.reason)) {
    finish("error", { detail: "Codex task registry 无法读取（" + pending.reason + "）" }, { reason: pending.reason });
  }
  const promotion = evaluatePromotion({ event, template: template.template, pending });
  if (!promotion.ok) {
    const reasonText = REASON_TEXT[promotion.reason] ?? promotion.reason;
    writeReceipt("unrouted-" + (event.message_id ?? Date.now()), {
      status: "rejected", reason: promotion.reason, claim_acquired: false, handed_off: false,
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
    home: HOME,
  });
  if (!promoted.ok) finish("error", { detail: "绑定没写成（" + promoted.reason + "）" }, { reason: promoted.reason });
  justBound = true;
  routed = findTaskForFeishuSession({ sessionId: event.session_id, home: HOME });
  if (!routed.ok) finish("error", { detail: "绑定写完却读不回来" }, { reason: routed.reason });
}

const task = routed.task;
const paths = taskPaths(task, HOME);
receiptDir = paths.receipts;
const verdict = evaluateInbound({ event, mapping: routed.mapping, config: routed.config, now: Date.now() });

if (justBound && verdict.decision === "reject" && verdict.reason === REJECT.EMPTY_INSTRUCTION) {
  appendConsumed(task, event.message_id, { home: HOME });
  writeReceipt("bound-" + event.message_id, {
    status: "bound", message_id: event.message_id, logical_task_key: task.logical_task_key,
    claim_acquired: false, handed_off: false,
  });
  finish("bound", { taskName: task.task_display_name }, { bound: true, logical_task_key: task.logical_task_key });
}

if (dryRun) {
  const detail = verdict.reasonText ?? "校验通过，但没有 claim、没有投递";
  process.stdout.write("[dry-run] " + verdict.decision + " · " + detail + "\n");
  process.exit(0);
}

if (verdict.decision === "reject") {
  writeReceipt("reject-" + (event.message_id ?? Date.now()), {
    status: "rejected", reason: verdict.reason, message_id: event.message_id,
    logical_task_key: task.logical_task_key, claim_acquired: false, handed_off: false,
  });
  finish("rejected", { reasonText: verdict.reasonText, taskName: task.task_display_name }, { reason: verdict.reason });
}

const claim = acquireClaim({
  claimsDir: paths.claims,
  messageId: verdict.messageId,
  logicalTaskKey: task.logical_task_key,
  meta: { session_id: event.session_id, codex_thread_id: task.codex_thread_id },
});
if (!claim.ok) {
  const duplicate = claim.reason === "duplicate";
  finish(duplicate ? "rejected" : "error", {
    reasonText: duplicate ? "这条消息已经处理过（幂等命中）" : undefined,
    detail: duplicate ? undefined : "无法取得投递权（" + claim.reason + "）",
    taskName: task.task_display_name,
  }, { reason: claim.reason });
}

if (isThreadBusy(task.codex_thread_id, { home: HOME })) {
  recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed", detail: { reason: "target_busy" } });
  writeReceipt("busy-" + verdict.messageId, {
    status: "error", reason: "target_busy", message_id: verdict.messageId,
    claim_acquired: true, handed_off: false,
  });
  finish("error", { detail: "目标 Codex task 当前正在执行另一轮，请稍后发送一条新消息" }, { reason: "target_busy" });
}

const lock = acquireSessionLock(paths.sessionLock);
if (!lock.ok) {
  recordClaimState({ claimsDir: paths.claims, key: claim.key, state: "failed", detail: { reason: lock.reason } });
  finish("error", { detail: "目标 Codex task 正忙，上一条飞书指令还没结束" }, { reason: lock.reason });
}

const stamped = [
  "[飞书 · " + verdict.messageId + " · " + new Date(Number(event.created_at_ms)).toISOString() + "]",
  verdict.instruction,
].join("\n");
let run;
try {
  run = handOffCodex({
    projectDir: task.root,
    threadId: task.codex_thread_id,
    instruction: stamped,
    runsDir: paths.runs,
    key: claim.key,
    taskKey: task.logical_task_key,
    bridgeHome: HOME,
    codexBin: process.env.FEISHU_CODEX_BIN ?? "codex",
  });
} catch (err) {
  releaseSessionLock(paths.sessionLock);
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
writeReceipt("accepted-" + verdict.messageId, {
  status: "accepted", message_id: verdict.messageId, claim_key: claim.key,
  logical_task_key: task.logical_task_key, claim_acquired: true, handed_off: true,
  completion_observed: false, completion_owner: "codex_stop_hook_and_local_watcher",
  delivery_mode: run.mode, envelope_attempts: fetched.attempts ?? 1,
});

finish("accepted", {
  taskName: task.task_display_name,
  messageId: verdict.messageId,
  key: claim.key,
}, { claim_key: claim.key, delivery_mode: run.mode });
