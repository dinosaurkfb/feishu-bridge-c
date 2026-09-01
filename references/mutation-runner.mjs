#!/usr/bin/env node
// 变异测试 runner —— 竞速单 #3。开发期工具，住 references/（不进 runtime）。
//
// 用法：
//   node references/mutation-runner.mjs                # 全表
//   node references/mutation-runner.mjs --ids m1 m2    # 选跑
//
// 表：每个变异 { id, file, find, replace, killedBy }
//   file 相对仓库根；find 必须在文件里恰好出现 1 次；killedBy 是预期击杀测试的名字子串
//   （逗号分隔多个子串，原样交给 TEST_FILTER —— 子串按 OR 命中，测试按文件顺序跑）。
//
// 判定协议（定向只是加速，全量才是判据）：
//   1. 锚点恰好命中 1 次，否则记异常（anchor_missing / anchor_ambiguous），文件不动；
//   2. 应用变异后先 `node --check`：语法坏记异常（mutant_broken）—— KILLED 必须是"套件抓住了它"，
//      不能是"变异体自己跑不起来"；
//   3. killedBy 定向基线（未变异）先跑一次并按 killedBy 缓存：基线红说明该子集有顺序依赖、
//      定向结果不可信 —— 跳过定向，直接全量（并把 killedBy 是表 bug 这件事喊出来）；
//      基线绿时，定向转红 ⇒ KILLED（定向）；
//   4. 定向没红（含 killedBy 命中 0 个测试）⇒ 自动升级全量确认：全量红 ⇒ KILLED（升级全量），
//      全量绿 ⇒ SURVIVED；
//   5. 还原写在 finally，还原后逐字节校验。
// 汇总 `KILLED x / SURVIVED y / 异常 z`；y 或 z > 0 → 退出码 1（变异没杀干净必须显眼）。
// 已知留白：runner 被强杀（SIGKILL）时变异文件来不及还原 —— 表里每个变异都自带
// find/replace 原文，可用 `git checkout -- <file>` 兜底；不为此加恢复进程。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "scripts/test.mjs";
const RUN_TIMEOUT_MS = 10 * 60 * 1000;   // 单次套件跑的保险丝：全量约 2.5 分钟，挂死的变异体在这里被截住

const MUTATIONS = [
  {
    id: "m1",
    file: "scripts/claim.mjs",
    find: 'reason: "duplicate", key, dir',
    replace: 'reason: "duplicate_placeholder", key, dir',
    killedBy: "首次 claim 成功,被拒为 duplicate",
  },
  {
    id: "m2",
    file: "scripts/claim.mjs",
    find: '.update(messageId + " " + logicalTaskKey)',
    replace: ".update(messageId)",
    // 故意写错：命中 0 个测试 → 定向白跑 → 演示自动升级全量后仍被杀。
    killedBy: "绝无此测试——演示定向白跑后升级全量",
  },
  {
    id: "m3",
    file: "scripts/claim.mjs",
    find: "这个锚点在仓库里不存在（示例：演示锚点报错路径）",
    replace: "x",
    killedBy: "无所谓",
  },
];

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let wanted = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--ids") {
    wanted = [];
    for (i += 1; i < argv.length && !argv[i].startsWith("--"); i += 1) wanted.push(argv[i]);
    i -= 1;
  } else {
    console.error("不认识的参数：" + argv[i] + "（只支持 --ids m1 m2 …）");
    process.exit(2);
  }
}
const table = wanted === null ? MUTATIONS : MUTATIONS.filter((m) => wanted.includes(m.id));
const unknown = wanted === null ? [] : wanted.filter((id) => !MUTATIONS.some((m) => m.id === id));
if (unknown.length > 0) {
  console.error("表里没有这些 id：" + unknown.join("、") + "。现有：" + MUTATIONS.map((m) => m.id).join("、"));
  process.exit(2);
}
if (table.length === 0) { console.error("--ids 没选中任何变异。"); process.exit(2); }

// ---------- 跑套件 ----------
function runSuite(filter) {
  const env = { ...process.env };
  if (filter === null) delete env.TEST_FILTER; else env.TEST_FILTER = filter;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SUITE], {
    cwd: ROOT, encoding: "utf-8", timeout: RUN_TIMEOUT_MS, env,
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.error || r.status === null) return { code: "timeout", out: String(r.stderr ?? r.error), seconds };
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), seconds };
}

