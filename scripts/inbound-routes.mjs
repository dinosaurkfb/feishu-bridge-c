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

  // 校验已经保证每一项都能确定地解释，这里只按 enabled 取舍 ——
  // 静默过滤"看不懂的项"是上一版的做法，那正是歧义表能通过的原因。
  const routes = (read.doc.routes ?? [])
    .filter((r) => r.enabled !== false)
    .map((r) => ({ id: r.id, handler: r.handler, isDefault: r.default === true, note: r.note ?? null }));
  return { ok: true, file, routes, sessions: { ...(read.doc.sessions ?? {}) } };
}

// 纯空白的 id 拿去比较、拿去打日志都像"有值"，实际什么都定位不到。
const nonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * 校验整份路由表。**读取、dispatcher、每个写入口共用这一个。**
 *
 * 只查顶层形状不够：routes 是数组、sessions 是对象，里面照样可以有 null 项、
 * 重复 id、两个 default。那种表上一版会静默过滤掉坏项然后返回 ok ——
 * 于是**数组顺序变成了选路依据**，同一个 id 出现两次时先写的那个赢。
 * 权威状态里解释不了的东西必须 fail-closed，不投递也不写入。
 *
 * 不认识的扩展字段原样保留 —— 校验的是能不能确定地解释，不是长得像不像。
 */
export function validateRoutesDoc(doc) {
  const bad = (problem) => ({ ok: false, reason: ROUTE_REJECT.TABLE_SHAPE, problem });
  if (!isPlainObject(doc)) return bad("table_not_object");

  const routes = doc.routes ?? [];
  if (!Array.isArray(routes)) return bad("routes_not_array");
  const seen = new Set();
  let activeDefaults = 0;
  for (const r of routes) {
    if (!isPlainObject(r)) return bad("route_not_object");
    if (!nonEmptyString(r.id)) return bad("route_id_invalid");
    if (!nonEmptyString(r.handler)) return bad("route_handler_invalid");
    // 相对路径会按 dispatcher 的当前工作目录解析 —— 同一张表在不同项目目录下
    // 会执行不同脚本，并把完整 Canonical Event 交给错的消费者。
    // 只在写入口拦不住：旧表是直接读进来的，从没经过写入口。
    if (!path.isAbsolute(r.handler)) return bad("route_handler_not_absolute");
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") return bad("route_enabled_not_boolean");
    if (r.default !== undefined && typeof r.default !== "boolean") return bad("route_default_not_boolean");
    // id 重复时"哪个生效"没有确定答案，只有数组顺序 —— 那不是答案。
    if (seen.has(r.id)) return bad("route_id_duplicated");
    seen.add(r.id);
    if (r.default === true && r.enabled !== false) activeDefaults += 1;
  }
  if (activeDefaults > 1) return bad("multiple_default_routes");

  const sessions = doc.sessions ?? {};
  if (!isPlainObject(sessions)) return bad("sessions_not_object");
  for (const [sid, owner] of Object.entries(sessions)) {
    if (!nonEmptyString(sid)) return bad("session_id_invalid");
    if (!nonEmptyString(owner)) return bad("session_owner_invalid");
  }
  // 登记指向不存在或已停用的路由**不在这里拒**：那是逐条话题的问题，
  // selectRoute 会按 session 报 UNKNOWN_ROUTE，比整表停摆精确。
  return { ok: true };
}

/**
 * 读原始文档并完整校验。返回 doc:null 表示文件不存在（可以初始化空表）。
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
  const valid = validateRoutesDoc(parsed);
  if (!valid.ok) return valid;
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

  // 先看这个话题登记过什么，再谈有没有活动路由。反过来的话，登记指向唯一那条
  // 且它被停用时，报的是"本机没配路由"而不是"这个话题登记的路由不存在" ——
  // 两者都安全 fail-closed，但前者会让排查往错的方向走。
  const declared = sessions?.[sessionId];
  if (typeof declared === "string") {
    const hit = list.find((r) => r.id === declared);
    if (!hit) return { ok: false, reason: ROUTE_REJECT.UNKNOWN_ROUTE, declared };
    return { ok: true, route: hit, matchedBy: "session_registration" };
  }

  if (list.length === 0) return { ok: false, reason: ROUTE_REJECT.NO_HANDLER };

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
    if (routeChanged || sessionChanged) {
      const wrote = writeRoutesDoc(doc, file);
      if (!wrote.ok) return wrote;
    }
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
    const wrote = writeRoutesDoc(doc, file);
    if (!wrote.ok) return wrote;
    return { ok: true, changed: true };
  } finally {
    releasePublishLock(lockDir);
  }
}

/**
 * 默认路由的处理器到底是谁 —— 这是"装了 ≠ 在跑"的那个缺口（issue #88）：
 * 分发器以表里 default 的那条为准，只有表为空时才回退运行时自带的处理器；表是安装器不管理的机器状态。
 * 2026-08-23 起两条链的默认处理器被换成一个 import 别的克隆的包装脚本，装到 runtime/current 的代码 5 天没接管入站，
 * 而"路由存在且启用"两项检查全绿。
 *
 * 分类（三态以上，不折叠）：
 *   no_routes   没有路由表 → 分发器用运行时自带默认处理器（正常）
 *   runtime     默认处理器在 runtimeCurrent 之下（按路径或 realpath 任一命中）
 *   outside     默认处理器在运行时之外 —— 装的运行时没在处理入站
 *   no_default  有路由但没有默认路由（多于一条且都没标 default）→ 未登记话题会被拒
 *   unreadable  表读不出来
 * others 列出非默认路由里处理器在运行时之外的（cc2cd 那种可能是有意的，按备注分辨）。
 */
