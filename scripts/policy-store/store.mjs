/**
 * policy.json 存储原语（#R31，policy-store 前置块第一交付物；m1a §4 interaction_policy_state 行）。
 *
 * 布局：<ledger 根>/<endpoint_id>/policy.json，封闭根 schema
 *   { schema_version:"policy-1", endpoint_id, entries:{ <policy_subject_id>: <ipsp-1 条目> } }
 * 纪律：registry 锁协议目录锁（policy.lock symlink，同一把原语）、目录 0700 / 文件 0600、
 * fd 绑定读（O_NOFOLLOW / 普通文件 / 单硬链接）、entries ≤512、文件 ≤1MiB；
 * 读写全经 ipsp-1（interactionPolicyStateProblem）——读到非法条目 fail-closed，写前校验非法不落盘。
 * 本单只交付校验器 + 原语 + 测试；interaction-policy-store / codex reserve-finalize 的读写方迁移接线在下一单。
 */

import fs from "node:fs";
import path from "node:path";

import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { ENDPOINT_SHAPE, canonKey, sha256, validateLedgerRoot } from "../topic-agent-ledger.mjs";
import { interactionPolicyStateProblem } from "./validator.mjs";

export const POLICY_SCHEMA_VERSION = "policy-1";
const MAX_ENTRIES = 512;
const MAX_BYTES = 1024 * 1024;
const SUBJECT_SHAPE = /^ps_[0-9a-f]{32}$/u;
const ROOT_KEYS = "endpoint_id,entries,schema_version";

/**
 * policy_subject_id 派生（m1a §4 唯一定义）：ps_ + sha256(canonKey({domain, kind, endpoint_id, id})).slice(0,32)。
 * kind 封闭域 lineage|topic_agent；canonKey 键排序 + domain 字段做碰撞域分隔（跨 kind / 跨 endpoint / 跨 id 不同域）。
 */
export function policySubjectId({ kind, endpointId, id }) {
  if (!["lineage", "topic_agent"].includes(kind)) throw new TypeError("policy_subject kind 不在封闭域（lineage|topic_agent）");
  if (typeof endpointId !== "string" || endpointId.length === 0) throw new TypeError("policy_subject endpoint_id 缺失");
  if (typeof id !== "string" || id.length === 0) throw new TypeError("policy_subject id 缺失");
  return "ps_" + sha256(Buffer.from(canonKey({ domain: "policy_subject_v1", kind, endpoint_id: endpointId, id }))).slice(0, 32);
}

/** 受验路径派生：账本根走 validateLedgerRoot（唯一校验器），末级 endpoint 目录允许缺席。 */
function policyStoreFileFor({ endpointId, env }) {
  const root = validateLedgerRoot({ env, mustExistRoot: false });
  if (!root.ok) return root;
  const dir = path.join(root.root, endpointId);
  return { ok: true, dir, file: path.join(dir, "policy.json") };
}

/** fd 绑定读纪律（channel-samples 同款）：O_NOFOLLOW|O_NONBLOCK 打开、同 fd fstat 普通文件 + nlink===1、读完即关。 */
function readPolicyFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true };
    return { ok: false, reason: "policy_store_not_regular_file", detail: err.code === "ELOOP" ? "是符号链接（别名）" : "不是普通文件（" + (err.code ?? "open_failed") + "）" };
  }
  let st;
  try { st = fs.fstatSync(fd); } catch (err) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "policy_store_not_regular_file", detail: String(err.code ?? err.message) };
  }
  if (!st.isFile() || st.nlink !== 1) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "policy_store_not_regular_file", detail: st.nlink !== 1 ? "是硬链接别名（nlink=" + st.nlink + "）" : "不是普通文件" };
  }
  if (st.size > MAX_BYTES) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "policy_store_too_large", detail: String(st.size) };
  }
  let raw;
  try { raw = fs.readFileSync(fd, "utf-8"); } catch (err) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: "policy_store_read_failed", detail: String(err.code ?? err.message) };
  }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  return { ok: true, raw };
}

/**
 * 读 policy.json（全经 ipsp-1）：缺席 = 空entries（首写前合法）；任何形状/条目非法 → {ok:false}（fail-closed）。
 * detail 只带 psid 与问题码（opaque），不带条目内容。
 */
