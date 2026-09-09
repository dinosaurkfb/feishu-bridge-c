/**
 * R52：owner_select_migration_a（operation A：old→transition + 复合 mint + writer_state=partial）的维护编排。
 *
 *   · 结构逐段对齐 ledger-operation.mjs（osmEnter / osmForward / osmReopening / osmExit），不自起第二套骨架；
 *   · 设计依据 owner-select-route.md §8（operation A 段、"mint plan"段、"pre-forward 状态矩阵"段）+ §8.2
 *     五行表（状态链闭合 / 写原语合同 / schema_upgrade 确定性）+ maintenance-gate.md §B/B-4；
 *   · operation B / direct / 门外 reaffirm 均有实现（B/direct 属 R53，门外 reaffirm 属既有）；
 *   · 账本写全部经 R51 的窄事务入口（schemaUpgrade / mintSelectionHandles，capability 由本模块读实文件核），
 *     状态文件写全部经 R50 的 writeCampaignState / writeWriterState（同款 capability 工艺）；
 *   · journal 一切提交走 journal.mjs 的通用原语（updateJournal / markStepDone / setPhase），进段（drained →
 *     osm_a_upgrading）与 ledger 的 enterLedgerForward 同一工艺：phase 翻转与全部 prepared step **同一次提交**。
 *
 * 测试注入点：ctx.afterStep（某步 done 后抛 {simulatedCrash:true} 模拟进程死在中间）；_inject 透传给账本写。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { acquireInstallSurfaceLock } from "../install-surface-lock.mjs";
import { codexRuntimeRoot, runtimeRoot, switchCurrentTarget, verifyRuntimeVersion } from "../runtime-install.mjs";
import { moduleDir } from "../direct-run.mjs";
import { fsyncDir, mkdirDurable, readStagedVerified, removeStagedPlan } from "../m1b/staged-plan.mjs";
import { removeStubVersion } from "./stub.mjs";
import { bootstrapTimer, timerPhase } from "./timers.mjs";
import { chainFacts } from "./precheck.mjs";
import { acquireOperationLease, addNote, clearActive, markStepDone, readActive, readJournal, releaseOperationLease, setPhase, updateJournal, verifyBackup } from "./journal.mjs";
import { readGate } from "../maintenance-gate-core.mjs";
import { enterMaintenance, rollbackOperation } from "./operation.mjs";
import { applyMintPlan, applySchemaUpgrade, buildMintPlan, fingerprintOf, loadLedger, migrationInventory, mintPlanProblem, mintSelectionHandles, OWNER_SELECT_HANDLE_TTL_MS, ownerSelectSchemaUpgradeOpId, resolveEndpointDir, schemaUpgrade, serializeLedger } from "../topic-agent-ledger.mjs";
import { CAMPAIGN_SCHEMA, WRITER_STATE_SCHEMA, campaignIdFor, campaignPath, endpointsDigest, readCampaignState, readOwnerSelectAdmission, readWriterState, writeCampaignState, writerStatePath, writeWriterState } from "./owner-select-state.mjs";
import { aggregateEndpointReceipts, endpointReceipt } from "./ledger-receipt.mjs";

const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
const CHAINS = ["claude", "codex"];

/** R53：三种 kind 的参数化映射（journal operation_kind + 预览文案）；handle TTL 唯一出处为账本模块 OWNER_SELECT_HANDLE_TTL_MS（P2-1）。 */
const OSM_KIND_TO_OPERATION = Object.freeze({ a: "owner_select_migration_a", b: "owner_select_migration_b", direct: "owner_select_migration_direct" });
const OSM_KIND_TO_REASON = Object.freeze({ a: "old→transition + mint + writer partial", b: "transition→strict + writer on", direct: "old→strict 直升 + writer on" });
const OSM_KIND_TO_PHASE = Object.freeze({ a: "osm_a_upgrading", b: "osm_b_strictening", direct: "osm_direct" });
const PHASE_TO_KIND = Object.freeze({ osm_a_upgrading: "a", osm_b_strictening: "b", osm_direct: "direct" });
/** forward-only 的 osm 段 + 复用 ledger 的重开族（journal.mjs 的 FORWARD_ONLY_PHASES 已含全部）。 */
import { OSM_FORWARD_PHASES } from "./exit-code.mjs";
export { OSM_FORWARD_PHASES };

const errText = (err) => String(err?.code ?? err?.message ?? err);
const afterStep = (ctx, id) => { if (typeof ctx.afterStep === "function") ctx.afterStep(id); };
const deepEq = (a, b) => { if (a === b) return true; if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i])); if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b); return false; };
const shaHex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const factsOf = (ctx, chain) => chainFacts({ chain, home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, node: ctx.node });
const readlinkOrNull = (p) => { try { return { state: "value", value: fs.readlinkSync(p) }; } catch (err) { return err?.code === "ENOENT" ? { state: "absent", value: null } : { state: "unclear", value: null, why: errText(err) }; } };
const releaseSurface = (surface) => {
  const rel = surface.release();
  return rel.ok ? rel : { ok: false, path: rel.path ?? null, why: rel.why ?? rel.reason };
};
const note = (ctx, token, lease, t) => addNote({ dir: ctx.dir, token, lease, note: t, now: ctx.now() });

/** P1-7 (a) 精确口径（#138 P2-5 收窄）：每 step「可记 done」——ok ∧ commit 属于对应 kind 的受控集合
 *   ∧ residue 空 ∧ lockUncleared==null ∧ lock_state!=='unclear'。
 *  ledger 类（schema_endpoint / mint）只认 committed_clean | replayed | already；state-file 类
 *  （campaign / writer_state）只认 committed；混用 → commit_unclear。返回 null 或 { reason:'commit_unclear'|'step_failed', why }。 */
const COMMIT_ALLOWED = Object.freeze({ ledger: ["committed_clean", "replayed", "already"], state: ["committed"] });
export function stepCommitCheck(result, kind = "ledger") {
  if (!result?.ok) return { reason: result?.reason ?? "step_failed", why: result?.why ?? null };
  if (!COMMIT_ALLOWED[kind]?.includes(result.commit)) return { reason: "commit_unclear", why: "commit=" + String(result.commit ?? "?") + "（kind=" + kind + "）" };
  if (result.residue != null && result.residue.length > 0) return { reason: "commit_unclear", why: "residue 非空" };
  if (result.lockUncleared != null) return { reason: "commit_unclear", why: "lockUncleared 非 null" };
  if (result.lock_state === "unclear") return { reason: "commit_unclear", why: "lock_state=unclear" };
  return null;
}

/** mint plan 的落盘字节（编排私有：与重演算消费的 JSON.parse 往返一致即可，账本序列化走 serializeLedger）。 */
export const mintPlanBytes = (plan) => Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf-8");

/** O_EXCL 0600 写满 fsync → fsync 父目录（intended/）；EEXIST 原样带出（pre-forward 矩阵据此判"已有一份"）。 */
function writePlanFileOExcl(file, bytes) {
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (err) { return { ok: false, reason: err?.code === "EEXIST" ? "plan_exists" : "plan_write_failed", why: errText(err) }; }
  try {
    fs.writeFileSync(fd, bytes);
    try { fs.fsyncSync(fd); } catch (err) { return { ok: false, reason: "plan_write_failed", why: "fsync：" + errText(err) }; }
  } finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  let dfd = null;
  try {
    dfd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    fs.fsyncSync(dfd); // 十四轮 P1：目录 fsync 失败不得推进 forward-only
  } catch (err) { return { ok: false, reason: "plan_dir_fsync_failed", why: errText(err) }; }
  finally { try { if (dfd !== null) fs.closeSync(dfd); } catch { /* 已关 */ } }
  return { ok: true };
}

/** step id → 无碰撞备份文件名（R53 返修五 P1-1）：id 里非 [A-Za-z0-9._-] 的字符按 %XX 编码（唯一算法、可逆）。 */
const stepIdEncoded = (id) => id.replace(/[^A-Za-z0-9._-]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
const backupPathFor = (stagedDir, stepId) => path.join(stagedDir, "backup-" + stepIdEncoded(stepId) + ".json");

/** R53 返修五 P1-1：备份/验收失败 → 拒进段并清 staged；清理失败不得报「干净拒绝」（外显残骸）。 */
function failWithStagedClean(stagedDir, reason, why) {
  try { fs.rmSync(stagedDir, { recursive: true, force: true }); }
  catch (err) { return { ok: false, reason: "staged_residue", why: "拒进段后清 staged 失败：" + errText(err) + "（staged 残骸保留）" }; }
  return { ok: false, reason, why };
}

/** 备份字节落本 operation 私有 staged/ 目录。P1-4 (c)：文件已在场 → readStagedVerified 核其 sha ===
 *  预期字节 sha 则复用（去掉一律 O_EXCL），不符 → fail-closed；缺席 → O_EXCL 0600 fd 写 + fsync。返回 {sha256, bytes}。 */
function copyBackup(dest, bytes) {
  const sha = shaHex(bytes);
  let fd = null;
  try { fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (err) {
    if (err?.code !== "EEXIST") return { ok: false, reason: "backup_write_failed", why: errText(err) };
    const v = readStagedVerified(dest, { sha256: sha, bytes: bytes.length });
    if (!v.ok) return { ok: false, reason: "backup_mismatch", why: "备份已在场但 sha 不符（" + (v.why ?? "") + "）" };
    // P1-2：复用必须重新 seal（受验 fd fsync + fsync staged/ 父目录）——上一轮目录屏障失败留下的文件，本轮复用要重新刷。
    const s = sealReusedFile(dest, path.dirname(dest));
    if (!s.ok) return { ok: false, reason: "backup_seal_failed", why: "复用备份重新 seal 失败（" + s.why + "）" };
    return { ok: true, sha256: sha, bytes: bytes.length };
  }
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  return { ok: true, sha256: sha, bytes: bytes.length };
}

/** P1-2（返修二）：复用前重新 seal —— 上一轮写入未刷盘（写入失败或目录屏障失败）留在场上的文件，
 *  本轮复用要在受验 fd（O_RDONLY|O_NOFOLLOW|O_NONBLOCK，核普通文件/0600/单硬链接）上 fsync(file)，
 *  再 fsync 正确父目录（plan 的 intended/、backup 的 staged/），才算「可跨崩溃存活」进 forward-only。
 *  返回 { ok:true } 或 { ok:false, why }。 */
function sealReusedFile(file, dir) {
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) { return { ok: false, why: errText(err) }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, why: "硬链接数不是 1" };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, why: "mode 不是 0600" };
    fs.fsyncSync(fd);
  } catch (err) { return { ok: false, why: errText(err) }; }
  finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  let dfd = null;
  try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
  catch (err) { return { ok: false, why: errText(err) }; }
  finally { try { if (dfd !== null) fs.closeSync(dfd); } catch { /* 已关 */ } }
  return { ok: true };
}

/** 返修三（#138 三轮 P1）统一屏障：四类 step 记 done 前（首次 clean 提交 + 恢复支）统一走这一套——
 *  ① fsync 目标目录；② 受验重读原始字节 + 完整投影逐字段 === step.intended_after；③ 残骸盘点为空。
 *  任一失败 → { ok:false, why }，调用方不记 done（fail-closed）。
 *  `readVerified` 返回 { ok, projection }（projection 为平整对象，逐字段与 intended 比）；
 *  `residueAllowed(n)` 决定目标目录里哪个名字合法（含合法子目录）；其余全是残骸。
 *  残骸 fail-closed：只忽略确定的 ENOENT；lstat 其它异常（EIO/EACCES…）→ 查不清阻断；
 *  未知目录、ledger.lock、state file 锁、`.reap`/`.reaped-*` 一律算残骸（不进允许制品）。 */
let __sealCalls = 0;
export const __sealCallCount = () => __sealCalls;
export const __resetSealCalls = () => { __sealCalls = 0; };
/** 返修四 #138 四轮 P1：ledger 根残骸白名单 (name, st)——endpoint 目录须 ∈ 受验冻结集 + 是目录 + 非 symlink；
 *  两个状态文件须普通文件 + 非 symlink；同名的普通文件 / 同名的 symlink / 冻结集外的 endpoint 目录一律算残骸。 */
const campaignAllowedFor = (frozen) => (name, st) => {
  const isFile = st.isFile() && !st.isSymbolicLink();
  const isDir = st.isDirectory() && !st.isSymbolicLink();
  return (isDir && (frozen ?? []).includes(name)) || (isFile && (name === "owner-select-campaign.json" || name === "owner-select-writer-state.json"));
};
/** 返修五追加：ledger 目录允许制品 = 普通文件 ∧ 非 symlink（只认 ledger.json / ledger.json.prev，同名 symlink 一律残骸）。 */
const ledgerAllowed = (name, st) => !!st && st.isFile() && !st.isSymbolicLink() && (name === "ledger.json" || name === "ledger.json.prev");

