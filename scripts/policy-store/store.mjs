/**
 * policy.json 存储原语（#R31 第一交付物，#R33 按仓内 store 纪律重写）。
 *
 * 布局：`<FEISHU_BRIDGE_LEDGER_DIR>/<endpoint_id>/policy.json`，同目录 `policy.lock` 走
 * registry 的 symlink 锁原语。根 schema 封闭三键，读写**全经 ipsp-1**
 * （policy-store/validator.mjs）：读到非法 fail-closed，写前非法不落盘。
 *
 * 写事务纪律与 chat-ledger.mjs 同源（#R33 P1-2）：
 *   · 门检前零写入 —— mkdir 必须在维护门判定之后；
 *   · 取锁 reapUnrecognized:false —— 畸形锁是现场，热路径不回收（由人工 / repair 入口处理）；
 *   · 锁内重验末级目录身份（TAL.resolveEndpointDir：lstat/精确 0700/realpath 归一）；
 *   · 唯一临时文件 O_EXCL|O_NOFOLLOW、循环写满、fsync；rename 只发生在 commitWhileHeld
 *     的 fenced 段（段内核对锁 token 仍是我）—— 失锁不提交，tmp 原地保留；
 *   · 提交后目录 fsync + 写后受验读回；提交段与释放段的残骸（lock_lost / commit_failed /
 *     reapUncleared / 释放异常）全部折入结果，不谎报 clean。
 *
 * 派生（policy_subject_id，#R33 P2-1）：入参形状先收紧再进哈希 —— endpoint 强制
 * ENDPOINT_SHAPE、topic_agent 强制 TAL.ID_SHAPE、lineage 复用 TAL.LINEAGE_SHAPE，
 * 不让哈希把非法输入洗成表面合法的 ps_。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquirePublishLock, releasePublishLock, commitWhileHeld } from "../registry.mjs";
import { gateBlocks } from "../maintenance-gate-core.mjs";
import { ENDPOINT_SHAPE, canonKey, sha256, resolveEndpointDir, ID_SHAPE, LINEAGE_SHAPE } from "../topic-agent-ledger.mjs";
import { interactionPolicyStateProblem } from "./validator.mjs";

export { ENDPOINT_SHAPE };

const MAX_ENTRIES = 512;
const MAX_BYTES = 1024 * 1024;
const ROOT_KEYS = "endpoint_id,entries,schema_version";
const POLICY_SCHEMA_VERSION = "policy-1";
const SUBJECT_ID_SHAPE = /^ps_[0-9a-f]{32}$/u;
const KINDS = ["lineage", "topic_agent"];
const LOCK_NAME = "policy.lock";
const FILE_NAME = "policy.json";

/* ───────────────────────── 派生：policy_subject_id ───────────────────────── */

/**
 * ps_ + sha256(canonKey({domain:"policy_subject_v1", kind, endpoint_id, id})).slice(0,32)。
 * domain 进哈希 = 碰撞域分隔：不同 domain 的同形键不会撞；非法入参抛 TypeError（#R33 P2-1：
 * 形状先收紧 —— 哈希不可逆不等于输入合法，非法输入不许被洗成表面合法的 ps_）。
 */
export function policySubjectId({ kind, endpointId, id } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError("policy_subject_id: kind 必须是 lineage|topic_agent");
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) throw new TypeError("policy_subject_id: endpointId 必须是 endpoint_<24hex>");
  if (typeof id !== "string" || id.length === 0) throw new TypeError("policy_subject_id: id 必须是非空字符串");
  if (kind === "topic_agent" && !ID_SHAPE.test(id)) throw new TypeError("policy_subject_id: topic_agent id 必须是 ta_<32hex>");
  if (kind === "lineage" && !LINEAGE_SHAPE.test(id)) throw new TypeError("policy_subject_id: lineage id 必须是账本 lineage 形状（有界、无控制字符）");
  return "ps_" + sha256(canonKey({ domain: "policy_subject_v1", kind, endpoint_id: endpointId, id })).slice(0, 32);
}

/* ───────────────────────── 条目校验（全经 ipsp-1） ───────────────────────── */

/** 单条目：subject 形状 + 值必须是过 ipsp-1 的完整 interaction_policy_state。bindingId 外键映射留给接线单。 */
function entryProblem(subject, value) {
  if (!SUBJECT_ID_SHAPE.test(subject)) return { reason: "policy_store_bad_subject", detail: null };
  const ip = interactionPolicyStateProblem(value, { bindingId: undefined });
  if (ip !== null) return { reason: "policy_entry_invalid", detail: ip };
  return null;
}

