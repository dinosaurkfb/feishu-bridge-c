#!/usr/bin/env node
/** 只读查看当前精确 Codex thread 的飞书连接状态；不输出任何 locator。 */

import { listPending } from "../outbox.mjs";
import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, findRegisteredTaskForCodexThread, taskPaths, topicStateForTask,
  interactionPolicyForTask,
} from "./state.mjs";
import { activeGeneration, pendingGeneration } from "../topic-generation.mjs";
import { interactionPolicySummary } from "../interaction-policy.mjs";
import { collectConnectivity, renderConnectivity } from "../status-providers.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const threadId = arg("thread-id");
if (!validThreadId(threadId)) {
  console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
  process.exit(1);
}

const home = bridgeHome();
const found = findRegisteredTaskForCodexThread({ threadId, home });
if (!found.ok) {
  if (found.reason === "thread_not_registered") {
    console.log("当前 Codex task 尚未接入飞书。");
    // 当前 task 没绑，不该妨碍看别的链路 —— 本机可能还有几条正常运转的，
    // 而"这条没绑"和"本机什么都没有"是两回事。
    const unbound = renderConnectivity(collectConnectivity());
    if (unbound) console.log("\n" + unbound);
    process.exit(0);
  }
  console.error("无法读取连接状态：" + found.reason);
  process.exit(1);
}

const task = found.task;
const active = (task.status ?? "active") === "active";
const pending = listPending({ outboxDir: taskPaths(task, home).outbox }).length;
const topic = topicStateForTask(task);
if (!topic.ok) {
  console.error("无法读取话题代际状态：" + topic.reason);
  process.exit(1);
}
const activeTopic = activeGeneration(topic.state);
const pendingTopic = pendingGeneration(topic.state);
const readOnlyCount = topic.state.generations.filter((generation) => generation.status === "read-only").length;
const interaction = interactionPolicyForTask(task);
if (!interaction.ok) {
  console.error("无法读取交互策略状态：" + interaction.reason);
  process.exit(1);
}
const policy = interactionPolicySummary(interaction.state);
console.log("当前 Codex task：" + (active ? "已接入飞书" : "已暂停飞书接入"));
console.log("当前话题代际：" + (activeTopic ? "第 " + activeTopic.generation + " 代" : "尚未完成首次认领"));
console.log("交互模式：" + policy.label + " · v" + policy.policyVersion);
if (policy.policyId === "dialogue") {
  console.log("对话状态：" + policy.status + (policy.turnActive ? "（有活动回合）" : ""));
  console.log("对话预算：" + policy.roundsStarted + " / " + policy.maxRounds + " 轮；" +
    policy.resourceUnitsUsed + " / " + policy.maxResourceUnits + " 资源单位");
}
if (activeTopic) {
  console.log("自动轮转：" + (activeTopic.activity?.message_count ?? 0) + " / " +
    (activeTopic.activity?.auto_rotate_threshold ?? 30) + " 条有效业务消息");
}
if (pendingTopic) {
  console.log("待认领话题代际：第 " + pendingTopic.generation + " 代" +
    (pendingTopic.claim_expires_at ? "（截止 " + pendingTopic.claim_expires_at + "）" : ""));
}
if (readOnlyCount > 0) {
  console.log("只读历史代际：" + readOnlyCount +
    " 个（不再接收新指令；轮转前受理的结果仍会发回原话题）");
}
console.log("飞书入站：" + (active
  ? (task.inbound_state === "bound" ? "已绑定" : "等待首次真实 @M5Codex")
  : "已暂停"));
console.log("答复发布：" + (active
  ? (task.auto_publish_on_completion === true ? "每轮自动发布（失败时留队）" : "仅入队，自动发布尚未启用")
  : "已暂停"));
console.log("待发布答复：" + pending + " 条" + (active ? "" : "（已保留）"));

// 「我有哪些东西连到了哪些飞书群和话题」两侧问的是同一个问题，
// 没理由只有 Claude 侧答得全。渲染共用同一个，免得两边措辞分叉。
const others = renderConnectivity(collectConnectivity());
if (others) console.log("\n" + others);
