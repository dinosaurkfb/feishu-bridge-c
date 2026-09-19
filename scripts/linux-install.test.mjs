/**
 * PK3-L1：Linux 首装的三块纯逻辑 —— 兜底定时器按平台、node 路径解析、lark-cli 的 DATA_DIR。
 *
 * 全部不碰磁盘 / 不跑 systemctl / 不发消息：平台、exists、env 一律注入。
 * 这里要钉的都是「换到另一台机器上不会静默装错」——错法都很安静：写一个永远不生效的 plist、
 * 把一个不存在的 node 写进 hooks、或者让 lark-cli 去找一个没有密钥的目录。
 */
import "./test-support/install-surface-boot.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, installedNodeFrom, resolveNodeForHooks, resolveTimerPlatform, timerKindFor, timerPlatform, TIMER_PLATFORM_ENV } from "./drain-schedule.mjs";
import { ailyDaemonPlan, claudeDrainPlistPath, claudeDrainSystemdPaths, claudeDrainSystemdUnits, drainTimerPlan, systemdUnitAbsent } from "./install-projection.mjs";
import { runDoctor } from "./doctor.mjs";
import { larkCliEnv, larkProvisionedSecretPath } from "./chain-template.mjs";
import { bootoutTimer, bootstrapTimer, timerPhase } from "./maintenance/timers.mjs";
import { chainFacts, precheckStartupSources } from "./maintenance/precheck.mjs";
import { enterMaintenance, exitMaintenance, maintenanceContext } from "./maintenance/operation.mjs";
import { systemctl, timerCmd } from "./timer-exec.mjs";
import { installSuiteTempRoot } from "./test-support/suite-temp-root.mjs";
import { installerChildEnv } from "./test-support/purge-fixture-guard.mjs"; // PK3-I247：安装器写目标隔离

// PK3-T2-fix1：这个入口也是测试，也要有本轮私有临时根 —— **在任何 mkdtemp 之前**装，
// 装上之后越出私有根的 mkdtemp 当场 throw（硬门在退出时把 violations 汇总成非 0）。
// 以前它直接往宿主 TMPDIR 造 pk3* 目录（实测一次全量在宿主 tmp 顶层新增 21 条）。
installSuiteTempRoot();

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "scripts", "install-outbound.mjs");

const existsOnly = (paths) => (p) => paths.includes(p);
const alwaysExec = () => {};   // 候选要过 X_OK：注入 access，测试不必造真文件

test("timerKindFor：darwin launchd / linux systemd / 其它 null（明说没实现）", () => {
  assert.equal(timerKindFor("darwin"), "launchd");
  assert.equal(timerKindFor("linux"), "systemd");
  assert.equal(timerKindFor("win32"), null);
  assert.equal(timerKindFor("freebsd"), null);
});

test("resolveNodeForHooks 平台化顺序：darwin 显式→已安装→/opt/homebrew→/usr/local→PATH→~/.local/bin；linux 显式→已安装→mise shim→PATH→/usr/local→~/.local/bin；都不用 execPath", () => {
  const home = "/home/dinosak";
  const shim = "/home/dinosak/.local/share/mise/shims/node";
  // ① 显式指定优先
  assert.equal(resolveNodeForHooks({ env: { FEISHU_BRIDGE_NODE: "/opt/x/node", PATH: "/usr/bin" },
    exists: existsOnly(["/opt/x/node", "/usr/bin/node"]), access: alwaysExec, homedir: home }), "/opt/x/node");
  // ② PATH 逐段（mise shim 就是这条：拿到 shim 比拿真身稳）
  assert.equal(resolveNodeForHooks({ env: { PATH: "/a:/b" }, exists: existsOnly(["/b/node"]), access: alwaysExec, homedir: home }), "/b/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "/usr/bin:" + path.dirname(shim) }, exists: existsOnly([shim]), access: alwaysExec, homedir: home }), shim);
  // ③/④/⑤ darwin 三个兜底候选按序（PK3-L2：平台分支的断言**显式注入 platform**，不靠 process.platform 默认）
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly(["/opt/homebrew/bin/node"]), access: alwaysExec, homedir: home, platform: "darwin" }), "/opt/homebrew/bin/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly(["/usr/local/bin/node"]), access: alwaysExec, homedir: home, platform: "darwin" }), "/usr/local/bin/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly([path.join(home, ".local", "bin", "node")]), access: alwaysExec, homedir: home, platform: "darwin" }), path.join(home, ".local", "bin", "node"));
  // ⑥ linux 分支（PK3-L2）：mise shim 优先 —— shim 存在时，PATH 先命中 installs 真身也要返回 shim；
  //   shim 不存在 → 走 PATH。XDG_DATA_HOME / ~/.local/share 都认。
  const instNode = "/home/dinosak/.local/share/mise/installs/node/26/bin/node";
  const shimP = "/home/dinosak/.local/share/mise/shims/node";
  assert.equal(resolveNodeForHooks({ env: { PATH: path.dirname(instNode) + ":/usr/bin" },
    exists: existsOnly([instNode, shimP]), access: alwaysExec, homedir: home, platform: "linux" }), shimP,
    "shim 在 → 优先 shim（mise 会重写子进程 PATH 把 installs 真身排前）");
  assert.equal(resolveNodeForHooks({ env: { PATH: path.dirname(instNode) + ":/usr/bin" },
    exists: existsOnly([instNode]), access: alwaysExec, homedir: home, platform: "linux" }), instNode,
    "shim 不在 → 走 PATH");
  const xdgHome = "/home/dinosak/xdg";
  const xdgShim = path.join(xdgHome, "mise/shims/node");
  assert.equal(resolveNodeForHooks({ env: { XDG_DATA_HOME: xdgHome, PATH: "" },
    exists: existsOnly([xdgShim]), access: alwaysExec, homedir: home, platform: "linux" }), xdgShim,
    "XDG_DATA_HOME 下的 shim 也认");
  // darwin 上 shim 不优待：installs 真身在 PATH 上就返回它（顺序不变）
  assert.equal(resolveNodeForHooks({ env: { PATH: path.dirname(instNode) },
    exists: existsOnly([instNode, shimP]), access: alwaysExec, homedir: home, platform: "darwin" }), instNode,
    "darwin 顺序不变（shim 不优待）");
  // 显式指定但不存在 → 抛（不静默换成别的）
  assert.throws(() => resolveNodeForHooks({ env: { FEISHU_BRIDGE_NODE: "/nope/node" }, exists: existsOnly([]), access: () => {}, homedir: home }), /FEISHU_BRIDGE_NODE 指的路径/);
  // 都没有 → 抛并把找过的列出来；**绝不退回 process.execPath**（钩子契约：Claude Code 自带的 node 不许当外部路径）
  let err = null;
  try { resolveNodeForHooks({ env: { PATH: "/a:/b" }, exists: existsOnly([]), access: alwaysExec, homedir: home }); } catch (e) { err = e; }
  assert.ok(err, "找不到必须抛");
  assert.match(err.message, /找不到 node/);
  assert.match(err.message, /\/a\/node/);
  assert.match(err.message, /\.local\/bin\/node/);
  assert.equal(err.message.includes(process.execPath), false, "报错里不许出现 execPath 这个兜底");
});

