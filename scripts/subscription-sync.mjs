/**
 * 订阅变更 → 依赖它的 binding 该怎么处置（FR-2.5）。
 *
 * 需求原文：
 *
 *   subscription 变更由控制面同步到依赖它的 binding 授权快照；暂停或撤销
 *   subscription 时，相关 binding 必须被明确暂停或迁移，**不能依靠日常热路径
 *   重新解释配置**。
 *
 * 最后那半句是整条约束的要害。让热路径"每次重新看一眼配置"看起来更省事，
 * 但那样一来：改配置的那一刻什么都没发生，**变更的后果散落在此后每一条消息上**，
 * 而每条消息看到的可能都不一样（配置又改了、快照没跟上、某条路径读的是缓存）。
 * 出了问题也没有一个可以对账的时刻 —— 只能说"从某个时候开始它就不对了"。
 *
 * 所以变更必须在**控制面**一次性算清楚：谁受影响、各自该怎么处置、
 * 处置完是什么状态。这个文件只负责**算**，不负责写 —— 有损动作要显式授权，
 * 而且算和写分开之后，"改之前先看会发生什么"才是真的可看。
 *
 * ■ 三种处置，为什么必须分开
 *
 *   resnapshot  订阅内容变了但仍然覆盖这条 binding → 重新物化授权快照。
 *               binding 照常工作，只是它依据的那份快照要跟上。
 *   suspend     订阅被暂停/撤销，或不再覆盖这条 binding → **明确暂停** binding。
 *               不暂停的后果不是"它停了"，而是"它还在收消息，但依据的授权已经没了"。
 *   migrate     迁到另一条订阅。**必须由人显式指定目标**，见下。
 *
 * ■ 迁移为什么不能自动
 *
 * 上一版的规则是"只有唯一一条订阅接得住就自动迁过去"。评审用反例打穿了：
 * 一条属于 domain-a、授权 u1、只收 message 事件的 binding，会被迁到
 * other-domain、other-agent、只授权 other-user 和别的事件类型的订阅 ——
 * 因为"接得住"只比了 endpoint / 群 / 运输身份这三样。
 *
 * 这是**跨业务域的错误归属**，而且它和自动抑制是同一类错误：
 * 从"只剩这一条"推出"那就是它" —— 唯一性不是授权。
 * 认领错了拒一条消息，迁移错了整条 binding 就归错了人。
 *
 * 所以 v1 只做两件事：默认**暂停**（安全、可恢复、后果明确），
 * 以及在人显式给出目标订阅时**严格校验兼容性**再迁。有候选也只是告诉人"有候选"，
 * 不替人决定。
 *
 * ■ 归属看身份，不看范围
 *
 * "哪些 binding 原来依赖这条订阅"只能用授权快照记着的 subscription_id 回答。
 * 上一版用范围覆盖代替，于是撤销 sub-a 会把明明属于 sub-b 的同群 binding
 * 一起列进来暂停。范围覆盖不能代替归属。
 *
 * ■ 输入就是仓库自己产出的那份授权快照
 *
 * 上一版要求 binding 自带 chat_id / transport_open_id / agent_uid /
 * authorized_sender_ids 这些**原始 locator**。而正式快照
 * （materializeDialogueBindingAuthorization）刻意一个都不存 —— 它只存
 * binding_ref / agent_participant_id / authorized_human_participant_ids /
 * chat_scope_ref 这些不可逆 ref。
 *
 * 评审拿仓库自己的 materializer 生成了一份合法快照喂进来，得到 `bindings_invalid: chat_id`。
 * 也就是说，那一版**证明不了它能同步真实的快照**，测试用的是自造的结构 ——
 * 一个只能消费自己夹具的计划器，不是 FR-2.5 的可落地前置。
 *
 * 现在直接消费正式快照。**比较全部在 ref 空间里做**：从候选订阅按同一套确定性
 * 规则派生出 ref，再跟快照里的 ref 比。这样既不需要原始 locator 流进计划器，
 * 输出也不会夹带它们 —— 计划里只有 binding_ref、动作、以及版本前置条件。
 */

