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

export function readClaim({ claimsDir, key }) {
  const file = path.join(claimsDir, key + ".claim", "claim.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
