/**
 * 维护安装核心（issue #81 PR C 第 2 步，方案稿 §89–103）—— **不公开 stage / commit CLI**，只是模块 API，
 * 每一步都绑定 active operation：token、journal 阶段前驱、门 active 且 token 一致、**执行租约属于本 operation**、
 * 两条 `current` 此刻仍是本 token 的桩（commit 之后绑定改核"指向目标版本"），否则拒。命令面只有 scripts/maintenance-install.mjs（enter → 1–5）。
 *
 *   1. stage        两链 stageRuntimeVersion（只落 versions/<v>/，不切 current）→ renderArtifacts（输入线上基线字节）
 *                   → 写 maintenance/<token>.staged/（目标制品字节 + plan.json + 之后 commit 的备份）
 *                   → **plan 锚**：plan.json 的 sha256 + 版本作为 staged_plan step 进受租约保护的 journal → phase staged。不碰任何线上配置。
 *   2. verifyStaged verifyRuntimeVersion 两链；plan 必须过封闭形状与 journal 锚（sha / 版本）；制品路径 ⊆ 由投影重算的安装面 allowlist；
 *                   引用脚本 ⊆ 桩清单 ∪ 存在于本链 versions/<v>/scripts/。只读。
 *   3. commit       门仍在：两条 current（桩 → versions/<v>，activateRuntimeVersion 的 expectBefore 在**安装锁内**做 CAS —— 与 rename 同一把锁）
 *                   → 每个制品写前 CAS（现场 == stage 时的 base，否则 base_changed 整次中止）→ prepared（备份原字节）→ 原子写 → done
 *                   → 两份机器级收据：**一次 fd 读产生同一份快照**（合并基 = CAS 基 = 备份），锁内重读 CAS 后写；
 *                   任何锁残骸（reap 交不还 / 释放失败）都算失败，不记 done → phase committed。
 *   4. verifyLive   verifyRuntime 两链 == v；线上制品 sha == after；plist 的 ProgramArguments == 期望 job；
 *                   Codex 阻断探针（无模型）：起新 runtime 的 prompt-hook（门还开着），顶层 decision:block。→ phase verified。
 *   5. reopening    phase reopening → operation.mjs 的成功路径（删门前精确复核 → 定时器到目标状态 → 删桩 / staged → token-CAS 删门 → done → 清 active）。
 *
 * 失败处置在调用方（CLI）：1–4 任一步失败 → rollbackOperation 按 journal 回退到进门前（versions/<v>/ 保留）；
 * lease_reap_uncleared → 立即停。测试注入点沿用 maintenanceContext（afterStep 在每个 step done 之后、"written:<id>" 在制品写盘与记 done 之间）。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readGate } from "../maintenance-gate-core.mjs";
import { ARTIFACT_KINDS, INSTALLED_SURFACE_SCHEMA, installedSurfaceProblem, readRegularFile, withInstalledSurfaceLock } from "../installed-surface.mjs";
import { activateRuntimeVersion, planRuntimeSync, stageRuntimeVersion, verifyRuntime, verifyRuntimeVersion } from "../runtime-install.mjs";
import { claudeDrainPlistPath, claudeSkillFiles, referencedRuntimeScripts } from "../install-projection.mjs";
import { claudeDrainExpectedJob } from "../drain-schedule.mjs";
import { SKILLS as CODEX_SKILLS } from "../codex/skill-content.mjs";
import { expectedJob as codexExpectedJob, plistPath as codexPlistPath } from "../codex/drain-service.mjs";
import { commitWhileHeld } from "../registry.mjs";
import { addStepPrepared, leasePath, markStepDone, readActive, readJournal, setPhase, writeBackup, writeDurable } from "./journal.mjs";
import { stubRelTarget } from "./stub.mjs";
import { chainAgentUid, chainFacts } from "./precheck.mjs";
import { maintenanceEntryManifest } from "./maintenance-entries.mjs";
import { renderArtifacts } from "./render-artifacts.mjs";
import { reopening, stagedDirPath } from "./operation.mjs";

const CHAINS = ["claude", "codex"];
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
const VERSION_SHAPE = /^[0-9a-f]{16}$/u;
const SCRIPT_SHAPE = /^(codex\/)?[A-Za-z0-9_.-]+\.mjs$/u;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const errText = (err) => String(err?.code ?? err?.message ?? err);
const readlinkOrNull = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
const factsOf = (ctx, chain) => chainFacts({ chain, home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, node: ctx.node });
const afterStep = (ctx, id) => { if (typeof ctx.afterStep === "function") ctx.afterStep(id); };
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");

/** 线上一个文件此刻的基线（fd 绑定读）：{ exists, sha256, bytes } | { unreadable, why }。stage 与 commit 的 CAS 用同一双眼睛。 */
export function liveBaseline(file) {
  const r = readRegularFile(file);
  if (r.status === "read") return { exists: true, sha256: sha256(r.buf), bytes: r.buf };
  if (r.status === "absent") return { exists: false, sha256: null, bytes: null };
  return { unreadable: true, why: r.why };
}
const stateOf = (b) => ({ exists: b.exists, sha256: b.exists ? b.sha256 : null });
const sameState = (a, b) => a.exists === b.exists && a.sha256 === b.sha256;

