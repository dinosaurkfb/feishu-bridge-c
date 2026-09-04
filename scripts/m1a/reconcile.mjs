/**
 * M1a 只读对账 · 判别 / 投影 / reconciler（规格 docs/architecture/m1a-reconciliation.md v6 §2/§3/§6）。
 *
 * 判别（§2）有优先级、互斥、封闭；投影（§3）产出期望账本记录；reconciler（§6）对整份
 * shadow 账本先过 G1–G15（loadLedger 内含 validateLedger），再仅对 live B 族子集双射。
 * 本模块**严格只读**：不写账本、不写 legacy、不写任何 sidecar。
 *
 * 结果联合（§6 封闭）：
 *   { ok:true, digest, cutover_blockers, snapshot_identity }
 *   { ok:null, reason:"snapshot_moved", why }
 *   { ok:false, reason, why, mismatches:[{code, topic_agent_id|null, field|null, detail}], cutover_blockers }
 * cutover_blockers = §2 待修项完整输出（任一存在 → cutover 拒；doctor 只报不拒）。
 */

import { canonKey, sha256 } from "../topic-agent-ledger.mjs";
import { validateTopicGenerationState } from "../topic-generation.mjs";
import { M1A_SHAPES } from "./legacy-snapshot.mjs";

const { OM_SHAPE, CHAT_SHAPE, LINEAGE_SHAPE } = M1A_SHAPES;

const AILY_SESSION_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u; // aliases.session_id（账本同源形状）

/** B 族判据（§1 范围 D1）：A 族 generation 全为 n/a，不参与双射。 */
export const isBFamily = (facts) => facts?.generation !== undefined && facts.generation !== "n/a";

/** §3 封闭公式：legacy 期望记录的 topic_agent_id。 */
export function topicAgentIdForLegacy(endpointId, bindingId, channelGenerationId) {
  return "ta_" + sha256(canonKey({
    domain: "topic_agent_legacy_v1", endpoint_id: endpointId,
    binding_id: bindingId, channel_generation_id: channelGenerationId,
  })).slice(0, 32);
}

/** 有效绑定状态（v6 §2 封闭公式）：retired 优先，不被 disabled 覆盖。 */
export const effectiveBindingStatus = (binding) => {
  const status = binding.state?.binding_status;
  if (status === "retired") return "retired";
  return binding.enabled === false ? "paused" : status;
};

/** §2 逐代际判别（命中即止）。返回 { family } | { exclude:true } | { blocker:code }。 */
export function discriminateGeneration(generation, { eff, rotation }) {
  if (generation.status === "retired") return { exclude: true };
  if (generation.status === "pending") {
    if (eff === "active" && rotation === null && generation.session_id === null) return { family: "B1" };
    if (eff === "active" && rotation?.status === "awaiting_claim"
      && rotation.pending_generation_id === generation.channel_generation_id) return { family: "B1" };
    return { blocker: "pending_unresolvable" };
  }
  if (generation.status === "active") {
    if (typeof generation.session_id !== "string" || !AILY_SESSION_SHAPE.test(generation.session_id)) {
      return { blocker: "session_missing" };
    }
    if (eff === "active") return { family: "B3" };
    if (eff === "paused") return { family: "B3prime" };
    return { blocker: "binding_retired_active_gen" }; // 0b 已挡 retired；此处是纵深
  }
  if (generation.status === "read-only") {
    if (typeof generation.session_id !== "string" || !AILY_SESSION_SHAPE.test(generation.session_id)) {
      return { blocker: "session_missing" };
    }
    if (eff === "active") return { family: "B4" };
    if (eff === "paused") return { blocker: "paused_readonly" }; // 不静默映 B4
    return { blocker: "binding_retired_readonly" };
  }
  return { blocker: "legacy_state_unmapped" }; // 未命中唯一分支（generation status 越界）
}

const B1_FACTS = Object.freeze({ binding: "pending", session: "absent", anchor: "present", locator_link_proof: "absent", generation: "pending" });
const B3_FACTS = Object.freeze({ binding: "active", session: "present", anchor: "present", locator_link_proof: "present", generation: "current" });
const B4_FACTS = Object.freeze({ binding: "active", session: "present", anchor: "present", locator_link_proof: "present", generation: "historical" });
const DORMANT_FACTS = Object.freeze({ binding: "dormant", session: "present", anchor: "present", locator_link_proof: "present", generation: "current" });
const familyFacts = (f) => (f === "B1" ? B1_FACTS : f === "B3" ? B3_FACTS : f === "B3prime" ? DORMANT_FACTS : B4_FACTS);
const familyOf = (facts) => (facts.generation === "pending" ? "B1"
  : facts.generation === "current" ? (facts.binding === "dormant" ? "B3prime" : "B3") : "B4");

/**
 * §2+§3：整份 legacy 快照 → 期望记录集（E）+ cutover_blockers。
 * 全局拒（任一 binding rotation preparing）在 这里以 globalReject 返回。
 */
