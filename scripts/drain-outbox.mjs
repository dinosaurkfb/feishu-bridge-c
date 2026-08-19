#!/usr/bin/env node
/**
 * 排空 outbox：把积累的关键进展合成一条摘要发到绑定话题，然后逐条标记已发。
 *
 * 由定时器周期性调用。它只读本地 outbox、只往一个已绑定的话题写，
 * 不监听飞书、不接受指令、不做任何入站动作。
 *
 * 幂等靠逐条 published_at：发送成功才标记；发送失败不标记，下一轮重试。
 * 宁可重试也不能标记了却没发出去 —— 那会让进展静默丢失。
 */

import fs from "node:fs";
import path from "node:path";

import { listPending, markSent, composeDigest } from "./outbox.mjs";
import { publishDraft } from "./outbound.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RT = path.join(ROOT, ".runtime-data");
const outboxDir = path.join(RT, "outbound", "outbox");

const cfg = JSON.parse(fs.readFileSync(path.join(RT, "inbound", "chain-config.json"), "utf-8"));
const mapping = JSON.parse(fs.readFileSync(path.join(RT, "inbound", "active-mapping.json"), "utf-8"));

const pending = listPending({ outboxDir });
if (pending.length === 0) {
  if (process.argv.includes("--verbose")) console.log("outbox 为空");
  process.exit(0);
}

// 绑定失效时不发：话题可能已经不再是 Frank 认可的那个。
if (mapping.status !== "active") {
  console.error("绑定不是 active，暂不发布（" + pending.length + " 条留在 outbox）");
  process.exit(0);
}

const text = composeDigest(pending, { taskName: cfg.task_display_name });

if (process.argv.includes("--dry-run")) {
  console.log("[dry-run] 将发布 " + pending.length + " 条：\n---\n" + text);
  process.exit(0);
}

try {
  const mid = publishDraft({
    profile: cfg.lark_cli_profile,
    rootMessageId: mapping.feishu_root_message_id_reference,
    text,
    larkBin: cfg.lark_cli_bin,
    larkHome: cfg.lark_cli_home,
  });
  for (const r of pending) markSent(r, mid);
  console.log("已发布 " + pending.length + " 条 -> " + mid);
} catch (err) {
  // 不标记、不吞掉：下一轮定时器会重试。
  console.error("发布失败，留在 outbox 下轮重试：" + String(err.message).slice(0, 200));
  process.exit(1);
}
