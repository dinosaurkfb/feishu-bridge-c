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

import {
  applyRuntimeSync, planRuntimeSync, runtimeScript, verifyRuntime,
} from "./runtime-install.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * **全局配置里只出现 runtime 路径，绝不出现开发克隆路径。**
 *
 * 钩子过去指向安装它的那个克隆，带来两个已经真实发生的后果：本机装了两份 Stop 与两份
 * UserPromptSubmit 钩子（两个克隆、两条不同路径，见下面 hookEntries 的说明）；以及钩子跑的是
 * 工作树当前 checkout 的代码，开发时切一次分支线上行为就跟着变。
 *
 * 现在代码复制到 ~/.claude/feishu-bridge/runtime/versions/<version>/，全局配置只认
 * runtime/current 这个符号链接。切分支、删克隆都不再影响线上。
 */
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const REGISTRY = path.join(os.homedir(), ".claude", "feishu-bridge", "registry.json");

const HOOK_SCRIPT = runtimeScript("stop-hook.mjs");
const INIT_HOOK_SCRIPT = runtimeScript("init-hook.mjs");
const PREVIEW_SCRIPT = runtimeScript("bind-preview.mjs");
/** 技能与 launchd 引用的「桥根目录」，同样是 runtime 而不是开发克隆。 */
const RUNTIME_BRIDGE_ROOT = path.dirname(path.dirname(HOOK_SCRIPT));
const INBOUND_HOOK_SCRIPT = runtimeScript("inbound-hook.mjs");
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

/** 埋进命令里的显式归属标记：与脚本路径无关，换克隆、换 runtime 都认得出自己那条。 */
const HOOK_TAG = "FEISHU_BRIDGE_HOOK:";

// 外层 if 是为了「node 或脚本不在了」时不把钩子报错弹到本机每一次会话结束上。
// 但也绝不能真的静默：else 分支往出站日志里留一行，否则出站停摆将无从发现。
const COMMAND =
  `if [ -x '${NODE_BIN}' ] && [ -r '${HOOK_SCRIPT}' ]; then '${NODE_BIN}' '${HOOK_SCRIPT}'; ` +
  `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; ` +
  `printf '%s hook-unavailable node=${NODE_BIN}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> '${LOG}' 2>/dev/null || :; fi` +
  ` # ${HOOK_TAG}stop-hook.mjs`;

// /init 钩子跑在本机**每一次提交 prompt** 上，比 Stop 更热。
// 跟 Stop 那条的区别：这里的 else 分支不往日志里写。UserPromptSubmit 的 stdout 会被
// 当成上下文注入，每敲一句话就往日志追一行也没有意义 —— 缺 node 时它该彻底闭嘴。
const INIT_COMMAND =
  `if [ -x '${NODE_BIN}' ] && [ -r '${INIT_HOOK_SCRIPT}' ]; then '${NODE_BIN}' '${INIT_HOOK_SCRIPT}'; ` +
  `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi` +
  ` # ${HOOK_TAG}init-hook.mjs`;

// 入站钩子：让「任何 Aily 回合先进入运输层」成为硬约束，而不是靠模型记得调技能。
// 跟 /init 钩子同一个事件（UserPromptSubmit），但判据完全不同、互不干扰：
// 那个认 prompt 是不是 /init，这个认环境里有没有 daemon 注入的 AILY_CLI_*。
const INBOUND_HOOK_COMMAND =
  `if [ -x '${NODE_BIN}' ] && [ -r '${INBOUND_HOOK_SCRIPT}' ]; then '${NODE_BIN}' '${INBOUND_HOOK_SCRIPT}'; ` +
  `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi` +
  ` # ${HOOK_TAG}inbound-hook.mjs`;

/**
 * 钩子归属判定。这里有两条必须同时满足的约束，缺一条都会出事：
 *
 *   宽了会误删。settings 是共享的，`.orca` 的整套钩子就在同一个数组里；而且**一条 entry
 *   里可以有多个 hook**，其中只有一条是我们的。按 entry 整条删，会把同一条里别人的钩子
 *   一起删掉，而且删得很安静。
 *   窄了收敛不掉。旧写法用克隆绝对路径当键（`MARKER = HOOK_SCRIPT`），第二个克隆路径不同
 *   就变成追加而非覆盖 —— 本机两份 Stop 钩子、两份 UserPromptSubmit 钩子就是这么来的。
 *
 * 所以：新装的命令里埋一个**与路径无关的显式标记**，认它；同时对历史遗留的命令按
 * 安装器**当初生成的确切形态**严格解析（不是子串包含），只为迁移那一次。
 */
