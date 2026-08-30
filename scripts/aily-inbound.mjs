#!/usr/bin/env node
/** Claude Aily 入站薄入口：配置 endpoint，业务与运行时逻辑仍在原 handler。 */

import os from "node:os";
import path from "node:path";

import { loadChainTemplate } from "./chain-template.mjs";
import { runInboundDispatcher } from "./inbound-dispatcher.mjs";
import { routesPath } from "./inbound-routes.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import { moduleRoot } from "./direct-run.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";

// 维护门（issue #81）：分发器入口先看门 —— 所有路由（含指向外部 handler 的）在窗口内都回"维护中"，不取信封、不 claim
{ const gate = gateBlocks(); if (gate.blocked) exitForGate("inbound", gate); }

const ROOT = moduleRoot(import.meta.url, "..");
const tpl = loadChainTemplate();
if (!tpl.ok) {
  process.stdout.write("系统错误 · 这台机器的链路模板不可用（" + tpl.reason +
    "）\n本条指令没有被投递。请勿视为已受理。\n");
  process.exit(1);
}

const result = runInboundDispatcher({
  endpointId: legacyEndpointId({ runtime: "claude", agentUid: tpl.template.agent_uid }),
  expectedCallerAgentUid: tpl.template.agent_uid,
  defaultRoute: { id: "self", handler: path.join(ROOT, "scripts", "inbound.mjs") },
  routesFile: routesPath(),
  logFile: path.join(os.homedir(), ".claude", "feishu-bridge", "aily-inbound.log"),
  dryRun: process.argv.includes("--dry-run"),
  handlerArgs: process.argv.slice(2),
});
process.exit(result.exitCode);
