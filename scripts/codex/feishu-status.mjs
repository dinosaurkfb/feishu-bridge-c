#!/usr/bin/env node
/** 只读查看当前精确 Codex thread 的飞书连接状态；不输出任何 locator。 */

import { listPending } from "../outbox.mjs";
import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, findRegisteredTaskForCodexThread, taskPaths,
} from "./state.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const threadId = arg("thread-id");
if (!validThreadId(threadId)) {
  console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
  process.exit(1);
}

const home = bridgeHome();
const found = findRegisteredTaskForCodexThread({ threadId, home });
if (!found.ok) {
  if (found.reason === "thread_not_registered") {
    console.log("当前 Codex task 尚未接入飞书。");
    process.exit(0);
  }
  console.error("无法读取连接状态：" + found.reason);
  process.exit(1);
}

const task = found.task;
const active = (task.status ?? "active") === "active";
const pending = listPending({ outboxDir: taskPaths(task, home).outbox }).length;
console.log("当前 Codex task：" + (active ? "已接入飞书" : "已暂停飞书接入"));
console.log("飞书入站：" + (active
  ? (task.inbound_state === "bound" ? "已绑定" : "等待首次真实 @M5Codex")
  : "已暂停"));
console.log("答复发布：" + (active
  ? (task.auto_publish_on_completion === true ? "每轮自动发布（失败时留队）" : "仅入队，自动发布尚未启用")
  : "已暂停"));
console.log("待发布答复：" + pending + " 条" + (active ? "" : "（已保留）"));
