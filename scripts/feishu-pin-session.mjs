#!/usr/bin/env node
/**
 * 把当前这条会话钉成本项目的首选投递目标。默认只预览，`--apply` 才写。
 *
 * 为什么需要它：项目级绑定在同一个项目开着多条会话时说不清该投给哪一条，
 * 入站会拒收（宁可发不进去，也不投错 —— 投错要等到"它怎么没反应"才发现，
 * 而那时指令可能已经在另一个上下文里执行了）。拒收之后得有出路，这就是那条出路。
 *
 * **必须在你要接收的那条会话里运行。**它钉的是"运行它的这条会话"，
 * 靠 CLAUDE_CODE_SESSION_ID 认自己 —— 在别处替另一条会话钉，等于又回到猜。
 *
 * 它**不改变绑定级别**：钉的只是"投给哪条会话"，不是"这条绑定属于哪条会话"。
 * 后者是 claude_session_id，动它会连带改掉 outbox 目录语义。
 *
 * 用法：
 *   node scripts/feishu-pin-session.mjs                # 看当前钉的是谁
 *   node scripts/feishu-pin-session.mjs --apply        # 钉成本会话
 *   node scripts/feishu-pin-session.mjs --clear --apply # 取消
 */

import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { currentBinding } from "./feishu-control.mjs";
import {
  clearDeliveryPin, findLiveSessions, readDeliveryPin, writeDeliveryPin,
} from "./live-session.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

function main() {
  const apply = process.argv.includes("--apply");
  const clear = process.argv.includes("--clear");
  const root = path.resolve(arg("project") ?? process.cwd());
  const self = process.env.CLAUDE_CODE_SESSION_ID ?? null;

  const st = currentBinding({ root });
  if (!st.ok) {
    console.error("这个项目还没接入飞书（" + st.reason + "），没有可钉的投递目标。");
    process.exit(1);
  }
  if (st.level === "session") {
    // 会话级绑定本来就钉死在它绑的那条线上，再钉一次只会制造两个说法。
    console.error("这是会话级绑定，投递目标本来就是它绑的那条会话，不需要另外钉。");
    process.exit(1);
  }

  const pinned = readDeliveryPin(root);
  const live = findLiveSessions({ projectRoot: root });
  console.log("项目      " + root);
  console.log("当前首选  " + (pinned
    ? pinned.slice(0, 8) + "…" + (live.some((s) => s.sessionId === pinned) ? "（还活着）" : "（已经不在了）")
    : "没有钉过"));
  console.log("现场会话  " + live.length + " 条");

  if (clear) {
    console.log("动作      取消首选");
    if (!apply) { console.log("\n[dry-run] 什么都没写。加 --apply 才生效。"); return; }
    const done = clearDeliveryPin(root);
    if (!done.ok) { console.error("取消失败（" + done.reason + "）"); process.exit(1); }
    console.log("\n已取消。现场只剩一条会话时会自动重新认定；多条时入站会拒收。");
    return;
  }

  if (!self) {
    // 认不出自己就别猜。在别处替另一条会话钉，等于把刚拆掉的猜测换个地方装回去。
    console.error("\n读不到 CLAUDE_CODE_SESSION_ID，认不出这是哪条会话。");
    console.error("请**在你要接收消息的那条会话里**运行这条命令。");
    process.exit(1);
  }
  // 这条会话必须真的是**这个项目**的现场。否则带 --project 从别的项目跑，
  // 就会把一个跟它无关的会话钉成投递目标 —— 那是把刚拆掉的猜测换个地方装回去。
  if (!live.some((x) => x.sessionId === self)) {
    console.error("\n这条会话不在该项目的现场记录里，钉了也投不进去。");
    console.error("请**在那个项目里、你要接收消息的那条会话中**运行这条命令。");
    process.exit(1);
  }
  console.log("动作      钉成本会话 " + self.slice(0, 8) + "…");

  if (pinned === self) { console.log("\n已经是它了，无需改动。"); return; }
  if (!apply) { console.log("\n[dry-run] 什么都没写。加 --apply 才生效。"); return; }

  const done = writeDeliveryPin(root, self);
  if (!done.ok) { console.error("钉不上（" + done.reason + "）：" + (done.error ?? "")); process.exit(1); }
  console.log("\n已钉住。之后这个项目的飞书指令都投给这条会话，直到你取消或它不在了。");
}

if (isDirectRun(import.meta.url)) main();