test("drainTimerPlan：darwin 写 plist 走 launchctl；linux 写两份 unit 走 systemctl；其它平台明说未装", () => {
  const home = "/home/dinosak"; const node = "/home/dinosak/.local/share/mise/shims/node";
  const darwin = drainTimerPlan({ home, node, platform: "darwin", read: () => null });
  assert.equal(darwin.kind, "launchd");
  assert.equal(darwin.files.length, 1);
  assert.match(darwin.files[0].path, /Library\/LaunchAgents\/.*\.plist$/u);
  assert.deepEqual(darwin.commands[0].slice(0, 2), ["launchctl", "bootout"]);
  assert.match(darwin.files[0].text, /StartInterval[\s\S]*1800/u, "plist 的 30 分钟语义");

  const linux = drainTimerPlan({ home, node, platform: "linux", read: () => null });
  assert.equal(linux.kind, "systemd");
  assert.deepEqual(linux.files.map((f) => f.path), [
    path.join(home, ".config", "systemd", "user", "feishu-bridge-cc-drain.service"),
    path.join(home, ".config", "systemd", "user", "feishu-bridge-cc-drain.timer"),
  ]);
  assert.deepEqual(linux.commands, [["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "feishu-bridge-cc-drain.timer"]]);
  assert.match(linux.files[0].text, /ExecStart=.*shims\/node .*drain-outbox\.mjs --all/u, "跑的就是同一条 drain --all");
  assert.match(linux.files[1].text, /OnUnitActiveSec=30min/u, "与 plist 同语义：30 分钟一次");
  assert.match(linux.files[1].text, /WantedBy=timers\.target/u);
  assert.match(String(linux.note ?? ""), /loginctl enable-linger/u, "持久化的前提要打印出来（但不执行）");

  const other = drainTimerPlan({ home, node, platform: "win32", read: () => null });
  assert.deepEqual([other.kind, other.action, other.files.length], [null, "unsupported", 0]);
  assert.match(other.note, /没有兜底定时器实现/u, "其它平台要明说未装，不假装装好");

  // unchanged / will-update：read 注入「盘上现在是什么」
  const linuxText = drainTimerPlan({ home, node, platform: "linux", read: () => null });
  const same = new Map(linuxText.files.map((f) => [f.path, f.text]));
  assert.equal(drainTimerPlan({ home, node, platform: "linux", read: (p) => same.get(p) ?? null }).action, "unchanged");
  assert.equal(drainTimerPlan({ home, node, platform: "linux", read: (p) => (same.has(p) ? "旧内容" : null) }).action, "will-update");
  assert.equal(drainTimerPlan({ home, node, platform: "linux", read: (p) => (p.endsWith(".service") ? same.get(p) : null) }).action, "will-install");
});

test("larkCliEnv：linux 才补 LARKSUITE_CLI_DATA_DIR=<configDir>/data（指向 data，不是 data/lark-cli）；darwin 不补", () => {
  const configDir = "/home/dinosak/.aily-cli/lark-cli/agent_x";
  const linux = larkCliEnv({ env: { A: "1" }, configDir, profile: "platform-bot", platform: "linux" });
  assert.deepEqual([linux.LARKSUITE_CLI_PROFILE, linux.LARKSUITE_CLI_CONFIG_DIR, linux.LARKSUITE_CLI_DATA_DIR],
    ["platform-bot", configDir, path.join(configDir, "data")], JSON.stringify(linux));
  assert.equal(linux.A, "1", "其余环境照旧继承");
  const darwin = larkCliEnv({ env: { A: "1" }, configDir, profile: "platform-bot", platform: "darwin" });
  assert.equal("LARKSUITE_CLI_DATA_DIR" in darwin, false, "macOS 走钥匙串，多设这个没实测过 → 不设");
  // 没有 configDir / profile 时不硬塞空值
  assert.deepEqual(larkCliEnv({ env: {}, configDir: null, profile: null, platform: "linux" }), {});
  // aily 写的密钥路径（doctor 用它对照打印）
  assert.equal(larkProvisionedSecretPath({ configDir, appId: "cli_x" }),
    path.join(configDir, "data", "lark-cli", "appsecret_cli_x.enc"));
  assert.equal(larkProvisionedSecretPath({ configDir: null, appId: "cli_x" }), null);
});

// ── PK3-L1-fix1（Codex 一轮 3 P1 + 2 P2）──────────────────────────────────────────────────
// 修前红：下面几条都是「按修后的契约写的」，旧实现会红。

test("fix1/P1-1 已安装路径优先（Mac 现网不漂移）：PATH 先命中 ~/.local/bin/node，但已安装的是 /opt/homebrew/bin/node → 选已安装", () => {
  const home = "/Users/dk";
  const installed = "/opt/homebrew/bin/node";
  const pathNode = "/Users/dk/.local/bin/node";
  const exists = (p) => [installed, pathNode].includes(p);
  // 修前：PATH 在 installed 之前 → 选 pathNode（现网三条 hook 的 node 会被改写）→ 红
  assert.equal(resolveNodeForHooks({ env: { PATH: "/Users/dk/.local/bin:/usr/bin" }, exists, access: alwaysExec,
    homedir: home, installed, platform: "darwin" }), installed, "已安装路径仍有效 → 不许改写");
  // installed 不存在 → darwin 退回 /opt/homebrew
  assert.equal(resolveNodeForHooks({ env: { PATH: "/Users/dk/.local/bin" }, exists: (p) => p === pathNode,
    access: alwaysExec, homedir: home, installed, platform: "darwin" }), pathNode, "installed 没了才轮到 PATH");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: (p) => p === "/opt/homebrew/bin/node",
    access: alwaysExec, homedir: home, installed: null, platform: "darwin" }), "/opt/homebrew/bin/node");
  // linux：PATH shim 优先（mise 切版本后 shim 不变）
  const shim = "/home/dinosak/.local/share/mise/shims/node";
  assert.equal(resolveNodeForHooks({ env: { PATH: "/usr/bin:" + path.dirname(shim) }, exists: (p) => p === shim,
    access: alwaysExec, homedir: "/home/dinosak", installed: "/usr/local/bin/node", platform: "linux" }), shim,
    "linux 上 PATH 在 installed 之后，但仍先于 /usr/local");
});

test("fix1/P1-1 候选必须绝对路径 + X_OK：PATH 里的相对/空段跳过，不可执行的候选跳过", () => {
  const exec = new Set(["/usr/local/bin/node"]);
  const access = (p) => { if (!exec.has(p)) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } };
  const got = resolveNodeForHooks({ env: { PATH: "relative/dir::/usr/bin" }, access, exists: () => true,
    homedir: "/home/x", installed: "relative/installed", platform: "linux" });
  assert.equal(got, "/usr/local/bin/node", "相对段不产生候选、不可执行的不算（access 注入）");
});

test("fix1/P1-2 卸载按平台：darwin 删 plist + bootout；linux disable --now + 删两份 unit + daemon-reload；其它明说无", () => {
  const home = "/h";
  const darwin = drainTimerPlan({ home, node: "/opt/homebrew/bin/node", platform: "darwin", uninstall: true });
  assert.equal(darwin.kind, "launchd");
  assert.deepEqual(darwin.files, [], "卸载不写文件");
  assert.deepEqual(darwin.remove, [darwin.remove[0]]);
  assert.match(darwin.remove[0], /Library\/LaunchAgents\/.*\.plist$/u);
  assert.deepEqual(darwin.commands[0].slice(0, 2), ["launchctl", "bootout"]);
  const linux = drainTimerPlan({ home, node: "/usr/bin/node", platform: "linux", uninstall: true });
  assert.equal(linux.kind, "systemd");
  assert.deepEqual(linux.remove.map((p) => path.basename(p)).sort(),
    ["feishu-bridge-cc-drain.service", "feishu-bridge-cc-drain.timer"]);
  // fix2 P1-2：三步顺序 —— disable --now **在删之前**，daemon-reload **在删之后**（两个数组就是那个"之间"）。
  assert.deepEqual(linux.commands, [["systemctl", "--user", "disable", "--now", "feishu-bridge-cc-drain.timer"]]);
  assert.deepEqual(linux.commandsAfterRemove, [["systemctl", "--user", "daemon-reload"]]);
  const other = drainTimerPlan({ home, node: "/usr/bin/node", platform: "win32", uninstall: true });
  assert.deepEqual([other.kind, other.action, other.remove ?? []], [null, "unsupported", []]);
});

test("fix1/P1-2 linux 计划的路径里绝不出现 LaunchAgents（预览与实际写入同一份计划）", () => {
  const p = drainTimerPlan({ home: "/h", node: "/usr/bin/node", platform: "linux", read: () => null });
  const all = [...p.files.map((f) => f.path), ...(p.remove ?? [])];
  assert.equal(all.some((x) => x.includes("LaunchAgents")), false, JSON.stringify(all));
  assert.ok(p.files.every((f) => f.path.includes(".config/systemd/user")), JSON.stringify(p.files.map((f) => f.path)));
});

// ── PK3-L1-fix2（Codex 二轮 3 P1 + 1 P2）──────────────────────────────────────────────────
// 这一批钉的都是**接线**：纯函数对了但生产入口没接上，等于没修（fix1 就是这么过去的 ——
// `installed` 只有纯函数测试走过，安装器与 doctor 全在裸调 pickClaudeNode()）。
// 所以下面尽量跑**真实入口**（子进程跑安装器、直调 runDoctor），而不是再写一遍纯函数断言。

const NODE_STUB = "#!/bin/sh\nexit 0\n";
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const tmpBase = (tag) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), tag));

/** 可执行的假 node：resolveNodeForHooks 的 installed 候选要过 X_OK，所以得是真文件。 */
function stubNode(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, NODE_STUB, { mode: 0o755 });
  return file;
}

/** 桥的 Stop hook 命令（带归属标记，与安装器生成的那条同形）。 */
const bridgeStopHook = (node) =>
  "if [ -x '" + node + "' ] && [ -r '/x/stop-hook.mjs' ]; then '" + node + "' '/x/stop-hook.mjs'; " +
  "else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; fi # FEISHU_BRIDGE_HOOK:stop-hook.mjs";

/** 安装器子进程的隔离环境：只碰夹具 HOME；机器级注入口一律显式清空（免得被外部环境改判）。 */
function installerEnv(home, extra = {}) {
  // PK3-I247：安装器 / 卸载入口的子进程环境统一走 installerChildEnv（= purgeChildEnv + 写目标断言）——
  // 继承的写目标 / 删除目标覆盖点（收据、安装面锁、桥根、覆盖文件）一律剔掉；下面这些显式字段照旧生效。
  return installerChildEnv({ env: process.env, home, extra: {
    FEISHU_BRIDGE_MAINTENANCE_GATE: path.join(home, "maintenance.gate"),
    FEISHU_BRIDGE_INSTALLED_SURFACE: "", FEISHU_BRIDGE_INSTALL_SURFACE_LOCK: "",
    FEISHU_BRIDGE_LAUNCHCTL: "", FEISHU_BRIDGE_SYSTEMCTL: "", FEISHU_BRIDGE_TIMER_PLATFORM: "",
    ...extra } });
}
const runInstaller = (env, args) => spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf-8", env });

