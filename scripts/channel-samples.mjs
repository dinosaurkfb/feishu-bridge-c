#!/usr/bin/env node
/**
 * 频道定位采样旁路（#R11 内部构件）。
 *
 * 目的：给入站链加一条「不承重」的采样线，把每条入站消息的频道 locator 对照结果
 * 记到 <bridgeHome>/inbound/channel-samples.jsonl，供后来人肉核验
 * AILY_CLI_CHANNEL_CHAT_ID 到底映射的是群还是私聊。
 *
 * 纪律（与主流程严格隔离）：
 *  - 采样失败绝不阻断 / 不回退入站流程。appendChannelSample 全包 try/catch，
 *    失败只往 stderr 打一行，返回 { ok:false }，调用方当没听见。
 *  - locator 不外泄：session / channel chat / channel thread / message_id 一律
 *    sha256 前 16 位落行。Aily 的 message_id 本身就是 om_ 前缀，写明文会漏。
 *    matches_template_chat 用布尔表达（true = 频道 == 模板群，false = 不一致，
 *    null = 频道或模板 chat_id 缺失，连比较都不做）。
 *  - 只写 machine 级目录（UNROUTED_RT / FEISHU_CODEX_BRIDGE_HOME 的 inbound/），
 *    绝不写项目 runtime，避免每装一版就换地方。
 *
 * 计划：实验期短、行小，文件不轮转。等 Frank 拿到对照结论、chat locator 验证完成后，
 * 本旁路连同本文件、两条链里的 recordChannelSample 调用一起整体移除，不留半成品。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA_VERSION = "1.0";
const CHAINS = Object.freeze(["claude", "codex"]);

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

/**
 * 追加一行采样。**全包不抛**：任何失败（目录不可写、文件被做成目录、有符号链接、OOM…）
 * 都只往 stderr 打一行，返回 { ok:false, reason }，绝不让采样线拖垮主流程。
 */
export function appendChannelSample({
  file, event, canonical, template, chain, env = process.env, disposition,
} = {}) {
  try {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      return { ok: false, reason: "channel_sample_required_absolute" };
    }
    const v = channelView({ event, canonical, template, env });
    const row = {
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
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd = null;
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        0o600,
      );
      fs.writeSync(fd, JSON.stringify(row) + "\n");
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
    }
    return { ok: true, row };
  } catch (err) {
    try {
      process.stderr.write("[channel-samples] 采样旁路失败（不阻断主流程）：" +
        (typeof err?.code === "string" ? err.code : String(err?.message ?? err)) + "\n");
    } catch { /* 连 stderr 都写不了就算了 */ }
    return { ok: false, reason: "channel_sample_write_failed" };
  }
}

/** 单行 shape 校验：结构合法才收；坏项进 problems。 */
function validateChannelSample(obj) {
  const problems = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return ["not_object"];
  if (obj.schema_version !== SCHEMA_VERSION) problems.push("schema_version");
  if (typeof obj.at !== "string" || obj.at.length === 0) problems.push("at");
  if (typeof obj.chain !== "string" || !CHAINS.includes(obj.chain)) problems.push("chain");
  for (const k of ["message_id", "session_sha16", "channel_chat_sha16", "channel_thread_sha16"]) {
    if (obj[k] !== null && typeof obj[k] !== "string") problems.push(k);
  }
  if (!(obj.matches_template_chat === true || obj.matches_template_chat === false || obj.matches_template_chat === null)) {
    problems.push("matches_template_chat");
  }
  if (typeof obj.disposition !== "string" || obj.disposition.length === 0) problems.push("disposition");
  return problems;
}

/**
 * 只读视图：subscription-store 同款 fd 读纪律（O_NOFOLLOW | O_NONBLOCK 打开、
 * 同 fd fstat 确认普通文件、读完即关），坏行进 problems，不隐没。
 * 不加载、不写任何东西。
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
  let raw;
  try { raw = fs.readFileSync(fd, "utf-8"); } catch (err) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "channel_samples_read_failed", detail: String(err.code ?? err.message) };
  }
  try { fs.closeSync(fd); } catch { /* 已关 */ }

  const rows = [];
  const problems = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let obj;
    try { obj = JSON.parse(line); } catch {
      problems.push("line:" + (i + 1) + ":json_invalid");
      continue;
    }
    const p = validateChannelSample(obj);
    if (p.length) { problems.push("line:" + (i + 1) + ":" + p.join(",")); continue; }
    rows.push(obj);
  }
  return { ok: true, absent: false, rows, problems };
}
