/**
 * 话题智能体权威账本（v2 第三步 `docs/architecture/layers-v2-ledger.md` 的实现）。
 *
 * 每个 endpoint 一份单文件 JSON（records + revision + 不可覆盖 operations + authority_mode）。
 * 写走带 token fencing 的 commitWhileHeld：锁内 fd 重读 → 指纹重放前置 → compare + 整账本校验
 * → build → 两次 rename + 目录 fsync；结果四态封闭（释放失败也折进结果，不谎报）。读快照走
 * fd 绑定读，载入先跑整账本校验器（G1–G15），任一不过则该 endpoint 整体 ledger_corrupt。
 * 账本缺席/不可读一律 fail-closed、永不回退 registry。
 *
 * **两个不可伪造的写入口**（评审 P1-4）：普通事务只走 gated（过维护门 acquirePublishLock），
 * **不接受 ungated**；维护内部事务（initialize_shadow / authority_cutover）要求维护层产生的
 * 受验 capability——维护编排（第 2 块）未实现时**生产恒拒 fail-closed**（无环境变量旁路，评审五 P1-1）。
 * 目录由模块内部从**受验 root + endpoint** 派生并核身份（评审 P1-7），不接受外部任意 dir。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquirePublishLock, acquireLockUngated, releasePublishLock, commitWhileHeld } from "./registry.mjs";
import { isCanonicalIso, canonicalIso, isCanonicalMs } from "./canonical-time.mjs";
import { CLAIM_KEY_SHAPE } from "./claim.mjs";
import { JOURNAL_SCHEMA, OPERATION_KINDS, journalProblem, leaseHolder, leasePath, maintenanceDir, readActive, readJournal } from "./maintenance/journal.mjs";
import { endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import { maintenanceGatePath, readGate } from "./maintenance-gate-core.mjs";

export const SCHEMA_VERSION = "1.0";
export const ARTIFACT_TYPE = "feishu_bridge_topic_agent_ledger";
export const LEDGER_DIR_ENV = "FEISHU_BRIDGE_LEDGER_DIR";
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const MAX_FILE_BYTES = 1 << 20;
const MAX_LIVE = 512;
const MAX_OPERATIONS = 4096;

const ID_SHAPE = /^ta_[0-9a-f]{32}$/u;
const OP_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
// 生产权威形状（评审二 P1-1/P1-6）：endpoint = legacyEndpointId = stableControlId("endpoint",…) = endpoint_<24hex>；
// 链不可从 opaque endpoint 还原，另存顶层 chain。om_/oc_/session-UUID 各按真实前缀；claim key 复用 CLAIM_KEY_SHAPE。
const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u;
export { ENDPOINT_SHAPE }; // 只读导出（doctor ⑭ 枚举账本目录用）：同一形状只住一处
const CHAIN = ["claude", "codex"];
const OM_SHAPE = /^om_[A-Za-z0-9]{1,120}$/u;                 // 根消息 / matched om
const CHAT_SHAPE = /^oc_[A-Za-z0-9]{1,120}$/u;               // 受验群 chat_id
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u; // claude session
const AILY_SESSION_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;    // aliases.session_id（Aily 会话 locator）
const CODEX_ID_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;        // codex task/thread
const LINEAGE_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u;
const REQUEST_KEY_SHAPE = /^[A-Za-z0-9_.:@+-]{1,256}$/u; // 外部请求身份（控制 claim key / message id），进指纹（评审四 P1-2）
const AUTHORIZED_BY_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u; // 授权者 sender id（有界、无控制字符，评审六 P2）
const REASON_ENUM = ["expired", "superseded", "manual"];
const MATCHED_FIELDS = ["chat_id", "sender", "body", "thread_root"];
const OP_TYPES = ["initialize_shadow", "create_a1", "create_b1", "seed", "activate", "void", "attach_a2", "attach_a3", "anchor", "restore", "unbind", "retarget", "authority_cutover", "migrate_seed", "migrate_repair"];
// migrate_repair 的 from_family / to_family 值域（§5.1 判别联合：B1→B1；{B3,B3',B4}→{B3,B3',B4}）
const MIGRATE_FAMILIES = ["B1", "B3", "B3'", "B4"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (o) => Object.keys(o).sort().join(",");
const isId = (v) => typeof v === "string" && ID_SHAPE.test(v);
const isOperationId = (v) => typeof v === "string" && OP_ID_SHAPE.test(v);
export const newTopicAgentId = () => "ta_" + crypto.randomBytes(16).toString("hex");
export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
// 时间守卫（评审七 P1-3 / 八 P2）：用 isCanonicalMs 核**本仓规范时间范围**（挡 toISOString 会抛的越界，
// 也挡 now=2.6e14 这种不抛但产六位年份的非规范 ISO）→ 非规范一律 null，事务入口收成 bad_time，绝不进到取锁/写盘。
const isoOrNull = (now) => isCanonicalMs(now) ? canonicalIso(now) : null;
const BAD_TIME = { ok: false, commit: "not_committed", reason: "bad_time" };

/** 规范化（键排序递归）后 JSON —— 用于目标/证明的稳定比较（评审 G6/G7：不能用键序敏感的 JSON.stringify）。 */
const stable = (v) => Array.isArray(v) ? v.map(stable) : (isObj(v) ? Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {}) : v);
export const canonKey = (v) => JSON.stringify(stable(v));

/* ─────────────────────────── 路径（受验派生，评审 P1-7） ─────────────────────────── */

function realUserHome() {
  try { const h = os.userInfo().homedir; if (typeof h === "string" && path.isAbsolute(h)) return h; } catch { /* 说不清 */ }
  return null;
}

/** 账本根：测试注入 FEISHU_BRIDGE_LEDGER_DIR（只覆盖 root），否则 <真实 home>/.claude/feishu-bridge/ledger。 */
function ledgerRoot(env = process.env) {
  const inj = env?.[LEDGER_DIR_ENV];
  if (typeof inj === "string" && inj.length > 0 && path.isAbsolute(inj)) return inj;
  const home = realUserHome();
  return home ? path.join(home, ".claude", "feishu-bridge", "ledger") : null;
}
/** 只读派生同源导出（doctor ⑭ 枚举账本目录用）：同一概念只住一处，不许第二份路径派生。 */
export const ledgerRootFor = (env = process.env) => ledgerRoot(env);

/**
 * 账本根受验核验（唯一校验器，#R19 四轮 P1：doctor ⑭ 根协议复用它，不再手写第二份）：
 * root 在场时必须——非 symlink、realpath 可解、逐层 realpath 边界（realpath === 词法 resolve，
 * 即路径任一层都不是符号链接，父层别名会被拒）、真目录、权限精确 0700（#R24 P1-1）。
 * 末级缺席 ≠ 合法缺席（#R24 P1-2）：向上找最深现存父目录并核 realpath 与词法一致，
 * 父层别名 → root_not_canonical；父链受验且目标确实缺席才允许 root_absent
 * （mustExistRoot:false 同样拒父层 symlink，只是允许末级本身不存在）。
 * 返回 { ok:true, root: realRoot } 或 { ok:false, reason, why? }。
 */
export function validateLedgerRoot({ env = process.env, mustExistRoot = true } = {}) {
  const root = ledgerRoot(env);
  if (!root || !path.isAbsolute(root)) return { ok: false, reason: "no_root" };
  let firstSeen = false; // 首次 lstat 是否看到 root 在场（#R27 P1）
  try {
    const st0 = fs.lstatSync(root);
    firstSeen = true;
    if (st0.isSymbolicLink()) return { ok: false, reason: "root_symlink" };
  } catch (err) { if (err?.code !== "ENOENT") return { ok: false, reason: "root_unresolvable", why: String(err.code ?? err.message) }; }
  let realRoot, rootResolved = true;
  try { realRoot = fs.realpathSync(root); }
  catch (err) {
    if (err?.code !== "ENOENT") return { ok: false, reason: "root_unresolvable", why: String(err.code ?? err.message) };
    // #R27 P1：首次 lstat 在场而 realpath ENOENT = “在场→缺席”相邻竞态（现场在变化），
    // 与复核处同折 root_unresolvable，不得当成合法缺席走父链盘点。
    if (firstSeen) return { ok: false, reason: "root_unresolvable", why: "根在首次核验后消失（lstat 在场→realpath 缺席）" };
    // #R24 P1-2：realpath ENOENT 只证明末级不存在，父链里可能藏着 symlink（<tmp>/link/missing）。
    // 逐级先 lstatSync（#R26 P1-1：statSync 会跟随 symlink，悬空别名指向永不存在的目标时
    // ENOENT 会被当成“分量也不存在”继续向上，漏掉别名本身）：词法分量在场且是 symlink
    // → 立即 root_not_canonical；只有分量确实 ENOENT 才继续向上。
    let probe = path.dirname(root);
    for (;;) {
      let pst;
      try { pst = fs.lstatSync(probe); }
      catch (e2) {
        if (e2?.code !== "ENOENT") return { ok: false, reason: "root_unresolvable", why: String(e2.code ?? e2.message) };
        const parent = path.dirname(probe);
        if (parent === probe) return { ok: false, reason: "root_unresolvable", why: "父链全不存在" };
        probe = parent;
        continue;
      }
      if (pst.isSymbolicLink()) return { ok: false, reason: "root_not_canonical" };
      break; // 现存非 symlink 分量 = 最深现存祖先
    }
    let realParent;
    try { realParent = fs.realpathSync(probe); }
    catch (e3) { return { ok: false, reason: "root_unresolvable", why: String(e3.code ?? e3.message) };
    }
    if (realParent !== path.resolve(probe)) return { ok: false, reason: "root_not_canonical" };
    if (mustExistRoot) return { ok: false, reason: "root_absent" };
    realRoot = root; rootResolved = false;
  }
  if (rootResolved && realRoot !== path.resolve(root)) return { ok: false, reason: "root_not_canonical" };
  if (!rootResolved) return { ok: true, root: realRoot }; // mustExistRoot:false 的合法缺席：末级不存在，无复核对象
  // 复核（#R26 P1-2）：realpath 已成功再 lstat 失败 = 现场在变化（EIO/EACCES/并发消失），
  // 全部受控折 root_unresolvable 带错误码——不得吞成 ok:true，也不得折 root_absent（它刚才还在）。
  let st;
  try { st = fs.lstatSync(realRoot); }
  catch (e4) { return { ok: false, reason: "root_unresolvable", why: "根复核 lstat：" + String(e4.code ?? e4.message) }; }
  if (!st.isDirectory()) return { ok: false, reason: "root_not_dir" };
  if ((st.mode & 0o777) !== 0o700) return { ok: false, reason: "root_perms" }; // #R24 P1-1：现存根精确 0700
  return { ok: true, root: realRoot };
}

/**
 * 由 endpointId 派生受验目录：root 必须存在且是真目录（realpath 自洽），dir=root/endpoint；
 * dir 若已存在必是真目录（非符号链接）且 realpath 落在 realpath(root) 下。首次 init 时 dir 尚不存在（允许）。
 * 返回 { ok, dir, root } 或 { ok:false, reason }。
 */
export function resolveEndpointDir(endpointId, { env = process.env, mustExistRoot = true } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "bad_endpoint" };
  // 根段核验唯一化（#R19 四轮 P1）：同一份协议只住 validateLedgerRoot。
  const r = validateLedgerRoot({ env, mustExistRoot });
  if (!r.ok) return r;
  const realRoot = r.root;
  const dir = path.join(realRoot, endpointId);
  try {
    const lst = fs.lstatSync(dir);
    if (!lst.isDirectory()) return { ok: false, reason: "dir_not_dir" };       // 符号链接 / 文件冒充
    if ((lst.mode & 0o777) !== 0o700) return { ok: false, reason: "dir_perms" }; // 精确 0700（评审五 P2）
    const realDir = fs.realpathSync(dir);
    if (realDir !== path.join(realRoot, endpointId)) return { ok: false, reason: "dir_identity" };
  } catch (err) { if (err?.code !== "ENOENT") return { ok: false, reason: "dir_unresolvable", why: String(err.code ?? err.message) }; }
  return { ok: true, dir, root: realRoot };
}

const ledgerPaths = (dir) => ({ ledger: path.join(dir, "ledger.json"), prev: path.join(dir, "ledger.json.prev"), lock: path.join(dir, "ledger.lock") });

/* ─────────────────────────── 记录 schema（封闭） ─────────────────────────── */

const BINDING = ["none", "pending", "active", "dormant"];
const SESSION = ["absent", "present"];
const ANCHOR = ["absent", "present"];
const LINK = ["absent", "present"];
const GENERATION = ["n/a", "pending", "current", "historical"];

const FAMILIES = Object.freeze({
  A1: ["none", "present", "absent", "absent", "n/a"],
  A2: ["active", "present", "absent", "absent", "n/a"],
  A3: ["active", "present", "present", "present", "n/a"],
  "A4-full": ["dormant", "present", "present", "present", "n/a"],
  "A4-bare": ["dormant", "present", "absent", "absent", "n/a"],
  B1: ["pending", "absent", "present", "absent", "pending"],
  B3: ["active", "present", "present", "present", "current"],
  "B3'": ["dormant", "present", "present", "present", "current"],
  B4: ["active", "present", "present", "present", "historical"],
});

export function familyOf(facts) {
  if (!isObj(facts)) return null;
  const tuple = [facts.binding, facts.session, facts.anchor, facts.locator_link_proof, facts.generation];
  for (const [name, row] of Object.entries(FAMILIES)) if (row.every((v, i) => v === tuple[i])) return name.startsWith("A4") ? "A4" : name;
  return null;
}

const targetProblem = (t) => {
  if (!isObj(t)) return "binding_target 不是对象";
  if (typeof t.project_root !== "string" || !path.isAbsolute(t.project_root)) return "project_root 不是绝对路径";
  if (t.runtime === "claude") {
    if (keysOf(t) !== "claude_session_id,project_root,runtime") return "claude target 字段集不对";
    if (typeof t.claude_session_id !== "string" || !UUID_SHAPE.test(t.claude_session_id)) return "claude_session_id 形状不对";
  } else if (t.runtime === "codex") {
    if (keysOf(t) !== "codex_task_id,codex_thread_id,project_root,runtime") return "codex target 字段集不对";
    if (typeof t.codex_task_id !== "string" || !CODEX_ID_SHAPE.test(t.codex_task_id) || typeof t.codex_thread_id !== "string" || !CODEX_ID_SHAPE.test(t.codex_thread_id)) return "codex target id 形状不对";
  } else return "target.runtime 不是 claude/codex";
  return null;
};

const matchedFieldsBad = (mf) => !(Array.isArray(mf) && mf.length === 4 && mf.every((v, i) => v === MATCHED_FIELDS[i]));

