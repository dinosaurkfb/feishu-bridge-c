/**
 * Codex 运行时状态。
 *
 * Claude 版以「项目目录」为绑定单位，Codex 版不能这么做：同一个仓库里可以同时有多个
 * Desktop task/thread。这里把绑定提升为 task，并把 locator、claim、outbox 全部放到
 * ~/.codex/feishu-bridge（或显式 FEISHU_CODEX_BRIDGE_HOME）下，绝不写进项目仓库。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadChainTemplate, materializeProjectConfig } from "../chain-template.mjs";
import { extractMentionIds } from "../selector.mjs";
import { acquirePublishLock, isUnder, releasePublishLock } from "../registry.mjs";

// 只有"别人正拿着"才是 registry_busy；锁目录不可写之类的 I/O 错误要原样报出去（评审探针：曾被折叠成 busy 静默跳过）。
const lockFailure = (lock) => (lock.reason === "publisher_busy"
  ? { ok: false, reason: "registry_busy" }
  : { ok: false, reason: "lock_io_error", error: lock.error ?? lock.reason });
import {
  MESSAGE_RECEIVE_EVENT, buildLegacySubscriptionReadModel, compareFirstClaimShadow,
  legacyEndpointId, selectPendingSubscriptionClaim, stableControlId,
} from "../subscription.mjs";
import {
  ROTATION_STATUS, activatePendingTopicGeneration, activeGeneration,
  applyTopicGenerationToMapping, closePendingTopicGeneration, generationForSession,
  failTopicRotation, materializeLegacyTopicFields, pendingGeneration, prepareTopicRotation,
  recordTopicGenerationActivity, registerPendingTopicGeneration, topicGenerationStateForLegacy,
  markPendingClaimReminder,
  markPendingClaimReminderAbandoned,
  reserveClaimReminderAttempt,
} from "../topic-generation.mjs";
import {
  finalizeDialogueTurn, interactionPolicyStateForLegacy, materializeInteractionPolicy,
  reserveDialogueTurn, setInteractionPolicyMode,
} from "../interaction-policy.mjs";

// 待认领**不过期**（2026-08-28）：只有写了显式截止的才过期。没有"窗口长度"常量了。
export const PENDING_WINDOW_MS = null;
export const ACTIVE_LEASE_MAX_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_INBOUND_PREFIX = null;

export function bridgeHome(env = process.env) {
  const explicit = env.FEISHU_CODEX_BRIDGE_HOME;
  if (typeof explicit === "string" && explicit.length > 0) {
    if (!path.isAbsolute(explicit)) throw new Error("FEISHU_CODEX_BRIDGE_HOME 必须是绝对路径");
    return explicit;
  }
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(codexHome)) throw new Error("CODEX_HOME 必须是绝对路径");
  return path.join(codexHome, "feishu-bridge");
}

export const registryFile = (home = bridgeHome()) => path.join(home, "registry.json");
export const templateFile = (home = bridgeHome()) => path.join(home, "chain-config.json");
export const hookLogFile = (home = bridgeHome()) => path.join(home, "hook.log");

const safeKey = (value) => String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
const threadFileKey = (threadId) => crypto.createHash("sha256").update(String(threadId)).digest("hex").slice(0, 24);

const duplicateValues = (tasks, field) => {
  const seen = new Set();
  const duplicate = new Set();
  for (const task of tasks) {
    const value = task?.[field];
    if (value === null || value === undefined || value === "") continue;
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
};

export function validateRegistryTasks(tasks) {
  if (!Array.isArray(tasks)) return { ok: false, reason: "tasks_not_array", duplicateFields: [] };
  const duplicateFields = [];
  for (const field of ["logical_task_key", "codex_thread_id", "root_message_id", "session_id"]) {
    if (duplicateValues(tasks, field).length > 0) duplicateFields.push(field);
  }
  return { ok: duplicateFields.length === 0, reason: duplicateFields.length ? "duplicate_binding" : null, duplicateFields };
}

export function taskStateDir(task, home = bridgeHome()) {
  const key = safeKey(task?.logical_task_key ?? task?.id);
  if (!key) throw new Error("task 缺 logical_task_key");
  return path.join(home, "tasks", key);
}

export const taskPaths = (task, home = bridgeHome()) => {
  const root = taskStateDir(task, home);
  return {
    root,
    claims: path.join(root, "inbound", "delivery-claims"),
    receipts: path.join(root, "inbound", "receipts"),
    runs: path.join(root, "inbound", "runs"),
    sessionLock: path.join(root, "inbound", "session.lock"),
    outbox: path.join(root, "outbound", "outbox"),
    turnInputs: path.join(root, "outbound", "turn-inputs"),
    publishLock: path.join(root, "outbound", "publish.lock"),
    consumed: path.join(root, "inbound", "consumed.json"),
    dialoguePlannerShadow: path.join(root, "inbound", "dialogue-planner-shadow"),
  };
};

export function validateCodexTemplate(template) {
  const problems = [];
  if (template?.chain !== "codex") problems.push("chain 必须等于 codex");
  if (template?.inbound_prefix !== null) {
    problems.push("inbound_prefix 必须为 null（mention 后正文直接作为指令）");
  }
  if (template?.transport_agent_name !== template?.outbound_agent_name) {
    problems.push("transport_agent_name 与 outbound_agent_name 必须相同");
  }
  if (template?.transport_app_id !== template?.outbound_app_id) {
    problems.push("transport_app_id 与 outbound_app_id 必须相同");
  }
  if (template?.transport_open_id !== template?.outbound_open_id) {
    problems.push("transport_open_id 与 outbound_open_id 必须相同");
  }
  return { ok: problems.length === 0, problems };
}

export function loadCodexTemplate(file = templateFile()) {
  const loaded = loadChainTemplate(file);
  if (!loaded.ok) return loaded;
  const v = validateCodexTemplate(loaded.template);
  if (!v.ok) return { ok: false, reason: "not_single_m5codex", file, ...v };
  return loaded;
}

/**
 * **登记表文档的身份契约 —— 读和写前共用这一份。**
 *
 * 上一版写前只查了启用条目的几个重复字段：评审实测登记表已有停用 key `same` 时，
 * addTask 仍能新增启用 key `same` 并返回成功，**落盘后的登记表立刻变成不可读**。
 * 写入把一份自己都读不回来的文档固化下来，比拒绝写入糟得多。
 *
 * 覆盖：形状、停用条目的存储身份、key 字符集、大小写折叠判重、id 契约。
 * 纯函数，不碰文件。
 */
