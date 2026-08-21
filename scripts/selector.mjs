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

/** 关掉次数闸的唯一写法。字面量比对，不做大小写或别名兼容 —— 见下面配额那段的理由。 */
export const UNLIMITED = "unlimited";

/**
 * 配额值合不合法。导出是为了让**写 mapping 的一方和读 mapping 的一方共用同一条规则** ——
 * 续期工具写进去的值，绝不能是这里会判成配错的值。两边各写一套，迟早写出一个
 * 「工具说配好了、入站说你配错了」的状态，而那种状态查起来最费劲。
 */
export function isValidQuota(v) {
  return v === UNLIMITED || (typeof v === "number" && Number.isInteger(v) && v > 0);
}

/**
 * 关掉前缀闸的唯一写法。
 *
 * 2026-08-19 Frank 的判断：对**路由**而言前缀是纯冗余的。能走到这一步，消息已经过了
 * 绑定有效、话题正确、发送者正确、真实 mention 四道闸，而路由到哪个项目靠的是
 * session_id（话题），前缀不参与。同群多链路的互斥，mention 对象 + 根话题已经够了。
 *
 * 它理论上还是「意图闸」（区分「对它下指令」和「在群里提到它」），但实测没起这个作用 ——
 * 17 条消息里从没触发过一次 prefix_mismatch，而 Frank 给确认类消息也照样加前缀。
 * 一道从不改变结果的闸就是纯成本，而成本是他在手机上每条都要多打几个字符。
 *
 * 和配额闸同样的处理：**关掉必须是一个决定，不能是配置漏了的副作用。**
 * 只有明写 null 才算关；字段缺失、空串、非字符串一律判配错并拒绝。
 */
export const NO_PREFIX = null;

/** 前缀值合不合法。导出理由同 isValidQuota：写配置的一方和读配置的一方共用一条规则。 */
export function isValidPrefix(v) {
  return v === NO_PREFIX || (typeof v === "string" && v.trim().length > 0);
}

export const REJECT = {
  MAPPING_MISSING: "mapping_missing",
  MAPPING_NOT_ACTIVE: "mapping_not_active",
  MAPPING_EXPIRED: "mapping_expired",
  SESSION_MISMATCH: "session_mismatch",
  SENDER_NOT_FRANK: "sender_not_frank",
  TRANSPORT_NOT_MENTIONED: "transport_not_mentioned",
  PREFIX_MISMATCH: "prefix_mismatch",
  EMPTY_INSTRUCTION: "empty_instruction",
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
  [REJECT.EMPTY_INSTRUCTION]: "消息里没有指令正文",
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

/**
 * 取出飞书自动附加的引用块正文（不含标记行本身）。
 *
 * 这段是**平台加的，不是 Frank 打的** —— 他在话题里说话时，飞书会把被回复的那条消息
 * 全文捎上。2026-08-20 统计 M5Claude 收到的全部带 mention 的消息：8/8 条都有引用块，
 * 所以它不是「回复根消息那一下才有」的特例，是这个话题里每条消息都带。
 *
 * 这一点很值钱：入站事件里没有任何飞书 locator（见本文件开头的 v2 说明），
 * 而引用块是**唯一**能把「这条消息属于哪个话题」的信息带进来的通道。
 */
export function extractQuotedBlock(content) {
  const s = String(content ?? "");
  const at = s.search(/\n\s*>?\s*\*\*\[引用\]\*\*/);
  if (at < 0) return null;
  return s.slice(at).replace(/^\s*>?\s*\*\*\[引用\]\*\*\s*/m, "").trim() || null;
}

/** 绑定码的字面形状：根消息里那行「绑定码    d85488」。 */
export const BINDING_TOKEN_RE = /绑定码\s+([0-9a-f]{6})\b/g;

/**
 * 从**引用块里**找绑定码 —— 刻意不看正文。
 *
 * 正文是 Frank 打的，引用块是平台加的。只认引用块，意味着「手打一个绑定码」不能用来
 * 指定目标；能指定目标的只有「你真的在那个话题里说话」这件事本身。
 *
 * 返回去重后的全部命中：出现多个是**歧义**，调用方必须拒绝而不是挑一个。
 */
export function bindingTokensInQuote(content) {
  const quoted = extractQuotedBlock(content);
  if (!quoted) return [];
  return [...new Set([...quoted.matchAll(BINDING_TOKEN_RE)].map((m) => m[1]))];
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

  // 配错和「明写关掉」必须导致不同结果，所以先判合法性、再判匹配。
  // 缺字段 / 空串 / 非字符串 = 配错（MALFORMED_EVENT），不是「没有前缀」。
  const prefix = mapping.inbound_prefix;
  if (!isValidPrefix(prefix)) return reject(REJECT.MALFORMED_EVENT);
  if (prefix !== NO_PREFIX && !body.startsWith(prefix)) {
    return reject(REJECT.PREFIX_MISMATCH);
  }

  const consumed = Array.isArray(mapping.consumed_message_ids)
    ? mapping.consumed_message_ids
    : [];
  if (consumed.includes(event.message_id)) return reject(REJECT.DUPLICATE_MESSAGE);

  // 配额和时效都必须真的配了才算数。缺字段时旧版会跳过检查（fail-open），
  // 那等于「配置写错就没有上限、没有时效」—— 与本文件的 fail-closed 原则相悖。
  //
  // 配额可以显式关掉（2026-08-19 Frank 决定）：次数闸和有效期闸守的是同一件事 ——
  // 一条绑定最多能造成多少次自动执行 —— 留时间那道就够，两道是冗余。
  // 但「无限」必须是明写出来的字面量，绝不能是字段漏了、写错了的副作用：
  // 前者是一个决定，后者是一次事故，它们不该导致同一个结果。
  //
  // 这里刻意不做 Number() 强制转换。旧版转过，于是 `true` 被转成 1，配额悄悄变成「1 条」
  // 而不是被判成配错 —— 一个布尔值笔误就能改掉准入条件，还改得没人看得见。
  // fail-closed 要求类型也 fail-closed：不是数字就是配错，不猜它想表达什么。
  const max = mapping.max_inbound_messages;
  if (!isValidQuota(max)) return reject(REJECT.MALFORMED_EVENT);
  if (max !== UNLIMITED && consumed.length >= max) return reject(REJECT.QUOTA_EXHAUSTED);

  // 同上：时效窗口也只认真正的数字。这道闸转错方向是 fail-closed（`true` → 1ms → 全拒），
  // 不像配额那样危险，但同一个笔误在两个字段上给出两种结局才是真的难查。
  const freshnessMs = mapping.freshness_ms ?? config.default_freshness_ms;
  const createdMs = Number(event.created_at_ms);
  if (typeof freshnessMs !== "number" || !Number.isFinite(freshnessMs) || freshnessMs <= 0) {
    return reject(REJECT.MALFORMED_EVENT);
  }
  if (!Number.isFinite(createdMs)) return reject(REJECT.MALFORMED_EVENT);
  if (nowMs - createdMs > freshnessMs) return reject(REJECT.STALE_MESSAGE);

  // 关了前缀就整段正文都是指令；开着就切掉前缀。
  const instruction = (prefix === NO_PREFIX ? body : body.slice(prefix.length)).trim();
  // 空正文单独一个原因：以前复用 PREFIX_MISMATCH，那在关掉前缀之后就是句谎话了。
  if (!isNonEmptyString(instruction)) return reject(REJECT.EMPTY_INSTRUCTION);

  return {
    decision: "accept",
    instruction,
    messageId: event.message_id,
    logicalTaskKey: mapping.logical_task_key,
  };
}
