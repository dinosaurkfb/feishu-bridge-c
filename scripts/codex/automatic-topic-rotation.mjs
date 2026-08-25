/** Codex runtime 对共享自动轮转核心的单向适配。 */

import { launchAutomaticTopicRotation } from "../automatic-topic-rotation.mjs";
import { bridgeHome, recordTaskTopicActivity } from "./state.mjs";
import { issueIntent } from "./intent.mjs";

export function recordCodexActivityAndMaybeRotate({
  root,
  threadId,
  home = bridgeHome(),
  generationId,
  eventKey,
  messageDelta = 1,
  now,
  retryMs,
  spawnImpl,
  env,
} = {}) {
  const recorded = recordTaskTopicActivity({
    threadId, home, generationId, eventKey, messageDelta, now, retryMs,
  });
  if (!recorded.ok || !recorded.shouldAutoRotate) return recorded;

  // **签字发生在"确认要轮转"这一刻，不在 launcher 里。**
  //
  // 上一版在 launcher 里签 —— 那等于自签自授权：绕过计数和阈值直接调它，
  // 它照样签票、照样启动 worker。评审直接调 launcher 就复现了。
  //
  // 票绑住这次决定的代际身份：换一代就是另一次决定，旧票不该还能用。
  const issued = issueIntent({
    action: "rotate:auto", threadId,
    params: { project: root, generation: generationId ?? null },
    home,
  });
  if (!issued.ok) {
    return { ...recorded, rotationLaunch: { ok: false, reason: "intent_unissuable", detail: issued.reason } };
  }
  return {
    ...recorded,
    rotationLaunch: launchAutomaticTopicRotation({
      runtime: "codex", root, threadId, home, spawnImpl, env, intentId: issued.id,
    }),
  };
}
