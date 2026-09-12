/**
 * sidecar 条目的**锁内读-改-校验-原子写**（PK2-W1 / M1b-W1）。
 *
 * 用途：authoritative 期写方（W1 的会话级绑定 + 认领）要往三条 sidecar
 * （`ledger/<ep>/{expiry,pending-claims,policy}.json`）里加/删**单条目**。这三份文件是 cutover 时
 * 由 `m1b/sidecar-renderers.mjs` 固化的权威事实，之后由这里按条目读写。
 *
 * 纪律（一条都不新发明）：
 *   · 锁 = **sidecar-writer 那把** `<file>.lock`（`acquirePublishLock`；同一个文件一把锁，
 *     不与 cutover 的窄写抢出第二条路径）；
 *   · 读 = `readSidecarFile`（父目录 0700 / O_NOFOLLOW / 普通文件 / 单硬链接 / 精确 0600 / ≤1MiB）
 *     + `validateSidecarDoc`（**唯一 schema**，不写第二套）；
 *   · 写 = tmp（O_EXCL 0600）→ 写满 → **文件 fsync（失败即失败：删 tmp、不 rename、盘上不变）**
 *     → rename → **目录 fsync（失败也拒，但如实报 committed:true）** → **写后受验读回**（逐字比对）；
 *   · 释放不干净按 R57d 折成 `lockUncleared` 并把 ok 降级（不谎报 clean）—— **每一条返回路径都折**，
 *     包括 `changed:false` 的零写返回；
 *   · `changed:false` 也不跳过目录屏障（P1-5① 返修）：上一笔可能正是死在 rename 之后的目录 fsync 上，
 *     “盘上已经是这一份”不等于“已证实落盘”，所以零写返回同样重做一次目录 fsync。
 *
 * 调用方拿到的 union：`{ok:false, reason, why?}`（拒）或
 * `{ok:true, changed, value, entries, committed, persistence, file, …}`（`changed:false` = 零写返回）。
 */
import fs from "node:fs";
import path from "node:path";

import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { stableStringify } from "../policy-store/canonical.mjs";
import { SIDECAR_SCHEMAS, readSidecarFile, validateSidecarDoc } from "./sidecar-renderers.mjs";

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

/** 侧车文件名就是渲染端的 `<name>.json`（sidecar-writer 同一约定）。 */
export function sidecarFileName(name) {
  return SIDECAR_SCHEMAS[name] ? name + ".json" : null;
}

/** 取锁重试（与 registry 同一锁原语；维护门在 acquirePublishLock 里兜底）。 */
export function acquireSidecarLock(lockDir, retries = 0, env = process.env) {
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = acquirePublishLock(lockDir, { env });
    if (result.ok || result.reason !== "publisher_busy") return result;
    if (attempt < retries) Atomics.wait(LOCK_WAIT, 0, 0, 25);
  }
  return result;
}

/** sidecar 路径（只解析，不建任何东西）。 */
export function sidecarPath({ endpointId, name, env = process.env, mustExistRoot = true } = {}) {
  const file = sidecarFileName(name);
  if (file === null) return { ok: false, reason: "sidecar_bad_name", why: "未知 sidecar name：" + String(name) };
  const d = resolveEndpointDir(endpointId, { env, mustExistRoot });
  if (!d.ok) return { ok: false, reason: d.reason, why: d.why ?? null };
  return { ok: true, dir: d.dir, file: path.join(d.dir, file) };
}

/**
 * 读整份 sidecar。返回：
 *   `{ok:true, absent:true, file, entries:{}}` —— 文件缺席（cutover 之后不该缺，由调用方定性）
 *   `{ok:true, file, doc, entries, bytes}`     —— 读回且整文档过 `validateSidecarDoc`
 *   `{ok:false, reason, why}`                  —— 读不出/不合法（fail-closed，不折成空）
 */
