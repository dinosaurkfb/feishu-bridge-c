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
import { SENDER_ROLES } from "./sender-roles.mjs";
import { RISK } from "./risk-class.mjs";
import { CHAT_FAIL_REASONS, SIGNAL_SHAPE } from "./chat-reply.mjs";

export const CHAT_MAX_CONCURRENT = 2;
export const CHAT_MAX_PER_SENDER = 1;
export const CHAT_CHAINS = Object.freeze(["claude", "codex"]);
const KEY_SHAPE = /^[0-9a-f]{64}$/u;
const SENDER_REF_SHAPE = /^sender_[0-9a-f]{16}$/u;
const CLAIM_KEYS = "chain,key,message_id,pid,risk_class,role,schema_version,sender_ref,session_id,started_at,state";
const OUTCOME_ANSWERED_KEYS = "elapsed_ms,key,recorded_at,schema_version,status,text";
/** failed 的键集按 reason 封闭：timeout 多一个 timeout_ms、nonzero_exit 多一个 exit_code —— 重放文案由这些受控字段确定，不靠存储的 why。 */
const OUTCOME_FAILED_KEYS = Object.freeze({
  timeout: "diagnostic,elapsed_ms,key,reason,recorded_at,schema_version,status,timeout_ms,why",
  spawn_failed: "diagnostic,elapsed_ms,key,reason,recorded_at,schema_version,status,why",
  nonzero_exit: "diagnostic,elapsed_ms,exit_code,key,reason,recorded_at,schema_version,status,why",
  signaled: "diagnostic,elapsed_ms,key,reason,recorded_at,schema_version,signal,status,why",
  empty_reply: "diagnostic,elapsed_ms,key,reason,recorded_at,schema_version,status,why",
});
const CHAT_DIR_ENTRIES = Object.freeze(["claim.json", "outcome.json"]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 准入锁家族（与 registry.mjs 的 symlink 锁协议逐一对应）：主锁 / reap 段锁 / 维护锁 / 回收残骸 / 隔离残骸 —— 只有这些名字不算条目。 */
const ADMISSION_LOCK_FAMILY = [
  /^admission\.lock$/u, /^admission\.lock\.reap$/u, /^admission\.lock\.maint$/u,
  new RegExp("^admission\\.lock\\.reaped-" + UUID + "$", "u"), new RegExp("^admission\\.lock\\.reap\\.quarantine-" + UUID + "$", "u"),
];
export const isAdmissionLockEntry = (name) => ADMISSION_LOCK_FAMILY.some((re) => re.test(name));
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
  if (!SENDER_ROLES.includes(doc.role)) return "role 不在受控集合里";
  if (!Object.values(RISK).includes(doc.risk_class)) return "risk_class 不在受控集合里";
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
    if (!CHAT_FAIL_REASONS.includes(doc.reason)) return "failed 的 reason 不在受控集合里";
    if (keys !== OUTCOME_FAILED_KEYS[doc.reason]) return "failed（" + doc.reason + "）的字段集不对";
    if (!nonEmpty(doc.why)) return "failed 缺 why";
    if (doc.diagnostic !== null && typeof doc.diagnostic !== "string") return "diagnostic 形状不对";
    if (doc.reason === "timeout" && !(Number.isInteger(doc.timeout_ms) && doc.timeout_ms > 0)) return "timeout_ms 不是正整数";
    if (doc.reason === "nonzero_exit" && !Number.isInteger(doc.exit_code)) return "exit_code 不是整数";
    if (doc.reason === "signaled" && !SIGNAL_SHAPE.test(String(doc.signal))) return "signal 形状不对";
    return null;
  }
  return "status 不在受控集合里";
}

const claimDir = (ledgerDir, key) => path.join(ledgerDir, key + ".chat");
/** 读记录：O_NONBLOCK | O_NOFOLLOW 打开、同一 fd fstat 确认普通文件后再读 —— 命名管道会把持锁的盘点卡死，符号链接会读到别处（评审探针）。 */
const readJson = (file) => {
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err?.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", why: err?.code === "ELOOP" ? "不是普通文件（符号链接）" : String(err.code ?? err.message) };
    }
    let st;
    try { st = fs.fstatSync(fd); } catch (err) { return { status: "unreadable", why: "fstat 失败：" + String(err.code ?? err.message) }; }
    if (!st.isFile()) return { status: "unreadable", why: "不是普通文件" };
    let raw;
    try { raw = fs.readFileSync(fd, "utf-8"); }
    catch (err) { return { status: "unreadable", why: String(err.code ?? err.message) }; }
    try { return { status: "read", doc: JSON.parse(raw) }; }
    catch { return { status: "unreadable", why: "不是 JSON" }; }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
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
/** claim 目录本身也要受验：必须是真目录（不是符号链接 / 别名，不是文件）；里面只允许 claim.json / outcome.json。 */
function inspectChatDir(dir) {
  let st;
  try { st = fs.lstatSync(dir); }
  catch (err) { return err?.code === "ENOENT" ? { status: "absent" } : { status: "unreadable", why: "目录 lstat 失败：" + String(err.code ?? err.message) }; }
  if (st.isSymbolicLink()) return { status: "unreadable", why: "claim 目录是符号链接（别名）" };
  if (!st.isDirectory()) return { status: "unreadable", why: "claim 目录不是目录" };
  let names;
  try { names = fs.readdirSync(dir); }
  catch (err) { return { status: "unreadable", why: "目录读不出：" + String(err.code ?? err.message) }; }
  const foreign = names.filter((n) => !CHAT_DIR_ENTRIES.includes(n));
  if (foreign.length > 0) return { status: "unreadable", why: "目录里有不该有的条目：" + foreign.slice(0, 3).map((n) => n.slice(0, 40)).join("、") + (/outcome\.json\.tmp\./u.test(foreign.join(" ")) ? "（含终态进位残骸）" : "") };
  return { status: "ok", identity: { dev: st.dev, ino: st.ino } };
}
/** 目录检查与读写之间没有"同一 fd"可用（Node 没有 openat，macOS 的 /dev/fd/N/子路径也不通）：读写完成后再核一次目录身份，被换掉就不认这次结果。 */
function dirIdentityUnchanged(dir, identity) {
  try { const st = fs.lstatSync(dir); return st.isDirectory() && st.dev === identity.dev && st.ino === identity.ino; }
  catch { return false; }
}

