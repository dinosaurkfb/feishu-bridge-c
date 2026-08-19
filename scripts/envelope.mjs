/**
 * 从 Aily 取回触发本次运行的那条消息信封。
 *
 * 为什么不让模型把事件拼成 JSON 传进来：模型手上根本没有这些字段（2026-08-19 实测，
 * prompt 里只有渲染后的正文）。让它「尽力填」等于让它编，而编出来的字段会绕过校验。
 * 所以字段一律由脚本自己向平台取，模型不参与。
 *
 * 用 --run 精确锁定本次运行对应的消息，避免「取最新一条」在并发下取错。
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
 * @returns {{ok:true, event:object} | {ok:false, reason:string, detail?:string}}
 */
export function fetchTriggerEvent(env = process.env) {
  const sessionId = env[ENV.SESSION];
  const runId = env[ENV.RUN];
  const agentId = env[ENV.AGENT];

  // 没有 session 就无法判定话题归属 —— 这是安全关键字段，缺了必须拒绝而不是放行。
  if (!sessionId) return { ok: false, reason: "missing_session_env" };
  if (!agentId) return { ok: false, reason: "missing_agent_env" };

  const args = ["session", "events", "--agent", agentId, "--session", sessionId, "--json"];
  if (runId) args.push("--run", runId);

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
