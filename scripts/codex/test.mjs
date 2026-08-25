#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { moduleRoot } from "../direct-run.mjs";
import { applySuppressionCore } from "../suppress-outbox-core.mjs";
import {
  checkArgShape, locateTask, parseArgs as parseCodexSuppressArgs,
} from "./suppress-outbox.mjs";
import {
  absentJob, auditOutbox, classifyBacklog, drainScriptPath, enableBlockers, loadedPhase,
  plistBody, scanRunnable,
} from "./drain-service.mjs";
import {
  explainabilityGaps, hasPublishAuthorization, outboxMutationBlocker,
} from "../outbox.mjs";
import { generationTargetState } from "../topic-generation.mjs";
import {
  ageText, collectBacklog, describeRecordState, sanitizeForDisplay, suppressCommandFor,
} from "./feishu-outbox.mjs";
import { auditSkills } from "./skill-content.mjs";
import { preflightTask } from "./publish-eligible.mjs";
import {
  HOOK_TAG, acceptsHookCommand, buildHookCommand, ownsHookCommand, parseHookCommand, pickNode,
} from "./hook-command.mjs";
import { composeSubscribeContext } from "./prompt-hook.mjs";
import { recordCodexActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";
import {
  INTENT_TTL_MS, buildIntentParams, consumeIntent, intentDir, issueIntent,
} from "./intent.mjs";
import { sweepEligible } from "./drain-all.mjs";

import {
  appendEvent, listPending, markPublishEligibleByEventKey, suppressPublishByEventKey,
} from "../outbox.mjs";
import { evaluateInbound, REJECT } from "../selector.mjs";
import {
  MAPPING_DISPOSITION, buildLegacyMappingContext, evaluateMappingAdmission, handleMappingPolicy,
} from "../mapping-policy.mjs";
import { composeCodexBinding, resolveBindingTarget, validThreadId } from "./bind-compose.mjs";
import { readCodexThreadTitle, sanitizeThreadTitle } from "./thread-title.mjs";
import { updateTextMessage } from "./lark-message.mjs";
import {
  classifyRunnerDiagnostic, isCodexInboundExecution, readCodexRunOutcome, sanitizeCodexRunEnv,
} from "./handoff.mjs";
import {
  composeCodexOutboundCard, neutralizeCardMentions, outboundCardBatches, validateCodexOutboundCard,
} from "./outbound-card.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import { publishDraft } from "../outbound.mjs";
import {
  clearTurnInput, readTurnInput, storeTurnInput,
} from "../turn-input.mjs";
import {
  classifyFeishuPrompt, composeAilyInboundContext, composeBindingContext, composeInitContext,
  composeInvalidControlContext, composeModeContext, composeRotateContext, composeRoutedCodexContext,
  composeStatusContext, composeUnbindContext,
  isAilyInvocation, isBindingPrompt,
} from "./prompt-hook.mjs";
import {
  buildCodexSubscriptionProjection, enableAutoPublishForAllTasks, evaluatePromotion,
  readMigrationReceipt,
  extractQuotedBindingTokens, findPendingTask,
  findRegisteredTaskForCodexThread, findTaskForCodexThread, findTaskForFeishuSession,
  isThreadBusy, loadCodexTemplate, loadRegistry, makeTaskEntry, mappingForTask, recordThreadActivity, resolveTask,
  closeTaskTopicRotation, prepareTaskTopicRotation, promoteTask, recordTaskTopicActivity,
  finalizeTaskDialogueTurn, interactionPolicyForTask, reserveTaskDialogueTurn,
  refreshPendingTaskBinding,
  addTask, mutateRegistryDocument, registerTaskTopicRotation, resolveTaskOutboundGeneration,
  setTaskConnectionStatus,
  setTaskDisplayName, setTaskInteractionMode, shadowCodexFirstClaim, taskPaths, topicStateForTask,
  validateCodexTemplate, validateRegistryTasks, writeRegistry,
} from "./state.mjs";
import { ROTATION_STATUS, activeGeneration, pendingGeneration } from "../topic-generation.mjs";
import { DIALOGUE_TURN_STATUS } from "../interaction-policy.mjs";
import {
  RELAY_DISPOSITION, RELAY_STEP_STATUS, advanceRelayPlan, createParticipantAuthorizationSnapshot,
  createRelayPlanState, deriveDialogueBindingRef, deriveDialogueOutputRef,
  deriveDialogueParticipantRef, startRelayCycle,
} from "../dialogue-participant-planner.mjs";
import { CHAT_SCOPE_PROBE_ARTIFACT_TYPE } from "../dialogue-chat-scope-probe.mjs";
import { shellQuote } from "../shell-quote.mjs";
import {
  DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE, DIALOGUE_SHADOW_READINESS_DECISION,
  analyzeDialogueShadowEvidence,
} from "../dialogue-shadow-readiness.mjs";

const ROOT = moduleRoot(import.meta.url, "../..");

/**
 * **所有测试一律走假的 launchctl，永不读真实控制面。**
 *
 * 评审实测：两条回归隔离了 HOME 却没隔离 launchd 域，他那台机器上有同名 job，
 * 于是同一份代码在我这里 127/127、在他那里 125/127。
 * 造一个"服务不存在"的假 launchctl 放在这里，任何要查服务状态的测试都用它。
 */
const fakeLaunchctlDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-launchctl-"));
const FAKE_LAUNCHCTL = path.join(fakeLaunchctlDir, "launchctl");
fs.writeFileSync(FAKE_LAUNCHCTL,
  '#!/bin/sh\necho "Could not find service in domain" >&2\nexit 113\n', { mode: 0o755 });
/** 跑子进程时用的环境：真实 launchd 域一律屏蔽掉。 */
/**
 * 给测试签一张真凭证，返回该带的命令参数。
 *
 * **走产品自己的 issueIntent，不手写凭证文件** —— 手写的话签发格式一改，
 * 测试就跟真实脱节，而签发恰恰是这道门禁的另一半。
 */
const withIntent = (action, threadId, home, input = {}) => {
  // **走产品同一个参数构造器，绝不手拼。**
  // 手拼正是这轮被打穿的病根：签发端和消费端各拼各的，拼出来不一样，
  // 真实入口全线 intent_params_mismatch，而各自签票的单测两边都绿。
  const issued = issueIntent({
    action, threadId, params: buildIntentParams(action, input), home });
  assert.equal(issued.ok, true, "签发凭证失败：" + (issued.reason ?? ""));
  return ["--intent", issued.id];
};

const isolatedEnv = (extra = {}) => ({
  ...process.env, FEISHU_BRIDGE_LAUNCHCTL: FAKE_LAUNCHCTL, ...extra,
});
const THREAD_A = "01911111-2222-7333-8444-555555555555";
const THREAD_B = "01922222-3333-7444-8555-666666666666";
const TEMPLATE = {
  schema_version: "1.0", chain: "codex",
  transport_agent_name: "M5Codex", transport_app_id: "cli_same", transport_open_id: "ou_same",
  outbound_agent_name: "M5Codex", outbound_app_id: "cli_same", outbound_open_id: "ou_same",
  lark_cli_profile: "platform-bot", lark_cli_bin: "/bin/false", lark_cli_home: "/tmp/lark",
  lark_cli_config_base: "/tmp/agents", frank_sender_id: "1234567890",
  chat_name: "test", chat_id: "oc_test", default_freshness_ms: 900000,
  agent_uid: "agent_test", bridge_root: ROOT, inbound_prefix: null,
};
let passed = 0;
let failed = 0;
/**
 * 汇总打印之后就封条 —— 与 Claude 侧 test.mjs 同一条保障，理由也相同：
 * 把新测试追加到文件末尾时，它的结果不会计入统计，而套件照样报绿。
 * Claude 侧 2026-08-23 真实发生过一次，一口气三条从未生效。
 */
let summarySealed = false;
const test = (name, fn) => {
  if (summarySealed) {
    console.error("\n✗ 测试「" + name + "」写在汇总之后 —— 它的结果不会计入统计。");
    process.exit(1);
  }
  try { fn(); passed += 1; }
  catch (err) { failed += 1; console.error("FAIL " + name + "\n" + (err.stack ?? err)); }
};
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "feishu-codex-adapter-test-"));

/**
 * 一条**真实形状**的 outbox 记录。
 *
 * 以前各处夹具写的是 `{ kind, text, published_at: null }` —— 而真实记录
 * （含升级前那批历史积压）一直都带着 id / kind / text / created_at。
 * 夹具比真实数据宽松，于是"没有 id、没有时间的文件被永久抑制"这个缺陷
 * 在全绿的套件下活了下来，是评审用反例挖出来的。
 *
 * **夹具要像真的**，否则守卫收紧时红的是测试，不是缺陷。
 */
/**
 * 测试里模拟"人从预览输出里复制过来的摘要"。
 *
 * **产品代码绝不能这么做** —— 在 --apply 时现算就只覆盖进程内窗口，
 * 那正是被评审逮到两次的写法。测试里这样算是合法的：它扮演的是
 * 人手上那份预览输出，而不是第二个进程自己重新算一遍。
 */
/**
 * 走**真实的两步流程**跑抑制：先预览，从输出里取回摘要，再带着它落盘。
 *
 * 这正是这道守卫要保护的东西 —— 摘要必须**跨进程**由人带过来。
 * 测试里如果直接在 apply 时算一个，就跟评审逮到的产品缺陷是同一个写法。
 */
function suppressViaPreview(cli, args) {
  const preview = cli(args);
  const m = /--expect-digest (\S+)/u.exec(preview.stdout ?? "");
  if (!m) return { preview, applied: null, digest: null };
  const applied = cli([...args, "--apply", "--expect-digest", m[1]]);
  return { preview, applied, digest: m[1] };
}

function digestFromDisk(outboxDir, select = (r) => r) {
  return suppressionDigest({
    files: auditOutbox(outboxDir).files,
    // **按核心锁内那条算法算** —— 用合成的 pending 算会跟它对不上。
    records: select(listPending({ outboxDir })),
  });
}

let recSeq = 0;
function outboxRecord(extra = {}) {
  recSeq += 1;
  return {
    id: "evt-" + String(recSeq).padStart(6, "0"),
    // **kind 必须在 KINDS 里** —— "progress" 不是合法 kind，
    // appendEvent 根本造不出来。夹具用生产入口造不出的值，
    // 就等于替被测代码放行了一类现实中不存在的输入。
    kind: "milestone",
    text: "夹具正文 " + recSeq,
    created_at: new Date(Date.UTC(2026, 7, 24, 0, 0, recSeq % 60)).toISOString(),
    published_at: null,
    ...extra,
  };
}

test("Codex 将 chat scope probe 纳入受保护共用面", () => {
  assert.equal(CHAT_SCOPE_PROBE_ARTIFACT_TYPE, "feishu_bridge_dialogue_chat_scope_probe");
});

test("Codex 与 Claude 共用 shadow readiness，空证据不能被解释为可切流", () => {
  const analyzed = analyzeDialogueShadowEvidence({ generatedAt: 0 });
  assert.equal(analyzed.ok, true);
  assert.equal(analyzed.report.artifact_type, DIALOGUE_SHADOW_READINESS_ARTIFACT_TYPE);
  assert.equal(analyzed.report.decision,
    DIALOGUE_SHADOW_READINESS_DECISION.INSUFFICIENT_EVIDENCE);
});

const codexRelaySnapshot = () => {
  const coordinator = deriveDialogueBindingRef({
    runtimeNamespace: "codex", endpointId: "endpoint_codex", privateBindingKey: THREAD_A,
  }).bindingRef;
  const peerBinding = deriveDialogueBindingRef({
    runtimeNamespace: "claude", endpointId: "endpoint_claude", privateBindingKey: "private_peer",
  }).bindingRef;
  const participant = (kind, runtime, endpoint, privateKey) => deriveDialogueParticipantRef({
    kind, runtimeNamespace: runtime, endpointId: endpoint, privateIdentityKey: privateKey,
  }).participantId;
  return createParticipantAuthorizationSnapshot({
    authorizationRevision: 1, capturedAt: 1_800_000_000_000,
    coordinatorBindingRef: coordinator,
    participants: [
      { participant_id: participant("human", "feishu", "endpoint_codex", "sender"),
        kind: "human", roles: ["requester"], subscription_id: null, binding_ref: null,
        local_target_id: null, allowed_origins: ["human_event"],
        limits: { max_agent_runs: 1, resource_units_per_run: 1 } },
      { participant_id: participant("agent", "codex", "endpoint_codex", THREAD_A),
        kind: "agent", roles: ["host", "finalizer"],
        subscription_id: "subscription_aaaaaaaaaaaaaaaaaaaaaaaa",
        binding_ref: coordinator, local_target_id: "target_aaaaaaaaaaaaaaaaaaaaaaaa",
        allowed_origins: ["human_event", "planner_relay"],
        limits: { max_agent_runs: 8, resource_units_per_run: 1 } },
      { participant_id: participant("agent", "claude", "endpoint_claude", "peer"),
        kind: "agent", roles: ["peer"],
        subscription_id: "subscription_bbbbbbbbbbbbbbbbbbbbbbbb",
        binding_ref: peerBinding, local_target_id: "target_bbbbbbbbbbbbbbbbbbbbbbbb",
        allowed_origins: ["planner_relay"],
        limits: { max_agent_runs: 4, resource_units_per_run: 1 } },
    ],
  }).snapshot;
};

test("Codex 与 Claude 共用 Participant foundation，planner 不暴露 thread locator", () => {
  const snapshot = codexRelaySnapshot();
  assert.equal(JSON.stringify(snapshot).includes(THREAD_A), false);
  const state = createRelayPlanState({
    dialogueId: "dialogue_codex_shared", snapshot, startedAt: 1_800_000_000_000,
  }).state;
  const started = startRelayCycle(state, {
    snapshot, humanEventId: "human_codex", parentHumanClaimId: "a".repeat(64),
    originChannelGenerationId: "channel_generation_aaaaaaaaaaaaaaaaaaaaaaaa",
    now: 1_800_000_000_001,
  });
  assert.equal(started.disposition, RELAY_DISPOSITION.DISPATCH_ONE);
  assert.equal(started.runRequest.local_target_id, "target_aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(JSON.stringify(started.runRequest).includes(THREAD_A), false);
  const outputRef = deriveDialogueOutputRef({
    dialogueId: state.dialogue_id, runId: started.runRequest.run_id,
    terminalEventId: "terminal_codex_host",
  }).outputRef;
  const peer = advanceRelayPlan(started.state, {
    snapshot, runId: started.runRequest.run_id, terminalEventId: "terminal_codex_host",
    status: RELAY_STEP_STATUS.COMPLETED, outputRef, now: 1_800_000_000_002,
  });
  assert.equal(peer.runRequest.role, "peer");
  assert.equal(peer.runRequest.local_target_id, "target_bbbbbbbbbbbbbbbbbbbbbbbb");
});

function autoPublishFixture({ enabled = true, workingPublisher = true } = {}) {
  const home = temp();
  const root = path.join(home, "project");
  const bin = path.join(home, "fake-lark.sh");
  const argsFile = path.join(home, "lark-args.json");
  const configBase = path.join(home, "agents");
  const credentialDir = path.join(configBase, TEMPLATE.agent_uid);
  fs.mkdirSync(root);
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(credentialDir, "config.json"), JSON.stringify({
    apps: [{ name: TEMPLATE.lark_cli_profile, appId: TEMPLATE.transport_app_id }],
  }));
  fs.writeFileSync(bin, workingPublisher
    ? "#!" + process.execPath + "\n" +
      "const fs = require('node:fs');\n" +
      "fs.writeFileSync(" + JSON.stringify(argsFile) + ", JSON.stringify(process.argv.slice(2)));\n" +
      "process.stdout.write('{\"ok\":true,\"data\":{\"message_id\":\"om_sent\"}}');\n"
    : "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify({
    ...TEMPLATE, lark_cli_bin: bin, lark_cli_config_base: configBase,
  }));
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = enabled;
  writeRegistry([task], path.join(home, "registry.json"));
  return { home, root, task, bin, argsFile };
}

test("thread id 只接受精确 UUID，不接受 --last 或名字", () => {
  assert.equal(validThreadId(THREAD_A), true);
  assert.equal(validThreadId("--last"), false);
  assert.equal(validThreadId("my-recent-thread"), false);
});

test("Codex task registry 原子保存 Dialogue 模式、回合与终局", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Dialogue", rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(home, "registry.json"));
  const enabled = setTaskInteractionMode({
    threadId: THREAD_A, mode: "dialogue", home, now: 1_800_000_000_000,
  });
  assert.equal(enabled.ok, true);
  const reserved = reserveTaskDialogueTurn({
    threadId: THREAD_A, eventId: "om_dialogue", runId: "claim_dialogue",
    localTargetId: "local_target", originChannelGenerationId: "generation",
    runtimeTargetId: THREAD_A, home, now: 1_800_000_000_001,
  });
  assert.equal(reserved.accepted, true);
  const finished = finalizeTaskDialogueTurn({
    threadId: THREAD_A, runId: "claim_dialogue", status: DIALOGUE_TURN_STATUS.COMPLETED,
    home, now: 1_800_000_000_002,
  });
  assert.equal(finished.ok, true);
  const stored = loadRegistry(path.join(home, "registry.json")).tasks[0];
  const loaded = interactionPolicyForTask(stored, { now: 1_800_000_000_003 });
  assert.equal(loaded.state.policy_id, "dialogue");
  assert.equal(loaded.state.dialogue.active_turn, null);
  assert.equal(loaded.state.dialogue.last_turn.status, "completed");
});

test("Codex feishu-mode 默认只读，只有 --apply 才切换精确 task", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Mode", rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(home, "registry.json"));
  const cli = path.join(ROOT, "scripts", "codex", "feishu-mode.mjs");
  const run = (...args) => spawnSync(process.execPath, [cli, "--thread-id", THREAD_A, ...args], {
    encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  const read = run();
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /Mapping/u);
  const preview = run("--mode", "dialogue");
  assert.match(preview.stdout, /dry-run/u);
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].interaction_policy_state, undefined);
  const applied = run("--mode", "dialogue", "--apply", ...withIntent("mode", THREAD_A, home, { mode: "dialogue" }));
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Dialogue/u);
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].interaction_policy_state.policy_id,
    "dialogue");
  // **非法模式该在消费凭证之前就被拒** —— 不给凭证也应该失败在"模式不对"上，
  // 而不是失败在"没凭证"上。参数校验排在门禁前面才是对的顺序。
  const invalid = run("--mode", "automatic", "--apply");
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /mapping.*dialogue/u);
});

test("单 M5Codex 是模板强约束", () => {
  const base = {
    chain: "codex",
    transport_agent_name: "M5Codex", outbound_agent_name: "M5Codex",
    transport_app_id: "cli_a", outbound_app_id: "cli_a",
    transport_open_id: "ou_a", outbound_open_id: "ou_a",
    inbound_prefix: null,
  };
  assert.equal(validateCodexTemplate(base).ok, true);
  assert.equal(validateCodexTemplate({ ...base, outbound_app_id: "cli_b" }).ok, false);
  assert.equal(validateCodexTemplate({ ...base, chain: "claude" }).ok, false);
  assert.equal(validateCodexTemplate({ ...base, inbound_prefix: "→Codex" }).ok, false);
});

test("Codex selector 只需真实 mention，mention 后正文直接成为指令", () => {
  const now = Date.now();
  const event = {
    message_id: "msg_direct",
    session_id: "session_direct",
    sender_id: TEMPLATE.frank_sender_id,
    created_at_ms: now,
    content: '<at id="ou_same">M5Codex</at> 直接继续完成适配',
  };
  const mapping = {
    status: "active",
    expires_at: new Date(now + 60_000).toISOString(),
    session_id: event.session_id,
    frank_sender_id: TEMPLATE.frank_sender_id,
    inbound_prefix: null,
    max_inbound_messages: "unlimited",
    freshness_ms: 60_000,
    consumed_message_ids: [],
    logical_task_key: "direct",
  };
  const accepted = evaluateInbound({ event, mapping, config: TEMPLATE, now });
  assert.equal(accepted.decision, "accept");
  assert.equal(accepted.instruction, "直接继续完成适配");
  const empty = evaluateInbound({
    event: { ...event, message_id: "msg_empty", content: '<at id="ou_same">M5Codex</at>' },
    mapping,
    config: TEMPLATE,
    now,
  });
  assert.equal(empty.reason, REJECT.EMPTY_INSTRUCTION);
});

test("Codex adapter 消费公共 Mapping Policy，runRequest 不携带 thread locator", () => {
  const now = Date.now();
  const event = {
    message_id: "msg_policy_codex",
    session_id: "session_policy_codex",
    sender_id: TEMPLATE.frank_sender_id,
    created_at_ms: now,
    content: '<at id="ou_same">M5Codex</at> 继续推进公共策略迁移',
  };
  const mapping = {
    status: "active",
    expires_at: new Date(now + 60_000).toISOString(),
    session_id: event.session_id,
    frank_sender_id: TEMPLATE.frank_sender_id,
    inbound_prefix: null,
    max_inbound_messages: "unlimited",
    freshness_ms: 60_000,
    consumed_message_ids: [],
    logical_task_key: "codex-policy-target",
    codex_thread_id: THREAD_A,
  };
  const evaluation = evaluateMappingAdmission({ event, mapping, config: TEMPLATE, now });
  const context = buildLegacyMappingContext({ runtime: "codex", mapping, event });
  const outcome = handleMappingPolicy({
    evaluation, claim: { ok: true, key: "claim_codex" }, resolvedContext: context,
  });
  assert.equal(outcome.disposition, MAPPING_DISPOSITION.ACCEPTED);
  assert.equal(outcome.runRequest.userInput, "继续推进公共策略迁移");
  assert.equal(JSON.stringify(outcome.runRequest).includes(THREAD_A), false);
});

test("Codex inbound 进程通道不把结构化诊断或 locator 泄露到 Aily 回复", () => {
  const home = temp();
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "inbound.mjs")], {
    encoding: "utf-8",
    env: {
      ...isolatedEnv(),
      FEISHU_CODEX_BRIDGE_HOME: home,
      AILY_CLI_CALLER_AGENT_UID: "agent_not_m5codex",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^已拒绝/u);
  assert.equal(r.stdout.includes("logical_task_key"), false);
  assert.equal(r.stderr, "");
});

test("同一项目可登记两个 Codex task，路由不按项目猜", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  fs.mkdirSync(root);
  const a = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  const b = makeTaskEntry({ root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "b" });
  a.session_id = "session_a"; a.inbound_state = "bound";
  b.session_id = "session_b"; b.inbound_state = "bound";
  delete a.topic_generation_state; delete a.channel_generation_id;
  delete b.topic_generation_state; delete b.channel_generation_id;
  writeRegistry([a, b], path.join(home, "registry.json"));
  const reg = loadRegistry(path.join(home, "registry.json"));
  assert.equal(reg.tasks.length, 2);
  assert.notEqual(a.logical_task_key, b.logical_task_key);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_B, home }).task.task_display_name, "B");
  // 没有模板时 Feishu 路由必须失败关闭，而不是仅凭同 cwd 选一个。
  assert.equal(findTaskForFeishuSession({ sessionId: "session_b", home }).ok, false);
});

test("多个待绑定 Codex task 由根消息引用中的绑定码精确选择", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  fs.mkdirSync(root);
  const a = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30",
  });
  const b = makeTaskEntry({
    root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "62ca4f",
  });
  writeRegistry([a, b], path.join(home, "registry.json"));
  const content = [
    '<at id="ou_same" type="employee">M5Codex</at> 继续处理',
    "",
    "> **[引用]**",
    "> 🌉 hv-meeting",
    ">",
    "> 本机项目  /tmp/hv-meeting",
    "> 绑定码    5fba30",
  ].join("\n");

  assert.deepEqual(extractQuotedBindingTokens(content), ["5fba30"]);
  const selected = findPendingTask({ home, content });
  assert.equal(selected.ok, true);
  assert.equal(selected.source, "quoted_binding_token");
  assert.equal(selected.task.task_display_name, "A");
});

test("绑定码必须来自引用行，正文手打不能在多个 pending 中选目标", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  fs.mkdirSync(root);
  writeRegistry([
    makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30" }),
    makeTaskEntry({ root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "62ca4f" }),
  ], path.join(home, "registry.json"));

  assert.deepEqual(extractQuotedBindingTokens("请处理绑定码 5fba30"), []);
  assert.equal(findPendingTask({ home, content: "请处理绑定码 5fba30" }).reason,
    "multiple_pending_bindings");
});

test("未知、重复或多个引用绑定码全部 fail-closed", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  fs.mkdirSync(root);
  const a = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30" });
  const b = makeTaskEntry({ root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "62ca4f" });
  writeRegistry([a, b], path.join(home, "registry.json"));

  assert.equal(findPendingTask({ home, content: "> 绑定码  abc123" }).reason,
    "pending_binding_token_unknown");
  assert.equal(findPendingTask({ home, content: "> 绑定码  5fba30\n> 绑定码  62ca4f" }).reason,
    "multiple_binding_tokens");

  b.pending_token = "5fba30";
  delete b.topic_generation_state;
  delete b.channel_generation_id;
  writeRegistry([a, b], path.join(home, "registry.json"));
  assert.equal(findPendingTask({ home, content: "> 绑定码  5fba30" }).reason,
    "duplicate_pending_binding_token");
});

test("没有引用码时保留唯一 pending 的兼容路径", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30",
  });
  writeRegistry([task], path.join(home, "registry.json"));
  const selected = findPendingTask({ home, content: "<at>M5Codex</at>" });
  assert.equal(selected.ok, true);
  assert.equal(selected.source, "sole_pending");
});

test("Codex 旧 task 登记只读投影成一份订阅和两个本地目标", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  fs.mkdirSync(root);
  const now = Date.parse("2026-08-22T08:00:00Z");
  const a = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30", now,
  });
  const b = makeTaskEntry({
    root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "62ca4f", now,
  });
  writeRegistry([a, b], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const before = fs.readFileSync(path.join(home, "registry.json"), "utf-8");

  const model = buildCodexSubscriptionProjection({ home });
  assert.equal(model.ok, true);
  assert.equal(model.subscriptions.length, 1);
  assert.equal(model.pending_bindings.length, 2);
  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(THREAD_A), false);
  assert.equal(serialized.includes(THREAD_B), false);
  assert.equal(fs.readFileSync(path.join(home, "registry.json"), "utf-8"), before);
  assert.equal(fs.existsSync(path.join(home, "subscriptions")), false);
});

test("Codex 首次认领 shadow 与现行绑定码选择一致且不写 task registry", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  fs.mkdirSync(root);
  const now = Date.parse("2026-08-22T08:00:00Z");
  const a = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30", now,
  });
  const b = makeTaskEntry({
    root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "62ca4f", now,
  });
  writeRegistry([a, b], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const event = {
    message_id: "msg_shadow", session_id: "session_shadow",
    sender_id: TEMPLATE.frank_sender_id, created_at_ms: now - 1000,
    content: '<at id="ou_same">M5Codex</at>\n> 绑定码  62ca4f',
  };
  const pending = findPendingTask({ home, content: event.content, now });
  const legacy = evaluatePromotion({ event, template: TEMPLATE, pending, now });
  const before = fs.readFileSync(path.join(home, "registry.json"), "utf-8");
  const shadow = shadowCodexFirstClaim({
    event, template: TEMPLATE, callerAgentUid: TEMPLATE.agent_uid,
    legacyPending: pending, legacyPromotion: legacy, home, now,
  });
  assert.equal(shadow.match, true);
  assert.deepEqual(shadow.scope_unverified, ["chat_id"]);
  assert.equal(fs.readFileSync(path.join(home, "registry.json"), "utf-8"), before);
});

test("完整入站链路用引用绑定码在多个 pending 中只绑定目标 task", () => {
  const home = temp();
  const root = path.join(home, "same-project");
  const bin = path.join(home, "bin");
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const a = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "5fba30",
  });
  const b = makeTaskEntry({
    root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "62ca4f",
  });
  writeRegistry([a, b], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const fakeAily = path.join(bin, "aily-cli");
  fs.writeFileSync(fakeAily, [
    "#!/usr/bin/env node",
    "process.stdout.write(process.env.FAKE_AILY_ENVELOPE);",
  ].join("\n") + "\n", { mode: 0o700 });
  const content = [
    '<at id="ou_same" type="employee">M5Codex</at>',
    "",
    "> **[引用]**",
    "> 🌉 hv-meeting",
    ">",
    "> 绑定码    62ca4f",
  ].join("\n");
  const envelope = JSON.stringify({
    envelopes: [{
      type: "message.create",
      payload: JSON.stringify({
        message: {
          id: "msg_token_handshake", sessionID: "session_token_b", role: "user",
          createdBy: TEMPLATE.frank_sender_id, createdAtMs: Date.now(), content,
        },
      }),
    }],
  });
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "aily-inbound.mjs")], {
    encoding: "utf-8",
    env: {
      ...isolatedEnv(),
      PATH: bin + path.delimiter + process.env.PATH,
      FEISHU_CODEX_BRIDGE_HOME: home,
      AILY_CLI_CALLER_AGENT_UID: TEMPLATE.agent_uid,
      AILY_CLI_SESSION_ID: "session_token_b",
      AILY_CLI_RUN_ID: "run_token_b",
      FAKE_AILY_ENVELOPE: envelope,
      FEISHU_DIALOGUE_AUTHORIZATION_SHADOW: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /绑定完成 · B/u);
  const tasks = loadRegistry(path.join(home, "registry.json")).tasks;
  const afterA = tasks.find((task) => task.codex_thread_id === THREAD_A);
  const afterB = tasks.find((task) => task.codex_thread_id === THREAD_B);
  assert.equal(afterA.inbound_state, "pending");
  assert.equal(afterA.session_id, null);
  assert.equal(afterB.inbound_state, "bound");
  assert.equal(afterB.session_id, "session_token_b");
  const receipts = fs.readdirSync(taskPaths(afterB, home).receipts).filter((name) => name.startsWith("bound-"));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(taskPaths(afterB, home).receipts, receipts[0]), "utf-8"));
  assert.equal(receipt.subscription_claim_shadow.match, true);
  assert.deepEqual(receipt.subscription_claim_shadow.scope_unverified, ["chat_id"]);
  const shadowPaths = taskPaths(afterB, home);
  assert.equal(fs.readdirSync(path.join(shadowPaths.dialoguePlannerShadow, "authorizations")).length,
    1);
  assert.equal(fs.readdirSync(path.join(shadowPaths.dialoguePlannerShadow, "events")).length, 1);
  const shadowEvidence = JSON.parse(fs.readFileSync(path.join(
    shadowPaths.dialoguePlannerShadow,
    "events",
    fs.readdirSync(path.join(shadowPaths.dialoguePlannerShadow, "events"))[0],
  ), "utf-8"));
  assert.equal(shadowEvidence.comparison.legacy_disposition, "accepted",
    "空 mention 只是内容为空，binding 授权本身已通过");
  assert.equal(shadowEvidence.comparison.candidate_reason, "chat_scope_unverified");
});

test("Feishu session 与 Codex thread 是两把独立且精确的键", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const routed = findTaskForFeishuSession({ sessionId: "aily_session_a", home });
  assert.equal(routed.ok, true);
  assert.equal(routed.mapping.session_id, "aily_session_a");
  assert.equal(routed.mapping.codex_thread_id, THREAD_A);
  assert.equal(routed.mapping.inbound_prefix, null);
  assert.equal(findTaskForFeishuSession({ sessionId: THREAD_A, home }).ok, false,
    "不能拿 Codex thread id 当 Aily session 路由");
});

test("暂停连接会同时关闭入站、Stop 入队和发布资格，恢复时复用原登记", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const paused = setTaskConnectionStatus({ threadId: THREAD_A, status: "paused", home, now: 1000 });
  assert.equal(paused.ok, true);
  assert.equal(paused.changed, true);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_A, home }).ok, false);
  assert.equal(findTaskForFeishuSession({ sessionId: "aily_session_a", home }).ok, false);
  assert.equal(findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task.status, "paused");

  const stop = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "stop-hook.mjs")], {
    input: JSON.stringify({
      session_id: THREAD_A, turn_id: "turn_paused", cwd: root, last_assistant_message: "不应入队",
    }),
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(listPending({ outboxDir: taskPaths(task, home).outbox }).length, 0);

  const resumed = setTaskConnectionStatus({ threadId: THREAD_A, status: "active", home, now: 2000 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.changed, true);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_A, home }).ok, true);
  assert.equal(findTaskForFeishuSession({ sessionId: "aily_session_a", home }).ok, true);
  assert.equal(resumed.task.root_message_id, "om_a");
});

test("active 但首次 mention 已过期的 task 可只刷新原话题握手窗口", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.bound_at = "2026-01-01T00:00:00.000Z";
  delete task.pending_expires_at;
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));

  const now = Date.parse("2026-08-22T05:00:00.000Z");
  assert.equal(findPendingTask({ home, now }).reason, "pending_binding_expired");
  const refreshed = refreshPendingTaskBinding({ threadId: THREAD_A, home, now });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.task.root_message_id, "om_a");
  assert.equal(refreshed.task.inbound_state, "pending");
  assert.equal(refreshed.task.session_id ?? null, null);
  assert.equal(findPendingTask({ home, now }).ok, true);
});

test("Codex adapter 轮转期间旧 session 继续路由，认领后新旧代际原子切换", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_old", token: "aaa111", now: 1000,
  });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const first = promoteTask({
    logicalTaskKey: task.logical_task_key,
    generationId: task.channel_generation_id,
    sessionId: "session_old",
    home,
    now: 1100,
  });
  assert.equal(first.ok, true);
  assert.equal(findTaskForFeishuSession({ sessionId: "session_old", home }).ok, true);

  const prepared = prepareTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_codex", home, now: 1200,
  });
  assert.equal(prepared.ok, true);
  const registered = registerTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_codex", rootMessageId: "om_new",
    pendingToken: "bbb222", home, now: 1300,
  });
  assert.equal(registered.ok, true);
  assert.equal(findTaskForFeishuSession({ sessionId: "session_old", home }).ok, true,
    "等待新话题 mention 时旧代际必须继续接收入站");
  const waiting = findPendingTask({ home, content: "> 绑定码  bbb222", now: 1400 });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.generationId, registered.generation.channel_generation_id);

  const switched = promoteTask({
    logicalTaskKey: task.logical_task_key,
    generationId: registered.generation.channel_generation_id,
    sessionId: "session_new",
    home,
    now: 1500,
  });
  assert.equal(switched.ok, true);
  assert.equal(findTaskForFeishuSession({ sessionId: "session_old", home }).ok, false);
  assert.equal(findTaskForFeishuSession({ sessionId: "session_new", home }).ok, true);
  const stored = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  const state = topicStateForTask(stored).state;
  assert.equal(activeGeneration(state).root_message_id, "om_new");
  assert.equal(state.generations.find((generation) => generation.root_message_id === "om_old").status,
    "read-only");
  assert.equal(resolveTaskOutboundGeneration(stored, switched.previousGeneration.channel_generation_id)
    .rootMessageId, "om_old", "轮转前冻结的结果仍回原话题");
  const status = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "codex", "feishu-status.mjs"),
    "--thread-id", THREAD_A,
  ], { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(status.status, 0, status.stderr);
  // 迁到四层之后措辞变了，**测的仍是同一件事**：有 1 个只读历史代际。
  assert.match(status.stdout, /只读历史.*1 个代际/u,
    "只读历史那条事实必须还在：" + status.stdout);
  assert.match(status.stdout, /第 3 层 · 精确通道绑定/u, "而且要出现在第 3 层里");
});

