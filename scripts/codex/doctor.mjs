#!/usr/bin/env node
/** Codex adapter 只读自检：不写配置、不安装、不联网，也不输出身份或 thread locator。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moduleRoot } from "../direct-run.mjs";
import { codexRuntimeRoot, verifyRuntime } from "../runtime-install.mjs";
import { acceptsHookCommand, ownsHookCommand, pickNode } from "./hook-command.mjs";
import { SKILL_NAMES, auditSkills } from "./skill-content.mjs";
import { PHASE_TEXT, serviceState } from "./drain-service.mjs";

import {
  bridgeHome, loadCodexTemplate, loadRegistry, registryFile,
} from "./state.mjs";

const ROOT = moduleRoot(import.meta.url, "../..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const JSON_OUTPUT = process.argv.includes("--json");
const REQUIRED_SKILLS = [
  "m5codex-inbound-router",
  "codex-longtask-feishu",
  "feishu-bind",
  "feishu-unbind",
  "feishu-status",
  "feishu-rotate",
  "feishu-mode",
];

function commandPath(name, extra = []) {
  const candidates = [
    ...extra,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
  ];
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* 继续查 */ }
  }
  return null;
}

/**
 * 某个事件下有几条**我们的** hook —— 判据来自安装器同一份模块。
 *
 * 上一版这里自己写了一套"命令里出现 scripts/codex/<名字>"的判据。
 * 评审用反例证明了它是假绿：一条 `echo <runtime/current/.../stop-hook.mjs>`
 * 被 doctor 判为"恰好 1 条，指向 runtime/current"，而安装器根本不认它。
 * **验收工具和被验收的东西必须说同一件事。**
 */
function hookCommands(hooks, event, basename) {
  const out = [];
  for (const entry of hooks?.hooks?.[event] ?? []) {
    for (const hook of entry?.hooks ?? []) {
      if (ownsHookCommand(hook?.command, basename)) out.push(hook.command);
    }
  }
  return out;
}

const checks = [];
const add = (name, ok, detail, next = null) => checks.push({ name, ok, detail, next });

const nodeMajor = Number(process.versions.node.split(".")[0]);
add("Node.js", nodeMajor >= 22, "v" + process.versions.node,
  "安装 Node.js 22 或更高版本");

const codexBin = commandPath("codex");
add("Codex CLI", codexBin !== null, codexBin === null ? "PATH 中未找到" : "已找到",
  "安装 Codex CLI，并确认 `codex --version` 可运行");

const ailyBin = commandPath("aily-cli");
add("aily-cli", ailyBin !== null, ailyBin === null ? "PATH 中未找到" : "已找到",
  "安装并登录 aily-cli，然后运行 `aily-cli doctor`");

const home = bridgeHome();
const template = loadCodexTemplate();
add("机器级模板", template.ok, template.ok ? "结构与单智能体约束通过" : template.reason,
  "按 CODEX_SETUP.md 运行 `init-chain-template.mjs`，先 dry-run 再加 `--apply`");
const configuredRoot = template.ok && typeof template.template.bridge_root === "string"
  ? path.resolve(template.template.bridge_root)
  : null;
// **不再检查"模板指不指向当前仓库"。**那条问的是"你是从哪个克隆跑的 doctor"，
// 不是"线上装的是什么"。同一套安装换个目录跑就换个结论 —— 这种检查在迁移之后
// 会稳定误报，而它恰恰是唯一的验收工具。
// **根必须跟安装器用同一个算法。**这里曾经用 os.homedir() 拼，而安装器走
// CODEX_HOME —— 两边算出不同的路径，doctor 就会永远说"指向 runtime 之外"，
// 而线上其实是好的。判据和被判据的对象必须共用同一个函数。
const RUNTIME_ROOT = codexRuntimeRoot(CODEX_HOME);
const runtime = verifyRuntime({ root: RUNTIME_ROOT });
add("运行时", runtime.ok === true,
  runtime.ok
    ? "current 指向 " + String(runtime.version ?? "?").slice(0, 16) + "，清单与内容一致"
    : "校验不过（" + (runtime.reason ?? "drift") + "）",
  "运行 `node scripts/codex/install.mjs` 预览，确认后加 `--apply`");

