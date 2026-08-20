/**
 * 一个项目的配置和绑定从哪来 —— 出站所有读取方共用的这一个入口。
 *
 * 为什么要它：接一个新项目本该只产生**一条**新事实 ——「这个项目的话题是哪条根消息」。
 * 但 drain-outbox / binding / binding-health 都是去**项目目录**读配置的，于是接入不得不
 * 在每个新项目里造出两个文件、38 个字段，其中 33 个是机器级事实的复制品
 * （运输身份、发布身份、profile、群 id、授权发送者……每个项目一模一样）。
 * 复制品越多，改一次配置要同步的地方就越多，而它们不同步时没有任何东西会报错。
 *
 * 这个模块把「从哪读」收敛成一处，于是新项目只需要在登记表里多一行：
 *
 *   { id, root, name, root_message_id, expires_at }
 *
 * 项目目录里一个文件都不写。
 *
 * **项目文件优先。**已经接好的项目（本仓库自己）文件还在，走原来那条路，
 * 字段、行为、失败方式全都不变 —— 这次简化对它应当是完全不可见的。
 */

import fs from "node:fs";
import path from "node:path";

import { loadChainTemplate } from "./chain-template.mjs";
import { loadRegistry } from "./registry.mjs";
import { materializeProjectConfig } from "./chain-template.mjs";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));

export const projectConfigPath = (root) => path.join(root, ".runtime-data", "inbound", "chain-config.json");
export const projectMappingPath = (root) => path.join(root, ".runtime-data", "inbound", "active-mapping.json");

/**
 * 由登记表那一行合成一份 mapping。
 *
 * 字段名和形状跟磁盘上那份**完全一致** —— 读取方拿到哪一种都不用分辨。
 * session_id 恒为 null：入站的多绑定路由还没做，而 evaluateInbound 比的就是这个字段，
 * null 跟任何真实 session 都不相等，所以登记表接进来的项目在入站侧天然是关着的。
 * 这不是遗漏，是这一步刻意只做出站。
 */
export function mappingFromRegistryEntry(entry) {
  return {
    schema_version: "1.0",
    binding_id: entry.id + "@registry",
    status: entry.status ?? "active",
    binding_mode: "aily_session_binding",

    session_id: null,
    inbound_state: entry.inbound_state ?? "pending",
    pending_token: entry.pending_token ?? null,

    inbound_prefix: null,
    logical_task_key: entry.id,
    feishu_root_message_id_reference: entry.root_message_id,

    expires_at: entry.expires_at,
    max_inbound_messages: "unlimited",
    consumed_message_ids: [],

    created_at: entry.bound_at ?? null,
    _source: "registry",
  };
}

/**
 * 解析一个项目：先看项目目录，没有就回落到「机器模板 + 登记表那一行」。
 *
 * 三种结局都要能被调用方区分开：
 *   ok + source           —— 能发
 *   not_bound             —— 这个项目根本没接桥（最常见，必须便宜且安静）
 *   config_unreadable / template_unusable —— 接了但配错了，要说出来
 */
export function resolveProject({ root, registryFile, templateFile } = {}) {
  // mapping 和 config 各自独立解析，不要求成对出现。
  // 上一版要求两个文件都在才走项目路径，结果是「有 mapping、没 chain-config」的项目
  // 会被判成完全没接桥 —— 到期预警从此静默消失。到期预警根本不读 config，
  // 让它去依赖一个自己用不到的文件，是把两件无关的事绑死了。
  const cfgPath = projectConfigPath(root);
  const mapPath = projectMappingPath(root);

  let mapping = null;
  let source = null;
  let registryEntry = null;
  if (fs.existsSync(mapPath)) {
    try {
      mapping = readJson(mapPath);
      source = "project-files";
    } catch (err) {
      // 文件在但读不出来是配错，不是没接 —— 必须说出来，静默会让进展无限期堆在本地。
      return { ok: false, reason: "config_unreadable", root, error: String(err.message).slice(0, 200) };
    }
  } else {
    const reg = loadRegistry(registryFile);
    if (!reg.ok) return { ok: false, reason: "registry_unreadable", root, error: reg.error ?? reg.reason };
    const entry = reg.projects.find((p) => p.root === root);
    // 没有 root_message_id 就等于没接：出站没有话题可回。这是最常见的分支，必须便宜且安静。
    if (!entry || !entry.root_message_id) return { ok: false, reason: "not_bound", root };
    mapping = mappingFromRegistryEntry(entry);
    source = "registry";
    registryEntry = entry; // 显示名留给下面合成 config 用
  }

  // config 只有真要发布时才用得上，所以模板不可用**不影响**已经能从项目文件读到 mapping 的情况
  // —— 到期预警照常工作。这里把 config 做成惰性的：拿不到就留 null，由调用方决定算不算错。
  let config = null;
  let configError = null;
  if (fs.existsSync(cfgPath)) {
    try {
      config = readJson(cfgPath);
    } catch (err) {
      configError = { reason: "config_unreadable", error: String(err.message).slice(0, 200) };
    }
  } else {
    const tpl = loadChainTemplate(templateFile);
    if (tpl.ok) {
      config = materializeProjectConfig({
        template: tpl.template, projectRoot: root, displayName: registryEntry?.name,
      });
    } else {
      configError = {
        reason: "template_unusable", templateReason: tpl.reason,
        missing: tpl.missing, malformed: tpl.malformed, error: tpl.error,
      };
    }
  }

  return { ok: true, source, root, mapping, config, configError };
}
