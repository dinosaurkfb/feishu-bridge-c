/**
 * chat 默认态的**机器级账本**（两条链共用）—— 没有绑定就没有项目内的 .runtime-data，但 chat 同样是"一个原始事件用事件 id 做幂等"的对象。
 *
 *   · 一条 chat = **一个文件** `<ledgerDir>/<key>.chat.json`：claim 与终态在同一份 JSON 里（state = running / answered / failed）。
 *     不用目录：目录会被"换出再换回"（ABA）绕过任何事后核对；单文件的读写都落在**同一个已打开的文件对象**上 ——
 *       读：`O_RDONLY | O_NONBLOCK | O_NOFOLLOW` 打开、同一 fd fstat 确认普通文件、从这个 fd 读；
 *       写（claim 与终态同一条路）：先把**完整**记录写进**同一目录**里唯一命名的临时文件（`<key>.<pid>.<time>.<uuid>`，O_EXCL，
 *              循环写满再 fsync），再 rename 成正式路径 —— 正式路径上要么没有、要么就是完整记录，没有"空文件"窗口；
 *              rename 替换的是路径上的那个目录项本身，路径若已被换成符号链接，替换掉的是链接、不是它指向的东西；
 *              临时文件与记录同目录，没有可被替换的父目录（评审探针：scratch 子目录被换成指向外部的链接）。
 *   · 账本的写事务（建 claim、记终态）都在**同一把账本锁**里（admission.lock，复用 registry.mjs 的 symlink 锁），
 *     且提交动作（rename）走 `commitWhileHeld`：在与陈旧回收互斥的 reap 段里核对主锁仍是我这一实例（token）再提交 ——
 *     事务停顿超过 staleMs 被合法回收、锁又被别人拿走时，提交返回 lock_lost，不覆盖别人已落盘的东西。
 *     建 claim = 锁内盘点 → 上界 → 正式路径缺席（否则 duplicate，不写临时文件）→ 写全 → fenced rename；
 *     记终态 = 锁内重读（必须还是 running，否则 already_final）→ 写全 → fenced rename。"只发布一次 / 终态只记一次"由锁 + fencing 给。
 *   · **热路径不删任何东西**：事务半途失败（写失败、提交前锁丢失、rename 失败）留下的临时文件原地保留，结果带 tmpResidue；
 *     它们**不参与准入盘点**（残留不会把账本弄成"说不清"），只由 doctor 盘点（年轻的 = 进位中，超过 TMP_RESIDUE_AGE_MS 仍在的 = 残骸），
 *     清理只走显式维护入口 sweepScratch / chat-scratch-sweep.mjs（账本锁内，只认封闭名字 + 普通文件 + 超阈值；名字唯一，协议里没有写者会再用）。
 *   · 记录形状**封闭**（chatRecordProblem）：键集恰好、时间规范、key 由 chain / message / session 推导、sender_ref / role / risk 枚举、pid 正整数；
 *     终态按 state 与 reason 各自封闭（timeout 带 timeout_ms、nonzero_exit 带 exit_code、signaled 带 signal）；
 *   · "说不清"不折叠成空闲：读不出 / 形状不对的记录、既非记录又非临时文件形状的名字，准入返回 unresolved，入口不起模型；
 *     锁族（admission.lock 及其 reap / maint / 回收 / 隔离残骸）在准入盘点里不算条目，但 doctor 单独盘它们
 *     （reap 段锁复用锁协议自己的投影：活的 / 还新的是在途，超过阈值或形状说不清才算问题）；reap 锁交不还时段内已完成的提交算数（lockUncleared，不裸抛）。
 *   · 陈旧：pid 死了又没有终态 = 上次没答完，不重跑，如实报"请再发一条新消息"。
 *
 * key = sha256(chain \0 message_id \0 session_id)。文件里不出 locator：只记 sender 的 sha256 前缀。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquirePublishLock, releasePublishLock, commitWhileHeld, clearStaleReapLock } from "./registry.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { SENDER_ROLES } from "./sender-roles.mjs";
import { RISK } from "./risk-class.mjs";
import { CHAT_FAIL_REASONS, SIGNAL_SHAPE } from "./chat-reply.mjs";
import { shellQuote } from "./shell-quote.mjs";

export const CHAT_MAX_CONCURRENT = 2;
export const CHAT_MAX_PER_SENDER = 1;
export const CHAT_CHAINS = Object.freeze(["claude", "codex"]);
export const CHAT_RECORD_SUFFIX = ".chat.json";
/** 临时文件超过这个年龄仍在才算残骸（一次事务只持锁几毫秒）。 */
export const TMP_RESIDUE_AGE_MS = 60 * 1000;
/** 准入等锁的上限（别的事务只持锁几毫秒；超过就是真忙）与记终态等锁的上限（终态丢了会让重放变 stale，多等一会）。 */
export const ADMIT_LOCK_WAIT_MS = 250;
export const RECORD_LOCK_WAIT_MS = 1000;
const KEY_SHAPE = /^[0-9a-f]{64}$/u;
const SENDER_REF_SHAPE = /^sender_[0-9a-f]{16}$/u;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 临时文件我们只会生成这种名字：<key>.<pid>.<time>.<uuid>（与记录同目录；不参与准入盘点） */
export const TMP_NAME_SHAPE = new RegExp("^[0-9a-f]{64}\\.\\d+\\.\\d+\\." + UUID + "$", "u");
/**
 * 临时文件条目的全部合法形状：原名后面可叠加 sweep 留下的标记段（.quarantine- / .owned- / .unknown-<uuid>），按**最后一段**分类：
 *   · 无标记 / .owned-   → 候选（归属已核过，允许自动按隔离协议删）；
 *   · .quarantine-       → 归属未确认（隔离后还没核完身份就中断，或落标失败）—— 自动维护永不再碰，准入说不清，只人工处置；
 *   · .unknown-          → 归属不明（隔离后身份对不上）—— 同上，只人工处置。
 * 裸 .quarantine 永远代表"未确认"：身份核验成功才改成 .owned，只有 .owned 允许自动重试删除（评审探针：落标失败让归属不明的东西变回候选）。
 * 标记段**替换**而不是叠加（最多一段）：文件名有 255 字节上限，叠加几轮就 ENAMETOOLONG。
 */
