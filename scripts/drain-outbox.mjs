#!/usr/bin/env node
/**
 * 排空 outbox：把积累的关键进展合成一条摘要发到绑定话题，然后逐条标记已发。
 *
 * 三个调用方共用这一个函数：会话结束钩子（事件驱动，主路径）、
 * launchd 兜底定时器、以及人工。它们只读本地 outbox、只往一个已绑定的话题写，
 * 不监听飞书、不接受指令、不做任何入站动作。
 *
 * 幂等靠两层：发布锁保证同一时刻只有一个排空者，逐条 published_at 保证发过的不再发。
 * 发送成功才标记；发送失败不标记，下一轮重试。宁可重试也不能标记了却没发出去 ——
 * 那会让进展静默丢失。
 */

import fs from "node:fs";
import path from "node:path";

import { listPending, markSent, composeDigest } from "./outbox.mjs";
import { publishDraft } from "./outbound.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { isLockStale } from "./handoff.mjs";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));

export const outboxDirOf = (root) => path.join(root, ".runtime-data", "outbound", "outbox");
const publishLockOf = (root) => path.join(root, ".runtime-data", "outbound", "publish.lock");
const sessionLockOf = (root) => path.join(root, ".runtime-data", "inbound", "session.lock");

/**
 * 有没有一次性守望者正盯着某次投递。
 *
 * 有就别自己发 —— 守望者会把「执行结果 + 本轮进展」合成一条。抢在它前面发，
 * Frank 一次指令就会收到三条消息（已受理 + 进展 + 结果），正是要避免的噪音。
 */
export function watcherActive(root) {
  const lockDir = sessionLockOf(root);
  if (!fs.existsSync(lockDir)) return false;
  return !isLockStale(lockDir);
}

/**
 * 排空一个项目的 outbox。返回结构化结果，自己不打印、不退出 ——
 * 它跑在会话结束钩子里，任何 throw 或 process.exit 都会砸到别人的会话上。
 */
export function drainProject({ root, dryRun = false, timeoutMs } = {}) {
  const outboxDir = outboxDirOf(root);

  // 先看有没有东西可发。绝大多数会话在这一行就返回了 —— 不读配置、不碰锁。
  if (listPending({ outboxDir }).length === 0) return { status: "empty", root };

  let cfg;
  let mapping;
  try {
    cfg = readJson(path.join(root, ".runtime-data", "inbound", "chain-config.json"));
    mapping = readJson(path.join(root, ".runtime-data", "inbound", "active-mapping.json"));
  } catch (err) {
    return { status: "error", root, reason: "config_unreadable", error: String(err.message).slice(0, 200) };
  }

  // 绑定失效时不发：话题可能已经不再是 Frank 认可的那个。
  if (mapping.status !== "active") {
    return { status: "skipped", root, reason: "mapping_not_active", count: listPending({ outboxDir }).length };
  }

  const lockDir = publishLockOf(root);
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { status: "skipped", root, reason: lock.reason };

  try {
    // 锁内重新读一遍：刚才排队等锁的时候，别的发布者可能已经把这批发掉了。
    const pending = listPending({ outboxDir });
    if (pending.length === 0) return { status: "empty", root };

    const text = composeDigest(pending, { taskName: cfg.task_display_name });
    if (dryRun) return { status: "dry_run", root, count: pending.length, text };

    const messageId = publishDraft({
      profile: cfg.lark_cli_profile,
      rootMessageId: mapping.feishu_root_message_id_reference,
      text,
      larkBin: cfg.lark_cli_bin,
      larkHome: cfg.lark_cli_home,
      timeoutMs,
    });
    for (const r of pending) markSent(r, messageId);
    return { status: "published", root, count: pending.length, messageId };
  } catch (err) {
    // 不标记、不吞掉：留在 outbox，下一个排空者重试。
    // 截断放宽到 400：飞书的报错 JSON 前 200 字还没到 code 和 message，截短了等于没留痕。
    return { status: "error", root, reason: "publish_failed", error: String(err.message).slice(0, 400) };
  } finally {
    releasePublishLock(lockDir);
  }
}

// ---------- CLI ----------

if (import.meta.url === "file://" + process.argv[1]) {
  const arg = (n) => {
    const i = process.argv.indexOf("--" + n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const SELF_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const verbose = process.argv.includes("--verbose");
  const dryRun = process.argv.includes("--dry-run");

  // --all 是兜底定时器该走的路径：登记表里的项目都排空一遍。
  // 只排本仓库会让后接进来的项目在钩子没跑到时永远没有兜底。
  let roots;
  if (process.argv.includes("--all")) {
    const { loadRegistry } = await import("./registry.mjs");
    const reg = loadRegistry();
    if (!reg.ok) {
      console.error("登记表读不了（" + reg.reason + "）：" + (reg.error ?? ""));
      process.exit(1);
    }
    roots = reg.projects.map((p) => p.root);
    if (roots.length === 0 && verbose) console.log("登记表里没有项目");
  } else {
    roots = [arg("project") ?? SELF_ROOT];
  }

  let hadError = false;
  for (const root of roots) {
    const tag = roots.length > 1 ? path.basename(root) + ": " : "";
    const r = drainProject({ root, dryRun });

    if (r.status === "published") {
      console.log(tag + "已发布 " + r.count + " 条 -> " + r.messageId);
    } else if (r.status === "dry_run") {
      console.log(tag + "[dry-run] 将发布 " + r.count + " 条：\n---\n" + r.text);
    } else if (r.status === "error") {
      console.error(tag + "排空失败（" + r.reason + "），进展留在 outbox：" + r.error);
      hadError = true;
    } else if (r.status === "skipped") {
      console.error(tag + "暂不发布：" + r.reason + (r.count ? "（" + r.count + " 条留在 outbox）" : ""));
    } else if (verbose) {
      console.log(tag + "outbox 为空");
    }
  }
  if (hadError) process.exit(1);
}
