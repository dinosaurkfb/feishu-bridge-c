// scripts/maintenance/owner-select-state.mjs
// R50：owner_select campaign / writer-state 文件**合同与读写原语**（不做门锁 fencing——那是 R51 接线）。
//
// 派生复用（三处同一派生，不另写）：campaign_id = campaignIdFor(token)（journal step id / campaign 文件 /
//   writer-state 三处同一编码）；endpoints_digest = sha256(canonKey(endpoints))。canonKey/ledgerRootFor 来自
//   topic-agent-ledger.mjs（同一概念只住一处，不许第二份路径/键派生）。
//
// 边界：本模块只做文件合同（封闭字段）、read 状态联合、write 原语（含 CAS + 原子持久），**不含**维护门锁
//   fencing（生产写方据此 fail-closed，R51 接线）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonKey, ledgerRootFor } from "../topic-agent-ledger.mjs";

const SHA_SHAPE = /^[0-9a-f]{64}$/u;
const EP_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
const CAMPAIGN_ID_SHAPE = /^osc_[0-9a-f]{32}$/u;
const SCHEMA_VALUES = ["1.0", "1.1-transition", "1.1"];
const CAMPAIGN_FILE_SCHEMA = "owner-select-campaign-1";
const WRITER_FILE_SCHEMA = "owner-select-writer-state-1";
const CAMPAIGN_STATES = ["open", "sealed", "complete"];
const WRITER_STATES = ["off", "partial", "on"];
const keysOf = (o) => Object.keys(o).sort().join(",");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256Of = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const canonKeyOf = (v) => canonKey(v);
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

/* ── 纯派生（§二.1）：同一编码，三处（journal step id / campaign 文件 / writer-state）同源 ────────── */
export const campaignIdFor = (token) =>
  "osc_" + sha256Of(canonKeyOf({ domain: "owner_select_campaign_v1", token })).slice(0, 32);
export const endpointsDigest = (endpoints) => sha256Of(canonKeyOf(endpoints));

/* ── 路径（§二.2）：受验、环境派生的 ledger 根下固定相对路径；不把字面 ~/.claude/... 当协议 ────────── */
export const campaignPathFor = (env = process.env) => {
  const root = ledgerRootFor(env);
  return typeof root === "string" && root.length > 0 ? path.join(root, "owner-select-campaign.json") : null;
};
export const writerStatePathFor = (env = process.env) => {
  const root = ledgerRootFor(env);
  return typeof root === "string" && root.length > 0 ? path.join(root, "owner-select-writer-state.json") : null;
};

/* ── 文件合同校验（封闭字段；多键/少键/不自洽 → 返回 problem 字符串，null=合法）────────────────────── */

/** campaign 文件封闭字段（§二.3）。 */
export function campaignStateProblem(doc) {
  if (!isObj(doc)) return "campaign 文件不是对象";
  if (keysOf(doc) !== "campaign_id,endpoints,endpoints_digest,members,origin_operation_id,pending_joins,revision,schema_version,state")
    return "campaign 字段集不对";
  if (doc.schema_version !== CAMPAIGN_FILE_SCHEMA) return "campaign.schema_version 不对";
  if (!CAMPAIGN_STATES.includes(doc.state)) return "campaign.state 越界";
  if (!CAMPAIGN_ID_SHAPE.test(doc.campaign_id)) return "campaign.campaign_id 形状不对";
  if (!SHA_SHAPE.test(doc.endpoints_digest)) return "campaign.endpoints_digest 不是 64hex";
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) return "campaign.revision 不是正整数";
  if (typeof doc.origin_operation_id !== "string" || doc.origin_operation_id.length === 0) return "campaign.origin_operation_id 不是字符串";
  // endpoints：有序、非空、去重、每项 ENDPOINT 形
  if (!Array.isArray(doc.endpoints) || doc.endpoints.length === 0) return "campaign.endpoints 必须非空";
  if (!doc.endpoints.every((e) => typeof e === "string" && EP_SHAPE.test(e))) return "campaign.endpoints 每项必须是 ENDPOINT 形";
  if (!doc.endpoints.every((e, i) => i === 0 || doc.endpoints[i - 1] < e)) return "campaign.endpoints 必须有序去重";
  if (endpointsDigest(doc.endpoints) !== doc.endpoints_digest) return "campaign.endpoints_digest 与 endpoints 摘要不一致";
  // members：键集 === endpoints；每项 schema_version 字面值 + 两计数 ≥0
  // members 键集必须 === endpoints（endpoints 已有序去重，keysOf 也按序，故直接比 join）。
  if (!isObj(doc.members) || keysOf(doc.members) !== doc.endpoints.join(",")) return "campaign.members 键集必须 === endpoints";
  for (const ep of doc.endpoints) {
    const m = doc.members[ep];
    if (!isObj(m)) return "campaign.members[" + ep + "] 不是对象";
    if (keysOf(m) !== "legacy_proof_count,null_b1_count,schema_version") return "campaign.members[" + ep + "] 字段集不对";
    if (!SCHEMA_VALUES.includes(m.schema_version)) return "campaign.members[" + ep + "].schema_version 字面值域外";
    if (!Number.isSafeInteger(m.legacy_proof_count) || m.legacy_proof_count < 0) return "campaign.members[" + ep + "].legacy_proof_count 非 ≥0 整数";
    if (!Number.isSafeInteger(m.null_b1_count) || m.null_b1_count < 0) return "campaign.members[" + ep + "].null_b1_count 非 ≥0 整数";
  }
  // pending_joins：与 endpoints 不交；sealed/complete 时必为 []
  if (!Array.isArray(doc.pending_joins)) return "campaign.pending_joins 不是数组";
  if (doc.state !== "open" && doc.pending_joins.length !== 0) return "sealed/complete 时 pending_joins 必为 []";
  for (const pj of doc.pending_joins) {
    if (!isObj(pj) || keysOf(pj) !== "at,endpoint_id") return "campaign.pending_joins 每项字段集不对";
    if (typeof pj.endpoint_id !== "string" || !EP_SHAPE.test(pj.endpoint_id)) return "campaign.pending_joins.endpoint_id 形状不对";
    if (!isCanonicalIso(pj.at)) return "campaign.pending_joins.at 不规范";
    if (doc.endpoints.includes(pj.endpoint_id)) return "campaign.pending_joins 与 endpoints 不交";
  }
  return null;
}

