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

import { acquirePublishLock, releasePublishLock } from "./registry.mjs";

export const DEFAULT_ROUTES = path.join(os.homedir(), ".claude", "feishu-bridge", "routes.json");

export function routesPath() {
  return process.env.FEISHU_BRIDGE_ROUTES || DEFAULT_ROUTES;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 读路由表。**只有文件不存在才算"本机没配路由"。**
 *
 * 绝大多数机器只有一个消费者，那种情况下表不存在，分发器走默认路由，行为跟没有
 * 分发层时一模一样 —— 这是正常状态，不是故障。
 *
 * 但"读不出来"和"没有"必须分开。表损坏时当成空表，后果有两个方向都很糟：
 * 分发器会把消息转给默认 handler（本该属于别人的话题落到了别人手里），
 * 登记命令会把损坏的表当成首次创建直接覆盖（剩下的登记全没了）。
 * 所以除 ENOENT 外一律 fail-closed。
 */
export function loadRoutes(file = routesPath()) {
  const read = readRoutesDoc(file);
  if (!read.ok) return { ...read, file, routes: [], sessions: {} };
  if (read.doc === null) return { ok: true, reason: "no_routes", file, routes: [], sessions: {} };

  const routes = [];
  for (const r of read.doc.routes ?? []) {
    if (!r || typeof r.id !== "string" || typeof r.handler !== "string") continue;
    if (r.enabled === false) continue;
    routes.push({ id: r.id, handler: r.handler, isDefault: r.default === true, note: r.note ?? null });
  }
  const sessions = {};
  for (const [sid, id] of Object.entries(read.doc.sessions ?? {})) {
    if (typeof sid === "string" && typeof id === "string") sessions[sid] = id;
  }
  return { ok: true, file, routes, sessions };
}

/**
 * 读原始文档并校验形状。返回 doc:null 表示文件不存在（可以初始化空表）。
 *
 * 结构异常不替换成空结构就继续 —— 那等于"我看不懂就当它没有"，
 * 而下一步要么是投递、要么是整表写回，两者都会造成实质损失。
 */
function readRoutesDoc(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, doc: null };
    return { ok: false, reason: ROUTE_REJECT.TABLE_UNREADABLE, error: err.message };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    return { ok: false, reason: ROUTE_REJECT.TABLE_UNREADABLE, error: err.message };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: ROUTE_REJECT.TABLE_SHAPE };
  if (parsed.routes !== undefined && !Array.isArray(parsed.routes)) {
    return { ok: false, reason: ROUTE_REJECT.TABLE_SHAPE };
  }
  if (parsed.sessions !== undefined && !isPlainObject(parsed.sessions)) {
    return { ok: false, reason: ROUTE_REJECT.TABLE_SHAPE };
  }
  return { ok: true, doc: parsed };
}

export const ROUTE_REJECT = {
  NO_HANDLER: "no_route_handler",
  UNKNOWN_ROUTE: "session_maps_to_unknown_route",
  HANDLER_MISSING: "route_handler_missing",
  TABLE_UNREADABLE: "routes_table_unreadable",
  TABLE_SHAPE: "routes_table_shape_unexpected",
};

