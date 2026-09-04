/**
 * M1a 只读对账 · legacy 快照适配器（规格 docs/architecture/m1a-reconciliation.md v6 §1）。
 *
 * 对账 legacy 侧**只能**经这两个封闭适配器产生：
 *   · collectClaudeLegacySnapshot({ registryFile, templateFile, now })
 *   · collectCodexLegacySnapshot({ home, now })
 *
 * 铁律（本模块全部导出的共同前提）：
 *   · **严格只读**——只经 readRegularFile（fd 受验）读文件，不写任何路径；
 *   · **严格读取**——任一在场文件读不出 / JSON 坏 / 代际状态校验不过 → legacy_unreadable，
 *     绝不把读不出当成"没有"；
 *   · **严格 target 采集**——binding_target 全字段受验，缺任一只标记 complete:false
 *     （判别层落 target_incomplete 待修），**绝不临时选值或填默认**；
 *   · enabled:false 的项目**仍进快照**（§4 enabled 行）；项目文件（active-mapping.json）
 *     在场即优先，registry 内联字段只在项目文件缺席时生效，registry 不产第二份投影。
 */

import fs from "node:fs";
import path from "node:path";

import { readRegularFile } from "../installed-surface.mjs";
import { sha256, canonKey } from "../topic-agent-ledger.mjs";
import { normalizeRoot } from "../registry.mjs";
import { loadChainTemplate } from "../chain-template.mjs";
import {
  applyTopicGenerationToMapping, effectiveBindingId, validateTopicGenerationState,
} from "../topic-generation.mjs";
import { mappingFromRegistryEntry, projectMappingPath } from "../project-resolve.mjs";
import {
  loadCodexTemplate, mappingForTask, registryFile as codexRegistryFile,
  templateFile as codexTemplateFile, validateRegistryDocument,
} from "../codex/state.mjs";

/* 与账本侧同源的受验形状（topic-agent-ledger.mjs 内部常量，这里按规格 §3 复述——
 * 两侧形状若有漂移，双射会以 mismatch 的形式暴露，不会静默放过）。 */
