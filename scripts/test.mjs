/**
 * 本地合成回归测试。零外部副作用：不碰飞书、不碰网络，只在临时目录里写文件。
 *
 * 覆盖重点是**拒绝路径**，不是接受路径 —— 接受路径错了会立刻被发现，
 * 拒绝路径错了会静默地把不该放行的消息放行。
 *
 * v2：标识符全部换到 Aily 命名空间（见 selector.mjs 顶部说明）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REJECT, bindingTokensInQuote, evaluateInbound, extractMentionIds, extractQuotedBlock,
  isValidPrefix, isValidQuota, normalizeBody,
} from "./selector.mjs";
import { NOTE_MAX, resolveUntil, validateNote } from "./binding.mjs";
import { FETCH_BACKOFF_MS, RECENT_TURNS, buildEventsArgs, fetchTriggerEvent } from "./envelope.mjs";
import { acquireClaim, claimKey, recordClaimState } from "./claim.mjs";
import { acquireSessionLock, releaseSessionLock, stampSessionLock, readRunOutcome } from "./handoff.mjs";
import {
  acquirePublishLock, attributeSession, fileContainsAny, isUnder,
  loadRegistry, releasePublishLock,
} from "./registry.mjs";
import { appendEvent, composeDigest, listPending, markSent } from "./outbox.mjs";
import {
  composeOutboundCard, outboundCardBatches, validateOutboundCard,
} from "./outbound-card.mjs";
import { drainProject, watcherActive } from "./drain-outbox.mjs";
import { bindingWarning, checkBinding } from "./binding-health.mjs";
import {
  findLiveSessions, forwardPrompt, hasPriorSession, isBridgeOwnedSession,
  stampInstruction, transcriptDirFor,
} from "./live-session.mjs";
import { extractReply } from "./stop-hook.mjs";
import {
  CHAIN_FIELDS, assertPublishIdentity, materializeProjectConfig,
  resolveLarkIdentity, validateChainTemplate,
} from "./chain-template.mjs";
import {
  PURPOSE_MAX, bindingToken, composeRootMessage, composeStatusMessage,
  firstSentence, idempotencyKeyFor, newRegistryEntry, readProjectIdentity,
} from "./bind-compose.mjs";
import {
  consumedPath, mappingFromRegistryEntry, resolveProject, selectBindingEntry,
} from "./project-resolve.mjs";
import { outboxDirOf } from "./drain-outbox.mjs";
import { identifySelf, newSessionEntry } from "./bind-session.mjs";
import { findLiveSessionById } from "./live-session.mjs";
import {
  SUSPENDED, bindingsForRoot, currentBinding, describeStatus, setBindingStatus,
} from "./feishu-control.mjs";
import { composeAsk, isInitPrompt } from "./init-hook.mjs";
import {
  composeTransportRule, isAilyTransportTurn, isBridgeOwnedTurn,
} from "./inbound-hook.mjs";
import {
  ROUTE_REJECT, loadRoutes, registerSession, selectRoute,
} from "./inbound-routes.mjs";
import { ENVELOPE_ENV as ENV_PASS, inheritedEvent } from "./envelope.mjs";
import { CANONICAL_EVENT_ENV } from "./canonical-event.mjs";
import {
  CANONICAL_EVENT_ENV as CANONICAL_PASS, buildCanonicalEvent, inheritedCanonicalEvent,
  legacyEventFromCanonical, validateCanonicalEvent,
} from "./canonical-event.mjs";
import { runInboundDispatcher } from "./inbound-dispatcher.mjs";
import {
  MAPPING_DISPOSITION, MAPPING_POLICY_ID, MAPPING_POLICY_VERSION,
  buildLegacyMappingContext, evaluateMappingAdmission, handleMappingPolicy,
} from "./mapping-policy.mjs";
import {
  DEFAULT_DIALOGUE_BUDGET, DIALOGUE_POLICY_ID, DIALOGUE_REASON, DIALOGUE_STATUS,
  DIALOGUE_TURN_STATUS, applyInteractionPolicyToAdmission, finalizeDialogueTurn,
  handleDialoguePolicy, interactionPolicyStateForLegacy, interactionPolicySummary,
  materializeInteractionPolicy, reserveDialogueTurn, setInteractionPolicyMode,
} from "./interaction-policy.mjs";
import {
  DEFAULT_RELAY_BUDGET, PARTICIPANT_SNAPSHOT_ARTIFACT_TYPE, RELAY_DISPOSITION,
  RELAY_PLAN_STATUS, RELAY_REASON, RELAY_STEP_STATUS, advanceRelayPlan, cancelRelayPlan,
  createParticipantAuthorizationSnapshot, createRelayPlanState, deriveDialogueBindingRef,
  deriveDialogueOutputRef, deriveDialogueParticipantRef, startRelayCycle,
  validateParticipantAuthorizationSnapshot,
  validateRelayPlanState,
} from "./dialogue-participant-planner.mjs";
import {
  BINDING_AUTHORIZATION_ARTIFACT_TYPE, BINDING_AUTHORIZATION_REASON,
  BOUND_AUTHORIZATION_SHADOW_ARTIFACT_TYPE,
  buildLegacyDialogueBoundAuthorizationContext, createDialogueBoundAuthorizationShadow,
  evaluateDialogueBoundAuthorization, materializeDialogueBindingAuthorization,
  validateDialogueBindingAuthorizationSnapshot, validateDialogueBoundAuthorizationShadow,
} from "./dialogue-binding-authorization.mjs";
import {
  dialogueAuthorizationShadowEnabled, recordDialogueBoundAuthorizationShadow,
  syncDialogueAuthorizationShadowSnapshot,
} from "./dialogue-authorization-shadow-store.mjs";
import {
  CHAT_SCOPE_PROBE_ARTIFACT_TYPE, createDialogueChatScopeProbe,
  sameDialogueChatScopeProbeObservation,
  validateDialogueChatScopeProbe,
} from "./dialogue-chat-scope-probe.mjs";
import {
  DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE, DIALOGUE_SHADOW_READINESS_CHECK_IDS,
  DIALOGUE_SHADOW_READINESS_DECISION,
  analyzeDialogueShadowEvidence, readDialogueShadowEvidence,
  renderDialogueShadowReadinessReport, validateDialogueShadowReadinessReport,
} from "./dialogue-shadow-readiness.mjs";
import { CANONICAL_TIME_PATTERN } from "./canonical-time.mjs";
import {
  ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS, ATTESTATION_EVIDENCE_MAX_AGE_MS,
  CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE, CHAT_SCOPE_ATTESTATION_REASON,
  CHAT_SCOPE_ATTESTATION_STATUS, MIN_ATTESTATION_SAMPLES,
  evaluateDialogueChatScopeAttestation, validateDialogueChatScopeAttestation,
} from "./dialogue-chat-scope-attestation.mjs";
import {
  MAX_LOCAL_INPUT_CHARS, claudeTurnInputDir, clearTurnInput, isFeishuStampedInput,
  readTurnInput, storeTurnInput,
} from "./turn-input.mjs";
import {
  currentSurface, diffSurface, loadSnapshot, sharedModules,
} from "./shared-surface.mjs";

// 顶层 await 先把导出面读出来，让下面那条测试保持**同步**。
// test() 跑器是同步的：给它一个 async 函数，fn() 只会返回一个 promise 而不会抛，
// 于是断言失败也会被记成通过 —— 这个仓库已经栽过一次「报绿而实际红」，不能再来一次。
const LIVE_SURFACE = await currentSurface();
import {
  PENDING_WINDOW_MS, PROMOTE_REJECT, appendConsumed, evaluatePromotion,
  buildClaudeSubscriptionProjection, findBindingForSession, findPendingBinding, loadConsumed,
  promoteBinding, shadowClaudeFirstClaim,
} from "./inbound-route.mjs";
import {
  SUBSCRIPTION_ARTIFACT_TYPE, SUBSCRIPTION_REJECT, SUBSCRIPTION_SCHEMA_VERSION,
  buildLegacySubscriptionReadModel, compareFirstClaimShadow, legacyEndpointId,
  stableControlId, validateSubscription,
} from "./subscription.mjs";
import {
  ROTATION_STATUS, activatePendingTopicGeneration, activeGeneration,
  closePendingTopicGeneration, materializeLegacyTopicFields, pendingGeneration,
  prepareTopicRotation, projectLegacyTopicGeneration, registerPendingTopicGeneration,
  recordTopicGenerationActivity, resolveOutboundGeneration, validateTopicGenerationState,
} from "./topic-generation.mjs";
import {
  prepareClaudeTopicRotation, recordClaudeTopicActivity, registerClaudeTopicRotation,
} from "./topic-generation-store.mjs";
import {
  finalizeClaudeDialogueTurn, loadClaudeInteractionPolicy, reserveClaudeDialogueTurn,
  setClaudeInteractionMode,
} from "./interaction-policy-store.mjs";
import {
  businessActivitiesForPublishedBatch, launchAutomaticTopicRotation,
} from "./automatic-topic-rotation.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(`${name}\n    ${err.message.split("\n")[0]}`);
  }
}

// ---------- 固定装置（取自 2026-08-19 真实信封） ----------

const NOW = Date.parse("2026-08-19T10:00:00Z");
const M5CLAUDE = "ou_07d4554816d5c05f306ef01ff7d229bb";
const M5CODEX = "ou_0272dfb0e04bfcd5a232bd34c94cb1c0";
const FRANK = "7621020633916345545";
const BOUND_SESSION = "session_bound";

const config = { transport_open_id: M5CLAUDE, default_freshness_ms: 10 * 60 * 1000 };

const baseMapping = {
  status: "active",
  expires_at: "2026-08-19T12:00:00Z",
  session_id: BOUND_SESSION,
  frank_sender_id: FRANK,
  inbound_prefix: "→Claude",
  logical_task_key: "feishu_bridge_cc",
  consumed_message_ids: [],
  max_inbound_messages: 5,
  freshness_ms: 10 * 60 * 1000,
};

const at = (id) => `<at id="${id}" type="employee">M5Claude</at>`;
const QUOTE = "\n\n**[引用]**\nClaude 侧飞书桥试点\nfeishu-bridge-cc 长期任务\n这是根话题正文";

const baseEvent = {
  message_id: "msg_1",
  session_id: BOUND_SESSION,
  sender_id: FRANK,
  created_at_ms: NOW - 5000,
  content: at(M5CLAUDE) + " →Claude 把出站发布器的草稿写完" + QUOTE,
};

const evalWith = (eventPatch = {}, mappingPatch = {}) =>
  evaluateInbound({
    event: { ...baseEvent, ...eventPatch },
    mapping: { ...baseMapping, ...mappingPatch },
    config,
    now: NOW,
  });

const dialogueAuthorizationFixture = () => {
  const runtimeNamespace = "claude";
  const endpointId = legacyEndpointId({ runtime: runtimeNamespace, agentUid: "agent_m5claude" });
  const template = {
    agent_uid: "agent_m5claude",
    transport_open_id: M5CLAUDE,
    frank_sender_id: FRANK,
    chat_id: "oc_private_dialogue",
    default_freshness_ms: 10 * 60 * 1000,
  };
  const model = buildLegacySubscriptionReadModel({
    runtime: runtimeNamespace,
    endpointId,
    template,
    pendingWindowMs: 24 * 60 * 60 * 1000,
    records: [{
      legacy_key: "dialogue-line",
      domain_key: "/private/project/path",
      local_target_id: stableControlId("target", runtimeNamespace, "dialogue-line"),
      status: "active",
      inbound_state: "bound",
      session_id: BOUND_SESSION,
      pending_token: null,
      bound_at: new Date(NOW - 60_000).toISOString(),
      chat_id: template.chat_id,
    }],
  });
  assert.equal(model.ok, true);
  const privateBindingKey = "private-binding-dialogue-line";
  const context = buildLegacyDialogueBoundAuthorizationContext({
    runtimeNamespace,
    model,
    legacyKey: "dialogue-line",
    privateBindingKey,
    bindingStatus: "active",
    verdict: { decision: "accept" },
  });
  assert.equal(context.ok, true);
  const built = buildCanonicalEvent({
    event: baseEvent,
    rawEnvelope: { type: "message.create", payload: { private: true } },
    endpointId,
    callerAgentUid: template.agent_uid,
  });
  assert.equal(built.ok, true);
  const trustedEvent = structuredClone(built.event);
  trustedEvent.source.chat_id = template.chat_id;
  trustedEvent.extensions.aily_channel = {
    verified: true,
    chat_id: template.chat_id,
    thread_id: null,
  };
  assert.equal(validateCanonicalEvent(trustedEvent).ok, true);
  return { runtimeNamespace, endpointId, template, model, privateBindingKey, context,
    unverifiedEvent: built.event, trustedEvent };
};

// ---------- 报文解析（真实格式） ----------

test("从真实 <at> 标签提取 mention id", () => {
  assert.deepEqual(extractMentionIds(baseEvent.content), [M5CLAUDE]);
});

test("引用块被切掉，不混入指令正文", () => {
  const body = normalizeBody(baseEvent.content);
  assert.equal(body, "→Claude 把出站发布器的草稿写完");
  assert.ok(!body.includes("引用"), "引用块必须被切掉");
});

test("平台把引用渲染成 > 前缀时同样切掉", () => {
  const c = at(M5CLAUDE) + " →Claude 干活\n\n> **[引用]**\n> 根消息";
  assert.equal(normalizeBody(c), "→Claude 干活");
});

// ---------- selector：接受路径 ----------

test("合格消息被接受", () => {
  const r = evalWith();
  assert.equal(r.decision, "accept");
  assert.equal(r.instruction, "把出站发布器的草稿写完");
  assert.equal(r.messageId, "msg_1");
});

// ---------- Topic Generation：同一 binding 的轮转、冻结与超时 ----------

test("Topic Generation v1 schema 与运行时常量一致", () => {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve("references", "topic-generation-v1.schema.json"), "utf-8"));
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.equal(schema.properties.artifact_type.const, "feishu_bridge_topic_generations");
  assert.deepEqual(schema.$defs.generation.properties.status.enum,
    ["pending", "active", "read-only", "retired"]);
  assert.equal(schema.$defs.activity.properties.auto_rotate_threshold.minimum, 1);
  assert.equal(schema.$defs.activity.properties.count_mode.const, "business_message_v1");
});

test("自动轮转按有效消息幂等计数，恰好 30 条时只取得一次尝试权", () => {
  const projected = projectLegacyTopicGeneration({
    runtime: "claude", bindingId: "activity-a", rootMessageId: "om_old",
    sessionId: "session_old", inboundState: "bound", now: NOW,
  });
  let state = projected.state;
  const generationId = state.active_generation_id;
  for (let index = 1; index <= 29; index += 1) {
    const counted = recordTopicGenerationActivity(state, {
      generationId, eventKey: "message-" + index, now: NOW + index,
    });
    assert.equal(counted.ok, true);
    assert.equal(counted.shouldAutoRotate, false);
    state = counted.state;
  }
  const duplicate = recordTopicGenerationActivity(state, {
    generationId, eventKey: "message-29", now: NOW + 30,
  });
  assert.equal(duplicate.counted, false);
  assert.equal(duplicate.messageCount, 29);

  const threshold = recordTopicGenerationActivity(state, {
    generationId, eventKey: "message-30", now: NOW + 31,
  });
  assert.equal(threshold.messageCount, 30);
  assert.equal(threshold.shouldAutoRotate, true);
  assert.equal(threshold.generation.activity.auto_rotation_attempts, 1);

  const cooldown = recordTopicGenerationActivity(threshold.state, {
    generationId, eventKey: "message-31", now: NOW + 32,
  });
  assert.equal(cooldown.messageCount, 31);
  assert.equal(cooldown.shouldAutoRotate, false, "同一轮失败后不能靠紧邻事件狂建话题");
  const retry = recordTopicGenerationActivity(cooldown.state, {
    generationId, eventKey: "message-32", now: NOW + 10 * 60 * 1000,
  });
  assert.equal(retry.shouldAutoRotate, true, "冷却后下一条新业务消息可重新申请轮转");
});

test("pending 阶段不重复触发，轮转后的旧代际迟到结果也不计入新代际", () => {
  const projected = projectLegacyTopicGeneration({
    runtime: "claude", bindingId: "activity-b", rootMessageId: "om_old",
    sessionId: "session_old", inboundState: "bound", now: NOW,
  });
  let state = projected.state;
  const oldId = state.active_generation_id;
  const counted = recordTopicGenerationActivity(state, {
    generationId: oldId, eventKey: "local-pair", messageDelta: 2, now: NOW + 1,
  });
  assert.equal(counted.messageCount, 2);
  const prepared = prepareTopicRotation(counted.state, { operationId: "op_activity", now: NOW + 2 });
  const registered = registerPendingTopicGeneration(prepared.state, {
    operationId: "op_activity", rootMessageId: "om_new", pendingToken: "abc123", now: NOW + 3,
  });
  const whilePending = recordTopicGenerationActivity(registered.state, {
    generationId: oldId, eventKey: "old-still-active", now: NOW + 4,
  });
  assert.equal(whilePending.counted, true);
  assert.equal(whilePending.shouldAutoRotate, false);
  const activated = activatePendingTopicGeneration(whilePending.state, {
    generationId: registered.generation.channel_generation_id,
    sessionId: "session_new", operationId: "op_activity", now: NOW + 5,
  });
  const late = recordTopicGenerationActivity(activated.state, {
    generationId: oldId, eventKey: "late-old-result", now: NOW + 6,
  });
  assert.equal(late.counted, false);
  assert.equal(late.reason, "generation_not_active");
  assert.equal(activeGeneration(late.state).activity.message_count, 0);
});

test("只有最终业务卡片计数；本地输入与回复合并卡计 2，纯进展计 0", () => {
  assert.deepEqual(businessActivitiesForPublishedBatch([
    { kind: "milestone", id: "progress" },
  ], { messageId: "om_progress", runtime: "claude" }), []);
  const local = businessActivitiesForPublishedBatch([{
    kind: "reply", event_key: "turn-1", input_origin: "local", input_text: "用户输入",
  }], { messageId: "om_reply", runtime: "codex" });
  assert.equal(local.length, 1);
  assert.equal(local[0].messageDelta, 2);
  assert.equal(local[0].eventKey, "outbound:codex:turn-1");
  const inboundReply = businessActivitiesForPublishedBatch([{
    kind: "reply", run_id: "run-1",
  }], { messageId: "om_reply_2", runtime: "claude" });
  assert.equal(inboundReply[0].messageDelta, 1);
});

test("自动轮转启动器只启动既有两阶段 CLI，不等待、不继承 Aily 入站身份", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "auto-rotation-launch-"));
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  let observed;
  const result = launchAutomaticTopicRotation({
    runtime: "codex", root, threadId: "thread-a", home,
    env: { SAFE_VALUE: "yes", AILY_CLI_AGENT_UID: "must-strip" },
    spawnImpl: (bin, args, options) => {
      observed = { bin, args, options };
      return { pid: 123, unref() { observed.unref = true; } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(observed.bin, process.execPath);
  assert.ok(observed.args.includes("--automatic"));
  assert.ok(observed.args.includes("--apply"));
  assert.ok(observed.args.includes("--thread-id"));
  assert.equal(observed.options.detached, true);
  assert.equal(observed.options.env.AILY_CLI_AGENT_UID, undefined);
  assert.equal(observed.options.env.SAFE_VALUE, "yes");
  assert.equal(observed.unref, true);
});

test("旧 mapping 投影出的 generation id 与既有 Mapping Policy 完全一致", () => {
  const bindingId = "legacy@registry";
  const projected = projectLegacyTopicGeneration({
    runtime: "claude",
    bindingId,
    rootMessageId: "om_old",
    sessionId: BOUND_SESSION,
    inboundState: "bound",
    createdAt: "2026-08-19T08:00:00.000Z",
  });
  assert.equal(projected.ok, true);
  const context = buildLegacyMappingContext({
    runtime: "claude",
    mapping: {
      binding_id: bindingId,
      logical_task_key: "legacy",
      session_id: BOUND_SESSION,
    },
    event: { session_id: BOUND_SESSION },
  });
  assert.equal(activeGeneration(projected.state).channel_generation_id,
    context.originChannelGenerationId);
});

test("轮转等待 mention 时旧代际仍 active，认领后一次状态替换完成新旧切换", () => {
  const legacy = projectLegacyTopicGeneration({
    runtime: "claude", bindingId: "binding_a", rootMessageId: "om_old",
    sessionId: "session_old", inboundState: "bound", now: NOW,
  });
  const prepared = prepareTopicRotation(legacy.state, { operationId: "op_a", now: NOW });
  assert.equal(prepared.ok, true);
  const registered = registerPendingTopicGeneration(prepared.state, {
    operationId: "op_a", rootMessageId: "om_new", pendingToken: "abc123", now: NOW,
  });
  assert.equal(registered.ok, true);
  assert.equal(activeGeneration(registered.state).root_message_id, "om_old");
  assert.equal(pendingGeneration(registered.state).root_message_id, "om_new");
  assert.equal(validateTopicGenerationState(registered.state).ok, true);

  const activated = activatePendingTopicGeneration(registered.state, {
    generationId: registered.generation.channel_generation_id,
    sessionId: "session_new",
    operationId: "op_a",
    now: NOW + 1000,
  });
  assert.equal(activated.ok, true);
  assert.equal(activeGeneration(activated.state).root_message_id, "om_new");
  assert.equal(activated.previous.status, "read-only");
  assert.equal(activated.state.rotation.status, ROTATION_STATUS.COMPLETED);
  assert.equal(validateTopicGenerationState(activated.state).ok, true);

  const oldTarget = resolveOutboundGeneration(
    activated.state,
    activated.previous.channel_generation_id,
  );
  assert.equal(oldTarget.ok, true, "轮转前冻结的迟到结果仍必须能回旧话题");
  assert.equal(oldTarget.rootMessageId, "om_old");
  const projected = materializeLegacyTopicFields({}, activated.state);
  assert.equal(projected.record.root_message_id, "om_new");
  assert.equal(projected.record.session_id, "session_new");
});

test("pending generation 超过 24 小时后 fail-closed，旧代际保持 active", () => {
  const legacy = projectLegacyTopicGeneration({
    runtime: "claude", bindingId: "binding_b", rootMessageId: "om_old",
    sessionId: "session_old", inboundState: "bound", now: NOW,
  });
  const prepared = prepareTopicRotation(legacy.state, { operationId: "op_b", now: NOW });
  const registered = registerPendingTopicGeneration(prepared.state, {
    operationId: "op_b", rootMessageId: "om_new", pendingToken: "def456", now: NOW,
  });
  const tooLate = activatePendingTopicGeneration(registered.state, {
    sessionId: "session_new", now: NOW + PENDING_WINDOW_MS + 1,
  });
  assert.equal(tooLate.reason, "pending_generation_expired");
  const expired = closePendingTopicGeneration(registered.state, {
    operationId: "op_b", reason: ROTATION_STATUS.EXPIRED,
    now: NOW + PENDING_WINDOW_MS + 1,
  });
  assert.equal(expired.ok, true);
  assert.equal(activeGeneration(expired.state).root_message_id, "om_old");
  assert.equal(pendingGeneration(expired.state), null);
  assert.equal(expired.generation.status, "retired");
});

test("Claude registry adapter 在同一份 binding 文档中持久化轮转并原子激活", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "topic-generation-claude-"));
  const root = path.join(local, "project");
  fs.mkdirSync(root, { recursive: true });
  const regFile = path.join(local, "registry.json");
  const entry = newRegistryEntry({
    root, name: "Claude Generation", purpose: null, token: "aaa111",
    rootMessageId: "om_old", now: NOW,
  });
  // 先完成初始 generation 认领，再开始轮转。
  fs.writeFileSync(regFile, JSON.stringify({
    schema_version: "1.0",
    registry_extension: { must_survive: true },
    projects: [entry],
  }, null, 2));
  const first = promoteBinding({
    root, id: entry.id, source: "registry", generationId: entry.channel_generation_id,
    sessionId: "session_old", registryFile: regFile, now: NOW + 1,
  });
  assert.equal(first.ok, true);
  const prepared = prepareClaudeTopicRotation({
    root, operationId: "op_store", registryFile: regFile, now: NOW + 2,
  });
  assert.equal(prepared.ok, true);
  const registered = registerClaudeTopicRotation({
    root, operationId: "op_store", rootMessageId: "om_new", pendingToken: "bbb222",
    registryFile: regFile, now: NOW + 3,
  });
  assert.equal(registered.ok, true);
  const beforeClaim = JSON.parse(fs.readFileSync(regFile, "utf-8")).projects[0];
  assert.equal(beforeClaim.root_message_id, "om_old", "pending 阶段旧代际仍是旧字段权威值");
  assert.equal(activeGeneration(beforeClaim.topic_generation_state).root_message_id, "om_old");

  const second = promoteBinding({
    root, id: entry.id, source: "registry",
    generationId: registered.generation.channel_generation_id,
    sessionId: "session_new", registryFile: regFile, now: NOW + 4,
  });
  assert.equal(second.ok, true);
  const afterClaim = JSON.parse(fs.readFileSync(regFile, "utf-8")).projects[0];
  assert.equal(afterClaim.root_message_id, "om_new");
  assert.equal(afterClaim.session_id, "session_new");
  assert.equal(afterClaim.topic_generation_state.generations.find((generation) =>
    generation.root_message_id === "om_old").status, "read-only");
  assert.deepEqual(JSON.parse(fs.readFileSync(regFile, "utf-8")).registry_extension,
    { must_survive: true }, "轮转原子替换不得丢掉未知的 registry 顶层字段");
});

test("Claude registry adapter 原子持久化代际计数，重复事件不增量", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "topic-activity-claude-"));
  const root = path.join(local, "project");
  fs.mkdirSync(root, { recursive: true });
  const regFile = path.join(local, "registry.json");
  const entry = newRegistryEntry({
    root, name: "Claude Activity", purpose: null, token: "aaa111",
    rootMessageId: "om_old", now: NOW,
  });
  fs.writeFileSync(regFile, JSON.stringify({ schema_version: "1.0", projects: [entry] }));
  promoteBinding({
    root, id: entry.id, source: "registry", generationId: entry.channel_generation_id,
    sessionId: "session_old", registryFile: regFile, now: NOW + 1,
  });
  const first = recordClaudeTopicActivity({
    root, generationId: entry.channel_generation_id, eventKey: "msg-one",
    registryFile: regFile, now: NOW + 2,
  });
  const duplicate = recordClaudeTopicActivity({
    root, generationId: entry.channel_generation_id, eventKey: "msg-one",
    registryFile: regFile, now: NOW + 3,
  });
  assert.equal(first.messageCount, 1);
  assert.equal(duplicate.counted, false);
  assert.equal(JSON.parse(fs.readFileSync(regFile, "utf-8"))
    .projects[0].topic_generation_state.generations[0].activity.message_count, 1);
});

// ---------- Dialogue Slice B1：已绑定授权快照与独立 shadow sidecar ----------

test("Canonical Event 只有双字段一致时才接受 verified chat scope", () => {
  const fixture = dialogueAuthorizationFixture();
  const forged = structuredClone(fixture.trustedEvent);
  forged.extensions.aily_channel.chat_id = "oc_other";
  assert.equal(validateCanonicalEvent(forged).ok, false);
  assert.ok(validateCanonicalEvent(forged).problems.includes("extensions.aily_channel.chat_scope"));

  const missing = structuredClone(fixture.trustedEvent);
  missing.source.chat_id = null;
  assert.equal(validateCanonicalEvent(missing).ok, false);
  assert.equal(validateCanonicalEvent(fixture.unverifiedEvent).ok, true,
    "现行 dispatcher 的 unverified 事件仍保持兼容");
});

test("binding authorization snapshot 只含 opaque ref，授权内容不变时 revision 幂等", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-auth-snapshot-"));
  const first = syncDialogueAuthorizationShadowSnapshot({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    capturedAt: NOW,
  });
  const same = syncDialogueAuthorizationShadowSnapshot({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    capturedAt: NOW + 1000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(same.changed, false);
  assert.equal(same.snapshot.authorization_revision, 1);
  assert.equal(validateDialogueBindingAuthorizationSnapshot(same.snapshot).ok, true);
  assert.equal(same.snapshot.artifact_type, BINDING_AUTHORIZATION_ARTIFACT_TYPE);

  const serialized = JSON.stringify(same.snapshot);
  for (const secret of [fixture.privateBindingKey, fixture.template.chat_id,
    fixture.template.frank_sender_id, fixture.template.transport_open_id,
    "/private/project/path"]) {
    assert.equal(serialized.includes(secret), false, "快照泄露私有输入：" + secret);
  }

  const pausedInput = structuredClone(fixture.context.authorizationInput);
  pausedInput.subscription.status = "paused";
  const paused = syncDialogueAuthorizationShadowSnapshot({
    shadowDir, authorizationInput: pausedInput, capturedAt: NOW + 2000,
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.changed, true);
  assert.equal(paused.snapshot.authorization_revision, 2);
  assert.equal(paused.snapshot.status, "paused");
  assert.equal(paused.snapshot.reason, BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_PAUSED);
});

test("bound authorization 候选在 chat 未核验时 fail-closed，可信同 scope 才接受", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-auth-evaluate-"));
  const synced = syncDialogueAuthorizationShadowSnapshot({
    shadowDir, authorizationInput: fixture.context.authorizationInput, capturedAt: NOW,
  });
  const unverified = evaluateDialogueBoundAuthorization({
    snapshot: synced.snapshot,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    now: NOW,
  });
  assert.equal(unverified.reason, BINDING_AUTHORIZATION_REASON.CHAT_SCOPE_UNVERIFIED);
  assert.deepEqual(unverified.scope_unverified, ["chat_id"]);

  const accepted = evaluateDialogueBoundAuthorization({
    snapshot: synced.snapshot,
    canonicalEvent: fixture.trustedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.local_target_id, fixture.context.legacy.local_target_id);

  const forgedBinding = evaluateDialogueBoundAuthorization({
    snapshot: synced.snapshot,
    canonicalEvent: fixture.trustedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: "binding_ref_ffffffffffffffffffffffff",
    now: NOW,
  });
  assert.equal(forgedBinding.reason, BINDING_AUTHORIZATION_REASON.BINDING_MISMATCH);
});

test("chat scope probe 只记录脱敏 presence 与一致性，不提升 canonical trust", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-scope-probe-"));
  const synced = syncDialogueAuthorizationShadowSnapshot({
    shadowDir, authorizationInput: fixture.context.authorizationInput, capturedAt: NOW,
  });
  const matching = structuredClone(fixture.unverifiedEvent);
  matching.extensions.aily_channel.chat_id = fixture.template.chat_id;
  matching.extensions.aily_channel.thread_id = "opaque-runtime-thread";
  const created = createDialogueChatScopeProbe({
    snapshot: synced.snapshot, canonicalEvent: matching, observedAt: NOW,
  });
  assert.equal(created.ok, true);
  assert.equal(created.probe.artifact_type, CHAT_SCOPE_PROBE_ARTIFACT_TYPE);
  assert.equal(created.probe.canonical_verified, false,
    "一致性观测不能自行把 canonical event 提升为可信");
  assert.equal(created.probe.chat_locator_present, true);
  assert.equal(created.probe.chat_scope_match, true);
  assert.equal(created.probe.thread_locator_present, true);
  assert.equal(validateDialogueChatScopeProbe(created.probe).ok, true);

  const absent = createDialogueChatScopeProbe({
    snapshot: synced.snapshot, canonicalEvent: fixture.unverifiedEvent, observedAt: NOW,
  });
  assert.equal(absent.probe.chat_locator_present, false);
  assert.equal(absent.probe.chat_scope_match, null);

  const mismatch = structuredClone(matching);
  mismatch.extensions.aily_channel.chat_id = "oc_other_private";
  const mismatched = createDialogueChatScopeProbe({
    snapshot: synced.snapshot, canonicalEvent: mismatch, observedAt: NOW,
  });
  assert.equal(mismatched.probe.chat_scope_match, false);
  assert.equal(mismatched.probe.probe_id, created.probe.probe_id,
    "同一 snapshot/event 必须落到同一冲突域，而不是悄悄生成第二份独立证据");
  assert.equal(sameDialogueChatScopeProbeObservation(created.probe, mismatched.probe), false);

  const serialized = JSON.stringify([created.probe, absent.probe, mismatched.probe]);
  for (const secret of [fixture.template.chat_id, "opaque-runtime-thread", "oc_other_private",
    fixture.template.frank_sender_id, fixture.privateBindingKey]) {
    assert.equal(serialized.includes(secret), false, "scope probe 泄露私有输入：" + secret);
  }
  const tampered = structuredClone(created.probe);
  tampered.chat_scope_match = false;
  assert.equal(validateDialogueChatScopeProbe(tampered).ok, false,
    "probe 内容被改写后必须由内容寻址 ID 检出");
  const retargeted = structuredClone(created.probe);
  retargeted.binding_ref = "binding_ref_ffffffffffffffffffffffff";
  assert.equal(validateDialogueChatScopeProbe(retargeted).ok, false,
    "binding_ref 也必须由 evidence hash 覆盖");
  const redated = structuredClone(created.probe);
  redated.observed_at = new Date(NOW + 1).toISOString();
  assert.equal(validateDialogueChatScopeProbe(redated).ok, false,
    "observed_at 也必须由 evidence hash 覆盖");
});

test("bound authorization shadow 独立写证据、重复幂等，且不写原始身份", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-auth-sidecar-"));
  const first = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  const duplicate = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW + 1000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.comparison.match, false);
  assert.equal(first.evidence.artifact_type, BOUND_AUTHORIZATION_SHADOW_ARTIFACT_TYPE);
  assert.equal(validateDialogueBoundAuthorizationShadow(first.evidence).ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.evidence.shadow_id, first.evidence.shadow_id);
  assert.equal(first.scopeProbe.ok, true);
  assert.equal(first.scopeProbe.probe.chat_locator_present, false);
  assert.equal(duplicate.scopeProbe.duplicate, true);
  assert.deepEqual(fs.readdirSync(shadowDir).sort(), ["authorizations", "events", "scope-probes"]);

  const allFiles = [first.file, path.join(shadowDir, "authorizations",
    first.snapshot.binding_ref + ".json"), first.scopeProbe.file];
  const serialized = allFiles.map((file) => fs.readFileSync(file, "utf-8")).join("\n");
  for (const secret of [fixture.privateBindingKey, fixture.template.chat_id,
    fixture.template.frank_sender_id, fixture.template.transport_open_id]) {
    assert.equal(serialized.includes(secret), false, "sidecar 泄露私有输入：" + secret);
  }
});

test("bound authorization 投影歧义 fail-closed，shadow 开关默认关闭", () => {
  const fixture = dialogueAuthorizationFixture();
  const ambiguous = structuredClone(fixture.model);
  ambiguous.pending_bindings.push(structuredClone(ambiguous.pending_bindings[0]));
  const context = buildLegacyDialogueBoundAuthorizationContext({
    runtimeNamespace: fixture.runtimeNamespace,
    model: ambiguous,
    legacyKey: "dialogue-line",
    privateBindingKey: fixture.privateBindingKey,
    bindingStatus: "active",
    verdict: { decision: "accept" },
  });
  assert.equal(context.reason, BINDING_AUTHORIZATION_REASON.BINDING_AMBIGUOUS);
  assert.equal(dialogueAuthorizationShadowEnabled({}), false);
  assert.equal(dialogueAuthorizationShadowEnabled({ FEISHU_DIALOGUE_AUTHORIZATION_SHADOW: "true" }),
    false);
  assert.equal(dialogueAuthorizationShadowEnabled({ FEISHU_DIALOGUE_AUTHORIZATION_SHADOW: "1" }),
    true);
});

test("shadow artifact 畸形输入与 sidecar I/O 失败都只返回诊断", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-auth-failure-"));
  const synced = syncDialogueAuthorizationShadowSnapshot({
    shadowDir, authorizationInput: fixture.context.authorizationInput, capturedAt: NOW,
  });
  assert.doesNotThrow(() => createDialogueBoundAuthorizationShadow({
    snapshot: synced.snapshot,
    canonicalEvent: fixture.unverifiedEvent,
    comparison: { mode: "shadow", scope_unverified: {} },
    recordedAt: NOW,
  }));
  assert.equal(createDialogueBoundAuthorizationShadow({
    snapshot: synced.snapshot,
    canonicalEvent: fixture.unverifiedEvent,
    comparison: { mode: "shadow", scope_unverified: {} },
    recordedAt: NOW,
  }).ok, false);

  const blockedPath = path.join(shadowDir, "blocked");
  fs.writeFileSync(blockedPath, "not-a-directory");
  const failed = recordDialogueBoundAuthorizationShadow({
    shadowDir: blockedPath,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /^shadow_/u);
});

test("chat scope probe 损坏不能阻断既有 authorization shadow", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-probe-isolation-"));
  const first = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(first.ok, true);
  fs.writeFileSync(first.scopeProbe.file, "{}\n");
  const second = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW + 1000,
  });
  assert.equal(second.ok, true, "诊断探针永远不能成为 legacy/shadow 主证据的承重依赖");
  assert.equal(second.duplicate, true);
  assert.equal(second.scopeProbe.ok, false);
  assert.equal(second.scopeProbe.reason, "chat_scope_probe_invalid");
});

test("同一 event 的 chat scope 观测冲突会显式诊断且不阻断 B1", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-probe-conflict-"));
  const first = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  const changedObservation = structuredClone(fixture.unverifiedEvent);
  changedObservation.extensions.aily_channel.chat_id = fixture.template.chat_id;
  const second = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: changedObservation,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW + 1000,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true, "探针冲突不能改变原 authorization shadow");
  assert.equal(second.duplicate, true);
  assert.equal(second.scopeProbe.ok, false);
  assert.equal(second.scopeProbe.reason, "chat_scope_probe_conflict");
  assert.equal(second.scopeProbe.probe_id, first.scopeProbe.probe.probe_id);
});

test("Dialogue Slice B1 schema 固化授权快照与 shadow artifact", () => {
  const snapshotSchema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-binding-authorization-v1.schema.json"), "utf-8"));
  const shadowSchema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-bound-authorization-shadow-v1.schema.json"), "utf-8"));
  const scopeProbeSchema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-chat-scope-probe-v1.schema.json"), "utf-8"));
  assert.equal(snapshotSchema.properties.artifact_type.const,
    BINDING_AUTHORIZATION_ARTIFACT_TYPE);
  assert.equal(snapshotSchema.properties.authorized_human_participant_ids.uniqueItems, true);
  assert.equal(shadowSchema.properties.artifact_type.const,
    BOUND_AUTHORIZATION_SHADOW_ARTIFACT_TYPE);
  assert.equal(shadowSchema.properties.evaluator_version.const, "1.0");
  assert.equal(scopeProbeSchema.properties.artifact_type.const,
    CHAT_SCOPE_PROBE_ARTIFACT_TYPE);
  assert.equal(scopeProbeSchema.properties.chat_scope_match.type.includes("null"), true);
});

const analyzeShadowDir = (shadowDir, generatedAt = NOW) => {
  const loaded = readDialogueShadowEvidence({ shadowDirs: [shadowDir] });
  assert.equal(loaded.ok, true);
  return analyzeDialogueShadowEvidence({
    sourceCount: loaded.evidence.source_count,
    missingSourceDirs: loaded.evidence.missing_source_dirs,
    readErrors: loaded.evidence.read_errors,
    authorizations: loaded.evidence.authorizations,
    events: loaded.evidence.events,
    probes: loaded.evidence.probes,
    generatedAt,
  });
};

test("Dialogue shadow readiness 对无样本和未核验 chat scope 保持 fail-closed", () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-empty-"));
  const empty = analyzeShadowDir(emptyDir);
  assert.equal(empty.ok, true);
  assert.equal(empty.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.INSUFFICIENT_EVIDENCE);

  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-shadow-"));
  const observed = structuredClone(fixture.unverifiedEvent);
  observed.extensions.aily_channel.chat_id = fixture.template.chat_id;
  observed.extensions.aily_channel.thread_id = "private-thread-locator";
  const wrote = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: observed,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(wrote.ok, true);
  const analyzed = analyzeShadowDir(shadowDir);
  assert.equal(analyzed.ok, true);
  assert.equal(analyzed.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.NOT_READY);
  assert.equal(analyzed.report.correlation.complete_pairs, 1);
  assert.equal(analyzed.report.artifacts.probes.chat_locator_present, 1);
  assert.equal(analyzed.report.artifacts.probes.chat_scope_match, 1);
  assert.equal(analyzed.report.artifacts.probes.canonical_verified, 0,
    "runtime 字段存在且匹配也不能自行提升 canonical trust");
  assert.equal(analyzed.report.artifacts.events.route_match, 0);
  assert.equal(analyzed.report.artifacts.events.candidate_reason_counts.chat_scope_unverified, 1);
  assert.equal(validateDialogueShadowReadinessReport(analyzed.report).ok, true);

  const serialized = JSON.stringify(analyzed.report) + "\n" +
    renderDialogueShadowReadinessReport(analyzed.report);
  for (const secret of [shadowDir, fixture.template.chat_id, "private-thread-locator",
    fixture.privateBindingKey, wrote.snapshot.binding_ref, wrote.evidence.event_ref]) {
    assert.equal(serialized.includes(secret), false, "readiness 报告泄露私有证据：" + secret);
  }
});

// —— 以下三条对应 Codex 对 PR #17 的三项阻断复审 ——

/** evidence 是 snake_case，analyze 收 camelCase；显式映射，别把两套形状混着用。 */
const asAnalyzeInput = (evidence) => ({
  sourceCount: evidence.source_count,
  missingSourceDirs: evidence.missing_source_dirs,
  readErrors: evidence.read_errors,
  authorizations: evidence.authorizations,
  events: evidence.events,
  probes: evidence.probes,
});