const bindingProofProblem = (p) => {
  if (!isObj(p)) return "binding_proof 不是对象";
  if (typeof p.authorized_by !== "string" || !AUTHORIZED_BY_SHAPE.test(p.authorized_by)) return "authorized_by 形状不对";
  if (!isCanonicalIso(p.authorized_at)) return "authorized_at 不规范";
  if (p.kind === "attach") {
    if (keysOf(p) !== "authorized_at,authorized_by,claim_key,kind") return "attach proof 字段集不对";
    if (typeof p.claim_key !== "string" || !CLAIM_KEY_SHAPE.test(p.claim_key)) return "attach.claim_key 形状不对";
  } else if (p.kind === "pairing") {
    if (keysOf(p) !== "authorized_at,authorized_by,kind,matched_fields,matched_om") return "pairing proof 字段集不对";
    if (typeof p.matched_om !== "string" || !OM_SHAPE.test(p.matched_om)) return "pairing.matched_om 形状不对";
    if (matchedFieldsBad(p.matched_fields)) return "pairing.matched_fields 不是完整有序四项";
  } else if (p.kind === "retarget") {
    if (keysOf(p) !== "authorized_at,authorized_by,kind,new_target,old_target") return "retarget proof 字段集不对";
    if (targetProblem(p.old_target) || targetProblem(p.new_target)) return "retarget old/new_target 形状不对";
  } else if (p.kind === "migrated") {
    if (keysOf(p) !== "authorized_at,authorized_by,kind,legacy_source_digest,migration_operation_id") return "migrated proof 字段集不对";
    if (typeof p.migration_operation_id !== "string" || !OP_ID_SHAPE.test(p.migration_operation_id)) return "migrated.migration_operation_id 形状不对";
    if (typeof p.legacy_source_digest !== "string" || !SHA_SHAPE.test(p.legacy_source_digest)) return "migrated.legacy_source_digest 形状不对";
  } else return "binding_proof.kind 不在 {attach,pairing,retarget,migrated}";
  return null;
};

const linkProofProblem = (r) => {
  if (!isObj(r)) return "locator_link_proof_ref 不是对象";
  if (r.kind === "migrated") {
    if (keysOf(r) !== "kind,legacy_source_digest,migration_operation_id") return "link migrated 字段集不对";
    if (typeof r.migration_operation_id !== "string" || !OP_ID_SHAPE.test(r.migration_operation_id)) return "link migrated.migration_operation_id 形状不对";
    if (typeof r.legacy_source_digest !== "string" || !SHA_SHAPE.test(r.legacy_source_digest)) return "link migrated.legacy_source_digest 形状不对";
    return null;
  }
  if (keysOf(r) !== "by_identity,kind,matched_at,matched_fields,matched_om") return "link proof 字段集不对";
  if (r.kind !== "pairing_merge" && r.kind !== "f4_anchor") return "link proof.kind 不对";
  if (typeof r.matched_om !== "string" || !OM_SHAPE.test(r.matched_om)) return "link matched_om 形状不对";
  if (!isCanonicalIso(r.matched_at)) return "matched_at 不规范";
  if (matchedFieldsBad(r.matched_fields)) return "link matched_fields 不是完整有序四项";
  if (r.by_identity !== "user") return "by_identity 只认 user";
  return null;
};

export function liveProblem(rec, id) {
  if (!isObj(rec)) return "记录不是对象";
  const allowed = "aliases,anchor_candidate,binding_proof,binding_target,chat_id,created_at,facts,generation_lineage_id,kind,locator_link_proof_ref,origin_operation_id,topic_agent_id,updated_at";
  if (keysOf(rec) !== allowed) return "live 字段集不对";
  if (rec.topic_agent_id !== id || !isId(id)) return "topic_agent_id 形状/一致性不对";
  if (typeof rec.chat_id !== "string" || !CHAT_SHAPE.test(rec.chat_id)) return "chat_id 形状不对";
  if (!isCanonicalIso(rec.created_at) || !isCanonicalIso(rec.updated_at)) return "created_at/updated_at 不规范";
  if (!isOperationId(rec.origin_operation_id)) return "origin_operation_id 形状不对";
  const f = rec.facts;
  if (!isObj(f) || keysOf(f) !== "anchor,binding,generation,locator_link_proof,session") return "facts 字段集不对";
  if (!BINDING.includes(f.binding) || !SESSION.includes(f.session) || !ANCHOR.includes(f.anchor) || !LINK.includes(f.locator_link_proof) || !GENERATION.includes(f.generation)) return "facts 取值越界";
  const fam = familyOf(f);
  if (fam === null) return "facts 不属于任何合法族";
  const a = rec.aliases;
  if (!isObj(a) || keysOf(a) !== "root_om,session_id") return "aliases 字段集不对";
  const sidP = typeof a.session_id === "string" && a.session_id.length > 0;
  const omP = typeof a.root_om === "string" && a.root_om.length > 0;
  if (a.session_id !== null && (!sidP || !AILY_SESSION_SHAPE.test(a.session_id))) return "aliases.session_id 形状不对";
  if (a.root_om !== null && (!omP || !OM_SHAPE.test(a.root_om))) return "aliases.root_om 形状不对";
  if (sidP !== (f.session === "present")) return "session 别名与 facts.session 不一致";
  if (omP !== (f.anchor === "present")) return "root_om 别名与 facts.anchor 不一致";
  const wantProof = f.binding === "active" || f.binding === "dormant";
  if (wantProof !== (rec.binding_proof !== null)) return "binding_proof 与 binding 不一致";
  if (rec.binding_proof !== null) {
    const bp = bindingProofProblem(rec.binding_proof); if (bp) return bp;
    const kind = rec.binding_proof.kind;
    const okKind = (fam === "A2" || fam === "A3") ? (kind === "attach" || kind === "retarget")
      : (fam === "B3" || fam === "B3'" || fam === "B4") ? (kind === "pairing" || kind === "retarget" || kind === "migrated")
        : (fam === "A4") ? (kind === "attach" || kind === "pairing" || kind === "retarget" || kind === "migrated") : false;
    if (!okKind) return "binding_proof.kind 与族不匹配";
  }
  if ((f.locator_link_proof === "present") !== (rec.locator_link_proof_ref !== null)) return "locator_link_proof 与 ref 不一致";
  if (rec.locator_link_proof_ref !== null) {
    if (!(f.session === "present" && f.anchor === "present")) return "link=present 必须 session∧anchor present";
    const lp = linkProofProblem(rec.locator_link_proof_ref); if (lp) return lp;
    if ((fam === "B3" || fam === "B3'" || fam === "B4") && rec.locator_link_proof_ref.kind !== "pairing_merge" && rec.locator_link_proof_ref.kind !== "migrated") return "B3/B3'/B4 的 link 必须 pairing_merge/migrated";
  }
  const genNotNa = f.generation !== "n/a";
  if (genNotNa !== (rec.generation_lineage_id !== null)) return "generation≠n/a ⇔ lineage_id≠null 不成立";
  if (genNotNa && f.anchor !== "present") return "generation≠n/a ⇒ anchor=present 不成立";
  if (rec.generation_lineage_id !== null && (typeof rec.generation_lineage_id !== "string" || !LINEAGE_SHAPE.test(rec.generation_lineage_id))) return "generation_lineage_id 形状不对";
  if (f.generation === "pending" && f.binding !== "pending") return "generation=pending ⇔ binding=pending 不成立";
  if ((f.binding === "none") !== (rec.binding_target === null)) return "binding_target=null ⇔ binding=none 不成立";
  if (rec.binding_target !== null) { const tp = targetProblem(rec.binding_target); if (tp) return tp; }
  if (rec.anchor_candidate !== null && (typeof rec.anchor_candidate !== "string" || !OM_SHAPE.test(rec.anchor_candidate))) return "anchor_candidate 形状不对";
  return null;
}

/** proof-组合校验器（§3.1 生命周期组合表）：证明**组合**，不只单 kind。
 *   ① binding=migrated ⇒ 必有 link 且 link=migrated（migrated 只成对出现；
 *      A4-bare 无 link 却带 migrated binding ⇒ 拒）。
 *   ② link=migrated ⇒ binding ∈ {migrated, retarget, attach(A3 或 A4 继承)}；
 *      (pairing|attach 非继承|null) + migrated link ⇒ 拒。
 *   ③ (attach, migrated) A3/A4 继承：A3 ⇒ origin=attach_a3；A4 ⇒ origin=经合法 unbind(terminal_family=A4) 继承 A3，
 *      且 origin 的直接前驱触碰交易恰为 attach_a3(affected_id=id)（#R34 P1：弃任意 .find()，须紧邻 unbind）；二者都要求
 *      link 的 migration_operation_id 指向合法 migrate_seed/migrate_repair 且 result digest 逐字相符（G13-mig ①② 的 link 侧）。
 *      #R32 P1：另要求因果 migrate < attach_a3（含全局不变量：最新触及该 id 的 op === origin_operation_id）。
 */
/** R32 P1：operation 的 result 触到哪些记录 id（用于全局因果顺序不变量）。initialize_shadow / authority_cutover 不触及记录 id。 */
function opTouchedIds(op) {
  const r = op?.result;
  if (!r) return [];
  switch (op.op_type) {
    case "create_a1":
    case "create_b1": return r.created_id == null ? [] : [r.created_id];
    case "seed": return Array.isArray(r.seeded_ids) ? r.seeded_ids : [];
    case "activate": return [r.surviving_id, r.tombstoned_id, r.demoted_historical_id].filter((x) => x != null);
    case "void": return r.voided_id == null ? [] : [r.voided_id];
    case "attach_a2":
    case "attach_a3":
    case "anchor":
    case "restore":
    case "unbind": return r.affected_id == null ? [] : [r.affected_id];
    case "retarget": return Array.isArray(r.affected_ids) ? r.affected_ids : [];
    case "migrate_seed": return Array.isArray(r.seeded) ? r.seeded.map((s) => s.topic_agent_id) : [];
    case "migrate_repair": return r.repaired_id == null ? [] : [r.repaired_id];
    default: return [];
  }
}

function proofCombinationProblem(rec, id, doc) {
  const bpKind = rec.binding_proof?.kind ?? null;
  const lpKind = rec.locator_link_proof_ref?.kind ?? null;
  if (bpKind === "migrated" && lpKind !== "migrated") return "binding=migrated 必须 pair link=migrated";
  if (lpKind === "migrated") {
    if (bpKind !== "migrated" && bpKind !== "retarget" && bpKind !== "attach") return "link=migrated 的 binding 只能是 migrated/retarget/attach(A3/A4 继承)";
    if (bpKind === "attach") {
      const fam = familyOf(rec.facts);
      const op = doc.operations[rec.origin_operation_id];
      if (fam === "A3") {
        // A3 直接：origin 必须是把它置成 A3(attach) 的 attach_a3（affected_id=id）。
        if (!op || op.op_type !== "attach_a3" || op.result?.affected_id !== id) return "(attach, migrated) 需 A3 继承 origin=attach_a3(affected_id=id)";
      } else if (fam === "A4") {
        // #R30 P1.1：A4 经 A3 的**合法 unbind** 继承——unbind/restore 保持 proof（规格 §3.1「A4 继承 migrated 合法」）。
        //   判据：origin=unbind(terminal_family=A4, affected_id=id)，且账本确有把本 id 置成 A3(attach) 的 attach_a3 op
        //   （否则 attach binding 无从谈起，只是伪造）。migrate B4→unbind→attach(A3)→unbind 第四笔即此。
        if (!op || op.op_type !== "unbind" || op.result?.terminal_family !== "A4" || op.result?.affected_id !== id) return "(attach, migrated) 的 A4 需经合法 unbind(terminal_family=A4, affected_id=id) 继承 A3";
        // #R34 P1：继承必须是 unbind(origin) 的**直接前驱**（弃用任意顺序 .find()）。
        //   按 result_revision 为该 id 建触及序列；origin 的直接前驱触及交易必须恰为 attach_a3(affected_id=id)。
        //   探针 migrate@2→attach@3→retarget@4→unbind@5：.find() 挑 attach@3 判区间仍过，但 retarget@4 才是 origin 的
        //   直接前驱（且已改 binding proof），故伪造终态应拒。旧 .find() 只证“存在某笔 attach_a3”，不证“紧邻 unbind”。
        const seq = Object.values(doc.operations)
          .filter((o) => opTouchedIds(o).includes(id))
          .sort((a, b) => a.result_revision - b.result_revision);
        const originIdx = seq.findIndex((o) => o === op);
        const prev = originIdx >= 1 ? seq[originIdx - 1] : null;
        if (!prev || prev.op_type !== "attach_a3" || prev.result?.affected_id !== id)
          return "(attach, migrated) 的 A4 需 A3 继承：账本无该 id 的 attach_a3 op 作为 unbind(origin) 的直接前驱（须紧邻、而非 migrate/retarget 等时隔；R34）";
        const migClOp = doc.operations[rec.locator_link_proof_ref.migration_operation_id];
        const migClRev = migClOp && (migClOp.op_type === "migrate_seed" || migClOp.op_type === "migrate_repair") ? migClOp.result_revision : null;
        if (migClRev !== null && !(migClRev < prev.result_revision))
          return "(attach, migrated) 的 A4 需因果顺序：migrate < attach_a3（R32）";
      } else {
        return "(attach, migrated) 只在 A3 继承 / A4 继承合法";
      }
      const lp = rec.locator_link_proof_ref;
      const mop = doc.operations[lp.migration_operation_id];
      if (!mop || (mop.op_type !== "migrate_seed" && mop.op_type !== "migrate_repair")) return "(attach, migrated) 的 link 未指向合法 migrate op";
      if (mop.op_type === "migrate_seed") {
        if (!mop.result.seeded.some((s) => s.topic_agent_id === id && s.legacy_source_digest === lp.legacy_source_digest)) return "(attach, migrated) 的 link 与 migrate_seed result 不符";
      } else if (mop.result.repaired_id !== id || mop.result.legacy_source_digest !== lp.legacy_source_digest) {
        return "(attach, migrated) 的 link 与 migrate_repair result 不符";
      }
    }
  }
  return null;
}

export function tombstoneProblem(rec, id) {
  if (!isObj(rec) || keysOf(rec) !== "forwards_to,kind,merged_at,origin_operation_id,proof_ref,topic_agent_id") return "tombstone 字段集不对";
  if (rec.topic_agent_id !== id || !isId(id)) return "tombstone id 不一致";
  if (!isId(rec.forwards_to)) return "forwards_to 形状不对";
  if (rec.forwards_to === id) return "forwards_to 自指";
  if (!isCanonicalIso(rec.merged_at)) return "merged_at 不规范";
  if (!isOperationId(rec.origin_operation_id)) return "origin_operation_id 形状不对";
  const p = rec.proof_ref;
  if (!isObj(p) || keysOf(p) !== "kind,matched_fields,om" || p.kind !== "pairing") return "proof_ref 字段集/kind 不对";
  if (typeof p.om !== "string" || !OM_SHAPE.test(p.om)) return "proof_ref.om 形状不对";
  if (matchedFieldsBad(p.matched_fields)) return "proof_ref.matched_fields 不是完整有序四项";
  return null;
}

