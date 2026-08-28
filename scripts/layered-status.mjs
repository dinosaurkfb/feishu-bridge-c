/**
 * 按四层关系模型展示状态。
 *
 * 需求原文（docs/requirements/agent-enhancement-requirements.md:219）要求 status
 * "只读展示四层状态和待处理事件"，而上一版把四层揉成了一张平表 —— 绑定级别、
 * 交互模式、出站入站、待发条数排在一起，看不出它们分属不同的关系层。
 *
 * 四层（同文件 §6）：
 *   1 运行端点连接  Aily Agent ──online──> 本机 adapter
 *   2 事件订阅      Agent + 群 + sender + event type ──subscribe──> 项目/业务域
 *   3 精确通道绑定  飞书 topic/session ──bind──> 本地 task/thread/session
 *   4 交互策略      通道 ──policy──> 映射 / 对话 / 管理
 * 外加需求要求的第五区：待处理事件。
 *
 * 两条刻意的克制：
 *
 *   · **不出总的绿色"已接入"。**四层完全可能各自处于不同状态（端点未自检、
 *     订阅活动、通道已绑、策略 Dialogue），一个总判断会把它们抹平成一句话。
 *   · **第 1 层不假装知道。**端点实时自检（FR-1.4）还没实现，所以这一层只说
 *     "未自检"，附带的历史证据措辞上必须停在"过去某刻工作过"，不能滑成"在线"。
 */

import { TOPIC_GENERATION_AUTO_ROTATE_MESSAGES } from "./topic-generation.mjs";
import { displaySafe } from "./display-safe.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyRuntime } from "./runtime-install.mjs";
import { claimable } from "./subscription.mjs";

/**
 * 自检结论的人读文案。**导出是为了让测试引用它，而不是复制一份字面量** ——
 * 复制的那份在文案改了之后会静悄悄地变成"永远成立"的空断言。
 *
 * ready 这条刻意不写数字。上一版写死"四项全过"，检查从四项加到五项之后
 * 它就成了一句给用户看的错话，而且**没有任何测试会因此变红**。
 */
export const SELF_CHECK_TEXT = {
  ready: "全部通过",
  // blocked 和 incomplete 必须分开：一个是**查出问题**，一个是**没查清**。
  // 把"没查清"显示成"有问题"会让人去修一个不存在的故障，
  // 显示成"没问题"则更糟 —— 那是拿不知道冒充没事。
  blocked: "有问题",
  incomplete: "没查清",
};

/** 没跑自检时的占位。**代码存在不等于查过了** —— 不传报告就仍然是"未自检"。 */
export const ENDPOINT_SELF_CHECK = "not_checked";

const runtimeDirDefault = () =>
  path.join(os.homedir(), ".claude", "feishu-bridge", "runtime");
const inboundLogDefault = () =>
  path.join(os.homedir(), ".claude", "feishu-bridge", "aily-inbound.log");

/**
 * 第 1 层能查到的事实。
 *
 * 能查：装没装、装的哪一版。
 * 查不到：**它此刻在不在线** —— 路由登记只证明配置存在，日志只证明过去某个时刻
 * 工作过。两者都不能升级成"在线"。
 */
/**
 * 待认领代际的窗口说明 —— **一份措辞，两处渲染共用**。
 * 写了显式截止（旧登记）就说截止；否则说"不设期限"并给已等待时长（算出来的，不是判断）。
 */
export function describePendingWindow(st, { now = Date.now(), full = false } = {}) {
  if (st.pendingGenerationExpiresAt) {
    const s = String(st.pendingGenerationExpiresAt);
    return "（截止 " + (full ? s : s.slice(0, 10)) + "）";
  }
  const created = Date.parse(st.pendingGenerationCreatedAt ?? "");
  if (!Number.isFinite(created)) return "（不设期限）";
  const waited = Math.max(0, now - created);
  const said = waited < 2 * 24 * 3600000 ? Math.max(1, Math.round(waited / 3600000)) + " 小时" : Math.round(waited / 86400000) + " 天";
  return "（不设期限，已等待约 " + said + "）";
}

