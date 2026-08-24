#!/usr/bin/env node
/**
 * 显式停止重试某个 Codex task 的待发内容。默认只预览，`--apply` 才写。
 *
 * 为什么 Codex 侧也要有这条命令：那边**没有兜底排空** —— 只有"每轮结束发当轮那条"
 * 一条路径，没有重试。某一轮没发成，那条内容就永远留在 outbox 里，
 * 而状态页会一直显示"待发布 N 条"。
 *
 * **一个长期非零的计数器等于把报警关掉了**：现在看到 13 不紧张，以后看到 15 也不会 ——
 * 而 15 里可能有一条是今天该发的。所以要有一条命令把确认不发的显式停掉，让计数回到 0。
 *
 * **判定"该不该停"这件事不能自动做**，跟 Claude 侧同一个理由：有损动作不能建立在
 * 推断出来的因果上。这条命令只执行人的决定。
 *
 * 判据整个复用 suppress-outbox-core —— 两边同一份，不再抄一遍。
 *
 * 用法：
 *   node scripts/codex/suppress-outbox.mjs --thread-id <id>
 *   node scripts/codex/suppress-outbox.mjs --task-key <key> --generation <代际 id> --apply --reason "..."
 */

import path from "node:path";

import { isDirectRun } from "../direct-run.mjs";
import { listPending } from "../outbox.mjs";
import { applySuppressionCore } from "../suppress-outbox-core.mjs";
import { activeGeneration } from "../topic-generation.mjs";
import {
  bridgeHome, findTaskForCodexThread, loadRegistry,
  resolveTask, resolveTaskOutboundGeneration, taskPaths, topicStateForTask,
} from "./state.mjs";

const FLAGS = new Set(["apply"]);
const OPTIONS = new Set(["task-key", "thread-id", "generation", "reason"]);

/** 严格白名单：拼错的参数不许被执行成另一种操作。 */
export function parseArgs(tokens) {
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

/**
 * 跟排空用同一套代际解析。
 *
 * 直接按 `r.target_channel_generation_id` 过滤会漏掉旧格式记录 ——
 * 它们没有这个字段，排空时被归入当前有效代际，于是按诊断给的代际 id 来筛，
 * 一条都筛不到。**提示指向的操作做不到它说的事**，这个坑 Claude 侧踩过。
 */
export function selectByGeneration(records, generation, task) {
  if (generation === null) return records;
  const out = [];
  for (const r of records) {
    const own = r?.target_channel_generation_id ?? null;
    const resolved = own === null ? resolveTaskOutboundGeneration(task, null) : { ok: true };
    const id = own ?? (resolved.ok ? resolved.channelGenerationId ?? null : null);
    if (id === generation || own === generation) out.push(r);
  }
  return out;
}

/** task 现在的有效代际。只有这一份定义 —— 两处各算一遍会漏掉其中一条分支。 */
export function activeGenerationOf(task) {
  const loaded = topicStateForTask(task);
  if (!loaded.ok) return null;
  return activeGeneration(loaded.state)?.channel_generation_id ?? null;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const apply = parsed.seen.has("apply");
  const generation = parsed.seen.get("generation") ?? null;
  const reason = parsed.seen.get("reason") ?? "manual_suppress";
  const home = bridgeHome();

  // **必须精确指定 task**，跟排空同一条规矩：不支持 --last，不猜。
  const threadId = parsed.seen.get("thread-id");
  const taskKey = parsed.seen.get("task-key");
  let task = null;
  if (threadId) task = findTaskForCodexThread({ threadId, home }).task ?? null;
  if (!task && taskKey) {
    const reg = loadRegistry();
    if (reg.ok) task = reg.tasks.find((t) => t.logical_task_key === taskKey) ?? null;
  }
  if (!task) {
    console.error("找不到目标 task。必须传精确 --task-key 或 --thread-id；不支持 --last。");
    process.exit(1);
  }
  const resolved = resolveTask(task, { home });
  if (!resolved.ok) {
    console.error("task 配置不可用：" + resolved.reason);
    process.exit(1);
  }

  const paths = taskPaths(task, home);
  const all = listPending({ outboxDir: paths.outbox });
  const pending = selectByGeneration(all, generation, task);
  const previewGenerationId = activeGenerationOf(task);

  console.log("task      " + task.task_display_name + "  " + task.logical_task_key);
  console.log("范围      " + (generation === null
    ? "**整个 outbox**（未指定 --generation）" : "代际 " + generation.slice(0, 12) + "…"));
  console.log("待发      " + pending.length + " 条" +
    (generation === null ? "" : "（本代际）／全部 " + all.length + " 条"));
  console.log("理由      " + reason);

  if (pending.length === 0) { console.log("\n没有待发内容，无需改动。"); return; }
  if (generation === null && all.length > 1) {
    console.log("\n注意：outbox 里有多条待发，可能分属不同代际。");
    console.log("要只停某一代，加 --generation <代际 id>。");
  }
  console.log("\n**这是不可逆的**：被停下的这些内容不会再发出去，");
  console.log("也**不会**因为重新绑定或轮转话题而自动回来。");
  if (!apply) { console.log("\n[dry-run] 什么都没写。加 --apply 才生效。"); return; }

  const r = applySuppressionCore({
    outboxDir: paths.outbox,
    publishLockDir: paths.publishLock,
    // Codex 侧的代际状态住在 registry 里，跟轮转共用 registry.lock。
    generationLockDir: path.join(home, "registry.lock"),
    pending, previewGenerationId, reason,
    readState: () => ({
      activeGeneration: activeGenerationOf(task),
      select: (records) => selectByGeneration(records, generation, task),
    }),
  });

  // **退出码和输出都在锁释放之后。**锁内 process.exit 会跳过 finally —— 那个坑踩过两次。
  if (!r.ok) {
    console.error(
      r.reason === "publisher_busy" ? "发布器正忙，稍后再试 —— 不在它发的时候动 outbox。"
      : r.reason === "rotation_busy" ? "话题正在轮转，稍后再试 —— 轮转会改变待发内容属于哪一代。"
      : r.reason === "rotated"
        ? "预览之后话题轮转过（" + String(r.from).slice(0, 12) + "… → " +
          String(r.to).slice(0, 12) + "…），没有动 outbox。\n" +
          "  即使文件一个没变，「抑制这一代」的含义已经不是刚才那个了。请重新预览确认。"
      : r.reason === "drift"
        ? "outbox 在预览之后变了（" + r.before + " → " + r.now +
          " 条待发，或换了内容），没有动它。请重新预览确认。"
        : "取锁失败（" + r.reason + "），没有动 outbox。");
    process.exitCode = 1;
    return;
  }
  console.log("\n已停止重试 " + r.done.changed + " 条。");
  if (!r.done.ok) {
    console.error(r.done.failed.length + " 条没停成（" +
      r.done.failed.map((f) => f.reason).join("、") + "），它们仍会被重试。");
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