test("fix2/P1-1 installedNodeFrom：收据守门，来源按 hooks → 定时器；只认绝对路径", () => {
  const installed = "/opt/installed/node";
  const plist = "<key>ProgramArguments</key>\n  <array>\n    <string>/opt/plist/node</string>\n  </array>";
  const unit = "[Service]\nExecStart=\"/opt/unit dir/node\" /x/drain-outbox.mjs --all\n";
  assert.equal(installedNodeFrom({ settingsHooks: [bridgeStopHook(installed)], timerExec: [plist] }), installed, "① hooks 优先于定时器");
  assert.equal(installedNodeFrom({ settingsHooks: [], timerExec: [plist] }), "/opt/plist/node", "② 没有 hooks 就看 plist");
  assert.equal(installedNodeFrom({ settingsHooks: [], timerExec: ["没这段", unit] }), "/opt/unit dir/node", "③ unit 的 ExecStart 首段（带引号也认）");
  assert.equal(installedNodeFrom({ settingsHooks: [], timerExec: [] }), null, "都没有 → null（调用方照旧走常规顺序）");
  assert.equal(installedNodeFrom({ receipt: { chains: {} }, settingsHooks: [bridgeStopHook(installed)] }), null,
    "收据在、但里面没有 claude 链 → 那两个制品不是我们的，不许从它们里面认 node");
  assert.equal(installedNodeFrom({ receipt: { chains: { claude: { artifacts: [] } } }, settingsHooks: [bridgeStopHook(installed)] }), installed, "收据有 claude 链 → 照常认");
  assert.equal(installedNodeFrom({ settingsHooks: ["if [ -x 'relative/node' ] && [ -r '/x/y' ]; then"], timerExec: [] }), null, "相对路径不算");
});

test("fix2/P1-1 生产入口真的把「已安装的 node」传进去了：预览与产物都用它，而不是 PATH 先命中的那个（子进程）", () => {
  const base = tmpBase("pk3fix2-node-");
  const home = path.join(base, "home");
  const installed = stubNode(path.join(base, "installed", "node"));
  const other = stubNode(path.join(base, "path-bin", "node"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  // 夹具：桥 hook 用的是这台机器上**已经装着的** node；PATH 里另有别的 node（更早命中）。
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(
    { hooks: { Stop: [{ hooks: [{ type: "command", timeout: 20, command: bridgeStopHook(installed) }] }] }, permissions: { allow: [] } }, null, 2) + "\n");
  const env = installerEnv(home, { PATH: path.dirname(other) + ":" + (process.env.PATH ?? "") });

  // ① 预览里就写明用的是哪个 node（修前这里打印的是 PATH / darwin 固定顺序命中的那个）。
  const dry = runInstaller(env, []);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp("^node     : " + escapeRe(installed) + "（", "mu"),
    "预览里的 node 必须是已安装那个：\n" + dry.stdout);
  assert.equal(dry.stdout.includes(path.dirname(other) + path.sep + "node"), false, "PATH 里那个不许出现在预览里");

  // ② 产物也用它：settings 的 hook 与定时器（plist / unit）—— 两条都是 NODE_BIN 派生的。
  const ap = runInstaller(env, ["--apply"]);
  assert.equal(ap.status, 0, ap.stderr);
  const settings = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8");
  assert.ok(settings.includes(installed), "settings 里三条 hook 用的是已安装 node");
  assert.equal(settings.includes(path.dirname(other)), false, "PATH 里那个 node 不许进 settings");
  const timerFile = process.platform === "darwin" ? claudeDrainPlistPath(home) : claudeDrainSystemdPaths(home).service;
  assert.ok(fs.readFileSync(timerFile, "utf-8").includes(installed), "定时器跑的就是已安装那个 node：" + timerFile);
});

/** linux 卸载夹具：真装一次（沙箱 HOME + 注入 systemctl），再按用例注入不同的 systemctl。 */
function linuxUninstallFixture() {
  const base = tmpBase("pk3fix2-uninst-");
  const home = path.join(base, "home");
  const log = path.join(base, "calls.log");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  const unitFile = claudeDrainSystemdPaths(home).service;
  // 假 systemctl：每次调用记一行 —— 调用本身 + **此刻单元文件还在不在**（删除必须发生在两步之间，
  // 只看调用顺序分不出「先 reload 再删」和「先删再 reload」）。
  const fake = (name, body) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, "#!/bin/sh\nprintf '%s | %s\\n' \"$*\" \"$( [ -f '" + unitFile + "' ] && echo present || echo gone )\" >> \"$PK3_LOG\"\n" + body, { mode: 0o755 });
    return file;
  };
  const ok = fake("systemctl-ok", "exit 0\n");
  const fails = fake("systemctl-fails", "if [ \"$2\" = \"disable\" ]; then echo 'Failed to disable unit: Access denied' >&2; exit 1; fi\nexit 0\n");
  const env = (bin) => installerEnv(home, { FEISHU_BRIDGE_TIMER_PLATFORM: "linux", FEISHU_BRIDGE_SYSTEMCTL: bin, PK3_LOG: log });
  return { home, log, unitFile, ok, fails, env, readLog: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n") : []) };
}

test("fix2/P1-2 linux 卸载三步顺序：disable --now（文件还在）→ 删 unit → daemon-reload（文件已不在），子进程 + 注入 systemctl", () => {
  const fx = linuxUninstallFixture();
  assert.equal(runInstaller(fx.env(fx.ok), ["--apply"]).status, 0, "先装一次");
  assert.ok(fs.existsSync(fx.unitFile), "装完单元在");
  const un = runInstaller(fx.env(fx.ok), ["--uninstall", "--apply"]);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(fx.unitFile), false, "单元删掉了");
  assert.match(un.stdout, /已卸载/u);
  const calls = fx.readLog();
  // PK3-U1：卸载现在也管 aily daemon 单元 —— 每个单元各自都是"停（文件还在）→ 删 → reload（文件已不在）"三步。
  // 逐单元切出来断言，别把另一条的步骤混进这条的期望里（混了就分不清是哪个单元的顺序坏了）。
  const perUnit = (unit) => {
    const at = calls.findIndex((l) => l.startsWith("--user disable --now " + unit + " |"));
    assert.notEqual(at, -1, "没找到 " + unit + " 的 disable --now：" + JSON.stringify(calls));
    return [calls[at], calls[at + 1]];
  };
  // 兜底定时器：disable --now 时它的单元文件还在（present），删完 reload 时已不在（gone）
  assert.deepEqual(perUnit("feishu-bridge-cc-drain.timer"),
    ["--user disable --now feishu-bridge-cc-drain.timer | present", "--user daemon-reload | gone"],
    "兜底定时器三步顺序（修前：daemon-reload 在删文件之前）：" + JSON.stringify(calls));
  // aily daemon 单元（PK3-U1）：同一条纪律 —— 先停（立刻跟着一次 reload，即"删完单元之后"）
  const ailyPair = perUnit("feishu-bridge-aily.service");
  assert.equal(ailyPair[0].startsWith("--user disable --now feishu-bridge-aily.service |"), true, JSON.stringify(calls));
  assert.equal(ailyPair[1], "--user daemon-reload | gone", "aily 单元也要「停 → 删 → reload」：" + JSON.stringify(calls));
  // 执行用的是**argv**，不是计划里给人看的命令行（修前是 `systemctl systemctl --user …`，静默失败还报已卸载）。
  assert.equal(calls.some((l) => l.startsWith("systemctl systemctl")), false, JSON.stringify(calls));
});

test("PK3-U2 systemdUnitAbsent 认 systemctl 对从未存在单元的原话「Unit x.service does not exist」；真失败不认", () => {
  assert.equal(systemdUnitAbsent("Failed to disable unit: Unit feishu-bridge-aily.service does not exist."), true);
  assert.equal(systemdUnitAbsent("Failed to disable unit: Unit file feishu-bridge-aily.service does not exist."), true, "带 file 的老写法照认");
  assert.equal(systemdUnitAbsent("Failed to disable unit: Access denied"), false, "真失败不许被当成不存在");
  // PK3-U2-fix1（Codex 一轮 P2）：点名单元时，只认"本单元不存在"；复合错误里别的单元不存在不算
  const U = "feishu-bridge-aily.service";
  assert.equal(systemdUnitAbsent("Failed to disable unit: Unit feishu-bridge-aily.service does not exist.", U), true);
  assert.equal(systemdUnitAbsent("Failed to disable unit: Access denied\nUnit other.service does not exist.", U), false,
    "真失败 + 别的单元不存在 → 不许判成本单元不存在（否则停用失败后会继续删文件）");
  assert.equal(systemdUnitAbsent("not-found", U), true, "is-enabled 对缺席单元只回 not-found");
});

// PK3-U2-fix1（Codex 一轮 P1）：本桥 aily 单元路径是断链符号链接 → 仍算"在盘上"（will-remove 并删掉），不许判 not-installed 留下残骸。
//   拿掉哪行会红：onDisk 退回 read(file) !== null → 断链判 not-installed、remove 为空，这里红。
test("PK3-U2-fix1 aily 单元是断链符号链接：卸载计划 will-remove 并列入删除，不判 not-installed", () => {
  const base = tmpBase("pk3u2f1-dangling-");
  const home = path.join(base, "home");
  const file = path.join(home, ".config", "systemd", "user", "feishu-bridge-aily.service");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(path.join(base, "gone-target.service"), file);
  const plan = ailyDaemonPlan({ home, platform: "linux", uninstall: true });
  assert.equal(plan.action, "will-remove", JSON.stringify(plan));
  assert.deepEqual(plan.remove, [file]);
});

