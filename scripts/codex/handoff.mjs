/** Codex 精确 thread 的非阻塞投递与严格终局解析。 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUNNER = path.join(HERE, "run-resume.mjs");

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
    env: {
      ...process.env,
      FEISHU_BRIDGE_ROLE: "codex-run",
      FEISHU_BRIDGE_CLAIM_KEY: key,
      FEISHU_BRIDGE_TASK_KEY: taskKey,
      ...(bridgeHome ? { FEISHU_CODEX_BRIDGE_HOME: bridgeHome } : {}),
    },
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

export function readCodexRunOutcome({ logPath, exitPath, lastMessagePath, expectedThreadId }) {
  let raw = "";
  try { raw = fs.readFileSync(logPath, "utf-8"); } catch { /* runner 可能刚启动 */ }

  let observedThreadId = null;
  let turnStarted = false;
  let turnCompleted = false;
  let turnFailed = false;
  let recoverableErrors = 0;
  let invalidJsonLines = 0;
  let threadMismatch = false;
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
  }

  let exit = null;
  try { exit = JSON.parse(fs.readFileSync(exitPath, "utf-8")); } catch { /* 仍在运行 */ }
  if (!exit) return { state: "running", observedThreadId, turnStarted, turnCompleted };

  if (invalidJsonLines > 0) return { state: "failed", reason: "invalid_jsonl", invalidJsonLines };
  if (threadMismatch || observedThreadId !== expectedThreadId) {
    return { state: "failed", reason: "thread_mismatch", observedThreadId, expectedThreadId };
  }
  if (turnFailed) return { state: "failed", reason: "turn_failed" };
  if (exit.exit_code !== 0) return { state: "failed", reason: "nonzero_exit", exitCode: exit.exit_code };
  if (!turnStarted) return { state: "failed", reason: "turn_started_missing" };
  if (!turnCompleted) return { state: "failed", reason: "turn_completed_missing" };

  let finalText = null;
  try { finalText = fs.readFileSync(lastMessagePath, "utf-8").trim(); } catch { /* below */ }
  if (!finalText) return { state: "failed", reason: "final_message_missing" };
  return { state: "completed", finalText, recoverableErrors, observedThreadId };
}