export function defaultRouteHandler({ file = routesPath(), runtimeCurrent, expectedHandler = null } = {}) {
  if (typeof runtimeCurrent !== "string" || !runtimeCurrent) return { status: "unreadable", why: "runtimeCurrent 缺失" };
  const table = loadRoutes(file);
  if (!table.ok) return { status: "unreadable", why: String(table.reason ?? "说不清") + (table.problem ? "：" + table.problem : "") };
  // 没有表、或表里没有一条启用路由：分发器都用运行时自带的默认处理器（与 inbound-dispatcher 的 routes.length > 0 判据一致）
  if (table.reason === "no_routes" || table.routes.length === 0) return { status: "no_routes", handler: null, others: [], why: table.reason === "no_routes" ? "没有路由表" : "路由表里没有启用的路由" };
  // **只认解析得到的普通文件的 realpath。**按路径字符串前缀判会假绿：runtime 目录下不存在的文件、
  // runtime 目录里一条指向外部的符号链接，都能"以 runtime/current 开头"。
  const realFile = (p) => {
    try { const real = fs.realpathSync(p); return fs.statSync(real).isFile() ? real : null; } catch { return null; }
  };
  let realRoot = null;
  try { realRoot = fs.realpathSync(runtimeCurrent); } catch { /* 运行时没装：任何 handler 都不可能在它之下 */ }
  const expectedReal = expectedHandler ? realFile(expectedHandler) : null;
  const judge = (handler) => {
    if (typeof handler !== "string") return { under: false, why: "handler 不是字符串" };
    const real = realFile(handler);
    if (real === null) return { under: false, why: "不是可解析的普通文件（缺失 / 断链 / 不是文件）" };
    if (realRoot === null || !real.startsWith(realRoot + path.sep)) return { under: false, why: "实际文件在运行时之外：" + real };
    if (expectedHandler !== null && real !== expectedReal) return { under: false, why: "在运行时目录里但不是这条链预期的处理器（" + String(expectedHandler) + "）：" + real };
    return { under: true, why: null };
  };
  const others = table.routes.filter((r) => !r.isDefault && !judge(r.handler).under).map((r) => ({ id: r.id, handler: r.handler, note: r.note }));
  const dflt = table.routes.find((r) => r.isDefault) ?? (table.routes.length === 1 ? table.routes[0] : null);
  if (!dflt) return { status: "no_default", handler: null, others, why: table.routes.length + " 条路由都没标 default" };
  const verdict = judge(dflt.handler);
  return { status: verdict.under ? "runtime" : "outside", id: dflt.id, handler: dflt.handler, note: dflt.note, why: verdict.why, others };
}

/**
 * 把默认路由的处理器改回给定路径（受控入口，替代手改 JSON）。
 * 只动默认那一条；先把整张表备份成 <file>.bak.<时间>；同锁、同原子写。
 * 换默认路由是切权威路由 —— 命令行默认只预览，--apply 才写，且要 Frank 逐次授权。
 */
export function restoreDefaultRoute({ handler, note = null, file = routesPath(), now = new Date() } = {}) {
  if (typeof handler !== "string" || !path.isAbsolute(handler)) return { ok: false, reason: "handler_not_absolute" };
  let stat;
  try { stat = fs.statSync(handler); } catch { return { ok: false, reason: "handler_missing", handler }; }
  if (!stat.isFile()) return { ok: false, reason: "handler_not_a_file", handler };
  try { fs.accessSync(handler, fs.constants.R_OK); } catch { return { ok: false, reason: "handler_not_readable", handler }; }
  const lockDir = routesLockDir(file);
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "routes_busy" };
  try {
    const read = readRoutesDoc(file);
    if (!read.ok) return { ok: false, reason: read.reason, error: read.error };
    if (read.doc === null) return { ok: false, reason: "no_routes" };
    const routes = Array.isArray(read.doc.routes) ? read.doc.routes.filter((r) => isPlainObject(r) && r.enabled !== false) : [];
    const dflt = routes.find((r) => r.default === true) ?? (routes.length === 1 ? routes[0] : null);
    if (!dflt) return { ok: false, reason: "no_default_route" };
    const handlerChanged = dflt.handler !== handler;
    const noteChanged = note !== null && (dflt.note ?? null) !== note;
    if (!handlerChanged && !noteChanged) return { ok: true, changed: false, id: dflt.id, handler };
    const backup = file + ".bak." + now.toISOString().replace(/[:.]/gu, "-");
    try { fs.copyFileSync(file, backup); } catch (err) { return { ok: false, reason: "backup_failed", error: err.message }; }
    const from = dflt.handler;
    dflt.handler = handler;
    if (noteChanged) dflt.note = note;
    const wrote = writeRoutesDoc(read.doc, file);
    if (!wrote.ok) return wrote;
    return { ok: true, changed: true, handlerChanged, noteChanged, id: dflt.id, from, handler, backup };
  } finally {
    releasePublishLock(lockDir);
  }
}

/**
 * 原子写。写到一半被打断会让整张表截断 —— 那不只是某条路由坏了，是入站全挂。
 *
 * 写之前再校验一遍：任何路径都不该把一张解释不了的表落到盘上。
 * 失败返回受控结果，不让 fs 的异常穿透成 Node 堆栈 —— 那对调用方没法处置。
 */
function writeRoutesDoc(doc, file) {
  const valid = validateRoutesDoc(doc);
  if (!valid.ok) return valid;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "routes_unwritable", error: err.message };
  }
}
