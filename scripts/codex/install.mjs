#!/usr/bin/env node
/**
 * 安装 Codex adapter：追加 hooks、复制七项技能、初始化 registry，并为已登记 task 启用
 * 每轮自动发布。默认 dry-run；不修改 hook trust，安装本身不发送飞书。
 * 安装**不改订阅策略**：历史 task 的迁移走 migrate-auto-publish.mjs，这里只报数。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moduleRoot } from "../direct-run.mjs";
import { shellQuote } from "../shell-quote.mjs";

import {
  bridgeHome, enableAutoPublishForAllTasks, registryFile,
} from "./state.mjs";

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
const promptScript = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
const stopScript = path.join(ROOT, "scripts", "codex", "stop-hook.mjs");
const log = path.join(home, "hook.log");
// 预览和落盘必须共用同一份扫描。原来这里用 loadRegistry 的**过滤视图**计数，
// 而真正的迁移读的是原始文档 —— 于是预览说"待迁移 1 个"、实际会改 3 个，
// 因为视图滤掉了 enabled:false 的 task 和 root 形状异常的记录。
const autoPublishPreview = enableAutoPublishForAllTasks({ home });
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

function updateHook(event, script, timeout) {
  const entries = (hooks.hooks[event] ??= []);
  const at = entries.findIndex((entry) =>
    (entry?.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(script)));
  if (uninstall) {
    if (at >= 0) entries.splice(at, 1);
    return at >= 0 ? "removed" : "already-absent";
  }
  const value = { hooks: [{ type: "command", command: hookCommand(script), timeout }] };
  if (at >= 0) entries[at] = value;
  else entries.push(value);
  return at >= 0 ? "updated" : "installed";
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
    (_, name) => shellQuote(path.join(ROOT, "scripts", name)))
  .replaceAll("{{BRIDGE_ROOT}}", ROOT)
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
console.log("hook trust  不自动写信任；安装后由用户审阅并确认");

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
  const pendingMigration = enableAutoPublishForAllTasks({ home });
  if (!pendingMigration.ok) {
    // 读不出来就说读不出来。静默忽略会让"没有待迁移项"和"根本没读到"长得一样。
    // 但**不因此恢复安装时改订阅**：读不出状态更不是替人改策略的理由。
    console.log("自动发布  待迁移状态不可读（" + pendingMigration.reason + "）；" +
      "可运行 scripts/codex/migrate-auto-publish.mjs 单独查看");
  } else if (pendingMigration.changed > 0) {
    console.log("自动发布  有 " + pendingMigration.changed + " 个历史 task 尚未启用；" +
      "要迁移请显式运行 scripts/codex/migrate-auto-publish.mjs --apply");
  }
}
console.log("\n已完成本地安装。下一次 Codex 载入 hook 时会要求信任；请核对命令后再确认。");
