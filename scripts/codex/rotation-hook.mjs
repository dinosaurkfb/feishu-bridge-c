/**
 * Codex 侧发布后的轮转记账钩子。**drain 与自动发布共用这一份**
 * （与 Claude 侧 claudeRotationBatchHook 同形状 —— 各抄一份的话
 * "检查 ok:false"这类修法就会又一次只修一处）。
 * 只记账不否决；记账函数失败不抛、返回 ok:false —— 转成受控抛错，
 * 让发布事务归进 bookkeepingFailures（发布已成，照样落标防重发）。
 */

import { businessActivitiesForPublishedBatch } from "../automatic-topic-rotation.mjs";
import { recordCodexActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";

export function codexRotationBatchHook({ root, threadId, home }) {
  return ({ batch, target, messageId }) => {
    for (const activity of businessActivitiesForPublishedBatch(batch, {
      messageId, runtime: "codex",
    })) {
      const recorded = recordCodexActivityAndMaybeRotate({
        root, threadId, home,
        generationId: target.channelGenerationId,
        ...activity,
      });
      if (recorded && recorded.ok === false) {
        throw new Error("轮转活动记账失败（" + (recorded.reason ?? "说不清") + "）");
      }
    }
  };
}