function sealAndVerifyStep({ targetDir, readVerified, intended, residueAllowed = null, inject = null }) {
  __sealCalls++;
  let dfd = null;
  try {
    if (inject?.failDirFsync) throw Object.assign(new Error("注入目录 fsync 失败"), { code: "EIO" });
    dfd = fs.openSync(targetDir, fs.constants.O_RDONLY);
    fs.fsyncSync(dfd);
  } catch (err) { return { ok: false, why: errText(err) }; }
  finally { try { if (dfd !== null) fs.closeSync(dfd); } catch { /* 已关 */ } }
  const rv = readVerified();
  if (!rv.ok) return { ok: false, why: rv.why ?? "受验重读失败" };
  if (intended !== null && typeof intended === "object") {
    for (const [k, v] of Object.entries(intended)) {
      if (!deepEq(rv.projection?.[k], v)) return { ok: false, why: "投影≠intended：" + k };
    }
  }
  let names;
  try { names = fs.readdirSync(targetDir); }
  catch (err) { return { ok: false, why: "readdir：" + errText(err) }; }
  for (const n of names) {
    let st = null;
    try {
      if (inject?.lstatThrows === n) throw Object.assign(new Error("注入 lstat 异常"), { code: "EACCES" });
      st = fs.lstatSync(path.join(targetDir, n));
    }
    catch (err) { if (err?.code === "ENOENT") continue; return { ok: false, why: "lstat：" + errText(err) }; }
    if (residueAllowed === null || !residueAllowed(n, st)) return { ok: false, why: "残骸：" + n + (st.isDirectory() ? "（目录）" : "") };
  }
  return { ok: true };
}

/** 受验投影构造器：读回目标现场，返回 { ok, projection }（供 sealAndVerifyStep 逐字段比对 intended）。 */
const campaignProj = (env) => { const a = readCampaignState(env); return { ok: a.state !== "unreadable", projection: a.state === "unreadable" ? {} : { exists: a.exists, sha256: a.sha256, state: a.state, campaign_id: a.campaign_id, endpoints: a.endpoints, endpoints_digest: a.endpoints_digest } }; };
const writerProj = (env) => { const a = readWriterState(env); return { ok: a.state !== "unreadable", projection: a.state === "unreadable" ? {} : { exists: a.exists, sha256: a.sha256, state: a.state, campaign_id: a.campaign_id, endpoints_digest: a.endpoints_digest, revision: a.revision } }; };
const ledgerProj = (ep, dir) => { const a = loadLedger(dir, { endpointId: ep }); return { ok: a.ok, projection: a.ok ? { schema_version: a.doc.schema_version, revision: a.doc.revision, ledger_sha256: a.sha256 } : {} }; };
const LEDGER_ALLOWED = (n) => n === "ledger.json" || n === "ledger.json.prev";

/** P1-3（返修二 P1-1）：核**两条链**的已装 runtime 是否支持过渡（§8 进门前置）。
 *  目标从**受验 journal** 的 `current:<chain>.before` 取（绝不读桩 manifest 的 original_current——
 *  那是自由字段，可被改成 `../../../escape-runtime` 之类逃逸路径）。每个 before 必须精确为
 *  `versions/<16hex>`，再逐链 verifyRuntimeVersion（manifest 完整）+ 子进程探针（1.4 / 1.1-transition）；
 *  任一不符 → 拒。返回 { ok:true } 或 { ok:false, why }。 */
function runtimeTransitionCapable({ env, j }) {
  const chainRuntime = (chain) => {
    if (chain === "claude") return { root: runtimeRoot(env.HOME, "claude"), home: env.HOME };
    return { root: codexRuntimeRoot(env.CODEX_HOME || path.join(env.HOME, ".codex")), home: env.CODEX_HOME || path.join(env.HOME, ".codex") };
  };
  const probePath = path.join(moduleDir(import.meta.url), "runtime-capability-probe.mjs");
  const probe = (versionDir, home) => {
    let raw = null;
    try {
      raw = execFileSync(process.execPath, [probePath, versionDir], { encoding: "utf-8", timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, HOME: home } });
    } catch (e) {
      return { ok: false, why: String(e.stderr ?? e.message).slice(0, 200) };
    }
    const line = String(raw ?? "").trim().split("\n").filter(Boolean);
    if (line.length < 1) return { ok: false, why: "探针无输出" };
    let rv = null;
    try { rv = JSON.parse(line[line.length - 1]); } catch { return { ok: false, why: "探针输出非合法 JSON" }; }
    if (rv?.ok !== true) return { ok: false, why: "探针 ok=false" };
    if (rv.journal_schema !== "1.4") return { ok: false, why: "journal_schema=" + String(rv.journal_schema) };
    const sv = rv.ledger_schema_versions;
    if (!Array.isArray(sv) || !sv.includes("1.1-transition") || !sv.includes("1.1")) return { ok: false, why: "账本 schema_versions 缺 1.1-transition/1.1" };
    return { ok: true };
  };
  for (const chain of CHAINS) {
    const step = (j.steps ?? []).find((s) => s.id === "current:" + chain && s.kind === "current");
    if (!step || typeof step.before !== "string") return { ok: false, why: chain + " 缺 current step 或 before 非字符串" };
    const before = step.before;
    if (!/^versions\/[0-9a-f]{16}$/u.test(before)) return { ok: false, why: chain + " before 形状不是 versions/<16hex>：" + before };
    const { root, home } = chainRuntime(chain);
    const vr = verifyRuntimeVersion({ version: before.slice("versions/".length), root });
    if (!vr.ok) return { ok: false, why: chain + " verifyRuntimeVersion 拒（" + (vr.reason ?? "?") + "）" };
    const versionDir = path.join(root, before);
    const p = probe(versionDir, home);
    if (!p.ok) return { ok: false, why: chain + "：" + p.why };
  }
  return { ok: true };
}

/** 删本 operation 的 staged mint plan（§二.7：回退先删 plan，删不掉 → rollback_incomplete；目录缺席幂等）。 */
export function removeMintPlans(ctx, token) {
  const dir = path.join(ctx.dir, token + ".staged", "intended");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith("mint-") && n.endsWith(".json")); }
  catch (err) { return err?.code === "ENOENT" ? { ok: true, removed: [] } : { ok: false, why: errText(err) }; }
  for (const n of names) {
    try { fs.unlinkSync(path.join(dir, n)); }
    catch (err) { return { ok: false, why: n + "：" + errText(err) }; }
  }
  return { ok: true, removed: names };
}

/** osmExit 的分派（纯读）：terminal → clear_active；osm forward 族 → osm_forward；≤drained / 回退族 → rollback。 */
function osmExitAction(phase) {
  if (phase === "done" || phase === "rolled_back") return "clear_active";
  if (OSM_FORWARD_PHASES.includes(phase)) return "osm_forward";
  if (phase === "drained" || phase === "planned" || phase === "timer_stopped" || phase === "stubbed" || phase === "gated"
    || phase === "rolling_back" || phase === "rollback_reopening" || phase === "rolled_back" || phase === "rollback_incomplete") return "rollback";
  return null;
}

/** ── drained 只读前置（§二.2；失败留在 drained，rollbackSafe）── */
function osmPrecheck(ctx, { token, env, j }) {
  // P1-3（返修二 P1-1）：过渡 runtime 前置 —— 两链 current:<chain>.before（受验 journal）必已受验支持
  // transition/strict 与 1.4 journal（§8 进门前置）。形状不是 versions/<16hex> / manifest 不完整 /
  // 子进程探针值不符 / 非零退出 / 超时 / 输出非合法 JSON → 一律 fail-closed。
  const rtProbe = runtimeTransitionCapable({ env, j });
  if (!rtProbe.ok) return { ok: false, reason: "precheck_failed", why: "runtime_not_transition_capable" + (rtProbe.why ? "：" + rtProbe.why : "") };
  // 冻结集 = 全部有效初始化收据（initDone）的 endpoint，有序去重非空（§8：open 的初始集来源）。
  // P1-2：改用唯一聚合 aggregateEndpointReceipts——任一收据 conflict / in-flight / duplicate / unreadable
  //   → 整体 precheck_failed（why 点名 ep），绝不拿剩余子集迁移（自建 aggregateInitDone 会静默跳过矛盾收据）。
  const agg = aggregateEndpointReceipts({ dir: ctx.dir });
  if (!agg.ok) return { ok: false, reason: "precheck_failed", why: agg.why ?? null };
  const frozen = [...new Set(agg.endpoints.filter((e) => e.initDone === true).map((e) => e.endpointId))].sort();
  if (frozen.length === 0) return { ok: false, reason: "frozen_set_empty", why: "无任何 initDone 收据的 endpoint，冻结集为空（迁移无从谈起）" };
  for (const ep of frozen) {
    if (!ENDPOINT_SHAPE.test(ep)) return { ok: false, reason: "bad_endpoint_receipt", why: "收据 endpoint 形状不对：" + ep };
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return { ok: false, reason: d.reason, why: ep + " 账本根定位失败", ep };
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: ep + "：" + (L.why ?? L.reason), ep };
    if (L.doc.schema_version !== "1.0") return { ok: false, reason: "schema_not_old", why: ep + " schema_version=" + L.doc.schema_version + "（应为 1.0）", ep };
  }
  // campaign 文件：absent 或 complete → 可 open；open 且 campaign_id 同 → 恢复（容忍）；sealed / 异 id → fail-closed。
  const cs = readCampaignState(env);
  if (cs.state === "unreadable") return { ok: false, reason: "campaign_unreadable", why: cs.problem };
  const cid = campaignIdFor(token);
  if (cs.exists) {
    if (cs.state === "open" && cs.campaign_id !== cid) return { ok: false, reason: "campaign_foreign", why: "open campaign 属别的 campaign_id：" + cs.campaign_id };
    if (cs.state === "sealed") return { ok: false, reason: "campaign_sealed", why: "campaign 已封印（sealed 后集合不可再变，A 不得重开）" };
  }
  // writer-state：off（缺席）或 on（退回场景）→ 可置 partial；partial 且同 id → 恢复；其它 → fail-closed。
  const ws = readWriterState(env);
  if (ws.state === "unreadable") return { ok: false, reason: "writer_state_unreadable", why: ws.problem };
  if (ws.exists && ws.state === "partial" && ws.campaign_id !== cid) return { ok: false, reason: "writer_state_foreign", why: "writer-state partial 属别的 campaign_id：" + ws.campaign_id };
  // P1-6：进段前核 campaign × writer 跨文件联合（readOwnerSelectAdmission）——两文件任一不自洽 → 拒。
  const adm = readOwnerSelectAdmission(env);
  if (adm.state === "unreadable") return { ok: false, reason: "campaign_writer_inconsistent", why: adm.problem };
  return { ok: true, frozen };
}



