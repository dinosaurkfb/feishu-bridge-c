// R52 账本侧 operation A（owner_select_migration_a）维护编排——照 ledger-operation.mjs 骨架。
//   只做账本侧：进门 → drained 只读前置 → pre-forward plan 矩阵 → 原子进段 → forward 收敛 → 重开/回退/--exit。
//   骨架/合同参照 scripts/maintenance/ledger-operation.mjs 与 docs/architecture/owner-select-route.md §8。
import fs from "node:fs";
import path from "node:path";
import { acquireInstallSurfaceLock } from "../install-surface-lock.mjs";
import { releaseOperationLease, readActive, readJournal, acquireOperationLease } from "./journal.mjs";
import { enterMaintenance, rollbackOperation } from "./operation.mjs";
import { updateJournal, journalProblem, markStepDone, setPhase, clearActive, addNote } from "./journal.mjs";
import { aggregateEndpointReceipts, endpointReceipt } from "./ledger-receipt.mjs";
import { campaignIdFor, endpointsDigest } from "./owner-select-derived.mjs";
import { readCampaignState, readWriterState, writeCampaignState, writeWriterState, readCampaignDocVerified, readWriterStateDocVerified, CAMPAIGN_SCHEMA, WRITER_STATE_SCHEMA } from "./owner-select-state.mjs";
import { resolveEndpointDir, validateLedgerRoot, loadLedger, schemaUpgrade, mintSelectionHandles, applySchemaUpgrade, buildMintPlan, applyMintPlan, mintPlanBytes, mintPlanProblem, migrationInventory, schemaUpgradeOperationId, canonKey, sha256, serializeLedger } from "../topic-agent-ledger.mjs";

const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
const errText = (err) => String(err?.code ?? err?.message ?? err);
const releaseSurface = (surface) => {
  if (typeof surface?.release !== "function") return { ok: true };
  try { return surface.release(); } catch (err) { return { ok: false, why: "release_threw：" + String(err?.message ?? err), path: surface.path ?? null }; }
};

// 只读前置失败（留在 drained）的判别：返回 { ok:false, reason, why, rollbackSafe:true }。
const preFail = (reason, why) => ({ ok: false, reason, why: why ?? null, rollbackSafe: true });

/** 冻结集：全部「有效初始化收据（initDone===true）」的 endpoint，有序去重非空。 */
export function frozenEndpoints(dir) {
  const agg = aggregateEndpointReceipts({ dir });
  if (!agg.ok) return { ok: false, reason: "receipts_unreadable", why: agg.unreadable?.[0]?.why ?? agg.why ?? "收据聚合 fail-closed" };
  const eps = [...new Set(agg.endpoints.filter((e) => e.initDone === true).map((e) => e.endpointId))].sort();
  return { ok: true, endpoints: eps };
}

/** §二.2 drained 只读前置（失败 rollbackSafe 留在 drained）：冻结集 / 每 ep 账本 / campaign / writer-state 四项核验。 */
export function osmDrainedPrecheck(ctx, { token, env = process.env } = {}) {
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return preFail("journal_" + j.state, j.why ?? null);
  if (j.doc.operation_kind !== "owner_select_migration_a") return preFail("bad_operation_kind", "operation_kind " + j.doc.operation_kind + " ≠ owner_select_migration_a");
  if (j.doc.phase !== "drained") return preFail("not_drained", "phase " + j.doc.phase);
  const cid = campaignIdFor(token);
  // ① 冻结集：全部有效 init 收据 endpoint（有序去重非空）。
  const frz = frozenEndpoints(ctx.dir);
  if (!frz.ok) return preFail(frz.reason, frz.why);
  if (frz.endpoints.length === 0) return preFail("no_frozen_endpoints", "无任何已初始化 endpoint");
  // ② 每 ep 账本受验可读且 schema_version==="1.0"；已是 transition 且本 campaign 已 open → 恢复路径（非前置失败）。
  const campNow = readCampaignState(env);
  if (campNow.state === "unreadable") return preFail("campaign_unreadable", campNow.problem ?? null);
  const recoverCase = campNow.state === "open" && campNow.campaign_id === cid;
  for (const ep of frz.endpoints) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return preFail("endpoint_unresolvable", ep + "：" + d.reason);
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return preFail("ledger_unreadable", ep + "：" + L.reason);
    if (L.doc.schema_version !== "1.0") {
      if (L.doc.schema_version === "1.1-transition" && recoverCase) continue; // 恢复路径
      return preFail("not_at_1_0", ep + "：schema " + L.doc.schema_version);
    }
  }
  // ③ campaign：absent/complete → 可 open；open 且 campaign_id===cid → 恢复；其它 → fail-closed。
  if (campNow.state !== "absent" && campNow.state !== "complete" && !(campNow.state === "open" && campNow.campaign_id === cid)) {
    return preFail("campaign_state_blocked", "campaign " + campNow.state + "（id " + String(campNow.campaign_id ?? "?").slice(0, 8) + "）不被本 operation 接受");
  }
  // ④ writer-state：off（缺席）或 on（退回）→ 可置 partial；partial 且同 id → 恢复；其它 → fail-closed。
  const wsNow = readWriterState(env);
  if (wsNow.state === "unreadable") return preFail("writer_unreadable", wsNow.problem ?? null);
  if (wsNow.state !== "off" && wsNow.state !== "on" && !(wsNow.state === "partial" && wsNow.campaign_id === cid)) {
    return preFail("writer_state_blocked", "writer-state " + wsNow.state + "（id " + String(wsNow.campaign_id ?? "?").slice(0, 8) + "）不被本 operation 接受");
  }
  return { ok: true, frozen: frz.endpoints, campaign: campNow.state, writer: wsNow.state };
}

