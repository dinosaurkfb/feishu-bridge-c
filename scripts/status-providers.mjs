/**
 * 状态提供者 —— 让 /feishu-status 回答「我有哪些东西连到了哪些飞书群和话题」。
 *
 * 为什么单独一层：本机不止一个消费者，各自管着自己的绑定。以前要回答这个问题，
 * Frank 得先知道每条绑定归哪个实现管 —— 那正是状态命令该替他隐藏的内部细节。
 *
 * 为什么**不挂在路由表上**（评审推翻了最初的方案，两条理由都成立）：
 *
 *   1. 路由表只知道**入站运输**消费者。纯进度发布的链路根本没有 route，
 *      挂上去它就永远不可见；而为了被发现去造一条假 route，等于往权威路由里
 *      掺不参与路由的东西。
 *   2. 更要紧：路由表是 fail-closed 的 —— 解释不了就停止投递。状态元数据要是
 *      住在同一份文件里，一条坏的 provider 记录会把**整个飞书入站**停掉。
 *      观测能力坏了只该显示「状态不可用」，不该让消息停摆。
 *
 * 所以这是独立文件、独立校验域。这里出任何问题都不影响入站。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDER_PROTOCOL = "feishu-bridge-status/v1";

/** 受控枚举。provider 报了别的值就整条拒 —— 自由文本进不来。 */
export const PROVIDER_KINDS = ["transport", "progress"];
export const CONNECTION_STATES = ["active", "suspended", "expired", "unknown"];
export const CONNECTION_SCOPES = ["chat", "topic", "project"];

/** 渲染用的字段就这些，都是人读的名字。additionalProperties 一律拒。 */
const CONNECTION_KEYS = new Set(["kind", "state", "scope", "group_name", "topic_name"]);

const NAME_MAX = 60;
export const PROVIDER_TIMEOUT_MS = 5000;
export const PROVIDER_OUTPUT_MAX = 64 * 1024;

export function statusProvidersPath() {
  return process.env.FEISHU_BRIDGE_STATUS_PROVIDERS ||
    path.join(os.homedir(), ".claude", "feishu-bridge", "status-providers.json");
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isName = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * 名字里不许出现 locator。结构化协议挡得住「多带一个 chat_id 字段」，
 * 挡不住「把 locator 塞进 group_name」。这里做一道廉价的形状检查 ——
 * 拦得住手滑，拦不住有意为之，后者只能靠登记时的信任审查。
 */
const LOCATOR_SHAPED = /(?:oc_|om_|ou_|on_|session_|thread_|cli_)[A-Za-z0-9]{6,}/u;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/gu;

function cleanName(value) {
  if (!isName(value)) return null;
  // 控制字符会把终端输出搞乱，也能用来伪装内容。
  const flat = value.replace(CONTROL_CHARS, " ").trim();
  if (flat.length === 0 || flat.length > NAME_MAX) return null;
  if (LOCATOR_SHAPED.test(flat)) return null;
  return flat;
}

/**
 * 校验 provider 登记表。**登记是一次独立授权**，不由「存在一条 route」推导出来 ——
 * route 的 handler 跑在受控的入站事件之后，status 跑在 Frank 的交互会话里，
 * 继承的环境和上下文都更多，两者不等价。
 */
export function validateProviderRegistry(doc) {
  const bad = (problem) => ({ ok: false, reason: "status_providers_shape_unexpected", problem });
  if (!isPlainObject(doc)) return bad("registry_not_object");
  const list = doc.providers ?? [];
  if (!Array.isArray(list)) return bad("providers_not_array");

  const seen = new Set();
  const providers = [];
  for (const p of list) {
    if (!isPlainObject(p)) return bad("provider_not_object");
    if (!isName(p.id)) return bad("provider_id_invalid");
    if (seen.has(p.id)) return bad("provider_id_duplicated");
    seen.add(p.id);
    if (p.protocol !== PROVIDER_PROTOCOL) return bad("provider_protocol_unsupported");
    // 同 route.handler 那条：相对路径按 cwd 解析，同一份登记在不同目录下跑不同脚本。
    for (const key of ["executable", "script"]) {
      if (!isName(p[key]) || !path.isAbsolute(p[key])) return bad(key + "_not_absolute");
    }
    if (p.args !== undefined &&
        (!Array.isArray(p.args) || p.args.some((a) => typeof a !== "string"))) {
      return bad("args_not_string_array");
    }
    if (!Array.isArray(p.allowed_kinds) || p.allowed_kinds.length === 0 ||
        p.allowed_kinds.some((k) => !PROVIDER_KINDS.includes(k))) {
      return bad("allowed_kinds_invalid");
    }
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") return bad("enabled_not_boolean");
    if (p.display_name !== undefined && cleanName(p.display_name) === null) {
      return bad("display_name_invalid");
    }
    providers.push({
      id: p.id,
      displayName: cleanName(p.display_name) ?? p.id,
      executable: p.executable,
      script: p.script,
      args: p.args ?? [],
      allowedKinds: [...p.allowed_kinds],
      enabled: p.enabled !== false,
    });
  }
  return { ok: true, providers };
}

/** 读登记表。**读不到不是错误** —— 大多数机器一个 provider 都没有。 */
export function loadStatusProviders(file = statusProvidersPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, providers: [], reason: "no_providers" };
    return { ok: false, reason: "status_providers_unreadable", error: err.message };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    return { ok: false, reason: "status_providers_unreadable", error: err.message };
  }
  return validateProviderRegistry(parsed);
}

