/**
 * 待认领话题的**快过期提醒**（FR-8 补充，2026-08-28 Frank 要求）。
 *
 * 新话题建好后要等人在里面 @ 一下才算认领；没人认领的话它会在 claim_expires_at 过期并 fail-closed。
 * 这里在截止前 TOPIC_GENERATION_CLAIM_REMINDER_LEAD_MS 内、且还没人认领时，**在那个待认领话题下**
 * 回复一条提醒，**只提醒一次**（提醒后把 claim_reminder_at 记进代际状态）。
 *
 * 判据只有一份：该不该提醒由 topic-generation.claimReminderDue 决定；本模块只负责发与记。
 * 顺序是**先发后记**：记不上会在下一轮（30 分钟）再发一次 —— 有上界（窗口内最多几次），
 * 而"先记后发"若发失败就永远不提醒；两害相权取前者，并把记不上的情况报出来。
 * publish 可注入 —— 测试不许打到真实飞书。
 */

import { publishDraft } from "./outbound.mjs";
import { loadRegistry, registryPath } from "./registry.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { loadClaudeTopicBinding, markClaudeClaimReminder } from "./topic-generation-store.mjs";
import { claimReminderDue } from "./topic-generation.mjs";

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
    "本提醒只发这一次。",
  ].join("\n");
}

/**
 * 扫一遍登记表里的 Claude 绑定，给进入提醒窗口的待认领话题各发一次提醒。
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
    const due = claimReminderDue(binding.state, { now });
    if (!due.due) { out.skipped.push({ name, reason: due.reason }); continue; }
    const g = due.generation;
    if (out.dryRun) { out.reminded.push({ name, generation: g.generation, dryRun: true }); continue; }
    if (!binding.config) { out.problems.push({ name, reason: "config_unavailable" }); continue; }
    const text = composeClaimReminderText({
      name: binding.config.task_display_name ?? name, generation: g.generation,
      remainingMs: due.remainingMs, deadlineIso: g.claim_expires_at,
    });
    let identity;
    try { identity = resolveLarkIdentity(binding.config); }
    catch (err) { out.problems.push({ name, reason: "identity_unavailable", error: String(err?.message ?? err).slice(0, 120) }); continue; }
    try {
      publish({ profile: identity.profile, rootMessageId: g.root_message_id, text,
        larkBin: identity.bin, larkHome: identity.configDir, expectedAppId: identity.expectedAppId });
    } catch (err) {
      out.problems.push({ name, reason: "publish_failed", error: String(err?.message ?? err).slice(0, 200) });
      continue;
    }
    const marked = markClaudeClaimReminder({ root, claudeSessionId, generationId: g.channel_generation_id, registryFile, now });
    if (!marked.ok) out.problems.push({ name, reason: "reminder_unrecorded", error: marked.reason });
    out.reminded.push({ name, generation: g.generation, recorded: marked.ok === true });
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