const TMP_ENTRY_SHAPE = new RegExp("^[0-9a-f]{64}\\.\\d+\\.\\d+\\." + UUID + "(\\.(quarantine|owned|unknown)-" + UUID + ")?$", "u");
const LAST_MARK = new RegExp("\\.(quarantine|owned|unknown)-" + UUID + "$", "u");
/** 临时条目分类：candidate / unconfirmed / unknown；名字不是临时条目形状 → null。 */
export function classifyTmpEntry(name) {
  if (!TMP_ENTRY_SHAPE.test(name)) return null;
  const m = LAST_MARK.exec(name);
  if (m === null || m[1] === "owned") return "candidate";
  return m[1] === "quarantine" ? "unconfirmed" : "unknown";
}
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
 * 盘点：正在答的条数（全局 / 这个发送者）与说不清的条目（读不出 / 形状不对的记录、既非记录又非临时文件形状的名字）。
 * 锁族（精确形状）与临时文件（精确形状）在这里不算条目 —— 准入自己就持着锁，临时文件只由 doctor 盘。
 */
export function chatLoad({ ledgerDir, senderId, now = Date.now(), budgetMs }) {
  let names;
  try { names = fs.readdirSync(ledgerDir); }
  catch (err) { return err?.code === "ENOENT" ? { running: 0, bySender: 0, unresolved: 0, why: [] } : { running: 0, bySender: 0, unresolved: 1, why: ["目录读不出：" + String(err.code ?? err.message)] }; }
  const me = senderRef(senderId);
  let running = 0; let bySender = 0; let unresolved = 0; const why = [];
  for (const n of names) {
    if (isAdmissionLockEntry(n)) continue;
    const tmpKind = classifyTmpEntry(n);
    if (tmpKind === "unknown") { unresolved += 1; why.push("归属不明的制品（隔离时身份对不上，只能人工处置）" + n.slice(0, 20) + "…"); continue; }
    if (tmpKind === "unconfirmed") { unresolved += 1; why.push("归属未确认的制品（隔离后没核完身份，只能人工处置）" + n.slice(0, 20) + "…"); continue; }
    if (tmpKind === "candidate") {
      // 只跳过**受验的普通文件**；临时名字上挂着符号链接 / 目录 / 管道就是说不清，不折成可用
      let st = null;
      try { st = fs.lstatSync(path.join(ledgerDir, n)); } catch (err) { if (err?.code === "ENOENT") continue; }
      if (st === null || !st.isFile()) { unresolved += 1; why.push("临时文件位置上不是普通文件 " + n.slice(0, 20) + "…"); }
      continue;
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
  return { running, bySender, unresolved, why };
}

/** 维护命令里给真实路径（破坏性入口只认真实路径）；解析不了就原样给。 */
const realLedgerPath = (dir) => { try { return fs.realpathSync(dir); } catch { return dir; } };
/** 盘点临时文件（封闭名字）：普通文件按年龄分进位中 / 残骸；不是普通文件或 lstat 非 ENOENT 错误 = 说不清。 */
function scanTmp(ledgerDir, now) {
  let names;
  try { names = fs.readdirSync(ledgerDir); }
  catch (err) { return { ok: err?.code === "ENOENT", why: err?.code === "ENOENT" ? null : "目录读不出：" + String(err.code ?? err.message), entries: [] }; }
  const entries = [];
  for (const n of names) {
    const tmpKind = classifyTmpEntry(n);
    if (tmpKind === null) continue;
    if (tmpKind === "unknown") { entries.push({ name: n, kind: "unknown", why: "归属不明（隔离时身份对不上），自动维护不碰，请人工核对后删除：" + path.join(ledgerDir, n) }); continue; }
    if (tmpKind === "unconfirmed") { entries.push({ name: n, kind: "unknown", why: "归属未确认（隔离后没核完身份 —— 中途退出或落标失败），自动维护不碰，请人工核对后删除：" + path.join(ledgerDir, n) }); continue; }
    let st;
    try { st = fs.lstatSync(path.join(ledgerDir, n)); }
    catch (err) { if (err?.code === "ENOENT") continue; entries.push({ name: n, kind: "unclear", why: "lstat 失败（" + String(err.code ?? err.message) + "）" }); continue; }
    if (!st.isFile()) { entries.push({ name: n, kind: "unclear", why: "不是普通文件" }); continue; }
    // 身份在盘点这一刻记下：隔离后按它核对 —— 盘点与删除之间被换进来的东西身份不同，不会被删
    entries.push({ name: n, kind: "file", ageMs: now - st.mtimeMs, dev: st.dev, ino: st.ino });
  }
  return { ok: true, why: null, entries };
}

/**
 * doctor 用：临时文件的状态。年轻的（≤ TMP_RESIDUE_AGE_MS）= 进位中（不算问题），老的 = 残骸（不影响准入，交 chat-scratch-sweep）；
 * 名字对但不是普通文件 / lstat 非 ENOENT 错误 = 说不清（问题）。
 */
export function inspectScratch({ ledgerDir, now = Date.now() }) {
  const scan = scanTmp(ledgerDir, now);
  if (!scan.ok) return { inflight: 0, problems: [scan.why] };
  let inflight = 0; const problems = [];
  for (const e of scan.entries) {
    if (e.kind === "unknown") { problems.push("归属不明的制品：" + e.why); continue; }
    if (e.kind === "unclear") { problems.push("临时文件位置上说不清的条目（" + e.why + "，不动）：" + e.name.slice(0, 40)); continue; }
    if (e.ageMs <= TMP_RESIDUE_AGE_MS) { inflight += 1; continue; }
    problems.push("scratch 残骸（超过 " + Math.round(TMP_RESIDUE_AGE_MS / 1000) + " 秒仍在）" + e.name.slice(0, 20) + "…：不影响准入，用 node scripts/chat-scratch-sweep.mjs --ledger " + shellQuote(realLedgerPath(ledgerDir)) + " 清（先预览，再加 --apply）");
  }
  return { inflight, problems };
}

/**
 * 破坏性入口的账本目录边界：必须是绝对路径、真实路径（各段都不经符号链接：realpath 与给定路径相等）、本身是目录（lstat，不是符号链接）。
 * @returns {null | string} 通过返回 null，否则返回原因
 */
export function ledgerDirProblem(ledgerDir) {
  return verifyLedgerDir(ledgerDir).problem;
}
/** 同上，但把通过时的目录身份（dev/ino）带回来 —— 取锁之后要用它重核（校验与操作之间目录可能被换）。 */
function verifyLedgerDir(ledgerDir) {
  if (typeof ledgerDir !== "string" || ledgerDir.length === 0) return { problem: "账本目录缺失", identity: null };
  if (!path.isAbsolute(ledgerDir)) return { problem: "账本目录必须是绝对路径", identity: null };
  let st;
  try { st = fs.lstatSync(ledgerDir); } catch (err) { return { problem: "账本目录 lstat 失败：" + String(err?.code ?? err?.message ?? err), identity: null }; }
  if (st.isSymbolicLink()) return { problem: "账本目录是符号链接（别名），不动", identity: null };
  if (!st.isDirectory()) return { problem: "账本目录不是目录", identity: null };
  let real;
  try { real = fs.realpathSync(ledgerDir); } catch (err) { return { problem: "账本目录 realpath 失败：" + String(err?.code ?? err?.message ?? err), identity: null }; }
  if (real !== ledgerDir) return { problem: "账本目录路径里有符号链接（真实路径不同），请用真实路径", identity: null };
  return { problem: null, identity: { dev: st.dev, ino: st.ino } };
}
/** 取锁之后重核目录身份：还是同一个目录（lstat 非符号链接、dev/ino 一致）才继续操作。 */
function ledgerDirStillSame(ledgerDir, identity) {
  let st;
  try { st = fs.lstatSync(ledgerDir); } catch (err) { return "账本目录 lstat 失败：" + String(err?.code ?? err?.message ?? err); }
  if (st.isSymbolicLink() || !st.isDirectory()) return "账本目录在校验之后被换掉（不再是目录本身）";
  if (identity === null || st.dev !== identity.dev || st.ino !== identity.ino) return "账本目录在校验之后被换掉（身份不同）";
  return null;
}

/**
 * 显式维护入口：清 scratch 残骸。账本目录先过 ledgerDirProblem；账本锁内、只认封闭名字 + 普通文件 + 超过 olderThanMs；说不清的不动。
 * 删除走**隔离协议**（评审探针：盘点后按原路径 unlink 会删掉换进来的目录项）：lstat 记身份 → rename 到唯一隔离路径 → 隔离路径上 lstat
 * 核对 dev/ino 一致才 unlink；不一致 = 实例已变（instance_changed），保留在隔离路径、不删；隔离后没删成也保留（quarantine_unremoved）。
 * 隔离名（.quarantine-<uuid>）仍是受验形状，下次 sweep 会再处理。
 * @returns {{ ok: true, candidates: {name, ageMs, removed, reason, quarantine}[], young: number, problems: string[], lockUncleared?, lockLost? } | { ok: false, reason, why? }}
 */
export function sweepScratch({ ledgerDir, now = Date.now(), apply = false, olderThanMs = TMP_RESIDUE_AGE_MS }) {
  const dir = verifyLedgerDir(ledgerDir);
  if (dir.problem !== null) return { ok: false, reason: "ledger_dir_unverified", why: dir.problem };
  return withLedgerLock(ledgerDir, ADMIT_LOCK_WAIT_MS, () => {
    // 校验与取锁之间目录可能被换（评审探针：realpath 返回前换成指向外部的链接）：取锁后按 dev/ino 重核，不同就什么都不做
    const changed = ledgerDirStillSame(ledgerDir, dir.identity);
    if (changed !== null) return { ok: false, reason: "ledger_dir_changed", why: changed };
    const scan = scanTmp(ledgerDir, now);
    if (!scan.ok) return { ok: true, candidates: [], young: 0, problems: [scan.why] };
    const candidates = []; const problems = []; let young = 0;
    for (const e of scan.entries) {
      if (e.kind === "unknown") { problems.push(e.why); continue; }
      if (e.kind === "unclear") { problems.push(e.name.slice(0, 40) + "（" + e.why + "）"); continue; }
      if (e.ageMs <= olderThanMs) { young += 1; continue; }
      const c = { name: e.name, ageMs: e.ageMs, removed: false, reason: null, quarantine: null };
      if (apply) Object.assign(c, quarantineAndRemove(path.join(ledgerDir, e.name), { dev: e.dev, ino: e.ino }));
      candidates.push(c);
    }
    return { ok: true, candidates, young, problems };
  });
}
/** 隔离协议的一次执行（身份来自盘点那一刻）：rename 到唯一隔离路径 → 隔离路径上 lstat 核对 dev/ino → 一致才 unlink。返回 { removed, reason, quarantine }。 */
function quarantineAndRemove(full, before) {
  const base = full.replace(LAST_MARK, "");
  const q = base + ".quarantine-" + crypto.randomUUID();
  try { fs.renameSync(full, q); }
  catch (err) { return err?.code === "ENOENT" ? { removed: true, reason: "already_gone", quarantine: null } : { removed: false, reason: "quarantine_failed：" + String(err.code ?? err.message), quarantine: null }; }
  let after;
  try { after = fs.lstatSync(q); }
  catch (err) { return { removed: false, reason: "quarantine_unreadable：" + String(err.code ?? err.message), quarantine: q }; }
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
    // 身份对不上 = 盘点与隔离之间被换过，隔离路径上的东西归属不明：再改名成持久标记；改名失败也没关系 —— 裸 .quarantine 本身就是"未确认"，同样只人工处置
    const u = base + ".unknown-" + crypto.randomUUID();
    try { fs.renameSync(q, u); return { removed: false, reason: "instance_changed", quarantine: u }; }
    catch (err) { return { removed: false, reason: "instance_changed（改名持久标记失败：" + String(err.code ?? err.message) + "，留在未确认态）", quarantine: q }; }
  }
  // 身份一致 = 本入口确认归属：先改成 .owned（只有这个形状允许自动重试删除），再删。
  // 这里的 lstat → unlink 仍是两步：协议外、同 UID 的路径替换不在威胁模型内（它能改账本里的任何东西），见契约 §14c
  const o = base + ".owned-" + crypto.randomUUID();
  try { fs.renameSync(q, o); }
  catch (err) { return { removed: false, reason: "owned_mark_failed：" + String(err.code ?? err.message) + "（留在未确认态）", quarantine: q }; }
  try { fs.unlinkSync(o); }
  catch (err) { return { removed: false, reason: "quarantine_unremoved：" + String(err.code ?? err.message), quarantine: o }; }
  return { removed: true, reason: null, quarantine: o };
}

/**
 * doctor 用：锁族的状态（准入盘点看不到它们）。
 *   · reap 段锁：复用锁协议自己的投影（clearStaleReapLock 预览，只读）—— 活的 / 还新的是在途（notes），超过阈值才是残骸（problems，给 repair 命令），
 *     形状说不清（目录 / 普通文件 / 畸形 symlink）也是问题；隔离残骸同样按它的 recognized / 年龄判；
 *   · 维护锁残留：**不挡 chat 准入**，只挡 repair-publish-lock 自己（它会报 maintenance_busy）；维护锁是最后一层，只能由人确认没有维护者在跑后手动删；
 *   · 回收残骸（.reaped-<uuid>）：可直接删；
 *   · 主锁在场超过 staleMs：持有者若已死会由下一笔按协议回收；一直在就是有问题。
 * @returns {{ ok: boolean, problems: string[], notes: string[] }}
 */
export function inspectAdmissionLocks({ ledgerDir, now = Date.now(), staleMs = 5 * 60 * 1000 }) {
  let names;
  try { names = fs.readdirSync(ledgerDir); } catch (err) { return err?.code === "ENOENT" ? { ok: true, problems: [], notes: [] } : { ok: false, problems: ["目录读不出：" + String(err.code ?? err.message)], notes: [] }; }
  const problems = []; const notes = [];
  const lockPath = admissionLockPath(ledgerDir);
  const repairCmd = "node scripts/repair-publish-lock.mjs --lock " + lockPath + "（先预览，再加 --apply）";
  let reapChecked = false;
  for (const n of names) {
    const family = classifyAdmissionLockEntry(n);
    if (family === null) continue;
    if (family === "reap" || family === "quarantine") {
      if (reapChecked) continue;
      reapChecked = true;
      const r = clearStaleReapLock(lockPath, { apply: false });
      if (r.reason === "io_error") problems.push("reap 段锁查不清（I/O 错误，阶段 " + (r.phase ?? "?") + "）：" + String(r.error ?? ""));
      else if (r.reason === "unrecognized_artifact") problems.push("reap 路径上的东西不是本协议的残骸（目录 / 普通文件 / 畸形 symlink），不动，请人工查看：" + r.reapDir);
      else if (r.present && r.stale) problems.push("锁族残留 admission.lock.reap（reap 段锁，已 " + Math.round(r.ageMs / 1000) + " 秒）：chat 准入与记终态取锁时会报锁不可用，请跑 " + repairCmd);
      else if (r.present) notes.push("reap 段锁在途（" + Math.max(0, Math.round(r.ageMs)) + " 毫秒，归属转换只持有几毫秒，不算问题）");
      for (const q of r.quarantine ?? []) {
        if (!q.recognized) problems.push("隔离路径上说不清的东西（不动，请人工查看）：" + q.path);
        else if (q.ageMs > 60 * 1000) problems.push("隔离残骸（已 " + Math.round(q.ageMs / 1000) + " 秒）可清：" + repairCmd);
        else notes.push("隔离路径在途（刚隔离，随后会删）");
      }
      continue;
    }
    if (family === "maint") { problems.push("锁族残留 " + n + "（维护锁）：不挡 chat 准入，只挡 repair-publish-lock 的维护入口；确认没有维护者在跑之后手动删除 " + path.join(ledgerDir, n)); continue; }
    if (family === "reaped") { problems.push("回收残骸 " + n.slice(0, 40) + "…：可直接删"); continue; }
    let st;
    try { st = fs.lstatSync(path.join(ledgerDir, n)); } catch { problems.push("主锁 lstat 失败"); continue; }
    if (now - st.mtimeMs > staleMs) problems.push("主锁已持有超过 " + Math.round((now - st.mtimeMs) / 60000) + " 分钟（正常几毫秒）：持有者若已死会由下一笔按协议回收；一直在就是有问题");
  }
  return { ok: problems.length === 0, problems, notes };
}

/**
 * 账本锁：拿到就跑 fn，释放失败挂到结果的 lockUncleared 上（结构化 {reason, detail}，入口按 reason 给受控文案；fn 自己已带的更具体、不覆盖）；
 * 释放时发现锁已不是我的 / 已缺席（被合法回收过）→ lockLost:true。
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
  try { result = fn(lockPath); }
  finally {
    let rel;
    try { rel = releasePublishLock(lockPath); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    if (result && typeof result === "object") {
      if (!result.lockUncleared) {
        if (!rel.ok && rel.reason !== "not_owner") result = { ...result, lockUncleared: { reason: String(rel.reason), detail: rel.error ? String(rel.error) : null } };
        else if (rel.ok && rel.reapUncleared) result = { ...result, lockUncleared: { reason: "reap_residue_uncleared", detail: String(rel.reapUncleared.error ?? "") } };
      }
      if ((rel.ok && rel.absent) || (!rel.ok && rel.reason === "not_owner")) result = { ...result, lockLost: true };
    }
  }
  return result;
}

/**
 * 准入 —— **一把锁内**：盘点 → 说不清则拒 → 上界则拒 → 正式路径缺席（否则 duplicate）→ 写全 → fenced rename。
 * @returns {{ ok: true, key, file, tmpResidue: null, lockUncleared? } | { ok: false, reason, text?, why?, load?, tmpResidue? }}
 */
export function admitChat({ ledgerDir, key, meta, senderId, now = Date.now(), budgetMs, maxConcurrent = CHAT_MAX_CONCURRENT, maxPerSender = CHAT_MAX_PER_SENDER, lockWaitMs = ADMIT_LOCK_WAIT_MS }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "chat_ledger_unwritable", why: "key 形状不对" };
  try { fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 }); }
  catch (err) { return { ok: false, reason: "chat_ledger_unwritable", why: String(err.code ?? err.message) }; }
  return withLedgerLock(ledgerDir, lockWaitMs, (lockPath) => {
    const load = chatLoad({ ledgerDir, senderId, now, budgetMs });
    if (load.unresolved > 0) {
      // 飞书正文只给状态与受控指引；机器路径与逐条原因只进回执（load.why）
      return { ok: false, reason: "chat_ledger_unresolved", text: "chat 账本有 " + load.unresolved + " 处说不清，不起回答；请在本机跑 doctor（第 ⑨ 项）查看", load };
    }
    if (load.running >= maxConcurrent) return { ok: false, reason: "chat_busy_global", text: "chat 正忙（同时在答 " + load.running + " 条，上限 " + maxConcurrent + "），稍后再问", load };
    if (load.bySender >= maxPerSender) return { ok: false, reason: "chat_busy_sender", text: "你上一条还在答（每人同时只答 " + maxPerSender + " 条），等它答完再问", load };
    return publishClaim({ ledgerDir, key, meta, now, lockPath });
  });
}

