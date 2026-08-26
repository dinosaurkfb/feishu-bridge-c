#!/usr/bin/env node
/** 逐次授权的 Codex outbox 发布入口。默认只预览，只有 --apply 才发送。 */

import { composeDigest } from "../outbox.mjs";
import { publishDraft } from "../outbound.mjs";
import { publishOutboxAttempt } from "../publish-attempt.mjs";
import { codexRotationBatchHook } from "./rotation-hook.mjs";
import { postDeliveryBits } from "../stop-note.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { composeCodexOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import {
  bridgeHome, findTaskForCodexThread, loadRegistry, resolveTask,
  resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

// groupByTargetGeneration 已收归 publish-attempt.mjs（此前四处各抄一份）。

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const home = bridgeHome();
const taskKey = arg("task-key");
const threadId = arg("thread-id");

let task = null;
if (threadId) task = findTaskForCodexThread({ threadId, home }).task ?? null;
if (!task && taskKey) {
  const reg = loadRegistry();
  if (reg.ok) task = reg.tasks.find((t) => t.logical_task_key === taskKey) ?? null;
}
if (!task) {
  console.error("找不到目标 task。必须传精确 --task-key 或 --thread-id；不支持 --last。 ");
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
  console.log("\n[dry-run] 没有发送。确认本次发布后加 --apply。");
} else if (r.status === "published") {
  // 两类发布后缺口共用同一份组合措辞 —— 各写一份就会又漏一类（评审在
  // partial 分支实测漏掉了轮转账缺失）。
  console.log("已由 " + resolved.template.transport_agent_name + " 发布 " + r.count + " 条。" +
    postDeliveryBits(r).replace(/^；/u, "\n"));
  if ((r.deliveredUnrecorded ?? []).length > 0) process.exitCode = 1;
} else if (r.status === "empty") {
  console.log("队列已经由另一个发布动作排空。");
} else if (r.status === "needs_attention") {
  console.error(r.count + " 条已暂停自动重试，等人处理：");
  for (const item of r.rejected ?? []) console.error("  " + item.file + " —— " + item.why);
  process.exitCode = 1;
} else if (r.status === "skipped") {
  console.error("发布器正忙（" + r.reason + "），没有发送。");
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
