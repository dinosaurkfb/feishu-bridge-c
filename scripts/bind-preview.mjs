#!/usr/bin/env node
/**
 * 只打印「接入这个项目会发出什么」—— 不发消息、不写文件、不联网。
 *
 * 为什么要单独一个入口，而不是给 bind-project 加个 --dry-run（它本来就有）：
 * 这个入口是要进权限白名单的。放进白名单的东西，它**做不到**发消息这件事必须是
 * 代码层面的事实，不能是一个自觉遵守的开关 —— 开关会被参数写错、被拼错、被绕过。
 *
 * 所以它的依赖图里没有 outbound.mjs：
 *
 *   bind-preview → bind-compose（纯函数）+ chain-template（读一个 JSON）
 *   bind-project → 上面这些 + outbound（lark-cli / execFileSync）
 *
 * 有一条测试专门盯着这件事，别在这里 import 任何能发东西的模块。
 *
 * 用法：
 *   node scripts/bind-preview.mjs                  # 看当前目录
 *   node scripts/bind-preview.mjs --project ~/x
 */

import fs from "node:fs";
import path from "node:path";

import { loadChainTemplate } from "./chain-template.mjs";
import {
  bindingToken, composeRootMessage, composeStatusMessage, readProjectIdentity,
} from "./bind-compose.mjs";

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const root = path.resolve(arg("project") ?? process.cwd());

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("项目目录不存在：" + root);
  process.exit(1);
}

const tpl = loadChainTemplate();
if (!tpl.ok) {
  console.error("机器级链路模板不可用（" + tpl.reason + "）：" + tpl.file);
  console.error("这台机器可能还没装桥。生成模板：node scripts/init-chain-template.mjs --chat-id oc_xxx --apply");
  process.exit(1);
}
const template = tpl.template;

const identity = readProjectIdentity({ root });
const name = arg("name") ?? identity.name;
const token = bindingToken(root);

console.log("项目      " + name + "  " + root);
console.log("名字来源  " + (arg("name") ? "命令行 --name"
  : identity.source === "dirname" ? "目录名（README/CLAUDE.md 里没有可用的一级标题）"
  : identity.source));
console.log("群        " + template.chat_name + "  " + template.chat_id);
console.log("身份      " + template.outbound_agent_name + "（profile " + template.lark_cli_profile + "）");

console.log("\n--- 根消息（发出去就改不了）---\n" +
  composeRootMessage({ name, purpose: identity.purpose, root, token }));
console.log("\n--- 底下第一条（之后的回复可以盖掉它）---\n" +
  composeStatusMessage({ name, inboundReady: false }));

console.log("\n这条命令什么都没做。真的建话题要跑：");
console.log("  node " + path.join(path.dirname(new URL(import.meta.url).pathname)) +
  "/bind-project.mjs --project " + root + " --apply");
