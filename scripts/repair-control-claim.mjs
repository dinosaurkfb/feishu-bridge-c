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
import { resolveEndpointDir, loadLedger, ownerSelectReaffirmRequestKey, ID_SHAPE, OM_SHAPE } from "./topic-agent-ledger.mjs";
import { cleanReaffirmIntent, foldLockReleaseState } from "./maintenance/reaffirm-intents.mjs";
import { acquireOrderLock, requestKeyFor } from "./m1a/dual-write.mjs";
import { readSelectionPlan, recoverSelectionPlanTmp } from "./selection-plan.mjs";

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
      eventSessionId: sc.session ?? null,
      txCtx: ctx && ctx.claimsDir && ctx.key ? { claimsDir: ctx.claimsDir, key: ctx.key, claim: ctx.claim ?? null } : null,
      env: ctx?.env,
      _inject: ctx?._inject,
      // R57b 返修六 P1-1：in-flight repair 调执行器也要透传 plan 上下文（缺 → 结构化拒，不进账本）。
      claimsDir: ctx?.claimsDir,
      key: claim?.claim_key ?? ctx?.key,
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
  // R57d 返修一 B 段 P1-7：kind 判别 —— rfh 走 intent 清理收尾；osh/orh 走「按 selection plan 核账本提交」收尾
  //   （目标已消费，不重执行；核得出提交 → 转 consumed 交事务层闭合，核不出 → 保持并点名）。
  const vCtx = verifySelectionContext(claim);
  if (!vCtx.ok) return { ok: false, reason: vCtx.reason, why: vCtx.why };
  const sc = vCtx.context;
  if (sc.kind !== "rfh") {
    const d0 = resolveEndpointDir(sc.endpoint, { env });
    if (!d0.ok) return { ok: false, reason: "endpoint_dir_unresolvable", why: d0.why };
    const L0 = loadLedger(d0.dir, { endpointId: sc.endpoint });
    if (!L0.ok) return { ok: false, reason: "ledger_unreadable", why: L0.why ?? L0.reason };
    const plan = claim?.selection_plan;
    if (!plan || typeof plan !== "object" || typeof plan.target_id !== "string" || typeof plan.action !== "string") {
      return { ok: false, reason: "selection_plan_missing", why: "claim 里没有可复核的 selection plan（旧形 unclean），保持 control-committed-unclean" };
    }
    const opType = plan.action === "rebind" ? "rebind_session_alias" : plan.action;
    const wantKey = requestKeyFor({ opType, externalRequestId: sc.message, entityId: plan.target_id });
    if (!wantKey.ok) return { ok: false, reason: "select_plan_invalid", why: wantKey.why ?? "request key 派生失败" };
    const op = Object.values(L0.doc.operations).find((o) => o.op_type === opType && o.request_key === wantKey.request_key);
    if (!op || !op.result || typeof op.result_revision !== "number") {
      return { ok: false, reason: "ledger_commit_unverifiable", why: "账本中核不出 " + opType + "（" + plan.target_id + "）的提交记录，保持 control-committed-unclean" };
    }
    return { ok: true, changed: true };
  }

  // R57b 返修三 P1-4a：repair 同样走 outer → intent 锁序（同 P1-2 签发/消费纪律）。
  //   顶层取 instance-bound outer（m1a-order lock），内层持 outer 的受验 capability。
  //   两层释放都干净才闭合；outer 取不到/残骸/释放失败 → 非绿、保持 committed-unclean 点名。
  const acq = acquireOrderLock(sc.endpoint, env);
  if (!acq.ok) {
    return { ok: false, reason: acq.reason ?? "outer_lock_unavailable", why: "repair 外层排序锁取不到（" + (acq.why ?? acq.reason ?? "?") + "），保持 control-committed-unclean", lock_state: "unclear" };
  }
  let innerRes;
  let outerRel;
  try {
    innerRes = repairControlCommittedUncleanInner({ claim, claimsDir, key, uncleanRecord, env, _inject, sc });
  } finally {
    try { outerRel = acq.release(); } catch (err) { outerRel = { ok: false, reason: "release_exception", why: String(err?.code ?? err?.message ?? err) }; }
  }
  // 联合 outer / intent 两层释放结果：任一 residue/unclear → 非绿。
  const outerLockState = foldLockReleaseState(outerRel);
  const intentLockState = innerRes?.lock_state ?? "released";
  if (outerLockState !== "released" || intentLockState !== "released") {
    const reason = outerLockState !== "released" ? "repair_outer_lock_release_unclean" : (innerRes?.reason ?? "intent_cleanup_unclean");
    return {
      ...innerRes,
      ok: false,
      reason,
      why: "repair 收口两侧锁释放不干净（outer=" + outerLockState + ", intent=" + intentLockState + "）：" + (innerRes?.why ?? ""),
      locks: { outer: outerLockState, intent: intentLockState },
      lockUncleared: {
        outer: outerLockState !== "released" ? { reason: outerRel?.reason ?? "outer_lock_release", why: outerRel?.why ?? null, path: outerRel?.path ?? null } : null,
        intent: innerRes?.lockUncleared ?? null,
      },
    };
  }
  return innerRes;
}