/** writer-state 文件封闭字段（§二.4）；取值约束同 §一.5 writer_state 联合。 */
export function writerStateProblem(doc) {
  if (!isObj(doc)) return "writer-state 文件不是对象";
  if (keysOf(doc) !== "campaign_id,endpoints_digest,origin_operation_id,revision,schema_version,state")
    return "writer-state 字段集不对";
  if (doc.schema_version !== WRITER_FILE_SCHEMA) return "writer-state.schema_version 不对";
  if (!WRITER_STATES.includes(doc.state)) return "writer-state.state 越界";
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) return "writer-state.revision 不是正整数";
  if (typeof doc.origin_operation_id !== "string" || doc.origin_operation_id.length === 0) return "writer-state.origin_operation_id 不是字符串";
  if (doc.state === "off") {
    if (doc.campaign_id !== null || doc.endpoints_digest !== null) return "off 时 campaign_id/endpoints_digest 必 null";
  } else {
    if (!CAMPAIGN_ID_SHAPE.test(doc.campaign_id)) return "非 off 时 campaign_id 必须 osc_ 形";
    if (doc.state === "on") {
      if (typeof doc.endpoints_digest !== "string" || !SHA_SHAPE.test(doc.endpoints_digest)) return "on 时 endpoints_digest 必 64hex";
    } else {
      if (doc.endpoints_digest !== null && !(typeof doc.endpoints_digest === "string" && SHA_SHAPE.test(doc.endpoints_digest)))
        return "partial 时 endpoints_digest 为 64hex 或 null";
    }
  }
  return null;
}

/* ── 读取器（§二.5）：返回 §一.5 状态联合；缺席 → campaign absent / writer off revision 0；读错/形状错/不自洽 → unreadable ── */

function statFile(file) {
  if (file === null) return { absent: true };
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { absent: false, symlink: true };
    if (st.isDirectory()) return { absent: false, not_regular: true };
    const buf = fs.readFileSync(file);
    return { absent: false, buf, sha256: sha256Of(buf) };
  } catch (err) {
    if (err?.code === "ENOENT") return { absent: true };
    return { absent: false, error: String(err?.code ?? err?.message ?? err) };
  }
}

function readStateFile(file, pathProblem) {
  if (file === null) return { state: "unreadable", problem: "ledger 根不可派生" };
  const st = statFile(file);
  if (st.absent) return { absent: true };
  if (st.symlink) return { state: "unreadable", problem: "目标为符号链接（拒）" };
  if (st.not_regular) return { state: "unreadable", problem: "目标不是普通文件（拒）" };
  if (st.error) return { state: "unreadable", problem: "读取失败：" + st.error };
  // 权限：拒非 0600/0700
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600 && mode !== 0o700) return { state: "unreadable", problem: "权限不是 0600/0700（" + mode.toString(8) + "）" };
  } catch (err) { return { state: "unreadable", problem: "stat 失败：" + String(err?.code ?? err) }; }
  let doc;
  try { doc = JSON.parse(st.buf.toString("utf8")); }
  catch (err) { return { state: "unreadable", problem: "JSON 解析失败：" + String(err?.message ?? err) }; }
  const p = pathProblem(doc);
  if (p) return { state: "unreadable", problem: p };
  return { exists: true, sha256: st.sha256, doc };
}

