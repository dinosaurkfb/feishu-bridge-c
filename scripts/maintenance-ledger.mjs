/**
 * 账本维护命令面（M1 第 2 块 stage4；design `docs/architecture/maintenance-gate.md` C 节）。
 *
 *   node scripts/maintenance-ledger.mjs --status                                                只读：活动账本 operation + B-3 endpoint 收据投影
 *   node scripts/maintenance-ledger.mjs --init    --endpoint <id> [--wait-ms N] [--apply]        账本初始化（shadow，revision=1）
 *   node scripts/maintenance-ledger.mjs --cutover --endpoint <id> [--wait-ms N] [--apply]        账本切权威（shadow→authoritative）
 *
 * --init / --cutover 默认只预览（预检 + 计划，零改动），--apply 才动；都是**安装类授权**（Frank 逐次授权）。
 * 不提供 --force / --kill；`--exit` 不在本单（沿用 maintenance-gate --exit 按 operation_kind 分派，R16 已接）。
 * 退出码：0 = 完成 / 预览；1 = 参数或拒绝（预检不过、有 operation、门在、收据 fail-closed）；3 = 动了但没做完
 * （reopening_incomplete / 租约或安装面锁交不还）。编排入口是 `ledger-operation.mjs` 的 `ledgerEnter`，
 * 本模块只包参数与返回码，不自造第二套编排；安装面锁由 `ledgerEnter` 在预检与 createOperation 之前取、持有到
 * reopening 与租约释放完成（L5b），本模块通过其对账后压退出码 3。
 */
import path from "node:path";

