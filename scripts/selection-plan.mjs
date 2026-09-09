/**
 * R57b 返修五/六：selection plan sidecar（真叶子模块，无上层依赖）。
 *   真实 claim 写方（inbound / codex-inbound 两链）在 rfh 支账本提交前，把本次选择的计划持久化为
 *   claims/<key>.selection-plan.json；repair（control-committed-unclean 恢复）读回它做三方逐字绑定
 *   （plan / uncleanRecord / 账本 op 的 target_id 逐字一致）。无 plan 或目标不一致 → 不转 consumed。
 *
 *   计划封闭键集（返修六，与 R57d B 段同形 + claim_key + schema_version）：
 *   action / basis / cas / claim_key / handle / kind / schema_version / target_id。
 *   cas（compare-and-set 上下文）在 rfh 支为 { intent_id, expected_expires_at }（绑定本次所见 intent）。
 *
 *   不可变约束（返修六 P1-2）：plan 本体含 claim_key，readback 与文件名逐字互证；key 核 CLAIM_KEY_SHAPE
 *   （64hex，防路径型 key 越界）；既有 plan 只能「受验全符复用」（逐字相等 → ok, reused:true）或
 *   selection_plan_conflict，**绝不覆盖**（写用 O_EXCL 目标文件，不用 rename 覆盖既有）。
 *
 *   写原语（同侧 sidecar 纪律）：临时文件 O_CREAT|O_EXCL 0600 → fstat 核普通文件/单硬链接/0600 →
 *   fsync 写端 fd → 目标文件 O_CREAT|O_EXCL（不覆盖）→ fsync 父目录 → 受验读回（fd 绑定：O_NOFOLLOW|
 *   O_NONBLOCK、fstat 核 0600/单硬链接/大小上限、JSON 封闭 schema、逐字节等）。失败 fail-closed
 *   （写失败 = 不进账本提交）。
 *
 *   注意：本模块只做 sidecar 持久化，不读环境变量、不碰账本、不 import 任何可能反向依赖本模块的模块。
 *   形状常量住叶子 scripts/shapes.mjs（返修六 P2），不 import 大账本模块。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isObj, canonKey, sha256 } from "./maintenance/canon.mjs";
import { ID_SHAPE, REAFFIRM_HANDLE_SHAPE, CLAIM_KEY_SHAPE } from "./shapes.mjs";

export const SELECTION_PLAN_SCHEMA = "selection-plan-1";
export const SELECTION_PLAN_FILE = (key) => key + ".selection-plan.json";
export const SELECTION_PLAN_MAX_BYTES = 64 * 1024;
// 封闭键集（含 claim_key + schema_version，返修六 P1-2 / P2-a）。
const SELECTION_PLAN_KEYS = "action,basis,cas,claim_key,handle,kind,schema_version,target_id";

const errCode = (err) => String(err?.code ?? err?.message ?? err);
const keysOf = (o) => Object.keys(o).sort().join(",");

/** 封闭 schema 校验器：返回 null 或问题短句（真正用 SELECTION_PLAN_SCHEMA 逐字段校验）。 */
export function selectionPlanProblem(plan, key) {
  if (!isObj(plan)) return "plan 不是对象";
  if (keysOf(plan) !== SELECTION_PLAN_KEYS) return "plan 键集不对（须 " + SELECTION_PLAN_KEYS + "）";
  if (plan.schema_version !== SELECTION_PLAN_SCHEMA) return "schema_version 不是 " + SELECTION_PLAN_SCHEMA;
  if (plan.action !== "reaffirm") return "action 不是 reaffirm";
  if (plan.basis !== "reaffirm") return "basis 不是 reaffirm";
  if (plan.kind !== "rfh") return "kind 不是 rfh";
  if (typeof plan.claim_key !== "string" || !CLAIM_KEY_SHAPE.test(plan.claim_key)) return "claim_key 形状不对";
  if (typeof key === "string" && plan.claim_key !== key) return "claim_key 与文件名不一致";
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

function validateKey(key) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return "key 形状不对（须 64hex）";
  return null;
}

/** 本次写临时文件的命名规则（封闭）：.<key>.selection-plan.json.tmp.<pid>.<uuid>，前缀可精确匹配。 */
export const SELECTION_PLAN_TMP_PREFIX = (key) => "." + SELECTION_PLAN_FILE(key) + ".tmp.";
function tmpPathFor(claimsDir, key) {
  return path.join(claimsDir, SELECTION_PLAN_TMP_PREFIX(key) + process.pid + "." + crypto.randomUUID());
}
function isPlanTmpName(claimsDir, key, name) {
  const pre = SELECTION_PLAN_TMP_PREFIX(key);
  return typeof name === "string" && name.startsWith(pre) && name.length > pre.length;
}
const statSame = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const isPlanTxShape = (st) => !!st && st.isFile() && (st.mode & 0o777) === 0o600;

