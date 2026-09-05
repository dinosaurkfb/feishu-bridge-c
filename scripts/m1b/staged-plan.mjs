/**
 * M1b T4 ③：cutover 计划与三个 sidecar blob 的 **staged 机械**（m1a-reconciliation.md §4.1 4c）。
 *
 *   · 私有目录 `<维护目录>/<token>.staged/intended/`：逐层 0700，仅新建那一级 fsync 父目录（EEXIST 复用不 fsync）。
 *   · 四文件（plan.json + expiry/pending-claims/policy 三个 blob）O_EXCL 0600 fd 绑定写满 → fsync 文件 →
 *     全部落完 fsync intended/ 目录 —— 全部屏障成功，调用方才许进段提交（ledger_cutting_over）。
 *   · 崩溃重试：intended/ 里已有文件（含陌生文件）一律走受验复验 —— 逐一核 0600、单硬链接、O_NOFOLLOW、长度与 SHA；
 *     与计划派生的期望全符 → 复用（reused:true），任一缺/不符 → staged_residue 拒（绝不把读不出当成没有）。
 *   · blob 字节与 plan.sidecars 宣称的 SHA 不符 → 拒（写入前核，不给盘上留下与账本锚不同的物）。
 *   · journal 锚（plan_sha256 + 三 sidecar intended SHA）驱动 verifyStagedPlan：恢复路径按锚复验，不信任盘上 plan 自述。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dirFsyncIgnorable, stagedDirFor, stagedIntendedFile } from "../maintenance/journal.mjs";
import { stableStringify } from "../policy-store/canonical.mjs";
import { MAX_BYTES as SIDECAR_MAX_BYTES } from "./sidecar-renderers.mjs";

const PLAN_SCHEMA = "m1a-cutover-plan-1";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u; // 账本 endpoint_id（layers-v2-ledger.md §2，同 journal.mjs）
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const errCode = (err) => String(err?.code ?? err?.message ?? err);
/** P1-3：token 必须 UUID（词法上无 / 与 ..）——遍历/外指 token 在入口就拒，stagedDirFor 只拼受验 token。 */
const tokenShapeProblem = (token) => (typeof token === "string" && UUID_SHAPE.test(token) ? null : "token 不是 UUID");
// plan.sidecars 键（无连字符）→ sidecar 文件名（连字符，同 journal target 规范）。
const BLOB_FILE = Object.freeze({ expiry: "expiry", pending_claims: "pending-claims", policy: "policy" });
export const PLAN_FILE = "plan.json";

