#!/usr/bin/env node
/**
 * 看看积压里到底是什么。**只读。**
 *
 * ■ 为什么需要它
 *
 * 现有命令只告诉你**有几条**（status 的"待发布答复 13 条"）。于是"要不要清掉"
 * 这个决定没法做 —— 抑制是不可逆的，而人手上只有一个数字。
 * **看不见的东西没法授权。**
 *
 * ■ 这个命令的第一条要求：宁可说不知道，也不能说错
 *
 * 它服务的是一个不可逆决定，所以**"读不出来"绝不能显示成"没有积压"**。
 * 上一版栽在这儿：直接用 listPending，而它把目录错误吞成 []、把坏 JSON 静默跳过，
 * 于是放一个坏文件进去，命令照样 exit 0 说"所有 task 的 outbox 都是空的"。
 * 现在改用 auditOutbox 的严格分类：**只有目录不存在才算空**，其余任何说不清
 * 都点名并非零退出。
 *
 * 同样地，"为什么发不出去"分成两层，各说各的：
 *   · **记录层**（这一条记录自身）：坏了 / 还没资格 / 就绪
 *   · **task 层**（身份、mapping、目标话题）：走 preflightTask
 * 上一版把两层混在一句里，于是 task 已暂停时，每条记录仍显示"等待下一次排空" ——
 * 那是编出来的原因。**混层就会编。**
 *
 * ■ 为什么清除不在这里
 *
 * 抑制已有完整实现，带着一整套守卫。再写一个"顺手清掉"的入口就是第二个
 * 不可逆实现。所以这里只把**真正可执行的**那条命令打出来，人复制过去执行。
 *
 * 而且**有损坏或读不出的记录时不给这条命令** —— 抑制对这种情况是整批拒绝的
 * （"只要有一条坏的，整批都不动"）。给一条注定被拒的命令，比不给更糟。
 *
 * 用法：
 *   node scripts/codex/feishu-outbox.mjs                    # 全部 task
 *   node scripts/codex/feishu-outbox.mjs --task-key <key>   # 只看一条
 *   node scripts/codex/feishu-outbox.mjs --thread-id <id>
 *   node scripts/codex/feishu-outbox.mjs --full             # 不截断正文
 */

import path from "node:path";

import { isDirectRun, moduleDir } from "../direct-run.mjs";
import { listPending } from "../outbox.mjs";
import { nodeCommandPrefix, shellQuote } from "../shell-quote.mjs";
import { generationTargetState } from "../suppress-outbox-core.mjs";
import { hasPublishAuthorization } from "../outbox.mjs";
import { auditOutbox } from "./drain-service.mjs";
import { outboxMutationBlocker } from "../outbox.mjs";
import { preflightTask } from "./publish-eligible.mjs";
import {
  bridgeHome, loadRegistry, registryFile, resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

const OPTIONS = new Set(["thread-id", "task-key"]);
const FLAGS = new Set(["full"]);

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
  if (seen.has("thread-id") && seen.has("task-key")) {
    return { ok: false, reason: "ambiguous_selector" };
  }
  return { ok: true, seen };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 多久以前。**给相对时间** —— 人关心的是"这有多旧"。 */
export function ageText(iso, now = Date.now()) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "时间读不出来";
  const d = Math.max(0, now - ms);
  if (d < HOUR) return Math.round(d / MINUTE) + " 分钟前";
  if (d < 2 * DAY) return Math.round(d / HOUR) + " 小时前";
  return Math.round(d / DAY) + " 天前";
}

/**
 * 把要显示的文本**去掉控制序列**。
 *
 * outbox 的正文是模型生成的，而这个视图是人用来做**不可逆决定**的。
 * 评审实测：`\u001b[2J\u001b[H` 原样进了输出 —— 一段内容可以清屏、移光标、
 * 伪造后面的提示行，让人看到的和实际存在的东西不一样。
 *
 * 覆盖 C0/C1 控制符和双向文本控制符；正文、名称、kind、外部错误文本都要过它。
 * 换成可见占位符而不是删掉 —— **"这里原本有东西"本身是信息**。
 */
