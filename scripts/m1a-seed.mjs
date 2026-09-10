#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { isDirectRun } from "./direct-run.mjs";
import { gateBlocks } from "./maintenance-gate-core.mjs";
import { acquireOrderLock } from "./m1a/dual-write.mjs";
import {
  loadByEndpoint,
  migrateSeed,
  AUTHORIZED_BY_SHAPE,
  ENDPOINT_SHAPE,
  familyOf,
} from "./topic-agent-ledger.mjs";
import {
  collectClaudeLegacySnapshot,
  collectCodexLegacySnapshot,
  identitySubset,
  legacySourceDigest,
} from "./m1a/legacy-snapshot.mjs";
import {
  reconcileLegacyEndpoint,
  projectLegacySnapshot,
  projectShadowBFamily,
  topicAgentIdForLegacy,
  fieldMismatches,
} from "./m1a/reconcile.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { legacyEndpointId } from "./subscription.mjs";

/**
 * 派生 legacy 快照中各代际的 legacy_source_digest。
 * @returns {Map<string, string>} topic_agent_id -> legacy_source_digest
 */
export function computeLegacyDigests(endpointId, snapshot) {
  const digests = new Map();
  if (!snapshot?.bindings || !snapshot?.snapshot_identity) return digests;
  for (const b of snapshot.bindings) {
    const sub = identitySubset(snapshot.snapshot_identity, b);
    if (!sub.ok) continue;
    for (const g of b.state?.generations ?? []) {
      const d = legacySourceDigest({ binding: b, generation: g, identity: sub.subset });
      if (!d.ok) continue;
      const tid = topicAgentIdForLegacy(endpointId, b.binding_id, g.channel_generation_id);
      digests.set(tid, d.digest);
    }
  }
  return digests;
}

function collectFor(chain, env = process.env) {
  const home = env.HOME ?? os.homedir();
  if (chain === "claude") {
    const registryFile = env.FEISHU_BRIDGE_REGISTRY ?? path.join(home, ".claude", "feishu-bridge", "registry.json");
    const templateFile = env.FEISHU_BRIDGE_CHAIN_TEMPLATE ?? path.join(home, ".claude", "feishu-bridge", "chain-config.json");
    return collectClaudeLegacySnapshot({ registryFile, templateFile });
  }
  const codexHome = env.FEISHU_CODEX_BRIDGE_HOME ?? path.join(home, ".codex", "feishu-bridge");
  return collectCodexLegacySnapshot({ home: codexHome });
}

function resolveAuthorizedBy(authorizedBy, chain, env = process.env) {
  if (typeof authorizedBy === "string" && AUTHORIZED_BY_SHAPE.test(authorizedBy)) {
    return authorizedBy;
  }
  if (typeof env.FEISHU_BRIDGE_SENDER_ID === "string" && AUTHORIZED_BY_SHAPE.test(env.FEISHU_BRIDGE_SENDER_ID)) {
    return env.FEISHU_BRIDGE_SENDER_ID;
  }
  try {
    const home = env.HOME ?? os.homedir();
    const tplPath = env.FEISHU_BRIDGE_CHAIN_TEMPLATE ?? (
      chain === "codex"
        ? path.join(env.FEISHU_CODEX_BRIDGE_HOME ?? path.join(home, ".codex", "feishu-bridge"), "chain-config.json")
        : path.join(home, ".claude", "feishu-bridge", "chain-config.json")
    );
    if (fs.existsSync(tplPath)) {
      const tpl = JSON.parse(fs.readFileSync(tplPath, "utf-8"));
      if (typeof tpl?.frank_sender_id === "string" && AUTHORIZED_BY_SHAPE.test(tpl.frank_sender_id)) {
        return tpl.frank_sender_id;
      }
    }
  } catch { /* fallback */ }
  return null;
}

/**
 * 影子账本补种核心逻辑。
 * 默认预览模式（apply=false）：核验双射与 blocker，打印待补种候选，零写入副作用。
 * 执行模式（apply=true）：取 outer order 锁，重新对账，以 migrateSeed 补种并后置核验。
 */
