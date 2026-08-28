/**
 * 待认领话题的**无人认领提醒**（FR-8 补充；2026-08-28 起待认领不过期）。
 *
 * 新话题建好后要等人在里面 @ 一下才算认领。它不会过期；没人认领就在那个待认领话题下提醒：
 * 等满 TOPIC_GENERATION_CLAIM_REMINDER_AFTER_MS（72 小时）提醒一次，之后每 REPEAT（7 天）再提醒一次。
 * 取消是唯一的显式出口（/feishu-rotate cancel）。
 *
 * 每个周期内的语义是**最多三次尝试、结果不明时允许重复**，不是"严格一次"（飞书侧没有幂等依据）：
 *   1. 锁外用 claimReminderDue 预筛；
 *   2. 锁内 reserveClaimReminderAttempt 预留这次尝试（attempts+1、attempted_at 持久化）——
 *      并发的第二个扫描器拿到 retry_too_soon，不会再发；
 *   3. 发布；
 *   4. 成功再 markPendingClaimReminder 记 claim_reminder_at（本周期结束，计数清零）。
 * 发布失败：attempts 留着，≥ RETRY_MS 后的下一轮兜底再试，用满 MAX_ATTEMPTS 次则记 abandoned、
 * 报 reminder_abandoned 一次，下个周期重来。
 * 判据只有一份（topic-generation.mjs）；本模块只负责发与记。publish 可注入 —— 测试不许打到真实飞书。
 */

import { publishDraft } from "./outbound.mjs";
import { loadRegistry, registryPath } from "./registry.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import {
  loadClaudeTopicBinding, markClaudeClaimReminder, markClaudeClaimReminderAbandoned, reserveClaudeClaimReminder,
} from "./topic-generation-store.mjs";
import { TOPIC_GENERATION_CLAIM_REMINDER_MAX_ATTEMPTS, claimReminderDue } from "./topic-generation.mjs";

const DAY_MS = 24 * 3600000;
/** 等待时长的人话：不足两天说小时，否则说天。 */
export function describeWaited(ms) {
  if (ms < 2 * DAY_MS) return "约 " + Math.max(1, Math.round(ms / 3600000)) + " 小时";
  return "约 " + Math.round(ms / DAY_MS) + " 天";
}

/** 提醒正文：不带 locator，只说清"哪一代、等了多久、怎么认领、不想要怎么取消"。 */
export function composeClaimReminderText({ name, generation, waitedMs, cancelCommand = "/feishu-rotate cancel" }) {
  return [
    "⏰ 这个话题还没有人认领 —— " + name + " · 第 " + generation + " 代",
    "",
    "已等待" + describeWaited(waitedMs) + "，无人认领。它不会过期。",
    "认领方式：在这条消息下面 @ 一下运输 agent（空消息也行），绑定就完成了。",
    "不想要这个新话题：" + cancelCommand + "。",
    "",
    "每 7 天提醒一次；发送失败时最多重试 3 次。",
  ].join("\n");
}

/** 预留阶段这些原因是**受控的**"这轮不发"：状态在锁内变了、别人正拿着锁。其余（登记表 / 状态 / 写盘错误）都是问题。 */
const RESERVE_SKIP_REASONS = new Set([
  "retry_too_soon", "reminded_recently", "not_yet", "expired", "no_pending", "binding_not_active", "no_created_at",
  "abandoned_recently", "pending_generation_mismatch", "binding_busy", "registry_busy",
]);

/**
 * 一个待认领代际的完整提醒流程：判据 → 身份 → 预留 → 发 → 记。两条链共用；
 * 差异（怎么预留、怎么记、怎么放弃、用谁的身份、取消命令怎么写）由参数注入。identity 是**惰性函数**：
 * 只在确认要发之后才解析，解析抛错算这个代际的问题，不许打断整轮扫描。
 * @returns {{outcome:"reminded"|"skipped"|"problem", entry:object}}
 */
