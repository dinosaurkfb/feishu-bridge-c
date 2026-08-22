/**
 * Claude/Codex 共用的 Aily 入站 dispatcher 核心。
 *
 * 它只拥有 endpoint 校验、一次取信封、Canonical Event 构造和 handler owner 选路；
 * subscription、binding、sender 权限、claim、policy 与 runtime 投递仍属于下游 handler。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CANONICAL_EVENT_ENV, buildCanonicalEvent } from "./canonical-event.mjs";
import { fetchTriggerEvent } from "./envelope.mjs";
import { ROUTE_REJECT_TEXT, loadRoutes, selectRoute } from "./inbound-routes.mjs";

const appendLog = (file, line) => {
  if (typeof file !== "string" || !file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, new Date().toISOString() + " " +
      String(line).replace(/\s+/gu, " ").slice(0, 1000) + "\n", { mode: 0o600 });
  } catch { /* 审计日志失败不能改变 dispatcher 结论 */ }
};

const write = (stream, text) => stream?.write?.(text);

/**
 * 返回 exitCode，由薄 CLI wrapper 决定 process.exit。测试可注入 fetch/spawn/stream，
 * 不需要真的访问 Aily 或启动 handler。
 */
export function runInboundDispatcher({
  endpointId,
  expectedCallerAgentUid,
  defaultRoute,
  routesFile,
  logFile,
  dryRun = false,
  handlerArgs = [],
  handlerTimeoutMs = 30_000,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetcher = fetchTriggerEvent,
  spawnHandler = spawnSync,
} = {}) {
  const log = (line) => appendLog(logFile, line);
  const fail = (detail, reason) => {
    write(stdout, "系统错误 · " + detail + "\n本条指令没有被投递。请勿视为已受理。\n");
    write(stderr, JSON.stringify({ kind: "error", stage: "dispatch", reason }) + "\n");
    return { exitCode: 1, kind: "error", reason };
  };

  if (typeof endpointId !== "string" || !endpointId ||
      typeof expectedCallerAgentUid !== "string" || !expectedCallerAgentUid) {
    log("endpoint config invalid");
    return fail("本机入站 endpoint 配置不完整", "endpoint_config_invalid");
  }

  const callerAgent = env.AILY_CLI_CALLER_AGENT_UID;
  if (callerAgent !== expectedCallerAgentUid) {
    log("caller mismatch");
    write(stdout, "已拒绝 · 调用方不是本链路的运输 agent\n本条指令没有被投递给任何任务。\n");
    write(stderr, JSON.stringify({ kind: "rejected", stage: "dispatch",
      reason: "caller_agent_mismatch" }) + "\n");
    return { exitCode: 0, kind: "rejected", reason: "caller_agent_mismatch" };
  }

  const fetched = fetcher(env);
  if (!fetched?.ok) {
    log("envelope fetch failed: " + (fetched?.reason ?? "unknown") +
      " attempts=" + (fetched?.attempts ?? 1));
    return fail("取不到本次消息信封（" + (fetched?.reason ?? "unknown") + "）",
      fetched?.reason ?? "envelope_fetch_failed");
  }

  const canonical = buildCanonicalEvent({
    event: fetched.event,
    rawEnvelope: fetched.raw_envelope,
    endpointId,
    callerAgentUid: callerAgent,
    fetchAttempts: fetched.attempts ?? 1,
    env,
  });
  if (!canonical.ok) {
    log("canonical event invalid: " + canonical.problems.join(","));
    return fail("消息信封无法规范化", canonical.reason);
  }

  const table = loadRoutes(routesFile);
  const fallback = defaultRoute && typeof defaultRoute.id === "string" &&
    typeof defaultRoute.handler === "string"
    ? [{ id: defaultRoute.id, handler: defaultRoute.handler, isDefault: true }]
    : [];
  const routes = table.routes.length > 0 ? table.routes : fallback;
  const picked = selectRoute({
    sessionId: canonical.event.source.session_id,
    routes,
    sessions: table.sessions,
  });
  if (!picked.ok) {
    log("route selection failed: " + picked.reason);
    return fail(ROUTE_REJECT_TEXT[picked.reason] ?? picked.reason, picked.reason);
  }

  const handler = picked.route.handler;
  if (!fs.existsSync(handler)) {
    log("handler missing: route=" + picked.route.id);
    return fail("路由 " + picked.route.id + " 指向的处理器不存在", "route_handler_missing");
  }

  if (dryRun) {
    write(stdout, "[dry-run] 会交给路由 " + picked.route.id + "（依据：" + picked.matchedBy + "）\n");
    write(stderr, JSON.stringify({ dryRun: true, route: picked.route.id,
      matchedBy: picked.matchedBy, canonical_schema: canonical.event.schema_version }) + "\n");
    return { exitCode: 0, kind: "dry_run", route: picked.route.id, canonical: canonical.event };
  }

  log("dispatch -> " + picked.route.id + " (" + picked.matchedBy + ")");
  let serialized;
  try {
    serialized = JSON.stringify(canonical.event);
  } catch {
    return fail("规范化消息无法交给处理器", "canonical_event_unserializable");
  }
  const child = spawnHandler(process.execPath, [handler, ...handlerArgs], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...env, [CANONICAL_EVENT_ENV]: serialized },
    timeout: handlerTimeoutMs,
    killSignal: "SIGTERM",
  });
  if (child.error) {
    if (child.error.code === "ETIMEDOUT") {
      log("handler timeout: route=" + picked.route.id);
      return fail("路由 " + picked.route.id + " 的处理器响应超时", "handler_timeout");
    }
    log("handler spawn failed: " + child.error.message);
    return fail("路由 " + picked.route.id + " 的处理器无法启动", "handler_spawn_failed");
  }
  return { exitCode: child.status ?? 1, kind: "dispatched", route: picked.route.id };
}