import { isDirectRun, moduleDir } from "./direct-run.mjs";
import { maintenanceContext, renderStatus, maintenanceStatus } from "./maintenance/operation.mjs";
import { readActive, readJournal } from "./maintenance/journal.mjs";
import { aggregateEndpointReceipts, endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import * as LEDGER_OP from "./maintenance/ledger-operation.mjs";
import { loadByEndpoint } from "./topic-agent-ledger.mjs";

const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
const LEDGER_KINDS = Object.freeze(["init", "cutover"]);

/** 参数封闭：每个 flag 至多一次；--status 不带别的；--init/--cutover 必须 --endpoint，可选 --wait-ms / --apply。 */
export function parseMaintenanceLedgerArgs(argv) {
  let mode = null, endpoint = null, waitMs = 60000, apply = false;
  const seen = new Set();
  const once = (flag) => { if (seen.has(flag)) return false; seen.add(flag); return true; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status" || a === "--init" || a === "--cutover") { if (mode !== null) return { ok: false, reason: "只能给一个动作" }; mode = a.slice(2); continue; }
    if (a === "--endpoint") { if (!once(a)) return { ok: false, reason: "--endpoint 重复" }; const v = argv[i + 1]; if (typeof v !== "string" || !ENDPOINT_SHAPE.test(v)) return { ok: false, reason: "--endpoint 要是 endpoint_<24hex>" }; endpoint = v; i += 1; continue; }
    if (a === "--wait-ms") { if (!once(a)) return { ok: false, reason: "--wait-ms 重复" }; const raw = argv[i + 1]; const v = Number(raw); if (typeof raw !== "string" || !/^\d+$/u.test(raw) || !Number.isSafeInteger(v) || v > 3600000) return { ok: false, reason: "--wait-ms 要是 0–3600000 的整数" }; waitMs = v; i += 1; continue; }
    if (a === "--apply") { if (!once(a)) return { ok: false, reason: "--apply 重复" }; apply = true; continue; }
    return { ok: false, reason: "不认识的参数：" + a };
  }
  if (mode === null) return { ok: false, reason: "要给 --status / --init / --cutover 之一" };
  if (mode === "status" && seen.size > 0) return { ok: false, reason: "--status 不带别的参数" };
  if (mode === "init" || mode === "cutover") {
    if (endpoint === null) return { ok: false, reason: "--" + mode + " 需要 --endpoint" };
    if (seen.has("--endpoint") && !ENDPOINT_SHAPE.test(endpoint)) return { ok: false, reason: "--endpoint 形状不对" };
  }
  return { ok: true, mode, endpoint, waitMs, apply };
}

/** 单 endpoint 的 chain：有既有账本用它，否则默认 claude（本机维护 CLI 一处保持一致；ponytail: 若 endpoint 可跨链需真实映射）。 */
function resolveChain(endpointId, { env }) {
  const L = loadByEndpoint(endpointId, { env });
  if (L.ok && (L.doc.chain === "claude" || L.doc.chain === "codex")) return L.doc.chain;
  return "claude";
}

/** 只读状态：活动账本 operation + B-3 endpoint 收据投影。 */
export function ledgerStatus(ctx, { env = process.env } = {}) {
  const active = readActive({ dir: ctx.dir });
  let activeOp = null;
  if (active.state === "active") {
    const j = readJournal({ dir: ctx.dir, token: active.token });
    if (j.state === "valid" && (j.doc.operation_kind === "ledger_init" || j.doc.operation_kind === "ledger_cutover")) {
      const ls = j.doc.steps.find((s) => s.kind === "ledger");
      activeOp = { token: active.token, kind: j.doc.operation_kind, phase: j.doc.phase, endpointId: ls?.target ?? null };
    }
  }
  const receipts = aggregateEndpointReceipts({ dir: ctx.dir });
  return { activeOp, receipts, dir: ctx.dir };
}

export function renderLedgerStatus(st) {
  const parts = [];
  if (st.activeOp) parts.push("活动账本 operation：token " + String(st.activeOp.token).slice(0, 8) + "，" + st.activeOp.kind + "，阶段 " + st.activeOp.phase + (st.activeOp.endpointId ? "，" + st.activeOp.endpointId : ""));
  else parts.push("没有活动账本 operation");
  if (!st.receipts.ok) parts.push("⚠ 收据项目 fail-closed：" + (st.receipts.why ?? "读不出"));
  const eps = st.receipts.endpoints;
  if (eps.length === 0) parts.push("B-3 收据：无任何 endpoint 收据");
  else parts.push("B-3 收据：" + eps.map((e) => e.endpointId + "=" + e.state + (e.initDone ? "（init）" : "") + (e.cutoverDone ? "（cutover）" : "")).join("、"));
  return parts.map((p) => "  " + p).join("\n");
}

const fmtFail = (r) => String(r.reason) + (r.why ? "：" + r.why : "") + (r.path ? "，" + r.path : "");

export function runMaintenanceLedger(argv, { ctx = null, out = (s) => process.stdout.write(s + "\n"), env = process.env } = {}) {
  const parsed = parseMaintenanceLedgerArgs(argv);
  if (!parsed.ok) { out("用法：node maintenance-ledger.mjs --status | --init --endpoint <id> [--wait-ms N] [--apply] | --cutover --endpoint <id> [--wait-ms N] [--apply]（" + parsed.reason + "）"); return 1; }
  const c = ctx ?? maintenanceContext({ repoRoot: path.dirname(moduleDir(import.meta.url)) });
  if (parsed.mode === "status") {
    out(renderStatus(maintenanceStatus(c)));
    out(renderLedgerStatus(ledgerStatus(c, { env })));
    return 0;
  }
  const kind = parsed.mode; // init | cutover
  // 前置收据检查：重复 / 读不出 / 已初始化 / 已切权威 → 干净拒绝（exit 1），一次都不碰状态（不留下 forward-only 门）。
  const receipt = endpointReceipt(c.dir, parsed.endpoint);
  if (!receipt.ok) { out("账本 " + kind + " 拒：收据 fail-closed：" + receipt.why + "（什么都不动）"); return 1; }
  if (kind === "init" && (receipt.initDone || receipt.cutoverDone)) { out("账本 init 拒：该 endpoint 已初始化或已切权威，不能重新 init（什么都不动）"); return 1; }
  if (kind === "cutover" && receipt.cutoverDone) { out("账本 cutover 拒：该 endpoint 已切权威，不能重复切（什么都不动）"); return 1; }
  const chain = resolveChain(parsed.endpoint, { env });
  const r = LEDGER_OP.ledgerEnter(c, { kind, endpointId: parsed.endpoint, chain, waitMs: parsed.waitMs, apply: parsed.apply, env });
  if (r.dryRun) {
    const verb = kind === "init" ? "init→shadow revision1" : "cutover→authoritative";
    out("[预览] 预检通过，账本 " + verb + "（" + parsed.endpoint + "）：停两链定时器 → 两链 current 切维护桩 → 建门 → 等既有进程退出最多 " + (r.plan?.waitMs ?? parsed.waitMs) + " ms → 门内写账本。加 --apply 执行。");
    return 0;
  }
  // 动了没做完 / 释放失败 → 3
  const releaseIssue = r.leaseRelease ?? r.surfaceRelease ?? null;
  const code = exitCodeFor(r);

  if (!r.ok) {
    if (r.reason === "startup_source_unverified") { out("拒绝进门（startup_source_unverified）：启动源与当前投影对不上，什么都没动\n" + fmtItems(r.items)); return 1; }
    out("账本 " + kind + " 没做成（" + fmtFail(r) + "）" + (r.rollback ? (r.rollback.ok ? "；已按账回退还清" : "；回退没做全（" + String(r.rollback.why ?? r.rollback.phase) + "，门与账保留，看 --status）") : "") + (releaseIssue ? "；且" + (r.leaseRelease ? "租约交不还" : "安装面锁交不还") + "—— 只人工核对：" + releaseIssue.path : "") + "\n旁路指示：先看 --status。");
    return code;
  }
  if (r.phase === "done" && r.activeCleared === true) {
    out("已做账本 " + kind + "：阶段 " + r.phase + "，active 已清" + (releaseIssue ? "；但" + (r.leaseRelease ? "租约交不还" : "安装面锁交不还") + "：" + releaseIssue.path + "—— 人工核对" : ""));
    return code;
  }
  out("账本 " + kind + " 没做完：阶段 " + String(r.phase) + (r.activeCleared === false ? "（active 未清）" : "") + (r.incomplete?.length ? "\n" + r.incomplete.map((i) => "  · " + i.id + "：" + i.why).join("\n") : "") + (releaseIssue ? "\n且" + (r.leaseRelease ? "租约交不还" : "安装面锁交不还") + "：" + releaseIssue.path : "") + "\n门与账保留，处置后再跑 --status 看只向前续跑。");
  return code;
}

export function exitCodeFor(r) {
  if (r.leaseRelease ?? r.surfaceRelease ?? null) return 3;
  if (r.ok) return 0;
  if (r.rollback && r.rollback.ok === true) return 1; // 回退清干净 → 干净拒绝（预检不过：reconciler_absent / gate_* / operation_active）
  if (r.rollback && r.rollback.ok === false) return 3; // 回退没做全：动了没做完
  if (FORWARD_PHASES.includes(r.phase)) return 3; // 卡在 forward-only（动了但没做完：门拆了 / current 切了没恢复）
  if (r.phase === "reopening_incomplete" || r.reason === "reopening_incomplete") return 3;
  if (r.reason === "startup_source_unverified") return 1; // 进门就被拒，什么都没动
  return 1;
}

const FORWARD_PHASES = ["drained", "ledger_initializing", "ledger_cutting_over", "ledger_reopening"];

const fmtItems = (items) => items.map((i) => "  ✗ " + i.id + "：" + i.why).join("\n");

if (isDirectRun(import.meta.url)) process.exit(runMaintenanceLedger(process.argv.slice(2)));
