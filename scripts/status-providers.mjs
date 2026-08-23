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

import { loadRoutes, routesPath } from "./inbound-routes.mjs";

export const PROVIDER_PROTOCOL = "feishu-bridge-status/v1";

/** 受控枚举。provider 报了别的值就整条拒 —— 自由文本进不来。 */
export const PROVIDER_KINDS = ["transport", "progress"];

/**
 * 一条连接**属于四层里的哪一层**。
 *
 * 上一版只有 kind 和 scope，判不出一条连接是订阅、绑定还是策略，所以全部挂在
 * 「本项目的其他链路（尚未分层）」附录里。硬按 kind=transport 归到第 2 层，
 * 就是替它声明了它没声明的东西。
 *
 * 跟 kind 一样受**两层约束**：登记时由人声明 allowed_relations，provider 给每条
 * 连接标注实际 relation_type，聚合方只接受声明集合内的值。没声明就没有能力 ——
 * 于是老的登记（没有这个字段）行为完全不变，仍然进附录。
 */
export const CONNECTION_RELATIONS = ["subscription", "binding", "policy"];
export const CONNECTION_STATES = ["active", "suspended", "expired", "unknown"];
export const CONNECTION_SCOPES = ["chat", "topic", "project"];

/** 渲染用的字段就这些，都是人读的名字。additionalProperties 一律拒。 */
const CONNECTION_KEYS = new Set([
  "kind", "state", "scope", "group_name", "topic_name", "relation_type",
]);
const REPORT_KEYS = new Set(["schema_version", "provider_id", "connections"]);

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
 * provider id 走严格白名单。
 *
 * 只要求"非空"是不够的：id 会被当成显示名的兜底值，于是它同时是标识符**和**
 * 输出文本。一个叫 "oc_SECRET123456\n  伪装  正常" 的 id 既能带 locator 出来，
 * 又能靠换行伪造出一整行状态。标识符和展示文本混用就会这样，所以两边都收紧：
 * id 本身受控，显示名也一律过 cleanName。
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

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
    if (typeof p.id !== "string" || !PROVIDER_ID.test(p.id)) return bad("provider_id_invalid");
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
    // 没声明就是没有能力：老登记不带这个字段，行为完全不变（连接仍进附录）。
    if (p.allowed_relations !== undefined &&
        (!Array.isArray(p.allowed_relations) || p.allowed_relations.length === 0 ||
         p.allowed_relations.some((r) => !CONNECTION_RELATIONS.includes(r)))) {
      return bad("allowed_relations_invalid");
    }
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") return bad("enabled_not_boolean");
    // 哪个项目的链路。status 只看当前项目 —— 没有它就归不了属，
    // 归不了属的 provider 不进项目视图（那是 doctor 该管的机器级问题）。
    if (p.project_root !== undefined &&
        (typeof p.project_root !== "string" || !path.isAbsolute(p.project_root))) {
      return bad("project_root_not_absolute");
    }
    if (p.display_name !== undefined && cleanName(p.display_name) === null) {
      return bad("display_name_invalid");
    }
    providers.push({
      id: p.id,
      // id 已经受控，这里再过一道：显示文本只有一个来源，不留第二条路。
      displayName: cleanName(p.display_name) ?? cleanName(p.id) ?? "(未命名)",
      executable: p.executable,
      script: p.script,
      args: p.args ?? [],
      allowedKinds: [...p.allowed_kinds],
      allowedRelations: Array.isArray(p.allowed_relations) ? [...p.allowed_relations] : [],
      enabled: p.enabled !== false,
      projectRoot: p.project_root ?? null,
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
export function validateProviderReport(text, { providerId, allowedKinds, allowedRelations = [] }) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "report_not_json" }; }
  if (!isPlainObject(doc)) return { ok: false, reason: "report_not_object" };
  for (const key of Object.keys(doc)) {
    // 连接项是封闭结构，报告顶层也得是 —— 否则"多带一个字段"只是换个地方放。
    if (!REPORT_KEYS.has(key)) return { ok: false, reason: "report_unknown_field", field: key };
  }
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
    if (c.relation_type !== undefined) {
      if (!CONNECTION_RELATIONS.includes(c.relation_type)) {
        return { ok: false, reason: "connection_relation_invalid" };
      }
      // provider 不能自己给自己发许可 —— 跟 kind 那条同理。
      if (!allowedRelations.includes(c.relation_type)) {
        return { ok: false, reason: "connection_relation_not_allowed" };
      }
    }
    const group = cleanName(c.group_name);
    if (group === null) return { ok: false, reason: "connection_group_name_invalid" };
    const topic = c.topic_name === undefined ? null : cleanName(c.topic_name);
    if (c.topic_name !== undefined && topic === null) {
      return { ok: false, reason: "connection_topic_name_invalid" };
    }
    connections.push({
      kind: c.kind, state: c.state, scope: c.scope, groupName: group, topicName: topic,
      relation: c.relation_type ?? null,
    });
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
    allowedRelations: provider.allowedRelations ?? [],
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

  return { ok: true, sections: runProviders(loaded.providers, run) };
}

