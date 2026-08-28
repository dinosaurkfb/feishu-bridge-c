/**
 * Codex 侧的待认领快过期提醒 —— 判据与文案共用 claim-reminder.mjs / topic-generation.mjs，
 * 这里只负责按 task 登记表枚举、用 Codex 模板身份发、在 task 状态里记。
 */

import { publishDraft } from "../outbound.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { claimReminderDue } from "../topic-generation.mjs";
import { composeClaimReminderText } from "../claim-reminder.mjs";
import {
  bridgeHome, loadCodexTemplate, loadRegistry, markTaskClaimReminder, registryFile,
  templateFile as codexTemplateFile, topicStateForTask,
} from "./state.mjs";

export function remindCodexPendingClaims({
  home = bridgeHome(), templateFile, now = Date.now(), publish = publishDraft, dryRun = false,
} = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return { ok: false, reason: reg.reason ?? "registry_unreadable", reminded: [], skipped: [], problems: [], dryRun };
  const out = { ok: true, reminded: [], skipped: [], problems: [], dryRun: dryRun === true };
  let identity = null;
  for (const task of reg.tasks ?? []) {
    const name = String(task?.task_display_name ?? task?.logical_task_key ?? "?");
    const topic = topicStateForTask(task, { now });
    if (!topic.ok) { out.problems.push({ name, reason: topic.reason ?? "topic_state_unreadable" }); continue; }
    const due = claimReminderDue(topic.state, { now });
    if (!due.due) { out.skipped.push({ name, reason: due.reason }); continue; }
    const g = due.generation;
    const text = composeClaimReminderText({ name, generation: g.generation, remainingMs: due.remainingMs, deadlineIso: g.claim_expires_at });
    if (out.dryRun) { out.reminded.push({ name, generation: g.generation, dryRun: true }); continue; }
    if (identity === null) {
      const tpl = loadCodexTemplate(templateFile ?? codexTemplateFile(home));
      if (!tpl.ok) { out.problems.push({ name, reason: "template_unavailable", error: tpl.reason }); continue; }
      try { identity = resolveLarkIdentity(tpl.template); }
      catch (err) { out.problems.push({ name, reason: "identity_unavailable", error: String(err?.message ?? err).slice(0, 120) }); continue; }
    }
    try {
      publish({ profile: identity.profile, rootMessageId: g.root_message_id, text,
        larkBin: identity.bin, larkHome: identity.configDir, expectedAppId: identity.expectedAppId });
    } catch (err) {
      out.problems.push({ name, reason: "publish_failed", error: String(err?.message ?? err).slice(0, 200) });
      continue;
    }
    const marked = markTaskClaimReminder({ threadId: task.codex_thread_id, generationId: g.channel_generation_id, home, now });
    if (!marked.ok) out.problems.push({ name, reason: "reminder_unrecorded", error: marked.reason });
    out.reminded.push({ name, generation: g.generation, recorded: marked.ok === true });
  }
  return out;
}