export function voidedProblem(rec, id) {
  if (!isObj(rec) || keysOf(rec) !== "kind,origin_operation_id,reason,root_om,topic_agent_id,voided_at") return "voided 字段集不对";
  if (rec.topic_agent_id !== id || !isId(id)) return "voided id 不一致";
  if (typeof rec.root_om !== "string" || !OM_SHAPE.test(rec.root_om)) return "root_om 形状不对";
  if (!isCanonicalIso(rec.voided_at)) return "voided_at 不规范";
  if (!REASON_ENUM.includes(rec.reason)) return "reason 不在封闭枚举"; // 评审 P1-1：不接受任意文本
  if (!isOperationId(rec.origin_operation_id)) return "origin_operation_id 形状不对";
  return null;
}

function recordProblem(rec, id) {
  if (!isObj(rec) || typeof rec.kind !== "string") return "记录缺 kind";
  if (rec.kind === "live") return liveProblem(rec, id);
  if (rec.kind === "forwarding_tombstone") return tombstoneProblem(rec, id);
  if (rec.kind === "voided_audit") return voidedProblem(rec, id);
  return "kind 不在三选一";
}

/* ─────────────────────────── operations 判别联合（评审 P1-1，G12） ─────────────────────────── */

/** ID 数组：非空、每项合法、严格升序（⇒ 唯一）。评审二 P1-3。 */
const idArrayOk = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => isId(x)) && a.every((x, i) => i === 0 || a[i - 1] < x);
// seed 允许空 seeded_ids（全存在的成功空 op 占用 request_key，评审七 P1-2）：仍要求有序且逐项 isId。
const idArraySortedMaybeEmpty = (a) => Array.isArray(a) && a.every((x) => isId(x)) && a.every((x, i) => i === 0 || a[i - 1] < x);
const allDistinct = (...xs) => { const seen = new Set(); for (const x of xs) { if (x === null) continue; if (seen.has(x)) return false; seen.add(x); } return true; };

const RESULT_SHAPE = Object.freeze({
  initialize_shadow: (r) => keysOf(r) === "revision" && r.revision === 1,
  create_a1: (r) => keysOf(r) === "created_id" && isId(r.created_id),
  create_b1: (r) => keysOf(r) === "created_id" && isId(r.created_id),
  seed: (r) => keysOf(r) === "seeded_ids" && idArraySortedMaybeEmpty(r.seeded_ids),
  activate: (r) => keysOf(r) === "demoted_historical_id,surviving_id,tombstoned_id" && isId(r.surviving_id) && isId(r.tombstoned_id) && (r.demoted_historical_id === null || isId(r.demoted_historical_id)) && allDistinct(r.surviving_id, r.tombstoned_id, r.demoted_historical_id),
  void: (r) => keysOf(r) === "voided_id" && isId(r.voided_id),
  attach_a2: (r) => keysOf(r) === "affected_id,terminal_family" && isId(r.affected_id) && r.terminal_family === "A2",
  attach_a3: (r) => keysOf(r) === "affected_id,terminal_family" && isId(r.affected_id) && r.terminal_family === "A3",
  anchor: (r) => keysOf(r) === "affected_id" && isId(r.affected_id),
  restore: (r) => keysOf(r) === "affected_id" && isId(r.affected_id),
  unbind: (r) => keysOf(r) === "affected_id,terminal_family" && isId(r.affected_id) && (r.terminal_family === "A4" || r.terminal_family === "B3'"),
  retarget: (r) => keysOf(r) === "affected_ids,new_target,old_target,unit" && idArrayOk(r.affected_ids) && (r.unit === "record" || r.unit === "lineage") && !targetProblem(r.old_target) && !targetProblem(r.new_target) && canonKey(r.old_target) !== canonKey(r.new_target),
  migrate_seed: (r) => keysOf(r) === "authorized_at,authorized_by,seeded" && typeof r.authorized_by === "string" && AUTHORIZED_BY_SHAPE.test(r.authorized_by) && isCanonicalIso(r.authorized_at) && Array.isArray(r.seeded) && r.seeded.every((s) => isObj(s) && isId(s.topic_agent_id) && typeof s.legacy_source_digest === "string" && SHA_SHAPE.test(s.legacy_source_digest)) && r.seeded.every((s, i) => i === 0 || r.seeded[i - 1].topic_agent_id < s.topic_agent_id),
  migrate_repair: (r) => keysOf(r) === "authorized_at,authorized_by,expected_projection_digest,from_family,legacy_source_digest,next_projection_digest,repaired_id,to_family" && isId(r.repaired_id) && typeof r.authorized_by === "string" && AUTHORIZED_BY_SHAPE.test(r.authorized_by) && isCanonicalIso(r.authorized_at) && [r.expected_projection_digest, r.next_projection_digest, r.legacy_source_digest].every((s) => typeof s === "string" && SHA_SHAPE.test(s)) && MIGRATE_FAMILIES.includes(r.from_family) && MIGRATE_FAMILIES.includes(r.to_family) && (r.from_family === "B1" ? r.to_family === "B1" : r.to_family !== "B1"),
  authority_cutover: (r) => keysOf(r) === "revision_at_cutover" && Number.isInteger(r.revision_at_cutover) && r.revision_at_cutover >= 1,
});

function operationProblem(op, topRevision) {
  if (!isObj(op) || keysOf(op) !== "fingerprint,op_type,request_key,result,result_revision,terminal_kind") return "operation 字段集不对";
  if (typeof op.request_key !== "string" || !REQUEST_KEY_SHAPE.test(op.request_key)) return "request_key 形状不对";
  if (!OP_TYPES.includes(op.op_type)) return "op_type 越界";
  if (op.terminal_kind !== op.op_type) return "terminal_kind 必须等于 op_type";
  if (typeof op.fingerprint !== "string" || !SHA_SHAPE.test(op.fingerprint)) return "fingerprint 形状不对";
  if (!Number.isInteger(op.result_revision) || op.result_revision < 1 || op.result_revision > topRevision) return "result_revision 越界";
  if (!isObj(op.result) || !RESULT_SHAPE[op.op_type](op.result)) return op.op_type + " result 形状不对";
  if (op.op_type === "initialize_shadow" && op.result_revision !== 1) return "initialize 的 result_revision 必为 1";
  if (op.op_type === "authority_cutover" && op.result.revision_at_cutover !== op.result_revision) return "cutover 的 revision_at_cutover 必等于 result_revision";
  return null;
}

/** G13（评审二 P1-3）：记录的 origin op 与该记录**逐 op 精确相容**——终态族、result 内容都要对得上。 */
function opConsistentWithRecord(op, id, rec) {
  const r = op.result;
  const fam = rec.kind === "live" ? familyOf(rec.facts) : null;
  switch (op.op_type) {
    case "initialize_shadow": case "authority_cutover": return false; // 不产生记录
    case "create_a1": return rec.kind === "live" && r.created_id === id && fam === "A1";
    case "create_b1": return rec.kind === "live" && r.created_id === id && fam === "B1";
    case "seed": return rec.kind === "live" && r.seeded_ids.includes(id); // seed 插入的族由 liveProblem 已校
    case "activate":
      if (r.surviving_id === id) return rec.kind === "live" && fam === "B3";
      if (r.tombstoned_id === id) return rec.kind === "forwarding_tombstone" && rec.forwards_to === r.surviving_id;
      if (r.demoted_historical_id === id) return rec.kind === "live" && fam === "B4";
      return false;
    case "void": return rec.kind === "voided_audit" && r.voided_id === id;
    case "attach_a2": return rec.kind === "live" && r.affected_id === id && fam === "A2";
    case "attach_a3": case "anchor": return rec.kind === "live" && r.affected_id === id && fam === "A3";
    case "restore": return rec.kind === "live" && r.affected_id === id && fam === "B3";
    case "unbind": return rec.kind === "live" && r.affected_id === id && fam === r.terminal_family;
    case "retarget": {
      if (rec.kind !== "live" || !r.affected_ids.includes(id)) return false;
      if (canonKey(rec.binding_target) !== canonKey(r.new_target)) return false; // 当前 target 必等 result.new_target
      if (rec.facts.binding === "pending") return rec.binding_proof === null; // B1：proof 仍 null
      return rec.binding_proof !== null && rec.binding_proof.kind === "retarget" && canonKey(rec.binding_proof.new_target) === canonKey(r.new_target) && canonKey(rec.binding_proof.old_target) === canonKey(r.old_target);
    }
    case "migrate_seed": {
      if (rec.kind !== "live" || !r.seeded.some((s) => s.topic_agent_id === id)) return false;
      // B1：proof 全 null；B3/B3'/B4：migrated 双证引用本笔 seed op，同 op 同 digest，且与 result.seeded 逐字匹配
      if (fam === "B1") return rec.binding_proof === null && rec.locator_link_proof_ref === null;
      if (fam !== "B3" && fam !== "B3'" && fam !== "B4") return false;
      if (rec.binding_proof?.kind !== "migrated" || rec.locator_link_proof_ref?.kind !== "migrated") return false;
      const bp = rec.binding_proof, lp = rec.locator_link_proof_ref;
      const opId = rec.origin_operation_id;
      if (bp.migration_operation_id !== opId || lp.migration_operation_id !== opId) return false;
      if (bp.legacy_source_digest !== lp.legacy_source_digest) return false;
      const seed = r.seeded.find((s) => s.topic_agent_id === id);
      if (!seed || seed.legacy_source_digest !== bp.legacy_source_digest) return false;
      return bp.authorized_by === r.authorized_by && bp.authorized_at === r.authorized_at;
    }
    case "migrate_repair": {
      if (rec.kind !== "live" || r.repaired_id !== id || fam !== r.to_family) return false;
      if (fam === "B1") return rec.binding_proof === null && rec.locator_link_proof_ref === null;
      if (fam !== "B3" && fam !== "B3'" && fam !== "B4") return false;
      if (rec.binding_proof?.kind !== "migrated" || rec.locator_link_proof_ref?.kind !== "migrated") return false;
      const bp = rec.binding_proof, lp = rec.locator_link_proof_ref;
      const opId = rec.origin_operation_id;
      if (bp.migration_operation_id !== opId || lp.migration_operation_id !== opId) return false;
      if (bp.legacy_source_digest !== lp.legacy_source_digest || r.legacy_source_digest !== bp.legacy_source_digest) return false;
      return bp.authorized_by === r.authorized_by && bp.authorized_at === r.authorized_at;
    }
    default: return false;
  }
}

/* ─────────────────────────── 整账本校验（G1–G15） ─────────────────────────── */