/** 低层读原始字节（不走单硬链接守卫）：O_NOFOLLOW|O_NONBLOCK、普通文件、0600、大小上限。 */
function readBytesNoNlink(file) {
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
    if ((st.mode & 0o777) !== 0o600) return { ok: false, problem: "mode 不是 0600: " + (st.mode & 0o777).toString(8) };
    if (st.size > SELECTION_PLAN_MAX_BYTES) return { ok: false, problem: "超过大小上限（" + st.size + " > " + SELECTION_PLAN_MAX_BYTES + "）" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) return { ok: false, problem: "读不满文件（" + off + "/" + st.size + "）" };
      off += n;
    }
    return { ok: true, buf, st };
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/**
 * 受验恢复（返修八 窗口②）：link 之后、unlink tmp 之前的崩溃会让 final 与 tmp 同 inode（nlink=2），
 * 单硬链接守卫拒 final。扫描同目录里 <key> 的精确 tmp 形状：若存在且与 final 同 dev+inode、
 * 形状（普通文件 0600）、内容（受验读回 canonKey 等）都对上 → 视为「link 后未 unlink」态：
 * unlink tmp → fsync 目录；对不上（不同 inode / 形状 / 内容）→ 明确 residue 点名，不自动清。
 */
function recoverLinkedTmp({ claimsDir, key }) {
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: true, residue: null };
  const kv = validateKey(key);
  if (kv !== null) return { ok: true, residue: null };
  const final = planPath(claimsDir, key);
  let finalSt = null;
  try { finalSt = fs.lstatSync(final); } catch { /* absent */ }
  if (!finalSt) return { ok: true, residue: null }; // final 缺席：无「link 后」窗口
  let names;
  try { names = fs.readdirSync(claimsDir); } catch { return { ok: true, residue: null }; }
  for (const name of names) {
    if (!isPlanTmpName(claimsDir, key, name)) continue;
    const tmp = path.join(claimsDir, name);
    let tmpSt;
    try { tmpSt = fs.lstatSync(tmp); } catch { continue; }
    if (statSame(tmpSt, finalSt) && isPlanTxShape(tmpSt)) {
      // 同 inode = 同内容；再受验读回 tmp 确认它是合法 plan（内容与 final 逐字等）。
      const rb = readBytesNoNlink(tmp);
      if (!rb.ok || rb.absent) continue;
      let tmpPlan = null;
      try { tmpPlan = JSON.parse(rb.buf.toString("utf-8")); } catch { continue; }
      if (selectionPlanProblem(tmpPlan, key) !== null) continue;
      // 内容 canonKey 与 final 逐字（同 inode 已是；这里用受验读回确认）。
      const fb = readBytesNoNlink(final);
      if (!fb.ok || fb.absent || canonKey(JSON.parse(fb.buf.toString("utf-8"))) !== canonKey(tmpPlan)) continue;
      // 视为「link 后未 unlink」：unlink tmp → fsync 目录。
      try {
        fs.unlinkSync(tmp);
      } catch (err) {
        return { ok: false, residue: [tmp], why: "unlink tmp 失败: " + errCode(err), problem: "受验恢复无法清 tmp（link 后未 unlink 态）" };
      }
      try {
        let dfd = null;
        try { dfd = fs.openSync(claimsDir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
        finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch {} } }
      } catch (err) {
        return { ok: false, residue: [tmp], why: "tmp 已清但目录 fsync 失败: " + errCode(err), problem: "受验恢复 fsync 目录失败" };
      }
      return { ok: true, recovered: tmp, residue: null };
    }
    // 对不上（不同 inode / 形状不对 / 内容不等）→ residue 点名，不自动清。
    return { ok: false, residue: [tmp], why: "tmp 与 final 对不上（inode/形状/内容不符），不自动清", problem: "selection plan tmp 残骸待人工" };
  }
  return { ok: true, residue: null };
}

/**
 * 受验读回：fd 绑定、O_NOFOLLOW|O_NONBLOCK、普通文件、单硬链接、0600、大小上限、JSON 封闭 schema。
 * 返回 { ok:true, plan, sha256, bytes, reused } / { ok:true, absent:true } / { ok:false, problem, reason? }。
 */
