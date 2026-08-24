#!/usr/bin/env node
/** 只读查看当前精确 Codex thread 的飞书连接状态；不输出任何 locator。 */

import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, findRegisteredTaskForCodexThread, loadCodexTemplate, loadRegistry, registryFile,
} from "./state.mjs";
import { collectConnectivity, renderConnectivity } from "../status-providers.mjs";
import {
  composeLayeredStatus, endpointFacts, outboundRoutingFact, renderLayeredStatus,
  splitByRelation, subscriptionFacts,
} from "../layered-status.mjs";
import { checkEndpoint } from "../endpoint-self-check.mjs";
import { resolveLarkIdentity } from "../chain-template.mjs";
import path from "node:path";
import { codexRuntimeRoot, verifyRuntime } from "../runtime-install.mjs";
import { codexHomeOf } from "./drain-service.mjs";
import { taskBindingFacts } from "./task-binding.mjs";
import { buildCodexSubscriptionProjection } from "./subscription-projection.mjs";

const arg = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const threadId = arg("thread-id");
if (!validThreadId(threadId)) {
  console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
  process.exit(1);
}

const home = bridgeHome();
const found = findRegisteredTaskForCodexThread({ threadId, home });
if (!found.ok) {
  if (found.reason === "thread_not_registered") {
    console.log("当前 Codex task 尚未接入飞书。");
    // 当前 task 没绑，不该妨碍看别的链路 —— 本机可能还有几条正常运转的，
    // 而"这条没绑"和"本机什么都没有"是两回事。
    const unbound = renderConnectivity(collectConnectivity());
    if (unbound) console.log("\n" + unbound);
    process.exit(0);
  }
  console.error("无法读取连接状态：" + found.reason);
  process.exit(1);
}

const task = found.task;
const st = taskBindingFacts({ task, home });
if (!st.ok) {
  console.error("无法读取这条 task 的状态：" + st.reason);
  process.exit(1);
}

const loaded = loadCodexTemplate();
const tpl = loaded?.ok ? loaded.template : null;

// 只看本条链路。整台机器的全景归 doctor。
const links = collectConnectivity();
// 附录只放归不了层的那部分 —— 能归层的已经进了对应层，再出现一次就是重复。
const unsorted = splitByRelation(links.sections).unsorted;
const layeredConnectivity = renderConnectivity(
  { ...links, sections: unsorted }, { heading: null });

// **出站路由认不认这条 task。**第 3 层其余各行读的是 task 自己的状态，
// 而出站走登记表 —— 两套可以不一致，而那种不一致最难查。
const reg = loadRegistry(registryFile(home));
const exact = reg.ok
  ? (reg.tasks ?? []).filter((t) => t.codex_thread_id === threadId) : [];
const outboundRouting = outboundRoutingFact({
  registryOk: reg.ok,
  exactCount: exact.length,
  // **"是不是这条 task"和"出站会不会挑到它"是两个问题。**暂停的属于前者不属于后者。
  routableCount: exact.filter((t) => (t.status ?? "active") === "active").length,
  bound: st.ok === true,
});

console.log(renderLayeredStatus(composeLayeredStatus({
  st,
  outboundRouting,
  // Codex 一条 thread 一条 task，没有"同一项目多条绑定"那一节。
  others: [],
  endpoint: endpointFacts({
    // **这三样都必须显式给。**默认值全指向 Claude 那条链 ——
    // 不给的话第 1 层会写着"Claude Code"、版本号报的是 Claude 运行时的哈希，
    // 而那正是四层最该分清的东西：这一层问的是"我这条链的端点"。
    runtime: "Codex CLI",
    runtimeDir: path.join(codexRuntimeRoot(codexHomeOf()), "current"),
    verify: () => verifyRuntime({ root: codexRuntimeRoot(codexHomeOf()) }),
    agentName: tpl?.transport_agent_name ?? null,
    // 端点自检：只读、限时、不修不启。模板读不出来时传 null ——
    // **没查就是没查**，不许因为代码存在就当成查过了。
    selfCheck: tpl ? checkEndpoint({ template: tpl, identity: resolveLarkIdentity(tpl) }) : null,
  }),
  subscription: subscriptionFacts(
    buildCodexSubscriptionProjection({ home, threadId }),
    { groupName: tpl?.chat_name ?? null }),
  connectivity: layeredConnectivity,
  otherLinks: links,
})));
process.exit(0);
