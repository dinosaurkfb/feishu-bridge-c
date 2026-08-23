/**
 * Dialogue Slice B shadow 证据的只读汇总器。
 *
 * 输入可以包含私有 sidecar artifact；输出只能包含计数、固定状态与受控原因桶。
 * 本模块不修改证据、不提升 canonical trust，也绝不返回 artifact id、locator 或文件路径。
 */

import fs from "node:fs";
import path from "node:path";

import {
  BINDING_AUTHORIZATION_REASON, validateDialogueBindingAuthorizationSnapshot,
  validateDialogueBoundAuthorizationShadow,
} from "./dialogue-binding-authorization.mjs";
import {
  CANONICAL_TIME_PATTERN, canonicalIso, isCanonicalIso, isCanonicalMs, toCanonicalMs,
} from "./canonical-time.mjs";
import {
  CHAT_SCOPE_ATTESTATION_REASON, CHAT_SCOPE_ATTESTATION_STATUS,
  evaluateDialogueChatScopeAttestation,
} from "./dialogue-chat-scope-attestation.mjs";
import { validateDialogueChatScopeProbe } from "./dialogue-chat-scope-probe.mjs";
import { REJECT } from "./selector.mjs";

export const DIALOGUE_SHADOW_READINESS_SCHEMA_VERSION = "1.0";
export const DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE =
  "feishu_bridge_dialogue_shadow_readiness_report";

export const DIALOGUE_SHADOW_READINESS_DECISION = Object.freeze({
  INVALID_EVIDENCE: "invalid_evidence",
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  NOT_READY: "not_ready",
  MANUAL_REVIEW_REQUIRED: "manual_review_required",
});

const CHECK_STATUS = new Set(["pass", "fail", "insufficient"]);
const MANUAL_GATES = Object.freeze([
  "trusted_locator_source",
  "both_runtime_coverage",
  "generation_rotation_coverage",
  "rollback_rehearsal",
]);
const KNOWN_REASONS = new Set([
  ...Object.values(BINDING_AUTHORIZATION_REASON),
  ...Object.values(REJECT),
]);
const onlyKeys = (value, allowed) => value && typeof value === "object" &&
  Object.keys(value).every((key) => allowed.includes(key));
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const reasonBucket = (value) => value === null ? "accepted"
  : KNOWN_REASONS.has(value) ? value : "other";

