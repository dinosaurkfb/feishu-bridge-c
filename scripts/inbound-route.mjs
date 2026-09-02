/**
 * 入站路由：这条消息属于哪个项目。
 *
 * 在这之前 inbound.mjs 是**单绑定写死**的 —— claims、回执、runs、锁、mapping 全挂在
 * 本仓库的固定路径上，技能里那条命令没有参数。能选对绑定，是因为 mention + session
 * 两道闸恰好只有一种可能。第二个项目一接进来就会撞。
 *
 * 顺序上没有死结：取信封只依赖 daemon 注入的环境变量（envelope.mjs），不读任何项目配置。
 * 所以可以先拿到 session_id，再决定读谁的配置、投给哪个项目。
 *
 * 两件事：
 *   1. 已绑定的 —— session_id 对上哪个项目的 mapping，就是哪个。
 *   2. 还没绑的 —— 建话题时 Aily session 还不存在（它是第一条消息流进来才产生的），
 *      所以绑定必然分两段。第二段就是 Frank 在新话题里 @ 的那一下。
 */

import fs from "node:fs";
import { senderRole } from "./sender-roles.mjs";
import path from "node:path";

import { loadChainTemplate, p2pChatIdProblem } from "./chain-template.mjs";
import {
  acquirePublishLock, loadRegistry, registryPath, releasePublishLock,
} from "./registry.mjs";
import {
  appendConsumed, loadConsumed, projectMappingPath, resolveProject,
} from "./project-resolve.mjs";
import { bindingTokensInQuote, extractMentionIds } from "./selector.mjs";
import {
  MESSAGE_RECEIVE_EVENT, buildLegacySubscriptionReadModel, compareFirstClaimShadow,
  legacyEndpointId, selectPendingSubscriptionClaim, stableControlId,
} from "./subscription.mjs";
import {
  activatePendingTopicGeneration, materializeLegacyTopicFields, pendingGeneration,
  topicGenerationStateForLegacy, effectiveBindingId,
  generationForSession,
} from "./topic-generation.mjs";

// 幂等列表住在 project-resolve（它是更低层的那个模块），从这里转出去，
// 免得 inbound.mjs 为了一件事 import 两个模块。
export { appendConsumed, loadConsumed };

/**
 * 待绑定**不过期**（2026-08-28，Frank 定的）：登记行 / 代际写了显式截止才按它过期，否则永不过期。
 * 取消是唯一的显式出口（/feishu-rotate cancel）。
 *
 * 以前用有限窗口守的是"一份忘在那儿的待绑定会把下一次在任何地方的 @ 都算成它的"——
 * 现在靠根消息引用块里的**绑定码精确匹配**（多份并存时）和"只有一份"时的直接命中，
 * 不再靠时间。这里没有"窗口长度"这个常量了 —— 别再加回来。
 */
export const PENDING_WINDOW_MS = null;

export const PROMOTE_REJECT = {
  NO_PENDING: "no_pending_binding",
  MULTIPLE_PENDING: "multiple_pending_bindings",
  TOKEN_UNKNOWN: "binding_token_unknown",
  TOKEN_AMBIGUOUS: "multiple_binding_tokens",
  TOKEN_DUPLICATED: "duplicate_pending_binding_token",
  PENDING_EXPIRED: "pending_binding_expired",
  SENDER_NOT_FRANK: "sender_not_frank",
  TRANSPORT_NOT_MENTIONED: "transport_not_mentioned",
  STALE_MESSAGE: "stale_message",
  MALFORMED_TEMPLATE: "malformed_template",
};

export const PROMOTE_REJECT_TEXT = {
  [PROMOTE_REJECT.NO_PENDING]: "这个话题没有绑定任何项目，也没有等待绑定的项目",
  [PROMOTE_REJECT.MULTIPLE_PENDING]: "同时有多个项目在等待绑定，而这条消息里没带上绑定码，认不出该绑哪个",
  [PROMOTE_REJECT.TOKEN_UNKNOWN]: "根消息引用里的绑定码不对应任何等待绑定的项目",
  [PROMOTE_REJECT.TOKEN_AMBIGUOUS]: "根消息引用里出现了多个绑定码，无法确定目标",
  [PROMOTE_REJECT.TOKEN_DUPLICATED]: "多个等待绑定的项目用了同一个绑定码，无法确定目标",
  [PROMOTE_REJECT.PENDING_EXPIRED]: "这份等待绑定写了截止时间且已过期，需要重新接入",
  [PROMOTE_REJECT.SENDER_NOT_FRANK]: "发送者不是授权用户",
  [PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED]: "没有真实 @ 本链路的运输 agent",
  [PROMOTE_REJECT.STALE_MESSAGE]: "消息超出时效窗口",
  [PROMOTE_REJECT.MALFORMED_TEMPLATE]: "机器级链路配置不完整",
};

