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
  authorityMode = null,
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
  if (authorityMode !== "authoritative" && authorityMode !== "shadow") return { action: "legacy", divergence: null };
  const resolved = resolve({ endpointId, rootOm, env });
  if (!resolved.ok) {
    if (authorityMode === "authoritative") return { action: "reject", reason: "ledger_route_unavailable", why: resolved.why ?? resolved.reason ?? "账本读不出" };
    return { action: "legacy", divergence: { ledger: null, legacy: legacySessionId, ledger_unavailable: true } };
  }
  const sid = resolved.record?.binding_target?.claude_session_id ?? null;
  // 分派只认调用方带来的 authorityMode（收据层：账本读不出时它仍可用；cutover 收据 ⇔ 账本 authoritative，G14）。
  if (authorityMode === "authoritative") {
    if (resolved.record === null) return { action: "reject", reason: "ledger_route_unavailable", why: "账本里没有这个话题（root_om " + rootOm + "）的 live 记录" };
    if (sid !== null) return { action: "session", sessionId: sid, target: findLiveById({ projectRoot, claudeSessionId: sid }) };
    return { action: "project", picked: selectSession({ pinned: readPin(projectRoot), live: findLive({ projectRoot }) }) };
  }
  return { action: "legacy", divergence: sid !== legacySessionId ? { ledger: sid, legacy: legacySessionId } : null };
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
