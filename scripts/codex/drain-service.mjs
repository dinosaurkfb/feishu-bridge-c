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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectRun } from "../direct-run.mjs";
import { acquireInstallSurfaceLockOrRefuse } from "../install-surface-lock.mjs";
import {
  LAUNCHCTL_ENV, PHASE_TEXT, absentJob, loadedPhase as loadedPhaseOf, parseLaunchctlList, spawnLaunchctl,
} from "../launchd-job.mjs";
// launchd 原语住在共用层（launchd-job.mjs）；这里原样再导出，Codex 侧的调用方不用改。
export { LAUNCHCTL_ENV, PHASE_TEXT, absentJob, parseLaunchctlList };
/** Codex 兜底服务自己的 label 是默认值 —— 判据仍是共用的那一份。 */
export function loadedPhase(run = spawnLaunchctl, expect = null, label = LAUNCH_LABEL) {
  return loadedPhaseOf(run, expect, label);
}
import { auditOutbox } from "../outbox.mjs";

// **auditOutbox 住在 scripts/outbox.mjs**（listPending 的隔壁）——
// 抑制核心和 Claude 侧也要用它，留在 Codex 适配器里两侧就够不着。
// 这里转出只是不打断既有导入点；**定义只有一份**。
export { auditOutbox };
import { codexRuntimeRoot, verifyRuntime } from "../runtime-install.mjs";
import { preflightTask } from "./publish-eligible.mjs";
import { bridgeHome, loadRegistry, registryFile, taskPaths } from "./state.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";
import { systemdExecStartValue, systemdShowExecArgv, systemdUnitAbsent, timerPlatform, resolveNodeForHooks, unitFirstArg } from "../install-projection.mjs";
import { systemctl } from "../timer-exec.mjs";
import { SYSTEMCTL_STATE_WORDS } from "../maintenance/timers.mjs";

const CHAIN = "codex";
export const LAUNCH_LABEL = "com.frank.feishu-bridge-codex.drain";
export const CODEX_DRAIN_SYSTEMD_UNIT = "feishu-bridge-codex-drain";

export const plistPath = (home = os.homedir()) =>
  path.join(home, "Library", "LaunchAgents", LAUNCH_LABEL + ".plist");

export const codexDrainSystemdDir = (home = os.homedir()) =>
  path.join(home, ".config", "systemd", "user");

export const codexDrainSystemdPaths = (home = os.homedir()) => {
  const dir = codexDrainSystemdDir(home);
  return {
    dir,
    service: path.join(dir, CODEX_DRAIN_SYSTEMD_UNIT + ".service"),
    timer: path.join(dir, CODEX_DRAIN_SYSTEMD_UNIT + ".timer"),
  };
};

export const pickNode = (platform = process.platform, home = os.homedir()) => {
  if (platform === "linux") {
    // PK3-L7-fix3 P1-1：**解析失败就是失败，不回退 process.execPath。**
    //
    // 回退的后果不是“降级”，是把当前进程那个 node 写进**长期**单元：钩子/定时器是被 systemd 起的，
    // 而 process.execPath 常常是 mise 的 `installs/<版本>/bin/node` 真身 —— 升级清掉那个目录之后，
    // ExecStart 指向不存在的路径，定时器**静默失效**（没有任何一处会报）。那正是 omm 上已经发生过的
    // 故障形状，也是这条兜底本身要防的东西。所以这里把 resolveNodeForHooks 的错**原话**带出去，
    // 由调用方拒绝启用（含「显式 FEISHU_BRIDGE_NODE 不可用」那一种 —— 它本来是个配置错误，
    // 静默换成别的二进制会把它掩盖掉）。
    return resolveNodeForHooks({ homedir: home, platform: "linux" });
  }
  for (const file of ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]) {
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return process.execPath;
};

/** 这个路径现在是不是一个可执行的程序（判单元里那个 node 还在不在用）。 */
const isExecutable = (p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
};

/**
 * 把一个 shell 引号项里的转义还原（systemd 的 `shell_maybe_quote` 用的是 C 风格转义：`\xHH`，
 * 以及 `\"` / `\\` 这种反斜杠单字符形式）。
 */
