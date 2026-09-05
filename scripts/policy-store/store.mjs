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
import { ENDPOINT_SHAPE, ID_SHAPE, resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { interactionPolicyStateProblem, policySubjectId } from "./validator.mjs";
import { canonicalPolicyContent, stableStringify } from "./canonical.mjs";

export { ENDPOINT_SHAPE, policySubjectId }; // 派生实现在 validator.mjs（#R35 P1-2：外键自洽与哈希同处），re-export 保持 API
export { canonicalPolicyContent, stableStringify }; // #R40 P1-5：规范字节唯一判据抽到 canonical.mjs，re-export 保持 API

const MAX_ENTRIES = 512;
export const MAX_BYTES = 1024 * 1024;
const ROOT_KEYS = "endpoint_id,entries,schema_version";
const POLICY_SCHEMA_VERSION = "policy-1";
const SUBJECT_ID_SHAPE = /^ps_[0-9a-f]{32}$/u;
const KINDS = ["lineage", "topic_agent"];
const LOCK_NAME = "policy.lock";
const FILE_NAME = "policy.json";

/* ───────────────── 条目校验（值全经 ipsp-1；subject 外键只在 store 层验，#R38 P1-5） ───────────────── */

/** 单条目：subject 形状 + 值必须是过 ipsp-1 的完整六键 interaction_policy_state + 外键自洽（#R40 P1-4）。 */
function entryProblem(subject, value, endpointId) {
  if (!SUBJECT_ID_SHAPE.test(subject)) return { reason: "policy_store_bad_subject", detail: null };
  const ip = interactionPolicyStateProblem(value);
  if (ip !== null) return { reason: "policy_entry_invalid", detail: ip };
  if (endpointId !== undefined) {
    try {
      if (subjectForEntry(value, endpointId) !== subject) {
        return { reason: "policy_entry_invalid", detail: "policy_subject_key_mismatch" };
      }
    } catch {
      return { reason: "policy_entry_invalid", detail: "policy_subject_key_mismatch" };
    }
  }
  return null;
}

/**
 * #R40 P1-4：subject 外键在 store 层强制 —— 条目 binding_id 所属主体派生出的 policy_subject_id
 * 必须等于挂载键（T4 合同：条目本体回六键原样、binding_id 留 legacy 出处，但**派生关系不撤**）。
 * kind 由 binding_id 形状唯一判定：精确 ta_<32hex>（TAL.ID_SHAPE）→ topic_agent，否则按账本
 * lineage 派生。派生对非法输入抛 TypeError（fail-closed：形状洗不过就拒，不让哈希吞）。
 */
function subjectForEntry(value, endpointId) {
  if (!value || typeof value !== "object" || typeof value.binding_id !== "string") {
    throw new TypeError("invalid entry or binding_id");
  }
  return policySubjectId({
    kind: ID_SHAPE.test(value.binding_id) ? "topic_agent" : "lineage",
    endpointId,
    id: value.binding_id,
  });
}

function rootSchemaProblem(raw, endpointId) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { reason: "policy_store_parse_failed", detail: null }; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { reason: "policy_store_root_schema", detail: null };
  if (Object.keys(doc).sort().join(",") !== ROOT_KEYS) return { reason: "policy_store_root_schema", detail: null };
  if (doc.schema_version !== POLICY_SCHEMA_VERSION) return { reason: "policy_store_root_schema", detail: null };
  if (typeof doc.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(doc.endpoint_id)) return { reason: "policy_store_root_schema", detail: null };
  if (doc.entries === null || typeof doc.entries !== "object" || Array.isArray(doc.entries)) return { reason: "policy_store_root_schema", detail: null };
  const subjects = Object.keys(doc.entries);
  if (subjects.length > MAX_ENTRIES) return { reason: "policy_store_too_many_entries", detail: null };
  for (const s of subjects) {
    const p = entryProblem(s, doc.entries[s], endpointId);
    if (p !== null) return p;
  }
  return null;
}

/** 序列化形态（写路径合成用）：三键封闭 + 全部条目 subject 形状 + ipsp-1 + 外键（#R40 P1-4）。返回 {reason, detail} 或 null。 */
function storeProblem(entries, endpointId) {
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return { reason: "policy_store_root_schema", detail: null };
  const subjects = Object.keys(entries);
  if (subjects.length > MAX_ENTRIES) return { reason: "policy_store_too_many_entries", detail: null };
  for (const s of subjects) {
    const p = entryProblem(s, entries[s], endpointId);
    if (p !== null) return p;
  }
  return null;
}

