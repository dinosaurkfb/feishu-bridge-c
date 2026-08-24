/**
 * 把同步计划真正落到授权快照与 binding 状态上（FR-2.5 的后半段）。
 *
 * 计划器（subscription-sync.mjs）只算不写。这里负责写，而写是有损的 ——
 * 所以整段设计都围着一个问题：**怎么保证写下去的东西，还是当初算出来的那份。**
 *
 * ■ 两层防护，缺一不可
 *
 * 评审的判断是不要在"锁内重算"和"CAS"之间二选一，两层都做：
 *
 *   第一层，锁内重算。取订阅控制域的锁，锁内重读订阅、正式授权快照、相关 binding
 *   和显式迁移目标，用**同一个** planSubscriptionSync() 重新规划，再比规范化的
 *   plan_id。不一致就 plan_stale、**零写入**，并把新算出来的计划给人看。
 *
 *   第二层，逐条 CAS。真正写之前，再核对每一条计划里的 expect 四个字段
 *   （subscription_id / subscription_version / authorization_revision / snapshot_id）。
 *   锁内重算已经挡住了绝大多数漂移，但**锁只在本机有效**，而快照文件可能被别的
 *   路径改写；第二层是对"锁之外还有人动过"的兜底。
 *
 * 为什么不能只做其中一层：只做 CAS 会让"整体计划已经变了、但某几条恰好没变"的
 * 情况通过 —— 那样落下去的是一份**残缺的**计划。只做锁内重算则默认了
 * "锁期间没人绕过锁"，而那是个假设，不是保证。
 *
 * ■ 先构造再写
 *
 * 全部写集先构造好、验证完，再动第一个文件。中途失败不许宣称整体成功 ——
 * 这条是硬要求：一份"一半新一半旧"的授权状态，比没同步更难排查。
 */

import crypto from "node:crypto";

import { SYNC_ACTION } from "./subscription-sync.mjs";

/**
 * 计划指纹。**只含影响写什么的字段**，顺序无关。
 *
 * 这份摘要要能回答一个问题：锁内重算出来的，跟当初给人看的是不是同一份。
 * 所以 binding 顺序不能影响它（重读的顺序本来就可能不同），
 * 但动作、目标、以及每条的 expect 前置条件都必须进去 ——
 * 少放一样，就会出现"指纹相同但写的东西不同"。
 *
 * 本地定义 digest：这个前缀只有本模块算、也只有本模块比，
 * 不存在两处算法分叉的风险。
 */
const digest = (prefix, parts) => prefix + crypto.createHash("sha256")
  .update(parts.join("\0")).digest("hex").slice(0, 24);

export function planId(plan) {
  if (!plan || plan.ok !== true) return null;
  const entries = (plan.plans ?? []).map((p) => ({
    binding_ref: p.bindingRef ?? null,
    action: p.action ?? null,
    to: p.toSubscriptionId ?? null,
    expect: {
      subscription_id: p.expect?.subscriptionId ?? null,
      subscription_version: p.expect?.subscriptionVersion ?? null,
      authorization_revision: p.expect?.authorizationRevision ?? null,
      snapshot_id: p.expect?.snapshotId ?? null,
    },
  })).sort((a, b) => String(a.binding_ref).localeCompare(String(b.binding_ref)));
  return digest("sync_plan_", [
    "subscription-sync-plan/v1",
    JSON.stringify({ noop: plan.noop === true, entries }),
  ]);
}

export const APPLY_REJECT = Object.freeze({
  PLAN_STALE: "plan_stale",
  EXPECT_MISMATCH: "expect_mismatch",
  SNAPSHOT_MISSING: "snapshot_missing",
});

/**
 * 第二道 CAS：这条计划依据的那份快照，现在还是不是当初那一份。
 *
 * 四个字段都要比。只比 snapshot_id 看着够（它是内容摘要），但**摘要相同不等于
 * 这条计划仍然适用** —— 订阅版本换了、授权 revision 涨了，都意味着中间发生过
 * 别的事，而这份计划是照着旧世界算的。
 */
export function verifyExpect(entry, current) {
  if (!current) return { ok: false, reason: APPLY_REJECT.SNAPSHOT_MISSING, field: null };
  const pairs = [
    ["subscription_id", entry?.expect?.subscriptionId, current.subscription_id],
    ["subscription_version", entry?.expect?.subscriptionVersion, current.subscription_version],
    ["authorization_revision", entry?.expect?.authorizationRevision, current.authorization_revision],
    ["snapshot_id", entry?.expect?.snapshotId, current.snapshot_id],
  ];
  for (const [field, want, got] of pairs) {
    if (want === undefined || want === null || want !== got) {
      return { ok: false, reason: APPLY_REJECT.EXPECT_MISMATCH, field, want: want ?? null, got: got ?? null };
    }
  }
  return { ok: true };
}
