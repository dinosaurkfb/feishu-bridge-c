/**
 * doctor ⑰ owner_select 对账（设计稿 owner-select-route.md §9/§7.2/§4/§8.2/§3.1）——
 * **纯函数 + 只读盘**：不修、不写飞书、不给修复建议；判据只读既有制品（账本、收据、campaign、
 * writer_state、journal 1.4、active），读不出/说不清一律 fail-closed 记「查不清」并点名。
 *
 * 对每个 initDone 的 endpoint（收据聚合复用 aggregateEndpointReceipts）：
 *   1. 账本一致性：loadLedger 受验读取，validateLedger 不过 → block；live 记录按 §7.2 核
 *      locator_link_proof_ref.kind 相容与 binding_proof.kind === "owner_select_v1" 的 §3.1 六字段；
 *      来源 op 带 proof_effects 时按 G13′ 判产证/保留。
 *   2. 存量计数：migrationInventory —— strict（1.1）下任一非 0 → block；transition/1.0 只报
 *      opaque 计数（不点名 id / handle 值）。
 *   3. handle 卫生：三 handle 与合法族一一映射（osh_→B1/A2、orh_→B3、rfh_ 在 sidecar 不入账本）、
 *      到期字段与存废一致、endpoint 内全局唯一；strict 不得有 null-handle B1。
 *      intent store 尚未实现（§4 ③）——本项注明「intent 未纳入」，不猜。
 *   4. 迁移状态链：campaign × writer_state 直读 + readOwnerSelectAdmission 联合互证；
 *      campaign endpoints ⊆ initDone；campaign state 与各 endpoint 账本 schema 相容；
 *      journal 1.4 进行中的迁移只报「迁移进行中（phase）」不判 block（那归 ⑩/维护门）。
 */

import { isCanonicalIso } from "../canonical-time.mjs";
import { loadByEndpoint, validateLedger, familyOf, migrationInventory } from "../topic-agent-ledger.mjs";
import { aggregateEndpointReceipts } from "./ledger-receipt.mjs";
import { readCampaignState, readWriterState, readOwnerSelectAdmission } from "./owner-select-state.mjs";
import { readActive, readJournal } from "./journal.mjs";

