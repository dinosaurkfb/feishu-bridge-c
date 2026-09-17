#!/usr/bin/env node
/**
 * 飞书入站跨会话转发凭证校验器（issue #217）。
 *
 * 桥把飞书消息送进现场会话的唯一受支持入口是 SendMessage（live-session.mjs），
 * 目标会话收到的均为 <cross-session-message>。
 * 接收方（如 my-herdr）在执行授权级指令前，调用本校验器核验入站回执：
 * 1. 回执存在且可读（receipt_missing）
 * 2. 状态为已受理且已交接（not_handed_off）
 * 3. 发送者角色确为 owner（sender_not_owner）
 * 4. 目标会话匹配当前会话（target_mismatch）
 * 5. 投递编号匹配本次投递（nonce_mismatch）
 * 6. 正文 sha256 匹配入站原文（body_mismatch）
 *
 * 本模块为纯只读校验，零文件写入，无副作用。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";

export const VERIFY_REASONS = {
  RECEIPT_MISSING: "receipt_missing",
  NOT_HANDED_OFF: "not_handed_off",
  SENDER_NOT_OWNER: "sender_not_owner",
  TARGET_MISMATCH: "target_mismatch",
  NONCE_MISMATCH: "nonce_mismatch",
  BODY_MISMATCH: "body_mismatch",
};

/** 剥除转发正文末尾附带的机器可读凭证行与引导说明。 */
export function stripCredentialFooter(text) {
  if (typeof text !== "string") return text;
  return text.replace(/(?:\r?\n)+\s*\[飞书凭证\s+message_id=[^\s]+[\s\S]*$/u, "");
}

/** 剥除 [飞书 · message_id · timestamp] 头部。 */
export function stripFeishuHeader(text) {
  if (typeof text !== "string") return text;
  return text.replace(/^\[飞书\s*·\s*[^·\r\n]+\s*·\s*[^\]\r\n]+\]\r?\n/, "");
}

/** 从正文或任意字符串中解析凭证行。 */
export function parseRelayCredentialLine(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/\[飞书凭证\s+message_id=([^\s]+)\s+nonce=([^\s]+)\s+body_sha256=([^\s]+)\s+receipt=([^\s\]]+)\]/);
  if (!match) return null;
  return {
    messageId: match[1],
    nonce: match[2],
    bodySha256: match[3],
    receipt: match[4],
  };
}

/**
 * 校验入站转发凭证（纯函数，只读）。
 *
 * @param {Object} params
 * @param {string} [params.projectRoot] 项目根目录（默认 process.cwd()）
 * @param {string} params.messageId 飞书消息 ID
 * @param {string} params.nonce 投递随机数
 * @param {string} [params.bodySha256] 正文 SHA-256 校验值
 * @param {string} [params.sessionId] 接收方会话 ID（提供时核验 target_session_id）
 * @param {string} [params.body] 接收到的消息正文（或原始 instruction）
 * @returns {{ ok: boolean, reason?: string, [key: string]: any }}
 */