function rootSchemaProblem(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { reason: "policy_store_parse_failed", detail: null }; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { reason: "policy_store_root_schema", detail: null };
  if (Object.keys(doc).sort().join(",") !== ROOT_KEYS) return { reason: "policy_store_root_schema", detail: null };
  if (doc.schema_version !== POLICY_SCHEMA_VERSION) return { reason: "policy_store_root_schema", detail: null };
  if (typeof doc.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(doc.endpoint_id)) return { reason: "policy_store_root_schema", detail: null };
  if (doc.entries === null || typeof doc.entries !== "object" || Array.isArray(doc.entries)) return { reason: "policy_store_root_schema", detail: null };
  const subjects = Object.keys(doc.entries);
  if (subjects.length > MAX_ENTRIES) return { reason: "policy_store_too_many_entries", detail: null };
  for (const s of subjects) { const p = entryProblem(s, doc.entries[s]); if (p !== null) return p; }
  return null;
}

/** 序列化形态（写路径合成用）：三键封闭 + 全部条目过 ipsp-1。返回 {reason, detail} 或 null。 */
function storeProblem(entries) {
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return { reason: "policy_store_root_schema", detail: null };
  const subjects = Object.keys(entries);
  if (subjects.length > MAX_ENTRIES) return { reason: "policy_store_too_many_entries", detail: null };
  for (const s of subjects) { const p = entryProblem(s, entries[s]); if (p !== null) return p; }
  return null;
}

/* ───────────────────────── 读端（fail-closed） ───────────────────────── */

/**
 * 读 `ledger/<ep>/policy.json`。路径与身份全部走 TAL.resolveEndpointDir（#R33 P1-3：
 * 末级 lstat/精确 0700/realpath 归一，endpoint symlink 指外部即拒）。
 * 返回 {ok:true, entries} | {ok:true, absent:true, entries:{}} | {ok:false, reason, why?}。
 */
export function loadPolicyStore({ endpointId, env = process.env } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "policy_store_bad_endpoint_id" };
  const dir = resolveEndpointDir(endpointId, { env, mustExistRoot: false });
  if (!dir.ok) return { ok: false, reason: "policy_store_" + dir.reason, why: dir.why };
  const file = path.join(dir.dir, FILE_NAME);
  let raw;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: "policy_store_not_regular_file" };
      if (st.nlink !== 1) return { ok: false, reason: "policy_store_not_regular_file", why: "硬链接别名（nlink=" + st.nlink + "）" };
      if ((st.mode & 0o777) !== 0o600) return { ok: false, reason: "policy_store_file_perms", why: "policy.json 权限必须精确 0600，实际 " + (st.mode & 0o777).toString(8) };
      if (st.size > MAX_BYTES) return { ok: false, reason: "policy_store_too_large" };
      raw = readAll(fd);
      // fstat 之后文件可能被换大：按**实际读到的字节**再核上限（TOCTOU 不给口子）
      if (raw.length > MAX_BYTES) return { ok: false, reason: "policy_store_too_large" };
    } finally { fs.closeSync(fd); }
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, absent: true, entries: {} };
    if (err?.code === "ELOOP" || err?.code === "ENXIO") return { ok: false, reason: "policy_store_not_regular_file" };
    return { ok: false, reason: "policy_store_unwritable", why: String(err.code ?? err.message) };
  }
  const p = rootSchemaProblem(raw.toString("utf-8"));
  if (p !== null) return { ok: false, reason: p.reason, ...(p.detail ? { detail: p.detail } : {}) };
  const doc = JSON.parse(raw.toString("utf-8"));
  if (doc.endpoint_id !== endpointId) return { ok: false, reason: "policy_store_root_schema", why: "endpoint_id 与目录不符" };
  return { ok: true, entries: doc.entries };
}

/** fd 循环读满（readFileSync 不可控；同写侧循环纪律，读到 EOF 为止）。 */
function readAll(fd) {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) return Buffer.concat(chunks);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
}

/* ───────────────────────── 写端（锁 + fenced 提交） ───────────────────────── */

