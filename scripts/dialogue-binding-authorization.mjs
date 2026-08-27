/**
 * Dialogue Slice B：已绑定通道的授权快照与只读 shadow 判定。
 *
 * 本模块只做纯计算。私有 binding/chat/sender/open_id 只作为派生输入，绝不进入返回 artifact；
 * adapter 仍以现有精确 session -> binding 路由为唯一权威，candidate 只能比较，不能 dispatch。
 */

import crypto from "node:crypto";

import { validateCanonicalEvent } from "./canonical-event.mjs";
import {
  deriveDialogueBindingRef, deriveDialogueParticipantRef,
} from "./dialogue-participant-planner.mjs";
import { validateSubscription } from "./subscription.mjs";
import { REJECT } from "./selector.mjs";

export const BINDING_AUTHORIZATION_SCHEMA_VERSION = "1.0";
export const BINDING_AUTHORIZATION_ARTIFACT_TYPE =
  "feishu_bridge_dialogue_binding_authorization_snapshot";
export const BOUND_AUTHORIZATION_SHADOW_SCHEMA_VERSION = "1.0";
export const BOUND_AUTHORIZATION_SHADOW_ARTIFACT_TYPE =
  "feishu_bridge_dialogue_bound_authorization_shadow";
export const BOUND_AUTHORIZATION_EVALUATOR_VERSION = "1.0";

export const BINDING_AUTHORIZATION_STATUS = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
});

export const BINDING_AUTHORIZATION_REASON = Object.freeze({
  INVALID_INPUT: "binding_authorization_input_invalid",
  INVALID_SNAPSHOT: "binding_authorization_snapshot_invalid",
  PROJECTION_INVALID: "binding_authorization_projection_invalid",
  BINDING_NOT_FOUND: "binding_authorization_binding_not_found",
  BINDING_AMBIGUOUS: "binding_authorization_binding_ambiguous",
  SUBSCRIPTION_NOT_FOUND: "binding_authorization_subscription_not_found",
  SUBSCRIPTION_AMBIGUOUS: "binding_authorization_subscription_ambiguous",
  SUBSCRIPTION_PAUSED: "subscription_paused",
  BINDING_PAUSED: "binding_paused",
  // 订阅被撤销 / 不再覆盖这条 binding：授权被收回（FR-2.5 落盘，评审定案的形状）。
  SUBSCRIPTION_REVOKED: "subscription_revoked",
  CANONICAL_INVALID: "canonical_event_invalid",
  BINDING_MISMATCH: "binding_ref_mismatch",
  ENDPOINT_MISMATCH: "endpoint_mismatch",
  EVENT_TYPE_MISMATCH: "event_type_mismatch",
  SENDER_NOT_ALLOWED: "sender_not_allowed",
  MENTION_REQUIRED: "transport_not_mentioned",
  CHAT_SCOPE_UNVERIFIED: "chat_scope_unverified",
  CHAT_SCOPE_MISMATCH: "chat_scope_mismatch",
  STALE_EVENT: "stale_event",
});

const SNAPSHOT_ID_PATTERN = /^binding_authorization_[0-9a-f]{24}$/u;
const SHADOW_ID_PATTERN = /^authorization_shadow_[0-9a-f]{24}$/u;
const EVENT_REF_PATTERN = /^event_ref_[0-9a-f]{24}$/u;
const BINDING_REF_PATTERN = /^binding_ref_[0-9a-f]{24}$/u;
const PARTICIPANT_REF_PATTERN = /^participant_ref_[0-9a-f]{24}$/u;
const CHAT_SCOPE_REF_PATTERN = /^chat_scope_ref_[0-9a-f]{24}$/u;
const SUBSCRIPTION_ID_PATTERN = /^subscription_[0-9a-f]{24}$/u;
const ENDPOINT_ID_PATTERN = /^endpoint_[0-9a-f]{24}$/u;
const DOMAIN_ID_PATTERN = /^domain_[0-9a-f]{24}$/u;
const LOCAL_TARGET_ID_PATTERN = /^(?:target|local_target)_[0-9a-f]{24}$/u;
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const safePart = (value) => nonEmpty(value) && !value.includes("\0");
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const iso = (value) => new Date(value).toISOString();
const onlyKeys = (value, allowed) => value && typeof value === "object" &&
  Object.keys(value).every((key) => allowed.includes(key));