export function validateLedger(doc, { endpointId } = {}) {
  const bad = (why) => ({ ok: false, reason: "ledger_corrupt", why });
  if (!isObj(doc)) return bad("账本不是对象");
  if (keysOf(doc) !== "artifact_type,authority_mode,chain,endpoint_id,operations,records,revision,schema_version") return bad("顶层字段集不对");
  if (doc.schema_version !== SCHEMA_VERSION || doc.artifact_type !== ARTIFACT_TYPE) return bad("schema/artifact 不对");
  if (doc.authority_mode !== "shadow" && doc.authority_mode !== "authoritative") return bad("authority_mode 越界");
  if (!CHAIN.includes(doc.chain)) return bad("chain 越界（链不可从 opaque endpoint 还原，顶层显式存）");
  if (!Number.isInteger(doc.revision) || doc.revision < 1) return bad("revision 不是正整数");
  if (typeof endpointId === "string" && doc.endpoint_id !== endpointId) return bad("endpoint_id 与路径不符"); // G2
  if (typeof doc.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(doc.endpoint_id)) return bad("endpoint_id 形状不对");
  if (!isObj(doc.records) || !isObj(doc.operations)) return bad("records/operations 不是对象");
  if (Object.keys(doc.operations).length > MAX_OPERATIONS) return bad("operations 超上限");

  // G12：逐 op 判别联合 + 恰一笔 initialize_shadow + **每 revision 恰一笔（result_revision 覆盖 1..revision）**
  //       + (op_type,fingerprint) 唯一（评审三 P1-3：否则伪造同 revision 的 op 能过、重放 .find 选到伪造）。
  let initCount = 0;
  const revSeen = new Set(), fpSeen = new Set(), rkSeen = new Set();
  for (const [opId, op] of Object.entries(doc.operations)) {
    if (!isOperationId(opId)) return bad("operation key 形状不对：" + opId);
    const p = operationProblem(op, doc.revision);
    if (p !== null) return bad("operation " + opId + "：" + p);
    if (op.op_type === "initialize_shadow") initCount += 1;
    if (revSeen.has(op.result_revision)) return bad("result_revision 重复（G12）：" + op.result_revision);
    revSeen.add(op.result_revision);
    const fpKey = op.op_type + ":" + op.fingerprint;
    if (fpSeen.has(fpKey)) return bad("(op_type,fingerprint) 重复（G12）");
    fpSeen.add(fpKey);
    if (rkSeen.has(op.request_key)) return bad("request_key 全局重复（G12，评审五 P1-1）：" + op.request_key);
    rkSeen.add(op.request_key);
  }
  if (initCount !== 1) return bad("必须恰一笔 initialize_shadow operation（G12）");
  if (Object.keys(doc.operations).length !== doc.revision) return bad("operations 数必等于 revision（每 revision 恰一笔，G12）");
  for (let r = 1; r <= doc.revision; r += 1) if (!revSeen.has(r)) return bad("result_revision 不连续，缺 " + r + "（G12）");

  const liveByLocator = new Map();
  const live = [];
  let liveCount = 0;
  for (const [id, rec] of Object.entries(doc.records)) {
    const p = recordProblem(rec, id);
    if (p !== null) return bad(id + "：" + p);
    if (!(rec.origin_operation_id in doc.operations)) return bad(id + "：origin_operation_id 不在 operations 表（G13）");
    if (!opConsistentWithRecord(doc.operations[rec.origin_operation_id], id, rec)) return bad(id + "：origin op 与本记录不相容（G13）");
    if (rec.kind === "live") {
      liveCount += 1; live.push([id, rec]);
      for (const loc of [rec.aliases.session_id, rec.aliases.root_om]) {
        if (typeof loc === "string" && loc) {
          if (liveByLocator.has(loc)) return bad("locator 全局不唯一（G3）：" + loc); // G3
          liveByLocator.set(loc, id);
        }
      }
    }
  }
  if (liveCount > MAX_LIVE) return bad("live 记录超上限");

  // #R32 P1 全局因果不变量：对每条记录，所有 result 触及该 id 的 op 中最新（max result_revision）一笔必须等于 origin_operation_id。
  //   每个触及 id 的 op 都会把该记录 origin 置成自己；因此若存在比 origin 更新仍触及 id 的 op ⇒ 不可能历史（如 unbind@rev4→attach_a3@rev5）。
  //   覆盖 migrate/repair 来源早于 attach/retarget 等继承操作。initialize_shadow / authority_cutover 不触及记录 id（opTouchedIds 归空）。
  const maxTouch = new Map(); // id → { rev, opId }
  for (const [opId, op] of Object.entries(doc.operations)) {
    if (op.op_type === "initialize_shadow" || op.op_type === "authority_cutover") continue;
    const touched = opTouchedIds(op);
    if (touched.length === 0) continue;
    for (const tId of touched) {
      const cur = maxTouch.get(tId);
      if (!cur || op.result_revision > cur.rev) maxTouch.set(tId, { rev: op.result_revision, opId });
    }
  }
  for (const [id, rec] of Object.entries(doc.records)) {
    const max = maxTouch.get(id);
    if (max && max.opId !== rec.origin_operation_id) return bad(id + "：最新触及该 id 的 op(" + max.opId + "@rev" + max.rev + ") 不等于 origin(" + rec.origin_operation_id + ")（因果不变量 R32）");
  }

  // §3.1 proof-组合校验：绑定/link 证明的组合，不只看单个 kind（A4-bare+migrated、migrated+pairing_merge 等）。
  for (const [id, rec] of live) {
    const pc = proofCombinationProblem(rec, id, doc);
    if (pc !== null) return bad(id + "：" + pc);
  }

  // G13-mig / G13-repair（§5.1 唯一权威）：任一 migrated proof ⇒ 交叉不变量。
  //   G13-mig：migration_operation_id 指向 op_type∈{migrate_seed,migrate_repair} 的存在 op；seed 的 result.seeded 含本 id 且 digest 逐字相等
  //   （repair 则 result.repaired_id===本 id 且 digest 逐字相等）；binding migrated 的 authorized_by/at 必与 op result 逐字相等；
  //   link 与 binding 的 migrated 引用同一 op 与同一 digest。
  //   G13-repair：origin 指向 repair ⇒ ① 现投影 digest 重算===result.next；② 指纹与 result 两投影 digest 重算一致；③ repaired_id===id。
  for (const [id, rec] of live) {
    const bp = rec.binding_proof, lp = rec.locator_link_proof_ref;
    const hasMigB = bp?.kind === "migrated";
    const hasMigL = lp?.kind === "migrated";
    if (!hasMigB && !hasMigL) continue;
    const migOpId = hasMigB ? bp.migration_operation_id : lp.migration_operation_id;
    if (hasMigB && hasMigL && (bp.migration_operation_id !== lp.migration_operation_id || bp.legacy_source_digest !== lp.legacy_source_digest)) return bad(id + "：binding 与 link 的 migrated 引用不同 op/不同 digest（G13-mig）");
    const mop = doc.operations[migOpId];
    if (!mop) return bad(id + "：migration_operation_id 不在 operations（G13-mig）");
    if (mop.op_type !== "migrate_seed" && mop.op_type !== "migrate_repair") return bad(id + "：migration_operation_id 指向非 migrate 交易（G13-mig）");
    const digest = hasMigB ? bp.legacy_source_digest : lp.legacy_source_digest;
    const mr = mop.result;
    if (mop.op_type === "migrate_seed") {
      const seed = mr.seeded.find((s) => s.topic_agent_id === id);
      if (!seed || seed.legacy_source_digest !== digest) return bad(id + "：migrate_seed 的 result.seeded digest 与 proof 不一致（G13-mig）");
    } else {
      if (mr.repaired_id !== id || mr.legacy_source_digest !== digest) return bad(id + "：migrate_repair 的 result digest 与 proof 不一致（G13-mig）");
    }
    if (hasMigB && (bp.authorized_by !== mr.authorized_by || bp.authorized_at !== mr.authorized_at)) return bad(id + "：binding migrated 授权与 op result 不一致（G13-mig）");
    if (rec.origin_operation_id === migOpId && mop.op_type === "migrate_repair") {
      if (migrateProjectionDigest(rec) !== mr.next_projection_digest) return bad(id + "：repair 后投影 digest 与 result.next 不一致（G13-repair）");
      if (fingerprintOf("migrate_repair", { request_key: mop.request_key, topic_agent_id: id, expected_projection_digest: mr.expected_projection_digest, next_projection_digest: mr.next_projection_digest }) !== mop.fingerprint) return bad(id + "：repair 指纹与 result 两投影 digest 不一致（G13-repair）");
    }
  }

  // G9：tombstone 直指存活 live（**一跳**，不允许链）
  for (const [id, rec] of Object.entries(doc.records)) {
    if (rec.kind !== "forwarding_tombstone") continue;
    const t = doc.records[rec.forwards_to];
    if (!t) return bad("tombstone 悬空（G9）：" + id);
    if (t.kind !== "live") return bad("tombstone 未直指 live（G9，不许链）：" + id);
  }

  // G5 / G6
  const lineages = new Map();
  for (const [, rec] of live) {
    const lid = rec.generation_lineage_id;
    if (lid === null) continue;
    const e = lineages.get(lid) ?? { current: 0, pending: 0, target: null, seen: false };
    if (rec.facts.generation === "current") e.current += 1;
    if (rec.facts.generation === "pending") e.pending += 1;
    const tk = canonKey(rec.binding_target);
    if (!e.seen) { e.target = tk; e.seen = true; } else if (e.target !== tk) return bad("同 lineage binding_target 不一致（G6）：" + lid);
    lineages.set(lid, e);
    if (e.current > 1) return bad("lineage 多个 current（G5）：" + lid);
    if (e.pending > 1) return bad("lineage 多个 pending（G5）：" + lid);
  }

  // G7：占用者 = {pending, active, B3'}；A4 不占用；同 target 只允许同一非空 lineage / 单个无谱系。
  const occ = new Map();
  for (const [id, rec] of live) {
    const fam = familyOf(rec.facts);
    const isOcc = rec.facts.binding === "pending" || rec.facts.binding === "active" || fam === "B3'";
    if (!isOcc || rec.binding_target === null) continue;
    const tk = canonKey(rec.binding_target);
    const e = occ.get(tk) ?? { lineages: new Set(), noLineage: new Set() };
    if (rec.generation_lineage_id === null) e.noLineage.add(id); else e.lineages.add(rec.generation_lineage_id);
    occ.set(tk, e);
  }
  for (const [tk, e] of occ) {
    if (e.noLineage.size > 1) return bad("同 target 多个无谱系占用者（G7）：" + tk);
    if (e.lineages.size > 1) return bad("同 target 落在多个 lineage（G7）：" + tk);
    if (e.lineages.size >= 1 && e.noLineage.size >= 1) return bad("同 target 谱系与无谱系占用者并存（G7）：" + tk);
  }

  // G11：binding_target.runtime === 顶层 chain；retarget 跨字段
  const chain = doc.chain;
  for (const [, rec] of live) {
    if (rec.binding_target !== null && rec.binding_target.runtime !== chain) return bad("binding_target.runtime 与 endpoint 链不符（G11）");
    if (rec.binding_proof !== null && rec.binding_proof.kind === "retarget") {
      if (canonKey(rec.binding_proof.old_target) === canonKey(rec.binding_proof.new_target)) return bad("retarget proof old===new（G11）");
      if (canonKey(rec.binding_target) !== canonKey(rec.binding_proof.new_target)) return bad("当前 binding_target ≠ proof.new_target（G11）");
    }
  }

  // G14：authority_mode 双向 ⇔ 恰一笔有效 authority_cutover
  const cutovers = Object.values(doc.operations).filter((op) => op.op_type === "authority_cutover");
  if (doc.authority_mode === "shadow" && cutovers.length !== 0) return bad("shadow 却含 cutover op（G14）");
  if (doc.authority_mode === "authoritative" && cutovers.length !== 1) return bad("authoritative 需恰一笔 cutover（G14）");

  return { ok: true };
}

/* ─────────────────────────── fd 绑定读 ─────────────────────────── */

export function readLedger(dir) {
  const file = ledgerPaths(dir).ledger;
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err?.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", why: err?.code === "ELOOP" ? "符号链接" : String(err.code ?? err.message) };
    }
    let st;
    try { st = fs.fstatSync(fd); } catch (err) { return { status: "unreadable", why: "fstat：" + String(err.code ?? err.message) }; }
    if (!st.isFile() || st.nlink !== 1) return { status: "unreadable", why: "不是单硬链接普通文件" };
    if ((st.mode & 0o777) !== 0o600) return { status: "unreadable", why: "账本文件权限非精确 0600" }; // 评审五 P2
    if (st.size > MAX_FILE_BYTES) return { status: "unreadable", why: "文件超上限" };
    let raw;
    try { raw = fs.readFileSync(fd); } catch (err) { return { status: "unreadable", why: String(err.code ?? err.message) }; }
    if (raw.length > MAX_FILE_BYTES) return { status: "unreadable", why: "读后超上限" }; // 评审 P2-1：读后复核
    let doc;
    try { doc = JSON.parse(raw.toString("utf-8")); } catch { return { status: "unreadable", why: "不是 JSON" }; }
    return { status: "read", doc, bytes: raw, sha256: sha256(raw) };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }
}

export function loadLedger(dir, { endpointId } = {}) {
  const r = readLedger(dir);
  if (r.status === "absent") return { ok: false, reason: "absent" };
  if (r.status === "unreadable") return { ok: false, reason: "unreadable", why: r.why };
  const v = validateLedger(r.doc, { endpointId });
  if (!v.ok) return v;
  return { ok: true, doc: r.doc, bytes: r.bytes, sha256: r.sha256 };
}

/** 由 endpointId 载入（受验目录派生 + 校验）。给路由/投影用。 */
export function loadByEndpoint(endpointId, { env = process.env } = {}) {
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return { ok: false, reason: d.reason, why: d.why };
  return loadLedger(d.dir, { endpointId });
}

/* ─────────────────────────── 写：唯一 tmp + prevTmp + fenced 提交（四态，释放折进结果） ─────────────────────────── */

function writeTmpBytes(dir, base, bytes) {
  const tmp = path.join(dir, base + "." + process.pid + "." + crypto.randomUUID());
  let fd = null;
  try {
    try { fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (err) { return { ok: false, why: "临时文件建不出：" + String(err.code ?? err.message) }; }
    // 写端同 fd 复核（评审二 P2-2）：O_EXCL|O_CREAT|O_NOFOLLOW 建的必是全新普通文件，nlink===1；不符即拒。
    try { const st = fs.fstatSync(fd); if (!st.isFile() || st.nlink !== 1) return { ok: false, why: "tmp 不是单硬链接普通文件", tmp }; }
    catch (err) { return { ok: false, why: "tmp fstat：" + String(err.code ?? err.message), tmp }; }
    try {
      let off = 0;
      while (off < bytes.length) { const n = fs.writeSync(fd, bytes, off, bytes.length - off); if (!(n > 0)) throw new Error("short write"); off += n; }
      fs.fsyncSync(fd);
    } catch (err) { return { ok: false, why: String(err.code ?? err.message), tmp }; }
    return { ok: true, tmp };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }
}

function fsyncDir(dir) { let fd = null; try { fd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(fd); return null; } catch (err) { return String(err.code ?? err.message); } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } } }

/**
 * 一笔账本写。**内部函数**——只由 gated 普通事务与受 capability 的维护事务调用（都不接受外部 dir/ungated）。
 * gated=true 过维护门（acquirePublishLock）；gated=false 走维护内部（acquireLockUngated），仅在
 * capability 校验通过后被调用。replay:{opType,inputs} 前置：命中即幂等（不写、返回原 result_revision）。
 * 释放失败折进四态结果（评审 P1-5），不在 finally 静默吞。
 */
function writeLedger({ dir, endpointId, gated, requestKey = null, replay = null, mutate, staleMs = LOCK_STALE_MS, allowAbsent = false, _inject = null }) {
  const inj = _inject ?? {};
  const { lock: lockDir, prev: prevPath, ledger: ledgerPath } = ledgerPaths(dir);
  const acq = gated ? acquirePublishLock : acquireLockUngated;
  // 取锁总墙钟预算内有限重试（评审三 P2-1：单调 deadline，含 acquire/reap 自身耗时，不只累计 sleep）。
  const monoMs = () => Number(process.hrtime.bigint() / 1000000n);
  const deadline = monoMs() + LOCK_WAIT_MS; // 单调时钟（评审四 P2-1）：不受系统时钟回拨
  let got;
  for (;;) {
    got = acq(lockDir, { staleMs, reapUnrecognized: false }); // 评审 P1-4：账本锁是新资源，不回收未知旧目录锁
    if (got.ok || got.reason !== "publisher_busy" || monoMs() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, Math.max(1, deadline - monoMs())));
  }
  if (!got.ok) return { ok: false, commit: "not_committed", reason: got.reason === "maintenance" ? "maintenance" : got.reason === "publisher_busy" ? "ledger_busy" : got.reason, why: got.error ?? got.reason ?? null, path: got.path ?? null };

  let released = { ok: true };
  let committed = false, committedRevision = null, committedResult = null;
  let ltTmp = null, ptTmp = null; // 提到外层（评审三 P1-6）：not_committed 出口（含 catch）都能报残留 tmp
  const outerResidue = () => [ltTmp, ptTmp].filter(Boolean);
  const finalize = (result) => {
    released = safeRelease(lockDir);
    return foldRelease(result, released);
  };
  try {
    const cur = readLedger(dir);
    if (cur.status === "unreadable") return finalize({ ok: false, commit: "not_committed", reason: "ledger_corrupt", why: cur.why });
    if (cur.status === "absent") {
      // 初始化归维护层（第 2 块）：仅受验 capability 的 ungated 维护路径可允许从 absent 建 revision=1；
      // gated 普通事务与不受验路径一律拒（既不重初始化、也不容忍账本被偷换）。
      if (!(gated === false && allowAbsent)) return finalize({ ok: false, commit: "not_committed", reason: "absent" });
    }
    let currentDoc = null, oldBytes = null;
    if (cur.status === "read") {
      const v = validateLedger(cur.doc, { endpointId });
      if (!v.ok) return finalize({ ok: false, commit: "not_committed", reason: "ledger_corrupt", why: v.why });
      currentDoc = cur.doc; oldBytes = cur.bytes;
      // **按 request_key 做全局唯一的重放/冲突判定（评审五 P1-1）**：request_key 是外部请求身份，
      // operation 里独立存。同 key + 载荷相同（指纹匹配本 tx 任一候选 op）→ 幂等重放（返回原 result/revision）；
      // 同 key + 载荷不同 → request_conflict（调用方 bug，拒，不新增第二笔）。
      if (typeof requestKey === "string") {
        const prior = Object.values(currentDoc.operations).find((op) => op.request_key === requestKey);
        if (prior) {
          const descs = typeof replay === "function" ? replay(currentDoc) : [];
          const match = descs.some((d) => d.opType === prior.op_type && fingerprintOf(d.opType, d.inputs) === prior.fingerprint);
          if (match) return finalize({ ok: true, commit: "committed_clean", revision: prior.result_revision, result: prior.result, idempotent: true });
          return finalize({ ok: false, commit: "not_committed", reason: "request_conflict", why: "同 request_key 换了载荷" });
        }
      }
    }
    const m = mutate(currentDoc);
    if (!m.ok) {
      // 重放/冲突判定统一走上面的 request_key 前置（评审七 P1-2：seed 全存在也落空 op，不再有状态式 noop 免写）。
      return finalize({ ok: false, commit: "not_committed", reason: m.reason, why: m.why });
    }
    const nextV = validateLedger(m.next, { endpointId });
    if (!nextV.ok) return finalize({ ok: false, commit: "not_committed", reason: "would_corrupt", why: nextV.why });
    const nextBytes = Buffer.from(JSON.stringify(m.next, null, 2) + "\n", "utf-8");
    if (nextBytes.length > MAX_FILE_BYTES) return finalize({ ok: false, commit: "not_committed", reason: "over_capacity" });

    // 首次提交也要返回**刚落盘 operation 的 result**（评审三 P1-4）：取本笔（result_revision === 新 revision）。
    const newOp = Object.values(m.next.operations).find((o) => o.result_revision === m.next.revision);
    committedResult = newOp ? newOp.result : null;
    const lt = writeTmpBytes(dir, "ledger.json", nextBytes);
    if (lt.tmp) ltTmp = lt.tmp;
    if (!lt.ok) return finalize({ ok: false, commit: "not_committed", reason: "tmp_unwritable", why: lt.why, residue: outerResidue() });
    if (oldBytes !== null) { const pt = writeTmpBytes(dir, "ledger.json.prev", oldBytes); if (pt.tmp) ptTmp = pt.tmp; if (!pt.ok) return finalize({ ok: false, commit: "not_committed", reason: "tmp_unwritable", why: "prevTmp：" + pt.why, residue: outerResidue() }); }

    if (inj.afterTmp) inj.afterTmp();
    let renameErr = null;
    const fenced = commitWhileHeld(lockDir, () => {
      if (ptTmp) { try { fs.renameSync(ptTmp, prevPath); ptTmp = null; } catch (err) { renameErr = err; return; } }
      if (inj.beforeLedgerRename) inj.beforeLedgerRename();
      try { fs.renameSync(ltTmp, ledgerPath); ltTmp = null; } catch (err) { renameErr = err; }
    });
    // 提交阶段取锁异常投影（评审六 P2）：lock_lost 单列；reap_residue/reap_busy/io_error 保留原 reason 与 path/error，
    // 不折成瞬时 ledger_busy（持久残骸不能伪装成"稍后重试即可"）。
    if (!fenced.ok) return finalize({ ok: false, commit: "not_committed", reason: fenced.reason === "lock_lost" ? "lock_lost" : (fenced.reason ?? "ledger_busy"), why: fenced.why ?? fenced.reason ?? null, path: fenced.path ?? null, residue: outerResidue() });
    if (renameErr !== null) return finalize({ ok: false, commit: "not_committed", reason: "commit_failed", why: String(renameErr.code ?? renameErr.message), residue: outerResidue() });
    // 第二次 rename（ledger）成功 = **已过提交点**（评审二 P1-5）：此后任何异常都不许报 not_committed。
    committed = true; committedRevision = m.next.revision;
    if (inj.afterLedgerRename) inj.afterLedgerRename();

    const reapResidue = fenced.reapUncleared ? [String(fenced.reapUncleared.path ?? "reap")] : [];
    const dirErr = inj.failDirFsync ? "injected" : fsyncDir(dir);
    if (dirErr !== null) return finalize({ ok: true, commit: "committed_durability_uncertain", revision: m.next.revision, result: committedResult, why: "目录 fsync 失败：" + dirErr, residue: reapResidue });
    if (reapResidue.length > 0) return finalize({ ok: true, commit: "committed_with_residue", revision: m.next.revision, result: committedResult, residue: reapResidue });
    return finalize({ ok: true, commit: "committed_clean", revision: m.next.revision, result: committedResult });
  } catch (err) {
    // 已过提交点的异常：账本已变，报已提交（durability_uncertain），绝不谎报 not_committed（评审二 P1-5）。
    if (committed) return finalize({ ok: true, commit: "committed_durability_uncertain", revision: committedRevision, result: committedResult, why: "提交后异常：" + String(err?.message ?? err) });
    return finalize({ ok: false, commit: "not_committed", reason: "exception", why: String(err?.message ?? err), residue: outerResidue() });
  }
}

