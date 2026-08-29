/**
 * Subscription v1 的公共只读模型与首次认领 shadow selector。
 *
 * 这个切片刻意不写新的控制面文件，也不替换旧路由：Claude/Codex adapter 把现有 registry
 * 投影为同一份 read model，候选 selector 消费它并与旧结果比较。只有比较经过真实样本验证后，
 * 后续 PR 才能按 endpoint 灰度切流。
 */

import crypto from "node:crypto";
import { roleEntriesProblem, senderRolesProblem, senderTable } from "./sender-roles.mjs";

export const SUBSCRIPTION_SCHEMA_VERSION = "1.0";
export const SUBSCRIPTION_ARTIFACT_TYPE = "feishu_bridge_subscription";
export const MESSAGE_RECEIVE_EVENT = "im.message.receive";

export const SUBSCRIPTION_REJECT = Object.freeze({
  PROJECTION_INVALID: "subscription_projection_invalid",
  ENDPOINT_MISMATCH: "endpoint_mismatch",
  NO_ACTIVE_SUBSCRIPTION: "no_active_subscription",
  AGENT_MISMATCH: "agent_mismatch",
  SENDER_NOT_ALLOWED: "sender_not_allowed",
  MENTION_REQUIRED: "transport_not_mentioned",
  SOURCE_SCOPE_MISMATCH: "source_scope_mismatch",
  STALE_EVENT: "stale_event",
  NO_PENDING_BINDING: "no_pending_binding",
  NOT_FOUND: "subscription_not_found",
  AMBIGUOUS: "subscription_ambiguous",
  TOKEN_UNKNOWN: "binding_token_unknown",
  TOKEN_AMBIGUOUS: "binding_token_ambiguous",
  TOKEN_DUPLICATED: "pending_binding_token_duplicated",
  PENDING_EXPIRED: "pending_binding_expired",
  MALFORMED_EVENT: "malformed_event",
});

const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const uniqueStrings = (values) => [...new Set((values ?? []).filter(nonEmpty))].sort();

/** 只生成稳定 opaque id；输出里不携带项目路径、thread/session locator 或人员原值。 */
export function stableControlId(kind, ...parts) {
  const digest = crypto.createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 24);
  return kind + "_" + digest;
}

export function legacyEndpointId({ runtime, agentUid }) {
  return stableControlId("endpoint", runtime, agentUid);
}

export function validateSubscription(subscription) {
  const problems = [];
  if (subscription?.schema_version !== SUBSCRIPTION_SCHEMA_VERSION) problems.push("schema_version");
  if (subscription?.artifact_type !== SUBSCRIPTION_ARTIFACT_TYPE) problems.push("artifact_type");
  for (const field of ["subscription_id", "endpoint_id", "domain_id"]) {
    if (!nonEmpty(subscription?.[field])) problems.push(field);
  }
  if (!Number.isInteger(subscription?.version) || subscription.version <= 0) problems.push("version");
  if (!["active", "paused"].includes(subscription?.status)) problems.push("status");
  const scope = subscription?.scope;
  if (!nonEmpty(scope?.agent_uid)) problems.push("scope.agent_uid");
  if (!nonEmpty(scope?.transport_open_id)) problems.push("scope.transport_open_id");
  if (!nonEmpty(scope?.chat_id)) problems.push("scope.chat_id");
  if (uniqueStrings(scope?.sender_ids).length !== scope?.sender_ids?.length || !scope?.sender_ids?.length) {
    problems.push("scope.sender_ids");
  }
  if (uniqueStrings(scope?.event_types).length !== scope?.event_types?.length || !scope?.event_types?.length) {
    problems.push("scope.event_types");
  }
  // sender_roles 可选；在场就必须封闭、不重复、角色在枚举里，且每个 sender_ids 里的 id 都得在表里（sender_ids 是授权基准，表不能少它）
  // 与模板同一份核心校验（sender-roles.mjs），owner 基准就是 sender_ids：owner 集合必须精确一致、字段取值域封闭。旧制品不带 sender_roles 仍接受。
  if (scope?.sender_roles !== undefined &&
      roleEntriesProblem(scope.sender_roles, { ownerIds: scope?.sender_ids ?? [], ownerRequired: true, name: "scope.sender_roles" }) !== null) {
    problems.push("scope.sender_roles");
  }
  if (typeof subscription?.constraints?.freshness_ms !== "number" ||
      !Number.isFinite(subscription.constraints.freshness_ms) || subscription.constraints.freshness_ms <= 0) {
    problems.push("constraints.freshness_ms");
  }
  return { ok: problems.length === 0, problems };
}

