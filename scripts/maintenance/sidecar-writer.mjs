/**
 * sidecar 窄 writer（T4/M1b 第二单，maintenance-gate.md「账本接入」+ §4.1 4d）。
 *
 * 单 sidecar 单步：绑定 token + lease + prepared step，读实文件核验后才写，
 * fenced commit（tmp O_CREAT|O_EXCL 0600 → fsync → rename → 目录 fsync → 读回核 SHA）。
 * 锁序合同：安装面锁 → lease / active / 门 → **sidecar 文件锁（这里，逐取逐交清）**
 * → 账本锁（调用方，authority cutover 唯一提交点）。本模块不碰账本文件。
 *
 * 崩溃恢复三分（现场 vs 锚，分派在 sidecar 文件锁内完成）：
 *   · 现场 SHA === intended → 已是目标态：只补 done（幂等，不重写）
 *   · 现场 === before（step.before.exists=true 且 SHA 相等，或 before.exists=false 且 ENOENT）→ fenced 写
 *   · 其它（含不可解析、硬链接 ≠1、陌生内容）→ sidecar_corrupt，文件一字节不动，停门等人
 *
 * 写后读回核 SHA === intended_after.sha256 才 markStepDone——「写成功」的定义是读回来对，
 * 不是 write() 不抛。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { SIDECAR_NAMES, readJournal, markStepDone } from "./journal.mjs";
import { readStagedVerified } from "../m1b/staged-plan.mjs";
import { acquireLockUngated, releasePublishLock } from "../registry.mjs";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

function readSidecarCurrent(file) {
  // 与 staged 同一受验读：O_NOFOLLOW、普通文件、单硬链接、0600（异常形状按 corrupt 处理，不走 before 分支）。
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (err) {
    if (err?.code === "ENOENT") return { present: false };
    return { present: true, problem: err?.code ?? "EIO" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) return { present: true, problem: "形状异常（非普通文件/硬链接≠1/mode≠0600）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) return { present: true, problem: "读不满" }; off += n; }
    return { present: true, sha256: sha256Hex(buf) };
  } catch (err) { return { present: true, problem: err?.code ?? "EIO" }; }
  finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

export function writeSidecarPrepared({ dir, token, lease, endpointId, name, ledgerDir, now = Date.now() }) {
  if (SIDECAR_NAMES.includes(name) !== true) return { ok: false, reason: "bad_name", why: name };
  const doc = readJournal({ dir, token });
  if (doc.state !== "valid") return { ok: false, reason: "journal_unreadable", why: doc.why ?? doc.state };
  if (doc.doc.operation_kind !== "ledger_cutover") return { ok: false, reason: "phase_mismatch", phase: doc.doc.phase, why: "不是 cutover 操作" };
  if (doc.doc.phase !== "ledger_cutting_over") return { ok: false, reason: "phase_mismatch", phase: doc.doc.phase };
  const step = doc.doc.steps.find((s) => s.kind === "sidecar" && s.id === "sidecar:" + name + ":" + endpointId);
  if (!step) return { ok: false, reason: "step_missing", why: name };
  if (step.state === "done") return { ok: true, written: false };
  if (step.state !== "prepared") return { ok: false, reason: "step_state", why: step.state };
  if (step.intended_after?.exists !== true || typeof step.intended_after?.sha256 !== "string") return { ok: false, reason: "step_anchor", why: "intended_after 锚不完整" };
  // staged 受验读（token 绑定路径；锚 SHA/bytes 来自 journal step，不信任盘上自述）
  const blobPath = path.join(dir, token + ".staged", "intended", name + ".json");
  const blob = readStagedVerified(blobPath, { sha256: step.intended_blob?.sha256, bytes: step.intended_blob?.bytes ?? null });
  if (blob.ok !== true) return { ok: false, reason: "staged_unreadable", why: blob.why };

  const target = path.join(ledgerDir, name + ".json");
  const lockDir = target + ".lock";
  const lock = acquireLockUngated(lockDir, { reapUnrecognized: false, now });
  if (lock.ok !== true) return { ok: false, reason: "sidecar_lock_busy", why: lock.reason };
  try {
    const cur = readSidecarCurrent(target);
    // 恢复三分
    if (cur.present && cur.problem === undefined && cur.sha256 === step.intended_after.sha256) {
      // 现场已是目标态：只补 done（幂等），不重写
      const d = markStepDone({ dir, token, lease, id: step.id, after: step.intended_after, now });
      if (d === null) return { ok: false, reason: "journal_conflict" };
      return { ok: true, written: false, recovered: true };
    }
    const before = step.before ?? { exists: false, sha256: null };
    const matchesBefore = cur.present
      ? (cur.problem === undefined && before.exists === true && before.sha256 !== null && cur.sha256 === before.sha256)
      : before.exists === false;
    if (matchesBefore !== true) {
      return { ok: false, reason: "sidecar_corrupt", why: cur.present ? (cur.problem ?? "现场 SHA 既不是 intended 也不是 before") : "现场缺席但 before 存在" };
    }
    // fenced commit
    const tmp = path.join(ledgerDir, "." + name + "." + process.pid + "." + crypto.randomUUID() + ".tmp");
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, blob.buf); fs.fsyncSync(fd); } catch (err) { try { fs.closeSync(fd); } catch { /* 已关 */ } try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
    fs.closeSync(fd);
    try { fs.renameSync(tmp, target); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
    let dfd = null;
    try { dfd = fs.openSync(ledgerDir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); } catch { /* 目录 fsync 不可得：rename 已原子，可容忍 */ }
    finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
    // 写后读回核
    const back = readSidecarCurrent(target);
    if (back.present !== true || back.problem !== undefined || back.sha256 !== step.intended_after.sha256) {
      return { ok: false, reason: "sidecar_corrupt", why: "写后读回核失败" };
    }
    const d = markStepDone({ dir, token, lease, id: step.id, after: step.intended_after, now });
    if (d === null) return { ok: false, reason: "journal_conflict" };
    return { ok: true, written: true };
  } finally {
    const rel = releasePublishLock(lockDir, { expectedToken: lock.token });
    if (rel.ok !== true) {
      // 释放失败 fail-closed：锁留给陈旧回收，并让调用方看见（不静默吞）。
      console.error(JSON.stringify({ level: "error", where: "sidecar-writer", op: "release", lock: lockDir, reason: rel.reason }));
    }
  }
}
