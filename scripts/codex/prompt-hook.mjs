#!/usr/bin/env node
/** Codex UserPromptSubmit：记录精确 thread 活跃租约，并为飞书控制动作注入确定性命令。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectRun, moduleDir } from "../direct-run.mjs";

import {
  bridgeHome, findRegisteredTaskForCodexThread, loadCodexTemplate, recordThreadActivity, taskPaths,
} from "./state.mjs";
import { storeTurnInput } from "../turn-input.mjs";
import { nodeCommandPrefix, shellQuote } from "../shell-quote.mjs";
import { buildIntentParams, issueIntent } from "./intent.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";

/**
 * 不带参数的控制命令 —— **只有这一份清单**。
 *
 * 这些名字原本在四条正则里各写一遍：加一个命令要改四处，
 * 漏一处的后果是"裸写能用、Desktop 的链接形式不认"，或者"带参数时不再 fail-closed"——
 * 两种都得等真人踩到才发现。
 */
const SIMPLE_COMMANDS = [
  "feishu-bind", "feishu-unbind", "feishu-status", "feishu-subscribe",
];

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
  // **取消轮转要有真入口。**
  //
  // 上一版这条命令带了参数就被判成 invalid-rotate —— 于是"取消等待认领的代际"
  // 这个能力在生产里**永远拿不到凭证**，只有测试能用（测试自己充当授权者，
  // 那不算证明）。要么给真入口，要么撤掉能力；这个能力是有用的，所以给入口。
  // 形状照 $feishu-mode 的先例：整条精确匹配，讨论和引用照样到不了这里。
  const bareRotate = /^\$feishu-rotate(?:\s+(cancel))?$/u.exec(commandText);
  if (bareRotate) return bareRotate[1] ? "rotate-cancel" : "rotate";
  const bare = new RegExp("^\\$(" + SIMPLE_COMMANDS.join("|") + ")$", "u").exec(commandText);
  if (bare) return bare[1].slice("feishu-".length);

  const linkedRotate =
    /^\[\$feishu-rotate\]\(([^\r\n)]+)\)(?:\s+(cancel))?$/u.exec(commandText);
  if (linkedRotate) {
    const target = linkedRotate[1].replace(/\\/gu, "/");
    if (!target.endsWith("/feishu-rotate/SKILL.md")) return "invalid-rotate";
    return linkedRotate[2] ? "rotate-cancel" : "rotate";
  }
  const linkedMode = /^\[\$feishu-mode\]\(([^\r\n)]+)\)(?:\s+(dialogue|mapping))?$/u.exec(commandText);
  if (linkedMode) {
    const target = linkedMode[1].replace(/\\/gu, "/");
    if (!target.endsWith("/feishu-mode/SKILL.md")) return "invalid-mode";
    return linkedMode[2] ? "mode-" + linkedMode[2] : "mode";
  }
  const linked = new RegExp("^\\[\\$(" + SIMPLE_COMMANDS.join("|") +
    ")\\]\\(([^\\r\\n)]+)\\)$", "u").exec(commandText);
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
  // rotate 从 SIMPLE_COMMANDS 里挪出来之后，畸形形态也要单独兜住 ——
  // 漏了的话 `$feishu-rotate 别的` 会静默变成 none，**用户得不到任何反馈**。
  const malformedRotate =
    /^(?:\$feishu-rotate|\[\$feishu-rotate\]\([^\r\n)]*\))(?=\s)/u.exec(commandText);
  if (malformedRotate) return "invalid-rotate";
  const malformedBare = new RegExp("^\\$(" + SIMPLE_COMMANDS.join("|") +
    ")(?=\\s)", "u").exec(commandText);
  if (malformedBare) return "invalid-" + malformedBare[1].slice("feishu-".length);
  const malformedLinked = new RegExp("^\\[\\$(" + SIMPLE_COMMANDS.join("|") +
    ")\\]\\([^\\r\\n)]*\\)", "u").exec(commandText);
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

