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
import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { acquireOrderLock, verifyOrderLockCapability } from "../m1a/dual-write.mjs";
import { readOwnerSelectAdmission } from "./owner-select-state.mjs";
import { loadChainTemplate } from "../chain-template.mjs";
import { loadCodexTemplate } from "../codex/state.mjs";
import { legacyEndpointId } from "../subscription.mjs";
import {
  OWNER_SELECT_REAFFIRM_TTL_MS, REAFFIRM_HANDLE_SHAPE, ID_SHAPE, ENDPOINT_SHAPE, CHAT_SHAPE,
  AUTHORIZED_BY_SHAPE, SHA_SHAPE, resolveEndpointDir, loadLedger, familyOf,
  ownerSelectReaffirmClosureDigest, ownerSelectReaffirm,
} from "../topic-agent-ledger.mjs";
import { classifySelectOutcome } from "../select-outcome.mjs";
import { writeSelectionPlan } from "../selection-plan.mjs";

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

function cleanupTmp(tmp, _inject) {
  if (_inject?.cleanupFail) return { residue: tmp };
  // P1-3：禁用 existsSync 先判缺席——它会把非 ENOENT 异常（EACCES/EIO…）折成「无残骸」。
  //   直接 unlink，只有 ENOENT（真已缺席）算无残骸；其它异常 → residue 点名（带原因）。
  try {
    if (_inject?.unlinkEACCES) { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; }
    fs.unlinkSync(tmp);
    return { residue: null };
  } catch (err) {
    if (err?.code === "ENOENT") return { residue: null };
    return { residue: tmp, why: errCode(err) };
  }
}

/**
 * tmp + rename + fsync 落盘（复用 m1a sidecar 原语）：
 * 写前核 ≤ 256 KiB；0600、O_EXCL|O_NOFOLLOW、写端 fd 复核 nlink；
 * rename 前失败清理 tmp，清不掉才 residue 点名 tmp；
 * rename 后目录 fsync 失败 → committed_durability_uncertain；
 * 写后受验读回逐字节等。
 */
function writeIntentsFile(dir, doc, { _inject = null } = {}) {
  const bytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf-8");
  if (bytes.length > REAFFIRM_INTENTS_MAX_BYTES) {
    return { ok: false, commit: "not_committed", reason: "over_capacity", why: "序列化长度 " + bytes.length + " 超出上限 " + REAFFIRM_INTENTS_MAX_BYTES };
  }
  const targetPath = path.join(dir, REAFFIRM_INTENTS_FILE);
  const tmp = path.join(dir, ".reaffirm-intents.tmp." + process.pid + "." + crypto.randomUUID());
  let fd = null;
  let renameLanded = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) {
      try { fs.closeSync(fd); fd = null; } catch {}
      const cl = cleanupTmp(tmp, _inject);
      const out = { ok: false, commit: "not_committed", reason: "tmp_file_invalid", why: "tmp 文件属性异常" };
      if (cl.residue) { out.reason = "residue"; out.residue = [cl.residue]; }
      return out;
    }
    let off = 0;
    while (off < bytes.length) {
      const n = fs.writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) break;
      off += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (typeof _inject?.beforeRename === "function") _inject.beforeRename();

    fs.renameSync(tmp, targetPath);
    renameLanded = true;
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); fd = null; } catch {} }
    if (!renameLanded) {
      const cl = cleanupTmp(tmp, _inject);
      if (cl.residue) {
        return { ok: false, commit: "not_committed", reason: "residue", residue: [cl.residue], why: "rename 前失败且 tmp 残留: " + errCode(err) };
      }
      return { ok: false, commit: "not_committed", reason: "tmp_write_failed", why: errCode(err) };
    }
  }

  // rename 后目录 fsync（不吞异常）
  try {
    if (_inject?.failDirFsync) {
      const err = new Error("EIO: i/o error, fsync");
      err.code = "EIO";
      throw err;
    }
    let dfd = null;
    try {
      dfd = fs.openSync(dir, fs.constants.O_RDONLY);
      fs.fsyncSync(dfd);
    } finally {
      if (dfd !== null) { try { fs.closeSync(dfd); } catch {} }
    }
  } catch (err) {
    return { ok: false, commit: "committed_durability_uncertain", reason: "dir_fsync_failed", why: "目录 fsync 失败: " + errCode(err) };
  }

  // 受验读回：不复用裸 fs.readFileSync(targetPath)——它不核 0600 / 链接数 / schema（chmod 0644 仍报 committed_clean）。
  // P1-3：复用 fd 绑定读取器（同 readReaffirmIntents：O_NOFOLLOW|O_NONBLOCK 打开 → fstat 普通文件/单硬链接/0600/大小上限 → 逐字节等 → schema 核）。
  if (typeof _inject?.beforeReadback === "function") _inject.beforeReadback();
  const rb = readReaffirmIntents({ endpointDir: dir });
  if (!rb.ok) {
    return { ok: false, commit: "committed_durability_uncertain", reason: "readback_failed", why: "受验读回未通过（" + (rb.problem ?? "?") + "）" };
  }
  if (rb.sha256 !== sha256(bytes)) {
    return { ok: false, commit: "committed_durability_uncertain", reason: "readback_failed", why: "读回字节与写入字节不一致" };
  }

  return { ok: true, commit: "committed_clean" };
}