// PK3-U2（omm 2026-09-19 真机）：本桥从没写过 aily 单元（机器上是 aily-cli 自己的单元），卸载却无条件
//   disable feishu-bridge-aily.service，systemctl 回「Unit … does not exist」→ 整个卸载中止在半截。
//   拿掉哪行会红：去掉 systemdUnitAbsent 的「unit \S+ does not exist」→ 卸载退 1、定时器单元还在。
test("PK3-U2 本桥没写过 aily 单元时卸载不中止：disable 回「does not exist」算本来没有，定时器照常卸干净（子进程 + 注入 systemctl）", () => {
  const fx = linuxUninstallFixture();
  assert.equal(runInstaller(fx.env(fx.ok), ["--apply"]).status, 0, "先装一次");
  const ailyFile = path.join(path.dirname(fx.unitFile), "feishu-bridge-aily.service");
  fs.rmSync(ailyFile, { force: true });   // omm 形状：磁盘上没有本桥的 aily 单元
  const notExist = path.join(path.dirname(fx.log), "systemctl-aily-not-exist");
  fs.writeFileSync(notExist, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PK3_LOG\"\n" +
    "case \"$*\" in *feishu-bridge-aily.service*) echo 'Failed to disable unit: Unit feishu-bridge-aily.service does not exist.' >&2; exit 1;; esac\nexit 0\n", { mode: 0o755 });
  const preview = runInstaller(fx.env(notExist), ["--uninstall"]);
  assert.match(preview.stdout, /aily daemon：not-installed/u, "预览不许说将删除一个不存在的文件：" + preview.stdout);
  const un = runInstaller(fx.env(notExist), ["--uninstall", "--apply"]);
  assert.equal(un.status, 0, "卸载不许中止：" + un.stdout + un.stderr);
  assert.doesNotMatch(un.stderr, /卸载中止/u, un.stderr);
  assert.equal(fs.existsSync(fx.unitFile), false, "兜底定时器照常卸干净");
  assert.match(un.stdout, /本来就没装/u, un.stdout);
});

test("fix2/P1-2 停不下来就不删、不报已卸载、退非零：disable 真失败（子进程 + 注入 systemctl）", () => {
  const fx = linuxUninstallFixture();
  assert.equal(runInstaller(fx.env(fx.ok), ["--apply"]).status, 0, "先装一次");
  const un = runInstaller(fx.env(fx.fails), ["--uninstall", "--apply"]);
  assert.notEqual(un.status, 0, "**必须退非零**");
  assert.ok(fs.existsSync(fx.unitFile), "**一个文件都没删**（它可能还在跑）");
  assert.equal(/已卸载/u.test(un.stdout), false, "不许说已卸载");
  assert.match(un.stdout + un.stderr, /Access denied/u, "要打印失败原因");
  assert.match(un.stdout + un.stderr, /一个文件都没删/u);
  // 反向：disable 说「本来就没有这个单元」= 干净卸载的常见形态，照旧卸完（不因为保守而永久卸不掉）。
  const fx2 = linuxUninstallFixture();
  assert.equal(runInstaller(fx2.env(fx2.ok), ["--apply"]).status, 0, "先装一次");
  const absent = path.join(path.dirname(fx2.ok), "systemctl-absent");
  // PK3-U2-fix1：假 systemctl 回的"不存在"要点名**被停用的那个单元**（$4）——判据现在只认本单元不存在，
  //   旧夹具对每个 disable 都回"drain.timer 不存在"，停用 aily 时那句点名的是别的单元，按新口径理应判失败。
  fs.writeFileSync(absent, "#!/bin/sh\nif [ \"$2\" = \"disable\" ]; then echo \"Failed to disable unit: Unit file $4 does not exist.\" >&2; exit 1; fi\nexit 0\n", { mode: 0o755 });
  const un2 = runInstaller(fx2.env(absent), ["--uninstall", "--apply"]);
  assert.equal(un2.status, 0, un2.stderr);
  assert.equal(fs.existsSync(fx2.unitFile), false, "「本来就没有」照旧卸完");
  assert.match(un2.stdout, /已卸载/u);
});

test("fix3/P1-1 Linux 安装：daemon-reload 失败不得继续 enable 且非零退出（子进程 + 注入 systemctl）", () => {
  const fx = linuxUninstallFixture();
  const reloadFails = path.join(path.dirname(fx.ok), "systemctl-reload-fails");
  fs.writeFileSync(reloadFails, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PK3_LOG\"\nif [ \"$2\" = \"daemon-reload\" ]; then echo 'Failed to reload: Bus communication error' >&2; exit 1; fi\nexit 0\n", { mode: 0o755 });
  const inst = runInstaller(fx.env(reloadFails), ["--apply"]);
  assert.notEqual(inst.status, 0, "daemon-reload 失败必须非零退出");
  assert.match(inst.stdout + inst.stderr, /daemon-reload 失败/u);
  assert.match(inst.stdout + inst.stderr, /Bus communication error/u);
  assert.equal(/已加载/u.test(inst.stdout), false, "不许报已加载");
  const calls = fx.readLog();
  assert.equal(calls.some((l) => l.includes("enable")), false, "daemon-reload 失败后决不能继续调用 enable：" + JSON.stringify(calls));
});

test("fix3/P1-1 Linux 安装：enable --now 失败非零退出且不报已加载（子进程 + 注入 systemctl）", () => {
  const fx = linuxUninstallFixture();
  const enableFails = path.join(path.dirname(fx.ok), "systemctl-enable-fails");
  fs.writeFileSync(enableFails, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PK3_LOG\"\nif [ \"$2\" = \"enable\" ]; then echo 'Failed to enable: Unit file is masked' >&2; exit 1; fi\nexit 0\n", { mode: 0o755 });
  const inst = runInstaller(fx.env(enableFails), ["--apply"]);
  assert.notEqual(inst.status, 0, "enable 失败必须非零退出");
  assert.match(inst.stdout + inst.stderr, /enable --now 失败/u);
  assert.match(inst.stdout + inst.stderr, /Unit file is masked/u);
  assert.equal(/已加载/u.test(inst.stdout), false, "不许报已加载");
});

test("fix3/P1-2 Linux 卸载：删 unit 后的 daemon-reload 失败要外显并非零退出、不报已卸载（子进程 + 注入 systemctl）", () => {
  const fx = linuxUninstallFixture();
  assert.equal(runInstaller(fx.env(fx.ok), ["--apply"]).status, 0, "先装一次");
  assert.ok(fs.existsSync(fx.unitFile), "装完单元在");
  const reloadFails = path.join(path.dirname(fx.ok), "systemctl-uninst-reload-fails");
  fs.writeFileSync(reloadFails, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PK3_LOG\"\nif [ \"$2\" = \"daemon-reload\" ]; then echo 'Failed to reload: Connection reset by peer' >&2; exit 1; fi\nexit 0\n", { mode: 0o755 });
  const un = runInstaller(fx.env(reloadFails), ["--uninstall", "--apply"]);
  assert.notEqual(un.status, 0, "daemon-reload 失败必须非零退出");
  assert.equal(fs.existsSync(fx.unitFile), false, "文件已删（已停止且文件已删）");
  assert.equal(/已卸载/u.test(un.stdout), false, "不许报已卸载");
  assert.match(un.stdout + un.stderr, /已停止、单元文件已删，但 systemd --user daemon-reload 失败：/u);
  assert.match(un.stdout + un.stderr, /请手工执行 systemctl --user daemon-reload/u);
});

/** doctor ⑥ 的 linux 夹具：盘上单元按投影写对、已安装 node 是 fixture 里那个、一个有积压的项目（有积压 ⑥ 才看发布器）。 */
function linuxDoctorFixture() {
  const base = tmpBase("pk3fix2-doctor-");
  const home = path.join(base, "home");
  const node = stubNode(path.join(base, "installed", "node"));
  const paths = claudeDrainSystemdPaths(home);
  fs.mkdirSync(paths.dir, { recursive: true });
  const units = claudeDrainSystemdUnits({ home, node });
  fs.writeFileSync(paths.service, units.service);
  fs.writeFileSync(paths.timer, units.timer);
  const project = path.join(base, "proj");
  const outbox = path.join(project, ".runtime-data", "outbound", "outbox");
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, "0001.json"), JSON.stringify(
    { id: "evt-000001", kind: "milestone", text: "夹具积压", created_at: "2026-08-24T00:00:01.000Z", published_at: null }));
  const registryFile = path.join(base, "registry.json");
  fs.writeFileSync(registryFile, JSON.stringify({ schema_version: "1.0", projects: [
    { id: "late", root: project, root_message_id: "om_x", status: "active", expires_at: "2099-01-01T00:00:00.000Z" }] }));
  const expected = claudeDrainExpectedJob({ home, node }).args;
  const showOf = (argv) => "{ path=" + argv[0] + " ; argv[]=" + argv.join(" ") + " ; ignore_errors=no ; start_time=[n/a] ; status=0/0 }";
  return { home, node, registryFile, expected,
    projectedShow: showOf(expected), oldShow: showOf(["/usr/bin/node", "/old/drain-outbox.mjs", "--all"]) };
}

/**
 * 假 systemctl：三态可注入。`inactive` 用**非零退出 + stdout 是状态词**——真 systemctl 就是这样，
 * 修前它被折成「查不清」。记下调用，用来钉「show 到底问了没、问的是不是 service 的 ExecStart」。
 */
function fakeSystemctl({ enabled = "enabled", active = "active", show = null, activeOut = null } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const sub = args[0] === "--user" ? args[1] : args[0];
    if (sub === "is-enabled") return { ok: true, out: enabled + "\n" };
    if (sub === "is-active") {
      const out = activeOut ?? active;
      return out === "inactive" ? { ok: false, out: "inactive\n", err: "" } : { ok: true, out: out + "\n" };
    }
    if (sub === "show") return { ok: true, out: String(show) };
    return { ok: false, out: "", err: "不认识的调用：" + args.join(" ") };
  };
  return { fn, calls };
}

const sixOf = (fx, systemctl) => runDoctor({ home: fx.home, platform: "linux", systemctl, registryFile: fx.registryFile })
  .checks.find((c) => c.id === "backlog_vs_publisher");

