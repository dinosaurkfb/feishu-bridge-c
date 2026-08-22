#!/usr/bin/env node
/** 为当前 Codex task 创建下一话题代际。默认只预览，--apply 才写状态并调用飞书。 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
} from "../bind-compose.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { publishDraft, sendToChat } from "../outbound.mjs";
import { resolveThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, failTaskTopicRotation, findRegisteredTaskForCodexThread,
  closeTaskTopicRotation, loadCodexTemplate, prepareTaskTopicRotation, registerTaskTopicRotation,
  topicStateForTask,
} from "./state.mjs";
import {
  ROTATION_STATUS, activeGeneration, pendingGeneration,
} from "../topic-generation.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (message) => { console.error(message); process.exit(1); };
const apply = process.argv.includes("--apply");
const cancel = process.argv.includes("--cancel");
const root = path.resolve(arg("project") ?? process.cwd());
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);
const thread = resolveThreadId({ explicit: arg("thread-id"), root });
if (!thread.ok) die("无法确定当前 Codex task（" + thread.reason + "）。");
const found = findRegisteredTaskForCodexThread({ threadId: thread.threadId });
if (!found.ok) die("当前 Codex task 尚未接入飞书。");
const task = found.task;
const loaded = topicStateForTask(task);
if (!loaded.ok) die("当前 task 的 topic generation 状态不可用（" + loaded.reason + "）。");
const active = activeGeneration(loaded.state);
if (!active) die("当前 task 没有 active generation，不能开始轮转。");
const pending = pendingGeneration(loaded.state);
if (cancel) {
  if (!pending || !loaded.state.rotation?.operation_id) die("当前没有等待认领的话题代际可取消。");
  console.log("任务      " + task.task_display_name);
  console.log("保留代际  " + active.generation + "（继续 active）");
  console.log("取消代际  " + pending.generation + "（话题历史保留，不再接受认领）");
  if (!apply) {
    console.log("\n[dry-run] 没有修改状态。加 --cancel --apply 才取消待认领代际。");
    process.exit(0);
  }
  const closed = closeTaskTopicRotation({
    threadId: thread.threadId,
    operationId: loaded.state.rotation.operation_id,
    reason: ROTATION_STATUS.CANCELLED,
    home: bridgeHome(),
  });
  if (!closed.ok) die("取消轮转失败（" + closed.reason + "）。");
  console.log("已取消待认领代际；旧话题仍是唯一 active，未删除任何飞书历史。");
  process.exit(0);
}
if (pending) die("已有等待认领的话题代际；请先完成认领或显式取消，不能重复创建。");
const nextNumber = Math.max(...loaded.state.generations.map((generation) => generation.generation)) + 1;
const token = bindingToken(loaded.state.binding_id + "\n" + nextNumber);
const name = task.task_display_name;
const rootText = composeRootMessage({
  name,
  heading: name + " · 第 " + nextNumber + " 代",
  purpose: "同一 Codex task 的新话题代际；旧话题保留为只读历史。",
  root: task.root,
  token,
});
const statusText = composeStatusMessage({ name });

console.log("任务      " + name);
console.log("当前代际  " + active.generation);
console.log("新代际    " + nextNumber + "（等待首次真实 mention 后才切换）");
console.log("\n--- 新根消息 ---\n" + rootText);
if (!apply) {
  console.log("\n[dry-run] 没有创建话题或修改状态。加 --apply 才执行两阶段轮转。");
  process.exit(0);
}

const operationId = "rotation_" + randomUUID();
const home = bridgeHome();
const prepared = prepareTaskTopicRotation({
  threadId: thread.threadId, operationId, home,
});
if (!prepared.ok) die("无法开始轮转（" + prepared.reason + "）。");
const template = loadCodexTemplate();
if (!template.ok) {
  failTaskTopicRotation({ threadId: thread.threadId, operationId, reason: template.reason, home });
  die("Codex 链路模板不可用（" + template.reason + "）。");
}
const identity = resolveLarkIdentity(template.template);
let rootMessageId;
try {
  rootMessageId = sendToChat({
    profile: identity.profile,
    chatId: task.chat_id ?? template.template.chat_id,
    text: rootText,
    idempotencyKey: idempotencyKeyFor(loaded.state.binding_id + "\nrotation\n" + nextNumber),
    larkBin: identity.bin,
    larkHome: identity.configDir,
    expectedAppId: identity.expectedAppId,
  });
} catch (err) {
  failTaskTopicRotation({ threadId: thread.threadId, operationId, reason: err.message, home });
  die("新话题创建失败；旧代际保持 active：" + err.message);
}
const registered = registerTaskTopicRotation({
  threadId: thread.threadId,
  operationId,
  rootMessageId,
  pendingToken: token,
  home,
});
if (!registered.ok) {
  die("新话题已创建，但 pending generation 登记失败（" + registered.reason + "）。旧代际仍保持 active。");
}
try {
  publishDraft({
    profile: identity.profile,
    rootMessageId,
    text: statusText,
    larkBin: identity.bin,
    larkHome: identity.configDir,
    expectedAppId: identity.expectedAppId,
  });
} catch (err) {
  console.error("pending generation 已登记，但状态回复发送失败：" + err.message);
}
console.log("新话题已进入 pending。去新话题真实 @ M5Codex 后，将原子切换为 active；旧话题变为只读历史。");