test("Dialogue shadow readiness 对缺失的证据源 fail-closed，但不误伤空目录", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-src-real-"));
  fs.mkdirSync(path.join(real, "authorizations"), { recursive: true });
  const gone = path.join(os.tmpdir(), "readiness-src-absent-" + Date.now());

  const read = readDialogueShadowEvidence({ shadowDirs: [real, gone] });
  assert.equal(read.evidence.source_count, 2);
  assert.equal(read.evidence.missing_source_dirs, 1, "根目录不存在才算证据源缺失");

  const analyzed = analyzeDialogueShadowEvidence({ ...asAnalyzeInput(read.evidence), generatedAt: NOW });
  assert.equal(analyzed.ok, true);
  assert.notEqual(analyzed.report.decision,
    DIALOGUE_SHADOW_READINESS_DECISION.MANUAL_REVIEW_REQUIRED,
    "看不全证据时绝不能给出'只差人工签字'的口径");
  assert.equal(analyzed.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.INVALID_EVIDENCE);
  const sourceCheck = analyzed.report.automated_checks
    .find((item) => item.id === "source_dirs_complete");
  assert.equal(sourceCheck.status, "fail", "必须有一项检查明确指出是哪里不全");

  // 存在但还空着的目录是合法的"尚未收集"，不能被算成证据缺失。
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-src-empty-"));
  const emptyRead = readDialogueShadowEvidence({ shadowDirs: [emptyDir] });
  assert.equal(emptyRead.evidence.missing_source_dirs, 0);
  assert.equal(
    analyzeDialogueShadowEvidence({ ...asAnalyzeInput(emptyRead.evidence), generatedAt: NOW })
      .report.decision,
    DIALOGUE_SHADOW_READINESS_DECISION.INSUFFICIENT_EVIDENCE);

  // 自相矛盾的报告要拒：缺失数不可能多过总数。
  const good = analyzed.report;
  assert.equal(validateDialogueShadowReadinessReport(good).ok, true);
  assert.equal(validateDialogueShadowReadinessReport(
    { ...good, missing_source_dirs: good.source_count + 1 }).ok, false);
});

test("Dialogue shadow readiness 的 generated_at 规范化，越界判错而不抛", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-time-"));
  const base = readDialogueShadowEvidence({ shadowDirs: [dir] }).evidence;
  const run = (generatedAt) =>
    analyzeDialogueShadowEvidence({ ...asAnalyzeInput(base), generatedAt });

  assert.equal(run(NOW).report.generated_at, new Date(NOW).toISOString());
  assert.equal(run(new Date(NOW + 123)).report.generated_at,
    new Date(NOW + 123).toISOString(), "Date 入参不能丢毫秒");
  assert.equal(run("Aug 19 2026").report.generated_at.endsWith("Z"), true);
  assert.match(run("Aug 19 2026").report.generated_at, new RegExp(CANONICAL_TIME_PATTERN, "u"),
    "Date.parse 收、JSON Schema 不收的写法必须被折算，不能原样进制品");

  // 原实现在校验之前就调用了 iso()，Infinity 会直接抛 RangeError。
  for (const bad of [Infinity, -Infinity, Number.NaN, 9e15, 2.6e14, "not-a-time", {}]) {
    let outcome;
    assert.doesNotThrow(() => { outcome = run(bad); },
      "越界或非法时间必须判成 input_invalid，不能抛异常穿透给调用方");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "shadow_readiness_input_invalid");
  }

  const report = run(NOW).report;
  for (const bad of ["2026-08-19", "2026-08-19T10:00:00Z", "2026-08-19T18:00:00+08:00",
    "+010209-01-27T06:13:20.000Z", "Aug 19 2026", 1755597600000, null]) {
    assert.equal(validateDialogueShadowReadinessReport({ ...report, generated_at: bad }).ok, false,
      "generated_at = " + JSON.stringify(bad) + " 必须被拒");
  }
});

test("Dialogue shadow readiness 的自动检查 ID 受控，挡住路径泄露", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-ids-"));
  const report = analyzeDialogueShadowEvidence({
    ...asAnalyzeInput(readDialogueShadowEvidence({ shadowDirs: [dir] }).evidence),
    generatedAt: NOW,
  }).report;
  assert.deepEqual(report.automated_checks.map((item) => item.id),
    [...DIALOGUE_SHADOW_READINESS_CHECK_IDS], "集合与顺序都必须与受控清单一致");
  assert.equal(validateDialogueShadowReadinessReport(report).ok, true);

  const swap = (index, id) => {
    const checks = report.automated_checks.map((item) => ({ ...item }));
    checks[index] = { ...checks[index], id };
    return { ...report, automated_checks: checks };
  };
  // 这条是本项阻断的原样复现：任意字符串能通过时，renderer 会把它原样打出去。
  assert.equal(validateDialogueShadowReadinessReport(swap(0, "/private/secret/path")).ok, false,
    "任意 id 必须被拒 —— 否则等于开了一条把绝对路径印进报告的通道");
  assert.equal(validateDialogueShadowReadinessReport(swap(1, "samples_present_x")).ok, false);
  assert.equal(validateDialogueShadowReadinessReport(
    swap(1, DIALOGUE_SHADOW_READINESS_CHECK_IDS[0])).ok, false, "重复 id 要拒");

  const reordered = [...report.automated_checks];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.equal(validateDialogueShadowReadinessReport(
    { ...report, automated_checks: reordered }).ok, false, "顺序也钉死");
  assert.equal(validateDialogueShadowReadinessReport(
    { ...report, automated_checks: report.automated_checks.slice(1) }).ok, false, "缺项要拒");

  // schema 与运行时同源：逐位 const 必须与受控清单逐字对齐。
  const schema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-shadow-readiness-report-v1.schema.json"), "utf-8"));
  assert.deepEqual(schema.properties.automated_checks.prefixItems.map((s) => s.properties.id.const),
    [...DIALOGUE_SHADOW_READINESS_CHECK_IDS]);
  assert.equal(schema.properties.automated_checks.items, false, "不允许多出未受控的检查项");
  assert.equal(schema.properties.generated_at.pattern, CANONICAL_TIME_PATTERN);

  // renderer 只输出受控检查名。
  const rendered = renderDialogueShadowReadinessReport(report);
  assert.equal(rendered.includes("/private/"), false);
  assert.equal(rendered.includes(os.tmpdir()), false, "报告正文不得出现任何输入路径");
});

test("Dialogue shadow readiness 自动检查全过也只要求人工评审", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-trusted-"));
  const wrote = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.trustedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(wrote.ok, true);
  const analyzed = analyzeShadowDir(shadowDir);
  assert.equal(analyzed.report.automated_checks.every((item) => item.status === "pass"), true);
  assert.equal(analyzed.report.decision,
    DIALOGUE_SHADOW_READINESS_DECISION.MANUAL_REVIEW_REQUIRED);
  assert.deepEqual(analyzed.report.manual_gates_unverified, [
    "trusted_locator_source", "both_runtime_coverage", "generation_rotation_coverage",
    "rollback_rehearsal",
  ]);
  assert.match(renderDialogueShadowReadinessReport(analyzed.report),
    /本报告不授权切换权威路由/u);
});

test("Dialogue shadow readiness 在授权修订覆盖旧快照后拒绝旧 event/probe", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-revision-"));
  const wrote = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.trustedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(wrote.ok, true);
  const pausedInput = structuredClone(fixture.context.authorizationInput);
  pausedInput.binding.status = "paused";
  const revised = syncDialogueAuthorizationShadowSnapshot({
    shadowDir, authorizationInput: pausedInput, capturedAt: NOW + 1000,
  });
  assert.equal(revised.ok, true);
  assert.equal(revised.snapshot.authorization_revision, 2);
  assert.notEqual(revised.snapshot.snapshot_id, wrote.snapshot.snapshot_id);

  const analyzed = analyzeShadowDir(shadowDir);
  assert.equal(analyzed.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.NOT_READY);
  assert.equal(analyzed.report.correlation.missing_authorizations, 2,
    "event 与 probe 引用的旧授权快照都必须显式失配");
  assert.equal(analyzed.report.automated_checks.find((item) =>
    item.id === "correlation_complete").status, "fail");
});

test("Dialogue shadow readiness 将只有 probe 的样本判为孤立且不放行", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-orphan-probe-"));
  const wrote = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.trustedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(wrote.ok, true);
  fs.rmSync(wrote.file);

  const analyzed = analyzeShadowDir(shadowDir);
  assert.equal(analyzed.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.NOT_READY);
  assert.equal(analyzed.report.correlation.complete_pairs, 0);
  assert.equal(analyzed.report.correlation.orphan_events, 0);
  assert.equal(analyzed.report.correlation.orphan_probes, 1);
});

test("Dialogue shadow readiness 合并多目录时检测跨目录重复且不重复计完整配对", () => {
  const fixture = dialogueAuthorizationFixture();
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-multi-a-"));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-multi-b-"));
  const wrote = recordDialogueBoundAuthorizationShadow({
    shadowDir: firstDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.trustedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(wrote.ok, true);
  for (const subdir of ["authorizations", "events", "scope-probes"]) {
    fs.cpSync(path.join(firstDir, subdir), path.join(secondDir, subdir), { recursive: true });
  }
  const loaded = readDialogueShadowEvidence({ shadowDirs: [firstDir, secondDir] });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.evidence.source_count, 2);
  const analyzed = analyzeDialogueShadowEvidence({
    sourceCount: loaded.evidence.source_count,
    missingSourceDirs: loaded.evidence.missing_source_dirs,
    readErrors: loaded.evidence.read_errors,
    authorizations: loaded.evidence.authorizations,
    events: loaded.evidence.events,
    probes: loaded.evidence.probes,
    generatedAt: NOW,
  });
  assert.equal(analyzed.ok, true);
  assert.equal(analyzed.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.NOT_READY);
  assert.equal(analyzed.report.correlation.duplicate_ids, 3);
  assert.equal(analyzed.report.correlation.complete_pairs, 0,
    "同一 correlation key 的重复 artifact 不能被多算为完整配对");
  assert.equal(analyzed.report.correlation.orphan_events, 2);
  assert.equal(analyzed.report.correlation.orphan_probes, 2);

  const cli = spawnSync(process.execPath, [path.resolve("scripts", "dialogue-shadow-audit.mjs"),
    "--shadow-dir", firstDir, "--shadow-dir", secondDir, "--json"], { encoding: "utf-8" });
  assert.equal(cli.status, 0, cli.stderr);
  const cliReport = JSON.parse(cli.stdout);
  assert.equal(cliReport.decision, DIALOGUE_SHADOW_READINESS_DECISION.NOT_READY);
  for (const secret of [firstDir, secondDir, wrote.evidence.event_ref, wrote.snapshot.binding_ref]) {
    assert.equal(cli.stdout.includes(secret), false,
      "多目录 CLI 汇总不得回显私有路径或 opaque ref");
  }
});

test("Dialogue shadow readiness 把损坏、孤立和 CLI 路径统一收敛为脱敏诊断", () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-readiness-corrupt-"));
  const wrote = recordDialogueBoundAuthorizationShadow({
    shadowDir,
    authorizationInput: fixture.context.authorizationInput,
    canonicalEvent: fixture.unverifiedEvent,
    runtimeNamespace: fixture.runtimeNamespace,
    expectedBindingRef: fixture.context.expectedBindingRef,
    legacy: fixture.context.legacy,
    now: NOW,
  });
  assert.equal(wrote.ok, true);
  fs.writeFileSync(path.join(shadowDir, "events", "corrupt.json"), "{not-json\n");
  fs.rmSync(wrote.scopeProbe.file);
  const analyzed = analyzeShadowDir(shadowDir);
  assert.equal(analyzed.report.decision, DIALOGUE_SHADOW_READINESS_DECISION.INVALID_EVIDENCE);
  assert.equal(analyzed.report.read_errors, 1);
  assert.equal(analyzed.report.correlation.orphan_events, 1);

  const cli = spawnSync(process.execPath, [path.resolve("scripts", "dialogue-shadow-audit.mjs"),
    "--shadow-dir", shadowDir, "--json"], { encoding: "utf-8" });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.decision, DIALOGUE_SHADOW_READINESS_DECISION.INVALID_EVIDENCE);
  assert.equal(cli.stdout.includes(shadowDir), false, "CLI 不得回显私有 sidecar 路径");
  assert.equal(cli.stdout.includes(wrote.evidence.event_ref), false, "CLI 不得输出 opaque ref");
});

test("Dialogue shadow readiness schema 与运行时 artifact 固化一致", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-shadow-readiness-report-v1.schema.json"), "utf-8"));
  assert.equal(schema.properties.artifact_type.const,
    DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE);
  assert.deepEqual(schema.properties.manual_gates_unverified.const, [
    "trusted_locator_source", "both_runtime_coverage", "generation_rotation_coverage",
    "rollback_rehearsal",
  ]);
  const reasonNames = schema.$defs.eventMetrics.properties.candidate_reason_counts
    .propertyNames.enum;
  const runtimeReasonNames = ["accepted", "other", ...new Set([
    ...Object.values(BINDING_AUTHORIZATION_REASON), ...Object.values(REJECT),
  ])].sort();
  assert.deepEqual([...reasonNames].sort(), runtimeReasonNames,
    "JSON Schema 与运行时必须维护完全相同的受控 reason bucket 集合");
});

// ---------- Dialogue Chat Scope Attestation（Slice B2c）：候选证据聚合，仍不提升 canonical trust ----------

const chatScopeAttestationFixture = () => {
  const fixture = dialogueAuthorizationFixture();
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-scope-attestation-"));
  const synced = syncDialogueAuthorizationShadowSnapshot({
    shadowDir, authorizationInput: fixture.context.authorizationInput, capturedAt: NOW,
  });
  assert.equal(synced.ok, true);
  const buildProbe = ({
    suffix, observedAt = NOW, chatId = fixture.template.chat_id, locatorPresent = true,
    snapshot = synced.snapshot,
  }) => {
    const event = { ...baseEvent, message_id: "msg_attest_" + suffix };
    const built = buildCanonicalEvent({
      event, rawEnvelope: { type: "message.create", payload: { opaque: true } },
      endpointId: fixture.endpointId, callerAgentUid: fixture.template.agent_uid,
    });
    assert.equal(built.ok, true);
    const canonicalEvent = structuredClone(built.event);
    if (locatorPresent) {
      canonicalEvent.extensions.aily_channel.chat_id = chatId;
      canonicalEvent.extensions.aily_channel.thread_id = "opaque-runtime-thread";
    }
    const created = createDialogueChatScopeProbe({ snapshot, canonicalEvent, observedAt });
    assert.equal(created.ok, true);
    return created.probe;
  };
  return { fixture, snapshot: synced.snapshot, buildProbe };
};

test("Chat scope attestation 证据缺失或独立样本不足时保持 unverified", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const empty = evaluateDialogueChatScopeAttestation({ snapshot, probes: [], now: NOW });
  assert.equal(empty.ok, true);
  assert.equal(empty.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(empty.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE);
  assert.equal(empty.attestation.sample_count, 0);
  assert.equal(empty.attestation.first_observed_at, null);
  assert.equal(validateDialogueChatScopeAttestation(empty.attestation).ok, true);

  const two = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" })], now: NOW,
  });
  assert.equal(two.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(two.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE);
  assert.equal(two.attestation.sample_count, 2);

  const duplicated = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [buildProbe({ suffix: "same" }), buildProbe({ suffix: "same" })], now: NOW,
  });
  assert.equal(duplicated.attestation.sample_count, 1,
    "同一 event 的重复观测不能凑成两条独立样本");
  assert.equal(duplicated.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.INSUFFICIENT_EVIDENCE);
});

test("Chat scope attestation 对任何一条损坏或互相矛盾的证据整体 fail-closed", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const probes = [buildProbe({ suffix: "a" }), buildProbe({ suffix: "b" }), buildProbe({ suffix: "c" })];
  const corrupted = structuredClone(probes[1]);
  corrupted.chat_scope_match = false;
  const withCorrupted = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [probes[0], corrupted, probes[2]], now: NOW,
  });
  assert.equal(withCorrupted.ok, true);
  assert.equal(withCorrupted.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(withCorrupted.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.EVIDENCE_INVALID);
  assert.equal(withCorrupted.attestation.sample_count, 0, "损坏证据不能保留部分计数凑数");

  const conflictingOne = buildProbe({ suffix: "z" });
  const conflictingTwo = buildProbe({ suffix: "z", chatId: "oc_other_private" });
  assert.equal(conflictingOne.probe_id, conflictingTwo.probe_id,
    "同一 snapshot/event 的观测必须落在同一冲突域");
  assert.notEqual(conflictingOne.evidence_hash, conflictingTwo.evidence_hash);
  const withConflict = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [probes[0], probes[2], conflictingOne, conflictingTwo], now: NOW,
  });
  assert.equal(withConflict.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(withConflict.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.EVIDENCE_INVALID);
});

test("Chat scope attestation 拒绝跨 binding 或跨授权 revision 混入的证据", () => {
  const { fixture, snapshot, buildProbe } = chatScopeAttestationFixture();
  const validProbes = [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" })];

  const otherInput = {
    ...fixture.context.authorizationInput,
    binding: {
      ...fixture.context.authorizationInput.binding,
      private_binding_key: "private-binding-other-line",
    },
  };
  const otherMaterialized = materializeDialogueBindingAuthorization({ ...otherInput, capturedAt: NOW });
  assert.equal(otherMaterialized.ok, true);
  assert.notEqual(otherMaterialized.snapshot.binding_ref, snapshot.binding_ref);
  const foreignProbe = buildProbe({ suffix: "foreign", snapshot: otherMaterialized.snapshot });
  const crossBinding = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [...validProbes, foreignProbe], now: NOW,
  });
  assert.equal(crossBinding.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(crossBinding.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.BINDING_MISMATCH);

  const revisedSubscription = structuredClone(fixture.context.authorizationInput.subscription);
  revisedSubscription.constraints = {
    ...revisedSubscription.constraints,
    freshness_ms: revisedSubscription.constraints.freshness_ms + 1000,
  };
  const revisedInput = { ...fixture.context.authorizationInput, subscription: revisedSubscription };
  const revisedMaterialized = materializeDialogueBindingAuthorization({ ...revisedInput, capturedAt: NOW });
  assert.equal(revisedMaterialized.ok, true);
  assert.equal(revisedMaterialized.snapshot.binding_ref, snapshot.binding_ref);
  assert.notEqual(revisedMaterialized.snapshot.snapshot_id, snapshot.snapshot_id);
  const revisedProbe = buildProbe({ suffix: "revised", snapshot: revisedMaterialized.snapshot });
  const crossSnapshot = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [...validProbes, revisedProbe], now: NOW,
  });
  assert.equal(crossSnapshot.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(crossSnapshot.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.SNAPSHOT_MISMATCH);
});

test("Chat scope attestation 拒绝任何一条过期或未来时间戳的证据", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const fresh = [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" })];
  const stale = buildProbe({
    suffix: "3", observedAt: NOW - ATTESTATION_EVIDENCE_MAX_AGE_MS - 1,
  });
  const staleResult = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [...fresh, stale], now: NOW,
  });
  assert.equal(staleResult.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(staleResult.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.STALE_EVIDENCE);
  assert.equal(staleResult.attestation.evidence_max_age_ms, ATTESTATION_EVIDENCE_MAX_AGE_MS,
    "判定用的窗口必须写进制品，否则说不清当时凭什么认为证据过期");

  const future = buildProbe({ suffix: "4", observedAt: NOW + 60_000 });
  const futureResult = evaluateDialogueChatScopeAttestation({
    snapshot, probes: [...fresh, future], now: NOW,
  });
  assert.equal(futureResult.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(futureResult.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.EVIDENCE_INVALID,
    "未来时间戳只能是损坏或篡改，不能算作过期之外的正常样本");
});

// 阻断项 1 的回归：证据保留窗口必须独立于消息防重放期限。
test("Chat scope attestation 的证据窗口与 snapshot.freshness_ms 解耦", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  assert.ok(ATTESTATION_EVIDENCE_MAX_AGE_MS > snapshot.freshness_ms,
    "前提：证据窗口必须比防重放期限长，否则跨轮取证根本攒不齐样本");

  // 三条观测分散在远超 freshness_ms（默认 15 分钟）的时间里 —— 这正是 attestation
  // 的正常工作形态：跨多轮、跨话题轮转积累。旧实现会把它们全判成过期。
  const spread = [
    buildProbe({ suffix: "1", observedAt: NOW - snapshot.freshness_ms * 4 }),
    buildProbe({ suffix: "2", observedAt: NOW - snapshot.freshness_ms * 2 }),
    buildProbe({ suffix: "3", observedAt: NOW }),
  ];
  const result = evaluateDialogueChatScopeAttestation({ snapshot, probes: spread, now: NOW });
  assert.equal(result.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE,
    "跨越防重放期限的多轮证据仍应成立；把两条策略焊在一起会让它永远无法成立");
  assert.equal(result.attestation.reason, null);
  assert.equal(result.attestation.sample_count, MIN_ATTESTATION_SAMPLES);
  assert.equal(validateDialogueChatScopeAttestation(result.attestation).ok, true);

  // 边界：正好压在证据窗口上的一条仍算数，越过一毫秒就不算。
  const atEdge = buildProbe({ suffix: "e", observedAt: NOW - ATTESTATION_EVIDENCE_MAX_AGE_MS });
  assert.equal(
    evaluateDialogueChatScopeAttestation({
      snapshot, probes: [...spread.slice(0, 2), atEdge], now: NOW,
    }).attestation.status,
    CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE, "窗口是闭区间，边界上仍成立");

  // 反向不能靠改 snapshot 来验：snapshot_id 是内容派生的，改 freshness_ms 等于伪造快照，
  // 会被完整性校验直接判 INVALID_SNAPSHOT，测不到想测的东西。
  // 真正要钉死的是"源码里根本不读这个字段"——这条防的是将来有人又把两条策略接回去。
  const source = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname),
      "dialogue-chat-scope-attestation.mjs"), "utf-8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.ok(!codeOnly.includes("freshness_ms"),
    "attestation 的判定代码不得读取 snapshot.freshness_ms —— 那是消息防重放期限，不是证据保留期");
});