/** 登记表里每个项目解析一遍。解析不出来的静默跳过 —— 一个项目配坏了不该让别的项目也收不到消息。 */
export function listBindings({ registryFile, templateFile } = {}) {
  const reg = loadRegistry(registryFile);
  if (!reg.ok) return { ok: false, reason: "registry_unreadable", error: reg.error ?? reg.reason, bindings: [] };

  const bindings = [];
  let skipped = 0;
  for (const p of reg.projects) {
    const r = resolveProject({
      root: p.root,
      claudeSessionId: p.claude_session_id,
      registryFile,
      templateFile,
    });
    // 解析不出来的跳过、但**记数**：路由到别的项目照常，可"这个 session 到底有没有绑定"在有跳过项时就说不清了（chat 兜底不许在说不清时进）。
    if (!r.ok) { skipped += 1; continue; }
    bindings.push({
      root: p.root,
      id: p.id,
      entry: p,
      config: r.config,
      mapping: r.mapping,
      source: r.source,
      claudeSessionId: r.claudeSessionId ?? p.claude_session_id ?? null,
    });
  }
  return { ok: true, bindings, skipped };
}

/**
 * session_id → 绑定。
 *
 * 只认 status === "active"。session 要么是当前代际的（mapping.session_id 严格相等），要么是
 * 某个 read-only 历史代际的（2026-08-28 goal 第 2 层：老话题也能下指令，回复发回原话题）。
 * null 跟任何真实 session 都不相等，所以还没绑的项目永远不会在这里被选中 —— 它们只能走 promotion。
 * 返回里带 originGenerationId / originGenerationStatus：出站据此把回复冻结到来源话题。
 */
export function findBindingForSession({ sessionId, registryFile, templateFile } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "no_session_id" };
  const listed = listBindings({ registryFile, templateFile });
  if (!listed.ok) return { ok: false, reason: listed.reason, error: listed.error };

  const hits = [];
  for (const b of listed.bindings) {
    if (b.mapping?.status !== "active") continue;
    if (b.mapping?.session_id === sessionId) {
      hits.push({ ok: true, ...b, originGenerationId: b.mapping.channel_generation_id ?? null, originGenerationStatus: "active" });
      continue;
    }
    const historic = generationForSession(b.mapping?.topic_generation_state ?? null, sessionId);
    if (historic && historic.status === "read-only") {
      hits.push({ ok: true, ...b, originGenerationId: historic.channel_generation_id, originGenerationStatus: "read-only" });
    }
  }
  // 命中多条说不清是谁的：不按登记顺序取第一条（评审探针）。
  if (hits.length > 1) return { ok: false, reason: "ambiguous_session", candidates: hits.length };
  if (hits.length === 1) return hits[0];
  // 有读不出的登记项时，"没绑定"是说不清的：只有全部候选都读清了、且都对不上，才是确定的未绑定
  if ((listed.skipped ?? 0) > 0) return { ok: false, reason: "unresolved_bindings", candidates: listed.bindings.length, skipped: listed.skipped };
  return { ok: false, reason: "no_binding_for_session", candidates: listed.bindings.length };
}

// 只有写了显式截止的登记行才会过期；没写（或 null）= 不过期。
const pendingDeadline = (entry) => {
  const explicit = Date.parse(entry?.pending_expires_at ?? "");
  return Number.isFinite(explicit) ? explicit : Infinity;
};

/**
 * 认领哪一份待绑定。
 *
 * 两条路，优先用确定性那条：
 *
 *   1. **引用块里带着绑定码** → 精确选中。飞书会把根消息全文自动捎在每条消息后面
 *      （2026-08-20 实测 8/8 条都有），所以 Frank **什么都不用打** —— 他只要在那个话题里
 *      说话，绑定码就跟过来了。这条路对「同时有多个项目等待接入」也成立。
 *   2. 没有绑定码 → 回落到「全机只有一份待绑定」。单项目的人走的一直是这条，行为不变；
 *      多于一份就拒绝，绝不挑一个。
 *
 * 绑定码只从**引用块**里认，不看正文：正文是 Frank 打的，引用块是平台加的。
 * 手打一个码不能用来指定目标 —— 能指定目标的只有「你真的在那个话题里说话」这件事本身。
 */
