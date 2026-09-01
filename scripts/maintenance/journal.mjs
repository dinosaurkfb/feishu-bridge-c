/**
 * 维护门的 **operation journal**（issue #81 PR C，方案稿"一本账"）。
 *
 *   · 位置：`<真实 home>/.claude/feishu-bridge/maintenance/<token>.json` + `maintenance/active`（symlink → token，同一时间只许一个）。
 *     只有测试隔离点 FEISHU_BRIDGE_MAINTENANCE_DIR 能覆盖目录。
 *   · **执行租约** `<token>.lease`：同一 operation 的 enter / exit / 续跑只许一个执行者（评审探针：等进程期间另一个 --exit 回退并清了 active，
 *     原 enter 醒来仍把 journal 写回 drained）。租约复用 registry 的锁协议，**只按持有者 pid 活性接管，不按时间**（等进程可以很久）；
 *     每次写 journal 都在租约的 reap 段内核对 token（commitWhileHeld）—— 租约被合法接管后晚到的写入 lease_lost，不落盘。
 *   · 每次更新都是**原子 + 持久**：同目录唯一临时名（O_EXCL | O_NOFOLLOW）写满 → fsync → rename → fsync 目录（只忽略"文件系统不支持目录 fsync"，EIO 之类照样失败）。
 *   · 三态读：active / journal 都是 absent（只有 ENOENT）| valid（形状逐字段受验）| unreadable（畸形不自动覆盖、不自动删）。
 *   · **形状按 step kind 封闭**（判别联合）：timer / current / stub / gate / artifact / receipt 各自的 before / intended_after / after 形状、id 形状都逐字段验；
 *     phase 与"必须已 done 的 step 集合"一致（timer_stopped 要两条 timer done，stubbed 要 stub + current 都 done，gated / drained 要 gate done）。
 *   · **每一次外部变更都是两阶段记账**：addStepPrepared（before / backup{sha256, bytes} / intended_after 落盘）→ 做变更 → markStepDone（记实际 after）。
 *     备份先写满 fsync、sha256 与长度进 journal，恢复前核验（对不上 → 该项 incomplete）。
 *   · 阶段封闭：planned → timer_stopped → stubbed → gated → drained → staged → committed → verified → reopening → done | reopening_incomplete；
 *     失败分支 rolling_back → rollback_reopening → rolled_back | rollback_incomplete。reopening / rollback_reopening 之后**不可逆**。
 *   · 终态先持久化，`active` 最后 token-CAS 清；"门已删、operation 未终结"的窗口里 --status 仍看得见。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { realUserHome } from "../maintenance-gate-core.mjs";
import { readRegularFile } from "../installed-surface.mjs";
import { acquireLockUngated, commitWhileHeld, releasePublishLock } from "../registry.mjs";

export const MAINTENANCE_DIR_ENV = "FEISHU_BRIDGE_MAINTENANCE_DIR";
export const JOURNAL_SCHEMA = "1.1";
export const PHASES = Object.freeze([
  "planned", "timer_stopped", "stubbed", "gated", "drained", "staged", "committed", "verified", "reopening", "done", "reopening_incomplete",
  "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete",
]);
export const TERMINAL_PHASES = Object.freeze(["done", "rolled_back"]);
/** 没做完的终态：门与账保留，--exit --apply 只向前重试。 */
export const INCOMPLETE_PHASES = Object.freeze(["reopening_incomplete", "rollback_incomplete"]);
/** 进了这些阶段只许向前（某条 current 已从桩指回真实 runtime，那条链已重新放行，不许再改线上制品）。 */
export const FORWARD_ONLY_PHASES = Object.freeze(["reopening", "rollback_reopening", ...TERMINAL_PHASES, ...INCOMPLETE_PHASES]);
export const STEP_KINDS = Object.freeze(["timer", "stub", "current", "gate", "artifact", "receipt"]);
export const TIMER_PHASES = Object.freeze(["loaded", "installed_not_loaded", "absent"]);
/** 走到某阶段时必须已 done 的 step。install 步（PR C 第 2 步）：commit 之后要求两条 current:<chain>:install 与两条收据。 */
const ENTER_DONE = Object.freeze(["timer:claude", "timer:codex", "stub:claude", "stub:codex", "current:claude", "current:codex", "gate"]);
const INSTALL_DONE = Object.freeze([...ENTER_DONE, "current:claude:install", "current:codex:install", "receipt:claude", "receipt:codex"]);
export const PHASE_REQUIRES = Object.freeze({
  timer_stopped: ["timer:claude", "timer:codex"],
  stubbed: ["timer:claude", "timer:codex", "stub:claude", "stub:codex", "current:claude", "current:codex"],
  gated: ENTER_DONE,
  drained: ENTER_DONE,
  staged: ENTER_DONE,
  committed: INSTALL_DONE,
  verified: INSTALL_DONE,
  reopening: INSTALL_DONE,
  done: INSTALL_DONE,
  reopening_incomplete: INSTALL_DONE,
});
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
/** current 只许指两种受控形状：正式版本 versions/<16 hex> 或维护桩 versions/maintenance-<uuid>（没有 . / .. / 多段的归一化歧义）。 */
const REL_TARGET = /^versions\/([0-9a-f]{16}|maintenance-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const errCode = (err) => String(err?.code ?? err?.message ?? err);

export function maintenanceDir(env = process.env) {
  const override = env[MAINTENANCE_DIR_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  const home = realUserHome();
  return home === null ? null : path.join(home, ".claude", "feishu-bridge", "maintenance");
}
export const journalPath = (dir, token) => path.join(dir, token + ".json");
export const activePath = (dir) => path.join(dir, "active");
export const leasePath = (dir, token) => path.join(dir, token + ".lease");

// ── 形状：按 kind 封闭的判别联合 ─────────────────────────────────────────────
const CHAIN_ID = /^(claude|codex)$/u;
function timerState(x) { return isObj(x) && keysOf(x) === "phase" && TIMER_PHASES.includes(x.phase); }
function shapeProblemFor(s) {
  const [kind, rest] = [s.kind, s.id.slice(s.kind.length + 1)];
  const idOk = s.id.startsWith(kind + ":") || s.id === kind;
  if (kind === "timer") {
    if (!idOk || !CHAIN_ID.test(rest)) return "timer 的 id 必须是 timer:<chain>";
    if (!(isObj(s.before) && keysOf(s.before) === "phase,plist" && TIMER_PHASES.includes(s.before.phase) && typeof s.before.plist === "string" && path.isAbsolute(s.before.plist))) return "timer.before 形状不对";
    if (!timerState(s.intended_after)) return "timer.intended_after 形状不对";
    if (!(s.after === null || timerState(s.after))) return "timer.after 形状不对";
    if (isObj(s.before) && s.before.phase === "loaded" && s.backup === null) return "timer 原来 loaded 必须有 plist 备份";
    return null;
  }
  if (kind === "current") {
    // enter 步 current:<chain>（原目标 → 桩）；install 步 current:<chain>:install（桩 → versions/<v>，PR C 第 2 步的 commit）
    if (!idOk || !/^(claude|codex)(:install)?$/u.test(rest)) return "current 的 id 必须是 current:<chain> 或 current:<chain>:install";
    if (!(s.before === null || (typeof s.before === "string" && REL_TARGET.test(s.before)))) return "current.before 不是 null 或 versions/<x>";
    if (!(typeof s.intended_after === "string" && REL_TARGET.test(s.intended_after))) return "current.intended_after 不是 versions/<x>";
    if (!(s.after === null || (typeof s.after === "string" && REL_TARGET.test(s.after)))) return "current.after 形状不对";
    if (s.backup !== null) return "current 不该有备份";
    return null;
  }
  if (kind === "stub") {
    if (!idOk || !CHAIN_ID.test(rest)) return "stub 的 id 必须是 stub:<chain>";
    if (s.before !== null) return "stub.before 必须是 null";
    if (!(typeof s.intended_after === "string" && /^versions\/maintenance-[0-9a-f-]{36}$/u.test(s.intended_after))) return "stub.intended_after 不是桩目标";
    if (!(s.after === null || s.after === s.intended_after)) return "stub.after 形状不对";
    if (s.backup !== null) return "stub 不该有备份";
    return null;
  }
  if (kind === "gate") {
    if (s.id !== "gate") return "gate 的 id 必须是 gate";
    if (s.before !== null) return "gate.before 必须是 null";
    const isUuid = (x) => typeof x === "string" && UUID_SHAPE.test(x);
    if (!(isObj(s.intended_after) && keysOf(s.intended_after) === "token" && isUuid(s.intended_after.token))) return "gate.intended_after 形状不对";
    const txnOk = (x) => x === null || (isObj(x) && keysOf(x) === "path,why" && typeof x.path === "string" && path.isAbsolute(x.path) && typeof x.why === "string");
    if (!(s.after === null || (isObj(s.after) && keysOf(s.after) === "token,txnUncleared" && isUuid(s.after.token) && txnOk(s.after.txnUncleared)))) return "gate.after 形状不对";
    if (s.backup !== null) return "gate 不该有备份";
    return null;
  }
  // {exists, sha256}：存在必须有 sha，不存在必须 sha 为 null
  const fileState = (x) => isObj(x) && keysOf(x) === "exists,sha256" && typeof x.exists === "boolean" && (x.exists ? (typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256)) : x.sha256 === null);
  if (kind === "artifact" || kind === "receipt") {
    if (kind === "artifact" && (!idOk || !path.isAbsolute(rest))) return "artifact 的 id 必须是 artifact:<绝对路径>";
    if (kind === "receipt" && (!idOk || !CHAIN_ID.test(rest))) return "receipt 的 id 必须是 receipt:<chain>";
    if (!fileState(s.before) || !fileState(s.intended_after) || !(s.after === null || fileState(s.after))) return kind + " 的 before / intended_after / after 形状不对";
    if (s.before.exists && s.backup === null) return kind + " 原来存在必须有备份";
    if (!s.before.exists && s.backup !== null) return kind + " 原来不存在不该有备份";
    return null;
  }
  return "kind 不在受控集合里";
}
function stepProblem(s) {
  if (!isObj(s)) return "step 不是对象";
  if (keysOf(s) !== "after,at,backup,backup_bytes,backup_sha256,before,id,intended_after,kind,state,target") return "step 字段集不对";
  if (typeof s.id !== "string" || s.id.length === 0) return "step id 不是字符串";
  if (!STEP_KINDS.includes(s.kind)) return "step kind 不在受控集合里";
  if (typeof s.target !== "string" || s.target.length === 0) return "step target 不是字符串";
  if (!(s.backup === null || (typeof s.backup === "string" && path.isAbsolute(s.backup)))) return "step backup 不是 null 或绝对路径";
  if (s.backup === null ? (s.backup_sha256 !== null || s.backup_bytes !== null) : !(typeof s.backup_sha256 === "string" && SHA_SHAPE.test(s.backup_sha256) && Number.isSafeInteger(s.backup_bytes) && s.backup_bytes >= 0)) return "备份的 sha256 / 长度与 backup 不一致";
  if (!(s.state === "prepared" || s.state === "done")) return "step state 不是 prepared / done";
  if (s.state === "prepared" && s.after !== null) return "prepared 的 step 不该有 after";
  if (s.state === "done" && s.after === null) return "done 的 step 必须有 after";
  if (!isCanonicalIso(s.at)) return "step at 不是规范化 ISO 时间";
  return shapeProblemFor(s);
}
export function journalProblem(doc) {
  if (!isObj(doc)) return "不是对象";
  if (doc.schema_version !== JOURNAL_SCHEMA) return "schema_version 不认识";
  if (keysOf(doc) !== "notes,phase,reason,schema_version,started_at,steps,token,updated_at") return "字段集不对";
  if (typeof doc.token !== "string" || !UUID_SHAPE.test(doc.token)) return "token 不是 UUID 字符串";
  if (typeof doc.reason !== "string" || [...doc.reason].length > 80) return "reason 不是 ≤ 80 码点的字符串";
  if (!isCanonicalIso(doc.started_at) || !isCanonicalIso(doc.updated_at)) return "时间不是规范化 ISO";
  if (!PHASES.includes(doc.phase)) return "phase 不在封闭集合里：" + String(doc.phase);
  if (!Array.isArray(doc.steps)) return "steps 不是数组";
  const ids = new Set();
  for (const s of doc.steps) { const p = stepProblem(s); if (p !== null) return p; if (ids.has(s.id)) return "step id 重复：" + s.id; ids.add(s.id); }
  for (const s of doc.steps) if ((s.kind === "stub" || s.kind === "gate") && s.state === "done") {
    if (s.kind === "gate" && s.after.token !== doc.token) return "gate 的 token 与 operation 不一致";
    if (s.kind === "stub" && !s.intended_after.endsWith("maintenance-" + doc.token)) return "桩目标与 operation token 不一致";
  }
  const required = PHASE_REQUIRES[doc.phase];
  if (required) for (const id of required) { const s = doc.steps.find((x) => x.id === id); if (!s || s.state !== "done") return "阶段 " + doc.phase + " 要求 " + id + " 已 done"; }
  if (!Array.isArray(doc.notes) || doc.notes.some((n) => typeof n !== "string")) return "notes 不是字符串数组";
  return null;
}

// ── 读 ───────────────────────────────────────────────────────────────────────
/** active 三态：只有 ENOENT 是 absent；不是 symlink / 目标不是 UUID → unreadable。 */
export function readActive({ dir } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { state: "unreadable", why: "维护目录说不清（真实用户 home 取不到）" };
  const file = activePath(dir);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: "lstat 失败：" + errCode(err) }; }
  if (!st.isSymbolicLink()) return { state: "unreadable", why: "active 位置上不是 symlink" };
  let token;
  try { token = fs.readlinkSync(file); } catch (err) { return { state: "unreadable", why: "readlink 失败：" + errCode(err) }; }
  if (!UUID_SHAPE.test(token)) return { state: "unreadable", why: "active 指向的不是 token" };
  return { state: "active", token };
}
/** journal 三态（fd 绑定读）。 */
export function readJournal({ dir, token } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { state: "unreadable", why: "维护目录说不清" };
  if (typeof token !== "string" || !UUID_SHAPE.test(token)) return { state: "unreadable", why: "token 形状不对" };
  const r = readRegularFile(journalPath(dir, token));
  if (r.status === "absent") return { state: "absent" };
  if (r.status !== "read") return { state: "unreadable", why: r.why };
  let doc;
  try { doc = JSON.parse(r.buf.toString("utf-8")); } catch (err) { return { state: "unreadable", why: "不是 JSON：" + errCode(err) }; }
  const problem = journalProblem(doc);
  return problem === null ? { state: "valid", doc } : { state: "unreadable", why: "形状不对：" + problem };
}

