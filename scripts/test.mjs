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

import { REJECT, evaluateInbound, extractMentionIds, isValidQuota, normalizeBody } from "./selector.mjs";
import { NOTE_MAX, resolveUntil, validateNote } from "./binding.mjs";
import { acquireClaim, claimKey, recordClaimState } from "./claim.mjs";
import { acquireSessionLock, releaseSessionLock, stampSessionLock, readRunOutcome } from "./handoff.mjs";
import {
  acquirePublishLock, attributeSession, fileContainsAny, isUnder,
  loadRegistry, releasePublishLock,
} from "./registry.mjs";
import { appendEvent, composeDigest, listPending, markSent } from "./outbox.mjs";
import { drainProject, watcherActive } from "./drain-outbox.mjs";
import { bindingWarning, checkBinding } from "./binding-health.mjs";

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
  ["前缀后没有正文", () => evalWith({ content: at(M5CLAUDE) + " →Claude   " }), REJECT.PREFIX_MISMATCH],
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

test("有待发内容但配置读不了 → error，绝不静默丢弃", () => {
  appendEvent({ outboxDir: projOutbox, kind: "next", text: "待发一条", source: "t" });
  const r = drainProject({ root: proj });
  assert.equal(r.status, "error");
  assert.equal(r.reason, "config_unreadable");
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

// ---------- 汇总 ----------

console.log(`\n通过 ${passed} / 失败 ${failed}\n`);
if (failed > 0) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
