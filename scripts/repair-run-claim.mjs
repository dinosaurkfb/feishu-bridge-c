#!/usr/bin/env node
/**
 * run 发布 claim 的**显式维护入口**。
 *
 * ■ 它只清 reap 锁，**不碰 claim**
 *
 * 第一版"判死 → 删 claim"被评审固定时序击穿：维护者读到旧死 claim、
 * 热路径抢先完成接管写入新 token、维护者按旧结论删掉了**新** claim ——
 * 两个 watcher 同时自认持有授权。"删除前再读一次"仍有窗口；
 * 与热路径共享互斥又会引入新的一层锁。所以采用更简单的安全形状：
 * **维护只移除阻塞热路径的 reap 锁**（核验其持有者确实已死），
 * 死 claim 本身留给热路径既有的 token/reap 接管协议自取 ——
 * 那条路已被 32 并发回归钉住"恰好一个得手"。
 *
 * ■ 严格参数面
 *
 * 这是破坏性 CLI：只认 --project <路径>、--key <64位十六进制>、--apply。
 * 未知参数、裸参数、`--` 透传一律拒绝退出 —— includes("--apply") 那种
 * 全数组扫法会把 `-- --apply` 也当成授权（评审实测）。默认预览。
 */

import fs from "node:fs";
import path from "node:path";

import { isDirectRun, moduleDir } from "./direct-run.mjs";

const REAP_SUFFIX = ".publish-claim.json.reaplock";
const KEY_SHAPE = /^[0-9a-f]{64}$/u;

const ownerDead = (file, { staleMs, now }) => {
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 按 mtime */ }
  if (owner && Number.isFinite(owner.pid)) {
    try { process.kill(owner.pid, 0); return { dead: false, why: "持有者进程还活着（pid " + owner.pid + "）" }; }
    catch { return { dead: true, why: "持有者进程已不存在（pid " + owner.pid + "）" }; }
  }
  try {
    const age = now - fs.statSync(file).mtimeMs;
    return age > staleMs
      ? { dead: true, why: "owner 读不出且已超龄（" + Math.round(age / 1000) + "s）" }
      : { dead: false, why: "owner 读不出但还新鲜 —— 可能正在创建" };
  } catch { return { dead: false, why: "文件已消失" }; }
};

/**
 * 扫描并（apply 时）清理**死掉的 reap 锁**。活持有者一律不动并说明原因。
 * claim 文件永远不动 —— 见文件头。
 */
export function repairRunClaims({ runsDir, key = null, apply = false,
  staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(runsDir); }
  catch { return { ok: false, reason: "runs_unreadable", runsDir }; }

  // **维护者也要串行。**评审固定时序：维护者 A 判旧 owner 已死 →
  // 维护者 B 删旧 reap → 热路径创建活进程的新 reap → A 按旧结论 rm 掉新 reap。
  // 同款 TOCTOU 低一层复发。维护锁 wx 单步、**不自愈**（教义一致：
  // 自愈就是反模式再低一层）；残留 fail-closed 指路人工。
  // 串行 + 热路径对 reap 锁从不自愈（EEXIST 即 fail-closed）⇒
  // 死 reap 在本维护者 rm 之前不可能被换成活的，rm 不会误伤。
  const maintLock = path.join(runsDir, ".repair-maintenance.lock");
  if (apply) {
    try {
      fs.writeFileSync(maintLock,
        JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + "\n",
        { flag: "wx", mode: 0o600 });
    } catch (err) {
      return err.code === "EEXIST"
        ? { ok: false, reason: "maintenance_lock_held",
            detail: "另一个维护者在场（或其崩溃残留）：" + maintLock +
              " —— 确认无维护者存活后人工删除该文件再试" }
        : { ok: false, reason: "io_error", error: String(err.message).slice(0, 200) };
    }
  }
  try {
    const actions = [];
    for (const name of names.sort()) {
      if (!name.endsWith(REAP_SUFFIX)) continue;
      // **--key 是精确目标，不是前缀。**评审实测 <key>f 的文件被
      // startsWith 顺带删掉 —— 破坏性命令的靶子必须逐字。
      if (key !== null && name !== key + REAP_SUFFIX) continue;
      const file = path.join(runsDir, name);
      const verdict = ownerDead(file, { staleMs, now });
      if (!verdict.dead) {
        actions.push({ file: name, action: "kept", why: verdict.why });
        continue;
      }
      if (apply) fs.rmSync(file, { force: true });
      actions.push({ file: name, action: apply ? "removed" : "would_remove", why: verdict.why });
    }
    return { ok: true, runsDir, apply, actions };
  } finally {
    if (apply) fs.rmSync(maintLock, { force: true });
  }
}

export function repairCmd() {
  return path.join(moduleDir(import.meta.url), "repair-run-claim.mjs");
}

if (isDirectRun(import.meta.url)) {
  // 严格解析：白名单之外一个都不收。
  const argv = process.argv.slice(2);
  let project = null;
  let key = null;
  let allKeys = false;
  let apply = false;
  let bad = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project") { project = argv[++i]; }
    else if (a === "--key") { key = argv[++i]; }
    else if (a === "--all") { allKeys = true; }
    else if (a === "--apply") { apply = true; }
    else { bad = a; break; }
  }
  // **范围必须显式**：--key <精确目标> 或 --all 二选一 ——
  // "没写 key 就默认全项目"会让人为一条 run 报警、顺手清掉整个项目的残留。
  const usage = "用法：repair-run-claim.mjs --project <root> (--key <64位hex> | --all) [--apply]";
  if (bad !== null || !project || typeof project !== "string"
    || (key === null) === (allKeys === false)
    || (key !== null && (typeof key !== "string" || !KEY_SHAPE.test(key)))) {
    console.error(bad !== null
      ? "不认识的参数：" + bad + " —— 这是破坏性命令。" + usage
      : usage);
    process.exit(2);
  }
  const runsDir = path.join(project, ".runtime-data", "inbound", "runs");
  const r = repairRunClaims({ runsDir, key, apply });
  if (!r.ok && r.reason === "maintenance_lock_held") {
    console.error("维护互斥：" + r.detail);
    process.exit(1);
  }
  if (!r.ok) { console.error("维护失败（" + r.reason + "）：" + runsDir); process.exit(1); }
  if (r.actions.length === 0) { console.log("没有匹配的 reap 锁残留。"); process.exit(0); }
  for (const a of r.actions) {
    console.log((a.action === "kept" ? "保留  " : a.action === "removed" ? "已删  " : "将删  ") +
      a.file + " —— " + a.why);
  }
  if (!r.apply) console.log("\n[dry-run] 没动任何文件。确认后加 --apply。");
  else console.log("\n死 claim（若有）不由本命令处理 —— 热路径的接管协议会自取。");
}