/** 把完整内容写进同目录里唯一命名的临时文件（O_EXCL | O_NOFOLLOW）：循环写满、fsync、关；写失败**原地保留**（热路径不删），带 tmpResidue。 */
function writeTmp(ledgerDir, key, content, now) {
  const tmp = path.join(ledgerDir, key + "." + process.pid + "." + now + "." + crypto.randomUUID());
  let fd = null;
  try {
    try { fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (err) { return { ok: false, why: "临时文件建不出：" + String(err.code ?? err.message), tmpResidue: null }; }
    try {
      const buf = Buffer.from(content, "utf-8");
      let off = 0;
      while (off < buf.length) {
        const n = fs.writeSync(fd, buf, off, buf.length - off);
        if (!(Number.isInteger(n) && n > 0)) throw Object.assign(new Error("short write"), { code: "ESHORTWRITE" });
        off += n;
      }
      fs.fsyncSync(fd);
    } catch (err) {
      return { ok: false, why: String(err.code ?? err.message), tmpResidue: residueOf(tmp, "写临时文件失败（" + String(err.code ?? err.message) + "）") };
    }
    return { ok: true, tmp };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}
const residueOf = (tmp, why) => ({ path: tmp, why: why + "；热路径不删，原地保留，doctor 会点名，用 chat-scratch-sweep 清" });
/** fenced 提交之后：把 commitWhileHeld 的结果折成 { ok, reason?, why?, lockUncleared? }。 */
function afterCommit(fenced, tmp, commitErr) {
  const lockUncleared = fenced.reapUncleared ? { reason: "reap_residue_uncleared", detail: String(fenced.reapUncleared.error ?? "") } : null;
  if (!fenced.ok) return { ok: false, reason: fenced.reason === "lock_lost" ? "chat_ledger_lock_lost" : "chat_admission_lock_unavailable", why: "提交前核对锁：" + fenced.reason, tmpResidue: residueOf(tmp, "提交前核对锁失败") };
  if (commitErr !== null) return { ok: false, reason: "commit_failed", why: String(commitErr.code ?? commitErr.message), tmpResidue: residueOf(tmp, "rename 失败（" + String(commitErr.code ?? commitErr.message) + "）"), ...(lockUncleared ? { lockUncleared } : {}) };
  return { ok: true, tmpResidue: null, ...(lockUncleared ? { lockUncleared } : {}) };
}

/** 发布 claim（锁内）：正式路径缺席（否则 duplicate，不写临时文件）→ 写全 → fenced rename（段内再核一次缺席）。 */
function publishClaim({ ledgerDir, key, meta, now, lockPath }) {
  const file = recordPath(ledgerDir, key);
  const before = readRecord(file);
  if (before.status === "read") return { ok: false, reason: "duplicate", key, file, tmpResidue: null };
  if (before.status === "unreadable") return { ok: false, reason: "chat_ledger_unwritable", why: "正式路径上已有说不清的东西：" + before.why };
  const doc = {
    schema_version: "1.0", state: "running", key,
    chain: meta.chain, message_id: meta.message_id, session_id: meta.session_id ?? null, sender_ref: meta.sender_ref,
    role: meta.role, risk_class: meta.risk_class, pid: process.pid, started_at: new Date(now).toISOString(),
  };
  const problem = chatRecordProblem(doc, key);
  if (problem !== null) return { ok: false, reason: "chat_ledger_unwritable", why: "claim 形状不对：" + problem };
  const w = writeTmp(ledgerDir, key, JSON.stringify(doc, null, 2) + "\n", now);
  if (!w.ok) return { ok: false, reason: "chat_ledger_unwritable", why: w.why, tmpResidue: w.tmpResidue };
  let commitErr = null; let dup = false;
  const fenced = commitWhileHeld(lockPath, () => {
    if (readRecord(file).status !== "absent") { dup = true; return; }
    try { fs.renameSync(w.tmp, file); } catch (err) { commitErr = err; }
  });
  if (fenced.ok && dup) return { ok: false, reason: "duplicate", key, file, tmpResidue: residueOf(w.tmp, "提交时正式路径已出现（重放）") };
  const r = afterCommit(fenced, w.tmp, commitErr);
  if (!r.ok) return r.reason === "commit_failed" ? { ...r, reason: "chat_ledger_unwritable", why: "发布 claim 失败：" + r.why } : r;
  return { ...r, key, file };
}

/**
 * 记终态 —— **账本锁内**：重读当前记录（同一 fd 协议）→ 必须还是 running（否则 already_final）→ 合成新记录过形状 → 写全 → fenced rename 覆盖。
 * 受控返回，不裸抛：{ ok:true } 或 { ok:false, reason: chat_admission_busy | chat_admission_lock_unavailable | chat_ledger_lock_lost | claim_unreadable | already_final | outcome_shape | ledger_unwritten }。
 */
export function recordChatOutcome({ ledgerDir, key, outcome, now = Date.now(), lockWaitMs = RECORD_LOCK_WAIT_MS }) {
  if (!KEY_SHAPE.test(String(key))) return { ok: false, reason: "key_shape" };
  const file = recordPath(ledgerDir, key);
  return withLedgerLock(ledgerDir, lockWaitMs, (lockPath) => {
    const current = readRecord(file);
    if (current.status !== "read") return { ok: false, reason: "claim_unreadable", why: current.status === "absent" ? "claim 缺席" : current.why };
    const currentProblem = chatRecordProblem(current.doc, key);
    if (currentProblem !== null) return { ok: false, reason: "claim_unreadable", why: currentProblem };
    if (current.doc.state !== "running") return { ok: false, reason: "already_final", why: "已经是 " + current.doc.state };
    const doc = { ...current.doc, ...outcome, state: outcome.status, recorded_at: new Date(now).toISOString() };
    delete doc.status;
    const problem = chatRecordProblem(doc, key);
    if (problem !== null) return { ok: false, reason: "outcome_shape", why: problem };
    const w = writeTmp(ledgerDir, key, JSON.stringify(doc, null, 2) + "\n", now);
    if (!w.ok) return { ok: false, reason: "ledger_unwritten", why: w.why, tmpResidue: w.tmpResidue };
    let commitErr = null;
    const fenced = commitWhileHeld(lockPath, () => { try { fs.renameSync(w.tmp, file); } catch (err) { commitErr = err; } });
    const r = afterCommit(fenced, w.tmp, commitErr);
    if (!r.ok) return r.reason === "commit_failed" ? { ...r, reason: "ledger_unwritten" } : r;
    return r;
  });
}

/** 锁没交还时给人看的受控文案（按 registry.mjs 释放阶段的 reason 族）：reap 残骸 fail-closed 要人工维护，其余按协议由下一笔回收；路径与 detail 只进机器回执。 */
export function lockUnclearedText(lu) {
  const reason = String(lu?.reason ?? "");
  if (reason.startsWith("reap_residue")) return "准入锁的回收段留有残骸（不会自动恢复）：之后的 chat 会一直报受理忙，请在本机用 repair-publish-lock 处理";
  return "准入锁没有交还；之后的 chat 可能报受理忙，持有者已死超过 5 分钟会按锁协议自动回收，不要手删";
}
