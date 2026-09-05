/**
 * ipsp-1 —— interaction_policy_state 条目的唯一封闭校验器（#R31，policy-store 前置块第一交付物）。
 *
 * 与现行 interaction-policy.validateInteractionPolicyState 的关系：后者是读写方的旧鸭子校验
 * （不查多余键、不查时间规范性），本模块是 policy.json 存储层的封闭校验器——键集从
 * interaction-policy.mjs 的 validDialogueContract 与写路径（setInteractionPolicyMode /
 * reserveDialogueTurn / finalizeDialogueTurn / stopDialogue）**冻结枚举**：每支逐键必有/可空/
 * 值域写死，多余键与缺键一律拒。T4 的 policy-1 收口以本块为硬前置（m1a-reconciliation §4）。
 *
 * 本模块纯内存，不读写文件。三端（写端 / renderer / 权威读取端）共用本导出，不各写第二份。
 */

import { isCanonicalIso } from "../canonical-time.mjs";
import { usableGeneration } from "../topic-generation.mjs";
import {
  DIALOGUE_POLICY_ID, DIALOGUE_STATUS, DIALOGUE_TURN_STATUS,
  DIALOGUE_STOP_CONDITIONS, DIALOGUE_FINAL_REASONS, INTERACTION_POLICY_SCHEMA_VERSION,
} from "../interaction-policy.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (o) => Object.keys(o).sort().join(",");
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const positiveInteger = (v) => Number.isInteger(v) && v > 0;
const nonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;

/** 六根键精确（m1a §4 policy-1 条目契约）：schema_version/binding_id/policy_id/policy_version/updated_at/dialogue。 */
const ROOT_KEYS = "binding_id,dialogue,policy_id,policy_version,schema_version,updated_at";

/** dialogue 必有键全集（写路径创建体冻结：19 键）；last_turn 由 finalize/stop 才写 → 可选。 */
const DIALOGUE_REQUIRED_KEYS = [
  "active_turn", "allow_agent_output_as_input", "budget", "concurrency", "deadline_at",
  "dialogue_id", "ended_at", "finalization", "host", "next_turn_index", "participants",
  "processed_events", "started_at", "status", "stop_conditions", "stop_reason",
  "turn_order", "updated_at", "usage",
];
const DIALOGUE_KEY_SET = new Set([...DIALOGUE_REQUIRED_KEYS, "last_turn"]); // 唯一可选键
const dialogueKeysProblem = (d) => {
  const keys = Object.keys(d);
  return keys.length === DIALOGUE_REQUIRED_KEYS.length + (d.last_turn !== undefined ? 1 : 0) &&
    keys.every((k) => DIALOGUE_KEY_SET.has(k)) ? null : "dialogue_keys";
};

/** turn 共有键（reserveDialogueTurn 的 reservation 冻结：10 键）。 */
const TURN_KEYS = [
  "dialogue_id", "dispatched_at", "event_id", "local_target_id",
  "origin_channel_generation_id", "resource_units", "runtime_target_id", "run_id",
  "status", "turn_index",
].sort().join(",");

/** last_turn = {...active_turn, status→终态, finalized_at, reason} → 12 键。 */
const LAST_TURN_KEYS = [...TURN_KEYS.split(","), "finalized_at", "reason"].sort().join(",");

const HOST_KEYS = "participant_id,role";
const PARTICIPANT_KEYS = "participant_id,role";
const FINALIZATION_KEYS = "publish_target,summarizer_participant_id";
const CONCURRENCY_KEYS = "agent_output_relay,duplicate_event,max_active_turns,mention_loop";
const BUDGET_KEYS = "max_duration_ms,max_resource_units,max_rounds";
const USAGE_KEYS = "resource_units_used,rounds_started";
const PROCESSED_EVENT_KEYS = "dialogue_id,event_id,run_id,turn_index";

const turnFacts = (turn) => ({
  idsOk: nonEmpty(turn.dialogue_id) && nonEmpty(turn.event_id) && nonEmpty(turn.run_id) && nonEmpty(turn.local_target_id),
  idxOk: positiveInteger(turn.turn_index),
  runtimeOk: turn.runtime_target_id === null || nonEmpty(turn.runtime_target_id),
  unitsOk: positiveInteger(turn.resource_units),
  genOk: usableGeneration(turn.origin_channel_generation_id),
});

