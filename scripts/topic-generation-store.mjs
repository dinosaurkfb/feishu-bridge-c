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
  now = Date.now(),
} = {}) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile });
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

function mutateClaudeTopicBinding({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  now = Date.now(),
  mutate,
} = {}) {
  const current = loadClaudeTopicBinding({ root, claudeSessionId, registryFile, now });
  if (!current.ok) return current;
  const projectFile = projectMappingPath(root);
  const projectBacked = current.source === "project-files";
  const lockDir = projectBacked
    ? path.join(path.dirname(projectFile), "topic-generation.lock")
    : path.join(path.dirname(registryFile), "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "binding_busy" };
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

export function resolveClaudeOutboundGeneration(binding, generationId) {
  return resolveMappingOutboundGeneration(binding?.mapping, generationId);
}