export function endpointFacts({
  runtime = "Claude Code",
  agentName = null,
  selfCheck = null,
  runtimeDir = runtimeDirDefault(),
  inboundLog = inboundLogDefault(),
  verify = () => verifyRuntime(),
} = {}) {
  // **能读到符号链接不等于装好了。**上一版只看链接在不在，于是一个指向不存在目录的
  // current 也会显示"已安装"。三种状态要分开：没装 / 装好了 / 装的东西有问题。
  const verified = verify();
  const install = verified.ok ? "ok"
    : verified.reason === "current_absent" ? "absent" : "broken";

  // **版本号也要过校验。**只读符号链接 basename 的话，一个坏掉的 runtime 会同时
  // 显示"看起来像真的版本号"和"运行时不可用" —— 那个数字没有任何东西背书。
  let version = null;
  if (verified.ok) {
    version = typeof verified.version === "string" ? verified.version.slice(0, 12) : null;
  }
  let linkCandidate = null;
  try {
    linkCandidate = path.basename(fs.readlinkSync(path.join(runtimeDir, "current"))).slice(0, 12);
  } catch { /* 没装或读不到 */ }

  return {
    runtime,
    agentName,
    install,
    installReason: verified.ok ? null : verified.reason,
    version,
    linkCandidate,
    selfCheck,
    lastInboundAt: lastSuccessfulDispatchAt(inboundLog),
  };
}

/**
 * 最近一次成功入站分发的时间。**只取时间戳，不碰日志里的任何标识。**
 *
 * 这是历史证据，不是在线证明 —— 渲染时必须原样这么说。
 */
export function lastSuccessfulDispatchAt(file) {
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return null; }
  let found = null;
  for (const line of text.split("\n")) {
    if (!line.includes("dispatch ->")) continue;
    const at = Date.parse(line.slice(0, 24));
    if (Number.isFinite(at)) found = at;
  }
  return found;
}

/**
 * 第 2 层的脱敏视图。
 *
 * 能出的只有计数和人读的名字。endpoint_id / subscription_id / domain_id /
 * agent_uid / transport_open_id / chat_id / sender_ids / local_target_id /
 * legacy_key / pending_token 一个都不出。
 *
 * 群名由调用方从链路模板传进来（模板里本来就有 chat_name，绑定命令一直在打印它）。
 * 订阅投影自己只有 chat_id —— 取不到名字时显示"不可用"，**不拿 ID 顶替**。
 */
export function subscriptionFacts(model, {
  groupName = null, templateChatId = null, now = Date.now(),
} = {}) {
  if (!model || model.ok !== true) {
    return { ok: false, reason: model?.reason ?? "subscription_unavailable" };
  }
  const items = (model.subscriptions ?? []).map((s) => ({
    status: s.status === "active" ? "活动" : "暂停",
    // **群名只能用在它确实对应的那条订阅上。**投影里只有 chat_id，群名在模板里；
    // 无条件套上去的话，指向别的群的订阅会被错报成模板群 ——
    // **一个错的名字比没有名字更难发现**。核对不上就报不可用。
    // feishu-subscribe 那条命令一直是这么做的，这里是向它看齐。
    groupName: (templateChatId !== null && s.scope?.chat_id === templateChatId)
      ? groupName : null,
    senderCount: (s.scope?.sender_ids ?? []).length,
    eventTypes: [...(s.scope?.event_types ?? [])],
  }));
  // **待认领要用跟热路径同一个判据。**直接取数组长度会把已绑定、暂停、过期的
  // 也算进去 —— 一个绑好的项目会显示"待认领"，让人以为还有一步没做完。
  // 同一份投影在 status 显示 1、在 subscribe 显示 0，正是这么来的。
  return { ok: true, items,
    pendingCount: (model.pending_bindings ?? []).filter((b) => claimable(b, now)).length };
}