export function findPendingBinding({ content, registryFile, templateFile, now = Date.now() } = {}) {
  const listed = listBindings({ registryFile, templateFile });
  if (!listed.ok) return { ok: false, reason: listed.reason };

  const pending = listed.bindings.flatMap((binding) => {
    const generation = pendingGeneration(binding.mapping?.topic_generation_state);
    return generation ? [{ ...binding, generation }] : [];
  });
  if (pending.length === 0) return { ok: false, reason: PROMOTE_REJECT.NO_PENDING };

  const tokens = bindingTokensInQuote(content);
  if (tokens.length > 1) {
    return { ok: false, reason: PROMOTE_REJECT.TOKEN_AMBIGUOUS, tokens };
  }

  let one;
  if (tokens.length === 1) {
    const hits = pending.filter((b) => b.generation?.pending_token === tokens[0]);
    // 认得出码但没人认领：与其回落到「只有一份」猜一个，不如明说 —— 回落会在
    // 「Frank 在 A 话题说话、而待绑定的是 B」时把 B 绑给 A，静默且难查。
    if (hits.length === 0) {
      return { ok: false, reason: PROMOTE_REJECT.TOKEN_UNKNOWN, token: tokens[0] };
    }
    if (hits.length > 1) {
      return { ok: false, reason: PROMOTE_REJECT.TOKEN_DUPLICATED, token: tokens[0],
        ids: hits.map((b) => b.id) };
    }
    one = hits[0];
  } else {
    if (pending.length > 1) {
      return { ok: false, reason: PROMOTE_REJECT.MULTIPLE_PENDING, ids: pending.map((b) => b.id) };
    }
    one = pending[0];
  }

  const generationDeadline = Date.parse(one.generation?.claim_expires_at ?? "");
  const deadline = Number.isFinite(generationDeadline)
    ? generationDeadline
    : pendingDeadline(one.entry);
  if (now >= deadline) {
    return {
      ok: false,
      reason: PROMOTE_REJECT.PENDING_EXPIRED,
      id: one.id,
      root: one.root,
      source: one.source,
      claudeSessionId: one.claudeSessionId,
      generationId: one.generation.channel_generation_id,
      operationId: one.mapping?.topic_generation_state?.rotation?.operation_id ?? null,
    };
  }
  return {
    ok: true, ...one,
    matchedBy: tokens.length === 1 ? "quoted_binding_token" : "only_pending",
    deadline,
    generationId: one.generation.channel_generation_id,
    operationId: one.mapping?.topic_generation_state?.rotation?.operation_id ?? null,
  };
}

