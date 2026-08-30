/**
 * 维护门 · 机器级门文件（issue #81，方案稿 docs/architecture/maintenance-gate.md 第 2 层）—— **共用层**，两条链都从这里看门。
 *
 *   · 路径由**真实用户 home** 推导（`os.userInfo().homedir`，不是会话可覆盖的 $HOME / CODEX_HOME）：
 *     `<真实 home>/.claude/feishu-bridge/maintenance.gate`；只有测试隔离点 FEISHU_BRIDGE_MAINTENANCE_GATE 能覆盖。
 *   · 门是一个 **symlink**（与发布锁同一原语），链接目标 = { schema_version, pid, at, token, reason } 的 JSON。
 *   · **三态读取契约**：absent = **只有** ENOENT；active = symlink 且 payload 每个字段受验；其余任何形状
 *     （目录、普通文件冒充、畸形 payload、EACCES / EIO …）= unreadable。**写入口对 unreadable 与 active 同样拒**，
 *     不折成"没门"；畸形制品不自动覆盖、不自动删，只人工处置。
 *   · 这一层只对含门代码的 runtime 生效；对不含门代码的旧 runtime，挡的是第 1 层（切桩），见方案稿。
 *
 * 入口怎么用：写入口在 main 最前面 `const g = gateBlocks(); if (g.blocked) exitForGate(kind, g)`；
 * 锁原语 acquirePublishLock 也看门作兜底（reason "maintenance"）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCanonicalIso } from "./canonical-time.mjs";
import { displaySafe } from "./display-safe.mjs";

export const MAINTENANCE_GATE_ENV = "FEISHU_BRIDGE_MAINTENANCE_GATE";
export const GATE_SCHEMA_VERSION = "1.0";
export const GATE_REASON_MAX_CODEPOINTS = 80;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GATE_KEYS = ["at", "pid", "reason", "schema_version", "token"].join(",");

/**
 * 真实用户 home：passwd 里的那一份，不跟会话 HOME 走。**取不到就是 null**（不退回 os.homedir()：
 * 那会把"权威门路径说不清"折成"去会话 HOME 读门"—— fail-open；说不清要投影成 unreadable 并阻断）。
 */
export function realUserHome() {
  try { const h = os.userInfo().homedir; if (typeof h === "string" && path.isAbsolute(h)) return h; } catch { /* 说不清 */ }
  return null;
}

