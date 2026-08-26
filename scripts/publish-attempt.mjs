/**
 * **唯一的 outbox 发布事务。**
 *
 * ■ 为什么要有它
 *
 * 同一条「发布尝试」策略曾有四份手写实现（Claude drain / Claude watcher /
 * Codex drain / Codex publish-eligible），锁、审计、候选选择、失败记账
 * 各自组合低层原语。A 批次连续五轮返修的失败形状完全相同：
 * **接了 N 个消费者漏了第 N+1 个** —— 靠人工找齐消费者，漏是常态。
 * 这个模块把策略收进一个承重接口，入口只提供四样：
 * 怎么解析目标代际、怎么构卡、怎么发一批、（可选）发完一批记什么账。
 *
 * ■ 形状
 *
 * 跟第 3 层抑制事务同构：**锁 → 单快照 → 审计闸门 → 动作**。
 * 抑制是它的写侧镜像 —— 两边共用 readOutboxSnapshot 与 outboxMutationBlocker，
 * 判据不另写。
 *
 * ■ 已知边界（计划文档 §R2 如实记下的）
 *
 * 飞书网络写与本地 markSent 不可能构成真正的原子事务 ——
 * "消息已发出、进程在落标前崩溃"仍可能重发。
 * "事务"指本地状态变更的一致性，**不承诺 exactly-once**。
 * watcher 的 run 结果是事务外的第二条通道（第 6 层评审定的例外），
 * 共用这把锁但互不进对方的审计闸门 —— 见 R2b1。
 */

import path from "node:path";

import {
  isPermanentlyRejected, markSent, outboxMutationBlocker, readOutboxSnapshot,
  recordPublishFailure, retryProtection,
} from "./outbox.mjs";
import { hasPublishAuthorization } from "./outbox.mjs";
import { normalizePublishFailure, publishRetryability } from "./publish-failure.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";

/**
 * 候选策略。**受控枚举，不接受 selector 回调** ——
 * 回调就是又一个能重写判据的口子（架构评审点名）。
 *
 *   all_unpaused          —— 三态 pending ∧ 未暂停（drain / watcher / Codex drain）
 *   authorized_only       —— 再加 hasPublishAuthorization（Codex 自动发布；
 *                            第 5 层的判据收敛在这里结构性地发生 ——
 *                            这里只**消费**授权结论，不生产它）
 *   explicit_retry_paused —— 连已暂停的一起放行（人显式 --retry-rejected）
 */
export const CANDIDATE_POLICIES = Object.freeze([
  "all_unpaused", "authorized_only", "explicit_retry_paused",
]);
const POLICY_SET = new Set(CANDIDATE_POLICIES);

/**
 * 按冻结目标代际分组。**只有这一份** ——
 * 此前 drain 导出一份、watcher 私有抄一份，改一处漏一处。
 * 旧格式记录（无目标字段）归入 `__legacy_active__`，由 resolveTarget(null) 解析。
 */
export const LEGACY_TARGET_KEY = "__legacy_active__";
export const groupByTargetGeneration = (records) => {
  const groups = new Map();
  for (const record of records) {
    const key = record.target_channel_generation_id ?? LEGACY_TARGET_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()];
};

/**
 * 一次发布尝试。**锁内单快照，成败都有账。**
 *
 * @param outboxDir        outbox 目录
 * @param lockDir          发布锁目录（跟抑制、资格提升共用同一把）
 * @param policy           CANDIDATE_POLICIES 之一，别的一律抛 —— 枚举是闭的
 * @param dryRun           预演：走完选择与构卡，不发布、**零改盘**
 * @param batchCards       (records) => records[][]  按卡片规则切批（入口的协议）
 * @param resolveTarget    (generationKeyOrNull) => {ok:true,...} | {ok:false,reason}
 * @param composeCard      (batch, target) => card
 * @param publishBatch     ({target, card}) => messageId（真正出网的那一步）
 * @param onBatchPublished 可选 ({batch, target, messageId})，**只许记账不许否决** ——
 *                         在 publish 之后、markSent 之前调用（维持既有顺序：
 *                         轮转活动记录先于落标）。它抛错按发布失败处理。
 *
 * @returns
 *   { status:"skipped", reason }                     拿不到锁
 *   { status:"error", local:true, ... }              审计闸门拦下（整批 fail-closed 并点名）
 *   { status:"empty" }
 *   { status:"needs_attention", count, rejected }    全是已暂停的 —— 不许报 empty
 *   { status:"dry_run", count, batches, selected }
 *   { status:"published", count, messageId, messageIds }
 *   { status:"error", reason:"publish_failed", permanent, permanentKind,
 *     permanentReason, markedRejected, error, failingTarget }
 */