// 待认领不过期：只有登记行写了显式截止才有 claim_expires_at_ms，否则 null（= 永不过期）。
// pendingWindowMs 只在调用方**要求**按接入时间推截止时才用（null / 省略 = 不推）。
const pendingDeadline = (record, pendingWindowMs) => {
  const explicit = Date.parse(record?.pending_expires_at ?? "");
  if (Number.isFinite(explicit)) return explicit;
  if (typeof pendingWindowMs !== "number") return null;
  const bound = Date.parse(record?.bound_at ?? "");
  return Number.isFinite(bound) ? bound + pendingWindowMs : 0;
};

/**
 * 把 runtime adapter 提供的旧登记投影为公共只读模型。
 *
 * records 只允许携带公共核心需要的 opaque key；Codex thread id、Claude session id 等 locator
 * 不得传进来。domain_key 是控制面的项目/业务域 locator，只用于当场派生 domain_id，不进入结果。
 */
export function buildLegacySubscriptionReadModel({
  runtime, endpointId, template, records, pendingWindowMs,
} = {}) {
  const problems = [];
  if (!nonEmpty(runtime)) problems.push("runtime");
  if (!nonEmpty(endpointId)) problems.push("endpoint_id");
  if (!nonEmpty(template?.agent_uid)) problems.push("template.agent_uid");
  if (!nonEmpty(template?.transport_open_id)) problems.push("template.transport_open_id");
  if (!nonEmpty(template?.frank_sender_id)) problems.push("template.frank_sender_id");
  // senders 在场但不合法 → 投影不可用；owner 基准不是数字（旧登记）且没写 senders → 合法但不生成 sender_roles
  if (nonEmpty(template?.frank_sender_id) && template?.senders !== undefined && template?.senders !== null && senderRolesProblem(template) !== null) problems.push("template.senders");
  if (!nonEmpty(template?.chat_id)) problems.push("template.chat_id");
  if (typeof template?.default_freshness_ms !== "number" ||
      !Number.isFinite(template.default_freshness_ms) || template.default_freshness_ms <= 0) {
    problems.push("template.default_freshness_ms");
  }
  if (!Array.isArray(records)) problems.push("records");
  if (pendingWindowMs !== undefined && pendingWindowMs !== null &&
      (typeof pendingWindowMs !== "number" || !Number.isFinite(pendingWindowMs) || pendingWindowMs <= 0)) {
    problems.push("pending_window_ms");
  }
  if (problems.length) return { ok: false, reason: SUBSCRIPTION_REJECT.PROJECTION_INVALID, problems };

  const subscriptions = new Map();
  const pendingBindings = [];
  for (const record of records) {
    const recordProblems = [];
    for (const field of ["legacy_key", "domain_key", "local_target_id"]) {
      if (!nonEmpty(record?.[field])) recordProblems.push(field);
    }
    const chatId = record?.chat_id ?? template.chat_id;
    if (!nonEmpty(chatId)) recordProblems.push("chat_id");
    if (recordProblems.length) {
      problems.push("record:" + recordProblems.join(","));
      continue;
    }

    const domainId = stableControlId("domain", runtime, record.domain_key);
    const subscriptionId = stableControlId(
      "subscription", endpointId, domainId, chatId, template.agent_uid,
    );
    const active = (record.status ?? "active") === "active";
    const existing = subscriptions.get(subscriptionId);
    if (!existing) {
      subscriptions.set(subscriptionId, {
        schema_version: SUBSCRIPTION_SCHEMA_VERSION,
        artifact_type: SUBSCRIPTION_ARTIFACT_TYPE,
        subscription_id: subscriptionId,
        version: 1,
        endpoint_id: endpointId,
        domain_id: domainId,
        status: active ? "active" : "paused",
        scope: {
          agent_uid: template.agent_uid,
          transport_open_id: template.transport_open_id,
          chat_id: chatId,
          sender_ids: uniqueStrings([template.frank_sender_id]),
          // 角色表：sender_ids（binding 授权快照的基准）仍只有 owner；operator / participant 的入站由 risk-class × authorize 判定，不进 sender_ids。
          ...(senderTable(template) !== null ? { sender_roles: senderTable(template) } : {}),
          event_types: [MESSAGE_RECEIVE_EVENT],
        },
        constraints: { freshness_ms: template.default_freshness_ms },
      });
    } else if (active) {
      existing.status = "active";
    }

    const token = record.pending_token == null ? null : String(record.pending_token).toLowerCase();
    if (token !== null && !/^[0-9a-f]{6}$/u.test(token)) {
      problems.push("record:pending_token");
      continue;
    }
    pendingBindings.push({
      subscription_id: subscriptionId,
      legacy_key: record.legacy_key,
      local_target_id: record.local_target_id,
      status: active ? "active" : "paused",
      inbound_state: record.inbound_state ?? "pending",
      session_bound: nonEmpty(record.session_id),
      pending_token: token,
      claim_expires_at_ms: pendingDeadline(record, pendingWindowMs),
    });
  }

  const projected = [...subscriptions.values()];
  for (const subscription of projected) {
    const valid = validateSubscription(subscription);
    if (!valid.ok) problems.push("subscription:" + valid.problems.join(","));
  }
  if (problems.length) return { ok: false, reason: SUBSCRIPTION_REJECT.PROJECTION_INVALID, problems };
  return {
    ok: true,
    schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    projection: "legacy-read-only",
    runtime,
    endpoint_id: endpointId,
    subscriptions: projected,
    pending_bindings: pendingBindings,
  };
}