/**
 * 绑定 active operation（不变量 12）：active → journal valid → 阶段 ∈ expectPhase → 门 active 且 token 一致
 * → **租约属于本 operation**（评审探针：拿别的 operation 的租约也曾走通）→ 两条 current == 期望目标
 *（默认本 token 的桩；commit 之后传 expectCurrent:"version"）。expectToken：调用方已知 token 时显式钉住（enter 与后续步骤之间 operation 被换掉 → 拒）。
 */
export function bindActiveOperation(ctx, { expectPhase, expectCurrent = "stub", version = null, lease = null, expectToken = null, requireLease = false } = {}) {
  const active = readActive({ dir: ctx.dir });
  if (active.state !== "active") return { ok: false, reason: active.state === "absent" ? "no_operation" : "active_unreadable", why: active.why ?? null };
  const token = active.token;
  if (expectToken !== null && token !== expectToken) return { ok: false, reason: "operation_changed", why: "active 指向 " + token.slice(0, 8) + "，不是 " + String(expectToken).slice(0, 8), token };
  // 写步骤必须真的**持有**租约实例（评审返修 2：只比路径的话，伪造 { path } 就能让 stage 在记账前动 staged 目录）：
  // 缺租约受控拒绝（不裸抛）；路径要属于本 operation；再用锁原语的 fencing 段证明"当前调用方就是持有者"。
  if (requireLease && (lease === null || typeof lease?.path !== "string")) return { ok: false, reason: "lease_required", why: "这一步必须持有本 operation 的执行租约", token };
  if (lease !== null) {
    if (typeof lease?.path !== "string" || lease.path !== leasePath(ctx.dir, token)) return { ok: false, reason: "lease_mismatch", why: "租约 " + String(lease?.path) + " 不属于 operation " + token.slice(0, 8), token };
    let held;
    try { held = commitWhileHeld(lease.path, () => "held"); }
    catch (err) { return { ok: false, reason: "lease_not_held", why: "租约核验抛错：" + String(err?.code ?? err?.message ?? err), token }; }
    if (!held.ok || held.run !== "held") return { ok: false, reason: "lease_not_held", why: "调用方并不持有该租约实例（" + String(held.reason ?? "未持有") + "）", token };
  }
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token };
  const phases = Array.isArray(expectPhase) ? expectPhase : [expectPhase];
  if (!phases.includes(j.doc.phase)) return { ok: false, reason: "phase_mismatch", why: "现在是 " + j.doc.phase + "，不是预期的 " + phases.join(" / "), token, phase: j.doc.phase };
  const gate = readGate({ file: ctx.gateFile, now: ctx.now() });
  if (gate.state !== "active" || gate.payload.token !== token) return { ok: false, reason: "gate_not_ours", why: "门 " + gate.state + (gate.state === "active" ? "（token " + String(gate.payload.token).slice(0, 8) + "）" : ""), token };
  const want = expectCurrent === "stub" ? stubRelTarget(token) : path.join("versions", String(version));
  for (const chain of CHAINS) {
    const live = readlinkOrNull(factsOf(ctx, chain).current);
    if (live !== want) return { ok: false, reason: "current_unbound", why: chain + " 的 current 是 " + String(live) + "，不是 " + want, token, chain };
  }
  return { ok: true, token, doc: j.doc };
}

