/** Codex task 接入的纯计算；不得 import outbound 或任何网络模块。 */

import path from "node:path";

import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor, readProjectIdentity,
} from "../bind-compose.mjs";
import { findActiveThreadsForRoot, logicalTaskKeyFor } from "./state.mjs";
import { readCodexThreadTitle } from "./thread-title.mjs";

export function validThreadId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function resolveThreadId({ explicit, root }) {
  if (explicit !== undefined) {
    return validThreadId(explicit)
      ? { ok: true, threadId: explicit, source: "--thread-id" }
      : { ok: false, reason: "invalid_thread_id" };
  }
  const active = findActiveThreadsForRoot(root);
  if (active.length === 0) return { ok: false, reason: "no_active_thread" };
  if (active.length > 1) return { ok: false, reason: "multiple_active_threads", count: active.length };
  return { ok: true, threadId: active[0].thread_id, source: "current-hook-lease" };
}

export function composeCodexBinding({ root, threadId, nameOverride, threadDescriptions, globalStateFile }) {
  const identity = readProjectIdentity({ root });
  const bindingIdentity = root + "\n" + threadId;
  const token = bindingToken(bindingIdentity);
  const resolvedTitle = nameOverride
    ? { title: null, source: "--name" }
    : readCodexThreadTitle({ threadId, stateFile: globalStateFile, descriptions: threadDescriptions });
  const taskTitle = resolvedTitle.title && resolvedTitle.title !== identity.name
    ? resolvedTitle.title
    : null;
  const name = nameOverride ?? (taskTitle
    ? identity.name + "｜" + taskTitle
    : identity.name + "｜任务 " + token);
  // 短码必须在首行可见：即使 Desktop 标题拿不到，同仓库的两个 task 也不会再长得一样。
  const heading = !nameOverride && !taskTitle ? name : name + " · " + token;
  const logicalTaskKey = logicalTaskKeyFor(root, threadId);
  return {
    root,
    threadId,
    logicalTaskKey,
    name,
    projectName: identity.name,
    taskTitle,
    heading,
    purpose: identity.purpose,
    identitySource: nameOverride ? "--name" : identity.source + "+" + resolvedTitle.source,
    token,
    idempotencyKey: idempotencyKeyFor(bindingIdentity),
    rootText: composeRootMessage({ name, heading, purpose: identity.purpose, root, token }),
    statusText: composeStatusMessage({ name })
      .replace("在这条消息下面 @ 一下运输 agent", "在这条消息下面真实 @M5Codex")
      .replace(
        "绑完之后，在这个话题里说话就是给 " + name + " 下指令。",
        "绑完之后，在这个话题里真实 @M5Codex，mention 后的正文就是给 " + name +
          " 的指令，不需要额外关键字。",
      ),
  };
}

export const displayThread = (threadId) => threadId.slice(0, 8) + "…";
