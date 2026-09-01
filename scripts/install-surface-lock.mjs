/**
 * 机器级**安装面锁**（issue #81 PR C 第 2 步评审返修 2）—— 把"看门 + 写安装面"变成原子准入。
 *
 * 为什么：普通安装器对维护门只做**瞬时**检查（gateBlocks 一次），检查通过到第一笔写之间门可以刚好建立
 * —— 评审探针实测：安装器过检后门变 active，它照样写完 runtime / hooks / 技能 / 收据退出 0；而进门盘点
 * 只认 runtime 路径，抓不到跑在源码检出下的官方安装命令。协议内的修法是让**安装面的每个写方共用一把锁**：
 *
 *   · 三个普通安装器（install-outbound / install-inbound / codex/install）在 `--apply` 分支**看门之前**取锁，
 *     持有到最后一份收据落盘（进程退出时释放；进程挂掉后按 pid 活性被下一个写方接管）；
 *   · maintenance-gate --enter/--exit --apply 与 maintenance-install --apply 在 enter 之前取**同一把**锁，
 *     持有到 reopening / 回退与租约释放完成。
 *
 * 于是"安装器已过门检、维护再建门"与"维护窗口内安装器开写"两个方向都变成锁互斥，不再依赖检查的时机。
 *
 * 原语复用 registry 的锁协议（symlink、reap 段串行化、归属转换）：**staleMs = ∞，只按持有者 pid 活性接管**
 * （维护窗口可以很长，安装也可能分钟级；时间不构成陈旧判据）；未知形状不回收（lock_residue 交人工）。
 * 位置随 **HOME 隔离点**走：`<home>/.claude/feishu-bridge/install-surface.lock` —— 安装器被 HOME 引到沙箱时
 * 锁跟着进沙箱（沙箱安装写的是沙箱面，不该与真机互斥）；只有测试隔离点 FEISHU_BRIDGE_INSTALL_SURFACE_LOCK 能覆盖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireLockUngated, releasePublishLock } from "./registry.mjs";

export const INSTALL_SURFACE_LOCK_ENV = "FEISHU_BRIDGE_INSTALL_SURFACE_LOCK";

export function installSurfaceLockPath({ home = os.homedir(), env = process.env } = {}) {
  const override = env[INSTALL_SURFACE_LOCK_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(home, ".claude", "feishu-bridge", "install-surface.lock");
}

/**
 * 取安装面锁。拿不到一律受控返回：
 *   surface_install_busy（活着的持有者）| lock_residue（未知形状 / reap 家族残骸，点名路径，只人工处置）| io_error。
 * @returns {{ ok:true, path, release: () => {ok,why?,path?} } | { ok:false, reason, why?, path }}
 */
export function acquireInstallSurfaceLock({ home = os.homedir(), env = process.env } = {}) {
  const file = installSurfaceLockPath({ home, env });
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
  catch (err) { return { ok: false, reason: "io_error", why: String(err?.code ?? err?.message ?? err), path: file }; }
  let r;
  try { r = acquireLockUngated(file, { staleMs: Number.POSITIVE_INFINITY, reapUnrecognized: false }); }
  catch (err) { return { ok: false, reason: "io_error", why: "锁原语抛错：" + String(err?.code ?? err?.message ?? err), path: file }; }
  if (r.ok) {
    return {
      ok: true, path: file,
      release: () => {
        try {
          const rel = releasePublishLock(file);
          // .reap 残骸会让后续每个写方 reap_residue：不是"等着被接管"，要 repair-publish-lock 显式清
          if (rel?.reapUncleared) return { ok: false, why: "reap_uncleared：" + String(rel.reapUncleared.error ?? "") + " —— node scripts/repair-publish-lock.mjs --lock " + file + " --apply 能清", path: rel.reapUncleared.path };
          return rel.ok || rel.reason === "not_owner" ? { ok: true } : { ok: false, why: String(rel.reason) + " —— 主锁残骸由下一个写方按 pid 活性接管，但请人工核对", path: file };
        } catch (err) { return { ok: false, why: "release_threw：" + String(err?.code ?? err?.message ?? err), path: file }; }
      },
    };
  }
  if (r.reason === "publisher_busy" || r.reason === "reap_busy") return { ok: false, reason: "surface_install_busy", path: file, why: "另一个安装 / 维护流程正持有安装面锁" };
  return { ok: false, reason: "lock_residue", path: r.path ?? file, why: String(r.reason) + (r.error ? "：" + r.error : "") + "（只人工处置；.reap 家族可用 node scripts/repair-publish-lock.mjs --lock " + file + " --apply）" };
}

