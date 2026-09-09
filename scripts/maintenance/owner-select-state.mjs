/**
 * R50: owner-select campaign / writer-state 文件合同与读写原语
 * （只做合同与校验器，不做 operation A/B 执行器）
 *
 * 参照设计稿 docs/architecture/owner-select-route.md §8 与 §8.2。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonKey, sha256 } from "./canon.mjs";
import { ledgerRootFor, validateLedgerRoot, REQUEST_KEY_SHAPE } from "../topic-agent-ledger.mjs";
import { acquireLockUngated, commitWhileHeld, releasePublishLock } from "../registry.mjs";
import { isCanonicalIso } from "../canonical-time.mjs";
import { dirFsyncIgnorable } from "./dir-fsync.mjs";
import {
  CAMPAIGN_STATES,
  WRITER_STATES,
  CAMPAIGN_ID_SHAPE,
  campaignIdFor,
  endpointsDigest,
} from "./owner-select-derived.mjs";
import {
  maintenanceDir,
  leasePath,
  readActive,
  readJournal,
  leaseHolder,
  OWNER_SELECT_OPERATION_KINDS,
  OSM_FORWARD_PHASES,
} from "./journal.mjs";
import { maintenanceGatePath, readGate } from "../maintenance-gate-core.mjs";

export {
  readVerifiedDoc,
  CAMPAIGN_STATES,
  WRITER_STATES,
  CAMPAIGN_ID_SHAPE,
  campaignIdFor,
  endpointsDigest,
};

export const CAMPAIGN_FILE = "owner-select-campaign.json";
export const WRITER_STATE_FILE = "owner-select-writer-state.json";
export const CAMPAIGN_SCHEMA = "owner-select-campaign-1";
export const WRITER_STATE_SCHEMA = "owner-select-writer-state-1";
export const MEMBER_SCHEMAS = Object.freeze(["1.0", "1.1-transition", "1.1"]);

export const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
export const SHA_SHAPE = /^[0-9a-f]{64}$/u;
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const MAX_STATE_FILE_BYTES = 1024 * 1024;

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const errCode = (err) => String(err?.code ?? err?.message ?? err);
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export const campaignPath = (env = process.env) => {
  const root = ledgerRootFor(env);
  return root ? path.join(root, CAMPAIGN_FILE) : null;
};

export const writerStatePath = (env = process.env) => {
  const root = ledgerRootFor(env);
  return root ? path.join(root, WRITER_STATE_FILE) : null;
};

/** campaign 文件封闭校验器（§二.3） */
export function campaignDocProblem(doc) {
  if (!isObj(doc)) return "campaign 文档不是对象";
  if (keysOf(doc) !== "campaign_id,endpoints,endpoints_digest,members,origin_operation_id,pending_joins,revision,schema_version,state") {
    return "campaign 字段集不对";
  }
  if (doc.schema_version !== CAMPAIGN_SCHEMA) return "schema_version 不认识: " + doc.schema_version;
  if (typeof doc.campaign_id !== "string" || !CAMPAIGN_ID_SHAPE.test(doc.campaign_id)) {
    return "campaign_id 形状不对: " + doc.campaign_id;
  }
  if (!CAMPAIGN_STATES.includes(doc.state)) return "state 不在受控集合里: " + doc.state;

  if (!Array.isArray(doc.endpoints) || doc.endpoints.length === 0) return "endpoints 必须是非空数组";
  for (let i = 0; i < doc.endpoints.length; i++) {
    const ep = doc.endpoints[i];
    if (typeof ep !== "string" || !ENDPOINT_SHAPE.test(ep)) return "endpoint 形状不对: " + ep;
    if (i > 0 && doc.endpoints[i] <= doc.endpoints[i - 1]) return "endpoints 必须严格有序去重";
  }

  if (typeof doc.endpoints_digest !== "string" || !SHA_SHAPE.test(doc.endpoints_digest)) return "endpoints_digest 形状不对";
  if (doc.endpoints_digest !== endpointsDigest(doc.endpoints)) return "endpoints_digest 不等于 endpoints 的 canonKey 摘要";

  if (!Array.isArray(doc.pending_joins)) return "pending_joins 必须是数组";
  if ((doc.state === "sealed" || doc.state === "complete") && doc.pending_joins.length !== 0) {
    return "sealed/complete 状态下 pending_joins 必须为空数组";
  }
  const pjIds = new Set();
  for (const pj of doc.pending_joins) {
    if (!isObj(pj) || keysOf(pj) !== "at,endpoint_id,init_chain,init_operation_token,init_request_key") {
      return "pending_joins 项字段集不对";
    }
    if (typeof pj.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(pj.endpoint_id)) return "pending_join endpoint_id 形状不对";
    if (!isCanonicalIso(pj.at)) return "pending_join at 不是规范 ISO 时间";
    if (pj.init_chain !== "claude" && pj.init_chain !== "codex") return "pending_join init_chain 必须是 claude 或 codex";
    if (typeof pj.init_request_key !== "string" || !REQUEST_KEY_SHAPE.test(pj.init_request_key)) return "pending_join init_request_key 形状不对";
    if (typeof pj.init_operation_token !== "string" || !UUID_SHAPE.test(pj.init_operation_token)) return "pending_join init_operation_token 不是合法的 operation token";
    if (doc.endpoints.includes(pj.endpoint_id)) return "pending_join 与 committed endpoints 相交: " + pj.endpoint_id;
    if (pjIds.has(pj.endpoint_id)) return "pending_joins 包含重复 endpoint_id: " + pj.endpoint_id;
    pjIds.add(pj.endpoint_id);
  }

  if (!isObj(doc.members)) return "members 必须是对象";
  if (keysOf(doc.members) !== doc.endpoints.join(",")) return "members 键集必须严格等于 committed endpoints";
  for (const ep of doc.endpoints) {
    const m = doc.members[ep];
    if (!isObj(m) || keysOf(m) !== "legacy_proof_count,null_b1_count,schema_version") {
      return "member[" + ep + "] 字段集不对";
    }
    if (!MEMBER_SCHEMAS.includes(m.schema_version)) return "member[" + ep + "].schema_version 不在受控集合: " + m.schema_version;
    if (!Number.isSafeInteger(m.legacy_proof_count) || m.legacy_proof_count < 0) return "member[" + ep + "].legacy_proof_count 必须是非负整数";
    if (!Number.isSafeInteger(m.null_b1_count) || m.null_b1_count < 0) return "member[" + ep + "].null_b1_count 必须是非负整数";
    if (doc.state === "complete") {
      if (m.schema_version !== "1.1" || m.legacy_proof_count !== 0 || m.null_b1_count !== 0) {
        return "campaign complete 状态下所有 member 必须满足 strict 准入条件（schema_version === 1.1 且两计数为 0）: " + ep;
      }
    }
  }

  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) return "revision 必须是正整数";
  if (typeof doc.origin_operation_id !== "string" || !UUID_SHAPE.test(doc.origin_operation_id)) {
    return "origin_operation_id 不是合法的 operation token";
  }
  return null;
}

