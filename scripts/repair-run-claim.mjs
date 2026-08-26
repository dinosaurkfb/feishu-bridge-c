#!/usr/bin/env node
/**
 * run 发布 claim 的**显式维护入口**。
 *
 * reap 锁刻意不在热路径自愈（自愈就是"判旧 → rm → wx"反模式低一层复发，
 * 评审两轮各击穿一层）。代价是崩溃残留会让该 run 的发布永久 fail-closed ——
 * 恢复动作收进这里：**核验持有者确实已死才删**，不让人直接 rm 一个
 * 可能仍被活进程持有的锁。默认预览，--apply 才动盘。
 */

import fs from "node:fs";
import path from "node:path";

import { isDirectRun, moduleDir } from "./direct-run.mjs";

const CLAIM_SUFFIX = ".publish-claim.json";
const REAP_SUFFIX = ".publish-claim.json.reaplock";

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
 * 扫描并（apply 时）清理死残留。**活持有者一律不动并说明原因。**
 */
export function repairRunClaims({ runsDir, apply = false, staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(runsDir); }
  catch { return { ok: false, reason: "runs_unreadable", runsDir }; }
  const actions = [];
  for (const name of names.sort()) {
    if (!name.endsWith(CLAIM_SUFFIX) && !name.endsWith(REAP_SUFFIX)) continue;
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
}

export function repairCmd() {
  // URL pathname 在含空格/非 ASCII 路径下会给出转义串 —— 用共用的 moduleDir。
  return path.join(moduleDir(import.meta.url), "repair-run-claim.mjs");
}

if (isDirectRun(import.meta.url)) {
  const arg = (n) => {
    const at = process.argv.indexOf("--" + n);
    return at >= 0 ? process.argv[at + 1] : undefined;
  };
  const root = arg("project");
  if (!root) { console.error("用法：repair-run-claim.mjs --project <root> [--apply]"); process.exit(2); }
  const runsDir = path.join(root, ".runtime-data", "inbound", "runs");
  const r = repairRunClaims({ runsDir, apply: process.argv.includes("--apply") });
  if (!r.ok) { console.error("runs 目录读不出来：" + runsDir); process.exit(1); }
  if (r.actions.length === 0) { console.log("没有 claim/reap 残留。"); process.exit(0); }
  for (const a of r.actions) {
    console.log((a.action === "kept" ? "保留  " : a.action === "removed" ? "已删  " : "将删  ") +
      a.file + " —— " + a.why);
  }
  if (!r.apply) console.log("\n[dry-run] 没动任何文件。加 --apply 才真的清理。");
}