/* ───────────────────────── 读端（fail-closed） ───────────────────────── */

/**
 * 读 `ledger/<ep>/policy.json`。路径与身份全部走 TAL.resolveEndpointDir（#R33 P1-3：
 * 末级 lstat/精确 0700/realpath 归一，endpoint symlink 指外部即拒）。
 * 返回 {ok:true, entries, raw} | {ok:true, absent:true, entries:{}} | {ok:false, reason, why?}。
 * #R40 P1-5：raw 带出盘上原始字节 —— 零写比对/读回比对都直接对它，不重新序列化。
 */
export function loadPolicyStore({ endpointId, env = process.env } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "policy_store_bad_endpoint_id" };
  const dir = resolveEndpointDir(endpointId, { env, mustExistRoot: false });
  if (!dir.ok) return { ok: false, reason: "policy_store_" + dir.reason, why: dir.why };
  const file = path.join(dir.dir, FILE_NAME);
  let raw;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: "policy_store_not_regular_file" };
      if (st.nlink !== 1) return { ok: false, reason: "policy_store_not_regular_file", why: "硬链接别名（nlink=" + st.nlink + "）" };
      if ((st.mode & 0o777) !== 0o600) return { ok: false, reason: "policy_store_file_perms", why: "policy.json 权限必须精确 0600，实际 " + (st.mode & 0o777).toString(8) };
      if (st.size > MAX_BYTES) return { ok: false, reason: "policy_store_too_large" };
      // #R35 P1-4：有界读 MAX_BYTES+1 —— fstat 之后文件可能被换大（TOCTOU）或有写端在灌
      //（FIFO/增长文件），读满上限即停受控拒，不吃下无限读。
      // #R38 P1-3：读到的总长必须等于同 fd fstat 尺寸 —— 少了（截断/竞态）就是读不出完整内容。
      const read = readAll(fd, MAX_BYTES);
      if (read.tooLarge) return { ok: false, reason: "policy_store_too_large", why: "有界读超限（读满 MAX_BYTES+1 即停）" };
      if (read.total !== st.size) {
        throw Object.assign(new Error("读到的字节（" + read.total + "）与 fstat 尺寸（" + st.size + "）不符"), { code: "EFPOLICYSIZE" });
      }
      raw = read.buf;
    } finally { fs.closeSync(fd); }
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, absent: true, entries: {} };
    if (err?.code === "ELOOP" || err?.code === "ENXIO") return { ok: false, reason: "policy_store_not_regular_file" };
    // #R38 P1-3：读侧读不到就是 unreadable（带错误码），不再谎报 unwritable —— 写不写得了是另一回事
    return { ok: false, reason: "policy_store_unreadable", why: String(err?.code ?? err?.message ?? err) };
  }
  const rawText = raw.toString("utf-8");
  const p = rootSchemaProblem(rawText, endpointId);
  if (p !== null) return { ok: false, reason: p.reason, ...(p.detail ? { detail: p.detail } : {}) };
  const doc = JSON.parse(rawText);
  if (doc.endpoint_id !== endpointId) return { ok: false, reason: "policy_store_root_schema", why: "endpoint_id 与目录不符" };
  return { ok: true, entries: doc.entries, raw: rawText };
}

/**
 * fd 循环读满（readFileSync 不可控；同写侧循环纪律）。#R35 P1-4：total > maxBytes 即停并标 tooLarge。
 * O_NONBLOCK 下 FIFO 无数据 + 有写者时 read 报 EAGAIN：短等待重试。
 * #R38 P1-3：非 EAGAIN 读异常与 EAGAIN 超时都是"读不到完整内容"，抛结构化错误折 unreadable，
 * 不许折成 EOF 谎报前缀；返回值带 total，load 层必须核 total === 同 fd fstat 尺寸。
 */
function readAll(fd, maxBytes) {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  let total = 0;
  let waitedMs = 0;
  for (;;) {
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, null); }
    catch (err) {
      if (err?.code === "EAGAIN" && waitedMs < 2000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        waitedMs += 5;
        continue;
      }
      throw Object.assign(new Error("policy.json 读取中断：" + String(err?.code ?? err?.message ?? err)), { code: "EFPOLICYREAD" });
    }
    if (n === 0) return { buf: Buffer.concat(chunks), tooLarge: false, total };
    total += n;
    if (total > maxBytes) return { buf: null, tooLarge: true, total };
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
}

