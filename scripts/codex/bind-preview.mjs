#!/usr/bin/env node
/** 只读预览：依赖图里没有 outbound，因此代码层面无法发送飞书消息。 */

import fs from "node:fs";
import path from "node:path";

import { composeCodexBinding, displayThread, resolveThreadId } from "./bind-compose.mjs";
import { findRegisteredTaskForCodexThread, loadCodexTemplate } from "./state.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const root = path.resolve(arg("project") ?? process.cwd());
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("项目目录不存在：" + root);
  process.exit(1);
}
const thread = resolveThreadId({ explicit: arg("thread-id"), root });
if (!thread.ok) {
  console.error("无法确定当前 Codex thread（" + thread.reason + "）。请从 hook 注入的上下文传 --thread-id。");
  process.exit(1);
}
const existing = findRegisteredTaskForCodexThread({ threadId: thread.threadId });
if (existing.ok) {
  if ((existing.task.status ?? "active") === "paused") {
    console.log("这个 Codex task 的飞书接入已暂停：" + existing.task.task_display_name);
    console.log("恢复后会继续使用原飞书话题，不会创建新话题，也不会向飞书发送消息。");
    console.log("运行 bind-task.mjs --apply 可恢复接入。");
  } else {
    console.log("这个 Codex task 已接入：" + existing.task.task_display_name);
    console.log("入站    " + (existing.task.inbound_state === "bound" ? "已绑定" : "待绑定"));
  }
  process.exit(0);
}
const tpl = loadCodexTemplate();
if (!tpl.ok) {
  console.error("Codex 单智能体模板不可用（" + tpl.reason + "）：" + tpl.file);
  process.exit(1);
}
const d = composeCodexBinding({ root, threadId: thread.threadId, nameOverride: arg("name") });
console.log("任务      " + d.name + "  " + d.logicalTaskKey);
console.log("项目      " + root);
console.log("Codex     " + displayThread(thread.threadId) + "（来源 " + thread.source + "）");
console.log("群        " + tpl.template.chat_name);
console.log("唯一身份  " + tpl.template.transport_agent_name);
console.log("入站关键字  无（只需真实 @M5Codex）");
console.log("\n--- 根消息（长期稳定）---\n" + d.rootText);
console.log("\n--- 底下第一条 ---\n" + d.statusText);
console.log("\n这条命令没有写文件、没有联网、没有发送。运行 bind-task.mjs --apply 可执行绑定。");
