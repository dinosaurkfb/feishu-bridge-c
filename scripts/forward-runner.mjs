/**
 * 转发结果落盘（issue #140；R54 返修一 = Codex #141 一轮）。
 *
 * 2026-09-08 的故障：三条 owner 消息都拿到冒充送达的回执，但转发进程 `claude -p` 因本机
 * 旧版 Claude Code 不认 settings 里的模型，起来 2–4 秒即报 `API Error: 400 …` 退出 ——
 * deliverToLiveSession spawn 后 `unref()` 不看结果，回执在结果出来之前就发了，消息从未到达会话。
 *
 * 现在由本 runner 承担 spawn：路由器起它（detached + unref，`process.execPath` + 本文件
 * 绝对路径，不走 PATH 上的 node）后秒级返回；它自己起 claude（detached + unref，与旧路径
 * 一致——runner 死了 claude 也不陪葬；runner 用自己的 keepalive 定时器撑住事件循环等
 * close），等退出后解析 stream-json 里 `type === "result"` 那行（没有就按 crash 处理），
 * 把结果投影成 `<key>.forward.result.json`；spawn 成功后立刻落 `<key>.forward.started.json`
 * （doctor 的孤儿判定要靠它区分「还在跑」和「runner 崩了」）。
 *
 * 落盘纪律（#141 P1-5）：tmp 用 O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW + 0600 打开（fd 写、
 * fsync、close），rename 前目标若是 symlink 不跟随不覆盖；rename 后读回 SHA 核等才算落盘，
 * 再 fsync 目录；失败清自己建的 tmp，诊断记一行到 stderr.log，绝不抛。读回 jsonl 只读
 * 末尾 256 KiB（超大文件不整读）。
 *
 * 结果文件是「跑完的事实」，不是回执：给不给 Frank 发失败回执要单独授权（另单），这里只落盘。
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { ROLE_ENV } from "./live-session.mjs";

export const FORWARD_RESULT_SCHEMA = "forward_result_v1";
export const FORWARD_STARTED_SCHEMA = "forward_started_v1";
const TAIL_READ_BYTES = 256 * 1024; // jsonl 只读尾部（#141 P1-5）

/** result.json 键集（封闭）：写端投影与读端校验共用这一份。 */
const RESULT_KEYS = "claude_code_version,claude_path,duration_ms,exit_code,finished_at,is_error,key,model,num_turns,pid,reason_first_line,sent,subtype,target_name,schema".split(",").sort().join(",");
const STARTED_KEYS = "claude_pid,key,runner_pid,started_at,schema".split(",").sort().join(",");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (o) => Object.keys(o).sort().join(",");
const isSafeInt = (v) => Number.isSafeInteger(v);
const strOrNull = (v, cap) => (v === null ? true : typeof v === "string" && v.length <= cap);

/**
 * result.json 的唯一封闭校验器（#141 P1-2）：写端落盘前自校验、doctor 读端共用。
 * problem 非空 → 写端不落盘 / 读端按查不清点名。
 */
export function forwardResultProblem(doc, { now = Date.now() } = {}) {
  if (!isObj(doc)) return "result 文档不是对象";
  if (keysOf(doc) !== RESULT_KEYS) return "result 字段集不对";
  if (doc.schema !== FORWARD_RESULT_SCHEMA) return "schema 不认识: " + String(doc.schema);
  if (typeof doc.key !== "string" || !doc.key || doc.key.includes("/") || doc.key.includes("\\")) return "key 形状不对";
  if (typeof doc.target_name !== "string" || doc.target_name.length > 200) return "target_name 形状不对";
  if (doc.pid !== null && !isSafeInt(doc.pid)) return "pid 形状不对";
  if (doc.exit_code !== null && !isSafeInt(doc.exit_code)) return "exit_code 形状不对";
  if (typeof doc.is_error !== "boolean") return "is_error 缺席或非布尔（缺席按 problem，不按 false）";
  if (doc.subtype !== null && (typeof doc.subtype !== "string" || doc.subtype.length > 200)) return "subtype 形状不对";
  if (doc.num_turns !== null && !isSafeInt(doc.num_turns)) return "num_turns 形状不对";
  if (doc.duration_ms !== null && (!isSafeInt(doc.duration_ms) || doc.duration_ms < 0)) return "duration_ms 形状不对";
  if (!strOrNull(doc.claude_code_version, 200)) return "claude_code_version 形状不对";
  if (!strOrNull(doc.model, 200)) return "model 形状不对";
  if (!strOrNull(doc.reason_first_line, 200)) return "reason_first_line 形状不对";
  if (typeof doc.sent !== "boolean") return "sent 非布尔";
  // sent === true 的充要前提：is_error=false 且 exit_code=0（result 行文本严格 "sent" 由写端公式保证，
  // 不得从 assistant 文本补造 —— 校验器把可核的三个条件钉死）。
  if (doc.sent === true && (doc.is_error !== false || doc.exit_code !== 0)) return "sent=true 但 is_error/exit_code 不满足";
  if (!isCanonicalIso(doc.finished_at)) return "finished_at 不是规范化 ISO";
  if (Date.parse(doc.finished_at) > now + 60_000) return "finished_at 晚于写入时刻 +60s";
  if (doc.claude_path !== null && typeof doc.claude_path !== "string") return "claude_path 形状不对";
  return null;
}

