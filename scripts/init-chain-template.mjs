#!/usr/bin/env node
/**
 * 写机器级链路模板 —— 装这台机器时**最先**做的一件事。
 *
 * 顺序很重要，而且这一版才排对：模板原来是「从一个已经配好的项目里派生出来」的，
 * 于是新装机器的人陷进一个死循环 —— 入站要靠模板里的 agent_uid 做调用者校验，
 * 而模板要等到项目配置写完才有，可项目配置又在「验证入站能通」之后。
 *
 * 机器级的东西不该由任何一个项目产生。所以现在两种模式：
 *
 *   直接写（新装机器走这条）：字段全部由命令行给
 *   从项目派生（老机器迁移用）：--from <项目目录>，缺的字段再用命令行补
 *
 * 排对之后连带的好处：第一个项目不再特殊，它和后面每个项目一样走 bind-project，
 * 不用手写那份三十多个字段的项目配置，也不用先手建话题。
 *
 * 用法：
 *   node scripts/init-chain-template.mjs \
 *     --agent-uid agent_xxx --transport-app-id cli_xxx --transport-open-id ou_xxx \
 *     --frank-sender-id 762... --chat-id oc_xxx --chat-name "群名" --apply
 *
 *   node scripts/init-chain-template.mjs --from /path/to/old-project --chat-id oc_xxx --apply
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHAIN_FIELDS, DEFAULT_CONFIG_BASE, templatePath, validateChainTemplate } from "./chain-template.mjs";
import { moduleRoot } from "./direct-run.mjs";

const ROOT = moduleRoot(import.meta.url, "..");

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");

/** 字段名 → 命令行开关名。用短横线是为了敲起来顺手，映射只此一处。 */
const flagOf = (field) => field.replace(/_/g, "-");

// ---------- 1. 先从项目派生（如果指定了） ----------

const from = arg("from");
const derived = {};
const sources = {};

if (from !== undefined) {
  const src = path.join(path.resolve(from), ".runtime-data", "inbound", "chain-config.json");
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(src, "utf-8"));
  } catch (err) {
    console.error("读不了源配置：" + src);
    console.error(err.message);
    process.exit(1);
  }
  for (const f of CHAIN_FIELDS) {
    if (cfg[f] !== undefined) { derived[f] = cfg[f]; sources[f] = "项目配置"; }
  }
}

// ---------- 2. 命令行覆盖 / 补齐 ----------

const tpl = { schema_version: "1.0", ...derived };

for (const f of CHAIN_FIELDS) {
  const v = arg(flagOf(f));
  if (v === undefined) continue;
  // 数字字段要转，否则形状校验会把 "900000" 判成配错（那正是它该做的）。
  tpl[f] = f.endsWith("_ms") ? Number(v) : v;
  sources[f] = "命令行";
}

// 有合理默认值的两个：不写就用默认，省掉两次手抄。
if (tpl.default_freshness_ms === undefined) {
  tpl.default_freshness_ms = 15 * 60 * 1000;
  sources.default_freshness_ms = "默认";
}
if (tpl.lark_cli_bin === undefined) {
  for (const c of ["/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli"]) {
    if (fs.existsSync(c)) { tpl.lark_cli_bin = c; sources.lark_cli_bin = "自动探测"; break; }
  }
}

// 出站凭据的配置目录基路径。默认指向 aily 放各 agent 配置的地方 ——
// 单智能体方案靠「基路径 + agent_uid」推出目录，所以布局变了只用改这一个字段。
if (tpl.lark_cli_config_base === undefined) {
  tpl.lark_cli_config_base = DEFAULT_CONFIG_BASE;
  sources.lark_cli_config_base = "默认";
}

// 桥仓库自己的位置：接入命令和 /init 钩子都要靠它找到 scripts/。
tpl.bridge_root = ROOT;

const check = validateChainTemplate(tpl);

// ---------- 3. 报告 ----------

// 屏显打码：这些是身份标识，没有理由在终端里出现全文，更没有理由被转发到飞书。
const mask = (v) => {
  const s = String(v);
  if (typeof v === "number" || typeof v === "boolean") return s;
  return s.length <= 10 ? s : s.slice(0, 6) + "…" + s.slice(-3) + "（" + s.length + " 字符）";
};

console.log("模板    " + templatePath());
if (from !== undefined) console.log("派生自  " + path.resolve(from));
console.log("");
for (const f of CHAIN_FIELDS) {
  const has = tpl[f] !== undefined && tpl[f] !== null && tpl[f] !== "";
  const src = has ? "  ← " + (sources[f] ?? "?") : "";
  console.log("  " + (has ? "✓" : "✗") + " " + f.padEnd(24) + (has ? mask(tpl[f]) : "缺  用 --" + flagOf(f)) + src);
}

if (!check.ok) {
  console.error("\n模板不完整，没有落盘。");
  if (check.missing.length) {
    console.error("  缺字段：" + check.missing.map((f) => "--" + flagOf(f)).join(" "));
  }
  if (check.malformed.length) console.error("  形状不对：" + check.malformed.join(", "));
  for (const m of check.inconsistent ?? []) console.error("  前后矛盾：" + m);
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
console.log("下一步：node scripts/install-outbound.mjs --apply，然后在项目目录里 /init。");
