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
/**
 * 「调用方已经在整段编排里持着这把锁」的继承点（PK3-U1-fix1 P1-2）。
 * 一键卸载（scripts/uninstall.mjs）要把**整段编排**放在锁里：入站 → 出站 → Codex → 摘 current → purge。
 * 子安装器是独立进程，它们自己再取一次同一把锁会自重入死锁 —— 所以父进程把自己的持有事实传给它们。
 *
 * **三态**（唯一判据 = `inheritedSurfaceLock`，两个取锁面共用；这里只说口径，别按"值不对就当没设"理解）：
 *   · 值不是这一处的锁路径（或压根没设）→ **当没设**，调用方照常取锁；
 *   · 值就是这一处的锁路径、且核到实际持有者（锁在 / owner.pid === 父进程 / token 逐字相等）→ 认继承：
 *     不重复取锁，release 是空操作（独占权由父进程保证持有到编排结束）；
 *   · **值对但核不上持有者 → fail-closed 拒绝（exit 2、零写）**，不是"当没设、照常取锁"
 *     —— 那把锁不在时普通取锁会**真的拿到锁并开写**，而调用方"我在编排的锁里"的前提已经被证伪。
 */
export const INSTALL_SURFACE_HELD_ENV = "FEISHU_BRIDGE_INSTALL_SURFACE_HELD";
/**
 * 继承点**配套的 token**（PK3-U1-fix2 P1-1）：路径是可预测的（就在桥根下），光比路径等于把
 * 「我持着锁」当成一句口头声明 —— 直接设上 HELD 就能无锁写安装面。改成两个变量：
 *   FEISHU_BRIDGE_INSTALL_SURFACE_HELD=<锁路径>  且  FEISHU_BRIDGE_INSTALL_SURFACE_HELD_TOKEN=<锁里的 token>
 * 子进程还要能核到**实际持有者**：锁文件在位、payload 形状受验、owner.pid === process.ppid（父进程就是持锁者）、
 * token 逐字相等。**任一不符 → 不认继承，但也不"当没设"**：直接 fail-closed 拒绝、exit 2 零写
 * （见上面那段三态；判定只有 `inheritedSurfaceLock` 一份，`holdInstallSurfaceLockOrExit` 与
 * `acquireInstallSurfaceLockOrRefuse` 共用）。
 */
export const INSTALL_SURFACE_HELD_TOKEN_ENV = "FEISHU_BRIDGE_INSTALL_SURFACE_HELD_TOKEN";

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
      // 取锁时的 token（registry 锁协议的归属凭据）：继承点要子进程拿着它才能证明“父进程真持着”（fix2 P1-1）
      token: r.token,
      release: () => {
        try {
          const rel = releasePublishLock(file);
          // .reap 残骸会让后续每个写方 reap_residue：不是"等着被接管"，要 repair-publish-lock 显式清
          if (rel?.reapUncleared) return { ok: false, why: "reap_uncleared：" + String(rel.reapUncleared.error ?? "") + " —— node scripts/repair-publish-lock.mjs --lock " + file + " --apply 能清", path: rel.reapUncleared.path };
          // 主锁缺席 / 已换主 = **我持有期间锁丢了**（评审探针：曾被当成功）：写段可能已被并发写方覆盖，必须非零收场
          if (rel?.ok && rel.absent) return { ok: false, why: "lock_lost：主锁在持有期间已缺席（被删除或回收）—— 本次写段的独占性无法证明，请人工核对安装面", path: file };
          if (rel?.ok) return { ok: true };
          if (rel?.reason === "not_owner") return { ok: false, why: "lock_instance_replaced：锁已被别的实例持有（本次持有期间被接管）—— 本次写段的独占性无法证明，请人工核对安装面", path: file };
          return { ok: false, why: String(rel?.reason ?? "release_failed"), path: file };
        } catch (err) { return { ok: false, why: "release_threw：" + String(err?.code ?? err?.message ?? err), path: file }; }
      },
    };
  }
  if (r.reason === "publisher_busy" || r.reason === "reap_busy") return { ok: false, reason: "surface_install_busy", path: file, why: "另一个安装 / 维护流程正持有安装面锁" };
  return { ok: false, reason: "lock_residue", path: r.path ?? file, why: String(r.reason) + (r.error ? "：" + r.error : "") + "（只人工处置；.reap 家族可用 node scripts/repair-publish-lock.mjs --lock " + file + " --apply）" };
}