/** started.json 的封闭校验器（#141 P1-4）。 */
export function forwardStartedProblem(doc, { now = Date.now() } = {}) {
  if (!isObj(doc)) return "started 文档不是对象";
  if (keysOf(doc) !== STARTED_KEYS) return "started 字段集不对";
  if (doc.schema !== FORWARD_STARTED_SCHEMA) return "schema 不认识: " + String(doc.schema);
  if (typeof doc.key !== "string" || !doc.key || doc.key.includes("/") || doc.key.includes("\\")) return "key 形状不对";
  if (!isSafeInt(doc.runner_pid) || !isSafeInt(doc.claude_pid)) return "pid 形状不对";
  if (!isCanonicalIso(doc.started_at)) return "started_at 不是规范化 ISO";
  if (Date.parse(doc.started_at) > now + 60_000) return "started_at 晚于写入时刻 +60s";
  return null;
}

/** 逐段扫 PATH 找可执行文件 —— 也就是 which。找不到返回 null。
 *  空分量按 execvp 语义 = 当前目录（path.join("", name) 得相对路径，stat/spawn 都相对 cwd 解析），
 *  与 execvp 保持一致，不做额外跳过。 */
function resolveOnPath(name, envPath) {
  for (const dir of String(envPath ?? "").split(path.delimiter)) {
    const candidate = dir === "" ? name : path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 这一段没有或不可执行：看下一段 */ }
  }
  return null;
}

/** result 行 / init 行。坏行跳过 —— 坏行造成的 result 缺席自然按 crash 投影。 */
function parseRunLines(lines) {
  const resultLine = [...lines].reverse().find((l) => l?.type === "result") ?? null;
  const initLine = lines.find((l) => l?.type === "system" && l.subtype === "init") ?? null;
  return { resultLine, initLine };
}

/**
 * 投影成 forward_result_v1。纯函数，三种结局在这里定型：
 *   成功     → result 行 is_error=false、prompt 要求只回 "sent"；sent 只认 result 行文本严格 "sent"
 *              且 is_error=false 且 exit_code=0（#141 P1-2：不从 assistant 文本补造）；
 *   result 报错（#140 的 400）→ is_error=true，reason_first_line 取错误文本第一行；
 *   崩溃     → 无 result 行（进程起不来 / 秒退 / jsonl 只有半截行）→ is_error=true、
 *              subtype="crash"、duration_ms 用 wall clock（#140 里那 2–4 秒本身就是证据）。
 */
function summarizeForwardRun({ spec, pid = null, exitCode = null, lines = [], claudePath = null, startedAt = null, finishedAt, notFound = false }) {
  const { resultLine, initLine } = parseRunLines(lines);
  const crashed = !notFound && resultLine === null;
  const resultText = resultLine !== null && typeof resultLine.result === "string" ? resultLine.result : "";
  const is_error = notFound || crashed || resultLine.is_error === true;
  const reason_first_line = notFound ? "claude_not_found"
    : crashed ? "no_result_line" + (exitCode === null ? "" : "(exit=" + exitCode + ")")
    : resultText.split("\n", 1)[0];
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
    sent: !is_error && exitCode === 0 && resultText === "sent",
    finished_at: new Date(finishedAt).toISOString(),
    claude_path: claudePath,
  };
}

/** 目录 fsync（rename 后持久化目录项；测试可注入失败）。 */
function fsyncDirOf(dir) {
  let dfd = null;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(dfd);
  } catch { /* 目录 fsync 在部分文件系统上不可用：忽略（与仓里 dirFsyncIgnorable 同判） */ }
  finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
}

/**
 * 原子落盘（#141 P1-5）：tmp 用 O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW + 0600（fd 写、fsync、close），
 * 目标已是 symlink → 不跟随不覆盖（记诊断后放弃）；rename 后读回 SHA 核等才算落盘，再 fsync 目录；
 * 失败清自己建的 tmp，记一行到 stderr.log，绝不抛。
 */
