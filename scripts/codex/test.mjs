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
import { composeCodexBinding, validThreadId } from "./bind-compose.mjs";
import { readCodexRunOutcome } from "./handoff.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import {
  classifyFeishuPrompt, composeAilyInboundContext, composeBindingContext, composeInitContext,
  composeStatusContext, composeUnbindContext, isAilyInvocation, isBindingPrompt,
} from "./prompt-hook.mjs";
import {
  enableAutoPublishForAllTasks, findRegisteredTaskForCodexThread, findTaskForCodexThread, findTaskForFeishuSession,
  isThreadBusy, loadRegistry, makeTaskEntry, mappingForTask, recordThreadActivity,
  setTaskConnectionStatus, taskPaths, validateCodexTemplate, validateRegistryTasks, writeRegistry,
} from "./state.mjs";

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

function autoPublishFixture({ enabled = true, workingPublisher = true } = {}) {
  const home = temp();
  const root = path.join(home, "project");
  const bin = path.join(home, "fake-lark.sh");
  const configBase = path.join(home, "agents");
  const credentialDir = path.join(configBase, TEMPLATE.agent_uid);
  fs.mkdirSync(root);
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(credentialDir, "config.json"), JSON.stringify({
    apps: [{ name: TEMPLATE.lark_cli_profile, appId: TEMPLATE.transport_app_id }],
  }));
  fs.writeFileSync(bin, workingPublisher
    ? "#!/bin/sh\nprintf '%s' '{\"ok\":true,\"data\":{\"message_id\":\"om_sent\"}}'\n"
    : "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  fs.writeFileSync(path.join(home, "chain-config.json"), JSON.stringify({
    ...TEMPLATE, lark_cli_bin: bin, lark_cli_config_base: configBase,
  }));
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.auto_publish_on_completion = enabled;
  writeRegistry([task], path.join(home, "registry.json"));
  return { home, root, task };
}

test("thread id 只接受精确 UUID，不接受 --last 或名字", () => {
  assert.equal(validThreadId(THREAD_A), true);
  assert.equal(validThreadId("--last"), false);
  assert.equal(validThreadId("my-recent-thread"), false);
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
  writeRegistry([a, b], path.join(home, "registry.json"));
  const reg = loadRegistry(path.join(home, "registry.json"));
  assert.equal(reg.tasks.length, 2);
  assert.notEqual(a.logical_task_key, b.logical_task_key);
  assert.equal(findTaskForCodexThread({ threadId: THREAD_B, home }).task.task_display_name, "B");
  // 没有模板时 Feishu 路由必须失败关闭，而不是仅凭同 cwd 选一个。
  assert.equal(findTaskForFeishuSession({ sessionId: "session_b", home }).ok, false);
});