/** 门的路径：测试隔离点优先，否则真实 home 下的固定位置；真实 home 说不清 → null（readGate 报 unreadable）。 */
export function maintenanceGatePath(env = process.env) {
  const override = env[MAINTENANCE_GATE_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  const home = realUserHome();
  return home === null ? null : path.join(home, ".claude", "feishu-bridge", "maintenance.gate");
}

/** reason 的受控形状：displaySafe 后按码点截到上限（含省略号一共不超过 GATE_REASON_MAX_CODEPOINTS；存进门里的就是这份）。 */
export function normalizeGateReason(reason) {
  const cps = Array.from(displaySafe(String(reason ?? "").trim()));
  const cut = cps.length > GATE_REASON_MAX_CODEPOINTS ? cps.slice(0, GATE_REASON_MAX_CODEPOINTS - 1).join("") + "…" : cps.join("");
  return cut.length > 0 ? cut : "未说明";
}

/** 门 payload 的封闭形状：键集恰好、token 是 UUID、pid 正整数、at 规范时间、reason 非空且不超上限。 */
export function gatePayloadProblem(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是对象";
  if (doc.schema_version !== GATE_SCHEMA_VERSION) return "schema_version 不认识";
  if (Object.keys(doc).sort().join(",") !== GATE_KEYS) return "字段集不对";
  if (typeof doc.token !== "string" || !UUID_SHAPE.test(doc.token)) return "token 形状不对";
  if (!Number.isSafeInteger(doc.pid) || doc.pid <= 0) return "pid 不是正整数";
  if (!isCanonicalIso(doc.at)) return "at 不是规范时间";
  if (typeof doc.reason !== "string" || doc.reason.length === 0) return "reason 缺失";
  if (Array.from(doc.reason).length > GATE_REASON_MAX_CODEPOINTS) return "reason 超长";
  if (doc.reason !== normalizeGateReason(doc.reason)) return "reason 含未净化字符";
  return null;
}

/** 归属转换锁只持有几毫秒；超过这个年龄的 .txn 就是残骸（持有者崩在段里），fail-closed 交人工。 */
export const GATE_TXN_STALE_MS = 60 * 1000;
const TXN_KEYS = ["at", "pid", "token"].join(",");
/**
 * 归属转换锁（`<门>.txn`）的三态：absent（只有 ENOENT）/ active（symlink、payload 受验、还新）/ unreadable（残骸、畸形、别的形状、I/O 错误）。
 * 门的投影必须把它算进去：门缺席但 .txn 在场，不是"没门"。
 */
export function readGateTxn({ file, now = Date.now() }) {
  const txn = file + ".txn";
  let st;
  try { st = fs.lstatSync(txn); }
  catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: "归属转换锁 lstat 失败：" + String(err?.code ?? err?.message ?? err) }; }
  if (!st.isSymbolicLink()) return { state: "unreadable", why: "归属转换锁位置上不是 symlink" };
  let doc;
  try { doc = JSON.parse(fs.readlinkSync(txn)); } catch { return { state: "unreadable", why: "归属转换锁 payload 读不出" }; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).sort().join(",") !== TXN_KEYS
    || typeof doc.token !== "string" || !UUID_SHAPE.test(doc.token) || !Number.isSafeInteger(doc.pid) || doc.pid <= 0 || !isCanonicalIso(doc.at)) return { state: "unreadable", why: "归属转换锁 payload 形状不对" };
  const ageMs = Math.max(0, now - st.mtimeMs);
  // why 是受控文案（进飞书正文 / hook reason，不含路径）；detail 只给 doctor（含本机路径）
  if (ageMs > GATE_TXN_STALE_MS) return { state: "unreadable", why: "归属转换锁残骸（持有者崩在段里，已 " + Math.round(ageMs / 1000) + " 秒），人工核对后删除", detail: txn };
  return { state: "active", ageMs, payload: doc };
}

/**
 * 三态读门（把归属转换锁算进投影 —— **不只在门缺席时**：门 active 旁边挂着 .txn 也要说出来）。
 * @returns {{ state: "absent" } | { state: "active", payload: object, ageMs: number } | { state: "transitioning", why: string, payload?: object }
 *          | { state: "unreadable", why: string, detail?: string }}
 *   transitioning = .txn 还新（建 / 撤门正在进行，或释放失败刚留下）：写入口同样挡；unreadable 含 .txn 残骸 / 畸形。
 *   why 是受控文案（不含路径）；detail 只给 doctor。
 */
