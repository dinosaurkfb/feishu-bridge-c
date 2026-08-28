/**
 * 待认领话题的**快过期提醒**（FR-8 补充，2026-08-28 Frank 要求）。
 *
 * 新话题建好后要等人在里面 @ 一下才算认领；没人认领的话它会在 claim_expires_at 过期并 fail-closed。
 * 这里在截止前 TOPIC_GENERATION_CLAIM_REMINDER_LEAD_MS 内、且还没人认领时，**在那个待认领话题下**
 * 回复一条提醒。
 *
 * 语义是**至少一次、有上界**，不是"严格一次"（飞书侧没有幂等依据）：
 *   1. 锁外用 claimReminderDue 预筛；
 *   2. 锁内 reserveClaimReminderAttempt 预留这次尝试（attempts+1、attempted_at 持久化）——
 *      并发的第二个扫描器拿到 retry_too_soon，不会再发；
 *   3. 发布；
 *   4. 成功再 markPendingClaimReminder 记 claim_reminder_at，从此不再提醒。
 * 发布失败：attempts 留着，≥ RETRY_MS 后的下一轮兜底再试，最多 MAX_ATTEMPTS 次，之后报 reminder_abandoned。
 * 判据只有一份（topic-generation.mjs）；本模块只负责发与记。publish 可注入 —— 测试不许打到真实飞书。
 */

import { publishDraft } from "./outbound.mjs";
import { loadRegistry, registryPath } from "./registry.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import {
  loadClaudeTopicBinding, markClaudeClaimReminder, reserveClaudeClaimReminder,
} from "./topic-generation-store.mjs";
import { TOPIC_GENERATION_CLAIM_REMINDER_MAX_ATTEMPTS, claimReminderDue } from "./topic-generation.mjs";

const hours = (ms) => Math.max(1, Math.round(ms / 3600000));

/** 提醒正文：不带 locator，只说清"哪一代、还剩多久、怎么认领、过期后怎么办"。 */
export function composeClaimReminderText({ name, generation, remainingMs, deadlineIso }) {
  return [
    "⏰ 这个话题还没有人认领 —— " + name + " · 第 " + generation + " 代",
    "",
    "认领截止：" + deadlineIso + "（还剩约 " + hours(remainingMs) + " 小时）。",
    "认领方式：在这条消息下面 @ 一下运输 agent（空消息也行），绑定就完成了。",
    "过期后这个话题作废，需要重新轮转（/feishu-rotate 或 $feishu-rotate）才有新话题。",
    "",
    "这条提醒不会反复发。",
  ].join("\n");
}

/**
 * 一个待认领代际的完整提醒流程：预留 → 发 → 记。两条链共用；差异（怎么预留、怎么记、用谁的身份）由参数注入。
 * @returns {{outcome:"reminded"|"skipped"|"problem", entry:object}}
 */
export function remindOnePendingClaim({ name, state, now, dryRun, reserve, publish, mark, identity }) {
  const due = claimReminderDue(state, { now });
  if (!due.due) {
    if (due.reason === "attempts_exhausted") {
      return { outcome: "problem", entry: { name, reason: "reminder_abandoned", error: "发送失败 " + due.attempts + " 次，已放弃" } };
    }
    return { outcome: "skipped", entry: { name, reason: due.reason } };
  }
  const g = due.generation;
  if (dryRun) return { outcome: "reminded", entry: { name, generation: g.generation, dryRun: true } };
  const reserved = reserve(g.channel_generation_id);
  if (!reserved.ok) {
    // 锁内重算没通过：多半是另一个扫描器刚拿走了这次尝试（retry_too_soon）；别的原因也一样只是跳过。
    return { outcome: "skipped", entry: { name, reason: reserved.reason } };
  }
  const text = composeClaimReminderText({
    name, generation: g.generation, remainingMs: reserved.remainingMs ?? due.remainingMs, deadlineIso: g.claim_expires_at,
  });
  try {
    publish({ profile: identity.profile, rootMessageId: g.root_message_id, text,
      larkBin: identity.bin, larkHome: identity.configDir, expectedAppId: identity.expectedAppId });
  } catch (err) {
    return { outcome: "problem", entry: { name, reason: "publish_failed",
      error: "第 " + reserved.attempt + "/" + TOPIC_GENERATION_CLAIM_REMINDER_MAX_ATTEMPTS + " 次：" + String(err?.message ?? err).slice(0, 200) } };
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
    if (!binding.config && !out.dryRun && claimReminderDue(binding.state, { now }).due) {
      out.problems.push({ name, reason: "config_unavailable" });
      continue;
    }
    const r = remindOnePendingClaim({
      name: binding.config?.task_display_name ?? name, state: binding.state, now, dryRun: out.dryRun,
      identity: binding.config ? resolveLarkIdentity(binding.config) : null, publish,
      reserve: (generationId) => reserveClaudeClaimReminder({ root, claudeSessionId, generationId, registryFile, templateFile, now }),
      mark: (generationId) => markClaudeClaimReminder({ root, claudeSessionId, generationId, registryFile, templateFile, now }),
    });
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
