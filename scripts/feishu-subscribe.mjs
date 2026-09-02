#!/usr/bin/env node
/**
 * 查看本项目的事件订阅（第 2 层）。**只读。**两条链各有一条：Claude `/feishu-subscribe`，Codex `$feishu-subscribe`
 * （Codex 那条复用这里的脱敏视图与渲染，只换投影来源）。
 *
 * 写入口的现状（2026-09-02 更新）：**发送者角色表的登记入口已开放**（`register-sender.mjs`，改链路模板的 senders，
 * 写入需 owner 逐次授权）；**订阅控制面的登记入口也已开放**（FR-2.6 单 1：`register-subscription.mjs`，
 * 落盘到独立 store，同样 owner 逐次授权）—— 但 store **尚未接入权威投影与切流**：落盘暂不改变生产
 * 认领 / 路由（生产调用方仍走纯 legacy 投影；接入是切流单的事，前置是 chat locator 验证与
 * 多订阅歧义的真实样本）。本命令把 store 里已登记的条目并进展示（FR-2.6 单 3，只读；
 * store 文件缺席的机器输出与以前逐字节一致），生产认领 / 路由仍走纯 legacy 投影。
 *
 * status 第 2 层给的是一行概览；这条命令给全貌 —— 允许哪些发送者、哪些事件类型、
 * 新鲜度约束、有没有待认领的绑定。FR-10 要求 status 能答"subscription 命中范围"，
 * 这是那个范围的详细版。
 *
 * ■ 写入口的现状（2026-09-02，逐项说清“有什么、还缺什么”，别再让这段话在事实变了之后留着）
 *
 *   已开放：**发送者角色表**的登记 —— `register-sender.mjs` 改链路模板的 senders（锁内重读重算、先校验后写、
 *          备份 + 逐字读回；写入需 owner 逐次授权）。本层只登记与显示；入站判定在第 2 层按角色 × 风险等级 × 模式决定（risk-class / authorize）。
 *   已开放：**独立订阅的登记** —— `register-subscription.mjs` 落盘到独立 store（锁内重读重算、先校验后写、备份 + 逐字读回；
 *          写入需 owner 逐次授权）。本层只登记与显示。
 *   已完成：FR-2.5 的落盘控制面 —— 同步计划器（subscription-sync.mjs）与 resnapshot / suspend / migrate 的落盘
 *          （subscription-sync-apply.mjs）都在，订阅变更能同步到依赖它的 binding 授权快照。
 *   未接入：**store 尚未接入权威投影与切流** —— 落盘暂不改变生产认领 / 路由（接入是切流单的事，前置是 chat locator
 *          验证与多订阅歧义的真实样本）。生产调用方仍走纯 legacy 投影，本命令把已登记的条目并进展示。
 *
 * 所以这条命令只读，并如实说明哪些写入口开了、哪些还没接 —— 一个假装能写、实际拒绝的开关比没有开关更糟。
 *
 * 用法：node scripts/feishu-subscribe.mjs [--project /abs/dir]
 */

import path from "node:path";
import { displaySafe } from "./display-safe.mjs";
import { roleCounts, roleCountsText } from "./sender-roles.mjs";

import { isDirectRun } from "./direct-run.mjs";
import { buildClaudeSubscriptionProjection } from "./inbound-route.mjs";
import { claimable } from "./subscription.mjs";
import { mergedSubscriptionView } from "./subscription-store.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { currentBinding } from "./feishu-control.mjs";

const OPTIONS = new Set(["project"]);

/** 严格白名单：拼错的参数不许静默退化成"看默认项目"。 */
function parseArgs(tokens) {
  const seen = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (typeof t !== "string" || !t.startsWith("--")) {
      return { ok: false, reason: "unexpected_argument", detail: t };
    }
    const name = t.slice(2);
    if (seen.has(name)) return { ok: false, reason: "duplicate_option", detail: t };
    if (!OPTIONS.has(name)) return { ok: false, reason: "unknown_option", detail: t };
    const value = tokens[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      return { ok: false, reason: "option_needs_value", detail: t };
    }
    seen.set(name, value);
    i += 1;
  }
  return { ok: true, seen };
}

const MINUTE = 60_000;

/**
 * 脱敏视图。**跟 status 第 2 层同一套规则** —— 两处分叉就会出现
 * "一个命令说能看、另一个说不能看"，而使用者没法知道哪个才是承诺。
 *
 * 不出：endpoint_id、subscription_id、domain_id、agent_uid、transport_open_id、
 * chat_id、sender_ids、local_target_id、legacy_key、pending_token。
 */