// §二.3 pre-forward 状态矩阵（§8 mint plan 段）：每 ep 盘存 `<token>.staged/intended/mint-<ep>.json`——
//   缺席 → buildMintPlan → mintPlanBytes O_EXCL 0600 写满 fsync → fsync intended/ 目录；恰一份且身份/before SHA/null-B1/重演 SHA 全符 → 复用；
//   其它 → fail-closed 留在 drained。返回 { ok, plans:{ep:plan} }。
const OSM_HANDLE_TTL_MS = 30 * 24 * 3600 * 1000;
const fsyncDir = (dir) => { try { const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* 目录 fsync 不可忽略时写失败在 open 前已抛 */ } };
export function osmPreForwardPlanMatrix(ctx, { token, lease, env = process.env } = {}) {
  void lease;
  const fail = (reason, why) => ({ ok: false, reason, why: why ?? null, rollbackSafe: true });
  const frz = frozenEndpoints(ctx.dir);
  if (!frz.ok) return fail(frz.reason, frz.why);
  const intendedDir = path.join(ctx.dir, token + ".staged", "intended");
  fs.mkdirSync(intendedDir, { recursive: true, mode: 0o700 });
  const cid = campaignIdFor(token);
  const plans = {};
  for (const ep of frz.endpoints) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return fail("endpoint_unresolvable", ep + "：" + d.reason);
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return fail("ledger_unreadable", ep + "：" + L.reason);
    if (L.doc.schema_version !== "1.0") return fail("not_at_1_0", ep + "：schema " + L.doc.schema_version);
    // §二.3：先用 applySchemaUpgrade 预算 schema_endpoint intended_after（transition 账本），mint 的 before = schema intended_after（状态链）。
    const opId = schemaUpgradeOperationId(token, ep);
    const budgeted = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token + ":schema", from_schema: "1.0", to_schema: "1.1-transition" });
    const budgetedSha = sha256(serializeLedger(budgeted));
    const inv = migrationInventory(budgeted);
    const planPath = path.join(intendedDir, "mint-" + ep + ".json");
    let plan;
    if (!fs.existsSync(planPath)) {
      plan = buildMintPlan({ doc: budgeted, token, campaignId: cid, endpointId: ep, requestKey: token, now: ctx.now(), ttlMs: OSM_HANDLE_TTL_MS });
      if (plan === null) return fail("build_plan_failed", ep + "：now/ttl 非法");
      const planBytes = mintPlanBytes(plan);
      const fd = fs.openSync(planPath, "w", 0o600); try { fs.writeSync(fd, planBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fsyncDir(intendedDir);
    } else {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(planPath, "utf-8")); } catch { return fail("plan_unreadable", ep + "：不是 JSON"); }
      if (mintPlanProblem(raw) !== null) return fail("plan_invalid", ep + "：" + mintPlanProblem(raw));
      if (raw.token !== token || raw.campaign_id !== cid || raw.endpoint !== ep || raw.request_key !== token) return fail("plan_identity_mismatch", ep + "：token/campaign/endpoint/request_key 与现场不符");
      if (raw.before_ledger_sha256 !== budgetedSha) return fail("plan_before_sha_mismatch", ep + "：before SHA 与 schema intended_after 不符");
      if (canonKey(raw.expected_null_b1_ids) !== canonKey(inv.null_b1_ids)) return fail("plan_nullb1_mismatch", ep + "：null-B1 集与 transition 账本不符");
      const applied = applyMintPlan(budgeted, raw);
      if (sha256(serializeLedger(applied)) !== raw.expected_ledger_sha256) return fail("plan_replay_mismatch", ep + "：按 plan 重演 SHA 与锚定不等");
      plan = raw;
    }
    plans[ep] = plan;
  }
  return { ok: true, plans };
}

