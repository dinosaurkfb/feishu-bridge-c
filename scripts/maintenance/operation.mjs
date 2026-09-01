/**
 * 维护门 operation 核心（issue #81 PR C）：enter / exit / status。命令面在 scripts/maintenance-gate.mjs。
 *
 * enter（预检 → 租约 + journal → 停定时器 → 建桩并切 current → 建门 → 等进程）：每一次外部变更都两阶段记账（journal.mjs），
 * 任一步失败按 journal 回退到进门前。exit：未到不可逆阶段 → 按 journal CAS 回退；已到不可逆阶段 → 只向前继续（每步幂等）。
 * **同一 operation 只许一个执行者**：enter / exit / 续跑都先拿 `<token>.lease`（只按持有者 pid 活性接管），journal 的每次写入在租约段内 fencing。
 *
 * 恢复规则（只看 journal 里的 prepared / done 与现场）：
 *   prepared 且现场 == before → 没做过，跳过；prepared / done 且现场 == intended_after → 做过：回退方向写回 before；
 *   现场既不是 before 也不是 after → *_incomplete（该项留给人，门与账保留）。
 * 残骸（撤门的归属转换锁交不还、active 清不掉、租约交不还）一律算"动了但没做完"：不宣称已进门 / 已出门，命令面退出码 3。
 *
 * 测试注入点（只给测试用）：ctx.launchctl / ctx.ps / ctx.sleep / ctx.now / ctx.afterStep（在某一步 done 之后抛 { simulatedCrash:true } 模拟进程死在中间）/ ctx.gateOps。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGate, maintenanceGatePath, normalizeGateReason, readGate, removeGate } from "../maintenance-gate-core.mjs";
import { inspectInstallSurfaceLock } from "../install-surface-lock.mjs";
import { readRegularFile, withInstalledSurfaceLock } from "../installed-surface.mjs";
import { switchCurrentTarget } from "../runtime-install.mjs";
import { spawnLaunchctl } from "../launchd-job.mjs";
import { pickClaudeNode } from "../drain-schedule.mjs";
import { bridgeHome as codexBridgeHomeOf } from "../codex/state.mjs";
import {
  FORWARD_ONLY_PHASES, INCOMPLETE_PHASES, TERMINAL_PHASES, acquireOperationLease, addNote, addStepPrepared, clearActive, createOperation, inspectMaintenanceDir, leaseHolder, maintenanceDir,
  markStepDone, readActive, readJournal, releaseOperationLease, setPhase, verifyBackup, writeBackup, writeDurable,
} from "./journal.mjs";
import { buildStubVersion, isStubTarget, readStubManifest, removeStubVersion, stubDirName, stubRelTarget } from "./stub.mjs";
import { defaultPs, waitForQuiet } from "./inventory.mjs";
import { bootoutTimer, bootstrapTimer, guiDomain, timerPhase } from "./timers.mjs";
import { chainFacts, precheckStartupSources } from "./precheck.mjs";

const CHAINS = ["claude", "codex"];
const readlinkOrNull = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
const errText = (err) => String(err?.code ?? err?.message ?? err);

/** 归一化依赖与路径；测试从这里注入隔离点。 */
export function maintenanceContext({
  home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, ".codex"), codexBridgeHome = codexBridgeHomeOf(), repoRoot,
  node = pickClaudeNode(), launchctl = spawnLaunchctl, ps = defaultPs, sleep = null, now = Date.now, afterStep = null,
  dir = maintenanceDir(), gateFile = maintenanceGatePath(), domain = guiDomain(), stepMs = 5000, gateOps = { createGate, removeGate },
} = {}) {
  return { home, codexHome, codexBridgeHome, repoRoot, node, launchctl, ps, sleep, now, afterStep, dir, gateFile, domain, stepMs, gateOps };
}

const factsOf = (ctx, chain) => chainFacts({ chain, home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, node: ctx.node });