export function subscriptionDetails(model, { groupName = null, templateChatId = null, now = Date.now() } = {}) {
  if (!model || model.ok !== true) {
    return { ok: false, reason: model?.reason ?? "subscription_unavailable" };
  }
  const items = (model.subscriptions ?? []).map((s) => ({
    status: s.status === "active" ? "活动" : "暂停",
    // **群名三级（FR-2.6 单 3）：条目自带的 chat_name（1.1 登记时录入，控制面条目才有）>
    // 模板匹配 > 群名不可用。**多订阅指向不同群时，模板群名只许套给它确实对应的那条 ——
    // 把模板群名套给每一条，就会把别的群错报成模板群，那比"群名不可用"糟得多：
    // 一个错的名字比没有名字更难发现。
    groupName: (typeof s.chat_name === "string" && s.chat_name.trim())
      ? s.chat_name
      : ((templateChatId !== null && s.scope?.chat_id === templateChatId) ? groupName : null),
    senderCount: (s.scope?.sender_ids ?? []).length,
    roleCounts: roleCounts(s.scope?.sender_roles ?? (s.scope?.sender_ids ?? []).map((id) => ({ open_id: id, role: "owner" }))),
    eventTypes: [...(s.scope?.event_types ?? [])],
    freshnessMs: Number.isFinite(s.constraints?.freshness_ms) ? s.constraints.freshness_ms : null,
    version: s.version ?? null,
  }));
  // **待认领要用跟热路径同一个判据。**直接取数组长度会把已绑定、暂停、过期的
  // 也算进去 —— 一个绑好的项目会显示"待认领"，让人以为还有一步没做完。
  const pendingCount = (model.pending_bindings ?? []).filter((b) => claimable(b, now)).length;
  return { ok: true, items, pendingCount };
}

export function renderSubscriptions(view, { source = null } = {}) {
  if (!view.ok) return "读不到订阅（" + view.reason + "）。";
  if (view.items.length === 0 && source === "project-files") {
    // **"投影覆盖不到"不等于"没有订阅"。**这个项目的绑定住在项目内文件里，
    // 而订阅投影是从 registry 建的 —— 报"没有订阅"就是把看不见说成了不存在。
    // status 第 2 层已经栽过一次，这里不能再栽。
    return "订阅状态  不可用（本项目绑定走项目内文件，订阅投影未覆盖）";
  }
  if (view.items.length === 0) return "本项目没有事件订阅。";

  const lines = [];
  for (const s of view.items) {
    lines.push("订阅状态  " + s.status + (s.version ? " · v" + s.version : ""));
    lines.push("订阅群    " + (s.groupName == null ? "群名不可用（只有群 ID，不拿 ID 顶替）" : displaySafe(s.groupName)));
    lines.push("授权发送者 " + s.senderCount + " 个（只出数量，不出身份）");
    lines.push("发送者角色 " + roleCountsText(s.roleCounts) + "（入站判定按角色 × 风险等级 × 模式：Mapping 只放 owner；Dialogue 的对话对 operator / participant 开，控制与授权类只认 owner）");
    lines.push("事件范围  " + (s.eventTypes.join("、") || "未声明"));
    lines.push("新鲜度    " + (s.freshnessMs === null ? "未声明"
      : Math.round(s.freshnessMs / MINUTE) + " 分钟内的事件才受理"));
  }
  if (view.pendingCount > 0) lines.push("待认领绑定 " + view.pendingCount + " 条");
  return lines.join("\n");
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const root = path.resolve(parsed.seen.get("project") ?? process.cwd());
  const loaded = loadChainTemplate();
  const tpl = loaded?.ok ? (loaded.template ?? loaded) : null;

  // FR-2.6 单 3 / 评审 #114 P1：展示口把 store 的控制面条目并进读模型。**四条入口共用**
  // mergedSubscriptionView 一条合并路径（读生产默认 store + mergeControlPlaneIntoModel 同一条
  // 路径，含 endpoint 隔离与损坏 fail-closed）。**文件缺席 = 今天**：输出逐字节一致。
  // 损坏不崩：退回 legacy 字段并注明；热路径（认领 / 路由）一行不碰。
  const { view, corrupt } = mergedSubscriptionView({ legacy: buildClaudeSubscriptionProjection({ projectRoot: root }) });

  console.log("项目      " + root);
  console.log(renderSubscriptions(
    subscriptionDetails(view, { groupName: tpl?.chat_name ?? null, templateChatId: tpl?.chat_id ?? null }),
    { source: currentBinding({ root }).source ?? null },
  ));
  if (corrupt) {
    console.log("\n注意：控制面 store 损坏（" + corrupt.length + " 个问题），已按 legacy 显示。");
  }
  console.log("\n本命令只读。**发送者角色表可以登记**（node scripts/register-sender.mjs，改链路模板的 senders；写入需 owner 逐次授权）。");
  console.log("**订阅控制面的登记入口已开放**（node scripts/register-subscription.mjs，落盘独立 store；写入需 owner 逐次授权），但 store **尚未接入权威投影与切流** —— 落盘暂不改变生产认领 / 路由；本命令把已登记的条目并进展示（FR-2.6 单 3，只读）。");
}

if (isDirectRun(import.meta.url)) main();
