#!/usr/bin/env node
/**
 * Codex 链的兜底排空调度器 —— **启用/停用是一条独立命令，不是安装的一个开关。**
 *
 * 为什么独立：评审的裁决。做成 `install --enable-drain` 那种可选参数，
 * "装了但没启用"就还是某个条件组合的结果；做成独立命令，它才是**默认态**。
 * 检查漏了就自动启用，那种 fail-open 这个仓库刚栽过一次
 * （空白目标代际绕过全部守卫）。
 *
 * 启用前要过的门槛（任何一条不过就拒绝，什么都不写）：
 *   1. runtime/current 完整性校验通过
 *   2. 调度器指向的正是 runtime/current，不是任何开发克隆
 *   3. 登记表可读
 *   4. eligible-only 扫描能跑通
 *   5. **历史积压已分类** —— 有未处理的待发内容时拒绝启用
 *
 * 第 5 条是这条命令存在的主要理由：Codex 链一直没有兜底定时器，
 * outbox 里攒着一批历史内容。装上定时器的那一刻它们会被发出去 ——
 * 而那批东西已经确认过是不该发的。**先分类，再启用。**
 *
 * 用法：
 *   node scripts/codex/drain-service.mjs            # 只报状态，什么都不写
 *   node scripts/codex/drain-service.mjs --enable --apply
 *   node scripts/codex/drain-service.mjs --disable --apply
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectRun } from "../direct-run.mjs";
import { listPending } from "../outbox.mjs";
import { codexRuntimeRoot, verifyRuntime } from "../runtime-install.mjs";
import { preflightTask } from "./publish-eligible.mjs";
import { bridgeHome, loadRegistry, registryFile, taskPaths } from "./state.mjs";

const CHAIN = "codex";
export const LAUNCH_LABEL = "com.frank.feishu-bridge-codex.drain";

export const plistPath = (home = os.homedir()) =>
  path.join(home, "Library", "LaunchAgents", LAUNCH_LABEL + ".plist");

const pickNode = () => {
  for (const file of ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]) {
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return process.execPath;
};

/**
 * 调度器要跑的脚本。**只能是 runtime/current 下那一份。**
 * 定时器一装就是长期存在的东西，让它指向某个开发克隆，等于把线上行为
 * 长期绑在某人的工作目录上。
 */
export const drainScriptPath = (home = os.homedir(), codexHome = codexHomeOf(home)) =>
  path.join(codexRuntimeRoot(codexHome), "current", "scripts", "codex", "drain-all.mjs");

/**
 * 这台机器上 Codex 的家目录。**CODEX_HOME 优先** —— 它是这条链的隔离点，
 * 绕过它就会在只隔离了 CODEX_HOME 的测试里写到真机。
 */
export const codexHomeOf = (home = os.homedir()) =>
  process.env.CODEX_HOME || path.join(home, ".codex");

/**
 * plist 是 XML —— **路径必须转义**。
 *
 * 家目录里出现 `&` 就足以让整份 plist 变成非法 XML：launchd 加载失败，
 * 而我们写文件那一步是"成功"的。含空格和中文的路径这个仓库已经栽过一次
 * （那次是 shell 引号），XML 是同一个道理换了一种语法。
 */