const OSH_RE = /^osh_[0-9a-f]{32}$/u;
const ORH_RE = /^orh_[0-9a-f]{32}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OWNER_SELECT_BINDING_KEYS = "authorized_at,authorized_by,kind,selected_root_om,selected_session_id,selection_handle,selection_operation_id";
const OWNER_SELECT_LINK_KEYS = "authorized_at,authorized_by,by_identity,kind,selected_root_om,selected_session_id,selection_handle,selection_operation_id";
// §7.2 G13′ preserved：link 的来源必须是产证 op（activate/anchor/rebind_session_alias/reaffirm）
const PRODUCER_OPS = Object.freeze(["activate", "anchor", "rebind_session_alias", "owner_select_reaffirm"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 单条 live 记录的账本一致性 + handle 卫生检查。返回问题短句数组（空 = 干净）。 */
function checkLiveRecord(doc, rec, schema) {
  const problems = [];
  const fam = familyOf(rec.facts);

  // ── handle 卫生（§4：两枚稳态字段 + 族闭合）── 字段缺席按 null 处理（旧形账本可能不带这些键）
  if ((rec.selection_handle ?? null) !== null) {
    if (typeof rec.selection_handle !== "string" || !OSH_RE.test(rec.selection_handle)) problems.push("selection_handle 不是 osh_+32hex 形状");
    if (!isCanonicalIso(rec.handle_expires_at)) problems.push("有 selection_handle 但 handle_expires_at 缺席/不是规范化 ISO");
    if (fam !== "B1" && fam !== "A2") problems.push("selection_handle 出现在 " + fam + " 族（合法族只有 B1/A2）");
  } else if ((rec.handle_expires_at ?? null) !== null) {
    problems.push("无 selection_handle 但 handle_expires_at 非 null");
  }
  if ((rec.rebind_handle ?? null) !== null) {
    if (typeof rec.rebind_handle !== "string" || !ORH_RE.test(rec.rebind_handle)) problems.push("rebind_handle 不是 orh_+32hex 形状");
    if (!isCanonicalIso(rec.rebind_expires_at)) problems.push("有 rebind_handle 但 rebind_expires_at 缺席/不是规范化 ISO");
    if (fam !== "B3") problems.push("rebind_handle 出现在 " + fam + " 族（合法族只有待 rebind 的 B3）");
  } else if ((rec.rebind_expires_at ?? null) !== null) {
    problems.push("无 rebind_handle 但 rebind_expires_at 非 null");
  }
  if (schema === "1.1" && fam === "B1" && (rec.selection_handle ?? null) === null) {
    problems.push("strict 下存在 selection_handle=null 的 B1（违族闭合）");
  }

  // ── locator_link_proof 相容（§7.2 G13′/§3.2）──
  if (rec.facts?.locator_link_proof === "present") {
    const link = rec.locator_link_proof_ref;
    if (!isObj(link) || typeof link.kind !== "string") {
      problems.push("link proof 标记 present 但 locator_link_proof_ref 缺席/形状不对");
    } else if (rec.binding_proof?.kind === "owner_select_v1" && link.kind !== "owner_selected_route_v1") {
      problems.push("binding=owner_select_v1 但 link kind=" + link.kind + "（应为 owner_selected_route_v1）");
    }
  }

  // ── binding_proof.kind === "owner_select_v1"：§3.1 六字段 + G11′ 等式 + 与 link 的 §3.2 等式 ──
  if (rec.binding_proof?.kind === "owner_select_v1") {
    const bp = rec.binding_proof;
    if (Object.keys(bp).sort().join(",") !== OWNER_SELECT_BINDING_KEYS) {
      problems.push("owner_select_v1 binding_proof 字段集不对（§3.1 七键）");
    } else {
      if (bp.selected_session_id !== rec.aliases.session_id) problems.push("selected_session_id ≠ aliases.session_id（G11′）");
      if (bp.selected_root_om !== rec.aliases.root_om) problems.push("selected_root_om ≠ aliases.root_om（G11′）");
      if (typeof bp.selection_handle !== "string" || !OSH_RE.test(bp.selection_handle)) problems.push("binding_proof.selection_handle 不是 osh_ 形状");
      if (typeof bp.selection_operation_id !== "string" || !UUID_RE.test(bp.selection_operation_id)) problems.push("selection_operation_id 不是合法 op id");
      if (!isCanonicalIso(bp.authorized_at)) problems.push("authorized_at 不是规范化 ISO");
    }
    const link = rec.locator_link_proof_ref;
    if (isObj(link) && link.kind === "owner_selected_route_v1") {
      if (Object.keys(link).sort().join(",") !== OWNER_SELECT_LINK_KEYS) problems.push("owner_selected_route_v1 link 字段集不对（§3.2 八键）");
      else if (link.selected_session_id !== bp.selected_session_id || link.selected_root_om !== bp.selected_root_om ||
        link.selection_handle !== bp.selection_handle || link.selection_operation_id !== bp.selection_operation_id) {
        problems.push("link 与 binding 的六字段不等（§3.2：仅 binding=owner_select_v1 时等式成立）");
      }
    }
    // G13′-produced：本记录的 proof_effects 项判产证 → selection_operation_id 必须 === origin
    const op = doc.operations[rec.origin_operation_id];
    const eff = Array.isArray(op?.result?.proof_effects)
      ? op.result.proof_effects.find((x) => isObj(x) && x.topic_agent_id === rec.topic_agent_id) : null;
    if (eff && eff.link_effect === "produced" && isObj(link) && link.selection_operation_id !== rec.origin_operation_id) {
      problems.push("来源 op 判 link=produced 但 selection_operation_id ≠ origin_operation_id（G13′-A）");
    }
  } else if (rec.facts?.locator_link_proof === "present" && isObj(rec.locator_link_proof_ref) && rec.locator_link_proof_ref.kind === "owner_selected_route_v1") {
    // G13′-B：binding 非 owner_select_v1 时 link 独立经自身来源 op 校验（preserved 语义）——
    // selection_operation_id 必须指向存在的产证 op。
    const src = doc.operations[rec.locator_link_proof_ref.selection_operation_id];
    if (!src || !PRODUCER_OPS.includes(src.op_type)) {
      problems.push("link=owner_selected_route_v1 但 selection_operation_id 不指向产证 op（G13′-B）");
    }
  }
  return problems;
}

/**
 * ⑰ 对账主入口（只读）。返回：
 * {
 *   endpoints: [{ endpointId, status: "ok"|"block"|"unclear", problems: [...], counts: {...}|null }],
 *   chain: { state: "off"|"partial"|"on"|null, problems: [...], unclear: string|null, note: string|null },
 *   intentNote: "intent 未纳入（§4 ③ intent store 尚未实现）",
 *   summary: { total, green, block, unclear },
 * }
 */
export function ownerSelectReconcile({ maintenanceDir, env = process.env, now = Date.now() } = {}) {
  const endpoints = [];
  const summary = { total: 0, green: 0, block: 0, unclear: 0 };
  const chain = { state: null, problems: [], unclear: null, note: null };
  if (typeof maintenanceDir !== "string" || maintenanceDir.length === 0) {
    return { endpoints, chain: { ...chain, unclear: "维护目录说不清" }, summary, intentNote: INTENT_NOTE };
  }

  // ── 收据聚合：任一收据说不清 → 整项查不清点名，不猜 ──
  const agg = aggregateEndpointReceipts({ dir: maintenanceDir });
  if (!agg.ok) {
    const why = agg.unreadable?.length > 0
      ? "收据 journal 读不出 " + agg.unreadable.length + " 个（如 " + agg.unreadable[0].token.slice(0, 8) + "：" + agg.unreadable[0].why + "）"
      : "收据矛盾：" + (agg.why ?? "说不清");
    return { endpoints, chain: { ...chain, unclear: why }, summary, intentNote: INTENT_NOTE };
  }
  const initDone = agg.endpoints.filter((e) => e.initDone === true);
  const initDoneSet = new Set(initDone.map((e) => e.endpointId));

  // ── 逐 endpoint：账本一致性 + 存量计数 + handle 卫生 ──
  const schemaByEndpoint = new Map();
  for (const ep of initDone) {
    const entry = { endpointId: ep.endpointId, status: "ok", problems: [], counts: null };
    const L = loadByEndpoint(ep.endpointId, { env });
    if (!L.ok) {
      entry.status = "block";
      entry.problems.push(L.granular === "absent" ? "有 init 收据但账本缺席" : "账本受验读取不过（" + (L.why ?? L.reason ?? "说不清") + "）");
      endpoints.push(entry);
      summary.total += 1; summary.block += 1;
      continue;
    }
    const doc = L.doc;
    const v = validateLedger(doc, { endpointId: ep.endpointId });
    if (!v.ok) {
      entry.status = "block";
      entry.problems.push("validateLedger 不过：" + (v.why ?? "说不清"));
      endpoints.push(entry);
      summary.total += 1; summary.block += 1;
      continue;
    }
    schemaByEndpoint.set(ep.endpointId, doc.schema_version);
    // endpoint 内 handle 全局唯一（#141/§7.2 G-handle；intent store 未实现，跨文件唯一后续并入）
    const seenHandles = new Map();
    for (const rec of Object.values(doc.records)) {
      if (rec?.kind !== "live") continue;
      for (const h of [rec.selection_handle ?? null, rec.rebind_handle ?? null]) {
        if (h === null) continue;
        if (seenHandles.has(h)) {
          entry.problems.push("handle 重复（endpoint 内须全局唯一）：" + h.slice(0, 12) + "（" + seenHandles.get(h).slice(0, 12) + " 与 " + rec.topic_agent_id.slice(0, 12) + "）");
        } else seenHandles.set(h, rec.topic_agent_id);
      }
    }
    for (const rec of Object.values(doc.records)) {
      if (rec?.kind !== "live") continue;
      for (const p of checkLiveRecord(doc, rec, doc.schema_version)) entry.problems.push(rec.topic_agent_id.slice(0, 12) + "：" + p);
    }
    // ── 存量计数（§9：严格后恒 0 非 0 block；过渡/1.0 报 opaque 计数）──
    const inv = migrationInventory(doc);
    entry.counts = { schema_version: doc.schema_version, legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count };
    if (doc.schema_version === "1.1" && (inv.legacy_proof_count !== 0 || inv.null_b1_count !== 0)) {
      entry.status = "block";
      entry.problems.push("strict 下存量非零：legacy_proof_count=" + inv.legacy_proof_count + " null_b1_count=" + inv.null_b1_count);
    }
    entry.status = entry.problems.length > 0 ? "block" : "ok";
    endpoints.push(entry);
    summary.total += 1;
    summary[entry.status === "ok" ? "green" : "block"] += 1;
  }

  // ── 迁移状态链：campaign × writer_state 直读 + readOwnerSelectAdmission 联合互证 ──
  const c = readCampaignState(env);
  const w = readWriterState(env);
  const unreadable = (who, problem) => { chain.unclear = who + " 读不出：" + problem; };
  if (c.state === "unreadable") unreadable("campaign", c.problem);
  else if (w.state === "unreadable") unreadable("writer_state", w.problem);
  else {
    const idsMatch = c.exists && w.campaign_id === c.campaign_id && w.endpoints_digest === c.endpoints_digest;
    if (w.exists && w.state === "on") {
      if (!c.exists || c.state !== "complete" || !idsMatch) {
        chain.state = "on"; chain.problems.push("writer on 但 campaign 不是 complete 且同源（campaign " + (c.exists ? c.state : "缺席") + (c.exists && !idsMatch ? "，campaign_id/digest 不匹配" : "") + "）");
      } else chain.state = "on";
    } else if (w.exists && w.state === "partial") {
      if (!c.exists || (c.state !== "open" && c.state !== "sealed") || !idsMatch) {
        chain.state = "partial"; chain.problems.push("writer partial 但 campaign 不是 open/sealed 且同源（campaign " + (c.exists ? c.state : "缺席") + "）");
      } else chain.state = "partial";
    } else if (w.exists && w.state === "off") {
      chain.state = "off";
      if (c.exists) chain.problems.push("writer off 但 campaign 在场（" + c.state + "）—— 迁移状态链不自洽");
    } else if (!w.exists && !c.exists) {
      chain.state = "off";
    } else {
      chain.state = c.exists ? c.state : "off";
      chain.problems.push("campaign/writer_state 组合说不清（writer " + (w.exists ? w.state : "缺席") + "，campaign " + (c.exists ? c.state : "缺席") + "）");
    }
    // campaign endpoints ⊆ initDone；campaign state 与各 endpoint 账本 schema 相容
    if (c.exists && Array.isArray(c.endpoints)) {
      const extras = c.endpoints.filter((ep) => !initDoneSet.has(ep));
      if (extras.length > 0) chain.problems.push("campaign 收录了未 initDone 的 endpoint：" + extras.join("、"));
      for (const ep of c.endpoints) {
        const schema = schemaByEndpoint.get(ep);
        if (schema === undefined) continue; // 上面已点名（不在 initDone 集）或该 ep 读不出已在本 endpoint 桶里
        if (c.state === "complete" && schema !== "1.1") chain.problems.push("campaign complete 但 " + ep + " 账本 schema=" + schema + "（应全 strict）");
        if ((c.state === "open" || c.state === "sealed") && schema !== "1.1-transition" && schema !== "1.1") {
          chain.problems.push("campaign " + c.state + " 但 " + ep + " 账本 schema=" + schema + "（应为 transition 或 strict）");
        }
      }
    }
    // 联合互证：直读判为干净时，readOwnerSelectAdmission 仍报 unreadable → 有一处视角没覆盖，查不清
    const adm = readOwnerSelectAdmission(env);
    if (chain.problems.length === 0 && adm.state === "unreadable") {
      chain.unclear = "readOwnerSelectAdmission 报 unreadable：" + (adm.problem ?? "说不清");
    }
  }

  // ── journal 1.4 进行中的迁移：只报不判（归 ⑩/维护门）──
  const act = readActive({ dir: maintenanceDir });
  if (act.state === "active") {
    const j = readJournal({ dir: maintenanceDir, token: act.token });
    const phase = j.state === "valid" ? j.doc.phase : "phase 说不清";
    chain.note = "迁移进行中（" + phase + "，operation " + act.token.slice(0, 8) + "）—— 进行中由 ⑩/维护门负责，本项不判 block";
  }

  // 查不清的 endpoint（收据层面的矛盾已由 agg.ok 兜底；此处兜逐 endpoint 的不确定）
  for (const ep of agg.endpoints) {
    if (ep.state === "conflict") {
      endpoints.push({ endpointId: ep.endpointId, status: "unclear", problems: ["收据 conflict：" + (agg.why ?? "说不清")], counts: null });
      summary.total += 1; summary.unclear += 1;
    }
  }
  return { endpoints, chain, summary, intentNote: INTENT_NOTE };
}

export const INTENT_NOTE = "intent 未纳入（§4 ③ intent store 尚未实现，reaffirm sidecar 不在本项对账范围）";
