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

import path from "node:path";
import { shellQuote } from "../shell-quote.mjs";

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
 * 现行形态：**首行必须正好是标记行，其后必须是我们生成的模板**。
 * 只认标记不看后面，等于谁写一句 echo 都能冒充。
 */
const CURRENT = new RegExp(
  "^# " + escapeRe(HOOK_TAG) + "([a-z-]+\\.mjs)\\n" +
  "if \\[ -x '([^']+)' \\] && \\[ -r '([^']+)' \\]; then " +
  "FEISHU_CODEX_BRIDGE_HOME='[^']*' '([^']+)' '([^']+)'; " +
  "else \\{ command -p cat 2>/dev/null \\|\\| cat; \\} >/dev/null 2>&1; " +
  "printf '%s hook-unavailable\\\\n' \"\\$\\(date -u \\+%Y-%m-%dT%H:%M:%SZ\\)\" >> " +
  "'[^']*' 2>/dev/null \\|\\| :; fi$", "u");

/**
 * 历史形态（没有标记行）：只为迁移那一次，同样**整条锚定**。
 */
const LEGACY = new RegExp(
  "^if \\[ -x '([^']+)' \\] && \\[ -r '([^']+)' \\]; then " +
  "FEISHU_CODEX_BRIDGE_HOME='[^']*' '([^']+)' '([^']+)'; " +
  "else \\{ command -p cat 2>/dev/null \\|\\| cat; \\} >/dev/null 2>&1; " +
  "printf '%s hook-unavailable\\\\n' \"\\$\\(date -u \\+%Y-%m-%dT%H:%M:%SZ\\)\" >> " +
  "'[^']*' 2>/dev/null \\|\\| :; fi$", "u");

/**
 * 解析一条命令：是不是我们的、指向哪个脚本。
 *
 * 返回 `null` 表示"不是我们的" —— **安装器据此决定碰不碰，doctor 据此决定认不认，
 * 两边用的是这同一个函数**。
 */
export function parseHookCommand(command) {
  if (typeof command !== "string") return null;
  const cur = CURRENT.exec(command);
  if (cur) {
    const [, tagged, guardNode, guardScript, runNode, runScript] = cur;
    // guard 检查的和实际执行的必须逐字相同；标记里写的名字也要对得上。
    if (guardNode !== runNode || guardScript !== runScript) return null;
    const name = path.basename(runScript);
    if (!OUR_SCRIPTS.has(name) || name !== tagged) return null;
    return { script: runScript, basename: name, form: "current" };
  }
  const old = LEGACY.exec(command);
  if (!old) return null;
  const [, guardNode, guardScript, runNode, runScript] = old;
  if (guardNode !== runNode || guardScript !== runScript) return null;
  const name = path.basename(runScript);
  if (!OUR_SCRIPTS.has(name)) return null;
  return { script: runScript, basename: name, form: "legacy" };
}

/** 这条命令是不是我们的、且正好是这个脚本的。 */
export const ownsHookCommand = (command, basename) =>
  parseHookCommand(command)?.basename === basename;

/** 这条命令是不是**我们的**、且执行的正是期望的那个脚本（逐字相等，不是包含）。 */
export function acceptsHookCommand(command, expectedScript) {
  const parsed = parseHookCommand(command);
  return parsed !== null && parsed.script === expectedScript;
}
