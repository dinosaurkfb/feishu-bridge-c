#!/usr/bin/env node
/**
 * 把出站装成机制：Stop 钩子 + 项目登记表 + 全局技能 + 兜底定时器。
 * 兜底定时器按平台（PK3-L1）：darwin launchd / linux systemd --user / 其它平台明说没有实现、不假装装好。
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

import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, pickClaudeNode } from "./drain-schedule.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moduleRoot } from "./direct-run.mjs";

import {
  applyRuntimeSync, planRuntimeSync, runtimeScript, verifyRuntime,
} from "./runtime-install.mjs";
import { CLAUDE_DRAIN_SYSTEMD_UNIT, CLAUDE_SKILLS, claudeDrainPlist, claudeDrainPlistPath, drainTimerPlan, referencedRuntimeScripts, renderClaudeSettings, renderClaudeSkill } from "./install-projection.mjs";
import { artifactSha, installedSurfacePath, receiptReport, recordInstalledSurface } from "./installed-surface.mjs";
import { gateBlocks } from "./maintenance-gate-core.mjs";
import { holdInstallSurfaceLockOrExit } from "./install-surface-lock.mjs";

const ROOT = moduleRoot(import.meta.url, "..");

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

/** 技能与 launchd 引用的「桥根目录」，同样是 runtime 而不是开发克隆。 */
const RUNTIME_BRIDGE_ROOT = path.dirname(path.dirname(runtimeScript("stop-hook.mjs")));
// node 的选择只有一份（drain-schedule.mjs）—— 定时器 plist 与 doctor 的期望 job 同源。
const NODE_BIN = pickClaudeNode();
// hook 命令模板、归属判定、settings 合并、plist、技能渲染都在 install-projection.mjs（维护门要在不写的情况下问"会写成什么"）。

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

// ---------- settings.json（投影在 install-projection.mjs：只动自己的 hook 与预览放行规则）----------

const settingsBefore = fs.readFileSync(SETTINGS, "utf-8");
const rendered = renderClaudeSettings({ baseText: settingsBefore, home: os.homedir(), node: NODE_BIN, uninstall });
const settings = rendered.settings;
const stop = settings.hooks.Stop;
const prompts = settings.hooks.UserPromptSubmit;
const allow = settings.permissions.allow;
const action = rendered.actions.stop;
const inboundHookAction = rendered.actions.inbound;
const initAction = rendered.actions.init;
const permAction = rendered.actions.perm;

// ---------- 登记表 ----------

let registry = { schema_version: "1.0", projects: [] };
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
  registry.projects ??= [];
} catch {
  /* 首次安装：用上面的空表 */
}

/**
 * **安装只保证登记表存在，不登记任何项目。**
 *
 * 安装是「装基础设施」，项目登记是「订阅」—— 两件事混在一起有三个后果，都真实存在过：
 *
 *   一、从哪个目录跑一次安装，那个目录就被当成一个已接入项目。本机登记表里现在就有
 *       两条这样的产物（只有 id/root/note，没有任何绑定字段），来自两个**开发克隆**。
 *   二、`--uninstall` 会把那条删掉。可它删的是一条**绑定**，而绑定牵着话题历史 ——
 *       卸载基础设施不该让历史变成孤儿。
 *   三、迁到 runtime 之后这个耦合更别扭：代码已经不在开发克隆里跑了，
 *       却还在把开发克隆写进登记表。
 *
 * 项目登记从此只来自显式绑定（bind-project / bind-session）—— 那也是控制面本来的规矩：
 * 配置变更必须来自显式控制动作。
 *
 * 已有的登记条目一律不动，包括那两条历史产物：清理它们是改运行状态，
 * 要由人显式决定，不能由一次安装顺手做掉。
 */
const selfAt = registry.projects.findIndex((p) => p?.root === ROOT);
const selfRegistered = selfAt >= 0;
const selfBound = selfRegistered && Boolean(registry.projects[selfAt]?.root_message_id);

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
const SKILLS = CLAUDE_SKILLS;
const skillSrcOf = (n) => path.join(ROOT, "skills", n, "SKILL.md");
const skillDstOf = (n) => path.join(os.homedir(), ".claude", "skills", n, "SKILL.md");
// 渲染只有一份（install-projection.mjs）：`{{SCRIPT:x.mjs}}` → 加了 shell 引号的 runtime 路径。
const renderSkill = (src) => renderClaudeSkill(src, { home: os.homedir() });

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
// label 只有一份定义（drain-schedule.mjs）—— doctor 查 launchd 用的是同一个。
const LAUNCH_LABEL = CLAUDE_DRAIN_LAUNCH_LABEL;
const PLIST = claudeDrainPlistPath(os.homedir());
// plist 正文只有一份（install-projection.mjs），与 doctor 核 launchd 的 expectedJob 同源。
const plistBody = claudeDrainPlist({ home: os.homedir(), node: NODE_BIN });

