/**
 * 本地回合输入缓存。
 *
 * UserPromptSubmit 先把人类在 Desktop/CLI 里提交的原文写到 Git 外缓存；Stop 再把它与
 * last_assistant_message 合成同一条 outbox 事件。飞书入站消息只清理缓存、不写入，避免
 * 原话题里已经存在的人类消息被机器人再抄一遍。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_LOCAL_INPUT_CHARS = 4_000;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

const fileKey = (value) => crypto.createHash("sha256")
  .update(String(value ?? ""))
  .digest("hex")
  .slice(0, 24);

const cacheFile = (dir, key) => path.join(dir, fileKey(key) + ".json");

export const claudeTurnInputDir = (root, claudeSessionId) =>
  path.join(root, ".runtime-data", "outbound",
    claudeSessionId ? "turn-inputs-" + claudeSessionId : "turn-inputs");

export function normalizeLocalInput(value, { maxChars = MAX_LOCAL_INPUT_CHARS } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return text.length <= maxChars
    ? text
    : text.slice(0, maxChars) + "\n…（本地输入已截断，全文仍保留在原会话）";
}

/** Claude 活跃会话收到的桥接指令带有确定性来源戳；只认行首，避免误伤正文引用。 */
export function isFeishuStampedInput(value) {
  return /^\s*\[飞书\s*·\s*(?:msg|om)_[^\s·\]]+\s*·/u.test(String(value ?? ""));
}

/** 飞书戳记里的消息 id（`[飞书 · msg_x · 时间]`）；不是戳记就 null。 */
export function feishuStampMessageId(value) {
  const m = /^\s*\[飞书\s*·\s*((?:msg|om)_[^\s·\]]+)\s*·/u.exec(String(value ?? ""));
  return m ? m[1] : null;
}

/**
 * **本轮来源只有一份记录**（同一个文件、原子覆写）：要么本地输入（含正文），要么飞书回合（含消息 id）。
 * 两种来源分两个文件表达时，切换不是原子的 —— 本地写失败 + 飞书标记没清 = Stop 把本地回复发回老话题
 * （评审探针）。现在一次 rename 就把上一轮的来源整个换掉。
 */
export function storeInboundTurn({ dir, key, messageId, now = Date.now() } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) return { ok: false, reason: "missing_locator" };
  if (typeof messageId !== "string" || !messageId) return { ok: false, reason: "message_id_required" };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    prune(dir, { now });
    const file = cacheFile(dir, key);
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      schema_version: "1.0", input_origin: "feishu", message_id: messageId, captured_at: new Date(now).toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: "unwritable", error: String(err?.code ?? err?.message ?? err) };
  }
}

/**
 * 读本轮记录（不做来源判断）：{ ok, kind: "local" | "feishu", ... } 或 { ok:false, reason: not_found | unreadable | invalid_cache }。
 * Stop 只有读到明确的 local，或 feishu + 合法 claim/origin，才允许入队；其余 fail-closed。
 */
export function readTurnRecord({ dir, key } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) return { ok: false, reason: "missing_locator" };
  const file = cacheFile(dir, key);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (err) { return { ok: false, reason: err.code === "ENOENT" ? "not_found" : "unreadable", file }; }
  if (record?.schema_version !== "1.0") return { ok: false, reason: "invalid_cache", file };
  if (record.input_origin === "local") {
    if (typeof record.text !== "string" || !record.text.trim()) return { ok: false, reason: "invalid_cache", file };
    return { ok: true, kind: "local", file, text: record.text, captureId: typeof record.capture_id === "string" && record.capture_id ? record.capture_id : null };
  }
  if (record.input_origin === "feishu") {
    if (typeof record.message_id !== "string" || !record.message_id) return { ok: false, reason: "invalid_cache", file };
    return { ok: true, kind: "feishu", file, messageId: record.message_id };
  }
  return { ok: false, reason: "invalid_cache", file };
}

/** 只认飞书回合；本地回合返回 local_turn。 */
export function readInboundTurn({ dir, key } = {}) {
  const r = readTurnRecord({ dir, key });
  if (!r.ok) return r;
  return r.kind === "feishu" ? { ok: true, file: r.file, messageId: r.messageId } : { ok: false, reason: "local_turn", file: r.file };
}

function prune(dir, { now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); }
  catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_CACHE_AGE_MS) fs.rmSync(file, { force: true });
    } catch { /* 缓存清理不能影响 hook */ }
  }
}

export function storeTurnInput({ dir, key, text, now = Date.now() } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) {
    return { ok: false, reason: "missing_locator" };
  }
  const normalized = normalizeLocalInput(text);
  if (!normalized) return { ok: false, reason: "empty_input" };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    prune(dir, { now });
    const file = cacheFile(dir, key);
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      schema_version: "1.0",
      capture_id: crypto.randomUUID(),
      input_origin: "local",
      text: normalized,
      captured_at: new Date(now).toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: "unwritable", error: String(err?.code ?? err?.message ?? err) };
  }
}

export function readTurnInput({ dir, key } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) {
    return { ok: false, reason: "missing_locator" };
  }
  const file = cacheFile(dir, key);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (record?.input_origin === "feishu") return { ok: false, reason: "feishu_turn", file };
    if (record?.input_origin !== "local" || typeof record?.text !== "string" || !record.text.trim()) {
      return { ok: false, reason: "invalid_cache", file };
    }
    return {
      ok: true,
      file,
      text: record.text,
      inputOrigin: "local",
      captureId: typeof record.capture_id === "string" && record.capture_id
        ? record.capture_id
        : null,
    };
  } catch (err) {
    return { ok: false, reason: err.code === "ENOENT" ? "not_found" : "unreadable", file };
  }
}

export function clearTurnInput({ dir, key } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) {
    return { ok: false, reason: "missing_locator" };
  }
  try { fs.rmSync(cacheFile(dir, key), { force: true }); }
  catch (err) { return { ok: false, reason: "unwritable", error: String(err?.code ?? err?.message ?? err) }; }
  return { ok: true };
}
