#!/usr/bin/env node
/** 逐次授权的 Codex outbox 发布入口。默认只预览，只有 --apply 才发送。 */

import { composeDigest, listPending, markSent } from "../outbox.mjs";
import { publishDraft } from "../outbound.mjs";
import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { composeCodexOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import {
  businessActivitiesForPublishedBatch,
} from "../automatic-topic-rotation.mjs";
import { recordCodexActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";
import {
  bridgeHome, findTaskForCodexThread, loadRegistry, resolveTask,
  resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

const groupByTargetGeneration = (records) => {
  const groups = new Map();
  for (const record of records) {
    const key = record.target_channel_generation_id ?? "__legacy_active__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()];
};

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
const pending = listPending({ outboxDir: paths.outbox });
if (pending.length === 0) {
  console.log(task.task_display_name + " 的 outbox 为空。");
  process.exit(0);
}
const text = composeDigest(pending, { taskName: task.task_display_name });
console.log("task   " + task.task_display_name + "  " + task.logical_task_key);
console.log("身份   " + resolved.template.transport_agent_name + "（单 M5Codex）");
console.log("待发布 " + pending.length + " 条\n\n---\n" + text + "\n---");
if (!apply) {
  console.log("\n[dry-run] 没有发送。确认本次发布后加 --apply。");
  process.exit(0);
}

const lock = acquirePublishLock(paths.publishLock);
if (!lock.ok) {
  console.error("发布器正忙（" + lock.reason + "），没有发送。");
  process.exit(1);
}
try {
  // 锁内重读，防止用户预览后另一个授权动作已经发掉。
  const current = listPending({ outboxDir: paths.outbox });
  if (current.length === 0) {
    console.log("队列已经由另一个发布动作排空。");
  } else {
    const identity = resolveLarkIdentity(resolved.template);
    for (const [targetKey, records] of groupByTargetGeneration(current)) {
      const target = resolveTaskOutboundGeneration(
        task,
        targetKey === "__legacy_active__" ? null : targetKey,
      );
      if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
      for (const batch of outboundCardBatches(records)) {
        const messageId = publishDraft({
          profile: identity.profile,
          rootMessageId: target.rootMessageId,
          card: composeCodexOutboundCard(batch, { taskName: task.task_display_name }),
          larkBin: identity.bin,
          larkHome: identity.configDir,
          expectedAppId: identity.expectedAppId,
        });
        for (const activity of businessActivitiesForPublishedBatch(batch, {
          messageId, runtime: "codex",
        })) {
          recordCodexActivityAndMaybeRotate({
            root: task.root,
            threadId: task.codex_thread_id,
            home,
            generationId: target.channelGenerationId,
            ...activity,
          });
        }
        for (const event of batch) markSent(event, messageId);
      }
    }
    console.log("已由 " + resolved.template.transport_agent_name + " 发布 " + current.length + " 条。");
  }
} catch (err) {
  console.error("发布失败，队列保持未发送：" + err.message);
  process.exitCode = 1;
} finally {
  releasePublishLock(paths.publishLock);
}
