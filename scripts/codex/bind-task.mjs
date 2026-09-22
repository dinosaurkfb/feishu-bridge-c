#!/usr/bin/env node
/** 把一个精确 Codex thread 建成独立飞书话题；同一项目允许多个 task。 */

import fs from "node:fs";
import path from "node:path";

import { resolveLarkIdentity } from "../chain-template.mjs";
import { publishDraft, sendToChat } from "../outbound.mjs";
import {
  composeCodexBinding, displayThread, resolveBindingTarget, resolveThreadId,
} from "./bind-compose.mjs";
import { resolveTargetCodexHome } from "./handoff.mjs";
import { updateTextMessage } from "./lark-message.mjs";
import {
  addTask, bridgeHome, codexHomeOf, findRegisteredTaskForCodexThread, loadCodexTemplate, makeTaskEntry, recordTaskCodexHome,
  refreshPendingTaskBinding, setTaskConnectionStatus, setTaskDisplayName,
} from "./state.mjs";
import { buildIntentParams, requireIntent } from "./intent.mjs";
import { wireBind, wirePauseResume, uncleanWired, emitUncleanReceipt } from "../m1a/wiring.mjs";
import { legacyEndpointId } from "../subscription.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";

// #266：绑定这一刻，目标 Codex 会话自己的 codex home（$feishu-bind 在目标会话里跑，这里的环境就是它的）。
//   与投递用同一个核实（resolveTargetCodexHome）：实际落点（realpath(3)）、不在运输会话临时目录下、装着这个 thread。
//   **核实不了就不建话题**（三轮 P1）——否则会建出一条投递必然失败的绑定。
function verifiedBindingCodexHome(threadId) {
  try {
    return { ok: true, home: resolveTargetCodexHome({ recorded: codexHomeOf({ env: process.env }), threadId }) };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
const root = path.resolve(arg("project") ?? process.cwd());
const die = (message) => { console.error(message); process.exit(1); };
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

const thread = resolveThreadId({ explicit: arg("thread-id"), root });
if (!thread.ok) die("无法确定当前 Codex thread（" + thread.reason + "），拒绝猜测或使用 --last。");

// **一次性意图凭证，在任何副作用之前消费。**
//
// 出过真事故：一条 agent 之间的消息里提到了这个命令，绑定技能就被选中、
// 直接来跑真实绑定。技能描述里写着"讨论和引用不得触发"，钩子的判据也是
// 整条精确匹配 —— **但技能选择这一层不受那条判据约束**。
// 凭证把"技能被选中"和"这次操作被授权"分开：只有人亲自输入完整命令时，
// 钩子才签发一张，用完即焚。
const intent = requireIntent({
  apply, action: "bind", threadId: thread.threadId,
  params: buildIntentParams("bind", { project: root, chat: arg("chat-id") ?? null,
    name: arg("name") ?? null }),
  home: bridgeHome() });
if (!intent.ok) die(intent.text);
const tpl = loadCodexTemplate();
const transportAgentName = tpl.ok ? (tpl.template?.transport_agent_name || "运输 agent") : "运输 agent";
const existing = findRegisteredTaskForCodexThread({ threadId: thread.threadId });
const homeCheck = verifiedBindingCodexHome(thread.threadId);
if (existing.ok && !Object.hasOwn(existing.task, "codex_home")) {
  // 旧绑定没记 codex home（#266 三轮 P1）：重跑绑定就是补记入口 —— 核实过才写，dry-run 只说会写什么。
  if (!homeCheck.ok) {
    console.log("注意：这条绑定没记 Codex 数据目录，当前会话的也核实不了（" + homeCheck.why + "）；飞书投递会退回默认目录并核实。");
  } else if (!apply) {
    console.log("[dry-run] 这条绑定没记 Codex 数据目录；加 --apply 会补记 " + homeCheck.home);
  } else {
    const recorded = recordTaskCodexHome({ threadId: thread.threadId, codexHome: homeCheck.home });
    if (!recorded.ok) die("补记 Codex 数据目录失败：" + recorded.reason + (recorded.error ? "（" + recorded.error + "）" : ""));
    console.log("已补记 Codex 数据目录：" + homeCheck.home);
  }
}
if (existing.ok) {
  if ((existing.task.status ?? "active") === "active") {
    const awaitingFirstMention = existing.task.inbound_state === "pending" && !existing.task.session_id;
    const d = composeCodexBinding({
      root: existing.task.root, threadId: thread.threadId, nameOverride: arg("name"),
      template: tpl.ok ? tpl.template : undefined,
    });
    if (awaitingFirstMention && !apply) {
      console.log("这个 Codex task 已建好原话题，但首次 mention 的握手窗口需要刷新。");
      console.log("[dry-run] 没有修改登记表，也没有发送或编辑飞书消息。加 --apply 才续期。");
      process.exit(0);
    }
    if (awaitingFirstMention) {
      const refreshed = refreshPendingTaskBinding({ threadId: thread.threadId });
      if (!refreshed.ok) die("刷新首次绑定窗口失败：" + refreshed.reason +
        (refreshed.error ? "（" + refreshed.error + "）" : ""));
      console.log("已复用原话题并刷新首次绑定窗口；请在该话题真实 @ " + transportAgentName + " 完成绑定。");
    }
    if (existing.task.task_display_name === d.name) {
      if (!awaitingFirstMention) {
        console.log("这个 Codex task 已接入，没有重复建话题：" + existing.task.task_display_name);
      }
      process.exit(0);
    }
    console.log("这个 Codex task 已接入；检测到旧话题名需要升级。");
    console.log("旧名称    " + existing.task.task_display_name);
    console.log("新名称    " + d.name);
    console.log("新首行    " + d.rootText.split("\n")[0]);
    if (!apply) {
      console.log("[dry-run] 没有编辑飞书消息，也没有修改登记表。加 --apply 才执行。");
      process.exit(0);
    }
    if (!tpl.ok) die("Codex 单智能体模板不可用（" + tpl.reason + "）");
    const identity = resolveLarkIdentity(tpl.template);
    try {
      updateTextMessage({
        profile: identity.profile,
        messageId: existing.task.root_message_id,
        text: d.rootText,
        larkBin: identity.bin,
        larkHome: identity.configDir,
        expectedAppId: identity.expectedAppId,
      });
    } catch (err) {
      if (awaitingFirstMention) {
        console.error("首次绑定窗口已刷新，但旧话题标题无法同步：" + err.message);
        console.error("这不影响在原话题完成首次 @" + transportAgentName + " 握手。");
        process.exit(0);
      }
      die("旧话题改名失败，登记表没有修改：" + err.message);
    }
    const renamed = setTaskDisplayName({ threadId: thread.threadId, name: d.name });
    if (!renamed.ok) {
      die("飞书话题已改名，但本地登记更新失败：" + renamed.reason +
        (renamed.error ? "（" + renamed.error + "）" : "") + "。可安全重跑本命令修复登记。");
    }
    console.log("已更新原飞书话题名称，没有创建第二个话题。");
    process.exit(0);
  }
  console.log("这个 Codex task 的飞书接入已暂停；恢复会复用原话题，不会向飞书发送消息。");
  if (!apply) {
    console.log("[dry-run] 没有修改登记表。加 --apply 才恢复接入。");
    process.exit(0);
  }
  // #R37 返修（P1-2）：W4 行连接恢复 = 只取 m1a-order outer 锁、零 shadow；legacy 为既有 setTaskConnectionStatus。
  const tpl0 = loadCodexTemplate();
  const agentUid = tpl0?.template?.agent_uid ?? null;
  const runResume = () => setTaskConnectionStatus({ threadId: thread.threadId, status: "active" });
  let resumed;
  let wiredResume = null;
  if (agentUid) {
    wiredResume = wirePauseResume({
      endpointId: legacyEndpointId({ runtime: "codex", agentUid }),
      env: process.env,
      legacy: runResume,
    });
    if (!wiredResume.ok) {
      die("恢复接入失败（M1a 一致性锁：" + wiredResume.reason + (wiredResume.why ? "；" + wiredResume.why : "") + "）");
    }
    resumed = wiredResume.legacy;
  } else {
    // P1-2 ③：agent_uid 取不到 = 端点无法派生收据现场，静默回落 legacy 会绕开一致性锁（fail-closed）。
    die("无法确定 Codex 模板 agent_uid —— 不能派生 M1a 端点，拒绝绕过一致性锁（fail-closed）");
  }
  if (!resumed.ok) die("恢复接入失败：" + resumed.reason + (resumed.error ? "（" + resumed.error + "）" : ""));
  // #R37 P1-4：legacy 已恢复但镜像不干净（release 残骸/锁残骸）→ 机器回执，不谎报 clean。
  if (wiredResume) emitUncleanReceipt("cli_bind_task_resume", wiredResume, { threadId: thread.threadId, receiptDir: path.join(bridgeHome(), "receipts") });
  console.log("已恢复当前 Codex task 的飞书接入，继续使用原话题。");
  process.exit(0);
}
if (!homeCheck.ok) die("核实不了目标 Codex 会话的数据目录，没有建话题：" + homeCheck.why);
if (!tpl.ok) die("Codex 单智能体模板不可用（" + tpl.reason + "）");
const target = resolveBindingTarget({
  template: tpl.template,
  chatId: arg("chat-id"),
  chatName: arg("chat-name"),
});
if (!target.ok) die("无法确定绑定目标群（" + target.reason + "）");
const d = composeCodexBinding({
  root,
  threadId: thread.threadId,
  nameOverride: arg("name"),
  idempotencyScope: target.overridden ? target.chatId : undefined,
  template: tpl.template,
});

console.log("任务      " + d.name + "  " + d.logicalTaskKey);
console.log("Codex     " + displayThread(thread.threadId));
console.log("群        " + target.chatName);
console.log("唯一身份  " + tpl.template.transport_agent_name);
console.log("\n--- 根消息 ---\n" + d.rootText);
console.log("\n--- 底下第一条 ---\n" + d.statusText);
if (!apply) {
  console.log("\n[dry-run] 没有发送，也没有写登记表。加 --apply 才真的执行。");
  process.exit(0);
}

const identity = resolveLarkIdentity(tpl.template);
// P2-2 wireBind（Frank 裁定）：codex 任务级绑定的 legacy 三步（建根话题 + 登记 + 发布状态回复）收进一个闭包，
//   已启用端点以 m1a-order 锁串行并镜像 shadow create_b1；未启用端点（never_initialized）→ 合法 legacy-only。
//   codex 允许多个 task / 项目，故 lineage 必须 per-task 唯一（prevent lineage_pending_exists 误拒）。
const bindTarget = { runtime: "codex", codex_task_id: d.logicalTaskKey, codex_thread_id: d.threadId, project_root: root };
const wired = wireBind({
  endpointId: legacyEndpointId({ runtime: "codex", agentUid: tpl.template.agent_uid }),
  env: process.env,
  externalRequestId: d.idempotencyKey,
  lineageId: d.logicalTaskKey + "@project-files",
  chatId: target.chatId,
  bindingTarget: bindTarget,
  legacy: () => {
    // ① 建根话题（幂等键）。失败 → 无任何副作用，返回 ok:false（wireBind 不跑 shadow）。
    let rootMessageId;
    try {
      rootMessageId = sendToChat({
        profile: identity.profile, chatId: target.chatId, text: d.rootText,
        idempotencyKey: d.idempotencyKey, larkBin: identity.bin, larkHome: identity.configDir,
        expectedAppId: identity.expectedAppId,
      });
    } catch (err) {
      return { ok: false, phase: "send", message: err.message };
    }
    // ② 登记（entry push + 原子写）。失败 → 话题已在群里，返回 ok:false（phase=registry，幂等键保重跑不重建）。
    const task = makeTaskEntry({
      root, threadId: thread.threadId, name: d.name, purpose: d.purpose, rootMessageId,
      token: d.token, inboundPrefix: tpl.template.inbound_prefix,
      chatId: target.chatId, chatName: target.chatName,
      codexHome: homeCheck.home,
    });
    const added = addTask(task);
    if (!added.ok) {
      return { ok: false, phase: "registry", root_message_id: rootMessageId, message: added.reason + (added.error ? "（" + added.error + "）" : "") };
    }
    // ③ 发布状态回复（best-effort：登记已完成，失败仅告警不断言失败）。
    try {
      publishDraft({ profile: identity.profile, rootMessageId, text: d.statusText, larkBin: identity.bin, larkHome: identity.configDir, expectedAppId: identity.expectedAppId });
    } catch (err) {
      console.error("登记已完成，但状态回复失败：" + err.message);
    }
    return { ok: true, root_message_id: rootMessageId };
  },
});
if (!wired.ok) {
  // 已启用端点任一取锁/账本/收据异常 → 整笔拒、不写 legacy、不建话题（fail-closed）。
  die("绑定失败（M1a 一致性锁：" + (wired.reason ?? "unknown") + (wired.why ? "；" + wired.why : "") + "）");
}
const lr = wired.legacy;
if (!lr.ok) {
  if (lr.phase === "send") die("建话题失败，没有写登记表：" + lr.message);
  die("话题已建（" + lr.root_message_id + "）但登记表没写成：" + lr.message + "。重跑会命中平台幂等键，不会重建话题。");
}
// #R37 P1-4：legacy 已提交但 shadow 镜像不干净 → 持久机器回执（不谎报 clean）。
const bindUnclean = uncleanWired(wired);
if (!bindUnclean.clean) emitUncleanReceipt("cli_bind_task", wired, { receiptDir: path.join(bridgeHome(), "receipts") });
console.log("已接入并发布状态回复。去新话题真实 @ " + transportAgentName + " 一下完成绑定；后续不需要关键字前缀。");
