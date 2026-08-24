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
 *   node scripts/codex/suppress-outbox.mjs --thread-id <id> --generation <代际 id>
 *   node scripts/codex/suppress-outbox.mjs --task-key <key> --all-generations --apply --reason "..."
 */

import path from "node:path";

import { isDirectRun } from "../direct-run.mjs";
import { listPending } from "../outbox.mjs";
import { applySuppressionCore, dependsOnMapping } from "../suppress-outbox-core.mjs";
import { activeGeneration, pendingGeneration } from "../topic-generation.mjs";
import {
  bridgeHome, findTaskForCodexThread, loadRegistry, registryFile,
  resolveTask, resolveTaskOutboundGeneration, taskPaths, topicStateForTask,
} from "./state.mjs";

const FLAGS = new Set(["apply", "all-generations"]);
const OPTIONS = new Set(["task-key", "thread-id", "generation", "reason", "expect-generation"]);

/**
 * 参数之间的硬约束。**有损操作的默认值不该是"最大范围"。**
 *
 * 上一版：不传 --generation 就作用于整个 outbox；同时传 --thread-id 和 --task-key
 * 会静默择一。两条都是"少说一句话就扩大破坏范围"，而这个动作不可逆。
 *
 * 现在：目标必须且只能给一个；范围必须显式 —— 要停全部代际得写出 --all-generations，
 * 它跟 --generation 互斥。
 */
export function checkArgShape(seen) {
  const hasThread = seen.has("thread-id");
  const hasKey = seen.has("task-key");
  if (hasThread && hasKey) return { ok: false, reason: "target_ambiguous" };
  if (!hasThread && !hasKey) return { ok: false, reason: "target_missing" };
  const hasGen = seen.has("generation");
  const hasAll = seen.has("all-generations");
  if (hasGen && hasAll) return { ok: false, reason: "scope_conflict" };
  if (!hasGen && !hasAll) return { ok: false, reason: "scope_missing" };
  return { ok: true };
}

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

/**
 * task 现在的**出站有效代际**。
 *
 * 必须跟排空用同一套解析：`active ?? pending`。上一版只看 active ——
 * 而首次真实认领之前那一代是 pending，于是这个函数返回 null，
 * **轮转前后都是 null，比不出任何变化，轮转检查形同虚设**。
 * 测试里它就这么把一条本该拦下的内容抑制掉了。
 *
 * 又是一处"同一个概念两处各写一份"。这里跟着 resolveTaskOutboundGeneration 的口径。
 */
export function activeGenerationOf(task) {
  const loaded = topicStateForTask(task);
  if (!loaded.ok) return null;
  return activeGeneration(loaded.state)?.channel_generation_id
    ?? pendingGeneration(loaded.state)?.channel_generation_id
    ?? null;
}

/**
 * 按**稳定身份**重新定位 task。锁外锁内都走这一个函数。
 *
 * 上一版我为共用核心设计了"锁内怎么重读"这个回调，**然后在实现它的时候
 * 把锁外读到的那个 task 闭包了进去** —— 接口对了，实现是假的：
 * 预览之后轮转，旧格式记录仍会按旧代际被不可逆抑制，rotated 检查压根不触发。
 *
 * 做成函数是为了让"闭包旧值"这件事在写法上做不出来：想拿 task 就得再调一次。
 * 缺失、歧义、读不出来一律 fail-closed —— 说不清是哪条 task 时不动 outbox。
 */