/** journal 里的 plan 锚（staged_plan step，必须已 done）：{ sha256, version }。 */
export function planAnchorOf(doc) {
  const st = doc.steps.find((s) => s.id === "staged_plan");
  return st && st.state === "done" ? { sha256: st.after.sha256, version: st.after.version } : null;
}

// ── staged 私有目录的读写 ────────────────────────────────────────────────────
const planArtifactProblem = (a, i) => {
  if (!isObj(a)) return "制品不是对象";
  if (keysOf(a) !== "base,chain,file,inReceipt,intendedAfterSha,kind,path") return "制品字段集不对";
  if (a.file !== path.join("artifacts", String(i))) return "file 必须是 artifacts/<下标>：" + String(a.file);
  if (!CHAINS.includes(a.chain)) return "chain 不在受控集合里";
  if (typeof a.path !== "string" || !path.isAbsolute(a.path)) return "path 不是绝对路径";
  if (!ARTIFACT_KINDS.includes(a.kind)) return "kind 不在受控集合里";
  if (!isObj(a.base) || keysOf(a.base) !== "exists,sha256" || typeof a.base.exists !== "boolean" || (a.base.exists ? !(typeof a.base.sha256 === "string" && SHA_SHAPE.test(a.base.sha256)) : a.base.sha256 !== null)) return "base 形状不对";
  if (typeof a.intendedAfterSha !== "string" || !SHA_SHAPE.test(a.intendedAfterSha)) return "intendedAfterSha 不是 64 位十六进制";
  if (typeof a.inReceipt !== "boolean") return "inReceipt 不是布尔";
  return null;
};
const planReceiptProblem = (r) => {
  if (!isObj(r) || keysOf(r) !== "artifacts,scripts") return "收据草稿字段集不对";
  if (!Array.isArray(r.artifacts)) return "收据草稿 artifacts 不是数组";
  for (const a of r.artifacts) {
    if (!isObj(a) || keysOf(a) !== "kind,path,sha256") return "收据草稿制品字段集不对";
    if (typeof a.path !== "string" || !path.isAbsolute(a.path)) return "收据草稿制品 path 不是绝对路径";
    if (!ARTIFACT_KINDS.includes(a.kind)) return "收据草稿制品 kind 不在受控集合里";
    if (typeof a.sha256 !== "string" || !SHA_SHAPE.test(a.sha256)) return "收据草稿制品 sha256 不是 64 位十六进制";
  }
  if (!Array.isArray(r.scripts) || r.scripts.some((s) => typeof s !== "string" || !SCRIPT_SHAPE.test(s))) return "收据草稿 scripts 形状不对";
  return null;
};
/** plan.json 的封闭形状（评审探针：../ 的 file、任意 chain / kind / 目标路径都曾被接受）。 */
export function stagedPlanProblem(meta, token) {
  if (!isObj(meta)) return "不是对象";
  if (meta.schema_version !== "1.0") return "schema_version 不认识";
  if (keysOf(meta) !== "artifacts,receipts,schema_version,token,version") return "字段集不对";
  if (meta.token !== token) return "token 与 operation 不一致";
  if (typeof meta.version !== "string" || !VERSION_SHAPE.test(meta.version)) return "version 不是 16 位十六进制";
  if (!Array.isArray(meta.artifacts)) return "artifacts 不是数组";
  for (const [i, a] of meta.artifacts.entries()) { const p = planArtifactProblem(a, i); if (p !== null) return p; }
  if (new Set(meta.artifacts.map((a) => a.path)).size !== meta.artifacts.length) return "制品 path 重复";
  if (!isObj(meta.receipts) || keysOf(meta.receipts) !== "claude,codex") return "receipts 字段集不对";
  for (const chain of CHAINS) { const p = planReceiptProblem(meta.receipts[chain]); if (p !== null) return chain + "：" + p; }
  return null;
}
/**
 * 读 staged plan：**必须传 journal 锚**（expect = planAnchorOf(doc)）—— plan 字节的 sha 与版本都要对上锚，
 * 之后过封闭形状，再核每个制品文件的内容寻址（bytes 的 sha == intendedAfterSha）。plan 本身不是信任根，journal 才是。
 */