/**
 * 注入的命令跑哪一份代码。**只认 runtime/current，不读模板的 bridge_root。**
 *
 * 迁移时踩过一个从外部完全看不出来的状态：hooks.json 已经改指 runtime/current、
 * hook 在跑也被信任了，**可注入的命令是从模板的 bridge_root 拼的**，
 * 而那个字段还指着旧克隆 —— 于是 Codex 一直在跑一天前的代码，
 * status 出的是迁移前的旧格式。钩子路径是新的，命令路径是旧的。
 *
 * 模板是机器级配置，会漂；runtime/current 是安装器刚校验过的那一份。
 * **命令路径的唯一事实来源只能是后者。**
 */
/**
 * 把凭证拼进命令。**没有凭证时拼空串** —— 让脚本自己拒，
 * 而不是在这里悄悄给一条不带凭证的命令。
 */
/** 有副作用的动作 —— **只有这些需要凭证**。只读的多发一张就多一个能被误用的东西。 */
const WRITE_ACTIONS = new Set(["bind", "unbind", "rotate", "mode"]);

const intentArg = (intentId) =>
  typeof intentId === "string" && intentId ? " --intent " + shellQuote(intentId) : "";

/**
 * **从钩子自己所在的位置推 runtime 根，不看 CODEX_HOME。**
 *
 * 上一版用 codexRuntimeRoot(process.env.CODEX_HOME) 拼：真机上 Aily 现在给每个会话一个专属的
 * CODEX_HOME（~/.aily-cli/session/<会话>/workdir/.aily-cli/codex-homes/<hash>），那里没装桥 ——
 * 于是钩子本身从真机 runtime 被加载并执行，注入的命令却指向一个不存在的路径，Codex 把
 * MODULE_NOT_FOUND 的栈原样当成回复发回了话题（2026-08-28 真机实测）。
 * 钩子是从哪份代码被加载的，就把同一份代码里的脚本交出去 —— 与 Claude 侧 inbound-hook 同一条规矩。
 */
const runtimeScriptsRoot = () => path.resolve(moduleDir(import.meta.url), "..", "..");

export function composeBindingContext({ bridgeRoot, cwd, threadId, chatName, intentId }) {
  const apply = path.join(bridgeRoot, "scripts", "codex", "bind-task.mjs");
  return [
    "[Codex 飞书桥] 当前任务的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "用户本轮显式运行了 $feishu-bind；该命令本身就是创建根话题并登记当前 task 的授权，无需再次预览或确认。",
    "直接运行以下幂等绑定命令：",
    "`" + nodeCommandPrefix(apply) + " --project " + shellQuote(cwd) +
      " --thread-id " + shellQuote(threadId) + " --apply" + intentArg(intentId) + "`",
    "目标群：" + (chatName ?? "机器级配置中的群") + "。若已接入则不得重复建话题；若已暂停则只恢复原连接。",
  ].join("\n");
}