/** 释放锁，把结果收成 { ok, reason }，不抛。
 *  P2-2：**非干净释放**（absent / not_owner / exception / reapUncleared）仍要带上**账本锁路径**——
 *  不然 foldRelease 的 lockUncleared.path 拿到 null，维护 CLI 只报“交不还”却说不出是哪儿（如“账本主锁交不还：null”）。
 *  clean = ok===true && !absent && !reapUncleared；仅干净释放保持原样。 */
function safeRelease(lockDir) {
  let r;
  try { r = releasePublishLock(lockDir); } catch (err) { r = { ok: false, reason: "release_exception", why: String(err?.message ?? err) }; }
  const clean = r.ok === true && !r.absent && !r.reapUncleared;
  if (!clean && r.path == null) r = { ...r, path: lockDir };
  return r;
}

/** 把释放结果折进四态（评审 P1-5）：只有**干净释放**才不折——absent（持有期锁消失）/not_owner/reapUncleared/异常都折成残骸；已提交则 with_residue/lock_state_unclear，不谎报 clean。 */
function foldRelease(result, released) {
  const clean = released.ok === true && !released.absent && !released.reapUncleared;
  if (clean) return result;
  // 释放残骸也保留结构化 path/error（评审六 P2）：reapUncleared 同时含 error 与 path 时两者都带上，不二选一。
  const lockUncleared = { reason: released.reason ?? (released.absent ? "lock_absent_on_release" : released.reapUncleared ? "reap_residue_uncleared" : "unknown"), why: released.why ?? (released.reapUncleared ? String(released.reapUncleared.error ?? "") : null), path: released.reapUncleared?.path ?? released.path ?? null };
  if (result.ok) {
    const commit = result.commit === "committed_durability_uncertain" ? result.commit : "committed_with_residue";
    return { ...result, commit, lockUncleared, lock_state: "unclear" };
  }
  return { ...result, lockUncleared };
}

/* ─────────────────────────── operations 盖章 ─────────────────────────── */

/** §5.1：fingerprint 首字段恒为 op_type（域分隔），再规范 JSON → sha256。 */
export function fingerprintOf(opType, inputs) {
  return sha256(Buffer.from(JSON.stringify(stable({ op_type: opType, ...inputs })), "utf-8"));
}

/** 克隆、bump revision、盖一笔不可覆盖 operation（result 过 RESULT_SHAPE），再 mutateRecords。返回 next。 */
function stampAndBuild(doc, { opType, inputs, result, mutateRecords }) {
  const next = structuredClone(doc);
  next.revision = doc.revision + 1;
  const opId = crypto.randomUUID();
  next.operations[opId] = { op_type: opType, terminal_kind: opType, request_key: inputs.request_key ?? null, fingerprint: fingerprintOf(opType, inputs), result_revision: next.revision, result };
  mutateRecords(next, opId);
  return next;
}

/* ─────────────────────────── 维护 capability（评审 P1-4：fail-closed，第 2 块维护层装真的） ─────────────────────────── */

/* ─────────────────────────── 维护 capability（评审 P1-4：fail-closed，第 2 块维护层装真的） ─────────────────────────── */

// init/cutover 是**维护层（第 2 块）**的写：virgin 目录盘点、§5.2 WAL、初始化收据、双射对账接口、capability
// （active maintenance operation / gate token / lease）由维护编排（ledger-operation.mjs）构造，本模块**读实文件独立核验**、
// 不信任入参自述、无环境变量旁路（评审 5 P1-1）；只经 initializeShadow/authorityCutover 这两个**窄事务入口**写，
// **不导出可接受任意 mutate 的通用 ungated writer**。

/** 维护 capability 核验：读实文件（active / journal / gate / lease + ledger step）逐项独立核对，任一不过 → 结构化拒。 */
function _maintenanceVerifier(capability, endpointId, opType, env = process.env) {
  const fail = (reason, why) => ({ ok: false, reason, why });
  if (!capability || typeof capability !== "object") return fail("bad_capability", "capability 缺失");
  const wantKind = opType === "initialize_shadow" ? "ledger_init" : "ledger_cutover";
  const wantPhase = opType === "initialize_shadow" ? "ledger_initializing" : "ledger_cutting_over";
  const wantSub = opType === "initialize_shadow" ? "init" : "cutover";
  const { token } = capability;
  // 维护目录 / 门位置一律从环境派生（评审 F1）：capability 只带 token/kind/endpointId，不信任其自述路径
  const maintDir = maintenanceDir(env);
  const gateFile = maintenanceGatePath(env);
  if (typeof maintDir !== "string" || maintDir.length === 0) return fail("maintenance_dir_unknown", "维护目录说不清（环境 " + (process.env.FEISHU_BRIDGE_MAINTENANCE_DIR ? "覆盖" : "真实 home 取不到") + "）");
  if (typeof gateFile !== "string" || gateFile.length === 0) return fail("gate_path_unknown", "门位置说不清");
  if (typeof token !== "string" || !UUID_SHAPE.test(token)) return fail("bad_operation_token", "capability token 不是 UUID");
  // active 指向的 journal（readJournal 已内嵌 journalProblem 校验 1.2 + operation_kind×step 闭合）
  const active = readActive({ dir: maintDir });
  if (active.state !== "active") return fail("no_active_operation", "没有 active operation（" + active.state + "）");
  if (active.token !== token) return fail("operation_token_mismatch", "active 指向的 token 与 capability 不一致");
  const j = readJournal({ dir: maintDir, token });
  if (j.state !== "valid") return fail("journal_unreadable", "journal " + j.state + (j.why ? "：" + j.why : ""));
  if (j.doc.schema_version !== JOURNAL_SCHEMA) return fail("journal_schema", "journal 不是 " + JOURNAL_SCHEMA);
  if (j.doc.operation_kind !== wantKind) return fail("operation_kind_mismatch", "operation_kind " + j.doc.operation_kind + " ≠ " + wantKind);
  if (j.doc.phase !== wantPhase) return fail("phase_mismatch", "阶段 " + j.doc.phase + " ≠ " + wantPhase);
  // ledger step 已在且 prepared、target 与 endpoint 一致（WAL 已落）
  const ls = j.doc.steps.find((s) => s.kind === "ledger");
  if (!ls) return fail("ledger_step_absent", "journal 尚无 ledger step");
  if (ls.state !== "prepared") return fail("ledger_step_not_prepared", "ledger step 状态 " + ls.state);
  const m = /^ledger:(endpoint_[0-9a-f]{24}):(init|cutover)$/u.exec(ls.id);
  if (!m || m[2] !== wantSub || m[1] !== endpointId) return fail("ledger_step_identity", "ledger step 身份与 endpoint/kind 不符");
  if (!CHAIN.includes(ls.chain)) return fail("ledger_chain_bad", "ledger step 缺 chain 或非法");
  // 门在且 token 与 journal 的 gate step intended_after 一致
  const gate = readGate({ file: gateFile, now: Date.now() });
  if (gate.state !== "active") return fail("gate_not_active", "门 " + gate.state + (gate.why ? "：" + gate.why : ""));
  if (gate.payload?.token !== token) return fail("gate_token_mismatch", "门 token 与 operation 不一致");
  // 租约存在且属于该 operation（leasePath(dir, token) 即 operation 专属）
  const holder = leaseHolder({ dir: maintDir, token });
  if (!holder.present) return fail("lease_absent", "operation 租约不存在");
  if (holder.unreadable) return fail("lease_unreadable", "租约读不出：" + holder.why);
  if (!holder.alive) return fail("lease_dead", "租约持有者 pid " + holder.pid + " 已不在");
  if (holder.at !== null && !isCanonicalIso(holder.at)) return fail("lease_payload_bad", "租约 owner.at 不是规范化 ISO");
  // 评审 P1-3：capability 必须证明**当前进程确实持有**该 operation 租约实例（commitWhileHeld 的 token fencing），
  // 且 plan 必须由 journal 里已落盘的 ledger step 重建，不得接受调用方任意 planIn。重建后逐字段绑定 before/intended_after。
  const lpath = leasePath(maintDir, token);
  const binding = commitWhileHeld(lpath, () => {
    const ld = resolveEndpointDir(endpointId, { env });
    if (!ld.ok) return ld;
    const plan = rebuildPlanFromStep({ endpointId, chain: ls.chain, token, ledgerDir: ld.dir, step: ls });
    if (!plan.ok) return plan;
    const bindProblem = bindPlanToStep(plan, ls);
    if (bindProblem !== null) return { ok: false, reason: "plan_binding_mismatch", why: bindProblem };
    return { ok: true, plan };
  });
  if (!binding.ok || !binding.run) return fail("lease_lost", "本过程不再持有 operation 租约实例（commitWhileHeld：" + (binding?.reason ?? "lock_lost") + "）");
  // 评审 P1-3：WAL 所有权转换后 reap 锁残骸没收干净（收成 reapUncleared 挂在 binding 上）→ fail-closed 拒写，不许带着残骸继续落盘。
  if (binding.reapUncleared) return fail("lease_reap_uncleared", "WAL 所有权转换后 reap 残骸未清（" + (binding.reapUncleared.path ?? "?") + "）");
  if (!binding.run.ok) return fail("plan_rebuild", binding.run.reason + (binding.run.why !== undefined ? "：" + binding.run.why : ""));
  return { ok: true, maintenanceDir: maintDir, doc: j.doc, ledgerStep: ls, plan: binding.run.plan };
}

/** 由 journal 里已落盘的 ledger step 幂等重建 WAL 蓝图（P1-3：不接受调用方任意 planIn）。 */
function rebuildPlanFromStep({ endpointId, chain, token, ledgerDir, step }) {
  const sub = step.id.endsWith(":init") ? "init" : "cutover";
  if (sub === "init") return initPlan({ endpointId, chain, requestKey: token, operationId: token });
  const L = loadLedger(ledgerDir, { endpointId });
  if (!L.ok) return { ok: false, reason: L.reason, why: L.why ?? null };
  if (L.doc.authority_mode !== "shadow") return { ok: false, reason: "mode_not_shadow", why: "重建 cutover plan 需 shadow" };
  const digest = step.intended_after?.bijection_digest;
  if (typeof digest !== "string" || !SHA_SHAPE.test(digest)) return { ok: false, reason: "bad_digest", why: "ledger step 的 intended_after.bijection_digest 缺失或非法" };
  return cutoverPlan({ endpointId, chain, requestKey: token, operationId: token, shadowDoc: L.doc, shadowSha: L.sha256, digest });
}

/** 逐字段绑定 plan.before / plan.intended_after 与 ledger step（P1-3：字段名相同、键序无关、值全等才放行）。 */
function bindPlanToStep(plan, ls) {
  const eq = (a, b) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every((k) => a[k] === b[k]); };
  if (!eq(plan.before, ls.before)) return "plan.before 与 ledger step 的 before 不一致";
  if (!eq(plan.intendedAfter, ls.intended_after)) return "plan.intended_after 与 ledger step 的 intended_after 不一致";
  return null;
}

/** 锁内封闭盘点：目录里除 ledger.lock 外不得有任何制品（v1 首笔无 .prev / 无 tmp / 无 reap 家族 / 无未知）。 */
function virginInventory(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return { ok: false, why: "目录读不出：" + String(err?.code ?? err?.message ?? err) }; }
  const junk = names.filter((n) => n !== "ledger.lock");
  if (junk.length > 0) return { ok: false, why: "非 virgin：目录含 " + junk.join("、") };
  return { ok: true };
}

