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
import { collectClaudeLegacySnapshot, collectCodexLegacySnapshot } from "../m1a/legacy-snapshot.mjs";
import { prepareLegacyCutoverEndpoint, reconcileLegacyEndpoint } from "../m1a/reconcile.mjs";
import { readStagedVerified, removeStagedPlan, stageBackupFiles, stageCutoverPlan, stagedIntendedFile } from "../m1b/staged-plan.mjs";
import { verifyCutoverPlan } from "../m1b/cutover-plan.mjs";
import { chainFacts } from "./precheck.mjs";
import { removeStubVersion } from "./stub.mjs";
import { bootstrapTimer, timerPhase } from "./timers.mjs";
import { readSidecarCurrent, writeSidecarPrepared } from "./sidecar-writer.mjs";
import { TERMINAL_PHASES, acquireOperationLease, addNote, clearActive, enterLedgerForward, markStepDone, readActive, readJournal, releaseOperationLease, setPhase, verifyBackup } from "./journal.mjs";
import { enterMaintenance, rollbackOperation } from "./operation.mjs";
import { authorityCutover, cutoverPlan, ensureLedgerRoot, initPlan, initializeShadow, loadLedger, resolveEndpointDir } from "../topic-agent-ledger.mjs";
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

/** M1a 真对账的 legacy 采集（R45：cutover 前置从「恒拒的 reconciler_absent」换成真对账；测试注入走 env）。 */
const collectFor = (ctx, chain, env) => chain === "claude"
  ? collectClaudeLegacySnapshot({
      registryFile: env.FEISHU_BRIDGE_REGISTRY ?? path.join(ctx.home, ".claude", "feishu-bridge", "registry.json"),
      templateFile: env.FEISHU_BRIDGE_CHAIN_TEMPLATE ?? path.join(ctx.home, ".claude", "feishu-bridge", "chain-config.json"),
    })
  : collectCodexLegacySnapshot({ home: ctx.codexBridgeHome });

// R45 三轮 P1-1：面拆分。公共 reconcileFor 走 reconcileLegacyEndpoint（预览/doctor 安全面，每键恰 {sha256}，无字节明文）；
// 私有 prepareFor 走 prepareLegacyCutoverEndpoint（T4 私有接口，plan 锚与 verifyCutoverPlan 需要受验字节）——
// grep 守卫只查私有接口字面名，经公共包装别名转发就能绕过；现在预览面数据源不再可能携字节。
export const reconcileFor = ({ ctx, chain, endpointId, ledgerDir, env }) => reconcileLegacyEndpoint({
  endpointId, chain,
  collectLegacy: () => collectFor(ctx, chain, env),
  loadLedgerFn: () => loadLedger(ledgerDir, { endpointId }),
});

const prepareFor = ({ ctx, chain, endpointId, ledgerDir, env }) => prepareLegacyCutoverEndpoint({
  endpointId, chain,
  collectLegacy: () => collectFor(ctx, chain, env),
  loadLedgerFn: () => loadLedger(ledgerDir, { endpointId }),
});

const shaHex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** sidecar 现场探测（staging 前，P1-5 顺带取回原字节做备份）：走唯一受验 sidecar 读取器 readSidecarCurrent
 *  （普通文件/单硬链接/0600/≤1MiB/读满，FIFO、多硬链接、超限文件在探查即拒，不再无界读）。
 *  absent → {exists:false}；在 → {exists:true, sha256, buf}；读不清 → fail-closed（sidecar_unclear）。 */
const probeBefore = (file) => {
  const cur = readSidecarCurrent(file);
  if (!cur.present) return { exists: false, sha256: null, buf: null };
  if (cur.problem !== undefined) return { exists: "unclear", sha256: null, buf: null, why: cur.problem };
  return { exists: true, sha256: cur.sha256, buf: cur.buf };
};

/** staging（4c/4d 冻结 S1，P1-3/P1-5 返修）：对账结果（rec，ok 支已带三 sidecar 受验字节）与账本快照（L）都来自 planOf
 *  的**同一次 reconcile**；先探测三条 sidecar 现场（零写盘，unclear 直接拒）→ 构造 plan → stageCutoverPlan 建树 →
 *  stageBackupFiles 把既有 sidecar 原字节备份进 staged → 产三条 prepared sidecar step（backup 三字段与 journal 1.3 键集）。
 *  snapshot_identity 原样透传（identityOf 的封闭域 source 标注在受验读时点就有）——编排层不再盖 source 章。 */
