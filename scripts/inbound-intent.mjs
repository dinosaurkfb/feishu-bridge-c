/**
 * 入站正文的**结构化意图**（goal「入站权限分级」第 3 层「近似命中收边」）—— **唯一一份判据，两条链共用。**
 *
 * 正文先按 normalizeControlText 折叠不可见字符 / 全角前缀 / 空白，再落进一个封闭联合：
 *
 *   readonly          正文恰为本链只读命令词（status / subscribe）—— 投给模型，由技能只读展示
 *   router_control    路由侧直接执行、不经模型：feishu-mode dialogue|mapping（control 字段非空）
 *   model_control     精确命令词，投给模型执行对应技能：bind / rotate / rotate cancel
 *   rejected_control  精确命令词但**不从飞书开放**（CLAUDE.md）：unbind / pin-session —— 取 claim 后记拒绝终态、回执说明去哪做
 *   malformed_control 命令命名空间（`/feishu-…` / `$feishu-…`）里的其它一切：缺参、错参、多了尾巴、
 *                     没这个词、别链前缀 —— 取 claim 后记拒绝终态、回执说清差在哪，不投递给会话
 *   authorization     逐次授权用语的封闭措辞（装 / 安装 / 切路由 / 写飞书 …，可带对象）
 *   ordinary          普通文本 —— 包括自然语言里顺带提到的命令（"记得 /feishu-mode dialogue 这条命令"）
 *
 * 风险等级（risk-class.mjs）只是这个联合的投影；入口按 intent 做确定性处置。
 * 身份不在这里验：谁能发哪一类由 authorize.mjs 的交叉表决定。
 */
import { createHash } from "node:crypto";
import { CONTROL_MODE_WORDS, normalizeControlText, parseControlCommand } from "./control-command.mjs";
import { REJECTED_CONTROL_INTENTS } from "./control-intent.mjs";
import { displaySafe } from "./display-safe.mjs";

export const INTENT = Object.freeze({
  READONLY: "readonly",
  ROUTER_CONTROL: "router_control",
  MODEL_CONTROL: "model_control",
  REJECTED_CONTROL: "rejected_control",
  MALFORMED_CONTROL: "malformed_control",
  AUTHORIZATION: "authorization",
  ORDINARY: "ordinary",
});

export const CHAIN_PREFIX = Object.freeze({ claude: "/", codex: "$" });
const CHAIN_NAME = Object.freeze({ "/": "Claude", "$": "Codex" });
const NAMESPACE = "feishu-";
const READONLY_WORDS = Object.freeze(["feishu-status", "feishu-subscribe"]);
/** 不从飞书开放的精确命令词 → 回执里告诉他去哪做。 */
const REJECTED_WORDS = Object.freeze({
  "feishu-unbind": (p) => `暂停接入不从飞书开放，请在终端里跑 ${p}feishu-unbind`,
  "feishu-pin-session": (p) => `钉会话不从飞书开放，请在终端里跑 ${p}feishu-pin-session`,
});
/** 逐次授权用语（CLAUDE.md「这三件事需要 Frank 逐次授权」的封闭措辞）：词本身，或词 + 空格 + 对象。 */
const AUTHORIZATION_RE = /^(?:装|安装|切路由|切权威路由|写飞书|发飞书)(?:\s.+)?$/u;

const availableText = (p) =>
  `${p}feishu-status、${p}feishu-subscribe、${p}feishu-mode ${CONTROL_MODE_WORDS.join("|")}、${p}feishu-bind、${p}feishu-rotate、${p}feishu-rotate cancel`;
/** 回执里反射用户给的词 / 参数：先净化（控制字符、locator 形状），再按 Unicode 码点截断 —— 原始正文只留在 digest 里，不直接展示。 */
const SHOWN_MAX = 40;
export function shown(text) {
  const cps = Array.from(displaySafe(String(text ?? "")));
  return cps.length > SHOWN_MAX ? cps.slice(0, SHOWN_MAX).join("") + "…" : cps.join("");
}