export function readSidecarStore({ endpointId, name, env = process.env } = {}) {
  const p = sidecarPath({ endpointId, name, env, mustExistRoot: false });
  if (!p.ok) return { ok: false, reason: "sidecar_unreadable", why: p.why ?? p.reason };
  try { fs.lstatSync(p.file); }
  catch (err) {
    if (err?.code === "ENOENT") return { ok: true, absent: true, file: p.file, entries: {} };
    return { ok: false, reason: "sidecar_unreadable", why: "lstat：" + String(err?.code ?? err?.message ?? err) };
  }
  const r = readSidecarFile({ file: p.file, endpointId, name });
  if (!r.ok) return { ok: false, reason: "sidecar_unreadable", why: r.why ?? r.reason };
  return { ok: true, absent: false, file: p.file, doc: r.doc, entries: r.doc.entries, bytes: r.bytes };
}

/** 目录屏障：rename 之后必须让父目录也落盘，崩溃后这一笔才存在。返回 null（成功）或错误串。 */
function fsyncDir(dir) {
  try {
    const dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (err) {
    return String(err?.code ?? err?.message ?? err);
  }
  return null;
}

/** 同目录 tmp（O_EXCL 0600）→ 写满 → 文件 fsync → rename → 目录 fsync。文件 fsync 失败：删 tmp、不 rename。 */
function writeSidecarAtomic(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, path.basename(file) + "." + process.pid + "." + Date.now() + ".tmp");
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
    return { ok: false, reason: "sidecar_write_failed", why: String(err?.code ?? err?.message ?? err) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
  try { fs.renameSync(tmp, file); }
  catch (err) { try { fs.rmSync(tmp, { force: true }); } catch { /* 同上 */ } return { ok: false, reason: "sidecar_write_failed", why: "rename：" + String(err?.code ?? err?.message ?? err) }; }
  const dirErr = fsyncDir(dir);
  if (dirErr !== null) {
    // 已提交但持久性没证实：拒（调用方折 unclean），并如实报 committed。
    return { ok: false, reason: "sidecar_durability_unconfirmed", why: dirErr, committed: true };
  }
  return { ok: true, committed: true, persistence: "fsynced" };
}

/**
 * 锁内读-改-校验-原子写**多条目**（PK2-I2-fix1 P1-3：续期一次事务覆盖整条 lineage）。
 * 与单条目版**同一把锁**（`<file>.lock`）、同一份 schema、同一份原子写与释放折叠 —— 不新建第二套。
 * `values`：`{key: 新值 | null}`（null = 删该条目）。整份文档先过 `validateSidecarDoc` 再落盘；
 * 写后受验读回逐字比对。返回形状与单条目版同族：`{ok:false, reason, …}` 或
 * `{ok:true, changed, entries, committed, persistence, file, …}`。
 */
export function mutateSidecarEntries({ endpointId, name, values, env = process.env, lockRetries = 0 } = {}) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return { ok: false, reason: "sidecar_bad_values", why: "values 必须是 {key: value|null} 对象" };
  const keys = Object.keys(values);
  if (keys.length === 0) return { ok: false, reason: "sidecar_bad_values", why: "values 不能为空（没有要改的条目）" };
  if (keys.some((k) => typeof k !== "string" || k.length === 0)) return { ok: false, reason: "sidecar_bad_key", why: "key 必须是非空字符串" };
  const p = sidecarPath({ endpointId, name, env, mustExistRoot: true });
  if (!p.ok) return { ok: false, reason: "sidecar_unreadable", why: "账本目录解析失败：" + String(p.why ?? p.reason) };
  const lockDir = p.file + ".lock";
  const lock = acquireSidecarLock(lockDir, lockRetries, env);
  if (!lock.ok) {
    return { ok: false, reason: lock.reason === "maintenance" ? "maintenance" : "sidecar_busy", why: String(lock.reason ?? "lock_unavailable") };
  }
  let result = null;
  try {
    const cur = readSidecarStore({ endpointId, name, env });
    if (!cur.ok) { result = { ok: false, reason: cur.reason, why: cur.why }; return result; }
    const nextEntries = { ...(cur.entries ?? {}) };
    let changed = false;
    for (const k of keys) {
      const curValue = Object.prototype.hasOwnProperty.call(nextEntries, k) ? nextEntries[k] : null;
      const want = values[k];
      if (curValue === want) continue;   // 逐字相同 → 不改这一条
      changed = true;
      if (want === null || want === undefined) delete nextEntries[k];
      else nextEntries[k] = want;
    }
    if (!changed) {
      const dirErr = fsyncDir(path.dirname(p.file));
      result = dirErr !== null
        ? { ok: false, changed: false, reason: "sidecar_durability_unconfirmed", why: dirErr, committed: true, entries: cur.entries ?? {}, file: p.file }
        : { ok: true, changed: false, entries: cur.entries ?? {}, file: p.file, committed: false, persistence: "fsynced" };
      return result;
    }
    const nextDoc = { schema_version: (cur.doc?.schema_version ?? SIDECAR_SCHEMAS[name]), endpoint_id: endpointId, entries: nextEntries };
    const invalid = validateSidecarDoc(nextDoc, name, { endpointId });
    if (invalid !== null) { result = { ok: false, reason: "sidecar_invalid", why: invalid }; return result; }
    const w = writeSidecarAtomic(p.file, stableStringify(nextDoc, 2) + "\n");
    if (!w.ok) { result = { ok: false, reason: w.reason, why: w.why, committed: w.committed === true, entries: w.committed === true ? nextEntries : cur.entries }; return result; }
    const back = readSidecarStore({ endpointId, name, env });
    if (!back.ok) { result = { ok: false, reason: "sidecar_readback_failed", why: back.why ?? back.reason, committed: true, entries: nextEntries, file: p.file }; return result; }
    if (stableStringify(back.entries, 2) !== stableStringify(nextEntries, 2)) {
      result = { ok: false, reason: "sidecar_readback_mismatch", why: "读回条目与本次意图不一致（盘上被别的写方动过？）", committed: true, entries: nextEntries, file: p.file };
      return result;
    }
    result = { ok: true, changed: true, entries: nextEntries, doc: nextDoc, file: p.file, committed: true, persistence: "fsynced" };
    return result;
  } finally {
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
      result.reason = "sidecar_lock_release_failed";
      result.why = unclean.reason;
      result.lockUncleared = unclean;
    }
  }
}