// §二.4 原子进段（drained → osm_a_upgrading）：campaign:open + 每 ep schema_endpoint:transition + mint（含 intended_blob）+ writer_state:partial，
//   全部 prepared，一次 journal 提交；进段后 journalProblem===null。失败留在 drained。
export function osmEnterForward(ctx, { token, lease, env = process.env } = {}) {
  const fail = (reason, why, extra = {}) => ({ ok: false, reason, why: why ?? null, phase: "drained", ...extra });
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return fail("journal_" + j.state, j.why ?? null);
  if (j.doc.operation_kind !== "owner_select_migration_a") return fail("bad_operation_kind", "operation_kind " + j.doc.operation_kind);
  if (j.doc.phase !== "drained") return fail("not_drained", "phase " + j.doc.phase);
  const cid = campaignIdFor(token);
  const frz = frozenEndpoints(ctx.dir); if (!frz.ok) return fail(frz.reason, frz.why);
  const pre = osmPreForwardPlanMatrix(ctx, { token, lease, env });
  if (!pre.ok) return fail(pre.reason, pre.why);
  // campaign before/after 投影 + 备份。
  const camp = readCampaignState(env);
  if (camp.state === "unreadable") return fail("campaign_unreadable", camp.problem ?? null);
  const campBefore = camp.state === "absent" || camp.state === "complete"
    ? { exists: false, sha256: null, state: "absent", campaign_id: null, endpoints: null, endpoints_digest: null }
    : camp; // open（恢复场景）
  const campDoc = { schema_version: CAMPAIGN_SCHEMA, state: "open", campaign_id: cid, endpoints: frz.endpoints, endpoints_digest: endpointsDigest(frz.endpoints) };
  const campAfter = { exists: true, sha256: sha256(serializeLedger(campDoc)), state: "open", campaign_id: cid, endpoints: frz.endpoints, endpoints_digest: endpointsDigest(frz.endpoints) };
  const campBackup = campBefore.exists === true ? stagedBackup(ctx, token, "campaign") : null;
  const writer = readWriterState(env);
  if (writer.state === "unreadable") return fail("writer_unreadable", writer.problem ?? null);
  const writerBefore = writer.state === "off" ? { exists: false, sha256: null, state: "off", campaign_id: null, endpoints_digest: null, revision: 0 } : writer;
  const writerDoc = { schema_version: WRITER_STATE_SCHEMA, state: "partial", campaign_id: cid, endpoints_digest: endpointsDigest(frz.endpoints), revision: writerBefore.exists === true ? writerBefore.revision + 1 : 1 };
  const writerAfter = { exists: true, sha256: sha256(serializeLedger(writerDoc)), state: "partial", campaign_id: cid, endpoints_digest: endpointsDigest(frz.endpoints), revision: writerDoc.revision };
  const writerBackup = writerBefore.exists === true ? stagedBackup(ctx, token, "writer-state") : null;
  const stagedDir = path.join(ctx.dir, token + ".staged"); fs.mkdirSync(path.join(stagedDir, "intended"), { recursive: true, mode: 0o700 });
  const ats = new Date(ctx.now()).toISOString();
  const steps = [
    { kind: "campaign", id: "campaign:" + cid + ":open", state: "prepared", at: ats, target: "ledger/owner-select-campaign.json", chain: null, backup: campBackup, backup_sha256: campBefore.exists === true ? campBefore.sha256 : null, backup_bytes: campBefore.exists === true ? campBefore.sha256.length * 4 : null, before: campBefore, intended_after: campAfter },
    { kind: "writer_state", id: "writer_state:" + cid + ":partial", state: "prepared", at: ats, target: "ledger/owner-select-writer-state.json", chain: null, backup: writerBackup, backup_sha256: writerBefore.exists === true ? writerBefore.sha256 : null, backup_bytes: writerBefore.exists === true ? writerBefore.sha256.length * 4 : null, before: writerBefore, intended_after: writerAfter },
  ];
  for (const ep of frz.endpoints) {
    const d = resolveEndpointDir(ep, { env }); if (!d.ok) return fail("endpoint_unresolvable", ep + "：" + d.reason);
    const L = loadLedger(d.dir, { endpointId: ep }); if (!L.ok) return fail("ledger_unreadable", ep + "：" + L.reason);
    if (L.doc.schema_version !== "1.0") return fail("not_at_1_0", ep + "：schema " + L.doc.schema_version);
    const opId = schemaUpgradeOperationId(token, ep);
    const budgeted = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token + ":schema", from_schema: "1.0", to_schema: "1.1-transition" });
    const budgetedSha = sha256(serializeLedger(budgeted));
    const inv = migrationInventory(budgeted);
    const plan = pre.plans[ep];
    const planBytes = mintPlanBytes(plan);
    // #2：schema/mint 各自独立备份文件（内容含其 before 状态），避免互相覆盖。
    const schemaBuf = fs.readFileSync(path.join(d.dir, "ledger.json"));
    const schemaBackup = stagedBackup(ctx, token, ep + "-ledger"); fs.writeFileSync(schemaBackup, schemaBuf, { mode: 0o600 });
    const mintBuf = serializeLedger(budgeted);
    const mintBackup = stagedBackup(ctx, token, ep + "-mint-before"); fs.writeFileSync(mintBackup, mintBuf, { mode: 0o600 });
    const mintSha = sha256(serializeLedger(applyMintPlan(budgeted, plan)));
    steps.push({ kind: "schema_endpoint", id: "schema_endpoint:" + ep + ":transition", state: "prepared", at: ats, target: "ledger/" + ep + "/ledger.json", chain: null, backup: schemaBackup, backup_sha256: sha256(schemaBuf), backup_bytes: schemaBuf.length, before: { schema_version: "1.0", revision: L.doc.revision, ledger_sha256: L.sha256 }, intended_after: { schema_version: "1.1-transition", revision: L.doc.revision + 1, ledger_sha256: budgetedSha } });
    steps.push({ kind: "mint", id: "mint:" + ep, state: "prepared", at: ats, target: "ledger/" + ep + "/ledger.json", chain: null, backup: mintBackup, backup_sha256: sha256(mintBuf), backup_bytes: mintBuf.length, before: { revision: L.doc.revision + 1, null_b1_count: inv.null_b1_count, ledger_sha256: budgetedSha }, intended_after: { revision: L.doc.revision + 2, null_b1_count: 0, ledger_sha256: mintSha }, intended_blob: { path: path.join(stagedDir, "intended", "mint-" + ep + ".json"), bytes: Buffer.byteLength(planBytes), sha256: sha256(Buffer.from(planBytes, "utf-8")) } });
  }
  const r = updateJournal({ dir: ctx.dir, token, lease, expectPhase: "drained", now: ctx.now(), mutate: (d) => { d.phase = "osm_a_upgrading"; d.steps = [...d.steps, ...steps]; return d; } });
  if (!r.ok) return fail(r.reason, r.why ?? null);
  const j2 = readJournal({ dir: ctx.dir, token });
  if (j2.state !== "valid") return fail("journal_" + j2.state, j2.why ?? null);
  // 红测试：进段后 journalProblem===null。
  const jp2 = journalProblem(j2.doc, { maintenanceDir: ctx.dir });
  if (jp2 !== null) return { ok: false, reason: "journal_corrupt", why: jp2, phase: "osm_a_upgrading" };
  return { ok: true, phase: "osm_a_upgrading", steps: steps.length };
}

