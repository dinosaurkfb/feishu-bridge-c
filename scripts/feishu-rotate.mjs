#!/usr/bin/env node
/** 为当前 Claude binding 创建下一话题代际。默认只预览，--apply 才写状态并调用飞书。 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
} from "./bind-compose.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import {
  closeClaudeTopicRotation, failClaudeTopicRotation, loadClaudeTopicBinding, prepareClaudeTopicRotation,
  registerClaudeTopicRotation,
} from "./topic-generation-store.mjs";
import {
  ROTATION_STATUS, activeGeneration, pendingGeneration,
} from "./topic-generation.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (message) => { console.error(message); process.exit(1); };
const apply = process.argv.includes("--apply");
const cancel = process.argv.includes("--cancel");
const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = arg("claude-session-id") ??
  process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

const current = loadClaudeTopicBinding({ root, claudeSessionId });
if (!current.ok || !current.config) die("当前 Claude binding 不可轮转（" + (current.reason ?? "config_unusable") + "）");
const active = activeGeneration(current.state);
if (!active) die("当前 binding 没有 active generation，不能开始轮转。");
const pending = pendingGeneration(current.state);
if (cancel) {
  if (!pending || !current.state.rotation?.operation_id) die("当前没有等待认领的话题代际可取消。");
  console.log("绑定      " + (current.config.task_display_name ?? path.basename(root)));
  console.log("保留代际  " + active.generation + "（继续 active）");
  console.log("取消代际  " + pending.generation + "（话题历史保留，不再接受认领）");
  if (!apply) {
    console.log("\n[dry-run] 没有修改状态。加 --cancel --apply 才取消待认领代际。");
    process.exit(0);
  }
  const closed = closeClaudeTopicRotation({
    root,
    claudeSessionId,
    operationId: current.state.rotation.operation_id,
    reason: ROTATION_STATUS.CANCELLED,
  });
  if (!closed.ok) die("取消轮转失败（" + closed.reason + "）。");
  console.log("已取消待认领代际；旧话题仍是唯一 active，未删除任何飞书历史。");
  process.exit(0);
}
if (pending) die("已有等待认领的话题代际；请先完成认领或显式取消，不能重复创建。");
const nextNumber = Math.max(...current.state.generations.map((generation) => generation.generation)) + 1;
const token = bindingToken(current.state.binding_id + "\n" + nextNumber);
const name = current.config.task_display_name ?? path.basename(root);
const rootText = composeRootMessage({
  name,
  heading: name + " · 第 " + nextNumber + " 代",
  purpose: "同一长期任务的新话题代际；旧话题保留为只读历史。",
  root,
  token,
});
const statusText = composeStatusMessage({ name });

console.log("绑定      " + name);
console.log("当前代际  " + active.generation);
console.log("新代际    " + nextNumber + "（等待首次真实 mention 后才切换）");
console.log("\n--- 新根消息 ---\n" + rootText);
if (!apply) {
  console.log("\n[dry-run] 没有创建话题或修改状态。加 --apply 才执行两阶段轮转。");
  process.exit(0);
}

const operationId = "rotation_" + randomUUID();
const prepared = prepareClaudeTopicRotation({ root, claudeSessionId, operationId });
if (!prepared.ok) die("无法开始轮转（" + prepared.reason + "）。");

const identity = resolveLarkIdentity(current.config);
let rootMessageId;
try {
  rootMessageId = sendToChat({
    profile: identity.profile,
    chatId: current.config.chat_id,
    text: rootText,
    idempotencyKey: idempotencyKeyFor(current.state.binding_id + "\nrotation\n" + nextNumber),
    larkBin: identity.bin,
    larkHome: identity.configDir,
    expectedAppId: identity.expectedAppId,
  });
} catch (err) {
  failClaudeTopicRotation({ root, claudeSessionId, operationId, reason: err.message });
  die("新话题创建失败；旧代际保持 active：" + err.message);
}

const registered = registerClaudeTopicRotation({
  root, claudeSessionId, operationId, rootMessageId, pendingToken: token,
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
console.log("新话题已进入 pending。去新话题真实 @ M5Claude 后，将原子切换为 active；旧话题变为只读历史。");
