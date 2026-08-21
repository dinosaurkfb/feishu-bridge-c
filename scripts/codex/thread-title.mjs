/** Codex Desktop 的 task 标题解析；失败时必须安静回退，不能阻断绑定。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const THREAD_TITLE_MAX = 48;

export function sanitizeThreadTitle(value, { threadId, maxLength = THREAD_TITLE_MAX } = {}) {
  if (typeof value !== "string") return null;
  let title = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[#>*_`~\-\s]+|[#>*_`~\-\s]+$/g, "")
    .trim();
  if (!title) return null;

  // task locator 是本机敏感路由信息；即使 Desktop 的标题异常也不把它带进飞书。
  if (threadId) title = title.replaceAll(threadId, "Codex task").replace(/\s+/g, " ").trim();
  if (!title) return null;

  const chars = Array.from(title);
  return chars.length <= maxLength ? title : chars.slice(0, maxLength - 1).join("") + "…";
}

export function defaultCodexGlobalStateFile() {
  return path.join(os.homedir(), ".codex", ".codex-global-state.json");
}

/**
 * Desktop 把用户可见标题登记在 thread-descriptions-v1。只按精确 thread id 取值，
 * 不按项目、最近使用时间或标题模糊匹配，避免给同一仓库的另一个长期 task 建错话题。
 */
export function readCodexThreadTitle({
  threadId,
  stateFile = defaultCodexGlobalStateFile(),
  descriptions,
} = {}) {
  try {
    let index = descriptions;
    if (index === undefined) {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      index = state?.["electron-persisted-atom-state"]?.["thread-descriptions-v1"];
    }
    if (!index || typeof index !== "object" || Array.isArray(index)) {
      return { title: null, source: "unavailable" };
    }
    const title = sanitizeThreadTitle(index[threadId], { threadId });
    return title
      ? { title, source: "codex-desktop-title" }
      : { title: null, source: "missing" };
  } catch {
    return { title: null, source: "unavailable" };
  }
}