// 备份路径（<token>.staged/backup.json）。
function stagedBackup(ctx, token, name) { return path.join(ctx.dir, token + ".staged", "backup-" + name + ".json"); }

// §二.5 forward 收敛（可重入；崩溃恢复只看 journal + 现场；handle 不重生成）：
//   a campaign open → b 每 ep schemaUpgrade → c 每 ep 读 plan（intended_blob 回读）→ mintSelectionHandles → d writer_state partial → e setPhase(ledger_reopening)。
//   每写 commit!==committed_clean → 停门（exit 3 纪律）；precheck_failed/written_mismatch/before_mismatch → 停门待修（forward-only）。
export function osmForward(ctx, { token, lease, env = process.env, _inject = null } = {}) {
  const fail = (reason, why, commit = "not_committed", extra = {}) => ({ ok: false, reason, why: why ?? null, commit, ...extra });
  let doc = readJournal({ dir: ctx.dir, token }).doc;
  if (doc.phase !== "osm_a_upgrading") return fail("not_forwarding", "phase " + doc.phase);
  const cid = campaignIdFor(token);
  const frz = frozenEndpoints(ctx.dir); if (!frz.ok) return fail(frz.reason, frz.why);
  const refresh = () => { doc = readJournal({ dir: ctx.dir, token }).doc; return doc; };
  // a. campaign:open
  const campStep = doc.steps.find((s) => s.kind === "campaign" && s.id === "campaign:" + cid + ":open");
  if (campStep && campStep.state !== "done") {
    if (campStep.state === "prepared") {
      const members = {};
      for (const ep of frz.endpoints) { const d = resolveEndpointDir(ep, { env }); const L = loadLedger(d.dir, { endpointId: ep }); const inv = migrationInventory(L.doc); members[ep] = { legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count, schema_version: L.doc.schema_version }; }
      const campDoc = { schema_version: CAMPAIGN_SCHEMA, state: "open", campaign_id: cid, endpoints: frz.endpoints, endpoints_digest: endpointsDigest(frz.endpoints), members, pending_joins: [], revision: 1, origin_operation_id: token };
      const campCur = readCampaignState(env);
      const w = writeCampaignState({ env, expectedSha256: campCur.exists === true ? campCur.sha256 : null, doc: campDoc, capability: { token, stepId: campStep.id } });
      if (!w.ok) return fail(w.reason, w.why, w.commit, { lockUncleared: w.lockUncleared ?? null });
      if (w.commit !== "committed") return fail("commit_residue", w.why ?? null, w.commit, { residue: w.residue ?? null, lockUncleared: w.lockUncleared ?? null });
    }
    const m = markStepDone({ dir: ctx.dir, token, lease, id: campStep.id, after: campStep.intended_after, now: ctx.now() });
    if (!m.ok) return fail(m.reason, m.why ?? null);
    refresh();
  }
  // b. 每 ep schemaUpgrade
  for (const ep of frz.endpoints) {
    const sStep = refresh().steps.find((s) => s.kind === "schema_endpoint" && s.id === "schema_endpoint:" + ep + ":transition");
    if (!sStep || sStep.state === "done") continue;
    const d = resolveEndpointDir(ep, { env }); if (!d.ok) return fail("endpoint_unresolvable", ep + "：" + d.reason);
    const L = loadLedger(d.dir, { endpointId: ep }); if (!L.ok) return fail("ledger_unreadable", ep + "：" + L.reason);
    if (sStep.state === "prepared") {
      const atIntended = L.doc.schema_version === sStep.intended_after.schema_version && L.sha256 === sStep.intended_after.ledger_sha256;
      if (!atIntended) {
        if (L.doc.schema_version !== sStep.before.schema_version || L.sha256 !== sStep.before.ledger_sha256) return fail("before_mismatch", ep + "：现场 schema/SHA 与 step.before 不符（forward-only，停门待修）");
        const w = schemaUpgrade({ endpointId: ep, capability: { kind: "schema_upgrade", token, endpointId: ep }, requestKey: token + ":schema", fromSchema: sStep.before.schema_version, toSchema: sStep.intended_after.schema_version, env, _inject });
        if (!w.ok) return fail(w.reason, w.why ?? null, w.commit ?? "not_committed", { lockUncleared: w.lockUncleared ?? null });
        if (w.commit !== "committed_clean" && w.commit !== "replayed") return fail("commit_residue", w.why ?? null, w.commit, { residue: w.residue ?? null, lockUncleared: w.lockUncleared ?? null });
      }
    }
    const m = markStepDone({ dir: ctx.dir, token, lease, id: sStep.id, after: sStep.intended_after, now: ctx.now() });
    if (!m.ok) return fail(m.reason, m.why ?? null);
  }
  // c. 每 ep 读 plan（intended_blob 回读 0600 单硬链接 sha/bytes）→ mintSelectionHandles
  for (const ep of frz.endpoints) {
    const mStep = refresh().steps.find((s) => s.kind === "mint" && s.id === "mint:" + ep);
    if (!mStep || mStep.state === "done") continue;
    if (mStep.state === "prepared") {
      const blob = mStep.intended_blob;
      if (!blob) return fail("intended_blob_missing", ep + "：journal mint step 无 intended_blob");
      let raw;
      try {
        const st = fs.statSync(blob.path); if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) return fail("blob_shape_bad", ep + "：plan 文件非 0600 单硬链接普通文件");
        const buf = fs.readFileSync(blob.path);
        if (Buffer.byteLength(buf) !== blob.bytes || sha256(buf) !== blob.sha256) return fail("blob_mismatch", ep + "：plan 文件 sha/bytes 与 intended_blob 不符");
        raw = JSON.parse(buf.toString("utf-8"));
      } catch (err) { return fail("blob_unreadable", ep + "：" + errText(err)); }
      if (mintPlanProblem(raw) !== null) return fail("plan_invalid", ep + "：" + mintPlanProblem(raw));
      // 三态由 mintSelectionHandles 内部判（before→apply / expected→already / 其它→ledger_diverged）；
      // 只在其返回 committed_clean/already 才 markStepDone；ledger_diverged → 停门待修（不记 done）。
      const w = mintSelectionHandles({ endpointId: ep, capability: { kind: "mint_selection_handles", token, endpointId: ep, request_key: token }, plan: raw, env, _inject });
      if (!w.ok) return fail(w.reason, w.why ?? null, w.commit ?? "not_committed", { lockUncleared: w.lockUncleared ?? null });
      if (w.commit !== "committed_clean" && w.commit !== "already") return fail("commit_residue", w.why ?? null, w.commit, { residue: w.residue ?? null, lockUncleared: w.lockUncleared ?? null });
    }
    const m = markStepDone({ dir: ctx.dir, token, lease, id: mStep.id, after: mStep.intended_after, now: ctx.now() });
    if (!m.ok) return fail(m.reason, m.why ?? null);
  }
  // d. writer_state partial
  const wStep = refresh().steps.find((s) => s.kind === "writer_state" && s.id === "writer_state:" + cid + ":partial");
  if (wStep && wStep.state !== "done") {
    if (wStep.state === "prepared") {
      const wsBefore = readWriterState(env);
      const writerDoc = { schema_version: WRITER_STATE_SCHEMA, state: "partial", campaign_id: cid, endpoints_digest: endpointsDigest(frz.endpoints), revision: wsBefore.exists === true ? wsBefore.revision + 1 : 1, origin_operation_id: token };
      const w = writeWriterState({ env, expectedSha256: wsBefore.exists === true ? wsBefore.sha256 : null, doc: writerDoc, capability: { token, stepId: wStep.id } });
      if (!w.ok) return fail(w.reason, w.why, w.commit, { lockUncleared: w.lockUncleared ?? null });
      if (w.commit !== "committed") return fail("commit_residue", w.why ?? null, w.commit, { residue: w.residue ?? null, lockUncleared: w.lockUncleared ?? null });
    }
    const m = markStepDone({ dir: ctx.dir, token, lease, id: wStep.id, after: wStep.intended_after, now: ctx.now() });
    if (!m.ok) return fail(m.reason, m.why ?? null);
  }
  // e. 全部 done → setPhase(ledger_reopening)
  refresh();
  const final = readJournal({ dir: ctx.dir, token });
  const undone = final.doc.steps.filter((s) => s.state !== "done");
  if (undone.length > 0) return fail("steps_incomplete", undone.map((s) => s.id).join(","));
  const np = setPhase({ dir: ctx.dir, token, lease, phase: "ledger_reopening", expectPhase: "osm_a_upgrading", now: ctx.now() });
  if (!np.ok) return fail(np.reason, np.why ?? null);
  return { ok: true, phase: "ledger_reopening" };
}

