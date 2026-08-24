/**
 * 机器级链路模板 —— 新项目接入时身份配置的来源。
 *
 * 为什么要有这个东西：chain-config.json 里绝大多数字段其实是**链路级**的
 * （运输身份、发布身份、lark profile、授权发送者、agent uid、群 id、时效窗口），
 * 每个项目都一模一样。一直做成每项目一份，纯粹因为到今天为止只有一个项目，
 * 复制一份看不出问题。但新项目在接入的那一刻还没有这份文件，却已经需要知道
 * 「用谁的身份、发到哪个群」—— 这些必须来自一个在项目之前就存在的地方。
 *
 * 刻意不改现有读取方：bind-project 把模板和项目级字段**合并成一份完整的**
 * project chain-config 落到项目里。drain-outbox / outbound / inbound 一行都不用动，
 * 已经在跑的那个项目也完全不受影响。把项目那份瘦下去是以后的事，不在这一步做 ——
 * 那会牵动三个读取方，而这一步的目的只是让新项目接得进来。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TEMPLATE = path.join(os.homedir(), ".claude", "feishu-bridge", "chain-config.json");

/**
 * aily 放各 agent 私有 lark-cli 配置的地方。单智能体方案的出站凭据从这里来：
 * 配置目录 = 这个基路径 + agent_uid。
 *
 * 单独做成一个字段而不是写死：这是 aily-cli 的**内部布局**，不是它对外承诺的接口。
 * 哪天它改了，这里改一个配置就行，不用动代码。
 */
export const DEFAULT_CONFIG_BASE = path.join(os.homedir(), ".aily-cli", "lark-cli");

export function templatePath() {
  return process.env.FEISHU_BRIDGE_CHAIN_TEMPLATE || DEFAULT_TEMPLATE;
}

/**
 * 链路级字段：每个项目都相同，由模板提供。
 *
 * 少一个都接不进去，所以这里同时充当校验清单 —— 模板缺字段要在接入之前就报出来，
 * 而不是等到建完话题、写完配置，第一次发布时才失败（那时候群里已经多了一个孤儿话题）。
 */
export const CHAIN_FIELDS = [
  "chain",
  "transport_agent_name", "transport_app_id", "transport_open_id",
  "outbound_agent_name", "outbound_app_id", "outbound_open_id",
  "lark_cli_profile", "lark_cli_bin", "lark_cli_home",
  "frank_sender_id",
  "chat_name", "chat_id",
  "default_freshness_ms",
  "agent_uid",
];

/**
 * 可选的链路级字段：有就带上，没有就用默认，**不作为必填**。
 *
 * 刻意跟必填分开：往 CHAIN_FIELDS 里加一个字段，等于让所有已经生成好的模板
 * 立刻变成「不完整」而全线拒绝 —— 加字段不该是一次静默的破坏性变更。
 */
export const OPTIONAL_CHAIN_FIELDS = ["lark_cli_config_base", "bridge_root", "aily_cli_bin"];

/** 项目级字段：每个项目不同，由 bind-project 现场算出来。 */
export const PROJECT_FIELDS = [
  "project_dir", "logical_task_key", "project_display_name", "task_display_name",
  "auto_publish_on_completion",
];

/**
 * 形状校验。挡的是手抄时最容易犯的那几类错。
 *
 * 每一条都对应一种真实后果：群 id 写错会把根话题建到别的群（撤不干净）；
 * app id 写成别的形式会让「凭据目录属不属于这个 agent」那道交叉校验失去依据；
 * agent_uid 写错会去用**另一个 agent 的凭据**发消息（本机有十几个 agent 目录）。
 *
 * 唯一挡不住的是 frank_sender_id：它只能校验「是不是一串数字」。
 * 抄成飞书的 ou_ 会全拒（fail-closed，你立刻发现）；但抄成**另一个人**的
 * Aily user id，形状完全合法，而后果是把授权给了别人，且完全无声。
 * 这是整条链上唯一一个「错了会静默扩大授权」的字段 —— SETUP 里单独标了出来。
 */
