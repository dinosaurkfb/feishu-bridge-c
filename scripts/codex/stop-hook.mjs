#!/usr/bin/env node
/**
 * Codex Stop：按精确 thread 找 task，把 last_assistant_message 原样入队并自动发布。
 * 飞书入站回合只入队；严格 watcher 确认终局后才授予发布资格并发送。
 */

import fs from "node:fs";
import path from "node:path";

import { appendEvent, MAX_REPLY_CHARS } from "../outbox.mjs";
import { readClaim } from "../claim.mjs";
import { extractReply } from "../stop-hook.mjs";
import { clearTurnInput, readTurnInput } from "../turn-input.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import { isDirectRun } from "../direct-run.mjs";
import {
  bridgeHome, findTaskForCodexThread, hookLogFile, mappingForTask,
  readThreadActivity, recordThreadActivity, taskPaths,
} from "./state.mjs";

function log(line) {
  try {
    const file = hookLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, new Date().toISOString() + " " + String(line).replace(/\s+/g, " ").slice(0, 1000) + "\n", { mode: 0o600 });
  } catch { /* 钩子日志不能影响 Codex */ }
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function main() {
  const payload = readPayload() ?? {};
  const threadId = payload.session_id;
  if (typeof threadId !== "string" || !threadId) process.exit(0);

  const found = findTaskForCodexThread({ threadId });
  // 未绑定普通 task 没有 lease，也不应仅因 Stop 就在桥状态里留下 locator。
  if (found.ok || readThreadActivity(threadId).ok) {
    recordThreadActivity({
      threadId,
      turnId: payload.turn_id,
      cwd: payload.cwd,
      active: false,
      eventName: "Stop",
    });
  }
  if (payload.stop_hook_active === true) process.exit(0);
  if (!found.ok) process.exit(0);
  const paths = taskPaths(found.task, bridgeHome());
  const turnKey = typeof payload.turn_id === "string" ? payload.turn_id : null;
  const reply = extractReply(payload, { maxChars: MAX_REPLY_CHARS });
  if (!reply) {
    if (!process.env.FEISHU_BRIDGE_CLAIM_KEY && turnKey) {
      clearTurnInput({ dir: paths.turnInputs, key: turnKey });
    }
    log(found.task.logical_task_key + " empty reply");
    process.exit(0);
  }

  const claimKey = process.env.FEISHU_BRIDGE_CLAIM_KEY;
  if (!claimKey && (typeof payload.turn_id !== "string" || !payload.turn_id)) {
    log(found.task.logical_task_key + " missing turn_id; reply not queued");
    process.exit(0);
  }
  const eventKey = typeof claimKey === "string" && claimKey
    ? "codex:" + threadId + ":claim:" + claimKey + ":reply"
    : "codex:" + threadId + ":turn:" + (payload.turn_id ?? "unknown") + ":reply";
  const input = !claimKey && turnKey
    ? readTurnInput({ dir: paths.turnInputs, key: turnKey })
    : { ok: false };
  const mapping = mappingForTask(found.task, { home: bridgeHome() });
  const claim = claimKey ? readClaim({ claimsDir: paths.claims, key: claimKey }) : null;
  const targetGenerationId = claimKey
    ? claim?.origin_channel_generation_id
    : mapping.channel_generation_id;
  const r = appendEvent({
    outboxDir: paths.outbox,
    kind: "reply",
    text: reply,
    source: claimKey ? "codex-inbound-reply" : "codex-stop-reply",
    eventKey,
    publishEligible: found.task.auto_publish_on_completion === true && !claimKey,
    inputText: input.ok ? input.text : undefined,
    inputOrigin: input.ok ? input.inputOrigin : undefined,
    targetGenerationId,
    runId: claimKey ?? payload.turn_id,
  });
  if (!claimKey && turnKey && (r.ok || r.reason === "duplicate")) {
    clearTurnInput({ dir: paths.turnInputs, key: turnKey });
  }
  log(found.task.logical_task_key + " " + (r.ok ? "queued" : r.reason) + " event=" + eventKey);

  // 入站 run 的完成权属于 watcher；Stop 不能抢在 exit code 和 turn.completed 之前发布。
  if (claimKey) process.exit(0);

  const published = publishEligibleTaskEvents({ task: found.task, home: bridgeHome() });
  log(found.task.logical_task_key + " auto-publish -> " + JSON.stringify(published));
  let systemMessage = null;
  if (published.status === "published") {
    systemMessage = "飞书桥：本轮答复已自动发布到绑定话题。";
  } else if (published.status === "error") {
    systemMessage = "飞书桥：自动发布失败，本轮答复已保留在待发队列。";
  } else if (published.status === "deferred") {
    systemMessage = "飞书桥：发布器正忙，本轮答复已保留并将在后续回合重试。";
  } else if (published.status === "disabled" && r.ok) {
    systemMessage = "飞书桥：本轮答复已进入本地待发布队列（自动发布尚未启用）。";
  }
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage, suppressOutput: true }) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    log("crashed: " + String(err?.message ?? err));
    process.exit(0);
  });
}
