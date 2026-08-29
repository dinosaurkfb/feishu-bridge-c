#!/usr/bin/env node
/** Codex Aily 入站薄入口：与 Claude 共用 dispatcher/canonical event，保留 Codex handler。 */

import path from "node:path";

import { runInboundDispatcher } from "../inbound-dispatcher.mjs";
import { legacyEndpointId } from "../subscription.mjs";
import { bridgeHome, loadCodexTemplate } from "./state.mjs";
import { moduleRoot } from "../direct-run.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";

// 维护门（issue #81）：分发器入口先看门，回"维护中"，不取信封、不 claim
{ const gate = gateBlocks(); if (gate.blocked) exitForGate("inbound", gate); }

const ROOT = moduleRoot(import.meta.url, "../..");
const HOME = bridgeHome();
const tpl = loadCodexTemplate();
if (!tpl.ok) {
  process.stdout.write("系统错误 · Codex 单智能体链路模板不可用（" + tpl.reason +
    "）\n本条指令没有被投递。请勿视为已受理。\n");
  process.exit(1);
}

const result = runInboundDispatcher({
  endpointId: legacyEndpointId({ runtime: "codex", agentUid: tpl.template.agent_uid }),
  expectedCallerAgentUid: tpl.template.agent_uid,
  defaultRoute: { id: "codex", handler: path.join(ROOT, "scripts", "codex", "inbound.mjs") },
  routesFile: path.join(HOME, "routes.json"),
  logFile: path.join(HOME, "dispatcher.log"),
  dryRun: process.argv.includes("--dry-run"),
  handlerArgs: process.argv.slice(2),
});
process.exit(result.exitCode);
