/**
 * R52：owner_select 迁移命令面（§三）。工艺对齐 maintenance-ledger.mjs：参数封闭（每 flag 至多一次）、
 * 默认只预览（零改动）、--apply 才动（安装类授权，Frank 逐次）；退出码沿用同一纪律
 * （0 完成/预览、1 拒绝未动、3 已动现场未做完）。编排入口是 owner-select-operation.mjs 的
 * osmEnter / osmExit，本模块只包参数与返回码，不自造第二套编排。
 *
 *   node scripts/maintenance-owner-select.mjs --status                          只读：活动 osm operation + 冻结集 + campaign/writer 投影
 *   node scripts/maintenance-owner-select.mjs --migrate-a [--wait-ms N] [--apply]  operation A（old→transition + mint + writer partial）
 *
 * `--exit` 不在本单（沿用 maintenance-gate --exit 按 operation_kind 分派：owner_select_migration_a → osmExit）。
 */
import fs from "node:fs";
import path from "node:path";

import { isDirectRun, moduleDir } from "./direct-run.mjs";
import { maintenanceContext, renderStatus, maintenanceStatus } from "./maintenance/operation.mjs";
import { readActive, readJournal, TERMINAL_PHASES } from "./maintenance/journal.mjs";
import { campaignIdFor, readCampaignState, readOwnerSelectAdmission, readWriterState } from "./maintenance/owner-select-state.mjs";
import { osmEnter, osmExit } from "./maintenance/owner-select-operation.mjs";
import { loadLedger, migrationInventory, resolveEndpointDir } from "./topic-agent-ledger.mjs";
import { aggregateEndpointReceipts, endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import { exitCodeFor } from "./maintenance/exit-code.mjs";
export { exitCodeFor };

/** 参数封闭：--status 不带别的；--migrate-a 可选 --wait-ms / --apply；每 flag 至多一次。 */
export function parseMaintenanceOwnerSelectArgs(argv) {
  let mode = null, waitMs = 60000, apply = false;
  const seen = new Set();
  const once = (flag) => { if (seen.has(flag)) return false; seen.add(flag); return true; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status" || a === "--migrate-a" || a === "--migrate-b" || a === "--migrate-direct") { if (mode !== null) return { ok: false, reason: "只能给一个动作" }; mode = a.slice(2); continue; }
    if (a === "--wait-ms") { if (!once(a)) return { ok: false, reason: "--wait-ms 重复" }; const raw = argv[i + 1]; const v = Number(raw); if (typeof raw !== "string" || !/^\d+$/u.test(raw) || !Number.isSafeInteger(v) || v > 3600000) return { ok: false, reason: "--wait-ms 要是 0–3600000 的整数" }; waitMs = v; i += 1; continue; }
    if (a === "--apply") { if (!once(a)) return { ok: false, reason: "--apply 重复" }; apply = true; continue; }
    return { ok: false, reason: "不认识的参数：" + a };
  }
  if (mode === null) return { ok: false, reason: "要给 --status / --migrate-a / --migrate-b / --migrate-direct 之一" };
  if (mode === "status" && seen.size > 0) return { ok: false, reason: "--status 不带别的参数" };
  return { ok: true, mode, waitMs, apply };
}

/** 只读投影：活动 osm operation + 冻结集（initDone 收据）+ 每 ep 账本要点 + campaign / writer-state 状态。 */
export function ownerSelectStatus(ctx, { env = process.env } = {}) {
  const active = readActive({ dir: ctx.dir });
  let activeOp = null;
  if (active.state === "active") {
    const j = readJournal({ dir: ctx.dir, token: active.token });
    if (j.state === "valid" && ["owner_select_migration_a", "owner_select_migration_b", "owner_select_migration_direct"].includes(j.doc.operation_kind)) {
      activeOp = { token: active.token, kind: j.doc.operation_kind, phase: j.doc.phase, steps: j.doc.steps.filter((s) => ["campaign", "schema_endpoint", "mint", "writer_state"].includes(s.kind)).map((s) => s.id + ":" + s.state) };
    }
  }
  const cs = readCampaignState(env);
  const ws = readWriterState(env);
  // 冻结集与每 ep 盘点（只读）——P1-2：用唯一聚合 aggregateEndpointReceipts，任一收据 conflict/in-flight/
  // unreadable → 整体投影成「查不清」（receiptsProblem 点名），绝不静默枚举剩余子集。
  const agg = aggregateEndpointReceipts({ dir: ctx.dir });
  const receiptsProblem = agg.ok ? null : agg.why ?? null;
  const frozen = [...new Set(agg.ok ? agg.endpoints.filter((e) => e.initDone === true).map((e) => e.endpointId) : [])].sort();
  const endpoints = frozen.map((ep) => {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) return { endpointId: ep, why: d.reason };
    const L = loadLedger(d.dir, { endpointId: ep });
    if (!L.ok) return { endpointId: ep, why: L.why ?? L.reason };
    const inv = migrationInventory(L.doc);
    return { endpointId: ep, schemaVersion: L.doc.schema_version, revision: L.doc.revision, legacyProofCount: inv.legacy_proof_count, nullB1Count: inv.null_b1_count };
  });
  const admission = readOwnerSelectAdmission(env);
  return { activeOp, campaign: { exists: cs.exists, state: cs.state, campaignId: cs.campaign_id }, writerState: { exists: ws.exists, state: ws.state, campaignId: ws.campaign_id }, receiptsProblem, endpoints, admission: admission.state };
}

