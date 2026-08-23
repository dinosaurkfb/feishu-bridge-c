/**
 * 把一个值安全地放进 shell 命令文本里。
 *
 * 为什么需要它 —— 桥会**生成给人和模型执行的命令字符串**：入站钩子注入的
 * `node <dispatcher>`、技能 SKILL.md 里的那几条、bind-preview 打印的后续命令。
 * 这些文本最终会被交给 shell。只要路径里有空格，shell 就会按空格拆词：
 *
 *   node /Users/dk/我的 家/.claude/…/aily-inbound.mjs
 *   → shell 认为你要执行 `node` 并传两个参数 `/Users/dk/我的` 和 `家/.claude/…`
 *
 * 实测过：同一条路径用 argv 直接调用能跑，交给 `/bin/sh -c` 就失败。
 *
 * **不能只加双引号**：双引号内 `$`、反引号、`\` 仍会被解释，路径里带这些字符就不只是
 * 拆词，而是可能执行别的东西。POSIX 里唯一完全字面的是单引号 —— 单引号内没有任何
 * 转义，连反斜杠都不特殊；唯一要处理的是单引号本身，办法是先闭合、插一个转义的单引号、
 * 再重新打开（`'\''`）。
 */
export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

/** 命令文本里的「node <脚本>」前缀，两处生成必须同源：技能正文与权限放行规则。 */
export function nodeCommandPrefix(scriptPath) {
  return "node " + shellQuote(scriptPath);
}
