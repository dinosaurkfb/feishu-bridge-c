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
 *   **R58 返修二 P1-1：机制搬到叶子 scripts/verified-sidecar.mjs（createVerifiedSidecar），本模块只留
 *   文件名/大小上限/校验器/文案这一层参数与薄适配。**转发失败回执（outbox.mjs）用同一份机制——
 *   受验读取与受验恢复只有一份实现，改一处两边一起变。
 *
 *   注意：本模块只做 sidecar 持久化，不读环境变量、不碰账本、不 import 任何可能反向依赖本模块的模块。
 *   形状常量住叶子 scripts/shapes.mjs（返修六 P2），不 import 大账本模块。
 */

import fs from "node:fs";
import { createVerifiedSidecar } from "./verified-sidecar.mjs";
import { isObj, canonKey, sha256 } from "./maintenance/canon.mjs";
import { ID_SHAPE, SELECTION_HANDLE_SHAPE, REBIND_HANDLE_SHAPE, REAFFIRM_HANDLE_SHAPE, CLAIM_KEY_SHAPE } from "./shapes.mjs";

export const SELECTION_PLAN_SCHEMA = "selection-plan-1";
export const SELECTION_PLAN_FILE = (key) => key + ".selection-plan.json";
export const SELECTION_PLAN_MAX_BYTES = 64 * 1024;
// 封闭键集（含 claim_key + schema_version，返修六 P1-2 / P2-a）。
const SELECTION_PLAN_KEYS = "action,basis,cas,claim_key,handle,kind,schema_version,target_id";

const errCode = (err) => String(err?.code ?? err?.message ?? err);
const keysOf = (o) => Object.keys(o).sort().join(",");

/** cas 按 action 的封闭键集（R57d 对齐 P1-4）：与 executeSelectControl 冻结的 CAS 上下文逐字段对应。 */
const PLAN_CAS_KEYS = Object.freeze({
  activate: "selected_root_om,selected_session_id,selection_handle",
  anchor: "expected_anchor_candidate,expected_expires_at,expected_handle,selected_root_om,selected_session_id",
  rebind: "expected_expires_at,expected_old_session_id,new_session_id,rebind_handle",
  reaffirm: "expected_expires_at,intent_id",
});
/** handle 形状按 kind 映射（形状常量住 shapes.mjs，同一形状只有一份）。 */
const PLAN_HANDLE_SHAPE = Object.freeze({ rfh: REAFFIRM_HANDLE_SHAPE, osh: SELECTION_HANDLE_SHAPE, orh: REBIND_HANDLE_SHAPE });

/**
 * 封闭 schema 校验器：返回 null 或问题短句（真正用 SELECTION_PLAN_SCHEMA 逐字段校验）。
 * kind 封闭三联合（R57d 对齐 P1-4）：rfh（reaffirm）/ osh（activate|anchor）/ orh（rebind），
 * action、basis、handle、cas 键集都随 kind/action 分支封闭；rfh 支行为与返修六逐字不变。
 */
export function selectionPlanProblem(plan, key) {
  if (!isObj(plan)) return "plan 不是对象";
  if (keysOf(plan) !== SELECTION_PLAN_KEYS) return "plan 键集不对（须 " + SELECTION_PLAN_KEYS + "）";
  if (plan.schema_version !== SELECTION_PLAN_SCHEMA) return "schema_version 不是 " + SELECTION_PLAN_SCHEMA;
  if (plan.kind !== "rfh" && plan.kind !== "osh" && plan.kind !== "orh") return "kind 不是 rfh/osh/orh";
  if (typeof plan.claim_key !== "string" || !CLAIM_KEY_SHAPE.test(plan.claim_key)) return "claim_key 形状不对";
  if (typeof key === "string" && plan.claim_key !== key) return "claim_key 与文件名不一致";
  if (typeof plan.handle !== "string" || !PLAN_HANDLE_SHAPE[plan.kind].test(plan.handle)) return "handle 形状不对";
  if (typeof plan.target_id !== "string" || !ID_SHAPE.test(plan.target_id)) return "target_id 形状不对";
  const cas = plan.cas;
  if (plan.kind === "rfh") {
    if (plan.action !== "reaffirm") return "action 不是 reaffirm";
    if (plan.basis !== "reaffirm") return "basis 不是 reaffirm";
    if (!isObj(cas) || keysOf(cas) !== PLAN_CAS_KEYS.reaffirm) return "cas 键集不对";
    if (typeof cas.intent_id !== "string" || !REAFFIRM_HANDLE_SHAPE.test(cas.intent_id)) return "cas.intent_id 形状不对";
    if (cas.intent_id !== plan.handle) return "cas.intent_id 与 handle 不一致";
    if (typeof cas.expected_expires_at !== "string") return "cas.expected_expires_at 不是字符串";
    if (!Number.isFinite(Date.parse(cas.expected_expires_at))) return "cas.expected_expires_at 不是合法时间";
    return null;
  }
  // osh / orh：action/basis 封闭 + cas 按 action 封闭键集（键集封闭由 keysOf 保证；值形状逐键核）。
  if (plan.kind === "osh" && plan.action !== "activate" && plan.action !== "anchor") return "osh 的 action 是 activate/anchor";
  if (plan.kind === "orh" && plan.action !== "rebind") return "orh 的 action 是 rebind";
  if (plan.basis !== "explicit_handle" && plan.basis !== "resolved") return "basis 是 explicit_handle/resolved";
  if (!isObj(cas) || keysOf(cas) !== PLAN_CAS_KEYS[plan.action]) return "cas 键集不对（" + plan.action + "）";
  for (const [k, v] of Object.entries(cas)) {
    if (v === null || typeof v !== "string" || v.length === 0) return "cas." + k + " 须非空字符串";
    if (/handle$/u.test(k) && !/^(osh|orh)_[0-9a-f]{32}$/u.test(v)) return "cas." + k + " 形状不对";
    if (/expires_at$/u.test(k) && !Number.isFinite(Date.parse(v))) return "cas." + k + " 不是合法时间";
  }
  // handle 自洽：cas 里冻结的 handle 与 plan.handle 同一（activate/anchor 的 selection_handle、rebind 的 rebind_handle）。
  const frozen = cas.selection_handle ?? cas.rebind_handle ?? null;
  if (frozen !== null && frozen !== plan.handle) return "cas 冻结的 handle 与 plan.handle 不一致";
  return null;
}