// ── 写 ───────────────────────────────────────────────────────────────────────
/** 目录 fsync 只有"文件系统不支持"才能忽略（EINVAL / ENOTSUP / EOPNOTSUPP）；EIO 之类必须失败。 */
export const dirFsyncIgnorable = (code) => code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
/** 原子 + 持久写：tmp（O_EXCL | O_NOFOLLOW）写满 → fsync → rename → fsync 目录。抛错交调用方。 */
export function writeDurable(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, ".journal." + process.pid + "." + crypto.randomUUID() + ".tmp");
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } catch (err) { try { fs.closeSync(fd); } catch { /* 已关 */ } try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, file); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
  let dfd = null;
  try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
  catch (err) { if (!dirFsyncIgnorable(err?.code)) throw err; }
  finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
}
/** 写备份：写满 fsync，返回 { sha256, bytes }；恢复前用 verifyBackup 核。 */
export function writeBackup(file, bytes) {
  writeDurable(file, bytes);
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
export function verifyBackup({ file, sha256, bytes }) {
  const r = readRegularFile(file);
  if (r.status !== "read") return { ok: false, why: r.status === "absent" ? "备份不在" : r.why };
  if (r.buf.length !== bytes) return { ok: false, why: "备份长度不对（" + r.buf.length + " ≠ " + bytes + "）" };
  const actual = crypto.createHash("sha256").update(r.buf).digest("hex");
  return actual === sha256 ? { ok: true, buf: r.buf } : { ok: false, why: "备份 sha256 不对" };
}

// ── 执行租约 ─────────────────────────────────────────────────────────────────
/**
 * 拿这个 operation 的执行租约：registry 锁协议，staleMs = ∞（只按持有者 pid 活性接管，等进程可以很久），未知形状不回收。
 * 拿不到 → { ok:false, reason:"operation_in_progress"（活着的执行者）| "lease_residue" | ... }。
 */
export function acquireOperationLease({ dir, token }) {
  const file = leasePath(dir, token);
  let r;
  try { r = acquireLockUngated(file, { staleMs: Number.POSITIVE_INFINITY, reapUnrecognized: false }); }
  catch (err) { return { ok: false, reason: "io_error", why: "租约原语抛错：" + errCode(err), path: file }; }
  if (r.ok) return { ok: true, path: file, token: r.token };
  if (r.reason === "publisher_busy" || r.reason === "reap_busy") return { ok: false, reason: "operation_in_progress", path: file, why: "另一个执行者正持有这个 operation 的租约" };
  return { ok: false, reason: r.reason === "lock_residue" || r.reason === "reap_residue" || r.reason === "reap_uncleared" || r.reason === "reaped_uncleared" ? "lease_residue" : "io_error", path: r.path ?? file, why: String(r.reason) + (r.error ? "：" + r.error : "") };
}
export function releaseOperationLease(lease) {
  if (!lease?.path) return { ok: true, absent: true };
  try {
    const r = releasePublishLock(lease.path);
    // 归属转换锁 .reap 交不还：主租约可能已删，但 .reap 残骸会让后续续跑一律 reap_residue —— 不是成功，点名真实路径
    if (r.reapUncleared) return { ok: false, why: "reap_uncleared：" + String(r.reapUncleared.error ?? ""), path: r.reapUncleared.path };
    return r.ok || r.reason === "not_owner" ? { ok: true } : { ok: false, why: String(r.reason), path: lease.path };
  } catch (err) { return { ok: false, why: "release_threw：" + errCode(err), path: lease.path }; }
}

/**
 * 开一次 operation：先拿租约 → journal（planned）落盘 → O_EXCL 建 active。active 在 / 读不出 → 拒绝；两个人同时开只有一个赢。
 * 返回 { ok, token, lease, doc }；调用方持有 lease 到 enter 结束，最后 releaseOperationLease。
 */
export function createOperation({ dir, reason, token = crypto.randomUUID(), now = Date.now() } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { ok: false, reason: "maintenance_dir_unknown", why: "真实用户 home 取不到" };
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) { return { ok: false, reason: "io_error", why: errCode(err) }; }
  const active = readActive({ dir });
  if (active.state === "active") return { ok: false, reason: "operation_active", token: active.token };
  if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why, path: activePath(dir) };
  const lease = acquireOperationLease({ dir, token });
  if (!lease.ok) return { ok: false, reason: lease.reason, why: lease.why, path: lease.path };
  const at = new Date(now).toISOString();
  const doc = { schema_version: JOURNAL_SCHEMA, token, reason, started_at: at, updated_at: at, phase: "planned", steps: [], notes: [] };
  const problem = journalProblem(doc);
  if (problem !== null) { releaseOperationLease(lease); return { ok: false, reason: "journal_shape", why: problem }; }
  try { writeDurable(journalPath(dir, token), JSON.stringify(doc, null, 2) + "\n"); } catch (err) { releaseOperationLease(lease); return { ok: false, reason: "io_error", why: "写 journal：" + errCode(err) }; }
  try { fs.symlinkSync(token, activePath(dir)); }
  catch (err) {
    releaseOperationLease(lease);
    if (err?.code === "EEXIST") { const again = readActive({ dir }); return { ok: false, reason: "operation_active", token: again.token ?? null, why: again.why }; }
    return { ok: false, reason: "io_error", why: "建 active：" + errCode(err) };
  }
  return { ok: true, token, lease, doc };
}

