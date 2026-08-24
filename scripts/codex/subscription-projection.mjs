/**
 * Codex 链的订阅投影 —— 第 2 层（事件订阅）的事实来源。
 *
 * **核心是共用的。**`buildLegacySubscriptionReadModel` 两条链用同一个；
 * 各自要做的只是把自己的登记表翻译成它要的 records。
 * Claude 侧翻译 projects，这里翻译 tasks —— 差别只在"绑定长什么样"，
 * 判断订阅是否活动、待认领有几条、授权发送者是谁，都归那一个核心。
 *
 * 各写一份的话，两条链对"订阅活动"的判断迟早会分叉，
 * 而那种分叉最难查：两边状态页都说自己正常。
 */

import {
  buildLegacySubscriptionReadModel, legacyEndpointId, stableControlId,
} from "../subscription.mjs";
import { pendingGeneration } from "../topic-generation.mjs";
import { bridgeHome, loadCodexTemplate, loadRegistry, registryFile } from "./state.mjs";

/** 跟 Claude 侧同一个窗口口径。 */
export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function buildCodexSubscriptionProjection({
  home = bridgeHome(), threadId = null,
} = {}) {
  const registry = loadRegistry(registryFile(home));
  if (!registry.ok) return { ok: false, reason: "registry_unreadable" };
  const loaded = loadCodexTemplate();
  if (!loaded.ok) return { ok: false, reason: "template_unusable" };
  const template = loaded.template;
  const endpointId = legacyEndpointId({ runtime: "codex", agentUid: template.agent_uid });

  const records = [];
  for (const task of registry.tasks ?? []) {
    // 传了 threadId 就只投影那一条 —— status 说"当前上下文"，
    // 就不能把别的 task 的订阅和待认领计数算进来。
    if (threadId !== null && task.codex_thread_id !== threadId) continue;
    const state = task.topic_generation_state ?? null;
    const pending = pendingGeneration(state);
    const active = state?.generations?.find(
      (generation) => generation.channel_generation_id === state.active_generation_id);
    records.push({
      legacy_key: task.id ?? task.logical_task_key,
      domain_key: task.codex_thread_id ?? task.logical_task_key,
      local_target_id: stableControlId("target", "codex",
        task.id ?? task.logical_task_key, "task"),
      status: task.status ?? "active",
      // 有待认领代际时，这条的入站就是"待认领"——跟 Claude 侧同一口径。
      inbound_state: pending ? "pending" : (task.inbound_state ?? "bound"),
      session_id: pending ? null : (active?.session_id ?? task.session_id ?? null),
      pending_token: pending?.pending_token ?? task.pending_token ?? null,
      pending_expires_at: pending?.claim_expires_at ?? task.pending_expires_at ?? null,
      bound_at: pending?.created_at ?? task.bound_at,
      chat_id: task.chat_id ?? template.chat_id,
    });
  }

  return buildLegacySubscriptionReadModel({
    runtime: "codex", endpointId, template, records, pendingWindowMs: PENDING_WINDOW_MS,
  });
}
