#!/usr/bin/env node
/**
 * 逐次授权的 Codex outbox 发布入口。默认只预览，只有 --apply 才发送。
 *
 * **落盘必须带回预览打印的计划摘要**（--expect-digest，第 4 层）：
 * 摘要绑「预览所见文件字节集合 + 解析后目标（代际/根消息）」——
 * 预览之后 outbox 变了、或话题轮转把目标换掉了，旧摘要都会作废。
 * 摘要的算法与核对都在发布事务里；这里只解析和显示，不自己判。
 */

import path from "node:path";

import { composeDigest } from "../outbox.mjs";
import { publishDraft } from "../outbound.mjs";
import { publishOutboxAttempt } from "../publish-attempt.mjs";
import { codexRotationBatchHook } from "./rotation-hook.mjs";
import { postDeliveryBits } from "../publish-outcome.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { composeCodexOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import { isDirectRun, moduleDir } from "../direct-run.mjs";
import { nodeCommandPrefix, shellQuote } from "../shell-quote.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";
import {
  bridgeHome, findTaskForCodexThread, loadRegistry, resolveTask,
  resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

// groupByTargetGeneration 已收归 publish-attempt.mjs（此前四处各抄一份）。

/**
 * 严格白名单（形状照抄 suppress-outbox）——
 * **这个入口会真的发消息**，拼错的参数不许被执行成另一种操作。
 */
const FLAGS = new Set(["apply"]);
const OPTIONS = new Set(["task-key", "thread-id", "expect-digest"]);

export function parseArgs(tokens) {
  const seen = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (typeof t !== "string" || !t.startsWith("--")) {
      return { ok: false, reason: "unexpected_argument", detail: t };
    }
    const name = t.slice(2);
    if (seen.has(name)) return { ok: false, reason: "duplicate_option", detail: t };
    if (FLAGS.has(name)) { seen.set(name, true); continue; }
    if (!OPTIONS.has(name)) return { ok: false, reason: "unknown_option", detail: t };
    const value = tokens[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      return { ok: false, reason: "option_needs_value", detail: t };
    }
    seen.set(name, value);
    i += 1;
  }
  return { ok: true, seen };
}

/**
 * 参数之间的硬约束。目标必须且只能给一个 —— 曾经的写法是静默择一，
 * 「少说一句话就换一个目标」对一个会发消息的入口不可接受。
 * --expect-digest 只属于落盘：预览不收它 —— 收了会让人以为预览也在核对什么。
 */
export function checkArgShape(seen) {
  const hasThread = seen.has("thread-id");
  const hasKey = seen.has("task-key");
  if (hasThread && hasKey) return { ok: false, reason: "target_ambiguous" };
  if (!hasThread && !hasKey) return { ok: false, reason: "target_missing" };
  if (seen.has("expect-digest") && !seen.has("apply")) {
    return { ok: false, reason: "expect_digest_without_apply" };
  }
  return { ok: true };
}