/**
 * 读 → 核 active 仍是本 token → 核阶段前驱（expectPhase）→ mutate（拿到深拷贝）→ 验形状 → 在租约 reap 段内核对 token 后原子持久写。
 * 没有租约 / 租约丢了 → 不写（lease_required / lease_lost）。
 */
export function updateJournal({ dir, token, lease, expectPhase = null, mutate, now = Date.now() } = {}) {
  if (!lease?.path) return { ok: false, reason: "lease_required" };
  const active = readActive({ dir });
  if (active.state !== "active" || active.token !== token) return { ok: false, reason: "active_mismatch", why: active.state === "active" ? "active 指向别的 operation：" + active.token : "active " + active.state + (active.why ? "（" + active.why + "）" : "") };
  const r = readJournal({ dir, token });
  if (r.state !== "valid") return { ok: false, reason: r.state === "absent" ? "journal_absent" : "journal_unreadable", why: r.why };
  if (expectPhase !== null && !(Array.isArray(expectPhase) ? expectPhase : [expectPhase]).includes(r.doc.phase)) return { ok: false, reason: "phase_mismatch", why: "现在是 " + r.doc.phase + "，不是预期的 " + String(expectPhase) };
  const next = mutate(structuredClone(r.doc)) ?? null;
  if (next === null) return { ok: false, reason: "mutate_returned_nothing" };
  next.updated_at = new Date(now).toISOString();
  const problem = journalProblem(next);
  if (problem !== null) return { ok: false, reason: "journal_shape", why: problem };
  const c = commitWhileHeld(lease.path, () => { try { writeDurable(journalPath(dir, token), JSON.stringify(next, null, 2) + "\n"); return null; } catch (err) { return errCode(err); } });
  if (!c.ok) return { ok: false, reason: c.reason === "lock_lost" ? "lease_lost" : "io_error", why: "租约核对：" + String(c.reason) };
  if (c.run !== null) return { ok: false, reason: "io_error", why: c.run };
  // 写已落盘，但租约的归属转换锁交不还：之后的每次写都会 reap_residue —— 立即停，不许再做外部变更（调用方保留 active / journal，退出码 3）
  if (c.reapUncleared) return { ok: false, reason: "lease_reap_uncleared", why: String(c.reapUncleared.error ?? ""), path: c.reapUncleared.path, written: true, doc: next };
  return { ok: true, doc: next };
}

