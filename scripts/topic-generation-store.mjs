/** Claude adapter 的 Topic Generation Git 外状态读写。 */

import fs from "node:fs";
import path from "node:path";

import { projectMappingPath, resolveProject, selectBindingEntry } from "./project-resolve.mjs";
import {
  acquirePublishLock, registryPath, releasePublishLock,
} from "./registry.mjs";
import {
  ROTATION_STATUS, closePendingTopicGeneration, failTopicRotation,
  materializeLegacyTopicFields, prepareTopicRotation, registerPendingTopicGeneration,
  recordTopicGenerationActivity, resolveMappingOutboundGeneration, topicGenerationStateForLegacy,
  markPendingClaimReminder,
  markPendingClaimReminderAbandoned,
  reserveClaimReminderAttempt,
} from "./topic-generation.mjs";

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
};

export function loadClaudeTopicBinding({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  templateFile,
  now = Date.now(),
} = {}) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile, templateFile });
  if (!resolved.ok) return resolved;
  const state = resolved.mapping?.topic_generation_state;
  if (!state) return { ok: false, reason: "topic_generation_unavailable" };
  return {
    ok: true,
    root,
    source: resolved.source,
    bindingLevel: resolved.bindingLevel,
    claudeSessionId: resolved.claudeSessionId,
    mapping: resolved.mapping,
    config: resolved.config,
    state,
    now,
  };
}

/**
 * 代际变更用的锁目录。**只有这一份定义。**
 *
 * 别处再算一遍是最容易出的那种错：两处各拼一次路径，看起来都在"加锁"，
 * 实际是两把互不认识的锁 —— 而症状只会在并发下偶发出现。
 * 抑制命令要跟轮转串行，就必须拿到**同一个**目录。
 */
export function topicGenerationLockDir({ source, registryFile = registryPath(), root } = {}) {
  if (source === "project-files") {
    return path.join(path.dirname(projectMappingPath(root)), "topic-generation.lock");
  }
  if (source === "registry") return path.join(path.dirname(registryFile), "registry.lock");
  // **说不清就不给锁。**上一版把 undefined 一并当成 registry 绑定，于是
  // 一个根本没绑定的目录也会去动**本机全局的**控制面锁 —— 测试跑一次就碰一次，
  // 未绑定项目的命令还会被报成"轮转中"。不知道该锁哪一把时返回 null，
  // 由调用方决定是拒绝还是走不需要锁的路径。
  return null;
}

function mutateClaudeTopicBinding({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  templateFile,
  now = Date.now(),
  mutate,
} = {}) {
  const current = loadClaudeTopicBinding({ root, claudeSessionId, registryFile, templateFile, now });
  if (!current.ok) return current;
  const projectFile = projectMappingPath(root);
  const projectBacked = current.source === "project-files";
  const lockDir = topicGenerationLockDir({ source: current.source, registryFile, root });
  // 绑定已经解析出来了才走到这里，所以 source 必是两者之一；真出现第三种，
  // 宁可明说也不要拿一把猜出来的锁去写。
  if (lockDir === null) return { ok: false, reason: "binding_source_unknown" };
  const lock = acquirePublishLock(lockDir);
  // 只有"别人正拿着"才是 busy；锁目录不可写之类的 I/O 错误要原样报出去（评审探针：曾被折叠成 busy 静默跳过）。
  if (!lock.ok) {
    return lock.reason === "publisher_busy" ? { ok: false, reason: "binding_busy" }
      : { ok: false, reason: "lock_io_error", error: lock.error ?? lock.reason };
  }
  try {
    if (projectBacked) {
      let record;
      try { record = JSON.parse(fs.readFileSync(projectFile, "utf-8")); }
      catch (err) {
        return { ok: false, reason: "mapping_unreadable", error: String(err.message).slice(0, 200) };
      }
      const bindingId = record.binding_id ?? (path.basename(root) + "@project-files");
      const loaded = topicGenerationStateForLegacy(record, { runtime: "claude", bindingId, now });
      if (!loaded.ok) return loaded;
      const changed = mutate(loaded.state, record);
      if (!changed?.ok) return changed;
      const materialized = materializeLegacyTopicFields(record, changed.state);
      if (!materialized.ok) return materialized;
      const { root_message_id: selectedRootMessageId, ...legacyCompatible } = materialized.record;
      const next = {
        ...legacyCompatible,
        feishu_root_message_id_reference: selectedRootMessageId,
      };
      writeJsonAtomic(projectFile, next);
      return { ...changed, source: current.source, mapping: next };
    }

    let registry;
    try { registry = JSON.parse(fs.readFileSync(registryFile, "utf-8")); }
    catch (err) {
      return { ok: false, reason: "registry_unreadable", error: String(err.message).slice(0, 200) };
    }
    if (!Array.isArray(registry.projects)) return { ok: false, reason: "registry_unreadable" };
    const picked = selectBindingEntry(
      registry.projects.filter((project) => project.root === root),
      claudeSessionId,
    );
    const entry = picked.entry;
    if (!entry) return { ok: false, reason: "entry_gone" };
    const bindingId = (entry.id ?? path.basename(root)) + "@registry";
    const loaded = topicGenerationStateForLegacy(entry, { runtime: "claude", bindingId, now });
    if (!loaded.ok) return loaded;
    const changed = mutate(loaded.state, entry);
    if (!changed?.ok) return changed;
    const materialized = materializeLegacyTopicFields(entry, changed.state);
    if (!materialized.ok) return materialized;
    Object.assign(entry, materialized.record);
    if (fs.existsSync(registryFile)) fs.copyFileSync(registryFile, registryFile + ".prev");
    writeJsonAtomic(registryFile, registry);
    return { ...changed, source: current.source, entry };
  } catch (err) {
    return { ok: false, reason: "binding_unwritable", error: String(err.message).slice(0, 200) };
  } finally {
    releasePublishLock(lockDir);
  }
}

