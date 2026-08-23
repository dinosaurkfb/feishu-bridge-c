#!/usr/bin/env node
/**
 * 安装 Codex adapter：追加 hooks、复制七项技能、初始化 registry，并为已登记 task 启用
 * 每轮自动发布。默认 dry-run；不修改 hook trust，安装本身不发送飞书。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moduleRoot } from "../direct-run.mjs";

import {
  bridgeHome, enableAutoPublishForAllTasks, loadRegistry, registryFile,
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
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const node = pickNode();
const home = bridgeHome();
const promptScript = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
const stopScript = path.join(ROOT, "scripts", "codex", "stop-hook.mjs");
const log = path.join(home, "hook.log");
const currentRegistry = loadRegistry(registryFile(home));
const autoPublishMigrationCount = currentRegistry.ok
  ? currentRegistry.tasks.filter((task) => task.auto_publish_on_completion !== true).length
  : null;

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
const renderedSkill = (file) => fs.readFileSync(file, "utf-8")
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
  const migrated = enableAutoPublishForAllTasks({ home });
  if (!migrated.ok) {
    console.error("自动发布合同迁移失败：" + migrated.reason + (migrated.error ? "（" + migrated.error + "）" : ""));
    process.exit(1);
  }
  console.log("自动发布  已为 " + migrated.tasks + " 个已登记 task 启用（本次更新 " + migrated.changed + " 个）");
}
console.log("\n已完成本地安装。下一次 Codex 载入 hook 时会要求信任；请核对命令后再确认。");
