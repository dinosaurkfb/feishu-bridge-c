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
import { groupByTargetGeneration, outboxDirOf } from "./drain-outbox.mjs";
import { resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { topicGenerationLockDir } from "./topic-generation-store.mjs";
import { currentBinding } from "./feishu-control.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";

const FLAGS = new Set(["apply"]);
const OPTIONS = new Set(["project", "session", "reason", "generation"]);

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

/**
 * 挑出属于某个代际的待发记录。旧格式记录没有 target_channel_generation_id，
 * 它们归属于**当前有效代际** —— 跟排空那边的判定一致。
 */
/**
 * mapping 现在的有效代际。**只有这一份定义。**
 *
 * 这个解析有两条分支，返回的字段名还不一样（generationId / channelGenerationId）。
 * 各处各写一遍就会漏掉其中一条 —— 我第一版就漏了，于是"轮转到哪一代"永远算成 null，
 * 比较看着还是通过的。
 */
function activeGenerationOf(mapping) {
  const r = resolveMappingOutboundGeneration(mapping, null);
  return r?.generationId ?? r?.channelGenerationId ?? null;
}

export function selectByGeneration(records, generation, mapping) {
  const out = [];
  for (const [key, group] of groupByTargetGeneration(records)) {
    const resolved = key === "__legacy_active__"
      ? resolveMappingOutboundGeneration(mapping, null)
      : { generationId: key };
    const id = resolved?.generationId ?? resolved?.channelGenerationId ?? key;
    if (id === generation || key === generation) out.push(...group);
  }
  return out;
}

/**
 * 锁内重读 + 抑制。**整段独立出来，是为了让 main 里不再有 try/finally。**
 *
 * 上一版为了修锁泄漏，把临界区里的 process.exit(1) 换成了 return —— 而 return
 * 会先跑 finally、再从**整个 main() 返回**，后面的报错和 exitCode 全部跳过：
 * 命令静默退出 0，对着一次没做成的操作报成功。比原来的锁泄漏更糟。
 *
 * 现在临界区只返回结果，退出码由 main 在 try 之外决定。**那种写法在 main 里
 * 不再可能出现**，不是靠记得别写。
 *
 * ■ 为什么要拿两把锁
 *
 * 只比 outbox 文件集合挡不住轮转。旧格式记录（没有 target_channel_generation_id）
 * 的目标代际是**从 mapping 现算的**：预览时 mapping 说当前是 gen-1，它就属于 gen-1；
 * 轮转之后同一个文件属于 gen-2。文件没变、条数没变，集合校验一路放行，
 * 于是一条本该发到新话题的内容被按旧代际**永久**抑制掉。
 *
 * 评审用受控探针复现了这条。挡它需要的不是更细的文件比较，而是让"代际含义"
 * 在读的时候不会变 —— 所以先取**代际锁**（轮转用的那一把，同一个目录，
 * 由 topicGenerationLockDir 唯一定义）再取发布锁，然后在锁内重读 mapping。
 *
 * 加锁顺序固定为「代际锁 → 发布锁」。反向顺序不存在（排空与发布只取发布锁、
 * 且不动代际），所以不会死锁。
 */
export function applySuppression({
  outboxDir, root, session = null, pending, generation, previewGenerationId = null, reason,
}) {
  const binding = currentBinding({ root, claudeSessionId: session });
  const genLockDir = topicGenerationLockDir({ source: binding?.source, root });
  const genLock = acquirePublishLock(genLockDir);
  // 轮转正在进行 → 现在不是动 outbox 的时候。等它做完再来。
  if (!genLock.ok) return { ok: false, reason: "rotation_busy" };
  const lockDir = path.join(root, ".runtime-data", "outbound", "publish.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) {
    releasePublishLock(genLockDir);
    return { ok: false, reason: lock.reason };
  }
  try {
    // **锁内重读 mapping**，不用预览时那一份 —— 代际含义正是从它来的。
    const resolved = resolveProject({ root, claudeSessionId: session });
    const freshMapping = resolved.ok ? resolved.mapping : null;
    const activeNow = activeGenerationOf(freshMapping);
    if (previewGenerationId !== null && activeNow !== previewGenerationId) {
      // 预览之后轮转过。即使一个文件都没变，"抑制这一代"的含义已经不是原来那个了。
      return { ok: false, reason: "rotated", from: previewGenerationId, to: activeNow };
    }

    // 预览到落盘之间可能有新内容进来，也可能有内容已经发出去了。
    const freshAll = listPending({ outboxDir });
    const fresh = generation === null ? freshAll : selectByGeneration(freshAll, generation, freshMapping);
    // **比集合，不是比数量。**只比条数挡不住等量替换：预览之后少一条旧的、
    // 多一条新的，总数没变，就会不可逆地抑制另一批内容。
    const before = new Set(pending.map((x) => x._file));
    const now = new Set(fresh.map((x) => x._file));
    const same = before.size === now.size && [...before].every((f) => now.has(f));
    if (!same) return { ok: false, reason: "drift", before: before.size, now: now.size };
    return { ok: true, done: suppressRecords(fresh, { reason }) };
  } finally {
    releasePublishLock(lockDir);
    releasePublishLock(genLockDir);
  }
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
  const generation = parsed.seen.get("generation") ?? null;

  const resolved = resolveProject({ root, claudeSessionId: session });
  const mapping = resolved.ok ? resolved.mapping : null;
  const outboxDir = outboxDirOf(root, session);
  // **默认只停某一个代际。**诊断是针对某个话题代际给出的，而 outbox 里可能同时
  // 躺着别的代际的待发内容 —— 一刀切会把不相干的一起永久停掉。
  // 不给 --generation 就要求显式确认范围是"全部"。
  const all = listPending({ outboxDir });
  // **跟排空用同一套代际解析。**直接按 r.target_channel_generation_id 过滤会漏掉
  // 旧格式记录 —— 它们没有这个字段，排空时被归入当前有效代际（__legacy_active__），
  // 于是按诊断给的代际 id 来筛，一条都筛不到。
  const pending = generation === null ? all : selectByGeneration(all, generation, mapping);
  // 记下预览时的有效代际。落盘前要拿它跟锁内重读的结果比 —— 中间轮转过的话，
  // "抑制这一代"的含义已经变了，即使一个文件都没动。
  const previewGenerationId = activeGenerationOf(mapping);

  console.log("项目      " + root);
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

  const r = applySuppression({
    outboxDir, root, session, pending, generation, previewGenerationId, reason });
  if (!r.ok) {
    console.error(
      r.reason === "publisher_busy"
        ? "发布器正忙，稍后再试 —— 不在它发的时候动 outbox。"
      : r.reason === "rotation_busy"
        ? "话题正在轮转，稍后再试 —— 轮转会改变待发内容属于哪一代。"
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
  const done = r.done;
  console.log("\n已停止重试 " + done.changed + " 条。");
  if (!done.ok) {
    // 部分失败要如实说，不能报"整批已停止"——那会让人以为噪音没了，而它还在。
    console.error(done.failed.length + " 条没停成（" +
      done.failed.map((f) => f.reason).join("、") + "），它们仍会被重试。");
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