const uniqueSorted = (values) => [...new Set(values ?? [])].sort();
const reject = (reason, extra = {}) => ({
  ok: false, disposition: "rejected", reason, ...extra,
});
const POST_AUTHORIZATION_REASONS = new Set([
  REJECT.PREFIX_MISMATCH,
  REJECT.EMPTY_INSTRUCTION,
  REJECT.DUPLICATE_MESSAGE,
  REJECT.QUOTA_EXHAUSTED,
]);

const digestRef = (prefix, parts) => prefix + crypto.createHash("sha256")
  .update(parts.join("\0"))
  .digest("hex")
  .slice(0, 24);

export function deriveDialogueChatScopeRef({ endpointId, privateChatId } = {}) {
  if (![endpointId, privateChatId].every(safePart)) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  return {
    ok: true,
    chatScopeRef: digestRef("chat_scope_ref_", [
      "dialogue-chat-scope-ref/v1", endpointId, privateChatId,
    ]),
  };
}

const snapshotContent = (snapshot) => ({
  binding_ref: snapshot.binding_ref,
  subscription_id: snapshot.subscription_id,
  subscription_version: snapshot.subscription_version,
  endpoint_id: snapshot.endpoint_id,
  domain_id: snapshot.domain_id,
  status: snapshot.status,
  reason: snapshot.reason,
  local_target_id: snapshot.local_target_id,
  agent_participant_id: snapshot.agent_participant_id,
  authorized_human_participant_ids: [...snapshot.authorized_human_participant_ids].sort(),
  chat_scope_ref: snapshot.chat_scope_ref,
  event_types: [...snapshot.event_types].sort(),
  freshness_ms: snapshot.freshness_ms,
});

/** 快照的内容寻址 id（导出给测试造"id 对得上、内容却不受控"的对手用）。 */
export const dialogueBindingAuthorizationSnapshotId = (snapshot) => snapshotId(snapshot);

const snapshotId = (snapshot) => digestRef("binding_authorization_", [
  "dialogue-binding-authorization-snapshot/v1",
  String(snapshot.authorization_revision),
  snapshot.captured_at,
  JSON.stringify(snapshotContent(snapshot)),
]);

/** paused 快照允许的 reason —— 与 references/dialogue-binding-authorization-v1.schema.json 的枚举同一份。 */
export const PAUSED_REASONS = Object.freeze([
  BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_PAUSED,
  BINDING_AUTHORIZATION_REASON.BINDING_PAUSED,
  BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_REVOKED,
]);

