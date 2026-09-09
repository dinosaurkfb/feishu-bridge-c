/**
 * 控制命令事务的显式维护入口（Claude 侧）：一笔 claim 里有控制意图（mode 或 select）、却没记下 consumed 终态时，
 * 在这里续做（幂等执行 + 写终态）。飞书重发是新消息 = 新 claim，补不了旧账 —— 这才是"恢复消费者"。
 * 身份：先从 claim 取会话定位，解析出它所属的精确绑定（项目级或会话级，与出站同一条选择规则），
 * 之后每次读 claim 都带份期望；真正写入前，还要用**写锁内刚读出的记录**重新推导一遍身份再核对。
 * 破坏性 CLI：只认 --project <root>、--key <64位hex>、--apply；未知 / 裸参数一律退出 2；默认只报告。
 */

import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { CLAIM_KEY_SHAPE, readClaimState } from "./claim.mjs";
import { RESUMABLE_CONTROL_STATES, inspectControlClaim, resumeControlClaim } from "./control-command.mjs";
import { RESUMABLE_REJECT_STATES, describeRejectRepair, inspectRejectedClaim, rejectRepairExitCode, resumeRejectedClaim } from "./reject-control.mjs";
import { setClaudeInteractionMode } from "./interaction-policy-store.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { expectationFromMapping, claudeControlPrecondition } from "./control-identity.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import { executeSelectControl, verifySelectionContext } from "./select-admission.mjs";
import { resolveEndpointDir, loadLedger } from "./topic-agent-ledger.mjs";
import { cleanReaffirmIntent } from "./maintenance/reaffirm-intents.mjs";

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

function describeIntent(intent) {
  if (!intent) return "?";
  if (intent.control === "select") return "选择 " + (intent.handle ?? "默认候选");
  return intent.mode ?? "?";
}

function describeTarget(intent) {
  if (!intent) return "?";
  if (intent.control === "select") return "目标选择 " + (intent.handle ?? "默认候选");
  return "目标模式 " + (intent.mode ?? "?");
}

