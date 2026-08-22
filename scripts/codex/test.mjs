#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  extractQuotedBindingTokens, findPendingTask,
  findRegisteredTaskForCodexThread, findTaskForCodexThread, findTaskForFeishuSession,
  isThreadBusy, loadCodexTemplate, loadRegistry, makeTaskEntry, mappingForTask, recordThreadActivity, resolveTask,
  closeTaskTopicRotation, prepareTaskTopicRotation, promoteTask, recordTaskTopicActivity,
  finalizeTaskDialogueTurn, interactionPolicyForTask, reserveTaskDialogueTurn,
  refreshPendingTaskBinding,
  registerTaskTopicRotation, resolveTaskOutboundGeneration, setTaskConnectionStatus,
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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
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
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (err) { failed += 1; console.error("FAIL " + name + "\n" + (err.stack ?? err)); }
};
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "feishu-codex-adapter-test-"));

test("Codex 将 chat scope probe 纳入受保护共用面", () => {
  assert.equal(CHAT_SCOPE_PROBE_ARTIFACT_TYPE, "feishu_bridge_dialogue_chat_scope_probe");
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
    encoding: "utf-8", env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
  });
  const read = run();
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /Mapping/u);
  const preview = run("--mode", "dialogue");
  assert.match(preview.stdout, /dry-run/u);
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].interaction_policy_state, undefined);
  const applied = run("--mode", "dialogue", "--apply");
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Dialogue/u);
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].interaction_policy_state.policy_id,
    "dialogue");
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
      ...process.env,
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
      ...process.env,
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
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
  ], { encoding: "utf-8", env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /只读历史代际：1 个.*轮转前受理的结果仍会发回原话题/u);
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
    "--apply",
  ], {
    encoding: "utf-8",
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
    "--project", root, "--thread-id", THREAD_A, "--name", "A", "--apply"], {
    encoding: "utf-8",
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
    "--project", root, "--thread-id", THREAD_A, "--name", "New", "--apply"], {
    encoding: "utf-8",
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
  const env = { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home };

  const status = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"),
    "--thread-id", THREAD_A], { encoding: "utf-8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /已接入飞书/);
  assert.match(status.stdout, /当前话题代际/u);
  assert.match(status.stdout, /自动轮转：0 \/ 30 条有效业务消息/u);
  assert.equal(status.stdout.includes(THREAD_A), false);
  assert.equal(status.stdout.includes("om_a"), false);

  const dry = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-unbind.mjs"),
    "--thread-id", THREAD_A], { encoding: "utf-8", env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_A, home }).ok, true);

  const paused = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-unbind.mjs"),
    "--thread-id", THREAD_A, "--apply"], { encoding: "utf-8", env });
  assert.equal(paused.status, 0, paused.stderr);
  assert.match(paused.stdout, /已暂停/);
  assert.equal(findRegisteredTaskForCodexThread({ threadId: THREAD_A, home }).task.status, "paused");

  const resumed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "bind-task.mjs"),
    "--project", root, "--thread-id", THREAD_A, "--apply"], { encoding: "utf-8", env });
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
    env: { ...process.env, TEST_OUTBOX: outboxDir },
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
    /feishu-mode\.mjs.*--mode dialogue.*--apply/u);
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
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
      ...process.env,
      FEISHU_CODEX_BRIDGE_HOME: home,
      AILY_CLI_SESSION_ID: "session_feishu",
      AILY_CLI_CALLER_AGENT_UID: TEMPLATE.agent_uid,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const injected = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(injected.includes("inbound.mjs"), true);
  assert.equal(injected.includes("FEISHU_CODEX_BRIDGE_HOME=" + JSON.stringify(home)), true);
  assert.equal(injected.includes("不得运行 bind-preview.mjs"), true);
  assert.equal(fs.existsSync(path.join(home, "active-threads")), false);

  const wrongCaller = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: THREAD_B, prompt: "$feishu-bind" }),
    encoding: "utf-8",
    env: {
      ...process.env,
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
  assert.equal(c.includes('FEISHU_CODEX_BRIDGE_HOME="/state home"'), true);
  assert.equal(c.includes('node "/bridge root/scripts/codex/aily-inbound.mjs"'), true);
  assert.equal(c.includes('node "/bridge root/scripts/codex/inbound.mjs"'), false,
    "hook 不得绕过 dispatcher 直达业务 handler");
  assert.equal(c.includes("bind-task.mjs --project"), false);
  assert.equal(c.includes("--last"), false);
  const skill = fs.readFileSync(path.join(ROOT, "skills", "m5codex-inbound-router", "SKILL.md"), "utf-8");
  assert.equal(skill.includes("scripts/codex/aily-inbound.mjs"), true,
    "M5Codex 技能和 hook 必须指向同一个 dispatcher wrapper");
  assert.equal(skill.includes("scripts/codex/inbound.mjs\""), false,
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
      ...process.env,
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

  const benignCommands = [
    "sed -n '1,220p' scripts/codex/inbound.mjs",
    "rg -n 'bridge_recursion|m5codex-inbound-router|scripts/codex/inbound.mjs' scripts",
    "git add scripts/codex/inbound.mjs skills/m5codex-inbound-router/SKILL.md",
    "/bin/zsh -lc \"git diff -- scripts/codex/inbound.mjs && rg -n 'm5codex-inbound-router' .\"",
    "node --input-type=module <<'NODE'\nconst marker = 'scripts/codex/inbound.mjs';\nNODE",
    "node --input-type=module <<'NODE'\nconst fixture = `\nnode /bridge/scripts/codex/inbound.mjs\n`;\nNODE",
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
    ...process.env,
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
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
  const env = { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home };

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
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home },
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
  ], { encoding: "utf-8", env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home } });
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
  ], { encoding: "utf-8", env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home } });
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
  ], { encoding: "utf-8", env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home } });
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
  ], { encoding: "utf-8", env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home } });
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
    env: { ...process.env, CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
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
    env: { ...process.env, CODEX_HOME: codexHome, FEISHU_CODEX_BRIDGE_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf-8"));
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, "existing-orca");
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  const skill = fs.readFileSync(path.join(codexHome, "skills", "m5codex-inbound-router", "SKILL.md"), "utf-8");
  assert.equal(skill.includes("{{BRIDGE_ROOT}}"), false);
  assert.equal(skill.includes("{{CODEX_BRIDGE_HOME_SHELL}}"), false);
  assert.equal(skill.includes(ROOT), true);
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
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].auto_publish_on_completion, true);
});

