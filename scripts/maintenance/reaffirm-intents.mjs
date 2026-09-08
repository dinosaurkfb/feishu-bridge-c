/**
 * R57b：reaffirm intent store（owner-select-route.md §8.1——迁移期专用 sidecar，迁移完删）。
 *
 * 两个事务域：`request_reaffirm`（本模块的 issueReaffirmIntent，**sidecar 写事务**）与
 * `owner_select_reaffirm`（topic-agent-ledger.mjs 的 ledger op）分开。reaffirm_handle 即唯一不可变
 * intent id（rfh_+32hex），既是 handle 又是 entries 主键与 request_key 派生源（ext=reaffirm_handle）。
 *
 * 文件：`ledger/<endpoint>/reaffirm-intents.json`；封闭 schema `{ schema_version, entries }`、
 * 键 = reaffirm_handle、entry 九键封闭、expires_at === issued_at + OWNER_SELECT_REAFFIRM_TTL_MS（唯一常量，
 * 住账本模块）；0700 目录 / 0600 文件、fd 绑定读（O_NOFOLLOW|O_NONBLOCK）、普通 gated intent 文件锁
 * （reaffirm 发生在门外：不要求 maintenance lease、也不开放 ungated ledger 写面——七轮 P1-5）；
 * 大小 ≤ 256 KiB、entries ≤ 512；unreadable 一律 fail-closed 阻断，绝不折成「无 intent」。
 *
 * 锁序（P1-5 修正）：outer（控制事务锁，消费方已持）→ **intent 锁**（本模块）→ ledger 锁（gatedTx 内）。
 * 消费在持 intent 锁期间完成 intent CAS + ledger commit；提交后清 intent 失败靠相同 request_key 恢复。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonKey, sha256, isObj } from "./canon.mjs";
import { isCanonicalIso, canonicalIso, isCanonicalMs } from "../canonical-time.mjs";
import { acquireLockUngated, releasePublishLock } from "../registry.mjs";
import {
  OWNER_SELECT_REAFFIRM_TTL_MS, REAFFIRM_HANDLE_SHAPE, ID_SHAPE, ENDPOINT_SHAPE, CHAT_SHAPE,
  AUTHORIZED_BY_SHAPE, SHA_SHAPE, resolveEndpointDir, loadLedger, familyOf,
  ownerSelectReaffirmClosureDigest, ownerSelectReaffirm,
} from "../topic-agent-ledger.mjs";

export const REAFFIRM_INTENTS_FILE = "reaffirm-intents.json";
export const REAFFIRM_INTENTS_LOCK = "reaffirm-intents.lock";
export const REAFFIRM_INTENTS_SCHEMA = "reaffirm-intents-1";
export const REAFFIRM_INTENTS_MAX_BYTES = 256 * 1024;
export const REAFFIRM_INTENTS_MAX_ENTRIES = 512;

// §4：reaffirm_handle 的合法族（B1 无证不可 reaffirm；A1/A2 同理）。
export const REAFFIRM_TARGET_FAMILIES = Object.freeze(["B3", "B3'", "B4", "A3", "A4"]);

const keysOf = (o) => Object.keys(o).sort().join(",");
const errCode = (err) => String(err?.code ?? err?.message ?? err);
const ENTRY_KEYS = "authorized_owner,chat_id,endpoint,expected_old_proof_closure_digest,expires_at,issued_at,reaffirm_handle,target_family,target_id";

/** 封闭 schema 校验器：返回 null 或问题短句。entries 键 = reaffirm_handle（主键即 handle，P1-5）。 */
export function reaffirmIntentsProblem(doc) {
  if (!isObj(doc)) return "文件不是对象";
  if (keysOf(doc) !== "entries,schema_version") return "字段集不对";
  if (doc.schema_version !== REAFFIRM_INTENTS_SCHEMA) return "schema_version 不对";
  if (!isObj(doc.entries)) return "entries 不是对象";
  const keys = Object.keys(doc.entries);
  if (keys.length > REAFFIRM_INTENTS_MAX_ENTRIES) return "entries 超上限（" + keys.length + " > " + REAFFIRM_INTENTS_MAX_ENTRIES + "）";
  for (const [k, e] of Object.entries(doc.entries)) {
    if (!REAFFIRM_HANDLE_SHAPE.test(k)) return "entry 键不是合法 rfh_ 形状：" + k.slice(0, 8);
    if (!isObj(e) || keysOf(e) !== ENTRY_KEYS) return "entry 字段集不对（" + k.slice(0, 8) + "）";
    if (e.reaffirm_handle !== k) return "reaffirm_handle 与键不一致（" + k.slice(0, 8) + "）";
    if (typeof e.target_id !== "string" || !ID_SHAPE.test(e.target_id)) return "target_id 形状不对（" + k.slice(0, 8) + "）";
    if (!REAFFIRM_TARGET_FAMILIES.includes(e.target_family)) return "target_family 越界（" + k.slice(0, 8) + "）";
    if (typeof e.authorized_owner !== "string" || !AUTHORIZED_BY_SHAPE.test(e.authorized_owner)) return "authorized_owner 形状不对（" + k.slice(0, 8) + "）";
    if (typeof e.endpoint !== "string" || !ENDPOINT_SHAPE.test(e.endpoint)) return "endpoint 形状不对（" + k.slice(0, 8) + "）";
    if (typeof e.chat_id !== "string" || !CHAT_SHAPE.test(e.chat_id)) return "chat_id 形状不对（" + k.slice(0, 8) + "）";
    if (!isCanonicalIso(e.issued_at) || !isCanonicalIso(e.expires_at)) return "时间不规范（" + k.slice(0, 8) + "）";
    if (Date.parse(e.expires_at) !== Date.parse(e.issued_at) + OWNER_SELECT_REAFFIRM_TTL_MS) return "expires_at ≠ issued_at + TTL（" + k.slice(0, 8) + "）";
    if (typeof e.expected_old_proof_closure_digest !== "string" || !SHA_SHAPE.test(e.expected_old_proof_closure_digest)) return "digest 形状不对（" + k.slice(0, 8) + "）";
  }
  return null;
}

