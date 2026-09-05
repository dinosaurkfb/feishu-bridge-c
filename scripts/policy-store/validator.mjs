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
import { ENDPOINT_SHAPE, ID_SHAPE, LINEAGE_SHAPE, canonKey, sha256 } from "../topic-agent-ledger.mjs";
import {
  DIALOGUE_POLICY_ID, DIALOGUE_STATUS, DIALOGUE_TURN_STATUS,
  DIALOGUE_STOP_CONDITIONS, DIALOGUE_FINAL_REASONS, INTERACTION_POLICY_SCHEMA_VERSION,
} from "../interaction-policy.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (o) => Object.keys(o).sort().join(",");
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const positiveInteger = (v) => Number.isInteger(v) && v > 0;
const nonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;

/** 八根键精确（#R35 P1-2：subject↔binding_id 外键进条目本体）：六键 + subject_kind/subject_id。 */
const ROOT_KEYS = "binding_id,dialogue,policy_id,policy_version,schema_version,subject_id,subject_kind,updated_at";

/** policy_subject 派生域（与 store.mjs 同一实现，store re-export 保持 API；#R35 P1-2 搬入校验器，
 *  外键自洽校验要在同一处算 ps_，避免 store↔validator 循环 import）。 */
export const POLICY_SUBJECT_KINDS = Object.freeze(["lineage", "topic_agent"]);
export function policySubjectId({ kind, endpointId, id } = {}) {
  if (!POLICY_SUBJECT_KINDS.includes(kind)) throw new TypeError("policy_subject_id: kind 必须是 lineage|topic_agent");
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) throw new TypeError("policy_subject_id: endpointId 必须是 endpoint_<24hex>");
  if (typeof id !== "string" || id.length === 0) throw new TypeError("policy_subject_id: id 必须是非空字符串");
  if (kind === "topic_agent" && !ID_SHAPE.test(id)) throw new TypeError("policy_subject_id: topic_agent id 必须是 ta_<32hex>");
  if (kind === "lineage" && !LINEAGE_SHAPE.test(id)) throw new TypeError("policy_subject_id: lineage id 必须是账本 lineage 形状（有界、无控制字符）");
  return "ps_" + sha256(canonKey({ domain: "policy_subject_v1", kind, endpoint_id: endpointId, id })).slice(0, 32);
}

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
 * { endpointId, subjectKey } 给定时（存储层）重算 ps_ 核对键与 subject_kind/subject_id 自洽
 * （#R35 P1-2 外键三重：条目内 kind↔id 形状、binding_id===subject_id、键↔字段哈希自洽）。
 */
export function interactionPolicyStateProblem(state, { bindingId, endpointId, subjectKey } = {}) {
  if (!isObj(state)) return "policy_not_object";
  if (keysOf(state) !== ROOT_KEYS) return "policy_root_keys";
  if (state.schema_version !== INTERACTION_POLICY_SCHEMA_VERSION) return "policy_schema_version";
  if (!POLICY_SUBJECT_KINDS.includes(state.subject_kind)) return "policy_subject_kind";
  if (typeof state.subject_id !== "string" || state.subject_id.length === 0) return "policy_subject_id";
  if (state.subject_kind === "topic_agent" && !ID_SHAPE.test(state.subject_id)) return "policy_subject_id";
  if (state.subject_kind === "lineage" && !LINEAGE_SHAPE.test(state.subject_id)) return "policy_subject_id";
  if (state.binding_id !== state.subject_id) return "policy_subject_binding_mismatch";
  if (endpointId !== undefined && subjectKey !== undefined &&
      policySubjectId({ kind: state.subject_kind, endpointId, id: state.subject_id }) !== subjectKey) {
    return "policy_subject_key_mismatch";
  }
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

  // 状态关系联合封闭（#R33 P1-1）+ dialogue.status × last_turn.status 封闭矩阵（#R35 P1-1）：
  // 终局三值必有规范 ended_at + 受控终局原因且 active_turn 空；active 反之。矩阵按写路径冻结：
  // failed ⇔ last_turn=failed（FAILED 分支唯一产生，跨回合覆盖）；cancelled ⇔ last_turn=cancelled
  //（finalize CANCELLED 唯一产生）；completed/active 时 last_turn 任意终态或缺席（stopDialogue 在
  // 无 active_turn 时保留上轮终态，映射切回后审计快照可能是任意组合，不作过度约束）。
  // mapping 是终局审计快照，三元组可遗留可空但值域仍受控。
  if (d.status === DIALOGUE_STATUS.ACTIVE) {
    if (d.ended_at !== null || d.stop_reason !== null) return "dialogue_status";
  } else {
    if ([DIALOGUE_TURN_STATUS.COMPLETED, DIALOGUE_TURN_STATUS.FAILED, DIALOGUE_TURN_STATUS.CANCELLED].includes(d.status)) {
      if (d.ended_at === null || !isCanonicalIso(d.ended_at)) return "dialogue_ended_at";
      if (d.stop_reason === null || !DIALOGUE_FINAL_REASONS.includes(d.stop_reason)) return "dialogue_stop_reason";
      if (d.active_turn !== null) return "dialogue_active_turn";
      if (d.status === DIALOGUE_TURN_STATUS.FAILED && d.last_turn !== undefined && d.last_turn.status !== DIALOGUE_TURN_STATUS.FAILED) return "dialogue_last_turn";
      if (d.status === DIALOGUE_TURN_STATUS.CANCELLED && d.last_turn !== undefined && d.last_turn.status !== DIALOGUE_TURN_STATUS.CANCELLED) return "dialogue_last_turn";
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
