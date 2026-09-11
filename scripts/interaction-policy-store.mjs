/** Claude adapter 的 Interaction Policy Git 外状态读写。
 *
 * PK2-I1（M1a §4 ③）：**authoritative 之后只读写 v2 policy store**（`ledger/<ep>/policy.json`，
 * 由 `m1b/policy-store.mjs` 管），legacy registry / active-mapping 的策略字段从此只读（冻结）。
 * shadow / never_initialized 行为与从前一字不差（Codex 链端点仍走 legacy）；判源不明（收据坏 /
 * 模式交叉）→ `ledger_route_unavailable`（与 R66 投递目标同口径，绝不回退 legacy 猜）。
 */

import fs from "node:fs";
import path from "node:path";

import {
  finalizeDialogueTurn, interactionPolicyStateForLegacy, materializeInteractionPolicy,
  reserveDialogueTurn, setInteractionPolicyMode,
} from "./interaction-policy.mjs";
import { projectMappingPath, resolveProject, selectBindingEntry } from "./project-resolve.mjs";
import { activeGeneration, effectiveBindingId, pendingGeneration } from "./topic-generation.mjs";
import { acquirePublishLock, releasePublishLock, registryPath } from "./registry.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import { maintenanceDir } from "./maintenance/journal.mjs";
import { endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import { decideLedgerRoute } from "./m1a/delivery-target.mjs";
import { mutatePolicyEntry, policyEntryFor, readPolicyStore, resolvePolicySubject } from "./m1b/policy-store.mjs";

/**
 * 本机 Claude 链的 ledger endpoint：与入站 / 投递目标**同一派生**（链模板的 agent_uid）。
 * **读不出模板 = 派不出 endpoint = 拒**（`mode:"reject"`，P1-3 裁定 3）：
 * 「未接入 M1a」的正判据是**收据**（`never_initialized`），不是"我读不到模板"。把后者当 legacy
 * 会让一个坏模板静默把写面引回**冻结的 legacy**（真相已经切到 v2 store 了）。
 */
export function claudePolicyRoute({ env = process.env } = {}) {
  const tpl = loadChainTemplate();
  const uid = tpl?.ok === true ? tpl.template?.agent_uid : null;
  if (typeof uid !== "string" || uid.length === 0) {
    return { mode: "reject", reason: "policy_endpoint_unresolved", why: "读不出链模板的 agent_uid（派不出 ledger endpoint）：" + String(tpl?.reason ?? "template_unusable"), endpointId: null };
  }
  const endpointId = legacyEndpointId({ runtime: "claude", agentUid: uid });
  const dir = maintenanceDir(env);
  const receipt = typeof dir === "string" && dir.length > 0 ? endpointReceipt(dir, endpointId) : { ok: false, state: "unreadable" };
  return { ...decideLedgerRoute({ receipt, endpointId, env }), endpointId };
}

/** 这个 binding 当前代际的根话题 om（legacy 索引行只用来**定位话题**；subject 由账本记录解析）。 */
const currentRootOm = (mapping) => {
  const state = mapping?.topic_generation_state ?? null;
  const gen = activeGeneration(state) ?? pendingGeneration(state);
  if (typeof gen?.root_message_id === "string" && gen.root_message_id.length > 0) return gen.root_message_id;
  if (typeof mapping?.root_message_id === "string" && mapping.root_message_id.length > 0) return mapping.root_message_id;
  return typeof mapping?.feishu_root_message_id_reference === "string" && mapping.feishu_root_message_id_reference.length > 0
    ? mapping.feishu_root_message_id_reference : null;
};

/**
 * authoritative 写面的**锁内身份**（P1-4）：给定 legacy 索引行（root/claudeSessionId）→
 * 重读索引行拿当前代际的 root_om → 在账本里按 root_om 定位 live 记录 → 解析 subject。
 * 只在 policy 锁内调用（身份与写之间不留漂移窗口）。
 */
const authoritativeIdentity = ({ root, claudeSessionId, registryFile, endpointId, env }) => () => {
  const resolved = resolveProject({ root, claudeSessionId, registryFile });
  if (!resolved.ok) return resolved;
  const rootOm = currentRootOm(resolved.mapping);
  const subj = resolvePolicySubject({ endpointId, rootOm, env });
  if (!subj.ok) return subj;
  return { ok: true, subjectId: subj.subjectId, kind: subj.kind, id: subj.id, bindingId: subj.id, rootOm, mapping: resolved.mapping, record: subj.record ?? null, bindingLevel: resolved.bindingLevel };
};

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
/** 取锁重试（与 registry 同一锁原语；维护门在 acquirePublishLock 里兜底）。legacy 读写路径用。 */
const acquireStateLock = (lockDir, retries = 0) => {
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = acquirePublishLock(lockDir);
    if (result.ok || result.reason !== "publisher_busy") return result;
    if (attempt < retries) Atomics.wait(LOCK_WAIT, 0, 0, 25);
  }
  return result;
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
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

/**
 * 读面（判源分派，PK2-I1）：authoritative → 只读 v2 policy store 的该 subject 条目（缺 → renderer
 * 同款默认条目）；store 读不出/不合法/缺席 → `ledger_route_unavailable`（fail-closed，**绝不回退
 * legacy**）；shadow / never_initialized → 原逻辑一字不改。
 * **reject（收据不明 / 模式交叉）走 legacy 读**：这一态的处置是 R66 投递层的职责（它在 claim 之后
 * 落 `.failed.json` + `ledger-route-*` 回执）—— 策略读若提前拒收，会把那一条回执挤掉（R69 T7 拒腿
 * 就是这么钉的）。策略面在"账本说不清"时只是不该**写**（写死在 reject，见 mutate）。
 * 返回形状是 `loadClaudeInteractionPolicy` 的超集（多 source/bindingId/subjectId/endpointId/synthesized）。
 */
export function loadClaudeInteractionPolicyRouted({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  env = process.env,
  now = Date.now(),
  rejectBehavior = "fail_closed",
} = {}) {
  const route = claudePolicyRoute({ env });
  if (route.mode === "reject") {
    // 裁定 3：**只有入站那个读点延后拒**（`rejectBehavior:"defer"`）—— 判源不明时读面照旧给一份现场，
    // 让流程走到 claim 之后由 R66 投递层统一拒收（.failed.json + ledger-route 回执）。其余读方
    // （status / mode / stop-hook）与写面一律 fail-closed，不回退冻结 legacy。
    if (rejectBehavior === "defer") return loadClaudeInteractionPolicy({ root, claudeSessionId, registryFile, now });
    return { ok: false, reason: "ledger_route_unavailable", why: route.why, endpointId: route.endpointId ?? null };
  }
  if (route.mode !== "authoritative") return loadClaudeInteractionPolicy({ root, claudeSessionId, registryFile, now });
  const resolved = resolveProject({ root, claudeSessionId, registryFile });
  if (!resolved.ok) return resolved;
  // P1-4：subject 由**受验账本记录**解析（legacy 索引行只提供当前代际的 root_om，用来定位 live 记录）。
  const rootOm = currentRootOm(resolved.mapping);
  const subj = resolvePolicySubject({ endpointId: route.endpointId, rootOm, env });
  if (!subj.ok) return { ok: false, reason: "ledger_route_unavailable", why: subj.reason + "：" + String(subj.why ?? ""), endpointId: route.endpointId, rootOm };
  const store = readPolicyStore({ endpointId: route.endpointId, kinds: subj.kinds, env });
  if (!store.ok) return { ok: false, reason: "ledger_route_unavailable", why: "policy store：" + String(store.why ?? "读不出"), endpointId: route.endpointId, subjectId: subj.subjectId };
  if (store.absent) return { ok: false, reason: "ledger_route_unavailable", why: "policy store 缺席（cutover 之后不应缺席）", endpointId: route.endpointId, subjectId: subj.subjectId };
  const picked = policyEntryFor({ entries: store.entries, subjectId: subj.subjectId, kind: subj.kind, id: subj.id, endpointId: route.endpointId });
  if (!picked.ok) return { ok: false, reason: "ledger_route_unavailable", why: picked.why ?? "policy store 里没有该 subject 且合成不出默认条目", endpointId: route.endpointId, subjectId: subj.subjectId };
  return {
    ok: true,
    root,
    source: "policy-store",
    bindingLevel: resolved.bindingLevel,
    claudeSessionId: resolved.claudeSessionId,
    mapping: resolved.mapping,
    config: resolved.config,
    state: picked.entry,
    migrated: false,
    synthesized: picked.synthesized,
    bindingId: subj.id,
    subjectId: subj.subjectId,
    kind: subj.kind,
    rootOm,
    endpointId: route.endpointId,
  };
}

function mutateClaudeInteractionPolicy({
  root,
  claudeSessionId,
  registryFile = registryPath(),
  now = Date.now(),
  lockRetries = 0,
  mutate,
  env = process.env,
} = {}) {
  // 判源（PK2-I1）：authoritative → 只写 policy store（legacy 一字不碰）；判源不明 → 同 R66 拒（**写面永不延后**）。
  const route = claudePolicyRoute({ env });
  if (route.mode === "reject") return { ok: false, reason: "ledger_route_unavailable", why: route.why };
  if (route.mode === "authoritative") {
    // P1-4：身份（subject）在 **policy 锁内**重读 —— legacy 索引行与账本都在锁内重读一遍，
    //   锁外那份不作数（检查与写入之间不留漂移窗口）。传进 mutate 的 record 也就是**锁内那份 mapping**，
    //   precondition（claudeControlPrecondition 重推 claim 身份）拿的是同一个现场。
    return mutatePolicyEntry({
      endpointId: route.endpointId, env, lockRetries,
      identity: authoritativeIdentity({ root, claudeSessionId, registryFile, endpointId: route.endpointId, env }),
      mutate: (state, meta) => mutate(state, meta.mapping, {
        ...meta, source: "policy-store", root, endpointId: route.endpointId, route: "authoritative",
      }),
    });
  }
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
  root, claudeSessionId, mode, budget, registryFile, now = Date.now(), precondition = null, env = process.env,
} = {}) {
  return mutateClaudeInteractionPolicy({
    root, claudeSessionId, registryFile, now, env,
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
  runtimeTargetId, resourceUnits = 1, registryFile, now = Date.now(), env = process.env,
} = {}) {
  return mutateClaudeInteractionPolicy({
    root, claudeSessionId, registryFile, now, env,
    mutate: (state) => reserveDialogueTurn(state, {
      eventId, runId, localTargetId, originChannelGenerationId,
      runtimeTargetId, resourceUnits, now,
    }),
  });
}

export function finalizeClaudeDialogueTurn({
  root, claudeSessionId, runId, runtimeTargetId, status, reason,
  registryFile, now = Date.now(), env = process.env,
} = {}) {
  return mutateClaudeInteractionPolicy({
    root, claudeSessionId, registryFile, now, lockRetries: 20, env,
    mutate: (state) => finalizeDialogueTurn(state, {
      runId, runtimeTargetId, status, reason, now,
    }),
  });
}