/** 只读状态：门 / active / journal / 租约持有者 / 两链 current 与桩 / 定时器三态 / 没做完的重新开放。 */
export function maintenanceStatus(ctx) {
  const gate = readGate({ file: ctx.gateFile, now: ctx.now() });
  const active = readActive({ dir: ctx.dir });
  const journal = active.state === "active" ? readJournal({ dir: ctx.dir, token: active.token }) : null;
  const lease = active.state === "active" ? leaseHolder({ dir: ctx.dir, token: active.token }) : null;
  const chains = {};
  for (const chain of CHAINS) {
    const facts = factsOf(ctx, chain);
    const current = readlinkOrNull(facts.current);
    let stubs = [];
    try { stubs = fs.readdirSync(path.join(facts.root, "versions")).filter((n) => n.startsWith("maintenance-")); } catch { stubs = []; }
    const stubManifest = current !== null && isStubTarget(current) ? readStubManifest(path.join(facts.root, current)) : null;
    chains[chain] = { current, isStub: current !== null && isStubTarget(current), stubManifest, stubs, timer: timerPhase({ ...facts.timer, run: ctx.launchctl }).phase };
  }
  const phase = journal?.state === "valid" ? journal.doc.phase : null;
  const pendingReopening = phase !== null && FORWARD_ONLY_PHASES.includes(phase) && !TERMINAL_PHASES.includes(phase);
  const residues = inspectMaintenanceDir({ dir: ctx.dir });
  const surfaceLock = inspectInstallSurfaceLock({ home: ctx.home });
  return { gate, active, journal, lease, phase, pendingReopening, chains, residues, surfaceLock, dir: ctx.dir, gateFile: ctx.gateFile };
}

export function renderStatus(s) {
  const lines = ["飞书桥 · 维护门状态（只读）", ""];
  const g = s.gate;
  lines.push("门        ：" + (g.state === "absent" ? "没开" : g.state === "active" ? "开着（" + g.payload.reason + "，已 " + Math.floor(g.ageMs / 60000) + " 分钟，token " + String(g.payload.token).slice(0, 8) + "）" : g.state === "transitioning" ? "正在切换（" + g.why + "）—— 入口都按维护中处理；一直如此就是归属转换锁残骸，请人工核对 " + s.gateFile + ".txn" : "读不出（" + g.why + "）—— 请人工核对 " + s.gateFile));
  const phaseText = (p) => INCOMPLETE_PHASES.includes(p) ? "（没做完 —— 门与账保留；处置后跑 --exit --apply 只向前继续）" : s.pendingReopening ? "（重新开放未完 —— 跑 --exit --apply 只向前继续）" : TERMINAL_PHASES.includes(p) ? "（已终结，active 未清 —— 跑 --exit --apply 只清 active）" : "";
  lines.push("operation ：" + (s.active.state === "absent" ? "没有" : s.active.state === "unreadable" ? "active 读不出（" + s.active.why + "）—— 请人工核对 " + path.join(s.dir, "active") : s.journal.state === "valid" ? "token " + s.active.token.slice(0, 8) + "，阶段 " + s.phase + phaseText(s.phase) : "journal " + s.journal.state + (s.journal.why ? "（" + s.journal.why + "）" : "") + " —— 请人工核对 " + path.join(s.dir, s.active.token + ".json")));
  if (s.lease?.present) lines.push("执行者    ：" + (s.lease.unreadable ? "租约读不出（" + s.lease.why + "）—— 请人工核对 " + path.join(s.dir, s.active.token + ".lease") : "pid " + s.lease.pid + (s.lease.alive ? "（在跑）" : "（已不在，下一个执行者会接管）")));
  for (const chain of CHAINS) {
    const c = s.chains[chain];
    lines.push((chain === "claude" ? "Claude 链 " : "Codex 链  ") + "：current → " + (c.current ?? "（没有）") + (c.isStub ? "（维护桩" + (c.stubManifest?.state === "valid" ? "，原目标 " + c.stubManifest.doc.original_current : "，清单读不出") + "）" : "") + "；定时器 " + c.timer + (c.stubs.length > 0 && !c.isStub ? "；残留桩目录 " + c.stubs.join("、") : ""));
  }
  if (s.journal?.state === "valid") {
    for (const st of s.journal.doc.steps) lines.push("  · " + st.id + " " + st.state + (st.state === "done" ? " → " + JSON.stringify(st.after) : "（prepared，现场核对后决定）"));
    for (const n of s.journal.doc.notes.slice(-3)) lines.push("  ※ " + n);
  }
  if (s.residues?.inventory === "unreadable") lines.push("维护目录  ：读不出 —— " + s.residues.residues.map((r) => r.detail).join("；"));
  else if (s.residues?.residues?.length > 0) { lines.push("维护目录残骸 " + s.residues.residues.length + " 处（只报告，不自动清）："); for (const r of s.residues.residues) lines.push("  · " + r.path + "：" + r.detail); }
  if (s.surfaceLock) {
    const h = s.surfaceLock.holder;
    lines.push("安装面锁  ：" + (h.state === "absent" ? "没人持有" : h.state === "held" ? "pid " + h.pid + (h.alive ? "（在跑）" : "（已不在，下一个写方会按 pid 活性接管）") : "说不清（" + h.why + "）—— " + s.surfaceLock.path));
    for (const r of s.surfaceLock.residues) lines.push("  · " + r.path + "：" + r.detail);
  }
  return lines.join("\n");
}