export function validateRegistryDocument(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "registry_malformed", detail: "根节点不是对象" };
  }
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) {
    return { ok: false, reason: "registry_malformed", detail: "tasks 不是数组" };
  }
  const entries = (parsed.tasks ?? []).map((raw, index) => ({ index, raw }));
  const malformed = [];
  // ■ 第一遍：**身份**。覆盖整张原始表，**含停用条目**。
  //
  // 上一版在判重之前就把停用条目 continue 掉了 —— 评审实测：
  // 一条停用 task 和一条启用 task 用完全相同的 key，loadRegistry 仍报 ok，
  // 两者的 outbox 和锁路径完全相同，**启用的那条会去动停用那条的历史内容**。
  // 停用不代表它不占存储身份：目录还在，里面的东西还在。
  const derived = new Map();
  const ids = new Map();
  for (const { index: i, raw } of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      malformed.push({ index: i, why: "不是 task 对象" }); continue;
    }
    // **停用的条目只查"它占不占存储身份"。**
    //
    // 判据要精确到这一点：停用不代表它不占目录（目录还在，里面的东西还在），
    // 但一条连 key 都没有的停用条目跟谁都撞不上，没有理由把整张表判坏。
    // 启用的条目仍然全查。
    const disabled = raw.enabled === false;
    const hasKey = typeof raw.logical_task_key === "string" && raw.logical_task_key !== "";
    if (disabled && !hasKey) continue;
    if (!disabled && (typeof raw.root !== "string" || !path.isAbsolute(raw.root))) {
      malformed.push({ index: i, why: "root 不是绝对路径" }); continue;
    }
    if (!hasKey) {
      malformed.push({ index: i, why: "缺 logical_task_key" }); continue;
    }
    // **key 的字符集要跟生成端一致。**存储目录是 safeKey(key) 算出来的，
    // 它把非法字符统一换成 `_`：`a/b` 和 `a?b` 会落到同一个 tasks/a_b/。
    if (!/^[A-Za-z0-9_-]+$/u.test(raw.logical_task_key)) {
      malformed.push({ index: i, why: "logical_task_key 含非法字符（只允许 A-Za-z0-9_-）" });
      continue;
    }
    // **按目标文件系统的等价关系判重。**本机默认大小写不敏感：
    // Task-A 和 task-a 是两个不同的 key，却指向同一个 inode。
    const storage = safeKey(raw.logical_task_key).toLowerCase();
    if (derived.has(storage)) {
      malformed.push({ index: i,
        why: "存储键与 #" + derived.get(storage) + " 在大小写折叠后相同（都是 " + storage + "）" });
    } else {
      derived.set(storage, i);
    }
    // **id：缺失才补；存在就必须等于 key。**
    // 用 Object.hasOwn 判"存在"，不能用 ?? —— 那会把显式的 "id": null
    // 当成缺失并静默改成 key，而显式空值是**说不清**，不是缺省。
    if (Object.hasOwn(raw, "id") && raw.id !== raw.logical_task_key) {
      malformed.push({ index: i,
        why: "id 与 logical_task_key 不一致（id=" + JSON.stringify(raw.id).slice(0, 40) + "）" });
      continue;
    }
    if (ids.has(raw.logical_task_key)) {
      malformed.push({ index: i, why: "id 与 #" + ids.get(raw.logical_task_key) + " 相同" });
    } else {
      ids.set(raw.logical_task_key, i);
    }
  }

  if (malformed.length > 0) {
    return { ok: false, reason: "registry_malformed",
      detail: malformed.map((m) => "#" + m.index + "（" + m.why + "）").join("、"),
      entries: malformed };
  }
  // **活动视图的重复绑定字段也归这一份。**
  //
  // 上一版 loadRegistry 调两个校验器，写入口只调了其中一个 —— 评审实测：
  // 两条活动记录 key 分别是 a、b、codex_thread_id 相同时，
  // loadRegistry 正确拒绝（duplicate_binding），validateRegistryDocument 却 ok:true，
  // 于是"坏表被隐式修好"照旧存在，**只是我上一条测试恰好选了重复存储键，
  // 正好落在第一层校验里**。
  // 一个"共用校验器"只要还有第二份判据在外面，它就不叫共用。
  const dup = validateRegistryTasks((parsed.tasks ?? []).filter(
    (t) => t && typeof t === "object" && t.enabled !== false));
  if (!dup.ok) {
    return { ok: false, reason: "duplicate_binding",
      detail: "重复绑定字段：" + dup.duplicateFields.join("、"),
      duplicateFields: dup.duplicateFields };
  }
  return { ok: true };
}
export function loadRegistry(file = registryFile()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, file, tasks: [], reason: "no_registry" };
    return { ok: false, file, tasks: [], reason: "registry_unreadable", error: err.message };
  }
  // **结构异常要 fail-closed，不能靠"访问它时会不会抛"来兜。**
  //
  // 评审实测：根节点是 null 或 tasks 是 {} 时两条定位路径都抛 TypeError；
  // 根节点是 [] 时被误报成"目标不存在"——**坏掉的登记表被说成没有这条 task**，
  // 人会去查绑定、去重新绑，而问题在别处。
  // 上一轮我只透传了 loadRegistry 已经结构化返回的故障，没管它自己不校验结构。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, file, tasks: [], reason: "registry_malformed",
      detail: "根节点不是对象" };
  }
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) {
    return { ok: false, file, tasks: [], reason: "registry_malformed",
      detail: "tasks 不是数组" };
  }
  // **身份契约跟写入口共用一份** —— 读放行的和写放行的必须是同一个集合。
  const verdict = validateRegistryDocument(parsed);
  if (!verdict.ok) return { ok: false, file, tasks: [], ...verdict };
  const tasks = [];

  // 身份都验过了，这里才轮到"停用的不参与后续"。
  for (const raw of parsed.tasks ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (raw.enabled === false) continue;
    if (typeof raw.logical_task_key !== "string" || !raw.logical_task_key) continue;
    tasks.push({ ...raw, id: Object.hasOwn(raw, "id") ? raw.id : raw.logical_task_key });
  }

  return { ok: true, file, tasks, schemaVersion: parsed.schema_version ?? "1.0" };
}

/**
 * **登记表的唯一写入口：读原文档、就地改目标条目、写回。**
 *
 * ■ 为什么必须这样
 *
 * loadRegistry 返回的是**过滤后的活动视图**（停用条目已经不在里面）。
 * 而此前七个写路径都是"改视图里的对象 → writeRegistryFixtureUnvalidated(reg.tasks)"——
 * 后者从零重建 `{schema_version, runtime, tasks}`。两件事叠在一起：
 *   · 停用条目**被静默删掉**；
 *   · 顶层未知字段**被静默删掉**；
 *   · 条目上的未知字段也一样。
 * 评审实测："启用 A + 停用 B + 顶层扩展字段"，只改 A 的显示名，
 * 落盘后 B 和顶层字段都没了，而调用方拿到的是 ok:true。
 *
 * 迁移逻辑里本来就写着"视图 + 重建会静默删数据"——**普通写路径还在重复它**。
 *
 * ■ 契约
 *
 * mutate 拿到的是**原始 tasks 数组**（含停用条目、含未知字段），就地改。
 * 返回 false 表示什么都没改（不写盘）。除 tasks 外的顶层字段原样保留。
 * 调用方**只读热路径**仍然可以用 loadRegistry 的活动视图 —— 那是安全的；
 * 危险的只有"拿视图去重建整表"。
 */
