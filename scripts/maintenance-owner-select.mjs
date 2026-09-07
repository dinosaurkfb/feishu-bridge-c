// R52 §三 CLI：owner_select 迁移 A 维护编排（--status / --migrate-a [--wait-ms N] [--apply]）。
//   参数封闭；默认只预览（零改动）；--apply 是安装类授权（本单测试永不在真机跑）。退出码 0/1/3 同 maintenance-ledger。
import { maintenanceContext } from "./maintenance/operation.mjs";
import { readActive, readJournal, acquireOperationLease, releaseOperationLease } from "./maintenance/journal.mjs";
import { readCampaignState, readWriterState } from "./maintenance/owner-select-state.mjs";
import { maintenanceDir } from "./maintenance/journal.mjs";
import { maintenanceGatePath } from "./maintenance-gate-core.mjs";
import { frozenEndpoints, osmEnter, osmPreForwardPlanMatrix, osmEnterForward, osmForward, osmReopening, osmExit } from "./maintenance/owner-select-operation.mjs";
import { loadLedger, resolveEndpointDir, migrationInventory } from "./topic-agent-ledger.mjs";
import { isDirectRun } from "./direct-run.mjs";

const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;

/** 参数封闭：--status | --migrate-a [--wait-ms N] [--apply]；每 flag 至多一次；--status 不带别的。 */
export function parseMaintenanceOwnerSelectArgs(argv) {
  let mode = null, waitMs = 60000, apply = false;
  const seen = new Set();
  const once = (flag) => { if (seen.has(flag)) return false; seen.add(flag); return true; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status" || a === "--migrate-a") { if (mode !== null) return { ok: false, reason: "只能给一个动作" }; mode = a.slice(2); continue; }
    if (a === "--wait-ms") { if (!once(a)) return { ok: false, reason: "--wait-ms 重复" }; const raw = argv[i + 1]; const v = Number(raw); if (typeof raw !== "string" || !/^\d+$/u.test(raw) || !Number.isSafeInteger(v) || v > 3600000) return { ok: false, reason: "--wait-ms 要是 0–3600000 的整数" }; waitMs = v; i += 1; continue; }
    if (a === "--apply") { if (!once(a)) return { ok: false, reason: "--apply 重复" }; apply = true; continue; }
    return { ok: false, reason: "不认识的参数：" + a };
  }
  if (mode === null) return { ok: false, reason: "要给 --status / --migrate-a 之一" };
  if (mode === "status" && seen.size > 0) return { ok: false, reason: "--status 不带别的参数" };
  return { ok: true, mode, waitMs, apply };
}

function buildCtx(env) {
  return maintenanceContext({
    home: env.HOME ?? process.env.HOME,
    dir: maintenanceDir(env),
    gateFile: maintenanceGatePath(env),
    now: Date.now,
  });
}

/** 只读状态：冻结集 / 每 ep 当前 schema+revision+null-B1 / campaign / writer 状态 / 活动 operation+phase。 */
export function osmStatus(ctx, { env = process.env } = {}) {
  const active = readActive({ dir: ctx.dir });
  const lines = ["owner_select 迁移 A 状态（只读）", ""];
  let frozen = [];
  const frz = frozenEndpoints(ctx.dir);
  if (frz.ok) frozen = frz.endpoints;
  lines.push("冻结集（有效 init 收据）：" + (frozen.length === 0 ? "（无）" : frozen.join(", ")));
  for (const ep of frozen) {
    const d = resolveEndpointDir(ep, { env });
    if (!d.ok) { lines.push("  · " + ep + "：账本根定位失败（" + d.reason + "）"); continue; }
    const L = loadLedger(d.dir, { endpointId: ep });
    lines.push("  · " + ep + "：schema " + (L.ok ? L.doc.schema_version : "?" ) + "，revision " + (L.ok ? L.doc.revision : "?") + "，null-B1 " + (L.ok ? migrationInventory(L.doc).null_b1_count : "?"));
  }
  const camp = readCampaignState(env); lines.push("campaign：state " + camp.state + (camp.exists ? "（id " + String(camp.campaign_id ?? "?").slice(0, 8) + "）" : ""));
  const ws = readWriterState(env); lines.push("writer-state：state " + ws.state + (ws.exists ? "（id " + String(ws.campaign_id ?? "?").slice(0, 8) + "）" : ""));
  if (active.state === "active") {
    const j = readJournal({ dir: ctx.dir, token: active.token });
    lines.push("操作：token " + active.token.slice(0, 8) + "，阶段 " + (j.state === "valid" ? j.doc.phase + "（" + j.doc.operation_kind + "）" : j.state + (j.why ? "（" + j.why + "）" : "")));
    if (j.state === "valid") { const undone = j.doc.steps.filter((s) => s.state !== "done"); if (undone.length) for (const s of undone) lines.push("  · " + s.id + " " + s.state); }
  } else lines.push("操作：没有");
  return lines.join("\n");
}