/** 释放结果折叠成 released | residue | unclear 三态。 */
export function foldLockReleaseState(rel) {
  // P2：instance-bound outer 的 release() 返回规范化 {ok:false, reason:"reap_uncleared", path, error}——
  //   不带 reapUncleared 字段；必须把该规范化 reason 也折成 residue 并点名路径。
  if (rel?.reason === "reap_uncleared") return "residue";
  const clean = rel?.ok === true && !rel.absent && !rel.reapUncleared;
  if (clean) return "released";
  if (rel?.reapUncleared) return "residue";
  return "unclear";
}

/** 把 intent 锁释放结果折进返回值（released | residue | unclear 三态外显）。 */
function foldIntentsLockRelease(result, rel, lockDir) {
  const lock_state = foldLockReleaseState(rel);
  if (lock_state === "released") {
    return { ...result, lock_state: "released" };
  }
  const isResidue = lock_state === "residue";
  const lockResidue = isResidue ? (rel.reapUncleared?.path ?? lockDir) : null;
  const lockUncleared = {
    reason: rel?.reason ?? (rel?.absent ? "lock_absent_on_release" : isResidue ? "reap_residue_uncleared" : "release_failed"),
    why: rel?.why ?? (isResidue ? String(rel.reapUncleared?.error ?? "") : null),
    path: rel?.reapUncleared?.path ?? rel?.path ?? lockDir
  };
  return {
    ...result,
    lock_state,
    lockUncleared,
    ...(lockResidue ? { lockResidue } : {}),
  };
}

/** intent 文件锁（普通 gated）：acquire → fn(token) → release（释放失败折进结果，不静默吞）。 */
function withIntentsLock(dir, fn, { env = process.env } = {}) {
  const lockDir = path.join(dir, REAFFIRM_INTENTS_LOCK);
  const acq = acquirePublishLock(lockDir, { reapUnrecognized: false, env });
  if (!acq.ok) return { ok: false, reason: acq.reason === "maintenance" ? "maintenance" : acq.reason === "publisher_busy" ? "reaffirm_intents_busy" : (acq.reason ?? "reaffirm_intents_lock"), why: acq.error ?? acq.reason ?? null, gate: acq.gate ?? null, text: acq.text ?? null, path: acq.path ?? null };
  let out;
  let rel;
  try {
    out = fn(acq.token);
  } finally {
    try {
      rel = releasePublishLock(lockDir, { expectedToken: acq.token });
    } catch (err) {
      rel = { ok: false, reason: "release_exception", why: errCode(err) };
    }
    out = foldIntentsLockRelease(out, rel, lockDir);
  }
  return out;
}

/**
 * request_reaffirm（§8.1 sidecar 写事务，非 ledger op）。
 * 顶层取得并释放 instance-bound outer 锁（scripts/m1a/dual-write.mjs 的 acquireOrderLock，与 wiring 同一纪律）。
 * 内层函数持 outer 的受验 capability。
 */
