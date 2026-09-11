/**
 * PK2-I1：authoritative 侧 interaction policy 的 v2 store（`ledger/<endpoint_id>/policy.json`）—— 领域薄壳。
 *
 * 设计 m1a-reconciliation.md §4 ③：authoritative → 只读写 v2 policy store，legacy policy 字段（registry /
 * active-mapping）冻结。存储原语、symlink 锁、fenced 原子写、封闭校验**全部**在 policy-store/store.mjs
 * （#R31–#R41）：条目值经 ipsp-1（policy-store/validator.mjs），subject 派生经 policySubjectId（与 renderer
 * 同一函数），落盘字节经 canonicalPolicyContent —— 本模块**不写第二套 schema/锁/序列化**，只钉两件领域事实：
 *   · 主体域整域 kind:"lineage"（subject = policySubjectId({kind:"lineage", endpointId, id: binding_id})，
 *     binding_id 的取法与 legacy 一致：<entry.id>@registry / mapping 的 binding_id）—— 以 store 的
 *     kinds.default 声明，逐条目的派生自洽核验（binding_id → 挂载键）仍全量执行；
 *   · 缺条目 → renderer 同款默认条目（mappingDefaultEntry，sidecar-renderers.mjs 同一出处）。
 *
 * 读纪律（fail-closed）：读不出 / 权限不对 / 坏 JSON / 超限一律拒，绝不折成空；缺席（absent）如实带出
 * —— cutover 后 policy.json 不应缺席，接线层按 unreadable 同等处置。
 */

import { loadPolicyStore, mutatePolicyStore, policySubjectId } from "../policy-store/store.mjs";
import { mappingDefaultEntry } from "./sidecar-renderers.mjs";

/** 整域 lineage 主体声明（逐条目派生自洽在 store 层核，#R41 P1-2 同一道）。 */
const KINDS_LINEAGE = Object.freeze({ default: "lineage" });

/**
 * 受验读整个 policy store。返回：
 *   · { ok:true, entries, raw }                       —— 在场且全量校验过；
 *   · { ok:true, absent:true, entries:{} }            —— 缺席（cutover 后不应缺席，调用方按 unreadable 处置）；
 *   · { ok:false, reason:"policy_store_*", why? }     —— 读不出/权限/坏 JSON/超限/不合法（fail-closed）。
 */
export function readPolicyStore({ endpointId, env = process.env } = {}) {
  return loadPolicyStore({ endpointId, kinds: KINDS_LINEAGE, env });
}

/**
 * 锁内取条目 → mutate → 校验 → 原子写。缺条目以 renderer 同款默认条目为底；
 * mutate 与 mutateClaudeInteractionPolicy 同一返回联合（mutate(state, meta) → {ok, changed, state, ...}）。
 * meta 带上 subject/endpointId/bindingId/source，调用方的 precondition 在**写锁内**照旧执行。
 * 锁被占 → { ok:false, reason:"policy_store_busy" }；写前校验不过不落盘；残骸按 R57d 折叠外显。
 */
export function mutatePolicyEntry({ endpointId, bindingId, mutate, env = process.env } = {}) {
  if (typeof bindingId !== "string" || bindingId.length === 0) {
    return { ok: false, reason: "binding_id_missing", why: "bindingId 必须是非空串（subject 由它派生）" };
  }
  let subject;
  try {
    subject = policySubjectId({ kind: "lineage", endpointId, id: bindingId });
  } catch (err) {
    return { ok: false, reason: "policy_store_bad_subject", why: String(err?.message ?? err) };
  }
  const r = mutatePolicyStore({
    endpointId, kinds: KINDS_LINEAGE, env,
    mutate: (entries) => {
      const wasPresent = Object.prototype.hasOwnProperty.call(entries, subject);
      const current = wasPresent ? entries[subject] : mappingDefaultEntry(bindingId);
      const changed = mutate(current, { source: "policy-store", bindingId, endpointId, subject });
      if (!changed || typeof changed !== "object" || changed.ok !== true) return changed;
      // 缺条目上的 no-op 不落实体（与 legacy「changed:false 不写回」同语义：absent 文件只许空投影）。
      const nextEntries = changed.changed === false && !wasPresent
        ? entries
        : { ...entries, [subject]: changed.state };
      return { ok: true, entries: nextEntries, changed: changed.changed !== false };
    },
  });
  if (!r.ok) {
    // 锁被占与 legacy 写路径同一外显（调用方的 busy 语义不变）；其余 policy_store_* 原样透传。
    const reason = r.reason === "policy_store_busy" ? "binding_busy" : r.reason;
    return { ok: false, reason, why: r.why ?? r.detail ?? null, subject, ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
  }
  return {
    ok: true,
    changed: r.changed,
    committed: r.committed === true,
    persistence: r.persistence ?? null,
    state: r.entries[subject],
    subject,
  };
}
