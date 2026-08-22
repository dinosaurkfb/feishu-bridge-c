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

import { inheritedCanonicalEvent, legacyEventFromCanonical } from "./canonical-event.mjs";

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
 * 事件存储是最终一致的：run 已经跑起来了，触发它的那条 message.create 却可能还查不到。
 *
 * 2026-08-19 实测三次真实失败：报 no_user_message_in_session，但事后按同一个 runID
 * 去查，那条消息**都在**。同一句话重发一次就成功了 —— 差别只有时间。
 * 查一次就放弃，等于把一个几百毫秒的读延迟变成一条「系统错误」摆在 Frank 面前。
 *
 * 重试预算必须压在秒级回执的契约之内：最坏 2.4 秒，之后仍然如实报错，不无限等。
 */
export const FETCH_BACKOFF_MS = [0, 400, 800, 1200];

/** 只有可能因为时间而改变的原因才重试。配置类错误重试一百次也是同一个结果。 */
const RETRYABLE = new Set([
  "no_user_message_in_session",
  "session_events_failed",
  "session_events_unparsable",
]);

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
/**
 * 分发器把已经取好的信封通过这个环境变量传给 handler，handler 就不必再取一遍。
 *
 * 为什么值得专门做这件事：Aily 的事件存储是最终一致的，取信封本身带 4 次重试
 * （≤2.4s，见 FETCH_BACKOFF_MS）。分发器取一次、handler 再取一次，重试预算就翻倍，
 * 顶到「秒级回执」那条契约的上限。而且两次取到的**可能不是同一条** ——
 * 那会让分发和执行基于不同的事实，是最难查的一类不一致。
 *
 * 只接受**本进程祖先**放进来的值：它由分发器在 spawn 时显式注入，
 * 不是从网络或消息正文来的，所以它和自己去取一样可信。
 */
export const ENVELOPE_ENV = "FEISHU_BRIDGE_ENVELOPE";

/** 有人已经取好并传下来了吗。取不出合法结构就当没有，回落到自己取。 */
export function inheritedEvent(env = process.env) {
  const raw = env[ENVELOPE_ENV];
  if (typeof raw !== "string" || !raw) return null;
  try {
    const e = JSON.parse(raw);
    if (!e || typeof e.message_id !== "string" || typeof e.session_id !== "string") return null;
    return e;
  } catch {
    return null;
  }
}

export function fetchTriggerEvent(env = process.env, { runner = runAily, sleep = sleepSync } = {}) {
  // 新 dispatcher 传的是无损 Canonical Event。handler 仍可消费旧事件视图，但不得重新取信封。
  const canonical = inheritedCanonicalEvent(env);
  if (canonical) {
    return {
      ok: true,
      event: legacyEventFromCanonical(canonical),
      canonical_event: canonical,
      raw_envelope: canonical.raw_envelope.payload,
      attempts: canonical.extensions?.dispatcher?.fetch_attempts ?? 0,
      inherited: true,
    };
  }
  // 分发器已经取好就直接用，不再打一次网络。见 ENVELOPE_ENV 的说明。
  const inherited = inheritedEvent(env);
  if (inherited) return { ok: true, event: inherited, attempts: 0, inherited: true };

  const sessionId = env[ENV.SESSION];
  const runId = env[ENV.RUN];
  const agentId = env[ENV.AGENT];

  // 没有 session 就无法判定话题归属 —— 这是安全关键字段，缺了必须拒绝而不是放行。
  if (!sessionId) return { ok: false, reason: "missing_session_env" };
  if (!agentId) return { ok: false, reason: "missing_agent_env" };

  const args = buildEventsArgs({ sessionId, agentId, runId });

  let last = null;
  for (let attempt = 0; attempt < FETCH_BACKOFF_MS.length; attempt += 1) {
    sleep(FETCH_BACKOFF_MS[attempt]);
    last = attemptFetch(args, sessionId, runner);
    if (last.ok) return { ...last, attempts: attempt + 1 };
    if (!RETRYABLE.has(last.reason)) break;
  }

  // 重试到底还是没有。如实报错，并带上诊断字段 —— 上一版只报一个原因字符串，
  // 事后连「当时查的是哪个 run、看到了几个 envelope」都无从得知。
  return {
    ...last,
    attempts: RETRYABLE.has(last.reason) ? FETCH_BACKOFF_MS.length : 1,
    session_id: sessionId,
    run_id: runId ?? null,
  };
}

function attemptFetch(args, sessionId, runner) {
  let raw;
  try {
    raw = runner(args);
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
        // 只保留被选中的那一份原始 Aily envelope，避免把整页历史带进子进程。
        // payload 若原来是字符串就继续是字符串；无损不等于重新序列化成另一种形状。
        raw_envelope: e,
      };
    }
  }

  if (latest === null) {
    return { ok: false, reason: "no_user_message_in_session", envelopes_seen: envelopes.length };
  }
  return { ok: true, event: latest.event, raw_envelope: latest.raw_envelope };
}
