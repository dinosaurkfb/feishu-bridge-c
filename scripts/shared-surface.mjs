#!/usr/bin/env node
/**
 * 共用模块的导出面快照 —— 让「共用代码被悄悄扩大」变成一次必须过目的评审。
 *
 * 这个仓库现在有两条链路：`scripts/` 是底座，`scripts/codex/` 是适配层。
 * 适配层从底座 import 了十个模块，而底座**不反向依赖**它（有测试守着方向）。
 * 问题在于：任何一方改这十个模块，都可能悄悄改掉另一方依赖的东西。
 *
 * 2026-08-20 已经发生过一次：Codex 往 outbox.mjs 里加了 eventKey / publishEligible /
 * publish_suppressed_at。改得很克制、注释也写清了兼容意图，但 Claude 侧当时一条
 * 覆盖这些新字段的测试都没有 —— 也就是说，**当时没出事靠的是对方仔细，不是靠机制。**
 *
 * 这个快照抓的不是「改错了」，是「改了而没人看见」。三种变化各有不同含义：
 *
 *   少了导出  → 另一条链路大概率当场 import 失败。响亮，但快照能让你在跑之前就知道。
 *   改了名字  → 同上。
 *   多了导出  → **最值得停下来看的一种。**它通常意味着某一方把自己的概念塞进了共用代码
 *               （`markPublishEligibleByEventKey` 就是纯 Codex 概念，现在住在共用 outbox 里）。
 *               这不一定错，但必须是个有人点头的决定，而不是一次悄悄的增生。
 *
 * 快照存成一个进版本管理的文件，就是为了让它出现在 diff 里 —— 评审看得见，才叫契约。
 *
 * 用法：
 *   node scripts/shared-surface.mjs            # 对一遍，有出入就非零退出
 *   node scripts/shared-surface.mjs --update   # 认可当前状态，更新快照
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const SNAPSHOT_FILE = path.join(ROOT, "references", "shared-surface.json");
const CODEX_DIR = path.join(ROOT, "scripts", "codex");

/**
 * 谁是共用模块 —— **从代码里数出来，不手写清单。**
 *
 * 手写清单会漏：适配层哪天多 import 一个模块，清单不会自己长出来，
 * 而那个新进来的模块正好是没人守着的那个。
 */
export function sharedModules({ codexDir = CODEX_DIR } = {}) {
  const names = new Set();
  let files;
  try {
    files = fs.readdirSync(codexDir).filter((f) => f.endsWith(".mjs"));
  } catch {
    return []; // 没有适配层就没有共用面
  }
  for (const f of files) {
    const src = fs.readFileSync(path.join(codexDir, f), "utf-8");
    for (const m of src.matchAll(/from\s+["']\.\.\/([A-Za-z0-9_-]+\.mjs)["']/g)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** 一个模块当前导出了哪些名字。排序，免得写法顺序变化造成假差异。 */
export async function surfaceOf(moduleFile, { root = ROOT } = {}) {
  const mod = await import(path.join(root, "scripts", moduleFile));
  return Object.keys(mod).sort();
}

export async function currentSurface(opts = {}) {
  const out = {};
  for (const m of sharedModules(opts)) out[m] = await surfaceOf(m, opts);
  return out;
}

export function loadSnapshot(file = SNAPSHOT_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")).modules ?? {};
  } catch {
    return null;
  }
}

/** 比对。返回结构化差异，自己不打印、不退出 —— 测试和 CLI 各自决定怎么呈现。 */
export function diffSurface(snapshot, current) {
  const problems = [];
  const snapKeys = Object.keys(snapshot ?? {});
  const curKeys = Object.keys(current ?? {});

  for (const m of curKeys.filter((k) => !snapKeys.includes(k))) {
    problems.push({ module: m, kind: "new_shared_module",
      detail: "适配层开始依赖一个新的共用模块，它此前没有任何契约保护" });
  }
  for (const m of snapKeys.filter((k) => !curKeys.includes(k))) {
    problems.push({ module: m, kind: "no_longer_shared",
      detail: "适配层不再依赖它 —— 可以从快照里去掉，但先确认不是漏改" });
  }
  for (const m of curKeys.filter((k) => snapKeys.includes(k))) {
    const before = snapshot[m] ?? [];
    const after = current[m] ?? [];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    if (added.length) {
      problems.push({ module: m, kind: "export_added", names: added,
        detail: "共用面变大了。先问一句：这是两条链路都要用的东西，还是某一方的概念塞了进来？" });
    }
    if (removed.length) {
      problems.push({ module: m, kind: "export_removed", names: removed,
        detail: "共用面变小了 —— 另一条链路可能当场 import 失败" });
    }
  }
  return problems;
}

export function describeProblem(p) {
  const names = p.names?.length ? "（" + p.names.join(", ") + "）" : "";
  return p.module + "  " + p.kind + names + "\n      " + p.detail;
}

// ---------- CLI ----------

if (import.meta.url === "file://" + process.argv[1]) {
  const current = await currentSurface();
  const modules = Object.keys(current);

  if (process.argv.includes("--update")) {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
      _README: "共用模块的导出面快照。scripts/ 是底座，scripts/codex/ 是适配层；这里列的是适配层依赖的模块。改动共用代码会让 node scripts/shared-surface.mjs 失败——那不是错误，是要求你确认这次扩大/缩小是有意的，然后用 --update 认下来。",
      generated_at: new Date().toISOString(),
      modules: current,
    }, null, 2) + "\n");
    console.log("快照已更新：" + SNAPSHOT_FILE);
    console.log(modules.length + " 个共用模块，共 " +
      Object.values(current).reduce((n, a) => n + a.length, 0) + " 个导出");
    process.exit(0);
  }

  const snapshot = loadSnapshot();
  if (snapshot === null) {
    console.error("还没有快照。先跑一次：node scripts/shared-surface.mjs --update");
    process.exit(1);
  }

  const problems = diffSurface(snapshot, current);
  console.log("共用模块 " + modules.length + " 个（从 scripts/codex/ 的 import 数出来的）");
  for (const m of modules) console.log("  " + m.padEnd(20) + current[m].length + " 个导出");

  if (problems.length === 0) {
    console.log("\n✅ 与快照一致");
    process.exit(0);
  }
  console.error("\n共用面变了 " + problems.length + " 处：\n");
  for (const p of problems) console.error("  · " + describeProblem(p) + "\n");
  console.error("确认这些改动是有意的之后：node scripts/shared-surface.mjs --update");
  process.exit(1);
}