test("fix2/P1-3 doctor ⑥ 还要核 manager 里**已加载**的 ExecStart：磁盘对但 show 是旧的 → loaded_other；两边都对 → 绿", () => {
  const fx = linuxDoctorFixture();
  const good = fakeSystemctl({ show: fx.projectedShow });
  const green = sixOf(fx, good.fn);
  assert.equal(green.ok, true, green.detail);
  assert.match(green.detail, /已加载，正在按计划跑/u);
  assert.deepEqual(good.calls.find((a) => a.includes("show")),
    ["--user", "show", "feishu-bridge-cc-drain.service", "-p", "ExecStart", "--value"], "问的就是 service 的 ExecStart");

  // 磁盘 unit 与投影逐字相同，但 manager 里加载的是旧定义 → 不许报"已加载"。
  const stale = fakeSystemctl({ show: fx.oldShow });
  const other = sixOf(fx, stale.fn);
  assert.equal(other.ok, false, "有积压 + 跑的不是当前这份 → fail：" + other.detail);
  assert.match(other.detail, /参数不是当前这份/u);
  assert.match(other.detail, /已加载\*\*的 ExecStart 与当前投影不一致/u);
  assert.equal(/正在按计划跑/u.test(other.detail), false, "不许说在按计划跑");

  // 反向：没 enable 也没 active（= 真没装）就不该去问 show —— 别把"没装"做成"查不清"。
  const none = fakeSystemctl({ enabled: "disabled", active: "inactive" });
  const notInstalled = sixOf(fx, none.fn);
  assert.equal(notInstalled.ok, false, notInstalled.detail);
  assert.match(notInstalled.detail, /未启用|没被 systemd --user 加载/u);
  assert.equal(none.calls.some((a) => a.includes("show")), false, "没装就别问 show：" + JSON.stringify(none.calls));
});

test("fix2/P2 is-active 的 inactive 是**读到了状态**（installed_not_loaded），不是「查不清」；连不上 manager 才是查不清", () => {
  const fx = linuxDoctorFixture();
  // ① is-enabled=enabled + is-active 非零退出、stdout=inactive → 已装未加载（修前这里是"查不清"）。
  const inactive = sixOf(fx, fakeSystemctl({ active: "inactive" }).fn);
  assert.equal(inactive.ok, false, inactive.detail);
  assert.match(inactive.detail, /单元已写入但没被 systemd --user 加载/u);
  assert.match(inactive.detail, /已 enable 但未 active/u);
  assert.equal(/查不清/u.test(inactive.detail), false, "**不许折成查不清**：" + inactive.detail);

  // ② 连不上 manager（命令在、实例不在）→ 查不清（ok:null），既不说"没装"也不说"在跑"。
  const broken = fakeSystemctl({ active: "Failed to connect to bus: No such file or directory" });
  const brokenFn = (args) => (args.includes("is-active") ? { ok: false, out: "", err: "Failed to connect to bus: No such file or directory" } : broken.fn(args));
  const unverifiable = sixOf(fx, brokenFn);
  assert.equal(unverifiable.ok, null, unverifiable.detail);
  assert.match(unverifiable.detail, /查不清/u);
  assert.match(unverifiable.detail, /Failed to connect to bus/u);
});

/** darwin 定时器夹具：沙箱 HOME + 注入 launchctl。 */
function darwinTimerFixture() {
  const base = tmpBase("pk3fix4-darwin-");
  const home = path.join(base, "home");
  const log = path.join(base, "calls.log");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  const plistFile = claudeDrainPlistPath(home);
  // 假 launchctl：每次调用记一行 —— 调用参数 + **此刻 plist 文件还在不在**
  const fake = (name, body) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, "#!/bin/sh\nprintf '%s | %s\\n' \"$*\" \"$( [ -f '" + plistFile + "' ] && echo present || echo gone )\" >> \"$PK3_LOG\"\n" + body, { mode: 0o755 });
    return file;
  };
  const ok = fake("launchctl-ok", "exit 0\n");
  const fails = fake("launchctl-fails", "if [ \"$1\" = \"bootout\" ]; then echo 'Boot-out failed: 5: Input/output error' >&2; exit 1; fi\nexit 0\n");
  const absent = fake("launchctl-absent", "if [ \"$1\" = \"bootout\" ]; then echo 'Could not find service \"com.frank.feishu-bridge-cc.drain\" in domain' >&2; exit 1; fi\nexit 0\n");
  const env = (bin) => installerEnv(home, { FEISHU_BRIDGE_TIMER_PLATFORM: "darwin", FEISHU_BRIDGE_LAUNCHCTL: bin, PK3_LOG: log });
  return { home, log, plistFile, ok, fails, absent, env, readLog: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n") : []) };
}

test("fix4/P1 Darwin 卸载 argv 钉：bootout 收到真实 uid 且不含字面量 <uid>，bootout 失败时不删 plist 退非零（子进程 + 注入 launchctl）", () => {
  const fx = darwinTimerFixture();
  assert.equal(runInstaller(fx.env(fx.ok), ["--apply"]).status, 0, "先装一次");
  assert.ok(fs.existsSync(fx.plistFile), "装完 plist 在");

  // ① 卸载成功：断言 argv 钉（真实 uid，无字面量 <uid>），且 plist 被删
  const callsBefore = fx.readLog().length;
  const un = runInstaller(fx.env(fx.ok), ["--uninstall", "--apply"]);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(fx.plistFile), false, "正常卸载 plist 删掉了");
  assert.match(un.stdout, /已卸载/u);
  const uninstCalls = fx.readLog().slice(callsBefore);
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  assert.equal(uninstCalls.length, 1, "卸载阶段只调一次 bootout：" + JSON.stringify(uninstCalls));
  assert.equal(uninstCalls[0], "bootout gui/" + uid + "/" + CLAUDE_DRAIN_LAUNCH_LABEL + " | present",
    "bootout argv 钉：必须替换 <uid> 为真实 uid：" + uninstCalls[0]);
  assert.equal(uninstCalls[0].includes("<uid>"), false, "不许带字面量 <uid>");

  // ② bootout 真失败（非 absent）：不删 plist、退非零、不报已卸载
  const fxFails = darwinTimerFixture();
  assert.equal(runInstaller(fxFails.env(fxFails.ok), ["--apply"]).status, 0, "先装一次");
  assert.ok(fs.existsSync(fxFails.plistFile), "装完 plist 在");
  const unFails = runInstaller(fxFails.env(fxFails.fails), ["--uninstall", "--apply"]);
  assert.notEqual(unFails.status, 0, "**bootout 失败必须退非零**");
  assert.ok(fs.existsSync(fxFails.plistFile), "**一个文件都没删**（plist 仍在）：" + fxFails.plistFile);
  assert.equal(/已卸载/u.test(unFails.stdout), false, "不许报已卸载");
  assert.match(unFails.stdout + unFails.stderr, /Boot-out failed: 5: Input\/output error/u, "打印失败原因");
  assert.match(unFails.stdout + unFails.stderr, /一个文件都没删/u);

  // ③ bootout 报 absent（服务本来不存在）：正常删除 plist、报已卸载、退出 0
  const fxAbsent = darwinTimerFixture();
  assert.equal(runInstaller(fxAbsent.env(fxAbsent.ok), ["--apply"]).status, 0, "先装一次");
  const unAbsent = runInstaller(fxAbsent.env(fxAbsent.absent), ["--uninstall", "--apply"]);
  assert.equal(unAbsent.status, 0, unAbsent.stderr);
  assert.equal(fs.existsSync(fxAbsent.plistFile), false, "「本来就没有」照旧删 plist");
  assert.match(unAbsent.stdout, /已卸载/u);
});

test("fix4/P1 Darwin 安装 bootstrap argv 钉：bootstrap 收到真实 uid 且不含字面量 <uid>（子进程 + 注入 launchctl）", () => {
  const fx = darwinTimerFixture();
  const inst = runInstaller(fx.env(fx.ok), ["--apply"]);
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(fs.existsSync(fx.plistFile), "装完 plist 在");
  assert.match(inst.stdout, /已加载/u);
  const calls = fx.readLog();
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const bootstrapCall = calls.find((l) => l.startsWith("bootstrap"));
  assert.ok(bootstrapCall, "安装必须调过 bootstrap：" + JSON.stringify(calls));
  assert.equal(bootstrapCall, "bootstrap gui/" + uid + " " + fx.plistFile + " | present",
    "bootstrap argv 钉：必须替换 <uid> 为真实 uid：" + bootstrapCall);
  assert.equal(bootstrapCall.includes("<uid>"), false, "不许带字面量 <uid>");
});