/**
 * 取锁的**受控返回**形态（PK3-L7-fix6）：不 exit、不挂 exit 钩子 —— 给「锁内段抽成可导入函数」的写方用
 * （释放由调用方在 finally 里做）。`holdInstallSurfaceLockOrExit` 就是它加一层 exit 包装 ——
 * 拒绝文案与退出码只写在这一处，两个调用面不会漂。
 * @returns {{ok:true, lock} | {ok:false, code:2|3, text}}
 */
/**
 * 编排继承（HELD）的**唯一一份**判定（PK3-U3：把 holdInstallSurfaceLockOrExit 里那段抽出来，两个取锁面共用）。
 *   · null：没声明 HELD，或 HELD 路径不是这一处的锁 → 调用方照常取锁；
 *   · { ok: true, lock }：声明成立且核到实际持有者（锁在 / owner.pid === 父进程 / token）→ 不重复取、release 是空操作；
 *   · { ok: false, code: 2, text }：声明了在锁里却核不上持有者 → fail-closed 拒绝、零写。
 * 为什么要共用：omm 2026-09-19 真机卸载，uninstall.mjs 持锁编排里起的 codex/drain-service.mjs --disable --apply
 *   走的是 acquireInstallSurfaceLockOrRefuse（PK3-L7-fix6），它不认 HELD，于是撞上父进程自己的锁报 busy、卸载停在半截。
 */
export function inheritedSurfaceLock({ home = os.homedir(), env = process.env } = {}) {
  const inherited = env[INSTALL_SURFACE_HELD_ENV];
  if (!(typeof inherited === "string" && inherited.length > 0 && inherited === installSurfaceLockPath({ home, env }))) return null;
  const why = inheritedHolderProblem({ path: inherited, token: env[INSTALL_SURFACE_HELD_TOKEN_ENV] });
  if (why === null) return { ok: true, lock: { ok: true, path: inherited, inherited: true, release: () => ({ ok: true }) } };
  return { ok: false, code: 2, text: "安装面锁的 HELD 继承声明不成立（" + why + "）—— 拒绝，什么都没写。" +
    "（这个变量只给 scripts/uninstall.mjs 编排里的子安装器用；不在编排里跑就 unset " + INSTALL_SURFACE_HELD_ENV + "）" };
}

export function acquireInstallSurfaceLockOrRefuse({ home = os.homedir(), env = process.env, err = null } = {}) {
  // PK3-U3：先认编排继承（与 holdInstallSurfaceLockOrExit 同一份判定），再走普通取锁。
  const held = inheritedSurfaceLock({ home, env });
  if (held !== null) {
    if (held.ok) return { ok: true, lock: held.lock, inherited: true };
    if (typeof err === "function") err(held.text);
    return { ok: false, code: held.code, text: held.text };
  }
  const got = acquireInstallSurfaceLock({ home, env });
  if (got.ok) return { ok: true, lock: got };
  const text = "安装面锁拿不到（" + got.reason + "：" + String(got.why) + "，" + got.path + "）—— 什么都没写。" +
    (got.reason === "surface_install_busy" ? "等它结束再装。" : "");
  if (typeof err === "function") err(text);
  return { ok: false, code: got.reason === "surface_install_busy" ? 2 : 3, text };
}

/**
 * 安装器脚本（顶层线性代码，多处 exit）用：取锁并挂 exit 钩子释放。释放失败**不许报成功**：
 * 点名残骸并把退出码改成 3（评审探针：.reap 删除 EIO 时进程曾照样退 0）。
 * 拿不到锁 → 打印原因并 exit 2（busy）/ 3（残骸），什么都没写。
 */