const afterStep = (ctx, id) => { if (typeof ctx.afterStep === "function") ctx.afterStep(id); };
const withLeaseResidue = (result, rel) => (rel.ok ? result : { ...result, ok: false, leaseUncleared: { path: rel.path, why: rel.why } });

/**
 * 进门。apply=false 只做预检并给计划。返回 { ok, token, phase } 或 { ok:false, reason, ..., rollback }。
 * keepLease=true（maintenance-install 用）：进门成功时**不释放执行租约**，随结果带回（{ lease }），
 * 由调用方连续持有到 reopening / 回退结束 —— 释放再重取会留出"旧 operation 被退出、新 operation 建立"的窗口（评审探针）。
 */
export function enterMaintenance(ctx, { reason, waitMs = 60000, apply = false, keepLease = false } = {}) {
  if (typeof reason !== "string" || reason.trim().length === 0) return { ok: false, reason: "reason_required" };
  const normalized = normalizeGateReason(reason);
  const pre = precheckStartupSources({ home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, repoRoot: ctx.repoRoot, node: ctx.node, launchctl: ctx.launchctl });
  if (!pre.ok) return { ok: false, reason: "startup_source_unverified", items: pre.items.filter((i) => !i.ok), precheck: pre };
  const gate = readGate({ file: ctx.gateFile, now: ctx.now() });
  if (gate.state !== "absent") return { ok: false, reason: "gate_" + gate.state, why: gate.why ?? (gate.payload ? "门已开着（token " + String(gate.payload.token).slice(0, 8) + "）" : null) };
  const active = readActive({ dir: ctx.dir });
  if (active.state !== "absent") return { ok: false, reason: active.state === "active" ? "operation_active" : "active_unreadable", token: active.token ?? null, why: active.why ?? null };
  const plan = { reason: normalized, waitMs, chains: {} };
  for (const chain of CHAINS) {
    const facts = pre.chains[chain].facts;
    plan.chains[chain] = { root: facts.root, current: readlinkOrNull(facts.current), timer: pre.chains[chain].timer.phase, agentUid: pre.chains[chain].agentUid, entries: pre.manifest.entries.filter(facts.entryFilter) };
  }
  if (!apply) return { ok: true, dryRun: true, plan, precheck: pre };

  const op = createOperation({ dir: ctx.dir, reason: normalized, now: ctx.now() });
  if (!op.ok) return { ok: false, reason: op.reason, why: op.why ?? null, token: op.token ?? null, path: op.path ?? null };
  const token = op.token, lease = op.lease;
  const J = (r, what) => { if (!r.ok) throw Object.assign(new Error(what + "：" + String(r.reason) + (r.why ? "（" + r.why + "）" : "") + (r.path ? "，" + r.path : "")), { opReason: r.reason === "lease_lost" || r.reason === "active_mismatch" ? "operation_taken_over" : r.reason === "lease_reap_uncleared" ? "lease_reap_uncleared" : "journal_write_failed", residuePath: r.path ?? null }); return r; };
  let out;
  try {
    // ── 定时器：先记账（原始三态 + plist 原字节备份，sha256 / 长度进账）再 bootout
    for (const chain of CHAINS) {
      const t = pre.chains[chain].timer, facts = pre.chains[chain].facts;
      let backup = null, meta = { sha256: null, bytes: null };
      if (t.plistBytes !== null) { backup = path.join(ctx.dir, token + "." + chain + ".plist"); meta = writeBackup(backup, t.plistBytes); }
      J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id: "timer:" + chain, kind: "timer", target: facts.timer.label, before: { phase: t.phase, plist: facts.timer.plistFile }, backup, backup_sha256: meta.sha256, backup_bytes: meta.bytes, intended_after: { phase: t.phase === "loaded" ? "installed_not_loaded" : t.phase } } }), "记 timer");
      if (t.phase === "loaded") {
        const r = bootoutTimer({ label: facts.timer.label, domain: ctx.domain, run: ctx.launchctl });
        if (!r.ok) throw Object.assign(new Error("停定时器（" + chain + "）：" + r.why), { opReason: "timer_stop_failed" });
      }
      J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id: "timer:" + chain, after: { phase: t.phase === "loaded" ? "installed_not_loaded" : t.phase } }), "记 timer done");
      afterStep(ctx, "timer:" + chain);
    }
    J(setPhase({ dir: ctx.dir, token, lease, phase: "timer_stopped", expectPhase: "planned", now: ctx.now() }), "phase");
    // ── 桩：先建目录（不可达缓存），再记账切 current
    for (const chain of CHAINS) {
      const facts = pre.chains[chain].facts, orig = plan.chains[chain].current;
      J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id: "stub:" + chain, kind: "stub", target: path.join(facts.root, "versions", stubDirName(token)), before: null, backup: null, intended_after: stubRelTarget(token) } }), "记 stub");
      const b = buildStubVersion({ root: facts.root, token, reason: normalized, at: new Date(ctx.now()).toISOString(), entries: plan.chains[chain].entries, agentUid: plan.chains[chain].agentUid, originalCurrent: orig });
      if (!b.ok) throw Object.assign(new Error("建桩（" + chain + "）：" + String(b.reason) + (b.why ? "（" + b.why + "）" : "")), { opReason: "stub_build_failed" });
      J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id: "stub:" + chain, after: b.rel }), "记 stub done");
      afterStep(ctx, "stub:" + chain);
    }
    for (const chain of CHAINS) {
      const facts = pre.chains[chain].facts, orig = plan.chains[chain].current;
      J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id: "current:" + chain, kind: "current", target: facts.current, before: orig, backup: null, intended_after: stubRelTarget(token) } }), "记 current");
      const live = readlinkOrNull(facts.current);
      if (live !== orig) throw Object.assign(new Error("切桩前 current（" + chain + "）已变：" + String(live)), { opReason: "current_changed" });
      const sw = switchCurrentTarget({ root: facts.root, target: stubRelTarget(token) });
      if (!sw.ok) throw Object.assign(new Error("切桩（" + chain + "）：" + String(sw.why ?? sw.reason)), { opReason: "current_switch_failed" });
      J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id: "current:" + chain, after: sw.after }), "记 current done");
      afterStep(ctx, "current:" + chain);
    }
    J(setPhase({ dir: ctx.dir, token, lease, phase: "stubbed", expectPhase: "timer_stopped", now: ctx.now() }), "phase");
    // ── 门（归属转换锁交不还 → 门会一直 transitioning：算失败，走回退）
    J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id: "gate", kind: "gate", target: ctx.gateFile, before: null, backup: null, intended_after: { token } } }), "记 gate");
    const g = ctx.gateOps.createGate({ file: ctx.gateFile, reason: normalized, token, now: ctx.now() });
    if (!g.ok) throw Object.assign(new Error("建门：" + String(g.reason) + (g.why ? "（" + g.why + "）" : "")), { opReason: "gate_create_failed" });
    J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id: "gate", after: { token, txnUncleared: g.txnUncleared ? { path: g.txnUncleared.path, why: String(g.txnUncleared.why) } : null } }), "记 gate done");
    if (g.txnUncleared) throw Object.assign(new Error("建门后归属转换锁交不还：" + g.txnUncleared.path), { opReason: "gate_txn_uncleared" });
    afterStep(ctx, "gate");
    J(setPhase({ dir: ctx.dir, token, lease, phase: "gated", expectPhase: "stubbed", now: ctx.now() }), "phase");
    // ── 等既有进程退出（只认桩清单里的入口；不 kill）—— 整段仍在租约里，别的执行者进不来
    const roots = [];
    for (const chain of CHAINS) {
      const facts = pre.chains[chain].facts, orig = plan.chains[chain].current;
      roots.push(path.join(facts.current, "scripts"));
      if (orig !== null) roots.push(path.join(facts.root, orig, "scripts"));
    }
    const q = waitForQuiet({ roots, waitMs, stepMs: ctx.stepMs, ps: ctx.ps, now: ctx.now, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) });
    if (!q.ok) throw Object.assign(new Error(q.reason === "processes_still_running" ? "等进程超时，残留：" + q.processes.map((p) => p.pid + " " + p.command).join("；") : "进程盘点做不了：" + String(q.why)), { opReason: q.reason, processes: q.processes ?? null });
    J(setPhase({ dir: ctx.dir, token, lease, phase: "drained", expectPhase: "gated", now: ctx.now(), note: "等了 " + q.waitedMs + " ms" }), "phase");
    out = { ok: true, token, phase: "drained", plan };
  } catch (err) {
    if (err?.simulatedCrash) throw err;
    if (err?.opReason === "operation_taken_over") { releaseOperationLease(lease); return { ok: false, reason: "operation_taken_over", why: String(err?.message ?? err), token }; }
    // 租约的归属转换锁交不还：之后每次写账都会 reap_residue，回退也写不了账 —— 立即停，什么都不再动；active / journal 保留，修好 .reap 后 --exit --apply 按账续做
    if (err?.opReason === "lease_reap_uncleared") { const rel = releaseOperationLease(lease); return { ok: false, reason: "lease_reap_uncleared", why: String(err?.message ?? err), token, path: err.residuePath, leaseUncleared: { path: err.residuePath ?? rel.path ?? null, why: "reap_uncleared" }, phase: "stopped" }; }
    const rollback = rollbackOperation(ctx, token, lease);
    out = { ok: false, reason: err?.opReason ?? "enter_failed", why: String(err?.message ?? err), token, processes: err?.processes ?? null, rollback };
  }
  if (out.ok && keepLease) return { ...out, lease };
  return withLeaseResidue(out, releaseOperationLease(lease));
}