/** campaign 读取器 → 状态联合。缺席 ⇒ {state:"absent"}; unreadable ⇒ {state:"unreadable", problem}。 */
export function readCampaignState(env = process.env) {
  const file = campaignPathFor(env);
  const found = readStateFile(file, campaignStateProblem);
  if (found.absent) return { exists: false, sha256: null, state: "absent", campaign_id: null, endpoints: null, endpoints_digest: null, doc: null };
  if (!found.exists) return { exists: false, sha256: null, state: found.state === "unreadable" ? "unreadable" : found.state, problem: found.problem, doc: null };
  const d = found.doc;
  return {
    exists: true, sha256: found.sha256,
    state: d.state, campaign_id: d.campaign_id, endpoints: d.endpoints, endpoints_digest: d.endpoints_digest,
    revision: d.revision, origin_operation_id: d.origin_operation_id, doc: d,
  };
}

/** writer-state 读取器 → 状态联合。缺席 ⇒ {state:"off", revision:0}; unreadable ⇒ {state:"unreadable", problem}。 */
export function readWriterState(env = process.env) {
  const file = writerStatePathFor(env);
  const found = readStateFile(file, writerStateProblem);
  if (found.absent) return { exists: false, sha256: null, state: "off", campaign_id: null, endpoints_digest: null, revision: 0, doc: null };
  if (!found.exists) return { exists: false, sha256: null, state: "unreadable", problem: found.problem, doc: null };
  const d = found.doc;
  return {
    exists: true, sha256: found.sha256,
    state: d.state, campaign_id: d.campaign_id, endpoints_digest: d.endpoints_digest,
    revision: d.revision, origin_operation_id: d.origin_operation_id, doc: d,
  };
}

/* ── 写原语（§二.6）：先验文档封闭形；CAS = 现场 {exists,sha256} 必等 expected（null=必须不存在）；原子持久 ── */

function writeStateFile({ file, expectedSha256, doc, problem, revDelta }) {
  if (file === null) return { ok: false, reason: "ledger_root_unresolvable", why: "ledger 根不可派生" };
  const p = problem(doc);
  if (p) return { ok: false, reason: "bad_doc", why: p };
  const before = readStateFile(file, problem);
  if (before.state === "unreadable") return { ok: false, reason: "before_unreadable", why: before.problem };
  const beforeExists = before.absent ? false : before.exists;
  const beforeSha = before.absent ? null : before.sha256;
  // CAS：现场 {exists,sha256} 必等 expected。
  if (expectedSha256 === null ? beforeExists : (!beforeExists || beforeSha !== expectedSha256))
    return { ok: false, reason: "cas_mismatch", why: "现场 " + (beforeExists ? "exists sha=" + beforeSha : "absent") };
  // revision 必 === before.revision + 1（首写 1）。
  const beforeRev = before.absent ? 0 : (before.doc?.revision ?? 0);
  if (doc.revision !== beforeRev + 1) return { ok: false, reason: "revision_mismatch", why: "doc.revision=" + doc.revision + " 但 before.revision=" + beforeRev };
  // 目录 0700 存在性核验（不递归建）。
  const dir = path.dirname(file);
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { ok: false, reason: "dir_not_dir", why: dir };
    if ((st.mode & 0o777) !== 0o700) return { ok: false, reason: "dir_perms", why: dir + " 不是 0700" };
  } catch (err) { return { ok: false, reason: "dir_absent", why: dir + "：" + String(err?.code ?? err) }; }
  // 临时文件 O_EXCL 0600 写满 → fsync → rename → fsync 目录。
  const tmp = path.join(dir, ".owner-select-tmp-" + crypto.randomUUID());
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
    const dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (err) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    return { ok: false, reason: "write_failed", why: String(err?.message ?? err) };
  }
  // 读回受验 === doc（原子持久证明）。
  const back = readStateFile(file, problem);
  if (back.state === "unreadable" || !back.exists || back.sha256 !== crypto.createHash("sha256").update(JSON.stringify(doc, null, 2) + "\n").digest("hex"))
    return { ok: false, reason: "verify_failed", why: "读回后与 doc 不一致" };
  return { ok: true, post: readStateFile(file, problem) };
}

export function writeCampaignState({ env = process.env, expectedSha256 = null, doc } = {}) {
  const r = writeStateFile({ file: campaignPathFor(env), expectedSha256, doc, problem: campaignStateProblem });
  if (!r.ok) return r;
  return { ok: true, post: r.post };
}
export function writeWriterState({ env = process.env, expectedSha256 = null, doc } = {}) {
  const r = writeStateFile({ file: writerStatePathFor(env), expectedSha256, doc, problem: writerStateProblem });
  if (!r.ok) return r;
  return { ok: true, post: r.post };
}