function writeDocFile(targetPath, errPath, doc, maxBytes) {
  const bytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf-8");
  if (bytes.length > maxBytes) { noteErr(errPath, "result 超过大小上限（" + bytes.length + "），不落盘"); return; }
  try {
    try { if (fs.lstatSync(targetPath).isSymbolicLink()) { noteErr(errPath, "目标已是符号链接，不跟随不覆盖：" + targetPath); return; } } catch { /* 不在更好 */ }
    const tmp = targetPath + ".tmp." + process.pid;
    let fd = null;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }
    try {
      fs.renameSync(tmp, targetPath);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉就留着交盘点 */ }
      throw err;
    }
    const back = fs.readFileSync(targetPath);
    if (crypto.createHash("sha256").update(back).digest("hex") !== crypto.createHash("sha256").update(bytes).digest("hex")) {
      noteErr(errPath, "落盘读回 SHA 不等：" + targetPath);
      return;
    }
    fsyncDirOf(path.dirname(targetPath));
  } catch (err) {
    noteErr(errPath, String(err?.code ?? err?.message ?? err).slice(0, 200));
  }
}

function noteErr(errPath, line) {
  try { fs.appendFileSync(errPath, new Date().toISOString() + " forward_result_note " + line + "\n", { mode: 0o600 }); } catch { /* 记不了就算了 */ }
}

/** 写端自校验（#141 P1-2）：problem 非空 → 不落盘、记 stderr.log。 */
function writeValidatedDoc(targetPath, errPath, doc, problemFn, maxBytes) {
  const problem = problemFn(doc, { now: Date.now() });
  if (problem !== null) { noteErr(errPath, "自校验失败不落盘（" + path.basename(targetPath) + "）：" + problem); return; }
  writeDocFile(targetPath, errPath, doc, maxBytes);
}

/** 有界读：只取文件末尾 256 KiB（O_NOFOLLOW 打开、同 fd fstat），逐行 JSON 解析，坏行跳过。 */
function readJsonlLines(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    const start = Math.max(0, st.size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(st.size - start);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    const out = [];
    for (const line of buf.toString("utf-8", 0, off).split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 半截/坏行：跳过（尾部截断的第一行天然半截） */ }
    }
    return out;
  } catch { return []; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }
}

function runForwardRunner(spec) {
  const runsDir = spec.runsDir;
  const jsonlPath = path.join(runsDir, spec.key + ".forward.jsonl");
  const errPath = path.join(runsDir, spec.key + ".forward.stderr.log");
  const startedPath = path.join(runsDir, spec.key + ".forward.started.json");
  const resultPath = path.join(runsDir, spec.key + ".forward.result.json");

  const claudePath = resolveOnPath("claude", process.env.PATH);
  if (claudePath === null) {
    writeValidatedDoc(resultPath, errPath, summarizeForwardRun({
      spec, startedAt: Date.now(), finishedAt: Date.now(), notFound: true,
    }), forwardResultProblem, 64 * 1024);
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
        cwd: spec.projectRoot, detached: true, stdio: ["ignore", out, err],
        env: { ...process.env, [ROLE_ENV]: "forwarder" },
      },
    );
  } catch {
    // spawn 同步抛（罕见：参数形不对）：也按 crash 落盘，不许 runner 崩了不写结果
    writeValidatedDoc(resultPath, errPath, summarizeForwardRun({
      spec, lines: readJsonlLines(jsonlPath), claudePath, startedAt, finishedAt: Date.now(),
    }), forwardResultProblem, 64 * 1024);
    return;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  child.unref(); // 与旧路径一致（runner 死了 claude 不陪葬）；事件循环由下面的 keepalive 撑住等 close
  writeValidatedDoc(startedPath, errPath, {
    schema: FORWARD_STARTED_SCHEMA, key: spec.key, runner_pid: process.pid,
    claude_pid: child.pid, started_at: new Date(startedAt).toISOString(),
  }, forwardStartedProblem, 16 * 1024);

  let done = false;
  const keepalive = setInterval(() => {}, 60_000);
  const finish = (exitCode) => {
    if (done) return; // spawn 失败时 error 与 close 可能都来：结果只写一份
    done = true;
    clearInterval(keepalive);
    writeValidatedDoc(resultPath, errPath, summarizeForwardRun({
      spec, pid: child.pid, exitCode, lines: readJsonlLines(jsonlPath),
      claudePath, startedAt, finishedAt: Date.now(),
    }), forwardResultProblem, 64 * 1024);
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
