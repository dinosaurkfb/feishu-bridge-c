/**
 * 角色 × 风险等级 × 第 4 层模式 的判定 —— **唯一一处，两条链共用**（goal「入站权限分级」第 2 层）。
 *
 * Frank 2026-08-29 定的表：
 *   · Mapping 下只有 owner 可以 R2（背后跑的是真项目）；
 *   · Dialogue 下 R1 对 owner / operator / participant 都开；
 *   · R3（控制）/ R4（授权类）只有 owner；
 *   · operator 暂与 participant 同权（角色位先留）；
 *   · 未登记（role 为 null）零权限。
 * 表里没写的格子就是不允许 —— fail-closed。
 *
 * 执行边界（Frank 2026-08-29 同意的 §6a 简化版）：放行的同时给出 **capability** ——
 *   · owner → full：照旧投给现场会话 / 续起长期会话，全能力；
 *   · 其他角色 → reply_only：只回复 —— 零工具、无历史的一次性回合，不碰任何会话文件；
 *   · 一条链若没有可验证的只回复执行路径（REPLY_ONLY_CAPABLE 为 false），非 owner 的放行格子在这条链上**暂不开放**
 *     （reason no_reply_only_path），而不是退化成全能力投递。判据仍只有这一份。
 */
import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";
import { SENDER_ROLES } from "./sender-roles.mjs";
import { RISK, RISK_LABEL } from "./risk-class.mjs";

const OWNER = Object.freeze(["owner"]);
const EVERYONE = Object.freeze(["owner", "operator", "participant"]);

/** 交叉表：mode → risk → 允许的角色。 */
export const AUTHORIZATION_TABLE = Object.freeze({
  [MAPPING_POLICY_ID]: Object.freeze({ [RISK.R0]: OWNER, [RISK.R1]: OWNER, [RISK.R2]: OWNER, [RISK.R3]: OWNER, [RISK.R4]: OWNER }),
  [DIALOGUE_POLICY_ID]: Object.freeze({ [RISK.R0]: OWNER, [RISK.R1]: EVERYONE, [RISK.R2]: OWNER, [RISK.R3]: OWNER, [RISK.R4]: OWNER }),
});
const MODE_LABEL = { [MAPPING_POLICY_ID]: "Mapping", [DIALOGUE_POLICY_ID]: "Dialogue" };

export const CAPABILITY = Object.freeze({ FULL: "full", REPLY_ONLY: "reply_only" });
/** 哪条链有可验证的只回复执行路径：Claude 有（`claude -p --tools ""`）；Codex 的只读沙箱只是 shell 沙箱，不算。 */
export const REPLY_ONLY_CAPABLE = Object.freeze({ claude: true, codex: false });

/**
 * @returns {{ allow: boolean, reason: null|"sender_not_registered"|"mode_unknown"|"risk_unknown"|"not_authorized"|"no_reply_only_path", required: string[], capability: "full"|"reply_only"|null, text: string|null }}
 * text 是给发送者看的拒绝理由：说清"哪个模式、哪个角色、缺什么权限"，不说别的。
 * chain：这条消息落在哪条链（claude | codex）—— 决定非 owner 的放行能不能落成 reply_only；说不清按没有只回复路径处理。
 */
export function authorize({ role, riskClass, mode, chain } = {}) {
  const modeText = MODE_LABEL[mode] ?? String(mode);
  const riskText = riskClass + "（" + (RISK_LABEL[riskClass] ?? "?") + "）";
  if (role === null || role === undefined || !SENDER_ROLES.includes(role)) {
    return { allow: false, reason: "sender_not_registered", required: [], capability: null, text: "发送者未登记角色；这个话题处于 " + modeText + " 模式，" + riskText + " 只对登记过的角色开放" };
  }
  const row = AUTHORIZATION_TABLE[mode];
  if (!row) return { allow: false, reason: "mode_unknown", required: [], capability: null, text: "这个话题的交互模式说不清（" + String(mode) + "），不放行任何操作" };
  const allowed = row[riskClass];
  if (!allowed) return { allow: false, reason: "risk_unknown", required: [], capability: null, text: "这条消息的风险等级说不清（" + String(riskClass) + "），不放行" };
  if (!allowed.includes(role)) {
    return { allow: false, reason: "not_authorized", required: [...allowed], capability: null,
      text: "这个话题处于 " + modeText + " 模式；你的角色是 " + role + "，" + riskText + " 需要 " + allowed.join(" / ") + " 权限" };
  }
  if (role === "owner") return { allow: true, reason: null, required: [...allowed], capability: CAPABILITY.FULL, text: null };
  if (REPLY_ONLY_CAPABLE[chain] !== true) {
    return { allow: false, reason: "no_reply_only_path", required: [...allowed], capability: null,
      text: "这个话题处于 " + modeText + " 模式；你的角色是 " + role + "，" + riskText + " 在这条链上暂时只对 owner 开放（还没有只回复的执行路径）" };
  }
  return { allow: true, reason: null, required: [...allowed], capability: CAPABILITY.REPLY_ONLY, text: null };
}
