/**
 * 维护门 operation 核心（issue #81 PR C）：enter / exit / status。命令面在 scripts/maintenance-gate.mjs。
 *
 * enter（预检 → journal → 停定时器 → 建桩并切 current → 建门 → 等进程）：每一次外部变更都两阶段记账（journal.mjs），
 * 任一步失败按 journal 回退到进门前。exit：未到 reopening → 按 journal CAS 回退；已到不可逆阶段 → 只向前继续（每步幂等）。
 *
 * 恢复规则（只看 journal 里的 prepared / done 与现场）：
 *   prepared 且现场 == before → 没做过，跳过；prepared / done 且现场 == intended_after → 做过：回退方向写回 before；
 *   现场既不是 before 也不是 after → rollback_incomplete（该项留给人，门与账保留）。
 *
 * 测试注入点（只给测试用）：ctx.launchctl / ctx.ps / ctx.sleep / ctx.now / ctx.afterStep（在某一步 done 之后抛 { simulatedCrash:true } 模拟进程死在中间）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGate, maintenanceGatePath, normalizeGateReason, readGate, removeGate } from "../maintenance-gate-core.mjs";
import { switchCurrentTarget } from "../runtime-install.mjs";
import { spawnLaunchctl } from "../launchd-job.mjs";
import { pickClaudeNode } from "../drain-schedule.mjs";
import { bridgeHome as codexBridgeHomeOf } from "../codex/state.mjs";
import { FORWARD_ONLY_PHASES, TERMINAL_PHASES, addNote, addStepPrepared, clearActive, createOperation, maintenanceDir, markStepDone, readActive, readJournal, setPhase } from "./journal.mjs";
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
  dir = maintenanceDir(), gateFile = maintenanceGatePath(), domain = guiDomain(), stepMs = 5000,
} = {}) {
  return { home, codexHome, codexBridgeHome, repoRoot, node, launchctl, ps, sleep, now, afterStep, dir, gateFile, domain, stepMs };
}

const factsOf = (ctx, chain) => chainFacts({ chain, home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, node: ctx.node });

/** 只读状态：门 / active / journal / 两链 current 与桩 / 定时器三态 / reopening 未完。 */
export function maintenanceStatus(ctx) {
  const gate = readGate({ file: ctx.gateFile, now: ctx.now() });
  const active = readActive({ dir: ctx.dir });
  const journal = active.state === "active" ? readJournal({ dir: ctx.dir, token: active.token }) : null;
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
  return { gate, active, journal, phase, pendingReopening, chains, dir: ctx.dir, gateFile: ctx.gateFile };
}

export function renderStatus(s) {
  const lines = ["飞书桥 · 维护门状态（只读）", ""];
  const g = s.gate;
  lines.push("门        ：" + (g.state === "absent" ? "没开" : g.state === "active" ? "开着（" + g.payload.reason + "，已 " + Math.floor(g.ageMs / 60000) + " 分钟，token " + String(g.payload.token).slice(0, 8) + "）" : g.state === "transitioning" ? "正在切换（" + g.why + "）" : "读不出（" + g.why + "）—— 请人工核对 " + s.gateFile));
  lines.push("operation ：" + (s.active.state === "absent" ? "没有" : s.active.state === "unreadable" ? "active 读不出（" + s.active.why + "）—— 请人工核对 " + path.join(s.dir, "active") : s.journal.state === "valid" ? "token " + s.active.token.slice(0, 8) + "，阶段 " + s.phase + (s.pendingReopening ? "（重新开放未完 —— 跑 --exit --apply 只向前继续）" : TERMINAL_PHASES.includes(s.phase) ? "（已终结，active 未清 —— 跑 --exit --apply 只清 active）" : "") : "journal " + s.journal.state + (s.journal.why ? "（" + s.journal.why + "）" : "") + " —— 请人工核对 " + path.join(s.dir, s.active.token + ".json")));
  for (const chain of CHAINS) {
    const c = s.chains[chain];
    lines.push((chain === "claude" ? "Claude 链 " : "Codex 链  ") + "：current → " + (c.current ?? "（没有）") + (c.isStub ? "（维护桩" + (c.stubManifest?.state === "valid" ? "，原目标 " + c.stubManifest.doc.original_current : "，清单读不出") + "）" : "") + "；定时器 " + c.timer + (c.stubs.length > 0 && !c.isStub ? "；残留桩目录 " + c.stubs.join("、") : ""));
  }
  if (s.journal?.state === "valid") for (const st of s.journal.doc.steps) lines.push("  · " + st.id + " " + st.state + (st.state === "done" ? " → " + JSON.stringify(st.after) : "（prepared，现场核对后决定）"));
  return lines.join("\n");
}

