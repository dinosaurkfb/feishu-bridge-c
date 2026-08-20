#!/usr/bin/env node
/**
 * 把出站装成机制：Stop 钩子 + 项目登记表 + 全局技能 + launchd 兜底定时器。
 *
 * 出站原来只是本项目 CLAUDE.md 里手写的一段约定 —— 只有读到那段文字的会话才守。
 * 这四样各管一段：技能让任何会话都知道该怎么记，钩子让任何会话结束时都会发，
 * 登记表决定这两件事对哪些项目生效，launchd 定时器兜住所有发失败的情况。
 *
 * 为什么要专门写个安装器而不是手改 JSON：那份 settings 里已经有 .orca 的一整套钩子
 * （Stop / UserPromptSubmit / PostToolUse …）。手改一次覆盖掉，Frank 的另一套工具就哑了，
 * 而且哑得很安静。安装器只往 Stop 数组里追加自己那一条，认脚本路径做幂等，
 * 改之前先落一份带时间戳的备份。
 *
 * 用法：
 *   node scripts/install-outbound.mjs            # 看看会改什么，不落盘
 *   node scripts/install-outbound.mjs --apply
 *   node scripts/install-outbound.mjs --uninstall --apply
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const REGISTRY = path.join(os.homedir(), ".claude", "feishu-bridge", "registry.json");

const HOOK_SCRIPT = path.join(ROOT, "scripts", "stop-hook.mjs");
const INIT_HOOK_SCRIPT = path.join(ROOT, "scripts", "init-hook.mjs");
const PREVIEW_SCRIPT = path.join(ROOT, "scripts", "bind-preview.mjs");
const LOG = path.join(os.homedir(), ".claude", "feishu-bridge", "stop-hook.log");

/**
 * 钩子的环境不保证继承交互 shell 的 PATH，所以 node 要写绝对路径。
 *
 * 但**不能**写 process.execPath —— 它是 realpath 过的，在这台机器上是
 * /opt/homebrew/Cellar/node/26.0.0/bin/node，带版本号。brew 升一次 node 这个路径就没了，
 * 而钩子的失败又是安静的，出站会无声停摆。优先取 brew 那个不带版本的稳定软链。
 */
function pickNode() {
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  return process.execPath;
}

const NODE_BIN = pickNode();

// 外层 if 是为了「node 或脚本不在了」时不把钩子报错弹到本机每一次会话结束上。
// 但也绝不能真的静默：else 分支往出站日志里留一行，否则出站停摆将无从发现。
const COMMAND =
  `if [ -x '${NODE_BIN}' ] && [ -r '${HOOK_SCRIPT}' ]; then '${NODE_BIN}' '${HOOK_SCRIPT}'; ` +
  `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; ` +
  `printf '%s hook-unavailable node=${NODE_BIN}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> '${LOG}' 2>/dev/null || :; fi`;

const MARKER = HOOK_SCRIPT; // 认脚本路径做幂等，命令别处怎么变都不会装两遍

// /init 钩子跑在本机**每一次提交 prompt** 上，比 Stop 更热。
// 跟 Stop 那条的区别：这里的 else 分支不往日志里写。UserPromptSubmit 的 stdout 会被
// 当成上下文注入，每敲一句话就往日志追一行也没有意义 —— 缺 node 时它该彻底闭嘴。
const INIT_COMMAND =
  `if [ -x '${NODE_BIN}' ] && [ -r '${INIT_HOOK_SCRIPT}' ]; then '${NODE_BIN}' '${INIT_HOOK_SCRIPT}'; ` +
  `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`;
const INIT_MARKER = INIT_HOOK_SCRIPT;

const apply = process.argv.includes("--apply");
const uninstall = process.argv.includes("--uninstall");

// ---------- settings.json ----------

const settingsBefore = fs.readFileSync(SETTINGS, "utf-8");
const settings = JSON.parse(settingsBefore);
settings.hooks ??= {};
const stop = (settings.hooks.Stop ??= []);

const alreadyAt = stop.findIndex((entry) =>
  (entry?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.includes(MARKER)));

let action;
if (uninstall) {
  if (alreadyAt < 0) action = "already-absent";
  else {
    stop.splice(alreadyAt, 1);
    action = "removed";
  }
} else if (alreadyAt >= 0) {
  // 已装过也要覆盖命令：脚本路径没变但 node 路径或包裹逻辑可能变了。
  stop[alreadyAt] = { hooks: [{ type: "command", command: COMMAND, timeout: 20 }] };
  action = "updated";
} else {
  stop.push({ hooks: [{ type: "command", command: COMMAND, timeout: 20 }] });
  action = "installed";
}