export function validateDialogueBindingAuthorizationSnapshot(snapshot) {
  if (!onlyKeys(snapshot, ["schema_version", "artifact_type", "snapshot_id",
    "authorization_revision", "captured_at", "binding_ref", "subscription_id",
    "subscription_version", "endpoint_id", "domain_id", "status", "reason",
    "local_target_id", "agent_participant_id", "authorized_human_participant_ids",
    "chat_scope_ref", "event_types", "freshness_ms"]) ||
      snapshot?.schema_version !== BINDING_AUTHORIZATION_SCHEMA_VERSION ||
      snapshot?.artifact_type !== BINDING_AUTHORIZATION_ARTIFACT_TYPE ||
      !SNAPSHOT_ID_PATTERN.test(snapshot?.snapshot_id ?? "") ||
      !positiveInteger(snapshot?.authorization_revision) ||
      !Number.isFinite(Date.parse(snapshot?.captured_at ?? "")) ||
      !BINDING_REF_PATTERN.test(snapshot?.binding_ref ?? "") ||
      !SUBSCRIPTION_ID_PATTERN.test(snapshot?.subscription_id ?? "") ||
      !positiveInteger(snapshot?.subscription_version) ||
      !ENDPOINT_ID_PATTERN.test(snapshot?.endpoint_id ?? "") ||
      !DOMAIN_ID_PATTERN.test(snapshot?.domain_id ?? "") ||
      !Object.values(BINDING_AUTHORIZATION_STATUS).includes(snapshot?.status) ||
      !LOCAL_TARGET_ID_PATTERN.test(snapshot?.local_target_id ?? "") ||
      !PARTICIPANT_REF_PATTERN.test(snapshot?.agent_participant_id ?? "") ||
      !Array.isArray(snapshot?.authorized_human_participant_ids) ||
      snapshot.authorized_human_participant_ids.length === 0 ||
      snapshot.authorized_human_participant_ids.some((id) => !PARTICIPANT_REF_PATTERN.test(id)) ||
      uniqueSorted(snapshot.authorized_human_participant_ids).length !==
        snapshot.authorized_human_participant_ids.length ||
      JSON.stringify(snapshot.authorized_human_participant_ids) !==
        JSON.stringify(uniqueSorted(snapshot.authorized_human_participant_ids)) ||
      !CHAT_SCOPE_REF_PATTERN.test(snapshot?.chat_scope_ref ?? "") ||
      !Array.isArray(snapshot?.event_types) || snapshot.event_types.length === 0 ||
      uniqueSorted(snapshot.event_types).length !== snapshot.event_types.length ||
      JSON.stringify(snapshot.event_types) !== JSON.stringify(uniqueSorted(snapshot.event_types)) ||
      snapshot.event_types.some((eventType) => !safePart(eventType)) ||
      typeof snapshot?.freshness_ms !== "number" || !Number.isFinite(snapshot.freshness_ms) ||
      snapshot.freshness_ms <= 0) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_SNAPSHOT };
  }
  const statusValid = snapshot.status === BINDING_AUTHORIZATION_STATUS.ACTIVE
    ? snapshot.reason === null
    : PAUSED_REASONS.includes(snapshot.reason);
  if (!statusValid || snapshot.snapshot_id !== snapshotId(snapshot)) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_SNAPSHOT };
  }
  return { ok: true };
}

const equivalentAuthorization = (left, right) =>
  JSON.stringify(snapshotContent(left)) === JSON.stringify(snapshotContent(right));

/**
 * 旧 selector 的最终 verdict 同时混有授权失败与内容/配额处置。shadow 只比较前者：
 * 已通过 binding、session、sender、mention 的消息即使正文为空或幂等命中，也算授权已通过。
 */
export function legacyDialogueBoundAuthorization({ verdict, localTargetId } = {}) {
  if (!LOCAL_TARGET_ID_PATTERN.test(localTargetId ?? "")) {
    return reject(BINDING_AUTHORIZATION_REASON.INVALID_INPUT);
  }
  if (verdict?.decision === "accept" ||
      (verdict?.decision === "reject" && POST_AUTHORIZATION_REASONS.has(verdict.reason))) {
    return {
      ok: true,
      disposition: "accepted",
      reason: null,
      local_target_id: localTargetId,
    };
  }
  return reject(verdict?.reason ?? BINDING_AUTHORIZATION_REASON.INVALID_INPUT);
}

/**
 * 把一份现有授权快照**收回**：新 revision、status=paused、受控 reason，其余内容原样。
 *
 * 为什么不走 materializeDialogueBindingAuthorization：撤销时那条订阅已经不存在（next=null），
 * 没有可以拿来物化的输入 —— 收回的语义就是"沿用上一份的内容，只把状态翻成 paused"。
 * reason 只认 PAUSED_REASONS（schema 同一份枚举）；已经是同 reason 的 paused 则幂等返回旧快照。
 */
export function materializeSuspendedAuthorization({ previousSnapshot, reason, capturedAt = Date.now() } = {}) {
  const validPrevious = validateDialogueBindingAuthorizationSnapshot(previousSnapshot);
  if (!validPrevious.ok) return validPrevious;
  if (!PAUSED_REASONS.includes(reason)) return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  const captured = typeof capturedAt === "number" ? iso(capturedAt) : capturedAt;
  if (!Number.isFinite(Date.parse(captured ?? ""))) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  const candidate = {
    ...clone(previousSnapshot),
    snapshot_id: "",
    authorization_revision: previousSnapshot.authorization_revision,
    captured_at: captured,
    status: BINDING_AUTHORIZATION_STATUS.PAUSED,
    reason,
  };
  if (equivalentAuthorization(previousSnapshot, candidate)) {
    return { ok: true, changed: false, snapshot: clone(previousSnapshot) };
  }
  candidate.authorization_revision += 1;
  candidate.snapshot_id = snapshotId(candidate);
  const valid = validateDialogueBindingAuthorizationSnapshot(candidate);
  return valid.ok ? { ok: true, changed: true, snapshot: candidate } : valid;
}

