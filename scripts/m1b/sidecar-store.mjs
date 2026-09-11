/**
 * PK2-W1：pending-claims / expiry 条目的锁内读-改-校验-原子写 —— authoritative 写方的 sidecar 原语。
 *
 * 复用不重写：锁 = sidecar-writer 那把 `<file>.lock`（acquirePublishLock，reapUnrecognized:false，
 * 释放残骸折叠）；受验读 = sidecar-writer 的 readSidecarCurrent（0600/单硬链接/O_NOFOLLOW/有界）；
 * schema = sidecar-renderers 的 validateSidecarDoc（expiry/pending-claims 封闭值域，不写第二套）；
 * 规范字节 = policy-store/canonical 的 stableStringify（与 renderer 落盘布局同一出处）。
 *
 * 纪律（M1b-W1 裁定 ④）：锁内 fd 受验读 → 改单条目 → 整文档 validateSidecarDoc →
 * tmp+fsync+rename+目录 fsync（**fsync 失败即失败**）→ 写后受验读回；释放失败折进返回（lockUncleared）。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { readSidecarCurrent } from "../maintenance/sidecar-writer.mjs";
import { MAX_BYTES, SIDECAR_SCHEMAS, validateSidecarDoc } from "./sidecar-renderers.mjs";
import { stableStringify } from "../policy-store/canonical.mjs";

/** 本原语管的 sidecar 封闭集合（policy 有自己的 store：policy-store/store.mjs，不在这里）。 */
const STORE_NAMES = ["expiry", "pending-claims"];