const configuredLark = template.ok && typeof template.template.lark_cli_bin === "string"
  ? template.template.lark_cli_bin
  : null;
const larkBin = commandPath("lark-cli", configuredLark ? [configuredLark] : []);
add("lark-cli", larkBin !== null, larkBin === null ? "未找到可执行文件" : "已找到",
  "安装 lark-cli，或在机器级模板中提供正确的 `--lark-cli-bin`");

let hooks = null;
const hooksFile = path.join(CODEX_HOME, "hooks.json");
try { hooks = JSON.parse(fs.readFileSync(hooksFile, "utf-8")); } catch { /* 下方统一报告 */ }
const RUNTIME_CURRENT = path.join(RUNTIME_ROOT, "current");
// **期望定义要跟安装器逐字同源**：node、脚本、bridge home、日志四项都算。
// 只比脚本路径的话，node 指到不存在的二进制、日志写错地方，doctor 照样报正常。
const expectOf = (name) => ({
  node: pickNode(),
  script: path.join(RUNTIME_CURRENT, "scripts", "codex", name),
  home,
  log: path.join(home, "hook.log"),
});
const expectPrompt = expectOf("prompt-hook.mjs");
const expectStop = expectOf("stop-hook.mjs");
const hookReport = [
  ["UserPromptSubmit", "prompt-hook.mjs", expectPrompt],
  ["Stop", "stop-hook.mjs", expectStop],
].map(([event, basename, expected]) => {
  const found = hookCommands(hooks, event, basename);
  if (found.length === 0) return { event, ok: false, why: "缺失" };
  // **重复一条就是旧代码还在跑。**Codex 文档说多个匹配的 hook 会全部运行 ——
  // 迁移时如果按完整路径去找旧条目，路径一换就匹配不上，于是新增而不是替换。
  if (found.length > 1) return { event, ok: false, why: found.length + " 条重复" };
  // **逐字相等，不是包含。**acceptsHookCommand 同时验"是我们的"和"正是这个脚本"。
  if (!acceptsHookCommand(found[0], expected)) {
    return { event, ok: false, why: "与安装器会写的那条对不上（脚本/node/home/日志任一不同）" };
  }
  return { event, ok: true, why: "恰好 1 条，指向 runtime/current" };
});
const hooksOk = hookReport.every((r) => r.ok);
add("Codex hooks", hooksOk,
  hooksOk ? "UserPromptSubmit 与 Stop 各恰好 1 条，均指向 runtime/current"
    : hookReport.filter((r) => !r.ok).map((r) => r.event + "：" + r.why).join("；"),
  "运行 `node scripts/codex/install.mjs` 预览，确认后加 `--apply`");
// **信任状态读不到就说读不到，不许由"文件存在"推出"已信任"。**
// Codex 文档明说 hook 定义变了要按新的定义哈希重新信任 ——
// 迁移正好会改变命令本身，这一步最容易被当成已经完成。
add("hook 信任", null, "本地读不到 Codex 的信任状态；hook 已安装不等于已信任",
  "在 Codex 里用 /hooks 核对命令后确认；迁移改了命令，多半需要重新信任");

// **逐字节比对，不是"文件在不在"。**runtime 换了、路径改了，旧内容照样存在；
// 只查存在的话，一次没生效的安装看起来跟成功一模一样。
const skillAudit = auditSkills({
  repoRoot: ROOT, codexHome: CODEX_HOME,
  runtimeCurrent: RUNTIME_CURRENT, bridgeHome: home,
});
add("Codex skills", skillAudit.ok,
  skillAudit.ok ? SKILL_NAMES.length + " 项内容均与期望逐字节一致"
    : skillAudit.problems.map((p) => p.skill + "/" + p.file + "：" + p.why).join("；"),
  "运行 `node scripts/codex/install.mjs` 预览，确认后加 `--apply`");

