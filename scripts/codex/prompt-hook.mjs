#!/usr/bin/env node
/** Codex UserPromptSubmit：记录精确 thread 活跃租约，并为飞书控制动作注入确定性命令。 */

import fs from "node:fs";
import path from "node:path";

import {
  bridgeHome, findRegisteredTaskForCodexThread, loadCodexTemplate, recordThreadActivity,
} from "./state.mjs";

export function classifyFeishuPrompt(prompt) {
  if (typeof prompt !== "string") return "none";
  const p = prompt.trim();
  if (p === "/init") return "init";
  // Desktop 会把显式技能调用序列化成 `[$skill](/absolute/SKILL.md)`；CLI 则可能保留裸 `$skill`。
  if (/\$feishu-unbind\b/u.test(p)) return "unbind";
  if (/\$feishu-status\b/u.test(p)) return "status";
  if (/\$feishu-bind\b/u.test(p)) return "bind";
  if (/(?:是否|是不是|能否|能不能|可不可以|可以).{0,20}(?:加|新增|提供|支持).{0,8}(?:命令|功能)/u.test(p)) {
    return "none";
  }
  if (/^(?:请)?(?:把|将)?(?:当前|这个).{0,12}(?:撤销|解除|断开|暂停).{0,8}飞书(?:接入|连接|绑定)/u.test(p) ||
      /^(?:撤销|解除|断开|暂停)飞书(?:接入|连接|绑定)$/u.test(p)) return "unbind";
  if (/^(?:请)?(?:查看|检查|查询|显示).{0,12}(?:当前|这个)?.{0,8}飞书(?:接入|连接|绑定)?状态/u.test(p) ||
      /^飞书(?:接入|连接|绑定)?状态$/u.test(p)) return "status";
  if (/(?:接(?:入|到)?|绑定(?:到)?).{0,12}飞书/u.test(p) ||
      /飞书.{0,8}(?:接入|绑定|建(?:立)?话题)/u.test(p) ||
      /(?:创建|新建|建).{0,8}飞书话题/u.test(p)) return "bind";
  return "none";
}

export function isBindingPrompt(prompt) {
  return classifyFeishuPrompt(prompt) === "bind";
}

export function isAilyInvocation(env = process.env) {
  return ["AILY_CLI_SESSION_ID", "AILY_CLI_RUN_ID", "AILY_CLI_CALLER_AGENT_UID"]
    .some((name) => typeof env[name] === "string" && env[name].length > 0);
}

export function composeBindingContext({ bridgeRoot, cwd, threadId, chatName }) {
  const apply = path.join(bridgeRoot, "scripts", "codex", "bind-task.mjs");
  return [
    "[Codex 飞书桥] 当前任务的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "用户本轮明确要求将当前 task 接入飞书；本次要求本身就是创建根话题并登记当前 task 的授权，无需再次预览或确认。",
    "直接运行以下幂等绑定命令：",
    "`node " + apply + " --project " + JSON.stringify(cwd) + " --thread-id " + threadId + " --apply`",
    "目标群：" + (chatName ?? "机器级配置中的群") + "。若已接入则不得重复建话题；若已暂停则只恢复原连接。",
  ].join("\n");
}