export function publishOutboxAttempt({
  outboxDir, lockDir, policy, dryRun = false,
  batchCards, resolveTarget, composeCard, publishBatch, onBatchPublished = null,
}) {
  if (!POLICY_SET.has(policy)) {
    throw new TypeError("未知候选策略：" + String(policy) +
      " —— 枚举是闭的，新策略先进 CANDIDATE_POLICIES 再用");
  }

  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { status: "skipped", reason: lock.reason };

  let failingTarget = null;
  let failingBatch = null;
  try {
    // **锁内只读这一次盘。**审计、选择、构卡、写回全用这一份快照 ——
    // 上一版是 auditOutbox + listPending 两次读，两读之间的窗口
    // 正是第 3 层在预览上被击穿过的那种。
    const snap = readOutboxSnapshot(outboxDir);
    if (!snap.ok) return { status: "error", reason: snap.reason, local: true };
    // 能不能动只认统一守卫。整批 fail-closed 并点名，不静默跳过单个坏文件。
    const blocked = outboxMutationBlocker(snap.audit);
    if (blocked) return { status: "error", ...blocked, local: true };

    // 候选选择：**判据全部来自共用投影 / 共用授权谓词**，这里不新造。
    const all = snap.records;
    const paused = all.filter(isPermanentlyRejected);
    const selected = policy === "explicit_retry_paused"
      ? all
      : all.filter((r) => !isPermanentlyRejected(r))
        .filter((r) => policy !== "authorized_only" || hasPublishAuthorization(r));

    if (selected.length === 0) {
      // **有被暂停的就不能报 empty** —— 一份假的「没有积压」比没有报告更坏。
      // authorized_only 下"未授权的 pending"不算积压问题（授权由第 5 层的链生产）。
      if (policy !== "explicit_retry_paused" && paused.length > 0) {
        return {
          status: "needs_attention", reason: "permanently_rejected",
          count: paused.length,
          rejected: paused.map((r) => {
            const rp = retryProtection(r);
            return { file: path.basename(String(r._file ?? "")),
              kind: rp.status === "paused" ? rp.kind : null,
              why: rp.status === "paused" ? rp.reason : "未说明" };
          }),
        };
      }
      return { status: "empty" };
    }

    const targetBatches = groupByTargetGeneration(selected).flatMap(([targetKey, records]) => {
      const target = resolveTarget(targetKey === LEGACY_TARGET_KEY ? null : targetKey);
      if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
      return batchCards(records).map((batch) => ({
        batch, target, card: composeCard(batch, target),
      }));
    });

    if (dryRun) {
      // **预演零改盘** —— 这条在显式重试上被击穿过一次（预先清标），
      // 现在结构上不可能：清标只发生在 markSent 里，而 dry-run 走不到那儿。
      return { status: "dry_run", count: selected.length, batches: targetBatches, selected };
    }

    const messageIds = [];
    for (const item of targetBatches) {
      // 失败要打在**这一批**上、诊断要查**这一个**目标 —— 不是全部待发。
      failingTarget = item.target;
      failingBatch = item.batch;
      const messageId = publishBatch({ target: item.target, card: item.card });
      // 记账钩子在 publish 之后、markSent 之前 —— 维持既有顺序（轮转先于落标）。
      if (onBatchPublished) onBatchPublished({ batch: item.batch, target: item.target, messageId });
      // 发布成功才落标；保护字段在同一次写里清掉。
      for (const record of item.batch) markSent(record, messageId);
      messageIds.push(messageId);
    }
    return {
      status: "published", count: selected.length,
      messageId: messageIds.at(-1) ?? null, messageIds,
    };
  } catch (err) {
    // 失败批次不落标、不吞掉；**成败都有账**。
    // 锁还在手里（catch 在 finally 之前），改语义跟抑制、资格提升共用这把锁。
    const failure = normalizePublishFailure(err);
    const retryability = publishRetryability(failure);
    const marked = [];
    let pausedKind = null;
    for (const record of failingBatch ?? []) {
      try {
        const outcome = recordPublishFailure(record, {
          permanent: retryability.permanent,
          reason: retryability.reason + "：" + failure.display,
        });
        if (outcome.paused) {
          marked.push(path.basename(String(record._file ?? "")));
          pausedKind = outcome.kind;
        }
      } catch { /* 记不上不算失败：下一轮还会再撞一次，但不会更坏 */ }
    }
    return {
      status: "error", reason: "publish_failed",
      // **报"永久"以实际打没打标为准**；成因以实际落盘的那个为准。
      permanent: marked.length > 0,
      permanentKind: pausedKind,
      permanentReason: pausedKind === null ? null
        : (pausedKind === "platform_rejected" ? retryability.reason : "retry_exhausted"),
      markedRejected: marked,
      error: failure.display,
      failingTarget,
    };
  } finally {
    releasePublishLock(lockDir);
  }
}
