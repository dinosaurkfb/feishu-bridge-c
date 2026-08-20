#!/usr/bin/env node
/** Codex adapter 只读自检：不写配置、不安装、不联网，也不输出身份或 thread locator。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bridgeHome, loadCodexTemplate, loadRegistry, registryFile,
} from "./state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const JSON_OUTPUT = process.argv.includes("--json");
const REQUIRED_SKILLS = [
  "m5codex-inbound-router",
  "codex-longtask-feishu",
  "feishu-bind",
  "feishu-unbind",
  "feishu-status",
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

function hookInstalled(hooks, event, script) {
  return (hooks?.hooks?.[event] ?? []).some((entry) =>
    (entry?.hooks ?? []).some((hook) =>
      typeof hook?.command === "string" && hook.command.includes(script)));
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
add("仓库路径", configuredRoot === ROOT,
  configuredRoot === ROOT ? "机器级模板指向当前仓库" : "模板仍指向其他位置",
  "仓库移动后重新生成机器级模板，并重新安装 hooks/skills");

const configuredLark = template.ok && typeof template.template.lark_cli_bin === "string"
  ? template.template.lark_cli_bin
  : null;
const larkBin = commandPath("lark-cli", configuredLark ? [configuredLark] : []);
add("lark-cli", larkBin !== null, larkBin === null ? "未找到可执行文件" : "已找到",
  "安装 lark-cli，或在机器级模板中提供正确的 `--lark-cli-bin`");

let hooks = null;
const hooksFile = path.join(CODEX_HOME, "hooks.json");
try { hooks = JSON.parse(fs.readFileSync(hooksFile, "utf-8")); } catch { /* 下方统一报告 */ }
const promptScript = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
const stopScript = path.join(ROOT, "scripts", "codex", "stop-hook.mjs");
const promptHook = hookInstalled(hooks, "UserPromptSubmit", promptScript);
const stopHook = hookInstalled(hooks, "Stop", stopScript);
add("Codex hooks", promptHook && stopHook,
  promptHook && stopHook ? "UserPromptSubmit 与 Stop 均已安装" :
    "缺少" + [!promptHook ? " UserPromptSubmit" : "", !stopHook ? " Stop" : ""].join(""),
  "运行 `node scripts/codex/install.mjs` 预览，确认后加 `--apply`");

const missingSkills = REQUIRED_SKILLS.filter((name) =>
  !fs.existsSync(path.join(CODEX_HOME, "skills", name, "SKILL.md")));
add("Codex skills", missingSkills.length === 0,
  missingSkills.length === 0 ? REQUIRED_SKILLS.length + " 项均已安装" : "缺少 " + missingSkills.join(", "),
  "运行 `node scripts/codex/install.mjs --apply`");

const registry = loadRegistry(registryFile(home));
const tasks = registry.ok ? registry.tasks : [];
const active = tasks.filter((task) => (task.status ?? "active") === "active");
const bound = active.filter((task) => task.inbound_state === "bound");
add("task 登记表", registry.ok,
  registry.ok ? "已登记 " + tasks.length + " 个，启用 " + active.length + " 个，入站绑定 " + bound.length + " 个" : registry.reason,
  "安装器会创建空登记表；随后在目标 task 中运行 `$feishu-bind`");

const ready = checks.every((check) => check.ok);
const next = [...new Set(checks.filter((check) => !check.ok && check.next).map((check) => check.next))];
if (JSON_OUTPUT) {
  process.stdout.write(JSON.stringify({ ready, checks, next }, null, 2) + "\n");
} else {
  console.log("Codex 飞书桥 · 只读自检\n");
  for (const check of checks) console.log((check.ok ? "✓ " : "✗ ") + check.name + "：" + check.detail);
  if (next.length > 0) {
    console.log("\n下一步：");
    next.forEach((item, index) => console.log((index + 1) + ". " + item));
  } else if (tasks.length === 0) {
    console.log("\n机器已就绪。请在要接入的 Codex task 中运行 `$feishu-bind`。");
  } else {
    console.log("\n机器级组件已就绪。单个 task 的连接状态请运行 `$feishu-status` 查看。");
  }
}

process.exitCode = ready ? 0 : 1;
