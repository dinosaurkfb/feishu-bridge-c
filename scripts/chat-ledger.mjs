/**
 * chat 默认态的**机器级账本**（两条链共用）—— 没有绑定就没有项目内的 .runtime-data，但 chat 同样是"一个原始事件用事件 id 做幂等"的对象。
 *
 *   · 一条 chat = **一个文件** `<ledgerDir>/<key>.chat.json`：claim 与终态在同一份 JSON 里（state = running / answered / failed）。
 *     不用目录：目录会被"换出再换回"（ABA）绕过任何事后核对；单文件的读写都落在**同一个已打开的文件对象**上 ——
 *       读：`O_RDONLY | O_NONBLOCK | O_NOFOLLOW` 打开、同一 fd fstat 确认普通文件、从这个 fd 读；
 *       建 claim：先把**完整**记录写进唯一命名的临时文件（O_EXCL）并 fsync，再 `link(tmp, final)` 发布 —— link 从不覆盖既有目录项
 *              （EEXIST = 同一条消息的重放），正式路径上要么没有、要么就是完整记录，没有"空文件"窗口；
 *       记终态：临时文件（同样 O_EXCL 创建）写全 → rename 覆盖；rename 替换的是路径上的那个目录项本身，
 *              路径若已被换成符号链接，替换掉的是链接、不是它指向的东西；
 *       清理只删**自己的临时文件**，且删之前按 dev/ino 核对它还是我打开的那个；正式路径从不按路径删。
 *   · 账本的写事务（建 claim、记终态）都在**同一把账本锁**里（admission.lock，复用 registry.mjs 的 symlink 锁）：
 *       建 claim = 锁内盘点 → 上界 → 发布；记终态 = 锁内重读（必须还是 running，否则 already_final）→ 写全 → rename。
 *       所以"终态只记一次"是锁给的，不是读 - 写之间的一次比较；锁内看到的临时文件只能是上一次事务的残骸。
 *   · 记录形状**封闭**（chatRecordProblem）：键集恰好、时间规范、key 由 chain / message / session 推导、sender_ref / role / risk 枚举、pid 正整数；
 *     终态按 state 与 reason 各自封闭（timeout 带 timeout_ms、nonzero_exit 带 exit_code、signaled 带 signal）；
 *   · "说不清"不折叠成空闲：读不出 / 形状不对的记录、进位残骸（`.tmp.`）、认不出的名字，准入返回 unresolved，入口不起模型；
 *     锁族（admission.lock 及其 reap / maint / 回收 / 隔离残骸）在准入盘点里不算条目（此刻自己就持着锁），但 doctor 单独盘它们；
 *     不持锁的盘点（doctor）分不清"进行中的进位"和"残骸"，只把超过 TMP_RESIDUE_AGE_MS 仍在的临时文件算残骸，年轻的报"进位中"。
 *   · 陈旧：pid 死了又没有终态 = 上次没答完，不重跑，如实报"请再发一条新消息"。
 *
 * key = sha256(chain \0 message_id \0 session_id)。文件里不出 locator：只记 sender 的 sha256 前缀。
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
export const CHAT_RECORD_SUFFIX = ".chat.json";
/** 不持锁的盘点里，临时文件超过这个年龄仍在才算残骸（一次事务只持锁几毫秒）。 */
export const TMP_RESIDUE_AGE_MS = 60 * 1000;
/** 准入等锁的上限（别的事务只持锁几毫秒；超过就是真忙）与记终态等锁的上限（终态丢了会让重放变 stale，多等一会）。 */
export const ADMIT_LOCK_WAIT_MS = 250;
export const RECORD_LOCK_WAIT_MS = 1000;
const KEY_SHAPE = /^[0-9a-f]{64}$/u;
const SENDER_REF_SHAPE = /^sender_[0-9a-f]{16}$/u;
const TMP_SHAPE = /\.chat\.json\.tmp\.\d+\.\d+$/u;
const BASE_KEYS = ["chain", "key", "message_id", "pid", "risk_class", "role", "schema_version", "sender_ref", "session_id", "started_at", "state"];
const ANSWERED_KEYS = [...BASE_KEYS, "elapsed_ms", "recorded_at", "text"].sort().join(",");
const FAILED_KEYS = Object.freeze({
  timeout: [...BASE_KEYS, "diagnostic", "elapsed_ms", "reason", "recorded_at", "timeout_ms", "why"].sort().join(","),
  spawn_failed: [...BASE_KEYS, "diagnostic", "elapsed_ms", "reason", "recorded_at", "why"].sort().join(","),
  nonzero_exit: [...BASE_KEYS, "diagnostic", "elapsed_ms", "exit_code", "reason", "recorded_at", "why"].sort().join(","),
  signaled: [...BASE_KEYS, "diagnostic", "elapsed_ms", "reason", "recorded_at", "signal", "why"].sort().join(","),
  empty_reply: [...BASE_KEYS, "diagnostic", "elapsed_ms", "reason", "recorded_at", "why"].sort().join(","),
});
const RUNNING_KEYS = BASE_KEYS.slice().sort().join(",");
const ADMISSION_LOCK = "admission.lock";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 准入锁家族（与 registry.mjs 的 symlink 锁协议逐一对应）：主锁 / reap 段锁 / 维护锁 / 回收残骸 / 隔离残骸 —— 只有这些名字不算记录。 */
const ADMISSION_LOCK_FAMILY = [
  ["lock", /^admission\.lock$/u], ["reap", /^admission\.lock\.reap$/u], ["maint", /^admission\.lock\.maint$/u],
  ["reaped", new RegExp("^admission\\.lock\\.reaped-" + UUID + "$", "u")], ["quarantine", new RegExp("^admission\\.lock\\.reap\\.quarantine-" + UUID + "$", "u")],
];
export function classifyAdmissionLockEntry(name) {
  for (const [family, re] of ADMISSION_LOCK_FAMILY) if (re.test(name)) return family;
  return null;
}
export const isAdmissionLockEntry = (name) => classifyAdmissionLockEntry(name) !== null;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function chatKey({ chain, messageId, sessionId }) {
  return crypto.createHash("sha256").update([String(chain), String(messageId), String(sessionId ?? "")].join("\0")).digest("hex");
}
export const senderRef = (senderId) => "sender_" + crypto.createHash("sha256").update(String(senderId)).digest("hex").slice(0, 16);
const recordPath = (ledgerDir, key) => path.join(ledgerDir, key + CHAT_RECORD_SUFFIX);
export const admissionLockPath = (ledgerDir) => path.join(ledgerDir, ADMISSION_LOCK);