/**
 * **就地替换原始数组里的那一条** —— 而不是往上叠字段。
 *
 * `Object.assign` 只能加和改，**删不掉**。评审实测：恢复连接时视图副本里
 * `delete task.paused_at` 了，落盘却仍留着 paused_at ——
 * 磁盘上的状态同时声称"active"和"曾在当前记录中暂停"。
 * **删除语义在 assign 那条路上根本到不了盘。**
 *
 * 保真规则仍然守住："原来没有 id 就仍然没有" ——
 * 视图里的 id 是 loadRegistry 补的，不是文档里本来就有的。
 */
export function replaceRawTask(raw, task) {
  const found = findRawTask(raw, task);
  if (!found.ok) return found;
  const at = raw.indexOf(found.entry);
  const next = { ...task };
  if (!Object.hasOwn(found.entry, "id")) delete next.id;
  raw[at] = next;
  return { ok: true, entry: next };
}

export function mutateRegistryDocument(file, mutate) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (err) {
    // **不存在 = 空文档**，首次写入本来就要把它建出来。
    // 其余读取错误说不清 —— 那时候写回去会覆盖掉一份我们没读懂的文件。
    if (err.code === "ENOENT") parsed = { schema_version: "1.0", runtime: "codex", tasks: [] };
    else return { ok: false, reason: "registry_unreadable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "registry_malformed" };
  }
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) {
    return { ok: false, reason: "registry_malformed" };
  }
  // **回调之前先校验原文档。**
  //
  // 上一版只在改完之后校验：评审构造了一张因重复存储键而被 loadRegistry 拒绝的表，
  // 让回调删掉冲突项 —— 修改前读不出来、mutateRegistryDocument 却返回 ok:true，
  // **坏表被悄悄覆盖成一张新表**。
  // 那既不符合"读放行的和写放行的是同一个集合"，也等于给普通写入口
  // 发了一张**未经授权的隐式修复许可**。修表是人的决定，不是写显示名的副作用。
  const before = validateRegistryDocument(parsed);
  if (!before.ok) return { ok: false, ...before };

  const raw = parsed.tasks ?? [];
  const changed = mutate(raw);
  // mutate 可以返回 { ok:false, reason } 中止 —— **"找不到目标"必须是错误，
  // 不是"没改动"**：后者会让调用方宣称成功。
  if (changed && changed.ok === false) return { ...changed, file };
  if (changed === false) return { ok: true, changed: false, file };
  // 改完再校验一次：前一次保证 fail-closed，这一次保证不会写坏。
  // 写入把一份自己都读不回来的文档固化下来，比拒绝写入糟得多。
  const verdict = validateRegistryDocument({ ...parsed, tasks: raw });
  if (!verdict.ok) return { ok: false, ...verdict };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // **顶层原样保留** —— 只换 tasks。
  const next = { ...parsed, tasks: raw };
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".prev");
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true, changed: true, file };
}

/**
 * 在原始 tasks 数组里定位那一条 —— **按全表唯一的存储键精确定位**。
 *
 * 上一版写的是"key 相同 **或** thread 相同"，评审实测：
 * 停用旧条目与启用新条目 thread 相同、key 不同时，改新条目的显示名
 * **先命中了停用那条**，随后它被覆盖成新条目的身份 —— 调用返回 ok:true，
 * 登记表却出现重复 key/id，下一次读取直接 registry_malformed。
 * **"或"在定位上等于放宽，而定位放宽就是改错东西。**
 *
 * 零项和多项都必须失败，不许当成 changed:false ——
 * "什么都没找到"和"不需要改"是两回事。
 */
export function findRawTask(raw, task) {
  const want = safeKey(task?.logical_task_key ?? "").toLowerCase();
  if (!want) return { ok: false, reason: "entry_key_missing" };
  const hits = (raw ?? []).filter((t) =>
    t && typeof t === "object" && typeof t.logical_task_key === "string"
    && safeKey(t.logical_task_key).toLowerCase() === want);
  if (hits.length === 0) return { ok: false, reason: "entry_gone" };
  if (hits.length > 1) return { ok: false, reason: "entry_ambiguous", count: hits.length };
  const hit = hits[0];
  // **其他身份字段存在就必须对得上** —— 对不上说明这不是同一条。
  if (task?.codex_thread_id && hit.codex_thread_id
      && hit.codex_thread_id !== task.codex_thread_id) {
    return { ok: false, reason: "entry_identity_mismatch" };
  }
  return { ok: true, entry: hit };
}

/**
 * **只给测试用的夹具写入口。生产路径一律走 mutateRegistryDocument。**
 *
 * 名字里带 FixtureUnvalidated 是刻意的：上一版我只在注释里写"用途写死在名字"
 * 和"有一条测试盯着这件事"——**而函数还叫 writeRegistry，那条测试也不存在**。
 * 又一次把设计意图写成了已实现的行为。现在名字和守卫都补上了。
 *
 * 它从零重建 { schema_version, runtime, tasks } —— 顶层未知字段会丢，
 * 而且不走完整文档校验：评审实测 writeRegistryFixtureUnvalidated([{ x: 1 }]) 成功、
 * 随后 loadRegistry 直接 registry_malformed。
 * 只要它还是一个不校验的公开写入口，"唯一写入口"这句话就不成立。
 *
 * 保留它是因为 86 处测试夹具靠它构造初始状态（**包括故意构造坏表**），
 * 那是合法用途。所以这里不加校验，而是把用途写死在名字和这段话里：
 * **生产代码里再出现它就是错的**，有一条测试盯着这件事。
 */
