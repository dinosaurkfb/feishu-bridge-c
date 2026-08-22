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

import { CHAIN_FIELDS, OPTIONAL_CHAIN_FIELDS, loadChainTemplate, materializeProjectConfig } from "./chain-template.mjs";
import { loadRegistry } from "./registry.mjs";
import { applyTopicGenerationToMapping } from "./topic-generation.mjs";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));

export const projectConfigPath = (root) => path.join(root, ".runtime-data", "inbound", "chain-config.json");
export const projectMappingPath = (root) => path.join(root, ".runtime-data", "inbound", "active-mapping.json");

/**
 * 已消费的消息 id 存哪。
 *
 * 登记表接入的项目没有 mapping 文件，而幂等（DUPLICATE_MESSAGE 那道闸）需要一份
 * 已处理列表。刻意不放进登记表：登记表在每一次会话结束时都会被读，往里面塞一个
 * 会无限增长的数组，是给一条热路径加负担。
 */
export const consumedPath = (root, claudeSessionId) =>
  path.join(root, ".runtime-data", "inbound",
    claudeSessionId ? "consumed-" + claudeSessionId + ".json" : "consumed.json");

export const CONSUMED_MAX = 500;

export function loadConsumed(root, claudeSessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(consumedPath(root, claudeSessionId), "utf-8"));
    return Array.isArray(parsed?.ids) ? parsed.ids.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** 只留最近 CONSUMED_MAX 条：幂等只需覆盖时效窗口，无限增长的列表迟早自己变成问题。 */
