/**
 * 确定性入站 selector（v2 / Aily 命名空间）。
 *
 * v1 假设能拿到飞书 locator（om_/oc_/ou_），2026-08-19 实测证伪：Aily 投递给 M5Claude 的
 * 是平台归一化后的消息，不含任何飞书 locator。v2 改用 Aily 自己的标识符，六项校验一项不少：
 *
 *   飞书 message_id  → 平台 message.id (msg_)
 *   飞书 sender ou_  → 平台 createdBy (user id)
 *   chat_id+root_id  → sessionID（实测：话题群里一个话题对应一个 session）
 *
 * 纯函数，无 IO。fail-closed：任何字段缺失或不匹配一律 reject，绝不猜测。
 */

export const REJECT = {
  MAPPING_MISSING: "mapping_missing",
  MAPPING_NOT_ACTIVE: "mapping_not_active",
  MAPPING_EXPIRED: "mapping_expired",
  SESSION_MISMATCH: "session_mismatch",
  SENDER_NOT_FRANK: "sender_not_frank",
  TRANSPORT_NOT_MENTIONED: "transport_not_mentioned",
  PREFIX_MISMATCH: "prefix_mismatch",
  DUPLICATE_MESSAGE: "duplicate_message",
  STALE_MESSAGE: "stale_message",
  QUOTA_EXHAUSTED: "quota_exhausted",
  MALFORMED_EVENT: "malformed_event",
};

export const REJECT_TEXT = {
  [REJECT.MAPPING_MISSING]: "没有找到有效的绑定关系",
  [REJECT.MAPPING_NOT_ACTIVE]: "绑定关系不在 active 状态",
  [REJECT.MAPPING_EXPIRED]: "绑定关系已过期",
  [REJECT.SESSION_MISMATCH]: "不在绑定的话题里",
  [REJECT.SENDER_NOT_FRANK]: "发送者不是授权用户",
  [REJECT.TRANSPORT_NOT_MENTIONED]: "没有真实 @ 本链路的运输 agent",
  [REJECT.PREFIX_MISMATCH]: "正文没有以约定前缀开头",
  [REJECT.DUPLICATE_MESSAGE]: "这条消息已经处理过（幂等命中）",
  [REJECT.STALE_MESSAGE]: "消息超出时效窗口",
  [REJECT.QUOTA_EXHAUSTED]: "该绑定的消息配额已用尽",
  [REJECT.MALFORMED_EVENT]: "事件结构不完整",
};

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const AT_TAG = /<at\s+id="([^"]*)"[^>]*>.*?<\/at>/gs;

/** 提取正文里所有 <at> 的 id。这是本链路唯一可验证的「真实 mention」信号。 */
export function extractMentionIds(content) {
  const ids = [];
  for (const m of String(content ?? "").matchAll(AT_TAG)) ids.push(m[1]);
  return ids;
}

/**
 * 去掉 <at> 标签和飞书追加的引用块，得到 Frank 真正写的那句话。
 *
 * 引用块是平台在被回复的消息下自动附加的，不是 Frank 的输入，
 * 必须在前缀判定之前切掉，否则指令正文会混入根消息全文。
 */
export function normalizeBody(content) {
  let s = String(content ?? "").replace(AT_TAG, "");
  const quoteAt = s.search(/\n\s*>?\s*\*\*\[引用\]\*\*/);
  if (quoteAt >= 0) s = s.slice(0, quoteAt);
  return s.replace(/^[\s ]+/, "").replace(/[\s ]+$/, "");
}

export function evaluateInbound({ event, mapping, config, now }) {
  const nowMs = typeof now === "number" ? now : Date.now();
  const reject = (reason) => ({
    decision: "reject",
    reason,
    reasonText: REJECT_TEXT[reason] ?? reason,
  });

  if (
    !event ||
    !isNonEmptyString(event.message_id) ||
    !isNonEmptyString(event.session_id) ||
    !isNonEmptyString(event.sender_id)
  ) {
    return reject(REJECT.MALFORMED_EVENT);
  }

  if (!mapping) return reject(REJECT.MAPPING_MISSING);
  if (mapping.status !== "active") return reject(REJECT.MAPPING_NOT_ACTIVE);

  const expiresAt = Date.parse(mapping.expires_at ?? "");
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) {
    return reject(REJECT.MAPPING_EXPIRED);
  }

  // session 即话题。两条链路共用一个飞书群，这是它们唯一的物理隔离。
  if (event.session_id !== mapping.session_id) {
    return reject(REJECT.SESSION_MISMATCH);
  }

  if (event.sender_id !== mapping.frank_sender_id) {
    return reject(REJECT.SENDER_NOT_FRANK);
  }

  // 必须是真实 <at> 标签，不接受正文里手打的「@M5Claude」字样。
  // 注意 open_id 按 app 隔离：这里比的是 M5Claude 自己 app 视角下的 id。
  if (!extractMentionIds(event.content).includes(config.transport_open_id)) {
    return reject(REJECT.TRANSPORT_NOT_MENTIONED);
  }

  const body = normalizeBody(event.content);
  const prefix = mapping.inbound_prefix;
  if (!isNonEmptyString(prefix) || !body.startsWith(prefix)) {
    return reject(REJECT.PREFIX_MISMATCH);
  }

  const consumed = Array.isArray(mapping.consumed_message_ids)
    ? mapping.consumed_message_ids
    : [];
  if (consumed.includes(event.message_id)) return reject(REJECT.DUPLICATE_MESSAGE);

  // 配额和时效都必须真的配了才算数。缺字段时旧版会跳过检查（fail-open），
  // 那等于「配置写错就没有上限、没有时效」—— 与本文件的 fail-closed 原则相悖。
  const max = Number(mapping.max_inbound_messages);
  if (!Number.isFinite(max) || max <= 0) return reject(REJECT.MALFORMED_EVENT);
  if (consumed.length >= max) return reject(REJECT.QUOTA_EXHAUSTED);

  const freshnessMs = Number(mapping.freshness_ms ?? config.default_freshness_ms);
  const createdMs = Number(event.created_at_ms);
  if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) return reject(REJECT.MALFORMED_EVENT);
  if (!Number.isFinite(createdMs)) return reject(REJECT.MALFORMED_EVENT);
  if (nowMs - createdMs > freshnessMs) return reject(REJECT.STALE_MESSAGE);

  const instruction = body.slice(prefix.length).trim();
  if (!isNonEmptyString(instruction)) return reject(REJECT.PREFIX_MISMATCH);

  return {
    decision: "accept",
    instruction,
    messageId: event.message_id,
    logicalTaskKey: mapping.logical_task_key,
  };
}