test("Chat scope attestation 的证据窗口可显式收紧，但不可取消过期", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const spread = [
    buildProbe({ suffix: "1", observedAt: NOW - 60 * 60 * 1000 }),
    buildProbe({ suffix: "2", observedAt: NOW - 30 * 60 * 1000 }),
    buildProbe({ suffix: "3", observedAt: NOW }),
  ];
  assert.equal(
    evaluateDialogueChatScopeAttestation({ snapshot, probes: spread, now: NOW })
      .attestation.status,
    CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE, "默认窗口下成立");

  const strict = evaluateDialogueChatScopeAttestation({
    snapshot, probes: spread, now: NOW, evidenceMaxAgeMs: 10 * 60 * 1000,
  });
  assert.equal(strict.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(strict.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.STALE_EVIDENCE);
  assert.equal(strict.attestation.evidence_max_age_ms, 10 * 60 * 1000,
    "制品要自述当时用的是哪个窗口，否则两份结论不同的 attestation 无法区分");

  for (const bad of [0, -1, 1.5, "600000", null,
    ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS + 1]) {
    const rejected = evaluateDialogueChatScopeAttestation({
      snapshot, probes: spread, now: NOW, evidenceMaxAgeMs: bad,
    });
    assert.equal(rejected.ok, false, "非法证据窗口 " + String(bad) + " 必须判成调用方错误");
    assert.equal(rejected.reason, CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID);
  }
});

// 阻断项 2 的回归：generated_at 必须一律由已校验的 nowMs 规范化。
test("Chat scope attestation 的 generated_at 永远是规范 ISO，越界数值判错而不抛", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const probes = [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" }),
    buildProbe({ suffix: "3" })];
  const expected = new Date(NOW).toISOString();

  // Date 对象：旧实现会把它原样放进 generated_at（一个对象，不是 string/date-time），
  // 而且 Date.parse(dateObject) 走 toString()，毫秒会被静默截断。
  const withMs = new Date(NOW + 123);
  const fromDate = evaluateDialogueChatScopeAttestation({ snapshot, probes, now: withMs });
  assert.equal(typeof fromDate.attestation.generated_at, "string");
  assert.equal(fromDate.attestation.generated_at, new Date(NOW + 123).toISOString(),
    "Date 入参不能丢毫秒");
  assert.equal(validateDialogueChatScopeAttestation(fromDate.attestation).ok, true);

  // 可解析但非 RFC3339 的字符串：旧实现原样透传，schema 的 format: date-time 不认。
  const fromLoose = evaluateDialogueChatScopeAttestation({
    snapshot, probes, now: "2026-08-19T10:00:00Z",
  });
  assert.equal(fromLoose.attestation.generated_at, expected);
  const fromDateOnly = evaluateDialogueChatScopeAttestation({
    snapshot, probes, now: "2026-08-19",
  });
  assert.equal(fromDateOnly.attestation.generated_at, "2026-08-19T00:00:00.000Z",
    "非规范但可解析的输入要被折算成规范形式，而不是原样透传");
  assert.equal(validateDialogueChatScopeAttestation(fromDateOnly.attestation).ok, true);

  // 越界数值：Number.isFinite 拦不住，toISOString() 会抛 RangeError。
  // 本模块承诺"只有调用方错误才返回 ok:false"，没承诺会抛。
  // 2.6e14 是另一类：它**不抛**，却会产出 "+010209-01-27T06:13:20.000Z" 这种六位年份 ——
  // 能被 Date.parse 往返，但不是合法 RFC3339，schema 拒收。边界必须按四位年份卡，
  // 而不是按 ECMAScript 的 ±8.64e15。
  for (const outOfRange of [9e15, -9e15, Number.MAX_SAFE_INTEGER, 2.6e14,
    Date.parse("9999-12-31T23:59:59.999Z") + 1]) {
    let outcome;
    assert.doesNotThrow(() => {
      outcome = evaluateDialogueChatScopeAttestation({ snapshot, probes, now: outOfRange });
    }, "越界时间值必须判成输入错误，不能抛异常穿透给调用方");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID);
  }
  for (const bad of [Number.NaN, Infinity, "not-a-time", {}]) {
    assert.equal(evaluateDialogueChatScopeAttestation({ snapshot, probes, now: bad }).ok, false);
  }
});

test("Chat scope attestation validator 与 JSON Schema 对 date-time 同解", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const good = evaluateDialogueChatScopeAttestation({
    snapshot,
    probes: [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" }),
      buildProbe({ suffix: "3" })],
    now: NOW,
  }).attestation;
  assert.equal(validateDialogueChatScopeAttestation(good).ok, true);

  // 运行时不能接受 schema 会拒的东西 —— 这正是原来 Number.isFinite(Date.parse(x)) 的漏洞。
  for (const field of ["generated_at", "first_observed_at", "last_observed_at"]) {
    for (const bad of ["2026-08-19", "2026-08-19T10:00:00", "2026-08-19T10:00:00Z",
      "2026-08-19T18:00:00+08:00", "+010209-01-27T06:13:20.000Z",
      "2026-02-30T00:00:00.000Z", 1755597600000, null]) {
      assert.equal(validateDialogueChatScopeAttestation({ ...good, [field]: bad }).ok, false,
        field + " = " + JSON.stringify(bad) + " 不是规范 date-time，validator 必须拒");
    }
  }

  // 双向等价：schema 的 pattern 与运行时用的是同一条，且两边对同一组样本判一致。
  // 早先版本只做 toISOString 往返，自以为"单向更严"，其实两个方向都不对：
  // 偏移写法上更严（schema 收、运行时拒），扩展年份上更松（运行时收、schema 拒）——
  // 后者意味着运行时会产出 schema 校验不过的制品。
  const timeRe = new RegExp(CANONICAL_TIME_PATTERN, "u");
  const timeSchema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-chat-scope-attestation-v1.schema.json"), "utf-8"));
  for (const field of ["generated_at", "first_observed_at", "last_observed_at"]) {
    assert.equal(timeSchema.properties[field].pattern, CANONICAL_TIME_PATTERN,
      field + " 的 schema pattern 必须与运行时同源");
  }
  for (const sample of ["2026-08-19T10:00:00.000Z", "0001-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z", "+010209-01-27T06:13:20.000Z", "2026-08-19T10:00:00Z",
    "2026-08-19T18:00:00+08:00", "2026-08-19", "2026-02-30T00:00:00.000Z"]) {
    const bySchema = timeRe.test(sample);
    const byRuntime = validateDialogueChatScopeAttestation(
      { ...good, generated_at: sample }).ok;
    // 形状合法但日期不存在的（2026-02-30）schema pattern 拦不住，运行时靠往返相等再拦一道；
    // 除此之外两边必须给出相同结论。
    if (sample !== "2026-02-30T00:00:00.000Z") {
      assert.equal(byRuntime, bySchema,
        sample + "：schema pattern 与运行时 validator 结论必须一致");
    } else {
      assert.equal(bySchema, true);
      assert.equal(byRuntime, false, "不存在的日期靠往返相等兜住");
    }
  }
  for (const bad of [undefined, 0, -1, 1.5, ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS + 1]) {
    assert.equal(
      validateDialogueChatScopeAttestation({ ...good, evidence_max_age_ms: bad }).ok, false,
      "evidence_max_age_ms = " + String(bad) + " 越界或缺失时必须拒");
  }
});

test("Chat scope attestation 要求全部样本 locator 存在且 chat scope 一致", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const missing = evaluateDialogueChatScopeAttestation({
    snapshot,
    probes: [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" }),
      buildProbe({ suffix: "3", locatorPresent: false })],
    now: NOW,
  });
  assert.equal(missing.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(missing.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.LOCATOR_MISSING);

  const mismatch = evaluateDialogueChatScopeAttestation({
    snapshot,
    probes: [buildProbe({ suffix: "4" }), buildProbe({ suffix: "5" }),
      buildProbe({ suffix: "6", chatId: "oc_other_private" })],
    now: NOW,
  });
  assert.equal(mismatch.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.UNVERIFIED);
  assert.equal(mismatch.attestation.reason, CHAT_SCOPE_ATTESTATION_REASON.SCOPE_MISMATCH);
});

test("Chat scope attestation 在足够、独立、新鲜且一致的真实观测后才产生 shadow candidate", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const probes = [
    buildProbe({ suffix: "1", observedAt: NOW - 3000 }),
    buildProbe({ suffix: "2", observedAt: NOW - 2000 }),
    buildProbe({ suffix: "3", observedAt: NOW - 1000 }),
  ];
  const result = evaluateDialogueChatScopeAttestation({ snapshot, probes, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE);
  assert.equal(result.attestation.reason, null);
  assert.equal(result.attestation.sample_count, MIN_ATTESTATION_SAMPLES);
  assert.equal(result.attestation.first_observed_at, new Date(NOW - 3000).toISOString());
  assert.equal(result.attestation.last_observed_at, new Date(NOW - 1000).toISOString());
  assert.equal(validateDialogueChatScopeAttestation(result.attestation).ok, true);

  const serialized = JSON.stringify(result.attestation);
  assert.equal(serialized.includes("oc_private_dialogue"), false,
    "attestation 不得包含原始 chat_id");
  assert.equal(serialized.includes("opaque-runtime-thread"), false,
    "attestation 不得包含原始 thread locator");
});

test("Chat scope attestation 校验器拒绝 status/reason/sample_count 不自洽的记录", () => {
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const probes = [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" }), buildProbe({ suffix: "3" })];
  const ok = evaluateDialogueChatScopeAttestation({ snapshot, probes, now: NOW });
  assert.equal(ok.attestation.status, CHAT_SCOPE_ATTESTATION_STATUS.ATTESTED_CANDIDATE);

  const brokenReason = structuredClone(ok.attestation);
  brokenReason.reason = CHAT_SCOPE_ATTESTATION_REASON.STALE_EVIDENCE;
  assert.equal(validateDialogueChatScopeAttestation(brokenReason).ok, false);

  const brokenCount = structuredClone(ok.attestation);
  brokenCount.sample_count = 1;
  assert.equal(validateDialogueChatScopeAttestation(brokenCount).ok, false,
    "attested_candidate 不能低于固定最小样本数");

  const brokenRange = structuredClone(ok.attestation);
  brokenRange.first_observed_at = null;
  assert.equal(validateDialogueChatScopeAttestation(brokenRange).ok, false);
});

test("Chat scope attestation 对调用方传入的畸形 snapshot/probes 返回 input_invalid", () => {
  const bad = evaluateDialogueChatScopeAttestation({ snapshot: {}, probes: [], now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID);

  const { snapshot } = chatScopeAttestationFixture();
  const badProbes = evaluateDialogueChatScopeAttestation({ snapshot, probes: "not-array", now: NOW });
  assert.equal(badProbes.ok, false);
  assert.equal(badProbes.reason, CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID);
});

test("Dialogue Chat Scope Attestation schema 与运行时常量一致", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-chat-scope-attestation-v1.schema.json"), "utf-8"));
  assert.equal(schema.properties.artifact_type.const, CHAT_SCOPE_ATTESTATION_ARTIFACT_TYPE);
  assert.deepEqual(schema.properties.status.enum, Object.values(CHAT_SCOPE_ATTESTATION_STATUS));
  assert.deepEqual(schema.properties.reason.enum,
    [null, ...Object.values(CHAT_SCOPE_ATTESTATION_REASON).filter((reason) =>
      reason !== CHAT_SCOPE_ATTESTATION_REASON.INPUT_INVALID)]);

  // 字段集也要对齐。原来这条测试只比三个枚举，不比 key 集合 —— 那正是让运行时多出
  // 一个 schema 不认识的字段（或反过来）而无人发现的那道缝。
  const { snapshot, buildProbe } = chatScopeAttestationFixture();
  const produced = evaluateDialogueChatScopeAttestation({
    snapshot,
    probes: [buildProbe({ suffix: "1" }), buildProbe({ suffix: "2" }),
      buildProbe({ suffix: "3" })],
    now: NOW,
  }).attestation;
  assert.deepEqual(Object.keys(produced).sort(), [...schema.required].sort(),
    "运行时产出的字段集必须与 schema.required 完全相同");
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(),
    "schema 里不应存在既非 required 又被 additionalProperties:false 排除的悬空字段");
  assert.equal(schema.properties.evidence_max_age_ms.maximum,
    ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS,
    "证据窗口上限必须两边同源，否则 validator 与 schema 会在边界上分歧");
  assert.ok(ATTESTATION_EVIDENCE_MAX_AGE_MS <= ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS);
});

// ---------- Mapping Policy：公共准入、处置与 runtime-neutral runRequest ----------

test("Mapping Policy 同轮计算 Canonical Event 候选并与旧 selector 影子比较", () => {
  const built = buildCanonicalEvent({
    event: baseEvent,
    rawEnvelope: { type: "message.create", payload: { opaque: true } },
    endpointId: "endpoint_claude",
    callerAgentUid: "agent_m5claude",
  });
  assert.equal(built.ok, true);
  const evaluation = evaluateMappingAdmission({
    canonicalEvent: built.event, event: baseEvent,
    mapping: baseMapping, config, now: NOW,
  });
  assert.equal(evaluation.decision, "accept");
  assert.equal(evaluation.instruction, "把出站发布器的草稿写完");
  assert.equal(evaluation.evaluation_path, "legacy_event_v2");
  assert.equal(evaluation.candidate_evaluation_path, "canonical_event_v1");
  assert.equal(evaluation.admission_shadow.match, true);
  assert.equal(evaluation.policy_id, MAPPING_POLICY_ID);
  assert.equal(evaluation.policy_version, MAPPING_POLICY_VERSION);
});

test("Mapping Policy 影子不一致只留证据，旧 selector 在真实验收前仍是唯一权威", () => {
  const built = buildCanonicalEvent({
    event: baseEvent,
    rawEnvelope: { type: "message.create", payload: { opaque: true } },
    endpointId: "endpoint_claude",
    callerAgentUid: "agent_m5claude",
  });
  const evaluation = evaluateMappingAdmission({
    canonicalEvent: built.event,
    event: { ...baseEvent, content: "被篡改的兼容正文" },
    mapping: baseMapping,
    config,
    now: NOW,
  });
  assert.equal(evaluation.decision, "reject", "旧 selector 结果仍然承重");
  assert.equal(evaluation.admission_shadow.match, false);
  assert.equal(evaluation.admission_shadow.legacy_decision, "reject");
  assert.equal(evaluation.admission_shadow.candidate_decision, "accept");
});

test("Mapping Policy 的 accepted 结果只给 runtime-neutral runRequest，不泄露 session/任务键", () => {
  const evaluation = evaluateMappingAdmission({ event: baseEvent, mapping: baseMapping, config, now: NOW });
  const context = buildLegacyMappingContext({
    runtime: "claude", mapping: baseMapping, event: baseEvent,
  });
  assert.equal(context.ok, true);
  assert.equal(context.projection, "legacy_mapping_v1");
  const outcome = handleMappingPolicy({
    evaluation, claim: { ok: true, key: "claim_opaque" }, resolvedContext: context,
  });
  assert.equal(outcome.disposition, MAPPING_DISPOSITION.ACCEPTED);
  assert.equal(outcome.claimId, "claim_opaque");
  assert.equal(outcome.runRequest.runId, "claim_opaque");
  assert.equal(outcome.runRequest.userInput, "把出站发布器的草稿写完");
  assert.equal(outcome.runRequest.origin.kind, "feishu");
  assert.equal(outcome.runRequest.policy.policy_id, MAPPING_POLICY_ID);
  const serialized = JSON.stringify(outcome.runRequest);
  assert.equal(serialized.includes(BOUND_SESSION), false, "runRequest 不得携带 Aily session locator");
  assert.equal(serialized.includes(baseMapping.logical_task_key), false,
    "runRequest 不得携带旧 logical task locator");
});

test("Mapping Policy 明确区分 rejected、duplicate 与 busy，非 accepted 不生成 runRequest", () => {
  const rejectedEvaluation = evaluateMappingAdmission({
    event: { ...baseEvent, sender_id: "unauthorized" }, mapping: baseMapping, config, now: NOW,
  });
  const rejected = handleMappingPolicy({ evaluation: rejectedEvaluation });
  assert.equal(rejected.disposition, MAPPING_DISPOSITION.REJECTED);
  assert.equal("runRequest" in rejected, false);

  const evaluation = evaluateMappingAdmission({ event: baseEvent, mapping: baseMapping, config, now: NOW });
  const duplicate = handleMappingPolicy({
    evaluation, claim: { ok: false, reason: "duplicate", key: "claim_duplicate" },
  });
  assert.equal(duplicate.disposition, MAPPING_DISPOSITION.DUPLICATE);
  assert.equal("runRequest" in duplicate, false);

  const busy = handleMappingPolicy({
    evaluation, claim: { ok: true, key: "claim_busy" }, targetState: "busy",
  });
  assert.equal(busy.disposition, MAPPING_DISPOSITION.BUSY);
  assert.equal("runRequest" in busy, false);
});

// ---------- Dialogue Policy：单主持者串行回合、预算与硬停止 ----------

test("旧 binding 默认保持 Mapping；显式切到 Dialogue 才创建有界状态", () => {
  const loaded = interactionPolicyStateForLegacy({ binding_id: "binding_a" }, {
    bindingId: "binding_a", now: NOW,
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.policy_id, "mapping");
  assert.equal(loaded.state.dialogue, null);

  const enabled = setInteractionPolicyMode(loaded.state, { mode: "dialogue", now: NOW + 1 });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.state.policy_id, DIALOGUE_POLICY_ID);
  assert.equal(enabled.dialogue.status, DIALOGUE_STATUS.ACTIVE);
  assert.equal(enabled.dialogue.turn_order, "human_then_host_serial");
  assert.equal(enabled.dialogue.allow_agent_output_as_input, false);
  assert.equal(enabled.dialogue.concurrency.max_active_turns, 1);
  assert.equal(enabled.dialogue.concurrency.mention_loop, "disabled");
  assert.equal(enabled.dialogue.concurrency.agent_output_relay, "disabled");
  assert.equal(enabled.dialogue.finalization.summarizer_participant_id, "bound_local_target");
  assert.equal(enabled.dialogue.finalization.publish_target, "origin_channel_generation");
  assert.deepEqual(enabled.dialogue.stop_conditions, [
    "round_budget", "time_budget", "resource_budget", "runtime_failure", "human_interrupt",
  ]);
  assert.deepEqual(enabled.dialogue.budget, DEFAULT_DIALOGUE_BUDGET);
  assert.equal(enabled.dialogue.participants.length, 2);
  assert.equal(interactionPolicySummary(enabled.state).maxRounds, 12);
  const same = setInteractionPolicyMode(enabled.state, { mode: "dialogue", now: NOW + 2 });
  assert.equal(same.changed, false);
  assert.equal(same.dialogue.dialogue_id, enabled.dialogue.dialogue_id);
});

test("Dialogue 每轮生成稳定 dialogue_id/turn_index，重复 event 不增加预算", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_b" }, {
    bindingId: "binding_b", now: NOW,
  }).state;
  const enabled = setInteractionPolicyMode(base, { mode: "dialogue", now: NOW }).state;
  const first = reserveDialogueTurn(enabled, {
    eventId: "om_turn_1", runId: "claim_1", localTargetId: "local_opaque",
    originChannelGenerationId: "generation_opaque", runtimeTargetId: "runtime_private",
    now: NOW + 1,
  });
  assert.equal(first.accepted, true);
  assert.equal(first.reservation.turn_index, 1);
  assert.equal(first.state.dialogue.usage.rounds_started, 1);
  assert.equal(first.state.dialogue.usage.resource_units_used, 1);

  const duplicate = reserveDialogueTurn(first.state, {
    eventId: "om_turn_1", runId: "claim_1", localTargetId: "local_opaque",
    originChannelGenerationId: "generation_opaque", now: NOW + 2,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.state.dialogue.usage.rounds_started, 1);
});

test("Dialogue 在活动回合结束前拒绝并发；完成后才开放下一串行回合", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_c" }, {
    bindingId: "binding_c", now: NOW,
  }).state;
  const enabled = setInteractionPolicyMode(base, { mode: "dialogue", now: NOW }).state;
  const first = reserveDialogueTurn(enabled, {
    eventId: "om_1", runId: "run_1", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 1,
  });
  const concurrent = reserveDialogueTurn(first.state, {
    eventId: "om_2", runId: "run_2", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 2,
  });
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.reason, DIALOGUE_REASON.TURN_ACTIVE);

  const finalized = finalizeDialogueTurn(first.state, {
    runId: "run_1", status: DIALOGUE_TURN_STATUS.COMPLETED, now: NOW + 3,
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.state.dialogue.active_turn, null);
  const second = reserveDialogueTurn(finalized.state, {
    eventId: "om_2", runId: "run_2", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 4,
  });
  assert.equal(second.accepted, true);
  assert.equal(second.reservation.turn_index, 2);
});

test("Dialogue 达到任一预算硬停止，运行失败也终止整个 dialogue", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_d" }, {
    bindingId: "binding_d", now: NOW,
  }).state;
  const enabled = setInteractionPolicyMode(base, {
    mode: "dialogue", now: NOW,
    budget: { max_rounds: 1, max_duration_ms: 60_000, max_resource_units: 1 },
  }).state;
  const first = reserveDialogueTurn(enabled, {
    eventId: "om_1", runId: "run_1", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 1,
  });
  const completed = finalizeDialogueTurn(first.state, {
    runId: "run_1", status: DIALOGUE_TURN_STATUS.COMPLETED, now: NOW + 2,
  });
  assert.equal(completed.state.dialogue.status, DIALOGUE_STATUS.COMPLETED);
  assert.equal(completed.state.dialogue.stop_reason, DIALOGUE_REASON.ROUND_BUDGET);

  const enabledAgain = setInteractionPolicyMode(completed.state, {
    mode: "dialogue", now: NOW + 10,
  }).state;
  const next = reserveDialogueTurn(enabledAgain, {
    eventId: "om_fail", runId: "run_fail", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 11,
  });
  const failed = finalizeDialogueTurn(next.state, {
    runId: "run_fail", status: DIALOGUE_TURN_STATUS.FAILED,
    reason: "runtime_failed", now: NOW + 12,
  });
  assert.equal(failed.state.dialogue.status, DIALOGUE_STATUS.FAILED);
  assert.equal(failed.state.dialogue.stop_reason, "runtime_failed");

  const genericEnabled = setInteractionPolicyMode(failed.state, {
    mode: "dialogue", now: NOW + 20,
  }).state;
  const genericTurn = reserveDialogueTurn(genericEnabled, {
    eventId: "om_generic_fail", runId: "run_generic_fail", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 21,
  });
  const genericFailure = finalizeDialogueTurn(genericTurn.state, {
    runId: "run_generic_fail", status: DIALOGUE_TURN_STATUS.FAILED, now: NOW + 22,
  });
  assert.equal(genericFailure.state.dialogue.status, DIALOGUE_STATUS.FAILED);
  assert.equal(genericFailure.state.dialogue.stop_reason, DIALOGUE_REASON.RUN_FAILED);
});

test("Dialogue 时间预算与资源预算分别在 dispatch 前硬停止", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_budget" }, {
    bindingId: "binding_budget", now: NOW,
  }).state;
  const timed = setInteractionPolicyMode(base, {
    mode: "dialogue", now: NOW,
    budget: { max_rounds: 3, max_duration_ms: 10, max_resource_units: 3 },
  }).state;
  const tooLate = reserveDialogueTurn(timed, {
    eventId: "om_late", runId: "run_late", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 10,
  });
  assert.equal(tooLate.accepted, false);
  assert.equal(tooLate.reason, DIALOGUE_REASON.TIME_BUDGET);
  assert.equal(tooLate.state.dialogue.usage.rounds_started, 0);

  const resourceLimited = setInteractionPolicyMode(tooLate.state, {
    mode: "dialogue", now: NOW + 20,
    budget: { max_rounds: 3, max_duration_ms: 60_000, max_resource_units: 1 },
  }).state;
  const tooExpensive = reserveDialogueTurn(resourceLimited, {
    eventId: "om_expensive", runId: "run_expensive", localTargetId: "local",
    originChannelGenerationId: "generation", resourceUnits: 2, now: NOW + 21,
  });
  assert.equal(tooExpensive.accepted, false);
  assert.equal(tooExpensive.reason, DIALOGUE_REASON.RESOURCE_BUDGET);
  assert.equal(tooExpensive.state.dialogue.usage.resource_units_used, 0);
});

test("Dialogue 悬挂活动回合在截止时间后由下一人类事件收口", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_hung" }, {
    bindingId: "binding_hung", now: NOW,
  }).state;
  const enabled = setInteractionPolicyMode(base, {
    mode: "dialogue", now: NOW,
    budget: { max_rounds: 3, max_duration_ms: 10, max_resource_units: 3 },
  }).state;
  const hanging = reserveDialogueTurn(enabled, {
    eventId: "om_hanging", runId: "run_hanging", localTargetId: "local",
    originChannelGenerationId: "generation", runtimeTargetId: "live_session", now: NOW + 1,
  });
  const expired = reserveDialogueTurn(hanging.state, {
    eventId: "om_after_deadline", runId: "run_after_deadline", localTargetId: "local",
    originChannelGenerationId: "generation", now: NOW + 10,
  });
  assert.equal(expired.ok, true);
  assert.equal(expired.accepted, false);
  assert.equal(expired.reason, DIALOGUE_REASON.TIME_BUDGET);
  assert.equal(expired.state.dialogue.status, DIALOGUE_STATUS.COMPLETED);
  assert.equal(expired.state.dialogue.active_turn, null);
  assert.equal(expired.state.dialogue.last_turn.status, DIALOGUE_TURN_STATUS.CANCELLED);
  assert.equal(expired.state.dialogue.last_turn.reason, DIALOGUE_REASON.TIME_BUDGET);
});

test("切回 Mapping 是人工中止；Dialogue runRequest 不携带 runtime locator", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_e" }, {
    bindingId: "binding_e", now: NOW,
  }).state;
  const enabled = setInteractionPolicyMode(base, { mode: "dialogue", now: NOW }).state;
  const evaluation = applyInteractionPolicyToAdmission(
    evaluateMappingAdmission({ event: baseEvent, mapping: baseMapping, config, now: NOW }), enabled,
  );
  const reservation = reserveDialogueTurn(enabled, {
    eventId: evaluation.messageId, runId: "claim_dialogue", localTargetId: "local_opaque",
    originChannelGenerationId: "generation_opaque", runtimeTargetId: BOUND_SESSION, now: NOW + 1,
  });
  const outcome = handleDialoguePolicy({
    evaluation,
    claim: { ok: true, key: "claim_dialogue" },
    resolvedContext: { localTargetId: "local_opaque", originChannelGenerationId: "generation_opaque" },
    reservation,
  });
  assert.equal(outcome.disposition, "accepted");
  assert.equal(outcome.runRequest.policy.dialogue_id, reservation.reservation.dialogue_id);
  assert.equal(outcome.runRequest.policy.turn_index, 1);
  assert.equal(JSON.stringify(outcome.runRequest).includes(BOUND_SESSION), false);

  const stopped = setInteractionPolicyMode(reservation.state, { mode: "mapping", now: NOW + 2 });
  assert.equal(stopped.state.policy_id, "mapping");
  assert.equal(stopped.state.dialogue.status, DIALOGUE_STATUS.CANCELLED);
  assert.equal(stopped.state.dialogue.stop_reason, DIALOGUE_REASON.HUMAN_INTERRUPT);
  assert.equal(materializeInteractionPolicy({ binding_id: "binding_e" }, stopped.state).ok, true);
});

test("Dialogue 终局只能关闭匹配的 run/runtime target，损坏契约一律失败关闭", () => {
  const base = interactionPolicyStateForLegacy({ binding_id: "binding_guard" }, {
    bindingId: "binding_guard", now: NOW,
  }).state;
  const enabled = setInteractionPolicyMode(base, { mode: "dialogue", now: NOW }).state;
  const reserved = reserveDialogueTurn(enabled, {
    eventId: "om_guard", runId: "run_guard", localTargetId: "local",
    originChannelGenerationId: "generation", runtimeTargetId: "runtime_guard", now: NOW + 1,
  });
  const mismatch = finalizeDialogueTurn(reserved.state, {
    runId: "other_run", runtimeTargetId: "other_runtime",
    status: DIALOGUE_TURN_STATUS.COMPLETED, now: NOW + 2,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "dialogue_turn_mismatch");
  assert.equal(reserved.state.dialogue.active_turn.run_id, "run_guard");

  const damaged = structuredClone(reserved.state);
  damaged.dialogue.concurrency.max_active_turns = 2;
  assert.equal(interactionPolicySummary(damaged).reason, DIALOGUE_REASON.POLICY_INVALID);
});

// ---------- Dialogue Participant & Planner Foundation：只计算、不接 adapter ----------

const relaySnapshotFixture = ({ capturedAt = NOW, hostRuns = 8, peerRuns = 4 } = {}) => {
  const hostBinding = deriveDialogueBindingRef({
    runtimeNamespace: "claude", endpointId: "endpoint_host",
    privateBindingKey: "/private/projects/host-project@registry",
  }).bindingRef;
  const peerBinding = deriveDialogueBindingRef({
    runtimeNamespace: "codex", endpointId: "endpoint_peer",
    privateBindingKey: "/private/projects/peer-project@registry",
  }).bindingRef;
  const human = deriveDialogueParticipantRef({
    kind: "human", runtimeNamespace: "feishu", endpointId: "endpoint_host",
    privateIdentityKey: "private_sender",
  }).participantId;
  const host = deriveDialogueParticipantRef({
    kind: "agent", runtimeNamespace: "claude", endpointId: "endpoint_host",
    privateIdentityKey: "private_host_target",
  }).participantId;
  const peer = deriveDialogueParticipantRef({
    kind: "agent", runtimeNamespace: "codex", endpointId: "endpoint_peer",
    privateIdentityKey: "private_peer_target",
  }).participantId;
  return createParticipantAuthorizationSnapshot({
    authorizationRevision: 1, capturedAt, coordinatorBindingRef: hostBinding,
    participants: [
      { participant_id: human, kind: "human", roles: ["requester"],
        subscription_id: null, binding_ref: null, local_target_id: null,
        allowed_origins: ["human_event"], limits: { max_agent_runs: 1, resource_units_per_run: 1 } },
      { participant_id: host, kind: "agent", roles: ["host", "finalizer"],
        subscription_id: "subscription_aaaaaaaaaaaaaaaaaaaaaaaa", binding_ref: hostBinding,
        local_target_id: "target_aaaaaaaaaaaaaaaaaaaaaaaa",
        allowed_origins: ["human_event", "planner_relay"],
        limits: { max_agent_runs: hostRuns, resource_units_per_run: 1 } },
      { participant_id: peer, kind: "agent", roles: ["peer"],
        subscription_id: "subscription_bbbbbbbbbbbbbbbbbbbbbbbb", binding_ref: peerBinding,
        local_target_id: "target_bbbbbbbbbbbbbbbbbbbbbbbb", allowed_origins: ["planner_relay"],
        limits: { max_agent_runs: peerRuns, resource_units_per_run: 1 } },
    ],
  });
};

const finishRelayCycle = ({ state, snapshot, suffix, now }) => {
  const claimId = claimKey("human_" + suffix, "dialogue_relay");
  const generationId = "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa";
  const started = startRelayCycle(state, {
    snapshot, humanEventId: "human_" + suffix, parentHumanClaimId: claimId,
    originChannelGenerationId: generationId, now,
  });
  const hostTerminal = "terminal_host_" + suffix;
  const hostOutput = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId: started.runRequest.run_id,
    terminalEventId: hostTerminal,
  }).outputRef;
  const host = advanceRelayPlan(started.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: hostTerminal,
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: hostOutput, now: now + 1,
  });
  const peerTerminal = "terminal_peer_" + suffix;
  const peerOutput = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId: host.runRequest.run_id,
    terminalEventId: peerTerminal,
  }).outputRef;
  const peer = advanceRelayPlan(host.state, {
    snapshot, runId: host.runRequest.run_id, terminalEventId: peerTerminal,
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: peerOutput, now: now + 2,
  });
  const finalTerminal = "terminal_final_" + suffix;
  const finalOutput = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId: peer.runRequest.run_id,
    terminalEventId: finalTerminal,
  }).outputRef;
  const final = advanceRelayPlan(peer.state, {
    snapshot, runId: peer.runRequest.run_id, terminalEventId: finalTerminal,
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: finalOutput, now: now + 3,
  });
  return { started, host, peer, final, finalOutput };
};

