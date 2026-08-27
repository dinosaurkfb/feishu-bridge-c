#!/usr/bin/env node
/** 只读查看当前精确 Codex thread 的飞书连接状态；不输出任何 locator。 */

import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, buildCodexSubscriptionProjection, findRegisteredTaskForCodexThread,
  loadCodexTemplate, loadRegistry, registryFile,
} from "./state.mjs";
import { collectProjectConnectivity, renderConnectivity } from "../status-providers.mjs";
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
import { codexPendingEventRows } from "./status-events.mjs";

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

/**
 * **没绑定不等于没有四层。**
 *
 * 上一版在这里直接退出，未绑定时只剩一句"尚未接入飞书"——
 * 四层模型在最需要它的时候消失了：正是没绑的时候，人才要知道
 * 运行时装没装、订阅活不活动。第 1、2 层照样有事实可报，
 * 只是第 3 层还没绑、第 4 层无从谈起。
 * 共用渲染器本来就 handle 这个，是我接线时提前 return 把它绕过去了。
 *
 * 同时区分"这条没绑"和"读不出来"—— 前者是正常状态，后者是故障；
 * 混成一句的话，一个坏掉的 registry 看起来就跟没绑过一样。
 */
const task = found.ok ? found.task : null;
const st = found.ok
  ? taskBindingFacts({ task: found.task, home })
  // **"还没接"要用渲染器认得的那个名字。**渲染器按 not_bound 区分
  // "尚未绑定"和"状态不可读"；Codex 侧管它叫 thread_not_registered，
  // 直接透传的话，一条**从没绑过**的 task 会被报成"状态不可读"——
  // 那是把正常状态说成了故障。同一个概念两个名字，翻译层负责对齐。
  : { ok: false, reason: found.reason === "thread_not_registered" ? "not_bound" : found.reason };

const loaded = loadCodexTemplate();
const tpl = loaded?.ok ? loaded.template : null;

// **只看本条链路 —— 而且要"先过滤再执行"。**
//
// 上一版这里调机器级 collectConnectivity()：它会**把所有 provider 都跑一遍**，
// 再按归属过滤显示。界面上看着只有当前项目，实际已经在这台机器上执行了
// 别的项目的脚本。评审用 marker 文件证明了 —— 输出里看不见，marker 却建出来了。
// collectProjectConnectivity 的注释里写着同一个坑已经修过一次，
// 而我在 Codex 侧又用回了那个机器级的。
//
// 未绑定时没有可信的项目根 —— **那就一个 provider 都不跑**，
// 不许退回机器全景：说不清是谁的，就不该替谁执行。
const links = found.ok
  ? collectProjectConnectivity({ root: found.task.root })
  : { sections: [], providersProblem: null, routesProblem: null };
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
  // Codex 侧的接入办法是 $feishu-bind，不是 Claude 那条脚本命令。
  // **一个错的下一步比没有下一步更糟。**
  bindHint: "$feishu-bind",
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
    // **入站日志也是 Claude 默认值。**我上一版只显式给了 runtime/runtimeDir/verify，
    // 漏了这一个 —— 评审用反例证明：只写一条 Claude 的入站日志，
    // Codex 状态就会把它显示成自己的"最近入站"。
    // 同一类默认值有四个，我修了三个 —— **补一处、不找同类**，又一次。
    inboundLog: path.join(home, "dispatcher.log"),
    agentName: tpl?.transport_agent_name ?? null,
    // 端点自检：只读、限时、不修不启。模板读不出来时传 null ——
    // **没查就是没查**，不许因为代码存在就当成查过了。
    selfCheck: tpl ? checkEndpoint({ template: tpl, identity: resolveLarkIdentity(tpl) }) : null,
  }),
  subscription: subscriptionFacts(
    buildCodexSubscriptionProjection({ home, threadId }),
    // **优先用这条 task 自己的群事实。**task 支持覆盖 chat_id/chat_name；
    // 只传模板的话，一个已知群名的 task 会被报成"群名不可用"——
    // 上一轮我修掉了"错报模板群名"，却把"把知道的说成不知道"留下了。
    { groupName: task?.chat_name ?? tpl?.chat_name ?? null,
      templateChatId: task?.chat_id ?? tpl?.chat_id ?? null }),
  connectivity: layeredConnectivity,
  otherLinks: links,
  // FR-10：第五区的 run / publish 状态 —— 只转述 collectBacklog 与 listEligibilityPending 的结论。
  pendingRows: codexPendingEventRows({ home, threadId, task }),
})));
process.exit(0);