/** upsert 语义：逐字相等去重（changed:false），否则冲突拒 —— 不依赖覆盖顺序。 */
export function upsertPolicyEntry(entries, subject, value) {
  if (!(subject in entries)) return { ok: true, entries: { ...entries, [subject]: value }, changed: true };
  if (JSON.stringify(entries[subject]) === JSON.stringify(value)) return { ok: true, entries, changed: false };
  return { ok: false, reason: "policy_subject_conflict", why: "同 subject 已有不同条目（" + subject + "）" };
}

/** 提交段之后把 commitWhileHeld 的结果折进来（照 chat-ledger.afterCommit 的语义）。 */
function afterCommit(fenced, tmp, commitErr) {
  const lockUncleared = fenced.reapUncleared ? { reason: "reap_residue_uncleared", detail: String(fenced.reapUncleared.error ?? "") } : null;
  if (!fenced.ok) return { ok: false, reason: "policy_store_lock_lost", why: "提交前核对锁：" + fenced.reason, tmpResidue: { path: tmp, why: "提交前核对锁失败，临时文件原地保留" }, ...(lockUncleared ? { lockUncleared } : {}) };
  if (commitErr !== null) return { ok: false, reason: "policy_store_commit_failed", why: String(commitErr.code ?? commitErr.message), tmpResidue: { path: tmp, why: "rename 失败，临时文件原地保留" }, ...(lockUncleared ? { lockUncleared } : {}) };
  return { ok: true, ...(lockUncleared ? { lockUncleared } : {}) };
}

