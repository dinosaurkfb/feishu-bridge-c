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
 * ■ 为什么现在还不能写
 *
 * 跟 Claude 侧同样的两条硬约束，缺一条就会让写入制造出比不写更糟的状态：
 *
 *   FR-2.5 订阅变更必须**同步到依赖它的 binding 授权快照**；暂停或撤销时，
 *          相关 binding 必须被明确暂停或迁移，不能靠日常热路径重新解释配置。
 *          **resnapshot 那一步的落盘地基已经有了**（subscription-sync-apply.mjs），
 *          但控制面没闭环：suspend / migrate 这些动作还没实现。
 *
 *   FR-2.6 首次认领未命中**唯一** subscription 时必须拒绝。这条判据本身在，
 *          但**没有经过多订阅的真实样本验证**。
 *          "现在只有一条所以不会有歧义"是个没被计算过的断言，
 *          不该写死在源码里当理由 —— 加第二条订阅时没人会回来改它。
 *
 * **一个假装能写、实际拒绝的开关比没有开关更糟。**所以这条命令只读，
 * 并如实说明写为什么没开。
 *
 * 用法：node scripts/codex/feishu-subscribe.mjs --thread-id <hook 给的精确 id>
 */

import { isDirectRun } from "../direct-run.mjs";
import { renderSubscriptions, subscriptionDetails } from "../feishu-subscribe.mjs";
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
  "这条命令只读 —— **写入口还没开**，原因写在脚本头部：",
  "  · 订阅变更要同步到 binding 授权快照：落盘地基已有，但 suspend / migrate 未实现，控制面没闭环；",
  "  · 首次认领未命中唯一订阅时必须拒绝，而这条没经过多订阅的真实样本验证。",
  "在同步机制到位之前开放写，等于让人能造出「订阅说 A、授权快照仍说 B」的状态 ——",
  "那种不一致只会在下一条消息被拒时才暴露。",
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
  const view = subscriptionDetails(
    buildCodexSubscriptionProjection({ home, threadId }),
    // **群名只能用在它确实对应的那条订阅上。**把模板群名套给每一条，
    // 就会把别的群错报成模板群 —— 一个错的名字比没有名字更难发现。
    // **优先用这条 task 自己的群事实**（task 支持覆盖 chat_id/chat_name）——
    // 只传模板的话，一个已知群名的 task 会被报成"群名不可用"。
    { groupName: found.task?.chat_name ?? tpl?.chat_name ?? null,
      templateChatId: found.task?.chat_id ?? tpl?.chat_id ?? null });

  console.log(renderSubscriptions(view));
  console.log(WRITE_NOTE);
  process.exit(0);
}

if (isDirectRun(import.meta.url)) main();