const readJsonFiles = (dir) => {
  const values = [];
  let readErrors = 0;
  let missing = false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") missing = true;
    else readErrors += 1;
    return { values, readErrors, missing };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { values.push(JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf-8"))); }
    catch { readErrors += 1; }
  }
  return { values, readErrors, missing };
};

/** 读取一个或多个 Git 外 shadow 根目录；返回值不含输入路径或文件名。 */
export function readDialogueShadowEvidence({ shadowDirs = [] } = {}) {
  if (!Array.isArray(shadowDirs) || shadowDirs.some((dir) =>
    typeof dir !== "string" || !path.isAbsolute(dir))) {
    return { ok: false, reason: "shadow_readiness_input_invalid" };
  }
  const evidence = {
    source_count: shadowDirs.length,
    missing_source_dirs: 0,
    read_errors: 0,
    authorizations: [],
    events: [],
    probes: [],
  };
  for (const root of shadowDirs) {
    const auth = readJsonFiles(path.join(root, "authorizations"));
    const events = readJsonFiles(path.join(root, "events"));
    const probes = readJsonFiles(path.join(root, "scope-probes"));
    // 只有**根目录本身不在**才算证据源缺失。
    //
    // 原判据是"三个子目录都不存在"，它把两件不同的事混成了一件：
    //   根目录不存在   —— 被点名要审的来源根本不在，报告是在看不全的证据上做的；
    //   根目录在、空的 —— 合法的"还没收集到"，本来就该走 insufficient_evidence。
    // 混在一起会二选一地错：要么放过前者（Codex 复审实测：一个完整目录 + 一个不存在的
    // 目录，自动检查全 pass），要么把后者误判成证据损坏。
    let rootPresent = false;
    try { rootPresent = fs.statSync(root).isDirectory(); } catch { rootPresent = false; }
    if (!rootPresent) evidence.missing_source_dirs += 1;
    evidence.read_errors += auth.readErrors + events.readErrors + probes.readErrors;
    evidence.authorizations.push(...auth.values);
    evidence.events.push(...events.values);
    evidence.probes.push(...probes.values);
  }
  return { ok: true, evidence };
}

const indexBy = (values, keyOf) => {
  const index = new Map();
  let duplicateIds = 0;
  for (const value of values) {
    const id = keyOf(value);
    const existing = index.get(id) ?? [];
    if (existing.length > 0) duplicateIds += 1;
    existing.push(value);
    index.set(id, existing);
  }
  return { index, duplicateIds };
};
const correlationKey = (value) => [
  value.authorization_snapshot_id, value.event_ref, value.binding_ref,
].join("\0");

const metric = (total, valid, extra = {}) => ({
  total, valid, invalid: total - valid, ...extra,
});
/**
 * 自动检查的**受控 ID 全集与顺序**。
 *
 * 之前 validator 只要求 `id` 是字符串，于是把某个 id 改成 `/private/secret/path` 也能通过，
 * renderer 还会原样打出去 —— 直接违反"只输出固定检查名、不得泄露路径"的契约。
 * 这里把集合与顺序一起钉死，schema 用 `prefixItems` 逐位 `const` 对齐同一份清单。
 */
export const DIALOGUE_SHADOW_READINESS_CHECK_IDS = Object.freeze([
  "source_dirs_complete",
  "samples_present",
  "artifact_integrity",
  "correlation_complete",
  "chat_locator_present",
  "chat_scope_consistent",
  "canonical_scope_verified",
  "chat_scope_attested",
  "legacy_candidate_route_match",
  "legacy_candidate_full_match",
]);

const check = (id, status) => ({ id, status });
const histogram = (values) => {
  const out = {};
  for (const value of values) {
    const key = reasonBucket(value);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

/**
 * 汇总并关联三类 artifact。即使全部自动检查通过，结论也只到 manual_review_required；
 * 真实来源、双 runtime、轮转和回滚四道门禁无法由这些脱敏 artifact 单独证明。
 */
export function analyzeDialogueShadowEvidence(rawInput = {}) {
  const {
    sourceCount = 0,
    missingSourceDirs = 0,
    readErrors = 0,
    authorizations = [],
    events = [],
    probes = [],
    generatedAt = Date.now(),
  } = rawInput ?? {};
  if (![sourceCount, missingSourceDirs, readErrors].every(nonNegativeInteger) ||
      !Array.isArray(authorizations) || !Array.isArray(events) || !Array.isArray(probes)) {
    return { ok: false, reason: "shadow_readiness_input_invalid" };
  }
  // readDialogueShadowEvidence 返回的是 snake_case，本函数收 camelCase。直接把 evidence
  // 摊进来看着能跑，实际会让 missingSourceDirs 静默取默认值 0 —— 也就是"没有缺失"，
  // 恰好是不安全的那个方向，且报告里一切正常。这个坑很好踩（返修期间就踩过一次），
  // 所以把它从静默降级改成响亮报错。
  if (["source_count", "missing_source_dirs", "read_errors"]
    .some((key) => key in rawInput)) {
    return { ok: false, reason: "shadow_readiness_input_invalid" };
  }
  // 先校验、再折算。原实现顺序相反：`iso(Infinity)` 会在校验之前抛 RangeError，
  // 而本函数的契约是返回 shadow_readiness_input_invalid，从没承诺会抛。
  const generatedMs = toCanonicalMs(generatedAt);
  if (!isCanonicalMs(generatedMs)) {
    return { ok: false, reason: "shadow_readiness_input_invalid" };
  }
  // 一律规范化，不透传调用方原值 —— 否则 "Aug 23 2026" 这类 Date.parse 收、
  // 而 JSON Schema 的 format: date-time 不收的字符串会直接进制品。
  const generated = canonicalIso(generatedMs);

  const validAuthorizations = authorizations.filter((value) =>
    validateDialogueBindingAuthorizationSnapshot(value).ok);
  const validEvents = events.filter((value) => validateDialogueBoundAuthorizationShadow(value).ok);
  const validProbes = probes.filter((value) => validateDialogueChatScopeProbe(value).ok);
  const authIndex = indexBy(validAuthorizations, (value) => value.snapshot_id);
  const eventIds = indexBy(validEvents, (value) => value.shadow_id);
  const probeIds = indexBy(validProbes, (value) => value.probe_id);
  const eventIndex = indexBy(validEvents, correlationKey).index;
  const probeIndex = indexBy(validProbes, correlationKey).index;

  let completePairs = 0;
  let orphanEvents = 0;
  let orphanProbes = 0;
  let missingAuthorizations = 0;
  const correlationKeys = new Set([...eventIndex.keys(), ...probeIndex.keys()]);
  for (const key of correlationKeys) {
    const matchingEvents = eventIndex.get(key) ?? [];
    const matchingProbes = probeIndex.get(key) ?? [];
    if (matchingEvents.length === 1 && matchingProbes.length === 1) completePairs += 1;
    else {
      orphanEvents += matchingEvents.length;
      orphanProbes += matchingProbes.length;
    }
  }
  for (const event of validEvents) {
    const snapshots = authIndex.index.get(event.authorization_snapshot_id) ?? [];
    if (snapshots.length !== 1 || snapshots[0].binding_ref !== event.binding_ref) {
      missingAuthorizations += 1;
    }
  }
  for (const probe of validProbes) {
    const snapshots = authIndex.index.get(probe.authorization_snapshot_id) ?? [];
    if (snapshots.length !== 1 || snapshots[0].binding_ref !== probe.binding_ref) {
      missingAuthorizations += 1;
    }
  }

  const invalidArtifacts = (authorizations.length - validAuthorizations.length) +
    (events.length - validEvents.length) + (probes.length - validProbes.length);
  const duplicateIds = authIndex.duplicateIds + eventIds.duplicateIds + probeIds.duplicateIds;
  const sampleCount = Math.min(validEvents.length, validProbes.length);
  const hasInteractionEvidence = validEvents.length > 0 || validProbes.length > 0;
  const all = (values, predicate) => values.length > 0 && values.every(predicate);
  const artifactIntegrity = invalidArtifacts === 0 && readErrors === 0;
  const correlationComplete = sampleCount > 0 &&
    completePairs === validEvents.length && completePairs === validProbes.length &&
    orphanEvents === 0 && orphanProbes === 0 && missingAuthorizations === 0 && duplicateIds === 0;
  const locatorPresent = all(validProbes, (probe) => probe.chat_locator_present === true);
  const scopeConsistent = all(validProbes, (probe) => probe.chat_scope_match === true);
  const canonicalVerified = all(validProbes, (probe) => probe.canonical_verified === true);
  const routeConsistent = all(validEvents, (event) => event.comparison.route_match === true);
  const fullComparisonMatch = all(validEvents, (event) => event.comparison.match === true);

  // 被点名要审的目录一个都不能少。少一个就意味着这份报告是在**看不全**的证据上做的结论，
  // 而 readiness audit 是 fail-closed 的：看不全时必须拒绝给出"只差人工签字"的口径。
  // 原实现漏了这一项 —— 实测传入一个完整目录 + 一个不存在的目录，八项自动检查全 pass、
  // 结论却是 manual_review_required，正好是最危险的那种读法。
  const sourceDirsComplete = missingSourceDirs === 0;

  /**
   * 逐 binding 跑 chat scope attestation，把 B2c 那份聚合判定接进只读审计。
   *
   * 在此之前 attestation 没有任何调用方 —— `attested_candidate` 只存在于单测里。
   * 一个没人读的判定既不能支撑门禁，也没人会发现它坏了。
   *
   * **它不提升 canonical trust。**这里只回答"证据够不够格被人拿去看"，
   * 而"chat scope 是否可信"仍是 `trusted_locator_source` 这道人工门禁 ——
   * attestation 说的是"多条独立真实观测持续一致"，不是"Aily 的字段注入来源已被证明可信"。
   * 所以下面的结论仍然封顶在 manual_review_required，见 decision 处。
   */
  const attestations = validAuthorizations.map((snapshot) =>
    evaluateDialogueChatScopeAttestation({
      snapshot,
      probes: validProbes.filter((probe) =>
        probe.binding_ref === snapshot.binding_ref &&
        probe.authorization_snapshot_id === snapshot.snapshot_id),
      now: generatedMs,
    }));
  const attested = attestations.filter((item) =>
    item.ok && item.attestation?.status === CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE);
  // 有授权快照、且每一个都攒够了独立一致的观测，才算这一项通过；
  // 一个都没有时是 insufficient，不是 pass —— 空集合不构成证据。
  const scopeAttested = validAuthorizations.length > 0 &&
    attested.length === validAuthorizations.length;
  // "证据还不够"和"证据有问题"必须分开报。attestation 要求至少
  // MIN_ATTESTATION_SAMPLES 条互相独立的观测，刚接上时天然攒不够 —— 那是
  // insufficient，不是 fail。报成 fail 会让人去查一个根本不存在的故障，
  // 也会把"还没开始收集"和"收到了互相矛盾的观测"混成同一种红。
  const attestationBlockers = attestations.filter((item) => !item.ok ||
    item.attestation?.status !== CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE);
  const onlyNeedsMoreSamples = attestationBlockers.every((item) => item.ok &&
    item.attestation?.reason === CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE);

  const automatedChecks = [
    check("source_dirs_complete", sourceDirsComplete ? "pass" : "fail"),
    check("samples_present", sampleCount > 0 ? "pass" :
      hasInteractionEvidence ? "fail" : "insufficient"),
    check("artifact_integrity", artifactIntegrity ? "pass" : "fail"),
    check("correlation_complete", sampleCount === 0 && !hasInteractionEvidence ? "insufficient" :
      correlationComplete ? "pass" : "fail"),
    check("chat_locator_present", validProbes.length === 0 ? "insufficient" :
      locatorPresent ? "pass" : "fail"),
    check("chat_scope_consistent", validProbes.length === 0 ? "insufficient" :
      scopeConsistent ? "pass" : "fail"),
    check("canonical_scope_verified", validProbes.length === 0 ? "insufficient" :
      canonicalVerified ? "pass" : "fail"),
    check("chat_scope_attested", validAuthorizations.length === 0 ? "insufficient" :
      scopeAttested ? "pass" : onlyNeedsMoreSamples ? "insufficient" : "fail"),
    check("legacy_candidate_route_match", validEvents.length === 0 ? "insufficient" :
      routeConsistent ? "pass" : "fail"),
    check("legacy_candidate_full_match", validEvents.length === 0 ? "insufficient" :
      fullComparisonMatch ? "pass" : "fail"),
  ];

  let decision;
  // 证据源缺失与证据损坏走同一个最保守出口：两种情况下这份报告都不足以支撑"可以人工签字了"。
  if (!artifactIntegrity || !sourceDirsComplete) {
    decision = DIALOGUE_SHADOW_READINESS_DECISION.INVALID_EVIDENCE;
  }
  else if (!hasInteractionEvidence) {
    decision = DIALOGUE_SHADOW_READINESS_DECISION.INSUFFICIENT_EVIDENCE;
  } else if (automatedChecks.some((item) => item.status !== "pass")) {
    decision = DIALOGUE_SHADOW_READINESS_DECISION.NOT_READY;
  } else decision = DIALOGUE_SHADOW_READINESS_DECISION.MANUAL_REVIEW_REQUIRED;

  const report = {
    schema_version: DIALOGUE_SHADOW_READINESS_SCHEMA_VERSION,
    artifact_type: DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE,
    generated_at: generated,
    decision,
    source_count: sourceCount,
    missing_source_dirs: missingSourceDirs,
    read_errors: readErrors,
    artifacts: {
      authorizations: metric(authorizations.length, validAuthorizations.length, {
        active: validAuthorizations.filter((item) => item.status === "active").length,
        paused: validAuthorizations.filter((item) => item.status === "paused").length,
      }),
      events: metric(events.length, validEvents.length, {
        route_match: validEvents.filter((item) => item.comparison.route_match).length,
        full_match: validEvents.filter((item) => item.comparison.match).length,
        candidate_reason_counts: histogram(validEvents.map((item) =>
          item.comparison.candidate_reason)),
      }),
      // 只出计数与受控原因桶，不出 binding_ref、snapshot_id 或任何 locator。
      attestations: metric(validAuthorizations.length, attested.length, {
        reason_counts: histogram(attestations.map((item) =>
          item.ok ? item.attestation?.reason ?? null : item.reason)),
      }),
      probes: metric(probes.length, validProbes.length, {
        chat_locator_present: validProbes.filter((item) => item.chat_locator_present).length,
        chat_scope_match: validProbes.filter((item) => item.chat_scope_match === true).length,
        chat_scope_mismatch: validProbes.filter((item) => item.chat_scope_match === false).length,
        canonical_verified: validProbes.filter((item) => item.canonical_verified).length,
        thread_locator_present: validProbes.filter((item) => item.thread_locator_present).length,
      }),
    },
    correlation: {
      complete_pairs: completePairs,
      orphan_events: orphanEvents,
      orphan_probes: orphanProbes,
      missing_authorizations: missingAuthorizations,
      duplicate_ids: duplicateIds,
    },
    automated_checks: automatedChecks,
    manual_gates_unverified: [...MANUAL_GATES],
  };
  return validateDialogueShadowReadinessReport(report).ok
    ? { ok: true, report }
    : { ok: false, reason: "shadow_readiness_report_invalid" };
}

export function validateDialogueShadowReadinessReport(report) {
  const metricKeys = ["total", "valid", "invalid"];
  const validMetric = (value, extra) => onlyKeys(value, [...metricKeys, ...extra]) &&
    metricKeys.every((key) => nonNegativeInteger(value?.[key])) &&
    value.total === value.valid + value.invalid;
  const reasons = report?.artifacts?.events?.candidate_reason_counts;
  if (!onlyKeys(report, ["schema_version", "artifact_type", "generated_at", "decision",
    "source_count", "missing_source_dirs", "read_errors", "artifacts", "correlation",
    "automated_checks", "manual_gates_unverified"]) ||
      report?.schema_version !== DIALOGUE_SHADOW_READINESS_SCHEMA_VERSION ||
      report?.artifact_type !== DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE ||
      !isCanonicalIso(report?.generated_at) ||
      !Object.values(DIALOGUE_SHADOW_READINESS_DECISION).includes(report?.decision) ||
      ![report?.source_count, report?.missing_source_dirs, report?.read_errors]
        .every(nonNegativeInteger) ||
      // 缺失的目录数不可能多过被审的目录总数；能这样自相矛盾的报告是伪造或算错的。
      report.missing_source_dirs > report.source_count ||
      !onlyKeys(report?.artifacts, ["authorizations", "events", "probes", "attestations"]) ||
      !validMetric(report?.artifacts?.attestations, ["reason_counts"]) ||
      !validMetric(report?.artifacts?.authorizations, ["active", "paused"]) ||
      ![report?.artifacts?.authorizations?.active, report?.artifacts?.authorizations?.paused]
        .every(nonNegativeInteger) ||
      !validMetric(report?.artifacts?.events,
        ["route_match", "full_match", "candidate_reason_counts"]) ||
      ![report?.artifacts?.events?.route_match, report?.artifacts?.events?.full_match]
        .every(nonNegativeInteger) ||
      !reasons || typeof reasons !== "object" || Array.isArray(reasons) ||
      Object.entries(reasons).some(([key, value]) =>
        !["accepted", "other", ...KNOWN_REASONS].includes(key) || !nonNegativeInteger(value)) ||
      !validMetric(report?.artifacts?.probes, ["chat_locator_present", "chat_scope_match",
        "chat_scope_mismatch", "canonical_verified", "thread_locator_present"]) ||
      ![report?.artifacts?.probes?.chat_locator_present,
        report?.artifacts?.probes?.chat_scope_match,
        report?.artifacts?.probes?.chat_scope_mismatch,
        report?.artifacts?.probes?.canonical_verified,
        report?.artifacts?.probes?.thread_locator_present].every(nonNegativeInteger) ||
      !onlyKeys(report?.correlation, ["complete_pairs", "orphan_events", "orphan_probes",
        "missing_authorizations", "duplicate_ids"]) ||
      !Object.values(report?.correlation ?? {}).every(nonNegativeInteger) ||
      !Array.isArray(report?.automated_checks) ||
      // 集合与顺序一起钉死。只校验"是字符串"时，把某个 id 换成 /private/secret/path
      // 一样能通过，renderer 还会原样打出去 —— 那是路径泄露，不是格式问题。
      JSON.stringify(report.automated_checks.map((item) => item?.id)) !==
        JSON.stringify(DIALOGUE_SHADOW_READINESS_CHECK_IDS) ||
      report.automated_checks.some((item) => !onlyKeys(item, ["id", "status"]) ||
        !CHECK_STATUS.has(item.status)) ||
      !Array.isArray(report?.manual_gates_unverified) ||
      JSON.stringify(report.manual_gates_unverified) !== JSON.stringify(MANUAL_GATES)) {
    return { ok: false, reason: "shadow_readiness_report_invalid" };
  }
  return { ok: true };
}

export function renderDialogueShadowReadinessReport(report) {
  if (!validateDialogueShadowReadinessReport(report).ok) {
    return "Dialogue shadow 证据不可用。";
  }
  const failed = report.automated_checks.filter((item) => item.status !== "pass")
    .map((item) => item.id + "=" + item.status);
  return [
    "Dialogue shadow readiness · " + report.decision,
    "证据：authorization " + report.artifacts.authorizations.valid + "/" +
      report.artifacts.authorizations.total + "，event " + report.artifacts.events.valid + "/" +
      report.artifacts.events.total + "，probe " + report.artifacts.probes.valid + "/" +
      report.artifacts.probes.total,
    "关联：完整 " + report.correlation.complete_pairs + "，孤立 event " +
      report.correlation.orphan_events + "，孤立 probe " + report.correlation.orphan_probes,
    failed.length > 0 ? "未通过：" + failed.join("，") : "自动检查：全部通过",
    "仍需人工门禁：" + report.manual_gates_unverified.join("，"),
    "本报告不授权切换权威路由。",
  ].join("\n");
}
