#!/usr/bin/env node
/**
 * 安装 Codex adapter：追加 hooks、复制七项技能、初始化 registry。
 * 默认 dry-run；不修改 hook trust，安装本身不发送飞书。
 *
 * 安装**不改订阅策略**。新绑定登记时就默认开启自动发布；历史 task 的迁移走
 * migrate-auto-publish.mjs，这里只报数。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moduleRoot } from "../direct-run.mjs";
import { shellQuote } from "../shell-quote.mjs";

import {
  bridgeHome, enableAutoPublishForAllTasks, registryFile,
} from "./state.mjs";
import {
  applyRuntimeSync, codexRuntimeRoot, planRuntimeSync, verifyRuntime,
} from "../runtime-install.mjs";

const ROOT = moduleRoot(import.meta.url, "../..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const HOOKS = path.join(CODEX_HOME, "hooks.json");
const apply = process.argv.includes("--apply");
const uninstall = process.argv.includes("--uninstall");

const pickNode = () => {
  for (const file of ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]) {
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return process.execPath;
};
// 原来这里自带一份同样逻辑的 shellQuote。同一条策略写两遍就会漂 ——
// 这个仓库今天已经为这类重复付过一次代价（时间格式在两处各写一份，边界收紧了一处、
// 另一处没跟上）。改用共用实现。Codex 侧的钩子命令一直是正确加引号的，
// 这次是 Claude 侧向它看齐。
const node = pickNode();
const home = bridgeHome();
// **钩子只认 runtime/current，不再写安装时所在的那个克隆。**
//
// 旧写法是 path.join(ROOT, ...)，ROOT 是跑安装器时的仓库路径 —— 于是线上行为
// 取决于那个目录当时 checkout 到哪。实测过一次代价：线上钩子指向的克隆停在
// 一天前，落后 main 198 个提交，而没有任何地方会报出来。
// **根从 CODEX_HOME 推出来，不从 os.homedir() 拼。**
// CODEX_HOME 本来就是这条链的家目录覆盖点；用 os.homedir() 的话，
// 只隔离了 CODEX_HOME 的测试会真的往本机装一份运行时 —— 实测发生过。
const CHAIN = "codex";
const RUNTIME_ROOT = codexRuntimeRoot(CODEX_HOME);
const RUNTIME_CURRENT = path.join(RUNTIME_ROOT, "current");
const promptScript = path.join(RUNTIME_CURRENT, "scripts", "codex", "prompt-hook.mjs");
const stopScript = path.join(RUNTIME_CURRENT, "scripts", "codex", "stop-hook.mjs");
const log = path.join(home, "hook.log");
// 预览和落盘必须共用同一份扫描。原来这里用 loadRegistry 的**过滤视图**计数，
// 而真正的迁移读的是原始文档 —— 于是预览说"待迁移 1 个"、实际会改 3 个，
// 因为视图滤掉了 enabled:false 的 task 和 root 形状异常的记录。
const autoPublishPreview = enableAutoPublishForAllTasks({ home });
// 运行时计划要在 dry-run 打印之前算好 —— 预览必须说清将要装哪一版。
const runtimePlan = uninstall ? null : planRuntimeSync({ sourceRoot: ROOT, root: RUNTIME_ROOT });
const autoPublishMigrationCount = autoPublishPreview.ok ? autoPublishPreview.changed : null;

const hookCommand = (script) =>
  "if [ -x " + shellQuote(node) + " ] && [ -r " + shellQuote(script) + " ]; then " +
  "FEISHU_CODEX_BRIDGE_HOME=" + shellQuote(home) + " " + shellQuote(node) + " " + shellQuote(script) + "; " +
  "else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; " +
  "printf '%s hook-unavailable\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> " + shellQuote(log) + " 2>/dev/null || :; fi";

let before = "";
let hooks = { hooks: {} };
try {
  before = fs.readFileSync(HOOKS, "utf-8");
  hooks = JSON.parse(before);
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error("hooks.json 读不了：" + err.message);
    process.exit(1);
  }
}
hooks.hooks ??= {};

/**
 * 认一条 hook 条目是不是"我们的"。
 *
 * **按脚本文件名认，不按完整路径。**旧写法用 command.includes(完整路径)：
 * 路径从开发克隆换成 runtime/current 的那一刻它就匹配不上了，
 * 于是不是替换、而是**新增一条** —— 指向旧克隆的那条原地不动，
 * 两条 hook 同时在跑，而 Codex 文档说多个匹配的 hook 会全部运行。
 * 迁移本身会制造出它要消灭的问题。
 */