// 「TEST_FILTER 命中 N / 总 M」——汇总行就是机器可读的过滤结果。
function filterHits(out) {
  const m = /TEST_FILTER 命中 (\d+) \/ 总 (\d+)/u.exec(out);
  return m === null ? null : { hits: Number(m[1]), total: Number(m[2]) };
}

function failLines(out, cap = 3) {
  return out.split("\n").filter((l) => l.startsWith("  ✗ ")).slice(0, cap);
}

// killedBy 子集的基线（未变异）状态，按 killedBy 字符串缓存 —— 一张真表里同一个守卫的
// 几十个变异共用一个 killedBy，基线只跑一次。
const baselineCache = new Map();
function baselineGreen(killedBy) {
  if (!baselineCache.has(killedBy)) {
    const r = runSuite(killedBy);
    const green = r.code === 0;
    baselineCache.set(killedBy, green);
    if (!green) console.log("  ⚠ killedBy 子集在未变异基线上就红（顺序依赖或表写错）——定向不可信，跳过定向直接全量");
  }
  return baselineCache.get(killedBy);
}

// ---------- 单个变异 ----------
function runMutation(mut) {
  const filePath = path.join(ROOT, mut.file);
  const original = fs.readFileSync(filePath, "utf-8");
  const applied = original.split(mut.find).length - 1;
  if (applied !== 1) {
    return { verdict: "异常", why: (applied === 0 ? "anchor_missing" : "anchor_ambiguous") + "（命中 " + applied + " 次），文件未动" };
  }
  // 定向子集的基线检查必须在**未变异**的文件上做（这也是它叫基线的原因）——
  // 放到应用变异之后，红的就是变异体本身，定向永远不可信，全部退化成全量。
  const targetedTrustworthy = baselineGreen(mut.killedBy);
  try {
    // 替换用函数形式：replace 里若有 $&、$1 也不会被当成替换模式解释。
    fs.writeFileSync(filePath, original.replace(mut.find, () => mut.replace));
    const check = spawnSync(process.execPath, ["--check", path.relative(ROOT, filePath)], { cwd: ROOT, encoding: "utf-8" });
    if (check.status !== 0) return { verdict: "异常", why: "mutant_broken（变异体语法跑不起来）" };

    if (targetedTrustworthy) {
      const targeted = runSuite(mut.killedBy);
      const hits = filterHits(targeted.out);
      if (targeted.code !== 0) {
        return { verdict: "KILLED", how: "定向（" + targeted.seconds + "s）", detail: failLines(targeted.out) };
      }
      if (hits !== null && hits.hits === 0) console.log("  ⚠ killedBy 没命中任何测试——定向白跑，升级全量");
    }
    const full = runSuite(null);
    if (full.code !== 0) return { verdict: "KILLED", how: "升级全量（" + full.seconds + "s）", detail: failLines(full.out) };
    return { verdict: "SURVIVED", how: "定向与全量都没杀到", detail: [] };
  } finally {
    fs.writeFileSync(filePath, original);
    if (fs.readFileSync(filePath, "utf-8") !== original) throw new Error("还原校验失败：" + mut.file);
  }
}

// ---------- 主循环 ----------
const results = { KILLED: 0, SURVIVED: 0, "异常": 0 };
for (const mut of table) {
  console.log("\n■ " + mut.id + "  " + mut.file);
  console.log("  find: " + JSON.stringify(mut.find));
  let result;
  try {
    result = runMutation(mut);
  } catch (err) {
    result = { verdict: "异常", why: String(err.message ?? err) };
  }
  results[result.verdict] += 1;
  const tag = result.verdict === "KILLED" ? "✔" : result.verdict === "异常" ? "✗" : "△";
  console.log("  " + tag + " " + result.verdict + "  " + (result.how ?? result.why ?? ""));
  for (const line of result.detail ?? []) console.log("      " + line.trim());
}

console.log("\nKILLED " + results.KILLED + " / SURVIVED " + results.SURVIVED + " / 异常 " + results["异常"]);
process.exit(results.SURVIVED > 0 || results["异常"] > 0 ? 1 : 0);
