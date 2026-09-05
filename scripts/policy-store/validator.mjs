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
  DIALOGUE_REASON, PROCESSED_EVENTS_WINDOW,
} from "../interaction-policy.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (o) => Object.keys(o).sort().join(",");
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const positiveInteger = (v) => Number.isInteger(v) && v > 0;
const nonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;

/** 六根键精确（#R38 P1-5 规格裁定：条目 = 原样六键 interaction_policy_state，m1a §4 policy-1）：
 *  binding_id 保留 legacy 原值只作出处（非空即可）；subject 挂载键由 store 层以显式 kind 从
 *  binding_id 派生并强制比对（#R41 P1-2），条目 schema 不带 subject 字段。 */
const ROOT_KEYS = "binding_id,dialogue,policy_id,policy_version,schema_version,updated_at";

/** policy_subject 派生域（与 store.mjs 同一实现，store re-export 保持 API）：键名派生的唯一判据。
 *  #R41 P1-2：外键自洽在 store 层强制 —— kind 由调用方显式声明（不从 binding_id 形状猜），
 *  store 核「声明 kind 派生出的键 == 挂载键」。 */
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
 * #R38 P1-5：撤掉 #R35 的八键与 binding_id===subject_id 强制 —— 规格赢（m1a §4 policy-1 定的
 * 是原样六键条目）；subject 关联（显式 kind + 派生比对 + binding 查重）在 store 层验（#R41 P1-2）。
 */