/** staged 私有目录（stage 写目标制品字节 / plan / 备份的地方；随 reopening 一并删除）。 */
export const stagedDirPath = (ctx, token) => path.join(ctx.dir, token + ".staged");
const sha256Of = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
/** 线上一个文件此刻的 { exists, sha256 }（fd 绑定读）；读不出 → null（既不是 before 也不是 after，说不清）。 */
const liveFileState = (file) => {
  const r = readRegularFile(file);
  if (r.status === "read") return { exists: true, sha256: sha256Of(r.buf) };
  if (r.status === "absent") return { exists: false, sha256: null };
  return null;
};
const sameFileState = (a, b) => a !== null && b !== null && a.exists === b.exists && a.sha256 === b.sha256;

/** journal 写失败的定性：租约的归属转换锁交不还 / 被接管 → 不许再做任何外部变更（立即停）；其余也停（journal_write_failed）。 */
const journalFatal = (r) => ({
  reason: r.reason === "lease_reap_uncleared" ? "lease_reap_uncleared" : r.reason === "lease_lost" || r.reason === "active_mismatch" || r.reason === "lease_mismatch" ? "operation_taken_over" : "journal_write_failed",
  why: String(r.reason) + (r.why ? "（" + r.why + "）" : ""), path: r.path ?? null,
});
/**
 * rolling_back 里按备份恢复 install 写入（PR C 第 2 步；**此时两条 current 仍是桩或已回桩、门仍在**）——
 * 逆序处理 receipt / artifact / current:<chain>:install 三类 step，每项恢复规则：
 *   现场 == before → 没做过 / 已回，跳过；现场 == intended_after → 按备份写回 before（备份先核 sha256 / 长度；before 缺席 → unlink）；
 *   其余 → 该项 incomplete（不拿来源不明的现场当可覆盖的东西）。收据的写回走收据事务锁（与安装器串行化），
 * 锁拿不到 / 锁残骸（reap 交不还、释放失败）都算该项 incomplete —— 有残骸就不能记成"已恢复"。
 * **每次恢复后的 journal note 都受检**：写不进（租约被接管 / 归属转换锁交不还 / I/O）→ 立即停，不再做下一项外部变更（{ fatal }）。
 */
