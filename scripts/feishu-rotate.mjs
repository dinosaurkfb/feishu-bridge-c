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
  ROTATION_STATUS, TOPIC_GENERATION_PREPARING_STALE_MS,
  activeGeneration, pendingGeneration,
} from "./topic-generation.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (message) => { console.error(message); process.exit(1); };
const apply = process.argv.includes("--apply");
const cancel = process.argv.includes("--cancel");
const automatic = process.argv.includes("--automatic");
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
const automaticThreshold = active.activity?.auto_rotate_threshold ?? 30;
const rootText = composeRootMessage({
  name,
  heading: name + " · 第 " + nextNumber + " 代",
  purpose: automatic
    ? "当前代际已达到 " + automaticThreshold + " 条有效业务消息；这是同一长期任务的下一话题代际，旧话题保留为只读历史。"
    : "同一长期任务的新话题代际；旧话题保留为只读历史。",
  root,
  token,
});
const statusText = composeStatusMessage({ name });

console.log("绑定      " + name);
console.log("当前代际  " + active.generation);
console.log("新代际    " + nextNumber + "（" +
  (automatic ? "自动阈值触发；" : "") + "等待首次真实 mention 后才切换）");
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
  // **失败要收口，而且收口本身也可能失败。**
  //
  // 两处教训叠在一起：
  //   同一函数里两个相邻失败出口，上面 sendToChat 那条收口了，这条原来只 die 就走人；
  //   而收口调用自己也会因写入失败、锁竞争或 operation mismatch 返回 false ——
  //   不看返回值就宣布"已收口"，等于生成一份虚假的完成回执，
  //   而真实状态可能仍停在 PREPARING。要让人知道何时可以重试。
  const closed = failClaudeTopicRotation({
    root, claudeSessionId, operationId, reason: registered.reason,
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
console.log("新话题已进入 pending。去新话题真实 @ M5Claude 后，将原子切换为 active；旧话题变为只读历史。");
