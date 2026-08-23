/**
 * 入站路由表 —— 一条 Aily 回合该交给谁。
 *
 * 为什么需要它：本机现在不止一个消费者。cc2cd 有自己的话题绑定和自己的入站脚本，
 * 它先前的做法是**包住**本仓库的 inbound.mjs（判不出归属就 exec 它、原样透出）。
 * 那个做法能跑，但有三处代价：
 *
 *   1. 技能和 Hook 只能指向一个入口 —— 谁后装谁赢，第三个消费者出现时得包第二层，
 *      于是嵌套深度和安装顺序成了正确性的一部分。
 *   2. 信封被取两遍：外层取一次判归属，内层再取一次。而 Aily 事件存储是最终一致的，
 *      取信封本身带 4 次重试（≤2.4s）—— 翻倍就顶到「秒级回执」那条契约的上限。
 *   3. 归属逻辑住在包装层，每加一个消费者，最外层都得知道所有内层的绑定。
 *
 * 换成路由表之后：**信封只取一次**，按可信字段查表，交给对应 handler。
 * 加一个消费者 = 加一行注册，不改任何人的代码。
 *
 * 谁能决定路由：**只有原始信封里的可信字段**（session、发送者、caller agent），
 * 以及本地这张表。模型不参与，正文也不参与 —— 正文是 Frank 打的，
 * 让它影响路由等于把路由交给消息内容。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ROUTES = path.join(os.homedir(), ".claude", "feishu-bridge", "routes.json");

export function routesPath() {
  return process.env.FEISHU_BRIDGE_ROUTES || DEFAULT_ROUTES;
}

/**
 * 读路由表。**读不到不是错误** —— 绝大多数机器只有一个消费者，那种情况下
 * 表不存在，分发器直接走默认路由，行为跟没有分发层时一模一样。
 */
export function loadRoutes(file = routesPath()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { ok: true, reason: "no_routes", file, routes: [], sessions: {} };
  }

  const routes = [];
  for (const r of parsed.routes ?? []) {
    if (!r || typeof r.id !== "string" || typeof r.handler !== "string") continue;
    if (r.enabled === false) continue;
    routes.push({ id: r.id, handler: r.handler, isDefault: r.default === true, note: r.note ?? null });
  }
  const sessions = {};
  for (const [sid, id] of Object.entries(parsed.sessions ?? {})) {
    if (typeof sid === "string" && typeof id === "string") sessions[sid] = id;
  }
  return { ok: true, file, routes, sessions };
}

export const ROUTE_REJECT = {
  NO_HANDLER: "no_route_handler",
  UNKNOWN_ROUTE: "session_maps_to_unknown_route",
  HANDLER_MISSING: "route_handler_missing",
};

export const ROUTE_REJECT_TEXT = {
  [ROUTE_REJECT.NO_HANDLER]: "本机没有配置任何入站处理者",
  [ROUTE_REJECT.UNKNOWN_ROUTE]: "这个话题登记的路由在路由表里不存在",
  [ROUTE_REJECT.HANDLER_MISSING]: "路由指向的脚本不在",
};

/**
 * 选路由。纯函数，不碰文件系统 —— handler 存不存在由调用方另判，
 * 因为「表配错了」和「脚本被删了」是两种不同的故障，回执上要能分开。
 *
 * 规则，从确定到兜底：
 *   1. 这个 session 明确登记过 → 用它登记的那个路由
 *   2. 没登记 → 默认路由（通常是本仓库，它自己会处理待绑定认领）
 *
 * 刻意**不做**「问每个 handler 这是不是你的」：那要为每条路由起一个进程，
 * 在秒级回执的预算里放不下，而且「谁先回答谁赢」会让结果依赖进程调度。
 */
export function selectRoute({ sessionId, routes, sessions }) {
  const list = Array.isArray(routes) ? routes : [];
  if (list.length === 0) return { ok: false, reason: ROUTE_REJECT.NO_HANDLER };

  const declared = sessions?.[sessionId];
  if (typeof declared === "string") {
    const hit = list.find((r) => r.id === declared);
    if (!hit) return { ok: false, reason: ROUTE_REJECT.UNKNOWN_ROUTE, declared };
    return { ok: true, route: hit, matchedBy: "session_registration" };
  }

  const fallback = list.find((r) => r.isDefault) ?? (list.length === 1 ? list[0] : null);
  if (!fallback) return { ok: false, reason: ROUTE_REJECT.NO_HANDLER, candidates: list.length };
  return { ok: true, route: fallback, matchedBy: "default" };
}

/**
 * 把一个 session 登记给某条路由。消费者绑定新话题时调它。
 *
 * 幂等：已经登记给同一条路由就什么都不做。登记给**别的**路由会被拒 ——
 * 一个话题同时属于两个消费者是配置错误，静默改写会让「上一条消息进了 A、
 * 这一条进了 B」，那是最难查的一类。
 */
export function registerSession({ sessionId, routeId, file = routesPath() }) {
  if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "no_session_id" };
  if (typeof routeId !== "string" || !routeId) return { ok: false, reason: "no_route_id" };

  let doc = { schema_version: "1.0", routes: [], sessions: {} };
  try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 首次：用上面的空表 */ }
  doc.sessions ??= {};

  const existing = doc.sessions[sessionId];
  if (existing === routeId) return { ok: true, changed: false };
  if (typeof existing === "string" && existing !== routeId) {
    return { ok: false, reason: "session_owned_by_other_route", owner: existing };
  }

  doc.sessions[sessionId] = routeId;
  writeRoutesDoc(doc, file);
  return { ok: true, changed: true };
}

/**
 * 登记一条路由。消费者接入本机时调它。
 *
 * **只改目标字段，不重建文档。**读进来的表原样保留，只往 `routes` 里加一项 ——
 * 因为「读出来的视图」和「文件里的内容」不是一回事：读取会过滤掉 enabled:false
 * 的项，重建则会丢掉本函数不认识的顶层字段。拿视图整体写回等于静默删数据。
 *
 * 幂等：同 id 同 handler 就什么都不做。同 id **换 handler** 会被拒 ——
 * 那是把别人的话题悄悄改判给另一个脚本，跟 registerSession 拒绝改判是同一条理由。
 *
 * 刻意**不支持**设 default。默认路由是权威路由，换它要 Frank 逐次授权。
 */
export function registerRoute({ id, handler, note = null, file = routesPath() }) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "no_route_id" };
  if (typeof handler !== "string" || !path.isAbsolute(handler)) {
    return { ok: false, reason: "handler_not_absolute" };
  }
  if (!fs.existsSync(handler)) return { ok: false, reason: "handler_missing", handler };

  let doc = { schema_version: "1.0", routes: [], sessions: {} };
  try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 首次：用空表 */ }
  if (!Array.isArray(doc.routes)) doc.routes = [];

  const existing = doc.routes.find((r) => r && r.id === id);
  if (existing) {
    if (existing.handler === handler) return { ok: true, changed: false, id };
    return { ok: false, reason: "route_id_owned_by_other_handler", owner: existing.handler };
  }

  doc.routes.push(note ? { id, handler, note } : { id, handler });
  writeRoutesDoc(doc, file);
  return { ok: true, changed: true, id };
}

/** 原子写。写到一半被打断会让整张表截断 —— 那不只是某条路由坏了，是入站全挂。 */
function writeRoutesDoc(doc, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
