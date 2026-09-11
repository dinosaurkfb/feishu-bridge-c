/** Claude adapter 的 Interaction Policy 读写外状态。PK2-I1：authoritative 判源分派 ——
 *  authoritative 只读写 v2 policy store（m1b/policy-store.mjs，legacy 冻结）；shadow/legacy 原逻辑；
 *  判源 reject → ledger_route_unavailable（与 R66 投递目标同口径，不回退）。 */

import fs from "node:fs";
import path from "node:path";

import {
  finalizeDialogueTurn, interactionPolicyStateForLegacy, materializeInteractionPolicy,
  reserveDialogueTurn, setInteractionPolicyMode,
} from "./interaction-policy.mjs";
import { projectMappingPath, resolveProject, selectBindingEntry } from "./project-resolve.mjs";
import { effectiveBindingId } from "./topic-generation.mjs";
import { acquirePublishLock, registryPath, releasePublishLock } from "./registry.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import { endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import { maintenanceDir } from "./maintenance/journal.mjs";
import { classifyLedgerAuthority } from "./m1a/delivery-target.mjs";
import { loadByEndpoint } from "./topic-agent-ledger.mjs";
import { mutatePolicyEntry, readPolicyStore } from "./m1b/policy-store.mjs";
import { policySubjectId } from "./policy-store/store.mjs";
import { mappingDefaultEntry } from "./m1b/sidecar-renderers.mjs";

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

/**
 * PK2-I1：authoritative 判源（R66 同口径四态矩阵）—— endpointId 与 receipt 的取法与 inbound R66 接线同源
 * （legacyEndpointId（链模板 agent_uid）+ endpointReceipt（maintenanceDir）+ loadByEndpoint 交叉核账本模式）。
 * 链模板读不出 → 无法命名 endpoint → 按 legacy（未接入判定不可用时的今天行为；真机装坏由 doctor ①/② 点名）。
 */
function claudePolicyAuthorityClass({ env = process.env } = {}) {
  const tpl = loadChainTemplate();
  if (!tpl.ok || typeof tpl.template?.agent_uid !== "string") return { mode: "legacy", endpointId: null };
  const endpointId = legacyEndpointId({ runtime: "claude", agentUid: tpl.template.agent_uid });
  const dir = maintenanceDir(env);
  const receipt = (typeof dir === "string" && dir.length > 0) ? endpointReceipt(dir, endpointId) : { ok: false };
  const pre = classifyLedgerAuthority({ receipt, ledgerMode: null });
  // 与 decideInboundDeliveryTarget 同构：pre 只分 legacy/拒收（收据本身坏）；cutoverDone + null 模式的
  // pre.reject 不是终态 —— 读账本拿到真实 authority_mode 后再判一次。
  if (pre.mode === "legacy") return { mode: "legacy", endpointId };
  if (receipt?.ok !== true) return { mode: "reject", why: pre.why, endpointId };
  const L = loadByEndpoint(endpointId, { env });
  const cls = classifyLedgerAuthority({ receipt, ledgerMode: L.ok ? L.doc.authority_mode : null });
  if (cls.mode === "reject") return { mode: "reject", why: cls.why, endpointId };
  return { mode: cls.mode, endpointId };
}

export function loadClaudeInteractionPolicy({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  now = Date.now(),
  _cls = null,
} = {}) {
  const cls = _cls ?? claudePolicyAuthorityClass();
  if (cls.mode === "reject") return { ok: false, reason: "ledger_route_unavailable", why: cls.why };
  const resolved = resolveProject({ root, claudeSessionId, registryFile });
  if (!resolved.ok) return resolved;
  const bindingId = effectiveBindingId(resolved.mapping, { root });
  if (cls.mode === "authoritative") {
    // PK2-I1：只读 v2 policy store（legacy policy 字段冻结）；缺条目 → renderer 同款默认；
    // 读不出/缺席 → 拒（fail-closed，与 R66 投递目标同款，不回退 legacy）。
    const store = readPolicyStore({ endpointId: cls.endpointId });
    if (!store.ok || store.absent) {
      return { ok: false, reason: "ledger_route_unavailable",
        why: store.absent ? "policy store 缺席（cutover 后不应缺席）" : (store.reason + (store.why ? "：" + store.why : "")) };
    }
    const subject = policySubjectId({ kind: "lineage", endpointId: cls.endpointId, id: bindingId });
    const state = Object.prototype.hasOwnProperty.call(store.entries, subject)
      ? store.entries[subject]
      : mappingDefaultEntry(bindingId);
    return {
      ok: true,
      root,
      source: "policy-store",
      bindingLevel: resolved.bindingLevel,
      claudeSessionId: resolved.claudeSessionId,
      mapping: resolved.mapping,
      config: resolved.config,
      state,
      migrated: false,
      subject,
      endpointId: cls.endpointId,
    };
  }
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
  // PK2-I1：入口判源（R66 同口径四态矩阵，一次判定共用给读与写）。
  const cls = claudePolicyAuthorityClass();
  if (cls.mode === "reject") return { ok: false, reason: "ledger_route_unavailable", why: cls.why };
  const current = loadClaudeInteractionPolicy({ root, claudeSessionId, registryFile, now, _cls: cls });
  if (!current.ok) return current;
  if (cls.mode === "authoritative") {
    // PK2-I1：只读写 v2 policy store，legacy（registry/mapping）冻结 —— 不再碰它们的写锁，更不写回。
    // bindingId 取 legacy 同源（effectiveBindingId 投影 / <id>@registry）；subject 由 m1b 壳内同一函数派生。
    const bindingId = current.state?.binding_id;
    if (typeof bindingId !== "string" || bindingId.length === 0) return { ok: false, reason: "binding_id_missing" };
    const r = mutatePolicyEntry({
      endpointId: cls.endpointId, bindingId, env: process.env,
      mutate: (entry, meta) => mutate(entry, entry, { source: "policy-store", bindingId, root, claudeSessionId,
        subject: meta.subject, endpointId: cls.endpointId }),
    });
    if (!r.ok) {
      return { ok: false, reason: r.reason, why: r.why ?? null, subject: r.subject ?? null, endpointId: cls.endpointId };
    }
    return { ok: true, changed: r.changed, source: "policy-store", state: r.state, subject: r.subject,
      endpointId: cls.endpointId, committed: r.committed };
  }
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