export function interactionPolicyStateProblem(state) {
  if (!isObj(state)) return "policy_not_object";
  if (keysOf(state) !== ROOT_KEYS) return "policy_root_keys";
  if (state.schema_version !== INTERACTION_POLICY_SCHEMA_VERSION) return "policy_schema_version";
  if (!nonEmpty(state.binding_id)) return "policy_binding_id";
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
        nonEmpty(e.event_id) && nonEmpty(e.run_id) && e.dialogue_id === d.dialogue_id &&
        positiveInteger(e.turn_index)) ||
      new Set(d.processed_events.map((e) => e.event_id)).size !== d.processed_events.length) {
    return "dialogue_processed_events";
  }
  const maxProcessedTurn = d.processed_events.length === 0 ? 0 : Math.max(...d.processed_events.map((e) => e.turn_index));
  if (d.next_turn_index !== maxProcessedTurn + 1) return "dialogue_next_turn_index";
  // #R41 P1-1 ③：轮数计账与回合索引锁步 —— 写路径里 rounds_started 与 next_turn_index 恒锁步 +1
  //（reserve 同步 +1、duplicate 幂等不改、finalize 不动）。脱钩即计账损坏：利害路径是篡改
  // rounds_started 后绕过 round_budget 闸多领轮次（旧版鸭子校验只看 rounds ≤ max，拦不住）。
  if (d.usage.rounds_started !== d.next_turn_index - 1) return "dialogue_usage";
  // #R42 P1-1 / #R43 P1：资源累计下界 + 不可见历史轮 —— 写方 reserve 开领即计（used +=
  // resource_units），任何时刻 active_turn（本回合）与 last_turn（上一回合）的 units 之和恒 ≤
  // used；rounds_started 超出可见轮数的每轮消耗不可见但已计入 used，而每轮 units 恒为正整数，
  // 故不可见轮每轮至少贡献 1。低报态（如篡改 used=0、或三轮后恰改到可见和）一旦过校验，
  // 准入闸（reserve 直接信 used）就会放行第三次领用超限（真耗 15/10 探针）——按下界不等式收，
  // 低报必拒；不可见轮数为 0（单/双回合）时全部消耗可见，进一步要求 used 恰等 visibleUnits
  // 完全封闭（高报同样拒）；高报且 unseenCount ≥ 1 只会提前触发保守停机，不在本刀范围。
  // unseenCount < 0 纯防御：known > rounds 的组合会被上方记账闭合/last 键检查前置封锁，
  // 可达性为零但 fail-closed 保留。
  {
    const visibleUnits = (d.active_turn !== null ? d.active_turn.resource_units : 0) +
      (d.last_turn !== undefined ? d.last_turn.resource_units : 0);
    const knownCount = (d.active_turn !== null ? 1 : 0) + (d.last_turn !== undefined ? 1 : 0);
    const unseenCount = d.usage.rounds_started - knownCount;
    if (unseenCount < 0) return "dialogue_usage";
    if (unseenCount === 0
      ? d.usage.resource_units_used !== visibleUnits
      : d.usage.resource_units_used < visibleUnits + unseenCount) return "dialogue_usage";
  }
  // #R41 P1-1 ③ / #R42 P2：processed_events 必须是当前保留窗口（PROCESSED_EVENTS_WINDOW）内的
  // 连续尾段，且**按存储顺序**逐项核（写方只追加 + slice(-WINDOW) 截断，产出恒为升序数组）。
  // 排序副本会把倒序数组合法化 —— 倒序态再追加会让写方的 push+slice 按存储序工作，产出乱序后继；
  // 中段缺口会让 duplicate 幂等闸被绕过（老事件重放），窗前截段、重复 turn_index、超长窗口
  // 也都不是写方能产出的形状。
  {
    const windowStart = Math.max(1, maxProcessedTurn - (PROCESSED_EVENTS_WINDOW - 1));
    for (let i = 0; i < d.processed_events.length; i += 1) {
      if (d.processed_events[i].turn_index !== windowStart + i) return "dialogue_processed_events";
    }
  }
  // #R41 P1-1 ①②：回合记账闭合 —— finalize 必写 last_turn、reserve 只在 active 空时开工，
  // 所以有 processed 事件时 active/last 至少一个在场：active 缺席则 last 必在（且恰为最新回合，
  // 由下方 last_turn 逐项检查钉死）；active 在场且已有完成回合（maxProcessedTurn ≥ 2）则 last
  // 必在且恰为 active 的上一回合。两者皆无或有历史却删 last_turn 都不是写方能产出的形状。
  if (d.processed_events.length > 0) {
    if (d.active_turn === null && d.last_turn === undefined) return "dialogue_last_turn";
    if (d.active_turn !== null && maxProcessedTurn >= 2 && d.last_turn === undefined) return "dialogue_last_turn";
    if (d.active_turn !== null && d.last_turn !== undefined &&
        d.last_turn.turn_index !== d.active_turn.turn_index - 1) return "dialogue_last_turn";
  }
  if (!isCanonicalIso(d.started_at)) return "dialogue_started_at";
  if (!isCanonicalIso(d.deadline_at)) return "dialogue_deadline_at";
  // #R42 P1-2：deadline 绑创建事实 —— 写方恒 deadline_at = started_at + max_duration_ms
  //（同一 now 生成，唯一赋值点）。恒等式破即篡改（如 1 秒预算改 100 秒，过原截止仍开工）；
  // 非规范时间已被上面 ISO 检查拒，这里 Date.parse 得 NaN 比较不等同样 fail-closed。
  if (Date.parse(d.deadline_at) - Date.parse(d.started_at) !== d.budget.max_duration_ms) {
    return "dialogue_deadline_at";
  }
  if (!isCanonicalIso(d.updated_at)) return "dialogue_updated_at";

  // 状态关系联合封闭（#R33 P1-1）+ dialogue.status × last_turn.status 封闭矩阵（#R40 P1-3）：
  // 真实状态机迁移全集闭合（set→reserve→finalize）：
  //   · failed 必须有 last_turn 且 status 为 failed，且 stop_reason 与 last_turn.reason 一致；
  //   · cancelled 携带 failed last_turn 必拒；stop_reason 与 last_turn.reason 必须自洽；
  //   · completed 携带 failed last_turn 必拒；stop_reason 为预算用尽原因且与 last_turn.reason 自洽；
  //   · active 的 last_turn 若存在必须为 completed（reason 必为 null）。
  if (d.status === DIALOGUE_STATUS.ACTIVE) {
    if (d.ended_at !== null || d.stop_reason !== null) return "dialogue_status";
    if (d.last_turn !== undefined && d.last_turn.status !== DIALOGUE_TURN_STATUS.COMPLETED) return "dialogue_last_turn";
  } else {
    if ([DIALOGUE_TURN_STATUS.COMPLETED, DIALOGUE_TURN_STATUS.FAILED, DIALOGUE_TURN_STATUS.CANCELLED].includes(d.status)) {
      if (d.ended_at === null || !isCanonicalIso(d.ended_at)) return "dialogue_ended_at";
      if (d.stop_reason === null || !DIALOGUE_FINAL_REASONS.includes(d.stop_reason)) return "dialogue_stop_reason";
      if (d.active_turn !== null) return "dialogue_active_turn";

      if (d.status === DIALOGUE_TURN_STATUS.FAILED) {
        // failed 删 last_turn 必拒；failed 携带非 failed last_turn 必拒
        if (d.last_turn === undefined || d.last_turn.status !== DIALOGUE_TURN_STATUS.FAILED) return "dialogue_last_turn";
        // stop_reason 与 last_turn.reason 矛盾必拒
        if (d.stop_reason !== (d.last_turn.reason ?? DIALOGUE_REASON.RUN_FAILED)) return "dialogue_stop_reason";
      } else if (d.status === DIALOGUE_TURN_STATUS.CANCELLED) {
        // cancelled 携带 failed last_turn 必拒
        if (d.last_turn !== undefined && d.last_turn.status === DIALOGUE_TURN_STATUS.FAILED) return "dialogue_last_turn";
        if (d.last_turn?.status === DIALOGUE_TURN_STATUS.CANCELLED) {
          if (d.stop_reason !== (d.last_turn.reason ?? DIALOGUE_REASON.HUMAN_INTERRUPT)) return "dialogue_stop_reason";
        } else if (d.last_turn?.status === DIALOGUE_TURN_STATUS.COMPLETED || d.last_turn === undefined) {
          if (d.stop_reason !== DIALOGUE_REASON.HUMAN_INTERRUPT) return "dialogue_stop_reason";
        }
      } else if (d.status === DIALOGUE_TURN_STATUS.COMPLETED) {
        // completed 携带 failed last_turn 必拒
        if (d.last_turn !== undefined && d.last_turn.status === DIALOGUE_TURN_STATUS.FAILED) return "dialogue_last_turn";
        // #R41 P1-1 ④：completed 的 last_turn × stop_reason 按真实产生路径配对成封闭表 ——
        // stopDialogue 只被 reserve 的三处停机调用，active 在场的只有 deadline 检查 →
        // cancelled last_turn 只可能配 time_budget（且与 last_turn.reason 自洽）；零轮（无
        // last_turn）时 round 停机不可达（rounds=0 < max_rounds ≥ 1），resource 可达（大
        // resourceUnits 一次越过）。有历史时 last_turn 必在（上方记账闭合已拒）。
        const stopOk = d.last_turn === undefined
          ? d.stop_reason === DIALOGUE_REASON.TIME_BUDGET || d.stop_reason === DIALOGUE_REASON.RESOURCE_BUDGET
          : d.last_turn.status === DIALOGUE_TURN_STATUS.COMPLETED
            ? d.stop_reason === DIALOGUE_REASON.ROUND_BUDGET || d.stop_reason === DIALOGUE_REASON.TIME_BUDGET ||
              d.stop_reason === DIALOGUE_REASON.RESOURCE_BUDGET
            : d.last_turn.status === DIALOGUE_TURN_STATUS.CANCELLED
              ? d.stop_reason === DIALOGUE_REASON.TIME_BUDGET && d.stop_reason === d.last_turn.reason
              : false;
        if (!stopOk) return "dialogue_stop_reason";
      }
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
        t.dialogue_id !== d.dialogue_id || t.turn_index !== maxProcessedTurn ||
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
        (t.status === DIALOGUE_TURN_STATUS.COMPLETED && t.reason !== null) ||
        (t.status !== DIALOGUE_TURN_STATUS.COMPLETED && t.reason !== null && !DIALOGUE_FINAL_REASONS.includes(t.reason)) ||
        t.dialogue_id !== d.dialogue_id || t.turn_index >= d.next_turn_index ||
        (d.active_turn !== null && t.turn_index >= d.active_turn.turn_index) ||
        (d.active_turn === null && t.turn_index !== maxProcessedTurn) ||
        ev === undefined || ev.run_id !== t.run_id ||
        ev.dialogue_id !== t.dialogue_id || ev.turn_index !== t.turn_index) return "dialogue_last_turn";
  }
  return null;
}