test("入站前置回执目录不可写时只返回脱敏错误，不泄露 Node 堆栈", () => {
  const dir = temp();
  const blockedHome = path.join(dir, "not-a-directory");
  fs.writeFileSync(blockedHome, "blocked");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "inbound.mjs")], {
    encoding: "utf-8",
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: blockedHome },
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
  assert.equal(enableAutoPublishForAllTasks({ home }).changed, 2);
  assert.equal(enableAutoPublishForAllTasks({ home }).changed, 0);
  assert.deepEqual(loadRegistry(path.join(home, "registry.json")).tasks.map((task) => task.auto_publish_on_completion),
    [true, true]);
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
    "--apply"], {
    encoding: "utf-8",
    env: { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home, FAKE_CALLS_FILE: calls },
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
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ command: "node " + path.join(ROOT, "scripts", "codex", "prompt-hook.mjs") }] }],
      Stop: [{ hooks: [{ command: "node " + path.join(ROOT, "scripts", "codex", "stop-hook.mjs") }] }],
    },
  }));
  for (const name of ["m5codex-inbound-router", "codex-longtask-feishu", "feishu-bind", "feishu-unbind", "feishu-status", "feishu-rotate", "feishu-mode"]) {
    const skillDir = path.join(codexHome, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: " + name + "\n---\n");
  }

  const run = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "doctor.mjs"), "--json"], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: bin + path.delimiter + (process.env.PATH ?? ""),
      CODEX_HOME: codexHome,
      FEISHU_CODEX_BRIDGE_HOME: home,
    },
  });
  const healthy = run();
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).ready, true);

  fs.rmSync(path.join(codexHome, "skills", "feishu-status"), { recursive: true });
  const broken = run();
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stdout).ready, false);
});

console.log("Codex adapter 通过 " + passed + " / 失败 " + failed);
if (failed > 0) process.exit(1);
