/**
 * Aily 原始消息 → bridge Canonical Event v1。
 *
 * Dispatcher 只在内存和子进程环境中传递这个对象。raw_envelope 是为了保证迁移期不丢字段，
 * 不能写进普通日志、用户回执或 Git；handler 只消费规范化字段，确需新字段时先升级契约。
 */

import { extractMentionIds } from "./selector.mjs";

export const CANONICAL_EVENT_SCHEMA_VERSION = "1.0";
export const CANONICAL_EVENT_TYPE = "im.message.receive";
export const CANONICAL_EVENT_ENV = "FEISHU_BRIDGE_CANONICAL_EVENT";

const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const nullableEnv = (env, name) => nonEmpty(env?.[name]) ? env[name] : null;
const nullableString = (value) => value === null || typeof value === "string";

export function validateCanonicalEvent(event) {
  const problems = [];
  if (event?.schema_version !== CANONICAL_EVENT_SCHEMA_VERSION) problems.push("schema_version");
  if (!nonEmpty(event?.event_id)) problems.push("event_id");
  if (event?.event_type !== CANONICAL_EVENT_TYPE) problems.push("event_type");
  if (!nonEmpty(event?.occurred_at) || !Number.isFinite(Date.parse(event.occurred_at))) {
    problems.push("occurred_at");
  }
  if (!nonEmpty(event?.endpoint_id)) problems.push("endpoint_id");
  if (!nonEmpty(event?.source?.session_id)) problems.push("source.session_id");
  for (const field of ["tenant_id", "chat_id", "root_id", "topic_id"]) {
    if (!nullableString(event?.source?.[field])) problems.push("source." + field);
  }
  if (!nonEmpty(event?.actor?.sender_id)) problems.push("actor.sender_id");
  if (!nonEmpty(event?.actor?.caller_agent_uid)) problems.push("actor.caller_agent_uid");
  if (!nullableString(event?.mention?.target_open_id)) problems.push("mention.target_open_id");
  if (!Array.isArray(event?.mention?.target_open_ids) ||
      event.mention.target_open_ids.some((id) => !nonEmpty(id)) ||
      new Set(event.mention.target_open_ids).size !== event.mention.target_open_ids.length) {
    problems.push("mention.target_open_ids");
  }
  if (typeof event?.mention?.is_real !== "boolean") problems.push("mention.is_real");
  if (typeof event?.content?.text !== "string") problems.push("content.text");
  if (event?.content?.origin !== "feishu") problems.push("content.origin");
  if (event?.raw_envelope?.format !== "aily-trigger-event/v1") problems.push("raw_envelope.format");
  if (!Object.hasOwn(event?.raw_envelope ?? {}, "payload")) problems.push("raw_envelope.payload");
  if (!Number.isInteger(event?.extensions?.dispatcher?.fetch_attempts) ||
      event.extensions.dispatcher.fetch_attempts < 0) problems.push("extensions.dispatcher.fetch_attempts");
  if (typeof event?.extensions?.aily_channel?.verified !== "boolean") {
    problems.push("extensions.aily_channel.verified");
  }
  for (const field of ["chat_id", "thread_id"]) {
    if (!nullableString(event?.extensions?.aily_channel?.[field])) {
      problems.push("extensions.aily_channel." + field);
    }
  }
  // `verified: true` 只接受 dispatcher 已把同一 chat locator 同时提升到 canonical source
  // 与诊断 extension 的事件。跨字段相等无法只靠 JSON Schema 表达，必须在运行时再守一遍。
  if (event?.extensions?.aily_channel?.verified === true &&
      (!nonEmpty(event?.source?.chat_id) ||
       event.extensions.aily_channel.chat_id !== event.source.chat_id)) {
    problems.push("extensions.aily_channel.chat_scope");
  }
  return { ok: problems.length === 0, problems };
}

export function buildCanonicalEvent({
  event,
  rawEnvelope,
  endpointId,
  callerAgentUid,
  fetchAttempts = 1,
  env = process.env,
} = {}) {
  const occurred = Number(event?.created_at_ms);
  const mentions = extractMentionIds(event?.content);
  const canonical = {
    schema_version: CANONICAL_EVENT_SCHEMA_VERSION,
    event_id: event?.message_id ?? null,
    event_type: CANONICAL_EVENT_TYPE,
    occurred_at: Number.isFinite(occurred) ? new Date(occurred).toISOString() : null,
    endpoint_id: endpointId ?? null,
    source: {
      // session_id 已由 Aily 事件本身与本轮 AILY_CLI_SESSION_ID 共同约束，是当前稳定热路径主键。
      session_id: event?.session_id ?? null,
      tenant_id: null,
      chat_id: null,
      root_id: null,
      topic_id: null,
    },
    actor: {
      sender_id: event?.sender_id ?? null,
      caller_agent_uid: callerAgentUid ?? null,
    },
    mention: {
      target_open_id: mentions.length === 1 ? mentions[0] : null,
      target_open_ids: mentions,
      is_real: mentions.length > 0,
    },
    content: {
      text: typeof event?.content === "string" ? event.content : "",
      origin: "feishu",
    },
    raw_envelope: {
      format: "aily-trigger-event/v1",
      // 生产 fetch 会带回被选中的原始 Aily envelope；兼容测试/旧继承路径没有时，
      // 至少原样保留 dispatcher 实际收到的旧事件，绝不编造不存在的字段。
      payload: rawEnvelope ?? event ?? null,
    },
    extensions: {
      dispatcher: { fetch_attempts: Number(fetchAttempts) || 0 },
      // 这两个变量目前只有诊断观测，没有完成 locator 稳定性验证。保留值形状供 shadow，
      // 但明确标为 unverified，selector 不能把它们当作授权或路由事实。
      aily_channel: {
        verified: false,
        chat_id: nullableEnv(env, "AILY_CLI_CHANNEL_CHAT_ID"),
        thread_id: nullableEnv(env, "AILY_CLI_CHANNEL_THREAD_ID"),
      },
    },
  };
  const valid = validateCanonicalEvent(canonical);
  return valid.ok ? { ok: true, event: canonical } : { ok: false, reason: "canonical_event_invalid", ...valid };
}

export function inheritedCanonicalEvent(env = process.env) {
  const raw = env?.[CANONICAL_EVENT_ENV];
  if (!nonEmpty(raw)) return null;
  try {
    const event = JSON.parse(raw);
    return validateCanonicalEvent(event).ok ? event : null;
  } catch {
    return null;
  }
}

/** 兼容现有 selector/handler 的最小事件视图；不把 raw_envelope 扩散进业务对象。 */
export function legacyEventFromCanonical(event) {
  if (!validateCanonicalEvent(event).ok) return null;
  return {
    message_id: event.event_id,
    session_id: event.source.session_id,
    sender_id: event.actor.sender_id,
    created_at_ms: Date.parse(event.occurred_at),
    content: event.content.text,
  };
}