/**
 * 安装器脚本（顶层线性代码，多处 exit）用：取锁并挂 exit 钩子释放。释放失败**不许报成功**：
 * 点名残骸并把退出码改成 3（评审探针：.reap 删除 EIO 时进程曾照样退 0）。
 * 拿不到锁 → 打印原因并 exit 2（busy）/ 3（残骸），什么都没写。
 */
export function holdInstallSurfaceLockOrExit({ home = os.homedir(), env = process.env, err = (t) => process.stderr.write(t + "\n") } = {}) {
  const got = acquireInstallSurfaceLock({ home, env });
  if (!got.ok) {
    err("安装面锁拿不到（" + got.reason + "：" + String(got.why) + "，" + got.path + "）—— 什么都没写。" + (got.reason === "surface_install_busy" ? "等它结束再装。" : ""));
    process.exit(got.reason === "surface_install_busy" ? 2 : 3);
  }
  process.on("exit", () => {
    const rel = got.release();
    if (!rel.ok) { err("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）。"); process.exitCode = 3; }
  });
  return got;
}

// ── 只读盘点（--status / doctor 用）：主锁三态 + 锁家族残骸按封闭名字识别，处置方式各不相同 ──────
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/**
 * @returns {{ holder: {state:"absent"}|{state:"held",pid,alive,at}|{state:"unknown",why}, residues: {path,kind,detail}[] }}
 */
export function inspectInstallSurfaceLock({ home = os.homedir(), env = process.env } = {}) {
  const file = installSurfaceLockPath({ home, env });
  const repair = "node scripts/repair-publish-lock.mjs --lock " + file + " --apply 能清";
  const residues = [];
  let holder = { state: "absent" };
  let st = null;
  try { st = fs.lstatSync(file); } catch (err) { if (err?.code !== "ENOENT") holder = { state: "unknown", why: "lstat 失败：" + String(err?.code ?? err?.message) }; }
  if (st !== null) {
    if (!st.isSymbolicLink()) holder = { state: "unknown", why: "锁位置上不是本协议的 symlink —— 只人工处置" };
    else {
      let owner = null;
      try { owner = JSON.parse(fs.readlinkSync(file)); } catch { owner = null; }
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !isCanonicalIso(owner.at ?? "")) holder = { state: "unknown", why: "payload 畸形 —— 只人工处置" };
      else {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch { alive = false; }
        holder = { state: "held", pid: owner.pid, alive, at: owner.at };
      }
    }
  }
  let names = [];
  try { names = fs.readdirSync(path.dirname(file)); } catch { names = []; }
  const base = path.basename(file);
  for (const n of names.sort()) {
    if (n === base || !n.startsWith(base + ".")) continue;
    const full = path.join(path.dirname(file), n);
    const tail = n.slice(base.length);
    if (tail === ".reap" || tail.startsWith(".reap.quarantine-")) { residues.push({ path: full, kind: "reap", detail: "reap 锁残骸 —— 后续写方一律 reap_residue 被拒；" + repair }); continue; }
    if (tail === ".maint") { residues.push({ path: full, kind: "maint", detail: "维护锁残骸 —— 不自动恢复，人工确认没有维护者在跑后手动删" }); continue; }
    if (tail.startsWith(".reaped-") && UUID_SHAPE.test(tail.slice(".reaped-".length))) { residues.push({ path: full, kind: "reaped", detail: "陈旧回收隔离后删不掉的旧锁实例 —— 已离开原路径，人工删即可" }); continue; }
    residues.push({ path: full, kind: "unknown", detail: "锁家族里不认识的制品 —— 只人工处置" });
  }
  return { holder, residues, path: file };
}