const SHAPE = {
  chat_id: (v) => typeof v === "string" && v.startsWith("oc_"),
  transport_app_id: (v) => typeof v === "string" && v.startsWith("cli_"),
  outbound_app_id: (v) => typeof v === "string" && v.startsWith("cli_"),
  transport_open_id: (v) => typeof v === "string" && v.startsWith("ou_"),
  outbound_open_id: (v) => typeof v === "string" && v.startsWith("ou_"),
  agent_uid: (v) => typeof v === "string" && v.startsWith("agent_"),
  frank_sender_id: (v) => typeof v === "string" && /^\d+$/.test(v),
  lark_cli_bin: (v) => typeof v === "string" && v.startsWith("/"),
  lark_cli_home: (v) => typeof v === "string" && v.startsWith("/"),
  lark_cli_config_base: (v) => typeof v === "string" && v.startsWith("/"),
  default_freshness_ms: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
};

/**
 * 校验模板。返回缺的和形状不对的，不抛 —— 调用方要把两类问题一次全说出来，
 * 而不是让人改一个字段再跑一次、再发现下一个。
 */
export function validateChainTemplate(tpl) {
  const missing = [];
  const malformed = [];
  for (const f of CHAIN_FIELDS) {
    const v = tpl?.[f];
    if (v === undefined || v === null || v === "") { missing.push(f); continue; }
    if (SHAPE[f] && !SHAPE[f](v)) malformed.push(f);
  }
  // 可选字段缺了不算错，但**填了就得填对** —— 一个形状不对的可选字段比没填更危险，
  // 因为它看着像配过了。
  for (const f of OPTIONAL_CHAIN_FIELDS) {
    const v = tpl?.[f];
    if (v === undefined || v === null || v === "") continue;
    if (SHAPE[f] && !SHAPE[f](v)) malformed.push(f);
  }
  // 单智能体：出站就是运输那个 agent 自己。既然是同一个应用，open_id 也必须是同一个 ——
  // 否则 outbound_open_id 就是个填了也没人管的装饰字段，而装饰字段迟早烂成过期的谎话
  // （这个项目今天已经被 inbound_prefix 和 LARKSUITE_CLI_HOME 各咬过一次）。
  const inconsistent = [];
  if (tpl?.outbound_app_id && tpl.outbound_app_id === tpl.transport_app_id &&
      tpl.outbound_open_id !== tpl.transport_open_id) {
    inconsistent.push("outbound_open_id 与 transport_open_id 不一致，但两者是同一个应用");
  }

  return {
    ok: missing.length === 0 && malformed.length === 0 && inconsistent.length === 0,
    missing, malformed, inconsistent,
  };
}

export function loadChainTemplate(file = templatePath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { ok: false, reason: "no_template", file };
  }
  let tpl;
  try {
    tpl = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "bad_json", file, error: err.message };
  }
  const v = validateChainTemplate(tpl);
  if (!v.ok) return { ok: false, reason: "incomplete", file, ...v };
  return { ok: true, file, template: tpl };
}

/**
 * 由「模板 + 项目根」合成一份完整的 project chain-config。
 *
 * 显示名默认取目录名。它会出现在发回飞书的每条消息开头，所以允许覆盖 ——
 * 但不留空：空的显示名会让话题里出现「 已发布 3 条进展」这种没有主语的消息。
 */
export function materializeProjectConfig({ template, projectRoot, displayName }) {
  const base = path.basename(projectRoot);
  const name = (typeof displayName === "string" && displayName.trim()) || base;
  const chain = {};
  for (const f of CHAIN_FIELDS) chain[f] = template[f];
  for (const f of OPTIONAL_CHAIN_FIELDS) if (template[f] !== undefined) chain[f] = template[f];
  return {
    schema_version: "1.0",
    ...chain,
    project_dir: projectRoot,
    // 逻辑键进回执和 claim 的文件名，所以只留文件名安全的字符。
    logical_task_key: base.replace(/[^A-Za-z0-9_-]/g, "_"),
    project_display_name: name,
    task_display_name: name,
    auto_publish_on_completion: true,
    _generated_by: "scripts/bind-project.mjs",
    _generated_at: new Date().toISOString(),
  };
}

