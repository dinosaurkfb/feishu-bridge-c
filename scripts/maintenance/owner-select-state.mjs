/**
 * R50: owner-select campaign / writer-state 文件合同与读写原语
 * （只做合同与校验器，不做 operation A/B 执行器）
 *
 * 参照设计稿 docs/architecture/owner-select-route.md §8 与 §8.2。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonKey, sha256, ledgerRootFor } from "../topic-agent-ledger.mjs";
import { dirFsyncIgnorable } from "./journal.mjs";

export const CAMPAIGN_FILE = "owner-select-campaign.json";
export const WRITER_STATE_FILE = "owner-select-writer-state.json";
export const CAMPAIGN_SCHEMA = "owner-select-campaign-1";
export const WRITER_STATE_SCHEMA = "owner-select-writer-state-1";
export const CAMPAIGN_STATES = Object.freeze(["open", "sealed", "complete"]);
export const WRITER_STATES = Object.freeze(["off", "partial", "on"]);
export const MEMBER_SCHEMAS = Object.freeze(["1.0", "1.1-transition", "1.1"]);

export const CAMPAIGN_ID_SHAPE = /^osc_[0-9a-f]{32}$/u;
export const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
export const SHA_SHAPE = /^[0-9a-f]{64}$/u;
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const MAX_STATE_FILE_BYTES = 1024 * 1024;

const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const errCode = (err) => String(err?.code ?? err?.message ?? err);
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** campaignId 派生公式（§二.1）："osc_" + sha256(canonKey({domain:"owner_select_campaign_v1", token})).slice(0,32) */
export const campaignIdFor = (token) =>
  "osc_" + sha256(canonKey({ domain: "owner_select_campaign_v1", token })).slice(0, 32);

/** endpointsDigest 派生公式（§二.1）：sha256(canonKey(endpoints))（endpoints 已排序去重） */
export const endpointsDigest = (endpoints) => {
  if (!Array.isArray(endpoints)) throw new Error("endpoints 必须是数组");
  return sha256(canonKey(endpoints));
};

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
    if (!isObj(pj) || keysOf(pj) !== "at,endpoint_id") return "pending_joins 项字段集不对";
    if (typeof pj.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(pj.endpoint_id)) return "pending_join endpoint_id 形状不对";
    if (!isCanonicalIso(pj.at)) return "pending_join at 不是规范 ISO 时间";
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
    if (doc.endpoints_digest !== null && (typeof doc.endpoints_digest !== "string" || !SHA_SHAPE.test(doc.endpoints_digest))) {
      return "state 为 partial 时 endpoints_digest 必须是 64hex 或 null";
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

/** 受验读状态文件：fd 绑定、O_NOFOLLOW、普通文件、单硬链接、mode 0600/0700、≤1MiB、JSON 校验 */
function readVerifiedDoc({ file, docValidator }) {
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
    if (mode !== 0o600 && mode !== 0o700) return { ok: false, problem: "mode 不是 0600/0700: " + mode.toString(8) };
    if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, problem: "文件是符号链接" };
    if (st.size > MAX_STATE_FILE_BYTES) return { ok: false, problem: "文件大小超过上限（" + st.size + " > " + MAX_STATE_FILE_BYTES + "）" };

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
    return { ok: true, doc, sha256: sha, bytes: buf.length };
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/** 校验父 ledger 目录：存在、目录、非 symlink、0700 */
function checkLedgerRoot(root) {
  if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) {
    return { ok: false, problem: "ledgerRoot 不是绝对路径" };
  }
  try {
    const st = fs.lstatSync(root);
    if (st.isSymbolicLink()) return { ok: false, problem: "ledger 根是符号链接" };
    if (!st.isDirectory()) return { ok: false, problem: "ledger 根不是目录" };
    if ((st.mode & 0o777) !== 0o700) return { ok: false, problem: "ledger 根 mode 不是 0700: " + (st.mode & 0o777).toString(8) };
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: "ledger 根核验失败: " + errCode(err) };
  }
}

/** 读取 campaign 状态（§二.5）：缺席 ⇒ absent 联合；有错 ⇒ unreadable；合法 ⇒ §一.5 状态联合 */
export function readCampaignState(env = process.env) {
  const root = ledgerRootFor(env);
  const rootCheck = checkLedgerRoot(root);
  if (!rootCheck.ok) return { state: "unreadable", problem: rootCheck.problem };

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
    endpoints_digest: res.doc.endpoints_digest
  };
}

/** 读取 writer-state 状态（§二.5）：缺席 ⇒ off 联合 revision 0；有错 ⇒ unreadable；合法 ⇒ §一.5 状态联合 */
export function readWriterState(env = process.env) {
  const root = ledgerRootFor(env);
  const rootCheck = checkLedgerRoot(root);
  if (!rootCheck.ok) return { state: "unreadable", problem: rootCheck.problem };

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
    revision: res.doc.revision
  };
}

export function readCampaignDocVerified(env = process.env) {
  const root = ledgerRootFor(env);
  const rootCheck = checkLedgerRoot(root);
  if (!rootCheck.ok) return { ok: false, problem: rootCheck.problem };
  return readVerifiedDoc({ file: campaignPath(env), docValidator: campaignDocProblem });
}

export function readWriterStateDocVerified(env = process.env) {
  const root = ledgerRootFor(env);
  const rootCheck = checkLedgerRoot(root);
  if (!rootCheck.ok) return { ok: false, problem: rootCheck.problem };
  return readVerifiedDoc({ file: writerStatePath(env), docValidator: writerStateDocProblem });
}

