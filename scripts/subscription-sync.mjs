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
 * "哪些 binding 原来依赖这条订阅"只能用 binding 记着的 subscription_id 回答。
 * 上一版用范围覆盖代替，于是撤销 sub-a 会把明明属于 sub-b 的同群 binding
 * 一起列进来暂停。范围覆盖只够用来找**迁移候选**，不能代替归属。
 */

import { validateSubscription } from "./subscription.mjs";

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
  BINDINGS_INVALID: "bindings_invalid",
  OTHERS_INVALID: "others_invalid",
  MIGRATION_TARGET_UNKNOWN: "migration_target_unknown",
  MIGRATION_INCOMPATIBLE: "migration_incompatible",
});

const ACTIVE = "active";

const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) && v.every(nonEmpty) && v.length > 0 ? v : null);
const covers = (outer, inner) => inner.every((x) => outer.includes(x));

/** binding 必须自带的字段。**少一个就不校验**等于让不完整的记录绕过所有判据。 */
const BINDING_FIELDS = ["subscription_id", "endpoint_id", "domain_id", "local_target_id",
  "chat_id", "transport_open_id", "agent_uid"];

function validateBinding(binding) {
  if (!isPlainObject(binding)) return "not_an_object";
  for (const f of BINDING_FIELDS) if (!nonEmpty(binding[f])) return f;
  if (!strList(binding.authorized_sender_ids)) return "authorized_sender_ids";
  if (!strList(binding.event_types)) return "event_types";
  if (!Number.isFinite(binding.freshness_ms) || binding.freshness_ms <= 0) return "freshness_ms";
  if (!["active", "suspended"].includes(binding.status)) return "status";
  return null;
}

/**
 * 一条订阅的**范围**覆不覆盖一条 binding —— 只看路由事实。
 *
 * 判据只有可信字段：同一个 endpoint、同一个群、同一个运输身份。刻意不看显示名
 * 或项目路径 —— 那些是展示用的，拿它们判归属就等于让改个名字改变路由。
 *
 * **这不是归属，也不足以支撑迁移。**归属看 binding 记着的 subscription_id；
 * 迁移要过 authorizationCovers() 那一关。这个函数只够用来找候选。
 */
export function subscriptionCovers(subscription, binding) {
  if (!subscription || !binding) return false;
  if (subscription.endpoint_id !== binding.endpoint_id) return false;
  const scope = subscription.scope ?? {};
  if (nonEmpty(binding.chat_id) && scope.chat_id !== binding.chat_id) return false;
  if (nonEmpty(binding.transport_open_id) &&
      scope.transport_open_id !== binding.transport_open_id) return false;
  return true;
}

/**
 * 目标订阅的授权是否**完全覆盖**这条 binding 现在所需的授权。
 *
 * 迁移是重新归属，不是换个指针。少比一样，就可能把 binding 交给一条
 * 不该看到它的订阅 —— 而这件事在下一条消息被放行或被拒之前是看不出来的。
 * 所以每一样都要比，缺字段一律不通过（"没写"不等于"不限制"）。
 */
