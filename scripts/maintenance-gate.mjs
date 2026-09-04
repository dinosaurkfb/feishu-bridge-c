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
import { acquireInstallSurfaceLock } from "./install-surface-lock.mjs";
import { enterMaintenance, exitMaintenance, maintenanceContext, maintenanceStatus, renderStatus } from "./maintenance/operation.mjs";

/** 参数封闭：每个 flag 至多一次；--status 不带任何别的；--exit 只许 --apply；--enter 必须 --reason，可选 --wait-ms / --apply。 */
export function parseMaintenanceGateArgs(argv) {
  let mode = null, reason = null, waitMs = 60000, apply = false;
  const seen = new Set();
  const once = (flag) => { if (seen.has(flag)) return false; seen.add(flag); return true; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status" || a === "--enter" || a === "--exit") { if (mode !== null) return { ok: false, reason: "只能给一个动作" }; mode = a.slice(2); continue; }
    if (a === "--apply") { if (!once(a)) return { ok: false, reason: "--apply 重复" }; apply = true; continue; }
    if (a === "--reason") { if (!once(a)) return { ok: false, reason: "--reason 重复" }; const v = argv[i + 1]; if (typeof v !== "string" || v.startsWith("--")) return { ok: false, reason: "--reason 后面要跟原因" }; reason = v; i += 1; continue; }
    if (a === "--wait-ms") { if (!once(a)) return { ok: false, reason: "--wait-ms 重复" }; const raw = argv[i + 1]; const v = Number(raw); if (typeof raw !== "string" || !/^\d+$/u.test(raw) || !Number.isSafeInteger(v) || v > 3600000) return { ok: false, reason: "--wait-ms 要是 0–3600000 的整数" }; waitMs = v; i += 1; continue; }
    return { ok: false, reason: "不认识的参数：" + a };
  }
  if (mode === null) return { ok: false, reason: "要给 --status / --enter / --exit 之一" };
  if (mode === "status" && seen.size > 0) return { ok: false, reason: "--status 不带别的参数" };
  if (mode === "exit" && (seen.has("--reason") || seen.has("--wait-ms"))) return { ok: false, reason: "--exit 只许 --apply" };
  if (mode === "enter" && (reason === null || reason.trim().length === 0)) return { ok: false, reason: "--enter 需要 --reason" };
  return { ok: true, mode, reason, waitMs, apply };
}

const fmtItems = (items) => items.map((i) => "  ✗ " + i.id + "：" + i.why).join("\n");

export function runMaintenanceGate(argv, { ctx = null, out = (s) => process.stdout.write(s + "\n") } = {}) {
  const parsed = parseMaintenanceGateArgs(argv);
  if (!parsed.ok) { out("用法：node maintenance-gate.mjs --status | --enter --reason <r> [--wait-ms N] [--apply] | --exit [--apply]（" + parsed.reason + "）"); return 1; }
  const c = ctx ?? maintenanceContext({ repoRoot: path.dirname(moduleDir(import.meta.url)) });
  if (parsed.mode === "status") { out(renderStatus(maintenanceStatus(c))); return 0; }
  // 安装面锁（评审返修 2）：与三个普通安装器共用一把 —— enter / exit 的 --apply 都是安装面写方，
  // 在做任何事之前取锁、持有到本次动作结束；拿不到就什么都不动（busy → 1，残骸 → 3）。
  let surface = null;
  if (parsed.apply) {
    surface = acquireInstallSurfaceLock({ home: c.home });
    if (!surface.ok) { out("安装面锁拿不到（" + surface.reason + "：" + String(surface.why) + "，" + surface.path + "）—— 什么都没动。"); return surface.reason === "surface_install_busy" ? 1 : 3; }
  }
  let code;
  try { code = runMaintenanceGateLocked(parsed, c, out, surface); }
  finally {
    if (surface !== null) {
      const rel = surface.release();
      // 释放失败不许报成功（评审探针：.reap 删除 EIO 时曾保留原返回码）：点名残骸并把整次结果压成 3
      if (!rel.ok) { out("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）。"); code = 3; }
    }
  }
  return code;
}

