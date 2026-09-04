/**
 * 账本维护 operation 编排（issue #81 M1 第 2 块；design `docs/architecture/maintenance-gate.md` B 节）。
 *
 * `ledger_init` / `ledger_cutover` 是**独立的维护 operation**：进门做完整 enter（停定时器、切桩、建门、
 * 等进程，复用 `operation.mjs` 的 `enterMaintenance`，keepLease），随后在**门内安静地写账本一笔**（revision=1
 * 的 shadow 或 shadow→authoritative），再按 **B-4** 重新开放（current 回原目标、定时器回原始三态、删桩、撤门、
 * 记 done、清 active）。本模块**不切 runtime、不装新 plist**（与 `maintenance-install` 正交）。
 *
 * `ledger` step 是 §5.2 WAL 收据：`addStepPrepared`（before / intended_after 落盘）→ 写账本 → `markStepDone`。
 * `before`/`intended_after` 由 `topic-agent-ledger.mjs` 的 `initPlan`/`cutoverPlan` 蓝图**先算好**
 * （intended_after.ledger_sha256 在写前就正确，恢复窗口能比对）。
 *
 * 锁序（B 节）：机器级安装面锁 → operation 租约 / active / 门 → 账本锁（`acquireLockUngated` 只在这条受验
 * 路径内允许）。释放次序：先 operation 租约，最后安装面锁。
 *
 * 崩溃恢复（`ledgerExit --apply`）：按 `operation_kind` 分派 —— 未到 forward-only（planned..drained）→ 普通回退
 * （`rollbackOperation`）；已到（ledger_initializing / ledger_cutting_over / ledger_reopening /
 * reopening_incomplete）→ **只向前**：按 B-2 恢复矩阵收敛 ledger step（现场==intended_after → 补 markStepDone；
 * 现场==before → 重试写），绝不进 `rolling_back`。
 *
 * 测试注入点：`ctx.afterStep`（在某一步 done 后抛 `{ simulatedCrash:true }` 模拟进程死在中间）；reconciler 是
 * cutover 的双射对账接口（M1a 未接真对账时恒拒 reconciler_absent）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acquireInstallSurfaceLock } from "../install-surface-lock.mjs";
import { switchCurrentTarget } from "../runtime-install.mjs";
import { chainFacts } from "./precheck.mjs";
import { removeStubVersion } from "./stub.mjs";
import { bootstrapTimer, timerPhase } from "./timers.mjs";
import { TERMINAL_PHASES, acquireOperationLease, addNote, clearActive, enterLedgerForward, markStepDone, readActive, readJournal, releaseOperationLease, setPhase, verifyBackup } from "./journal.mjs";
import { enterMaintenance, rollbackOperation } from "./operation.mjs";
import { authorityCutover, cutoverPlan, initPlan, initializeShadow, loadLedger, reconcileShadow, resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { endpointReceipt } from "./ledger-receipt.mjs";

const CHAINS = ["claude", "codex"];
const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
const ENDPOINT_RE = /^ledger:(endpoint_[0-9a-f]{24}):(init|cutover)$/u;
const LEDGER_FORWARD_PHASES = Object.freeze(["ledger_initializing", "ledger_cutting_over", "ledger_reopening", "reopening_incomplete"]);

// 评审 P1-8：readlink 三态——只有 ENOENT 算“absent”（原本就没有）；EACCES / 其他 IO 是“unclear”（持有状态说不清，不许当“没有”）。
const readlinkOrNull = (p) => { try { return { state: "value", value: fs.readlinkSync(p) }; } catch (err) { return err?.code === "ENOENT" ? { state: "absent", value: null } : { state: "unclear", value: null, why: String(err?.code ?? err?.message) }; } };
const errText = (err) => String(err?.code ?? err?.message ?? err);
const factsOf = (ctx, chain) => chainFacts({ chain, home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, node: ctx.node });
// capability 只携带身份（token/kind/endpointId）；维护目录 / 门位置由 verifier 从 env 派生（评审 F1），不写自述路径
const capabilityOf = (ctx, token, kind, endpointId) => ({ token, kind, endpointId });
// 评审 P1-8：释放失败不许静默吞（release() 自身已包 try/catch，这里只兜“非函数 / 意外抛错”，失败如实报出）。
const releaseSurface = (surface) => {
  if (typeof surface?.release !== "function") return { ok: true };
  try { return surface.release(); } catch (err) { return { ok: false, why: "release_threw：" + String(err?.message ?? err), path: surface.path ?? null }; }
};
const afterStep = (ctx, id) => { if (typeof ctx.afterStep === "function") ctx.afterStep(id); };
const resolveDir = (ctx, endpointId, env) => resolveEndpointDir(endpointId, { env });

/** 蓝图（幂等）：init 直接构造 revision=1；cutover 从现场 shadow 构造。request_key = operation token（设计）。
 *  评审 P1-4：cutover 不接调用方注入 reconciler——`reconcileShadow` 本身 fail-closed 恒拒 reconciler_absent，
 *  真对账接入时在 topic-agent-ledger 的 reconcileShadow 接，且必须经 capability 门。
 */
