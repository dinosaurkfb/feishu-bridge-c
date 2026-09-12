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

import crypto from "node:crypto";
import fs from "node:fs";
import { senderRole } from "./sender-roles.mjs";
import path from "node:path";

import { loadChainTemplate, p2pChatIdProblem } from "./chain-template.mjs";
import { maintenanceDir } from "./maintenance/journal.mjs";
import { endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import { readSidecarStore } from "./m1b/sidecar-store.mjs";
import { loadByEndpoint, resolveLiveId } from "./topic-agent-ledger.mjs";
import { decideLedgerRoute } from "./m1a/delivery-target.mjs";
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
  activatePendingTopicGeneration, activeGeneration, materializeLegacyTopicFields, pendingGeneration,
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
  // P1-2（F4）：认领的 chat 维真实匹配。channel-locator-verdict.md：AILY_CLI_CHANNEL_CHAT_ID 就是飞书 chat_id
  // （可信），与待绑定所在群不一致 → 四维不成立，硬拒（不落 chat 兜底——在错误的群里答错地方）。
  CHAT_MISMATCH: "chat_mismatch",
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
  [PROMOTE_REJECT.CHAT_MISMATCH]: "这条认领的聊天群与待绑定项目所在群不一致",
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
// PK2-I3：同一个解析器服务两个字段面 —— 登记行是 `pending_expires_at`，凭证库条目是 `claim_expires_at`。
const deadlineOf = (row, field) => {
  const explicit = Date.parse(row?.[field] ?? "");
  return Number.isFinite(explicit) ? explicit : Infinity;
};
const pendingDeadline = (entry) => deadlineOf(entry, "pending_expires_at");
const claimDeadline = (entry) => deadlineOf(entry, "claim_expires_at");

/** 定长比较：先比长度（长度不是秘密），相等再 `timingSafeEqual` —— 不写 `t1 === t2`。*/
const sameToken = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf-8");
  const y = Buffer.from(b, "utf-8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * bearer 凭证库（`ledger/<endpoint>/pending-claims.json`）的**唯一查询入口**（PK2-I3）。
 *
 * 为什么不直接 `entries[id].token === token`：这是凭证比对，不是普通字段比对 —— 按位比完再判，
 * 早退的 `===` 会把"前几位对不对"这种信息泄出去。表很小（≤512），扫满不早退。
 * 恰一条 → `{ok:true, id}`；零条 → `token_unknown`；多条 → `token_duplicated`（与 inbound 的
 * PROMOTE_REJECT 三分同形，调用方按同一个词收口）。`token === null` 的条目（无码 B1，owner 配对不需要码）
 * **永不**参与码认领。
 */
export function findByToken({ doc, token } = {}) {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "token_unknown" };
  const entries = doc?.entries;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    return { ok: false, reason: "token_store_invalid", why: "凭证库条目表不是对象" };
  }
  const hits = [];
  for (const [id, entry] of Object.entries(entries)) {
    const got = entry !== null && typeof entry === "object" ? entry.token : null;
    if (got === null || got === undefined) continue;
    if (sameToken(token, got)) hits.push(id);
  }
  if (hits.length === 0) return { ok: false, reason: "token_unknown" };
  if (hits.length > 1) return { ok: false, reason: "token_duplicated", ids: hits };
  return { ok: true, id: hits[0] };
}

/**
 * 认领凭证面的**判源**（PK2-I3）：与投递目标/bypass 同一条矩阵（R66 `decideLedgerRoute` →
 * `classifyLedgerAuthority`），不另立第二套。模板读不出 → 当 legacy（那条路上 `evaluatePromotion`
 * 自己会以 malformed_template 拒，不会放行认领）。
 */
const pendingClaimsRoute = ({ templateFile, env = process.env } = {}) => {
  const tpl = loadChainTemplate(templateFile);
  if (!tpl.ok) return { mode: "legacy", why: "机器级链路配置不可用（" + tpl.reason + "）—— 不进凭证面" };
  const endpointId = legacyEndpointId({ runtime: "claude", agentUid: tpl.template.agent_uid });
  const recDir = maintenanceDir(env);
  const receipt = (typeof recDir === "string" && recDir.length > 0)
    ? endpointReceipt(recDir, endpointId)
    : { ok: false, state: "unreadable", why: "维护目录不可派生" };
  return { endpointId, ...decideLedgerRoute({ receipt, endpointId, env }) };
};

