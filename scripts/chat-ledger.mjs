/**
 * chat 默认态的**机器级账本**（两条链共用）—— 没有绑定就没有项目内的 .runtime-data，但 chat 同样是"一个原始事件用事件 id 做幂等"的对象：
 *
 *   · claim：`<ledgerDir>/<key>.chat/`（mkdir 原子；EEXIST = 同一条消息的重放）+ claim.json（谁、哪条、何时、哪个进程在答）；
 *   · 终态：`<key>.chat/outcome.json`（answered：记录回答全文；failed：记录受控原因）—— 重放按记录重出，不再起模型；
 *   · 并发上界：正在答（claim 在、终态缺席、pid 活着、没超预算）的条数有全局与每发送者两个上限，超了就拒，**在取 claim 之前判**，
 *     这样被拒的那条重放时还能再试；
 *   · 陈旧：pid 死了又没有终态 = 上次没答完，不重跑（说不清上次答到哪），如实报"请再发一条新消息"。
 *
 * key = sha256(chain \0 message_id \0 session_id)。目录里不出 locator：claim 只记 sender_id 的角色与 sha256 前缀。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CHAT_MAX_CONCURRENT = 2;
export const CHAT_MAX_PER_SENDER = 1;
const KEY_SHAPE = /^[0-9a-f]{64}$/u;

export function chatKey({ chain, messageId, sessionId }) {
  return crypto.createHash("sha256").update([String(chain), String(messageId), String(sessionId ?? "")].join("\0")).digest("hex");
}
export const senderRef = (senderId) => "sender_" + crypto.createHash("sha256").update(String(senderId)).digest("hex").slice(0, 16);

const claimDir = (ledgerDir, key) => path.join(ledgerDir, key + ".chat");
const readJson = (file) => {
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); }
  catch (err) { return err?.code === "ENOENT" ? { status: "absent" } : { status: "unreadable", why: String(err.code ?? err.message) }; }
  try {
    const doc = JSON.parse(raw);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { status: "unreadable", why: "不是记录对象" };
    return { status: "valid", doc };
  } catch { return { status: "unreadable", why: "不是 JSON" }; }
};
const writeJsonAtomic = (file, doc) => {
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

/** 取 claim：ok / duplicate / io_error。 */
export function acquireChatClaim({ ledgerDir, key, meta }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "key_shape" };
  const dir = claimDir(ledgerDir, key);
  try {
    fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false, reason: "duplicate", key, dir };
    return { ok: false, reason: "io_error", error: String(err.code ?? err.message), key, dir };
  }
  writeJsonAtomic(path.join(dir, "claim.json"), { ...meta, schema_version: "1.0", state: "running", key, pid: process.pid, started_at: new Date().toISOString() });
  return { ok: true, key, dir };
}

export function recordChatOutcome({ ledgerDir, key, outcome }) {
  if (!KEY_SHAPE.test(String(key))) throw new Error("chat key 形状不对");
  writeJsonAtomic(path.join(claimDir(ledgerDir, key), "outcome.json"), { ...outcome, schema_version: "1.0", key, recorded_at: new Date().toISOString() });
}

/**
 * 一条 chat 的状态（重放时用）：
 *   absent（没 claim）/ answered（有终态且是回答）/ failed（有终态且是失败）/ running（claim 在、终态缺席、pid 活着）/
 *   stale（claim 在、终态缺席、pid 死了）/ unreadable（claim 或终态读不出）。
 */
export function inspectChat({ ledgerDir, key }) {
  if (!KEY_SHAPE.test(String(key))) return { state: "unreadable", why: "key 形状不对" };
  const dir = claimDir(ledgerDir, key);
  const claim = readJson(path.join(dir, "claim.json"));
  if (claim.status === "absent") return fs.existsSync(dir) ? { state: "unreadable", why: "claim 目录在、claim.json 缺席" } : { state: "absent" };
  if (claim.status === "unreadable") return { state: "unreadable", why: "claim：" + claim.why };
  const outcome = readJson(path.join(dir, "outcome.json"));
  if (outcome.status === "unreadable") return { state: "unreadable", why: "outcome：" + outcome.why, claim: claim.doc };
  if (outcome.status === "valid") {
    if (outcome.doc.status === "answered" && typeof outcome.doc.text === "string") return { state: "answered", claim: claim.doc, outcome: outcome.doc };
    if (outcome.doc.status === "failed") return { state: "failed", claim: claim.doc, outcome: outcome.doc };
    return { state: "unreadable", why: "outcome 的 status 说不清", claim: claim.doc };
  }
  return alive(claim.doc.pid) ? { state: "running", claim: claim.doc } : { state: "stale", claim: claim.doc };
}

/** 正在答的条数（全局 + 这个发送者）：claim 在、终态缺席、pid 活着、没超预算（budgetMs + 30 秒宽限）。 */
export function chatLoad({ ledgerDir, senderId, now = Date.now(), budgetMs }) {
  let names;
  try { names = fs.readdirSync(ledgerDir).filter((n) => n.endsWith(".chat")); }
  catch (err) { return err?.code === "ENOENT" ? { running: 0, bySender: 0, unknown: null } : { running: 0, bySender: 0, unknown: String(err.code ?? err.message) }; }
  const me = senderRef(senderId);
  let running = 0; let bySender = 0; let unknown = null;
  for (const n of names) {
    const key = n.slice(0, -".chat".length);
    if (!KEY_SHAPE.test(key)) continue;
    const seen = inspectChat({ ledgerDir, key });
    if (seen.state === "unreadable") { unknown = (unknown ?? 0) + 1; continue; }
    if (seen.state !== "running") continue;
    const startedAt = Date.parse(seen.claim.started_at ?? "");
    if (Number.isFinite(budgetMs) && Number.isFinite(startedAt) && now - startedAt > budgetMs + 30_000) continue;   // 超过预算 + 宽限：不算占位
    running += 1;
    if (seen.claim.sender_ref === me) bySender += 1;
  }
  return { running, bySender, unknown: unknown === null ? null : unknown + " 条读不出" };
}

export function chatBusy({ ledgerDir, senderId, now, budgetMs, maxConcurrent = CHAT_MAX_CONCURRENT, maxPerSender = CHAT_MAX_PER_SENDER }) {
  const load = chatLoad({ ledgerDir, senderId, now, budgetMs });
  if (load.running >= maxConcurrent) return { busy: true, reason: "chat_busy_global", text: "chat 正忙（同时在答 " + load.running + " 条，上限 " + maxConcurrent + "），稍后再问", load };
  if (load.bySender >= maxPerSender) return { busy: true, reason: "chat_busy_sender", text: "你上一条还在答（每人同时只答 " + maxPerSender + " 条），等它答完再问", load };
  return { busy: false, load };
}