/**
 * 将一个 Subscription v1 与一条 adapter 私有 binding 投影为公共授权快照。
 * previousSnapshot 只用于单调 revision；相同授权内容幂等返回旧快照。
 */
export function materializeDialogueBindingAuthorization({
  runtimeNamespace, endpointId, subscription, binding, previousSnapshot = null,
  capturedAt = Date.now(),
} = {}) {
  const subscriptionValid = validateSubscription(subscription);
  if (!safePart(runtimeNamespace) || !ENDPOINT_ID_PATTERN.test(endpointId ?? "") ||
      !subscriptionValid.ok || subscription.endpoint_id !== endpointId ||
      !safePart(binding?.private_binding_key) ||
      !LOCAL_TARGET_ID_PATTERN.test(binding?.local_target_id ?? "") ||
      !nonEmpty(binding?.status)) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  let previous = null;
  if (previousSnapshot !== null) {
    const validPrevious = validateDialogueBindingAuthorizationSnapshot(previousSnapshot);
    if (!validPrevious.ok) return validPrevious;
    previous = previousSnapshot;
  }
  const bindingRef = deriveDialogueBindingRef({
    runtimeNamespace, endpointId, privateBindingKey: binding.private_binding_key,
  });
  const agent = deriveDialogueParticipantRef({
    kind: "agent", runtimeNamespace, endpointId,
    privateIdentityKey: subscription.scope.transport_open_id,
  });
  const humans = subscription.scope.sender_ids.map((senderId) => deriveDialogueParticipantRef({
    kind: "human", runtimeNamespace: "feishu", endpointId, privateIdentityKey: senderId,
  }));
  const chatScope = deriveDialogueChatScopeRef({
    endpointId, privateChatId: subscription.scope.chat_id,
  });
  if (!bindingRef.ok || !agent.ok || humans.some((result) => !result.ok) || !chatScope.ok) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  if (previous && previous.binding_ref !== bindingRef.bindingRef) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  const activeSubscription = subscription.status === "active";
  const activeBinding = binding.status === "active";
  const captured = typeof capturedAt === "number" ? iso(capturedAt) : capturedAt;
  if (!Number.isFinite(Date.parse(captured ?? ""))) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  const candidate = {
    schema_version: BINDING_AUTHORIZATION_SCHEMA_VERSION,
    artifact_type: BINDING_AUTHORIZATION_ARTIFACT_TYPE,
    snapshot_id: "",
    authorization_revision: previous?.authorization_revision ?? 1,
    captured_at: captured,
    binding_ref: bindingRef.bindingRef,
    subscription_id: subscription.subscription_id,
    subscription_version: subscription.version,
    endpoint_id: endpointId,
    domain_id: subscription.domain_id,
    status: activeSubscription && activeBinding
      ? BINDING_AUTHORIZATION_STATUS.ACTIVE
      : BINDING_AUTHORIZATION_STATUS.PAUSED,
    reason: !activeSubscription
      ? BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_PAUSED
      : !activeBinding ? BINDING_AUTHORIZATION_REASON.BINDING_PAUSED : null,
    local_target_id: binding.local_target_id,
    agent_participant_id: agent.participantId,
    authorized_human_participant_ids: uniqueSorted(humans.map((result) => result.participantId)),
    chat_scope_ref: chatScope.chatScopeRef,
    event_types: uniqueSorted(subscription.scope.event_types),
    freshness_ms: subscription.constraints.freshness_ms,
  };
  if (previous && equivalentAuthorization(previous, candidate)) {
    return { ok: true, changed: false, snapshot: clone(previous) };
  }
  if (previous) candidate.authorization_revision += 1;
  candidate.snapshot_id = snapshotId(candidate);
  const valid = validateDialogueBindingAuthorizationSnapshot(candidate);
  return valid.ok ? { ok: true, changed: true, snapshot: candidate } : valid;
}