test("Codex registry adapter 原子持久化代际计数，旧登记不会回扫历史", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_old", token: "aaa111", now: 1000,
  });
  writeRegistry([task], path.join(home, "registry.json"));
  promoteTask({
    logicalTaskKey: task.logical_task_key, generationId: task.channel_generation_id,
    sessionId: "session_old", home, now: 1100,
  });
  const first = recordTaskTopicActivity({
    threadId: THREAD_A, generationId: task.channel_generation_id,
    eventKey: "inbound-one", home, now: 1200,
  });
  const duplicate = recordTaskTopicActivity({
    threadId: THREAD_A, generationId: task.channel_generation_id,
    eventKey: "inbound-one", home, now: 1300,
  });
  assert.equal(first.messageCount, 1);
  assert.equal(duplicate.counted, false);
  const stored = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  assert.equal(activeGeneration(topicStateForTask(stored).state).activity.message_count, 1);
});

test("Codex 轮转取消只退休 pending generation，不影响旧 active", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_old", token: "aaa111", now: 1000,
  });
  writeRegistry([task], path.join(home, "registry.json"));
  promoteTask({
    logicalTaskKey: task.logical_task_key, generationId: task.channel_generation_id,
    sessionId: "session_old", home, now: 1100,
  });
  prepareTaskTopicRotation({ threadId: THREAD_A, operationId: "op_cancel", home, now: 1200 });
  registerTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_cancel", rootMessageId: "om_new",
    pendingToken: "bbb222", home, now: 1300,
  });
  const cancelled = closeTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_cancel",
    reason: ROTATION_STATUS.CANCELLED, home, now: 1400,
  });
  assert.equal(cancelled.ok, true);
  const state = topicStateForTask(cancelled.task).state;
  assert.equal(activeGeneration(state).root_message_id, "om_old");
  assert.equal(pendingGeneration(state), null);
});

test("Codex 轮转 CLI 可显式取消 pending，且完全不调用飞书", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_old", token: "aaa111", now: 1000,
  });
  writeRegistry([task], path.join(home, "registry.json"));
  promoteTask({
    logicalTaskKey: task.logical_task_key, generationId: task.channel_generation_id,
    sessionId: "session_old", home, now: 1100,
  });
  prepareTaskTopicRotation({ threadId: THREAD_A, operationId: "op_cli_cancel", home, now: 1200 });
  registerTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_cli_cancel", rootMessageId: "om_new",
    pendingToken: "bbb222", home, now: 1300,
  });
  const cancelled = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "codex", "feishu-rotate.mjs"),
    "--project", root,
    "--thread-id", THREAD_A,
    "--cancel",
    // **取消要取消的票。**一张创建票拿来取消会被拒 —— 那正是参数绑定的意义。
    "--apply", ...withIntent("rotate", THREAD_A, home, { op: "cancel" }),
  ], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /旧话题仍是唯一 active/u);
  const stored = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  assert.equal(pendingGeneration(topicStateForTask(stored).state), null);
});

test("过期的轮转候选携带精确 operation，可在一次原子写中退休", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "A", rootMessageId: "om_old", token: "aaa111", now: 1000,
  });
  writeRegistry([task], path.join(home, "registry.json"));
  promoteTask({
    logicalTaskKey: task.logical_task_key, generationId: task.channel_generation_id,
    sessionId: "session_old", home, now: 1100,
  });
  prepareTaskTopicRotation({ threadId: THREAD_A, operationId: "op_expire", home, now: 1200 });
  registerTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_expire", rootMessageId: "om_new",
    pendingToken: "bbb222", claimExpiresAt: new Date(1400).toISOString(), home, now: 1300,
  });
  const expired = findPendingTask({ home, content: "> 绑定码  bbb222", now: 1500 });
  assert.equal(expired.reason, "pending_binding_expired");
  assert.equal(expired.operationId, "op_expire");
  const closed = closeTaskTopicRotation({
    threadId: THREAD_A, operationId: expired.operationId,
    reason: ROTATION_STATUS.EXPIRED, home, now: 1500,
  });
  assert.equal(closed.ok, true);
  assert.equal(activeGeneration(topicStateForTask(closed.task).state).root_message_id, "om_old");
  assert.equal(pendingGeneration(topicStateForTask(closed.task).state), null);
});

test("轮转前后已冻结的两个 outbox 目标分别发布到旧话题和新话题", () => {
  const { home, task, bin, argsFile } = autoPublishFixture();
  const first = promoteTask({
    logicalTaskKey: task.logical_task_key, generationId: task.channel_generation_id,
    sessionId: "session_old", home, now: 1100,
  });
  prepareTaskTopicRotation({ threadId: THREAD_A, operationId: "op_publish", home, now: 1200 });
  const registered = registerTaskTopicRotation({
    threadId: THREAD_A, operationId: "op_publish", rootMessageId: "om_new",
    pendingToken: "bbb222", home, now: 1300,
  });
  const switched = promoteTask({
    logicalTaskKey: task.logical_task_key,
    generationId: registered.generation.channel_generation_id,
    sessionId: "session_new", home, now: 1400,
  });
  assert.equal(switched.ok, true);
  fs.writeFileSync(bin,
    "#!" + process.execPath + "\n" +
    "const fs = require('node:fs');\n" +
    "fs.appendFileSync(" + JSON.stringify(argsFile) + ", JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
    "process.stdout.write('{\"ok\":true,\"data\":{\"message_id\":\"om_sent\"}}');\n",
    { mode: 0o700 });
  fs.rmSync(argsFile, { force: true });
  const current = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  const outboxDir = taskPaths(current, home).outbox;
  appendEvent({
    outboxDir, kind: "reply", text: "旧请求迟到结果", eventKey: "old-result",
    publishEligible: true,
    targetGenerationId: switched.previousGeneration.channel_generation_id,
  });
  appendEvent({
    outboxDir, kind: "reply", text: "新请求结果", eventKey: "new-result",
    publishEligible: true,
    targetGenerationId: switched.generation.channel_generation_id,
  });
  const published = publishEligibleTaskEvents({ task: current, home });
  assert.equal(published.status, "published");
  assert.equal(published.count, 2);
  const invocations = fs.readFileSync(argsFile, "utf-8").trim().split("\n").map(JSON.parse);
  const roots = invocations.map((args) => args[args.indexOf("--message-id") + 1]).sort();
  assert.deepEqual(roots, ["om_new", "om_a"].sort());
  assert.equal(listPending({ outboxDir }).length, 0);
  assert.equal(first.generation.root_message_id, "om_a");
});

test("bind-task 重跑只续期 active pending，不创建或回复第二个话题", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "# A\n");
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.bound_at = "2026-01-01T00:00:00.000Z";
  delete task.pending_expires_at;
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));

  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
    "--project", root, "--thread-id", THREAD_A, "--name", "A", "--apply", ...withIntent("bind", THREAD_A, home, { project: root, name: "A" })], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /刷新首次绑定窗口/u);
  const after = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  assert.equal(after.root_message_id, "om_a");
  assert.equal(after.inbound_state, "pending");
  assert.equal(Number.isFinite(Date.parse(after.pending_expires_at)), true);
});

test("pending 续期不被超过编辑时限的旧话题标题阻断", () => {
  const home = temp();
  const root = path.join(home, "project");
  const bin = path.join(home, "fake-lark.sh");
  const configBase = path.join(home, "agents");
  const credentialDir = path.join(configBase, TEMPLATE.agent_uid);
  fs.mkdirSync(root);
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# New\n");
  fs.writeFileSync(path.join(credentialDir, "config.json"), JSON.stringify({
    apps: [{ name: TEMPLATE.lark_cli_profile, appId: TEMPLATE.transport_app_id }],
  }));
  fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify({
    ...TEMPLATE, lark_cli_bin: bin, lark_cli_config_base: configBase,
  }));
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "Old", rootMessageId: "om_a", token: "a",
  });
  task.bound_at = "2026-01-01T00:00:00.000Z";
  delete task.pending_expires_at;
  writeRegistry([task], path.join(home, "registry.json"));

  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
    "--project", root, "--thread-id", THREAD_A, "--name", "New", "--apply", ...withIntent("bind", THREAD_A, home, { project: root, name: "New" })], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /刷新首次绑定窗口/u);
  assert.match(run.stderr, /不影响.*首次.*握手/u);
  const after = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  assert.equal(after.task_display_name, "Old");
  assert.equal(Number.isFinite(Date.parse(after.pending_expires_at)), true);
});

test("task 控制脚本不猜 thread，暂停和恢复都不调用飞书", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));
  const env = { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home };

  const status = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"),
    "--thread-id", THREAD_A], { encoding: "utf-8", env });
  assert.equal(status.status, 0, status.stderr);
  // 同上：四层里"接入状态"由第 3 层的入站行和绑定名称表达。
  assert.match(status.stdout, /第 3 层 · 精确通道绑定/u, status.stdout);
  assert.match(status.stdout, /入站/u);
  assert.match(status.stdout, /当前代际/u);
  // 四层里这行在第 4 层，措辞是「0 / 30 条（还剩 30 条）」——
  // **测的仍是同一件事**：计数 0、阈值 30。
  assert.match(status.stdout, /自动轮转.*0 \/ 30 条/u, status.stdout);
  assert.match(status.stdout, /第 4 层 · 交互策略/u);
  assert.equal(status.stdout.includes(THREAD_A), false);
  assert.equal(status.stdout.includes("om_a"), false);

  const dry = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-unbind.mjs"),
    "--thread-id", THREAD_A], { encoding: "utf-8", env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_A, home }).ok, true);

  const paused = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-unbind.mjs"),
    "--thread-id", THREAD_A, "--apply", ...withIntent("unbind", THREAD_A, home)], { encoding: "utf-8", env });
  assert.equal(paused.status, 0, paused.stderr);
  assert.match(paused.stdout, /已暂停/);
  assert.equal(findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task.status, "paused");

  const resumed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
    "--project", root, "--thread-id", THREAD_A, "--apply", ...withIntent("bind", THREAD_A, home, { project: root })], { encoding: "utf-8", env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /复用原话题|继续使用原话题/);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_A, home }).ok, true);
});

test("registry 对重复 thread/topic/session fail-closed", () => {
  const root = temp();
  const a = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  const b = makeTaskEntry({ root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "b" });
  b.codex_thread_id = THREAD_A;
  assert.deepEqual(validateRegistryTasks([a, b]).duplicateFields, ["codex_thread_id"]);
  assert.throws(() => writeRegistry([a, b], path.join(temp(), "registry.json")), /重复绑定/);
});

test("Codex task 的 claim/outbox 全部在 ~/.codex 桥状态下，不落项目目录", () => {
  const home = temp();
  const root = path.join(home, "worktree");
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  const paths = taskPaths(task, home);
  assert.equal(paths.root.startsWith(path.join(home, "tasks") + path.sep), true);
  assert.equal(paths.root.startsWith(root + path.sep), false);
  assert.equal(mappingForTask(task, { home }).codex_thread_id, THREAD_A);
  assert.equal(task.auto_publish_on_completion, true);
});

test("outbox 按事件键而非正文去重", () => {
  const outboxDir = path.join(temp(), "outbox");
  const first = appendEvent({ outboxDir, kind: "reply", text: "相同答复", eventKey: "turn-1" });
  assert.equal(first.ok, true);
  assert.match(path.basename(first.file), /^event-[0-9a-f]{16}\.json$/);
  assert.equal(appendEvent({ outboxDir, kind: "reply", text: "相同答复", eventKey: "turn-2" }).ok, true);
  assert.equal(appendEvent({ outboxDir, kind: "reply", text: "被改写也不应重入", eventKey: "turn-1" }).reason, "duplicate");
  assert.equal(listPending({ outboxDir }).length, 2);
});

test("Codex 出站使用无顶底栏的轻量 Card 2.0，并保留语义摘要", () => {
  const reply = composeCodexOutboundCard([
    { kind: "reply", text: "这是最终答复", created_at: "2026-08-21T00:00:00Z" },
  ], { taskName: "高价值会议｜项目推进" });
  assert.equal(validateCodexOutboundCard(reply).ok, true);
  assert.equal(reply.schema, "2.0");
  assert.equal(reply.config.width_mode, "default");
  assert.equal(reply.header, undefined);
  assert.equal(reply.body.elements.length, 1);
  assert.equal(reply.body.elements[0].tag, "markdown");
  assert.equal(reply.body.elements[0].element_id, "agent_reply");
  assert.match(JSON.stringify(reply.body.elements[0]), /这是最终答复/u);
  assert.equal(JSON.stringify(reply).includes("column_set"), false);
  assert.equal(JSON.stringify(reply).includes("background_style"), false);
  assert.equal(reply.config.summary.content, "这是最终答复");
  assert.equal(JSON.stringify(reply).includes("behaviors"), false);

  const risk = composeCodexOutboundCard([
    { kind: "risk", text: "任务没有完成" },
  ], { taskName: "风险测试" });
  assert.equal(risk.header, undefined);
  assert.equal(risk.body.elements[0].tag, "markdown");
  assert.equal(risk.config.summary.content, "风险：任务没有完成");
});

test("本地 Codex 输入与回复进入同一张卡，飞书入站回复不复读原消息", () => {
  const local = composeCodexOutboundCard([{
    kind: "reply",
    text: "我已经完成修改",
    input_origin: "local",
    input_text: "请把输入和回复放在一张卡里",
  }], { taskName: "配对测试" });
  assert.equal(local.body.elements.length, 2);
  assert.equal(local.body.elements[0].element_id, "user_quote");
  assert.equal(local.body.elements[0].text_size, "notation");
  assert.match(local.body.elements[0].content, /^> <font color='grey'>/u);
  assert.match(JSON.stringify(local.body.elements[0]), /请把输入和回复放在一张卡里/u);
  assert.equal(local.body.elements[1].element_id, "agent_reply");
  assert.match(JSON.stringify(local.body.elements[1]), /我已经完成修改/u);
  assert.equal(JSON.stringify(local).includes("你的输入"), false);
  assert.equal(JSON.stringify(local).includes("Codex 回复"), false);
  assert.equal(local.config.summary.content, "请把输入和回复放在一张卡里");

  const inbound = composeCodexOutboundCard([{
    kind: "reply",
    text: "这是飞书指令的执行结果",
    input_origin: null,
    input_text: null,
  }], { taskName: "去重测试" });
  assert.equal(inbound.body.elements.length, 1);
  assert.equal(inbound.body.elements[0].element_id, "agent_reply");
  assert.equal(JSON.stringify(inbound).includes("user_quote"), false);
  assert.match(JSON.stringify(inbound), /这是飞书指令的执行结果/u);
  assert.equal(inbound.config.summary.content, "这是飞书指令的执行结果");
});

test("会话列表摘要取首条有效纯文本，并清理 Markdown 与 mention", () => {
  const local = composeCodexOutboundCard([{
    kind: "reply", text: "回复", input_origin: "local",
    input_text: "# Files mentioned by the user:\n截图.png\n\n## My request:\n" +
      "<at id=ou_someone></at> **修复侧栏摘要**\n第二行不应进入摘要",
  }], { taskName: "摘要测试" });
  assert.equal(local.config.summary.content, "修复侧栏摘要");
  assert.match(local.body.elements[0].content, /修复侧栏摘要.*<br>第二行不应进入摘要/u);

  const progress = composeCodexOutboundCard([
    { kind: "milestone", text: "- 已经完成第一阶段\n更多说明" },
  ], { taskName: "摘要测试" });
  assert.equal(progress.config.summary.content, "里程碑：已经完成第一阶段");
});

test("进展正文把动态任务名收敛为单行普通文本", () => {
  const card = composeCodexOutboundCard([
    { kind: "milestone", text: "完成" },
  ], { taskName: "  *危险* <at id=ou_someone></at>\n下一行  " });
  const content = card.body.elements[0].content;
  assert.equal(content.includes("<at"), false);
  assert.match(content, /&#42;危险&#42;/u);
  assert.match(content, /&#60;at id=ou&#95;someone&#62;&#60;\/at&#62; 下一行 · 进展/u);
});

test("reply 一轮一张卡，非 reply 进展继续合批", () => {
  const batches = outboundCardBatches([
    { kind: "milestone", text: "M1" },
    { kind: "risk", text: "R1" },
    { kind: "reply", text: "A1", input_origin: "local", input_text: "Q1" },
    { kind: "reply", text: "A2", input_origin: "local", input_text: "Q2" },
    { kind: "next", text: "N1" },
  ]);
  assert.deepEqual(batches.map((batch) => batch.map((record) => record.kind)), [
    ["milestone", "risk"], ["reply"], ["reply"], ["next"],
  ]);
});

test("本地输入缓存按精确回合读取并可恢复清理", () => {
  const dir = path.join(temp(), "turn-inputs");
  assert.equal(storeTurnInput({ dir, key: "turn-a", text: "  本地输入  " }).ok, true);
  assert.equal(readTurnInput({ dir, key: "turn-a" }).text, "本地输入");
  assert.equal(readTurnInput({ dir, key: "turn-b" }).reason, "not_found");
  assert.equal(clearTurnInput({ dir, key: "turn-a" }).ok, true);
  assert.equal(readTurnInput({ dir, key: "turn-a" }).reason, "not_found");
});

test("卡片长正文保持单一回复区，并中和模型正文里的原生卡片 mention", () => {
  const source = "<at id=ou_someone></at>\n" + "很长的答复".repeat(500);
  const card = composeCodexOutboundCard([{ kind: "reply", text: source }], { taskName: "T" });
  assert.equal(card.body.elements[0].tag, "markdown");
  const content = card.body.elements[0].content;
  assert.equal(content.includes("<at id="), false);
  assert.match(content, /&#60;at id=ou_someone>/u);
  assert.equal(neutralizeCardMentions("普通文本"), "普通文本");
});

test("自动发布通过 interactive 回复原话题，绑定状态仍可使用文本发布", () => {
  const { home, task, bin, argsFile } = autoPublishFixture();
  const outboxDir = taskPaths(task, home).outbox;
  appendEvent({
    outboxDir, kind: "reply", text: "卡片答复", eventKey: "card-reply", publishEligible: true,
  });
  assert.equal(publishEligibleTaskEvents({ task, home }).status, "published");
  const cardArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8"));
  assert.equal(cardArgs.includes("--text"), false);
  assert.equal(cardArgs[cardArgs.indexOf("--msg-type") + 1], "interactive");
  const card = JSON.parse(cardArgs[cardArgs.indexOf("--content") + 1]);
  assert.equal(card.schema, "2.0");
  assert.equal(card.header, undefined);
  assert.equal(card.body.elements.length, 1);
  assert.equal(card.body.elements[0].element_id, "agent_reply");
  assert.match(card.body.elements[0].content, /卡片答复/u);
  assert.equal(cardArgs.includes("--reply-in-thread"), true);

  publishDraft({
    profile: "platform-bot", rootMessageId: "om_root", text: "绑定状态", larkBin: bin,
  });
  const textArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8"));
  assert.equal(textArgs[textArgs.indexOf("--text") + 1], "绑定状态");
  assert.equal(textArgs.includes("--msg-type"), false);
});

test("只有成功送达的业务卡片才计入代际，本地输入与回复合计 2", () => {
  const { home, root, task } = autoPublishFixture();
  promoteTask({
    logicalTaskKey: task.logical_task_key,
    generationId: task.channel_generation_id,
    sessionId: "session_active",
    home,
    now: 1100,
  });
  const current = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  const outboxDir = taskPaths(current, home).outbox;
  appendEvent({
    outboxDir,
    kind: "reply",
    text: "本地答复",
    eventKey: "local-pair-published",
    publishEligible: true,
    inputOrigin: "local",
    inputText: "本地输入",
    targetGenerationId: current.channel_generation_id,
  });
  assert.equal(publishEligibleTaskEvents({ task: current, home }).status, "published");
  const stored = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  assert.equal(activeGeneration(topicStateForTask(stored).state).activity.message_count, 2);
  assert.equal(fs.existsSync(path.join(root, ".runtime-data")), false,
    "Codex 代际计数仍必须留在 Git 外 bridge home");
});

test("自动发布只消费显式 eligible 事件，不补发升级前的历史 outbox", () => {
  const { home, task } = autoPublishFixture();
  const outboxDir = taskPaths(task, home).outbox;
  appendEvent({ outboxDir, kind: "reply", text: "历史积压", eventKey: "old" });
  appendEvent({ outboxDir, kind: "reply", text: "本轮答复", eventKey: "new", publishEligible: true });
  const published = publishEligibleTaskEvents({ task, home });
  assert.equal(published.status, "published");
  assert.equal(published.count, 1);
  assert.deepEqual(listPending({ outboxDir }).map((event) => event.text), ["历史积压"]);
});

test("入站 Stop 的答复只有经 watcher 提升资格后才能自动发布", () => {
  const { home, task } = autoPublishFixture();
  const outboxDir = taskPaths(task, home).outbox;
  appendEvent({ outboxDir, kind: "reply", text: "严格终局答复", eventKey: "claim-reply" });
  assert.equal(publishEligibleTaskEvents({ task, home }).status, "empty");
  assert.equal(markPublishEligibleByEventKey({ outboxDir, eventKey: "claim-reply" }).ok, true);
  assert.equal(publishEligibleTaskEvents({ task, home }).status, "published");
  assert.equal(listPending({ outboxDir }).length, 0);
});

test("严格终局失败的半成品答复保留证据但退出发布队列", () => {
  const outboxDir = path.join(temp(), "outbox");
  const first = appendEvent({ outboxDir, kind: "reply", text: "半成品", eventKey: "failed-claim" });
  assert.equal(first.ok, true);
  assert.equal(suppressPublishByEventKey({ outboxDir, eventKey: "failed-claim", reason: "nonzero_exit" }).ok, true);
  assert.equal(listPending({ outboxDir }).length, 0);
  const saved = JSON.parse(fs.readFileSync(first.file, "utf-8"));
  assert.equal(saved.text, "半成品");
  assert.equal(saved.publish_suppressed_reason, "nonzero_exit");
  assert.equal(saved.published_at, null);
});

test("自动发布失败保留 eligible 事件，后续回合可以重试", () => {
  const { home, task } = autoPublishFixture({ workingPublisher: false });
  promoteTask({
    logicalTaskKey: task.logical_task_key,
    generationId: task.channel_generation_id,
    sessionId: "session_active",
    home,
    now: 1100,
  });
  const current = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  const outboxDir = taskPaths(current, home).outbox;
  appendEvent({ outboxDir, kind: "reply", text: "暂时发不出", eventKey: "retry", publishEligible: true });
  const published = publishEligibleTaskEvents({ task: current, home });
  assert.equal(published.status, "error");
  assert.equal(listPending({ outboxDir }).length, 1);
  assert.equal(typeof listPending({ outboxDir })[0].publish_eligible_at, "string");
  assert.equal(activeGeneration(topicStateForTask(
    findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task,
  ).state).activity.message_count, 0, "发布失败不得提前计数");
});

test("Stop 与 watcher 并发写同一事件键时只留下一个文件", () => {
  const dir = temp();
  const outboxDir = path.join(dir, "outbox");
  const worker = path.join(dir, "append-worker.mjs");
  const outboxModule = pathToFileURL(path.join(ROOT, "scripts", "outbox.mjs")).href;
  fs.writeFileSync(worker, [
    "import { appendEvent } from " + JSON.stringify(outboxModule) + ";",
    "appendEvent({ outboxDir: process.env.TEST_OUTBOX, kind: 'reply', text: '同一轮', eventKey: 'same-turn' });",
  ].join("\n") + "\n");
  const command = Array.from({ length: 12 }, () =>
    JSON.stringify(process.execPath) + " " + JSON.stringify(worker) + " &").join("\n") + "\nwait\n";
  const run = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), TEST_OUTBOX: outboxDir },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal(listPending({ outboxDir }).length, 1);
});

test("Prompt hook 只接受占据整条输入的显式控制命令", () => {
  assert.equal(isBindingPrompt("把这个任务接到飞书"), false);
  assert.equal(isBindingPrompt("飞书接入当前任务"), false);
  assert.equal(isBindingPrompt("新建一个飞书话题"), false);
  assert.equal(isBindingPrompt("/init"), false, "/init 是 AGENTS.md 初始化，不是绑定命令");
  assert.equal(classifyFeishuPrompt("/init"), "init");
  assert.equal(classifyFeishuPrompt("$feishu-bind"), "bind");
  assert.equal(classifyFeishuPrompt("$feishu-unbind"), "unbind");
  assert.equal(classifyFeishuPrompt("$feishu-status"), "status");
  assert.equal(classifyFeishuPrompt("$feishu-rotate"), "rotate");
  assert.equal(classifyFeishuPrompt("$feishu-mode"), "mode");
  assert.equal(classifyFeishuPrompt("$feishu-mode dialogue"), "mode-dialogue");
  assert.equal(classifyFeishuPrompt("$feishu-mode mapping"), "mode-mapping");
  assert.equal(classifyFeishuPrompt("[$feishu-bind](/Users/test/.codex/skills/feishu-bind/SKILL.md)"), "bind");
  assert.equal(classifyFeishuPrompt("[$feishu-unbind](/Users/test/.codex/skills/feishu-unbind/SKILL.md)"), "unbind");
  assert.equal(classifyFeishuPrompt("[$feishu-status](/Users/test/.codex/skills/feishu-status/SKILL.md)"), "status");
  assert.equal(classifyFeishuPrompt("[$feishu-rotate](/Users/test/.codex/skills/feishu-rotate/SKILL.md)"), "rotate");
  assert.equal(classifyFeishuPrompt("[$feishu-mode](/Users/test/.codex/skills/feishu-mode/SKILL.md)"), "mode");
  assert.equal(classifyFeishuPrompt(
    "[$feishu-mode](/Users/test/.codex/skills/feishu-mode/SKILL.md)&#x20;dialogue"), "mode-dialogue");
  assert.equal(classifyFeishuPrompt(
    "[$feishu-bind](/Users/test/.codex/skills/feishu-bind/SKILL.md)&#x20;"), "bind");
  assert.equal(classifyFeishuPrompt("把当前 task 撤销飞书接入"), "none");
  assert.equal(classifyFeishuPrompt("查看当前 task 的飞书接入状态"), "none");
  assert.equal(classifyFeishuPrompt("是不是也可以加个命令来实现接入飞书和撤销接入？"), "none");
  assert.equal(classifyFeishuPrompt("请评审 `$feishu-bind` 的设计"), "none");
  assert.equal(classifyFeishuPrompt("Agent 建议：$feishu-bind"), "none");
  assert.equal(classifyFeishuPrompt("> [$feishu-bind](/Users/test/.codex/skills/feishu-bind/SKILL.md)"), "none");
  assert.equal(classifyFeishuPrompt(
    "[$feishu-bind](/Users/test/.codex/skills/other/SKILL.md)"), "invalid-bind");
  assert.equal(classifyFeishuPrompt("$feishu-bind 然后继续"), "invalid-bind");
  assert.equal(classifyFeishuPrompt("$feishu-unbind 暂停一下"), "invalid-unbind");
  assert.equal(classifyFeishuPrompt("$feishu-rotate 现在"), "invalid-rotate");
  assert.equal(classifyFeishuPrompt("$feishu-mode 自动"), "invalid-mode");
  assert.equal(classifyFeishuPrompt(
    "[$feishu-status](/Users/test/.codex/skills/feishu-status/SKILL.md) 看看"), "invalid-status");
  assert.equal(isBindingPrompt("继续写代码"), false);
  assert.equal(isBindingPrompt([
    '<at id="ou_m5">M5Codex</at>', "", "**[引用]**", "🌉 Codex-Lark", "",
    "Codex—飞书桥的长期承接项目。",
  ].join("\n")), false, "引用根消息中的‘飞书…承接’不是绑定意图");
  const c = composeBindingContext({ bridgeRoot: "/bridge", cwd: "/work", threadId: THREAD_A, chatName: "群" });
  assert.match(c, new RegExp(THREAD_A));
  assert.equal(c.includes("resume --last"), false);
  assert.match(c, /bind-task\.mjs.*--apply/u);
  assert.equal(c.includes("bind-preview.mjs"), false);
  assert.match(c, /无需再次预览或确认/u);
  assert.match(composeUnbindContext({ bridgeRoot: "/bridge", threadId: THREAD_A }), /feishu-unbind\.mjs/);
  assert.match(composeStatusContext({ bridgeRoot: "/bridge", threadId: THREAD_A }), /feishu-status\.mjs/);
  assert.match(composeRotateContext({ bridgeRoot: "/bridge", threadId: THREAD_A }),
    /feishu-rotate\.mjs.*--apply/u);
  assert.match(composeModeContext({ bridgeRoot: "/bridge", threadId: THREAD_A, mode: "dialogue" }),
    // 参数现在也是 shell 字面量：--mode 'dialogue'，thread id 同理。
    /feishu-mode\.mjs'.*--mode 'dialogue'.*--apply/u);
  assert.equal(composeModeContext({ bridgeRoot: "/bridge", threadId: THREAD_A }).includes("--apply"), false);
});

test("像控制命令但附带正文时明确提示格式，绝不执行或登记未绑定 task", () => {
  const c = composeInvalidControlContext({ action: "bind" });
  assert.match(c, /没有执行任何飞书桥脚本/);
  assert.match(c, /必须单独占一整条输入/);
  assert.match(c, /请只发送 `\$feishu-bind`/);

  const home = temp();
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const hook = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: THREAD_A, turn_id: "turn_invalid_bind", cwd: "/work",
      prompt: "$feishu-bind 绑到测试群",
    }),
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const injected = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /请只发送 `\$feishu-bind`/);
  assert.equal(injected.includes("bind-task.mjs"), false);
  assert.equal(fs.existsSync(path.join(home, "registry.json")), false);
  assert.equal(fs.existsSync(path.join(home, "active-threads")), false);
});

test("$feishu-bind 直接注入幂等绑定命令，不再产生二次确认回合", () => {
  const home = temp();
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const hook = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: THREAD_A,
      turn_id: "turn_bind",
      cwd: "/work",
      prompt: "$feishu-bind",
    }),
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const injected = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /bind-task\.mjs.*--apply/u);
  assert.equal(injected.includes("bind-preview.mjs"), false);
  assert.match(injected, /无需再次预览或确认/u);
  assert.equal(injected.includes("回复“确认”"), false);
});

test("/init 只追加初始化成功后的询问，不触发绑定或飞书写入", () => {
  const c = composeInitContext({ connectionStatus: "none" });
  assert.match(c, /先完整执行 \/init 原本的 AGENTS\.md 初始化/);
  assert.match(c, /如需将当前 Codex task 接入飞书，请运行 `\$feishu-bind`/);
  assert.match(c, /普通自然语言回复不构成控制授权/);
  assert.equal(c.includes("请回复“接入飞书”"), false);
  assert.equal(c.includes("bind-task.mjs"), false);

  const home = temp();
  const hook = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: THREAD_A, turn_id: "turn_init", cwd: "/work", prompt: "/init" }),
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const injected = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /不是飞书绑定命令/);
  assert.equal(fs.existsSync(path.join(home, "registry.json")), false);
  assert.equal(fs.existsSync(path.join(home, "threads")), false);
});

test("Prompt hook 在 Aily/M5Codex 回合只注入数据面命令，不记录 lease 或注入控制面命令", () => {
  assert.equal(isAilyInvocation({ AILY_CLI_SESSION_ID: "session_feishu" }), true);
  assert.equal(isAilyInvocation({}), false);
  const home = temp();
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const hook = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: THREAD_B,
      turn_id: "turn_aily",
      cwd: "/Users/test/aily_workspaces/m5codex",
      prompt: "$feishu-bind",
    }),
    encoding: "utf-8",
    env: {
      ...isolatedEnv(),
      FEISHU_CODEX_BRIDGE_HOME: home,
      AILY_CLI_SESSION_ID: "session_feishu",
      AILY_CLI_CALLER_AGENT_UID: TEMPLATE.agent_uid,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const injected = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(injected.includes("inbound.mjs"), true);
  // 单引号：JSON.stringify 产出双引号，挡得住空格但挡不住 $ / 反引号 / 反斜杠。
  assert.equal(injected.includes("FEISHU_CODEX_BRIDGE_HOME=" + shellQuote(home)), true);
  assert.equal(injected.includes("不得运行 bind-preview.mjs"), true);
  assert.equal(fs.existsSync(path.join(home, "active-threads")), false);

  const wrongCaller = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: THREAD_B, prompt: "$feishu-bind" }),
    encoding: "utf-8",
    env: {
      ...isolatedEnv(),
      FEISHU_CODEX_BRIDGE_HOME: home,
      AILY_CLI_SESSION_ID: "session_feishu",
      AILY_CLI_CALLER_AGENT_UID: "agent_other",
    },
  });
  assert.equal(wrongCaller.status, 0, wrongCaller.stderr);
  assert.equal(wrongCaller.stdout, "");
});

test("Aily 入站上下文不包含建话题命令或 --last", () => {
  const c = composeAilyInboundContext({ bridgeRoot: "/bridge root", home: "/state home" });
  // 单引号而非双引号：双引号内 $、反引号、反斜杠仍会被 shell 解释。
  assert.equal(c.includes("FEISHU_CODEX_BRIDGE_HOME='/state home'"), true);
  assert.equal(c.includes("node '/bridge root/scripts/codex/aily-inbound.mjs'"), true);
  assert.equal(c.includes("scripts/codex/inbound.mjs"), false,
    "hook 不得绕过 dispatcher 直达业务 handler");
  assert.equal(c.includes("bind-task.mjs --project"), false);
  assert.equal(c.includes("--last"), false);
  const skill = fs.readFileSync(path.join(ROOT, "skills", "m5codex-inbound-router", "SKILL.md"), "utf-8");
  // 模板里现在是 {{SCRIPT:codex/aily-inbound.mjs}}，scripts/ 前缀移进了渲染器 ——
  // 引用由渲染器统一负责，模板不再自己拼路径。
  assert.equal(skill.includes("{{SCRIPT:codex/aily-inbound.mjs}}"), true,
    "M5Codex 技能和 hook 必须指向同一个 dispatcher wrapper");
  assert.equal(skill.includes("codex/inbound.mjs"), false,
    "M5Codex 技能不得绕过 dispatcher 直达业务 handler");
});