/** 机器级初始化收据（B-3 的最小投影：aggregate 全量收据属第 2 块另一分支）：扫描维护目录 journal，看该 endpoint 是否已被初始化 / 已切权威。 */
/** 门内双射对账接口（§8/§5 cutover 前置）——恒拒 reconciler_absent（T4 硬前置）：
 *  ipsp-1/policy-store 块落地前可执行 cutover 保持 fail-closed；且 4e 规定 reconciler
 *  ok:true 必须四件同证（ledger 双射 ∧ 三 sidecar 投影相等），只接 ledger 双射会让
 *  cutover 在无 sidecar 证明下通过。真接线等 policy-store 块，届时按 4e 接。
 */
export function reconcileShadow({ endpointId, shadowDoc } = {}) {
  void endpointId; void shadowDoc;
  return { ok: false, reason: "reconciler_absent", why: "双射对账器未接入，cutover fail-closed" };
}

/** 评审 P2：T4 切权威计划对账验证——校验 cutover 蓝图是否把对账 digest 封闭绑定到 intended_after
 *  （bijection_digest + endpoint_id 两字段全等才放行）。与 T3a(reconcileShadow：对账门) 明确分开，
 *  不许同一个函数既对账又验证蓝图；T4 只消费对账结果，不自行对账。 */
export function cutoverPlanVerifier(plan, digest, endpointId) {
  if (typeof digest !== "string" || !SHA_SHAPE.test(digest)) return { ok: false, reason: "reconciler_absent", why: "对账器未给合法 digest" };
  if (plan.intendedAfter.bijection_digest !== digest || plan.intendedAfter.endpoint_id !== endpointId) return { ok: false, reason: "plan_mismatch", why: "plan 与对账结果不一致" };
  return { ok: true, digest };
}

/* ─────────────────────────── 维护 WAL 蓝图（幂等构造，给 B-2 步的 intended_after 用） ─────────────────────────── */

/** 幂等构造 revision=1 的 shadow 账本文档 + 整文件 SHA（init 的 WAL 蓝图）。 */
export function initPlan({ endpointId, chain, requestKey, operationId } = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "bad_endpoint" };
  if (!CHAIN.includes(chain)) return { ok: false, reason: "bad_chain" };
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, reason: "bad_request_key" };
  if (typeof operationId !== "string" || !OP_ID_SHAPE.test(operationId)) return { ok: false, reason: "bad_operation_id" };
  const fingerprint = fingerprintOf("initialize_shadow", { request_key: requestKey, endpoint_id: endpointId, chain });
  const doc = {
    artifact_type: ARTIFACT_TYPE, schema_version: SCHEMA_VERSION, chain, endpoint_id: endpointId,
    authority_mode: "shadow", revision: 1, records: {}, operations: { [operationId]: {
      op_type: "initialize_shadow", terminal_kind: "initialize_shadow", request_key: requestKey, fingerprint,
      result_revision: 1, result: { revision: 1 },
    } },
  };
  const docSha = sha256(Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf-8"));
  return {
    ok: true, operationId, requestKey, fingerprint, kind: "initialize_shadow", doc, sha256: docSha,
    before: { authority_mode: null, endpoint_id: endpointId, fingerprint, ledger_sha256: null, operation_id: operationId, revision: null },
    intendedAfter: { authority_mode: "shadow", endpoint_id: endpointId, fingerprint, ledger_sha256: docSha, operation_id: operationId, revision: 1 },
  };
}

/** 幂等构造 cutover 后的账本文档（authoritative, revision+1, 追加一笔 cutover op）+ 整文件 SHA（cutover 的 WAL 蓝图）。 */
export function cutoverPlan({ endpointId, chain, requestKey, operationId, shadowDoc, shadowSha, digest }) {
  if (!shadowDoc || shadowDoc.authority_mode !== "shadow") return { ok: false, reason: "not_shadow" };
  if (!CHAIN.includes(chain)) return { ok: false, reason: "bad_chain" };
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, reason: "bad_request_key" };
  if (typeof digest !== "string" || !SHA_SHAPE.test(digest)) return { ok: false, reason: "bad_digest" };
  const fingerprint = fingerprintOf("authority_cutover", { request_key: requestKey, endpoint_id: endpointId, bijection_digest: digest });
  const doc = structuredClone(shadowDoc);
  doc.revision += 1;
  doc.authority_mode = "authoritative";
  doc.operations[operationId] = {
    op_type: "authority_cutover", terminal_kind: "authority_cutover", request_key: requestKey, fingerprint,
    result_revision: doc.revision, result: { revision_at_cutover: doc.revision },
  };
  const docSha2 = sha256(Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf-8"));
  return {
    ok: true, operationId, requestKey, fingerprint, kind: "authority_cutover", doc, sha256: docSha2,
    before: { authority_mode: "shadow", endpoint_id: endpointId, fingerprint, ledger_sha256: shadowSha, operation_id: operationId, revision: shadowDoc.revision, bijection_digest: null },
    intendedAfter: { authority_mode: "authoritative", endpoint_id: endpointId, fingerprint, ledger_sha256: docSha2, operation_id: operationId, revision: doc.revision, bijection_digest: digest },
  };
}

/* ─────────────────────────── 记录构造 / 小工具 ─────────────────────────── */

const liveBase = (id, chatId, iso, opId) => ({
  kind: "live", topic_agent_id: id, chat_id: chatId,
  aliases: { session_id: null, root_om: null },
  facts: { binding: "none", session: "absent", anchor: "absent", locator_link_proof: "absent", generation: "n/a" },
  binding_target: null, binding_proof: null, locator_link_proof_ref: null,
  anchor_candidate: null, generation_lineage_id: null,
  origin_operation_id: opId, created_at: iso, updated_at: iso,
});
const liveLocatorInUse = (doc, loc) => loc != null && Object.values(doc.records).some((r) => r.kind === "live" && (r.aliases.session_id === loc || r.aliases.root_om === loc));
const projectionOf = (rec) => { const { origin_operation_id, created_at, updated_at, ...rest } = rec; void origin_operation_id; void created_at; void updated_at; return canonKey(rest); };
// §6 的 C 记录（proof 不进双射比较）：migrate_seed 的“已存在”判定与 migrate_repair 的投影摘要都以此为准——
// proof 是来源证明，会嵌 opId 且不进双射；用 C 记录让投影摘要确定性派生，不依赖随机 opId。
const cRecordOf = (rec) => ({ topic_agent_id: rec.topic_agent_id, chat_id: rec.chat_id, aliases: rec.aliases, facts: rec.facts, generation_lineage_id: rec.generation_lineage_id, binding_target: rec.binding_target });
export const cRecordKey = (rec) => canonKey(cRecordOf(rec));
export const migrateProjectionDigest = (rec) => sha256(Buffer.from(cRecordKey(rec), "utf-8"));
const badTx = (d) => ({ ok: false, commit: "not_committed", reason: d.reason, why: d.why });
/** 写回残骸投影（P2-2 第 5 轮）：成功与失败出口**都要**透传 writeLedger 的 lockUncleared / residue，
 *  否则 ledger-operation 的 commit_residue 分支 sees null，releaseRows 点不出账本主锁路径。 */
const wrNote = (res) => ({ lockUncleared: res?.lockUncleared ?? null, residue: res?.residue ?? null });

/** 普通（gated）事务的公共外壳：派生受验目录 → writeLedger(gated)。 */
function gatedTx({ endpointId, requestKey, env, replay, _inject, mutate }) {
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, commit: "not_committed", reason: "bad_request_key" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return badTx(d);
  return writeLedger({ dir: d.dir, endpointId, gated: true, requestKey, replay, _inject, mutate });
}

/* ─────────────────────────── 维护内部事务（capability 门） ─────────────────────────── */

// init/cutover 是**第 2 块维护层**的写入口，第 1 块只保留恒拒外壳（评审六 P1-1）：删除了当前不可用的正文，
// 不留可绕的准生产实现。第 2 块落地时在此接真 capability（active maintenance op / gate token / lease / 桩状态 +
// 证明 opaque endpoint 属该 chain），并显式规范化、校验、使用调用方原 request_key（不 fallback），
// 只经这两个窄事务写（virgin 盘点 / §5.2 WAL / 初始化收据 / 门内双射对账都在维护层）。

/** initialize_shadow（§5/§5.2）：受验 capability（active maintenance op / gate token / lease / ledger step）+ 原 request_key + virgin 盘点 + 机器级初始化收据，写 revision=1。 */
export function initializeShadow({ endpointId, capability, requestKey, chain, env = process.env, _inject = null } = {}) {
  if (!capability || capability.kind !== "initialize_shadow") return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "kind 不符或缺失" };
  const cap = _maintenanceVerifier(capability, endpointId, "initialize_shadow", env);
  if (!cap.ok) return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: cap.reason + (cap.why ? "：" + cap.why : "") };
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, commit: "not_committed", reason: "bad_request_key" };
  if (!CHAIN.includes(chain)) return { ok: false, commit: "not_committed", reason: "bad_chain" };
  if (chain !== cap.ledgerStep.chain) return { ok: false, commit: "not_committed", reason: "chain_mismatch", why: "入参 chain 与 ledger step 不一致" };
  const plan = cap.plan;
  if (plan.requestKey !== requestKey) return { ok: false, commit: "not_committed", reason: "bad_request_key", why: "重进的 requestKey 与 operation requestKey 不符" };
  if (plan.intendedAfter.endpoint_id !== endpointId) return { ok: false, commit: "not_committed", reason: "plan_mismatch", why: "重进 plan 与该 endpoint 不符" };
  const receipt = endpointReceipt(cap.maintenanceDir, endpointId, { token: capability.token });
  if (!receipt.ok) return { ok: false, commit: "not_committed", reason: "already_initialized", why: receipt.why };
  if (receipt.initDone || receipt.cutoverDone) return { ok: false, commit: "not_committed", reason: "already_initialized", why: "该 endpoint 已被初始化或已切权威" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return badTx(d);
  const res = writeLedger({
    dir: d.dir, endpointId, gated: false, allowAbsent: true, requestKey, _inject,
    replay: () => [{ opType: "initialize_shadow", inputs: { request_key: requestKey, endpoint_id: endpointId, chain } }],
    mutate: (currentDoc) => {
      if (currentDoc !== null) return { ok: false, reason: "not_virgin", why: "账本已存在" };
      const vir = virginInventory(d.dir);
      if (!vir.ok) return { ok: false, reason: "not_virgin", why: vir.why };
      return { ok: true, next: plan.doc };
    },
  });
  if (!res.ok || typeof res.commit !== "string" || !res.commit.startsWith("committed")) return { ok: false, commit: res?.commit ?? "not_committed", reason: res?.reason ?? "written_refused", why: res?.why ?? null, ...wrNote(res) };
  if (res.result?.revision !== 1) return { ok: false, commit: res.commit, reason: "written_refused", why: "写回 revision 不是 1", ...wrNote(res) };
  const reread = readLedger(d.dir);
  if (reread.status !== "read" || reread.sha256 !== plan.sha256) return { ok: false, commit: res.commit, reason: "written_mismatch", why: "落盘 SHA 与蓝图不符", ...wrNote(res) };

  // P2-2（第 5 轮）：成功出口也用统一投影，写提交即便成功，释放残骸/写后残骸也**透传**——
  // 否则 ledger-operation 的 commit_residue 分支拿到的 wr.lockUncleared/residue 是 null，releaseRows 点名不出账本主锁路径。
  return { ok: true, commit: res.commit, revision: 1, result: res.result, sha256: plan.sha256, plan, ...wrNote(res) };
}

/** authority_cutover（§5/§8）：shadow→authoritative 同一不可逆提交；前置 = 门内双射对账通过（fail-closed）+ G14 无已切权威。 */
export function authorityCutover({ endpointId, capability, requestKey, chain, env = process.env, _inject = null } = {}) {
  if (!capability || capability.kind !== "authority_cutover") return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "kind 不符或缺失" };
  const cap = _maintenanceVerifier(capability, endpointId, "authority_cutover", env);
  if (!cap.ok) return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: cap.reason + (cap.why ? "：" + cap.why : "") };
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, commit: "not_committed", reason: "bad_request_key" };
  if (!CHAIN.includes(chain)) return { ok: false, commit: "not_committed", reason: "bad_chain" };
  if (chain !== cap.ledgerStep.chain) return { ok: false, commit: "not_committed", reason: "chain_mismatch", why: "入参 chain 与 ledger step 不一致" };
  const plan = cap.plan;
  if (plan.requestKey !== requestKey) return { ok: false, commit: "not_committed", reason: "bad_request_key", why: "重进的 requestKey 与 operation requestKey 不符" };
  if (plan.intendedAfter.endpoint_id !== endpointId) return { ok: false, commit: "not_committed", reason: "plan_mismatch", why: "重进 plan 与该 endpoint 不符" };
  const receipt = endpointReceipt(cap.maintenanceDir, endpointId, { token: capability.token });
  if (!receipt.ok) return { ok: false, commit: "not_committed", reason: "receipt_problem", why: receipt.why };
  if (receipt.cutoverDone) return { ok: false, commit: "not_committed", reason: "already_cutover", why: "该 endpoint 已切权威" };
  // 评审 P1-5：cutover 窄入口也要求恰一份 done init 收据（没有 init 就切权威 → fail-closed）。
  if (!receipt.initDone) return { ok: false, commit: "not_committed", reason: "init_receipt_missing", why: "切权威要求恰一份已 done 的 init 收据（收据 initDone=false）" };
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return badTx(d);
  const loaded = loadLedger(d.dir, { endpointId });
  if (!loaded.ok) return { ok: false, commit: "not_committed", reason: loaded.reason, why: loaded.why ?? null };
  if (loaded.doc.authority_mode !== "shadow") return { ok: false, commit: "not_committed", reason: "mode_not_shadow", why: "authority_mode=" + loaded.doc.authority_mode };
  if (loaded.doc.chain !== chain) return { ok: false, commit: "not_committed", reason: "chain_mismatch", why: "账本 chain 与入参不符" };
  // 评审 P1-4：cutover 不接调用方注入的 reconciler——真对账未接，恒 fail-closed（reconciler_absent），不许测试/旁路自行对账。
  const rec = reconcileShadow({ endpointId, shadowDoc: loaded.doc });
  if (!rec.ok) return { ok: false, commit: "not_committed", reason: "reconciler_absent", why: rec.why };
  // 评审 P2：T4 蓝图验证独立于 T3a 对账门——一个函数只做一件事，不再把 digest 形状检查与 plan 绑定混在手写块里。
  const t4 = cutoverPlanVerifier(plan, rec.digest, endpointId);
  if (!t4.ok) return { ok: false, commit: "not_committed", reason: t4.reason, why: t4.why };
  const digest = rec.digest;
  const res = writeLedger({
    dir: d.dir, endpointId, gated: false, requestKey, _inject,
    replay: () => [{ opType: "authority_cutover", inputs: { request_key: requestKey, endpoint_id: endpointId, bijection_digest: digest } }],
    mutate: (currentDoc) => {
      if (currentDoc === null) return { ok: false, reason: "absent", why: "账本缺席" };
      if (currentDoc.authority_mode !== "shadow") return { ok: false, reason: "mode_not_shadow" };
      if (Object.values(currentDoc.operations).some((op) => op.op_type === "authority_cutover")) return { ok: false, reason: "already_cutover" };
      if (currentDoc.revision !== plan.before.revision) return { ok: false, reason: "state_moved", why: "账本 revision 变过" };
      return { ok: true, next: plan.doc };
    },
  });
  if (!res.ok || typeof res.commit !== "string" || !res.commit.startsWith("committed")) return { ok: false, commit: res?.commit ?? "not_committed", reason: res?.reason ?? "written_refused", why: res?.why ?? null, ...wrNote(res) };
  if (res.result?.revision_at_cutover !== plan.intendedAfter.revision) return { ok: false, commit: res.commit, reason: "written_refused", why: "写回 revision 与蓝图不符", ...wrNote(res) };
  const reread = readLedger(d.dir);
  if (reread.status !== "read" || reread.sha256 !== plan.sha256) return { ok: false, commit: res.commit, reason: "written_mismatch", why: "落盘 SHA 与蓝图不符", ...wrNote(res) };
  // P2-2（第 5 轮）：同上用统一投影，cutover 的 commit_residue 分支也能点名账本主锁。
  return { ok: true, commit: res.commit, revision: plan.intendedAfter.revision, result: res.result, sha256: plan.sha256, plan, ...wrNote(res) };
}

