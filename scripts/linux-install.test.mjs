/**
 * PK3-L1：Linux 首装的三块纯逻辑 —— 兜底定时器按平台、node 路径解析、lark-cli 的 DATA_DIR。
 *
 * 全部不碰磁盘 / 不跑 systemctl / 不发消息：平台、exists、env 一律注入。
 * 这里要钉的都是「换到另一台机器上不会静默装错」——错法都很安静：写一个永远不生效的 plist、
 * 把一个不存在的 node 写进 hooks、或者让 lark-cli 去找一个没有密钥的目录。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, installedNodeFrom, resolveNodeForHooks, timerKindFor } from "./drain-schedule.mjs";
import { claudeDrainPlistPath, claudeDrainSystemdPaths, claudeDrainSystemdUnits, drainTimerPlan } from "./install-projection.mjs";
import { runDoctor } from "./doctor.mjs";
import { larkCliEnv, larkProvisionedSecretPath } from "./chain-template.mjs";

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

test("resolveNodeForHooks：FEISHU_BRIDGE_NODE → PATH → /opt/homebrew → /usr/local → ~/.local/bin；都不用 execPath", () => {
  const home = "/home/dinosak";
  const shim = "/home/dinosak/.local/share/mise/shims/node";
  // ① 显式指定优先
  assert.equal(resolveNodeForHooks({ env: { FEISHU_BRIDGE_NODE: "/opt/x/node", PATH: "/usr/bin" },
    exists: existsOnly(["/opt/x/node", "/usr/bin/node"]), access: alwaysExec, homedir: home }), "/opt/x/node");
  // ② PATH 逐段（mise shim 就是这条：拿到 shim 比拿真身稳）
  assert.equal(resolveNodeForHooks({ env: { PATH: "/a:/b" }, exists: existsOnly(["/b/node"]), access: alwaysExec, homedir: home }), "/b/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "/usr/bin:" + path.dirname(shim) }, exists: existsOnly([shim]), access: alwaysExec, homedir: home }), shim);
  // ③/④/⑤ 三个兜底候选按序
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly(["/opt/homebrew/bin/node"]), access: alwaysExec, homedir: home }), "/opt/homebrew/bin/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly(["/usr/local/bin/node"]), access: alwaysExec, homedir: home }), "/usr/local/bin/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly([path.join(home, ".local", "bin", "node")]), access: alwaysExec, homedir: home }), path.join(home, ".local", "bin", "node"));
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
  return { ...process.env, HOME: home,
    FEISHU_BRIDGE_MAINTENANCE_GATE: path.join(home, "maintenance.gate"),
    FEISHU_BRIDGE_INSTALLED_SURFACE: "", FEISHU_BRIDGE_INSTALL_SURFACE_LOCK: "",
    FEISHU_BRIDGE_LAUNCHCTL: "", FEISHU_BRIDGE_SYSTEMCTL: "", FEISHU_BRIDGE_TIMER_PLATFORM: "",
    ...extra };
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
  const tail = calls.slice(calls.findIndex((l) => l.includes("disable --now")));
  assert.deepEqual(tail, [
    "--user disable --now feishu-bridge-cc-drain.timer | present",
    "--user daemon-reload | gone",
  ], "三步顺序（修前：daemon-reload 在删文件之前）：" + JSON.stringify(calls));
  // 执行用的是**argv**，不是计划里给人看的命令行（修前是 `systemctl systemctl --user …`，静默失败还报已卸载）。
  assert.equal(calls.some((l) => l.startsWith("systemctl systemctl")), false, JSON.stringify(calls));
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
  fs.writeFileSync(absent, "#!/bin/sh\nif [ \"$2\" = \"disable\" ]; then echo 'Failed to disable unit: Unit file feishu-bridge-cc-drain.timer does not exist.' >&2; exit 1; fi\nexit 0\n", { mode: 0o755 });
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
    if (args[0] === "is-enabled") return { ok: true, out: enabled + "\n" };
    if (args[0] === "is-active") {
      const out = activeOut ?? active;
      return out === "inactive" ? { ok: false, out: "inactive\n", err: "" } : { ok: true, out: out + "\n" };
    }
    if (args[0] === "show") return { ok: true, out: String(show) };
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
  assert.deepEqual(good.calls.find((a) => a[0] === "show"),
    ["show", "feishu-bridge-cc-drain.service", "-p", "ExecStart", "--value"], "问的就是 service 的 ExecStart");

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
  assert.equal(none.calls.some((a) => a[0] === "show"), false, "没装就别问 show：" + JSON.stringify(none.calls));
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
  const brokenFn = (args) => (args[0] === "is-active" ? { ok: false, out: "", err: "Failed to connect to bus: No such file or directory" } : broken.fn(args));
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