export const ROUTE_REJECT_TEXT = {
  [ROUTE_REJECT.NO_HANDLER]: "本机没有配置任何入站处理者",
  [ROUTE_REJECT.UNKNOWN_ROUTE]: "这个话题登记的路由在路由表里不存在",
  [ROUTE_REJECT.HANDLER_MISSING]: "路由指向的脚本不在",
  [ROUTE_REJECT.TABLE_UNREADABLE]: "本机路由表读不出来，已停止投递",
  [ROUTE_REJECT.TABLE_SHAPE]: "本机路由表结构异常，已停止投递",
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

/** 路由表的写锁。登记 route 和登记 session 必须在同一把锁下，否则会丢更新。 */
const routesLockDir = (file) => file + ".lock";

/**
 * 一次事务里登记路由 + 认领话题。**这是唯一的写入口。**
 *
 * 为什么必须是一个事务：先写 route、再写 session 是两次读改写。中间任何一步
 * 出事都会留下半截状态 —— 实测过预检之后话题被别的进程认领，结果新 route 已经
 * 写进去了、session 登记被拒。锁外预检挡不住这个，因为预检和写入之间没有互斥。
 *
 * 校验全部在锁内重做一遍：锁外读到的那份跟要写的那份不是同一个快照。
 */
export function registerRouteBinding({ id, handler, note = null, sessionId = null, file = routesPath() }) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "no_route_id" };
  if (typeof handler !== "string" || !path.isAbsolute(handler)) {
    return { ok: false, reason: "handler_not_absolute" };
  }
  // 目录也能通过 existsSync。要求是可读的普通文件，否则登记出来的路由投不进去。
  let stat;
  try { stat = fs.statSync(handler); } catch { return { ok: false, reason: "handler_missing", handler }; }
  if (!stat.isFile()) return { ok: false, reason: "handler_not_a_file", handler };
  try { fs.accessSync(handler, fs.constants.R_OK); } catch {
    return { ok: false, reason: "handler_not_readable", handler };
  }
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) {
    return { ok: false, reason: "no_session_id" };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockDir = routesLockDir(file);
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "routes_busy" };
  try {
    const read = readRoutesDoc(file);
    if (!read.ok) return { ok: false, reason: read.reason, error: read.error };
    const doc = read.doc ?? { schema_version: "1.0", routes: [], sessions: {} };
    if (!Array.isArray(doc.routes)) doc.routes = [];
    if (!isPlainObject(doc.sessions)) doc.sessions = {};

    // ---- 锁内校验：两边都过了才动任何一边 ----
    const existing = doc.routes.find((r) => isPlainObject(r) && r.id === id);
    if (existing) {
      if (existing.handler !== handler) {
        return { ok: false, reason: "route_id_owned_by_other_handler", owner: existing.handler };
      }
      // 停用的路由 loadRoutes 根本不加载，handler 实际没接通。报"已登记"是虚假成功。
      // 重新启用是另一件事，要显式做，不能由登记命令暗中完成。
      if (existing.enabled === false) return { ok: false, reason: "route_disabled", id };
    }
    const declared = sessionId === null ? undefined : doc.sessions[sessionId];
    if (typeof declared === "string" && declared !== id) {
      return { ok: false, reason: "session_owned_by_other_route", owner: declared };
    }

    // ---- 单次原子写 ----
    const routeChanged = !existing;
    const sessionChanged = sessionId !== null && declared !== id;
    if (routeChanged) doc.routes.push(note ? { id, handler, note } : { id, handler });
    if (sessionChanged) doc.sessions[sessionId] = id;
    if (routeChanged || sessionChanged) writeRoutesDoc(doc, file);
    return { ok: true, id, routeChanged, sessionChanged };
  } finally {
    releasePublishLock(lockDir);
  }
}

/**
 * 只登记路由。走同一把锁 —— 不加锁的读改写在并发下会丢更新。
 *
 * 幂等：同 id 同 handler 就什么都不做。同 id **换 handler** 会被拒 ——
 * 那是把别人的话题悄悄改判给另一个脚本。
 *
 * 刻意**不支持**设 default。默认路由是权威路由，换它要 Frank 逐次授权。
 */
export function registerRoute({ id, handler, note = null, file = routesPath() }) {
  const r = registerRouteBinding({ id, handler, note, sessionId: null, file });
  return r.ok ? { ok: true, changed: r.routeChanged, id: r.id } : r;
}

/**
 * 把一个 session 登记给某条路由。
 *
 * 登记给**别的**路由会被拒：一个话题同时属于两个消费者是配置错误，静默改写会让
 * 「上一条消息进了 A、这一条进了 B」，那是最难查的一类。
 */
export function registerSession({ sessionId, routeId, file = routesPath() }) {
  if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "no_session_id" };
  if (typeof routeId !== "string" || !routeId) return { ok: false, reason: "no_route_id" };

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockDir = routesLockDir(file);
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "routes_busy" };
  try {
    const read = readRoutesDoc(file);
    if (!read.ok) return { ok: false, reason: read.reason, error: read.error };
    const doc = read.doc ?? { schema_version: "1.0", routes: [], sessions: {} };
    if (!isPlainObject(doc.sessions)) doc.sessions = {};

    const existing = doc.sessions[sessionId];
    if (existing === routeId) return { ok: true, changed: false };
    if (typeof existing === "string") {
      return { ok: false, reason: "session_owned_by_other_route", owner: existing };
    }
    doc.sessions[sessionId] = routeId;
    writeRoutesDoc(doc, file);
    return { ok: true, changed: true };
  } finally {
    releasePublishLock(lockDir);
  }
}

/** 原子写。写到一半被打断会让整张表截断 —— 那不只是某条路由坏了，是入站全挂。 */
function writeRoutesDoc(doc, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