/** writer-state 文件封闭校验器（§二.4） */
export function writerStateDocProblem(doc) {
  if (!isObj(doc)) return "writer_state 文档不是对象";
  if (keysOf(doc) !== "campaign_id,endpoints_digest,origin_operation_id,revision,schema_version,state") {
    return "writer_state 字段集不对";
  }
  if (doc.schema_version !== WRITER_STATE_SCHEMA) return "schema_version 不认识: " + doc.schema_version;
  if (!WRITER_STATES.includes(doc.state)) return "state 不在受控集合里: " + doc.state;

  if (doc.state === "off") {
    if (doc.campaign_id !== null) return "state 为 off 时 campaign_id 必须为 null";
    if (doc.endpoints_digest !== null) return "state 为 off 时 endpoints_digest 必须为 null";
  } else if (doc.state === "partial") {
    if (typeof doc.campaign_id !== "string" || !CAMPAIGN_ID_SHAPE.test(doc.campaign_id)) {
      return "state 为 partial 时 campaign_id 必须是非 null osc_ 形状";
    }
    if (typeof doc.endpoints_digest !== "string" || !SHA_SHAPE.test(doc.endpoints_digest)) {
      return "state 为 partial 时 endpoints_digest 必须是 64hex";
    }
  } else if (doc.state === "on") {
    if (typeof doc.campaign_id !== "string" || !CAMPAIGN_ID_SHAPE.test(doc.campaign_id)) {
      return "state 为 on 时 campaign_id 必须是非 null osc_ 形状";
    }
    if (typeof doc.endpoints_digest !== "string" || !SHA_SHAPE.test(doc.endpoints_digest)) {
      return "state 为 on 时 endpoints_digest 必须是 64hex";
    }
  }

  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) return "revision 必须是正整数";
  if (typeof doc.origin_operation_id !== "string" || !UUID_SHAPE.test(doc.origin_operation_id)) {
    return "origin_operation_id 不是合法的 operation token";
  }
  return null;
}

function fsyncDir(dir) {
  let dfd = null;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(dfd);
  } catch (err) {
    if (!dirFsyncIgnorable(err?.code)) throw err;
  } finally {
    if (dfd !== null) {
      try { fs.closeSync(dfd); } catch { /* 已关 */ }
    }
  }
}

/** 受验读状态文件：fd 绑定、O_NOFOLLOW、普通文件、单硬链接、mode 恰 0600、≤1MiB、JSON 校验 */
/**
 * fd 绑定有界读原语（#141 P1-3 doctor 读转发制品复用）：O_NOFOLLOW|O_NONBLOCK 打开、同 fd fstat、
 * 普通文件、单硬链接、0600、大小上限（默认 owner-select 状态文件的 1 MiB，doctor 处收窄到 64 KiB）。
 */