export function sanitizeForDisplay(text) {
  return String(text ?? "").replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu,
    "\uFFFD");
}

/** 正文压成一行，默认截断 —— 一屏能看完才叫"看得见"。 */
export function oneLine(text, { full = false, width = 60 } = {}) {
  const flat = sanitizeForDisplay(text).replace(/\s+/gu, " ").trim();
  if (full || flat.length <= width) return flat || "(空)";
  return flat.slice(0, width) + "…";
}

/**
 * 这一条记录的状态。
 *
 * **"字段形状对"不等于"发得出去"。**上一版只看字段形状，于是一条冻结到
 * 已 retired（或压根不存在）的代际的记录被报成"已就绪"，而真实发布会被
 * resolveTaskOutboundGeneration 拒绝 —— 记录层说就绪、task 层说可发布，
 * **两层都对，合起来仍是一个错误的暗示**。评审原话："不能合起来暗示能发。"
 *
 * 所以这里也做一次真实的目标解析。解析器由调用方给：
 * 给不出（说不清该用哪条 task）就明说不确定，不替它猜一个结论。
 */
export function describeRecordState(record, { resolveTarget = null } = {}) {
  if (generationTargetState(record) === "corrupt") {
    return { code: "corrupt", text: "目标代际不可用（本地记录坏了，重试没用）" };
  }
  // **资格和目标是两个维度，不许一个挡住另一个。**
  //
  // 上一版先返回 not_eligible，再谈目标 —— 于是一条"冻结到已经不存在的代际、
  // 而且没有发布资格"的历史积压只显示"尚未取得发布资格"，
  // 听起来像"等等就好"，实际是**永远发不出去**。
  // 恰恰是最该被看见的那一类被藏得最深：它正是人要决定清不清的那种。
  // 所以先解析目标，target_gone 优先于资格。
  // **授权判据只有一份。**
  //
  // 上一版这里又写了一遍"非空字符串" —— 于是对
  // publish_eligible_at:"not-a-canonical-time"，审计说"解释不了"、
  // 查看器却说"记录本身已就绪"：**同一个 CLI 给出两个相反的结论。**
  const hasEligibility = hasPublishAuthorization(record);
  // 而且"畸形授权"和"尚未授权"要分开说 —— 前者需要人看，后者等等就好。
  const malformedAuth = record?.publish_eligible_at !== undefined
    && record?.publish_eligible_at !== null && !hasEligibility;

  if (typeof resolveTarget !== "function") {
    if (malformedAuth) {
      return { code: "auth_malformed",
        text: "发布资格字段是坏的（不是规范时间）—— 需要人看一眼" };
    }
    return hasEligibility
      ? { code: "unknown_target", text: "记录本身没问题；目标话题是否仍有效，这里判不出来" }
      : { code: "not_eligible", text: "尚未取得发布资格（目标话题是否仍有效，这里判不出来）" };
  }
  let target;
  try { target = resolveTarget(record?.target_channel_generation_id ?? null); }
  catch (err) {
    return { code: "unknown_target",
      text: "目标话题解析不出来（" + sanitizeForDisplay(String(err?.message ?? err)).slice(0, 60) + "）" };
  }
  if (!target?.ok) {
    // **目标没了就是没了**，有没有资格都改变不了这个事实 —— 先说这个。
    return { code: "target_gone",
      text: "目标话题代际已经不可用（" + (target?.reason ?? "说不清") + "）—— 永远发不出去" +
        (hasEligibility ? "" : "；这条也还没取得发布资格") };
  }
  if (malformedAuth) {
    return { code: "auth_malformed",
      text: "发布资格字段是坏的（不是规范时间）—— **这不是「还没轮到它」，是需要人看一眼**" };
  }
  if (!hasEligibility) {
    return { code: "not_eligible", text: "尚未取得发布资格（目标话题还在）" };
  }
  return { code: "ready", text: "记录本身已就绪，目标话题也还在" };
}

