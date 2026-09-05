/**
 * M1b T4 ④：三个 sidecar 的**确定性 renderer** 与**读取端 validator**（m1a-reconciliation.md §4.1 4e / 4e-2）。
 *
 * 共同输入：同一冻结 legacy snapshot 的 bindings + §3 期望集 E（Map：topic_agent_id → 记录六字段）。
 * 输出：`JSON.stringify(stable(doc), null, 2) + "\n"` —— stable 与 policy-store/canonical 同源（递归键排序），
 * 同一输入字节级可复现，三件产物分别作为 expiry/pending-claims/policy sidecar 的 staged blob。
 *
 *   · expiry-1：E 中每条记录 → 其 binding（generation_lineage_id === binding_id）的 expires_at 经规范化；空 E → entries:{}。
 *   · pending-claims-1：仅 B1（facts.generation === "pending"）记录 → 从 binding 的 TGS 里按 topic_agent_id 派生公式
 *     反查 generation，取 pending_token / claim_expires_at；token===null ⇒ claim_expires_at===null。
 *   · policy-1：subject = policySubjectId({kind:"lineage", endpointId, id: binding_id})；条目 = binding.interaction_policy_state
 *     原样，缺席 → Mapping 默认条目（updated_at 哨兵 1970）；交叉不变量：条目 binding_id 必须等于 subject 派生输入；
 *     同 subject 逐字等 → 去重，不等 → policy_subject_conflict。
 *
 * 读取端（4e-2）：fd 绑定（O_NOFOLLOW / 普通文件 / 单硬链接 / mode 0600 / 父目录 0700）、≤1MiB、三键根、≤512 条、
 * 值域按 4e 逐键封闭；一切读不出/不像合法 sidecar → { ok:false, reason:"sidecar_unreadable" }。
 * 读取端不核 psid 交叉不变量（M1b 运行时 topic_agent 条目无法自证）——lineage 保证由 renderer 侧测试钉死。
 */
import fs from "node:fs";
import path from "node:path";

import { topicAgentIdForLegacy } from "../m1a/reconcile.mjs";
import { stableStringify } from "../policy-store/canonical.mjs";
import { interactionPolicyStateProblem, policySubjectId } from "../policy-store/validator.mjs";

