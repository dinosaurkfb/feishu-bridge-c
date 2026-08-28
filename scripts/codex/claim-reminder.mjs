/**
 * Codex 侧的待认领无人认领提醒（不过期；等满 72 小时一次、之后每 7 天一次）—— 判据、流程（预留 → 发 → 记）与文案共用 claim-reminder.mjs / topic-generation.mjs，
 * 这里只负责按 task 登记表枚举、用 Codex 模板身份发、在 task 状态里预留与记。
 */

import { publishDraft } from "../outbound.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { remindOnePendingClaim } from "../claim-reminder.mjs";
import {
  bridgeHome, loadCodexTemplate, loadRegistry, markTaskClaimReminder, markTaskClaimReminderAbandoned, registryFile,
  reserveTaskClaimReminder, templateFile as codexTemplateFile, topicStateForTask,
} from "./state.mjs";

export function remindCodexPendingClaims({
  home = bridgeHome(), templateFile, now = Date.now(), publish = publishDraft, dryRun = false,
} = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return { ok: false, reason: reg.reason ?? "registry_unreadable", reminded: [], skipped: [], problems: [], dryRun };
  const out = { ok: true, reminded: [], skipped: [], problems: [], dryRun: dryRun === true };
  // 身份惰性解析、只解析一次；模板必须跟 home 同源 —— 传了 home 却读默认模板，测试里就是真机凭据（实测抓到过）。
  let identity = null;
  const resolveIdentity = () => {
    if (identity !== null) return identity;
    const tpl = loadCodexTemplate(templateFile ?? codexTemplateFile(home));
    if (!tpl.ok) throw Object.assign(new Error(String(tpl.reason)), { reason: "template_unavailable" });
    identity = resolveLarkIdentity(tpl.template);
    return identity;
  };
  for (const task of reg.tasks ?? []) {
    const name = String(task?.task_display_name ?? task?.logical_task_key ?? "?");
    let r;
    try {
      const topic = topicStateForTask(task, { now });
      if (!topic.ok) { out.problems.push({ name, reason: topic.reason ?? "topic_state_unreadable" }); continue; }
      r = remindOnePendingClaim({
        name, state: topic.state, now, dryRun: out.dryRun, identity: resolveIdentity, publish, cancelCommand: "$feishu-rotate cancel",
        reserve: (generationId) => reserveTaskClaimReminder({ threadId: task.codex_thread_id, generationId, home, now }),
        mark: (generationId) => markTaskClaimReminder({ threadId: task.codex_thread_id, generationId, home, now }),
        abandon: (generationId) => markTaskClaimReminderAbandoned({ threadId: task.codex_thread_id, generationId, home, now }),
      });
    } catch (err) {
      r = { outcome: "problem", entry: { name, reason: "task_scan_failed", error: String(err?.message ?? err).slice(0, 160) } };
    }
    if (r.outcome === "reminded") {
      out.reminded.push(r.entry);
      if (r.entry.recorded === false) out.problems.push({ name, reason: "reminder_unrecorded", error: r.entry.error });
    } else if (r.outcome === "problem") out.problems.push(r.entry);
    else out.skipped.push(r.entry);
  }
  return out;
}