function restoreInstallWrites(ctx, doc, { note }) {
  const incomplete = [];
  const restoreBytes = (st) => {
    if (st.before.exists) {
      const v = verifyBackup({ file: st.backup, sha256: st.backup_sha256, bytes: st.backup_bytes });
      if (!v.ok) return "备份核不过：" + v.why + "（" + st.backup + "）";
      try { writeDurable(st.target, v.buf); } catch (err) { return "写回失败：" + errText(err); }
      return null;
    }
    try { fs.unlinkSync(st.target); } catch (err) { return err?.code === "ENOENT" ? null : "删除失败：" + errText(err); }
    return null;
  };
  const noted = (t) => { const n = note(t); return n.ok ? null : journalFatal(n); };
  for (const st of [...doc.steps].reverse()) {
    const isInstallCurrent = st.kind === "current" && st.id.endsWith(":install");
    if (st.kind !== "artifact" && st.kind !== "receipt" && !isInstallCurrent) continue;
    if (isInstallCurrent) {
      const chain = st.id.split(":")[1];
      const facts = factsOf(ctx, chain);
      const live = readlinkOrNull(facts.current);
      if (live === st.before) continue;
      if (live !== st.intended_after) { incomplete.push({ id: st.id, why: "现场 current=" + String(live) + " 既不是桩也不是目标版本，不动" }); continue; }
      const sw = switchCurrentTarget({ root: facts.root, target: st.before });
      if (!sw.ok) { incomplete.push({ id: st.id, why: "切回桩失败：" + String(sw.why ?? sw.reason) }); continue; }
      const f = noted(st.id + " 已切回桩");
      if (f !== null) return { incomplete, fatal: f };
      continue;
    }
    const live = liveFileState(st.target);
    if (live === null) { incomplete.push({ id: st.id, why: "线上状态读不出" }); continue; }
    if (sameFileState(live, st.before)) continue;
    if (!sameFileState(live, st.intended_after)) { incomplete.push({ id: st.id, why: "现场既不是 before 也不是 intended_after，不动" }); continue; }
    if (st.kind === "receipt") {
      const locked = withInstalledSurfaceLock(st.target, ({ commit }) => {
        if (!sameFileState(liveFileState(st.target), st.intended_after)) return { why: "锁内重读已变，不动" };
        const c = commit(() => restoreBytes(st));
        if (!c.ok) return { why: "锁归属核对失败：" + String(c.reason) };
        return { why: c.run, reap: c.reapUncleared ?? null };
      });
      let why = null;
      if (!locked.ok) why = "收据锁拿不到：" + String(locked.reason) + (locked.why ? "（" + locked.why + "）" : "") + (locked.path ? "，" + locked.path : "");
      else if (locked.run.reap) why = "收据锁归属转换锁交不还：" + String(locked.run.reap.error ?? "") + "（" + locked.run.reap.path + "）";
      else if (locked.lockUncleared) why = "收据锁交不还：" + String(locked.lockUncleared.reason) + (locked.lockUncleared.error ? "：" + locked.lockUncleared.error : "") + "（" + locked.lockUncleared.path + "）";
      else why = locked.run.why;
      if (why !== null) { incomplete.push({ id: st.id, why }); continue; }
    } else {
      const why = restoreBytes(st);
      if (why !== null) { incomplete.push({ id: st.id, why }); continue; }
    }
    const f = noted(st.id + " 已按备份回退");
    if (f !== null) return { incomplete, fatal: f };
  }
  return { incomplete, fatal: null };
}