/** 现有 Claude registry → Subscription v1；纯投影，不写 registry 或新控制面目录。 */
export function buildClaudeSubscriptionProjection({
  registryFile, templateFile, projectRoot = null,
} = {}) {
  const registry = loadRegistry(registryFile);
  if (!registry.ok) return { ok: false, reason: "registry_unreadable" };
  const loaded = loadChainTemplate(templateFile);
  if (!loaded.ok) return { ok: false, reason: "template_unusable" };
  const template = loaded.template;
  const endpointId = legacyEndpointId({ runtime: "claude", agentUid: template.agent_uid });
  // 默认仍是全局视图 —— 首次认领 shadow 需要它，这个默认不能改。
  // 传了 projectRoot 就只投影那一个项目：status 说"当前项目"，
  // 就不能把别人的订阅和待认领计数算进来。
  const want = typeof projectRoot === "string" ? path.resolve(projectRoot) : null;
  const records = [];
  for (const entry of registry.projects) {
    if (want !== null && path.resolve(entry.root ?? "") !== want) continue;
    // 旧安装把根消息和绑定放在项目内 active-mapping.json，registry 只登记 root。
    // 这些行没有 root_message_id，但仍是现行数据面的真实绑定，投影不能把它们漏掉。
    const resolved = entry.root_message_id
      ? null
      : resolveProject({
        root: entry.root,
        claudeSessionId: entry.claude_session_id,
        registryFile,
        templateFile,
      });
    if (!entry.root_message_id && (!resolved?.ok ||
        !resolved.mapping?.feishu_root_message_id_reference)) continue;
    const mapping = resolved?.mapping ?? null;
    const config = resolved?.config ?? null;
    const targetIsSession = Boolean(entry.claude_session_id ?? mapping?.claude_session_id);
    const projectedState = entry.root_message_id
      ? topicGenerationStateForLegacy(entry, {
        runtime: "claude",
        bindingId: (entry.id ?? "project") + "@registry",
      })
      : null;
    const state = mapping?.topic_generation_state ?? (projectedState?.ok ? projectedState.state : null);
    const pending = pendingGeneration(state);
    const active = state?.generations?.find((generation) =>
      generation.channel_generation_id === state.active_generation_id);
    records.push({
      legacy_key: entry.id,
      domain_key: entry.root,
      local_target_id: stableControlId(
        "target", "claude", entry.id, targetIsSession ? "session" : "project",
      ),
      status: entry.status ?? mapping?.status ?? "active",
      inbound_state: pending ? "pending" : (entry.inbound_state ?? mapping?.inbound_state ?? "bound"),
      session_id: pending ? null : (active?.session_id ?? entry.session_id ?? mapping?.session_id ?? null),
      pending_token: pending?.pending_token ?? entry.pending_token ?? mapping?.pending_token ?? null,
      pending_expires_at: pending?.claim_expires_at ?? entry.pending_expires_at ?? null,
      bound_at: pending?.created_at ?? entry.bound_at ?? mapping?.created_at,
      chat_id: entry.chat_id ?? config?.chat_id ?? template.chat_id,
    });
  }
  return buildLegacySubscriptionReadModel({
    runtime: "claude", endpointId, template, records, pendingWindowMs: PENDING_WINDOW_MS,
  });
}

/** 首次认领的新旧结果对照；返回值只供审计，旧结果仍是唯一执行依据。 */
export function shadowClaudeFirstClaim({
  event, template, callerAgentUid, legacyPending, legacyPromotion,
  registryFile, templateFile, now = Date.now(),
} = {}) {
  const model = buildClaudeSubscriptionProjection({ registryFile, templateFile });
  const endpointId = legacyEndpointId({ runtime: "claude", agentUid: template?.agent_uid });
  const candidate = selectPendingSubscriptionClaim({
    model,
    evidence: {
      endpoint_id: endpointId,
      caller_agent_uid: callerAgentUid,
      sender_id: event?.sender_id,
      mention_ids: extractMentionIds(event?.content),
      event_type: MESSAGE_RECEIVE_EVENT,
      chat_id: null, // 现有 envelope 尚未验证稳定 chat locator；只在 shadow 中显式记为未核验。
      created_at_ms: event?.created_at_ms,
    },
    bindingTokens: bindingTokensInQuote(event?.content),
    now,
  });
  return compareFirstClaimShadow({
    legacy: {
      ok: legacyPromotion?.ok === true,
      target_key: legacyPromotion?.ok ? legacyPromotion.id : null,
      reason: legacyPromotion?.reason ?? legacyPending?.reason,
    },
    candidate,
  });
}

/**
 * 还不知道是哪个项目时能守住的闸，一个不少。
 *
 * 三道都来自机器级配置，所以在绑定之前就能判：发送者是不是 Frank、有没有真实 @
 * 运输 agent、消息新不新。认领哪一份待绑定靠绑定码精确匹配（只有一份时直接命中）；
 * 待绑定不过期（2026-08-28 起），只有旧登记写了显式截止的才会过期。fail-closed 成立。
 */