/** 把完整内容写进同目录唯一命名的临时文件（O_EXCL|O_NOFOLLOW）：循环写满、fsync；写失败原地保留。 */
function writeTmp(dir, content) {
  const tmp = path.join(dir, FILE_NAME + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp");
  let fd = null;
  try {
    try { fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (err) { return { ok: false, why: "临时文件建不出：" + String(err.code ?? err.message), tmpResidue: null }; }
    try {
      const buf = Buffer.from(content, "utf-8");
      if (buf.length > MAX_BYTES) throw Object.assign(new Error("oversize"), { code: "EFPOLICYOVERSIZE" });
      let off = 0;
      while (off < buf.length) {
        const n = fs.writeSync(fd, buf, off, buf.length - off);
        if (!(Number.isInteger(n) && n > 0)) throw Object.assign(new Error("short write"), { code: "ESHORTWRITE" });
        off += n;
      }
      fs.fsyncSync(fd);
    } catch (err) {
      return { ok: false, why: String(err.code ?? err.message), tmpResidue: { path: tmp, why: "写临时文件失败，原地保留" } };
    }
    return { ok: true, tmp };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

const fsyncDir = (dir) => { const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };

/**
 * 锁内事务式改写。mutate 信封契约：返回 {ok:true, entries, changed?} 或 {ok:false, reason, why?}
 * （ok:false 原样透传）。写前全量过 ipsp-1，非法不落盘；changed:false 且条目合法 → 校验后零写返回。
 * 成功：{ok:true, entries, changed:true|false}；失败：reason 以 policy_store_ 前缀（maintenance /
 * busy / lock_residue 系按锁原语语义折入）。
 */
export function mutatePolicyStore({ endpointId, mutate, env = process.env } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "policy_store_bad_endpoint_id" };
  if (typeof mutate !== "function") return { ok: false, reason: "policy_store_mutate_invalid" };
  // 锁前只做**只读**校验：resolveEndpointDir（不建任何东西）；目录缺席是合法首写，锁后建。
  const pre = resolveEndpointDir(endpointId, { env, mustExistRoot: false });
  if (!pre.ok) return { ok: false, reason: "policy_store_" + pre.reason, why: pre.why };
  // 维护门：门开着就零写入（目录都不建，#R33 探针一）
  const gate = gateBlocks();
  if (gate.blocked) return { ok: false, reason: "maintenance", why: gate.state };
  // 门过了才允许落盘：建 endpoint 目录（首写）；精确 0700 由下文锁内重验兜底
  try { fs.mkdirSync(pre.dir, { recursive: true, mode: 0o700 }); }
  catch (err) { return { ok: false, reason: "policy_store_unwritable", why: String(err.code ?? err.message) }; }
  const dir = resolveEndpointDir(endpointId, { env, mustExistRoot: true });
  if (!dir.ok) return { ok: false, reason: "policy_store_" + dir.reason, why: dir.why };
  const lockPath = path.join(dir.dir, LOCK_NAME);
  const file = path.join(dir.dir, FILE_NAME);
  let lock;
  for (;;) {
    try { lock = acquirePublishLock(lockPath, { reapUnrecognized: false }); }
    catch (err) { return { ok: false, reason: "policy_store_lock_unavailable", why: String(err?.code ?? err?.message ?? err) }; }
    if (lock.ok) break;
    if (lock.reason !== "publisher_busy") return { ok: false, reason: lock.reason === "lock_residue" ? "policy_store_lock_residue" : "policy_store_lock_unavailable", why: String(lock.reason) + (lock.error ? "：" + lock.error : "") };
    return { ok: false, reason: "policy_store_busy", why: "policy.lock 被持有" };
  }
  let result;
  try {
    // 锁内重验末级身份与权限（#R33 P1-3）：锁前后目录都可能被动过
    const re = resolveEndpointDir(endpointId, { env, mustExistRoot: true });
    if (!re.ok) { result = { ok: false, reason: "policy_store_" + re.reason, why: re.why }; return result; }
    const load = loadPolicyStore({ endpointId, env });
    if (!load.ok) { result = load; return result; }
    const next = mutate(load.entries);
    if (!next || typeof next !== "object" || next.ok !== true) {
      result = next && typeof next === "object" && next.ok === false
        ? { ok: false, reason: next.reason, why: next.why }
        : { ok: false, reason: "policy_store_mutate_invalid", why: "mutate 必须返回 {ok:true, entries} 或 {ok:false}" };
      return result;
    }
    if (next.entries === undefined) next.entries = {};
    const p = storeProblem(next.entries);
    if (p !== null) { result = { ok: false, reason: p.reason, why: "写前全量校验不过，不落盘", ...(p.detail ? { detail: p.detail } : {}) }; return result; }
    const changed = next.changed === undefined ? true : next.changed === true;
    if (changed === false) { result = { ok: true, entries: next.entries, changed: false }; return result; } // 零写：锁内校验后直接返回（#R33 P2-2）
    const content = JSON.stringify({ schema_version: POLICY_SCHEMA_VERSION, endpoint_id: endpointId, entries: next.entries }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf-8") > MAX_BYTES) { result = { ok: false, reason: "policy_store_too_large" }; return result; }
    const w = writeTmp(dir.dir, content);
    if (!w.ok) { result = { ok: false, reason: "policy_store_unwritable", why: w.why, ...(w.tmpResidue ? { tmpResidue: w.tmpResidue } : {}) }; return result; }
    let commitErr = null;
    // fenced 提交：段内核对锁 token 仍是我 —— 锁丢了就不 rename（失锁不提交，#R33 探针二）
    const fenced = commitWhileHeld(lockPath, () => { try { fs.renameSync(w.tmp, file); } catch (err) { commitErr = err; } });
    const r = afterCommit(fenced, w.tmp, commitErr);
    if (!r.ok) { result = { ok: false, reason: r.reason, why: r.why, ...(r.tmpResidue ? { tmpResidue: r.tmpResidue } : {}), ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) }; return result; }
    try { fsyncDir(dir.dir); } catch { /* 目录 fsync 尽力而为：数据已在 rename 后落位 */ }
    // 写后受验读回：全 ipsp-1 再过一遍，读不回或读出非法都如实报错（已提交，不谎报失败原因在写）
    const verify = loadPolicyStore({ endpointId, env });
    if (!verify.ok) { result = { ok: false, reason: "policy_store_readback_failed", why: verify.reason + (verify.why ? "：" + verify.why : ""), committed: true }; return result; }
    result = { ok: true, entries: next.entries, changed: true };
    return result;
  } finally {
    // 释放段残骸完整折入（照 withLedgerLock 的三态纪律）：not_owner 是别人接管，不算残留；
    // 其余（owner_unreadable / release_busy / reapUncleared / 抛错）一律不谎报 clean。
    let rel;
    try { rel = releasePublishLock(lockPath); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    if (result && typeof result === "object" && !result.lockUncleared) {
      const lu = rel.reapUncleared ? { reason: "reap_residue_uncleared", detail: String(rel.reapUncleared.error ?? "") }
        : (!rel.ok && rel.reason !== "not_owner") ? { reason: String(rel.reason), detail: rel.error ? String(rel.error) : null }
        : null;
      if (lu !== null) result = { ...result, lockUncleared: lu };
    }
  }
}
