/**
 * 从 Aily 取回触发本次运行的那条消息信封。
 *
 * 为什么不让模型把事件拼成 JSON 传进来：模型手上根本没有这些字段（2026-08-19 实测，
 * prompt 里只有渲染后的正文）。让它「尽力填」等于让它编，而编出来的字段会绕过校验。
 * 所以字段一律由脚本自己向平台取，模型不参与。
 *
 * 用 --run 精确锁定本次运行对应的消息，避免「取最新一条」在并发下取错。
 *
 * 只取最近的轮次，不拉全量：`session events` 默认返回整个话题的 envelope，
 * 而话题只增不减（2026-08-19 实测：29 条消息已经是 160 个 envelope）。
 * 一条指令要的只是最新那条 user 消息，拉全量等于每次都把整个话题史搬一遍，
 * 且开销随话题寿命线性增长。收窄在脚本里做，模型不参与。
 */

import { execFileSync } from "node:child_process";

export const ENV = {
  SESSION: "AILY_CLI_SESSION_ID",
  RUN: "AILY_CLI_RUN_ID",
  AGENT: "AILY_CLI_CALLER_AGENT_UID",
};

function runAily(args) {
  return execFileSync("aily-cli", args, {
    encoding: "utf-8",
    env: { ...process.env, AILY_CLI_SURFACE: "agent-lite" },
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * `--page-size` 的单位是**对话轮次**，不是 envelope 条数，而且从最新一轮往回数
 * （2026-08-19 实测：--page-size 3 精确返回最后 3 轮共 45 个 envelope 并带 nextPageToken；
 * --page-size 1 返回 13 个，就是最新那轮）。
 *
 * 取 2 而不是 1：多留一轮的余量，防止查询正好落在轮次边界上把目标那条漏掉。
 * 代价约 13 个 envelope，比漏掉一条指令便宜太多。
 *
 * 有 runId 时不加 —— `--run` 已经是更准的收窄，两个一起用只会互相干扰。
 */
export const RECENT_TURNS = 2;

export function buildEventsArgs({ sessionId, agentId, runId }) {
  const args = ["session", "events", "--agent", agentId, "--session", sessionId, "--json"];
  if (runId) args.push("--run", runId);
  else args.push("--page-size", String(RECENT_TURNS));
  return args;
}

/**
 * @returns {{ok:true, event:object} | {ok:false, reason:string, detail?:string}}
 */
export function fetchTriggerEvent(env = process.env) {
  const sessionId = env[ENV.SESSION];
  const runId = env[ENV.RUN];
  const agentId = env[ENV.AGENT];

  // 没有 session 就无法判定话题归属 —— 这是安全关键字段，缺了必须拒绝而不是放行。
  if (!sessionId) return { ok: false, reason: "missing_session_env" };
  if (!agentId) return { ok: false, reason: "missing_agent_env" };

  const args = buildEventsArgs({ sessionId, agentId, runId });

  let raw;
  try {
    raw = runAily(args);
  } catch (err) {
    return { ok: false, reason: "session_events_failed", detail: String(err.message).slice(0, 200) };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "session_events_unparsable" };
  }

  const envelopes = Array.isArray(parsed?.envelopes) ? parsed.envelopes : [];
  let latest = null;
  for (const e of envelopes) {
    if (e?.type !== "message.create") continue;
    let payload;
    try {
      payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
    } catch {
      continue;
    }
    const msg = payload?.message;
    if (!msg || msg.role !== "user") continue;
    const at = Number(msg.createdAtMs ?? 0);
    if (latest === null || at >= latest.at) {
      latest = {
        at,
        event: {
          message_id: msg.id,
          session_id: msg.sessionID ?? sessionId,
          sender_id: String(msg.createdBy ?? ""),
          created_at_ms: at,
          content: msg.content ?? "",
        },
      };
    }
  }

  if (latest === null) return { ok: false, reason: "no_user_message_in_session" };
  return { ok: true, event: latest.event };
}