export function composeUnbindContext({ bridgeRoot, threadId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-unbind.mjs");
  return [
    "[Codex 飞书桥·暂停接入] 用户通过 $feishu-unbind 明确要求撤销当前 task 的飞书接入。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下可恢复的本地暂停命令：",
    "`node " + command + " --thread-id " + threadId + " --apply`",
    "命令不会向飞书发送消息或删除话题；不要直接编辑 registry，也不要把 locator 输出给用户。",
  ].join("\n");
}

export function composeStatusContext({ bridgeRoot, threadId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-status.mjs");
  return [
    "[Codex 飞书桥·连接状态] 用户要求只读查看当前 task 的飞书状态。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下只读命令，并用简洁自然语言转述 stdout：",
    "`node " + command + " --thread-id " + threadId + "`",
    "不得直接读取或输出 registry、locator、凭据、claim 或 receipt。",
  ].join("\n");
}

export function composeInitContext({ connectionStatus = "none" } = {}) {
  if (connectionStatus === "active") return [
    "[Codex 飞书桥·/init 适配] 这是 Codex 官方 /init，不是飞书绑定命令。",
    "先完整执行 /init 原本的 AGENTS.md 初始化；不要运行任何飞书桥脚本。",
    "只有初始化确实成功后，才在最终回复中说明当前 task 已接入飞书；无需再次询问。",
  ].join("\n");
  const question = connectionStatus === "paused"
    ? "项目初始化完成。是否恢复当前 Codex task 的飞书接入？如需要，请回复“接入飞书”。"
    : "项目初始化完成。是否将当前 Codex task 接入飞书？如需要，请回复“接入飞书”。";
  return [
    "[Codex 飞书桥·/init 适配] 这是 Codex 官方 /init，不是飞书绑定命令。",
    "先完整执行 /init 原本的 AGENTS.md 初始化；本轮不要运行任何飞书桥脚本，也不要创建飞书话题。",
    "只有初始化确实成功后，才在最终回复末尾逐字询问：\n“" + question + "”",
    "初始化失败时不要询问。后续用户明确回复“接入飞书”后，直接执行独立绑定流程，不再要求第二次确认。",
  ].join("\n");
}

export function composeAilyInboundContext({ bridgeRoot, home }) {
  const inbound = path.join(bridgeRoot, "scripts", "codex", "inbound.mjs");
  const command = "FEISHU_CODEX_BRIDGE_HOME=" + JSON.stringify(home) +
    " node " + JSON.stringify(inbound);
  return [
    "[Codex 飞书桥·M5Codex 入站] 当前回合来自 Aily 的 M5Codex 飞书调用。",
    "不得运行 bind-preview.mjs、bind-task.mjs 或 codex-longtask-feishu；不得把 M5Codex 自己的 Aily task 接到飞书。",
    "只执行以下命令，不加参数：",
    "`" + command + "`",
    "把命令的 stdout 原样作为回复，不增删、解释或改写。脚本会自行判断首次绑定、拒绝或投递。",
  ].join("\n");
}

export function composeRoutedCodexContext() {
  return [
    "[Codex 飞书桥·已路由指令] 当前回合已经由 M5Codex 完成信封校验、claim 和精确 task 路由。",
    "你现在是目标 Codex task，不是 M5Codex 入站运输进程。",
    "禁止调用 m5codex-inbound-router 或再次获取 Aily 消息信封；直接执行用户交付的项目指令。",
  ].join("\n");
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function main() {
  const payload = readPayload() ?? {};
  const isRoutedCodexRun = process.env.FEISHU_BRIDGE_ROLE === "codex-run";
  // M5Codex 的飞书回合也是 codex-local，会继承本机 hooks；它属于入站数据面，必须用
  // developer 级上下文盖过历史回合里可能残留的控制面指令。只给配置中的唯一 agent 注入，
  // 其他 Aily agent fail-closed。确定性 sender/session/mention 校验仍全部留在 inbound.mjs。
  // codex-run 必须优先：即使上游误把 AILY_CLI_* 传进来，也不能递归进入入站路由。
  if (!isRoutedCodexRun && isAilyInvocation()) {
    const tpl = loadCodexTemplate();
    if (!tpl.ok || process.env.AILY_CLI_CALLER_AGENT_UID !== tpl.template.agent_uid ||
        typeof tpl.template.bridge_root !== "string") process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: composeAilyInboundContext({
          bridgeRoot: tpl.template.bridge_root,
          home: bridgeHome(),
        }),
      },
    }) + "\n");
    return;
  }
  const threadId = payload.session_id;
  if (typeof threadId !== "string" || !threadId) process.exit(0);
  const cwd = payload.cwd;
  const action = classifyFeishuPrompt(payload.prompt);
  const bindingIntent = action === "bind";
  const registered = findRegisteredTaskForCodexThread({ threadId });

  // 普通未绑定 Codex task 不应被桥收集 locator。只有已绑定 task，或用户正在明确接桥时，
  // 才需要这份 lease。
  if (registered.ok || bindingIntent) {
    recordThreadActivity({
      threadId,
      turnId: payload.turn_id,
      cwd,
      active: true,
      eventName: "UserPromptSubmit",
    });
  }

  if (isRoutedCodexRun) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: composeRoutedCodexContext(),
      },
    }) + "\n");
    return;
  }
  if (action === "init") {
    const connectionStatus = registered.ok ? (registered.task.status ?? "active") : "none";
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: composeInitContext({ connectionStatus }),
      },
    }) + "\n");
    return;
  }
  if (action === "none") process.exit(0);
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) process.exit(0);

  const tpl = loadCodexTemplate();
  if (!tpl.ok || typeof tpl.template.bridge_root !== "string") process.exit(0);
  let additionalContext;
  if (action === "bind") {
    additionalContext = composeBindingContext({
      bridgeRoot: tpl.template.bridge_root,
      cwd,
      threadId,
      chatName: tpl.template.chat_name,
    });
  } else if (action === "unbind") {
    additionalContext = composeUnbindContext({ bridgeRoot: tpl.template.bridge_root, threadId });
  } else if (action === "status") {
    additionalContext = composeStatusContext({ bridgeRoot: tpl.template.bridge_root, threadId });
  } else {
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  }) + "\n");
}

if (import.meta.url === "file://" + process.argv[1]) {
  main().catch(() => process.exit(0));
}