test("PK3-L3 timerPhase(linux)：钉 loaded / installed_not_loaded / absent / orphan 四相与 unverifiable", () => {
  const fx = linuxDoctorFixture();
  const facts = chainFacts({ chain: "claude", home: fx.home, platform: "linux", node: fx.node });
  assert.equal(facts.timer.kind, "systemd");

  // ① loaded：单元在、enabled+active、show ExecStart 符合当前投影
  const goodCtl = fakeSystemctl({ show: fx.projectedShow });
  const loaded = timerPhase({ ...facts.timer, systemctl: goodCtl.fn });
  assert.equal(loaded.phase, "loaded");
  assert.ok(loaded.plistBytes instanceof Buffer, "loaded 必须带 unit 字节备份供 journal 使用");
  assert.equal(loaded.why, null);

  // ② installed_not_loaded：单元在且匹配，明确稳定的不运行状态（inactive 或 failed，且 enabled 或 disabled）
  const inactiveCtl = fakeSystemctl({ enabled: "enabled", active: "inactive" });
  const notLoaded = timerPhase({ ...facts.timer, systemctl: inactiveCtl.fn });
  assert.equal(notLoaded.phase, "installed_not_loaded");
  assert.ok(notLoaded.plistBytes instanceof Buffer);

  const disabledInactiveCtl = fakeSystemctl({ enabled: "disabled", active: "inactive" });
  const notLoaded2 = timerPhase({ ...facts.timer, systemctl: disabledInactiveCtl.fn });
  assert.equal(notLoaded2.phase, "installed_not_loaded");

  const failedCtl = fakeSystemctl({ enabled: "enabled", active: "failed" });
  const notLoaded3 = timerPhase({ ...facts.timer, systemctl: failedCtl.fn });
  assert.equal(notLoaded3.phase, "installed_not_loaded");

  // ③ absent：两份 unit 都不在，且 systemd 里未启用也未运行
  const emptyBase = tmpBase("pk3-timer-absent-");
  const emptyHome = path.join(emptyBase, "home");
  const absentFacts = chainFacts({ chain: "claude", home: emptyHome, platform: "linux", node: fx.node });
  const absentCtl = fakeSystemctl({ enabled: "disabled", active: "inactive" });
  const absent = timerPhase({ ...absentFacts.timer, systemctl: absentCtl.fn });
  assert.equal(absent.phase, "absent");
  assert.equal(absent.plistBytes, null);

  // ④ orphan：
  //   只留给「磁盘上无单元，但 manager 里仍 enabled 或 active」
  const orphanCtlA = fakeSystemctl({ enabled: "enabled", active: "active", show: fx.projectedShow });
  const orphanA = timerPhase({ ...absentFacts.timer, systemctl: orphanCtlA.fn });
  assert.equal(orphanA.phase, "orphan");
  assert.match(orphanA.why, /磁盘上无 unit 文件/u);

  // ⑤ P2-1 loaded_other：单元在且 enabled+active，但已加载的 ExecStart 与当前投影不符
  const staleExecCtl = fakeSystemctl({ show: fx.oldShow });
  const otherExec = timerPhase({ ...facts.timer, systemctl: staleExecCtl.fn });
  assert.equal(otherExec.phase, "loaded_other");
  assert.match(otherExec.why, /ExecStart 与当前投影不一致/u);

  // ⑥ unverifiable：
  //   情况 A：连不上 manager（is-enabled / is-active 查不清）
  const brokenCtl = (args) => ({ ok: false, out: "", err: "Failed to connect to bus: Connection refused" });
  const unvA = timerPhase({ ...facts.timer, systemctl: brokenCtl });
  assert.equal(unvA.phase, "unverifiable");
  assert.match(unvA.why, /Failed to connect to bus/u);

  //   情况 B：show 查不了（show 失败）
  const brokenShowCtl = (args) => {
    if (args.includes("show")) return { ok: false, out: "", err: "show failed" };
    return goodCtl.fn(args);
  };
  const unvB = timerPhase({ ...facts.timer, systemctl: brokenShowCtl });
  assert.equal(unvB.phase, "unverifiable");
  assert.match(unvB.why, /show 查不了/u);

  // ⑦ other 平台（win32/freebsd 等）：明说无定时器实现，按 absent 处理
  const winFacts = chainFacts({ chain: "claude", home: fx.home, platform: "win32", node: fx.node });
  assert.equal(winFacts.timer.kind, null);
  const winTimer = timerPhase({ ...winFacts.timer });
  assert.equal(winTimer.phase, "absent");
  assert.equal(winTimer.plistBytes, null);
});

test("PK3-L3-fix1 P1-1 active+disabled 与过渡态拒绝进门：disabled+active 拒、activating 拒，只有明确稳定不运行态归 installed_not_loaded", () => {
  const fx = linuxDoctorFixture();
  const facts = chainFacts({ chain: "claude", home: fx.home, platform: "linux", node: fx.node });

  // ① disabled + active：实际在跑但未托管 → 拒（phase running_unmanaged，非原始三态）
  const disabledActive = fakeSystemctl({ enabled: "disabled", active: "active" });
  const r1 = timerPhase({ ...facts.timer, systemctl: disabledActive.fn });
  assert.notEqual(r1.phase, "installed_not_loaded", "active+disabled 绝不许归 installed_not_loaded 从而被预检放行！");
  assert.equal(r1.phase, "running_unmanaged");
  assert.match(r1.why, /active.*未 enabled/u);

  // ② activating 等过渡态 → 拒（phase transitional，非原始三态）
  const activating = fakeSystemctl({ enabled: "enabled", active: "activating" });
  const r2 = timerPhase({ ...facts.timer, systemctl: activating.fn });
  assert.notEqual(r2.phase, "installed_not_loaded", "activating 过渡态不许归 installed_not_loaded！");
  assert.equal(r2.phase, "transitional");
  assert.match(r2.why, /过渡态/u);

  // ③ reloading 过渡态 → 拒
  const reloading = fakeSystemctl({ enabled: "enabled", active: "reloading" });
  const r3 = timerPhase({ ...facts.timer, systemctl: reloading.fn });
  assert.equal(r3.phase, "transitional");

  // ④ enabled+inactive 与 disabled+inactive：明确稳定的不运行状态 → installed_not_loaded
  const enIn = timerPhase({ ...facts.timer, systemctl: fakeSystemctl({ enabled: "enabled", active: "inactive" }).fn });
  assert.equal(enIn.phase, "installed_not_loaded");
  const disIn = timerPhase({ ...facts.timer, systemctl: fakeSystemctl({ enabled: "disabled", active: "inactive" }).fn });
  assert.equal(disIn.phase, "installed_not_loaded");
});

test("PK3-L3-fix1 P1-2 两份 unit 齐全与字节投影无条件先核：stale+inactive 归 stale，只缺一份 unit 归 partial_unit 拒进门", () => {
  const fx = linuxDoctorFixture();
  const paths = claudeDrainSystemdPaths(fx.home);

  // ① 两份 unit 在盘但字节被篡改（stale）+ inactive：
  // 即使处于 inactive 态，也必须优先判出 stale 并拒进门，绝不许被判定为 installed_not_loaded 放行！
  fs.writeFileSync(paths.service, "[Service]\n# 篡改内容\n");
  const factsStale = chainFacts({ chain: "claude", home: fx.home, platform: "linux", node: fx.node });
  const inactiveCtl = fakeSystemctl({ enabled: "enabled", active: "inactive" });
  const rStale = timerPhase({ ...factsStale.timer, systemctl: inactiveCtl.fn });
  assert.equal(rStale.phase, "stale", "即使 inactive，字节不匹配也必须是 stale（修前被判定为 installed_not_loaded 放行）");
  assert.match(rStale.why, /与当前投影不一致/u);

  // ② 缺失 service 单元（只有 timer 单元）：
  fs.unlinkSync(paths.service);
  const factsMissingService = chainFacts({ chain: "claude", home: fx.home, platform: "linux", node: fx.node });
  const rMiss = timerPhase({ ...factsMissingService.timer, systemctl: inactiveCtl.fn });
  assert.notEqual(rMiss.phase, "installed_not_loaded", "只缺一份 unit 绝不许判为 installed_not_loaded");
  assert.equal(rMiss.phase, "partial_unit");
  assert.match(rMiss.why, /feishu-bridge-cc-drain\.service/u);

  // ③ 缺失 timer 单元（只有 service 单元）：
  const units = claudeDrainSystemdUnits({ home: fx.home, node: fx.node });
  fs.writeFileSync(paths.service, units.service);
  fs.unlinkSync(paths.timer);
  const factsMissingTimer = chainFacts({ chain: "claude", home: fx.home, platform: "linux", node: fx.node });
  const rMissTimer = timerPhase({ ...factsMissingTimer.timer, systemctl: inactiveCtl.fn });
  assert.notEqual(rMissTimer.phase, "installed_not_loaded");
  assert.equal(rMissTimer.phase, "partial_unit");
  assert.match(rMissTimer.why, /feishu-bridge-cc-drain\.timer/u);
});

test("PK3-L3 沙箱隔离：沙箱 HOME 不碰真实 systemctl --user；未注入时返回 unverifiable", () => {
  const sandboxHome = path.join(tmpBase("pk3-sandbox-"), "home");
  const facts = chainFacts({ chain: "claude", home: sandboxHome, platform: "linux" });
  const prevEnv = process.env.FEISHU_BRIDGE_SYSTEMCTL;
  delete process.env.FEISHU_BRIDGE_SYSTEMCTL;
  try {
    const unv = timerPhase({ ...facts.timer, home: sandboxHome });
    assert.equal(unv.phase, "unverifiable");
    assert.match(unv.why, /沙箱.*不碰真实 systemctl --user/u);
  } finally {
    if (prevEnv !== undefined) process.env.FEISHU_BRIDGE_SYSTEMCTL = prevEnv;
  }
});