export function readGate({ file = maintenanceGatePath(), now = Date.now(), withinTxn = false } = {}) {
  if (typeof file !== "string" || file.length === 0) return { state: "unreadable", why: "真实用户 home 说不清，门的位置无从确定" };
  const txn = withinTxn ? { state: "absent" } : readGateTxn({ file, now }); // 段内自己持着 .txn，不把自己算成"正在切换"
  let st;
  try { st = fs.lstatSync(file); }
  catch (err) {
    if (err?.code !== "ENOENT") return { state: "unreadable", why: "lstat 失败：" + String(err?.code ?? err?.message ?? err) };
    if (txn.state === "absent") return { state: "absent" };
    if (txn.state === "active") return { state: "transitioning", why: "门正在建 / 撤（归属转换段进行中，已 " + Math.round(txn.ageMs) + " 毫秒）" };
    return { state: "unreadable", why: txn.why, detail: txn.detail };
  }
  if (txn.state === "unreadable") return { state: "unreadable", why: "门开着，但" + txn.why, detail: txn.detail };
  if (txn.state === "active") {
    const g = readGateFile(file, now);
    return g.state === "active" ? { state: "transitioning", why: "门开着，且归属转换段还在（建 / 撤门进行中或释放失败，已 " + Math.round(txn.ageMs) + " 毫秒）", payload: g.payload } : g;
  }
  return readGateFile(file, now);
}
/** 只读门文件本身（不看 .txn）。 */
function readGateFile(file, now) {
  let st;
  try { st = fs.lstatSync(file); }
  catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: "lstat 失败：" + String(err?.code ?? err?.message ?? err) }; }
  if (!st.isSymbolicLink()) return { state: "unreadable", why: st.isDirectory() ? "门的位置上是目录" : "门的位置上不是 symlink" };
  let raw;
  try { raw = fs.readlinkSync(file); }
  catch (err) { return { state: "unreadable", why: "readlink 失败：" + String(err?.code ?? err?.message ?? err) }; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return { state: "unreadable", why: "payload 不是 JSON" }; }
  const problem = gatePayloadProblem(doc);
  if (problem !== null) return { state: "unreadable", why: "payload 形状不对：" + problem };
  return { state: "active", payload: doc, ageMs: Math.max(0, now - Date.parse(doc.at)) };
}

/**
 * 写入口的判据：门 active 或 unreadable 都算"被挡"。text 是给人看的受控一句话（不含路径）。
 * @returns {{ blocked: boolean, state: string, text: string|null, gate: object|null }}
 */
export function gateBlocks({ file = maintenanceGatePath(), now = Date.now() } = {}) {
  const g = readGate({ file, now });
  if (g.state === "absent") return { blocked: false, state: "absent", text: null, gate: null };
  if (g.state === "active") {
    const mins = Math.floor(g.ageMs / 60000);
    return { blocked: true, state: "active", text: "桥维护中（" + g.payload.reason + "，已 " + mins + " 分钟）", gate: { reason: g.payload.reason, at: g.payload.at, token: g.payload.token, ageMs: g.ageMs } };
  }
  if (g.state === "transitioning") return { blocked: true, state: "transitioning", text: "维护门正在切换（建门或撤门进行中），按维护中处理，请稍后重试", gate: g.payload ? { reason: g.payload.reason, at: g.payload.at, token: g.payload.token } : null };
  return { blocked: true, state: "unreadable", text: "维护门读不出（" + g.why + "），按维护中处理，请在本机跑 doctor", gate: null, detail: g.detail ?? null };
}

/** 入站类入口的确定性回复（stdout，给运输 agent 原样回复）：不 claim、不写回执、不重放。 */
export const gateInboundText = (g) => (g.state === "active" ? g.text + "：这条消息没有处理，请稍后重发" : g.text);
/** Aily 回合的 UserPromptSubmit 硬阻断（两条宿主都是这个顶层形状；reason 非空）。 */
export const gateBlockDecision = (g) => JSON.stringify({ decision: "block", reason: gateInboundText(g) });

/**
 * 各类入口在门前的受控退出：
 *   hook_silent   → 无输出 exit 0（Stop / init / 本地回合）
 *   hook_block    → stdout decision:block，exit 0（Aily 回合）
 *   inbound       → stdout 维护中一句话，exit 0（运输 agent 回复它）
 *   cli           → stdout 维护中一句话，exit 2（人手起的命令要有回音）
 *   worker        → 无输出 exit 0（定时器 / 守望者 / 排空）
 * 只在 blocked 时调用；不 blocked 就返回 false 让调用方继续。
 */
export function exitForGate(kind, g, { out = process.stdout, exit = (code) => process.exit(code) } = {}) {
  if (!g?.blocked) return false;
  if (kind === "hook_block") { out.write(gateBlockDecision(g) + "\n"); exit(0); return true; }
  if (kind === "inbound") { out.write(gateInboundText(g) + "\n"); exit(0); return true; }
  if (kind === "cli") { out.write(g.text + "\n"); exit(2); return true; }
  exit(0); // hook_silent / worker
  return true;
}