function planOf({ kind, endpointId, chain, token, ledgerDir }) {
  const requestKey = token;
  if (kind === "init") return initPlan({ endpointId, chain, requestKey, operationId: token });
  const L = loadLedger(ledgerDir, { endpointId });
  if (!L.ok) return { ok: false, reason: L.reason, why: L.why ?? null };
  if (L.doc.authority_mode !== "shadow") return { ok: false, reason: "not_shadow", why: "切权威前置要求 shadow（实际 " + L.doc.authority_mode + "）" };
  const rec = reconcileShadow({ endpointId, shadowDoc: L.doc });
  if (!rec.ok) return rec;
  return cutoverPlan({ endpointId, chain, requestKey, operationId: token, shadowDoc: L.doc, shadowSha: L.sha256, digest: rec.digest });
}

/** 写入：走受验窄事务（capability 门 + 蓝图；plan 由 verifier 从 journal ledger step 重建，不接受调用方 plan）。 */
function doWrite(ctx, { token, kind, endpointId, chain, ledgerDir, env, _inject = null }) {
  const requestKey = token;
  const plan = planOf({ kind, endpointId, chain, token, ledgerDir });
  if (!plan.ok) return plan;
  const cap = capabilityOf(ctx, token, kind === "init" ? "initialize_shadow" : "authority_cutover", endpointId);
  return kind === "init"
    ? initializeShadow({ endpointId, capability: cap, requestKey, chain, env, _inject })
    : authorityCutover({ endpointId, capability: cap, requestKey, chain, env, _inject });
}

const ledgerStep = (plan, sub, endpointId) => ({ id: "ledger:" + endpointId + ":" + sub, kind: "ledger", target: endpointId, before: plan.before, backup: null, intended_after: plan.intendedAfter });
const sceneWhy = (scene) => (scene.why ? "：" + scene.why : "读不出");

/** 现场账本 vs ledger step 的 before / intended_after 判据（B-2）：init.before = absent；cutover.before = 原 shadow 身份。 */
function compareScene(dir, endpointId, step) {
  const sub = step.id.endsWith(":init") ? "init" : "cutover";
  const L = loadLedger(dir, { endpointId });
  const before = step.before ?? null, intended = step.intended_after ?? null;
  const intendedOk = L.ok && L.doc.authority_mode === intended.authority_mode && L.doc.revision === intended.revision && L.sha256 === intended.ledger_sha256;
  if (intendedOk) return { scene: "intended_after" };
  const beforeOk = sub === "init"
    ? (!L.ok && L.reason === "absent")
    : (L.ok && L.doc.authority_mode === before.authority_mode && L.doc.revision === before.revision && L.sha256 === before.ledger_sha256);
  if (beforeOk) return { scene: "before" };
  if (!L.ok) return { scene: "corrupt", why: L.why ?? L.reason };
  return { scene: "corrupt", why: "现场既非 before 也非 intended_after" };
}

/**
 * 向前引擎（幂等、只向前）。从当前阶段出发，把 ledger operation 推进到 done + 清 active（B-2 收敛 + B-4 重开）。
 * `intent`（{kind, endpointId, chain}）只在"drained 进 forward-only 边界"那一刻需要；崩溃重跑自 journal ledger step 重建（P1-1）。
 */