// ---------- UserPromptSubmit：/init 时问一句要不要接飞书 ----------
//
// 跟 Stop 用同一套做法：只认脚本路径做幂等、只动自己那一条、绝不重排别人的。
// .orca 的 UserPromptSubmit 钩子就在这个数组里，覆盖掉它 Frank 的另一套工具会静默失灵。

const prompts = (settings.hooks.UserPromptSubmit ??= []);
const initAt = prompts.findIndex((entry) =>
  (entry?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.includes(INIT_MARKER)));

let initAction;
if (uninstall) {
  if (initAt < 0) initAction = "already-absent";
  else { prompts.splice(initAt, 1); initAction = "removed"; }
} else if (initAt >= 0) {
  prompts[initAt] = { hooks: [{ type: "command", command: INIT_COMMAND, timeout: 10 }] };
  initAction = "updated";
} else {
  prompts.push({ hooks: [{ type: "command", command: INIT_COMMAND, timeout: 10 }] });
  initAction = "installed";
}

// ---------- 权限：只放行预览，真发仍逐次确认 ----------
//
// /init 之后那句「要不要建话题」必须附一份**脚本自己打印的**文案。拿不到它，模型会去读
// 源码「还原」一份 —— 那东西看着像预览，其实是算出来的，差一个字就是照着假预览点头，
// 而根消息发出去改不了。（2026-08-20 实测：dry-run 被 auto 模式分类器拦下，
// cc2cd 那个会话就是这么还原的。）
//
// 放行的是 bind-preview.mjs，**不是** bind-project.mjs：前者的依赖图里没有 outbound，
// 它做不到发消息这件事是代码事实，不是一个自觉遵守的 --dry-run 开关（有测试盯着）。
// 真正建话题的那条仍然每次弹权限 —— 往群里发一条撤不掉的消息，本来就该有人点头。

const PREVIEW_RULE = "Bash(node " + PREVIEW_SCRIPT + ":*)";
const permissions = (settings.permissions ??= {});
const allow = (permissions.allow ??= []);

let permAction;
const permAt = allow.indexOf(PREVIEW_RULE);
if (uninstall) {
  if (permAt < 0) permAction = "already-absent";
  else { allow.splice(permAt, 1); permAction = "removed"; }
} else if (permAt >= 0) {
  permAction = "already-present";
} else {
  allow.push(PREVIEW_RULE);
  permAction = "installed";
}

// ---------- 登记表 ----------

let registry = { schema_version: "1.0", projects: [] };
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
  registry.projects ??= [];
} catch {
  /* 首次安装：用上面的空表 */
}

const selfEntry = {
  id: path.basename(ROOT),
  root: ROOT,
  note: "长期任务把关键进展写进 .runtime-data/outbound/outbox，会话结束时由出站钩子排空",
};
const selfAt = registry.projects.findIndex((p) => p?.root === ROOT);
if (uninstall) {
  if (selfAt >= 0) registry.projects.splice(selfAt, 1);
} else if (selfAt >= 0) {
  registry.projects[selfAt] = { ...registry.projects[selfAt], ...selfEntry };
} else {
  registry.projects.push(selfEntry);
}

// ---------- 全局技能 ----------

// 技能是出站的另一半：钩子保证「发」，技能保证「记」。
// 装到用户级技能目录，任何目录起的会话都看得见 —— 这正是与入站技能对称的地方。
const SKILL_SRC = path.join(ROOT, "skills", "claude-longtask-progress", "SKILL.md");
const SKILL_DST = path.join(os.homedir(), ".claude", "skills", "claude-longtask-progress", "SKILL.md");

// 拷贝而不是软链：软链一旦仓库被移动或删除就变成悬空文件，而且各家扫描器
// 对 readdir 是否跟随软链的处理并不一致（入站技能就在这上面栽过）。
let skillAction = "unchanged";
const skillReadable = fs.existsSync(SKILL_SRC);
if (uninstall) {
  if (fs.existsSync(SKILL_DST)) skillAction = "will-remove";
} else if (!skillReadable) {
  skillAction = "source-missing";
} else {
  const src = fs.readFileSync(SKILL_SRC, "utf-8");
  let dst = null;
  try { dst = fs.readFileSync(SKILL_DST, "utf-8"); } catch { /* 还没装 */ }
  if (dst !== src) skillAction = dst === null ? "will-install" : "will-update";
}

// ---------- launchd 兜底定时器 ----------