/** plan（m1a-cutover-plan-1）键集与值域封闭。 */
export function planProblem(plan) {
  if (!(isObj(plan) && keysOf(plan) === "digest,endpoint_id,ledger,operation_token,schema_version,sidecars,snapshot_identity")) return "plan 键集不对";
  if (plan.schema_version !== PLAN_SCHEMA) return "plan.schema_version 不是 " + PLAN_SCHEMA;
  if (typeof plan.operation_token !== "string" || !UUID_SHAPE.test(plan.operation_token)) return "plan.operation_token 不是 UUID";
  if (typeof plan.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(plan.endpoint_id)) return "plan.endpoint_id 形状不对";
  if (!(typeof plan.digest === "string" && SHA_SHAPE.test(plan.digest))) return "plan.digest 形状不对";
  if (!(isObj(plan.ledger) && keysOf(plan.ledger) === "revision,sha256" && Number.isSafeInteger(plan.ledger.revision) && plan.ledger.revision >= 1
    && typeof plan.ledger.sha256 === "string" && SHA_SHAPE.test(plan.ledger.sha256))) return "plan.ledger 形状不对";
  if (!Array.isArray(plan.snapshot_identity) || plan.snapshot_identity.length === 0 || !plan.snapshot_identity.every((x) => isObj(x)
    && keysOf(x) === "path,sha256,source" && typeof x.source === "string" && x.source.length > 0 && typeof x.path === "string" && path.isAbsolute(x.path)
    && (x.sha256 === null || (typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256))))) return "plan.snapshot_identity 形状不对";
  if (!(isObj(plan.sidecars) && keysOf(plan.sidecars) === "expiry,pending_claims,policy"
    && Object.values(plan.sidecars).every((x) => isObj(x) && keysOf(x) === "sha256" && typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256)))) return "plan.sidecars 形状不对";
  return null;
}

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 建 0700 目录（recursive 保父链在场），fsync 其父目录作屏障；已在场复用，但 mode 必须仍是 0700（private 目录不许降级）。 */
function mkdirDurable(dir, parentToFsync) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) { if (err?.code !== "EEXIST") throw err; }
  // P1-3：lstat 不跟随 —— .staged / intended 被预埋成外指 symlink 时必须在此拒，不能 statSync 跟随放行照写。
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) { const e = new Error("staged 层是符号链接：" + dir); e.code = "EPRIVLINK"; throw e; }
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) { const e = new Error("staged 目录不是 0700：" + dir); e.code = "EPRIVMODE"; throw e; }
  let dfd = null;
  try { dfd = fs.openSync(parentToFsync, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
  catch (err) { if (!dirFsyncIgnorable(err?.code)) throw err; }
  finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
}

/** O_EXCL 0600 fd 绑定写满 → fsync 文件。已在场（EEXIST）抛给上层走复验路径。 */
function writeExclDurable(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDir(dir) {
  let dfd = null;
  try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
  catch (err) { if (!dirFsyncIgnorable(err?.code)) throw err; }
  finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
}

/**
 * 受验读 staged 文件：O_NOFOLLOW fd 绑定、普通文件、单硬链接、mode 0600、（给定则）长度、SHA。
 * readRegularFile 不核 mode —— staged/sidecar 的 0600 合同在这里核。
 */
export function readStagedVerified(file, { sha256, bytes = null } = {}) {
  // P1-5：O_NONBLOCK —— FIFO 无写者时 O_RDONLY 的 open 会阻塞挂死；非阻塞打开后同 fd fstat 拒非普通文件。
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (err) { return { ok: false, why: err?.code === "ENOENT" ? "文件不在" : errCode(err) }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, why: "硬链接数不是 1" };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, why: "mode 不是 0600" };
    // P1-6：字节上限先于按 st.size 分配 Buffer —— 被换大的文件先受控拒，不分配超大缓冲。
    if (st.size > SIDECAR_MAX_BYTES) return { ok: false, why: "超过 1MiB（" + st.size + " 字节）" };
    if (bytes !== null && st.size !== bytes) return { ok: false, why: "长度不对（" + st.size + " ≠ " + bytes + "）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) return { ok: false, why: "读不满文件（" + off + "/" + st.size + "）" }; off += n; }
    const actual = sha256Hex(buf);
    if (actual !== sha256) return { ok: false, why: "sha256 不符" };
    return { ok: true, buf };
  } catch (err) { return { ok: false, why: errCode(err) }; }
  finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

/**
 * 按 journal 锚复验 staged 四件：plan.json 的 SHA + 三个 blob 的 SHA（逐一受验读）。
 * 锚来自 journal（ledger step 的 plan_sha256 + 三 sidecar intended_after/intended_blob），不信任盘上 plan 自述。
 */
export function verifyStagedPlan({ dir, token, planSha256, sidecarAnchors }) {
  const tokenProblem = tokenShapeProblem(token);
  if (tokenProblem !== null) return { ok: false, reason: "staged_residue", why: tokenProblem };
  // 二轮 P1-3：恢复路径逐层核 —— <token>.staged 与 intended 都必须是普通目录、精确 0700、无 symlink，
  // 且 canonical realpath 落在本 operation 私有目录内（把 intended/ 或 staged/ 整个换成外指 symlink 在这里拒，
  // 不只靠末级文件的 O_NOFOLLOW）。
  let intended = null;
  try {
    const realDir = fs.realpathSync(dir);
    const realStaged = path.join(realDir, stagedDirFor(token));
    const st = fs.lstatSync(realStaged);
    if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o777) !== 0o700) return { ok: false, reason: "staged_residue", why: "<token>.staged 不是 0700 普通目录" };
    if (fs.realpathSync(realStaged) !== realStaged) return { ok: false, reason: "staged_residue", why: "<token>.staged 的 realpath 不在私有目录内" };
    intended = path.join(realStaged, "intended");
    const si = fs.lstatSync(intended);
    if (si.isSymbolicLink() || !si.isDirectory() || (si.mode & 0o777) !== 0o700) return { ok: false, reason: "staged_residue", why: "intended 不是 0700 普通目录" };
    if (fs.realpathSync(intended) !== intended) return { ok: false, reason: "staged_residue", why: "intended 的 realpath 不在私有目录内" };
  } catch (err) { return { ok: false, reason: "staged_residue", why: "staged 目录核：" + errCode(err) }; }
  let names = [];
  try { names = fs.readdirSync(intended).sort(); } catch (err) { return { ok: false, reason: "staged_residue", why: "intended 目录读不出：" + errCode(err) }; }
  const want = [PLAN_FILE, ...Object.values(BLOB_FILE).map((n) => n + ".json")];
  if (JSON.stringify(names) !== JSON.stringify(want.slice().sort())) return { ok: false, reason: "staged_residue", why: "intended 里不是恰四件：" + names.join(",") };
  const p = readStagedVerified(path.join(intended, PLAN_FILE), { sha256: planSha256 });
  if (!p.ok) return { ok: false, reason: "staged_residue", why: "plan.json：" + p.why };
  // 二轮 P1-5：消费完整 {path,bytes,sha256} 锚 —— path 必须词法等于内部重算的规范路径、fd 实读长度必须等于 bytes、SHA 相等。
  // 只核 SHA 的旧写法放过了 bytes:999 这类与 journal 锚不一致的残骸。
  for (const [k, fileBase] of Object.entries(BLOB_FILE)) {
    const a = sidecarAnchors?.[k];
    if (!(a && typeof a === "object" && !Array.isArray(a))) return { ok: false, reason: "staged_residue", why: k + " 的锚缺失" };
    if (typeof a.path !== "string" || !path.isAbsolute(a.path)) return { ok: false, reason: "staged_residue", why: k + " 的锚 path 不是绝对路径" };
    if (a.path !== stagedIntendedFile({ dir, token, name: k === "pending_claims" ? "pending-claims" : k })) return { ok: false, reason: "staged_residue", why: k + " 的锚 path 与内部规范路径不符" };
    if (!Number.isSafeInteger(a.bytes) || a.bytes < 0) return { ok: false, reason: "staged_residue", why: k + " 的锚 bytes 不是非负安全整数" };
    if (!(typeof a.sha256 === "string" && SHA_SHAPE.test(a.sha256))) return { ok: false, reason: "staged_residue", why: k + " 的锚 SHA 缺失或形状不对" };
    const r = readStagedVerified(path.join(intended, fileBase + ".json"), { sha256: a.sha256, bytes: a.bytes });
    if (!r.ok) return { ok: false, reason: "staged_residue", why: fileBase + ".json：" + r.why };
  }
  return { ok: true };
}

