#!/usr/bin/env node
/**
 * 群级绑定的状态提供者 —— 把一份 group binding 翻译成 feishu-bridge-status/v1。
 *
 * 为什么住在这个仓库：状态视图是**本仓库的功能**，消费者只是使用它的场景。
 * 让每个接入方各写一份，等于把「不打印 locator」「枚举值受控」这些承诺
 * 复制到 N 个实现里，然后指望它们都不写错。第一个用它的是 cc2cd。
 *
 * 绑定文件由消费者自己维护（各自的 .runtime-data 下），本脚本**只读**。
 *
 * 输出里**只有群名**。chat_id、thread_id、session id 一个都不出 ——
 * 聚合方那边虽然也拦（未知字段整条拒），但拦截是最后一道，不是唯一一道。
 *
 * 用法：
 *   node scripts/group-binding-status.mjs --provider-id cc2cd --binding /abs/binding.json
 */

import fs from "node:fs";
import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { PROVIDER_PROTOCOL } from "./status-providers.mjs";

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * 从绑定推出对外可见的状态。
 *
 * 「读不到」和「没绑过」都归结为"没有已连接的群" —— 两者对使用者是同一件事。
 * 但**解释不了的内容**（文件在、却不是一份能读懂的绑定）要报错，让聚合方
 * 显示"状态取不到"，而不是显示"没有绑定" —— 后者是在替它下一个它不该下的结论。
 */
export function bindingToConnections(doc, { now = Date.now() } = {}) {
  if (doc === null) return { ok: true, connections: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "binding_shape_unexpected" };
  if (doc.bind_scope !== "chat") return { ok: false, reason: "binding_shape_unexpected" };

  const groupName = typeof doc.chat_name === "string" && doc.chat_name.trim().length > 0
    ? doc.chat_name.trim()
    : "（未命名群）";

  const expiresAt = Date.parse(doc.expires_at ?? "");
  let state = "unknown";
  if (doc.status === "active") {
    state = Number.isFinite(expiresAt) && now >= expiresAt ? "expired" : "active";
  } else if (doc.status === "suspended") {
    state = "suspended";
  }

  // scope 报 chat：话题是对账出来的，没有预先登记的话题名可报，
  // 而 sessions 里那些 thread_id 是 locator，不能出现在状态里。
  return { ok: true, connections: [{ kind: "transport", state, scope: "chat", group_name: groupName }] };
}

function readBinding(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, doc: null };
    return { ok: false, reason: "binding_unreadable" };
  }
  try { return { ok: true, doc: JSON.parse(raw) }; }
  catch { return { ok: false, reason: "binding_unreadable" }; }
}

function main() {
  const providerId = arg("provider-id");
  const binding = arg("binding");
  if (!providerId || !binding || !path.isAbsolute(binding)) {
    console.error("用法：node scripts/group-binding-status.mjs --provider-id <id> --binding <绝对路径>");
    process.exit(2);
  }

  const read = readBinding(binding);
  if (!read.ok) {
    // 协议里没有错误通道，非零退出让聚合方显示"状态取不到"。
    console.error(read.reason);
    process.exit(1);
  }
  const got = bindingToConnections(read.doc);
  if (!got.ok) {
    console.error(got.reason);
    process.exit(1);
  }
  console.log(JSON.stringify({
    schema_version: PROVIDER_PROTOCOL,
    provider_id: providerId,
    connections: got.connections,
  }));
}

if (isDirectRun(import.meta.url)) main();
