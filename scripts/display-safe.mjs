/**
 * 面向人的输出边界 —— **一份规则，各入口共用**：
 *   · sanitizeForDisplay：所有 C0/C1 控制符、行分隔符、双向文本控制符换成可见占位符
 *     （评审两轮实测：清屏序列、换行伪造后续行、U+061C 都曾原样带进真实 CLI 的 stdout；
 *     "这里原本有东西"本身是信息，所以是替换不是删除）；
 *   · redactLocators：状态页不许泄露 locator —— 飞书 id（oc_/om_/omt_/ou_/on_）、会话 / 线程 /
 *     应用 id、64 位内容摘要（run key）、UUID，都只留一个能对照的短前缀。
 * why 文本来自文件名、旧失败账、底层错误消息 —— 不能假定内容受控，必须在边界统一过一遍，
 * 而不是逐个插值点记得调用（那种写法漏一个就前功尽弃）。
 */

export function sanitizeForDisplay(text) {
  // **双向控制符用 Unicode 属性，不手数码位。**手数码位的错误模式就是"漏掉的那个"。
  return String(text ?? "").replace(
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Bidi_Control}/gu, "\uFFFD");
}

/** locator 的形状：前缀受控，主体 ≥ 6 位。状态提供者的显示名校验与状态页脱敏共用。 */
export const LOCATOR_SHAPED = /(?:oc_|omt_|om_|ou_|on_|session_|thread_|cli_)[A-Za-z0-9_-]{6,}/u;
const LOCATOR_ALL = new RegExp(LOCATOR_SHAPED.source, "gu");
const HEX_DIGEST = /\b[0-9a-fA-F]{64}\b/gu;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu;

export function redactLocators(text) {
  return String(text ?? "")
    .replace(HEX_DIGEST, (m) => m.slice(0, 8) + "…")
    .replace(UUID, (m) => m.slice(0, 8) + "…")
    .replace(LOCATOR_ALL, (m) => m.slice(0, m.indexOf("_") + 1) + "…");
}

/** 状态页文本的完整净化：先压平控制符，再脱敏 locator。 */
export function displaySafe(text) {
  return redactLocators(sanitizeForDisplay(text));
}
