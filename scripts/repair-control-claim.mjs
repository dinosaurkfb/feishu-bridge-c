/**
 * 控制命令事务的显式维护入口（Claude 侧）：一笔 claim 里有控制意图、却没记下 consumed 终态（模式已切换、账本未闭合）时，
 * 在这里续做（幂等执行 + 写终态）。飞书重发是新消息 = 新 claim，补不了旧账 —— 这才是"恢复消费者"。
 * 破坏性 CLI：只认 --project <root>、--key <64位hex>、--apply；未知 / 裸参数一律退出 2；默认只报告。
 */

import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { CLAIM_KEY_SHAPE, readClaimState } from "./claim.mjs";
import { inspectControlClaim, resumeControlClaim } from "./control-command.mjs";
import { setClaudeInteractionMode } from "./interaction-policy-store.mjs";

export function parseRepairControlArgs(argv, { target = "--project" } = {}) {
  let root = null; let key = null; let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === target || a === "--key") {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: a + "_value_required" };
      if (a === "--key") key = v; else root = v;
      i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!root) return { ok: false, reason: target + "_required" };
  if (!key || !CLAIM_KEY_SHAPE.test(key)) return { ok: false, reason: "key_shape" };
  return { ok: true, root, key, apply };
}

export function describeControlRepair({ seen, result, apply }) {
  if (result) {
    if (!result.ok) return "没有恢复（" + result.reason + (result.why ? "：" + result.why : "") + "）";
    return result.already ? "这笔已经闭合，无需恢复" : "已补齐终态（目标模式 " + result.intent.mode + "，" + (result.changed ? "本次完成切换" : "模式本来就是") + "）";
  }
  const head = { in_flight: "事务未闭合：控制意图 " + (seen.intent?.mode ?? "?") + "，终态缺席", consumed: "已闭合，无需恢复", mismatch: "终态与意图不一致：" + (seen.why ?? ""),
    consumed_unreadable: "终态记录损坏：" + (seen.why ?? ""), failed: "已记为失败（当时没切成），不恢复", not_control: "这张 claim 不是控制命令" }[seen.state]
    ?? ("说不清：" + seen.state + (seen.why ? "：" + seen.why : ""));
  return (apply ? "" : "[预览] ") + head + (seen.residue?.length ? "；另有 " + seen.residue.length + " 个临时残骸" : "") +
    (seen.state === "in_flight" || seen.state === "consumed_unreadable" ? (apply ? "" : "\n加 --apply 续做。") : "");
}

export function repairExitCode({ seen, result, apply }) {
  if (result) return result.ok ? 0 : 1;
  if (!apply) return 0;
  return seen.state === "consumed" ? 0 : 1;
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairControlArgs(process.argv.slice(2));
  if (!parsed.ok) { process.stderr.write("用法：node repair-control-claim.mjs --project <root> --key <64位hex> [--apply]（" + parsed.reason + "）\n"); process.exit(2); }
  const claimsDir = path.join(path.resolve(parsed.root), ".runtime-data", "inbound", "delivery-claims");
  const seen = inspectControlClaim({ claimsDir, key: parsed.key });
  let result = null;
  if (parsed.apply && (seen.state === "in_flight" || seen.state === "consumed_unreadable")) {
    const claim = readClaimState({ claimsDir, key: parsed.key }).claim;
    result = resumeControlClaim({ claimsDir, key: parsed.key,
      execute: (mode) => setClaudeInteractionMode({ root: path.resolve(parsed.root), claudeSessionId: claim?.claude_session_id ?? null, mode }) });
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