export function readStagedPlan(ctx, token, { expect } = {}) {
  if (!expect || typeof expect.sha256 !== "string") return { ok: false, reason: "staged_plan_unanchored", why: "journal 里没有已 done 的 staged_plan 锚" };
  const dir = stagedDirPath(ctx, token);
  const r = readRegularFile(path.join(dir, "plan.json"));
  if (r.status !== "read") return { ok: false, reason: "staged_plan_" + r.status, why: r.why ?? null };
  if (sha256(r.buf) !== expect.sha256) return { ok: false, reason: "staged_plan_mismatch", why: "plan.json 的 sha 与 journal 锚不符" };
  let meta;
  try { meta = JSON.parse(r.buf.toString("utf-8")); } catch (err) { return { ok: false, reason: "staged_plan_unparseable", why: errText(err) }; }
  const problem = stagedPlanProblem(meta, token);
  if (problem !== null) return { ok: false, reason: "staged_plan_shape", why: problem };
  if (meta.version !== expect.version) return { ok: false, reason: "staged_plan_mismatch", why: "plan 版本与 journal 锚不符" };
  const artifacts = [];
  for (const a of meta.artifacts) {
    const f = readRegularFile(path.join(dir, a.file));
    if (f.status !== "read") return { ok: false, reason: "staged_artifact_" + f.status, path: a.path };
    if (sha256(f.buf) !== a.intendedAfterSha) return { ok: false, reason: "staged_artifact_drifted", path: a.path };
    artifacts.push({ ...a, bytes: f.buf });
  }
  return { ok: true, dir, version: meta.version, artifacts, receipts: meta.receipts };
}

/**
 * ① stage：两链落 versions/<v>/ → 目标投影（输入线上基线）→ 写 staged 目录 → plan 锚进 journal → phase staged。不碰线上。
 */
export function stageForInstall(ctx, { sourceRoot, lease }) {
  const bound = bindActiveOperation(ctx, { expectPhase: "drained", lease, requireLease: true });
  if (!bound.ok) return bound;
  const token = bound.token;
  const plans = {};
  for (const chain of CHAINS) {
    const plan = planRuntimeSync({ sourceRoot, root: factsOf(ctx, chain).root });
    if (!plan.ok) return { ok: false, reason: "plan_failed", chain, why: String(plan.reason), token };
    plans[chain] = plan;
  }
  if (plans.claude.version !== plans.codex.version) return { ok: false, reason: "version_mismatch", why: plans.claude.version + " ≠ " + plans.codex.version, token };
  const version = plans.claude.version;
  for (const chain of CHAINS) {
    const root = factsOf(ctx, chain).root;
    const staged = stageRuntimeVersion(plans[chain], { root });
    if (!staged.ok) return { ok: false, reason: "stage_failed", chain, why: String(staged.reason), token };
    const v = verifyRuntimeVersion({ version, root });
    if (!v.ok) return { ok: false, reason: "staged_verify_failed", chain, why: String(v.reason), token };
  }
  const rendered = renderArtifacts({
    home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, runtimeVersion: version, node: ctx.node,
    templates: { claude: path.join(factsOf(ctx, "claude").root, "versions", version), codex: path.join(factsOf(ctx, "codex").root, "versions", version) },
    base: liveBaseline,
  });
  if (!rendered.ok) return { ...rendered, token };
  for (const chain of CHAINS) {
    const badSha = rendered.receipts[chain].artifacts.find((a) => !SHA_SHAPE.test(a.sha256));
    if (badSha) return { ok: false, reason: "artifact_sha_unusable", path: badSha.path, token };
  }
  const dir = stagedDirPath(ctx, token);
  let planBytes;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true, mode: 0o700 });
    rendered.artifacts.forEach((a, i) => writeDurable(path.join(dir, "artifacts", String(i)), a.bytes));
    planBytes = Buffer.from(JSON.stringify({
      schema_version: "1.0", token, version,
      artifacts: rendered.artifacts.map((a, i) => ({ file: path.join("artifacts", String(i)), chain: a.chain, path: a.path, kind: a.kind, base: a.base, intendedAfterSha: a.intendedAfterSha, inReceipt: a.inReceipt })),
      receipts: rendered.receipts,
    }, null, 2) + "\n", "utf-8");
    writeDurable(path.join(dir, "plan.json"), planBytes);
  } catch (err) { return { ok: false, reason: "staged_write_failed", why: errText(err), token }; }
  // plan 锚：plan.json 的 sha + 版本进受租约保护的 journal —— commit / verify 只认锚上的那份 plan
  const anchor = { sha256: sha256(planBytes), version };
  const sp = addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id: "staged_plan", kind: "staged_plan", target: path.join(dir, "plan.json"), before: null, backup: null, intended_after: anchor } });
  if (!sp.ok) return { ok: false, reason: sp.reason, why: sp.why ?? null, path: sp.path ?? null, token };
  const sd = markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id: "staged_plan", after: anchor });
  if (!sd.ok) return { ok: false, reason: sd.reason, why: sd.why ?? null, path: sd.path ?? null, token };
  const p = setPhase({ dir: ctx.dir, token, lease, phase: "staged", expectPhase: "drained", now: ctx.now(), note: "staged " + version + "（" + rendered.artifacts.length + " 个制品）" });
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why ?? null, path: p.path ?? null, token };
  return { ok: true, token, version, artifactCount: rendered.artifacts.length };
}