class SimulatedCrash extends Error { constructor(id) { super("simulated crash after " + id); this.simulatedCrash = true; } }
const afterStep = (ctx, id) => { if (typeof ctx.afterStep === "function") ctx.afterStep(id); };

/**
 * 进门。apply=false 只做预检并给计划。返回 { ok, token, phase } 或 { ok:false, reason, ..., rollback }。
 */
export function enterMaintenance(ctx, { reason, waitMs = 60000, apply = false } = {}) {
  const normalized = normalizeGateReason(reason);
  if (typeof reason !== "string" || reason.trim().length === 0) return { ok: false, reason: "reason_required" };
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
  if (!op.ok) return { ok: false, reason: op.reason, why: op.why ?? null, token: op.token ?? null };
  const token = op.token;
  const J = (r, what) => { if (!r.ok) throw Object.assign(new Error(what + "：" + String(r.reason) + (r.why ? "（" + r.why + "）" : "")), { opReason: "journal_write_failed" }); return r; };
  try {
    // ── 定时器：先记账（原始三态 + plist 原字节备份）再 bootout
    for (const chain of CHAINS) {
      const t = pre.chains[chain].timer, facts = pre.chains[chain].facts;
      let backup = null;
      if (t.plistBytes !== null) { backup = path.join(ctx.dir, token + "." + chain + ".plist"); fs.writeFileSync(backup, t.plistBytes, { mode: 0o600 }); }
      J(addStepPrepared({ dir: ctx.dir, token, now: ctx.now(), step: { id: "timer:" + chain, kind: "timer", target: facts.timer.label, before: { phase: t.phase, plist: facts.timer.plistFile }, backup, intended_after: { phase: t.phase === "loaded" ? "installed_not_loaded" : t.phase } } }), "记 timer");
      if (t.phase === "loaded") {
        const r = bootoutTimer({ label: facts.timer.label, domain: ctx.domain, run: ctx.launchctl });
        if (!r.ok) throw Object.assign(new Error("停定时器（" + chain + "）：" + r.why), { opReason: "timer_stop_failed" });
      }
      J(markStepDone({ dir: ctx.dir, token, now: ctx.now(), id: "timer:" + chain, after: { phase: t.phase === "loaded" ? "installed_not_loaded" : t.phase } }), "记 timer done");
      afterStep(ctx, "timer:" + chain);
    }
    J(setPhase({ dir: ctx.dir, token, phase: "timer_stopped", now: ctx.now() }), "phase");
    // ── 桩：先建目录（不可达缓存），再记账切 current
    for (const chain of CHAINS) {
      const facts = pre.chains[chain].facts, orig = plan.chains[chain].current;
      J(addStepPrepared({ dir: ctx.dir, token, now: ctx.now(), step: { id: "stub:" + chain, kind: "stub", target: path.join(facts.root, "versions", stubDirName(token)), before: null, backup: null, intended_after: stubRelTarget(token) } }), "记 stub");
      const b = buildStubVersion({ root: facts.root, token, reason: normalized, at: new Date(ctx.now()).toISOString(), entries: plan.chains[chain].entries, agentUid: plan.chains[chain].agentUid, originalCurrent: orig });
      if (!b.ok) throw Object.assign(new Error("建桩（" + chain + "）：" + String(b.reason) + (b.why ? "（" + b.why + "）" : "")), { opReason: "stub_build_failed" });
      J(markStepDone({ dir: ctx.dir, token, now: ctx.now(), id: "stub:" + chain, after: b.rel }), "记 stub done");
      afterStep(ctx, "stub:" + chain);
    }
    for (const chain of CHAINS) {
      const facts = pre.chains[chain].facts, orig = plan.chains[chain].current;
      J(addStepPrepared({ dir: ctx.dir, token, now: ctx.now(), step: { id: "current:" + chain, kind: "current", target: facts.current, before: orig, backup: null, intended_after: stubRelTarget(token) } }), "记 current");
      const live = readlinkOrNull(facts.current);
      if (live !== orig) throw Object.assign(new Error("切桩前 current（" + chain + "）已变：" + String(live)), { opReason: "current_changed" });
      const sw = switchCurrentTarget({ root: facts.root, target: stubRelTarget(token) });
      if (!sw.ok) throw Object.assign(new Error("切桩（" + chain + "）：" + String(sw.why ?? sw.reason)), { opReason: "current_switch_failed" });
      J(markStepDone({ dir: ctx.dir, token, now: ctx.now(), id: "current:" + chain, after: sw.after }), "记 current done");
      afterStep(ctx, "current:" + chain);
    }
    J(setPhase({ dir: ctx.dir, token, phase: "stubbed", now: ctx.now() }), "phase");
    // ── 门
    J(addStepPrepared({ dir: ctx.dir, token, now: ctx.now(), step: { id: "gate", kind: "gate", target: ctx.gateFile, before: null, backup: null, intended_after: { token } } }), "记 gate");
    const g = createGate({ file: ctx.gateFile, reason: normalized, token, now: ctx.now() });
    if (!g.ok) throw Object.assign(new Error("建门：" + String(g.reason) + (g.why ? "（" + g.why + "）" : "")), { opReason: "gate_create_failed" });
    J(markStepDone({ dir: ctx.dir, token, now: ctx.now(), id: "gate", after: { token, txnUncleared: g.txnUncleared ?? null } }), "记 gate done");
    afterStep(ctx, "gate");
    J(setPhase({ dir: ctx.dir, token, phase: "gated", now: ctx.now() }), "phase");
    // ── 等既有进程退出（只认桩清单里的入口；不 kill）
    const roots = [];
    for (const chain of CHAINS) {
      const facts = pre.chains[chain].facts, orig = plan.chains[chain].current;
      roots.push(path.join(facts.current, "scripts"));
      if (orig !== null) roots.push(path.join(facts.root, orig, "scripts"));
    }
    const q = waitForQuiet({ roots, waitMs, stepMs: ctx.stepMs, ps: ctx.ps, now: ctx.now, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) });
    if (!q.ok) throw Object.assign(new Error(q.reason === "processes_still_running" ? "等进程超时，残留：" + q.processes.map((p) => p.pid + " " + p.command).join("；") : "进程盘点做不了：" + String(q.why)), { opReason: q.reason, processes: q.processes ?? null });
    J(setPhase({ dir: ctx.dir, token, phase: "drained", now: ctx.now(), note: "等了 " + q.waitedMs + " ms" }), "phase");
    return { ok: true, token, phase: "drained", plan };
  } catch (err) {
    if (err?.simulatedCrash) throw err;
    const rollback = rollbackOperation(ctx, token);
    return { ok: false, reason: err?.opReason ?? "enter_failed", why: String(err?.message ?? err), token, processes: err?.processes ?? null, rollback };
  }
}

