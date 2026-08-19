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
import path from "node:path";

import { evaluateInbound } from "./selector.mjs";
import { fetchTriggerEvent } from "./envelope.mjs";
import { acquireClaim, recordClaimState } from "./claim.mjs";
import { handOff, acquireSessionLock, releaseSessionLock, stampSessionLock } from "./handoff.mjs";
import {
  deliverToLiveSession, findLiveSessions, hasPriorSession, stampInstruction,
} from "./live-session.mjs";

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
    // 说清楚落到哪条线上：他在终端里看不看得到这条指令，取决于这个。
    const where = detail.mode === "live_session"
      ? "已送进你正开着的会话（" + detail.targetName + "）"
      : "已起一轮后台执行（沿用本项目最近的对话）";
    return [
      "已受理 · " + detail.taskName,
      where + "。完成后结果会通过 COO助理CC 发布到本话题。",
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

const config = readJson(path.join(RT, "chain-config.json"));

let mapping = null;
const mappingPath = path.join(RT, "active-mapping.json");
try {
  mapping = readJson(mappingPath);
} catch {
  mapping = null; // selector 会把它判成 MAPPING_MISSING
}

const verdict = evaluateInbound({ event, mapping, config, now: Date.now() });

// --dry-run：只跑校验，不 claim、不投递、不写 mapping。用于诊断和联调，
// 免得一次排查就把真实指令送进长期任务。
if (process.argv.includes("--dry-run")) {
  process.stdout.write("[dry-run] " + verdict.decision +
    (verdict.reason ? " · " + verdict.reasonText : " · " + String(verdict.instruction).slice(0, 60)) + "\n");
  process.stderr.write(JSON.stringify({ dryRun: true, ...verdict }) + "\n");
  process.exit(0);
}

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
  meta: { session_id: event.session_id, binding_id: mapping.binding_id },
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

// 路由：现场有人就投给现场，没人才自己起一轮。
//
// 这两条分支必须互斥。都走 --continue 的话会有两个进程写同一份 transcript ——
// 现在没撞上纯粹是因为旧设计钉的是另一份记录，那是运气不是设计。
const liveTargets = findLiveSessions({ projectRoot: config.project_dir });
const target = liveTargets[0] ?? null;

let run;

if (target) {
  // 现场路径不需要会话锁：消息进的是一个活着的会话，它自己会把先后顺序排好。
  // 也不需要守望者 —— 那个会话结束时它自己的 Stop 钩子会把进展发出去。
  try {
    run = deliverToLiveSession({
      target,
      instruction: verdict.instruction,
      messageId: verdict.messageId,
      createdAtMs: event.created_at_ms,
      projectRoot: config.project_dir,
      runsDir: RUNS,
      key: claim.key,
    });
  } catch (err) {
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
  if (!hasPriorSession({ projectRoot: config.project_dir })) {
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
  const lock = acquireSessionLock(LOCK);
  if (!lock.ok) {
    recordClaimState({ claimsDir: CLAIMS, key: claim.key, state: "failed", detail: { reason: lock.reason } });
    writeReceipt("busy-" + verdict.messageId, {
      status: "error", reason: lock.reason, message_id: verdict.messageId,
      claim_acquired: true, handed_off: false,
    });
    finish("error", { detail: "长期任务正忙，上一条指令还没跑完" }, { reason: lock.reason });
  }

  try {
    run = handOff({
      projectDir: config.project_dir,
      instruction: stampInstruction({
        instruction: verdict.instruction,
        messageId: verdict.messageId,
        createdAtMs: event.created_at_ms,
      }),
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

  // 起一次性守望者：run 跑完就发布结果并放锁。
  if (config.auto_publish_on_completion !== false) {
    const w = spawn(process.execPath, [path.join(ROOT, "scripts", "watch-and-publish.mjs"), claim.key], {
      cwd: ROOT, detached: true,
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

mapping.consumed_message_ids = [...(mapping.consumed_message_ids ?? []), verdict.messageId];
const mtmp = mappingPath + ".tmp." + process.pid;
fs.writeFileSync(mtmp, JSON.stringify(mapping, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(mtmp, mappingPath);

writeReceipt("accepted-" + verdict.messageId, {
  status: "accepted", message_id: verdict.messageId, claim_key: claim.key,
  claim_acquired: true, handed_off: true, completion_observed: false,
  completion_owner: "outbound_publisher",
  run_log: run.logPath, pid: run.pid,
  // 落到哪条线上必须留痕：两条路径的结果发布者不同（现场靠它自己的 Stop 钩子，
  // --continue 靠一次性守望者），出问题时第一件事就是问「这条走的哪边」。
  delivery_mode: run.mode,
  target_session_id: run.targetSessionId ?? null,
  target_session_name: run.targetName ?? null,
});

finish("accepted", {
  taskName: config.task_display_name, messageId: verdict.messageId, key: claim.key,
  mode: run.mode, targetName: run.targetName,
}, { claim_key: claim.key, run_log: run.logPath, delivery_mode: run.mode });
