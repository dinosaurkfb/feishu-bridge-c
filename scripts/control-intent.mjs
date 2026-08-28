/**
 * 控制意图的**唯一**验证器（claim.mjs 与 control-command.mjs 共用；各写一份就会漂）。
 * 形状封闭：恰为 { control: "mode", mode: mapping | dialogue }，多一个键都不算。
 */

import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";

export const CONTROL_MODES = Object.freeze([MAPPING_POLICY_ID, DIALOGUE_POLICY_ID]);

/** 不在场（undefined）= 不是控制命令 → null；在场就必须完全合规，否则返回问题描述。 */
export function controlIntentProblem(intent) {
  if (intent === undefined) return null;
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return "control 不是对象";
  if (Object.keys(intent).sort().join(",") !== "control,mode") return "control 字段集不对";
  if (intent.control !== "mode") return "control 不是 mode";
  if (!CONTROL_MODES.includes(intent.mode)) return "control 取值不在受控集合里";
  return null;
}

export function sameControlIntent(a, b) {
  return controlIntentProblem(a) === null && controlIntentProblem(b) === null && a !== undefined && b !== undefined
    && a.control === b.control && a.mode === b.mode;
}
