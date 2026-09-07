// R52 账本侧 operation A（owner_select_migration_a）维护编排——照 ledger-operation.mjs 骨架。
//   只做账本侧：进门 → drained 只读前置 → pre-forward plan 矩阵 → 原子进段 → forward 收敛 → 重开/回退/--exit。
//   骨架/合同参照 scripts/maintenance/ledger-operation.mjs 与 docs/architecture/owner-select-route.md §8。
import fs from "node:fs";
import path from "node:path";
import { acquireInstallSurfaceLock } from "../install-surface-lock.mjs";
import { releaseOperationLease, readActive, readJournal, acquireOperationLease } from "./journal.mjs";
import { enterMaintenance, rollbackOperation } from "./operation.mjs";
import { aggregateEndpointReceipts, endpointReceipt } from "./ledger-receipt.mjs";
import { campaignIdFor } from "./owner-select-derived.mjs";
import { readCampaignState, readWriterState, writeCampaignState, writeWriterState, readCampaignDocVerified, readWriterStateDocVerified } from "./owner-select-state.mjs";
import { resolveEndpointDir, validateLedgerRoot, loadLedger, schemaUpgrade, mintSelectionHandles, applySchemaUpgrade, buildMintPlan, mintPlanBytes, mintPlanProblem, migrationInventory, schemaUpgradeOperationId } from "../topic-agent-ledger.mjs";

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
