/**
 * sidecar 窄 writer（T4/M1b 第二单，maintenance-gate.md「账本接入」+ §4.1 4d）。
 *
 * 单 sidecar 单步：绑定 token + lease + prepared step，读实文件核验后才写，
 * fenced commit（tmp O_CREAT|O_EXCL 0600 → fsync → rename → 目录 fsync → 读回核 SHA）。
 * 锁序合同：安装面锁 → lease / active / 门 → **sidecar 文件锁（这里，逐取逐交清）**
 * → 账本锁（调用方，authority cutover 唯一提交点）。本模块不碰账本文件。
 *
 * R45 返修 P1-1：释放 operation lease 后 writer 曾实际 ungated——现在**写前**（sidecar 文件锁内、
 * 分派前）核三绑定齐活：active 指向本 token、lease 仍在本进程手里、维护门 active 且 token 相符。
 * 三者任一不活 → 拒写（op_not_active / lease_not_held / gate_not_active），文件一字节不动。
 *
 * 崩溃恢复三分（现场 vs 锚，分派在 sidecar 文件锁内完成）：
 *   · 现场 SHA === intended → 已是目标态：只补 done（幂等，不重写）
 *   · 现场 === before（step.before.exists=true 且 SHA 相等，或 before.exists=false 且 ENOENT）→ fenced 写；
 *     before 存在时**先核备份**（P1-5）：journal 里的 backup 锚受验读 + 内容 SHA 必须等于 before 现场 SHA
 *   · 其它（含不可解析、硬链接 ≠1、陌生内容）→ sidecar_corrupt，文件一字节不动，停门等人
 *
 * 写后读回核 SHA === intended_after.sha256 才 markStepDone——「写成功」的定义是读回来对，
 * 不是 write() 不抛。目录 fsync / 锁释放失败都**折进返回值**（P1-2）：不静默吞，调用方必须停。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { SIDECAR_NAMES, dirFsyncIgnorable, readActive, readJournal, markStepDone } from "./journal.mjs";
import { readGate } from "../maintenance-gate-core.mjs";
import { readStagedVerified } from "../m1b/staged-plan.mjs";
import { acquireLockUngated, commitWhileHeld, releasePublishLock } from "../registry.mjs";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const errCodeOf = (err) => String(err?.code ?? err?.message ?? err);

/** sidecar 现场受验读：O_NOFOLLOW、普通文件、单硬链接、0600、≤maxBytes（异常形状按 problem 处理，不走 before 分支）。
 *  R45 二轮 P1-5：唯一受验 sidecar 读取器 —— 上限内才 alloc，不无界读；返回带 buf 供 staging 备份复用，
 *  不再把 FIFO 当空文件、多硬链接/超限文件当普通文件读。 */