/**
 * 历史遗留命令的严格识别。
 *
 * 只锚定开头 + 出现过某个脚本名是不够的：别的工具用同样的 guard 写法、同样的文件名，
 * 一样会被我们认领然后删掉。所以这里把安装器**当初生成的完整模板**拆开验：
 * guard 检查的 node 与脚本，必须和实际执行的 node 与脚本逐字相同；尾部也必须是
 * 当初那两种形态之一。任何一处对不上就不是我们的，不碰。
 */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const LEGACY_BODY =
  /^if \[ -x '([^']+)' \] && \[ -r '([^']+)' \]; then '([^']+)' '([^']+)'; else \{ command -p cat 2>\/dev\/null \|\| cat; \} >\/dev\/null 2>&1(.*)$/u;

const legacyOwns = (command, basename) => {
  const m = LEGACY_BODY.exec(command);
  if (!m) return false;
  const [, guardNode, guardScript, runNode, runScript, tail] = m;
  // guard 与实际执行必须是同一个 node、同一个脚本 —— 这是安装器生成物的固有性质，
  // 手写或别的工具生成的命令极少恰好满足。
  if (guardNode !== runNode || guardScript !== runScript) return false;
  if (!guardScript.endsWith("/scripts/" + basename)) return false;
  if (basename === "stop-hook.mjs") {
    return new RegExp("^; printf '%s hook-unavailable node=" + escapeRe(guardNode) +
      "\\\\n' \"\\$\\(date -u \\+%Y-%m-%dT%H:%M:%SZ\\)\" >> '[^']*' 2>\\/dev\\/null \\|\\| :; fi$", "u")
      .test(tail);
  }
  return /^ \|\| :; fi$/u.test(tail);
};

const ownsHook = (hook, basename) => {
  const command = hook?.command;
  if (typeof command !== "string") return false;
  // 新装认**固定的尾部注释**，不是任意位置的 includes —— 后者会把一条只是提到这个
  // 字符串的命令（比如别人写的清理脚本）也认成自己的。
  if (command.endsWith(" # " + HOOK_TAG + basename)) return true;
  return legacyOwns(command, basename);
};

const countHooks = (list, basename) => (list ?? [])
  .reduce((n, entry) => n + (entry?.hooks ?? []).filter((h) => ownsHook(h, basename)).length, 0);

/**
 * 收编：摘掉**所有**属于自己的 hook，再放回恰好一条。
 *
 * 两个细节都来自实际教训：
 *   摘"所有"而不是第一条 —— 只处理首个匹配项正是重复条目长期存活的原因，
 *   安装器每次都只看见自己那条，另一条永远没人管。
 *   摘的是 **hook** 而不是 entry —— 同一条 entry 里可能还有别人的钩子，
 *   只有整条都属于我们时才删掉这条 entry。
 */
const claimSingleHook = (list, basename, entry) => {
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const hooks = list[i]?.hooks;
    if (!Array.isArray(hooks)) continue;
    const kept = hooks.filter((h) => !ownsHook(h, basename));
    if (kept.length === hooks.length) continue;
    removed += hooks.length - kept.length;
    if (kept.length === 0) list.splice(i, 1);
    else list[i].hooks = kept;
  }
  if (entry) list.push(entry);
  return removed;
};

const apply = process.argv.includes("--apply");
const uninstall = process.argv.includes("--uninstall");

// ---------- 运行时代码：先落到固定位置，全局配置才有东西可指 ----------
//
// 顺序很重要：**先同步代码，再改 settings**。反过来的话，中间那一刻钩子已经指向
// runtime，而 runtime 里还没有脚本 —— 钩子命令的 `[ -r … ]` 守卫会让它静默跳过，
// 于是那段时间里结束的会话不会有任何出站，也不会有任何报错。
const runtimePlan = uninstall ? null : planRuntimeSync({ sourceRoot: ROOT });
if (runtimePlan && !runtimePlan.ok) {
  console.error("运行时代码无法准备（" + runtimePlan.reason +
    (runtimePlan.file ? "：" + runtimePlan.file : "") + "）。什么都没做。");
  process.exit(1);
}

// ---------- settings.json ----------

const settingsBefore = fs.readFileSync(SETTINGS, "utf-8");
const settings = JSON.parse(settingsBefore);
settings.hooks ??= {};
const stop = (settings.hooks.Stop ??= []);

const stopBefore = countHooks(stop, "stop-hook.mjs");
const stopRemoved = claimSingleHook(stop, "stop-hook.mjs",
  uninstall ? null : { hooks: [{ type: "command", command: COMMAND, timeout: 20 }] });
const action = uninstall
  ? (stopRemoved > 0 ? "removed" : "already-absent")
  : (stopBefore === 0 ? "installed" : stopBefore === 1 ? "updated" : "deduped");

// ---------- UserPromptSubmit：/init 时问一句要不要接飞书 ----------
//
// 跟 Stop 用同一套做法：只认脚本路径做幂等、只动自己那一条、绝不重排别人的。
// .orca 的 UserPromptSubmit 钩子就在这个数组里，覆盖掉它 Frank 的另一套工具会静默失灵。

const prompts = (settings.hooks.UserPromptSubmit ??= []);
// 两个 UserPromptSubmit 钩子各自按脚本名幂等，互不覆盖。
const describe = (before, removed) => uninstall
  ? (removed > 0 ? "removed" : "already-absent")
  : (before === 0 ? "installed" : before === 1 ? "updated" : "deduped");

const inboundBefore = countHooks(prompts, "inbound-hook.mjs");
const inboundHookAction = describe(inboundBefore, claimSingleHook(prompts, "inbound-hook.mjs",
  uninstall ? null : { hooks: [{ type: "command", command: INBOUND_HOOK_COMMAND, timeout: 10 }] }));

const initBefore = countHooks(prompts, "init-hook.mjs");
const initAction = describe(initBefore, claimSingleHook(prompts, "init-hook.mjs",
  uninstall ? null : { hooks: [{ type: "command", command: INIT_COMMAND, timeout: 10 }] }));

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

// 权限规则同样要收编：旧克隆各留了一条自己路径的放行规则，只加不减就会越积越多，
// 而每一条都是一个「某个开发克隆里的脚本可以免确认执行」的长期授权。
// 同样按安装器生成的确切形态匹配，不用子串包含 —— 一条 allow 规则是一次长期免确认授权，
// 误删别人的、或漏掉旧克隆的，两种都不能接受。
const PREVIEW_RULE_SHAPE = /^Bash\(node [^\s()]*\/scripts\/bind-preview\.mjs:\*\)$/u;
const ownsPreview = (rule) => typeof rule === "string" && PREVIEW_RULE_SHAPE.test(rule);
const permBefore = allow.filter(ownsPreview).length;
for (let i = allow.length - 1; i >= 0; i -= 1) if (ownsPreview(allow[i])) allow.splice(i, 1);
if (!uninstall) allow.push(PREVIEW_RULE);
const permAction = uninstall
  ? (permBefore > 0 ? "removed" : "already-absent")
  : (permBefore === 0 ? "installed" : permBefore === 1 ? "already-present" : "deduped");

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
/**
 * 装哪些技能，以及装成什么名字。
 *
 * 五条控制命令在仓库里叫 claude-feishu-*，装出去要去掉前缀 —— 因为**装出去的目录名
 * 就是斜杠命令名**，而 Codex 那边用的是 $feishu-bind / $feishu-status / $feishu-unbind。
 * 两边同名，用户不用记两套。仓库里之所以要加前缀，是因为 skills/feishu-bind/
 * 已经被 Codex 那份占了 —— 它们装到不同的家目录（~/.codex vs ~/.claude），
 * 运行时不冲突，只有仓库目录会撞。
 */
const SKILLS = [
  { src: "claude-longtask-progress", dst: "claude-longtask-progress" },
  { src: "claude-feishu-bind",       dst: "feishu-bind" },
  { src: "claude-feishu-status",     dst: "feishu-status" },
  { src: "claude-feishu-unbind",     dst: "feishu-unbind" },
  { src: "claude-feishu-rotate",     dst: "feishu-rotate" },
  { src: "claude-feishu-mode",       dst: "feishu-mode" },
];

const skillSrcOf = (n) => path.join(ROOT, "skills", n, "SKILL.md");
const skillDstOf = (n) => path.join(os.homedir(), ".claude", "skills", n, "SKILL.md");
// 技能里给模型看的命令也要指 runtime。否则 Frank 跑 /feishu-bind 时执行的是某个开发克隆的
// 脚本 —— 那个克隆此刻停在哪条分支上没人知道，而这条命令会往群里发一条撤不掉的消息。
const renderSkill = (src) => src.replaceAll("{{BRIDGE_ROOT}}", RUNTIME_BRIDGE_ROOT);

// 拷贝而不是软链：软链一旦仓库被移动或删除就变成悬空文件，而且各家扫描器
// 对 readdir 是否跟随软链的处理并不一致（入站技能就在这上面栽过）。
const skillPlan = SKILLS.map((sk) => {
  const srcFile = skillSrcOf(sk.src);
  const dstFile = skillDstOf(sk.dst);
  if (uninstall) {
    return { ...sk, srcFile, dstFile, action: fs.existsSync(dstFile) ? "will-remove" : "already-absent" };
  }
  if (!fs.existsSync(srcFile)) return { ...sk, srcFile, dstFile, action: "source-missing" };
  const src = renderSkill(fs.readFileSync(srcFile, "utf-8"));
  let dst = null;
  try { dst = fs.readFileSync(dstFile, "utf-8"); } catch { /* 还没装 */ }
  return { ...sk, srcFile, dstFile,
    action: dst === src ? "unchanged" : dst === null ? "will-install" : "will-update" };
});

const skillAction = skillPlan.some((s) => s.action === "source-missing") ? "source-missing"
  : skillPlan.every((s) => s.action === "unchanged") ? "unchanged"
  : skillPlan.map((s) => s.dst + ":" + s.action).filter((t) => !t.endsWith(":unchanged")).join(" ");

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
const DRAIN_SCRIPT = runtimeScript("drain-outbox.mjs");

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
  <key>WorkingDirectory</key><string>${RUNTIME_BRIDGE_ROOT}</string>
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

if (runtimePlan) {
  console.log("运行时   : " + runtimePlan.runtimeRoot + "  → 版本 " + runtimePlan.version +
    (runtimePlan.alreadyCurrent ? "（与线上相同，无需切换）"
      : runtimePlan.previousVersion ? "（将从 " + runtimePlan.previousVersion + " 切换）"
        : "（首次安装）"));
  console.log("           " + runtimePlan.files.length + " 个脚本，来源 " +
    (runtimePlan.sourceCommit ? runtimePlan.sourceCommit.slice(0, 12) : "非 git 仓库") +
    " @ " + runtimePlan.sourceRoot);
}
console.log("settings : " + SETTINGS + "  → " + action);
console.log("Stop 钩子 : " + stop.length + " 条（.orca 的那条必须还在）  → " + action);
console.log("/init 钩子: " + initAction + "        （UserPromptSubmit 共 " + prompts.length + " 条）");
console.log("入站钩子 : " + inboundHookAction + "        （Aily 回合强制进运输层）");
console.log("预览放行 : allow " + allow.length + " 条  → " + permAction);
console.log("登记表   : " + REGISTRY + "  → " + registry.projects.length + " 个项目");
console.log("技能     : " + SKILLS.length + " 个（装进 ~/.claude/skills/）  → " + skillAction);
for (const sk of skillPlan) console.log("           /" + sk.dst.padEnd(26) + sk.action);
console.log("兜底定时 : " + PLIST + "  → " + plistAction + "（每 30 分钟排空全部登记项目）");

if (skillAction === "source-missing") {
  for (const sk of skillPlan.filter((x) => x.action === "source-missing")) {
    console.error("\n技能源文件不在：" + sk.srcFile);
  }
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

// 先把运行时代码落地，再动 settings。见上面 runtimePlan 处对顺序的说明。
if (runtimePlan) {
  const synced = applyRuntimeSync(runtimePlan);
  if (!synced.ok) {
    console.error("运行时代码落盘失败（" + synced.reason + "）：" +
      (synced.error ?? synced.file ?? "") + "\nsettings 未改动。");
    process.exit(1);
  }
  const checked = verifyRuntime();
  if (!checked.ok) {
    console.error("运行时校验未通过（链接 " + (checked.linkOk ? "ok" : "错") +
      "，缺失 " + checked.missing.length + "，漂移 " + checked.drifted.length +
      "）。settings 未改动。");
    process.exit(1);
  }
  console.log("运行时   : 已装 " + checked.version + " 并校验通过");
}

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

for (const sk of skillPlan) {
  if (uninstall) {
    fs.rmSync(path.dirname(sk.dstFile), { recursive: true, force: true });
  } else {
    fs.mkdirSync(path.dirname(sk.dstFile), { recursive: true });
    fs.writeFileSync(sk.dstFile, renderSkill(fs.readFileSync(sk.srcFile, "utf-8")), { mode: 0o600 });
  }
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