test("Participant snapshot 使用跨 adapter 固定 opaque ref，不泄露私有 binding key", () => {
  const one = deriveDialogueBindingRef({
    runtimeNamespace: "claude", endpointId: "endpoint_a", privateBindingKey: "/secret/alpha@registry",
  });
  const same = deriveDialogueBindingRef({
    runtimeNamespace: "claude", endpointId: "endpoint_a", privateBindingKey: "/secret/alpha@registry",
  });
  const otherRuntime = deriveDialogueBindingRef({
    runtimeNamespace: "codex", endpointId: "endpoint_a", privateBindingKey: "/secret/alpha@registry",
  });
  assert.equal(one.ok, true);
  assert.equal(one.bindingRef, same.bindingRef);
  assert.notEqual(one.bindingRef, otherRuntime.bindingRef);
  assert.match(one.bindingRef, /^binding_ref_[0-9a-f]{24}$/u);
  assert.equal(one.bindingRef.includes("alpha"), false);

  const fixture = relaySnapshotFixture();
  assert.equal(fixture.ok, true);
  assert.equal(fixture.snapshot.artifact_type, PARTICIPANT_SNAPSHOT_ARTIFACT_TYPE);
  assert.equal(validateParticipantAuthorizationSnapshot(fixture.snapshot).ok, true);
  assert.equal(JSON.stringify(fixture.snapshot).includes("/private/projects"), false);

  const reordered = structuredClone(fixture.snapshot);
  reordered.participants = reordered.participants.map((participant) => ({
    limits: { resource_units_per_run: participant.limits.resource_units_per_run,
      max_agent_runs: participant.limits.max_agent_runs },
    allowed_origins: participant.allowed_origins, local_target_id: participant.local_target_id,
    binding_ref: participant.binding_ref, subscription_id: participant.subscription_id,
    roles: participant.roles, kind: participant.kind, participant_id: participant.participant_id,
  }));
  assert.equal(validateParticipantAuthorizationSnapshot(reordered).ok, true);
});

test("Relay planner 固定 host→peer→host finalizer，只有 finalizer 后等待人类", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const created = createRelayPlanState({ dialogueId: "dialogue_relay", snapshot, startedAt: NOW });
  assert.equal(created.ok, true);
  assert.deepEqual(created.state.budget, DEFAULT_RELAY_BUDGET);
  const cycle = finishRelayCycle({ state: created.state, snapshot, suffix: "one", now: NOW + 1 });
  assert.equal(cycle.started.disposition, RELAY_DISPOSITION.DISPATCH_ONE);
  assert.equal(cycle.started.runRequest.role, "host");
  assert.equal(cycle.host.runRequest.role, "peer");
  assert.equal(cycle.peer.runRequest.role, "finalizer");
  assert.equal(cycle.final.disposition, RELAY_DISPOSITION.WAIT_HUMAN);
  assert.equal(cycle.final.finalOutputRef, cycle.finalOutput);
  assert.equal(cycle.final.state.active_cycle, null);
  assert.equal(cycle.final.state.usage.cycles_started, 1);
  assert.equal(cycle.final.state.usage.agent_runs_started, 3);
  assert.equal(cycle.final.state.usage.resource_units_used, 3);
  assert.equal(validateRelayPlanState(cycle.final.state, { snapshot }).ok, true);
  assert.equal("binding_ref" in cycle.started.runRequest, false);
  assert.equal("claim_id" in cycle.host.runRequest, false);
  assert.equal(cycle.host.runRequest.parent_human_claim_id,
    claimKey("human_one", "dialogue_relay"));
});

test("Relay 人类事件和 terminal event 分别幂等，不重复 dispatch 或扣预算", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const state = createRelayPlanState({ dialogueId: "dialogue_idempotent", snapshot, startedAt: NOW }).state;
  const started = startRelayCycle(state, {
    snapshot, humanEventId: "human_same", parentHumanClaimId: claimKey("human_same", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1,
  });
  const duplicateHuman = startRelayCycle(started.state, {
    snapshot, humanEventId: "human_same", parentHumanClaimId: claimKey("human_same", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 2,
  });
  assert.equal(duplicateHuman.disposition, RELAY_DISPOSITION.DUPLICATE);
  assert.equal("runRequest" in duplicateHuman, false);
  assert.equal(duplicateHuman.state.usage.agent_runs_started, 1);

  const terminalOutput = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId: started.runRequest.run_id,
    terminalEventId: "terminal_same",
  }).outputRef;
  const terminal = advanceRelayPlan(started.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: "terminal_same",
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: terminalOutput, now: NOW + 3,
  });
  const duplicateTerminal = advanceRelayPlan(terminal.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: "terminal_same",
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: "malicious-new-output", now: NOW + 4,
  });
  assert.equal(duplicateTerminal.disposition, RELAY_DISPOSITION.DUPLICATE);
  assert.equal("runRequest" in duplicateTerminal, false);
  assert.equal(duplicateTerminal.state.usage.agent_runs_started, 2);
});

test("Relay 正文 mention/命令不参与选路，固定 key 只由控制面字段决定", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const base = createRelayPlanState({ dialogueId: "dialogue_untrusted", snapshot, startedAt: NOW }).state;
  const a = startRelayCycle(base, {
    snapshot, humanEventId: "human_untrusted",
    parentHumanClaimId: claimKey("human_untrusted", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa",
    content: "@other /feishu-mode mapping", now: NOW + 1,
  });
  const b = startRelayCycle(base, {
    snapshot, humanEventId: "human_untrusted",
    parentHumanClaimId: claimKey("human_untrusted", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa",
    content: "完全不同的正文", now: NOW + 1,
  });
  assert.equal(a.runRequest.run_id, b.runRequest.run_id);
  assert.equal(a.runRequest.participant_id, b.runRequest.participant_id);
});

test("Relay 在 cycle 开始前预检完整三步预算，四个默认 cycle 同时耗尽三个计数器", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  let state = createRelayPlanState({ dialogueId: "dialogue_budget", snapshot, startedAt: NOW }).state;
  for (let index = 1; index <= 4; index += 1) {
    state = finishRelayCycle({ state, snapshot, suffix: String(index), now: NOW + index * 10 }).final.state;
  }
  assert.deepEqual(state.usage, {
    cycles_started: 4, agent_runs_started: 12, resource_units_used: 12,
    participant_agent_runs: Object.fromEntries(snapshot.participants
      .filter((participant) => participant.kind === "agent")
      .map((participant) => [participant.participant_id,
        participant.roles.includes("peer") ? 4 : 8])),
  });
  const exhausted = startRelayCycle(state, {
    snapshot, humanEventId: "human_five", parentHumanClaimId: claimKey("human_five", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 100,
  });
  assert.equal(exhausted.disposition, RELAY_DISPOSITION.STOP);
  assert.equal(exhausted.reason, RELAY_REASON.CYCLE_BUDGET);
  assert.equal(exhausted.state.status, RELAY_PLAN_STATUS.COMPLETED);
  assert.equal(exhausted.state.usage.agent_runs_started, 12);
});

test("Relay deadline 的迟到终局只关闭当前 run，不再 dispatch peer", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const state = createRelayPlanState({
    dialogueId: "dialogue_deadline", snapshot, startedAt: NOW,
    budget: { max_cycles: 1, max_agent_runs: 3, max_duration_ms: 10, max_resource_units: 3 },
  }).state;
  const started = startRelayCycle(state, {
    snapshot, humanEventId: "human_deadline",
    parentHumanClaimId: claimKey("human_deadline", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1,
  });
  const lateOutput = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId: started.runRequest.run_id,
    terminalEventId: "terminal_deadline",
  }).outputRef;
  const late = advanceRelayPlan(started.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: "terminal_deadline",
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: lateOutput, now: NOW + 10,
  });
  assert.equal(late.disposition, RELAY_DISPOSITION.STOP);
  assert.equal(late.reason, RELAY_REASON.TIME_BUDGET);
  assert.equal(late.state.status, RELAY_PLAN_STATUS.COMPLETED);
  assert.equal(late.state.usage.agent_runs_started, 1);
  assert.equal("runRequest" in late, false);
  assert.equal(validateRelayPlanState(late.state, { snapshot }).ok, true);

  const expiredWhileActive = startRelayCycle(started.state, {
    snapshot, humanEventId: "human_after_deadline",
    parentHumanClaimId: claimKey("human_after_deadline", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 10,
  });
  assert.equal(expiredWhileActive.disposition, RELAY_DISPOSITION.STOP);
  assert.equal(expiredWhileActive.reason, RELAY_REASON.TIME_BUDGET);
  assert.equal(expiredWhileActive.state.last_cycle.steps[0].status,
    RELAY_STEP_STATUS.CANCELLED);
  assert.equal(validateRelayPlanState(expiredWhileActive.state, { snapshot }).ok, true);
});

test("Relay output ref 必须绑定当前 dialogue、run 与 terminal event", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const state = createRelayPlanState({
    dialogueId: "dialogue_output_authenticity", snapshot, startedAt: NOW,
  }).state;
  const started = startRelayCycle(state, {
    snapshot, humanEventId: "human_output_authenticity",
    parentHumanClaimId: claimKey("human_output_authenticity", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1,
  });
  const forged = advanceRelayPlan(started.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: "terminal_authenticity",
    status: RELAY_STEP_STATUS.COMPLETED,
    outputRef: "output_ref_ffffffffffffffffffffffff", now: NOW + 2,
  });
  assert.equal(forged.state.status, RELAY_PLAN_STATUS.FAILED);
  assert.equal(forged.reason, RELAY_REASON.OUTPUT_REF_INVALID);
  assert.equal(forged.state.last_cycle.steps[0].output_ref, null);
  assert.equal(validateRelayPlanState(forged.state, { snapshot }).ok, true);
});

test("Relay runtime/空终局硬失败，授权撤销则是 cancelled", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const base = createRelayPlanState({ dialogueId: "dialogue_failure", snapshot, startedAt: NOW }).state;
  const started = startRelayCycle(base, {
    snapshot, humanEventId: "human_failure",
    parentHumanClaimId: claimKey("human_failure", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1,
  });
  const empty = advanceRelayPlan(started.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: "terminal_empty",
    status: RELAY_STEP_STATUS.COMPLETED, outputRef: "", now: NOW + 2,
  });
  assert.equal(empty.state.status, RELAY_PLAN_STATUS.FAILED);
  assert.equal(empty.reason, RELAY_REASON.EMPTY_OUTPUT);

  const active = startRelayCycle(createRelayPlanState({
    dialogueId: "dialogue_revoke", snapshot, startedAt: NOW,
  }).state, {
    snapshot, humanEventId: "human_revoke",
    parentHumanClaimId: claimKey("human_revoke", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1,
  });
  const revoked = cancelRelayPlan(active.state, {
    snapshot, reason: RELAY_REASON.AUTHORIZATION_REVOKED, now: NOW + 2,
  });
  assert.equal(revoked.state.status, RELAY_PLAN_STATUS.CANCELLED);
  assert.equal(revoked.state.stop_reason, RELAY_REASON.AUTHORIZATION_REVOKED);
  assert.equal(revoked.state.last_cycle.steps[0].status, RELAY_STEP_STATUS.CANCELLED);

  const runtimeCancelled = advanceRelayPlan(active.state, {
    snapshot, runId: active.runRequest.run_id, terminalEventId: "terminal_cancelled",
    status: RELAY_STEP_STATUS.CANCELLED, now: NOW + 2,
  });
  assert.equal(runtimeCancelled.state.status, RELAY_PLAN_STATUS.CANCELLED);
  assert.equal(runtimeCancelled.state.stop_reason, RELAY_REASON.HUMAN_INTERRUPT);
  assert.equal(runtimeCancelled.state.last_cycle.steps[0].reason, RELAY_REASON.HUMAN_INTERRUPT);
  assert.equal(validateRelayPlanState(runtimeCancelled.state, { snapshot }).ok, true);
});

test("Relay state 中 target、步骤顺序或 deterministic run key 被篡改时 fail-closed", () => {
  const snapshot = relaySnapshotFixture().snapshot;
  const base = createRelayPlanState({ dialogueId: "dialogue_tamper", snapshot, startedAt: NOW }).state;
  const started = startRelayCycle(base, {
    snapshot, humanEventId: "human_tamper",
    parentHumanClaimId: claimKey("human_tamper", "dialogue"),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1,
  });
  const runTampered = structuredClone(started.state);
  runTampered.active_cycle.steps[0].run_id = "relay_run_ffffffffffffffffffffffff";
  assert.equal(validateRelayPlanState(runTampered, { snapshot }).reason, RELAY_REASON.INVALID_STATE);

  const claimTampered = structuredClone(started.state);
  claimTampered.processed_human_events[0].parent_human_claim_id = "not-a-claim";
  assert.equal(validateRelayPlanState(claimTampered, { snapshot }).reason,
    RELAY_REASON.INVALID_STATE);

  const targetTampered = structuredClone(snapshot);
  targetTampered.participants.find((item) => item.roles.includes("host")).local_target_id =
    "target_ffffffffffffffffffffffff";
  assert.equal(validateRelayPlanState(started.state, { snapshot: targetTampered }).reason,
    RELAY_REASON.INVALID_STATE);
});

test("Participant schema 与离线 simulator 可复现三步计划且不产生控制面文件", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-participant-snapshot-v1.schema.json"), "utf-8"));
  const planSchema = JSON.parse(fs.readFileSync(path.resolve("references",
    "dialogue-relay-plan-v1.schema.json"), "utf-8"));
  assert.equal(schema.properties.artifact_type.const, PARTICIPANT_SNAPSHOT_ARTIFACT_TYPE);
  assert.ok(schema.required.includes("coordinator_binding_ref"));
  assert.equal(planSchema.properties.policy_version.const, "2.0");
  assert.equal(planSchema.properties.processed_terminal_events.maxItems, 256);

  const local = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-planner-simulator-"));
  const input = path.join(local, "fixture.json");
  fs.writeFileSync(input, JSON.stringify({
    snapshot: relaySnapshotFixture().snapshot,
    dialogue_id: "dialogue_simulator",
    started_at: NOW,
    events: [
      { type: "human", event_id: "human_sim", claim_id: "a".repeat(64),
        origin_channel_generation_id: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa", now: NOW + 1 },
      { type: "terminal", run_id: "$active", terminal_event_id: "terminal_sim_1",
        derive_output_ref: true, now: NOW + 2 },
      { type: "terminal", run_id: "$active", terminal_event_id: "terminal_sim_2",
        derive_output_ref: true, now: NOW + 3 },
      { type: "terminal", run_id: "$active", terminal_event_id: "terminal_sim_3",
        derive_output_ref: true, now: NOW + 4 },
    ],
  }));
  const run = spawnSync(process.execPath, [path.resolve("scripts", "simulate-dialogue-planner.mjs"),
    "--input", input], { encoding: "utf-8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.state.usage.agent_runs_started, 3);
  assert.equal(result.results.at(-1).disposition, RELAY_DISPOSITION.WAIT_HUMAN);
  assert.deepEqual(fs.readdirSync(local), ["fixture.json"]);
});

test("Claude registry binding 原子保存 Dialogue 模式、回合与终局", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-policy-claude-"));
  const root = path.join(local, "project");
  fs.mkdirSync(root);
  const regFile = path.join(local, "registry.json");
  fs.writeFileSync(regFile, JSON.stringify({ schema_version: "1.0", projects: [{
    id: "dialogue-claude", root, root_message_id: "om_root", session_id: "session_feishu",
    status: "active", expires_at: "2027-01-01T00:00:00.000Z",
  }] }));
  const enabled = setClaudeInteractionMode({
    root, mode: "dialogue", registryFile: regFile, now: NOW,
  });
  assert.equal(enabled.ok, true);
  const reserved = reserveClaudeDialogueTurn({
    root, eventId: "om_dialogue", runId: "claim_dialogue", localTargetId: "local_target",
    originChannelGenerationId: "generation", runtimeTargetId: "claude_session_private",
    registryFile: regFile, now: NOW + 1,
  });
  assert.equal(reserved.accepted, true);
  const finished = finalizeClaudeDialogueTurn({
    root, runId: "claim_dialogue", status: DIALOGUE_TURN_STATUS.COMPLETED,
    registryFile: regFile, now: NOW + 2,
  });
  assert.equal(finished.ok, true);
  const loaded = loadClaudeInteractionPolicy({ root, registryFile: regFile, now: NOW + 3 });
  assert.equal(loaded.state.policy_id, "dialogue");
  assert.equal(loaded.state.dialogue.active_turn, null);
  assert.equal(loaded.state.dialogue.usage.rounds_started, 1);
  assert.equal(JSON.parse(fs.readFileSync(regFile, "utf-8"))
    .projects[0].interaction_policy_state.dialogue.last_turn.status, "completed");
});

test("Claude feishu-mode 默认只读，只有 --apply 才切换当前 binding", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-mode-claude-"));
  const root = path.join(fs.realpathSync(local), "project");
  fs.mkdirSync(root);
  const regFile = path.join(local, "registry.json");
  fs.writeFileSync(regFile, JSON.stringify({ schema_version: "1.0", projects: [{
    id: "dialogue-mode", root, root_message_id: "om_root", session_id: "session_feishu",
    status: "active", expires_at: "2027-01-01T00:00:00.000Z",
  }] }));
  const cli = path.resolve("scripts", "feishu-mode.mjs");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: "utf-8",
    env: { ...process.env, FEISHU_BRIDGE_REGISTRY: regFile },
  });
  assert.match(run().stdout, /Mapping/u);
  assert.match(run("--mode", "dialogue").stdout, /dry-run/u);
  assert.equal(JSON.parse(fs.readFileSync(regFile, "utf-8")).projects[0].interaction_policy_state, undefined);
  const applied = run("--mode", "dialogue", "--apply");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(fs.readFileSync(regFile, "utf-8")).projects[0]
    .interaction_policy_state.policy_id, "dialogue");
});

test("损坏的 Canonical Event 只记 shadow，无权否决合法的旧 selector 结果", () => {
  const evaluation = evaluateMappingAdmission({
    canonicalEvent: {}, event: baseEvent, mapping: baseMapping, config, now: NOW,
  });
  assert.equal(evaluation.decision, "accept");
  assert.equal(evaluation.instruction, "把出站发布器的草稿写完");
  assert.equal(evaluation.evaluation_path, "legacy_event_v2");
  assert.equal(evaluation.admission_shadow.match, false);
  assert.equal(evaluation.admission_shadow.candidate_decision, "invalid");
  assert.equal(evaluation.admission_shadow.candidate_reason, "canonical_invalid");
});

test("前缀后多个空格也能接受", () => {
  const r = evalWith({ content: at(M5CLAUDE) + " →Claude  桥接长期任务" + QUOTE });
  assert.equal(r.decision, "accept");
  assert.equal(r.instruction, "桥接长期任务");
});

// ---------- selector：拒绝路径（安全关键） ----------

const rejects = [
  ["mapping 为 null", () => evaluateInbound({ event: baseEvent, mapping: null, config, now: NOW }), REJECT.MAPPING_MISSING],
  ["mapping 非 active", () => evalWith({}, { status: "closed" }), REJECT.MAPPING_NOT_ACTIVE],
  ["mapping 已过期", () => evalWith({}, { expires_at: "2026-08-19T09:00:00Z" }), REJECT.MAPPING_EXPIRED],
  ["mapping 缺 expires_at", () => evalWith({}, { expires_at: undefined }), REJECT.MAPPING_EXPIRED],
  ["不在绑定话题（别的 session）", () => evalWith({ session_id: "session_other" }), REJECT.SESSION_MISMATCH],
  ["发送者不是 Frank", () => evalWith({ sender_id: "9999999999" }), REJECT.SENDER_NOT_FRANK],
  ["没有 mention", () => evalWith({ content: "→Claude 干活" }), REJECT.TRANSPORT_NOT_MENTIONED],
  ["@ 的是另一条链路的 M5Codex", () => evalWith({ content: at(M5CODEX) + " →Claude 干活" }), REJECT.TRANSPORT_NOT_MENTIONED],
  ["前缀不符", () => evalWith({ content: at(M5CLAUDE) + " 帮我看一下" }), REJECT.PREFIX_MISMATCH],
  ["用了 →Codex 前缀", () => evalWith({ content: at(M5CLAUDE) + " →Codex 干活" }), REJECT.PREFIX_MISMATCH],
  ["前缀后没有正文", () => evalWith({ content: at(M5CLAUDE) + " →Claude   " }), REJECT.EMPTY_INSTRUCTION],
  ["重复消息", () => evalWith({}, { consumed_message_ids: ["msg_1"] }), REJECT.DUPLICATE_MESSAGE],
  ["配额用尽", () => evalWith({}, { consumed_message_ids: ["a","b","c","d","e"] }), REJECT.QUOTA_EXHAUSTED],
  ["超出时效窗口", () => evalWith({ created_at_ms: NOW - 20 * 60 * 1000 }), REJECT.STALE_MESSAGE],
  ["缺 message_id", () => evalWith({ message_id: undefined }), REJECT.MALFORMED_EVENT],
  ["缺 session_id", () => evalWith({ session_id: undefined }), REJECT.MALFORMED_EVENT],
  ["缺 sender_id", () => evalWith({ sender_id: undefined }), REJECT.MALFORMED_EVENT],
  ["created_at_ms 不是数字", () => evalWith({ created_at_ms: "nope" }), REJECT.MALFORMED_EVENT],
];

for (const [name, fn, expected] of rejects) {
  test(`拒绝：${name}`, () => {
    const r = fn();
    assert.equal(r.decision, "reject", `应当拒绝但返回了 ${r.decision}`);
    assert.equal(r.reason, expected);
    assert.ok(r.reasonText && r.reasonText.length > 0, "拒绝必须带人类可读原因");
  });
}

test("手打的 @M5Claude 文本不构成 mention", () => {
  const r = evalWith({ content: "@M5Claude →Claude 干活" });
  assert.equal(r.reason, REJECT.TRANSPORT_NOT_MENTIONED);
});

test("引用块里出现前缀不能顶替正文前缀", () => {
  const r = evalWith({ content: at(M5CLAUDE) + " 随便说说\n\n**[引用]**\n→Claude 这是引用里的" });
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, REJECT.PREFIX_MISMATCH);
});

test("mapping 缺 max_inbound_messages → 拒绝，不 fail-open", () => {
  const r = evalWith({}, { max_inbound_messages: undefined });
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, REJECT.MALFORMED_EVENT, "缺配额上限必须拒绝，不能当成无上限");
});

test("mapping 缺 freshness 且 config 也没有 → 拒绝，不 fail-open", () => {
  const r = evaluateInbound({
    event: baseEvent, mapping: { ...baseMapping, freshness_ms: undefined },
    config: { transport_open_id: M5CLAUDE }, now: NOW,
  });
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, REJECT.MALFORMED_EVENT, "缺时效窗口必须拒绝，不能当成无限期有效");
});

test("配额为 0 或负数 → 拒绝", () => {
  assert.equal(evalWith({}, { max_inbound_messages: 0 }).reason, REJECT.MALFORMED_EVENT);
});

// ---------- 配额闸退役：无限必须是明写的，不能是配错的副作用 ----------

test("max_inbound_messages: \"unlimited\" → 放行，且不受已消费条数影响", () => {
  const many = Array.from({ length: 9999 }, (_, i) => "msg_old_" + i);
  const r = evalWith({}, { max_inbound_messages: "unlimited", consumed_message_ids: many });
  assert.equal(r.decision, "accept", "显式无限时次数闸应当整个不参与判断");
});

test("无限配额不影响其他闸：过期照样拒", () => {
  const r = evalWith({}, { max_inbound_messages: "unlimited", expires_at: "2026-08-19T09:00:00Z" });
  assert.equal(r.reason, REJECT.MAPPING_EXPIRED, "关掉次数闸不等于关掉有效期闸");
});

test("无限配额不影响幂等：重复消息照样拒", () => {
  const r = evalWith({}, { max_inbound_messages: "unlimited", consumed_message_ids: ["msg_1"] });
  assert.equal(r.reason, REJECT.DUPLICATE_MESSAGE);
});

for (const bad of ["Unlimited", "UNLIMITED", "infinite", "none", "", true, null, -1, 2.5, "20"]) {
  test("配额写成 " + JSON.stringify(bad) + " → 判配错，不放行", () => {
    const r = evalWith({}, { max_inbound_messages: bad });
    assert.equal(r.decision, "reject", "只认字面量 unlimited 或正整数；写错必须是事故");
    assert.equal(r.reason, REJECT.MALFORMED_EVENT);
  });
}

test("配额 true 不得被强制转成 1（回归：布尔笔误悄悄改掉准入条件）", () => {
  const r = evalWith({}, { max_inbound_messages: true, consumed_message_ids: [] });
  assert.equal(r.reason, REJECT.MALFORMED_EVENT, "Number(true)===1 会让它变成「配额 1 条」而不是配错");
});

test("时效窗口写成非数字 → 判配错", () => {
  assert.equal(evalWith({}, { freshness_ms: "900000" }).reason, REJECT.MALFORMED_EVENT);
  assert.equal(evalWith({}, { freshness_ms: true }).reason, REJECT.MALFORMED_EVENT);
});

// ---------- 前缀闸退役：关掉必须是明写的 ----------

test("inbound_prefix: null → 不要前缀，整段正文都是指令", () => {
  const r = evalWith({ content: at(M5CLAUDE) + " 把出站发布器的草稿写完" }, { inbound_prefix: null });
  assert.equal(r.decision, "accept", "明写 null 时前缀闸应当整个不参与判断");
  assert.equal(r.instruction, "把出站发布器的草稿写完");
});

test("关掉前缀后，带着旧前缀发也照样能用（不会把前缀当指令切掉）", () => {
  const r = evalWith({}, { inbound_prefix: null });
  assert.equal(r.decision, "accept");
  assert.equal(r.instruction, "→Claude 把出站发布器的草稿写完", "整段正文都是指令，不猜哪段是前缀");
});

test("关掉前缀不影响其他闸：不是 Frank 照样拒", () => {
  assert.equal(evalWith({ sender_id: "9999" }, { inbound_prefix: null }).reason, REJECT.SENDER_NOT_FRANK);
});

test("关掉前缀不影响 mention 闸 —— 这是替代前缀的那道闸，绝不能一起松", () => {
  const r = evalWith({ content: at(M5CODEX) + " 干活" }, { inbound_prefix: null });
  assert.equal(r.reason, REJECT.TRANSPORT_NOT_MENTIONED);
});

test("关掉前缀后，只 @ 不说话 → 空指令，不投递", () => {
  const r = evalWith({ content: at(M5CLAUDE) + "   " }, { inbound_prefix: null });
  assert.equal(r.reason, REJECT.EMPTY_INSTRUCTION);
});

for (const bad of [undefined, "", "   ", 0, false, 123, [], {}]) {
  test("前缀写成 " + JSON.stringify(bad) + " → 判配错，不当成「关掉了」", () => {
    const r = evalWith({}, { inbound_prefix: bad });
    assert.equal(r.decision, "reject");
    assert.equal(r.reason, REJECT.MALFORMED_EVENT,
      "只有明写 null 才算关；配漏了不能等同于关掉");
  });
}

test("写配置的一方和读配置的一方共用同一条前缀规则", () => {
  assert.equal(isValidPrefix(null), true);
  assert.equal(isValidPrefix("→Claude"), true);
  for (const v of [undefined, "", "  ", 0, false, 123, [], {}]) {
    assert.equal(isValidPrefix(v), false, JSON.stringify(v) + " 不该被判合法");
  }
});

// ---------- claim：原子性与幂等 ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-test-"));
const claimsDir = path.join(tmp, "delivery-claims");
fs.mkdirSync(claimsDir, { recursive: true });

test("claims 父目录不存在时自动创建（全新部署首条不该失败）", () => {
  const fresh = path.join(tmp, "brand-new", "delivery-claims");
  const r = acquireClaim({ claimsDir: fresh, messageId: "msg_first", logicalTaskKey: "k", meta: {} });
  assert.equal(r.ok, true, "全新部署的第一条消息必须能拿到 claim");
});

test("首次 claim 成功", () => {
  const r = acquireClaim({ claimsDir, messageId: "msg_a", logicalTaskKey: "k", meta: {} });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(r.dir, "claim.json")));
});