/** 受验读：fd 绑定、O_NOFOLLOW|O_NONBLOCK、普通文件、单硬链接、0600、≤256KiB、封闭 schema。
 *  返回 { ok:true, doc, sha256, bytes } / { ok:true, absent:true, doc:空档 } / { ok:false, problem }。 */
export function readReaffirmIntents({ endpointDir }) {
  if (typeof endpointDir !== "string" || endpointDir.length === 0) return { ok: false, problem: "endpointDir 缺失" };
  const file = path.join(endpointDir, REAFFIRM_INTENTS_FILE);
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, absent: true, doc: { schema_version: REAFFIRM_INTENTS_SCHEMA, entries: {} } };
    return { ok: false, problem: "open 失败: " + errCode(err) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, problem: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, problem: "硬链接数不为 1" };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, problem: "mode 不是 0600: " + (st.mode & 0o777).toString(8) };
    if (st.size > REAFFIRM_INTENTS_MAX_BYTES) return { ok: false, problem: "超过大小上限（" + st.size + " > " + REAFFIRM_INTENTS_MAX_BYTES + "）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) return { ok: false, problem: "读不满文件（" + off + "/" + st.size + "）" };
      off += n;
    }
    let doc = null;
    try { doc = JSON.parse(buf.toString("utf-8")); } catch (err) { return { ok: false, problem: "JSON 解析失败: " + errCode(err) }; }
    const p = reaffirmIntentsProblem(doc);
    if (p !== null) return { ok: false, problem: p };
    return { ok: true, doc, sha256: sha256(buf), bytes: buf.length };
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/** tmp + rename + fsync 落盘（0600、O_EXCL|O_NOFOLLOW、写端 fd 复核 nlink，目录 fsync）。返回 { ok } 或 { ok:false, problem }。 */
function writeIntentsFile(dir, doc) {
  const bytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf-8");
  const tmp = path.join(dir, ".reaffirm-intents.tmp." + process.pid + "." + Date.now());
  let fd = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return { ok: false, problem: "tmp 不是单硬链接普通文件" };
    let off = 0;
    while (off < bytes.length) { const n = fs.writeSync(fd, bytes, off, bytes.length - off); if (n <= 0) return { ok: false, problem: "short write" }; off += n; }
    fs.fsyncSync(fd);
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }
  try {
    fs.renameSync(tmp, path.join(dir, REAFFIRM_INTENTS_FILE));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
    return { ok: false, problem: "rename 失败: " + errCode(err) };
  }
  let dfd = null;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(dfd);
  } catch { /* 目录 fsync 不支持的平台：尽力 */ }
  finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
  return { ok: true };
}

