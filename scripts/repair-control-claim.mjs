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
import { resolveProject } from "./project-resolve.mjs";
import { effectiveBindingId } from "./topic-generation.mjs";

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
    const left = result.residueUncleared?.length ? "；但有 " + result.residueUncleared.length + " 个临时残骸清不掉，请人工查看" : "";
    return (result.already ? "这笔已经闭合，无需恢复" : "已补齐终态（目标模式 " + result.intent.mode + "，" + (result.changed ? "本次完成切换" : "模式本来就是") + "）") + left;
  }
  const head = { in_flight: "事务未闭合：控制意图 " + (seen.intent?.mode ?? "?") + "，终态缺席", consumed: "已闭合，无需恢复", mismatch: "终态与意图不一致：" + (seen.why ?? ""),
    consumed_unreadable: "终态记录损坏（意图 " + (seen.intent?.mode ?? "?") + "）：" + (seen.why ?? ""), failed_unreadable: "失败记录损坏（意图 " + (seen.intent?.mode ?? "?") + "）：" + (seen.why ?? ""),
    failed: "已记为失败（当时没切成），不恢复", conflict: "failed 与 consumed 并存，请人工查看", not_control: "这张 claim 不是控制命令",
    claim_unreadable: "claim 不属于当前绑定 / 读不出：" + (seen.why ?? ""), claim_absent: "没有这张 claim" }[seen.state]
    ?? ("说不清：" + seen.state + (seen.why ? "：" + seen.why : ""));
  const resumable = ["in_flight", "consumed_unreadable", "failed_unreadable"].includes(seen.state);
  return (apply ? "" : "[预览] ") + head + (seen.residue?.length ? "；另有 " + seen.residue.length + " 个临时残骸" : "") +
    (resumable && !apply ? "\n加 --apply 续做。" : "");
}

export function repairExitCode({ seen, result, apply }) {
  if (result) return result.ok && !(result.residueUncleared?.length) ? 0 : 1;
  if (!apply) return 0;
  return seen.state === "consumed" ? 0 : 1;
}

/** 当前项目绑定的身份期望：claim 必须属于它（logical task、binding、会话）。 */
export function claudeClaimExpectation({ root, registryFile, templateFile }) {
  const resolved = resolveProject({ root, registryFile, templateFile });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const mapping = resolved.mapping;
  return { ok: true, expect: { logicalTaskKey: mapping.logical_task_key, bindingId: effectiveBindingId(mapping), claudeSessionId: mapping.claude_session_id ?? null } };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairControlArgs(process.argv.slice(2));
  if (!parsed.ok) { process.stderr.write("用法：node repair-control-claim.mjs --project <root> --key <64位hex> [--apply]（" + parsed.reason + "）\n"); process.exit(2); }
  const root = path.resolve(parsed.root);
  const claimsDir = path.join(root, ".runtime-data", "inbound", "delivery-claims");
  const expectation = claudeClaimExpectation({ root });
  if (!expectation.ok) { process.stdout.write("当前项目没有可用绑定（" + expectation.reason + "）\n"); process.exit(1); }
  const expect = expectation.expect;
  const seen = inspectControlClaim({ claimsDir, key: parsed.key, expect });
  let result = null;
  if (parsed.apply && ["in_flight", "consumed_unreadable", "failed_unreadable"].includes(seen.state)) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, expect,
      execute: (mode) => setClaudeInteractionMode({ root, claudeSessionId: expect.claudeSessionId, mode,
        // 写锁内复核：这张 claim 此刻仍属于当前绑定，检查与写入之间不留漂移窗口。
        precondition: () => readClaimState({ claimsDir, key: parsed.key, expect }).status === "valid" }) });
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