test("同一消息二次 claim 被拒为 duplicate", () => {
  const r = acquireClaim({ claimsDir, messageId: "msg_a", logicalTaskKey: "k", meta: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate");
});

test("不同 logical_task_key 视为不同 claim", () => {
  assert.equal(acquireClaim({ claimsDir, messageId: "msg_a", logicalTaskKey: "k2", meta: {} }).ok, true);
});

test("claim key 对同一组输入稳定", () => {
  assert.equal(claimKey("msg_x", "k"), claimKey("msg_x", "k"));
  assert.notEqual(claimKey("msg_x", "k"), claimKey("msg_y", "k"));
});

test("被拒消息不留下半成品 claim", () => {
  const before = fs.readdirSync(claimsDir).length;
  assert.equal(evalWith({ content: at(M5CLAUDE) + " 普通回复" }).decision, "reject");
  assert.equal(fs.readdirSync(claimsDir).length, before, "拒绝路径不得创建 claim");
});

test("handed_off 是终态记录，不代表任务完成", () => {
  const k = claimKey("msg_a", "k");
  const f = recordClaimState({ claimsDir, key: k, state: "handed_off", detail: { target: "t" } });
  const rec = JSON.parse(fs.readFileSync(f, "utf-8"));
  assert.equal(rec.state, "handed_off");
  assert.ok(!("completed" in rec), "claim 层不得出现完成语义");
});

// ---------- 会话锁：陈旧回收（回归 2026-08-19 修复的死锁缺陷） ----------

const lockDir = path.join(tmp, "session.lock");

test("首次取锁成功", () => {
  assert.equal(acquireSessionLock(lockDir).ok, true);
});

test("活着的持有者会挡住第二次取锁", () => {
  stampSessionLock(lockDir, { pid: process.pid, logPath: path.join(tmp, "nope.jsonl") });
  const r = acquireSessionLock(lockDir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "session_busy");
});

test("持有者进程已死 → 锁被判为陈旧并回收", () => {
  // 用一个几乎不可能存活的 pid；若碰巧存在则跳过而不是误报
  stampSessionLock(lockDir, { pid: 999999, logPath: path.join(tmp, "nope.jsonl") });
  let alive = true;
  try { process.kill(999999, 0); } catch { alive = false; }
  if (!alive) assert.equal(acquireSessionLock(lockDir).ok, true);
});

test("run 已完成 → 即使进程还在也判为陈旧", () => {
  releaseSessionLock(lockDir);
  assert.equal(acquireSessionLock(lockDir).ok, true);
  const doneLog = path.join(tmp, "done.jsonl");
  fs.writeFileSync(doneLog, JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\n");
  stampSessionLock(lockDir, { pid: process.pid, logPath: doneLog });
  assert.equal(acquireSessionLock(lockDir).ok, true, "已完成的 run 不该继续占锁");
});

test("owner.json 不可读 → 判为陈旧，不永久死锁", () => {
  releaseSessionLock(lockDir);
  fs.mkdirSync(lockDir, { recursive: true });
  assert.equal(acquireSessionLock(lockDir).ok, true);
});

releaseSessionLock(lockDir);

// ---------- run 结局判定 ----------

test("没有 result 行 → running，不得判失败", () => {
  const f = path.join(tmp, "partial.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "assistant" }) + "\n");
  assert.equal(readRunOutcome(f).state, "running");
});

test("半截 JSON 行不影响判定", () => {
  const f = path.join(tmp, "torn.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "result", is_error: false, result: "done" }) + "\n{\"type\":\"assi");
  assert.equal(readRunOutcome(f).state, "completed");
});

test("result 存在但最终输出为空 → failed", () => {
  const f = path.join(tmp, "empty.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "result", is_error: false, result: "   " }) + "\n");
  assert.equal(readRunOutcome(f).state, "failed");
});

test("is_error 为真 → failed", () => {
  const f = path.join(tmp, "err.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "result", is_error: true, result: "boom" }) + "\n");
  assert.equal(readRunOutcome(f).state, "failed");
});

test("权限被拦 → blocked，绝不判 completed（回归：误判成功）", () => {
  const f = path.join(tmp, "denied.jsonl");
  fs.writeFileSync(f, JSON.stringify({
    type: "result", is_error: false,
    result: "写入被权限拦下了，我没法完成。",
    permission_denials: [{ tool_name: "Write", tool_input: {} }],
  }) + "\n");
  const r = readRunOutcome(f);
  assert.equal(r.state, "blocked", "权限被拦的 run 不得判为 completed");
  assert.deepEqual(r.deniedTools, ["Write"]);
});

test("没有 denials 的正常完成仍判 completed", () => {
  const f = path.join(tmp, "clean.jsonl");
  fs.writeFileSync(f, JSON.stringify({
    type: "result", is_error: false, result: "干完了", permission_denials: [],
  }) + "\n");
  assert.equal(readRunOutcome(f).state, "completed");
});

test("日志文件不存在 → missing，不崩", () => {
  assert.equal(readRunOutcome(path.join(tmp, "nothing.jsonl")).state, "missing");
});

// ---------- 登记表 ----------

const regDir = path.join(tmp, "registry");
fs.mkdirSync(regDir, { recursive: true });
const writeRegistry = (name, obj) => {
  const f = path.join(regDir, name);
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  return f;
};

test("登记表不存在 → 空表，且不算错误（本机没接桥是常态）", () => {
  const r = loadRegistry(path.join(regDir, "absent.json"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects, []);
});

test("登记表是坏 JSON → 报错，不当成空表", () => {
  const r = loadRegistry(writeRegistry("broken.json", "{ not json"));
  assert.equal(r.ok, false, "坏掉的表必须说出来，静默当空表会让出站无声消失");
  assert.equal(r.reason, "bad_json");
});

test("enabled:false 的项目被排除", () => {
  const r = loadRegistry(writeRegistry("mixed.json", {
    projects: [{ id: "on", root: "/a/on" }, { id: "off", root: "/a/off", enabled: false }],
  }));
  assert.deepEqual(r.projects.map((p) => p.id), ["on"]);
});

test("root 尾斜杠被归一化，缺 root 的条目被丢弃", () => {
  const r = loadRegistry(writeRegistry("slash.json", {
    projects: [{ id: "a", root: "/a/proj/" }, { id: "bad" }],
  }));
  assert.deepEqual(r.projects.map((p) => p.root), ["/a/proj"]);
});

test("isUnder 不把同前缀的兄弟目录算进来", () => {
  assert.equal(isUnder("/a/proj", "/a/proj"), true);
  assert.equal(isUnder("/a/proj/sub", "/a/proj"), true);
  assert.equal(isUnder("/a/project-other", "/a/proj"), false, "同前缀不等于在目录下");
  assert.equal(isUnder(undefined, "/a/proj"), false);
});

// ---------- 归属判定 ----------

const P1 = { id: "p1", root: path.join(tmp, "p1") };
const P2 = { id: "p2", root: path.join(tmp, "p2") };

test("cwd 在项目里 → 归属该项目", () => {
  const r = attributeSession({ projects: [P1, P2], cwd: path.join(P1.root, "scripts"), transcriptPath: null });
  assert.deepEqual(r.map((x) => x.id), ["p1"]);
  assert.deepEqual(r[0].via, ["cwd"]);
});

test("cwd 在别处但会话记录里出现过项目路径 → 仍归属（会话可能起在任何地方）", () => {
  const t = path.join(tmp, "transcript.jsonl");
  fs.writeFileSync(t, JSON.stringify({ type: "user", text: "cd " + P2.root + " && node scripts/x.mjs" }) + "\n");
  const r = attributeSession({ projects: [P1, P2], cwd: "/somewhere/else", transcriptPath: t });
  assert.deepEqual(r.map((x) => x.id), ["p2"]);
  assert.deepEqual(r[0].via, ["transcript"]);
});

test("会话既没在项目里也没提过它 → 不归属", () => {
  const t = path.join(tmp, "unrelated.jsonl");
  fs.writeFileSync(t, "完全无关的内容\n");
  assert.deepEqual(attributeSession({ projects: [P1, P2], cwd: "/tmp", transcriptPath: t }), []);
});

test("会话记录不存在 → 不崩，只是判不出归属", () => {
  const r = attributeSession({ projects: [P1], cwd: "/tmp", transcriptPath: path.join(tmp, "nope.jsonl") });
  assert.deepEqual(r, []);
});

test("路径正好跨在分块边界上也能命中（回归：分块读漏匹配）", () => {
  const t = path.join(tmp, "big.jsonl");
  const pad = "x".repeat(1000);
  fs.writeFileSync(t, pad + P1.root + pad);
  const hits = fileContainsAny(t, [P1.root], { chunkSize: 1000 + 5 });
  assert.deepEqual(hits, [P1.root], "重叠窗口必须覆盖被切断的路径");
});

// ---------- 发布锁 ----------

const pubLock = path.join(tmp, "publish.lock");

test("首次取发布锁成功", () => {
  assert.equal(acquirePublishLock(pubLock).ok, true);
});

test("活着的发布者挡住第二次取锁（防重复打扰）", () => {
  const r = acquirePublishLock(pubLock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "publisher_busy");
});

test("持有者进程已死 → 发布锁被判陈旧并回收", () => {
  fs.writeFileSync(path.join(pubLock, "owner.json"),
    JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  let alive = true;
  try { process.kill(999999, 0); } catch { alive = false; }
  if (!alive) assert.equal(acquirePublishLock(pubLock).ok, true);
});

test("持有者还活着但锁太老 → 也判陈旧，不永久堵住出站", () => {
  releasePublishLock(pubLock);
  assert.equal(acquirePublishLock(pubLock).ok, true);
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(pubLock, "owner.json"), JSON.stringify({ pid: process.pid, at: old }));
  assert.equal(acquirePublishLock(pubLock).ok, true);
});

releasePublishLock(pubLock);

// ---------- outbox 记录纪律 ----------

const obDir = path.join(tmp, "ob", ".runtime-data", "outbound", "outbox");

test("五类之外的 kind 一律不收", () => {
  const r = appendEvent({ outboxDir: obDir, kind: "note", text: "随便说说", source: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_kind");
});

test("同一条进展重复记录被判重，不重复打扰", () => {
  assert.equal(appendEvent({ outboxDir: obDir, kind: "risk", text: "同一件事", source: "t" }).ok, true);
  const again = appendEvent({ outboxDir: obDir, kind: "risk", text: "同一件事", source: "t" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "duplicate");
});

test("摘要按五类分组，已发的不再出现在 pending 里", () => {
  appendEvent({ outboxDir: obDir, kind: "milestone", text: "做完了一件", source: "t" });
  const pending = listPending({ outboxDir: obDir });
  assert.equal(pending.length, 2);
  const text = composeDigest(pending, { taskName: "T" });
  assert.ok(text.includes("【里程碑】") && text.includes("【风险】"));
  for (const r of pending) markSent(r, "om_test");
  assert.equal(listPending({ outboxDir: obDir }).length, 0);
});

// ---------- 排空：所有不该发的路径 ----------

const proj = path.join(tmp, "proj");
const projOutbox = path.join(proj, ".runtime-data", "outbound", "outbox");
const projInbound = path.join(proj, ".runtime-data", "inbound");

test("outbox 为空 → empty，且不去读配置（配置根本不存在也不该报错）", () => {
  const r = drainProject({ root: proj });
  assert.equal(r.status, "empty");
});

test("有待发内容但根本没接桥 → error not_bound，绝不静默丢弃", () => {
  appendEvent({ outboxDir: projOutbox, kind: "next", text: "待发一条", source: "t" });
  const r = drainProject({ root: proj });
  assert.equal(r.status, "error");
  // 「哪儿都没有绑定」和「绑定在但读不出来」必须是两个原因：
  // 前者是没接，后者是接了但坏了，排查方向完全不同。
  assert.equal(r.reason, "not_bound");
});

test("绑定文件在但是坏 JSON → config_unreadable，跟没接桥区分开", () => {
  fs.mkdirSync(projInbound, { recursive: true });
  fs.writeFileSync(path.join(projInbound, "active-mapping.json"), "{ 这不是 json");
  const r = drainProject({ root: proj });
  assert.equal(r.status, "error");
  assert.equal(r.reason, "config_unreadable");
  fs.rmSync(path.join(projInbound, "active-mapping.json"));
});

test("绑定不是 active → skipped，进展留在本地", () => {
  fs.mkdirSync(projInbound, { recursive: true });
  fs.writeFileSync(path.join(projInbound, "chain-config.json"),
    JSON.stringify({ task_display_name: "T", lark_cli_profile: "claude" }));
  fs.writeFileSync(path.join(projInbound, "active-mapping.json"),
    JSON.stringify({ status: "closed", feishu_root_message_id_reference: "om_x" }));
  const r = drainProject({ root: proj });
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "mapping_not_active");
  assert.equal(r.count, 1, "被跳过的条目必须仍然待发");
  assert.equal(listPending({ outboxDir: projOutbox }).length, 1);
});

test("dry-run 出摘要但不标记已发", () => {
  fs.writeFileSync(path.join(projInbound, "active-mapping.json"),
    JSON.stringify({ status: "active", feishu_root_message_id_reference: "om_x" }));
  const r = drainProject({ root: proj, dryRun: true });
  assert.equal(r.status, "dry_run");
  assert.ok(r.text.includes("待发一条"));
  assert.equal(listPending({ outboxDir: projOutbox }).length, 1, "dry-run 不得标记已发");
});

test("已有发布者在排空 → 让路，不并发发送", () => {
  const lock = path.join(proj, ".runtime-data", "outbound", "publish.lock");
  assert.equal(acquirePublishLock(lock).ok, true);
  const r = drainProject({ root: proj });
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "publisher_busy");
  releasePublishLock(lock);
});

// ---------- 让给守望者 ----------

test("没有守望者 → 会话结束钩子自己排空", () => {
  assert.equal(watcherActive(proj), false);
});

test("守望者活着 → 让给它发（否则一次指令会收到三条消息）", () => {
  const sl = path.join(projInbound, "session.lock");
  assert.equal(acquireSessionLock(sl).ok, true);
  stampSessionLock(sl, { pid: process.pid, logPath: path.join(tmp, "never.jsonl") });
  assert.equal(watcherActive(proj), true);
  releaseSessionLock(sl);
});

test("守望者的 run 已收场 → 锁是陈旧的，不该再让路", () => {
  const sl = path.join(projInbound, "session.lock");
  const done = path.join(tmp, "watch-done.jsonl");
  fs.writeFileSync(done, JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\n");
  assert.equal(acquireSessionLock(sl).ok, true);
  stampSessionLock(sl, { pid: process.pid, logPath: done });
  assert.equal(watcherActive(proj), false, "陈旧的会话锁不该让进展卡住");
  releaseSessionLock(sl);
});

// ---------- 绑定到期预警（配额闸退役后，有效期是唯一的闸） ----------

const bh = path.join(tmp, "bh");
fs.mkdirSync(path.join(bh, ".runtime-data", "inbound"), { recursive: true });
const setExpiry = (v) => fs.writeFileSync(
  path.join(bh, ".runtime-data", "inbound", "active-mapping.json"),
  JSON.stringify({ status: "active", expires_at: v }));
const daysOut = (n) => new Date(NOW + n * 24 * 60 * 60 * 1000).toISOString();

test("离到期还早 → 不打扰", () => {
  setExpiry(daysOut(200));
  const h = checkBinding({ root: bh, now: NOW });
  assert.equal(h.state, "ok");
  assert.equal(bindingWarning(h), null);
});

test("进 30 天窗口 → 记一条待拍板", () => {
  setExpiry(daysOut(20));
  const h = checkBinding({ root: bh, now: NOW });
  assert.equal(h.state, "expiring");
  assert.equal(h.window, 30);
  assert.equal(bindingWarning(h).kind, "pending");
});

test("进 7 天窗口 → 报 7 天那档，不再报 30 天", () => {
  setExpiry(daysOut(3));
  assert.equal(checkBinding({ root: bh, now: NOW }).window, 7, "应当取命中的最小窗口");
});

test("预警文案不含天数 —— 否则每天一条新指纹，一周刷七次", () => {
  setExpiry(daysOut(20));
  const t = bindingWarning(checkBinding({ root: bh, now: NOW })).text;
  const dayAfter = bindingWarning(checkBinding({ root: bh, now: NOW + 24 * 60 * 60 * 1000 })).text;
  assert.equal(t, dayAfter, "同一档在不同日子必须产出完全相同的文案才能被判重挡住");
});

test("已过期 → 升级成风险，并说清「我能说、你不能回」", () => {
  setExpiry(daysOut(-1));
  const h = checkBinding({ root: bh, now: NOW });
  assert.equal(h.state, "expired");
  const w = bindingWarning(h);
  assert.equal(w.kind, "risk");
  assert.ok(w.text.includes("出站不受影响"), "必须点明出站还活着，否则他会以为整条桥断了");
});

test("expires_at 解析不出日期 → 报风险，不当成没事", () => {
  setExpiry("下周");
  const h = checkBinding({ root: bh, now: NOW });
  assert.equal(h.state, "malformed");
  assert.equal(bindingWarning(h).kind, "risk");
});

test("每条预警都自带续期命令 —— 一年后没人记得字段在哪", () => {
  for (const spec of [daysOut(3), daysOut(-1), "下周"]) {
    setExpiry(spec);
    const w = bindingWarning(checkBinding({ root: bh, now: NOW }));
    assert.ok(w.text.includes("scripts/binding.mjs"), "提醒不给解法只完成了一半");
  }
});

test("没有 mapping 的项目 → 不预警（没接入站是常态，不是故障）", () => {
  const h = checkBinding({ root: path.join(tmp, "no-mapping"), now: NOW });
  assert.equal(h.state, "absent");
  assert.equal(bindingWarning(h), null);
});

test("同一档预警只会进 outbox 一次（含已发出的那条）", () => {
  const dir = path.join(tmp, "warn-once", "outbox");
  setExpiry(daysOut(20));
  const w = bindingWarning(checkBinding({ root: bh, now: NOW }));
  assert.equal(appendEvent({ outboxDir: dir, ...w, source: "binding-health" }).ok, true);
  const [rec] = listPending({ outboxDir: dir });
  markSent(rec, "om_test"); // 发出去之后再来一次，指纹仍在，不该重复打扰
  assert.equal(appendEvent({ outboxDir: dir, ...w, source: "binding-health" }).ok, false);
});

fs.rmSync(tmp, { recursive: true, force: true });

// ---------- 续期的日期解析 ----------

const YEAR_NOW = Date.parse("2026-08-19T10:00:00.000Z");
const until = (spec) => resolveUntil(spec, YEAR_NOW);

test("1y 从现在起算一年", () => {
  assert.equal(until("1y").iso, "2027-08-19T10:00:00.000Z");
});

test("6m / 90d 也收", () => {
  assert.equal(until("6m").iso, "2027-02-19T10:00:00.000Z");
  assert.equal(until("90d").iso, "2026-11-17T10:00:00.000Z");
});

test("闰年 2 月 29 日往后一年不会滚成无效日期", () => {
  const r = resolveUntil("1y", Date.parse("2028-02-29T00:00:00.000Z"));
  assert.ok(r.ok);
  assert.ok(!Number.isNaN(Date.parse(r.iso)), "不能产出 Invalid Date");
});

test("绝对日期照收", () => {
  assert.equal(until("2027-08-19").iso, "2027-08-19T00:00:00.000Z");
});

test("往回续 → 拒绝（打错年份等于当场关桥）", () => {
  const r = until("2020-01-01");
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("将来"));
});

test("看不懂的写法 → 拒绝，并说清能用什么", () => {
  const r = until("下周");
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("1y"), "报错要带可用写法，不能只说不认识");
});

test("0y / 负数 → 拒绝", () => {
  assert.equal(until("0d").ok, false);
});

test("备注：空的、太长的都拒", () => {
  assert.equal(validateNote("").ok, false);
  assert.equal(validateNote("   ").ok, false);
  assert.equal(validateNote("x".repeat(NOTE_MAX + 1)).ok, false);
  assert.equal(validateNote("长期绑定（非测试期）").ok, true);
});

test("--note --apply 这种手滑被挡下（否则备注变成 --apply 且没落盘）", () => {
  const r = validateNote("--apply");
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("引号"), "报错要指向真正的原因");
});

test("续期工具写得出的值，入站一定认（同一条规则）", () => {
  for (const v of ["unlimited", 1, 20, 500]) assert.equal(isValidQuota(v), true);
  for (const v of ["Unlimited", 0, -1, 2.5, "20", true, null, undefined]) {
    assert.equal(isValidQuota(v), false, JSON.stringify(v) + " 不该被判合法");
  }
});

// ---------- 只取最近轮次，不拉全量话题 ----------

test("没有 runId 时按轮次收窄，不拉整个话题", () => {
  const a = buildEventsArgs({ sessionId: "s", agentId: "a", runId: undefined });
  assert.ok(a.includes("--page-size"), "缺了收窄，开销会随话题寿命一直涨");
  assert.equal(a[a.indexOf("--page-size") + 1], String(RECENT_TURNS));
});

test("有 runId 时用 --run，不叠加 --page-size", () => {
  const a = buildEventsArgs({ sessionId: "s", agentId: "a", runId: "run_1" });
  assert.ok(a.includes("--run"));
  assert.ok(!a.includes("--page-size"), "--run 已经更准，两个一起用只会互相干扰");
});

test("收窄的余量至少留一轮（别卡在轮次边界上漏消息）", () => {
  assert.ok(RECENT_TURNS >= 2, "取 1 会在查询正好落到轮次边界时漏掉目标消息");
});

// ---------- 现场判定：投给谁 ----------

const sess = path.join(tmp, "sessions");
fs.mkdirSync(sess, { recursive: true });
const PROJ = "/Users/dk/claude-projects/feishu-bridge-cc";
const writeSession = (name, rec) =>
  fs.writeFileSync(path.join(sess, name + ".json"), JSON.stringify(rec));
const allAlive = () => true;
const find = (opts = {}) => findLiveSessions({ projectRoot: PROJ, sessionsDir: sess, isAlive: allAlive, ...opts });

test("活着的交互会话就是现场", () => {
  writeSession("100", { pid: 100, sessionId: "s-a", cwd: PROJ, kind: "interactive", name: "n-a", startedAt: 1 });
  assert.deepEqual(find().map((s) => s.sessionId), ["s-a"]);
});

test("无头会话不算现场（投进去会套娃：投递自己起的就是无头）", () => {
  writeSession("101", { pid: 101, sessionId: "s-h", cwd: PROJ, kind: "headless", name: "n-h", startedAt: 9 });
  assert.ok(!find().some((s) => s.sessionId === "s-h"));
});

test("别的项目的会话不算现场", () => {
  writeSession("102", { pid: 102, sessionId: "s-o", cwd: "/Users/dk/other", kind: "interactive", name: "n-o", startedAt: 9 });
  assert.ok(!find().some((s) => s.sessionId === "s-o"));
});

test("项目子目录里起的会话算现场", () => {
  writeSession("103", { pid: 103, sessionId: "s-sub", cwd: PROJ + "/scripts", kind: "interactive", name: "n-sub", startedAt: 2 });
  assert.ok(find().some((s) => s.sessionId === "s-sub"));
});

test("进程已死 → 不算现场（登记文件不会自己消失）", () => {
  const deadOnly = findLiveSessions({ projectRoot: PROJ, sessionsDir: sess, isAlive: () => false });
  assert.deepEqual(deadOnly, [], "只有登记文件在、进程没了，绝不能当成现场");
});

test("多个现场取最近开的那个", () => {
  writeSession("104", { pid: 104, sessionId: "s-new", cwd: PROJ, kind: "interactive", name: "n-new", startedAt: 999 });
  assert.equal(find()[0].sessionId, "s-new");
});

test("半截 / 损坏的登记文件不影响判定", () => {
  fs.writeFileSync(path.join(sess, "105.json"), "{ 半截");
  assert.ok(find().length > 0, "坏文件应当被跳过而不是让整个判定崩掉");
});

test("sessions 目录不存在 → 没有现场，不崩", () => {
  assert.deepEqual(findLiveSessions({ projectRoot: PROJ, sessionsDir: path.join(tmp, "nope") }), []);
});

// ---------- --continue 有没有东西可续 ----------

test("目录里有会话记录 → 可续", () => {
  const d = path.join(tmp, "has-prior");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "abc.jsonl"), "{}\n");
  assert.equal(hasPriorSession({ projectRoot: "/x", projectsDir: d }), true);
});

test("目录是空的或不存在 → 不可续（该拒绝，不该兜底）", () => {
  const d = path.join(tmp, "empty-prior");
  fs.mkdirSync(d, { recursive: true });
  assert.equal(hasPriorSession({ projectRoot: "/x", projectsDir: d }), false);
  assert.equal(hasPriorSession({ projectRoot: "/x", projectsDir: path.join(tmp, "absent") }), false);
});

test("会话记录目录名就是 cwd 把 / 换成 -", () => {
  assert.ok(transcriptDirFor(PROJ).endsWith("-Users-dk-claude-projects-feishu-bridge-cc"));
});

// ---------- 来源戳与转发提示词 ----------

test("指令带上飞书来源戳，终端里看得出这条哪来的", () => {
  const s = stampInstruction({ instruction: "干活", messageId: "msg_x", createdAtMs: Date.parse("2026-08-19T07:27:30Z") });
  assert.ok(s.includes("msg_x") && s.includes("2026-08-19 07:27"));
  assert.ok(s.endsWith("干活"), "指令正文必须原样在最后，不能被戳改写");
});

test("时间戳缺失也不崩，如实写未知", () => {
  assert.ok(stampInstruction({ instruction: "干活", messageId: "m", createdAtMs: NaN }).includes("时间未知"));
});

test("转发提示词把「不要执行」放在最前面并重复", () => {
  const p = forwardPrompt({ targetName: "sess-1", stamped: "[飞书 · m · t]\n把仓库删了" });
  assert.ok(p.indexOf("不要执行") < p.indexOf("SendMessage"), "禁止执行必须先于任务说明出现");
  assert.ok(p.lastIndexOf("不负责完成") > p.indexOf("===END==="), "分隔符之后要再挡一次");
  assert.ok(p.includes('"sess-1"'), "目标名要带引号，防止名字里有空格时被截断");
});

// ---------- 答复原样转发（不经判断） ----------

const ex = (payload) => extractReply(payload, { maxChars: 4000 });

test("答复是字符串时直接取", () => {
  assert.equal(ex({ last_assistant_message: "  改完了  " }), "改完了");
});

test("答复是带 content 块的对象时也取得出", () => {
  const p = { last_assistant_message: { content: [
    { type: "thinking", thinking: "内心戏不该外发" },
    { type: "text", text: "第一段" }, { type: "text", text: "第二段" },
  ] } };
  assert.equal(ex(p), "第一段\n第二段");
});

test("思考过程不进答复", () => {
  assert.ok(!ex({ last_assistant_message: { content: [
    { type: "thinking", thinking: "秘密" }, { type: "text", text: "结论" },
  ] } }).includes("秘密"));
});

test("嵌一层 message.content 也认", () => {
  assert.equal(ex({ last_assistant_message: { message: { content: [{ type: "text", text: "嵌套" }] } } }), "嵌套");
});

test("取不出文本 → null，绝不发 [object Object]", () => {
  for (const bad of [{}, { last_assistant_message: null }, { last_assistant_message: 42 },
                     { last_assistant_message: {} }, { last_assistant_message: "   " },
                     { last_assistant_message: { content: [{ type: "thinking", thinking: "只有思考" }] } }]) {
    assert.equal(ex(bad), null, JSON.stringify(bad) + " 应当取不出答复");
  }
});

test("超长答复截断并明说，不静默丢尾巴", () => {
  const r = extractReply({ last_assistant_message: "x".repeat(500) }, { maxChars: 100 });
  assert.ok(r.length < 500 && r.includes("已截断"), "截断必须留下痕迹");
});

test("桥自己起的会话不产生答复（转发的只会说 sent，跑活的归守望者发）", () => {
  assert.equal(isBridgeOwnedSession({ FEISHU_BRIDGE_ROLE: "forwarder" }), true);
  assert.equal(isBridgeOwnedSession({ FEISHU_BRIDGE_ROLE: "run" }), true);
  assert.equal(isBridgeOwnedSession({}), false, "人开的交互会话必须产生答复");
  assert.equal(isBridgeOwnedSession({ FEISHU_BRIDGE_ROLE: "" }), false);
});

// ---------- 摘要渲染 ----------

const rec = (kind, text) => ({ kind, text });

test("reply 原样渲染，不加「· 」不加【】", () => {
  const long = "第一行\n\n| 表 | 格 |\n|---|---|\n| a | b |";
  const out = composeDigest([rec("reply", long)], { taskName: "T" });
  assert.equal(out, long, "答复是正文，任何前缀或分组都会把它揉烂");
});

test("只有进展时渲染不变（老行为不能回归）", () => {
  const out = composeDigest([rec("milestone", "做完了")], { taskName: "T" });
  assert.ok(out.startsWith("T · 进展") && out.includes("【里程碑】") && out.includes("· 做完了"));
});

test("答复和进展同时待发 → 答复在前，用分隔线隔开", () => {
  const out = composeDigest([rec("milestone", "做完了"), rec("reply", "这是答复")], { taskName: "T" });
  assert.ok(out.indexOf("这是答复") < out.indexOf("T · 进展"), "答复应当排在进展前面");
  assert.ok(out.includes("———"));
  assert.ok(!out.includes("· 这是答复"), "答复绝不能被加上进展的项目符号");
});

test("多条答复各自成段", () => {
  const out = composeDigest([rec("reply", "甲"), rec("reply", "乙")], { taskName: "T" });
  assert.ok(out.includes("甲") && out.includes("乙") && !out.includes("· 甲"));
});

test("reply 是合法 kind，能被 appendEvent 收下", () => {
  const dir = path.join(tmp, "reply-kind");
  assert.equal(appendEvent({ outboxDir: dir, kind: "reply", text: "答复正文", source: "t" }).ok, true);
  assert.equal(listPending({ outboxDir: dir })[0].kind, "reply");
});

test("outbox 只接收本地 reply 的输入并在边界截断", () => {
  const dir = path.join(tmp, "reply-input-boundary");
  appendEvent({
    outboxDir: dir, kind: "reply", text: "答复", source: "t",
    inputOrigin: "local", inputText: "x".repeat(MAX_LOCAL_INPUT_CHARS + 50),
  });
  const local = listPending({ outboxDir: dir })[0];
  assert.equal(local.input_origin, "local");
  assert.match(local.input_text, /本地输入已截断/u);

  appendEvent({
    outboxDir: dir, kind: "milestone", text: "进展", source: "t",
    inputOrigin: "local", inputText: "不应进入进展事件",
  });
  const progress = listPending({ outboxDir: dir }).find((record) => record.kind === "milestone");
  assert.equal(progress.input_origin, null);
  assert.equal(progress.input_text, null);
});

test("Claude 本地输入与回复进入同一张 Card 2.0，入站回复不显示输入块", () => {
  const paired = composeOutboundCard([{
    kind: "reply",
    text: "Claude 已完成",
    input_origin: "local",
    input_text: "请继续开发",
  }], { taskName: "Claude 项目", runtime: "claude" });
  assert.equal(validateOutboundCard(paired).ok, true);
  assert.equal(paired.header, undefined);
  assert.equal(paired.body.elements.length, 2);
  assert.equal(paired.body.elements[0].element_id, "user_quote");
  assert.equal(paired.body.elements[0].text_size, "notation");
  assert.match(JSON.stringify(paired.body.elements[0]), /请继续开发/u);
  assert.equal(paired.body.elements[1].element_id, "agent_reply");
  assert.match(JSON.stringify(paired.body.elements[1]), /Claude 已完成/u);
  assert.equal(JSON.stringify(paired).includes("Claude 回复"), false);
  assert.equal(paired.config.summary.content, "请继续开发");

  const inbound = composeOutboundCard([{
    kind: "reply", text: "飞书消息执行完成",
  }], { taskName: "Claude 项目", runtime: "claude" });
  assert.equal(inbound.body.elements.length, 1);
  assert.equal(JSON.stringify(inbound).includes("user_quote"), false);
  assert.equal(inbound.body.elements[0].element_id, "agent_reply");
  assert.equal(inbound.config.summary.content, "飞书消息执行完成");
});

test("Claude 回合缓存识别飞书来源戳，并按会话隔离", () => {
  const root = path.join(tmp, "turn-input-project");
  const dir = claudeTurnInputDir(root, "session-a");
  assert.equal(storeTurnInput({ dir, key: "session-a", text: "本地问题" }).ok, true);
  assert.equal(readTurnInput({ dir, key: "session-a" }).text, "本地问题");
  assert.equal(typeof readTurnInput({ dir, key: "session-a" }).captureId, "string");
  assert.equal(readTurnInput({ dir, key: "session-b" }).reason, "not_found");
  assert.equal(isFeishuStampedInput("[飞书 · msg_abc · 2026-08-21 10:00Z]\n继续"), true);
  assert.equal(isFeishuStampedInput("正文里引用 [飞书 · msg_abc · t] 不算来源戳"), false);
  clearTurnInput({ dir, key: "session-a" });
  assert.equal(readTurnInput({ dir, key: "session-a" }).reason, "not_found");
});

test("Claude reply 一轮一张卡，普通进展保持合批", () => {
  assert.deepEqual(outboundCardBatches([
    rec("milestone", "m"), rec("reply", "a"), rec("reply", "b"), rec("next", "n"),
  ]).map((batch) => batch.map((record) => record.kind)), [
    ["milestone"], ["reply"], ["reply"], ["next"],
  ]);
});

// ---------- 取信封：最终一致的事件存储要重试 ----------

const ENVELOPE_ENV = {
  AILY_CLI_SESSION_ID: "session_x", AILY_CLI_RUN_ID: "run_x", AILY_CLI_CALLER_AGENT_UID: "agent_x",
};
const userEnvelope = (id) => JSON.stringify({ envelopes: [{
  type: "message.create",
  payload: { message: { id, role: "user", sessionID: "session_x", createdBy: "u1", createdAtMs: 1, content: "hi" } },
}] });
const emptyEnvelope = JSON.stringify({ envelopes: [{ type: "run.queued" }] });

const fetchWith = (responses) => {
  let n = 0;
  const calls = [];
  const r = fetchTriggerEvent(ENVELOPE_ENV, {
    runner: () => {
      const v = responses[Math.min(n, responses.length - 1)];
      n += 1;
      if (v instanceof Error) throw v;
      return v;
    },
    sleep: (ms) => calls.push(ms),
  });
  return { result: r, tries: n, sleeps: calls };
};

test("第一次就查到 → 不重试", () => {
  const { result, tries } = fetchWith([userEnvelope("msg_a")]);
  assert.equal(result.ok, true);
  assert.equal(result.event.message_id, "msg_a");
  assert.deepEqual(result.raw_envelope, JSON.parse(userEnvelope("msg_a")).envelopes[0],
    "取信封时必须把被选中的 Aily envelope 原样带给 dispatcher");
  assert.equal(tries, 1, "查到了还重试是白白拖慢回执");
});

test("前两次查不到、第三次查到 → 成功（回归 2026-08-19 三次真实失败）", () => {
  const { result, tries } = fetchWith([emptyEnvelope, emptyEnvelope, userEnvelope("msg_b")]);
  assert.equal(result.ok, true, "读延迟不该变成摆在 Frank 面前的系统错误");
  assert.equal(result.event.message_id, "msg_b");
  assert.equal(result.attempts, 3);
  assert.equal(tries, 3);
});

test("一直查不到 → 如实报错，并带上诊断字段", () => {
  const { result } = fetchWith([emptyEnvelope]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_user_message_in_session");
  assert.equal(result.attempts, FETCH_BACKOFF_MS.length);
  assert.equal(result.session_id, "session_x");
  assert.equal(result.run_id, "run_x");
  assert.equal(result.envelopes_seen, 1, "看到几个 envelope 必须留痕，否则事后查不出是空还是没匹配上");
});

test("重试预算压在秒级回执之内", () => {
  const total = FETCH_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.ok(total <= 3000, "最坏等待 " + total + "ms，超过秒级回执的契约");
});

test("aily-cli 调用失败也重试（可能是瞬时的）", () => {
  const { result, tries } = fetchWith([new Error("boom"), new Error("boom"), userEnvelope("msg_c")]);
  assert.equal(result.ok, true);
  assert.equal(tries, 3);
});

test("配置类错误不重试 —— 重试一百次也是同一个结果", () => {
  const r1 = fetchTriggerEvent({ AILY_CLI_CALLER_AGENT_UID: "a" }, { runner: () => { throw new Error("不该被调用"); } });
  assert.equal(r1.reason, "missing_session_env");
  const r2 = fetchTriggerEvent({ AILY_CLI_SESSION_ID: "s" }, { runner: () => { throw new Error("不该被调用"); } });
  assert.equal(r2.reason, "missing_agent_env");
});

test("返回的不是 JSON → 也重试，最终如实报错", () => {
  const { result, tries } = fetchWith(["这不是 json"]);
  assert.equal(result.reason, "session_events_unparsable");
  assert.equal(tries, FETCH_BACKOFF_MS.length);
});

// ---------- 接入新项目（bind-project / chain-template） ----------

const TPL = {
  chain: "claude",
  transport_agent_name: "T", transport_app_id: "cli_x", transport_open_id: "ou_t",
  outbound_agent_name: "O", outbound_app_id: "cli_y", outbound_open_id: "ou_o",
  lark_cli_profile: "claude", lark_cli_bin: "/bin/lark", lark_cli_home: "/home/lark",
  frank_sender_id: "12345",
  chat_name: "群", chat_id: "oc_abc",
  default_freshness_ms: 900000,
  agent_uid: "agent_x",
};

test("Claude UserPromptSubmit 与 Stop 配对本地输入，飞书来源戳只回写回复", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-turn-"));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  const registryFile = path.join(home, "registry.json");
  const templateFile = path.join(home, "chain-config.json");
  fs.writeFileSync(registryFile, JSON.stringify({ projects: [{
    id: "paired", root: project, name: "配对项目", root_message_id: "om_root",
    expires_at: "2099-01-01T00:00:00Z",
  }] }));
  fs.writeFileSync(templateFile, JSON.stringify(TPL));
  const lock = path.join(project, ".runtime-data", "inbound", "session.lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid, log_path: path.join(home, "running.jsonl"), at: new Date().toISOString(),
  }));
  const env = {
    ...process.env,
    FEISHU_BRIDGE_REGISTRY: registryFile,
    FEISHU_BRIDGE_CHAIN_TEMPLATE: templateFile,
  };
  const initHook = path.join(path.resolve("scripts"), "init-hook.mjs");
  const stopHook = path.join(path.resolve("scripts"), "stop-hook.mjs");
  const session = "claude-local-session";
  const inputDir = claudeTurnInputDir(project, null);

  const localPrompt = spawnSync(process.execPath, [initHook], {
    input: JSON.stringify({ session_id: session, cwd: project, prompt: "请把这一轮同步过去" }),
    encoding: "utf-8",
    env,
  });
  assert.equal(localPrompt.status, 0, localPrompt.stderr);
  assert.equal(readTurnInput({ dir: inputDir, key: session }).text, "请把这一轮同步过去");

  const localStop = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({
      session_id: session, cwd: project, last_assistant_message: "这一轮已经完成",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(localStop.status, 0, localStop.stderr);
  let replies = listPending({ outboxDir: outboxDirOf(project) }).filter((record) => record.kind === "reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].input_origin, "local");
  assert.equal(replies[0].input_text, "请把这一轮同步过去");
  assert.equal(typeof readTurnInput({ dir: inputDir, key: session }).captureId, "string");

  const duplicateStop = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({
      session_id: session, cwd: project, last_assistant_message: "这一轮已经完成",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(duplicateStop.status, 0, duplicateStop.stderr);
  replies = listPending({ outboxDir: outboxDirOf(project) }).filter((record) => record.kind === "reply");
  assert.equal(replies.length, 1, "同一 Claude 回合的 Stop 重入不得重复入队");

  const nextPrompt = spawnSync(process.execPath, [initHook], {
    input: JSON.stringify({ session_id: session, cwd: project, prompt: "换一个问题但得到相同回复" }),
    encoding: "utf-8",
    env,
  });
  assert.equal(nextPrompt.status, 0, nextPrompt.stderr);
  const nextStop = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({
      session_id: session, cwd: project, last_assistant_message: "这一轮已经完成",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(nextStop.status, 0, nextStop.stderr);
  replies = listPending({ outboxDir: outboxDirOf(project) }).filter((record) => record.kind === "reply");
  assert.equal(replies.length, 2, "不同 Claude 回合即使回复正文相同也必须分别入队");

  storeTurnInput({ dir: inputDir, key: session, text: "不应误配的旧输入" });
  const inboundPrompt = spawnSync(process.execPath, [initHook], {
    input: JSON.stringify({
      session_id: session,
      cwd: project,
      prompt: "[飞书 · msg_inbound · 2026-08-21 10:00Z]\n请继续",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(inboundPrompt.status, 0, inboundPrompt.stderr);
  assert.equal(readTurnInput({ dir: inputDir, key: session }).reason, "not_found");

  const inboundStop = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({
      session_id: session, cwd: project, last_assistant_message: "飞书指令已经完成",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(inboundStop.status, 0, inboundStop.stderr);
  replies = listPending({ outboxDir: outboxDirOf(project) }).filter((record) => record.kind === "reply");
  assert.equal(replies.length, 3);
  const inboundRecord = replies.find((record) => record.text === "飞书指令已经完成");
  assert.equal(inboundRecord.input_origin, null);
  assert.equal(inboundRecord.input_text, null);
});

test("模板缺字段 → 报出缺哪些，不放行", () => {
  const { chat_id, agent_uid, ...rest } = TPL;
  const v = validateChainTemplate(rest);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing.sort(), ["agent_uid", "chat_id"]);
});

test("群 id 形状不对 → 判 malformed，不是 missing", () => {
  const v = validateChainTemplate({ ...TPL, chat_id: "oc" });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.malformed, ["chat_id"]);
});

test("群 id 写成飞书群链接那种非 oc_ 值 → 拒，绝不拿去建话题", () => {
  for (const bad of ["https://feishu.cn/chat/x", "ou_looks_like_user", "7620345068927929309"]) {
    assert.equal(validateChainTemplate({ ...TPL, chat_id: bad }).ok, false, bad);
  }
});

test("时效窗口是布尔或字符串数字 → 判配错（跟 selector 同一条 fail-closed 原则）", () => {
  for (const bad of [true, "900000", 0, -1]) {
    assert.equal(validateChainTemplate({ ...TPL, default_freshness_ms: bad }).ok, false, String(bad));
  }
});

test("合成的项目配置带齐全部链路字段 —— 现有读取方一行都不用改", () => {
  const cfg = materializeProjectConfig({ template: TPL, projectRoot: "/tmp/demo" });
  for (const f of CHAIN_FIELDS) assert.equal(cfg[f], TPL[f], f);
  assert.equal(cfg.project_dir, "/tmp/demo");
  assert.equal(cfg.task_display_name, "demo");
});

test("逻辑键剔掉文件名不安全的字符 —— 它要进 claim 和回执的文件名", () => {
  const cfg = materializeProjectConfig({ template: TPL, projectRoot: "/tmp/a b.c/d e" });
  assert.equal(cfg.logical_task_key, "d_e");
  assert.match(cfg.logical_task_key, /^[A-Za-z0-9_-]+$/);
});

test("显示名可覆盖，但空白覆盖不生效（话题里不能出现没有主语的消息）", () => {
  assert.equal(materializeProjectConfig({ template: TPL, projectRoot: "/tmp/x", displayName: "我的项目" }).task_display_name, "我的项目");
  assert.equal(materializeProjectConfig({ template: TPL, projectRoot: "/tmp/x", displayName: "   " }).task_display_name, "x");
});

test("幂等键：同路径恒定、不同路径不同、不超过平台 50 字符上限", () => {
  assert.equal(idempotencyKeyFor("/tmp/a"), idempotencyKeyFor("/tmp/a"));
  assert.notEqual(idempotencyKeyFor("/tmp/a"), idempotencyKeyFor("/tmp/b"));
  assert.ok(idempotencyKeyFor("/very/long/".repeat(40)).length <= 50);
});

test("绑定码进了根消息正文 —— 将来靠引用块做确定性匹配全指望它", () => {
  const token = bindingToken("/tmp/a");
  const msg = composeRootMessage({ name: "a", root: "/tmp/a", token });
  assert.ok(msg.includes(token));
  assert.ok(msg.includes("/tmp/a"));
  assert.ok(msg.includes("本机输入与每轮回答会合成卡片"));
  assert.ok(msg.includes("从本话题发出的输入不会重复显示"));
});

test("根消息里不含任何当前进度字样 —— 它发出去就改不了", () => {
  const msg = composeRootMessage({ name: "a", root: "/tmp/a", token: "abc123" });
  for (const banned of ["已接通", "还没接通", "待绑定", "改造"]) {
    assert.ok(!msg.includes(banned), "根消息不该出现「" + banned + "」");
  }
});

test("状态消息说清入站还差 @ 那一下，且不含任何过期说法", () => {
  const m = composeStatusMessage({ name: "a" });
  assert.ok(m.includes("出站已接通"));
  assert.ok(m.includes("@ 一下"));
  assert.ok(m.includes("绑定就完成了"));
  // 这几句在多绑定路由做完之后就是假话了。文案里不许再出现。
  for (const stale of ["多绑定", "还没接通", "只认一个项目"]) {
    assert.ok(!m.includes(stale), "状态消息不该出现「" + stale + "」");
  }
});

test("登记表接入：session_id 恒为 null → 入站被 evaluateInbound 一律拒（fail-closed 免费得到）", () => {
  const entry = newRegistryEntry({
    root: "/tmp/demo", name: "demo", purpose: null, token: "abc123", rootMessageId: "om_root",
  });
  const mapping = mappingFromRegistryEntry(entry);
  const event = {
    message_id: "msg_1", session_id: "session_real", sender_id: TPL.frank_sender_id,
    content: '<at id="ou_t">T</at> 干活', created_at_ms: Date.now(),
  };
  const v = evaluateInbound({ event, mapping, config: { transport_open_id: "ou_t" }, now: Date.now() });
  assert.equal(v.decision, "reject");
  assert.equal(v.reason, REJECT.SESSION_MISMATCH);
});

test("登记表那一行 status=active → 出站立刻可用（不等入站）", () => {
  const m = mappingFromRegistryEntry(newRegistryEntry({
    root: "/tmp/demo", name: "demo", token: "t", rootMessageId: "om_root",
  }));
  assert.equal(m.status, "active");            // drainProject 只看这个
  assert.equal(m.inbound_state, "pending");
  assert.equal(m.session_id, null);
  assert.equal(m.feishu_root_message_id_reference, "om_root");
});

test("接入产生的新状态只有一行登记，有效期一年、配额无限", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  const e = newRegistryEntry({ root: "/tmp/d", name: "d", token: "t", rootMessageId: "om_r", now });
  assert.ok(Date.parse(e.expires_at) - now > 300 * 24 * 3600 * 1000);
  assert.equal(e.root_message_id, "om_r");
  assert.equal(mappingFromRegistryEntry(e).max_inbound_messages, "unlimited");
});

// ---------- 解析：项目文件优先，回落登记表 ----------

function bindFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-proj-"));
  const regFile = path.join(home, "registry.json");
  const tplFile = path.join(home, "chain-config.json");
  fs.writeFileSync(tplFile, JSON.stringify(TPL));
  return { home, proj, regFile, tplFile };
}

test("项目目录里有 mapping → 走项目文件，登记表和模板完全不参与", () => {
  const { proj, regFile, tplFile } = bindFixture();
  const rt = path.join(proj, ".runtime-data", "inbound");
  fs.mkdirSync(rt, { recursive: true });
  fs.writeFileSync(path.join(rt, "active-mapping.json"),
    JSON.stringify({ status: "active", expires_at: "2099-01-01T00:00:00Z", feishu_root_message_id_reference: "om_old" }));
  const r = resolveProject({ root: proj, registryFile: regFile, templateFile: tplFile });
  assert.equal(r.ok, true);
  assert.equal(r.source, "project-files");
  assert.equal(r.mapping.feishu_root_message_id_reference, "om_old");
});

test("项目文件 binding 的 consumed sidecar 不覆盖 Dialogue/Topic 状态", () => {
  const { proj, regFile, tplFile } = bindFixture();
  const rt = path.join(proj, ".runtime-data", "inbound");
  fs.mkdirSync(rt, { recursive: true });
  const base = {
    schema_version: "1.0",
    binding_id: "project-files-dialogue",
    status: "active",
    logical_task_key: "project-files-dialogue",
    session_id: "session_project",
    inbound_state: "bound",
    feishu_root_message_id_reference: "om_project",
    expires_at: "2099-01-01T00:00:00.000Z",
    consumed_message_ids: ["legacy_event"],
  };
  const mappingPolicy = interactionPolicyStateForLegacy(base, {
    bindingId: base.binding_id, now: NOW,
  }).state;
  base.interaction_policy_state = setInteractionPolicyMode(mappingPolicy, {
    mode: "dialogue", now: NOW,
  }).state;
  const mappingFile = path.join(rt, "active-mapping.json");
  fs.writeFileSync(mappingFile, JSON.stringify(base, null, 2));

  appendConsumed(proj, "new_event", { seed: base.consumed_message_ids });
  const disk = JSON.parse(fs.readFileSync(mappingFile, "utf-8"));
  assert.deepEqual(disk.interaction_policy_state, base.interaction_policy_state);
  assert.deepEqual(disk.consumed_message_ids, ["legacy_event"]);
  const resolved = resolveProject({ root: proj, registryFile: regFile, templateFile: tplFile });
  assert.deepEqual(resolved.mapping.consumed_message_ids, ["legacy_event", "new_event"]);
  assert.equal(resolved.mapping.interaction_policy_state.policy_id, "dialogue");
});

test("项目目录里什么都没有 → 回落到登记表那一行", () => {
  const { proj, regFile, tplFile } = bindFixture();
  fs.writeFileSync(regFile, JSON.stringify({ projects: [
    { id: "p", root: proj, name: "我的项目", root_message_id: "om_new", expires_at: "2099-01-01T00:00:00Z" },
  ] }));
  const r = resolveProject({ root: proj, registryFile: regFile, templateFile: tplFile });
  assert.equal(r.ok, true);
  assert.equal(r.source, "registry");
  assert.equal(r.mapping.feishu_root_message_id_reference, "om_new");
  assert.equal(r.config.task_display_name, "我的项目");            // 显示名来自登记表
  assert.equal(r.config.lark_cli_profile, TPL.lark_cli_profile);  // 身份来自机器模板
});

test("登记表有这个项目但没有 root_message_id → not_bound，不是配错", () => {
  const { proj, regFile, tplFile } = bindFixture();
  fs.writeFileSync(regFile, JSON.stringify({ projects: [{ id: "p", root: proj }] }));
  const r = resolveProject({ root: proj, registryFile: regFile, templateFile: tplFile });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_bound");
});

test("到期预警不依赖 chain-config —— 只有 mapping 也照常体检", () => {
  const { proj } = bindFixture();
  const rt = path.join(proj, ".runtime-data", "inbound");
  fs.mkdirSync(rt, { recursive: true });
  // 刻意不写 chain-config.json：预警根本不读它。让它去依赖一个自己用不到的文件，
  // 会让「配置缺一半」的项目静默停止预警 —— 这一版差点就是这样。
  fs.writeFileSync(path.join(rt, "active-mapping.json"),
    JSON.stringify({ status: "active", expires_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString() }));
  const health = checkBinding({ root: proj });
  assert.equal(health.state, "expiring");
  assert.ok(bindingWarning(health).text.includes("续期"));
});

test("登记表接入的项目也进得了到期体检", () => {
  const { proj, regFile, tplFile } = bindFixture();
  fs.writeFileSync(regFile, JSON.stringify({ projects: [
    { id: "p", root: proj, root_message_id: "om_x",
      expires_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString() },
  ] }));
  const r = resolveProject({ root: proj, registryFile: regFile, templateFile: tplFile });
  assert.equal(r.mapping.status, "active");
  assert.ok(Date.parse(r.mapping.expires_at) > Date.now());
});

test("登记表整条带过去，不再只留 id 和 root", () => {
  const { proj, regFile } = bindFixture();
  fs.writeFileSync(regFile, JSON.stringify({ projects: [
    { id: "p", root: proj + "/", root_message_id: "om_x", name: "N" },
  ] }));
  const reg = loadRegistry(regFile);
  assert.equal(reg.projects[0].root_message_id, "om_x");
  assert.equal(reg.projects[0].name, "N");
  assert.equal(reg.projects[0].root, proj, "结尾斜杠仍然要归一化");
});

// ---------- 项目名字和用途：从 CLAUDE.md 取，取不到用目录名 ----------

function projWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-id-"));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return d;
}

test("CLAUDE.md 的一级标题当名字，第一段第一句当用途", () => {
  const d = projWith({ "CLAUDE.md": "# cc2cd\n\n让 Claude 和 Codex 在飞书的一个话题里互相对话。背景、两种模式、\n已定与未定，都在 `README.md`。\n\n## 别的\n" });
  const id = readProjectIdentity({ root: d });
  assert.equal(id.name, "cc2cd");
  assert.equal(id.purpose, "让 Claude 和 Codex 在飞书的一个话题里互相对话。");
  assert.equal(id.source, "CLAUDE.md");
});

test("断句：中文句号不需要后跟空格，英文点号需要", () => {
  assert.equal(firstSentence("第一句。第二句。"), "第一句。");
  assert.equal(firstSentence("详见 README.md 里的说明。后面还有"), "详见 README.md 里的说明。");
  assert.equal(firstSentence("First one. Second one."), "First one.");
  assert.equal(firstSentence("版本 v1.2 是稳定版"), "版本 v1.2 是稳定版", "小数点不该断句");
  assert.equal(firstSentence("没有终止符的一段"), "没有终止符的一段");
});

test("/init 生成的 CLAUDE.md 不能当项目身份用 —— 标题就是文件名、首段是样板话", () => {
  const boiler = "# CLAUDE.md\n\nThis file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.\n\n## 别的\n";
  const only = projWith({ "CLAUDE.md": boiler });
  const id = readProjectIdentity({ root: only });
  assert.equal(id.source, "dirname", "只有样板 CLAUDE.md 时必须退到目录名");
  assert.equal(id.name, path.basename(only));

  // 有 README 就该用 README —— 这是 /init 之后的常态。
  const both = projWith({ "CLAUDE.md": boiler, "README.md": "# cc2cd\n\n让 Claude 和 Codex 对话。\n" });
  const id2 = readProjectIdentity({ root: both });
  assert.equal(id2.name, "cc2cd");
  assert.equal(id2.source, "README.md");
});

test("README 优先于 CLAUDE.md", () => {
  const d = projWith({ "README.md": "# 真名\n\n真用途。\n", "CLAUDE.md": "# 假名\n\n假用途。\n" });
  assert.equal(readProjectIdentity({ root: d }).name, "真名");
});

test("项目身份中的行内 markdown 被剥掉 —— 根消息仍是飞书文本", () => {
  const d = projWith({ "README.md": "# `cc2cd`\n\n让两个模型**互相**对话，详见 [基线](./x.md)。\n" });
  const id = readProjectIdentity({ root: d });
  assert.equal(id.name, "cc2cd");
  assert.equal(id.purpose, "让两个模型互相对话，详见 基线。");
  assert.ok(!id.purpose.includes("*") && !id.purpose.includes("`") && !id.purpose.includes("]("));
});

test("两个文件都没有 → 用目录名，绝不失败", () => {
  const d = projWith({});
  const id = readProjectIdentity({ root: d });
  assert.equal(id.name, path.basename(d));
  assert.equal(id.purpose, null);
  assert.equal(id.source, "dirname");
});

test("有标题但正文是代码块或直接下一个标题 → 用途为 null，名字照常", () => {
  const a = projWith({ "CLAUDE.md": "# 名字\n\n```bash\nls\n```\n" });
  assert.equal(readProjectIdentity({ root: a }).purpose, null);
  assert.equal(readProjectIdentity({ root: a }).name, "名字");
  const b = projWith({ "CLAUDE.md": "# 名字\n\n## 小节\n正文\n" });
  assert.equal(readProjectIdentity({ root: b }).purpose, null);
});

test("超长的第一句会被截断，不会把整篇 CLAUDE.md 发进话题", () => {
  const d = projWith({ "CLAUDE.md": "# 名字\n\n" + "很长".repeat(500) + "。\n" });
  const id = readProjectIdentity({ root: d });
  assert.ok(id.purpose.length <= PURPOSE_MAX, "用途长度 " + id.purpose.length);
});

test("没有一级标题的 CLAUDE.md 不算数 —— 退到目录名而不是拿正文当名字", () => {
  const d = projWith({ "CLAUDE.md": "随便一段话，没有标题\n" });
  assert.equal(readProjectIdentity({ root: d }).source, "dirname");
});

test("用途进了根消息；没有用途时根消息也成立", () => {
  const withP = composeRootMessage({ name: "n", purpose: "干这个的。", root: "/tmp/x", token: "t0k3n1" });
  assert.ok(withP.includes("干这个的。"));
  const noP = composeRootMessage({ name: "n", purpose: null, root: "/tmp/x", token: "t0k3n1" });
  assert.ok(noP.includes("t0k3n1") && noP.includes("/tmp/x"));
  assert.ok(!noP.includes("null"), "用途缺失不能把 null 打进消息里");
});

// ---------- /init 钩子：什么算 /init，注入什么 ----------

test("只认 /init 本身和 /init 带参数", () => {
  for (const y of ["/init", "  /init  ", "/init 顺便跑测试"]) {
    assert.equal(isInitPrompt(y), true, JSON.stringify(y));
  }
  for (const n of ["/initialize", "/init-thing", "init", "/compact", "帮我 /init", "", null, undefined, 42, {}]) {
    assert.equal(isInitPrompt(n), false, JSON.stringify(n));
  }
});

test("Claude /init 只提示后续显式命令，不携带真实绑定路径", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("先完整执行 /init 原本的 CLAUDE.md 初始化"));
  assert.ok(ask.includes("请显式运行 `/feishu-bind`"));
  assert.ok(ask.includes("只有用户后续单独运行 `/feishu-bind`"));
  assert.equal(ask.includes("bind-project.mjs"), false,
    "真实 hook 注入不能再携带绑定写路径");
  assert.equal(ask.includes("--apply"), false);
  assert.equal(ask.includes("默认「是」"), false);
  assert.ok(ask.includes("不要调用 AskUserQuestion"));
});

// ---------- 预览入口进白名单的前提：它碰不到发送代码 ----------

/** 顺着 import 走一遍，返回这个模块传递依赖到的全部本地脚本。 */
function importGraph(entry, seen = new Set()) {
  const abs = path.resolve("scripts", entry);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  let src;
  try { src = fs.readFileSync(abs, "utf-8"); } catch { return seen; }
  for (const m of src.matchAll(/^\s*import[^"']*["'](\.\/[^"']+)["']/gm)) {
    importGraph(m[1].replace("./", ""), seen);
  }
  for (const m of src.matchAll(/await import\(\s*["'](\.\/[^"']+)["']/g)) {
    importGraph(m[1].replace("./", ""), seen);
  }
  return seen;
}

test("bind-preview 的依赖图里没有 outbound —— 白名单条目必须名副其实", () => {
  const g = [...importGraph("bind-preview.mjs")].map((f) => path.basename(f));
  assert.ok(!g.includes("outbound.mjs"),
    "预览入口不能传递依赖到能发消息的代码，实际依赖：" + g.join(", "));
  assert.ok(!g.includes("drain-outbox.mjs"), "也不能间接拉进发布器：" + g.join(", "));
  assert.ok(g.includes("bind-compose.mjs") && g.includes("chain-template.mjs"), "该有的还得有");
});

test("bind-preview 的代码里不出现任何执行外部命令的手段", () => {
  // 先剥注释：文件头那段说明本来就要提 outbound 依赖 execFileSync 这件事，
  // 提到它和用它是两回事，检查用的必须是代码。
  const code = fs.readFileSync(path.resolve("scripts", "bind-preview.mjs"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["child_process", "execFile", "execSync", "spawn", "lark-cli"]) {
    assert.ok(!code.includes(bad), "预览入口的代码里不该出现 " + bad);
  }
});

test("对照：bind-project 确实依赖 outbound（否则上面那条测试是空的）", () => {
  const g = [...importGraph("bind-project.mjs")].map((f) => path.basename(f));
  assert.ok(g.includes("outbound.mjs"), "真发那条路径本来就该依赖 outbound");
});

// ---------- 入站多绑定路由 ----------

function routeFixture(projects) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-route-"));
  const regFile = path.join(home, "registry.json");
  const tplFile = path.join(home, "chain-config.json");
  fs.writeFileSync(tplFile, JSON.stringify(TPL));
  const entries = projects.map((p) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-p-"));
    return { id: p.id, root, root_message_id: "om_" + p.id,
      expires_at: "2099-01-01T00:00:00Z", ...p.extra };
  });
  fs.writeFileSync(regFile, JSON.stringify({ projects: entries }));
  return { regFile, tplFile, entries };
}

const files = (f) => ({ registryFile: f.regFile, templateFile: f.tplFile });

test("session_id 对上哪个项目就路由到哪个", () => {
  const f = routeFixture([
    { id: "a", extra: { session_id: "session_a", inbound_state: "bound" } },
    { id: "b", extra: { session_id: "session_b", inbound_state: "bound" } },
  ]);
  const r = findBindingForSession({ sessionId: "session_b", ...files(f) });
  assert.equal(r.ok, true);
  assert.equal(r.id, "b");
  assert.equal(r.root, f.entries[1].root);
});

test("认不出的 session → 不路由（绝不退回默认项目）", () => {
  const f = routeFixture([{ id: "a", extra: { session_id: "session_a", inbound_state: "bound" } }]);
  const r = findBindingForSession({ sessionId: "session_unknown", ...files(f) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_binding_for_session");
});

test("还没绑的项目（session_id 为 null）永远不会被 session 路由选中", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  for (const sid of ["session_x", "null", ""]) {
    assert.equal(findBindingForSession({ sessionId: sid, ...files(f) }).ok, false, sid);
  }
});

test("绑定被停用（status 非 active）→ 不路由", () => {
  const f = routeFixture([
    { id: "a", extra: { session_id: "session_a", inbound_state: "bound", status: "closed" } },
  ]);
  assert.equal(findBindingForSession({ sessionId: "session_a", ...files(f) }).ok, false);
});

// ---------- 第二段绑定：@ 一下就完成 ----------

const NOW2 = Date.parse("2026-08-20T12:00:00Z");
const okEvent = {
  message_id: "msg_new", session_id: "session_fresh", sender_id: TPL.frank_sender_id,
  created_at_ms: NOW2 - 3000, content: '<at id="ou_t">T</at>',
};

const pendingOf = (f, extra = {}) => {
  const reg = JSON.parse(fs.readFileSync(f.regFile, "utf-8"));
  reg.projects[0] = { ...reg.projects[0], inbound_state: "pending",
    bound_at: new Date(NOW2 - 60_000).toISOString(), ...extra };
  fs.writeFileSync(f.regFile, JSON.stringify(reg));
  return findPendingBinding({ ...files(f), now: NOW2 });
};

test("全机唯一那份待绑定 + 授权发送者 + 真实 mention → 放行", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  const r = evaluatePromotion({ event: okEvent, template: TPL, pending: pendingOf(f), now: NOW2 });
  assert.equal(r.ok, true);
  assert.equal(r.id, "a");
});

test("不是 Frank 发的 → 拒（绑定前这道闸就在）", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  const r = evaluatePromotion({
    event: { ...okEvent, sender_id: "9999" }, template: TPL, pending: pendingOf(f), now: NOW2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PROMOTE_REJECT.SENDER_NOT_FRANK);
});

test("没有真实 <at> → 拒；手打的 @名字 不算", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  for (const content of ["随便说说", "@T 干活", '<at id="ou_other">别人</at>']) {
    const r = evaluatePromotion({
      event: { ...okEvent, content }, template: TPL, pending: pendingOf(f), now: NOW2 });
    assert.equal(r.reason, PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED, content);
  }
});

test("消息太旧 → 拒，防重放", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  const r = evaluatePromotion({
    event: { ...okEvent, created_at_ms: NOW2 - 60 * 60 * 1000 },
    template: TPL, pending: pendingOf(f), now: NOW2 });
  assert.equal(r.reason, PROMOTE_REJECT.STALE_MESSAGE);
});

test("没有待绑定 → 拒，不去乱认一个项目", () => {
  const f = routeFixture([{ id: "a", extra: { session_id: "session_a", inbound_state: "bound" } }]);
  const r = evaluatePromotion({
    event: okEvent, template: TPL, pending: findPendingBinding({ ...files(f), now: NOW2 }), now: NOW2 });
  assert.equal(r.reason, PROMOTE_REJECT.NO_PENDING);
});

test("同时有两份待绑定 → 拒。认领靠的就是「只有一份」这个前提", () => {
  const f = routeFixture([{ id: "a", extra: {} }, { id: "b", extra: {} }]);
  const reg = JSON.parse(fs.readFileSync(f.regFile, "utf-8"));
  for (const p of reg.projects) { p.inbound_state = "pending"; p.bound_at = new Date(NOW2 - 60_000).toISOString(); }
  fs.writeFileSync(f.regFile, JSON.stringify(reg));
  const pending = findPendingBinding({ ...files(f), now: NOW2 });
  assert.equal(pending.reason, PROMOTE_REJECT.MULTIPLE_PENDING);
  const r = evaluatePromotion({ event: okEvent, template: TPL, pending, now: NOW2 });
  assert.equal(r.reason, PROMOTE_REJECT.MULTIPLE_PENDING);
});

test("待绑定超过 24 小时 → 过期，重新接入", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  const pending = pendingOf(f, { bound_at: new Date(NOW2 - PENDING_WINDOW_MS - 1000).toISOString() });
  assert.equal(pending.reason, PROMOTE_REJECT.PENDING_EXPIRED);
});

test("待绑定连接入时间都没有 → 当成已过期（fail-closed）", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  const pending = pendingOf(f, { bound_at: undefined });
  assert.equal(pending.reason, PROMOTE_REJECT.PENDING_EXPIRED);
});

test("机器级配置不全 → 拒，绝不因为「反正是 Frank」放行", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  const pending = pendingOf(f);
  for (const bad of [{ frank_sender_id: undefined }, { transport_open_id: undefined },
                     { default_freshness_ms: "900000" }, { default_freshness_ms: true }]) {
    const r = evaluatePromotion({ event: okEvent, template: { ...TPL, ...bad }, pending, now: NOW2 });
    assert.equal(r.reason, PROMOTE_REJECT.MALFORMED_TEMPLATE, JSON.stringify(bad));
  }
  assert.equal(evaluatePromotion({ event: okEvent, template: null, pending, now: NOW2 }).reason,
    PROMOTE_REJECT.MALFORMED_TEMPLATE);
});

test("Claude 旧登记只读投影成 Subscription v1，不泄露项目与会话 locator", () => {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve("references", "subscription-v1.schema.json"), "utf-8",
  ));
  assert.equal(schema.properties.schema_version.const, SUBSCRIPTION_SCHEMA_VERSION);
  assert.equal(schema.properties.artifact_type.const, SUBSCRIPTION_ARTIFACT_TYPE);
  assert.equal(schema.properties.scope.properties.event_types.items.const, "im.message.receive");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-subscription-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-domain-"));
  const regFile = path.join(home, "registry.json");
  const tplFile = path.join(home, "chain-config.json");
  const projects = [
    {
      id: "project-line", root,
    },
    {
      id: "session-line", root, claude_session_id: "claude-secret-session",
      root_message_id: "om_session", status: "suspended", inbound_state: "pending",
      pending_token: "bbbbbb",
      bound_at: new Date(NOW2 - 60_000).toISOString(),
    },
  ];
  fs.writeFileSync(regFile, JSON.stringify({ projects }));
  fs.writeFileSync(tplFile, JSON.stringify(TPL));
  const runtimeDir = path.join(root, ".runtime-data", "inbound");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "active-mapping.json"), JSON.stringify({
    status: "active", inbound_state: "pending", session_id: null,
    pending_token: "aaaaaa", created_at: new Date(NOW2 - 60_000).toISOString(),
    feishu_root_message_id_reference: "om_project",
  }));
  const before = fs.readFileSync(regFile, "utf-8");

  const model = buildClaudeSubscriptionProjection({ registryFile: regFile, templateFile: tplFile });
  assert.equal(model.ok, true);
  assert.equal(model.schema_version, SUBSCRIPTION_SCHEMA_VERSION);
  assert.equal(model.subscriptions.length, 1, "同 endpoint/domain/chat 只产生一份订阅");
  assert.equal(model.pending_bindings.length, 2, "两条本地工作线仍各自保留待认领目标");
  assert.equal(model.subscriptions[0].status, "active", "旧 project-file active 绑定不能被漏投影");
  assert.equal(model.subscriptions[0].artifact_type, SUBSCRIPTION_ARTIFACT_TYPE);
  assert.equal(validateSubscription(model.subscriptions[0]).ok, true);
  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("claude-secret-session"), false);
  assert.equal(fs.readFileSync(regFile, "utf-8"), before, "只读迁移不能改旧登记");
  assert.equal(fs.existsSync(path.join(home, "subscriptions")), false);
});