function stageCutover(ctx, { token, endpointId, ledgerDir, rec, L }) {
  // P1-5：三条 sidecar 现场先探（absent/在/unclear 三态 + 原字节）；unclear 在 stage 前拒，不留任何写盘残骸。
  const probes = {};
  for (const k of ["expiry", "pending_claims", "policy"]) {
    const name = k === "pending_claims" ? "pending-claims" : k;
    const before = probeBefore(path.join(ledgerDir, name + ".json"));
    if (before.exists === "unclear") return { ok: false, reason: "sidecar_unclear", why: name + ".json 读不出（" + before.why + "），不stage" };
    probes[k] = { name, before };
  }
  const blobs = {
    // R45 二轮 P1-1：受验字节引用在 T4 私有面的 {sha256, bytes} 里
    expiry: rec.sidecars.expiry.bytes,
    pending_claims: rec.sidecars.pending_claims.bytes,
    policy: rec.sidecars.policy.bytes,
  };
  const plan = {
    schema_version: "m1a-cutover-plan-1",
    operation_token: token,
    endpoint_id: endpointId,
    digest: rec.digest,
    ledger: { revision: L.doc.revision, sha256: L.sha256 },
    snapshot_identity: rec.snapshot_identity,
    sidecars: {
      expiry: { sha256: shaHex(blobs.expiry) },
      pending_claims: { sha256: shaHex(blobs.pending_claims) },
      policy: { sha256: shaHex(blobs.policy) },
    },
  };
  const st = stageCutoverPlan({ dir: ctx.dir, token, plan, blobs });
  if (!st.ok) return st;
  // P1-5：既有 sidecar 的原字节备份进 staged（原文件缺席 → files[k]=null，不备份；journal 侧 before.exists=false 必无备份）。
  const bk = stageBackupFiles({ dir: ctx.dir, token, files: {
    expiry: probes.expiry.before.exists ? probes.expiry.before.buf : null,
    pending_claims: probes.pending_claims.before.exists ? probes.pending_claims.before.buf : null,
    policy: probes.policy.before.exists ? probes.policy.before.buf : null,
  } });
  if (!bk.ok) return bk;
  const sidecarSteps = [];
  for (const k of ["expiry", "pending_claims", "policy"]) {
    const { name, before } = probes[k];
    const anchor = plan.sidecars[k];
    const backup = bk.backups[k];
    sidecarSteps.push({
      id: "sidecar:" + name + ":" + endpointId,
      kind: "sidecar",
      target: "ledger/" + endpointId + "/" + name + ".json", // 1.3 合同：相对账本根的路径（4f 重算同一公式）
      // fileState 键集封闭（exists,sha256）—— probeBefore 的 buf 只喂 stageBackupFiles，不进 journal。
      before: { exists: before.exists, sha256: before.sha256 },
      backup: backup?.path ?? null,
      backup_sha256: backup?.sha256 ?? null,
      backup_bytes: backup?.bytes ?? null,
      intended_blob: { path: stagedIntendedFile({ dir: ctx.dir, token, name }), bytes: blobs[k].byteLength, sha256: anchor.sha256 },
      intended_after: { exists: true, sha256: anchor.sha256 },
    });
  }
  return { ok: true, plan_sha256: st.plan_sha256, sidecarSteps };
}

/** 蓝图（幂等）：init 直接构造 revision=1；cutover 从现场 shadow + M1a 真对账构造（R45：reconcileShadow 的恒拒占位退出生产路径）。
 *  request_key = operation token（设计）。
 *  评审 P1-4 保留：调用方注入 reconciler 依旧不接——对账走 reconcileLegacyEndpoint（M1a），reconcileShadow 只留给直接调用方（恒拒红线）。
 */
