#!/usr/bin/env node
/** 一次性 watcher：确认 Codex run 终局、兜底入队、按发布合同处理并释放 task 锁。 */

import { readClaim, recordClaimState } from "../claim.mjs";
import { recoverEligibilityPending } from "../eligibility-recovery.mjs";
import { releaseSessionLock } from "../handoff.mjs";
import {
  appendEvent, markPublishEligibleByEventKey, MAX_REPLY_CHARS, suppressPublishByEventKey,
} from "../outbox.mjs";
import { readCodexRunOutcome } from "./handoff.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import { bridgeHome, finalizeTaskDialogueTurn, loadRegistry, taskPaths } from "./state.mjs";
import { DIALOGUE_POLICY_ID, DIALOGUE_TURN_STATUS } from "../interaction-policy.mjs";

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
const acceptedClaim = readClaim({ claimsDir: paths.claims, key });
const targetGenerationId = acceptedClaim?.origin_channel_generation_id ?? null;
// **上一轮卡住的资格，在这里补上。**
//
// 提升取不到发布锁时（publisher_busy）watcher 只记一个 eligibility_pending 就退了；
// 没人消费的话那条答复再没有任何路径获得资格。
// **必须在拿发布锁之前跑** —— 它内部要拿那把锁，锁内调会自己卡死自己。
const recovered = recoverEligibilityPending({
  claimsDir: paths.claims, outboxDir: paths.outbox, publishLockDir: paths.publishLock });