const reject = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/**
 * 新模型的首次认领候选。它只计算，不 claim、不写 registry、不投递。
 * `evidence.chat_id` 尚未由现有 Aily envelope 稳定提供时，兼容路径会继续计算并显式标记
 * `scope_unverified: ["chat_id"]`；因此该结果只能用于 shadow，不能直接成为切流依据。
 */
/**
 * 这条 pending binding 现在还能被认领吗。
 *
 * **展示和热路径必须用同一个判据。**曾经展示层直接取 pending_bindings.length，
 * 而那个数组里躺着已绑定、暂停、过期的记录 —— 于是一个绑好的项目也会显示"待认领"，
 * 让人以为还有一步没做完。
 */
export function claimable(binding, now = Date.now()) {
  if (!binding || binding.status !== "active") return false;
  if (binding.inbound_state !== "pending") return false;
  if (binding.session_bound) return false;
  const deadline = binding.claim_expires_at_ms;
  return !Number.isFinite(deadline) || now < deadline;
}

export function selectPendingSubscriptionClaim({ model, evidence, bindingTokens = [], now = Date.now() } = {}) {
  if (!model?.ok) return reject(model?.reason ?? SUBSCRIPTION_REJECT.PROJECTION_INVALID);
  if (model.schema_version !== SUBSCRIPTION_SCHEMA_VERSION ||
      !Array.isArray(model.subscriptions) ||
      model.subscriptions.some((subscription) =>
        subscription.version !== 1 || !validateSubscription(subscription).ok)) {
    return reject(SUBSCRIPTION_REJECT.PROJECTION_INVALID);
  }
  if (!nonEmpty(evidence?.endpoint_id) || !nonEmpty(evidence?.caller_agent_uid) ||
      !nonEmpty(evidence?.sender_id) || !Array.isArray(evidence?.mention_ids) ||
      !nonEmpty(evidence?.event_type) || !Number.isFinite(Number(evidence?.created_at_ms))) {
    return reject(SUBSCRIPTION_REJECT.MALFORMED_EVENT);
  }

  let candidates = model.subscriptions.filter(
    (subscription) => subscription.endpoint_id === evidence.endpoint_id,
  );
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.ENDPOINT_MISMATCH);
  candidates = candidates.filter((subscription) => subscription.status === "active");
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.NO_ACTIVE_SUBSCRIPTION);
  candidates = candidates.filter((subscription) => subscription.scope.agent_uid === evidence.caller_agent_uid);
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.AGENT_MISMATCH);
  candidates = candidates.filter((subscription) => subscription.scope.sender_ids.includes(evidence.sender_id));
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.SENDER_NOT_ALLOWED);
  candidates = candidates.filter((subscription) => subscription.scope.event_types.includes(evidence.event_type));
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.NOT_FOUND);
  candidates = candidates.filter((subscription) =>
    evidence.mention_ids.includes(subscription.scope.transport_open_id));
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.MENTION_REQUIRED);

  const created = Number(evidence.created_at_ms);
  candidates = candidates.filter((subscription) =>
    now - created <= subscription.constraints.freshness_ms);
  if (!candidates.length) return reject(SUBSCRIPTION_REJECT.STALE_EVENT);

  const scopeUnverified = [];
  if (nonEmpty(evidence.chat_id)) {
    candidates = candidates.filter((subscription) => subscription.scope.chat_id === evidence.chat_id);
    if (!candidates.length) return reject(SUBSCRIPTION_REJECT.SOURCE_SCOPE_MISMATCH);
  } else {
    scopeUnverified.push("chat_id");
  }

  const subscriptionIds = new Set(candidates.map((subscription) => subscription.subscription_id));
  const pending = model.pending_bindings.filter((binding) =>
    subscriptionIds.has(binding.subscription_id) && claimable(binding, now));

  const tokens = uniqueStrings(bindingTokens.map((token) => String(token).toLowerCase()));
  if (tokens.length > 1) return reject(SUBSCRIPTION_REJECT.TOKEN_AMBIGUOUS);
  let selected;
  if (tokens.length === 1) {
    const hits = pending.filter((binding) => binding.pending_token === tokens[0]);
    if (!hits.length) return reject(SUBSCRIPTION_REJECT.TOKEN_UNKNOWN);
    if (hits.length > 1) return reject(SUBSCRIPTION_REJECT.TOKEN_DUPLICATED);
    selected = hits[0];
  } else {
    if (!pending.length) return reject(SUBSCRIPTION_REJECT.NO_PENDING_BINDING);
    if (pending.length > 1) return reject(SUBSCRIPTION_REJECT.AMBIGUOUS);
    selected = pending[0];
  }
  if (Number.isFinite(selected.claim_expires_at_ms) && now >= selected.claim_expires_at_ms) {
    return reject(SUBSCRIPTION_REJECT.PENDING_EXPIRED);
  }

  return {
    ok: true,
    disposition: "accepted",
    subscription_id: selected.subscription_id,
    local_target_id: selected.local_target_id,
    legacy_key: selected.legacy_key,
    matched_by: tokens.length === 1 ? "quoted_binding_token" : "sole_pending",
    scope_unverified: scopeUnverified,
  };
}

