/**
 * Codex hook 命令的**构造与识别 —— 只有这一份**。
 *
 * 安装器和 doctor 各写一份判据的后果，评审用反例当场证明了：
 * 一条只做 `echo <runtime/current/.../stop-hook.mjs>` 的假 hook，
 * doctor 报"恰好 1 条，指向 runtime/current"，而安装器根本不认它。
 * **判据分家 = 验收工具和被验收的东西说的不是一件事。**
 *
 * 识别必须是**整条锚定**，不是子串包含。评审的反例：
 * `echo FEISHU_BRIDGE_CODEX_HOOK:prompt-hook.mjs` 会被安装器当成自己的删掉 ——
 * 别人的 hook 里随便提一句这个标记就会被误删。
 */

import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "../shell-quote.mjs";

/**
 * 钩子命令里用哪个 node。**安装器和 doctor 必须挑出同一个**——
 * 各写一份的话，doctor 拿它自己挑的那个去比对，永远比不上。
 */
export function pickNode(candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
  for (const file of [...candidates, process.execPath]) {
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return process.execPath;
}

/** 埋进命令首行的归属标记：与脚本路径无关，换克隆、换 runtime 都认得出自己那条。 */
export const HOOK_TAG = "FEISHU_BRIDGE_CODEX_HOOK:";

export const OUR_SCRIPTS = new Set(["prompt-hook.mjs", "stop-hook.mjs"]);

/**
 * 构造一条 hook 命令。
 *
 * 外层 if 是为了「node 或脚本不在了」时不把错误弹到每一次会话结束上；
 * 但绝不能真的静默 —— else 分支往日志里留一行，否则出站停摆无从发现。
 */
export function buildHookCommand({ node, script, home, log }) {
  return "# " + HOOK_TAG + path.basename(script) + "\n" +
    "if [ -x " + shellQuote(node) + " ] && [ -r " + shellQuote(script) + " ]; then " +
    "FEISHU_CODEX_BRIDGE_HOME=" + shellQuote(home) + " " +
    shellQuote(node) + " " + shellQuote(script) + "; " +
    "else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; " +
    "printf '%s hook-unavailable\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> " +
    shellQuote(log) + " 2>/dev/null || :; fi";
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * 拆一个 shellQuote 出来的单引号串。
 *
 * shellQuote 把 `'` 编码成 `'\''`（收尾、转义的引号、再开头）。
 * 用 `'([^']+)'` 去匹配就会在第一个内嵌引号处断掉 —— 评审实测：
 * 在含 `'` 的 CODEX_HOME 下连装两次，**UserPromptSubmit 和 Stop 各出现 2 条**，
 * 因为第二次没认出第一次装的那条。
 */
const QUOTED = "'(?:[^']|'\\\\'')*'";
const unquote = (text) => text.slice(1, -1).replaceAll("'\\''", "'");

/**
 * 现行形态：**首行标记 + 我们生成的模板**，整条锚定。
 *
 * 捕获出 node / 脚本 / home / 日志四项，供 build → parse → build 往返校验。
 */
const CURRENT = new RegExp(
  "^# " + escapeRe(HOOK_TAG) + "([a-z-]+\\.mjs)\\n" +
  "if \\[ -x (" + QUOTED + ") \\] && \\[ -r (" + QUOTED + ") \\]; then " +
  "FEISHU_CODEX_BRIDGE_HOME=(" + QUOTED + ") (" + QUOTED + ") (" + QUOTED + "); " +
  "else \\{ command -p cat 2>/dev/null \\|\\| cat; \\} >/dev/null 2>&1; " +
  "printf '%s hook-unavailable\\\\n' \"\\$\\(date -u \\+%Y-%m-%dT%H:%M:%SZ\\)\" >> " +
  "(" + QUOTED + ") 2>/dev/null \\|\\| :; fi$", "u");

/** 历史形态（没有标记行），只为迁移那一次，同样整条锚定。 */
const LEGACY = new RegExp(
  "^if \\[ -x (" + QUOTED + ") \\] && \\[ -r (" + QUOTED + ") \\]; then " +
  "FEISHU_CODEX_BRIDGE_HOME=(" + QUOTED + ") (" + QUOTED + ") (" + QUOTED + "); " +
  "else \\{ command -p cat 2>/dev/null \\|\\| cat; \\} >/dev/null 2>&1; " +
  "printf '%s hook-unavailable\\\\n' \"\\$\\(date -u \\+%Y-%m-%dT%H:%M:%SZ\\)\" >> " +
  "(" + QUOTED + ") 2>/dev/null \\|\\| :; fi$", "u");

/**
 * 解析一条命令。**判据是"能否原样重建"，不是"长得像"。**
 *
 * 拆出四项之后拿 buildHookCommand 重造一遍，逐字对不上就不是我们的 ——
 * 这样识别和构造在结构上不可能分家：改了构造而没改识别，往返立刻失败。
 */
export function parseHookCommand(command) {
  if (typeof command !== "string") return null;
  const cur = CURRENT.exec(command);
  const old = cur ? null : LEGACY.exec(command);
  const m = cur ?? old;
  if (!m) return null;
  const parts = (cur ? m.slice(2) : m.slice(1)).map(unquote);
  const [guardNode, guardScript, home, runNode, runScript, log] = parts;
  if (guardNode !== runNode || guardScript !== runScript) return null;
  const basename = path.basename(runScript);
  if (!OUR_SCRIPTS.has(basename)) return null;
  if (cur && basename !== m[1]) return null;          // 标记里写的名字要对得上
  const parsed = { node: runNode, script: runScript, home, log, basename,
    form: cur ? "current" : "legacy" };
  // **往返校验**：现行形态必须能被原样重建。历史形态不做（它本来就没有标记行）。
  if (cur && buildHookCommand(parsed) !== command) return null;
  return parsed;
}

/** 这条命令是不是我们的、且正好是这个脚本的。 */
export const ownsHookCommand = (command, basename) =>
  parseHookCommand(command)?.basename === basename;

/**
 * 这条命令是不是**跟安装器现在会写的那条逐字相同**。
 *
 * 上一版只比 parsed.script。评审实测：把 node 换成 /definitely/missing/node、
 * bridge home 和日志路径也改错，doctor 仍报 hooks 正常 ——
 * **只比一个字段等于放过了其余三个**。现在比整条。
 */
export function acceptsHookCommand(command, expected) {
  const parsed = parseHookCommand(command);
  if (parsed === null) return false;
  if (typeof expected === "string") return parsed.script === expected;   // 旧签名
  return command === buildHookCommand(expected);
}