import { validateSubscription } from "./subscription.mjs";
import {
  deriveDialogueChatScopeRef, validateDialogueBindingAuthorizationSnapshot,
} from "./dialogue-binding-authorization.mjs";
import { deriveDialogueParticipantRef } from "./dialogue-participant-planner.mjs";

export const SYNC_ACTION = Object.freeze({
  RESNAPSHOT: "resnapshot",
  SUSPEND: "suspend",
  MIGRATE: "migrate",
});

export const SYNC_REJECT = Object.freeze({
  SUBSCRIPTION_INVALID: "subscription_invalid",
  PREVIOUS_INVALID: "previous_invalid",
  IDENTITY_CHANGED: "subscription_identity_changed",
  VERSION_NOT_ADVANCED: "version_not_advanced",
  SNAPSHOTS_INVALID: "snapshots_invalid",
  OTHERS_INVALID: "others_invalid",
  NAMESPACE_INVALID: "runtime_namespace_invalid",
  MIGRATION_TARGET_INVALID: "migration_target_invalid",
  MIGRATION_TARGET_UNKNOWN: "migration_target_unknown",
  MIGRATION_INCOMPATIBLE: "migration_incompatible",
});

const ACTIVE = "active";

const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const strList = (v) => (Array.isArray(v) && v.every(nonEmpty) && v.length > 0 ? v : null);
const covers = (outer, inner) => inner.every((x) => outer.includes(x));

/**
 * 把一条订阅投影到**快照所在的 ref 空间**。
 *
 * 快照里没有原始 locator，只有不可逆 ref。要判断一条订阅能不能覆盖某份快照，
 * 唯一诚实的办法是按同一套确定性规则从订阅派生出 ref 再比 ——
 * 而不是要求调用方把 chat_id / transport_open_id 这些东西额外传进来。
 *
 * 派生失败（字段缺失或不合规）就返回 null，由调用方当成"覆盖不了"。
 */
function projectSubscription(subscription, runtimeNamespace) {
  const endpointId = subscription?.endpoint_id;
  const scope = subscription?.scope ?? {};
  const agent = deriveDialogueParticipantRef({
    kind: "agent", runtimeNamespace, endpointId, privateIdentityKey: scope.transport_open_id,
  });
  const chat = deriveDialogueChatScopeRef({ endpointId, privateChatId: scope.chat_id });
  const senderIds = strList(scope.sender_ids);
  if (!agent.ok || !chat.ok || !senderIds) return null;
  const humans = senderIds.map((senderId) => deriveDialogueParticipantRef({
    kind: "human", runtimeNamespace: "feishu", endpointId, privateIdentityKey: senderId,
  }));
  if (humans.some((h) => !h.ok)) return null;
  return {
    agentParticipantId: agent.participantId,
    chatScopeRef: chat.chatScopeRef,
    humanParticipantIds: humans.map((h) => h.participantId),
    eventTypes: strList(scope.event_types) ?? [],
    freshnessMs: subscription?.constraints?.freshness_ms,
  };
}

/**
 * 目标订阅的授权是否**完全覆盖**这份快照现在依据的授权。
 *
 * 迁移是重新归属，不是换个指针。少比一样，就可能把 binding 交给一条不该看到它的
 * 订阅 —— 而这件事在下一条消息被放行或被拒之前是看不出来的。所以每一样都要比，
 * 派生不出来或缺字段一律不通过（"没写"不等于"不限制"）。
 */
