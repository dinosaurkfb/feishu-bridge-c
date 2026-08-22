#!/usr/bin/env node
/** Codex UserPromptSubmit：记录精确 thread 活跃租约，并为飞书控制动作注入确定性命令。 */

import fs from "node:fs";
import path from "node:path";

import {
  bridgeHome, findRegisteredTaskForCodexThread, loadCodexTemplate, recordThreadActivity, taskPaths,
} from "./state.mjs";
import { storeTurnInput } from "../turn-input.mjs";

export function classifyFeishuPrompt(prompt) {
  if (typeof prompt !== "string") return "none";
  const p = prompt.trim().replace(/(?:(?:&#x20;|&nbsp;)\s*)+$/gu, "").trim();
  const commandText = p.replace(/(?:&#x20;|&nbsp;)/gu, " ").trim();
  if (commandText === "/init") return "init";

  // 控制动作必须占据整条输入。CLI 保留裸 `$skill`；Desktop 会把显式技能调用序列化成
  // `[$skill](/absolute/.../$skill/SKILL.md)`。不能只查正文里有没有 token：用户可能正在
  // 讨论命令、粘贴 Agent 输出或引用旧消息，那些都没有控制授权。
  const bareMode = /^\$feishu-mode(?:\s+(dialogue|mapping))?$/u.exec(commandText);
  if (bareMode) return bareMode[1] ? "mode-" + bareMode[1] : "mode";
  const bare = /^\$(feishu-bind|feishu-unbind|feishu-status|feishu-rotate)$/u.exec(commandText);
  if (bare) return bare[1].slice("feishu-".length);

  const linkedMode = /^\[\$feishu-mode\]\(([^\r\n)]+)\)(?:\s+(dialogue|mapping))?$/u.exec(commandText);
  if (linkedMode) {
    const target = linkedMode[1].replace(/\\/gu, "/");
    if (!target.endsWith("/feishu-mode/SKILL.md")) return "invalid-mode";
    return linkedMode[2] ? "mode-" + linkedMode[2] : "mode";
  }
  const linked = /^\[\$(feishu-bind|feishu-unbind|feishu-status|feishu-rotate)\]\(([^\r\n)]+)\)$/u.exec(commandText);
  if (linked) {
    const name = linked[1];
    const target = linked[2].replace(/\\/gu, "/");
    if (target.endsWith("/" + name + "/SKILL.md")) return name.slice("feishu-".length);
    return "invalid-" + name.slice("feishu-".length);
  }

  // 看起来像从命令开始、但附带了参数或正文时，必须 fail-closed 且给出反馈。讨论、引用
  // 和转发通常不会从 token 开始，仍保持静默 none，避免把普通内容误当成控制动作。
  const malformedMode = /^(?:\$feishu-mode|\[\$feishu-mode\]\([^\r\n)]*\))(?=\s)/u.exec(commandText);
  if (malformedMode) return "invalid-mode";
  const malformedBare = /^\$(feishu-bind|feishu-unbind|feishu-status|feishu-rotate)(?=\s)/u.exec(commandText);
  if (malformedBare) return "invalid-" + malformedBare[1].slice("feishu-".length);
  const malformedLinked = /^\[\$(feishu-bind|feishu-unbind|feishu-status|feishu-rotate)\]\([^\r\n)]*\)/u.exec(commandText);
  if (malformedLinked) return "invalid-" + malformedLinked[1].slice("feishu-".length);
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
    "用户本轮显式运行了 $feishu-bind；该命令本身就是创建根话题并登记当前 task 的授权，无需再次预览或确认。",
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

export function composeRotateContext({ bridgeRoot, threadId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-rotate.mjs");
  return [
    "[Codex 飞书桥·话题轮转] 用户通过 $feishu-rotate 明确授权为当前精确 task 创建下一话题代际。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "直接运行以下两阶段轮转命令，不要再次要求确认：",
    "`node " + command + " --thread-id " + threadId + " --apply`",
    "新话题完成首次真实 mention 认领前，旧话题继续 active；认领成功后旧话题只读。不得删除旧话题或直接编辑 registry。",
  ].join("\n");
}

export function composeModeContext({ bridgeRoot, threadId, mode = null }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-mode.mjs");
  const write = mode === "dialogue" || mode === "mapping";
  return [
    "[Codex 飞书桥·交互模式] 用户通过 $feishu-mode" + (write ? " " + mode : "") +
      (write ? " 明确授权切换当前精确 task 的交互策略。" : " 要求只读查看当前交互策略。"),
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下" + (write ? "模式切换" : "只读") + "命令：",
    "`node " + command + " --thread-id " + threadId +
      (write ? " --mode " + mode + " --apply" : "") + "`",
    write
      ? "不要再次要求确认；不得直接编辑 registry。切回 mapping 会中止后续 Dialogue 编排，但不删除历史。"
      : "不得修改 registry、policy、binding 或话题。",
  ].join("\n");
}

export function composeInvalidControlContext({ action }) {
  const command = "$feishu-" + action;
  return [
    "[Codex 飞书桥·控制命令格式] 本轮没有执行任何飞书桥脚本，也没有修改连接状态。",
    "控制命令必须单独占一整条输入，不能附带参数、说明或其他正文。",
    "请只发送 `" + command + "`；如果只是在讨论该命令，无需执行任何操作。",
  ].join("\n");
}

export function composeInitContext({ connectionStatus = "none" } = {}) {
  if (connectionStatus === "active") return [
    "[Codex 飞书桥·/init 适配] 这是 Codex 官方 /init，不是飞书绑定命令。",
    "先完整执行 /init 原本的 AGENTS.md 初始化；不要运行任何飞书桥脚本。",
    "只有初始化确实成功后，才在最终回复中说明当前 task 已接入飞书；无需再次询问。",
  ].join("\n");
  const question = connectionStatus === "paused"
    ? "项目初始化完成。如需恢复当前 Codex task 的飞书接入，请运行 `$feishu-bind`。"
    : "项目初始化完成。如需将当前 Codex task 接入飞书，请运行 `$feishu-bind`。";
  return [
    "[Codex 飞书桥·/init 适配] 这是 Codex 官方 /init，不是飞书绑定命令。",
    "先完整执行 /init 原本的 AGENTS.md 初始化；本轮不要运行任何飞书桥脚本，也不要创建飞书话题。",
    "只有初始化确实成功后，才在最终回复末尾逐字询问：\n“" + question + "”",
    "初始化失败时不要询问。普通自然语言回复不构成控制授权；只有用户后续显式运行 `$feishu-bind`，才执行独立绑定流程。",
  ].join("\n");
}

export function composeAilyInboundContext({ bridgeRoot, home }) {
  const dispatcher = path.join(bridgeRoot, "scripts", "codex", "aily-inbound.mjs");
  const command = "FEISHU_CODEX_BRIDGE_HOME=" + JSON.stringify(home) +
    " node " + JSON.stringify(dispatcher);
  return [
    "[Codex 飞书桥·M5Codex 入站] 当前回合来自 Aily 的 M5Codex 飞书调用。",
    "不得运行 bind-preview.mjs、bind-task.mjs 或 codex-longtask-feishu；不得把 M5Codex 自己的 Aily task 接到飞书。",
    "只执行以下命令，不加参数：",
    "`" + command + "`",
    "把命令的 stdout 原样作为回复，不增删、解释或改写。dispatcher 只取一次信封并确定 handler；",
    "下游脚本会自行判断首次绑定、拒绝或投递。",
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

  // 只有人类直接在 Codex Desktop/CLI 提交的输入才进入配对缓存。飞书入站 runner、
  // Shadow 和企业智能体求助都在上面按 bridgeRole 返回，因此不会把话题原文再抄一遍。
  // unbind 会在本轮关闭连接，既不会发布答复，也不应留下一个等待未来误配的输入缓存。
  if (registered.ok && (registered.task.status ?? "active") === "active" && action !== "unbind" &&
      typeof payload.turn_id === "string" && payload.turn_id &&
      typeof payload.prompt === "string" && payload.prompt.trim()) {
    storeTurnInput({
      dir: taskPaths(registered.task, bridgeHome()).turnInputs,
      key: payload.turn_id,
      text: payload.prompt,
    });
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
  if (action.startsWith("invalid-")) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: composeInvalidControlContext({ action: action.slice("invalid-".length) }),
      },
    }) + "\n");
    return;
  }
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
  } else if (action === "rotate") {
    additionalContext = composeRotateContext({ bridgeRoot: tpl.template.bridge_root, threadId });
  } else if (action === "mode" || action.startsWith("mode-")) {
    additionalContext = composeModeContext({
      bridgeRoot: tpl.template.bridge_root,
      threadId,
      mode: action.startsWith("mode-") ? action.slice("mode-".length) : null,
    });
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