/* ───────────────────────── 写端（锁 + fenced 提交） ───────────────────────── */

/** upsert 语义：语义相等去重（changed:false，稳定序列化比对 #R40 P1-5），否则冲突拒 —— 不依赖覆盖顺序。 */
export function upsertPolicyEntry(entries, subject, value) {
  if (!(subject in entries)) return { ok: true, entries: { ...entries, [subject]: value }, changed: true };
  if (stableStringify(entries[subject]) === stableStringify(value)) return { ok: true, entries, changed: false };
  return { ok: false, reason: "policy_subject_conflict", why: "同 subject 已有不同条目（" + subject + "）" };
}

/**
 * 释放/提交段锁残骸的唯一折叠器（#R38 P1-4）：锁归属说不清（absent）或已易主（not_owner）
 * 同样是"这次调用的锁没还干净"，和 reap 残骸、释放异常一样不谎报 clean；
 * 残骸必须带 path（.reap 残骸是 reap 路径）。先到的 lockUncleared 不被覆盖（先到的算数）。
 */
function foldLockUncleared(result, rel, lockPath) {
  if (!result || typeof result !== "object" || result.lockUncleared !== undefined) return;
  let lu = null;
  if (rel.reapUncleared) {
    lu = { reason: "reap_residue_uncleared", path: rel.reapUncleared.path ?? lockPath + ".reap",
      detail: rel.reapUncleared.error != null ? String(rel.reapUncleared.error) : null };
  } else if (rel.absent === true) {
    lu = { reason: "lock_absent", path: lockPath, detail: null };
  } else if (!rel.ok) {
    lu = { reason: String(rel.reason ?? "release_failed"), path: lockPath,
      detail: rel.error != null ? String(rel.error) : (rel.why != null ? String(rel.why) : null) };
  }
  if (lu !== null) result.lockUncleared = lu;
}

