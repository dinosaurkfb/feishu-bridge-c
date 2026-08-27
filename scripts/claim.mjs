/**
 * 单机原子 delivery claim。
 *
 * 幂等的物理基础是 mkdir —— POSIX 上它要么成功创建、要么以 EEXIST 失败，
 * 不存在「检查后再创建」的竞态窗口。所以这里刻意不用 existsSync + mkdir 两步。
 *
 * 明确的能力边界：这只提供**单机** exactly-once。跨设备不承诺，也不假装承诺。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { DIALOGUE_POLICY_ID, DIALOGUE_POLICY_VERSION } from "./interaction-policy.mjs";
import { MAPPING_POLICY_ID, MAPPING_POLICY_VERSION } from "./mapping-policy.mjs";
import { usableGeneration } from "./topic-generation.mjs";
import path from "node:path";

export const CLAIM_STATE = {
  CLAIMED: "claimed",
  HANDED_OFF: "handed_off",
  REJECTED: "rejected",
  FAILED: "failed",
};

/**
 * claim key 的真实形状：`claimKey()` 是 sha256 的十六进制摘要，恒为 64 位。
 * **全仓唯一的判据** —— 恢复标记文件名、run 制品文件名、退出回执里的 claim_key、
 * watcher 的入参都用它验；各写一份正则就会有一份漏掉。
 */
export const CLAIM_KEY_SHAPE = /^[0-9a-f]{64}$/u;

export function claimKey(messageId, logicalTaskKey) {
  return createHash("sha256")
    .update(messageId + " " + logicalTaskKey)
    .digest("hex");
}

function writeJsonAtomic(filePath, payload) {
  // 先写临时文件再 rename：rename 在同一文件系统上是原子的，
  // 读取方永远不会看到半截 JSON。
  const tmp = filePath + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * 取得唯一投递权。
 */
export function acquireClaim({ claimsDir, messageId, logicalTaskKey, meta }) {
  const key = claimKey(messageId, logicalTaskKey);
  const dir = path.join(claimsDir, key + ".claim");

  try {
    // 父目录按需创建：全新部署时它不存在，旧版会让第一条消息必然失败。
    fs.mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
    // claim 目录本身必须 recursive:false —— EEXIST 正是幂等赖以成立的原子信号。
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, reason: "duplicate", key, dir };
    // 其他 IO 错误绝不当成「可以继续」—— 没拿到 claim 就不许投递。
    return { ok: false, reason: "io_error", error: err.message, key, dir };
  }

  // 固定身份字段放在扩展对象**之后** —— meta 覆盖不了 claim_key/state/message_id。
  writeJsonAtomic(path.join(dir, "claim.json"), {
    ...meta,
    schema_version: "1.0",
    state: CLAIM_STATE.CLAIMED,
    claim_key: key,
    message_id: messageId,
    logical_task_key: logicalTaskKey,
    claimed_at: new Date().toISOString(),
  });

  return { ok: true, key, dir };
}

/**
 * 记录 claim 的终态。
 *
 * 注意 handed_off 表示「已交给长期任务」，并不表示任务已完成。
 * 完成与否由出站流程独立观察，本模块不做也不允许做这个判断。
 */
export function recordClaimState({ claimsDir, key, state, detail }) {
  // 写原语自带形状守卫：评审实测 key="../../escape" 让 failed 记录写到了 claims 目录外。
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) {
    throw new Error("claim key 形状不对，拒绝写状态记录");
  }
  const file = path.join(claimsDir, key + "." + state + ".json");
  writeJsonAtomic(file, {
    ...detail,
    schema_version: "1.0",
    claim_key: key,
    state,
    recorded_at: new Date().toISOString(),
  });
  return file;
}

/**
 * 读一张已取得的 claim —— **三态，不是两态**。
 *
 *   absent      文件不在（生产里 acquireClaim 先写再起 watcher，缺席 = 被删/坏盘）
 *   valid       能读、是对象、claim_key 与目录名一致
 *   unreadable  读不出 / 不是对象 / claim_key 对不上 —— 说不清
 *
 * 两个 watcher 都靠它决定来源代际（Claude 侧还决定 outbox 归属）。上一版把三态
 * 折成 `claim | null`，null 就当 legacy 现算当前代际 —— 说不清来源却猜了个目标，
 * 正是 R2b1 回执三态那一课（第 5 层步骤 2 复核发现）。
 */
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
/** Claude 会话 id 是 Claude Code 的 uuid —— 它会参与 outbox 路径拼接，形状必须路径安全。 */
const CLAUDE_SESSION_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** 受控的策略 id/version 组合 —— 未知 policy 会绕开 dialogue 专属收口却继续走发布路径，不是无害扩展。 */
const POLICY_VERSIONS = Object.freeze({
  [MAPPING_POLICY_ID]: MAPPING_POLICY_VERSION,
  [DIALOGUE_POLICY_ID]: DIALOGUE_POLICY_VERSION,
});

/**
 * 一张 claim 要能被**解释**才算 valid：不只是"claim_key 对得上"。
 * 评审探针：`{claim_key, origin_channel_generation_id:"wrong-but-nonempty"}` 甚至
 * 只有 claim_key 的对象都被判 valid，随后两个 watcher 直接信任来源代际。
 * 固定字段 + 规范时间 + 非空来源代际 + 调用方消费的路由字段都要在；
 * 未知扩展字段允许（不封键集），缺必需身份事实的不叫 valid。
 * `expect` 由调用方给：Codex 侧交叉核对 task / thread，Claude 侧核对逻辑 task。
 */