test("PK3-L3 Linux 维护门停与恢复：bootout 走 systemctl stop，bootstrap 走 reload + enable/start", () => {
  const fx = linuxDoctorFixture();
  const facts = chainFacts({ chain: "claude", home: fx.home, platform: "linux", node: fx.node });

  // ① bootout 成功
  const stopCalls = [];
  const stopCtl = (args) => {
    stopCalls.push(args);
    if (args.includes("stop")) return { ok: true, out: "" };
    return { ok: false, out: "", err: "unknown" };
  };
  const b1 = bootoutTimer({ ...facts.timer, systemctl: stopCtl });
  assert.equal(b1.ok, true);
  assert.equal(b1.absent, false);
  assert.ok(stopCalls.some((a) => a.includes("stop") && a.includes("feishu-bridge-cc-drain.timer")),
    "bootout 调了 systemctl stop 且针对 timer 单元：" + JSON.stringify(stopCalls));

  // ② bootout absent（单元本来就不存在）
  const absentCtl = (args) => ({ ok: false, out: "", err: "Unit feishu-bridge-cc-drain.timer not-found." });
  const b2 = bootoutTimer({ ...facts.timer, systemctl: absentCtl });
  assert.equal(b2.ok, true);
  assert.equal(b2.absent, true);

  // ③ bootout 真实失败
  const failCtl = (args) => ({ ok: false, out: "", err: "Failed to stop unit: Permission denied" });
  const b3 = bootoutTimer({ ...facts.timer, systemctl: failCtl });
  assert.equal(b3.ok, false);
  assert.match(b3.why, /Permission denied/u);

  // ④ bootstrap 成功：daemon-reload → enable/start → loadedPhase 为 loaded
  const bootCalls = [];
  let timerActive = false;
  const resumeCtl = (args) => {
    bootCalls.push(args);
    if (args.includes("daemon-reload")) return { ok: true, out: "" };
    if (args.includes("enable") || args.includes("start")) {
      timerActive = true;
      return { ok: true, out: "" };
    }
    if (args.includes("is-enabled")) return { ok: true, out: "enabled\n" };
    if (args.includes("is-active")) return timerActive ? { ok: true, out: "active\n" } : { ok: false, out: "inactive\n" };
    if (args.includes("show")) return { ok: true, out: fx.projectedShow };
    return { ok: false, out: "", err: "unknown" };
  };
  const bs = bootstrapTimer({ ...facts.timer, systemctl: resumeCtl });
  assert.equal(bs.ok, true, bs.why);
  assert.ok(bootCalls.some((a) => a.includes("daemon-reload")), "bootstrap 调了 daemon-reload：" + JSON.stringify(bootCalls));
  assert.ok(bootCalls.some((a) => a.includes("enable") || a.includes("start")), "bootstrap 调了 enable/start：" + JSON.stringify(bootCalls));

  // ⑤ bootstrap 失败（daemon-reload 失败外显）
  const reloadFailCtl = (args) => {
    if (args.includes("daemon-reload")) return { ok: false, out: "", err: "Access denied" };
    return { ok: true, out: "" };
  };
  const bsFail = bootstrapTimer({ ...facts.timer, systemctl: reloadFailCtl });
  assert.equal(bsFail.ok, false);
  assert.match(bsFail.why, /daemon-reload 失败/u);
});

test("PK3-L3 预检与维护门：Linux + loaded 下正常进门，停定时器、切桩、建门全链路通过", () => {
  const base = tmpBase("pk3-linux-gate-");
  const home = path.join(base, "home");
  const codexHome = path.join(base, "codex-home");
  const codexBridge = path.join(base, "codex-bridge");
  const dir = path.join(home, ".claude", "feishu-bridge", "maintenance");
  const gateFile = path.join(home, ".claude", "feishu-bridge", "maintenance.gate");

  // 准备环境与安装产物
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  const node = stubNode(path.join(base, "installed", "node"));
  const env = installerEnv(home, {
    FEISHU_BRIDGE_NODE: node,
    FEISHU_BRIDGE_TIMER_PLATFORM: "linux",
    CODEX_HOME: codexHome,
    FEISHU_CODEX_BRIDGE_HOME: codexBridge,
  });
  // 安装 outbound / inbound / codex
  execFileSync(process.execPath, [path.resolve("scripts", "install-outbound.mjs"), "--apply"], { encoding: "utf-8", env });
  execFileSync(process.execPath, [path.resolve("scripts", "install-inbound.mjs"), "--apply"], { encoding: "utf-8", env });
  execFileSync(process.execPath, [path.resolve("scripts", "codex", "install.mjs"), "--apply"], { encoding: "utf-8", env });

  // 假 systemctl：loaded 态
  const expected = claudeDrainExpectedJob({ home, node }).args;
  const projectedShow = "{ path=" + expected[0] + " ; argv[]=" + expected.join(" ") + " ; ignore_errors=no ; start_time=[n/a] ; status=0/0 }";
  let isTimerActive = true;
  const sysCalls = [];
  const fakeSys = (args) => {
    sysCalls.push(args);
    if (args.includes("is-enabled")) return { ok: true, out: "enabled\n" };
    if (args.includes("is-active")) return isTimerActive ? { ok: true, out: "active\n" } : { ok: false, out: "inactive\n" };
    if (args.includes("show")) return { ok: true, out: projectedShow };
    if (args.includes("stop")) { isTimerActive = false; return { ok: true, out: "" }; }
    if (args.includes("daemon-reload") || args.includes("enable") || args.includes("start")) {
      isTimerActive = true;
      return { ok: true, out: "" };
    }
    return { ok: false, out: "", err: "unknown" };
  };

  // 1. precheckStartupSources: linux 平台全绿
  const pre = precheckStartupSources({
    home,
    codexHome,
    codexBridgeHome: codexBridge,
    repoRoot: REPO,
    node,
    platform: "linux",
    systemctl: fakeSys,
  });
  assert.equal(pre.ok, true, "预检在 Linux + loaded 下必须全绿：" + JSON.stringify(pre.items.filter((i) => !i.ok)));
  assert.equal(pre.chains.claude.timer.phase, "loaded");
  assert.equal(pre.chains.codex.timer.phase, "absent", "Codex 在 Linux 上无 timer，按 absent 绿");

  // 2. maintenanceContext + enterMaintenance (dry-run & apply)
  let clock = 1000000;
  const ctx = maintenanceContext({
    home,
    codexHome,
    codexBridgeHome: codexBridge,
    repoRoot: REPO,
    node,
    ps: () => ({ ok: true, stdout: "  PID  PPID COMMAND\n" }),
    now: () => clock,
    dir,
    gateFile,
    platform: "linux",
    systemctl: fakeSys,
  });

  const dry = enterMaintenance(ctx, { reason: "测试 Linux 维护门", apply: false });
  assert.equal(dry.ok, true, "dryRun 成功进门：" + JSON.stringify(dry));
  assert.equal(dry.plan.chains.claude.timer, "loaded");
  assert.equal(dry.plan.chains.codex.timer, "absent");

  const enter = enterMaintenance(ctx, { reason: "测试 Linux 维护门", apply: true });
  assert.equal(enter.ok, true, "apply 成功进门：" + JSON.stringify(enter));
  assert.equal(enter.phase, "drained");
  assert.ok(sysCalls.some((a) => a.includes("stop")), "进门停了定时器：" + JSON.stringify(sysCalls));

  // 3. exitMaintenance 回退
  const ex = exitMaintenance(ctx, { apply: true });
  assert.equal(ex.ok, true, "成功出门：" + JSON.stringify(ex));
  assert.equal(ex.phase, "rolled_back");
  assert.ok(sysCalls.some((a) => a.includes("daemon-reload") || a.includes("start")), "出门恢复了定时器：" + JSON.stringify(sysCalls));
});

// ── PK3-L4-fix1（Codex 一轮 P1）：平台隔离点只在受验测试沙箱里生效 ──────────────────────────
// 修前：`timerPlatform(env)` 无条件读 env → 生产入口（安装器 / doctor / 维护门 / 预检）里
// 留一个 `FEISHU_BRIDGE_TIMER_PLATFORM=linux` 就能让 Mac 改走 systemd（反之亦然），而它改的是
// **协议、路径与落盘对象**，不只是「用哪个二进制」——四个面共享同一个错值只会让错误彼此「对得上」。

test("fix1/P1-1 真 HOME 下一律 process.platform（env=linux 也忽略）并有提示；沙箱 HOME 才认它、值不封闭则抛", () => {
  const realHome = os.userInfo().homedir;
  const sandbox = path.join(os.tmpdir(), "pk3-l4-fix1-sandbox");
  const warns = [];
  const warn = (m) => warns.push(m);

  // ① 真 HOME + env=linux → 仍 process.platform（Mac 上就是 darwin）。
  //    **修前红**：旧实现返回 "linux"，于是同一台 Mac 会去写/查 systemd 单元。
  const real = resolveTimerPlatform({ env: { [TIMER_PLATFORM_ENV]: "linux" }, home: realHome, warn });
  assert.equal(real.platform, process.platform, "真 HOME 下这个变量不许改判据：" + JSON.stringify(real));
  assert.deepEqual([real.injected, real.ignored], [false, true], JSON.stringify(real));
  assert.equal(warns.length, 1, "忽略必须说出来（不静默）：" + JSON.stringify(warns));
  assert.match(warns[0], /已忽略/u);
  assert.match(warns[0], new RegExp(TIMER_PLATFORM_ENV, "u"));
  assert.match(warns[0], /linux/u, "提示要点名忽略了什么值");

  // ② 沙箱 HOME（与 launchctl / systemctl 注入同一判据）才认它，值封闭内照用
  const boxed = resolveTimerPlatform({ env: { [TIMER_PLATFORM_ENV]: "linux" }, home: sandbox, realHome, warn });
  assert.deepEqual([boxed.platform, boxed.injected, boxed.ignored], ["linux", true, false], JSON.stringify(boxed));
  assert.equal(resolveTimerPlatform({ env: { [TIMER_PLATFORM_ENV]: "darwin" }, home: sandbox, realHome, warn }).platform, "darwin");
  assert.equal(warns.length, 1, "生效时不再提示");

  // ③ 沙箱 + 值不封闭 → **抛**（旧行为是原样接受 → timerKind=null → 安静地不装定时器）
  assert.throws(() => resolveTimerPlatform({ env: { [TIMER_PLATFORM_ENV]: "win32" }, home: sandbox, realHome, warn }),
    /darwin \/ linux/u, "沙箱里的非法值必须抛");
  assert.throws(() => resolveTimerPlatform({ env: { [TIMER_PLATFORM_ENV]: "Darwin" }, home: sandbox, realHome, warn }), /darwin \/ linux/u);

  // ④ 真 HOME + 值不封闭 → **不抛**（生产不许被这个变量弄崩：它本来就不该被读），只忽略
  const junk = resolveTimerPlatform({ env: { [TIMER_PLATFORM_ENV]: "win32" }, home: realHome, warn });
  assert.deepEqual([junk.platform, junk.ignored], [process.platform, true], JSON.stringify(junk));

  // ⑤ 未设 / 空串 → process.platform，且不提示
  assert.deepEqual([
    timerPlatform({ env: {}, home: sandbox, realHome, warn }),
    timerPlatform({ env: { [TIMER_PLATFORM_ENV]: "" }, home: sandbox, realHome, warn }),
  ], [process.platform, process.platform]);
  assert.equal(warns.length, 2, "只有那两条真-HOME 提示：" + JSON.stringify(warns));
});