function readVerifiedDoc({ file, docValidator, maxBytes = MAX_STATE_FILE_BYTES }) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, absent: true };
    return { ok: false, problem: "open 失败: " + errCode(err) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, problem: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, problem: "硬链接数不为 1" };
    const mode = st.mode & 0o777;
    if (mode !== 0o600) return { ok: false, problem: "mode 不是 0600: " + mode.toString(8) };
    if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, problem: "文件是符号链接" };
    if (st.size > maxBytes) return { ok: false, problem: "文件大小超过上限（" + st.size + " > " + maxBytes + "）" };

    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) return { ok: false, problem: "读不满文件（" + off + "/" + st.size + "）" };
      off += n;
    }
    const sha = sha256Hex(buf);
    let doc = null;
    try {
      doc = JSON.parse(buf.toString("utf-8"));
    } catch (err) {
      return { ok: false, problem: "JSON 解析失败: " + errCode(err) };
    }
    const p = docValidator(doc);
    if (p !== null) return { ok: false, problem: p };
    // P1-6：raw 暴露原始字节（供备份直接用读取器 raw，不再从状态投影重新 JSON 化）；bytes 保持字节长度语义；
    // mtimeMs 同 fd fstat 时间（#141 二轮 P1-4）。
    return { ok: true, doc, sha256: sha, raw: buf, bytes: buf.length, mtimeMs: st.mtimeMs };
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/** 读取 campaign 状态（§二.5）：缺席 ⇒ absent 联合；有错 ⇒ unreadable；合法 ⇒ §一.5 状态联合 */
export function readCampaignState(env = process.env) {
  const rootCheck = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rootCheck.ok) return { state: "unreadable", problem: "ledger 根核验失败: " + rootCheck.reason + (rootCheck.why ? " (" + rootCheck.why + ")" : "") };

  const file = campaignPath(env);
  const res = readVerifiedDoc({ file, docValidator: campaignDocProblem });
  if (!res.ok) {
    if (res.absent) {
      return {
        exists: false,
        sha256: null,
        state: "absent",
        campaign_id: null,
        endpoints: null,
        endpoints_digest: null
      };
    }
    return { state: "unreadable", problem: res.problem };
  }
  return {
    exists: true,
    sha256: res.sha256,
    state: res.doc.state,
    campaign_id: res.doc.campaign_id,
    endpoints: res.doc.endpoints,
    endpoints_digest: res.doc.endpoints_digest,
    revision: res.doc.revision,
    raw: res.raw
  };
}

/** 读取 writer-state 状态（§二.5）：缺席 ⇒ off 联合 revision 0；有错 ⇒ unreadable；合法 ⇒ §一.5 状态联合 */
export function readWriterState(env = process.env) {
  const rootCheck = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rootCheck.ok) return { state: "unreadable", problem: "ledger 根核验失败: " + rootCheck.reason + (rootCheck.why ? " (" + rootCheck.why + ")" : "") };

  const file = writerStatePath(env);
  const res = readVerifiedDoc({ file, docValidator: writerStateDocProblem });
  if (!res.ok) {
    if (res.absent) {
      return {
        exists: false,
        sha256: null,
        state: "off",
        campaign_id: null,
        endpoints_digest: null,
        revision: 0
      };
    }
    return { state: "unreadable", problem: res.problem };
  }
  return {
    exists: true,
    sha256: res.sha256,
    state: res.doc.state,
    campaign_id: res.doc.campaign_id,
    endpoints_digest: res.doc.endpoints_digest,
    revision: res.doc.revision,
    raw: res.raw
  };
}

export function readCampaignDocVerified(env = process.env) {
  const rootCheck = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rootCheck.ok) return { ok: false, problem: "ledger 根核验失败: " + rootCheck.reason + (rootCheck.why ? " (" + rootCheck.why + ")" : "") };
  return readVerifiedDoc({ file: campaignPath(env), docValidator: campaignDocProblem });
}

export function readWriterStateDocVerified(env = process.env) {
  const rootCheck = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rootCheck.ok) return { ok: false, problem: "ledger 根核验失败: " + rootCheck.reason + (rootCheck.why ? " (" + rootCheck.why + ")" : "") };
  return readVerifiedDoc({ file: writerStatePath(env), docValidator: writerStateDocProblem });
}

const OSM_KIND_TO_FORWARD_PHASE = Object.freeze({
  owner_select_migration_a: "osm_a_upgrading",
  owner_select_migration_b: "osm_b_strictening",
  owner_select_migration_direct: "osm_direct",
});

/**
 * 维护窄事务 capability 受验逻辑（PR #135 Codex 二轮 P1-2）:
 * 核 active === token, journal 1.4 journalProblem === null,
 * operation_kind ∈ 三新种, phase ∈ forward 段,
 * stepId 存在且 prepared,
 * step.intended_after 与本次 doc 的投影逐字相等：
 *   - campaign: state, campaign_id, endpoints, endpoints_digest
 *   - writer: state, campaign_id, endpoints_digest, revision
 * step.before.{exists, sha256} === 现场
 */