export function authorizationCovers(subscription, snapshot, { runtimeNamespace } = {}) {
  if (!subscription || !snapshot) return { ok: false, missing: "input" };
  if (subscription.status !== ACTIVE) return { ok: false, missing: "status" };
  if (!nonEmpty(subscription.endpoint_id) || subscription.endpoint_id !== snapshot.endpoint_id) {
    return { ok: false, missing: "endpoint_id" };
  }
  // **跨业务域绝不自动归属。**
  if (!nonEmpty(subscription.domain_id) || subscription.domain_id !== snapshot.domain_id) {
    return { ok: false, missing: "domain_id" };
  }
  const projected = projectSubscription(subscription, runtimeNamespace);
  if (projected === null) return { ok: false, missing: "scope" };
  if (projected.agentParticipantId !== snapshot.agent_participant_id) {
    return { ok: false, missing: "agent_participant_id" };
  }
  if (projected.chatScopeRef !== snapshot.chat_scope_ref) {
    return { ok: false, missing: "chat_scope_ref" };
  }
  const needHumans = strList(snapshot.authorized_human_participant_ids) ?? [];
  if (!covers(projected.humanParticipantIds, needHumans)) {
    return { ok: false, missing: "authorized_human_participant_ids" };
  }
  const needEvents = strList(snapshot.event_types) ?? [];
  if (!covers(projected.eventTypes, needEvents)) return { ok: false, missing: "event_types" };
  // 新的新鲜度窗口更严，就收不下这份快照原本受理的事件 —— 那不是覆盖。
  if (!Number.isFinite(projected.freshnessMs) || !Number.isFinite(snapshot.freshness_ms) ||
      projected.freshnessMs < snapshot.freshness_ms) {
    return { ok: false, missing: "freshness_ms" };
  }
  return { ok: true, missing: null };
}

/** 授权指纹：只含影响授权的字段，**不含 version**。内容没变就是 no-op。 */
const fingerprint = (sub) => JSON.stringify({
  endpoint_id: sub.endpoint_id, domain_id: sub.domain_id, status: sub.status,
  agent_uid: sub.scope?.agent_uid, chat_id: sub.scope?.chat_id,
  transport_open_id: sub.scope?.transport_open_id,
  sender_ids: [...(sub.scope?.sender_ids ?? [])].sort(),
  event_types: [...(sub.scope?.event_types ?? [])].sort(),
  freshness_ms: sub.constraints?.freshness_ms,
});

const reject = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/**
 * 计划条目**只带稳定引用和版本前置条件**。
 *
 * 不回传整份快照或整条目标订阅：那会把 private_binding_key、群和发送者 locator
 * 一路带到调用方和日志里。落盘那一半要的也不是这些，是"改哪个 binding_ref、
 * 在什么版本前置条件下改"。
 */
const entry = (snapshot, action, reason, extra = {}) => ({
  bindingRef: snapshot.binding_ref,
  localTargetId: snapshot.local_target_id,
  action,
  reason,
  // 落盘时用它做 CAS：快照还是当初那一版才允许写。
  expect: {
    subscriptionId: snapshot.subscription_id,
    subscriptionVersion: snapshot.subscription_version,
    authorizationRevision: snapshot.authorization_revision,
    snapshotId: snapshot.snapshot_id,
  },
  ...extra,
});

/**
 * 算出这次变更影响哪些 binding、各该怎么处置。**纯函数，不碰磁盘。**
 *
 * `snapshots` 是正式的 dialogue_binding_authorization 快照，逐份校验。
 * `next` 为 null 表示订阅被撤销。`migrateTo` 是人显式指定的迁移目标
 * subscription_id —— 不给（null）就一律暂停，不自动迁。
 *
 * 输入一律先校验，且**参数对象本身也要能缺**：上一版不带参数直接抛 TypeError，
 * 崩溃不是拒绝。**一个 fail-open 的控制面比没有控制面更危险** ——
 * 它会让人以为已经算过了。
 */