/** 生成 plan 的规范摘要（读回核身用；不依赖盘上字节——换行/缩进无关）。 */
export function selectionPlanDigest(plan) {
  return sha256(Buffer.from(canonKey(plan), "utf-8"));
}

/**
 * 受验 sidecar 原语（R58 返修二 P1-1：机制住在叶子 scripts/verified-sidecar.mjs，两边共用）。
 * 本模块只提供参数：文件名 `<key>.selection-plan.json`、64 KiB 上限、封闭校验器 selectionPlanProblem、
 * key 形状 CLAIM_KEY_SHAPE，以及各自的文案。
 */
const SIDECAR = createVerifiedSidecar({
  label: "selection plan",
  fileNameOf: SELECTION_PLAN_FILE,
  maxBytes: SELECTION_PLAN_MAX_BYTES,
  problemOf: (plan, key) => selectionPlanProblem(plan, key),
  keyShape: CLAIM_KEY_SHAPE,
  dirMissingReason: "claims_dir_missing",
  problemReason: "selection_plan_key_mismatch",
  keyProblem: "key 形状不对（须 64hex）",
  dirMissingWhy: "claimsDir 缺失",
});

function planPath(claimsDir, key) {
  return SIDECAR.filePath(claimsDir, key);
}

function validateKey(key) {
  return SIDECAR.validateKey(key);
}

/** 本次写临时文件的命名规则（封闭）：.<key>.selection-plan.json.tmp.<pid>.<uuid>，前缀可精确匹配。 */
export const SELECTION_PLAN_TMP_PREFIX = (key) => SIDECAR.tmpPrefixOf(key);
function tmpPathFor(claimsDir, key) {
  return SIDECAR.tmpPathFor(claimsDir, key);
}

/**
 * 受验恢复（返修九 规则 2/5）：见 verified-sidecar.mjs 模块头 ③。只在持锁入口被显式调用。
 * 返回 { ok:true, recovered, residue:null } / { ok:false, reason, residue:[...], why }。
 * （叶子与旧形同形，无需映射。）
 */
export function recoverSelectionPlanTmp({ claimsDir, key, _inject = null } = {}) {
  return SIDECAR.recoverTmp({ dir: claimsDir, key, _inject });
}

/**
 * 受验读回：见 verified-sidecar.mjs 模块头 ② ④。
 * 返回 { ok:true, plan, sha256, bytes } / { ok:true, absent:true } / { ok:false, problem, reason?, residue? }。
 *
 * **P2-2（R58 返修三）：返回形是 R57b 十一轮放行的对外契约，逐字保留。** verified-sidecar 是共用叶子，
 * 它为了别的消费面多带了字段（失败时的 `kind`、成功时的 `raw`）——本薄适配层把它们挡在模块边界外：
 *   成功 → 恰 {ok, plan, sha256, bytes}
 *   输入错 / 读不出 → 恰 {ok, problem}
 *   校验不过 → {ok, problem, reason}
 *   残骸 / 盘点失败 → {ok, problem, reason:"residue", residue}
 * 新增字段一律不许漏出去（有键集逐字断言钉着）。
 */
export function readSelectionPlan({ claimsDir, key, _inject = null }) {
  const r = SIDECAR.read({ dir: claimsDir, key, _inject });
  if (r.ok === true && r.absent === true) return { ok: true, absent: true };
  if (r.ok === true) return { ok: true, plan: r.value, sha256: r.sha256, bytes: r.bytes };
  const out = { ok: false, problem: r.problem };
  if (r.reason !== undefined) out.reason = r.reason;
  if (r.residue !== undefined) out.residue = r.residue;
  return out;
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