export function ledgerForward(ctx, { token, lease, intent = null, env = process.env, _inject = null } = {}) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
  let doc = j.doc;
  let phase = doc.phase;
  const sub = doc.operation_kind === "ledger_init" ? "init" : doc.operation_kind === "ledger_cutover" ? "cutover" : null;
  if (!sub) return { ok: false, reason: "bad_operation_kind", phase };

  // 1. drained → 落不可逆前向边界（只有首次 ledgerEnter 会到；崩溃重跑在 drained 由 ledgerExit 转回退）
  let planPre = null;
  if (phase === "drained") {
    if (!intent || intent.kind !== sub) return { ok: false, reason: "intent_required", phase, why: "drained 进 forward-only 需要 init/cutover 意图" };
    const dPre = resolveDir(ctx, intent.endpointId, env);
    if (!dPre.ok) return { ok: false, reason: dPre.reason, phase, why: dPre.why };
    // 评审 P1-2：只读前置（收据 / 已初始化 / 已切权威）在 drained 就验，失败留在 drained（rollbackSafe），
    // 不把判定失败留成 forward-only 维护态。cutover 的 reconciler_absent 也在此 fail-closed（P1-4）。
    const receipt = endpointReceipt(ctx.dir, intent.endpointId, { token });
    if (!receipt.ok) return { ok: false, reason: receipt.state, why: receipt.why ?? null, phase, rollbackSafe: true };
    if (sub === "init" && (receipt.initDone || receipt.cutoverDone)) return { ok: false, reason: "already_initialized", why: "该 endpoint 已被初始化或已切权威", phase, rollbackSafe: true };
    if (sub === "cutover" && receipt.cutoverDone) return { ok: false, reason: "already_cutover", why: "该 endpoint 已切权威", phase, rollbackSafe: true };
    // 评审 P1-5：cutover 前置要求恰一份 done init 收据（没有 init 就切权威 → fail-closed，留在 drained）。
    if (sub === "cutover" && !receipt.initDone) return { ok: false, reason: "init_receipt_missing", why: "切权威要求恰一份已 done 的 init 收据（收据 initDone=false）", phase, rollbackSafe: true };
    planPre = planOf({ kind: sub, endpointId: intent.endpointId, chain: intent.chain, token, ledgerDir: dPre.dir });
    if (!planPre.ok) return { ok: false, reason: planPre.reason, why: planPre.why ?? null, phase, rollbackSafe: true };
    const fwd = sub === "init" ? "ledger_initializing" : "ledger_cutting_over";
    // 评审 P1-1：phase 推进 + ledger step（含 chain）合并成一次原子写，杜绝"phase=fwd 但无 step/无 chain"的恢复死窗。
    const pw = enterLedgerForward({ dir: ctx.dir, token, lease, phase: fwd, step: ledgerStep(planPre, sub, intent.endpointId), chain: intent.chain, expectPhase: "drained", now: ctx.now() });
    if (!pw.ok) return { ok: false, reason: pw.reason, why: pw.why ?? null, phase };
    phase = fwd;
    const j2 = readJournal({ dir: ctx.dir, token });
    if (j2.state !== "valid") return { ok: false, reason: "journal_" + j2.state, why: j2.why ?? null, phase };
    doc = j2.doc;
  }

  // 2. 收敛 ledger step（B-2 恢复矩阵：intended_after → 补 markStepDone；before → 重试写）
  if (phase === "ledger_initializing" || phase === "ledger_cutting_over") {
    const ls = doc.steps.find((s) => s.kind === "ledger");
    const endpointId = ls ? (ENDPOINT_RE.exec(ls.id)?.[1] ?? null) : (intent?.endpointId ?? null);
    if (!endpointId) return { ok: false, reason: "endpoint_unknown", phase };
    const chain = ls ? ls.chain : (intent?.chain ?? null); // P1-1：链从 ledger step 读（不赖 note）
    if (!chain) return { ok: false, reason: "chain_unknown", phase, why: "ledger step 无 chain 且无 intent" };
    const d = resolveDir(ctx, endpointId, env);
    if (!d.ok) return { ok: false, reason: d.reason, phase, why: d.why };

    if (ls) {
      // 已有 ledger step（prepared）→ B-2 判据
      const scene = compareScene(d.dir, endpointId, ls);
      if (scene.scene !== "before" && scene.scene !== "intended_after") {
        addNote({ dir: ctx.dir, token, lease, note: "ledger 现场" + sceneWhy(scene) + "，停门待修", now: ctx.now() });
        return { ok: false, reason: "ledger_corrupt", phase, why: scene.why };
      }
      if (scene.scene === "before") {
        const wr = doWrite(ctx, { token, kind: sub, endpointId, chain, ledgerDir: d.dir, env, _inject });
        if (!wr.ok) return { ok: false, reason: wr.reason, why: wr.why ?? null, phase, commit: wr.commit ?? "not_committed", residue: wr.residue ?? null, lockUncleared: wr.lockUncleared ?? null };
        // 评审 P1-5：只有 committed_clean 才视为可推进；committed_with_residue / committed_durability_uncertain 保留门+active，退出码 3。
        if (wr.commit !== "committed_clean") return { ok: false, reason: "commit_residue", phase, commit: wr.commit, residue: wr.residue ?? null, lockUncleared: wr.lockUncleared ?? null, why: wr.why ?? null };
        afterStep(ctx, "written:" + ls.id);
      }
      const m = markStepDone({ dir: ctx.dir, token, lease, id: ls.id, after: ls.intended_after, now: ctx.now() });
      if (!m.ok) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
      afterStep(ctx, ls.id);
    } else {
      // P1-1：正常前向已由 enterLedgerForward 原子写入 phase+step；forward 态无 ledger step 只可能是旧种崩溃 journal，fail-closed。
      return { ok: false, reason: "ledger_step_absent", phase, why: "forward 态却无 ledger step（不应出现；需重建 journal）" };
    }
    const np = setPhase({ dir: ctx.dir, token, lease, phase: "ledger_reopening", expectPhase: phase, now: ctx.now() });
    if (!np.ok) return { ok: false, reason: np.reason, why: np.why ?? null, phase };
    phase = "ledger_reopening";
  }

  // 3. B-4 重开
  if (phase === "ledger_reopening" || phase === "reopening_incomplete") return ledgerReopening(ctx, token, lease);
  return { ok: false, reason: "unexpected_phase", phase };
}

