/**
 * doctor ⑰ owner_select 对账（设计稿 owner-select-route.md §9/§7.2/§4/§8.2/§3.1）——
 * **纯函数 + 只读盘**：不修、不写飞书、不给修复建议；判据只读既有制品（账本、收据、campaign、
 * writer_state、journal 1.4、active），读不出/说不清一律 fail-closed 记「查不清」并点名。
 *
 * R56 返修一（Codex #143 一轮）：
 *   - P1-1：删除裸路径读账本与第二套守卫校验器——一律先 `loadByEndpoint`（fd 绑定、O_NOFOLLOW、
 *     单硬链接、0600、大小上限）受验读取 + 整账本 `validateLedger`，doctor 专属判据只跑在受验 doc 上；
 *     细粒度文案来自唯一校验器的结构化 why。账本读不出（FIFO/symlink/坏 JSON/权限）→ 该 endpoint
 *     「查不清」，不抛不挂、不误 block。
 *   - P1-2：handle 到期卫生——`now >= handle_expires_at / rebind_expires_at`（边界含等号）仍存活
 *     → block「handle 已过期未清理」（validateLedger 不核时间，这是 doctor 专属判据）。
 *   - P1-3：只把 `state === "ok" && initDone === true` 的 endpoint 视为 initDone；收据 conflict /
 *     in-flight 只进「查不清」一次，不进 initDone 集、不参与 campaign 成员关系，total 不重复。
 *   - P1-4：零收据 + 账本根缺席 → 本项不适用（ok:true，文案「尚未接入」）；有收据但根缺席 →
 *     fail-closed 查不清。
 *   - P2-5：「迁移进行中」只认 journal 1.4 且 operation_kind ∈ owner_select 迁移集；普通
 *     install/gate 的 active 不冒充迁移。
 *   - P2-7：诊断正文不输出 handle 前缀，只记 opaque id 与计数（redactHandle）。
 *
 * 对每个 initDone 的 endpoint：
 *   1. 账本一致性：validateLedger 不过 → block（结构化 why，脱敏后展示）。
 *   2. 存量计数：migrationInventory —— strict（1.1）下任一非 0 → block（strict 合法性由
 *      validateLedger 收口，这里只对受验 doc 报 opaque 计数）；transition/1.0 只报计数。
 *   3. handle 卫生：到期字段与存废一致、endpoint 内全局唯一（validateLedger 已核形状/族/G-handle，
 *      到期是本项专属）；intent store（§4 ③）不在本项对账范围，注明不猜。
 *   4. 迁移状态链：campaign × writer_state 直读 + readOwnerSelectAdmission 联合互证；
 *      campaign endpoints ⊆ initDone；campaign state 与各 endpoint 账本 schema 相容。
 */

import fs from "node:fs";

import { isCanonicalIso } from "../canonical-time.mjs";
import { loadByEndpoint, validateLedger, familyOf, migrationInventory, validateLedgerRoot } from "../topic-agent-ledger.mjs";
import { aggregateEndpointReceipts } from "./ledger-receipt.mjs";
import { readCampaignState, readWriterState, readOwnerSelectAdmission } from "./owner-select-state.mjs";
import { readActive, readJournal, OWNER_SELECT_OPERATION_KINDS } from "./journal.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HANDLE_RE = /(?:osh|orh|rfh)_[0-9a-f]{32}/gu;

/** P2-7：诊断正文不输出 handle 前缀——handle 值一律脱敏成 [handle]，只留 opaque id 与计数。 */
const redactHandle = (t) => String(t).replace(HANDLE_RE, "[handle]");

/** 单条 live 记录的 handle 到期卫生（P1-2，doctor 专属：validateLedger 不核时间）。 */
function checkHandleExpiry(rec, now, problems) {
  const fam = familyOf(rec.facts);
  for (const [hField, eField] of [["selection_handle", "handle_expires_at"], ["rebind_handle", "rebind_expires_at"]]) {
    if ((rec[hField] ?? null) === null) continue;
    if (!isCanonicalIso(rec[eField])) continue; // 形状问题归唯一校验器
    if (now >= Date.parse(rec[eField])) {
      problems.push(fam + " " + rec.topic_agent_id.slice(0, 12) + "：handle 已过期未清理（" + eField + " ≤ now）");
    }
  }
}