/**
 * @param {{ instruction: unknown, chain: "claude"|"codex" }} _
 * @returns {{ intent: string, text: string, word: string|null, control: {kind:"mode",mode:string}|null, problem: string|null }}
 *   word    ：命令命名空间里的命令词（不含前缀），非命令为 null
 *   control ：router_control 时是 parseControlCommand 的结果，其它一律 null
 *   problem ：rejected_control / malformed_control 时说清"差在哪 / 去哪做"，其它一律 null
 */
export function parseInboundIntent({ instruction, chain } = {}) {
  const text = normalizeControlText(typeof instruction === "string" ? instruction : "");
  const base = { text, word: null, control: null, problem: null };
  const prefix = text.startsWith("/" + NAMESPACE) ? "/" : text.startsWith("$" + NAMESPACE) ? "$" : null;
  if (prefix === null) {
    if (AUTHORIZATION_RE.test(text)) return { intent: INTENT.AUTHORIZATION, ...base };
    return { intent: INTENT.ORDINARY, ...base };
  }
  const [word, ...rest] = text.slice(1).split(" ");
  const args = rest.join(" ");
  const w = shown(word); const a = shown(args);
  const malformed = (problem) => ({ intent: INTENT.MALFORMED_CONTROL, ...base, word, problem });
  const own = CHAIN_PREFIX[chain] ?? null;
  if (own === null) return malformed("这条链说不清是 Claude 还是 Codex，命令没有执行");
  if (prefix !== own) {
    return malformed(`前缀「${prefix}」是 ${CHAIN_NAME[prefix]} 链的写法；这个话题是 ${CHAIN_NAME[own]} 链，命令用「${own}」开头`);
  }
  const noArgs = (intent, problem = null) =>
    args ? malformed(`${own}${w} 不带参数，多了「${a}」`) : { intent, ...base, word, problem };
  if (READONLY_WORDS.includes(word)) return noArgs(INTENT.READONLY);
  if (word === "feishu-mode") {
    if (!args) return malformed(`${own}feishu-mode 缺参数：${CONTROL_MODE_WORDS.join(" 或 ")}（查看当前模式走 ${own}feishu-status）`);
    // 命中与否只由路由侧的精确解析决定（判据一份）；文案引用同一份参数词表
    const control = parseControlCommand(text, { chain });
    if (!control) return malformed(`${own}feishu-mode 的参数只认 ${CONTROL_MODE_WORDS.join(" / ")}，收到「${a}」`);
    return { intent: INTENT.ROUTER_CONTROL, ...base, word, control };
  }
  if (word === "feishu-rotate") {
    if (!args || args === "cancel") return { intent: INTENT.MODEL_CONTROL, ...base, word };
    return malformed(`${own}feishu-rotate 只认不带参数或「cancel」，收到「${a}」`);
  }
  if (word === "feishu-bind") return noArgs(INTENT.MODEL_CONTROL);
  if (Object.hasOwn(REJECTED_WORDS, word)) return noArgs(INTENT.REJECTED_CONTROL, REJECTED_WORDS[word](own));
  return malformed(`没有「${own}${w}」这个命令；飞书里可用：${availableText(own)}`);
}

/** 进 claim 的拒绝投影（封闭形状，验证器在 control-intent.mjs）：只有 rejected_control / malformed_control 才有，其它为 null。 */
export function rejectedControlProjection(intent) {
  if (!intent || !REJECTED_CONTROL_INTENTS.includes(intent.intent)) return null;
  return { intent: intent.intent, word: intent.word, problem: intent.problem, digest: createHash("sha256").update(intent.text, "utf8").digest("hex") };
}

/** 拒绝回执正文（手机上读）：说清这一条差在哪 / 去哪做，并明说没有执行、没有投递。 */
export function controlRejectText(intent) {
  if (intent?.intent === INTENT.REJECTED_CONTROL) return "这个命令不从飞书开放：" + intent.problem + "。没有执行，也没有投递。";
  if (intent?.intent === INTENT.MALFORMED_CONTROL) return "命令形状不对：" + intent.problem + "。没有执行，也没有投递。";
  return null;
}