const relative = (ms, now) => {
  if (!Number.isFinite(ms)) return null;
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  const hours = Math.round(mins / 60);
  return hours < 48 ? hours + " 小时前" : Math.round(hours / 24) + " 天前";
};

/**
 * 组装五个区。**纯函数** —— 取数在外面做，这里只决定"哪条事实属于哪一层"。
 */
/**
 * 把别的链路按它**自己声明的** relation_type 归到对应层。
 *
 * 没声明的留在附录 —— 判不出就不硬归类。上一版所有链路都只能进附录，
 * 因为协议里根本没有这个字段。
 */
const KIND_TEXT = { transport: "消息运输", progress: "进度汇报" };
const STATE_TEXT = { active: "正常", suspended: "已暂停", expired: "已过期", unknown: "状态未知" };
const SCOPE_TEXT = { chat: "整个群", topic: "单个话题", project: "整个项目" };

export function splitByRelation(sections = []) {
  const byLayer = { subscription: [], binding: [], policy: [] };
  const unsorted = [];
  for (const s of sections) {
    const rows = s.state === "ok" ? (s.connections ?? []) : [];
    if (rows.length === 0) { unsorted.push(s); continue; }
    const placed = rows.filter((c) => c.relation && byLayer[c.relation]);
    for (const c of placed) byLayer[c.relation].push({ ...c, displayName: s.displayName });
    if (placed.length < rows.length) {
      unsorted.push({ ...s, connections: rows.filter((c) => !c.relation || !byLayer[c.relation]) });
    }
  }
  return { byLayer, unsorted };
}

const relationRow = (c) => [c.displayName,
  (KIND_TEXT[c.kind] ?? c.kind) + " · " + c.groupName + (c.topicName ? " / " + c.topicName : "") +
  " · " + (SCOPE_TEXT[c.scope] ?? c.scope) + " · " + (STATE_TEXT[c.state] ?? c.state)];

/**
 * 出站路由认不认这个项目。
 *
 * **第 3 层读的是项目内文件，而出站路由走的是登记表 —— 两套。**
 * 它们可以不一致，而不一致的那种状态最难查：状态页理直气壮地报"已绑定 · 第 N 代 ·
 * 有效期 2027"，实际每一轮答复都没进过出站流程，一句错误提示也没有。
 * 这不是假想 —— 线上就这么断了十几个小时，我自己也是先信了第 3 层才判断错的。
 *
 * 三种结论要分开：
 *   · routable  出站认得它
 *   · degraded  项目内绑定在，但登记表里没有 —— **绑定已降级，出站不会工作**
 *   · unknown   登记表读不出来。**不许把"没查清"报成"没问题"**，也不许报成"坏了"
 */
export function outboundRoutingFact({ registryOk, exactCount, routableCount, bound }) {
  if (!bound) return null;                    // 项目内都没有绑定，这一层没什么可说
  if (registryOk !== true) return "unknown";
  // **多于一条也不算正常。**同一个项目在登记表里有两条时，出站挑哪一条是不确定的 ——
  // 报"正常"等于把一个说不清的状态说成说得清。
  if (exactCount > 1) return "ambiguous";
  if (exactCount === 0) return "degraded";
  // **有记录 ≠ 出站会挑到它。**enabled:false 的条目被 loadRegistry 过滤掉，
  // Stop 挑不到 —— 这时报 routable 就是界面说正常、实际发不出去。
  return routableCount === 1 ? "routable" : "disabled";
}

const OUTBOUND_ROUTING_TEXT = {
  degraded: "**绑定已降级** —— 项目内绑定在，但登记表里没有它，出站不会工作。"
    + "跑 /feishu-bind 补登记（复用原话题，不新建）",
  unknown: "说不清（登记表读不出来）—— 没查清，不代表没问题",
  ambiguous: "**登记表里有多条这个项目** —— 出站挑哪一条不确定。先人工只保留一条",
  disabled: "**登记表里这条是停用的** —— 出站会跳过它，答复发不出去",
};

