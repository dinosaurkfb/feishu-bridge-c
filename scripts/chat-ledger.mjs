/**
 * chat 默认态的**机器级账本**（两条链共用）—— 没有绑定就没有项目内的 .runtime-data，但 chat 同样是"一个原始事件用事件 id 做幂等"的对象。
 *
 *   · claim：`<ledgerDir>/<key>.chat/`（**闭合转换**：先在临时目录写全 claim.json，再 rename 进位；EEXIST = 同一条消息的重放；
 *     进位前的任何失败只留临时目录，且受控返回，不裸抛）+ 终态 `outcome.json`（answered 记回答全文 / failed 记受控原因），
 *     同样临时文件 + rename；
 *   · 记录形状**封闭**（chatClaimProblem / chatOutcomeProblem）：键集恰好、时间规范、key / chain / message / session / sender_ref / pid
 *     逐一核对，终态与 claim 交叉核对 —— 一个只有 {status, text} 的文件不算"已回答"；
 *   · 准入是**一把锁内**的一次判定（admission.lock，复用 registry.mjs 的 symlink 锁）：盘点正在答的条数 → 上界 → 建 claim，
 *     两个进程不可能都看到 0 再各自取 claim；
 *   · "说不清"不折叠成空闲：目录里有读不出的 claim / 终态、认不出的条目，准入返回 unresolved，入口不起模型；
 *   · 陈旧：pid 死了又没有终态 = 上次没答完，不重跑（说不清上次答到哪），如实报"请再发一条新消息"。
 *
 * key = sha256(chain \0 message_id \0 session_id)。目录里不出 locator：claim 只记 sender 的 sha256 前缀。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";

export const CHAT_MAX_CONCURRENT = 2;
export const CHAT_MAX_PER_SENDER = 1;
export const CHAT_CHAINS = Object.freeze(["claude", "codex"]);
const KEY_SHAPE = /^[0-9a-f]{64}$/u;
const SENDER_REF_SHAPE = /^sender_[0-9a-f]{16}$/u;
const CLAIM_KEYS = "chain,key,message_id,pid,risk_class,role,schema_version,sender_ref,session_id,started_at,state";
const OUTCOME_ANSWERED_KEYS = "elapsed_ms,key,recorded_at,schema_version,status,text";
const OUTCOME_FAILED_KEYS = "diagnostic,elapsed_ms,key,reason,recorded_at,schema_version,status,why";
const ADMISSION_LOCK = "admission.lock";
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

export function chatKey({ chain, messageId, sessionId }) {
  return crypto.createHash("sha256").update([String(chain), String(messageId), String(sessionId ?? "")].join("\0")).digest("hex");
}
export const senderRef = (senderId) => "sender_" + crypto.createHash("sha256").update(String(senderId)).digest("hex").slice(0, 16);

/** claim.json 的封闭形状。 */
export function chatClaimProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (Object.keys(doc).sort().join(",") !== CLAIM_KEYS) return "字段集不对";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.state !== "running") return "state 不是 running";
  if (doc.key !== key) return "key 跟目录名对不上";
  if (!CHAT_CHAINS.includes(doc.chain)) return "chain 不在受控集合里";
  if (!nonEmpty(doc.message_id)) return "message_id 缺失";
  if (doc.session_id !== null && !nonEmpty(doc.session_id)) return "session_id 形状不对";
  if (chatKey({ chain: doc.chain, messageId: doc.message_id, sessionId: doc.session_id ?? "" }) !== key) return "key 不是由 chain / message_id / session_id 推导出来的";
  if (!SENDER_REF_SHAPE.test(String(doc.sender_ref))) return "sender_ref 形状不对";
  if (!nonEmpty(doc.role) || !nonEmpty(doc.risk_class)) return "role / risk_class 缺失";
  if (!Number.isInteger(doc.pid) || doc.pid <= 0) return "pid 不是正整数";
  if (!isCanonicalIso(doc.started_at)) return "started_at 不是规范时间";
  return null;
}

/** outcome.json 的封闭形状，并与 claim 交叉核对（key）。 */
export function chatOutcomeProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.key !== key) return "key 跟目录名对不上";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  if (!Number.isInteger(doc.elapsed_ms) || doc.elapsed_ms < 0) return "elapsed_ms 不是非负整数";
  const keys = Object.keys(doc).sort().join(",");
  if (doc.status === "answered") {
    if (keys !== OUTCOME_ANSWERED_KEYS) return "answered 的字段集不对";
    if (!nonEmpty(doc.text)) return "answered 没有正文";
    return null;
  }
  if (doc.status === "failed") {
    if (keys !== OUTCOME_FAILED_KEYS) return "failed 的字段集不对";
    if (!nonEmpty(doc.reason) || !nonEmpty(doc.why)) return "failed 缺 reason / why";
    if (doc.diagnostic !== null && typeof doc.diagnostic !== "string") return "diagnostic 形状不对";
    return null;
  }
  return "status 不在受控集合里";
}

