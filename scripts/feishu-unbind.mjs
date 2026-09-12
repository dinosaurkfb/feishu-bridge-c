#!/usr/bin/env node
/**
 * 可恢复地暂停当前上下文的飞书接入。
 *
 * **绝不做的事**：删话题、删登记、删待发内容、删回执、往飞书发消息。
 * 暂停要能后悔 —— 话题里已经有历史对话，删掉登记会让那段历史变成孤儿；
 * 待发内容要是一起删了，用户会以为「暂停」顺手丢了他还没看到的东西。
 *
 * 实现上只翻一个已有的闸：绑定的 status。出站只发 active 的，入站见到非 active 直接拒 ——
 * 所以暂停不需要新机制，一个字段两个方向同时生效。
 *
 * 用法：node scripts/feishu-unbind.mjs [--project ~/x] [--apply]
 */

import path from "node:path";
import os from "node:os";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";

import {
  SUSPENDED, bindingsForRoot, currentBinding, describeStatus, setBindingStatus,
} from "./feishu-control.mjs";
import { loadClaudeTopicBinding } from "./topic-generation-store.mjs";
import { activeGeneration } from "./topic-generation.mjs";
import { m1aWriteRoute, wirePauseResume, wirePauseResumeAuthoritative, uncleanWired, emitUncleanReceipt } from "./m1a/wiring.mjs";
import { legacyEndpointId } from "./subscription.mjs";

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态

const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;

const st = currentBinding({ root, claudeSessionId });
if (!st.ok) {
  console.error(describeStatus(st));
  process.exit(1);
}
if (st.suspended) {
  console.log("已经是暂停状态了，没有重复操作。");
  console.log(describeStatus(st, bindingsForRoot({ root })));
  process.exit(0);
}

console.log("将暂停：" + (st.level === "session"
  ? "这条工作线（会话 " + String(st.claudeSessionId).slice(0, 8) + "）"
  : "整个项目 " + st.displayName));
console.log("");
console.log("暂停之后：");
console.log("  · 出站停发，进展**留在本地**（现有 " + st.pending + " 条），恢复后一并发出");
console.log("  · 入站一律拒绝，话题里发指令会收到明确的拒绝回执");
console.log("  · 话题、历史、登记、回执**全部保留**，不删任何东西，也不往飞书发消息");
console.log("  · 恢复：" + (st.level === "session"
  ? "在**这条工作线的会话里**跑 node scripts/bind-session.mjs --apply（复用原话题，不新建）"
  : "node scripts/bind-project.mjs --apply（复用原话题，不新建）"));

if (!apply) {
  console.log("\n[dry-run] 什么都没做。加 --apply 才真的暂停。");
  process.exit(0);
}

