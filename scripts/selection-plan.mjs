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
 *   返修九 恢复纪律：readSelectionPlan **不删任何文件**——遇任何精确 tmp 候选一律报 residue fail-closed；
 *   恢复（unlink）由 recoverSelectionPlanTmp 在持锁入口（writeSelectionPlan / repair）显式调用，且只在
 *   唯一候选、final 存在、同 dev+ino、final nlink===2、open 后 inode 绑定复核全满足时才 unlink。
 *   tmp 命名严格封闭为 <key>.selection-plan.json.tmp.<正整数 pid>.<v4 uuid>，非此形状不算候选。
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
// 封闭形状（返修九 规则 1）：<key>.selection-plan.json.tmp.<正整数 pid>.<v4 uuid>。
// <uuid> 严格按 crypto.randomUUID() 形状（version 4，variant [89ab]）；<pid> 须正整数。
// 用 startsWith(精确前缀) 承载 key（key 不是正则、无需转义），rest 用正则字面量封闭。
const TMP_UUID_V4_RE = /^([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
function isPlanTmpName(claimsDir, key, name) {
  if (typeof name !== "string") return false;
  const prefix = "." + SELECTION_PLAN_FILE(key) + ".tmp.";
  if (!name.startsWith(prefix)) return false;
  return TMP_UUID_V4_RE.test(name.slice(prefix.length));
}
const statSame = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;

/** 低层读原始字节（不走单硬链接守卫）：O_NOFOLLOW|O_NONBLOCK、普通文件、0600、大小上限。
 *  传入 expectedStat 时做「open 后 inode 绑定复核」（返修九 规则 2）：open+fstat 的 dev/ino 必须与盘点快照一致，
 *  否则拒（防止 open 后文件被替换的 TOCTOU）。 */
function readBytesNoNlink(file, expectedStat) {
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
    if (expectedStat && !statSame(st, expectedStat)) return { ok: false, problem: "open 后 inode 与盘点快照不一致（可能被替换）" };
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
 * 盘点（返修九 规则 1）：目录里名字严格匹配精确 tmp 形状的候选。盘点期间不得 unlink；
 * readdir / lstat 的非 ENOENT 异常、异形（非普通文件 / 非 0600 / symlink）→ 整体非绿。
 * 返回 { ok:true, entries:[{name,path,st}] } / { ok:false, residue:[...], why }（residue 为已找到的路径 + 出错路径）。
 * @param {object} _inject 可选：{ readdir } 钩子在测试注入 readdir EIO。
 */
function scanPlanTmpCandidates({ claimsDir, key, _inject }) {
  let names;
  try {
    names = typeof _inject?.readdir === "function" ? _inject.readdir() : fs.readdirSync(claimsDir);
  } catch (err) {
    // 规则 3：只有 ENOENT 折缺席（目录还不存在 = 无候选）；非 ENOENT（如注入的 EIO）→ residue fail-closed。
    if (err?.code === "ENOENT") return { ok: true, entries: [] };
    return { ok: false, residue: [], why: "readdir 失败: " + errCode(err) };
  }
  const entries = [];
  for (const name of names) {
    if (!isPlanTmpName(claimsDir, key, name)) continue;
    const p = path.join(claimsDir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      return { ok: false, residue: entries.map((e) => e.path).concat([p]), why: "lstat tmp 失败: " + errCode(err) };
    }
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
      return { ok: false, residue: entries.map((e) => e.path).concat([p]), why: "tmp 形状异常（非普通文件或非 0600）：" + path.basename(p) };
    }
    entries.push({ name, path: p, st });
  }
  return { ok: true, entries };
}

/**
 * 受验恢复（返修九 规则 2/5）：只在持锁入口被显式调用（writeSelectionPlan / repair）。
 * 规则 2 恢复的充要条件 = 唯一候选 && final 存在 && tmp 与 final 同 dev+ino && final 的 lstat nlink === 2
 * && open tmp 的 fd 后 fstat.dev/ino 与盘点快照一致（open 后 inode 绑定复核）。全部满足 → unlink tmp → fsync 目录。
 * 其余（无候选 / 唯一候选但不满足 / 多于一个候选 / 异常 / 异形 / 异 inode / final 缺席但有候选）→ 按
 * 规则 1/3 fail-closed：返回 { ok:false, reason:"residue", residue:[...], why }，不改动任何文件。
 */
export function recoverSelectionPlanTmp({ claimsDir, key, _inject = null } = {}) {
  // P2-2（返修十）：输入错误 fail-closed —— 判决目录缺失 / key 非法拒；目录本身 ENOENT 仍按「无候选」ok。
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: false, reason: "claims_dir_missing", why: "claimsDir 缺失" };
  const kv = validateKey(key);
  if (kv !== null) return { ok: false, reason: "key_shape", why: kv };
  const scan = scanPlanTmpCandidates({ claimsDir, key, _inject });
  if (!scan.ok) return { ok: false, reason: "residue", residue: scan.residue, why: scan.why };
  if (scan.entries.length === 0) return { ok: true, recovered: null, residue: null };
  if (scan.entries.length > 1) return { ok: false, reason: "residue", residue: scan.entries.map((e) => e.path), why: "多于一个精确 tmp 候选（规则 1：不自动清）" };
  const cand = scan.entries[0];
  const final = planPath(claimsDir, key);
  let finalSt;
  try { finalSt = fs.lstatSync(final); } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, reason: "residue", residue: [cand.path], why: "final 缺席但精确候选在场（规则 3，非「无窗口」）" };
    return { ok: false, reason: "residue", residue: [cand.path], why: "lstat final 失败: " + errCode(err) };
  }
  if (finalSt.nlink !== 2) return { ok: false, reason: "residue", residue: [cand.path], why: "final nlink 不是 2（当前 " + finalSt.nlink + "，非「link 后未 unlink」态）" };
  if (!statSame(cand.st, finalSt)) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 与 final 不同 dev+ino（异 inode）" };
  if (cand.st.nlink !== 2) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp nlink 不是 2（当前 " + cand.st.nlink + "）" };
  // open 后 inode 绑定复核（规则 2）：open+readBytesNoNlink 的 fstat.dev/ino 必须与盘点快照一致（防 TOCTOU）。
  const rb = readBytesNoNlink(cand.path, cand.st);
  if (!rb.ok) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 受验读回失败: " + rb.problem };
  let tmpPlan = null;
  try { tmpPlan = JSON.parse(rb.buf.toString("utf-8")); } catch (err) { return { ok: false, reason: "residue", residue: [cand.path], why: "tmp JSON 解析失败" }; }
  if (selectionPlanProblem(tmpPlan, key) !== null) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 不是合法 selection plan" };
  try {
    fs.unlinkSync(cand.path);
  } catch (err) {
    return { ok: false, reason: "residue", residue: [cand.path], why: "unlink tmp 失败: " + errCode(err) };
  }
  try {
    let dfd = null;
    try { dfd = fs.openSync(claimsDir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
    finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch {} } }
  } catch (err) {
    return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 已清但目录 fsync 失败: " + errCode(err) };
  }
  return { ok: true, recovered: cand.path, residue: null };
}