/** 安装面 allowlist：由投影**重算**的合法制品路径全集（路径不依赖基线字节）。plan 里的目标路径必须都在这里面。 */
export function installSurfacePaths(ctx, version) {
  const claudeTree = path.join(factsOf(ctx, "claude").root, "versions", version);
  const claude = new Set([
    path.join(ctx.home, ".claude", "settings.json"), claudeDrainPlistPath(ctx.home),
    ...claudeSkillFiles({ repoRoot: claudeTree, home: ctx.home }).map((f) => f.path),
  ]);
  const codex = new Set([
    path.join(ctx.codexHome, "hooks.json"), codexPlistPath(ctx.home),
    ...CODEX_SKILLS.flatMap((sk) => sk.files.map((f) => path.join(ctx.codexHome, "skills", sk.name, f))),
  ]);
  return { claude, codex };
}

/** ② verify staged 的检查本体（commit 前还要再跑一遍，所以单独抽出）。只读。 */
export function stagedChecks(ctx, token, staged) {
  const bad = [];
  for (const chain of CHAINS) {
    const v = verifyRuntimeVersion({ version: staged.version, root: factsOf(ctx, chain).root });
    if (!v.ok) bad.push(chain + ":versions/" + staged.version + "（" + String(v.reason) + "）");
  }
  const allow = installSurfacePaths(ctx, staged.version);
  for (const a of staged.artifacts) if (!allow[a.chain]?.has(a.path)) bad.push("制品路径不在安装面 allowlist：" + a.chain + " " + a.path);
  const claudeTree = path.join(factsOf(ctx, "claude").root, "versions", staged.version);
  const manifest = maintenanceEntryManifest({ repoRoot: claudeTree, home: ctx.home, codexHome: ctx.codexHome, bridgeHome: ctx.codexBridgeHome });
  if (manifest.missing.length > 0) bad.push("桩清单项在 versions/" + staged.version + " 里缺失：" + manifest.missing.join("、"));
  const refsByChain = { claude: new Set(), codex: new Set() };
  for (const a of staged.artifacts) for (const n of referencedRuntimeScripts(a.bytes.toString("utf-8"))) refsByChain[a.chain].add(n);
  for (const chain of CHAINS) for (const n of staged.receipts[chain].scripts) refsByChain[chain].add(n);
  for (const chain of CHAINS) {
    const tree = path.join(factsOf(ctx, chain).root, "versions", staged.version);
    for (const n of [...refsByChain[chain]].sort()) {
      if (!manifest.entries.includes(n)) { bad.push(chain + " 引用的 " + n + " 不在桩清单里"); continue; }
      let isFile = false;
      try { isFile = fs.statSync(path.join(tree, "scripts", ...n.split("/"))).isFile(); } catch { isFile = false; }
      if (!isFile) bad.push(chain + " 引用的 " + n + " 不在 versions/" + staged.version + "/scripts/ 下");
    }
  }
  return bad.length === 0 ? { ok: true } : { ok: false, reason: "staged_refs_unverified", items: bad };
}
export function verifyStagedForInstall(ctx, { lease = null } = {}) {
  const bound = bindActiveOperation(ctx, { expectPhase: "staged", lease });
  if (!bound.ok) return bound;
  const anchor = planAnchorOf(bound.doc);
  const staged = readStagedPlan(ctx, bound.token, { expect: anchor });
  if (!staged.ok) return { ...staged, token: bound.token };
  const checked = stagedChecks(ctx, bound.token, staged);
  return checked.ok ? { ok: true, token: bound.token, version: staged.version } : { ...checked, token: bound.token };
}

