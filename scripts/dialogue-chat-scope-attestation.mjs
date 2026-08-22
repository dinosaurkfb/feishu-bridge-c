/**
 * Dialogue Slice B2c：把重复、真实的 B2a chat scope probe 证据聚合成一个每-binding 的
 * candidate attestation 状态。
 *
 * 这仍然是纯计算、只读 shadow：它不写 Canonical Event，不把 `extensions.aily_channel.verified`
 * 改成 true，也不产生任何新的持久化写入路径。`status: attested_candidate` 只表示"同一 binding 的
 * 多条独立真实观测持续一致、新鲜、未损坏"，不代表 Aily 字段注入来源已被证明可信 —— 那仍是
 * dialogue-chat-scope-probe.md 第 5 节列出的、本模块不解决的独立门禁。
 *
 * fail-closed 原则：输入证据里任何一条损坏、跨 binding、跨 snapshot（授权修订）、或过期，
 * 都会让整批证据判定为 unverified，而不是丢弃坏样本后用剩下的凑数——一条坏证据足以让人怀疑
 * 整批采集过程，不能被稀释掉。
 */

import { validateDialogueBindingAuthorizationSnapshot } from "./dialogue-binding-authorization.mjs";
import { validateDialogueChatScopeProbe } from "./dialogue-chat-scope-probe.mjs";

export const CHAT_SCOPE_ATTESTATION_SCHEMA_VERSION = "1.0";
export const CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE =
  "feishu_bridge_dialogue_chat_scope_attestation";
export const CHAT_SCOPE_ATTESTATION_VERSION = "1.0";

export const CHAT_SCOPE_ATTESTATION_STATUS = Object.freeze({
  UNVERIFIED: "unverified",
  ATTESTED_CANDIDATE: "attested_candidate",
});

export const CHAT_SCOPE_ATTESTATION_REASON = Object.freeze({
  INPUT_INVALID: "chat_scope_attestation_input_invalid",
  EVIDENCE_INVALID: "chat_scope_attestation_evidence_invalid",
  INSUFFICIENT_EVIDENCE: "chat_scope_attestation_insufficient_evidence",
  BINDING_MISMATCH: "chat_scope_attestation_binding_mismatch",
  SNAPSHOT_MISMATCH: "chat_scope_attestation_snapshot_mismatch",
  STALE_EVIDENCE: "chat_scope_attestation_stale_evidence",
  LOCATOR_MISSING: "chat_scope_attestation_locator_missing",
  SCOPE_MISMATCH: "chat_scope_attestation_scope_mismatch",
});

/**
 * 至少需要多少条互相独立（不同 event_ref）的真实观测才允许考虑提升为 candidate。
 * 单条甚至两条一致的观测不足以排除"一次性巧合"；这是固定策略常量，不对外开放调低。
 */
export const MIN_ATTESTATION_SAMPLES = 3;

const BINDING_REF_PATTERN = /^binding_ref_[0-9a-f]{24}$/u;
const SNAPSHOT_ID_PATTERN = /^binding_authorization_[0-9a-f]{24}$/u;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const onlyKeys = (value, allowed) => value && typeof value === "object" &&
  Object.keys(value).every((key) => allowed.includes(key));
const iso = (value) => new Date(value).toISOString();
const toMs = (value) => typeof value === "number" ? value : Date.parse(value ?? "");

const emptyAttestation = ({ snapshot, generated, status, reason, sampleCount = 0,
  firstObservedAt = null, lastObservedAt = null }) => ({
  schema_version: CHAT_SCOPE_ATTESTATION_SCHEMA_VERSION,
  artifact_type: CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE,
  attestation_version: CHAT_SCOPE_ATTESTATION_VERSION,
  generated_at: generated,
  binding_ref: snapshot.binding_ref,
  authorization_snapshot_id: snapshot.snapshot_id,
  status,
  reason,
  sample_count: sampleCount,
  first_observed_at: firstObservedAt,
  last_observed_at: lastObservedAt,
});

/**
 * 纯函数：给定一个已冻结的授权快照与一批候选 probe 证据，判定这批证据能否把该 binding 的
 * chat scope 从 `unverified` 提升为 shadow-only 的 `attested_candidate`。
 *
 * 只有 snapshot 类型错误或 probes 不是数组这类调用方错误才返回 `ok:false`；证据本身缺失、
 * 损坏、过期或不一致都会返回 `ok:true` 且 `status:"unverified"`——调用方不需要用 try/catch
 * 区分"没有证据"和"程序用错了"。
 */
