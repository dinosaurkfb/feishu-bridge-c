#!/usr/bin/env node
/** 为当前 Claude binding 创建下一话题代际。默认只预览，--apply 才写状态并调用飞书。 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
} from "./bind-compose.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import {
  closeClaudeTopicRotation, failClaudeTopicRotation, loadClaudeTopicBinding, prepareClaudeTopicRotation,
  registerClaudeTopicRotation,
} from "./topic-generation-store.mjs";
import { m1aWriteRoute, wireRotate, wireVoid, wireRotateRecovery, wireRotateAuthoritative, wireVoidAuthoritative } from "./m1a/wiring.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import { loadByEndpoint, resolveLiveId } from "./topic-agent-ledger.mjs";
import { requestKeyFor } from "./m1a/dual-write.mjs";
import {
  ROTATION_STATUS, TOPIC_GENERATION_PREPARING_STALE_MS, activeGeneration, pendingGeneration, TOPIC_GENERATION_AUTO_ROTATE_MESSAGES, pendingRotationBlocker,
} from "./topic-generation.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (message) => { console.error(message); process.exit(1); };
// P1-6（#R37 返修）：shadow 步、或 outer 释放失败 → 把完整步结果/残留写进机器回执（JSON 到 stderr），再 CLI 非零。
// 绝不在此之后说“双写完成/新话题已进入 pending”。
const emitMachineReceipt = (kind, payload) => {
  console.error(JSON.stringify({
    schema_version: "1.0",
    artifact_type: "feishu_bridge_rotate_receipt",
    classification: "internal",
    recorded_at: new Date().toISOString(),
    kind,
    ...payload,
  }, null, 2));
};
const shadowFailed = (wired) => (wired.shadow ?? []).filter((s) => !s.ok);
const releaseFailed = (wired) => wired.release && wired.release.ok !== true;
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
const cancel = process.argv.includes("--cancel");
const automatic = process.argv.includes("--automatic");
const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = arg("claude-session-id") ??
  process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

let current = loadClaudeTopicBinding({ root, claudeSessionId });
if (!current.ok || !current.config) die("当前 Claude binding 不可轮转（" + (current.reason ?? "config_unusable") + "）");
const active = activeGeneration(current.state);
if (!active) die("当前 binding 没有 active generation，不能开始轮转。");
const pending = pendingGeneration(current.state);
if (cancel) {
  if (!pending || !current.state.rotation?.operation_id) die("当前没有等待认领的话题代际可取消。");
  console.log("绑定      " + (current.config.task_display_name ?? path.basename(root)));
  console.log("保留代际  " + active.generation + "（继续 active）");
  console.log("取消代际  " + pending.generation + "（话题历史保留，不再接受认领）");
  if (!apply) {
    console.log("\n[dry-run] 没有修改状态。加 --cancel --apply 才取消待认领代际。");
    process.exit(0);
  }
  const rotationOpId = current.state.rotation.operation_id;
  const cancelEndpointId = legacyEndpointId({ runtime: "claude", agentUid: current.config.agent_uid });
  // PK2-W2：authoritative → 走 `wireVoidAuthoritative`（账本 void → 删待认领条目 → 代际索引，账本先于索引）；
  //   shadow / 未接入 → 原路径一字未改。
  if (m1aWriteRoute({ endpointId: cancelEndpointId, env: process.env }).mode === "authoritative") {
    const wiredVoidA = wireVoidAuthoritative({
      endpointId: cancelEndpointId, env: process.env, operationId: rotationOpId,
      locator: pending.root_message_id, reason: "manual",
      publishIndex: () => closeClaudeTopicRotation({ root, claudeSessionId, operationId: rotationOpId, reason: ROTATION_STATUS.CANCELLED }),
    });
    if (!wiredVoidA.ok) {
      die("取消轮转中止（M1a 权威写方拒：" + (wiredVoidA.reason ?? "m1a_reject") + (wiredVoidA.why ? "；" + wiredVoidA.why : "") + "）。旧代际保持 active、待认领代际未被作废。");
    }
    if (wiredVoidA.legacy?.ok !== true) {
      emitMachineReceipt("rotate-cancel-unclean", { status: "unclean", operationId: rotationOpId, binding_id: current.state.binding_id,
        commit: wiredVoidA.commit ?? null, phase: wiredVoidA.legacy?.phase ?? null, reason: wiredVoidA.legacy?.reason ?? null,
        steps: (wiredVoidA.shadow ?? []).map((s) => ({ op: s.op, ok: s.ok ?? false, reason: s.reason ?? null, why: s.why ?? null })),
        release: wiredVoidA.release ?? null });
      die("取消轮转没落完（停在第 " + String(wiredVoidA.legacy?.phase ?? "?") + " 步：" + String(wiredVoidA.legacy?.message ?? wiredVoidA.legacy?.reason ?? "")
        + "）。账本可能已提交：同一条命令重跑会按同一 request key 续做后缀（不重复作废）。");
    }
    const relFailA = releaseFailed(wiredVoidA);
    if (relFailA) {
      emitMachineReceipt("rotate-cancel-unclean", { status: "unclean", operationId: rotationOpId, binding_id: current.state.binding_id,
        legacy_committed: true, release: wiredVoidA.release ?? null });
      die("取消轮转已提交，但 outer 锁释放失败（" + wiredVoidA.release.reason + "）。详情见上方机器回执；先 doctor。");
    }
    console.log("已取消待认领代际；旧话题仍是唯一 active，未删除任何飞书历史。");
    process.exit(0);
  }
  // M1a 双写（W5，Frank 拍板）：cancel → void 镜像（ledger voidPending），reason 映射 cancelled→"manual"（枚举不扩）。
  // 目标由 resolver 按 pending 根消息 om 命中；resolver 未命中（如 legacy-only、无 B1）→ shadow fail-closed、legacy 照常取消。
  const wiredVoid = wireVoid({
    endpointId: legacyEndpointId({ runtime: "claude", agentUid: current.config.agent_uid }),
    env: process.env,
    rotationOpId,
    locator: pending.root_message_id,
    reason: "manual",
    legacy: () => closeClaudeTopicRotation({ root, claudeSessionId, operationId: rotationOpId, reason: ROTATION_STATUS.CANCELLED }),
  });
  if (!wiredVoid.ok) {
    if (wiredVoid.reason === "legacy_failed") die("取消轮转失败：" + (wiredVoid.why ?? "legacy 异常"));
    die("取消轮转中止（M1a 一致性锁取不到：" + (wiredVoid.reason ?? "m1a_reject") + (wiredVoid.why ? "；" + wiredVoid.why : "") + "）。旧代际保持 active。");
  }
  const closed = wiredVoid.legacy;
  if (!closed.ok) die("取消轮转失败（" + closed.reason + "）。");
  // P1-6（#R37 返修 ⑤）：cancel 的 shadow void 失败、或 outer 释放失败 → 机器回执 + CLI 非零。
  // legacy 已取消；但不在此宣告“双写完成”——作废镜像缺了，缺口留给 doctor/repair。
  {
    const failed = shadowFailed(wiredVoid);
    const relFail = releaseFailed(wiredVoid);
    if (failed.length > 0 || relFail) {
      emitMachineReceipt("rotate-cancel-shadow-failed", {
        status: "shadow_failed",
        operationId: rotationOpId,
        binding_id: current.state.binding_id,
        legacy_committed: true,
        shadow: (wiredVoid.shadow ?? []).map((s) => ({ op: s.op, ok: s.ok ?? false, reason: s.reason ?? null, why: s.why ?? null })),
        release: wiredVoid.release ?? null,
      });
      die("取消轮转 legacy 已成功（待认领代际作废），但 M1a shadow 未完整镜像（" +
        (failed.length ? "失败步 " + failed.map((s) => "`" + s.op + "`" + (s.reason ? "（" + s.reason + "）" : "")).join("，") : "") +
        (relFail ? (failed.length ? "；" : "") + "outer 锁释放失败（" + wiredVoid.release.reason + "）" : "") +
        "）。详情见上方机器回执；未断言双写完成，缺口留 doctor/repair。");
    }
  }
  console.log("已取消待认领代际；旧话题仍是唯一 active，未删除任何飞书历史。");
  process.exit(0);
}
const blocker = pendingRotationBlocker(current.state);
// PK2-W2 **半笔续跑**：已有 pending 代际、而它正是**本笔自己**那一轮留下的（rotation.operation_id 还在）——
//   那是"索引已提交、sidecar 还没写"那半笔：同一条命令重跑必须能补齐后缀，而不是被"不能重复创建"挡住。
//   判据全在权威事实里（账本里同 request key 的 create_b1 已提交）+ 索引里那次轮转的操作号。
const w2ResumeIntent = (() => {
  if (blocker.kind !== "blocked" || !blocker.pending) return null;
  const rot = current.state.rotation;
  if (!rot || typeof rot.operation_id !== "string" || rot.operation_id.length === 0) return null;
  const ep0 = legacyEndpointId({ runtime: "claude", agentUid: current.config.agent_uid });
  if (m1aWriteRoute({ endpointId: ep0, env: process.env }).mode !== "authoritative") return null;
  const led = loadByEndpoint(ep0, { env: process.env });
  if (!led.ok) return null;
  const resolved = resolveLiveId({ endpointId: ep0, locator: blocker.pending.root_message_id, env: process.env });
  if (!resolved.ok) return null;
  const rec = led.doc.records?.[resolved.id];
  const lin = rec?.generation_lineage_id;
  const k = typeof lin === "string" ? requestKeyFor({ opType: "create_b1", externalRequestId: rot.operation_id, entityId: lin }) : null;
  const own = k?.ok === true && Object.values(led.doc.operations ?? {}).some((op) => op?.request_key === k.request_key);
  return own ? { opId: rot.operation_id, generation: blocker.pending.generation, rootOm: blocker.pending.root_message_id,
    token: blocker.pending.pending_token, claimExpiresAt: blocker.pending.claim_expires_at ?? null } : null;
})();
if (w2ResumeIntent) {
  console.log("续跑      已经有一代待认领（第 " + w2ResumeIntent.generation + " 代）且那一笔就是本轮转留下的：补齐它的后缀（话题幂等、账本重放命中）");
}
if (blocker.kind === "blocked" && !w2ResumeIntent) {
  die("已有等待认领的话题代际（第 " + blocker.pending.generation + " 代" + (blocker.deadline ? "，认领截止 " + blocker.deadline : "，不过期") +
    "）；去新话题 @ 完成认领，或 --cancel --apply 显式取消，不能重复创建。");
}
if (blocker.kind === "expired") {
  // 过期的待认领代际不再挡路：--apply 时在同一笔锁内退休它 + 准备 + 冻结下一代编号（话题历史保留），不用再单独取消一次
  console.log("过期代际  第 " + blocker.pending.generation + " 代（认领截止 " + blocker.deadline + " 已过）：本次在同一笔锁内作废它并建下一代，话题历史保留");
}
const name = current.config.task_display_name ?? path.basename(root);
const automaticThreshold = active.activity?.auto_rotate_threshold ?? TOPIC_GENERATION_AUTO_ROTATE_MESSAGES;
// 根消息与 token 只能用**锁内冻结**的下一代编号生成；dry-run 用当前状态算一个预告值
const plan = (nextNumber) => ({
  nextNumber,
  token: bindingToken(current.state.binding_id + "\n" + nextNumber),
  rootText: composeRootMessage({
    name,
    heading: name + " · 第 " + nextNumber + " 代",
    purpose: automatic
      ? "当前代际已达到 " + automaticThreshold + " 条有效业务消息；这是同一长期任务的下一话题代际，旧话题保留为只读历史。"
      : "同一长期任务的新话题代际；旧话题保留为只读历史。",
    root,
    token: bindingToken(current.state.binding_id + "\n" + nextNumber),
  }),
});
const statusText = composeStatusMessage({ name });
const expectedNext = Math.max(...current.state.generations.map((generation) => generation.generation)) + 1;

console.log("绑定      " + name);
console.log("当前代际  " + active.generation);
console.log("新代际    " + expectedNext + "（" +
  (automatic ? "自动阈值触发；" : "") + "等待首次真实 mention 后才切换；编号以 --apply 时锁内冻结的为准）");
console.log("\n--- 新根消息 ---\n" + plan(expectedNext).rootText);
if (!apply) {
  console.log("\n[dry-run] 没有创建话题或修改状态。加 --apply 才执行两阶段轮转。");
  process.exit(0);
}

const operationId = "rotation_" + randomUUID();
const identity = resolveLarkIdentity(current.config);
// authoritative 分派时会用**复用或新建**的操作号（见下）；shadow 分支恒用这一次新铸的 `operationId`（行为不变）。
const authOpId = (() => {
  const rot = current.state.rotation;
  const frozen = rot && typeof rot.operation_id === "string" && rot.operation_id.length > 0 &&
    (rot.status === ROTATION_STATUS.PREPARING || rot.status === ROTATION_STATUS.FAILED) ? rot.operation_id : null;
  return frozen ?? operationId;
})();

// M1a 双写（W3，Frank 拍板）：外层一致性锁在 sendToChat 之前取 —— 取不到 → 话题从未创建、无孤儿。
// 「准备 + 建话题 + 登记 pending」是同一 legacy 闭包，锁覆盖整笔写事务；shadow create_b1 在锁内镜像。
const ep = legacyEndpointId({ runtime: "claude", agentUid: current.config.agent_uid });
// PK2-W2：判源分派 —— authoritative 走 `wireRotateAuthoritative`（账本先于业务索引），
//   shadow / 未接入走原来的 `wireRotate`（一字未改）。
const effOpId = w2ResumeIntent ? w2ResumeIntent.opId : authOpId;
const writeRoute = m1aWriteRoute({ endpointId: ep, env: process.env });
const wired = writeRoute.mode === "authoritative"
  ? wireRotateAuthoritative({
      endpointId: ep,
      env: process.env,
      // 裁定 P1-1：持久 intent = 现有 PREPARING（发话题前冻结 operation id / 代数）。
      //   上一轮留下的 preparing / failed 且操作号还在 → **复用同一个号**（重跑续做，不新建意图、话题幂等键也不变）。
      operationId: w2ResumeIntent ? w2ResumeIntent.opId : effOpId,
      locator: w2ResumeIntent ? w2ResumeIntent.rootOm : active.root_message_id,
      chatId: current.config.chat_id,
      // P1-3：supersede / freeze 收成**一份**两相实现 —— `phase:"inspect"` 只读（零写，回报过期那条能不能退休），
      //   `phase:"freeze"` 才持久化 PREPARING。判据（账本 pending / 登记表严格读）在调用方过完之后才走到 freeze 相。
      supersede: ({ operationId: opId, phase }) => {
        const st = loadClaudeTopicBinding({ root, claudeSessionId });
        if (!st.ok) return { ok: false, reason: "state_unreadable", why: "锁内读不到话题状态：" + String(st.reason ?? "unknown") };
        const rot = st.state?.rotation ?? null;
        const nextOf = (state) => Math.max(...state.generations.map((g) => g.generation)) + 1;
        if (w2ResumeIntent && opId === w2ResumeIntent.opId) {
          return { ok: true, nextNumber: w2ResumeIntent.generation, token: w2ResumeIntent.token,
            claimExpiresAt: w2ResumeIntent.claimExpiresAt, reused: true, superseded: null };
        }
        const mine = rot && rot.operation_id === opId && (rot.status === ROTATION_STATUS.PREPARING || rot.status === ROTATION_STATUS.FAILED);
        if (phase === "inspect") {
          // 只读：这里只回答"那条过期 pending 能不能在本笔里退休"（未过期 / 别人的 pending → null，交给账本侧判）
          const blk = pendingRotationBlocker(st.state);
          const sup = blk.kind === "expired" ? { opId: rot?.operation_id ?? null, rootOm: blk.pending?.root_message_id ?? null, generation: blk.pending?.generation ?? null } : null;
          return { ok: true, superseded: sup, nextNumber: mine ? nextOf(st.state) : null };
        }
        if (mine) {
          const n = nextOf(st.state);
          return { ok: true, nextNumber: n, token: bindingToken(st.state.binding_id + "\n" + n), claimExpiresAt: null, reused: true, superseded: null };
        }
        const prepared = prepareClaudeTopicRotation({ root, claudeSessionId, operationId: opId, supersedeExpired: true });
        if (!prepared.ok) {
          return { ok: false, why: "锁内冻结 PREPARING 失败（" + String(prepared.reason) + "）",
            reason: prepared.reason === "rotation_already_pending" ? "rotation_pending_exists" : prepared.reason };
        }
        if (prepared.superseded) console.log("已作废    第 " + prepared.superseded.generation + " 代（过期的待认领代际）");
        const n = prepared.nextGeneration;
        return { ok: true, nextNumber: n, token: bindingToken(st.state.binding_id + "\n" + n), claimExpiresAt: null, reused: false,
          superseded: prepared.superseded === null || prepared.superseded === undefined ? null
            : { opId: rot?.operation_id ?? null, rootOm: prepared.superseded.root_message_id ?? null, generation: prepared.superseded.generation ?? null } };
      },
      createTopic: ({ nextNumber }) => {
        const { rootText } = plan(nextNumber);
        try {
          const om = sendToChat({
            profile: identity.profile, chatId: current.config.chat_id, text: rootText,
            idempotencyKey: idempotencyKeyFor(current.state.binding_id + "\nrotation\n" + nextNumber),
            larkBin: identity.bin, larkHome: identity.configDir, expectedAppId: identity.expectedAppId,
          });
          return { ok: true, root_message_id: om };
        } catch (err) { return { ok: false, reason: "send_failed", message: err.message }; }
      },
      publishIndex: ({ rootMessageId, pendingToken }) => {
        // 幂等（半笔续跑）：这一代**已经登记**且就是本笔（同操作号 / 同根消息 / 同 token）→ 零写返回，
        //   不再走 register（那个状态机只接受 PREPARING，已 awaiting_claim 会以 operation_mismatch 拒）。
        const st0 = loadClaudeTopicBinding({ root, claudeSessionId });
        const pend0 = st0.ok ? pendingGeneration(st0.state) : null;
        if (st0.ok && st0.state?.rotation?.operation_id === effOpId
            && pend0?.root_message_id === rootMessageId && pend0?.pending_token === pendingToken) {
          return { ok: true, count: pend0.generation ?? null, changed: false, already_registered: true };
        }
        const registered = registerClaudeTopicRotation({ root, claudeSessionId, operationId: effOpId, rootMessageId, pendingToken });
        if (registered.ok) return { ok: true, count: registered.generation?.generation ?? null };
        // 幂等：上一次跑到 index 之后才失败的极端情形 —— 已登记且就是本笔（同操作号 / 同根消息）→ 视为已生效
        if (registered.reason === "rotation_already_pending") {
          const st2 = loadClaudeTopicBinding({ root, claudeSessionId });
          const pend = st2.ok ? pendingGeneration(st2.state) : null;
          if (st2.ok && st2.state?.rotation?.operation_id === effOpId && pend?.root_message_id === rootMessageId && pend?.pending_token === pendingToken) {
            return { ok: true, count: pend.generation ?? null, changed: false };
          }
        }
        return { ok: false, reason: registered.reason ?? "register_failed", why: registered.error ?? registered.reason ?? null };
      },
    })
  : wireRotate({
      endpointId: ep,
  env: process.env,
  rotationOpId: operationId,
  lineageId: current.state.binding_id,
  chatId: current.config.chat_id,
  bindingTarget: { runtime: "claude", project_root: root, claude_session_id: claudeSessionId },
  rootOm: null, // 取 legacy 闭包返回的 root_message_id（sendToChat 产物）
  legacy: () => {
    // 一次锁内原子转换：过期 pending 退休 + PREPARING + 冻结编号；仍可认领的 pending 在这里也会被拒（rotation_already_pending）
    const prepared = prepareClaudeTopicRotation({ root, claudeSessionId, operationId, supersedeExpired: true });
    if (!prepared.ok) throw new Error("无法开始轮转（" + prepared.reason + "）。");
    if (prepared.superseded) console.log("已作废    第 " + prepared.superseded.generation + " 代（过期的待认领代际）");
    const { nextNumber, token, rootText } = plan(prepared.nextGeneration);
    if (nextNumber !== expectedNext) console.log("注意      锁内冻结的下一代是第 " + nextNumber + " 代（预告为第 " + expectedNext + " 代）：根消息按冻结的编号生成");
    let rootMessageId;
    try {
      rootMessageId = sendToChat({
        profile: identity.profile,
        chatId: current.config.chat_id,
        text: rootText,
        idempotencyKey: idempotencyKeyFor(current.state.binding_id + "\nrotation\n" + nextNumber),
        larkBin: identity.bin,
        larkHome: identity.configDir,
        expectedAppId: identity.expectedAppId,
      });
    } catch (err) {
      failClaudeTopicRotation({ root, claudeSessionId, operationId, reason: err.message });
      throw err;
    }
    const registered = registerClaudeTopicRotation({ root, claudeSessionId, operationId, rootMessageId, pendingToken: token });
    if (!registered.ok) {
      // **失败要收口，而且收口本身也可能失败。**
      const closed = failClaudeTopicRotation({ root, claudeSessionId, operationId, reason: registered.reason });
      throw new Error("新话题已创建，但 pending generation 登记失败（" + registered.reason + "）。" +
        (closed.ok
          ? "轮转已收口，旧代际仍保持 active；新建的那个话题需要人工清理。"
          : "**收口也失败了（" + closed.reason + "）**：轮转状态可能仍停在 preparing。" +
            "旧代际保持 active。若状态仍停在 preparing，" +
            Math.round(TOPIC_GENERATION_PREPARING_STALE_MS / 60000) +
            " 分钟后可由下一次轮转接管；若已进入 awaiting_claim，则去新话题真实 @ 完成认领。" +
            "新建的那个话题需要人工清理。"));
    }
    return { ...registered, root_message_id: rootMessageId, supersededRootOm: prepared.superseded?.root_message_id ?? null };
  },
});
if (!wired.ok) {
  if (wired.reason === "legacy_failed") die("轮转失败：" + (wired.why ?? "legacy 异常"));
  die("无法开始轮转（M1a 一致性锁取不到：" + (wired.reason ?? "m1a_reject") + (wired.why ? "；" + wired.why : "") + "）。旧代际保持 active，未创建新话题。");
}
// PK2-W2：authoritative 的分步结果收口 —— 账本先于索引，所以"账本已提交、后缀没做完"必须如实说清、非零退出；
//   同一条命令重跑按同一 request key / 同一冻结意图续做后缀（不新建话题、账本不重复记）。
if (writeRoute.mode === "authoritative") {
  const steps = (wired.shadow ?? []).map((s) => ({ op: s.op, ok: s.ok ?? false, reason: s.reason ?? null, why: s.why ?? null }));
  if (wired.legacy?.ok !== true) {
    emitMachineReceipt("rotate-unclean", { status: "unclean", operationId: effOpId, binding_id: current.state.binding_id,
      commit: wired.commit ?? null, phase: wired.legacy?.phase ?? null, reason: wired.legacy?.reason ?? null,
      root_message_id: wired.legacy?.root_message_id ?? null, steps, release: wired.release ?? null });
    die("轮转没落完（停在第 " + String(wired.legacy?.phase ?? "?") + " 步：" + String(wired.legacy?.message ?? wired.legacy?.reason ?? "")
      + "）。" + (wired.commit === "committed_unclean"
        ? "账本已提交：**同一条命令重跑**会按同一 request key 续做后缀（话题幂等、账本不重复记）。"
        : "账本未提交：同一条命令重跑会从同一冻结意图继续，已发出的新话题按幂等键复用。"));
  }
  if (wired.commit !== "committed_clean") {
    emitMachineReceipt("rotate-unclean", { status: "unclean", operationId: effOpId, binding_id: current.state.binding_id,
      commit: wired.commit ?? null, steps, release: wired.release ?? null, legacy_committed: true });
    console.error("注意      这一步有提交不干净（commit=" + String(wired.commit) + "）：已落机器回执，先 doctor 核对（轮转本身已完成）。");
  }
}
const rootMessageId = wired.legacy.root_message_id;

// #R37 P1-3①：legacy 已提交（新话题已登记、rootMessageId 到手）但 shadow 的 create_b1 缺失/失败 →
// **不直接拒**（旧行为 = reject、把缺口丢给 doctor/repair），而是调用 wireRotateRecovery 补 create_b1。
// 恢复在同一个 outer 锁内、create_b1 前重核 legacy 现场（P1-3②）：pending/operation-id/root 均已变 → 整笔拒、不略影像。
const createB1Missing = (wired.shadow ?? []).some((s) => s.op === "create_b1" && s.ok !== true);
let recovered = null;
// 清单封闭：authoritative 下不再需要"补 create_b1"（顺序已经是账本先行）——wireRotateRecovery 在 authoritative 仍拒。
if (writeRoute.mode !== "authoritative" && createB1Missing && wired.legacy && wired.legacy.root_message_id) {
  recovered = wireRotateRecovery({
    endpointId: ep,
    env: process.env,
    rotationOpId: operationId,
    lineageId: current.state.binding_id,
    chatId: current.config.chat_id,
    rootOm: rootMessageId,
    bindingTarget: { runtime: "claude", project_root: root, claude_session_id: claudeSessionId },
    now: Date.now(),
    verifyLegacy: () => {
      const st = loadClaudeTopicBinding({ root, claudeSessionId });
      if (!st.ok) return { ok: false, reason: "state_unreadable", why: st.reason ?? "无法重读话题状态" };
      const rot = st.state?.rotation;
      if (!rot || rot.operation_id !== operationId) return { ok: false, reason: "op_id_changed", why: "轮转操作号已变，不再补 create_b1" };
      if (rot.root_message_id !== rootMessageId) return { ok: false, reason: "root_changed", why: "轮转根消息已变，不再补 create_b1" };
      if (rot.status !== "preparing" && rot.status !== "awaiting_claim") return { ok: false, reason: "not_pending", why: "轮转不再 pending，跳过补 create_b1" };
      return { ok: true, root_message_id: rot.root_message_id };
    },
  });
  if (recovered.ok && recovered.legacy && recovered.legacy.ok === true) {
    const recFailed = shadowFailed(recovered);
    if (recFailed.length === 0) {
      console.log("已恢复    M1a shadow：补 write create_b1 后完整镜像（legacy 已提交）");
      wired.shadow = recovered.shadow;
    }
  }
}

// P1-6（#R37 返修 ⑤）：旧代际作废或新代际镜像任一 shadow 步失败、或 outer 释放失败 → 机器回执 + CLI 非零。
// 注意 legacy（轮转+新话题登记）已经成功；但绝不在此宣告“双写完成”，缺口留给 doctor/repair。
{
  const failed = shadowFailed(wired);
  const relFail = releaseFailed(wired);
  if (failed.length > 0 || relFail) {
    emitMachineReceipt("rotate-shadow-failed", {
      status: "shadow_failed",
      operationId,
      binding_id: current.state.binding_id,
      legacy_committed: true,
      root_message_id: rootMessageId,
      superseded_root_om: wired.legacy?.supersededRootOm ?? null,
      shadow: (wired.shadow ?? []).map((s) => ({ op: s.op, ok: s.ok ?? false, reason: s.reason ?? null, why: s.why ?? null })),
      release: wired.release ?? null,
    });
    die("轮转 legacy 已提交（新话题已登记），但 M1a shadow 未完整镜像（" +
      (failed.length ? "失败步 " + failed.map((s) => "`" + s.op + "`" + (s.reason ? "（" + s.reason + "）" : "")).join("，") : "") +
      (relFail ? (failed.length ? "；" : "") + "outer 锁释放失败（" + wired.release.reason + "）" : "") +
      "）。详情见上方机器回执；未断言双写完成，缺口留 doctor/repair。");
  }
}

try {
  publishDraft({
    profile: identity.profile,
    rootMessageId,
    text: statusText,
    larkBin: identity.bin,
    larkHome: identity.configDir,
    expectedAppId: identity.expectedAppId,
  });
} catch (err) {
  console.error("pending generation 已登记，但状态回复发送失败：" + err.message);
}
console.log("新话题已进入 pending。去新话题真实 @ M5Claude 后，将原子切换为 active；旧话题变为只读历史。");
