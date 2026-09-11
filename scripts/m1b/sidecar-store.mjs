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
 *   · 释放不干净按 R57d 折成 `lockUncleared` 并把 ok 降级（不谎报 clean）。
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

/** 同目录 tmp（O_EXCL 0600）→ 写满 → 文件 fsync → rename → 目录 fsync。文件 fsync 失败：删 tmp、不 rename。
 *  `_inject`（只给测试）：{failTmpFsync, failDirFsync} —— PK2-W1-fix1 的两道屏障各自可注入失败。 */
function writeSidecarAtomic(file, content, _inject = null) {
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
    if (_inject?.failTmpFsync === true) { const e = new Error("input/output error"); e.code = "EIO"; throw e; }
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
  try {
    if (_inject?.failDirFsync === true) { const e = new Error("input/output error"); e.code = "EIO"; throw e; }
    const dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (err) {
    // 已提交但持久性没证实：拒（调用方折 unclean），并如实报 committed。
    return { ok: false, reason: "sidecar_durability_unconfirmed", why: String(err?.code ?? err?.message ?? err), committed: true };
  }
  return { ok: true, committed: true, persistence: "fsynced" };
}

/**
 * 锁内读-改-校验-原子写**单条目**。
 *
 * `mutate(current, meta)` 契约：`current` = 该 key 现值（缺 → null）；
 * 返回 `{ok:true, changed?:boolean, value?}`（`value === null` → **删**该键；`changed:false` → 零写返回）
 * 或 `{ok:false, reason, why?}`（原样透传）。
 * 写前**整文档**过 `validateSidecarDoc(nextDoc, name, {endpointId})`——非法条目一个字节都不落盘。
 */
export function mutateSidecarEntry({ endpointId, name, key, mutate, env = process.env, lockRetries = 0, _inject = null } = {}) {
  if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "sidecar_bad_key", why: "key 必须是非空字符串" };
  if (typeof mutate !== "function") return { ok: false, reason: "sidecar_bad_mutate", why: "mutate 必须是函数" };
  const p = sidecarPath({ endpointId, name, env, mustExistRoot: true });
  if (!p.ok) return { ok: false, reason: "sidecar_unreadable", why: "账本目录解析失败：" + String(p.why ?? p.reason) };
  const lockDir = p.file + ".lock";
  const lock = acquireSidecarLock(lockDir, lockRetries, env);
  if (!lock.ok) {
    return { ok: false, reason: lock.reason === "maintenance" ? "maintenance" : "sidecar_busy", why: String(lock.reason ?? "lock_unavailable") };
  }
  // PK2-W1-fix1 P1-5②：主体收进内层闭包，**每个返回路径**都经过外层的释放折叠 ——
  //   旧版只有最后一条成功路径给 result 赋值，changed:false / 各类早退 return 绕过 finally 的折叠
  //  （result 恒 null），锁释放不净被吞成 ok。
  const run = () => {
    // 锁内 fd 受验重读（不在锁外先读：那是个漂移窗口）。
    const cur = readSidecarStore({ endpointId, name, env });
    if (!cur.ok) return { ok: false, reason: cur.reason, why: cur.why };
    const present = cur.absent === true ? null : (Object.prototype.hasOwnProperty.call(cur.entries, key) ? cur.entries[key] : null);
    const changed = mutate(present, { key, file: p.file, entries: cur.entries, absent: cur.absent === true });
    if (!changed || typeof changed !== "object" || changed.ok !== true) {
      return changed && typeof changed === "object" && changed.ok === false
        ? changed
        : { ok: false, reason: "sidecar_bad_mutate", why: "mutate 必须返回 {ok:true, changed?, value?} 或 {ok:false, reason}" };
    }
    if (changed.changed === false) {
      // PK2-W1-fix1 P1-5①：文件在场（上次可能 durability 未证实）→ 零写返回前**重做目录屏障**。
      //   屏障再失败 → 如实拒（committed:true）——重跑可重做，直到屏障过为止；缺席文件无事可屏障。
      if (cur.absent !== true) {
        const barrier = writeSidecarAtomic(p.file, stableStringify(cur.doc, 2) + "\n", _inject);
        if (!barrier.ok) return { ok: false, reason: barrier.reason, why: "目录屏障重做失败（零写路径）：" + (barrier.why ?? ""), committed: barrier.committed === true };
      }
      return { ok: true, changed: false, value: present, entries: cur.entries ?? {}, file: p.file, committed: false };
    }
    const nextEntries = { ...(cur.entries ?? {}) };
    const value = Object.prototype.hasOwnProperty.call(changed, "value") ? changed.value : present;
    if (value === null || value === undefined) delete nextEntries[key];
    else nextEntries[key] = value;
    const nextDoc = { schema_version: (cur.doc?.schema_version ?? SIDECAR_SCHEMAS[name]), endpoint_id: endpointId, entries: nextEntries };
    const invalid = validateSidecarDoc(nextDoc, name, { endpointId });
    if (invalid !== null) return { ok: false, reason: "sidecar_invalid", why: invalid };
    const w = writeSidecarAtomic(p.file, stableStringify(nextDoc, 2) + "\n", _inject);
    if (!w.ok) return { ok: false, reason: w.reason, why: w.why, committed: w.committed === true, entries: w.committed === true ? nextEntries : cur.entries };
    // 写后受验读回：整文档再过一遍，且条目逐字一致（读不回/不一致 → 已提交但不干净）。
    const back = readSidecarStore({ endpointId, name, env });
    if (!back.ok) return { ok: false, reason: "sidecar_readback_failed", why: back.why ?? back.reason, committed: true, entries: nextEntries, file: p.file };
    if (stableStringify(back.entries, 2) !== stableStringify(nextEntries, 2)) {
      return { ok: false, reason: "sidecar_readback_mismatch", why: "读回条目与本次意图不一致（盘上被别的写方动过？）", committed: true, entries: nextEntries, file: p.file };
    }
    return { ok: true, changed: true, value, entries: nextEntries, doc: nextDoc, file: p.file, committed: true, persistence: "fsynced" };
  };
  let result = null;
  try {
    result = run();
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