/** legacy / shadow：待认领的选择照旧由登记/映射里的 `pending_token` 定（一字未改）。 */
const pickPendingFromLegacy = ({ pending, tokens }) => {
  if (tokens.length === 1) {
    const hits = pending.filter((b) => b.generation?.pending_token === tokens[0]);
    // 认得出码但没人认领：与其回落到「只有一份」猜一个，不如明说 —— 回落会在
    // 「Frank 在 A 话题说话、而待绑定的是 B」时把 B 绑给 A，静默且难查。
    if (hits.length === 0) return { ok: false, reason: PROMOTE_REJECT.TOKEN_UNKNOWN, token: tokens[0] };
    if (hits.length > 1) return { ok: false, reason: PROMOTE_REJECT.TOKEN_DUPLICATED, token: tokens[0], ids: hits.map((b) => b.id) };
    return { ok: true, one: hits[0], matchedBy: "quoted_binding_token" };
  }
  if (pending.length > 1) return { ok: false, reason: PROMOTE_REJECT.MULTIPLE_PENDING, ids: pending.map((b) => b.id) };
  return { ok: true, one: pending[0], matchedBy: "only_pending" };
};

/**
 * **半笔续跑**的识别（PK2-I3）。
 *
 * 为什么需要它：复合的顺序是「账本 activate → **删凭证条目** → 索引」（W1 P1-2）——于是存在一个中间态：
 *   账本说 active、凭证已被消费、而索引还没写（现场在登记面仍 pending）。旧世界里「可认领」靠登记行的
 *   `pending_token`（删凭证不影响它），所以同一条命令重跑能续上（T14）；I3 把读面换成凭证库后，
 *   那一个中间态的码**注定查不到**（条目已经删了），续跑就会被自己挡死。
 *
 * 判据全在**权威事实**里（不回头看登记表的 `pending_token`）：
 *   ① 全部 pending 中唯一一条符合半笔恢复证据的候选（PK2-I3-fix2：不再数全机 pending；多条符合证据 = 无从消歧 —— 宁可拒）；
 *   ② 该候选在凭证库里**没有条目**（凭证确实被消费了）；
 *   ③ 账本里这条 B1 已经 `active`（activate 提交过）；
 *   ④ 账本自己那条 pairing 证明是**码认领**且 `matched_om` 就是本代际的根消息。
 * 这条路只是让读面**不把续跑挡死**：真正的闸在复合里 —— `activate` 必须按同一 `claimKey` 重放命中，
 *   换个 message_id 来重放照样 `m1a_mode_not_shadow` 拒。
 */
const resumeCandidate = ({ pending, claims, endpointId, env }) => {
  // PK2-I3-fix2 P1：候选资格看「符合四项恢复证据的条数」，**不是全机 pending 数**（`pending.length === 1`
  //   的旧判据会把「另一条 lineage 的正常 pending」也数进去，卡死本条线合法的 committed-unclean 续跑）。
  //   在全部 claims 里筛出同时满足 ①凭证条目已删 ②能解析到账本 live id ③账本 active ④pairing 证明
  //   是码认领且 matched_om 与本代际根消息一致 的候选，再要求**恰一条**；两条真半笔 → 无从消歧 → null
  //   （调用方折成 token_unknown 拒，绝不挑一个）。账本一次读入、全候选共用。
  const led = loadByEndpoint(endpointId, { env });
  if (!led.ok) return null;
  const candidates = claims.filter((c) => {
    if (c.entry !== null || c.id === null) return false;
    const rec = led.doc.records?.[c.id];
    if (!rec || rec.kind !== "live" || rec.facts?.binding !== "active") return false;
    const proof = rec.binding_proof;
    return proof?.pending_token_state === "present" && proof?.matched_om === c.binding.generation?.root_message_id;
  });
  return candidates.length === 1 ? candidates[0] : null;
};