export function renderOwnerSelectStatus(st) {
  const parts = [];
  if (st.activeOp) parts.push("活动 owner_select operation：token " + String(st.activeOp.token).slice(0, 8) + "，" + st.activeOp.kind + "，阶段 " + st.activeOp.phase + (st.activeOp.steps.length ? "\n    " + st.activeOp.steps.join("、") : ""));
  else parts.push("没有活动 owner_select operation");
  parts.push("campaign：" + (st.campaign.exists ? st.campaign.state + "（" + st.campaign.campaignId + "）" : "absent"));
  parts.push("writer-state：" + (st.writerState.exists ? st.writerState.state + "（" + st.writerState.campaignId + "）" : "off（缺席）"));
  if (st.receiptsProblem) { parts.push("冻结集：查不清（" + st.receiptsProblem + "）"); return parts.join("\n"); }
  parts.push("准入投影（writer ∧ campaign 联合判定）：" + st.admission);
  if (st.endpoints.length === 0) parts.push("冻结集：空（无 initDone 收据 endpoint）");
  else parts.push("冻结集（initDone 收据）：" + st.endpoints.length + " 个 endpoint");
  for (const e of st.endpoints) {
    if (e.why) parts.push("  " + e.endpointId + "：读不出（" + e.why + "）");
    else parts.push("  " + e.endpointId + "：" + e.schemaVersion + " rev" + e.revision + "，legacy " + e.legacyProofCount + "，null-B1 " + e.nullB1Count);
  }
  return parts.map((p) => "  " + p).join("\n");
}

const fmtFail = (r) => String(r.reason) + (r.why ? "：" + r.why : "") + (r.path ? "，" + r.path : "");
const releaseRows = (r) => {
  const rows = [];
  if (r.leaseRelease) rows.push("租约交不还：" + r.leaseRelease.path + "（" + String(r.leaseRelease.why ?? r.leaseRelease.reason ?? "") + "）");
  if (r.surfaceRelease) rows.push("安装面锁交不还：" + r.surfaceRelease.path + "（" + String(r.surfaceRelease.why ?? r.surfaceRelease.reason ?? "") + "）");
  for (const p of r.residue ?? []) rows.push("写后残骸：" + p);
  return rows;
};