/**
 * 门的**归属转换段**（建 / 撤都在里面）：`<门>.txn` symlink 锁，与发布锁同一原语。
 * 没有它，撤门是"读 token → 按路径 unlink"两步：中间旧门被撤、别的实例建了新门，旧撤门者会删掉新门（评审探针）。
 * 段内重读再动；.txn 在场 → gate_busy（不等），超过 GATE_TXN_STALE_MS → gate_txn_residue（不自愈，人工处置）。
 */
function withGateTxn(file, fn) {
  const txn = file + ".txn";
  const token = crypto.randomUUID();
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.symlinkSync(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }), txn); }
  catch (err) {
    if (err?.code !== "EEXIST") return { ok: false, reason: "io_error", why: "归属转换锁建不出：" + String(err?.code ?? err?.message ?? err) };
    const cur = readGateTxn({ file });
    if (cur.state === "unreadable") return { ok: false, reason: "gate_txn_residue", why: cur.why };
    return { ok: false, reason: "gate_busy", why: "另一次建门 / 撤门正在进行" };
  }
  let result;
  try { result = fn(); }
  finally {
    // 释放失败**不吞**：段内的动作已经完成（结果照样返回），但 .txn 留在原地会让后续建 / 撤门都 gate_busy、读门都 transitioning，
    // 必须随结果带回（txnUncleared），让调用方与 doctor 点名，而不是"建门成功"完事。
    let uncleared = null;
    try { const cur = JSON.parse(fs.readlinkSync(txn)); if (cur?.token === token) fs.unlinkSync(txn); }
    catch (err) { if (err?.code !== "ENOENT") uncleared = { path: txn, why: String(err?.code ?? err?.message ?? err) }; }
    if (uncleared !== null && result && typeof result === "object") result = { ...result, txnUncleared: uncleared };
  }
  return result;
}

/** 建门（归属转换段内）：symlink 原语，路径上有任何东西都 EEXIST（不覆盖）。返回 { ok, token } 或 { ok:false, reason }。 */
export function createGate({ file = maintenanceGatePath(), reason, token = crypto.randomUUID(), pid = process.pid, now = Date.now() } = {}) {
  if (typeof file !== "string" || file.length === 0) return { ok: false, reason: "gate_path_unknown", why: "真实用户 home 说不清" };
  const payload = { schema_version: GATE_SCHEMA_VERSION, pid, at: new Date(now).toISOString(), token, reason: normalizeGateReason(reason) };
  const problem = gatePayloadProblem(payload);
  if (problem !== null) return { ok: false, reason: "payload_shape", why: problem };
  return withGateTxn(file, () => {
    try { fs.symlinkSync(JSON.stringify(payload), file); }
    catch (err) { return err?.code === "EEXIST" ? { ok: false, reason: "gate_exists" } : { ok: false, reason: "io_error", why: String(err?.code ?? err?.message ?? err) }; }
    return { ok: true, token, payload };
  });
}

/** 撤门（归属转换段内，段内重读）：只撤 token 一致的门；unreadable / 别人的门 / 缺席都不动，如实返回。 */
export function removeGate({ file = maintenanceGatePath(), token } = {}) {
  if (typeof file !== "string" || file.length === 0) return { ok: false, removed: false, reason: "gate_path_unknown", why: "真实用户 home 说不清" };
  return withGateTxn(file, () => {
    const g = readGate({ file, withinTxn: true });
    if (g.state === "absent") return { ok: true, removed: false, reason: "absent" };
    if (g.state === "unreadable") return { ok: false, removed: false, reason: "unreadable", why: g.why };
    if (g.payload.token !== token) return { ok: false, removed: false, reason: "not_owner" };
    try { fs.unlinkSync(file); } catch (err) { return err?.code === "ENOENT" ? { ok: true, removed: false, reason: "absent" } : { ok: false, removed: false, reason: "io_error", why: String(err?.code ?? err?.message ?? err) }; }
    return { ok: true, removed: true, reason: null };
  });
}