/**
 * 锁内读-改-校验-原子写**单条目**。
 *
 * `mutate(current, meta)` 契约：`current` = 该 key 现值（缺 → null）；
 * 返回 `{ok:true, changed?:boolean, value?}`（`value === null` → **删**该键；`changed:false` → 零写返回）
 * 或 `{ok:false, reason, why?}`（原样透传）。
 * 写前**整文档**过 `validateSidecarDoc(nextDoc, name, {endpointId})`——非法条目一个字节都不落盘。
 */
export function mutateSidecarEntry({ endpointId, name, key, mutate, env = process.env, lockRetries = 0 } = {}) {
  if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "sidecar_bad_key", why: "key 必须是非空字符串" };
  if (typeof mutate !== "function") return { ok: false, reason: "sidecar_bad_mutate", why: "mutate 必须是函数" };
  const p = sidecarPath({ endpointId, name, env, mustExistRoot: true });
  if (!p.ok) return { ok: false, reason: "sidecar_unreadable", why: "账本目录解析失败：" + String(p.why ?? p.reason) };
  const lockDir = p.file + ".lock";
  const lock = acquireSidecarLock(lockDir, lockRetries, env);
  if (!lock.ok) {
    return { ok: false, reason: lock.reason === "maintenance" ? "maintenance" : "sidecar_busy", why: String(lock.reason ?? "lock_unavailable") };
  }
  // P1-5②（返修）：**每一条返回路径都先赋给 result** —— 只有 result 非 null 才会在 finally 里折
  //   释放残骸；早退（含 changed:false 的零写返回）直接 return 字面量会让那一折被吞掉，
  //   “锁没交还”被报成 clean。
  let result = null;
  try {
    // 锁内 fd 受验重读（不在锁外先读：那是个漂移窗口）。
    const cur = readSidecarStore({ endpointId, name, env });
    if (!cur.ok) {
      result = { ok: false, reason: cur.reason, why: cur.why };
      return result;
    }
    const present = cur.absent === true ? null : (Object.prototype.hasOwnProperty.call(cur.entries, key) ? cur.entries[key] : null);
    const changed = mutate(present, { key, file: p.file, entries: cur.entries, absent: cur.absent === true });
    if (!changed || typeof changed !== "object" || changed.ok !== true) {
      result = changed && typeof changed === "object" && changed.ok === false
        ? changed
        : { ok: false, reason: "sidecar_bad_mutate", why: "mutate 必须返回 {ok:true, changed?, value?} 或 {ok:false, reason}" };
      return result;
    }
    if (changed.changed === false) {
      // P1-5①（返修）：零写返回**不等于持久性已证实** —— 上一笔很可能正是死在 rename 之后的目录
      //   fsync 上（盘上已是这一份、这一跳没做成）。所以每次零写返回都重做一次目录屏障，
      //   屏障成不成如实报（失败 → 拒 + committed，交给调用方折 unclean），不因"字节没变"跳过。
      const dirErr = fsyncDir(path.dirname(p.file));
      result = dirErr !== null
        ? { ok: false, changed: false, reason: "sidecar_durability_unconfirmed", why: dirErr, committed: true, entries: cur.entries ?? {}, file: p.file }
        : { ok: true, changed: false, value: present, entries: cur.entries ?? {}, file: p.file, committed: false, persistence: "fsynced" };
      return result;
    }
    const nextEntries = { ...(cur.entries ?? {}) };
    const value = Object.prototype.hasOwnProperty.call(changed, "value") ? changed.value : present;
    if (value === null || value === undefined) delete nextEntries[key];
    else nextEntries[key] = value;
    const nextDoc = { schema_version: (cur.doc?.schema_version ?? SIDECAR_SCHEMAS[name]), endpoint_id: endpointId, entries: nextEntries };
    const invalid = validateSidecarDoc(nextDoc, name, { endpointId });
    if (invalid !== null) {
      result = { ok: false, reason: "sidecar_invalid", why: invalid };
      return result;
    }
    const w = writeSidecarAtomic(p.file, stableStringify(nextDoc, 2) + "\n");
    if (!w.ok) {
      result = { ok: false, reason: w.reason, why: w.why, committed: w.committed === true, entries: w.committed === true ? nextEntries : cur.entries };
      return result;
    }
    // 写后受验读回：整文档再过一遍，且条目逐字一致（读不回/不一致 → 已提交但不干净）。
    const back = readSidecarStore({ endpointId, name, env });
    if (!back.ok) {
      result = { ok: false, reason: "sidecar_readback_failed", why: back.why ?? back.reason, committed: true, entries: nextEntries, file: p.file };
      return result;
    }
    if (stableStringify(back.entries, 2) !== stableStringify(nextEntries, 2)) {
      result = { ok: false, reason: "sidecar_readback_mismatch", why: "读回条目与本次意图不一致（盘上被别的写方动过？）", committed: true, entries: nextEntries, file: p.file };
      return result;
    }
    result = { ok: true, changed: true, value, entries: nextEntries, doc: nextDoc, file: p.file, committed: true, persistence: "fsynced" };
    return result;
  } finally {
    // R57d：释放不干净不谎报 clean —— 折成 lockUncleared（带 path）并降级 ok；写已落盘的话 entries/committed 照旧带出。
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
      result.reason = "sidecar_lock_release_failed";
      result.why = unclean.reason;
      result.lockUncleared = unclean;
    }
  }
}
