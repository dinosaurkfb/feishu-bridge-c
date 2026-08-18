#!/usr/bin/env node
/**
 * 入站主流程 —— M5Claude 唯一被允许调用的入口。
 *
 * 从 stdin 读一条飞书消息事件，输出一段给 Frank 的回执文本（stdout 最后一段）
 * 和一份机器可读结果（stderr 上的 JSON）。
 *
 * 时间契约：这个脚本必须秒级返回。它**不等待**长期任务完成 —— 完成由出站流程负责。
 *
 * 顺序不可调换：先校验、再 claim、再投递。任何一步失败都不进入下一步。
 */

import fs from "node:fs";
import path from "node:path";

import { evaluateInbound } from "./selector.mjs";
import { acquireClaim, recordClaimState } from "./claim.mjs";
import { handOff, acquireSessionLock, releaseSessionLock, stampSessionLock } from "./handoff.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RT = path.join(ROOT, ".runtime-data", "inbound");
const CLAIMS = path.join(RT, "delivery-claims");
const RECEIPTS = path.join(RT, "receipts");
const RUNS = path.join(RT, "runs");
const LOCK = path.join(RT, "session.lock");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));

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
    return [
      "已受理 · " + detail.taskName,
      "指令已投递，正在执行。完成后结果会通过 COO助理CC 发布到本话题。",
      "消息 " + detail.messageId.slice(-8) + " | claim " + detail.key.slice(0, 8),
    ].join("\n");
  }
  if (kind === "rejected") {
    return [
      "已拒绝 · " + detail.reasonText,
      "本条指令没有被投递给任何任务。",
    ].join("\n");
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

const raw = fs.readFileSync(0, "utf-8");
let event;
try {
  event = JSON.parse(raw);
} catch (err) {
  finish("error", { detail: "事件不是合法 JSON" }, { error: err.message });
}

const config = readJson(path.join(RT, "chain-config.json"));

let mapping = null;
const mappingPath = path.join(RT, "active-mapping.json");
try {
  mapping = readJson(mappingPath);
} catch {
  mapping = null; // selector 会把它判成 MAPPING_MISSING
}

const verdict = evaluateInbound({ event, mapping, config, now: Date.now() });

if (verdict.decision === "reject") {
  writeReceipt("reject-" + (event?.message_id ?? "unknown") + "-" + Date.now(), {
    status: "rejected",
    reason: verdict.reason,
    reason_text: verdict.reasonText,
    message_id: event?.message_id ?? null,
    claim_acquired: false,
    handed_off: false,
  });
  finish("rejected", verdict, { reason: verdict.reason });
}

// 校验通过才允许 claim。claim 是幂等的唯一保证。
const claim = acquireClaim({
  claimsDir: CLAIMS,
  messageId: verdict.messageId,
  logicalTaskKey: verdict.logicalTaskKey,
  meta: { chat_id: event.chat_id, binding_id: mapping.binding_id },
});

if (!claim.ok) {
  const isDup = claim.reason === "duplicate";
  writeReceipt("claim-" + claim.reason + "-" + verdict.messageId, {
    status: isDup ? "rejected" : "error",
    reason: claim.reason,
    message_id: verdict.messageId,
    claim_acquired: false,
    handed_off: false,
  });
  if (isDup) {
    finish("rejected", { reasonText: "这条消息已经处理过（幂等命中）" }, { reason: "duplicate" });
  }
  finish("error", { detail: "无法取得投递权：" + claim.error }, { reason: claim.reason });
}

// 同一会话不能并发 resume。拿不到锁就明确告知，不排队、不静默丢弃。
const lock = acquireSessionLock(LOCK);
if (!lock.ok) {
  recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: lock.reason } });
  writeReceipt("busy-" + verdict.messageId, {
    status: "error", reason: lock.reason, message_id: verdict.messageId,
    claim_acquired: true, handed_off: false,
  });
  finish("error", { detail: "长期任务正忙，上一条指令还没跑完" }, { reason: lock.reason });
}

let run;
try {
  run = handOff({
    projectDir: config.project_dir,
    sessionId: fs.readFileSync(path.join(ROOT, ".runtime-data", "longtask-session-id.txt"), "utf-8").trim(),
    instruction: verdict.instruction,
    runsDir: RUNS,
    key: claim.key,
  });
} catch (err) {
  releaseSessionLock(LOCK);
  recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { error: err.message } });
  writeReceipt("handoff-failed-" + verdict.messageId, {
    status: "error", reason: "handoff_failed", message_id: verdict.messageId,
    claim_acquired: true, handed_off: false,
  });
  finish("error", { detail: "投递失败：" + err.message }, { reason: "handoff_failed" });
}

// 把 run 信息盖进锁：锁要活到 run 结束，靠这份信息做陈旧回收。
stampSessionLock(LOCK, { pid: run.pid, logPath: run.logPath });

// 投递成功。注意 handed_off ≠ 完成，出站流程稍后独立判定完成。
recordClaimState({
  claimsDir: CLAIMS, key: claim.key, state: "handed_off",
  detail: { pid: run.pid, log_path: run.logPath, started_at: run.startedAt },
});

mapping.consumed_message_ids = [...(mapping.consumed_message_ids ?? []), verdict.messageId];
const mtmp = mappingPath + ".tmp." + process.pid;
fs.writeFileSync(mtmp, JSON.stringify(mapping, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(mtmp, mappingPath);

writeReceipt("accepted-" + verdict.messageId, {
  status: "accepted", message_id: verdict.messageId, claim_key: claim.key,
  claim_acquired: true, handed_off: true, completion_observed: false,
  completion_owner: "outbound_publisher",
  run_log: run.logPath, pid: run.pid,
});

finish("accepted", {
  taskName: config.task_display_name, messageId: verdict.messageId, key: claim.key,
}, { claim_key: claim.key, run_log: run.logPath });
