/**
 * PK3-L1：Linux 首装的三块纯逻辑 —— 兜底定时器按平台、node 路径解析、lark-cli 的 DATA_DIR。
 *
 * 全部不碰磁盘 / 不跑 systemctl / 不发消息：平台、exists、env 一律注入。
 * 这里要钉的都是「换到另一台机器上不会静默装错」——错法都很安静：写一个永远不生效的 plist、
 * 把一个不存在的 node 写进 hooks、或者让 lark-cli 去找一个没有密钥的目录。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { resolveNodeForHooks, timerKindFor } from "./drain-schedule.mjs";
import { drainTimerPlan } from "./install-projection.mjs";
import { larkCliEnv, larkProvisionedSecretPath } from "./chain-template.mjs";

const existsOnly = (paths) => (p) => paths.includes(p);

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
    exists: existsOnly(["/opt/x/node", "/usr/bin/node"]), homedir: home }), "/opt/x/node");
  // ② PATH 逐段（mise shim 就是这条：拿到 shim 比拿真身稳）
  assert.equal(resolveNodeForHooks({ env: { PATH: "/a:/b" }, exists: existsOnly(["/b/node"]), homedir: home }), "/b/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "/usr/bin:" + path.dirname(shim) }, exists: existsOnly([shim]), homedir: home }), shim);
  // ③/④/⑤ 三个兜底候选按序
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly(["/opt/homebrew/bin/node"]), homedir: home }), "/opt/homebrew/bin/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly(["/usr/local/bin/node"]), homedir: home }), "/usr/local/bin/node");
  assert.equal(resolveNodeForHooks({ env: { PATH: "" }, exists: existsOnly([path.join(home, ".local", "bin", "node")]), homedir: home }), path.join(home, ".local", "bin", "node"));
  // 显式指定但不存在 → 抛（不静默换成别的）
  assert.throws(() => resolveNodeForHooks({ env: { FEISHU_BRIDGE_NODE: "/nope/node" }, exists: existsOnly([]), homedir: home }), /FEISHU_BRIDGE_NODE 指的路径不存在/);
  // 都没有 → 抛并把找过的列出来；**绝不退回 process.execPath**（钩子契约：Claude Code 自带的 node 不许当外部路径）
  let err = null;
  try { resolveNodeForHooks({ env: { PATH: "/a:/b" }, exists: existsOnly([]), homedir: home }); } catch (e) { err = e; }
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
