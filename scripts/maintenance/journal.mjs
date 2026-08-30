/**
 * 维护门的 **operation journal**（issue #81 PR C，方案稿"一本账"）。
 *
 *   · 位置：`<真实 home>/.claude/feishu-bridge/maintenance/<token>.json` + `maintenance/active`（symlink → token，同一时间只许一个）。
 *     只有测试隔离点 FEISHU_BRIDGE_MAINTENANCE_DIR 能覆盖目录。
 *   · 每次更新都是**原子 + 持久**：同目录唯一临时名（O_EXCL | O_NOFOLLOW）写满 → fsync → rename → fsync 目录。
 *   · 三态读：active / journal 都是 absent（只有 ENOENT）| valid（形状逐字段受验）| unreadable（畸形不自动覆盖、不自动删）。
 *   · **每一次外部变更都是两阶段记账**：先 addStepPrepared（before / backup / intended_after 落盘）→ 做变更 → markStepDone（记实际 after）。
 *     恢复只看 journal 里的 prepared / done 与现场（见 operation.mjs 的恢复规则）。
 *   · 阶段封闭：planned → timer_stopped → stubbed → gated → drained → staged → committed → verified → reopening → done；
 *     失败分支 rolling_back → rollback_reopening → rolled_back | rollback_incomplete。reopening / rollback_reopening 之后**不可逆**。
 *   · 终态先持久化，`active` 最后 token-CAS 清；"门已删、operation 未终结"的窗口里 --status 仍看得见。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { realUserHome } from "../maintenance-gate-core.mjs";
import { readRegularFile } from "../installed-surface.mjs";

export const MAINTENANCE_DIR_ENV = "FEISHU_BRIDGE_MAINTENANCE_DIR";
export const JOURNAL_SCHEMA = "1.0";
export const PHASES = Object.freeze([
  "planned", "timer_stopped", "stubbed", "gated", "drained", "staged", "committed", "verified", "reopening", "done",
  "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete",
]);
export const TERMINAL_PHASES = Object.freeze(["done", "rolled_back", "rollback_incomplete"]);
/** 进了这些阶段只许向前（某条 current 已从桩指回真实 runtime，那条链已重新放行，不许再改线上制品）。 */
export const FORWARD_ONLY_PHASES = Object.freeze(["reopening", "rollback_reopening", ...TERMINAL_PHASES]);
export const STEP_KINDS = Object.freeze(["timer", "stub", "current", "gate", "artifact", "receipt"]);
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const errCode = (err) => String(err?.code ?? err?.message ?? err);

export function maintenanceDir(env = process.env) {
  const override = env[MAINTENANCE_DIR_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  const home = realUserHome();
  return home === null ? null : path.join(home, ".claude", "feishu-bridge", "maintenance");
}
export const journalPath = (dir, token) => path.join(dir, token + ".json");
export const activePath = (dir) => path.join(dir, "active");

function stepProblem(s) {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return "step 不是对象";
  if (Object.keys(s).sort().join(",") !== "after,at,backup,before,id,intended_after,kind,state,target") return "step 字段集不对";
  if (typeof s.id !== "string" || s.id.length === 0) return "step id 不是字符串";
  if (!STEP_KINDS.includes(s.kind)) return "step kind 不在受控集合里";
  if (typeof s.target !== "string" || s.target.length === 0) return "step target 不是字符串";
  if (!(s.backup === null || (typeof s.backup === "string" && path.isAbsolute(s.backup)))) return "step backup 不是 null 或绝对路径";
  if (!(s.state === "prepared" || s.state === "done")) return "step state 不是 prepared / done";
  if (s.state === "prepared" && s.after !== null) return "prepared 的 step 不该有 after";
  if (!isCanonicalIso(s.at)) return "step at 不是规范化 ISO 时间";
  return null;
}
export function journalProblem(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是对象";
  if (doc.schema_version !== JOURNAL_SCHEMA) return "schema_version 不认识";
  if (Object.keys(doc).sort().join(",") !== "notes,phase,reason,schema_version,started_at,steps,token,updated_at") return "字段集不对";
  if (typeof doc.token !== "string" || !UUID_SHAPE.test(doc.token)) return "token 不是 UUID";
  if (typeof doc.reason !== "string" || [...doc.reason].length > 80) return "reason 不是 ≤ 80 码点的字符串";
  if (!isCanonicalIso(doc.started_at) || !isCanonicalIso(doc.updated_at)) return "时间不是规范化 ISO";
  if (!PHASES.includes(doc.phase)) return "phase 不在封闭集合里：" + String(doc.phase);
  if (!Array.isArray(doc.steps)) return "steps 不是数组";
  const ids = new Set();
  for (const s of doc.steps) { const p = stepProblem(s); if (p !== null) return p; if (ids.has(s.id)) return "step id 重复：" + s.id; ids.add(s.id); }
  if (!Array.isArray(doc.notes) || doc.notes.some((n) => typeof n !== "string")) return "notes 不是字符串数组";
  return null;
}

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

/** 原子 + 持久写：tmp（O_EXCL | O_NOFOLLOW）写满 → fsync → rename → fsync 目录。抛错交调用方。 */
export function writeDurable(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, ".journal." + process.pid + "." + crypto.randomUUID() + ".tmp");
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
  let dfd = null;
  try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); } catch { /* 目录 fsync 不可用的文件系统：rename 本身已原子 */ } finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
}