/**
 * 只看当前项目的链路。**这是 status 用的那个。**
 *
 * 上一版把整台机器的消费者都列出来，那是我把范围做大了 —— Frank 最初的要求是
 * "把**这个项目**有关的都列出来"。cc2cd 对 feishu-bridge-cc 来说是别人，
 * 它出现在这里只会让每天要看的那屏变吵。
 *
 * "有 route 却没人报状态"那类跨项目的说不通，归后续的 doctor 命令管 ——
 * status 是每天看的，doctor 是出问题才跑的，两者该查的东西本来就不一样。
 */
export function collectProjectConnectivity({
  root, providersFile = statusProvidersPath(), run = runStatusProvider,
} = {}) {
  const loaded = loadStatusProviders(providersFile);
  if (!loaded.ok) {
    return { sections: [], providersProblem: loaded.problem ?? loaded.reason, routesProblem: null };
  }
  // **先过滤再执行。**上一版跑完全部 provider 再按归属过滤显示 —— 界面上看着
  // 只有当前项目，实际已经把别的项目的脚本在 Frank 的交互会话里跑了一遍。
  // 项目范围要是只管显示不管执行，那它就不是范围。
  const want = typeof root === "string" ? path.resolve(root) : null;
  const mine = loaded.providers.filter((p) =>
    want !== null && typeof p.projectRoot === "string" && path.resolve(p.projectRoot) === want);
  return { sections: runProviders(mine, run), providersProblem: null, routesProblem: null };
}

/**
 * 把两份目录合成一张连通性视图。**机器全景，给后续的 doctor 用。**
 *
 * 路由表和 provider 表回答的是不同问题：**路由表知道有哪些入站消费者**，
 * provider 表知道**谁能报自己的状态**。只看后者，"有 route、没登记状态入口"
 * 的消费者就完全不可见 —— 而那正是最需要被看见的一类：它在收消息，
 * 却没人知道它连到了哪儿。
 *
 * 两份表**各自独立降级**：provider 表坏了不影响列出路由，路由表坏了不影响
 * 已经取到的 provider 状态。观测能力不该是全有全无。
 */