/** intent 文件锁（普通 gated）：acquire → fn() → release（释放失败折进结果，不静默吞）。 */
function withIntentsLock(dir, fn) {
  const lockDir = path.join(dir, REAFFIRM_INTENTS_LOCK);
  const acq = acquireLockUngated(lockDir, { reapUnrecognized: false });
  if (!acq.ok) return { ok: false, reason: acq.reason === "publisher_busy" ? "reaffirm_intents_busy" : (acq.reason ?? "reaffirm_intents_lock"), why: acq.error ?? acq.reason ?? null, path: acq.path ?? null };
  let out;
  try { out = fn(); }
  finally {
    const rel = releasePublishLock(lockDir, { expectedToken: acq.token });
    if (!rel.ok) out = { ...out, lockUncleared: rel.reason ?? "release_failed" };
  }
  return out;
}

/**
 * request_reaffirm（§8.1 sidecar 写事务，非 ledger op）。
 * intent 锁内：unreadable 阻断 → 受验清理**该 target** 的过期项 → CAS「该 target 下无任何未清 intent」
 * → 算 expected_old_proof_closure_digest（§8.1 公式，family 在内）→ 签 rfh_（128-bit CSPRNG）→
 * tmp+rename+fsync 写回 → 返回 handle。family 越界 / 别名缺失 / chat 不符 → fail-closed 拒。
 */
export function issueReaffirmIntent({ endpointId, targetId, authorizedOwner, chatId, now = undefined, clock = () => Date.now(), env = process.env } = {}) {
  // R57a 返修一 P1-5：签发时间由 intent 锁内的 clock seam 读取（显式 now 仅作确定性钉值）。
  const nowMs = Number.isFinite(now) ? now : clock();
  const iso = isCanonicalMs(nowMs) ? canonicalIso(nowMs) : null;
  if (iso === null) return { ok: false, reason: "bad_time" };
  if (typeof targetId !== "string" || !ID_SHAPE.test(targetId)) return { ok: false, reason: "bad_target_id" };
  if (typeof authorizedOwner !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedOwner)) return { ok: false, reason: "bad_authorized_owner" };
  if (typeof chatId !== "string" || !CHAT_SHAPE.test(chatId)) return { ok: false, reason: "bad_chat_id" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return { ok: false, reason: d.reason ?? "endpoint_dir_unresolvable", why: d.why ?? null };
  return withIntentsLock(d.dir, () => {
    const cur = readReaffirmIntents({ endpointDir: d.dir });
    if (!cur.ok) return { ok: false, reason: "reaffirm_intents_unreadable", why: cur.problem };
    const doc = cur.doc;
    // 受验清理：只动本 target 的过期项（§8.1「先受验清理该 target 的过期项」；他 target 的过期项归其下次签发清理）
    const cleaned = [];
    for (const [k, e] of Object.entries(doc.entries)) {
      if (e.target_id === targetId && Date.parse(e.expires_at) <= nowMs) { cleaned.push(k); delete doc.entries[k]; }
    }
    // CAS：no-existing-intent = 该 target 下无任何未清 intent（不是「忽略过期项」——否则同 target 堆积）
    if (Object.values(doc.entries).some((e) => e.target_id === targetId)) {
      return { ok: false, reason: "reaffirm_intent_exists", why: "该 target 下已有未消费的 reaffirm intent（先消费或等过期）" };
    }
    // ledger 侧事实（只读）：live、族、别名、chat 一致
    const L = loadLedger(d.dir, { endpointId });
    if (!L.ok) return { ok: false, reason: L.reason === "ledger_corrupt" ? "ledger_corrupt" : "ledger_unreadable", why: L.why ?? L.reason ?? null };
    const rec = L.doc.records[targetId];
    if (!rec || rec.kind !== "live") return { ok: false, reason: "target_not_live" };
    const fam = familyOf(rec.facts);
    if (!REAFFIRM_TARGET_FAMILIES.includes(fam)) return { ok: false, reason: "reaffirm_scope", why: "familyOf=" + String(fam) + "（reaffirm 只对 B3/B3'/B4/A3/A4）" };
    if (rec.chat_id !== chatId) return { ok: false, reason: "chat_mismatch", why: "调用方 chatId 与记录 chat_id 不符" };
    if (rec.aliases.session_id === null || rec.aliases.root_om === null) return { ok: false, reason: "reaffirm_scope", why: "缺 session/root_om 别名，签不出 owner_select 证明" };
    const digest = ownerSelectReaffirmClosureDigest(L.doc, targetId);
    if (typeof digest !== "string") return { ok: false, reason: "target_not_live" };
    const handle = "rfh_" + crypto.randomBytes(16).toString("hex");
    const expiresMs = nowMs + OWNER_SELECT_REAFFIRM_TTL_MS;
    const expires = isCanonicalMs(expiresMs) ? canonicalIso(expiresMs) : null;
    if (expires === null) return { ok: false, reason: "bad_time", why: "expires_at 越界" };
    doc.entries[handle] = {
      reaffirm_handle: handle, target_id: targetId, target_family: fam,
      authorized_owner: authorizedOwner, endpoint: endpointId, chat_id: rec.chat_id,
      issued_at: iso, expires_at: expires, expected_old_proof_closure_digest: digest,
    };
    const p = reaffirmIntentsProblem(doc);
    if (p !== null) return { ok: false, reason: "reaffirm_intents_unwritable", why: "产物不过封闭 schema：" + p };
    const w = writeIntentsFile(d.dir, doc);
    if (!w.ok) return { ok: false, reason: "reaffirm_intents_unwritable", why: w.problem };
    return { ok: true, reaffirm_handle: handle, entry: doc.entries[handle], cleaned, cleaned_count: cleaned.length };
  });
}