function verifyMaintenanceCapability({ capability, env, targetKind, doc, beforeExists, beforeSha256, skipLeaseCommit = false, payloadSha = null }) {
  if (!isObj(capability) || typeof capability.token !== "string" || !UUID_SHAPE.test(capability.token) || typeof capability.stepId !== "string" || capability.stepId.length === 0) {
    return { ok: false, reason: "maintenance_capability_required", why: "capability 缺失或形状无效" };
  }

  const mDir = maintenanceDir(env);
  if (!mDir) {
    return { ok: false, reason: "maintenance_capability_required", why: "维护目录取不到" };
  }

  const act = readActive({ dir: mDir });
  if (act.state !== "active" || act.token !== capability.token) {
    return { ok: false, reason: "maintenance_capability_required", why: "active token 不匹配或未处于 active (当前: " + (act.token ?? act.state) + ", 期望: " + capability.token + ")" };
  }

  // gate 校验：gate 文件存在且处于 active，token 与 capability.token 一致
  const gateFile = maintenanceGatePath(env);
  if (typeof gateFile !== "string" || gateFile.length === 0) {
    return { ok: false, reason: "maintenance_capability_required", why: "gate_path_unknown：门位置说不清" };
  }
  const gate = readGate({ file: gateFile, now: Date.now() });
  if (gate.state !== "active") {
    return { ok: false, reason: "maintenance_capability_required", why: "gate_not_active：门未处于 active 状态: " + gate.state + (gate.why ? " (" + gate.why : "") };
  }
  if (gate.payload?.token !== capability.token) {
    return { ok: false, reason: "maintenance_capability_required", why: "gate_token_mismatch：门 token 与 capability 不一致 (门: " + gate.payload?.token + ", 期望: " + capability.token + ")" };
  }

  // lease 校验：租约存在且持有者 pid 存活
  const holder = leaseHolder({ dir: mDir, token: capability.token });
  if (!holder.present) {
    return { ok: false, reason: "maintenance_capability_required", why: "lease_absent：operation 租约不存在" };
  }
  if (holder.unreadable) {
    return { ok: false, reason: "maintenance_capability_required", why: "lease_unreadable：租约读不出：" + holder.why };
  }
  if (!holder.alive) {
    return { ok: false, reason: "maintenance_capability_required", why: "lease_dead：租约持有者 pid " + holder.pid + " 已不在" };
  }
  if (holder.at !== null && !isCanonicalIso(holder.at)) {
    return { ok: false, reason: "maintenance_capability_required", why: "lease_payload_bad：租约 owner.at 不是规范化 ISO" };
  }

  // 证明当前进程持有真实 lease 实例
  if (!skipLeaseCommit) {
    const lpath = leasePath(mDir, capability.token);
    const leaseProof = commitWhileHeld(lpath, () => ({ ok: true }));
    if (!leaseProof.ok || leaseProof.reapUncleared) {
      return {
        ok: false,
        reason: "maintenance_capability_required",
        why: "lease_not_held：本进程未持有 operation 租约实例（" + (leaseProof.reapUncleared ? "lease_reap_uncleared" : (leaseProof.reason ?? "lock_lost")) + "）"
      };
    }
  }

  const jRes = readJournal({ dir: mDir, token: capability.token, env });
  if (jRes.state !== "valid") {
    return { ok: false, reason: "maintenance_capability_required", why: "journal 不是 valid 状态: " + (jRes.why ?? jRes.state) };
  }

  const jDoc = jRes.doc;
  if (jDoc.schema_version !== "1.4") {
    return { ok: false, reason: "maintenance_capability_required", why: "journal schema_version 不是 1.4 (当前: " + jDoc.schema_version + ")" };
  }

  if (!OWNER_SELECT_OPERATION_KINDS.includes(jDoc.operation_kind)) {
    return { ok: false, reason: "maintenance_capability_required", why: "operation_kind 不是 owner_select 三新种之一 (当前: " + jDoc.operation_kind + ")" };
  }

  const expectedPhase = OSM_KIND_TO_FORWARD_PHASE[jDoc.operation_kind];
  if (!OSM_FORWARD_PHASES.includes(jDoc.phase) || jDoc.phase !== expectedPhase) {
    return { ok: false, reason: "maintenance_capability_required", why: "operation 阶段不在 forward 段 (当前 phase: " + jDoc.phase + ", 期望: " + expectedPhase + ")" };
  }

  if (!Array.isArray(jDoc.steps)) {
    return { ok: false, reason: "maintenance_capability_required", why: "journal steps 不是数组" };
  }

  const step = jDoc.steps.find((s) => s.id === capability.stepId);
  if (!step) {
    return { ok: false, reason: "maintenance_capability_required", why: "stepId 不存在: " + capability.stepId };
  }

  if (step.state !== "prepared") {
    return { ok: false, reason: "maintenance_capability_required", why: "step 不是 prepared 状态 (当前: " + step.state + ")" };
  }

  if (targetKind === "campaign") {
    if (step.kind !== "campaign") {
      return { ok: false, reason: "maintenance_capability_required", why: "step kind 不是 campaign (当前: " + step.kind + ")" };
    }
    const ia = step.intended_after;
    if (!isObj(ia) || ia.exists !== true
        || ia.state !== doc.state
        || ia.campaign_id !== doc.campaign_id
        || ia.endpoints_digest !== doc.endpoints_digest
        || canonKey(ia.endpoints) !== canonKey(doc.endpoints)) {
      return { ok: false, reason: "maintenance_capability_required", why: "step intended_after 与本次 campaign doc 投影不匹配" };
    }
    if (payloadSha !== null && (typeof ia.sha256 !== "string" || !SHA_SHAPE.test(ia.sha256) || ia.sha256 !== payloadSha)) {
      return { ok: false, reason: "maintenance_capability_required", why: "step intended_after.sha256 (" + (ia?.sha256 ?? "null") + ") 与 payload sha256 (" + payloadSha + ") 不符" };
    }
  } else if (targetKind === "writer_state") {
    if (step.kind !== "writer_state") {
      return { ok: false, reason: "maintenance_capability_required", why: "step kind 不是 writer_state (当前: " + step.kind + ")" };
    }
    const ia = step.intended_after;
    if (!isObj(ia) || ia.exists !== true
        || ia.state !== doc.state
        || ia.campaign_id !== doc.campaign_id
        || ia.endpoints_digest !== doc.endpoints_digest
        || ia.revision !== doc.revision) {
      return { ok: false, reason: "maintenance_capability_required", why: "step intended_after 与本次 writer-state doc 投影不匹配" };
    }
    if (payloadSha !== null && (typeof ia.sha256 !== "string" || !SHA_SHAPE.test(ia.sha256) || ia.sha256 !== payloadSha)) {
      return { ok: false, reason: "maintenance_capability_required", why: "step intended_after.sha256 (" + (ia?.sha256 ?? "null") + ") 与 payload sha256 (" + payloadSha + ") 不符" };
    }
  } else {
    return { ok: false, reason: "maintenance_capability_required", why: "未知 targetKind: " + targetKind };
  }

  // 核 before 现场
  const stepBeforeExists = Boolean(step.before?.exists);
  const stepBeforeSha = step.before?.sha256 ?? null;
  if (stepBeforeExists !== Boolean(beforeExists) || stepBeforeSha !== (beforeSha256 ?? null)) {
    return { ok: false, reason: "maintenance_capability_required", why: "step before 现场不匹配 (step.before={exists:" + stepBeforeExists + ",sha256:" + stepBeforeSha + "}, 现场={exists:" + beforeExists + ",sha256:" + beforeSha256 + "})" };
  }

  return { ok: true };
}