// PK3-L1：兜底定时器按平台 —— darwin launchd / linux systemd --user / 其它明说没实现。
// 计划是**纯函数**（install-projection.drainTimerPlan），安装器照它执行、测试照它断言。
const TIMER_PLAN = drainTimerPlan({ home: os.homedir(), node: NODE_BIN, uninstall });
const TIMER_FILES = TIMER_PLAN.files;
const TIMER_REMOVE = TIMER_PLAN.remove ?? [];

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
console.log("登记表   : " + REGISTRY + "  → " + registry.projects.length +
  " 个项目（安装只保证文件存在，不登记项目）");
// 提示而不是动作：安装器不再替人做订阅决定，但也不该让人以为「装完就接上了」。
if (!uninstall && !selfBound) {
  console.log("           本目录" + (selfRegistered ? "在表内但未绑定话题" : "未登记") +
    "；要接入请显式运行 /feishu-bind");
}
console.log("技能     : " + SKILLS.length + " 个（装进 ~/.claude/skills/）  → " + skillAction);
for (const sk of skillPlan) console.log("           /" + sk.dst.padEnd(26) + sk.action);
// PK3-L1-fix1 P1-2：预览与**实际写入**同一份计划 —— linux 上这里必须打印两份 unit 与 systemctl 命令，
// 不许再出现 ~/Library/LaunchAgents（旧版就是那么打印的，与实际写入不符）。
console.log("兜底定时 : " + (TIMER_PLAN.kind === null ? "（无可写）" : (uninstall ? "卸载 " : "") +
  (TIMER_PLAN.files.length ? TIMER_PLAN.files.map((f) => f.path).join("  ") : TIMER_REMOVE.join("  "))) +
  "  → " + TIMER_PLAN.action + (TIMER_PLAN.kind === null ? "（" + TIMER_PLAN.note + "）" : "（每 30 分钟排空全部登记项目）"));
for (const cmd of TIMER_PLAN.commands) console.log("            " + cmd.join(" ") + (String(cmd[0]).includes("launchctl") || cmd[0] === "systemctl" ? "" : ""));

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

