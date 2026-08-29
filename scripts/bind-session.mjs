#!/usr/bin/env node
/**
 * 把**当前这个会话**单独绑到一个飞书话题 —— 同一个项目里可以有多条工作线，各占一个话题。
 *
 * 为什么需要它：「项目 = 目录」这个假设是从写代码来的。写代码时目录确实等于工作范围，
 * 但做研究、写东西、整理资料的人，可能一个文件夹里同时开五条互不相干的线 ——
 * 目录代表不了「在忙哪件事」。Claude 这边最接近「一条工作线」的东西就是会话。
 *
 * **必须在你要绑的那个会话里跑。**它从环境变量认自己：
 *
 *   CLAUDE_CODE_SESSION_ID  这个会话的 uuid
 *   CLAUDE_PID              这个会话的进程 pid（用来交叉核对登记文件）
 *
 * 这一点跟当年那个失败方案是本质区别。当年是从外面**推断**一个 uuid 钉死，过期了没人知道；
 * 现在这个 uuid 是在那条线自己身上读出来的，而且入站找不到它时会明确拒绝，
 * 不会悄悄投给另一条线（见 inbound.mjs 的 bound_session_gone）。
 *
 * 项目级绑定仍然是默认和兜底：没有会话级绑定时，一切照旧。会话级是加法。
 *
 * 用法（在目标会话里）：
 *   node scripts/bind-session.mjs              # 看会做什么
 *   node scripts/bind-session.mjs --apply
 *   node scripts/bind-session.mjs --name "迁移这条线" --apply
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadChainTemplate, resolveLarkIdentity } from "./chain-template.mjs";
import { registryPath } from "./registry.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import { isDirectRun } from "./direct-run.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
  newRegistryEntry, readProjectIdentity,
} from "./bind-compose.mjs";

export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
export const PID_ENV = "CLAUDE_PID";

/**
 * 认出「我是谁」。
 *
 * 两个来源交叉核对：环境变量给的 uuid，和按 pid 找到的登记文件里的 uuid。
 * 只信环境变量的话，在一个由别的会话派生出来的子进程里也会读到值 —— 那就绑错线了。
 * 对不上就拒绝，不猜。
 */
export function identifySelf({ env = process.env, sessionsDir } = {}) {
  const sid = env[SESSION_ENV];
  const pid = env[PID_ENV];
  if (typeof sid !== "string" || !sid) {
    return { ok: false, reason: "no_session_env",
      detail: "读不到 " + SESSION_ENV + " —— 这条命令必须在一个 Claude 会话里跑" };
  }
  if (typeof pid !== "string" || !pid) {
    return { ok: false, reason: "no_pid_env", detail: "读不到 " + PID_ENV };
  }

  const dir = sessionsDir ?? path.join(os.homedir(), ".claude", "sessions");
  const file = path.join(dir, pid + ".json");
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { ok: false, reason: "no_session_record",
      detail: "按 pid 找不到会话登记文件：" + file };
  }
  if (rec.sessionId !== sid) {
    return { ok: false, reason: "session_mismatch",
      detail: "环境变量说是 " + sid.slice(0, 8) + "，登记文件说是 " +
        String(rec.sessionId).slice(0, 8) + " —— 对不上就不绑，免得绑错线" };
  }
  if (rec.kind !== "interactive") {
    return { ok: false, reason: "not_interactive",
      detail: "只有交互会话能绑（当前是 " + rec.kind + "）—— 无头会话跑完就没了" };
  }
  return { ok: true, sessionId: sid, pid: Number(pid), name: rec.name, cwd: rec.cwd };
}

/** 会话级那一行 = 项目级那一行 + 会话标识。共用 newRegistryEntry，免得两处各写一份。 */
export function newSessionEntry({ root, name, purpose, token, rootMessageId, claudeSessionId, sessionName, now }) {
  return {
    ...newRegistryEntry({ root, name, purpose, token, rootMessageId, now }),
    // id 要能区分同一个项目下的多条：加会话 uuid 的前 8 位，人看得出、也够唯一。
    id: path.basename(root) + "@" + String(claudeSessionId).slice(0, 8),
    claude_session_id: claudeSessionId,
    claude_session_name: sessionName ?? null,
    note: "会话级绑定（在该会话里用 bind-session 建立）。项目级绑定仍然独立存在、互不影响。",
  };
}

