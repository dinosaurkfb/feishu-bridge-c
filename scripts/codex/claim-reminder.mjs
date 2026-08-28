/**
 * Codex 侧的待认领快过期提醒 —— 判据、流程（预留 → 发 → 记）与文案共用 claim-reminder.mjs / topic-generation.mjs，
 * 这里只负责按 task 登记表枚举、用 Codex 模板身份发、在 task 状态里预留与记。
 */

import { publishDraft } from "../outbound.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { remindOnePendingClaim } from "../claim-reminder.mjs";
import { claimReminderDue } from "../topic-generation.mjs";
import {
  bridgeHome, loadCodexTemplate, loadRegistry, markTaskClaimReminder, registryFile, reserveTaskClaimReminder,
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
    if (identity === null && !out.dryRun && claimReminderDue(topic.state, { now }).due) {
      // 模板必须跟 home 同源 —— 传了 home 却读默认模板，测试里就是真机凭据（实测抓到过）。
      const tpl = loadCodexTemplate(templateFile ?? codexTemplateFile(home));
      if (!tpl.ok) { out.problems.push({ name, reason: "template_unavailable", error: tpl.reason }); continue; }
      identity = resolveLarkIdentity(tpl.template);
    }
    const r = remindOnePendingClaim({
      name, state: topic.state, now, dryRun: out.dryRun, identity, publish,
      reserve: (generationId) => reserveTaskClaimReminder({ threadId: task.codex_thread_id, generationId, home, now }),
      mark: (generationId) => markTaskClaimReminder({ threadId: task.codex_thread_id, generationId, home, now }),
    });
    if (r.outcome === "reminded") {
      out.reminded.push(r.entry);
      if (r.entry.recorded === false) out.problems.push({ name, reason: "reminder_unrecorded", error: r.entry.error });
    } else if (r.outcome === "problem") out.problems.push(r.entry);
    else out.skipped.push(r.entry);
  }
  return out;
}