export function writeRegistryFixtureUnvalidated(tasks, file = registryFile()) {
  const valid = validateRegistryTasks(tasks);
  if (!valid.ok) throw new Error("registry 存在重复绑定字段：" + valid.duplicateFields.join(", "));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = { schema_version: "1.0", runtime: "codex", tasks };
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".prev");
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function addTask(task, { home = bridgeHome() } = {}) {
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    if (reg.tasks.some((t) => t.codex_thread_id === task.codex_thread_id)) {
      return { ok: false, reason: "thread_already_bound" };
    }
    const wrote = mutateRegistryDocument(file, (rawTasks) => { rawTasks.push(task); });
    if (!wrote.ok) return wrote;
    return { ok: true, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

export function loadConsumed(task, home = bridgeHome()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(taskPaths(task, home).consumed, "utf-8"));
    return Array.isArray(parsed.ids) ? parsed.ids.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function appendConsumed(task, messageId, { home = bridgeHome(), max = 500 } = {}) {
  const ids = loadConsumed(task, home);
  if (ids.includes(messageId)) return ids;
  const next = [...ids, messageId].slice(-max);
  const file = taskPaths(task, home).consumed;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ ids: next }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

export function mappingForTask(task, { home = bridgeHome() } = {}) {
  const mapping = {
    schema_version: "1.0",
    binding_id: task.id + "@codex-registry",
    binding_mode: "codex_thread_binding",
    status: task.status ?? "active",
    session_id: task.session_id ?? null,
    inbound_state: task.inbound_state ?? "pending",
    pending_token: task.pending_token ?? null,
    pending_expires_at: task.pending_expires_at ?? null,
    channel_generation_id: task.channel_generation_id ?? null,
    topic_generation_state: task.topic_generation_state ?? null,
    interaction_policy_state: task.interaction_policy_state ?? null,
    inbound_prefix: Object.hasOwn(task, "inbound_prefix") ? task.inbound_prefix : DEFAULT_INBOUND_PREFIX,
    logical_task_key: task.logical_task_key,
    codex_thread_id: task.codex_thread_id,
    codex_workdir: task.root,
    feishu_root_message_id_reference: task.root_message_id,
    expires_at: task.expires_at,
    max_inbound_messages: "unlimited",
    freshness_ms: task.freshness_ms ?? null,
    consumed_message_ids: loadConsumed(task, home),
    created_at: task.bound_at ?? null,
    _source: "codex-registry",
  };
  const evolved = applyTopicGenerationToMapping(mapping, {
    runtime: "codex",
    bindingId: mapping.binding_id,
  });
  // 持久化的新状态一旦损坏必须 fail-closed，不能悄悄回落到旧字段继续收消息。
  return evolved.ok ? evolved.mapping : {
    ...mapping,
    status: "invalid",
    topic_generation_error: evolved.reason,
  };
}

export function topicStateForTask(task, { now = Date.now() } = {}) {
  return topicGenerationStateForLegacy(task, {
    runtime: "codex",
    bindingId: (task?.id ?? task?.logical_task_key) + "@codex-registry",
    now,
  });
}

export function interactionPolicyForTask(task, { now = Date.now() } = {}) {
  return interactionPolicyStateForLegacy(task, {
    bindingId: (task?.id ?? task?.logical_task_key) + "@codex-registry",
    now,
  });
}

export function resolveTask(task, { home = bridgeHome(), templatePath = templateFile(home) } = {}) {
  const tpl = loadCodexTemplate(templatePath);
  if (!tpl.ok) return { ok: false, reason: "template_unusable", template: tpl };
  const mapping = mappingForTask(task, { home });
  mapping.frank_sender_id = tpl.template.frank_sender_id;
  const config = materializeProjectConfig({
    template: tpl.template,
    projectRoot: task.root,
    displayName: task.task_display_name ?? task.name,
  });
  if (typeof task.chat_id === "string" && task.chat_id) config.chat_id = task.chat_id;
  if (typeof task.chat_name === "string" && task.chat_name) config.chat_name = task.chat_name;
  config.logical_task_key = task.logical_task_key;
  config.runtime = "codex";
  // 已安装的新合同按轮自动发布；旧登记在安装器显式迁移前保持 false，避免代码更新本身
  // 立刻把历史 outbox 发出去。
  config.auto_publish_on_completion = task.auto_publish_on_completion === true;
  return { ok: true, task, mapping, config, template: tpl.template };
}

export function findTaskForFeishuSession({ sessionId, home = bridgeHome() } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "no_session_id" };
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return reg;
  const hits = reg.tasks.filter((candidate) => {
    if ((candidate.status ?? "active") !== "active") return false;
    const loaded = topicStateForTask(candidate);
    // active 与 read-only 历史代际的 session 都路由（goal 第 2 层：老话题也能下指令）
    return loaded.ok && Boolean(generationForSession(loaded.state, sessionId));
  });
  // 命中多条说不清是谁的：不按登记顺序取第一条（评审探针）。
  if (hits.length > 1) return { ok: false, reason: "ambiguous_session", candidates: hits.length };
  const task = hits[0];
  if (!task) return { ok: false, reason: "no_binding_for_session", candidates: reg.tasks.length };
  const resolved = resolveTask(task, { home });
  return resolved.ok ? { ok: true, ...resolved } : resolved;
}

export function findTaskForCodexThread({ threadId, home = bridgeHome() } = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return reg;
  const task = reg.tasks.find((t) => (t.status ?? "active") === "active" && t.codex_thread_id === threadId);
  return task ? { ok: true, task } : { ok: false, reason: "thread_not_bound" };
}

export function findRegisteredTaskForCodexThread({ threadId, home = bridgeHome() } = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return reg;
  const task = reg.tasks.find((t) => t.codex_thread_id === threadId);
  return task ? { ok: true, task } : { ok: false, reason: "thread_not_registered" };
}

export function setTaskConnectionStatus({
  threadId, status, home = bridgeHome(), now = Date.now(),
} = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  if (!new Set(["active", "paused"]).has(status)) return { ok: false, reason: "invalid_status" };
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    const current = task.status ?? "active";
    if (current === status) return { ok: true, changed: false, task };

    const loaded = topicStateForTask(task, { now });
    if (!loaded.ok) return loaded;
    loaded.state.binding_status = status;
    loaded.state.updated_at = new Date(now).toISOString();
    if (status === "paused") {
      task.paused_at = new Date(now).toISOString();
    } else {
      task.resumed_at = new Date(now).toISOString();
      delete task.paused_at;
      // 尚未完成首次 mention 的绑定在恢复时清掉旧的显式截止 —— 待认领不过期。
      const pending = pendingGeneration(loaded.state);
      if (pending && !activeGeneration(loaded.state)) {
        pending.claim_expires_at = null;
      }
    }
    const materialized = materializeLegacyTopicFields(task, loaded.state);
    if (!materialized.ok) return materialized;
    Object.assign(task, materialized.record);
    // **不许拿视图重建整表。**视图里的 task 是副本，且停用条目/顶层未知字段
    // 都不在视图里 —— 重建一次就把它们静默删了。就地改原文档里的那一条。
    const wrote = mutateRegistryDocument(file, (rawTasks) => {
      const done = replaceRawTask(rawTasks, task);
      if (!done.ok) return done;            // 找不到 / 有歧义 → 错误，不是"没改动"
      return true;
    });
    if (!wrote.ok) return wrote;
    return { ok: true, changed: true, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

/**
 * 给已经建好话题、但尚未完成首次 mention 的 task 重新开放握手窗口。
 *
 * 这和“恢复暂停连接”是两种不同状态迁移：task 可以一直处于 active，却因为用户隔天才
 * 去飞书完成首次 mention 而让 pending 窗口过期。重跑 $feishu-bind 时只应续期原登记，
 * 不能因为 task 已 active 就直接返回，更不能创建第二个话题。
 */
export function refreshPendingTaskBinding({
  threadId, home = bridgeHome(), now = Date.now(),
} = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    if ((task.status ?? "active") !== "active") return { ok: false, reason: "task_not_active" };
    const loaded = topicStateForTask(task, { now });
    if (!loaded.ok) return loaded;
    const pending = pendingGeneration(loaded.state);
    if (!pending || activeGeneration(loaded.state)) {
      return { ok: false, reason: "task_not_pending" };
    }
    pending.claim_expires_at = null; // 刷新 = 清掉旧的显式截止；待认领不过期
    loaded.state.updated_at = new Date(now).toISOString();
    const materialized = materializeLegacyTopicFields(task, loaded.state);
    if (!materialized.ok) return materialized;
    Object.assign(task, materialized.record);
    task.pending_refreshed_at = new Date(now).toISOString();
    // **不许拿视图重建整表。**视图里的 task 是副本，且停用条目/顶层未知字段
    // 都不在视图里 —— 重建一次就把它们静默删了。就地改原文档里的那一条。
    const wrote = mutateRegistryDocument(file, (rawTasks) => {
      const done = replaceRawTask(rawTasks, task);
      if (!done.ok) return done;            // 找不到 / 有歧义 → 错误，不是"没改动"
      return true;
    });
    if (!wrote.ok) return wrote;
    return { ok: true, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

export function setTaskDisplayName({ threadId, name, home = bridgeHome() } = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "invalid_name" };
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    task.task_display_name = name.trim();
    // **不许拿视图重建整表。**视图里的 task 是副本，且停用条目/顶层未知字段
    // 都不在视图里 —— 重建一次就把它们静默删了。就地改原文档里的那一条。
    const wrote = mutateRegistryDocument(file, (rawTasks) => {
      const done = replaceRawTask(rawTasks, task);
      if (!done.ok) return done;            // 找不到 / 有歧义 → 错误，不是"没改动"
      return true;
    });
    if (!wrote.ok) return wrote;
    return { ok: true, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

/** 这次迁移的身份。写进持久回执，让"跑没跑过、跑的是哪一版"变成可回答的问题。 */
export const AUTO_PUBLISH_MIGRATION_ID = "auto_publish_on_completion_v1";

const migrationsFile = (home) => path.join(home, "migrations.json");

/**
 * 读原始登记文档 —— **不用 loadRegistry**。
 *
 * loadRegistry 返回的是「视图」：它会滤掉 enabled:false 的 task、滤掉 root 不是绝对
 * 路径的记录、给缺 id 的补写 id；writeRegistry 又只重建 schema_version/runtime/tasks
 * 三个顶层字段。整表迁移用这对组合 = 把没被读出来的记录和不认识的顶层字段静默删掉。
 * 迁移只该改目标字段，别的原样留着。
 */
function readRawRegistry(file) {
  try {
    return { ok: true, doc: JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, doc: null };
    return { ok: false, reason: "registry_unreadable", error: err.message };
  }
}

/** 原子写原始文档，保留全部顶层字段。跟 writeRegistry 一样先留 .prev 备份。 */
function writeRawRegistry(doc, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".prev");
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 扫描待迁移项。**遇到解释不了的结构就 fail-closed**，不过滤后继续 ——
 * 过滤意味着"我看不懂这条，那就当它不存在"，而下一步是整表写回，等于删掉它。
 *
 * 返回的 pendingRefs 是 doc.tasks 里的**对象引用**，就地改字段，不重建数组。
 */
function scanAutoPublish(doc) {
  if (doc === null) return { ok: true, total: 0, pendingRefs: [], names: [] };
  if (!Array.isArray(doc.tasks)) return { ok: false, reason: "registry_shape_unexpected" };
  // **迁移也要过共用契约。**
  //
  // 上一版这里只查数组/对象形状，写回又走另一套 writeRawRegistry ——
  // 评审实测：两条 codex_thread_id 重复的登记，主读取器返回 duplicate_binding，
  // 而 enableAutoPublishForAllTasks({apply:true}) 返回 ok:true、改了两个条目、
  // **写完登记表仍然不可读**。
  // 那违反"读、写前、写后接受同一集合"，而且它是我漏掉的第二条整表写路径 ——
  // 我之前扫的是 writeRegistry(，`writeRawRegistry(` 根本不匹配。
  const verdict = validateRegistryDocument(doc);
  if (!verdict.ok) return { ok: false, ...verdict };
  const pendingRefs = [];
  for (const task of doc.tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      return { ok: false, reason: "registry_entry_unreadable" };
    }
    if (task.auto_publish_on_completion !== true) pendingRefs.push(task);
  }
  return {
    ok: true,
    total: doc.tasks.length,
    pendingRefs,
    // 只出脱敏名称，不出 thread locator。
    names: pendingRefs.map((t) =>
      t.task_display_name ?? t.id ?? t.logical_task_key ?? "(未命名)"),
  };
}

/**
 * 读迁移账本。**只有 ENOENT 才算首次运行。**
 *
 * 解析失败、权限失败、顶层不是普通对象 —— 一律 fail-closed。把这些也当成"首次"，
 * 会让一次迁移直接覆盖掉别的迁移的回执：账本坏了不是重建它的理由，是停下的理由。
 */
function readMigrationLedger(home) {
  let raw;
  try {
    raw = fs.readFileSync(migrationsFile(home), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, ledger: {} };
    return { ok: false, reason: "migrations_unreadable", error: err.message };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    return { ok: false, reason: "migrations_unreadable", error: err.message };
  }
  // 数组也是 JSON 对象，但 all[id] = … 之后 stringify 会把它丢掉 —— 于是
  // 回执"写成功了"却读不回来。必须在这里挡掉，不能等到写完才发现。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "migrations_shape_unexpected" };
  }
  return { ok: true, ledger: parsed };
}

/** 读某一版迁移的回执。回执缺失只说明"没记录到"，不等于没跑过 —— 重跑是幂等的。 */
export function readMigrationReceipt(home = bridgeHome(), id = AUTO_PUBLISH_MIGRATION_ID) {
  const read = readMigrationLedger(home);
  return read.ok ? (read.ledger[id] ?? null) : null;
}

/**
 * 落盘回执，并**读回来核验**。
 *
 * 先写登记表再写回执：反过来的话中途崩溃会留下一份声称迁移完成、但登记表没改的
 * 回执 —— 往谎报成功的方向错。回执写不成只是"可能跑过"，安全方向。
 *
 * 写完必须重读核验才敢报 receipt:true。写入返回没报错不等于内容落对了 ——
 * 账本是数组时 `all[id] = …` 就是这么无声无息地什么都没留下的。
 */
function writeReceipt(home, { tasks, changed }) {
  try {
    const read = readMigrationLedger(home);
    if (!read.ok) return { receipt: false, receiptError: read.reason };

    const file = migrationsFile(home);
    const entry = { applied_at: new Date().toISOString(), tasks, changed };
    const next = { ...read.ledger, [AUTO_PUBLISH_MIGRATION_ID]: entry };
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);

    const back = readMigrationReceipt(home);
    if (!back || back.applied_at !== entry.applied_at || back.changed !== entry.changed) {
      return { receipt: false, receiptError: "receipt_not_readable_after_write" };
    }
    return { receipt: true };
  } catch (err) {
    // 登记表已经改完了。这里报 true 就是谎报。
    return { receipt: false, receiptError: err.message };
  }
}

/**
 * 把既有 task 迁移到「完成即自动发布」。
 *
 * **默认只预览，`apply: true` 才写。**原来它挂在安装器上，每次 `--apply` 都会把所有
 * task 的 auto_publish_on_completion 强改为 true —— 那是在改**订阅策略**，不是装基础设施。
 *
 * 新绑定不依赖这次迁移：登记时就默认 true（见 registerTask）。这里只处理历史 task。
 *
 * apply 路径下 **tasks/changed/names 全部出自锁内那一份文档**：预览快照和落盘快照
 * 不是同一份时，会出现"改了这批、列的却是那批"。
 */
export function enableAutoPublishForAllTasks({ home = bridgeHome(), apply = false } = {}) {
  const file = registryFile(home);

  const report = (scan, extra) => ({
    ok: true, migration: AUTO_PUBLISH_MIGRATION_ID,
    tasks: scan.total, changed: scan.pendingRefs.length, names: scan.names, ...extra,
  });

  if (!apply) {
    const snap = readRawRegistry(file);
    if (!snap.ok) return snap;
    const scan = scanAutoPublish(snap.doc);
    if (!scan.ok) return scan;
    // 账本坏了和没有回执不是一回事。readMigrationReceipt 把两者都压成 null
    // 是为了让调用方好写，但预览是审计用途，这里必须分开报。
    const ledger = readMigrationLedger(home);
    return report(scan, {
      applied: false,
      receipt: ledger.ok ? (ledger.ledger[AUTO_PUBLISH_MIGRATION_ID] ?? null) : null,
      receiptProblem: ledger.ok ? null : ledger.reason,
    });
  }

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    // 取锁之后才读：锁外读到的那份跟要写的那份不是同一个快照。
    const snap = readRawRegistry(file);
    if (!snap.ok) return snap;
    const scan = scanAutoPublish(snap.doc);
    if (!scan.ok) return scan;

    // 锁内预检账本：账本坏了就别动登记表 —— 否则改完了却记不下来，
    // 「跑没跑过、跑的是哪一版」立刻变回答不了的问题。
    const ledger = readMigrationLedger(home);
    if (!ledger.ok) return { ok: false, reason: ledger.reason, error: ledger.error };

    if (scan.pendingRefs.length > 0) {
      for (const task of scan.pendingRefs) task.auto_publish_on_completion = true;
      // 改完再校验一次：前一次保证 fail-closed，这一次保证不会写坏。
      const after = validateRegistryDocument(snap.doc);
      if (!after.ok) return { ok: false, ...after };
      writeRawRegistry(snap.doc, file);
    }
    // 零变更也留回执：否则"跑过但本来就没东西可改"和"从没跑过"分不开。
    return report(scan, { applied: true, ...writeReceipt(home, { tasks: scan.total, changed: scan.pendingRefs.length }) });
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

// 只有写了显式截止的 task 才会过期；没写（或 null）= 不过期。
const pendingDeadline = (task) => {
  const explicit = Date.parse(task?.pending_expires_at ?? "");
  return Number.isFinite(explicit) ? explicit : Infinity;
};

/**
 * Aily 不透传飞书 root_id，但回复话题根消息时会把根消息作为 Markdown 引用附在正文后。
 * 只认引用行里的六位绑定码，正文里手打一个相同字符串不算根消息证据。
 */
export function extractQuotedBindingTokens(content) {
  if (typeof content !== "string") return [];
  const found = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*>\s*绑定码\s*[:：]?\s*([0-9a-f]{6})\s*$/iu);
    if (match) found.push(match[1].toLowerCase());
  }
  return [...new Set(found)];
}

export function findPendingTask({ home = bridgeHome(), now = Date.now(), content } = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return reg;
  const pending = reg.tasks.flatMap((task) => {
    if ((task.status ?? "active") !== "active") return [];
    const loaded = topicStateForTask(task, { now });
    if (!loaded.ok) return [];
    const generation = pendingGeneration(loaded.state);
    return generation ? [{
      task,
      generation,
      operationId: loaded.state.rotation?.operation_id ?? null,
    }] : [];
  });
  if (pending.length === 0) return { ok: false, reason: "no_pending_binding" };

  const tokens = extractQuotedBindingTokens(content);
  if (tokens.length > 1) return { ok: false, reason: "multiple_binding_tokens" };

  let selected;
  if (tokens.length === 1) {
    const matches = pending.filter(({ generation }) =>
      typeof generation.pending_token === "string" &&
      generation.pending_token.toLowerCase() === tokens[0]);
    if (matches.length === 0) return { ok: false, reason: "pending_binding_token_unknown" };
    if (matches.length > 1) return { ok: false, reason: "duplicate_pending_binding_token" };
    selected = matches[0];
  } else {
    // 兼容旧根消息或非话题表面：没有引用码时仍只允许全机唯一 pending，绝不按目录或标题猜。
    if (pending.length > 1) {
      return { ok: false, reason: "multiple_pending_bindings", ids: pending.map(({ task }) => task.id) };
    }
    selected = pending[0];
  }

  const explicit = Date.parse(selected.generation.claim_expires_at ?? "");
  const deadline = Number.isFinite(explicit) ? explicit : pendingDeadline(selected.task);
  if (now >= deadline) return {
    ok: false,
    reason: "pending_binding_expired",
    task: selected.task,
    generation: selected.generation,
    generationId: selected.generation.channel_generation_id,
    operationId: selected.operationId,
  };
  return {
    ok: true,
    task: selected.task,
    generation: selected.generation,
    generationId: selected.generation.channel_generation_id,
    source: tokens.length === 1 ? "quoted_binding_token" : "sole_pending",
  };
}

/**
 * 现有 Codex task registry → Subscription v1；不写控制面状态，不改变现有 task。
 *
 * `threadId` 传了就只投影那一条 —— status 和 subscribe 说"当前这条 task"，
 * 就不能把别的 task 的订阅和待认领计数算进来。
 * **默认仍是全局视图**：首次认领 shadow 需要它，那个默认不能改。
 */
export function buildCodexSubscriptionProjection({
  home = bridgeHome(), template, threadId = null,
} = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return reg;
  const loadedTemplate = template
    ? { ok: true, template }
    : loadCodexTemplate(templateFile(home));
  if (!loadedTemplate.ok) return { ok: false, reason: "template_unusable" };
  const resolvedTemplate = loadedTemplate.template;
  const endpointId = legacyEndpointId({ runtime: "codex", agentUid: resolvedTemplate.agent_uid });
  const records = reg.tasks.filter(
    (task) => threadId === null || task.codex_thread_id === threadId,
  ).map((task) => {
    const state = topicStateForTask(task);
    const pending = state.ok ? pendingGeneration(state.state) : null;
    const active = state.ok ? activeGeneration(state.state) : null;
    return {
      legacy_key: task.logical_task_key,
      domain_key: task.root,
      local_target_id: stableControlId("target", "codex", task.logical_task_key),
      status: task.status ?? "active",
      inbound_state: pending ? "pending" : (task.inbound_state ?? "bound"),
      session_id: pending ? null : (active?.session_id ?? task.session_id ?? null),
      pending_token: pending?.pending_token ?? null,
      pending_expires_at: pending?.claim_expires_at ?? null,
      bound_at: pending?.created_at ?? task.bound_at,
      chat_id: task.chat_id ?? resolvedTemplate.chat_id,
    };
  });
  return buildLegacySubscriptionReadModel({
    runtime: "codex", endpointId, template: resolvedTemplate, records,
    pendingWindowMs: PENDING_WINDOW_MS,
  });
}

/** 首次认领的新旧 shadow 对照；不 claim、不写 registry、不启动 Codex。 */
export function shadowCodexFirstClaim({
  event, template, callerAgentUid, legacyPending, legacyPromotion,
  home = bridgeHome(), now = Date.now(),
} = {}) {
  const model = buildCodexSubscriptionProjection({ home, template });
  const endpointId = legacyEndpointId({ runtime: "codex", agentUid: template?.agent_uid });
  const candidate = selectPendingSubscriptionClaim({
    model,
    evidence: {
      endpoint_id: endpointId,
      caller_agent_uid: callerAgentUid,
      sender_id: event?.sender_id,
      mention_ids: extractMentionIds(event?.content),
      event_type: MESSAGE_RECEIVE_EVENT,
      chat_id: null,
      created_at_ms: event?.created_at_ms,
    },
    bindingTokens: extractQuotedBindingTokens(event?.content),
    now,
  });
  return compareFirstClaimShadow({
    legacy: {
      ok: legacyPromotion?.ok === true,
      target_key: legacyPromotion?.ok ? legacyPromotion.task?.logical_task_key : null,
      reason: legacyPromotion?.reason ?? legacyPending?.reason,
    },
    candidate,
  });
}

export function evaluatePromotion({ event, template, pending, now = Date.now() }) {
  if (!pending?.ok) return { ok: false, reason: pending?.reason ?? "no_pending_binding" };
  if (event?.sender_id !== template?.frank_sender_id) return { ok: false, reason: "sender_not_frank" };
  if (!extractMentionIds(event?.content).includes(template?.transport_open_id)) {
    return { ok: false, reason: "transport_not_mentioned" };
  }
  const createdAt = Number(event?.created_at_ms);
  if (!Number.isFinite(createdAt)) return { ok: false, reason: "malformed_event" };
  if (now - createdAt > template.default_freshness_ms) return { ok: false, reason: "stale_message" };
  return { ok: true, task: pending.task };
}

export function promoteTask({
  logicalTaskKey, sessionId, generationId, operationId,
  home = bridgeHome(), now = Date.now(),
}) {
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.logical_task_key === logicalTaskKey);
    if (!task) return { ok: false, reason: "entry_gone" };
    if ((task.status ?? "active") !== "active") {
      return { ok: false, reason: "entry_not_pending" };
    }
    const loaded = topicStateForTask(task, { now });
    if (!loaded.ok || !pendingGeneration(loaded.state)) return { ok: false, reason: "entry_not_pending" };
    const sessionUsed = reg.tasks.some((candidate) => {
      if (candidate.logical_task_key === logicalTaskKey) return false;
      const candidateState = topicStateForTask(candidate, { now });
      return candidateState.ok && candidateState.state.generations.some((generation) =>
        generation.session_id === sessionId && generation.status !== "retired");
    });
    if (sessionUsed) {
      return { ok: false, reason: "session_already_bound" };
    }
    const activated = activatePendingTopicGeneration(loaded.state, {
      generationId,
      sessionId,
      operationId,
      now,
    });
    if (!activated.ok) return activated;
    const materialized = materializeLegacyTopicFields(task, activated.state);
    if (!materialized.ok) return materialized;
    Object.assign(task, materialized.record, {
      inbound_bound_at: new Date(now).toISOString(),
    });
    // **不许拿视图重建整表。**视图里的 task 是副本，且停用条目/顶层未知字段
    // 都不在视图里 —— 重建一次就把它们静默删了。就地改原文档里的那一条。
    const wrote = mutateRegistryDocument(file, (rawTasks) => {
      const done = replaceRawTask(rawTasks, task);
      if (!done.ok) return done;            // 找不到 / 有歧义 → 错误，不是"没改动"
      return true;
    });
    if (!wrote.ok) return wrote;
    return {
      ok: true,
      task,
      generation: activated.active,
      previousGeneration: activated.previous,
    };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

function mutateTaskTopicState({
  threadId,
  home = bridgeHome(),
  now = Date.now(),
  mutate,
} = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((candidate) => candidate.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    const loaded = topicStateForTask(task, { now });
    if (!loaded.ok) return loaded;
    const changed = mutate(loaded.state, task);
    if (!changed?.ok) return changed;
    const materialized = materializeLegacyTopicFields(task, changed.state);
    if (!materialized.ok) return materialized;
    Object.assign(task, materialized.record);
    // **不许拿视图重建整表。**视图里的 task 是副本，且停用条目/顶层未知字段
    // 都不在视图里 —— 重建一次就把它们静默删了。就地改原文档里的那一条。
    const wrote = mutateRegistryDocument(file, (rawTasks) => {
      const done = replaceRawTask(rawTasks, task);
      if (!done.ok) return done;            // 找不到 / 有歧义 → 错误，不是"没改动"
      return true;
    });
    if (!wrote.ok) return wrote;
    return { ...changed, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

/** 轮转 phase 1：只登记 operation，网络调用在锁外由 CLI 完成。 */
export function prepareTaskTopicRotation({
  threadId, operationId, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => prepareTopicRotation(state, { operationId, now }),
  });
}

/** 轮转 phase 2：根话题创建成功后登记 pending generation。 */
export function registerTaskTopicRotation({
  threadId, operationId, rootMessageId, pendingToken, claimExpiresAt,
  home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => registerPendingTopicGeneration(state, {
      operationId, rootMessageId, pendingToken, claimExpiresAt, now,
    }),
  });
}

export function failTaskTopicRotation({
  threadId, operationId, reason, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => failTopicRotation(state, { operationId, reason, now }),
  });
}

export function closeTaskTopicRotation({
  threadId, operationId, reason = ROTATION_STATUS.CANCELLED,
  home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => closePendingTopicGeneration(state, { operationId, reason, now }),
  });
}

/** 锁内预留一次待认领提醒尝试（判据在锁内重算，并发只有一个能拿到）。 */
export function reserveTaskClaimReminder({
  threadId, generationId, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => reserveClaimReminderAttempt(state, { generationId, now }),
  });
}

