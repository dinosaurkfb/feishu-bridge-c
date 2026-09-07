// R52 账本侧 operation A（owner_select_migration_a）维护编排——照 ledger-operation.mjs 骨架。
//   只做账本侧：进门 → drained 只读前置 → pre-forward plan 矩阵 → 原子进段 → forward 收敛 → 重开/回退/--exit。
//   骨架/合同参照 scripts/maintenance/ledger-operation.mjs 与 docs/architecture/owner-select-route.md §8。
import fs from "node:fs";
import path from "node:path";
import { acquireInstallSurfaceLock } from "../install-surface-lock.mjs";
import { releaseOperationLease, readActive, readJournal, acquireOperationLease } from "./journal.mjs";
import { enterMaintenance, rollbackOperation } from "./operation.mjs";
import { updateJournal, journalProblem } from "./journal.mjs";
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
function frozenEndpoints(dir) {
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
    const budgeted = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token, from_schema: "1.0", to_schema: "1.1-transition" });
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
  const campBackup = campBefore.exists === true ? stagedBackupOf(ctx, token) : null;
  const writer = readWriterState(env);
  if (writer.state === "unreadable") return fail("writer_unreadable", writer.problem ?? null);
  const writerBefore = writer.state === "off" ? { exists: false, sha256: null, state: "off", campaign_id: null, endpoints_digest: null, revision: 0 } : writer;
  const writerDoc = { schema_version: WRITER_STATE_SCHEMA, state: "partial", campaign_id: cid, endpoints_digest: endpointsDigest(frz.endpoints), revision: writerBefore.exists === true ? writerBefore.revision + 1 : 1 };
  const writerAfter = { exists: true, sha256: sha256(serializeLedger(writerDoc)), state: "partial", campaign_id: cid, endpoints_digest: endpointsDigest(frz.endpoints), revision: writerDoc.revision };
  const writerBackup = writerBefore.exists === true ? stagedBackupOf(ctx, token) : null;
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
    const budgeted = applySchemaUpgrade(L.doc, { operation_id: opId, request_key: token, from_schema: "1.0", to_schema: "1.1-transition" });
    const budgetedSha = sha256(serializeLedger(budgeted));
    const inv = migrationInventory(budgeted);
    const plan = pre.plans[ep];
    const planBytes = mintPlanBytes(plan);
    const backup = stagedBackupOf(ctx, token);
    const ledgerBackup = backup; // 账本备份到 staged（sha === before.ledger_sha256）
    fs.writeFileSync(ledgerBackup, fs.readFileSync(path.join(d.dir, "ledger.json")), { mode: 0o600 });
    const mintSha = sha256(serializeLedger(applyMintPlan(budgeted, plan)));
    steps.push({ kind: "schema_endpoint", id: "schema_endpoint:" + ep + ":transition", state: "prepared", at: ats, target: "ledger/" + ep + "/ledger.json", chain: null, backup: ledgerBackup, backup_sha256: L.sha256, backup_bytes: Buffer.byteLength(fs.readFileSync(path.join(d.dir, "ledger.json"))), before: { schema_version: "1.0", revision: L.doc.revision, ledger_sha256: L.sha256 }, intended_after: { schema_version: "1.1-transition", revision: L.doc.revision + 1, ledger_sha256: budgetedSha } });
    steps.push({ kind: "mint", id: "mint:" + ep, state: "prepared", at: ats, target: "ledger/" + ep + "/ledger.json", chain: null, backup: ledgerBackup, backup_sha256: budgetedSha, backup_bytes: Buffer.byteLength(fs.readFileSync(path.join(d.dir, "ledger.json"))), before: { revision: L.doc.revision + 1, null_b1_count: inv.null_b1_count, ledger_sha256: budgetedSha }, intended_after: { revision: L.doc.revision + 2, null_b1_count: 0, ledger_sha256: mintSha }, intended_blob: { path: path.join(stagedDir, "intended", "mint-" + ep + ".json"), bytes: Buffer.byteLength(planBytes), sha256: sha256(Buffer.from(planBytes, "utf-8")) } });
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
function stagedBackupOf(ctx, token) { return path.join(ctx.dir, token + ".staged", "backup.json"); }

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
