/**
 * Mapping Policy v1：把既有「一个话题输入 -> 一个本地目标 run」收敛成模式无关 handler。
 *
 * 本模块只计算，不取 Aily 信封、不 claim、不读取 runtime locator、不启动 Claude/Codex。
 * runtime adapter 先在私有映射中解析 locator、只向公共层投影 localTargetId，再消费 runRequest。
 */

import { generationForSession } from "./topic-generation.mjs";
import { validateCanonicalEvent } from "./canonical-event.mjs";
import {
  REJECT, evaluateInbound, evaluateInboundEvidence,
} from "./selector.mjs";
import { stableControlId } from "./subscription.mjs";

export const MAPPING_POLICY_ID = "mapping";
export const MAPPING_POLICY_VERSION = "1.0";

export const MAPPING_DISPOSITION = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
  BUSY: "busy",
});

export const MAPPING_POLICY_REASON = Object.freeze({
  CANONICAL_INVALID: "canonical_invalid",
  CONTEXT_INVALID: "mapping_policy_context_invalid",
  CLAIM_REQUIRED: "mapping_policy_claim_required",
  TARGET_BUSY: "target_busy",
});

const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const baseResult = () => ({
  policy_id: MAPPING_POLICY_ID,
  policy_version: MAPPING_POLICY_VERSION,
});

const compareAdmission = (legacy, candidate) => {
  const decisionMatch = legacy?.decision === candidate?.decision;
  const reasonMatch = legacy?.decision === "reject" && candidate?.decision === "reject"
    ? legacy.reason === candidate.reason
    : true;
  const requestMatch = legacy?.decision === "accept" && candidate?.decision === "accept"
    ? legacy.messageId === candidate.messageId &&
      legacy.logicalTaskKey === candidate.logicalTaskKey &&
      legacy.instruction === candidate.instruction
    : true;
  return {
    mode: "shadow",
    match: decisionMatch && reasonMatch && requestMatch,
    decision_match: decisionMatch,
    reason_match: reasonMatch,
    request_match: requestMatch,
    legacy_decision: legacy?.decision ?? "invalid",
    candidate_decision: candidate?.decision ?? "invalid",
    legacy_reason: legacy?.reason ?? null,
    candidate_reason: candidate?.reason ?? null,
  };
};

/**
 * Canonical Event 是正式路径；legacy event 只为直接运行旧 handler 的诊断/回滚路径保留。
 * 一旦显式传入了坏的 canonical event 就 fail-closed，不能悄悄回落到另一份事实。
 */
export function evaluateMappingAdmission({ canonicalEvent, event, mapping, config, now } = {}) {
  if (canonicalEvent !== undefined && canonicalEvent !== null) {
    const legacy = evaluateInbound({ event, mapping, config, now });
    if (!validateCanonicalEvent(canonicalEvent).ok) {
      const candidate = {
        decision: "invalid",
        reason: MAPPING_POLICY_REASON.CANONICAL_INVALID,
      };
      return {
        ...baseResult(),
        ...legacy,
        evaluation_path: "legacy_event_v2",
        candidate_evaluation_path: "canonical_event_v1",
        admission_shadow: compareAdmission(legacy, candidate),
      };
    }
    const candidate = evaluateInboundEvidence({
      event: {
        event_id: canonicalEvent.event_id,
        session_id: canonicalEvent.source.session_id,
        sender_id: canonicalEvent.actor.sender_id,
        created_at_ms: Date.parse(canonicalEvent.occurred_at),
        mention_ids: canonicalEvent.mention.target_open_ids,
        content_text: canonicalEvent.content.text,
      },
      mapping,
      config,
      now,
    });
    // INV-12：候选结果先影子比较，旧 selector 在真实样本验收前仍是唯一权威。
    return {
      ...baseResult(),
      ...legacy,
      evaluation_path: "legacy_event_v2",
      candidate_evaluation_path: "canonical_event_v1",
      admission_shadow: compareAdmission(legacy, candidate),
    };
  }
  const verdict = evaluateInbound({ event, mapping, config, now });
  return { ...baseResult(), ...verdict, evaluation_path: "legacy_event_v2" };
}

/**
 * 把旧 mapping 临时投影成公共层只看得见的 opaque ids。
 * 后续 Topic Generation 持久化切片会用正式实体替换这份兼容投影，调用方接口不变。
 */
