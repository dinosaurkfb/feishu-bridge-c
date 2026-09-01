/**
 * 变异测试 runner（票 #3）—— 改坏一处代码，套件必须转红；不红就说明那条守卫没在盯这件事。
 *
 * 为什么先跑定向：全量套件约 2.5 分钟，48 个变异要 2 小时；而真能杀掉某个变异的往往只有
 * 1–2 个测试。定向跑一次不到 1 秒（实测 0.4s 跑两条），杀掉即算红。
 * **定向只是加速，不是判据**：定向没转红时自动升级跑全量确认，全量也没红才算 SURVIVED。
 *
 * 三层防的是"变异表变成一台制造绿字的机器"：
 *  1. 启动前先在**未变异**的代码上跑一次全量。全量本来就红 → 直接退出：那时任何变异都会
 *     被读成 KILLED，整轮的结论都是假的。（表里所有变异都在锚点核对阶段就报错时不花这笔时间。）
 *  2. 每个变异先在未变异代码上跑它自己的定向过滤器。基线就红 → 报 baseline_red 异常，
 *     **不算击杀**（那是过滤器挑到了本来就红的测试，或那条测试依赖前序测试的副作用）。
 *  3. 锚点必须恰好命中 1 次；变异体先过 `node --check`，语法坏了报 mutant_broken，
 *     不算 KILLED（红是红在语法上，不是红在守卫上）。
 *
 * 退出码：0 = 全部 KILLED；1 = 有 SURVIVED 或异常。
 * 用法：`node references/mutation-runner.mjs`（全表）或 `--ids m1 m2`（选跑）。
 *
 * 只驱动 Claude 套件（`scripts/test.mjs`）。`killedBy` 在那一侧一个名字都不命中时，套件以
 * 退出码 2 + "命中 0" 收场，这里读成 filter_misses 异常 —— 所以"Codex 侧才有的守卫"
 * 不会被静默判成存活，会被判成异常。真要覆盖 codex 套件时给表加 `suite` 字段，别在这儿预留。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectRun, moduleDir } from "../scripts/direct-run.mjs";

// --root 覆盖（--jobs 的子进程在临时 worktree 里跑；默认 = 本仓根）
let ROOT = path.resolve(moduleDir(import.meta.url), "..");
const SUITE = path.join("scripts", "test.mjs");
// 定向跑用短窗，全量用长窗；超时的变异**不许**被当成击杀（超时是红在计时器上）。
const TARGETED_TIMEOUT_MS = 5 * 60 * 1000;
const FULL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * 真实变异表在 references/mutation-table.mjs（m1506+，随收口逐条验证过全红）；默认跑它。
 *
 * 下面三条是**示例**（DEMOS），各自盯 runner 的一条路径，只有 --ids 显式点名才会跑
 *（m-upgrade-full 每跑一次要付一轮全量，混进默认全表会白花两分半）：
 *  - m-anchor-targeted：锚点唯一、killedBy 写对 → 定向 0.4 秒即杀。
 *  - m-upgrade-full：**故意把 killedBy 写成一条无关但会通过的测试** → 定向不红 →
 *    自动升级全量 → 全量转红 → 记 KILLED（升级）。这条存在的意义就是证明升级这一步真的会发生。
 *  - m-anchor-missing：锚点在文件里根本不存在 → 报错，不跑任何套件。
 */
import { MUTATIONS as TABLE } from "./mutation-table.mjs";
const DEMOS = [
  {
    id: "m-anchor-targeted",
    file: "scripts/outbound.mjs",
    find: 'name.slice(0, 140)',
    replace: 'name.slice(0, 20)',
    // "不认识"的条目要把名字给全到能分清后缀（key 占 64 位）—— 截到 20 位就只剩 hex 前缀。
    killedBy: "run 通道排空",
  },
  {
    id: "m-upgrade-full",
    file: "scripts/layered-status.mjs",
    find: 'key.length > 0 ? key.slice(0, 8) : "--------"',
    replace: 'key.length > 0 ? key.slice(0, 7) : "--------"',
    // 故意写错：shortKey 少一位是**状态页**那条用例杀的，这里填的是账本 consumed 的用例，
    // 它会通过 → runner 必须升级全量，而不是就地算存活。
    killedBy: "claim 终态 consumed",
  },
  {
    id: "m-anchor-missing",
    file: "scripts/outbound.mjs",
    find: "这一段文字在本仓不存在（示例锚点 m-anchor-missing）",
    replace: "随便改点什么",
    killedBy: "run 通道排空",
  },
];