/**
 * 写 campaign 状态（§二.6）：
 * 先校验 doc 封闭形；CAS 核验现场 {exists, sha256}；revision === before.revision + 1；
 * 临时文件 O_EXCL 0600 写满 fsync → rename → fsync 目录 → 读回受验；返回写后状态联合。
 */
export function writeCampaignState({ env = process.env, expectedSha256 = null, doc }) {
  const prob = campaignDocProblem(doc);
  if (prob !== null) return { ok: false, reason: "invalid_doc", why: prob };

  const root = ledgerRootFor(env);
  const rootCheck = checkLedgerRoot(root);
  if (!rootCheck.ok) return { ok: false, reason: "ledger_root_invalid", why: rootCheck.problem };

  const cur = readCampaignDocVerified(env);
  if (!cur.ok && !cur.absent) return { ok: false, reason: "current_unreadable", why: cur.problem };

  const beforeExists = cur.ok === true;
  const beforeSha = beforeExists ? cur.sha256 : null;
  const beforeRevision = beforeExists ? cur.doc.revision : 0;

  if (expectedSha256 === null) {
    if (beforeExists) return { ok: false, reason: "cas_mismatch", why: "期望文件缺席，实际已存在" };
  } else {
    if (!beforeExists || beforeSha !== expectedSha256) {
      return { ok: false, reason: "cas_mismatch", why: "期望 sha (" + expectedSha256 + ") 与当前 (" + beforeSha + ") 不匹配" };
    }
  }

  if (doc.revision !== beforeRevision + 1) {
    return { ok: false, reason: "revision_mismatch", why: "doc.revision (" + doc.revision + ") 必须等于 before.revision + 1 (" + (beforeRevision + 1) + ")" };
  }

  const targetFile = campaignPath(env);
  const tmpName = "." + CAMPAIGN_FILE + ".tmp." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  const tmpPath = path.join(root, tmpName);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  }

  try {
    fs.renameSync(tmpPath, targetFile);
    fsyncDir(root);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    return { ok: false, reason: "rename_failed", why: errCode(err) };
  }

  const readBack = readCampaignDocVerified(env);
  if (!readBack.ok || canonKey(readBack.doc) !== canonKey(doc)) {
    return { ok: false, reason: "readback_failed", why: readBack.problem ?? "读回内容与写入 doc 不一致" };
  }
  return {
    ok: true,
    exists: true,
    sha256: readBack.sha256,
    state: readBack.doc.state,
    campaign_id: readBack.doc.campaign_id,
    endpoints: readBack.doc.endpoints,
    endpoints_digest: readBack.doc.endpoints_digest
  };
}

/**
 * 写 writer-state 状态（§二.6）：
 * 先校验 doc 封闭形；CAS 核验现场 {exists, sha256}；revision === before.revision + 1；
 * 临时文件 O_EXCL 0600 写满 fsync → rename → fsync 目录 → 读回受验；返回写后状态联合。
 */
export function writeWriterState({ env = process.env, expectedSha256 = null, doc }) {
  const prob = writerStateDocProblem(doc);
  if (prob !== null) return { ok: false, reason: "invalid_doc", why: prob };

  const root = ledgerRootFor(env);
  const rootCheck = checkLedgerRoot(root);
  if (!rootCheck.ok) return { ok: false, reason: "ledger_root_invalid", why: rootCheck.problem };

  const cur = readWriterStateDocVerified(env);
  if (!cur.ok && !cur.absent) return { ok: false, reason: "current_unreadable", why: cur.problem };

  const beforeExists = cur.ok === true;
  const beforeSha = beforeExists ? cur.sha256 : null;
  const beforeRevision = beforeExists ? cur.doc.revision : 0;

  if (expectedSha256 === null) {
    if (beforeExists) return { ok: false, reason: "cas_mismatch", why: "期望文件缺席，实际已存在" };
  } else {
    if (!beforeExists || beforeSha !== expectedSha256) {
      return { ok: false, reason: "cas_mismatch", why: "期望 sha (" + expectedSha256 + ") 与当前 (" + beforeSha + ") 不匹配" };
    }
  }

  if (doc.revision !== beforeRevision + 1) {
    return { ok: false, reason: "revision_mismatch", why: "doc.revision (" + doc.revision + ") 必须等于 before.revision + 1 (" + (beforeRevision + 1) + ")" };
  }

  const targetFile = writerStatePath(env);
  const tmpName = "." + WRITER_STATE_FILE + ".tmp." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  const tmpPath = path.join(root, tmpName);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  }

  try {
    fs.renameSync(tmpPath, targetFile);
    fsyncDir(root);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    return { ok: false, reason: "rename_failed", why: errCode(err) };
  }

  const readBack = readWriterStateDocVerified(env);
  if (!readBack.ok || canonKey(readBack.doc) !== canonKey(doc)) {
    return { ok: false, reason: "readback_failed", why: readBack.problem ?? "读回内容与写入 doc 不一致" };
  }
  return {
    ok: true,
    exists: true,
    sha256: readBack.sha256,
    state: readBack.doc.state,
    campaign_id: readBack.doc.campaign_id,
    endpoints_digest: readBack.doc.endpoints_digest,
    revision: readBack.doc.revision
  };
}

export function readOwnerSelectAdmission(env = process.env) {
  return null;
}
