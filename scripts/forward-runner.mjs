/**
 * 转发结果落盘（issue #140）。
 *
 * 2026-09-08 的故障：三条 owner 消息都拿到冒充送达的回执，但转发进程
 * `claude -p` 因本机旧版 Claude Code 不认 settings 里的模型，起来 2–4 秒即报
 * `API Error: 400 …` 退出 —— deliverToLiveSession spawn 后 `unref()` 不看结果，
 * 回执在结果出来之前就发了，消息从未到达会话。
 *
 * 现在由本 runner 承担 spawn：路由器起它（detached + unref，`process.execPath` + 本文件
 * 绝对路径，不走 PATH 上的 node）后秒级返回；它自己起 claude（参数与原先逐字一致，
 * stdout/stderr 仍接 `<key>.forward.jsonl` / `.forward.stderr.log`），等子进程退出后解析
 * stream-json 里 `type === "result"` 那行（没有就按 crash 处理），把结果投影成
 * `<key>.forward.result.json`（tmp + rename 同目录原子写；写不了就往 stderr.log 记一行，
 * 绝不抛 —— 诊断是次要目的，不能反过来伤投递）。
 *
 * 结果文件是「跑完的事实」，不是回执：给不给 Frank 发失败回执要单独授权（另单），这里只落盘。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { ROLE_ENV } from "./live-session.mjs";

export const FORWARD_RESULT_SCHEMA = "forward_result_v1";

/** 逐段扫 PATH 找可执行文件 —— 也就是 which。找不到返回 null。 */
function resolveOnPath(name, envPath) {
  for (const dir of String(envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 这一段没有或不可执行：看下一段 */ }
  }
  return null;
}

/** result 行 / init 行 / 最后一条非空助手文本。坏行跳过 —— 坏行造成的 result 缺席自然按 crash 投影。 */
function parseRunLines(lines) {
  const resultLine = [...lines].reverse().find((l) => l?.type === "result") ?? null;
  const initLine = lines.find((l) => l?.type === "system" && l.subtype === "init") ?? null;
  const texts = lines
    .filter((l) => l?.type === "assistant")
    .map((l) => (Array.isArray(l?.message?.content) ? l.message.content : [])
      .filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(""))
    .filter((t) => t.trim() !== "");
  return { resultLine, initLine, lastAssistantText: texts[texts.length - 1] ?? "" };
}

/**
 * 投影成 forward_result_v1。纯函数，三种结局在这里定型：
 *   成功     → result 行 is_error=false、prompt 要求只回 "sent"，sent 据此判定；
 *   result 报错（#140 的 400）→ is_error=true，reason_first_line 取错误文本第一行；
 *   崩溃     → 无 result 行（进程起不来 / 秒退 / jsonl 只有半截行）→ is_error=true、
 *              subtype="crash"、duration_ms 用 wall clock（#140 里那 2–4 秒本身就是证据）。
 */
function summarizeForwardRun({ spec, pid = null, exitCode = null, lines = [], claudePath = null, startedAt = null, finishedAt, notFound = false }) {
  const { resultLine, initLine, lastAssistantText } = parseRunLines(lines);
  const crashed = !notFound && resultLine === null;
  const finalText = resultLine === null ? "" : (typeof resultLine.result === "string" ? resultLine.result : lastAssistantText);
  const is_error = notFound || crashed || resultLine.is_error === true;
  const reason_first_line = notFound ? "claude_not_found"
    : crashed ? "no_result_line" + (exitCode === null ? "" : "(exit=" + exitCode + ")")
    : String(finalText).split("\n", 1)[0];
  return {
    schema: FORWARD_RESULT_SCHEMA,
    key: spec.key,
    target_name: spec.targetName,
    pid,
    exit_code: exitCode,
    is_error,
    subtype: notFound ? "claude_not_found" : crashed ? "crash" : (resultLine.subtype ?? null),
    num_turns: crashed || notFound || !Number.isFinite(resultLine.num_turns) ? null : resultLine.num_turns,
    duration_ms: notFound ? null
      : crashed ? Math.max(0, finishedAt - startedAt)
      : Number.isFinite(resultLine.duration_ms) ? resultLine.duration_ms : null,
    claude_code_version: initLine?.claude_code_version ?? initLine?.version ?? null,
    model: initLine?.model ?? resultLine?.model ?? null,
    reason_first_line,
    sent: String(finalText).trim() === "sent",
    finished_at: new Date(finishedAt).toISOString(),
    claude_path: claudePath,
  };
}