function claimProblem(claim, key, expect) {
  if (claim.schema_version !== "1.0") return "schema_version 不认识";
  if (claim.state !== CLAIM_STATE.CLAIMED) return "state 不是 claimed";
  if (claim.claim_key !== key) return "claim_key 跟目录名对不上";
  if (!nonEmpty(claim.message_id)) return "message_id 缺失或为空";
  if (!nonEmpty(claim.logical_task_key)) return "logical_task_key 缺失或为空";
  if (!isCanonicalIso(claim.claimed_at)) return "claimed_at 不是规范时间";
  // **key 要能从身份字段重新推导出来** —— 只比 claim_key===文件名，一张字段齐全
  // 但 key 与 message/task 无关的 claim 照样 valid（评审探针）。
  if (claimKey(claim.message_id, claim.logical_task_key) !== key) {
    return "claim_key 不是由 message_id 与 logical_task_key 推导出来的";
  }
  if (!Object.hasOwn(POLICY_VERSIONS, claim.policy_id)) return "policy_id 不在受控取值里";
  if (claim.policy_version !== POLICY_VERSIONS[claim.policy_id]) return "policy_version 跟 policy_id 对不上";
  if (!usableGeneration(claim.origin_channel_generation_id)) return "origin_channel_generation_id 不是可用代际";
  if (claim.binding_id !== undefined && !nonEmpty(claim.binding_id)) return "binding_id 形状不对";
  if (claim.claude_session_id !== undefined && claim.claude_session_id !== null
    && !CLAUDE_SESSION_SHAPE.test(claim.claude_session_id)) return "claude_session_id 不是会话 uuid 的形状";
  if (claim.codex_thread_id !== undefined && !nonEmpty(claim.codex_thread_id)) return "codex_thread_id 形状不对";
  if (expect.logicalTaskKey !== undefined && claim.logical_task_key !== expect.logicalTaskKey) {
    return "logical_task_key 跟这个 task 对不上";
  }
  if (expect.codexThreadId !== undefined && claim.codex_thread_id !== expect.codexThreadId) {
    return "codex_thread_id 跟这个 task 对不上";
  }
  // Claude 侧的期望身份由 inbound 在起 watcher 时独立传入 —— claim 内字段彼此自证不算。
  if (expect.bindingId !== undefined && claim.binding_id !== expect.bindingId) {
    return "binding_id 跟 inbound 给的期望对不上";
  }
  if (expect.claudeSessionId !== undefined
    && (claim.claude_session_id ?? null) !== expect.claudeSessionId) {
    return "claude_session_id 跟 inbound 给的期望对不上";
  }
  return null;
}

export function readClaimState({ claimsDir, key, expect = {} }) {
  // **key 形状先验，任何路径派生之前** —— 路径型读写核心自带守卫，别指望每个调用方都记得。
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) {
    return { status: "unreadable", why: "key 不是 claim key 的形状" };
  }
  const file = path.join(claimsDir, key + ".claim", "claim.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); }
  catch (err) {
    if (err?.code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", why: "读不出来" };
  }
  let claim;
  try { claim = JSON.parse(raw); }
  catch { return { status: "unreadable", why: "不是 JSON" }; }
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
    return { status: "unreadable", why: "不是记录对象" };
  }
  const problem = claimProblem(claim, key, expect);
  if (problem !== null) return { status: "unreadable", why: problem };
  return { status: "valid", claim };
}

/**
 * inbound 起 Claude 守望者时传入的**期望身份** —— 两侧共用这一份契约，
 * 各写一份就会有一边漏掉/拼错变量名而静默失效。
 * 空会话（项目级绑定）编码成空串："" 明确表示"期望没有会话"，缺变量才是"没给"。
 */
const EXPECT_BINDING_VAR = "FEISHU_BRIDGE_EXPECT_BINDING_ID";
const EXPECT_SESSION_VAR = "FEISHU_BRIDGE_EXPECT_CLAUDE_SESSION_ID";
/**
 * 一个 mapping 的**有效绑定身份** —— 唯一投影。
 * 旧 project-file 映射没有 mapping.binding_id，resolveProject 兼容它并把有效 id
 * 放进 topic_generation_state.binding_id；直接读可缺省的旧字段会把这类合法映射
 * 编码成空 binding，watcher 启动即拒绝（评审探针）。claim 写入、期望 env、
 * watcher 复核都从这里取。
 */
export function effectiveBindingId(mapping) {
  const fromState = mapping?.topic_generation_state?.binding_id;
  if (nonEmpty(fromState)) return fromState;
  return nonEmpty(mapping?.binding_id) ? mapping.binding_id : null;
}
export function watcherExpectEnv(mapping) {
  return {
    [EXPECT_BINDING_VAR]: effectiveBindingId(mapping) ?? "",
    [EXPECT_SESSION_VAR]: mapping?.claude_session_id ?? "",
  };
}
export function readWatcherExpectEnv(env) {
  const bindingId = env?.[EXPECT_BINDING_VAR];
  const sessionRaw = env?.[EXPECT_SESSION_VAR];
  if (!nonEmpty(bindingId) || typeof sessionRaw !== "string") return { ok: false, reason: "expect_identity_missing" };
  return { ok: true, bindingId, claudeSessionId: sessionRaw === "" ? null : sessionRaw };
}

/** 两态视图（只给不做授权决定的读方）：valid 才给 claim，其余一律 null。 */
export function readClaim({ claimsDir, key, expect = {} }) {
  const state = readClaimState({ claimsDir, key, expect });
  return state.status === "valid" ? state.claim : null;
}