/** 会话级绑定的根消息要说清它跟项目级那条的区别，否则群里两个话题长得一模一样。 */
export function composeSessionRootMessage({ name, purpose, root, token, sessionName }) {
  const base = composeRootMessage({ name, purpose, root, token });
  return base + "\n\n这个话题只对应该项目里的**一条工作线**（会话 " +
    (sessionName ?? "?") + "）。同一个项目的其他会话有各自的话题。";
}

// ---------- CLI ----------

if (isDirectRun(import.meta.url)) {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态

const die = (msg, hint) => {
  console.error(msg);
  if (hint) console.error(hint);
  process.exit(1);
};

const me = identifySelf();
if (!me.ok) die("认不出当前会话（" + me.reason + "）：" + me.detail);

const root = me.cwd;
const tpl = loadChainTemplate();
if (!tpl.ok) {
  die("机器级链路模板不可用（" + tpl.reason + "）",
    "先跑 node scripts/init-chain-template.mjs --apply");
}
const template = tpl.template;

const regFile = registryPath();
let registry = { schema_version: "1.0", projects: [] };
try {
  registry = JSON.parse(fs.readFileSync(regFile, "utf-8"));
  registry.projects ??= [];
} catch { /* 没有登记表就新建 */ }

const already = registry.projects.find((p) => p?.claude_session_id === me.sessionId);
if (already?.root_message_id) {
  console.log("这条会话已经绑过了，没有重复建话题。");
  console.log("  话题  " + already.root_message_id);
  console.log("  入站  " + (already.session_id ? "已绑定" : "待绑定（去话题里 @ 一下）"));
  process.exit(0);
}

const identity = readProjectIdentity({ root });
const name = arg("name") ?? (identity.name + " · " + me.name);
const token = bindingToken(root + "#" + me.sessionId);   // 会话级用不同的种子，不跟项目级撞
const idemKey = idempotencyKeyFor(root + "#" + me.sessionId);
const rootText = composeSessionRootMessage({
  name, purpose: identity.purpose, root, token, sessionName: me.name,
});
const statusText = composeStatusMessage({ name });

console.log("会话    " + me.name + "  (" + me.sessionId.slice(0, 8) + ")");
console.log("项目    " + root);
console.log("群      " + template.chat_name + "  " + template.chat_id);
console.log("\n--- 根消息 ---\n" + rootText);
console.log("\n--- 底下第一条 ---\n" + statusText);
console.log("\n只写一处：" + regFile + "（项目目录里不写任何文件）");
console.log("项目级绑定不受影响 —— 它仍然独立存在，其他会话照旧发到原话题。");

if (!apply) {
  console.log("\n[dry-run] 没有发消息，也没有写文件。加 --apply 才真的做。");
  process.exit(0);
}

const ident = resolveLarkIdentity(template);
let rootMessageId;
try {
  rootMessageId = sendToChat({
    profile: ident.profile, chatId: template.chat_id, text: rootText,
    idempotencyKey: idemKey, larkBin: ident.bin, larkHome: ident.configDir,
    expectedAppId: ident.expectedAppId,
  });
} catch (err) {
  die("建话题失败，没有写任何文件：" + err.message);
}
console.log("\n根话题已建立  " + rootMessageId);

const entry = newSessionEntry({
  root, name, purpose: identity.purpose, token, rootMessageId,
  claudeSessionId: me.sessionId, sessionName: me.name,
});
registry.projects.push(entry);

try {
  fs.mkdirSync(path.dirname(regFile), { recursive: true, mode: 0o700 });
  if (fs.existsSync(regFile)) fs.copyFileSync(regFile, regFile + ".prev");
  const tmp = regFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, regFile);
} catch (err) {
  die("话题建好了（" + rootMessageId + "）但登记没写成：" + err.message,
    "修好权限后重跑同一条命令即可，幂等键保证不会多建一个话题。");
}
console.log("已登记        " + regFile + "  （现在 " + registry.projects.length + " 条绑定）");

try {
  const statusId = publishDraft({
    profile: ident.profile, rootMessageId, text: statusText,
    larkBin: ident.bin, larkHome: ident.configDir, expectedAppId: ident.expectedAppId,
  });
  console.log("状态已发布    " + statusId);
} catch (err) {
  console.error("状态回复没发出去：" + err.message);
  console.error("绑定本身已完成，只是这条验证消息没发成。");
}

console.log("\n这条会话已单独接入。本机输入与每轮回答会合成卡片发到新话题，不再进项目那个。");
console.log("入站还差最后一下：去新话题 @ 一下运输 agent（空消息也行）。");
}
