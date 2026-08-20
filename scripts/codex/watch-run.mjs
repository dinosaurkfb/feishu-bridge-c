#!/usr/bin/env node
/** 一次性 watcher：确认 Codex run 终局、兜底入队、按发布合同处理并释放 task 锁。 */

import { recordClaimState } from "../claim.mjs";
import { releaseSessionLock } from "../handoff.mjs";
import {
  appendEvent, markPublishEligibleByEventKey, MAX_REPLY_CHARS, suppressPublishByEventKey,
} from "../outbox.mjs";
import { readCodexRunOutcome } from "./handoff.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import { bridgeHome, loadRegistry, taskPaths } from "./state.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const key = arg("claim-key");
const taskKey = arg("task-key");
if (!key || !taskKey) {
  console.error("usage: watch-run.mjs --claim-key <key> --task-key <key>");
  process.exit(2);
}

const home = bridgeHome();
const reg = loadRegistry();
const task = reg.ok ? reg.tasks.find((t) => t.logical_task_key === taskKey) : null;
if (!task) {
  console.error("task not found");
  process.exit(2);
}
const paths = taskPaths(task, home);
const run = {
  logPath: paths.runs + "/" + key + ".jsonl",
  exitPath: paths.runs + "/" + key + ".exit.json",
  errPath: paths.runs + "/" + key + ".stderr.log",
  lastMessagePath: paths.runs + "/" + key + ".last-message.txt",
};
const eventKey = "codex:" + task.codex_thread_id + ":claim:" + key + ":reply";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;
let releaseLock = true;

const failureLabel = (outcome) => {
  const diagnostic = {
    git_repository_required: "工作目录未通过 Codex Git 仓库检查",
    session_not_found: "Codex 找不到绑定的 session",
    hook_trust_required: "Codex hook 尚未取得信任",
  }[outcome.diagnostic];
  return diagnostic ? outcome.reason + "：" + diagnostic : outcome.reason;
};

try {
  while (Date.now() - started <= MAX_WAIT_MS) {
    const outcome = readCodexRunOutcome({ ...run, expectedThreadId: task.codex_thread_id });
    if (outcome.state === "running") {
      await sleep(4000);
      continue;
    }

    if (outcome.state === "completed") {
      // 正常主路径是 Stop hook 入队。若 hook 未信任、未安装或崩了，runner 留下的最后消息
      // 是确定性兜底；与 Stop 使用同一 event key，所以无论谁先写都只会有一条。
      // appendEvent 会在所有 outbox 文件（含已发布记录）上按 event key 去重，避免「Stop 已入队、
      // 人工刚好先发布、watcher 又补一条」的竞态。
      appendEvent({
        outboxDir: paths.outbox,
        kind: "reply",
        text: outcome.finalText.length <= MAX_REPLY_CHARS
          ? outcome.finalText
          : outcome.finalText.slice(0, MAX_REPLY_CHARS) + "\n…（本条已截断，全文保留在本机 run 记录）",
        source: "codex-run-watcher-fallback",
        eventKey,
      });
      // Stop 只保存入站答复；四项终局证据齐全后，watcher 才允许它自动发布。
      markPublishEligibleByEventKey({ outboxDir: paths.outbox, eventKey });
      publishEligibleTaskEvents({ task, home });
      recordClaimState({
        claimsDir: paths.claims,
        key,
        state: "completed",
        detail: { run_state: "completed", recoverable_error_events: outcome.recoverableErrors ?? 0 },
      });
      process.exitCode = 0;
      break;
    }

    // Stop 可能已经保存了一段未通过严格终局校验的答复；保留证据但永久移出发布队列。
    suppressPublishByEventKey({ outboxDir: paths.outbox, eventKey, reason: outcome.reason });
    const reasonText = failureLabel(outcome);
    appendEvent({
      outboxDir: paths.outbox,
      kind: "risk",
      text: task.task_display_name + " 的飞书指令执行失败（" + reasonText + "），任务没有完成。",
      source: "codex-run-watcher",
      eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":failure",
      publishEligible: task.auto_publish_on_completion === true,
    });
    publishEligibleTaskEvents({ task, home });
    recordClaimState({
      claimsDir: paths.claims,
      key,
      state: "failed",
      detail: { run_state: outcome.state, reason: outcome.reason, diagnostic: outcome.diagnostic ?? null },
    });
    process.exitCode = 1;
    break;
  }

  if (Date.now() - started > MAX_WAIT_MS) {
    // watcher 自己超时不等于 Codex runner 已退出。此时保留 session lock，让下一条入站通过
    // owner pid 探活继续 fail-closed；直接放锁会允许两个 resume 并发踩同一 thread。
    releaseLock = false;
    suppressPublishByEventKey({ outboxDir: paths.outbox, eventKey, reason: "watch_timeout" });
    appendEvent({
      outboxDir: paths.outbox,
      kind: "risk",
      text: task.task_display_name + " 的飞书指令超过本地 watcher 四小时观察窗口；runner 可能仍在执行，目标 task 继续保持锁定。",
      source: "codex-run-watcher",
      eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":watch-timeout",
      publishEligible: task.auto_publish_on_completion === true,
    });
    publishEligibleTaskEvents({ task, home });
    recordClaimState({
      claimsDir: paths.claims,
      key,
      state: "handed_off",
      detail: { observation_state: "watch_timeout", runner_may_be_active: true },
    });
    process.exitCode = 1;
  }
} finally {
  if (releaseLock) releaseSessionLock(paths.sessionLock);
}