export const SIDECAR_READ_MAX_BYTES = 1024 * 1024; // 与 staged blob 上限同源（S1/M1b 侧 ≤1MiB）
export function readSidecarCurrent(file, { maxBytes = SIDECAR_READ_MAX_BYTES } = {}) {
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (err) {
    if (err?.code === "ENOENT") return { present: false };
    return { present: true, problem: err?.code ?? "EIO" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) return { present: true, problem: "形状异常（非普通文件/硬链接≠1/mode≠0600）" };
    if (st.size > maxBytes) return { present: true, problem: "超限（" + st.size + " > " + maxBytes + " 字节）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) return { present: true, problem: "读不满" }; off += n; }
    return { present: true, sha256: sha256Hex(buf), buf };
  } catch (err) { return { present: true, problem: err?.code ?? "EIO" }; }
  finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

/** P1-1 三绑定（active / lease / 门）：写前在 sidecar 文件锁内核，任一不活都拒。
 *  R45 二轮 P1-3①：lease 复验走对象返回（carryReapResidue 只对 object 生效），reapUncleared 丢不得——
 *  reap 交不还是现场没清干净，不能当「lease 仍被自己持有」继续写。 */
function verifyOpBindings({ dir, token, lease, gateFile, now }) {
  const act = readActive({ dir });
  if (act.state !== "active" || act.token !== token) {
    return { ok: false, reason: "op_not_active", why: act.state === "active" ? "active 指向别的 operation" : "active " + act.state + (act.why ? "（" + act.why + "）" : "") };
  }
  const held = commitWhileHeld(lease.path, () => ({ ok: true }), { waitMs: 0 });
  if (held.ok !== true) return { ok: false, reason: "lease_not_held", why: "operation lease 不在本进程手里（" + String(held.reason ?? "lost") + "）" };
  if (held.reapUncleared) {
    // R45 三轮 P2-2：保留原 reason（reap_uncleared）+ 残骸路径 + error，不再折成无路径的 lease_not_held
    // ——运维看到的应当是真实原因和真实路径。
    return { ok: false, reason: "reap_uncleared", path: held.reapUncleared.path ?? null, error: held.reapUncleared.error ?? null,
      why: "operation lease 的 .reap 交不还——现场清理未完成，不装干净" };
  }
  const g = readGate({ file: gateFile, now });
  if (g.state !== "active" || g.payload?.token !== token) {
    return { ok: false, reason: "gate_not_active", why: "维护门 " + g.state + (g.why ? "（" + g.why + "）" : "") };
  }
  return { ok: true };
}

export function writeSidecarPrepared({ dir, token, lease, gateFile, endpointId, name, ledgerDir, now = Date.now() }) {
  if (SIDECAR_NAMES.includes(name) !== true) return { ok: false, reason: "bad_name", why: name };
  if (typeof gateFile !== "string" || gateFile.length === 0) return { ok: false, reason: "gate_file_missing", why: "sidecar 写前必须绑定维护门（gateFile）" };
  const doc = readJournal({ dir, token });
  if (doc.state !== "valid") return { ok: false, reason: "journal_unreadable", why: doc.why ?? doc.state };
  if (doc.doc.operation_kind !== "ledger_cutover") return { ok: false, reason: "phase_mismatch", phase: doc.doc.phase, why: "不是 cutover 操作" };
  if (doc.doc.phase !== "ledger_cutting_over") return { ok: false, reason: "phase_mismatch", phase: doc.doc.phase };
  const step = doc.doc.steps.find((s) => s.kind === "sidecar" && s.id === "sidecar:" + name + ":" + endpointId);
  if (!step) return { ok: false, reason: "step_missing", why: name };
  const target = path.join(ledgerDir, name + ".json");
  if (step.state === "done") {
    // P1-2：done 不再直接当成功——复核 journal 锚与现场文件一致（纯读，不写，不需要三绑定检查）。
    if (step.after?.sha256 !== step.intended_after?.sha256) return { ok: false, reason: "sidecar_corrupt", why: "done step 的 after 锚与 intended_after 不等" };
    const done = readSidecarCurrent(target);
    if (!(done.present && done.problem === undefined && done.sha256 === step.intended_after.sha256)) {
      return { ok: false, reason: "sidecar_corrupt", why: "done step 的现场与锚不符" };
    }
    return { ok: true, written: false };
  }
  if (step.state !== "prepared") return { ok: false, reason: "step_state", why: step.state };
  if (step.intended_after?.exists !== true || typeof step.intended_after?.sha256 !== "string") return { ok: false, reason: "step_anchor", why: "intended_after 锚不完整" };
  // staged 受验读（token 绑定路径；锚 SHA/bytes 来自 journal step，不信任盘上自述）
  const blobPath = path.join(dir, token + ".staged", "intended", name + ".json");
  const blob = readStagedVerified(blobPath, { sha256: step.intended_blob?.sha256, bytes: step.intended_blob?.bytes ?? null });
  if (blob.ok !== true) return { ok: false, reason: "staged_unreadable", why: blob.why };

  const lockDir = target + ".lock";
  const lock = acquireLockUngated(lockDir, { reapUnrecognized: false, now });
  if (lock.ok !== true) return { ok: false, reason: "sidecar_lock_busy", why: lock.reason };

  // R45 三轮 P1-2：临界段收窄。主 sidecar 锁持有期完成全部准备（绑定核验 → 现场判读 → 备份核验 → tmp 写+fsync）；
  // commitWhileHeld 的 .reap 段内只做「CAS 重读 + token 核验 + rename」三件 —— registry 合同是 .reap 段只做几次文件
  // 操作：慢 I/O 或 journal 写期死进程会把归属转换锁变长期人工残骸。目录 fsync、读回核、journal done 全部移出段外。
  const release45 = () => releasePublishLock(lockDir, { expectedToken: lock.token });
  // R45 二轮 P1-3：释放支 absent / reapUncleared 都不算交清 → sidecar_lock_release_failed + releaseResidue；
  // R45 三轮 P2-1：主锁路径一并带出（编排层 lockUncleared / CLI releaseRows 的原料）。
  const finish45 = (out45) => {
    const rel45 = release45();
    const residue45 = rel45.ok !== true ? String(rel45.reason ?? "release_publish_lock") : rel45.absent === true ? "absent" : rel45.reapUncleared ? "reap_uncleared" : null;
    if (residue45 !== null) {
      console.error(JSON.stringify({ level: "error", where: "sidecar-writer", op: "release", lock: lockDir, reason: residue45 }));
      return { ok: false, reason: "sidecar_lock_release_failed", why: residue45, written: out45?.written === true, lock: lockDir,
        releaseResidue: { absent: rel45.absent === true, reapUncleared: rel45.reapUncleared ?? null } };
    }
    return out45;
  };
  // R45 二轮 P1-4：written 以现场实际状态重验（rename 落了就是 true，不猜）。
  const landed45 = () => {
    const now45 = readSidecarCurrent(target);
    return now45.present === true && now45.problem === undefined && now45.sha256 === step.intended_after.sha256;
  };

  // 准备段（.reap 段外）：返 { early:true, result }（早退结果，走 finish45 释放分类）或 { tmp }（就绪待 rename）。
  const prepare45 = () => {
    const bind = verifyOpBindings({ dir, token, lease, gateFile, now });
    if (bind.ok !== true) return { early: true, result: bind };
    const cur = readSidecarCurrent(target);
    // 恢复三分：现场已是目标态 → 只补 done（幂等，无 rename，无需 fence）
    if (cur.present && cur.problem === undefined && cur.sha256 === step.intended_after.sha256) {
      const d = markStepDone({ dir, token, lease, id: step.id, after: step.intended_after, now });
      if (d?.ok !== true) return { early: true, result: { ok: false, reason: d?.reason ?? "journal_conflict", why: d?.why ?? null } };
      return { early: true, result: { ok: true, written: false, recovered: true } };
    }
    const before = step.before ?? { exists: false, sha256: null };
    const matchesBefore = cur.present
      ? (cur.problem === undefined && before.exists === true && before.sha256 !== null && cur.sha256 === before.sha256)
      : before.exists === false;
    if (matchesBefore !== true) {
      return { early: true, result: { ok: false, reason: "sidecar_corrupt", why: cur.present ? (cur.problem ?? "现场 SHA 既不是 intended 也不是 before") : "现场缺席但 before 存在" } };
    }
    // P1-5：覆盖既有 sidecar 前必须核备份——journal 锚受验读 + 内容 SHA 等于 before 现场 SHA。
    if (before.exists === true) {
      const bk = readStagedVerified(step.backup, { sha256: step.backup_sha256, bytes: step.backup_bytes ?? null });
      if (bk.ok !== true) return { early: true, result: { ok: false, reason: "sidecar_backup_mismatch", why: "备份受验读失败：" + (bk.why ?? "") } };
      if (sha256Hex(bk.buf) !== before.sha256) return { early: true, result: { ok: false, reason: "sidecar_backup_mismatch", why: "备份内容不是 before 现场" } };
    }
    const tmp = path.join(ledgerDir, "." + name + "." + process.pid + "." + crypto.randomUUID() + ".tmp");
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, blob.buf); fs.fsyncSync(fd); } catch (err) { try { fs.closeSync(fd); } catch { /* 已关 */ } try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
    fs.closeSync(fd);
    return { tmp };
  };

  let prep = null, prepErr = null;
  try { prep = prepare45(); } catch (err) { prepErr = err; }
  if (prepErr !== null) {
    // R45 二轮 P1-4：写路径异常折结构化返回（sidecar_write_failed），不裸抛炸穿调用方；tmp 由 prepare 内部清。
    return finish45({ ok: false, reason: "sidecar_write_failed", why: errCodeOf(prepErr), written: landed45() });
  }
  if (prep.early === true) return finish45(prep.result);

  // .reap 临界段：CAS 重读 + token 核验（commitWhileHeld 段首 readLockOwner）+ rename，就这三件。fn 抛错原样抛出。
  let fenced = null, fenceErr = null;
  try { fenced = commitWhileHeld(lockDir, () => { fs.renameSync(prep.tmp, target); return { renamed: true }; }, { waitMs: 0 }); } catch (err) { fenceErr = err; }
  if (fenceErr !== null) {
    try { fs.unlinkSync(prep.tmp); } catch { /* 留给人 */ }
    return finish45({ ok: false, reason: "sidecar_write_failed", why: errCodeOf(fenceErr), written: landed45() });
  }
  if (fenced.ok !== true) {
    try { fs.unlinkSync(prep.tmp); } catch { /* 留给人 */ }
    const rel45 = release45();
    if (fenced.reason === "lock_lost") {
      // R45 二轮 P1-2：锁被接管（lock_lost）后旧 writer 晚到也写不进新现场；tmp 已清，账本不动。
      return { ok: false, reason: "sidecar_lock_lost", why: "lock_lost", written: false, lock: lockDir,
        release: rel45.ok === true ? null : String(rel45.reason ?? "release_publish_lock") };
    }
    // R45 三轮 P2-2：reap_busy / reap_residue / io_error 保留原 reason（不再都折 sidecar_lock_lost ——
    // 运维看到的应当是真实原因），主锁路径结构化带出。
    return { ok: false, reason: String(fenced.reason ?? "fence_failed"), why: String(fenced.reason ?? "fence_failed"), written: false, lock: lockDir,
      release: rel45.ok === true ? null : String(rel45.reason ?? "release_publish_lock") };
  }
  if (fenced.reapUncleared) {
    // R45 二轮 P1-3：fence 段 .reap 交不还 → sidecar_lock_residue（write 已落，主锁不释放，残骸交显式维护）。
    return { ok: false, reason: "sidecar_lock_residue", written: true, lock: lockDir,
      residue: { path: fenced.reapUncleared.path ?? null, error: String(fenced.reapUncleared.error ?? "") } };
  }

  // 段外收尾（P1-2）：目录 fsync → 写后读回核 → journal done。任一失败折进返回值（written:true，不静默吞）。
  let out45 = { ok: true, written: true };
  // 目录 fsync（P1-2）：EINVAL/ENOTSUP/EOPNOTSUPP 是文件系统不支持目录 fsync（可容忍）；其它失败折 sidecar_dir_fsync。
  let dfd = null;
  try { dfd = fs.openSync(ledgerDir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); } catch (err) {
    if (!dirFsyncIgnorable(err?.code)) out45 = { ok: false, reason: "sidecar_dir_fsync", why: errCodeOf(err), written: true };
  } finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
  if (out45.ok) {
    const back = readSidecarCurrent(target);
    if (back.present !== true || back.problem !== undefined || back.sha256 !== step.intended_after.sha256) {
      out45 = { ok: false, reason: "sidecar_corrupt", why: "写后读回核失败", written: true };
    }
  }
  if (out45.ok) {
    const d = markStepDone({ dir, token, lease, id: step.id, after: step.intended_after, now });
    if (d?.ok !== true) out45 = { ok: false, reason: d?.reason ?? "journal_conflict", why: d?.why ?? null, written: true };
  }
  return finish45(out45);
}