/** 别名：崩溃恢复入口（= 只向前的 ledgerForward）。 */
export const ledgerRecover = ledgerForward;

/** B-4 重新开放：current 回原目标 → 定时器回原始三态 → 删桩 → token-CAS 撤门 → 记 done → 清 active；失败 → reopening_incomplete（门与账保留）。 */
export function ledgerReopening(ctx, token, lease) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
  const doc = j.doc;
  if (doc.phase === "reopening_incomplete") {
    const n = setPhase({ dir: ctx.dir, token, lease, phase: "ledger_reopening", expectPhase: "reopening_incomplete", now: ctx.now() });
    if (!n.ok) return { ok: false, reason: n.reason, why: n.why ?? null, phase: "ledger_reopening" };
  } else if (doc.phase !== "ledger_reopening") {
    return { ok: false, reason: "not_reopening", phase: doc.phase };
  }
  const incomplete = [];
  const note = (t) => addNote({ dir: ctx.dir, token, lease, note: t, now: ctx.now() });
  const noted = (t) => { const n = note(t); return n.ok ? null : { reason: n.reason, why: n.why, path: n.path }; };
  const bail = (extra) => {
    const p = setPhase({ dir: ctx.dir, token, lease, phase: "reopening_incomplete", expectPhase: "ledger_reopening", now: ctx.now(), note: "说不清 " + incomplete.length + " 项：" + incomplete.map((i) => i.id + "（" + i.why + "）").join("；") });
    return { ok: false, phase: "reopening_incomplete", incomplete, journalWrite: p.ok, ...(p.ok ? {} : { journalWhy: p.why ?? p.reason }), ...extra };
  };
  // ① current：回原目标（enter 步 before；账本 operation 无 :install 步）—— 读回三态（P1-8：EACCES 说不清不许当“没有”）
  for (const st of doc.steps.filter((s) => s.kind === "current")) {
    const chain = st.id.split(":")[1];
    const facts = factsOf(ctx, chain);
    const live = readlinkOrNull(facts.current);
    if (live.state === "absent") {
      // 原来就没有 current → 回退到“没有”，对上了；原来有 current 但现场丢了 → 说不清（fail-closed，桩先留着）
      if (st.before === null) continue;
      incomplete.push({ id: st.id, why: "现场没有 current，但原来有（" + st.before + "），说不清" });
      continue;
    }
    if (live.state === "unclear") { incomplete.push({ id: st.id, why: "current 读不出（" + live.why + "），不动" }); continue; }
    if (live.value === st.before) continue;
    if (live.value === st.intended_after) {
      if (st.before === null) { incomplete.push({ id: st.id, why: "原来没有 current，无法回退到「没有」之外的状态" }); continue; }
      const sw = switchCurrentTarget({ root: facts.root, target: st.before });
      if (!sw.ok) { incomplete.push({ id: st.id, why: "切回失败：" + String(sw.why ?? sw.reason) }); continue; }
      const f = noted("current:" + chain + " 已切回 " + st.before);
      if (f !== null) return { ok: false, reason: f.reason, why: f.why, path: f.path, phase: doc.phase };
      continue;
    }
    incomplete.push({ id: st.id, why: "现场 current=" + live.value + " 既不是桩也不是原目标，不动" });
  }
  // 评审 P1-8：同链 current 说不清的链**不得恢复该链定时器**（否则 bootstrap 可能启动指向未知 current 的定时器）。
  const unclearChains = new Set(incomplete.filter((i) => i.id.startsWith("current:")).map((i) => i.id.split(":")[1]));
  // ② 定时器：回原始三态（只有原来 loaded 才需 bootstrap；plist 字节先按备份还原并核 sha256 / 长度）
  for (const st of doc.steps.filter((s) => s.kind === "timer")) {
    const chain = st.id.split(":")[1];
    if (unclearChains.has(chain)) continue; // P1-8：current 说不清，不动该链定时器
    const facts = factsOf(ctx, chain);
    const wantLoaded = st.before.phase === "loaded";
    if (!wantLoaded) continue;
    if (st.backup !== null) {
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
  // ③ 删桩：current 已不指它才删；同链 current 说不清的，桩先留着
  for (const st of doc.steps.filter((s) => s.kind === "stub")) {
    const chain = st.id.split(":")[1];
    if (unclearChains.has(chain)) { incomplete.push({ id: st.id, why: "同链 current 说不清，桩先留着" }); continue; }
    const facts = factsOf(ctx, chain);
    const r = removeStubVersion({ root: facts.root, token });
    if (!r.ok) incomplete.push({ id: st.id, why: "删桩：" + String(r.reason) + (r.why ? "（" + r.why + "）" : "") });
  }
  // ④ 全部对得上才撤门；撤门成功但归属转换锁交不还 → 同样算没做完
  if (incomplete.length > 0) return bail({});
  if (doc.steps.some((s) => s.kind === "gate")) {
    const g = ctx.gateOps.removeGate({ file: ctx.gateFile, token });
    if (!g.ok && g.reason !== "absent") { incomplete.push({ id: "gate", why: "撤门失败：" + String(g.reason) + (g.why ? "（" + g.why + "）" : "") }); return bail({}); }
    if (g.txnUncleared) { incomplete.push({ id: "gate", why: "门已撤但归属转换锁交不还：" + g.txnUncleared.path + " —— 所有入口仍按维护中处理，请人工核对后再 --exit --apply" }); return bail({ gateRemoved: true }); }
  }
  // ⑤ 终态先持久化，再清 active；active 清不掉也算没做完
  const p = setPhase({ dir: ctx.dir, token, lease, phase: "done", expectPhase: "ledger_reopening", now: ctx.now() });
  if (!p.ok) return { ok: false, reason: "journal_write_failed", why: p.why ?? p.reason, phase: doc.phase };
  const c = clearActive({ dir: ctx.dir, token });
  if (!c.ok) return { ok: false, phase: "done", activeCleared: false, activeWhy: String(c.reason) + (c.why ? "（" + c.why + "）" : ""), incomplete: [{ id: "active", why: "active 清不掉：" + String(c.reason) }] };
  return { ok: true, phase: "done", activeCleared: c.cleared === true };
}

/** `ledger_init` / `ledger_cutover` 维护 operation 进门。apply=false 只出 dry-run 计划。 */
export function ledgerEnter(ctx, { kind, endpointId, chain, waitMs = 60000, apply = false, reason = null, env = process.env } = {}) {
  if (kind !== "init" && kind !== "cutover") return { ok: false, reason: "bad_kind" };
  // 评审 P2-2：endpointId 显式类型守卫（避免 undefined/null 被 ENDPOINT_SHAPE.test 偷偷放行）
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "bad_endpoint" };
  if (!CHAINS.includes(chain)) return { ok: false, reason: "bad_chain" };
  const operationKind = kind === "init" ? "ledger_init" : "ledger_cutover";
  const reasonText = reason ?? (kind === "init" ? "账本初始化（shadow）" : "账本切权威（cutover）");
  if (!apply) return enterMaintenance(ctx, { reason: reasonText, waitMs, apply: false, operationKind });
  const surface = acquireInstallSurfaceLock({ home: ctx.home, env });
  if (!surface.ok) return { ok: false, reason: surface.reason, why: surface.why, path: surface.path };
  const ent = enterMaintenance(ctx, { reason: reasonText, waitMs, apply: true, keepLease: true, operationKind });
  if (!ent.ok || !ent.lease) {
    // P1-2：早退分支（!ent.ok / !ent.lease）也必须投影 surfaceRelease——自己拿到锁、自己释放，释放失败不许吞。
    const rel = releaseSurface(surface);
    return { ...ent, surfaceRelease: rel.ok ? null : { path: rel.path ?? null, why: rel.why ?? rel.reason } };
  }
  const out = ledgerForward(ctx, { token: ent.token, lease: ent.lease, intent: { kind, endpointId, chain }, env });
  let rollbackResult = null;
  if (out.ok === false && out.rollbackSafe === true) {
    // 前置条件失败（如 reconciler_absent：账本步未准备、未写盘）→ 回退清场（桩/current/门/active 与进入前一致），不留下维护态
    const rb = rollbackOperation(ctx, ent.token, ent.lease);
    rollbackResult = { ok: rb.phase === "rolled_back", phase: rb.phase ?? null, why: rb.why ?? null };
  }
  const leaseRel = releaseOperationLease(ent.lease);
  const surfaceRel = releaseSurface(surface);
  return { token: ent.token, ...out, rollback: rollbackResult, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason }, surfaceRelease: surfaceRel.ok ? null : { path: surfaceRel.path ?? null, why: surfaceRel.why ?? surfaceRel.reason } };
}

