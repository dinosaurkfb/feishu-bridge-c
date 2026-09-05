#!/usr/bin/env node
/** 一次性 watcher：确认 Codex run 终局、兜底入队、按发布合同处理并释放 task 锁。 */

import { CLAIM_KEY_SHAPE, readClaimState, recordClaimState } from "../claim.mjs";
import { eligibilityBudgetMs } from "../eligibility-recovery.mjs";
import { settleEligibilityPending, settleOwnEligibility } from "./eligibility-recovery.mjs";
import { releaseSessionLock } from "../handoff.mjs";
import {
  appendEvent, codexReplyEventKey, markPublishEligibleByEventKey, MAX_REPLY_CHARS,
  suppressPublishByEventKey,
} from "../outbox.mjs";
import { verifyCodexRunCredential } from "./handoff.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import { bridgeHome, finalizeTaskDialogueTurn, loadRegistry, taskPaths } from "./state.mjs";
import { DIALOGUE_POLICY_ID, DIALOGUE_TURN_STATUS, normalizeFinalReason } from "../interaction-policy.mjs";

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
// key 形状先验：三件 run 制品的路径全从它派生，形状不对就没有可验的凭据。
if (!CLAIM_KEY_SHAPE.test(key)) {
  console.error("--claim-key 不是 claim key 的形状");
  process.exit(2);
}

const home = bridgeHome();
const reg = loadRegistry();

/**
 * #R38 P1-2：终局写的守卫包装 —— 动态 reason 先过 normalizeFinalReason（与 Claude watcher
 * 同一判据），返回值必须被消费：写失败时 risk 入队、session lock 保留（fail-closed 探活）、
 * 退出码置 1 —— 决不许“写不进也照常放锁”让 active turn 留在账上没人管。
 * 返回 finalize 的结果（调用方可用于断言），失败时也返回（调用方不必再分支）。
 */
const finalizeGuarded = ({ task, runId, status, reason, paths, label }) => {
  const fin = finalizeTaskDialogueTurn({
    threadId: task.codex_thread_id,
    runId,
    status,
    reason: normalizeFinalReason(status, reason),
    home,
  });
  if (!fin.ok) {
    try {
      appendEvent({
        outboxDir: paths.outbox,
        kind: "risk",
        text: task.task_display_name + " 的这一轮 " + label + "终局状态没写进 task 状态（" +
          (fin.reason ?? "说不清") + (fin.why ? "：" + fin.why : "") + "）。active turn 还留在账上，" +
          "session lock 保留 —— 需要人看一眼，别直接删锁。",
        source: "codex-run-watcher",
        eventKey: "codex:" + task.codex_thread_id + ":claim:" + runId + ":finalize-failed",
      });
    } catch (err) {
      console.error("risk 没发出去：" + String(err?.message ?? err).slice(0, 200));
    }
    releaseLock = false;
    process.exitCode = 1;
  }
  return fin;
};

const task = reg.ok ? reg.tasks.find((t) => t.logical_task_key === taskKey) : null;
if (!task) {
  console.error("task not found");
  process.exit(2);
}
const paths = taskPaths(task, home);
// run 制品路径不在这里拼 —— 由验真入口从 runsDir + key 派生（防跨 run 拼装）。
const eventKey = codexReplyEventKey({ threadId: task.codex_thread_id, claimKey: key });
// **claim 三态：说不清来源代际就不猜。**上一版 null 一律当 legacy 现算当前代际 ——
// 一张缺席/损坏的 claim 会把这一轮结果发到"现在的"话题，而不是它来自的那个。
// 结果不自动发布、留 risk、session lock 保留（runner 可能还活着，交给陈旧检测）。
const claimState = readClaimState({ claimsDir: paths.claims, key,
  expect: { logicalTaskKey: task.logical_task_key, codexThreadId: task.codex_thread_id } });