export function prepareClaudeTopicRotation({
  root, claudeSessionId, operationId, registryFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => prepareTopicRotation(state, { operationId, now }),
  });
}

export function registerClaudeTopicRotation({
  root, claudeSessionId, operationId, rootMessageId, pendingToken,
  claimExpiresAt, registryFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => registerPendingTopicGeneration(state, {
      operationId, rootMessageId, pendingToken, claimExpiresAt, now,
    }),
  });
}

export function failClaudeTopicRotation({
  root, claudeSessionId, operationId, reason, registryFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => failTopicRotation(state, { operationId, reason, now }),
  });
}

export function closeClaudeTopicRotation({
  root, claudeSessionId, operationId, reason = ROTATION_STATUS.CANCELLED,
  registryFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => closePendingTopicGeneration(state, { operationId, reason, now }),
  });
}

export function setClaudeTopicBindingStatus({
  root, claudeSessionId, status, registryFile, now = Date.now(),
} = {}) {
  if (!["active", "paused"].includes(status)) return { ok: false, reason: "invalid_status" };
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => {
      if (state.binding_status === status) return { ok: true, changed: false, state };
      const next = JSON.parse(JSON.stringify(state));
      next.binding_status = status;
      next.updated_at = new Date(now).toISOString();
      return { ok: true, changed: true, state: next };
    },
  });
}

/** 原子记录 Claude binding 当前话题代际的一条有效业务消息。 */
export function recordClaudeTopicActivity({
  root, claudeSessionId, generationId, eventKey, messageDelta = 1,
  registryFile, now = Date.now(), retryMs,
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => recordTopicGenerationActivity(state, {
      generationId, eventKey, messageDelta, now, retryMs,
    }),
  });
}

/** 锁内预留一次待认领提醒尝试（判据在锁内重算，并发只有一个能拿到）。 */
export function reserveClaudeClaimReminder({
  root, claudeSessionId, generationId, registryFile, templateFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, templateFile, now,
    mutate: (state) => reserveClaimReminderAttempt(state, { generationId, now }),
  });
}

/** 本周期尝试用尽：原子记下放弃时间，下个周期重来。 */
export function markClaudeClaimReminderAbandoned({
  root, claudeSessionId, generationId, registryFile, templateFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, templateFile, now,
    mutate: (state) => markPendingClaimReminderAbandoned(state, { generationId, now }),
  });
}

/** 原子记下"待认领话题已提醒过"。 */
export function markClaudeClaimReminder({
  root, claudeSessionId, generationId, registryFile, templateFile, now = Date.now(),
} = {}) {
  return mutateClaudeTopicBinding({
    root, claudeSessionId, registryFile, templateFile, now,
    mutate: (state) => markPendingClaimReminder(state, { generationId, now }),
  });
}

export function resolveClaudeOutboundGeneration(binding, generationId) {
  return resolveMappingOutboundGeneration(binding?.mapping, generationId);
}