/** 将旧只读 subscription projection 中的精确 binding 转为 materializer 输入。 */
export function legacyBindingAuthorizationInput({
  runtimeNamespace, model, legacyKey, privateBindingKey, bindingStatus,
} = {}) {
  if (!safePart(runtimeNamespace) || !model?.ok || !nonEmpty(legacyKey) ||
      !safePart(privateBindingKey) || !nonEmpty(bindingStatus) ||
      !Array.isArray(model?.pending_bindings) || !Array.isArray(model?.subscriptions)) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.PROJECTION_INVALID };
  }
  const bindings = model.pending_bindings.filter((binding) => binding.legacy_key === legacyKey);
  if (bindings.length === 0) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.BINDING_NOT_FOUND };
  }
  if (bindings.length !== 1) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.BINDING_AMBIGUOUS };
  }
  const subscriptions = model.subscriptions.filter((subscription) =>
    subscription.subscription_id === bindings[0].subscription_id);
  if (subscriptions.length === 0) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_NOT_FOUND };
  }
  if (subscriptions.length !== 1) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_AMBIGUOUS };
  }
  return {
    ok: true,
    input: {
      runtimeNamespace,
      endpointId: model.endpoint_id,
      subscription: subscriptions[0],
      binding: {
        private_binding_key: privateBindingKey,
        local_target_id: bindings[0].local_target_id,
        status: bindingStatus,
      },
    },
  };
}

/** adapter 私有登记 + 旧 selector verdict → 一次只读 bound authorization shadow 上下文。 */
export function buildLegacyDialogueBoundAuthorizationContext({
  runtimeNamespace, model, legacyKey, privateBindingKey, bindingStatus, verdict,
} = {}) {
  const projected = legacyBindingAuthorizationInput({
    runtimeNamespace, model, legacyKey, privateBindingKey, bindingStatus,
  });
  if (!projected.ok) return projected;
  const expected = deriveDialogueBindingRef({
    runtimeNamespace,
    endpointId: projected.input.endpointId,
    privateBindingKey,
  });
  if (!expected.ok) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  const legacy = legacyDialogueBoundAuthorization({
    verdict,
    localTargetId: projected.input.binding.local_target_id,
  });
  return {
    ok: true,
    authorizationInput: projected.input,
    expectedBindingRef: expected.bindingRef,
    legacy,
  };
}

export function evaluateDialogueBoundAuthorization({
  snapshot, canonicalEvent, runtimeNamespace, expectedBindingRef, now = Date.now(),
} = {}) {
  const snapshotValid = validateDialogueBindingAuthorizationSnapshot(snapshot);
  if (!snapshotValid.ok || !safePart(runtimeNamespace) ||
      !BINDING_REF_PATTERN.test(expectedBindingRef ?? "")) {
    return reject(snapshotValid.ok
      ? BINDING_AUTHORIZATION_REASON.INVALID_INPUT
      : snapshotValid.reason);
  }
  if (!validateCanonicalEvent(canonicalEvent).ok) {
    return reject(BINDING_AUTHORIZATION_REASON.CANONICAL_INVALID);
  }
  if (snapshot.binding_ref !== expectedBindingRef) {
    return reject(BINDING_AUTHORIZATION_REASON.BINDING_MISMATCH);
  }
  if (snapshot.status !== BINDING_AUTHORIZATION_STATUS.ACTIVE) {
    return reject(snapshot.reason);
  }
  if (canonicalEvent.endpoint_id !== snapshot.endpoint_id) {
    return reject(BINDING_AUTHORIZATION_REASON.ENDPOINT_MISMATCH);
  }
  if (!snapshot.event_types.includes(canonicalEvent.event_type)) {
    return reject(BINDING_AUTHORIZATION_REASON.EVENT_TYPE_MISMATCH);
  }
  const sender = deriveDialogueParticipantRef({
    kind: "human", runtimeNamespace: "feishu", endpointId: snapshot.endpoint_id,
    privateIdentityKey: canonicalEvent.actor.sender_id,
  });
  if (!sender.ok || !snapshot.authorized_human_participant_ids.includes(sender.participantId)) {
    return reject(BINDING_AUTHORIZATION_REASON.SENDER_NOT_ALLOWED);
  }
  const mentionedParticipants = canonicalEvent.mention.target_open_ids.map((openId) =>
    deriveDialogueParticipantRef({
      kind: "agent", runtimeNamespace, endpointId: snapshot.endpoint_id,
      privateIdentityKey: openId,
    }).participantId).filter(nonEmpty);
  if (!canonicalEvent.mention.is_real ||
      !mentionedParticipants.includes(snapshot.agent_participant_id)) {
    return reject(BINDING_AUTHORIZATION_REASON.MENTION_REQUIRED);
  }
  const occurredAt = Date.parse(canonicalEvent.occurred_at);
  if (!Number.isFinite(occurredAt) || now - occurredAt > snapshot.freshness_ms) {
    return reject(BINDING_AUTHORIZATION_REASON.STALE_EVENT);
  }
  if (canonicalEvent.extensions.aily_channel.verified !== true ||
      !nonEmpty(canonicalEvent.source.chat_id)) {
    return reject(BINDING_AUTHORIZATION_REASON.CHAT_SCOPE_UNVERIFIED, {
      scope_unverified: ["chat_id"],
    });
  }
  const chatScope = deriveDialogueChatScopeRef({
    endpointId: snapshot.endpoint_id, privateChatId: canonicalEvent.source.chat_id,
  });
  if (!chatScope.ok || chatScope.chatScopeRef !== snapshot.chat_scope_ref) {
    return reject(BINDING_AUTHORIZATION_REASON.CHAT_SCOPE_MISMATCH);
  }
  return {
    ok: true,
    disposition: "accepted",
    reason: null,
    binding_ref: snapshot.binding_ref,
    local_target_id: snapshot.local_target_id,
    participant_id: sender.participantId,
    scope_unverified: [],
  };
}

