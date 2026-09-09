/**
 * R57b 返修五：selection plan sidecar（叶子模块，无反向依赖）。
 *   真实 claim 写方（inbound / codex-inbound 两链）在 rfH 支账本提交前，把本次选择的计划持久化为
 *   claims/<key>.selection-plan.json；repair（control-committed-unclean 恢复）读回它做三方逐字绑定
 *   （plan / uncleanRecord / 账本 op 的 target_id 逐字一致）。无 plan 或目标不一致 → 不转 consumed。
 *
 *   计划键集（与 R57d B 段 plan 同形）：action / target_id / basis / handle / kind / cas。其中
 *   cas（compare-and-set 上下文）在 rfH 支为 { intent_id, expected_expires_at }（绑定本次所见 intent）。
 *
 *   写原语（同侧 sidecar 纪律）：临时文件 O_CREAT|O_EXCL 0600 → fstat 核普通文件/单硬链接/0600 →
 *   fsync 写端 fd → rename → fsync 父目录 → 受验读回（fd 绑定：O_NOFOLLOW|O_NONBLOCK、fstat 核
 *   0600/单硬链接/大小上限、JSON 封闭 schema、逐字节等）。失败 fail-closed（写失败 = 不进账本提交）。
 *
 *   注意：本模块只做 sidecar 持久化，不读环境变量、不碰账本、不 import 任何可能反向依赖本模块的模块。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isObj, canonKey, sha256 } from "./maintenance/canon.mjs";
import { ID_SHAPE, REAFFIRM_HANDLE_SHAPE } from "./topic-agent-ledger.mjs";

export const SELECTION_PLAN_SCHEMA = "selection-plan-1";
export const SELECTION_PLAN_FILE = (key) => key + ".selection-plan.json";
export const SELECTION_PLAN_MAX_BYTES = 64 * 1024;

const errCode = (err) => String(err?.code ?? err?.message ?? err);
const keysOf = (o) => Object.keys(o).sort().join(",");

/** 封闭 schema 校验器：返回 null 或问题短句。 */
export function selectionPlanProblem(plan) {
  if (!isObj(plan)) return "plan 不是对象";
  // 键集 = action,basis,cas,handle,kind,target_id（与 R57d B 段同形）。
  if (keysOf(plan) !== "action,basis,cas,handle,kind,target_id") return "plan 键集不对";
  if (plan.action !== "reaffirm") return "action 不是 reaffirm";
  if (plan.basis !== "reaffirm") return "basis 不是 reaffirm";
  if (plan.kind !== "rfh") return "kind 不是 rfh";
  if (typeof plan.handle !== "string" || !REAFFIRM_HANDLE_SHAPE.test(plan.handle)) return "handle 形状不对";
  if (typeof plan.target_id !== "string" || !ID_SHAPE.test(plan.target_id)) return "target_id 形状不对";
  // cas：封闭对象，键集 = expected_expires_at,intent_id；两值形状/自洽。
  const cas = plan.cas;
  if (!isObj(cas) || keysOf(cas) !== "expected_expires_at,intent_id") return "cas 键集不对";
  if (typeof cas.intent_id !== "string" || !REAFFIRM_HANDLE_SHAPE.test(cas.intent_id)) return "cas.intent_id 形状不对";
  if (cas.intent_id !== plan.handle) return "cas.intent_id 与 handle 不一致";
  if (typeof cas.expected_expires_at !== "string") return "cas.expected_expires_at 不是字符串";
  if (!Number.isFinite(Date.parse(cas.expected_expires_at))) return "cas.expected_expires_at 不是合法时间";
  return null;
}

/** 生成 plan 的规范摘要（读回核身用；不依赖盘上字节——换行/缩进无关）。 */
export function selectionPlanDigest(plan) {
  return sha256(Buffer.from(canonKey(plan), "utf-8"));
}

function planPath(claimsDir, key) {
  return path.join(claimsDir, SELECTION_PLAN_FILE(key));
}

/**
 * 受验读回：fd 绑定、O_NOFOLLOW|O_NONBLOCK、普通文件、单硬链接、0600、大小上限、JSON 封闭 schema。
 * 返回 { ok:true, plan, sha256, bytes } / { ok:true, absent:true } / { ok:false, problem }。
 */