export function evaluatePromotion({ event, template, pending, now = Date.now(), env = process.env }) {
  const reject = (reason, extra = {}) => ({
    ok: false, reason, reasonText: PROMOTE_REJECT_TEXT[reason] ?? reason, ...extra,
  });

  const frank = template?.frank_sender_id;
  const transport = template?.transport_open_id;
  const freshness = template?.default_freshness_ms;
  if (typeof frank !== "string" || typeof transport !== "string" ||
      typeof freshness !== "number" || !Number.isFinite(freshness) || freshness <= 0) {
    return reject(PROMOTE_REJECT.MALFORMED_TEMPLATE);
  }

  if (event?.sender_id !== frank) return reject(PROMOTE_REJECT.SENDER_NOT_FRANK);
  // #R11 P1-2：promotion 底层**不许豁免 @**。私聊豁免只放在 evaluateChatGates（chat 默认态）；
  // 认领 pending 必须带真实 @——否则早分流漏接时，私聊能凭「无 @」从私聊认领 pending。
  // #R14 B1：唯一例外是**绑定码精确命中**（matchedBy === "quoted_binding_token"）——码只出现在 pending
  // 话题根消息的引用块里，是话题身份的强正据；私聊没有 pending 根消息，matchedBy 不可能为此值，私聊照旧
  // 强制 @。这两条判据互斥不混写：豁免认「码命中」，不认「有 pending」。
  const tokenMatched = pending?.ok === true && pending.matchedBy === "quoted_binding_token";
  if (!extractMentionIds(event?.content).includes(transport) && !tokenMatched) {
    const r = reject(PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED);
    if (pending?.ok === true) r.reasonText += PENDING_CLAIM_HINT;
    else if (isOffTemplateChatTurn({ template, env })) r.reasonText += OFF_TEMPLATE_HINT;
    return r;
  }

  const createdMs = Number(event?.created_at_ms);
  if (!Number.isFinite(createdMs)) return reject(PROMOTE_REJECT.MALFORMED_TEMPLATE);
  if (now - createdMs > freshness) return reject(PROMOTE_REJECT.STALE_MESSAGE);

  if (!pending?.ok) return reject(pending?.reason ?? PROMOTE_REJECT.NO_PENDING, { ids: pending?.ids });

  return {
    ok: true,
    root: pending.root,
    id: pending.id,
    source: pending.source,
    generationId: pending.generationId,
    // #R15 P1-1：binding-only 握手要用 —— 无 @ 且靠码命中豁免放行的认领，绑完即终结，不把正文继续当指令。
    mentionWaived: tokenMatched && !extractMentionIds(event?.content).includes(transport),
  };
}

/**
 * chat 默认态的三道闸（无绑定上下文；两条链共用）：登记发送者在角色表里、真实 @ 运输 agent、新鲜度。
 * 与 evaluatePromotion 的区别只有一处：绑定只认 owner，chat 认角色表里的任何角色（谁能干什么由 authorize 的 chat 行决定）。
 * 这些 reason 是 chat 兜底的对象 —— 绑定没成不等于该拒：没有 pending、多份 pending、绑定码对不上、pending 过期、
 * 发送者不是 owner，都落进 chat 重新判；@ 没打、消息过期、模板坏了仍是拒绝。
 */
export const CHAT_FALLBACK_REASONS = Object.freeze([
  PROMOTE_REJECT.NO_PENDING, PROMOTE_REJECT.MULTIPLE_PENDING, PROMOTE_REJECT.TOKEN_UNKNOWN,
  PROMOTE_REJECT.TOKEN_AMBIGUOUS, PROMOTE_REJECT.TOKEN_DUPLICATED, PROMOTE_REJECT.PENDING_EXPIRED,
  PROMOTE_REJECT.SENDER_NOT_FRANK,
]);
/**
 * 私聊判据（#R11 P1-1 定案，Frank 拍板 b 选项）：**正向白名单**，不是结构签名。
 *
 * 评审 P1-1 指出 #12 的结构签名把「thread 缺失」当正证据——但那也可能是「Aily 没注入 thread」，
 * 无法与「私聊本来没 thread」区分；且违反 verdict §4 的 fail-safe（要素缺失应回落，不是当正据）。
 * 所以主判据换成模板里的 `verified_p2p_chat_ids`（已验证私聊 chat 登记表，register-p2p-chat.mjs 维护）：
 *   表缺失 / 非数组 / 空表 → false（没登记就是没放行，完全 fail-safe）
 *   表不含 chatId → false
 *   表含 chatId（逐字）&& chatId ≠ 模板登记群 && thread 缺失/空 → true
 * `thread 缺失/空` 在这里只是**纵深防御**（外部群话题的 thread 有值，白名单里的 chat 也拒），
 * 不再是主判据；chatId ≠ 模板群二者之一是私聊的语义前提（群消息即便被误登记也按群处理）。
 */
