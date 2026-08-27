#!/usr/bin/env node
/**
 * 只负责跑一次精确的 Codex thread resume，并把进程终局原子落盘。
 *
 * ■ 退出回执是**发布授权凭据的一部分**（第 5 层）
 *
 * watcher 判"这一轮真的跑完了"靠三件终局证据：Codex CLI 写的 `.jsonl` 与
 * `.last-message.txt`，加上这里写的 `.exit.json`。三件都不是 watcher 自己写的 ——
 * 出证者与发资格者不同源，验它才有独立性。所以回执要**带身份**（claim_key，
 * 必须与文件名里的 key 一致）、**封闭 schema 连同取值域**、规范时间。
 *
 * 回执**不写** run_state=completed：runner 只知道进程退出，说不了 JSONL 终局
 * 完整、最终输出非空 —— "完成"是验真器把三件证据合起来推导的，不由任何
 * 单一写方自报。也不写 event_key：那个由可信输入推导，不该是凭据自带的字段。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { CLAIM_KEY_SHAPE } from "../claim.mjs";
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
// 显式参数，不从环境变量隐式取 —— 凭据里的身份必须来自调用方明确给的值。
const claimKey = required("claim-key");
if (!CLAIM_KEY_SHAPE.test(claimKey)) throw new Error("--claim-key 不是 claim key 的形状");
const codexBin = arg("codex-bin") ?? "codex";

let settled = false;
/**
 * 回执的封闭形状（读取端 verifyCodexRunCredential 逐字对账，改一边另一边就红）：
 *   artifact_type   "codex_run_exit_receipt"
 *   schema_version  "1.0"
 *   claim_key       与文件名一致的 64 位十六进制
 *   recorded_at     规范 ISO
 *   status          exited | failed | spawn_failed | artifacts_unreadable
 *   exit_code       exited/artifacts_unreadable ⇒ 0；failed ⇒ 非零整数或 null；spawn_failed ⇒ null
 *   signal          exited/artifacts_unreadable ⇒ null；failed ⇒ 与 exit_code 互斥两档
 *   error           仅 spawn_failed / artifacts_unreadable 分支有，非空字符串
 *   jsonl_sha256 / last_message_sha256   仅 exited 分支有 —— **内容绑定**。
 *
 * 为什么要内容摘要：三个路径都从 key 派生只能证明"B 的回执放在 B 的文件名下"，
 * 证明不了旁边两份内容也是 B 的 —— 评审实测：保留 B 的合法回执、把 A 的 JSONL 与
 * 最终输出覆盖到 B 的文件名，B 的 claim 就授权了 A 的答复。所以成功回执把这两份
 * 字节的 SHA-256 一起封进去；算不出来就写 artifacts_unreadable，永远解释不成完成。
 */
function writeExit(payload) {
  if (settled) return;
  settled = true;
  const tmp = exitPath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    artifact_type: "codex_run_exit_receipt",
    schema_version: "1.0",
    claim_key: claimKey,
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
  if (code !== 0) {
    writeExit({ status: "failed", exit_code: code, signal: signal ?? null });
    process.exitCode = 1;
    return;
  }
  // 先关掉我们自己持有的 fd 再读 —— 子进程已退出，内核写完了，但别留半点悬念。
  try { fs.closeSync(out); } catch { /* 已关 */ }
  let digests;
  try {
    digests = {
      jsonl_sha256: createHash("sha256").update(fs.readFileSync(logPath)).digest("hex"),
      last_message_sha256: createHash("sha256").update(fs.readFileSync(lastMessagePath)).digest("hex"),
    };
  } catch (error) {
    writeExit({ status: "artifacts_unreadable", exit_code: 0, signal: null,
      error: String(error?.message ?? error).slice(0, 300) || "unreadable" });
    process.exitCode = 1;
    return;
  }
  writeExit({ status: "exited", exit_code: 0, signal: null, ...digests });
  process.exitCode = 0;
});

child.stdin.on("error", (error) => {
  if (error.code !== "EPIPE") {
    try { fs.appendFileSync(errPath, "\nstdin: " + error.message + "\n"); } catch { /* best effort */ }
  }
});
child.stdin.end(prompt);
