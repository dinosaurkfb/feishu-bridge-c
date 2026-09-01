/**
 * 维护安装命令面（issue #81 PR C 第 2 步，方案稿 §105）：
 *
 *   node scripts/maintenance-install.mjs [--reason "<≤80 码点>"] [--wait-ms 60000] [--apply]
 *
 * --apply = enter（预检 → 停定时器 → 切桩 → 建门 → 等进程）→ stage → verify staged → commit → verify live → reopening。
 * 默认只预览（预检 + 版本 + 目标投影，什么都不写）。--apply 是**安装类授权**（Frank 逐次授权）。没有单独的 stage / commit CLI。
 * 1–4 任一步失败按 journal 回退到进门前（versions/<v>/ 保留可重用）；回退说不清 → 门与账保留，退出码 3，之后 maintenance-gate --exit --apply 续做。
 * 退出码：0 = 完成 / 预览；1 = 参数或拒绝（预检不过等，零改动）或失败但已完整回退；3 = 动了但没做完（门与账保留，看 --status）。
 */
import path from "node:path";

import { isDirectRun, moduleDir } from "./direct-run.mjs";
import { acquireInstallSurfaceLock } from "./install-surface-lock.mjs";
import { planRuntimeSync } from "./runtime-install.mjs";
import { enterMaintenance, maintenanceContext, rollbackOperation } from "./maintenance/operation.mjs";
import { releaseOperationLease } from "./maintenance/journal.mjs";
import { commitForInstall, finishInstallReopening, liveBaseline, stageForInstall, verifyLiveForInstall, verifyStagedForInstall } from "./maintenance/maintenance-install-core.mjs";
import { renderArtifacts } from "./maintenance/render-artifacts.mjs";

/** 参数封闭：flag 至多一次；只认 --apply / --reason <r> / --wait-ms N。 */
export function parseMaintenanceInstallArgs(argv) {
  let reason = null, waitMs = 60000, apply = false;
  const seen = new Set();
  const once = (flag) => { if (seen.has(flag)) return false; seen.add(flag); return true; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { if (!once(a)) return { ok: false, reason: "--apply 重复" }; apply = true; continue; }
    if (a === "--reason") { if (!once(a)) return { ok: false, reason: "--reason 重复" }; const v = argv[i + 1]; if (typeof v !== "string" || v.startsWith("--")) return { ok: false, reason: "--reason 后面要跟原因" }; reason = v; i += 1; continue; }
    if (a === "--wait-ms") { if (!once(a)) return { ok: false, reason: "--wait-ms 重复" }; const raw = argv[i + 1]; const v = Number(raw); if (typeof raw !== "string" || !/^\d+$/u.test(raw) || !Number.isSafeInteger(v) || v > 3600000) return { ok: false, reason: "--wait-ms 要是 0–3600000 的整数" }; waitMs = v; i += 1; continue; }
    return { ok: false, reason: "不认识的参数：" + a };
  }
  return { ok: true, reason, waitMs, apply };
}

const fmtItems = (items) => (items ?? []).map((i) => "  ✗ " + (i.id ?? "") + (i.id ? "：" : "") + (i.why ?? i)).join("\n");
const fmtFail = (r) => String(r.reason) + (r.chain ? "（" + r.chain + "）" : "") + (r.why ? "：" + r.why : "") + (r.path ? "，" + r.path : "") + (r.items ? "\n" + fmtItems(r.items) : "");