export function isPrivateChatTurn({ template, env = process.env } = {}) {
  const chatId = typeof env?.AILY_CLI_CHANNEL_CHAT_ID === "string" ? env.AILY_CLI_CHANNEL_CHAT_ID : "";
  // 形状判据用同一份 p2pChatIdProblem（#R12 P1）：env 值是 unverified locator，形状不合法
  // 直接不放行 —— 逐字 includes 本来也拦得住，但显式走同一份判据，四个使用点不会漂移。
  if (chatId.length === 0 || p2pChatIdProblem(chatId) !== null) return false;
  // 主判据：正向验过的私聊登记表。缺 / 非数组 / 空 → false（没登记就没有私聊放行）。
  const whitelist = template?.verified_p2p_chat_ids;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
  if (!whitelist.includes(chatId)) return false;
  // 群里（= 模板登记的群 chat）语义上不是私聊——即便被误登记进白名单也按群处理。
  // 模板 chat_id 缺失 / 坏形状时跳过这条群判，白名单照常判定（登记表本身已被
  // validateChainTemplate 守过；这里坏的是群 id，不是放行白名单）。
  const templateChatId = typeof template?.chat_id === "string" ? template.chat_id : "";
  if (templateChatId.length > 0 && p2pChatIdProblem(templateChatId) === null && chatId === templateChatId) return false;
  // 纵深防御：thread 形态异常（非字符串）或 thread 有值 → 外部群话题/群内线程，不是私聊。
  const rawThread = env?.AILY_CLI_CHANNEL_THREAD_ID;
  if (rawThread !== undefined && rawThread !== null && typeof rawThread !== "string") return false;
  if (typeof rawThread === "string" && rawThread.length > 0) return false;
  return true;
}

// 两道 @ 闸（promotion / chat）共用同一句 hint —— 只解释，不改变任何判定。
// 私聊已开通（真机验证），hint 只描述「未接入的群」这一场景。
export const OFF_TEMPLATE_HINT =
  "（诊断：本轮频道与登记群不一致，未接入的群消息暂不自动应答；请到已绑定话题里 @ 我）";

// #R14 B1：认领退回「无 @ 无码」时的动作 hint —— 只解释，不改变判定。
// 只在「存在唯一待认领代际」且未命中码时追加：引导去新话题（引用码随根消息自动附带）或 @ 我。
export const PENDING_CLAIM_HINT =
  "（若还有待认领：到新话题里回复任意内容（引用码随根消息自动附带），或直接 @ 本链路，即可完成认领）";

/**
 * off-template 观察（**诊断用，不是路由事实**——评审 PR #111 P1 定案）：本轮 Aily turn 的
 * 频道 locator 与链模板登记的群 chat 不一致。
 *
 * 这里读 daemon 注入的 AILY_CLI_CHANNEL_CHAT_ID（dispatcher 只删 SESSION / RUN 两个键，
 * child 原样继承）对照模板 chat_id。「不一致」只能证明 locator 不同——可能是私聊，也可能是
 * 外部群或模板 locator 过期，所以它**不豁免任何闸**，只用于往 transport_not_mentioned 的
 * 拒绝回执里追加 OFF_TEMPLATE_HINT。env 缺失或模板没有 chat_id → false（连 hint 都不加）。
 */
export function isOffTemplateChatTurn({ template, env = process.env } = {}) {
  const chatId = typeof env?.AILY_CLI_CHANNEL_CHAT_ID === "string" ? env.AILY_CLI_CHANNEL_CHAT_ID : "";
  const templateChatId = typeof template?.chat_id === "string" ? template.chat_id : "";
  return chatId.length > 0 && templateChatId.length > 0 && chatId !== templateChatId;
}

export function evaluateChatGates({ event, template, now = Date.now(), env = process.env }) {
  const reject = (reason) => ({ ok: false, reason, reasonText: PROMOTE_REJECT_TEXT[reason] ?? reason });
  const frank = template?.frank_sender_id;
  const transport = template?.transport_open_id;
  const freshness = template?.default_freshness_ms;
  if (typeof frank !== "string" || typeof transport !== "string" ||
      typeof freshness !== "number" || !Number.isFinite(freshness) || freshness <= 0) {
    return reject(PROMOTE_REJECT.MALFORMED_TEMPLATE);
  }
  const role = senderRole({ frank_sender_id: frank, senders: template?.senders }, event?.sender_id);
  if (role === null) return reject(PROMOTE_REJECT.SENDER_NOT_FRANK);
  if (!extractMentionIds(event?.content).includes(transport) &&
      !isPrivateChatTurn({ template, env })) {
    // #R11 P1-1：私聊豁免 @ 闸只放在 chat 默认态这里，判据 = 已验证私聊登记表正向命中（thread 纵深防御）。
    // 非白名单的 off-template（外部群话题 / 模板 locator 过期 / 未登记私聊）仍拒 + hint。
    const r = reject(PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED);
    if (isOffTemplateChatTurn({ template, env })) r.reasonText += OFF_TEMPLATE_HINT;
    return r;
  }
  const createdMs = Number(event?.created_at_ms);
  if (!Number.isFinite(createdMs)) return reject(PROMOTE_REJECT.MALFORMED_TEMPLATE);
  if (now - createdMs > freshness) return reject(PROMOTE_REJECT.STALE_MESSAGE);
  return { ok: true, role };
}