export function seedShadowEndpoint({
  endpointId,
  apply = false,
  authorizedBy,
  env = process.env,
  collectLegacy,
  loadLedgerFn,
  now = Date.now(),
} = {}) {
  if (!endpointId || typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) {
    return { ok: false, reason: "bad_endpoint_id", why: "endpointId 缺失或形状不对" };
  }

  const L0 = loadLedgerFn ? loadLedgerFn() : loadByEndpoint(endpointId, { env });
  if (!L0.ok) return { ok: false, reason: "ledger_" + L0.reason, why: L0.why };
  if (L0.doc.authority_mode !== "shadow") {
    return { ok: false, reason: "not_shadow", why: "endpoint 不是 shadow 模式（当前为 " + L0.doc.authority_mode + "）" };
  }
  const chain = L0.doc.chain;

  // 1. 预览模式（零写入副作用，不取锁）
  if (!apply) {
    const S1 = collectLegacy ? collectLegacy() : collectFor(chain, env);
    if (!S1.ok) return { ok: false, reason: S1.reason, why: S1.why };
    const proj = projectLegacySnapshot({ endpointId, chain, snapshot: S1 });
    if (!proj.ok) return { ok: false, reason: proj.reason, why: proj.why };
    if (proj.blockers?.length > 0) {
      return { ok: false, reason: "cutover_blocked", blockers: proj.blockers, why: "存在 cutover 阻塞项" };
    }

    const S = projectShadowBFamily(L0.doc);
    const E = proj.records;

    const extraInShadow = [];
    for (const [id, s] of S) {
      if (!E.has(id)) extraInShadow.push({ topic_agent_id: id, facts: s.facts });
    }
    if (extraInShadow.length > 0) {
      return { ok: false, reason: "extra_in_shadow", mismatches: extraInShadow, why: "shadow 账本有多余记录，请先人工核实" };
    }

    const fieldDiffs = [];
    for (const [id, e] of E) {
      const s = S.get(id);
      if (s !== undefined) fieldDiffs.push(...fieldMismatches(id, e, s));
    }
    if (fieldDiffs.length > 0) {
      return { ok: false, reason: "field_mismatch", mismatches: fieldDiffs, why: "legacy 投影与 shadow 记录字段不一致" };
    }

    const toSeed = [];
    for (const [id, e] of E) {
      if (!S.has(id)) {
        toSeed.push({
          topic_agent_id_prefix: id.slice(0, 12),
          family: familyOf(e.facts),
          generation_lineage_id_prefix: e.generation_lineage_id.slice(0, 12),
          project_level: e.binding_target?.runtime === "claude" && e.binding_target?.claude_session_id === null,
        });
      }
    }
    return { ok: true, mode: "preview", endpointId, candidateCount: toSeed.length, candidates: toSeed };
  }

  // 2. 执行模式（--apply）
  const gate = gateBlocks({ env });
  if (gate.blocked) return { ok: false, reason: "maintenance", why: gate.text };

  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) {
    return { ok: false, reason: acq.reason ?? "outer_lock_unavailable", why: acq.why ?? acq.text };
  }

  try {
    const L1 = loadLedgerFn ? loadLedgerFn() : loadByEndpoint(endpointId, { env });
    if (!L1.ok) return { ok: false, reason: "ledger_" + L1.reason, why: L1.why };
    if (L1.doc.authority_mode !== "shadow") {
      return { ok: false, reason: "not_shadow", why: "endpoint 不是 shadow 模式" };
    }

    const S1 = collectLegacy ? collectLegacy() : collectFor(chain, env);
    if (!S1.ok) return { ok: false, reason: S1.reason, why: S1.why };
    const proj = projectLegacySnapshot({ endpointId, chain, snapshot: S1 });
    if (!proj.ok) return { ok: false, reason: proj.reason, why: proj.why };
    if (proj.blockers?.length > 0) {
      return { ok: false, reason: "cutover_blocked", blockers: proj.blockers, why: "存在 cutover 阻塞项" };
    }

    const S = projectShadowBFamily(L1.doc);
    const E = proj.records;

    const extraInShadow = [];
    for (const [id, s] of S) {
      if (!E.has(id)) extraInShadow.push({ topic_agent_id: id, facts: s.facts });
    }
    if (extraInShadow.length > 0) {
      return { ok: false, reason: "extra_in_shadow", mismatches: extraInShadow, why: "shadow 账本有多余记录，请先人工核实" };
    }

    const fieldDiffs = [];
    for (const [id, e] of E) {
      const s = S.get(id);
      if (s !== undefined) fieldDiffs.push(...fieldMismatches(id, e, s));
    }
    if (fieldDiffs.length > 0) {
      return { ok: false, reason: "field_mismatch", mismatches: fieldDiffs, why: "legacy 投影与 shadow 记录字段不一致" };
    }

    const toSeedIds = [];
    for (const [id] of E) {
      if (!S.has(id)) toSeedIds.push(id);
    }

    // P2-B already-consistent 短路：三类差异全空直接返回
    if (toSeedIds.length === 0) {
      return { ok: true, status: "already_consistent", mode: "apply", endpointId, seeded: [], revision: L1.doc.revision };
    }

    const digests = computeLegacyDigests(endpointId, S1);
    const candidates = [];
    for (const id of toSeedIds) {
      const rec = E.get(id);
      const digest = digests.get(id);
      if (!digest) {
        return { ok: false, reason: "missing_legacy_digest", why: "无法为 " + id.slice(0, 12) + " 派生 legacy_source_digest" };
      }
      const cand = {
        topic_agent_id: rec.topic_agent_id,
        kind: "live",
        chat_id: rec.chat_id,
        aliases: { ...rec.aliases },
        anchor_candidate: null,
        binding_target: rec.binding_target === null ? null : { ...rec.binding_target },
        facts: { ...rec.facts },
        generation_lineage_id: rec.generation_lineage_id,
        legacy_source_digest: digest,
      };
      if (L1.doc.schema_version === "1.1-transition" || L1.doc.schema_version === "1.1") {
        cand.selection_handle = null;
        cand.handle_expires_at = null;
        cand.rebind_handle = null;
        cand.rebind_expires_at = null;
      }
      candidates.push(cand);
    }

    const authBy = resolveAuthorizedBy(authorizedBy, chain, env);
    if (!authBy || !AUTHORIZED_BY_SHAPE.test(authBy)) {
      return { ok: false, reason: "bad_authorized_by", why: "authorizedBy 必须为合法 sender id" };
    }

    const requestKey = crypto.randomUUID();
    const seedRes = migrateSeed({ endpointId, requestKey, candidates, authorizedBy: authBy, env, now });
    if (!seedRes.ok) {
      return { ok: false, reason: seedRes.reason, why: seedRes.why ?? "migrateSeed 写入失败" };
    }

    // 后置核验：必须 ok 且 cutover_blockers 空
    const post = reconcileLegacyEndpoint({
      endpointId,
      chain: L1.doc.chain,
      collectLegacy: () => S1,
      loadLedgerFn: () => loadByEndpoint(endpointId, { env }),
    });
    if (!post.ok || (post.cutover_blockers?.length ?? 0) > 0) {
      return {
        ok: false,
        reason: "post_reconcile_failed",
        mismatches: post.mismatches,
        blockers: post.cutover_blockers,
        why: "后置对账未通过",
      };
    }

    return {
      ok: true,
      mode: "apply",
      endpointId,
      seeded: seedRes.result.seeded,
      revision: seedRes.result?.revision ?? seedRes.revision,
    };
  } finally {
    acq.release();
  }
}

