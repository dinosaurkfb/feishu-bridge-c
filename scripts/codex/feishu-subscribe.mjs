#!/usr/bin/env node
/**
 * 查看当前 Codex task 的事件订阅（第 2 层）。**只读。**
 *
 * ■ 跟 Claude 侧共用什么
 *
 * 脱敏视图（subscriptionDetails）和渲染（renderSubscriptions）都直接复用 Claude
 * 那一份。**两处分叉就会出现"一个命令说能看、另一个说不能看"**，
 * 而使用者没法知道哪个才是承诺。这里只换投影来源：
 * Claude 从 projects 建，Codex 从 tasks 建，核心读模型是同一个。
 *
 * ■ 写入口的现状（2026-09-02 更新）
 *
 * 发送者角色表的登记入口已开放（`register-sender.mjs --template <Codex 的 chain-config.json> …`，写入需 owner 逐次授权）。
 * 订阅控制面的登记入口也已开放（FR-2.6 单 1：`register-subscription.mjs`，落盘独立 store，owner 逐次授权），
 * 但 store 尚未接入权威投影与切流 —— 落盘暂不改变生产认领 / 路由（切流前置：chat locator 验证与
 * 多订阅歧义的真实样本；FR-2.5 的落盘控制面 subscription-sync-apply.mjs 已经完成）。本命令与 Claude 侧一样，
 * 把 store 里已登记的条目并进展示（只读；文件缺席的机器输出与以前逐字节一致），生产认领 / 路由仍走纯 legacy 投影。
 */

import { isDirectRun } from "../direct-run.mjs";
import { renderSubscriptions, subscriptionDetails } from "../feishu-subscribe.mjs";
import { mergedSubscriptionView } from "../subscription-store.mjs";
import { validThreadId } from "./bind-compose.mjs";
import {
  bridgeHome, buildCodexSubscriptionProjection, findRegisteredTaskForCodexThread, loadCodexTemplate,
} from "./state.mjs";

/** 严格白名单：拼错的参数不许静默退化成"看默认的那条"。 */
const OPTIONS = new Set(["thread-id"]);

export function parseArgs(tokens) {
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

const WRITE_NOTE = [
  "",
  "这条命令只读 —— 发送者角色表可用 register-sender.mjs 登记（写入需 owner 逐次授权）；订阅控制面的登记入口已开放（register-subscription.mjs，落盘独立 store，同样 owner 逐次授权）：",
  "  · 但 store 尚未接入权威投影与切流 —— 落盘暂不改变生产认领 / 路由，本命令把已登记的条目并进展示（只读）；",
  "  · 接入（切流）的前置：chat locator 验证与多订阅歧义的真实样本。",
].join("\n");

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const threadId = parsed.seen.get("thread-id");
  if (!validThreadId(threadId)) {
    console.error("缺少 hook 提供的精确 --thread-id；拒绝猜测或使用 --last。");
    process.exit(1);
  }

  const home = bridgeHome();
  const found = findRegisteredTaskForCodexThread({ threadId, home });
  if (!found.ok) {
    // **"这条没绑"和"读不出来"是两回事。**前者是正常状态，后者是故障。
    if (found.reason === "thread_not_registered") {
      console.log("当前 Codex task 尚未接入飞书，没有对应的事件订阅。");
      console.log(WRITE_NOTE);
      process.exit(0);
    }
    console.error("无法读取这条 task：" + found.reason);
    process.exit(1);
  }

  const loaded = loadCodexTemplate();
  const tpl = loaded?.ok ? loaded.template : null;
  // 评审 #114 P1：与 Claude 侧共用 mergedSubscriptionView —— 读生产默认 store + 合并 + 损坏退 legacy。
  const { view: model, corrupt } = mergedSubscriptionView({ legacy: buildCodexSubscriptionProjection({ home, threadId }) });
  const view = subscriptionDetails(model,
    // **群名只能用在它确实对应的那条订阅上。**把模板群名套给每一条，
    // 就会把别的群错报成模板群 —— 一个错的名字比没有名字更难发现。
    // **优先用这条 task 自己的群事实**（task 支持覆盖 chat_id/chat_name）——
    // 只传模板的话，一个已知群名的 task 会被报成"群名不可用"。
    { groupName: found.task?.chat_name ?? tpl?.chat_name ?? null,
      templateChatId: found.task?.chat_id ?? tpl?.chat_id ?? null });

  console.log(renderSubscriptions(view));
  if (corrupt) console.log("\n注意：控制面 store 损坏（" + corrupt.length + " 个问题），已按 legacy 显示。");
  console.log(WRITE_NOTE);
  process.exit(0);
}

if (isDirectRun(import.meta.url)) main();
