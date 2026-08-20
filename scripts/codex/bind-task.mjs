#!/usr/bin/env node
/** 把一个精确 Codex thread 建成独立飞书话题；同一项目允许多个 task。 */

import fs from "node:fs";
import path from "node:path";

import { resolveLarkIdentity } from "../chain-template.mjs";
import { publishDraft, sendToChat } from "../outbound.mjs";
import { composeCodexBinding, displayThread, resolveThreadId } from "./bind-compose.mjs";
import {
  addTask, findRegisteredTaskForCodexThread, loadCodexTemplate, makeTaskEntry,
  setTaskConnectionStatus,
} from "./state.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const root = path.resolve(arg("project") ?? process.cwd());
const die = (message) => { console.error(message); process.exit(1); };
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

const thread = resolveThreadId({ explicit: arg("thread-id"), root });
if (!thread.ok) die("无法确定当前 Codex thread（" + thread.reason + "），拒绝猜测或使用 --last。");
const existing = findRegisteredTaskForCodexThread({ threadId: thread.threadId });
if (existing.ok) {
  if ((existing.task.status ?? "active") === "active") {
    console.log("这个 Codex task 已接入，没有重复建话题：" + existing.task.task_display_name);
    process.exit(0);
  }
  console.log("这个 Codex task 的飞书接入已暂停；恢复会复用原话题，不会向飞书发送消息。");
  if (!apply) {
    console.log("[dry-run] 没有修改登记表。加 --apply 才恢复接入。");
    process.exit(0);
  }
  const resumed = setTaskConnectionStatus({ threadId: thread.threadId, status: "active" });
  if (!resumed.ok) die("恢复接入失败：" + resumed.reason + (resumed.error ? "（" + resumed.error + "）" : ""));
  console.log("已恢复当前 Codex task 的飞书接入，继续使用原话题。");
  process.exit(0);
}
const tpl = loadCodexTemplate();
if (!tpl.ok) die("Codex 单智能体模板不可用（" + tpl.reason + "）");
const d = composeCodexBinding({ root, threadId: thread.threadId, nameOverride: arg("name") });

console.log("任务      " + d.name + "  " + d.logicalTaskKey);
console.log("Codex     " + displayThread(thread.threadId));
console.log("群        " + tpl.template.chat_name);
console.log("唯一身份  " + tpl.template.transport_agent_name);
console.log("\n--- 根消息 ---\n" + d.rootText);
console.log("\n--- 底下第一条 ---\n" + d.statusText);
if (!apply) {
  console.log("\n[dry-run] 没有发送，也没有写登记表。加 --apply 才真的执行。");
  process.exit(0);
}

const identity = resolveLarkIdentity(tpl.template);
let rootMessageId;
try {
  rootMessageId = sendToChat({
    profile: identity.profile,
    chatId: tpl.template.chat_id,
    text: d.rootText,
    idempotencyKey: d.idempotencyKey,
    larkBin: identity.bin,
    larkHome: identity.configDir,
    expectedAppId: identity.expectedAppId,
  });
} catch (err) {
  die("建话题失败，没有写登记表：" + err.message);
}

const task = makeTaskEntry({
  root,
  threadId: thread.threadId,
  name: d.name,
  purpose: d.purpose,
  rootMessageId,
  token: d.token,
  inboundPrefix: tpl.template.inbound_prefix,
});
const added = addTask(task);
if (!added.ok) die("话题已建，但登记表没写成：" + added.reason +
  (added.error ? "（" + added.error + "）" : "") + "。重跑会命中平台幂等键，不会重建话题。");

try {
  publishDraft({
    profile: identity.profile,
    rootMessageId,
    text: d.statusText,
    larkBin: identity.bin,
    larkHome: identity.configDir,
    expectedAppId: identity.expectedAppId,
  });
  console.log("已接入并发布状态回复。去新话题真实 @ M5Codex 一下完成绑定；后续不需要关键字前缀。");
} catch (err) {
  console.error("登记已完成，但状态回复失败：" + err.message);
}
