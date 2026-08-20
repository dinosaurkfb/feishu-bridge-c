/**
 * 本地合成回归测试。零外部副作用：不碰飞书、不碰网络，只在临时目录里写文件。
 *
 * 覆盖重点是**拒绝路径**，不是接受路径 —— 接受路径错了会立刻被发现，
 * 拒绝路径错了会静默地把不该放行的消息放行。
 *
 * v2：标识符全部换到 Aily 命名空间（见 selector.mjs 顶部说明）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REJECT, evaluateInbound, extractMentionIds, isValidPrefix, isValidQuota, normalizeBody,
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
import { drainProject, watcherActive } from "./drain-outbox.mjs";
import { bindingWarning, checkBinding } from "./binding-health.mjs";
import {
  findLiveSessions, forwardPrompt, hasPriorSession, isBridgeOwnedSession,
  stampInstruction, transcriptDirFor,
} from "./live-session.mjs";
import { extractReply } from "./stop-hook.mjs";
import {
  CHAIN_FIELDS, materializeProjectConfig, validateChainTemplate,
} from "./chain-template.mjs";
import {
  PURPOSE_MAX, bindingToken, composeRootMessage, composeStatusMessage,
  firstSentence, idempotencyKeyFor, newRegistryEntry, readProjectIdentity,
} from "./bind-compose.mjs";
import { mappingFromRegistryEntry, resolveProject } from "./project-resolve.mjs";
import { composeAsk, isInitPrompt } from "./init-hook.mjs";

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
});

test("根消息里不含任何当前进度字样 —— 它发出去就改不了", () => {
  const msg = composeRootMessage({ name: "a", root: "/tmp/a", token: "abc123" });
  for (const banned of ["已接通", "还没接通", "待绑定", "改造"]) {
    assert.ok(!msg.includes(banned), "根消息不该出现「" + banned + "」");
  }
});

test("入站没通时状态消息必须明说不通 —— 没做成就不能说做成了", () => {
  const off = composeStatusMessage({ name: "a", inboundReady: false });
  assert.ok(off.includes("还没接通"));
  assert.ok(!off.includes("绑定就完成了"));
  const on = composeStatusMessage({ name: "a", inboundReady: true });
  assert.ok(on.includes("绑定就完成了"));
  assert.ok(!on.includes("还没接通"));
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

test("行内 markdown 被剥掉 —— 飞书文本消息不渲染，留着就是一堆星号", () => {
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

// ---------- /init 钩子：什么算 /init，问什么 ----------

test("只认 /init 本身和 /init 带参数", () => {
  for (const y of ["/init", "  /init  ", "/init 顺便跑测试"]) {
    assert.equal(isInitPrompt(y), true, JSON.stringify(y));
  }
  for (const n of ["/initialize", "/init-thing", "init", "/compact", "帮我 /init", "", null, undefined, 42, {}]) {
    assert.equal(isInitPrompt(n), false, JSON.stringify(n));
  }
});

test("注入的话里写死了「等 CLAUDE.md 写完再问」——/init 之前问，名字和用途还不存在", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("CLAUDE.md 写完"));
  assert.ok(ask.includes("不是现在"));
});

test("注入的话带上可直接执行的命令和项目路径", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("/b/scripts/bind-project.mjs"));
  assert.ok(ask.includes("--project /tmp/p"));
  assert.ok(ask.includes("--apply"));
});

test("默认「是」，但答否就不许再问", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("默认「是」"));
  assert.ok(ask.includes("不要再问第二次"));
});

test("注入的话必须说清入站没通 —— 模型最容易顺口说成「接好了」", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("还没接通"));
  assert.ok(ask.includes("别说它通了"));
});

test("拦下了要交出命令，而不是自己还原根消息文案", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("不要自己还原文案"));
  assert.ok(ask.includes("逐字还原"), "要点名这个具体的错误做法");
});

test("先跑预览再问 —— 文案必须是脚本打印的，不是模型算的", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("/b/scripts/bind-preview.mjs --project /tmp/p"));
  assert.ok(ask.indexOf("bind-preview.mjs") < ask.indexOf("默认「是」"), "预览要排在提问前面");
  assert.ok(ask.indexOf("bind-preview.mjs") < ask.indexOf("--apply"), "预览要排在真发前面");
});

test("明说真发那条会弹权限，且那是应该的", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b", chatName: "群" });
  assert.ok(ask.includes("弹权限"));
  assert.ok(ask.includes("那是应该的"), "别让模型把正常的确认当成故障去绕");
});

test("群名缺失时也拼得出话，不把 undefined 打进去", () => {
  const ask = composeAsk({ cwd: "/tmp/p", bridgeRoot: "/b" });
  assert.ok(!ask.includes("undefined"));
  assert.ok(!ask.includes("null"));
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

// ---------- 汇总 ----------

console.log(`\n通过 ${passed} / 失败 ${failed}\n`);
if (failed > 0) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
