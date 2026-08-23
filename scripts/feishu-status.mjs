#!/usr/bin/env node
/**
 * 只读查看当前上下文的飞书接入状态。不改任何东西，也不打印 locator。
 *
 * 「当前上下文」= 这条工作线（如果它单独绑过），否则 = 这个项目。用的是跟出站
 * 完全同一条选择规则 —— 状态命令要是按另一套规则找，就会出现「status 说绑的是 A、
 * 实际发到 B」这种最难查的不一致。
 *
 * 除了当前上下文，还会列出本机其他消费者的连接 —— 「我有哪些东西连到了哪些
 * 飞书群和话题」是**一个**问题，不该按实现拆成几条命令各答一半。
 * 那部分的取数和校验在 status-providers.mjs，坏了只影响显示，不影响入站。
 *
 * 用法：node scripts/feishu-status.mjs [--project ~/x]
 */

import path from "node:path";

import { bindingsForRoot, currentBinding, describeStatus } from "./feishu-control.mjs";
import { buildClaudeSubscriptionProjection } from "./inbound-route.mjs";
import { composeLayeredStatus, endpointFacts, renderLayeredStatus, subscriptionFacts } from "./layered-status.mjs";
import { collectConnectivity, renderConnectivity } from "./status-providers.mjs";

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;

const st = currentBinding({ root, claudeSessionId });
// 分层视图把它放进"其他消费者"那一节，标题由那边给。
const layeredConnectivity = renderConnectivity(collectConnectivity(), { heading: null });
const connectivity = renderConnectivity(collectConnectivity());

if (!st.ok) {
  // 没绑定就没有四层可言，照旧给接入指引；本机其他链路仍然值得看见。
  console.log(describeStatus(st, bindingsForRoot({ root })));
  if (connectivity) console.log("\n" + connectivity);
  process.exit(0);
}

console.log(renderLayeredStatus(composeLayeredStatus({
  st,
  others: bindingsForRoot({ root }),
  endpoint: endpointFacts(),
  subscription: subscriptionFacts(buildClaudeSubscriptionProjection({})),
  connectivity: layeredConnectivity,
})));
process.exit(0);