function planOf({ kind, endpointId, chain, token, ledgerDir, ctx, env }) {
  const requestKey = token;
  if (kind === "init") return initPlan({ endpointId, chain, requestKey, operationId: token });
  const L1 = loadLedger(ledgerDir, { endpointId });
  if (!L1.ok) return { ok: false, reason: L1.reason, why: L1.why ?? null };
  if (L1.doc.authority_mode !== "shadow") return { ok: false, reason: "not_shadow", why: "切权威前置要求 shadow（实际 " + L1.doc.authority_mode + "）" };
  const rec = prepareFor({ ctx, chain, endpointId, ledgerDir, env });
  if (!rec.ok) return { ok: false, reason: rec.reason, why: rec.why ?? (rec.mismatches ? "双射不等（" + rec.mismatches.length + " 条）" : null) };
  // 对账期间账本被旁路改写（revision / 整文件 SHA 任一变）→ 蓝图作废，fail-closed。
  const L2 = loadLedger(ledgerDir, { endpointId });
  if (!L2.ok) return { ok: false, reason: L2.reason, why: L2.why ?? null };
  if (L2.doc.revision !== L1.doc.revision || L2.sha256 !== L1.sha256) {
    return { ok: false, reason: "ledger_moved", why: "账本在对账期间变化（revision " + L1.doc.revision + "→" + L2.doc.revision + "）" };
  }
  // P1-4：cutover_blockers 是硬门——双射 ok 也可能带着待修项（如 retired binding 未清），非空必拒。
  if (rec.cutover_blockers.length > 0) {
    return { ok: false, reason: "cutover_blocked", why: "对账待修项未清（" + rec.cutover_blockers.length + " 条：" + rec.cutover_blockers.map((b) => b.code).join("、") + "）" };
  }
  const cp = cutoverPlan({
    endpointId, chain, requestKey, operationId: token, shadowDoc: L2.doc, shadowSha: L2.sha256, digest: rec.digest,
    sidecarShas: {
      expiry: rec.sidecars.expiry.sha256,
      pending_claims: rec.sidecars.pending_claims.sha256,
      policy: rec.sidecars.policy.sha256,
    },
  });
  if (!cp.ok) return cp;
  return { ...cp, rec, L: L2 };
}

/** 写入：走受验窄事务（capability 门 + 蓝图；plan 由 verifier 从 journal ledger step 重建，不接受调用方 plan）。 */
function doWrite(ctx, { token, kind, endpointId, chain, ledgerDir, env, _inject = null }) {
  const requestKey = token;
  // P2-2：planOf 接 ctx/env——env 注入（registry 路径等）在 planOf 内的 reconcileFor 同样生效。
  const plan = planOf({ kind, endpointId, chain, token, ledgerDir, ctx, env });
  if (!plan.ok) return plan;
  const cap = capabilityOf(ctx, token, kind === "init" ? "initialize_shadow" : "authority_cutover", endpointId);
  return kind === "init"
    ? initializeShadow({ endpointId, capability: cap, requestKey, chain, env, _inject })
    : authorityCutover({ endpointId, capability: cap, requestKey, chain, env, _inject });
}

/** R45：journal 锚驱动的 ledger step（蓝图字段是 intendedAfter；1.3 键集：init 六键不补 plan_sha256，cutover 八键 before.plan_sha256=null、intended_after.plan_sha256=staged plan SHA）。 */
const ledgerStep = (plan, sub, endpointId, planSha = null) => ({
  id: "ledger:" + endpointId + ":" + sub, kind: "ledger", target: endpointId,
  before: sub === "cutover" ? { ...plan.before, plan_sha256: null } : plan.before,
  backup: null,
  intended_after: sub === "cutover" ? { ...plan.intendedAfter, plan_sha256: planSha } : plan.intendedAfter,
});
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

/** R45 复合提交（§4.1 4c/4d/4f/5）：①逐 sidecar 窄写（journal 锚驱动，幂等）→ ②门内二次重验（live collect + 五等式 + 4f）。
 *  两次对账都在本函数内：S1 已在 stageCutover 时冻结进 plan；这里取 S2 = live collect，verifyCutoverPlan 核 S2 与 plan 锚自洽。
 *  返回后调用方才到唯一提交点 authority_cutover；本函数不碰账本。 */
// R45 三轮 P2-1：writer 的锁类失败本就结构化带路径（residue/releaseResidue/lock），但编排层曾把它折成 {reason, why}，
// CLI 面打不出 .reap/主锁真实路径，人工只能全盘翻 ledger。这里归一成 lockUncleared:{path,reason,error}
// —— 与 doWrite 透传约定（m1b 回执字段同形）一致，releaseRows（"账本主锁交不还："+path）直接可用。
const lockUnclearedOf = (w) => {
  if (w.residue) return { path: w.residue.path ?? null, reason: "fence_reap_uncleared", error: w.residue.error ?? null };
  if (w.releaseResidue?.reapUncleared) return { path: w.releaseResidue.reapUncleared.path ?? null, reason: "release_reap_uncleared", error: w.releaseResidue.reapUncleared.error ?? null };
  if (w.releaseResidue?.absent === true || typeof w.release === "string") return { path: w.lock ?? null, reason: "release_" + (w.releaseResidue?.absent === true ? "absent" : String(w.release)), error: null };
  if (w.lock) return { path: w.lock, reason: String(w.reason), error: w.why ?? null };
  return null;
};