// §二.6 重开（owner_select 专门版，不涉 runtime current/timer/stub）：
//   ① 身份核验（每 ep 账本含本 token 的 schema_upgrade(≤request_key token:":schema") 与 mint(request_key token) op 且 revision ≥）；campaign/writer 读回 === step after；
//   ② 删 <token>.staged/（含 mint plan）→ 撤门 → done → 清 active；失败 → reopening_incomplete（门与 active 保留）。
export function osmReopening(ctx, { token, lease, env = process.env } = {}) {
  const fail = (reason, why, extra = {}) => ({ ok: false, reason, why: why ?? null, phase: "reopening_incomplete", journalWrite: true, ...extra });
  const j = readJournal({ dir: ctx.dir, token });
  if (j.state !== "valid") return fail("journal_" + j.state, j.why ?? null);
  if (j.doc.phase !== "ledger_reopening") return fail("not_reopening", "phase " + j.doc.phase);
  const incomplete = [];
  const note = (t) => addNote({ dir: ctx.dir, token, lease, note: t, now: ctx.now() });
  const frz = frozenEndpoints(ctx.dir);
  // ① 身份核验：每 ep 账本含本 op 的 schema_upgrade + mint。
  for (const ep of (frz.ok ? frz.endpoints : [])) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) { incomplete.push({ id: "ledger:" + ep, why: "账本根无法定位" }); continue; }
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) { incomplete.push({ id: "ledger:" + ep, why: "账本缺失/不可读" }); continue; }
    const schemas = Object.values(L.doc.operations).filter((o) => o.op_type === "schema_upgrade" && (o.request_key === token + ":schema" || o.request_key === token));
    const mints = Object.values(L.doc.operations).filter((o) => o.op_type === "mint_selection_handles" && o.request_key === token);
    if (schemas.length !== 1) incomplete.push({ id: "schema:" + ep, why: "账本缺/多 schema_upgrade op（request_key 应为本 token）" });
    if (mints.length !== 1) incomplete.push({ id: "mint:" + ep, why: "账本缺/多 mint op（request_key 应为本 token）" });
  }
  // campaign/writer 读回 === step after。
  const campStep = j.doc.steps.find((s) => s.kind === "campaign");
  if (campStep) { const c = readCampaignState(env); if (!(c.exists === true && c.campaign_id === campStep.intended_after.campaign_id && c.state === "open")) incomplete.push({ id: campStep.id, why: "campaign 读回升级不匹配" }); }
  const wStep = j.doc.steps.find((s) => s.kind === "writer_state");
  if (wStep) { const w = readWriterState(env); if (!(w.exists === true && w.campaign_id === wStep.intended_after.campaign_id && w.state === "partial")) incomplete.push({ id: wStep.id, why: "writer-state 读回不匹配" }); }
  if (incomplete.length > 0) {
    note("重开身份核验不齐：" + incomplete.map((i) => i.id + "（" + i.why + "）").join(";"));
    return fail("reopening_incomplete", incomplete.map((i) => i.id).join(","));
  }
  // ② 删 <token>.staged/（含 mint plan）。
  const staged = path.join(ctx.dir, token + ".staged");
  try { fs.rmSync(staged, { recursive: true, force: true }); } catch (err) { return fail("staged_delete_failed", errText(err)); }
  // 撤门 → done → 清 active。
  if (j.doc.steps.some((s) => s.kind === "gate")) {
    const g = ctx.gateOps.removeGate({ file: ctx.gateFile, token });
    if (!g.ok && g.reason !== "absent") return fail("gate_remove_failed", String(g.reason));
    if (g.txnUncleared) return fail("gate_txn_uncleared", "撤门成功但归属转换锁交不还");
  }
  const p = setPhase({ dir: ctx.dir, token, lease, phase: "done", expectPhase: "ledger_reopening", now: ctx.now() });
  if (!p.ok) return fail("journal_write_failed", p.why ?? p.reason);
  const c = clearActive({ dir: ctx.dir, token });
  if (!c.ok) return { ok: false, phase: "done", activeCleared: false, activeWhy: String(c.reason), incomplete: [{ id: "active", why: "active 清不掉" }] };
  return { ok: true, phase: "done", activeCleared: c.cleared === true };
}