/** 单文件记录的封闭形状：按 state（与 failed 的 reason）各自封闭键集，并交叉核对 key。 */
export function chatRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.key !== key) return "key 跟文件名对不上";
  if (!CHAT_CHAINS.includes(doc.chain)) return "chain 不在受控集合里";
  if (!nonEmpty(doc.message_id)) return "message_id 缺失";
  if (doc.session_id !== null && !nonEmpty(doc.session_id)) return "session_id 形状不对";
  if (chatKey({ chain: doc.chain, messageId: doc.message_id, sessionId: doc.session_id ?? "" }) !== key) return "key 不是由 chain / message_id / session_id 推导出来的";
  if (!SENDER_REF_SHAPE.test(String(doc.sender_ref))) return "sender_ref 形状不对";
  if (!SENDER_ROLES.includes(doc.role)) return "role 不在受控集合里";
  if (!Object.values(RISK).includes(doc.risk_class)) return "risk_class 不在受控集合里";
  if (!Number.isInteger(doc.pid) || doc.pid <= 0) return "pid 不是正整数";
  if (!isCanonicalIso(doc.started_at)) return "started_at 不是规范时间";
  const keys = Object.keys(doc).sort().join(",");
  if (doc.state === "running") return keys === RUNNING_KEYS ? null : "running 的字段集不对";
  if (doc.state === "answered" || doc.state === "failed") {
    if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
    if (!Number.isInteger(doc.elapsed_ms) || doc.elapsed_ms < 0) return "elapsed_ms 不是非负整数";
  }
  if (doc.state === "answered") {
    if (keys !== ANSWERED_KEYS) return "answered 的字段集不对";
    if (!nonEmpty(doc.text)) return "answered 没有正文";
    return null;
  }
  if (doc.state === "failed") {
    if (!CHAT_FAIL_REASONS.includes(doc.reason)) return "failed 的 reason 不在受控集合里";
    if (keys !== FAILED_KEYS[doc.reason]) return "failed（" + doc.reason + "）的字段集不对";
    if (!nonEmpty(doc.why)) return "failed 缺 why";
    if (doc.diagnostic !== null && typeof doc.diagnostic !== "string") return "diagnostic 形状不对";
    if (doc.reason === "timeout" && !(Number.isInteger(doc.timeout_ms) && doc.timeout_ms > 0)) return "timeout_ms 不是正整数";
    if (doc.reason === "nonzero_exit" && !Number.isInteger(doc.exit_code)) return "exit_code 不是整数";
    if (doc.reason === "signaled" && !SIGNAL_SHAPE.test(String(doc.signal))) return "signal 形状不对";
    return null;
  }
  return "state 不在受控集合里";
}

