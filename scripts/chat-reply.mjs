/**
 * chat 默认态的回复器（两条链共用）—— 无绑定上下文（刚装桥的群话题、私聊、unbind 之后的话题）里的消息
 * 没有任何目标会话可投，也没有异步回投通道（运输 agent 的回复 = 路由器的 stdout），所以只能在路由器里
 * **同步**起一个零工具、无历史的一次性 `claude -p`，把回答当回执返回。
 *
 *   · 边界与 Dialogue 的 reply_only 同一份（ZERO_TOOL_ARGS）：禁全部内建工具、禁 MCP、不落会话、--safe-mode；
 *   · 有时间预算（CHAT_REPLY_TIMEOUT_MS）：超时就说超时，不挂着运输 agent 的回合；
 *   · 不读任何会话历史，不进任何项目目录（cwd 是 HOME）；
 *   · 只回答，不承诺执行 —— 要执行本机操作得先接入。
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import { ZERO_TOOL_ARGS } from "./handoff.mjs";

export const CHAT_POLICY_ID = "chat";
export const CHAT_REPLY_TIMEOUT_MS = 60_000;
/** 预算可由环境覆盖（测试把它调短；生产不设就是 60 秒）。 */
export function chatReplyTimeoutMs(env = process.env) {
  const n = Number(env.FEISHU_BRIDGE_CHAT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : CHAT_REPLY_TIMEOUT_MS;
}
export const CHAT_REPLY_MAX_CHARS = 4000;
/** 同步回答用 text 输出；边界参数与 REPLY_ONLY_ARGS 共用同一份 ZERO_TOOL_ARGS。 */
export const CHAT_REPLY_ARGS = Object.freeze([...ZERO_TOOL_ARGS, "--output-format", "text"]);
export const CHAT_SYSTEM_PROMPT =
  "你是飞书桥的 chat 默认态：这个话题 / 私聊没有接入任何本机项目或会话，你没有任何工具，也读不到任何历史，只能凭这一条消息回答。" +
  "回答要短、直接、用中文。对方若要你执行本机操作（改文件、跑命令、看项目状态），如实说明：这里还没接入，接入要在终端里跑 /feishu-bind；你不能替他做。";

/**
 * @returns {{ ok: true, text: string, elapsedMs: number } | { ok: false, reason: "timeout"|"spawn_failed"|"nonzero_exit"|"empty_reply", why: string, elapsedMs: number }}
 */
export function chatReply({ instruction, claudeBin = "claude", timeoutMs = chatReplyTimeoutMs(), cwd = os.homedir(), env = process.env } = {}) {
  const startedAt = Date.now();
  const run = spawnSync(claudeBin, ["-p", instruction, "--append-system-prompt", CHAT_SYSTEM_PROMPT, ...CHAT_REPLY_ARGS], {
    cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    env: { ...env, FEISHU_BRIDGE_ROLE: "chat" },
  });
  const elapsedMs = Date.now() - startedAt;
  if (run.error) {
    if (run.error.code === "ETIMEDOUT") return { ok: false, reason: "timeout", why: "超过 " + Math.round(timeoutMs / 1000) + " 秒没答完", elapsedMs };
    return { ok: false, reason: "spawn_failed", why: String(run.error.code ?? run.error.message), elapsedMs };
  }
  if (run.status !== 0) return { ok: false, reason: "nonzero_exit", why: "退出码 " + run.status + (run.stderr ? "：" + String(run.stderr).trim().slice(0, 200) : ""), elapsedMs };
  const text = String(run.stdout ?? "").trim();
  if (!text) return { ok: false, reason: "empty_reply", why: "没有输出", elapsedMs };
  return { ok: true, text: Array.from(text).length > CHAT_REPLY_MAX_CHARS ? Array.from(text).slice(0, CHAT_REPLY_MAX_CHARS).join("") + "…" : text, elapsedMs };
}

/** 回执尾行：让人一眼看出这是未接入状态下的零工具回答，以及怎么接入。 */
export const CHAT_FOOTER = "— chat · 这里还没接入本机项目，零工具回答；要它干活先在终端里跑 /feishu-bind";
export const CHAT_BIND_GUIDE = "这个话题还没接入任何本机项目。接入要在终端里、在那个项目目录下跑 /feishu-bind（会建一个新话题并等你在里面 @ 一下）；飞书里发 /feishu-bind 不会触发接入。";