/**
 * 校验 provider 报上来的东西。**绝不回显它的原始 stdout。**
 *
 * 自由文本一旦直接展示，本命令「不打印 locator」那条承诺就没法兑现 ——
 * 那是我这边的承诺，不能指望每个接入方替我守。
 */
export function validateProviderReport(text, { providerId, allowedKinds }) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "report_not_json" }; }
  if (!isPlainObject(doc)) return { ok: false, reason: "report_not_object" };
  if (doc.schema_version !== PROVIDER_PROTOCOL) {
    return { ok: false, reason: "report_protocol_unsupported" };
  }
  if (doc.provider_id !== providerId) return { ok: false, reason: "report_provider_id_mismatch" };
  if (!Array.isArray(doc.connections)) return { ok: false, reason: "report_connections_not_array" };

  const connections = [];
  for (const c of doc.connections) {
    if (!isPlainObject(c)) return { ok: false, reason: "connection_not_object" };
    for (const key of Object.keys(c)) {
      // additionalProperties: false。多带一个 chat_id 进来就整条拒。
      if (!CONNECTION_KEYS.has(key)) {
        return { ok: false, reason: "connection_unknown_field", field: key };
      }
    }
    if (!PROVIDER_KINDS.includes(c.kind)) return { ok: false, reason: "connection_kind_invalid" };
    // provider 不能自己扩大能力范围：登记时人给了什么，它只能报什么。
    if (!allowedKinds.includes(c.kind)) return { ok: false, reason: "connection_kind_not_allowed" };
    if (!CONNECTION_STATES.includes(c.state)) return { ok: false, reason: "connection_state_invalid" };
    if (!CONNECTION_SCOPES.includes(c.scope)) return { ok: false, reason: "connection_scope_invalid" };
    const group = cleanName(c.group_name);
    if (group === null) return { ok: false, reason: "connection_group_name_invalid" };
    const topic = c.topic_name === undefined ? null : cleanName(c.topic_name);
    if (c.topic_name !== undefined && topic === null) {
      return { ok: false, reason: "connection_topic_name_invalid" };
    }
    connections.push({ kind: c.kind, state: c.state, scope: c.scope, groupName: group, topicName: topic });
  }
  return { ok: true, connections };
}

/**
 * 跑一个 provider 拿它的状态。
 *
 * 这些约束不是"顺手加的"，每条都对应一个具体的失手方式：
 *
 *   · execFile 而非 shell —— 参数里出现引号、分号、空格都不会变成命令
 *   · 环境白名单 —— 状态查询跑在 Frank 的交互会话里，那里有 AILY_CLI_* 和凭据；
 *     provider 没有理由拿到它们，也没有理由知道我在跟谁说话
 *   · 固定 cwd 到脚本所在目录 —— 不让"从哪儿调用"影响结果
 *   · 关 stdin —— provider 不该有机会等输入把状态命令挂住
 *   · 超时与输出上限 —— 一个消费者卡住不该让整条 status 卡住
 */
