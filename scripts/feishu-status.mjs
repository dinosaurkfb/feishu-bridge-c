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
import {
  composeLayeredStatus, endpointFacts, outboundRoutingFact, renderLayeredStatus,
  splitByRelation, subscriptionFacts,
} from "./layered-status.mjs";
import { collectProjectConnectivity, renderConnectivity } from "./status-providers.mjs";
import {
  exactProjectsForRoot, loadRegistryStrict, routableProjectsForRoot,
} from "./registry.mjs";

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
// 附录只放归不了层的那部分 —— 能归层的已经进了对应层，再出现一次就是重复。
const unsorted = splitByRelation(projectLinks.sections).unsorted;
const layeredConnectivity = renderConnectivity(
  { ...projectLinks, sections: unsorted }, { heading: null });

// **出站路由认不认这个项目。**第 3 层其余各行读的是项目内文件，
// 而出站走登记表 —— 两套可以不一致，而那种不一致最难查。
// **用严格读取，不用 loadRegistry。**后者服务钩子：读不到就安静当成"没接桥"，
// 于是 EACCES / EISDIR / 根节点是数组 全被当成 no_registry —— 状态页会把
// "读不出来"报成"降级"。要据此下判断的调用方必须用严格版。
const reg = loadRegistryStrict();
// **精确匹配这个项目，不是"哪个登记项目能覆盖当前目录"。**
// attributeSession 走的是目录包含关系：登记表里只有父目录 /projects、
// 当前绑定是 /projects/A 时它照样命中 —— 状态页显示正常，
// 而 Stop 钩子实际会把回答**归给父项目**。
const outboundRouting = outboundRoutingFact({
  registryOk: reg.ok,
  exactCount: reg.ok ? exactProjectsForRoot(reg.projects, root).length : 0,
  // **"是不是这个项目"和"出站会不会挑到它"是两个问题。**停用的条目属于前者不属于后者。
  routableCount: reg.ok ? routableProjectsForRoot(reg.projects, root).length : 0,
  bound: st.ok === true,
});

console.log(renderLayeredStatus(composeLayeredStatus({
  st,
  outboundRouting,
  others: bindingsForRoot({ root }),
  endpoint: endpointFacts({
    agentName: tpl?.transport_agent_name ?? null,
    // 端点自检（FR-1.4）。只读、限时、不修不启。
    selfCheck: tpl ? checkEndpoint({ template: tpl, identity: resolveLarkIdentity(tpl) }) : null,
  }),
  subscription: subscriptionFacts(buildClaudeSubscriptionProjection({ projectRoot: root }),
      // chat_id 也要给：**群名只能用在它确实对应的那条订阅上** ——
      // 无条件套上去的话，指向别的群的订阅会被错报成模板群。
      { groupName: tpl?.chat_name ?? null, templateChatId: tpl?.chat_id ?? null }),
  connectivity: layeredConnectivity,
  otherLinks: projectLinks,
})));
process.exit(0);