/** task 那一层能不能发。**说不出所以然就把原始 reason 摆出来，不翻译成猜测。** */
export function describeTaskPublishability({ task, home }) {
  let pre;
  try { pre = preflightTask({ task, home }); }
  catch (err) {
    return { ok: false,
      text: "这个 task 能否发布查不出来（" +
        sanitizeForDisplay(String(err?.message ?? err)).slice(0, 80) + "）" };
  }
  if (pre?.ok) return { ok: true, text: "task 可发布" };
  const known = {
    auto_publish_disabled: "这个 task 没有开启自动发布",
    mapping_not_active: "绑定当前不是 active（暂停或已解绑）",
    lark_cli_unset: "没有配置 lark-cli",
  };
  return {
    ok: false,
    // 认得的就说人话；认不得的**原样给 reason**，不编。
    text: known[pre?.reason] ?? ("task 暂不可发布（" + (pre?.reason ?? "说不清") + "）"),
  };
}

/**
 * @returns {{ok:true, tasks:Array}|{ok:false, reason:string}}
 * 每个 task 带 `readable`：false 表示 outbox 读不全，**这时候的条数不可信**。
 */
export function collectBacklog({ home = bridgeHome(), threadId = null, taskKey = null } = {}) {
  const reg = loadRegistry(registryFile(home));
  // **原样透传受控 reason/detail。**上一版一律改写成 registry_unreadable ——
  // 登记表那层刚做出来的精确诊断（结构坏了、第几条坏了）到不了用户手上，
  // 他看到的只有"读不出登记表"。
  if (!reg.ok) {
    return { ok: false, reason: reg.reason ?? "registry_unreadable",
      detail: reg.detail ? sanitizeForDisplay(reg.detail) : null };
  }
  const all = reg.tasks ?? [];
  const selected = all.filter((t) =>
    (threadId === null || t.codex_thread_id === threadId) &&
    (taskKey === null || t.logical_task_key === taskKey));
  // **点名要一条却没找到，是错误，不是"没有积压"。**
  if ((threadId !== null || taskKey !== null) && selected.length === 0) {
    return { ok: false, reason: "task_not_found" };
  }

  const tasks = [];
  for (const task of selected) {
    const outboxDir = taskPaths(task, home).outbox;
    const audit = auditOutbox(outboxDir);
    const entry = {
      name: sanitizeForDisplay(task.task_display_name ?? task.logical_task_key ?? "(未命名)"),
      taskKey: task.logical_task_key ?? null,
      readable: audit.ok === true,
      unreadableReason: audit.ok === true ? null : (audit.reason ?? "说不清"),
      unclassified: audit.ok === true ? (audit.unclassified ?? []) : [],
      // **解释不了的记录也要显示，也要挡住处置命令。**
      // 上一版只存了 unclassified，于是这类记录既看不见、还照样给出抑制命令 ——
      // 而抑制会拒绝它们。查看器和真实入口必须给出同一个结论。
      unexplainable: audit.ok === true ? (audit.unexplainable ?? []) : [],
      blocked: outboxMutationBlocker(audit),
      taskState: describeTaskPublishability({ task, home }),
      records: [],
    };
    if (entry.readable) {
      // **逐记录真解析一次目标代际** —— 只验字段形状会漏掉"冻结到已 retired 的代际"。
      const resolveTarget = (key) => resolveTaskOutboundGeneration(
        task, key === null || key === undefined ? null : key);
      for (const r of listPending({ outboxDir })) {
        const state = describeRecordState(r, { resolveTarget });
        entry.records.push({
          file: path.basename(r._file ?? ""),
          kind: sanitizeForDisplay(r.kind ?? "?"),
          createdAt: r.created_at ?? null,
          text: r.text ?? "",
          state: state.code,
          why: state.text,
        });
      }
    }
    // 读不出来的、有说不清文件的、有待发记录的 —— 三者任一都要出现在报告里。
    if (!entry.readable || entry.unclassified.length > 0
      || (entry.unexplainable ?? []).length > 0 || entry.records.length > 0) {
      tasks.push(entry);
    }
  }
  return { ok: true, tasks };
}

/**
 * 抑制命令 —— **只在真的能跑通时才给**。
 * 有损坏或说不清的记录时返回 null：抑制对那种情况是整批拒绝的。
 */
