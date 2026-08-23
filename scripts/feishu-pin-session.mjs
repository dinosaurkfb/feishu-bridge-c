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
import { identifySelf } from "./bind-session.mjs";
import {
  clearDeliveryPin, findLiveSessions, readDeliveryPin, writeDeliveryPin,
} from "./live-session.mjs";

/**
 * 严格解析。**白名单，不是"认识的就用、不认识的忽略"。**
 *
 * 上一版见到未知参数直接忽略，于是 `--cleer --apply` 被静默当成"钉住"执行 ——
 * 一个拼写错误换来了另一种操作。这一课我在 register-status-provider 上刚学过，
 * 写这个新命令时没用上。
 */
const FLAGS = new Set(["apply", "clear"]);
const OPTIONS = new Set(["project"]);

function parseArgs(tokens) {
  const seen = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (typeof t !== "string" || !t.startsWith("--")) {
      return { ok: false, reason: "unexpected_argument", detail: t };
    }
    const name = t.slice(2);
    if (seen.has(name)) return { ok: false, reason: "duplicate_option", detail: t };
    if (FLAGS.has(name)) { seen.set(name, true); continue; }
    if (!OPTIONS.has(name)) return { ok: false, reason: "unknown_option", detail: t };
    const value = tokens[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      return { ok: false, reason: "option_needs_value", detail: t };
    }
    seen.set(name, value);
    i += 1;
  }
  return { ok: true, seen };
}

const REASON_TEXT = {
  unexpected_argument: "只接受 --xxx 形式的参数",
  duplicate_option: "同一个参数给了两次",
  unknown_option: "不认识这个参数（拼错了？）",
  option_needs_value: "这个参数缺少取值",
};

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）：" +
      (REASON_TEXT[parsed.reason] ?? parsed.reason) +
      (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const apply = parsed.seen.has("apply");
  const clear = parsed.seen.has("clear");
  const rootArg = parsed.seen.get("project");
  const root = path.resolve(typeof rootArg === "string" ? rootArg : process.cwd());

  // **不能只信环境变量。**identifySelf 会把 session id、PID 和现场登记三者对上 ——
  // 上一版只读 CLAUDE_CODE_SESSION_ID，于是 PID 是假的也照样写 pin。
  // 这个函数早就存在（bind-session 用它绑会话），我又写了一份只信环境变量的。
  const me = identifySelf();
  const self = me.ok ? me.sessionId : null;

  // **把已验证的会话传进去。**上一版只传 root，于是：
  //   · 只有会话级绑定时被误报成 not_bound；
  //   · 项目级与会话级并存时错选了项目级；
  //   · st.level === "session" 那条分支对当前会话根本不可达。
  // 选绑定的规则必须跟出站一致 —— 按另一套规则找，就会出现"这里说 A、实际发到 B"。
  const st = currentBinding({ root, claudeSessionId: me.ok ? me.sessionId : undefined });
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
    console.error("\n认不出这是哪条会话（" + me.reason + "）：" + (me.detail ?? ""));
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