export function issueReaffirmIntent({ endpointId, targetId, authorizedOwner, chatId, now = undefined, clock = () => Date.now(), env = process.env, outerCapability = undefined, _inject } = {}) {
  let innerRes;
  let outerRel = { ok: true }; // 未在本层新取 outer（调用方持有）→ 视为外层已受验释放干净
  if (!outerCapability) {
    const acq = acquireOrderLock(endpointId, env);
    if (!acq.ok) return { ok: false, reason: acq.reason ?? "binding_busy", why: acq.why ?? null, gate: acq.gate ?? null, text: acq.text ?? null };
    const cap = Object.freeze({ kind: "m1a_order_lock", token: acq.token, endpointId });
    try {
      innerRes = issueReaffirmIntentInner({ endpointId, targetId, authorizedOwner, chatId, now, clock, env, outerCapability: cap, _inject });
    } finally {
      try { outerRel = acq.release(); } catch (err) { outerRel = { ok: false, reason: "release_exception", why: String(err?.code ?? err?.message ?? err) }; }
    }
  } else {
    innerRes = issueReaffirmIntentInner({ endpointId, targetId, authorizedOwner, chatId, now, clock, env, outerCapability, _inject });
  }
  // R57b 返修二 P1-2：签发出口像消费出口一样**联合 outer / intent 两层释放结果**——
  //   任一 residue/unclear → 非绿（结构化 reason，CLI 退出码非 0）。
  const outerLockState = foldLockReleaseState(outerRel);
  const intentLockState = innerRes?.lock_state ?? "released";
  if (outerLockState !== "released" || intentLockState !== "released") {
    return {
      ...innerRes,
      ok: false,
      reason: "issue_lock_release_unclean",
      why: "签发出口两侧锁释放不干净（outer=" + outerLockState + ", intent=" + intentLockState + "）",
      locks: { outer: outerLockState, intent: intentLockState },
      lockUncleared: {
        outer: outerLockState !== "released" ? { reason: outerRel?.reason ?? "outer_lock_release", why: outerRel?.why ?? null, path: outerRel?.path ?? null } : null,
        intent: innerRes?.lockUncleared ?? null,
      },
    };
  }
  return innerRes;
}