export function planSubscriptionSync(input) {
  // **解构默认值只挡 undefined，不挡 null。**上一版写 `{...} = {}`，
  // planSubscriptionSync(null) 照样抛 TypeError —— 崩溃不是拒绝。
  const {
    previous, next, snapshots = [], others = [], migrateTo = null, runtimeNamespace,
  } = (input && typeof input === "object") ? input : {};
  if (!nonEmpty(runtimeNamespace)) return reject(SYNC_REJECT.NAMESPACE_INVALID);

  const prev = validateSubscription(previous);
  if (!prev.ok) return reject(SYNC_REJECT.PREVIOUS_INVALID, { problems: prev.problems ?? null });

  if (next !== null && next !== undefined) {
    const valid = validateSubscription(next);
    if (!valid.ok) return reject(SYNC_REJECT.SUBSCRIPTION_INVALID, { problems: valid.problems ?? null });
    // 换了 subscription_id 不是"更新"，是把一条订阅替换成另一条 —— 受影响面完全不同。
    if (next.subscription_id !== previous.subscription_id) return reject(SYNC_REJECT.IDENTITY_CHANGED);
  }
  const revokedInput = next === null || next === undefined;

  // **版本单调性先于 no-op。**上一版先比指纹：内容相同而版本从 2 退回 1 时
  // 直接判 no-op 放行 —— 版本回退本身就违反控制面契约，不该因为内容相同而被赦免。
  if (!revokedInput && next.version < previous.version) {
    return reject(SYNC_REJECT.VERSION_NOT_ADVANCED, { from: previous.version, to: next.version });
  }

  if (!Array.isArray(snapshots)) {
    return reject(SYNC_REJECT.SNAPSHOTS_INVALID, { at: -1, problem: "not_an_array" });
  }
  for (const [i, snap] of snapshots.entries()) {
    if (!validateDialogueBindingAuthorizationSnapshot(snap).ok) {
      return reject(SYNC_REJECT.SNAPSHOTS_INVALID, { at: i, problem: "invalid_snapshot" });
    }
  }

  if (!Array.isArray(others)) return reject(SYNC_REJECT.OTHERS_INVALID, { at: -1, problem: "not_an_array" });
  const seen = new Set([previous.subscription_id]);
  for (const [i, o] of others.entries()) {
    if (!validateSubscription(o).ok) return reject(SYNC_REJECT.OTHERS_INVALID, { at: i, problem: "invalid" });
    // 同一个 id 出现两次，"唯一目标"就无从谈起。
    if (seen.has(o.subscription_id)) return reject(SYNC_REJECT.OTHERS_INVALID, { at: i, problem: "duplicate_id" });
    seen.add(o.subscription_id);
  }

  // **显式控制参数的类型错误不能降级成另一种动作。**上一版 migrateTo: 42
  // 被当成"没指定迁移"，静默生成暂停计划 —— 人明明按了迁移。只有 null 是"没指定"。
  if (migrateTo !== null && migrateTo !== undefined && !nonEmpty(migrateTo)) {
    return reject(SYNC_REJECT.MIGRATION_TARGET_INVALID, { migrateTo: typeof migrateTo });
  }
  const target = nonEmpty(migrateTo) ? migrateTo : null;

  // 授权内容一字未变 → 什么都不用做。**生成一份"重新物化"计划不是无害的**：
  // 它会让人以为确实发生了变更，也会让每次保存都刷一遍所有快照。
  if (!revokedInput && fingerprint(next) === fingerprint(previous)) {
    return { ok: true, noop: true, plans: [], counts: { resnapshot: 0, suspend: 0, migrate: 0 } };
  }
  // 内容变了，版本就必须往前走。允许原地不动等于让两份不同的授权共用一个版本号。
  if (!revokedInput && next.version === previous.version) {
    return reject(SYNC_REJECT.VERSION_NOT_ADVANCED, { from: previous.version, to: next.version });
  }

  const revoked = revokedInput;
  const paused = !revoked && next.status !== ACTIVE;
  const plans = [];

  for (const snapshot of snapshots) {
    // **归属看身份。**范围一样但属于别条订阅的快照，不在这次变更范围里。
    if (snapshot.subscription_id !== previous.subscription_id) continue;

    if (!revoked && !paused && authorizationCovers(next, snapshot, { runtimeNamespace }).ok) {
      plans.push(entry(snapshot, SYNC_ACTION.RESNAPSHOT, "scope_changed"));
      continue;
    }

    if (target !== null) {
      const to = others.find((o) => o.subscription_id === target);
      if (!to) return reject(SYNC_REJECT.MIGRATION_TARGET_UNKNOWN, { migrateTo: target });
      const fit = authorizationCovers(to, snapshot, { runtimeNamespace });
      if (!fit.ok) {
        return reject(SYNC_REJECT.MIGRATION_INCOMPATIBLE, {
          migrateTo: target, missing: fit.missing, localTargetId: snapshot.local_target_id,
        });
      }
      plans.push(entry(snapshot, SYNC_ACTION.MIGRATE, "explicit_target", { toSubscriptionId: target }));
      continue;
    }

    // 没有显式目标 → 暂停。有候选也只是告诉人有候选，不替人决定归属。
    const candidates = others.filter((o) => authorizationCovers(o, snapshot, { runtimeNamespace }).ok);
    plans.push(entry(snapshot, SYNC_ACTION.SUSPEND,
      revoked ? "subscription_revoked" : paused ? "subscription_paused" : "no_longer_covered",
      { migrationCandidates: candidates.length }));
  }

  const counts = { resnapshot: 0, suspend: 0, migrate: 0 };
  for (const p of plans) counts[p.action] += 1;
  return { ok: true, noop: false, plans, counts };
}