export const setPhase = ({ dir, token, lease, phase, expectPhase = null, note = null, now }) => updateJournal({ dir, token, lease, expectPhase, now, mutate: (d) => { d.phase = phase; if (note !== null) d.notes.push(note); return d; } });
export const addNote = ({ dir, token, lease, note, now }) => updateJournal({ dir, token, lease, now, mutate: (d) => { d.notes.push(note); return d; } });
/** 两阶段第一步：把 before / backup{sha256,bytes} / intended_after 落盘之后才允许做外部变更。 */
export const addStepPrepared = ({ dir, token, lease, step, now = Date.now() }) => updateJournal({ dir, token, lease, now, mutate: (d) => {
  if (d.steps.some((s) => s.id === step.id)) return null;
  d.steps.push({ id: step.id, kind: step.kind, target: step.target, before: step.before ?? null, backup: step.backup ?? null, backup_sha256: step.backup_sha256 ?? null, backup_bytes: step.backup_bytes ?? null, intended_after: step.intended_after ?? null, state: "prepared", after: null, at: new Date(now).toISOString() });
  return d;
} });
/** 两阶段第二步：记实际 after。 */
export const markStepDone = ({ dir, token, lease, id, after, now = Date.now() }) => updateJournal({ dir, token, lease, now, mutate: (d) => {
  const s = d.steps.find((x) => x.id === id);
  if (!s) return null;
  s.state = "done"; s.after = after; s.at = new Date(now).toISOString();
  return d;
} });