const xml = (text) => String(text)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plistBody({ home = os.homedir(), node = pickNode(),
  codexHome = codexHomeOf(home) } = {}) {
  const script = drainScriptPath(home, codexHome);
  const workdir = path.join(codexRuntimeRoot(codexHome), "current");
  const log = path.join(codexHome, "feishu-bridge", "drain.log");
  const [xNode, xScript, xWork, xLog, xHome, xBridge] =
    [node, script, workdir, log, home, path.join(codexHome, "feishu-bridge")].map(xml);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xNode}</string>
    <string>${xScript}</string>
  </array>
  <key>WorkingDirectory</key><string>${xWork}</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xLog}</string>
  <key>StandardErrorPath</key><string>${xLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${xHome}</string>
    <key>FEISHU_CODEX_BRIDGE_HOME</key><string>${xBridge}</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * 数一遍还没处理的历史待发内容。
 *
 * **只数、不解释。**返回 per-task 的条数让调用方决定 ——
 * 这里替它判断"这些应该发/不该发"就是在替人做那个不可逆的决定。
 */
export function classifyBacklog({ home = bridgeHome() } = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return { ok: false, reason: "registry_unreadable" };
  const tasks = [];
  let total = 0;
  let unreadable = 0;
  for (const t of reg.tasks ?? []) {
    const outboxDir = taskPaths(t, home).outbox;
    let n = 0;
    try { n = listPending({ outboxDir }).length; }
    catch { return { ok: false, reason: "outbox_unreadable" }; }
    // **listPending 会静默跳过读不出来的文件。**于是一个装满坏 JSON 的 outbox
    // 会被数成"0 条积压"，门槛放行，定时器装上 —— 而那些文件到底是什么内容
    // 谁也不知道。**读不出来不等于没有**，这跟登记表那条是同一个道理。
    const bad = unreadableRecords(outboxDir);
    unreadable += bad.length;
    total += n;
    if (n > 0 || bad.length > 0) {
      tasks.push({ key: t?.logical_task_key ?? null, pending: n, unreadable: bad.length });
    }
  }
  return { ok: true, total, unreadable, tasks };
}

/** outbox 里有几个文件根本读不出来。listPending 会跳过它们，所以要单独数。 */
export function unreadableRecords(outboxDir) {
  let files;
  try { files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")); }
  catch { return []; }
  const bad = [];
  for (const f of files) {
    try { JSON.parse(fs.readFileSync(path.join(outboxDir, f), "utf-8")); }
    catch { bad.push(f); }
  }
  return bad;
}

/**
 * 现在处于哪个状态。**"未启用"是安装后的正常态，不是故障。**
 * 把它报成故障，人就会去"修"一件本来就该这样的事。
 */
export function serviceState({ home = os.homedir(), bridge = bridgeHome(),
  codexHome = codexHomeOf(home) } = {}) {
  const runtime = verifyRuntime({ root: codexRuntimeRoot(codexHome) });
  const file = plistPath(home);
  let installed = null;
  try { installed = fs.readFileSync(file, "utf-8"); } catch { /* 没装 */ }
  const wanted = plistBody({ home, codexHome });
  const backlog = classifyBacklog({ home: bridge });
  const scan = scanRunnable({ home: bridge });
  return {
    scan,
    runtimeOk: runtime.ok === true,
    runtimeReason: runtime.ok ? null : (runtime.reason ?? "drift"),
    // **四态，不是"文件在不在"。**plist 写了但没 bootstrap 成功的话，
    // 定时器根本不会跑 —— 而只看文件存在会报"已启用"，
    // 那正是"界面说正常、实际不工作"的形状。
    phase: installed === null ? "absent"
      : installed !== wanted ? "stale"
      : loadedPhase(spawnLaunchctl, drainScriptPath(home, codexHome)),
    enabled: installed !== null,
    stale: installed !== null && installed !== wanted,
    plist: file,
    backlog,
  };
}

/**
 * launchd 里到底有没有它。**读不出来就说读不出来**，不许由"文件在"推出"在跑"。
 */
export function loadedPhase(run = spawnLaunchctl, expectScript = null) {
  const r = run(["list", LAUNCH_LABEL]);
  if (!r.ok) {
    // 明确的"没这个服务"和"我查不了"是两件事。
    if (typeof r.detail === "string" && /could not find|No such/iu.test(r.detail)) {
      return "installed_not_loaded";
    }
    return "unverifiable";
  }
  // **同名 job 在，不等于跑的是我们刚写的那份。**
  //
  // 先写新 plist 再 bootstrap，失败时 plist 留在原地；而如果旧的同名 job 还在
  // launchd 里跑着，只看"有没有这个 label"就会报"已加载，正在按计划跑"——
  // 实际跑的是旧配置。评审用这个场景做出了假绿。
  if (expectScript !== null) {
    const args = typeof r.stdout === "string" ? r.stdout : "";
    if (!args.includes(expectScript)) return "loaded_other";
  }
  return "loaded";
}

export const PHASE_TEXT = {
  absent: "未启用（安装后的默认态，不是故障）",
  stale: "plist 与当前运行时对不上（要重装）",
  installed_not_loaded: "**plist 已写入但没被 launchd 加载 —— 定时器不会跑**",
  loaded: "已加载，正在按计划跑",
  loaded_other: "**同名 job 在跑，但参数不是当前这份 —— 跑的多半是旧配置**",
  unverifiable: "plist 已写入；launchd 状态查不出来（不等于在跑）",
};

/**
 * 能不能启用。**每一条都是硬门槛，任何一条不过就什么都不写。**
 * 返回全部未过的项，不是第一条 —— 一次说清比让人来回试三遍强。
 */
/**
 * eligible-only 扫描本身跑不跑得通。
 *
 * **不发任何东西 —— 注入一个只观察的 publish。**上一版我在文档里把这道门槛
 * 写成了"已有"，实际根本没实现："不确定的事别写成确定"，这次栽在自己写的注释上。
 */
export function scanRunnable({ home = bridgeHome(), preflight = preflightTask } = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return { ok: false, reason: "registry_unreadable" };
  const broken = [];
  for (const task of reg.tasks ?? []) {
    let r;
    try { r = preflight({ task, home }); }
    catch (err) { r = { ok: false, status: "error",
      reason: String(err?.message ?? err).slice(0, 120) }; }
    // disabled / skipped 是正常状态（没开自动发布、mapping 没激活）——
    // 只有 error 才说明这条链本身跑不通。
    if (!r.ok && r.status === "error") {
      broken.push({ key: task?.logical_task_key ?? null, reason: r.reason });
    }
  }
  if (broken.length > 0) {
    return { ok: false,
      reason: broken.map((b) => (b.key ?? "?") + "：" + b.reason).join("；") };
  }
  return { ok: true, tasks: (reg.tasks ?? []).length };
}

export function enableBlockers(state) {
  const blockers = [];
  if (state.scan && !state.scan.ok) {
    blockers.push({ code: "scan_failed", detail: state.scan.reason });
  }
  if (!state.runtimeOk) {
    blockers.push({ code: "runtime_unverified", detail: state.runtimeReason });
  }
  if (!state.backlog.ok) {
    blockers.push({ code: "backlog_unreadable", detail: state.backlog.reason });
  } else if (state.backlog.total > 0) {
    blockers.push({ code: "backlog_unclassified", detail: state.backlog.total + " 条待发" });
  }
  if (state.backlog.ok && (state.backlog.unreadable ?? 0) > 0) {
    blockers.push({ code: "backlog_corrupt",
      detail: state.backlog.unreadable + " 个文件读不出来" });
  }
  return blockers;
}

function main() {
  const argv = process.argv.slice(2);
  const known = new Set(["--enable", "--disable", "--apply"]);
  const bad = argv.filter((a) => !known.has(a));
  if (bad.length > 0) {
    console.error("认不出的参数：" + bad.join(" "));
    console.error("  只接受 --enable / --disable / --apply");
    process.exit(1);
  }
  const enable = argv.includes("--enable");
  const disable = argv.includes("--disable");
  const apply = argv.includes("--apply");
  if (enable && disable) {
    console.error("--enable 和 --disable 只能给一个。");
    process.exit(1);
  }

  const home = os.homedir();
  const st = serviceState({ home });

  console.log("调度器    " + st.plist);
  console.log("状态      " + (PHASE_TEXT[st.phase] ?? st.phase));
  console.log("运行时    " + (st.runtimeOk
    ? "校验通过" : "**校验不过**（" + st.runtimeReason + "）"));
  console.log("排空脚本  " + drainScriptPath(home));
  if (st.backlog.ok && (st.backlog.unreadable ?? 0) > 0) {
    console.log("损坏文件  **" + st.backlog.unreadable + " 个读不出来**（不计入待发数）");
  }
  console.log("链路预检  " + (st.scan.ok
    ? "通过（" + st.scan.tasks + " 个 task 走真实发布前置检查）"
    : "**跑不通**（" + st.scan.reason + "）"));
  if (st.backlog.ok) {
    console.log("历史积压  " + st.backlog.total + " 条" +
      (st.backlog.total > 0 ? "（分布在 " + st.backlog.tasks.length + " 个 task）" : ""));
  } else {
    console.log("历史积压  读不出来（" + st.backlog.reason + "）");
  }

  if (!enable && !disable) {
    console.log("\n只报状态。要动它加 --enable --apply 或 --disable --apply。");
    process.exit(0);
  }

  if (enable) {
    const blockers = enableBlockers(st);
    if (blockers.length > 0) {
      console.error("\n不能启用，什么都没写：");
      for (const b of blockers) {
        if (b.code === "backlog_unclassified") {
          console.error("  · 还有 " + b.detail + " 没处理。**定时器一启用它们就会被发出去** ——");
          console.error("    先决定这批内容是发还是停（scripts/codex/suppress-outbox.mjs），");
          console.error("    再回来启用。这一步不许省：省掉它就是替人做了一个不可逆的决定。");
        } else if (b.code === "backlog_corrupt") {
          console.error("  · outbox 里有 " + b.detail + "。**读不出来不等于没有** ——");
          console.error("    这些文件是什么内容谁也不知道，不能当成「没有积压」放行。");
        } else if (b.code === "scan_failed") {
          console.error("  · eligible-only 扫描跑不通（" + b.detail + "）——");
          console.error("    定时器要跑的就是它，跑不通就不能装。");
        } else if (b.code === "runtime_unverified") {
          console.error("  · 运行时校验不过（" + b.detail + "）—— 先跑 scripts/codex/install.mjs --apply。");
        } else {
          console.error("  · " + b.code + "（" + b.detail + "）");
        }
      }
      process.exit(1);
    }
  }

  if (!apply) {
    console.log("\n[dry-run] 什么都没写。加 --apply 才生效。");
    process.exit(0);
  }

  if (disable) {
    if (!st.enabled) { console.log("\n本来就没启用，什么都没做。"); process.exit(0); }
    try {
      const r = spawnLaunchctl(["bootout", "gui/" + process.getuid() + "/" + LAUNCH_LABEL]);
      if (!r.ok) console.log("（launchctl bootout 没成功，继续删 plist：" + r.detail + "）");
    } catch { /* 卸载失败不阻断删文件 */ }
    fs.rmSync(st.plist, { force: true });
    console.log("\n已停用。plist 已删除。");
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(st.plist), { recursive: true });
  // **先把同名的旧 job 卸掉。**不卸的话 bootstrap 会因"已存在"失败，
  // 而旧 job 继续按旧配置跑 —— 那正是"报了错却仍显示已加载"的来源。
  spawnLaunchctl(["bootout", "gui/" + process.getuid() + "/" + LAUNCH_LABEL]);
  fs.writeFileSync(st.plist, plistBody({ home }), { mode: 0o644 });
  const loaded = spawnLaunchctl(["bootstrap", "gui/" + process.getuid(), st.plist]);
  if (!loaded.ok) {
    // **加载失败必须非零退出。**报成功而定时器没在跑，就是"界面说正常、实际不工作"——
    // 兜底本来就是最后一道，它悄悄不工作的话没有第二处会发现。
    console.error("\nplist 已写入，但 launchd 加载失败：" + loaded.detail);
    console.error("**定时器现在不会跑。**修好后重跑本命令。");
    process.exit(1);
  }
  console.log("\n已启用，定时器已加载。");
  console.log("每 30 分钟扫一次全部登记 task；**只发已取得发布资格的内容**。");
}

function spawnLaunchctl(args) {
  const r = spawnSync("launchctl", args, { encoding: "utf-8" });
  // stdout 要带回来 —— 核验"跑的是不是我们这份"靠的就是它。
  if (r.status === 0) return { ok: true, stdout: r.stdout ?? "" };
  return { ok: false, detail: (r.stderr || r.stdout || "status " + r.status).trim() };
}

if (isDirectRun(import.meta.url)) main();