/**
 * authoritative：**凭证只认 store**（`ledger/<ep>/pending-claims.json`），登记/映射里的 `pending_token`
 *   不再是裁定依据；到期同样取 store 条目（`claim_expires_at` 为 null = 不过期）。
 *   候选代际 → 账本 live id 用 `resolveLiveId`（代际根消息就是账本 locator），而 store 的键**就是**
 *   `topic_agent_id` —— 两边靠 id 对上，不靠登记行里的 token。
 *   store 读不出 / 缺席 → 拒 `ledger_route_unavailable`（fail-closed：bearer 凭证核不了就不认，
 *   绝不回落到旧登记表那一列）。
 */
const pickPendingFromStore = ({ pending, tokens, endpointId, env }) => {
  const store = readSidecarStore({ endpointId, name: "pending-claims", env });
  if (store.ok !== true || store.absent === true) {
    return { ok: false, reason: "ledger_route_unavailable", tokens,
      why: "待认领凭证库读不出（" + String(store.why ?? store.reason ?? (store.absent === true ? "pending-claims.json 缺席" : "unknown"))
        + "）：authoritative 下不回落旧登记表的 pending_token" };
  }
  const claims = pending.map((binding) => {
    const resolved = resolveLiveId({ endpointId, locator: binding.generation?.root_message_id ?? null, env });
    const id = resolved.ok === true ? resolved.id : null;
    const entry = id !== null && Object.prototype.hasOwnProperty.call(store.entries, id) ? store.entries[id] : null;
    return { binding, id, entry };
  });
  if (tokens.length === 1) {
    const found = findByToken({ doc: store.doc, token: tokens[0] });
    if (found.ok === true) {
      const hits = claims.filter((c) => c.id === found.id);
      // 码在库里、但不在**待认领**那几条里（代际已翻页/已认领）→ 与「码对不上」同一收口，不猜。
      if (hits.length === 1) return { ok: true, one: hits[0].binding, matchedBy: "quoted_binding_token", storeBacked: true, deadline: claimDeadline(hits[0].entry) };
      if (hits.length > 1) return { ok: false, reason: PROMOTE_REJECT.TOKEN_DUPLICATED, token: tokens[0], ids: hits.map((c) => c.binding.id) };
      return { ok: false, reason: PROMOTE_REJECT.TOKEN_UNKNOWN, token: tokens[0] };
    }
    // 码不在库里：可能是「凭证已被消费、索引还没写」的半笔续跑（见 resumeCandidate），否则就是真对不上。
    const res = resumeCandidate({ pending, claims, endpointId, env });
    if (res !== null) return { ok: true, one: res.binding, matchedBy: "consumed_credential_resume", storeBacked: true, deadline: claimDeadline(res.entry) };
    return { ok: false, token: tokens[0], ...(found.ids ? { ids: found.ids } : {}),
      reason: found.reason === "token_duplicated" ? PROMOTE_REJECT.TOKEN_DUPLICATED : PROMOTE_REJECT.TOKEN_UNKNOWN };
  }
  if (pending.length > 1) return { ok: false, reason: PROMOTE_REJECT.MULTIPLE_PENDING, ids: pending.map((b) => b.id) };
  return { ok: true, one: claims[0].binding, matchedBy: "only_pending", storeBacked: true, deadline: claimDeadline(claims[0].entry) };
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
export function findPendingBinding({ content, registryFile, templateFile, now = Date.now(), env = process.env } = {}) {
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

  // PK2-I3：判源分派 —— **只有 authoritative 换读面**（凭证库），legacy / shadow / reject 一律走原路径、一字未改。
  //   reject 那一态（收据坏 / cutover 与账本对不上）**写面本来就 fail-closed**（复合必拒：m1a_ledger_absent /
  //   m1a_mode_not_shadow，P2-① 钉的就是它）—— 在读面抢先改口只换一个字面、不多一分安全，却会动掉那条封闭判据。
  //   注意「哪些代际在待认领」仍由登记/映射投影提供（那是话题身份面）；本单换的是**凭证**那一列。
  const route = pendingClaimsRoute({ templateFile, env });
  const picked = route.mode === "authoritative"
    ? pickPendingFromStore({ pending, tokens, endpointId: route.endpointId, env })
    : pickPendingFromLegacy({ pending, tokens });
  if (picked.ok !== true) return picked;

  const one = picked.one;
  // 到期判源同源：authoritative 取 store 条目的 `claim_expires_at`（null = 不过期）；
  //   legacy / shadow 仍按旧口径（代际的 claim_expires_at，否则登记行的 pending_expires_at）。
  const generationDeadline = Date.parse(one.generation?.claim_expires_at ?? "");
  const deadline = picked.storeBacked === true
    ? picked.deadline
    : (Number.isFinite(generationDeadline) ? generationDeadline : pendingDeadline(one.entry));
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
    matchedBy: picked.matchedBy,
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
  if (!extractMentionIds(event?.content).includes(transport)) {
    const r = reject(PROMOTE_REJECT.TRANSPORT_NOT_MENTIONED);
    if (isOffTemplateChatTurn({ template, env })) r.reasonText += OFF_TEMPLATE_HINT;
    return r;
  }

  const createdMs = Number(event?.created_at_ms);
  if (!Number.isFinite(createdMs)) return reject(PROMOTE_REJECT.MALFORMED_TEMPLATE);
  if (now - createdMs > freshness) return reject(PROMOTE_REJECT.STALE_MESSAGE);

  if (!pending?.ok) return reject(pending?.reason ?? PROMOTE_REJECT.NO_PENDING, { ids: pending?.ids });

  // P1-2（F4）：四维真实匹配——chat / sender / body(码) / thread_root。sender 与 @ 在上方闸已验；
  // findPendingBinding 已按正文绑定码收敛 pending（body 维）；thread_root 由 pending 锚定（
  // pending.generation.root_message_id = matched_om），不经 env。这里只补 **chat** 维：
  //   channel-locator-verdict.md §2（2026-09-02 真机对照）：AILY_CLI_CHANNEL_CHAT_ID 就是飞书 chat_id（可信）；
  //   AILY_CLI_CHANNEL_THREAD_ID 则只是 Aily 命名空间 thread 标识（不是飞书 thread/root locator）——
  //   所以 thread_root 不能从 env 比对，只能经 pending 锚定（上方 findPendingBinding 已锚）。
  // 判据（fail-safe）：env chat 存在且与待绑定所在群不一致 → 拒（这条认领在错误的群里，四维不成立）；
  //   env chat 缺失（未可核验）→ 照常放行，chat 维由 shadow（selectPendingSubscriptionClaim）
  //   记 scope_unverified:["chat_id"]（ledger binding_proof 是封闭五项，不含该诊断字段）。不把缺失当匹配。
  const envChat = typeof env?.AILY_CLI_CHANNEL_CHAT_ID === "string" ? env.AILY_CLI_CHANNEL_CHAT_ID : "";
  const bindingChat = pending?.entry?.chat_id ?? pending?.config?.chat_id ?? template?.chat_id;
  if (envChat.length > 0 && typeof bindingChat === "string" && bindingChat.length > 0 && envChat !== bindingChat) {
    return reject(PROMOTE_REJECT.CHAT_MISMATCH, { chat: envChat, expected: bindingChat });
  }

  // P1-2 收尾：认领校验处**真核**并产出封闭 F4 产物（matched_om=被认领代际根消息 om；matched_fields=标准
  //   四项）供 wirePromoteBinding 只消费不自铸。generation.root_message_id 缺失（无受验 thread_root 锚）
  //   → f4=null —— wirePromoteBinding 侧 bad_f4 fail-closed、不写配对证明。不经 env 取 thread/root。
  //   判别联合见下方（P1-1-d 裁定 d）：plain 无码不再伪造 body(码) 维。
  const matchedOm = (typeof pending.generation?.root_message_id === "string" && pending.generation.root_message_id.length > 0)
    ? pending.generation.root_message_id : null;
  const chatVerified = envChat.length > 0 && typeof bindingChat === "string" && bindingChat.length > 0 && envChat === bindingChat;
  // P1-1-d（Codex 裁定 d）：F4 判别联合，**不伪造**。token 认领（quoted_binding_token）→ 完整四维 present；
  //   plain 无码（only_pending）→ 厂商不再伪造 body(码) 维；#守卫① 起连 owner-root 三维也不再产（f4=null，
  //   root-blind Aily 下 thread_root 无诚实来源）。六件事仍收敛为：唯一可认领 B1 恰一份 + token/到期均 null +
  //   sender 受验 owner + chat 与 B1 受验 chat 相等（由上方 CHAT_MISMATCH 守卫保证）+ 引用根逐字等于 B1 root +
  //   消息整条按 bind-only、正文不执行。
  // PK2-I3：半笔续跑（`consumed_credential_resume`）与 token 认领**同一支** —— 它不是新铸的证明：账本那条 B1
  //   的 binding_proof 本来就是 `pending_token_state:"present"` + `matched_om`=本代际根消息（`resumeCandidate` ④
  //   就是逐字核这两项），本跑只是把复合要的那个 f4 按同一形状交回，且复合仍要求 activate 按同一 claimKey 重放命中。
  const isCodeClaim = pending?.matchedBy === "quoted_binding_token" || pending?.matchedBy === "consumed_credential_resume";
  // #守卫①（Frank 裁定）：root-blind Aily 传输下 thread_root 维无诚实来源 —— owner_root_no_token_v1 停止生产。
  //   事件侧引用根 om 问题因此不复存在：无码认领（only_pending）直接不再产任何配对证明（f4=null）。
  //   只保留 token 认领（quoted_binding_token）的 binding_token_v1（完整四维 present，chat 必须真受验 env chat 非空且相等）。
  //   校验侧 G15 仍接受旧 owner_root_no_token_v1（三维 absent）为合法历史形状；生产侧不再铸造。
  const f4 = matchedOm && isCodeClaim && chatVerified
    ? { matched_om: matchedOm, matched_fields: ["chat_id", "sender", "body", "thread_root"], pending_token_state: "present" }
    : null;
  return {
    ok: true,
    root: pending.root,
    id: pending.id,
    source: pending.source,
    generationId: pending.generationId,
    f4,
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
  // 释放折叠（P1-5③）只在 result 非 null 时才折得上 —— 所以**每一条返回路径都先赋 result**。
  let result = null;
  try {
    if (useProjectFile) {
      let mapping;
      try { mapping = JSON.parse(fs.readFileSync(projectFile, "utf-8")); }
      catch (err) {
        result = { ok: false, reason: "mapping_unreadable", error: String(err.message).slice(0, 200) };
        return result;
      }
      const bindingId = effectiveBindingId(mapping, { root });
      const loaded = topicGenerationStateForLegacy(mapping, { runtime: "claude", bindingId, now });
      if (!loaded.ok) { result = loaded; return result; }
      const activated = activatePendingTopicGeneration(loaded.state, {
        generationId, operationId, sessionId, now,
      });
      if (!activated.ok) { result = activated; return result; }
      const materialized = materializeLegacyTopicFields(mapping, activated.state);
      if (!materialized.ok) { result = materialized; return result; }
      const { root_message_id: selectedRootMessageId, ...legacyCompatible } = materialized.record;
      const next = {
        ...legacyCompatible,
        feishu_root_message_id_reference: selectedRootMessageId,
        inbound_bound_at: new Date(now).toISOString(),
      };
      const tmp = projectFile + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, projectFile);
      result = { ok: true, root, sessionId, generation: activated.active };
      return result;
    }

    let reg;
    try { reg = JSON.parse(fs.readFileSync(registryFile, "utf-8")); }
    catch (err) {
      result = { ok: false, reason: "registry_unreadable", error: String(err.message).slice(0, 200) };
      return result;
    }
    const entry = (reg.projects ?? []).find((project) =>
      id ? project?.id === id : project?.root === root);
    if (!entry) { result = { ok: false, reason: "entry_gone" }; return result; }
    const loaded = topicGenerationStateForLegacy(entry, {
      runtime: "claude",
      bindingId: (entry.id ?? path.basename(root)) + "@registry",
      now,
    });
    if (!loaded.ok) { result = loaded; return result; }
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
    if (sessionUsed) { result = { ok: false, reason: "session_already_bound" }; return result; }
    const activated = activatePendingTopicGeneration(loaded.state, {
      generationId, operationId, sessionId, now,
    });
    if (!activated.ok) { result = activated; return result; }
    const materialized = materializeLegacyTopicFields(entry, activated.state);
    if (!materialized.ok) { result = materialized; return result; }
    Object.assign(entry, materialized.record, {
      inbound_bound_at: new Date(now).toISOString(),
    });
    fs.copyFileSync(registryFile, registryFile + ".prev");
    const tmp = registryFile + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, registryFile);
    result = { ok: true, root, sessionId, generation: activated.active };
    return result;
  } catch (err) {
    result = { ok: false, reason: "registry_unwritable", error: String(err.message).slice(0, 200) };
    return result;
  } finally {
    // PK2-W1-fix2 P1-5③：释放结果**不得丢** —— 索引写成而登记表锁未交还时，旧版照样报 clean，
    //   认领的下游（authoritative 复合的 index 步 → unclean 投影）也就看不到它。按 R57d 折叠：
    //   `lockUncleared` 上折 + ok 降级（写已落盘的话 root/generation 照旧带出，供人工判断）。
    let rel;
    try { rel = releasePublishLock(lockDir); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    const unclean = rel.reapUncleared
      ? { reason: "reap_residue_uncleared", path: rel.reapUncleared.path ?? lockDir + ".reap", detail: rel.reapUncleared.error != null ? String(rel.reapUncleared.error) : null }
      : rel.absent === true ? { reason: "lock_absent", path: lockDir, detail: null }
        : rel.ok !== true
          ? { reason: String(rel.reason ?? "release_failed"), path: lockDir, detail: rel.error != null ? String(rel.error) : (rel.why != null ? String(rel.why) : null) }
          : null;
    if (unclean !== null && result !== null && typeof result === "object" && result.lockUncleared === undefined) {
      result.ok = false;
      result.reason = "registry_lock_release_failed";
      result.why = unclean.reason;
      result.lockUncleared = unclean;
    }
  }
}

/**
 * R57d 返修二 P1-1：读一个绑定（项目映射文件，缺则 registry 条目）里 **pending 代际**的身份 ——
 *   channel_generation_id（promoteBinding 的 generationId CAS 输入）+ rotation operation id
 *   （operationId CAS 输入；rotation 缺席 → null，promoteBinding 侧按既有 nonEmpty 规则跳过该 CAS）。
 * 供 owner_select activate 的 legacy 提交回调带足身份；只读，不写、不取锁（写仍由 promoteBinding 自己做）。
 */
export function pendingGenerationIdentity({ root, registryFile = registryPath(), now = Date.now() } = {}) {
  const readState = (record, bindingId) => {
    const loaded = topicGenerationStateForLegacy(record, { runtime: "claude", bindingId, now });
    if (!loaded.ok) return loaded;
    const pending = pendingGeneration(loaded.state);
    if (!pending) return { ok: false, reason: "no_pending_generation", why: "目标绑定没有 pending 代际（可能已激活/已轮转）" };
    const active = activeGeneration(loaded.state);
    return { ok: true, generationId: pending.channel_generation_id, operationId: loaded.state.rotation?.operation_id ?? null, activeRootOm: active?.root_message_id ?? null, activeSessionId: active?.session_id ?? null };
  };
  try {
    const mapping = JSON.parse(fs.readFileSync(projectMappingPath(root), "utf-8"));
    return readState(mapping, effectiveBindingId(mapping, { root }));
  } catch (err) {
    if (err?.code !== "ENOENT") return { ok: false, reason: "mapping_unreadable", why: String(err.code ?? err.message) };
  }
  try {
    const reg = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
    const entry = (reg.projects ?? []).find((p) => p?.root === root);
    if (!entry) return { ok: false, reason: "entry_gone", why: "registry 里没有这个项目根的条目" };
    return readState(entry, (entry.id ?? path.basename(root)) + "@registry");
  } catch (err) {
    return { ok: false, reason: "registry_unreadable", why: String(err.code ?? err.message) };
  }
}