/* ─────────────────────────── 普通（gated）事务 ─────────────────────────── */

export function createA1({ endpointId, requestKey, chatId, sessionId, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, chat_id: chatId, session_locator: sessionId };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "create_a1", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (typeof sessionId !== "string" || !AILY_SESSION_SHAPE.test(sessionId) || typeof chatId !== "string" || !CHAT_SHAPE.test(chatId)) return { ok: false, reason: "bad_input" };
      if (liveLocatorInUse(doc, sessionId)) return { ok: false, reason: "locator_exists" };
      const id = newTopicAgentId();
      return { ok: true, next: stampAndBuild(doc, { opType: "create_a1", inputs, result: { created_id: id }, mutateRecords: (n, opId) => { const r = liveBase(id, chatId, iso, opId); r.aliases.session_id = sessionId; r.facts.session = "present"; n.records[id] = r; } }) };
    },
  });
}

export function createB1({ endpointId, requestKey, chatId, rootOm, lineageId, bindingTarget, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, chat_id: chatId, root_om: rootOm, lineage_id: lineageId, predetermined_target: bindingTarget };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "create_b1", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (typeof rootOm !== "string" || !OM_SHAPE.test(rootOm) || typeof chatId !== "string" || !CHAT_SHAPE.test(chatId) || typeof lineageId !== "string" || !LINEAGE_SHAPE.test(lineageId)) return { ok: false, reason: "bad_input" };
      if (targetProblem(bindingTarget)) return { ok: false, reason: "bad_target" };
      if (liveLocatorInUse(doc, rootOm)) return { ok: false, reason: "locator_exists" };
      if (Object.values(doc.records).some((r) => r.kind === "live" && r.generation_lineage_id === lineageId && r.facts.generation === "pending")) return { ok: false, reason: "lineage_pending_exists" };
      const id = newTopicAgentId();
      return { ok: true, next: stampAndBuild(doc, { opType: "create_b1", inputs, result: { created_id: id }, mutateRecords: (n, opId) => { const r = liveBase(id, chatId, iso, opId); r.aliases.root_om = rootOm; r.facts.anchor = "present"; r.facts.binding = "pending"; r.facts.generation = "pending"; r.generation_lineage_id = lineageId; r.binding_target = bindingTarget; n.records[id] = r; } }) };
    },
  });
}

/** seed（§5，M1a 批量，gated）：同 id 规范投影相同→幂等跳过；不同→冲突；locator 撞别 id→冲突。 */
export function seedRecords({ endpointId, requestKey, candidates, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now);
  if (iso === null) return BAD_TIME;
  // 请求身份（评审六 P1-1）：seed 的指纹取**调用方给的全量候选集**（规范化后按串排序），与账本当前状态无关。
  // 否则第二次同请求时 toInsert 收缩、指纹变，重放会被误判成 request_conflict。canonKey 对循环对象会抛→收成 bad_candidate（评审七 P1-3）。
  let reqInputs;
  try { reqInputs = { request_key: requestKey, candidates: Array.isArray(candidates) ? candidates.map(canonKey).sort() : candidates }; }
  catch { return { ok: false, commit: "not_committed", reason: "bad_candidate" }; }
  return gatedTx({
    endpointId, requestKey, env, _inject, replay: () => [{ opType: "seed", inputs: reqInputs }],
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, reason: "bad_input" };
      const locatorOwner = new Map();
      for (const [id, r] of Object.entries(doc.records)) { if (r.kind !== "live") continue; for (const loc of [r.aliases.session_id, r.aliases.root_om]) if (typeof loc === "string" && loc) locatorOwner.set(loc, id); }
      const toInsert = [];
      for (const cand of candidates) {
        if (!isObj(cand) || typeof cand.topic_agent_id !== "string") return { ok: false, reason: "bad_candidate" };
        const id = cand.topic_agent_id;
        const staged = { ...cand, origin_operation_id: "00000000-0000-0000-0000-000000000000", created_at: iso, updated_at: iso };
        const p = liveProblem(staged, id);
        if (p !== null) return { ok: false, reason: "bad_candidate", why: id + "：" + p };
        const existing = doc.records[id];
        if (existing) {
          if (existing.kind !== "live") return { ok: false, reason: "conflict", why: id + " 已是非 live" };
          if (projectionOf(existing) !== projectionOf(staged)) return { ok: false, reason: "conflict", why: id + " 投影不同" };
          continue;
        }
        for (const loc of [cand.aliases?.session_id, cand.aliases?.root_om]) if (typeof loc === "string" && loc && locatorOwner.has(loc) && locatorOwner.get(loc) !== id) return { ok: false, reason: "conflict", why: "locator " + loc + " 被 " + locatorOwner.get(loc) + " 占用" };
        toInsert.push(id);
      }
      // 全存在也**落一笔空 seed op**（seeded_ids:[]）占用 request_key（评审七 P1-2）：否则同 key 换候选不会被判 request_conflict。
      const byId = new Map(candidates.map((c) => [c.topic_agent_id, c]));
      return { ok: true, next: stampAndBuild(doc, { opType: "seed", inputs: reqInputs, result: { seeded_ids: [...toInsert].sort() }, mutateRecords: (n, opId) => { for (const id of toInsert) n.records[id] = { ...byId.get(id), origin_operation_id: opId, created_at: iso, updated_at: iso }; } }) };
    },
  });
}

/** 激活（配对归并）B1+A1→B3（§5）：消费受验 F4 结果 f4={matched_om,matched_fields}，不自铸证明。 */
export function activate({ endpointId, requestKey, b1Id, a1Id, f4, authorizedBy, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, b1_id: b1Id, a1_id: a1Id, matched_om: f4?.matched_om };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "activate", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(b1Id) || !isId(a1Id)) return { ok: false, reason: "bad_id" };
      const b1 = doc.records[b1Id], a1 = doc.records[a1Id];
      if (a1?.kind === "forwarding_tombstone" && a1.forwards_to === b1Id && b1?.kind === "live" && b1.facts.binding === "active" && b1.facts.generation === "current") return { ok: false, reason: "already_merged" };
      if (!b1 || b1.kind !== "live" || b1.facts.binding !== "pending") return { ok: false, reason: "b1_not_pending" };
      if (!a1 || a1.kind !== "live" || familyOf(a1.facts) !== "A1") return { ok: false, reason: "a1_not_chat" };
      if (a1.chat_id !== b1.chat_id) return { ok: false, reason: "chat_mismatch" };
      if (!isObj(f4) || typeof f4.matched_om !== "string" || !OM_SHAPE.test(f4.matched_om) || matchedFieldsBad(f4.matched_fields)) return { ok: false, reason: "bad_f4" };
      if (typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      const lineage = b1.generation_lineage_id;
      return { ok: true, next: stampAndBuild(doc, {
        opType: "activate", inputs, result: { surviving_id: b1Id, tombstoned_id: a1Id, demoted_historical_id: null },
        mutateRecords: (n, opId) => {
          let demoted = null;
          // 降旧 current→历史代际必须形成**合法 B4**（评审七 P1-1）：不管旧代际当时是 B3(active) 还是 B3′(dormant，被暂停)，
          // 变历史后一律 binding=active + generation=historical；否则 dormant+historical 不属于任何合法族、下一步整账本校验拒。
          for (const [id, r] of Object.entries(n.records)) if (r.kind === "live" && r.generation_lineage_id === lineage && r.facts.generation === "current" && id !== b1Id) { r.facts.binding = "active"; r.facts.generation = "historical"; r.updated_at = iso; r.origin_operation_id = opId; demoted = id; }
          const s = n.records[b1Id];
          s.aliases.session_id = a1.aliases.session_id; s.facts.session = "present";
          s.facts.binding = "active"; s.facts.generation = "current"; s.facts.locator_link_proof = "present";
          s.binding_proof = { kind: "pairing", authorized_by: authorizedBy, authorized_at: iso, matched_om: f4.matched_om, matched_fields: [...f4.matched_fields] };
          s.locator_link_proof_ref = { kind: "pairing_merge", matched_om: f4.matched_om, matched_at: iso, matched_fields: [...f4.matched_fields], by_identity: "user" };
          s.updated_at = iso; s.origin_operation_id = opId;
          n.records[a1Id] = { kind: "forwarding_tombstone", topic_agent_id: a1Id, forwards_to: b1Id, merged_at: iso, proof_ref: { kind: "pairing", om: f4.matched_om, matched_fields: [...f4.matched_fields] }, origin_operation_id: opId };
          n.operations[opId].result.demoted_historical_id = demoted;
        },
      }) };
    },
  });
}

export function voidPending({ endpointId, requestKey, b1Id, reason, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, b1_id: b1Id, reason };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "void", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(b1Id)) return { ok: false, reason: "bad_id" };
      const b1 = doc.records[b1Id];
      if (!b1 || b1.kind !== "live" || b1.facts.binding !== "pending") return { ok: false, reason: "b1_not_pending" };
      if (!REASON_ENUM.includes(reason)) return { ok: false, reason: "bad_reason" };
      return { ok: true, next: stampAndBuild(doc, { opType: "void", inputs, result: { voided_id: b1Id }, mutateRecords: (n, opId) => { n.records[b1Id] = { kind: "voided_audit", topic_agent_id: b1Id, root_om: b1.aliases.root_om, voided_at: iso, reason, origin_operation_id: opId }; } }) };
    },
  });
}

/** attach 无 F4（§5）A1→A2；A4 双证齐→保留 link 进 A3、写新 attach proof；A4 全无→A2。 */
export function attach({ endpointId, requestKey, id, bindingTarget, claimKey, authorizedBy, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, topic_agent_id: id, target: bindingTarget, claim_key: claimKey, root_om: null, matched_om: null };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "attach_a2", inputs }, { opType: "attach_a3", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live" };
      const fam = familyOf(rec.facts);
      if (fam !== "A1" && fam !== "A4") return { ok: false, reason: "not_attachable" };
      if (targetProblem(bindingTarget)) return { ok: false, reason: "bad_target" };
      if (typeof claimKey !== "string" || !CLAIM_KEY_SHAPE.test(claimKey) || typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      const keepLink = fam === "A4" && rec.facts.locator_link_proof === "present";
      const opType = keepLink ? "attach_a3" : "attach_a2";
      return { ok: true, next: stampAndBuild(doc, { opType, inputs, result: { affected_id: id, terminal_family: keepLink ? "A3" : "A2" }, mutateRecords: (n, opId) => {
        const r = n.records[id];
        r.facts.binding = "active";
        r.binding_proof = { kind: "attach", authorized_by: authorizedBy, authorized_at: iso, claim_key: claimKey };
        r.binding_target = bindingTarget;
        if (!keepLink) { r.facts.anchor = "absent"; r.facts.locator_link_proof = "absent"; r.locator_link_proof_ref = null; r.aliases.root_om = null; }
        r.updated_at = iso; r.origin_operation_id = opId;
      } }) };
    },
  });
}

/** attach F4（§5，评审 P1-6：一笔原子 A1/A4→A3）：消费受验 f4={root_om,matched_om,matched_fields}，同笔写 binding+anchor+link+双 proof。 */
export function attachF4({ endpointId, requestKey, id, bindingTarget, claimKey, authorizedBy, f4, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, topic_agent_id: id, target: bindingTarget, claim_key: claimKey, root_om: f4?.root_om, matched_om: f4?.matched_om };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "attach_a3", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live" };
      const fam = familyOf(rec.facts);
      if (fam !== "A1" && fam !== "A4") return { ok: false, reason: "not_attachable" };
      if (targetProblem(bindingTarget)) return { ok: false, reason: "bad_target" };
      if (typeof claimKey !== "string" || !CLAIM_KEY_SHAPE.test(claimKey) || typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      if (!isObj(f4) || typeof f4.root_om !== "string" || !OM_SHAPE.test(f4.root_om) || typeof f4.matched_om !== "string" || !OM_SHAPE.test(f4.matched_om) || matchedFieldsBad(f4.matched_fields)) return { ok: false, reason: "bad_f4" };
      // A4 已有 root_om（曾 A3）时，F4 新 root 若与旧不一致 = 正面矛盾 → 拒（评审三 P1-5：不许覆盖旧证）。
      if (rec.aliases.root_om !== null && rec.aliases.root_om !== f4.root_om) return { ok: false, reason: "root_conflict" };
      if (rec.aliases.root_om === null && liveLocatorInUse(doc, f4.root_om)) return { ok: false, reason: "locator_exists" };
      return { ok: true, next: stampAndBuild(doc, { opType: "attach_a3", inputs, result: { affected_id: id, terminal_family: "A3" }, mutateRecords: (n, opId) => {
        const r = n.records[id];
        r.facts.binding = "active"; r.facts.anchor = "present"; r.facts.locator_link_proof = "present";
        r.aliases.root_om = f4.root_om;
        r.binding_proof = { kind: "attach", authorized_by: authorizedBy, authorized_at: iso, claim_key: claimKey };
        r.locator_link_proof_ref = { kind: "f4_anchor", matched_om: f4.matched_om, matched_at: iso, matched_fields: [...f4.matched_fields], by_identity: "user" };
        r.binding_target = bindingTarget;
        r.updated_at = iso; r.origin_operation_id = opId;
      } }) };
    },
  });
}