const OM_SHAPE = /^om_[A-Za-z0-9]{1,120}$/u;
const CHAT_SHAPE = /^oc_[A-Za-z0-9]{1,120}$/u;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LINEAGE_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;
const CODEX_ID_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 快照身份条目的实际形状（§1 封闭格式）。 */
const identityOf = (files) => {
  const seen = new Map();
  for (const file of files) {
    const r = readRegularFile(file);
    let entry;
    if (r.status === "read") {
      // 在场：身份对文件本身 realpath（symlink 解掉，身份跟内容走）+ 内容 SHA。
      let real = null;
      try { real = fs.realpathSync(file); } catch { real = path.resolve(file); }
      entry = { path: real, sha256: sha256(r.buf) };
    } else if (r.status === "absent") {
      // 缺席：显式 null；身份 = 受验真实父目录（realpath）+ basename —— 父目录被换则身份变。
      let parent = null;
      try { parent = fs.realpathSync(path.dirname(file)); } catch { parent = path.resolve(path.dirname(file)); }
      entry = { path: path.join(parent, path.basename(file)), sha256: null };
    } else {
      return { ok: false, path: file, why: r.why };
    }
    // 同一文件可能被多个来源引用（同 root 多条登记）——按路径去重，路径唯一。
    const prev = seen.get(entry.path);
    if (prev === undefined) seen.set(entry.path, entry);
    else if (prev.sha256 !== entry.sha256) return { ok: false, path: entry.path, why: "同一路径两次读出不同内容" };
  }
  return { ok: true, identity: [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
};

/** 逐条受验读一个 JSON 文件；absent → null，坏 → { error }。绝不把"读不出"当"没有"。 */
const readJsonStrict = (file) => {
  const r = readRegularFile(file);
  if (r.status === "absent") return { absent: true };
  if (r.status !== "read") return { error: r.why };
  try { return { value: JSON.parse(r.buf.toString("utf-8")) }; }
  catch (err) { return { error: "JSON 坏：" + String(err.message).slice(0, 120) }; }
};

const unreadable = (source, why) => ({ ok: false, reason: "legacy_unreadable", source, why });
const conflict = (why) => ({ ok: false, reason: "legacy_conflict", why });

/** 由已物化的 mapping 组装一条 binding 证据（§1 产出；投影 C 的全部输入都在这里）。 */
const bindingEvidence = ({ bindingId, enabled, root, sessionId, chatId, target, state, generationSource, sourceFiles }) => ({
  binding_id: bindingId,
  enabled: enabled === false ? false : undefined, // 只在 registry 条目真给 false 时带（文件优先分支 runtime 不读 enabled）
  root,
  chat_id: chatId,
  state,
  generation_source: generationSource,
  binding_target: target,
  source_files: sourceFiles,
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
  // 模板是 chat_id 唯一权威；读不出 = 整份快照没有任何合法 chat_id 可言 → fail-closed。
  const tpl = loadChainTemplate(templateFile);
  if (!tpl.ok) return unreadable("chain-template", "链模板读不出/不完整（" + tpl.reason + "）");
  const chatId = tpl.template.chat_id;
  if (typeof chatId !== "string" || !CHAT_SHAPE.test(chatId)) {
    return unreadable("chain-template", "模板 chat_id 形状不对（账本受验形状 oc_[A-Za-z0-9]{1,120}）");
  }

  const reg = readJsonStrict(registryFile);
  if (reg.absent) {
    // registry 缺席 = 空表（loadRegistryStrict 同语义：只有"文件不存在"算空）。
    const id = identityOf([registryFile, templateFile]);
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
    const file = readJsonStrict(mapPath);
    if (file.error) return unreadable("project-mapping", "项目 mapping 文件读不出：" + file.error);
    if (!file.absent) {
      // 项目文件在场 → 本组**一份**投影（registry 不产第二份）；binding_id 取 effectiveBindingId
      // 的同源投影（旧文件无 binding_id 时 = basename@project-files）。
      if (!isObj(file.value)) return unreadable("project-mapping", "项目 mapping 根节点不是对象");
      const mapping = file.value;
      const bindingId = effectiveBindingId(mapping, { root });
      const evolved = applyTopicGenerationToMapping(mapping, { runtime: "claude", bindingId, now });
      if (!evolved.ok) return unreadable("topic-generation-state", "项目 mapping 的代际状态校验不过（" + evolved.reason + "）");
      const sid = evolved.mapping.claude_session_id;
      bindings.push(bindingEvidence({
        bindingId,
        root,
        chatId,
        state: evolved.state,
        generationSource: evolved.projection,
        target: {
          runtime: "claude", project_root: root,
          claude_session_id: typeof sid === "string" ? sid : null,
          complete: typeof sid === "string" && UUID_SHAPE.test(sid),
        },
        sourceFiles: [registryFile, mapPath],
      }));
      continue;
    }
    // 项目文件缺席 → registry 条目逐条投影（同 root 项目级 + 会话级各是一条绑定）。
    for (const { entry, index, entryId } of group) {
      const evolved = applyTopicGenerationToMapping(
        mappingFromRegistryEntry({ ...entry, id: entryId }),
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
        sourceFiles: [registryFile],
      }));
    }
  }

  // 双投影（同一 binding_id 两次）→ legacy_conflict。
  const seen = new Set();
  for (const b of bindings) {
    if (seen.has(b.binding_id)) return conflict("binding_id 双投影：" + b.binding_id);
    seen.add(b.binding_id);
  }
  const id = identityOf([registryFile, templateFile, ...mappingFiles]);
  if (!id.ok) return unreadable("snapshot-identity", id.why);
  return { ok: true, chain: "claude", snapshot_identity: id.identity, chat_id: chatId, bindings };
}

/* ─────────────────────────── Codex 侧 ─────────────────────────── */

/**
 * Codex legacy 快照：只读 task registry（mappingForTask 物化语义）；binding_id = <taskId>@codex-registry；
 * chat_id 按 task 覆盖优先、模板群兜底；disabled（enabled:false）任务**仍进快照**（§4 enabled 行）。
 */
export function collectCodexLegacySnapshot({ home, now = Date.now() } = {}) {
  if (typeof home !== "string") return unreadable("args", "home 必须是路径串");
  const regFile = codexRegistryFile(home);
  const tplFile = codexTemplateFile(home);
  const tpl = loadCodexTemplate(tplFile);
  if (!tpl.ok) return unreadable("chain-template", "Codex 链模板读不出/不完整（" + tpl.reason + "）");
  const templateChatId = tpl.template.chat_id;
  if (typeof templateChatId !== "string" || !CHAT_SHAPE.test(templateChatId)) {
    return unreadable("chain-template", "模板 chat_id 形状不对");
  }

  const raw = readJsonStrict(regFile);
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
    // mappingForTask 物化（binding_id = id@codex-registry；内部 applyTopicGenerationToMapping，
    // 状态损坏时给 status:"invalid" + topic_generation_error —— 这里一律 fail-closed）。
    // registry JSON 里的 task 可能无 id（validateRegistryDocument 同语义：缺失时以 logical_task_key 为准）。
    const mapping = mappingForTask({ ...task, id: task.id ?? task.logical_task_key }, { home });
    if (mapping.status === "invalid") {
      return unreadable("codex-task-state", "task 代际状态校验不过（" + mapping.topic_generation_error + "）");
    }
    if (!LINEAGE_SHAPE.test(mapping.binding_id)) return unreadable("codex-registry:" + i, "binding_id 形状越界");
    // chat_id：task 覆盖优先；覆盖值在场但形状坏 = 采集失败（fail-closed，不静默兜底）。
    let chatId = templateChatId;
    if (typeof task.chat_id === "string" && task.chat_id !== "") {
      if (!CHAT_SHAPE.test(task.chat_id)) return unreadable("codex-registry:" + i, "task 级 chat_id 覆盖形状不对");
      chatId = task.chat_id;
    }
    const root = typeof task.root === "string" ? task.root : null;
    const thread = typeof task.codex_thread_id === "string" ? task.codex_thread_id : null;
    bindings.push(bindingEvidence({
      bindingId: mapping.binding_id,
      enabled: task.enabled,
      root,
      chatId,
      state: mapping.topic_generation_state,
      generationSource: mapping.topic_generation_state ? "stored_v1" : "legacy_v1",
      target: {
        runtime: "codex", project_root: root,
        codex_task_id: mapping.binding_id.slice(0, mapping.binding_id.length - "@codex-registry".length),
        codex_thread_id: thread,
        complete: root !== null && path.isAbsolute(root) && thread !== null && CODEX_ID_SHAPE.test(thread),
      },
      sourceFiles: [regFile, tplFile],
    }));
  }

  const seen = new Set();
  for (const b of bindings) {
    if (seen.has(b.binding_id)) return conflict("binding_id 双投影：" + b.binding_id);
    seen.add(b.binding_id);
  }
  const id = identityOf([regFile, tplFile]);
  if (!id.ok) return unreadable("snapshot-identity", id.why);
  return { ok: true, chain: "codex", snapshot_identity: id.identity, chat_id: templateChatId, bindings };
}

/* ─────────────────────────── 逐记录来源摘要（§3 legacy_source_digest，供 T3b 用） ─────────────────────────── */

/**
 * legacy_source_digest（v6 §3 封闭公式）：对账/迁移的逐记录来源证明。
 * 本单（T3a）只产出不消费；快照子集取该 binding 的相关源文件 {path,sha256}。
 */
export function legacySourceDigest({ binding, generation }) {
  const sub = identityOf(binding.source_files ?? []);
  if (!sub.ok) return { ok: false, why: sub.why };
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
    snapshot: sub.identity,
  })) };
}

/** 导出给判别/投影与测试复用的受验形状（避免第三处复述）。 */
export const M1A_SHAPES = Object.freeze({ OM_SHAPE, CHAT_SHAPE, UUID_SHAPE, LINEAGE_SHAPE, CODEX_ID_SHAPE });