export function runMaintenanceOwnerSelect(argv, { ctx = null, out = (s) => process.stdout.write(s + "\n"), env = process.env } = {}) {
  const parsed = parseMaintenanceOwnerSelectArgs(argv);
  if (!parsed.ok) { out("用法：node maintenance-owner-select.mjs --status | --migrate-a [--wait-ms N] [--apply]（" + parsed.reason + "）"); return 1; }
  const c = ctx ?? maintenanceContext({ repoRoot: path.dirname(moduleDir(import.meta.url)) });
  if (parsed.mode === "status") {
    out(renderStatus(maintenanceStatus(c)));
    out(renderOwnerSelectStatus(ownerSelectStatus(c, { env })));
    return 0;
  }
  const kind = parsed.mode === "migrate-a" ? "a" : parsed.mode === "migrate-b" ? "b" : "direct";
  const r = osmEnter(c, { kind, waitMs: parsed.waitMs, apply: parsed.apply, reason: null, env });
  if (r.dryRun) {
    const previewByKind = {
      a: "[预览] owner_select 迁移 A：停两链定时器 → 两链 current 切维护桩 → 建门 → 等既有进程退出 → drained 前置盘点（冻结集 = 全部 initDone 收据 endpoint）→ 原子进段（campaign open + 每 ep schema/mint + writer partial）→ transition + 复合 mint + writer_state=partial → 重开撤门。加 --apply 执行。",
      b: "[预览] owner_select 迁移 B：停两链定时器 → 两链 current 切维护桩 → 建门 → 等既有进程退出 → drained 前置盘点（campaign open 且 pending_joins 空、writer partial 同 id、冻结集 = campaign endpoints、每 ep transition 且当场盘点两计数皆 0）→ 原子进段（campaign seal + 每 ep precheck/strict + campaign complete + writer on）→ strict + campaign complete + writer_state=on（准入投影 on）→ 重开撤门。加 --apply 执行。",
      direct: "[预览] owner_select 迁移 direct：停两链定时器 → 两链 current 切维护桩 → 建门 → 等既有进程退出 → drained 前置盘点（冻结集 = 全部 initDone 收据 endpoint、每 ep 1.0 且当场盘点两计数皆 0、campaign absent|complete、writer off → on）→ 原子进段（campaign open + 每 ep precheck/直升 + campaign seal + campaign complete + writer on，on 的 before=off）→ 直升 1.1 + writer_state=on（准入投影 on）→ 重开撤门。加 --apply 执行。",
    };
    out(previewByKind[kind]);
    return 0;
  }
  const rows = releaseRows(r);
  const code = exitCodeFor(r);
  // R53 返修一 (b)：失败/拒绝/完成/卡住的文案按 kind 分段（A/B/direct 各自措辞），不再一律「迁移 A」。
  const KIND_LABEL = { a: "A", b: "B", direct: "direct" };
  const DONE_BY_KIND = {
    a: "transition + handle 已铸 + writer partial",
    b: "transition→strict + campaign complete + writer on",
    direct: "1.0→1.1 直升 + campaign complete + writer on",
  };
  const label = KIND_LABEL[kind] ?? "?" + kind;
  if (!r.ok) {
    out("owner_select 迁移 " + label + " 没做成（" + fmtFail(r) + "）" + (r.rollback ? (r.rollback.ok ? "；已按账回退还清" : "；回退没做全（" + String(r.rollback.why ?? r.rollback.phase) + "，门与账保留，看 --status）") : "") + (rows.length ? "；且" + rows.join("；且") + "—— 只人工核对" : "") + "\n旁路指示：先看 --status。");
    return code;
  }
  if (r.phase === "done" && r.activeCleared === true) {
    out("owner_select 迁移 " + label + " 完成：" + (DONE_BY_KIND[kind] ?? "") + "，重开 done、active 已清" + (rows.length ? "；但" + rows.join("；且") + "—— 人工核对" : ""));
    return code;
  }
  out("owner_select 迁移 " + label + " 没做完：阶段 " + String(r.phase) + (r.incomplete?.length ? "\n" + r.incomplete.map((i) => "  · " + i.id + "：" + i.why).join("\n") : "") + (rows.length ? "\n且" + rows.join("\n且") : "") + "\n门与账保留（forward-only 只向前），处置后再跑 --status。");
  return code;
}

if (isDirectRun(import.meta.url)) process.exit(runMaintenanceOwnerSelect(process.argv.slice(2)));