/** 读记录：O_NONBLOCK | O_NOFOLLOW 打开、同一 fd fstat 确认普通文件、从这个 fd 读 —— 命名管道 / 符号链接 / 目录都不认；fstat 抛错也兜成三态。 */
function readRecord(file) {
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
    try { raw = fs.readFileSync(fd, "utf-8"); } catch (err) { return { status: "unreadable", why: String(err.code ?? err.message) }; }
    try { return { status: "read", doc: JSON.parse(raw) }; } catch { return { status: "unreadable", why: "不是 JSON" }; }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

/**
 * 一条 chat 的状态：absent / answered / failed / running（pid 活着）/ stale（pid 死了、没终态）/ unreadable（读不出、形状不对）。
 */
export function inspectChat({ ledgerDir, key }) {
  if (!KEY_SHAPE.test(String(key))) return { state: "unreadable", why: "key 形状不对" };
  const rec = readRecord(recordPath(ledgerDir, key));
  if (rec.status === "absent") return { state: "absent" };
  if (rec.status === "unreadable") return { state: "unreadable", why: rec.why };
  const problem = chatRecordProblem(rec.doc, key);
  if (problem !== null) return { state: "unreadable", why: problem };
  if (rec.doc.state === "answered" || rec.doc.state === "failed") return { state: rec.doc.state, record: rec.doc };
  return alive(rec.doc.pid) ? { state: "running", record: rec.doc } : { state: "stale", record: rec.doc };
}

/**
 * 盘点：正在答的条数（全局 / 这个发送者）与说不清的条目（读不出 / 形状不对的记录、进位残骸、认不出的名字）。
 * 锁族（精确形状）在这里不算条目 —— 准入自己就持着锁；doctor 用 inspectAdmissionLocks 单独盘它们。
 * locked=true（账本锁内，默认）：临时文件只能是残骸。locked=false（doctor 这类不持锁的读者）：分不清进行中的进位与残骸，
 * 超过 TMP_RESIDUE_AGE_MS 仍在的算残骸，年轻的记进 inflight（不算问题）。
 */
export function chatLoad({ ledgerDir, senderId, now = Date.now(), budgetMs, locked = true }) {
  let names;
  try { names = fs.readdirSync(ledgerDir); }
  catch (err) { return err?.code === "ENOENT" ? { running: 0, bySender: 0, unresolved: 0, inflight: 0, why: [] } : { running: 0, bySender: 0, unresolved: 1, inflight: 0, why: ["目录读不出：" + String(err.code ?? err.message)] }; }
  const me = senderRef(senderId);
  let running = 0; let bySender = 0; let unresolved = 0; let inflight = 0; const why = [];
  for (const n of names) {
    if (isAdmissionLockEntry(n)) continue;
    if (TMP_SHAPE.test(n)) {
      if (locked) { unresolved += 1; why.push("进位残骸（上次事务中断）" + n.slice(0, 20) + "…，人工删除"); continue; }
      let age = null;
      try { age = now - fs.lstatSync(path.join(ledgerDir, n)).mtimeMs; } catch { /* 刚被清掉 = 进位刚结束 */ }
      if (age === null || age <= TMP_RESIDUE_AGE_MS) { inflight += 1; continue; }
      unresolved += 1; why.push("进位残骸（超过 " + Math.round(TMP_RESIDUE_AGE_MS / 1000) + " 秒仍在）" + n.slice(0, 20) + "…，人工删除"); continue;
    }
    if (!n.endsWith(CHAT_RECORD_SUFFIX) || !KEY_SHAPE.test(n.slice(0, -CHAT_RECORD_SUFFIX.length))) { unresolved += 1; why.push("认不出的条目 " + n.slice(0, 40)); continue; }
    const key = n.slice(0, -CHAT_RECORD_SUFFIX.length);
    const seen = inspectChat({ ledgerDir, key });
    if (seen.state === "unreadable") { unresolved += 1; why.push(key.slice(0, 8) + "：" + seen.why); continue; }
    if (seen.state !== "running") continue;
    const startedAt = Date.parse(seen.record.started_at);
    if (Number.isFinite(budgetMs) && now - startedAt > budgetMs + 30_000) continue;
    running += 1;
    if (seen.record.sender_ref === me) bySender += 1;
  }
  return { running, bySender, unresolved, inflight, why };
}

/**
 * doctor 用：锁族的状态（准入盘点看不到它们）。
 *   · reap 段锁残留：准入 / 记终态取锁时会报锁不可用（超过 1 分钟 reap_residue，之前 reap_busy）—— 交 repair-publish-lock 的显式维护入口；
 *   · 维护锁残留：**不挡 chat 准入**，只挡 repair-publish-lock 自己（它会报 maintenance_busy）；维护锁是最后一层，只能由人确认没有维护者在跑后手动删；
 *   · 回收 / 隔离残骸：可直接删；
 *   · 主锁在场超过 staleMs：持有者若已死会由下一笔按协议回收；一直在就是有问题。
 */
export function inspectAdmissionLocks({ ledgerDir, now = Date.now(), staleMs = 5 * 60 * 1000 }) {
  let names;
  try { names = fs.readdirSync(ledgerDir); } catch (err) { return err?.code === "ENOENT" ? { ok: true, problems: [] } : { ok: false, problems: ["目录读不出：" + String(err.code ?? err.message)] }; }
  const problems = [];
  const lockPath = admissionLockPath(ledgerDir);
  for (const n of names) {
    const family = classifyAdmissionLockEntry(n);
    if (family === null) continue;
    if (family === "reap") { problems.push("锁族残留 " + n + "（reap 段锁）：chat 准入与记终态取锁时会报锁不可用，请跑 node scripts/repair-publish-lock.mjs --lock " + lockPath + "（先预览，再加 --apply）"); continue; }
    if (family === "maint") { problems.push("锁族残留 " + n + "（维护锁）：不挡 chat 准入，只挡 repair-publish-lock 的维护入口；确认没有维护者在跑之后手动删除 " + path.join(ledgerDir, n)); continue; }
    if (family === "reaped" || family === "quarantine") { problems.push("锁族残骸 " + n.slice(0, 40) + "…：可直接删"); continue; }
    let st;
    try { st = fs.lstatSync(path.join(ledgerDir, n)); } catch { problems.push("主锁 lstat 失败"); continue; }
    if (now - st.mtimeMs > staleMs) problems.push("主锁已持有超过 " + Math.round((now - st.mtimeMs) / 60000) + " 分钟（正常几毫秒）：持有者若已死会由下一笔按协议回收；一直在就是有问题");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 账本锁：拿到就跑 fn，释放失败挂到结果的 lockUncleared 上（结构化 {reason, detail}，入口按 reason 给受控文案）。
 * 等锁：别的事务只持锁几毫秒，publisher_busy 时按 5ms 步进最多等 waitMs；超过按 busy 返回。
 */
function withLedgerLock(ledgerDir, waitMs, fn) {
  const lockPath = admissionLockPath(ledgerDir);
  const deadline = Date.now() + waitMs;
  let lock;
  for (;;) {
    try { lock = acquirePublishLock(lockPath); }
    catch (err) { return { ok: false, reason: "chat_admission_lock_unavailable", why: "锁原语抛错：" + String(err?.code ?? err?.message ?? err) }; }
    if (lock.ok) break;
    if (lock.reason !== "publisher_busy") return { ok: false, reason: "chat_admission_lock_unavailable", why: String(lock.reason) + (lock.error ? "：" + lock.error : "") };
    if (Date.now() >= deadline) return { ok: false, reason: "chat_admission_busy", text: "chat 正在受理另一条消息，稍后再问", why: "admission.lock 被持有" };
    sleep(5);
  }
  let result;
  try { result = fn(); }
  finally {
    let rel;
    try { rel = releasePublishLock(lockPath); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    if (!rel.ok && result && typeof result === "object") result = { ...result, lockUncleared: { reason: String(rel.reason), detail: rel.error ? String(rel.error) : null } };
  }
  return result;
}

/**
 * 准入 —— **一把锁内**：盘点 → 说不清则拒 → 上界则拒 → 发布 claim（临时文件写全 + link，从不覆盖）。
 * @returns {{ ok: true, key, file, tmpResidue: string|null } | { ok: false, reason, text?, why?, load? }}
 */
export function admitChat({ ledgerDir, key, meta, senderId, now = Date.now(), budgetMs, maxConcurrent = CHAT_MAX_CONCURRENT, maxPerSender = CHAT_MAX_PER_SENDER, lockWaitMs = ADMIT_LOCK_WAIT_MS }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "chat_ledger_unwritable", why: "key 形状不对" };
  try { fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 }); }
  catch (err) { return { ok: false, reason: "chat_ledger_unwritable", why: String(err.code ?? err.message) }; }
  return withLedgerLock(ledgerDir, lockWaitMs, () => {
    const load = chatLoad({ ledgerDir, senderId, now, budgetMs, locked: true });
    if (load.unresolved > 0) {
      // 飞书正文只给状态与受控指引；机器路径与逐条原因只进回执（load.why）
      return { ok: false, reason: "chat_ledger_unresolved", text: "chat 账本有 " + load.unresolved + " 处说不清，不起回答；请在本机跑 doctor（第 ⑨ 项）查看", load };
    }
    if (load.running >= maxConcurrent) return { ok: false, reason: "chat_busy_global", text: "chat 正忙（同时在答 " + load.running + " 条，上限 " + maxConcurrent + "），稍后再问", load };
    if (load.bySender >= maxPerSender) return { ok: false, reason: "chat_busy_sender", text: "你上一条还在答（每人同时只答 " + maxPerSender + " 条），等它答完再问", load };
    return publishClaim({ ledgerDir, key, meta, now });
  });
}

const identityOf = (fd) => { try { const st = fs.fstatSync(fd); return st.dev + ":" + st.ino; } catch { return null; } };
/** 只删自己的临时文件：路径上的目录项与我打开的 inode 一致才删（评审探针：按路径删会删掉换进来的别人）。返回是否已不在。 */
function unlinkOwnTmp(tmp, identity) {
  try {
    const st = fs.lstatSync(tmp);
    if (identity === null || !st.isFile() || st.dev + ":" + st.ino !== identity) return false;
    fs.unlinkSync(tmp);
    return true;
  } catch (err) { return err?.code === "ENOENT"; }
}
/** 把完整内容写进唯一命名的临时文件（O_EXCL | O_NOFOLLOW）并 fsync；返回 { ok, tmp, identity } 或受控失败（自己的临时文件已按 inode 核对后清掉）。 */
function writeTmp(file, content, now) {
  const tmp = file + ".tmp." + process.pid + "." + now;
  let fd = null;
  try {
    try { fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (err) { return { ok: false, why: "临时文件建不出：" + String(err.code ?? err.message) }; }
    const identity = identityOf(fd);
    try { fs.writeSync(fd, content); fs.fsyncSync(fd); }
    catch (err) { unlinkOwnTmp(tmp, identity); return { ok: false, why: String(err.code ?? err.message) }; }
    return { ok: true, tmp, identity };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

/** 发布 claim（锁内）：临时文件写全 → link 到正式路径（EEXIST = duplicate；link 从不覆盖）→ 清掉自己的临时文件。 */
function publishClaim({ ledgerDir, key, meta, now }) {
  const file = recordPath(ledgerDir, key);
  const doc = {
    schema_version: "1.0", state: "running", key,
    chain: meta.chain, message_id: meta.message_id, session_id: meta.session_id ?? null, sender_ref: meta.sender_ref,
    role: meta.role, risk_class: meta.risk_class, pid: process.pid, started_at: new Date(now).toISOString(),
  };
  const problem = chatRecordProblem(doc, key);
  if (problem !== null) return { ok: false, reason: "chat_ledger_unwritable", why: "claim 形状不对：" + problem };
  const w = writeTmp(file, JSON.stringify(doc, null, 2) + "\n", now);
  if (!w.ok) return { ok: false, reason: "chat_ledger_unwritable", why: w.why };
  try { fs.linkSync(w.tmp, file); }
  catch (err) {
    const cleared = unlinkOwnTmp(w.tmp, w.identity);
    if (err?.code === "EEXIST") return { ok: false, reason: "duplicate", key, file, tmpResidue: cleared ? null : w.tmp };
    return { ok: false, reason: "chat_ledger_unwritable", why: "发布 claim 失败：" + String(err.code ?? err.message), tmpResidue: cleared ? null : w.tmp };
  }
  const cleared = unlinkOwnTmp(w.tmp, w.identity);
  return { ok: true, key, file, tmpResidue: cleared ? null : w.tmp };
}

/**
 * 记终态 —— **账本锁内**：重读当前记录（同一 fd 协议）→ 必须还是 running（否则 already_final）→ 合成新记录过形状 → 临时文件写全 → rename 覆盖。
 * 受控返回，不裸抛：{ ok:true } 或 { ok:false, reason: chat_admission_busy | chat_admission_lock_unavailable | claim_unreadable | already_final | outcome_shape | ledger_unwritten }。
 */
export function recordChatOutcome({ ledgerDir, key, outcome, now = Date.now(), lockWaitMs = RECORD_LOCK_WAIT_MS }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "key_shape" };
  const file = recordPath(ledgerDir, key);
  return withLedgerLock(ledgerDir, lockWaitMs, () => {
    const current = readRecord(file);
    if (current.status !== "read") return { ok: false, reason: "claim_unreadable", why: current.status === "absent" ? "claim 缺席" : current.why };
    const currentProblem = chatRecordProblem(current.doc, key);
    if (currentProblem !== null) return { ok: false, reason: "claim_unreadable", why: currentProblem };
    if (current.doc.state !== "running") return { ok: false, reason: "already_final", why: "已经是 " + current.doc.state };
    const doc = { ...current.doc, ...outcome, state: outcome.status, recorded_at: new Date(now).toISOString() };
    delete doc.status;
    const problem = chatRecordProblem(doc, key);
    if (problem !== null) return { ok: false, reason: "outcome_shape", why: problem };
    const w = writeTmp(file, JSON.stringify(doc, null, 2) + "\n", now);
    if (!w.ok) return { ok: false, reason: "ledger_unwritten", why: w.why };
    try { fs.renameSync(w.tmp, file); }
    catch (err) {
      const cleared = unlinkOwnTmp(w.tmp, w.identity);
      return { ok: false, reason: "ledger_unwritten", why: String(err.code ?? err.message), tmpResidue: cleared ? null : w.tmp };
    }
    return { ok: true };
  });
}

/** 锁没交还时给人看的受控文案（按 registry.mjs 释放阶段的 reason 族）：reap 残骸 fail-closed 要人工维护，其余按协议由下一笔回收；路径与 detail 只进机器回执。 */
export function lockUnclearedText(lu) {
  const reason = String(lu?.reason ?? "");
  if (reason.startsWith("reap_residue")) return "准入锁的回收段留有残骸（不会自动恢复）：之后的 chat 会一直报受理忙，请在本机用 repair-publish-lock 处理";
  return "准入锁没有交还；之后的 chat 可能报受理忙，持有者已死超过 5 分钟会按锁协议自动回收，不要手删";
}
