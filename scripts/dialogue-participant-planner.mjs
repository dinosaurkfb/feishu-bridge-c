/**
 * Dialogue Participant & Planner Foundation。
 *
 * 这是独立纯函数模块：不读写 binding/state，不调用 runtime，不发布飞书，也不认识 Claude/Codex
 * locator。Relay 真正接入 adapter 前，生产 Dialogue v1 行为保持不变。
 */

import crypto from "node:crypto";

export const PARTICIPANT_SNAPSHOT_SCHEMA_VERSION = "1.0";
export const PARTICIPANT_SNAPSHOT_ARTIFACT_TYPE =
  "feishu_bridge_dialogue_participant_snapshot";
export const RELAY_PLAN_SCHEMA_VERSION = "1.0";
export const RELAY_PLAN_ARTIFACT_TYPE = "feishu_bridge_dialogue_relay_plan_state";
export const RELAY_POLICY_ID = "dialogue";
export const RELAY_POLICY_VERSION = "2.0";

export const DEFAULT_RELAY_BUDGET = Object.freeze({
  max_cycles: 4,
  max_agent_runs: 12,
  max_duration_ms: 2 * 60 * 60 * 1000,
  max_resource_units: 12,
});

export const RELAY_PLAN_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const RELAY_STEP_STATUS = Object.freeze({
  DISPATCHED: "dispatched",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const RELAY_DISPOSITION = Object.freeze({
  DISPATCH_ONE: "dispatch_one",
  WAIT_HUMAN: "wait_human",
  STOP: "stop",
  DUPLICATE: "duplicate",
  BUSY: "busy",
});

export const RELAY_REASON = Object.freeze({
  INVALID_SNAPSHOT: "participant_snapshot_invalid",
  INVALID_STATE: "relay_plan_invalid",
  ALREADY_ACTIVE: "relay_cycle_active",
  DUPLICATE_HUMAN_EVENT: "relay_duplicate_human_event",
  DUPLICATE_TERMINAL_EVENT: "relay_duplicate_terminal_event",
  RUN_MISMATCH: "relay_run_mismatch",
  CYCLE_BUDGET: "relay_cycle_budget_exhausted",
  AGENT_RUN_BUDGET: "relay_agent_run_budget_exhausted",
  RESOURCE_BUDGET: "relay_resource_budget_exhausted",
  PARTICIPANT_BUDGET: "relay_participant_budget_exhausted",
  TIME_BUDGET: "relay_time_budget_exhausted",
  RUNTIME_FAILED: "relay_runtime_failed",
  EMPTY_OUTPUT: "relay_empty_output",
  OUTPUT_REF_INVALID: "relay_output_ref_invalid",
  AUTHORIZATION_REVOKED: "authorization_revoked",
  HUMAN_INTERRUPT: "human_interrupt",
});

const ROLE = Object.freeze({
  REQUESTER: "requester",
  HOST: "host",
  PEER: "peer",
  FINALIZER: "finalizer",
});
const ORIGIN = Object.freeze({ HUMAN: "human_event", RELAY: "planner_relay" });
const BINDING_REF_PATTERN = /^binding_ref_[0-9a-f]{24}$/u;
const PARTICIPANT_REF_PATTERN = /^participant_ref_[0-9a-f]{24}$/u;
const SNAPSHOT_ID_PATTERN = /^participant_snapshot_[0-9a-f]{24}$/u;
const RUN_ID_PATTERN = /^relay_run_[0-9a-f]{24}$/u;
const SUBSCRIPTION_ID_PATTERN = /^subscription_[0-9a-f]{24}$/u;
const LOCAL_TARGET_ID_PATTERN = /^(?:target|local_target)_[0-9a-f]{24}$/u;
const CHANNEL_GENERATION_ID_PATTERN = /^channel_generation_[0-9a-f]{24}$/u;
const CLAIM_ID_PATTERN = /^[0-9a-f]{64}$/u;
const OUTPUT_REF_PATTERN = /^output_ref_[0-9a-f]{24}$/u;
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const safeIdentityPart = (value) => nonEmpty(value) && !value.includes("\0");
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const iso = (now) => new Date(now).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const uniqueStrings = (values) => [...new Set(values ?? [])];
const onlyKeys = (value, allowed) => value && typeof value === "object" &&
  Object.keys(value).every((key) => allowed.includes(key));
const sameMembers = (values, expected) => Array.isArray(values) &&
  values.length === expected.length && expected.every((item) => values.includes(item));

const digestRef = (prefix, parts) => prefix + crypto.createHash("sha256")
  .update(parts.join("\0"))
  .digest("hex")
  .slice(0, 24);

/** 跨 adapter 共用的 opaque binding ref；私有 binding key 不进入返回值。 */
export function deriveDialogueBindingRef({
  runtimeNamespace, endpointId, privateBindingKey,
} = {}) {
  if (![runtimeNamespace, endpointId, privateBindingKey].every(safeIdentityPart)) {
    return { ok: false, reason: RELAY_REASON.INVALID_SNAPSHOT };
  }
  return {
    ok: true,
    bindingRef: digestRef("binding_ref_", [
      "dialogue-binding-ref/v1", runtimeNamespace, endpointId, privateBindingKey,
    ]),
  };
}

/** participant id 同样只暴露摘要；privateIdentityKey 可以是 sender 或 adapter 私有 target key。 */
export function deriveDialogueParticipantRef({
  kind, runtimeNamespace, endpointId, privateIdentityKey,
} = {}) {
  if (!["human", "agent"].includes(kind) ||
      ![runtimeNamespace, endpointId, privateIdentityKey].every(safeIdentityPart)) {
    return { ok: false, reason: RELAY_REASON.INVALID_SNAPSHOT };
  }
  return {
    ok: true,
    participantId: digestRef("participant_ref_", [
      "dialogue-participant-ref/v1", kind, runtimeNamespace, endpointId, privateIdentityKey,
    ]),
  };
}

/** 严格终局正文留在 adapter 私有存储；planner 只传不可逆 output ref。 */
export function deriveDialogueOutputRef({ dialogueId, runId, terminalEventId } = {}) {
  if (![dialogueId, runId, terminalEventId].every(safeIdentityPart) ||
      !RUN_ID_PATTERN.test(runId)) {
    return { ok: false, reason: RELAY_REASON.OUTPUT_REF_INVALID };
  }
  return { ok: true, outputRef: digestRef("output_ref_", [
    "dialogue-output-ref/v1", dialogueId, runId, terminalEventId,
  ]) };
}

const validParticipant = (participant) => {
  if (!onlyKeys(participant, ["participant_id", "kind", "roles", "subscription_id",
    "binding_ref", "local_target_id", "allowed_origins", "limits"])) return false;
  if (!PARTICIPANT_REF_PATTERN.test(participant?.participant_id) ||
      !["human", "agent"].includes(participant?.kind) ||
      !Array.isArray(participant?.roles) || participant.roles.length === 0 ||
      uniqueStrings(participant.roles).length !== participant.roles.length ||
      participant.roles.some((role) => !Object.values(ROLE).includes(role)) ||
      !Array.isArray(participant?.allowed_origins) || participant.allowed_origins.length === 0 ||
      uniqueStrings(participant.allowed_origins).length !== participant.allowed_origins.length ||
      participant.allowed_origins.some((origin) => !Object.values(ORIGIN).includes(origin)) ||
      !onlyKeys(participant?.limits, ["max_agent_runs", "resource_units_per_run"]) ||
      !positiveInteger(participant.limits.max_agent_runs) ||
      !positiveInteger(participant.limits.resource_units_per_run)) return false;
  if (participant.kind === "human") {
    return participant.subscription_id === null && participant.binding_ref === null &&
      participant.local_target_id === null && participant.roles.includes(ROLE.REQUESTER) &&
      participant.allowed_origins.includes(ORIGIN.HUMAN);
  }
  return SUBSCRIPTION_ID_PATTERN.test(participant.subscription_id ?? "") &&
    BINDING_REF_PATTERN.test(participant.binding_ref) &&
    LOCAL_TARGET_ID_PATTERN.test(participant.local_target_id ?? "") &&
    participant.allowed_origins.includes(ORIGIN.RELAY);
};

const normalizedSnapshotParticipants = (participants) => clone(participants ?? []).map(
  (participant) => ({
    participant_id: participant?.participant_id,
    kind: participant?.kind,
    roles: [...(participant?.roles ?? [])].sort(),
    subscription_id: participant?.subscription_id,
    binding_ref: participant?.binding_ref,
    local_target_id: participant?.local_target_id,
    allowed_origins: [...(participant?.allowed_origins ?? [])].sort(),
    limits: {
      max_agent_runs: participant?.limits?.max_agent_runs,
      resource_units_per_run: participant?.limits?.resource_units_per_run,
    },
  }),
).sort((a, b) => String(a.participant_id).localeCompare(String(b.participant_id)));

const participantSnapshotId = ({ authorizationRevision, capturedAt, coordinatorBindingRef,
  participants }) => digestRef("participant_snapshot_", [
  "dialogue-participant-snapshot/v1", String(authorizationRevision ?? ""),
  String(capturedAt ?? ""), String(coordinatorBindingRef ?? ""),
  JSON.stringify(normalizedSnapshotParticipants(participants)),
]);

export function validateParticipantAuthorizationSnapshot(snapshot) {
  if (!onlyKeys(snapshot, ["schema_version", "artifact_type", "snapshot_id",
    "authorization_revision", "captured_at", "coordinator_binding_ref", "participants"]) ||
      snapshot?.schema_version !== PARTICIPANT_SNAPSHOT_SCHEMA_VERSION ||
      snapshot?.artifact_type !== PARTICIPANT_SNAPSHOT_ARTIFACT_TYPE ||
      !SNAPSHOT_ID_PATTERN.test(snapshot?.snapshot_id ?? "") ||
      !positiveInteger(snapshot?.authorization_revision) ||
      !Number.isFinite(Date.parse(snapshot?.captured_at ?? "")) ||
      !BINDING_REF_PATTERN.test(snapshot?.coordinator_binding_ref ?? "") ||
      !Array.isArray(snapshot?.participants) || snapshot.participants.length !== 3 ||
      snapshot.participants.some((participant) => !validParticipant(participant)) ||
      snapshot.snapshot_id !== participantSnapshotId({
        authorizationRevision: snapshot.authorization_revision, capturedAt: snapshot.captured_at,
        coordinatorBindingRef: snapshot.coordinator_binding_ref, participants: snapshot.participants,
      })) {
    return { ok: false, reason: RELAY_REASON.INVALID_SNAPSHOT };
  }
  const ids = snapshot.participants.map((participant) => participant.participant_id);
  if (new Set(ids).size !== ids.length) return { ok: false, reason: RELAY_REASON.INVALID_SNAPSHOT };
  const humans = snapshot.participants.filter((participant) => participant.kind === "human");
  const hosts = snapshot.participants.filter((participant) => participant.roles.includes(ROLE.HOST));
  const peers = snapshot.participants.filter((participant) => participant.roles.includes(ROLE.PEER));
  const finalizers = snapshot.participants.filter((participant) =>
    participant.roles.includes(ROLE.FINALIZER));
  if (humans.length !== 1 || hosts.length !== 1 || peers.length !== 1 || finalizers.length !== 1 ||
      hosts[0].participant_id !== finalizers[0].participant_id ||
      hosts[0].participant_id === peers[0].participant_id ||
      hosts[0].binding_ref !== snapshot.coordinator_binding_ref ||
      hosts[0].limits.max_agent_runs < 2 ||
      !sameMembers(humans[0].roles, [ROLE.REQUESTER]) ||
      !sameMembers(humans[0].allowed_origins, [ORIGIN.HUMAN]) ||
      !sameMembers(hosts[0].roles, [ROLE.HOST, ROLE.FINALIZER]) ||
      !sameMembers(hosts[0].allowed_origins, [ORIGIN.HUMAN, ORIGIN.RELAY]) ||
      !sameMembers(peers[0].roles, [ROLE.PEER]) ||
      !sameMembers(peers[0].allowed_origins, [ORIGIN.RELAY])) {
    return { ok: false, reason: RELAY_REASON.INVALID_SNAPSHOT };
  }
  return { ok: true };
}

export function createParticipantAuthorizationSnapshot({
  authorizationRevision, capturedAt = Date.now(), coordinatorBindingRef, participants,
} = {}) {
  const captured = typeof capturedAt === "number" ? iso(capturedAt) : capturedAt;
  const normalizedParticipants = normalizedSnapshotParticipants(participants);
  const snapshot = {
    schema_version: PARTICIPANT_SNAPSHOT_SCHEMA_VERSION,
    artifact_type: PARTICIPANT_SNAPSHOT_ARTIFACT_TYPE,
    snapshot_id: participantSnapshotId({
      authorizationRevision, capturedAt: captured, coordinatorBindingRef,
      participants: normalizedParticipants,
    }),
    authorization_revision: authorizationRevision,
    captured_at: captured,
    coordinator_binding_ref: coordinatorBindingRef,
    participants: normalizedParticipants,
  };
  const valid = validateParticipantAuthorizationSnapshot(snapshot);
  return valid.ok ? { ok: true, snapshot } : valid;
}

const validBudget = (budget) => onlyKeys(budget,
  ["max_cycles", "max_agent_runs", "max_duration_ms", "max_resource_units"]) &&
  positiveInteger(budget?.max_cycles) && positiveInteger(budget?.max_agent_runs) &&
  positiveInteger(budget?.max_duration_ms) && positiveInteger(budget?.max_resource_units);

const participantForRole = (snapshot, role) => snapshot.participants.find((participant) =>
  participant.roles.includes(role));

const relayRunId = ({ dialogueId, cycleIndex, stepIndex, participantId }) =>
  digestRef("relay_run_", [
    "dialogue-relay-run/v1", dialogueId, String(cycleIndex), String(stepIndex), participantId,
  ]);

const initialParticipantUsage = (snapshot) => Object.fromEntries(snapshot.participants
  .filter((participant) => participant.kind === "agent")
  .map((participant) => [participant.participant_id, 0]));

export function createRelayPlanState({
  dialogueId, snapshot, budget = DEFAULT_RELAY_BUDGET, startedAt = Date.now(),
} = {}) {
  const snapshotValid = validateParticipantAuthorizationSnapshot(snapshot);
  if (!snapshotValid.ok || !nonEmpty(dialogueId) || !validBudget(budget) ||
      budget.max_agent_runs < 3 || budget.max_resource_units < 3) {
    return { ok: false, reason: snapshotValid.ok ? RELAY_REASON.INVALID_STATE : snapshotValid.reason };
  }
  const started = typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
  if (!Number.isFinite(started)) return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  const state = {
    schema_version: RELAY_PLAN_SCHEMA_VERSION,
    artifact_type: RELAY_PLAN_ARTIFACT_TYPE,
    policy_id: RELAY_POLICY_ID,
    policy_version: RELAY_POLICY_VERSION,
    dialogue_id: dialogueId,
    participant_snapshot_id: snapshot.snapshot_id,
    status: RELAY_PLAN_STATUS.ACTIVE,
    budget: { ...budget },
    usage: {
      cycles_started: 0,
      agent_runs_started: 0,
      resource_units_used: 0,
      participant_agent_runs: initialParticipantUsage(snapshot),
    },
    next_cycle_index: 1,
    active_cycle: null,
    last_cycle: null,
    processed_human_events: [],
    processed_terminal_events: [],
    started_at: iso(started),
    deadline_at: iso(started + budget.max_duration_ms),
    updated_at: iso(started),
    ended_at: null,
    stop_reason: null,
  };
  const valid = validateRelayPlanState(state, { snapshot });
  return valid.ok ? { ok: true, state } : valid;
}

const validStep = (step) => {
  if (!onlyKeys(step, ["step_index", "role", "participant_id", "run_id", "input_ref",
    "source_participant_id", "resource_units", "status", "dispatched_at", "finalized_at",
    "output_ref", "reason"]) || !positiveInteger(step?.step_index) ||
      ![ROLE.HOST, ROLE.PEER, ROLE.FINALIZER].includes(step?.role) ||
      !PARTICIPANT_REF_PATTERN.test(step?.participant_id ?? "") ||
      !RUN_ID_PATTERN.test(step?.run_id ?? "") || !nonEmpty(step?.input_ref) ||
      (step.step_index > 1 && !OUTPUT_REF_PATTERN.test(step.input_ref)) ||
      (step.source_participant_id !== null &&
        !PARTICIPANT_REF_PATTERN.test(step.source_participant_id ?? "")) ||
      !positiveInteger(step?.resource_units) ||
      !Object.values(RELAY_STEP_STATUS).includes(step?.status) ||
      !Number.isFinite(Date.parse(step?.dispatched_at ?? ""))) return false;
  if (step.status === RELAY_STEP_STATUS.DISPATCHED) {
    return step.finalized_at === null && step.output_ref === null && step.reason === null;
  }
  if (!Number.isFinite(Date.parse(step.finalized_at ?? ""))) return false;
  if (step.status === RELAY_STEP_STATUS.COMPLETED) {
    return OUTPUT_REF_PATTERN.test(step.output_ref ?? "") && step.reason === null;
  }
  return (step.output_ref === null || nonEmpty(step.output_ref)) && nonEmpty(step.reason);
};

const validCycle = (cycle, { active }) => {
  if (!onlyKeys(cycle, ["cycle_index", "human_event_id", "parent_human_claim_id",
    "origin_channel_generation_id", "steps", "active_step_index", "started_at", "completed_at"]) ||
      !positiveInteger(cycle?.cycle_index) || !nonEmpty(cycle?.human_event_id) ||
      !CLAIM_ID_PATTERN.test(cycle?.parent_human_claim_id ?? "") ||
      !CHANNEL_GENERATION_ID_PATTERN.test(cycle?.origin_channel_generation_id ?? "") ||
      !Array.isArray(cycle?.steps) || cycle.steps.length < 1 || cycle.steps.length > 3 ||
      !cycle.steps.every(validStep) ||
      !cycle.steps.map((step) => step.step_index).every((index, offset) => index === offset + 1) ||
      !positiveInteger(cycle?.active_step_index) || cycle.active_step_index > cycle.steps.length ||
      !Number.isFinite(Date.parse(cycle?.started_at ?? ""))) return false;
  const dispatched = cycle.steps.filter((step) => step.status === RELAY_STEP_STATUS.DISPATCHED);
  if (active) {
    return cycle.completed_at === null && dispatched.length === 1 &&
      cycle.steps.at(-1).status === RELAY_STEP_STATUS.DISPATCHED &&
      cycle.active_step_index === cycle.steps.length &&
      cycle.steps.slice(0, -1).every((step) => step.status === RELAY_STEP_STATUS.COMPLETED);
  }
  return Number.isFinite(Date.parse(cycle.completed_at ?? "")) && dispatched.length === 0;
};

const validCycleContract = (cycle, state, snapshot) => {
  if (cycle === null) return true;
  const expectedRoles = [ROLE.HOST, ROLE.PEER, ROLE.FINALIZER];
  return cycle.steps.every((step, offset) => {
    const role = expectedRoles[offset];
    const participant = participantForRole(snapshot, role);
    const prior = offset === 0 ? null : cycle.steps[offset - 1];
    return step.role === role && step.participant_id === participant?.participant_id &&
      step.resource_units === participant?.limits?.resource_units_per_run &&
      step.run_id === relayRunId({
        dialogueId: state.dialogue_id, cycleIndex: cycle.cycle_index,
        stepIndex: step.step_index, participantId: step.participant_id,
      }) && (offset === 0
        ? step.input_ref === cycle.human_event_id && step.source_participant_id === null
        : step.input_ref === prior.output_ref &&
          step.source_participant_id === prior.participant_id);
  });
};

export function validateRelayPlanState(state, { snapshot } = {}) {
  const snapshotValid = validateParticipantAuthorizationSnapshot(snapshot);
  if (!snapshotValid.ok || !onlyKeys(state, ["schema_version", "artifact_type", "policy_id",
    "policy_version", "dialogue_id", "participant_snapshot_id", "status", "budget", "usage",
    "next_cycle_index", "active_cycle", "last_cycle", "processed_human_events",
    "processed_terminal_events", "started_at", "deadline_at", "updated_at", "ended_at",
    "stop_reason"]) || state?.schema_version !== RELAY_PLAN_SCHEMA_VERSION ||
      state?.artifact_type !== RELAY_PLAN_ARTIFACT_TYPE || state?.policy_id !== RELAY_POLICY_ID ||
      state?.policy_version !== RELAY_POLICY_VERSION || !nonEmpty(state?.dialogue_id) ||
      state?.participant_snapshot_id !== snapshot.snapshot_id ||
      !Object.values(RELAY_PLAN_STATUS).includes(state?.status) || !validBudget(state?.budget) ||
      !onlyKeys(state?.usage, ["cycles_started", "agent_runs_started", "resource_units_used",
        "participant_agent_runs"]) ||
      !Number.isInteger(state.usage.cycles_started) || state.usage.cycles_started < 0 ||
      !Number.isInteger(state.usage.agent_runs_started) || state.usage.agent_runs_started < 0 ||
      !Number.isInteger(state.usage.resource_units_used) || state.usage.resource_units_used < 0 ||
      state.usage.cycles_started > state.budget.max_cycles ||
      state.usage.agent_runs_started > state.budget.max_agent_runs ||
      state.usage.resource_units_used > state.budget.max_resource_units ||
      !positiveInteger(state.next_cycle_index) || !Array.isArray(state.processed_human_events) ||
      !Array.isArray(state.processed_terminal_events) ||
      !Number.isFinite(Date.parse(state.started_at ?? "")) ||
      !Number.isFinite(Date.parse(state.deadline_at ?? "")) ||
      !Number.isFinite(Date.parse(state.updated_at ?? ""))) {
    return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  }
  const participantUsage = state.usage.participant_agent_runs;
  const agentIds = snapshot.participants.filter((participant) => participant.kind === "agent")
    .map((participant) => participant.participant_id).sort();
  if (!participantUsage || Object.keys(participantUsage).sort().join("\0") !== agentIds.join("\0") ||
      Object.values(participantUsage).some((value) => !Number.isInteger(value) || value < 0)) {
    return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  }
  const validHumanEvent = (item) => onlyKeys(item, ["event_id", "cycle_index",
    "parent_human_claim_id"]) && nonEmpty(item?.event_id) && positiveInteger(item?.cycle_index) &&
    CLAIM_ID_PATTERN.test(item?.parent_human_claim_id ?? "");
  const validTerminalEvent = (item) => onlyKeys(item, ["terminal_event_id", "run_id",
    "cycle_index", "step_index"]) && nonEmpty(item?.terminal_event_id) &&
    RUN_ID_PATTERN.test(item?.run_id ?? "") && positiveInteger(item?.cycle_index) &&
    positiveInteger(item?.step_index) && item.step_index <= 3;
  const humanIds = state.processed_human_events.map((item) => item?.event_id);
  const terminalIds = state.processed_terminal_events.map((item) => item?.terminal_event_id);
  if (humanIds.some((item) => !nonEmpty(item)) || new Set(humanIds).size !== humanIds.length ||
      terminalIds.some((item) => !nonEmpty(item)) || new Set(terminalIds).size !== terminalIds.length ||
      !state.processed_human_events.every(validHumanEvent) ||
      !state.processed_terminal_events.every(validTerminalEvent) ||
      (state.active_cycle !== null && !validCycle(state.active_cycle, { active: true })) ||
      (state.last_cycle !== null && !validCycle(state.last_cycle, { active: false })) ||
      !validCycleContract(state.active_cycle, state, snapshot) ||
      !validCycleContract(state.last_cycle, state, snapshot)) {
    return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  }
  const participantLimits = new Map(snapshot.participants.filter((participant) =>
    participant.kind === "agent").map((participant) =>
    [participant.participant_id, participant.limits.max_agent_runs]));
  if (Object.entries(participantUsage).some(([participantId, count]) =>
    count > participantLimits.get(participantId)) ||
      Object.values(participantUsage).reduce((sum, count) => sum + count, 0) !==
        state.usage.agent_runs_started ||
      state.next_cycle_index !== state.usage.cycles_started + 1) {
    return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  }
  if ((state.status === RELAY_PLAN_STATUS.ACTIVE) !== (state.ended_at === null) ||
      (state.status === RELAY_PLAN_STATUS.ACTIVE && state.stop_reason !== null) ||
      (state.status !== RELAY_PLAN_STATUS.ACTIVE &&
        (!Number.isFinite(Date.parse(state.ended_at ?? "")) || !nonEmpty(state.stop_reason))) ||
      (state.active_cycle !== null && state.status !== RELAY_PLAN_STATUS.ACTIVE)) {
    return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  }
  return { ok: true };
}

const stopState = (state, status, reason, now, { closeStepStatus = null } = {}) => {
  const next = clone(state);
  if (next.active_cycle) {
    const step = next.active_cycle.steps[next.active_cycle.active_step_index - 1];
    if (step?.status === RELAY_STEP_STATUS.DISPATCHED && closeStepStatus) {
      step.status = closeStepStatus;
      step.finalized_at = iso(now);
      step.reason = reason;
    }
    next.active_cycle.completed_at = iso(now);
    next.last_cycle = next.active_cycle;
    next.active_cycle = null;
  }
  next.status = status;
  next.stop_reason = reason;
  next.ended_at = iso(now);
  next.updated_at = iso(now);
  return next;
};

const budgetStop = (state, reason, now) => ({
  ok: true,
  changed: true,
  disposition: RELAY_DISPOSITION.STOP,
  reason,
  state: stopState(state, RELAY_PLAN_STATUS.COMPLETED, reason, now,
    { closeStepStatus: RELAY_STEP_STATUS.CANCELLED }),
});

const remainingCycleBudget = (state, snapshot) => {
  if (state.usage.cycles_started + 1 > state.budget.max_cycles) return RELAY_REASON.CYCLE_BUDGET;
  if (state.usage.agent_runs_started + 3 > state.budget.max_agent_runs) {
    return RELAY_REASON.AGENT_RUN_BUDGET;
  }
  const host = participantForRole(snapshot, ROLE.HOST);
  const peer = participantForRole(snapshot, ROLE.PEER);
  const resources = host.limits.resource_units_per_run * 2 + peer.limits.resource_units_per_run;
  if (state.usage.resource_units_used + resources > state.budget.max_resource_units) {
    return RELAY_REASON.RESOURCE_BUDGET;
  }
  if (state.usage.participant_agent_runs[host.participant_id] + 2 > host.limits.max_agent_runs ||
      state.usage.participant_agent_runs[peer.participant_id] + 1 > peer.limits.max_agent_runs) {
    return RELAY_REASON.PARTICIPANT_BUDGET;
  }
  return null;
};

const dispatchStep = (state, snapshot, {
  role, inputRef, sourceParticipantId = null, now,
}) => {
  const next = clone(state);
  const participant = participantForRole(snapshot, role);
  const cycle = next.active_cycle;
  const stepIndex = cycle.steps.length + 1;
  const runId = relayRunId({
    dialogueId: next.dialogue_id, cycleIndex: cycle.cycle_index,
    stepIndex, participantId: participant.participant_id,
  });
  const step = {
    step_index: stepIndex,
    role,
    participant_id: participant.participant_id,
    run_id: runId,
    input_ref: inputRef,
    source_participant_id: sourceParticipantId,
    resource_units: participant.limits.resource_units_per_run,
    status: RELAY_STEP_STATUS.DISPATCHED,
    dispatched_at: iso(now),
    finalized_at: null,
    output_ref: null,
    reason: null,
  };
  cycle.steps.push(step);
  cycle.active_step_index = stepIndex;
  next.usage.agent_runs_started += 1;
  next.usage.resource_units_used += step.resource_units;
  next.usage.participant_agent_runs[participant.participant_id] += 1;
  next.updated_at = iso(now);
  return {
    state: next,
    runRequest: {
      run_id: runId,
      policy_id: RELAY_POLICY_ID,
      policy_version: RELAY_POLICY_VERSION,
      dialogue_id: next.dialogue_id,
      cycle_index: cycle.cycle_index,
      step_index: stepIndex,
      role,
      participant_id: participant.participant_id,
      local_target_id: participant.local_target_id,
      parent_human_claim_id: cycle.parent_human_claim_id,
      origin_channel_generation_id: cycle.origin_channel_generation_id,
      input: {
        kind: stepIndex === 1 ? "human_event_ref" : "agent_output_ref",
        ref_id: inputRef,
        source_participant_id: sourceParticipantId,
      },
      resource_units: step.resource_units,
    },
  };
};

export function startRelayCycle(state, {
  snapshot, humanEventId, parentHumanClaimId, originChannelGenerationId, now = Date.now(),
} = {}) {
  const valid = validateRelayPlanState(state, { snapshot });
  if (!valid.ok || !nonEmpty(humanEventId) || !CLAIM_ID_PATTERN.test(parentHumanClaimId ?? "") ||
      !CHANNEL_GENERATION_ID_PATTERN.test(originChannelGenerationId ?? "")) {
    return valid.ok ? { ok: false, reason: RELAY_REASON.INVALID_STATE } : valid;
  }
  const prior = state.processed_human_events.find((item) => item.event_id === humanEventId);
  if (prior) return { ok: true, changed: false, disposition: RELAY_DISPOSITION.DUPLICATE,
    reason: RELAY_REASON.DUPLICATE_HUMAN_EVENT, state: clone(state), prior: clone(prior) };
  if (state.status !== RELAY_PLAN_STATUS.ACTIVE) {
    return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  }
  if (now < Date.parse(state.started_at)) return { ok: false, reason: RELAY_REASON.INVALID_STATE };
  if (now >= Date.parse(state.deadline_at)) return budgetStop(state, RELAY_REASON.TIME_BUDGET, now);
  if (state.active_cycle) return { ok: true, changed: false, disposition: RELAY_DISPOSITION.BUSY,
    reason: RELAY_REASON.ALREADY_ACTIVE, state: clone(state) };
  const budgetReason = remainingCycleBudget(state, snapshot);
  if (budgetReason) return budgetStop(state, budgetReason, now);

  const next = clone(state);
  const cycleIndex = next.next_cycle_index;
  next.active_cycle = {
    cycle_index: cycleIndex,
    human_event_id: humanEventId,
    parent_human_claim_id: parentHumanClaimId,
    origin_channel_generation_id: originChannelGenerationId,
    steps: [],
    active_step_index: 1,
    started_at: iso(now),
    completed_at: null,
  };
  next.processed_human_events.push({ event_id: humanEventId, cycle_index: cycleIndex,
    parent_human_claim_id: parentHumanClaimId });
  next.processed_human_events = next.processed_human_events.slice(-256);
  next.usage.cycles_started += 1;
  next.next_cycle_index += 1;
  const dispatched = dispatchStep(next, snapshot, {
    role: ROLE.HOST, inputRef: humanEventId, now,
  });
  return { ok: true, changed: true, disposition: RELAY_DISPOSITION.DISPATCH_ONE,
    state: dispatched.state, runRequest: dispatched.runRequest };
}

export function advanceRelayPlan(state, {
  snapshot, runId, terminalEventId, status, outputRef = null, reason = null, now = Date.now(),
} = {}) {
  const valid = validateRelayPlanState(state, { snapshot });
  if (!valid.ok || ![runId, terminalEventId].every(nonEmpty) ||
      ![RELAY_STEP_STATUS.COMPLETED, RELAY_STEP_STATUS.FAILED,
        RELAY_STEP_STATUS.CANCELLED].includes(status)) {
    return valid.ok ? { ok: false, reason: RELAY_REASON.INVALID_STATE } : valid;
  }
  const prior = state.processed_terminal_events.find((item) =>
    item.terminal_event_id === terminalEventId);
  if (prior) return { ok: true, changed: false, disposition: RELAY_DISPOSITION.DUPLICATE,
    reason: RELAY_REASON.DUPLICATE_TERMINAL_EVENT, state: clone(state), prior: clone(prior) };
  const cycle = state.active_cycle;
  const active = cycle?.steps?.[cycle.active_step_index - 1];
  if (!active || active.status !== RELAY_STEP_STATUS.DISPATCHED || active.run_id !== runId) {
    return { ok: false, reason: RELAY_REASON.RUN_MISMATCH };
  }
  if (now < Date.parse(active.dispatched_at)) return { ok: false, reason: RELAY_REASON.INVALID_STATE };

  const next = clone(state);
  const nextCycle = next.active_cycle;
  const nextStep = nextCycle.steps[nextCycle.active_step_index - 1];
  const expectedOutputRef = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId, terminalEventId,
  }).outputRef;
  const finalStatus = status === RELAY_STEP_STATUS.COMPLETED && outputRef !== expectedOutputRef
    ? RELAY_STEP_STATUS.FAILED
    : status;
  const finalReason = finalStatus === RELAY_STEP_STATUS.FAILED
    ? (status === RELAY_STEP_STATUS.COMPLETED
      ? (nonEmpty(outputRef) ? RELAY_REASON.OUTPUT_REF_INVALID : RELAY_REASON.EMPTY_OUTPUT) :
      (nonEmpty(reason) ? reason : RELAY_REASON.RUNTIME_FAILED))
    : finalStatus === RELAY_STEP_STATUS.CANCELLED
      ? (nonEmpty(reason) ? reason : RELAY_REASON.HUMAN_INTERRUPT)
      : null;
  nextStep.status = finalStatus;
  nextStep.finalized_at = iso(now);
  nextStep.output_ref = finalStatus === RELAY_STEP_STATUS.COMPLETED ? outputRef : null;
  nextStep.reason = finalReason;
  next.processed_terminal_events.push({ terminal_event_id: terminalEventId, run_id: runId,
    cycle_index: nextCycle.cycle_index, step_index: nextStep.step_index });
  next.processed_terminal_events = next.processed_terminal_events.slice(-256);
  next.updated_at = iso(now);

  if (finalStatus === RELAY_STEP_STATUS.FAILED) {
    const stopped = stopState(next, RELAY_PLAN_STATUS.FAILED, finalReason, now);
    return { ok: true, changed: true, disposition: RELAY_DISPOSITION.STOP,
      reason: finalReason, state: stopped };
  }
  if (finalStatus === RELAY_STEP_STATUS.CANCELLED) {
    const stopped = stopState(next, RELAY_PLAN_STATUS.CANCELLED,
      finalReason, now);
    return { ok: true, changed: true, disposition: RELAY_DISPOSITION.STOP,
      reason: stopped.stop_reason, state: stopped };
  }
  if (now >= Date.parse(next.deadline_at)) {
    const stopped = stopState(next, RELAY_PLAN_STATUS.COMPLETED, RELAY_REASON.TIME_BUDGET, now);
    return { ok: true, changed: true, disposition: RELAY_DISPOSITION.STOP,
      reason: RELAY_REASON.TIME_BUDGET, state: stopped };
  }

  if (nextStep.role === ROLE.HOST) {
    const dispatched = dispatchStep(next, snapshot, {
      role: ROLE.PEER, inputRef: outputRef, sourceParticipantId: nextStep.participant_id, now,
    });
    return { ok: true, changed: true, disposition: RELAY_DISPOSITION.DISPATCH_ONE,
      state: dispatched.state, runRequest: dispatched.runRequest };
  }
  if (nextStep.role === ROLE.PEER) {
    const dispatched = dispatchStep(next, snapshot, {
      role: ROLE.FINALIZER, inputRef: outputRef, sourceParticipantId: nextStep.participant_id, now,
    });
    return { ok: true, changed: true, disposition: RELAY_DISPOSITION.DISPATCH_ONE,
      state: dispatched.state, runRequest: dispatched.runRequest };
  }

  nextCycle.completed_at = iso(now);
  next.last_cycle = nextCycle;
  next.active_cycle = null;
  next.updated_at = iso(now);
  return { ok: true, changed: true, disposition: RELAY_DISPOSITION.WAIT_HUMAN,
    state: next, finalOutputRef: outputRef };
}

export function cancelRelayPlan(state, {
  snapshot, reason = RELAY_REASON.HUMAN_INTERRUPT, now = Date.now(),
} = {}) {
  const valid = validateRelayPlanState(state, { snapshot });
  if (!valid.ok || ![RELAY_REASON.HUMAN_INTERRUPT, RELAY_REASON.AUTHORIZATION_REVOKED]
    .includes(reason)) return valid.ok ? { ok: false, reason: RELAY_REASON.INVALID_STATE } : valid;
  if (state.status !== RELAY_PLAN_STATUS.ACTIVE) {
    return { ok: true, changed: false, disposition: RELAY_DISPOSITION.STOP,
      reason: state.stop_reason, state: clone(state) };
  }
  return { ok: true, changed: true, disposition: RELAY_DISPOSITION.STOP, reason,
    state: stopState(state, RELAY_PLAN_STATUS.CANCELLED, reason, now,
      { closeStepStatus: RELAY_STEP_STATUS.CANCELLED }) };
}