/**
 * 消费编排（§8.1）：在消费方的 outer 锁内被调 → 本函数持 **intent 锁** → ownerSelectReaffirm 的
 * gatedTx 内持 **ledger 锁**（锁序 intent → ledger）。intent CAS：entry 在场（=handle 主键、endpoint 相符）、
 * 未过期、sender === authorized_owner；family/digest 的 CAS 在 ledger op 内对现账原子重核。
 * 提交成功（含崩溃恢复的 replayed）→ 清 intent；清失败不谎报——ok 保持 true（账本已提交），cleared:false
 * 带出，同 request_key 重发幂等清 intent（§8.1 崩溃恢复矩阵）。
 */
export function consumeReaffirmIntent({ endpointId, reaffirmHandle, sender, chatId, selectionMessageId, now = undefined, clock = () => Date.now(), env = process.env } = {}) {
  if (typeof reaffirmHandle !== "string" || !REAFFIRM_HANDLE_SHAPE.test(reaffirmHandle)) return { ok: false, reason: "reaffirm_handle_unknown" };
  if (typeof sender !== "string" || !AUTHORIZED_BY_SHAPE.test(sender)) return { ok: false, reason: "sender_mismatch", why: "sender 形状不对" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return { ok: false, reason: d.reason ?? "endpoint_dir_unresolvable", why: d.why ?? null };
  return withIntentsLock(d.dir, () => {
    const cur = readReaffirmIntents({ endpointDir: d.dir });
    if (!cur.ok) return { ok: false, reason: "reaffirm_intents_unreadable", why: cur.problem };
    const entry = cur.doc.entries[reaffirmHandle];
    if (!entry || entry.endpoint !== endpointId) return { ok: false, reason: "reaffirm_handle_unknown", why: "intent 不在场（未签发、已消费或属别的 endpoint）" };
    const lockNow = clock(); // P1-7：过期核一律 intent 锁内 clock()
    if (Date.parse(entry.expires_at) <= lockNow) return { ok: false, reason: "reaffirm_intent_expired", why: "过期不清（等签发侧同锁受验清理）" };
    if (entry.authorized_owner !== sender) return { ok: false, reason: "sender_mismatch", why: "只有签发时登记的 owner 本人才可消费这个 handle" };
    // 别名解析（供 fp 的 selected_* 字面输入）：handle → target → 当前别名；ledger op 内再原子 CAS。
    const L = loadLedger(d.dir, { endpointId });
    if (!L.ok) return { ok: false, reason: L.reason === "ledger_corrupt" ? "ledger_corrupt" : "ledger_unreadable", why: L.why ?? L.reason ?? null };
    const rec = L.doc.records[entry.target_id];
    if (!rec || rec.kind !== "live") return { ok: false, reason: "reaffirm_target_missing" };
    const res = ownerSelectReaffirm({
      endpointId, targetId: entry.target_id, targetFamily: entry.target_family,
      expectedOldProofClosureDigest: entry.expected_old_proof_closure_digest,
      reaffirmHandle, authorizedBy: sender, chatId,
      selectedSessionId: rec.aliases.session_id, selectedRootOm: rec.aliases.root_om,
      selectionMessageId, clock, env, _inject: undefined,
    });
    if (!res.ok || typeof res.commit !== "string" || !res.commit.startsWith("committed")) return res;
    // 提交成功（committed_clean / committed_durability_uncertain / replayed）→ 清 intent
    delete cur.doc.entries[reaffirmHandle];
    const w = writeIntentsFile(d.dir, cur.doc);
    const cleared = w.ok;
    return { ...res, cleared, ...(cleared ? {} : { why: "intent 清理失败（" + (w.problem ?? "?") + "）：账本已提交，同 handle 重发可幂等清 intent" }) };
  });
}
