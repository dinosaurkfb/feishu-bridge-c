/**
 * M1a 只读对账 · legacy 快照适配器（规格 docs/architecture/m1a-reconciliation.md §1）。
 *
 * 对账 legacy 侧**只能**经这两个封闭适配器产生：
 *   · collectClaudeLegacySnapshot({ registryFile, templateFile, now })
 *   · collectCodexLegacySnapshot({ home, now })
 *
 * 铁律（本模块全部导出的共同前提）：
 *   · **严格只读**——不写任何路径；
 *   · **一次受验读绑定**——每个来源文件在整个采集过程中恰好读一次（fetch 缓存），
 *     业务解析、snapshot_identity、digest 都从同一次读入的 buffer 派生；评审 P1-1：
 *     "旧业务投影 + 新身份"的假一致在结构上不可能发生；
 *   · **严格读取**——任一在场文件读不出 / JSON 坏 / 代际状态校验不过 → legacy_unreadable，
 *     绝不把读不出当成"没有"；realpath 说不清也是 unreadable（不折 path.resolve）；
 *   · **严格 target 采集**——binding_target 全字段受验，缺任一只标记 complete:false
 *     （判别层落 target_incomplete 待修），**绝不临时选值或填默认**；
 *   · enabled:false 的项目**仍进快照**（§4 enabled 行）；项目文件（active-mapping.json）
 *     在场即优先，registry 内联字段只在项目文件缺席时生效，registry 不产第二份投影；
 *     项目文件在场时 enabled 按其 binding_id 回指的唯一 registry 条目带入（评审 P1-2）。
 */

import fs from "node:fs";
import path from "node:path";

import { readRegularFile } from "../installed-surface.mjs";
import { sha256, canonKey } from "../topic-agent-ledger.mjs";
import { normalizeRoot } from "../registry.mjs";
import { parseChainTemplateRaw } from "../chain-template.mjs";
import {
  applyTopicGenerationToMapping, effectiveBindingId, validateTopicGenerationState,
} from "../topic-generation.mjs";
import { mappingFromRegistryEntry, projectMappingPath } from "../project-resolve.mjs";
import {
  validateCodexTemplate, validateRegistryDocument, DEFAULT_INBOUND_PREFIX,
  registryFile as codexRegistryFile, templateFile as codexTemplateFile,
} from "../codex/state.mjs";

/* 与账本侧同源的受验形状（topic-agent-ledger.mjs 内部常量，这里按规格 §3 复述——
 * 两侧形状若有漂移，双射会以 mismatch 的形式暴露，不会静默放过）。 */
const OM_SHAPE = /^om_[A-Za-z0-9]{1,120}$/u;
const CHAT_SHAPE = /^oc_[A-Za-z0-9]{1,120}$/u;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LINEAGE_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;
const CODEX_ID_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const unreadable = (source, why) => ({ ok: false, reason: "legacy_unreadable", source, why });
const conflict = (why) => ({ ok: false, reason: "legacy_conflict", why });

/**
 * 一次受验读绑定（评审 P1-1）：同一路径在整个采集过程只真正读一次盘，
 * 之后解析 / 身份 / digest 全部消费缓存。read 状态缓存 {real, sha256, buf}；
 * absent 缓存受验父目录 realpath + basename；realpath 说不清 → error（fail-closed）。
 */