const registry = loadRegistry(registryFile(home));
const tasks = registry.ok ? registry.tasks : [];
const active = tasks.filter((task) => (task.status ?? "active") === "active");
const bound = active.filter((task) => task.inbound_state === "bound");
add("task 登记表", registry.ok,
  registry.ok ? "已登记 " + tasks.length + " 个，启用 " + active.length + " 个，入站绑定 " + bound.length + " 个" : registry.reason,
  "安装器会创建空登记表；随后在目标 task 中运行 `$feishu-bind`");

// **三态，不是两态。**ok === null 表示"这件事本地查不出来"，
// 它既不是通过、也不是故障。上一版只有真/假，于是"查不清"被画成 ✗ ——
// 人会去修一件本来就查不清的事；反过来把它算成通过，就是在声称一件没查过的事。
// 第 1 层的 inbound 自检早就是这个道理（永远 unknown），这里跟它对齐。
const failed = (check) => check.ok === false;
// 调度器状态单独报，而且**未启用不算故障** —— 那是安装后的默认态。
// 把它报成故障，人就会去"修"一件本来就该这样的事。
try {
  const svc = serviceState();
  // 四态各自的判定：**只有真的被 launchd 加载了才算通过**。
  // plist 写了没加载是故障（定时器不会跑）；未启用和查不出来都是 null。
  const ok = svc.phase === "loaded" ? true
    : (svc.phase === "stale" || svc.phase === "installed_not_loaded" ||
       svc.phase === "loaded_other" || svc.phase === "orphan" ||
       svc.phase === "plist_unreadable") ? false
    : null;
  add("兜底排空", ok,
    (PHASE_TEXT[svc.phase] ?? svc.phase) +
      (svc.phase === "absent" && svc.backlog.ok && svc.backlog.total > 0
        ? "；还有 " + svc.backlog.total + " 条历史积压未分类" : ""),
    ok === false ? "重跑 `node scripts/codex/drain-service.mjs --enable --apply`" : null);
} catch (err) {
  add("兜底排空", null, "状态读不出来（" + err.message + "）");
}

/**
 * 三态汇总。**"查不清"不等于"就绪"。**
 *
 * 上一版是 every(ok !== false)：全是 null 时也报 ready:true、exit 0、
 * "机器级组件已就绪" —— 而 hook 信任本来就查不到，于是它永远算通过。
 * 那把三态又压回了两态，只是压向了另一边。
 *
 *   任一 false        → blocked（有真故障）
 *   无 false、有 null → incomplete（还差人去确认的事，不是坏了）
 *   全 true           → ready
 */
const overall = checks.some((check) => check.ok === false) ? "blocked"
  : checks.some((check) => check.ok === null) ? "incomplete" : "ready";
const ready = overall === "ready";
// 待办要**同时收 false 和 null**：hook 信任那条永远是 null，
// 而它恰恰是迁移之后最需要人去做的一步。只收 false 就等于把它藏起来。
const next = [...new Set(checks
  .filter((check) => check.ok !== true && check.next)
  .map((check) => check.next))];
if (JSON_OUTPUT) {
  process.stdout.write(JSON.stringify({ ready, overall, checks, next }, null, 2) + "\n");
} else {
  console.log("Codex 飞书桥 · 只读自检\n");
  for (const check of checks) {
    const mark = check.ok === true ? "✓ " : check.ok === false ? "✗ " : "? ";
    console.log(mark + check.name + "：" + check.detail);
  }
  if (next.length > 0) {
    console.log("\n下一步：");
    next.forEach((item, index) => console.log((index + 1) + ". " + item));
  } else if (overall === "incomplete") {
    console.log("\n还差人确认几件本地查不出来的事（上面标 ? 的）；没有发现故障。");
  } else if (tasks.length === 0) {
    console.log("\n机器已就绪。请在要接入的 Codex task 中运行 `$feishu-bind`。");
  } else {
    console.log("\n机器级组件已就绪。单个 task 的连接状态请运行 `$feishu-status` 查看。");
  }
}

// **incomplete 也非零退出。**它不是故障，但也不是"可以不管了"——
// 让脚本把它当成功，人就永远不会去做那一步。
process.exitCode = ready ? 0 : 1;
