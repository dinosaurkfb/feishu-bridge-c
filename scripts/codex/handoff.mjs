/** Codex 精确 thread 的非阻塞投递与严格终局解析。 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { moduleDir } from "../direct-run.mjs";

const HERE = moduleDir(import.meta.url);
const RUNNER = path.join(HERE, "run-resume.mjs");

/** 目标 Codex task 不能继承 M5Codex/Aily 入站身份，否则 hook 会把它再次路由。 */
export function sanitizeCodexRunEnv(env = process.env, overrides = {}) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("AILY_CLI_")) clean[name] = value;
  }
  return { ...clean, ...overrides };
}

export function assertCodexAvailable(codexBin = "codex") {
  if (codexBin.includes("/")) {
    fs.accessSync(codexBin, fs.constants.X_OK);
    return;
  }
  try {
    execFileSync("command", ["-v", codexBin], { shell: "/bin/sh", stdio: "ignore", timeout: 5000 });
  } catch {
    throw new Error("codex 不在 PATH 上，无法投递");
  }
}

export function handOffCodex({
  projectDir, threadId, instruction, runsDir, key, taskKey, bridgeHome, codexBin = "codex",
}) {
  assertCodexAvailable(codexBin);
  if (typeof threadId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("绑定里的 codex_thread_id 不是精确 UUID，拒绝使用名字或 --last");
  }
  if (!path.isAbsolute(projectDir)) throw new Error("projectDir 必须是绝对路径");
  if (!fs.statSync(projectDir).isDirectory()) throw new Error("绑定的 projectDir 不再是目录");

  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const instructionPath = path.join(runsDir, key + ".prompt.txt");
  const logPath = path.join(runsDir, key + ".jsonl");
  const errPath = path.join(runsDir, key + ".stderr.log");
  const lastMessagePath = path.join(runsDir, key + ".last-message.txt");
  const exitPath = path.join(runsDir, key + ".exit.json");
  const runnerLog = path.join(runsDir, key + ".runner.log");
  fs.writeFileSync(instructionPath, instruction, { mode: 0o600 });

  const child = spawn(process.execPath, [
    RUNNER,
    "--thread-id", threadId,
    "--project", projectDir,
    "--instruction-file", instructionPath,
    "--log", logPath,
    "--stderr", errPath,
    "--last-message", lastMessagePath,
    "--exit-receipt", exitPath,
    "--codex-bin", codexBin,
  ], {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", fs.openSync(runnerLog, "a"), fs.openSync(runnerLog, "a")],
    env: sanitizeCodexRunEnv(process.env, {
      FEISHU_BRIDGE_ROLE: "codex-run",
      FEISHU_BRIDGE_CLAIM_KEY: key,
      FEISHU_BRIDGE_TASK_KEY: taskKey,
      ...(bridgeHome ? { FEISHU_CODEX_BRIDGE_HOME: bridgeHome } : {}),
    }),
  });
  child.unref();

  return {
    mode: "codex_thread",
    pid: child.pid,
    logPath,
    errPath,
    lastMessagePath,
    exitPath,
    instructionPath,
    targetSessionId: threadId,
    startedAt: new Date().toISOString(),
  };
}

export function classifyRunnerDiagnostic(stderr) {
  const text = String(stderr ?? "").toLowerCase();
  if (text.includes("not inside a trusted directory") && text.includes("skip-git-repo-check")) {
    return "git_repository_required";
  }
  if (text.includes("session") && text.includes("not found")) return "session_not_found";
  if (text.includes("hook") && text.includes("trust")) return "hook_trust_required";
  return null;
}

const DIRECT_INBOUND_EXECUTION = /^(?:exec\s+)?(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:[^\s"';&|]*\/)?node(?:js)?(?:\s+(?:-r|--require)\s+[^\s"';&|]+|\s+--[^\s"';&|]+|\s+-[A-Za-z]+)*\s+["']?(?:[^\s"';&|]*\/)?scripts\/codex\/(?:aily-)?inbound\.mjs["']?(?:\s|$)/u;

/**
 * 只把真正执行 Codex 入站入口的 shell segment 认作递归。
 *
 * 读取、搜索、diff、git add 或测试代码中引用同一路径都不是执行；旧的 contains 判定会把
 * 正常开发和故障排查误报为 bridge_recursion。这里只支持桥自己会生成的直接 node 形态，
 * 未知复杂 shell 形态保持 fail-safe：不会用一个任意字符串命中覆盖真实 turn.completed。
 */