/**
 * 状态页只给人看 key 的前 8 位；why 里可能夹着文件名（含完整 key）或消息 id（locator）——
 * 一律脱敏。判据不在这里：这个函数只转述 inspectRunChannel 的结论。
 */
export function redactRunText(text) {
  // 一份规则（display-safe.mjs）：压平控制符 + 脱敏所有 locator 形状 / 64 位摘要 / UUID。
  return displaySafe(text);
}
const shortKey = (key) => (typeof key === "string" && key.length > 0 ? key.slice(0, 8) : "--------");
// why 可能是整条失败命令连卡片正文（真机实测一行几百字）：状态页是给手机看的，展示边界截断。
const WHY_MAX = 120;
const clipWhy = (text) => {
  const safe = redactRunText(text);
  // 按 code point 截，不按 code unit —— 边界落在 emoji 中间会留下孤立的高代理项（评审探针）。
  const points = Array.from(safe);
  return points.length > WHY_MAX ? points.slice(0, WHY_MAX).join("") + "…（已截断）" : safe;
};

/**
 * 待处理事件第五区里 run 通道那几行 —— **只转述，不判断**：分类来自 inspectRunChannel（与排空同一份判据）。
 * 没查 / 解析不出 / runs 账本打不开 / 绑定暂停未分类，各自明写，不折叠成 0，不伪造成正常。
 */
/** 未路由回复那几行 —— 独立于 runs 账本的事实，runs 读不出时也要渲染（评审探针：曾被提前 return 藏掉）。 */
function unroutedRows(ur) {
  if (ur === undefined || ur === null) return [];
  if (ur.ok === false) return [["未路由回复", "说不清（" + String(ur.reason ?? "unrouted_unreadable") + "）"]];
  const rows = [];
  const problems = ur.problems ?? [];
  if (ur.count > 0 || problems.length > 0) {
    rows.push(["未路由回复", ur.count + " 条（需要人看：" + ur.dir + "）" + (problems.length ? "；另有 " + problems.length + " 个说不清的条目" : "")]);
    for (const x of ur.entries) rows.push(["  " + clipWhy(x.reason), x.why ? clipWhy(x.why) : (x.recordedAt ?? "")]);
    for (const p of problems) rows.push(["  " + clipWhy(p.file), p.reason]);
  }
  return rows;
}

export function runChannelRows(rc, now = Date.now()) {
  if (rc === undefined || rc === null) return [["run 通道", "未查（本次没读 runs 账本）"]];
  const rows = [];
  const problems = rc.runs?.problems ?? [];
  if (rc.inventoryOk === false) {
    const p = problems.find((x) => x.key === null) ?? problems[0];
    rows.push(["run 通道", "说不清（" + (p?.reason ?? "runs 账本读不出") + (p?.why ? "：" + redactRunText(p.why) : "") + "）"]);
    rows.push(...unroutedRows(rc.unrouted));
    return rows;
  }
  if (rc.phase === "unresolved") {
    rows.push(["run 通道", "说不清（" + String(rc.reason ?? "unresolved") + "）；账本里有 " + (rc.waiting?.count ?? 0) + " 条待处理"]);
  } else if (rc.phase === "paused") {
    rows.push(["run 通道", "暂停中未分类：" + (rc.waiting?.count ?? 0) + " 条待处理（恢复绑定后由排空分类处理，符合条件的再发出）"]);
  } else {
    const oldest = relative(rc.waiting?.oldestMs, now);
    rows.push(["run 待发", (rc.waiting?.count ?? 0) + " 条" + (oldest && rc.waiting.count > 0 ? "（最老 " + oldest + "）" : "")]);
    const stuck = rc.runs?.stuck ?? [];
    rows.push(["run 卡住", stuck.length + " 条" + (stuck.length ? "（需要人看）" : "")]);
    for (const x of stuck) rows.push(["  " + shortKey(x.key), x.reason + (x.why ? "：" + clipWhy(x.why) : "")]);
    const du = rc.runs?.deliveredUnrecorded ?? [];
    if (du.length > 0) {
      rows.push(["run 送达未落标", du.length + " 条（下一轮可能重发，先去话题核对）"]);
      for (const x of du) rows.push(["  " + shortKey(x.key), clipWhy(x.error ?? "")]);
    }
  }
  rows.push(...unroutedRows(rc.unrouted));
  // 盘点能读（inventoryOk）时，problems 一条不漏 —— 含 key 为 null 的（不认识的条目、claims 目录读不出）；
  // 评审探针：未绑定的项目里有个未识别文件，曾被同时说成"0 条待处理"和"账本无异常"。
  rows.push(["runs 账本", problems.length ? "说不清 " + problems.length + " 处" : "无异常"]);
  for (const x of problems) rows.push(["  " + shortKey(x.key), x.reason + (x.why ? "：" + clipWhy(x.why) : "")]);
  return rows;
}

