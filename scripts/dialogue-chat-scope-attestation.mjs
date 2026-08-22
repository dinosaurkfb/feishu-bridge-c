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

/**
 * 证据保留窗口：一条 probe 观测在多久之内仍算数。**这是一条独立策略，刻意不复用
 * `snapshot.freshness_ms`。**
 *
 * 两者语义完全不同，早期实现把它们接在了一起，是必须拆开的错误耦合：
 *
 *   freshness_ms  单条入站消息的处理新鲜度 / 防重放期限。它判的是
 *                 `canonicalEvent.occurred_at`（见 dialogue-binding-authorization.mjs
 *                 的 STALE_EVENT），默认只有 15 分钟，因为它要压缩重放攻击窗口。
 *   本常量        attestation 证据的可信保留期。它判的是多条 probe 的 `observed_at`，
 *                 而 attestation 的全部意义就在于**跨多轮、跨话题轮转**积累
 *                 MIN_ATTESTATION_SAMPLES 条互相独立的观测。
 *
 * 挂在 15 分钟的防重放窗口上，等于要求三条独立观测挤在一刻钟内发生 —— 既攒不齐，
 * 又会让已经攒齐的证据在下一次评估时集体过期。更糟的是它把两条策略焊死：
 * 有人为了收紧重放窗口去调小 freshness_ms，会在毫不知情的情况下同时废掉 attestation。
 */
export const ATTESTATION_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 调用方可以显式收紧或放宽证据窗口，但不能取消过期。上限存在的理由：
 * attestation 的前提是"持续一致的近期观测"，一份无限期有效的证据就不再是观测，
 * 而是一句没有时效的断言。
 */
export const ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/** ECMAScript 时间值的可表示上限（±100,000,000 天）。超出它 `toISOString()` 会抛。 */
const MAX_TIME_VALUE_MS = 8.64e15;

const BINDING_REF_PATTERN = /^binding_ref_[0-9a-f]{24}$/u;
const SNAPSHOT_ID_PATTERN = /^binding_authorization_[0-9a-f]{24}$/u;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const onlyKeys = (value, allowed) => value && typeof value === "object" &&
  Object.keys(value).every((key) => allowed.includes(key));
const iso = (value) => new Date(value).toISOString();

/**
 * Date 分支不能少：`Date.parse(dateObject)` 会先 toString()，而那个格式**没有毫秒**，
 * 于是一个 Date 入参会被静默截断到整秒（…123 → …000），既影响 generated_at 也影响过期算术。
 */
const toMs = (value) => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(value ?? "");
};

/** 只有落在可表示范围内的时间值才允许进入 `iso()`；否则那是一次抛异常，不是一个判定。 */
const representableMs = (ms) => Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_VALUE_MS;

/**
 * 是不是 `toISOString()` 会产出的那种规范形式 —— 用往返相等来判，不用正则拼。
 *
 * 刻意比 JSON Schema 的 `format: date-time` **更严**（只收 Z 结尾的规范形式，不收
 * "+08:00" 偏移写法）。方向是有意的：运行时永远不能接受 schema 会拒的东西，
 * 反过来严一点只会让本模块产出的制品集合更小，不会造出 schema 校验不过的制品。
 * 原来那句 `Number.isFinite(Date.parse(x))` 恰恰是错的那个方向 —— 它连 "2026-08-23"
 * 都收，而 schema 不收。
 */
const isCanonicalIso = (value) => {
  const ms = Date.parse(value);
  return representableMs(ms) && iso(ms) === value;
};

