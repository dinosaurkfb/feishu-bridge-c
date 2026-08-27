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

  writeJsonAtomic(path.join(dir, "claim.json"), {
    schema_version: "1.0",
    state: CLAIM_STATE.CLAIMED,
    claim_key: key,
    message_id: messageId,
    logical_task_key: logicalTaskKey,
    claimed_at: new Date().toISOString(),
    ...meta,
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
  const file = path.join(claimsDir, key + "." + state + ".json");
  writeJsonAtomic(file, {
    schema_version: "1.0",
    claim_key: key,
    state,
    recorded_at: new Date().toISOString(),
    ...detail,
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
export function readClaimState({ claimsDir, key }) {
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
  if (claim.claim_key !== key) return { status: "unreadable", why: "claim_key 跟目录名对不上" };
  return { status: "valid", claim };
}

/** 两态视图（只给不做授权决定的读方）：valid 才给 claim，其余一律 null。 */
export function readClaim({ claimsDir, key }) {
  const state = readClaimState({ claimsDir, key });
  return state.status === "valid" ? state.claim : null;
}