/**
 * ⑰ 对账主入口（只读）。返回：
 * {
 *   endpoints: [{ endpointId, status: "ok"|"block"|"unclear", problems: [...], counts: {...}|null }],
 *   chain: { state: "off"|"partial"|"on"|null, problems: [...], unclear: string|null, note: string|null },
 *   intentNote: "intent 未纳入（§4 ③ intent store 尚未实现）",
 *   notApplicable: string|null,   // P1-4：零收据 + 根缺席 → 「尚未接入」
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
  if (agg.unreadable?.length > 0) {
    return { endpoints, chain: { ...chain, unclear: "收据 journal 读不出 " + agg.unreadable.length + " 个（如 " + agg.unreadable[0].token.slice(0, 8) + "：" + agg.unreadable[0].why + "）" }, summary, intentNote: INTENT_NOTE };
  }
  // R56 返修二 P1-1：根缺席判定复用唯一根校验器——只有 root_absent 才允许「尚未接入」（且零 initDone
  // 收据）；no_root / root_symlink / root_not_canonical / root_unresolvable / root_perms 一律「查不清」。
  const rootV = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rootV.ok && rootV.reason !== "root_absent") {
    return { endpoints, chain: { ...chain, unclear: "账本根不可信（" + rootV.reason + (rootV.why ? "：" + rootV.why : "") + "）" }, summary, intentNote: INTENT_NOTE };
  }
  const rootAbsent = !rootV.ok && rootV.reason === "root_absent";
  // P1-4：全新机器——无任何收据且账本根缺席 → 本项不适用（尚未接入），不算红也不算查不清
  if (agg.endpoints.length === 0 && rootAbsent) {
    return { endpoints, chain: { state: "off", problems: [], unclear: null, note: null }, summary, intentNote: INTENT_NOTE, notApplicable: "尚未接入（没有任何 init 收据，账本根也未建）" };
  }
  // P1-3：只认 state === "ok" && initDone === true；conflict / in-flight 只进「查不清」一次，
  // 不进 initDone 集、不参与 campaign 成员关系（下面 extras 检查自然点名）。
  const initDone = agg.endpoints.filter((e) => e.state === "ok" && e.initDone === true);
  const initDoneSet = new Set(initDone.map((e) => e.endpointId));

  // ── 逐 endpoint：受验读取 → validateLedger → doctor 专属判据（计数 / 到期卫生）──
  const schemaByEndpoint = new Map();
  for (const ep of initDone) {
    const entry = { endpointId: ep.endpointId, status: "ok", problems: [], counts: null };
    const L = loadByEndpoint(ep.endpointId, { env });
    if (!L.ok) {
      if (L.granular === "unreadable" || (L.granular === "absent" && rootAbsent)) {
        // P1-1/P1-4：读不出（symlink/FIFO/坏 JSON/权限）或根整体缺席但有收据 → fail-closed 查不清
        entry.status = "unclear";
        entry.problems.push(L.granular === "absent"
          ? "有 init 收据但账本根缺席（fail-closed）"
          : "账本受验读取不过（" + (L.why ?? "说不清") + "）—— fail-closed");
      } else {
        // 账本损坏（validateLedger 不过）→ block，细粒度文案来自唯一校验器（脱敏后展示）
        entry.status = "block";
        entry.problems.push(L.granular === "absent" ? "有 init 收据但账本缺席" : "validateLedger 不过：" + (L.why ?? L.reason ?? "说不清"));
      }
      endpoints.push(entry);
      summary.total += 1;
      summary[entry.status === "unclear" ? "unclear" : "block"] += 1;
      continue;
    }
    const doc = L.doc; // loadByEndpoint 已内嵌整账本 validateLedger——到这里 doc 必受验
    schemaByEndpoint.set(ep.endpointId, doc.schema_version);
    // ── 存量计数（§9：报 opaque 计数；strict 合法性由 validateLedger 收口，这里不再第二套）──
    const inv = migrationInventory(doc);
    entry.counts = { schema_version: doc.schema_version, legacy_proof_count: inv.legacy_proof_count, null_b1_count: inv.null_b1_count };
    // ── handle 到期卫生（P1-2，doctor 专属：validateLedger 不核时间；边界含等号）──
    for (const rec of Object.values(doc.records)) {
      if (rec?.kind !== "live") continue;
      checkHandleExpiry(rec, now, entry.problems);
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
    // campaign endpoints ⊆ initDone（P1-3：conflict/in-flight endpoint 不在集内 → 这里点名）；
    // campaign state 与各 endpoint 账本 schema 相容
    if (c.exists && Array.isArray(c.endpoints)) {
      // R56 返修二 P2-3：收据不可信的 endpoint 已在收据层报过一次 unclear——campaign 检查不再对它
      // 生成「收录未 initDone」的 chain block（一次事实只报一次）。
      const receiptUnclear = new Set(agg.endpoints.filter((e) => e.state !== "ok").map((e) => e.endpointId));
      const extras = c.endpoints.filter((ep) => !initDoneSet.has(ep) && !receiptUnclear.has(ep));
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

  // ── journal 迁移进行中（P2-5）：只认 journal 1.4 且 owner_select 迁移 kinds——
  //    普通 install/gate 的 active 不冒充迁移（不产生 note，也不产生状态链 block；那归 ⑩/维护门）。
  //    readJournal 内嵌 journalProblem（phase×kind×step 合法性）→ j.state === "valid" 即合法中间态。
  const act = readActive({ dir: maintenanceDir });
  if (act.state === "active") {
    const j = readJournal({ dir: maintenanceDir, token: act.token });
    if (j.state === "valid" && j.doc.schema_version === "1.4" && OWNER_SELECT_OPERATION_KINDS.includes(j.doc.operation_kind)) {
      chain.note = "迁移进行中（" + j.doc.operation_kind + "：" + j.doc.phase + "，operation " + act.token.slice(0, 8) + "）—— 进行中由 ⑩/维护门负责，本项不判 block";
    }
  }

  // 查不清的 endpoint（收据层面的矛盾：conflict / in-flight——恰进这一桶，P1-3）
  for (const ep of agg.endpoints) {
    if (ep.state === "conflict" || ep.state === "duplicate_or_conflict") {
      endpoints.push({ endpointId: ep.endpointId, status: "unclear", problems: ["收据 conflict：" + (agg.why ?? "说不清")], counts: null });
      summary.total += 1; summary.unclear += 1;
    }
  }
  // P2-7：诊断正文不输出 handle 前缀——出口统一脱敏（opaque id 与计数保留）
  for (const e of endpoints) e.problems = e.problems.map(redactHandle);
  return { endpoints, chain, summary, intentNote: INTENT_NOTE };
}

export const INTENT_NOTE = "intent 未纳入（§4 ③ intent store 尚未实现，reaffirm sidecar 不在本项对账范围）";