export function verifyRelayCredential({
  projectRoot = process.cwd(),
  messageId,
  nonce,
  bodySha256,
  sessionId,
  body,
} = {}) {
  if (!messageId || typeof messageId !== "string") {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  const receiptPath = path.join(
    projectRoot,
    ".runtime-data",
    "inbound",
    "receipts",
    `accepted-${messageId}.json`,
  );

  let receipt;
  try {
    const raw = fs.readFileSync(receiptPath, "utf8");
    receipt = JSON.parse(raw);
  } catch {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  if (!receipt || typeof receipt !== "object") {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  // 1. 状态必须为 accepted 且已 handed_off
  if (receipt.status !== "accepted" || receipt.handed_off !== true) {
    return { ok: false, reason: VERIFY_REASONS.NOT_HANDED_OFF };
  }

  // 2. 发送者角色必须是 owner（路由层判定结果，非转发方声明）
  if (receipt.sender_role !== "owner") {
    return { ok: false, reason: VERIFY_REASONS.SENDER_NOT_OWNER };
  }

  // 3. 若提供会话 ID，目标会话必须匹配
  if (sessionId !== undefined && sessionId !== null) {
    if (receipt.target_session_id !== sessionId) {
      return { ok: false, reason: VERIFY_REASONS.TARGET_MISMATCH };
    }
  }

  // 4. 投递随机数必须一致
  if (!nonce || typeof nonce !== "string" || receipt.delivery_nonce !== nonce) {
    return { ok: false, reason: VERIFY_REASONS.NONCE_MISMATCH };
  }

  // 5. 正文哈希核验（凭证行不计入哈希）
  const expectedHash = receipt.body_sha256;
  if (!expectedHash || typeof expectedHash !== "string") {
    return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
  }

  if (typeof bodySha256 === "string" && bodySha256.length > 0) {
    if (bodySha256 !== expectedHash) {
      return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
    }
  }

  if (typeof body === "string") {
    // 候选正文：
    // c1: 传入的 body 原样
    // c2: 剥除末尾凭证与引导语
    // c3: 剥除末尾凭证与 [飞书 · ...] 头部
    // c4: 仅剥除头部
    const c1 = body;
    const c2 = stripCredentialFooter(c1);
    const c3 = stripFeishuHeader(c2);
    const c4 = stripFeishuHeader(c1);
    const candidates = [c1, c2, c3, c4];

    const matched = candidates.some((cand) => {
      const h = crypto.createHash("sha256").update(cand, "utf-8").digest("hex");
      return h === expectedHash;
    });

    if (!matched) {
      return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
    }
  } else if (!bodySha256) {
    return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
  }

  return {
    ok: true,
    messageId,
    senderRole: receipt.sender_role,
    targetSessionId: receipt.target_session_id ?? null,
    deliveryNonce: receipt.delivery_nonce,
    bodySha256: receipt.body_sha256,
    receiptPath,
  };
}

/** CLI 入口 */
export function runCli(argv = process.argv.slice(2)) {
  let projectRoot = process.cwd();
  let messageId = null;
  let nonce = null;
  let bodySha256 = null;
  let sessionId = null;
  let body = null;
  let bodyFile = null;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && i + 1 < argv.length) {
      projectRoot = argv[++i];
    } else if (arg === "--message-id" && i + 1 < argv.length) {
      messageId = argv[++i];
    } else if (arg === "--nonce" && i + 1 < argv.length) {
      nonce = argv[++i];
    } else if (arg === "--body-sha256" && i + 1 < argv.length) {
      bodySha256 = argv[++i];
    } else if (arg === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (arg === "--body" && i + 1 < argv.length) {
      body = argv[++i];
    } else if (arg === "--body-file" && i + 1 < argv.length) {
      bodyFile = argv[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write([
        "Usage: node scripts/verify-relay-credential.mjs [options]",
        "",
        "Options:",
        "  --project <root>      项目根目录（默认当前目录）",
        "  --message-id <id>     飞书消息 ID",
        "  --nonce <hex>         投递随机数",
        "  --session-id <id>     期望目标会话 ID",
        "  --body <text>         接收到的正文",
        "  --body-file <path>    包含接收正文的文件路径",
        "  --body-sha256 <hex>   期望正文 SHA-256",
        "  --json                以 JSON 格式输出结果",
        "  -h, --help            显示帮助",
      ].join("\n") + "\n");
      process.exit(0);
    }
  }

  if (bodyFile && body === null) {
    try {
      body = fs.readFileSync(bodyFile, "utf8");
    } catch (err) {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify({ ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING, error: err.message }) + "\n");
      } else {
        process.stderr.write(`[verify-relay-credential] 无法读取正文文件: ${err.message}\n`);
      }
      process.exit(1);
    }
  }

  // 尝试从 body 提取未显式指定的凭证信息
  if (typeof body === "string") {
    const parsed = parseRelayCredentialLine(body);
    if (parsed) {
      if (!messageId) messageId = parsed.messageId;
      if (!nonce) nonce = parsed.nonce;
      if (!bodySha256) bodySha256 = parsed.bodySha256;
    }
  }

  const result = verifyRelayCredential({
    projectRoot,
    messageId,
    nonce,
    bodySha256,
    sessionId: sessionId ?? undefined,
    body,
  });

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.ok) {
    process.stdout.write(`[verify-relay-credential] 凭证校验通过 (message_id=${result.messageId}, sender_role=${result.senderRole})\n`);
  } else {
    process.stderr.write(`[verify-relay-credential] 凭证校验失败: ${result.reason}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

if (isDirectRun(import.meta.url)) {
  runCli();
}