export function suppressCommandFor(entry) {
  // **跟真实入口同一个判据。**查看器说"可以跑这条"，抑制却拒绝 ——
  // 那就是给了一条注定被拒的命令。
  if (entry.blocked) return null;
  if (!entry.readable || entry.unclassified.length > 0) return null;
  if ((entry.unexplainable ?? []).length > 0) return null;
  if (entry.records.some((r) => r.state === "corrupt")) return null;
  if (entry.records.length === 0 || !entry.taskKey) return null;
  return nodeCommandPrefix(path.join(moduleDir(import.meta.url), "suppress-outbox.mjs")) +
    " --task-key " + shellQuote(entry.taskKey) + " --all-generations";
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const full = parsed.seen.get("full") === true;
  const got = collectBacklog({
    home: bridgeHome(),
    threadId: parsed.seen.get("thread-id") ?? null,
    taskKey: parsed.seen.get("task-key") ?? null,
  });
  if (!got.ok) {
    console.error(got.reason === "task_not_found"
      ? "没有这个 task —— **不是「没有积压」，是点名的那一条不存在。**"
      : got.reason === "registry_malformed"
        ? "登记表结构不对" + (got.detail ? "（" + got.detail + "）" : "") +
          " —— **这不是「没有积压」**，先看一眼那张表。"
        : "读不出登记表（" + got.reason + "）。");
    process.exit(1);
  }
  if (got.tasks.length === 0) {
    console.log("没有积压 —— 所有 task 的 outbox 都读得通，且都是空的。");
    process.exit(0);
  }

  let trouble = false;
  const readable = got.tasks.filter((t) => t.readable && t.unclassified.length === 0);
  const total = readable.reduce((n, t) => n + t.records.length, 0);
  console.log("积压 " + total + " 条" +
    (readable.length === got.tasks.length ? "" : "（另有 task 读不全，见下）") + "。\n");

  for (const t of got.tasks) {
    console.log("【" + t.name + "】" + (t.taskKey ? t.taskKey : ""));
    console.log("  " + t.taskState.text);
    if (!t.readable) {
      trouble = true;
      console.log("  **outbox 读不出来（" + t.unreadableReason + "）—— 这里的条数不可信。**");
      console.log("");
      continue;
    }
    if (t.unclassified.length > 0) {
      trouble = true;
      console.log("  **有 " + t.unclassified.length + " 个文件归不了类，整体不可信：**");
      for (const u of t.unclassified) console.log("    " + u.file + " —— " + u.why);
    }
    if ((t.unexplainable ?? []).length > 0) {
      trouble = true;
      console.log("  **有 " + t.unexplainable.length + " 条记录解释不了，不能对它们动手：**");
      for (const u of t.unexplainable) console.log("    " + u.file + " —— " + u.why);
    }
    console.log("  待发 " + t.records.length + " 条");
    for (const [i, r] of t.records.entries()) {
      console.log("  " + String(i + 1).padStart(2) + ". [" + r.kind + "] " +
        ageText(r.createdAt) + " · " + r.why);
      console.log("      " + oneLine(r.text, { full }));
    }
    const cmd = suppressCommandFor(t);
    if (cmd) {
      console.log("  要停止重试这个 task 的这些内容（**不可逆**）：");
      console.log("    " + cmd);
      console.log("    先不加 --apply 看预览；预览会打出落盘该带的 --expect-digest");
      console.log("    （必要时还有 --expect-generation），照抄上去再加 --apply。");
    } else if (t.blocked) {
      // 已经在上面点过名了，这里只说清没有出路。
      console.log("  这个 task 的 outbox 有说不清的内容，**抑制会整批拒绝** ——");
      console.log("  先确认上面点名的文件是什么。");
    } else if (t.records.some((r) => r.state === "corrupt")) {
      trouble = true;
      // **不给注定被拒的命令。**抑制要求整批可归类，有一条坏的就整批不动。
      console.log("  这个 task 里有损坏记录，**抑制命令会整批拒绝** —— 现在没有自动处置路径，");
      console.log("  请把上面点名的文件交给维护者。");
    }
    console.log("");
  }
  process.exit(trouble ? 1 : 0);
}

if (isDirectRun(import.meta.url)) main();