export function projectLegacySnapshot({ endpointId, chain, snapshot }) {
  const records = new Map();
  const blockers = [];
  for (const binding of snapshot.bindings) {
    const state = binding.state;
    // 0. 整体校验不过 → 拒整份（适配器已挡，纵深保留）。
    const v = validateTopicGenerationState(state);
    if (!v.ok) return { ok: false, reason: "legacy_unreadable", source: "topic-generation-state", why: v.problems.join("、") };
    // 1. rotation preparing → 全局拒（cutover_blocked:rotation_preparing）。
    if (state.rotation?.status === "preparing") {
      return { ok: false, reason: "legacy_unreconcilable", global: "rotation_preparing",
        why: "cutover_blocked:rotation_preparing", blockers, records };
    }
    const eff = effectiveBindingStatus(binding);
    const gens = state.generations ?? [];
    // 0b. binding 级前置：retired binding（或全部代际 retired）→ 一条 binding 级 blocker，不逐条无声排除。
    if (eff === "retired" || (gens.length > 0 && gens.every((g) => g.status === "retired"))) {
      blockers.push({ code: "binding_retired", binding_id: binding.binding_id, channel_generation_id: null, detail: "binding 已退役（effective_binding_status=retired），M1a 不映射" });
      continue;
    }
    for (const generation of gens) {
      const d = discriminateGeneration(generation, { eff, rotation: state.rotation });
      if (d.exclude) continue;
      if (d.blocker) {
        blockers.push({ code: d.blocker, binding_id: binding.binding_id, channel_generation_id: generation.channel_generation_id, detail: "代际 " + generation.status + " 未满足投影条件" });
        continue;
      }
      // 严格 target 采集（§1）：缺任一 → 该代际待修 target_incomplete，绝不临时选值。
      if (!binding.binding_target.complete) {
        blockers.push({ code: "target_incomplete", binding_id: binding.binding_id, channel_generation_id: generation.channel_generation_id, detail: "binding_target 受验字段不全（" + binding.binding_target.runtime + "）" });
        continue;
      }
      // chat_id（适配器产出，已过受验形状——双保险）与 root_om（OM_SHAPE 必过）。
      if (typeof binding.chat_id !== "string" || !CHAT_SHAPE.test(binding.chat_id)) {
        blockers.push({ code: "target_incomplete", binding_id: binding.binding_id, channel_generation_id: generation.channel_generation_id, detail: "chat_id 受验形状不过" });
        continue;
      }
      if (typeof generation.root_message_id !== "string" || !OM_SHAPE.test(generation.root_message_id)) {
        blockers.push({ code: "root_om_missing", binding_id: binding.binding_id, channel_generation_id: generation.channel_generation_id, detail: "generation.root_message_id 缺席或形状不过" });
        continue;
      }
      if (!LINEAGE_SHAPE.test(binding.binding_id)) {
        blockers.push({ code: "target_incomplete", binding_id: binding.binding_id, channel_generation_id: generation.channel_generation_id, detail: "binding_id 形状越界（lineage 受验形状）" });
        continue;
      }
      const facts = familyFacts(d.family);
      const rec = {
        topic_agent_id: topicAgentIdForLegacy(endpointId, binding.binding_id, generation.channel_generation_id),
        chat_id: binding.chat_id,
        aliases: {
          session_id: d.family === "B1" ? null : generation.session_id,
          root_om: generation.root_message_id,
        },
        facts: { ...facts },
        generation_lineage_id: binding.binding_id,
        binding_target: Object.fromEntries(Object.entries(binding.binding_target).filter(([k]) => k !== "complete")),
      };
      // 同 id 由不同输入元组产生（碰撞）→ legacy_conflict（§3）。
      if (records.has(rec.topic_agent_id)) {
        return { ok: false, reason: "legacy_conflict", why: "topic_agent_id 碰撞：" + rec.topic_agent_id, blockers, records };
      }
      records.set(rec.topic_agent_id, rec);
    }
  }
  return { ok: true, chain, records, blockers };
}

/** §6：shadow 账本 → live B 族子集的 C 投影（S 侧）。 */
export function projectShadowBFamily(shadowDoc) {
  const records = new Map();
  for (const rec of Object.values(shadowDoc.records ?? {})) {
    if (rec?.kind !== "live" || !isBFamily(rec.facts)) continue;
    records.set(rec.topic_agent_id, {
      topic_agent_id: rec.topic_agent_id,
      chat_id: rec.chat_id,
      aliases: { ...rec.aliases },
      facts: { ...rec.facts },
      generation_lineage_id: rec.generation_lineage_id,
      binding_target: rec.binding_target === null ? null : { ...rec.binding_target },
    });
  }
  return records;
}

const C_FIELDS = Object.freeze(["aliases", "binding_target", "chat_id", "facts", "generation_lineage_id", "topic_agent_id"]);