const ownsScript = (entry, basename) => (entry?.hooks ?? []).some((h) =>
  typeof h.command === "string" && h.command.includes("scripts/codex/" + basename));

/**
 * 让某个事件下**恰好只剩一条**我们的 hook。
 *
 * 返回值要能区分"本来就只有一条、换了内容"和"清掉了几条重复的" ——
 * 后者是迁移时最该被看见的事实。
 */
function updateHook(event, script, timeout) {
  const basename = path.basename(script);
  const entries = (hooks.hooks[event] ??= []);
  const mine = entries.filter((e) => ownsScript(e, basename));
  const others = entries.filter((e) => !ownsScript(e, basename));

  if (uninstall) {
    hooks.hooks[event] = others;
    return mine.length > 0 ? "removed(" + mine.length + ")" : "already-absent";
  }
  // 别人的 hook 一条不动，我们的全部丢掉重建成一条。
  hooks.hooks[event] = [...others,
    { hooks: [{ type: "command", command: hookCommand(script), timeout }] }];
  if (mine.length === 0) return "installed";
  if (mine.length === 1) {
    const was = JSON.stringify(mine[0]);
    const now = JSON.stringify(hooks.hooks[event][hooks.hooks[event].length - 1]);
    return was === now ? "unchanged" : "updated";
  }
  return "converged(清掉 " + mine.length + " 条，只留 1 条)";
}

const promptAction = updateHook("UserPromptSubmit", promptScript, 10);
const stopAction = updateHook("Stop", stopScript, 20);

const skills = [
  { name: "m5codex-inbound-router", files: ["SKILL.md", "aily-cli-skill.json"] },
  { name: "codex-longtask-feishu", files: ["SKILL.md"] },
  { name: "feishu-bind", files: ["SKILL.md"] },
  { name: "feishu-unbind", files: ["SKILL.md"] },
  { name: "feishu-status", files: ["SKILL.md"] },
  { name: "feishu-rotate", files: ["SKILL.md"] },
  { name: "feishu-mode", files: ["SKILL.md"] },
];
// {{SCRIPT:x.mjs}} 由渲染器负责加 shell 引号 —— 引用是渲染器的职责，不是模板作者的记性。
// 模板里原来写的是 node "{{BRIDGE_ROOT}}/scripts/…"，双引号挡得住空格但挡不住
// `$`、反引号和反斜杠；单引号才是 POSIX 里唯一完全字面的。
const renderedSkill = (file) => fs.readFileSync(file, "utf-8")
  .replaceAll(/\{\{SCRIPT:([A-Za-z0-9_./-]+)\}\}/gu,
    (_, name) => shellQuote(path.join(RUNTIME_CURRENT, "scripts", name)))
  .replaceAll("{{BRIDGE_ROOT}}", RUNTIME_CURRENT)
  .replaceAll("{{CODEX_BRIDGE_HOME_SHELL}}", shellQuote(home));

console.log("hooks       " + HOOKS);
console.log("  UserPromptSubmit → " + promptAction);
console.log("  Stop             → " + stopAction);
for (const skill of skills) {
  console.log("skill       " + path.join(CODEX_HOME, "skills", skill.name));
}
console.log("commands    $feishu-bind  $feishu-unbind  $feishu-status  $feishu-rotate  $feishu-mode（也出现在斜杠菜单）");
console.log("state       " + home + "（Git 外）");
console.log("publish     绑定 task 每轮自动发布；失败留队，历史积压不自动补发" +
  (autoPublishMigrationCount === null ? "" : "（待迁移 " + autoPublishMigrationCount + " 个 task）"));
