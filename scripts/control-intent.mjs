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

/** 收边（第 3 层）在 claim 里持久化的**拒绝投影**：{ intent, word, problem, digest }，封闭形状；两种 intent 与 inbound-intent.mjs 同名（有测试钉住）。 */
export const REJECTED_CONTROL_INTENTS = Object.freeze(["rejected_control", "malformed_control"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/** 不在场（undefined）= 不是收边对象 → null；在场就必须完全合规，否则返回问题描述。 */
export function rejectedControlProblem(rc) {
  if (rc === undefined) return null;
  if (rc === null || typeof rc !== "object" || Array.isArray(rc)) return "rejected_control 不是对象";
  if (Object.keys(rc).sort().join(",") !== "digest,intent,problem,word") return "rejected_control 字段集不对";
  if (!REJECTED_CONTROL_INTENTS.includes(rc.intent)) return "rejected_control.intent 不在受控集合里";
  if (!nonEmpty(rc.word)) return "rejected_control.word 缺失";
  if (!nonEmpty(rc.problem)) return "rejected_control.problem 缺失";
  if (!SHA256.test(rc.digest)) return "rejected_control.digest 不是 sha256";
  return null;
}

export function sameRejectedControl(a, b) {
  return a !== undefined && b !== undefined && rejectedControlProblem(a) === null && rejectedControlProblem(b) === null
    && a.intent === b.intent && a.word === b.word && a.problem === b.problem && a.digest === b.digest;
}
