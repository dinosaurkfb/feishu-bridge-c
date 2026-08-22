/**
 * 控制命令的共用核心：看状态、暂停、恢复；话题轮转由 topic-generation-store 复用同一状态。
 *
 * 跟 Codex 侧的 `$feishu-status` / `$feishu-unbind` / `$feishu-bind` 对齐语义：
 *
 *   status  只读。不改任何东西，也不把 locator、凭据、claim、回执打出来。
 *   unbind  **可恢复地暂停**。绝不删话题、不删登记、不删待发内容、不往飞书发消息。
 *   bind    重新接入；如果原来是暂停状态，**复用原话题恢复**，不新建。
 *
 * 「暂停」用的是绑定本身的 status 字段，因为两个方向本来就都在看它：
 * drainProject 只发 status === "active" 的，evaluateInbound 见到非 active 直接拒。
 * 也就是说暂停不需要新机制 —— 只需要一个已有的闸被翻过来，两边同时生效。
 *
 * 为什么暂停而不是删除：话题里已经有历史对话，删掉登记等于让那段历史变成孤儿；
 * 而待发内容如果一起删，用户会以为"暂停"顺手丢了他还没看到的东西。暂停要能后悔。
 */

import fs from "node:fs";
import path from "node:path";

import { loadRegistry, registryPath } from "./registry.mjs";
import {
  projectMappingPath, resolveProject, selectBindingEntry,
} from "./project-resolve.mjs";
import { outboxDirOf } from "./drain-outbox.mjs";
import { listPending } from "./outbox.mjs";
import { setClaudeTopicBindingStatus } from "./topic-generation-store.mjs";
import { activeGeneration, pendingGeneration } from "./topic-generation.mjs";

export const SUSPENDED = "suspended";

/**
 * 「当前上下文」对应哪条绑定。
 *
 * 跟出站用的是同一条选择规则（selectBindingEntry）—— 状态命令要是按另一套规则找，
 * 就会出现「status 说绑的是 A，实际发到 B」这种最难查的不一致。
 */
export function currentBinding({ root, claudeSessionId, registryFile, templateFile } = {}) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile, templateFile });
  if (!resolved.ok) return { ok: false, reason: resolved.reason, root };

  const outboxDir = outboxDirOf(root, resolved.claudeSessionId);
  let pending = 0;
  try { pending = listPending({ outboxDir }).length; } catch { /* 目录还没建：0 条 */ }

  const m = resolved.mapping;
  const topicState = m.topic_generation_state ?? null;
  const activeTopic = activeGeneration(topicState);
  const pendingTopic = pendingGeneration(topicState);
  return {
    ok: true,
    root,
    source: resolved.source,
    level: resolved.bindingLevel,
    claudeSessionId: resolved.claudeSessionId,
    status: m.status ?? "active",
    suspended: (m.status ?? "active") !== "active",
    inboundBound: typeof m.session_id === "string" && !!m.session_id,
    expiresAt: m.expires_at ?? null,
    displayName: resolved.config?.task_display_name ?? path.basename(root),
    pending,
    activeGeneration: activeTopic?.generation ?? null,
    pendingGeneration: pendingTopic?.generation ?? null,
    pendingGenerationExpiresAt: pendingTopic?.claim_expires_at ?? null,
    readOnlyGenerations: topicState?.generations?.filter((generation) =>
      generation.status === "read-only").length ?? 0,
    // 话题 id 是 locator，只在需要时由调用方决定要不要显示；默认不进人类可读输出。
    _rootMessageId: m.feishu_root_message_id_reference ?? null,
  };
}

/**
 * 把绑定的 status 改掉。两种存放形式都支持。
 *
 * 只碰 status 一个字段，其余原样 —— 暂停要能原地恢复，改多了就恢复不回去了。
 */