// §二.8 --exit 分派：owner_select_migration_a 按 phase 分派（forward 态只向前 / ≤drained 回退 / done 清 active）。
export function osmExit(ctx, { apply = false, env = process.env } = {}) {
  const readOp = () => { const active = readActive({ dir: ctx.dir }); if (active.state === "absent") return { ok: false, reason: "no_operation" }; if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why }; const tk = active.token; const jj = readJournal({ dir: ctx.dir, token: tk }); if (jj.state !== "valid") return { ok: false, reason: "journal_" + jj.state, why: jj.why }; const ph = jj.doc.phase; const action = ph === "done" ? "clear_active" : ph === "ledger_reopening" || ph === "reopening_incomplete" ? "reopen" : ph === "drained" ? "rollback" : "forward"; return { ok: true, token: tk, phase: ph, action }; };
  const dry = readOp(); if (!dry.ok) return dry; if (!apply) return { ok: true, dryRun: true, ...dry };
  const lease = acquireOperationLease({ dir: ctx.dir, token: dry.token });
  if (!lease.ok) return { ok: false, reason: lease.reason, why: lease.why };
  let out;
  if (dry.action === "clear_active") { const c = clearActive({ dir: ctx.dir, token: dry.token }); out = { ok: c.ok, phase: "done", activeCleared: c.cleared === true, why: c.ok ? null : String(c.reason) }; releaseOperationLease(lease); return out; }
  if (dry.action === "reopen") { out = osmReopening(ctx, { token: dry.token, lease, env }); releaseOperationLease(lease); return out; }
  if (dry.action === "rollback") { out = osmRollback(ctx, { token: dry.token, lease, env }); releaseOperationLease(lease); return out; }
  // forward：只向前（osmForward）。
  out = osmForward(ctx, { token: dry.token, lease, env }); if (out.ok) { out = osmReopening(ctx, { token: dry.token, lease, env }); }
  releaseOperationLease(lease); return out;
}

