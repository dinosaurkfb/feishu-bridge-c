/**
 * 自动发布一个 Codex task 中已经取得发布资格的 outbox 事件。
 *
 * 资格是事件级的：本地 Stop 可以直接授予；飞书入站回合必须由严格 watcher 在终局确认后
 * 授予。这样升级前的历史积压、失败 run 的半成品答复都不会被下一轮顺带发出。
 */

import { listPending, markSent } from "../outbox.mjs";
import { publishDraft } from "../outbound.mjs";
import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import fs from "node:fs";
import { assertPublishIdentity, resolveLarkIdentity } from "../chain-template.mjs";
import { composeCodexOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import {
  businessActivitiesForPublishedBatch,
} from "../automatic-topic-rotation.mjs";
import { recordCodexActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";
import {
  bridgeHome, resolveTask, resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

const groupByTargetGeneration = (records) => {
  const groups = new Map();
  for (const record of records) {
    const key = record.target_channel_generation_id ?? "__legacy_active__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()];
};

/**
 * 发送之前必须成立的每一件事 —— **不碰 outbox、不发任何东西**。
 *
 * 抽出来是因为兜底调度器的启用门槛要验"这条链跑不跑得通"。
 * 上一版那道门槛把整个 publishEligibleTaskEvents 换成假的，于是它验的是
 * "我的假函数能被调用"，跟真实链路无关：评审实测同一个 task 门禁报 ok，
 * 真实路径却是 template_unusable。**替换掉被测对象的检查等于没有检查。**
 *
 * 主链自己也走这个函数 —— 分成两份写的话，门槛迟早验的是另一件事。
 */
export function preflightTask({ task, home = bridgeHome() } = {}) {
  if (!task || task.auto_publish_on_completion !== true) {
    return { ok: false, status: "disabled", reason: "auto_publish_disabled" };
  }
  const resolved = resolveTask(task, { home });
  if (!resolved.ok) return { ok: false, status: "error", reason: resolved.reason };
  if (resolved.mapping.status !== "active" || !resolved.mapping.feishu_root_message_id_reference) {
    return { ok: false, status: "skipped", reason: "mapping_not_active" };
  }
  // **resolveLarkIdentity 只是拼路径，它永远返回对象。**
  // 上一版拿它当身份检查，于是 lark-cli 不存在、凭据目录读不出来、
  // profile 不在、凭据的 app id 跟配置对不上 —— 一律"通过"。
  // 评审用不存在的二进制和凭据目录实测，门槛照样报 ok:true。
  //
  // 真正的检查是 assertPublishIdentity（"我手上这份凭据确实属于我以为的那个应用"），
  // 加上 lark-cli 本身可不可执行。**发之前会做的，门槛就得做。**
  let identity;
  try {
    identity = resolveLarkIdentity(resolved.template);
  } catch (err) {
    return { ok: false, status: "error", reason: "identity_unresolved",
      error: String(err?.message ?? err).slice(0, 200) };
  }
  const bin = identity?.bin;
  if (typeof bin !== "string" || bin.length === 0) {
    return { ok: false, status: "error", reason: "lark_cli_unset" };
  }
  try { fs.accessSync(bin, fs.constants.X_OK); }
  catch { return { ok: false, status: "error", reason: "lark_cli_not_executable" }; }
  const checked = assertPublishIdentity(identity);
  if (!checked?.ok) {
    return { ok: false, status: "error",
      reason: checked?.reason ?? "identity_mismatch" };
  }
  return { ok: true, resolved, identity };
}

export function publishEligibleTaskEvents({ task, home = bridgeHome(), timeoutMs = 12_000 } = {}) {
  const pre = preflightTask({ task, home });
  if (!pre.ok) return { status: pre.status, reason: pre.reason };
  const resolved = pre.resolved;

  const paths = taskPaths(task, home);
  const eligible = () => listPending({ outboxDir: paths.outbox })
    .filter((event) => typeof event.publish_eligible_at === "string" && event.publish_eligible_at);
  if (eligible().length === 0) return { status: "empty" };

  const lock = acquirePublishLock(paths.publishLock);
  if (!lock.ok) return { status: "deferred", reason: lock.reason };
  try {
    // 锁内重读，避免 Stop 与 watcher 同时拿到同一批事件。
    const current = eligible();
    if (current.length === 0) return { status: "empty" };
    const identity = resolveLarkIdentity(resolved.template);
    const messageIds = [];
    // reply 一轮一张卡，才能让本地输入与对应答复保持精确配对。没有回合可依附的进展
    // 继续合批，避免同类通知把话题刷屏。每张成功后立即标记，后续失败不会重发前一张。
    for (const [targetKey, targetRecords] of groupByTargetGeneration(current)) {
      const target = resolveTaskOutboundGeneration(
        task,
        targetKey === "__legacy_active__" ? null : targetKey,
      );
      if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
      for (const batch of outboundCardBatches(targetRecords)) {
        const messageId = publishDraft({
          profile: identity.profile,
          rootMessageId: target.rootMessageId,
          card: composeCodexOutboundCard(batch, { taskName: task.task_display_name }),
          larkBin: identity.bin,
          larkHome: identity.configDir,
          expectedAppId: identity.expectedAppId,
          timeoutMs,
        });
        for (const activity of businessActivitiesForPublishedBatch(batch, {
          messageId, runtime: "codex",
        })) {
          recordCodexActivityAndMaybeRotate({
            root: task.root,
            threadId: task.codex_thread_id,
            home,
            generationId: target.channelGenerationId,
            ...activity,
          });
        }
        for (const event of batch) markSent(event, messageId);
        messageIds.push(messageId);
      }
    }
    return {
      status: "published",
      count: current.length,
      messageId: messageIds.at(-1) ?? null,
      messageIds,
    };
  } catch (err) {
    // 不标记、不吞掉；后续 Stop/watcher 会再次尝试所有 eligible 事件。
    return { status: "error", reason: "publish_failed", error: String(err?.message ?? err).slice(0, 400) };
  } finally {
    releasePublishLock(paths.publishLock);
  }
}
