#!/usr/bin/env node
/** 把一个精确 Codex thread 建成独立飞书话题；同一项目允许多个 task。 */

import fs from "node:fs";
import path from "node:path";

import { resolveLarkIdentity } from "../chain-template.mjs";
import { publishDraft, sendToChat } from "../outbound.mjs";
import {
  composeCodexBinding, displayThread, resolveBindingTarget, resolveThreadId,
} from "./bind-compose.mjs";
import { updateTextMessage } from "./lark-message.mjs";
import {
  addTask, bridgeHome, findRegisteredTaskForCodexThread, loadCodexTemplate, makeTaskEntry,
  refreshPendingTaskBinding, setTaskConnectionStatus, setTaskDisplayName,
} from "./state.mjs";
import { requireIntent } from "../intent.mjs";

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

// **一次性意图凭证，在任何副作用之前消费。**
//
// 出过真事故：一条 agent 之间的消息里提到了这个命令，绑定技能就被选中、
// 直接来跑真实绑定。技能描述里写着"讨论和引用不得触发"，钩子的判据也是
// 整条精确匹配 —— **但技能选择这一层不受那条判据约束**。
// 凭证把"技能被选中"和"这次操作被授权"分开：只有人亲自输入完整命令时，
// 钩子才签发一张，用完即焚。
const intent = requireIntent({
  apply, action: "bind", threadId: thread.threadId,
  params: { project: root }, home: bridgeHome() });
if (!intent.ok) die(intent.text);
const existing = findRegisteredTaskForCodexThread({ threadId: thread.threadId });
if (existing.ok) {
  if ((existing.task.status ?? "active") === "active") {
    const awaitingFirstMention = existing.task.inbound_state === "pending" && !existing.task.session_id;
    const d = composeCodexBinding({
      root: existing.task.root, threadId: thread.threadId, nameOverride: arg("name"),
    });
    if (awaitingFirstMention && !apply) {
      console.log("这个 Codex task 已建好原话题，但首次 mention 的握手窗口需要刷新。");
      console.log("[dry-run] 没有修改登记表，也没有发送或编辑飞书消息。加 --apply 才续期。");
      process.exit(0);
    }
    if (awaitingFirstMention) {
      const refreshed = refreshPendingTaskBinding({ threadId: thread.threadId });
      if (!refreshed.ok) die("刷新首次绑定窗口失败：" + refreshed.reason +
        (refreshed.error ? "（" + refreshed.error + "）" : ""));
      console.log("已复用原话题并刷新首次绑定窗口；请在该话题真实 @ M5Codex 完成绑定。");
    }
    if (existing.task.task_display_name === d.name) {
      if (!awaitingFirstMention) {
        console.log("这个 Codex task 已接入，没有重复建话题：" + existing.task.task_display_name);
      }
      process.exit(0);
    }
    console.log("这个 Codex task 已接入；检测到旧话题名需要升级。");
    console.log("旧名称    " + existing.task.task_display_name);
    console.log("新名称    " + d.name);
    console.log("新首行    " + d.rootText.split("\n")[0]);
    if (!apply) {
      console.log("[dry-run] 没有编辑飞书消息，也没有修改登记表。加 --apply 才执行。");
      process.exit(0);
    }
    const tpl = loadCodexTemplate();
    if (!tpl.ok) die("Codex 单智能体模板不可用（" + tpl.reason + "）");
    const identity = resolveLarkIdentity(tpl.template);
    try {
      updateTextMessage({
        profile: identity.profile,
        messageId: existing.task.root_message_id,
        text: d.rootText,
        larkBin: identity.bin,
        larkHome: identity.configDir,
        expectedAppId: identity.expectedAppId,
      });
    } catch (err) {
      if (awaitingFirstMention) {
        console.error("首次绑定窗口已刷新，但旧话题标题无法同步：" + err.message);
        console.error("这不影响在原话题完成首次 @M5Codex 握手。");
        process.exit(0);
      }
      die("旧话题改名失败，登记表没有修改：" + err.message);
    }
    const renamed = setTaskDisplayName({ threadId: thread.threadId, name: d.name });
    if (!renamed.ok) {
      die("飞书话题已改名，但本地登记更新失败：" + renamed.reason +
        (renamed.error ? "（" + renamed.error + "）" : "") + "。可安全重跑本命令修复登记。");
    }
    console.log("已更新原飞书话题名称，没有创建第二个话题。");
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
const target = resolveBindingTarget({
  template: tpl.template,
  chatId: arg("chat-id"),
  chatName: arg("chat-name"),
});
if (!target.ok) die("无法确定绑定目标群（" + target.reason + "）");
const d = composeCodexBinding({
  root,
  threadId: thread.threadId,
  nameOverride: arg("name"),
  idempotencyScope: target.overridden ? target.chatId : undefined,
});

console.log("任务      " + d.name + "  " + d.logicalTaskKey);
console.log("Codex     " + displayThread(thread.threadId));
console.log("群        " + target.chatName);
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
    chatId: target.chatId,
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
  chatId: target.chatId,
  chatName: target.chatName,
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