export function composeUnbindContext({ bridgeRoot, threadId, intentId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-unbind.mjs");
  return [
    "[Codex 飞书桥·暂停接入] 用户通过 $feishu-unbind 明确要求撤销当前 task 的飞书接入。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下可恢复的本地暂停命令：",
    "`" + nodeCommandPrefix(command) + " --thread-id " + shellQuote(threadId) + " --apply" + intentArg(intentId) + "`",
    "命令不会向飞书发送消息或删除话题；不要直接编辑 registry，也不要把 locator 输出给用户。",
  ].join("\n");
}

export function composeStatusContext({ bridgeRoot, threadId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-status.mjs");
  return [
    "[Codex 飞书桥·连接状态] 用户要求只读查看当前 task 的飞书状态。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下只读命令，并用简洁自然语言转述 stdout：",
    "`" + nodeCommandPrefix(command) + " --thread-id " + shellQuote(threadId) + "`",
    "不得直接读取或输出 registry、locator、凭据、claim 或 receipt。",
  ].join("\n");
}

export function composeSubscribeContext({ bridgeRoot, threadId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-subscribe.mjs");
  return [
    "[Codex 飞书桥·事件订阅] 用户要求只读查看当前 task 的事件订阅（第 2 层）。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下只读命令，并**保留 stdout 的结构**转述（标签 + 值两列）：",
    "`" + nodeCommandPrefix(command) + " --thread-id " + shellQuote(threadId) + "`",
    // **写入口没开的原因本身就是信息。**概括成"暂不支持修改"，
    // 下一个来问"为什么不能改"的人就得重新把这段考古一遍。
    "脚本末尾会说明写入口为什么还没开 —— 那段原样转述，不要概括成「暂不支持修改」。",
    "不得直接读取或输出 registry、locator、凭据、claim 或 receipt；",
    "「授权发送者 N 个」只出数量不出身份，群名不可用时不要拿群 ID 顶替。",
  ].join("\n");
}

export function composeRotateContext({ bridgeRoot, threadId, intentId, op = "create" }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-rotate.mjs");
  const cancel = op === "cancel";
  return [
    cancel
      ? "[Codex 飞书桥·取消轮转] 用户通过 $feishu-rotate cancel 明确要求取消等待认领的话题代际。"
      : "[Codex 飞书桥·话题轮转] 用户通过 $feishu-rotate 明确授权为当前精确 task 创建下一话题代际。",
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    cancel ? "直接运行以下取消命令，不要再次要求确认：" : "直接运行以下两阶段轮转命令，不要再次要求确认：",
    "`" + nodeCommandPrefix(command) + " --thread-id " + shellQuote(threadId) +
      (cancel ? " --cancel" : "") + " --apply" + intentArg(intentId) + "`",
    cancel
      ? "取消只丢弃尚未认领的那一代；已经 active 的话题不受影响。不得删除任何话题或直接编辑 registry。"
      : "新话题完成首次真实 mention 认领前，旧话题继续 active；认领成功后旧话题只读。不得删除旧话题或直接编辑 registry。",
  ].join("\n");
}

export function composeModeContext({ bridgeRoot, threadId, mode = null , intentId }) {
  const command = path.join(bridgeRoot, "scripts", "codex", "feishu-mode.mjs");
  const write = mode === "dialogue" || mode === "mapping";
  return [
    "[Codex 飞书桥·交互模式] 用户通过 $feishu-mode" + (write ? " " + mode : "") +
      (write ? " 明确授权切换当前精确 task 的交互策略。" : " 要求只读查看当前交互策略。"),
    "当前 task 的精确 thread id 是 " + threadId + "。不得使用 --last 或猜测别的线程。",
    "只运行以下" + (write ? "模式切换" : "只读") + "命令：",
    "`" + nodeCommandPrefix(command) + " --thread-id " + shellQuote(threadId) +
      (write ? " --mode " + shellQuote(mode) + " --apply" + intentArg(intentId) : "") + "`",
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
  // 用 shellQuote 而不是 JSON.stringify。后者产出的是**双引号**，挡得住空格，
  // 但双引号内 `$`、反引号、反斜杠仍会被 shell 解释 —— 路径里带这些字符时，
  // 那就不只是拆词，而是可能执行别的东西。POSIX 里唯一完全字面的是单引号。
  const command = "FEISHU_CODEX_BRIDGE_HOME=" + shellQuote(home) +
    " " + nodeCommandPrefix(dispatcher);
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
  // 维护门（issue #81）：在任何写之前看门。本链运输 agent 的 Aily 回合用宿主的顶层 decision:block 硬阻断
  // （Codex 已实测）；别的 Aily agent 的回合不是我们的，放行；模板读不出一律当本链回合挡；其它回合无输出放行。
  const gate = gateBlocks();
  const ailyTurn = !isRoutedCodexRun && isAilyInvocation();
  if (gate.blocked && !ailyTurn) process.exit(0);
  if (gate.blocked) {
    const tpl = loadCodexTemplate();
    if (tpl.ok && process.env.AILY_CLI_CALLER_AGENT_UID !== tpl.template.agent_uid) process.exit(0);
    exitForGate("hook_block", gate);
  }
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
          bridgeRoot: runtimeScriptsRoot(),
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
  /**
   * **凭证只在这里签发，只此一处。**
   *
   * 走到这里意味着 classifyFeishuPrompt 判定原始输入是**完整、独立**的控制命令
   * （整条精确匹配 —— 讨论和引用到不了这里）。这就是"原始意图"的证明。
   *
   * 只给有副作用的动作签。只读的（status / subscribe）不需要，
   * 多发一张就多一个能被误用的东西。
   */
  // **凭证绑的是"这一次操作"，不是"这一类操作"。**
  //
  // 上一版只按命令族签：一张 mode 票能切 dialogue 也能切 mapping，
  // 一张 rotate 票能创建也能取消。更糟的是**无参数的只读 $feishu-mode
  // 也会签出一张 mode 票，而它能被当写票消费** —— 一次只读输入换来一次写授权。
  const modeArg = action.startsWith("mode-") ? action.slice("mode-".length) : null;
  const intentAction = action.startsWith("mode") ? "mode"
    : action.startsWith("rotate") ? "rotate" : action;
  const rotateOp = action === "rotate-cancel" ? "cancel" : "create";
  // **参数只由共用构造器拼。**上一版这里 bind 给的是空对象，
  // 而 bind-task 消费的是 { project } —— 摘要对不上，**真实绑定全线卡死**，
  // 而单测各自签各自的票，两边都绿。
  const intentParams = WRITE_ACTIONS.has(intentAction)
    ? buildIntentParams(intentAction, {
        mode: modeArg,
        op: rotateOp,                          // 创建还是取消，按分类结果来
        project: cwd, chat: null, name: null, chatName: null,  // 钩子不传群
      })
    : {};
  // **只读的 $feishu-mode（不带参数）不签票。**它只是看当前模式。
  const wantsIntent = WRITE_ACTIONS.has(intentAction) &&
    !(intentAction === "mode" && modeArg === null);
  let intentId = null;
  if (wantsIntent) {
    const issued = issueIntent({
      action: intentAction, threadId, params: intentParams,
      turnId: payload.turn_id ?? null, home: bridgeHome(),
    });
    // **签不出来就不给命令。**给一条注定被拒的命令比不给更糟：
    // 人会以为是别的地方坏了。
    if (!issued.ok) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "[Codex 飞书桥] 无法签发一次性意图凭证（" + issued.reason +
            "）。**没有执行任何操作**，也不要手工绕过 —— 凭证是这条命令的授权依据。",
        },
      }) + "\n");
      process.exit(0);
    }
    intentId = issued.id;
  }

  if (action === "bind") {
    additionalContext = composeBindingContext({
      bridgeRoot: runtimeScriptsRoot(),
      cwd,
      threadId,
      chatName: tpl.template.chat_name,
      intentId,
    });
  } else if (action === "unbind") {
    additionalContext = composeUnbindContext({ bridgeRoot: runtimeScriptsRoot(), threadId, intentId });
  } else if (action === "status") {
    additionalContext = composeStatusContext({ bridgeRoot: runtimeScriptsRoot(), threadId });
  } else if (action === "subscribe") {
    additionalContext = composeSubscribeContext({ bridgeRoot: runtimeScriptsRoot(), threadId });
  } else if (action === "rotate" || action === "rotate-cancel") {
    additionalContext = composeRotateContext({
      bridgeRoot: runtimeScriptsRoot(), threadId, intentId, op: rotateOp });
  } else if (action === "mode" || action.startsWith("mode-")) {
    additionalContext = composeModeContext({
      bridgeRoot: runtimeScriptsRoot(),
      threadId,
      mode: action.startsWith("mode-") ? action.slice("mode-".length) : null,
      intentId,
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

if (isDirectRun(import.meta.url)) {
  main().catch(() => process.exit(0));
}
