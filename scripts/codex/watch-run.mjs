#!/usr/bin/env node
/** 一次性 watcher：确认 Codex run 终局、兜底入队、按发布合同处理并释放 task 锁。 */

import { readClaim, recordClaimState } from "../claim.mjs";
import {
  recoverEligibilityPending, settleOwnEligibility,
} from "../eligibility-recovery.mjs";
import { releaseSessionLock } from "../handoff.mjs";
import {
  appendEvent, codexReplyEventKey, markPublishEligibleByEventKey, MAX_REPLY_CHARS,
  suppressPublishByEventKey,
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
const eventKey = codexReplyEventKey({ threadId: task.codex_thread_id, claimKey: key });
const acceptedClaim = readClaim({ claimsDir: paths.claims, key });
const targetGenerationId = acceptedClaim?.origin_channel_generation_id ?? null;
// **上一轮卡住的资格，在这里补上。**
//
// 提升取不到发布锁时（publisher_busy）watcher 只记一个 eligibility_pending 就退了；
// 没人消费的话那条答复再没有任何路径获得资格。
// **必须在拿发布锁之前跑** —— 它内部要拿那把锁，锁内调会自己卡死自己。
const recovered = recoverEligibilityPending({
  claimsDir: paths.claims, outboxDir: paths.outbox,
  publishLockDir: paths.publishLock, threadId: task.codex_thread_id });
if (!recovered.ok) {
  // 读不出 claims 目录跟"一条都没有"长得一样，含义却相反 —— 说出来。
  console.error("claims 目录读不出来（" + recovered.reason + "），这一轮没法确认有没有卡住的资格。");
} else {
  for (const r of recovered.recovered) console.error("补回发布资格：" + r.key + "（" + r.reason + "）");
  for (const r of recovered.pending) console.error("资格仍卡住：" + r.key + "（" + r.reason + "）");
  for (const r of recovered.unusable) console.error("恢复标记看不懂，没动：" + r.key + " —— " + r.unusable);
}

/**
 * 等资格的预算。默认 60 秒 —— 竞争方持锁做真实网络发布默认可达 12 秒，
 * 留足余量。**只接受非负整数**，写错就用默认值：一个看不懂的值不该
 * 静默变成"零预算"，那会把这条恢复路径悄悄关掉。
 */
const eligibilityBudgetMs = (() => {
  const raw = process.env.FEISHU_BRIDGE_ELIGIBILITY_BUDGET_MS;
  if (raw === undefined) return 60_000;
  return /^\d+$/u.test(raw) ? Number(raw) : 60_000;
})();

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
      // **自己新加的失败模式，得自己接住 —— 而且要接到有结论为止。**
      //
      // 加锁之后 publisher_busy 成了真实路径：这里只重试约 720ms，
      // 竞争方却会持锁做真实网络发布，默认可达 12 秒。
      // 光记一个 eligibility_pending 就退出是不够的 —— 那要等到**下一条入站消息**
      // 触发下一个 watcher 才会被扫到，中间这条答复一直卡着。
      let settled = promoted;
      if (!promoted.ok) {
        // 先落标记：先写证据再重试，中途崩掉也还有人能接着管。
        recordClaimState({
          claimsDir: paths.claims, key, state: "eligibility_pending",
          detail: { run_state: "completed", promote_failed: promoted.reason ?? "unknown",
            event_key: eventKey },
        });
        // 自己扫到有结论为止。只对 publisher_busy 重试 —— 别的失败多等也不会变好。
        // 标记不在了要去问记录本身：可能是另一个恢复器先做完了。
        const settled_ = settleOwnEligibility({
          claimsDir: paths.claims, outboxDir: paths.outbox,
          publishLockDir: paths.publishLock, threadId: task.codex_thread_id, claimKey: key,
          budgetMs: eligibilityBudgetMs,
        });
        // **报出来的原因要是复查之后的原因。**只认 recovered 的话，
        // 复查时变成 event_not_found / record_unclassified / claims_unreadable，
        // 最终仍会照最初那个 publisher_busy 去报告。
        settled = settled_;
      }
      if (!settled.ok) {
        // **真实原因要说出来。**只渲染 reason 的话最终只会说 marker_unusable，
        // 而人真正需要知道的是"缺 event_key"这种具体的那句。
        const why = (settled.reason ?? "说不清") + (settled.why ? "：" + settled.why : "");
        appendEvent({
          outboxDir: paths.outbox, kind: "risk",
          text: task.task_display_name + " 的这一轮答复已经跑完，但没能取得发布资格（" +
            why + "）。**它不会自动发出去**，需要人看一眼。",
          source: "codex-run-watcher",
          eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":promote-failed",
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