if (!autoPublishPreview.ok) {
  // 读不出来就说读不出来，而且要在 dry-run 退出**之前**说 —— 静默省略会让
  // "没有待迁移项"和"根本没读到"在预览里长得一模一样。
  // 但**不因此恢复安装时改订阅**：读不出状态更不是替人改策略的理由。
  console.log("            待迁移状态不可读（" + autoPublishPreview.reason + "）；" +
    "可运行 scripts/codex/migrate-auto-publish.mjs 单独查看");
}
console.log("hook trust  不自动写信任；安装后由用户审阅并确认");
if (!uninstall) {
  console.log("运行时      " + RUNTIME_ROOT +
    (runtimePlan?.ok
      ? "  → 版本 " + runtimePlan.version.slice(0, 16) +
        "（" + runtimePlan.files.length + " 个脚本，来源 " + ROOT + "）"
      : "  → 算不出计划（" + (runtimePlan?.reason ?? "unknown") + "）"));
}
// **调度器不在这条命令里。**装了但没启用是默认态，不是某个检查碰巧生效的结果。
// 评审的裁决：启用要是一条独立命令，否则仍可能误组合。
console.log("兜底排空    未启用（默认）—— 单独跑 scripts/codex/drain-service.mjs 启用");

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才安装。");
  process.exit(0);
}

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

// **先装运行时，再写钩子。**顺序反了的话，钩子会有一段时间指向还不存在的路径 ——
// 那期间每一轮 Stop 都走 hook-unavailable 分支，进展静默留在本地。
if (!uninstall) {
  if (!runtimePlan?.ok) {
    console.error("运行时计划算不出来（" + (runtimePlan?.reason ?? "unknown") + "），什么都没装。");
    process.exit(1);
  }
  const synced = applyRuntimeSync(runtimePlan, { root: RUNTIME_ROOT });
  if (!synced.ok) {
    console.error("运行时装不上（" + synced.reason + "），钩子没动。");
    process.exit(1);
  }
  const checked = verifyRuntime({ root: RUNTIME_ROOT });
  if (!checked.ok) {
    console.error("运行时装完校验不过（" + (checked.reason ?? "drift") + "），钩子没动。");
    process.exit(1);
  }
  console.log("运行时    ：已装 " + runtimePlan.version.slice(0, 16) + " 并校验通过");
}

const after = JSON.stringify(hooks, null, 2) + "\n";
if (after !== before) {
  if (fs.existsSync(HOOKS)) fs.copyFileSync(HOOKS, HOOKS + ".bak." + Date.now());
  writeAtomic(HOOKS, after);
}

for (const skill of skills) {
  const src = path.join(ROOT, "skills", skill.name);
  const dst = path.join(CODEX_HOME, "skills", skill.name);
  if (uninstall) {
    fs.rmSync(dst, { recursive: true, force: true });
    continue;
  }
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const name of skill.files) {
    const source = path.join(src, name);
    const content = name === "SKILL.md" ? renderedSkill(source) : fs.readFileSync(source);
    fs.writeFileSync(path.join(dst, name), content, { mode: 0o600 });
  }
}

if (!uninstall && !fs.existsSync(registryFile(home))) {
  writeAtomic(registryFile(home), JSON.stringify({ schema_version: "1.0", runtime: "codex", tasks: [] }, null, 2) + "\n");
}
if (!uninstall) {
  // task 尚未路由成功时的脱敏错误回执使用这个目录；提前创建，避免首个错误路径才 mkdir。
  fs.mkdirSync(path.join(home, "receipts"), { recursive: true, mode: 0o700 });
  // **安装不再改订阅策略。**原来这里会把所有已登记 task 的 auto_publish_on_completion
  // 强改为 true —— 装一次基础设施，顺手把每条绑定的发布行为改掉，不预览、不留痕、不可选。
  // 新绑定登记时就默认开启，不依赖这一步；历史 task 走显式的 migrate-auto-publish.mjs。
  if (autoPublishPreview.ok && autoPublishPreview.changed > 0) {
    console.log("自动发布  有 " + autoPublishPreview.changed + " 个历史 task 尚未启用；" +
      "要迁移请显式运行 scripts/codex/migrate-auto-publish.mjs --apply");
  }
}
console.log("\n已完成本地安装。下一次 Codex 载入 hook 时会要求信任；请核对命令后再确认。");
