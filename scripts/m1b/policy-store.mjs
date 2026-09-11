/**
 * authoritative 期 interaction policy 的唯一读写面：`ledger/<endpoint_id>/policy.json`
 * —— cutover 时由 m1b sidecar renderer 固定的那一份（M1a §4 ③），cutover 之后由这里读写，
 * legacy 的 registry / active-mapping 策略字段**冻结**（不再读写）。
 *
 * 为什么不用 `policy-store/store.mjs`（#R31~#R41 的前置块，同一路径）—— 三条都是硬理由：
 *   · 盘上这份文件的 schema 判据是 **m1b 的 `validateSidecarDoc("policy")`**（renderer 写它时用的同
 *     一份判据）。阅读判据不另立第二套：读同源、写同源。
 *   · 它的锁是 sidecar-writer 用的 `<policy.json>.lock`（写这份文件的那把锁）。store.mjs 用
 *     `policy.lock` —— 同一个文件两把锁就是留了并发口子。
 *   · store.mjs 的 kinds 显式声明 / 跨 kind 查重属于"cutover 前的正面 store"设计；authoritative 期
 *     subject 只有一种 kind（lineage），由调用方按 binding_id 用**同一个** `policySubjectId` 派生。
 *   回调形状也不同：这里按**单条目** mutate（与 interaction-policy 的三条写路径同形）。
 *
 * 读：`readSidecarFile`（父目录 0700 / O_NOFOLLOW / 普通文件 / 单硬链接 / 精确 0600 / ≤1MiB）
 *   + `validateSidecarDoc`。读不出/不合法一律 fail-closed（`policy_store_unreadable`），**不折成空**；
 *   文件缺席如实报 `absent:true`，由调用方按"cutover 之后不应缺席"处理。
 * 写：同一把锁 → 锁内 fd 重读 → 取条目（缺 → renderer 同款默认条目）→ 单条目 mutate →
 *   ipsp-1 → 整文档 `validateSidecarDoc` → tmp + fsync + rename + 目录 fsync（0600）→ 释放。
 *   释放不干净按 R57d 折叠外显（`lockUncleared`，不谎报 clean）。
 */
import fs from "node:fs";
import path from "node:path";

import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { interactionPolicyStateProblem } from "../policy-store/validator.mjs";
import { stableStringify } from "../policy-store/canonical.mjs";
// 复用，不写第二套 schema / 不写第二份默认条目（renderer 是它的另一半）。
import { PSID_SHAPE, mappingDefaultEntry, readSidecarFile, validateSidecarDoc } from "./sidecar-renderers.mjs";

export const POLICY_STORE_FILE = "policy.json";
export { PSID_SHAPE };

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

/** 取锁重试（与 registry 同一锁原语；maintenance 门在 acquirePublishLock 里兜底）。 */
export function acquireStateLock(lockDir, retries = 0, env = process.env) {
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = acquirePublishLock(lockDir, { env });
    if (result.ok || result.reason !== "publisher_busy") return result;
    if (attempt < retries) Atomics.wait(LOCK_WAIT, 0, 0, 25);
  }
  return result;
}

/** policy.json 的路径（只解析，不建任何东西）。 */
export function policyStorePath({ endpointId, env = process.env, mustExistRoot = false } = {}) {
  const d = resolveEndpointDir(endpointId, { env, mustExistRoot });
  if (!d.ok) return { ok: false, reason: d.reason, why: d.why ?? null };
  return { ok: true, dir: d.dir, file: path.join(d.dir, POLICY_STORE_FILE) };
}

/** 单条目读取：`entries[subjectId]` 缺 → renderer 同款默认条目（binding_id 取 lineage）。 */
export function policyEntryFor({ entries, subjectId, bindingId } = {}) {
  const present = entries !== null && typeof entries === "object" ? entries[subjectId] : undefined;
  if (present !== undefined) return { ok: true, entry: present, synthesized: false };
  if (typeof bindingId !== "string" || bindingId.length === 0) {
    return { ok: false, reason: "policy_store_invalid", why: "store 里没有该 subject 且拿不到 binding_id，合成不出默认条目" };
  }
  return { ok: true, entry: mappingDefaultEntry(bindingId), synthesized: true };
}