const ACTION_TEXT = {
  [SYNC_ACTION.RESNAPSHOT]: "重新物化授权快照（binding 照常工作）",
  [SYNC_ACTION.SUSPEND]: "暂停（订阅不再覆盖它，继续收消息就等于没有授权）",
  [SYNC_ACTION.MIGRATE]: "迁移到指定的那条订阅",
};

const REJECT_TEXT = {
  [SYNC_REJECT.SUBSCRIPTION_INVALID]: "新版订阅本身说不清，不能拿它去同步",
  [SYNC_REJECT.PREVIOUS_INVALID]: "变更前那份订阅说不清，算不出谁受影响",
  [SYNC_REJECT.IDENTITY_CHANGED]: "前后不是同一条订阅 —— 那是替换，不是更新",
  [SYNC_REJECT.VERSION_NOT_ADVANCED]: "授权变了但版本没往前走，之后没法判断哪份更新",
  [SYNC_REJECT.SNAPSHOTS_INVALID]: "授权快照说不清，缺了它没法比授权",
  [SYNC_REJECT.OTHERS_INVALID]: "其余订阅列表说不清",
  [SYNC_REJECT.NAMESPACE_INVALID]: "没给运行时命名空间，派生不出可比较的引用",
  [SYNC_REJECT.MIGRATION_TARGET_INVALID]: "迁移目标不是一个订阅 id —— 不猜你是不是想迁",
  [SYNC_REJECT.MIGRATION_TARGET_UNKNOWN]: "指定的迁移目标不在候选里",
  [SYNC_REJECT.MIGRATION_INCOMPATIBLE]:
    "目标订阅的授权覆盖不了这条 binding —— 迁过去就是把它交给一条不该看到它的订阅",
};

export function renderSyncPlan(plan) {
  if (!plan.ok) {
    return "无法同步（" + plan.reason + "）：" + (REJECT_TEXT[plan.reason] ?? plan.reason) +
      (plan.missing ? "（差在 " + plan.missing + "）" : "") +
      (plan.problem ? "（" + plan.problem + "）" : "");
  }
  if (plan.noop) return "授权内容没有变化，无需同步。";
  if (plan.plans.length === 0) return "没有依赖这条订阅的 binding，无需同步。";
  const lines = ["受影响 " + plan.plans.length + " 条 binding："];
  for (const p of plan.plans) {
    // 只出本地 target 的短标识，不出 subscription_id / chat_id 之类。
    const id = String(p.localTargetId ?? "?").slice(0, 12);
    const hint = p.action === SYNC_ACTION.SUSPEND && p.migrationCandidates > 0
      ? "（有 " + p.migrationCandidates + " 条订阅授权上接得住；要迁请显式指定目标）" : "";
    lines.push("  " + id + "…  " + (ACTION_TEXT[p.action] ?? p.action) + hint);
  }
  return lines.join("\n");
}