export const SIDECAR_SCHEMAS = Object.freeze({ expiry: "expiry-1", "pending-claims": "pending-claims-1", policy: "policy-1" });
const TA_SHAPE = /^ta_[0-9a-f]{32}$/u;
const PSID_SHAPE = /^ps_[0-9a-f]{32}$/u;
const TOKEN_SHAPE = /^[0-9a-f]{6}$/u;
const MAX_ENTRIES = 512;
const MAX_BYTES = 1024 * 1024;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
/** expires_at / claim_expires_at 的规范化：可解析 → toISOString；不可解析（含 null/undefined）→ null（调用方 fail-closed）。 */
const normalizeIso = (s) => (s !== null && s !== undefined && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
const unreadable = (why) => ({ ok: false, reason: "legacy_unreadable", why });
const fail = (reason, why) => ({ ok: false, reason, why });

/** 期望记录 E 的形状封闭（六字段；不含 expires_at/pending_token/claim_expires_at/interaction_policy_state——那些在 binding/TGS）。 */
function eRecordProblem(rec) {
  if (!(isObj(rec) && keysOf(rec) === "aliases,binding_target,chat_id,facts,generation_lineage_id,topic_agent_id")) return "期望记录字段集不对";
  if (typeof rec.topic_agent_id !== "string" || !TA_SHAPE.test(rec.topic_agent_id)) return "topic_agent_id 形状不对";
  if (typeof rec.chat_id !== "string" || rec.chat_id.length === 0) return "chat_id 不是非空字符串";
  if (typeof rec.generation_lineage_id !== "string" || rec.generation_lineage_id.length === 0) return "generation_lineage_id 不是非空字符串";
  if (!(isObj(rec.facts) && typeof rec.facts.generation === "string")) return "facts.generation 不是字符串";
  return null;
}

/** lineage → binding 恰好一条（snapshot 内部一致性：0 或多条都是快照矛盾）。 */
function bindingByLineage(bindings, lineageId) {
  const hits = bindings.filter((b) => b?.binding_id === lineageId);
  if (hits.length !== 1) return { ok: false, why: "lineage " + lineageId + " 命中 " + hits.length + " 条 binding（必须恰一）" };
  return { ok: true, binding: hits[0] };
}

/** 渲染共同骨架：E 形状核 → lineage 唯一定位 binding → 逐条产 entries → stable 字节。 */
function renderSidecar({ endpointId, bindings, E, name, buildEntries }) {
  if (typeof endpointId !== "string" || !/^endpoint_[0-9a-f]{24}$/u.test(endpointId)) return fail("legacy_unreadable", "endpoint_id 形状不对");
  if (!Array.isArray(bindings)) return unreadable("bindings 不是数组");
  if (!(E instanceof Map)) return unreadable("E 不是 Map");
  const perRecord = [];
  for (const rec of E.values()) {
    const p = eRecordProblem(rec);
    if (p !== null) return unreadable(p);
    const b = bindingByLineage(bindings, rec.generation_lineage_id);
    if (!b.ok) return unreadable(b.why);
    perRecord.push({ rec, binding: b.binding });
  }
  let entries;
  try {
    entries = buildEntries(perRecord, endpointId);
  } catch (err) {
    return err?.reason === "policy_subject_conflict" ? fail("policy_subject_conflict", String(err.why ?? err.message)) : unreadable(String(err.why ?? err.message));
  }
  if (entries === null) return { ok: false, reason: "legacy_unreadable", why: "构建 entries 失败（细节见前置检查）" };
  const doc = { schema_version: SIDECAR_SCHEMAS[name], endpoint_id: endpointId, entries };
  return { ok: true, bytes: Buffer.from(stableStringify(doc, 2) + "\n", "utf-8") };
}

export function renderExpirySidecar({ endpointId, bindings, E }) {
  return renderSidecar({ endpointId, bindings, E, name: "expiry", buildEntries: (perRecord) => {
    const entries = {};
    for (const { rec, binding } of perRecord) {
      const iso = normalizeIso(binding.expires_at);
      if (iso === null) throw Object.assign(new Error("binding " + binding.binding_id + " 的 expires_at 不可规范化（值为 " + JSON.stringify(binding.expires_at ?? null) + "）；永不过期分支规格未定义，fail-closed"), { why: "expires_at 不可规范化" });
      entries[rec.topic_agent_id] = iso;
    }
    return entries;
  } });
}

export function renderPendingClaimsSidecar({ endpointId, bindings, E }) {
  return renderSidecar({ endpointId, bindings, E, name: "pending-claims", buildEntries: (perRecord) => {
    const entries = {};
    for (const { rec, binding } of perRecord) {
      if (rec.facts.generation !== "pending") continue; // 只有 B1 进待认领表
      const gens = Array.isArray(binding.state?.generations) ? binding.state.generations : [];
      // 与 renderer 同源的派生公式反查 generation（确定性、同 binding 内唯一；重算判别而不是存指针）
      const matches = gens.filter((g) => isObj(g) && typeof g.channel_generation_id === "string"
        && topicAgentIdForLegacy(endpointId, binding.binding_id, g.channel_generation_id) === rec.topic_agent_id);
      if (matches.length !== 1) throw Object.assign(new Error("B1 记录 " + rec.topic_agent_id + " 在 TGS 里命中 " + matches.length + " 个 generation"), { why: "B1 记录无法唯一回溯到 generation" });
      const g = matches[0];
      const token = g.pending_token ?? null;
      if (token !== null && !TOKEN_SHAPE.test(token)) throw Object.assign(new Error("pending_token 形状越界：" + JSON.stringify(token)), { why: "pending_token 形状越界" });
      const claim = normalizeIso(g.claim_expires_at ?? null);
      if (g.claim_expires_at !== null && g.claim_expires_at !== undefined && claim === null) throw Object.assign(new Error("claim_expires_at 不可规范化：" + JSON.stringify(g.claim_expires_at)), { why: "claim_expires_at 不可规范化" });
      if (token === null && claim !== null) throw Object.assign(new Error("pending_token 为 null 而 claim_expires_at 为 " + claim + "（蕴含违反）"), { why: "token===null ⇒ claim_expires_at 必须 null" });
      entries[rec.topic_agent_id] = { token, claim_expires_at: claim };
    }
    return entries;
  } });
}

const MAPPING_DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const mappingDefaultEntry = (bindingId) => ({ schema_version: "1.0", binding_id: bindingId, policy_id: "mapping", policy_version: "1.0", updated_at: MAPPING_DEFAULT_UPDATED_AT, dialogue: null });

export function renderPolicySidecar({ endpointId, bindings, E }) {
  return renderSidecar({ endpointId, bindings, E, name: "policy", buildEntries: (perRecord) => {
    const entries = {};
    for (const { rec, binding } of perRecord) {
      const subject = policySubjectId({ kind: "lineage", endpointId, id: binding.binding_id });
      const entry = binding.interaction_policy_state ?? mappingDefaultEntry(binding.binding_id);
      // 交叉不变量（4e）：kind=lineage 时 binding_id 必须等于 subject 的派生输入。
      if (entry?.binding_id !== binding.binding_id) throw Object.assign(new Error("交叉不变量：条目 binding_id（" + JSON.stringify(entry?.binding_id ?? null) + "）≠ subject 派生输入（" + binding.binding_id + "）"), { why: "条目 binding_id 与 subject 派生输入不一致" });
      const problem = interactionPolicyStateProblem(entry);
      if (problem !== null) throw Object.assign(new Error("interaction_policy_state 不合法：" + problem), { why: "interaction_policy_state 不合法：" + problem });
      const prev = entries[subject];
      if (prev !== undefined) {
        if (stableStringify(prev, 2) !== stableStringify(entry, 2)) {
          throw Object.assign(new Error("同 subject " + subject + " 的条目互不一致（policy_subject_conflict）"), { reason: "policy_subject_conflict", why: "同 subject 条目不一致：" + subject });
        }
        continue; // 逐字相等 → 去重（不依赖 E 迭代序）
      }
      entries[subject] = entry;
    }
    return entries;
  } });
}

// ── 读取端（4e-2）────────────────────────────────────────────────────────────
const entryChecks = {
  expiry: (entries) => {
    for (const [k, v] of Object.entries(entries)) {
      if (!TA_SHAPE.test(k)) return "键不是 topic_agent_id：" + k;
      if (!isCanonicalIso(v)) return "值不是规范化 ISO：" + JSON.stringify(v);
    }
    return null;
  },
  "pending-claims": (entries) => {
    for (const [k, v] of Object.entries(entries)) {
      if (!TA_SHAPE.test(k)) return "键不是 topic_agent_id：" + k;
      if (!(isObj(v) && keysOf(v) === "claim_expires_at,token")) return "值键集不是 {token, claim_expires_at}";
      if (v.token !== null && !TOKEN_SHAPE.test(v.token)) return "token 形状越界：" + JSON.stringify(v.token);
      if (v.claim_expires_at !== null && !isCanonicalIso(v.claim_expires_at)) return "claim_expires_at 不是 null 或规范化 ISO";
      if (v.token === null && v.claim_expires_at !== null) return "token===null ⇒ claim_expires_at 必须 null";
    }
    return null;
  },
  policy: (entries) => {
    for (const [k, v] of Object.entries(entries)) {
      if (!PSID_SHAPE.test(k)) return "键不是 policy_subject_id：" + k;
      const problem = interactionPolicyStateProblem(v);
      if (problem !== null) return "条目 interaction_policy_state 不合法：" + problem;
    }
    return null;
  },
};

/** sidecar 文档值域封闭（三键根 + ≤512 条 + 值域按 4e）。返回 null 或问题串。 */
export function validateSidecarDoc(doc, name, { endpointId } = {}) {
  if (!isObj(doc)) return "sidecar 根不是对象";
  if (keysOf(doc) !== "endpoint_id,entries,schema_version") return "根键集不对";
  if (doc.schema_version !== SIDECAR_SCHEMAS[name]) return "schema_version 不是 " + SIDECAR_SCHEMAS[name];
  if (typeof doc.endpoint_id !== "string" || !/^endpoint_[0-9a-f]{24}$/u.test(doc.endpoint_id)) return "endpoint_id 形状不对";
  if (endpointId !== undefined && doc.endpoint_id !== endpointId) return "endpoint_id 与账本不一致";
  if (!isObj(doc.entries)) return "entries 不是对象";
  const ids = Object.keys(doc.entries);
  if (ids.length > MAX_ENTRIES) return "entries 超过 " + MAX_ENTRIES + " 条";
  return entryChecks[name](doc.entries);
}

/** 读取端：fd 绑定（O_NOFOLLOW / 普通文件 / 单硬链接 / 0600）+ 父目录 0700 + ≤1MiB + 值域。 */
export function readSidecarFile({ file, endpointId, name }) {
  if (!SIDECAR_SCHEMAS[name]) return { ok: false, reason: "sidecar_unreadable", why: "未知 sidecar name：" + String(name) };
  if (typeof file !== "string" || file.length === 0) return { ok: false, reason: "sidecar_unreadable", why: "file 不是路径" };
  let dst;
  try { dst = fs.lstatSync(path.dirname(file)); } catch (err) { return { ok: false, reason: "sidecar_unreadable", why: "父目录 lstat：" + String(err?.code ?? err) }; }
  if (!dst.isDirectory() || (dst.mode & 0o777) !== 0o700) return { ok: false, reason: "sidecar_unreadable", why: "父目录不是 0700" };
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (err) { return { ok: false, reason: "sidecar_unreadable", why: String(err?.code ?? err) }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return { ok: false, reason: "sidecar_unreadable", why: "不是单硬链接普通文件" };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, reason: "sidecar_unreadable", why: "mode 不是 0600" };
    if (st.size > MAX_BYTES) return { ok: false, reason: "sidecar_unreadable", why: "超过 1MiB（" + st.size + " 字节）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) return { ok: false, reason: "sidecar_unreadable", why: "读不满文件（" + off + "/" + st.size + "）" }; off += n; }
    let doc;
    try { doc = JSON.parse(buf.toString("utf-8")); } catch (err) { return { ok: false, reason: "sidecar_unreadable", why: "不是 JSON：" + String(err?.message ?? err) }; }
    const problem = validateSidecarDoc(doc, name, { endpointId });
    if (problem !== null) return { ok: false, reason: "sidecar_unreadable", why: problem };
    return { ok: true, doc, bytes: st.size };
  } catch (err) {
    return { ok: false, reason: "sidecar_unreadable", why: String(err?.code ?? err?.message ?? err) };
  } finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}
