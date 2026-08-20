/**
 * 自动发布一个 Codex task 中已经取得发布资格的 outbox 事件。
 *
 * 资格是事件级的：本地 Stop 可以直接授予；飞书入站回合必须由严格 watcher 在终局确认后
 * 授予。这样升级前的历史积压、失败 run 的半成品答复都不会被下一轮顺带发出。
 */

import { composeDigest, listPending, markSent } from "../outbox.mjs";
import { publishDraft } from "../outbound.mjs";
import { acquirePublishLock, releasePublishLock } from "../registry.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import { bridgeHome, resolveTask, taskPaths } from "./state.mjs";

export function publishEligibleTaskEvents({ task, home = bridgeHome(), timeoutMs = 12_000 } = {}) {
  if (!task || task.auto_publish_on_completion !== true) {
    return { status: "disabled", reason: "auto_publish_disabled" };
  }
  const resolved = resolveTask(task, { home });
  if (!resolved.ok) return { status: "error", reason: resolved.reason };
  if (resolved.mapping.status !== "active" || !resolved.mapping.feishu_root_message_id_reference) {
    return { status: "skipped", reason: "mapping_not_active" };
  }

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
    const messageId = publishDraft({
      profile: identity.profile,
      rootMessageId: resolved.mapping.feishu_root_message_id_reference,
      text: composeDigest(current, { taskName: task.task_display_name }),
      larkBin: identity.bin,
      larkHome: identity.configDir,
      expectedAppId: identity.expectedAppId,
      timeoutMs,
    });
    for (const event of current) markSent(event, messageId);
    return { status: "published", count: current.length, messageId };
  } catch (err) {
    // 不标记、不吞掉；后续 Stop/watcher 会再次尝试所有 eligible 事件。
    return { status: "error", reason: "publish_failed", error: String(err?.message ?? err).slice(0, 400) };
  } finally {
    releasePublishLock(paths.publishLock);
  }
}