export function loadPolicyStore({ endpointId, env = process.env } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) {
    return { ok: false, reason: "policy_store_bad_endpoint_id" };
  }
  const loc = policyStoreFileFor({ endpointId, env });
  if (!loc.ok) return loc;
  const read = readPolicyFile(loc.file);
  if (!read.ok) return read;
  if (read.absent) return { ok: true, absent: true, entries: {} };
  let doc;
  try { doc = JSON.parse(read.raw); } catch (err) {
    return { ok: false, reason: "policy_store_parse_failed", detail: String(err.message).slice(0, 120) };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) ||
      Object.keys(doc).sort().join(",") !== ROOT_KEYS ||
      doc.schema_version !== POLICY_SCHEMA_VERSION || doc.endpoint_id !== endpointId) {
    return { ok: false, reason: "policy_store_root_schema" };
  }
  const entries = doc.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return { ok: false, reason: "policy_store_root_schema" };
  }
  const subjects = Object.keys(entries);
  if (subjects.length > MAX_ENTRIES) return { ok: false, reason: "policy_store_too_many_entries" };
  for (const subjectId of subjects) {
    if (!SUBJECT_SHAPE.test(subjectId)) return { ok: false, reason: "policy_store_bad_subject", detail: subjectId.slice(0, 8) };
    const problem = interactionPolicyStateProblem(entries[subjectId], { bindingId: undefined });
    if (problem !== null) return { ok: false, reason: "policy_entry_invalid", detail: subjectId.slice(0, 8) + " " + problem };
  }
  return { ok: true, entries };
}

/**
 * 同 subject 合并语义（#R31 钦定）：已存在且逐字不等 → policy_subject_conflict 拒（不依赖覆盖顺序）；
 * 逐字相等 → 幂等去重（changed:false）；否则新增。纯函数，不动盘。
 */
export function upsertPolicyEntry(entries, subjectId, entry) {
  const prev = entries?.[subjectId];
  if (prev !== undefined) {
    if (JSON.stringify(prev) !== JSON.stringify(entry)) return { ok: false, reason: "policy_subject_conflict" };
    return { ok: true, changed: false, entries };
  }
  return { ok: true, changed: true, entries: { ...entries, [subjectId]: entry } };
}

/**
 * 锁内读-改-写。mutate(entries) 返回 {ok:true, entries, changed?}（如 upsertPolicyEntry）或 {ok:false, reason, ...}
 * 直接透传（如 policy_subject_conflict）。写前全量 ipsp-1 复核 + 上限复核，非法不落盘；
 * 文件 0600、目录 0700、原子 replace（tmp+rename）。changed 缺省 true。
 */
export function mutatePolicyStore({ endpointId, mutate, env = process.env } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) {
    return { ok: false, reason: "policy_store_bad_endpoint_id" };
  }
  const loc = policyStoreFileFor({ endpointId, env });
  if (!loc.ok) return loc;
  fs.mkdirSync(loc.dir, { recursive: true, mode: 0o700 });
  const lockDir = path.join(loc.dir, "policy.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "policy_store_busy", detail: lock.reason };
  try {
    const loaded = loadPolicyStore({ endpointId, env });
    if (!loaded.ok) return loaded;
    const next = mutate(loaded.entries);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return { ok: false, reason: "policy_store_mutate_invalid" };
    }
    if (next.ok === false) return next; // mutate 拒（如 policy_subject_conflict）透传
    if (next.ok !== true || !next.entries || typeof next.entries !== "object" || Array.isArray(next.entries)) {
      return { ok: false, reason: "policy_store_mutate_invalid" };
    }
    const entries = next.entries;
    const subjects = Object.keys(entries);
    if (subjects.length > MAX_ENTRIES) return { ok: false, reason: "policy_store_too_many_entries" };
    for (const subjectId of subjects) {
      if (!SUBJECT_SHAPE.test(subjectId)) return { ok: false, reason: "policy_store_bad_subject", detail: subjectId.slice(0, 8) };
      const problem = interactionPolicyStateProblem(entries[subjectId]);
      if (problem !== null) return { ok: false, reason: "policy_entry_invalid", detail: subjectId.slice(0, 8) + " " + problem };
    }
    const doc = { schema_version: POLICY_SCHEMA_VERSION, endpoint_id: endpointId, entries };
    const bytes = JSON.stringify(doc, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) return { ok: false, reason: "policy_store_too_large" };
    const tmp = loc.file + ".tmp." + process.pid + "." + Date.now();
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, loc.file);
    return { ok: true, entries, changed: next.changed !== false };
  } catch (err) {
    return { ok: false, reason: "policy_store_unwritable", detail: String(err.message).slice(0, 200) };
  } finally {
    releasePublishLock(lockDir);
  }
}
