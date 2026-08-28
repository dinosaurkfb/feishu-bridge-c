/**
 * 飞书正文里的**控制命令**（goal 第 3 层，2026-08-28）：路由侧直接执行，不经过模型。
 *
 * 只认封闭的精确形状（正文恰为，多一个字都不算 —— 与 CLAUDE.md 里的授权纪律同一份）：
 *   Claude：`/feishu-mode dialogue`、`/feishu-mode mapping`
 *   Codex ：`$feishu-mode dialogue`、`$feishu-mode mapping`
 * 身份不在这里验：能走到这里的正文已经过了入站的三道闸（登记发送者、真实 @、新鲜度）并拿到 claim。
 * 无参数的 `/feishu-mode`（只读查看）不在飞书侧开放：查看走状态页。
 */

import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";

const SHAPES = {
  claude: /^\/feishu-mode (dialogue|mapping)$/u,
  codex: /^\$feishu-mode (dialogue|mapping)$/u,
};

/** @returns {{kind:"mode", mode:string}|null} */
export function parseControlCommand(instruction, { chain } = {}) {
  const re = SHAPES[chain];
  if (!re || typeof instruction !== "string") return null;
  const m = re.exec(instruction);
  if (!m) return null;
  return { kind: "mode", mode: m[1] === "dialogue" ? DIALOGUE_POLICY_ID : MAPPING_POLICY_ID };
}

const MODE_LABEL = {
  [DIALOGUE_POLICY_ID]: "Dialogue（单主持者·串行；默认 12 轮 / 2 小时 / 12 资源单位）",
  [MAPPING_POLICY_ID]: "Mapping（一次输入对应一次运行）",
};

/** 回执正文：说清切到了什么、是不是本来就是、这条不是指令。 */
export function controlAckText({ taskName, mode, changed }) {
  return [
    (changed ? "已切换 · " : "模式未变 · ") + taskName,
    (changed ? "交互模式现在是 " : "本来就是 ") + (MODE_LABEL[mode] ?? mode) + "。",
    "本条是控制命令，没有被当作指令投递。",
  ].join("\n");
}
