#!/usr/bin/env node
/**
 * 频道定位采样旁路（#R11 内部构件）。
 *
 * 目的：给入站链加一条「不承重」的采样线，把每条入站消息的频道 locator 对照结果
 * 记到 <bridgeHome>/inbound/channel-samples.jsonl，供后来人肉核验
 * AILY_CLI_CHANNEL_CHAT_ID 到底映射的是群还是私聊。
 *
 * 纪律（与主流程严格隔离，#R9 修订版）：
 *  - 采样失败绝不阻断 / 不回退入站流程；也**绝不污染模型可见输出**——Aily 会把
 *    stdout+stderr 合并进模型上下文，所以失败一个字都不往进程输出写。
 *    appendChannelSample 全包 try/catch，失败静默返回 { ok:false, reason }，调用方当没听见；
 *    失败原因**追加到机器级诊断文件** <dir>/channel-samples.diag.log（同样全包 try/catch，
 *    写不进就彻底放弃——诊断的诊断不再递归）。注意：诊断文件也不进进程输出，是落盘。
 *  - 写方与读方共用唯一封闭校验器 channelSampleProblem：精确键集、规范 ISO、哈希
 *    null|^[0-9a-f]{16}$、chain/disposition 封闭且有界。**坏行写不出去、读不进来**——
 *    本批数据要用来判断 locator 能否提升为可信事实，不能把不符写方封闭 shape 的行当干净证据。
 *  - locator 不外泄：session / channel chat / channel thread / message_id 一律 sha256 前
 *    16 位落行。Aily 的 message_id 本身就是 om_ 前缀，写明文会漏。matches_template_chat
 *    用布尔表达（true = 频道 == 模板群，false = 不一致，null = 频道或模板 chat_id 缺失）。
 *  - 只写 machine 级目录（UNROUTED_RT / FEISHU_CODEX_BRIDGE_HOME 的 inbound/），
 *    绝不写项目 runtime，避免每装一版就换地方。
 *
 * 计划：实验期短、行小，文件不轮转。等 Frank 拿到对照结论、chat locator 验证完成后，
 * 本旁路连同本文件、两条链里的 recordChannelSample 调用一起整体移除，不留半成品。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isCanonicalIso } from "./canonical-time.mjs";

const SCHEMA_VERSION = "1.0";
const CHAINS = Object.freeze(["claude", "codex"]);
// 精确键集：行允许的键一个不多一个不少（缺键或多余的 raw_locator 一律拒）。
const KEYS = Object.freeze([
  "schema_version", "at", "chain", "message_id", "session_sha16",
  "channel_chat_sha16", "channel_thread_sha16", "matches_template_chat", "disposition",
]);
// 非 rejected 的终态枚举。**accepted 必在列**：入站成功投递的收口是 finish("accepted", …)，
// 缺它会让真正的成功路径产出的行被 channelSampleProblem 拒掉、静默丢行（#R10 评审 P1-1）。
const DISPOSITION_KINDS = Object.freeze(["chat", "control", "bound", "accepted", "error"]);
// rejected 的原因词：用形状封闭（snake_case、首字符字母、长度 ≤ 64）而非从判定逻辑里引
// PROMOTE_REJECT 词表——引词表会让本旁路耦合到判定代码、且未来词表增删就全绿→红。形状足够。
const REASON_PATTERN = /^rejected:[a-z][a-z0-9_]{0,63}$/;

/** sha256 前 16 位；空串 / 非字符串 → null（缺字段就是缺，不造假）。 */
export function channelSampleSha16(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * 终态短词：不用新造状态机，直接取入站 finish 的 kind。
 * rejected 带上原因（rejected:<reason>），其余就用 kind 本身（chat / control / bound / error）。
 */
export function channelDisposition(kind, reason) {
  return kind === "rejected" ? "rejected:" + (reason ?? "") : kind;
}

/**
 * 唯一封闭校验器：写前（appendChannelSample）与读时（loadChannelSamples）共用。
 * 返回问题数组；空数组 = 干净行。坏行两个方向都进不来。
 * 封闭判据：精确键集 + 规范 ISO at + 哈希 null|^[0-9a-f]{16}$ + matches 三值 +
 * chain 枚举 + disposition 枚举/形状（rejected:<reason> 有界）。
 */
export function channelSampleProblem(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return ["not_object"];
  const problems = [];
  const keys = Object.keys(obj);
  const extra = keys.filter((k) => !KEYS.includes(k));
  const missing = KEYS.filter((k) => !keys.includes(k));
  if (extra.length) problems.push("extra_keys:" + extra.join(","));
  if (missing.length) problems.push("missing_keys:" + missing.join(","));
  if (obj.schema_version !== SCHEMA_VERSION) problems.push("schema_version");
  if (!isCanonicalIso(obj.at)) problems.push("at");
  if (typeof obj.chain !== "string" || !CHAINS.includes(obj.chain)) problems.push("chain");
  for (const k of ["message_id", "session_sha16", "channel_chat_sha16", "channel_thread_sha16"]) {
    if (obj[k] !== null && !(typeof obj[k] === "string" && /^[0-9a-f]{16}$/.test(obj[k]))) {
      problems.push(k + ":bad_hash");
    }
  }
  if (!(obj.matches_template_chat === true || obj.matches_template_chat === false || obj.matches_template_chat === null)) {
    problems.push("matches_template_chat");
  }
  if (!(DISPOSITION_KINDS.includes(obj.disposition) || REASON_PATTERN.test(obj.disposition))) {
    problems.push("disposition");
  }
  return problems;
}

// #R10 评审 P2-1：复用 canonical-time.mjs 的 isCanonicalIso —— 原来的宽版只要求形如
// “…Z 且 Date.parse 可观”，会把缺毫秒的 2026-09-02T00:00:00Z 当规范形式放行；而规范形式
// 与 toISOString() 同形（毫秒 .\d{3}Z、四位数年份、往返相等）。两处判据已写成同一处实现。
// （本地 isCanonicalIso 已被 import 的替换，删掉以免再漂移。）

/** 读入站消息频道对照所需字段；缺哪个补哪个，都缺就 null。 */
function channelView({ event, canonical, template, env }) {
  const channel = canonical?.extensions?.aily_channel ?? null;
  const envChat = typeof env?.AILY_CLI_CHANNEL_CHAT_ID === "string" ? env.AILY_CLI_CHANNEL_CHAT_ID : null;
  const envThread = typeof env?.AILY_CLI_CHANNEL_THREAD_ID === "string" ? env.AILY_CLI_CHANNEL_THREAD_ID : null;
  const chatId = (channel && typeof channel.chat_id === "string") ? channel.chat_id : envChat;
  const threadId = (channel && typeof channel.thread_id === "string") ? channel.thread_id : envThread;
  const messageId = event?.message_id ?? canonical?.event_id ?? null;
  const sessionId = event?.session_id ?? canonical?.source?.session_id ?? null;
  const tplChat = (template && typeof template.chat_id === "string") ? template.chat_id : null;
  let at = canonical?.occurred_at ?? null;
  if (typeof at !== "string") {
    const createdMs = Number(event?.created_at_ms);
    at = Number.isFinite(createdMs) && createdMs > 0 ? new Date(createdMs).toISOString() : new Date().toISOString();
  }
  return {
    at,
    messageId,
    sessionId,
    chatId,
    threadId,
    tplChat,
    matches: (chatId && tplChat) ? (chatId === tplChat) : null,
  };
}

// 机器级诊断：只落 <dir>/channel-samples.diag.log，绝不进 stdout/stderr（Aily 会合并）。
// 再全包 try/catch，写不进就彻底放弃——诊断的诊断不再递归。
function diagWrite(file, msg) {
  try {
    if (typeof file !== "string" || file.length === 0) return;
    const diagFile = path.join(path.dirname(file), "channel-samples.diag.log");
    let fd = null;
    try {
      fd = fs.openSync(
        diagFile,
        fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        0o600,
      );
      fs.writeSync(fd, new Date().toISOString() + " " + msg + "\n");
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
    }
  } catch { /* 诊断都不再递归，放弃 */ }
}

/**
 * 追加一行采样。**全包不抛**：任何失败（目录不可写、文件被做成目录、有符号链接、OOM…）
 * 都静默返回 { ok:false, reason }，绝不让采样线拖垮主流程，也绝不污染进程输出（Aily 会把
 * stdout+stderr 合并进模型上下文）。失败原因写进机器级诊断文件（见 diagWrite）。
 * 写前先过 channelSampleProblem 自校验，坏行写不出去（P1）。
 */
export function appendChannelSample({
  file, event, canonical, template, chain, env = process.env, disposition,
} = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    return { ok: false, reason: "channel_sample_required_absolute" };
  }
  // #R10 评审 P1-2：row 投影（channelView）+ 校验（channelSampleProblem）必须包进最外层
  // try/catch —— event.created_at_ms 越界（如 1e20）会让 new Date(...).toISOString() 抛
  // RangeError，而它们原来在 try 之外，坏输入会一路向上打穿入站主流程。采样线不承重，收口。
  let row;
  let problems;
  try {
    const v = channelView({ event, canonical, template, env });
    row = {
      schema_version: SCHEMA_VERSION,
      at: v.at,
      chain,
      message_id: channelSampleSha16(v.messageId),
      session_sha16: channelSampleSha16(v.sessionId),
      channel_chat_sha16: channelSampleSha16(v.chatId),
      channel_thread_sha16: channelSampleSha16(v.threadId),
      matches_template_chat: v.matches,
      disposition,
    };
    problems = channelSampleProblem(row);
  } catch (err) {
    diagWrite(file, "channel_sample_write_failed " + (err?.code ?? err?.message ?? err));
    return { ok: false, reason: "channel_sample_write_failed" };
  }
  if (problems.length) {
    diagWrite(file, "channel_sample_invalid " + problems.join(","));
    return { ok: false, reason: "channel_sample_invalid", problems };
  }
  // #R10 评审 P1-3：写侧同 fd fstat 确认普通文件且单硬链接 nlink===1（拒符号链接/别名），
  // 用 Buffer 写、校验写全字节（短写/零写 = 受控失败，不静默丢、也不假装成功）。
  const buf = Buffer.from(JSON.stringify(row) + "\n", "utf-8");
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(
      file,
      fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600,
    );
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      diagWrite(file, "channel_sample_not_regular_file");
      return { ok: false, reason: "channel_sample_not_regular_file" };
    }
    if (st.nlink !== 1) {
      diagWrite(file, "channel_sample_not_regular_file nlink=" + st.nlink);
      return { ok: false, reason: "channel_sample_not_regular_file", detail: "nlink=" + st.nlink };
    }
    const written = fs.writeSync(fd, buf);
    if (written !== buf.length) {
      diagWrite(file, "channel_sample_short_write " + written + "/" + buf.length);
      return { ok: false, reason: "channel_sample_short_write", detail: written + "/" + buf.length };
    }
    return { ok: true, row };
  } catch (err) {
    diagWrite(file, "channel_sample_write_failed " + (err?.code ?? err?.message ?? err));
    return { ok: false, reason: "channel_sample_write_failed" };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

/**
 * 只读视图：subscription-store 同款 fd 读纪律（O_NOFOLLOW | O_NONBLOCK 打开、同 fd fstat
 * 确认普通文件且**单硬链接 nlink===1**、读完即关），坏行进 problems，不隐没。文件不以换行
 * 结尾（截断风险）→ 报文件级 problem。
 * 读方用同一 channelSampleProblem：与写方同判据，坏行不进来当干净证据。不加载、不写任何东西。
 */
export function loadChannelSamples({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    return { ok: false, reason: "channel_samples_required_absolute" };
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true, rows: [], problems: [] };
    if (err.code === "ELOOP") return { ok: false, reason: "channel_samples_not_regular_file", detail: "是符号链接（别名）；请用真实路径" };
    return { ok: false, reason: "channel_samples_not_regular_file", detail: "不是普通文件（" + (err.code ?? "open_failed") + "）" };
  }
  let st;
  try { st = fs.fstatSync(fd); } catch (err) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "channel_samples_fstat_failed", detail: String(err.code ?? err.message) };
  }
  if (!st.isFile()) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "channel_samples_not_regular_file", detail: "不是普通文件" };
  }
  if (st.nlink !== 1) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "channel_samples_not_regular_file", detail: "是硬链接别名（nlink=" + st.nlink + "）；对照样本请用真实路径" };
  }
  let raw;
  try { raw = fs.readFileSync(fd, "utf-8"); } catch (err) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "channel_samples_read_failed", detail: String(err.code ?? err.message) };
  }
  try { fs.closeSync(fd); } catch { /* 已关 */ }

  const rows = [];
  const problems = [];
  if (raw.length > 0 && !raw.endsWith("\n")) problems.push("tail_no_newline");
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let obj;
    try { obj = JSON.parse(line); } catch {
      problems.push("line:" + (i + 1) + ":json_invalid");
      continue;
    }
    const p = channelSampleProblem(obj);
    if (p.length) { problems.push("line:" + (i + 1) + ":" + p.join(",")); continue; }
    rows.push(obj);
  }
  return { ok: true, absent: false, rows, problems };
}