export function issueReaffirmIntentInner({ endpointId, targetId, authorizedOwner, chatId, now = undefined, clock = () => Date.now(), env = process.env, outerCapability = undefined, _inject } = {}) {
  const vCap = verifyOrderLockCapability(endpointId, outerCapability, env);
  if (!vCap.ok) return { ok: false, reason: vCap.reason ?? "outer_lock_required", why: vCap.why ?? "outer 未持有" };

  if (typeof targetId !== "string" || !ID_SHAPE.test(targetId)) return { ok: false, reason: "bad_target_id" };
  if (typeof authorizedOwner !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedOwner)) return { ok: false, reason: "bad_authorized_owner" };
  if (typeof chatId !== "string" || !CHAT_SHAPE.test(chatId)) return { ok: false, reason: "bad_chat_id" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return { ok: false, reason: d.reason ?? "endpoint_dir_unresolvable", why: d.why ?? null };

  return withIntentsLock(d.dir, (intentToken) => {
    // R57b 返修二 P1-2：签发默认且强制用真实准入读取器，outer + intent 锁内要求精确 partial；
    //   只能替换不能省略关闭——之前签发路径完全没调 readOwnerSelectAdmission（准入可绕过）。
    const admFn = _inject?.selectAdmissionFn ?? readOwnerSelectAdmission;
    const lockAdm = admFn(env);
    if (!lockAdm || lockAdm.state !== "partial") {
      return { ok: false, reason: lockAdm?.state === "off" ? "select_off" : "select_not_partial", why: "签发准入锁内重核未通过（state=" + (lockAdm?.state ?? "null") + "）" };
    }
    const cur = readReaffirmIntents({ endpointDir: d.dir });
    if (!cur.ok) return { ok: false, reason: "reaffirm_intents_unreadable", why: cur.problem };
    const doc = cur.doc;
    const lockNow = clock(); // P1-7：签发 TTL 与清理一律 intent 锁内 clock()
    const iso = isCanonicalMs(lockNow) ? canonicalIso(lockNow) : null;
    if (iso === null) return { ok: false, reason: "bad_time" };

    // 受验清理：只动本 target 的过期项（§8.1「先受验清理该 target 的过期项」；他 target 的过期项归其下次签发清理）
    const cleaned = [];
    for (const [k, e] of Object.entries(doc.entries)) {
      if (e.target_id === targetId && Date.parse(e.expires_at) <= lockNow) { cleaned.push(k); delete doc.entries[k]; }
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
    const expiresMs = lockNow + OWNER_SELECT_REAFFIRM_TTL_MS;
    const expires = isCanonicalMs(expiresMs) ? canonicalIso(expiresMs) : null;
    if (expires === null) return { ok: false, reason: "bad_time", why: "expires_at 越界" };
    doc.entries[handle] = {
      reaffirm_handle: handle, target_id: targetId, target_family: fam,
      authorized_owner: authorizedOwner, endpoint: endpointId, chat_id: rec.chat_id,
      issued_at: iso, expires_at: expires, expected_old_proof_closure_digest: digest,
    };
    const p = reaffirmIntentsProblem(doc);
    if (p !== null) return { ok: false, commit: "not_committed", reason: "reaffirm_intents_unwritable", why: "产物不过封闭 schema：" + p };
    const w = writeIntentsFile(d.dir, doc, { _inject });
    if (!w.ok) {
      return {
        ok: false,
        commit: w.commit ?? "not_committed",
        reason: w.reason ?? "reaffirm_intents_unwritable",
        why: w.why ?? w.problem ?? null,
        ...(w.residue ? { residue: w.residue } : {})
      };
    }
    return { ok: true, commit: w.commit, reaffirm_handle: handle, entry: doc.entries[handle], cleaned, cleaned_count: cleaned.length };
  }, { env });
}

/**
 * 消费编排（§8.1）：顶层取得并释放 instance-bound outer 锁 → intent 锁 → ledger 锁。
 * 内层函数持 outer 的受验 capability。
 * admission === partial 在 outer + intent 锁内重核。
 */
export function consumeReaffirmIntent({ endpointId, reaffirmHandle, sender, chatId, selectionMessageId, selectAdmissionFn = undefined, now = undefined, clock = () => Date.now(), env = process.env, outerCapability = undefined, _inject, claimsDir = undefined, key = undefined } = {}) {
  const innerArgs = { endpointId, reaffirmHandle, sender, chatId, selectionMessageId, selectAdmissionFn, now, clock, env, outerCapability: undefined, _inject, claimsDir, key };
  if (!outerCapability) {
    const acq = acquireOrderLock(endpointId, env);
    if (!acq.ok) return { ok: false, status: "failed", reason: acq.reason ?? "binding_busy", why: acq.why ?? null, gate: acq.gate ?? null, text: acq.text ?? null };
    let innerRes;
    let outerRel;
    try {
      const cap = Object.freeze({ kind: "m1a_order_lock", token: acq.token, endpointId });
      innerRes = consumeReaffirmIntentInner({ ...innerArgs, outerCapability: cap });
    } finally {
      try {
        outerRel = acq.release();
      } catch (err) {
        outerRel = { ok: false, reason: "release_exception", why: String(err?.code ?? err?.message ?? err) };
      }
    }
    const outerLockState = foldLockReleaseState(outerRel);
    const locks = {
      outer: outerLockState,
      intent: innerRes?.lock_state ?? "released",
    };
    const outcome = classifySelectOutcome({
      ledger: innerRes?.ledger_res ?? innerRes,
      intentCleanup: innerRes?.intent_cleanup ?? (innerRes?.cleared ? "cleared" : "unclear"),
      locks,
    });
    return {
      ...innerRes,
      ...outcome,
      locks,
    };
  }
  const innerRes = consumeReaffirmIntentInner({ ...innerArgs, outerCapability });
  const locks = {
    outer: "released",
    intent: innerRes?.lock_state ?? "released",
  };
  const outcome = classifySelectOutcome({
    ledger: innerRes?.ledger_res ?? innerRes,
    intentCleanup: innerRes?.intent_cleanup ?? (innerRes?.cleared ? "cleared" : "unclear"),
    locks,
  });
  return {
    ...innerRes,
    ...outcome,
    locks,
  };
}

export function consumeReaffirmIntentInner({ endpointId, reaffirmHandle, sender, chatId, selectionMessageId, selectAdmissionFn = undefined, now = undefined, clock = () => Date.now(), env = process.env, outerCapability = undefined, _inject, claimsDir = undefined, key = undefined } = {}) {
  const vCap = verifyOrderLockCapability(endpointId, outerCapability, env);
  if (!vCap.ok) return { ok: false, status: "failed", reason: vCap.reason ?? "outer_lock_required", why: vCap.why ?? "outer 未持有" };

  if (typeof reaffirmHandle !== "string" || !REAFFIRM_HANDLE_SHAPE.test(reaffirmHandle)) return { ok: false, status: "failed", reason: "reaffirm_handle_unknown" };
  if (typeof sender !== "string" || !AUTHORIZED_BY_SHAPE.test(sender)) return { ok: false, status: "failed", reason: "sender_mismatch", why: "sender 形状不对" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return { ok: false, status: "failed", reason: d.reason ?? "endpoint_dir_unresolvable", why: d.why ?? null };

  return withIntentsLock(d.dir, (intentToken) => {
    // R57b 返修二 P1-2：消费默认且强制用真实准入读取器（省略 selectAdmissionFn 不再跳过）；注入只能替换不能省略关闭。
    const admFn = selectAdmissionFn ?? readOwnerSelectAdmission;
    const lockAdm = admFn(env);
    if (!lockAdm || lockAdm.state !== "partial") {
      return { ok: false, status: "failed", reason: lockAdm?.state === "off" ? "select_off" : "select_not_partial", why: "准入锁内重核未通过（state=" + (lockAdm?.state ?? "null") + "）" };
    }

    const cur = readReaffirmIntents({ endpointDir: d.dir });
    if (!cur.ok) return { ok: false, status: "failed", reason: "reaffirm_intents_unreadable", why: cur.problem };
    const entry = cur.doc.entries[reaffirmHandle];
    if (!entry || entry.endpoint !== endpointId) return { ok: false, status: "failed", reason: "reaffirm_handle_unknown", why: "intent 不在场（未签发、已消费或属别的 endpoint）" };
    const lockNow = clock(); // P1-7：过期核一律 intent 锁内 clock()
    if (Date.parse(entry.expires_at) <= lockNow) return { ok: false, status: "failed", reason: "reaffirm_intent_expired", why: "过期不清（等签发侧同锁受验清理）" };
    if (entry.authorized_owner !== sender) return { ok: false, status: "failed", reason: "sender_mismatch", why: "只有签发时登记的 owner 本人才可消费这个 handle" };
    // 别名解析（供 fp 的 selected_* 字面输入）：handle → target → 当前别名；ledger op 内再原子 CAS。
    const L = loadLedger(d.dir, { endpointId });
    if (!L.ok) return { ok: false, status: "failed", reason: L.reason === "ledger_corrupt" ? "ledger_corrupt" : "ledger_unreadable", why: L.why ?? L.reason ?? null };
    const rec = L.doc.records[entry.target_id];
    if (!rec || rec.kind !== "live") return { ok: false, status: "failed", reason: "reaffirm_target_missing" };
    // R57b 返修五：rfh 支在账本提交前原子持久化 selection plan（两链同一份代码，真实 claim 写方）。
    //   plan = { action:"reaffirm", target_id, basis:"reaffirm", handle:reaffirmHandle, kind:"rfh", cas:{intent_id, expected_expires_at} }。
    //   claimsDir+key 由调用方（executeSelectControl → inbound/codex-inbound）传入；写失败 → fail-closed，不进账本提交。
    if (typeof claimsDir === "string" && claimsDir.length > 0 && typeof key === "string" && key.length > 0) {
      const plan = {
        action: "reaffirm",
        target_id: entry.target_id,
        basis: "reaffirm",
        handle: reaffirmHandle,
        kind: "rfh",
        cas: { intent_id: reaffirmHandle, expected_expires_at: entry.expires_at },
      };
      const wp = writeSelectionPlan({ claimsDir, key, plan, _inject });
      if (!wp.ok) return { ok: false, status: "failed", reason: "selection_plan_write_failed", why: (wp.why ?? wp.reason ?? "selection plan 写失败，不进账本提交"), plan_write: wp };
    }
    const res = ownerSelectReaffirm({
      endpointId, targetId: entry.target_id, targetFamily: entry.target_family,
      expectedOldProofClosureDigest: entry.expected_old_proof_closure_digest,
      reaffirmHandle, authorizedBy: sender, chatId,
      selectedSessionId: rec.aliases.session_id, selectedRootOm: rec.aliases.root_om,
      selectionMessageId, now, clock, env, _inject,
    });
    if (!res.ok || typeof res.commit !== "string" || !res.commit.startsWith("committed")) return res;

    // 只有账本干净提交才允许清 intent；未收净不得当成功清 intent
    const isLedgerClean = res.ok &&
      ["committed_clean", "replayed", "already"].includes(res.commit) &&
      (!res.residue || res.residue.length === 0) &&
      !res.lockUncleared &&
      res.lock_state !== "unclear";

    let cleared = false;
    let intentCleanupWhy = null;
    if (isLedgerClean) {
      if (typeof _inject?.afterCommit === "function") {
        _inject.afterCommit();
      }
      delete cur.doc.entries[reaffirmHandle];
      const w = writeIntentsFile(d.dir, cur.doc, { _inject });
      cleared = w.ok === true;
      if (!cleared) {
        intentCleanupWhy = "intent 清理失败（" + (w.why ?? w.problem ?? "?") + "）：账本已提交，同 handle 重发可幂等清 intent";
      }
    }

    return {
      ...res,
      cleared,
      intent_cleanup: cleared ? "cleared" : "unclear",
      ledger_res: res,
      ...(intentCleanupWhy ? { why: intentCleanupWhy } : {}),
    };
  }, { env });
}

/**
 * 显式维护/修复专用：只在确认账本已提交后清理单个 reaffirm intent。
 * 不跑业务事务，只取 intent 锁做安全清理。
 */
export function cleanReaffirmIntent({ endpointDir, reaffirmHandle, env = process.env, _inject = undefined } = {}) {
  return withIntentsLock(endpointDir, (intentToken) => {
    const cur = readReaffirmIntents({ endpointDir });
    if (!cur.ok) return { ok: false, reason: "reaffirm_intents_unreadable", why: cur.problem };
    if (!cur.doc.entries[reaffirmHandle]) {
      return { ok: true, cleaned: false };
    }
    if (_inject?.failIntentCleanup) {
      return { ok: false, reason: "intent_cleanup_failed", why: "injected_intent_cleanup_failure" };
    }
    delete cur.doc.entries[reaffirmHandle];
    const w = writeIntentsFile(endpointDir, cur.doc, { _inject });
    if (!w.ok) return { ok: false, reason: "intent_cleanup_failed", why: w.why ?? w.problem };
    return { ok: true, cleaned: true };
  }, { env });
}

/**
 * 模板按 doc.chain 选，核 chain、chat、endpoint 与 owner。
 * 住 maintenance 侧避免 Claude 脚本反向 import codex。
 */
export function loadAndVerifyTemplate({ doc, rec, env = process.env }) {
  const chain = doc.chain;
  let tplRes;
  if (chain === "claude") {
    tplRes = loadChainTemplate(undefined, env);
  } else if (chain === "codex") {
    tplRes = loadCodexTemplate();
  } else {
    return { ok: false, reason: "unknown_chain", why: "未知账本 chain（" + String(chain) + "）" };
  }
  if (!tplRes || !tplRes.ok) {
    return { ok: false, reason: "template_unreadable", why: "链路模板读不出：" + (tplRes?.reason ?? "不可用") };
  }
  const template = tplRes.template;
  if (template.chain !== chain) {
    return { ok: false, reason: "chain_mismatch", why: "模板 chain（" + template.chain + "）与账本 chain（" + chain + "）不一致" };
  }
  if (template.chat_id !== rec.chat_id) {
    return { ok: false, reason: "chat_mismatch", why: "模板 chat_id（" + template.chat_id + "）与记录 chat_id（" + rec.chat_id + "）不一致" };
  }
  const expectedEndpoint = legacyEndpointId({ runtime: chain, agentUid: template.agent_uid });
  if (expectedEndpoint !== doc.endpoint_id) {
    return { ok: false, reason: "endpoint_mismatch", why: "模板 agent_uid 重算 endpoint（" + expectedEndpoint + "）与账本 endpoint_id（" + doc.endpoint_id + "）不一致" };
  }
  const authorizedOwner = template.frank_sender_id;
  if (typeof authorizedOwner !== "string" || !/^[0-9]+$/u.test(authorizedOwner)) {
    return { ok: false, reason: "bad_frank_sender_id", why: "模板 frank_sender_id 形状不对" };
  }
  return { ok: true, template, authorizedOwner };
}