/**
 * 回退（未到不可逆阶段时）：rolling_back —— 先按备份恢复全部 install 写入并核验（此时门仍在），任一项说不清 →
 * **停在 rolling_back**（门与账保留，--exit --apply 重试恢复），全部干净才进 rollback_reopening（不可逆）→ reopening(mode:"rollback")。
 * journal 写失败（含租约被接管 / 归属转换锁交不还）→ 立即停，不再做外部变更。
 * 已在成功侧不可逆阶段（reopening / reopening_incomplete）时只向前走成功路径，不回退。调用方持有租约。
 */
export function rollbackOperation(ctx, token, lease) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null };
  let phase = j.doc.phase;
  if (!FORWARD_ONLY_PHASES.includes(phase)) {
    const p = setPhase({ dir: ctx.dir, token, lease, phase: "rolling_back", now: ctx.now() });
    if (!p.ok) { const f = journalFatal(p); return { ok: false, reason: f.reason, why: f.why, path: f.path }; }
    const restored = restoreInstallWrites(ctx, p.doc, { note: (t) => addNote({ dir: ctx.dir, token, lease, note: t, now: ctx.now() }) });
    if (restored.fatal !== null) return { ok: false, reason: restored.fatal.reason, why: restored.fatal.why, path: restored.fatal.path, phase: "rolling_back" };
    if (restored.incomplete.length > 0) {
      addNote({ dir: ctx.dir, token, lease, note: "恢复 install 写入说不清 " + restored.incomplete.length + " 项：" + restored.incomplete.map((i) => i.id + "（" + i.why + "）").join("；"), now: ctx.now() });
      return { ok: false, phase: "rolling_back", incomplete: restored.incomplete };
    }
    const p2 = setPhase({ dir: ctx.dir, token, lease, phase: "rollback_reopening", expectPhase: "rolling_back", now: ctx.now() });
    if (!p2.ok) { const f = journalFatal(p2); return { ok: false, reason: f.reason, why: f.why, path: f.path }; }
    phase = "rollback_reopening";
  }
  // 成功侧的不可逆阶段（current 已指新版本、可能已删门）：只向前走成功路径 —— 回退方向在这里已经不存在
  const mode = phase === "reopening" || phase === "reopening_incomplete" || phase === "done" ? "success" : "rollback";
  return reopening(ctx, token, lease, { mode });
}

/**
 * 重新开放（不可逆、幂等、只向前）。mode:"rollback" → current 回 before、定时器回原始三态；mode:"success"（PR C 第二步）→ current 已由 commit 指向新版本、定时器到目标状态。
 * 有 CAS 不成立项 / 撤门残骸 / active 清不掉 → *_incomplete：不删门（或门已删但账保留）、不清 active，留给人，之后只向前重试。
 */