/**
 * 统一写原语：
 * 锁内 CAS + fenced rename + 落盘前核大小 ≤ 1 MiB + 维护窄事务 capability 受验 + 封闭 commit 联合。
 */
function writeStateFile({ env, expectedSha256, doc, capability, fileName, targetKind, docValidator, formatOutput }) {
  try {
    const prob = docValidator(doc);
    if (prob !== null) return { ok: false, commit: "not_committed", reason: "invalid_doc", why: prob };

    let payload;
    try {
      payload = JSON.stringify(doc, null, 2) + "\n";
    } catch (err) {
      return { ok: false, commit: "not_committed", reason: "invalid_doc", why: "序列化失败: " + errCode(err) };
    }
    const byteLen = Buffer.byteLength(payload, "utf-8");
    if (byteLen > MAX_STATE_FILE_BYTES) {
      return { ok: false, commit: "not_committed", reason: "document_too_large", why: "序列化大小超过 1 MiB（" + byteLen + " 字节）" };
    }
    const payloadSha = sha256(payload);

    const rootVal = validateLedgerRoot({ env, mustExistRoot: true });
    if (!rootVal.ok) {
      return { ok: false, commit: "not_committed", reason: "ledger_root_invalid", why: rootVal.reason };
    }
    const root = rootVal.root;

    if (!capability) {
      return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "capability 缺失" };
    }
    if (!isObj(capability) || typeof capability.token !== "string" || !UUID_SHAPE.test(capability.token) || typeof capability.stepId !== "string" || capability.stepId.length === 0) {
      return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "capability 形状无效" };
    }

    const mDir = maintenanceDir(env);
    if (!mDir) {
      return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "维护目录取不到" };
    }
    const holder = leaseHolder({ dir: mDir, token: capability.token });
    if (!holder.present) {
      return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "lease_absent：operation 租约不存在" };
    }
    const lpath = leasePath(mDir, capability.token);
    const leaseProof = commitWhileHeld(lpath, () => ({ ok: true }));
    if (!leaseProof.ok || leaseProof.reapUncleared) {
      return {
        ok: false,
        commit: "not_committed",
        reason: "maintenance_capability_required",
        why: "lease_not_held：本进程未持有 operation 租约实例（" + (leaseProof.reapUncleared ? "lease_reap_uncleared" : (leaseProof.reason ?? "lock_lost")) + "）",
      };
    }

    const lockDir = path.join(root, "owner-select-state.lock");
    const lock = acquireLockUngated(lockDir, { reapUnrecognized: false });
    if (lock.ok !== true) {
      const reason = lock.reason === "publisher_busy" ? "lock_busy" : String(lock.reason ?? "lock_busy");
      return { ok: false, commit: "not_committed", reason, why: String(lock.why ?? lock.reason ?? ""), lock: lockDir };
    }

    let renameLanded = false;
    let lockReleased = false;
    let lockResidue = null;

    const finalizeLockOnce = () => {
      if (lockReleased) return lockResidue;
      lockReleased = true;
      try {
        const rel = releasePublishLock(lockDir, { expectedToken: lock.token });
        const residue = rel.ok !== true ? String(rel.reason ?? "release_publish_lock") : rel.absent === true ? "absent" : rel.reapUncleared ? "reap_uncleared" : null;
        if (residue !== null) {
          lockResidue = residue;
        }
      } catch (err) {
        lockResidue = "lock_release_throw: " + errCode(err);
      }
      return lockResidue;
    };

    const exitWithLock = (res) => {
      const residue = finalizeLockOnce();
      if (residue !== null) {
        if (renameLanded) {
          return { ...res, ok: false, commit: "lock_residue", reason: "lock_release_residue", why: residue, lock: lockDir, target: fileName };
        }
        return { ...res, ok: false, commit: "not_committed", reason: res.reason, why: res.why, lockResidue: residue, lock: lockDir };
      }
      return res;
    };

    let cleanupTmp = () => {};
    let tmpResidue = null;

    try {
      const targetFile = path.join(root, fileName);
      const cur = readVerifiedDoc({ file: targetFile, docValidator });
      if (!cur.ok && !cur.absent) {
        return exitWithLock({ ok: false, commit: "not_committed", reason: "current_unreadable", why: cur.problem });
      }

      const beforeExists = cur.ok === true;
      const beforeSha = beforeExists ? cur.sha256 : null;
      const beforeRevision = beforeExists ? cur.doc.revision : 0;

      if (expectedSha256 === null) {
        if (beforeExists) {
          return exitWithLock({ ok: false, commit: "not_committed", reason: "cas_mismatch", why: "期望文件缺席，实际已存在" });
        }
      } else {
        if (!beforeExists || beforeSha !== expectedSha256) {
          return exitWithLock({ ok: false, commit: "not_committed", reason: "cas_mismatch", why: "期望 sha (" + expectedSha256 + ") 与当前 (" + beforeSha + ") 不匹配" });
        }
      }

      if (doc.revision !== beforeRevision + 1) {
        return exitWithLock({ ok: false, commit: "not_committed", reason: "revision_mismatch", why: "doc.revision (" + doc.revision + ") 必须等于 before.revision + 1 (" + (beforeRevision + 1) + ")" });
      }

      // 核验 maintenance capability（窄事务）
      const capCheck = verifyMaintenanceCapability({ capability, env, targetKind, doc, beforeExists, beforeSha256: beforeSha, payloadSha });
      if (!capCheck.ok) {
        return exitWithLock({ ok: false, commit: "not_committed", reason: capCheck.reason, why: capCheck.why });
      }

      const tmpName = "." + fileName + ".tmp." + process.pid + "." + crypto.randomBytes(8).toString("hex");
      const tmpPath = path.join(root, tmpName);
      let fd = null;
      let tmpCreated = false;
      cleanupTmp = () => {
        if (!tmpCreated) return;
        try {
          fs.unlinkSync(tmpPath);
          tmpCreated = false;
        } catch (uErr) {
          if (uErr && uErr.code === "ENOENT") {
            tmpCreated = false;
            return;
          }
          tmpResidue = { path: tmpPath, reason: "tmp_unlink_failed", why: errCode(uErr) };
        }
      };

      try {
        fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        tmpCreated = true;
        fs.fchmodSync(fd, 0o600);
        const wst = fs.fstatSync(fd);
        if (!wst.isFile() || wst.nlink !== 1 || (wst.mode & 0o777) !== 0o600) {
          try { fs.closeSync(fd); fd = null; } catch { /* 已关 */ }
          cleanupTmp();
          const out = { ok: false, commit: "not_committed", reason: "tmp_file_invalid", why: "tmp 文件属性异常" };
          if (tmpResidue) out.residue = tmpResidue;
          return exitWithLock(out);
        }
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } catch (err) {
        if (fd !== null) {
          try { fs.closeSync(fd); fd = null; } catch { /* 已关 */ }
        }
        cleanupTmp();
        const out = { ok: false, commit: "not_committed", reason: "tmp_write_failed", why: errCode(err) };
        if (tmpResidue) out.residue = tmpResidue;
        return exitWithLock(out);
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* 已关 */ }
        }
      }

      let fenceErr = null;
      let fenceCapReason = null;
      let fenceCapWhy = null;
      const mDir = maintenanceDir(env);
      const lpath = mDir && capability?.token ? leasePath(mDir, capability.token) : null;

      const fenced = commitWhileHeld(lockDir, () => {
        if (!lpath) {
          fenceCapReason = "maintenance_capability_required";
          fenceCapWhy = "维护目录不可用或 token 无效";
          return;
        }
        const leaseFence = commitWhileHeld(lpath, () => {
          // 提交栅栏内用 commitWhileHeld 证明本进程持有真实 lease 实例并重读 active / gate / journal
          const recheck = verifyMaintenanceCapability({
            capability,
            env,
            targetKind,
            doc,
            beforeExists,
            beforeSha256: beforeSha,
            skipLeaseCommit: true,
            payloadSha,
          });
          if (!recheck.ok) {
            fenceCapReason = recheck.reason;
            fenceCapWhy = recheck.why;
            return;
          }
          try {
            fs.renameSync(tmpPath, targetFile);
            renameLanded = true;
            tmpCreated = false;
          } catch (err) {
            fenceErr = err;
          }
        });
        if (!leaseFence.ok || leaseFence.reapUncleared) {
          if (!fenceCapReason) {
            fenceCapReason = "maintenance_capability_required";
            fenceCapWhy = "提交栅栏内本进程未持有 operation 租约实例: " + (leaseFence.reapUncleared ? "lease_reap_uncleared" : (leaseFence.reason ?? "lock_lost"));
          }
        }
      });

      if (fenceCapReason !== null) {
        cleanupTmp();
        if (renameLanded) {
          return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: fenceCapReason, why: fenceCapWhy });
        }
        const out = { ok: false, commit: "not_committed", reason: fenceCapReason, why: fenceCapWhy };
        if (tmpResidue) out.residue = tmpResidue;
        return exitWithLock(out);
      }

      if (!fenced.ok || fenceErr !== null) {
        cleanupTmp();
        if (renameLanded) {
          return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: "fenced_commit_failed", why: String(fenced.reason ?? fenceErr) });
        }
        const out = { ok: false, commit: "not_committed", reason: "rename_failed", why: String(fenced.reason ?? fenceErr) };
        if (tmpResidue) out.residue = tmpResidue;
        return exitWithLock(out);
      }

      try {
        fsyncDir(root);
      } catch (err) {
        return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: "dir_fsync_failed", why: errCode(err) });
      }

      const readBack = readVerifiedDoc({ file: targetFile, docValidator });
      if (!readBack.ok || canonKey(readBack.doc) !== canonKey(doc) || readBack.sha256 !== payloadSha) {
        return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: "readback_failed", why: readBack.problem ?? "读回内容或 SHA 与写入 doc 不一致" });
      }

      const residue = finalizeLockOnce();
      if (residue !== null) {
        return { ok: false, commit: "lock_residue", reason: "lock_release_residue", why: residue, lock: lockDir, target: fileName };
      }

      return formatOutput(readBack);
    } catch (innerErr) {
      cleanupTmp();
      const residue = finalizeLockOnce();
      if (renameLanded) {
        if (residue !== null) {
          return { ok: false, commit: "lock_residue", reason: "lock_release_residue", why: residue, lock: lockDir, target: fileName };
        }
        return { ok: false, commit: "committed_durability_uncertain", reason: "io_error", why: errCode(innerErr) };
      }
      const out = { ok: false, commit: "not_committed", reason: "io_error", why: errCode(innerErr) };
      if (tmpResidue) out.residue = tmpResidue;
      return exitWithLock(out);
    }
  } catch (outerErr) {
    return { ok: false, commit: "not_committed", reason: "unexpected_error", why: errCode(outerErr) };
  }
}

