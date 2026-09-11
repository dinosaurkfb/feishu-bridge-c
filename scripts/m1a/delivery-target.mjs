/**
 * R66：入站投递目标的账本解析与决策（M1b 前置消费路径）。
 *
 * resolveDeliveryTargetFromLedger —— 受验读账本（loadByEndpoint 内嵌整账本 validateLedger），
 *   在 kind==="live" 记录里按 aliases.root_om === rootOm 找：恰一条 → record；零条 → record:null；
 *   多条 → ledger_conflict；读不出/损坏 → ledger_unavailable（fail-closed，不猜）。纯读、零副作用。
 *
 * decideInboundDeliveryTarget —— 权威/shadow 双模决策：
 *   · authoritative：投递目标只认账本 binding_target——claude_session_id 为 UUID →
 *     findLiveSessionById（不在场 target=null，调用方走既有 bound_session_gone）；
 *     null → 项目级 legacy 同款规则（delivery pin / 唯一 live 顺手钉 / 多条歧义拒）；
 *     读不出、记录缺席、多条 → reject（调用方拒收，绝不回退 legacy mapping）。
 *   · shadow（当前真机状态）：行为同 legacy；记录在场且 target 与 legacy sid 分歧（或账本读不出）→
 *     带 divergence 标注，由调用方追加 notes（只记分歧，不改行为）。
 *   · authorityMode=null（未接入 M1a）→ 纯 legacy，账本连 open 都不发生。
 *
 * appendShadowDivergenceNote —— shadow 分歧落 notes 的唯一出口（best-effort，失败不抛）。
 */
import fs from "node:fs";

import { loadByEndpoint } from "../topic-agent-ledger.mjs";
import { findLiveSessionById, findLiveSessions, readDeliveryPin, selectDeliverySession } from "../live-session.mjs";

/** 项目根等式：两边 realpath 规范化；任一 realpath 失败（含不存在）按不符。 */
const sameRealPath = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};

/**
 * R66 返修一 P1-1：判源四态矩阵（inbound 与决策函数共用，纯函数）。
 * receipt = endpointReceipt 结果；ledgerMode = null（账本读不出/尚未读）或 "shadow"|"authoritative"。
 *   · 非 ok 收据（unreadable / conflict / in-progress / 维护目录说不清）→ reject，不回退；
 *   · never_initialized → legacy（不读账本）；
 *   · ok 且 !cutoverDone → shadow；账本可读时其 authority_mode 必须同为 shadow，否则 reject；
 *   · ok 且 cutoverDone → authoritative；账本必须可读且同为 authoritative，否则 reject。
 */
export function classifyLedgerAuthority({ receipt = null, ledgerMode = null } = {}) {
  if (!receipt || receipt.ok !== true) {
    return { mode: "reject", why: "收据判定不可用（" + String(receipt?.state ?? receipt?.why ?? "维护目录说不清") + "），不回退" };
  }
  if (receipt.state === "never_initialized") return { mode: "legacy", why: "未接入 M1a（无任何账本收据）" };
  if (!receipt.cutoverDone) {
    if (ledgerMode !== null && ledgerMode !== "shadow") return { mode: "reject", why: "收据是 init-only（shadow 期）但账本 authority_mode=" + String(ledgerMode) };
    return { mode: "shadow", why: "收据 init-only" };
  }
  if (ledgerMode !== "authoritative") return { mode: "reject", why: "收据已 cutover 但账本" + (ledgerMode === null ? "读不出（无法交叉核验）" : " authority_mode=" + String(ledgerMode)) };
  return { mode: "authoritative", why: "收据与账本一致（authoritative）" };
}

