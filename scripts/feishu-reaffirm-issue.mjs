#!/usr/bin/env node
/**
 * R57b §8.1：终端签发 reaffirm intent —— `/feishu-reaffirm-issue <target_id>`（**只在终端**，飞书不开放）。
 *
 * 流程：owner 在终端对本单点名的 target 预览 / 签发 → 命令回执打印 `rfh_` handle → owner 在对应话题里
 * 发 `/feishu-select <rfh_…>` → owner_select_reaffirm 消费（§6/§12）。**默认预览零写**；`--apply` 才写
 * intent 文件（intent 文件锁内 CAS：同 target 无未清 intent，过期项先受验清理；unreadable fail-closed）。
 *
 * 用法：node scripts/feishu-reaffirm-issue.mjs <target_id> [--apply]
 * 退出码：0 = 预览/签发完成；1 = 干净拒绝（参数/盘点/CAS）。
 */

import fs from "node:fs";
import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { ENDPOINT_SHAPE, ID_SHAPE, ledgerRootFor, loadLedger, familyOf, ownerSelectReaffirmClosureDigest } from "./topic-agent-ledger.mjs";
import { REAFFIRM_TARGET_FAMILIES, issueReaffirmIntent } from "./maintenance/reaffirm-intents.mjs";

const fail = (msg, code = 1) => {
  console.error("✗ " + msg);
  process.exit(code);
};

function findTarget({ targetId, env }) {
  const root = ledgerRootFor(env);
  if (!root) fail("账本根说不清（HOME / FEISHU_BRIDGE_LEDGER_DIR）");
  let names;
  try { names = fs.readdirSync(root); } catch (err) { fail("账本根读不出：" + String(err.code ?? err.message)); }
  for (const name of names.sort()) {
    if (!ENDPOINT_SHAPE.test(name)) continue;
    const l = loadLedger(path.join(root, name), { endpointId: name });
    if (!l.ok) continue; // 读不出的 endpoint 不冒充命中（fail-closed：不猜）
    const rec = l.doc.records[targetId];
    if (rec && rec.kind === "live") return { endpointId: name, doc: l.doc, rec };
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) fail("用法：node scripts/feishu-reaffirm-issue.mjs <target_id> [--apply]");
  const targetId = positional[0];
  if (!ID_SHAPE.test(targetId)) fail("target_id 形状不对（须 ta_+32hex）：" + targetId);

  const hit = findTarget({ targetId, env: process.env });
  if (!hit) fail("账本里找不到 live 记录 " + targetId);
  const { endpointId, doc, rec } = hit;
  const fam = familyOf(rec.facts);
  if (!REAFFIRM_TARGET_FAMILIES.includes(fam)) fail("family " + String(fam) + " 不在 reaffirm 范围（只对 B3/B3'/B4/A3/A4）");
  const digest = ownerSelectReaffirmClosureDigest(doc, targetId);

  if (!apply) {
    console.log("reaffirm 签发预览（零写；加 --apply 才签发）");
    console.log("  endpoint : " + endpointId);
    console.log("  target   : " + targetId);
    console.log("  family   : " + fam);
    console.log("  chat_id  : " + rec.chat_id);
    console.log("  session  : " + String(rec.aliases.session_id));
    console.log("  root_om  : " + String(rec.aliases.root_om));
    console.log("  expected_old_proof_closure_digest : " + digest);
    console.log("");
    console.log("签发后会在对应话题消费；消费时记录再变动会拒（digest CAS / family 核）。");
    return;
  }

  const tpl = loadChainTemplate();
  if (!tpl.ok) fail("链路模板读不出（frank_sender_id 是消费时 sender 核验的依据）：" + (tpl.reason ?? "?"));
  const issued = issueReaffirmIntent({ endpointId, targetId, authorizedOwner: tpl.template.frank_sender_id, chatId: rec.chat_id, env: process.env });
  if (!issued.ok) fail("签发被拒：" + issued.reason + (issued.why ? "（" + issued.why + "）" : ""));
  if (issued.cleaned_count > 0) console.log("  已受验清理该 target 的过期 intent：" + issued.cleaned_count + " 条");
  console.log("已签发 reaffirm intent：");
  console.log("  handle（rfh_）: " + issued.reaffirm_handle);
  console.log("  过期时间      : " + issued.entry.expires_at);
  console.log("");
  console.log("下一步：在对应话题发送  /feishu-select " + issued.reaffirm_handle);
}

if (isDirectRun(import.meta.url)) main();