/**
 * 写 campaign 状态（§二.6 与 PR #135 P1-2/P1-3）：
 * 锁内 CAS；revision === before.revision + 1；落盘前核 ≤ 1 MiB；
 * 维护窄事务 capability 受验；
 * 临时文件 O_EXCL 0600 写满 fsync → fenced rename → fsync 目录 → 读回受验；
 * 返回封闭联合 commit ∈ {not_committed, committed, committed_durability_uncertain, lock_residue}。
 */
export function writeCampaignState({ env = process.env, expectedSha256 = null, doc, capability }) {
  return writeStateFile({
    env,
    expectedSha256,
    doc,
    capability,
    fileName: CAMPAIGN_FILE,
    targetKind: "campaign",
    docValidator: campaignDocProblem,
    formatOutput: (rb) => ({
      ok: true,
      commit: "committed",
      exists: true,
      sha256: rb.sha256,
      state: rb.doc.state,
      campaign_id: rb.doc.campaign_id,
      endpoints: rb.doc.endpoints,
      endpoints_digest: rb.doc.endpoints_digest
    })
  });
}

/**
 * 写 writer-state 状态（§二.6 与 PR #135 P1-2/P1-3）：
 * 锁内 CAS；revision === before.revision + 1；落盘前核 ≤ 1 MiB；
 * 维护窄事务 capability 受验；
 * 临时文件 O_EXCL 0600 写满 fsync → fenced rename → fsync 目录 → 读回受验；
 * 返回封闭联合 commit ∈ {not_committed, committed, committed_durability_uncertain, lock_residue}。
 */