export function evaluateDialogueChatScopeAttestation({
  snapshot, probes, now = Date.now(),
} = {}) {
  const snapshotValid = validateDialogueBindingAuthorizationSnapshot(snapshot);
  const nowMs = toMs(now);
  if (!snapshotValid.ok || !Array.isArray(probes) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID };
  }
  const generated = typeof now === "number" ? iso(now) : now;

  if (probes.length === 0) {
    return {
      ok: true,
      attestation: emptyAttestation({
        snapshot, generated, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
        reason: CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE,
      }),
    };
  }
  if (probes.some((probe) => !validateDialogueChatScopeProbe(probe).ok)) {
    return {
      ok: true,
      attestation: emptyAttestation({
        snapshot, generated, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
        reason: CHAT_SCOPE_ATTESTATION_REASON.EVIDENCE_INVALID,
      }),
    };
  }

  const byId = new Map();
  for (const probe of probes) {
    const existing = byId.get(probe.probe_id);
    if (existing && existing.evidence_hash !== probe.evidence_hash) {
      return {
        ok: true,
        attestation: emptyAttestation({
          snapshot, generated, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
          reason: CHAT_SCOPE_ATTESTATION_REASON.EVIDENCE_INVALID,
        }),
      };
    }
    if (!existing) byId.set(probe.probe_id, probe);
  }
  const samples = [...byId.values()];
  const observedRange = () => {
    const timestamps = samples.map((probe) => toMs(probe.observed_at));
    return {
      first: iso(Math.min(...timestamps)),
      last: iso(Math.max(...timestamps)),
    };
  };

  if (samples.length < MIN_ATTESTATION_SAMPLES) {
    const range = observedRange();
    return {
      ok: true,
      attestation: emptyAttestation({
        snapshot, generated, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
        reason: CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE,
        sampleCount: samples.length, firstObservedAt: range.first, lastObservedAt: range.last,
      }),
    };
  }
  const range = observedRange();
  const withCount = (status, reason) => ({
    ok: true,
    attestation: emptyAttestation({
      snapshot, generated, status, reason,
      sampleCount: samples.length, firstObservedAt: range.first, lastObservedAt: range.last,
    }),
  });

  if (samples.some((probe) => probe.binding_ref !== snapshot.binding_ref)) {
    return withCount(CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
      CHAT_SCOPE_ATTESTATION_REASON.BINDING_MISMATCH);
  }
  if (samples.some((probe) => probe.authorization_snapshot_id !== snapshot.snapshot_id)) {
    return withCount(CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
      CHAT_SCOPE_ATTESTATION_REASON.SNAPSHOT_MISMATCH);
  }
  if (samples.some((probe) => toMs(probe.observed_at) > nowMs)) {
    return withCount(CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
      CHAT_SCOPE_ATTESTATION_REASON.EVIDENCE_INVALID);
  }
  if (samples.some((probe) => nowMs - toMs(probe.observed_at) > snapshot.freshness_ms)) {
    return withCount(CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
      CHAT_SCOPE_ATTESTATION_REASON.STALE_EVIDENCE);
  }
  if (samples.some((probe) => probe.chat_locator_present !== true)) {
    return withCount(CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
      CHAT_SCOPE_ATTESTATION_REASON.LOCATOR_MISSING);
  }
  if (samples.some((probe) => probe.chat_scope_match !== true)) {
    return withCount(CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
      CHAT_SCOPE_ATTESTATION_REASON.SCOPE_MISMATCH);
  }
  return withCount(CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE, null);
}

export function validateDialogueChatScopeAttestation(attestation) {
  if (!onlyKeys(attestation, ["schema_version", "artifact_type", "attestation_version",
    "generated_at", "binding_ref", "authorization_snapshot_id", "status", "reason",
    "sample_count", "first_observed_at", "last_observed_at"]) ||
      attestation?.schema_version !== CHAT_SCOPE_ATTESTATION_SCHEMA_VERSION ||
      attestation?.artifact_type !== CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE ||
      attestation?.attestation_version !== CHAT_SCOPE_ATTESTATION_VERSION ||
      !Number.isFinite(Date.parse(attestation?.generated_at ?? "")) ||
      !BINDING_REF_PATTERN.test(attestation?.binding_ref ?? "") ||
      !SNAPSHOT_ID_PATTERN.test(attestation?.authorization_snapshot_id ?? "") ||
      !Object.values(CHAT_SCOPE_ATTESTATION_STATUS).includes(attestation?.status) ||
      !nonNegativeInteger(attestation?.sample_count)) {
    return { ok: false, reason: CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID };
  }
  const reasonValid = attestation.status === CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE
    ? attestation.reason === null
    : Object.values(CHAT_SCOPE_ATTESTATION_REASON).includes(attestation.reason) &&
      attestation.reason !== CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID;
  const rangeValid = attestation.sample_count === 0
    ? attestation.first_observed_at === null && attestation.last_observed_at === null
    : Number.isFinite(Date.parse(attestation.first_observed_at ?? "")) &&
      Number.isFinite(Date.parse(attestation.last_observed_at ?? "")) &&
      Date.parse(attestation.first_observed_at) <= Date.parse(attestation.last_observed_at);
  const minSamplesRespected =
    attestation.status !== CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE ||
    attestation.sample_count >= MIN_ATTESTATION_SAMPLES;
  return reasonValid && rangeValid && minSamplesRespected
    ? { ok: true }
    : { ok: false, reason: CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID };
}