/** `ledger_init` / `ledger_cutover` 出门（含崩溃恢复；按 phase 分派：回退 / 只向前 / 只清 active）。
 *  P1-1：调用方（runMaintenanceGate --apply）已持安装面锁时传入 `surface` 复用，不重取（非重入锁同 pid 也 busy）。
 *  P1-2：所有释放统一投影 surfaceRelease——早退分支（!op.ok / !lease.ok）也吞不掉。 */
export function ledgerExit(ctx, { apply = false, env = process.env, surface: held = null } = {}) {
  const readOp = (dir) => {
    const active = readActive({ dir });
    if (active.state === "absent") return { ok: false, reason: "no_operation" };
    if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why };
    const token = active.token;
    const j = readJournal({ dir, token });
    if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
    const phase = j.doc.phase;
    const action = TERMINAL_PHASES.includes(phase) ? "clear_active" : LEDGER_FORWARD_PHASES.includes(phase) ? "ledger_forward" : "rollback";
    return { ok: true, token, phase, action };
  };
  // 干跑：只读、不带锁（只看有没有 operation / 什么动作）。
  const dry = readOp(ctx.dir);
  if (!dry.ok) return dry;
  if (!apply) return { ok: true, dryRun: true, token: dry.token, phase: dry.phase, action: dry.action };
  // 评审 P1-1：复用调用方持有的安装面锁；没传才自取。
  const owns = held === null;
  const surface = held ?? acquireInstallSurfaceLock({ home: ctx.home, env });
  if (!surface.ok) return { ok: false, reason: surface.reason, why: surface.why, path: surface.path, token: dry.token, phase: dry.phase, action: dry.action };
  // 评审 P1-2：统一经 finalize 投影 surfaceRelease（自己没有锁就不投影，交给调用方负责释放）。
  const releaseHeld = (r) => {
    if (!owns) return r;
    const rel = releaseSurface(surface);
    return { ...r, surfaceRelease: rel.ok ? null : { path: rel.path ?? null, why: rel.why ?? rel.reason } };
  };
  // 评审 P1-8：apply 必须先拿安装面锁，再锁内重读并绑定 active/journal（不许锁前读、锁后沿用；锁间隙改面也不许）。
  const op = readOp(ctx.dir);
  if (!op.ok) return releaseHeld(op);
  const { token, phase, action } = op;
  if (action === "clear_active") {
    const c = clearActive({ dir: ctx.dir, token });
    return releaseHeld({ ok: c.ok, token, phase, action, activeCleared: c.cleared === true, why: c.ok ? null : String(c.reason) });
  }
  const lease = acquireOperationLease({ dir: ctx.dir, token });
  if (!lease.ok) return releaseHeld({ ok: false, reason: lease.reason, why: lease.why, token, phase, action, path: lease.path });
  if (action === "ledger_forward") {
    const f = ledgerForward(ctx, { token, lease, env });
    const leaseRel = releaseOperationLease(lease);
    return releaseHeld({ token, action, ...f, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason } });
  }
  const r = rollbackOperation(ctx, token, lease);
  const leaseRel = releaseOperationLease(lease);
  return releaseHeld({ token, action, ...r, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason } });
}