export function runMaintenanceInstall(argv, { ctx = null, out = (s) => process.stdout.write(s + "\n") } = {}) {
  const parsed = parseMaintenanceInstallArgs(argv);
  if (!parsed.ok) { out("用法：node maintenance-install.mjs [--reason <r>] [--wait-ms N] [--apply]（" + parsed.reason + "）"); return 1; }
  const c = ctx ?? maintenanceContext({ repoRoot: path.dirname(moduleDir(import.meta.url)) });
  const sourceRoot = c.repoRoot;
  const plan = planRuntimeSync({ sourceRoot, home: c.home, chain: "claude" });
  if (!plan.ok) { out("版本算不出来（" + String(plan.reason) + (plan.file ? "：" + plan.file : "") + "），什么都没动"); return 1; }
  const version = plan.version;
  const reason = parsed.reason ?? "安装 " + version.slice(0, 8);

  if (!parsed.apply) {
    const dry = enterMaintenance(c, { reason, waitMs: parsed.waitMs, apply: false });
    if (!dry.ok) {
      if (dry.reason === "startup_source_unverified") { out("拒绝进门（startup_source_unverified）：启动源与当前投影对不上，什么都没动\n" + fmtItems(dry.items)); return 1; }
      out("拒绝进门（" + fmtFail(dry) + "）"); return 1;
    }
    // 目标投影预览：模板树用源码树（stage 之后会换成 versions/<v>/，内容一致 —— 版本号就是内容寻址的证明）
    const rendered = renderArtifacts({ home: c.home, codexHome: c.codexHome, codexBridgeHome: c.codexBridgeHome, runtimeVersion: version, node: c.node, templates: { claude: sourceRoot, codex: sourceRoot }, base: liveBaseline });
    if (!rendered.ok) { out("目标投影算不出来（" + fmtFail(rendered) + "），什么都没动"); return 1; }
    const changed = rendered.artifacts.filter((a) => !(a.base.exists && a.base.sha256 === a.intendedAfterSha));
    out("[预览] 预检通过。maintenance-install --apply 会：进门（停定时器 " + dry.plan.chains.claude.timer + " / " + dry.plan.chains.codex.timer
      + "，切桩 " + dry.plan.chains.claude.entries.length + " + " + dry.plan.chains.codex.entries.length + " 个入口，建门「" + dry.plan.reason + "」，等进程最多 " + dry.plan.waitMs + " ms）"
      + "→ stage 版本 " + version + " → commit " + rendered.artifacts.length + " 个制品（" + changed.length + " 个会变）+ 两份收据 → verify → 重新开放。");
    for (const a of changed) out("  · 会变：" + a.path);
    out("加 --apply 执行（安装类授权）。");
    return 0;
  }

  // ── 安装面锁（评审返修 2）：与三个普通安装器共用一把，**enter 之前**取、持有到 reopening / 回退与租约释放完成 ——
  // 门检是瞬时的，锁才是原子准入：已过门检的安装器与将要建门的维护流程在这里互斥。
  const surface = acquireInstallSurfaceLock({ home: c.home });
  if (!surface.ok) { out("安装面锁拿不到（" + surface.reason + "：" + String(surface.why) + "，" + surface.path + "）—— 什么都没动。"); return surface.reason === "surface_install_busy" ? 1 : 3; }
  try { return applyUnderSurfaceLock(); }
  finally { const rel = surface.release(); if (!rel.ok) out("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）—— 会被下一个写方按 pid 活性接管，请人工核对。"); }

  function applyUnderSurfaceLock() {
  // ── enter：keepLease —— 从进门到 reopening / 回退结束连续持有同一租约（释放再重取会留出 operation 被换掉的窗口）
  const entered = enterMaintenance(c, { reason, waitMs: parsed.waitMs, apply: true, keepLease: true });
  if (!entered.ok) {
    if (entered.reason === "startup_source_unverified") { out("拒绝进门（startup_source_unverified）：启动源与当前投影对不上，什么都没动\n" + fmtItems(entered.items)); return 1; }
    if (entered.reason === "lease_reap_uncleared") { out("进门中途停下（租约的归属转换锁交不还：" + String(entered.path) + "）—— operation 保留，清掉残骸后跑 maintenance-gate --exit --apply 按账回退"); return 3; }
    if (entered.rollback) { const rb = entered.rollback; out("进门失败（" + entered.reason + "：" + entered.why + "），已按账回退：" + (rb.ok && rb.activeCleared ? rb.phase : "**" + String(rb.phase ?? rb.reason) + "** —— 门与账保留，看 maintenance-gate --status") + (entered.processes ? "\n残留进程：" + entered.processes.map((p) => p.pid + " " + p.command).join("\n") : "")); return rb.ok && rb.activeCleared && !entered.leaseUncleared ? 1 : 3; }
    out("拒绝进门（" + fmtFail(entered) + "）"); return 1;
  }
  const token = entered.token;
  const lease = entered.lease;
  out("已进门：token " + token.slice(0, 8) + "，阶段 " + entered.phase);
  let fail = null, result = null;
  try {
    for (const [label, step] of [
      ["stage", () => stageForInstall(c, { sourceRoot, lease })],
      ["verify staged", () => verifyStagedForInstall(c, { lease })],
      ["commit", () => commitForInstall(c, { lease })],
      ["verify live", () => verifyLiveForInstall(c, { lease })],
    ]) {
      const r = step();
      if (!r.ok) { fail = { label, ...r }; break; }
      out(label + " ✓" + (r.version ? "（" + r.version + "）" : ""));
    }
    if (fail === null) result = finishInstallReopening(c, { lease });
  } catch (err) {
    if (err?.simulatedCrash) { releaseOperationLease(lease); throw err; }
    fail = { label: "install", ok: false, reason: "install_failed", why: String(err?.message ?? err) };
  }
  let code;
  if (fail !== null) {
    if (fail.reason === "lease_reap_uncleared") { out("安装中途停下（租约的归属转换锁交不还：" + String(fail.path) + "）—— 什么都没再动，operation 保留；清掉残骸后跑 maintenance-gate --exit --apply 按账回退"); code = 3; }
    else {
      out(fail.label + " 失败（" + fmtFail(fail) + "），按账回退…");
      const rb = rollbackOperation(c, token, lease);
      if (rb.ok && rb.activeCleared) { out("已回退到进门前（" + rb.phase + "，active 已清）。versions/" + version + "/ 保留可重用。"); code = 1; }
      else { out("回退没做完：阶段 " + String(rb.phase ?? rb.reason) + "\n" + fmtItems(rb.incomplete) + "\n门与账保留，处置后跑 maintenance-gate --exit --apply 只向前继续。"); code = 3; }
    }
  } else if (result.ok && result.activeCleared) { out("已装 " + result.version + " 并重新开放（" + result.phase + "，active 已清）。"); code = 0; }
  else { out("安装写完但重新开放没做完：阶段 " + String(result.phase ?? result.reason) + (result.why ? "（" + result.why + "）" : "") + "\n" + fmtItems(result.incomplete) + "\n门与账保留（线上已是新版本或仍在桩，看 maintenance-gate --status），处置后跑 maintenance-gate --exit --apply 只向前继续。"); code = 3; }
  const rel = releaseOperationLease(lease);
  if (!rel.ok) { out("租约交不还：" + String(rel.path) + "（" + String(rel.why) + "）—— 请人工核对"); return 3; }
  return code;
  }
}

if (isDirectRun(import.meta.url)) process.exit(runMaintenanceInstall(process.argv.slice(2)));