export function appendConsumed(root, messageId, { max = CONSUMED_MAX, claudeSessionId } = {}) {
  const ids = loadConsumed(root, claudeSessionId);
  if (ids.includes(messageId)) return ids;
  const next = [...ids, messageId].slice(-max);
  const file = consumedPath(root, claudeSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ ids: next }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

/**
 * 同一个项目可能有多条绑定：一条项目级的（兜底），外加若干条**会话级**的。
 *
 * 为什么需要会话级：「项目 = 目录」这个假设是从写代码来的。写代码时目录确实等于工作范围，
 * 但做研究、写东西的人可能一个文件夹里同时开五条互不相干的线，目录代表不了「在忙哪件事」。
 * Claude 这边最接近「一条工作线」的东西就是会话。
 *
 * 选择规则刻意做成**严格超集**，只用一个会话的人行为一字不差：
 *
 *   1. 有会话级绑定且 session 对得上 → 用它
 *   2. 否则用项目级那条（没有 claude_session_id 的）
 *   3. 都没有 → 没接桥
 *
 * 项目级必须留作默认和兜底：它天然扛得住终端重启，而这正是当年钉死会话 UUID
 * 那个失败方案缺的东西（见 STATE.md）。会话级是加法，不是替换。
 */
export function selectBindingEntry(entries, claudeSessionId) {
  const list = Array.isArray(entries) ? entries : [];
  if (typeof claudeSessionId === "string" && claudeSessionId) {
    const exact = list.find((e) => e?.claude_session_id === claudeSessionId);
    if (exact) return { entry: exact, level: "session" };
  }
  const project = list.find((e) => !e?.claude_session_id);
  if (project) return { entry: project, level: "project" };
  return { entry: null, level: null };
}

/**
 * 由登记表那一行合成一份 mapping。
 *
 * 字段名和形状跟磁盘上那份**完全一致** —— 读取方拿到哪一种都不用分辨。
 * 这条是这次能少写两个配置文件的全部原因：读取方看不出区别，就不必为两种存放方式各写一遍。
 */
export function mappingFromRegistryEntry(entry, { consumed = [] } = {}) {
  const mapping = {
    schema_version: "1.0",
    binding_id: entry.id + "@registry",
    status: entry.status ?? "active",
    binding_mode: "aily_session_binding",

    // 绑定完成前是 null —— 跟任何真实 session 都不相等，入站天然关着。
    // 第二段绑定（Frank 在新话题里 @ 的那一下）把它写进登记表，见 inbound-route.mjs。
    session_id: entry.session_id ?? null,
    inbound_state: entry.inbound_state ?? "pending",
    pending_token: entry.pending_token ?? null,
    pending_expires_at: entry.pending_expires_at ?? null,
    channel_generation_id: entry.channel_generation_id ?? null,
    topic_generation_state: entry.topic_generation_state ?? null,

    inbound_prefix: null,
    // 会话级绑定把 Claude 会话 id 带进 mapping，入站据此投给指定的那条线。
    claude_session_id: entry.claude_session_id ?? null,
    logical_task_key: entry.id,
    feishu_root_message_id_reference: entry.root_message_id,

    expires_at: entry.expires_at,
    max_inbound_messages: "unlimited",
    freshness_ms: entry.freshness_ms ?? null,
    consumed_message_ids: consumed,

    created_at: entry.bound_at ?? null,
    _source: "registry",
  };
  const evolved = applyTopicGenerationToMapping(mapping, {
    runtime: "claude",
    bindingId: mapping.binding_id,
  });
  return evolved.ok ? evolved.mapping : {
    ...mapping,
    status: "invalid",
    topic_generation_error: evolved.reason,
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
export function resolveProject({ root, claudeSessionId, registryFile, templateFile } = {}) {
  // mapping 和 config 各自独立解析，不要求成对出现。
  // 上一版要求两个文件都在才走项目路径，结果是「有 mapping、没 chain-config」的项目
  // 会被判成完全没接桥 —— 到期预警从此静默消失。到期预警根本不读 config，
  // 让它去依赖一个自己用不到的文件，是把两件无关的事绑死了。
  const cfgPath = projectConfigPath(root);
  const mapPath = projectMappingPath(root);

  let mapping = null;
  let source = null;
  let registryEntry = null;
  let bindingLevel = null;
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
    // 同一个 root 可能有多条：一条项目级 + 若干条会话级。选哪条见 selectBindingEntry。
    const bound = reg.projects.filter((p) => p.root === root && p.root_message_id);
    const picked = selectBindingEntry(bound, claudeSessionId);
    const entry = picked.entry;
    // 没有 root_message_id 就等于没接：出站没有话题可回。这是最常见的分支，必须便宜且安静。
    if (!entry) return { ok: false, reason: "not_bound", root };
    mapping = mappingFromRegistryEntry(entry, { consumed: loadConsumed(root, entry.claude_session_id) });
    source = "registry";
    bindingLevel = picked.level;
    registryEntry = entry; // 显示名留给下面合成 config 用
  }

  // config 只有真要发布时才用得上，所以模板不可用**不影响**已经能从项目文件读到 mapping 的情况
  // —— 到期预警照常工作。这里把 config 做成惰性的：拿不到就留 null，由调用方决定算不算错。
  let config = null;
  let configError = null;
  if (fs.existsSync(cfgPath)) {
    try {
      config = readJson(cfgPath);
      // **链路级字段一律以机器模板为准**，哪怕项目文件里也有一份。
      //
      // 那些字段（运输/发布身份、profile、群 id、授权发送者）本来就是整条链路共用的，
      // 项目文件里的只是历史留下的副本。不让模板压过去，就会出现「新接的项目用新身份、
      // 老项目还用旧身份」这种同机不一致 —— 而且它不会报错，只会让话题里出现两个头像。
      // 没有模板时（老装法）项目文件仍然独自够用。
      const tpl = loadChainTemplate(templateFile);
      if (tpl.ok) {
        for (const f of CHAIN_FIELDS) config[f] = tpl.template[f];
        for (const f of OPTIONAL_CHAIN_FIELDS) {
          if (tpl.template[f] !== undefined) config[f] = tpl.template[f];
        }
      }
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

  // 授权发送者是**链路级**的，登记表那一行里没有它。evaluateInbound 读的是
  // mapping.frank_sender_id —— 不补上，登记表接进来的项目会把每一条消息都判成
  // 「发送者不是授权用户」，而且理由听起来像是真的，最难查的那种。
  if (mapping && mapping.frank_sender_id === undefined && config?.frank_sender_id !== undefined) {
    mapping.frank_sender_id = config.frank_sender_id;
  }

  // 项目文件形式也只做内存投影；真正轮转时 adapter 才在生命周期锁内持久化。
  if (mapping && source === "project-files") {
    const evolved = applyTopicGenerationToMapping(mapping, {
      runtime: "claude",
      bindingId: mapping.binding_id ?? (path.basename(root) + "@project-files"),
    });
    if (evolved.ok) mapping = evolved.mapping;
    else mapping = { ...mapping, status: "invalid", topic_generation_error: evolved.reason };
  }

  return { ok: true, source, root, mapping, config, configError,
    bindingLevel: bindingLevel ?? (source === "project-files" ? "project" : null),
    claudeSessionId: registryEntry?.claude_session_id ?? null };
}