/** 锚定 A2→A3（§5）：消费受验 f4={root_om,matched_om,matched_fields}。 */
export function anchor({ endpointId, requestKey, id, f4, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, topic_agent_id: id, root_om: f4?.root_om, matched_om: f4?.matched_om };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "anchor", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live" || familyOf(rec.facts) !== "A2") return { ok: false, reason: "not_a2" };
      if (!isObj(f4) || typeof f4.root_om !== "string" || !OM_SHAPE.test(f4.root_om) || typeof f4.matched_om !== "string" || !OM_SHAPE.test(f4.matched_om) || matchedFieldsBad(f4.matched_fields)) return { ok: false, reason: "bad_f4" };
      if (liveLocatorInUse(doc, f4.root_om)) return { ok: false, reason: "locator_exists" };
      return { ok: true, next: stampAndBuild(doc, { opType: "anchor", inputs, result: { affected_id: id }, mutateRecords: (n, opId) => {
        const r = n.records[id];
        r.aliases.root_om = f4.root_om; r.facts.anchor = "present"; r.facts.locator_link_proof = "present";
        r.locator_link_proof_ref = { kind: "f4_anchor", matched_om: f4.matched_om, matched_at: iso, matched_fields: [...f4.matched_fields], by_identity: "user" };
        r.updated_at = iso; r.origin_operation_id = opId;
      } }) };
    },
  });
}

export function unbind({ endpointId, requestKey, id, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, topic_agent_id: id };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "unbind", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live" };
      const fam = familyOf(rec.facts);
      if (!["A2", "A3", "B3", "B4"].includes(fam)) return { ok: false, reason: "not_unbindable" };
      return { ok: true, next: stampAndBuild(doc, { opType: "unbind", inputs, result: { affected_id: id, terminal_family: fam === "B3" ? "B3'" : "A4" }, mutateRecords: (n, opId) => { const r = n.records[id]; r.facts.binding = "dormant"; if (fam === "B4") { r.facts.generation = "n/a"; r.generation_lineage_id = null; } r.updated_at = iso; r.origin_operation_id = opId; } }) };
    },
  });
}

export function restore({ endpointId, requestKey, id, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const inputs = { request_key: requestKey, topic_agent_id: id };
  return gatedTx({
    endpointId, requestKey, env, replay: () => [{ opType: "restore", inputs }], _inject,
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live" || familyOf(rec.facts) !== "B3'") return { ok: false, reason: "not_b3prime" };
      const lineage = rec.generation_lineage_id;
      if (Object.entries(doc.records).some(([k, r]) => k !== id && r.kind === "live" && r.generation_lineage_id === lineage && r.facts.generation === "current")) return { ok: false, reason: "lineage_has_current" };
      return { ok: true, next: stampAndBuild(doc, { opType: "restore", inputs, result: { affected_id: id }, mutateRecords: (n, opId) => { const r = n.records[id]; r.facts.binding = "active"; r.updated_at = iso; r.origin_operation_id = opId; } }) };
    },
  });
}

/**
 * retarget（§5，A′；评审三 P1-4：显式 expectedOldTarget + 锁内精确 CAS）：owner 改绑；有谱系整条一起改
 * （B1 只改 target、proof 仍 null）。scope 含 id/lineage（防跨实体误判）。命中已存 retarget op 才算重放（前置返回原 result）；
 * 否则 CAS：当前 target 必须逐字段等于 expectedOldTarget，否则冲突。
 */
export function retarget({ endpointId, requestKey, id, expectedOldTarget, newTarget, authorizedBy, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  // 请求身份（评审六 P1-1）：retarget 的指纹取调用方字面参数（id + old/new target），与状态派生的 lineage 无关。
  // 否则 A→B→A 往返里同 id 的两笔会因 lineage 相同而被误判重放；lineage 只进 result/affected，不进请求身份。
  const reqInputs = { request_key: requestKey, topic_agent_id: id, old_target: expectedOldTarget, new_target: newTarget };
  return gatedTx({
    endpointId, requestKey, env, _inject, replay: () => [{ opType: "retarget", inputs: reqInputs }],
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live" };
      if (rec.facts.binding !== "active") return { ok: false, reason: "target_not_active" };
      if (targetProblem(newTarget) || targetProblem(expectedOldTarget)) return { ok: false, reason: "bad_target" };
      const oldTarget = rec.binding_target;
      // 精确 CAS（评审三 P1-4）：当前 target 必须逐字段等于 expectedOldTarget，否则冲突（"已在 new 但从未 retarget" 也会在此被拒）。
      if (canonKey(oldTarget) !== canonKey(expectedOldTarget)) return { ok: false, reason: "cas_mismatch", why: "当前 target 与 expectedOldTarget 不符" };
      if (canonKey(oldTarget) === canonKey(newTarget)) return { ok: false, reason: "no_change" };
      if (newTarget.project_root !== oldTarget.project_root) return { ok: false, reason: "project_boundary" };
      if (typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      const lineage = rec.generation_lineage_id;
      const affected = lineage === null ? [id] : Object.keys(doc.records).filter((k) => doc.records[k].kind === "live" && doc.records[k].generation_lineage_id === lineage);
      const proof = { kind: "retarget", authorized_by: authorizedBy, authorized_at: iso, old_target: oldTarget, new_target: newTarget };
      return { ok: true, next: stampAndBuild(doc, { opType: "retarget", inputs: reqInputs, result: { affected_ids: [...affected].sort(), unit: lineage === null ? "record" : "lineage", old_target: oldTarget, new_target: newTarget }, mutateRecords: (n, opId) => {
        for (const k of affected) { const r = n.records[k]; r.binding_target = newTarget; r.updated_at = iso; r.origin_operation_id = opId; if (r.facts.binding === "pending") continue; r.binding_proof = { ...proof }; }
      } }) };
    },
  });
}

/** migrate_seed（§3.1，gated、仅 shadow）：把 legacy 证据迁成 B 族（B1：proof 全 null；B3/B3'/B4：migrated 双证引用本笔 seed op）。
 *  fingerprint = { request_key, candidates: 逐条 legacy 证据元组 canonKey 排序 }（与账本当前状态无关，评审六 P1-1）。
 *  result = { authorized_by, authorized_at, seeded: [按 id 严格升序的 {topic_agent_id, legacy_source_digest}] }。
 *  同 id 已存在但 C 投影（不含 proof）不同 → conflict；已存在且 C 投影相同 → 跳过（同 key 幂等）；A 族不从 legacy 迁 → migrate_scope。 */
export function migrateSeed({ endpointId, requestKey, candidates, authorizedBy, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME;
  let reqInputs;
  try { reqInputs = { request_key: requestKey, candidates: Array.isArray(candidates) ? candidates.map(canonKey).sort() : candidates }; }
  catch { return { ok: false, commit: "not_committed", reason: "bad_candidate" }; }
  return gatedTx({
    endpointId, requestKey, env, _inject, replay: () => [{ opType: "migrate_seed", inputs: reqInputs }],
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, reason: "bad_input" };
      if (doc.authority_mode !== "shadow") return { ok: false, reason: "not_shadow" };
      if (typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      const locatorOwner = new Map();
      for (const [id, r] of Object.entries(doc.records)) { if (r.kind !== "live") continue; for (const loc of [r.aliases.session_id, r.aliases.root_om]) if (typeof loc === "string" && loc) locatorOwner.set(loc, id); }
      const toInsert = [];
      for (const cand of candidates) {
        if (!isObj(cand) || typeof cand.topic_agent_id !== "string" || !isId(cand.topic_agent_id)) return { ok: false, reason: "bad_candidate", why: "id" };
        const id = cand.topic_agent_id;
        const legacyDigest = cand.legacy_source_digest;
        if (typeof legacyDigest !== "string" || !SHA_SHAPE.test(legacyDigest)) return { ok: false, reason: "bad_candidate", why: id + "：缺合法 legacy_source_digest" };
        const fam = familyOf(cand.facts);
        if (fam === null) return { ok: false, reason: "bad_candidate", why: id + "：facts 不构成合法族" };
        if (fam === "A1" || fam === "A2" || fam === "A3" || fam === "A4") return { ok: false, reason: "migrate_scope", why: "migrate_seed 只做 B 族（A 族不从 legacy 迁）" };
        const staged = { ...cand, origin_operation_id: "00000000-0000-0000-0000-000000000000", created_at: iso, updated_at: iso };
        delete staged.legacy_source_digest;
        if (fam === "B1") { staged.binding_proof = null; staged.locator_link_proof_ref = null; }
        else { staged.binding_proof = { kind: "migrated", authorized_by: authorizedBy, authorized_at: iso, migration_operation_id: "00000000-0000-0000-0000-000000000000", legacy_source_digest: legacyDigest }; staged.locator_link_proof_ref = { kind: "migrated", migration_operation_id: "00000000-0000-0000-0000-000000000000", legacy_source_digest: legacyDigest }; }
        const p = liveProblem(staged, id);
        if (p !== null) return { ok: false, reason: "bad_candidate", why: id + "：" + p };
        const existing = doc.records[id];
        if (existing) {
          if (existing.kind !== "live") return { ok: false, reason: "conflict", why: id + " 已是非 live" };
          if (cRecordKey(existing) !== cRecordKey(staged)) return { ok: false, reason: "conflict", why: id + " C 投影不同" };
          continue;
        }
        for (const loc of [cand.aliases?.session_id, cand.aliases?.root_om]) if (typeof loc === "string" && loc && locatorOwner.has(loc) && locatorOwner.get(loc) !== id) return { ok: false, reason: "conflict", why: "locator " + loc + " 被 " + locatorOwner.get(loc) + " 占用" };
        toInsert.push(id);
      }
      const byId = new Map(candidates.map((c) => [c.topic_agent_id, c]));
      const seeded = toInsert.map((id) => ({ topic_agent_id: id, legacy_source_digest: byId.get(id).legacy_source_digest })).sort((a, b) => a.topic_agent_id < b.topic_agent_id ? -1 : 1);
      return { ok: true, next: stampAndBuild(doc, { opType: "migrate_seed", inputs: reqInputs, result: { authorized_by: authorizedBy, authorized_at: iso, seeded }, mutateRecords: (n, opId) => {
        for (const id of toInsert) {
          const cand = byId.get(id);
          const fam = familyOf(cand.facts);
          const r = { ...cand, origin_operation_id: opId, created_at: iso, updated_at: iso };
          delete r.legacy_source_digest;
          r.binding_proof = fam !== "B1" ? { kind: "migrated", authorized_by: authorizedBy, authorized_at: iso, migration_operation_id: opId, legacy_source_digest: cand.legacy_source_digest } : null;
          r.locator_link_proof_ref = fam !== "B1" ? { kind: "migrated", migration_operation_id: opId, legacy_source_digest: cand.legacy_source_digest } : null;
          n.records[id] = r;
        }
      } }) };
    },
  });
}

/** migrate_repair（§5.1，gated、仅 shadow、owner 逐次授权）：按 legacy 证据对**已迁移**记录做同族内容对齐。
 *  两分支判别联合：B1→B1（proof 全 null，只改 C 投影）；{B3,B3',B4}→同族（migrated 双证由本笔 repair op 重签）。
 *  其余（A 族、真实生命周期 proof、表外组合、跨族）一律 repair_scope。
 *  fingerprint = { request_key, topic_agent_id, expected_projection_digest, next_projection_digest }（两者皆调用方字面证据，与当前状态无关）。
 *  CAS：现 C 投影 digest≠expected → repair_cas_mismatch；调用方给的 facts/aliases/target 必须产出 next → 否则 bad_input。
 *  result = { repaired_id, from_family, to_family, expected_projection_digest, next_projection_digest, legacy_source_digest, authorized_by, authorized_at }。 */
export function migrateRepair({ endpointId, requestKey, id, expectedProjectionDigest, nextProjectionDigest, facts, aliases, bindingTarget, legacySourceDigest, authorizedBy, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME;
  if (!isId(id)) return { ok: false, commit: "not_committed", reason: "bad_id" };
  const reqInputs = { request_key: requestKey, topic_agent_id: id, expected_projection_digest: expectedProjectionDigest, next_projection_digest: nextProjectionDigest };
  return gatedTx({
    endpointId, requestKey, env, _inject, replay: () => [{ opType: "migrate_repair", inputs: reqInputs }],
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (doc.authority_mode !== "shadow") return { ok: false, reason: "not_shadow" };
      if (![expectedProjectionDigest, nextProjectionDigest, legacySourceDigest].every((s) => typeof s === "string" && SHA_SHAPE.test(s))) return { ok: false, reason: "bad_input", why: "digest 不是 64-hex" };
      if (typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live" };
      const fromFam = familyOf(rec.facts);
      if (fromFam === null || (fromFam !== "B1" && fromFam !== "B3" && fromFam !== "B3'" && fromFam !== "B4")) return { ok: false, reason: "repair_scope", why: "只修 B1/B3/B3'/B4" };
      const bp = rec.binding_proof, lp = rec.locator_link_proof_ref;
      const realLife = (bp?.kind && bp.kind !== "migrated") || (lp?.kind && lp.kind !== "migrated");
      if (realLife) return { ok: false, reason: "repair_scope", why: "真实生命周期 proof 不可 repair" };
      if (fromFam === "B1") { if (bp !== null || lp !== null) return { ok: false, reason: "repair_scope", why: "B1 必须 proof 全 null" }; }
      else if (bp?.kind !== "migrated" || lp?.kind !== "migrated") return { ok: false, reason: "repair_scope", why: "B3/B3'/B4 必须是 migrated 双证" };
      if (migrateProjectionDigest(rec) !== expectedProjectionDigest) return { ok: false, reason: "repair_cas_mismatch", why: "现 C 投影 digest 与 expected 不符" };
      if (!isObj(facts) || !isObj(aliases)) return { ok: false, reason: "bad_input", why: "facts/aliases" };
      const toFam = familyOf(facts);
      if (toFam === null) return { ok: false, reason: "bad_input", why: "repair 后 facts 不构成合法族" };
      const allowedTo = fromFam === "B1" ? toFam === "B1" : (toFam === "B3" || toFam === "B3'" || toFam === "B4");
      if (!allowedTo) return { ok: false, reason: "repair_scope", why: "repair 只在同支内：B1→B1 或 {B3,B3',B4}→{B3,B3',B4}" };
      const nextCRec = { topic_agent_id: id, chat_id: rec.chat_id, aliases, facts, generation_lineage_id: rec.generation_lineage_id, binding_target: bindingTarget };
      if (sha256(Buffer.from(canonKey(nextCRec), "utf-8")) !== nextProjectionDigest) return { ok: false, reason: "bad_input", why: "调用方 next 投影 digest 与所给内容不符" };
      return { ok: true, next: stampAndBuild(doc, { opType: "migrate_repair", inputs: reqInputs, result: { repaired_id: id, from_family: fromFam, to_family: toFam, expected_projection_digest: expectedProjectionDigest, next_projection_digest: nextProjectionDigest, legacy_source_digest: legacySourceDigest, authorized_by: authorizedBy, authorized_at: iso }, mutateRecords: (n, opId) => {
        const r = n.records[id];
        r.facts = facts; r.aliases = aliases; r.binding_target = bindingTarget;
        if (toFam !== "B1") { r.binding_proof = { kind: "migrated", authorized_by: authorizedBy, authorized_at: iso, migration_operation_id: opId, legacy_source_digest: legacySourceDigest }; r.locator_link_proof_ref = { kind: "migrated", migration_operation_id: opId, legacy_source_digest: legacySourceDigest }; }
        r.updated_at = iso; r.origin_operation_id = opId;
      } }) };
    },
  });
}