test("Claude 首次认领 shadow 与现行绑定码选择一致，但不会假装已核验 chat", () => {
  const f = pendingFixture([{ id: "a", token: "aaaaaa" }, { id: "b", token: "bbbbbb" }]);
  const event = {
    ...okEvent,
    content: '<at id="ou_t">T</at>\n\n**[引用]**\n绑定码    bbbbbb',
  };
  const pending = findPendingBinding({ content: event.content, ...f, now: NOW2 });
  const legacy = evaluatePromotion({ event, template: TPL, pending, now: NOW2 });
  const registryBefore = fs.readFileSync(f.registryFile, "utf-8");
  const shadow = shadowClaudeFirstClaim({
    event, template: TPL, callerAgentUid: TPL.agent_uid,
    legacyPending: pending, legacyPromotion: legacy,
    registryFile: f.registryFile, templateFile: f.templateFile, now: NOW2,
  });
  assert.equal(shadow.match, true);
  assert.deepEqual(shadow.scope_unverified, ["chat_id"]);
  assert.equal(fs.readFileSync(f.registryFile, "utf-8"), registryBefore);
});

test("Claude shadow 能记录旧逻辑与新订阅授权的差异，而不改变旧结果", () => {
  const f = routeFixture([{
    id: "paused", extra: {
      status: "paused", inbound_state: "pending", pending_token: "aaaaaa",
      bound_at: new Date(NOW2 - 60_000).toISOString(),
    },
  }]);
  const event = {
    ...okEvent,
    content: '<at id="ou_t">T</at>\n\n**[引用]**\n绑定码    aaaaaa',
  };
  const pending = findPendingBinding({ content: event.content, ...files(f), now: NOW2 });
  const legacy = evaluatePromotion({ event, template: TPL, pending, now: NOW2 });
  assert.equal(legacy.ok, true, "现行 Claude 路径仍保持原行为");
  const shadow = shadowClaudeFirstClaim({
    event, template: TPL, callerAgentUid: TPL.agent_uid,
    legacyPending: pending, legacyPromotion: legacy,
    ...files(f), now: NOW2,
  });
  assert.equal(shadow.match, false);
  assert.equal(shadow.legacy_disposition, "accepted");
  assert.equal(shadow.candidate_disposition, "rejected");
  assert.equal(shadow.candidate_reason, SUBSCRIPTION_REJECT.NO_ACTIVE_SUBSCRIPTION);
});

