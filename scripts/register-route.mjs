#!/usr/bin/env node
/**
 * 把一个入站消费者登记到本机路由表。默认只预览，`--apply` 才写。
 *
 * 为什么要有它：路由表是结构化状态，手写 `node -e` 改它会绕过三道保险 ——
 * 话题归属检查、原子写、文件权限。已经有人这么干过一次，那条命令会把
 * 已属别人的话题静默改判，而「上一条进了 A、这一条进了 B」是最难查的一类故障。
 *
 * 用法：
 *   node scripts/register-route.mjs --id cc2cd --handler /abs/path.mjs --session <sid>
 *   node scripts/register-route.mjs --id cc2cd --handler /abs/path.mjs --session <sid> --apply
 */

import { isDirectRun } from "./direct-run.mjs";
import { registerRouteBinding, loadRoutes, routesPath } from "./inbound-routes.mjs";

const REASON_TEXT = {
  no_route_id: "缺 --id",
  handler_not_absolute: "--handler 必须是绝对路径",
  handler_missing: "handler 脚本不存在",
  route_id_owned_by_other_handler: "这个 id 已经指向别的脚本",
  route_disabled: "这个 id 存在但被停用了；重新启用是另一件事，本命令不做",
  handler_not_a_file: "--handler 不是普通文件",
  handler_not_readable: "handler 不可读",
  no_session_id: "缺 --session",
  session_owned_by_other_route: "这个话题已经登记给别的路由",
  routes_busy: "路由表正被别的进程写，稍后重试",
  routes_table_unreadable: "路由表读不出来 —— 先修表，别覆盖它",
  routes_table_shape_unexpected: "路由表结构异常 —— 先修表，别覆盖它",
};

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(result) {
  console.error("失败（" + result.reason + "）：" +
    (REASON_TEXT[result.reason] ?? result.reason) +
    (result.owner ? "：" + result.owner : "") +
    (result.handler ? "：" + result.handler : ""));
  process.exit(1);
}

function main() {
  const apply = process.argv.includes("--apply");
  const id = arg("id");
  const handler = arg("handler");
  const session = arg("session");
  const note = arg("note") ?? null;
  const file = routesPath();

  if (!id || !handler) {
    console.error("用法：node scripts/register-route.mjs --id <id> --handler <绝对路径> " +
      "[--session <session_id>] [--note <说明>] [--apply]");
    process.exit(2);
  }

  const before = loadRoutes(file);
  if (!before.ok) {
    fail({ reason: before.reason });
  }
  const hasRoute = before.routes.some((r) => r.id === id);
  const declared = session ? before.sessions[session] : undefined;

  console.log("路由表    " + file);
  console.log("路由      " + id + " → " + handler +
    (hasRoute ? "（已登记）" : "（新增）"));
  if (session) {
    console.log("话题      " + session.slice(0, 12) + "… → " + id +
      (declared === id ? "（已登记）" : declared ? "（当前属于 " + declared + "）" : "（新增）"));
  }

  if (!apply) {
    console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
    return;
  }

  // 路由和话题在同一个事务里写。分两次写会留下半截登记：
  // 路由写进去了、话题被别的进程抢先认领，于是登记被拒。
  const r = registerRouteBinding({ id, handler, note, sessionId: session ?? null, file });
  if (!r.ok) fail(r);
  console.log("\n已写入。路由 " + (r.routeChanged ? "新增" : "无变化") +
    (session ? "，话题 " + (r.sessionChanged ? "新增" : "无变化") : ""));
  console.log("默认路由未改动 —— 换默认路由是换权威路由，本命令不做。");
}

if (isDirectRun(import.meta.url)) main();