export function readSelectionPlan({ claimsDir, key }) {
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: false, problem: "claimsDir 缺失" };
  const kv = validateKey(key);
  if (kv !== null) return { ok: false, problem: kv };
  // 返修八 窗口②：先受验恢复「link 后未 unlink」的 tmp，避免单硬链接守卫拒 final。
  const rc = recoverLinkedTmp({ claimsDir, key });
  if (rc && rc.ok === false) return { ok: false, problem: rc.why ?? rc.problem, residue: rc.residue };
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
    const p = selectionPlanProblem(plan, key);
    if (p !== null) return { ok: false, problem: p, reason: "selection_plan_key_mismatch" };
    return { ok: true, plan, sha256: sha256(buf), bytes: buf.length };
  } catch (err) {
    return { ok: false, problem: errCode(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/**
 * 写 plan sidecar（原子 no-replace 落盘）。返回：
 *   { ok:true, reused:false, created:true }  新建
 *   { ok:true, reused:true }                 既有 plan 深层全符（canonKey，幂等）
 *   { ok:false, reason, why }                conflict / 校验 / 写失败（fail-closed）
 * 发布序列（返修七 P1-2）：完整写 tmp → fsync(tmp) → linkSync(tmp, final)（final 已存在 → EEXIST → 全符复用/conflict）
 * → unlink tmp → fsync 目录 → 受验读回。任何阶段失败：link 前 → 清 tmp（清不掉 → residue 点名）；
 * link 后目录 fsync 失败 → durability_uncertain；所有 fd 在 finally 关闭。
 */
export function writeSelectionPlan({ claimsDir, key, plan, _inject = null } = {}) {
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: false, reason: "claimsDir 缺失" };
  const kv = validateKey(key);
  if (kv !== null) return { ok: false, reason: "selection_plan_key_invalid", why: kv };
  // plan 必须带与 key 一致的 claim_key（P1-2：读回与文件名互证）。
  const p = selectionPlanProblem(plan, key);
  if (p !== null) return { ok: false, reason: "selection_plan_invalid", why: p };
  const bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf-8");
  if (bytes.length > SELECTION_PLAN_MAX_BYTES) return { ok: false, reason: "over_capacity", why: "序列化长度超出上限" };
  const file = planPath(claimsDir, key);

  // 返修八 窗口②：先受验恢复「link 后未 unlink」的 tmp（否则单硬链接守卫会拒 final）。
  const rc = recoverLinkedTmp({ claimsDir, key });
  if (rc && rc.ok === false) return { ok: false, reason: "selection_plan_readback_failed", why: rc.why ?? rc.problem, residue: rc.residue };

  // 既有 plan：只能「深层全符复用」或 conflict，绝不覆盖（P2：用 canonKey，非原始字节）。
  const existing = readSelectionPlan({ claimsDir, key });
  if (!existing.ok) return { ok: false, reason: existing.reason ?? "selection_plan_readback_failed", why: existing.problem };
  if (!existing.absent) {
    if (canonKey(existing.plan) === canonKey(plan)) return { ok: true, reused: true };
    return { ok: false, reason: "selection_plan_conflict", why: "既有 plan 与本次计划深层不等（不可覆盖），保持原计划" };
  }

  const tmp = tmpPathFor(claimsDir, key);
  let fd = null;
  let linked = false;
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
    if (typeof _inject?.beforeLink === "function") _inject.beforeLink();
    // no-replace 发布：linkSync(tmp, final)。final 已存在 → EEXIST → 走全符复用 / conflict；绝不用 rename 覆盖。
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (err?.code === "EEXIST") {
        // 返修八 窗口①：reused / conflict 两支退出前都清本次 tmp；清不掉 → 外显 residue，不得报干净。
        try { cleanupTmp(); } catch (e2) { return { ok: false, reason: "residue", residue: tmp, why: errCode(e2) }; }
        // 目标在写窗口内被并发创建（此后无本次 tmp）：重读核深层是否全符。
        const later = readSelectionPlan({ claimsDir, key });
        if (later.ok && !later.absent && canonKey(later.plan) === canonKey(plan)) return { ok: true, reused: true };
        return { ok: false, reason: "selection_plan_conflict", why: "目标文件已被并发写（深层不等，不可覆盖）" };
      }
      throw err;
    }
    linked = true;
    // 发布成功后清 tmp（link 之后 tmp 与 final 同 inode；unlink tmp 只剩 final）。
    try { cleanupTmp(); } catch (err2) { return { ok: false, reason: "residue", residue: tmp, why: errCode(err2) }; }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); fd = null; } catch {} }
    if (!linked) {
      try { cleanupTmp(); } catch (e2) { return { ok: false, reason: "residue", residue: tmp, why: errCode(e2) }; }
      return { ok: false, reason: "tmp_write_failed", why: errCode(err) };
    }
    // link 已成功但后续（目录 fsync / 读回）失败 → durability_uncertain。
    return { ok: false, reason: "commit_uncertain", why: "link 后收口失败: " + errCode(err) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  // 发布后目录 fsync（不吞异常）
  try {
    if (_inject?.failDirFsync) { const e = new Error("EIO: i/o error"); e.code = "EIO"; throw e; }
    let dfd = null;
    try { dfd = fs.openSync(claimsDir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
    finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch {} } }
  } catch (err) {
    return { ok: false, reason: "dir_fsync_failed", why: "目录 fsync 失败: " + errCode(err), commit: "committed_durability_uncertain" };
  }
  // 受验读回逐字节等
  if (typeof _inject?.beforeReadback === "function") _inject.beforeReadback();
  const rb = readSelectionPlan({ claimsDir, key });
  if (!rb.ok) return { ok: false, reason: "readback_failed", why: "受验读回未通过（" + (rb.problem ?? "?") + "）", commit: "committed_durability_uncertain" };
  if (rb.sha256 !== sha256(bytes)) return { ok: false, reason: "readback_failed", why: "读回字节与写入字节不一致", commit: "committed_durability_uncertain" };
  return { ok: true, created: true, reused: false };
}