export function reopening(ctx, token, lease, { mode }) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null };
  const doc = j.doc;
  const incomplete = [];
  const note = (t) => addNote({ dir: ctx.dir, token, lease, note: t, now: ctx.now() });
  // note 受检：journal 写不进（租约被接管 / 归属转换锁交不还 / I/O）→ 立即停，不再做下一项外部变更
  const noted = (t) => { const n = note(t); return n.ok ? null : journalFatal(n); };
  const incompletePhase = mode === "rollback" ? "rollback_incomplete" : "reopening_incomplete";
  const bail = (extra) => {
    const p = setPhase({ dir: ctx.dir, token, lease, phase: incompletePhase, now: ctx.now(), note: "说不清 " + incomplete.length + " 项：" + incomplete.map((i) => i.id + "（" + i.why + "）").join("；") });
    return { ok: false, phase: incompletePhase, incomplete, journalWrite: p.ok, ...(p.ok ? {} : { journalWhy: p.why ?? p.reason }), ...extra };
  };
  // ① current：CAS —— 现场 == intended_after（桩）→ 切回 before；== before → 没做过 / 已回；否则说不清。
  // 回退方向逆序：install 步（桩 → 版本）先回到桩，enter 步（原目标 → 桩）再回原目标 —— 正序会把"还指着新版本"误判成说不清。
  const currentSteps = doc.steps.filter((s) => s.kind === "current");
  if (mode === "rollback") currentSteps.reverse();
  for (const st of currentSteps) {
    const chain = st.id.split(":")[1];
    const facts = factsOf(ctx, chain);
    const live = readlinkOrNull(facts.current);
    if (mode === "rollback") {
      if (live === st.before) continue;
      if (live === st.intended_after) {
        if (st.before === null) { incomplete.push({ id: st.id, why: "原来没有 current，无法回退到「没有」之外的状态" }); continue; }
        const sw = switchCurrentTarget({ root: facts.root, target: st.before });
        if (!sw.ok) { incomplete.push({ id: st.id, why: "切回失败：" + String(sw.why ?? sw.reason) }); continue; }
        const f = noted("current:" + chain + " 已切回 " + st.before);
        if (f !== null) return { ok: false, reason: f.reason, why: f.why, path: f.path, phase: doc.phase };
        continue;
      }
      incomplete.push({ id: st.id, why: "现场 current=" + String(live) + " 既不是桩也不是原目标，不动" });
    } else if (st.id.endsWith(":install")) {
      // 成功路径：install 步的 current 必须**精确**等于目标版本（评审探针：缺失 / 指向别的正式版本也曾被放过并删门）
      if (live !== st.intended_after) incomplete.push({ id: st.id, why: "成功路径 reopening 时 current=" + String(live) + " 不是目标 " + st.intended_after + "，不删门" });
    } else if (live !== null && isStubTarget(live)) {
      incomplete.push({ id: st.id, why: "成功路径 reopening 时 current 仍指桩（commit 没完成？）" });
    }
  }
  // ①b 成功路径：删门前复核全部 install 写入（制品 / 收据）仍等于 journal 的目标状态 —— 目标漂移就不删门、不记 done
  if (mode === "success") for (const st of doc.steps.filter((s) => s.kind === "artifact" || s.kind === "receipt")) {
    const live = liveFileState(st.target);
    if (live === null || !sameFileState(live, st.intended_after)) incomplete.push({ id: st.id, why: "现场" + (live === null ? "读不出" : "与 journal 的目标状态不符") + "，不删门" });
  }
  // ② 定时器：回原始三态（rollback）—— 只有原来 loaded 才需要 bootstrap；plist 字节先按备份还原（备份先核 sha256 / 长度）
  for (const st of doc.steps.filter((s) => s.kind === "timer")) {
    const chain = st.id.split(":")[1];
    const facts = factsOf(ctx, chain);
    const wantLoaded = mode === "rollback" ? st.before.phase === "loaded" : (chain === "claude" || st.before.phase === "loaded");
    if (!wantLoaded) continue;
    if (mode === "rollback" && st.backup !== null) {
      const v = verifyBackup({ file: st.backup, sha256: st.backup_sha256, bytes: st.backup_bytes });
      if (!v.ok) { incomplete.push({ id: st.id, why: "plist 备份核不过：" + v.why + "（" + st.backup + "）" }); continue; }
      let liveBytes = null;
      try { liveBytes = fs.readFileSync(facts.timer.plistFile); } catch { liveBytes = null; }
      if (liveBytes === null || !liveBytes.equals(v.buf)) {
        try { fs.mkdirSync(path.dirname(facts.timer.plistFile), { recursive: true }); fs.writeFileSync(facts.timer.plistFile, v.buf); }
        catch (err) { incomplete.push({ id: st.id, why: "plist 写回失败：" + errText(err) }); continue; }
      }
    }
    const cur = timerPhase({ ...facts.timer, run: ctx.launchctl });
    if (cur.phase === "loaded") continue;
    const r = bootstrapTimer({ label: facts.timer.label, plistFile: facts.timer.plistFile, expect: facts.timer.expect, domain: ctx.domain, run: ctx.launchctl });
    if (!r.ok) { incomplete.push({ id: st.id, why: "定时器恢复失败：" + r.why }); continue; }
    const f = noted("timer:" + chain + " 已恢复 loaded");
    if (f !== null) return { ok: false, reason: f.reason, why: f.why, path: f.path, phase: doc.phase };
  }
  // ③ 删桩：current 已不指它才删；同链 current 说不清的，桩先留着（人要把 current 指回桩再出门，桩没了就没得回）
  const unclearChains = new Set(incomplete.filter((i) => i.id.startsWith("current:")).map((i) => i.id.split(":")[1]));
  for (const st of doc.steps.filter((s) => s.kind === "stub")) {
    const chain = st.id.split(":")[1];
    if (unclearChains.has(chain)) { incomplete.push({ id: st.id, why: "同链 current 说不清，桩先留着" }); continue; }
    const facts = factsOf(ctx, chain);
    const r = removeStubVersion({ root: facts.root, token });
    if (!r.ok) incomplete.push({ id: st.id, why: "删桩：" + String(r.reason) + (r.why ? "（" + r.why + "）" : "") });
  }
  // ④ 门：只有全部项都对得上才 token-CAS 删门；有说不清的项 → 门与账保留。撤门成功但归属转换锁交不还 → 门会一直 transitioning，同样算没做完
  if (incomplete.length > 0) return bail({});
  // ③b 全部对得上才删 staged 私有目录（评审返修：有说不清的项时保留 —— 备份与目标字节都在里面，续跑要用）
  try { fs.rmSync(stagedDirPath(ctx, token), { recursive: true, force: true }); }
  catch (err) { incomplete.push({ id: "staged", why: "staged 目录删不掉：" + errText(err) }); return bail({}); }
  if (doc.steps.some((s) => s.kind === "gate")) {
    const g = ctx.gateOps.removeGate({ file: ctx.gateFile, token });
    if (!g.ok && g.reason !== "absent") { incomplete.push({ id: "gate", why: "撤门失败：" + String(g.reason) + (g.why ? "（" + g.why + "）" : "") }); return bail({}); }
    if (g.txnUncleared) { incomplete.push({ id: "gate", why: "门已撤但归属转换锁交不还：" + g.txnUncleared.path + " —— 所有入口仍按维护中处理，请人工核对后再 --exit --apply" }); return bail({ gateRemoved: true }); }
  }
  // ⑤ 终态先持久化，再清 active；active 清不掉也算没做完（active 留着供重试）
  const terminal = mode === "rollback" ? "rolled_back" : "done";
  const p = setPhase({ dir: ctx.dir, token, lease, phase: terminal, now: ctx.now() });
  if (!p.ok) return { ok: false, reason: "journal_write_failed", why: p.why ?? p.reason, phase: doc.phase };
  afterStep(ctx, "terminal"); // 测试注入点：终态已持久化、active 未清（不变量 14）
  const c = clearActive({ dir: ctx.dir, token });
  if (!c.ok) return { ok: false, phase: terminal, activeCleared: false, activeWhy: String(c.reason) + (c.why ? "（" + c.why + "）" : ""), incomplete: [{ id: "active", why: "active 清不掉：" + String(c.reason) }] };
  return { ok: true, phase: terminal, activeCleared: c.cleared === true };
}