test("目标 codex-run 优先于残留 Aily 环境，明确禁止再次路由", () => {
  const c = composeRoutedCodexContext();
  assert.match(c, /你现在是目标 Codex task/u);
  assert.match(c, /禁止调用 m5codex-inbound-router/u);
  const home = temp();
  const hook = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: THREAD_A, turn_id: "turn_routed", cwd: "/work", prompt: "/init" }),
    encoding: "utf-8",
    env: {
      ...isolatedEnv(),
      FEISHU_CODEX_BRIDGE_HOME: home,
      FEISHU_BRIDGE_ROLE: "codex-run",
      AILY_CLI_SESSION_ID: "should_not_route",
      AILY_CLI_CALLER_AGENT_UID: TEMPLATE.agent_uid,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const injected = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /已路由指令/u);
  assert.equal(injected.includes("只执行以下命令"), false);
  assert.equal(injected.includes("scripts/codex/inbound.mjs"), false);
});

test("活跃租约让正在运行的 Desktop turn fail-closed", () => {
  const home = temp();
  recordThreadActivity({ threadId: THREAD_A, turnId: "turn_a", cwd: "/work", active: true, home, now: 1000 });
  assert.equal(isThreadBusy(THREAD_A, { home, now: 2000 }), true);
  recordThreadActivity({ threadId: THREAD_A, turnId: "turn_a", cwd: "/work", active: false, home, now: 3000 });
  assert.equal(isThreadBusy(THREAD_A, { home, now: 4000 }), false);
});