export function compareDialogueBoundAuthorizationShadow({ legacy, candidate } = {}) {
  const legacyAccepted = legacy?.ok === true;
  const candidateAccepted = candidate?.ok === true;
  const dispositionMatch = legacyAccepted === candidateAccepted;
  const targetMatch = !legacyAccepted || !candidateAccepted ||
    legacy.local_target_id === candidate.local_target_id;
  const reasonMatch = legacyAccepted && candidateAccepted
    ? true
    : (legacy?.reason ?? "unknown") === (candidate?.reason ?? "unknown");
  return {
    mode: "shadow",
    match: dispositionMatch && targetMatch && reasonMatch,
    route_match: dispositionMatch && targetMatch,
    disposition_match: dispositionMatch,
    target_match: targetMatch,
    reason_match: reasonMatch,
    legacy_disposition: legacyAccepted ? "accepted" : "rejected",
    candidate_disposition: candidateAccepted ? "accepted" : "rejected",
    legacy_reason: legacyAccepted ? null : (legacy?.reason ?? "unknown"),
    candidate_reason: candidateAccepted ? null : (candidate?.reason ?? "unknown"),
    scope_unverified: candidate?.scope_unverified ?? [],
  };
}

const comparisonContent = (comparison) => ({
  mode: comparison.mode,
  match: comparison.match,
  route_match: comparison.route_match,
  disposition_match: comparison.disposition_match,
  target_match: comparison.target_match,
  reason_match: comparison.reason_match,
  legacy_disposition: comparison.legacy_disposition,
  candidate_disposition: comparison.candidate_disposition,
  legacy_reason: comparison.legacy_reason,
  candidate_reason: comparison.candidate_reason,
  scope_unverified: [...comparison.scope_unverified].sort(),
});

