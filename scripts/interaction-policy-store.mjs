/** Claude adapter 的 Interaction Policy Git 外状态读写。 */

import fs from "node:fs";
import path from "node:path";

import {
  finalizeDialogueTurn, interactionPolicyStateForLegacy, materializeInteractionPolicy,
  reserveDialogueTurn, setInteractionPolicyMode,
} from "./interaction-policy.mjs";
import { projectMappingPath, resolveProject, selectBindingEntry } from "./project-resolve.mjs";
import { effectiveBindingId } from "./topic-generation.mjs";
import { acquirePublishLock, registryPath, releasePublishLock } from "./registry.mjs";

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
};

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const acquireStateLock = (lockDir, retries = 0) => {
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = acquirePublishLock(lockDir);
    if (result.ok || result.reason !== "publisher_busy") return result;
    if (attempt < retries) Atomics.wait(LOCK_WAIT, 0, 0, 25);
  }
  return result;
};

export function loadClaudeInteractionPolicy({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  now = Date.now(),
} = {}) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile });
  if (!resolved.ok) return resolved;
  const bindingId = effectiveBindingId(resolved.mapping, { root });
  const loaded = interactionPolicyStateForLegacy(resolved.mapping, { bindingId, now });
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    root,
    source: resolved.source,
    bindingLevel: resolved.bindingLevel,
    claudeSessionId: resolved.claudeSessionId,
    mapping: resolved.mapping,
    config: resolved.config,
    state: loaded.state,
    migrated: loaded.migrated,
  };
}

function mutateClaudeInteractionPolicy({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  now = Date.now(),
  lockRetries = 0,
  mutate,
} = {}) {
  const current = loadClaudeInteractionPolicy({ root, claudeSessionId, registryFile, now });
  if (!current.ok) return current;
  const projectFile = projectMappingPath(root);
  const projectBacked = current.source === "project-files";
  // 同一 mapping 文件里的 Topic Generation 与 Interaction Policy 必须共用一把锁，
  // 否则两个独立原子 replace 仍可能互相覆盖对方刚写入的字段。
  const lockDir = projectBacked
    ? path.join(path.dirname(projectFile), "topic-generation.lock")
    : path.join(path.dirname(registryFile), "registry.lock");
  const lock = acquireStateLock(lockDir, lockRetries);
  if (!lock.ok) return { ok: false, reason: "binding_busy" };
  try {
    if (projectBacked) {
      let record;
      try { record = JSON.parse(fs.readFileSync(projectFile, "utf-8")); }
      catch (err) {
        return { ok: false, reason: "mapping_unreadable", error: String(err.message).slice(0, 200) };
      }
      // 锁内重读的是原始记录，投影仍只有那一份。
      const bindingId = effectiveBindingId(record, { root });
      const loaded = interactionPolicyStateForLegacy(record, { bindingId, now });
      if (!loaded.ok) return loaded;
      const changed = mutate(loaded.state, record, { source: "project-files", bindingId, root });
      if (!changed?.ok) return changed;
      if (changed.changed !== false) {
        const materialized = materializeInteractionPolicy(record, changed.state);
        if (!materialized.ok) return materialized;
        writeJsonAtomic(projectFile, materialized.record);
        return { ...changed, source: current.source, mapping: materialized.record };
      }
      return { ...changed, source: current.source, mapping: record };
    }

    let registry;
    try { registry = JSON.parse(fs.readFileSync(registryFile, "utf-8")); }
    catch (err) {
      return { ok: false, reason: "registry_unreadable", error: String(err.message).slice(0, 200) };
    }
    if (!Array.isArray(registry.projects)) return { ok: false, reason: "registry_unreadable" };
    const entry = selectBindingEntry(
      registry.projects.filter((project) => project.root === root && project.root_message_id),
      claudeSessionId,
    ).entry;
    if (!entry) return { ok: false, reason: "entry_gone" };
    const bindingId = (entry.id ?? path.basename(root)) + "@registry";
    const loaded = interactionPolicyStateForLegacy(entry, { bindingId, now });
    if (!loaded.ok) return loaded;
    const changed = mutate(loaded.state, entry, { source: "registry", bindingId, root });
    if (!changed?.ok) return changed;
    if (changed.changed !== false) {
      const materialized = materializeInteractionPolicy(entry, changed.state);
      if (!materialized.ok) return materialized;
      Object.assign(entry, materialized.record);
      if (fs.existsSync(registryFile)) fs.copyFileSync(registryFile, registryFile + ".prev");
      writeJsonAtomic(registryFile, registry);
    }
    return { ...changed, source: current.source, entry };
  } catch (err) {
    return { ok: false, reason: "binding_unwritable", error: String(err.message).slice(0, 200) };
  } finally {
    releasePublishLock(lockDir);
  }
}

export function setClaudeInteractionMode({
  root, claudeSessionId, mode, budget, registryFile, now = Date.now(), precondition = null,
} = {}) {
  return mutateClaudeInteractionPolicy({
    root, claudeSessionId, registryFile, now,
    // precondition 在**写锁内**复核，参数是锁内刚读出的那份记录（项目文件 mapping 或登记表条目）——
    // 维护入口据此重新推导身份再核对 claim，锁外算好的身份不作数，检查与写入之间不留漂移窗口。
    mutate: (state, record, meta) => {
      if (typeof precondition === "function" && precondition(record, meta) !== true) return { ok: false, reason: "precondition_failed" };
      return setInteractionPolicyMode(state, { mode, budget, now });
    },
  });
}

export function reserveClaudeDialogueTurn({
  root, claudeSessionId, eventId, runId, localTargetId, originChannelGenerationId,
  runtimeTargetId, resourceUnits = 1, registryFile, now = Date.now(),
} = {}) {
  return mutateClaudeInteractionPolicy({
    root, claudeSessionId, registryFile, now,
    mutate: (state) => reserveDialogueTurn(state, {
      eventId, runId, localTargetId, originChannelGenerationId,
      runtimeTargetId, resourceUnits, now,
    }),
  });
}

export function finalizeClaudeDialogueTurn({
  root, claudeSessionId, runId, runtimeTargetId, status, reason,
  registryFile, now = Date.now(),
} = {}) {
  return mutateClaudeInteractionPolicy({
    root, claudeSessionId, registryFile, now, lockRetries: 20,
    mutate: (state) => finalizeDialogueTurn(state, {
      runId, runtimeTargetId, status, reason, now,
    }),
  });
}