/** tmp + rename 同目录原子写；失败往 stderr.log 记一行，两层都不许抛。 */
function writeResultFile(resultPath, errPath, doc) {
  const tmp = resultPath + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, resultPath);
  } catch (err) {
    try {
      fs.appendFileSync(errPath, new Date().toISOString() + " forward_result_write_failed " +
        String(err?.message ?? err).slice(0, 200) + "\n", { mode: 0o600 });
    } catch { /* 连 stderr.log 都写不了：只能放弃，绝不抛 */ }
  }
}

function readJsonlLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半截/坏行：跳过 */ }
  }
  return out;
}

function runForwardRunner(spec) {
  const runsDir = spec.runsDir;
  const jsonlPath = path.join(runsDir, spec.key + ".forward.jsonl");
  const errPath = path.join(runsDir, spec.key + ".forward.stderr.log");
  const resultPath = path.join(runsDir, spec.key + ".forward.result.json");

  const claudePath = resolveOnPath("claude", process.env.PATH);
  if (claudePath === null) {
    writeResultFile(resultPath, errPath, summarizeForwardRun({
      spec, startedAt: Date.now(), finishedAt: Date.now(), notFound: true,
    }));
    return;
  }

  const out = fs.openSync(jsonlPath, "a");
  const err = fs.openSync(errPath, "a");
  const startedAt = Date.now();
  let child = null;
  try {
    child = spawn(
      claudePath,
      ["-p", spec.prompt, "--output-format", "stream-json", "--verbose"],
      {
        cwd: spec.projectRoot, stdio: ["ignore", out, err],
        env: { ...process.env, [ROLE_ENV]: "forwarder" },
      },
    );
  } catch {
    // spawn 同步抛（罕见：参数形不对）：也按 crash 落盘，不许 runner 崩了不写结果
    writeResultFile(resultPath, errPath, summarizeForwardRun({
      spec, lines: readJsonlLines(jsonlPath), claudePath, startedAt, finishedAt: Date.now(),
    }));
    return;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }

  let done = false;
  const finish = (exitCode) => {
    if (done) return; // spawn 失败时 error 与 close 可能都来：结果只写一份
    done = true;
    writeResultFile(resultPath, errPath, summarizeForwardRun({
      spec, pid: child.pid, exitCode, lines: readJsonlLines(jsonlPath),
      claudePath, startedAt, finishedAt: Date.now(),
    }));
  };
  child.on("error", () => finish(null));
  child.on("close", (code) => finish(Number.isFinite(code) ? code : null));
}

if (isDirectRun(import.meta.url)) {
  let spec = null;
  try { spec = JSON.parse(process.argv[2] ?? ""); } catch { /* 下面统一拒 */ }
  const bad = !spec || typeof spec !== "object"
    || typeof spec.key !== "string" || !spec.key || spec.key.includes("/") || spec.key.includes("\\") || spec.key === ".."
    || typeof spec.runsDir !== "string" || typeof spec.projectRoot !== "string"
    || typeof spec.targetName !== "string" || typeof spec.prompt !== "string";
  if (bad) {
    process.stderr.write("forward-runner：spec 不对（需要 key/runsDir/projectRoot/targetName/prompt 的 JSON）\n");
    process.exit(2);
  }
  runForwardRunner(spec);
}
