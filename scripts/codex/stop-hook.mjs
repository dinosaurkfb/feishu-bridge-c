#!/usr/bin/env node
/**
 * Codex Stop：按精确 thread 找 task，把 last_assistant_message 原样入队。
 *
 * 当前合同不允许 Stop 自动发送飞书，所以这里没有 drain/publish 依赖。真实发布只能由
 * scripts/codex/drain-outbox.mjs --apply 在该次明确授权下执行。
 */

import fs from "node:fs";
import path from "node:path";

import { appendEvent, MAX_REPLY_CHARS } from "../outbox.mjs";
import { extractReply } from "../stop-hook.mjs";
import {
  bridgeHome, findTaskForCodexThread, hookLogFile, readThreadActivity, recordThreadActivity, taskPaths,
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
  const reply = extractReply(payload, { maxChars: MAX_REPLY_CHARS });
  if (!reply) {
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
  const r = appendEvent({
    outboxDir: taskPaths(found.task, bridgeHome()).outbox,
    kind: "reply",
    text: reply,
    source: claimKey ? "codex-inbound-reply" : "codex-stop-reply",
    eventKey,
  });
  log(found.task.logical_task_key + " " + (r.ok ? "queued" : r.reason) + " event=" + eventKey);

  // 只告诉本地用户「已入队」，绝不冒充已送达飞书。
  if (r.ok) process.stdout.write(JSON.stringify({
    systemMessage: "飞书桥：本轮答复已进入本地待发布队列（尚未发送）。",
    suppressOutput: true,
  }) + "\n");
}

if (import.meta.url === "file://" + process.argv[1]) {
  main().catch((err) => {
    log("crashed: " + String(err?.message ?? err));
    process.exit(0);
  });
}