/**
 * ③ commit（门仍在）：current（桩 → versions/<v>，CAS 在安装锁内）→ 制品（写前 CAS）→ 收据（单快照 + 事务锁内 CAS）→ phase committed。
 * 任一失败即返回（已写项留给 rollbackOperation 按账回退）。
 */
export function commitForInstall(ctx, { lease }) {
  const bound = bindActiveOperation(ctx, { expectPhase: "staged", lease, requireLease: true });
  if (!bound.ok) return bound;
  const token = bound.token;
  const staged = readStagedPlan(ctx, token, { expect: planAnchorOf(bound.doc) });
  if (!staged.ok) return { ...staged, token };
  const checked = stagedChecks(ctx, token, staged);
  if (!checked.ok) return { ...checked, token };
  const J = (r) => (r.ok ? r : Object.assign(new Error("journal"), { journalFail: { ok: false, reason: r.reason, why: r.why ?? null, path: r.path ?? null, token } }));
  const run = (r) => { if (r instanceof Error) throw r; return r; };
  try {
    // ── 两条 current：桩 → versions/<v>。expectBefore 的 CAS 在 activateRuntimeVersion 的安装锁内（与 rename 同一把锁，没有检查与切换之间的窗口）
    for (const chain of CHAINS) {
      const facts = factsOf(ctx, chain);
      const id = "current:" + chain + ":install";
      run(J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id, kind: "current", target: facts.current, before: stubRelTarget(token), backup: null, intended_after: path.join("versions", staged.version) } })));
      const act = activateRuntimeVersion({ version: staged.version, root: facts.root, expectBefore: stubRelTarget(token) });
      if (!act.ok) return { ok: false, reason: act.reason === "current_changed" ? "current_changed" : "activate_failed", chain, why: String(act.reason === "current_changed" ? act.live : act.reason), token };
      run(J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id, after: path.join("versions", staged.version) })));
      afterStep(ctx, id);
    }
    // ── 制品：写前 CAS（base_changed 点名整次中止）→ prepared（备份原字节进 staged/backups/）→ 原子写 → done
    for (const [i, a] of staged.artifacts.entries()) {
      const id = "artifact:" + a.path;
      const live = liveBaseline(a.path);
      if (live.unreadable) return { ok: false, reason: "artifact_unreadable", path: a.path, why: live.why, token };
      if (!sameState(stateOf(live), a.base)) return { ok: false, reason: "base_changed", path: a.path, why: "stage 时 " + JSON.stringify(a.base) + "，现在 " + JSON.stringify(stateOf(live)), token };
      let backup = null, meta = { sha256: null, bytes: null };
      if (live.exists) { backup = path.join(staged.dir, "backups", String(i)); meta = writeBackup(backup, live.bytes); }
      run(J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id, kind: "artifact", target: a.path, before: { exists: a.base.exists, sha256: a.base.sha256 }, backup, backup_sha256: meta.sha256, backup_bytes: meta.bytes, intended_after: { exists: true, sha256: a.intendedAfterSha } } })));
      try { fs.mkdirSync(path.dirname(a.path), { recursive: true }); writeDurable(a.path, a.bytes); }
      catch (err) { return { ok: false, reason: "artifact_write_failed", path: a.path, why: errText(err), token }; }
      afterStep(ctx, "written:" + id);
      run(J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id, after: { exists: true, sha256: a.intendedAfterSha } })));
      afterStep(ctx, id);
    }
    // ── 两份收据：**一次 fd 读产生同一份快照**（合并基 = CAS 基 = 备份来源；评审探针：两次读取之间另一写方提交会被静默丢掉），
    // 确定性合并出 intended 字节（与 recordInstalledSurface 同一合并语义：版本变了整链换），事务锁内重读 CAS 后写；锁残骸一律算失败
    for (const chain of CHAINS) {
      const facts = factsOf(ctx, chain);
      const file = facts.receiptFile;
      const id = "receipt:" + chain;
      const live = liveBaseline(file);
      if (live.unreadable) return { ok: false, reason: "surface_unreadable", chain, why: live.why, token };
      let doc0 = { schema_version: INSTALLED_SURFACE_SCHEMA, chains: {} };
      if (live.exists) {
        try { doc0 = JSON.parse(live.bytes.toString("utf-8")); } catch (err) { return { ok: false, reason: "surface_unreadable", chain, why: "不是 JSON：" + errText(err), token }; }
        const p0 = installedSurfaceProblem(doc0);
        if (p0 !== null) return { ok: false, reason: "surface_unreadable", chain, why: "形状不对：" + p0, token };
      }
      const before = stateOf(live);
      const draft = staged.receipts[chain];
      const entry = {
        version: staged.version, at: new Date(ctx.now()).toISOString(),
        artifacts: [...draft.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
        scripts: [...new Set(draft.scripts)].sort(),
      };
      const next = { schema_version: INSTALLED_SURFACE_SCHEMA, chains: { ...doc0.chains, [chain]: entry } };
      const problem = installedSurfaceProblem(next);
      if (problem !== null) return { ok: false, reason: "entry_shape", chain, why: problem, token };
      const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf-8");
      let backup = null, meta = { sha256: null, bytes: null };
      if (live.exists) { backup = path.join(staged.dir, "backups", "receipt-" + chain); meta = writeBackup(backup, live.bytes); }
      run(J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id, kind: "receipt", target: file, before, backup, backup_sha256: meta.sha256, backup_bytes: meta.bytes, intended_after: { exists: true, sha256: sha256(bytes) } } })));
      try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch (err) { return { ok: false, reason: "receipt_write_failed", chain, why: errText(err), token }; }
      const locked = withInstalledSurfaceLock(file, ({ commit }) => {
        const again = liveBaseline(file);
        if (again.unreadable || !sameState(stateOf(again), before)) return { why: "锁内重读与 prepared 时不一致，不写" };
        const c = commit(() => { try { writeDurable(file, bytes); return null; } catch (err) { return errText(err); } });
        if (!c.ok) return { why: "锁归属核对失败：" + String(c.reason) };
        return { why: c.run, reap: c.reapUncleared ?? null };
      });
      let failWhy = null, failPath = null;
      if (!locked.ok) { failWhy = "收据锁拿不到：" + String(locked.reason) + (locked.why ? "（" + locked.why + "）" : ""); failPath = locked.path ?? null; }
      else if (locked.run.reap) { failWhy = "收据锁归属转换锁交不还：" + String(locked.run.reap.error ?? ""); failPath = locked.run.reap.path; }
      else if (locked.lockUncleared) { failWhy = "收据锁交不还：" + String(locked.lockUncleared.reason) + (locked.lockUncleared.error ? "：" + locked.lockUncleared.error : ""); failPath = locked.lockUncleared.path; }
      else failWhy = locked.run.why;
      if (failWhy !== null) return { ok: false, reason: "receipt_write_failed", chain, why: failWhy, path: failPath, token };
      afterStep(ctx, "written:" + id);
      run(J(markStepDone({ dir: ctx.dir, token, lease, now: ctx.now(), id, after: { exists: true, sha256: sha256(bytes) } })));
      afterStep(ctx, id);
    }
    run(J(setPhase({ dir: ctx.dir, token, lease, phase: "committed", expectPhase: "staged", now: ctx.now() })));
  } catch (err) {
    if (err?.journalFail) return err.journalFail;
    throw err;
  }
  return { ok: true, token, version: staged.version };
}

