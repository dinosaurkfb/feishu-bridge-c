/**
 * 确定性入站 selector。
 *
 * 纯函数，无 IO、无网络、无副作用 —— 因此可以被完整合成测试覆盖。
 * 唯一职责：判断一条飞书消息是否是「Frank 在本链路根话题里给目标长期任务的显式指令」。
 *
 * 设计原则：fail-closed。任何字段缺失、类型不符、无法判定的情况一律 reject，
 * 绝不因为「看起来像」而放行，也绝不猜测消息属于哪条链路。
 */

export const REJECT = {
  MAPPING_MISSING: "mapping_missing",
  MAPPING_NOT_ACTIVE: "mapping_not_active",
  MAPPING_EXPIRED: "mapping_expired",
  CHAT_MISMATCH: "chat_mismatch",
  ROOT_MISMATCH: "root_mismatch",
  SENDER_NOT_FRANK: "sender_not_frank",
  TRANSPORT_NOT_MENTIONED: "transport_not_mentioned",
  PREFIX_MISMATCH: "prefix_mismatch",
  DUPLICATE_MESSAGE: "duplicate_message",
  STALE_MESSAGE: "stale_message",
  QUOTA_EXHAUSTED: "quota_exhausted",
  MALFORMED_EVENT: "malformed_event",
};

/** 人类可读的拒绝原因 —— 直接用于回给 Frank 的「已拒绝」回执。 */
export const REJECT_TEXT = {
  [REJECT.MAPPING_MISSING]: "没有找到有效的绑定关系",
  [REJECT.MAPPING_NOT_ACTIVE]: "绑定关系不在 active 状态",
  [REJECT.MAPPING_EXPIRED]: "绑定关系已过期",
  [REJECT.CHAT_MISMATCH]: "不是绑定的群",
  [REJECT.ROOT_MISMATCH]: "不在绑定的根话题里",
  [REJECT.SENDER_NOT_FRANK]: "发送者不是授权用户",
  [REJECT.TRANSPORT_NOT_MENTIONED]: "没有真实 @ 本链路的运输 agent",
  [REJECT.PREFIX_MISMATCH]: "正文没有以约定前缀开头",
  [REJECT.DUPLICATE_MESSAGE]: "这条消息已经处理过（幂等命中）",
  [REJECT.STALE_MESSAGE]: "消息超出时效窗口",
  [REJECT.QUOTA_EXHAUSTED]: "该绑定的消息配额已用尽",
  [REJECT.MALFORMED_EVENT]: "事件结构不完整",
};

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

/**
 * 去掉飞书 mention 占位符，得到用于前缀判定的正文。
 *
 * 飞书把 @ 渲染成 `@_user_N` 占位符，真实身份在 mentions[] 里。只删占位符，
 * 不做任何其他归一化 —— 大小写、全半角箭头都必须精确匹配，避免「差不多就放行」。
 */
export function stripMentions(text, mentions) {
  let out = typeof text === "string" ? text : "";
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (isNonEmptyString(m?.key)) out = out.split(m.key).join("");
  }
  return out.replace(/^[\s ]+/, "");
}

/**
 * @returns {{decision:'accept'|'reject', reason?:string, reasonText?:string,
 *            instruction?:string, messageId?:string, logicalTaskKey?:string}}
 */
export function evaluateInbound({ event, mapping, config, now }) {
  const nowMs = typeof now === "number" ? now : Date.now();
  const reject = (reason) => ({
    decision: "reject",
    reason,
    reasonText: REJECT_TEXT[reason] ?? reason,
  });

  // 事件本身必须结构完整。缺任何一项都无法安全判定归属。
  if (
    !event ||
    !isNonEmptyString(event.message_id) ||
    !isNonEmptyString(event.chat_id) ||
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

  if (event.chat_id !== mapping.chat_id) return reject(REJECT.CHAT_MISMATCH);

  // 根话题必须精确匹配：两条链路共用一个群，root 是它们唯一的物理隔离。
  const eventRoot = event.root_message_id ?? event.parent_id;
  if (!isNonEmptyString(eventRoot) || eventRoot !== mapping.root_message_id) {
    return reject(REJECT.ROOT_MISMATCH);
  }

  if (event.sender_id !== mapping.frank_sender_id) {
    return reject(REJECT.SENDER_NOT_FRANK);
  }

  // 必须是真实 mention，不接受正文里手打的「@M5Claude」字样。
  const mentioned = (Array.isArray(event.mentions) ? event.mentions : []).some(
    (m) => m?.id?.open_id === config.transport_open_id,
  );
  if (!mentioned) return reject(REJECT.TRANSPORT_NOT_MENTIONED);

  const body = stripMentions(event.text, event.mentions);
  const prefix = mapping.inbound_prefix;
  if (!isNonEmptyString(prefix) || !body.startsWith(prefix)) {
    return reject(REJECT.PREFIX_MISMATCH);
  }

  const consumed = Array.isArray(mapping.consumed_message_ids)
    ? mapping.consumed_message_ids
    : [];
  if (consumed.includes(event.message_id)) {
    return reject(REJECT.DUPLICATE_MESSAGE);
  }

  const max = mapping.max_inbound_messages;
  if (Number.isFinite(max) && consumed.length >= max) {
    return reject(REJECT.QUOTA_EXHAUSTED);
  }

  // 时效窗口挡住重启后重放的历史消息。
  const freshnessMs = mapping.freshness_ms ?? config.default_freshness_ms;
  const createdMs = Number(event.create_time);
  if (Number.isFinite(freshnessMs)) {
    if (!Number.isFinite(createdMs)) return reject(REJECT.MALFORMED_EVENT);
    if (nowMs - createdMs > freshnessMs) return reject(REJECT.STALE_MESSAGE);
  }

  const instruction = body.slice(prefix.length).trim();
  if (!isNonEmptyString(instruction)) return reject(REJECT.PREFIX_MISMATCH);

  return {
    decision: "accept",
    instruction,
    messageId: event.message_id,
    logicalTaskKey: mapping.logical_task_key,
  };
}
