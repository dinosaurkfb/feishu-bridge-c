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
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import {
  closeClaudeTopicRotation, failClaudeTopicRotation, loadClaudeTopicBinding, prepareClaudeTopicRotation,
  registerClaudeTopicRotation,
} from "./topic-generation-store.mjs";
import { wireRotate } from "./m1a/wiring.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import {
  ROTATION_STATUS, TOPIC_GENERATION_PREPARING_STALE_MS, activeGeneration, pendingGeneration, TOPIC_GENERATION_AUTO_ROTATE_MESSAGES, pendingRotationBlocker,
} from "./topic-generation.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (message) => { console.error(message); process.exit(1); };
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
const cancel = process.argv.includes("--cancel");
const automatic = process.argv.includes("--automatic");
const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = arg("claude-session-id") ??
  process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

let current = loadClaudeTopicBinding({ root, claudeSessionId });
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
const blocker = pendingRotationBlocker(current.state);
if (blocker.kind === "blocked") {
  die("已有等待认领的话题代际（第 " + blocker.pending.generation + " 代" + (blocker.deadline ? "，认领截止 " + blocker.deadline : "，不过期") +
    "）；去新话题 @ 完成认领，或 --cancel --apply 显式取消，不能重复创建。");
}
if (blocker.kind === "expired") {
  // 过期的待认领代际不再挡路：--apply 时在同一笔锁内退休它 + 准备 + 冻结下一代编号（话题历史保留），不用再单独取消一次
  console.log("过期代际  第 " + blocker.pending.generation + " 代（认领截止 " + blocker.deadline + " 已过）：本次在同一笔锁内作废它并建下一代，话题历史保留");
}
const name = current.config.task_display_name ?? path.basename(root);
const automaticThreshold = active.activity?.auto_rotate_threshold ?? TOPIC_GENERATION_AUTO_ROTATE_MESSAGES;
// 根消息与 token 只能用**锁内冻结**的下一代编号生成；dry-run 用当前状态算一个预告值
const plan = (nextNumber) => ({
  nextNumber,
  token: bindingToken(current.state.binding_id + "\n" + nextNumber),
  rootText: composeRootMessage({
    name,
    heading: name + " · 第 " + nextNumber + " 代",
    purpose: automatic
      ? "当前代际已达到 " + automaticThreshold + " 条有效业务消息；这是同一长期任务的下一话题代际，旧话题保留为只读历史。"
      : "同一长期任务的新话题代际；旧话题保留为只读历史。",
    root,
    token: bindingToken(current.state.binding_id + "\n" + nextNumber),
  }),
});
const statusText = composeStatusMessage({ name });
const expectedNext = Math.max(...current.state.generations.map((generation) => generation.generation)) + 1;

console.log("绑定      " + name);
console.log("当前代际  " + active.generation);
console.log("新代际    " + expectedNext + "（" +
  (automatic ? "自动阈值触发；" : "") + "等待首次真实 mention 后才切换；编号以 --apply 时锁内冻结的为准）");
console.log("\n--- 新根消息 ---\n" + plan(expectedNext).rootText);
if (!apply) {
  console.log("\n[dry-run] 没有创建话题或修改状态。加 --apply 才执行两阶段轮转。");
  process.exit(0);
}

const operationId = "rotation_" + randomUUID();
const identity = resolveLarkIdentity(current.config);

// M1a 双写（W3，Frank 拍板）：外层一致性锁在 sendToChat 之前取 —— 取不到 → 话题从未创建、无孤儿。
// 「准备 + 建话题 + 登记 pending」是同一 legacy 闭包，锁覆盖整笔写事务；shadow create_b1 在锁内镜像。
const wired = wireRotate({
  endpointId: legacyEndpointId({ runtime: "claude", agentUid: current.config.agent_uid }),
  env: process.env,
  rotationOpId: operationId,
  lineageId: current.state.binding_id,
  chatId: current.config.chat_id,
  bindingTarget: { runtime: "claude", project_root: root, claude_session_id: claudeSessionId },
  rootOm: null, // 取 legacy 闭包返回的 root_message_id（sendToChat 产物）
  legacy: () => {
    // 一次锁内原子转换：过期 pending 退休 + PREPARING + 冻结编号；仍可认领的 pending 在这里也会被拒（rotation_already_pending）
    const prepared = prepareClaudeTopicRotation({ root, claudeSessionId, operationId, supersedeExpired: true });
    if (!prepared.ok) throw new Error("无法开始轮转（" + prepared.reason + "）。");
    if (prepared.superseded) console.log("已作废    第 " + prepared.superseded.generation + " 代（过期的待认领代际）");
    const { nextNumber, token, rootText } = plan(prepared.nextGeneration);
    if (nextNumber !== expectedNext) console.log("注意      锁内冻结的下一代是第 " + nextNumber + " 代（预告为第 " + expectedNext + " 代）：根消息按冻结的编号生成");
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
      throw err;
    }
    const registered = registerClaudeTopicRotation({ root, claudeSessionId, operationId, rootMessageId, pendingToken: token });
    if (!registered.ok) {
      // **失败要收口，而且收口本身也可能失败。**
      const closed = failClaudeTopicRotation({ root, claudeSessionId, operationId, reason: registered.reason });
      throw new Error("新话题已创建，但 pending generation 登记失败（" + registered.reason + "）。" +
        (closed.ok
          ? "轮转已收口，旧代际仍保持 active；新建的那个话题需要人工清理。"
          : "**收口也失败了（" + closed.reason + "）**：轮转状态可能仍停在 preparing。" +
            "旧代际保持 active。若状态仍停在 preparing，" +
            Math.round(TOPIC_GENERATION_PREPARING_STALE_MS / 60000) +
            " 分钟后可由下一次轮转接管；若已进入 awaiting_claim，则去新话题真实 @ 完成认领。" +
            "新建的那个话题需要人工清理。"));
    }
    return { ...registered, root_message_id: rootMessageId };
  },
});
if (!wired.ok) {
  if (wired.reason === "legacy_failed") die("轮转失败：" + (wired.why ?? "legacy 异常"));
  die("无法开始轮转（M1a 一致性锁取不到：" + (wired.reason ?? "m1a_reject") + (wired.why ? "；" + wired.why : "") + "）。旧代际保持 active，未创建新话题。");
}
const rootMessageId = wired.legacy.root_message_id;

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