test("shadow 总 match 不掩盖同为拒绝但 reason 不同", () => {
  const shadow = compareFirstClaimShadow({
    legacy: { ok: false, reason: "no_pending_binding" },
    candidate: { ok: false, reason: "no_active_subscription" },
  });
  assert.equal(shadow.route_match, true);
  assert.equal(shadow.reason_match, false);
  assert.equal(shadow.match, false);
});

test("绑定写回登记表之后，同一个 session 就能被路由到了", () => {
  const f = routeFixture([{ id: "a", extra: {} }]);
  pendingOf(f);
  assert.equal(findBindingForSession({ sessionId: "session_fresh", ...files(f) }).ok, false);

  const w = promoteBinding({ root: f.entries[0].root, sessionId: "session_fresh", registryFile: f.regFile });
  assert.equal(w.ok, true);

  const r = findBindingForSession({ sessionId: "session_fresh", ...files(f) });
  assert.equal(r.ok, true);
  assert.equal(r.id, "a");
  assert.equal(r.mapping.inbound_state, "bound");
  // 绑完就不再是待绑定，下一个新项目才认得出自己是唯一那份
  assert.equal(findPendingBinding({ ...files(f), now: NOW2 }).reason, PROMOTE_REJECT.NO_PENDING);
});

test("绑定写回不会碰到别的字段", () => {
  const f = routeFixture([{ id: "a", extra: { name: "我的项目", purpose: "干这个的" } }]);
  promoteBinding({ root: f.entries[0].root, sessionId: "session_fresh", registryFile: f.regFile });
  const reg = JSON.parse(fs.readFileSync(f.regFile, "utf-8"));
  assert.equal(reg.projects[0].name, "我的项目");
  assert.equal(reg.projects[0].purpose, "干这个的");
  assert.equal(reg.projects[0].root_message_id, "om_a");
});

// ---------- 幂等：登记表接入的项目也得有已消费列表 ----------

test("已消费列表：去重、有上限、读得回来", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-consumed-"));
  assert.deepEqual(loadConsumed(d), []);
  appendConsumed(d, "msg_1");
  appendConsumed(d, "msg_1");
  appendConsumed(d, "msg_2");
  assert.deepEqual(loadConsumed(d), ["msg_1", "msg_2"]);
  for (let i = 0; i < 12; i += 1) appendConsumed(d, "m" + i, { max: 5 });
  assert.equal(loadConsumed(d).length, 5);
  assert.ok(loadConsumed(d).includes("m11"), "留下的该是最近的");
});

test("登记表接入的 mapping 必须带上授权发送者 —— 否则每条消息都被判成发错人", () => {
  const f = routeFixture([{ id: "a", extra: { session_id: "session_a", inbound_state: "bound" } }]);
  const r = findBindingForSession({ sessionId: "session_a", ...files(f) });
  assert.equal(r.mapping.frank_sender_id, TPL.frank_sender_id);
  const v = evaluateInbound({
    event: { message_id: "msg_ok", session_id: "session_a", sender_id: TPL.frank_sender_id,
             created_at_ms: Date.now(), content: '<at id="ou_t">T</at> 干活' },
    mapping: r.mapping, config: r.config, now: Date.now() });
  assert.equal(v.decision, "accept", "理由：" + (v.reasonText ?? ""));
  assert.equal(v.instruction, "干活");
});

test("已消费列表会进 mapping —— 幂等那道闸才拦得住重复消息", () => {
  const f = routeFixture([{ id: "a", extra: { session_id: "session_a", inbound_state: "bound" } }]);
  appendConsumed(f.entries[0].root, "msg_seen");
  const r = findBindingForSession({ sessionId: "session_a", ...files(f) });
  assert.deepEqual(r.mapping.consumed_message_ids, ["msg_seen"]);
  const v = evaluateInbound({
    event: { message_id: "msg_seen", session_id: "session_a", sender_id: TPL.frank_sender_id,
             created_at_ms: Date.now(), content: '<at id="ou_t">T</at> 再来一次' },
    mapping: r.mapping, config: r.config, now: Date.now() });
  assert.equal(v.reason, REJECT.DUPLICATE_MESSAGE);
});

// ---------- lark-cli 的环境变量名（写错了不会报错，只会安静地不生效） ----------

test("出站传的是 LARKSUITE_CLI_CONFIG_DIR，不是那个不存在的 LARKSUITE_CLI_HOME", () => {
  const src = fs.readFileSync(path.resolve("scripts", "outbound.mjs"), "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes("LARKSUITE_CLI_CONFIG_DIR"), "必须用真实存在的那个变量名");
  assert.ok(!code.includes("LARKSUITE_CLI_HOME"),
    "LARKSUITE_CLI_HOME 在 lark-cli 二进制里出现 0 次 —— 设了等于没设，而且不会报错");
  // 两个共用发送入口都得钉住身份：只钉一个，另一个就会在 agent 的清洗环境里拿错身份。
  assert.equal((code.match(/LARKSUITE_CLI_CONFIG_DIR/g) ?? []).length, 2);
  assert.equal((code.match(/LARKSUITE_CLI_PROFILE/g) ?? []).length, 2);
});

// ---------- 身份解析与凭据归属校验 ----------

const TPL2 = { ...TPL, agent_uid: "agent_x1", lark_cli_config_base: "/base",
  transport_app_id: "cli_transport", outbound_app_id: "cli_outbound" };

test("双智能体：凭据目录用 lark_cli_home，不去碰 agent 私有目录", () => {
  const id = resolveLarkIdentity(TPL2);
  assert.equal(id.singleAgent, false);
  assert.equal(id.configDir, TPL2.lark_cli_home);
  assert.equal(id.expectedAppId, "cli_outbound");
});

test("单智能体：凭据目录 = 基路径 + agent_uid，从配置推不另加开关", () => {
  const id = resolveLarkIdentity({ ...TPL2, outbound_app_id: "cli_transport" });
  assert.equal(id.singleAgent, true);
  assert.equal(id.configDir, path.join("/base", "agent_x1"));
});

test("基路径没配时用默认，不至于算出一个以 undefined 结尾的路径", () => {
  const { lark_cli_config_base, ...noBase } = TPL2;
  const id = resolveLarkIdentity({ ...noBase, outbound_app_id: "cli_transport" });
  assert.ok(id.configDir.endsWith("agent_x1"));
  assert.ok(!id.configDir.includes("undefined"));
});

function credDir(apps) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-cred-"));
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ apps }));
  return d;
}

test("凭据目录里就是配置说的那个应用 → 放行", () => {
  const d = credDir([{ name: "platform-bot", appId: "cli_me" }]);
  const r = assertPublishIdentity({ configDir: d, profile: "platform-bot", expectedAppId: "cli_me" });
  assert.equal(r.ok, true);
});

test("凭据目录属于另一个应用 → 拒绝，一个字都不发", () => {
  const d = credDir([{ name: "platform-bot", appId: "cli_someone_else" }]);
  const r = assertPublishIdentity({ configDir: d, profile: "platform-bot", expectedAppId: "cli_me" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "app_id_mismatch");
});

test("目录不存在（aily 被卸载/清理）→ 拒绝，且原因要说得让人看懂", () => {
  const r = assertPublishIdentity({ configDir: "/nope/nope", profile: "p", expectedAppId: "cli_me" });
  assert.equal(r.reason, "config_dir_unreadable");
});

test("目录里没有那个 profile → 拒绝，并列出它到底有哪些", () => {
  const d = credDir([{ name: "别的", appId: "cli_x" }, { name: "还有别的", appId: "cli_y" }]);
  const r = assertPublishIdentity({ configDir: d, profile: "platform-bot", expectedAppId: "cli_me" });
  assert.equal(r.reason, "profile_not_found");
  assert.deepEqual(r.have, ["别的", "还有别的"]);
});

test("只有一个无名 app 时按它算 —— 普通 lark-cli home 第一个就是这样", () => {
  const d = credDir([{ appId: "cli_me" }]);
  assert.equal(assertPublishIdentity({ configDir: d, profile: "任意", expectedAppId: "cli_me" }).ok, true);
});

// ---------- 形状与前后一致 ----------

test("app id 不是 cli_ 开头 → 判配错（交叉校验要靠它当依据）", () => {
  assert.ok(validateChainTemplate({ ...TPL, transport_app_id: "aaf8be" }).malformed
    .includes("transport_app_id"));
  assert.ok(validateChainTemplate({ ...TPL, outbound_app_id: "notcli_x" }).malformed
    .includes("outbound_app_id"));
});

test("agent_uid 不是 agent_ 开头 → 判配错（它现在是凭据目录的推导依据）", () => {
  const v = validateChainTemplate({ ...TPL, agent_uid: "4ks11dv8f0mxwbd" });
  assert.ok(v.malformed.includes("agent_uid"));
});

test("frank_sender_id 必须是纯数字 —— 抄成飞书 ou_ 会被当场挡下", () => {
  assert.ok(validateChainTemplate({ ...TPL, frank_sender_id: "ou_1f48a7f7fcb9" }).malformed.includes("frank_sender_id"));
  assert.ok(validateChainTemplate({ ...TPL, frank_sender_id: 762102 }).malformed.includes("frank_sender_id"));
  assert.ok(validateChainTemplate({ ...TPL, frank_sender_id: "7621020633916345545" }).ok);
});

test("单智能体但两个 open_id 不一致 → 判前后矛盾，不让它变成装饰字段", () => {
  const v = validateChainTemplate({
    ...TPL, transport_app_id: "cli_same", outbound_app_id: "cli_same",
    transport_open_id: "ou_a", outbound_open_id: "ou_b",
  });
  assert.equal(v.ok, false);
  assert.equal(v.inconsistent.length, 1);
});

test("可选字段缺了不算错，填了就得填对", () => {
  assert.ok(validateChainTemplate(TPL).ok, "没有 lark_cli_config_base 也该通过");
  assert.ok(validateChainTemplate({ ...TPL, lark_cli_config_base: "相对路径" }).malformed
    .includes("lark_cli_config_base"));
});

// ---------- 入站第 0 道闸 ----------

test("入站脚本在取信封之前就校验调用方 agent", () => {
  const src = fs.readFileSync(path.resolve("scripts", "inbound.mjs"), "utf-8");
  const gate = src.indexOf("caller_agent_mismatch");
  const fetch = src.indexOf("fetchTriggerEvent()");
  assert.ok(gate > 0 && fetch > 0);
  assert.ok(gate < fetch, "调用方校验必须排在取信封之前，否则已经替别的 agent 取过事件了");
});

test("Claude/Codex 已绑定授权 shadow 都在 verdict 后旁路，且默认不开启", () => {
  for (const file of ["scripts/inbound.mjs", "scripts/codex/inbound.mjs"]) {
    const src = fs.readFileSync(path.resolve(file), "utf-8");
    const verdict = src.indexOf("const verdict = evaluateMappingAdmission");
    const enabled = src.indexOf("dialogueAuthorizationShadowEnabled()", verdict);
    const record = src.indexOf("recordDialogueBoundAuthorizationShadow({", enabled);
    const claim = src.indexOf("acquireClaim({", record);
    assert.ok(verdict >= 0 && enabled > verdict && record > enabled && claim > record, file);
    assert.ok(src.includes("catch { /* shadow 永不承重 */ }"), file);
  }
});

test("这道闸只能用机器级模板 —— 用项目配置会变成循环", () => {
  const src = fs.readFileSync(path.resolve("scripts", "inbound.mjs"), "utf-8");
  const gate = src.indexOf("callerAgent !== bootTpl.template.agent_uid");
  assert.ok(gate > 0, "比对的必须是模板里的 agent_uid");
  // 找**调用点**，不是 import 那一行 —— import 永远排在最前面，拿它比等于没比。
  const route = src.indexOf("findBindingForSession({ sessionId");
  assert.ok(route > 0 && gate < route, "必须在路由之前");
});

// ---------- 链路级字段以模板为准 ----------

test("项目文件里的链路级字段被模板压过去 —— 免得同机两个身份并存", () => {
  const { proj, regFile, tplFile } = bindFixture();
  const rt = path.join(proj, ".runtime-data", "inbound");
  fs.mkdirSync(rt, { recursive: true });
  fs.writeFileSync(path.join(rt, "active-mapping.json"),
    JSON.stringify({ status: "active", expires_at: "2099-01-01T00:00:00Z", feishu_root_message_id_reference: "om_x" }));
  fs.writeFileSync(path.join(rt, "chain-config.json"), JSON.stringify({
    lark_cli_profile: "老身份", outbound_agent_name: "老名字",
    task_display_name: "项目自己的显示名",
  }));
  const r = resolveProject({ root: proj, registryFile: regFile, templateFile: tplFile });
  assert.equal(r.source, "project-files");
  assert.equal(r.config.lark_cli_profile, TPL.lark_cli_profile, "链路级字段该来自模板");
  assert.equal(r.config.task_display_name, "项目自己的显示名", "项目级字段该保留");
});

// ---------- 与 Codex 链路的共用边界（scripts/outbox.mjs 是两边唯一的接触面） ----------
//
// Codex 适配层从这个仓库 import 了十个共用模块，其中 outbox.mjs 已经被它改过一次
// （加了 eventKey / publishEligible / publish_suppressed_at）。改得很克制，
// 但「克制」不是一个能被回归测试保证的性质 —— 下面这几条把 Claude 侧依赖的行为钉死，
// 免得下一次共用改动悄悄改掉 Claude 的语义。

function freshOutbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-shared-"));
}

test("Claude 的调用方式（不传 eventKey）仍按内容指纹判重", () => {
  const d = freshOutbox();
  const a = appendEvent({ outboxDir: d, kind: "risk", text: "同一句话", source: "t" });
  const b = appendEvent({ outboxDir: d, kind: "risk", text: "同一句话", source: "t" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "duplicate");
  // 换 kind 就是另一条：指纹算的是 kind + 正文
  assert.equal(appendEvent({ outboxDir: d, kind: "next", text: "同一句话", source: "t" }).ok, true);
});

test("Claude 的文件名仍是「时间戳-指纹」，没有被换成事件键那种确定性命名", () => {
  const d = freshOutbox();
  const r = appendEvent({ outboxDir: d, kind: "milestone", text: "x", source: "t" });
  assert.match(path.basename(r.file), /^\d{13}-[0-9a-f]{16}\.json$/,
    "文件名格式变了会影响 listPending 的排序（它按文件名排，时间前缀就是时序）");
  assert.ok(!path.basename(r.file).startsWith("event-"));
});

test("Claude 写的事件没有发布资格标记，但照样能被 Claude 排空", () => {
  const d = freshOutbox();
  appendEvent({ outboxDir: d, kind: "risk", text: "要发出去的", source: "t" });
  const [rec] = listPending({ outboxDir: d });
  // Codex 的自动发布只消费 publish_eligible_at 非空的事件；Claude 不用这套，
  // 所以这里是 null —— 但它绝不能因此被 Claude 自己的 listPending 漏掉。
  assert.equal(rec.publish_eligible_at, null);
  assert.equal(rec.published_at, null);
  assert.equal(rec.text, "要发出去的");
});

test("listPending 的新过滤条件不会误伤 Claude 的老记录", () => {
  const d = freshOutbox();
  const r = appendEvent({ outboxDir: d, kind: "next", text: "老记录", source: "t" });
  // 模拟升级前写下的记录：没有 publish_eligible_at / publish_suppressed_at 这两个键
  const old = JSON.parse(fs.readFileSync(r.file, "utf-8"));
  delete old.publish_eligible_at;
  delete old.event_key;
  fs.writeFileSync(r.file, JSON.stringify(old));
  assert.equal(listPending({ outboxDir: d }).length, 1, "缺新字段的老记录必须照样待发");
});

test("被标记 suppressed 的事件不再待发 —— Claude 不写它，但要认它", () => {
  const d = freshOutbox();
  const r = appendEvent({ outboxDir: d, kind: "risk", text: "半成品", source: "t" });
  const rec = JSON.parse(fs.readFileSync(r.file, "utf-8"));
  fs.writeFileSync(r.file, JSON.stringify({ ...rec, publish_suppressed_at: new Date().toISOString() }));
  assert.equal(listPending({ outboxDir: d }).length, 0);
});

test("Claude 不依赖 scripts/codex/ 里的任何东西", () => {
  const dir = path.resolve("scripts");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/from\s+["'][^"']*codex\//.test(src),
      f + " 不该 import codex 目录 —— 依赖必须是单向的（codex 依赖共用代码，不能反过来）");
  }
});

// ---------- 共用面快照：让「共用代码被悄悄扩大」变成一次必须过目的评审 ----------

test("共用模块清单是从代码数出来的，不是手写的", () => {
  const mods = sharedModules();
  assert.ok(mods.length > 0, "适配层存在时应当数得出共用模块");
  assert.ok(mods.includes("outbox.mjs"), "outbox 是已知的接触面");
  // 手写清单会漏：适配层哪天多 import 一个模块，清单不会自己长出来，
  // 而那个新进来的模块正好是没人守着的那个。
  assert.deepEqual(mods, [...mods].sort(), "清单要稳定排序，否则快照会有假差异");
});

test("共用模块的导出面与快照一致", () => {
  const snapshot = loadSnapshot();
  assert.ok(snapshot, "缺快照：跑 node scripts/shared-surface.mjs --update");
  const problems = diffSurface(snapshot, LIVE_SURFACE);
  assert.deepEqual(problems, [],
    "共用面变了。这不一定是错，但必须是有人点头的决定 —— 确认后跑 --update 认下来");
});

test("导出变多会被抓到 —— 这是最值得停下来看的一种", () => {
  const before = { "outbox.mjs": ["appendEvent", "listPending"] };
  const after = { "outbox.mjs": ["appendEvent", "listPending", "markPublishEligibleByEventKey"] };
  const p = diffSurface(before, after);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "export_added");
  assert.deepEqual(p[0].names, ["markPublishEligibleByEventKey"]);
});

test("导出变少、以及新增一个此前没有契约保护的共用模块，都会被抓到", () => {
  assert.equal(diffSurface({ "a.mjs": ["x", "y"] }, { "a.mjs": ["x"] })[0].kind, "export_removed");
  assert.equal(diffSurface({}, { "new.mjs": ["x"] })[0].kind, "new_shared_module");
});

// ---------- 一个项目多条工作线：会话级绑定 ----------
//
// 整组的验收标准只有一条：**只用一个会话的人，行为一字不差。**
// 会话级是加法，项目级永远是默认和兜底 —— 它天然扛得住终端重启，
// 而那正是当年钉死会话 UUID 那个失败方案缺的东西。

const PROJ_ENTRY = { id: "p", root: "/r", root_message_id: "om_project" };
const SESS_A = { id: "p@aaa", root: "/r", root_message_id: "om_a", claude_session_id: "aaa-111" };
const SESS_B = { id: "p@bbb", root: "/r", root_message_id: "om_b", claude_session_id: "bbb-222" };

test("只有项目级绑定时，任何会话都选中它 —— 行为跟以前一样", () => {
  for (const sid of ["aaa-111", "随便", undefined, null, ""]) {
    const r = selectBindingEntry([PROJ_ENTRY], sid);
    assert.equal(r.entry, PROJ_ENTRY, String(sid));
    assert.equal(r.level, "project");
  }
});

test("会话对得上就走会话级，对不上回落项目级", () => {
  const all = [PROJ_ENTRY, SESS_A, SESS_B];
  assert.equal(selectBindingEntry(all, "aaa-111").entry, SESS_A);
  assert.equal(selectBindingEntry(all, "bbb-222").entry, SESS_B);
  assert.equal(selectBindingEntry(all, "无人认领").entry, PROJ_ENTRY);
  assert.equal(selectBindingEntry(all, "无人认领").level, "project");
});

test("只有会话级、没有项目级时，不匹配的会话算没接桥（绝不乱认一条）", () => {
  const r = selectBindingEntry([SESS_A, SESS_B], "ccc-333");
  assert.equal(r.entry, null);
  assert.equal(r.level, null);
});

test("outbox 目录跟着绑定走：项目级的路径一个字节没变", () => {
  assert.equal(outboxDirOf("/r"), path.join("/r", ".runtime-data", "outbound", "outbox"));
  assert.equal(outboxDirOf("/r", null), path.join("/r", ".runtime-data", "outbound", "outbox"));
  assert.equal(outboxDirOf("/r", "aaa-111"),
    path.join("/r", ".runtime-data", "outbound", "outbox-aaa-111"));
});

test("两条线的 outbox 必须分开 —— 共用会把 A 的进展发到 B 的话题里", () => {
  assert.notEqual(outboxDirOf("/r", "aaa-111"), outboxDirOf("/r", "bbb-222"));
  assert.notEqual(outboxDirOf("/r", "aaa-111"), outboxDirOf("/r"));
});

test("幂等列表也按绑定分，项目级路径不变", () => {
  assert.match(consumedPath("/r"), /consumed\.json$/);
  assert.match(consumedPath("/r", "aaa-111"), /consumed-aaa-111\.json$/);
});

test("resolveProject 按会话选中对的那条绑定", () => {
  const { proj, regFile, tplFile } = bindFixture();
  fs.writeFileSync(regFile, JSON.stringify({ projects: [
    { id: "p", root: proj, root_message_id: "om_project", expires_at: "2099-01-01T00:00:00Z" },
    { id: "p@aaa", root: proj, root_message_id: "om_a", claude_session_id: "aaa-111",
      expires_at: "2099-01-01T00:00:00Z" },
  ] }));
  const f = { registryFile: regFile, templateFile: tplFile };
  const bySession = resolveProject({ root: proj, claudeSessionId: "aaa-111", ...f });
  assert.equal(bySession.mapping.feishu_root_message_id_reference, "om_a");
  assert.equal(bySession.bindingLevel, "session");
  assert.equal(bySession.claudeSessionId, "aaa-111");

  const fallback = resolveProject({ root: proj, claudeSessionId: "没绑过的", ...f });
  assert.equal(fallback.mapping.feishu_root_message_id_reference, "om_project");
  assert.equal(fallback.bindingLevel, "project");
  assert.equal(fallback.claudeSessionId, null, "项目级绑定不该带出会话 id，否则 outbox 会走错目录");

  // 不传会话（老调用方）也必须落到项目级
  assert.equal(resolveProject({ root: proj, ...f }).mapping.feishu_root_message_id_reference, "om_project");
});

test("会话级 mapping 把会话 id 带给入站，项目级带 null", () => {
  assert.equal(mappingFromRegistryEntry(SESS_A).claude_session_id, "aaa-111");
  assert.equal(mappingFromRegistryEntry(PROJ_ENTRY).claude_session_id, null);
});

// ---------- 认自己：两个来源交叉核对 ----------

function sessionsFixture(records) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-sess-"));
  for (const [pid, rec] of Object.entries(records)) {
    fs.writeFileSync(path.join(d, pid + ".json"), JSON.stringify(rec));
  }
  return d;
}

test("环境变量和登记文件都指向同一个会话 → 认出自己", () => {
  const d = sessionsFixture({ "999": { sessionId: "aaa-111", name: "线A", cwd: "/r", kind: "interactive" } });
  const r = identifySelf({ env: { CLAUDE_CODE_SESSION_ID: "aaa-111", CLAUDE_PID: "999" }, sessionsDir: d });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, "aaa-111");
  assert.equal(r.name, "线A");
  assert.equal(r.cwd, "/r");
});

test("两个来源对不上 → 拒绝。只信环境变量会在派生进程里绑错线", () => {
  const d = sessionsFixture({ "999": { sessionId: "别人", name: "线B", cwd: "/r", kind: "interactive" } });
  const r = identifySelf({ env: { CLAUDE_CODE_SESSION_ID: "aaa-111", CLAUDE_PID: "999" }, sessionsDir: d });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "session_mismatch");
});

test("无头会话不能绑 —— 它跑完就没了", () => {
  const d = sessionsFixture({ "999": { sessionId: "aaa-111", name: "临时工", cwd: "/r", kind: "headless" } });
  assert.equal(identifySelf({ env: { CLAUDE_CODE_SESSION_ID: "aaa-111", CLAUDE_PID: "999" }, sessionsDir: d }).reason,
    "not_interactive");
});

test("不在 Claude 会话里跑 → 说清楚为什么，而不是绑出一条假的", () => {
  const d = sessionsFixture({});
  assert.equal(identifySelf({ env: {}, sessionsDir: d }).reason, "no_session_env");
  assert.equal(identifySelf({ env: { CLAUDE_CODE_SESSION_ID: "x" }, sessionsDir: d }).reason, "no_pid_env");
  assert.equal(identifySelf({ env: { CLAUDE_CODE_SESSION_ID: "x", CLAUDE_PID: "1" }, sessionsDir: d }).reason,
    "no_session_record");
});

test("会话级登记行带齐会话标识，且 id 能区分同项目的多条", () => {
  const e = newSessionEntry({ root: "/r", name: "n", token: "t", rootMessageId: "om_a",
    claudeSessionId: "aaa-111-long-uuid", sessionName: "线A" });
  assert.equal(e.claude_session_id, "aaa-111-long-uuid");
  assert.equal(e.claude_session_name, "线A");
  assert.equal(e.id, "r@aaa-111-");
  assert.equal(e.root_message_id, "om_a");
});

// ---------- 投递：找指定的那条线 ----------

test("findLiveSessionById 只认指定的那个，不退而求其次", () => {
  const d = sessionsFixture({
    "111": { sessionId: "aaa-111", name: "线A", cwd: "/r", kind: "interactive", startedAt: 1 },
    "222": { sessionId: "bbb-222", name: "线B", cwd: "/r", kind: "interactive", startedAt: 9 },
  });
  const opts = { projectRoot: "/r", sessionsDir: d, isAlive: () => true };
  assert.equal(findLiveSessionById({ ...opts, claudeSessionId: "aaa-111" }).name, "线A",
    "即使线B更晚开，指定了线A就必须是线A");
  assert.equal(findLiveSessionById({ ...opts, claudeSessionId: "不存在" }), null,
    "找不到要返回 null，让调用方去 --resume 或如实拒绝，而不是投给别人");
});

test("入站在绑定会话不在时不回落到别的线", () => {
  const src = fs.readFileSync(path.resolve("scripts", "inbound.mjs"), "utf-8");
  assert.ok(src.includes("bound_session_gone"), "要有专门的拒绝原因");
  const gone = src.indexOf("bound_session_gone");
  const cont = src.indexOf("hasPriorSession({ projectRoot: config.project_dir })");
  assert.ok(gone < src.lastIndexOf("hasPriorSession"), "会话级的判断要排在项目级兜底之前");
  assert.ok(cont > 0);
});

// ---------- 控制命令共用状态：status / unbind / bind（恢复） ----------
//
// 语义跟 Codex 侧对齐：暂停是**可恢复**的，绝不删话题、登记、待发内容或历史。
// 实现上只翻绑定自己的 status —— 出站只发 active 的，入站见到非 active 直接拒，
// 一个已有的闸两个方向同时生效，不需要新机制。

function controlFixture({ suspended = false, sessions = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-ctl-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-ctlp-"));
  const regFile = path.join(home, "registry.json");
  const tplFile = path.join(home, "chain-config.json");
  fs.writeFileSync(tplFile, JSON.stringify(TPL));
  const projects = [{
    id: "demo", root: proj, name: "演示", root_message_id: "om_demo",
    expires_at: "2099-01-01T00:00:00Z", session_id: "session_x", inbound_state: "bound",
    ...(suspended ? { status: SUSPENDED } : {}),
  }, ...sessions];
  fs.writeFileSync(regFile, JSON.stringify({ projects }));
  return { proj, regFile, tplFile, f: { registryFile: regFile, templateFile: tplFile } };
}

test("status 只读，且不把话题 id 之类的 locator 打进人类可读输出", () => {
  const { proj, f } = controlFixture();
  const st = currentBinding({ root: proj, ...f });
  const text = describeStatus(st, bindingsForRoot({ root: proj, registryFile: f.registryFile }));
  assert.ok(text.includes("已接入"));
  assert.match(text, /自动轮转\s+0 \/ 30 条有效业务消息/u);
  assert.ok(!text.includes("om_demo"), "话题 id 是 locator，不该出现在状态输出里");
  assert.ok(!text.includes("session_x"), "Aily session 同理");
});

test("status 明确说明只读旧话题仍会接收轮转前受理的迟到结果", () => {
  const text = describeStatus({
    ok: true,
    displayName: "演示",
    suspended: false,
    level: "project",
    claudeSessionId: null,
    activeGeneration: 2,
    pendingGeneration: null,
    pendingGenerationExpiresAt: null,
    readOnlyGenerations: 1,
    inboundBound: true,
    expiresAt: null,
    pending: 0,
  });
  assert.match(text, /只读历史.*轮转前受理的结果仍会发回原话题/u);
  assert.match(text, /自动轮转\s+0 \/ 30 条有效业务消息/u);
});

test("暂停把出站和入站同时关掉 —— 靠的是两边本来就在看的那个字段", () => {
  const { proj, f } = controlFixture();
  const r = setBindingStatus({ root: proj, status: SUSPENDED, registryFile: f.registryFile });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);

  const st = currentBinding({ root: proj, ...f });
  assert.equal(st.suspended, true);

  // 出站：drainProject 只发 active 的
  assert.notEqual(st.status, "active");
  // 入站：evaluateInbound 见到非 active 直接拒
  const mapping = resolveProject({ root: proj, ...f }).mapping;
  const v = evaluateInbound({
    event: { message_id: "m", session_id: "session_x", sender_id: TPL.frank_sender_id,
             created_at_ms: Date.now(), content: '<at id="ou_t">T</at> 干活' },
    mapping, config: { transport_open_id: "ou_t", default_freshness_ms: 900000 }, now: Date.now(),
  });
  assert.equal(v.reason, REJECT.MAPPING_NOT_ACTIVE);
});

