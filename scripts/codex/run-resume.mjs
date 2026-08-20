#!/usr/bin/env node
/** 只负责跑一次精确的 Codex thread resume，并把进程终局原子落盘。 */

import { spawn } from "node:child_process";
import fs from "node:fs";

import { sanitizeCodexRunEnv } from "./handoff.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const required = (name) => {
  const value = arg(name);
  if (typeof value !== "string" || !value) throw new Error("缺 --" + name);
  return value;
};

const threadId = required("thread-id");
const projectDir = required("project");
const instructionFile = required("instruction-file");
const logPath = required("log");
const errPath = required("stderr");
const lastMessagePath = required("last-message");
const exitPath = required("exit-receipt");
const codexBin = arg("codex-bin") ?? "codex";

let settled = false;
function writeExit(payload) {
  if (settled) return;
  settled = true;
  const tmp = exitPath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: "1.0",
    recorded_at: new Date().toISOString(),
    ...payload,
  }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, exitPath);
}

const out = fs.openSync(logPath, "a");
const err = fs.openSync(errPath, "a");
const prompt = fs.readFileSync(instructionFile);

const child = spawn(codexBin, [
  // task.root 来自用户明确确认后写入的精确绑定，可能是包含多个仓库的 Codex workspace，
  // 不一定自身带 .git。这里只跳过 Git 仓库前置检查，不改变 sandbox 或 approval 权限。
  "exec", "resume", "--skip-git-repo-check", "--json",
  "--output-last-message", lastMessagePath, threadId, "-",
], {
  cwd: projectDir,
  // 双保险：即使 runner 被其他入口直接调用，也不把 M5Codex/Aily 入站身份传进目标 task。
  env: sanitizeCodexRunEnv(process.env),
  stdio: ["pipe", out, err],
});

child.once("error", (error) => {
  writeExit({ status: "spawn_failed", exit_code: null, signal: null, error: error.message.slice(0, 300) });
  process.exitCode = 1;
});

child.once("close", (code, signal) => {
  writeExit({ status: code === 0 ? "exited" : "failed", exit_code: code, signal: signal ?? null });
  process.exitCode = code === 0 ? 0 : 1;
});

child.stdin.on("error", (error) => {
  if (error.code !== "EPIPE") {
    try { fs.appendFileSync(errPath, "\nstdin: " + error.message + "\n"); } catch { /* best effort */ }
  }
});
child.stdin.end(prompt);
