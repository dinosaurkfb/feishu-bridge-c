/**
 * 维护门命令面（issue #81 PR C）：
 *
 *   node scripts/maintenance-gate.mjs --status                              只读：门 / operation / 两链 current 与桩 / 定时器三态
 *   node scripts/maintenance-gate.mjs --enter --reason "<≤80 码点>" [--wait-ms 60000] [--apply]
 *   node scripts/maintenance-gate.mjs --exit [--apply]                      未到不可逆阶段：按 journal CAS 回退；已到：只向前继续
 *
 * --enter / --exit 默认只预览（预检 + 计划），--apply 才动；两者都是安装类授权（Frank 逐次授权）。不提供 --force / --kill。
 * 退出码：0 = 完成 / 预览；1 = 参数或拒绝（预检不过、有 operation、门在）；3 = 动了但没做完（rollback_incomplete —— 门与账保留，看 --status）。
 */
import path from "node:path";

import { isDirectRun, moduleDir } from "./direct-run.mjs";
import { enterMaintenance, exitMaintenance, maintenanceContext, maintenanceStatus, renderStatus } from "./maintenance/operation.mjs";

export function parseMaintenanceGateArgs(argv) {
  let mode = null, reason = null, waitMs = 60000, apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status" || a === "--enter" || a === "--exit") { if (mode !== null) return { ok: false, reason: "只能给一个动作" }; mode = a.slice(2); continue; }
    if (a === "--apply") { apply = true; continue; }
    if (a === "--reason") { const v = argv[i + 1]; if (typeof v !== "string" || v.startsWith("--")) return { ok: false, reason: "--reason 后面要跟原因" }; reason = v; i += 1; continue; }
    if (a === "--wait-ms") { const v = Number(argv[i + 1]); if (!Number.isSafeInteger(v) || v < 0 || v > 3600000) return { ok: false, reason: "--wait-ms 要是 0–3600000 的整数" }; waitMs = v; i += 1; continue; }
    return { ok: false, reason: "不认识的参数：" + a };
  }
  if (mode === null) return { ok: false, reason: "要给 --status / --enter / --exit 之一" };
  if (mode === "enter" && (reason === null || reason.trim().length === 0)) return { ok: false, reason: "--enter 需要 --reason" };
  return { ok: true, mode, reason, waitMs, apply };
}

const fmtItems = (items) => items.map((i) => "  ✗ " + i.id + "：" + i.why).join("\n");

export function runMaintenanceGate(argv, { ctx = null, out = (s) => process.stdout.write(s + "\n") } = {}) {
  const parsed = parseMaintenanceGateArgs(argv);
  if (!parsed.ok) { out("用法：node maintenance-gate.mjs --status | --enter --reason <r> [--wait-ms N] [--apply] | --exit [--apply]（" + parsed.reason + "）"); return 1; }
  const c = ctx ?? maintenanceContext({ repoRoot: path.dirname(moduleDir(import.meta.url)) });
  if (parsed.mode === "status") { out(renderStatus(maintenanceStatus(c))); return 0; }
  if (parsed.mode === "enter") {
    const r = enterMaintenance(c, { reason: parsed.reason, waitMs: parsed.waitMs, apply: parsed.apply });
    if (!r.ok) {
      if (r.reason === "startup_source_unverified") { out("拒绝进门（startup_source_unverified）：启动源与当前投影对不上，什么都没动\n" + fmtItems(r.items)); return 1; }
      if (r.rollback) { out("进门失败（" + r.reason + "：" + r.why + "），已按账回退：" + (r.rollback.ok ? r.rollback.phase : "**" + String(r.rollback.phase ?? r.rollback.reason) + "** —— 门与账保留，看 --status") + (r.processes ? "\n残留进程：" + r.processes.map((p) => p.pid + " " + p.command).join("\n") : "")); return r.rollback.ok ? 1 : 3; }
      out("拒绝进门（" + r.reason + (r.why ? "：" + r.why : "") + "）"); return 1;
    }
    if (r.dryRun) { out("[预览] 预检通过，进门会：停两链定时器（" + r.plan.chains.claude.timer + " / " + r.plan.chains.codex.timer + "）→ 两链 current 切到维护桩（" + r.plan.chains.claude.entries.length + " + " + r.plan.chains.codex.entries.length + " 个入口）→ 建门（" + r.plan.reason + "）→ 等既有进程退出最多 " + r.plan.waitMs + " ms。加 --apply 执行。"); return 0; }
    out("已进门：token " + r.token.slice(0, 8) + "，阶段 " + r.phase + "。出门：--exit --apply"); return 0;
  }
  const r = exitMaintenance(c, { apply: parsed.apply });
  if (!r.ok && r.dryRun !== true && !r.phase) { out("出门做不了（" + r.reason + (r.why ? "：" + r.why : "") + "）"); return 1; }
  if (r.dryRun) { out("[预览] operation " + r.token.slice(0, 8) + " 阶段 " + r.phase + " → 动作：" + r.action + "。加 --apply 执行。"); return 0; }
  if (r.ok) { out("已出门：阶段 " + r.phase + (r.activeCleared ? "，active 已清" : "，active 未清（" + String(r.activeWhy ?? r.why ?? "") + "）")); return 0; }
  out("出门没做完：阶段 " + String(r.phase) + "\n" + (r.incomplete ?? []).map((i) => "  · " + i.id + "：" + i.why).join("\n") + "\n门与账保留，处置后再跑 --exit --apply 只向前继续。"); return 3;
}

if (isDirectRun(import.meta.url)) process.exit(runMaintenanceGate(process.argv.slice(2)));
