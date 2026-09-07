/**
 * R50: owner-select campaign / writer-state 文件合同与读写原语
 * （只做合同与校验器，不做 operation A/B 执行器）
 *
 * 参照设计稿 docs/architecture/owner-select-route.md §8 与 §8.2。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonKey, sha256, ledgerRootFor, validateLedgerRoot } from "../topic-agent-ledger.mjs";
import { acquireLockUngated, commitWhileHeld, releasePublishLock } from "../registry.mjs";
import { isCanonicalIso } from "../canonical-time.mjs";
import { dirFsyncIgnorable } from "./dir-fsync.mjs";

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
    if (!isObj(pj) || keysOf(pj) !== "at,endpoint_id,init_chain,init_operation_token,init_request_key") {
      return "pending_joins 项字段集不对";
    }
    if (typeof pj.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(pj.endpoint_id)) return "pending_join endpoint_id 形状不对";
    if (!isCanonicalIso(pj.at)) return "pending_join at 不是规范 ISO 时间";
    if (typeof pj.init_chain !== "string" || pj.init_chain.length === 0) return "pending_join init_chain 必须是非空字符串";
    if (typeof pj.init_request_key !== "string" || pj.init_request_key.length === 0) return "pending_join init_request_key 必须是非空字符串";
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
        return "campaign complete 状态下所有 member 必须 schema_version === 1.1 且两计数为 0: " + ep;
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
    if (mode !== 0o600) return { ok: false, problem: "mode 不是 0600: " + mode.toString(8) };
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
    endpoints_digest: res.doc.endpoints_digest
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
    revision: res.doc.revision
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

/**
 * 统一写原语：
 * 锁内 CAS + fenced rename + 落盘前核大小 ≤ 1 MiB + 封闭 commit 联合。
 */
function writeStateFile({ env, expectedSha256, doc, fileName, docValidator, formatOutput }) {
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

    const rootVal = validateLedgerRoot({ env, mustExistRoot: true });
    if (!rootVal.ok) {
      return { ok: false, commit: "not_committed", reason: "ledger_root_invalid", why: rootVal.reason };
    }
    const root = rootVal.root;

    const lockDir = path.join(root, "owner-select-state.lock");
    const lock = acquireLockUngated(lockDir, { reapUnrecognized: false });
    if (lock.ok !== true) {
      const reason = lock.reason === "publisher_busy" ? "lock_busy" : String(lock.reason ?? "lock_busy");
      return { ok: false, commit: "not_committed", reason, why: String(lock.why ?? lock.reason ?? ""), lock: lockDir };
    }

    const releaseSafe = () => releasePublishLock(lockDir, { expectedToken: lock.token });

    let renameLanded = false;

    const exitWithLock = (res) => {
      const rel = releaseSafe();
      const residue = rel.ok !== true ? String(rel.reason ?? "release_publish_lock") : rel.absent === true ? "absent" : rel.reapUncleared ? "reap_uncleared" : null;
      if (residue !== null) {
        return { ok: false, commit: "lock_residue", reason: "lock_release_residue", why: residue, lock: lockDir, target: fileName };
      }
      return res;
    };

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

      const tmpName = "." + fileName + ".tmp." + process.pid + "." + crypto.randomBytes(8).toString("hex");
      const tmpPath = path.join(root, tmpName);
      let fd = null;
      try {
        fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.fchmodSync(fd, 0o600);
        const wst = fs.fstatSync(fd);
        if (!wst.isFile() || wst.nlink !== 1 || (wst.mode & 0o777) !== 0o600) {
          return exitWithLock({ ok: false, commit: "not_committed", reason: "tmp_file_invalid", why: "tmp 文件属性异常" });
        }
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } catch (err) {
        return exitWithLock({ ok: false, commit: "not_committed", reason: "tmp_write_failed", why: errCode(err) });
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* 已关 */ }
        }
      }

      let fenceErr = null;
      const fenced = commitWhileHeld(lockDir, () => {
        try {
          fs.renameSync(tmpPath, targetFile);
          renameLanded = true;
        } catch (err) {
          fenceErr = err;
        }
      });

      if (!fenced.ok || fenceErr !== null) {
        try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
        if (renameLanded) {
          return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: "fenced_commit_failed", why: String(fenced.reason ?? fenceErr) });
        }
        return exitWithLock({ ok: false, commit: "not_committed", reason: "rename_failed", why: String(fenced.reason ?? fenceErr) });
      }

      try {
        fsyncDir(root);
      } catch (err) {
        return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: "dir_fsync_failed", why: errCode(err) });
      }

      const readBack = readVerifiedDoc({ file: targetFile, docValidator });
      if (!readBack.ok || canonKey(readBack.doc) !== canonKey(doc)) {
        return exitWithLock({ ok: false, commit: "committed_durability_uncertain", reason: "readback_failed", why: readBack.problem ?? "读回内容与写入 doc 不一致" });
      }

      const rel = releaseSafe();
      const residue = rel.ok !== true ? String(rel.reason ?? "release_publish_lock") : rel.absent === true ? "absent" : rel.reapUncleared ? "reap_uncleared" : null;
      if (residue !== null) {
        return { ok: false, commit: "lock_residue", reason: "lock_release_residue", why: residue, lock: lockDir, target: fileName };
      }

      return formatOutput(readBack);
    } catch (innerErr) {
      return exitWithLock({ ok: false, commit: renameLanded ? "committed_durability_uncertain" : "not_committed", reason: "io_error", why: errCode(innerErr) });
    }
  } catch (outerErr) {
    return { ok: false, commit: "not_committed", reason: "unexpected_error", why: errCode(outerErr) };
  }
}

/**
 * 写 campaign 状态（§二.6 与 PR #135 P1-2/P1-3）：
 * 锁内 CAS；revision === before.revision + 1；落盘前核 ≤ 1 MiB；
 * 临时文件 O_EXCL 0600 写满 fsync → fenced rename → fsync 目录 → 读回受验；
 * 返回封闭联合 commit ∈ {not_committed, committed, committed_durability_uncertain, lock_residue}。
 */
export function writeCampaignState({ env = process.env, expectedSha256 = null, doc }) {
  return writeStateFile({
    env,
    expectedSha256,
    doc,
    fileName: CAMPAIGN_FILE,
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
 * 临时文件 O_EXCL 0600 写满 fsync → fenced rename → fsync 目录 → 读回受验；
 * 返回封闭联合 commit ∈ {not_committed, committed, committed_durability_uncertain, lock_residue}。
 */
export function writeWriterState({ env = process.env, expectedSha256 = null, doc }) {
  return writeStateFile({
    env,
    expectedSha256,
    doc,
    fileName: WRITER_STATE_FILE,
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