const gitClean = (rel) => spawnSync("git", ["status", "--porcelain", "--", rel],
  { cwd: ROOT, encoding: "utf-8" }).stdout.trim() === "";

/** 正则（带 g）最后一次命中的结果 —— 套件输出里可能嵌着别人打印的汇总行。 */
function lastMatch(re, text) {
  let found = null;
  for (const m of text.matchAll(re)) found = m;
  return found;
}

/**
 * 跑一次套件。filter=null 表示全量（显式删掉 TEST_FILTER，别让它从环境里漏进来）。
 *
 * 返回 verdict：red 只在"打了汇总行而且失败 > 0"时给。套件没打汇总（崩在中间）、
 * 退出码 1 但失败 0（汇总之外挂的）都算 crashed —— 不收到 red 里去，否则
 * "套件自己崩了"会被记成"守卫把它杀了"，那正是变异测试最怕的假信号。
 */
function runSuite(filter) {
  const env = { ...process.env };
  if (filter === null) delete env.TEST_FILTER; else env.TEST_FILTER = filter;
  const r = spawnSync(process.execPath, [SUITE], {
    cwd: ROOT, env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
    timeout: filter === null ? FULL_TIMEOUT_MS : TARGETED_TIMEOUT_MS,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(out);            // 套件输出一行不吞，人要看得到红在哪
  if (r.signal) return { verdict: "crashed", why: "被 " + r.signal + " 打断（超时？） —— 不算转红" };
  if (typeof r.status !== "number") return { verdict: "crashed", why: "套件起不来：" + String(r.error?.message ?? r.status) };
  const summary = lastMatch(/通过 (\d+) \/ 失败 (\d+)/gu, out);   // 取最后一次：拿第一次会把嵌套运行的结果当本轮的
  if (!summary) return { verdict: "crashed", why: "没打印汇总行（退出码 " + r.status + "）—— 红绿都不能记" };
  const failed = Number(summary[2]);
  if (filter !== null) {
    const hit = lastMatch(/TEST_FILTER 命中 (\d+) \/ 总 (\d+)/gu, out);
    if (!hit) return { verdict: "crashed", why: "该跑的是过滤运行却没打 TEST_FILTER 命中行 —— 汇总不可信" };
    if (Number(hit[1]) === 0) return { verdict: "no_match", why: "命中 0 / 总 " + hit[2] };
  }
  if (r.status === 0 && failed === 0) return { verdict: "green", why: "通过 " + summary[1] };
  if (r.status === 1 && failed > 0) return { verdict: "red", why: "失败 " + failed + " / 共 " + summary[1] };
  return { verdict: "crashed", why: "退出码 " + r.status + "、失败 " + failed + " —— 对不上（汇总之外挂了）" };
}

/** 锚点核对 + 落盘变异。只改确实过了核对的文件；失败时文件一个字节都没动。 */
function apply(m) {
  const abs = path.resolve(ROOT, m.file);
  if (!abs.startsWith(ROOT + path.sep)) return { err: "变异目标越出仓外：" + m.file };
  if (!fs.existsSync(abs)) return { err: "文件不存在：" + m.file };
  const src = fs.readFileSync(abs, "utf-8");
  const hits = src.split(m.find).length - 1;
  if (hits !== 1) return { err: "锚点命中 " + hits + " 次（要求恰好 1 次），不改文件：" + m.file };
  if (!gitClean(m.file)) return { err: "工作树里 " + m.file + " 有未提交改动 —— 还原会盖掉它，先收干净" };
  fs.writeFileSync(abs, src.replace(m.find, m.replace));
  return { abs, src };
}

function restore(applied) {
  fs.writeFileSync(applied.abs, applied.src);
  if (fs.readFileSync(applied.abs, "utf-8") !== applied.src) throw new Error("还原后内容与原文不一致：" + applied.abs);
}

function syntaxOk(abs) {
  const r = spawnSync(process.execPath, ["--check", abs], { cwd: ROOT, encoding: "utf-8", timeout: 60_000 });
  if (r.status !== 0) console.log((r.stderr ?? "").trim());
  return r.status === 0;
}

/**
 * 并行模式（--jobs N）：父进程做锚点核对 + **一次**全量基线（不让 N 个 worker 各付 150s），
 * 然后 `git worktree add --detach` 出 N 份隔离工作树，把变异分片派给 N 个子 runner
 *（--root <worktree> --assume-green），收集各自输出与汇总后加总；finally 一律 worktree remove。
 * 每路的套件沙箱（mkdtemp）互不相干；代价只是 CPU 高峰。失败一路不拖累别路。
 */
function main(argv) {
  // 默认跑真实表；DEMOS 三条只有 --ids 显式点名才够得到（它们是 runner 自己的演示，不是仓库守卫）。
  const ALL = [...TABLE, ...DEMOS];
  let picked = TABLE;
  let jobs = 1;
  let assumeGreen = false;
  let workerToken = null;
  let workerCommit = null;
  const rest = [...argv];
  while (rest.length > 0 && rest[0].startsWith("--") && rest[0] !== "--ids") {
    const flag = rest.shift();
    if (flag === "--root") { const v = rest.shift(); if (!v || !fs.existsSync(v)) { console.error("--root 要给存在的目录"); return 2; } ROOT = path.resolve(v); continue; }
    if (flag === "--assume-green") { assumeGreen = true; continue; }
    if (flag === "--worker-token") { workerToken = rest.shift() ?? null; continue; }
    if (flag === "--commit") { workerCommit = rest.shift() ?? null; continue; }
    if (flag === "--jobs") { const v = Number(rest.shift()); if (!Number.isSafeInteger(v) || v < 1 || v > 8) { console.error("--jobs 要是 1–8 的整数"); return 2; } jobs = v; continue; }
    console.error("不认识参数：" + flag + "\n用法：node references/mutation-runner.mjs [--jobs N] [--ids id …]");
    return 2;
  }
  // ── 证据必须绑定**干净提交**（评审探针：test.mjs 脏时仍报 KILLED/退出 0）：任何套件跑之前，
  // git 可用、整树 tracked 无未提交改动，冻结 commit SHA —— 并行 worker 的 worktree 也检出这个 SHA 并复核。
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
  if (rev.status !== 0) { console.error("✗ git rev-parse HEAD 失败（不在 git 仓里？）—— 变异证据必须绑定提交，不跑"); return 2; }
  const frozenSha = rev.stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain", "-uno"], { cwd: ROOT, encoding: "utf-8" });
  if (dirty.status !== 0 || dirty.stdout.trim() !== "") {
    console.error("✗ 工作树有未提交改动（tracked）—— 变异证据必须绑定干净提交，先提交或还原：\n" + (dirty.stdout ?? "").trim());
    return 2;
  }
  // ── --assume-green 是并行 worker 的**内部协议**（评审探针：裸调可无凭据跳过第一层全量基线）：
  // 必须带父进程的一次性凭据（--worker-token 与 env MUTATION_RUNNER_TOKEN 一致）与父进程冻结的 --commit，且本 worktree 的 HEAD 与之相同。
  if (assumeGreen) {
    if (!workerToken || process.env.MUTATION_RUNNER_TOKEN !== workerToken || !workerCommit) {
      console.error("✗ --assume-green 是 --jobs 并行 worker 的内部协议（要求父进程一次性凭据与冻结 commit）；普通调用请去掉它，让 runner 自己跑全量基线");
      return 2;
    }
    if (frozenSha !== workerCommit) { console.error("✗ worktree HEAD " + frozenSha.slice(0, 12) + " ≠ 父进程冻结的 " + workerCommit.slice(0, 12) + " —— 拒跑"); return 2; }
  } else {
    console.log("— 证据绑定 commit " + frozenSha.slice(0, 12) + "（整树 tracked 干净）");
  }
  if (rest[0] === "--ids") {
    const want = rest.slice(1);
    if (want.length === 0) { console.error("--ids 后面要给 id（可用：" + ALL.map((x) => x.id).join(" ") + "）"); return 2; }
    picked = want.map((id) => ALL.find((x) => x.id === id)
      ?? { id, missing: true, file: "-", find: "-", replace: "-", killedBy: "-" });
  } else if (rest.length > 0) {
    console.error("不认识参数：" + rest.join(" ") + "\n用法：node references/mutation-runner.mjs [--root DIR] [--assume-green] [--jobs N] [--ids id …]");
    return 2;
  }
  if (jobs > 1) return mainParallel(picked, jobs, frozenSha);

  // ① 锚点先全体核对（纯字符串，不跑套件）—— 一条都不用跑时不必花那 2.5 分钟基线。
  const ready = [];
  const anomalies = [];
  for (const m of picked) {
    if (m.missing) { anomalies.push([m.id, "unknown_id：表里没有这个变异"]); continue; }
    const abs = path.resolve(ROOT, m.file);
    const hits = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8").split(m.find).length - 1 : -1;
    if (hits !== 1) {
      anomalies.push([m.id, "anchor_error：锚点在 " + m.file + " 里命中 "
        + (hits === -1 ? "（文件不存在）" : hits + " 次") + "，要求恰好 1 次 —— 一个字节都没改"]);
      continue;
    }
    ready.push(m);
  }

  let killed = 0; let survived = 0;
  if (ready.length > 0) {
    // ② 全量基线：未变异的代码必须全绿，否则后面每个变异都会"被击杀"。--assume-green（并行子进程）时父进程已验过，跳过。
    if (!assumeGreen) {
      console.log("— 全量基线（未变异）：" + SUITE);
      const base = runSuite(null);
      if (base.verdict !== "green") {
        console.log("\n✗ 全量基线就没绿（" + base.verdict + "：" + base.why
          + "）—— 这时任何变异都会被读成 KILLED，整轮结论都是假的。先把套件修绿。");
        return 1;
      }
    }
    for (const m of ready) {
      console.log("\n=== " + m.id + "  " + m.file + "  killedBy=" + JSON.stringify(m.killedBy));
      let applied = null;
      try {
        // ③ 定向基线：过滤器在这条变异上到底挑到了谁，未变异时必须过。
        const t0 = Date.now();
        const baseline = runSuite(m.killedBy);
        if (baseline.verdict === "no_match") { anomalies.push([m.id, "filter_misses：TEST_FILTER=" + m.killedBy
          + " 在 Claude 套件里一个名字都没命中（表的 killedBy 写错了，或这条守卫只有 Codex 侧有）"]); continue; }
        if (baseline.verdict !== "green") { anomalies.push([m.id, "baseline_" + baseline.verdict + "：未变异的代码上这条过滤器就不干净（" + baseline.why
          + "）—— 不算击杀，先修表或修套件"]); continue; }
        console.log("  定向基线绿（" + ((Date.now() - t0) / 1000).toFixed(1) + "s），落变异");

        applied = apply(m);
        if (applied.err) { anomalies.push([m.id, "apply_error：" + applied.err]); applied = null; continue; }
        if (!syntaxOk(applied.abs)) { anomalies.push([m.id, "mutant_broken：变异体语法就坏了，红也算不到守卫头上"]); continue; }

        const t1 = Date.now();
        const targeted = runSuite(m.killedBy);
        if (targeted.verdict === "red") { killed += 1; console.log("  KILLED（定向，" + ((Date.now() - t1) / 1000).toFixed(1) + "s）"); continue; }
        if (targeted.verdict !== "green") { anomalies.push([m.id, "targeted_" + targeted.verdict + "：" + targeted.why]); continue; }
        console.log("  定向没红 → 升级全量确认（判据是全量，不是定向）");
        const t2 = Date.now();
        const full = runSuite(null);
        if (full.verdict === "red") { killed += 1; console.log("  KILLED（升级全量才红，" + ((Date.now() - t2) / 1000).toFixed(0) + "s；红在哪个用例见上面 ✗ 行 —— 顺手核对不是偶发用例）"); continue; }
        if (full.verdict !== "green") { anomalies.push([m.id, "full_" + full.verdict + "：" + full.why]); continue; }
        survived += 1;
        console.log("  SURVIVED：全量也没红 —— 改坏了而没人报警");
      } catch (err) {
        anomalies.push([m.id, "error：" + (err?.message ?? String(err))]);
      } finally {
        if (applied) {
          try { restore(applied); console.log("  已还原 " + m.file); }
          catch (err) { anomalies.push([m.id, "restore_failed：" + (err?.message ?? String(err)) + " —— 手工 git checkout " + m.file]); }
        }
      }
    }
  }

  console.log("\nKILLED " + killed + " / SURVIVED " + survived + " / 异常 " + anomalies.length);
  for (const [id, why] of anomalies) console.log("  ! " + id + "：" + why);
  return survived + anomalies.length > 0 ? 1 : 0;
}

/**
 * 并行编排：锚点核对与全量基线在主根做一次（主根已核过"干净提交"），worktree 检出**冻结的 SHA**（不是运行时再解析 HEAD），
 * worker 用一次性凭据（env + --worker-token）+ --commit 复核后才许 --assume-green。
 * 启动失败、worker 崩溃、汇总对不上分片数、worktree 清理失败都计异常、非零退出、点名路径（评审返修：曾被吞成"异常 0"）。
 */
async function mainParallel(picked, jobs, frozenSha) {
  const bad = picked.filter((m) => m.missing);
  for (const m of bad) console.log("  ! " + m.id + "：unknown_id：表里没有这个变异");
  const real = picked.filter((m) => !m.missing);
  if (real.length === 0) return 1;
  console.log("— 证据绑定 commit " + frozenSha.slice(0, 12) + "（整树 tracked 干净）");
  console.log("— 全量基线（未变异，主根一次）：" + SUITE);
  const base = runSuite(null);
  if (base.verdict !== "green") { console.log("✗ 全量基线就没绿（" + base.verdict + "：" + base.why + "），整轮不跑。"); return 1; }
  const token = (await import("node:crypto")).randomUUID();
  const n = Math.min(jobs, real.length);
  const chunks = Array.from({ length: n }, () => []);
  real.forEach((m, i) => chunks[i % n].push(m));
  const wts = [];
  const results = [];
  const cleanupFailures = [];
  try {
    for (let i = 0; i < n; i += 1) {
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-wt-"));
      fs.rmdirSync(wt); // git worktree add 要求目标不存在
      const add = spawnSync("git", ["worktree", "add", "--detach", wt, frozenSha], { cwd: ROOT, encoding: "utf-8" });
      if (add.status !== 0) { console.log("✗ 建 worktree 失败：" + (add.stderr ?? "").trim()); return 1; }
      wts.push(wt);
    }
    await Promise.all(chunks.map((chunk, i) => new Promise((resolve) => {
      const args = [path.join(ROOT, "references", "mutation-runner.mjs"), "--root", wts[i], "--assume-green", "--worker-token", token, "--commit", frozenSha, "--ids", ...chunk.map((m) => m.id)];
      const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, MUTATION_RUNNER_TOKEN: token } });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("error", (err) => { results[i] = { code: null, out: out + "\n[spawn error] " + String(err?.message ?? err), ids: chunk.map((m) => m.id) }; resolve(); });
      child.on("close", (code) => { results[i] = { code, out, ids: chunk.map((m) => m.id) }; resolve(); });
    })));
  } finally {
    for (const wt of wts) {
      const rm = spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: ROOT, encoding: "utf-8" });
      if (rm.status !== 0) cleanupFailures.push(wt + "（" + (rm.stderr ?? "").trim().slice(0, 120) + "）");
    }
  }
  let killed = 0; let survived = 0; let anomalies = bad.length;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i] ?? { code: null, out: "[worker 没有结果]", ids: chunks[i].map((m) => m.id) };
    console.log("\n──── worker " + (i + 1) + "（" + r.ids.join(" ") + "）────");
    process.stdout.write(r.out);
    const sum = lastMatch(/KILLED (\d+) \/ SURVIVED (\d+) \/ 异常 (\d+)/gu, r.out);
    // worker 的退出码要与汇总互证；汇总三桶之和要等于分片条数（只验结构不验自洽等于没验）
    if (!sum || (r.code !== 0 && r.code !== 1)) { console.log("  ! worker " + (i + 1) + (sum ? " 退出码异常（" + r.code + "）" : " 没打汇总（退出码 " + r.code + "）") + " —— 这一片的结论作废"); anomalies += r.ids.length; continue; }
    const [k, s, a] = [Number(sum[1]), Number(sum[2]), Number(sum[3])];
    if (k + s + a !== r.ids.length) { console.log("  ! worker " + (i + 1) + " 汇总 " + (k + s + a) + " ≠ 分片 " + r.ids.length + " 条 —— 这一片的结论作废"); anomalies += r.ids.length; continue; }
    killed += k; survived += s; anomalies += a;
  }
  if (cleanupFailures.length > 0) {
    anomalies += cleanupFailures.length;
    console.log("  ! worktree 清理失败 " + cleanupFailures.length + " 处（残留请人工 git worktree remove --force）：\n    " + cleanupFailures.join("\n    "));
  }
  console.log("\n═══ 并行总汇 ═══\nKILLED " + killed + " / SURVIVED " + survived + " / 异常 " + anomalies);
  return survived + anomalies > 0 ? 1 : 0;
}

if (isDirectRun(import.meta.url)) Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