const emptyAttestation = ({ snapshot, generated, status, reason, evidenceMaxAgeMs,
  sampleCount = 0, firstObservedAt = null, lastObservedAt = null }) => ({
  schema_version: CHAT_SCOPE_ATTESTATION_SCHEMA_VERSION,
  artifact_type: CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE,
  attestation_version: CHAT_SCOPE_ATTESTATION_VERSION,
  generated_at: generated,
  binding_ref: snapshot.binding_ref,
  authorization_snapshot_id: snapshot.snapshot_id,
  status,
  reason,
  // 判定用的窗口写进制品本身：否则两份状态相同、但按不同证据窗口算出来的 attestation
  // 在 shadow comparison 里完全无法区分，也说不清当时凭什么认为证据还新鲜。
  evidence_max_age_ms: evidenceMaxAgeMs,
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
  snapshot, probes, now = Date.now(), evidenceMaxAgeMs = ATTESTATION_EVIDENCE_MAX_AGE_MS,
} = {}) {
  const snapshotValid = validateDialogueBindingAuthorizationSnapshot(snapshot);
  const nowMs = toMs(now);
  // 越界但有限的数值（例如 9e15）过得了 Number.isFinite，却会让 toISOString() 抛 RangeError。
  // 这个模块承诺"只有调用方错误才返回 ok:false"，从没承诺会抛——所以范围必须在这里判掉。
  const ageValid = positiveInteger(evidenceMaxAgeMs) &&
    evidenceMaxAgeMs <= ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS;
  if (!snapshotValid.ok || !Array.isArray(probes) || !representableMs(nowMs) || !ageValid) {
    return { ok: false, reason: CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID };
  }
  // 一律由已校验的 nowMs 规范化：Date 对象、"2026-08-23" 这类可解析但非 RFC3339 的字符串
  // 都会被折算成同一种 date-time 形式，运行时 validator 与 JSON Schema 因此永远同解。
  const generated = iso(nowMs);
  const base = { snapshot, generated, evidenceMaxAgeMs };

  if (probes.length === 0) {
    return {
      ok: true,
      attestation: emptyAttestation({
        ...base, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
        reason: CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE,
      }),
    };
  }
  if (probes.some((probe) => !validateDialogueChatScopeProbe(probe).ok)) {
    return {
      ok: true,
      attestation: emptyAttestation({
        ...base, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
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
          ...base, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
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
        ...base, status: CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED,
        reason: CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE,
        sampleCount: samples.length, firstObservedAt: range.first, lastObservedAt: range.last,
      }),
    };
  }
  const range = observedRange();
  const withCount = (status, reason) => ({
    ok: true,
    attestation: emptyAttestation({
      ...base, status, reason,
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
  if (samples.some((probe) => nowMs - toMs(probe.observed_at) > evidenceMaxAgeMs)) {
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
    "evidence_max_age_ms", "sample_count", "first_observed_at", "last_observed_at"]) ||
      attestation?.schema_version !== CHAT_SCOPE_ATTESTATION_SCHEMA_VERSION ||
      attestation?.artifact_type !== CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE ||
      attestation?.attestation_version !== CHAT_SCOPE_ATTESTATION_VERSION ||
      // 只认规范 date-time：Date.parse 连 "2026-08-23" 都收，而 JSON Schema 的
      // format: date-time 不收。两边不同解，正是这次要修掉的那类不一致。
      typeof attestation?.generated_at !== "string" ||
      !isCanonicalIso(attestation.generated_at) ||
      !BINDING_REF_PATTERN.test(attestation?.binding_ref ?? "") ||
      !SNAPSHOT_ID_PATTERN.test(attestation?.authorization_snapshot_id ?? "") ||
      !Object.values(CHAT_SCOPE_ATTESTATION_STATUS).includes(attestation?.status) ||
      !positiveInteger(attestation?.evidence_max_age_ms) ||
      attestation.evidence_max_age_ms > ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS ||
      !nonNegativeInteger(attestation?.sample_count)) {
    return { ok: false, reason: CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID };
  }
  const reasonValid = attestation.status === CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE
    ? attestation.reason === null
    : Object.values(CHAT_SCOPE_ATTESTATION_REASON).includes(attestation.reason) &&
      attestation.reason !== CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID;
  const rangeValid = attestation.sample_count === 0
    ? attestation.first_observed_at === null && attestation.last_observed_at === null
    : isCanonicalIso(attestation.first_observed_at) &&
      isCanonicalIso(attestation.last_observed_at) &&
      Date.parse(attestation.first_observed_at) <= Date.parse(attestation.last_observed_at);
  const minSamplesRespected =
    attestation.status !== CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE ||
    attestation.sample_count >= MIN_ATTESTATION_SAMPLES;
  return reasonValid && rangeValid && minSamplesRespected
    ? { ok: true }
    : { ok: false, reason: CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID };
}