export function authorizationCovers(subscription, binding) {
  if (!subscription || !binding) return { ok: false, missing: "input" };
  if (subscription.status !== ACTIVE) return { ok: false, missing: "status" };
  for (const [f, a, b] of [
    ["endpoint_id", subscription.endpoint_id, binding.endpoint_id],
    // **跨业务域绝不自动归属。**
    ["domain_id", subscription.domain_id, binding.domain_id],
    ["agent_uid", subscription.scope?.agent_uid, binding.agent_uid],
    ["chat_id", subscription.scope?.chat_id, binding.chat_id],
    ["transport_open_id", subscription.scope?.transport_open_id, binding.transport_open_id],
  ]) {
    if (!nonEmpty(a) || a !== b) return { ok: false, missing: f };
  }
  const senders = strList(subscription.scope?.sender_ids);
  const events = strList(subscription.scope?.event_types);
  const need = { s: strList(binding.authorized_sender_ids), e: strList(binding.event_types) };
  if (!senders || !need.s || !covers(senders, need.s)) return { ok: false, missing: "sender_ids" };
  if (!events || !need.e || !covers(events, need.e)) return { ok: false, missing: "event_types" };
  const fresh = subscription.constraints?.freshness_ms;
  // 新的新鲜度窗口更严，就收不下这条 binding 原本受理的事件 —— 那不是覆盖。
  if (!Number.isFinite(fresh) || !Number.isFinite(binding.freshness_ms) ||
      fresh < binding.freshness_ms) return { ok: false, missing: "freshness_ms" };
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
 * 算出这次变更影响哪些 binding、各该怎么处置。**纯函数，不碰磁盘。**
 *
 * `next` 为 null 表示订阅被撤销。`migrateTo` 是人显式指定的迁移目标
 * subscription_id —— 不给就一律暂停，不自动迁。
 *
 * 输入一律先校验。上一版只校验 next：previous 传 null 照收、bindings 传 null
 * 直接抛 TypeError、版本从 2 退回 1 也认、前后完全相同还生成一份 resnapshot 计划。
 * **一个 fail-open 的控制面比没有控制面更危险** —— 它会让人以为已经算过了。
 */
export function planSubscriptionSync({ previous, next, bindings = [], others = [], migrateTo = null }) {
  const prev = validateSubscription(previous);
  if (!prev.ok) return reject(SYNC_REJECT.PREVIOUS_INVALID, { problems: prev.problems ?? null });

  if (next !== null) {
    const valid = validateSubscription(next);
    if (!valid.ok) return reject(SYNC_REJECT.SUBSCRIPTION_INVALID, { problems: valid.problems ?? null });
    // 换了 subscription_id 不是"更新"，是把一条订阅替换成另一条 —— 受影响面完全不同，
    // 不能借普通更新的外壳走过去。
    if (next.subscription_id !== previous.subscription_id) {
      return reject(SYNC_REJECT.IDENTITY_CHANGED);
    }
  }

  if (!Array.isArray(bindings)) return reject(SYNC_REJECT.BINDINGS_INVALID, { at: -1, problem: "not_an_array" });
  for (const [i, b] of bindings.entries()) {
    const problem = validateBinding(b);
    if (problem) return reject(SYNC_REJECT.BINDINGS_INVALID, { at: i, problem });
  }

  if (!Array.isArray(others)) return reject(SYNC_REJECT.OTHERS_INVALID, { at: -1, problem: "not_an_array" });
  const seen = new Set([previous.subscription_id]);
  for (const [i, o] of others.entries()) {
    const valid = validateSubscription(o);
    if (!valid.ok) return reject(SYNC_REJECT.OTHERS_INVALID, { at: i, problem: "invalid" });
    // 同一个 id 出现两次，"唯一目标"就无从谈起。
    if (seen.has(o.subscription_id)) return reject(SYNC_REJECT.OTHERS_INVALID, { at: i, problem: "duplicate_id" });
    seen.add(o.subscription_id);
  }

  // 授权内容一字未变 → 什么都不用做。**生成一份"重新物化"计划不是无害的**：
  // 它会让人以为确实发生了变更，也会让每次保存都刷一遍所有快照。
  if (next !== null && fingerprint(next) === fingerprint(previous)) {
    return { ok: true, noop: true, plans: [], counts: { resnapshot: 0, suspend: 0, migrate: 0 } };
  }
  // 内容变了，版本就必须往前走。允许回退等于让两份不同的授权共用一个版本号，
  // 之后没有任何办法判断哪一份更新。
  if (next !== null && !(next.version > previous.version)) {
    return reject(SYNC_REJECT.VERSION_NOT_ADVANCED, { from: previous.version, to: next.version });
  }

  const revoked = next === null;
  const paused = !revoked && next.status !== ACTIVE;
  const plans = [];

  for (const binding of bindings) {
    // **归属看身份。**范围一样但属于别条订阅的 binding，不在这次变更范围里。
    if (binding.subscription_id !== previous.subscription_id) continue;

    if (!revoked && !paused && authorizationCovers(next, binding).ok) {
      plans.push({ binding, action: SYNC_ACTION.RESNAPSHOT, reason: "scope_changed" });
      continue;
    }

    if (nonEmpty(migrateTo)) {
      const target = others.find((o) => o.subscription_id === migrateTo);
      if (!target) return reject(SYNC_REJECT.MIGRATION_TARGET_UNKNOWN, { migrateTo });
      const fit = authorizationCovers(target, binding);
      if (!fit.ok) {
        return reject(SYNC_REJECT.MIGRATION_INCOMPATIBLE, {
          migrateTo, missing: fit.missing,
          localTargetId: binding.local_target_id ?? null,
        });
      }
      plans.push({ binding, action: SYNC_ACTION.MIGRATE, to: target, reason: "explicit_target" });
      continue;
    }

    // 没有显式目标 → 暂停。有候选也只是告诉人有候选，不替人决定归属。
    const candidates = others.filter((o) => authorizationCovers(o, binding).ok);
    plans.push({
      binding, action: SYNC_ACTION.SUSPEND,
      reason: revoked ? "subscription_revoked" : paused ? "subscription_paused" : "no_longer_covered",
      migrationCandidates: candidates.length,
    });
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
  [SYNC_REJECT.BINDINGS_INVALID]: "binding 记录不完整，缺字段就没法比授权",
  [SYNC_REJECT.OTHERS_INVALID]: "其余订阅列表说不清",
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
    const id = String(p.binding.local_target_id ?? "?").slice(0, 12);
    const hint = p.action === SYNC_ACTION.SUSPEND && p.migrationCandidates > 0
      ? "（有 " + p.migrationCandidates + " 条订阅授权上接得住；要迁请显式指定目标）" : "";
    lines.push("  " + id + "…  " + (ACTION_TEXT[p.action] ?? p.action) + hint);
  }
  return lines.join("\n");
}
