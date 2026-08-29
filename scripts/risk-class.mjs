/**
 * 入站消息的风险等级（goal「入站权限分级」第 2 层）—— **唯一一份判据，两条链共用。**
 *
 * 风险等级是 inbound-intent.mjs 那个封闭意图联合的**投影**：
 *
 *   R0 只读    ：readonly（正文恰为本链的 status / subscribe 命令词）—— 不动本机任何状态
 *   R1 对话    ：ordinary × Dialogue / chat —— 只产生一段回复
 *   R2 执行    ：ordinary × Mapping —— 在本地项目里跑一轮 run（改文件、跑命令）
 *   R3 控制    ：router_control / model_control / rejected_control / malformed_control —— 命令命名空间里的
 *                一切都按控制处理，不折叠成普通文本；哪些真执行、哪些当场拒，入口按 intent 处置
 *   R4 授权类  ：authorization（装 / 安装 / 切路由 / 写飞书 的封闭措辞，可带对象）
 *
 * 第 4 层模式决定普通文本落在 R1 还是 R2：同一句话在 Dialogue 里是对话、在 Mapping 里是执行。
 * 归类只看"这条消息想干什么"，不看谁发的 —— 谁能干什么由 authorize.mjs 的交叉表决定。
 *
 * 归类不是执行边界：一句自由语句（"把这份结果发到飞书"）在 Dialogue 下就是 R1，模型收到后
 * 能不能真的去写飞书，由投递层给 R1 的能力边界决定，不由这里猜自然语言。
 */
import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";
import { INTENT, parseInboundIntent } from "./inbound-intent.mjs";
import { CHAT_POLICY_ID } from "./chat-reply.mjs";

export const RISK = Object.freeze({ R0: "R0", R1: "R1", R2: "R2", R3: "R3", R4: "R4" });
export const RISK_LABEL = Object.freeze({ R0: "只读", R1: "对话", R2: "执行", R3: "控制", R4: "授权类" });

const CONTROL_INTENTS = new Set([INTENT.ROUTER_CONTROL, INTENT.MODEL_CONTROL, INTENT.REJECTED_CONTROL, INTENT.MALFORMED_CONTROL]);

/**
 * @param {{ intent?: ReturnType<typeof parseInboundIntent>, instruction?: unknown, chain?: string, mode?: unknown }} _
 *   给了 intent 就用它（入口只解析一次）；没给才从 instruction + chain 解析 —— 两条路结论必须一致（有测试钉住）。
 * @returns {{ riskClass: string, kind: "readonly"|"control"|"authorization"|"conversation"|"instruction" }}
 */
export function classifyRisk({ intent = null, instruction, chain, mode } = {}) {
  const it = intent ?? parseInboundIntent({ instruction, chain });
  if (it.intent === INTENT.READONLY) return { riskClass: RISK.R0, kind: "readonly" };
  if (CONTROL_INTENTS.has(it.intent)) return { riskClass: RISK.R3, kind: "control" };
  if (it.intent === INTENT.AUTHORIZATION) return { riskClass: RISK.R4, kind: "authorization" };
  if (it.intent === INTENT.ORDINARY) {
    if (mode === DIALOGUE_POLICY_ID) return { riskClass: RISK.R1, kind: "conversation" };
    // chat 默认态（无绑定上下文）：普通文本只能是对话 —— 没有目标可执行，R2 在这里根本不存在
    if (mode === CHAT_POLICY_ID) return { riskClass: RISK.R1, kind: "conversation" };
    if (mode === MAPPING_POLICY_ID) return { riskClass: RISK.R2, kind: "instruction" };
    // 模式说不清：按最高风险的普通文本处理（fail-closed），不折叠成 R1
    return { riskClass: RISK.R2, kind: "instruction" };
  }
  // 意图联合之外的值（编程错误）：按控制处理，只有 owner 能过 —— 说不清不折叠成 0
  return { riskClass: RISK.R3, kind: "control" };
}
