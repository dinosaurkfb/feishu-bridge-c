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

export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
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
    publishLock: path.join(root, "outbound", "publish.lock"),
    consumed: path.join(root, "inbound", "consumed.json"),
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

export function loadRegistry(file = registryFile()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, file, tasks: [], reason: "no_registry" };
    return { ok: false, file, tasks: [], reason: "registry_unreadable", error: err.message };
  }
  const tasks = [];
  for (const task of parsed.tasks ?? []) {
    if (!task || task.enabled === false) continue;
    if (typeof task.root !== "string" || !path.isAbsolute(task.root)) continue;
    if (typeof task.logical_task_key !== "string" || !task.logical_task_key) continue;
    tasks.push({ ...task, id: task.id ?? task.logical_task_key });
  }
  const valid = validateRegistryTasks(tasks);
  if (!valid.ok) return { ok: false, file, tasks: [], ...valid };
  return { ok: true, file, tasks, schemaVersion: parsed.schema_version ?? "1.0" };
}

export function writeRegistry(tasks, file = registryFile()) {
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
  if (!lock.ok) return { ok: false, reason: "registry_busy" };
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    if (reg.tasks.some((t) => t.codex_thread_id === task.codex_thread_id)) {
      return { ok: false, reason: "thread_already_bound" };
    }
    writeRegistry([...reg.tasks, task], file);
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
  return {
    schema_version: "1.0",
    binding_id: task.id + "@codex-registry",
    binding_mode: "codex_thread_binding",
    status: task.status ?? "active",
    session_id: task.session_id ?? null,
    inbound_state: task.inbound_state ?? "pending",
    pending_token: task.pending_token ?? null,
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
  const task = reg.tasks.find((t) => (t.status ?? "active") === "active" && t.session_id === sessionId);
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
  if (!lock.ok) return { ok: false, reason: "registry_busy" };
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    const current = task.status ?? "active";
    if (current === status) return { ok: true, changed: false, task };

    task.status = status;
    if (status === "paused") {
      task.paused_at = new Date(now).toISOString();
    } else {
      task.resumed_at = new Date(now).toISOString();
      delete task.paused_at;
      // 尚未完成首次 mention 的绑定在恢复时重新获得完整握手窗口。
      if (task.inbound_state === "pending" && !task.session_id) {
        task.pending_expires_at = new Date(now + PENDING_WINDOW_MS).toISOString();
      }
    }
    writeRegistry(reg.tasks, file);
    return { ok: true, changed: true, task };
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
  if (!lock.ok) return { ok: false, reason: "registry_busy" };
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.codex_thread_id === threadId);
    if (!task) return { ok: false, reason: "thread_not_registered" };
    task.task_display_name = name.trim();
    writeRegistry(reg.tasks, file);
    return { ok: true, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

/** 安装新发布合同时一次性迁移所有既有 task；暂停项恢复后也应沿用同一合同。 */
export function enableAutoPublishForAllTasks({ home = bridgeHome() } = {}) {
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "registry_busy" };
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const changed = reg.tasks.filter((task) => task.auto_publish_on_completion !== true).length;
    if (changed === 0) return { ok: true, changed: 0, tasks: reg.tasks.length };
    writeRegistry(reg.tasks.map((task) => ({ ...task, auto_publish_on_completion: true })), file);
    return { ok: true, changed, tasks: reg.tasks.length };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

const pendingDeadline = (task) => {
  const explicit = Date.parse(task?.pending_expires_at ?? "");
  if (Number.isFinite(explicit)) return explicit;
  const bound = Date.parse(task?.bound_at ?? "");
  return Number.isFinite(bound) ? bound + PENDING_WINDOW_MS : 0;
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
  const pending = reg.tasks.filter((t) =>
    (t.status ?? "active") === "active" && t.inbound_state === "pending" && !t.session_id);
  if (pending.length === 0) return { ok: false, reason: "no_pending_binding" };

  const tokens = extractQuotedBindingTokens(content);
  if (tokens.length > 1) return { ok: false, reason: "multiple_binding_tokens" };

  let selected;
  if (tokens.length === 1) {
    const matches = pending.filter((task) =>
      typeof task.pending_token === "string" && task.pending_token.toLowerCase() === tokens[0]);
    if (matches.length === 0) return { ok: false, reason: "pending_binding_token_unknown" };
    if (matches.length > 1) return { ok: false, reason: "duplicate_pending_binding_token" };
    selected = matches[0];
  } else {
    // 兼容旧根消息或非话题表面：没有引用码时仍只允许全机唯一 pending，绝不按目录或标题猜。
    if (pending.length > 1) {
      return { ok: false, reason: "multiple_pending_bindings", ids: pending.map((t) => t.id) };
    }
    selected = pending[0];
  }

  if (now >= pendingDeadline(selected)) return { ok: false, reason: "pending_binding_expired" };
  return { ok: true, task: selected, source: tokens.length === 1 ? "quoted_binding_token" : "sole_pending" };
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

export function promoteTask({ logicalTaskKey, sessionId, home = bridgeHome(), now = Date.now() }) {
  const lockDir = path.join(home, "registry.lock");
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: "registry_busy" };
  try {
    const file = registryFile(home);
    const reg = loadRegistry(file);
    if (!reg.ok) return reg;
    const task = reg.tasks.find((t) => t.logical_task_key === logicalTaskKey);
    if (!task) return { ok: false, reason: "entry_gone" };
    if ((task.status ?? "active") !== "active" || task.inbound_state !== "pending") {
      return { ok: false, reason: "entry_not_pending" };
    }
    if (task.session_id && task.session_id !== sessionId) return { ok: false, reason: "already_bound_elsewhere" };
    if (reg.tasks.some((t) => t.logical_task_key !== logicalTaskKey && t.session_id === sessionId)) {
      return { ok: false, reason: "session_already_bound" };
    }
    task.session_id = sessionId;
    task.inbound_state = "bound";
    task.inbound_bound_at = new Date(now).toISOString();
    writeRegistry(reg.tasks, file);
    return { ok: true, task };
  } catch (err) {
    return { ok: false, reason: "registry_unwritable", error: err.message };
  } finally {
    releasePublishLock(lockDir);
  }
}

export function logicalTaskKeyFor(root, threadId) {
  return safeKey(path.basename(root) + "-" + threadFileKey(threadId).slice(0, 12));
}

export function makeTaskEntry({
  root, threadId, name, purpose, rootMessageId, token,
  inboundPrefix = DEFAULT_INBOUND_PREFIX, chatId, chatName, now = Date.now(),
}) {
  const logicalTaskKey = logicalTaskKeyFor(root, threadId);
  return {
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
    expires_at: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };
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