/**
 * 这一段原来是缺的，而且缺得很难发现：drain-outbox / stop-hook / watch-and-publish
 * 三处失败分支的注释都写着「留在 outbox，兜底定时器会重试」，但安装器从不创建那个定时器。
 * 这台机器上它存在，是更早某次手工装的 —— 换台机器就只有事件驱动那条路，
 * 一次发布失败等于进展永久卡在本地，而注释还在向读代码的人承诺有人会重试。
 *
 * 注释承诺了什么，安装器就得装出什么。
 */
const LAUNCH_LABEL = "com.frank.feishu-bridge-cc.drain";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", LAUNCH_LABEL + ".plist");
const DRAIN_LOG = path.join(os.homedir(), ".claude", "feishu-bridge", "drain.log");
const DRAIN_SCRIPT = path.join(ROOT, "scripts", "drain-outbox.mjs");

// --all：兜底要覆盖登记表里所有项目。只排本仓库的话，后接进来的项目就没有兜底了。
const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DRAIN_SCRIPT}</string>
    <string>--all</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${DRAIN_LOG}</string>
  <key>StandardErrorPath</key><string>${DRAIN_LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
</dict>
</plist>
`;

let plistAction = "unchanged";
if (uninstall) {
  if (fs.existsSync(PLIST)) plistAction = "will-remove";
} else {
  let current = null;
  try { current = fs.readFileSync(PLIST, "utf-8"); } catch { /* 还没装 */ }
  if (current !== plistBody) plistAction = current === null ? "will-install" : "will-update";
}

// ---------- 落盘 ----------

console.log("settings : " + SETTINGS + "  → " + action);
console.log("Stop 钩子 : " + stop.length + " 条（.orca 的那条必须还在）  → " + action);
console.log("/init 钩子: " + prompts.length + " 条 UserPromptSubmit（.orca 的那条必须还在）  → " + initAction);
console.log("预览放行 : allow " + allow.length + " 条  → " + permAction);
console.log("登记表   : " + REGISTRY + "  → " + registry.projects.length + " 个项目");
console.log("技能     : " + SKILL_DST + "  → " + skillAction);
console.log("兜底定时 : " + PLIST + "  → " + plistAction + "（每 30 分钟排空全部登记项目）");

if (skillAction === "source-missing") {
  console.error("\n技能源文件不在：" + SKILL_SRC);
  process.exit(1);
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才真的落盘。");
  process.exit(0);
}

const writeJsonAtomic = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
};

// 内容没变就别动这个文件。反复重写只会攒出一堆备份，还平白给一份别人也在用的
// 全局配置增加被写坏的机会。
const settingsAfter = JSON.stringify(settings, null, 2) + "\n";
let backup = null;
if (settingsAfter !== settingsBefore) {
  backup = SETTINGS + ".bak." + new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(SETTINGS, backup);
  writeJsonAtomic(SETTINGS, settings);
}

writeJsonAtomic(REGISTRY, registry);

if (uninstall) {
  fs.rmSync(path.dirname(SKILL_DST), { recursive: true, force: true });
} else {
  fs.mkdirSync(path.dirname(SKILL_DST), { recursive: true });
  fs.copyFileSync(SKILL_SRC, SKILL_DST);
}

// launchd：先 bootout 再 bootstrap。改了 plist 不重新加载的话，跑的还是旧的那份，
// 而且看不出来 —— 文件是新的，行为是旧的，是最难查的那种不一致。
const launchctl = (args, { tolerate = false } = {}) => {
  try {
    execFileSync("/bin/launchctl", args, { stdio: "pipe", timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    if (!tolerate) console.error("  launchctl " + args.join(" ") + " 失败：" + String(err.message).split("\n")[0]);
    return { ok: false };
  }
};

const domain = "gui/" + process.getuid();
let launchNote;
if (uninstall) {
  launchctl(["bootout", domain + "/" + LAUNCH_LABEL], { tolerate: true });
  fs.rmSync(PLIST, { force: true });
  launchNote = "已卸载";
} else {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plistBody);
  launchctl(["bootout", domain + "/" + LAUNCH_LABEL], { tolerate: true }); // 没装过时必然失败，正常
  launchNote = launchctl(["bootstrap", domain, PLIST]).ok
    ? "已加载"
    : "**plist 已写入但 launchctl 加载失败 —— 兜底重试目前不生效**";
}

console.log("\n" + (backup ? "settings 已改，备份：" + backup : "settings 无改动，未重写"));
console.log("兜底定时器：" + launchNote);
console.log("钩子和技能都立即生效，不需要重启会话。");