export function holdInstallSurfaceLockOrExit({ home = os.homedir(), env = process.env, err = (t) => process.stderr.write(t + "\n") } = {}) {
  // 编排继承（PK3-U1-fix1 / fix2）：判定只有一份（inheritedSurfaceLock，PK3-U3 抽出），两个取锁面共用。
  //   声明成立 → 不重复取、也不假装"取到了"；声明了却核不上持有者 → fail-closed 拒绝 exit 2（不是"当没设、照常取锁"：
  //   那把锁不在时普通取锁会真的拿到锁开写，而调用方"我在编排的锁里"的前提已被证伪）。路径本身不对的 HELD 当没设。
  const held = inheritedSurfaceLock({ home, env });
  if (held !== null) {
    if (held.ok) return { ok: true, path: held.lock.path, inherited: true, release: () => ({ ok: true }) };
    err(held.text);
    process.exit(held.code);
  }
  // 普通路径走受控返回的那一份（PK3-L7-fix6 抽出的）：拒绝文案与退出码只写在那里，两个调用面不会漂。
  const refused = acquireInstallSurfaceLockOrRefuse({ home, env, err });
  if (!refused.ok) process.exit(refused.code);
  const got = refused.lock;
  process.on("exit", () => {
    const rel = got.release();
    if (!rel.ok) { err("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）。"); process.exitCode = 3; }
  });
  return got;
}

// ── 只读盘点（--status / doctor 用）—— **封闭、fail-closed 的协议投影**（评审探针：缺 token 曾显示 held、
// 枚举异常曾折成空、任意 quarantine 后缀曾说可 repair、在途 .reap 曾被误报残骸）──────────────────────
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const INSTALL_SURFACE_LOCK_STALE_MS = 60 * 1000;
/** 一个锁位置的三态投影：owner 形状与 registry 锁协议**逐字段同形**（{pid, at, token} 缺一不可）。 */
function lockSiteState(p, now) {
  let st;
  try { st = fs.lstatSync(p); } catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unknown", why: "lstat 失败：" + String(err?.code ?? err?.message) }; }
  if (!st.isSymbolicLink()) return { state: "unknown", why: "不是本协议的 symlink" };
  let o = null;
  try { o = JSON.parse(fs.readlinkSync(p)); } catch { o = null; }
  const shapeOk = o !== null && typeof o === "object" && !Array.isArray(o) && Number.isSafeInteger(o.pid) && o.pid > 0 && isCanonicalIso(o.at) && typeof o.token === "string" && o.token.length > 0;
  if (!shapeOk) return { state: "unknown", why: "payload 形状不对（owner 必须是 {pid, at, token} 逐字段受验）" };
  let alive = true;
  try { process.kill(o.pid, 0); } catch { alive = false; }
  // token 也带回去：HELD 继承要拿它跟子进程收到的逐字比（fix2 P1-1）。盘点投影不打印它（只取 pid/alive/at）
  return { state: "held", pid: o.pid, alive, at: o.at, token: o.token, ageMs: Math.max(0, now - Date.parse(o.at)) };
}

/**
 * HELD 继承能不能成立（fix2 P1-1）—— 返回 null 表示成立，否则返回为什么。
 * 四道：① 有 token；② 锁文件在位且是本协议的 symlink（{pid, at, token} 形状受验）；
 * ③ owner.pid === process.ppid（**父进程就是持锁者** —— 一个无关进程设上环境变量不成立）；④ token 逐字相等。
 */
