/** Codex runtime 对共享自动轮转核心的单向适配。 */

import { launchAutomaticTopicRotation } from "../automatic-topic-rotation.mjs";
import { bridgeHome, recordTaskTopicActivity } from "./state.mjs";

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
  return {
    ...recorded,
    rotationLaunch: launchAutomaticTopicRotation({
      runtime: "codex", root, threadId, home, spawnImpl, env,
    }),
  };
}
