#!/usr/bin/env node
/**
 * R57b §8.1：终端签发 reaffirm intent —— `/feishu-reaffirm-issue <target_id>`（**只在终端**，飞书不开放）。
 *
 * 流程：owner 在终端对本单点名的 target 预览 / 签发 → 命令回执打印 `rfh_` handle → owner 在对应话题里
 * 发 `/feishu-select <rfh_…>` → owner_select_reaffirm 消费（§6/§12）。**默认预览零写**；`--apply` 才写
 * intent 文件（intent 文件锁内 CAS：同 target 无未清 intent，过期项先受验清理；unreadable fail-closed）。
 *
 * 用法：node scripts/feishu-reaffirm-issue.mjs <target_id> [--apply]
 * 退出码：0 = 预览/签发完成；1 = 干净拒绝（参数/盘点/CAS）；2 = CLI 参数错误。
 */

import { isDirectRun } from "./direct-run.mjs";
import { maintenanceDir } from "./maintenance/journal.mjs";
import { aggregateEndpointReceipts } from "./maintenance/ledger-receipt.mjs";
import { ID_SHAPE, loadByEndpoint, familyOf } from "./topic-agent-ledger.mjs";
import { REAFFIRM_TARGET_FAMILIES, issueReaffirmIntent, loadAndVerifyTemplate } from "./maintenance/reaffirm-intents.mjs";

const fail = (msg, code = 1) => {
  console.error("✗ " + msg);
  process.exit(code);
};

export function parseIssueArgs(argv) {
  let applyCount = 0;
  const positional = [];
  for (const a of argv) {
    if (a === "--apply") {
      applyCount++;
      if (applyCount > 1) return { ok: false, reason: "重复的 --apply 参数" };
    } else if (a.startsWith("-")) {
      return { ok: false, reason: "未知参数：" + a };
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    return { ok: false, reason: "用法：node scripts/feishu-reaffirm-issue.mjs <target_id> [--apply]" };
  }
  const targetId = positional[0];
  if (!ID_SHAPE.test(targetId)) {
    return { ok: false, reason: "target_id 形状不对（须 ta_+32hex）：" + targetId };
  }
  return { ok: true, targetId, apply: applyCount === 1 };
}

export function findTarget({ targetId, env = process.env }) {
  const mDir = maintenanceDir(env);
  if (!mDir) return { ok: false, reason: "maintenance_dir_unresolvable", why: "维护目录说不清（FEISHU_BRIDGE_MAINTENANCE_DIR / realUserHome）" };
  const agg = aggregateEndpointReceipts({ dir: mDir });
  if (!agg.ok) {
    return { ok: false, reason: "receipts_unusable", why: agg.why ?? "收据矛盾或读不出" };
  }
  const endpointIds = [...new Set(agg.endpoints.filter((e) => e.initDone === true).map((e) => e.endpointId))].sort();
  if (endpointIds.length === 0) {
    return { ok: false, reason: "no_initialized_endpoints", why: "无受验已初始化 endpoint" };
  }

  const hits = [];
  for (const ep of endpointIds) {
    const l = loadByEndpoint(ep, { env });
    if (!l.ok) {
      return { ok: false, reason: "endpoint_ledger_unreadable", why: "endpoint " + ep + " 账本读不出（" + (l.why ?? l.granular ?? l.reason) + "）" };
    }
    const rec = l.doc.records[targetId];
    if (rec && rec.kind === "live") {
      hits.push({ endpointId: ep, doc: l.doc, rec });
    }
  }

  if (hits.length === 0) {
    return { ok: false, reason: "target_not_found", why: "账本里找不到 live 记录 " + targetId };
  }
  if (hits.length > 1) {
    return { ok: false, reason: "multiple_targets_found", count: hits.length, why: "目标 " + targetId + " 在多个账本中命中（数量：" + hits.length + "）" };
  }
  return { ok: true, hit: hits[0] };
}

export { loadAndVerifyTemplate };

function main() {
  const parsed = parseIssueArgs(process.argv.slice(2));
  if (!parsed.ok) fail(parsed.reason, 2);

  const found = findTarget({ targetId: parsed.targetId, env: process.env });
  if (!found.ok) fail(found.why ?? found.reason, 1);
  const { endpointId, doc, rec } = found.hit;

  const fam = familyOf(rec.facts);
  if (!REAFFIRM_TARGET_FAMILIES.includes(fam)) fail("family " + String(fam) + " 不在 reaffirm 范围（只对 B3/B3'/B4/A3/A4）");

  const tplVer = loadAndVerifyTemplate({ doc, rec, env: process.env });
  if (!tplVer.ok) fail(tplVer.why ?? tplVer.reason, 1);

  if (!parsed.apply) {
    console.log("reaffirm 签发预览（零写；加 --apply 才签发）");
    console.log("  target   : " + parsed.targetId);
    console.log("  family   : " + fam);
    console.log("  有效期   : 7 天（签发后）");
    console.log("");
    console.log("签发后需在对应话题发送 /feishu-select <rfh_…> 确认。");
    return;
  }

  const issued = issueReaffirmIntent({
    endpointId,
    targetId: parsed.targetId,
    authorizedOwner: tplVer.authorizedOwner,
    chatId: rec.chat_id,
    env: process.env,
  });
  if (!issued.ok) fail("签发被拒：" + issued.reason + (issued.why ? "（" + issued.why + "）" : ""));
  if (issued.cleaned_count > 0) console.log("  已受验清理该 target 的过期 intent：" + issued.cleaned_count + " 条");
  console.log("已签发 reaffirm intent：");
  console.log("  handle（rfh_）: " + issued.reaffirm_handle);
  console.log("  过期时间      : " + issued.entry.expires_at);
  console.log("");
  console.log("下一步：在对应话题发送  /feishu-select " + issued.reaffirm_handle);
}

if (isDirectRun(import.meta.url)) main();
