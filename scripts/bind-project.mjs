#!/usr/bin/env node
/**
 * 把一个项目接进飞书 —— 每个项目一辈子一次。
 *
 * 接入只产生**一条新事实**：这个项目的话题是哪条根消息。
 * 群、发布身份、profile、授权发送者这些都是机器级的，装的时候配一次
 * （`~/.claude/feishu-bridge/chain-config.json`）；项目叫什么、干什么，CLAUDE.md 里就有。
 * 所以这条命令做的事是：建根话题 → 往登记表加一行。**项目目录里一个文件都不写。**
 *
 * 上一版会在每个新项目里造两个配置文件、38 个字段，其中 33 个是机器级事实的复制品。
 * 复制品越多，改一次配置要同步的地方越多，而不同步时没有任何东西会报错。
 * 收敛靠 project-resolve.mjs：读取方先看项目目录，没有就回落到机器模板 + 登记表那一行。
 *
 * 用法：
 *   node scripts/bind-project.mjs                       # 看会做什么，不发不写
 *   node scripts/bind-project.mjs --apply
 *   node scripts/bind-project.mjs --project ~/x --name "显示名" --apply
 */

import fs from "node:fs";
import path from "node:path";

import { loadChainTemplate } from "./chain-template.mjs";
import { registryPath } from "./registry.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
  newRegistryEntry, readProjectIdentity,
} from "./bind-compose.mjs";

// ---------- CLI ----------

if (import.meta.url === "file://" + process.argv[1]) {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");

const root = path.resolve(arg("project") ?? process.cwd());

const die = (msg, hint) => {
  console.error(msg);
  if (hint) console.error(hint);
  process.exit(1);
};

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

const tpl = loadChainTemplate();
if (!tpl.ok) {
  if (tpl.reason === "no_template") {
    die("还没有机器级链路模板：" + tpl.file,
      "先从一个已接好的项目生成一份：\n  node scripts/init-chain-template.mjs --chat-id oc_xxx --apply");
  }
  die("链路模板不可用（" + tpl.reason + "）：" + tpl.file,
    [tpl.error, tpl.missing?.length ? "缺字段：" + tpl.missing.join(", ") : null,
     tpl.malformed?.length ? "形状不对：" + tpl.malformed.join(", ") : null].filter(Boolean).join("\n"));
}
const template = tpl.template;

// ---------- 已经接过就到此为止 ----------
// 重复建话题是这条命令唯一能造成的不可撤销的破坏。

const regFile = registryPath();
let registry = { schema_version: "1.0", projects: [] };
try {
  registry = JSON.parse(fs.readFileSync(regFile, "utf-8"));
  registry.projects ??= [];
} catch { /* 没有登记表就新建 */ }

const at = registry.projects.findIndex((p) => p?.root === root);
const already = at >= 0 ? registry.projects[at] : null;
const legacyMapping = path.join(root, ".runtime-data", "inbound", "active-mapping.json");

if (already?.root_message_id || fs.existsSync(legacyMapping)) {
  console.log(path.basename(root) + " 已经接入过了，没有重复建话题。");
  if (already?.root_message_id) {
    console.log("  根话题  " + already.root_message_id);
    console.log("  入站    " + (already.inbound_state === "bound" ? "已绑定" : "待绑定"));
  } else {
    console.log("  绑定在项目目录里（老形式）：" + legacyMapping);
  }
  console.log("看绑定详情：node scripts/binding.mjs");
  process.exit(0);
}

const identity = readProjectIdentity({ root });
const name = arg("name") ?? identity.name;
const purpose = identity.purpose;
const token = bindingToken(root);
const idemKey = idempotencyKeyFor(root);
const rootText = composeRootMessage({ name, purpose, root, token });

const statusText = composeStatusMessage({ name });

console.log("项目    " + name + "  " + root);
console.log("名字来源" + "  " + (arg("name") ? "命令行 --name" : identity.source === "dirname" ? "目录名（没找到 CLAUDE.md 标题）" : identity.source));
console.log("群      " + template.chat_name + "  " + template.chat_id);
console.log("身份    " + template.outbound_agent_name + "（profile " + template.lark_cli_profile + "）");
console.log("\n--- 根消息 ---\n" + rootText);
console.log("\n--- 底下第一条 ---\n" + statusText);
console.log("\n只写一处：" + regFile + "（项目目录里不写任何文件）");

if (!apply) {
  console.log("\n[dry-run] 没有发消息，也没有写文件。加 --apply 才真的做。");
  process.exit(0);
}

// 1. 建话题。失败就什么都不写 —— 干净重来，不留半个状态。
let rootMessageId;
try {
  rootMessageId = sendToChat({
    profile: template.lark_cli_profile, chatId: template.chat_id, text: rootText,
    idempotencyKey: idemKey, larkBin: template.lark_cli_bin, larkHome: template.lark_cli_home,
  });
} catch (err) {
  die("建话题失败，没有写任何文件：" + err.message);
}
console.log("\n根话题已建立  " + rootMessageId);

// 2. 登记。到这一步话题已经在群里了，所以这里失败不能静默 ——
//    重跑会命中平台侧幂等键，不会多建一个话题。
const entry = newRegistryEntry({ root, name, purpose, token, rootMessageId });
if (at >= 0) registry.projects[at] = { ...registry.projects[at], ...entry };
else registry.projects.push(entry);

try {
  fs.mkdirSync(path.dirname(regFile), { recursive: true, mode: 0o700 });
  if (fs.existsSync(regFile)) fs.copyFileSync(regFile, regFile + ".prev");
  const tmp = regFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, regFile);
} catch (err) {
  die("话题建好了（" + rootMessageId + "）但登记没写成：" + err.message,
    "修好权限后重跑同一条命令即可，幂等键保证不会多建一个话题。");
}
console.log("已登记        " + regFile + "  （现在 " + registry.projects.length + " 个项目）");

// 3. 发状态回复。走 publishDraft，也就是出站平时走的那条路径 —— 它到了话题里，
//    出站就是真的通了，不是我说通了。
try {
  const statusId = publishDraft({
    profile: template.lark_cli_profile, rootMessageId, text: statusText,
    larkBin: template.lark_cli_bin, larkHome: template.lark_cli_home,
  });
  console.log("状态已发布    " + statusId);
} catch (err) {
  console.error("状态回复没发出去：" + err.message);
  console.error("接入本身已完成（登记写好了），只是这条验证消息没发成。");
}

console.log("\n" + name + " 已接入。项目里下一轮会话结束时，回答会自动发到这个话题。");
console.log("入站还差最后一下：去那个话题里 @ 一下运输 agent（空消息也行），绑定就完成了。");
}