/** 逐字段不等清单（比较域 = C 的六个字段；canonKey 比较保证键序无关）。 */
function fieldMismatches(id, e, s) {
  const out = [];
  for (const field of C_FIELDS) {
    if (canonKey(e[field]) !== canonKey(s[field])) {
      out.push({ code: "field_mismatch", topic_agent_id: id, field, detail: familyOf(e.facts) + "≠账本侧 " + familyOf(s.facts) });
    }
  }
  return out;
}

/**
 * §6 reconciler：legacy 快照 ↔ shadow 账本双射（单 endpoint）。
 * collectLegacy / loadLedgerFn 各被调用两次（投影前后复核 snapshot_identity + 账本 revision）。
 */
export function reconcileLegacyEndpoint({ endpointId, chain, collectLegacy, loadLedgerFn }) {
  const L1 = loadLedgerFn();
  if (!L1.ok) return { ok: false, reason: "ledger_" + L1.reason, why: L1.why ?? null, mismatches: [], cutover_blockers: [] };
  // shadow 前提（评审 P1-5）：对账只在影子期有意义；authoritative 账本合法演进、legacy 冻结，
  // 拿 M1a 双射去套只会永久误红。后续 cutover 调用方误用也在这里 fail-closed。
  if (L1.doc.authority_mode !== "shadow") {
    return { ok: false, reason: "not_shadow", why: null, mismatches: [], cutover_blockers: [] };
  }
  if (L1.doc.chain !== chain) return { ok: false, reason: "chain_mismatch", why: "账本 chain 与对账链不符", mismatches: [], cutover_blockers: [] };
  const S1 = collectLegacy();
  if (!S1.ok) return { ok: false, reason: S1.reason, source: S1.source, why: S1.why, mismatches: [], cutover_blockers: [] };

  const proj = projectLegacySnapshot({ endpointId, chain, snapshot: S1 });
  if (!proj.ok) {
    return { ok: false, reason: proj.reason, source: proj.source, why: proj.why,
      mismatches: [], cutover_blockers: proj.blockers, global: proj.global ?? null };
  }
  const S = projectShadowBFamily(L1.doc);
  const E = proj.records;

  // 双射：配对键 = topic_agent_id；mismatch 全清单（E 多 / S 多 / 逐字段不等）。
  const mismatches = [];
  for (const [id, e] of E) {
    const s = S.get(id);
    if (s === undefined) mismatches.push({ code: "extra_in_legacy", topic_agent_id: id, field: null, detail: familyOf(e.facts) + " 在 legacy 有投影、shadow 缺记录" });
    else mismatches.push(...fieldMismatches(id, e, s));
  }
  for (const [id, s] of S) {
    if (!E.has(id)) mismatches.push({ code: "extra_in_shadow", topic_agent_id: id, field: null, detail: familyOf(s.facts) + " 在 shadow 有记录、legacy 无投影" });
  }
  mismatches.sort((a, b) => (a.code + a.topic_agent_id + (a.field ?? "")).localeCompare(b.code + b.topic_agent_id + (b.field ?? "")));

  const C = (records) => ({ projection_version: "m1a-2", endpoint_id: endpointId, chain, records: [...records.values()].sort((a, b) => a.topic_agent_id.localeCompare(b.topic_agent_id)) });
  const digestE = sha256(canonKey(C(E)));
  const digestS = sha256(canonKey(C(S)));

  // 快照一致性（§6）：投影前后各取一次 snapshot_identity + 账本 revision；不一致 → inconclusive。
  const S2 = collectLegacy();
  const L2 = loadLedgerFn();
  const idKey = (x) => JSON.stringify(x);
  if (S2.ok && idKey(S2.snapshot_identity) !== idKey(S1.snapshot_identity)) {
    return { ok: null, reason: "snapshot_moved", why: "legacy 快照在投影期间变化" };
  }
  if (L2.ok && (L2.doc.revision !== L1.doc.revision || L2.sha256 !== L1.sha256)) {
    return { ok: null, reason: "snapshot_moved", why: "账本 revision 在投影期间变化（" + L1.doc.revision + "→" + L2.doc.revision + "）" };
  }
  if (!S2.ok) return { ok: null, reason: "snapshot_moved", why: "投影后 legacy 快照读不出（" + S2.reason + "）" };
  if (!L2.ok) return { ok: null, reason: "snapshot_moved", why: "投影后账本读不出（" + L2.reason + "）" };

  const ok = digestE === digestS && mismatches.length === 0;
  if (ok) return { ok: true, digest: digestE, cutover_blockers: proj.blockers, snapshot_identity: S1.snapshot_identity };
  return { ok: false, reason: "bijection_mismatch", why: "digestE≠digestS 或双射不成立", mismatches, cutover_blockers: proj.blockers, snapshot_identity: S1.snapshot_identity };
}