/**
 * 把 session_id 写进登记表那一行 —— 绑定的第二段完成。
 *
 * 只改这两个字段，其余原样留着。写前留 .prev，和别处一致。
 */
export function promoteBinding({
  root, id, source, generationId, operationId, sessionId,
  registryFile = registryPath(), now = Date.now(),
}) {
  const projectFile = projectMappingPath(root);
  const useProjectFile = source === "project-files" ||
    (source === undefined && fs.existsSync(projectFile) && !id);
  const lockDir = useProjectFile
    ? path.join(path.dirname(projectFile), "topic-generation.lock")
    : path.join(path.dirname(registryFile), "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "binding_busy" };
  try {
    if (useProjectFile) {
      let mapping;
      try { mapping = JSON.parse(fs.readFileSync(projectFile, "utf-8")); }
      catch (err) {
        return { ok: false, reason: "mapping_unreadable", error: String(err.message).slice(0, 200) };
      }
      const bindingId = effectiveBindingId(mapping, { root });
      const loaded = topicGenerationStateForLegacy(mapping, { runtime: "claude", bindingId, now });
      if (!loaded.ok) return loaded;
      const activated = activatePendingTopicGeneration(loaded.state, {
        generationId, operationId, sessionId, now,
      });
      if (!activated.ok) return activated;
      const materialized = materializeLegacyTopicFields(mapping, activated.state);
      if (!materialized.ok) return materialized;
      const { root_message_id: selectedRootMessageId, ...legacyCompatible } = materialized.record;
      const next = {
        ...legacyCompatible,
        feishu_root_message_id_reference: selectedRootMessageId,
        inbound_bound_at: new Date(now).toISOString(),
      };
      const tmp = projectFile + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, projectFile);
      return { ok: true, root, sessionId, generation: activated.active };
    }

    let reg;
    try { reg = JSON.parse(fs.readFileSync(registryFile, "utf-8")); }
    catch (err) {
      return { ok: false, reason: "registry_unreadable", error: String(err.message).slice(0, 200) };
    }
    const entry = (reg.projects ?? []).find((project) =>
      id ? project?.id === id : project?.root === root);
    if (!entry) return { ok: false, reason: "entry_gone" };
    const loaded = topicGenerationStateForLegacy(entry, {
      runtime: "claude",
      bindingId: (entry.id ?? path.basename(root)) + "@registry",
      now,
    });
    if (!loaded.ok) return loaded;
    const sessionUsed = (reg.projects ?? []).some((project) => {
      if (project === entry) return false;
      const state = topicGenerationStateForLegacy(project, {
        runtime: "claude",
        bindingId: (project.id ?? path.basename(project.root ?? "project")) + "@registry",
        now,
      });
      return state.ok && state.state.generations.some((generation) =>
        generation.session_id === sessionId && generation.status !== "retired");
    });
    if (sessionUsed) return { ok: false, reason: "session_already_bound" };
    const activated = activatePendingTopicGeneration(loaded.state, {
      generationId, operationId, sessionId, now,
    });
    if (!activated.ok) return activated;
    const materialized = materializeLegacyTopicFields(entry, activated.state);
    if (!materialized.ok) return materialized;
    Object.assign(entry, materialized.record, {
      inbound_bound_at: new Date(now).toISOString(),
    });
    fs.copyFileSync(registryFile, registryFile + ".prev");
    const tmp = registryFile + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, registryFile);
    return { ok: true, root, sessionId, generation: activated.active };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: String(err.message).slice(0, 200) };
  } finally {
    releasePublishLock(lockDir);
  }
}