const makeFetcher = () => {
  const cache = new Map();
  const fetch = (file) => {
    let e = cache.get(file);
    if (e !== undefined) return e;
    // 读前身份基准（复评 P1-1）：与读后 realpath 对比，路径中途被换向能当场报错。
    // ENOENT 不预折——文件缺席是合法分支，交给读后的 absent 判定。
    let preReal = null;
    try { preReal = fs.realpathSync(file); } catch (err) {
      if (err?.code !== "ENOENT") {
        e = { status: "error", why: "读前路径身份说不清（realpath 失败：" + String(err?.message ?? err).slice(0, 60) + "）" };
        cache.set(file, e); return e;
      }
    }
    const r = readRegularFile(file);
    if (r.status === "read") {
      // inode 一致性核对（复评 P1-1）：读到 buf 与路径身份必须同一对象。
      // lstat 不跟随 symlink：路径读后被换成指向同 inode 的 symlink 也当场拒。
      // 全部受控捕获：stat 自身炸（如 EIO）也折 unreadable，不裸抛出 collect。
      let post = undefined, postErr = null;
      try { post = fs.lstatSync(file, { throwIfNoEntry: false }); } catch (err) { postErr = err; }
      if (postErr === null && post !== undefined) {
        try { const real = fs.realpathSync(file); if (real !== preReal) postErr = new Error("读前读后 realpath 不一致"); } catch (err) { postErr = err; }
      }
      if (postErr !== null || post === undefined || !post.isFile() || post.nlink !== 1
        || post.ino !== r.ino || post.dev !== r.dev) {
        e = { status: "error", why: "文件在读期间被替换或身份说不清（lstat/realpath 复核失败："
          + (postErr !== null ? String(postErr?.message ?? postErr).slice(0, 60) : post === undefined ? "路径消失" : "身份不等") + "）" };
        cache.set(file, e); return e;
      }
      const real = preReal;
      e = { status: "read", real, sha256: sha256(r.buf), buf: r.buf };
    } else if (r.status === "absent") {
      let parent = null;
      try { parent = fs.realpathSync(path.dirname(file)); } catch (err) {
        // 父目录缺席（ENOENT）是确定的缺席证据，身份取词法路径即可（文件真出现时身份会带真实
        // realpath，第二轮 snapshot_identity 变化会以 snapshot_moved 暴露）；其他错误 fail-closed。
        if (err?.code === "ENOENT") parent = path.resolve(path.dirname(file));
        else {
          e = { status: "error", why: "父目录身份说不清（realpath 失败：" + String(err?.message ?? err).slice(0, 60) + "）" };
          cache.set(file, e); return e;
        }
      }
      e = { status: "absent", real: path.join(parent, path.basename(file)) };
    } else {
      e = { status: "error", why: r.why };
    }
    cache.set(file, e);
    return e;
  };
  /** 逐条受验读一个 JSON 文件；absent → null，坏 → { error }。绝不把"读不出"当"没有"。 */
  const readJsonStrict = (file) => {
    const e = fetch(file);
    if (e.status === "absent") return { absent: true };
    if (e.status === "error") return { error: e.why };
    try { return { value: JSON.parse(e.buf.toString("utf-8")) }; }
    catch (err) { return { error: "JSON 坏：" + String(err.message).slice(0, 120) }; }
  };
  /** §1 封闭身份清单：从缓存派生（不再读盘）。同一路径可能被多个来源引用——按真实路径去重。 */
  const identityOf = (files) => {
    const seen = new Map();
    for (const file of files) {
      const e = fetch(file);
      if (e.status === "error") return { ok: false, path: file, why: e.why };
      const entry = { path: e.real, sha256: e.status === "read" ? e.sha256 : null };
      const prev = seen.get(entry.path);
      if (prev === undefined) seen.set(entry.path, entry);
      else if (prev.sha256 !== entry.sha256) return { ok: false, path: entry.path, why: "同一路径身份冲突" };
    }
    return { ok: true, identity: [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  };
  return { fetch, readJsonStrict, identityOf };
};

/**
 * 冻结来源身份（复评 P1-1）：从采集缓存取每个 source 的身份（真实路径 + sha 或 null），
 * 零次新读盘；与 binding 同生命周期。identitySubset 纯内存匹配它。
 */
const frozenSourceIdentity = (io, files) => files.map((f) => {
  const e = io.fetch(f);
  return { source: f, path: e.real, sha256: e.status === "read" ? e.sha256 : null };
});

/** 由已物化的 mapping 组装一条 binding 证据（§1 产出；投影 C 的全部输入都在这里）。 */
const bindingEvidence = ({ bindingId, enabled, root, sessionId, chatId, target, state, generationSource, sourceFiles, sourceIdentity, expiresAt, interactionPolicyState }) => ({
  binding_id: bindingId,
  enabled: enabled === false ? false : undefined, // 只在来源真给 false 时带（undefined = 未声明）
  root,
  chat_id: chatId,
  state,
  generation_source: generationSource,
  binding_target: target,
  source_files: sourceFiles,
  // 冻结来源身份（复评 P1-1）：采集时的身份（真实路径 + sha 或 null），与 binding 同生命周期；
  // identitySubset 纯内存匹配它，不再二次读现场。
  source_identity: sourceIdentity,
  // M1b T4：expires_at / interaction_policy_state 随 binding 证据带走（sidecar renderer 的规范输入；
  // mapping 层字段此前被 bindingEvidence 丢弃）。缺席归 null：expires_at 为 null 由 renderer fail-closed，
  // interaction_policy_state 为 null → Mapping 默认条目。
  expires_at: expiresAt ?? null,
  interaction_policy_state: interactionPolicyState ?? null,
});

/* ─────────────────────────── Claude 侧 ─────────────────────────── */

/**
 * Claude legacy 快照：registry.json 的 projects[] 是项目集合唯一来源；
 * chat_id 取机器链模板（链路级字段以模板为准，与 resolveProject 同一语义）。
 * templateFile 必须由调用方给出（机器级 = ~/.claude/feishu-bridge/chain-config.json）。
 */
export function collectClaudeLegacySnapshot({ registryFile, templateFile, now = Date.now() } = {}) {
  if (typeof registryFile !== "string" || typeof templateFile !== "string") {
    return unreadable("args", "registryFile/templateFile 必须是路径串");
  }
  const io = makeFetcher();
  // 模板是 chat_id 唯一权威；读不出 = 整份快照没有任何合法 chat_id 可言 → fail-closed。
  const tplE = io.fetch(templateFile);
  if (tplE.status !== "read") {
    return unreadable("chain-template", tplE.status === "absent" ? "链模板缺席" : "链模板读不出（" + tplE.why + "）");
  }
  const tpl = parseChainTemplateRaw(tplE.buf.toString("utf-8"), templateFile);
  if (!tpl.ok) return unreadable("chain-template", "链模板读不出/不完整（" + tpl.reason + "）");
  // 权威来源判别封闭（复评 P1-2）：Codex 链的模板歬 Claude 适配器也必须拒，不能只靠 chat_id 形状。
  if (tpl.template.chain !== "claude") {
    return unreadable("chain-template", "链模板 chain 不是 claude（M1a Claude 快照只认 claude 链模板）");
  }
  const chatId = tpl.template.chat_id;
  if (typeof chatId !== "string" || !CHAT_SHAPE.test(chatId)) {
    return unreadable("chain-template", "模板 chat_id 形状不对（账本受验形状 oc_[A-Za-z0-9]{1,120}）");
  }

  const reg = io.readJsonStrict(registryFile);
  if (reg.absent) {
    // registry 缺席 = 空表（loadRegistryStrict 同语义：只有"文件不存在"算空）。
    const id = io.identityOf([registryFile, templateFile]);
    if (!id.ok) return unreadable("snapshot-identity", id.why);
    return { ok: true, chain: "claude", snapshot_identity: id.identity, chat_id: chatId, bindings: [] };
  }
  if (reg.error) return unreadable("registry", reg.error);
  if (!isObj(reg.value) || (reg.value.projects !== undefined && !Array.isArray(reg.value.projects))) {
    return unreadable("registry", "根节点/projects 形状不对");
  }
  const projects = reg.value.projects ?? [];

  // 逐条目出 binding 证据；按 root 分组（与运行时同一份 normalizeRoot），组内项目文件在场即优先。
  const byRoot = new Map();
  for (let i = 0; i < projects.length; i++) {
    const entry = projects[i];
    if (!isObj(entry)) return unreadable("registry:" + i, "条目不是对象");
    const root = normalizeRoot(entry.root);
    if (root === null) return unreadable("registry:" + i, "root 不是可用路径串");
    const entryId = entry.id ?? path.basename(root);
    if (typeof entryId !== "string" || entryId.length === 0) return unreadable("registry:" + i, "缺 id 且 basename 不可用");
    if (!LINEAGE_SHAPE.test(entryId + "@registry")) return unreadable("registry:" + i, "binding_id 形状越界（账本 lineage 受验形状）");
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({ entry, index: i, entryId });
  }

  const bindings = [];
  const mappingFiles = [];
  for (const [root, group] of byRoot) {
    const mapPath = projectMappingPath(root);
    mappingFiles.push(mapPath);
    const file = io.readJsonStrict(mapPath);
    if (file.error) return unreadable("project-mapping", "项目 mapping 文件读不出：" + file.error);
    if (!file.absent) {
      // 项目文件在场 → 本组**一份**投影（registry 不产第二份）；binding_id 取 effectiveBindingId
      // 的同源投影（旧文件无 binding_id 时 = basename@project-files）。
      if (!isObj(file.value)) return unreadable("project-mapping", "项目 mapping 根节点不是对象");
      const mapping = file.value;
      const bindingId = effectiveBindingId(mapping, { root });
      // enabled 回指（评审 P1-2）：项目文件不记 enabled，registry 才记；按 binding_id 回指唯一条目。
      const rid = typeof bindingId === "string" && bindingId.endsWith("@registry")
        ? bindingId.slice(0, bindingId.length - "@registry".length) : null;
      let owner = null;
      if (rid !== null) {
        const hits = group.filter((g) => g.entryId === rid);
        if (hits.length !== 1) return conflict("项目文件的 registry 回指不唯一（命中 " + hits.length + " 条同 id 登记）");
        owner = hits[0].entry;
      } else if (group.length > 1) {
        return conflict("同 root 多条 registry 登记且项目文件未回指，enabled 无法唯一判定");
      } else {
        owner = group[0].entry;
      }
      const evolved = applyTopicGenerationToMapping(mapping, { runtime: "claude", bindingId, now });
      if (!evolved.ok) return unreadable("topic-generation-state", "项目 mapping 的代际状态校验不过（" + evolved.reason + "）");
      const sid = evolved.mapping.claude_session_id;
      bindings.push(bindingEvidence({
        bindingId,
        enabled: owner?.enabled,
        root,
        chatId,
        state: evolved.state,
        generationSource: evolved.projection,
        target: {
          runtime: "claude", project_root: root,
          claude_session_id: typeof sid === "string" ? sid : null,
          complete: typeof sid === "string" && UUID_SHAPE.test(sid),
        },
        sourceFiles: [registryFile, templateFile, mapPath],
        sourceIdentity: frozenSourceIdentity(io, [registryFile, templateFile, mapPath]),
        expiresAt: evolved.mapping.expires_at,
        interactionPolicyState: evolved.mapping.interaction_policy_state,
      }));
      continue;
    }
    // 项目文件缺席 → registry 条目逐条投影（同 root 项目级 + 会话级各是一条绑定）。
    for (const { entry, index, entryId } of group) {
      const evolved = applyTopicGenerationToMapping(
        mappingFromRegistryEntry({ ...entry, id: entryId }, { materialize: false }),
        { runtime: "claude", bindingId: entryId + "@registry", now });
      if (!evolved.ok) return unreadable("registry:" + index, "registry 条目的代际状态校验不过（" + evolved.reason + "）");
      const sid = entry.claude_session_id;
      bindings.push(bindingEvidence({
        bindingId: entryId + "@registry",
        enabled: entry.enabled,
        root,
        chatId,
        state: evolved.state,
        generationSource: evolved.projection,
        target: {
          runtime: "claude", project_root: root,
          claude_session_id: typeof sid === "string" ? sid : null,
          complete: typeof sid === "string" && UUID_SHAPE.test(sid),
        },
        sourceFiles: [registryFile, templateFile],
        sourceIdentity: frozenSourceIdentity(io, [registryFile, templateFile]),
        expiresAt: evolved.mapping.expires_at,
        interactionPolicyState: evolved.mapping.interaction_policy_state,
      }));
    }
  }

  // 双投影（同一 binding_id 两次）→ legacy_conflict。
  const seen = new Set();
  for (const b of bindings) {
    if (seen.has(b.binding_id)) return conflict("binding_id 双投影（同 id 两条投影，无法定谁作数）");
    seen.add(b.binding_id);
  }
  const id = io.identityOf([registryFile, templateFile, ...mappingFiles]);
  if (!id.ok) return unreadable("snapshot-identity", id.why);
  return { ok: true, chain: "claude", snapshot_identity: id.identity, chat_id: chatId, bindings };
}

/* ─────────────────────────── Codex 侧 ─────────────────────────── */

/**
 * Codex task → mapping 物化，**不读盘**（与 codex/state.mjs mappingForTask 同构，评审 P1-1：
 * mappingForTask 内部 loadConsumed 会裸读 consumed 文件，而 consumed_message_ids 不进投影 C）。
 * 同构性由行为测试守住：同一 task 两侧产出的 topic_generation_state 必须一致。
 */
const codexMappingFromTask = (task, { now } = {}) => {
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
    consumed_message_ids: [],
    created_at: task.bound_at ?? null,
    _source: "codex-registry",
  };
  const evolved = applyTopicGenerationToMapping(mapping, {
    runtime: "codex",
    bindingId: mapping.binding_id,
    now,
  });
  // 持久化的新状态一旦损坏必须 fail-closed，不能悄悄回落到旧字段继续收消息。
  // projection 必须取 evolved.projection（复评 P2-1）：不能在物化后恒报 stored_v1。
  return evolved.ok ? { status: "ok", projection: evolved.projection, mapping: evolved.mapping } : {
    ...mapping,
    status: "invalid",
    topic_generation_error: evolved.reason,
  };
};

/**
 * Codex legacy 快照：只读 task registry；binding_id = <taskId>@codex-registry；
 * chat_id 按 task 覆盖优先、模板群兜底；disabled（enabled:false）任务**仍进快照**（§4 enabled 行）。
 */
export function collectCodexLegacySnapshot({ home, now = Date.now() } = {}) {
  if (typeof home !== "string") return unreadable("args", "home 必须是路径串");
  const regFile = codexRegistryFile(home);
  const tplFile = codexTemplateFile(home);
  const io = makeFetcher();
  const tplE = io.fetch(tplFile);
  if (tplE.status !== "read") {
    return unreadable("chain-template", tplE.status === "absent" ? "Codex 链模板缺席" : "Codex 链模板读不出（" + tplE.why + "）");
  }
  const parsed = parseChainTemplateRaw(tplE.buf.toString("utf-8"), tplFile);
  if (!parsed.ok) return unreadable("chain-template", "Codex 链模板读不出/不完整（" + parsed.reason + "）");
  const cv = validateCodexTemplate(parsed.template);
  if (!cv.ok) return unreadable("chain-template", "Codex 链模板不是单 m5codex 形状（" + cv.reason + "）");
  const templateChatId = parsed.template.chat_id;
  if (typeof templateChatId !== "string" || !CHAT_SHAPE.test(templateChatId)) {
    return unreadable("chain-template", "模板 chat_id 形状不对");
  }

  const raw = io.readJsonStrict(regFile);
  let tasks = [];
  if (!raw.absent) {
    if (raw.error) return unreadable("codex-registry", raw.error);
    const v = validateRegistryDocument(raw.value);
    if (!v.ok) return unreadable("codex-registry", v.detail ?? v.reason);
    tasks = raw.value.tasks ?? [];
  }

  const bindings = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!isObj(task)) return unreadable("codex-registry:" + i, "task 不是对象");
    const disabled = task.enabled === false;
    const hasKey = typeof task.logical_task_key === "string" && task.logical_task_key !== "";
    if (disabled && !hasKey) continue; // validateRegistryDocument 同语义：无身份的停用条目跟谁都撞不上
    // registry JSON 里的 task 可能无 id（validateRegistryDocument 同语义：缺失时以 logical_task_key 为准）。
    const mapping = codexMappingFromTask({ ...task, id: task.id ?? task.logical_task_key }, { now });
    if (mapping.status === "invalid") {
      return unreadable("codex-task-state", "task 代际状态校验不过（" + mapping.topic_generation_error + "）");
    }
    if (!LINEAGE_SHAPE.test(mapping.mapping.binding_id)) return unreadable("codex-registry:" + i, "binding_id 形状越界");
    // chat_id：task 覆盖优先；覆盖值在场但形状坏 = 采集失败（fail-closed，不静默兜底）。
    // 复评 P1-2：只允许字段缺席/null 走模板兜底；数字/数组/对象这类"有值但不是串"是形状坏，必须拒。
    let chatId = templateChatId;
    if (typeof task.chat_id === "string" && task.chat_id !== "") {
      if (!CHAT_SHAPE.test(task.chat_id)) return unreadable("codex-registry:" + i, "task 级 chat_id 覆盖形状不对");
      chatId = task.chat_id;
    } else if (task.chat_id !== undefined && task.chat_id !== null) {
      return unreadable("codex-registry:" + i, "task 级 chat_id 覆盖不是字符串（覆盖值在场必须过 CHAT_SHAPE）");
    }
    const root = typeof task.root === "string" ? task.root : null;
    const thread = typeof task.codex_thread_id === "string" ? task.codex_thread_id : null;
    bindings.push(bindingEvidence({
      bindingId: mapping.mapping.binding_id,
      enabled: task.enabled,
      root,
      chatId,
      state: mapping.mapping.topic_generation_state,
      generationSource: mapping.projection,
      target: {
        runtime: "codex", project_root: root,
        codex_task_id: mapping.mapping.binding_id.slice(0, mapping.mapping.binding_id.length - "@codex-registry".length),
        codex_thread_id: thread,
        complete: root !== null && path.isAbsolute(root) && thread !== null && CODEX_ID_SHAPE.test(thread),
      },
      sourceFiles: [regFile, tplFile],
      sourceIdentity: frozenSourceIdentity(io, [regFile, tplFile]),
      expiresAt: mapping.mapping.expires_at,
      interactionPolicyState: mapping.mapping.interaction_policy_state,
    }));
  }

  const seen = new Set();
  for (const b of bindings) {
    if (seen.has(b.binding_id)) return conflict("binding_id 双投影（同 id 两条投影，无法定谁作数）");
    seen.add(b.binding_id);
  }
  const id = io.identityOf([regFile, tplFile]);
  if (!id.ok) return unreadable("snapshot-identity", id.why);
  return { ok: true, chain: "codex", snapshot_identity: id.identity, chat_id: templateChatId, bindings };
}