const claimDir = (ledgerDir, key) => path.join(ledgerDir, key + ".chat");
const readJson = (file) => {
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); }
  catch (err) { return err?.code === "ENOENT" ? { status: "absent" } : { status: "unreadable", why: String(err.code ?? err.message) }; }
  try { return { status: "read", doc: JSON.parse(raw) }; }
  catch { return { status: "unreadable", why: "不是 JSON" }; }
};
const writeJsonAtomic = (file, doc) => {
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

/**
 * 一条 chat 的状态：
 *   absent / answered / failed / running（claim 在、终态缺席、pid 活着）/ stale（pid 死了）/ unreadable（claim 或终态读不出、形状不对）。
 */
export function inspectChat({ ledgerDir, key }) {
  if (!KEY_SHAPE.test(String(key))) return { state: "unreadable", why: "key 形状不对" };
  const dir = claimDir(ledgerDir, key);
  const claim = readJson(path.join(dir, "claim.json"));
  if (claim.status === "absent") return fs.existsSync(dir) ? { state: "unreadable", why: "claim 目录在、claim.json 缺席" } : { state: "absent" };
  if (claim.status === "unreadable") return { state: "unreadable", why: "claim：" + claim.why };
  const claimProblem = chatClaimProblem(claim.doc, key);
  if (claimProblem !== null) return { state: "unreadable", why: "claim：" + claimProblem };
  const outcome = readJson(path.join(dir, "outcome.json"));
  if (outcome.status === "unreadable") return { state: "unreadable", why: "outcome：" + outcome.why, claim: claim.doc };
  if (outcome.status === "read") {
    const problem = chatOutcomeProblem(outcome.doc, key);
    if (problem !== null) return { state: "unreadable", why: "outcome：" + problem, claim: claim.doc };
    return { state: outcome.doc.status, claim: claim.doc, outcome: outcome.doc };
  }
  return alive(claim.doc.pid) ? { state: "running", claim: claim.doc } : { state: "stale", claim: claim.doc };
}

/**
 * 盘点：正在答的条数（全局 / 这个发送者），以及说不清的条目数（读不出的 claim / 终态、认不出的名字）。
 * 正在答 = running 且未超预算 + 30 秒宽限；超过的不算占位（进程可能卡死，但不能因此永久堵住入口）。
 */
export function chatLoad({ ledgerDir, senderId, now = Date.now(), budgetMs }) {
  let names;
  try { names = fs.readdirSync(ledgerDir); }
  catch (err) { return err?.code === "ENOENT" ? { running: 0, bySender: 0, unresolved: 0, why: [] } : { running: 0, bySender: 0, unresolved: 1, why: ["目录读不出：" + String(err.code ?? err.message)] }; }
  const me = senderRef(senderId);
  let running = 0; let bySender = 0; let unresolved = 0; const why = [];
  for (const n of names) {
    if (n === ADMISSION_LOCK || n.startsWith(ADMISSION_LOCK + ".")) continue;   // 锁与它的回收残骸不是条目
    if (/\.chat\.tmp\.\d+\.\d+$/u.test(n)) continue;                            // 进位前的临时目录：不是 claim
    if (!n.endsWith(".chat") || !KEY_SHAPE.test(n.slice(0, -".chat".length))) { unresolved += 1; why.push("认不出的条目 " + n.slice(0, 40)); continue; }
    const key = n.slice(0, -".chat".length);
    const seen = inspectChat({ ledgerDir, key });
    if (seen.state === "unreadable") { unresolved += 1; why.push(key.slice(0, 8) + "：" + seen.why); continue; }
    if (seen.state !== "running") continue;
    const startedAt = Date.parse(seen.claim.started_at);
    if (Number.isFinite(budgetMs) && now - startedAt > budgetMs + 30_000) continue;
    running += 1;
    if (seen.claim.sender_ref === me) bySender += 1;
  }
  return { running, bySender, unresolved, why };
}

/**
 * 准入 —— **一把锁内**：盘点 → 说不清则拒 → 上界则拒 → 建 claim（临时目录写全再 rename 进位）。
 * @returns {{ ok: true, key, dir } | { ok: false, reason: "chat_ledger_unresolved"|"chat_busy_global"|"chat_busy_sender"|"duplicate"|"chat_admission_busy"|"chat_admission_lock_unavailable"|"chat_ledger_unwritable", text?: string, why?: string, load? }}
 */
export function admitChat({ ledgerDir, key, meta, senderId, now = Date.now(), budgetMs, maxConcurrent = CHAT_MAX_CONCURRENT, maxPerSender = CHAT_MAX_PER_SENDER }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "chat_ledger_unwritable", why: "key 形状不对" };
  try { fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 }); }
  catch (err) { return { ok: false, reason: "chat_ledger_unwritable", why: String(err.code ?? err.message) }; }
  const lockPath = path.join(ledgerDir, ADMISSION_LOCK);
  let lock;
  try { lock = acquirePublishLock(lockPath); }
  catch (err) { return { ok: false, reason: "chat_admission_lock_unavailable", why: "锁原语抛错：" + String(err?.code ?? err?.message ?? err) }; }
  if (!lock.ok) {
    return lock.reason === "publisher_busy"
      ? { ok: false, reason: "chat_admission_busy", text: "chat 正在受理另一条消息，稍后再问", why: "admission.lock 被持有" }
      : { ok: false, reason: "chat_admission_lock_unavailable", why: String(lock.reason) + (lock.error ? "：" + lock.error : "") };
  }
  let result;
  try {
    const load = chatLoad({ ledgerDir, senderId, now, budgetMs });
    if (load.unresolved > 0) {
      result = { ok: false, reason: "chat_ledger_unresolved", text: "chat 账本有 " + load.unresolved + " 处说不清（" + load.why.slice(0, 2).join("；") + "），不起回答；请人工查看 " + ledgerDir, load };
    } else if (load.running >= maxConcurrent) {
      result = { ok: false, reason: "chat_busy_global", text: "chat 正忙（同时在答 " + load.running + " 条，上限 " + maxConcurrent + "），稍后再问", load };
    } else if (load.bySender >= maxPerSender) {
      result = { ok: false, reason: "chat_busy_sender", text: "你上一条还在答（每人同时只答 " + maxPerSender + " 条），等它答完再问", load };
    } else {
      result = createClaim({ ledgerDir, key, meta, now });
    }
  } finally {
    let rel;
    try { rel = releasePublishLock(lockPath); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    if (!rel.ok && result && typeof result === "object") result = { ...result, lockUncleared: String(rel.reason) + (rel.error ? "：" + rel.error : "") };
  }
  return result;
}