/**
 * 出站该用哪份凭据 —— 从配置推，不额外加开关。
 *
 * 判据是「发布身份是不是就是运输身份」：
 *   是（单智能体）→ 凭据在 aily 给那个 agent 的私有目录里，路径 = 基路径 + agent_uid
 *   否（双智能体）→ 凭据在普通的 lark-cli 配置目录里
 *
 * 刻意推导而不是再加一个字段：多一个开关，就多一种「开关说 A、身份字段说 B」的
 * 不一致状态，而那种状态查起来最费劲。推导让两者**构造上**就不可能打架。
 */
export function resolveLarkIdentity(config) {
  const singleAgent =
    typeof config?.outbound_app_id === "string" &&
    config.outbound_app_id === config.transport_app_id;

  const configDir = singleAgent
    ? path.join(config.lark_cli_config_base ?? DEFAULT_CONFIG_BASE, String(config.agent_uid ?? ""))
    : config?.lark_cli_home;

  return {
    singleAgent,
    configDir,
    profile: config?.lark_cli_profile,
    expectedAppId: config?.outbound_app_id,
    bin: config?.lark_cli_bin,
  };
}

/**
 * 发之前先确认「我手上这份凭据确实属于我以为的那个应用」。
 *
 * 为什么值得一次文件读：2026-08-20 发现过一个传了一年的环境变量根本不存在，
 * 而它失败时什么都不说。这道校验的意义就是**让它失败时会喊**。
 *
 * 它验的是内部自洽（目录里的 appId == 配置里的 outbound_app_id），
 * 挡得住「agent_uid 抄错、指到别的 agent 目录」这类错 —— 本机十几个 agent 目录，
 * 抄错一位就命中别人。挡不住的是两个字段被一致地抄错，那种情况由入站兜底：
 * mention 闸对不上，入站当场就是死的，不会静默。
 */
export function assertPublishIdentity({ configDir, profile, expectedAppId }) {
  if (typeof expectedAppId !== "string" || !expectedAppId) {
    return { ok: false, reason: "no_expected_app_id" };
  }
  if (typeof configDir !== "string" || !configDir) {
    return { ok: false, reason: "no_config_dir" };
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
  } catch (err) {
    return { ok: false, reason: "config_dir_unreadable", configDir, error: String(err.message).slice(0, 200) };
  }

  const apps = Array.isArray(cfg.apps) ? cfg.apps : [];
  // 按 profile 名找；只有一个 app 且没起名时就是它（普通 home 里第一个就是这样）。
  const app = apps.find((a) => a?.name === profile) ?? (apps.length === 1 ? apps[0] : undefined);
  if (!app) return { ok: false, reason: "profile_not_found", configDir, profile, have: apps.map((a) => a?.name ?? "(无名)") };

  if (app.appId !== expectedAppId) {
    return { ok: false, reason: "app_id_mismatch", configDir, profile, found: app.appId, expected: expectedAppId };
  }
  return { ok: true, appId: app.appId, profile: app.name ?? profile };
}

/** 校验失败的人话。回执和日志都要能被一年后的人读懂。 */
export function identityErrorText(r) {
  switch (r.reason) {
    case "config_dir_unreadable":
      return "读不到出站凭据目录（" + r.configDir + "）—— aily-cli 可能被卸载或清理过，" +
        "或者 agent_uid 配错了。这不影响入站，所以你可能只会发现「它不说话了」。";
    case "profile_not_found":
      return "凭据目录里没有 profile「" + r.profile + "」（里面有：" + (r.have ?? []).join(", ") + "）。";
    case "app_id_mismatch":
      return "凭据目录属于另一个应用（找到 " + r.found + "，配置说该是 " + r.expected +
        "）—— agent_uid 大概率指错了 agent。**没有发送任何消息。**";
    case "no_expected_app_id":
      return "配置里没有 outbound_app_id，无法确认将要用的是谁的身份。";
    case "no_config_dir":
      return "配置里没有可用的凭据目录。";
    default:
      return "出站身份校验失败：" + r.reason;
  }
}