export function readSelectionPlan({ claimsDir, key }) {
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: false, problem: "claimsDir 缺失" };
  if (typeof key !== "string" || key.length === 0) return { ok: false, problem: "key 缺失" };
  const file = planPath(claimsDir, key);
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, absent: true };
    return { ok: false, problem: "open 失败: " + errCode(err) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, problem: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, problem: "硬链接数不为 1" };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, problem: "mode 不是 0600: " + (st.mode & 0o777).toString(8) };
    if (st.size > SELECTION_PLAN_MAX_BYTES) return { ok: false, problem: "超过大小上限（" + st.size + " > " + SELECTION_PLAN_MAX_BYTES + "）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) return { ok: false, problem: "读不满文件（" + off + "/" + st.size + "）" };
      off += n;
    }
    let plan = null;
    try { plan = JSON.parse(buf.toString("utf-8")); } catch (err) { return { ok: false, problem: "JSON 解析失败: " + errCode(err) }; }
    const p = selectionPlanProblem(plan);
    if (p !== null) return { ok: false, problem: p };
    return { ok: true, plan, sha256: sha256(buf), bytes: buf.length };
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/**
 * 原子写 plan sidecar：tmp O_EXCL 0600 写满 → fsync → rename → fsync 父目录 → 受验读回逐字节等。
 * 失败 fail-closed（带 residue 点名 tmp）。
 * @returns { ok:true } | { ok:false, reason, why, residue? }
 */
export function writeSelectionPlan({ claimsDir, key, plan, _inject = null } = {}) {
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: false, reason: "claimsDir 缺失" };
  if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "key 缺失" };
  const p = selectionPlanProblem(plan);
  if (p !== null) return { ok: false, reason: "selection_plan_invalid", why: p };
  const bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf-8");
  if (bytes.length > SELECTION_PLAN_MAX_BYTES) return { ok: false, reason: "over_capacity", why: "序列化长度超出上限" };
  const file = planPath(claimsDir, key);
  const tmp = path.join(claimsDir, "." + SELECTION_PLAN_FILE(key) + ".tmp." + process.pid + "." + crypto.randomUUID());
  let fd = null;
  let renameLanded = false;
  const cleanupTmp = () => {
    try { fs.unlinkSync(tmp); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  };
  try {
    fs.mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) {
      try { fs.closeSync(fd); fd = null; } catch {}
      try { cleanupTmp(); } catch (e2) { return { ok: false, reason: "residue", residue: tmp, why: errCode(e2) }; }
      return { ok: false, reason: "tmp_file_invalid", why: "tmp 文件属性异常" };
    }
    let off = 0;
    while (off < bytes.length) {
      const n = fs.writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) break;
      off += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (typeof _inject?.beforeRename === "function") _inject.beforeRename();
    fs.renameSync(tmp, file);
    renameLanded = true;
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); fd = null; } catch {} }
    if (!renameLanded) {
      try { cleanupTmp(); } catch (e2) { return { ok: false, reason: "residue", residue: tmp, why: errCode(e2) }; }
      return { ok: false, reason: "tmp_write_failed", why: errCode(err) };
    }
  }
  // rename 后目录 fsync（不吞异常）
  try {
    if (_inject?.failDirFsync) { const e = new Error("EIO: i/o error"); e.code = "EIO"; throw e; }
    let dfd = null;
    try { dfd = fs.openSync(claimsDir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
    finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch {} } }
  } catch (err) {
    return { ok: false, reason: "dir_fsync_failed", why: "目录 fsync 失败: " + errCode(err) };
  }
  // 受验读回逐字节等
  if (typeof _inject?.beforeReadback === "function") _inject.beforeReadback();
  const rb = readSelectionPlan({ claimsDir, key });
  if (!rb.ok) return { ok: false, reason: "readback_failed", why: "受验读回未通过（" + (rb.problem ?? "?") + "）" };
  if (rb.sha256 !== sha256(bytes)) return { ok: false, reason: "readback_failed", why: "读回字节与写入字节不一致" };
  return { ok: true };
}