// 安装面锁 + 维护门（issue #81）：先取安装面锁（与维护流程共用一把，持有到本进程退出），**再**看门 ——
// 门检是瞬时的，锁才是原子准入：过了检查门才建立的竞态被锁互斥挡住（评审探针）。
// 维护安装自己不走这个 CLI（maintenance-install-core 直接用投影函数），所以这里没有豁免口。
holdInstallSurfaceLockOrExit();
{
  const g = gateBlocks();
  if (g.blocked) { console.error("维护门：" + g.text + " —— 安装被拒，什么都没写。"); process.exit(2); }
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

/**
 * **只在登记表不存在时创建，绝不重写既有内容。**
 *
 * 原来是无条件 writeJsonAtomic(REGISTRY, registry) —— 即使安装器不再增删条目，
 * 那也意味着每次安装都把整份绑定数据读出来再整体写回去。这条路径上的任何一个
 * 解析/序列化差错都会落到真实绑定上，而绑定牵着话题历史。
 *
 * 装基础设施不该拿绑定数据当赌注。缺文件就建一份空的，其余交给显式绑定。
 */
/**
 * **排他创建，不是「先查再写」。**
 *
 * 上一版是 `if (!existsSync) writeJsonAtomic(...)` —— 典型的 check-then-write：
 * 从判定「不存在」到真正落盘之间，如果绑定流程恰好创建了登记表并写进第一条绑定，
 * 随后那次 rename 会把它整份覆盖成空表。而绑定牵着话题历史，覆盖掉历史就成孤儿。
 *
 * 讽刺的是这个 PR 的主题正是「别让安装器碰绑定数据」，我却用一个竞态把同样的风险
 * 又放了回去 —— 只是窗口变窄了，而窄窗口的竞态更难查。
 *
 * 用 `wx` 让创建本身原子：文件已存在就抛 EEXIST，那正是「不需要我建」，
 * 直接当无操作 —— 不读、不写、不覆盖。
 */
let registryAction = "untouched";
if (uninstall) {
  // 卸载基础设施不该创建订阅状态。
  registryAction = "untouched (uninstall)";
} else {
  try {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true, mode: 0o700 });
    fs.writeFileSync(REGISTRY,
      JSON.stringify({ schema_version: "1.0", projects: [] }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    registryAction = "created (empty)";
  } catch (err) {
    if (err.code !== "EEXIST") {
      console.error("登记表无法创建（" + err.code + "）：" + err.message);
      process.exit(1);
    }
    // EEXIST：已经有了，可能正是一次并发绑定刚建的。什么都不做才是对的。
  }
}

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
/**
 * **HOME 被覆盖时一律不碰 launchctl。**
 *
 * plist 文件路径跟着 `os.homedir()` 走，所以指定 HOME 就能把安装引到别处 —— 看起来像
 * 一个安全的沙箱安装。但 `launchctl bootout/bootstrap` 操作的是**真实用户的 launchd 域**，
 * 跟 HOME 一点关系都没有。于是一次"沙箱"安装会把线上那个兜底定时器卸掉，
 * 再把一个临时目录里的 plist 装进真实域 —— 临时目录一清，定时器就指向不存在的文件。
 *
 * 这不是假设：我为了测试 shell 安全性写了几条跑 `--apply` 的回归，用的正是临时 HOME，
 * 结果把线上 30 分钟兜底任务切到了临时目录。Codex 只读复核时发现的。
 *
 * `os.userInfo().homedir` 读的是密码库，不受 HOME 环境变量影响，所以能可靠区分
 * "真实安装"和"被重定向的安装"。
 */
const REAL_HOME = os.userInfo().homedir;
const SANDBOXED = os.homedir() !== REAL_HOME;

const launchctl = (args, { tolerate = false } = {}) => {
  if (SANDBOXED) return { ok: false, skipped: true };
  try {
    execFileSync("/bin/launchctl", args, { stdio: "pipe", timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    if (!tolerate) console.error("  launchctl " + args.join(" ") + " 失败：" + String(err.message).split("\n")[0]);
    return { ok: false };
  }
};

// systemd 那一侧同一条纪律（PK3-L1）：沙箱 HOME 不碰**真实** systemd --user 实例 —— 理由与 launchctl 处
// 逐字相同：systemctl --user 操作的是当前登录用户的实例，跟 HOME 一点关系都没有。
// FEISHU_BRIDGE_SYSTEMCTL 是测试隔离点（与 FEISHU_BRIDGE_LAUNCHCTL 同一口径）。
const systemctl = (args, { tolerate = false } = {}) => {
  if (SANDBOXED) return { ok: false, skipped: true };
  const bin = process.env.FEISHU_BRIDGE_SYSTEMCTL || "systemctl";
  try {
    execFileSync(bin, args, { stdio: "pipe", timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    if (!tolerate) console.error("  " + bin + " " + args.join(" ") + " 失败：" + String(err.message).split("\n")[0]);
    return { ok: false };
  }
};

const domain = "gui/" + process.getuid();
let launchNote;
if (uninstall) {
  // PK3-L1-fix1 P1-2：卸载**也按平台计划**。旧版无条件调 launchctl、只删 plist ——
  // linux 上 unit 与已启用的 timer 会继续跑（安装能写、卸载不管，是最难发现的那类残留）。
  if (TIMER_PLAN.kind === null) { launchNote = TIMER_PLAN.note; }
  else {
    const ran = TIMER_PLAN.commands.map((args) =>
      (TIMER_PLAN.kind === "launchd" ? launchctl(args, { tolerate: true }) : systemctl(args, { tolerate: true })));
    const skipped = ran.some((r) => r.skipped);
    for (const path0 of TIMER_REMOVE) fs.rmSync(path0, { force: true });
    const what = TIMER_PLAN.kind === "launchd" ? "plist" : "systemd 单元";
    const live = TIMER_PLAN.kind === "launchd" ? "launchd" : "systemd --user";
    // 沙箱卸载只删得掉这个 HOME 下的文件，真实域里那个 job/timer 还在跑。
    // 报"已卸载"会让人以为清干净了 —— 跟安装那侧同一个不对称，说法要对称。
    launchNote = skipped
      ? what + " 已删，但真实 " + live + " 未动（HOME 被重定向到 " + os.homedir() + "）"
      : "已卸载";
  }
} else if (TIMER_PLAN.kind === null) {
  // 其它平台：**明说没装**，安装继续（不假装装好）。计划里已经带了这句话。
  launchNote = TIMER_PLAN.note;
} else {
  for (const f of TIMER_FILES) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.text);
  }
  if (TIMER_PLAN.kind === "launchd") {
    launchctl(["bootout", domain + "/" + LAUNCH_LABEL], { tolerate: true }); // 没装过时必然失败，正常
    const loaded = launchctl(["bootstrap", domain, TIMER_FILES[0].path]);
    launchNote = loaded.skipped
      // 说出来，别让人以为兜底装好了。沙箱安装不碰真实 launchd 是有意的，见 launchctl 处的说明。
      ? "已跳过（HOME 被重定向到 " + os.homedir() + "，不碰真实 launchd）"
      : loaded.ok
        ? "已加载"
        : "**plist 已写入但 launchctl 加载失败 —— 兜底重试目前不生效**";
  } else {
    const reloaded = systemctl(["daemon-reload"], { tolerate: true });
    const enabled = reloaded.skipped ? { skipped: true } : systemctl(["enable", "--now", CLAUDE_DRAIN_SYSTEMD_UNIT + ".timer"]);
    launchNote = enabled.skipped
      ? "已跳过（HOME 被重定向到 " + os.homedir() + "，不碰真实 systemd --user）"
      : enabled.ok
        ? "已加载（systemd user timer）" + (TIMER_PLAN.note ? "；" + TIMER_PLAN.note : "")
        : "**单元已写入但 systemctl enable --now 失败 —— 兜底重试目前不生效**";
  }
}

// 机器级安装收据（维护门 PR B）—— **放在全部制品（settings / 技能 / plist）都写完之后**：记的是已经落盘的东西，不是打算写的。记下这次往线上写了什么（settings 只记桥拥有的封闭条目、plist 与技能整文件）与引用的脚本。
// 收据读不出（畸形）就不覆盖、只报出来 —— 它是下一次维护预检的"当前投影"，不能被安装器顺手改坏。
if (!uninstall) {
  const installedVersion = verifyRuntime().version ?? null;
  const artifacts = [
    { path: SETTINGS, kind: "claude-settings", sha256: artifactSha({ kind: "claude-settings", text: settingsAfter, home: os.homedir(), node: NODE_BIN }) },
    // darwin：plist（kind=plist）；linux：两个 systemd 单元（kind=file —— 受控集合里没有 systemd 专用 kind，
    //   而收据记的是「这次往线上写了哪些文件 + 它们的内容摘要」，用 file 如实表达）。
    ...TIMER_FILES.map((f) => ({ path: f.path, kind: TIMER_PLAN.kind === "launchd" ? "plist" : "file",
      sha256: artifactSha({ kind: TIMER_PLAN.kind === "launchd" ? "plist" : "file", text: f.text }) })),
    ...skillPlan.filter((sk) => sk.action !== "source-missing").map((sk) => ({ path: sk.dstFile, kind: "skill", sha256: artifactSha({ kind: "skill", text: renderSkill(fs.readFileSync(sk.srcFile, "utf-8")) }) })),
  ];
  const timerText = TIMER_FILES.map((f) => f.text).join("\n");
  const scripts = referencedRuntimeScripts([settingsAfter, plistBody, timerText, ...skillPlan.filter((sk) => sk.action !== "source-missing").map((sk) => renderSkill(fs.readFileSync(sk.srcFile, "utf-8")))].join("\n"));
  const receipt = installedVersion ? recordInstalledSurface({ chain: "claude", version: installedVersion, artifacts, scripts, file: installedSurfacePath({ chain: "claude", home: os.homedir() }) }) : { ok: false, reason: "runtime_version_unknown" };
  const report = receiptReport(receipt, { artifacts: artifacts.length, scripts: scripts.length });
  console.log("安装收据 : " + report.text);
  if (report.failed) process.exitCode = 1; // 收据没记下或留下残骸：制品已经写了，但下一次维护预检会拿不到当前投影 —— 不能显示成功
}

console.log("\n" + (backup ? "settings 已改，备份：" + backup : "settings 无改动，未重写"));
// 说出来：登记表牵着绑定和话题历史，"这次安装到底动没动它"不该靠人去猜。
console.log("登记表    ：" + registryAction);
console.log("兜底定时器：" + launchNote);
console.log("钩子和技能都立即生效，不需要重启会话。");