/** ── pre-forward 状态矩阵（§二.3）+ 备份 + 进段 step body（§二.4；全部只写本 operation 私有目录）── */
function osmPrepareForward(ctx, { token, frozen, env }) {
  const cid = campaignIdFor(token);
  const digest = endpointsDigest(frozen);
  const stagedDir = path.join(ctx.dir, token + ".staged");
  const intendedDir = path.join(stagedDir, "intended");
  // P1-4 (a)：用 R46 建根原语逐层建 staged 树（父目录在场、非递归、lstat 核 symlink/0700、fsync 父目录作屏障），
  //   不再 mkdirSync({recursive:true})——staged/ 被预埋成外指 symlink 时在此拒。
  try { mkdirDurable(stagedDir, ctx.dir); mkdirDurable(intendedDir, stagedDir); }
  catch (err) { return { ok: false, reason: err?.code === "EPRIVMODE" || err?.code === "EPRIVLINK" ? "staged_residue" : "io_error", why: "建 staged 树：" + errText(err), rollbackSafe: false }; }

  // 现场投影（campaign / writer_state）——备份规则按 kind：before.exists → 备份到 staged/
  const cs = readCampaignState(env);
  const campaignBefore = cs.exists
    ? { exists: true, sha256: cs.sha256, state: cs.state, campaign_id: cs.campaign_id, endpoints: cs.endpoints, endpoints_digest: cs.endpoints_digest }
    : { exists: false, sha256: null, state: "absent", campaign_id: null, endpoints: null, endpoints_digest: null };
  const ws = readWriterState(env);
  const writerBefore = ws.exists
    ? { exists: true, sha256: ws.sha256, state: ws.state, campaign_id: ws.campaign_id, endpoints_digest: ws.endpoints_digest, revision: ws.revision }
    : { exists: false, sha256: null, state: "off", campaign_id: null, endpoints_digest: null, revision: 0 };

  const perEp = [];
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    const L = loadLedger(d.dir, { endpointId: ep });
    const inv = migrationInventory(L.doc);

    // ① schema 预算先行（确定性 op id → next 可预算；plan 锚的是 transition 后的账本，不是 1.0——
    //    mint 在 schema 之后执行，plan.before_ledger_sha256 必 === mint step before 的 ledger_sha256）
    const opId = ownerSelectSchemaUpgradeOpId(token, ep);
    const next = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token + ":schema:" + ep, from_schema: "1.0", to_schema: "1.1-transition" }); // 与执行器 requestKey 同源
    // P2-3：schema_upgrade 的 request_key 派生公式（§8.2 已回带合同）固定为 token + ":schema:" + ep，两处（进段预算 / 执行器 / 重开核验）必须逐字一致。
    const schemaAfter = { schema_version: "1.1-transition", revision: L.doc.revision + 1, ledger_sha256: shaHex(serializeLedger(next)) };

    // ② pre-forward 矩阵：staged mint plan 盘点（缺席 → 建；恰一份身份/锚全符 → 复用；其它 → fail-closed 不删不改）
    const planFile = path.join(intendedDir, "mint-" + ep + ".json");
    const probe = readStagedPlanBytes(planFile);
    let plan = null, planBytes = null;
    if (probe.ok) {
      // 文件在场：按 §8 矩阵逐项核身份与重演算；文件本身的 0600/单硬链接/普通文件已由 readStagedPlanBytes 核过。
      let parsed;
      try { parsed = JSON.parse(probe.buf.toString("utf-8")); }
      catch (err) { return { ok: false, reason: "mint_plan_corrupt", why: ep + " 不是 JSON：" + errText(err), rollbackSafe: false }; }
      const identityOk = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        && parsed.plan_kind === "owner_select_mint_plan_v1" && parsed.token === token && parsed.campaign_id === cid
        && parsed.endpoint === ep && parsed.request_key === token;
      const invNow = migrationInventory(next);
      const resim = identityOk && mintPlanProblem(parsed) === null ? shaHex(serializeLedger(applyMintPlan(next, parsed))) : null;
      if (!identityOk || mintPlanProblem(parsed) !== null
        || parsed.before_ledger_sha256 !== schemaAfter.ledger_sha256
        || JSON.stringify(parsed.expected_null_b1_ids) !== JSON.stringify(invNow.null_b1_ids)
        || resim !== parsed.expected_ledger_sha256) {
        return { ok: false, reason: "mint_plan_mismatch", why: ep + " 的 staged plan 身份/锚不符（不删不改，等人工）", rollbackSafe: false };
      }
      plan = parsed;
      // P1-4 (b)：plan 来自文件 → journal 锚用盘上原始字节的 sha（不重新序列化）；非规范但合法的序列化以文件为准。
      planBytes = probe.buf;
      // P1-2：复用必须重新 seal（受验 fd fsync + fsync intended/ 父目录）——上一轮目录屏障失败留下的 plan，本轮复用要重新刷。
      const seal = sealReusedFile(planFile, path.dirname(planFile));
      if (!seal.ok) return { ok: false, reason: "plan_seal_failed", why: ep + "：复用 plan 重新 seal 失败（" + seal.why + "）", rollbackSafe: false };
    } else if (probe.why !== "文件不在") {
      return { ok: false, reason: "mint_plan_unreadable", why: ep + "：" + probe.why, rollbackSafe: false };
    } else {
      plan = buildMintPlan({ doc: next, token, campaignId: cid, endpointId: ep, requestKey: token, now: ctx.now(), ttlMs: OWNER_SELECT_HANDLE_TTL_MS });
      if (plan === null || mintPlanProblem(plan) !== null) return { ok: false, reason: "plan_build_failed", why: ep + " 的 mint plan 构造失败或形状不过", rollbackSafe: false };
      const bytes = mintPlanBytes(plan);
      const w = writePlanFileOExcl(planFile, bytes);
      if (!w.ok) return { ok: false, reason: w.reason, why: ep + "：" + (w.why ?? ""), rollbackSafe: false };
      planBytes = bytes;
    }
    const planBlob = { path: planFile, bytes: planBytes.length, sha256: shaHex(planBytes) };

    // ③ 账本备份进 staged（P1-5：schema 步备份 = 受验读取器读到的 1.0 原始字节——backup_sha === before.ledger_sha256；
    //    mint 步备份 = serializeLedger(applySchemaUpgrade(...)) 的确定性字节——三方等式
    //    mint.before.ledger_sha256 === schema.intended_after.ledger_sha256 === mint 备份 sha；不得从状态投影重新 JSON 化）。
    const backupFile = path.join(stagedDir, "backup-ledger-" + ep + ".json");
    const b = copyBackup(backupFile, L.bytes ?? serializeLedger(L.doc));
    if (!b.ok) return { ok: false, reason: b.reason, why: ep + "：" + (b.why ?? "") };
    const mintBackupFile = path.join(stagedDir, "backup-mint-" + ep + ".json");
    const mb = copyBackup(mintBackupFile, serializeLedger(next));
    if (!mb.ok) return { ok: false, reason: mb.reason, why: ep + " mint 备份：" + (mb.why ?? "") };
    if (mb.sha256 !== schemaAfter.ledger_sha256) return { ok: false, reason: "mint_backup_sha_mismatch", why: ep + " mint 备份 sha ≠ schema.intended_after.ledger_sha256", rollbackSafe: false };

    perEp.push({
      ep, plan, planBlob, schemaAfter,
      backupFile, backupSha: b.sha256, backupBytes: b.bytes,
      mintBackupFile, mintBackupSha: mb.sha256, mintBackupBytes: mb.bytes,
      schemaBefore: { schema_version: "1.0", revision: L.doc.revision, ledger_sha256: L.sha256 },
      mintBefore: { revision: L.doc.revision + 1, null_b1_count: inv.null_b1_count, ledger_sha256: schemaAfter.ledger_sha256 },
      mintAfter: { revision: L.doc.revision + 2, null_b1_count: 0, ledger_sha256: plan.expected_ledger_sha256 },
    });
  }

  // campaign / writer_state 的 intended_after：doc 先冻结（成员投影 + revision+1），预算序列化 SHA（与
  // writeStateFile 的 payload 同式：JSON.stringify(doc, null, 2) + "\n"——同一对象同一序列化，逐字可对）。
  // campaign / writer_state 的 intended_after：doc 先冻结（成员投影 + revision+1），预算序列化 SHA（与
  // writeStateFile 的 payload 同式：JSON.stringify(doc, null, 2) + "\n"——同一构造函数同一序列化，逐字可对）。
  const campaignDoc = buildOsmCampaignDoc({ env, frozen, cid, token, expectedRevision: (cs.exists ? cs.revision : 0) + 1 });
  if (!campaignDoc.ok) return { ok: false, reason: "campaign_member_unreadable", why: campaignDoc.why };
  const campaignAfter = { exists: true, sha256: shaHex(serializeLedger(campaignDoc.doc)), state: "open", campaign_id: cid, endpoints: frozen, endpoints_digest: digest };
  const writerDoc = buildOsmWriterDoc({ token, cid, digest, expectedRevision: (ws.exists ? ws.revision : 0) + 1 });
  const writerAfter = { exists: true, sha256: shaHex(serializeLedger(writerDoc)), state: "partial", campaign_id: cid, endpoints_digest: digest, revision: writerDoc.revision };

  // 备份：campaign / writer_state before.exists → 备份到 staged/
  let campaignBackup = { backup: null, backup_sha256: null, backup_bytes: null };
  let writerBackup = { backup: null, backup_sha256: null, backup_bytes: null };
  if (cs.exists) {
    // P1-3（返修二）：campaign 备份 = 读取器 raw（cs.raw 同一受验 fd 字节），绝不重读路径——
    // 读取器返回 raw 后若现场被换成 FIFO/改内容，备份仍等于 raw。
    const rawBytes = cs.raw;
    if (!Buffer.isBuffer(rawBytes) || shaHex(rawBytes) !== cs.sha256) return { ok: false, reason: "campaign_backup_raw_mismatch", why: "campaign 备份 raw sha ≠ 读取器 sha", rollbackSafe: false };
    const cb = copyBackup(path.join(stagedDir, "backup-campaign.json"), rawBytes);
    if (!cb.ok) return { ok: false, reason: cb.reason, why: "campaign 备份：" + (cb.why ?? "") };
    campaignBackup = { backup: path.join(stagedDir, "backup-campaign.json"), backup_sha256: cb.sha256, backup_bytes: cb.bytes };
  }
  if (ws.exists) {
    // P1-3（返修二）：writer_state 备份 = 读取器 raw（ws.raw 同一受验 fd 字节），绝不重读路径。
    const rawBytes = ws.raw;
    if (!Buffer.isBuffer(rawBytes) || shaHex(rawBytes) !== ws.sha256) return { ok: false, reason: "writer_backup_raw_mismatch", why: "writer-state 备份 raw sha ≠ 读取器 sha", rollbackSafe: false };
    const wb = copyBackup(path.join(stagedDir, "backup-writer-state.json"), rawBytes);
    if (!wb.ok) return { ok: false, reason: wb.reason, why: "writer-state 备份：" + (wb.why ?? "") };
    writerBackup = { backup: path.join(stagedDir, "backup-writer-state.json"), backup_sha256: wb.sha256, backup_bytes: wb.bytes };
  }
  // P1-4 (d)：所有备份（含 ledger/campaign/writer）落盘后才 fsync staged/ 目录作目录屏障，之后才许进段提交。
  try { fsyncDir(stagedDir); }
  catch (err) { return { ok: false, reason: "backup_dir_fsync_failed", why: "fsync staged 目录：" + errText(err), rollbackSafe: false }; }

  const at = new Date(ctx.now()).toISOString();
  const steps = [];
  steps.push({ kind: "campaign", id: "campaign:" + cid + ":open", state: "prepared", at, target: "ledger/owner-select-campaign.json", chain: null, before: campaignBefore, intended_after: campaignAfter, ...campaignBackup });
  for (const p of perEp) {
    steps.push({ kind: "schema_endpoint", id: "schema_endpoint:" + p.ep + ":transition", state: "prepared", at, target: "ledger/" + p.ep + "/ledger.json", chain: null, before: p.schemaBefore, intended_after: p.schemaAfter, backup: p.backupFile, backup_sha256: p.schemaBefore.ledger_sha256, backup_bytes: p.backupBytes });
    steps.push({ kind: "mint", id: "mint:" + p.ep, state: "prepared", at, target: "ledger/" + p.ep + "/ledger.json", chain: null, before: p.mintBefore, intended_after: p.mintAfter, intended_blob: p.planBlob, backup: p.mintBackupFile, backup_sha256: p.mintBefore.ledger_sha256, backup_bytes: p.mintBackupBytes });
  }
  steps.push({ kind: "writer_state", id: "writer_state:" + cid + ":partial", state: "prepared", at, target: "ledger/owner-select-writer-state.json", chain: null, before: writerBefore, intended_after: writerAfter, ...writerBackup });

  return { ok: true, steps, phase: "osm_a_upgrading", campaignDoc, writerDoc, cid, digest, frozen };
}

/** staged plan 的受验读（0600 / 单硬链接 / 普通文件），返回字节（无外部锚——锚由身份+重演算核承担）。 */
function readStagedPlanBytes(file) {
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) { return { ok: false, why: err?.code === "ENOENT" ? "文件不在" : errText(err) }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, why: "硬链接数不是 1" };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, why: "mode 不是 0600" };
    if (st.size > (1 << 20)) return { ok: false, why: "超过 1MiB" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) return { ok: false, why: "读不满文件" }; off += n; }
    return { ok: true, buf };
  } catch (err) { return { ok: false, why: errText(err) }; }
  finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

/**
 * osmForward：向前引擎（幂等、只向前、崩溃恢复入口）。drained → 原子进段 → a-e 收敛 → ledger_reopening。
 * 每步 commit 非 committed_clean / 拒绝（precheck_failed / written_mismatch / diverged）→ 停门退出（forward-only 不回退）。
 */