export function locateTask({ threadId, taskKey, home }) {
  if (threadId) {
    const found = findTaskForCodexThread({ threadId, home });
    if (!found?.task) return { ok: false, reason: "task_not_found" };
    return { ok: true, task: found.task };
  }
  // **读的必须是 home 那一份。**上一版这里调 loadRegistry() 读默认位置，
  // 而拿的锁是 home/registry.lock —— 显式指定 home 时，锁和被保护的文件
  // 可能根本不是同一份状态。现在两者靠同一个 home 保持一致，不靠巧合。
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return { ok: false, reason: "registry_unreadable" };
  const hits = reg.tasks.filter((t) => t.logical_task_key === taskKey);
  if (hits.length === 0) return { ok: false, reason: "task_not_found" };
  // 同一个 key 有多条 → 说不清该动哪一条，拒绝。
  if (hits.length > 1) return { ok: false, reason: "task_ambiguous", count: hits.length };
  return { ok: true, task: hits[0] };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const shape = checkArgShape(parsed.seen);
  if (!shape.ok) {
    console.error({
      target_ambiguous: "--thread-id 和 --task-key 只能给一个 —— 两个都给时说不清动哪条 task。",
      target_missing: "必须给 --thread-id 或 --task-key 之一。不支持 --last，不猜。",
      scope_conflict: "--generation 和 --all-generations 互斥。",
      scope_missing: "必须显式给范围：--generation <代际 id>，或 --all-generations。\n" +
        "  **不给范围不等于「全部」** —— 这个动作不可逆，默认值不该是最大破坏面。",
    }[shape.reason]);
    process.exit(1);
  }
  const apply = parsed.seen.has("apply");
  const generation = parsed.seen.get("generation") ?? null;
  const reason = parsed.seen.get("reason") ?? "manual_suppress";
  const home = bridgeHome();

  // **必须精确指定 task**，跟排空同一条规矩：不支持 --last，不猜。
  const threadId = parsed.seen.get("thread-id");
  const taskKey = parsed.seen.get("task-key");
  const located = locateTask({ threadId, taskKey, home });
  if (!located.ok) {
    console.error(located.reason === "task_ambiguous"
      ? "有 " + located.count + " 条 task 用同一个 key，说不清该动哪一条。什么都没做。"
      : located.reason === "registry_unreadable"
        ? "登记表读不出来，什么都没做。"
        : "找不到目标 task。必须传精确 --task-key 或 --thread-id；不支持 --last。");
    process.exit(1);
  }
  const task = located.task;
  const resolved = resolveTask(task, { home });
  if (!resolved.ok) {
    console.error("task 配置不可用：" + resolved.reason);
    process.exit(1);
  }

  const paths = taskPaths(task, home);
  const all = listPending({ outboxDir: paths.outbox });
  const pending = selectByGeneration(all, generation, task);
  // **预览看到的代际必须由人带进来。**
  //
  // 上一版在这里现算，而预览和 --apply 是两次独立运行 —— 第二次会重新算出
  // 轮转之后的值，前后一比总是相等，**跨进程根本没有保护**。
  // 而"预览之后轮转过"恰恰是跨进程才会发生的事。
  //
  // 所以：这批里有旧格式记录（代际靠现算）时，--apply 必须显式带
  // --expect-generation，预览会把该带的值原样打出来。
  const nowGeneration = activeGenerationOf(task);
  const expectGeneration = parsed.seen.get("expect-generation") ?? null;

  console.log("task      " + task.task_display_name + "  " + task.logical_task_key);
  console.log("范围      " + (generation === null
    ? "**全部代际**（显式 --all-generations）" : "代际 " + generation.slice(0, 12) + "…"));
  console.log("待发      " + pending.length + " 条" +
    (generation === null ? "" : "（本代际）／全部 " + all.length + " 条"));
  console.log("理由      " + reason);
  const needsExpect = dependsOnMapping(pending);

  if (pending.length === 0) { console.log("\n没有待发内容，无需改动。"); return; }
  if (generation === null && all.length > 1) {
    console.log("\n注意：这 " + all.length + " 条可能分属不同代际，本次会全部停下。");
    console.log("只想停某一代的话，改用 --generation <代际 id>。");
  }
  console.log("\n**这是不可逆的**：被停下的这些内容不会再发出去，");
  console.log("也**不会**因为重新绑定或轮转话题而自动回来。");
  if (!apply) {
    console.log("\n[dry-run] 什么都没写。");
    if (needsExpect) {
      console.log("这批里有旧格式记录（代际靠当前状态现算）。落盘要带上现在这一代：");
      console.log("  --apply --expect-generation " + (nowGeneration ?? "<读不出代际>"));
      console.log("**带它是为了让「预览之后轮转过」拦得住** —— 两次运行之间轮转了，");
      console.log("这个值就对不上，命令会中止而不是按旧代际停错东西。");
    } else {
      console.log("加 --apply 才生效。（每条都自带代际，轮转不影响它们。）");
    }
    return;
  }
  if (needsExpect && expectGeneration === null) {
    console.error("这批里有旧格式记录，--apply 必须带 --expect-generation <代际 id>。");
    console.error("  先跑一次预览，它会把该带的值打出来。");
    console.error("  **不带它的话，「预览之后轮转过」这件事拦不住** —— 两次运行各算各的。");
    process.exit(1);
  }

  const r = applySuppressionCore({
    outboxDir: paths.outbox,
    publishLockDir: paths.publishLock,
    // Codex 侧的代际状态住在 registry 里，跟轮转共用 registry.lock。
    generationLockDir: path.join(home, "registry.lock"),
    pending, previewGenerationId: expectGeneration, reason,
    // **锁内重新定位，不用锁外那个 task。**闭包旧值的话，
    // "锁内重读"就只是句好听的话 —— 轮转检查会拿着过期的代际去比。
    readState: () => {
      const fresh = locateTask({ threadId, taskKey, home });
      if (!fresh.ok) return null;               // → state_unreadable，零写入
      return {
        activeGeneration: activeGenerationOf(fresh.task),
        select: (records) => selectByGeneration(records, generation, fresh.task),
      };
    },
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