/* ─────────────────────────── 逐记录来源摘要（§3 legacy_source_digest，供 T3b 用） ─────────────────────────── */

/**
 * 从 snapshot_identity 里选出与 binding 来源对应的子集（复评 P1-1 重写）：
 * 纯内存精确匹配 binding.source_identity（采集时冻结的 {source, path, sha256}），
 * **零次文件系统调用**——不再二次读现场（旧实现 realpathSync 在采集后路径被替换时会
 * 返回 {ok:true, subset:[]}，来源证据悄悄缺失）。逐 source 必须在 identity 里命中
 * （path 全等 ∧ sha256 全等），否则 fail-closed；subset 按 source 顺序去重。
 */
export function identitySubset(snapshotIdentity, binding) {
  if (!Array.isArray(snapshotIdentity)) return { ok: false, why: "snapshot_identity 形状不对" };
  const frozen = binding?.source_identity;
  if (!Array.isArray(frozen) || frozen.length === 0) return { ok: false, why: "binding 缺冻结来源身份（source_identity 空/非数组）" };
  const subset = [];
  const seen = new Set();
  for (const f of frozen) {
    if (f === null || typeof f !== "object" || typeof f.source !== "string" || typeof f.path !== "string") {
      return { ok: false, why: "冻结来源身份条目形状不对" };
    }
    const hit = snapshotIdentity.find((e) => e !== null && e.path === f.path && e.sha256 === f.sha256);
    if (hit === undefined) {
      return { ok: false, why: "来源身份在 snapshot_identity 里没命中（来源证据缺失）：" + f.path };
    }
    if (!seen.has(hit.path)) { seen.add(hit.path); subset.push(hit); }
  }
  return { ok: true, subset };
}

