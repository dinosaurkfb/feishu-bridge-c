#!/usr/bin/env node
/**
 * 把一个入站消费者登记到本机路由表。默认只预览，`--apply` 才写。
 *
 * 为什么要有它：路由表是结构化状态，手写 `node -e` 改它会绕过三道保险 ——
 * 话题归属检查、原子写、文件权限。已经有人这么干过一次，那条命令会把
 * 已属别人的话题静默改判，而「上一条进了 A、这一条进了 B」是最难查的一类故障。
 *
 * 用法：
 *   node scripts/register-route.mjs --init-default --routes <表> --id <self|codex> --handler /abs/path.mjs [--note <说明>] [--apply]
 *   node scripts/register-route.mjs --id cc2cd --handler /abs/path.mjs --session <sid>
 *   node scripts/register-route.mjs --id cc2cd --handler /abs/path.mjs --session <sid> --apply
 *
 * 新机器的顺序（issue #222）：装机 → `--init-default` 首建本链默认路由 → 登记外部处理器。
 * `--init-default` 的 `--routes` 必填：两条链各有一张表，环境变量兜底会把 codex 的默认写进 Claude 那张。
 * 表里还没有默认路由时不许新增路由：那会把机器停在"有路由、但没有默认"的状态（未登记话题一律拒收）。
 */

import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { registerRouteBinding, initDefaultRoute, previewInitDefault, loadRoutes, restoreDefaultRoute, routesPath } from "./inbound-routes.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";