function runMaintenanceGateLocked(parsed, c, out, surface) {
  if (parsed.mode === "enter") {
    const r = enterMaintenance(c, { reason: parsed.reason, waitMs: parsed.waitMs, apply: parsed.apply });
    const residue = r.leaseUncleared ? "\n租约交不还：" + r.leaseUncleared.path + "（" + r.leaseUncleared.why + "）—— 下一个执行者会按 pid 活性接管；请人工核对" : "";
    if (!r.ok) {
      if (r.reason === "startup_source_unverified") { out("拒绝进门（startup_source_unverified）：启动源与当前投影对不上，什么都没动\n" + fmtItems(r.items)); return 1; }
      if (r.rollback) { const rb = r.rollback; out("进门失败（" + r.reason + "：" + r.why + "），已按账回退：" + (rb.ok && rb.activeCleared ? rb.phase : "**" + String(rb.phase ?? rb.reason) + "** —— 门与账保留，看 --status") + (r.processes ? "\n残留进程：" + r.processes.map((p) => p.pid + " " + p.command).join("\n") : "") + (rb.incomplete ? "\n" + rb.incomplete.map((i) => "  · " + i.id + "：" + i.why).join("\n") : "") + residue); return rb.ok && rb.activeCleared && !r.leaseUncleared ? 1 : 3; }
      if (r.reason === "lease_reap_uncleared") { out("进门中途停下（租约的归属转换锁交不还：" + String(r.path) + "）—— 什么都没再动，operation 保留（阶段见 --status）；清掉该残骸后跑 --exit --apply 按账回退" + residue); return 3; }
      if (r.leaseUncleared) { out("进门做完了但租约交不还" + residue); return 3; }
      out("拒绝进门（" + r.reason + (r.why ? "：" + r.why : "") + (r.path ? "，" + r.path : "") + "）"); return 1;
    }
    if (r.dryRun) { out("[预览] 预检通过，进门会：停两链定时器（" + r.plan.chains.claude.timer + " / " + r.plan.chains.codex.timer + "）→ 两链 current 切到维护桩（" + r.plan.chains.claude.entries.length + " + " + r.plan.chains.codex.entries.length + " 个入口）→ 建门（" + r.plan.reason + "）→ 等既有进程退出最多 " + r.plan.waitMs + " ms。加 --apply 执行。"); return 0; }
    out("已进门：token " + r.token.slice(0, 8) + "，阶段 " + r.phase + "。出门：--exit --apply"); return 0;
  }
  const r = exitMaintenance(c, { apply: parsed.apply, surface });
  if (r.dryRun) { out("[预览] operation " + r.token.slice(0, 8) + " 阶段 " + r.phase + " → 动作：" + r.action + (r.executor ? "（执行者 pid " + r.executor + " 正在跑，此刻 --apply 会被拒）" : "") + "。加 --apply 执行。"); return 0; }
  if (!r.ok && !r.phase && r.reason === "journal_write_failed" && /lease_reap_uncleared/u.test(String(r.why))) { out("出门中途停下（租约的归属转换锁交不还）—— operation 保留，清掉残骸后再跑 --exit --apply" + (r.why ? "：" + r.why : "")); return 3; }
  if (!r.ok && !r.phase) { out("出门做不了（" + r.reason + (r.why ? "：" + r.why : "") + (r.path ? "，" + r.path : "") + "）"); return 1; }
  const residue = r.leaseUncleared ? "\n租约交不还：" + r.leaseUncleared.path + "（" + r.leaseUncleared.why + "）—— 请人工核对" : "";
  if (r.ok && r.activeCleared && !r.leaseUncleared) { out("已出门：阶段 " + r.phase + "，active 已清"); return 0; }
  out("出门没做完：阶段 " + String(r.phase) + (r.activeCleared === false ? "（active 未清" + (r.activeWhy ? "：" + r.activeWhy : "") + "）" : "") + "\n" + (r.incomplete ?? []).map((i) => "  · " + i.id + "：" + i.why).join("\n") + residue + "\n门与账保留，处置后再跑 --exit --apply 只向前继续。"); return 3;
}

if (isDirectRun(import.meta.url)) process.exit(runMaintenanceGate(process.argv.slice(2)));