for (const r of recovered.recovered) console.error("补回发布资格：" + r.key + "（" + r.reason + "）");
for (const r of recovered.pending) console.error("资格仍卡住：" + r.key + "（" + r.reason + "）");
for (const r of recovered.unusable) console.error("恢复标记看不懂，没动：" + r.key + " —— " + r.unusable);

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
  if (outcome.reason === "bridge_recursion") return "bridge_recursion：目标 task 错误地再次进入飞书入站路由";
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
        targetGenerationId,
        runId: key,
      });
      // Stop 只保存入站答复；四项终局证据齐全后，watcher 才允许它自动发布。
      // **锁是必需的**：资格提升跟抑制改的是同一条记录的语义，
      // 不共用一把锁就会出现"抑制读完快照、写回之前资格被改掉"的窗口。
      const promoted = markPublishEligibleByEventKey({
        outboxDir: paths.outbox, eventKey, publishLockDir: paths.publishLock });
      // **自己新加的失败模式，得自己接住。**
      // 加锁之后 publisher_busy 成了真实路径 —— 忽略它的话，
      // 这一轮会被记成 completed，而那条答复再没有任何路径获得资格。
      if (!promoted.ok) {
        appendEvent({
          outboxDir: paths.outbox, kind: "risk",
          text: task.task_display_name + " 的这一轮答复已经跑完，但没能取得发布资格（" +
            (promoted.reason ?? "说不清") + "）。**它不会自动发出去**，需要人看一眼。",
          source: "codex-run-watcher",
          eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":promote-failed",
        });
        recordClaimState({
          claimsDir: paths.claims, key, state: "eligibility_pending",
          detail: { run_state: "completed", promote_failed: promoted.reason ?? "unknown",
            event_key: eventKey },
        });
        process.exitCode = 1;
        break;
      }
      publishEligibleTaskEvents({ task, home });
      recordClaimState({
        claimsDir: paths.claims,
        key,
        state: "completed",
        detail: { run_state: "completed", recoverable_error_events: outcome.recoverableErrors ?? 0 },
      });
      if (acceptedClaim?.policy_id === DIALOGUE_POLICY_ID) {
        finalizeTaskDialogueTurn({
          threadId: task.codex_thread_id,
          runId: key,
          status: DIALOGUE_TURN_STATUS.COMPLETED,
          home,
        });
      }
      process.exitCode = 0;
      break;
    }

    // Stop 可能已经保存了一段未通过严格终局校验的答复；保留证据但永久移出发布队列。
    const stopped = suppressPublishByEventKey({ outboxDir: paths.outbox, eventKey,
      reason: outcome.reason, publishLockDir: paths.publishLock });
    // **没停成就得说出来。**半成品答复留在队列里会被下一轮发出去。
    // event_not_found 是"本来就没有要停的东西"（Stop 还没入队）—— 那是常态，不是故障。
    if (!stopped.ok
        && !["already_published", "event_not_found", "no_event_key"].includes(stopped.reason)) {
      appendEvent({
        outboxDir: paths.outbox, kind: "risk",
        text: task.task_display_name + " 的失败答复没能移出发布队列（" +
          (stopped.reason ?? "说不清") + "）——**它可能被发出去**，需要人看一眼。",
        source: "codex-run-watcher",
        eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":suppress-failed-" + "a",
      });
    }
    const reasonText = failureLabel(outcome);
    appendEvent({
      outboxDir: paths.outbox,
      kind: "risk",
      text: task.task_display_name + " 的飞书指令执行失败（" + reasonText + "），任务没有完成。",
      source: "codex-run-watcher",
      eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":failure",
      publishEligible: task.auto_publish_on_completion === true,
      targetGenerationId,
      runId: key,
    });
    publishEligibleTaskEvents({ task, home });
    recordClaimState({
      claimsDir: paths.claims,
      key,
      state: "failed",
      detail: { run_state: outcome.state, reason: outcome.reason, diagnostic: outcome.diagnostic ?? null },
    });
    if (acceptedClaim?.policy_id === DIALOGUE_POLICY_ID) {
      finalizeTaskDialogueTurn({
        threadId: task.codex_thread_id,
        runId: key,
        status: DIALOGUE_TURN_STATUS.FAILED,
        reason: outcome.reason,
        home,
      });
    }
    process.exitCode = 1;
    break;
  }

  if (Date.now() - started > MAX_WAIT_MS) {
    // watcher 自己超时不等于 Codex runner 已退出。此时保留 session lock，让下一条入站通过
    // owner pid 探活继续 fail-closed；直接放锁会允许两个 resume 并发踩同一 thread。
    releaseLock = false;
    const stoppedTimeout = suppressPublishByEventKey({ outboxDir: paths.outbox, eventKey,
      reason: "watch_timeout", publishLockDir: paths.publishLock });
    // **没停成就得说出来。**半成品答复留在队列里会被下一轮发出去。
    // event_not_found 是"本来就没有要停的东西"（Stop 还没入队）—— 那是常态，不是故障。
    if (!stoppedTimeout.ok
        && !["already_published", "event_not_found", "no_event_key"].includes(stoppedTimeout.reason)) {
      appendEvent({
        outboxDir: paths.outbox, kind: "risk",
        text: task.task_display_name + " 的失败答复没能移出发布队列（" +
          (stoppedTimeout.reason ?? "说不清") + "）——**它可能被发出去**，需要人看一眼。",
        source: "codex-run-watcher",
        eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":suppress-failed-" + "b",
      });
    }
    appendEvent({
      outboxDir: paths.outbox,
      kind: "risk",
      text: task.task_display_name + " 的飞书指令超过本地 watcher 四小时观察窗口；runner 可能仍在执行，目标 task 继续保持锁定。",
      source: "codex-run-watcher",
      eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":watch-timeout",
      publishEligible: task.auto_publish_on_completion === true,
      targetGenerationId,
      runId: key,
    });
    publishEligibleTaskEvents({ task, home });
    recordClaimState({
      claimsDir: paths.claims,
      key,
      state: "handed_off",
      detail: { observation_state: "watch_timeout", runner_may_be_active: true },
    });
    if (acceptedClaim?.policy_id === DIALOGUE_POLICY_ID) {
      finalizeTaskDialogueTurn({
        threadId: task.codex_thread_id,
        runId: key,
        status: DIALOGUE_TURN_STATUS.FAILED,
        reason: "watch_timeout",
        home,
      });
    }
    process.exitCode = 1;
  }
} finally {
  if (releaseLock) releaseSessionLock(paths.sessionLock);
}