/**
 * 出门：没有 operation → 拒；别的执行者在跑 → 拒；未到不可逆阶段 → 回退；已到 → 只向前；已终结但 active 没清 → 只清 active。
 */
export function exitMaintenance(ctx, { apply = false } = {}) {
  const active = readActive({ dir: ctx.dir });
  if (active.state === "absent") return { ok: false, reason: "no_operation" };
  if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why };
  const token = active.token;
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
  const phase = j.doc.phase;
  const action = TERMINAL_PHASES.includes(phase) ? "clear_active" : phase === "rollback_incomplete" || phase === "rollback_reopening" ? "rollback_forward" : phase === "reopening" || phase === "reopening_incomplete" ? "reopen_forward" : "rollback";
  if (!apply) { const holder = leaseHolder({ dir: ctx.dir, token }); return { ok: true, dryRun: true, token, phase, action, executor: holder.present && holder.alive ? holder.pid : null }; }
  const lease = acquireOperationLease({ dir: ctx.dir, token });
  if (!lease.ok) return { ok: false, reason: lease.reason, why: lease.why, token, path: lease.path };
  let out;
  try {
    if (action === "clear_active") { const c = clearActive({ dir: ctx.dir, token }); out = { ok: c.ok, token, phase, action, activeCleared: c.cleared === true, why: c.ok ? null : String(c.reason) }; }
    else if (action === "reopen_forward") out = { token, action, ...reopening(ctx, token, lease, { mode: "success" }) };
    else if (action === "rollback_forward") out = { token, action, ...reopening(ctx, token, lease, { mode: "rollback" }) };
    else out = { token, action, ...rollbackOperation(ctx, token, lease) };
  } finally { /* 租约在下面统一交还并投影残骸 */ }
  return withLeaseResidue(out, releaseOperationLease(lease));
}
