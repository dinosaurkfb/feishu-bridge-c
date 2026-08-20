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

/** 项目级字段：每个项目不同，由 bind-project 现场算出来。 */
export const PROJECT_FIELDS = [
  "project_dir", "logical_task_key", "project_display_name", "task_display_name",
  "auto_publish_on_completion",
];

/** 群 id 必须是 oc_ 开头。写错了会把根话题建到别的群里，而那是撤不干净的。 */
const SHAPE = {
  chat_id: (v) => typeof v === "string" && v.startsWith("oc_"),
  transport_open_id: (v) => typeof v === "string" && v.startsWith("ou_"),
  outbound_open_id: (v) => typeof v === "string" && v.startsWith("ou_"),
  lark_cli_bin: (v) => typeof v === "string" && v.startsWith("/"),
  lark_cli_home: (v) => typeof v === "string" && v.startsWith("/"),
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
  return { ok: missing.length === 0 && malformed.length === 0, missing, malformed };
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