export function buildLegacyMappingContext({ runtime, mapping, canonicalEvent, event } = {}) {
  const logicalTaskKey = mapping?.logical_task_key;
  const sessionId = canonicalEvent?.source?.session_id ?? event?.session_id;
  if (!nonEmpty(runtime) || !nonEmpty(logicalTaskKey) || !nonEmpty(sessionId)) {
    return { ok: false, reason: MAPPING_POLICY_REASON.CONTEXT_INVALID };
  }
  const bindingSeed = nonEmpty(mapping?.binding_id) ? mapping.binding_id : logicalTaskKey;
  // 来源代际按 **这条消息的 session** 定：它落在哪个代际（当前的或某个 read-only 历史话题），
  // 回复就冻结回那个话题（goal 第 2 层）。找不到对应代际才退回当前代际。
  const bySession = generationForSession(mapping?.topic_generation_state ?? null, sessionId);
  return {
    ok: true,
    projection: nonEmpty(mapping?.channel_generation_id)
      ? "topic_generation_v1"
      : "legacy_mapping_v1",
    localTargetId: stableControlId("local_target", runtime, logicalTaskKey),
    originChannelGenerationId: bySession
      ? bySession.channel_generation_id
      : nonEmpty(mapping?.channel_generation_id)
        ? mapping.channel_generation_id
        : stableControlId("channel_generation", runtime, bindingSeed, sessionId),
    originGenerationStatus: bySession ? bySession.status : (nonEmpty(mapping?.channel_generation_id) ? "active" : null),
  };
}

/**
 * 等价于架构契约的 handle(event, resolvedContext)。evaluation 已由同模块产生，claim 由
 * ingress kernel 原子取得；handler 只决定处置并在 accepted 时生成 runtime-neutral runRequest。
 */
export function handleMappingPolicy({
  evaluation,
  claim,
  resolvedContext,
  targetState = "ready",
  capability = null,
} = {}) {
  const base = baseResult();
  const reject = (reason, receiptText, claimId = null) => ({
    ...base,
    receiptText,
    claimId,
    disposition: MAPPING_DISPOSITION.REJECTED,
    reason,
  });

  if (evaluation?.policy_id !== MAPPING_POLICY_ID ||
      evaluation?.policy_version !== MAPPING_POLICY_VERSION) {
    return reject(MAPPING_POLICY_REASON.CONTEXT_INVALID, "映射策略上下文不完整");
  }

  if (evaluation.decision === "reject") {
    const duplicate = evaluation.reason === REJECT.DUPLICATE_MESSAGE;
    return {
      ...base,
      receiptText: evaluation.reasonText ?? "映射请求未通过准入",
      claimId: null,
      disposition: duplicate ? MAPPING_DISPOSITION.DUPLICATE : MAPPING_DISPOSITION.REJECTED,
      reason: evaluation.reason ?? MAPPING_POLICY_REASON.CONTEXT_INVALID,
    };
  }
  if (evaluation.decision !== "accept") {
    return reject(MAPPING_POLICY_REASON.CONTEXT_INVALID, "映射策略上下文不完整");
  }

  if (claim?.ok !== true) {
    if (claim?.reason === "duplicate") {
      return {
        ...base,
        receiptText: "这条消息已经处理过（幂等命中）",
        claimId: nonEmpty(claim?.key) ? claim.key : null,
        disposition: MAPPING_DISPOSITION.DUPLICATE,
        reason: "duplicate",
      };
    }
    return reject(
      claim?.reason ?? MAPPING_POLICY_REASON.CLAIM_REQUIRED,
      "无法取得映射请求的唯一投递权",
      nonEmpty(claim?.key) ? claim.key : null,
    );
  }

  if (targetState === "busy") {
    return {
      ...base,
      receiptText: "目标任务正在执行另一轮",
      claimId: claim.key,
      disposition: MAPPING_DISPOSITION.BUSY,
      reason: MAPPING_POLICY_REASON.TARGET_BUSY,
    };
  }
  if (targetState !== "ready" || !nonEmpty(claim.key) ||
      !nonEmpty(evaluation.messageId) || !nonEmpty(evaluation.instruction) ||
      !nonEmpty(resolvedContext?.localTargetId) ||
      !nonEmpty(resolvedContext?.originChannelGenerationId)) {
    return reject(MAPPING_POLICY_REASON.CONTEXT_INVALID, "映射策略上下文不完整", claim.key ?? null);
  }

  return {
    ...base,
    receiptText: "映射请求已通过准入并准备投递",
    claimId: claim.key,
    disposition: MAPPING_DISPOSITION.ACCEPTED,
    runRequest: {
      runId: claim.key,
      localTargetId: resolvedContext.localTargetId,
      userInput: evaluation.instruction,
      capability,
      origin: {
        kind: "feishu",
        eventId: evaluation.messageId,
        channelGenerationId: resolvedContext.originChannelGenerationId,
      },
      policy: {
        policy_id: MAPPING_POLICY_ID,
        policy_version: MAPPING_POLICY_VERSION,
      },
    },
  };
}
