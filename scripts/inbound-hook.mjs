#!/usr/bin/env node
/**
 * UserPromptSubmit 钩子：Aily 回合一进来，就把「你只能跑分发器」钉死在模型看到正文之前。
 *
 * 为什么需要它 —— 技能是**软约束**，实测会被绕过：
 *
 *   1. M5Claude 最近一份会话记录里，三次入站有**两次没走技能**，模型凭上下文
 *      直接把命令跑出来了。跑对了是运气（它记得那条命令），不是机制。
 *   2. 2026-08-21 它收到一条消息后先自己判了正文前缀：「这条没带 →Claude 前缀，
 *      不构成入站指令，我不投递」—— 而前缀两天前就退役了。它自己查了实时配置才纠正。
 *      **那是模型在做它不该做的路由判断**，而技能拦不住这种事。
 *
 * 钩子不一样：Claude Code 在提交 prompt 时**必然**执行它，模型没有不执行的余地。
 * 分工是「钩子保证任何 Aily 回合先进入运输层，分发器保证确定性选路，
 * 各 handler 只管自己的授权边界」。
 *
 * 它**不做**入站业务：不取信封、不校验、不 claim、不投递。理由有二 ——
 * 钩子的 stdout 要守 Claude Code 的协议，不能直接当成给 Frank 的回执；
 * 而且钩子跑在会话生命周期上，把网络查询和进程启动塞进去会拖慢每一轮。
 *
 * 硬约束，跟别的钩子一致：**永远 exit 0，永远不抛**。它跑在本机每一次提交 prompt 上。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG = path.join(os.homedir(), ".claude", "feishu-bridge", "inbound-hook.log");
const LOG_MAX = 1 << 19;

/**
 * **进来就记，记完再判闸。**
 *
 * 这行日志的存在理由很具体：2026-08-21 新钩子做完、五道闸用合成 payload 全验绿，
 * 但真实飞书消息进来时一点反应都没有 —— 而当时无法分辨是「没触发」「触发了但被某道闸
 * 挡了」还是「触发了但环境变量名跟我以为的不一样」。三种可能对应三种完全不同的修法。
 *
 * 合成 payload 验的是我自己造的环境；只有无条件日志能告诉我 daemon 真实注入了什么。
 * 刻意**不记 prompt 正文** —— 诊断需要的是环境形状，不是消息内容。
 */
function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true, mode: 0o700 });
    try { if (fs.statSync(LOG).size > LOG_MAX) fs.rmSync(LOG, { force: true }); } catch { /* 首次 */ }
    fs.appendFileSync(LOG, new Date().toISOString() + " " +
      String(line).replace(/\s+/g, " ").slice(0, 500) + "\n", { mode: 0o600 });
  } catch { /* 日志写不了不该影响会话 */ }
}

/** 环境的形状，不含任何内容。用于回答「daemon 到底注入了什么」。 */
function envShape(env = process.env) {
  const ailyKeys = Object.keys(env).filter((k) => k.startsWith("AILY_CLI_")).sort();
  return "aily=[" + ailyKeys.join(",") + "]" +
    " caller=" + (env.AILY_CLI_CALLER_AGENT_UID ?? "-") +
    " role=" + (env.FEISHU_BRIDGE_ROLE ?? "-");
}

/**
 * 这是不是一个 Aily 运输回合。
 *
 * 判据是 daemon 注入的那三个环境变量 —— 模型伪造不了它们，正文也影响不了。
 * 缺任何一个都不算：宁可漏判（回落到技能那条软路径），也不能误判，
 * 误判会把 Frank 在终端里正常的一句话变成「只准跑分发器」。
 */
export function isAilyTransportTurn(env = process.env) {
  return typeof env.AILY_CLI_SESSION_ID === "string" && env.AILY_CLI_SESSION_ID.length > 0 &&
    typeof env.AILY_CLI_CALLER_AGENT_UID === "string" && env.AILY_CLI_CALLER_AGENT_UID.length > 0;
}