test("fix1/P1-1 四个调用点传的是**当下 home**：沙箱 home 下 env 生效、把 home 丢掉就红（产品入口）", () => {
  // 这条钉的是接线：调用点若只写 `timerPlatform()`（默认 home = 真家目录），夹具的沙箱 home 就白给了
  // —— 下面的 "linux" 会变成 process.platform。
  const realHome = os.userInfo().homedir;
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pk3l4fix1-"));
  const saved = process.env[TIMER_PLATFORM_ENV];
  process.env[TIMER_PLATFORM_ENV] = "linux";
  try {
    // 维护门 ctx（operation.maintenanceContext）
    assert.equal(maintenanceContext({ home: sandbox }).platform, "linux", "维护门要走当下 home 判沙箱");
    // precheck 的两处（chainFacts / precheckStartupSources）
    assert.equal(chainFacts({ chain: "claude", home: sandbox }).timer.kind, "systemd", "chainFacts 要按当下 home 判沙箱");
    assert.equal(precheckStartupSources({ home: sandbox, codexHome: path.join(sandbox, ".codex"), repoRoot: REPO, launchctl: () => ({ ok: false, detail: "Could not find service" }) }).chains.claude.facts.timer.kind,
      "systemd", "precheckStartupSources 要按当下 home 判沙箱");
    // doctor：不传 platform 参数、只给 env（走的就是 env 那条路）
    const fx = linuxDoctorFixture();
    const six = runDoctor({ home: fx.home, systemctl: fakeSystemctl({ show: fx.projectedShow }).fn, registryFile: fx.registryFile })
      .checks.find((c) => c.id === "backlog_vs_publisher");
    assert.match(six.detail, /systemd --user/u, "doctor 要按当下 home 读 env：" + six.detail);
  } finally {
    if (saved === undefined) delete process.env[TIMER_PLATFORM_ENV]; else process.env[TIMER_PLATFORM_ENV] = saved;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  assert.equal(realHome, os.userInfo().homedir, "没动真家目录");
});

test("PK3-L6 doctor(linux)：每一次调用 systemctl 的 argv[0] 恒为 --user（注入函数与 FEISHU_BRIDGE_SYSTEMCTL 假二进制全覆盖）", () => {
  const fx = linuxDoctorFixture();

  // 1. 注入函数路径：逐一断言每次调用 argv[0] === "--user"（is-enabled / is-active / show 三处逐一）
  const recordedCalls = [];
  const recordingSystemctl = (args) => {
    recordedCalls.push(args);
    if (args.includes("is-enabled")) return { ok: true, out: "enabled\n" };
    if (args.includes("is-active")) return { ok: true, out: "active\n" };
    if (args.includes("show")) return { ok: true, out: fx.projectedShow };
    return { ok: false, out: "", err: "unknown" };
  };

  const doc = runDoctor({ home: fx.home, platform: "linux", systemctl: recordingSystemctl, registryFile: fx.registryFile });
  const check = doc.checks.find((c) => c.id === "backlog_vs_publisher");
  assert.equal(check.ok, true, check.detail);
  // PK3-U1-fix4 P1-3：aily daemon 项现在**磁盘不在也问一次 manager**（四象限），所以总调用数多了两次；
  // 本用例管的是「定时器那三项问得对不对、每次 argv[0] 是不是 --user」，所以按 unit 名筛出定时器那三条。
  const drainCalls = recordedCalls.filter((a) => !a.includes("feishu-bridge-aily.service"));
  const ailyCalls = recordedCalls.filter((a) => a.includes("feishu-bridge-aily.service"));
  assert.equal(drainCalls.length, 3, "定时器的 is-enabled / is-active / show 必须各调用一次：" + JSON.stringify(recordedCalls));
  assert.equal(ailyCalls.length, 2, "aily 项要独立问一次 manager（is-enabled + is-active）：" + JSON.stringify(recordedCalls));
  assert.deepEqual(drainCalls[0].slice(0, 2), ["--user", "is-enabled"]);
  assert.deepEqual(drainCalls[1].slice(0, 2), ["--user", "is-active"]);
  assert.deepEqual(drainCalls[2].slice(0, 2), ["--user", "show"]);
  for (const call of recordedCalls) {
    assert.equal(call[0], "--user", "注入函数路径每次调用 argv[0] 必须是 --user: " + JSON.stringify(call));
  }

  // 2. FEISHU_BRIDGE_SYSTEMCTL 假二进制路径：写入 log 文件，每行首项是 --user
  const base = tmpBase("pk3-l6-doctor-bin-");
  const bin = path.join(base, "fake-systemctl.sh");
  const log = path.join(base, "calls.log");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$2" = "is-enabled" ]; then echo "enabled"; exit 0; fi\nif [ "$2" = "is-active" ]; then echo "active"; exit 0; fi\nif [ "$2" = "show" ]; then echo "${fx.projectedShow}"; exit 0; fi\nexit 0\n`, { mode: 0o755 });

  const prevEnv = process.env.FEISHU_BRIDGE_SYSTEMCTL;
  process.env.FEISHU_BRIDGE_SYSTEMCTL = bin;
  try {
    const docBin = runDoctor({ home: fx.home, platform: "linux", registryFile: fx.registryFile });
    const checkBin = docBin.checks.find((c) => c.id === "backlog_vs_publisher");
    assert.equal(checkBin.ok, true, checkBin.detail);
    assert.ok(fs.existsSync(log), "假二进制必须产生调用日志");
    const lines = fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
    // 同上：把 aily 项那两次（fix4 P1-3 新增）筛出去，本用例的断言对象是定时器那三条。
    const drainLines = lines.filter((l) => !l.includes("feishu-bridge-aily.service"));
    assert.equal(drainLines.length, 3, "假二进制必须记录定时器的 3 次调用：" + JSON.stringify(lines));
    assert.equal(lines.length - drainLines.length, 2, "加 aily 的两次：" + JSON.stringify(lines));
    for (const line of lines) {
      assert.match(line, /^--user(\s|$)/, "文件里每行首项必须是 --user：" + line);
    }
  } finally {
    if (prevEnv === undefined) delete process.env.FEISHU_BRIDGE_SYSTEMCTL;
    else process.env.FEISHU_BRIDGE_SYSTEMCTL = prevEnv;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("PK3-L6 timer-exec systemctl 包装断言：不带 --user 抛，带 --user 正常执行", () => {
  // ① 不带 --user：systemctl 包装与 timerCmd 均抛
  assert.throws(
    () => systemctl(["daemon-reload"]),
    /systemctl 包装收到的 args 首项必须是 "--user"/,
    "直接调用 systemctl 不带 --user 必须抛",
  );
  assert.throws(
    () => systemctl(["enable", "--now", "foo.timer"]),
    /systemctl 包装收到的 args 首项必须是 "--user"/,
    "直接调用 systemctl enable 不带 --user 必须抛",
  );
  assert.throws(
    () => timerCmd(["systemctl", "daemon-reload"]),
    /systemctl 包装收到的 args 首项必须是 "--user"/,
    "timerCmd 计划命令不带 --user 必须抛",
  );

  // ② 带 --user：注入假二进制后正常执行
  const base = tmpBase("pk3-l6-outbound-sys-");
  const bin = path.join(base, "fake-systemctl.sh");
  const log = path.join(base, "calls.log");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`, { mode: 0o755 });

  const prevEnv = process.env.FEISHU_BRIDGE_SYSTEMCTL;
  process.env.FEISHU_BRIDGE_SYSTEMCTL = bin;
  try {
    const res1 = systemctl(["--user", "daemon-reload"]);
    assert.equal(res1.ok, true);

    const res2 = timerCmd(["systemctl", "--user", "enable", "--now", "foo.timer"]);
    assert.equal(res2.ok, true);

    const lines = fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "--user daemon-reload");
    assert.equal(lines[1], "--user enable --now foo.timer");
  } finally {
    if (prevEnv === undefined) delete process.env.FEISHU_BRIDGE_SYSTEMCTL;
    else process.env.FEISHU_BRIDGE_SYSTEMCTL = prevEnv;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
