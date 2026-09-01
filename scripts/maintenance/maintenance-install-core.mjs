/**
 * 维护安装核心（issue #81 PR C 第 2 步，方案稿 §89–103）—— **不公开 stage / commit CLI**，只是模块 API，
 * 每一步都绑定 active operation：token、journal 阶段前驱、门 active 且 token 一致、两条 `current` 此刻仍是本 token 的桩
 * （commit 之后绑定放宽为"指向目标版本"），否则拒。命令面只有 scripts/maintenance-install.mjs（enter → 1–5）。
 *
 *   1. stage        两链 stageRuntimeVersion（只落 versions/<v>/，不切 current）→ renderArtifacts（输入线上基线字节）
 *                   → 写 maintenance/<token>.staged/（目标制品字节 + plan.json + 之后 commit 的备份）→ phase staged。不碰任何线上配置。
 *   2. verifyStaged verifyRuntimeVersion 两链；staged 制品引用的脚本 ⊆ 桩清单 ∪ 存在于本链 versions/<v>/scripts/。只读。
 *   3. commit       门仍在：两条 current（桩 → versions/<v>，activateRuntimeVersion 先验后切）→ 每个制品写前 CAS
 *                   （现场 {exists,sha} == stage 时的 base，否则 base_changed 整次中止）→ prepared（备份原字节）→ 原子写 → done
 *                   → 两份机器级收据按同样两阶段 + 收据事务锁写入（确定性合并出 intended 字节，锁内 CAS）→ phase committed。
 *   4. verifyLive   verifyRuntime 两链 == v；线上制品 sha == after；plist 的 ProgramArguments == 期望 job；
 *                   Codex 阻断探针（无模型）：起新 runtime 的 prompt-hook（门还开着），顶层 decision:block。→ phase verified。
 *   5. reopening    phase reopening → operation.mjs 的成功路径（定时器到目标状态 → 删桩 → 删 staged → token-CAS 删门 → done → 清 active）。
 *
 * 失败处置在调用方（CLI）：1–4 任一步失败 → rollbackOperation 按 journal 回退到进门前（versions/<v>/ 保留）；
 * lease_reap_uncleared → 立即停，不再动任何东西。测试注入点沿用 maintenanceContext（afterStep 在每个 step done 之后、
 * "written:<id>" 在制品写盘与记 done 之间触发）。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readGate } from "../maintenance-gate-core.mjs";
import { INSTALLED_SURFACE_SCHEMA, installedSurfaceProblem, readInstalledSurface, readRegularFile, withInstalledSurfaceLock } from "../installed-surface.mjs";
import { activateRuntimeVersion, planRuntimeSync, stageRuntimeVersion, verifyRuntime, verifyRuntimeVersion } from "../runtime-install.mjs";
import { claudeDrainPlistPath, referencedRuntimeScripts } from "../install-projection.mjs";
import { claudeDrainExpectedJob } from "../drain-schedule.mjs";
import { expectedJob as codexExpectedJob, plistPath as codexPlistPath } from "../codex/drain-service.mjs";
import { addStepPrepared, markStepDone, readActive, readJournal, setPhase, writeBackup, writeDurable } from "./journal.mjs";
import { stubRelTarget } from "./stub.mjs";
import { chainAgentUid, chainFacts } from "./precheck.mjs";
import { maintenanceEntryManifest } from "./maintenance-entries.mjs";
import { renderArtifacts } from "./render-artifacts.mjs";
import { reopening, stagedDirPath } from "./operation.mjs";

const CHAINS = ["claude", "codex"];
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const errText = (err) => String(err?.code ?? err?.message ?? err);
const readlinkOrNull = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
const factsOf = (ctx, chain) => chainFacts({ chain, home: ctx.home, codexHome: ctx.codexHome, codexBridgeHome: ctx.codexBridgeHome, node: ctx.node });
const afterStep = (ctx, id) => { if (typeof ctx.afterStep === "function") ctx.afterStep(id); };

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
 * → 两条 current == 期望目标（默认本 token 的桩；commit 之后传 expectCurrent:"version"）。
 */
