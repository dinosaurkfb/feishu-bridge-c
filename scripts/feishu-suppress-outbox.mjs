#!/usr/bin/env node
/**
 * 显式停止重试某个项目的待发内容。默认只预览，`--apply` 才写。
 *
 * 为什么要有它、而且**只能由人来按**：
 *
 * 出站失败分两种，而系统只会重试。有一类失败重试再多次也不会变 —— 比如话题是
 * 另一个应用建的，当前身份回复不进去。那种情况下每 30 分钟重试一次，只是稳定地
 * 制造噪音，而每轮 Stop 都会说一句"兜底定时器会重试"，那句话是假的。
 *
 * 但**判定"永久"这件事不能自动做**。上一版试过：诊断到"根消息属于另一个应用"就
 * 自动抑制。那是**从相关性推因果** —— 一次瞬时的网络错误恰好发生在跨应用根消息上，
 * 照样会触发不可逆的抑制。有损动作不能建立在推断出来的因果上。
 *
 * 所以排空只**诊断并报告**，抑制留给这条命令：由看到诊断的人决定。
 *
 * **抑制是不可逆的**：被标记的记录不会因为重新绑定或轮转话题而自动回来。
 * 这一点预览里会明说 —— 一个让人以为"以后还能恢复"的提示比不提示更糟。
 *
 * 用法：
 *   node scripts/feishu-suppress-outbox.mjs --project /abs/dir
 *   node scripts/feishu-suppress-outbox.mjs --project /abs/dir --apply --reason "话题属于旧应用"
 */

import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { listPending, suppressRecords } from "./outbox.mjs";
import { outboxDirOf } from "./drain-outbox.mjs";

const FLAGS = new Set(["apply"]);
const OPTIONS = new Set(["project", "session", "reason"]);

/** 严格白名单：拼错的参数不许被执行成另一种操作。 */
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

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const apply = parsed.seen.has("apply");
  const root = path.resolve(parsed.seen.get("project") ?? process.cwd());
  const session = parsed.seen.get("session") ?? null;
  const reason = parsed.seen.get("reason") ?? "manual_suppress";

  const outboxDir = outboxDirOf(root, session);
  const pending = listPending({ outboxDir });

  console.log("项目      " + root);
  console.log("待发      " + pending.length + " 条");
  console.log("理由      " + reason);

  if (pending.length === 0) { console.log("\n没有待发内容，无需改动。"); return; }

  console.log("\n**这是不可逆的**：被停下的这些内容不会再发出去，");
  console.log("也**不会**因为重新绑定或轮转话题而自动回来。");

  if (!apply) { console.log("\n[dry-run] 什么都没写。加 --apply 才生效。"); return; }

  const done = suppressRecords(pending, { reason });
  console.log("\n已停止重试 " + done.changed + " 条。");
  if (!done.ok) {
    // 部分失败要如实说，不能报"整批已停止"——那会让人以为噪音没了，而它还在。
    console.error(done.failed.length + " 条没停成（" +
      done.failed.map((f) => f.reason).join("、") + "），它们仍会被重试。");
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
