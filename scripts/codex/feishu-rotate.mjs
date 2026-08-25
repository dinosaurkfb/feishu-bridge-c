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
  TOPIC_GENERATION_PREPARING_STALE_MS,
} from "../topic-generation.mjs";
import { requireIntent } from "./intent.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (message) => { console.error(message); process.exit(1); };
const apply = process.argv.includes("--apply");
const cancel = process.argv.includes("--cancel");
const automatic = process.argv.includes("--automatic");
const root = path.resolve(arg("project") ?? process.cwd());
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);
const thread = resolveThreadId({ explicit: arg("thread-id"), root });
if (!thread.ok) die("无法确定当前 Codex task（" + thread.reason + "）。");

// **一次性意图凭证，在任何副作用之前消费。**
// 技能选择这一层不受钩子判据约束 —— agent 之间提一句命令就可能把它执行掉
// （出过真事故）。凭证把"技能被选中"和"这次操作被授权"分开。
// **三种情形各自授权，不是一张通票。**
//
//   自动轮转 —— 发布器数到阈值自己决定的，由**它**签字（rotate:auto）；
//   人工创建 —— 用户敲了命令，hook 签字（rotate，params 里带 create）；
//   人工取消 —— 同上，但 params 里带 cancel。
//
// 上一版三种共用一张 "rotate" 票：一张创建票能拿去取消，
// 而 --automatic 干脆没有签发入口、被整条卡死。
// **"授权了这一类操作"不是授权。**
const rotateAction = automatic ? "rotate:auto" : "rotate";
const rotateParams = automatic
  ? { project: root }
  : { op: cancel ? "cancel" : "create" };
const intent = requireIntent({
  apply, action: rotateAction, threadId: thread.threadId, params: rotateParams,
  home: bridgeHome(),
});
if (!intent.ok) die(intent.text);

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
const automaticThreshold = active.activity?.auto_rotate_threshold ?? 30;
const rootText = composeRootMessage({
  name,
  heading: name + " · 第 " + nextNumber + " 代",
  purpose: automatic
    ? "当前代际已达到 " + automaticThreshold + " 条有效业务消息；这是同一 Codex task 的下一话题代际，旧话题保留为只读历史。"
    : "同一 Codex task 的新话题代际；旧话题保留为只读历史。",
  root: task.root,
  token,
});
const statusText = composeStatusMessage({ name });

console.log("任务      " + name);
console.log("当前代际  " + active.generation);
console.log("新代际    " + nextNumber + "（" +
  (automatic ? "自动阈值触发；" : "") + "等待首次真实 mention 后才切换）");
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
  // **失败要收口，而且收口本身也可能失败。**
  //
  // 两处教训叠在一起：
  //   同一函数里两个相邻失败出口，上面 sendToChat 那条收口了，这条原来只 die 就走人；
  //   而收口调用自己也会因写入失败、锁竞争或 operation mismatch 返回 false ——
  //   不看返回值就宣布"已收口"，等于生成一份虚假的完成回执，
  //   而真实状态可能仍停在 PREPARING。要让人知道何时可以重试。
  const closed = failTaskTopicRotation({
    threadId: thread.threadId, operationId, reason: registered.reason, home,
  });
  die("新话题已创建，但 pending generation 登记失败（" + registered.reason + "）。" +
    (closed.ok
      ? "轮转已收口，旧代际仍保持 active；新建的那个话题需要人工清理。"
      : "**收口也失败了（" + closed.reason + "）**：轮转状态可能仍停在 preparing。" +
        "旧代际保持 active。若状态仍停在 preparing，" +
        Math.round(TOPIC_GENERATION_PREPARING_STALE_MS / 60000) +
        " 分钟后可由下一次轮转接管；若已进入 awaiting_claim，则去新话题真实 @ 完成认领。" +
        "新建的那个话题需要人工清理。"));
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
