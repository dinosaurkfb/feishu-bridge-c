#!/usr/bin/env node
/**
 * 可恢复地暂停当前上下文的飞书接入。
 *
 * **绝不做的事**：删话题、删登记、删待发内容、删回执、往飞书发消息。
 * 暂停要能后悔 —— 话题里已经有历史对话，删掉登记会让那段历史变成孤儿；
 * 待发内容要是一起删了，用户会以为「暂停」顺手丢了他还没看到的东西。
 *
 * 实现上只翻一个已有的闸：绑定的 status。出站只发 active 的，入站见到非 active 直接拒 ——
 * 所以暂停不需要新机制，一个字段两个方向同时生效。
 *
 * 用法：node scripts/feishu-unbind.mjs [--project ~/x] [--apply]
 */

import path from "node:path";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";

import {
  SUSPENDED, bindingsForRoot, currentBinding, describeStatus, setBindingStatus,
} from "./feishu-control.mjs";

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态

const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;

const st = currentBinding({ root, claudeSessionId });
if (!st.ok) {
  console.error(describeStatus(st));
  process.exit(1);
}
if (st.suspended) {
  console.log("已经是暂停状态了，没有重复操作。");
  console.log(describeStatus(st, bindingsForRoot({ root })));
  process.exit(0);
}

console.log("将暂停：" + (st.level === "session"
  ? "这条工作线（会话 " + String(st.claudeSessionId).slice(0, 8) + "）"
  : "整个项目 " + st.displayName));
console.log("");
console.log("暂停之后：");
console.log("  · 出站停发，进展**留在本地**（现有 " + st.pending + " 条），恢复后一并发出");
console.log("  · 入站一律拒绝，话题里发指令会收到明确的拒绝回执");
console.log("  · 话题、历史、登记、回执**全部保留**，不删任何东西，也不往飞书发消息");
console.log("  · 恢复：node scripts/bind-project.mjs --apply（复用原话题，不新建）");

if (!apply) {
  console.log("\n[dry-run] 什么都没做。加 --apply 才真的暂停。");
  process.exit(0);
}

const r = setBindingStatus({ root, claudeSessionId, status: SUSPENDED });
if (!r.ok) {
  console.error("暂停失败（" + r.reason + "）" + (r.error ? "：" + r.error : ""));
  process.exit(1);
}
console.log("\n已暂停。改动写在 " + r.store);
console.log(describeStatus(currentBinding({ root, claudeSessionId }), bindingsForRoot({ root })));
