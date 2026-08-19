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

import { REJECT, evaluateInbound, extractMentionIds, normalizeBody } from "./selector.mjs";
import { acquireClaim, claimKey, recordClaimState } from "./claim.mjs";
import { acquireSessionLock, releaseSessionLock, stampSessionLock, readRunOutcome } from "./handoff.mjs";

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

// ---------- claim：原子性与幂等 ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cc-test-"));
const claimsDir = path.join(tmp, "delivery-claims");
fs.mkdirSync(claimsDir, { recursive: true });

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

fs.rmSync(tmp, { recursive: true, force: true });

// ---------- 汇总 ----------

console.log(`\n通过 ${passed} / 失败 ${failed}\n`);
if (failed > 0) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