test("暂停不删任何东西：话题、登记、待发内容原样还在", () => {
  const { proj, f } = controlFixture();
  const outbox = outboxDirOf(proj);
  appendEvent({ outboxDir: outbox, kind: "next", text: "暂停前写的", source: "t" });

  setBindingStatus({ root: proj, status: SUSPENDED, registryFile: f.registryFile });

  const reg = JSON.parse(fs.readFileSync(f.registryFile, "utf-8"));
  assert.equal(reg.projects.length, 1, "登记行不能被删");
  assert.equal(reg.projects[0].root_message_id, "om_demo", "话题引用必须保留");
  assert.equal(listPending({ outboxDir: outbox }).length, 1, "待发内容必须留着，恢复后要发出去");
});

test("恢复之后一切照旧，且待发内容还在", () => {
  const { proj, f } = controlFixture({ suspended: true });
  const outbox = outboxDirOf(proj);
  appendEvent({ outboxDir: outbox, kind: "next", text: "暂停期间攒的", source: "t" });

  const r = setBindingStatus({ root: proj, status: "active", registryFile: f.registryFile });
  assert.equal(r.changed, true);
  const st = currentBinding({ root: proj, ...f });
  assert.equal(st.suspended, false);
  assert.equal(st.pending, 1, "暂停期间攒下的要还在");
});

test("重复暂停是幂等的，不报错也不重复写", () => {
  const { proj, f } = controlFixture({ suspended: true });
  const r = setBindingStatus({ root: proj, status: SUSPENDED, registryFile: f.registryFile });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
});

test("会话级绑定可以单独暂停，不影响项目级", () => {
  const { proj, f } = controlFixture({ sessions: [{
    id: "demo@aaa", root: "__ROOT__", root_message_id: "om_a", claude_session_id: "aaa-111",
    expires_at: "2099-01-01T00:00:00Z",
  }] });
  // fixture 里 root 要现填
  const reg = JSON.parse(fs.readFileSync(f.registryFile, "utf-8"));
  reg.projects[1].root = proj;
  fs.writeFileSync(f.registryFile, JSON.stringify(reg));

  setBindingStatus({ root: proj, claudeSessionId: "aaa-111", status: SUSPENDED, registryFile: f.registryFile });

  assert.equal(currentBinding({ root: proj, claudeSessionId: "aaa-111", ...f }).suspended, true,
    "被暂停的那条线该停");
  assert.equal(currentBinding({ root: proj, ...f }).suspended, false,
    "项目级不该被连累");
});

test("没接桥时 status 给的是怎么接入，不是一句报错", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-none-"));
  const text = describeStatus(currentBinding({ root: empty }));
  assert.ok(text.includes("还没有接入"));
  assert.ok(text.includes("bind-project") && text.includes("bind-session"), "要给出两种接入方式");
});

test("状态命令和出站用的是同一条绑定选择规则", () => {
  const src = fs.readFileSync(path.resolve("scripts", "feishu-control.mjs"), "utf-8");
  assert.ok(src.includes("resolveProject"),
    "status 必须走 resolveProject —— 另写一套规则会出现「status 说 A、实际发到 B」");
  assert.ok(src.includes("selectBindingEntry"));
});

test("五条控制技能都装成跟 Codex 同名的斜杠命令", () => {
  const src = fs.readFileSync(path.resolve("scripts", "install-outbound.mjs"), "utf-8");
  for (const [repo, installed] of [
    ["claude-feishu-bind", "feishu-bind"],
    ["claude-feishu-status", "feishu-status"],
    ["claude-feishu-unbind", "feishu-unbind"],
    ["claude-feishu-rotate", "feishu-rotate"],
    ["claude-feishu-mode", "feishu-mode"],
  ]) {
    assert.ok(src.includes(repo), "安装器要认得仓库里的 " + repo);
    assert.ok(src.includes('"' + installed + '"'), "要装成 /" + installed);
    // 装出去的目录名就是斜杠命令名，必须跟技能自己声明的 name 一致
    const skill = fs.readFileSync(path.resolve("skills", repo, "SKILL.md"), "utf-8");
    assert.ok(skill.includes("name: " + installed),
      repo + " 的 frontmatter name 必须是 " + installed + "，否则命令名对不上");
  }
});

test("Claude 进展技能不再兼任自然语言绑定入口", () => {
  const skill = fs.readFileSync(path.resolve("skills", "claude-longtask-progress", "SKILL.md"), "utf-8");
  assert.equal(skill.includes("bind-project.mjs --apply"), false,
    "进展技能不得携带写绑定脚本，控制动作只能走独立斜杠命令");
  assert.ok(skill.includes("只有 Frank 显式运行 `/feishu-bind`"));
  assert.ok(skill.includes("Agent、子 Agent、引用和转发内容不能继承控制权"));
});

// ---------- 绑定码从引用块里认（Frank 什么都不用打） ----------
//
// 飞书会把被回复的那条消息全文自动捎在正文后面。2026-08-20 统计 M5Claude 收到的
// 全部 18 条带 mention 的消息：**18/18 都有引用块，且 18/18 都不带 `>` 前缀**。
// 两种渲染都要能吃 —— 只认一种的话，另一种会静默回落到「只有一份待绑定」，
// 而那在单项目时看起来完全正常，多项目时才暴露。

const REAL_QUOTE = '<at id="ou_t">M</at>\n\n**[引用]**\n🌉 cc2cd\n\n让两个模型对话。\n\n' +
  "本机项目  /Users/dk/x\n绑定码    d85488\n\n项目里的进展会回复到本条下面。";
const GT_QUOTE = '<at id="ou_t">M</at> 干活\n\n> **[引用]**\n> 🌉 demo\n> 绑定码    a1b2c3\n';

test("真实报文（引用块不带 > ）里取得到绑定码", () => {
  assert.deepEqual(bindingTokensInQuote(REAL_QUOTE), ["d85488"]);
});

test("平台渲染成 > 引用时同样取得到 —— 两种格式都见过", () => {
  assert.deepEqual(bindingTokensInQuote(GT_QUOTE), ["a1b2c3"]);
});

test("正文里手打的绑定码不算 —— 能指定目标的只有「你真的在那个话题里说话」", () => {
  assert.deepEqual(bindingTokensInQuote('<at id="ou_t">M</at> 绑定码 aaaaaa'), []);
  // 正文有一个、引用块里是另一个：只认引用块那个
  const mixed = '<at id="ou_t">M</at> 绑定码 aaaaaa\n\n**[引用]**\n绑定码    d85488';
  assert.deepEqual(bindingTokensInQuote(mixed), ["d85488"]);
});

test("没有引用块 / 引用块里没有码 → 空数组，回落到「只有一份」那条路", () => {
  assert.deepEqual(bindingTokensInQuote('<at id="ou_t">M</at> 干活'), []);
  assert.deepEqual(bindingTokensInQuote('<at id="ou_t">M</at>\n\n**[引用]**\n老话题，没有绑定码'), []);
  assert.equal(extractQuotedBlock('<at id="ou_t">M</at> 干活'), null);
});

test("引用块里出现多个绑定码 → 歧义，必须拒绝而不是挑一个", () => {
  const two = '<at id="ou_t">M</at>\n\n**[引用]**\n绑定码    d85488\n绑定码    a1b2c3';
  assert.deepEqual(bindingTokensInQuote(two).sort(), ["a1b2c3", "d85488"]);
});

// ---------- 认领：确定性优先，回落不变 ----------

function pendingFixture(specs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-pend-"));
  const regFile = path.join(home, "registry.json");
  const tplFile = path.join(home, "chain-config.json");
  fs.writeFileSync(tplFile, JSON.stringify(TPL));
  const projects = specs.map((sp) => ({
    id: sp.id, root: fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-pp-")),
    root_message_id: "om_" + sp.id, expires_at: "2099-01-01T00:00:00Z",
    inbound_state: "pending", pending_token: sp.token,
    bound_at: new Date(Date.now() - 60_000).toISOString(),
  }));
  fs.writeFileSync(regFile, JSON.stringify({ projects }));
  return { registryFile: regFile, templateFile: tplFile };
}

test("多个项目同时待接入时，靠引用块里的绑定码精确选中", () => {
  const f = pendingFixture([{ id: "a", token: "aaaaaa" }, { id: "b", token: "bbbbbb" }]);
  const content = '<at id="ou_t">M</at>\n\n**[引用]**\n🌉 b\n绑定码    bbbbbb';
  const r = findPendingBinding({ content, ...f });
  assert.equal(r.ok, true);
  assert.equal(r.id, "b");
  assert.equal(r.matchedBy, "quoted_binding_token");
});

test("只有一个待接入且没带码 → 走老路，单项目用户行为不变", () => {
  const f = pendingFixture([{ id: "a", token: "aaaaaa" }]);
  const r = findPendingBinding({ content: '<at id="ou_t">M</at> 干活', ...f });
  assert.equal(r.ok, true);
  assert.equal(r.matchedBy, "only_pending");
});

test("多个待接入且没带码 → 拒绝，绝不挑一个", () => {
  const f = pendingFixture([{ id: "a", token: "aaaaaa" }, { id: "b", token: "bbbbbb" }]);
  const r = findPendingBinding({ content: '<at id="ou_t">M</at> 干活', ...f });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PROMOTE_REJECT.MULTIPLE_PENDING);
});

test("码认得出但没人认领 → 明说，不回落去猜", () => {
  const f = pendingFixture([{ id: "a", token: "aaaaaa" }]);
  const content = '<at id="ou_t">M</at>\n\n**[引用]**\n绑定码    ffffff';
  const r = findPendingBinding({ content, ...f });
  assert.equal(r.reason, PROMOTE_REJECT.TOKEN_UNKNOWN);
  // 关键：即使只有一份待绑定，认得出码却对不上时也不能回落 ——
  // 那会在「Frank 在 A 话题说话、待绑定的是 B」时把 B 绑给 A。
});

test("引用里那串不是十六进制就不算绑定码 —— 安静回落到「只有一份」", () => {
  const f = pendingFixture([{ id: "a", token: "aaaaaa" }]);
  const bad = '<at id="ou_t">M</at>\n\n**[引用]**\n绑定码    zzzzzz';
  assert.deepEqual(bindingTokensInQuote(bad), [], "非 hex 不该被当成码");
  const r = findPendingBinding({ content: bad, ...f });
  assert.equal(r.matchedBy, "only_pending", "认不出码就走老路，而不是报一个假的「码不认识」");
});

test("两个待接入撞了同一个码，或引用里多个码 → 都 fail-closed", () => {
  const dup = pendingFixture([{ id: "a", token: "abc123" }, { id: "b", token: "abc123" }]);
  const c1 = '<at id="ou_t">M</at>\n\n**[引用]**\n绑定码    abc123';
  assert.equal(findPendingBinding({ content: c1, ...dup }).reason, PROMOTE_REJECT.TOKEN_DUPLICATED);

  const f = pendingFixture([{ id: "a", token: "aaaaaa" }]);
  const c2 = '<at id="ou_t">M</at>\n\n**[引用]**\n绑定码    aaaaaa\n绑定码    bbbbbb';
  assert.equal(findPendingBinding({ content: c2, ...f }).reason, PROMOTE_REJECT.TOKEN_AMBIGUOUS);
});

// ---------- 入站分发：一个入口、一次取信封、确定性选路 ----------
//
// 本机不止一个消费者（本仓库、cc2cd……）。原来的做法是外层包内层：判不出归属就
// exec 邻仓的脚本。那能跑，但技能和钩子只能指一个入口（谁后装谁赢）、信封被取两遍
// （重试预算翻倍，顶到秒级回执上限）、归属逻辑住在最外层。分发表一次解掉这三件。

const R_SELF = { id: "self", handler: "/a/inbound.mjs", isDefault: true };
const R_CC2CD = { id: "cc2cd", handler: "/b/c2c-inbound.mjs" };

test("话题登记过就走登记的那条路由", () => {
  const r = selectRoute({ sessionId: "s_x", routes: [R_SELF, R_CC2CD], sessions: { s_x: "cc2cd" } });
  assert.equal(r.ok, true);
  assert.equal(r.route.id, "cc2cd");
  assert.equal(r.matchedBy, "session_registration");
});

test("没登记过就走默认路由 —— 待绑定认领由默认那家自己处理", () => {
  const r = selectRoute({ sessionId: "s_new", routes: [R_SELF, R_CC2CD], sessions: {} });
  assert.equal(r.route.id, "self");
  assert.equal(r.matchedBy, "default");
});

test("只有一条路由时它就是默认，不必显式标 default", () => {
  const one = { id: "only", handler: "/x.mjs" };
  assert.equal(selectRoute({ sessionId: "s", routes: [one], sessions: {} }).route.id, "only");
});

test("登记指向一条不存在的路由 → 拒绝，绝不悄悄回落到默认", () => {
  const r = selectRoute({ sessionId: "s_x", routes: [R_SELF], sessions: { s_x: "已经删掉的" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROUTE_REJECT.UNKNOWN_ROUTE);
  // 回落会把本该给 B 的消息投给 A —— 静默且难查，正是分发层要防的那类错。
});

test("一条路由都没有 → 拒绝，不猜", () => {
  assert.equal(selectRoute({ sessionId: "s", routes: [], sessions: {} }).reason, ROUTE_REJECT.NO_HANDLER);
});

test("多条路由都没标 default 且话题没登记 → 拒绝而不是挑第一条", () => {
  const r = selectRoute({ sessionId: "s", routes: [R_CC2CD, { id: "x", handler: "/x.mjs" }], sessions: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROUTE_REJECT.NO_HANDLER);
});

test("路由表读不到不是错误 —— 单消费者的机器不该被要求先写一张表", () => {
  const t = loadRoutes(path.join(os.tmpdir(), "bridge-cc-没有这个文件.json"));
  assert.equal(t.ok, true);
  assert.equal(t.reason, "no_routes");
  assert.deepEqual(t.routes, []);
});

test("enabled:false 的路由不参与选路", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-rt-")), "routes.json");
  fs.writeFileSync(f, JSON.stringify({ routes: [
    { id: "a", handler: "/a.mjs", default: true },
    { id: "b", handler: "/b.mjs", enabled: false },
  ], sessions: { s1: "b" } }));
  const t = loadRoutes(f);
  assert.deepEqual(t.routes.map((r) => r.id), ["a"]);
  // 登记还指向被停用的那条 → 拒绝，而不是当它不存在回落到 a
  assert.equal(selectRoute({ sessionId: "s1", ...t }).reason, ROUTE_REJECT.UNKNOWN_ROUTE);
});

test("登记话题：幂等，且不许把别人的话题抢过来", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-reg-")), "routes.json");
  assert.equal(registerSession({ sessionId: "s1", routeId: "cc2cd", file: f }).changed, true);
  assert.equal(registerSession({ sessionId: "s1", routeId: "cc2cd", file: f }).changed, false);
  const stolen = registerSession({ sessionId: "s1", routeId: "self", file: f });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.owner, "cc2cd");
  // 静默改写会让「上一条进了 A、这一条进了 B」，那是最难查的一类
  assert.equal(loadRoutes(f).sessions.s1, "cc2cd");
});

// ---------- 信封只取一次，往下传 ----------

test("继承来的信封被直接采用，不再打一次网络", () => {
  const ev = { message_id: "m1", session_id: "s1", sender_id: "u", created_at_ms: 1 };
  const r = fetchTriggerEvent({ [ENV_PASS]: JSON.stringify(ev),
    AILY_CLI_SESSION_ID: "s1", AILY_CLI_CALLER_AGENT_UID: "a" },
    { runner: () => { throw new Error("不该再取一次"); } });
  assert.equal(r.ok, true);
  assert.equal(r.inherited, true);
  assert.equal(r.attempts, 0);
  assert.equal(r.event.message_id, "m1");
});

test("继承的信封结构不完整 → 当没有，回落到自己取", () => {
  for (const bad of ["{}", '{"message_id":"m"}', "不是 json", ""]) {
    assert.equal(inheritedEvent({ [ENV_PASS]: bad }), null, JSON.stringify(bad));
  }
});

test("Canonical Event 同时保留规范字段和无损 Aily envelope", () => {
  const raw = {
    type: "message.create",
    payload: JSON.stringify({ message: { id: "m-canonical" }, future_field: { nested: true } }),
    transport_extension: ["future", 1],
  };
  const built = buildCanonicalEvent({
    event: {
      message_id: "m-canonical", session_id: "s-canonical", sender_id: "frank",
      created_at_ms: NOW, content: at(M5CODEX) + " 继续开发",
    },
    rawEnvelope: raw,
    endpointId: "m5codex",
    callerAgentUid: "agent_m5codex",
    fetchAttempts: 3,
    env: { AILY_CLI_CHANNEL_CHAT_ID: "unverified-chat", AILY_CLI_CHANNEL_THREAD_ID: "unverified-thread" },
  });
  assert.equal(built.ok, true);
  assert.equal(built.event.source.session_id, "s-canonical");
  assert.equal(built.event.source.chat_id, null,
    "未验证的 Aily channel 变量不得升级成 selector 可用的 locator");
  assert.equal(built.event.extensions.aily_channel.chat_id, "unverified-chat");
  assert.equal(built.event.extensions.aily_channel.verified, false);
  assert.deepEqual(built.event.raw_envelope.payload, raw, "未知字段和 payload 原始形状都不能丢");
  assert.deepEqual(built.event.mention.target_open_ids, [M5CODEX]);
  assert.equal(built.event.extensions.dispatcher.fetch_attempts, 3);
  assert.deepEqual(legacyEventFromCanonical(built.event), {
    message_id: "m-canonical", session_id: "s-canonical", sender_id: "frank",
    created_at_ms: NOW, content: at(M5CODEX) + " 继续开发",
  });
});

test("Canonical Event 继承路径不重新访问 Aily", () => {
  const built = buildCanonicalEvent({
    event: { message_id: "m-inherited", session_id: "s-inherited", sender_id: "frank",
      created_at_ms: NOW, content: "hi" },
    rawEnvelope: { type: "message.create", payload: "opaque" },
    endpointId: "m5codex", callerAgentUid: "agent_m5codex", fetchAttempts: 2,
  });
  assert.equal(built.ok, true);
  const env = { [CANONICAL_PASS]: JSON.stringify(built.event) };
  assert.deepEqual(inheritedCanonicalEvent(env), built.event);
  const fetched = fetchTriggerEvent(env, { runner: () => { throw new Error("不该重新取 Aily"); } });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.inherited, true);
  assert.equal(fetched.attempts, 2);
  assert.equal(fetched.event.message_id, "m-inherited");
  assert.deepEqual(fetched.raw_envelope, built.event.raw_envelope.payload);
});

test("Canonical Event 缺必填字段时必须在 dispatcher 边界拒绝", () => {
  const invalid = {
    schema_version: "1.0", event_id: "m", event_type: "im.message.receive",
    occurred_at: new Date(NOW).toISOString(), endpoint_id: "m5codex",
    source: { session_id: "s" }, actor: {}, content: { text: "x", origin: "feishu" },
    raw_envelope: { format: "aily-trigger-event/v1", payload: {} },
  };
  assert.equal(validateCanonicalEvent(invalid).ok, false);
  assert.ok(validateCanonicalEvent(invalid).problems.includes("actor.sender_id"));
  assert.equal(inheritedCanonicalEvent({ [CANONICAL_PASS]: JSON.stringify(invalid) }), null);
});

test("共享 dispatcher 只取一次信封并把 Canonical Event 原样交给 handler", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-"));
  const handler = path.join(dir, "handler.mjs");
  fs.writeFileSync(handler, "// fixture\n");
  let fetches = 0;
  let spawned = null;
  const out = [];
  const err = [];
  const raw = { type: "message.create", payload: "{\"unknown\":true}" };
  const result = runInboundDispatcher({
    endpointId: "m5codex",
    expectedCallerAgentUid: "agent_expected",
    defaultRoute: { id: "codex", handler },
    routesFile: path.join(dir, "missing-routes.json"),
    env: {
      AILY_CLI_CALLER_AGENT_UID: "agent_expected",
      AILY_CLI_SESSION_ID: "must-not-reach-handler",
      AILY_CLI_RUN_ID: "must-not-reach-handler",
    },
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
    fetcher: () => {
      fetches += 1;
      return { ok: true, attempts: 4, raw_envelope: raw, event: {
        message_id: "m-dispatch", session_id: "s-dispatch", sender_id: "frank",
        created_at_ms: NOW, content: "执行",
      } };
    },
    spawnHandler: (...args) => { spawned = args; return { status: 0 }; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fetches, 1);
  assert.equal(spawned[0], process.execPath);
  assert.deepEqual(spawned[1], [handler]);
  assert.deepEqual(spawned[2].stdio, ["ignore", "inherit", "inherit"]);
  assert.equal(spawned[2].timeout, 30_000);
  assert.deepEqual(JSON.parse(spawned[2].env[ENV_PASS]), {
    message_id: "m-dispatch", session_id: "s-dispatch", sender_id: "frank",
    created_at_ms: NOW, content: "执行",
  }, "真正实现旧继承契约的 handler 在迁移期也只能读取同一份已取事件");
  assert.equal(Object.hasOwn(spawned[2].env, "AILY_CLI_SESSION_ID"), false,
    "handler 不得保留再次按 session 查询 Aily 的能力");
  assert.equal(Object.hasOwn(spawned[2].env, "AILY_CLI_RUN_ID"), false,
    "handler 不得保留再次按 run 查询 Aily 的能力");
  assert.equal(spawned[2].env.AILY_CLI_CALLER_AGENT_UID, "agent_expected",
    "handler 仍需独立校验 endpoint caller");
  const passed = JSON.parse(spawned[2].env[CANONICAL_PASS]);
  assert.equal(passed.event_id, "m-dispatch");
  assert.deepEqual(passed.raw_envelope.payload, raw);
  assert.equal(passed.extensions.dispatcher.fetch_attempts, 4);
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test("dispatcher 在调用方不匹配时连 Aily 都不读取", () => {
  let fetches = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-log-"));
  const logFile = path.join(dir, "dispatcher.log");
  const result = runInboundDispatcher({
    endpointId: "m5codex", expectedCallerAgentUid: "expected",
    defaultRoute: { id: "codex", handler: "/not-used" },
    logFile,
    env: {},
    stdout: { write() {} }, stderr: { write() {} },
    fetcher: () => { fetches += 1; return { ok: false }; },
  });
  assert.equal(result.kind, "rejected");
  assert.equal(fetches, 0);
  assert.ok(fs.readFileSync(logFile, "utf-8").includes("got=none"),
    "缺 caller 与 caller 错误必须在私有日志中可区分");
});

test("dispatcher 必须同时传新旧两个信封变量 —— 只传一个会让外部消费者静默重取", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-env-"));
  const handler = path.join(dir, "handler.mjs");
  fs.writeFileSync(handler, "// 存在即可，不会真的被跑\n");
  let seenEnv = null;
  const result = runInboundDispatcher({
    endpointId: "ep", expectedCallerAgentUid: "expected",
    defaultRoute: { id: "self", handler },
    routesFile: path.join(dir, "routes.json"),
    logFile: path.join(dir, "d.log"),
    env: { AILY_CLI_CALLER_AGENT_UID: "expected" },
    stdout: { write() {} }, stderr: { write() {} },
    fetcher: () => ({ ok: true, event: { message_id: "m", session_id: "s",
      sender_id: "u", created_at_ms: NOW, content: "x" },
    raw_envelope: { type: "message.create", payload: {} } }),
    spawnHandler: (_bin, _args, opts) => { seenEnv = opts.env; return { status: 0 }; },
  });
  assert.equal(result.kind, "dispatched");

  // 新契约：handler 拿 Canonical Event。
  assert.ok(seenEnv.CANONICAL_EVENT ?? seenEnv[CANONICAL_EVENT_ENV],
    "必须传 Canonical Event");
  // 旧契约：迁移期必须**同时**保留。cc2cd 这类外部消费者用的是自己那份取信封实现，
  // 它只认旧变量；只传新变量的话它不会报错，而是安静地自己再取一次 ——
  // 「每条消息只取一次信封」这条不变量被破坏了却没有任何东西作声。
  // PR#6 初版就只传了新变量，这条测试是为了它不再被重构丢掉。
  assert.ok(seenEnv[ENV_PASS], "迁移期必须同时传旧的 " + ENV_PASS);

  const legacy = JSON.parse(seenEnv[ENV_PASS]);
  assert.equal(legacy.message_id, "m", "旧视图要能被旧消费者直接使用");
  assert.equal(legacy.session_id, "s");
});

test("dispatcher 选路失败日志保留可关联 session 指纹但不泄露 locator", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-route-log-"));
  const logFile = path.join(dir, "dispatcher.log");
  const routesFile = path.join(dir, "routes.json");
  fs.writeFileSync(routesFile, JSON.stringify({ routes: [
    { id: "one", handler: "/one.mjs" }, { id: "two", handler: "/two.mjs" },
  ] }));
  const result = runInboundDispatcher({
    endpointId: "m5codex", expectedCallerAgentUid: "expected", routesFile, logFile,
    env: { AILY_CLI_CALLER_AGENT_UID: "expected" },
    stdout: { write() {} }, stderr: { write() {} },
    fetcher: () => ({ ok: true, event: { message_id: "m", session_id: "secret-session-locator",
      sender_id: "u", created_at_ms: NOW, content: "x" },
    raw_envelope: { type: "message.create", payload: {} } }),
  });
  assert.equal(result.reason, ROUTE_REJECT.NO_HANDLER);
  const log = fs.readFileSync(logFile, "utf-8");
  assert.ok(log.includes("session=sha256:"));
  assert.equal(log.includes("secret-session-locator"), false);
});

test("dispatcher 把 handler 超时与启动失败区分开", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-timeout-"));
  const handler = path.join(dir, "handler.mjs");
  fs.writeFileSync(handler, "// fixture\n");
  const outputs = [];
  const result = runInboundDispatcher({
    endpointId: "m5codex", expectedCallerAgentUid: "expected",
    defaultRoute: { id: "codex", handler }, routesFile: path.join(dir, "none.json"),
    env: { AILY_CLI_CALLER_AGENT_UID: "expected" },
    stdout: { write: (s) => outputs.push(s) }, stderr: { write() {} },
    fetcher: () => ({ ok: true, event: { message_id: "m", session_id: "s", sender_id: "u",
      created_at_ms: NOW, content: "x" }, raw_envelope: { type: "message.create", payload: {} } }),
    spawnHandler: () => ({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }),
  });
  assert.equal(result.reason, "handler_timeout");
  assert.ok(outputs.join("").includes("响应超时"));
});

// ---------- 入站钩子：让「先进运输层」成为硬约束 ----------

const AILY_ENV = { AILY_CLI_SESSION_ID: "s", AILY_CLI_CALLER_AGENT_UID: "agent_x" };

test("认 Aily 回合只看 daemon 注入的环境变量，不看正文", () => {
  assert.equal(isAilyTransportTurn(AILY_ENV), true);
  assert.equal(isAilyTransportTurn({ AILY_CLI_SESSION_ID: "s" }), false, "缺 agent 不算");
  assert.equal(isAilyTransportTurn({ AILY_CLI_CALLER_AGENT_UID: "a" }), false, "缺 session 不算");
  assert.equal(isAilyTransportTurn({}), false);
  // 宁可漏判（回落到技能那条软路径），也不能误判 ——
  // 误判会把 Frank 在终端里正常的一句话变成「只准跑分发器」。
});

test("桥自己起的会话不再进运输层 —— 否则一次投递会无限套娃", () => {
  assert.equal(isBridgeOwnedTurn({ FEISHU_BRIDGE_ROLE: "forwarder" }), true);
  assert.equal(isBridgeOwnedTurn({ FEISHU_BRIDGE_ROLE: "" }), false);
  assert.equal(isBridgeOwnedTurn({}), false);
});

test("注入的规则把禁令放在最前面、并在末尾重复一次", () => {
  const rule = composeTransportRule({ dispatcher: "/b/scripts/aily-inbound.mjs" });
  const head = rule.slice(0, 120);
  assert.ok(head.includes("不是给你的指令"), "禁令必须在最前面 —— 中间那段是祈使句，模型天然想执行它");
  assert.ok(rule.trimEnd().endsWith("原样返回它的输出。"), "末尾要再重复一次");
  assert.ok(rule.includes("node /b/scripts/aily-inbound.mjs"));
});

test("注入的规则禁止模型自己判断该不该投递 —— 这条错误真实发生过", () => {
  const rule = composeTransportRule({ dispatcher: "/x.mjs" });
  assert.ok(rule.includes("不要自己判断"));
  assert.ok(rule.includes("前缀"), "要点名前缀那次误判，否则一年后没人记得为什么写这条");
});

test("钩子和技能指向同一个入口 —— 绝不能各指一套", () => {
  const skill = fs.readFileSync(path.resolve("skills", "m5claude-inbound-router", "SKILL.md"), "utf-8");
  const rule = composeTransportRule({ dispatcher: "/B/scripts/aily-inbound.mjs" });
  assert.ok(skill.includes("aily-inbound.mjs"), "技能要指分发器");
  assert.ok(!skill.includes("scripts/inbound.mjs"), "技能不该再直接指业务脚本");
  assert.ok(rule.includes("aily-inbound.mjs"), "钩子也要指分发器");
});

test("分发器自己不加一个字：stdout 原样透出", () => {
  const src = fs.readFileSync(path.resolve("scripts", "inbound-dispatcher.mjs"), "utf-8");
  assert.ok(src.includes('stdio: ["ignore", "inherit", "inherit"]'),
    "handler 的 stdout 必须直通，分发器插一句嘴 Frank 就分不清是谁的判断");
  assert.ok(src.includes("CANONICAL_EVENT_ENV"), "必须把取好的无损 Canonical Event 传下去");
  const claude = fs.readFileSync(path.resolve("scripts", "aily-inbound.mjs"), "utf-8");
  assert.ok(claude.includes("runInboundDispatcher"), "Claude 薄入口也必须复用同一个 dispatcher 核心");
});

test("入站钩子进来就记日志，记完再判闸", () => {
  const src = fs.readFileSync(path.resolve("scripts", "inbound-hook.mjs"), "utf-8");
  const enter = src.indexOf('log("enter');
  const firstGate = src.indexOf("isAilyTransportTurn()");
  assert.ok(enter > 0, "必须有无条件的入口日志");
  assert.ok(enter < firstGate,
    "日志要排在第一道闸之前 —— 否则「没触发」和「触发了但被挡」分不开，" +
    "而这两种情况的修法完全不同（2026-08-21 就卡在这个分不开上）");
  assert.ok(!src.includes("payload.prompt"), "诊断需要的是环境形状，不是消息内容");
});

test("每条退出路径都留下可分辨的原因", () => {
  const src = fs.readFileSync(path.resolve("scripts", "inbound-hook.mjs"), "utf-8");
  for (const reason of ["not_aily_turn", "bridge_owned", "template_unusable",
                        "other_agent", "no_bridge_root", "INJECT", "crashed"]) {
    assert.ok(src.includes(reason), "缺少 " + reason + " 的日志出口");
  }
});

// ---------- 汇总 ----------

console.log(`\n通过 ${passed} / 失败 ${failed}\n`);
if (failed > 0) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