/**
 * staging 入口：plan + 三 blob 全部落 staged 私有目录（全新 O_EXCL 写 / 崩溃重试受验复用）。
 * plan.sidecars[k].sha256 必须等于 blobs[k] 的真实 SHA（调用方给错 → plan_mismatch，不落盘）。
 */
export function stageCutoverPlan({ dir, token, plan, blobs }) {
  const problem = planProblem(plan);
  if (problem !== null) return { ok: false, reason: "plan_mismatch", why: problem };
  // P1-3：token 必须 UUID 且与 plan.operation_token 绑定 —— 遍历 token（../escape）、外指 staging 全部在此拒。
  const tokenProblem = tokenShapeProblem(token);
  if (tokenProblem !== null) return { ok: false, reason: "plan_mismatch", why: tokenProblem };
  if (token !== plan.operation_token) return { ok: false, reason: "plan_mismatch", why: "token 与 plan.operation_token 不一致" };
  if (!(isObj(blobs) && keysOf(blobs) === "expiry,pending_claims,policy"
    && Object.values(blobs).every((b) => b instanceof Uint8Array))) return { ok: false, reason: "plan_mismatch", why: "blobs 必须是 {expiry,pending_claims,policy} 三个 Uint8Array" };
  // P1-6：blob 超过 1MiB 拒在写入前 —— 不给盘上留下读取端必拒的物。
  for (const [k, fileBase] of Object.entries(BLOB_FILE)) {
    if (blobs[k].byteLength > SIDECAR_MAX_BYTES) return { ok: false, reason: "plan_mismatch", why: fileBase + " blob 超过 1MiB（" + blobs[k].byteLength + " 字节）" };
    const actual = sha256Hex(Buffer.from(blobs[k]));
    if (actual !== plan.sidecars[k].sha256) return { ok: false, reason: "plan_mismatch", why: fileBase + " 字节 SHA 与 plan.sidecars." + k + ".sha256 不符" };
  }
  const planBytes = Buffer.from(stableStringify(plan, 2) + "\n", "utf-8");
  // 二轮 P1-4：plan.json 自身也受读端同一上限约束 —— 超限拒在建目录/写文件之前，不给盘上留下读取端必拒的物。
  if (planBytes.length > SIDECAR_MAX_BYTES) return { ok: false, reason: "plan_mismatch", why: "plan 超过 1MiB（" + planBytes.length + " 字节）" };
  const planSha = sha256Hex(planBytes);
  const staged = path.join(dir, stagedDirFor(token));
  const intended = path.join(staged, "intended");
  try {
    mkdirDurable(staged, dir);
    mkdirDurable(intended, staged);
  } catch (err) {
    if (err?.code === "EPRIVMODE" || err?.code === "EPRIVLINK") return { ok: false, reason: "staged_residue", why: err.message };
    return { ok: false, reason: "io_error", why: "建 staged 目录：" + errCode(err) };
  }
  // intended/ 已有文件（崩溃残骸）：走受验复验，全符复用、否则拒。陌生文件也是残骸。
  let existing = [];
  try { existing = fs.readdirSync(intended).sort(); } catch (err) { return { ok: false, reason: "io_error", why: "读 intended：" + errCode(err) }; }
  if (existing.length > 0) {
    // 二轮 P1-5：复验走完整锚（path 词法重算 + 盘上真实 bytes + plan.sidecars SHA），与 journal 锚驱动同一消费面。
    const anchors = Object.fromEntries(["expiry", "pending_claims", "policy"].map((k) => [k, { path: stagedIntendedFile({ dir, token, name: k === "pending_claims" ? "pending-claims" : k }), bytes: blobs[k].byteLength, sha256: plan.sidecars[k].sha256 }]));
    const v = verifyStagedPlan({ dir, token, planSha256: planSha, sidecarAnchors: anchors });
    if (!v.ok) return { ok: false, reason: "staged_residue", why: v.why };
    // P1-4：复用成功前必须重新 fsync intended/ 目录 —— 首次写完四件但目录屏障失败后，
    // 重试只复验文件即 reused 会把「目录项未落盘」的窗口带进段提交。
    try { fsyncDir(intended); } catch (err) { return { ok: false, reason: "io_error", why: "复用前 fsync intended 目录：" + errCode(err) }; }
    return { ok: true, reused: true, plan_bytes: planBytes.length, plan_sha256: planSha };
  }
  try {
    writeExclDurable(path.join(intended, PLAN_FILE), planBytes);
    for (const [k, fileBase] of Object.entries(BLOB_FILE)) writeExclDurable(path.join(intended, fileBase + ".json"), Buffer.from(blobs[k]));
    fsyncDir(intended); // 四件全落盘才 fsync 目录屏障；之后才许进段提交
  } catch (err) {
    return { ok: false, reason: err?.code === "EEXIST" ? "staged_residue" : "io_error", why: "写 staged 文件：" + errCode(err) };
  }
  return { ok: true, reused: false, plan_bytes: planBytes.length, plan_sha256: planSha };
}

/** 删除 staged 私有目录；absent 也算成功（幂等）。失败交调用方（R45：journal 保持 drained + cleanup_pending）。 */
export function removeStagedPlan({ dir, token }) {
  const tokenProblem = tokenShapeProblem(token);
  if (tokenProblem !== null) return { ok: false, why: tokenProblem };
  const staged = path.join(dir, stagedDirFor(token));
  try {
    fs.rmSync(staged, { recursive: true, force: false });
    let dfd = null;
    try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
    catch (err) { if (!dirFsyncIgnorable(err?.code)) throw err; }
    finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
    return { ok: true };
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true };
    return { ok: false, why: errCode(err), path: staged };
  }
}

export { stagedIntendedFile };