export function inspectChat({ ledgerDir, key }) {
  if (!KEY_SHAPE.test(String(key))) return { state: "unreadable", why: "key 形状不对" };
  const dir = claimDir(ledgerDir, key);
  const dirState = inspectChatDir(dir);
  if (dirState.status === "absent") return { state: "absent" };
  if (dirState.status === "unreadable") return { state: "unreadable", why: dirState.why };
  const claim = readJson(path.join(dir, "claim.json"));
  if (claim.status === "absent") return { state: "unreadable", why: "claim 目录在、claim.json 缺席" };
  if (claim.status === "unreadable") return { state: "unreadable", why: "claim：" + claim.why };
  const claimProblem = chatClaimProblem(claim.doc, key);
  if (claimProblem !== null) return { state: "unreadable", why: "claim：" + claimProblem };
  const outcome = readJson(path.join(dir, "outcome.json"));
  if (outcome.status === "unreadable") return { state: "unreadable", why: "outcome：" + outcome.why, claim: claim.doc };
  // 读完再核一次目录身份：检查与读之间目录被换掉（别名 / 重命名）→ 这次读到的不作数
  if (!dirIdentityUnchanged(dir, dirState.identity)) return { state: "unreadable", why: "claim 目录在读取期间被替换" };
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
    if (isAdmissionLockEntry(n)) continue;   // 锁家族（精确形状）不是条目；相似而不精确的名字往下当认不出
    // 进位前的临时目录：盘点在准入锁内做，此刻不可能有另一笔合法进位在跑 —— 它只能是上次建 claim 中断留下的残骸，说不清就不许当不存在
    if (/\.chat\.tmp\.\d+\.\d+$/u.test(n)) { unresolved += 1; why.push("进位残骸（上次建 claim 中断）" + n.slice(0, 20) + "…，人工删除"); continue; }
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
      // 飞书正文只给状态与受控指引；机器路径与逐条原因只进回执（load.why）
      result = { ok: false, reason: "chat_ledger_unresolved", text: "chat 账本有 " + load.unresolved + " 处说不清，不起回答；请在本机跑 doctor（第 ⑨ 项）查看", load };
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
    // 结构化：入口按 reason 给受控文案（reap 残骸是 fail-closed、要人工维护；其余按协议由下一笔回收），detail 只进机器回执
    if (!rel.ok && result && typeof result === "object") result = { ...result, lockUncleared: { reason: String(rel.reason), detail: rel.error ? String(rel.error) : null } };
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
  const dir = claimDir(ledgerDir, key);
  const dirState = inspectChatDir(dir);
  if (dirState.status !== "ok") return { ok: false, reason: "claim_dir_unusable", why: dirState.why ?? dirState.status };
  try { writeJsonAtomic(path.join(dir, "outcome.json"), doc); }
  catch (err) { return { ok: false, reason: "ledger_unwritten", why: String(err.code ?? err.message) }; }
  // 写完再核目录身份：检查与写之间目录被换掉 → 终态可能落到了别处，这次写不算数（不去别处删：那正是别名想要的）
  if (!dirIdentityUnchanged(dir, dirState.identity)) return { ok: false, reason: "ledger_unwritten", why: "claim 目录在写入期间被替换" };
  return { ok: true };
}

/** 锁没交还时给人看的受控文案（按 registry.mjs 释放阶段的 reason 族）：reap 残骸 fail-closed 要人工维护，其余按协议由下一笔回收；路径与 detail 只进机器回执。 */
export function lockUnclearedText(lu) {
  const reason = String(lu?.reason ?? "");
  if (reason.startsWith("reap_residue")) return "准入锁的回收段留有残骸（不会自动恢复）：之后的 chat 会一直报受理忙，请在本机用 repair-publish-lock 处理";
  return "准入锁没有交还；之后的 chat 可能报受理忙，持有者已死超过 5 分钟会按锁协议自动回收，不要手删";
}
