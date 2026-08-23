#!/usr/bin/env node
/**
 * 只读查看当前上下文的飞书接入状态。不改任何东西，也不打印 locator。
 *
 * 「当前上下文」= 这条工作线（如果它单独绑过），否则 = 这个项目。用的是跟出站
 * 完全同一条选择规则 —— 状态命令要是按另一套规则找，就会出现「status 说绑的是 A、
 * 实际发到 B」这种最难查的不一致。
 *
 * 按四层关系模型分区展示（§6），并**只看当前项目**：本项目的其他链路也一并列出，
 * 因为「我有哪些东西连到了哪些飞书群和话题」是一个问题，不该按实现拆成几条命令
 * 各答一半。整台机器的跨项目诊断归后续的 doctor 命令。
 *
 * 状态提供者的取数和校验在 status-providers.mjs，坏了只影响显示，不影响入站。
 *
 * 用法：node scripts/feishu-status.mjs [--project ~/x]
 */

import path from "node:path";

import { bindingsForRoot, currentBinding } from "./feishu-control.mjs";
import { buildClaudeSubscriptionProjection } from "./inbound-route.mjs";
import { loadChainTemplate, resolveLarkIdentity } from "./chain-template.mjs";
import { checkEndpoint } from "./endpoint-self-check.mjs";
import { composeLayeredStatus, endpointFacts, renderLayeredStatus, subscriptionFacts } from "./layered-status.mjs";
import { collectProjectConnectivity, renderConnectivity } from "./status-providers.mjs";

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;

const st = currentBinding({ root, claudeSessionId });
// 分层视图把它放进"其他消费者"那一节，标题由那边给。
const loaded = loadChainTemplate();
const tpl = loaded?.ok ? (loaded.template ?? loaded) : null;

// 只看当前项目的链路。整台机器的全景归后续的 doctor 命令。
const projectLinks = collectProjectConnectivity({ root });
const layeredConnectivity = renderConnectivity(projectLinks, { heading: null });

console.log(renderLayeredStatus(composeLayeredStatus({
  st,
  others: bindingsForRoot({ root }),
  endpoint: endpointFacts({
    agentName: tpl?.transport_agent_name ?? null,
    // 端点自检（FR-1.4）。只读、限时、不修不启。
    selfCheck: tpl ? checkEndpoint({ template: tpl, identity: resolveLarkIdentity(tpl) }) : null,
  }),
  subscription: subscriptionFacts(buildClaudeSubscriptionProjection({ projectRoot: root }),
    { groupName: tpl?.chat_name ?? null }),
  connectivity: layeredConnectivity,
})));
process.exit(0);