export function resolveDeliveryTargetFromLedger({ endpointId, rootOm, env = process.env } = {}) {
  if (typeof rootOm !== "string" || rootOm.length === 0) return { ok: false, reason: "ledger_unavailable", why: "root_om 缺失，无法在账本里定位话题" };
  const L = loadByEndpoint(endpointId, { env });
  if (!L.ok) return { ok: false, reason: "ledger_unavailable", why: L.why ?? L.reason ?? "账本读不出" };
  const hits = Object.values(L.doc.records).filter((r) => r?.kind === "live" && r?.aliases?.root_om === rootOm);
  if (hits.length > 1) return { ok: false, reason: "ledger_conflict", why: "root_OM 命中 " + hits.length + " 条 live 记录" };
  return {
    ok: true,
    authority_mode: L.doc.authority_mode,
    record: hits.length === 1 ? { topic_agent_id: hits[0].topic_agent_id, binding_target: hits[0].binding_target } : null,
  };
}

export function decideInboundDeliveryTarget({
  receipt = null,
  endpointId,
  rootOm = null,
  legacySessionId = null,
  projectRoot,
  env = process.env,
  resolve = resolveDeliveryTargetFromLedger,
  findLiveById = findLiveSessionById,
  selectSession = selectDeliverySession,
  readPin = readDeliveryPin,
  findLive = findLiveSessions,
} = {}) {
  // 第一刀：不读账本就能定的态（未接入 = legacy；收据本身坏 = 终态拒）
  const pre = classifyLedgerAuthority({ receipt, ledgerMode: null });
  if (pre.mode === "legacy") return { action: "legacy", divergence: null };
  if (receipt?.ok !== true) return { action: "reject", reason: "ledger_route_unavailable", why: pre.why };
  // shadow/authoritative：读账本，按矩阵交叉核账本 authority_mode（cutoverDone + 账本读不出在达里才拒）
  const resolved = resolve({ endpointId, rootOm, env });
  const cls = classifyLedgerAuthority({ receipt, ledgerMode: resolved.ok ? resolved.authority_mode : null });
  if (cls.mode === "reject") return { action: "reject", reason: "ledger_route_unavailable", why: cls.why };
  if (cls.mode === "shadow") {
    // shadow + 账本不可读 = 记录（不拒）；可读才谈分歧
    if (!resolved.ok) return { action: "legacy", divergence: { ledger: null, legacy: legacySessionId, ledger_unavailable: true } };
    const sid = resolved.record?.binding_target?.claude_session_id ?? null;
    return { action: "legacy", divergence: sid !== legacySessionId ? { ledger: sid, legacy: legacySessionId } : null };
  }
  // authoritative：只认账本
  if (!resolved.ok) return { action: "reject", reason: "ledger_route_unavailable", why: resolved.why ?? "账本读不出" };
  if (resolved.record === null) return { action: "reject", reason: "ledger_route_unavailable", why: "账本里没有这个话题（root_om " + rootOm + "）的 live 记录" };
  // R66 返修一 P1-2：账本 target 的项目根必须与本次路由项目一致（两边 realpath 规范化，失败按不符）——
  // 否则会把别的项目的 session 在当前 cwd 续起。不根据账本静默切项目。
  const btRoot = resolved.record.binding_target?.project_root;
  if (typeof btRoot !== "string" || !sameRealPath(btRoot, projectRoot)) {
    return { action: "reject", reason: "ledger_route_unavailable", why: "账本 target 的项目根与本次路由项目不一致" };
  }
  const sid = resolved.record.binding_target?.claude_session_id ?? null;
  if (sid !== null) return { action: "session", sessionId: sid, target: findLiveById({ projectRoot, claudeSessionId: sid }) };
  return { action: "project", picked: selectSession({ pinned: readPin(projectRoot), live: findLive({ projectRoot }) }) };
}

export function appendShadowDivergenceNote({ noteFile, divergence }) {
  if (!divergence) return false;
  try {
    fs.appendFileSync(noteFile, "delivery_target_shadow_divergence ledger=" + (divergence.ledger ?? "null")
      + " legacy=" + (divergence.legacy ?? "null")
      + (divergence.ledger_unavailable ? " ledger_unavailable=true" : "") + "\n");
    return true;
  } catch {
    return false; // best-effort：分歧记录失败不影响投递
  }
}
