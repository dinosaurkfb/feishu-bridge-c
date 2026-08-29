/**
 * Binding 级交互策略与 Dialogue Policy v1 纯状态机。
 *
 * 本模块不读写文件、不认识 Claude session / Codex thread locator，也不启动运行时。
 * adapter 负责把这里返回的新状态原子写回自己的 Git 外 binding，并把 runRequest 中的
 * opaque localTargetId 解析为私有 locator。
 */

import { stableControlId } from "./subscription.mjs";
import { usableGeneration } from "./topic-generation.mjs";
import {
  MAPPING_POLICY_ID, MAPPING_POLICY_VERSION,
} from "./mapping-policy.mjs";

export { MAPPING_POLICY_ID, MAPPING_POLICY_VERSION };
export const DIALOGUE_POLICY_ID = "dialogue";
export const DIALOGUE_POLICY_VERSION = "1.0";
export const INTERACTION_POLICY_SCHEMA_VERSION = "1.0";

export const DEFAULT_DIALOGUE_BUDGET = Object.freeze({
  max_rounds: 12,
  max_duration_ms: 2 * 60 * 60 * 1000,
  max_resource_units: 12,
});

export const DIALOGUE_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const DIALOGUE_TURN_STATUS = Object.freeze({
  DISPATCHED: "dispatched",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const DIALOGUE_REASON = Object.freeze({
  POLICY_INVALID: "dialogue_policy_invalid",
  NOT_ACTIVE: "dialogue_not_active",
  TURN_ACTIVE: "dialogue_turn_active",
  DUPLICATE: "dialogue_duplicate_event",
  ROUND_BUDGET: "dialogue_round_budget_exhausted",
  TIME_BUDGET: "dialogue_time_budget_exhausted",
  RESOURCE_BUDGET: "dialogue_resource_budget_exhausted",
  RUN_FAILED: "dialogue_run_failed",
  HUMAN_INTERRUPT: "human_interrupt",
});

const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const iso = (now) => new Date(now).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const positiveInteger = (value) => Number.isInteger(value) && value > 0;

const validBudget = (budget) =>
  positiveInteger(budget?.max_rounds) &&
  positiveInteger(budget?.max_duration_ms) &&
  positiveInteger(budget?.max_resource_units);

const DIALOGUE_STOP_CONDITIONS = Object.freeze([
  "round_budget",
  "time_budget",
  "resource_budget",
  "runtime_failure",
  "human_interrupt",
]);

const validDialogueContract = (dialogue) =>
  dialogue.host?.participant_id === "bound_local_target" &&
  dialogue.host?.role === "host" &&
  Array.isArray(dialogue.participants) &&
  dialogue.participants.length === 2 &&
  dialogue.participants.some((item) =>
    item?.participant_id === "authorized_human" && item?.role === "human") &&
  dialogue.participants.some((item) =>
    item?.participant_id === "bound_local_target" && item?.role === "host") &&
  dialogue.finalization?.summarizer_participant_id === "bound_local_target" &&
  dialogue.finalization?.publish_target === "origin_channel_generation" &&
  dialogue.concurrency?.max_active_turns === 1 &&
  dialogue.concurrency?.duplicate_event === "idempotent" &&
  dialogue.concurrency?.mention_loop === "disabled" &&
  dialogue.concurrency?.agent_output_relay === "disabled" &&
  Array.isArray(dialogue.stop_conditions) &&
  dialogue.stop_conditions.length === DIALOGUE_STOP_CONDITIONS.length &&
  DIALOGUE_STOP_CONDITIONS.every((item) => dialogue.stop_conditions.includes(item));

const mappingState = ({ bindingId, now }) => ({
  schema_version: INTERACTION_POLICY_SCHEMA_VERSION,
  binding_id: bindingId,
  policy_id: MAPPING_POLICY_ID,
  policy_version: MAPPING_POLICY_VERSION,
  updated_at: iso(now),
  dialogue: null,
});

/** 老 binding 没有策略字段时保持 Mapping，不做历史推断或隐式升级。 */
export function interactionPolicyStateForLegacy(record, {
  bindingId = record?.binding_id,
  now = Date.now(),
} = {}) {
  if (!nonEmpty(bindingId)) return { ok: false, reason: "binding_id_missing" };
  if (record?.interaction_policy_state === null || record?.interaction_policy_state === undefined) {
    return { ok: true, migrated: true, state: mappingState({ bindingId, now }) };
  }
  const state = clone(record.interaction_policy_state);
  const valid = validateInteractionPolicyState(state, { bindingId });
  return valid.ok ? { ok: true, migrated: false, state } : valid;
}

export function validateInteractionPolicyState(state, { bindingId } = {}) {
  if (!state || state.schema_version !== INTERACTION_POLICY_SCHEMA_VERSION) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  if (!nonEmpty(state.binding_id) || (bindingId && state.binding_id !== bindingId)) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  const mappingMode = state.policy_id === MAPPING_POLICY_ID &&
    state.policy_version === MAPPING_POLICY_VERSION;
  const dialogueMode = state.policy_id === DIALOGUE_POLICY_ID &&
    state.policy_version === DIALOGUE_POLICY_VERSION;
  if (!mappingMode && !dialogueMode) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  if (mappingMode && state.dialogue === null) return { ok: true };
  const dialogue = state.dialogue;
  if (!dialogue || !nonEmpty(dialogue.dialogue_id) ||
      !Object.values(DIALOGUE_STATUS).includes(dialogue.status) ||
      dialogue.turn_order !== "human_then_host_serial" ||
      dialogue.allow_agent_output_as_input !== false ||
      !validDialogueContract(dialogue) ||
      !validBudget(dialogue.budget) ||
      !Number.isInteger(dialogue.usage?.rounds_started) || dialogue.usage.rounds_started < 0 ||
      !Number.isInteger(dialogue.usage?.resource_units_used) || dialogue.usage.resource_units_used < 0 ||
      dialogue.usage.rounds_started > dialogue.budget.max_rounds ||
      dialogue.usage.resource_units_used > dialogue.budget.max_resource_units ||
      !positiveInteger(dialogue.next_turn_index) || !Array.isArray(dialogue.processed_events) ||
      !Number.isFinite(Date.parse(dialogue.started_at)) ||
      !Number.isFinite(Date.parse(dialogue.deadline_at))) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  if (mappingMode && dialogue.status === DIALOGUE_STATUS.ACTIVE) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  const eventIds = dialogue.processed_events.map((item) => item?.event_id);
  if (eventIds.some((item) => !nonEmpty(item)) || new Set(eventIds).size !== eventIds.length) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  if (dialogue.active_turn !== null) {
    const turn = dialogue.active_turn;
    if (!positiveInteger(turn?.turn_index) || !nonEmpty(turn?.event_id) || !nonEmpty(turn?.run_id) ||
        turn.dialogue_id !== dialogue.dialogue_id ||
        turn.turn_index >= dialogue.next_turn_index ||
        turn.status !== DIALOGUE_TURN_STATUS.DISPATCHED || !nonEmpty(turn?.local_target_id) ||
        !eventIds.includes(turn.event_id) || !usableGeneration(turn?.origin_channel_generation_id)) {
      return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
    }
  }
  return { ok: true };
}

export function materializeInteractionPolicy(record, state) {
  const valid = validateInteractionPolicyState(state, { bindingId: state?.binding_id });
  if (!valid.ok) return valid;
  return { ok: true, record: { ...record, interaction_policy_state: clone(state) } };
}

/**
 * 显式切换模式。首次进入 dialogue 创建新的有界会话；对相同活跃配置重复调用是幂等的。
 * 切回 mapping 会把尚未结束的 dialogue 标为人工中止并保留审计快照，不删除历史。
 */
export function setInteractionPolicyMode(state, {
  mode,
  budget = DEFAULT_DIALOGUE_BUDGET,
  now = Date.now(),
} = {}) {
  const valid = validateInteractionPolicyState(state, { bindingId: state?.binding_id });
  if (!valid.ok) return valid;
  if (![MAPPING_POLICY_ID, DIALOGUE_POLICY_ID].includes(mode)) {
    return { ok: false, reason: "unsupported_policy_mode" };
  }
  if (mode === DIALOGUE_POLICY_ID && !validBudget(budget)) {
    return { ok: false, reason: "invalid_dialogue_budget" };
  }

  if (mode === DIALOGUE_POLICY_ID && state.policy_id === DIALOGUE_POLICY_ID &&
      state.dialogue?.status === DIALOGUE_STATUS.ACTIVE &&
      JSON.stringify(state.dialogue.budget) === JSON.stringify(budget)) {
    return { ok: true, changed: false, state: clone(state), dialogue: clone(state.dialogue) };
  }

  const next = clone(state);
  if (mode === MAPPING_POLICY_ID) {
    const changed = next.policy_id !== MAPPING_POLICY_ID || next.dialogue?.status === DIALOGUE_STATUS.ACTIVE;
    if (next.dialogue?.status === DIALOGUE_STATUS.ACTIVE) {
      next.dialogue.status = DIALOGUE_STATUS.CANCELLED;
      next.dialogue.stop_reason = DIALOGUE_REASON.HUMAN_INTERRUPT;
      next.dialogue.ended_at = iso(now);
      if (next.dialogue.active_turn) {
        next.dialogue.last_turn = {
          ...next.dialogue.active_turn,
          status: DIALOGUE_TURN_STATUS.CANCELLED,
          finalized_at: iso(now),
          reason: DIALOGUE_REASON.HUMAN_INTERRUPT,
        };
        next.dialogue.active_turn = null;
      }
    }
    next.policy_id = MAPPING_POLICY_ID;
    next.policy_version = MAPPING_POLICY_VERSION;
    next.updated_at = iso(now);
    return { ok: true, changed, state: next, dialogue: next.dialogue };
  }

  const startedAt = iso(now);
  next.policy_id = DIALOGUE_POLICY_ID;
  next.policy_version = DIALOGUE_POLICY_VERSION;
  next.updated_at = startedAt;
  next.dialogue = {
    dialogue_id: stableControlId("dialogue", state.binding_id, startedAt),
    status: DIALOGUE_STATUS.ACTIVE,
    host: { participant_id: "bound_local_target", role: "host" },
    participants: [
      { participant_id: "authorized_human", role: "human" },
      { participant_id: "bound_local_target", role: "host" },
    ],
    turn_order: "human_then_host_serial",
    allow_agent_output_as_input: false,
    finalization: {
      summarizer_participant_id: "bound_local_target",
      publish_target: "origin_channel_generation",
    },
    concurrency: {
      max_active_turns: 1,
      duplicate_event: "idempotent",
      mention_loop: "disabled",
      agent_output_relay: "disabled",
    },
    stop_conditions: [...DIALOGUE_STOP_CONDITIONS],
    budget: { ...budget },
    usage: { rounds_started: 0, resource_units_used: 0 },
    next_turn_index: 1,
    active_turn: null,
    processed_events: [],
    started_at: startedAt,
    deadline_at: iso(now + budget.max_duration_ms),
    updated_at: startedAt,
    ended_at: null,
    stop_reason: null,
  };
  return { ok: true, changed: true, state: next, dialogue: next.dialogue };
}

const stopDialogue = (state, reason, now) => {
  const next = clone(state);
  if (next.dialogue.active_turn) {
    next.dialogue.last_turn = {
      ...next.dialogue.active_turn,
      status: DIALOGUE_TURN_STATUS.CANCELLED,
      finalized_at: iso(now),
      reason,
    };
    next.dialogue.active_turn = null;
  }
  next.dialogue.status = DIALOGUE_STATUS.COMPLETED;
  next.dialogue.stop_reason = reason;
  next.dialogue.ended_at = iso(now);
  next.dialogue.updated_at = iso(now);
  next.updated_at = iso(now);
  return next;
};

/** 原子预留一个串行回合；调用方必须把返回的新 state 与 reservation 一起落盘。 */
export function reserveDialogueTurn(state, {
  eventId,
  runId,
  localTargetId,
  originChannelGenerationId,
  runtimeTargetId = null,
  resourceUnits = 1,
  now = Date.now(),
} = {}) {
  const valid = validateInteractionPolicyState(state, { bindingId: state?.binding_id });
  if (!valid.ok) return valid;
  if (state.policy_id !== DIALOGUE_POLICY_ID || state.dialogue?.status !== DIALOGUE_STATUS.ACTIVE) {
    return { ok: false, reason: DIALOGUE_REASON.NOT_ACTIVE };
  }
  if (![eventId, runId, localTargetId, originChannelGenerationId].every(nonEmpty) ||
      !positiveInteger(resourceUnits)) {
    return { ok: false, reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  const prior = state.dialogue.processed_events.find((item) => item.event_id === eventId);
  if (prior) {
    return { ok: true, changed: false, duplicate: true, reason: DIALOGUE_REASON.DUPLICATE,
      state: clone(state), reservation: clone(prior) };
  }

  const deadline = Date.parse(state.dialogue.deadline_at);
  if (!Number.isFinite(deadline) || now >= deadline) {
    return { ok: true, changed: true, accepted: false, reason: DIALOGUE_REASON.TIME_BUDGET,
      state: stopDialogue(state, DIALOGUE_REASON.TIME_BUDGET, now) };
  }
  if (state.dialogue.active_turn) {
    return { ok: false, reason: DIALOGUE_REASON.TURN_ACTIVE };
  }
  if (state.dialogue.usage.rounds_started >= state.dialogue.budget.max_rounds) {
    return { ok: true, changed: true, accepted: false, reason: DIALOGUE_REASON.ROUND_BUDGET,
      state: stopDialogue(state, DIALOGUE_REASON.ROUND_BUDGET, now) };
  }
  if (state.dialogue.usage.resource_units_used + resourceUnits >
      state.dialogue.budget.max_resource_units) {
    return { ok: true, changed: true, accepted: false, reason: DIALOGUE_REASON.RESOURCE_BUDGET,
      state: stopDialogue(state, DIALOGUE_REASON.RESOURCE_BUDGET, now) };
  }

  const next = clone(state);
  const reservation = {
    event_id: eventId,
    run_id: runId,
    dialogue_id: next.dialogue.dialogue_id,
    turn_index: next.dialogue.next_turn_index,
    local_target_id: localTargetId,
    origin_channel_generation_id: originChannelGenerationId,
    runtime_target_id: nonEmpty(runtimeTargetId) ? runtimeTargetId : null,
    resource_units: resourceUnits,
    status: DIALOGUE_TURN_STATUS.DISPATCHED,
    dispatched_at: iso(now),
  };
  next.dialogue.active_turn = reservation;
  next.dialogue.processed_events.push({
    event_id: eventId,
    run_id: runId,
    dialogue_id: reservation.dialogue_id,
    turn_index: reservation.turn_index,
  });
  next.dialogue.processed_events = next.dialogue.processed_events.slice(-256);
  next.dialogue.usage.rounds_started += 1;
  next.dialogue.usage.resource_units_used += resourceUnits;
  next.dialogue.next_turn_index += 1;
  next.dialogue.updated_at = iso(now);
  next.updated_at = iso(now);
  return { ok: true, changed: true, accepted: true, duplicate: false, state: next, reservation };
}

/** 由 adapter 的严格终局观察者结束当轮；失败是 Dialogue v1 的硬失败条件。 */
export function finalizeDialogueTurn(state, {
  runId,
  runtimeTargetId = null,
  status,
  reason = null,
  now = Date.now(),
} = {}) {
  const valid = validateInteractionPolicyState(state, { bindingId: state?.binding_id });
  if (!valid.ok) return valid;
  const active = state.dialogue?.active_turn;
  if (!active) return { ok: true, changed: false, state: clone(state), reason: "no_active_turn" };
  const hasRun = nonEmpty(runId);
  const hasRuntime = nonEmpty(runtimeTargetId);
  if ((!hasRun && !hasRuntime) ||
      (hasRun && active.run_id !== runId) ||
      (hasRuntime && active.runtime_target_id !== runtimeTargetId)) {
    return { ok: false, reason: "dialogue_turn_mismatch" };
  }
  if (![DIALOGUE_TURN_STATUS.COMPLETED, DIALOGUE_TURN_STATUS.FAILED,
    DIALOGUE_TURN_STATUS.CANCELLED].includes(status)) {
    return { ok: false, reason: "invalid_dialogue_turn_status" };
  }

  const next = clone(state);
  next.dialogue.last_turn = {
    ...active,
    status,
    finalized_at: iso(now),
    reason,
  };
  next.dialogue.active_turn = null;
  next.dialogue.updated_at = iso(now);
  next.updated_at = iso(now);

  if (status === DIALOGUE_TURN_STATUS.FAILED) {
    next.dialogue.status = DIALOGUE_STATUS.FAILED;
    next.dialogue.stop_reason = reason ?? DIALOGUE_REASON.RUN_FAILED;
    next.dialogue.ended_at = iso(now);
  } else if (status === DIALOGUE_TURN_STATUS.CANCELLED) {
    next.dialogue.status = DIALOGUE_STATUS.CANCELLED;
    next.dialogue.stop_reason = reason ?? DIALOGUE_REASON.HUMAN_INTERRUPT;
    next.dialogue.ended_at = iso(now);
  } else {
    const deadline = Date.parse(next.dialogue.deadline_at);
    let stopReason = null;
    if (now >= deadline) stopReason = DIALOGUE_REASON.TIME_BUDGET;
    else if (next.dialogue.usage.rounds_started >= next.dialogue.budget.max_rounds) {
      stopReason = DIALOGUE_REASON.ROUND_BUDGET;
    } else if (next.dialogue.usage.resource_units_used >= next.dialogue.budget.max_resource_units) {
      stopReason = DIALOGUE_REASON.RESOURCE_BUDGET;
    }
    if (stopReason) {
      next.dialogue.status = DIALOGUE_STATUS.COMPLETED;
      next.dialogue.stop_reason = stopReason;
      next.dialogue.ended_at = iso(now);
    }
  }
  return { ok: true, changed: true, state: next, dialogue: next.dialogue, turn: next.dialogue.last_turn };
}

export function interactionPolicySummary(state) {
  const valid = validateInteractionPolicyState(state, { bindingId: state?.binding_id });
  if (!valid.ok) return valid;
  if (state.policy_id === MAPPING_POLICY_ID) {
    return { ok: true, policyId: MAPPING_POLICY_ID, policyVersion: MAPPING_POLICY_VERSION,
      label: "Mapping（一次输入对应一次运行）" };
  }
  const dialogue = state.dialogue;
  return {
    ok: true,
    policyId: DIALOGUE_POLICY_ID,
    policyVersion: DIALOGUE_POLICY_VERSION,
    label: "Dialogue（单主持者·串行）",
    dialogueId: dialogue.dialogue_id,
    status: dialogue.status,
    roundsStarted: dialogue.usage.rounds_started,
    maxRounds: dialogue.budget.max_rounds,
    resourceUnitsUsed: dialogue.usage.resource_units_used,
    maxResourceUnits: dialogue.budget.max_resource_units,
    deadlineAt: dialogue.deadline_at,
    turnActive: dialogue.active_turn !== null,
    stopReason: dialogue.stop_reason,
  };
}

/** 把既有准入证据冻结到当前 binding 的策略版本，不重新读取消息。 */
export function applyInteractionPolicyToAdmission(evaluation, state) {
  const valid = validateInteractionPolicyState(state, { bindingId: state?.binding_id });
  if (!valid.ok || !evaluation || typeof evaluation !== "object") {
    return { policy_id: state?.policy_id ?? null, policy_version: state?.policy_version ?? null,
      decision: "invalid", reason: DIALOGUE_REASON.POLICY_INVALID };
  }
  return { ...evaluation, policy_id: state.policy_id, policy_version: state.policy_version };
}

/** reservation 已由 adapter 原子取得；本函数只生成 runtime-neutral runRequest。 */
export function handleDialoguePolicy({
  evaluation, claim, resolvedContext, reservation, targetState = "ready", capability = null,
} = {}) {
  const base = { policy_id: DIALOGUE_POLICY_ID, policy_version: DIALOGUE_POLICY_VERSION };
  const rejected = (reason, disposition = "rejected") => ({
    ...base, disposition, reason, claimId: claim?.key ?? null,
  });
  if (evaluation?.policy_id !== DIALOGUE_POLICY_ID ||
      evaluation?.policy_version !== DIALOGUE_POLICY_VERSION) {
    return rejected(DIALOGUE_REASON.POLICY_INVALID);
  }
  if (evaluation.decision === "reject") return rejected(evaluation.reason ?? DIALOGUE_REASON.POLICY_INVALID);
  if (claim?.ok !== true) {
    return rejected(claim?.reason ?? "dialogue_claim_required",
      claim?.reason === "duplicate" ? "duplicate" : "rejected");
  }
  if (targetState === "busy") return rejected(DIALOGUE_REASON.TURN_ACTIVE, "busy");
  if (!reservation?.accepted || !reservation?.reservation ||
      !nonEmpty(resolvedContext?.localTargetId) ||
      !nonEmpty(resolvedContext?.originChannelGenerationId)) {
    return rejected(reservation?.reason ?? DIALOGUE_REASON.POLICY_INVALID,
      reservation?.reason === DIALOGUE_REASON.TURN_ACTIVE ? "busy" : "rejected");
  }
  const turn = reservation.reservation;
  return {
    ...base,
    disposition: "accepted",
    claimId: claim.key,
    receiptText: "对话回合已通过预算校验并准备投递",
    runRequest: {
      runId: claim.key,
      localTargetId: resolvedContext.localTargetId,
      userInput: evaluation.instruction,
      // 执行边界（authorize 给的）：full = 现场 / 续起会话；reply_only = 零工具无历史的一次性回合。缺席时投递层按 fail-closed 拒。
      capability,
      origin: {
        kind: "feishu",
        eventId: evaluation.messageId,
        channelGenerationId: resolvedContext.originChannelGenerationId,
      },
      policy: {
        policy_id: DIALOGUE_POLICY_ID,
        policy_version: DIALOGUE_POLICY_VERSION,
        dialogue_id: turn.dialogue_id,
        turn_index: turn.turn_index,
        allow_agent_output_as_input: false,
      },
    },
  };
}