export function osmForward(ctx, { token, lease, env = process.env, _inject = null } = {}) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
  let doc = j.doc;
  let phase = doc.phase;
  const kind = doc.operation_kind === "owner_select_migration_a" ? "a" : doc.operation_kind === "owner_select_migration_b" ? "b" : doc.operation_kind === "owner_select_migration_direct" ? "direct" : null;
  if (!kind) return { ok: false, reason: "bad_operation_kind", phase };

  if (phase === "drained") {
    const pre = kind === "b" ? osmPrecheckB(ctx, { env, j: doc }) : kind === "direct" ? osmPrecheckDirect(ctx, { env, j: doc }) : osmPrecheck(ctx, { token, env, j: doc });
    if (!pre.ok) return { ok: false, reason: pre.reason, why: pre.why ?? null, phase, rollbackSafe: true };
    const body = kind === "b" ? osmPrepareForwardB(ctx, { token, env, frozen: pre.frozen, cid: pre.cid, digest: pre.digest })
      : kind === "direct" ? osmPrepareForwardDirect(ctx, { token, env, frozen: pre.frozen })
      : osmPrepareForward(ctx, { token, frozen: pre.frozen, env });
    if (!body.ok) return { ok: false, reason: body.reason, why: body.why ?? null, phase, rollbackSafe: body.rollbackSafe === true };
    // 原子进段：phase 翻转 + 全部 prepared step 同一次 journal 提交（§二.4；进段后 journal 必 journalProblem===null）
    const pw = updateJournal({ dir: ctx.dir, token, lease, expectPhase: "drained", now: ctx.now(), mutate: (d) => {
      d.phase = body.phase;
      for (const st of body.steps) d.steps.push(st);
      return d;
    } });
    if (!pw.ok) return { ok: false, reason: pw.reason, why: pw.why ?? null, phase };
    doc = pw.doc;
    phase = body.phase;
    afterStep(ctx, "osm:forward-entered");
  }

  if (phase === "osm_a_upgrading") {
    const cid = campaignIdFor(token);
    const stepDone = (id, after) => { const m = markStepDone({ dir: ctx.dir, token, lease, id, after, now: ctx.now() }); if (!m.ok) return m; return null; };

    // a. campaign open：现场已 === intended（崩溃窗口）→ 补 done；否则 CAS 写 → markStepDone(after=写后读回投影 === intended)
    {
      const st = doc.steps.find((s) => s.kind === "campaign" && s.id === "campaign:" + cid + ":open");
      if (!st) return { ok: false, reason: "campaign_step_absent", phase };
      if (st.state !== "done") {
        const cs = readCampaignState(env);
        const intended = st.intended_after;
        const atIntended = cs.exists && cs.sha256 === intended.sha256 && cs.state === intended.state && cs.campaign_id === intended.campaign_id
          && JSON.stringify(cs.endpoints) === JSON.stringify(intended.endpoints) && cs.endpoints_digest === intended.endpoints_digest;
        if (!atIntended) {
          const rebuild = buildOsmCampaignDoc({ env, frozen: intended.endpoints, cid, token, expectedRevision: (cs.exists ? cs.revision : 0) + 1 }); // 与进段同式：campaign 联合无 revision，现场投影推导
          if (!rebuild.ok) return { ok: false, reason: "campaign_member_unreadable", why: rebuild.why, phase };
          if (shaHex(serializeLedger(rebuild.doc)) !== intended.sha256) return { ok: false, reason: "campaign_budget_drift", why: "预算漂移：进段 " + intended.sha256.slice(0, 12) + " 重算 " + shaHex(serializeLedger(rebuild.doc)).slice(0, 12), phase };
          const w = writeCampaignState({ env, expectedSha256: cs.exists ? cs.sha256 : null, doc: rebuild.doc, capability: { token, stepId: st.id } });
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点：写后读回前（返修一 ③）
        }
        // 返修三：首次 clean 提交与恢复支（现场===intended）统一走 sealAndVerifyStep，再记 done。
        const s = sealAndVerifyStep({
          targetDir: path.dirname(campaignPath(env)),
          readVerified: () => { const a = readCampaignState(env); return { ok: a.state !== "unreadable", projection: a.state === "unreadable" ? {} : { exists: a.exists, sha256: a.sha256, state: a.state, campaign_id: a.campaign_id, endpoints: a.endpoints, endpoints_digest: a.endpoints_digest } }; },
          intended,
          residueAllowed: campaignAllowedFor(intended?.endpoints),
          inject: _inject,
        });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }

    // b. 每 ep schemaUpgrade（执行器读回 SHA === 进段预算；replayed / 已 after 态 → 补 done）
    for (const st of doc.steps.filter((s) => s.kind === "schema_endpoint")) {
      const ep = st.id.slice("schema_endpoint:".length).split(":")[0];
      if (st.state !== "done") {
        const d = resolveEndpointDir(ep, { env });
        if (!d.ok) return { ok: false, reason: d.reason, why: ep, phase };
        const L = loadLedger(d.dir, { endpointId: ep });
        const schemaAtIntended = L.ok && L.sha256 === st.intended_after.ledger_sha256 && L.doc.schema_version === st.intended_after.schema_version;
        if (!schemaAtIntended) {
          const r = schemaUpgrade({ endpointId: ep, capability: { kind: "schema_upgrade", token }, requestKey: token + ":schema:" + ep, fromSchema: "1.0", toSchema: "1.1-transition", env, _inject });
          const sc = stepCommitCheck(r, "ledger");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: r?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点：写后读回前
        }
        // 返修三：schema 首次（写后）与恢复支（现场已 after）统一 sealAndVerifyStep。
        const s = sealAndVerifyStep({
          targetDir: d.dir,
          readVerified: () => { const a = loadLedger(d.dir, { endpointId: ep }); return { ok: a.ok, projection: a.ok ? { schema_version: a.doc.schema_version, revision: a.doc.revision, ledger_sha256: a.sha256 } : {} }; },
          intended: st.intended_after,
          residueAllowed: ledgerAllowed,
          inject: _inject,
        });
        if (!s.ok) return { ok: false, reason: schemaAtIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }

    // c. 每 ep mint：从 journal 锚的 intended_blob 读 plan（sha/bytes/0600/单硬链接）→ 执行器消费
    for (const st of doc.steps.filter((s) => s.kind === "mint")) {
      const ep = st.id.slice("mint:".length);
      if (st.state !== "done") {
        const dd = resolveEndpointDir(ep, { env });
        if (!dd.ok) return { ok: false, reason: dd.reason, why: ep, phase };
        const ia = st.intended_after;
        // 恢复支：mint 已提交（现场===intended，journal step 仍 prepared）→ 不重跑执行器，统一 sealAndVerifyStep。
        const mintAtIntended = (() => {
          const a = loadLedger(dd.dir, { endpointId: ep });
          if (!a.ok) return false;
          const inv = migrationInventory(a.doc);
          return a.sha256 === ia.ledger_sha256 && a.doc.revision === ia.revision && inv.null_b1_count === ia.null_b1_count;
        })();
        if (!mintAtIntended) {
          const blob = st.intended_blob;
          const pb = readStagedVerified(blob.path, { sha256: blob.sha256, bytes: blob.bytes });
          if (!pb.ok) return { ok: false, reason: "mint_plan_unreadable", why: ep + "：" + pb.why, phase };
          let plan;
          try { plan = JSON.parse(pb.buf.toString("utf-8")); }
          catch (err) { return { ok: false, reason: "mint_plan_corrupt", why: ep + "：" + errText(err), phase }; }
          const pp = mintPlanProblem(plan);
          if (pp !== null) return { ok: false, reason: "mint_plan_corrupt", why: ep + "：" + pp, phase };
          const r = mintSelectionHandles({ endpointId: ep, capability: { kind: "mint_selection_handles", token }, plan, env, _inject });
          const sc = stepCommitCheck(r, "ledger");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: r?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点：执行器返回 ok 后、重读账本前
        }
        // 返修三：mint 首次（写后）与恢复支（现场===intended）统一 sealAndVerifyStep。
        const s = sealAndVerifyStep({
          targetDir: dd.dir,
          readVerified: () => { const a = loadLedger(dd.dir, { endpointId: ep }); return { ok: a.ok, projection: a.ok ? { revision: a.doc.revision, null_b1_count: migrationInventory(a.doc).null_b1_count, ledger_sha256: a.sha256 } : {} }; },
          intended: ia,
          residueAllowed: ledgerAllowed,
          inject: _inject,
        });
        if (!s.ok) return { ok: false, reason: mintAtIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }

    // d. writer_state partial
    {
      const st = doc.steps.find((s) => s.kind === "writer_state");
      if (!st) return { ok: false, reason: "writer_state_step_absent", phase };
      if (st.state !== "done") {
        const ws = readWriterState(env);
        const intended = st.intended_after;
        const atIntended = ws.exists && ws.sha256 === intended.sha256 && ws.state === intended.state && ws.campaign_id === intended.campaign_id && ws.endpoints_digest === intended.endpoints_digest;
        if (!atIntended) {
          const rebuild = buildOsmWriterDoc({ token, cid, digest: intended.endpoints_digest, expectedRevision: intended.revision });
          if (shaHex(serializeLedger(rebuild)) !== intended.sha256) return { ok: false, reason: "writer_budget_drift", why: "partial 写入前状态与进段预算不一致（说不清）", phase };
          const w = writeWriterState({ env, expectedSha256: ws.exists ? ws.sha256 : null, doc: rebuild, capability: { token, stepId: st.id } });
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点：写后读回前
        }
        // 返修三：writer 首次（写后）与恢复支（现场===intended）统一 sealAndVerifyStep。
        const s = sealAndVerifyStep({
          targetDir: path.dirname(writerStatePath(env)),
          readVerified: () => { const a = readWriterState(env); return { ok: a.state !== "unreadable", projection: a.state === "unreadable" ? {} : { exists: a.exists, sha256: a.sha256, state: a.state, campaign_id: a.campaign_id, endpoints_digest: a.endpoints_digest, revision: a.revision } }; },
          intended,
          residueAllowed: campaignAllowedFor(doc.steps.find((s) => s.kind === "campaign")?.intended_after.endpoints),
          inject: _inject,
        });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }

    // e. 全部 done → ledger_reopening
    const np = setPhase({ dir: ctx.dir, token, lease, phase: "ledger_reopening", expectPhase: "osm_a_upgrading", now: ctx.now() });
    if (!np.ok) return { ok: false, reason: np.reason, why: np.why ?? null, phase };
    phase = "ledger_reopening";
  }

  if (phase === "osm_b_strictening") {
    const cid = doc.steps.find((s) => s.kind === "campaign").id.split(":")[1];
    const stepDone = (id, after) => { const m = markStepDone({ dir: ctx.dir, token, lease, id, after, now: ctx.now() }); if (!m.ok) return m; return null; };
    // a seal
    {
      const st = doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":seal"));
      if (st.state !== "done") {
        const cs = readCampaignState(env);
        const intended = st.intended_after;
        const atIntended = cs.exists && cs.sha256 === intended.sha256 && cs.state === "sealed";
        if (!atIntended) {
          let openFull;
          try { openFull = JSON.parse(cs.raw.toString("utf-8")); }
          catch (err) { return { ok: false, reason: "campaign_unreadable", why: errText(err), phase }; }
          if (openFull.state !== "open") return { ok: false, reason: "campaign_state_bad", why: "seal 前现场非 open（" + openFull.state + "）", phase };
          const sealDoc = { ...openFull, state: "sealed", pending_joins: [], revision: openFull.revision + 1 };
          if (shaHex(serializeLedger(sealDoc)) !== intended.sha256) return { ok: false, reason: "campaign_budget_drift", why: "seal 预算漂移", phase };
          const w = writeCampaignState({ env, expectedSha256: cs.sha256, doc: sealDoc, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 返修三 测试注入点：写后读回前
        }
        // 返修三：B/direct 首次 clean 提交与恢复支统一 sealAndVerifyStep。
        const s = sealAndVerifyStep({ targetDir: path.dirname(campaignPath(env)), readVerified: () => campaignProj(env), intended, residueAllowed: campaignAllowedFor(intended?.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // b 每 ep precheck：当场再盘，非零 → 停门不记 done
    for (const st of doc.steps.filter((s) => s.kind === "precheck")) {
      if (st.state !== "done") {
        const ep = st.id.slice("precheck:".length);
        const d = resolveEndpointDir(ep, { env });
        const L = loadLedger(d.dir, { endpointId: ep });
        const inv = migrationInventory(L.doc);
        // R53 返修五 P1-4（#138 五轮）：precheck 做四字段完整投影等式（revision/ledger_sha256/两计数），不只核两计数——否则可记假 after。
        if (!L.ok || inv.legacy_proof_count !== st.intended_after.legacy_proof_count || inv.null_b1_count !== st.intended_after.null_b1_count
          || L.doc.revision !== st.intended_after.revision || L.sha256 !== st.intended_after.ledger_sha256) {
          return { ok: false, reason: "precheck_failed", why: ep + " 前置投影与预算不符（revision=" + String(L.doc?.revision ?? "?") + " 预期 " + st.intended_after.revision + "）", phase };
        }
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // c 每 ep schemaUpgrade(strict)
    for (const st of doc.steps.filter((s) => s.kind === "schema_endpoint")) {
      const ep = st.id.slice("schema_endpoint:".length).split(":")[0];
      if (st.state !== "done") {
        const d = resolveEndpointDir(ep, { env });
        if (!d.ok) return { ok: false, reason: d.reason, why: ep, phase };
        const L = loadLedger(d.dir, { endpointId: ep });
        const atIntended = L.ok && L.sha256 === st.intended_after.ledger_sha256 && L.doc.schema_version === "1.1";
        if (!atIntended) {
          const r = schemaUpgrade({ endpointId: ep, capability: { kind: "schema_upgrade", token }, requestKey: token + ":schema:" + ep, fromSchema: "1.1-transition", toSchema: "1.1", env, _inject });
          const sc = stepCommitCheck(r, "ledger");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: r?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id);
        }
        const s = sealAndVerifyStep({ targetDir: d.dir, readVerified: () => ledgerProj(ep, d.dir), intended: st.intended_after, residueAllowed: LEDGER_ALLOWED, inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // d complete：前置 = 全部 strict step done
    {
      const st = doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":complete"));
      if (st.state !== "done") {
        const jNow = readJournal({ dir: ctx.dir, token });
        if (!jNow.doc.steps.filter((s) => s.kind === "schema_endpoint").every((s) => s.state === "done")) return { ok: false, reason: "strict_not_converged", phase };
        const cs = readCampaignState(env);
        const intended = st.intended_after;
        const atIntended = cs.exists && cs.sha256 === intended.sha256 && cs.state === "complete";
        if (atIntended) {
          // R53 返修五 P1-4：complete 恢复支逐 endpoint 复核——仍 strict(1.1) 且计数 0，现场被改 → 拒。
          const members = frozenMembersOf(ctx, { env, frozen: intended.endpoints });
          if (members?.why) return { ok: false, reason: "complete_members_unreadable", why: members.why, phase };
          for (const ep of intended.endpoints) {
            const m = members[ep];
            if (!m || m.schema_version !== "1.1" || m.legacy_proof_count !== 0 || m.null_b1_count !== 0) {
              return { ok: false, reason: "complete_members_drift", why: ep + " 恢复支现场不符（schema=" + String(m?.schema_version ?? "?") + "）", phase };
            }
          }
        } else {
          let sealedFull;
          try { sealedFull = JSON.parse(cs.raw.toString("utf-8")); }
          catch (err) { return { ok: false, reason: "campaign_unreadable", why: errText(err), phase }; }
          if (sealedFull.state !== "sealed") return { ok: false, reason: "campaign_state_bad", why: "complete 前现场非 sealed", phase };
          const completeDoc = { ...sealedFull, state: "complete", members: frozenMembersOf(ctx, { env, frozen: intended.endpoints }), revision: sealedFull.revision + 1 };
          if (shaHex(serializeLedger(completeDoc)) !== intended.sha256) return { ok: false, reason: "campaign_budget_drift", why: "complete 预算漂移", phase };
          const w = writeCampaignState({ env, expectedSha256: cs.sha256, doc: completeDoc, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点
        }
        const s = sealAndVerifyStep({ targetDir: path.dirname(campaignPath(env)), readVerified: () => campaignProj(env), intended, residueAllowed: campaignAllowedFor(intended?.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // e on：前置 = complete step done；写后准入投影必 on
    {
      const stNow = readJournal({ dir: ctx.dir, token }).doc.steps.find((s) => s.kind === "writer_state");
      if (stNow.state !== "done") {
        const jNow = readJournal({ dir: ctx.dir, token });
        const completeStep = jNow.doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":complete"));
        if (!completeStep || completeStep.state !== "done") return { ok: false, reason: "complete_not_done", why: "on 的前置：campaign complete 未 done", phase };
        const st = jNow.doc.steps.find((s) => s.kind === "writer_state");
        const ws = readWriterState(env);
        const intended = st.intended_after;
        const atIntended = ws.exists && ws.sha256 === intended.sha256 && ws.state === "on";
        if (!atIntended) {
          const rebuild = buildOsmWriterDoc({ token, cid, digest: intended.endpoints_digest, expectedRevision: intended.revision, state: "on" });
          if (shaHex(serializeLedger(rebuild)) !== intended.sha256) return { ok: false, reason: "writer_budget_drift", why: "on 预算漂移", phase };
          const w = writeWriterState({ env, expectedSha256: ws.exists ? ws.sha256 : null, doc: rebuild, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点
        }
        const s = sealAndVerifyStep({ targetDir: path.dirname(writerStatePath(env)), readVerified: () => writerProj(env), intended, residueAllowed: campaignAllowedFor(doc.steps.find((x) => x.kind === "campaign")?.intended_after.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const adm = readOwnerSelectAdmission(env);
        if (adm.state !== "on") return { ok: false, reason: "written_mismatch", why: "on 写后准入投影 ≠ on（" + adm.state + "）", phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    const np = setPhase({ dir: ctx.dir, token, lease, phase: "ledger_reopening", expectPhase: "osm_b_strictening", now: ctx.now() });
    if (!np.ok) return { ok: false, reason: np.reason, why: np.why ?? null, phase };
    phase = "ledger_reopening";
  }

  if (phase === "osm_direct") {
    const cid = doc.steps.find((s) => s.kind === "campaign").id.split(":")[1];
    const stepDone = (id, after) => { const m = markStepDone({ dir: ctx.dir, token, lease, id, after, now: ctx.now() }); if (!m.ok) return m; return null; };
    // a open
    {
      const st = doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":open"));
      if (st.state !== "done") {
        const cs = readCampaignState(env);
        const intended = st.intended_after;
        const atIntended = cs.exists && cs.sha256 === intended.sha256 && cs.state === "open";
        if (!atIntended) {
          const rebuild = buildOsmCampaignDoc({ env, frozen: intended.endpoints, cid, token, expectedRevision: (cs.exists ? cs.revision : 0) + 1 });
          if (!rebuild.ok) return { ok: false, reason: "campaign_member_unreadable", why: rebuild.why, phase };
          if (shaHex(serializeLedger(rebuild.doc)) !== intended.sha256) return { ok: false, reason: "campaign_budget_drift", why: "open 预算漂移", phase };
          const w = writeCampaignState({ env, expectedSha256: cs.exists ? cs.sha256 : null, doc: rebuild.doc, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          copyBackup(path.join(ctx.dir, token + ".staged", "backup-campaign.json"), serializeLedger(rebuild.doc)); // seal/complete 步备份合同
        }
        const s = sealAndVerifyStep({ targetDir: path.dirname(campaignPath(env)), readVerified: () => campaignProj(env), intended, residueAllowed: campaignAllowedFor(intended?.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // b precheck（当场再盘）
    for (const st of doc.steps.filter((s) => s.kind === "precheck")) {
      if (st.state !== "done") {
        const ep = st.id.slice("precheck:".length);
        const d = resolveEndpointDir(ep, { env });
        const L = loadLedger(d.dir, { endpointId: ep });
        const inv = migrationInventory(L.doc);
        // R53 返修五 P1-4：precheck 做四字段完整投影等式（revision/ledger_sha256/两计数），不只核两计数——否则可记假 after。
        if (!L.ok || inv.legacy_proof_count !== st.intended_after.legacy_proof_count || inv.null_b1_count !== st.intended_after.null_b1_count
          || L.doc.revision !== st.intended_after.revision || L.sha256 !== st.intended_after.ledger_sha256) {
          return { ok: false, reason: "precheck_failed", why: ep + " 前置投影与预算不符（revision=" + String(L.doc?.revision ?? "?") + " 预期 " + st.intended_after.revision + "）", phase };
        }
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // c schema direct（1.0→1.1）
    for (const st of doc.steps.filter((s) => s.kind === "schema_endpoint")) {
      const ep = st.id.slice("schema_endpoint:".length).split(":")[0];
      if (st.state !== "done") {
        const d = resolveEndpointDir(ep, { env });
        const L = loadLedger(d.dir, { endpointId: ep });
        const atIntended = L.ok && L.sha256 === st.intended_after.ledger_sha256 && L.doc.schema_version === "1.1";
        if (!atIntended) {
          const r = schemaUpgrade({ endpointId: ep, capability: { kind: "schema_upgrade", token }, requestKey: token + ":schema:" + ep, fromSchema: "1.0", toSchema: "1.1", env, _inject });
          const sc = stepCommitCheck(r, "ledger");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: r?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点
        }
        const s = sealAndVerifyStep({ targetDir: d.dir, readVerified: () => ledgerProj(ep, d.dir), intended: st.intended_after, residueAllowed: LEDGER_ALLOWED, inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // d seal
    {
      const st = doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":seal"));
      if (st.state !== "done") {
        const cs = readCampaignState(env);
        const intended = st.intended_after;
        const atIntended = cs.exists && cs.sha256 === intended.sha256 && cs.state === "sealed";
        if (!atIntended) {
          let openFull;
          try { openFull = JSON.parse(cs.raw.toString("utf-8")); }
          catch (err) { return { ok: false, reason: "campaign_unreadable", why: errText(err), phase }; }
          if (openFull.state !== "open") return { ok: false, reason: "campaign_state_bad", why: "seal 前现场非 open", phase };
          const sealDoc = { ...openFull, state: "sealed", pending_joins: [], revision: openFull.revision + 1 };
          if (shaHex(serializeLedger(sealDoc)) !== intended.sha256) return { ok: false, reason: "campaign_budget_drift", why: "seal 预算漂移", phase };
          const w = writeCampaignState({ env, expectedSha256: cs.sha256, doc: sealDoc, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点
        }
        const s = sealAndVerifyStep({ targetDir: path.dirname(campaignPath(env)), readVerified: () => campaignProj(env), intended, residueAllowed: campaignAllowedFor(intended?.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // e complete
    {
      const stNow = readJournal({ dir: ctx.dir, token }).doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":complete"));
      const st = stNow;
      if (st.state !== "done") {
        const cs = readCampaignState(env);
        const intended = st.intended_after;
        const atIntended = cs.exists && cs.sha256 === intended.sha256 && cs.state === "complete";
        if (atIntended) {
          // R53 返修五 P1-4：complete 恢复支逐 endpoint 复核——仍 strict(1.1) 且计数 0，现场被改 → 拒。
          const members = frozenMembersOf(ctx, { env, frozen: intended.endpoints });
          if (members?.why) return { ok: false, reason: "complete_members_unreadable", why: members.why, phase };
          for (const ep of intended.endpoints) {
            const m = members[ep];
            if (!m || m.schema_version !== "1.1" || m.legacy_proof_count !== 0 || m.null_b1_count !== 0) {
              return { ok: false, reason: "complete_members_drift", why: ep + " 恢复支现场不符（schema=" + String(m?.schema_version ?? "?") + "）", phase };
            }
          }
        } else {
          let sealedFull;
          try { sealedFull = JSON.parse(cs.raw.toString("utf-8")); }
          catch (err) { return { ok: false, reason: "campaign_unreadable", why: errText(err), phase }; }
          if (sealedFull.state !== "sealed") return { ok: false, reason: "campaign_state_bad", why: "complete 前现场非 sealed", phase };
          const completeDoc = { ...sealedFull, state: "complete", members: frozenMembersOf(ctx, { env, frozen: intended.endpoints }), revision: sealedFull.revision + 1 };
          if (shaHex(serializeLedger(completeDoc)) !== intended.sha256) return { ok: false, reason: "campaign_budget_drift", why: "complete 预算漂移", phase };
          const w = writeCampaignState({ env, expectedSha256: cs.sha256, doc: completeDoc, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点
        }
        const s = sealAndVerifyStep({ targetDir: path.dirname(campaignPath(env)), readVerified: () => campaignProj(env), intended, residueAllowed: campaignAllowedFor(intended?.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    // f on：前置 = complete step done
    {
      const jOn = readJournal({ dir: ctx.dir, token });
      const st = jOn.doc.steps.find((s) => s.kind === "writer_state");
      if (st.state !== "done") {
        const completeStep = jOn.doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(":complete"));
        if (!completeStep || completeStep.state !== "done") return { ok: false, reason: "complete_not_done", why: "on 的前置：campaign complete 未 done", phase };
        const ws = readWriterState(env);
        const intended = st.intended_after;
        const atIntended = ws.exists && ws.sha256 === intended.sha256 && ws.state === "on";
        if (!atIntended) {
          const rebuild = buildOsmWriterDoc({ token, cid, digest: intended.endpoints_digest, expectedRevision: intended.revision, state: "on" });
          if (shaHex(serializeLedger(rebuild)) !== intended.sha256) return { ok: false, reason: "writer_budget_drift", why: "on 预算漂移", phase };
          const w = writeWriterState({ env, expectedSha256: ws.exists ? ws.sha256 : null, doc: rebuild, capability: { token, stepId: st.id } });
          if (!w.ok) return { ok: false, reason: w.reason, why: w.why ?? null, phase, commit: w.commit ?? "not_committed" };
          const sc = stepCommitCheck(w, "state");
          if (sc) return { ok: false, reason: sc.reason, why: sc.why ?? null, phase, commit: w?.commit ?? "not_committed" };
          if (typeof ctx.afterWrite === "function") ctx.afterWrite(st.id); // 测试注入点
        }
        const s = sealAndVerifyStep({ targetDir: path.dirname(writerStatePath(env)), readVerified: () => writerProj(env), intended, residueAllowed: campaignAllowedFor(doc.steps.find((x) => x.kind === "campaign")?.intended_after.endpoints), inject: _inject });
        if (!s.ok) return { ok: false, reason: atIntended ? "recovery_seal_failed" : "written_mismatch", why: s.why, phase };
        const adm = readOwnerSelectAdmission(env);
        if (adm.state !== "on") return { ok: false, reason: "written_mismatch", why: "on 写后准入投影 ≠ on（" + adm.state + "）", phase };
        const m = stepDone(st.id, st.intended_after);
        if (m) return { ok: false, reason: m.reason, why: m.why ?? null, phase };
        afterStep(ctx, st.id);
      }
    }
    const np = setPhase({ dir: ctx.dir, token, lease, phase: "ledger_reopening", expectPhase: "osm_direct", now: ctx.now() });
    if (!np.ok) return { ok: false, reason: np.reason, why: np.why ?? null, phase };
    phase = "ledger_reopening";
  }

  if (phase === "ledger_reopening" || phase === "reopening_incomplete") return osmReopening(ctx, token, lease, env);
  return { ok: false, reason: "unexpected_phase", phase };
}

/** ── B 前置（§二.1）：campaign open（cid 取自文件）+ pending_joins 空 + writer partial 同 id + 每 ep transition 计数 0 ── */
function osmPrecheckB(ctx, { env, j }) {
  // 返修二 P1-1 复用：两链 runtime 必已受验支持过渡（非仅 A）。
  const rtB = runtimeTransitionCapable({ env, j });
  if (!rtB.ok) return { ok: false, reason: "precheck_failed", why: "runtime_not_transition_capable" + (rtB.why ? "：" + rtB.why : "") };
  const cs = readCampaignState(env);
  if (cs.state === "unreadable") return { ok: false, reason: "campaign_unreadable", why: cs.problem };
  if (!cs.exists) return { ok: false, reason: "campaign_absent", why: "B 前置要求 campaign open（文件缺席）" };
  if (cs.state !== "open") return { ok: false, reason: "campaign_state_bad", why: "campaign state=" + cs.state + "（B 要求 open）" };
  let pending = [];
  try { pending = JSON.parse(cs.raw.toString("utf-8")).pending_joins ?? []; }
  catch (err) { return { ok: false, reason: "campaign_unreadable", why: errText(err) }; }
  if (pending.length !== 0) return { ok: false, reason: "pending_joins_pending", why: "campaign 有未落地的加入：" + pending.length + " 项（B 开始前必须清空）" };
  const ws = readWriterState(env);
  if (ws.state === "unreadable") return { ok: false, reason: "writer_state_unreadable", why: ws.problem };
  if (!ws.exists || ws.state !== "partial") return { ok: false, reason: "writer_state_not_partial", why: "B 前置要求 writer partial（现 " + (ws.exists ? ws.state : "off") + "）" };
  if (ws.campaign_id !== cs.campaign_id) return { ok: false, reason: "writer_state_foreign", why: "writer partial 属别的 campaign：" + ws.campaign_id };
  // R53 返修五 P1-3（#138 五轮）：B 前置核**完整** partial 联合——不只 campaign_id，还核 endpoints_digest 跨文件一致，
  //   且 readOwnerSelectAdmission 投影必须为同 campaign 的 partial（post_js：不自洽 partial 会被静默改写成 on）。
  if (ws.endpoints_digest !== cs.endpoints_digest) return { ok: false, reason: "writer_state_foreign", why: "writer partial endpoints_digest 与 campaign 不一致" };
  const adm = readOwnerSelectAdmission(env);
  if (adm.state === "unreadable") return { ok: false, reason: "admission_unreadable", why: adm.problem };
  if (adm.state !== "partial" || adm.campaign_id !== ws.campaign_id) return { ok: false, reason: "admission_not_partial", why: "admission 非 partial 或属别的 campaign（现 " + adm.state + "）" };
  const frozen = [...(cs.endpoints ?? [])].sort();
  if (frozen.length === 0) return { ok: false, reason: "frozen_set_empty", why: "campaign endpoints 为空" };
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return { ok: false, reason: d.reason, why: ep, ep };
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: ep + "：" + (L.why ?? L.reason), ep };
    if (L.doc.schema_version !== "1.1-transition") return { ok: false, reason: "schema_not_transition", why: ep + " schema_version=" + L.doc.schema_version + "（B 要求 1.1-transition）", ep };
    const inv = migrationInventory(L.doc);
    if (inv.legacy_proof_count !== 0 || inv.null_b1_count !== 0) return { ok: false, reason: "precheck_failed", why: ep + " 当场盘点 legacy=" + inv.legacy_proof_count + " nullB1=" + inv.null_b1_count + "（门外 reaffirm 未完成的信号）", ep };
  }
  return { ok: true, frozen, cid: cs.campaign_id, digest: cs.endpoints_digest };
}

/** ── direct 前置（§三.1）：冻结集 = initDone 收据；每 ep 1.0 且两计数 0；campaign absent|complete；writer off|on ── */
function osmPrecheckDirect(ctx, { env, j }) {
  // 返修二 P1-1 复用：两链 runtime 必已受验支持过渡（非仅 A）。
  const rtD = runtimeTransitionCapable({ env, j });
  if (!rtD.ok) return { ok: false, reason: "precheck_failed", why: "runtime_not_transition_capable" + (rtD.why ? "：" + rtD.why : "") };
  // P1-2（R52 返修一）：用唯一聚合 aggregateEndpointReceipts——任一端点收据 conflict/in-flight/duplicate/unreadable
  //   → 整体 precheck_failed（why 点名），绝不拿剩余子集（自建 aggregateInitDone 已废）；R53 direct 天然继承。
  const agg = aggregateEndpointReceipts({ dir: ctx.dir });
  if (!agg.ok) return { ok: false, reason: "precheck_failed", why: agg.why ?? null };
  const frozen = [...new Set(agg.endpoints.filter((e) => e.initDone === true).map((e) => e.endpointId))].sort();
  if (frozen.length === 0) return { ok: false, reason: "frozen_set_empty", why: "无任何 initDone 收据的 endpoint，冻结集为空" };
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return { ok: false, reason: d.reason, why: ep, ep };
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: ep + "：" + (L.why ?? L.reason), ep };
    if (L.doc.schema_version !== "1.0") return { ok: false, reason: "schema_not_old", why: ep + " schema_version=" + L.doc.schema_version + "（direct 要求 1.0）", ep };
    const inv = migrationInventory(L.doc);
    if (inv.legacy_proof_count !== 0 || inv.null_b1_count !== 0) return { ok: false, reason: "precheck_failed", why: ep + " 计数非零（legacy=" + inv.legacy_proof_count + " nullB1=" + inv.null_b1_count + "）—— 改走 A", ep };
  }
  const cs = readCampaignState(env);
  if (cs.state === "unreadable") return { ok: false, reason: "campaign_unreadable", why: cs.problem };
  if (cs.exists && cs.state !== "complete") return { ok: false, reason: "campaign_state_bad", why: "campaign state=" + cs.state + "（direct 要求 absent 或 complete）" };
  const ws = readWriterState(env);
  if (ws.state === "unreadable") return { ok: false, reason: "writer_state_unreadable", why: ws.problem };
  // R53 返修五 P1-3：direct 前置要求 writer **精确为 off**（缺席或 off）；既有 partial 或 on 一律拒，否则进段后
  //   journal 的 writer_state:on before=on（非 partial/off）shape 拒、operation 留在 drained 不回退（staged 已备好）。
  if (ws.exists && ws.state !== "off") return { ok: false, reason: "writer_state_not_off", why: "writer state=" + ws.state + "（direct 要求 off，即 absent 或 off，在准备任何制品前）" };
  return { ok: true, frozen };
}

/** ── B 进段准备（§二.2）：seal + 每 ep precheck/strict + complete + writer on，全部 prepared ── */
function osmPrepareForwardB(ctx, { token, env, frozen, cid, digest }) {
  const stagedDir = path.join(ctx.dir, token + ".staged");
  try { mkdirDurable(stagedDir, ctx.dir); }
  catch (err) {
    if (err?.code === "EPRIVMODE" || err?.code === "EPRIVLINK") return { ok: false, reason: "staged_residue", why: err.message };
    return { ok: false, reason: "io_error", why: "建 staged 目录：" + errText(err) };
  }
  const cs = readCampaignState(env);
  if (!cs.exists || cs.state !== "open") return { ok: false, reason: "campaign_state_bad", why: "seal 前重读 campaign 非 open" };
  const ws = readWriterState(env);
  const writerBefore = { exists: true, sha256: ws.sha256, state: ws.state, campaign_id: ws.campaign_id, endpoints_digest: ws.endpoints_digest, revision: ws.revision };
  // open 全量现场 → seal/complete doc（同一现场派生，预算可对）
  const openFull = JSON.parse(cs.raw.toString("utf-8"));
  const sealDoc = { ...openFull, state: "sealed", pending_joins: [], revision: openFull.revision + 1 };
  const completeDoc = { ...sealDoc, state: "complete", members: Object.fromEntries(frozen.map((ep) => [ep, { schema_version: "1.1", legacy_proof_count: 0, null_b1_count: 0 }])), revision: sealDoc.revision + 1 };
  const campaignBefore = { exists: true, sha256: cs.sha256, state: cs.state, campaign_id: cs.campaign_id, endpoints: cs.endpoints, endpoints_digest: cs.endpoints_digest };
  const sealAfter = { exists: true, sha256: shaHex(serializeLedger(sealDoc)), state: "sealed", campaign_id: cid, endpoints: frozen, endpoints_digest: digest };
  const completeAfter = { exists: true, sha256: shaHex(serializeLedger(completeDoc)), state: "complete", campaign_id: cid, endpoints: frozen, endpoints_digest: digest };
  // R53 返修五 P1-1（#138 五轮 P1）——WAL 备份与盘上事实一致：只给有状态变更的 step 独立备份，
  //   文件名 = backup-<stepIdEncoded>.json（%XX 编码非 [A-Za-z0-9._-]，唯一可逆）；before 出处：首个改该文件的
  //   step 取受验 fd 原始字节、后继 step（seal→complete）取前驱确定性 intended 字节（预算序列化）；逐份核 SHA/长度后才进段。
  const sealStepId = "campaign:" + cid + ":seal";
  const completeStepId = "campaign:" + cid + ":complete";
  const writerOnStepId = "writer_state:" + cid + ":on";
  const sealBackup = copyBackup(backupPathFor(stagedDir, sealStepId), cs.raw);
  if (!sealBackup.ok) return failWithStagedClean(stagedDir, sealBackup.reason, "seal 备份：" + sealBackup.why);
  if (sealBackup.sha256 !== campaignBefore.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "seal 备份 sha ≠ before.sha256");
  const completeBackup = copyBackup(backupPathFor(stagedDir, completeStepId), serializeLedger(sealDoc));
  if (!completeBackup.ok) return failWithStagedClean(stagedDir, completeBackup.reason, "complete 备份：" + completeBackup.why);
  if (completeBackup.sha256 !== sealAfter.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "complete 备份 sha ≠ before.sha256（前驱 seal intended 字节）");
  const writerOnBackup = copyBackup(backupPathFor(stagedDir, writerOnStepId), ws.raw);
  if (!writerOnBackup.ok) return failWithStagedClean(stagedDir, writerOnBackup.reason, "writer 备份：" + writerOnBackup.why);
  if (writerOnBackup.sha256 !== writerBefore.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "writer 备份 sha ≠ before.sha256");
  const writerAfter = { exists: true, sha256: shaHex(serializeLedger(buildOsmWriterDoc({ token, cid, digest, expectedRevision: ws.revision + 1, state: "on" }))), state: "on", campaign_id: cid, endpoints_digest: digest, revision: ws.revision + 1 };
  const at = new Date(ctx.now()).toISOString();
  const steps = [];
  steps.push({ kind: "campaign", id: sealStepId, state: "prepared", at, target: "ledger/owner-select-campaign.json", chain: null, before: campaignBefore, intended_after: sealAfter, backup: backupPathFor(stagedDir, sealStepId), backup_sha256: sealBackup.sha256, backup_bytes: sealBackup.bytes });
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    const L = loadLedger(d.dir, { endpointId: ep });
    const inv = migrationInventory(L.doc);
    steps.push({ kind: "precheck", id: "precheck:" + ep, state: "prepared", at, target: "ledger/" + ep + "/ledger.json", chain: null, before: { legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count, revision: L.doc.revision, ledger_sha256: L.sha256 }, intended_after: { legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count, revision: L.doc.revision, ledger_sha256: L.sha256 }, backup: null, backup_sha256: null, backup_bytes: null });
    // schema_endpoint 的独立备份（copyBackup 现在真的写盘——改前只登记 backup-ledger-<ep>.json 而从未 copyBackup）。
    const schemaStepId = "schema_endpoint:" + ep + ":strict";
    const sbk = copyBackup(backupPathFor(stagedDir, schemaStepId), L.bytes);
    if (!sbk.ok) return failWithStagedClean(stagedDir, sbk.reason, "schema 备份：" + sbk.why + " ep=" + ep);
    if (sbk.sha256 !== L.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", ep + " schema 备份 sha ≠ before.ledger_sha256");
    const opId = ownerSelectSchemaUpgradeOpId(token, ep);
    const next = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token + ":schema:" + ep, from_schema: "1.1-transition", to_schema: "1.1" });
    steps.push({ kind: "schema_endpoint", id: schemaStepId, state: "prepared", at, target: "ledger/" + ep + "/ledger.json", chain: null, before: { schema_version: "1.1-transition", revision: L.doc.revision, ledger_sha256: L.sha256 }, intended_after: { schema_version: "1.1", revision: L.doc.revision + 1, ledger_sha256: shaHex(serializeLedger(next)) }, backup: backupPathFor(stagedDir, schemaStepId), backup_sha256: sbk.sha256, backup_bytes: sbk.bytes });
  }
  steps.push({ kind: "campaign", id: completeStepId, state: "prepared", at, target: "ledger/owner-select-campaign.json", chain: null, before: sealAfter, intended_after: completeAfter, backup: backupPathFor(stagedDir, completeStepId), backup_sha256: completeBackup.sha256, backup_bytes: completeBackup.bytes });
  steps.push({ kind: "writer_state", id: writerOnStepId, state: "prepared", at, target: "ledger/owner-select-writer-state.json", chain: null, before: writerBefore, intended_after: writerAfter, backup: backupPathFor(stagedDir, writerOnStepId), backup_sha256: writerOnBackup.sha256, backup_bytes: writerOnBackup.bytes });
  try { fsyncDir(stagedDir); }
  catch (err) { return failWithStagedClean(stagedDir, "backup_dir_fsync_failed", "fsync staged 目录：" + errText(err)); }
  return { ok: true, steps, phase: "osm_b_strictening" };
}

/** ── direct 进段准备（§三.2）：open + 每 ep precheck/direct + seal + complete + writer on（before off）── */
function osmPrepareForwardDirect(ctx, { token, env, frozen }) {
  const cid = campaignIdFor(token);
  const digest = endpointsDigest(frozen);
  const cs = readCampaignState(env);
  const campaignBefore = cs.exists
    ? { exists: true, sha256: cs.sha256, state: cs.state, campaign_id: cs.campaign_id, endpoints: cs.endpoints, endpoints_digest: cs.endpoints_digest }
    : { exists: false, sha256: null, state: "absent", campaign_id: null, endpoints: null, endpoints_digest: null };
  const ws = readWriterState(env);
  const writerBefore = ws.exists
    ? { exists: true, sha256: ws.sha256, state: ws.state, campaign_id: ws.campaign_id, endpoints_digest: ws.endpoints_digest, revision: ws.revision }
    : { exists: false, sha256: null, state: "off", campaign_id: null, endpoints_digest: null, revision: 0 };
  const openDoc = buildOsmCampaignDoc({ env, frozen, cid, token, expectedRevision: (cs.exists ? cs.revision : 0) + 1 });
  if (!openDoc.ok) return { ok: false, reason: "campaign_member_unreadable", why: openDoc.why };
  const openAfter = { exists: true, sha256: shaHex(serializeLedger(openDoc.doc)), state: "open", campaign_id: cid, endpoints: frozen, endpoints_digest: digest };
  const sealDoc = { ...openDoc.doc, state: "sealed", revision: openDoc.doc.revision + 1 };
  const sealAfter = { exists: true, sha256: shaHex(serializeLedger(sealDoc)), state: "sealed", campaign_id: cid, endpoints: frozen, endpoints_digest: digest };
  const completeDoc = { ...sealDoc, state: "complete", members: Object.fromEntries(frozen.map((ep) => [ep, { schema_version: "1.1", legacy_proof_count: 0, null_b1_count: 0 }])), revision: sealDoc.revision + 1 };
  const completeAfter = { exists: true, sha256: shaHex(serializeLedger(completeDoc)), state: "complete", campaign_id: cid, endpoints: frozen, endpoints_digest: digest };
  const writerAfter = { exists: true, sha256: shaHex(serializeLedger(buildOsmWriterDoc({ token, cid, digest, expectedRevision: (ws.exists ? ws.revision : 0) + 1, state: "on" }))), state: "on", campaign_id: cid, endpoints_digest: digest, revision: (ws.exists ? ws.revision : 0) + 1 };
  const stagedDir = path.join(ctx.dir, token + ".staged");
  try { mkdirDurable(stagedDir, ctx.dir); }
  catch (err) {
    if (err?.code === "EPRIVMODE" || err?.code === "EPRIVLINK") return { ok: false, reason: "staged_residue", why: err.message };
    return { ok: false, reason: "io_error", why: "建 staged 目录：" + errText(err) };
  }
  // R53 返修五 P1-1（#138 五轮 P1）——WAL 备份与盘上事实一致：只给有状态变更的 step 独立备份，
  //   文件名 = backup-<stepIdEncoded>.json（%XX 编码非 [A-Za-z0-9._-]，唯一可逆）；before 出处：首个改该文件的
  //   step 取受验 fd 原始字节、后继 step（open→seal→complete）取前驱确定性 intended 字节（预算序列化）；逐份核 SHA/长度后才进段。
  const openStepId = "campaign:" + cid + ":open";
  const sealStepId = "campaign:" + cid + ":seal";
  const completeStepId = "campaign:" + cid + ":complete";
  const writerOnStepId = "writer_state:" + cid + ":on";
  let openBackup = { backup: null, backup_sha256: null, backup_bytes: null };
  if (campaignBefore.exists) {
    const cb = copyBackup(backupPathFor(stagedDir, openStepId), cs.raw);
    if (!cb.ok) return failWithStagedClean(stagedDir, cb.reason, "open 备份：" + cb.why);
    if (cb.sha256 !== campaignBefore.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "open 备份 sha ≠ before.sha256");
    openBackup = { backup: backupPathFor(stagedDir, openStepId), backup_sha256: cb.sha256, backup_bytes: cb.bytes };
  }
  const openBytes = serializeLedger(openDoc.doc);
  const sealDocBytes = serializeLedger(sealDoc);
  const sealBk = copyBackup(backupPathFor(stagedDir, sealStepId), openBytes);
  if (!sealBk.ok) return failWithStagedClean(stagedDir, sealBk.reason, "seal 备份：" + sealBk.why);
  if (sealBk.sha256 !== openAfter.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "seal 备份 sha ≠ before.sha256（前驱 open intended 字节）");
  const completeBk = copyBackup(backupPathFor(stagedDir, completeStepId), sealDocBytes);
  if (!completeBk.ok) return failWithStagedClean(stagedDir, completeBk.reason, "complete 备份：" + completeBk.why);
  if (completeBk.sha256 !== sealAfter.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "complete 备份 sha ≠ before.sha256");
  let writerOnBackup = { backup: null, backup_sha256: null, backup_bytes: null };
  if (writerBefore.exists) {
    const wb = copyBackup(backupPathFor(stagedDir, writerOnStepId), ws.raw);
    if (!wb.ok) return failWithStagedClean(stagedDir, wb.reason, "writer 备份：" + wb.why);
    if (wb.sha256 !== writerBefore.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", "writer 备份 sha ≠ before.sha256");
    writerOnBackup = { backup: backupPathFor(stagedDir, writerOnStepId), backup_sha256: wb.sha256, backup_bytes: wb.bytes };
  }
  const at = new Date(ctx.now()).toISOString();
  const steps = [];
  steps.push({ kind: "campaign", id: openStepId, state: "prepared", at, target: "ledger/owner-select-campaign.json", chain: null, before: campaignBefore, intended_after: openAfter, ...openBackup });
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    const L = loadLedger(d.dir, { endpointId: ep });
    const inv = migrationInventory(L.doc);
    steps.push({ kind: "precheck", id: "precheck:" + ep, state: "prepared", at, target: "ledger/" + ep + "/ledger.json", chain: null, before: { legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count, revision: L.doc.revision, ledger_sha256: L.sha256 }, intended_after: { legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count, revision: L.doc.revision, ledger_sha256: L.sha256 }, backup: null, backup_sha256: null, backup_bytes: null });
    // schema_endpoint 的独立备份（copyBackup 现在真的写盘——改前只登记 backup-ledger-<ep>.json 而从未 copyBackup）。
    const schemaStepId = "schema_endpoint:" + ep + ":direct";
    const sbk = copyBackup(backupPathFor(stagedDir, schemaStepId), L.bytes);
    if (!sbk.ok) return failWithStagedClean(stagedDir, sbk.reason, "schema 备份：" + sbk.why + " ep=" + ep);
    if (sbk.sha256 !== L.sha256) return failWithStagedClean(stagedDir, "backup_sha_mismatch", ep + " schema 备份 sha ≠ before.ledger_sha256");
    const opId = ownerSelectSchemaUpgradeOpId(token, ep);
    const next = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token + ":schema:" + ep, from_schema: "1.0", to_schema: "1.1" });
    steps.push({ kind: "schema_endpoint", id: schemaStepId, state: "prepared", at, target: "ledger/" + ep + "/ledger.json", chain: null, before: { schema_version: "1.0", revision: L.doc.revision, ledger_sha256: L.sha256 }, intended_after: { schema_version: "1.1", revision: L.doc.revision + 1, ledger_sha256: shaHex(serializeLedger(next)) }, backup: backupPathFor(stagedDir, schemaStepId), backup_sha256: sbk.sha256, backup_bytes: sbk.bytes });
  }
  steps.push({ kind: "campaign", id: sealStepId, state: "prepared", at, target: "ledger/owner-select-campaign.json", chain: null, before: openAfter, intended_after: sealAfter, backup: backupPathFor(stagedDir, sealStepId), backup_sha256: sealBk.sha256, backup_bytes: sealBk.bytes });
  steps.push({ kind: "campaign", id: completeStepId, state: "prepared", at, target: "ledger/owner-select-campaign.json", chain: null, before: sealAfter, intended_after: completeAfter, backup: backupPathFor(stagedDir, completeStepId), backup_sha256: completeBk.sha256, backup_bytes: completeBk.bytes });
  steps.push({ kind: "writer_state", id: writerOnStepId, state: "prepared", at, target: "ledger/owner-select-writer-state.json", chain: null, before: writerBefore, intended_after: writerAfter, ...writerOnBackup });
  try { fsyncDir(stagedDir); }
  catch (err) { return failWithStagedClean(stagedDir, "backup_dir_fsync_failed", "fsync staged 目录：" + errText(err)); }
  return { ok: true, steps, phase: "osm_direct" };
}

/** complete doc 的成员投影（§8.2 campaign 不变量：complete ⇒ 全 member strict ∧ 两计数 0——按"完成后的应有状态"投影）。 */
function frozenMembersOf(ctx, { env, frozen }) {
  const members = {};
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return { ep, why: d.reason };
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return { ep, why: L.why ?? L.reason };
    const inv = migrationInventory(L.doc);
    members[ep] = { schema_version: L.doc.schema_version, legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count };
  }
  return members;
}

/** campaign open 文档（进段与收敛 a 共用同一构造 → 同一字节 → intended_after.sha256 锚可对）。 */
function buildOsmCampaignDoc({ env, frozen, cid, token, expectedRevision }) {
  const members = {};
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return { ok: false, why: ep + "：" + d.reason };
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return { ok: false, why: ep + "：" + (L.why ?? L.reason) };
    const inv = migrationInventory(L.doc);
    members[ep] = { schema_version: L.doc.schema_version, legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count };
  }
  return { ok: true, doc: {
    schema_version: CAMPAIGN_SCHEMA, campaign_id: cid, state: "open", endpoints: frozen, endpoints_digest: endpointsDigest(frozen),
    pending_joins: [], members, revision: expectedRevision, origin_operation_id: token,
  } };
}

/** writer_state 文档（无账本依赖，纯确定性；state 由调用方给：A=partial、B/direct=on）。 */
function buildOsmWriterDoc({ token, cid, digest, expectedRevision, state = "partial" }) {
  return {
    schema_version: WRITER_STATE_SCHEMA, state, campaign_id: cid, endpoints_digest: digest,
    revision: expectedRevision, origin_operation_id: token,
  };
}

/**
 * osmReopening（§二.6，B-4 顺序）：重开前身份核验 → current 回原目标 → 定时器回原始三态 → 删桩 →
 * ③b 删 <token>.staged/（含 mint plan）→ 撤门 → done → 清 active；任一说不清 → reopening_incomplete（门与 active 保留）。
 */
export function osmReopening(ctx, token, lease, env = process.env) {
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
  const noted = (t) => { const n = addNote({ dir: ctx.dir, token, lease, note: t, now: ctx.now() }); return n.ok ? null : { reason: n.reason, why: n.why, path: n.path }; };
  const bail = (extra) => {
    const p = setPhase({ dir: ctx.dir, token, lease, phase: "reopening_incomplete", expectPhase: "ledger_reopening", now: ctx.now(), note: "说不清 " + incomplete.length + " 项：" + incomplete.map((i) => i.id + "（" + i.why + "）").join("；") });
    return { ok: false, phase: "reopening_incomplete", incomplete, journalWrite: p.ok, ...(p.ok ? {} : { journalWhy: p.why ?? p.reason }), ...extra };
  };

  // ── 重开前身份核验（§二.6）：账本含本 token 的 schema_upgrade 与 mint op（request_key===token）且 revision ≥ 之；
  //    campaign / writer-state 读回 === 各 step after。
  for (const se of doc.steps.filter((s) => s.kind === "schema_endpoint")) {
    const ep = se.id.slice("schema_endpoint:".length).split(":")[0];
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) { incomplete.push({ id: se.id, why: "账本根定位失败：" + d.reason }); continue; }
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) { incomplete.push({ id: se.id, why: "账本缺失/不可读：" + (L.why ?? L.reason) }); continue; }
    const opId = ownerSelectSchemaUpgradeOpId(token, ep);
    const op = L.doc.operations[opId] ?? null;
    const mi = doc.steps.find((s) => s.kind === "mint" && s.id === "mint:" + ep);
    // P1-7 (b)：撤门前逐 ep 核——当前账本 SHA === 最后（mint）step.after；B/direct 无 mint → 核最后 schema step.after（R53 返修五 P1-4）。
    if (mi && L.sha256 !== mi.after.ledger_sha256) incomplete.push({ id: mi.id, why: "当前账本 SHA ≠ 最后（mint）step.after（" + String(L.sha256).slice(0, 12) + " ≠ " + mi.after.ledger_sha256.slice(0, 12) + "）" });
    else if (!mi && L.sha256 !== se.after?.ledger_sha256) incomplete.push({ id: se.id, why: "当前账本 SHA ≠ 最后 schema step.after（" + String(L.sha256).slice(0, 12) + " ≠ " + String(se.after?.ledger_sha256 ?? "?").slice(0, 12) + "）" });
    if (!op) incomplete.push({ id: se.id, why: "账本内不含本 operation 的 schema_upgrade op（" + opId.slice(0, 8) + "）" });
    else if (op.request_key !== token + ":schema:" + ep) incomplete.push({ id: se.id, why: "schema_upgrade 的 request_key 非本 operation 派生键" });
    else if (op.result?.from_schema !== se.before.schema_version || op.result?.to_schema !== se.after.schema_version) incomplete.push({ id: se.id, why: "schema_upgrade 的 from/to 与 step.before/after 不符（" + String(op.result?.from_schema) + "→" + String(op.result?.to_schema) + "，应 " + se.before.schema_version + "→" + se.after.schema_version + "）" });
    else if (op.result_revision < se.intended_after.revision) incomplete.push({ id: se.id, why: "schema_upgrade 的 result_revision（" + op.result_revision + "）早于 journal 意图（" + se.intended_after.revision + "）" });
    else if (L.doc.revision < op.result_revision) incomplete.push({ id: se.id, why: "账本当前 revision 早于本事务" });
    const mop = mi ? Object.values(L.doc.operations).find((o) => o.op_type === "mint_selection_handles" && o.request_key === token) : null;
    if (mi) {
      if (!mop) incomplete.push({ id: mi.id, why: "账本内不含本 operation 的 mint_selection_handles op" });
      else if (mop.request_key !== token) incomplete.push({ id: mi.id, why: "mint op 的 request_key 非本 operation token" });
      else if (mop.result_revision < mi.intended_after.revision) incomplete.push({ id: mi.id, why: "mint 的 result_revision（" + mop.result_revision + "）早于 journal 意图（" + mi.intended_after.revision + "）" });
      else {
        // fingerprint 核：由 op.result.minted 的 target_id 集重算 fingerprint（与 result_revision 处 op 的 result 锚同源）。
        const targets = Array.isArray(mop.result?.minted) ? mop.result.minted.map((m) => m.target_id) : null;
        const expectedFp = targets ? fingerprintOf("mint_selection_handles", { request_key: mop.request_key, endpoint: ep, expected_null_b1_ids: targets }) : null;
        if (mop.fingerprint !== expectedFp) incomplete.push({ id: mi.id, why: "mint op 的 fingerprint 与 result.minted 集不符（被篡改？）" });
      }
    }
  }
  {
    const cs = readCampaignState(env);
    const kind = doc.operation_kind === "owner_select_migration_a" ? "a" : doc.operation_kind === "owner_select_migration_b" ? "b" : "direct";
    const wantCampaignId = kind === "a" ? ":open" : ":complete";
    const cst = doc.steps.find((s) => s.kind === "campaign" && s.id.endsWith(wantCampaignId));
    if (!cst || cst.state !== "done") incomplete.push({ id: "campaign", why: "campaign " + wantCampaignId.slice(1) + " step 尚未 done" });
    else if (!cs.exists || cs.sha256 !== cst.after.sha256 || cs.state !== cst.after.state || cs.campaign_id !== cst.after.campaign_id) incomplete.push({ id: "campaign", why: "campaign 文件读回 ≠ step after" });
    const ws = readWriterState(env);
    const wst = doc.steps.find((s) => s.kind === "writer_state");
    if (!wst || wst.state !== "done") incomplete.push({ id: "writer_state", why: "writer_state step 尚未 done" });
    else if (!ws.exists || ws.sha256 !== wst.after.sha256 || ws.state !== wst.after.state || ws.campaign_id !== wst.after.campaign_id) incomplete.push({ id: "writer_state", why: "writer-state 文件读回 ≠ step after" });
  }
  if (incomplete.length > 0) return bail({});

  // ① current：回原目标（enter 步 before）
  for (const st of doc.steps.filter((s) => s.kind === "current")) {
    const chain = st.id.split(":")[1];
    const facts = factsOf(ctx, chain);
    const live = readlinkOrNull(facts.current);
    if (live.state === "absent") {
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
      if (f !== null) return { ok: false, reason: f.reason, why: f.why, path: f.path, phase: "ledger_reopening" };
      continue;
    }
    incomplete.push({ id: st.id, why: "现场 current=" + live.value + " 既不是桩也不是原目标，不动" });
  }
  const unclearChains = new Set(incomplete.filter((i) => i.id.startsWith("current:")).map((i) => i.id.split(":")[1]));
  // ② 定时器：回原始三态（只有原来 loaded 才 bootstrap；plist 字节按备份还原并核 sha256/长度）
  for (const st of doc.steps.filter((s) => s.kind === "timer")) {
    const chain = st.id.split(":")[1];
    if (unclearChains.has(chain)) continue;
    const facts = factsOf(ctx, chain);
    if (st.before.phase !== "loaded") continue;
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
    if (f !== null) return { ok: false, reason: f.reason, why: f.why, path: f.path, phase: "ledger_reopening" };
  }
  // ③ 删桩
  for (const st of doc.steps.filter((s) => s.kind === "stub")) {
    const chain = st.id.split(":")[1];
    if (unclearChains.has(chain)) { incomplete.push({ id: st.id, why: "同链 current 说不清，桩先留着" }); continue; }
    const facts = factsOf(ctx, chain);
    const r = removeStubVersion({ root: facts.root, token });
    if (!r.ok) incomplete.push({ id: st.id, why: "删桩：" + String(r.reason) + (r.why ? "（" + r.why + "）" : "") });
  }
  // ③b 删 <token>.staged/（含 mint plan；§二.6）：absent 幂等，失败算没做完
  {
    const rp = removeStagedPlan({ dir: ctx.dir, token });
    if (!rp.ok) incomplete.push({ id: "staged", why: "staged 清理：" + String(rp.reason) + (rp.why ? "（" + rp.why + "）" : "") });
  }
  // ④ 全部对得上才撤门
  if (incomplete.length > 0) return bail({});
  if (doc.steps.some((s) => s.kind === "gate")) {
    const g = ctx.gateOps.removeGate({ file: ctx.gateFile, token });
    if (!g.ok && g.reason !== "absent") { incomplete.push({ id: "gate", why: "撤门失败：" + String(g.reason) + (g.why ? "（" + g.why + "）" : "") }); return bail({}); }
    if (g.txnUncleared) { incomplete.push({ id: "gate", why: "门已撤但归属转换锁交不还：" + g.txnUncleared.path }); return bail({ gateRemoved: true }); }
  }
  // ⑤ 终态先持久化，再清 active
  const p = setPhase({ dir: ctx.dir, token, lease, phase: "done", expectPhase: "ledger_reopening", now: ctx.now() });
  if (!p.ok) return { ok: false, reason: "journal_write_failed", why: p.why ?? p.reason, phase: "ledger_reopening" };
  const c = clearActive({ dir: ctx.dir, token });
  if (!c.ok) return { ok: false, phase: "done", activeCleared: false, activeWhy: String(c.reason) + (c.why ? "（" + c.why + "）" : ""), incomplete: [{ id: "active", why: "active 清不掉：" + String(c.reason) }] };
  return { ok: true, phase: "done", activeCleared: c.cleared === true };
}

/** osmEnter：owner_select_migration_a 进门（apply=false 只出 dry-run 计划）。 */
export function osmEnter(ctx, { kind = "a", waitMs = 60000, apply = false, reason = null, env = process.env } = {}) {
  const operationKind = OSM_KIND_TO_OPERATION[kind];
  if (!operationKind) return { ok: false, reason: "bad_kind" };
  const reasonText = reason ?? ("owner_select 迁移 " + kind.toUpperCase() + "：" + OSM_KIND_TO_REASON[kind]);
  if (!apply) return enterMaintenance(ctx, { reason: reasonText, waitMs, apply: false, operationKind });
  const surface = acquireInstallSurfaceLock({ home: ctx.home, env });
  if (!surface.ok) return { ok: false, reason: surface.reason, why: surface.why, path: surface.path };
  const ent = enterMaintenance(ctx, { reason: reasonText, waitMs, apply: true, keepLease: true, operationKind });
  if (!ent.ok || !ent.lease) {
    const rel = releaseSurface(surface);
    return { ...ent, surfaceRelease: rel.ok ? null : { path: rel.path ?? null, why: rel.why ?? rel.reason } };
  }
  let out, rollbackResult = null, crashErr = null;
  try {
    out = osmForward(ctx, { token: ent.token, lease: ent.lease, env });
    if (out.ok === false && out.rollbackSafe === true) {
      // §二.7：回退先删本 operation 的 staged mint plan，删不掉 → rollback_incomplete（不回退，等人工）
      const pd = removeMintPlans(ctx, ent.token);
      if (!pd.ok) {
        const p = setPhase({ dir: ctx.dir, token: ent.token, lease: ent.lease, phase: "rollback_incomplete", now: ctx.now(), note: "回退删 plan 失败：" + pd.why });
        rollbackResult = { ok: false, phase: p.ok ? "rollback_incomplete" : "drained", why: "删 plan 失败：" + pd.why };
      } else {
        rollbackResult = rollbackOperation(ctx, ent.token, ent.lease);
      }
    }
  } catch (err) {
    if (err?.simulatedCrash === true) crashErr = err;
    else out = { ok: false, reason: "osm_forward_failed", why: errText(err), phase: (() => { const jj = readJournal({ dir: ctx.dir, token: ent.token }); return jj.state === "valid" ? jj.doc.phase : null; })(), incomplete: [] };
  }
  if (crashErr !== null) throw crashErr;
  const leaseRel = releaseOperationLease(ent.lease);
  const surfaceRel = releaseSurface(surface);
  return { token: ent.token, ...out, rollback: rollbackResult, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason }, surfaceRelease: surfaceRel.ok ? null : { path: surfaceRel.path ?? null, why: surfaceRel.why ?? surfaceRel.reason } };
}

/** osmExit：--exit 按 operation_kind === owner_select_migration_a 分派（forward 只向前，≤drained 回退，终态清 active）。 */
export function osmExit(ctx, { apply = false, env = process.env, surface: held = null } = {}) {
  const readOp = (dir) => {
    const active = readActive({ dir });
    if (active.state === "absent") return { ok: false, reason: "no_operation" };
    if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why };
    const token = active.token;
    const j = readJournal({ dir, token });
    if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
    const phase = j.doc.phase;
    if (!["owner_select_migration_a", "owner_select_migration_b", "owner_select_migration_direct"].includes(j.doc.operation_kind)) return { ok: false, reason: "not_osm_operation", why: "active 是 " + j.doc.operation_kind + "（走 maintenance-gate --exit 通用分派）", token, phase };
    const action = osmExitAction(phase);
    if (action === null) return { ok: false, reason: "unexpected_phase", why: phase, token, phase };
    return { ok: true, token, phase, action };
  };
  const dry = readOp(ctx.dir);
  if (!dry.ok) return dry;
  if (!apply) return { ok: true, dryRun: true, token: dry.token, phase: dry.phase, action: dry.action };
  const owns = held === null;
  const surface = held ?? acquireInstallSurfaceLock({ home: ctx.home, env });
  if (!surface.ok) return { ok: false, reason: surface.reason, why: surface.why, path: surface.path, token: dry.token, phase: dry.phase, action: dry.action };
  const releaseHeld = (r) => {
    if (!owns) return r;
    const rel = releaseSurface(surface);
    return { ...r, surfaceRelease: rel.ok ? null : { path: rel.path ?? null, why: rel.why ?? rel.reason } };
  };
  const op = readOp(ctx.dir);
  if (!op.ok) return releaseHeld(op);
  const { token, phase, action } = op;
  if (action === "clear_active") {
    const c = clearActive({ dir: ctx.dir, token });
    return releaseHeld({ ok: c.ok, token, phase, action, activeCleared: c.cleared === true, why: c.ok ? null : String(c.reason) });
  }
  const lease = acquireOperationLease({ dir: ctx.dir, token });
  if (!lease.ok) return releaseHeld({ ok: false, reason: lease.reason, why: lease.why, token, phase, action, path: lease.path });
  let out, crashErr = null;
  try {
    if (action === "osm_forward") out = osmForward(ctx, { token, lease, env });
    else {
      // §二.7：drained 回退先删 staged mint plan，删不掉 → rollback_incomplete（门与 active 保留）
      if (phase === "drained") {
        const pd = removeMintPlans(ctx, token);
        if (!pd.ok) {
          const p = setPhase({ dir: ctx.dir, token, lease, phase: "rollback_incomplete", now: ctx.now(), note: "回退删 plan 失败：" + pd.why });
          out = { ok: false, phase: p.ok ? "rollback_incomplete" : "drained", why: "删 plan 失败：" + pd.why, incomplete: [{ id: "staged", why: pd.why }] };
        }
      }
      if (!out) out = rollbackOperation(ctx, token, lease);
    }
  } catch (err) {
    if (err?.simulatedCrash === true) crashErr = err;
    else out = { ok: false, reason: action === "osm_forward" ? "osm_forward_failed" : "osm_rollback_failed", why: errText(err), phase, incomplete: [] };
  }
  if (crashErr !== null) throw crashErr;
  const leaseRel = releaseOperationLease(lease);
  return releaseHeld({ token, action, ...out, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason } });
}