export function describeControlRepair({ seen, result, apply }) {
  if (result) {
    if (!result.ok) return "没有恢复（" + result.reason + (result.why ? "：" + result.why : "") + "）";
    const left = (result.residueUncleared?.length ? "；但有 " + result.residueUncleared.length + " 个临时残骸清不掉，请人工查看" : "") +
      (result.residueUnknown ? "；残骸情况说不清（" + result.residueUnknown + "），请人工查看" : "") +
      (result.lockUncleared ? "；事务锁没有交还（" + result.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后删除锁目录" : "");
    const held = result.quarantined?.length ? "；损坏的 failed 记录已隔离为 " + result.quarantined.join("、") + "，人工查看后删除" : "";
    const targetDesc = describeTarget(result.intent);
    const actionDesc = result.intent?.control === "select"
      ? (result.changed ? "已完成选择" : "选择未变化")
      : (result.changed ? "本次完成切换" : "模式本来就是");
    return (result.already ? "这笔已闭合，无需恢复" : "已补齐终态（" + targetDesc + "，" + actionDesc + "）") + held + left;
  }
  const intentDesc = describeIntent(seen.intent);
  const head = { in_flight: "事务未闭合：控制意图 " + intentDesc + "，终态缺席", consumed: "已闭合，无需恢复", mismatch: "终态与意图不一致：" + (seen.why ?? ""),
    consumed_unreadable: "终态记录损坏（意图 " + intentDesc + "）：" + (seen.why ?? ""), failed_unreadable: "失败记录损坏（意图 " + intentDesc + "）：" + (seen.why ?? ""),
    failed: "已记为失败（" + (seen.intent?.control === "select" ? "当时未执行选择" : "当时没切成") + "），不恢复", conflict: "两份终态并存（" + (seen.why ?? "") + "），请人工查看", not_control: "这张 claim 不是控制命令",
    claim_unreadable: "claim 不属于当前绑定 / 读不出：" + (seen.why ?? ""), claim_absent: "没有这张 claim",
    "control-committed-unclean": "事务已写入账本但收口不干净（意图 " + intentDesc + "）：" + (seen.why ?? seen.record?.why ?? "收口不干净，可恢复") }[seen.state]
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
 * 两个 repair 消费者的按 kind 穷举分发（Claude 与 Codex 共用）：
 *   - select 支：受验 selection_context，根据状态分派（unclean 走专门路径，in_flight 走真执行器）
 *   - mode 支：走 onMode
 *   - 其它值 fail-closed：结构化拒 unknown_control_kind，不得"否则按 mode"
 */
export function dispatchControlRepair(target, { onMode, onSelect = null } = {}, ctx = {}) {
  const kind = target?.control ?? (typeof target === "string" ? "mode" : null);
  if (kind === "select") {
    if (typeof onSelect === "function") return onSelect(target, ctx);
    const claim = ctx?.claim;
    const vCtx = verifySelectionContext(claim);
    if (!vCtx.ok) return { ok: false, reason: vCtx.reason, why: vCtx.why };
    const sc = vCtx.context;
    if (ctx?.uncleanRecord || claim?.state === "control-committed-unclean") {
      return repairControlCommittedUnclean({
        claim,
        claimsDir: ctx?.claimsDir,
        key: claim?.claim_key ?? ctx?.key,
        uncleanRecord: ctx?.uncleanRecord,
        env: ctx?.env,
        _inject: ctx?._inject,
      });
    }
    return executeSelectControl(target, {
      endpointId: sc.endpoint,
      chatId: sc.chat,
      senderId: sc.sender,
      messageId: sc.message,
      env: ctx?.env,
      _inject: ctx?._inject,
    });
  }
  if (kind === "mode") return onMode(typeof target === "string" ? target : target.mode);
  return { ok: false, reason: "unknown_control_kind", why: "未知控制命令类型（" + String(kind) + "）" };
}

/**
 * control-committed-unclean 专用恢复路径（§8.1/R57b P1-4）：
 * 重读账本核已提交 → 只做清理/释放收尾 → 转 consumed；核不出 → 保持并点名。
 */
export function repairControlCommittedUnclean({ claim, claimsDir, key, uncleanRecord, env = process.env, _inject = undefined } = {}) {
  const vCtx = verifySelectionContext(claim);
  if (!vCtx.ok) return { ok: false, reason: vCtx.reason, why: vCtx.why };
  const sc = vCtx.context;

  const d = resolveEndpointDir(sc.endpoint, { env });
  if (!d.ok) return { ok: false, reason: "endpoint_dir_unresolvable", why: d.why };

  // 1. 重读账本核已提交
  const L = loadLedger(d.dir, { endpointId: sc.endpoint });
  if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: L.why ?? L.reason };

  const priorOp = Object.values(L.doc.operations).find((op) =>
    op.op_type === "owner_select_reaffirm" && (
      op.request_key === "osr:" + op.result?.target_id + ":" + sc.handle ||
      (typeof op.request_key === "string" && op.request_key.endsWith(":" + sc.handle)) ||
      op.result?.new_link_proof?.selection_handle === sc.handle
    )
  );

  if (!priorOp) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "账本中核不出 handle " + sc.handle + " 的提交记录，保持 control-committed-unclean" };
  }

  // 2. 只做清理/释放收尾
  const cl = cleanReaffirmIntent({ endpointDir: d.dir, reaffirmHandle: sc.handle, env, _inject });
  if (!cl.ok) {
    return { ok: false, reason: cl.reason ?? "intent_cleanup_failed", why: cl.why ?? "清理 intent 失败，保持可恢复" };
  }

  return { ok: true, changed: true };
}

export { expectationFromMapping, claudeControlPrecondition as controlRepairPrecondition } from "./control-identity.mjs";

/** 当前项目里、这张 claim 所属的精确绑定（claim 带会话定位就选会话级，否则项目级）的身份期望。 */
export function claudeClaimExpectation({ root, claudeSessionId = null, registryFile, templateFile }) {
  const resolved = resolveProject({ root, claudeSessionId, registryFile, templateFile });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, expect: expectationFromMapping(resolved.mapping, { root }) };
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
  if (parsed.apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）
  if (parsed.apply && (RESUMABLE_CONTROL_STATES.includes(seen.state) || seen.state === "consumed")) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, expect,
      execute: (target, ctx) => dispatchControlRepair(target, {
        onMode: (mode) => setClaudeInteractionMode({ root, claudeSessionId: expect.claudeSessionId, mode,
          precondition: claudeControlPrecondition({ claimsDir, key: parsed.key, root }) }),
      }, ctx) });
  }
  // 不是控制命令的 claim 也可能是收边的拒绝（第 3 层）：同一个入口，另一套事务。
  if (seen.state === "not_control") {
    const rj = inspectRejectedClaim({ claimsDir, key: parsed.key, expect });
    if (rj.state !== "not_rejected_control") {
      const rr = parsed.apply && (RESUMABLE_REJECT_STATES.includes(rj.state) || rj.state === "rejected") ? resumeRejectedClaim({ claimsDir, key: parsed.key, expect }) : null;
      process.stdout.write(describeRejectRepair({ seen: rj, result: rr, apply: parsed.apply }) + "\n");
      process.exit(rejectRepairExitCode({ seen: rj, result: rr, apply: parsed.apply }));
    }
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