export function inheritedHolderProblem({ path: p, token, ppid = process.ppid, now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length === 0) return "只有锁路径、没有 " + INSTALL_SURFACE_HELD_TOKEN_ENV + "";
  const s = lockSiteState(p, now);
  if (s.state !== "held") return "锁文件不在或不符协议（" + String(s.why ?? s.state) + "）：" + String(p);
  if (s.pid !== ppid) return "锁的 owner pid " + s.pid + " ≠ 本进程的父进程 " + ppid + "（不是持锁者派生出来的）";
  if (s.token !== token) return "token 与锁里的不相等";
  return null;
}
/**
 * @returns {{ holder, residues: {path,kind,detail}[], inventory: "ok"|"unreadable", path }}
 *   holder：absent | held{pid,alive,at} | unknown{why}。目录枚举失败（除 ENOENT）→ inventory:"unreadable" 并点名，
 *   **不折成"没有残骸"**。在途的 .reap / .maint（持有者活着且未超时）不是残骸，不报。
 */
export function inspectInstallSurfaceLock({ home = os.homedir(), env = process.env, now = Date.now(), staleMs = INSTALL_SURFACE_LOCK_STALE_MS } = {}) {
  const file = installSurfaceLockPath({ home, env });
  const repair = "node scripts/repair-publish-lock.mjs --lock " + file + " --apply 能清";
  const residues = [];
  const raw = lockSiteState(file, now);
  const holder = raw.state === "held" ? { state: "held", pid: raw.pid, alive: raw.alive, at: raw.at } : raw;
  let names;
  try { names = fs.readdirSync(path.dirname(file)); }
  catch (err) {
    if (err?.code === "ENOENT") names = [];
    else return { holder, residues: [{ path: path.dirname(file), kind: "inventory", detail: "目录枚举失败：" + String(err?.code ?? err?.message) + " —— 残骸情况说不清，请人工核对" }], inventory: "unreadable", path: file };
  }
  const base = path.basename(file);
  const transient = (s) => s.state === "held" && s.alive && s.ageMs <= staleMs; // 在途归属转换 / 维护段，不是残骸
  for (const n of names.sort()) {
    if (n === base || !n.startsWith(base + ".")) continue;
    const full = path.join(path.dirname(file), n);
    const tail = n.slice(base.length);
    if (tail === ".reap") {
      const s = lockSiteState(full, now);
      if (transient(s)) continue;
      residues.push({ path: full, kind: s.state === "held" ? "reap" : "unknown", detail: s.state === "held" ? (s.alive ? "reap 锁被 pid " + s.pid + " 持有已 " + Math.floor(s.ageMs / 1000) + " 秒（段只有几毫秒）" : "reap 锁残骸（回收者 pid " + s.pid + " 已不在）") + " —— 后续写方一律 reap_residue 被拒；" + repair : "reap 位置" + (s.why ?? "形状不对") + " —— 只人工处置" });
      continue;
    }
    if (tail === ".maint") {
      const s = lockSiteState(full, now);
      if (transient(s)) continue;
      residues.push({ path: full, kind: s.state === "held" ? "maint" : "unknown", detail: s.state === "held" ? "维护锁残骸 —— 不自动恢复，人工确认没有维护者在跑后手动删" : "维护锁位置" + (s.why ?? "形状不对") + " —— 只人工处置" });
      continue;
    }
    if (tail.startsWith(".reaped-")) {
      residues.push(UUID_SHAPE.test(tail.slice(".reaped-".length)) ? { path: full, kind: "reaped", detail: "陈旧回收隔离后删不掉的旧锁实例 —— 已离开原路径，人工删即可" } : { path: full, kind: "unknown", detail: "像 .reaped-<uuid> 但不合形状 —— 只人工处置" });
      continue;
    }
    if (tail.startsWith(".reap.quarantine-")) {
      residues.push(UUID_SHAPE.test(tail.slice(".reap.quarantine-".length)) ? { path: full, kind: "reap-quarantine", detail: "reap 锁残骸隔离后删不掉 —— " + repair } : { path: full, kind: "unknown", detail: "像 .reap.quarantine-<uuid> 但不合形状 —— 只人工处置" });
      continue;
    }
    residues.push({ path: full, kind: "unknown", detail: "锁家族里不认识的制品 —— 只人工处置" });
  }
  return { holder, residues, inventory: "ok", path: file };
}