export function runStatusProvider(provider, { exec = execFileSync } = {}) {
  for (const file of [provider.executable, provider.script]) {
    let stat;
    try { stat = fs.statSync(file); } catch { return { ok: false, reason: "provider_file_missing" }; }
    if (!stat.isFile()) return { ok: false, reason: "provider_file_not_a_file" };
    try { fs.accessSync(file, fs.constants.R_OK); } catch {
      return { ok: false, reason: "provider_file_not_readable" };
    }
  }
  let stdout;
  try {
    stdout = exec(provider.executable, [provider.script, ...provider.args], {
      cwd: path.dirname(provider.script),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROVIDER_TIMEOUT_MS,
      maxBuffer: PROVIDER_OUTPUT_MAX,
      encoding: "utf-8",
      env: envAllowlist(),
    });
  } catch (err) {
    return { ok: false, reason: err?.code === "ETIMEDOUT" ? "provider_timeout" : "provider_failed" };
  }
  return validateProviderReport(String(stdout), {
    providerId: provider.id, allowedKinds: provider.allowedKinds,
  });
}

/** 白名单本身就是文档：这四个之外的一律不传。 */
function envAllowlist() {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "TZ"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  return env;
}

/**
 * 汇总全部 provider。**一个坏掉只影响它自己那一节。**
 *
 * 观测能力的可用性不该是全有全无 —— 三个消费者里有一个超时，
 * 另外两个的状态照样值得看见。
 */
export function collectStatusProviders({ file = statusProvidersPath(), run = runStatusProvider } = {}) {
  const loaded = loadStatusProviders(file);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, problem: loaded.problem, sections: [] };

  const sections = [];
  for (const provider of loaded.providers) {
    if (!provider.enabled) {
      sections.push({ id: provider.id, displayName: provider.displayName, state: "disabled" });
      continue;
    }
    const got = run(provider);
    sections.push(got.ok
      ? { id: provider.id, displayName: provider.displayName, state: "ok", connections: got.connections }
      : { id: provider.id, displayName: provider.displayName, state: "unavailable", reason: got.reason });
  }
  return { ok: true, sections };
}

const KIND_TEXT = { transport: "消息运输", progress: "进度汇报" };
const STATE_TEXT = { active: "正常", suspended: "已暂停", expired: "已过期", unknown: "状态未知" };
const SCOPE_TEXT = { chat: "整个群", topic: "单个话题", project: "整个项目" };

/**
 * 渲染。**只渲染校验过的字段，绝不回显 provider 的原始输出。**
 * 不打印话题 id、会话 locator、凭据 —— 这条承诺由聚合方兑现，不外包给接入方。
 */
export function renderStatusProviders(result) {
  if (!result.ok) {
    // 观测坏了就说观测坏了。入站不受影响这句得说出来，否则会被当成故障。
    return "其他链路  状态登记不可用（" + (result.problem ?? result.reason) + "）；" +
      "这只影响本命令的显示，不影响飞书入站";
  }
  if (result.sections.length === 0) return null;

  const lines = [];
  for (const s of result.sections) {
    if (s.state === "disabled") {
      lines.push("  " + s.displayName + "  已停用");
      continue;
    }
    if (s.state !== "ok") {
      // 老实的空白好过看不见 —— 但要说清是"看不到"而不是"没有"。
      lines.push("  " + s.displayName + "  状态取不到（" + s.reason + "）");
      continue;
    }
    if (s.connections.length === 0) {
      lines.push("  " + s.displayName + "  没有已连接的群或话题");
      continue;
    }
    for (const c of s.connections) {
      lines.push("  " + s.displayName + "  " + (KIND_TEXT[c.kind] ?? c.kind) + " · " +
        c.groupName + (c.topicName ? " / " + c.topicName : "") +
        " · " + (SCOPE_TEXT[c.scope] ?? c.scope) + " · " + (STATE_TEXT[c.state] ?? c.state));
    }
  }
  return "其他链路\n" + lines.join("\n");
}
