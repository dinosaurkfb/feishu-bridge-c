#!/usr/bin/env node
/** 生成 ~/.codex/feishu-bridge/chain-config.json；单 M5Codex 身份是强约束。 */

import fs from "node:fs";
import { parseArgvOptions } from "../argv-options.mjs"; // PK3-C220-fix1：一次解析 argv
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG_BASE, describeTemplateWrite, validateChainTemplate, withChainTemplateWrite } from "../chain-template.mjs";
import { bridgeHome, templateFile, validateCodexTemplate } from "./state.mjs";
import { moduleRoot } from "../direct-run.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";

const ROOT = moduleRoot(import.meta.url, "../..");

const USAGE = "用法：\n" +
  "  node scripts/codex/init-chain-template.mjs \\\n" +
  "    --agent-uid agent_xxx \\\n" +
  "    --transport-agent-name M5Codex \\\n" +
  "    --transport-app-id cli_xxx \\\n" +
  "    --transport-open-id ou_xxx \\\n" +
  "    --frank-sender-id 0000000000000000000 \\\n" +
  "    --chat-id oc_xxx \\\n" +
  "    --chat-name \"目标群\" \\\n" +
  "    [--apply]";

const KNOWN_BOOLEAN_FLAGS = new Set(["--apply"]);
const KNOWN_VALUE_FLAGS = new Set([
  "--transport-agent-name",
  "--transport-app-id",
  "--transport-open-id",
  "--lark-cli-profile",
  "--lark-cli-bin",
  "--lark-cli-home",
  "--lark-cli-config-base",
  "--frank-sender-id",
  "--chat-name",
  "--chat-id",
  "--default-freshness-ms",
  "--agent-uid",
]);

// PK3-C220-fix1：argv 一次解析成 options map（等号形式、缺值校验）—— 与 Claude 链同形状。
const parsed = parseArgvOptions(process.argv.slice(2),
  { booleanFlags: KNOWN_BOOLEAN_FLAGS, valueFlags: KNOWN_VALUE_FLAGS });
if (!parsed.ok) {
  console.error(parsed.message);
  if (parsed.kind === "unknown" && parsed.flag === "--bridge-root") {
    console.error("bridge_root 由安装器维护：Codex 链装机时改写为 runtime/current，Claude 链仅作标志；先写模板再跑安装器");
  }
  console.error("\n" + USAGE);
  process.exit(2);
}
const opt = (n) => parsed.options[n];
const apply = opt("apply") === true;
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
const transportName = opt("transport-agent-name") ?? "M5Codex";
const transportApp = opt("transport-app-id");
const transportOpen = opt("transport-open-id");

let larkBin = opt("lark-cli-bin");
if (!larkBin) {
  larkBin = ["/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli"].find((p) => fs.existsSync(p));
}
const template = {
  schema_version: "1.0",
  chain: "codex",
  transport_agent_name: transportName,
  transport_app_id: transportApp,
  transport_open_id: transportOpen,
  // 不是可选默认：Codex 方案从构造上只有一个 M5Codex。
  outbound_agent_name: transportName,
  outbound_app_id: transportApp,
  outbound_open_id: transportOpen,
  lark_cli_profile: opt("lark-cli-profile") ?? "platform-bot",
  lark_cli_bin: larkBin,
  lark_cli_home: opt("lark-cli-home") ?? path.join(os.homedir(), ".lark-cli"),
  lark_cli_config_base: opt("lark-cli-config-base") ?? DEFAULT_CONFIG_BASE,
  frank_sender_id: opt("frank-sender-id"),
  chat_name: opt("chat-name"),
  chat_id: opt("chat-id"),
  default_freshness_ms: Number(opt("default-freshness-ms") ?? 15 * 60 * 1000),
  inbound_prefix: null,
  agent_uid: opt("agent-uid"),
  bridge_root: ROOT,
};
const common = validateChainTemplate(template);
const codex = validateCodexTemplate(template);
const mask = (value) => {
  const s = String(value ?? "");
  return s.length <= 10 ? s : s.slice(0, 5) + "…" + s.slice(-3);
};

console.log("模板      " + templateFile());
console.log("运行时    codex");
console.log("唯一身份  " + transportName);
console.log("入站关键字  无（真实 @" + transportName + " 后的正文直接作为指令）");
for (const field of ["agent_uid", "transport_app_id", "transport_open_id", "frank_sender_id", "chat_id"]) {
  console.log("  " + (template[field] ? "✓ " + field + " = " + mask(template[field]) : "✗ " + field + " 缺"));
}
if (!common.ok || !codex.ok) {
  console.error("\n模板不完整，没有写入。");
  if (common.missing.length) console.error("缺字段：" + common.missing.join(", "));
  if (common.malformed.length) console.error("形状不对：" + common.malformed.join(", "));
  if (codex.problems.length) console.error("单智能体约束：" + codex.problems.join("；"));
  process.exit(1);
}
if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
  process.exit(0);
}
const file = templateFile(bridgeHome());
const wrote = withChainTemplateWrite({ file, backupSuffix: ".prev", allowInvalidCurrent: true, mutate: () => ({ template }) });
{
  const told = describeTemplateWrite(wrote, file);
  if (told.exitCode !== 0) { console.error(told.lines.join("\n")); process.exit(told.exitCode); }
}
console.log("已写入 " + file + "。下一步先运行 scripts/codex/install.mjs 预览安装内容。");