const ARG_ERRORS = {
  unexpected_argument: "不认识的参数形式",
  duplicate_option: "参数重复",
  unknown_option: "不认识的参数（白名单：--task-key / --thread-id / --apply / --expect-digest）",
  option_needs_value: "参数缺值",
  target_ambiguous: "--task-key 和 --thread-id 只能给一个",
  target_missing: "必须传精确 --task-key 或 --thread-id；不支持 --last。",
  expect_digest_without_apply: "--expect-digest 只跟 --apply 一起用 —— 预览会打印它的值。",
};

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed && parsed.seen instanceof Set && parsed.seen.has("apply")) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）
  const shape = parsed.ok ? checkArgShape(parsed.seen) : parsed;
  if (!parsed.ok || !shape.ok) {
    const r = parsed.ok ? shape : parsed;
    console.error("参数不对（" + r.reason + "）：" +
      (ARG_ERRORS[r.reason] ?? "") + (r.detail ? "（" + r.detail + "）" : ""));
    process.exit(1);
  }
  const seen = parsed.seen;
  const apply = seen.get("apply") === true;
  const home = bridgeHome();
  const taskKey = seen.get("task-key") ?? null;
  const threadId = seen.get("thread-id") ?? null;

  let task = null;
  if (threadId) task = findTaskForCodexThread({ threadId, home }).task ?? null;
  if (!task && taskKey) {
    const reg = loadRegistry();
    if (reg.ok) task = reg.tasks.find((t) => t.logical_task_key === taskKey) ?? null;
  }
  if (!task) {
    console.error("找不到目标 task。" + ARG_ERRORS.target_missing);
    process.exit(1);
  }

  const resolved = resolveTask(task, { home });
  if (!resolved.ok) {
    console.error("task 配置不可用：" + resolved.reason);
    process.exit(1);
  }
  if (resolved.mapping.status !== "active" || !resolved.mapping.feishu_root_message_id_reference) {
    console.error("task 的飞书绑定不是 active，拒绝发送。");
    process.exit(1);
  }

  const paths = taskPaths(task, home);

  // **预览也走事务。**上一版在事务前用宽松的 listPending 出预览、空队列直接退 ——
  // 评审实测：outbox 只有坏 JSON 时 dry-run 和 --apply 都说"为空" exit 0；
  // 混着坏文件时预览照给、--apply 才被事务拒 —— **预览与执行结论不一致**，
  // 而预览正是人做决定的那一步。现在两条路都从事务的同一份快照出结果。
  const identity = resolveLarkIdentity(resolved.template);
  const r = publishOutboxAttempt({
    outboxDir: paths.outbox,
    lockDir: paths.publishLock,
    policy: "all_unpaused",
    dryRun: !apply,
    // 这是逐次授权的人工入口：落盘必须带回预览摘要。开关在这里、判据在事务 ——
    // CLI 不许自己决定"可不可以不给"。
    manualPlan: true,
    expectPlanDigest: apply ? (seen.get("expect-digest") ?? null) : null,
    batchCards: outboundCardBatches,
    resolveTarget: (generationKey) => resolveTaskOutboundGeneration(task, generationKey),
    composeCard: (batch) => composeCodexOutboundCard(batch, { taskName: task.task_display_name }),
    publishBatch: ({ target, card }) => publishDraft({
      profile: identity.profile,
      rootMessageId: target.rootMessageId,
      card,
      larkBin: identity.bin,
      larkHome: identity.configDir,
      expectedAppId: identity.expectedAppId,
    }),
    onBatchPublished: codexRotationBatchHook({
      root: task.root, threadId: task.codex_thread_id, home,
    }),
  });
  if (r.status === "dry_run") {
    const text = composeDigest(r.selected, { taskName: task.task_display_name });
    console.log("task   " + task.task_display_name + "  " + task.logical_task_key);
    console.log("身份   " + resolved.template.transport_agent_name + "（单 M5Codex）");
    console.log("待发布 " + r.count + " 条（" + r.batches.length + " 张卡）\n\n---\n" + text + "\n---");
    // **打印完整可执行命令**：含脚本路径与 selector，过 shellQuote。
    // 提示指向的操作做不到它说的事 —— 这个坑踩过不止一次，所以整条给全。
    const selector = threadId !== null
      ? " --thread-id " + shellQuote(threadId)
      : " --task-key " + shellQuote(taskKey);
    console.log("\n[dry-run] 没有发送。确认本次发布（内容与目标话题）后执行：");
    console.log("  " + nodeCommandPrefix(path.join(moduleDir(import.meta.url), "drain-outbox.mjs")) +
      selector + " --apply --expect-digest " + r.planDigest);
  } else if (r.status === "published") {
    // 两类发布后缺口共用同一份组合措辞 —— 各写一份就会又漏一类（评审在
    // partial 分支实测漏掉了轮转账缺失）。
    console.log("已由 " + resolved.template.transport_agent_name + " 发布 " + r.count + " 条。" +
      postDeliveryBits(r).replace(/^；/u, "\n"));
    // **任一发布后缺口非空都要非零退出** —— 只查落标缺口的话，
    // 纯轮转账缺失会被当成完整成功（评审实测 exit 0）。
    if ((r.deliveredUnrecorded ?? []).length > 0 || (r.bookkeepingFailures ?? []).length > 0) {
      process.exitCode = 1;
    }
  } else if (r.status === "empty") {
    // 不推断原因 —— 正常空队列的 dry-run 也走这里，"被别人排空"是猜的。
    console.log(task.task_display_name + " 的 outbox 为空。");
  } else if (r.status === "needs_attention") {
    console.error(r.count + " 条已暂停自动重试，等人处理：");
    for (const item of r.rejected ?? []) console.error("  " + item.file + " —— " + item.why);
    process.exitCode = 1;
  } else if (r.status === "skipped") {
    console.error("发布器正忙（" + r.reason + "），没有发送。");
    process.exitCode = 1;
  } else if (r.status === "error" && r.reason === "plan_expectation_required") {
    console.error("落盘必须带 --apply --expect-digest <预览打印的摘要>。\n" +
      "先跑预览（不带 --apply），核对内容与目标话题，再原样带回它打印的命令。");
    process.exitCode = 1;
  } else if (r.status === "error" && r.reason === "plan_changed") {
    console.error("预览之后 outbox 或目标话题变了，旧摘要已作废 —— 一张都没发。\n" +
      "重新预览、重新核对后再落盘。（预览摘要 " + r.expected + "，当前 " + r.actual + "）");
    process.exitCode = 1;
  } else if (r.status === "error" && r.local === true) {
    console.error("本地 outbox 有问题（" + (r.reason ?? "说不清") +
      ((r.files ?? []).length ? "：" + r.files.join("、") : "") + "）—— 整批没动，这不是飞书故障。");
    process.exitCode = 1;
  } else {
    console.error("发布失败，队列保持未发送：" + (r.error ?? r.reason) +
      ((r.partial === true) ? "\n（失败前已送达 " + (r.messageIds ?? []).length + " 张，已落标的不会重发）" : "") +
      postDeliveryBits(r) +
      ((r.markedRejected ?? []).length > 0 ? "\n这几条已暂停自动重试：" + r.markedRejected.join("、") : ""));
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