export function writeWriterState({ env = process.env, expectedSha256 = null, doc, capability }) {
  return writeStateFile({
    env,
    expectedSha256,
    doc,
    capability,
    fileName: WRITER_STATE_FILE,
    targetKind: "writer_state",
    docValidator: writerStateDocProblem,
    formatOutput: (rb) => ({
      ok: true,
      commit: "committed",
      exists: true,
      sha256: rb.sha256,
      state: rb.doc.state,
      campaign_id: rb.doc.campaign_id,
      endpoints_digest: rb.doc.endpoints_digest,
      revision: rb.doc.revision
    })
  });
}

/**
 * 跨文件准入读取器 readOwnerSelectAdmission(env)（PR #135 一轮 P1-6 回带）：
 * 供 W1/W2/reaffirm 与 R52 使用。
 *
 * 判别规则：
 *   · on ⇔ writer-state on ∧ campaign complete ∧ 同 campaign_id ∧ digest 相等 ∧ 全 member strict；
 *   · partial ⇔ writer-state partial ∧ campaign open|sealed ∧ 同 campaign_id；
 *   · off ⇔ 两文件缺席，或 writer off 且 campaign 缺席；
 *   · 任一不自洽 / 损坏 → { state: "unreadable", problem }。
 */
export function readOwnerSelectAdmission(env = process.env) {
  const rootVal = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rootVal.ok) return { state: "unreadable", problem: "ledger 根核验失败: " + rootVal.reason + (rootVal.why ? " (" + rootVal.why + ")" : "") };

  const cRes = readCampaignDocVerified(env);
  const wRes = readWriterStateDocVerified(env);

  if (!cRes.ok && !cRes.absent) return { state: "unreadable", problem: "campaign unreadable: " + cRes.problem };
  if (!wRes.ok && !wRes.absent) return { state: "unreadable", problem: "writer_state unreadable: " + wRes.problem };

  const cAbsent = cRes.absent === true;
  const wAbsent = wRes.absent === true;

  if (cAbsent && wAbsent) {
    return { state: "off" };
  }

  if (cAbsent && !wAbsent) {
    if (wRes.doc.state === "off") {
      return { state: "off" };
    }
    return { state: "unreadable", problem: "writer 为 " + wRes.doc.state + " 但 campaign 缺席" };
  }

  if (!cAbsent && wAbsent) {
    return { state: "unreadable", problem: "campaign 为 " + cRes.doc.state + " 但 writer 缺席" };
  }

  const cDoc = cRes.doc;
  const wDoc = wRes.doc;

  if (wDoc.state === "on") {
    if (cDoc.state !== "complete") {
      return { state: "unreadable", problem: "writer 为 on 但 campaign 不处于 complete（当前：" + cDoc.state + "）" };
    }
    if (wDoc.campaign_id !== cDoc.campaign_id) {
      return { state: "unreadable", problem: "campaign_id 不匹配（writer: " + wDoc.campaign_id + ", campaign: " + cDoc.campaign_id + "）" };
    }
    if (wDoc.endpoints_digest !== cDoc.endpoints_digest) {
      return { state: "unreadable", problem: "endpoints_digest 不匹配" };
    }
    for (const ep of cDoc.endpoints) {
      const m = cDoc.members[ep];
      if (!m || m.schema_version !== "1.1" || m.legacy_proof_count !== 0 || m.null_b1_count !== 0) {
        return { state: "unreadable", problem: "member 不满足 strict 准入条件: " + ep };
      }
    }
    return {
      state: "on",
      campaign_id: wDoc.campaign_id,
      endpoints_digest: wDoc.endpoints_digest,
      endpoints: cDoc.endpoints,
      revision: wDoc.revision
    };
  }

  if (wDoc.state === "partial") {
    if (cDoc.state !== "open" && cDoc.state !== "sealed") {
      return { state: "unreadable", problem: "writer 为 partial 但 campaign 不是 open/sealed（当前：" + cDoc.state + "）" };
    }
    if (wDoc.campaign_id !== cDoc.campaign_id) {
      return { state: "unreadable", problem: "campaign_id 不匹配" };
    }
    if (wDoc.endpoints_digest !== null && wDoc.endpoints_digest !== cDoc.endpoints_digest) {
      return { state: "unreadable", problem: "endpoints_digest 不匹配" };
    }
    return {
      state: "partial",
      campaign_id: wDoc.campaign_id,
      campaign_state: cDoc.state,
      endpoints_digest: wDoc.endpoints_digest,
      endpoints: cDoc.endpoints,
      revision: wDoc.revision
    };
  }

  if (wDoc.state === "off") {
    return { state: "unreadable", problem: "writer 为 off 但 campaign 处于 " + cDoc.state };
  }

  return { state: "unreadable", problem: "未知状态组合" };
}
