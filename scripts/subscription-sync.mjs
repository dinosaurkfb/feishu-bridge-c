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
 *   migrate     另有一条订阅覆盖它 → 迁到那条。**只有唯一命中才算迁移**；
 *               多条命中是歧义，按 FR-2.6 的同一条理由拒绝，不猜。
 */

import { validateSubscription } from "./subscription.mjs";

export const SYNC_ACTION = Object.freeze({
  RESNAPSHOT: "resnapshot",
  SUSPEND: "suspend",
  MIGRATE: "migrate",
});

export const SYNC_REJECT = Object.freeze({
  SUBSCRIPTION_INVALID: "subscription_invalid",
  AMBIGUOUS_TARGET: "ambiguous_migration_target",
});

const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/**
 * 一条订阅覆不覆盖一条 binding。
 *
 * 覆盖的判据只有**可信字段**：同一个 endpoint、同一个群、同一个运输身份。
 * 刻意不看 binding 的显示名或项目路径 —— 那些是展示用的，
 * 拿它们判归属就等于让改个名字改变路由。
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

const ACTIVE = "active";

/**
 * 算出这次变更影响哪些 binding、各该怎么处置。**纯函数，不碰磁盘。**
 *
 * `next` 为 null 表示订阅被撤销。
 */
export function planSubscriptionSync({ previous, next, bindings = [], others = [] }) {
  // 撤销时 next 为 null；否则新版本必须自身合法 —— 拿一份说不清的订阅去同步，
  // 只会把说不清扩散到每一条 binding 上。
  if (next !== null) {
    const valid = validateSubscription(next);
    if (!valid.ok) {
      return { ok: false, reason: SYNC_REJECT.SUBSCRIPTION_INVALID, problems: valid.problems ?? null };
    }
  }

  const revoked = next === null;
  const paused = !revoked && next.status !== ACTIVE;
  const plans = [];

  for (const binding of bindings) {
    // 只管**原来归这条订阅**的 binding。别的订阅的事不在这次变更范围里。
    if (!subscriptionCovers(previous, binding)) continue;

    const stillCovered = !revoked && !paused && subscriptionCovers(next, binding);
    if (stillCovered) {
      plans.push({ binding, action: SYNC_ACTION.RESNAPSHOT, reason: "scope_changed" });
      continue;
    }

    // 不再覆盖 → 看有没有**唯一**一条别的订阅接得住。
    const candidates = others.filter((s) =>
      s.status === ACTIVE && subscriptionCovers(s, binding));
    if (candidates.length === 1) {
      plans.push({ binding, action: SYNC_ACTION.MIGRATE, to: candidates[0], reason: "single_cover" });
      continue;
    }
    if (candidates.length > 1) {
      // 多条命中是歧义。跟 FR-2.6 首次认领同一条理由：**不猜**，
      // 而且这里比认领更严重 —— 认领错了拒一条消息，迁移错了整条 binding 就归错了人。
      return {
        ok: false, reason: SYNC_REJECT.AMBIGUOUS_TARGET,
        localTargetId: binding.local_target_id ?? null, candidates: candidates.length,
      };
    }
    plans.push({
      binding, action: SYNC_ACTION.SUSPEND,
      reason: revoked ? "subscription_revoked" : paused ? "subscription_paused" : "no_longer_covered",
    });
  }

  const counts = { resnapshot: 0, suspend: 0, migrate: 0 };
  for (const p of plans) counts[p.action] += 1;
  return { ok: true, plans, counts };
}

const ACTION_TEXT = {
  [SYNC_ACTION.RESNAPSHOT]: "重新物化授权快照（binding 照常工作）",
  [SYNC_ACTION.SUSPEND]: "暂停（订阅不再覆盖它，继续收消息就等于没有授权）",
  [SYNC_ACTION.MIGRATE]: "迁移到另一条订阅",
};

const REJECT_TEXT = {
  [SYNC_REJECT.SUBSCRIPTION_INVALID]: "新版订阅本身说不清，不能拿它去同步",
  [SYNC_REJECT.AMBIGUOUS_TARGET]:
    "有多条订阅都能接住同一条 binding，说不清该迁给谁 —— 迁错了整条 binding 就归错了人",
};

export function renderSyncPlan(plan) {
  if (!plan.ok) {
    return "无法同步（" + plan.reason + "）：" + (REJECT_TEXT[plan.reason] ?? plan.reason) +
      (plan.candidates ? "（命中 " + plan.candidates + " 条）" : "");
  }
  if (plan.plans.length === 0) return "没有依赖这条订阅的 binding，无需同步。";
  const lines = ["受影响 " + plan.plans.length + " 条 binding："];
  for (const p of plan.plans) {
    // 只出本地 target 的短标识，不出 subscription_id / chat_id 之类。
    const id = String(p.binding.local_target_id ?? "?").slice(0, 12);
    lines.push("  " + id + "…  " + (ACTION_TEXT[p.action] ?? p.action));
  }
  return lines.join("\n");
}