/**
 * 开一次 operation：journal（planned）先落盘，再以 O_EXCL 语义建 active（symlink）。
 * active 在 / 读不出 → 拒绝（operation_active / active_unreadable），人工处置；两个人同时开 → 只有一个赢。
 */
export function createOperation({ dir, reason, token = crypto.randomUUID(), now = Date.now() } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { ok: false, reason: "maintenance_dir_unknown", why: "真实用户 home 取不到" };
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) { return { ok: false, reason: "io_error", why: errCode(err) }; }
  const active = readActive({ dir });
  if (active.state === "active") return { ok: false, reason: "operation_active", token: active.token };
  if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why, path: activePath(dir) };
  const at = new Date(now).toISOString();
  const doc = { schema_version: JOURNAL_SCHEMA, token, reason, started_at: at, updated_at: at, phase: "planned", steps: [], notes: [] };
  const problem = journalProblem(doc);
  if (problem !== null) return { ok: false, reason: "journal_shape", why: problem };
  try { writeDurable(journalPath(dir, token), JSON.stringify(doc, null, 2) + "\n"); } catch (err) { return { ok: false, reason: "io_error", why: "写 journal：" + errCode(err) }; }
  try { fs.symlinkSync(token, activePath(dir)); }
  catch (err) {
    if (err?.code === "EEXIST") { const again = readActive({ dir }); return { ok: false, reason: "operation_active", token: again.token ?? null, why: again.why }; }
    return { ok: false, reason: "io_error", why: "建 active：" + errCode(err) };
  }
  return { ok: true, token, doc };
}

/** 读 → mutate（拿到深拷贝）→ 验形状 → 原子持久写。journal 不合法就不写。 */
export function updateJournal({ dir, token, mutate, now = Date.now() } = {}) {
  const r = readJournal({ dir, token });
  if (r.state !== "valid") return { ok: false, reason: r.state === "absent" ? "journal_absent" : "journal_unreadable", why: r.why };
  const next = mutate(structuredClone(r.doc)) ?? null;
  if (next === null) return { ok: false, reason: "mutate_returned_nothing" };
  next.updated_at = new Date(now).toISOString();
  const problem = journalProblem(next);
  if (problem !== null) return { ok: false, reason: "journal_shape", why: problem };
  try { writeDurable(journalPath(dir, token), JSON.stringify(next, null, 2) + "\n"); } catch (err) { return { ok: false, reason: "io_error", why: errCode(err) }; }
  return { ok: true, doc: next };
}

export const setPhase = ({ dir, token, phase, note = null, now }) => updateJournal({ dir, token, now, mutate: (d) => { d.phase = phase; if (note !== null) d.notes.push(note); return d; } });
export const addNote = ({ dir, token, note, now }) => updateJournal({ dir, token, now, mutate: (d) => { d.notes.push(note); return d; } });
/** 两阶段第一步：把 before / backup / intended_after 落盘之后才允许做外部变更。 */
export const addStepPrepared = ({ dir, token, step, now = Date.now() }) => updateJournal({ dir, token, now, mutate: (d) => {
  if (d.steps.some((s) => s.id === step.id)) return null;
  d.steps.push({ id: step.id, kind: step.kind, target: step.target, before: step.before ?? null, backup: step.backup ?? null, intended_after: step.intended_after ?? null, state: "prepared", after: null, at: new Date(now).toISOString() });
  return d;
} });
/** 两阶段第二步：记实际 after。 */
export const markStepDone = ({ dir, token, id, after = null, now = Date.now() }) => updateJournal({ dir, token, now, mutate: (d) => {
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