function repairControlCommittedUncleanInner({ claim, claimsDir, key, uncleanRecord, env = process.env, _inject = undefined, sc = undefined } = {}) {
  // sc 由外层 repairControlCommittedUnclean 验证后传入；这里不再重复 verifySelectionContext。
  const d = resolveEndpointDir(sc.endpoint, { env });
  if (!d.ok) return { ok: false, reason: "endpoint_dir_unresolvable", why: d.why };

  // 1. 重读账本核已提交
  const L = loadLedger(d.dir, { endpointId: sc.endpoint });
  if (!L.ok) return { ok: false, reason: "ledger_unreadable", why: L.why ?? L.reason };

  // P1-4b：逐字绑定本 claim 对应的唯一 op——两字段（target_id / selection_message_id）**必须在场**且与
  //   claim / intent **逐字一致**；不再降级（缺席不核 / 在场不比）。缺失或不等 → ledger_commit_unverifiable。
  //   且 request_key 与写入侧共用同一派生函数（P2）。
  //   注：recordClaimState 把 detail 铺平到记录顶层（state/claim_key/recorded_at 并列），result 在记录顶层。
  const unResult = uncleanRecord?.result;
  const unTarget = unResult?.target_id;
  const unMessage = unResult?.selection_message_id;
  if (typeof unTarget !== "string" || !ID_SHAPE.test(unTarget) || typeof unMessage !== "string" || !OM_SHAPE.test(unMessage)) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "uncleanRecord.result 缺 target_id/selection_message_id（均须在场且合法），保持 control-committed-unclean" };
  }
  if (unMessage !== sc.message) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection_message_id 与 claim 的 message 不一致，保持 control-committed-unclean" };
  }
  // P1-4b（续）：核 selection plan 的 target_id——plan 必须在场，且 plan / unclean / 账本 operation 三者
  //   target_id 逐字一致。R57b 返修五：真实 claim 写方把 plan 落盘到 claims/<key>.selection-plan.json（不再
  //   依赖手工拼的 claim.selection_plan）；repair 从盘读回。plan 缺席或任一不等 → ledger_commit_unverifiable。
  // 规则 5：repair 是持锁入口——读 plan 前先调受验恢复（unlink「link 后未 unlink」tmp）；恢复不了（residue）→ 非绿。
  const rec = recoverSelectionPlanTmp({ claimsDir, key });
  if (rec && rec.ok === false) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan tmp 残骸待人工（" + (rec.why ?? "?") + "）" };
  }
  const planRead = readSelectionPlan({ claimsDir, key });
  if (!planRead.ok) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan 读不出（" + (planRead.problem ?? "?") + "），保持 control-committed-unclean" };
  }
  if (planRead.absent) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan 缺席（真实 claim 写方应已落盘），保持 control-committed-unclean" };
  }
  const planTarget = planRead.plan?.target_id;
  if (typeof planTarget !== "string" || !ID_SHAPE.test(planTarget)) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.target_id 缺席/不合法（须在场且 ta_ 形状），保持 control-committed-unclean" };
  }
  if (planTarget !== unTarget) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.target_id（" + planTarget + "）与 uncleanRecord.result.target_id（" + unTarget + "）不一致，保持 control-committed-unclean" };
  }
  // P1-2（续）：repair 也比对 plan.handle === claim.handle 与 plan.kind === claim.kind（不全只比 target）。
  if (planRead.plan?.handle !== sc.handle) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.handle 与 claim.handle 不一致，保持 control-committed-unclean" };
  }
  if (planRead.plan?.kind !== sc.kind) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "selection plan.kind 与 claim.kind 不一致，保持 control-committed-unclean" };
  }
  // 精确绑定的 request_key 与写入侧共用同一派生函数（P2）；不再保留本地字面拼接。
  const matches = Object.values(L.doc.operations).filter((op) =>
    op.op_type === "owner_select_reaffirm" &&
    op.result && typeof op.result.target_id === "string" &&
    op.request_key === ownerSelectReaffirmRequestKey({ target: op.result.target_id, handle: sc.handle }) &&
    op.result.target_id === unTarget &&
    op.result.selection_message_id === unMessage
  );
  if (matches.length !== 1) {
    return { ok: false, reason: "ledger_commit_unverifiable", why: "账本中核不出 handle " + sc.handle + " 的唯一提交记录（命中 " + matches.length + " 笔），保持 control-committed-unclean" };
  }
  const priorOp = matches[0];

  // 2. 只做清理/释放收尾
  const cl = cleanReaffirmIntent({ endpointDir: d.dir, reaffirmHandle: sc.handle, env, _inject });
  // P1-4：cleanReaffirmIntent 可返回 ok:true 但 lock_state: residue | unclear（intent 锁释放不净）；
  //   repair 不能只看 cl.ok 就转 consumed——要求清理提交 + 锁释放全部干净才转，否则保持 committed-unclean 并点名。
  const cleanupClean = cl.ok && cl.lock_state === "released" && !cl.lockUncleared && !cl.lockResidue;
  if (!cleanupClean) {
    return {
      ok: false,
      reason: cl.reason ?? "intent_cleanup_unclean",
      why: cl.why ?? ("清理 intent 收口不干净（ok=" + String(cl.ok) + "，lock_state=" + String(cl.lock_state ?? "?") + "），保持 control-committed-unclean"),
      lock_state: cl.lock_state ?? null,
    };
  }

  return { ok: true, changed: true, lock_state: "released" };
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