/**
 * 回退（未到不可逆阶段时）：rolling_back（此处还没有线上制品要恢复；PR C 第二步的 staged / committed 会在这里先恢复制品并核验）
 * → rollback_reopening（不可逆）：current 回原目标 → 定时器回原始三态 → 删桩 → token-CAS 删门 → 持久化终态 → 最后清 active。
 */
export function rollbackOperation(ctx, token) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null };
  if (!FORWARD_ONLY_PHASES.includes(j.doc.phase)) {
    const p = setPhase({ dir: ctx.dir, token, phase: "rolling_back", now: ctx.now() });
    if (!p.ok) return { ok: false, reason: "journal_write_failed", why: p.why ?? p.reason };
    const p2 = setPhase({ dir: ctx.dir, token, phase: "rollback_reopening", now: ctx.now() });
    if (!p2.ok) return { ok: false, reason: "journal_write_failed", why: p2.why ?? p2.reason };
  }
  return reopening(ctx, token, { mode: "rollback" });
}

/**
 * 重新开放（不可逆、幂等、只向前）。mode:"rollback" → current 回 before、定时器回原始三态；mode:"success"（PR C 第二步）→ current 已由 commit 指向新版本、定时器到目标状态。
 * 有 CAS 不成立项 → rollback_incomplete：不删门、不清 active，门与账保留给人。
 */