/**
 * 读整份 store。返回：
 *   `{ok:true, absent:true, file, entries:{}}`  —— 文件缺席（cutover 之后不应缺席）
 *   `{ok:true, file, doc, entries, bytes}`      —— 读回且整文档过 `validateSidecarDoc("policy")`
 *   `{ok:false, reason:"policy_store_unreadable", why}` —— 读不出/不合法（fail-closed，不折成空）
 */
export function readPolicyStore({ endpointId, env = process.env } = {}) {
  const p = policyStorePath({ endpointId, env });
  if (!p.ok) return { ok: false, reason: "policy_store_unreadable", why: "账本目录解析失败：" + String(p.why ?? p.reason) };
  try { fs.lstatSync(p.file); }
  catch (err) {
    if (err?.code === "ENOENT") return { ok: true, absent: true, file: p.file, entries: {} };
    return { ok: false, reason: "policy_store_unreadable", why: "lstat：" + String(err?.code ?? err?.message ?? err) };
  }
  const r = readSidecarFile({ file: p.file, endpointId, name: "policy" });
  if (!r.ok) return { ok: false, reason: "policy_store_unreadable", why: r.why ?? r.reason };
  return { ok: true, absent: false, file: p.file, doc: r.doc, entries: r.doc.entries, bytes: r.bytes };
}

/** 同目录 tmp（O_EXCL 0600）→ 写满 → fsync → rename → 目录 fsync；失败不留半截目标文件。 */
function writePolicyAtomic(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, POLICY_STORE_FILE + "." + process.pid + "." + Date.now() + ".tmp");
  let fd = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const buf = Buffer.from(content, "utf-8");
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(Number.isInteger(n) && n > 0)) throw Object.assign(new Error("short write"), { code: "ESHORTWRITE" });
      off += n;
    }
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } fd = null; }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 留残骸总比半截目标好 */ }
    return { ok: false, why: String(err?.code ?? err?.message ?? err) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
  try { fs.renameSync(tmp, file); }
  catch (err) { try { fs.rmSync(tmp, { force: true }); } catch { /* 同上 */ } return { ok: false, why: "rename：" + String(err?.code ?? err?.message ?? err) }; }
  // 目录 fsync：失败不谎报 fsynced（提交已落，如实报 uncertain）。
  let persistence = "fsynced";
  try { const dfd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } }
  catch (err) { persistence = "uncertain"; }
  return { ok: true, persistence };
}

/**
 * 单条目事务式改写（**唯一写入口**）。返回 union 与 `mutateClaudeInteractionPolicy` 同形：
 *   `{ok:true, changed, state, subjectId, entries, ...changed}` —— `changed:false` 时零写
 *   `{ok:false, reason, why?}` —— 拒因（`policy_store_unreadable` / `policy_store_invalid` /
 *     `policy_store_busy` / `maintenance` / `policy_store_unwritable` / `policy_store_lock_release_failed`）
 *
 * 写前两道：单条目 ipsp-1（`interactionPolicyStateProblem`）+ 整文档 `validateSidecarDoc`——
 * 非法状态一个字节都不落盘。`changed:false` 由 mutate 自报，照旧零写返回。
 */