/** 本周期尝试用尽：原子记下放弃时间，下个周期重来。 */
export function markTaskClaimReminderAbandoned({
  threadId, generationId, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => markPendingClaimReminderAbandoned(state, { generationId, now }),
  });
}

/** 原子记下"待认领话题已提醒过"。 */
export function markTaskClaimReminder({
  threadId, generationId, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => markPendingClaimReminder(state, { generationId, now }),
  });
}

/** 原子记录 Codex task 当前话题代际的一条有效业务消息。 */
export function recordTaskTopicActivity({
  threadId, generationId, eventKey, messageDelta = 1,
  home = bridgeHome(), now = Date.now(), retryMs,
} = {}) {
  return mutateTaskTopicState({
    threadId, home, now,
    mutate: (state) => recordTopicGenerationActivity(state, {
      generationId, eventKey, messageDelta, now, retryMs,
    }),
  });
}

function mutateTaskInteractionPolicy({
  threadId,
  home = bridgeHome(),
  now = Date.now(),
  lockRetries = 0,
  mutate,
} = {}) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  const lockDir = path.join(home, "registry.lock");
  let lock;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt <= lockRetries; attempt += 1) {
    lock = acquirePublishLock(lockDir);
    if (lock.ok || lock.reason !== "publisher_busy") break;
    if (attempt < lockRetries) Atomics.wait(wait, 0, 0, 25);
  }
  if (!lock.ok) return lockFailure(lock);
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((candidate) => candidate.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    const loaded = interactionPolicyForTask(task, { now });
    if (!loaded.ok) return loaded;
    const changed = mutate(loaded.state, task);
    if (!changed?.ok) return changed;
    if (changed.changed !== false) {
      const materialized = materializeInteractionPolicy(task, changed.state);
      if (!materialized.ok) return materialized;
      Object.assign(task, materialized.record);
      // **不许拿视图重建整表。**视图里的 task 是副本，且停用条目/顶层未知字段
    // 都不在视图里 —— 重建一次就把它们静默删了。就地改原文档里的那一条。
    const wrote = mutateRegistryDocument(file, (rawTasks) => {
      const done = replaceRawTask(rawTasks, task);
      if (!done.ok) return done;            // 找不到 / 有歧义 → 错误，不是"没改动"
      return true;
    });
    if (!wrote.ok) return wrote;
    }
    return { ...changed, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

export function setTaskInteractionMode({
  threadId, mode, budget, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskInteractionPolicy({
    threadId, home, now,
    mutate: (state) => setInteractionPolicyMode(state, { mode, budget, now }),
  });
}

export function reserveTaskDialogueTurn({
  threadId, eventId, runId, localTargetId, originChannelGenerationId,
  runtimeTargetId, resourceUnits = 1, home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskInteractionPolicy({
    threadId, home, now,
    mutate: (state) => reserveDialogueTurn(state, {
      eventId, runId, localTargetId, originChannelGenerationId,
      runtimeTargetId, resourceUnits, now,
    }),
  });
}

export function finalizeTaskDialogueTurn({
  threadId, runId, runtimeTargetId, status, reason,
  home = bridgeHome(), now = Date.now(),
} = {}) {
  return mutateTaskInteractionPolicy({
    threadId, home, now, lockRetries: 20,
    mutate: (state) => finalizeDialogueTurn(state, {
      runId, runtimeTargetId, status, reason, now,
    }),
  });
}

export function resolveTaskOutboundGeneration(task, generationId, { now = Date.now() } = {}) {
  const loaded = topicStateForTask(task, { now });
  if (!loaded.ok) return loaded;
  const selected = generationId ??
    activeGeneration(loaded.state)?.channel_generation_id ??
    pendingGeneration(loaded.state)?.channel_generation_id;
  const generation = loaded.state.generations.find((item) =>
    item.channel_generation_id === selected);
  const initialPending = generation?.status === "pending" &&
    loaded.state.active_generation_id === null && loaded.state.generations.length === 1;
  if (!generation || (!initialPending && !["active", "read-only"].includes(generation.status))) {
    return { ok: false, reason: "outbound_generation_unavailable" };
  }
  return {
    ok: true,
    channelGenerationId: generation.channel_generation_id,
    rootMessageId: generation.root_message_id,
    status: generation.status,
  };
}

export function logicalTaskKeyFor(root, threadId) {
  return safeKey(path.basename(root) + "-" + threadFileKey(threadId).slice(0, 12));
}

export function makeTaskEntry({
  root, threadId, name, purpose, rootMessageId, token,
  inboundPrefix = DEFAULT_INBOUND_PREFIX, chatId, chatName, now = Date.now(),
}) {
  const logicalTaskKey = logicalTaskKeyFor(root, threadId);
  const base = {
    id: logicalTaskKey,
    runtime: "codex",
    root,
    logical_task_key: logicalTaskKey,
    task_display_name: name,
    purpose: purpose ?? null,
    codex_thread_id: threadId,
    root_message_id: rootMessageId,
    ...(typeof chatId === "string" && chatId ? { chat_id: chatId } : {}),
    ...(typeof chatName === "string" && chatName ? { chat_name: chatName } : {}),
    status: "active",
    inbound_state: "pending",
    pending_token: token,
    inbound_prefix: inboundPrefix,
    auto_publish_on_completion: true,
    bound_at: new Date(now).toISOString(),
    pending_expires_at: null, // 待认领不过期
    expires_at: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const loaded = topicStateForTask(base, { now });
  const materialized = loaded.ok ? materializeLegacyTopicFields(base, loaded.state) : loaded;
  if (!materialized.ok) throw new Error("无法建立 Codex topic generation：" + materialized.reason);
  return materialized.record;
}

const leaseFile = (threadId, home = bridgeHome()) =>
  path.join(home, "threads", threadFileKey(threadId) + ".json");

export function recordThreadActivity({ threadId, turnId, cwd, active, eventName, home = bridgeHome(), now = Date.now() }) {
  if (typeof threadId !== "string" || !threadId) return { ok: false, reason: "no_thread_id" };
  const file = leaseFile(threadId, home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const rec = {
    schema_version: "1.0",
    thread_id: threadId,
    turn_id: typeof turnId === "string" ? turnId : null,
    cwd: typeof cwd === "string" ? cwd : null,
    active: active === true,
    event_name: eventName ?? null,
    updated_at: new Date(now).toISOString(),
  };
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true, file, record: rec };
}

export function readThreadActivity(threadId, { home = bridgeHome() } = {}) {
  try {
    return { ok: true, record: JSON.parse(fs.readFileSync(leaseFile(threadId, home), "utf-8")) };
  } catch {
    return { ok: false, reason: "no_activity" };
  }
}

export function isThreadBusy(threadId, { home = bridgeHome(), now = Date.now(), maxAgeMs = ACTIVE_LEASE_MAX_MS } = {}) {
  const r = readThreadActivity(threadId, { home });
  if (!r.ok || r.record.active !== true) return false;
  const updated = Date.parse(r.record.updated_at ?? "");
  return Number.isFinite(updated) && now - updated <= maxAgeMs;
}

export function findActiveThreadsForRoot(root, { home = bridgeHome(), now = Date.now() } = {}) {
  const dir = path.join(home, "threads");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      const updated = Date.parse(rec.updated_at ?? "");
      if (rec.active === true && Number.isFinite(updated) && now - updated <= ACTIVE_LEASE_MAX_MS &&
          typeof rec.cwd === "string" && isUnder(rec.cwd, root)) out.push(rec);
    } catch { /* 跳过半截状态 */ }
  }
  return out.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}
