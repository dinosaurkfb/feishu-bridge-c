#!/usr/bin/env node
/** 查看或显式切换当前 Claude binding 的 Interaction Policy。默认只读，写入必须 --apply。 */

import path from "node:path";

import {
  DIALOGUE_POLICY_ID, MAPPING_POLICY_ID, interactionPolicySummary,
} from "./interaction-policy.mjs";
import {
  loadClaudeInteractionPolicy, setClaudeInteractionMode,
} from "./interaction-policy-store.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

export function describeInteractionPolicy(state) {
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
  const root = path.resolve(arg("project") ?? process.cwd());
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const mode = arg("mode");
  if (mode !== undefined && ![MAPPING_POLICY_ID, DIALOGUE_POLICY_ID].includes(mode)) {
    console.error("模式只能是 mapping 或 dialogue。");
    process.exit(2);
  }
  const current = loadClaudeInteractionPolicy({ root, claudeSessionId });
  if (!current.ok) {
    console.error("当前上下文没有可用的飞书 binding（" + current.reason + "）。");
    process.exit(1);
  }
  if (mode === undefined) {
    console.log(describeInteractionPolicy(current.state));
    process.exit(0);
  }
  console.log("将切换为：" + (mode === DIALOGUE_POLICY_ID
    ? "Dialogue（单主持者·串行；默认 12 轮 / 2 小时 / 12 资源单位）"
    : "Mapping（一次输入对应一次运行；若对话仍在进行会立即中止后续编排）"));
  if (!process.argv.includes("--apply")) {
    console.log("[dry-run] 什么都没写。加 --apply 才切换。");
    process.exit(0);
  }
  const changed = setClaudeInteractionMode({ root, claudeSessionId, mode });
  if (!changed.ok) {
    console.error("模式没有切换（" + changed.reason + "）。");
    process.exit(1);
  }
  console.log(changed.changed === false ? "模式本来就是这个状态，没有重复创建对话。" : "模式已切换。");
  console.log(describeInteractionPolicy(changed.state));
}

if (import.meta.url === "file://" + process.argv[1]) main();
