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

const inboundFile = (dir, key) => path.join(dir, fileKey(key) + ".inbound.json");

/**
 * 记下"这个会话当前这一轮是飞书来的哪条消息"。Stop 钩子据此反查 claim，拿到入站时冻结的
 * origin 代际，把回复发回指令所在的那个话题（goal 第 2 层）。与本地回合缓存同目录、同清理规则；
 * 下一次 UserPromptSubmit 原子覆写或清掉。
 */
export function storeInboundTurn({ dir, key, messageId, now = Date.now() } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) return { ok: false, reason: "missing_locator" };
  if (typeof messageId !== "string" || !messageId) return { ok: false, reason: "message_id_required" };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  prune(dir, { now });
  const file = inboundFile(dir, key);
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: "1.0", input_origin: "feishu", message_id: messageId, captured_at: new Date(now).toISOString(),
  }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true, file };
}

export function readInboundTurn({ dir, key } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) return { ok: false, reason: "missing_locator" };
  const file = inboundFile(dir, key);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (record?.input_origin !== "feishu" || typeof record?.message_id !== "string" || !record.message_id) {
      return { ok: false, reason: "invalid_cache", file };
    }
    return { ok: true, file, messageId: record.message_id };
  } catch (err) {
    return { ok: false, reason: err.code === "ENOENT" ? "not_found" : "unreadable", file };
  }
}

export function clearInboundTurn({ dir, key } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) return { ok: false, reason: "missing_locator" };
  fs.rmSync(inboundFile(dir, key), { force: true });
  return { ok: true };
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
}

export function readTurnInput({ dir, key } = {}) {
  if (typeof dir !== "string" || !dir || typeof key !== "string" || !key) {
    return { ok: false, reason: "missing_locator" };
  }
  const file = cacheFile(dir, key);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
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
  fs.rmSync(cacheFile(dir, key), { force: true });
  return { ok: true };
}
