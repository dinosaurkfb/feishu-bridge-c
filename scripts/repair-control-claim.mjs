/**
 * 控制命令事务的显式维护入口（Claude 侧）：一笔 claim 里有控制意图、却没记下 consumed 终态（模式已切换、账本未闭合）时，
 * 在这里续做（幂等执行 + 写终态）。飞书重发是新消息 = 新 claim，补不了旧账 —— 这才是"恢复消费者"。
 * 身份：先从 claim 取会话定位，解析出它所属的精确绑定（项目级或会话级，与出站同一条选择规则），
 * 之后每次读 claim 都带这份期望；真正写入前，还要用**写锁内刚读出的记录**重新推导一遍身份再核对。
 * 破坏性 CLI：只认 --project <root>、--key <64位hex>、--apply；未知 / 裸参数一律退出 2；默认只报告。
 */

import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { CLAIM_KEY_SHAPE, readClaimState } from "./claim.mjs";
import { RESUMABLE_CONTROL_STATES, inspectControlClaim, resumeControlClaim } from "./control-command.mjs";
import { setClaudeInteractionMode } from "./interaction-policy-store.mjs";
import { mappingFromRegistryEntry, resolveProject } from "./project-resolve.mjs";
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
    const left = (result.residueUncleared?.length ? "；但有 " + result.residueUncleared.length + " 个临时残骸清不掉，请人工查看" : "") +
      (result.residueUnknown ? "；残骸情况说不清（" + result.residueUnknown + "），请人工查看" : "") +
      (result.lockUncleared ? "；事务锁没有交还（" + result.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后删除锁目录" : "");
    const held = result.quarantined?.length ? "；损坏的 failed 记录已隔离为 " + result.quarantined.join("、") + "，人工查看后删除" : "";
    return (result.already ? "这笔已闭合，无需恢复" : "已补齐终态（目标模式 " + result.intent.mode + "，" + (result.changed ? "本次完成切换" : "模式本来就是") + "）") + held + left;
  }
  const head = { in_flight: "事务未闭合：控制意图 " + (seen.intent?.mode ?? "?") + "，终态缺席", consumed: "已闭合，无需恢复", mismatch: "终态与意图不一致：" + (seen.why ?? ""),
    consumed_unreadable: "终态记录损坏（意图 " + (seen.intent?.mode ?? "?") + "）：" + (seen.why ?? ""), failed_unreadable: "失败记录损坏（意图 " + (seen.intent?.mode ?? "?") + "）：" + (seen.why ?? ""),
    failed: "已记为失败（当时没切成），不恢复", conflict: "两份终态并存（" + (seen.why ?? "") + "），请人工查看", not_control: "这张 claim 不是控制命令",
    claim_unreadable: "claim 不属于当前绑定 / 读不出：" + (seen.why ?? ""), claim_absent: "没有这张 claim" }[seen.state]
    ?? ("说不清：" + seen.state + (seen.why ? "：" + seen.why : ""));
  const resumable = RESUMABLE_CONTROL_STATES.includes(seen.state);
  return (apply ? "" : "[预览] ") + head + (seen.residue?.length ? "；另有 " + seen.residue.length + " 个临时残骸" : "") +
    (seen.quarantined?.length ? "；另有 " + seen.quarantined.length + " 个隔离的损坏 failed 制品待人工查看" : "") +
    (seen.listingProblem ? "；同 key 的临时制品说不清（" + seen.listingProblem + "）" : "") +
    (resumable && !apply ? "\n加 --apply 续做。" : "");
}

/** 退出码：只要还有没闭合的事、清不掉的残骸，就不许报 0 —— 第二次运行也一样。 */
export function repairExitCode({ seen, result, apply }) {
  if (result) return result.ok && !(result.residueUncleared?.length) && !result.residueUnknown && !result.lockUncleared ? 0 : 1;
  if (!apply) return 0;
  return seen.state === "consumed" && !(seen.residue?.length) && !seen.listingProblem ? 0 : 1;
}

/**
 * 由一份 mapping（项目文件那份，或登记表条目合成的那份）推导 claim 必须满足的身份期望。
 * bindingId 用存储层同一算法 effectiveBindingId(mapping, { root })：旧形状的项目文件没有 binding_id / topic_generation_state 时
 * 得到 `<basename>@project-files`，约束不丢 —— claim 里写的是别的 binding（或没写）都对不上，fail-closed。
 */
export function expectationFromMapping(mapping, { root = null } = {}) {
  return { logicalTaskKey: mapping.logical_task_key, bindingId: effectiveBindingId(mapping, { root }), claudeSessionId: mapping.claude_session_id ?? null };
}

/** 当前项目里、这张 claim 所属的精确绑定（claim 带会话定位就选会话级，否则项目级）的身份期望。 */
export function claudeClaimExpectation({ root, claudeSessionId = null, registryFile, templateFile }) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile, templateFile });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, expect: expectationFromMapping(resolved.mapping, { root }) };
}

/**
 * 写锁内的前置条件：参数是存储层在锁内刚读出的记录。用它**重新**推导身份，再用这份锁内身份读 claim ——
 * 锁外算好的 expect 在这里不作数。锁外到锁内之间绑定换代（claim 的 logical task / binding / 会话任一对不上）就拒。
 * （claim 的 logical_task_key 由 key 推导、不可换，所以"锁内身份 vs claim"这一道核对已经蕴含"锁内身份 vs 锁外身份"。）
 */
export function controlRepairPrecondition({ claimsDir, key, root = null }) {
  return (record, meta = {}) => {
    if (!record || typeof record !== "object") return false;
    const live = meta.source === "registry" ? mappingFromRegistryEntry(record) : record;
    return readClaimState({ claimsDir, key, expect: expectationFromMapping(live, { root: meta.root ?? root }) }).status === "valid";
  };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairControlArgs(process.argv.slice(2));
  if (!parsed.ok) { process.stderr.write("用法：node repair-control-claim.mjs --project <root> --key <64位hex> [--apply]（" + parsed.reason + "）\n"); process.exit(2); }
  const root = path.resolve(parsed.root);
  const claimsDir = path.join(root, ".runtime-data", "inbound", "delivery-claims");
  // 第一次读 claim 只为拿会话定位（选项目级还是会话级绑定）；身份核对在下面带 expect 再做一遍。
  const located = readClaimState({ claimsDir, key: parsed.key });
  const claudeSessionId = located.status === "valid" ? (located.claim.claude_session_id ?? null) : null;
  const expectation = claudeClaimExpectation({ root, claudeSessionId });
  if (!expectation.ok) { process.stdout.write("当前项目没有可用绑定（" + expectation.reason + "）\n"); process.exit(1); }
  const expect = expectation.expect;
  const seen = inspectControlClaim({ claimsDir, key: parsed.key, expect });
  let result = null;
  if (parsed.apply && (RESUMABLE_CONTROL_STATES.includes(seen.state) || seen.state === "consumed")) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, expect,
      execute: (mode) => setClaudeInteractionMode({ root, claudeSessionId: expect.claudeSessionId, mode,
        precondition: controlRepairPrecondition({ claimsDir, key: parsed.key, root }) }) });
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
