#!/usr/bin/env node
/** 可恢复地暂停当前精确 Codex thread 的飞书连接；不调用飞书 API。 */

import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, findRegisteredTaskForCodexThread, setTaskConnectionStatus,
} from "./state.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const threadId = arg("thread-id");
const apply = process.argv.includes("--apply");
if (!validThreadId(threadId)) {
  console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
  process.exit(1);
}

const home = bridgeHome();
const found = findRegisteredTaskForCodexThread({ threadId, home });
if (!found.ok) {
  if (found.reason === "thread_not_registered") {
    console.log("当前 Codex task 尚未接入飞书，无需撤销。");
    process.exit(0);
  }
  console.error("无法读取连接状态：" + found.reason);
  process.exit(1);
}
if ((found.task.status ?? "active") === "paused") {
  console.log("当前 Codex task 的飞书接入已经暂停。");
  process.exit(0);
}

console.log("将暂停当前 Codex task 的飞书入站、答复入队和发布资格。");
console.log("原飞书话题、历史回执和待发布答复都会保留，可再次接入恢复。");
console.log("本操作不会向飞书发送消息，也不会删除飞书话题。");
if (!apply) {
  console.log("\n[dry-run] 没有修改登记表。加 --apply 才执行暂停。");
  process.exit(0);
}

const changed = setTaskConnectionStatus({ threadId, status: "paused", home });
if (!changed.ok) {
  console.error("暂停失败：" + changed.reason + (changed.error ? "（" + changed.error + "）" : ""));
  process.exit(1);
}
console.log("已暂停当前 Codex task 的飞书接入；原话题和本地历史均已保留。");