/** runMaintenanceOwnerSelect：默认只预览；--apply 走 osmEnter → 前置 → plan 矩阵 → 原子进段 → forward → 重开。 */
export function runMaintenanceOwnerSelect(argv, { ctx = null, out = (s) => process.stdout.write(s + "\n"), env = process.env } = {}) {
  const parsed = parseMaintenanceOwnerSelectArgs(argv);
  if (!parsed.ok) { out("用法：node maintenance-owner-select.mjs --status | --migrate-a [--wait-ms N] [--apply]（" + parsed.reason + "）"); return 1; }
  const self = ctx ?? buildCtx(env);
  if (parsed.mode === "status") { out(osmStatus(self, { env })); return 0; }
  // --migrate-a
  if (!parsed.apply) {
    // 只预览：进门 dry-run（预检），打印计划。零改动。
    const ent = osmEnter(self, { waitMs: parsed.waitMs, apply: false, env });
    out("[预览] " + (ent.ok ? "预检通过：将停两链定时器→current 切维护桩→建门→drained 前置→provision/plan→原子进段→forward 收敛→重开。加 --apply 执行。" : "预检不过（" + String(ent.reason ?? "") + (ent.why ? "：" + ent.why : "") + "）"));
    return ent.ok ? 0 : 1;
  }
  // --apply
  const ent = osmEnter(self, { waitMs: parsed.waitMs, apply: true, env });
  if (!ent.ok || !ent.token) { out("进入失败：" + String(ent.reason ?? "") + (ent.why ? "：" + ent.why : "") + "（未动）"); return 1; }
  let lease = acquireOperationLease({ dir: self.dir, token: ent.token });
  if (!lease.ok) { out("取执行租约失败：" + String(lease.reason ?? "")); return 3; }
  try {
    const r = osmPreForwardPlanMatrix(self, { token: ent.token, lease, env });
    if (!r.ok) { out("pre-forward 矩阵失败（" + String(r.reason ?? "") + (r.why ? "：" + r.why : "") + "）—— 留在 drained，回退后重置"); return exitCodeFor(r); }
    const a = osmEnterForward(self, { token: ent.token, lease, env });
    if (!a.ok) { out("原子进段失败（" + String(a.reason ?? "") + (a.why ? "：" + a.why : "") + "）"); return exitCodeFor(a); }
    const f = osmForward(self, { token: ent.token, lease, env });
    if (!f.ok) { out("forward 收敛失败（" + String(f.reason ?? "") + (f.why ? "：" + f.why : "") + "）—— 门与 active 保留，--exit --apply 只向前续跑"); return exitCodeFor(f); }
    const re = osmReopening(self, { token: ent.token, lease, env });
    out("迁移 A 完成：" + (re.ok ? "phase done、active 清" : "重开未做全（" + String(re.reason ?? "") + "）"));
    return exitCodeFor(re);
  } finally { releaseOperationLease(lease); }
}

export function exitCodeFor(r) {
  if (r.ok) return 0;
  if (r.reason === "reopening_incomplete" || r.phase === "reopening_incomplete") return 3;
  if (r.reason === "not_drained" || r.reason === "not_forwarding" || r.phase === "osm_a_upgrading") return 3;
  if (r.rollbackSafe === true && r.phase === "drained") return 1; // 干净拒绝（前置失败留在 drained，未动现场）
  return 1;
}

// --exit 分派：maintenance-gate --exit 按 operation_kind 分派到 osmExit（本 CLI 封装）。
export function exitOwnerSelect(ctx, { apply = false, env = process.env } = {}) { return osmExit(ctx, { apply, env }); }

if (isDirectRun(import.meta.url)) process.exit(runMaintenanceOwnerSelect(process.argv.slice(2)));