export function reopening(ctx, token, { mode }) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null };
  const doc = j.doc;
  const incomplete = [];
  const note = (t) => addNote({ dir: ctx.dir, token, note: t, now: ctx.now() });
  // ① current：CAS —— 现场 == intended_after（桩）→ 切回 before；== before → 没做过 / 已回；否则说不清
  for (const st of doc.steps.filter((s) => s.kind === "current")) {
    const chain = st.id.split(":")[1];
    const facts = factsOf(ctx, chain);
    const live = readlinkOrNull(facts.current);
    if (mode === "rollback") {
      if (live === st.before) continue;
      if (live === st.intended_after) {
        if (st.before === null) { incomplete.push({ id: st.id, why: "原来没有 current，无法回退到「没有」之外的状态" }); continue; }
        const sw = switchCurrentTarget({ root: facts.root, target: st.before });
        if (!sw.ok) { incomplete.push({ id: st.id, why: "切回失败：" + String(sw.why ?? sw.reason) }); continue; }
        note("current:" + chain + " 已切回 " + st.before);
        continue;
      }
      incomplete.push({ id: st.id, why: "现场 current=" + String(live) + " 既不是桩也不是原目标，不动" });
    } else if (live !== null && isStubTarget(live)) {
      incomplete.push({ id: st.id, why: "成功路径 reopening 时 current 仍指桩（commit 没完成？）" });
    }
  }
  // ② 定时器：回原始三态（rollback）—— 只有原来 loaded 才需要 bootstrap；plist 字节先按备份还原
  for (const st of doc.steps.filter((s) => s.kind === "timer")) {
    const chain = st.id.split(":")[1];
    const facts = factsOf(ctx, chain);
    const wantLoaded = mode === "rollback" ? st.before?.phase === "loaded" : (chain === "claude" || st.before?.phase === "loaded");
    if (!wantLoaded) continue;
    if (mode === "rollback" && st.backup !== null) {
      let backupBytes = null;
      try { backupBytes = fs.readFileSync(st.backup); } catch (err) { incomplete.push({ id: st.id, why: "plist 备份读不出：" + errText(err) }); continue; }
      let liveBytes = null;
      try { liveBytes = fs.readFileSync(facts.timer.plistFile); } catch { liveBytes = null; }
      if (liveBytes === null || !liveBytes.equals(backupBytes)) {
        try { fs.mkdirSync(path.dirname(facts.timer.plistFile), { recursive: true }); fs.writeFileSync(facts.timer.plistFile, backupBytes); }
        catch (err) { incomplete.push({ id: st.id, why: "plist 写回失败：" + errText(err) }); continue; }
      }
    }
    const cur = timerPhase({ ...facts.timer, run: ctx.launchctl });
    if (cur.phase === "loaded") continue;
    const r = bootstrapTimer({ label: facts.timer.label, plistFile: facts.timer.plistFile, expect: facts.timer.expect, domain: ctx.domain, run: ctx.launchctl });
    if (!r.ok) { incomplete.push({ id: st.id, why: "定时器恢复失败：" + r.why }); continue; }
    note("timer:" + chain + " 已恢复 loaded");
  }
  // ③ 删桩：current 已不指它才删；同链 current 说不清的，桩先留着（人要把 current 指回桩再出门，桩没了就没得回）
  const unclearChains = new Set(incomplete.map((i) => i.id.split(":")[1]));
  for (const st of doc.steps.filter((s) => s.kind === "stub")) {
    const chain = st.id.split(":")[1];
    if (unclearChains.has(chain)) { incomplete.push({ id: st.id, why: "同链 current 说不清，桩先留着" }); continue; }
    const facts = factsOf(ctx, chain);
    const r = removeStubVersion({ root: facts.root, token });
    if (!r.ok) incomplete.push({ id: st.id, why: "删桩：" + String(r.reason) + (r.why ? "（" + r.why + "）" : "") });
  }
  // ④ 门：只有全部项都对得上才 token-CAS 删门；有说不清的项 → 门与账保留
  if (incomplete.length > 0) {
    const p = setPhase({ dir: ctx.dir, token, phase: "rollback_incomplete", now: ctx.now(), note: "说不清 " + incomplete.length + " 项：" + incomplete.map((i) => i.id + "（" + i.why + "）").join("；") });
    return { ok: false, phase: "rollback_incomplete", incomplete, journalWrite: p.ok };
  }
  if (doc.steps.some((s) => s.kind === "gate")) {
    const g = removeGate({ file: ctx.gateFile, token });
    if (!g.ok && g.reason !== "absent") {
      const p = setPhase({ dir: ctx.dir, token, phase: "rollback_incomplete", now: ctx.now(), note: "撤门失败：" + String(g.reason) + (g.why ? "（" + g.why + "）" : "") });
      return { ok: false, phase: "rollback_incomplete", incomplete: [{ id: "gate", why: String(g.reason) }], journalWrite: p.ok };
    }
    if (g.txnUncleared) note("撤门的归属转换锁交不还：" + g.txnUncleared.path);
  }
  // ⑤ 终态先持久化，再清 active
  const terminal = mode === "rollback" ? "rolled_back" : "done";
  const p = setPhase({ dir: ctx.dir, token, phase: terminal, now: ctx.now() });
  if (!p.ok) return { ok: false, reason: "journal_write_failed", why: p.why ?? p.reason, phase: doc.phase };
  const c = clearActive({ dir: ctx.dir, token });
  return { ok: true, phase: terminal, activeCleared: c.cleared === true, activeWhy: c.ok ? null : String(c.reason) };
}

/**
 * 出门：没有 operation → 拒；未到不可逆阶段 → 回退；已到 → 只向前；已终结但 active 没清 → 只清 active。
 */
export function exitMaintenance(ctx, { apply = false } = {}) {
  const active = readActive({ dir: ctx.dir });
  if (active.state === "absent") return { ok: false, reason: "no_operation" };
  if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why };
  const token = active.token;
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
  const phase = j.doc.phase;
  const action = TERMINAL_PHASES.includes(phase) && phase !== "rollback_incomplete" ? "clear_active" : phase === "rollback_incomplete" || phase === "rollback_reopening" ? "rollback_forward" : phase === "reopening" ? "reopen_forward" : "rollback";
  if (!apply) return { ok: true, dryRun: true, token, phase, action };
  if (action === "clear_active") { const c = clearActive({ dir: ctx.dir, token }); return { ok: c.ok, token, phase, action, activeCleared: c.cleared === true, why: c.ok ? null : String(c.reason) }; }
  if (action === "reopen_forward") return { token, action, ...reopening(ctx, token, { mode: "success" }) };
  if (action === "rollback_forward") return { token, action, ...reopening(ctx, token, { mode: "rollback" }) };
  return { token, action, ...rollbackOperation(ctx, token) };
}