export function mutatePolicyEntry({ endpointId, bindingId = null, subjectId, mutate, env = process.env, lockRetries = 0 } = {}) {
  if (typeof subjectId !== "string" || !PSID_SHAPE.test(subjectId)) {
    return { ok: false, reason: "policy_store_invalid", why: "subject 不是 policy_subject_id：" + String(subjectId) };
  }
  if (typeof mutate !== "function") return { ok: false, reason: "policy_store_invalid", why: "mutate 必须是函数" };
  // 目录必须已在（cutover 之后 endpoint 目录必然在场；这里不建目录、不建文件 —— 缺席是故障，不是首写）。
  const p = policyStorePath({ endpointId, env, mustExistRoot: true });
  if (!p.ok) return { ok: false, reason: "policy_store_unreadable", why: "账本目录解析失败：" + String(p.why ?? p.reason) };
  const lockDir = p.file + ".lock";
  const lock = acquireStateLock(lockDir, lockRetries, env);
  if (!lock.ok) {
    return { ok: false, reason: lock.reason === "maintenance" ? "maintenance" : "policy_store_busy", why: String(lock.reason ?? "lock_unavailable") };
  }
  let result = null;
  try {
    // 锁内 fd 重读（不在锁外先读：那是个漂移窗口）。
    const cur = readPolicyStore({ endpointId, env });
    if (!cur.ok) return { ok: false, reason: cur.reason, why: cur.why };
    if (cur.absent) return { ok: false, reason: "policy_store_unreadable", why: "policy.json 缺席（cutover 之后不应缺席，不新建）" };
    const picked = policyEntryFor({ entries: cur.entries, subjectId, bindingId });
    if (!picked.ok) return picked;
    const changed = mutate(picked.entry, { subjectId, file: p.file, entries: cur.entries, synthesized: picked.synthesized, bindingId });
    if (!changed || typeof changed !== "object" || changed.ok !== true) {
      return changed && typeof changed === "object" && changed.ok === false
        ? changed
        : { ok: false, reason: "policy_store_invalid", why: "mutate 必须返回 {ok:true, changed?, state} 或 {ok:false, reason}" };
    }
    if (changed.changed === false) return { ...changed, subjectId, entries: cur.entries };
    if (!('state' in changed)) return { ok: false, reason: "policy_store_invalid", why: "changed:true 必须带 state" };
    const problem = interactionPolicyStateProblem(changed.state);
    if (problem !== null) return { ok: false, reason: "policy_store_invalid", why: problem };
    // 交叉不变量（与 renderer 同一条）：lineage subject 的条目 binding_id 必须等于派生输入。
    if (typeof bindingId === "string" && bindingId.length > 0 && changed.state.binding_id !== bindingId) {
      return { ok: false, reason: "policy_store_invalid", why: "条目 binding_id 与 lineage 派生输入不一致" };
    }
    const doc = { ...cur.doc, entries: { ...cur.entries, [subjectId]: changed.state } };
    const invalid = validateSidecarDoc(doc, "policy", { endpointId });
    if (invalid !== null) return { ok: false, reason: "policy_store_invalid", why: invalid };
    const w = writePolicyAtomic(p.file, stableStringify(doc, 2) + "\n");
    if (!w.ok) return { ok: false, reason: "policy_store_unwritable", why: w.why };
    result = { ...changed, subjectId, entries: doc.entries, doc, committed: true, persistence: w.persistence };
    return result;
  } finally {
    // R57d：释放不干净不谎报 clean —— 折成 lockUncleared（带 path）并把 ok 降级；写已落盘的话
    // committed/changed/state 照旧带出，人工据此判断"落了但没还干净"。
    let rel;
    try { rel = releasePublishLock(lockDir); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    const unclean = rel.reapUncleared
      ? { reason: "reap_residue_uncleared", path: rel.reapUncleared.path ?? lockDir + ".reap", detail: rel.reapUncleared.error != null ? String(rel.reapUncleared.error) : null }
      : rel.absent === true ? { reason: "lock_absent", path: lockDir, detail: null }
        : rel.ok !== true
          ? { reason: String(rel.reason ?? "release_failed"), path: lockDir, detail: rel.error != null ? String(rel.error) : (rel.why != null ? String(rel.why) : null) }
          : null;
    if (unclean !== null && result !== null && typeof result === "object" && result.lockUncleared === undefined) {
      result.ok = false;
      result.reason = "policy_store_lock_release_failed";
      result.why = unclean.reason;
      result.lockUncleared = unclean;
    }
  }
}
