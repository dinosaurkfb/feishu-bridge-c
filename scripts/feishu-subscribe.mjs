#!/usr/bin/env node
/**
 * 查看本项目的事件订阅（第 2 层）。**当前只读。**
 *
 * status 第 2 层给的是一行概览；这条命令给全貌 —— 允许哪些发送者、哪些事件类型、
 * 新鲜度约束、有没有待认领的绑定。FR-10 要求 status 能答"subscription 命中范围"，
 * 这是那个范围的详细版。
 *
 * ■ 为什么现在还不能写
 *
 * FR-2 对写有两条硬约束，缺一条就会让写入制造出比不写更糟的状态：
 *
 *   FR-2.5 订阅变更必须**同步到依赖它的 binding 授权快照**；暂停或撤销时，
 *          相关 binding 必须被明确暂停或迁移，**不能靠日常热路径重新解释配置**。
 *          投影机制已经有（dialogue-binding-authorization.mjs），
 *          但"改订阅 → 同步快照 → 暂停/迁移 binding"这条链路还没有。
 *
 *   FR-2.6 首次认领未命中**唯一** subscription 时必须拒绝。现在全机器只有一条订阅，
 *          不存在歧义；加第二条就会有，而歧义处理没经过真实样本验证。
 *
 * 写入口不是"再写几行代码"的事：**在同步机制到位之前开放写，等于让人能造出
 * 一个订阅说 A、绑定授权快照仍说 B 的状态**，而那种不一致只会在下一条消息被拒时
 * 才暴露。路线图也把多订阅权威路由排在一串验收之后。
 *
 * 所以这条命令现在只读，并如实说明写为什么没开 —— 一个假装能写、实际拒绝的开关
 * 比没有开关更糟。
 *
 * 用法：node scripts/feishu-subscribe.mjs [--project /abs/dir]
 */

import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { buildClaudeSubscriptionProjection } from "./inbound-route.mjs";
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
export function subscriptionDetails(model, { groupName = null } = {}) {
  if (!model || model.ok !== true) {
    return { ok: false, reason: model?.reason ?? "subscription_unavailable" };
  }
  const items = (model.subscriptions ?? []).map((s) => ({
    status: s.status === "active" ? "活动" : "暂停",
    groupName,
    senderCount: (s.scope?.sender_ids ?? []).length,
    eventTypes: [...(s.scope?.event_types ?? [])],
    freshnessMs: Number.isFinite(s.constraints?.freshness_ms) ? s.constraints.freshness_ms : null,
    version: s.version ?? null,
  }));
  return { ok: true, items, pendingCount: (model.pending_bindings ?? []).length };
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
    lines.push("订阅群    " + (s.groupName ?? "群名不可用（只有群 ID，不拿 ID 顶替）"));
    lines.push("授权发送者 " + s.senderCount + " 个（只出数量，不出身份）");
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

  console.log("项目      " + root);
  console.log(renderSubscriptions(
    subscriptionDetails(
      buildClaudeSubscriptionProjection({ projectRoot: root }),
      { groupName: tpl?.chat_name ?? null },
    ),
    { source: currentBinding({ root }).source ?? null },
  ));
  console.log("\n本命令只读。**增删订阅还没开放**，不是没写代码，是缺前置条件：");
  console.log("  · 改订阅要同步 binding 授权快照并明确暂停/迁移相关 binding（FR-2.5），");
  console.log("    那条链路还没有；缺了它，写入会造出「订阅说 A、授权快照仍说 B」的状态。");
  console.log("  · 多于一条订阅时首次认领必须能拒绝歧义（FR-2.6），该路径未经真实样本验证。");
}

if (isDirectRun(import.meta.url)) main();