function convergeSidecars(ctx, { token, lease, gateFile, env, endpointId, chain, ledgerDir, doc, ls }) {
  const sidecarSteps = doc.steps.filter((s) => s.kind === "sidecar");
  if (sidecarSteps.length !== 3) return { ok: false, reason: "sidecar_steps_missing", why: "cutting_over 应有三条 sidecar step（实际 " + sidecarSteps.length + "）" };
  for (const st of sidecarSteps) {
    const name = st.id.split(":")[1];
    // P1-1：writer 写前核 op token + operation lease + gate 三绑定活（gateFile 由编排层从 ctx 供给）。
    const w = writeSidecarPrepared({ dir: ctx.dir, token, lease, gateFile, endpointId, name, ledgerDir, now: ctx.now() });
    if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, lockUncleared: lockUnclearedOf(w) };
    if (w.written) afterStep(ctx, "written:" + st.id);
  }
  // 门内二次重验：staged plan 受验读（SHA 锚 = ledger step intended_after.plan_sha256）
  const planSha = ls.intended_after?.plan_sha256;
  if (!(typeof planSha === "string" && /^[0-9a-f]{64}$/u.test(planSha))) return { ok: false, reason: "plan_anchor_missing", why: "ledger step intended_after.plan_sha256 缺失（1.3 八键）" };
  const pb = readStagedVerified(path.join(ctx.dir, token + ".staged", "intended", "plan.json"), { sha256: planSha });
  if (!pb.ok) return { ok: false, reason: "staged_plan_unreadable", why: pb.why ?? pb.reason };
  const rec2 = prepareFor({ ctx, chain, endpointId, ledgerDir, env });
  if (!rec2.ok) return { ok: false, reason: rec2.reason, why: rec2.why ?? null };
  // P1-4：二次重验同样过 blockers 硬门——staging 后清了项又冒出新待修项（或 staging 本就不该过）都在这里拦。
  if (rec2.cutover_blockers.length > 0) {
    return { ok: false, reason: "cutover_blocked", why: "二次重验发现待修项（" + rec2.cutover_blockers.length + " 条：" + rec2.cutover_blockers.map((b) => b.code).join("、") + "）" };
  }
  // 账本 CAS：重验时刻的活读（M1a 对账返回不带账本身份，CAS 由编排器供）。
  const L2 = loadLedger(ledgerDir, { endpointId });
  if (!L2.ok) return { ok: false, reason: L2.reason, why: L2.why ?? null };
  const v = verifyCutoverPlan({ planBytes: pb.buf, doc, ledgerStep: ls, sidecarSteps, ledgerEndpointId: endpointId, reconcile: { ...rec2, ledger: { revision: L2.doc.revision, sha256: L2.sha256 } } });
  if (!v.ok) return { ok: false, reason: v.reason, why: v.why ?? null };
  return { ok: true, planSha };
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
    // 评审 P1-2 + 返修 P2：只读前置（收据 / 已初始化 / 已切权威）在 drained 就验，失败留在 drained（rollbackSafe），
    // 且**先于 provision** —— already_* 失败都不会留下空根。cutover 的 reconciler_absent 也在此 fail-closed（P1-4）。
    const receipt = endpointReceipt(ctx.dir, intent.endpointId, { token });
    if (!receipt.ok) return { ok: false, reason: receipt.state, why: receipt.why ?? null, phase, rollbackSafe: true };
    if (sub === "init" && (receipt.initDone || receipt.cutoverDone)) return { ok: false, reason: "already_initialized", why: "该 endpoint 已被初始化或已切权威", phase, rollbackSafe: true };
    if (sub === "cutover" && receipt.cutoverDone) return { ok: false, reason: "already_cutover", why: "该 endpoint 已切权威", phase, rollbackSafe: true };
    // 评审 P1-5：cutover 前置要求恰一份 done init 收据（没有 init 就切权威 → fail-closed，留在 drained）。
    if (sub === "cutover" && !receipt.initDone) return { ok: false, reason: "init_receipt_missing", why: "切权威要求恰一份已 done 的 init 收据（收据 initDone=false）", phase, rollbackSafe: true };
    // 返修 P1-1 + P2：provision 只发生在 drained 且**只读 precheck 全过后**（仅 init）。cutover 不 provision ——
    // init 已建成根，根缺席是真实故障应 fail，绝不静默重建。forward 态（initializing/cutting_over/reopening）
    // 一律不 provision —— 根丢失 → fail-closed（done 收据 + 账本缺席 = 说不清），不得重建。
    if (sub === "init") {
      const prov = ensureLedgerRoot({ env });
      if (!prov.ok) {
        addNote({ dir: ctx.dir, token, lease, note: "账本根不能安全创建：" + (prov.why ?? prov.reason), now: ctx.now() });
        return { ok: false, reason: prov.reason, phase, why: prov.why ?? null, rollbackSafe: true };
      }
    }
    const dPre = resolveDir(ctx, intent.endpointId, env);
    if (!dPre.ok) return { ok: false, reason: dPre.reason, phase, why: dPre.why };
    planPre = planOf({ kind: sub, endpointId: intent.endpointId, chain: intent.chain, token, ledgerDir: dPre.dir, ctx, env });
    if (!planPre.ok) return { ok: false, reason: planPre.reason, why: planPre.why ?? null, phase, rollbackSafe: true };
    // R45 4c/4d：cutover 进段前冻结 S1 —— planOf 的同一 rec（ok 支带三 sidecar 受验字节）+ L 建 staged 树 + 备份 + 三条 prepared step（与 ledger step 同一次原子进段）。
    let sidecarSteps = [];
    let planSha = null;
    if (sub === "cutover") {
      const st = stageCutover(ctx, { token, endpointId: intent.endpointId, ledgerDir: dPre.dir, rec: planPre.rec, L: planPre.L });
      if (!st.ok) return { ok: false, reason: st.reason, why: st.why ?? null, phase, rollbackSafe: true };
      sidecarSteps = st.sidecarSteps;
      planSha = st.plan_sha256;
    }
    const fwd = sub === "init" ? "ledger_initializing" : "ledger_cutting_over";
    // 评审 P1-1：phase 推进 + ledger step（含 chain）合并成一次原子写，杜绝"phase=fwd 但无 step/无 chain"的恢复死窗。
    // R45：sidecar steps 同一 mutate 原子进段（4f——单写进段会在「进段了但 sidecar step 缺席」处留下不合法 journal）。
    const pw = enterLedgerForward({ dir: ctx.dir, token, lease, phase: fwd, step: ledgerStep(planPre, sub, intent.endpointId, planSha), sidecarSteps, chain: intent.chain, expectPhase: "drained", now: ctx.now() });
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
      if (scene.scene === "intended_after" && sub === "cutover" && !doc.steps.filter((s) => s.kind === "sidecar").every((s) => s.state === "done")) {
        // 账本已翻转但 sidecar 未收全 —— 复合提交的顺序被破坏（提交点在窄写之后，不应可达）；fail-closed。
        addNote({ dir: ctx.dir, token, lease, note: "ledger 已翻转但 sidecar 未收全，停门待修", now: ctx.now() });
        return { ok: false, reason: "composite_order_violation", phase, why: "intended_after 场景要求三条 sidecar 已 done" };
      }
      if (scene.scene === "before") {
        if (sub === "cutover") {
          // R45 复合提交：①三条 sidecar 窄写 + ②门内二次重验（都过才到提交点）。
          const cv = convergeSidecars(ctx, { token, lease, gateFile: ctx.gateFile, env, endpointId, chain, ledgerDir: d.dir, doc, ls });
          if (!cv.ok) return { ok: false, reason: cv.reason, why: cv.why ?? null, phase, lockUncleared: cv.lockUncleared ?? null };
          // 唯一提交点 authority_cutover：本单只武装到提交前（capability 门与真翻转账本归 M1b 后续单），停在门内。
          return { ok: false, reason: "authority_cutover_not_armed", why: "sidecar 已收敛、二次重验已过；authority_cutover 提交点未武装，停在 ledger_cutting_over", phase };
        }
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
  // 返修 P1-1：B-4 重开前必须确认提交的账本仍真实在场 —— done 收据 + 账本缺席 = fail-closed，
  // 绝不在此重建（重建会拿空账本当成功）。根缺失 / 账本缺 / 不可读 → append 到 incomplete → bail 保门保 active。
  {
    const ls = doc.steps.find((s) => s.kind === "ledger");
    const ep = ls ? (ENDPOINT_RE.exec(ls.id)?.[1] ?? null) : null;
    if (!ep) incomplete.push({ id: "ledger", why: "重开 journal 无合法 ledger step（endpoint 不可辨），说不清" });
    else {
      const d = resolveEndpointDir(ep, { env: process.env });
      if (!d.ok) incomplete.push({ id: ls.id, why: "账本根无法定位（" + (d.reason ?? "") + (d.why ? "：" + d.why : "") + "）—— done 收据 + 根缺失 = fail-closed" });
      else {
        const L = loadLedger(d.dir, { endpointId: ep });
        if (!L.ok) incomplete.push({ id: ls.id, why: "提交的账本缺失/不可读（" + (L.reason ?? "") + "）—— done 收据 + 账本缺失 = fail-closed" });
      }
    }
  }
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
  // ③b R45（B-4 账本接入）：cutover 的 staged 私有树在此清（账本已翻转、sidecar 已落，staged 不再有用）；absent 幂等，失败算没做完。
  if (doc.operation_kind === "ledger_cutover") {
    const rp = removeStagedPlan({ dir: ctx.dir, token });
    if (!rp.ok) incomplete.push({ id: "staged", why: "staged 清理：" + String(rp.reason) + (rp.why ? "（" + rp.why + "）" : "") });
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
  // R45 二轮 P1-4：真异常（非模拟崩溃）折结构化收据（ledger_forward_failed），不再裸抛炸穿调用方；
  // lease / 安装面锁在正常与异常路径都释放；simulatedCrash 契约豁免：原样重抛且不释放（模拟死亡，接管者按残骸处理）。
  let out, rollbackResult = null, crashErr = null;
  try {
    out = ledgerForward(ctx, { token: ent.token, lease: ent.lease, intent: { kind, endpointId, chain }, env });
    if (out.ok === false && out.rollbackSafe === true) {
      // 前置条件失败（如 reconciler_absent：账本步未准备、未写盘）→ 回退清场（桩/current/门/active 与进入前一致），不留下维护态
      const rb = rollbackOperation(ctx, ent.token, ent.lease);
      // P1-1：保留完整 rb（含 ok/activeCleared/incomplete）——只用 phase 重建会把“回退已到 rolled_back 但 active 没清掉”
      // 二次判定成成功（exit 1 + “已按账回退还清”），active 其实还留着。只有 rb.ok===true ∧ activeCleared===true 才算回退做完。
      rollbackResult = rb;
    }
  } catch (err) {
    if (err?.simulatedCrash === true) crashErr = err;
    // R45 三轮 P1-3：折收据带 phase（尽力重读 journal）——命令面 exitCodeFor 靠它判「已动现场」退 3，
    // 不再因丢 phase 退 1（与干净拒绝同码，脚本侧分不出「不能动」和「动了没做完」）。
    else out = { ok: false, reason: "ledger_forward_failed", why: errText(err),
      phase: (() => { const j45 = readJournal({ dir: ctx.dir, token: ent.token }); return j45.state === "valid" ? j45.doc.phase : null; })(),
      incomplete: [] };
  }
  if (crashErr !== null) throw crashErr;
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
  // R45 二轮 P1-4：forward / rollback 真异常折结构化收据（不再裸抛）；simulatedCrash 契约豁免：
  // 原样重抛且不释放 lease / 安装面锁（模拟死亡，接管者按残骸处理）。
  let out, crashErr = null;
  try {
    out = action === "ledger_forward"
      ? ledgerForward(ctx, { token, lease, env })
      : rollbackOperation(ctx, token, lease);
  } catch (err) {
    if (err?.simulatedCrash === true) crashErr = err;
    // R45 三轮 P1-3：同 ledgerEnter —— 折收据带 phase/action，退出码映射判「已动现场」退 3
    else out = { ok: false, reason: action === "ledger_forward" ? "ledger_forward_failed" : "ledger_rollback_failed", why: errText(err), phase, incomplete: [] };
  }
  if (crashErr !== null) throw crashErr;
  const leaseRel = releaseOperationLease(lease);
  return releaseHeld({ token, action, ...out, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason } });
}
