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
import { sweepEligible } from "./drain-all.mjs";
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

export function plistBody({ home = os.homedir(), node = pickNode(),
  codexHome = codexHomeOf(home) } = {}) {
  const script = drainScriptPath(home, codexHome);
  const workdir = path.join(codexRuntimeRoot(codexHome), "current");
  const log = path.join(codexHome, "feishu-bridge", "drain.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
  </array>
  <key>WorkingDirectory</key><string>${workdir}</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${home}</string>
    <key>FEISHU_CODEX_BRIDGE_HOME</key><string>${path.join(codexHome, "feishu-bridge")}</string>
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
  for (const t of reg.tasks ?? []) {
    let n = 0;
    try { n = listPending({ outboxDir: taskPaths(t, home).outbox }).length; }
    catch { return { ok: false, reason: "outbox_unreadable" }; }
    total += n;
    if (n > 0) tasks.push({ key: t?.logical_task_key ?? null, pending: n });
  }
  return { ok: true, total, tasks };
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
      : loadedPhase(),
    enabled: installed !== null,
    stale: installed !== null && installed !== wanted,
    plist: file,
    backlog,
  };
}

/**
 * launchd 里到底有没有它。**读不出来就说读不出来**，不许由"文件在"推出"在跑"。
 */
export function loadedPhase(run = spawnLaunchctl) {
  const r = run(["list", LAUNCH_LABEL]);
  if (r.ok) return "loaded";
  // 明确的"没这个服务"和"我查不了"是两件事。
  if (typeof r.detail === "string" && /could not find|No such/iu.test(r.detail)) {
    return "installed_not_loaded";
  }
  return "unverifiable";
}

export const PHASE_TEXT = {
  absent: "未启用（安装后的默认态，不是故障）",
  stale: "plist 与当前运行时对不上（要重装）",
  installed_not_loaded: "**plist 已写入但没被 launchd 加载 —— 定时器不会跑**",
  loaded: "已加载，正在按计划跑",
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
export function scanRunnable({ home = bridgeHome(), sweep } = {}) {
  const run = sweep ?? sweepEligible;
  try {
    const r = run({ home, publish: () => ({ status: "dry" }) });
    return r.ok ? { ok: true, tasks: r.results.length } : { ok: false, reason: r.reason };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
  }
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
  if (r.status === 0) return { ok: true };
  return { ok: false, detail: (r.stderr || r.stdout || "status " + r.status).trim() };
}

if (isDirectRun(import.meta.url)) main();