/** 目录 fsync（数据进了目录项但持久性不确定的窗口收口）；注入缝只给测试。 */
const fsyncDir = (dir, _inject = null) => {
  if (_inject?.failDirFsync === true) { const e = new Error("input/output error"); e.code = "EIO"; throw e; }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

/**
 * 锁内读-改-校验-原子写一份 sidecar 文档。
 * @param name 封闭集合：expiry | pending-claims
 * @param mutate (entries) => { ok:true, entries, changed? } | { ok:false, reason, why? }
 *   changed:false 且 entries 与锁内现状逐字一致 → 零写返回（幂等读）。
 * @returns { ok:true, changed, entries } | { ok:false, reason, why?, committed?, lockUncleared? }
 *   失败 reason 族：sidecar_lock_busy / sidecar_unreadable / sidecar_invalid / sidecar_write_failed /
 *   sidecar_dir_fsync_failed（committed:true，数据已 rename） / sidecar_readback_failed（committed:true）。
 */
export function mutateSidecarDoc({ endpointId, name, mutate, env = process.env, _inject = null } = {}) {
  if (STORE_NAMES.includes(name) !== true) return { ok: false, reason: "bad_name", why: "sidecar store 只管 expiry/pending-claims（policy 归 policy-store）" };
  if (typeof mutate !== "function") return { ok: false, reason: "sidecar_mutate_invalid", why: "mutate 必须是函数" };
  const d = resolveEndpointDir(endpointId, { env, mustExistRoot: true });
  if (!d.ok) return { ok: false, reason: "sidecar_dir_unavailable", why: d.why ?? d.reason };
  const file = path.join(d.dir, name + ".json");
  const lockDir = file + ".lock";
  let lock;
  try { lock = acquirePublishLock(lockDir, { reapUnrecognized: false, env }); }
  catch (err) { return { ok: false, reason: "sidecar_lock_unavailable", why: String(err?.code ?? err?.message ?? err), lock: lockDir }; }
  if (lock.ok !== true) {
    return { ok: false, reason: lock.reason === "publisher_busy" ? "sidecar_lock_busy" : String(lock.reason ?? "sidecar_lock_busy"),
      why: lock.reason === "publisher_busy" ? "sidecar 锁被持有" : String(lock.why ?? lock.reason ?? ""),
      lock: lockDir, ...(lock.path != null ? { path: lock.path } : {}), ...(lock.error != null ? { error: String(lock.error) } : {}) };
  }
  let result;
  try {
    // 锁内 fd 受验读：缺席 = 规范空文档（首写合法）；在场但读不出/形状坏 = fail-closed。
    const cur = readSidecarCurrent(file);
    if (cur.present && cur.problem !== undefined) return (result = { ok: false, reason: "sidecar_unreadable", why: String(cur.problem) });
    let doc;
    if (!cur.present) {
      doc = { schema_version: SIDECAR_SCHEMAS[name], endpoint_id: endpointId, entries: {} };
    } else {
      try { doc = JSON.parse(cur.buf.toString("utf-8")); }
      catch { return (result = { ok: false, reason: "sidecar_unreadable", why: "不是 JSON" }); }
    }
    const shape = validateSidecarDoc(doc, name, { endpointId });
    if (shape !== null) return (result = { ok: false, reason: "sidecar_invalid", why: shape });
    const next = mutate(doc.entries);
    if (!next || typeof next !== "object") return (result = { ok: false, reason: "sidecar_mutate_invalid", why: "mutate 必须返回对象" });
    if (next.ok !== true) return (result = { ok: false, reason: next.reason ?? "sidecar_mutate_rejected", why: next.why ?? null });
    if (next.entries === null || typeof next.entries !== "object" || Array.isArray(next.entries)) {
      return (result = { ok: false, reason: "sidecar_mutate_invalid", why: "mutate 返回的 entries 必填（不默补空对象）" });
    }
    const nextDoc = { schema_version: SIDECAR_SCHEMAS[name], endpoint_id: endpointId, entries: next.entries };
    const problem = validateSidecarDoc(nextDoc, name, { endpointId });
    if (problem !== null) return (result = { ok: false, reason: "sidecar_invalid", why: "写前整文档校验不过，不落盘：" + problem });
    const changed = next.changed === false ? false : true;
    if (changed === false) {
      // 零写：entries 必须与锁内现状逐字一致（缺席文档只许空 entries）才返回，不谎报已写。
      if (cur.present && stableStringify(doc, 2) !== stableStringify(nextDoc, 2)) {
        return (result = { ok: false, reason: "sidecar_changed_mismatch", why: "changed:false 但 entries 与锁内现状不一致" });
      }
      if (!cur.present && Object.keys(next.entries).length !== 0) {
        return (result = { ok: false, reason: "sidecar_changed_mismatch", why: "文件缺席时 changed:false 仅允许空 entries" });
      }
      return (result = { ok: true, changed: false, entries: next.entries });
    }
    const bytes = Buffer.from(stableStringify(nextDoc, 2) + "\n", "utf-8");
    if (bytes.length > MAX_BYTES) return (result = { ok: false, reason: "sidecar_too_large", why: "超过 1MiB（" + bytes.length + " 字节）" });
    const tmp = file + ".tmp." + process.pid + "." + Date.now();
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); if (_inject?.failTmpFsync === true) { const e = new Error("input/output error"); e.code = "EIO"; throw e; } fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      fsyncDir(d.dir, _inject); // 目录 fsync 失败即失败（数据已 rename：committed:true，持久性不确定）
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 已 rename 或本就不在 */ }
      const code = String(err?.code ?? err?.message ?? err);
      return (result = err?.code === "EIO" && _inject?.failDirFsync === true
        ? { ok: false, reason: "sidecar_dir_fsync_failed", why: code, committed: true }
        : { ok: false, reason: "sidecar_write_failed", why: code });
    }
    // 写后受验读回：字节一致才算干净提交。
    const back = readSidecarCurrent(file);
    const wantSha = createHash("sha256").update(bytes).digest("hex");
    if (!(back.present && back.problem === undefined && back.sha256 === wantSha)) {
      return (result = { ok: false, reason: "sidecar_readback_failed", why: back.present ? (back.problem ?? "sha 不等") : "读不回", committed: true });
    }
    return (result = { ok: true, changed: true, entries: next.entries });
  } finally {
    let rel;
    try { rel = releasePublishLock(lockDir); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    if (result && typeof result === "object" && rel && rel.ok !== true) {
      result.lockUncleared = { path: lockDir, reason: rel.absent === true ? "absent" : String(rel.reason ?? "release_publish_lock"), ...(rel.error ? { error: rel.error } : {}) };
      if (result.ok === true) { result.ok = false; result.reason = "sidecar_release_failed"; result.committed = true; }
    }
  }
}