export function bindActiveOperation(ctx, { expectPhase, expectCurrent = "stub", version = null } = {}) {
  const active = readActive({ dir: ctx.dir });
  if (active.state !== "active") return { ok: false, reason: active.state === "absent" ? "no_operation" : "active_unreadable", why: active.why ?? null };
  const token = active.token;
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

// ── staged 私有目录的读写 ────────────────────────────────────────────────────
/** 读 staged plan 并核每个制品文件的内容寻址（bytes 的 sha 必须 == intendedAfterSha）。 */
export function readStagedPlan(ctx, token) {
  const dir = stagedDirPath(ctx, token);
  const r = readRegularFile(path.join(dir, "plan.json"));
  if (r.status !== "read") return { ok: false, reason: "staged_plan_" + r.status, why: r.why ?? null };
  let meta;
  try { meta = JSON.parse(r.buf.toString("utf-8")); } catch (err) { return { ok: false, reason: "staged_plan_unparseable", why: errText(err) }; }
  if (meta?.schema_version !== "1.0" || meta.token !== token || typeof meta.version !== "string" || !Array.isArray(meta.artifacts) || !meta.receipts) return { ok: false, reason: "staged_plan_shape" };
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
 * ① stage：两链落 versions/<v>/ → 目标投影（输入线上基线）→ 写 staged 目录 → phase staged。不碰线上。
 */
export function stageForInstall(ctx, { sourceRoot, lease }) {
  const bound = bindActiveOperation(ctx, { expectPhase: "drained" });
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
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true, mode: 0o700 });
    rendered.artifacts.forEach((a, i) => writeDurable(path.join(dir, "artifacts", String(i)), a.bytes));
    writeDurable(path.join(dir, "plan.json"), JSON.stringify({
      schema_version: "1.0", token, version,
      artifacts: rendered.artifacts.map((a, i) => ({ file: path.join("artifacts", String(i)), chain: a.chain, path: a.path, kind: a.kind, base: a.base, intendedAfterSha: a.intendedAfterSha, inReceipt: a.inReceipt })),
      receipts: rendered.receipts,
    }, null, 2) + "\n");
  } catch (err) { return { ok: false, reason: "staged_write_failed", why: errText(err), token }; }
  const p = setPhase({ dir: ctx.dir, token, lease, phase: "staged", expectPhase: "drained", now: ctx.now(), note: "staged " + version + "（" + rendered.artifacts.length + " 个制品）" });
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why ?? null, path: p.path ?? null, token };
  return { ok: true, token, version, artifactCount: rendered.artifacts.length };
}