export function collectConnectivity({
  routesFile = routesPath(), providersFile = statusProvidersPath(), run = runStatusProvider,
} = {}) {
  const fromProviders = collectStatusProviders({ file: providersFile, run });
  const table = loadRoutes(routesFile);

  const sections = fromProviders.ok ? [...fromProviders.sections] : [];

  // **只有获准报告 transport 的 provider 才算覆盖了一条 route。**
  // 按 id 一刀切会掩盖缺口：给一条 route 配一个只授权 progress 的同 id provider，
  // 结果只显示"进度汇报正常"，那条 route 的运输状态凭空消失、也不提示未登记。
  const coversTransport = new Set(
    (fromProviders.ok ? fromProviders.sections : [])
      .filter((x) => x.allowedKinds?.includes("transport"))
      .map((x) => x.id));

  if (table.ok) {
    for (const route of table.routes) {
      if (coversTransport.has(route.id)) continue;
      sections.push({
        id: route.id,
        // 路由 id 也会变成显示文本，跟 provider id 是同一个注入面。
        displayName: cleanName(route.id) ?? "(未命名)",
        state: "unregistered",
        isDefault: route.isDefault,
      });
    }
  }
  return {
    sections,
    providersProblem: fromProviders.ok ? null : (fromProviders.problem ?? fromProviders.reason),
    routesProblem: table.ok ? null : table.reason,
  };
}

/** 跑一批 provider。停用的不跑 —— 停用就该是"连执行都不发生"。 */
function runProviders(providers, run) {
  const sections = [];
  for (const provider of providers) {
    const base = { id: provider.id, displayName: provider.displayName,
      allowedKinds: provider.allowedKinds, projectRoot: provider.projectRoot };
    if (!provider.enabled) { sections.push({ ...base, state: "disabled" }); continue; }
    const got = run(provider);
    sections.push(got.ok
      ? { ...base, state: "ok", connections: got.connections }
      : { ...base, state: "unavailable", reason: got.reason });
  }
  return sections;
}

const KIND_TEXT = { transport: "消息运输", progress: "进度汇报" };
const STATE_TEXT = { active: "正常", suspended: "已暂停", expired: "已过期", unknown: "状态未知" };
const SCOPE_TEXT = { chat: "整个群", topic: "单个话题", project: "整个项目" };

/**
 * 渲染。**只渲染校验过的字段，绝不回显 provider 的原始输出。**
 * 不打印话题 id、会话 locator、凭据 —— 这条承诺由聚合方兑现，不外包给接入方。
 */
export function renderConnectivity(view, { heading = "其他链路" } = {}) {
  const lines = [];
  for (const s of view.sections) {
    const name = s.displayName;
    if (s.state === "unregistered") {
      // 老实的空白好过看不见：说清是"看不到"，不是"没有"。
      lines.push("  " + name + "  链路存在，状态入口未登记" + (s.isDefault ? "（默认路由）" : ""));
    } else if (s.state === "disabled") {
      // 停的是**状态入口**，不是链路。说成"已停用"会被读成链路停了，
      // 而那条 route 可能还在正常收消息。
      lines.push("  " + name + "  状态入口已停用（链路本身不受影响）");
    } else if (s.state !== "ok") {
      lines.push("  " + name + "  状态取不到（" + s.reason + "）");
    } else if (s.connections.length === 0) {
      lines.push("  " + name + "  没有已连接的群或话题");
    } else {
      for (const c of s.connections) {
        lines.push("  " + name + "  " + (KIND_TEXT[c.kind] ?? c.kind) + " · " +
          c.groupName + (c.topicName ? " / " + c.topicName : "") +
          " · " + (SCOPE_TEXT[c.scope] ?? c.scope) + " · " + (STATE_TEXT[c.state] ?? c.state));
      }
    }
  }
  if (view.providersProblem) {
    // 观测坏了会被当成故障，所以"不影响入站"这句必须说出来。
    lines.push("  状态入口登记不可用（" + view.providersProblem + "）；" +
      "这只影响本命令的显示，不影响飞书入站");
  }
  if (view.routesProblem) {
    // 路由表读不出来则相反：入站**确实**会停，不能说成只是显示问题。
    lines.push("  路由表不可用（" + view.routesProblem + "）；" +
      "入站已停止投递，这是需要处理的故障");
  }
  if (lines.length === 0) return null;
  // 分层视图自己会给这一节起标题，不能再叠一个。
  return (heading ? heading + "\n" : "") + lines.join("\n");
}