/** 闭合转换：临时目录写全 claim.json → rename 进位；失败只留临时目录并受控返回。 */
function createClaim({ ledgerDir, key, meta, now }) {
  const dir = claimDir(ledgerDir, key);
  if (fs.existsSync(dir)) return { ok: false, reason: "duplicate", key, dir };
  const tmp = dir + ".tmp." + process.pid + "." + now;
  const claim = {
    schema_version: "1.0", state: "running", key,
    chain: meta.chain, message_id: meta.message_id, session_id: meta.session_id ?? null, sender_ref: meta.sender_ref,
    role: meta.role, risk_class: meta.risk_class, pid: process.pid, started_at: new Date(now).toISOString(),
  };
  const problem = chatClaimProblem(claim, key);
  if (problem !== null) return { ok: false, reason: "chat_ledger_unwritable", why: "claim 形状不对：" + problem };
  try {
    fs.mkdirSync(tmp, { recursive: false, mode: 0o700 });
    fs.writeFileSync(path.join(tmp, "claim.json"), JSON.stringify(claim, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 留下的临时目录不算 claim */ }
    return { ok: false, reason: "chat_ledger_unwritable", why: String(err.code ?? err.message) };
  }
  try { fs.renameSync(tmp, dir); }
  catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 同上 */ }
    if (err?.code === "EEXIST" || err?.code === "ENOTEMPTY") return { ok: false, reason: "duplicate", key, dir };
    return { ok: false, reason: "chat_ledger_unwritable", why: String(err.code ?? err.message) };
  }
  return { ok: true, key, dir };
}

/** 记终态：受控返回，不裸抛。 */
export function recordChatOutcome({ ledgerDir, key, outcome, now = Date.now() }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "key_shape" };
  const doc = { ...outcome, schema_version: "1.0", key, recorded_at: new Date(now).toISOString() };
  const problem = chatOutcomeProblem(doc, key);
  if (problem !== null) return { ok: false, reason: "outcome_shape", why: problem };
  try { writeJsonAtomic(path.join(claimDir(ledgerDir, key), "outcome.json"), doc); }
  catch (err) { return { ok: false, reason: "ledger_unwritten", why: String(err.code ?? err.message) }; }
  return { ok: true };
}
