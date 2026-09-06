#!/usr/bin/env node
/** 可恢复地暂停当前精确 Codex thread 的飞书连接；不调用飞书 API。 */

import path from "node:path";
import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, findRegisteredTaskForCodexThread, setTaskConnectionStatus, loadCodexTemplate,
} from "./state.mjs";
import { wirePauseResume, emitUncleanReceipt } from "../m1a/wiring.mjs";
import { legacyEndpointId } from "../subscription.mjs";
import { requireIntent } from "./intent.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const threadId = arg("thread-id");
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
if (!validThreadId(threadId)) {
  console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
  process.exit(1);
}


const home = bridgeHome();

// **一次性意图凭证，在任何副作用之前消费。**
// 技能选择这一层不受钩子判据约束 —— agent 之间提一句命令就可能把它执行掉
// （出过真事故）。凭证把"技能被选中"和"这次操作被授权"分开。
//
// 位置必须在 home 定义之后、任何读写之前：home 现在是必填参数
//（凭证层上移到共用层时去掉了默认值 —— 共用代码不能反向依赖 codex 目录）。
const intent = requireIntent({ apply, action: "unbind", threadId, home });
if (!intent.ok) { console.error(intent.text); process.exit(1); }
const found = findRegisteredTaskForCodexThread({ threadId, home });
if (!found.ok) {
  if (found.reason === "thread_not_registered") {
    console.log("当前 Codex task 尚未接入飞书，无需撤销。");
    process.exit(0);
  }
  console.error("无法读取连接状态：" + found.reason);
  process.exit(1);
}
if ((found.task.status ?? "active") === "paused") {
  console.log("当前 Codex task 的飞书接入已经暂停。");
  process.exit(0);
}

console.log("将暂停当前 Codex task 的飞书入站、答复入队和发布资格。");
console.log("原飞书话题、历史回执和待发布答复都会保留，可再次接入恢复。");
console.log("本操作不会向飞书发送消息，也不会删除飞书话题。");
if (!apply) {
  console.log("\n[dry-run] 没有修改登记表。加 --apply 才执行暂停。");
  process.exit(0);
}

// #R37 返修（P1-2）：W4 行连接暂停 = 只取 m1a-order outer 锁、零 shadow；legacy 为既有 setTaskConnectionStatus。
// 收据现场可派生且未启用（never_initialized）→ 合法 legacy-only；已启用端点取锁失败 → 整笔拒、不写 legacy。
const tmpl = loadCodexTemplate();
const agentUid = tmpl?.template?.agent_uid ?? null;
const runPause = () => setTaskConnectionStatus({ threadId, status: "paused", home });
let changed;
let wired = null;
if (agentUid) {
  wired = wirePauseResume({
    endpointId: legacyEndpointId({ runtime: "codex", agentUid }),
    env: process.env,
    legacy: runPause,
  });
  if (!wired.ok) {
    console.error("暂停失败（M1a 一致性锁：" + wired.reason + (wired.why ? "；" + wired.why : "") + "）");
    process.exit(1);
  }
  changed = wired.legacy;
} else {
  // P1-2 ③：agent_uid 取不到 = 端点无法派生收据现场，静默回落 legacy 会绕开一致性锁（fail-closed）。
  console.error("无法确定 Codex 模板 agent_uid —— 不能派生 M1a 端点，拒绝绕过一致性锁（fail-closed）");
  process.exit(1);
}
if (!changed.ok) {
  console.error("暂停失败：" + changed.reason + (changed.error ? "（" + changed.error + "）" : ""));
  process.exit(1);
}
// #R37 P1-4：legacy 已暂停但镜像不干净（release 残骸/锁残骸）→ 机器回执，不谎报 clean。
if (wired) emitUncleanReceipt("cli_unbind_pause", wired, { threadId, receiptDir: path.join(bridgeHome(), "receipts") });
console.log("已暂停当前 Codex task 的飞书接入；原话题和本地历史均已保留。");