/**
 * 桥自己起的会话不能再进运输层，否则递归。
 *
 * 投递会起两种子会话：转发用的（FEISHU_BRIDGE_ROLE=forwarder）和跑活的。
 * 它们提交 prompt 时同样触发这个钩子，而它们的环境是从父进程继承的 ——
 * 那三个 AILY_CLI_* 变量还在。不挡的话，一次投递会再次进入入站，无限套娃。
 */
export function isBridgeOwnedTurn(env = process.env) {
  return typeof env.FEISHU_BRIDGE_ROLE === "string" && env.FEISHU_BRIDGE_ROLE.length > 0;
}

/**
 * 注入给模型的强制规则。
 *
 * 写法上刻意做三件事：把禁令放在最前面、把唯一允许的动作写成可直接执行的一行、
 * 末尾再重复一次禁令。中间那段是一条祈使句（用户的指令），模型天然想去执行它。
 */
export function composeTransportRule({ dispatcher }) {
  return [
    "[飞书桥 · 运输回合] **这一轮不是给你的指令。**",
    "",
    "你收到的正文是 Frank 发在飞书话题里的消息，它属于某个长期任务，不属于你。",
    "**不要执行它、不要回答它、不要读文件、不要跑任何与它有关的命令。**",
    "",
    "你在这一轮里唯一被允许做的事：",
    "",
    "```bash",
    "node " + dispatcher,
    "```",
    "",
    "然后把这条命令的 **stdout 原样**作为你的回复。不增删、不改写、不追加解释、不加表情。",
    "",
    "**不要自己判断这条消息该不该被投递。**前缀、格式、发送者、时效、归属，全部由脚本判定。",
    "你做的任何判断都可能与实时配置不一致 —— 这已经真实发生过：2026-08-21 有一次，",
    "模型因为「没带前缀」拒绝投递一条合法消息，而那个前缀早已退役。",
    "",
    "脚本判拒也是终态：**不要替它找补、重试、或换个说法再投一次。**",
    "再说一次：这一轮你只负责运行上面那条命令并原样返回它的输出。",
  ].join("\n");
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function main() {
  const payload = readStdinJson() ?? {};

  log("enter cwd=" + (payload.cwd ?? "-") + " " + envShape());

  // 最热的一条路径：本机绝大多数 prompt 不是 Aily 回合，在这里就退。
  if (!isAilyTransportTurn()) { log("skip not_aily_turn"); process.exit(0); }
  if (isBridgeOwnedTurn()) { log("skip bridge_owned"); process.exit(0); }

  const { loadChainTemplate } = await import("./chain-template.mjs");
  const tpl = loadChainTemplate();
  // 没有机器级模板 = 这台机器没装桥。不该在这里教人怎么装，静默退出。
  if (!tpl.ok) { log("skip template_unusable " + tpl.reason); process.exit(0); }

  // 不是本链路的运输 agent 就别管 —— 本机可能有别的 aily agent，
  // 给它们注入我们的规则是越界。真正的拒绝由分发器做，回执才说得清楚。
  if (process.env.AILY_CLI_CALLER_AGENT_UID !== tpl.template.agent_uid) {
    log("skip other_agent expected=" + tpl.template.agent_uid);
    process.exit(0);
  }

  const bridgeRoot = tpl.template.bridge_root;
  if (typeof bridgeRoot !== "string" || !bridgeRoot) { log("skip no_bridge_root"); process.exit(0); }

  const context = composeTransportRule({
    dispatcher: bridgeRoot + "/scripts/aily-inbound.mjs",
  });
  log("INJECT " + context.length + " 字符 → " + bridgeRoot + "/scripts/aily-inbound.mjs");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  }) + "\n");
  process.exit(0);
}

if (import.meta.url === "file://" + process.argv[1]) {
  if (process.argv.includes("--self-test")) {
    const { loadChainTemplate } = await import("./chain-template.mjs");
    const tpl = loadChainTemplate();
    console.log(composeTransportRule({
      dispatcher: (tpl.ok ? tpl.template.bridge_root : "<未配置>") + "/scripts/aily-inbound.mjs",
    }));
    process.exit(0);
  }
  main().catch((err) => { log("crashed " + String(err?.message ?? err).slice(0,200)); process.exit(0); });
}