// #R37 返修（P1-2）：W4 行连接暂停 = 只取 m1a-order outer 锁、零 shadow；legacy 为既有 setBindingStatus。
const agentUid = loadClaudeTopicBinding({ root, claudeSessionId })?.config?.agent_uid ?? null;
const runPause = () => setBindingStatus({ root, claudeSessionId, status: SUSPENDED });
let r;
let wiredPause = null;
if (agentUid) {
  const pauseEndpoint = legacyEndpointId({ runtime: "claude", agentUid });
  // PK2-W3：authoritative → 走 `wirePauseResumeAuthoritative`（账本 unbind 先行 → 索引 paused）；
  //   shadow / 未接入 → 原路径一字未改。
  if (m1aWriteRoute({ endpointId: pauseEndpoint, env: process.env }).mode === "authoritative") {
    // locator：优先取**活跃代际的根消息**（与 rotate 同口径），否则退回 mapping / 登记行里的引用
    const stBind = loadClaudeTopicBinding({ root, claudeSessionId });
    const om = activeGeneration(stBind?.state)?.root_message_id
      ?? currentBinding({ root, claudeSessionId })?.mapping?.feishu_root_message_id_reference
      ?? currentBinding({ root, claudeSessionId })?.entry?.root_message_id ?? null;
    if (typeof om !== "string" || om.length === 0) {
      console.error("这条绑定没有根消息 locator（定位不到账本记录）：**不写**（先人工核对）。");
      process.exit(1);
    }
    const wiredAuth = wirePauseResumeAuthoritative({
      endpointId: pauseEndpoint, env: process.env, action: "pause", locator: om,
      publishIndex: () => setBindingStatus({ root, claudeSessionId, status: SUSPENDED }),
    });
    if (!wiredAuth.ok) {
      console.error("暂停中止（M1a 权威写方拒：" + (wiredAuth.reason ?? "m1a_reject") + (wiredAuth.why ? "；" + wiredAuth.why : "") + "）");
      process.exit(1);
    }
    // P1-4（W3-fix4）：**统一 unclean 投影**（与 W1 同一份）。账本与索引都 clean、而 `runAuthoritative.release`
    //   不净时，`commit` 仍是 committed_clean —— 旧写法（只在 commit!==clean / legacy 非 ok 时调）
    //   会一个回执都不留（成功退出且无痕迹）。prepare 就拒的那一支已经 exit（什么都没写，不算 unclean）。
    const pauseUnclean = uncleanWired(wiredAuth);
    if (!pauseUnclean.clean) emitUncleanReceipt("cli_unbind_pause", wiredAuth, { root, claudeSessionId, receiptDir: path.join(os.homedir(), ".claude", "feishu-bridge", "receipts") });
    if (wiredAuth.legacy?.ok !== true) {
      console.error("暂停没落完（停在第 " + String(wiredAuth.legacy?.phase ?? "?") + " 步：" + String(wiredAuth.legacy?.message ?? wiredAuth.legacy?.reason ?? "")
        + "）。账本可能已提交：**按当前 origin op 证明已提交后补索引**（同一条命令重跑，不重复记）。");
      process.exit(1);
    }
    if (wiredAuth.commit !== "committed_clean") {
      console.error("注意      这一步有提交不干净（commit=" + String(wiredAuth.commit) + "）：已落机器回执。");
    }
    // P1-4（W3-fix5）：不干净 = **不许绿退出、也不许说"已暂停"** —— 回执已经落了（上一拍），这里补一句
    //   "事实可能已提交、需 doctor 后重跑补齐"并**非零退出**（与 committed-unclean 的既有口径同一条）。
    if (!pauseUnclean.clean) {
      console.error("注意      这一次不干净（commit=" + String(wiredAuth.commit ?? "?") + (pauseUnclean.releaseUnclean ? "，排序锁没交还干净" : "")
        + "）：已落机器回执。**暂停的事实可能已经提交**（账本 unbind / 索引 paused 之一或两者已落地）——"
        + "先跑 doctor 核对，再按同一条命令重跑补齐（不重复记）。");
      process.exit(1);
    }
    console.log("\n已暂停（账本 unbind 先行，再改索引）。");
    console.log(describeStatus(currentBinding({ root, claudeSessionId }), bindingsForRoot({ root })));
    process.exit(0);
  }
  wiredPause = wirePauseResume({
    endpointId: legacyEndpointId({ runtime: "claude", agentUid }),
    env: process.env,
    legacy: runPause,
  });
  if (!wiredPause.ok) {
    console.error("暂停失败（M1a 一致性锁：" + wiredPause.reason + (wiredPause.why ? "；" + wiredPause.why : "") + "）");
    process.exit(1);
  }
  r = wiredPause.legacy;
} else {
  // P1-2 ③：agent_uid 取不到 = 端点无法派生收据现场，静默回落 legacy 会绕开一致性锁（fail-closed）。
  console.error("无法确定该 binding 的 agent_uid —— 不能派生 M1a 端点，拒绝绕过一致性锁（fail-closed）");
  process.exit(1);
}
if (!r.ok) {
  console.error("暂停失败（" + r.reason + "）" + (r.error ? "：" + r.error : ""));
  process.exit(1);
}
// #R37 P1-4：legacy 已暂停但镜像不干净（release 残骸/锁残骸）→ 机器回执，不谎报 clean。
if (wiredPause) emitUncleanReceipt("cli_unbind_pause", wiredPause, { root, claudeSessionId, receiptDir: path.join(os.homedir(), ".claude", "feishu-bridge", "receipts") });
console.log("\n已暂停。改动写在 " + r.store);
console.log(describeStatus(currentBinding({ root, claudeSessionId }), bindingsForRoot({ root })));