export function composeLayeredStatus({
  st, others = [], endpoint, subscription, connectivity = null,
  otherLinks = null, outboundRouting = null, now = Date.now(),
  bindHint = "node scripts/bind-project.mjs --apply",
  // run 通道状态（inspectRunChannel 的结论）。不传 = 没查，第五区明写"未查"，不伪造成 0。
  runChannel = undefined,
  // 另一条链（Codex）的第五区行：调用方按自己的只读投影算好传进来；给了就用它，不再按 run 通道渲染。
  pendingRows = null,
}) {
  const fifthRows = () => (Array.isArray(pendingRows) ? pendingRows : runChannelRows(runChannel, now));
  // 别的链路里能归层的，直接进对应层；归不了的留给附录。
  const split = otherLinks ? splitByRelation(otherLinks.sections) : { byLayer: null, unsorted: [] };
  // **没绑定不等于没有四层。**第 1、2 层照样有事实可报，只是第 3 层还没绑、
  // 第 4 层无从谈起。上一版在这里直接退回旧格式，等于四层模型在最需要它的时候消失。
  const bound = st.ok === true;
  const L1 = [
    ["运行时", endpoint.runtime],
    // 运输 agent 的名字是模板里就有的，报名字比报 UID 有用且不算 locator。
    ["运输 agent", endpoint.agentName ?? "名称不可用"],
    // 上一版把版本号跟运行时拼在一行，被读成了 agent id。它是脚本内容哈希。
    ["运行时版本", endpoint.version
      ?? (endpoint.linkCandidate ? "未通过校验（链接候选 " + endpoint.linkCandidate + "）" : "未安装")],
    ["安装状态", endpoint.install === "ok" ? "已安装"
      : endpoint.install === "absent" ? "未安装"
      // 损坏、漂移、链接异常都不是"正常"，也不是"没装"。
      : "不可用（" + (endpoint.installReason ?? "unknown") + "）"],
    // FR-1.4 做完之前这里只能写"未自检"。现在能查了，就报真实结论 ——
    // 但**没查还是要说没查**：不传 selfCheckReport 时仍是"未自检"，
    // 不能因为代码存在就当成查过了。
    ["实时自检", endpoint.selfCheck?.verdict
      ? SELF_CHECK_TEXT[endpoint.selfCheck.verdict] +
        (endpoint.selfCheck.failed?.length ? "：" + endpoint.selfCheck.failed.join("、") : "") +
        (endpoint.selfCheck.unknown?.length ? "（查不清：" + endpoint.selfCheck.unknown.join("、") + "）" : "")
      : "未自检（本次没跑端点自检）"],
  ];
  const seen = relative(endpoint.lastInboundAt, now);
  if (seen) L1.push(["最近入站", seen + "（历史证据，不代表当前在线）"]);

  const L2 = [];
  if (!subscription.ok) {
    L2.push(["订阅状态", "读不到（" + subscription.reason + "）"]);
  } else if (subscription.items.length === 0 && st.source === "project-files") {
    // **"投影覆盖不到"不等于"没有订阅"。**这个项目的绑定住在项目内文件里，
    // 而订阅投影是从 registry 建的 —— 报"没有事件订阅"就是把看不见说成了不存在。
    L2.push(["订阅状态", "不可用（本项目绑定走项目内文件，订阅投影未覆盖）"]);
  } else if (subscription.items.length === 0) {
    L2.push(["订阅状态", "本项目没有事件订阅"]);
  } else {
    for (const s of subscription.items) {
      L2.push(["订阅状态", s.status]);
      L2.push(["订阅群", s.groupName ?? "群名不可用（只有群 ID，不拿 ID 顶替）"]);
      L2.push(["授权发送者", s.senderCount + " 个"]);
      L2.push(["事件范围", s.eventTypes.join("、") || "未声明"]);
    }
    if (subscription.pendingCount > 0) {
      L2.push(["待认领绑定", subscription.pendingCount + " 条"]);
    }
  }
  for (const c of split.byLayer?.subscription ?? []) L2.push(relationRow(c));

  if (!bound) {
    // not_bound 和"读不出来"必须分开：前者是还没接，后者是配错了或文件坏了。
    // **接入的办法两条链不一样。**写死 Claude 那条命令的话，
    // Codex 侧看到的是一条在它那里跑不通的指令 ——
    // 一个错的下一步比没有下一步更糟。
    const why = st.reason === "not_bound"
      ? "尚未绑定（接入：" + bindHint + "）"
      : "状态不可读（" + (st.reason ?? "unknown") + "）";
    return {
      layers: [
        { n: 1, title: "运行端点连接", rows: L1 },
        { n: 2, title: "事件订阅", rows: L2 },
        { n: 3, title: "精确通道绑定", rows: [["绑定状态", why]] },
        { n: 4, title: "交互策略", rows: [["交互模式", "尚无通道策略（要先有绑定）"]] },
      ],
      // 待处理区也要跟着分开 —— 上一版两种情形共用"不适用（尚未绑定）"，
      // 正是我在第 3 层要求分开的那件事，自己在这里又合回去了。
      pendingEvents: [["待发布答复", st.reason === "not_bound"
        ? "不适用（尚未绑定）" : "不适用（绑定状态不可读）"],
        ...fifthRows()],
      connectivity,
      suspended: false,
    };
  }

  const L3 = [
    // 叫"绑定名称"而不是"话题名"：这是绑定时用的名字，也是话题创建时的标题，
    // 但用户可以在飞书里改名，本地没有读取当前标题的权威事实 —— 说成"话题名"
    // 就是在声称一件我们没查过的事。
    ["绑定名称", st.displayName ? "🌉 " + st.displayName : "名称不可用"],
    // **三种级别，不是两种。**Codex 一条 thread 就是一条 task，
    // 既不是"项目共用"也不是"会话单独绑" —— 落到 else 分支就会写着
    // "整个项目共用一个话题"，那句话在 Codex 侧是错的。
    ["绑定级别", st.level === "session" ? "这条工作线单独绑定"
      : st.level === "task" ? "这条 task 单独一个话题"
      : "整个项目共用一个话题"],
    ["当前代际", st.activeGeneration === null ? "尚未完成首次认领" : "第 " + st.activeGeneration + " 代"],
    ["入站", st.suspended ? "暂停中，话题里的指令一律被拒"
      : st.inboundBound ? "已绑定" : "还差一步：去话题里 @ 一下运输 agent"],
  ];
  // **只在不正常的时候出这一行。**routable 是常态，天天报一句"正常"
  // 会把真正需要注意的那两种淹掉。
  if (outboundRouting !== null && outboundRouting !== "routable") {
    L3.push(["出站路由", OUTBOUND_ROUTING_TEXT[outboundRouting]]);
  }
  if (st.pendingGeneration !== null && st.pendingGeneration !== undefined) {
    L3.push(["待认领代际", "第 " + st.pendingGeneration + " 代" + describePendingWindow(st, { now: Date.now() })]);
  }
  if (st.readOnlyGenerations > 0) {
    L3.push(["历史话题", st.readOnlyGenerations + " 个代际（仍可下指令，回复回原话题）"]);
  }
  if (st.expiresAt) L3.push(["有效期", String(st.expiresAt).slice(0, 10)]);
  if (others.length > 1) L3.push(["本项目绑定数", others.length + " 条"]);
  for (const c of split.byLayer?.binding ?? []) L3.push(relationRow(c));

  const L4 = [
    ["交互模式", st.policy?.ok ? st.policy.label + " · v" + st.policy.policyVersion : "状态不可用"],
  ];
  if (st.policy?.policyId === "dialogue") {
    L4.push(["对话预算", st.policy.roundsStarted + " / " + st.policy.maxRounds + " 轮；" +
      st.policy.resourceUnitsUsed + " / " + st.policy.maxResourceUnits + " 资源单位"]);
    L4.push(["对话状态", st.policy.status + (st.policy.turnActive ? "（有活动回合）" : "")]);
  }
  if (st.activeGeneration !== null) {
    const used = Number.isInteger(st.activeGenerationMessages) ? st.activeGenerationMessages : 0;
    const max = Number.isInteger(st.activeGenerationThreshold) ? st.activeGenerationThreshold : TOPIC_GENERATION_AUTO_ROTATE_MESSAGES;
    L4.push(["自动轮转", used + " / " + max + " 条（还剩 " + Math.max(0, max - used) + " 条）"]);
  }
  // **不许无条件声称"每轮自动发布"**，也不许说得比实际行为满。
  //
  // 2026-08-24 起这个开关真的管住了所有自动发布路径（drainProject 默认遵守它），
  // 所以"仅入队"这个说法现在**是准的**。此前它只被 inbound.mjs 和
  // watch-and-publish.mjs 读，每轮 Stop 和 30 分钟兜底都不读 —— 那时候写"仅入队"
  // 是在承诺一件开关做不到的事，措辞改过两版才追上行为。
  L4.push(["出站发布", st.suspended ? "暂停中，进展留在本地不发出"
    : st.autoPublish === true ? "每轮自动发布"
    : st.autoPublish === false
      ? "仅入队，不自动发布（人工排空可用 --force 绕过）"
      : "状态不可用（读不到发布配置）"]);

  for (const c of split.byLayer?.policy ?? []) L4.push(relationRow(c));

  const L5 = [["待发布答复", st.pending + " 条" + (st.pending && st.suspended ? "（恢复后会发出）" : "")],
    ...fifthRows()];

  return {
    layers: [
      { n: 1, title: "运行端点连接", rows: L1 },
      { n: 2, title: "事件订阅", rows: L2 },
      { n: 3, title: "精确通道绑定", rows: L3 },
      { n: 4, title: "交互策略", rows: L4 },
    ],
    pendingEvents: L5,
    connectivity,
    suspended: st.suspended === true,
  };
}

/**
 * 渲染。两列，标签左值右 —— 卡片在手机上较窄，不做复杂表格。
 *
 * 刻意**不出总判断**：分别陈述才符合这套架构契约。
 */
export function renderLayeredStatus(view) {
  const lines = [];
  const put = (rows) => {
    for (const [k, v] of rows) lines.push("  " + k.padEnd(6, "　") + "  " + v);
  };
  for (const layer of view.layers) {
    lines.push("第 " + layer.n + " 层 · " + layer.title);
    put(layer.rows);
    lines.push("");
  }
  lines.push("待处理事件");
  put(view.pendingEvents);

  if (view.connectivity) {
    lines.push("");
    // 同一个项目的另一条链路（比如 cc2cd 的群级绑定）。按语义它其实属于第 2 层，
    // 但当前协议只有 kind 和 scope，判不出一条连接是订阅、绑定还是策略。
    // **判不出就不硬归类** —— 等协议加上受控的 relation_type 再并进对应层。
    lines.push("本项目的其他链路（尚未分层）");
    lines.push(view.connectivity);
  }
  if (view.suspended) {
    lines.push("", "恢复：node scripts/bind-project.mjs --apply（会复用原话题，不新建）");
  }
  return lines.join("\n");
}