/** 提交段之后把 commitWhileHeld 的结果折进来（照 chat-ledger.afterCommit 的语义）。 */
function afterCommit(fenced, tmp, commitErr) {
  const lockUncleared = fenced.reapUncleared ? { reason: "reap_residue_uncleared", path: fenced.reapUncleared.path, detail: String(fenced.reapUncleared.error ?? "") } : null;
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
 * （ok:false 原样透传）。#R38 P2：entries 必填（缺 = 拒不补）、changed 只许布尔；
 * 写前全量过 ipsp-1（subject 外键只在 store 层验，#R38 P1-5）；changed:false 必须与锁内现状
 * 规范字节逐字一致才零写返回（#R33 P2-2 + #R38 P2；#R35 P2-1：缺席 endpoint 的零写不留下目录）。
 *
 * #R35 P1-3 结果四态统一折叠，#R38 P1-4 收紧：
 *   未提交（committed:false）/ 已提交干净（committed:true + persistence:"fsynced"）/
 *   有残骸（+tmpResidue / lockUncleared{reason,path,detail}）/ 持久性不确定（committed:true + persistence:"uncertain"）。
 * 提交段（rename 后）的目录 fsync 失败、写后读回失败/读回与意图不一致都如实折入
 * "持久性不确定"，不吞不谎报；主体内部任何异常也折成受控结果；释放段残骸走唯一折叠器
 * foldLockUncleared（absent/not_owner/reap 残骸/异常都成 lockUncleared，带 path），
 * 不覆盖先到的。释放完才返回。
 */
export function mutatePolicyStore({ endpointId, mutate, env = process.env } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "policy_store_bad_endpoint_id" };
  if (typeof mutate !== "function") return { ok: false, reason: "policy_store_mutate_invalid" };
  // 锁前只做**只读**校验：resolveEndpointDir（不建任何东西）；目录缺席是合法首写，锁后建。
  const pre = resolveEndpointDir(endpointId, { env, mustExistRoot: false });
  if (!pre.ok) return { ok: false, reason: "policy_store_" + pre.reason, why: pre.why };
  // 维护门：门开着就零写入（目录都不建，#R33 探针一）。#R35 P1-5：门与 ledger 从**同一份 env** 解析，
  // 传入 env 与 process.env 不一致时仍以传入 env 为准（预检/门/锁三处一致，没有绕门口子）。
  const gate = gateBlocks({ env });
  if (gate.blocked) return { ok: false, reason: "maintenance", why: gate.state };
  // 门过了才允许落盘：建 endpoint 目录（首写）；精确 0700 由下文锁内重验兜底
  let dirWasAbsent = false;
  try { dirWasAbsent = !fs.existsSync(pre.dir); fs.mkdirSync(pre.dir, { recursive: true, mode: 0o700 }); }
  catch (err) { return { ok: false, reason: "policy_store_unwritable", why: String(err.code ?? err.message) }; }
  const dir = resolveEndpointDir(endpointId, { env, mustExistRoot: true });
  if (!dir.ok) return { ok: false, reason: "policy_store_" + dir.reason, why: dir.why };
  const lockPath = path.join(dir.dir, LOCK_NAME);
  const file = path.join(dir.dir, FILE_NAME);
  let lock;
  for (;;) {
    try { lock = acquirePublishLock(lockPath, { reapUnrecognized: false, env }); }
    catch (err) { return { ok: false, reason: "policy_store_lock_unavailable", why: String(err?.code ?? err?.message ?? err) }; }
    if (lock.ok) break;
    if (lock.reason !== "publisher_busy") return { ok: false, reason: lock.reason === "lock_residue" ? "policy_store_lock_residue" : "policy_store_lock_unavailable", why: String(lock.reason) + (lock.error ? "：" + lock.error : "") };
    return { ok: false, reason: "policy_store_busy", why: "policy.lock 被持有" };
  }
  let result;
  try {
    // 锁内重验末级身份与权限（#R33 P1-3）：锁前后目录都可能被动过
    const re = resolveEndpointDir(endpointId, { env, mustExistRoot: true });
    if (!re.ok) { result = { ok: false, reason: "policy_store_" + re.reason, why: re.why, committed: false }; return result; }
    const load = loadPolicyStore({ endpointId, env });
    if (!load.ok) { result = { ...load, committed: false }; return result; }
    const next = mutate(load.entries);
    if (!next || typeof next !== "object" || next.ok !== true) {
      result = next && typeof next === "object" && next.ok === false
        ? { ok: false, reason: next.reason, why: next.why, committed: false }
        : { ok: false, reason: "policy_store_mutate_invalid", why: "mutate 必须返回 {ok:true, entries} 或 {ok:false}", committed: false };
      return result;
    }
    // #R38 P2：entries 必填（缺 = 拒，不默补 {} —— 调用方忘了返回 entries 就是调用方 bug）；
    // changed 只许布尔。
    if (next.entries === undefined || next.entries === null || typeof next.entries !== "object" || Array.isArray(next.entries)) {
      result = { ok: false, reason: "policy_store_mutate_invalid", why: "mutate 返回的 entries 必填（不默补空对象）", committed: false };
      return result;
    }
    if (next.changed !== undefined && typeof next.changed !== "boolean") {
      result = { ok: false, reason: "policy_store_mutate_invalid", why: "changed 只许布尔", committed: false };
      return result;
    }
    const p = storeProblem(next.entries, endpointId);
    if (p !== null) { result = { ok: false, reason: p.reason, why: "写前全量校验不过，不落盘", ...(p.detail ? { detail: p.detail } : {}), committed: false }; return result; }
    const changed = next.changed === undefined ? true : next.changed;
    if (changed === false) {
      // #R40 P1-2：复用唯一受验读函数（O_NOFOLLOW / 单硬链接 / 0600 / 有界读）；
      // 缺席只允许配『规范空投影』（entries 为空对象），其余拒。
      const current = loadPolicyStore({ endpointId, env });
      if (!current.ok) {
        result = { ok: false, reason: current.reason, why: current.why, committed: false };
        return result;
      }
      if (current.absent) {
        if (Object.keys(next.entries).length !== 0) {
          result = { ok: false, reason: "policy_store_changed_mismatch", why: "文件缺席时 changed:false 仅允许规范空投影", committed: false };
          return result;
        }
      } else {
        if (current.raw !== canonicalPolicyContent(endpointId, next.entries)) {
          result = { ok: false, reason: "policy_store_changed_mismatch", why: "changed:false 但 entries 与锁内现状的规范字节不一致", committed: false };
          return result;
        }
      }
      result = { ok: true, entries: next.entries, changed: false, committed: false }; // 零写：逐字一致才返回（#R33 P2-2 + #R38 P2）
      return result;
    }
    const content = canonicalPolicyContent(endpointId, next.entries);
    if (Buffer.byteLength(content, "utf-8") > MAX_BYTES) { result = { ok: false, reason: "policy_store_too_large", committed: false }; return result; }
    const w = writeTmp(dir.dir, content);
    if (!w.ok) { result = { ok: false, reason: "policy_store_unwritable", why: w.why, ...(w.tmpResidue ? { tmpResidue: w.tmpResidue } : {}), committed: false }; return result; }
    let commitErr = null;
    // fenced 提交：段内核对锁 token 仍是我 —— 锁丢了就不 rename（失锁不提交，#R33 探针二）
    const fenced = commitWhileHeld(lockPath, () => { try { fs.renameSync(w.tmp, file); } catch (err) { commitErr = err; } });
    const r = afterCommit(fenced, w.tmp, commitErr);
    if (!r.ok) {
      // #R38 P1-4：提交段残骸（含 fenced 段 reapUncleared，afterCommit 已折成 lockUncleared{reason,path}）
      // 走同一折叠路径，不再展开到顶层覆盖 reason。
      result = { ok: false, reason: r.reason, why: r.why, ...(r.tmpResidue ? { tmpResidue: r.tmpResidue } : {}), committed: false };
      if (r.lockUncleared) result.lockUncleared = r.lockUncleared;
      return result;
    }
    // 已提交（rename 完成）。目录 fsync：失败不再吞 —— 数据在目录项里但崩溃窗口不确定，
    // 如实折入持久性不确定态（#R35 P1-3 探针二：fsync EIO 不许谎报 fsynced）。
    let persistence = "fsynced";
    let dirFsyncError = null;
    try { fsyncDir(dir.dir); } catch (err) { persistence = "uncertain"; dirFsyncError = String(err.code ?? err.message); }
    // 写后受验读回：全 ipsp-1 再过一遍；且读回条目必须与本次意图逐字一致（#R38 P1-4），
    // 读不回/读出非法/内容不符都如实报错（已提交，不谎报失败原因在写）
    // #R40 P1-6：所有已提交出口统一折叠 commit residue（r.lockUncleared），不丢残骸。
    const verify = loadPolicyStore({ endpointId, env });
    if (!verify.ok) {
      result = { ok: false, reason: "policy_store_readback_failed", why: verify.reason + (verify.why ? "：" + verify.why : ""), committed: true, persistence: "uncertain", ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
      return result;
    }
    if (verify.raw !== content) {
      result = { ok: false, reason: "policy_store_readback_mismatch", why: "读回条目与本次意图不一致（盘上被别的写方动过？）", committed: true, persistence: "uncertain", ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
      return result;
    }
    result = { ok: true, entries: next.entries, changed: true, committed: true, persistence, ...(dirFsyncError ? { dirFsyncError } : {}), ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
    return result;
  } catch (err) {
    // 主体内部任何异常（含 commitWhileHeld 段内 .reap 读失败）折成受控结果 —— 不裸抛，
    // 让 finally 的释放段残骸折入仍能落到结果上（#R35 P1-3 探针一）。
    result = { ok: false, reason: "policy_store_internal", why: String(err?.code ?? err?.message ?? err), committed: false };
    return result;
  } finally {
    // 释放段残骸走唯一折叠器（#R38 P1-4）：锁归属丢失（absent / not_owner）与 reap 残骸、
    // 释放异常一样不谎报 clean，残骸带 path。先到的 lockUncleared（提交段折入的）不被覆盖。
    let rel;
    try { rel = releasePublishLock(lockPath); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    // 必须原地改：try 里 `return result` 已把当时的结果求值作为返回值，finally 里
    // `result = {...}` 只是重新绑定变量，调用方拿到的仍是旧值 —— 这就是 #R33 版折入死代码 bug。
    if (result && typeof result === "object") foldLockUncleared(result, rel, lockPath);
    // #R35 P2-1：缺席 endpoint 的零写不留下副作用 —— 锁释放后目录若已空则收走（真零副作用）。
    // 目录非空（tmp 残骸等）时 rmdir 自然失败，保留现场。
    if (dirWasAbsent && result && typeof result === "object" && result.ok === true && result.changed === false) {
      try { fs.rmdirSync(dir.dir); } catch { /* 非空/竞态：保留现场 */ }
    }
  }
}