/** ② verify staged 的检查本体（commit 前还要再跑一遍，所以单独抽出）。只读。 */
export function stagedChecks(ctx, token, staged) {
  const bad = [];
  for (const chain of CHAINS) {
    const v = verifyRuntimeVersion({ version: staged.version, root: factsOf(ctx, chain).root });
    if (!v.ok) bad.push(chain + ":versions/" + staged.version + "（" + String(v.reason) + "）");
  }
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
export function verifyStagedForInstall(ctx) {
  const bound = bindActiveOperation(ctx, { expectPhase: "staged" });
  if (!bound.ok) return bound;
  const staged = readStagedPlan(ctx, bound.token);
  if (!staged.ok) return { ...staged, token: bound.token };
  const checked = stagedChecks(ctx, bound.token, staged);
  return checked.ok ? { ok: true, token: bound.token, version: staged.version } : { ...checked, token: bound.token };
}

/**
 * ③ commit（门仍在）：current（桩 → versions/<v>）→ 制品（写前 CAS）→ 收据（事务锁内 CAS）→ phase committed。
 * 任一失败即返回（已写项留给 rollbackOperation 按账回退）。
 */
export function commitForInstall(ctx, { lease }) {
  const bound = bindActiveOperation(ctx, { expectPhase: "staged" });
  if (!bound.ok) return bound;
  const token = bound.token;
  const staged = readStagedPlan(ctx, token);
  if (!staged.ok) return { ...staged, token };
  const checked = stagedChecks(ctx, token, staged);
  if (!checked.ok) return { ...checked, token };
  const J = (r) => (r.ok ? r : Object.assign(new Error("journal"), { journalFail: { ok: false, reason: r.reason, why: r.why ?? null, path: r.path ?? null, token } }));
  const run = (r) => { if (r instanceof Error) throw r; return r; };
  try {
    // ── 两条 current：桩 → versions/<v>（activateRuntimeVersion 先验目录再切；门还开着，新 runtime 的每个写入口都看门）
    for (const chain of CHAINS) {
      const facts = factsOf(ctx, chain);
      const id = "current:" + chain + ":install";
      run(J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id, kind: "current", target: facts.current, before: stubRelTarget(token), backup: null, intended_after: path.join("versions", staged.version) } })));
      const live = readlinkOrNull(facts.current);
      if (live !== stubRelTarget(token)) return { ok: false, reason: "current_changed", chain, why: String(live), token };
      const act = activateRuntimeVersion({ version: staged.version, root: facts.root });
      if (!act.ok) return { ok: false, reason: "activate_failed", chain, why: String(act.reason), token };
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
    // ── 两份收据：确定性合并出 intended 字节（同 recordInstalledSurface 的合并语义：版本变了整链换），锁内 CAS 写
    for (const chain of CHAINS) {
      const facts = factsOf(ctx, chain);
      const file = facts.receiptFile;
      const id = "receipt:" + chain;
      const cur = readInstalledSurface({ file });
      if (cur.state === "unreadable") return { ok: false, reason: "surface_unreadable", chain, why: cur.why, token };
      const doc = cur.state === "valid" ? cur.doc : { schema_version: INSTALLED_SURFACE_SCHEMA, chains: {} };
      const draft = staged.receipts[chain];
      const entry = {
        version: staged.version, at: new Date(ctx.now()).toISOString(),
        artifacts: [...draft.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
        scripts: [...new Set(draft.scripts)].sort(),
      };
      const next = { schema_version: INSTALLED_SURFACE_SCHEMA, chains: { ...doc.chains, [chain]: entry } };
      const problem = installedSurfaceProblem(next);
      if (problem !== null) return { ok: false, reason: "entry_shape", chain, why: problem, token };
      const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf-8");
      const live = liveBaseline(file);
      if (live.unreadable) return { ok: false, reason: "surface_unreadable", chain, why: live.why, token };
      const before = stateOf(live);
      let backup = null, meta = { sha256: null, bytes: null };
      if (live.exists) { backup = path.join(staged.dir, "backups", "receipt-" + chain); meta = writeBackup(backup, live.bytes); }
      run(J(addStepPrepared({ dir: ctx.dir, token, lease, now: ctx.now(), step: { id, kind: "receipt", target: file, before, backup, backup_sha256: meta.sha256, backup_bytes: meta.bytes, intended_after: { exists: true, sha256: sha256(bytes) } } })));
      try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch (err) { return { ok: false, reason: "receipt_write_failed", chain, why: errText(err), token }; }
      const locked = withInstalledSurfaceLock(file, ({ commit }) => {
        const again = liveBaseline(file);
        if (again.unreadable || !sameState(stateOf(again), before)) return "锁内重读与 prepared 时不一致，不写";
        const c = commit(() => { try { writeDurable(file, bytes); return null; } catch (err) { return errText(err); } });
        if (!c.ok) return "锁归属核对失败：" + String(c.reason);
        return c.run;
      });
      const failWhy = !locked.ok ? "收据锁拿不到：" + String(locked.reason) + (locked.why ? "（" + locked.why + "）" : "") : locked.run;
      if (failWhy !== null) return { ok: false, reason: "receipt_write_failed", chain, why: failWhy, token, ...(locked.lockUncleared ? { lockUncleared: locked.lockUncleared } : {}) };
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
  const staged0 = readActive({ dir: ctx.dir });
  if (staged0.state !== "active") return { ok: false, reason: "no_operation" };
  const stagedPlan = readStagedPlan(ctx, staged0.token);
  if (!stagedPlan.ok) return { ...stagedPlan, token: staged0.token };
  const bound = bindActiveOperation(ctx, { expectPhase: "committed", expectCurrent: "version", version: stagedPlan.version });
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
 * （定时器到目标状态 → 删桩 → 删 staged → token-CAS 删门 → 持久化 done → 最后清 active）。
 */
export function finishInstallReopening(ctx, { lease }) {
  const active = readActive({ dir: ctx.dir });
  if (active.state !== "active") return { ok: false, reason: "no_operation" };
  const stagedPlan = readStagedPlan(ctx, active.token);
  if (!stagedPlan.ok) return { ...stagedPlan, token: active.token };
  const bound = bindActiveOperation(ctx, { expectPhase: "verified", expectCurrent: "version", version: stagedPlan.version });
  if (!bound.ok) return bound;
  const p = setPhase({ dir: ctx.dir, token: bound.token, lease, phase: "reopening", expectPhase: "verified", now: ctx.now() });
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why ?? null, path: p.path ?? null, token: bound.token };
  return { token: bound.token, version: stagedPlan.version, ...reopening(ctx, bound.token, lease, { mode: "success" }) };
}