const SHELL_WRAPPER =
  /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:[^\s"']*\/)?(?:zsh|bash|sh)\s+-l?c\s+(["'])([\s\S]*)\1$/u;

/**
 * 双引号包裹体内的 shell 转义要还原，否则剥壳等于没剥。
 *
 * 这不是理论洁癖：`~/.codex/skills/m5codex-inbound-router/SKILL.md` 里那条命令的路径**就是**
 * 用双引号括起来的，而 Codex 实际执行的命令**一律**是 `/bin/zsh -lc "..."` 形态 —— 两者叠加，
 * 内层就成了 `node \"/…/aily-inbound.mjs\"`。不还原的话 `\"` 会把路径匹配打断，
 * 于是**真正的递归调用**从检测里漏掉，方向从旧版的过度检测翻成漏检测。
 *
 * 单引号包裹体在 POSIX shell 里不处理任何转义，原样返回才是对的。
 */
const unescapeDoubleQuoted = (body) => body.replace(/\\(["\\$`])/gu, "$1");

/**
 * 只在**引号之外**按 `;` `|` `&&` `||` 分段，并按 shell 语义处理引号与转义。
 *
 * 按原始文本无差别切分会造出新的误报：引号里的分隔符并不开启新命令。
 *   echo "ignore; node …/inbound.mjs"        —— `;` 在双引号内
 *   rg -n "x|node …/inbound.mjs" scripts     —— `|` 在双引号内
 * 两者都只是一条 echo / rg，切开后却会冒出一个看起来像执行的片段。
 *
 * 顶层的反斜杠保留原样，不做还原：双引号内 `\'` 并不是合法转义（POSIX 双引号不转义单引号），
 * 把它当成干净引号会让 `node \'…/inbound.mjs\'` 被误判成执行。
 */
const splitTopLevelSegments = (text) => {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else current += ch;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\" && i + 1 < text.length && "\"\\$`".includes(text[i + 1])) {
        current += text[i + 1];
        i += 1;
      } else if (ch === "\"") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") { quote = ch; continue; }
    if (ch === "\\" && i + 1 < text.length) { current += ch + text[i + 1]; i += 1; continue; }
    if (ch === ";" || ch === "|" || ch === "&") {
      if ((ch === "|" || ch === "&") && text[i + 1] === ch) i += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
};

export function isCodexInboundExecution(command) {
  if (typeof command !== "string" || command.trim().length === 0) return false;
  let text = command.trim();
  // 逐层剥壳（`zsh -lc "bash -lc \"…\""` 这类嵌套真实存在），但设上界，
  // 不让一个畸形字符串把这里变成不停机的循环。
  for (let depth = 0; depth < 4; depth += 1) {
    const wrapped = text.match(SHELL_WRAPPER);
    if (!wrapped) break;
    const [, quote, body] = wrapped;
    text = (quote === "\"" ? unescapeDoubleQuoted(body) : body).trim();
  }
  // 不按换行拆分：换行后的文本可能是 heredoc/测试夹具，不代表新的 shell command。
  return splitTopLevelSegments(text).some((segment) =>
    DIRECT_INBOUND_EXECUTION.test(segment.trim().replace(/^[('"\s]+/u, "")));
}

export function readCodexRunOutcome({ logPath, exitPath, lastMessagePath, errPath, expectedThreadId }) {
  let raw = "";
  try { raw = fs.readFileSync(logPath, "utf-8"); } catch { /* runner 可能刚启动 */ }

  let observedThreadId = null;
  let turnStarted = false;
  let turnCompleted = false;
  let turnFailed = false;
  let recoverableErrors = 0;
  let invalidJsonLines = 0;
  let threadMismatch = false;
  let bridgeRecursion = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { invalidJsonLines += 1; continue; }
    if (event.type === "thread.started") {
      observedThreadId = event.thread_id ?? null;
      if (observedThreadId !== expectedThreadId) threadMismatch = true;
    }
    if (event.type === "turn.started") turnStarted = true;
    if (event.type === "turn.completed") turnCompleted = true;
    if (event.type === "turn.failed") turnFailed = true;
    if (event.type === "error") recoverableErrors += 1;
    if (event.item?.type === "command_execution" &&
        isCodexInboundExecution(event.item.command)) bridgeRecursion = true;
  }

  let exit = null;
  try { exit = JSON.parse(fs.readFileSync(exitPath, "utf-8")); } catch { /* 仍在运行 */ }
  if (!exit) return { state: "running", observedThreadId, turnStarted, turnCompleted };

  if (invalidJsonLines > 0) return { state: "failed", reason: "invalid_jsonl", invalidJsonLines };
  // 只有真实观察到另一个 thread 才叫 mismatch。CLI 在前置检查阶段退出时根本没有
  // thread.started；把 null 当成另一个 thread 会掩盖真正的启动错误。
  if (threadMismatch || (observedThreadId !== null && observedThreadId !== expectedThreadId)) {
    return { state: "failed", reason: "thread_mismatch", observedThreadId, expectedThreadId };
  }
  if (bridgeRecursion) return { state: "failed", reason: "bridge_recursion" };
  if (exit.status === "spawn_failed") {
    return { state: "failed", reason: "runner_spawn_failed" };
  }
  if (turnFailed) return { state: "failed", reason: "turn_failed" };
  if (exit.exit_code !== 0) {
    let stderr = "";
    try { stderr = fs.readFileSync(errPath, "utf-8").slice(-4000); } catch { /* 没有 stderr */ }
    return {
      state: "failed",
      reason: observedThreadId === null ? "runner_preflight_failed" : "nonzero_exit",
      exitCode: exit.exit_code,
      diagnostic: classifyRunnerDiagnostic(stderr),
    };
  }
  if (observedThreadId === null) return { state: "failed", reason: "thread_started_missing" };
  if (!turnStarted) return { state: "failed", reason: "turn_started_missing" };
  if (!turnCompleted) return { state: "failed", reason: "turn_completed_missing" };

  let finalText = null;
  try { finalText = fs.readFileSync(lastMessagePath, "utf-8").trim(); } catch { /* below */ }
  if (!finalText) return { state: "failed", reason: "final_message_missing" };
  return { state: "completed", finalText, recoverableErrors, observedThreadId };
}