const REASON_TEXT = {
  no_route_id: "缺 --id",
  handler_not_absolute: "--handler 必须是绝对路径",
  handler_missing: "handler 脚本不存在",
  route_id_owned_by_other_handler: "这个 id 已经指向别的脚本",
  route_disabled: "这个 id 存在但被停用了；重新启用是另一件事，本命令不做",
  handler_not_a_file: "--handler 不是普通文件",
  handler_not_readable: "handler 不可读",
  no_session_id: "缺 --session",
  no_default_route_yet: "表里还没有启用的默认路由 —— 直接登记外部处理器会让这台机器停在「有路由但没有默认」的状态：未登记话题一律拒收，本链自己也接不到待绑定认领（doctor 会报 ✗）；先用 --init-default 播种本链默认路由，再登记外部处理器",
  default_route_exists: "表里已经有默认路由；要换默认处理器用 --restore-default（切权威路由，需 Frank 授权）",
  routes_without_default: "表里已经有路由但都没标 default —— 给它们补默认等于改变未登记话题的去向（即 issue #222 说的那个坑），本命令不修：人工核对未登记话题该投给谁，Frank 定夺",
  no_default_route: "路由表里没有默认路由，无从恢复",
  no_expected_route_id: "缺 --id（本链默认路由的 id：Claude 是 self，Codex 是 codex）",
  default_route_id_mismatch: "表里的默认路由不是 --id 指定的那条；不改别人的路由，请人工核对",
  no_routes: "没有路由表 —— 分发器本来就用运行时自带的默认处理器，不需要恢复",
  backup_failed: "备份没写成，没有动表",
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
  if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态
  // --restore-default：把默认路由的处理器改回给定路径（issue #88 的受控入口；切权威路由，Frank 授权后才 --apply）
  if (process.argv.includes("--restore-default")) {
    const handler = arg("handler");
    const routesArg = arg("routes");
    const expectedRouteId = arg("id");
    // 路由表与默认路由 id 都必须显式给：两条链各有一张表、各有自己的默认 id，默认值只会指向 Claude 那张 —— Codex doctor 抄来的命令不该改错表，
    // 也不该在别的路由被标成默认时把它的 handler 换掉。
    if (!handler || !routesArg || !expectedRouteId || !path.isAbsolute(routesArg) || !path.isAbsolute(handler)) {
      console.error("用法：node scripts/register-route.mjs --restore-default --routes <路由表绝对路径> --handler <处理器绝对路径> --id <本链默认路由 id> [--note <说明>] [--apply]");
      process.exit(2);
    }
    const file = routesArg;
    const table = loadRoutes(file);
    // 只认显式 default（与 selectRoute / defaultRouteHandler 同一规则：单条非默认不算默认）
    const current = table.ok ? (table.routes.find((r) => r.isDefault) ?? null) : null;
    console.log("路由表  ：" + file);
    console.log("默认路由：" + (current ? current.id + " → " + current.handler : "（没有）"));
    console.log("要求 id ：" + expectedRouteId + (current && current.id !== expectedRouteId ? "（不符，--apply 会拒绝）" : ""));
    console.log("改为    ：" + handler);
    if (!apply) { console.log("\n[dry-run] 什么都没写。加 --apply 才落盘（切权威路由，需要 Frank 逐次授权）。"); process.exit(0); }
    const r = restoreDefaultRoute({ handler, note: arg("note") ?? null, file, expectedRouteId });
    if (!r.ok) { console.error("没有恢复：" + (REASON_TEXT[r.reason] ?? r.reason) + (r.error ? "：" + r.error : "")); process.exit(1); }
    console.log(r.changed ? "已改：" + r.id + " " + r.from + " → " + r.handler + "\n备份：" + r.backup : "已经是这个处理器，没动。");
    process.exit(0);
  }
  const id = arg("id");
  const handler = arg("handler");
  const session = arg("session");
  const note = arg("note") ?? null;
  const file = routesPath();

  // --init-default：首建本链默认路由（issue #222）。表里已经有任何路由就拒 —— 本命令只在"还没有表/空表"这一步成立。
  // 目标表**必须显式给**（与 --restore-default 一致）：两条链各有一张表，从 routesPath() / FEISHU_BRIDGE_ROUTES
  // 兜底会把 --id codex 的首建写进 Claude 那张表（返修 P1：旧的 CLI 用例靠注入环境变量把这事掩盖了）。
  if (process.argv.includes("--init-default")) {
    const routesArg = arg("routes");
    if (!id || !handler || !routesArg || !path.isAbsolute(routesArg)) {
      console.error("用法：node scripts/register-route.mjs --init-default --routes <路由表绝对路径（Claude 链 ~/.claude/feishu-bridge/routes.json，Codex 链 ~/.codex/feishu-bridge/routes.json）> --id <本链默认路由 id：Claude 是 self，Codex 是 codex> --handler <处理器绝对路径> [--note <说明>] [--apply]");
      process.exit(2);
    }
    // 预览与 --apply **同源**（judgeInitDefault 纯判定），且预览**只读**（PK3-R222-fix2）：
    // 不 mkdir、不取锁、不写 —— "停用路由算不算已有路由"这种判据只写一处，
    // 否则会出现"预览说没事、apply 说不行"（只有停用路由的表就是这样）。
    const preview = previewInitDefault({ file: routesArg, id, handler, note });
    console.log("路由表  ：" + routesArg);
    console.log("将写入：" + JSON.stringify(note ? { id, handler, default: true, note } : { id, handler, default: true }));
    if (!preview.ok) {
      console.log("--apply 会拒（" + preview.reason + "）：" + (REASON_TEXT[preview.reason] ?? preview.reason) +
        (preview.routes > 0 ? "【表里已有 " + preview.routes + " 条路由，含停用】" : ""));
    }
    if (!apply) { console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。"); process.exit(0); }
    const r = initDefaultRoute({ file: routesArg, id, handler, note });
    if (!r.ok) { console.error("没有写入：" + (REASON_TEXT[r.reason] ?? r.reason) + (r.error ? "：" + r.error : "")); process.exit(1); }
    console.log("\n已写入：" + r.id + " → " + r.handler + "（default: true）");
    console.log("接下来才能登记外部处理器 —— 表里有默认路由时，未登记话题不会落到别人的处理器上。");
    process.exit(0);
  }

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
  // 新增路由 + 表里没有默认路由 = --apply 会被守卫拒（issue #222），预览时就说清楚。
  if (!hasRoute && !before.routes.some((r) => r.isDefault)) {
    console.log("注意      表里没有启用的默认路由 —— --apply 会拒（no_default_route_yet），" +
      "先用 --init-default 播种本链默认路由。");
  }
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
