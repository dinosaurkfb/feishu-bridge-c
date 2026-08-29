#!/usr/bin/env node
/** 生成 ~/.codex/feishu-bridge/chain-config.json；单 M5Codex 身份是强约束。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG_BASE, validateChainTemplate, withChainTemplateWrite } from "../chain-template.mjs";
import { bridgeHome, templateFile, validateCodexTemplate } from "./state.mjs";
import { moduleRoot } from "../direct-run.mjs";

const ROOT = moduleRoot(import.meta.url, "../..");
const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const transportName = arg("transport-agent-name") ?? "M5Codex";
const transportApp = arg("transport-app-id");
const transportOpen = arg("transport-open-id");

let larkBin = arg("lark-cli-bin");
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
  lark_cli_profile: arg("lark-cli-profile") ?? "platform-bot",
  lark_cli_bin: larkBin,
  lark_cli_home: arg("lark-cli-home") ?? path.join(os.homedir(), ".lark-cli"),
  lark_cli_config_base: arg("lark-cli-config-base") ?? DEFAULT_CONFIG_BASE,
  frank_sender_id: arg("frank-sender-id"),
  chat_name: arg("chat-name"),
  chat_id: arg("chat-id"),
  default_freshness_ms: Number(arg("default-freshness-ms") ?? 15 * 60 * 1000),
  inbound_prefix: null,
  agent_uid: arg("agent-uid"),
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
console.log("入站关键字  无（真实 @M5Codex 后的正文直接作为指令）");
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
if (!wrote.ok) { console.error("没有落盘：" + wrote.reason + (wrote.detail ? "：" + (typeof wrote.detail === "string" ? wrote.detail : JSON.stringify(wrote.detail)) : "")); process.exit(1); }
if (wrote.lockUncleared) { console.error("已写入，但模板写锁没有交还（" + wrote.lockUncleared + "）：请人工确认后处理 " + file + ".lock"); process.exit(1); }
console.log("已写入 " + file + "。下一步先运行 scripts/codex/install.mjs 预览安装内容。");