test("Feishu session 与 Codex thread 是两把独立且精确的键", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
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

test("三条 task 控制脚本不猜 thread，暂停和恢复都不调用飞书", () => {
  const home = temp();
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  const task = makeTaskEntry({ root, threadId: THREAD_A, name: "A", rootMessageId: "om_a", token: "a" });
  task.session_id = "aily_session_a";
  task.inbound_state = "bound";
  writeRegistry([task], path.join(home, "registry.json"));
  const env = { ...process.env, FEISHU_CODEX_BRIDGE_HOME: home };

  const status = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "feishu-status.mjs"),
    "--thread-id", THREAD_A], { encoding: "utf-8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /已接入飞书/);
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
  const outboxDir = taskPaths(task, home).outbox;
  appendEvent({ outboxDir, kind: "reply", text: "暂时发不出", eventKey: "retry", publishEligible: true });
  const published = publishEligibleTaskEvents({ task, home });
  assert.equal(published.status, "error");
  assert.equal(listPending({ outboxDir }).length, 1);
  assert.equal(typeof listPending({ outboxDir })[0].publish_eligible_at, "string");
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

test("Prompt hook 的接桥意图窄匹配，并注入精确 thread 命令", () => {
  assert.equal(isBindingPrompt("把这个任务接到飞书"), true);
  assert.equal(isBindingPrompt("飞书接入当前任务"), true);
  assert.equal(isBindingPrompt("新建一个飞书话题"), true);
  assert.equal(isBindingPrompt("/init"), false, "/init 是 AGENTS.md 初始化，不是绑定命令");
  assert.equal(classifyFeishuPrompt("/init"), "init");
  assert.equal(classifyFeishuPrompt("$feishu-bind"), "bind");
  assert.equal(classifyFeishuPrompt("$feishu-unbind"), "unbind");
  assert.equal(classifyFeishuPrompt("$feishu-status"), "status");
  assert.equal(classifyFeishuPrompt("[$feishu-bind](/Users/test/.codex/skills/feishu-bind/SKILL.md)"), "bind");
  assert.equal(classifyFeishuPrompt("[$feishu-unbind](/Users/test/.codex/skills/feishu-unbind/SKILL.md)"), "unbind");
  assert.equal(classifyFeishuPrompt("[$feishu-status](/Users/test/.codex/skills/feishu-status/SKILL.md)"), "status");
  assert.equal(classifyFeishuPrompt("把当前 task 撤销飞书接入"), "unbind");
  assert.equal(classifyFeishuPrompt("查看当前 task 的飞书接入状态"), "status");
  assert.equal(classifyFeishuPrompt("是不是也可以加个命令来实现接入飞书和撤销接入？"), "none");
  assert.equal(isBindingPrompt("继续写代码"), false);
  assert.equal(isBindingPrompt([
    '<at id="ou_m5">M5Codex</at>', "", "**[引用]**", "🌉 Codex-Lark", "",
    "Codex—飞书桥的长期承接项目。",
  ].join("\n")), false, "引用根消息中的‘飞书…承接’不是绑定意图");
  const c = composeBindingContext({ bridgeRoot: "/bridge", cwd: "/work", threadId: THREAD_A, chatName: "群" });
  assert.match(c, new RegExp(THREAD_A));
  assert.equal(c.includes("resume --last"), false);
  assert.match(composeUnbindContext({ bridgeRoot: "/bridge", threadId: THREAD_A }), /feishu-unbind\.mjs/);
  assert.match(composeStatusContext({ bridgeRoot: "/bridge", threadId: THREAD_A }), /feishu-status\.mjs/);
});

test("/init 只追加初始化成功后的询问，不触发绑定或飞书写入", () => {
  const c = composeInitContext({ connectionStatus: "none" });
  assert.match(c, /先完整执行 \/init 原本的 AGENTS\.md 初始化/);
  assert.match(c, /是否将当前 Codex task 接入飞书/);
  assert.match(c, /请回复“接入飞书”/);
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
      prompt: "把这个任务接到飞书",
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
    input: JSON.stringify({ session_id: THREAD_B, prompt: "把这个任务接到飞书" }),
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
  assert.equal(c.includes('node "/bridge root/scripts/codex/inbound.mjs"'), true);
  assert.equal(c.includes("bind-task.mjs --project"), false);
  assert.equal(c.includes("--last"), false);
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

test("run-resume 用精确 UUID、stdin prompt 和 last-message 形成可观察终局", () => {
  const dir = temp();
  const fake = path.join(dir, "fake-codex.sh");
  fs.writeFileSync(fake, `#!/bin/sh
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
  fs.writeFileSync(instruction, "精确投递");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex", "run-resume.mjs"),
    "--thread-id", THREAD_A, "--project", dir, "--instruction-file", instruction,
    "--log", log, "--stderr", stderr, "--last-message", last, "--exit-receipt", exit,
    "--codex-bin", fake,
  ], { encoding: "utf-8", env: { ...process.env, EXPECTED_THREAD: THREAD_A } });
  assert.equal(r.status, 0, r.stderr);
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
  for (const name of ["feishu-bind", "feishu-unbind", "feishu-status"]) {
    const commandSkill = fs.readFileSync(path.join(codexHome, "skills", name, "SKILL.md"), "utf-8");
    assert.equal(commandSkill.includes("name: " + name), true);
  }
  assert.equal(fs.existsSync(path.join(home, "registry.json")), true);
  assert.equal(loadRegistry(path.join(home, "registry.json")).tasks[0].auto_publish_on_completion, true);
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

console.log("Codex adapter 通过 " + passed + " / 失败 " + failed);
if (failed > 0) process.exit(1);