test("Codex JSONL 中间 error 不覆盖最终 turn.completed", () => {
  const dir = temp();
  const logPath = path.join(dir, "run.jsonl");
  const exitPath = path.join(dir, "exit.json");
  const lastMessagePath = path.join(dir, "last.txt");
  fs.writeFileSync(logPath, [
    { type: "thread.started", thread_id: THREAD_A },
    { type: "turn.started" },
    { type: "error", message: "recoverable" },
    { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(exitPath, JSON.stringify({ exit_code: 0 }));
  fs.writeFileSync(lastMessagePath, "最终答复");
  const r = readCodexRunOutcome({ logPath, exitPath, lastMessagePath, expectedThreadId: THREAD_A });
  assert.equal(r.state, "completed");
  assert.equal(r.recoverableErrors, 1);
});

test("Codex runner 观察到不同 thread 时严格失败", () => {
  const dir = temp();
  const logPath = path.join(dir, "run.jsonl");
  const exitPath = path.join(dir, "exit.json");
  const lastMessagePath = path.join(dir, "last.txt");
  fs.writeFileSync(logPath, [
    { type: "thread.started", thread_id: THREAD_B }, { type: "turn.started" }, { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(exitPath, JSON.stringify({ exit_code: 0 }));
  fs.writeFileSync(lastMessagePath, "不该采信");
  assert.equal(readCodexRunOutcome({ logPath, exitPath, lastMessagePath, expectedThreadId: THREAD_A }).reason,
    "thread_mismatch");
});

test("目标 Codex 再次执行入站路由时严格判为 bridge_recursion", () => {
  const dir = temp();
  const logPath = path.join(dir, "run.jsonl");
  const exitPath = path.join(dir, "exit.json");
  const lastMessagePath = path.join(dir, "last.txt");
  fs.writeFileSync(logPath, [
    { type: "thread.started", thread_id: THREAD_A },
    { type: "turn.started" },
    { type: "item.completed", item: {
      type: "command_execution", command: "node /bridge/scripts/codex/inbound.mjs", status: "failed",
    } },
    { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(exitPath, JSON.stringify({ status: "exited", exit_code: 0 }));
  fs.writeFileSync(lastMessagePath, "不应发布的递归错误栈");
  const result = readCodexRunOutcome({ logPath, exitPath, lastMessagePath, expectedThreadId: THREAD_A });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "bridge_recursion");
});

test("bridge_recursion 只识别真实入口执行，不把源码引用和排障命令当递归", () => {
  assert.equal(isCodexInboundExecution("node /bridge/scripts/codex/inbound.mjs"), true);
  assert.equal(isCodexInboundExecution(
    "/bin/zsh -lc \"node /bridge/scripts/codex/aily-inbound.mjs\""), true);
  assert.equal(isCodexInboundExecution(
    "cd /bridge && FEISHU_BRIDGE_ROLE=test node scripts/codex/inbound.mjs"), true);
  assert.equal(isCodexInboundExecution(
    "node -r ts-node/register /bridge/scripts/codex/inbound.mjs"), true);
  assert.equal(isCodexInboundExecution(
    "env bash -c 'FEISHU_CODEX_BRIDGE_HOME=/tmp node /bridge/scripts/codex/aily-inbound.mjs --dry-run'"),
    true);

  // 真实调用形态：router 技能里那条命令的路径本来就带双引号，而 Codex 执行的命令一律是
  // `/bin/zsh -lc "..."` —— 两者叠加，内层就成了 \"…\"。不还原转义的话，
  // **真正的递归**会从检测里漏掉，风险方向从过度检测翻成漏检测。
  assert.equal(isCodexInboundExecution(
    "/bin/zsh -lc \"FEISHU_CODEX_BRIDGE_HOME='/Users/dk/.codex/feishu-bridge' " +
    "node \\\"/bridge/scripts/codex/aily-inbound.mjs\\\"\""), true,
    "zsh -lc 包裹且内层路径用转义双引号，是 router 技能被调用时的真实形态");
  assert.equal(isCodexInboundExecution(
    "/bin/zsh -lc \"bash -lc \\\"node /bridge/scripts/codex/inbound.mjs\\\"\""), true,
    "嵌套包裹也要逐层剥开");
  assert.equal(isCodexInboundExecution(
    "/bin/zsh -lc \"rg -n \\\"bridge_recursion\\\" . && node \\\"/b/scripts/codex/inbound.mjs\\\"\""),
    true, "同一条里既有只读命令又有真实执行时，仍按执行判定");

  const benignCommands = [
    "sed -n '1,220p' scripts/codex/inbound.mjs",
    "rg -n 'bridge_recursion|m5codex-inbound-router|scripts/codex/inbound.mjs' scripts",
    "git add scripts/codex/inbound.mjs skills/m5codex-inbound-router/SKILL.md",
    "/bin/zsh -lc \"git diff -- scripts/codex/inbound.mjs && rg -n 'm5codex-inbound-router' .\"",
    "node --input-type=module <<'NODE'\nconst marker = 'scripts/codex/inbound.mjs';\nNODE",
    "node --input-type=module <<'NODE'\nconst fixture = `\nnode /bridge/scripts/codex/inbound.mjs\n`;\nNODE",
    "node -e \"console.log('scripts/codex/inbound.mjs')\"",
    // 还原转义后仍不能把只读命令算成执行 —— 补洞不能把误报补回来。
    "/bin/zsh -lc \"rg -n \\\"scripts/codex/inbound.mjs\\\" scripts\"",
    "/bin/zsh -lc \"sed -n '1,50p' \\\"/bridge/scripts/codex/inbound.mjs\\\"\"",
    "/bin/zsh -lc \"echo \\\"node /bridge/scripts/codex/inbound.mjs\\\" > /tmp/note.txt\"",
    // 引号内的分隔符不开启新命令。按原始文本无差别切分会切出一个看起来像执行的片段，
    // 而这两条其实各自只是一条 echo / rg。
    "/bin/zsh -lc \"echo \\\"ignore; node /bridge/scripts/codex/inbound.mjs\\\"\"",
    "/bin/zsh -lc \"rg -n \\\"x|node /bridge/scripts/codex/inbound.mjs\\\" scripts\"",
    // POSIX 双引号内 \\' 不是合法转义，不能把它当成干净引号还原掉。
    "/bin/zsh -lc \"node \\\\'/bridge/scripts/codex/inbound.mjs\\\\'\"",
  ];
  for (const command of benignCommands) assert.equal(isCodexInboundExecution(command), false, command);

  const dir = temp();
  const logPath = path.join(dir, "run.jsonl");
  const exitPath = path.join(dir, "exit.json");
  const lastMessagePath = path.join(dir, "last.txt");
  fs.writeFileSync(logPath, [
    { type: "thread.started", thread_id: THREAD_A },
    { type: "turn.started" },
    ...benignCommands.map((command, index) => ({
      type: "item.completed",
      item: { type: "command_execution", command, status: index === 1 ? "failed" : "completed" },
    })),
    { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(exitPath, JSON.stringify({ status: "exited", exit_code: 0 }));
  fs.writeFileSync(lastMessagePath, "真实任务已完成");
  const result = readCodexRunOutcome({
    logPath, exitPath, lastMessagePath, expectedThreadId: THREAD_A,
  });
  assert.equal(result.state, "completed");
  assert.equal(result.finalText, "真实任务已完成");
});

test("Codex 启动前 Git 预检失败不会误报 thread_mismatch", () => {
  const dir = temp();
  const logPath = path.join(dir, "run.jsonl");
  const exitPath = path.join(dir, "exit.json");
  const errPath = path.join(dir, "stderr.log");
  const lastMessagePath = path.join(dir, "last.txt");
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(exitPath, JSON.stringify({ status: "failed", exit_code: 1 }));
  fs.writeFileSync(errPath,
    "Not inside a trusted directory and --skip-git-repo-check was not specified.\n");
  const result = readCodexRunOutcome({
    logPath, exitPath, errPath, lastMessagePath, expectedThreadId: THREAD_A,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "runner_preflight_failed");
  assert.equal(result.diagnostic, "git_repository_required");
  assert.equal(classifyRunnerDiagnostic("secret token abc"), null,
    "未知 stderr 不应进入飞书风险回执");
});

test("run-resume 用精确 UUID、stdin prompt 和 last-message 形成可观察终局", () => {
  const dir = temp();
  const fake = path.join(dir, "fake-codex.sh");
  fs.writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "$ARGS_OUT"
printf '%s|%s|%s' "\${AILY_CLI_SESSION_ID-unset}" "\${AILY_CLI_CALLER_AGENT_UID-unset}" "\${FEISHU_BRIDGE_ROLE-unset}" > "$ENV_OUT"
last=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2; else shift; fi
done
prompt=$(cat)
printf '{"type":"thread.started","thread_id":"%s"}\\n' "$EXPECTED_THREAD"
printf '{"type":"turn.started"}\\n'
printf '{"type":"turn.completed"}\\n'
printf '%s' "$prompt" > "$last"
`, { mode: 0o700 });
  const instruction = path.join(dir, "prompt.txt");
  const log = path.join(dir, "run.jsonl");
  const stderr = path.join(dir, "stderr.log");
  const last = path.join(dir, "last.txt");
  const exit = path.join(dir, "exit.json");
  const argsOut = path.join(dir, "args.txt");
  const envOut = path.join(dir, "env.txt");
  fs.writeFileSync(instruction, "精确投递");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "run-resume.mjs"),
    "--thread-id", THREAD_A, "--project", dir, "--instruction-file", instruction,
    "--log", log, "--stderr", stderr, "--last-message", last, "--exit-receipt", exit,
    "--codex-bin", fake,
  ], { encoding: "utf-8", env: {
    ...isolatedEnv(),
    EXPECTED_THREAD: THREAD_A,
    ARGS_OUT: argsOut,
    ENV_OUT: envOut,
    FEISHU_BRIDGE_ROLE: "codex-run",
    AILY_CLI_SESSION_ID: "must_be_removed",
    AILY_CLI_CALLER_AGENT_UID: "must_be_removed",
  } });
  assert.equal(r.status, 0, r.stderr);
  const args = fs.readFileSync(argsOut, "utf-8").trim().split("\n");
  assert.deepEqual(args.slice(0, 5), ["exec", "resume", "--skip-git-repo-check", "--json",
    "--output-last-message"]);
  assert.equal(args.includes(THREAD_A), true);
  assert.equal(args.at(-1), "-");
  assert.equal(fs.readFileSync(envOut, "utf-8"), "unset|unset|codex-run");
  assert.deepEqual(sanitizeCodexRunEnv({ KEEP: "yes", AILY_CLI_RUN_ID: "remove" }), { KEEP: "yes" });
  assert.equal(fs.readFileSync(last, "utf-8"), "精确投递");
  assert.equal(JSON.parse(fs.readFileSync(exit, "utf-8")).exit_code, 0);
  assert.equal(readCodexRunOutcome({ logPath: log, exitPath: exit, lastMessagePath: last,
    expectedThreadId: THREAD_A }).state, "completed");
});

test("Codex Stop hook：相同正文的两个 turn 各入队一次，同一 turn 重入不重复", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = false;
  writeRegistry([task], path.join(home, "registry.json"));
  const hook = path.join(ROOT, "scripts", "codex", "stop-hook.mjs");
  const run = (turn) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: THREAD_A, turn_id: turn, cwd: root, last_assistant_message: "一样" }),
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(run("turn-1").status, 0);
  assert.equal(run("turn-2").status, 0);
  assert.equal(run("turn-1").status, 0);
  assert.equal(listPending({ outboxDir: taskPaths(task, home).outbox }).length, 2);
});

test("Codex UserPromptSubmit 与 Stop 按 turn_id 配对本地输入，入站 runner 不缓存", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = false;
  writeRegistry([task], path.join(home, "registry.json"));
  const promptHook = path.join(ROOT, "scripts", "codex", "prompt-hook.mjs");
  const stopHook = path.join(ROOT, "scripts", "codex", "stop-hook.mjs");
  const env = { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home };

  const submitted = spawnSync(process.execPath, [promptHook], {
    input: JSON.stringify({
      session_id: THREAD_A, turn_id: "turn-paired", cwd: root, prompt: "请实现一轮一卡",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(readTurnInput({ dir: taskPaths(task, home).turnInputs, key: "turn-paired" }).text,
    "请实现一轮一卡");

  const stopped = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({
      session_id: THREAD_A, turn_id: "turn-paired", cwd: root, last_assistant_message: "已经完成",
    }),
    encoding: "utf-8",
    env,
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  const record = listPending({ outboxDir: taskPaths(task, home).outbox })[0];
  assert.equal(record.input_origin, "local");
  assert.equal(record.input_text, "请实现一轮一卡");
  assert.equal(record.text, "已经完成");
  assert.equal(readTurnInput({ dir: taskPaths(task, home).turnInputs, key: "turn-paired" }).reason,
    "not_found");

  const routed = spawnSync(process.execPath, [promptHook], {
    input: JSON.stringify({
      session_id: THREAD_A, turn_id: "turn-feishu", cwd: root, prompt: "来自飞书的指令",
    }),
    encoding: "utf-8",
    env: { ...env, FEISHU_BRIDGE_ROLE: "codex-run" },
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.equal(readTurnInput({ dir: taskPaths(task, home).turnInputs, key: "turn-feishu" }).reason,
    "not_found");
});

test("Codex Stop hook 自动发布本地回合，并保留旧的非 eligible 积压", () => {
  const { home, root, task } = autoPublishFixture();
  const outboxDir = taskPaths(task, home).outbox;
  appendEvent({ outboxDir, kind: "reply", text: "旧答复", eventKey: "legacy" });
  const hook = path.join(ROOT, "scripts", "codex", "stop-hook.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: THREAD_A, turn_id: "turn-auto", cwd: root, last_assistant_message: "新答复",
    }),
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已自动发布到绑定话题/u);
  assert.deepEqual(listPending({ outboxDir }).map((event) => event.text), ["旧答复"]);
});

test("Codex bind-preview 的传递依赖碰不到 outbound", () => {
  const preview = fs.readFileSync(path.join(ROOT, "scripts", "codex", "bind-preview.mjs"), "utf-8");
  const compose = fs.readFileSync(path.join(ROOT, "scripts", "codex", "bind-compose.mjs"), "utf-8");
  assert.equal(preview.includes("outbound.mjs"), false);
  assert.equal(compose.includes("outbound.mjs"), false);
});

test("关闭自动发布时 watcher 只把严格完成的最终答复兜底入队并放锁", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = false;
  writeRegistry([task], path.join(home, "registry.json"));
  const paths = taskPaths(task, home);
  fs.mkdirSync(paths.runs, { recursive: true });
  fs.mkdirSync(paths.claims, { recursive: true });
  fs.mkdirSync(paths.sessionLock, { recursive: true });
  const key = "a".repeat(64);
  fs.writeFileSync(path.join(paths.runs, key + ".jsonl"), [
    { type: "thread.started", thread_id: THREAD_A }, { type: "turn.started" }, { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(paths.runs, key + ".exit.json"), JSON.stringify({ exit_code: 0 }));
  fs.writeFileSync(path.join(paths.runs, key + ".last-message.txt"), "watcher final");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "watch-run.mjs"),
    "--claim-key", key, "--task-key", task.logical_task_key,
  ], { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(listPending({ outboxDir: paths.outbox }).length, 1);
  assert.equal(fs.existsSync(paths.sessionLock), false);
});

test("Codex watcher 严格完成后释放 Dialogue 活动回合", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Dialogue", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = false;
  writeRegistry([task], path.join(home, "registry.json"));
  setTaskInteractionMode({ threadId: THREAD_A, mode: "dialogue", home, now: 1_800_000_000_000 });
  const key = "d".repeat(64);
  reserveTaskDialogueTurn({
    threadId: THREAD_A, eventId: "om_dialogue_watch", runId: key,
    localTargetId: "local", originChannelGenerationId: task.channel_generation_id,
    runtimeTargetId: THREAD_A, home, now: 1_800_000_000_001,
  });
  const current = loadRegistry(path.join(home, "registry.json")).tasks[0];
  const paths = taskPaths(current, home);
  fs.mkdirSync(path.join(paths.claims, key + ".claim"), { recursive: true });
  fs.writeFileSync(path.join(paths.claims, key + ".claim", "claim.json"), JSON.stringify({
    claim_key: key, policy_id: "dialogue", origin_channel_generation_id: task.channel_generation_id,
  }));
  fs.mkdirSync(paths.runs, { recursive: true });
  fs.mkdirSync(paths.sessionLock, { recursive: true });
  fs.writeFileSync(path.join(paths.runs, key + ".jsonl"), [
    { type: "thread.started", thread_id: THREAD_A }, { type: "turn.started" }, { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(paths.runs, key + ".exit.json"), JSON.stringify({ exit_code: 0 }));
  fs.writeFileSync(path.join(paths.runs, key + ".last-message.txt"), "dialogue final");
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "watch-run.mjs"),
    "--claim-key", key, "--task-key", task.logical_task_key,
  ], { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(run.status, 0, run.stderr);
  const after = loadRegistry(path.join(home, "registry.json")).tasks[0];
  assert.equal(interactionPolicyForTask(after).state.dialogue.active_turn, null);
  assert.equal(interactionPolicyForTask(after).state.dialogue.last_turn.status, "completed");
});

test("watcher 抑制递归产生的错误答复，只保留风险回执", () => {
  const home = temp();
  const root = path.join(home, "workspace");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = false;
  writeRegistry([task], path.join(home, "registry.json"));
  const paths = taskPaths(task, home);
  fs.mkdirSync(paths.runs, { recursive: true });
  fs.mkdirSync(paths.claims, { recursive: true });
  fs.mkdirSync(paths.sessionLock, { recursive: true });
  const key = "c".repeat(64);
  const eventKey = "codex:" + THREAD_A + ":claim:" + key + ":reply";
  appendEvent({ outboxDir: paths.outbox, kind: "reply", text: "EPERM stack", eventKey });
  fs.writeFileSync(path.join(paths.runs, key + ".jsonl"), [
    { type: "thread.started", thread_id: THREAD_A },
    { type: "turn.started" },
    { type: "item.completed", item: {
      type: "command_execution", command: "node /bridge/scripts/codex/inbound.mjs", status: "failed",
    } },
    { type: "turn.completed" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(paths.runs, key + ".exit.json"),
    JSON.stringify({ status: "exited", exit_code: 0 }));
  fs.writeFileSync(path.join(paths.runs, key + ".last-message.txt"), "EPERM stack");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "watch-run.mjs"),
    "--claim-key", key, "--task-key", task.logical_task_key,
  ], { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(r.status, 1, r.stderr);
  const pending = listPending({ outboxDir: paths.outbox });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "risk");
  assert.match(pending[0].text, /bridge_recursion/u);
  assert.equal(pending[0].text.includes("EPERM stack"), false);
});

test("watcher 对启动前 Git 预检失败给出真实且脱敏的风险回执", () => {
  const home = temp();
  const root = path.join(home, "workspace");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = false;
  writeRegistry([task], path.join(home, "registry.json"));
  const paths = taskPaths(task, home);
  fs.mkdirSync(paths.runs, { recursive: true });
  fs.mkdirSync(paths.claims, { recursive: true });
  fs.mkdirSync(paths.sessionLock, { recursive: true });
  const key = "b".repeat(64);
  fs.writeFileSync(path.join(paths.runs, key + ".jsonl"), "");
  fs.writeFileSync(path.join(paths.runs, key + ".exit.json"),
    JSON.stringify({ status: "failed", exit_code: 1 }));
  fs.writeFileSync(path.join(paths.runs, key + ".stderr.log"),
    "Not inside a trusted directory and --skip-git-repo-check was not specified. secret-token\n");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "watch-run.mjs"),
    "--claim-key", key, "--task-key", task.logical_task_key,
  ], { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(r.status, 1, r.stderr);
  const pending = listPending({ outboxDir: paths.outbox });
  assert.equal(pending.length, 1);
  assert.match(pending[0].text, /runner_preflight_failed：工作目录未通过 Codex Git 仓库检查/u);
  assert.equal(pending[0].text.includes("secret-token"), false);
  assert.equal(fs.existsSync(paths.sessionLock), false);
});

test("安装器默认 dry-run，不创建 hooks 或状态", () => {
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "install.mjs")], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.equal(fs.existsSync(path.join(codexHome, "hooks.json")), false);
  assert.equal(fs.existsSync(home), false);
});

test("安装器在隔离 HOME 只追加 hooks、渲染技能路径且保留已有 hook", () => {
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const old = { hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-orca", timeout: 1 }] }] } };
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify(old));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const legacyTask = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  legacyTask.auto_publish_on_completion = false;
  writeRegistry([legacyTask], path.join(home, "registry.json"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf-8"));
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, "existing-orca");
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  const skill = fs.readFileSync(path.join(codexHome, "skills", "m5codex-inbound-router", "SKILL.md"), "utf-8");
  assert.equal(skill.includes("{{BRIDGE_ROOT}}"), false);
  assert.equal(skill.includes("{{CODEX_BRIDGE_HOME_SHELL}}"), false);
  // **技能里不许再出现开发克隆路径。**上一版这里断言的正好相反（includes(ROOT)）——
  // 那是在把"技能指向安装者的工作目录"钉成契约。现在钉的是 runtime/current。
  assert.equal(skill.includes(ROOT), false,
    "技能里不许嵌开发克隆路径 —— 那个目录一 checkout，线上行为就变了");
  assert.ok(skill.includes(path.join(codexHome, "feishu-bridge", "runtime", "current")),
    "技能必须指向 runtime/current：" + skill.slice(0, 200));
  assert.equal(skill.includes("FEISHU_CODEX_BRIDGE_HOME='" + home + "'"), true);
  assert.equal(skill.includes("待绑定话题或已绑定话题"), true);
  const controlSkill = fs.readFileSync(path.join(codexHome, "skills", "codex-longtask-feishu", "SKILL.md"), "utf-8");
  assert.equal(controlSkill.includes("AILY_CLI_*"), true);
  assert.equal(controlSkill.includes("m5codex-inbound-router"), true);
  assert.equal(controlSkill.includes("$feishu-unbind"), true);
  for (const name of ["feishu-bind", "feishu-unbind", "feishu-status", "feishu-rotate", "feishu-mode"]) {
    const commandSkill = fs.readFileSync(path.join(codexHome, "skills", name, "SKILL.md"), "utf-8");
    assert.equal(commandSkill.includes("name: " + name), true);
    if (name === "feishu-bind") {
      assert.equal(commandSkill.includes("不先运行只读预览，也不再次要求用户"), true);
    }
  }
  assert.equal(fs.existsSync(path.join(home, "registry.json")), true);
  assert.equal(fs.statSync(path.join(home, "receipts")).isDirectory(), true);
  // **安装不再改订阅策略。**这条原来断言的正是"安装会把 task 的
  // auto_publish_on_completion 改成 true" —— 那是装基础设施顺手改掉每条绑定的发布行为，
  // 不预览、不留痕、不可选。现在它必须保持原样，迁移走显式的 migrate-auto-publish.mjs。
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].auto_publish_on_completion,
    false, "安装不得改动既有 task 的发布策略");
});

test("入站前置回执目录不可写时只返回脱敏错误，不泄露 Node 堆栈", () => {
  const dir = temp();
  const blockedHome = path.join(dir, "not-a-directory");
  fs.writeFileSync(blockedHome, "blocked");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "inbound.mjs")], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: blockedHome },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /系统错误/u);
  assert.equal(/node:fs|EPERM|EISDIR|\n\s+at /u.test(r.stdout + r.stderr), false);
});

test("自动发布登记迁移幂等，暂停 task 也保留恢复后的发布合同", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const active = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  const paused = makeTaskEntry({ root, threadId: THREAD_B, name: "B", rootMessageId: "om_b", token: "b" });
  active.auto_publish_on_completion = false;
  paused.auto_publish_on_completion = false;
  paused.status = "paused";
  writeRegistry([active, paused], path.join(home, "registry.json"));
  // 默认只预览：报得出待迁移数，但不写。
  const preview = enableAutoPublishForAllTasks({ home });
  assert.equal(preview.changed, 2);
  assert.equal(preview.applied, false, "不带 apply 不得落盘");
  assert.equal(preview.migration, "auto_publish_on_completion_v1", "迁移要有版本身份");
  assert.equal(enableAutoPublishForAllTasks({ home }).changed, 2,
    "预览不改变状态，所以再预览一次数字不变");

  assert.equal(enableAutoPublishForAllTasks({ home, apply: true }).changed, 2);
  assert.equal(enableAutoPublishForAllTasks({ home, apply: true }).changed, 0);
  assert.deepEqual(loadRegistry(path.join(home, "registry.json")).tasks.map((task) => task.auto_publish_on_completion),
    [true, true]);
});

test("迁移只改目标字段：停用项、怪路径记录、未知顶层字段都不能被顺手删掉", () => {
  const home = temp();
  const file = path.join(home, "registry.json");
  // 刻意绕过 writeRegistry 直接造文档：这些正是 loadRegistry 会滤掉、
  // writeRegistry 会丢掉的东西，用视图读写就会静默删数据。
  fs.writeFileSync(file, JSON.stringify({
    schema_version: "1.0", runtime: "codex", custom_marker: "KEEP_ME",
    tasks: [
      { logical_task_key: "a", root: "/tmp/a" },
      { logical_task_key: "b", root: "/tmp/b", enabled: false },
      { logical_task_key: "c", root: "relative/bad" },
    ],
  }));
  assert.equal(enableAutoPublishForAllTasks({ home, apply: true }).changed, 3);

  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(raw.tasks.map((t) => t.logical_task_key), ["a", "b", "c"], "一条都不能少");
  assert.equal(raw.custom_marker, "KEEP_ME", "不认识的顶层字段要原样留着");
  assert.equal(raw.tasks[1].enabled, false, "停用状态不能被抹掉");
  assert.equal(raw.tasks.every((t) => t.id === undefined), true, "迁移不得顺手补写 id");
  assert.equal(raw.tasks.every((t) => t.auto_publish_on_completion === true), true);
});

test("迁移遇到解释不了的登记结构要 fail-closed，不许过滤后整表写回", () => {
  for (const [shape, reason] of [
    [{ tasks: "not-an-array" }, "registry_shape_unexpected"],
    [{ tasks: [null] }, "registry_entry_unreadable"],
    [{ tasks: [["a"]] }, "registry_entry_unreadable"],
  ]) {
    const home = temp();
    const file = path.join(home, "registry.json");
    const before = JSON.stringify({ schema_version: "1.0", ...shape });
    fs.writeFileSync(file, before);
    const r = enableAutoPublishForAllTasks({ home, apply: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(fs.readFileSync(file, "utf-8"), before, "拒绝时一个字节都不该动");
  }
});

test("迁移留持久回执：零变更也留，且回执与实际计数自洽", () => {
  const home = temp();
  const file = path.join(home, "registry.json");
  fs.writeFileSync(file, JSON.stringify({ schema_version: "1.0", runtime: "codex", tasks: [
    { logical_task_key: "a", root: "/tmp/a" },
    { logical_task_key: "b", root: "/tmp/b", auto_publish_on_completion: true },
  ] }));
  assert.equal(readMigrationReceipt(home), null, "没跑过就没有回执");

  const first = enableAutoPublishForAllTasks({ home, apply: true });
  const r1 = readMigrationReceipt(home);
  assert.equal(first.receipt, true);
  assert.equal(r1.changed, first.changed, "回执得跟这次真改了多少条对得上");
  assert.equal(r1.tasks, first.tasks);
  assert.equal(r1.changed, 1);
  assert.equal(typeof r1.applied_at, "string");

  // 零变更也要留痕，否则「跑过但本来就没东西可改」和「从没跑过」分不开。
  const second = enableAutoPublishForAllTasks({ home, apply: true });
  assert.equal(second.changed, 0);
  assert.equal(readMigrationReceipt(home).changed, 0);
});

test("apply 路径必须取锁后再读，待迁移为 0 也不许绕过锁", () => {
  const home = temp();
  fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({
    schema_version: "1.0", runtime: "codex",
    tasks: [{ logical_task_key: "a", root: "/tmp/a", auto_publish_on_completion: true }],
  }));
  const lockDir = path.join(home, "registry.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  // 必须是**有效**的持有者，否则会被当成陈旧锁正当接管。
  fs.writeFileSync(path.join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  const r = enableAutoPublishForAllTasks({ home, apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "registry_busy", "旧实现在取锁前就返回了 applied:true");
  assert.equal(readMigrationReceipt(home), null, "没跑成就不该留回执");

  // 预览不写盘，所以不需要锁。
  assert.equal(enableAutoPublishForAllTasks({ home, apply: false }).ok, true);
});

test("迁移账本坏了就停手：不写登记表，也不覆盖账本", () => {
  // 账本是数组：JSON 上合法，但 all[id] = … 之后 stringify 会把它丢掉 ——
  // 于是"写成功了"却读不回来。必须在动登记表之前就挡住。
  for (const [ledger, reason] of [
    ["[]", "migrations_shape_unexpected"],
    ["null", "migrations_shape_unexpected"],
    ["{ 坏掉的 json", "migrations_unreadable"],
  ]) {
    const home = temp();
    const file = path.join(home, "registry.json");
    const before = JSON.stringify({ schema_version: "1.0", runtime: "codex",
      tasks: [{ logical_task_key: "a", root: "/tmp/a" }] });
    fs.writeFileSync(file, before);
    fs.writeFileSync(path.join(home, "migrations.json"), ledger);

    const r = enableAutoPublishForAllTasks({ home, apply: true });
    assert.equal(r.ok, false, "账本不可用时不该报成功：" + ledger);
    assert.equal(r.reason, reason);
    assert.equal(fs.readFileSync(file, "utf-8"), before, "登记表一个字节都不该动");
    assert.equal(fs.readFileSync(path.join(home, "migrations.json"), "utf-8"), ledger,
      "坏账本不是重建它的理由");
  }
});

test("迁移回执不覆盖别的迁移，且写完要读回来核验", () => {
  const home = temp();
  fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({
    schema_version: "1.0", runtime: "codex",
    tasks: [{ logical_task_key: "a", root: "/tmp/a" }],
  }));
  const other = { applied_at: "2020-01-01T00:00:00.000Z", tasks: 9, changed: 9 };
  fs.writeFileSync(path.join(home, "migrations.json"),
    JSON.stringify({ some_other_migration_v3: other }));

  const r = enableAutoPublishForAllTasks({ home, apply: true });
  assert.equal(r.receipt, true);
  const all = JSON.parse(fs.readFileSync(path.join(home, "migrations.json"), "utf-8"));
  assert.deepEqual(all.some_other_migration_v3, other, "别人的回执不能被顺手抹掉");
  assert.equal(all.auto_publish_on_completion_v1.changed, 1);
  // 读回来核验：写入不报错 ≠ 内容落对了。
  assert.deepEqual(readMigrationReceipt(home), all.auto_publish_on_completion_v1);
});

test("预览要把账本损坏和没有回执报成两种状态", () => {
  const home = temp();
  fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({
    schema_version: "1.0", runtime: "codex", tasks: [],
  }));
  // 没有账本：确实是"没有回执"。
  const none = enableAutoPublishForAllTasks({ home });
  assert.equal(none.receipt, null);
  assert.equal(none.receiptProblem, null);

  // 账本坏了：不能跟上面长得一样，否则预览的审计语义是假的。
  fs.writeFileSync(path.join(home, "migrations.json"), "[]");
  const broken = enableAutoPublishForAllTasks({ home });
  assert.equal(broken.ok, true, "预览本身仍可用");
  assert.equal(broken.receipt, null);
  assert.equal(broken.receiptProblem, "migrations_shape_unexpected");
  // 而 --apply 在同样的账本下必须拒绝。
  assert.equal(enableAutoPublishForAllTasks({ home, apply: true }).ok, false);
});

test("登记表不可读时，安装器要在 dry-run 退出之前就说出来", () => {
  const dir = temp();
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "registry.json"), "{ 坏掉的 json");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "install.mjs")], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), CODEX_HOME: path.join(dir, "codex-home"), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const beforeExit = r.stdout.slice(0, r.stdout.indexOf("[dry-run]"));
  // 静默省略会让"没有待迁移项"和"根本没读到"在预览里长得一模一样。
  assert.match(beforeExit, /待迁移状态不可读/u);
  // 但读不出状态不是替人改订阅的理由 —— dry-run 仍然什么都没写。
  assert.equal(fs.readFileSync(path.join(home, "registry.json"), "utf-8"), "{ 坏掉的 json");
});

test("安装器预览的待迁移数必须等于实际会改的数", () => {
  const dir = temp();
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(home, { recursive: true });
  // 一个暂停、一个 root 形状异常 —— 两者都会被 loadRegistry 的过滤视图漏掉。
  fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({
    schema_version: "1.0", runtime: "codex",
    tasks: [
      { logical_task_key: "a", root: "/tmp/a" },
      { logical_task_key: "b", root: "/tmp/b", enabled: false },
      { logical_task_key: "c", root: "relative/bad" },
    ],
  }));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "install.mjs")], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), CODEX_HOME: path.join(dir, "codex-home"), FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /待迁移 3 个 task/u, "预览报的数是过滤视图的话这里会是 1");
  assert.equal(enableAutoPublishForAllTasks({ home }).changed, 3);
});

test("绑定预览为同一 thread 生成稳定逻辑键与平台幂等键", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n\n一个演示项目。\n");
  const a = composeCodexBinding({ root: dir, threadId: THREAD_A });
  const b = composeCodexBinding({ root: dir, threadId: THREAD_A });
  assert.equal(a.logicalTaskKey, b.logicalTaskKey);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.equal(a.rootText.includes(THREAD_A), false, "根消息不暴露 Codex locator");
  assert.equal(a.statusText.includes("真实 @M5Codex"), true);
  assert.equal(a.statusText.includes("不需要额外关键字"), true);
  assert.equal(a.statusText.includes("运输 agent"), false);
});

test("绑定目标默认沿用机器群，显式跨群时要求 chat-id 并隔离平台幂等域", () => {
  const defaultTarget = resolveBindingTarget({ template: TEMPLATE });
  const override = resolveBindingTarget({
    template: TEMPLATE, chatId: "oc_lab", chatName: "智能体进化",
  });
  assert.deepEqual(defaultTarget, {
    ok: true, chatId: TEMPLATE.chat_id, chatName: TEMPLATE.chat_name, overridden: false,
  });
  assert.deepEqual(override, {
    ok: true, chatId: "oc_lab", chatName: "智能体进化", overridden: true,
  });
  assert.equal(resolveBindingTarget({ template: TEMPLATE, chatName: "智能体进化" }).reason,
    "chat_name_without_chat_id");
  assert.equal(resolveBindingTarget({ template: TEMPLATE, chatId: "wrong" }).reason, "invalid_chat_id");

  const dir = temp();
  const legacy = composeCodexBinding({ root: dir, threadId: THREAD_A });
  const lab = composeCodexBinding({ root: dir, threadId: THREAD_A, idempotencyScope: "oc_lab" });
  const another = composeCodexBinding({ root: dir, threadId: THREAD_A, idempotencyScope: "oc_other" });
  assert.equal(legacy.token, lab.token);
  assert.notEqual(legacy.idempotencyKey, lab.idempotencyKey);
  assert.notEqual(lab.idempotencyKey, another.idempotencyKey);
});

test("task 级目标群覆盖只进入 Git 外运行映射，不改变机器模板", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "实验主管", rootMessageId: "om_lab", token: "lab",
    chatId: "oc_lab", chatName: "智能体进化",
  });
  writeRegistry([task], path.join(home, "registry.json"));
  const resolved = findTaskForCodexThread({ threadId: THREAD_A, home });
  assert.equal(resolved.ok, true);
  const mapped = mappingForTask(task, { home });
  assert.equal(mapped.codex_thread_id, THREAD_A);
  const registered = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home });
  assert.equal(registered.task.chat_id, "oc_lab");
  assert.equal(registered.task.chat_name, "智能体进化");
  const runtime = resolveTask(task, { home });
  assert.equal(runtime.config.chat_id, "oc_lab");
  assert.equal(runtime.config.chat_name, "智能体进化");
  assert.equal(loadCodexTemplate(path.join(home, "chain-config.json")).template.chat_id, TEMPLATE.chat_id);
});

test("bind-task 显式跨群 apply 把根消息发到目标群并登记该 task 的群", () => {
  const home = temp();
  const root = path.join(home, "project");
  const bin = path.join(home, "fake-lark.sh");
  const calls = path.join(home, "calls.txt");
  const configBase = path.join(home, "agents");
  const credentialDir = path.join(configBase, TEMPLATE.agent_uid);
  fs.mkdirSync(root);
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Lab\n");
  fs.writeFileSync(path.join(credentialDir, "config.json"), JSON.stringify({
    apps: [{ name: TEMPLATE.lark_cli_profile, appId: TEMPLATE.transport_app_id }],
  }));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify({
    ...TEMPLATE, lark_cli_bin: bin, lark_cli_config_base: configBase,
  }));
  fs.writeFileSync(bin, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$FAKE_CALLS_FILE\"",
    "case \"$*\" in",
    "  *+messages-send*) printf '%s' '{\"ok\":true,\"data\":{\"message_id\":\"om_lab_root\"}}' ;;",
    "  *) printf '%s' '{\"ok\":true,\"data\":{\"message_id\":\"om_lab_reply\"}}' ;;",
    "esac",
  ].join("\n") + "\n", { mode: 0o700 });

  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
    "--project", root,
    "--thread-id", THREAD_A,
    "--name", "智能体进化｜Aily主动求助验收",
    "--chat-id", "oc_lab",
    "--chat-name", "智能体进化",
    "--apply", ...withIntent("bind", THREAD_A, home, {
        project: root, chat: "oc_lab", name: "智能体进化｜Aily主动求助验收" })], {
    encoding: "utf-8",
    env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home, FAKE_CALLS_FILE: calls },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /群\s+智能体进化/u);
  assert.equal(run.stdout.includes("oc_lab"), false, "stdout 不暴露群 locator");
  const sent = fs.readFileSync(calls, "utf-8");
  assert.match(sent, /\+messages-send --chat-id oc_lab/u);
  const task = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  assert.equal(task.root_message_id, "om_lab_root");
  assert.equal(task.chat_id, "oc_lab");
  assert.equal(task.chat_name, "智能体进化");
});

test("同一项目的两个 Codex task 用 Desktop 标题和短码形成不同的可见话题名", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "README.md"), "# hv-meeting\n\n会议项目。\n");
  const descriptions = {
    [THREAD_A]: "运行实例接管检查：shadow / charter_pending",
    [THREAD_B]: "高价值会议｜产品与架构：P1/P2/P3 原子需求",
  };
  const a = composeCodexBinding({ root: dir, threadId: THREAD_A, threadDescriptions: descriptions });
  const b = composeCodexBinding({ root: dir, threadId: THREAD_B, threadDescriptions: descriptions });

  assert.equal(a.name, "hv-meeting｜运行实例接管检查：shadow / charter_pending");
  assert.equal(b.name, "hv-meeting｜高价值会议｜产品与架构：P1/P2/P3 原子需求");
  assert.notEqual(a.rootText.split("\n")[0], b.rootText.split("\n")[0]);
  assert.match(a.rootText.split("\n")[0], new RegExp(a.token + "$"));
  assert.match(b.rootText.split("\n")[0], new RegExp(b.token + "$"));
  assert.equal(a.rootText.includes(THREAD_A), false);
  assert.equal(b.rootText.includes(THREAD_B), false);
});

test("Codex task 标题不可用时仍用稳定短码区分同项目话题", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "README.md"), "# hv-meeting\n\n会议项目。\n");
  const a = composeCodexBinding({ root: dir, threadId: THREAD_A, threadDescriptions: {} });
  const b = composeCodexBinding({ root: dir, threadId: THREAD_B, threadDescriptions: {} });

  assert.equal(a.name, "hv-meeting｜任务 " + a.token);
  assert.equal(b.name, "hv-meeting｜任务 " + b.token);
  assert.notEqual(a.name, b.name);
  assert.equal(a.rootText.split("\n")[0], "🌉 " + a.name);
});

test("Codex task 标题读取只做精确匹配，并清理换行、locator 与超长文本", () => {
  const descriptions = {
    [THREAD_A]: "  **标题一**\n" + THREAD_A + "  " + "很长".repeat(40),
    other: "不该命中",
  };
  const exact = readCodexThreadTitle({ threadId: THREAD_A, descriptions });
  const missing = readCodexThreadTitle({ threadId: THREAD_B, descriptions });
  assert.equal(exact.source, "codex-desktop-title");
  assert.equal(exact.title.includes("\n"), false);
  assert.equal(exact.title.includes(THREAD_A), false);
  assert.equal(Array.from(exact.title).length <= 48, true);
  assert.deepEqual(missing, { title: null, source: "missing" });
  assert.equal(sanitizeThreadTitle(" \n\t "), null);
});

test("旧 Codex 绑定可原地更新显示名，不改变根消息与 thread locator", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({
    root, threadId: THREAD_A, name: "hv-meeting", rootMessageId: "om_existing", token: "abc123",
  });
  writeRegistry([task], path.join(home, "registry.json"));
  const renamed = setTaskDisplayName({ threadId: THREAD_A, name: "hv-meeting｜任务一", home });
  assert.equal(renamed.ok, true);
  const after = loadRegistry(path.join(home, "registry.json")).tasks[0];
  assert.equal(after.task_display_name, "hv-meeting｜任务一");
  assert.equal(after.root_message_id, "om_existing");
  assert.equal(after.codex_thread_id, THREAD_A);
});

test("编辑旧根消息使用官方 PUT API、bot 身份和 JSON 信封合同", () => {
  const dir = temp();
  const bin = path.join(dir, "fake-lark.sh");
  const argsFile = path.join(dir, "args.json");
  const bodyFile = path.join(dir, "body.json");
  fs.writeFileSync(bin, [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" > \"$FAKE_ARGS_FILE\"",
    "cat > \"$FAKE_BODY_FILE\"",
    "printf '%s' '{\"ok\":true,\"identity\":\"bot\",\"data\":{\"message_id\":\"om_existing\"}}'",
  ].join("\n") + "\n", { mode: 0o700 });
  const oldArgs = process.env.FAKE_ARGS_FILE;
  const oldBody = process.env.FAKE_BODY_FILE;
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_BODY_FILE = bodyFile;
  try {
    assert.equal(updateTextMessage({
      profile: "bot-profile", messageId: "om_existing", text: "新标题", larkBin: bin,
    }), "om_existing");
  } finally {
    if (oldArgs === undefined) delete process.env.FAKE_ARGS_FILE; else process.env.FAKE_ARGS_FILE = oldArgs;
    if (oldBody === undefined) delete process.env.FAKE_BODY_FILE; else process.env.FAKE_BODY_FILE = oldBody;
  }
  const args = fs.readFileSync(argsFile, "utf-8").trim().split("\n");
  assert.deepEqual(args, [
    "api", "PUT", "/open-apis/im/v1/messages/om_existing", "--as", "bot", "--data", "-", "--json",
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(bodyFile, "utf-8")), {
    msg_type: "text", content: JSON.stringify({ text: "新标题" }),
  });
});

test("Codex doctor 只读汇总依赖、安装和登记状态", () => {
  const dir = temp();
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "bridge-home");
  const codexHome = path.join(dir, "codex-home");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
  for (const name of ["codex", "aily-cli", "lark-cli"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify({
    ...TEMPLATE,
    lark_cli_bin: path.join(bin, "lark-cli"),
  }));
  writeRegistry([], path.join(home, "registry.json"));
  // **"健康"就是安装器装出来的样子 —— 由安装器自己构造，不手写。**
  //
  // 上一版这里手写 hooks 指向 ROOT（开发克隆）、手写空壳技能。那份夹具描述的是
  // 一个 doctor 认得、但安装器从来不会产出的状态；判据一改它就得跟着改，
  // 而"跟着改"的时候很容易把 doctor 改松了去迁就夹具。
  // 现在两者绑在一起：安装器和 doctor 谁跑偏，这条都会红。
  const installed = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"], {
      encoding: "utf-8",
      env: { ...isolatedEnv(), CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
    });
  assert.equal(installed.status, 0, "夹具依赖安装器成功：" + installed.stderr);

  const run = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "doctor.mjs"), "--json"], {
    encoding: "utf-8",
    env: {
      ...isolatedEnv(),
      PATH: bin + path.delimiter + (process.env.PATH ?? ""),
      CODEX_HOME: codexHome,
      FEISHU_CODEX_BRIDGE_HOME: home,
    },
  });
  // **装好之后不是 ready，是 incomplete。**hook 信任本地查不到，
  // 调度器默认没启用 —— 两件都不是故障，但也都不是"可以不管了"。
  // 上一版这里断言 ready:true，等于把"查不清"钉成了"通过"。
  const healthy = JSON.parse(run().stdout);
  assert.equal(healthy.overall, "incomplete",
    "全新装好 = 没有故障、但还差人确认：" + JSON.stringify(healthy.checks));
  assert.equal(healthy.ready, false, "ready 只能在全 true 时成立");
  assert.equal(healthy.checks.some((c) => c.ok === false), false,
    "**一条真故障都不该有** —— incomplete 是因为有 null，不是因为有 false");
  assert.ok(healthy.checks.some((c) => c.ok === null), "确实存在查不清的项");
  // 查不清的那几项要出现在待办里，不能被藏起来。
  assert.ok(healthy.next.some((n) => /hooks/u.test(n)),
    "hook 信任那条必须出现在下一步里：" + JSON.stringify(healthy.next));
  assert.equal(run().status, 1, "incomplete 也非零退出 —— 当成功就没人去做那一步");

  fs.rmSync(path.join(codexHome, "skills", "feishu-status"), { recursive: true });
  const broken = run();
  assert.equal(broken.status, 1);
  const brokenJson = JSON.parse(broken.stdout);
  assert.equal(brokenJson.ready, false);
  assert.equal(brokenJson.overall, "blocked", "**真故障要和「查不清」分得开**");
});

test("Codex 测试文件里没有写在汇总之后的 test()", () => {
  // 运行期封条只在那条 test() 真的被执行时触发；藏在走不到的分支里就抓不到。
  // 这条从结构上兜住，两层各覆盖一种情形。
  const src = fs.readFileSync(path.resolve(ROOT, "scripts", "codex", "test.mjs"), "utf-8")
    .split("\n");
  const sealAt = src.findIndex((line) => line.startsWith("summarySealed = true;"));
  assert.ok(sealAt > 0, "找不到封条那一行 —— 它被改名或删掉了，本检查会失效");
  const late = [];
  for (let i = sealAt + 1; i < src.length; i += 1) {
    if (/^\s*test\(/u.test(src[i])) late.push(i + 1);
  }
  assert.deepEqual(late, [],
    "第 " + late.join("、") + " 行的 test() 写在汇总之后，结果不会计入统计");
});

test("Codex 抑制：共用核心的判据在这一侧也真的生效", () => {
  // **不只是"命令存在"。**判据抽成了共用核心，但共用只有在两边都真的接上时才成立 ——
  // Claude 侧那批回归证明不了 Codex 这一侧接对了。所以这里直接驱动核心，
  // 用 Codex 的路径布局，把每条判据各验一遍。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-suppress-"));
  const outbox = path.join(dir, "outbox");
  const publishLock = path.join(dir, "publish.lock");
  const genLock = path.join(dir, "registry.lock");
  fs.mkdirSync(outbox, { recursive: true });
  const write = (name, extra = {}) => {
    fs.writeFileSync(path.join(outbox, name),
      JSON.stringify({ kind: "progress", text: name, published_at: null, ...extra }));
  };
  const readRec = (name) => JSON.parse(fs.readFileSync(path.join(outbox, name), "utf-8"));
  const state = (gen) => ({ activeGeneration: gen, select: (r) => r });
  const call = (over) => applySuppressionCore({
    outboxDir: outbox, publishLockDir: publishLock, generationLockDir: genLock,
    previewGenerationId: "gen-1", readState: () => state("gen-1"), reason: "t", ...over });

  // ① 正常：全停下来。
  write("0001.json", { target_channel_generation_id: "gen-1" });
  let pending = listPending({ outboxDir: outbox });
  let got = call({ pending, reason: "历史内容" });
  assert.equal(got.ok, true, got.reason ?? "");
  assert.equal(got.done.changed, 1);
  assert.equal(readRec("0001.json").publish_suppressed_reason, "历史内容");
  assert.equal(fs.existsSync(publishLock), false, "跑完要把发布锁还回去");

  // ② 等量替换：条数没变、内容换了 → 必须中止。
  write("0002.json", { target_channel_generation_id: "gen-1" });
  pending = listPending({ outboxDir: outbox });
  fs.rmSync(path.join(outbox, "0002.json"));
  write("0003.json", { target_channel_generation_id: "gen-1" });
  got = call({ pending });
  assert.equal(got.reason, "drift", "只比条数的话这里会放行");
  assert.equal(readRec("0003.json").publish_suppressed_at, undefined, "中止就一条不许动");

  // ③ 旧格式记录 + 预览后轮转 → 必须中止，**即使文件一个没变**。
  fs.rmSync(path.join(outbox, "0003.json"));
  write("0004.json");                       // 没有 target_channel_generation_id
  pending = listPending({ outboxDir: outbox });
  got = call({ pending, readState: () => state("gen-2") });
  assert.equal(got.reason, "rotated");
  assert.deepEqual([got.from, got.to], ["gen-1", "gen-2"]);
  assert.equal(readRec("0004.json").publish_suppressed_at, undefined);

  // ④ 有旧格式记录、却给不出代际锁 → 明确拒绝，不许拿一把猜出来的锁碰运气。
  assert.equal(call({ pending, generationLockDir: null }).reason, "binding_unresolved");

  // ⑤ 代际锁被占（轮转进行中）→ 不动手，也不许去碰发布锁。
  fs.mkdirSync(genLock, { recursive: true });
  fs.writeFileSync(path.join(genLock, "owner.json"),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  got = call({ pending });
  assert.equal(got.reason, "rotation_busy");
  assert.equal(fs.existsSync(publishLock), false, "第一把锁没拿到就不许留下第二把");
  fs.rmSync(genLock, { recursive: true, force: true });

  // ⑥ 每条都自带代际时，轮转不该拦 —— 那时中止是在拒绝一件本来安全的事。
  fs.rmSync(path.join(outbox, "0004.json"));
  write("0005.json", { target_channel_generation_id: "gen-9" });
  pending = listPending({ outboxDir: outbox });
  got = call({ pending, readState: () => state("gen-2") });
  assert.equal(got.ok, true, "没有旧格式记录时轮转不该拦：" + (got.reason ?? ""));
  assert.equal(fs.existsSync(genLock), false, "这种情况下压根不该去取代际锁");
});

test("Codex 抑制命令：默认只预览，参数拼错不许被当成别的操作", () => {
  // 有损且不可逆，所以默认预览、白名单严格。
  const ok = parseCodexSuppressArgs(["--thread-id", "t1", "--apply", "--reason", "x"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.seen.get("apply"), true);
  for (const [what, argv] of [
    ["拼错 apply", ["--aply"]],
    ["未知参数", ["--force"]],
    ["重复参数", ["--thread-id", "a", "--thread-id", "b"]],
    ["缺值", ["--thread-id", "--apply"]],
    ["裸参数", ["thread-id"]],
  ]) {
    assert.equal(parseCodexSuppressArgs(argv).ok, false, what + " 竟然被接受了");
  }
});

test("Codex 真实 CLI：缺 expectation / 纯空白 / 代际不可读，都不许说成取锁失败或轮转", () => {
  // 跟 Claude 侧同一条要求：核心分清的三类原因，到界面上不许又混成一句
  // "取锁失败"。上一版 Codex 侧还多一个毛病 —— 包装层只拦 null，
  // 空串和纯空白穿到核心，界面就只剩兜底那句。
  const mk = (withState) => {
    const home = temp();
    const root = path.join(home, "project");
    fs.mkdirSync(root, { recursive: true });
    const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Sup",
      rootMessageId: "om_root", token: "abc123" });
    // **删掉状态是造不出「读不出代际」的** —— 它会从 task 现合成一份。
    // 要让 topicStateForTask 真的失败，得给一份结构上就不合法的状态。
    if (!withState) task.topic_generation_state = { generations: "not-an-array" };
    fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
    writeRegistry([task], path.join(home, "registry.json"));
    const paths = taskPaths(task, home);
    fs.mkdirSync(paths.outbox, { recursive: true });
    const rec = path.join(paths.outbox, "0001.json");
    // 旧格式：没有 target_channel_generation_id。
    fs.writeFileSync(rec, JSON.stringify({ kind: "progress", text: "旧格式", published_at: null }));
    return { home, rec };
  };
  const cliPath = path.join(ROOT, "scripts", "codex", "suppress-outbox.mjs");
  const run = (home, ...args) => spawnSync(process.execPath,
    [cliPath, "--thread-id", THREAD_A, ...args],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  const untouched = (rec) =>
    JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at;

  // ① 完全不给
  {
    const { home, rec } = mk(true);
    const r = run(home, "--all-generations", "--apply", "--reason", "t");
    assert.notEqual(r.status, 0, "缺 expectation 必须非零退出");
    assert.match(r.stderr, /--expect-generation/u, "要说清缺的是什么、怎么补");
    assert.doesNotMatch(r.stderr, /取锁失败/u, "**这不是取锁失败**");
    assert.doesNotMatch(r.stderr, /轮转/u, "也没有发生轮转");
    assert.equal(untouched(rec), undefined, "零抑制");
    assert.equal(fs.existsSync(path.join(home, "registry.lock")), false,
      "拒绝发生在拿锁之前 —— 代际锁没拿");
  }

  // ② 纯空白
  {
    const { home, rec } = mk(true);
    const r = run(home, "--all-generations", "--apply", "--reason", "t",
      "--expect-generation", "   ");
    assert.notEqual(r.status, 0, "纯空白必须非零退出");
    assert.match(r.stderr, /--expect-generation/u);
    assert.doesNotMatch(r.stderr, /取锁失败/u, "**这不是取锁失败**");
    assert.doesNotMatch(r.stderr, /轮转/u, "空白串不是「世界变了」，是这个值根本不是代际");
    assert.equal(untouched(rec), undefined, "零抑制");
    assert.equal(fs.existsSync(path.join(home, "registry.lock")), false,
      "拒绝发生在拿锁之前");
  }

  // ③ 代际读不出来 —— 预览不许印一个能复制的假值
  {
    const { home, rec } = mk(false);
    const preview = run(home, "--all-generations");
    assert.equal(preview.status, 0, preview.stderr);
    assert.doesNotMatch(preview.stdout, /--apply --expect-generation \S/u,
      "**读不出代际时不许给出可复制的参数** —— 照抄之后会被误报成轮转");
    assert.match(preview.stdout, /读不出当前代际/u, "要直说是代际读不出来");
    const r = run(home, "--all-generations", "--apply", "--reason", "t");
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /取锁失败/u, "**这不是取锁失败**");
    assert.doesNotMatch(r.stderr, /轮转/u, "没有轮转");
    assert.equal(untouched(rec), undefined, "零抑制");
  }
});

test("Codex 抑制命令：真实入口 —— 预览后轮转必须 rotated 且零抑制", () => {
  // 评审指出：上一版的 readState 闭包引用了**加锁前**读到的 task ——
  // 我为共用核心设计了"锁内怎么重读"这个接口，**然后在实现它的时候把旧值闭包了进去**。
  // 接口对了，实现是假的：预览后轮转，旧格式记录仍会按旧代际被不可逆抑制。
  //
  // 而且他说得对 —— 之前那条回归只驱动共用核心，**没验包装层接线**。
  // 这跟我在 Stop 钩子上栽的那次一模一样：纯函数全绿、真实入口是坏的。
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Sup",
    rootMessageId: "om_root", token: "abc123" });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const regFile = path.join(home, "registry.json");
  writeRegistry([task], regFile);

  const paths = taskPaths(task, home);
  fs.mkdirSync(paths.outbox, { recursive: true });
  // **旧格式记录**：没有 target_channel_generation_id，代际靠当前状态现算。
  const rec = path.join(paths.outbox, "0001.json");
  fs.writeFileSync(rec, JSON.stringify({ kind: "progress", text: "旧格式", published_at: null }));

  const cli = path.join(ROOT, "scripts", "codex", "suppress-outbox.mjs");
  const run = (...args) => spawnSync(process.execPath, [cli, "--thread-id", THREAD_A, ...args],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  const suppressed = () => JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at;

  // 预览：能看到那一条。
  const preview = run("--all-generations");
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /待发      1 条/u);
  assert.match(preview.stdout, /dry-run/u);
  assert.equal(suppressed(), undefined, "预览不许写盘");

  // 预览必须把「落盘时该带哪一代」原样打出来 —— 不然人没处抄。
  const told = /--expect-generation (channel_generation_[0-9a-f]{24})/u.exec(preview.stdout);
  assert.ok(told, "预览要打出该带的代际：" + preview.stdout);
  const seenGeneration = told[1];

  // 不带它就不许落盘。**跨进程的轮转保护全靠这个值**。
  const bare = run("--all-generations", "--apply", "--reason", "t");
  assert.notEqual(bare.status, 0, "不带 --expect-generation 不许落盘");
  assert.match(bare.stderr, /--expect-generation/u);
  assert.equal(suppressed(), undefined, "被拦下时零抑制");

  // **预览之后轮转**：registry 换代，outbox 一个字节没动。
  // 新建的 task 第一代是 pending（还没被真实 @ 认领过），先标成 active 再造轮转。
  const rotated = JSON.parse(fs.readFileSync(regFile, "utf-8"));
  const state = rotated.tasks[0].topic_generation_state;
  assert.ok(state?.generations?.length, "夹具应当带着代际状态");
  const first = state.generations[0];
  first.status = "read-only";
  state.generations.push({ ...first, status: "active", generation: (first.generation ?? 1) + 1,
    channel_generation_id: "channel_generation_" + "f".repeat(24),
    root_message_id: "om_next", session_id: null, pending_token: null });
  rotated.tasks[0].channel_generation_id = "channel_generation_" + "f".repeat(24);
  fs.writeFileSync(regFile, JSON.stringify(rotated, null, 2));

  // 带着**预览那一刻**看到的代际来落盘 —— 现实里人就是照着预览抄的。
  const after = run("--all-generations", "--apply", "--reason", "t",
    "--expect-generation", seenGeneration);
  assert.notEqual(after.status, 0,
    "轮转过就必须中止。stdout=" + after.stdout + " stderr=" + after.stderr);
  assert.match(after.stderr, /轮转过/u);
  assert.equal(suppressed(), undefined, "**零抑制** —— 那条内容现在属于新话题");
});

test("locateTask 的 task-key 分支必须读 home 那一份登记表", () => {
  // 评审实测：这个分支拿的锁是 home/registry.lock，读的却是**默认位置**的
  // registry.json —— 显式指定 home 时，锁和被保护的文件根本不是同一份状态。
  // 现网没立刻炸，只是因为 CLI 的 home 恰好来自同一个环境变量。
  // **靠巧合保持一致的东西不算守住了。**
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "cx-other-"));
  const task = makeTaskEntry({ root: path.join(home, "p"), threadId: THREAD_A,
    name: "只在 home 里", rootMessageId: "om_root", token: "abc123" });
  // id 必须跟 key 同步 —— 读取端现在拒绝两者不一致的条目。
  task.logical_task_key = "only-in-home";
  task.id = "only-in-home";
  fs.writeFileSync(path.join(home, "registry.json"),
    JSON.stringify({ schema_version: "1.0", tasks: [task] }, null, 2));
  // 默认位置（由环境变量决定）指向一份**不含这条 task** 的登记表。
  fs.writeFileSync(path.join(other, "registry.json"),
    JSON.stringify({ schema_version: "1.0", tasks: [] }, null, 2));

  const prev = process.env.FEISHU_CODEX_BRIDGE_HOME;
  process.env.FEISHU_CODEX_BRIDGE_HOME = other;
  try {
    const got = locateTask({ threadId: null, taskKey: "only-in-home", home });
    assert.equal(got.ok, true,
      "读的必须是 home 那一份；读默认位置就会找不到（" + (got.reason ?? "") + "）");
    assert.equal(got.task.logical_task_key, "only-in-home");
  } finally {
    if (prev === undefined) delete process.env.FEISHU_CODEX_BRIDGE_HOME;
    else process.env.FEISHU_CODEX_BRIDGE_HOME = prev;
  }
});

test("Codex 预览和 --apply 不许给出相反结论：损坏记录在预览里就要点名", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Sup",
    rootMessageId: "om_root", token: "abc123" });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  writeRegistry([task], path.join(home, "registry.json"));
  const paths = taskPaths(task, home);
  fs.mkdirSync(paths.outbox, { recursive: true });
  const rec = path.join(paths.outbox, "0001.json");
  fs.writeFileSync(rec, JSON.stringify({ kind: "milestone", text: "坏的",
    published_at: null, target_channel_generation_id: "   " }));
  const cliPath = path.join(ROOT, "scripts", "codex", "suppress-outbox.mjs");
  const run = (...args) => spawnSync(process.execPath,
    [cliPath, "--thread-id", THREAD_A, ...args],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });

  const preview = run("--all-generations");
  assert.match(preview.stdout, /目标代际是坏的/u, "预览就要点名损坏");
  assert.match(preview.stdout, /0001\.json/u, "要说清是哪个文件");
  assert.doesNotMatch(preview.stdout, /每条都自带代际/u,
    "**这是错的判断** —— 它的目标字段在，但不是代际");

  const r = run("--all-generations", "--apply", "--reason", "t");
  assert.notEqual(r.status, 0, "预览说会拒，真跑就必须拒");
  assert.match(r.stderr, /目标代际是坏的/u);
  assert.equal(JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at, undefined,
    "零抑制");
});

test("锁内重读要重判损坏：文件名一个没变，目标字段变坏也必须中止", () => {
  // 评审实测复现的：锁外判的是**预览快照**。同一个文件的目标代际在预览之后
  // 变坏时，文件名集合一个字节没变，集合 CAS 一路放行 ——
  // 于是一条已经说不清该发去哪的内容被永久抑制。
  //
  // 这跟"锁内重读却闭包了旧值"是同一类：接口留了重读，实现只拿它比了文件名。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-relock-"));
  const obDir = path.join(dir, "outbox");
  fs.mkdirSync(obDir, { recursive: true });
  const rec = path.join(obDir, "0001.json");
  // **磁盘上已经是坏的**，而预览快照记的是好的 gen-1。
  fs.writeFileSync(rec, JSON.stringify({ kind: "milestone", text: "x",
    published_at: null, target_channel_generation_id: "   " }));

  const got = applySuppressionCore({
    outboxDir: obDir, publishLockDir: path.join(dir, "pub.lock"),
    generationLockDir: path.join(dir, "gen.lock"),
    pending: [{ _file: rec, target_channel_generation_id: "gen-1" }],
    previewGenerationId: "gen-1",
    readState: () => ({ activeGeneration: "gen-1", select: (x) => x }),
    reason: "t",
  });

  assert.equal(got.ok, false, "锁内重读必须发现它变坏了");
  assert.equal(got.reason, "corrupt_target_generation");
  assert.equal(got.atRecheck, true, "要说清是锁内重判时发现的，不是锁外那一次");
  assert.equal(JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at, undefined,
    "**零抑制** —— 说不清该发去哪，就不能替它决定不发");
});

test("安装器只许写进 CODEX_HOME —— 真机的 ~/.codex 一个字节都不许碰", () => {
  // **这条守的是一次实测事故。**新代码用 os.homedir() 算运行时根，而这套测试
  // 只隔离了 CODEX_HOME —— 于是跑一次测试就往真机装了 3.7M 的运行时。
  // 这个仓库为"测试污染真机"付过三次代价，那是第四次。
  //
  // 根因不是"某条测试忘了隔离"，是**隔离点没接到实现里**。所以守卫也不能是
  // "记得设 HOME"，而必须是：给了 CODEX_HOME，就一个字节都不许落在它外面。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));

  // 真机上那个位置现在是什么样，记下来。
  const realCodexRuntime = path.join(os.homedir(), ".codex", "feishu-bridge", "runtime");
  const before = fs.existsSync(realCodexRuntime)
    ? fs.readdirSync(realCodexRuntime).sort().join(",") : "<不存在>";

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"], {
      encoding: "utf-8",
      env: { ...isolatedEnv(), CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
    });
  assert.equal(r.status, 0, r.stderr);

  // 该装的地方装了。
  assert.equal(fs.existsSync(path.join(codexHome, "feishu-bridge", "runtime", "current")), true,
    "运行时必须落在 CODEX_HOME 下");

  // **不该动的地方一个字节没动。**
  const after = fs.existsSync(realCodexRuntime)
    ? fs.readdirSync(realCodexRuntime).sort().join(",") : "<不存在>";
  assert.equal(after, before,
    "给了 CODEX_HOME 还往真机写 —— 这正是那次污染的形状");
});

test("迁移必须收敛旧克隆的 hook，而不是在旁边再加一条", () => {
  // **迁移最容易办坏的就是这一步。**旧写法按完整路径找已有条目：
  // 路径从开发克隆换成 runtime/current 的那一刻就匹配不上，
  // 于是新增而不是替换 —— 指向旧克隆的那条原地不动。
  // Codex 文档说多个匹配的 hook 会全部运行，等于新旧两份代码同时在跑。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));

  // **夹具必须是现场真正的形状。**线上那两条是安装器当初生成的完整模板
  //（我核对过真机的 ~/.codex/hooks.json）。造一条裸的 `node <path>` 去测，
  // 测的就是另一件事 —— 严格解析本来就不该认领那种。
  const legacy = (script) =>
    "if [ -x '/opt/homebrew/bin/node' ] && [ -r '" + script + "' ]; then " +
    "FEISHU_CODEX_BRIDGE_HOME='/Users/someone/.codex/feishu-bridge' " +
    "'/opt/homebrew/bin/node' '" + script + "'; " +
    "else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; " +
    "printf '%s hook-unavailable\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> " +
    "'/Users/someone/.codex/feishu-bridge/hook.log' 2>/dev/null || :; fi";
  const clone = "/Users/someone/codex-projects/old-clone/scripts/codex/";
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [
        { type: "command", command: legacy(clone + "prompt-hook.mjs") },
      ] }],
      Stop: [
        // **同一条 entry 里既有我们的、又有别人的** —— 按 entry 整条删就会
        // 把别人那条一起删掉，而且删得很安静。
        { hooks: [
          { type: "command", command: "别人的 hook，不许动" },
          { type: "command", command: legacy(clone + "stop-hook.mjs") },
        ] },
        // 长得像、但不是我们的：guard 检查的脚本和实际执行的不是同一个。
        { hooks: [{ type: "command", command:
          "if [ -x '/opt/homebrew/bin/node' ] && [ -r '/x/stop-hook.mjs' ]; then " +
          "FEISHU_CODEX_BRIDGE_HOME='/y' '/opt/homebrew/bin/node' '/z/stop-hook.mjs'; " +
          "else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; " }] },
      ],
    },
  }));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"], {
      encoding: "utf-8",
      env: { ...isolatedEnv(), CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
    });
  assert.equal(r.status, 0, r.stderr);

  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf-8"));
  const commands = (event) => (hooks.hooks[event] ?? [])
    .flatMap((e) => (e.hooks ?? []).map((h) => h.command));

  // 旧克隆路径必须一个不剩。
  const all = JSON.stringify(hooks);
  assert.equal(all.includes("old-clone"), false,
    "**旧克隆的 hook 必须被收掉，不是留在旁边**：" + all);

  // 我们的 hook 各恰好一条。
  const mine = (event, basename) =>
    commands(event).filter((c) => c.includes("scripts/codex/" + basename));
  assert.equal(mine("UserPromptSubmit", "prompt-hook.mjs").length, 1, "恰好 1 条");
  assert.equal(mine("Stop", "stop-hook.mjs").length, 1, "恰好 1 条");

  // 而且指向 runtime/current。
  const expected = path.join(codexHome, "feishu-bridge", "runtime", "current",
    "scripts", "codex", "stop-hook.mjs");
  assert.ok(mine("Stop", "stop-hook.mjs")[0].includes(expected),
    "必须指向 runtime/current：" + mine("Stop", "stop-hook.mjs")[0]);

  // **别人的 hook 一条都不许动。**
  assert.ok(commands("Stop").includes("别人的 hook，不许动"),
    "**同一条 entry 里别人的 hook 必须原样留下** —— 按 entry 整条删会把它一起带走");
  assert.ok(commands("Stop").some((c) => c.includes("/z/stop-hook.mjs")),
    "长得像但 guard 与执行的脚本对不上的，不是我们的，不许碰");
});

test("装好的 runtime 必须能自证 —— doctor 在自己的运行环境里不许失灵", () => {
  // 评审实测：runtime 只收 scripts/**\/*.mjs，技能源模板进不去；
  // 从 runtime/current 跑 doctor，8 个技能文件全部报"源模板读不出来"——
  // **唯一的验收工具在它自己的运行环境里失灵。**
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  for (const d of [fakeHome, codexHome, bridge, bin]) fs.mkdirSync(d, { recursive: true });
  for (const n of ["codex", "aily-cli", "lark-cli"]) {
    fs.writeFileSync(path.join(bin, n), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  writeRegistry([], path.join(bridge, "registry.json"));
  fs.writeFileSync(path.join(bridge, "chain-config.json"),
    JSON.stringify({ ...TEMPLATE, lark_cli_bin: path.join(bin, "lark-cli") }));
  const env = { ...isolatedEnv(), HOME: fakeHome, CODEX_HOME: codexHome,
    FEISHU_CODEX_BRIDGE_HOME: bridge, PATH: bin + path.delimiter + process.env.PATH };

  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);

  // **从装好的 runtime 里跑**，不是从仓库里跑。
  const installedDoctor = path.join(codexHome, "feishu-bridge", "runtime", "current",
    "scripts", "codex", "doctor.mjs");
  assert.equal(fs.existsSync(installedDoctor), true, "doctor 要在 runtime 里");
  const r = spawnSync(process.execPath, [installedDoctor, "--json"], { encoding: "utf-8", env });
  const report = JSON.parse(r.stdout);
  const skills = report.checks.find((c) => c.name === "Codex skills");
  assert.equal(skills.ok, true,
    "**runtime 里的 doctor 必须能核验技能**：" + skills.detail);
  assert.doesNotMatch(skills.detail, /源模板读不出来/u);
  const hooks = report.checks.find((c) => c.name === "Codex hooks");
  assert.equal(hooks.ok, true, hooks.detail);
  // 一条真故障都不该有；只剩"查不清"的项。
  assert.equal(report.checks.filter((c) => c.ok === false).length, 0,
    "装完之后不该有故障：" + JSON.stringify(report.checks.filter((c) => c.ok === false)));
  assert.equal(report.overall, "incomplete");
});

test("lark_cli_bin 指到目录不算可执行 —— X_OK 对目录也成立", () => {
  // 评审实测：目录的"可执行"是"可进入"，accessSync(X_OK) 通过、isFile 是 false。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(home, "registry.json"));
  const aDir = path.join(home, "adir");
  fs.mkdirSync(aDir);
  const t = JSON.parse(JSON.stringify(TEMPLATE));
  t.lark_cli_bin = aDir;
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(t));
  const r = preflightTask({ task, home });
  assert.equal(r.ok, false, "**目录不是可执行文件**");
  assert.equal(r.reason, "lark_cli_not_a_file");
});

test("三态要校验字段类型 —— 畸形 published_at 不许被当成已发布藏起来", () => {
  // 评审实测：published_at 放 false / 0 / {} / "" 时，上一版全当"已发布"静默跳过，
  // 结果 ok:true, pending:0, unclassified:[] —— **一批损坏记录被永久藏起来，
  // 门槛还照样放行。**
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-strict-"));
  const put = (name, rec) => fs.writeFileSync(path.join(dir, name), JSON.stringify(rec));
  for (const [i, bad] of [false, 0, {}, "", [], true].entries()) {
    put("bad" + i + ".json", { published_at: bad });
  }
  put("ok-pending.json", { published_at: null });
  put("ok-published.json", { published_at: "2026-08-24T00:00:00.000Z" });
  put("ok-suppressed.json", { published_at: null, publish_suppressed_at: "2026-08-24T00:00:00.000Z" });
  // suppressed 字段本身畸形也要拦。
  put("bad-sup.json", { published_at: null, publish_suppressed_at: 7 });
  put("bad-sup2.json", { published_at: null, publish_suppressed_at: "" });

  const a = auditOutbox(dir);
  assert.equal(a.ok, true);
  assert.equal(a.pending, 1, "只有一条真待发");
  assert.equal(a.unclassified.length, 8,
    "**6 条畸形 published_at + 2 条畸形 suppressed 都要点出来**：" +
    JSON.stringify(a.unclassified.map((u) => u.file)));
});

test("停用：卸载失败不许删 plist —— 还在跑的定时器不能被显示成「未启用」", () => {
  // 评审实测：上一版是"卸载失败也照删 plist"。后果有两层 ——
  // 旧 job 可能还在跑，而 plist 一删，下次查状态就报 absent。
  // **一个还在跑的定时器被显示成「未启用」，比报错更糟。**
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  for (const d of [fakeHome, codexHome, bridge, bin]) fs.mkdirSync(d, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  // 假 launchctl：list 说有、bootout 失败（不是"没有这个服务"）。
  fs.writeFileSync(path.join(bin, "launchctl"),
    '#!/bin/sh\ncase "$1" in\n' +
    '  list) echo \'{ "Program" = "/x"; "ProgramArguments" = ( "/x"; ); };\'; exit 0;;\n' +
    '  bootout) echo "Boot-out failed: 5: Input/output error" >&2; exit 5;;\nesac\nexit 0\n',
    { mode: 0o700 });
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plist = path.join(agents, "com.frank.feishu-bridge-codex.drain.plist");
  fs.writeFileSync(plist, "<plist/>");

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--disable", "--apply"],
    { encoding: "utf-8", env: isolatedEnv({ HOME: fakeHome, CODEX_HOME: codexHome,
      FEISHU_CODEX_BRIDGE_HOME: bridge,
      // **这条测的就是"卸载失败"**，要用自己那份会失败的假 launchctl，
      // 不是全局那份"服务不存在"的。
      FEISHU_BRIDGE_LAUNCHCTL: path.join(bin, "launchctl"),
      PATH: bin + path.delimiter + process.env.PATH }) });

  assert.notEqual(r.status, 0, "卸载失败必须非零退出：" + r.stdout);
  assert.equal(fs.existsSync(plist), true, "**plist 不许被删**");
  assert.match(r.stderr, /卸载失败/u);
});

test("时间串走规范校验 —— 纯空白和乱写的都不算合法状态", () => {
  // 评审：上一版只要"非空字符串"就算合法时间，于是纯空白、"abc"、"2026-13-45"
  // 都被当成合法状态，损坏记录又被藏起来。改用全仓统一的 isCanonicalIso。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-time-"));
  const put = (n, rec) => fs.writeFileSync(path.join(dir, n), JSON.stringify(rec));
  for (const [i, bad] of ["   ", "abc", "2026-13-45T99:99:99.000Z",
    "2026-08-24T00:00:00Z"].entries()) {
    put("p" + i + ".json", { published_at: bad });
    put("s" + i + ".json", { published_at: null, publish_suppressed_at: bad });
  }
  put("good-p.json", { published_at: "2026-08-24T00:00:00.000Z" });
  put("good-s.json", { published_at: null, publish_suppressed_at: "2026-08-24T00:00:00.000Z" });

  const a = auditOutbox(dir);
  assert.equal(a.pending, 0);
  assert.equal(a.unclassified.length, 8,
    "**8 条伪时间串都要被点出来**：" + JSON.stringify(a.unclassified.map((u) => u.file)));
  // 缺毫秒的那种也不算 —— 产品写的是 toISOString()，判据就该按它来。
  assert.ok(a.unclassified.some((u) => u.file === "p3.json"),
    "缺毫秒的 ISO 串不是规范时间");
});

test("启用必须 fail-closed：launchd 查不出来时，只许一次只读 list", () => {
  // 评审指出：unverifiable 那道门槛**没有测试钉着** —— 单独删掉它，
  // 整套仍然 135/135 全绿。产品行为当时是对的，但"对"没有守卫就守不住。
  //
  // 这条断言的是**控制面只被读、没被改**：一次 list，零 bootout、零 bootstrap，
  // plist 逐字节不变。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  for (const d of [fakeHome, codexHome, bridge, bin]) fs.mkdirSync(d, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  fs.writeFileSync(path.join(bridge, "chain-config.json"), JSON.stringify(TEMPLATE));

  const marker = path.join(dir, "CALLED");
  const lc = path.join(bin, "launchctl");
  // list 返回**看不懂的东西** → 拆不出 ProgramArguments → unverifiable。
  fs.writeFileSync(lc, '#!/bin/sh\necho "$@" >> ' + JSON.stringify(marker) +
    '\ncase "$1" in\n  list) echo "看不懂的输出"; exit 0;;\nesac\nexit 0\n', { mode: 0o755 });

  const env = isolatedEnv({ HOME: fakeHome, CODEX_HOME: codexHome,
    FEISHU_CODEX_BRIDGE_HOME: bridge, FEISHU_BRIDGE_LAUNCHCTL: lc });
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);

  // 写一份**合法且与当前配置一致**的 plist —— 这样 phase 只可能由 launchd 那步决定。
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plist = path.join(agents, "com.frank.feishu-bridge-codex.drain.plist");
  fs.writeFileSync(plist, plistBody({ home: fakeHome, codexHome }));
  const before = fs.readFileSync(plist);
  fs.rmSync(marker, { force: true });

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--enable", "--apply"],
    { encoding: "utf-8", env });

  assert.notEqual(r.status, 0, "查不出来就必须拒绝：" + r.stdout);
  assert.match(r.stderr, /launchd 状态查不出来/u, "要说清拒绝的原因");
  assert.match(r.stderr, /什么都没动/u);

  const calls = fs.existsSync(marker)
    ? fs.readFileSync(marker, "utf-8").trim().split("\n").filter(Boolean) : [];
  assert.equal(calls.length, 1, "**只许一次调用**（只读的 list）：" + JSON.stringify(calls));
  assert.match(calls[0], /^list /u, "那一次必须是只读的 list");
  assert.equal(calls.some((c) => /^(bootout|bootstrap)/u.test(c)), false,
    "**控制面一次都不许被改**");
  assert.deepEqual(fs.readFileSync(plist), before, "plist 逐字节不许变");
});

test("已经在健康运行时，重跑 --enable 是无操作 —— 不许打断正在进行的排空", () => {
  // 评审的非阻断建议，我当成安全问题做了：无条件 bootout → bootstrap
  // **可能打断一次正在进行的排空**。幂等重跑不该有副作用。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  for (const d of [fakeHome, codexHome, bridge, bin]) fs.mkdirSync(d, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  fs.writeFileSync(path.join(bridge, "chain-config.json"), JSON.stringify(TEMPLATE));

  const marker = path.join(dir, "CALLED");
  const lc = path.join(bin, "launchctl");
  const expectScript = path.join(codexHome, "feishu-bridge", "runtime", "current",
    "scripts", "codex", "drain-all.mjs");
  // **用产品同一个函数挑 node，不自己猜。**猜错的话这条测的就成了"路径不一致"，
  // 而不是"健康在跑时不该动手"。
  const node = pickNode();
  // list 报告"正在跑，而且参数就是当前这份"。
  fs.writeFileSync(lc, '#!/bin/sh\necho "$@" >> ' + JSON.stringify(marker) +
    '\ncase "$1" in\n  list) printf \'{\\n\\t"Program" = "%s";\\n\\t"ProgramArguments" = (\\n\\t\\t"%s";\\n\\t\\t"%s";\\n\\t);\\n};\\n\' ' +
    JSON.stringify(node) + ' ' + JSON.stringify(node) + ' ' + JSON.stringify(expectScript) +
    '; exit 0;;\nesac\nexit 0\n', { mode: 0o755 });

  const env = isolatedEnv({ HOME: fakeHome, CODEX_HOME: codexHome,
    FEISHU_CODEX_BRIDGE_HOME: bridge, FEISHU_BRIDGE_LAUNCHCTL: lc });
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plist = path.join(agents, "com.frank.feishu-bridge-codex.drain.plist");
  fs.writeFileSync(plist, plistBody({ home: fakeHome, codexHome, node }));
  const before = fs.readFileSync(plist);
  fs.rmSync(marker, { force: true });

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--enable", "--apply"],
    { encoding: "utf-8", env });

  assert.equal(r.status, 0,
    "健康在跑时重跑应当成功且无操作：" + r.stdout + r.stderr);
  assert.match(r.stdout, /什么都没做/u);
  const calls = fs.existsSync(marker)
    ? fs.readFileSync(marker, "utf-8").trim().split("\n").filter(Boolean) : [];
  assert.equal(calls.some((c) => /^(bootout|bootstrap)/u.test(c)), false,
    "**不许 bootout/bootstrap** —— 那会打断正在进行的排空：" + JSON.stringify(calls));
  assert.deepEqual(fs.readFileSync(plist), before, "plist 也不许被重写");
});

test("启用必须 fail-closed：plist 读不出来时，launchctl 一次都不许被调用", () => {
  // 评审实测：上一版启用路径先 bootout、再写盘才抛 EISDIR ——
  // **退出码是 1，可 launchd 控制面已经被动过**。
  // 报错报对了、事情办坏了，跟停用那条是同一种病。
  //
  // 所以这条断言的不是"退出码非零"，而是**它一次都没碰过控制面**。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  for (const d of [fakeHome, codexHome, bridge, bin]) fs.mkdirSync(d, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  fs.writeFileSync(path.join(bridge, "chain-config.json"), JSON.stringify(TEMPLATE));

  // 记账用的假 launchctl：**被调用一次就留痕**。
  const marker = path.join(dir, "CALLED");
  const lc = path.join(bin, "launchctl");
  fs.writeFileSync(lc, '#!/bin/sh\necho "$@" >> ' + JSON.stringify(marker) +
    '\necho "Could not find service" >&2\nexit 113\n', { mode: 0o755 });

  // **把 plist 路径做成目录** → 读它 EISDIR。
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plistPathAsDir = path.join(agents, "com.frank.feishu-bridge-codex.drain.plist");
  fs.mkdirSync(plistPathAsDir);

  const env = isolatedEnv({ HOME: fakeHome, CODEX_HOME: codexHome,
    FEISHU_CODEX_BRIDGE_HOME: bridge, FEISHU_BRIDGE_LAUNCHCTL: lc });
  // 先把运行时装好，免得卡在运行时那道门槛上、测不到我们要测的东西。
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);
  // 安装本身不该碰 launchctl；从这里开始计数。
  fs.rmSync(marker, { force: true });

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--enable", "--apply"],
    { encoding: "utf-8", env });

  assert.notEqual(r.status, 0, "必须拒绝：" + r.stdout);
  assert.match(r.stderr, /plist 读不出来/u, "要说清拒绝的原因");
  assert.match(r.stderr, /什么都没动/u);
  assert.equal(fs.existsSync(marker), false,
    "**launchctl 一次都不许被调用** —— 调用过就说明拒绝发生在动手之后：" +
    (fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8") : ""));
  // 现场保持原样：还是一个目录，不是被写成了文件。
  assert.equal(fs.statSync(plistPathAsDir).isDirectory(), true,
    "plist 路径的类型都不许被改");
});

test("plist 读不出来不许当成「未启用」", () => {
  // 评审实测：把 plist 路径做成目录，状态仍显示"未启用"，
  // 停用命令还会说"本来就没启用"。**读不出来不等于没有** ——
  // 这条道理我在登记表、outbox 上都写过，这是第三处。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  fs.mkdirSync(bridge, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  // **把 plist 路径做成目录** → 读它会 EISDIR。
  fs.mkdirSync(path.join(agents, "com.frank.feishu-bridge-codex.drain.plist"));

  const env = isolatedEnv({ HOME: fakeHome, CODEX_HOME: path.join(dir, "codex"),
    FEISHU_CODEX_BRIDGE_HOME: bridge });
  const status = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs")], { encoding: "utf-8", env });
  assert.doesNotMatch(status.stdout, /未启用（安装后的默认态/u,
    "**不许报成未启用**：" + status.stdout);
  assert.match(status.stdout, /plist 读不出来/u);

  // 停用也必须拒绝，而不是说"本来就没启用"。
  const off = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--disable", "--apply"],
    { encoding: "utf-8", env });
  assert.notEqual(off.status, 0, "读不出来就不许当成没启用：" + off.stdout);
  assert.doesNotMatch(off.stdout, /本来就没启用/u);
});

test("停用的顺序：核验没过时 plist 一个字节都不许动", () => {
  // 评审实测：上一版先删 plist 再核验。bootout 返回成功但 job 仍在时，
  // 命令确实非零退出了，**可现场已经被改成 orphan** —— plist 没了、job 还在，
  // 比动手之前更糟。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plist = path.join(agents, "com.frank.feishu-bridge-codex.drain.plist");
  fs.writeFileSync(plist, "<plist/>");
  const before = fs.readFileSync(plist, "utf-8");

  // 假 launchctl：bootout 成功，但 list 始终说 job 还在。
  const lc = path.join(bin, "launchctl");
  fs.writeFileSync(lc, '#!/bin/sh\ncase "$1" in\n' +
    '  list) echo \'{ "Program" = "/x"; "ProgramArguments" = ( "/x"; ); };\'; exit 0;;\n' +
    'esac\nexit 0\n', { mode: 0o755 });

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--disable", "--apply"],
    { encoding: "utf-8", env: isolatedEnv({ HOME: fakeHome,
      CODEX_HOME: path.join(dir, "codex"), FEISHU_CODEX_BRIDGE_HOME: bridge,
      FEISHU_BRIDGE_LAUNCHCTL: lc }) });

  assert.notEqual(r.status, 0, "核验没过必须非零退出");
  assert.equal(fs.existsSync(plist), true,
    "**plist 不许被删** —— 删了现场就变成「没有 plist、job 还在」，比之前更糟");
  assert.equal(fs.readFileSync(plist, "utf-8"), before, "一个字节都不许动");
});

test("有副作用的技能必须关掉隐式调用，且装出来要带上那份策略", () => {
  // **宿主级的那一层。**技能描述里写着"讨论和引用不得触发"，
  // 但那是给模型看的约定 —— 宿主的技能选择不受它约束，出过真事故。
  //
  // 这一层跟凭证门禁**同时存在**，缺一不可：
  //   这里挡「误选」，凭证挡「误执行」。
  // 单靠凭证的话，每次误选都要靠门禁兜底 —— 而门禁是最后一道，不该当第一道用。
  const WRITE_SKILLS = ["feishu-bind", "feishu-unbind", "feishu-rotate", "feishu-mode"];
  for (const name of WRITE_SKILLS) {
    const f = path.join(ROOT, "skills", name, "agents", "openai.yaml");
    assert.equal(fs.existsSync(f), true, "**缺策略文件**：" + name);
    const text = fs.readFileSync(f, "utf-8");
    assert.match(text, /allow_implicit_invocation:\s*false/u,
      name + " 必须关掉隐式调用：" + text);
  }
  // 只读技能不需要 —— 加了只是噪音，而且会让"哪些有副作用"这件事变模糊。
  for (const name of ["feishu-status", "feishu-subscribe"]) {
    assert.equal(fs.existsSync(path.join(ROOT, "skills", name, "agents", "openai.yaml")),
      false, "只读技能不该有这份策略：" + name);
  }

  // **装出来也要带上，而且逐字节一致。**清单漏了它的话，
  // 线上就只有凭证那一层 —— 而"同时存在"才是设计。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));
  const env = isolatedEnv({ CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home });
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);

  for (const name of WRITE_SKILLS) {
    const installed = path.join(codexHome, "skills", name, "agents", "openai.yaml");
    assert.equal(fs.existsSync(installed), true, "**装出来必须带上**：" + name);
    assert.equal(fs.readFileSync(installed, "utf-8"),
      fs.readFileSync(path.join(ROOT, "skills", name, "agents", "openai.yaml"), "utf-8"),
      name + " 装出来的内容要逐字节一致");
  }
  // doctor 也要能核验它 —— "文件在"不等于"装对了"。
  const audit = auditSkills({ repoRoot: ROOT, codexHome,
    runtimeCurrent: path.join(codexHome, "feishu-bridge", "runtime", "current"),
    bridgeHome: home });
  assert.equal(audit.ok, true, JSON.stringify(audit.problems));
  fs.writeFileSync(path.join(codexHome, "skills", "feishu-bind", "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: true\n");
  const tampered = auditSkills({ repoRoot: ROOT, codexHome,
    runtimeCurrent: path.join(codexHome, "feishu-bridge", "runtime", "current"),
    bridgeHome: home });
  assert.equal(tampered.ok, false, "**被改成 true 必须被 doctor 发现**");
  assert.ok(tampered.problems.some((p) => p.file === "agents/openai.yaml"));
});

test("每个命令都要有对应的技能，装出来还要能被 doctor 核验", () => {
  // **清单漏一项的后果是"命令能敲、技能没装"**，而那要等真人敲了才发现。
  // 这条把三样绑在一起：prompt-hook 认得的命令、技能清单、装出来的产物。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));
  const env = isolatedEnv({ CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home });
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);

  // prompt-hook 认得的每一个 $feishu-x，都必须有同名技能装出来。
  for (const name of ["feishu-bind", "feishu-unbind", "feishu-status",
    "feishu-rotate", "feishu-subscribe"]) {
    assert.notEqual(classifyFeishuPrompt("$" + name), "none",
      name + " 必须被 prompt-hook 认得");
    assert.equal(
      fs.existsSync(path.join(codexHome, "skills", name, "SKILL.md")), true,
      "**命令认得但技能没装**：" + name);
  }

  // 装出来的还要能通过逐字节核验 —— "文件在"不等于"装对了"。
  const runtimeCurrent = path.join(codexHome, "feishu-bridge", "runtime", "current");
  const audit = auditSkills({ repoRoot: ROOT, codexHome, runtimeCurrent, bridgeHome: home });
  assert.equal(audit.ok, true, JSON.stringify(audit.problems));
});

test("订阅投影只许有一份实现", () => {
  // **我在这个 PR 里真的造了第二份。**state.mjs 早就有
  // buildCodexSubscriptionProjection（还在 shadowCodexFirstClaim 的真实路径上用着），
  // 我没查就新建了 scripts/codex/subscription-projection.mjs —— 两份并存的话，
  // 一份改了另一份没跟上，两边对"订阅活动"的判断就会分叉，
  // 而那种分叉最难查：两个命令都说自己正常。
  //
  // 这条钉的是"只有一处定义"。文件级断言，因为这正是**改坏了照样绿**的形状：
  // 第二份存在时所有测试都能过。
  const dir = path.join(ROOT, "scripts", "codex");
  // 排除测试文件自己 —— 这条断言里写着那个正则，会把自己算进去。
  const defs = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "test.mjs")
    .filter((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf-8");
    return /export function buildCodexSubscriptionProjection/u.test(text);
  });
  assert.deepEqual(defs, ["state.mjs"],
    "**订阅投影只能定义一次**，现在有：" + JSON.stringify(defs));

  // 带 threadId 时只投影那一条；不带时仍是全局视图（首次认领 shadow 依赖它）。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const a = makeTaskEntry({ root, threadId: THREAD_A, name: "A",
    rootMessageId: "om_a", token: "a1b2c3" });
  const b = makeTaskEntry({ root, threadId: THREAD_B, name: "B",
    rootMessageId: "om_b", token: "d4e5f6" });
  writeRegistry([a, b], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const all = buildCodexSubscriptionProjection({ home });
  const one = buildCodexSubscriptionProjection({ home, threadId: THREAD_A });
  assert.equal(all.ok, true, all.reason);
  assert.equal(one.ok, true, one.reason);
  assert.equal((all.pending_bindings ?? []).length, 2, "不带 threadId 仍是全局视图");
  assert.equal((one.pending_bindings ?? []).length, 1,
    "**带 threadId 只投影那一条** —— 否则 status 会把别人的待认领算进来");
});

test("$feishu-subscribe：四种输入形式都要判对，讨论时不许触发", () => {
  // 命令名原本在四条正则里各写一遍。**漏一处的后果分两种**：
  // 裸写能用但 Desktop 的链接形式不认；或者带了参数时不再 fail-closed。
  // 两种都得等真人踩到才发现，所以这里四种形式各验一次。
  assert.equal(classifyFeishuPrompt("$feishu-subscribe"), "subscribe");
  assert.equal(classifyFeishuPrompt("[$feishu-subscribe](/x/feishu-subscribe/SKILL.md)"),
    "subscribe", "Desktop 会把技能调用序列化成链接形式");
  assert.equal(classifyFeishuPrompt("$feishu-subscribe 多余的"), "invalid-subscribe",
    "**带了参数必须 fail-closed**，不许静默当成裸命令执行");
  assert.equal(classifyFeishuPrompt("[$feishu-subscribe](/x/别的技能/SKILL.md)"),
    "invalid-subscribe", "链接指向别的技能就不算");
  // **讨论、引用、转发都没有控制授权。**
  assert.equal(classifyFeishuPrompt("我们讨论一下 $feishu-subscribe 这个命令"), "none");
  assert.equal(classifyFeishuPrompt("前面还有字 $feishu-subscribe"), "none");
  // 收成一份清单之后，既有命令一个都不许坏。
  for (const name of ["bind", "unbind", "status", "rotate"]) {
    assert.equal(classifyFeishuPrompt("$feishu-" + name), name, name + " 不许被改坏");
  }
});

test("$feishu-subscribe：注入的命令只读，且要求原样转述「为什么不能写」", () => {
  const ctx = composeSubscribeContext({ bridgeRoot: "/r", threadId: THREAD_A });
  assert.ok(ctx.includes("/r/scripts/codex/feishu-subscribe.mjs"), "要指向对的脚本");
  assert.ok(ctx.includes(THREAD_A), "要带精确 thread id");
  // 只禁 --apply。"不得使用 --last"这句**本身就该在** —— 我第一版把它一起禁了，
  // 那是把一条安全要求当成了违规。
  assert.doesNotMatch(ctx, /--apply/u, "**只读命令不许出现 --apply**");
  assert.match(ctx, /不得使用 --last/u, "而「不许猜线程」这条要求必须在");
  // **原因本身就是信息。**概括成"暂不支持修改"，下一个来问"为什么"的人
  // 就得把这段重新考古一遍。
  assert.match(ctx, /原样转述/u);
  assert.match(ctx, /不要概括成/u);
  assert.match(ctx, /只出数量不出身份/u, "脱敏要求要带进去");
});

test("subscribe 命令：读得出订阅，且不泄漏任何 locator", () => {
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "订阅示例",
    // 认领口令必须是 6 位十六进制（subscription.mjs 的格式要求）——
    // 我第一版写了 "tok123456"，投影直接判 record:pending_token 不合法。
    // **改夹具，不是放松判据。**
    rootMessageId: "om_secret_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-subscribe.mjs"), "--thread-id", THREAD_A],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.equal(r.status, 0, r.stderr);
  if (!/订阅状态/u.test(r.stdout)) {
    // 投影不合法时把 problems 打出来 —— "invalid" 三个字查不出是哪个字段。
    const probe = buildCodexSubscriptionProjection({ home, threadId: THREAD_A });
    assert.fail("投影不可用：" + JSON.stringify(probe).slice(0, 400) + "\n" + r.stdout);
  }
  assert.match(r.stdout, /授权发送者.*只出数量，不出身份/u);
  assert.match(r.stdout, /写入口还没开/u, "为什么不能写要说清楚");

  // **一个 locator 都不许出现。**
  for (const secret of ["om_secret_root", "a1b2c3", THREAD_A,
    TEMPLATE.chat_id, TEMPLATE.agent_uid, TEMPLATE.transport_open_id]) {
    if (!secret) continue;
    assert.equal(r.stdout.includes(secret), false, "泄漏了：" + secret);
  }

  // 拼错的参数不许静默退化。
  const typo = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-subscribe.mjs"), "--thread--id", THREAD_A],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.notEqual(typo.status, 0, "**拼错的参数不许被当成对的**");
});

test("status 不许执行别的项目的 provider —— 不显示还不够，必须不跑", () => {
  // **评审用 marker 文件证明的：输出里看不见，marker 却建出来了。**
  // 机器级 collectConnectivity 会把所有 provider 都跑一遍再按归属过滤显示 ——
  // 界面上干净，别人的脚本已经在这台机器上执行过了。
  // 「项目范围要是只管显示不管执行，那它就不是范围。」
  const dir = temp();
  const home = path.join(dir, "bridge");
  const mine = path.join(dir, "mine");
  const theirs = path.join(dir, "theirs");
  for (const d of [home, mine, theirs]) fs.mkdirSync(d, { recursive: true });
  const task = makeTaskEntry({ root: mine, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  // 别的项目的 provider：**跑起来就留 marker**。
  //
  // 夹具必须是真实格式（id / protocol / executable / script / allowed_kinds /
  // project_root）—— 我第一版写的是 name/projectRoot/command，**根本加载不进去**，
  // 于是那条测试从头到尾没验到任何东西：连机器级 collector 都"没执行"。
  const marker = path.join(dir, "THEIRS_RAN");
  const script = path.join(dir, "theirs.mjs");
  fs.writeFileSync(script,
    'import fs from "node:fs";\n' +
    "fs.writeFileSync(" + JSON.stringify(marker) + ', "ran");\n' +
    'process.stdout.write(JSON.stringify({ schema_version: "feishu-bridge-status/v1",' +
    ' provider_id: "theirs", connections: [] }));\n');
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(providers, JSON.stringify({
    providers: [{
      id: "theirs", protocol: "feishu-bridge-status/v1",
      executable: process.execPath, script,
      allowed_kinds: ["transport"], project_root: theirs,
    }],
  }));

  const run = (threadId) => spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"), "--thread-id", threadId],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home,
      FEISHU_BRIDGE_STATUS_PROVIDERS: providers }) });

  // 本项目也放一个 provider，跑起来留自己的 marker ——
  // **只断言"别人的没跑"是不够的**：root 传空时两个都不跑，那条断言照样成立，
  // 于是"过滤失效"和"什么都没跑"分不开。要同时断言**自己的确实跑了**。
  const mineMarker = path.join(dir, "MINE_RAN");
  const mineScript = path.join(dir, "mine.mjs");
  fs.writeFileSync(mineScript,
    'import fs from "node:fs";\n' +
    "fs.writeFileSync(" + JSON.stringify(mineMarker) + ', "ran");\n' +
    'process.stdout.write(JSON.stringify({ schema_version: "feishu-bridge-status/v1",' +
    ' provider_id: "mine", connections: [] }));\n');
  fs.writeFileSync(providers, JSON.stringify({
    providers: [
      { id: "theirs", protocol: "feishu-bridge-status/v1",
        executable: process.execPath, script, allowed_kinds: ["transport"],
        project_root: theirs },
      { id: "mine", protocol: "feishu-bridge-status/v1",
        executable: process.execPath, script: mineScript, allowed_kinds: ["transport"],
        project_root: mine },
    ],
  }));

  // ① 绑定状态：本项目的要跑，别人的一个都不跑。
  const bound = run(THREAD_A);
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(fs.existsSync(mineMarker), true,
    "**本项目的 provider 该跑** —— 不跑的话下面那条断言就没有意义了");
  assert.equal(fs.existsSync(marker), false,
    "**别的项目的 provider 被执行了** —— 不显示还不够，必须不跑");
  assert.doesNotMatch(bound.stdout, /别人的项目/u);
  fs.rmSync(mineMarker, { force: true });

  // ② 未绑定：没有可信的项目根 → 一个 provider 都不跑，不许退回机器全景。
  const unbound = run(THREAD_B);
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.equal(fs.existsSync(marker), false,
    "**未绑定时更不该跑** —— 说不清是谁的，就不该替谁执行");
});

test("群名优先用 task 自己的覆盖，而不是把知道的说成不知道", () => {
  // 上一轮修掉了"错报模板群名"，却把"已知 task 群名被报成不可用"留下了。
  // 两种都是错的：一个说了错名字，一个把知道的说成不知道。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  // **task 自己覆盖了群**（不是模板那个群）。
  task.chat_id = "oc_task_own_group";
  task.chat_name = "这条 task 自己的群";
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"), "--thread-id", THREAD_A],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /订阅群.*这条 task 自己的群/u,
    "**已知的 task 群名不许被报成不可用**：" + r.stdout);
  // 而且不许把模板那个群的名字套上来。
  assert.doesNotMatch(r.stdout, new RegExp(TEMPLATE.chat_name ?? "___", "u"));
});

test("意图凭证：复现那次事故 —— 没有凭证的 --apply 一律拒绝", () => {
  // **这条钉的是一次真事故。**一条 agent 之间的消息里提到了某个 $ 命令，
  // Codex 的绑定技能就被选中，直接去跑真实绑定（那次是审批门挡住的）。
  //
  // 技能描述里写着"自然语言讨论、引用或 Agent 消息不得触发"，
  // 钩子的判据也是整条精确匹配 —— **但技能选择这一层不受那条判据约束**。
  // description 负责路由（"这段话像不像在说这件事"），
  // 那跟"这次真的被授权了吗"是两个问题。混淆代理。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const env = isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home });

  // 事故的形状：agent 自己去跑 bind-task --apply，**没有凭证**。
  const noIntent = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
      "--project", root, "--thread-id", THREAD_A, "--apply"],
    { encoding: "utf-8", env });
  assert.notEqual(noIntent.status, 0, "**没有凭证必须拒绝**：" + noIntent.stdout);
  assert.match(noIntent.stderr, /一次性意图凭证/u);
  assert.match(noIntent.stderr, /agent 之间转述、引用、正文夹带都不会有/u,
    "要说清为什么它拿不到凭证");
  // **没有任何状态被改变。**
  assert.equal(fs.existsSync(path.join(home, "tasks")), false, "不许留下 task 目录");

  // 预览不需要凭证 —— 它没有副作用，要凭证只会把凭证消费在没用的地方。
  const preview = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
      "--project", root, "--thread-id", THREAD_A],
    { encoding: "utf-8", env });
  assert.doesNotMatch(preview.stderr, /一次性意图凭证/u, "预览不该要凭证");
});

test("自动轮转不许被门禁卡死，也不许靠 --automatic 绕过", () => {
  // **每种情形用不同的 turn。**签发按 (thread, turn, 意图) 幂等 ——
  // 同一 turn 连签同类票会拿到同一张（或消费后被墓碑挡住）。
  // 这条要验的是"不同意图互不通用"，所以每次换 turn 才测得到那件事。
  // **评审实测：加了门禁之后，自动轮转整条被卡死**（intent_missing, exit 1）。
  // 那条路径由发布器数到阈值自己发起，**没有用户输入**，不可能有 hook 签的票。
  //
  // 但也不能让 --automatic 直接绕过 —— 那样谁加上这个参数都能强制轮转，
  // 等于开一扇没锁的后门。做法是让**做出决定的一方签字**。
  const home = temp();
  const T = THREAD_A;

  // ① 发布器签的 rotate:auto 票，轮转脚本能消费。
  const auto = issueIntent({ action: "rotate:auto", threadId: T, turnId: "a1",
    params: buildIntentParams("rotate:auto", { project: "/p" }), home });
  assert.equal(consumeIntent({ id: auto.id, action: "rotate:auto", threadId: T,
    params: buildIntentParams("rotate:auto", { project: "/p" }), home }).ok, true, "自动那条要能走通");

  // ② **人工票不能拿去做自动轮转，反过来也不行。**
  const manual = issueIntent({ action: "rotate", threadId: T, turnId: "a2",
    params: buildIntentParams("rotate", { op: "create" }), home });
  assert.equal(consumeIntent({ id: manual.id, action: "rotate:auto", threadId: T,
    params: buildIntentParams("rotate:auto", { project: "/p" }), home }).reason, "intent_action_mismatch");
  const auto2 = issueIntent({ action: "rotate:auto", threadId: T, turnId: "a3",
    params: buildIntentParams("rotate:auto", { project: "/p" }), home });
  assert.equal(consumeIntent({ id: auto2.id, action: "rotate", threadId: T,
    params: buildIntentParams("rotate", { op: "create" }), home }).reason, "intent_action_mismatch");

  // ③ **创建票不能拿去取消。**三种情形各自授权，不是一张通票。
  const create = issueIntent({ action: "rotate", threadId: T, turnId: "a4",
    params: buildIntentParams("rotate", { op: "create" }), home });
  assert.equal(consumeIntent({ id: create.id, action: "rotate", threadId: T,
    params: buildIntentParams("rotate", { op: "cancel" }), home }).reason, "intent_params_mismatch");
});

test("接线：走真实决策路径签票 → 真实 CLI 过门禁；代际变了就拒", () => {
  // **上一版这条直接调 issueIntent —— 等于测试自己充当授权者**，
  // 于是它证明不了"生产里那条链能走通"，也没抓住重试撞墓碑那个缺陷。
  // 评审指出来的。现在从 recordCodexActivityAndMaybeRotate 进去，
  // 由它自己决定、自己签字、自己把票交给 launcher。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const stored = findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task;
  const gen = activeGeneration(topicStateForTask(stored).state).channel_generation_id;

  // 数到阈值 —— 让决策方自己决定要轮转。
  let launched = null;
  const drive = (i) => recordCodexActivityAndMaybeRotate({
    root, threadId: THREAD_A, home, generationId: gen,
    eventKey: "evt-" + i, messageDelta: 1,
    spawnImpl: (bin, args) => { launched = args; return { pid: 1, unref() {} }; },
  });
  let decided = null;
  for (let i = 0; i < 40 && !decided; i += 1) {
    const r = drive(i);
    if (r.shouldAutoRotate) decided = r;
  }
  assert.ok(decided, "夹具要能数到阈值");
  assert.equal(decided.rotationLaunch?.ok, true,
    "**决策方要能签出票并启动 worker**：" + JSON.stringify(decided.rotationLaunch));
  assert.ok(launched, "worker 要被启动");

  // 把决策方交给 worker 的那张票，喂进真实 CLI —— 必须过门禁。
  const at = launched.indexOf("--intent");
  assert.notEqual(at, -1, "launcher 必须把票传下去：" + JSON.stringify(launched));
  const ticket = launched[at + 1];
  const env = isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home });
  const pass = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-rotate.mjs"),
      "--project", root, "--thread-id", THREAD_A, "--automatic", "--apply",
      "--intent", ticket],
    { encoding: "utf-8", env });
  assert.doesNotMatch(pass.stderr ?? "", /凭证/u,
    "**决策方签的票必须过真实 CLI 的门禁**：" + pass.stderr);

  // **冷却之后的新决策必须能拿到新票。**
  //
  // 评审实测到的：首次启动成功、票被消费，**重试请求就撞上那张墓碑**
  //（intent_already_used）—— 自动轮转从此再也起不来。
  // 槽位里要带上"这次决策的号"：同一次决策幂等，新决策换号拿新票。
  let retried = null;
  for (let i = 100; i < 160 && !retried; i += 1) {
    const r = recordCodexActivityAndMaybeRotate({
      root, threadId: THREAD_A, home, generationId: gen,
      eventKey: "retry-" + i, messageDelta: 1, retryMs: 0,
      spawnImpl: (bin, args) => { launched = args; return { pid: 1, unref() {} }; },
    });
    if (r.shouldAutoRotate) retried = r;
  }
  assert.ok(retried, "冷却之后要能再次决定轮转");
  assert.equal(retried.rotationLaunch?.ok, true,
    "**重试必须能拿到新票**，不该撞上上次那张墓碑：" +
    JSON.stringify(retried.rotationLaunch));
  const at2 = launched.indexOf("--intent");
  assert.notEqual(launched[at2 + 1], ticket, "新决策要拿到不同的票");
});

test("签发是原子的：并发只产生一个授权，消费后不许重签", () => {
  // 评审实测：上一版"先查再随机创建"，32 个并发签发进程跑出 **4 张不同活票**。
  // 我改成 mkdir 抢槽位之后仍有 2 张 —— 因为 recursive: true 在目录已存在时
  // **不报 EEXIST**，每个进程都以为自己抢到了。互斥全靠 EEXIST，recursive 把它吞了。
  const home = temp();
  const T = THREAD_A;
  const sign = () => issueIntent({ action: "bind", threadId: T, turnId: "same-turn",
    params: buildIntentParams("bind", { project: "/p" }), home });

  // 消费前重复签 → 同一张。
  const a = sign();
  const b = sign();
  assert.equal(a.id, b.id, "**消费前重复签必须是同一张**");
  assert.equal(b.reused, true);

  // **真并发。**顺序调两次证明不了原子性 —— 把槽位改回 recursive: true
  // （EEXIST 被吞、每个进程都以为自己抢到了）时，上面那两行照样绿。
  // 必须真的同时开多个进程。
  const concHome = temp();
  const one = path.join(concHome, "one.mjs");
  fs.writeFileSync(one,
    'import { issueIntent, buildIntentParams } from ' +
    JSON.stringify(path.join(ROOT, "scripts", "codex", "intent.mjs")) + ';\n' +
    'const r = issueIntent({ action: "bind", threadId: ' + JSON.stringify(T) + ',\n' +
    '  turnId: "conc", params: buildIntentParams("bind", { project: "/p" }),\n' +
    '  home: process.env.H });\n' +
    'process.stdout.write((r.ok ? r.id : "ERR:" + r.reason) + "\\n");\n');
  // **spawnSync 在循环里是顺序的** —— 那样写出来的"并发测试"根本不并发，
  // 我第一版就是那样。用 shell 把它们同时放出去再 wait。
  const out = path.join(concHome, "out.txt");
  const sh = spawnSync("/bin/sh", ["-c",
    'for i in $(seq 1 16); do node ' + JSON.stringify(one) +
    ' >> ' + JSON.stringify(out) + ' 2>/dev/null & done; wait'],
    { encoding: "utf-8", env: { ...process.env, H: concHome } });
  assert.equal(sh.status, 0, sh.stderr);
  const lines = fs.readFileSync(out, "utf-8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 8, "至少要真的跑起来几个：" + lines.length);
  const ids = new Set(lines.map((x) => x.trim()).filter((x) => x && !x.startsWith("ERR")));
  assert.equal(ids.size, 1,
    "**并发只能产生一个授权**，实际 " + ids.size + " 个：" + [...ids].join(" "));

  // 消费。
  assert.equal(consumeIntent({ id: a.id, action: "bind", threadId: T, turnId: "same-turn",
    params: buildIntentParams("bind", { project: "/p" }), home }).ok, true);

  // **消费后不许重签** —— 这一次输入已经授权过一次了。
  const after = sign();
  assert.equal(after.ok, false, "**消费后不许再签**：" + JSON.stringify(after));
  assert.equal(after.reason, "intent_already_used");
});

test("轮转脚本真实入口：人工票不能拿去跑 --automatic", () => {
  // **函数层验过还不够。**把脚本里那行改成三种共用 "rotate"，函数层的断言
  // 全都还是绿的 —— 因为它们验的是凭证层，不是脚本怎么选 action。
  // 这条打真实 CLI。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  // **要有 active generation，门禁才走得到。**
  //
  // 门禁绑住"这次决定的是哪一代"，所以它必须排在代际读出来之后 ——
  // 而新建 task 的第一代是 pending。夹具不真实的话，脚本会先因为
  // "没有 active generation"退出，**根本走不到凭证那一层**：
  // 于是这条测试测的是别的东西，我第一版就是这样。
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
  // **这两行 delete 是必须的**，探针跑出来才看清：留着 makeTaskEntry 造的那份
  // 代际状态，第一代永远是 pending；删掉之后才会按 bound 重新合成出 active。
  // 既有夹具里那两行 delete 就是干这个的，我一开始没看懂它们为什么在。
  delete task.topic_generation_state;
  delete task.channel_generation_id;
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const env = isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home });

  // 拿一张**人工创建**的票，去跑自动轮转 —— 必须被拒。
  const manual = issueIntent({ action: "rotate", threadId: THREAD_A,
    params: buildIntentParams("rotate", { op: "create" }), home });
  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-rotate.mjs"),
      "--project", root, "--thread-id", THREAD_A, "--automatic", "--apply",
      "--intent", manual.id],
    { encoding: "utf-8", env });
  // **断言必须能分辨"被凭证拒"和"因别的原因失败"。**
  // 只断言非零退出是恒真的：这个夹具里 task 没有 active generation，
  // 业务判断本来就会非零退出 —— 于是把 action 改成通票，这条照样绿。
  // 实测过：那个变异下整套 157/0。
  assert.match(r.stderr, /凭证授权的不是这个动作/u,
    "**必须是被凭证拒的**，不是因为别的原因失败：" +
    JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }).slice(0, 400));

  // 反过来：自动票去跑人工创建，也必须被拒。
  const auto = issueIntent({ action: "rotate:auto", threadId: THREAD_A,
    params: { project: root }, home });
  const r2 = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-rotate.mjs"),
      "--project", root, "--thread-id", THREAD_A, "--apply", "--intent", auto.id],
    { encoding: "utf-8", env });
  assert.match(r2.stderr, /凭证授权的不是这个动作/u,
    "**必须是被凭证拒的**：" +
    JSON.stringify({ status: r2.status, stderr: r2.stderr }).slice(0, 300));
});

test("$feishu-rotate cancel 有真入口，而且能拿到取消的票", () => {
  // **评审指出：取消在生产里永远拿不到凭证。**
  // 带参数的控制命令被判成 invalid-rotate，于是那个能力只有测试能用 ——
  // 而测试自己充当授权者，那不算证明。要么给真入口，要么撤掉能力。
  assert.equal(classifyFeishuPrompt("$feishu-rotate cancel"), "rotate-cancel");
  assert.equal(classifyFeishuPrompt("[$feishu-rotate](/x/feishu-rotate/SKILL.md) cancel"),
    "rotate-cancel", "Desktop 的链接形式也要认");
  assert.equal(classifyFeishuPrompt("$feishu-rotate"), "rotate", "不带参数仍是创建");
  // 畸形仍要 fail-closed 并给反馈 —— 不许静默成 none。
  assert.equal(classifyFeishuPrompt("$feishu-rotate 别的"), "invalid-rotate");
  assert.equal(classifyFeishuPrompt("讨论 $feishu-rotate cancel"), "none");

  // 注入的命令要带 --cancel，票也要是取消那一张。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "prompt-hook.mjs")],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }),
      input: JSON.stringify({ prompt: "$feishu-rotate cancel", cwd: root,
        session_id: THREAD_A, turn_id: "t1" }) });
  const ctx = JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /--cancel/u, "**注入的命令必须带 --cancel**：" + ctx);
  assert.match(ctx, /--intent '[0-9a-f]{32}'/u, "而且要带票");

  // 那张票必须是**取消**的票 —— 拿它去创建要被拒。
  const id = /--intent '([0-9a-f]{32})'/u.exec(ctx)[1];
  assert.equal(consumeIntent({ id, action: "rotate", threadId: THREAD_A,
    params: buildIntentParams("rotate", { op: "create" }), home }).reason,
    "intent_params_mismatch", "**取消的票不许拿去创建**");
});

test("跨群绑定的群名要进摘要 —— A 群的票不许绑到 B 群", () => {
  // 评审实测：chat_name 不在摘要里，群名 A/B 的摘要完全相同。
  // 群名是**发给人看的那个名字**，换了名字就是另一次操作。
  const home = temp();
  const T = THREAD_A;
  const a = issueIntent({ action: "bind", threadId: T, turnId: "c1",
    params: buildIntentParams("bind", { project: "/p", chat: "oc_a", chatName: "A 群" }), home });
  assert.equal(consumeIntent({ id: a.id, action: "bind", threadId: T, turnId: "c1",
    params: buildIntentParams("bind", { project: "/p", chat: "oc_a", chatName: "B 群" }), home })
    .reason, "intent_params_mismatch", "**换了群名必须拒**");
  const b = issueIntent({ action: "bind", threadId: T, turnId: "c2",
    params: buildIntentParams("bind", { project: "/p", chat: "oc_a", chatName: "A 群" }), home });
  assert.equal(consumeIntent({ id: b.id, action: "bind", threadId: T, turnId: "c2",
    params: buildIntentParams("bind", { project: "/p", chat: "oc_a", chatName: "A 群" }), home })
    .ok, true, "一致就放行");
});

test("凭证绑的是这一次操作，不是这一类操作", () => {
  // 评审的三个反例：mode 不分 dialogue/mapping、rotate 不分创建/取消、
  // bind 不绑 project。**只绑命令族等于"授权了这一类"，那不是授权。**
  const home = temp();
  const T = THREAD_A;

  // 每次换 turn —— 签发按 (thread, turn, 意图) 幂等，同 turn 会拿到同一张。
  const dialogue = issueIntent({ action: "mode", threadId: T, turnId: "p1",
    params: buildIntentParams("mode", { mode: "dialogue" }), home });
  assert.equal(consumeIntent({ id: dialogue.id, action: "mode", threadId: T,
    params: buildIntentParams("mode", { mode: "mapping" }), home }).reason, "intent_params_mismatch",
    "**一张 dialogue 票不该能切 mapping**");

  const bindA = issueIntent({ action: "bind", threadId: T, turnId: "p2",
    params: buildIntentParams("bind", { project: "/a" }), home });
  assert.equal(consumeIntent({ id: bindA.id, action: "bind", threadId: T,
    params: buildIntentParams("bind", { project: "/b" }), home }).reason, "intent_params_mismatch",
    "**一张 /a 的绑定票不该能绑 /b**");

  // 参数对上就放行。
  const ok = issueIntent({ action: "bind", threadId: T, turnId: "p3",
    params: buildIntentParams("bind", { project: "/a" }), home });
  assert.equal(consumeIntent({ id: ok.id, action: "bind", threadId: T,
    params: buildIntentParams("bind", { project: "/a" }), home }).ok, true);
});

test("同一次输入只签一张票；消费之后不许重签", () => {
  // **这条整条重写过。**上一版有两处错：
  //   · 动作写 bind、参数却用 rotate:auto 的构造器 —— 摘要跟真实路径无关；
  //   · 断言"消费后重签是新的一张"，而新契约是**拒绝重签** ——
  //     更糟的是它靠 notEqual(undefined, 旧 id) 假通过：
  //     c 是 { ok: false }，c.id 就是 undefined，那条断言恒真。
  //     **我把 bug 写进了断言，还让它一直绿着。**
  const home = temp();
  const T = THREAD_A;
  const same = () => issueIntent({ action: "bind", threadId: T, turnId: "turn-1",
    params: buildIntentParams("bind", { project: "/p" }), home });

  const a = same();
  const b = same();
  assert.equal(a.id, b.id, "**同一次输入必须拿到同一张票**");
  assert.equal(b.reused, true, "第二次是复用，不是新签");

  assert.equal(consumeIntent({ id: a.id, action: "bind", threadId: T, turnId: "turn-1",
    params: buildIntentParams("bind", { project: "/p" }), home }).ok, true);

  // **消费之后拒绝重签** —— 这一次输入已经授权过一次了。
  const c = same();
  assert.equal(c.ok, false, "**消费后不许再签**：" + JSON.stringify(c));
  assert.equal(c.reason, "intent_already_used");

  // 换了轮次就是另一次输入，可以签。
  const other = issueIntent({ action: "bind", threadId: T, turnId: "turn-2",
    params: buildIntentParams("bind", { project: "/p" }), home });
  assert.equal(other.ok, true);
  assert.notEqual(other.id, a.id);

  // 换了意图也是。
  const diff = issueIntent({ action: "bind", threadId: T, turnId: "turn-1",
    params: buildIntentParams("bind", { project: "/other" }), home });
  assert.equal(diff.ok, true, "不同意图不受那张墓碑影响");
  assert.notEqual(diff.id, a.id);
});

test("只读的 $feishu-mode 不许签出可当写票用的凭证", () => {
  // **评审实测到的最险的一条**：无参数的只读 $feishu-mode 会签出一张 mode 票，
  // 而那张票能被核心当写票消费 —— **一次只读输入换来一次写授权。**
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const env = isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home });

  const hook = (prompt) => {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, "scripts", "codex", "prompt-hook.mjs")],
      { encoding: "utf-8", env, input: JSON.stringify({
        prompt, cwd: root, session_id: THREAD_A, turn_id: "t1" }) });
    return JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  };
  const dir = intentDir(home);
  const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith(".json")).length;

  const before = count();
  const readOnly = hook("$feishu-mode");
  assert.doesNotMatch(readOnly, /--intent/u, "只读那条不该带凭证");
  assert.equal(count(), before,
    "**只读的 $feishu-mode 不许签票** —— 签了就是一次只读输入换一次写授权");

  // 带参数的才签，而且票绑着那个参数。
  const write = hook("$feishu-mode dialogue");
  assert.match(write, /--intent '[0-9a-f]{32}'/u, "带参数的要签：" + write);
  assert.equal(count(), before + 1);
});

test("意图凭证：重放、串动作、串 thread、过期，四种都要拒", () => {
  const home = temp();
  const T = THREAD_A;

  // ① 正常消费一次成功
  const a = issueIntent({ action: "bind", threadId: T, turnId: "r0", home });
  assert.equal(consumeIntent({ id: a.id, action: "bind", threadId: T, home }).ok, true);
  // **② 同一张再用一次 —— 必须拒。**这是"一次输入只授权一次操作"的全部含义。
  assert.equal(consumeIntent({ id: a.id, action: "bind", threadId: T, home }).reason,
    "intent_already_used");

  // ③ 串动作：拿 bind 的凭证去做 unbind
  const b = issueIntent({ action: "bind", threadId: T, turnId: "r1", home });
  assert.equal(consumeIntent({ id: b.id, action: "unbind", threadId: T, home }).reason,
    "intent_action_mismatch");
  // **对不上也不还回去** —— 一张被误用的凭证不该还能再试一次。
  assert.equal(consumeIntent({ id: b.id, action: "bind", threadId: T, home }).reason,
    "intent_already_used");

  // ④ 串 thread
  const c = issueIntent({ action: "bind", threadId: T, turnId: "r2", home });
  assert.equal(consumeIntent({ id: c.id, action: "bind", threadId: THREAD_B, home }).reason,
    "intent_thread_mismatch");

  // ⑤ 过期
  const d = issueIntent({ action: "bind", threadId: T, home });
  assert.equal(consumeIntent({ id: d.id, action: "bind", threadId: T, home,
    now: Date.now() + INTENT_TTL_MS + 1 }).reason, "intent_expired");

  // ⑥ 没给 / 伪造 / 路径穿越
  assert.equal(consumeIntent({ action: "bind", threadId: T, home }).reason, "intent_missing");
  assert.equal(consumeIntent({ id: "deadbeef", action: "bind", threadId: T, home }).reason,
    "intent_id_malformed");
  assert.equal(consumeIntent({ id: "../../etc/passwd", action: "bind", threadId: T, home }).reason,
    "intent_id_malformed", "**id 会被拼进路径，不能是任意字符串**");
  assert.equal(consumeIntent({ id: "f".repeat(32), action: "bind", threadId: T, home }).reason,
    "intent_not_found", "格式对但没签发过的，也拒");
});

test("意图凭证：钩子只给写动作签，只读的不签", () => {
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  const env = isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home });

  const hook = (prompt) => {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, "scripts", "codex", "prompt-hook.mjs")],
      { encoding: "utf-8", env, input: JSON.stringify({
        prompt, cwd: root, session_id: THREAD_A, turn_id: "t1" }) });
    return JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  };

  // 写动作：命令里必须带凭证。
  const unbind = hook("$feishu-unbind");
  // 命令里是 shell 引号包着的 —— 断言要按真实形状写，不是按我以为的形状。
  assert.match(unbind, /--intent '[0-9a-f]{32}'/u, "写动作要带凭证：" + unbind);

  // **只读动作不签** —— 多发一张就多一个能被误用的东西。
  //
  // 只断言"命令里没有 --intent"是**不够的**：把 status 加进 WRITE_ACTIONS 之后
  // 命令里照样不会出现 --intent（status 的 compose 根本不接 intentId），
  // 可凭证已经被签出来躺在磁盘上了。变异实测：那样改，整套仍然全绿。
  // 所以要直接数**磁盘上多没多出凭证**。
  const dir = intentDir(home);
  const countIntents = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith(".json")).length;

  const beforeReadOnly = countIntents();
  const status = hook("$feishu-status");
  assert.doesNotMatch(status, /--intent/u, "只读不该有凭证：" + status);
  const subscribe = hook("$feishu-subscribe");
  assert.doesNotMatch(subscribe, /--intent/u);
  assert.equal(countIntents(), beforeReadOnly,
    "**只读动作不许签发凭证** —— 命令里看不见，不等于没签出来躺在磁盘上");

  // **讨论、引用不许签发。**这就是那次事故的入口。
  const before = countIntents();
  assert.equal(hook("我们讨论一下 $feishu-unbind 这个命令"), "", "讨论不该注入任何东西");
  assert.equal(hook("前面有字 $feishu-unbind"), "");
  assert.equal(countIntents(), before, "**讨论不许签发凭证** —— 签了就等于给了一次授权");
});

test("钩子注入的命令必须跑 runtime/current —— 不许按模板的 bridge_root 拼", () => {
  // **这是迁移真正漏掉的那一半，而且从外部完全看不出来。**
  // hooks.json 已经指向 runtime/current、hook 在跑也被信任了，
  // 可注入的命令是从模板的 bridge_root 拼的 —— 那个字段还指着旧克隆。
  // 结果：钩子路径是新的、命令路径是旧的，Codex 一直在跑一天前的代码，
  // status 出的是迁移前的旧格式。是 Frank 问"为什么 status 还是旧格式"才查出来的。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  const root = path.join(dir, "project");
  for (const d of [codexHome, home, root]) fs.mkdirSync(d, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  // **模板里故意留一个指向别处的 bridge_root** —— 就是迁移前的现场。
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify({
    ...TEMPLATE, bridge_root: "/Users/someone/old-clone/feishu-bridge-c" }));

  const env = isolatedEnv({ CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home });
  const runtimeCurrent = path.join(codexHome, "feishu-bridge", "runtime", "current");

  const hook = () => spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "prompt-hook.mjs")],
    { encoding: "utf-8", env, input: JSON.stringify({
      prompt: "$feishu-status", cwd: root, session_id: THREAD_A, turn_id: "t1" }) });

  const before = hook();
  const ctxBefore = JSON.parse(before.stdout || "{}")
    ?.hookSpecificOutput?.additionalContext ?? "";
  assert.ok(ctxBefore.includes(runtimeCurrent),
    "**注入的命令必须指向 runtime/current**：" + ctxBefore);
  assert.equal(ctxBefore.includes("old-clone"), false,
    "**不许按模板的 bridge_root 拼** —— 那个字段会漂：" + ctxBefore);
});

test("安装器要把模板的 bridge_root 更新到 runtime/current", () => {
  // 它由 init-chain-template 写成"生成模板时那个仓库路径"，安装器一直不碰它。
  // 于是每次迁移都会留下这个漂移，而**没有任何检查在看它**
  //（旧的"仓库路径"判据被我删了，删完只剩一个没人用的死变量）。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));
  const tplFile = path.join(home, "chain-config.json");
  fs.writeFileSync(tplFile, JSON.stringify({
    ...TEMPLATE, bridge_root: "/Users/someone/old-clone/feishu-bridge-c" }));

  const env = isolatedEnv({ CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home });
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);

  // **doctor 必须能查出这种漂移** —— 装之前它就该是 ✗。
  // 这条单独验，因为判据本身也可能被写成"永远通过"，那样它就白加了。
  const drifted = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "doctor.mjs"), "--json"],
    { encoding: "utf-8", env });
  const beforeReport = JSON.parse(drifted.stdout);
  const beforeCheck = beforeReport.checks.find((c) => c.name === "模板 bridge_root");
  assert.ok(beforeCheck, "doctor 必须有这条判据");

  const after = JSON.parse(fs.readFileSync(tplFile, "utf-8"));
  assert.equal(after.bridge_root,
    path.join(codexHome, "feishu-bridge", "runtime", "current"),
    "**装完必须指向 runtime/current**");
  // **只改这一个字段**：模板里还有群、身份、凭据位置，装一次基础设施不该动它们。
  for (const key of ["chat_id", "agent_uid", "transport_open_id", "lark_cli_profile"]) {
    if (TEMPLATE[key] === undefined) continue;
    assert.equal(after[key], TEMPLATE[key], "不许顺手改 " + key);
  }

  // 装完之后 doctor 该说一致了。
  const fixed = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "doctor.mjs"), "--json"],
    { encoding: "utf-8", env });
  const afterCheck = JSON.parse(fixed.stdout).checks.find((c) => c.name === "模板 bridge_root");
  assert.equal(afterCheck.ok, true, "装完必须一致：" + afterCheck.detail);
});

test("doctor 的 bridge_root 判据不许写成「永远通过」", () => {
  // **判据本身也要被验。**上一版加完之后我做变异，把它改成恒 true —— 全绿。
  // 那说明那条判据当时一条守卫都没有：加了个看起来对的东西，坏了也没人知道。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  const bin = path.join(dir, "bin");
  for (const d of [codexHome, home, bin]) fs.mkdirSync(d, { recursive: true });
  for (const n of ["codex", "aily-cli", "lark-cli"]) {
    fs.writeFileSync(path.join(bin, n), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  writeRegistry([], path.join(home, "registry.json"));
  const env = isolatedEnv({ CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home,
    PATH: bin + path.delimiter + process.env.PATH });
  // 先正常装一遍（安装器会把 bridge_root 校正过来）。
  fs.writeFileSync(path.join(home, "chain-config.json"),
    JSON.stringify({ ...TEMPLATE, lark_cli_bin: path.join(bin, "lark-cli") }));
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env }).status, 0);

  const check = () => JSON.parse(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "doctor.mjs"), "--json"],
    { encoding: "utf-8", env }).stdout).checks.find((c) => c.name === "模板 bridge_root");

  assert.equal(check().ok, true, "装完是一致的：" + check().detail);

  // **然后把它改坏** —— 判据必须由 true 变 false。
  const tplFile = path.join(home, "chain-config.json");
  const doc = JSON.parse(fs.readFileSync(tplFile, "utf-8"));
  doc.bridge_root = "/Users/someone/old-clone/feishu-bridge-c";
  fs.writeFileSync(tplFile, JSON.stringify(doc, null, 2));
  const broken = check();
  assert.equal(broken.ok, false,
    "**改坏了必须报 ✗** —— 恒真的判据等于没有判据：" + broken.detail);
  assert.match(broken.detail, /runtime 之外/u);
});

test("四层 status：Codex 侧报的必须是自己那条链的事实，不是 Claude 的", () => {
  // **这条迁移最容易办坏的地方。**endpointFacts 的 runtime / runtimeDir / verify
  // 默认值全指向 Claude 那条链 —— 不显式给的话，第 1 层会写着"Claude Code"、
  // 版本号报的是 Claude 运行时的哈希。而第 1 层问的正是"我这条链的端点"。
  // 我第一次接线就是这样，输出看着完整、内容是别人的。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "四层示例",
    rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(home, "registry.json"));
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"), "--thread-id", THREAD_A],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.equal(r.status, 0, r.stderr);

  // 四层都在。
  for (const layer of ["第 1 层 · 运行端点连接", "第 2 层 · 事件订阅",
    "第 3 层 · 精确通道绑定", "第 4 层 · 交互策略"]) {
    assert.ok(r.stdout.includes(layer), "缺 " + layer + "：" + r.stdout);
  }

  // **第 1 层必须是 Codex 自己的。**
  assert.match(r.stdout, /运行时.*Codex CLI/u, "运行时不许写成 Claude Code");
  assert.doesNotMatch(r.stdout, /Claude Code/u, "**一个字都不许出现 Claude Code**");

  // **绑定级别必须是 task 级。**落到 else 分支会写成"整个项目共用一个话题"，
  // 那句话在 Codex 侧是错的。
  assert.match(r.stdout, /绑定级别.*这条 task 单独一个话题/u);
  assert.doesNotMatch(r.stdout, /整个项目共用一个话题/u);

  // 绑定名称来自 task 自己。
  assert.match(r.stdout, /绑定名称.*四层示例/u);

  // **版本号必须来自 Codex 那条链。**这条单独验，因为它是最难发现的一类：
  // 不传 runtimeDir/verify 的话输出看着完整，报的却是 Claude 运行时的哈希 ——
  // 一个"看起来已安装"的第 1 层，背后是另一条链。
  //
  // **判据不能是"未安装"** —— 那依赖本机 Codex runtime 恰好没装。
  // 真装上之后这条就失效了（我装完线上就撞到了），跟 launchd 那条是同一种病：
  // 夹具依赖真机状态。改成给一个**隔离的空 CODEX_HOME**，
  // 那里必然没有 runtime；若它仍报出版本号，那个号只可能来自别的链。
  const emptyCodexHome = path.join(home, "empty-codex");
  fs.mkdirSync(emptyCodexHome, { recursive: true });
  const isolated = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"), "--thread-id", THREAD_A],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home,
      CODEX_HOME: emptyCodexHome }) });
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.match(isolated.stdout, /安装状态.*未安装/u,
    "**空的 CODEX_HOME 里必须报未安装** —— 报出版本号说明查的是别的链：" + isolated.stdout);
  assert.match(isolated.stdout, /运行时版本.*未安装/u);

  // **不许泄漏 locator。**status 刻意不打印这些。
  assert.doesNotMatch(r.stdout, /om_root/u, "根消息 id 不许出现");
  assert.doesNotMatch(r.stdout, new RegExp(THREAD_A, "u"), "thread id 不许出现");
  assert.doesNotMatch(r.stdout, /abc123/u, "认领口令不许出现");
});

test("四层 status：这条 task 的登记表状态要单独报，不跟 task 自己的状态混", () => {
  // 第 3 层其余各行读的是 task 自己的状态，而出站走登记表 ——
  // 两套可以不一致，而**那种不一致最难查**：状态页说正常、出站挑不到它。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "abc123" });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  // **登记表里没有它** —— task 文件在，但出站挑不到。
  writeRegistry([], path.join(home, "registry.json"));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"), "--thread-id", THREAD_A],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  // 登记表里没有它 → 第 3 层必须说"尚未绑定"，不许假装绑好了。
  // **四层照出**（没绑定不等于没有四层），但第 3 层要说实话。
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /第 3 层 · 精确通道绑定/u, "四层要照出");
  assert.match(r.stdout, /尚未绑定/u,
    "**登记表里没有它时不许报成绑好了**：" + r.stdout);
  assert.doesNotMatch(r.stdout, /当前代际/u, "没绑就没有代际可报");
});

test("三态必须互斥：既标已发布又标已停发的记录是坏的", () => {
  // 评审：上一版只要 publish_suppressed_at 是非空串就判 suppressed，
  // 不管 published_at 是什么 —— **一条自相矛盾的记录被静默接受**。
  // 停发的前提就是它还没发出去。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-excl-"));
  const put = (n, rec) => fs.writeFileSync(path.join(dir, n), JSON.stringify(rec));
  put("both.json", outboxRecord({ published_at: "2026-08-24T00:00:00.000Z",
    publish_suppressed_at: "2026-08-24T00:00:00.000Z" }));
  const a = auditOutbox(dir);
  assert.equal(a.pending, 0);
  assert.equal(a.unclassified.length, 1, "**自相矛盾必须被点出来**");
  assert.match(a.unclassified[0].why, /自相矛盾/u);

  // 正常的 suppressed（published_at 是 null）仍然算 suppressed。
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cx-excl2-"));
  fs.writeFileSync(path.join(dir2, "s.json"), JSON.stringify(outboxRecord({
    published_at: null, publish_suppressed_at: "2026-08-24T00:00:00.000Z" })));
  assert.deepEqual(auditOutbox(dir2),
    { ok: true, pending: 0, unclassified: [], unexplainable: [], files: ["s.json"] });
});

test("loadedPhase 与 absentJob 必须共用同一份缺席判据", () => {
  // 两处各写一份的话，同一个错误串在两处得到不同结论 ——
  // absentJob 说"这是真失败"，loadedPhase 却说"服务不存在"。
  for (const detail of ["Boot-out failed: 5: Input/output error",
    "could not load service", "job not loaded correctly"]) {
    assert.equal(absentJob(detail), false, "这是真失败：" + detail);
    assert.equal(loadedPhase(() => ({ ok: false, detail }), null), "unverifiable",
      "**真失败在 loadedPhase 里也必须是 unverifiable，不是 installed_not_loaded**：" + detail);
  }
  for (const detail of ["Could not find service \"x\" in domain", "No such process"]) {
    assert.equal(absentJob(detail), true);
    assert.equal(loadedPhase(() => ({ ok: false, detail }), null), "installed_not_loaded");
  }
});

test("没有 plist 时的三种可能：absent / orphan / unverifiable，查不清不许报 orphan", () => {
  // 评审：查不清就报 orphan，等于声称一件没查过的事 —— 而 orphan 是"还在跑"，
  // 会把人引去做一次不必要的卸载。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex");
  const bridge = path.join(dir, "bridge");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(bridge, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });

  const withLaunchctl = (script) => {
    const f = path.join(bin, "launchctl");
    fs.writeFileSync(f, script, { mode: 0o755 });
    const r = spawnSync(process.execPath,
      [path.join(ROOT, "scripts", "codex", "drain-service.mjs")],
      { encoding: "utf-8", env: isolatedEnv({ HOME: fakeHome, CODEX_HOME: codexHome,
        FEISHU_CODEX_BRIDGE_HOME: bridge, FEISHU_BRIDGE_LAUNCHCTL: f }) });
    return r.stdout;
  };

  // ① 明确没有 → absent
  assert.match(withLaunchctl('#!/bin/sh\necho "Could not find service" >&2\nexit 113\n'),
    /未启用（安装后的默认态/u, "明确没有就是 absent");

  // ② 查到 job、没有 plist → orphan
  assert.match(withLaunchctl('#!/bin/sh\necho \'{ "Program" = "/x"; "ProgramArguments" = ( "/x"; ); };\'\nexit 0\n'),
    /没有 plist，但 launchd 里还有同名 job/u, "查到 job 就是 orphan");

  // ③ **查不清 → unverifiable，不许报 orphan**
  const unclear = withLaunchctl('#!/bin/sh\necho "Operation not permitted" >&2\nexit 1\n');
  assert.doesNotMatch(unclear, /没有 plist，但 launchd 里还有同名 job/u,
    "**查不清不许说成 orphan** —— 那是在声称一件没查过的事");
});

test("launchctl 必须走注入口 —— 测试不许读真实控制面", () => {
  // 评审实测：同一份代码在我这里 127/127、在他那里 125/127，
  // 因为两条回归隔离了 HOME 却没隔离 launchd 域。
  // **这条钉的是注入口本身存在且被尊重。**
  const dir = temp();
  const marker = path.join(dir, "CALLED");
  const f = path.join(dir, "launchctl");
  fs.writeFileSync(f, '#!/bin/sh\necho called >> ' + JSON.stringify(marker) +
    '\necho "Could not find service" >&2\nexit 113\n', { mode: 0o755 });
  const bridge = path.join(dir, "bridge");
  fs.mkdirSync(bridge, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs")],
    { encoding: "utf-8", env: isolatedEnv({ HOME: path.join(dir, "home"),
      CODEX_HOME: path.join(dir, "codex"), FEISHU_CODEX_BRIDGE_HOME: bridge,
      FEISHU_BRIDGE_LAUNCHCTL: f }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), true,
    "**注入口必须被真的用上** —— 没被调用说明它还在读别的地方");
});

test("「本来就没有这个服务」的判据不许放宽", () => {
  // 上一版还认 not.*loaded —— 那能匹配上 "could not load"、
  // "job not loaded correctly" 之类**真正的失败**。判据放宽一点，
  // "卸载失败"就会被当成"本来就没有"，于是照样往下走。
  assert.equal(absentJob("Could not find service \"x\" in domain"), true);
  assert.equal(absentJob("No such file or directory"), true);
  for (const real of ["Boot-out failed: 5: Input/output error",
    "could not load service", "job not loaded correctly", "Operation not permitted"]) {
    assert.equal(absentJob(real), false, "**这是真失败，不是「本来就没有」**：" + real);
  }
});

test("链路预检必须真验身份：lark-cli 不在、凭据对不上都要拦", () => {
  // 评审实测：resolveLarkIdentity **只是拼路径，永远返回对象** ——
  // 拿它当身份检查的话，二进制不存在、凭据目录读不出来、profile 不在、
  // app id 对不上，一律"通过"。而真实发送会在这几处失败。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(home, "registry.json"));

  const bin = path.join(home, "lark-cli");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const credBase = path.join(home, "creds");
  const agentDir = path.join(credBase, String(TEMPLATE.agent_uid ?? "agent"));
  fs.mkdirSync(agentDir, { recursive: true });
  const writeCred = (appId) => fs.writeFileSync(path.join(agentDir, "config.json"),
    JSON.stringify({ apps: [{ name: TEMPLATE.lark_cli_profile, appId }] }));

  const withTemplate = (mut) => {
    const t = JSON.parse(JSON.stringify(TEMPLATE));
    t.lark_cli_bin = bin;
    t.lark_cli_config_base = credBase;
    mut(t);
    fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(t));
    return preflightTask({ task, home });
  };

  writeCred(TEMPLATE.outbound_app_id);
  const good = withTemplate(() => {});
  assert.equal(good.ok, true, "配置齐全时该通过：" + (good.reason ?? ""));

  // 二进制不存在
  const missing = withTemplate((t) => { t.lark_cli_bin = "/definitely/missing/lark"; });
  assert.equal(missing.ok, false, "**lark-cli 不存在必须拦**");
  assert.equal(missing.reason, "lark_cli_not_executable");

  // 二进制在但不可执行
  const notExec = path.join(home, "not-exec");
  fs.writeFileSync(notExec, "x", { mode: 0o600 });
  assert.equal(withTemplate((t) => { t.lark_cli_bin = notExec; }).reason,
    "lark_cli_not_executable", "不可执行也要拦");

  // 凭据目录读不出来
  assert.equal(withTemplate((t) => { t.lark_cli_config_base = "/definitely/missing"; }).reason,
    "config_dir_unreadable", "**凭据目录读不出来必须拦**");

  // 凭据里的 app id 跟配置对不上 —— 拿着别人的身份发
  writeCred("cli_someoneelse");
  assert.equal(withTemplate(() => {}).reason, "app_id_mismatch",
    "**凭据属于别的应用必须拦**");
  writeCred(TEMPLATE.outbound_app_id);
});

test("积压归类：每个 JSON 都要能归类，说不清就拦住", () => {
  // 评审：上一版只补了坏 JSON，没覆盖"路径不是目录"和"能解析但不是记录（如 {}）"。
  // **只有目录不存在才算真的空。**
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-audit-"));
  const ok = (name, body) => fs.writeFileSync(path.join(dir, name), body);

  ok("pending.json", JSON.stringify({ kind: "milestone", published_at: null }));
  ok("published.json", JSON.stringify({ published_at: "2026-08-24T00:00:00.000Z" }));
  ok("suppressed.json", JSON.stringify({ published_at: null,
    publish_suppressed_at: "2026-08-24T00:00:00.000Z" }));
  let a = auditOutbox(dir);
  assert.equal(a.ok, true);
  assert.equal(a.pending, 1, "三态各一，只有一条待发");
  assert.deepEqual(a.unclassified, [], "三态都能归类");

  ok("empty.json", "{}");
  ok("broken.json", "这不是 JSON");
  ok("array.json", "[]");
  a = auditOutbox(dir);
  assert.equal(a.pending, 1, "待发数不受影响");
  assert.equal(a.unclassified.length, 3,
    "**{} / 坏 JSON / 数组都必须被点出来**：" + JSON.stringify(a.unclassified));

  // 目录不存在 = 合法的空。
  assert.deepEqual(auditOutbox(path.join(dir, "nope")),
    { ok: true, pending: 0, unclassified: [], unexplainable: [], files: [] });

  // 路径是文件不是目录 → 说不清，拦住。
  const file = path.join(dir, "afile");
  fs.writeFileSync(file, "x");
  assert.equal(auditOutbox(file).ok, false);
  assert.equal(auditOutbox(file).reason, "outbox_not_a_directory");
});

test("hook 往返：含单引号的路径，装两次仍然只有一条", () => {
  // 评审实测：shellQuote 把 ' 编码成 '\'' ，而 '([^']+)' 在第一个内嵌引号处就断了。
  // 于是在含 ' 的 CODEX_HOME 下连装两次，UserPromptSubmit 和 Stop **各出现 2 条**——
  // 第二次没认出第一次装的那条。
  const dir = temp();
  const codexHome = path.join(dir, "co'dex-home");     // 目录名里带单引号
  const home = path.join(dir, "bridge'home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));
  const env = { ...isolatedEnv(), CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home };
  const install = () => spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"], { encoding: "utf-8", env });

  assert.equal(install().status, 0);
  assert.equal(install().status, 0, "第二次安装");

  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf-8"));
  for (const [event, basename] of [["UserPromptSubmit", "prompt-hook.mjs"], ["Stop", "stop-hook.mjs"]]) {
    const mine = (hooks.hooks[event] ?? [])
      .flatMap((e) => (e.hooks ?? []).map((h) => h.command))
      .filter((c) => ownsHookCommand(c, basename));
    assert.equal(mine.length, 1,
      "**装两次也只能有一条**（" + event + "）：" + mine.length + " 条");
    // 往返：解析出来再造回去必须逐字相同。
    const parsed = parseHookCommand(mine[0]);
    assert.notEqual(parsed, null, "含单引号的路径必须解析得出");
    assert.equal(buildHookCommand(parsed), mine[0], "build → parse → build 要往返");
  }
});

test("doctor 比对完整期望定义 —— node/home/日志任一不对都不许算正常", () => {
  // 评审实测：把 node 换成 /definitely/missing/node、bridge home 和日志也改错，
  // doctor 仍报 hooks 正常，因为它只比 parsed.script。
  const script = "/r/current/scripts/codex/stop-hook.mjs";
  const expect = { node: "/opt/homebrew/bin/node", script, home: "/h", log: "/h/hook.log" };
  const good = buildHookCommand(expect);
  assert.equal(acceptsHookCommand(good, expect), true);

  for (const [field, value] of [["node", "/definitely/missing/node"],
    ["home", "/wrong"], ["log", "/wrong/hook.log"]]) {
    const drifted = buildHookCommand({ ...expect, [field]: value });
    assert.equal(parseHookCommand(drifted) !== null, true, "它本身仍是我们的 hook");
    assert.equal(acceptsHookCommand(drifted, expect), false,
      "**" + field + " 不对就不许算正常**");
  }
});

test("技能要逐字节比对 —— 「文件在」不等于「装对了」", () => {
  // 评审实测：安装后把 feishu-status/SKILL.md 换成陈旧内容，
  // doctor 仍报 {"name":"Codex skills","ok":true,"detail":"7 项均已安装"}。
  const dir = temp();
  const codexHome = path.join(dir, "codex-home");
  const home = path.join(dir, "bridge-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRegistry([], path.join(home, "registry.json"));
  const runtimeCurrent = path.join(codexHome, "feishu-bridge", "runtime", "current");
  assert.equal(spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"],
    { encoding: "utf-8", env: { ...isolatedEnv(), CODEX_HOME: codexHome,
      FEISHU_CODEX_BRIDGE_HOME: home } }).status, 0);

  const audit = () => auditSkills({ repoRoot: ROOT, codexHome, runtimeCurrent, bridgeHome: home });
  assert.equal(audit().ok, true, "刚装完必须逐字节一致：" + JSON.stringify(audit().problems));

  // 换成陈旧内容：文件仍在。
  const victim = path.join(codexHome, "skills", "feishu-status", "SKILL.md");
  fs.writeFileSync(victim, "---\nname: feishu-status\n---\n旧内容\n");
  const stale = audit();
  assert.equal(stale.ok, false, "**内容不对必须被发现**");
  assert.deepEqual(stale.problems.map((p) => p.skill), ["feishu-status"]);
  assert.equal(stale.problems[0].why, "内容与期望不符");

  // 非模板文件（aily-cli-skill.json）也要纳入。
  const json = path.join(codexHome, "skills", "m5codex-inbound-router", "aily-cli-skill.json");
  fs.writeFileSync(json, "{}");
  assert.ok(audit().problems.some((p) => p.file === "aily-cli-skill.json"),
    "非 SKILL.md 的文件也要比对");
});

test("launchd 核验要精确到完整参数 —— 跑 /bin/echo 的同名 job 不算数", () => {
  // 评审构造的反例：实际运行 /bin/echo、仅把期望脚本当参数的 job，
  // 子串匹配照样判成 loaded。
  const expect = { node: "/opt/homebrew/bin/node",
    args: ["/opt/homebrew/bin/node", "/r/current/scripts/codex/drain-all.mjs"] };
  const listing = (program, args) => '{\n\t"Program" = "' + program + '";\n' +
    '\t"ProgramArguments" = (\n' + args.map((a) => '\t\t"' + a + '";\n').join("") + '\t);\n};';
  const run = (text) => () => ({ ok: true, stdout: text });

  assert.equal(loadedPhase(run(listing(expect.node, expect.args)), expect), "loaded");
  assert.equal(loadedPhase(run(listing("/bin/echo", ["/bin/echo", expect.args[1]])), expect),
    "loaded_other", "**实际跑的是 /bin/echo**");
  assert.equal(loadedPhase(run(listing(expect.node, [...expect.args, "--extra"])), expect),
    "loaded_other", "多一个参数就不是我们那份");
  assert.equal(loadedPhase(run(listing(expect.node, [expect.args[0]])), expect),
    "loaded_other", "少一个参数也不是");
  assert.equal(loadedPhase(run("看不懂的输出"), expect), "unverifiable",
    "**拆不出来就说查不出来，不许当 loaded**");
});

test("plist 必须是 macOS 真的能解析的 XML", () => {
  // 字符串断言只能证明"我写的字符串里有转义"。真解析才能证明 launchd 读得进去。
  const body = plistBody({ home: "/Users/a&b/工 作 <区>/o'brien",
    node: "/opt/homebrew/bin/node" });
  const file = path.join(temp(), "t.plist");
  fs.writeFileSync(file, body);
  const r = spawnSync("plutil", ["-lint", file], { encoding: "utf-8" });
  assert.equal(r.status, 0, "**plutil 必须能解析**：" + (r.stdout + r.stderr).slice(0, 300));
});

test("hook 归属：整条锚定 —— 只提一句标记或路径的外部 hook 不许被认领", () => {
  // 评审的两个反例，一条都不许中：
  //   echo FEISHU_BRIDGE_CODEX_HOOK:prompt-hook.mjs   （提到标记）
  //   echo <runtime/current/.../stop-hook.mjs>        （提到路径）
  // 前者会被安装器删掉，后者会被 doctor 判为正常 —— 两种都是判据只做子串包含。
  const script = "/r/current/scripts/codex/stop-hook.mjs";
  const good = buildHookCommand({ node: "/opt/homebrew/bin/node", script,
    home: "/h", log: "/h/hook.log" });

  assert.equal(ownsHookCommand(good, "stop-hook.mjs"), true, "自己造的要认得出");
  assert.equal(acceptsHookCommand(good, script), true);

  for (const impostor of [
    "echo " + HOOK_TAG + "stop-hook.mjs",
    "echo " + script,
    "# " + HOOK_TAG + "stop-hook.mjs\necho 假的",
    "rg " + script,
    good + " ; rm -rf /",                       // 尾部多东西 → 不是我们的
    good.replace("/h/hook.log", "/h/hook.log' ; evil '"),
  ]) {
    assert.equal(parseHookCommand(impostor), null,
      "**不许认领**：" + impostor.slice(0, 60));
  }

  // guard 检查的脚本与实际执行的不同 → 不是我们的。
  const mismatched = good.replace(
    "'/opt/homebrew/bin/node' '" + script + "';",
    "'/opt/homebrew/bin/node' '/z/stop-hook.mjs';");
  assert.equal(parseHookCommand(mismatched), null, "guard 与执行对不上就不是我们的");

  // **专门验 acceptsHookCommand 自己那一步。**
  // 上一版这里只用"指向别的脚本"来验，而那种命令 parseHookCommand 就先拒了 ——
  // 两道守卫互相遮挡，把 accepts 改成子串包含也照样绿。
  // 这里要的是一条**parse 认可、但脚本只是前缀关系**的命令：
  // 只有"逐字相等"能分开，"包含"分不开。
  const nested = "/r/current/scripts/codex/stop-hook.mjs.bak/stop-hook.mjs";
  const nestedCmd = buildHookCommand({ node: "/opt/homebrew/bin/node", script: nested,
    home: "/h", log: "/h/hook.log" });
  assert.notEqual(parseHookCommand(nestedCmd), null, "这条本身是合法的我们的 hook");
  assert.equal(acceptsHookCommand(nestedCmd, script), false,
    "**逐字相等，不是包含** —— 命令里确实出现了 " + script + " 这个前缀");
  assert.equal(acceptsHookCommand(nestedCmd, nested), true, "它自己那条要接受");
});

test("启用门槛的链路预检必须走真实主链，不许把被测对象换掉", () => {
  // 评审实测的假绿：上一版把整个 publishEligibleTaskEvents 换成假函数，
  // 于是门槛验的是"我的假函数能被调用"。同一个 task 走真实路径是 template_unusable，
  // 门禁却报 ok。**替换掉被测对象的检查等于没有检查。**
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "abc123" });
  task.logical_task_key = "k";
  task.id = "k";
  writeRegistry([task], path.join(home, "registry.json"));

  // 没有 chain-config.json → 真实预检必然 template_unusable。
  const scanned = scanRunnable({ home });
  assert.equal(scanned.ok, false, "真实链路跑不通就必须报跑不通");
  assert.match(scanned.reason, /template_unusable/u, "要说清是哪一步不通");
  assert.equal(enableBlockers({ runtimeOk: true, scan: scanned,
    backlog: { ok: true, total: 0, unreadable: 0 } }).length, 1, "跑不通就要拦");

  // 预检成功时不拦。
  const okScan = { ok: true, tasks: 1 };
  assert.deepEqual(enableBlockers({ runtimeOk: true, scan: okScan,
    backlog: { ok: true, total: 0, unreadable: 0 } }), []);
});

test("坏 JSON 不许把积压数成 0 —— 读不出来不等于没有", () => {
  // 评审实测：outbox 里全是坏 JSON 时，listPending 静默跳过，
  // 积压被统计成 0，门槛放行，定时器装上 —— 而那些文件是什么谁也不知道。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(home, "registry.json"));
  const outbox = taskPaths(task, home).outbox;
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, "0001.json"), "{ 这不是 JSON");

  const backlog = classifyBacklog({ home });
  assert.equal(backlog.ok, true);
  assert.equal(backlog.total, 0, "坏文件确实不算待发");
  assert.equal(backlog.unreadable, 1, "**但必须被数出来**");
  const blockers = enableBlockers({ runtimeOk: true, scan: { ok: true },
    backlog });
  assert.equal(blockers.length, 1, "有读不出来的文件就要拦");
  assert.equal(blockers[0].code, "backlog_corrupt");
});

test("同名旧 job 还在跑时不许报「已加载」", () => {
  // 评审实测：先写新 plist 再 bootstrap，失败时 plist 留在原地；
  // 若旧的同名 job 还在 launchd 里，只看 label 存在就会报"已加载，正在按计划跑"——
  // 实际跑的是旧配置。
  // 期望现在是完整的 { node, args }，不再是一个脚本路径 ——
  // 只比脚本路径挡不住"实际跑 /bin/echo、把脚本当参数"那种 job。
  const expect = { node: "/n", args: ["/n", "/new/drain-all.mjs"] };
  const listing = (program, args) => '{\n\t"Program" = "' + program + '";\n' +
    '\t"ProgramArguments" = (\n' + args.map((a) => '\t\t"' + a + '";\n').join("") + '\t);\n};';
  const fake = (text) => () => ({ ok: true, stdout: text });
  assert.equal(loadedPhase(fake(listing("/n", ["/n", "/new/drain-all.mjs"])), expect), "loaded");
  assert.equal(loadedPhase(fake(listing("/n", ["/n", "/OLD/clone/drain-outbox.mjs"])), expect),
    "loaded_other", "**参数不是当前这份就不许说已加载**");
  assert.equal(loadedPhase(() => ({ ok: false, detail: "could not find service" }), expect),
    "installed_not_loaded");
  assert.equal(loadedPhase(() => ({ ok: false, detail: "权限不足" }), expect),
    "unverifiable", "查不出来就说查不出来");
});

test("plist 里的路径必须 XML 转义", () => {
  // 家目录里一个 & 就足以让整份 plist 变成非法 XML：launchd 加载失败，
  // 而"写文件"那一步是成功的。含空格和中文的路径这个仓库已经栽过一次（那次是 shell 引号）。
  const body = plistBody({ home: "/Users/a&b/工 作 <区>", node: "/opt/homebrew/bin/node" });
  // 只查 <string> 里的**值**——plist 本身当然到处是尖括号。
  const values = [...body.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((m) => m[1]);
  assert.ok(values.length > 0, "得真的取到值才算数");
  for (const v of values) {
    assert.doesNotMatch(v.replace(/&(amp|lt|gt);/gu, ""), /[&<>]/u,
      "值里不许有裸的 & < >：" + v);
  }
  assert.ok(body.includes("&amp;"), "& 要转义");
  assert.ok(body.includes("&lt;区&gt;"), "< > 要转义");
  assert.ok(body.includes("工 作"), "空格和中文原样保留");
});

test("launchd 加载失败必须非零退出 —— 不许报成「已启用」", () => {
  // **兜底是最后一道，它悄悄不工作没有第二处会发现。**
  // plist 写了但 bootstrap 失败时报成功，就是"界面说正常、实际不跑"。
  const dir = temp();
  const fakeHome = path.join(dir, "home");
  const codexHome = path.join(dir, "codex-home");
  const bridge = path.join(dir, "bridge");
  const bin = path.join(dir, "bin");
  for (const d of [fakeHome, codexHome, bridge, bin]) fs.mkdirSync(d, { recursive: true });
  writeRegistry([], path.join(bridge, "registry.json"));      // 空 → 积压门槛过

  // 假 launchctl：list 说没有，bootstrap 失败。**不碰真机的 launchd。**
  fs.writeFileSync(path.join(bin, "launchctl"),
    '#!/bin/sh\ncase "$1" in\n  list) echo "could not find service" >&2; exit 113;;\n' +
    '  bootstrap) echo "Load failed: 5: Input/output error" >&2; exit 5;;\nesac\nexit 0\n',
    { mode: 0o700 });

  const env = { ...isolatedEnv(), HOME: fakeHome, PATH: bin + path.delimiter + process.env.PATH,
    CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: bridge };
  // 先把运行时装好，否则会卡在运行时那道门槛上，测不到我们要测的东西。
  const installed = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "install.mjs"), "--apply"], { encoding: "utf-8", env });
  assert.equal(installed.status, 0, installed.stderr);

  const realAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  const before = fs.existsSync(realAgents) ? fs.readdirSync(realAgents).sort().join(",") : "";

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "drain-service.mjs"), "--enable", "--apply"],
    { encoding: "utf-8", env });

  assert.notEqual(r.status, 0,
    "**加载失败必须非零退出**：" + r.stdout + r.stderr);
  assert.match(r.stderr, /加载失败/u, "要说清是加载失败，不是别的");
  assert.doesNotMatch(r.stdout, /已启用，定时器已加载/u,
    "没加载成功就不许说已加载");

  // 真机的 LaunchAgents 一个字节都不许动。
  const after = fs.existsSync(realAgents) ? fs.readdirSync(realAgents).sort().join(",") : "";
  assert.equal(after, before, "给了 HOME 还往真机的 LaunchAgents 写");
});

test("兜底扫描：逐 task 走 eligible-only，一个失败不许拖垮其他", () => {
  // 兜底的价值就在于它是最后一道。一条坏记录让整轮扫描中断，等于没有兜底。
  // **publish 是注入的 —— 测试不许打到真实飞书。**
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const mk = (key, thread) => {
    const t = makeTaskEntry({ root, threadId: thread, name: key,
      rootMessageId: "om_" + key, token: "abc123" });
    t.logical_task_key = key;
    t.id = key;
    return t;
  };
  writeRegistry([mk("a", THREAD_A), mk("b", THREAD_B)], path.join(home, "registry.json"));

  const seen = [];
  const swept = sweepEligible({
    home,
    publish: ({ task }) => {
      seen.push(task.logical_task_key);
      if (task.logical_task_key === "a") throw new Error("这条炸了");
      return { status: "published", count: 2 };
    },
  });

  assert.equal(swept.ok, true);
  assert.deepEqual(seen, ["a", "b"], "**第一个抛了，第二个仍然要跑**");
  assert.equal(swept.errors.length, 1);
  assert.equal(swept.errors[0].key, "a");
  assert.equal(swept.errors[0].reason, "threw");
  assert.equal(swept.tally.published, 1, "没炸的那个照常发");

  // 登记表**坏了**（不是"不存在"）→ 明确失败，不许报成"扫了 0 个 task"。
  // 文件不存在是合法的"还没有 task"，新装机器本来就这样；坏文件才是故障。
  const badHome = temp();
  fs.writeFileSync(path.join(badHome, "registry.json"), "{ 这不是 JSON");
  const broken = sweepEligible({ home: badHome });
  assert.equal(broken.ok, false, "**读不出来不等于没有** —— 报成 0 条就会静默空转");
  assert.equal(broken.reason, "registry_unreadable");
});

test("调度器：历史积压没分类时拒绝启用，且一条都不写", () => {
  // **这条是这条命令存在的主要理由。**Codex 链一直没有兜底定时器，
  // outbox 里攒着一批历史内容；装上定时器的那一刻它们会被发出去。
  // 省掉这道门槛就是替人做了一个不可逆的决定。
  const home = temp();
  const bridge = path.join(home, "bridge");
  fs.mkdirSync(bridge, { recursive: true });
  const root = path.join(home, "project");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "S",
    rootMessageId: "om_root", token: "abc123" });
  writeRegistry([task], path.join(bridge, "registry.json"));
  const paths = taskPaths(task, bridge);
  fs.mkdirSync(paths.outbox, { recursive: true });

  // 空 outbox：分类这一关不该拦。
  const empty = classifyBacklog({ home: bridge });
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 0);
  assert.deepEqual(enableBlockers({ runtimeOk: true, backlog: empty }), [],
    "没有积压时不该有任何门槛");

  // 有一条待发：必须拦。
  fs.writeFileSync(path.join(paths.outbox, "0001.json"),
    JSON.stringify({ kind: "milestone", text: "历史内容", published_at: null }));
  const withBacklog = classifyBacklog({ home: bridge });
  assert.equal(withBacklog.total, 1);
  assert.equal(withBacklog.tasks.length, 1);
  const blockers = enableBlockers({ runtimeOk: true, backlog: withBacklog });
  assert.equal(blockers.length, 1, "有积压就必须拦");
  assert.equal(blockers[0].code, "backlog_unclassified");

  // 运行时校验不过也要拦，而且**两条要一起报**，不是只报第一条。
  const both = enableBlockers({ runtimeOk: false, runtimeReason: "current_absent",
    backlog: withBacklog });
  assert.equal(both.length, 2, "两条门槛都不过就要一次说清，别让人来回试");
  assert.deepEqual(both.map((b) => b.code).sort(),
    ["backlog_unclassified", "runtime_unverified"]);

  // 登记表读不出来 → 也拦，而且不能报成"没有积压"。
  const unreadable = enableBlockers({ runtimeOk: true,
    backlog: { ok: false, reason: "registry_unreadable" } });
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].code, "backlog_unreadable",
    "**读不出来不等于没有** —— 报成 0 条就会放行");
});

test("调度器指向的必须是 runtime/current，不是任何开发克隆", () => {
  // 定时器一装就长期存在。让它指向某个开发克隆，等于把线上行为长期绑在
  // 某人的工作目录上 —— 那正是这次迁移要消灭的东西。
  const home = temp();
  const script = drainScriptPath(home);
  assert.match(script,
    /\.codex\/feishu-bridge\/runtime\/current\/scripts\/codex\/drain-all\.mjs$/u);
  const body = plistBody({ home, node: "/opt/homebrew/bin/node" });
  assert.ok(body.includes(script), "plist 里跑的必须是这个路径");
  assert.doesNotMatch(body, /claude-projects|codex-projects/u,
    "**plist 里不许出现任何开发克隆路径**");
  // **不再传 --all。**drain-outbox 根本不支持它：拿到 --all 会打一行
  // "找不到目标 task" 然后 exit 0 —— 定时器每 30 分钟静默空转，
  // 而外部看起来一切正常。现在跑的是真正的机器级 eligible-only 扫描入口。
  assert.doesNotMatch(body, /<string>--all<\/string>/u,
    "--all 是个不存在的用法，不许再出现在 plist 里");
  assert.ok(body.includes("drain-all.mjs"),
    "跑的必须是逐 task 的 eligible-only 扫描入口");
  assert.ok(body.includes("<key>RunAtLoad</key><false/>"),
    "装上不等于立刻跑一次");
});

test("空白目标代际是损坏记录 —— Codex 侧守着同一条三态判定", () => {
  // 判据分家的后果两条链是共享的：核心一放松，两边同时漏。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-corrupt-"));
  const obDir = path.join(dir, "outbox");
  fs.mkdirSync(obDir, { recursive: true });
  const rec = path.join(obDir, "0001.json");
  const genLock = path.join(dir, "gen.lock");
  const pubLock = path.join(dir, "pub.lock");
  const call = (target) => {
    fs.writeFileSync(rec, JSON.stringify({ kind: "progress", text: "x", published_at: null,
      ...(target === undefined ? {} : { target_channel_generation_id: target }) }));
    return applySuppressionCore({
      outboxDir: obDir, publishLockDir: pubLock, generationLockDir: genLock,
      pending: [{ _file: rec, ...(target === undefined ? {} : { target_channel_generation_id: target }) }],
      previewGenerationId: null,
      readState: () => ({ activeGeneration: "gen-1", select: (x) => x }), reason: "t",
    });
  };
  for (const bad of ["   ", "", 7, {}]) {
    const got = call(bad);
    assert.equal(got.ok, false, "损坏目标不许放行：" + JSON.stringify(bad));
    assert.equal(got.reason, "corrupt_target_generation");
    assert.equal(JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at, undefined,
      "一条都不许动");
    assert.equal(fs.existsSync(genLock), false, "拒绝发生在拿锁之前");
    assert.equal(fs.existsSync(pubLock), false, "发布锁也没拿");
  }
  assert.equal(call(undefined).reason, "generation_expectation_required", "缺失=合法旧格式");
  assert.equal(call("gen-1").ok, true, "自带可用代际该照常抑制");
});

test("「锁没拿」要证明从未获取 —— Codex 侧同样预先持锁验一次", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-prelock-"));
  const obDir = path.join(dir, "outbox");
  fs.mkdirSync(obDir, { recursive: true });
  const rec = path.join(obDir, "0001.json");
  fs.writeFileSync(rec, JSON.stringify({ kind: "progress", text: "旧格式", published_at: null }));
  const genLock = path.join(dir, "gen.lock");
  const pubLock = path.join(dir, "pub.lock");
  const hold = (d) => {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "owner.json"),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  };
  const call = () => applySuppressionCore({
    outboxDir: obDir, publishLockDir: pubLock, generationLockDir: genLock,
    pending: [{ _file: rec }], previewGenerationId: null,
    readState: () => ({ activeGeneration: "gen-1", select: (x) => x }), reason: "t",
  });
  hold(genLock);
  assert.equal(call().reason, "generation_expectation_required",
    "代际锁被别人持着也该报缺 expectation —— 报 rotation_busy 就说明它先去抢锁了");
  fs.rmSync(genLock, { recursive: true, force: true });
  hold(pubLock);
  assert.equal(call().reason, "generation_expectation_required",
    "发布锁被别人持着也一样");
  assert.equal(JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at, undefined);
  assert.ok(fs.existsSync(pubLock), "别人的锁不许被顺手删掉");
});

test("核心不变量：旧格式记录缺 expectation 一律拒绝 —— Codex 侧也守着同一条", () => {
  // **这条直接打核心，不经 CLI。**包装层自己也有一道前置检查，于是把核心那道
  // 守卫拆掉时，走 CLI 的测试照样绿 —— 包装层先拦下了。
  // 两条链共享的是核心，那这条不变量就必须在两边各有一个直接的守卫：
  // 退回"允许 null"时，两侧要同时变红。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-core-inv-"));
  const obDir = path.join(dir, "outbox");
  const genLock = path.join(dir, "gen.lock");
  fs.mkdirSync(obDir, { recursive: true });
  const rec = path.join(obDir, "0001.json");
  fs.writeFileSync(rec, JSON.stringify({ kind: "progress", text: "旧格式", published_at: null }));
  const call = (previewGenerationId) => applySuppressionCore({
    outboxDir: obDir, publishLockDir: path.join(dir, "pub.lock"),
    generationLockDir: genLock,
    pending: [{ _file: rec }], previewGenerationId,
    readState: () => ({ activeGeneration: "gen-1", select: (r) => r }),
    reason: "t",
  });

  for (const missing of [null, undefined, "", "   "]) {
    const got = call(missing);
    assert.equal(got.ok, false, "缺 expectation 不许放行：" + JSON.stringify(missing));
    assert.equal(got.reason, "generation_expectation_required");
  }
  assert.equal(JSON.parse(fs.readFileSync(rec, "utf-8")).publish_suppressed_at, undefined,
    "被拒时一条都不许动");
  assert.equal(fs.existsSync(genLock), false, "拒绝发生在拿锁之前，不许留代际锁");
  assert.equal(fs.existsSync(path.join(dir, "pub.lock")), false, "也不许留发布锁");

  const ok = call("gen-1");
  assert.equal(ok.ok, true, "带了就该放行：" + (ok.reason ?? ""));
  assert.equal(ok.done.changed, 1);
});

test("Codex 抑制命令：目标和范围都必须显式给", () => {
  // **有损操作的默认值不该是"最大范围"。**上一版不传 --generation 就作用于整个
  // outbox；同时传 --thread-id 和 --task-key 会静默择一 ——
  // 两条都是"少说一句话就扩大破坏范围"，而这个动作不可逆。
  assert.equal(checkArgShape(new Map([["thread-id", "t"], ["task-key", "k"],
    ["generation", "g"]])).reason, "target_ambiguous");
  assert.equal(checkArgShape(new Map([["generation", "g"]])).reason, "target_missing");
  assert.equal(checkArgShape(new Map([["thread-id", "t"]])).reason, "scope_missing");
  assert.equal(checkArgShape(new Map([["thread-id", "t"], ["generation", "g"],
    ["all-generations", true]])).reason, "scope_conflict");
  assert.equal(checkArgShape(new Map([["thread-id", "t"], ["generation", "g"]])).ok, true);
  assert.equal(checkArgShape(new Map([["task-key", "k"], ["all-generations", true]])).ok, true);

  // 真实入口：歧义命令必须非零退出，且 outbox 一个字节不变。
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "Sup2",
    rootMessageId: "om_root", token: "abc124" });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify(TEMPLATE));
  writeRegistry([task], path.join(home, "registry.json"));
  const paths = taskPaths(task, home);
  fs.mkdirSync(paths.outbox, { recursive: true });
  const rec = path.join(paths.outbox, "0001.json");
  const body = JSON.stringify({ kind: "progress", text: "x", published_at: null });
  fs.writeFileSync(rec, body);

  const cli = path.join(ROOT, "scripts", "codex", "suppress-outbox.mjs");
  for (const args of [
    ["--thread-id", THREAD_A, "--apply"],                                  // 没给范围
    ["--thread-id", THREAD_A, "--task-key", "k", "--all-generations", "--apply"],
    ["--thread-id", THREAD_A, "--generation", "g", "--all-generations", "--apply"],
    ["--all-generations", "--apply"],                                      // 没给目标
  ]) {
    const r = spawnSync(process.execPath, [cli, ...args],
      { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
    assert.notEqual(r.status, 0, args.join(" ") + " 竟然被接受了");
    assert.equal(fs.readFileSync(rec, "utf-8"), body, args.join(" ") + "：outbox 不许被动");
  }
});

test("积压查看：读不出来绝不能显示成「没有积压」", () => {
  // **这个命令服务的是一个不可逆决定。**上一版直接用 listPending，
  // 而它把目录错误吞成 []、把坏 JSON 静默跳过 —— 复审实测：放个坏文件进去，
  // CLI 照样 exit 0 说"所有 task 的 outbox 都是空的"。
  // 一份假的"没有积压"会让人放心地授权抑制。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "示例 task",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "0001.json"), "{ 这不是 JSON");

  const got = collectBacklog({ home });
  assert.equal(got.ok, true);
  assert.equal(got.tasks.length, 1, "**读不出来的 task 必须出现在报告里**");
  assert.equal(got.tasks[0].unclassified.length, 1);
  assert.deepEqual(got.tasks[0].unclassified.map((u) => u.file), ["0001.json"], "要点名");

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.notEqual(r.status, 0, "**说不清就必须非零退出**");
  assert.match(r.stdout + r.stderr, /0001\.json/u);
  assert.equal(/都是空的/u.test(r.stdout), false, "不许说成空的");
});

test("积压查看：点名一条不存在的 task 是错误，不是「没有积压」", () => {
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  writeRegistry([makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" })], path.join(home, "registry.json"));

  assert.equal(collectBacklog({ home, taskKey: "no-such-key" }).reason, "task_not_found");
  assert.equal(collectBacklog({ home, threadId: THREAD_B }).reason, "task_not_found");

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs"), "--task-key", "no-such-key"],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.notEqual(r.status, 0);
  assert.equal(/没有积压[^—]/u.test(r.stdout), false, "不许把「找不到」说成「没有积压」");
});

test("积压查看：记录层和 task 层分开说，不编原因", () => {
  // 上一版把两层混在一句里：task 已暂停时，每条记录仍显示"等待下一次排空" ——
  // 那是编出来的。**混层就会编。**
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  task.auto_publish_on_completion = false;             // task 层：没开自动发布
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "0001.json"), JSON.stringify({
    kind: "reply", text: "就绪的那条", published_at: null,
    publish_eligible_at: new Date().toISOString(), created_at: new Date().toISOString(),
  }));

  const t = collectBacklog({ home }).tasks[0];
  // **记录层只说记录**：它自己是就绪的。
  assert.equal(t.records[0].state, "ready");
  assert.equal(/排空|等待/u.test(t.records[0].why), false, "记录层不许编发布时机");
  // **task 层单独说**，而且说的是真原因。
  assert.equal(t.taskState.ok, false);
  assert.match(t.taskState.text, /没有开启自动发布/u);
});

test("积压查看：有损坏记录时不给抑制命令 —— 那条命令一定会被拒", () => {
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  const base = { kind: "reply" };
  fs.writeFileSync(path.join(ob, "0001.json"),
    JSON.stringify(outboxRecord({ ...base, text: "好的" })));

  // 全好 → 给命令，而且**必须是真能跑的**：非 locator 的 --task-key + 引号。
  const good = collectBacklog({ home }).tasks[0];
  const cmd = suppressCommandFor(good);
  assert.ok(cmd, "干净的一批要给出处置命令");
  assert.match(cmd, /--task-key /u);
  assert.equal(cmd.includes("<"), false, "**不许留占位符** —— 占位符不是可执行命令");
  assert.equal(cmd.includes(THREAD_A), false, "不许把 thread id 写进命令");
  assert.match(cmd, /'/u, "路径要加引号");

  // 加一条损坏的 → **不给命令**（抑制对这种情况整批拒绝）。
  fs.writeFileSync(path.join(ob, "0002.json"),
    JSON.stringify({ ...base, text: "坏的", target_channel_generation_id: "   " }));
  const bad = collectBacklog({ home }).tasks[0];
  assert.equal(suppressCommandFor(bad), null, "有损坏记录就不许给注定被拒的命令");

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.equal(/suppress-outbox\.mjs/u.test(r.stdout), false, "有损坏记录时不许打印抑制命令");
  assert.match(r.stdout, /整批拒绝/u, "要说明为什么没有出路");
});

test("积压查看：只读 —— 真实 CLI 跑完一个字节都不许变", () => {
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "0001.json"), JSON.stringify(outboxRecord({
    kind: "reply", text: "很久以前的一条答复",
    created_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
  })));
  const before = fs.readdirSync(ob).map((f) => fs.readFileSync(path.join(ob, f), "utf-8"));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /很久以前/u, "要能看到内容");
  assert.match(r.stdout, /5 天前/u);
  assert.deepEqual(fs.readdirSync(ob).map((f) => fs.readFileSync(path.join(ob, f), "utf-8")),
    before, "**查看命令一个字节都不许改**");

  // 拼错的参数、同时给两个选择器 —— 都不许静默退化。
  const bad = (...a) => spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs"), ...a],
    { encoding: "utf-8", env: isolatedEnv({ FEISHU_CODEX_BRIDGE_HOME: home }) }).status;
  assert.notEqual(bad("--thread--id", THREAD_A), 0);
  assert.notEqual(bad("--thread-id", THREAD_A, "--task-key", "k"), 0);
});

test("积压查看：没有发布资格 + 目标已经没了 —— 不许只说「尚未取得发布资格」", () => {
  // 评审：先返回 not_eligible 再谈目标，于是一条"永远发不出去"的历史积压
  // 只显示"尚未取得发布资格"，听起来像等等就好。
  // **最该被看见的那一类被藏得最深** —— 它正是人要决定清不清的那种。
  const gone = describeRecordState(
    { id: "e1", kind: "reply", text: "x", created_at: "2026-08-20T00:00:00.000Z",
      target_channel_generation_id: "channel_generation_" + "f".repeat(24) },
    { resolveTarget: () => ({ ok: false, reason: "generation_not_found" }) });
  assert.equal(gone.code, "target_gone", "**目标没了优先于资格**");
  assert.match(gone.text, /永远发不出去/u);
  assert.match(gone.text, /还没取得发布资格/u, "资格那一维也要照说，只是不能盖住前者");

  // 目标还在、只是没资格 —— 那才是真的"等等就好"。
  const waiting = describeRecordState(
    { id: "e2", kind: "reply", text: "x", created_at: "2026-08-20T00:00:00.000Z" },
    { resolveTarget: () => ({ ok: true }) });
  assert.equal(waiting.code, "not_eligible");
  assert.match(waiting.text, /目标话题还在/u);
});

test("可解释判据：id 纯空白不算 id", () => {
  // 评审实测：id:"   " 通过长度检查，该记录 unexplainable:[]，随后被成功抑制。
  // 生产入口生成的 id 不可能是纯空白。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-blankid-"));
  fs.writeFileSync(path.join(dir, "0001.json"), JSON.stringify({ ...outboxRecord(), id: "   " }));
  fs.writeFileSync(path.join(dir, "0002.json"), JSON.stringify({ ...outboxRecord(), id: "" }));
  fs.writeFileSync(path.join(dir, "0003.json"), JSON.stringify(outboxRecord()));
  const bad = new Set((auditOutbox(dir).unexplainable ?? []).map((u) => u.file));
  assert.ok(bad.has("0001.json"), "**纯空白 id 不算 id**");
  assert.ok(bad.has("0002.json"));
  assert.equal(bad.has("0003.json"), false, "正常的不许误伤");
});

test("处置命令要真能跑：含空格和单引号的路径，交给真实 /bin/sh -c", () => {
  // **这条测试我弄丢过一次。**
  //
  // 它在第 3 轮加进来，第 6 轮我重写查看命令时把它换成了形状断言
  // （`assert.match(cmd, /'/u, "路径要加引号")`）—— 而"字符串里有引号"
  // 恰恰是我自己在第 3 轮写下的反面教材：**断言它像命令，不等于它能跑。**
  // 拆分时用全历史比对才发现少了这条，补回来。
  //
  // 仓库为这类事付过账：经符号链接执行、含空格的 HOME、真 shell 执行 ——
  // 三种场景各自都让全绿的套件漏掉过线上故障。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cx don't-"));   // 空格 + 单引号
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "0001.json"), JSON.stringify(outboxRecord({
    kind: "reply", text: "一条" })));

  const entry = collectBacklog({ home }).tasks[0];
  const cmd = suppressCommandFor(entry);
  assert.ok(cmd, "干净的一批要给出命令");

  // **交给真 shell 跑。**只要求它不是"命令找不到 / 语法错" ——
  // 抑制本身会因为缺 --expect-digest 之类而拒绝，那是它该做的事。
  const r = spawnSync("/bin/sh", ["-c", cmd],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.notEqual(r.status, 127, "**127 = shell 没找到命令**，说明路径被空格拆词了");
  assert.equal(/not found|No such file|syntax error|unexpected/u.test(r.stderr), false,
    "shell 层不许报错：" + r.stderr.slice(0, 200));
  assert.match(r.stdout + r.stderr, /task|待发|outbox/u,
    "命令应该真的执行到了脚本里：" + (r.stdout + r.stderr).slice(0, 200));
});

test("审计：只有目录不存在才算空，读不出来必须说出来", () => {
  // 变异验证抓到的缺口：这一层原本没有测试盯着"读不出来"这条分支 ——
  // 把 ENOENT 判断改成恒真（任何读取错误都当成空），套件照样绿。
  // **"读不出来"和"是空的"是两件事**：前者说不清目录里有什么，
  // 而下游会拿这个结论去做不可逆的事。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cx-auditread-"));

  // ① 目录不存在 = 还没发过东西，合法的空。
  const none = auditOutbox(path.join(base, "never-existed"));
  assert.equal(none.ok, true, "不存在是合法的空");
  assert.equal(none.pending, 0);

  // ② 路径是文件而不是目录 → **说不清，必须拦住**。
  const asFile = path.join(base, "outbox-as-file");
  fs.writeFileSync(asFile, "我不是目录");
  const notDir = auditOutbox(asFile);
  assert.equal(notDir.ok, false, "**不是目录不许报成空**");
  assert.equal(notDir.reason, "outbox_not_a_directory");

  // ③ 目录不可读（权限）→ 同样不许报成空。
  const noRead = path.join(base, "outbox-noread");
  fs.mkdirSync(noRead);
  fs.writeFileSync(path.join(noRead, "0001.json"), JSON.stringify(outboxRecord()));
  fs.chmodSync(noRead, 0o000);
  try {
    const denied = auditOutbox(noRead);
    // root 跑测试时读得动，那就跳过这一档 —— 但不许静默当成通过。
    if (denied.ok === true) {
      assert.equal(denied.pending, 1, "读得动就该看到那一条，而不是报空");
    } else {
      assert.equal(denied.reason, "outbox_unreadable", "**读不出来不许报成空**");
    }
  } finally {
    fs.chmodSync(noRead, 0o700);
  }

  // 统一守卫对这两种都要给出阻断结论。
  assert.equal(outboxMutationBlocker(notDir)?.reason, "outbox_not_a_directory");
  assert.equal(outboxMutationBlocker(none), null, "合法的空不许被拦");
});


test("登记表读取：结构坏掉要 fail-closed，不许抛也不许静默成空表", () => {
  // 两件事一起守：
  // ① 顶层结构异常（根节点 null / 数组 / 字符串、tasks 不是数组）——
  //    上一版会抛 TypeError 或被读成"正常的空表"。
  // ② 逐条畸形（null / 字符串 / 缺 root / 缺 key）—— 上一版直接 continue，
  //    最终返回 ok:true 加一张空表。
  //
  // **静默过滤等于把「表坏了」说成「表是空的」** —— 人会去重新绑定，
  // 而真正该做的是看一眼这张表。
  const write = (body) => {
    const home = temp();
    const f = path.join(home, "registry.json");
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    return f;
  };

  for (const [name, body] of [
    ["根节点 null", "null"],
    ["根节点是数组", "[]"],
    ["根节点是字符串", JSON.stringify("nope")],
    ["tasks 不是数组", { tasks: {} }],
  ]) {
    let reg;
    assert.doesNotThrow(() => { reg = loadRegistry(write(body)); }, name + "：**不许抛**");
    assert.equal(reg.ok, false, name + "：不许当成读得通");
    assert.equal(reg.reason, "registry_malformed", name);
  }

  for (const [name, tasks] of [
    ["null 条目", [null]],
    ["字符串条目", ["x"]],
    ["缺 root/key", [{ foo: "bar" }]],
    ["root 不是绝对路径", [{ root: "relative", logical_task_key: "k" }]],
  ]) {
    const reg = loadRegistry(write({ tasks }));
    assert.equal(reg.ok, false, name + "：**不许静默过滤成空表**");
    assert.equal(reg.reason, "registry_malformed", name);
    assert.ok(reg.detail?.includes("#0"), name + "：要带索引，人才知道看第几条");
  }

  // 显式停用的条目仍然照常跳过 —— 那是合法状态，不是畸形。
  assert.equal(loadRegistry(write({ tasks: [{ enabled: false }] })).ok, true, "停用不算畸形");
  // 正常表照常读得出来。
  const good = write({ tasks: [{ root: "/tmp/x", logical_task_key: "k" }] });
  assert.equal(loadRegistry(good).ok, true);
  assert.equal(loadRegistry(good).tasks.length, 1);
});


test("统一守卫要看得见损坏的目标代际 —— 不许靠查看器自己再查一次", () => {
  // 评审实测：一条字段齐全的记录只要把 target_channel_generation_id 写成纯空白，
  // auditOutbox 报干净、outboxMutationBlocker 返回 null；
  // **查看器之所以拦住，是因为它自己又查了一次 state === "corrupt"** ——
  // 所谓"唯一守卫"实际上是两份判据。判据现在下沉到 topic-generation。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-corrupt-audit-"));
  fs.writeFileSync(path.join(dir, "0001.json"),
    JSON.stringify(outboxRecord({ target_channel_generation_id: "   " })));

  const audit = auditOutbox(dir);
  assert.equal(audit.unexplainable.length, 1, "**审计自己就要看见它**");
  assert.match(audit.unexplainable[0].why, /target_channel_generation_id/u);
  assert.notEqual(outboxMutationBlocker(audit), null, "**守卫必须给出阻断结论**");
  assert.equal(outboxMutationBlocker(audit).reason, "outbox_unexplainable");

  const rec = JSON.parse(fs.readFileSync(path.join(dir, "0001.json"), "utf-8"));
  assert.equal(generationTargetState(rec), "corrupt");
  assert.ok(explainabilityGaps(rec).includes("target_channel_generation_id"));

  fs.writeFileSync(path.join(dir, "0001.json"), JSON.stringify(outboxRecord({
    target_channel_generation_id: "channel_generation_" + "a".repeat(24) })));
  assert.deepEqual(auditOutbox(dir).unexplainable, []);
  assert.equal(outboxMutationBlocker(auditOutbox(dir)), null);
});

test("查看器的授权判据只有一份：不许一边说解释不了、一边说已就绪", () => {
  // 评审实测：对 publish_eligible_at:"not-a-canonical-time"
  //   hasPublishAuthorization=false / explainabilityGaps 点名 / describeRecordState=ready
  // **同一个 CLI 给出两个相反的结论。**
  const malformed = { id: "e1", kind: "reply", text: "x",
    created_at: "2026-08-20T00:00:00.000Z", publish_eligible_at: "not-a-canonical-time" };
  const state = describeRecordState(malformed, { resolveTarget: () => ({ ok: true }) });
  assert.notEqual(state.code, "ready", "**畸形授权不许显示成已就绪**");
  assert.equal(state.code, "auth_malformed");
  assert.match(state.text, /需要人看/u, "要跟「还没轮到它」分开说");
  assert.equal(hasPublishAuthorization(malformed), false);
  assert.ok(explainabilityGaps(malformed).includes("publish_eligible_at"));

  const notYet = { ...malformed, publish_eligible_at: null };
  assert.equal(describeRecordState(notYet, { resolveTarget: () => ({ ok: true }) }).code,
    "not_eligible");
  const ready = { ...malformed, publish_eligible_at: new Date().toISOString() };
  assert.equal(describeRecordState(ready, { resolveTarget: () => ({ ok: true }) }).code, "ready");
});

test("登记表：两个 task 不许落到同一个存储目录", () => {
  // 评审实测：a/b 和 a?b 都被 safeKey 换成 a_b，
  // **两条 task 的 outbox 和锁混在一起**，而登记表照样 ok。
  const home = temp();
  const f = path.join(home, "registry.json");
  fs.writeFileSync(f, JSON.stringify({ tasks: [
    { root: "/tmp/a", logical_task_key: "a/b" },
    { root: "/tmp/b", logical_task_key: "a?b" },
  ] }));
  const reg = loadRegistry(f);
  assert.equal(reg.ok, false, "**不许放行**");
  assert.equal(reg.reason, "registry_malformed");
  assert.match(reg.detail, /非法字符/u, "要说清是字符集的问题");

  fs.writeFileSync(f, JSON.stringify({ tasks: [
    { root: "/tmp/a", logical_task_key: "Task-A_1" },
    { root: "/tmp/b", logical_task_key: "Task-B_2" },
  ] }));
  assert.equal(loadRegistry(f).ok, true);
  assert.equal(loadRegistry(f).tasks.length, 2);
});

test("查看内容不许带终端控制序列 —— 它服务的是不可逆决定", () => {
  // 评审实测：清屏序列原样进了输出。outbox 正文是模型生成的，
  // 而这个视图是人用来决定要不要永久停掉内容的。
  // 一段内容能清屏、移光标、伪造后面的提示行，人看到的就不是实际存在的东西。
  const ESC = String.fromCharCode(27);
  const BIDI = String.fromCharCode(0x202e);
  const evil = "正常开头" + ESC + "[2J" + ESC + "[H伪造的提示" + BIDI + "reversed";
  const clean = sanitizeForDisplay(evil);
  for (const ch of [ESC, BIDI, String.fromCharCode(0)]) {
    assert.equal(clean.includes(ch), false, "控制符漏出去了：" + JSON.stringify(ch));
  }
  assert.match(clean, /正常开头/u, "可见内容要留着");
  assert.ok(clean.includes(String.fromCharCode(0xfffd)),
    "**换成占位符而不是删掉** —— 「这里原本有东西」是信息");

  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A,
    name: "名字里也有" + ESC + "[31m颜色", rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "0001.json"), JSON.stringify(outboxRecord({
    kind: "reply", text: evil })));
  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(r.stdout.includes(ESC), false, "**stdout 里不许有 ESC**");
  assert.equal(r.stdout.includes(BIDI), false);
});

test("登记表的精确诊断要到得了用户手上", () => {
  // 上一版查看层把所有失败都改写成 registry_unreadable，
  // 登记表那层刚做出来的"结构坏了、第几条坏了"到不了用户。
  const home = temp();
  fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({ tasks: [null] }));
  const got = collectBacklog({ home });
  assert.equal(got.ok, false);
  assert.equal(got.reason, "registry_malformed", "**不许压扁成 registry_unreadable**");
  assert.ok(got.detail?.includes("#0"), "索引要透传");

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /结构不对/u);
  assert.match(r.stderr, /#0/u, "人要知道看第几条");
});


test("存储键按大小写折叠判重，id 不许跟 key 分叉", () => {
  // 评审实测两处：
  // ① 本机默认大小写不敏感：Task-A 与 task-a 通过校验，**却指向同一个 inode**，
  //    outbox 和锁照样混在一起 —— 字符串相等挡不住文件系统的等价关系。
  // ② 读取端原样保留已有 id：两条不同 key、相同 id 的 task，
  //    binding_id 会撞成同一个。
  const write = (tasks) => {
    const home = temp();
    const f = path.join(home, "registry.json");
    fs.writeFileSync(f, JSON.stringify({ tasks }));
    return f;
  };

  const folded = loadRegistry(write([
    { root: "/tmp/a", logical_task_key: "Task-A", id: "Task-A" },
    { root: "/tmp/b", logical_task_key: "task-a", id: "task-a" },
  ]));
  assert.equal(folded.ok, false, "**大小写折叠后相同就不许放行**");
  assert.equal(folded.reason, "registry_malformed");
  assert.match(folded.detail, /大小写折叠/u, "要说清是折叠之后撞的");

  const sameId = loadRegistry(write([
    { root: "/tmp/a", logical_task_key: "task-one", id: "same" },
    { root: "/tmp/b", logical_task_key: "task-two", id: "same" },
  ]));
  assert.equal(sameId.ok, false, "**id 与 key 不一致就不许放行**");
  assert.match(sameId.detail, /id 与 logical_task_key 不一致/u);

  // id 缺失 → 补成 key，仍然合法。
  const noId = loadRegistry(write([{ root: "/tmp/a", logical_task_key: "task-one" }]));
  assert.equal(noId.ok, true, "id 缺失是合法的");
  assert.equal(noId.tasks[0].id, "task-one", "要补成 key");
  // 真正不同的 key 照常通过。
  assert.equal(loadRegistry(write([
    { root: "/tmp/a", logical_task_key: "task-one", id: "task-one" },
    { root: "/tmp/b", logical_task_key: "task-two", id: "task-two" },
  ])).ok, true);
});

test("坏文件名也要过净化 —— 这个命令的用途就是查看畸形文件", () => {
  // 评审实测：创建名为 evil<ESC>[2J.json 的坏记录，真实 CLI 的 stdout 仍含 ESC。
  // **文件名不能被视为可信输入** —— 恰恰因为这个命令是用来看畸形文件的。
  // 另外换行、TAB、U+2028/U+2029 上一版也没处理：换行同样能伪造后续行。
  const ESC = String.fromCharCode(27);
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  // 文件名里带 ESC，内容是坏 JSON —— 它一定会被点名，于是文件名一定会被打印。
  fs.writeFileSync(path.join(ob, "evil" + ESC + "[2J.json"), "{ 坏的");

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.notEqual(r.status, 0, "坏文件要被点名");
  const all = r.stdout + r.stderr;
  assert.match(all, /evil/u, "确实打印了这个文件名");
  assert.equal(all.includes(ESC), false, "**文件名里的 ESC 不许漏出去**");

  // 净化判据要覆盖换行族。
  for (const code of [0x0a, 0x0d, 0x09, 0x2028, 0x2029, 0x1b, 0x202e, 0x00]) {
    const ch = String.fromCharCode(code);
    assert.equal(sanitizeForDisplay("a" + ch + "b").includes(ch), false,
      "U+" + code.toString(16) + " 漏出去了");
  }
});

test("授权是三态：目标失效时也不许把「畸形」说成「尚未」", () => {
  // 评审实测：授权畸形 + 目标正常时已正确报 auth_malformed；
  // 但目标同时失效时，又因为 hasEligibility === false 输出"还没取得发布资格" ——
  // **三态在那条分支上被压回了布尔**；目标解析抛错时更是完全藏起来。
  const base = { id: "e1", kind: "reply", text: "x", created_at: "2026-08-20T00:00:00.000Z" };
  const malformed = { ...base, publish_eligible_at: "not-a-canonical-time" };

  // ① 目标失效 + 授权畸形 → 两件事都要说。
  const gone = describeRecordState(malformed,
    { resolveTarget: () => ({ ok: false, reason: "generation_not_found" }) });
  assert.equal(gone.code, "target_gone");
  assert.match(gone.text, /永远发不出去/u);
  assert.match(gone.text, /资格字段是坏的/u, "**畸形授权不许退化成「尚未」**");
  assert.equal(/还没取得发布资格/u.test(gone.text), false);

  // ② 目标失效 + 尚未授权 → 说法要不同。
  const pendingAuth = describeRecordState({ ...base, publish_eligible_at: null },
    { resolveTarget: () => ({ ok: false, reason: "generation_not_found" }) });
  assert.match(pendingAuth.text, /还没取得发布资格/u);
  assert.equal(/资格字段是坏的/u.test(pendingAuth.text), false);

  // ③ 目标解析抛错 → 授权损坏不许被藏起来。
  const threw = describeRecordState(malformed,
    { resolveTarget: () => { throw new Error("炸了"); } });
  assert.equal(threw.code, "auth_malformed", "**抛错也要把授权损坏说出来**");
  assert.match(threw.text, /资格字段是坏的/u);
});

test("时间展示也走规范判据 —— 不许一边说解释不了、一边给出精确年龄", () => {
  // 评审实测：created_at = "Aug 25 2026" 同时得到
  // explainabilityGaps=["created_at"] 和"32 小时前"。
  // 后者精确到看着可信，而它根本不是规范时间。
  for (const bad of ["Aug 25 2026", "8/25/2026", "2026/08/25", "2026-08-25",
    "2026-08-25T01:02:03Z"]) {
    assert.match(ageText(bad), /不是规范格式/u, JSON.stringify(bad) + " 竟然给出了年龄");
    assert.ok(explainabilityGaps({ id: "a", kind: "reply", text: "x", created_at: bad })
      .includes("created_at"), JSON.stringify(bad) + " 审计应当点名");
  }
  // 规范时间照常给相对时间。
  const now = Date.now();
  assert.match(ageText(new Date(now - 3 * 3600 * 1000).toISOString(), now), /小时前/u);
});


test("停用条目也占存储身份 —— 判重要在过滤之前", () => {
  // 评审实测：一条**停用** task 和一条启用 task 用完全相同的 key，
  // loadRegistry 仍报 ok，两者 outbox/锁路径完全相同 ——
  // **启用的那条会去动停用那条的历史内容。**
  // 停用不代表它不占目录：目录还在，里面的东西还在。
  const write = (tasks) => {
    const home = temp();
    const f = path.join(home, "registry.json");
    fs.writeFileSync(f, JSON.stringify({ tasks }));
    return f;
  };

  const clash = loadRegistry(write([
    { root: "/tmp/a", logical_task_key: "same-key", id: "same-key", enabled: false },
    { root: "/tmp/b", logical_task_key: "same-key", id: "same-key" },
  ]));
  assert.equal(clash.ok, false, "**停用的那条也要参与判重**");
  assert.equal(clash.reason, "registry_malformed");
  assert.match(clash.detail, /#0/u, "要指回原始索引，不是过滤之后的位置");

  // 大小写折叠同理 —— 停用那条也算。
  assert.equal(loadRegistry(write([
    { root: "/tmp/a", logical_task_key: "Same-Key", id: "Same-Key", enabled: false },
    { root: "/tmp/b", logical_task_key: "same-key", id: "same-key" },
  ])).ok, false, "折叠后相同也要拦");

  // 但一条连 key 都没有的停用条目跟谁都撞不上 —— 不该把整张表判坏。
  assert.equal(loadRegistry(write([{ enabled: false }])).ok, true, "无 key 的停用不算畸形");
  assert.equal(loadRegistry(write([
    { enabled: false },
    { root: "/tmp/b", logical_task_key: "k", id: "k" },
  ])).tasks.length, 1, "停用的不进结果集");
});

test("id 的缺失与显式空值是两回事", () => {
  // 评审：用 ?? 补写 id，使显式的 "id": null 被当成"字段缺失"并静默改成 key。
  // 契约是"缺失才补；存在则必须等于 key" —— **显式空值是说不清，不是缺省**。
  const write = (task) => {
    const home = temp();
    const f = path.join(home, "registry.json");
    fs.writeFileSync(f, JSON.stringify({ tasks: [task] }));
    return f;
  };
  const missing = loadRegistry(write({ root: "/tmp/a", logical_task_key: "k" }));
  assert.equal(missing.ok, true, "缺失是合法的");
  assert.equal(missing.tasks[0].id, "k", "缺失才补成 key");

  for (const bad of [null, "", 0, false]) {
    const got = loadRegistry(write({ root: "/tmp/a", logical_task_key: "k", id: bad }));
    assert.equal(got.ok, false, JSON.stringify(bad) + " 竟然被当成缺失");
    assert.match(got.detail, /id 与 logical_task_key 不一致/u);
  }
  // 显式且相等 → 合法。
  assert.equal(loadRegistry(write({ root: "/tmp/a", logical_task_key: "k", id: "k" })).ok, true);
});

test("净化覆盖全部双向控制符，包括 U+061C", () => {
  // 评审把 U+061C（ARABIC LETTER MARK）放进坏文件名，真实 CLI 原样带了出来。
  // **手数码位的错误模式就是"漏掉的那个"** —— 改用 Unicode Bidi_Control 属性。
  const ALM = String.fromCharCode(0x061c);
  assert.equal(sanitizeForDisplay("a" + ALM + "b").includes(ALM), false, "U+061C 漏出去了");
  // 属性覆盖的其余码位也要过。
  for (const cp of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069]) {
    const ch = String.fromCodePoint(cp);
    assert.equal(sanitizeForDisplay("a" + ch + "b").includes(ch), false,
      "U+" + cp.toString(16) + " 漏出去了");
  }

  // 真实 CLI：文件名里带 U+061C 也不许漏。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "evil" + ALM + "name.json"), "{ 坏的");
  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal((r.stdout + r.stderr).includes(ALM), false, "**文件名里的 U+061C 不许漏**");
});

test("输出边界的规矩自己也要守：不许内嵌换行", () => {
  // 我在这个文件里定了"格式串不许带换行"，然后在同一个文件里破了它 ——
  // 净化器把那个 \n 换成了 U+FFFD，真实输出首行成了"积压 1 条。<?>"。
  const home = temp();
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "T",
    rootMessageId: "om_root", token: "a1b2c3" });
  writeRegistry([task], path.join(home, "registry.json"));
  const ob = taskPaths(task, home).outbox;
  fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, "0001.json"), JSON.stringify(outboxRecord({
    kind: "reply", text: "一条" })));

  const r = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "codex", "feishu-outbox.mjs")],
    { encoding: "utf-8", env: { ...isolatedEnv(), FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(String.fromCharCode(0xfffd)), false,
    "**正常输出里不许出现占位符** —— 出现就说明格式串自己带了控制字符：" +
    r.stdout.split("\n")[0]);
  assert.match(r.stdout.split("\n")[0], /^积压 1 条。$/u, "首行要干净");
});


test("登记表写入不许重建整表：停用条目、未知字段、顶层字段都要留住", () => {
  // 评审实测："启用 A + 停用 B + 顶层扩展字段"，只改 A 的显示名，
  // 落盘后 **B 和顶层字段都没了**，而调用方拿到的是 ok:true。共 7 个同类写入点。
  //
  // 根因是两件事叠加：loadRegistry 返回的是**过滤后的活动视图**（停用的不在里面，
  // 而且每条都是副本），writeRegistry 又从零重建 { schema_version, runtime, tasks }。
  // **迁移逻辑里本来就写着"视图 + 重建会静默删数据"—— 普通写路径还在重复它。**
  const home = temp();
  const file = path.join(home, "registry.json");
  const root = path.join(home, "p");
  fs.mkdirSync(root, { recursive: true });
  const a = makeTaskEntry({ root, threadId: THREAD_A, name: "A",
    rootMessageId: "om_a", token: "a1b2c3" });
  a.未知条目字段 = "要留住";
  const b = makeTaskEntry({ root: path.join(home, "q"), threadId: THREAD_B, name: "B",
    rootMessageId: "om_b", token: "b1b2c3" });
  b.enabled = false;
  fs.mkdirSync(path.join(home, "q"), { recursive: true });
  // 直接写原始文档 —— 带上一个顶层扩展字段。
  fs.writeFileSync(file, JSON.stringify({
    schema_version: "1.0", runtime: "codex", 顶层扩展字段: "也要留住", tasks: [a, b],
  }, null, 2));

  const readBack = () => JSON.parse(fs.readFileSync(file, "utf-8"));
  const survives = (where) => {
    const doc = readBack();
    assert.equal(doc.顶层扩展字段, "也要留住", where + "：**顶层未知字段被删了**");
    assert.equal((doc.tasks ?? []).length, 2, where + "：**停用条目被删了**");
    const rawA = doc.tasks.find((t) => t.codex_thread_id === THREAD_A);
    assert.equal(rawA?.未知条目字段, "要留住", where + "：**条目上的未知字段被删了**");
    const rawB = doc.tasks.find((t) => t.codex_thread_id === THREAD_B);
    assert.equal(rawB?.enabled, false, where + "：停用标记要留住");
  };

  // ① 改显示名
  const renamed = setTaskDisplayName({ threadId: THREAD_A, name: "A2", home });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(readBack().tasks.find((t) => t.codex_thread_id === THREAD_A).task_display_name,
    "A2", "改动本身要落盘");
  survives("改显示名之后");

  // ② 改状态
  const paused = setTaskConnectionStatus({ threadId: THREAD_A, status: "paused", home });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  survives("改状态之后");

  // ③ 新增 task
  const THIRD = "01a01ecf-84ea-7a43-a44e-0710d008999c";
  const c = makeTaskEntry({ root: path.join(home, "r"), threadId: THIRD, name: "C",
    rootMessageId: "om_c", token: "c1b2c3" });
  fs.mkdirSync(path.join(home, "r"), { recursive: true });
  const added = addTask(c, { home });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(readBack().tasks.length, 3, "新增要真的加进去");
  assert.equal(readBack().顶层扩展字段, "也要留住", "新增之后顶层字段也要留住");
  assert.equal(readBack().tasks.filter((t) => t.enabled === false).length, 1,
    "新增之后停用条目也要留住");
});

test("登记表首次写入要能把文件建出来，读不懂时不许覆盖", () => {
  // ENOENT = 空文档（首次写入本来就要建它）；
  // **其余读取错误说不清 —— 那时候写回去会覆盖一份我们没读懂的文件。**
  const home = temp();
  const file = path.join(home, "registry.json");
  const created = mutateRegistryDocument(file, (raw) => { raw.push({ x: 1 }); });
  assert.equal(created.ok, true, "首次写入要能建文件");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).tasks.length, 1);

  // 读不懂 → 拒绝，且**原文件一个字节都不许动**。
  fs.writeFileSync(file, "{ 这不是 JSON");
  const before = fs.readFileSync(file, "utf-8");
  const refused = mutateRegistryDocument(file, () => { throw new Error("不该被调用"); });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "registry_unreadable");
  assert.equal(fs.readFileSync(file, "utf-8"), before, "**读不懂就不许覆盖**");
});


summarySealed = true;
console.log("Codex adapter 通过 " + passed + " / 失败 " + failed);
if (failed > 0) process.exit(1);