export function setBindingStatus({ root, claudeSessionId, status, registryFile, now = Date.now() }) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  if (resolved.mapping?.topic_generation_state) {
    const normalizedStatus = status === SUSPENDED ? "paused" : status;
    const changed = setClaudeTopicBindingStatus({
      root, claudeSessionId, status: normalizedStatus, registryFile, now,
    });
    if (!changed.ok) return changed;
    return {
      ok: true,
      changed: changed.changed !== false,
      status,
      store: resolved.source === "project-files"
        ? projectMappingPath(root)
        : (registryFile ?? registryPath()),
    };
  }

  const stamp = new Date(now).toISOString();

  if (resolved.source === "project-files") {
    const file = projectMappingPath(root);
    let mapping;
    try { mapping = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (err) {
      return { ok: false, reason: "mapping_unreadable", error: String(err.message).slice(0, 200) };
    }
    if ((mapping.status ?? "active") === status) return { ok: true, changed: false, status };
    const next = { ...mapping, status, status_changed_at: stamp };
    writeAtomic(file, next);
    return { ok: true, changed: true, status, store: file };
  }

  const file = registryFile ?? registryPath();
  let reg;
  try { reg = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (err) {
    return { ok: false, reason: "registry_unreadable", error: String(err.message).slice(0, 200) };
  }
  const bound = (reg.projects ?? []).filter((p) => p?.root === root && p?.root_message_id);
  const picked = selectBindingEntry(bound, claudeSessionId).entry;
  if (!picked) return { ok: false, reason: "not_bound" };
  if ((picked.status ?? "active") === status) return { ok: true, changed: false, status };

  picked.status = status;
  picked.status_changed_at = stamp;
  try { fs.copyFileSync(file, file + ".prev"); } catch { /* 首次没有前一版 */ }
  writeAtomic(file, reg);
  return { ok: true, changed: true, status, store: file };
}

function writeAtomic(file, obj) {
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 这个项目下**所有**绑定的概览 —— 多条工作线时要能一眼看出各自的状态。 */
export function bindingsForRoot({ root, registryFile } = {}) {
  const reg = loadRegistry(registryFile);
  if (!reg.ok) return [];
  return reg.projects
    .filter((p) => p.root === root && p.root_message_id)
    .map((p) => ({
      id: p.id,
      level: p.claude_session_id ? "session" : "project",
      claudeSessionId: p.claude_session_id ?? null,
      sessionName: p.claude_session_name ?? null,
      status: p.status ?? "active",
      inboundBound: typeof p.session_id === "string" && !!p.session_id,
    }));
}

/** 人类可读的状态摘要。刻意不打印任何 locator（话题 id、session id 全长、凭据）。 */
export function describeStatus(st, others = []) {
  if (!st.ok) {
    if (st.reason === "not_bound") {
      return ["这个项目还没有接入飞书。",
        "接入：node scripts/bind-project.mjs --apply（整个项目）",
        "或在某条工作线的会话里：node scripts/bind-session.mjs --apply"].join("\n");
    }
    return "读不到绑定状态（" + st.reason + "）。";
  }

  const lines = [];
  lines.push(st.suspended ? "⏸ 已暂停 · " + st.displayName : "✅ 已接入 · " + st.displayName);
  lines.push("绑定级别  " + (st.level === "session"
    ? "这条工作线单独绑定（会话 " + String(st.claudeSessionId).slice(0, 8) + "）"
    : "整个项目共用一个话题"));
  lines.push("当前代际  " + (st.activeGeneration === null ? "尚未完成首次认领" : "第 " + st.activeGeneration + " 代"));
  if (st.pendingGeneration !== null) {
    lines.push("待认领    第 " + st.pendingGeneration + " 代" +
      (st.pendingGenerationExpiresAt ? "（截止 " + st.pendingGenerationExpiresAt + "）" : ""));
  }
  if (st.readOnlyGenerations > 0) lines.push("只读历史  " + st.readOnlyGenerations + " 个代际");
  lines.push("出站      " + (st.suspended ? "暂停中，进展留在本地不发出" : "正常"));
  lines.push("入站      " + (st.suspended ? "暂停中，话题里的指令一律被拒"
    : st.inboundBound ? "已绑定" : "还差一步：去话题里 @ 一下运输 agent"));
  if (st.expiresAt) lines.push("有效期    " + String(st.expiresAt).slice(0, 10));
  lines.push("待发      " + st.pending + " 条" + (st.pending && st.suspended ? "（恢复后会发出）" : ""));

  if (others.length > 1) {
    lines.push("");
    lines.push("这个项目共有 " + others.length + " 条绑定：");
    for (const o of others) {
      lines.push("  · " + (o.level === "session"
        ? "工作线 " + (o.sessionName ?? String(o.claudeSessionId).slice(0, 8))
        : "项目级") + "  " + (o.status === "active" ? "正常" : o.status));
    }
  }

  if (st.suspended) lines.push("", "恢复：node scripts/bind-project.mjs --apply（会复用原话题，不新建）");
  return lines.join("\n");
}