const validShadowComparison = (comparison) =>
  onlyKeys(comparison, ["mode", "match", "route_match", "disposition_match",
    "target_match", "reason_match", "legacy_disposition", "candidate_disposition",
    "legacy_reason", "candidate_reason", "scope_unverified"]) &&
  comparison.mode === "shadow" &&
  ["match", "route_match", "disposition_match", "target_match", "reason_match"]
    .every((key) => typeof comparison[key] === "boolean") &&
  [comparison.legacy_disposition, comparison.candidate_disposition]
    .every((value) => ["accepted", "rejected"].includes(value)) &&
  (comparison.legacy_disposition === "accepted"
    ? comparison.legacy_reason === null : nonEmpty(comparison.legacy_reason)) &&
  (comparison.candidate_disposition === "accepted"
    ? comparison.candidate_reason === null : nonEmpty(comparison.candidate_reason)) &&
  Array.isArray(comparison.scope_unverified) &&
  comparison.scope_unverified.length <= 1 &&
  comparison.scope_unverified.every((value) => value === "chat_id") &&
  comparison.disposition_match ===
    (comparison.legacy_disposition === comparison.candidate_disposition) &&
  comparison.reason_match === (
    comparison.legacy_disposition === "accepted" &&
    comparison.candidate_disposition === "accepted"
      ? true
      : comparison.legacy_reason === comparison.candidate_reason
  ) &&
  comparison.route_match === (comparison.disposition_match && comparison.target_match) &&
  comparison.match === (comparison.route_match && comparison.reason_match) &&
  (comparison.candidate_disposition === "accepted"
    ? comparison.scope_unverified.length === 0
    : comparison.candidate_reason === BINDING_AUTHORIZATION_REASON.CHAT_SCOPE_UNVERIFIED
      ? comparison.scope_unverified.length === 1
      : comparison.scope_unverified.length === 0);

export function createDialogueBoundAuthorizationShadow({
  snapshot, canonicalEvent, comparison, recordedAt = Date.now(),
} = {}) {
  const snapshotValid = validateDialogueBindingAuthorizationSnapshot(snapshot);
  const recorded = typeof recordedAt === "number" ? iso(recordedAt) : recordedAt;
  if (!snapshotValid.ok || !validateCanonicalEvent(canonicalEvent).ok ||
      !Number.isFinite(Date.parse(recorded ?? "")) || !validShadowComparison(comparison)) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  const eventRef = digestRef("event_ref_", [
    "dialogue-authorization-event-ref/v1", snapshot.endpoint_id, canonicalEvent.event_id,
  ]);
  const shadowId = digestRef("authorization_shadow_", [
    "dialogue-bound-authorization-shadow/v1", BOUND_AUTHORIZATION_EVALUATOR_VERSION,
    snapshot.snapshot_id, eventRef, JSON.stringify(comparisonContent(comparison)),
  ]);
  const evidence = {
    schema_version: BOUND_AUTHORIZATION_SHADOW_SCHEMA_VERSION,
    artifact_type: BOUND_AUTHORIZATION_SHADOW_ARTIFACT_TYPE,
    evaluator_version: BOUND_AUTHORIZATION_EVALUATOR_VERSION,
    shadow_id: shadowId,
    recorded_at: recorded,
    event_ref: eventRef,
    binding_ref: snapshot.binding_ref,
    authorization_snapshot_id: snapshot.snapshot_id,
    comparison: clone(comparison),
  };
  return validateDialogueBoundAuthorizationShadow(evidence).ok
    ? { ok: true, evidence }
    : { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
}

export function validateDialogueBoundAuthorizationShadow(evidence) {
  const comparison = evidence?.comparison;
  if (!onlyKeys(evidence, ["schema_version", "artifact_type", "evaluator_version",
    "shadow_id", "recorded_at",
    "event_ref", "binding_ref", "authorization_snapshot_id", "comparison"]) ||
      evidence?.schema_version !== BOUND_AUTHORIZATION_SHADOW_SCHEMA_VERSION ||
      evidence?.artifact_type !== BOUND_AUTHORIZATION_SHADOW_ARTIFACT_TYPE ||
      evidence?.evaluator_version !== BOUND_AUTHORIZATION_EVALUATOR_VERSION ||
      !SHADOW_ID_PATTERN.test(evidence?.shadow_id ?? "") ||
      !Number.isFinite(Date.parse(evidence?.recorded_at ?? "")) ||
      !EVENT_REF_PATTERN.test(evidence?.event_ref ?? "") ||
      !BINDING_REF_PATTERN.test(evidence?.binding_ref ?? "") ||
      !SNAPSHOT_ID_PATTERN.test(evidence?.authorization_snapshot_id ?? "") ||
      !validShadowComparison(comparison)) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  const expectedShadowId = digestRef("authorization_shadow_", [
    "dialogue-bound-authorization-shadow/v1", evidence.evaluator_version,
    evidence.authorization_snapshot_id, evidence.event_ref,
    JSON.stringify(comparisonContent(comparison)),
  ]);
  if (evidence.shadow_id !== expectedShadowId) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_INPUT };
  }
  return { ok: true };
}
