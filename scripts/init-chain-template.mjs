#!/usr/bin/env node
/**
 * 从一个已经接好的项目里提取链路级字段，生成机器级模板。
 *
 * 为什么要一个脚本而不是手抄：那份 chain-config 在 .runtime-data/ 里，长期任务对它
 * 没有读写权限（见 CLAUDE.md 的边界）。让脚本来搬字段，搬的过程是确定性的、
 * 只挑白名单里的字段、屏显一律打码 —— 干活的一方从头到尾看不到那些身份标识的全文。
 *
 * 用法：
 *   node scripts/init-chain-template.mjs --chat-id oc_xxx              # dry-run
 *   node scripts/init-chain-template.mjs --chat-id oc_xxx --apply
 *   node scripts/init-chain-template.mjs --from /path/to/other --chat-id oc_xxx --apply
 */

import fs from "node:fs";
import path from "node:path";

import { CHAIN_FIELDS, templatePath, validateChainTemplate } from "./chain-template.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");

const from = path.resolve(arg("from") ?? ROOT);
const src = path.join(from, ".runtime-data", "inbound", "chain-config.json");

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(src, "utf-8"));
} catch (err) {
  console.error("读不了源配置：" + src);
  console.error(err.message);
  process.exit(1);
}

const tpl = { schema_version: "1.0" };
for (const f of CHAIN_FIELDS) if (cfg[f] !== undefined) tpl[f] = cfg[f];

// 群 id 源配置里没有（旧 schema 只有 chat_name），必须显式传进来。
const chatId = arg("chat-id");
if (chatId) tpl.chat_id = chatId;

// 桥仓库自己的位置：接入命令和技能都要靠它找到 scripts/。
tpl.bridge_root = ROOT;

const check = validateChainTemplate(tpl);

// 屏显打码：这些是身份标识，没有理由在终端里出现全文，更没有理由被转发到飞书。
const mask = (v) => {
  const s = String(v);
  if (typeof v === "number" || typeof v === "boolean") return s;
  return s.length <= 10 ? s : s.slice(0, 6) + "…" + s.slice(-3) + "（" + s.length + " 字符）";
};

console.log("源      " + src);
console.log("模板    " + templatePath());
console.log("");
for (const f of CHAIN_FIELDS) {
  const has = tpl[f] !== undefined && tpl[f] !== null && tpl[f] !== "";
  console.log("  " + (has ? "✓" : "✗") + " " + f.padEnd(24) + (has ? mask(tpl[f]) : "缺"));
}

if (!check.ok) {
  console.error("\n模板不完整，没有落盘。");
  if (check.missing.length) console.error("  缺字段：" + check.missing.join(", "));
  if (check.malformed.length) console.error("  形状不对：" + check.malformed.join(", "));
  if (check.missing.includes("chat_id")) console.error("  群 id 用 --chat-id oc_xxx 传进来（旧 schema 里没有这个字段）。");
  process.exit(1);
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
  process.exit(0);
}

const out = templatePath();
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
// 已有模板先留一份：这份文件一旦写错，后面每个新接入的项目都会拿到错的身份。
if (fs.existsSync(out)) fs.copyFileSync(out, out + ".prev");
const tmp = out + ".tmp." + process.pid;
fs.writeFileSync(tmp, JSON.stringify(tpl, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, out);

console.log("\n已写入 " + out);
console.log("现在可以在任意项目里跑 bind-project 接入。");
