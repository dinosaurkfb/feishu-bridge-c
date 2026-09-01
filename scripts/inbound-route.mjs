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

import { loadChainTemplate } from "./chain-template.mjs";
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

/**
 * 这条消息是不是**私聊（P2P）**。
 *
 * 先说清为什么只能这么判：入站事件里没有 `chat_type`，也没有任何飞书 locator。
 * 事件视图只有五个字段（`message_id / session_id / sender_id / created_at_ms / content`，
 * 见 scripts/envelope.mjs 的 attemptFetch）；Canonical Event v1 的 `source.chat_id` 恒为 null，
 * `extensions.aily_channel.chat_id` 来自 `AILY_CLI_CHANNEL_CHAT_ID` 且带 `verified:false`
 * （scripts/canonical-event.mjs:107-115，那段注释写了「selector 不能把它们当作授权或路由事实」），
 * 它能不能当路由事实正是 `docs/implementation/dialogue-chat-scope-probe.md` 在收的证据 —— 还没定论。
 * 所以这里**不猜字段名**，用分发层已写进文档的那条事实反推：「把智能体拉进群、在群里 @ 它
 * 或私聊它，平台投 `im.message.receive`」（docs/architecture/layers-modes-permissions.md:20，
 * 同一行还写着「不核对群 id（envelope 的 chat_id 仍标未核验）」）。
 * 群消息要 @ 才会投过来，那么**整条消息一个 mention 都没有**时，还能到达本链路的形状只剩私聊。
 *
 * 判据故意保守：**有任何 mention 就不算私聊** —— 群里 @ 别的 agent / @ 别人的消息照旧走
 * 原来的 mention 闸（@ 的必须是本链路运输 agent，否则拒），不因为这次改动多放行任何东西。
 */
export function isP2pMessage(event) {
  return extractMentionIds(event?.content).length === 0;
}

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
  // 私聊（P2P）：不是「@ 没打」，是**根本没有 @ 这个东西**。见 isP2pMessage 的说明。
  P2P_NO_MENTION: "p2p_no_mention",
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
  // 这条不会到用户眼前（紧接着就落进 chat 默认态重判），只进回执 —— 但必须能读懂为什么不算「@ 没打」
  [PROMOTE_REJECT.P2P_NO_MENTION]: "私聊不用于认领项目：认领要在待接入话题里真实 @ 运输 agent。这条按 chat 默认态回答",
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
export function evaluatePromotion({ event, template, pending, now = Date.now() }) {
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
  // 私聊不进认领评估：绑定必然分两段（在待接入话题里真实 @ 那一下才认得到运输 agent），私聊里没有
  // mention 结构，硬判只能得到一条把私聊说成群聊的「没有真实 @」。这条落进 chat 默认态重判
  //（见 CHAT_FALLBACK_REASONS），既不绑定位也不把待绑定拖下水。
  if (isP2pMessage(event)) return reject(PROMOTE_REJECT.P2P_NO_MENTION);
  if (!extractMentionIds(event?.content).includes(transport)) {
    return reject(PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED);
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
  // 私聊压根不该进认领评估（没有 mention 结构），落到 chat 重判；群消息照旧按原闸走
  PROMOTE_REJECT.P2P_NO_MENTION,
]);
export function evaluateChatGates({ event, template, now = Date.now() }) {
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
  // @ 这道闸管的是「群里谁都能搭话」；私聊里没有 mention 可言，所以它不参与 ——
  // 防串话靠第 0 道闸（调用方 agent uid）、角色表与新鲜度，不靠这里。
  // 只要消息里出现了 mention，仍然必须 @ 到本链路运输 agent（群行为一个不变）。
  if (!isP2pMessage(event) && !extractMentionIds(event?.content).includes(transport)) {
    return reject(PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED);
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