/**
 * legacy_source_digest（§3 封闭公式）：对账/迁移的逐记录来源证明。
 * 本单（T3a）只产出不消费；digest 输入里的 snapshot 是调用方传入的**冻结身份子集**
 * （identitySubset 的产出）——本函数不读盘（评审 P1-1），来源变化由外层 snapshot_moved 兜住。
 */
export function legacySourceDigest({ binding, generation, identity }) {
  if (!Array.isArray(identity)) return { ok: false, why: "identity 必须是冻结身份子集数组" };
  return { ok: true, digest: sha256(canonKey({
    digest_version: "lsd-1",
    binding_id: binding.binding_id,
    channel_generation_id: generation.channel_generation_id,
    generation_status: generation.status,
    binding_status: binding.state?.binding_status ?? null,
    root_om: typeof generation.root_message_id === "string" ? generation.root_message_id : null,
    aily_session: typeof generation.session_id === "string" ? generation.session_id : null,
    binding_target: binding.binding_target.complete
      ? Object.fromEntries(Object.entries(binding.binding_target).filter(([k]) => k !== "complete"))
      : null,
    snapshot: identity,
  })) };
}

/** 导出给判别/投影与测试复用的受验形状（避免第三处复述）。 */
export const M1A_SHAPES = Object.freeze({ OM_SHAPE, CHAT_SHAPE, UUID_SHAPE, LINEAGE_SHAPE, CODEX_ID_SHAPE });