const unescapeSystemdWord = (s) => String(s ?? "")
  .replace(/\\x([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  .replace(/\\(.)/gu, "$1");

/** 去掉恰好包住整个字符串的一对双引号（`"a b"` → `a b`；`a"b` 不动）。 */
const stripOuterQuotes = (s) => (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"") ? s.slice(1, -1) : s);

/**
 * 把 `systemctl show -p <某数组属性> --value` 的输出拆成**字符串项**：systemd 会对每个项调用
 * `shell_maybe_quote`，所以**整条 `NAME=value` 可能被一对双引号包住**（`"FEISHU_CODEX_BRIDGE_HOME=/a b"`）。
 * 双引号内允许 `\"` / `\\` / `\xHH`，解析时把转义序列**原样留着**，交给 unescapeSystemdWord 统一解。
 * 官方语义见 systemd 源码 `src/shared/bus-print-properties.c`（shell_maybe_quote）与 `src/basic/escape.c`。
 */
export const shellQuoteItems = (text) => {
  const items = [];
  let cur = "";
  let quoted = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === "\\" && i + 1 < s.length) { cur += ch + s[i + 1]; i += 1; continue; }
      if (ch === "\"") { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === "\"") { quoted = true; continue; }
    if (/\s/u.test(ch)) { if (cur.length > 0) { items.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur.length > 0) items.push(cur);
  return items;
};

/**
 * `systemctl show -p Environment --value` 里某个变量的值（null = 没有这个变量）。
 * 解析顺序（PK3-L7-fix5 P1-2）：**先按 shell 引号规则拆出每个字符串项**，再按**首个** `=` 分键值，
 * 最后解 C 转义。四种真实形状都要认：
 *   `NAME=/a/b`（裸值）、`"NAME=/a b"`（整条加引号）、`NAME="/a b"`、`NAME=/a\x20b`；也允许一条里多个变量并列。
 * 旧版只认后两种中的一部分，含空格的合法桥根会被误判成漂移（enable 后误报 loaded_other 并 exit 1）。
 */
export const systemdEnvValue = (text, name) => {
  for (const rawItem of shellQuoteItems(text)) {
    const item = unescapeSystemdWord(stripOuterQuotes(rawItem));
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    if (item.slice(0, eq) !== name) continue;
    return unescapeSystemdWord(stripOuterQuotes(item.slice(eq + 1)));
  }
  return null;
};

/**
 * 桥的状态根（`FEISHU_CODEX_BRIDGE_HOME`）—— **darwin plist 与 linux 单元用的是同一个值、同一来源**（PK3-L7-fix3 P1-2）。
 * 两处各算一遍就会漂：自定义 CODEX_HOME 时 plist 指向自定义桥根、而 systemd 那一份没有这个变量，
 * drain 跑起来会按默认 `~/.codex/feishu-bridge` 找状态 —— 运行时代码与状态目录分叉。
 */
/**
 * 桥的状态根（`FEISHU_CODEX_BRIDGE_HOME`）：**显式值优先，否则 codexHome/feishu-bridge**。
 *
 * 规则只有一份（codex/state.mjs 的 `bridgeHome`，不在这里另推导）—— 这里只是把 codexHome 也做成显式入参，
 * 否则沙箱 home 会被 os.homedir() 绕过去。
 *
 * **为什么不能从 codexHome 重新推导（PK3-L7-fix4 P1-1）**：显式 `FEISHU_CODEX_BRIDGE_HOME` 指到别处时，
 * 两种投影（systemd unit 的 `Environment=` / darwin plist 的 `EnvironmentVariables`）必须写**那个值** ——
 * 否则 drain 跑起来按默认桥根找状态，与安装时投影出来的东西分叉（运行时代码与状态目录各一套）。
 *
 * `codexHome` 是**必填**（PK3-L7-fix4 P2-2）：旧版把它写成自调用的默认参数 `codexBridgeHomeOf(codexHome = codexBridgeHomeOf())`，
 * 谁不传参就 RangeError（爆栈）—— 那种默认值不如没有。
 */
export function codexBridgeOf({ codexHome, env = process.env } = {}) {
  if (typeof codexHome !== "string" || codexHome.length === 0) {
    throw new Error("codexBridgeOf 需要显式的 codexHome（旧版有个会自调用爆栈的默认值，已去掉）");
  }
  const explicit = env?.FEISHU_CODEX_BRIDGE_HOME;
  return bridgeHome(typeof explicit === "string" && explicit.length > 0
    ? { CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: explicit }
    : { CODEX_HOME: codexHome });
}

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

/** launchd 里**应该**跑的东西。跟 plist 同源 —— 各写一份就会漂。 */
export function expectedJob({ home = os.homedir(), codexHome = codexHomeOf(home),
  platform = process.platform, node = pickNode(platform, home) } = {}) {
  return { node, args: [node, drainScriptPath(home, codexHome)] };
}

export function plistBody({ home = os.homedir(), node = pickNode(),
  codexHome = codexHomeOf(home), bridge = codexBridgeOf({ codexHome }) } = {}) {
  const script = drainScriptPath(home, codexHome);
  const workdir = path.join(codexRuntimeRoot(codexHome), "current");
  const log = path.join(codexHome, "feishu-bridge", "drain.log");
  const [xNode, xScript, xWork, xLog, xHome, xBridge] =
    [node, script, workdir, log, home, bridge].map(xml);
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

export function codexDrainSystemdUnits({
  home = os.homedir(),
  codexHome = codexHomeOf(home),
  bridge = codexBridgeOf({ codexHome }),
  node = pickNode("linux", home),
} = {}) {
  const script = drainScriptPath(home, codexHome);
  const workdir = path.join(codexRuntimeRoot(codexHome), "current");
  const log = path.join(codexHome, "feishu-bridge", "drain.log");
  const exec = systemdExecStartValue([node, script]);
  // PK3-L7-fix3 P1-2：与 darwin plist 的 EnvironmentVariables 那一条**同值同源**。
  // systemd 的引用规则对 Environment 值与 ExecStart 参数是同一条（systemd.syntax 的 quoted words），
  // 所以直接复用同一个引用函数 —— 各写一份引号规则就会漂（含空格/引号的路径会静默变成错的）。
  const envBridge = systemdExecStartValue([bridge]);
  const service = `[Unit]
Description=feishu-bridge 兜底发布（Codex 链，drain-all）
After=default.target

[Service]
Type=oneshot
Environment=FEISHU_CODEX_BRIDGE_HOME=${envBridge}
WorkingDirectory=${workdir}
ExecStart=${exec}
StandardOutput=append:${log}
StandardError=append:${log}
`;
  const timer = `[Unit]
Description=feishu-bridge 兜底发布定时器（Codex 链，每 30 分钟）

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true
Unit=${CODEX_DRAIN_SYSTEMD_UNIT}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

export const SYSTEMD_PHASE_TEXT = {
  absent: "未启用（安装后的默认态，不是故障）",
  plist_unreadable: "**单元文件读不出来 —— 不知道它是什么状态，一律当成可能在跑**",
  orphan: "**没有单元文件，但 systemd 里还有同名 timer 在 —— 它在按谁的配置跑说不清**",
  stale: "单元文件与当前运行时对不上（要重装）",
  installed_not_loaded: "**单元已写入但没被 systemd --user 加载 —— 定时器不会跑**",
  loaded: "已加载，正在按计划跑",
  loaded_other: "**同名 timer 在跑，但参数不是当前这份 —— 跑的多半是旧配置**",
  unverifiable: "systemd --user 状态查不出来 —— 不等于没在跑",
};

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
    const audit = auditOutbox(taskPaths(t, home).outbox);
    if (!audit.ok) return { ok: false, reason: audit.reason };
    unreadable += audit.unclassified.length;
    total += audit.pending;
    if (audit.pending > 0 || audit.unclassified.length > 0) {
      tasks.push({ key: t?.logical_task_key ?? null, pending: audit.pending,
        unreadable: audit.unclassified.length });
    }
  }
  return { ok: true, total, unreadable, tasks };
}


/**
 * 现在处于哪个状态。**"未启用"是安装后的正常态，不是故障。**
 * 把它报成故障，人就会去"修"一件本来就该这样的事。
 */
export function serviceState({ home = os.homedir(), codexHome = codexHomeOf(home),
  bridge = codexBridgeOf({ codexHome }), platform = timerPlatform({ home }), systemctlFn = systemctl } = {}) {
  if (platform === "linux") {
    const runtime = verifyRuntime({ root: codexRuntimeRoot(codexHome) });
    const paths = codexDrainSystemdPaths(home);
    // PK3-L7-fix3 P1-1：node 解析失败**不再回退 process.execPath**，所以这里主动接住它 ——
    //   它不是「查不出来」，是一个明确的、可修的问题（说的就是该用哪个 node）。
    let node = null;
    let nodeProblem = null;
    try { node = pickNode("linux", home); }
    catch (err) { nodeProblem = String(err?.message ?? err); }
    // 投影用**同一个 bridge**（fix4 P1-1）：显式桥根优先，否则 codexHome/feishu-bridge。
    const units = node === null ? null : codexDrainSystemdUnits({ home, codexHome, bridge, node });
    const backlog = classifyBacklog({ home: bridge });
    const scan = scanRunnable({ home: bridge });

    let serviceContent = null;
    let timerContent = null;
    let plistUnreadable = null;
    try {
      serviceContent = fs.readFileSync(paths.service, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") plistUnreadable = err.code ?? "unreadable";
    }
    try {
      timerContent = fs.readFileSync(paths.timer, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") plistUnreadable = err.code ?? "unreadable";
    }

    let phase = "unverifiable";
    let phaseWhy = null;

    if (plistUnreadable !== null) {
      phase = "plist_unreadable";
    } else {
      const timerUnit = CODEX_DRAIN_SYSTEMD_UNIT + ".timer";
      const serviceUnit = CODEX_DRAIN_SYSTEMD_UNIT + ".service";

      const enabled = systemctlFn(["--user", "is-enabled", timerUnit], { tolerate: true });
      const active = systemctlFn(["--user", "is-active", timerUnit], { tolerate: true });

      if (enabled?.skipped || active?.skipped) {
        phase = "unverifiable";
        phaseWhy = "体检的 home 不是当前用户的家目录（沙箱），不碰真实 systemctl --user";
      } else {
        const say = (r) => (String(r?.out ?? "") + " " + String(r?.err ?? "")).trim();
        const stateWord = (r) => {
          const word = String(r?.out ?? "").trim().split(/\s+/u)[0] ?? "";
          return SYSTEMCTL_STATE_WORDS.has(word) ? word : null;
        };
        const readable = (r) => r?.ok === true || stateWord(r) !== null || systemdUnitAbsent(say(r));
        const broken = (r) => !readable(r);

        if (broken(enabled) || broken(active)) {
          phase = "unverifiable";
          phaseWhy = "systemctl --user 查不了（" + say(broken(enabled) ? enabled : active).slice(0, 120) + "）—— 查不清，不等于没在跑";
        } else {
          const hasFiles = serviceContent !== null || timerContent !== null;
          const projected = units !== null && serviceContent === units.service && timerContent === units.timer;
          // 单元里那个 node 还在不在（PK3-L7-fix3 P1-1 的另一半）：升级把版本真身清掉后，
          //   manager 那边一切正常、ExecStart 却指向不存在的路径 —— 那是**静默失效**，
          //   必须报 stale 并把那个路径点出来（否则人只会看到「已加载、正在按计划跑」）。
          const diskNode = serviceContent === null ? null : unitFirstArg(serviceContent);
          const diskNodeMissing = diskNode !== null && !isExecutable(diskNode);
          const isEnabled = String(enabled?.out ?? "").trim() === "enabled";
          const isActive = String(active?.out ?? "").trim() === "active";

          if (!hasFiles) {
            if (isEnabled || isActive) {
              phase = "orphan";
              phaseWhy = "没有单元文件，但 systemd 里还有同名 timer 在";
            } else {
              phase = "absent";
            }
          } else if (serviceContent === null || timerContent === null) {
            phase = "installed_not_loaded";
            phaseWhy = "systemd 单元文件不完整";
          } else if (diskNodeMissing) {
            phase = "stale";
            phaseWhy = "单元里的 node 不存在了：" + diskNode +
              "（升级把版本真身清掉？装回 mise shim 或设 FEISHU_BRIDGE_NODE 后重跑 --enable --apply）";
          } else if (nodeProblem !== null) {
            phase = "stale";
            phaseWhy = "现在解析不出可用的 node：" + nodeProblem;
          } else if (!projected) {
            phase = "stale";
            phaseWhy = "单元文件与当前运行时对不上（要重装）";
          } else if (isEnabled && isActive) {
            const show = systemctlFn(["--user", "show", serviceUnit, "-p", "ExecStart", "--value"], { tolerate: true });
            // fix4 P1-2：+ 两道 —— manager 实际加载的 **LoadState**（error/bad-setting 也“在跑”？不）
            // 与 **Environment**（旧桥根 = 状态目录分叉）。两者与 ExecStart 同一份判据、同一处报。
            const loadProbe = systemctlFn(["--user", "show", serviceUnit, "-p", "LoadState", "--value"], { tolerate: true });
            const envProbe = systemctlFn(["--user", "show", serviceUnit, "-p", "Environment", "--value"], { tolerate: true });
            const expectedArgs = expectedJob({ home, codexHome, platform: "linux", node }).args;
            const loadedArgv = systemdShowExecArgv(String(show?.out ?? ""));
            const sameExec = show?.ok === true && loadedArgv !== null &&
              (loadedArgv === systemdExecStartValue(expectedArgs) || loadedArgv === expectedArgs.join(" "));
            const loadWord = String(loadProbe?.out ?? "").trim();
            const loadedBridge = systemdEnvValue(String(envProbe?.out ?? ""), "FEISHU_CODEX_BRIDGE_HOME");
            if (show?.ok !== true || loadProbe?.ok !== true || envProbe?.ok !== true) {
              phase = "unverifiable";
              phaseWhy = "systemctl --user show 查不了（" + say([show, loadProbe, envProbe].find((r) => r?.ok !== true)).slice(0, 120) + "）—— 已加载的定义核不了，查不清";
            } else if (loadWord !== "loaded") {
              // 单元起不来（语法错 / 依赖缺）—— enabled + active 也可能落到这里（timer 看似在跑，其实是旧实例）
              phase = "installed_not_loaded";
              phaseWhy = "systemd manager 里这个单元的 LoadState=" + (loadWord || "?") + "（不是 loaded）—— 它起不来";
            } else if (!sameExec) {
              phase = "loaded_other";
              phaseWhy = "systemd manager 里已加载的 ExecStart 与当前配置不一致";
            } else if (loadedBridge !== bridge) {
              phase = "loaded_other";
              phaseWhy = loadedBridge === null
                ? "manager 里加载的 Environment 没有 FEISHU_CODEX_BRIDGE_HOME（旧定义）—— 跑起来会按默认桥根找状态，与投影的 " + bridge + " 不一致"
                : "manager 里加载的 FEISHU_CODEX_BRIDGE_HOME=" + loadedBridge + " 与投影的 " + bridge + " 不一致（旧定义）";
            } else {
              phase = "loaded";
            }
          } else {
            phase = "installed_not_loaded";
            phaseWhy = isEnabled ? "已 enable 但未 active" : isActive ? "在跑但没 enable" : "未启用且未在跑";
          }
        }
      }
    }

    return {
      platform: "linux",
      scan,
      runtimeOk: runtime.ok === true,
      runtimeReason: runtime.ok ? null : (runtime.reason ?? "drift"),
      plistUnreadable,
      phase,
      why: phaseWhy,
      enabled: serviceContent !== null || timerContent !== null,
      stale: phase === "stale",
      plist: paths.timer,
      timer: paths.timer,
      service: paths.service,
      paths,
      units,
      backlog,
    };
  }

  const runtime = verifyRuntime({ root: codexRuntimeRoot(codexHome) });
  const file = plistPath(home);
  // **只有 ENOENT 算"没装"。**上一版把所有读取错误都吞成"没装"——
  // 把 plist 路径做成目录（EISDIR）、或者权限不足，状态都显示"未启用"，
  // 停用命令还会说"本来就没启用"。**读不出来不等于没有**，
  // 这跟登记表、outbox 那两条是同一个道理，我在第三处又犯了一次。
  let installed = null;
  let plistUnreadable = null;
  try { installed = fs.readFileSync(file, "utf-8"); }
  catch (err) { if (err.code !== "ENOENT") plistUnreadable = err.code ?? "unreadable"; }
  const wanted = plistBody({ home, codexHome, bridge });
  const backlog = classifyBacklog({ home: bridge });
  const scan = scanRunnable({ home: bridge });
  return {
    platform: "darwin",
    scan,
    runtimeOk: runtime.ok === true,
    runtimeReason: runtime.ok ? null : (runtime.reason ?? "drift"),
    // **四态，不是"文件在不在"。**plist 写了但没 bootstrap 成功的话，
    // 定时器根本不会跑 —— 而只看文件存在会报"已启用"，
    // 那正是"界面说正常、实际不工作"的形状。
    // **没有 plist 不等于没在跑。**孤儿 job（plist 被删了、job 还在 launchd 里）
    // 曾经会被报成 absent —— 一个还在跑的定时器显示成"未启用"。
    // **没有 plist 时的三种可能，不是两种。**
    //   查到 job → orphan（还在跑，但按谁的配置说不清）
    //   明确没有 → absent（正常默认态）
    //   查不清   → unverifiable —— **不许当成 orphan**，那是在声称一件没查过的事
    plistUnreadable,
    phase: plistUnreadable !== null
      ? "plist_unreadable"
      : installed === null
      ? { installed_not_loaded: "absent", unverifiable: "unverifiable" }[
          loadedPhase(spawnLaunchctl, null)] ?? "orphan"
      : installed !== wanted ? "stale"
      : loadedPhase(spawnLaunchctl, expectedJob({ home, codexHome })),
    enabled: installed !== null,
    stale: installed !== null && installed !== wanted,
    plist: file,
    backlog,
  };
}

/**
 * launchd 里到底有没有它。**读不出来就说读不出来**，不许由"文件在"推出"在跑"。
 */




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

/**
 * 这些状态下不许启用 —— **拒绝必须发生在动任何东西之前**。
 *
 * plist 读不出来：上一版没拦，于是启用路径先 bootout、再写盘才抛 EISDIR ——
 * **退出码是 1，可 launchd 控制面已经被动过**。报错报对了、事情办坏了，
 * 跟停用那条是同一种病。
 *
 * launchd 状态查不出来：这时候 bootstrap 之后也核验不了，
 * 早拦比"动完再说没法确认"强。
 */
const PHASE_BLOCKS = {
  plist_unreadable: "plist 读不出来",
  unverifiable: "launchd 状态查不出来",
};

/** PK3-L2-fix1 P1 / fix2：兜底排空检查（可注入 platform 与 launchd 探测函数，doctor 与用例共用）。
 *  非 darwin/linux 直接报「尚未实现」（不是未启用、不是查不清），状态记 null。
 *  启停入口与无参状态入口同样在非 darwin/linux 走 drainTimerCheck / 拒绝。 */
export function drainTimerCheck({ platform = timerPlatform({ home: os.homedir() }), serviceStateFn = serviceState } = {}) {
  if (platform !== "darwin" && platform !== "linux") {
    return { name: "兜底排空", ok: null, phase: "unverifiable", detail: drainTimerText({ platform }), next: null };
  }
  let svc;
  try {
    svc = serviceStateFn({ platform });
  } catch (err) {
    return { name: "兜底排空", ok: null, phase: "unverifiable", detail: "状态读不出来：" + (err?.message ?? err), next: null };
  }
  const ok = svc.phase === "loaded" ? true
    : (svc.phase === "stale" || svc.phase === "installed_not_loaded" ||
       svc.phase === "loaded_other" || svc.phase === "orphan" ||
       svc.phase === "plist_unreadable") ? false
    : null;
  const backlogSuffix = svc.phase === "absent" && svc.backlog?.ok && svc.backlog.total > 0
    ? "；还有 " + svc.backlog.total + " 条历史积压未分类"
    : "";
  const phaseTexts = platform === "linux" ? SYSTEMD_PHASE_TEXT : PHASE_TEXT;
  // 相位词后面带上为什么：linux 的 stale 会点名**那个不存在的 node 路径**（PK3-L7-fix3 P1-1），
  //   只说「对不上（要重装）」的话，doctor 里看不出是路径死了还是配置变了。
  const detail = (phaseTexts[svc.phase] ?? svc.phase) + (svc.why ? "（" + svc.why + "）" : "") + backlogSuffix;
  return { name: "兜底排空", ok, phase: svc.phase, detail, next: ok === false ? "重跑 `node scripts/codex/drain-service.mjs --enable --apply`" : null };
}

export function drainTimerText({ platform = timerPlatform({ home: os.homedir() }) } = {}) {
  if (platform === "darwin") {
    return "兜底定时器（launchd）—— " + PHASE_TEXT.unverifiable;
  }
  if (platform === "linux") {
    return "兜底定时器（systemd --user）—— " + SYSTEMD_PHASE_TEXT.unverifiable;
  }
  return "Codex 兜底定时器在本平台尚未实现（只在 darwin 有 launchd 实现、linux 有 systemd --user 实现）—— 启停入口也已拒绝，不会去探 launchd/systemd";
}

export function enableBlockers(state) {
  const blockers = [];
  const phaseWhy = state.platform === "linux"
    ? (state.phase === "plist_unreadable" ? "单元文件读不出来"
      : state.phase === "unverifiable" ? "systemd --user 状态查不出来"
      : null)
    : PHASE_BLOCKS[state.phase];
  if (phaseWhy) {
    blockers.push({ code: "phase_blocks", detail: phaseWhy });
  }
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

// ── systemd --user 现场与清理（PK3-L7-fix6：从 codex/install.mjs 搬到这里）────────────────────────
//
// 为什么搬家：install.mjs 是**顶层线性脚本**（import 即执行安装），在那里导不出可被用例 import 的函数；
// 而这段现场（盘上两份 unit + manager 三态）与"收掉定时器"本来就归 drain-service 管（单元名、路径、
// 投影都在本模块）。install.mjs 现在只调 `uninstallDrainUnitsInLock`，预览仍用 `linuxDrainScene` /
// `codexDrainRemovalPlan` —— 定义只有一份，两侧不会漂。

/**
 * manager（systemd --user）里那个 timer 的**三态**：present / absent / unverifiable（PK3-L7-fix4 P2-1）。
 * 旧版只给 true/false，于是「查不了」被折成「不在 manager」—— dry-run 预览「未启用」而 apply 可能去停
 * 一个孤儿 timer（预览与执行不一致）。三态里：`absent` 要三个探针都说“不在”（fail-closed），
 * 说不清的归 `unverifiable`。`skipped`（沙箱 HOME 且没注入）单独一态：那是「没问」，不是「问了说没有」。
 */
export function systemdTimerLookup({ systemctlFn = systemctl } = {}) {
  const timerUnit = CODEX_DRAIN_SYSTEMD_UNIT + ".timer";
  const first = (r) => String(r?.out ?? "").trim().split(/\s+/u)[0] ?? "";
  const say = (r) => (String(r?.out ?? "") + " " + String(r?.err ?? "")).trim();
  const enabled = systemctlFn(["--user", "is-enabled", timerUnit], { tolerate: true });
  const active = systemctlFn(["--user", "is-active", timerUnit], { tolerate: true });
  const show = systemctlFn(["--user", "show", timerUnit, "-p", "LoadState", "--value"], { tolerate: true });
  if (enabled?.skipped || active?.skipped || show?.skipped) return { state: "skipped", why: "沙箱 HOME，没问真实 systemd --user" };
  if (first(enabled) === "enabled" || first(active) === "active" || String(show?.out ?? "").trim() === "loaded") return { state: "present" };
  // 「没有它」要说准：每个探针要么 ok、要么是协议认的 not-found 说法、要么是最常见的 disabled/inactive 词
  const absentish = (r) => r?.ok === true || systemdUnitAbsent(say(r)) || ["disabled", "inactive", "unknown", "not-found"].includes(first(r));
  if (absentish(enabled) && absentish(active) && absentish(show)) return { state: "absent" };
  return { state: "unverifiable", why: say(!absentish(enabled) ? enabled : !absentish(active) ? active : show).slice(0, 120) };
}

/**
 * 卸载要不要动、以及预览要说哪句话 —— **dry-run 与 apply 共用这一份判断**（fix4 P2-1）。
 * action：none（本来就没启用）/ files（盘上有文件）/ orphan（只有 manager 里那个）/ refuse（查不清）。
 */
export function codexDrainRemovalPlan({ hasFiles, look }) {
  if (look.state === "unverifiable") {
    return { action: "refuse", text: "兜底排空    **manager 查不清**（" + look.why + "）—— --apply 会在这一步拒绝（不静默跳过，也不当成「未启用」）" };
  }
  if (look.state === "present" && !hasFiles) {
    return { action: "orphan", text: "兜底排空    将停用 manager 中的**孤儿 timer**（盘上没有单元文件，systemd --user 里还在），并 daemon-reload" };
  }
  if (hasFiles) return { action: "files", text: "兜底排空    待停用并删除 systemd 单元" };
  if (look.state === "skipped") return { action: "none", text: "兜底排空    未启用（默认；manager 没问 —— 沙箱 HOME）" };
  return { action: "none", text: "兜底排空    未启用（默认）" };
}

/** linux 卸载要看的现场（盘上两份 unit + manager 三态 + 计划）：预览与执行都从这里取，不各算一遍。 */
export function linuxDrainScene({ home = os.homedir(), systemctlFn = systemctl } = {}) {
  const spaths = codexDrainSystemdPaths(home);
  const hasFiles = fs.existsSync(spaths.service) || fs.existsSync(spaths.timer);
  return { spaths, hasFiles, look: systemdTimerLookup({ systemctlFn }) };
}

/**
 * 卸载时收掉 linux 上的兜底定时器（**PK3-L7-fix6：可导入单出口**）。
 *
 * 契约：**调用方已经持着安装面锁**（codex/install.mjs 的 `--apply` 段在它之前取的锁）—— 所以这里只做
 * 「锁内重读现场 → disable --now → 删两份 unit → daemon-reload」，不再自己取锁（同进程再取一次必 busy）。
 * 现场在**函数内重读**（fix5 P1-3）：模块顶部那份预览快照只给人看，不能拿来执行。
 *
 * `hooks` 只给用例（**CLI 不可触达**）：`hooks.beforeScene()` 在「重读现场之前」跑，用来确定性地复现
 * 「预览快照之后、真正动手之前有人放下 unit」的交错。旧版这个注入点是一个环境变量指向任意 `.mjs`
 * （生产可达：设上它就能在锁外跑任意代码），已删除。
 *
 * 不调 `process.exit`：打印走 `log` / `error`，退出码由调用方按 `{ ok, code }` 映射。
 */
export function uninstallDrainUnitsInLock({
  home = os.homedir(), platform = timerPlatform({ home }),
  systemctlFn = systemctl, log = console.log, error = console.error, hooks = {},
} = {}) {
  // 非 linux 什么都不做（darwin 真机上一次 systemctl 都不许调 —— fix5 P1-1）。
  if (platform !== "linux") return { ok: true, code: 0, action: "none", removed: false };
  if (typeof hooks.beforeScene === "function") hooks.beforeScene();
  const scene = linuxDrainScene({ home, systemctlFn });
  const plan = codexDrainRemovalPlan(scene);
  if (plan.action === "refuse") {
    error(plan.text + "\n什么都没动（先查清 systemd --user 能不能用、里面到底有没有同名 timer，再卸载）。");
    return { ok: false, code: 1, action: "refuse", removed: false };
  }
  if (plan.action === "none") return { ok: true, code: 0, action: "none", removed: false };

  const { spaths, hasFiles } = scene;
  const disabled = systemctlFn(["--user", "disable", "--now", CODEX_DRAIN_SYSTEMD_UNIT + ".timer"], { tolerate: true });
  if (!disabled.ok && !disabled.skipped && !disabled.absent) {
    error("兜底定时器停用失败：" + (disabled.text ?? "说不清") + "，单元文件未删。");
    return { ok: false, code: 1, action: plan.action, removed: false };
  }
  fs.rmSync(spaths.service, { force: true });
  fs.rmSync(spaths.timer, { force: true });
  const reloaded = systemctlFn(["--user", "daemon-reload"], { tolerate: true });
  if (!reloaded.ok && !reloaded.skipped) {
    error("已停止、单元文件已删，但 systemd --user daemon-reload 失败：" + (reloaded.text ?? "说不清"));
    return { ok: false, code: 1, action: plan.action, removed: true };
  }
  const skipped = disabled.skipped;
  log("兜底排空    " + (skipped
    ? "systemd 单元已删，但真实 systemd --user 未动（HOME 被重定向）"
    : plan.action === "orphan" || !hasFiles
      ? "收了一个孤儿 timer（单元文件早已不在，systemd --user 里还在），已停用并 daemon-reload"
      : "已停用并删除 systemd 单元"));
  return { ok: true, code: 0, action: plan.action, removed: true };
}

/**
 * 持锁段的外壳（PK3-L7-fix6）：**取锁 → 跑 body → finally 释放并把释放状态折叠成退出码**。
 * body 返回 0 / 非 0；释放不干净一律 3（"释放失败不许报成功"）。`beforeLock` 只在**取锁之前**跑。
 */
function runUnderInstallSurfaceLock({ home, env, error, exit, beforeLock, body }) {
  if (typeof beforeLock === "function") beforeLock();
  const refused = acquireInstallSurfaceLockOrRefuse({ home, env, err: error });
  if (!refused.ok) return exit(refused.code);
  let code = 0;
  try { code = body(); }
  catch (err) {
    error("写段抛异常（" + String(err?.code ?? err?.message ?? err) + "）：停在这里，锁按下一条结论交还。");
    code = 1;
  } finally {
    const rel = refused.lock.release();
    if (!rel.ok) { error("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）。"); code = 3; }
  }
  return exit(code);
}

/**
 * `--enable --apply` 的**持锁段**（**PK3-L7-fix6：可导入单出口**，CLI 只传生产实现）。
 *
 * `hooks.beforeLock()` 在「取锁之前」跑 —— 交错注入**只能从函数参数来**（CLI 不传、也不读任何
 * "只给测试"的环境变量）。整段：取锁 → 锁内重查维护门 → 锁内重读 node 与单元现状 → 写两份 unit →
 * daemon-reload → enable --now → 用现成判据复核 manager 实态；释放走 finally（失败折叠成 3）。
 * 返回 `exit(code)`（退出码由注入的 exit 决定，与 runDrainService 的既有契约一致）。
 */
export function enableDrainInLock({
  home = os.homedir(), codexHome = codexHomeOf(home), bridge = codexBridgeOf({ codexHome }),
  paths = codexDrainSystemdPaths(home), systemctlFn = systemctl, serviceStateFn = serviceState,
  log = console.log, error = console.error, exit = process.exit, env = process.env, hooks = {},
} = {}) {
  return runUnderInstallSurfaceLock({ home, env, error, exit, beforeLock: hooks.beforeLock, body: () => {
    // **锁内重查维护门**（fix5 P1-3）：门是"窗口内不许写安装面"的裁决，取锁前的检查只是礼貌。
    const gateNow = gateBlocks();
    if (gateNow.blocked) {
      error("维护门开着（" + String(gateNow.text ?? "") + "）—— 锁内复核发现的，什么都没写。");
      return 2;
    }
    // **锁内重读现场**（fix5 P1-3）：node 与单元现状都以此刻为准（上面那份是给预览/拒绝用的）。
    let node = null;
    {
      let why = null;
      try { node = pickNode("linux", home); } catch (err) { why = String(err?.message ?? err); }
      if (why !== null) {
        error("\n锁内重读发现 node 又解不出来了：" + why + "\n什么都没写。");
        return 1;
      }
    }

    const units = codexDrainSystemdUnits({ home, codexHome, bridge, node });
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.service, units.service, { mode: 0o644 });
    fs.writeFileSync(paths.timer, units.timer, { mode: 0o644 });

    const reload = systemctlFn(["--user", "daemon-reload"]);
    if (reload.skipped) {
      log("\n单元已写入，但跳过真实 systemd --user（HOME 被重定向到 " + home + "）。");
      return 0;
    }
    if (!reload.ok) {
      error("\n单元已写入，但 systemctl --user daemon-reload 失败：" + (reload.text || reload.err || ""));
      error("**定时器现在不会跑。**修好后重跑本命令。");
      return 1;
    }

    const start = systemctlFn(["--user", "enable", "--now", CODEX_DRAIN_SYSTEMD_UNIT + ".timer"]);
    if (start.skipped) {
      log("\n单元已写入，但跳过真实 systemd --user（HOME 被重定向到 " + home + "）。");
      return 0;
    }
    if (!start.ok) {
      error("\n单元已写入，但 systemctl --user enable --now 失败：" + (start.text || start.err || ""));
      error("**定时器现在不会跑。**修好后重跑本命令。");
      return 1;
    }

    // PK3-L7-fix3 P1-3：**enable --now 返回 0 不等于实态对。**systemd 可以返回成功但定时器
    //   仍是 inactive（masked / 依赖没起来 / 别的地方改了同名单元），或者 manager 里还是**旧定义**。
    //   复核用现成的那三道（is-enabled / is-active / show ExecStart）+ fix4 补的 LoadState / Environment
    //   —— 就是 serviceState 的 linux 分支，不另写一份。复核不过就说清是哪一道不过，**不打印「已加载」**。
    const after = serviceStateFn({ home, codexHome, bridge, platform: "linux", systemctlFn });
    if (after.phase !== "loaded") {
      error("\nenable --now 返回成功，但复核 systemd manager 实态不过：" +
        (SYSTEMD_PHASE_TEXT[after.phase] ?? after.phase));
      if (after.why) error("  判据：" + after.why);
      error("**不当作已启用** —— 返回 0 不代表它真的在按这份配置跑。");
      error("  修好后：先 --disable --apply，再 --enable --apply。");
      return 1;
    }

    log("\n已启用，定时器已加载（manager 实态已复核：enabled + active + ExecStart 与投影一致）。");
    log("每 30 分钟扫一次全部登记 task；**只发已取得发布资格的内容**。");
    return 0;
  } });
}

/**
 * `--disable --apply` 的**持锁段**（**PK3-L7-fix6：可导入单出口**）。
 *
 * 与 enable 同一条纪律：取锁 → 锁内重查门 → 单元文件读不出来就一个字节不动 → disable --now →
 * 删两份 unit → daemon-reload；停不下来不删（删了会把还在跑的定时器显示成"未启用"）。
 * `hooks.beforeLock()` 同样只在函数参数里，CLI 不可触达。
 */
export function disableDrainInLock({
  home = os.homedir(), paths = codexDrainSystemdPaths(home), systemctlFn = systemctl,
  log = console.log, error = console.error, exit = process.exit, env = process.env, hooks = {},
} = {}) {
  return runUnderInstallSurfaceLock({ home, env, error, exit, beforeLock: hooks.beforeLock, body: () => {
    const gateNow = gateBlocks();
    if (gateNow.blocked) {
      error("维护门开着（" + String(gateNow.text ?? "") + "）—— 锁内复核发现的，什么都没写。");
      return 2;
    }

    let plistUnreadable = null;
    for (const p of [paths.service, paths.timer]) {
      try { fs.readFileSync(p, "utf-8"); }
      catch (err) {
        if (err.code !== "ENOENT") plistUnreadable = err.code ?? "unreadable";
      }
    }
    if (plistUnreadable !== null) {
      error("\n单元文件读不出来（" + plistUnreadable + "），**不知道它是什么状态**。");
      error("什么都没动 —— 先把那个文件处理掉再来。");
      return 1;
    }

    const out = systemctlFn(["--user", "disable", "--now", CODEX_DRAIN_SYSTEMD_UNIT + ".timer"], { tolerate: true });
    if (!out.ok && !out.skipped && !out.absent) {
      error("\n卸载失败：" + (out.text || out.err || "退出码非零"));
      error("**单元文件没有删。**删了的话，下次查状态会把一个可能还在跑的");
      error("定时器报成「未启用」—— 先把它停掉再来。");
      return 1;
    }
    fs.rmSync(paths.service, { force: true });
    fs.rmSync(paths.timer, { force: true });
    const reloaded = systemctlFn(["--user", "daemon-reload"], { tolerate: true });
    if (!reloaded.ok && !reloaded.skipped) {
      error("\n已停止、单元文件已删，但 systemd --user daemon-reload 失败：" + (reloaded.text || reloaded.err || "说不清") + "；请手工执行 systemctl --user daemon-reload");
      return 1;
    }
    if (out.skipped) {
      log("\n单元文件已删，但真实 systemd --user 未动（HOME 被重定向到 " + home + "）。");
    } else {
      log("\n已停用。systemd --user 里确认没有它了，单元文件也已删除。");
    }
    return 0;
  } });
}

export function runDrainService(argv = process.argv.slice(2), {
  home = os.homedir(),
  codexHome = codexHomeOf(home),
  bridge = codexBridgeOf({ codexHome }),
  platform = timerPlatform({ home }),
  serviceStateFn = serviceState,
  spawnLaunchctlFn = spawnLaunchctl,
  spawnSystemctlFn = systemctl,
  log = console.log,
  error = console.error,
  exit = process.exit,
} = {}) {
  const known = new Set(["--enable", "--disable", "--apply"]);
  const bad = argv.filter((a) => !known.has(a));
  if (bad.length > 0) {
    error("认不出的参数：" + bad.join(" "));
    error("  只接受 --enable / --disable / --apply");
    return exit(1);
  }
  const enable = argv.includes("--enable");
  const disable = argv.includes("--disable");
  const apply = argv.includes("--apply");
  if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
  if (enable && disable) {
    error("--enable 和 --disable 只能给一个。");
    return exit(1);
  }

  if (platform !== "darwin" && platform !== "linux") {
    if (enable || disable) {
      error("Codex 兜底定时器在本平台尚未实现（只在 darwin 有 launchd 实现、linux 有 systemd --user 实现）—— enable / disable 在这里不可用。");
      return exit(1);
    }
    const check = drainTimerCheck({ platform });
    log("状态      " + check.detail);
    log("\n本平台没有启停实现（只在 darwin 有 launchd 实现、linux 有 systemd --user 实现）。");
    return exit(0);
  }

  if (platform === "linux") {
    const paths = codexDrainSystemdPaths(home);

    if (!enable && !disable) {
      const st = serviceStateFn({ home, codexHome, bridge, platform: "linux", systemctlFn: spawnSystemctlFn });

      log("调度器    " + paths.timer);
      log("状态      " + (SYSTEMD_PHASE_TEXT[st.phase] ?? st.phase));
      // 状态行的 why 要说出来：stale 时它点的是**哪个路径/哪一道判据**（fix3 P1-1），
      // 只说「对不上」人会不知道该看哪里。
      if (st.why) log("原因      " + st.why);
      log("运行时    " + (st.runtimeOk
        ? "校验通过" : "**校验不过**（" + st.runtimeReason + "）"));
      log("排空脚本  " + drainScriptPath(home, codexHome));
      if (st.backlog.ok && (st.backlog.unreadable ?? 0) > 0) {
        log("损坏文件  **" + st.backlog.unreadable + " 个读不出来**（不计入待发数）");
      }
      log("链路预检  " + (st.scan.ok
        ? "通过（" + st.scan.tasks + " 个 task 走真实发布前置检查）"
        : "**跑不通**（" + st.scan.reason + "）"));
      if (st.backlog.ok) {
        log("历史积压  " + st.backlog.total + " 条" +
          (st.backlog.total > 0 ? "（分布在 " + st.backlog.tasks.length + " 个 task）" : ""));
      } else {
        log("历史积压  读不出来（" + st.backlog.reason + "）");
      }

      log("\n只报状态。要动它加 --enable --apply 或 --disable --apply。");
      return exit(0);
    }

    if (enable) {
      const runtime = verifyRuntime({ root: codexRuntimeRoot(codexHome) });
      const scan = scanRunnable({ home: bridge });
      const backlog = classifyBacklog({ home: bridge });
      let plistUnreadable = null;
      for (const p of [paths.service, paths.timer]) {
        try { fs.readFileSync(p, "utf-8"); }
        catch (err) {
          if (err.code !== "ENOENT") plistUnreadable = err.code ?? "unreadable";
        }
      }
      const blockers = enableBlockers({
        platform: "linux",
        phase: plistUnreadable ? "plist_unreadable" : "absent",
        scan,
        runtimeOk: runtime.ok === true,
        runtimeReason: runtime.ok ? null : (runtime.reason ?? "drift"),
        backlog,
      });
      // PK3-L7-fix3 P1-1：node 解析**先于任何动作**求值 —— 解不出来就拒绝，
      //   绝不退回 process.execPath（退回会把当前进程那个带版本号的 node 写进长期单元）。
      let nodeProblem = null;
      // 这里只问"能不能解出来"（不能就拒绝）；**真正的值在锁内重读**（enableDrainInLock）。
      try { pickNode("linux", home); }
      catch (err) { nodeProblem = String(err?.message ?? err); }
      if (nodeProblem !== null) blockers.push({ code: "node_unresolvable", detail: nodeProblem });

      if (blockers.length > 0) {
        error("\n不能启用，什么都没写：");
        for (const b of blockers) {
          if (b.code === "backlog_unclassified") {
            error("  · 还有 " + b.detail + " 没处理。**定时器一启用它们就会被发出去** ——");
            error("    先决定这批内容是发还是停（scripts/codex/suppress-outbox.mjs），");
            error("    再回来启用。这一步不许省：省掉它就是替人做了一个不可逆的决定。");
          } else if (b.code === "phase_blocks") {
            error("  · " + b.detail + " —— **什么都没动**（没有 daemon-reload、没有写盘）。");
            error("    先把它查清楚：动过控制面之后再失败，比现在难收拾。");
          } else if (b.code === "backlog_corrupt") {
            error("  · outbox 里有 " + b.detail + "。**读不出来不等于没有** ——");
            error("    这些文件是什么内容谁也不知道，不能当成「没有积压」放行。");
          } else if (b.code === "scan_failed") {
            error("  · eligible-only 扫描跑不通（" + b.detail + "）——");
            error("    定时器要跑的就是它，跑不通就不能装。");
          } else if (b.code === "runtime_unverified") {
            error("  · 运行时校验不过（" + b.detail + "）—— 先跑 scripts/codex/install.mjs --apply。");
          } else if (b.code === "node_unresolvable") {
            error("  · 找不到可用的 node：" + b.detail);
            error("    **不会退回当前进程的 node** —— 那个路径常带版本号（mise 的 installs/<版本>/bin/node），");
            error("    升级清掉之后单元里的 ExecStart 就指向不存在的东西，定时器静默失效。");
            error("    指路：装一个 mise shim（~/.local/share/mise/shims/node）或设 FEISHU_BRIDGE_NODE");
            error("    指向一个**不带版本号**的绝对路径，然后重跑本命令。");
          } else {
            error("  · " + b.code + "（" + b.detail + "）");
          }
        }
        return exit(1);
      }

      if (!apply) {
        log("\n[dry-run] 什么都没写。加 --apply 才生效。");
        return exit(0);
      }

      // 写路径：**持锁段抽成可导入的单出口函数**（PK3-L7-fix6）。CLI 不传 hooks、也不读任何
      // "只给测试"的环境变量 —— 交错注入只能经函数参数（用例直接 import 那个函数并传 hooks）。
      return enableDrainInLock({
        home, codexHome, bridge, paths, systemctlFn: spawnSystemctlFn, serviceStateFn,
        log, error, exit, env: process.env,
      });
    }

    if (disable) {
      if (!apply) {
        log("\n[dry-run] 什么都没写。加 --apply 才生效。");
        return exit(0);
      }

      // 停用同样是写路径（停服务 + 删单元）：**持锁段抽成可导入的单出口函数**（PK3-L7-fix6）。
      return disableDrainInLock({ home, paths, systemctlFn: spawnSystemctlFn, log, error, exit, env: process.env });
    }
  }

  const st = serviceStateFn({ home, codexHome, bridge });

  log("调度器    " + st.plist);
  log("状态      " + (PHASE_TEXT[st.phase] ?? st.phase));
  log("运行时    " + (st.runtimeOk
    ? "校验通过" : "**校验不过**（" + st.runtimeReason + "）"));
  log("排空脚本  " + drainScriptPath(home));
  if (st.backlog.ok && (st.backlog.unreadable ?? 0) > 0) {
    log("损坏文件  **" + st.backlog.unreadable + " 个读不出来**（不计入待发数）");
  }
  log("链路预检  " + (st.scan.ok
    ? "通过（" + st.scan.tasks + " 个 task 走真实发布前置检查）"
    : "**跑不通**（" + st.scan.reason + "）"));
  if (st.backlog.ok) {
    log("历史积压  " + st.backlog.total + " 条" +
      (st.backlog.total > 0 ? "（分布在 " + st.backlog.tasks.length + " 个 task）" : ""));
  } else {
    log("历史积压  读不出来（" + st.backlog.reason + "）");
  }

  if (!enable && !disable) {
    log("\n只报状态。要动它加 --enable --apply 或 --disable --apply。");
    return exit(0);
  }

  if (enable) {
    const blockers = enableBlockers(st);
    if (blockers.length > 0) {
      error("\n不能启用，什么都没写：");
      for (const b of blockers) {
        if (b.code === "backlog_unclassified") {
          error("  · 还有 " + b.detail + " 没处理。**定时器一启用它们就会被发出去** ——");
          error("    先决定这批内容是发还是停（scripts/codex/suppress-outbox.mjs），");
          error("    再回来启用。这一步不许省：省掉它就是替人做了一个不可逆的决定。");
        } else if (b.code === "phase_blocks") {
          error("  · " + b.detail + " —— **什么都没动**（没有 bootout、没有写盘）。");
          error("    先把它查清楚：动过控制面之后再失败，比现在难收拾。");
        } else if (b.code === "backlog_corrupt") {
          error("  · outbox 里有 " + b.detail + "。**读不出来不等于没有** ——");
          error("    这些文件是什么内容谁也不知道，不能当成「没有积压」放行。");
        } else if (b.code === "scan_failed") {
          error("  · eligible-only 扫描跑不通（" + b.detail + "）——");
          error("    定时器要跑的就是它，跑不通就不能装。");
        } else if (b.code === "runtime_unverified") {
          error("  · 运行时校验不过（" + b.detail + "）—— 先跑 scripts/codex/install.mjs --apply。");
        } else {
          error("  · " + b.code + "（" + b.detail + "）");
        }
      }
      return exit(1);
    }
  }

  if (!apply) {
    log("\n[dry-run] 什么都没写。加 --apply 才生效。");
    return exit(0);
  }

  if (disable) {
    // **"没有 plist"不等于"没在跑"。**orphan 就是 plist 没了、job 还在 ——
    // 那种情况下直接说"本来就没启用"，等于把一个还在跑的定时器当成不存在。
    if (st.phase === "absent") {
      log("\n本来就没启用，什么都没做。");
      return exit(0);
    }
    if (st.phase === "plist_unreadable") {
      error("\nplist 读不出来（" + st.plistUnreadable + "），**不知道它是什么状态**。");
      error("什么都没动 —— 先把那个文件处理掉再来。");
      return exit(1);
    }
    if (st.phase === "unverifiable") {
      error("\nlaunchd 状态查不出来，**不敢说它有没有在跑**。");
      error("什么都没动 —— 先把 launchctl 能不能用查清楚。");
      return exit(1);
    }
    const out = spawnLaunchctlFn(["bootout", "gui/" + process.getuid() + "/" + LAUNCH_LABEL]);
    // **只有"确实没有这个服务"可以忽略。**
    //
    // 上一版是"卸载失败也照删 plist"，后果有两层：旧 job 可能还在跑，
    // 而 plist 一删，下一次状态查询就报 absent —— **一个还在跑的定时器
    // 被显示成"未启用"**，比报错更糟。
    if (!out.ok && !absentJob(out.detail)) {
      error("\n卸载失败：" + out.detail);
      error("**plist 没有删。**删了的话，下次查状态会把一个可能还在跑的");
      error("定时器报成「未启用」—— 先把它卸掉再来。");
      return exit(1);
    }
    // **顺序：卸载 → 核验确实没了 → 才删 plist。**
    //
    // 上一版是先删 plist 再核验：bootout 返回成功但 job 仍在时，命令确实非零退出了，
    // **可现场已经被改成 orphan** —— plist 没了、job 还在，比动手之前更糟。
    // 核验没过就一个字节都不动，把现场留在原样。
    const after = loadedPhase(spawnLaunchctlFn, null);
    if (after !== "installed_not_loaded") {
      error("\nbootout 返回成功，但 launchd 里仍能查到（" + after + "）。");
      error("**plist 一个字节没动。**删了的话现场会变成「没有 plist、job 还在」，");
      error("比现在更难收拾。先把那个 job 处理掉再来。");
      return exit(1);
    }
    fs.rmSync(st.plist, { force: true });
    log("\n已停用。launchd 里确认没有它了，plist 也已删除。");
    return exit(0);
  }

  // **已经是健康的 loaded 就什么都不做。**
  //
  // 上一版无条件 bootout → bootstrap，而那可能**打断一次正在进行的排空**。
  // 幂等重跑是常见操作（比如脚本里顺手带一句），不该有副作用；
  // 真要重启的话，先 --disable 再 --enable，那是个明确的意图。
  if (st.phase === "loaded") {
    log("\n已经在跑，而且参数就是当前这份 —— 什么都没做。");
    log("要重启的话：先 --disable --apply，再 --enable --apply。");
    return exit(0);
  }

  fs.mkdirSync(path.dirname(st.plist), { recursive: true });
  // **先把同名的旧 job 卸掉。**不卸的话 bootstrap 会因"已存在"失败，
  // 而旧 job 继续按旧配置跑 —— 那正是"报了错却仍显示已加载"的来源。
  const out = spawnLaunchctlFn(["bootout", "gui/" + process.getuid() + "/" + LAUNCH_LABEL]);
  // **只有"本来就没有"可以忽略。**其他失败意味着旧 job 还在，
  // 接着 bootstrap 只会失败或让旧配置继续跑 —— 那正是假绿的来源。
  if (!out.ok && !absentJob(out.detail)) {
    error("\n卸载旧的同名 job 失败：" + out.detail);
    error("**没有动 plist。**旧 job 可能还在按旧配置跑，先处理它再来。");
    return exit(1);
  }
  fs.writeFileSync(st.plist, plistBody({ home, codexHome, bridge }), { mode: 0o644 });
  const loaded = spawnLaunchctlFn(["bootstrap", "gui/" + process.getuid(), st.plist]);
  if (!loaded.ok) {
    // **加载失败必须非零退出。**报成功而定时器没在跑，就是"界面说正常、实际不工作"——
    // 兜底本来就是最后一道，它悄悄不工作的话没有第二处会发现。
    error("\nplist 已写入，但 launchd 加载失败：" + loaded.detail);
    error("**定时器现在不会跑。**修好后重跑本命令。");
    return exit(1);
  }
  // **bootstrap 返回 0 不等于跑的是我们这份。**重新读一次，核验实际参数。
  const after = loadedPhase(spawnLaunchctlFn, expectedJob({ home }));
  if (after !== "loaded") {
    error("\nbootstrap 报成功，但核验实际 job 得到：" + (PHASE_TEXT[after] ?? after));
    error("**不当作已启用。**");
    return exit(1);
  }
  log("\n已启用，定时器已加载（实际参数已核验）。");
  log("每 30 分钟扫一次全部登记 task；**只发已取得发布资格的内容**。");
  return exit(0);
}

/**
 * launchctl 的**唯一入口，带显式注入口**。
 *
 * 评审实测：两条回归隔离了 HOME，却没隔离真实用户的 launchd 域 ——
 * 他那台机器上有同名 job，临时 HOME 就被判成 orphan，**同一份代码
 * 在我这里 127/127、在他那里 125/127**。"全绿"带着机器状态前提，
 * 那个数字就不作数。这个仓库为"测试碰真机"付过四次代价，这是第五次。
 *
 * 根因照例不是"某条测试忘了造假"，是**隔离点没接到实现里**。
 */

function main() {
  runDrainService();
}

if (isDirectRun(import.meta.url)) main();