/**
 * 校验 interaction_policy_state 条目；返回问题码字符串（fail-closed 的 reason）或 null（合法）。
 * { bindingId } 给定时要求条目 binding_id 与之一致（存储层外键核对）。
 */
export function interactionPolicyStateProblem(state, { bindingId } = {}) {
  if (!isObj(state)) return "policy_not_object";
  if (keysOf(state) !== ROOT_KEYS) return "policy_root_keys";
  if (state.schema_version !== INTERACTION_POLICY_SCHEMA_VERSION) return "policy_schema_version";
  if (!nonEmpty(state.binding_id)) return "policy_binding_id";
  if (bindingId !== undefined && state.binding_id !== bindingId) return "policy_binding_id_mismatch";
  if (!isCanonicalIso(state.updated_at)) return "policy_updated_at";

  const mappingMode = state.policy_id === "mapping" && state.policy_version === "1.0";
  const dialogueMode = state.policy_id === DIALOGUE_POLICY_ID && state.policy_version === "1.0";
  if (!mappingMode && !dialogueMode) return "policy_id";

  if (mappingMode && state.dialogue === null) return null;
  const d = state.dialogue;
  if (!isObj(d) || dialogueKeysProblem(d) !== null) return "dialogue_keys";
  if (mappingMode && d.status === DIALOGUE_STATUS.ACTIVE) return "mapping_active_dialogue";

  if (!nonEmpty(d.dialogue_id)) return "dialogue_id";
  if (!Object.values(DIALOGUE_STATUS).includes(d.status)) return "dialogue_status";
  if (!isObj(d.host) || keysOf(d.host) !== HOST_KEYS ||
      d.host.participant_id !== "bound_local_target" || d.host.role !== "host") return "dialogue_host";
  if (!Array.isArray(d.participants) || d.participants.length !== 2 ||
      !d.participants.every((p) => isObj(p) && keysOf(p) === PARTICIPANT_KEYS) ||
      !d.participants.some((p) => p.participant_id === "authorized_human" && p.role === "human") ||
      !d.participants.some((p) => p.participant_id === "bound_local_target" && p.role === "host")) {
    return "dialogue_participants";
  }
  if (d.turn_order !== "human_then_host_serial") return "dialogue_turn_order";
  if (d.allow_agent_output_as_input !== false) return "dialogue_allow_agent_output_as_input";
  if (!isObj(d.finalization) || keysOf(d.finalization) !== FINALIZATION_KEYS ||
      d.finalization.summarizer_participant_id !== "bound_local_target" ||
      d.finalization.publish_target !== "origin_channel_generation") return "dialogue_finalization";
  if (!isObj(d.concurrency) || keysOf(d.concurrency) !== CONCURRENCY_KEYS ||
      d.concurrency.max_active_turns !== 1 || d.concurrency.duplicate_event !== "idempotent" ||
      d.concurrency.mention_loop !== "disabled" ||
      d.concurrency.agent_output_relay !== "disabled") return "dialogue_concurrency";
  if (!Array.isArray(d.stop_conditions) || d.stop_conditions.length !== DIALOGUE_STOP_CONDITIONS.length ||
      !DIALOGUE_STOP_CONDITIONS.every((c) => d.stop_conditions.includes(c))) return "dialogue_stop_conditions";
  if (!isObj(d.budget) || keysOf(d.budget) !== BUDGET_KEYS ||
      !positiveInteger(d.budget.max_rounds) || !positiveInteger(d.budget.max_duration_ms) ||
      !positiveInteger(d.budget.max_resource_units)) return "dialogue_budget";
  if (!isObj(d.usage) || keysOf(d.usage) !== USAGE_KEYS ||
      !nonNegativeInteger(d.usage.rounds_started) ||
      !nonNegativeInteger(d.usage.resource_units_used) ||
      d.usage.rounds_started > d.budget.max_rounds ||
      d.usage.resource_units_used > d.budget.max_resource_units) return "dialogue_usage";
  if (!positiveInteger(d.next_turn_index)) return "dialogue_next_turn_index";
  if (!Array.isArray(d.processed_events) ||
      !d.processed_events.every((e) => isObj(e) && keysOf(e) === PROCESSED_EVENT_KEYS &&
        nonEmpty(e.event_id) && nonEmpty(e.run_id) && nonEmpty(e.dialogue_id) &&
        positiveInteger(e.turn_index)) ||
      new Set(d.processed_events.map((e) => e.event_id)).size !== d.processed_events.length) {
    return "dialogue_processed_events";
  }
  if (!isCanonicalIso(d.started_at)) return "dialogue_started_at";
  if (!isCanonicalIso(d.deadline_at)) return "dialogue_deadline_at";
  if (!isCanonicalIso(d.updated_at)) return "dialogue_updated_at";

  // 状态关系联合封闭（#R33 P1-1）：终局三值（failed/completed/cancelled）必有规范 ended_at +
  // 受控终局原因且 active_turn 空；active 反之；mapping 是终局审计快照，三元组可遗留可空但值域仍受控。
  // 与写路径冻结的对应关系：终局三元组由 finalize/stop 写入；dialogue→mapping 直接切回时末跑完终局的
  // dialogue 会带 null 三元组进快照 —— 这是合法演进，不算矛盾。
  if (d.status === DIALOGUE_STATUS.ACTIVE) {
    if (d.ended_at !== null || d.stop_reason !== null) return "dialogue_status";
  } else {
    if ([DIALOGUE_TURN_STATUS.COMPLETED, DIALOGUE_TURN_STATUS.FAILED, DIALOGUE_TURN_STATUS.CANCELLED].includes(d.status)) {
      if (d.ended_at === null || !isCanonicalIso(d.ended_at)) return "dialogue_ended_at";
      if (d.stop_reason === null || !DIALOGUE_FINAL_REASONS.includes(d.stop_reason)) return "dialogue_stop_reason";
      if (d.active_turn !== null) return "dialogue_active_turn";
    } else if (d.ended_at !== null && !isCanonicalIso(d.ended_at)) return "dialogue_ended_at";
  }

  const eventIds = d.processed_events.map((e) => e.event_id);
  const eventOf = (evId) => d.processed_events.find((e) => e.event_id === evId);
  if (d.active_turn !== null) {
    const t = d.active_turn;
    if (!isObj(t) || keysOf(t) !== TURN_KEYS) return "dialogue_active_turn";
    const f = turnFacts(t);
    const ev = eventOf(t.event_id);
    if (!f.idsOk || !f.idxOk || !f.runtimeOk || !f.unitsOk || !f.genOk ||
        t.status !== DIALOGUE_TURN_STATUS.DISPATCHED || !isCanonicalIso(t.dispatched_at) ||
        t.dialogue_id !== d.dialogue_id || t.turn_index >= d.next_turn_index ||
        // 全元组一致（#R33 P1-1）：同 event_id 的 run_id/dialogue_id/turn_index 必须逐字段相等
        ev === undefined || ev.run_id !== t.run_id ||
        ev.dialogue_id !== t.dialogue_id || ev.turn_index !== t.turn_index) return "dialogue_active_turn";
  }
  if (d.last_turn !== undefined) {
    const t = d.last_turn;
    if (!isObj(t) || keysOf(t) !== LAST_TURN_KEYS) return "dialogue_last_turn";
    const f = turnFacts(t);
    const ev = eventOf(t.event_id);
    if (!f.idsOk || !f.idxOk || !f.runtimeOk || !f.unitsOk || !f.genOk ||
        ![DIALOGUE_TURN_STATUS.COMPLETED, DIALOGUE_TURN_STATUS.FAILED,
          DIALOGUE_TURN_STATUS.CANCELLED].includes(t.status) ||
        !isCanonicalIso(t.dispatched_at) || !isCanonicalIso(t.finalized_at) ||
        (t.reason !== null && !DIALOGUE_FINAL_REASONS.includes(t.reason)) ||
        t.dialogue_id !== d.dialogue_id || t.turn_index >= d.next_turn_index ||
        ev === undefined || ev.run_id !== t.run_id ||
        ev.dialogue_id !== t.dialogue_id || ev.turn_index !== t.turn_index) return "dialogue_last_turn";
  }
  return null;
}