/** plist XML 里的 ProgramArguments（与假 launchd 的解析同形；XML 转义还原）。 */
function plistProgramArguments(text) {
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(text);
  if (!arr) return null;
  return [...arr[1].matchAll(/<string>([^<]*)<\/string>/gu)].map((m) => m[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
}

/**
 * ④ verify live：verifyRuntime 两链 == v；线上制品 sha == after；plist ProgramArguments == 期望 job；
 * Codex 阻断探针（无模型）：门还开着，起新 runtime 的 prompt-hook（Aily 环境），必须顶层 decision:block。→ phase verified。
 */
export function verifyLiveForInstall(ctx, { lease, spawn = spawnSync }) {
  const active = readActive({ dir: ctx.dir });
  if (active.state !== "active") return { ok: false, reason: "no_operation" };
  const j = readJournal({ dir: ctx.dir, token: active.token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token: active.token };
  const stagedPlan = readStagedPlan(ctx, active.token, { expect: planAnchorOf(j.doc) });
  if (!stagedPlan.ok) return { ...stagedPlan, token: active.token };
  const bound = bindActiveOperation(ctx, { expectPhase: "committed", expectCurrent: "version", version: stagedPlan.version, lease, expectToken: active.token, requireLease: true });
  if (!bound.ok) return bound;
  const token = bound.token;
  const bad = [];
  for (const chain of CHAINS) {
    const v = verifyRuntime({ root: factsOf(ctx, chain).root });
    if (!v.ok || v.version !== stagedPlan.version) bad.push(chain + ":runtime（" + String(v.reason ?? v.version) + "）");
  }
  for (const a of stagedPlan.artifacts) {
    const live = liveBaseline(a.path);
    if (!live.exists || live.sha256 !== a.intendedAfterSha) bad.push("制品 " + a.path + "（" + (live.unreadable ? live.why : live.exists ? "sha 不符" : "缺席") + "）");
  }
  const jobOf = { [claudeDrainPlistPath(ctx.home)]: claudeDrainExpectedJob({ home: ctx.home, node: ctx.node }).args, [codexPlistPath(ctx.home)]: codexExpectedJob({ home: ctx.home, codexHome: ctx.codexHome }).args };
  for (const a of stagedPlan.artifacts.filter((x) => x.kind === "plist")) {
    const args = plistProgramArguments(a.bytes.toString("utf-8"));
    const want = jobOf[a.path];
    if (!want || !args || args.length !== want.length || args.some((x, i) => x !== want[i])) bad.push("plist " + a.path + " 的 ProgramArguments 与期望 job 不一致");
  }
  // Codex 阻断探针（无模型）：hook 在门前退出，不会碰模型或任何桥状态
  const codexFacts = factsOf(ctx, "codex");
  const uid = chainAgentUid(codexFacts) ?? "maintenance-probe";
  const probe = spawn(ctx.node, [path.join(codexFacts.root, "current", "scripts", "codex", "prompt-hook.mjs")], {
    encoding: "utf-8", input: "{}", timeout: 20000,
    env: { HOME: ctx.home, PATH: process.env.PATH ?? "", CODEX_HOME: ctx.codexHome, FEISHU_CODEX_BRIDGE_HOME: ctx.codexBridgeHome, FEISHU_BRIDGE_MAINTENANCE_GATE: ctx.gateFile, AILY_CLI_CALLER_AGENT_UID: uid },
  });
  let decision = null;
  try { decision = JSON.parse(String(probe.stdout ?? "")); } catch { decision = null; }
  if (probe.status !== 0 || decision?.decision !== "block") bad.push("Codex 阻断探针不过（exit " + String(probe.status) + "，stdout " + String(probe.stdout ?? "").slice(0, 80) + "）");
  if (bad.length > 0) return { ok: false, reason: "verify_live_failed", items: bad, token };
  const p = setPhase({ dir: ctx.dir, token, lease, phase: "verified", expectPhase: "committed", now: ctx.now() });
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why ?? null, path: p.path ?? null, token };
  return { ok: true, token, version: stagedPlan.version };
}

/**
 * ⑤ reopening（不可逆的成功路径）：phase reopening → operation.mjs 的 reopening(mode:"success")
 * （删门前精确复核 → 定时器到目标状态 → 删桩 / staged → token-CAS 删门 → 持久化 done → 最后清 active）。
 */
export function finishInstallReopening(ctx, { lease }) {
  const active = readActive({ dir: ctx.dir });
  if (active.state !== "active") return { ok: false, reason: "no_operation" };
  const j = readJournal({ dir: ctx.dir, token: active.token });
  if (j.state !== "valid") return { ok: false, reason: "journal_" + j.state, why: j.why ?? null, token: active.token };
  const stagedPlan = readStagedPlan(ctx, active.token, { expect: planAnchorOf(j.doc) });
  if (!stagedPlan.ok) return { ...stagedPlan, token: active.token };
  const bound = bindActiveOperation(ctx, { expectPhase: "verified", expectCurrent: "version", version: stagedPlan.version, lease, expectToken: active.token, requireLease: true });
  if (!bound.ok) return bound;
  const p = setPhase({ dir: ctx.dir, token: bound.token, lease, phase: "reopening", expectPhase: "verified", now: ctx.now() });
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why ?? null, path: p.path ?? null, token: bound.token };
  return { token: bound.token, version: stagedPlan.version, ...reopening(ctx, bound.token, lease, { mode: "success" }) };
}