/** 清 active：token-CAS。绝不清别人的；unreadable 不动。 */
export function clearActive({ dir, token } = {}) {
  const a = readActive({ dir });
  if (a.state === "absent") return { ok: true, cleared: false, reason: "absent" };
  if (a.state === "unreadable") return { ok: false, cleared: false, reason: "active_unreadable", why: a.why };
  if (a.token !== token) return { ok: false, cleared: false, reason: "not_owner", token: a.token };
  try { fs.unlinkSync(activePath(dir)); } catch (err) { return err?.code === "ENOENT" ? { ok: true, cleared: false, reason: "absent" } : { ok: false, cleared: false, reason: "io_error", why: errCode(err) }; }
  return { ok: true, cleared: true, reason: null };
}

/** 目录里的全部 journal（只按封闭名字 <uuid>.json 认）。 */
export function listJournals({ dir } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { return { ok: err?.code === "ENOENT", tokens: [], why: err?.code === "ENOENT" ? null : errCode(err) }; }
  return { ok: true, tokens: names.filter((n) => /^[0-9a-f-]{36}\.json$/u.test(n) && UUID_SHAPE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort() };
}

/**
 * 维护目录盘点（只读，给 --status / doctor）：孤立 journal（active 没指向它 —— 例如两个 enter 竞争 active 的输家）、非 active 的租约与租约锁家族残骸、
 * 写 journal 的临时文件、非 active 的 plist 备份。只报告，不清理（能证明是输家的才该按受控协议清，这里不猜）。
 */
export function inspectMaintenanceDir({ dir } = {}) {
  const residues = [];
  if (typeof dir !== "string" || dir.length === 0) return { inventory: "unknown", residues };
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return err?.code === "ENOENT" ? { inventory: "ok", residues } : { inventory: "unreadable", residues: [{ path: dir, kind: "inventory", detail: "目录读不出：" + errCode(err) }] }; }
  const active = readActive({ dir });
  const activeToken = active.state === "active" ? active.token : null;
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    if (n === "active") continue;
    let m;
    if ((m = /^([0-9a-f-]{36})\.json$/u.exec(n)) && UUID_SHAPE.test(m[1])) { if (m[1] !== activeToken) { const j = readJournal({ dir, token: m[1] }); residues.push({ path: full, kind: "orphan_journal", detail: j.state === "valid" ? "没有 active 指向的 journal（阶段 " + j.doc.phase + "，" + j.doc.started_at + "）—— 竞争输家或已终结未清理，只人工处置" : "没有 active 指向且读不出的 journal（" + String(j.why) + "）—— 只人工处置" }); } continue; }
    if ((m = /^([0-9a-f-]{36})\.lease$/u.exec(n)) && UUID_SHAPE.test(m[1])) { const h = leaseHolder({ dir, token: m[1] }); if (m[1] !== activeToken) residues.push({ path: full, kind: "stale_lease", detail: "非 active operation 的租约" + (h.alive ? "（持有者 pid " + h.pid + " 仍在）" : "（持有者已不在）") + " —— 只人工处置" }); else if (h.present && !h.unreadable && !h.alive) residues.push({ path: full, kind: "dead_lease", detail: "active operation 的租约持有者 pid " + h.pid + " 已不在 —— 下一个执行者会接管" }); continue; }
    if (/^[0-9a-f-]{36}\.lease\.(reap|maint)$/u.test(n) || /^[0-9a-f-]{36}\.lease\.reaped-/u.test(n) || /^[0-9a-f-]{36}\.lease\.reap\.quarantine-/u.test(n)) { residues.push({ path: full, kind: "lease_lock_residue", detail: "租约锁家族残骸 —— node scripts/repair-publish-lock.mjs --lock " + path.join(dir, n.split(".lease")[0] + ".lease") + " 能清（.reap / 隔离），其余只人工处置" }); continue; }
    if (/^\.journal\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(n)) { residues.push({ path: full, kind: "tmp", detail: "写 journal 的临时文件残骸 —— 人工删即可" }); continue; }
    if ((m = /^([0-9a-f-]{36})\.(claude|codex)\.plist$/u.exec(n)) && UUID_SHAPE.test(m[1])) { if (m[1] !== activeToken) residues.push({ path: full, kind: "stale_backup", detail: "非 active operation 的 plist 备份 —— 只人工处置" }); continue; }
    if ((m = /^([0-9a-f-]{36})\.staged$/u.exec(n)) && UUID_SHAPE.test(m[1])) { if (m[1] !== activeToken) residues.push({ path: full, kind: "stale_staged", detail: "非 active operation 的 staged 目录（目标制品与备份）—— 只人工处置" }); continue; }
    residues.push({ path: full, kind: "unknown", detail: "维护目录里不认识的文件 —— 只人工处置" });
  }
  return { inventory: "ok", residues };
}

/** 租约持有者（只读，给 --status）：{ present, pid, alive } */
export function leaseHolder({ dir, token }) {
  const file = leasePath(dir, token);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return err?.code === "ENOENT" ? { present: false } : { present: true, unreadable: true, why: errCode(err) }; }
  if (!st.isSymbolicLink()) return { present: true, unreadable: true, why: "不是 symlink" };
  let owner = null;
  try { owner = JSON.parse(fs.readlinkSync(file)); } catch { owner = null; }
  if (!owner || !Number.isSafeInteger(owner.pid)) return { present: true, unreadable: true, why: "payload 畸形" };
  let alive = true;
  try { process.kill(owner.pid, 0); } catch { alive = false; }
  return { present: true, pid: owner.pid, alive, at: owner.at ?? null };
}
