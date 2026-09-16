/**
 * claude 二进制的版本前检（issue #140 产品侧第四条）。
 *
 * 2026-09-08 的事故：PATH 上 /opt/homebrew/bin 排在 ~/.local/bin 前面，转发进程解析到旧版
 * 2.1.248，被 API 按 "version 2.1.251 or newer is required" 顶回来，2–4 秒即退 —— 而回执
 * 早就宣称已经投进那个会话了（那三个字的旧字样在 scripts/ 里被守卫盯着，这里只用别的说法指代）。
 * R58 的失败回执是**事后**如实告知，这里补的是**事前**那一眼。
 *
 * 这个叶子模块只做两件事：把 `claude --version` 的输出解析成可比的三段数字，生成 / 反解
 * 「版本过旧」那一类回执正文。**正文里只允许出现严格三段版本形状的 token**（反解端从正文里
 * 把它抠出来、按同一个模板逐字重建一次才算数），所以它不是一个自由文本通道 —— R58 的
 * 正文封闭纪律不破。放叶子模块是为了不被 outbox ↔ forward-runner 的依赖方向卷成环。
 */

/** 事故里 API 报出的下限：`version 2.1.251 or newer is required`。 */
export const MIN_FORWARD_CLAUDE_VERSION = "2.1.251";

const VERSION_RE = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/u;
const ANY_VERSION_RE = /(\d{1,5})\.(\d{1,5})\.(\d{1,5})/u;

/** 严格三段版本 token（回执正文里允许出现的唯一动态片段）。 */
export const isClaudeVersionToken = (v) => typeof v === "string" && VERSION_RE.test(v);

/** 从 `claude --version` 的输出里取版本；取不到返回 null —— 调用方据此**不拦**，不猜。 */
export function parseClaudeVersion(text) {
  const m = String(text ?? "").match(ANY_VERSION_RE);
  return m === null ? null : m[0];
}

/** a < b ？形状不认识一律 false（不拿不认识的东西拦路）。 */
export function claudeVersionBelow(a, b = MIN_FORWARD_CLAUDE_VERSION) {
  const x = VERSION_RE.exec(String(a ?? ""));
  const y = VERSION_RE.exec(String(b ?? ""));
  if (x === null || y === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0;
  }
  return false;
}

const OLD_PREFIX = "转发失败：本机 claude 版本 ";
const OLD_SUFFIX = " 过旧（转发需要 " + MIN_FORWARD_CLAUDE_VERSION + " 或更高）；本条未送达，请重发或在终端查看 doctor ⑯";

/** 「版本过旧」回执正文 = 封闭模板 + 严格版本 token。 */
export function forwardVersionUnsupportedText(version) {
  return OLD_PREFIX + version + OLD_SUFFIX;
}

/** 反解：正文必须逐字等于「模板 + 某条严格版本 token」，否则不认（回执封闭校验器用）。 */
export function forwardVersionUnsupportedVersionOf(text) {
  if (typeof text !== "string" || !text.startsWith(OLD_PREFIX) || !text.endsWith(OLD_SUFFIX)) return null;
  const v = text.slice(OLD_PREFIX.length, text.length - OLD_SUFFIX.length);
  return isClaudeVersionToken(v) ? v : null;
}
