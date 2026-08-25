#!/usr/bin/env node
/**
 * 查看本项目的事件订阅（第 2 层）。**当前只读，且只有 Claude 侧。**
 *
 * Codex 侧有 buildCodexSubscriptionProjection()，但还没有对应的 CLI / 技能 /
 * 安装入口。把它说成 `$feishu-subscribe`（两侧同名的斜杠命令）是不成立的 ——
 * 那会让人在 Codex 里敲一个不存在的命令。所以这里明确写 `/feishu-subscribe`，
 * Codex 侧标为待迁移。
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
 *          同步计划器和 resnapshot 的**落盘地基也已经有了**
 *          （subscription-sync.mjs / subscription-sync-apply.mjs）——
 *          但控制面没闭环：suspend / migrate 这些动作还没实现。
 *
 *          （上一版这里写的是"控制面还没有"。它自己下面就写着
 *          「说链路不存在在它落地之后就成了假话，而这种假话没人会去复查」——
 *          **而它正是那句假话**：落盘地基落地之后没人回来改这段。
 *          所以现在写的是"有什么、还缺什么"，缺的那半才是拦住写入口的理由。）
 *
 *   FR-2.6 首次认领未命中**唯一** subscription 时必须拒绝。这条判据本身在，
 *          但**没有经过多订阅的真实样本验证**。
 *          "现在全机器只有一条订阅所以不存在歧义"是个没被计算过的断言，
 *          不该写死在源码里当理由 —— 加第二条订阅时没人会回来改它。
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
import { claimable } from "./subscription.mjs";
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
    // **群名只能用在它确实对应的那条订阅上。**多订阅指向不同群时，
    // 把模板群名套给每一条，就会把别的群错报成模板群 ——
    // 那比"群名不可用"糟得多：一个错的名字比没有名字更难发现。
    groupName: (templateChatId !== null && s.scope?.chat_id === templateChatId)
      ? groupName : null,
    senderCount: (s.scope?.sender_ids ?? []).length,
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
      { groupName: tpl?.chat_name ?? null, templateChatId: tpl?.chat_id ?? null },
    ),
    { source: currentBinding({ root }).source ?? null },
  ));
  console.log("\n本命令只读。**增删订阅还没开放**，不是没写代码，是缺前置条件：");
  console.log("  · 改订阅要同步 binding 授权快照并明确暂停/迁移相关 binding（FR-2.5）。");
  console.log("    把同步计划落到授权快照与 binding 状态上的控制面还没有；");
  console.log("    缺了它，写入会造出「订阅说 A、授权快照仍说 B」的状态。");
  console.log("  · 多于一条订阅时首次认领必须能拒绝歧义（FR-2.6），该路径未经真实样本验证。");
}

if (isDirectRun(import.meta.url)) main();
