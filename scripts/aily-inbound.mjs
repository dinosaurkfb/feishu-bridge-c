#!/usr/bin/env node
/**
 * Aily 入站分发器 —— 本机**唯一**的入站入口。
 *
 * 一条 Aily 回合进来，它只做三件事：验调用方、取一次信封、按可信字段把它交给对的 handler。
 * 它自己不做任何业务判断（不校验绑定、不 claim、不投递），那些是各 handler 的事。
 *
 * 为什么要有这一层：本机不止一个消费者。cc2cd 有自己的话题绑定和入站脚本，
 * 它先前的做法是**包住**本仓库的 inbound.mjs。那能跑，但技能和 Hook 只能指一个入口
 * （谁后装谁赢）、信封被取两遍（重试预算翻倍，顶到秒级回执的上限）、
 * 归属逻辑住在最外层（每加一个消费者，最外层都得知道所有内层）。
 *
 * 分发器把这三件事一次解掉：入口恒定，信封取一次并往下传，加消费者只是加一行注册。
 *
 * **模型不参与选路。**能决定去向的只有原始信封里的可信字段和本地那张表。
 * 正文是 Frank 打的 —— 让正文影响路由，等于把路由交给消息内容。
 *
 * 用法（技能和 Hook 都只写这一条）：
 *   node scripts/aily-inbound.mjs
 *   node scripts/aily-inbound.mjs --dry-run   # 只报会交给谁，不执行
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENVELOPE_ENV, fetchTriggerEvent } from "./envelope.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { ROUTE_REJECT_TEXT, loadRoutes, selectRoute } from "./inbound-routes.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LOG = path.join(os.homedir(), ".claude", "feishu-bridge", "aily-inbound.log");

/** 分发器的失败必须留痕：它跑在别人的会话里，出错时没有人会看终端。 */
function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG, new Date().toISOString() + " " +
      String(line).replace(/\s+/g, " ").slice(0, 1000) + "\n", { mode: 0o600 });
  } catch { /* 日志写不了不该影响投递 */ }
}

/**
 * 回执文案。分发层只会说两种话：交给谁了，或者为什么没交出去。
 * 业务上的「已受理／已拒绝」由 handler 自己说，分发器**一个字都不加**。
 */
function fail(detail, reason) {
  process.stdout.write("系统错误 · " + detail + "\n本条指令没有被投递。请勿视为已受理。\n");
  process.stderr.write(JSON.stringify({ kind: "error", stage: "dispatch", reason }) + "\n");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

// ---------- 第 0 道闸：调用我的这个 agent 是不是本链路的运输 agent ----------
//
// 入站技能装在 ~/.claude/skills/，本机每个 Claude 会话都看得见 —— 包括另外十几个
// aily agent。任何一个跑了这个脚本，都会去取**它自己的**事件。挡住这件事的原本是
// mention 那道闸（别的 agent 收到的消息 @ 的是它自己），但那是巧合性的安全。
//
// 只能用**机器级模板**：项目配置要等路由之后才知道读哪份，而路由要靠信封。

const tpl = loadChainTemplate();
if (!tpl.ok) {
  log("chain template unusable: " + tpl.reason);
  fail("这台机器的链路模板不可用（" + tpl.reason + "）—— 先跑 init-chain-template.mjs",
    "chain_template_unusable");
}

const callerAgent = process.env.AILY_CLI_CALLER_AGENT_UID;
if (callerAgent !== tpl.template.agent_uid) {
  log("caller mismatch: got=" + (callerAgent ?? "none"));
  process.stdout.write("已拒绝 · 调用方不是本链路的运输 agent（收到 " +
    (callerAgent ?? "空") + "）\n本条指令没有被投递给任何任务。\n");
  process.stderr.write(JSON.stringify({ kind: "rejected", stage: "dispatch",
    reason: "caller_agent_mismatch" }) + "\n");
  process.exit(0);
}

// ---------- 取信封：整条链路上**只取这一次** ----------

const fetched = fetchTriggerEvent();
if (!fetched.ok) {
  log("envelope fetch failed: " + fetched.reason + " attempts=" + (fetched.attempts ?? 1));
  fail("取不到本次消息信封（" + fetched.reason + "）", fetched.reason);
}
const event = fetched.event;

// ---------- 选路由 ----------

const table = loadRoutes();
const routes = table.routes.length > 0 ? table.routes : [{
  // 表不存在时的隐含默认：本仓库自己。绝大多数机器只有一个消费者，
  // 那种情况下不该要求任何人先去写一张表。
  id: "self", handler: path.join(ROOT, "scripts", "inbound.mjs"), isDefault: true,
}];

const picked = selectRoute({ sessionId: event.session_id, routes, sessions: table.sessions });
if (!picked.ok) {
  log("route selection failed: " + picked.reason + " session=" + event.session_id);
  fail(ROUTE_REJECT_TEXT[picked.reason] ?? picked.reason, picked.reason);
}

const handler = picked.route.handler;
if (!fs.existsSync(handler)) {
  log("handler missing: " + handler);
  fail("路由 " + picked.route.id + " 指向的脚本不在：" + handler, "route_handler_missing");
}

if (dryRun) {
  process.stdout.write("[dry-run] 会交给路由 " + picked.route.id +
    "（依据：" + picked.matchedBy + "）→ " + handler + "\n");
  process.stderr.write(JSON.stringify({ dryRun: true, route: picked.route.id,
    matchedBy: picked.matchedBy, session_id: event.session_id }) + "\n");
  process.exit(0);
}

// ---------- 交给 handler，原样透出 ----------
//
// stdout / 退出码一个字都不改：飞书上看到的那句「已受理／已拒绝」必须是 handler 说的。
// 分发器插一句嘴，Frank 就分不清是谁的判断了。

log("dispatch session=" + event.session_id + " -> " + picked.route.id +
  " (" + picked.matchedBy + ")");

const r = spawnSync(process.execPath, [handler, ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, [ENVELOPE_ENV]: JSON.stringify(event) },
});

if (r.error) {
  log("handler spawn failed: " + r.error.message);
  fail("路由 " + picked.route.id + " 起不来：" + r.error.message, "handler_spawn_failed");
}
process.exit(r.status ?? 1);