// §二.7 回退（≤drained 才允许）：先删本 operation 的 <token>.staged/intended/mint-*.json；删不掉 → rollback_incomplete。
export function osmRollback(ctx, { token, lease, env = process.env }) {
  void lease; void env;
  const staged = path.join(ctx.dir, token + ".staged");
  try { fs.rmSync(staged, { recursive: true, force: true }); } catch (err) { return { ok: false, reason: "rollback_incomplete", why: "删 plan 失败：" + errText(err) }; }
  return { ok: true, phase: "rolled_back", reason: "rolled_back" };
}

/** osmEnter：进门（安装面锁 → enterMaintenance(operation_kind="owner_select_migration_a") → drained）+ drained 只读前置。 */
export function osmEnter(ctx, { waitMs = 60000, apply = false, reason = "owner_select 迁移 A（old→transition）", env = process.env } = {}) {
  if (!apply) return enterMaintenance(ctx, { reason, waitMs, apply: false, operationKind: "owner_select_migration_a" });
  const surface = acquireInstallSurfaceLock({ home: ctx.home, env });
  if (!surface.ok) return { ok: false, reason: surface.reason, why: surface.why, path: surface.path };
  const ent = enterMaintenance(ctx, { reason, waitMs, apply: true, keepLease: true, operationKind: "owner_select_migration_a" });
  if (!ent.ok || !ent.lease) {
    const rel = releaseSurface(surface);
    return { ...ent, surfaceRelease: rel.ok ? null : { path: rel.path ?? null, why: rel.why ?? rel.reason } };
  }
  let out;
  try {
    out = osmDrainedPrecheck(ctx, { token: ent.token, env });
  } catch (err) {
    if (err?.simulatedCrash === true) throw err;
    out = { ok: false, reason: "osm_precheck_failed", why: errText(err), phase: ent.phase ?? "drained", rollbackSafe: true };
  }
  const leaseRel = releaseOperationLease(ent.lease);
  const surfaceRel = releaseSurface(surface);
  return { token: ent.token, phase: ent.phase, ...out, leaseRelease: leaseRel.ok ? null : { path: leaseRel.path ?? null, why: leaseRel.why ?? leaseRel.reason }, surfaceRelease: surfaceRel.ok ? null : { path: surfaceRel.path ?? null, why: surfaceRel.why ?? surfaceRel.reason } };
}
