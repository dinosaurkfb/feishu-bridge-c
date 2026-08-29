/**
 * 入站消息的风险等级（goal「入站权限分级」第 2 层）—— **唯一一份判据，两条链共用。**
 *
 *   R0 只读    ：查看状态 / 订阅（正文恰为本链的 status / subscribe 命令词）—— 不动本机任何状态
 *   R1 对话    ：Dialogue 模式下的普通文本 —— 只产生一段回复
 *   R2 执行    ：Mapping 模式下的普通文本 —— 在本地项目里跑一轮 run（改文件、跑命令）
 *   R3 控制    ：改绑定 / 策略的控制命令（feishu-mode 精确形状；bind / rotate 的精确形状）
 *   R4 授权类  ：装 / 切权威路由 这类逐次授权用语（CLAUDE.md 里的封闭措辞）
 *
 * 第 4 层模式决定普通文本落在 R1 还是 R2：同一句话在 Dialogue 里是对话、在 Mapping 里是执行。
 * 归类只看"这条消息想干什么"，不看谁发的 —— 谁能干什么由 authorize.mjs 的交叉表决定。
 */
import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";
import { normalizeControlText } from "./control-command.mjs";

export const RISK = Object.freeze({ R0: "R0", R1: "R1", R2: "R2", R3: "R3", R4: "R4" });
export const RISK_LABEL = Object.freeze({ R0: "只读", R1: "对话", R2: "执行", R3: "控制", R4: "授权类" });

const PREFIX = { claude: "/", codex: "$" };
const READ_ONLY = ["feishu-status", "feishu-subscribe"];
const CONTROL_WORDS = ["feishu-bind", "feishu-rotate", "feishu-rotate cancel", "feishu-mode dialogue", "feishu-mode mapping"];
// 逐次授权用语（CLAUDE.md「这三件事需要 Frank 逐次授权」的封闭形状）：装 / 装 <对象>、安装、切路由 …
const AUTHORIZATION_RE = /^(?:装|安装)(?:\s+\S+)?$|^切路由(?:\s+.+)?$/u;

/**
 * @returns {{ riskClass: string, kind: "readonly"|"control"|"authorization"|"conversation"|"instruction" }}
 * control 由调用方传入 parseControlCommand 的结果（不重复解析，保持"判据只有一份"）。
 */
export function classifyRisk({ instruction, chain, mode, control = null } = {}) {
  if (control) return { riskClass: RISK.R3, kind: "control" };
  const text = normalizeControlText(typeof instruction === "string" ? instruction : "");
  const prefix = PREFIX[chain];
  if (prefix && text.startsWith(prefix)) {
    const word = text.slice(prefix.length);
    if (READ_ONLY.includes(word)) return { riskClass: RISK.R0, kind: "readonly" };
    if (CONTROL_WORDS.includes(word)) return { riskClass: RISK.R3, kind: "control" };
  }
  if (AUTHORIZATION_RE.test(text)) return { riskClass: RISK.R4, kind: "authorization" };
  if (mode === DIALOGUE_POLICY_ID) return { riskClass: RISK.R1, kind: "conversation" };
  if (mode === MAPPING_POLICY_ID) return { riskClass: RISK.R2, kind: "instruction" };
  // 模式说不清：按最高风险的普通文本处理（fail-closed），不折叠成 R1
  return { riskClass: RISK.R2, kind: "instruction" };
}