if (isDirectRun(import.meta.url)) {
  const arg = (n) => {
    const i = process.argv.indexOf("--" + n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const apply = process.argv.includes("--apply");
  let endpointId = arg("endpoint");
  const authorizedBy = arg("authorized-by");

  if (!endpointId) {
    const tpl = loadChainTemplate();
    if (tpl.ok && tpl.template?.agent_uid) {
      endpointId = legacyEndpointId({ runtime: "claude", agentUid: tpl.template.agent_uid });
    }
  }
  if (!endpointId) {
    console.error("[m1a-seed] 错误：必须指定 --endpoint <endpoint_id> 或配置机器级链路模板");
    process.exit(1);
  }

  const res = seedShadowEndpoint({ endpointId, apply, authorizedBy });
  if (res.ok) {
    if (res.mode === "preview") {
      console.log(`[m1a-seed] 预览模式（零副作用）：端点 ${endpointId}`);
      console.log(`待补种候选数: ${res.candidateCount}`);
      for (const c of res.candidates) {
        console.log(`  - 话题: ${c.topic_agent_id_prefix}... 族: ${c.family} 代际: ${c.generation_lineage_id_prefix}... 项目级: ${c.project_level ? "是" : "否"}`);
      }
      if (res.candidateCount > 0) {
        console.log(`运行 'node scripts/m1a-seed.mjs --endpoint ${endpointId} --apply' 执行补种`);
      } else {
        console.log("双射已一致，无需补种");
      }
      process.exit(0);
    } else {
      if (res.status === "already_consistent") {
        console.log(`[m1a-seed] 账本已一致，无需补种（端点: ${endpointId}, revision: ${res.revision}）`);
      } else {
        console.log(`[m1a-seed] 补种成功（端点: ${endpointId}, revision: ${res.revision}, 补种条数: ${res.seeded.length}）`);
      }
      process.exit(0);
    }
  } else {
    console.error(`[m1a-seed] 失败 (${res.reason}): ${res.why ?? ""}`);
    if (res.mismatches) {
      console.error("差异项:", JSON.stringify(res.mismatches, null, 2));
    }
    if (res.blockers) {
      console.error("阻塞项:", JSON.stringify(res.blockers, null, 2));
    }
    process.exit(1);
  }
}