/**
 * 受验读回：fd 绑定、O_NOFOLLOW|O_NONBLOCK、普通文件、单硬链接、0600、大小上限、JSON 封闭 schema。
 * 返回 { ok:true, plan, sha256, bytes, reused } / { ok:true, absent:true } / { ok:false, problem, reason? }。
 * 规则 5：本函数**不删任何文件**。遇到任何精确 tmp 候选（规则 1 全量盘点）→ 报 residue fail-closed，
 * 不自动恢复；恢复（unlink）由 recoverSelectionPlanTmp 在持锁入口调用。
 */
export function readSelectionPlan({ claimsDir, key, _inject = null }) {
  if (typeof claimsDir !== "string" || claimsDir.length === 0) return { ok: false, problem: "claimsDir 缺失" };
  const kv = validateKey(key);
  if (kv !== null) return { ok: false, problem: kv };
  // 规则 1：全量盘点；盘点期间不 unlink。异常 / 异形 / 异 inode / 多于一个候选 → 非绿。
  const scan = scanPlanTmpCandidates({ claimsDir, key, _inject });
  if (!scan.ok) return { ok: false, reason: "residue", problem: scan.why, residue: scan.residue };
  if (scan.entries.length > 0) {
    return { ok: false, reason: "residue", problem: "selection plan tmp 残骸待人工（readSelectionPlan 不自动清）", residue: scan.entries.map((e) => e.path) };
  }
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

  // 规则 5：持锁入口——先受验恢复「link 后未 unlink」的 tmp（唯一合法候选且满足规则 2 充要条件 → unlink）；
  // 恢复不了（规则 1/3 的 residue）→ fail-closed，不继续写。
  const rc = recoverSelectionPlanTmp({ claimsDir, key, _inject });
  if (rc && rc.ok === false) return { ok: false, reason: "residue", why: rc.why, residue: rc.residue };

  // 既有 plan：只能「深层全符复用」或 conflict，绝不覆盖（P2：用 canonKey，非原始字节）。
  const existing = readSelectionPlan({ claimsDir, key, _inject });
  if (!existing.ok) {
    if (existing.residue) return { ok: false, reason: "residue", why: existing.problem, residue: existing.residue };
    return { ok: false, reason: existing.reason ?? "selection_plan_readback_failed", why: existing.problem };
  }
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
        const later = readSelectionPlan({ claimsDir, key, _inject });
        // 规则 4：重读出带 residue 的失败 → 原样带出（residue/路径/错误码），不折成 selection_plan_conflict。
        if (later.ok === false && later.residue) return { ok: false, reason: "residue", why: later.problem, residue: later.residue };
        if (later.ok && !later.absent && canonKey(later.plan) === canonKey(plan)) return { ok: true, reused: true };
        if (later.ok === false) return { ok: false, reason: later.reason ?? "selection_plan_readback_failed", why: later.problem };
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
  if (!rb.ok) {
    // P1（返修十）：最终受验读回盘点出精确 tmp 候选（residue）—— link 已成功这一事实不变，
    //   保留 reason:"residue" + residue 数组 + commit:committed_durability_uncertain，不折 readback_failed、不丢路径。
    if (rb.residue) return { ok: false, reason: "residue", why: rb.problem ?? "受验读回发现 tmp 残骸", residue: rb.residue, commit: "committed_durability_uncertain" };
    return { ok: false, reason: "readback_failed", why: "受验读回未通过（" + (rb.problem ?? "?") + "）", commit: "committed_durability_uncertain" };
  }
  if (rb.sha256 !== sha256(bytes)) return { ok: false, reason: "readback_failed", why: "读回字节与写入字节不一致", commit: "committed_durability_uncertain" };
  return { ok: true, created: true, reused: false };
}