/** 比较选路/授权结果；reason 文案变化单独报告，但只有结果或目标变化才算数据面不一致。 */
export function compareFirstClaimShadow({ legacy, candidate } = {}) {
  const legacyAccepted = legacy?.ok === true;
  const candidateAccepted = candidate?.ok === true;
  const dispositionMatch = legacyAccepted === candidateAccepted;
  const targetMatch = !legacyAccepted || !candidateAccepted || legacy.target_key === candidate.legacy_key;
  const reasonMatch = legacyAccepted && candidateAccepted
    ? true
    : (legacy?.reason ?? "unknown") === (candidate?.reason ?? "unknown");
  const routeMatch = dispositionMatch && targetMatch;
  return {
    schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    mode: "shadow",
    match: routeMatch && reasonMatch,
    route_match: routeMatch,
    disposition_match: dispositionMatch,
    target_match: targetMatch,
    legacy_disposition: legacyAccepted ? "accepted" : "rejected",
    candidate_disposition: candidateAccepted ? "accepted" : "rejected",
    legacy_reason: legacyAccepted ? null : (legacy?.reason ?? "unknown"),
    candidate_reason: candidateAccepted ? null : (candidate?.reason ?? "unknown"),
    reason_match: reasonMatch,
    candidate_subscription_id: candidateAccepted ? candidate.subscription_id : null,
    scope_unverified: candidate?.scope_unverified ?? [],
  };
}