export function remindOnePendingClaim({ name, state, now, dryRun, reserve, publish, mark, abandon, identity, cancelCommand }) {
  const due = claimReminderDue(state, { now });
  if (!due.due) {
    if (due.reason === "attempts_exhausted") {
      // 正常情况下上一轮发失败时已经记过 abandoned；走到这里说明没记上，补记一次并报出来。
      const marked = typeof abandon === "function" ? abandon(due.generation.channel_generation_id) : { ok: false, reason: "no_abandon" };
      return { outcome: "problem", entry: { name, reason: "reminder_abandoned",
        error: "本周期发送失败 " + due.attempts + " 次，已放弃" + (marked.ok ? "" : "（放弃记录未写上：" + marked.reason + "）") } };
    }
    return { outcome: "skipped", entry: { name, reason: due.reason } };
  }
  const g = due.generation;
  if (dryRun) return { outcome: "reminded", entry: { name, generation: g.generation, dryRun: true } };
  let who;
  try { who = typeof identity === "function" ? identity() : identity; }
  catch (err) {
    return { outcome: "problem", entry: { name, reason: err?.reason ?? "identity_unresolvable", error: String(err?.message ?? err).slice(0, 160) } };
  }
  if (!who) return { outcome: "problem", entry: { name, reason: "config_unavailable" } };
  const reserved = reserve(g.channel_generation_id);
  if (!reserved.ok) {
    if (reserved.reason === "attempts_exhausted") {
      return { outcome: "problem", entry: { name, reason: "reminder_abandoned", error: "本周期发送失败 " + reserved.attempts + " 次，已放弃" } };
    }
    if (RESERVE_SKIP_REASONS.has(reserved.reason)) return { outcome: "skipped", entry: { name, reason: reserved.reason } };
    return { outcome: "problem", entry: { name, reason: "reserve_failed",
      error: String(reserved.reason) + (reserved.error ? "：" + String(reserved.error).slice(0, 120) : "") } };
  }
  const text = composeClaimReminderText({
    name, generation: g.generation, waitedMs: reserved.waitedMs ?? due.waitedMs, cancelCommand,
  });
  try {
    publish({ profile: who.profile, rootMessageId: g.root_message_id, text,
      larkBin: who.bin, larkHome: who.configDir, expectedAppId: who.expectedAppId });
  } catch (err) {
    const last = reserved.attempt >= TOPIC_GENERATION_CLAIM_REMINDER_MAX_ATTEMPTS;
    let abandoned = null;
    if (last && typeof abandon === "function") abandoned = abandon(g.channel_generation_id);
    return { outcome: "problem", entry: { name, reason: last ? "reminder_abandoned" : "publish_failed",
      error: "第 " + reserved.attempt + "/" + TOPIC_GENERATION_CLAIM_REMINDER_MAX_ATTEMPTS + " 次：" + String(err?.message ?? err).slice(0, 200)
        + (last ? "；本周期放弃，下个周期再试" + (abandoned?.ok ? "" : "（放弃记录未写上：" + (abandoned?.reason ?? "no_abandon") + "）") : "") } };
  }
  const marked = mark(g.channel_generation_id);
  return { outcome: "reminded", entry: { name, generation: g.generation, attempt: reserved.attempt, recorded: marked.ok === true,
    ...(marked.ok ? {} : { error: "reminder_unrecorded：" + marked.reason }) } };
}

/**
 * 扫一遍登记表里的 Claude 绑定，给进入提醒窗口的待认领话题发提醒。
 * @returns {{ok:boolean, reason?:string, reminded:object[], skipped:object[], problems:object[], dryRun:boolean}}
 */
export function remindClaudePendingClaims({
  registryFile = registryPath(), templateFile, now = Date.now(), publish = publishDraft, dryRun = false,
} = {}) {
  const reg = loadRegistry(registryFile);
  if (!reg.ok) return { ok: false, reason: reg.reason ?? "registry_unreadable", reminded: [], skipped: [], problems: [], dryRun };
  const out = { ok: true, reminded: [], skipped: [], problems: [], dryRun: dryRun === true };
  const seen = new Set();
  for (const project of reg.projects ?? []) {
    const root = project?.root;
    if (typeof root !== "string" || !root) continue;
    const claudeSessionId = project.claude_session_id ?? null;
    const key = root + "\u0000" + (claudeSessionId ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    const name = String(project.name ?? project.id ?? root.split("/").pop());
    const binding = loadClaudeTopicBinding({ root, claudeSessionId, registryFile, templateFile, now });
    if (!binding.ok) {
      // 没有代际状态 = 没轮转过，正常；别的读不出要报。
      if (binding.reason !== "topic_generation_unavailable") out.problems.push({ name, reason: binding.reason });
      continue;
    }
    let r;
    try {
      r = remindOnePendingClaim({
        name: binding.config?.task_display_name ?? name, state: binding.state, now, dryRun: out.dryRun,
        identity: () => (binding.config ? resolveLarkIdentity(binding.config) : null), publish, cancelCommand: "/feishu-rotate cancel",
        reserve: (generationId) => reserveClaudeClaimReminder({ root, claudeSessionId, generationId, registryFile, templateFile, now }),
        mark: (generationId) => markClaudeClaimReminder({ root, claudeSessionId, generationId, registryFile, templateFile, now }),
        abandon: (generationId) => markClaudeClaimReminderAbandoned({ root, claudeSessionId, generationId, registryFile, templateFile, now }),
      });
    } catch (err) {
      // 逐项目的错误边界：一个项目炸了不许终止后面项目的扫描。
      r = { outcome: "problem", entry: { name, reason: "project_scan_failed", error: String(err?.message ?? err).slice(0, 160) } };
    }
    if (r.outcome === "reminded") {
      out.reminded.push(r.entry);
      if (r.entry.recorded === false) out.problems.push({ name: r.entry.name, reason: "reminder_unrecorded", error: r.entry.error });
    } else if (r.outcome === "problem") out.problems.push(r.entry);
    else out.skipped.push(r.entry);
  }
  return out;
}

/** 给兜底日志的一行话；没事时返回 null。 */
export function describeReminderSweep(r, { chain = "Claude" }) {
  if (!r.ok) return chain + " 待认领提醒：登记表读不了（" + r.reason + "）";
  const bits = [];
  if (r.reminded.length > 0) bits.push((r.dryRun ? "[dry-run] 将提醒 " : "已提醒 ") + r.reminded.map((x) => x.name + " 第 " + x.generation + " 代").join("、"));
  if (r.problems.length > 0) bits.push("**提醒有问题**：" + r.problems.map((x) => x.name + "（" + x.reason + (x.error ? "：" + x.error : "") + "）").join("、"));
  return bits.length > 0 ? chain + " 待认领提醒：" + bits.join("；") : null;
}
