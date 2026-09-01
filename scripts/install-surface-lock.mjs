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
          if (rel?.reapUncleared) return { ok: false, why: "reap_uncleared：" + String(rel.reapUncleared.error ?? ""), path: rel.reapUncleared.path };
          return rel.ok || rel.reason === "not_owner" ? { ok: true } : { ok: false, why: String(rel.reason), path: file };
        } catch (err) { return { ok: false, why: "release_threw：" + String(err?.code ?? err?.message ?? err), path: file }; }
      },
    };
  }
  if (r.reason === "publisher_busy" || r.reason === "reap_busy") return { ok: false, reason: "surface_install_busy", path: file, why: "另一个安装 / 维护流程正持有安装面锁" };
  return { ok: false, reason: "lock_residue", path: r.path ?? file, why: String(r.reason) + (r.error ? "：" + r.error : "") + "（只人工处置）" };
}

/**
 * 安装器脚本（顶层线性代码，多处 exit）用：取锁并挂 exit 钩子释放；释放残骸打到 stderr（进程要退了，只能点名）。
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
    if (!rel.ok) err("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）—— 残骸会被下一个写方按 pid 活性接管，但请人工核对。");
  });
  return got;
}
