#!/usr/bin/env node
/** 查看或显式切换当前精确 Codex task 的 Interaction Policy。 */

import {
  DIALOGUE_POLICY_ID, MAPPING_POLICY_ID, interactionPolicySummary,
} from "../interaction-policy.mjs";
import { validThreadId } from "./bind-compose.mjs";
import { isDirectRun } from "../direct-run.mjs";
import {
  bridgeHome, findRegisteredTaskForCodexThread, interactionPolicyForTask,
  setTaskInteractionMode,
} from "./state.mjs";
import { buildIntentParams, requireIntent } from "./intent.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

export function describeCodexInteractionPolicy(state) {
  const summary = interactionPolicySummary(state);
  if (!summary.ok) return "交互策略状态不可用（" + summary.reason + "）。";
  const lines = ["当前模式：" + summary.label + " · v" + summary.policyVersion];
  if (summary.policyId === DIALOGUE_POLICY_ID) {
    lines.push("对话状态：" + summary.status);
    lines.push("轮次预算：" + summary.roundsStarted + " / " + summary.maxRounds);
    lines.push("资源预算：" + summary.resourceUnitsUsed + " / " + summary.maxResourceUnits);
    lines.push("截止时间：" + summary.deadlineAt);
    lines.push("活动回合：" + (summary.turnActive ? "有（新输入会被拒绝）" : "无"));
    if (summary.stopReason) lines.push("停止原因：" + summary.stopReason);
  }
  return lines.join("\n");
}

function main() {
  const threadId = arg("thread-id");
  if (!validThreadId(threadId)) {
    console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
    process.exit(1);
  }
  const mode = arg("mode");
  if (mode !== undefined && ![MAPPING_POLICY_ID, DIALOGUE_POLICY_ID].includes(mode)) {
    console.error("模式只能是 mapping 或 dialogue。");
    process.exit(2);
  }
  const home = bridgeHome();
  const found = findRegisteredTaskForCodexThread({ threadId, home });
  if (!found.ok) {
    console.error("当前 Codex task 尚未接入飞书，不能设置模式。");
    process.exit(1);
  }
  const current = interactionPolicyForTask(found.task);
  if (!current.ok) {
    console.error("交互策略状态不可用（" + current.reason + "）。");
    process.exit(1);
  }
  if (mode === undefined) {
    console.log(describeCodexInteractionPolicy(current.state));
    process.exit(0);
  }
  console.log("将切换为：" + (mode === DIALOGUE_POLICY_ID
    ? "Dialogue（单主持者·串行；默认 12 轮 / 2 小时 / 12 资源单位）"
    : "Mapping（一次输入对应一次运行；若对话仍在进行会立即中止后续编排）"));
  if (!process.argv.includes("--apply")) {
    console.log("[dry-run] 什么都没写。加 --apply 才切换。");
    process.exit(0);
  }
  // **一次性意图凭证，在写之前消费。**
  // 技能选择这一层不受钩子判据约束 —— agent 之间提一句命令就可能把它执行掉
  // （出过真事故）。凭证把"技能被选中"和"这次操作被授权"分开。
  // **参数要带上** —— 一张 dialogue 票不该能切 mapping。
  const intent = requireIntent({
    apply: true, action: "mode", threadId,
    params: buildIntentParams("mode", { mode }), home });
  if (!intent.ok) { console.error(intent.text); process.exit(1); }
  const changed = setTaskInteractionMode({ threadId, mode, home });
  if (!changed.ok) {
    console.error("模式没有切换（" + changed.reason + "）。");
    process.exit(1);
  }
  console.log(changed.changed === false ? "模式本来就是这个状态，没有重复创建对话。" : "模式已切换。");
  console.log(describeCodexInteractionPolicy(changed.state));
}

if (isDirectRun(import.meta.url)) main();