if (claimState.status !== "valid") {
  const why = claimState.status === "absent" ? "claim 缺席" : "claim 读不出来：" + claimState.why;
  console.error("这一轮的 claim 说不清（" + why + "），结果不会自动发布；session lock 保留。");
  // **failed 记录先落、单独落** —— 它是留给恢复/人工的证据，不能因为 outbox 不可写
  // 或发布路径抛错而一起丢。risk 入队与发布再分别尽力。
  try {
    recordClaimState({ claimsDir: paths.claims, key, state: "failed",
      detail: { reason: "claim_unreadable", why } });
  } catch (err) {
    console.error("failed 记录没落成：" + String(err?.message ?? err).slice(0, 200));
  }
  try {
    // risk 走这个 task **当前**的话题（task 级告警，跟失败/超时分支同一语义）——
    // 它不是 run 的结果，来源代际说不清不影响"告诉人这一轮出了问题"。
    appendEvent({
      outboxDir: paths.outbox, kind: "risk",
      text: task.task_display_name + " 的这一轮投递 claim 说不清（" + why +
        "）。**它的结果不会自动发出去**，需要人看一眼。",
      source: "codex-run-watcher",
      eventKey: "codex:" + task.codex_thread_id + ":claim:" + key + ":claim-unreadable",
      publishEligible: task.auto_publish_on_completion === true,
      runId: key,
    });
  } catch (err) {
    console.error("risk 没入队：" + String(err?.message ?? err).slice(0, 200));
  }
  try { publishEligibleTaskEvents({ task, home }); }
  catch (err) { console.error("risk 没发出去：" + String(err?.message ?? err).slice(0, 200)); }
  process.exit(2);
}
const acceptedClaim = claimState.claim;
const targetGenerationId = acceptedClaim.origin_channel_generation_id ?? null;
// **上一轮卡住的资格，在这里补上 —— 而且要等到有结论。**
//
// 提升取不到发布锁时（publisher_busy）watcher 只记一个 eligibility_pending 就退了；
// 没人消费的话那条答复再没有任何路径获得资格。
//
// **这里必须用有界的那个消费者，不能只扫一次。**评审实测：只扫一次时，
// 启动这一刻若撞上 publisher_busy，而随后这一轮**自己**的资格直接拿到了成功，
// 就再也不会进 settleOwnEligibility 那个分支 —— 旧标记继续留着、旧答复仍无资格，
// 若没有下一条入站消息，就再无消费者。
// 共用截止时间只保护"自己刚写的标记"，保护不了历史标记。
//
// **必须在拿发布锁之前跑** —— 它内部要拿那把锁，锁内调会自己卡死自己。
const recovered = settleEligibilityPending({
  claimsDir: paths.claims, outboxDir: paths.outbox, runsDir: paths.runs,
  publishLockDir: paths.publishLock, threadId: task.codex_thread_id,
  budgetMs: eligibilityBudgetMs(process.env.FEISHU_BRIDGE_ELIGIBILITY_BUDGET_MS) });
if (!recovered.ok) {
  // 读不出 claims 目录跟"一条都没有"长得一样，含义却相反 —— 说出来。
  console.error("claims 目录读不出来（" + recovered.reason + "），这一轮没法确认有没有卡住的资格。");
} else {
  for (const r of recovered.recovered) console.error("补回发布资格：" + r.key + "（" + r.reason + "）");
  for (const r of recovered.pending) {
    console.error("资格仍卡住：" + r.key + "（" + r.reason + (r.why ? "：" + r.why : "") + "）");
  }
  for (const r of recovered.unusable) console.error("恢复标记看不懂，没动：" + r.key + " —— " + r.unusable);
}

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
    // **授权凭据验真**：退出回执身份/封闭 schema + JSONL 终局 + 最终输出，合起来才算完成。
    const outcome = verifyCodexRunCredential({
      runsDir: paths.runs, claimKey: key, expectedThreadId: task.codex_thread_id });
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
      // **requireRunId 在初始路径也必须带** —— 评审实测这里漏传：event key 命中的记录
      // 若 run_id 是别的 claim（Stop 侧入队时写错），资格照样发给了它。
      const promoted = markPublishEligibleByEventKey({
        outboxDir: paths.outbox, eventKey, publishLockDir: paths.publishLock,
        requireRunId: key });
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
          claimsDir: paths.claims, outboxDir: paths.outbox, runsDir: paths.runs,
          publishLockDir: paths.publishLock, threadId: task.codex_thread_id, claimKey: key,
          // 预算解析只有一份判据 —— 有限安全整数、有上限、不合规回落默认值。
          budgetMs: eligibilityBudgetMs(process.env.FEISHU_BRIDGE_ELIGIBILITY_BUDGET_MS),
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
        // #R38 P1-2：completed 同样消费返回值 —— 写失败不放锁、退出码置 1（不说谎报成功）。
        finalizeGuarded({ task, runId: key, status: DIALOGUE_TURN_STATUS.COMPLETED, reason: null, paths, label: "完成" });
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
      // #R38 P1-2：outcome.reason 是 runner 侧动态字符串（nonzero_exit / turn_failed /
      // artifact_unreadable 等），不在纯终局枚举里 —— 归一化后交给 finalize，且**必须消费返回值**：
      // 写失败不再静默放锁（旧版 active turn 留账、锁照放，下一条入站会踩一个状态说不清的 thread）。
      finalizeGuarded({ task, runId: key, status: DIALOGUE_TURN_STATUS.FAILED, reason: outcome.reason, paths, label: "失败" });
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
      // #R38 P1-2：timeout 分支本来就保留 session lock（releaseLock 已 false），
      // 这里消费返回值是为了写失败时多一条说人话的 risk —— 账留没留上要说出来。
      finalizeGuarded({ task, runId: key, status: DIALOGUE_TURN_STATUS.FAILED, reason: "watch_timeout", paths, label: "超时" });
    }
    process.exitCode = 1;
  }
} finally {
  if (releaseLock) releaseSessionLock(paths.sessionLock);
}
