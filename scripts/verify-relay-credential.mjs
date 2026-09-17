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
  RECEIPT_PATH_ESCAPE: "receipt_path_escape",
  RECEIPT_MISMATCH: "receipt_mismatch",
  NOT_HANDED_OFF: "not_handed_off",
  SENDER_NOT_OWNER: "sender_not_owner",
  TARGET_MISMATCH: "target_mismatch",
  NONCE_MISMATCH: "nonce_mismatch",
  BODY_MISMATCH: "body_mismatch",
  BODY_REQUIRED: "body_required",
  SESSION_REQUIRED: "session_required",
  TRAILING_CONTENT: "trailing_content",
};

const MESSAGE_ID_SHAPE = /^(?:om_|msg_)[A-Za-z0-9_-]{1,128}$/u;
const VALID_ARTIFACT_TYPES = new Set([
  "claude_bridge_inbound_receipt",
  "codex_feishu_bridge_inbound_receipt",
]);
const VALID_SCHEMA_VERSIONS = new Set(["1.0"]);

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
  const match = text.match(/\[飞书凭证\s+message_id=([^\s]+)\s+nonce=([^\s]+)\s+body_sha256=([^\s]+)\s+receipt=([^\s\]]+)\]/u);
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
 * @param {string} [params.messageId] 飞书消息 ID（可由 body 自动解析）
 * @param {string} [params.nonce] 投递随机数（可由 body 自动解析）
 * @param {string} [params.bodySha256] 正文 SHA-256 交叉核验值（可选）
 * @param {string} params.sessionId 接收方会话 ID（必填，核验 target_session_id）
 * @param {string} params.body 接收到的消息正文（必填）
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
  // P1-1: sessionId 与 body 为必填项，缺任一返回封闭原因
  if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return { ok: false, reason: VERIFY_REASONS.SESSION_REQUIRED };
  }
  if (!body || typeof body !== "string" || body.length === 0) {
    return { ok: false, reason: VERIFY_REASONS.BODY_REQUIRED };
  }

  // 尝试从 body 提取未显式指定的凭证信息，并严格核验尾部完整性
  const credLinePattern = /(?:\r?\n|^)\s*\[飞书凭证\s+message_id=([^\s]+)\s+nonce=([^\s]+)\s+body_sha256=([^\s]+)\s+receipt=([^\s\]]+)\]/u;
  const match = credLinePattern.exec(body);
  let resolvedMessageId = messageId;
  let resolvedNonce = nonce;
  let callerBodySha256 = bodySha256;
  let bodyForHash = body;

  if (match) {
    if (!resolvedMessageId) resolvedMessageId = match[1];
    if (!resolvedNonce) resolvedNonce = match[2];
    if (!callerBodySha256) callerBodySha256 = match[3];

    // P1-2: 凭证行必须是正文最后一个非空行（可紧随引导说明），之后若有任何额外非空内容则拒
    const afterMatch = body.slice(match.index + match[0].length);
    const afterCleaned = afterMatch.replace(/^\s*(?:授权级指令请先用\s+scripts\/verify-relay-credential\.mjs\s+核回执)?\s*$/u, "");
    if (afterCleaned.length > 0) {
      return { ok: false, reason: VERIFY_REASONS.TRAILING_CONTENT };
    }
    bodyForHash = body.slice(0, match.index).replace(/\r?\n+$/u, "");
  }

  if (!resolvedMessageId || typeof resolvedMessageId !== "string") {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  // P1-3: 检查 messageId 封闭形状，拒绝任何路径穿越符号
  if (!MESSAGE_ID_SHAPE.test(resolvedMessageId)) {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_PATH_ESCAPE };
  }

  // P1-3: 固定回执路径并核 realpath containment
  const receiptsDir = path.join(projectRoot, ".runtime-data", "inbound", "receipts");
  const receiptPath = path.join(receiptsDir, `accepted-${resolvedMessageId}.json`);

  if (!fs.existsSync(receiptPath)) {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  let realReceiptsDir;
  try {
    realReceiptsDir = fs.realpathSync(receiptsDir);
  } catch {
    realReceiptsDir = path.resolve(receiptsDir);
  }

  let realReceiptPath;
  try {
    realReceiptPath = fs.realpathSync(receiptPath);
  } catch {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  if (!realReceiptPath.startsWith(realReceiptsDir + path.sep)) {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_PATH_ESCAPE };
  }

  let receipt;
  try {
    const raw = fs.readFileSync(realReceiptPath, "utf8");
    receipt = JSON.parse(raw);
  } catch {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  if (!receipt || typeof receipt !== "object") {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISSING };
  }

  // P1-3: 核 artifact_type, schema_version, message_id
  if (
    !VALID_ARTIFACT_TYPES.has(receipt.artifact_type) ||
    !VALID_SCHEMA_VERSIONS.has(receipt.schema_version) ||
    receipt.message_id !== resolvedMessageId
  ) {
    return { ok: false, reason: VERIFY_REASONS.RECEIPT_MISMATCH };
  }

  // 1. 状态必须为 accepted 且已 handed_off
  if (receipt.status !== "accepted" || receipt.handed_off !== true) {
    return { ok: false, reason: VERIFY_REASONS.NOT_HANDED_OFF };
  }

  // 2. 发送者角色必须是 owner（路由层判定结果，非转发方声明）
  if (receipt.sender_role !== "owner") {
    return { ok: false, reason: VERIFY_REASONS.SENDER_NOT_OWNER };
  }

  // 3. 目标会话必须匹配
  if (receipt.target_session_id !== sessionId) {
    return { ok: false, reason: VERIFY_REASONS.TARGET_MISMATCH };
  }

  // 4. 投递随机数必须一致
  if (!resolvedNonce || typeof resolvedNonce !== "string" || receipt.delivery_nonce !== resolvedNonce) {
    return { ok: false, reason: VERIFY_REASONS.NONCE_MISMATCH };
  }

  // 5. 正文哈希核验（由校验器从 body 计算，不接受入参替代）
  const expectedHash = receipt.body_sha256;
  if (!expectedHash || typeof expectedHash !== "string") {
    return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
  }

  if (typeof callerBodySha256 === "string" && callerBodySha256.length > 0) {
    if (callerBodySha256 !== expectedHash) {
      return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
    }
  }

  const c1 = bodyForHash;
  const c2 = stripFeishuHeader(c1);
  const candidates = [c1, c2];

  const matched = candidates.some((cand) => {
    const h = crypto.createHash("sha256").update(cand, "utf-8").digest("hex");
    return h === expectedHash;
  });

  if (!matched) {
    return { ok: false, reason: VERIFY_REASONS.BODY_MISMATCH };
  }

  return {
    ok: true,
    messageId: resolvedMessageId,
    senderRole: receipt.sender_role,
    targetSessionId: receipt.target_session_id ?? null,
    deliveryNonce: receipt.delivery_nonce,
    bodySha256: receipt.body_sha256,
    receiptPath: realReceiptPath,
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
        "  --session-id <id>     期望目标会话 ID（必填）",
        "  --body <text>         接收到的正文",
        "  --body-file <path>    包含接收正文的文件路径（与 --body 选一，必填）",
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

  // P1-1: CLI 同样必填 --session-id 与 --body / --body-file
  if (!sessionId) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ok: false, reason: VERIFY_REASONS.SESSION_REQUIRED }) + "\n");
    } else {
      process.stderr.write(`[verify-relay-credential] 缺少必填参数: --session-id\n`);
    }
    process.exit(1);
  }

  if (!body) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ok: false, reason: VERIFY_REASONS.BODY_REQUIRED }) + "\n");
    } else {
      process.stderr.write(`[verify-relay-credential] 缺少必填参数: --body 或 --body-file\n`);
    }
    process.exit(1);
  }

  // 尝试从 body 提取未显式指定的凭证信息
  const parsed = parseRelayCredentialLine(body);
  if (parsed) {
    if (!messageId) messageId = parsed.messageId;
    if (!nonce) nonce = parsed.nonce;
    if (!bodySha256) bodySha256 = parsed.bodySha256;
  }

  const result = verifyRelayCredential({
    projectRoot,
    messageId,
    nonce,
    bodySha256,
    sessionId,
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
