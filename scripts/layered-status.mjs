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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 端点自检尚未实现。这个常量存在本身就是为了让"未实现"是显式的，而不是遗漏。 */
export const ENDPOINT_SELF_CHECK = "not_implemented";

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
export function endpointFacts({
  runtime = "Claude Code",
  agentName = null,
  runtimeDir = runtimeDirDefault(),
  inboundLog = inboundLogDefault(),
} = {}) {
  let version = null;
  try {
    const target = fs.readlinkSync(path.join(runtimeDir, "current"));
    version = path.basename(target).slice(0, 12);
  } catch { /* 没装或读不到 */ }

  return {
    runtime,
    agentName,
    installed: version !== null,
    version,
    selfCheck: ENDPOINT_SELF_CHECK,
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
export function subscriptionFacts(model, { groupName = null } = {}) {
  if (!model || model.ok !== true) {
    return { ok: false, reason: model?.reason ?? "subscription_unavailable" };
  }
  const items = (model.subscriptions ?? []).map((s) => ({
    status: s.status === "active" ? "活动" : "暂停",
    // 投影里只有 chat_id，但群名在链路模板里就有（绑定命令一直在打印它）。
    // 上一版报"群名不可用"是我没把它接过来，不是真的没有。
    groupName,
    senderCount: (s.scope?.sender_ids ?? []).length,
    eventTypes: [...(s.scope?.event_types ?? [])],
  }));
  return { ok: true, items, pendingCount: (model.pending_bindings ?? []).length };
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
export function composeLayeredStatus({
  st, others = [], endpoint, subscription, connectivity = null, now = Date.now(),
}) {
  const L1 = [
    ["运行时", endpoint.runtime],
    // 运输 agent 的名字是模板里就有的，报名字比报 UID 有用且不算 locator。
    ["运输 agent", endpoint.agentName ?? "名称不可用"],
    // 上一版把版本号跟运行时拼在一行，被读成了 agent id。它是脚本内容哈希。
    ["运行时版本", endpoint.version ?? "未安装"],
    ["安装状态", endpoint.installed ? "已安装" : "未安装"],
    // FR-1.4 未实现。写出来，别让空白被读成"没问题"。
    ["实时自检", "未自检（端点自检 FR-1.4 尚未实现）"],
  ];
  const seen = relative(endpoint.lastInboundAt, now);
  if (seen) L1.push(["最近入站", seen + "（历史证据，不代表当前在线）"]);

  const L2 = [];
  if (!subscription.ok) {
    L2.push(["订阅状态", "读不到（" + subscription.reason + "）"]);
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

  const L3 = [
    // 话题标题就是「🌉 项目名」。上一版删掉总判断那行时，把项目名一起弄丢了。
    ["话题", st.displayName ? "🌉 " + st.displayName : "名称不可用"],
    ["绑定级别", st.level === "session"
      ? "这条工作线单独绑定"
      : "整个项目共用一个话题"],
    ["当前代际", st.activeGeneration === null ? "尚未完成首次认领" : "第 " + st.activeGeneration + " 代"],
    ["入站", st.suspended ? "暂停中，话题里的指令一律被拒"
      : st.inboundBound ? "已绑定" : "还差一步：去话题里 @ 一下运输 agent"],
  ];
  if (st.pendingGeneration !== null && st.pendingGeneration !== undefined) {
    L3.push(["待认领代际", "第 " + st.pendingGeneration + " 代" +
      (st.pendingGenerationExpiresAt ? "（截止 " + String(st.pendingGenerationExpiresAt).slice(0, 10) + "）" : "")]);
  }
  if (st.readOnlyGenerations > 0) {
    L3.push(["只读历史", st.readOnlyGenerations + " 个代际（不再接收新指令）"]);
  }
  if (st.expiresAt) L3.push(["有效期", String(st.expiresAt).slice(0, 10)]);
  if (others.length > 1) L3.push(["本项目绑定数", others.length + " 条"]);

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
    const max = Number.isInteger(st.activeGenerationThreshold) ? st.activeGenerationThreshold : 30;
    L4.push(["自动轮转", used + " / " + max + " 条（还剩 " + Math.max(0, max - used) + " 条）"]);
  }
  L4.push(["出站发布", st.suspended ? "暂停中，进展留在本地不发出" : "每轮自动发布"]);

  const L5 = [["待发布答复", st.pending + " 条" + (st.pending && st.suspended ? "（恢复后会发出）" : "")]];

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
