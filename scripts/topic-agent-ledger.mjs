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
import { JOURNAL_SCHEMA, OPERATION_KINDS, OWNER_SELECT_JOURNAL_SCHEMA, journalProblem, leaseHolder, leasePath, maintenanceDir, readActive, readJournal } from "./maintenance/journal.mjs";
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
export { ID_SHAPE }; // 只读导出（policy-store 派生 policy_subject_id 复用同一判据，#R33 P2-1）
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
export { LINEAGE_SHAPE, REQUEST_KEY_SHAPE }; // 只读导出（policy-store / owner-select-state 复用，#R33 P2-1, R50 P1-3）
const AUTHORIZED_BY_SHAPE = /^[A-Za-z0-9_.:@+-]{1,128}$/u; // 授权者 sender id（有界、无控制字符，评审六 P2）
const REASON_ENUM = ["expired", "superseded", "manual"];
const MATCHED_FIELDS = ["chat_id", "sender", "body", "thread_root"];
/* P1-1-d 判别联合（Codex 裁定 d）：binding_token_v1（token 证明，四维）vs owner_root_no_token_v1（无码 owner-root 配对，三维）。
   两套都合法、都可独立验证；G15 按 pending_token_state 分支精确校验，禁止通用"部分 matched_fields"与任何 unverified 占位。 */
const F4_NO_TOKEN_FIELDS = ["chat_id", "sender", "thread_root"];

// R48：owner_select 账本地基 schema 与 handle 前缀形状
const SCHEMA_VERSIONS = Object.freeze(["1.0", "1.1-transition", "1.1"]);
const SELECTION_HANDLE_SHAPE = /^osh_[0-9a-f]{32}$/u;
const REBIND_HANDLE_SHAPE = /^orh_[0-9a-f]{32}$/u;
const REAFFIRM_HANDLE_SHAPE = /^rfh_[0-9a-f]{32}$/u;
const ANY_HANDLE_SHAPE = /^(osh|orh|rfh)_[0-9a-f]{32}$/u;
const ALLOWED_PRODUCE_OPS = Object.freeze(["activate", "anchor", "rebind_session_alias", "owner_select_reaffirm"]);

const OP_TYPES = [
  "initialize_shadow", "create_a1", "create_b1", "seed", "activate", "void",
  "attach_a2", "attach_a3", "anchor", "restore", "unbind", "retarget",
  "rebind_session_alias", "authority_cutover", "migrate_seed", "migrate_repair",
  "mint_selection_handles", "clear_anchor_handle", "reissue_selection_handle",
  "request_rebind", "expire_rebind_handle", "cancel_rebind", "owner_select_reaffirm",
  "schema_upgrade"
];
const NEW_OP_TYPES = Object.freeze([
  "mint_selection_handles", "clear_anchor_handle", "reissue_selection_handle",
  "request_rebind", "expire_rebind_handle", "cancel_rebind", "owner_select_reaffirm",
  "schema_upgrade"
]);
const VALID_UPGRADE_EDGES = Object.freeze(["1.0->1.1-transition", "1.1-transition->1.1", "1.0->1.1"]);
// migrate_repair 的 from_family / to_family 值域（§5.1 判别联合：B1→B1；{B3,B3',B4}→{B3,B3',B4}）
const MIGRATE_FAMILIES = ["B1", "B3", "B3'", "B4"];
// 返修三 P1-2：逐 op 钉死 produced/preserved 的合法 proof kind（未列的 effect 维度不约束；preserved-binding 未列即不约束）。
//   unbind/restore/clear_anchor_handle/reaffirm 不钉：reaffirm 有专属逐字校验，其余是“保留型”op，proof kind 随上游。
const OP_EFFECT_PROOF_KINDS = Object.freeze({
  activate: { produced_binding: ["owner_select_v1"] },
  attach_a2: { produced_binding: ["attach"] },
  attach_a3: { produced_binding: ["attach"] },
  anchor: { preserved_binding: ["attach", "retarget"], produced_link: ["owner_selected_route_v1"] },
  rebind_session_alias: { produced_binding: ["owner_select_v1"] },
  retarget: { produced_binding: ["retarget"] }
});

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

/** 对已 open 的父目录 fd 做 fsync（P1-3：既有根快路与新建根共用同一父目录持久化屏障）。 */
function fsyncDirFd(fd, inj) {
  if (inj.failFsync) return { ok: false, reason: "fsync_failed", why: "注入 fsync 失败" };
  try { fs.fsyncSync(fd); return { ok: true }; }
  catch (err) { return { ok: false, reason: "fsync_failed", why: "父目录 fsync：" + String(err?.code ?? err?.message ?? err) }; }
}

/** R46：init 门内、写账本前自建账本根（单层，绝不 recursive）。受验：
 *  1) validateLedgerRoot(mustExistRoot:true) —— 根已在场且 0700 真目录 → 重做父目录 fsync（P1-3：上次 fsync
 *     失败可能留着未落盘目录条目，快路不 fsync 会把那次失败洗白成成功），只读不改目录，然后返回；
 *     父链任一 symlink → root_not_canonical；不可解析 → root_unresolvable；根非 0700 → root_perms（不放宽）。
 *     只有 rv.reason === "root_absent"（父链受验净、末级确实缺席）才允许自建。
 *  2) P1-2 TOCTOU 防护：先 open 父目录 fd 钉住 inode、受验父 realpath；路径式 mkdir 后立刻复核父 realpath，
 *     父目录在受验后被换成外指 symlink → mkdir 写进外指目标 → **尽力清掉**刚建目录并 fail-closed（root_not_canonical）。
 *  3) P1-2 迁移点栅栏：调用方传 `_fence` 时给它一个 `create` 闭包（真正的 mkdir 变更）。`_fence(create)` 在**自己的
 *     持锁复核段**（租约 reap 段内走 commitWhileHeld 核**真实注册实例**，不是磁盘 symlink 的 pid）再次原子复核
 *     active 仍指本 token / gate 仍本 token / phase 仍 drained 后，**由 _fence 在窄段内执行 create**；任一失效 →
 *     fence_lost，**在建根前就拒**（不留空根）——防"手里有 lease 对象但实际已丢护栏（真实例被删/被换）"的窗口。
 *  4) mkdirSync(root,{recursive:false, mode:0o700})；父目录缺席 → ENOENT → 原样 fail（不递归创建）。
 *  5) chmodSync 0700 兜 umask；fsync 父目录（用钉住的 fd）。
 *  6) 再 validateLedgerRoot(mustExistRoot:true) 复核通过才算数。任一步失败不吞、原样 fail。
 *  返回 { ok:true, root } 或 { ok:false, reason, why }。
 *
 *  —— 威胁模型（P1-1 本裁定，Codex 认可；不引入 native mkdirat helper）——
 *  本函数**防御**：既存/误配置的符号链接、非规范父链（任一分量是 symlink 或 realpath 不自洽）、权限错误
 *    （根非精确 0700、父不可读/不可解析）。
 *  本函数**不防御**：与 provision **精确并发**的恶意同 UID 路径替换。目标部署是单用户机器、门内受控维护操作，
 *    该攻击被明确排除出威胁模型。**注意："同 UID 无增益"不是普遍事实**（macOS TCC/FDA/sandbox entitlement
 *    可致同 UID 两进程能力不同、confused deputy）——本收缩成立**仅因**目标部署排除恶意同 UID 并发，
 *    不是因为该攻击在所有环境无害。
 *  创建后的 realpath 复核与清理属纵深防御（不依赖它防恶意并发）；清理是 **best-effort**，不承诺外部残留必然
 *    被清、更不承诺 doctor 必然能定位外部残留（父路径恢复后外部创建位置未必可从词法路径定位）。
 *
 *  测试注入点：failMkdir / failChmod / failFsync（既有）+ onBeforeMkdir（P1-2 竞态）+ _fence（迁移点栅栏）。 */
export function ensureLedgerRoot({ env = process.env, _inject = null, _fence = null } = {}) {
  const inj = _inject ?? {};
  // ① 以"必须在场"核验：根已在场且 0700 真目录 → 也要重做父目录持久化屏障（P1-3），只读、不改目录，然后返回。
  //    root_not_canonical / root_unresolvable / root_perms / root_symlink → 原样拒（不创建）。
  const rv = validateLedgerRoot({ env, mustExistRoot: true });
  if (rv.ok) {
    const parent = path.dirname(rv.root);
    let pfd = null;
    try { pfd = fs.openSync(parent, fs.constants.O_RDONLY); }
    catch (err) { return { ok: false, reason: "parent_open_failed", why: "打开父目录：" + String(err?.code ?? err?.message ?? err) }; }
    const f = fsyncDirFd(pfd, inj);
    fs.closeSync(pfd);
    if (!f.ok) return f;
    return { ok: true, root: rv.root };
  }
  // 只有"父链受验且末级确实缺席"（root_absent）才允许自建；no_root 无路径可建，也拒。
  if (rv.reason !== "root_absent") return rv;
  const root = ledgerRootFor(env); // 合法缺席：root_absent 返回不带 root，路径从 ledgerRootFor 取（父链已受验净）
  const parent = path.dirname(root);
  // P1-2：先受验父目录 realpath 并 open 钉住 inode，再在受验父上创建 —— 防"受验后父目录被并发换成
  // 外指 symlink"的越界写。路径式 mkdir 后即时复核父 realpath，被换 → 回滚并拒（best-effort 清理，不承诺净零）。
  let parentReal = null;
  try { parentReal = fs.realpathSync(parent); }
  catch (err) { return { ok: false, reason: err?.code === "ENOENT" ? "parent_absent" : "parent_unresolvable", why: "父目录 realpath：" + String(err?.code ?? err?.message ?? err) }; }
  let pfd = null;
  try { pfd = fs.openSync(parent, fs.constants.O_RDONLY); }
  catch (err) { return { ok: false, reason: "parent_open_failed", why: "打开父目录：" + String(err?.code ?? err?.message ?? err) }; }
  try {
    const st = fs.fstatSync(pfd);
    if (!st.isDirectory()) { fs.closeSync(pfd); return { ok: false, reason: "parent_not_dir" }; }
  } catch (err) { fs.closeSync(pfd); return { ok: false, reason: "parent_fstat_failed", why: String(err?.code ?? err?.message ?? err) }; }
  try {
    if (fs.realpathSync(parent) !== parentReal) { fs.closeSync(pfd); return { ok: false, reason: "root_not_canonical", why: "父目录在受验后与外指不同（symlink 或换目录），不创建" }; }
  } catch (err) { fs.closeSync(pfd); return { ok: false, reason: "parent_unresolvable", why: "父目录复核失败：" + String(err?.code ?? err?.message ?? err) }; }
  if (inj.onBeforeMkdir) inj.onBeforeMkdir(); // P1-2 注入点：测试在此把父目录确定性换成外指 symlink
  // ② 建单层（递归：false，绝不递归）：父目录缺席 → ENOENT → 不递归、原样 fail。封装成 create，交给 _fence 或直接调用。
  const create = () => {
    let mkdirErr = null;
    if (inj.failMkdir) mkdirErr = inj.failMkdir;
    else { try { fs.mkdirSync(root, { recursive: false, mode: 0o700 }); } catch (err) { mkdirErr = err; } }
    if (mkdirErr !== null) {
      const code = mkdirErr?.code ?? null;
      return { ok: false, reason: code === "ENOENT" ? "parent_absent" : "mkdir_failed", why: code === "ENOENT" ? "父目录缺席，不递归创建" : String(mkdirErr?.message ?? mkdirErr) };
    }
    return { ok: true };
  };
  // P1-2 迁移点栅栏：把**创建目录的变更点**（mkdir）交给 `_fence(create)` 在真实持锁复核段内执行。失效
  //   （active/gate 被改写、lease 真实例被删/被接管、phase 不再 drained）→ 在建根前就拒，绝不留下空根或写入未知目录。
  if (_fence) {
    const fr = _fence(create);
    if (!fr.ok) {
      fs.closeSync(pfd);
      return { ok: false, reason: fr.reason ?? "fence_lost", why: fr.why ?? fr.reason ?? null };
    }
  } else {
    const cr = create();
    if (!cr.ok) { fs.closeSync(pfd); return { ok: false, reason: cr.reason, why: cr.why }; }
  }
  // P1-2 复核：mkdir 后父路径必须仍解析到受验 realpath；否则根被写进了外指目标 → **尽力清**并 fail-closed。
  // 清理是 best-effort（rmdir 失败也照常 fail-closed），不承诺外部残留必然被清、不承诺 doctor 可见。
  try {
    if (fs.realpathSync(parent) !== parentReal) {
      try { fs.rmdirSync(root); } catch { /* 尽力清（best-effort，不承诺净零） */ }
      fs.closeSync(pfd);
      return { ok: false, reason: "root_not_canonical", why: "父目录在 mkdir 后被换成外指，尽力回滚越界目录后 fail-closed" };
    }
  } catch (err) {
    try { fs.rmdirSync(root); } catch { /* 尽力清 */ }
    fs.closeSync(pfd);
    return { ok: false, reason: "parent_unresolvable", why: "父目录 mkdir 后不可解析：" + String(err?.code ?? err?.message ?? err) };
  }
  // ③ chmod 0700 兜 umask（仅在父链受验未换时）。
  let chmodErr = null;
  if (inj.failChmod) chmodErr = inj.failChmod;
  else { try { fs.chmodSync(root, 0o700); } catch (err) { chmodErr = err; } }
  if (chmodErr !== null) { fs.closeSync(pfd); return { ok: false, reason: "chmod_failed", why: "chmod：" + String(chmodErr?.message ?? chmodErr) }; }
  // ④ fsync 父目录（用钉住的 fd，让刚建的单层落盘）。
  const f = fsyncDirFd(pfd, inj);
  fs.closeSync(pfd);
  if (!f.ok) return f;
  // ⑤ 复核：根必须已是 0700 真目录；否则 fail-closed。
  const rc = validateLedgerRoot({ env, mustExistRoot: true });
  if (!rc.ok) return rc;
  return { ok: true, root: rc.root };
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

/** R51 §三：迁移盘点（纯函数，不验账本级合同）。输入域是 1.1-transition 形状的 doc（A 段语义：
 *  live 记录已补显式四字段，selection_handle===null 才算 null-B1；1.0 形状字段缺位不在本合同域内）。
 *  legacy = owner-select-route.md §8"存量范围"：binding_proof.kind=pairing 的 live +
 *  locator_link_proof_ref.kind=f4_anchor 的 live + tombstone（forwarding_tombstone）proof_ref.kind=pairing（旧系，
 *  新系是 owner_select_merge_v1）。计数单位是 proof 面，不是记录。*/
export function migrationInventory(doc) {
  let legacy = 0;
  const nullB1 = [];
  for (const [id, rec] of Object.entries(doc?.records ?? {})) {
    if (rec.kind === "live") {
      if (rec.binding_proof?.kind === "pairing") legacy++;
      if (rec.locator_link_proof_ref?.kind === "f4_anchor") legacy++;
      if (familyOf(rec.facts) === "B1" && rec.selection_handle === null) nullB1.push(id);
    } else if (rec.kind === "forwarding_tombstone") {
      if (rec.proof_ref?.kind === "pairing") legacy++;
    }
  }
  return { legacy_proof_count: legacy, null_b1_count: nullB1.length, null_b1_ids: nullB1.sort() };
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

const matchedFieldsBad = (mf, pstate) => {
  if (pstate === "present") return !(Array.isArray(mf) && mf.length === 4 && mf.every((v, i) => v === MATCHED_FIELDS[i]));
  if (pstate === "absent") return !(Array.isArray(mf) && mf.length === 3 && mf.every((v, i) => v === F4_NO_TOKEN_FIELDS[i]));
  return true; // 未知/缺失 pending_token_state：非合法判别联合（G15）。
  //   注：旧写（本分支未发布、无线上账本）只可能全缺 pstate——这正是“无声明到底哪一种”的未受验占位，
  //   按裁定 d 直接拒，不当作 legacy token 兼容（旧的伪造 no-token-as-四项 正是要靠这层探测出来）。
};

const bindingProofProblem = (p, { schemaVersion = "1.0" } = {}) => {
  if (!isObj(p)) return "binding_proof 不是对象";
  if (typeof p.authorized_by !== "string" || !AUTHORIZED_BY_SHAPE.test(p.authorized_by)) return "authorized_by 形状不对";
  if (!isCanonicalIso(p.authorized_at)) return "authorized_at 不规范";
  if (p.kind === "attach") {
    if (keysOf(p) !== "authorized_at,authorized_by,claim_key,kind") return "attach proof 字段集不对";
    if (typeof p.claim_key !== "string" || !CLAIM_KEY_SHAPE.test(p.claim_key)) return "attach.claim_key 形状不对";
  } else if (p.kind === "pairing") {
    if (schemaVersion === "1.1") return "legacy_pairing_shape 现于 1.1 strict 账本 (G15′)";
    if (keysOf(p) !== "authorized_at,authorized_by,kind,matched_fields,matched_om,pending_token_state") return "pairing proof 字段集不对";
    if (typeof p.matched_om !== "string" || !OM_SHAPE.test(p.matched_om)) return "pairing.matched_om 形状不对";
    if (matchedFieldsBad(p.matched_fields, p.pending_token_state)) return "pairing.matched_fields 不是封闭判别联合（token 四项 / no-token 三项）";
  } else if (p.kind === "retarget") {
    if (keysOf(p) !== "authorized_at,authorized_by,kind,new_target,old_target") return "retarget proof 字段集不对";
    if (targetProblem(p.old_target) || targetProblem(p.new_target)) return "retarget old/new_target 形状不对";
  } else if (p.kind === "migrated") {
    if (keysOf(p) !== "authorized_at,authorized_by,kind,legacy_source_digest,migration_operation_id") return "migrated proof 字段集不对";
    if (typeof p.migration_operation_id !== "string" || !OP_ID_SHAPE.test(p.migration_operation_id)) return "migrated.migration_operation_id 形状不对";
    if (typeof p.legacy_source_digest !== "string" || !SHA_SHAPE.test(p.legacy_source_digest)) return "migrated.legacy_source_digest 形状不对";
  } else if (p.kind === "owner_select_v1") {
    if (schemaVersion === "1.0") return "binding_proof.kind 不在 {attach,pairing,retarget,migrated}";
    if (keysOf(p) !== "authorized_at,authorized_by,kind,selected_root_om,selected_session_id,selection_handle,selection_operation_id") return "owner_select_v1 字段集不对";
    if (typeof p.selected_session_id !== "string" || !AILY_SESSION_SHAPE.test(p.selected_session_id)) return "selected_session_id 形状不对";
    if (typeof p.selected_root_om !== "string" || !OM_SHAPE.test(p.selected_root_om)) return "selected_root_om 形状不对";
    if (typeof p.selection_handle !== "string" || !ANY_HANDLE_SHAPE.test(p.selection_handle)) return "selection_handle 形状不对";
    if (!isOperationId(p.selection_operation_id)) return "selection_operation_id 形状不对";
  } else return "binding_proof.kind 不在 {attach,pairing,retarget,migrated,owner_select_v1}";
  return null;
};

const linkProofProblem = (r, { schemaVersion = "1.0" } = {}) => {
  if (!isObj(r)) return "locator_link_proof_ref 不是对象";
  if (r.kind === "migrated") {
    if (keysOf(r) !== "kind,legacy_source_digest,migration_operation_id") return "link migrated 字段集不对";
    if (typeof r.migration_operation_id !== "string" || !OP_ID_SHAPE.test(r.migration_operation_id)) return "link migrated.migration_operation_id 形状不对";
    if (typeof r.legacy_source_digest !== "string" || !SHA_SHAPE.test(r.legacy_source_digest)) return "link migrated.legacy_source_digest 形状不对";
    return null;
  }
  if (r.kind === "owner_selected_route_v1") {
    if (schemaVersion === "1.0") return "link proof.kind 不对";
    if (keysOf(r) !== "authorized_at,authorized_by,by_identity,kind,selected_root_om,selected_session_id,selection_handle,selection_operation_id") return "owner_selected_route_v1 字段集不对";
    if (r.by_identity !== "owner_authorization") return "by_identity 只认 owner_authorization";
    if (typeof r.authorized_by !== "string" || !AUTHORIZED_BY_SHAPE.test(r.authorized_by)) return "authorized_by 形状不对";
    if (!isCanonicalIso(r.authorized_at)) return "authorized_at 不规范";
    if (typeof r.selected_session_id !== "string" || !AILY_SESSION_SHAPE.test(r.selected_session_id)) return "selected_session_id 形状不对";
    if (typeof r.selected_root_om !== "string" || !OM_SHAPE.test(r.selected_root_om)) return "selected_root_om 形状不对";
    if (typeof r.selection_handle !== "string" || !ANY_HANDLE_SHAPE.test(r.selection_handle)) return "selection_handle 形状不对";
    if (!isOperationId(r.selection_operation_id)) return "selection_operation_id 形状不对";
    return null;
  }
  if (schemaVersion === "1.1") return "legacy_pairing_shape 现于 1.1 strict 账本 (G15′)";
  if (keysOf(r) !== "by_identity,kind,matched_at,matched_fields,matched_om,pending_token_state") return "link proof 字段集不对";
  if (r.kind !== "pairing_merge" && r.kind !== "f4_anchor") return "link proof.kind 不对";
  if (typeof r.matched_om !== "string" || !OM_SHAPE.test(r.matched_om)) return "link matched_om 形状不对";
  if (!isCanonicalIso(r.matched_at)) return "matched_at 不规范";
  if (matchedFieldsBad(r.matched_fields, r.pending_token_state)) return "link matched_fields 不是封闭判别联合（token 四项 / no-token 三项）";
  if (r.by_identity !== "user") return "by_identity 只认 user";
  return null;
};

export function liveProblem(rec, id, { schemaVersion = "1.0" } = {}) {
  if (!isObj(rec)) return "记录不是对象";
  const is11 = schemaVersion === "1.1-transition" || schemaVersion === "1.1";
  const allowed = is11
    ? "aliases,anchor_candidate,binding_proof,binding_target,chat_id,created_at,facts,generation_lineage_id,handle_expires_at,kind,locator_link_proof_ref,origin_operation_id,rebind_expires_at,rebind_handle,selection_handle,topic_agent_id,updated_at"
    : "aliases,anchor_candidate,binding_proof,binding_target,chat_id,created_at,facts,generation_lineage_id,kind,locator_link_proof_ref,origin_operation_id,topic_agent_id,updated_at";
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

  if (is11) {
    if (rec.selection_handle !== null && (typeof rec.selection_handle !== "string" || !SELECTION_HANDLE_SHAPE.test(rec.selection_handle))) return "selection_handle 形状不对";
    if (rec.handle_expires_at !== null && !isCanonicalIso(rec.handle_expires_at)) return "handle_expires_at 不规范";
    if (rec.rebind_handle !== null && (typeof rec.rebind_handle !== "string" || !REBIND_HANDLE_SHAPE.test(rec.rebind_handle))) return "rebind_handle 形状不对";
    if (rec.rebind_expires_at !== null && !isCanonicalIso(rec.rebind_expires_at)) return "rebind_expires_at 不规范";

    if (fam === "B1") {
      if (schemaVersion === "1.1" && (rec.selection_handle === null || rec.handle_expires_at === null)) return "1.1 strict 要求 B1 selection_handle 与 handle_expires_at 双非空";
      if ((rec.selection_handle === null) !== (rec.handle_expires_at === null)) return "B1 handle 与 expiry 必须同时有或同时无";
    } else if (fam === "A2") {
      if ((rec.selection_handle === null) !== (rec.handle_expires_at === null)) return "A2 handle 与 expiry 必须同时有或同时无";
    } else {
      if (rec.selection_handle !== null || rec.handle_expires_at !== null) return "非 B1/A2 不得有 selection_handle";
    }
    if (fam === "B3") {
      if ((rec.rebind_handle === null) !== (rec.rebind_expires_at === null)) return "rebind handle 与 expiry 必须同时有或同时无";
    } else {
      if (rec.rebind_handle !== null || rec.rebind_expires_at !== null) return "非 B3 不得有 rebind_handle";
    }
  }

  const wantProof = f.binding === "active" || f.binding === "dormant";
  if (wantProof !== (rec.binding_proof !== null)) return "binding_proof 与 binding 不一致";
  if (rec.binding_proof !== null) {
    const bp = bindingProofProblem(rec.binding_proof, { schemaVersion }); if (bp) return bp;
    const kind = rec.binding_proof.kind;
    const okKind = (fam === "A2" || fam === "A3") ? (kind === "attach" || kind === "retarget")
      : (fam === "B3" || fam === "B3'" || fam === "B4") ? (kind === "pairing" || kind === "retarget" || kind === "migrated" || kind === "owner_select_v1")
        : (fam === "A4") ? (kind === "attach" || kind === "pairing" || kind === "retarget" || kind === "migrated" || kind === "owner_select_v1") : false;
    if (!okKind) return "binding_proof.kind 与族不匹配";
  }
  if ((f.locator_link_proof === "present") !== (rec.locator_link_proof_ref !== null)) return "locator_link_proof 与 ref 不一致";
  if (rec.locator_link_proof_ref !== null) {
    if (!(f.session === "present" && f.anchor === "present")) return "link=present 必须 session∧anchor present";
    const lp = linkProofProblem(rec.locator_link_proof_ref, { schemaVersion }); if (lp) return lp;
    if ((fam === "B3" || fam === "B3'" || fam === "B4") && rec.locator_link_proof_ref.kind !== "pairing_merge" && rec.locator_link_proof_ref.kind !== "migrated" && rec.locator_link_proof_ref.kind !== "owner_selected_route_v1") return "B3/B3'/B4 的 link 必须 pairing_merge/migrated/owner_selected_route_v1";
    if ((fam === "A3" || fam === "A4") && rec.locator_link_proof_ref.kind !== "pairing_merge" && rec.locator_link_proof_ref.kind !== "f4_anchor" && rec.locator_link_proof_ref.kind !== "migrated" && rec.locator_link_proof_ref.kind !== "owner_selected_route_v1") return "A3/A4 的 link kind 不匹配";
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
    case "create_b1": return r.created_id == null ? (Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : []) : [r.created_id];
    case "seed": return Array.isArray(r.seeded_ids) ? r.seeded_ids : [];
    case "activate": return [r.surviving_id, r.tombstoned_id, r.demoted_historical_id].filter((x) => x != null);
    case "void": return r.voided_id == null ? [] : [r.voided_id];
    case "attach_a2":
    case "attach_a3":
    case "anchor":
    case "restore":
    case "unbind": return r.affected_id == null ? (Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : []) : [r.affected_id];
    case "retarget": return Array.isArray(r.affected_ids) ? r.affected_ids : [];
    case "rebind_session_alias": return r.affected_id == null ? (Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : []) : [r.affected_id];
    case "mint_selection_handles": return Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : (Array.isArray(r.minted) ? r.minted.map((m) => m.target_id) : []);
    case "clear_anchor_handle": return Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : [];
    case "reissue_selection_handle": return Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : (r.target_id ? [r.target_id] : []);
    case "request_rebind":
    case "expire_rebind_handle":
    case "cancel_rebind": return Array.isArray(r.affected_live_ids_after_commit) ? r.affected_live_ids_after_commit : [];
    case "owner_select_reaffirm": {
      const ids = r.target_id ? [r.target_id] : (Array.isArray(r.affected_live_ids_after_commit) ? [...r.affected_live_ids_after_commit] : []);
      if (Array.isArray(r.tombstone_remap)) for (const m of r.tombstone_remap) ids.push(m.old_tomb_id);
      return ids.filter(Boolean);
    }
    case "schema_upgrade": return [];
    case "migrate_seed": return Array.isArray(r.seeded) ? r.seeded.map((s) => s.topic_agent_id) : [];
    case "migrate_repair": return r.repaired_id == null ? [] : [r.repaired_id];
    default: return [];
  }
}

function proofCombinationProblem(rec, id, doc) {
  const bpKind = rec.binding_proof?.kind ?? null;
  const lpKind = rec.locator_link_proof_ref?.kind ?? null;
  if (bpKind === "owner_select_v1" && lpKind !== "owner_selected_route_v1" && lpKind !== null) {
    return "binding=owner_select_v1 只能 pair link=owner_selected_route_v1 (或 null)";
  }
  if (lpKind === "owner_selected_route_v1") {
    if (bpKind !== "owner_select_v1" && bpKind !== "attach" && bpKind !== "retarget" && bpKind !== "pairing" && bpKind !== "migrated") {
      return "link=owner_selected_route_v1 的 binding 只能是 owner_select_v1/attach/retarget/pairing/migrated";
    }
  }
  if (rec.facts.binding === "pending" || rec.facts.binding === "none") {
    if (bpKind === "owner_select_v1" || lpKind === "owner_selected_route_v1") return "owner_select proof 禁现于 A1/B1";
  }
  if (bpKind === "migrated" && lpKind !== "migrated") {
    if (doc.schema_version === "1.0") return "binding=migrated 必须 pair link=migrated";
    if (lpKind !== "owner_selected_route_v1") return "binding=migrated 必须 pair link∈{migrated,owner_selected_route_v1}";
  }
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

export function tombstoneProblem(rec, id, { schemaVersion = "1.0" } = {}) {
  if (!isObj(rec) || keysOf(rec) !== "forwards_to,kind,merged_at,origin_operation_id,proof_ref,topic_agent_id") return "tombstone 字段集不对";
  if (rec.topic_agent_id !== id || !isId(id)) return "tombstone id 不一致";
  if (!isId(rec.forwards_to)) return "forwards_to 形状不对";
  if (rec.forwards_to === id) return "forwards_to 自指";
  if (!isCanonicalIso(rec.merged_at)) return "merged_at 不规范";
  if (!isOperationId(rec.origin_operation_id)) return "origin_operation_id 形状不对";
  const p = rec.proof_ref;
  if (!isObj(p)) return "proof_ref 不是对象";
  if (p.kind === "owner_select_merge_v1") {
    if (schemaVersion === "1.0") return "proof_ref 字段集/kind 不对";
    if (keysOf(p) !== "kind,selected_root_om,selection_handle,selection_operation_id") return "owner_select_merge_v1 字段集不对";
    if (!isOperationId(p.selection_operation_id)) return "selection_operation_id 形状不对";
    if (typeof p.selected_root_om !== "string" || !OM_SHAPE.test(p.selected_root_om)) return "selected_root_om 形状不对";
    if (typeof p.selection_handle !== "string" || !ANY_HANDLE_SHAPE.test(p.selection_handle)) return "selection_handle 形状不对";
    return null;
  }
  if (schemaVersion === "1.1") return "legacy_pairing_shape 现于 1.1 strict 账本 (G15′)";
  if (keysOf(p) !== "kind,matched_fields,om,pending_token_state" || p.kind !== "pairing") return "proof_ref 字段集/kind 不对";
  if (typeof p.om !== "string" || !OM_SHAPE.test(p.om)) return "proof_ref.om 形状不对";
  if (matchedFieldsBad(p.matched_fields, p.pending_token_state)) return "proof_ref.matched_fields 不是封闭判别联合（token 四项 / no-token 三项）";
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

function recordProblem(rec, id, { schemaVersion = "1.0" } = {}) {
  if (!isObj(rec) || typeof rec.kind !== "string") return "记录缺 kind";
  if (rec.kind === "live") return liveProblem(rec, id, { schemaVersion });
  if (rec.kind === "forwarding_tombstone") return tombstoneProblem(rec, id, { schemaVersion });
  if (rec.kind === "voided_audit") return voidedProblem(rec, id);
  return "kind 不在三选一";
}

/* ─────────────────────────── operations 判别联合（评审 P1-1，G12） ─────────────────────────── */

/** ID 数组：非空、每项合法、严格升序（⇒ 唯一）。评审二 P1-3。 */
const idArrayOk = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => isId(x)) && a.every((x, i) => i === 0 || a[i - 1] < x);
// seed 允许空 seeded_ids（全存在的成功空 op 占用 request_key，评审七 P1-2）：仍要求有序且逐项 isId。
const idArraySortedMaybeEmpty = (a) => Array.isArray(a) && a.every((x) => isId(x)) && a.every((x, i) => i === 0 || a[i - 1] < x);
const allDistinct = (...xs) => { const seen = new Set(); for (const x of xs) { if (x === null) continue; if (seen.has(x)) return false; seen.add(x); } return true; };

const validProofEffects = (pes) => Array.isArray(pes) && pes.every((p, i) => isObj(p) && isId(p.topic_agent_id) && ["produced", "preserved", "none"].includes(p.binding_effect) && ["produced", "preserved", "none"].includes(p.link_effect) && (i === 0 || pes[i - 1].topic_agent_id < p.topic_agent_id));

const RESULT_SHAPE = Object.freeze({
  initialize_shadow: (r) => keysOf(r) === "revision" && r.revision === 1,
  create_a1: (r) => keysOf(r) === "created_id" && isId(r.created_id),
  create_b1: (r) => (keysOf(r) === "created_id" && isId(r.created_id))
    || (keysOf(r) === "affected_live_ids_after_commit,created_id,handle_expires_at,proof_effects,selection_handle"
        && isId(r.created_id) && SELECTION_HANDLE_SHAPE.test(r.selection_handle) && isCanonicalIso(r.handle_expires_at)
        && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.created_id
        && Array.isArray(r.proof_effects) && r.proof_effects.length === 0),
  seed: (r) => keysOf(r) === "seeded_ids" && idArraySortedMaybeEmpty(r.seeded_ids),
  activate: (r) => {
    if (keysOf(r) === "demoted_historical_id,surviving_id,tombstoned_id") {
      return isId(r.surviving_id) && isId(r.tombstoned_id) && (r.demoted_historical_id === null || isId(r.demoted_historical_id)) && allDistinct(r.surviving_id, r.tombstoned_id, r.demoted_historical_id);
    }
    if (keysOf(r) !== "affected_live_ids_after_commit,authorized_at,authorized_by,demoted_historical_id,proof_effects,selected_root_om,selected_session_id,selection_basis,selection_handle,selection_message_id,selection_operation_id,surviving_id,tombstoned_id") {
      return false;
    }
    const expectedAffected = r.demoted_historical_id === null
      ? [r.surviving_id]
      : [r.surviving_id, r.demoted_historical_id].sort();
    const expectedPes = r.demoted_historical_id === null
      ? [{ topic_agent_id: r.surviving_id, binding_effect: "produced", link_effect: "produced" }]
      : [
          { topic_agent_id: r.surviving_id, binding_effect: "produced", link_effect: "produced" },
          { topic_agent_id: r.demoted_historical_id, binding_effect: "preserved", link_effect: "preserved" }
        ].sort((a, b) => a.topic_agent_id.localeCompare(b.topic_agent_id));

    return isId(r.surviving_id) && isId(r.tombstoned_id) && (r.demoted_historical_id === null || isId(r.demoted_historical_id))
      && allDistinct(r.surviving_id, r.tombstoned_id, r.demoted_historical_id)
      && ANY_HANDLE_SHAPE.test(r.selection_handle) && isCanonicalIso(r.authorized_at) && AUTHORIZED_BY_SHAPE.test(r.authorized_by)
      && AILY_SESSION_SHAPE.test(r.selected_session_id) && OM_SHAPE.test(r.selected_root_om) && isOperationId(r.selection_operation_id)
      && (r.selection_basis === "explicit_handle" || r.selection_basis === "unique_candidate")
      && typeof r.selection_message_id === "string" && OM_SHAPE.test(r.selection_message_id)
      && canonKey(r.affected_live_ids_after_commit) === canonKey(expectedAffected)
      && canonKey(r.proof_effects) === canonKey(expectedPes);
  },
  void: (r) => keysOf(r) === "voided_id" && isId(r.voided_id),
  attach_a2: (r) => (keysOf(r) === "affected_id,terminal_family" && isId(r.affected_id) && r.terminal_family === "A2")
    || (keysOf(r) === "affected_id,affected_live_ids_after_commit,anchor_candidate,handle_expires_at,proof_effects,selection_handle,terminal_family"
        && isId(r.affected_id) && r.terminal_family === "A2"
        && ((r.selection_handle === null && r.handle_expires_at === null) || (SELECTION_HANDLE_SHAPE.test(r.selection_handle) && isCanonicalIso(r.handle_expires_at)))
        && OM_SHAPE.test(r.anchor_candidate)
        && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.affected_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_id && r.proof_effects[0].binding_effect === "produced" && r.proof_effects[0].link_effect === "none"),
  attach_a3: (r) => (keysOf(r) === "affected_id,terminal_family" && isId(r.affected_id) && r.terminal_family === "A3")
    || (keysOf(r) === "affected_id,affected_live_ids_after_commit,proof_effects,terminal_family"
        && isId(r.affected_id) && r.terminal_family === "A3"
        && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.affected_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_id && r.proof_effects[0].binding_effect === "produced" && r.proof_effects[0].link_effect === "preserved"),
  anchor: (r) => (keysOf(r) === "affected_id" && isId(r.affected_id))
    || (keysOf(r) === "affected_id,affected_live_ids_after_commit,authorized_at,authorized_by,expected_anchor_candidate,proof_effects,selected_root_om,selected_session_id,selection_basis,selection_handle,selection_message_id,selection_operation_id"
        && isId(r.affected_id) && ANY_HANDLE_SHAPE.test(r.selection_handle) && isCanonicalIso(r.authorized_at) && AUTHORIZED_BY_SHAPE.test(r.authorized_by)
        && AILY_SESSION_SHAPE.test(r.selected_session_id) && OM_SHAPE.test(r.selected_root_om) && isOperationId(r.selection_operation_id)
        && (r.selection_basis === "explicit_handle" || r.selection_basis === "unique_candidate")
        && typeof r.selection_message_id === "string" && OM_SHAPE.test(r.selection_message_id)
        && OM_SHAPE.test(r.expected_anchor_candidate) && r.expected_anchor_candidate === r.selected_root_om
        && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.affected_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_id && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "produced"),
  restore: (r) => (keysOf(r) === "affected_id" && isId(r.affected_id))
    || (keysOf(r) === "affected_id,affected_live_ids_after_commit,proof_effects"
        && isId(r.affected_id) && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.affected_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_id && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "preserved"),
  unbind: (r) => (keysOf(r) === "affected_id,terminal_family" && isId(r.affected_id) && (r.terminal_family === "A4" || r.terminal_family === "B3'"))
    || (keysOf(r) === "affected_id,affected_live_ids_after_commit,proof_effects,terminal_family"
        && isId(r.affected_id) && (r.terminal_family === "A4" || r.terminal_family === "B3'")
        && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.affected_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_id && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "preserved"),
  retarget: (r) => (keysOf(r) === "affected_ids,new_target,old_target,unit" && idArrayOk(r.affected_ids) && (r.unit === "record" || r.unit === "lineage") && !targetProblem(r.old_target) && !targetProblem(r.new_target) && canonKey(r.old_target) !== canonKey(r.new_target))
    || (keysOf(r) === "affected_ids,affected_live_ids_after_commit,new_target,old_target,proof_effects,unit"
        && idArrayOk(r.affected_ids) && (r.unit === "record" || r.unit === "lineage")
        && !targetProblem(r.old_target) && !targetProblem(r.new_target) && canonKey(r.old_target) !== canonKey(r.new_target)
        && canonKey(r.affected_ids) === canonKey(r.affected_live_ids_after_commit)
        && validProofEffects(r.proof_effects) && r.proof_effects.every((p) => r.affected_ids.includes(p.topic_agent_id) && p.binding_effect === "produced" && (p.link_effect === "none" || p.link_effect === "preserved"))),
  rebind_session_alias: (r) => (keysOf(r) === "affected_id,authorized_at,authorized_by,new_session_id,old_session_id" && isId(r.affected_id) && AILY_SESSION_SHAPE.test(r.old_session_id) && AILY_SESSION_SHAPE.test(r.new_session_id) && r.old_session_id !== r.new_session_id && AUTHORIZED_BY_SHAPE.test(r.authorized_by) && isCanonicalIso(r.authorized_at))
    || (keysOf(r) === "affected_id,affected_live_ids_after_commit,authorized_at,authorized_by,new_session_id,old_session_id,proof_effects,selected_root_om,selected_session_id,selection_basis,selection_handle,selection_message_id,selection_operation_id,tombstoned_a1_id"
        && isId(r.affected_id) && AILY_SESSION_SHAPE.test(r.old_session_id) && AILY_SESSION_SHAPE.test(r.new_session_id) && r.old_session_id !== r.new_session_id
        && AUTHORIZED_BY_SHAPE.test(r.authorized_by) && isCanonicalIso(r.authorized_at)
        && ANY_HANDLE_SHAPE.test(r.selection_handle) && OM_SHAPE.test(r.selected_root_om) && r.selected_session_id === r.new_session_id
        && isOperationId(r.selection_operation_id)
        && (r.tombstoned_a1_id === null || isId(r.tombstoned_a1_id))
        && r.selection_basis === "rebind"
        && typeof r.selection_message_id === "string" && OM_SHAPE.test(r.selection_message_id)
        && canonKey(r.affected_live_ids_after_commit) === canonKey([r.affected_id])
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_id && ["produced", "preserved"].includes(r.proof_effects[0].binding_effect) && r.proof_effects[0].link_effect === "produced"),
  migrate_seed: (r) => keysOf(r) === "authorized_at,authorized_by,seeded" && typeof r.authorized_by === "string" && AUTHORIZED_BY_SHAPE.test(r.authorized_by) && isCanonicalIso(r.authorized_at) && Array.isArray(r.seeded) && r.seeded.every((s) => isObj(s) && isId(s.topic_agent_id) && typeof s.legacy_source_digest === "string" && SHA_SHAPE.test(s.legacy_source_digest)) && r.seeded.every((s, i) => i === 0 || r.seeded[i - 1].topic_agent_id < s.topic_agent_id),
  migrate_repair: (r) => keysOf(r) === "authorized_at,authorized_by,expected_projection_digest,from_family,legacy_source_digest,next_projection_digest,repaired_id,to_family" && isId(r.repaired_id) && typeof r.authorized_by === "string" && AUTHORIZED_BY_SHAPE.test(r.authorized_by) && isCanonicalIso(r.authorized_at) && [r.expected_projection_digest, r.next_projection_digest, r.legacy_source_digest].every((s) => typeof s === "string" && SHA_SHAPE.test(s)) && MIGRATE_FAMILIES.includes(r.from_family) && MIGRATE_FAMILIES.includes(r.to_family) && (r.from_family === "B1" ? r.to_family === "B1" : r.to_family !== "B1"),
  authority_cutover: (r) => keysOf(r) === "bijection_digest,endpoint_id,expiry_sha256,pending_claims_sha256,policy_sha256,pre_cutover_ledger_sha,revision_at_cutover"
    && Number.isInteger(r.revision_at_cutover) && r.revision_at_cutover >= 1
    && typeof r.endpoint_id === "string" && ENDPOINT_SHAPE.test(r.endpoint_id)
    && [r.bijection_digest, r.pre_cutover_ledger_sha, r.expiry_sha256, r.pending_claims_sha256, r.policy_sha256].every((v) => typeof v === "string" && SHA_SHAPE.test(v)),
  mint_selection_handles: (r) => keysOf(r) === "affected_live_ids_after_commit,endpoint,minted,proof_effects"
    && typeof r.endpoint === "string" && ENDPOINT_SHAPE.test(r.endpoint)
    && Array.isArray(r.minted) && r.minted.every((m, i) => isObj(m) && isId(m.target_id) && SELECTION_HANDLE_SHAPE.test(m.selection_handle) && isCanonicalIso(m.handle_expires_at)
        // 返修三 P2：A2 不由 mint 产生（A2 只经 attach_a2），minted 项不再认 anchor_candidate 字段
        && keysOf(m) === "handle_expires_at,selection_handle,target_id"
        && (i === 0 || r.minted[i - 1].target_id < m.target_id))
    && canonKey(r.affected_live_ids_after_commit) === canonKey(r.minted.map((m) => m.target_id))
    && Array.isArray(r.proof_effects) && r.proof_effects.length === 0,
  clear_anchor_handle: (r) => keysOf(r) === "affected_live_ids_after_commit,cleared,proof_effects"
    && canonKey(r.cleared) === canonKey(["selection_handle", "handle_expires_at"])
    && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1
    && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_live_ids_after_commit[0] && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "none",
  reissue_selection_handle: (r) => {
    if (keysOf(r) === "affected_live_ids_after_commit,new_expires_at,new_handle,proof_effects") {
      return idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1
        && SELECTION_HANDLE_SHAPE.test(r.new_handle) && isCanonicalIso(r.new_expires_at)
        && Array.isArray(r.proof_effects) && r.proof_effects.length === 0;
    }
    if (keysOf(r) === "affected_live_ids_after_commit,anchor_candidate,new_expires_at,new_handle,proof_effects") {
      return idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1
        && SELECTION_HANDLE_SHAPE.test(r.new_handle) && isCanonicalIso(r.new_expires_at) && OM_SHAPE.test(r.anchor_candidate)
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_live_ids_after_commit[0] && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "none";
    }
    return false;
  },
  request_rebind: (r) => keysOf(r) === "affected_live_ids_after_commit,proof_effects,rebind_expires_at,rebind_handle"
    && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1
    && REBIND_HANDLE_SHAPE.test(r.rebind_handle) && isCanonicalIso(r.rebind_expires_at)
    && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_live_ids_after_commit[0] && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "preserved",
  expire_rebind_handle: (r) => keysOf(r) === "affected_live_ids_after_commit,cleared,proof_effects"
    && canonKey(r.cleared) === canonKey(["rebind_handle", "rebind_expires_at"])
    && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1
    && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_live_ids_after_commit[0] && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "preserved",
  cancel_rebind: (r) => keysOf(r) === "affected_live_ids_after_commit,cleared,proof_effects"
    && canonKey(r.cleared) === canonKey(["rebind_handle", "rebind_expires_at"])
    && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1
    && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.affected_live_ids_after_commit[0] && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "preserved",
  owner_select_reaffirm: (r) => {
    if (keysOf(r) === "affected_live_ids_after_commit,new_binding_proof,new_link_proof,proof_effects,selection_message_id,target_id,tombstone_remap") {
      return isId(r.target_id) && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.target_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.target_id && r.proof_effects[0].binding_effect === "produced" && r.proof_effects[0].link_effect === "produced"
        && bindingProofProblem(r.new_binding_proof, { schemaVersion: "1.1" }) === null && r.new_binding_proof.kind === "owner_select_v1" && REAFFIRM_HANDLE_SHAPE.test(r.new_binding_proof.selection_handle)
        && linkProofProblem(r.new_link_proof, { schemaVersion: "1.1" }) === null && r.new_link_proof.kind === "owner_selected_route_v1" && REAFFIRM_HANDLE_SHAPE.test(r.new_link_proof.selection_handle)
        && Array.isArray(r.tombstone_remap) && r.tombstone_remap.every((m, i) => isObj(m) && isId(m.old_tomb_id) && isObj(m.new_proof_ref) && keysOf(m.new_proof_ref) === "kind,selected_root_om,selection_handle,selection_operation_id" && m.new_proof_ref.kind === "owner_select_merge_v1" && REAFFIRM_HANDLE_SHAPE.test(m.new_proof_ref.selection_handle) && (i === 0 || r.tombstone_remap[i - 1].old_tomb_id < m.old_tomb_id))
        && typeof r.selection_message_id === "string" && OM_SHAPE.test(r.selection_message_id);
    }
    if (keysOf(r) === "affected_live_ids_after_commit,new_link_proof,proof_effects,selection_message_id,target_id,tombstone_remap") {
      return isId(r.target_id) && idArraySortedMaybeEmpty(r.affected_live_ids_after_commit) && r.affected_live_ids_after_commit.length === 1 && r.affected_live_ids_after_commit[0] === r.target_id
        && validProofEffects(r.proof_effects) && r.proof_effects.length === 1 && r.proof_effects[0].topic_agent_id === r.target_id && r.proof_effects[0].binding_effect === "preserved" && r.proof_effects[0].link_effect === "produced"
        && linkProofProblem(r.new_link_proof, { schemaVersion: "1.1" }) === null && r.new_link_proof.kind === "owner_selected_route_v1" && REAFFIRM_HANDLE_SHAPE.test(r.new_link_proof.selection_handle)
        && Array.isArray(r.tombstone_remap) && r.tombstone_remap.every((m, i) => isObj(m) && isId(m.old_tomb_id) && isObj(m.new_proof_ref) && keysOf(m.new_proof_ref) === "kind,selected_root_om,selection_handle,selection_operation_id" && m.new_proof_ref.kind === "owner_select_merge_v1" && REAFFIRM_HANDLE_SHAPE.test(m.new_proof_ref.selection_handle) && (i === 0 || r.tombstone_remap[i - 1].old_tomb_id < m.old_tomb_id))
        && typeof r.selection_message_id === "string" && OM_SHAPE.test(r.selection_message_id);
    }
    return false;
  },
  schema_upgrade: (r) => keysOf(r) === "endpoint,from_schema,to_schema"
    && typeof r.endpoint === "string" && ENDPOINT_SHAPE.test(r.endpoint)
    && VALID_UPGRADE_EDGES.includes(r.from_schema + "->" + r.to_schema),
});

function operationProblem(op, topRevision, { schemaVersion = "1.0", upgradeBoundaryRevision = 0 } = {}) {
  if (!isObj(op) || keysOf(op) !== "fingerprint,op_type,request_key,result,result_revision,terminal_kind") return "operation 字段集不对";
  if (typeof op.request_key !== "string" || !REQUEST_KEY_SHAPE.test(op.request_key)) return "request_key 形状不对";
  if (!OP_TYPES.includes(op.op_type)) return "op_type 越界";
  if (op.terminal_kind !== op.op_type) return "terminal_kind 必须等于 op_type";
  if (typeof op.fingerprint !== "string" || !SHA_SHAPE.test(op.fingerprint)) return "fingerprint 形状不对";
  if (!Number.isInteger(op.result_revision) || op.result_revision < 1 || op.result_revision > topRevision) return "result_revision 越界";
  if (!isObj(op.result) || !RESULT_SHAPE[op.op_type](op.result)) return op.op_type + " result 形状不对";

  // 1.0 边界与升级边界前历史封闭
  const isBeforeUpgrade = schemaVersion === "1.0" || (upgradeBoundaryRevision > 0 && op.result_revision < upgradeBoundaryRevision);
  if (isBeforeUpgrade) {
    if (schemaVersion === "1.0" && op.op_type === "schema_upgrade") return "schema_upgrade 禁现于 1.0 账本";
    if (op.op_type !== "schema_upgrade" && NEW_OP_TYPES.includes(op.op_type)) return op.op_type + " 禁现于 1.0 或升级边界之前";
    if ("affected_live_ids_after_commit" in op.result) return op.op_type + " 增量 result 禁现于 1.0 或升级边界之前";
  }

  if ((op.op_type === "activate" || op.op_type === "anchor") && op.result.selection_handle && !op.result.selection_handle.startsWith("osh_")) {
    return "activate/anchor handle 前缀必须为 osh_ (G15′)";
  }
  if (op.op_type === "rebind_session_alias" && op.result.selection_handle && !op.result.selection_handle.startsWith("orh_")) {
    return "rebind_session_alias handle 前缀必须为 orh_ (G15′)";
  }
  if (op.op_type === "initialize_shadow" && op.result_revision !== 1) return "initialize 的 result_revision 必为 1";
  if (op.op_type === "authority_cutover" && op.result.revision_at_cutover !== op.result_revision) return "cutover 的 revision_at_cutover 必等于 result_revision";
  return null;
}

/** G13（评审二 P1-3）：记录的 origin op 与该记录**逐 op 精确相容**——终态族、result 内容都要对得上。 */
function opConsistentWithRecord(op, id, rec) {
  const r = op.result;
  const fam = rec.kind === "live" ? familyOf(rec.facts) : null;
  switch (op.op_type) {
    case "initialize_shadow": case "authority_cutover": case "schema_upgrade": return false; // 不产生记录
    case "create_a1": return rec.kind === "live" && r.created_id === id && fam === "A1";
    case "create_b1": return rec.kind === "live" && (r.created_id === id || r.affected_live_ids_after_commit?.includes(id)) && fam === "B1";
    case "seed": return rec.kind === "live" && r.seeded_ids.includes(id); // seed 插入的族由 liveProblem 已校
    case "activate":
      if (r.surviving_id === id) return rec.kind === "live" && fam === "B3";
      if (r.tombstoned_id === id) return rec.kind === "forwarding_tombstone" && rec.forwards_to === r.surviving_id;
      if (r.demoted_historical_id === id) return rec.kind === "live" && fam === "B4";
      return false;
    case "void": return rec.kind === "voided_audit" && r.voided_id === id;
    case "attach_a2": return rec.kind === "live" && (r.affected_id === id || r.affected_live_ids_after_commit?.includes(id)) && fam === "A2"
      && (r.anchor_candidate === undefined || r.anchor_candidate === rec.anchor_candidate);
    case "attach_a3": return rec.kind === "live" && (r.affected_id === id || r.affected_live_ids_after_commit?.includes(id)) && fam === "A3";
    case "anchor": return rec.kind === "live" && (r.affected_id === id || r.affected_live_ids_after_commit?.includes(id)) && fam === "A3"
      // 返修三 P1-3：owner_select 增量锚定（r.expected_anchor_candidate 已由 shape 钉必带且 === selected_root_om）
      // 时，必须等于记录上保留的 anchor_candidate（即产生 op 钉下的 pre-commit 值）；
      // F4 基线锚定（1.0 形状，无此字段）不受影响 —— 与 attach_a2 的 undefined 宽容模式一致。
      && (r.expected_anchor_candidate === undefined || r.expected_anchor_candidate === rec.anchor_candidate);
    case "restore": return rec.kind === "live" && (r.affected_id === id || r.affected_live_ids_after_commit?.includes(id)) && fam === "B3";
    case "unbind": return rec.kind === "live" && (r.affected_id === id || r.affected_live_ids_after_commit?.includes(id)) && fam === r.terminal_family;
    case "retarget": {
      if (rec.kind !== "live" || !r.affected_ids.includes(id)) return false;
      if (canonKey(rec.binding_target) !== canonKey(r.new_target)) return false; // 当前 target 必等 result.new_target
      if (rec.facts.binding === "pending") return rec.binding_proof === null; // B1：proof 仍 null
      return rec.binding_proof !== null && rec.binding_proof.kind === "retarget" && canonKey(rec.binding_proof.new_target) === canonKey(r.new_target) && canonKey(rec.binding_proof.old_target) === canonKey(r.old_target);
    }
    case "rebind_session_alias": return rec.kind === "live" && (r.affected_id === id || r.affected_live_ids_after_commit?.includes(id)) && rec.aliases.session_id === r.new_session_id; // G13：仅改别名，target/proof 不动
    case "mint_selection_handles": {
      if (rec.kind !== "live") return false;
      if (!Array.isArray(r.minted)) return false;
      const m = r.minted.find((x) => x.target_id === id);
      if (!m) return false;
      // 返修三 P2：A2 不由 mint 产生（A2 只经 attach_a2）—— B1 保留，其余族一律 false
      return fam === "B1";
    }
    case "clear_anchor_handle": return rec.kind === "live" && fam === "A2" && r.affected_live_ids_after_commit?.includes(id);
    case "reissue_selection_handle": return rec.kind === "live" && (fam === "B1" || fam === "A2") && r.affected_live_ids_after_commit?.includes(id)
      && (r.anchor_candidate === undefined || r.anchor_candidate === rec.anchor_candidate);
    case "request_rebind":
    case "expire_rebind_handle":
    case "cancel_rebind": return rec.kind === "live" && fam === "B3" && r.affected_live_ids_after_commit?.includes(id);
    case "owner_select_reaffirm": return (rec.kind === "live" && (r.target_id === id || r.affected_live_ids_after_commit?.includes(id))) || (rec.kind === "forwarding_tombstone" && Array.isArray(r.tombstone_remap) && r.tombstone_remap.some((m) => m.old_tomb_id === id));
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
  if (!SCHEMA_VERSIONS.includes(doc.schema_version) || doc.artifact_type !== ARTIFACT_TYPE) return bad("schema/artifact 不对");
  if (doc.authority_mode !== "shadow" && doc.authority_mode !== "authoritative") return bad("authority_mode 越界");
  if (!CHAIN.includes(doc.chain)) return bad("chain 越界（链不可从 opaque endpoint 还原，顶层显式存）");
  if (!Number.isInteger(doc.revision) || doc.revision < 1) return bad("revision 不是正整数");
  if (typeof endpointId === "string" && doc.endpoint_id !== endpointId) return bad("endpoint_id 与路径不符"); // G2
  if (typeof doc.endpoint_id !== "string" || !ENDPOINT_SHAPE.test(doc.endpoint_id)) return bad("endpoint_id 形状不对");
  if (!isObj(doc.records) || !isObj(doc.operations)) return bad("records/operations 不是对象");
  if (Object.keys(doc.operations).length > MAX_OPERATIONS) return bad("operations 超上限");

  // G12：逐 op 判别联合 + 恰一笔 initialize_shadow + **每 revision 恰一笔（result_revision 覆盖 1..revision）**
  //       + (op_type,fingerprint) 唯一（评审三 P1-3：否则伪造同 revision 的 op 能过、重放 .find 选到伪造）。
  const upgradeOps = Object.values(doc.operations)
    .filter((op) => isObj(op) && op.op_type === "schema_upgrade")
    .sort((a, b) => a.result_revision - b.result_revision);

  if (doc.schema_version === "1.0") {
    if (upgradeOps.length > 0) return bad("1.0 账本不得包含 schema_upgrade 操作");
  } else {
    if (upgradeOps.length > 2) return bad("schema_upgrade 操作不得超过 2 笔");
    if (upgradeOps.length === 2) {
      if (upgradeOps[0].result?.from_schema !== "1.0" || upgradeOps[0].result?.to_schema !== "1.1-transition" ||
          upgradeOps[1].result?.from_schema !== "1.1-transition" || upgradeOps[1].result?.to_schema !== "1.1") {
        return bad("两笔 schema_upgrade 必须严格单调 (1.0->1.1-transition 后 1.1-transition->1.1)");
      }
    }
    if (upgradeOps.length > 0) {
      const latest = upgradeOps[upgradeOps.length - 1];
      if (latest.result?.to_schema !== doc.schema_version) {
        return bad("最近一笔 schema_upgrade 的 to_schema 必须等于 doc.schema_version");
      }
    }
  }
  // 升级边界 = 首次离开 1.0 的那笔 schema_upgrade（按 result_revision 排序后第一笔 from_schema==="1.0"）；
  // 之后的 op 才允许新形/增量 result —— 合法历史 1.0→transition→mint→1.1 里夹在两笔升级间的 op 也要放行。
  const firstLeave10 = upgradeOps.find((u) => u.result?.from_schema === "1.0");
  const upgradeBoundaryRevision = firstLeave10 ? firstLeave10.result_revision : 0;

  let initCount = 0;
  const revSeen = new Set(), fpSeen = new Set(), rkSeen = new Set();
  for (const [opId, op] of Object.entries(doc.operations)) {
    if (!isOperationId(opId)) return bad("operation key 形状不对：" + opId);
    const p = operationProblem(op, doc.revision, { schemaVersion: doc.schema_version, upgradeBoundaryRevision });
    if (p !== null) return bad("operation " + opId + "：" + p);
    if (op.result?.selection_operation_id && op.result.selection_operation_id !== opId) {
      return bad("operation " + opId + " 的 selection_operation_id 必须等于本 operation key");
    }
    if (op.op_type === "owner_select_reaffirm") {
      if (op.result?.new_link_proof?.selection_operation_id !== opId) {
        return bad("reaffirm new_link_proof selection_operation_id 必须等于本 operation key");
      }
      if (Array.isArray(op.result?.tombstone_remap)) {
        for (const m of op.result.tombstone_remap) {
          if (m.new_proof_ref?.selected_root_om !== op.result.new_link_proof.selected_root_om) {
            return bad("reaffirm tombstone_remap selected_root_om 必须等于 new_link_proof.selected_root_om");
          }
          if (m.new_proof_ref?.selection_handle !== op.result.new_link_proof.selection_handle) {
            return bad("reaffirm tombstone_remap selection_handle 必须等于 new_link_proof.selection_handle");
          }
          if (m.new_proof_ref?.selection_operation_id !== opId) {
            return bad("reaffirm tombstone_remap selection_operation_id 必须等于本 operation key");
          }
          const targetRec = doc.records[m.old_tomb_id];
          if (!targetRec || targetRec.kind !== "forwarding_tombstone") {
            return bad("reaffirm tombstone_remap old_tomb_id 必须为已存在的 forwarding_tombstone 记录：" + m.old_tomb_id);
          }
        }
      }
    }
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
    const p = recordProblem(rec, id, { schemaVersion: doc.schema_version });
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

  // G11′：binding_target.runtime === 顶层 chain；retarget 跨字段；owner_select_v1 selected_* 别名一致 ∧ 六字段等式
  const chain = doc.chain;
  for (const [id, rec] of live) {
    if (rec.binding_target !== null && rec.binding_target.runtime !== chain) return bad("binding_target.runtime 与 endpoint 链不符（G11）");
    if (rec.binding_proof !== null && rec.binding_proof.kind === "retarget") {
      if (canonKey(rec.binding_proof.old_target) === canonKey(rec.binding_proof.new_target)) return bad("retarget proof old===new（G11）");
      if (canonKey(rec.binding_target) !== canonKey(rec.binding_proof.new_target)) return bad("当前 binding_target ≠ proof.new_target（G11）");
    }
    const bp = rec.binding_proof;
    const lp = rec.locator_link_proof_ref;
    if (bp?.kind === "owner_select_v1") {
      if (bp.selected_session_id !== rec.aliases.session_id || bp.selected_root_om !== rec.aliases.root_om) {
        return bad(id + "：owner_select_v1 selected_* 与 aliases 不一致（G11′）");
      }
    }
    if (lp?.kind === "owner_selected_route_v1") {
      if (lp.selected_session_id !== rec.aliases.session_id || lp.selected_root_om !== rec.aliases.root_om) {
        return bad(id + "：owner_selected_route_v1 selected_* 与 aliases 不一致（G11′）");
      }
    }
    if (bp?.kind === "owner_select_v1" && lp?.kind === "owner_selected_route_v1") {
      if (bp.authorized_by !== lp.authorized_by || bp.authorized_at !== lp.authorized_at ||
          bp.selected_session_id !== lp.selected_session_id || bp.selected_root_om !== lp.selected_root_om ||
          bp.selection_handle !== lp.selection_handle || bp.selection_operation_id !== lp.selection_operation_id) {
        return bad(id + "：owner_select_v1 与 owner_selected_route_v1 六字段等式不成立（G11′/G13′）");
      }
    }
  }

  // G13′ (§7.2)：由来源 op result 的 proof_effects 中本记录那一项判 produced/preserved
  for (const [id, rec] of live) {
    const origOp = doc.operations[rec.origin_operation_id];
    const bp = rec.binding_proof;
    const lp = rec.locator_link_proof_ref;
    const hasOwnerSelect = bp?.kind === "owner_select_v1" || lp?.kind === "owner_selected_route_v1";

    if (hasOwnerSelect && (doc.schema_version === "1.1-transition" || doc.schema_version === "1.1")) {
      if (!origOp?.result?.proof_effects || !Array.isArray(origOp.result.proof_effects) || !origOp.result.proof_effects.some((p) => p.topic_agent_id === id)) {
        return bad(id + "：带 owner_select proof 的记录，其 origin op 必带 proof_effects 且含本记录项（G13′）");
      }
    }

    if (!origOp?.result?.proof_effects) continue; // 基线 1.0 op 无 proof_effects，跳过
    const pe = origOp.result.proof_effects.find((p) => p.topic_agent_id === id);
    if (!pe) continue;

    // none⇔proof null 全账本等式（返修三 P1-2：对任何 proof kind 成立，不再限 owner_select 系）
    if (bp === null && lp === null) {
      return bad(id + "：affected 中无 proof 的记录不得在 proof_effects 中列出");
    }
    if (bp !== null && pe.binding_effect === "none") {
      return bad(id + "：有 binding proof 记录的 binding_effect 不得为 none（G13′）");
    }
    if (lp !== null && pe.link_effect === "none") {
      return bad(id + "：有 link proof 记录的 link_effect 不得为 none（G13′）");
    }
    if (bp === null && pe.binding_effect !== "none") {
      return bad(id + "：无 binding proof 记录的 binding_effect 必须为 none（G13′）");
    }
    if (lp === null && pe.link_effect !== "none") {
      return bad(id + "：无 link proof 记录的 link_effect 必须为 none（G13′）");
    }

    // 逐 op 钉死 produced/preserved 的合法 proof kind（返修三 P1-2）：retarget 保留 migrated link 却写 none、
    //   attach_a2 产生 retarget binding 这类漂移在此拦下，而非只靠 RESULT_SHAPE 的 effect 枚举。
    const pin = OP_EFFECT_PROOF_KINDS[origOp.op_type];
    if (pin) {
      if (pe.binding_effect === "produced" && pin.produced_binding && !pin.produced_binding.includes(bp?.kind)) {
        return bad(id + "：" + origOp.op_type + " binding_effect:produced 的 proof kind 必须是 " + pin.produced_binding.join("/") + "（G13′）");
      }
      if (pe.link_effect === "produced" && pin.produced_link && !pin.produced_link.includes(lp?.kind)) {
        return bad(id + "：" + origOp.op_type + " link_effect:produced 的 proof kind 必须是 " + pin.produced_link.join("/") + "（G13′）");
      }
      if (pe.binding_effect === "preserved" && pin.preserved_binding && !pin.preserved_binding.includes(bp?.kind)) {
        return bad(id + "：" + origOp.op_type + " binding_effect:preserved 的 proof kind 必须是 " + pin.preserved_binding.join("/") + "（G13′）");
      }
    }

    // link_effect
    if (pe.link_effect === "produced") {
      if (!lp || lp.kind !== "owner_selected_route_v1") return bad(id + "：link_effect:produced 必须有 owner_selected_route_v1（G13′）");
      if (lp.selection_operation_id !== rec.origin_operation_id) return bad(id + "：link_effect:produced 但 selection_operation_id 不等于 origin_operation_id（G13′）");
      const r = origOp.result;
      if (origOp.op_type === "owner_select_reaffirm") {
        const nlp = r.new_link_proof;
        if (!nlp || canonKey(nlp) !== canonKey(lp)) return bad(id + "：link_effect:produced 与 reaffirm new_link_proof 逐字不符（G13′）");
      } else {
        if (r.authorized_by !== lp.authorized_by || r.authorized_at !== lp.authorized_at ||
            r.selected_session_id !== lp.selected_session_id || r.selected_root_om !== lp.selected_root_om ||
            r.selection_handle !== lp.selection_handle) {
          return bad(id + "：link_effect:produced proof 字段与 op result 逐字不符（G13′）");
        }
        if (r.selection_operation_id && r.selection_operation_id !== lp.selection_operation_id) {
          return bad(id + "：link_effect:produced selection_operation_id 与 op result 逐字不符（G13′）");
        }
      }
    } else if (pe.link_effect === "preserved") {
      if (lp && lp.kind === "owner_selected_route_v1") {
        const prodOpId = lp.selection_operation_id;
        const prodOp = doc.operations[prodOpId];
        if (!prodOp) return bad(id + "：preserved link 的产生 op 不在 operations 表（G13′）");
        if (!ALLOWED_PRODUCE_OPS.includes(prodOp.op_type)) return bad(id + "：preserved link 的产生 op 不在受控产生集（G13′）");
        if (prodOp.result_revision > origOp.result_revision) return bad(id + "：preserved link 来源 revision 大于当前 origin revision（G13′）");
        const prodPe = prodOp.result?.proof_effects?.find((p) => p.topic_agent_id === id);
        if (!prodPe || prodPe.link_effect !== "produced") return bad(id + "：preserved link 在来源 op 未标记 produced（G13′）");
        if (prodOp.op_type === "owner_select_reaffirm") {
          const nlp = prodOp.result.new_link_proof;
          if (!nlp || canonKey(nlp) !== canonKey(lp)) return bad(id + "：preserved link 字段与 reaffirm 产生 result 不一致（G13′）");
        } else {
          const pr = prodOp.result;
          if (pr.authorized_by !== lp.authorized_by || pr.authorized_at !== lp.authorized_at ||
              pr.selected_session_id !== lp.selected_session_id || pr.selected_root_om !== lp.selected_root_om ||
              pr.selection_handle !== lp.selection_handle) {
            return bad(id + "：preserved link 字段与产生 op result 不一致（G13′）");
          }
        }
      }
    }

    // binding_effect
    if (pe.binding_effect === "produced" && bp?.kind === "owner_select_v1") {
      if (bp.selection_operation_id !== rec.origin_operation_id) return bad(id + "：binding_effect:produced 但 selection_operation_id 不等于 origin_operation_id（G13′）");
      const r = origOp.result;
      if (origOp.op_type === "owner_select_reaffirm") {
        const nbp = r.new_binding_proof;
        if (!nbp || canonKey(nbp) !== canonKey(bp)) return bad(id + "：binding_effect:produced 与 reaffirm new_binding_proof 逐字不符（G13′）");
      } else {
        if (r.authorized_by !== bp.authorized_by || r.authorized_at !== bp.authorized_at ||
            r.selected_session_id !== bp.selected_session_id || r.selected_root_om !== bp.selected_root_om ||
            r.selection_handle !== bp.selection_handle) {
          return bad(id + "：binding_effect:produced proof 字段与 op result 逐字不符（G13′）");
        }
        if (r.selection_operation_id && r.selection_operation_id !== bp.selection_operation_id) {
          return bad(id + "：binding_effect:produced selection_operation_id 与 op result 逐字不符（G13′）");
        }
      }
    } else if (pe.binding_effect === "preserved" && bp?.kind === "owner_select_v1") {
      const prodOpId = bp.selection_operation_id;
      const prodOp = doc.operations[prodOpId];
      if (!prodOp) return bad(id + "：preserved binding 的产生 op 不在 operations 表（G13′）");
      if (!ALLOWED_PRODUCE_OPS.includes(prodOp.op_type)) return bad(id + "：preserved binding 的产生 op 不在受控产生集（G13′）");
      if (prodOp.result_revision > origOp.result_revision) return bad(id + "：preserved binding 来源 revision 大于当前 origin revision（G13′）");
      const prodPe = prodOp.result?.proof_effects?.find((p) => p.topic_agent_id === id);
      if (!prodPe || prodPe.binding_effect !== "produced") return bad(id + "：preserved binding 在来源 op 未标记 produced（G13′）");
      if (prodOp.op_type === "owner_select_reaffirm") {
        const nbp = prodOp.result.new_binding_proof;
        if (!nbp || canonKey(nbp) !== canonKey(bp)) return bad(id + "：preserved binding 字段与 reaffirm 产生 result 不一致（G13′）");
      } else {
        const pr = prodOp.result;
        if (pr.authorized_by !== bp.authorized_by || pr.authorized_at !== bp.authorized_at ||
            pr.selected_session_id !== bp.selected_session_id || pr.selected_root_om !== bp.selected_root_om ||
            pr.selection_handle !== bp.selection_handle) {
          return bad(id + "：preserved binding 字段与产生 op result 不一致（G13′）");
        }
      }
    }
  }

  // G13-tomb (§7.1)：tombstone 关联核验
  for (const [id, rec] of Object.entries(doc.records)) {
    if (rec.kind !== "forwarding_tombstone") continue;
    if (rec.proof_ref?.kind !== "owner_select_merge_v1") continue;
    const op = doc.operations[rec.origin_operation_id];
    if (!op) return bad(id + "：tombstone origin_operation_id 不在 operations（G13-tomb）");
    if (!["activate", "rebind_session_alias", "owner_select_reaffirm"].includes(op.op_type)) return bad(id + "：tombstone origin op_type 不在受控集合（G13-tomb）");
    const r = op.result;
    if (!r?.proof_effects) return bad(id + "：owner_select_merge_v1 tombstone origin op 必为增量形状（G13-tomb）");
    if (op.op_type === "activate") {
      if (r.tombstoned_id !== id) return bad(id + "：activate 未点名该 tombstone id（G13-tomb）");
      if (rec.forwards_to !== r.surviving_id) return bad(id + "：tombstone forwards_to 不等于 activate surviving_id（G13-tomb）");
      if (rec.proof_ref.selected_root_om !== r.selected_root_om || rec.proof_ref.selection_handle !== r.selection_handle) return bad(id + "：tombstone proof_ref 与 activate result 不一致（G13-tomb）");
      if (rec.proof_ref.selection_operation_id !== rec.origin_operation_id) return bad(id + "：tombstone selection_operation_id 不等于 origin_operation_id（G13-tomb）");
    } else if (op.op_type === "rebind_session_alias") {
      if (r.tombstoned_a1_id !== id) return bad(id + "：rebind 未点名该 tombstone id（G13-tomb）");
      if (rec.forwards_to !== r.affected_id) return bad(id + "：tombstone forwards_to 不等于 rebind affected_id（G13-tomb）");
      if (rec.proof_ref.selected_root_om !== r.selected_root_om || rec.proof_ref.selection_handle !== r.selection_handle) return bad(id + "：tombstone proof_ref 与 rebind result 不一致（G13-tomb）");
      if (rec.proof_ref.selection_operation_id !== rec.origin_operation_id) return bad(id + "：tombstone selection_operation_id 不等于 origin_operation_id（G13-tomb）");
    } else if (op.op_type === "owner_select_reaffirm") {
      const remap = Array.isArray(r.tombstone_remap) ? r.tombstone_remap.find((m) => m.old_tomb_id === id) : null;
      if (!remap) return bad(id + "：reaffirm tombstone_remap 未点名该 tombstone id（G13-tomb）");
      if (rec.forwards_to !== r.target_id) return bad(id + "：tombstone forwards_to 不等于 reaffirm target_id（G13-tomb）");
      if (remap.new_proof_ref.selected_root_om !== rec.proof_ref.selected_root_om ||
          remap.new_proof_ref.selection_handle !== rec.proof_ref.selection_handle ||
          remap.new_proof_ref.selection_operation_id !== rec.proof_ref.selection_operation_id) {
        return bad(id + "：reaffirm tombstone_remap 与 tombstone proof_ref 不一致（G13-tomb）");
      }
      if (rec.proof_ref.selected_root_om !== r.new_link_proof?.selected_root_om ||
          rec.proof_ref.selection_handle !== r.new_link_proof?.selection_handle ||
          rec.proof_ref.selection_operation_id !== rec.origin_operation_id) {
        return bad(id + "：reaffirm tombstone proof_ref 与 new_link_proof 不一致（G13-tomb）");
      }
    }
  }

  // G15′：1.1 strict 拒 legacy pairing 形态；来源 op ↔ handle 前缀绑定
  if (doc.schema_version === "1.1") {
    for (const [id, rec] of Object.entries(doc.records)) {
      if (rec.binding_proof?.matched_fields !== undefined || rec.binding_proof?.pending_token_state !== undefined) {
        return bad(id + "：legacy_pairing_shape 现于 1.1 strict 账本 (G15′)");
      }
      if (rec.locator_link_proof_ref?.matched_fields !== undefined || rec.locator_link_proof_ref?.pending_token_state !== undefined) {
        return bad(id + "：legacy_pairing_shape 现于 1.1 strict 账本 (G15′)");
      }
      if (rec.proof_ref?.matched_fields !== undefined || rec.proof_ref?.pending_token_state !== undefined) {
        return bad(id + "：legacy_pairing_shape 现于 1.1 strict 账本 (G15′)");
      }
    }
  }
  for (const [, op] of Object.entries(doc.operations)) {
    const r = op.result;
    if (!r) continue;
    if (op.op_type === "activate" || op.op_type === "anchor") {
      if (r.selection_handle && !r.selection_handle.startsWith("osh_")) return bad("activate/anchor handle 前缀必须为 osh_ (G15′)");
    } else if (op.op_type === "rebind_session_alias") {
      if (r.selection_handle && !r.selection_handle.startsWith("orh_")) return bad("rebind_session_alias handle 前缀必须为 orh_ (G15′)");
    } else if (op.op_type === "owner_select_reaffirm") {
      if (r.new_link_proof?.selection_handle && !r.new_link_proof.selection_handle.startsWith("rfh_")) return bad("owner_select_reaffirm handle 前缀必须为 rfh_ (G15′)");
      if (r.new_binding_proof?.selection_handle && !r.new_binding_proof.selection_handle.startsWith("rfh_")) return bad("owner_select_reaffirm handle 前缀必须为 rfh_ (G15′)");
    }
  }

  // G-handle (§7.2)：handle 来源完整性与全局唯一
  const liveHandles = new Map();
  for (const [id, rec] of live) {
    for (const h of [rec.selection_handle, rec.rebind_handle]) {
      if (h !== null && h !== undefined) {
        if (liveHandles.has(h)) return bad("live handle 全局不唯一 (G-handle)：" + h);
        liveHandles.set(h, id);
      }
    }
  }

  for (const [id, rec] of live) {
    const fam = familyOf(rec.facts);
    if (rec.selection_handle !== null && rec.selection_handle !== undefined) {
      // 产生 op 集 = {create_b1, mint_selection_handles, attach_a2, reissue_selection_handle}
      const prodOps = Object.entries(doc.operations).filter(([, op]) => {
        if (!["create_b1", "mint_selection_handles", "attach_a2", "reissue_selection_handle"].includes(op.op_type)) return false;
        return op.result?.affected_live_ids_after_commit?.includes(id);
      }).sort((a, b) => b[1].result_revision - a[1].result_revision);
      if (prodOps.length === 0) return bad(id + "：selection_handle 无产生 op (G-handle)");
      const [prodOpId, prodOp] = prodOps[0];

      // 检查是否被更晚的消费/清理 op 覆盖
      const consumedByLater = Object.entries(doc.operations).some(([, op]) => {
        if (!["activate", "anchor", "void", "clear_anchor_handle"].includes(op.op_type)) return false;
        if (op.result_revision <= prodOp.result_revision) return false;
        return op.result?.affected_live_ids_after_commit?.includes(id) || op.result?.voided_id === id;
      });
      if (consumedByLater) return bad(id + "：selection_handle 已被后续 op 消费/清理 (G-handle)");

      // 逐字等核验
      const pr = prodOp.result;
      if (prodOp.op_type === "create_b1" || prodOp.op_type === "attach_a2") {
        if (pr.selection_handle !== rec.selection_handle || pr.handle_expires_at !== rec.handle_expires_at) {
          return bad(id + "：selection_handle 与产生 op result 逐字不符 (G-handle)");
        }
        if (prodOp.op_type === "attach_a2" && pr.anchor_candidate !== undefined && pr.anchor_candidate !== rec.anchor_candidate) {
          return bad(id + "：anchor_candidate 与产生 op result 逐字不符 (G-handle)");
        }
      } else if (prodOp.op_type === "mint_selection_handles") {
        const item = pr.minted?.find((m) => m.target_id === id);
        if (!item || item.selection_handle !== rec.selection_handle || item.handle_expires_at !== rec.handle_expires_at) {
          return bad(id + "：selection_handle 与产生 op result 逐字不符 (G-handle)");
        }
        // 返修三 P2：A2 的 anchor_candidate 与 mint 产生 op 的逐字等检查已删（A2 不由 mint 产生）
      } else if (prodOp.op_type === "reissue_selection_handle") {
        if (pr.new_handle !== rec.selection_handle || pr.new_expires_at !== rec.handle_expires_at) {
          return bad(id + "：selection_handle 与产生 op result 逐字不符 (G-handle)");
        }
        if (pr.anchor_candidate !== undefined && pr.anchor_candidate !== rec.anchor_candidate) {
          return bad(id + "：anchor_candidate 与产生 op result 逐字不符 (G-handle)");
        }
      }
    }

    if (rec.rebind_handle !== null && rec.rebind_handle !== undefined) {
      // 产生 op 集 = {request_rebind}
      const prodOps = Object.entries(doc.operations).filter(([, op]) => {
        if (op.op_type !== "request_rebind") return false;
        return op.result?.affected_live_ids_after_commit?.includes(id);
      }).sort((a, b) => b[1].result_revision - a[1].result_revision);
      if (prodOps.length === 0) return bad(id + "：rebind_handle 无产生 op (G-handle)");
      const [prodOpId, prodOp] = prodOps[0];

      const consumedByLater = Object.entries(doc.operations).some(([, op]) => {
        if (!["rebind_session_alias", "expire_rebind_handle", "cancel_rebind"].includes(op.op_type)) return false;
        if (op.result_revision <= prodOp.result_revision) return false;
        return op.result?.affected_live_ids_after_commit?.includes(id);
      });
      if (consumedByLater) return bad(id + "：rebind_handle 已被后续 op 消费/清理 (G-handle)");

      const pr = prodOp.result;
      if (pr.rebind_handle !== rec.rebind_handle || pr.rebind_expires_at !== rec.rebind_expires_at) {
        return bad(id + "：rebind_handle 与产生 op result 逐字不符 (G-handle)");
      }
    }
  }

  // 跨 op 核验：affected_live_ids_after_commit 与 proof_effects 关联等式
  for (const [opId, op] of Object.entries(doc.operations)) {
    const r = op.result;
    if (!r || !Array.isArray(r.affected_live_ids_after_commit)) continue;
    if (!Array.isArray(r.proof_effects)) return bad("带 affected_live_ids_after_commit 的 op 必带 proof_effects");
    const pesIds = new Set(r.proof_effects.map((p) => p.topic_agent_id));
    for (const pId of pesIds) {
      if (!r.affected_live_ids_after_commit.includes(pId)) {
        return bad("proof_effects 中的 id 不在 affected_live_ids_after_commit 中");
      }
    }
    for (const affId of r.affected_live_ids_after_commit) {
      const rec = doc.records[affId];
      if (rec && rec.kind === "live" && rec.origin_operation_id === opId) {
        const hasProof = rec.binding_proof !== null || rec.locator_link_proof_ref !== null;
        if (hasProof && !pesIds.has(affId)) return bad("affected 中有 proof 的记录未在 proof_effects 中列出");
        if (!hasProof && pesIds.has(affId)) return bad("affected 中无 proof 的记录不得在 proof_effects 中列出");
      }
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

/** 由 endpointId 载入（受验目录派生 + 校验）。给路由/投影用。
 *  P2-2（Codex）：任何读取失败（corrupt/unreadable/absent）都折成**封闭** m1a_ledger_absent，
 *   不泄露原始校验 reason；granular（absent|unreadable|corrupt）+ why 保留底层原因供既有调用方区分。 */
export function loadByEndpoint(endpointId, { env = process.env } = {}) {
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) {
    const granular = (d.reason === "no_root" || d.reason === "root_absent") ? "absent" : "unreadable";
    return { ok: false, reason: "m1a_ledger_absent", granular, why: d.why ?? d.reason };
  }
  const l = loadLedger(d.dir, { endpointId });
  if (!l.ok) {
    const granular = l.reason === "absent" ? "absent" : l.reason === "unreadable" ? "unreadable" : "corrupt";
    return { ok: false, reason: "m1a_ledger_absent", granular, why: l.why ?? l.reason };
  }
  return { ok: true, doc: l.doc, bytes: l.bytes, sha256: l.sha256 };
}

/** 按 locator 解析 live 影记录 id（claim→bind 的 b1Id、enabled 翻转的 id、void 的目标 id 共用）。
 *  locator = aliases.session_id 或 aliases.root_om；G3 校验保证全局唯一，但防御性复查命中多条→ambiguous。
 *  账本读取失败→ledger_absent / ledger_unreadable（fail-closed，不猜测）。 */
export function resolveLiveId({ endpointId, locator, env = process.env } = {}) {
  if (typeof locator !== "string" || locator.length === 0) return { ok: false, reason: "bad_locator" };
  const l = loadByEndpoint(endpointId, { env });
  if (!l.ok) {
    const absent = l.granular === "absent";
    return { ok: false, reason: absent ? "ledger_absent" : "ledger_unreadable", why: l.why ?? null };
  }
  const hits = [];
  for (const [id, r] of Object.entries(l.doc.records)) {
    if (r.kind !== "live") continue;
    if (r.aliases?.session_id === locator || r.aliases?.root_om === locator) hits.push(id);
  }
  if (hits.length === 0) return { ok: false, reason: "locator_absent" };
  if (hits.length > 1) return { ok: false, reason: "locator_ambiguous", ids: hits };
  return { ok: true, id: hits[0] };
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
    const nextBytes = serializeLedger(m.next);
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

/** 账本落盘字节（与 writeLedger 同一函数——plan 的 expected_ledger_sha256 必须用同一序列化重演算）。 */
const serializeLedger = (doc) => Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf-8");

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
// R51：owner_select 迁移三新种的 journal kind/phase/step 映射（owner-select-route.md §8.2；不 import owner-select-state.mjs ——
// 那边 import 本模块，会成循环依赖，故本地常量与它各住一份、由测试钉死两处相等）。
const OSM_KINDS = Object.freeze(["owner_select_migration_a", "owner_select_migration_b", "owner_select_migration_direct"]);
const OSM_KIND_TO_PHASE = Object.freeze({ owner_select_migration_a: "osm_a_upgrading", owner_select_migration_b: "osm_b_strictening", owner_select_migration_direct: "osm_direct" });
const OSM_KIND_TO_UPGRADE_EDGE = Object.freeze({ owner_select_migration_a: "1.0->1.1-transition", owner_select_migration_b: "1.1-transition->1.1", owner_select_migration_direct: "1.0->1.1" });
function _maintenanceVerifier(capability, endpointId, opType, env = process.env) {
  const fail = (reason, why) => ({ ok: false, reason, why });
  if (!capability || typeof capability !== "object") return fail("bad_capability", "capability 缺失");
  const isOsm = opType === "schema_upgrade" || opType === "mint_selection_handles";
  const wantKind = isOsm ? null : opType === "initialize_shadow" ? "ledger_init" : "ledger_cutover";
  const wantPhase = isOsm ? null : opType === "initialize_shadow" ? "ledger_initializing" : "ledger_cutting_over";
  const wantSub = isOsm ? null : opType === "initialize_shadow" ? "init" : "cutover";
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
  if (j.doc.schema_version !== (isOsm ? OWNER_SELECT_JOURNAL_SCHEMA : JOURNAL_SCHEMA)) return fail("journal_schema", "journal 不是 " + (isOsm ? OWNER_SELECT_JOURNAL_SCHEMA : JOURNAL_SCHEMA));
  // 门 + 租约共用核（init/cutover 与 owner_select 迁移同一段；原地提取不改顺序与语义）。
  const gateLeaseProblem = () => {
    const gate = readGate({ file: gateFile, now: Date.now() });
    if (gate.state !== "active") return fail("gate_not_active", "门 " + gate.state + (gate.why ? "：" + gate.why : ""));
    if (gate.payload?.token !== token) return fail("gate_token_mismatch", "门 token 与 operation 不一致");
    const holder = leaseHolder({ dir: maintDir, token });
    if (!holder.present) return fail("lease_absent", "operation 租约不存在");
    if (holder.unreadable) return fail("lease_unreadable", "租约读不出：" + holder.why);
    if (!holder.alive) return fail("lease_dead", "租约持有者 pid " + holder.pid + " 已不在");
    if (holder.at !== null && !isCanonicalIso(holder.at)) return fail("lease_payload_bad", "租约 owner.at 不是规范化 ISO");
    return null;
  };
  if (isOsm) {
    // R51 §一：owner_select 迁移的 capability —— kind/phase/step 与账本两态核验（§8.2）。
    const gl = gateLeaseProblem();
    if (gl !== null) return gl;
    const k = j.doc.operation_kind;
    if (!OSM_KINDS.includes(k)) return fail("operation_kind_mismatch", "operation_kind " + k + " 不属于 owner_select 三新种");
    if (opType === "mint_selection_handles" && k !== "owner_select_migration_a") return fail("operation_kind_mismatch", "mint_selection_handles 仅 owner_select_migration_a（当前 " + k + "）");
    const wantOsmPhase = OSM_KIND_TO_PHASE[k];
    if (j.doc.phase !== wantOsmPhase) return fail("phase_mismatch", "阶段 " + j.doc.phase + " ≠ " + wantOsmPhase);
    const stepKind = opType === "schema_upgrade" ? "schema_endpoint" : "mint";
    const variant = k === "owner_select_migration_a" ? "transition" : k === "owner_select_migration_b" ? "strict" : "direct";
    const wantStepId = opType === "schema_upgrade" ? "schema_endpoint:" + endpointId + ":" + variant : "mint:" + endpointId;
    const st = j.doc.steps.find((s) => s.kind === stepKind && s.id === wantStepId);
    if (!st) return fail("step_absent", "journal 无 " + wantStepId + " step");
    if (st.state !== "prepared") return fail("step_not_prepared", stepKind + " step 状态 " + st.state);
    if (st.target !== "ledger/" + endpointId + "/ledger.json") return fail("step_target_mismatch", stepKind + " step target 派生不符：" + st.target);
    // 租约 fencing 内读账本现场：step 必须锚定账本两态之一——before 态（执行路径）或 after 态（崩溃窗口：
    // 账本已提交、step 未 markStepDone —— 这是重放/already 支的可达前提，§8.2 mint 行“真正两态”的
    // capability 投影；单一 before 核会让那两支不可达）。
    const binding = commitWhileHeld(leasePath(maintDir, token), () => {
      const ld = resolveEndpointDir(endpointId, { env });
      if (!ld.ok) return ld;
      const L = loadLedger(ld.dir, { endpointId });
      if (!L.ok) return { ok: false, reason: L.reason, why: L.why ?? null };
      const atBefore = st.before.ledger_sha256 === L.sha256 && (opType !== "schema_upgrade" || st.before.schema_version === L.doc.schema_version);
      const atAfter = st.intended_after.ledger_sha256 === L.sha256 && (opType !== "schema_upgrade" || st.intended_after.schema_version === L.doc.schema_version);
      if (!atBefore && !atAfter) return { ok: false, reason: "ledger_state_mismatch", why: "账本不处于该 step 的 before/after 两态（SHA 或 schema_version 不符）" };
      return { ok: true, ledger: { dir: ld.dir, doc: L.doc, sha256: L.sha256 } };
    });
    if (!binding.ok || !binding.run) return fail("lease_lost", "本过程不再持有 operation 租约实例（commitWhileHeld：" + (binding?.reason ?? "lock_lost") + "）");
    if (!binding.run.ok) return fail(binding.run.reason, binding.run.why ?? null);
    return { ok: true, maintenanceDir: maintDir, doc: j.doc, osmStep: st, ledger: binding.run.ledger };
  }
  if (j.doc.operation_kind !== wantKind) return fail("operation_kind_mismatch", "operation_kind " + j.doc.operation_kind + " ≠ " + wantKind);
  if (j.doc.phase !== wantPhase) return fail("phase_mismatch", "阶段 " + j.doc.phase + " ≠ " + wantPhase);
  // ledger step 已在且 prepared、target 与 endpoint 一致（WAL 已落）
  const ls = j.doc.steps.find((s) => s.kind === "ledger");
  if (!ls) return fail("ledger_step_absent", "journal 尚无 ledger step");
  if (ls.state !== "prepared") return fail("ledger_step_not_prepared", "ledger step 状态 " + ls.state);
  const m = /^ledger:(endpoint_[0-9a-f]{24}):(init|cutover)$/u.exec(ls.id);
  if (!m || m[2] !== wantSub || m[1] !== endpointId) return fail("ledger_step_identity", "ledger step 身份与 endpoint/kind 不符");
  if (!CHAIN.includes(ls.chain)) return fail("ledger_chain_bad", "ledger step 缺 chain 或非法");
  // 门在且 token 与 journal 的 gate step intended_after 一致；租约存在且属于该 operation（leasePath(dir, token) 即 operation 专属）
  const gl = gateLeaseProblem();
  if (gl !== null) return gl;
  // 评审 P1-3：capability 必须证明**当前进程确实持有**该 operation 租约实例（commitWhileHeld 的 token fencing），
  // 且 plan 必须由 journal 里已落盘的 ledger step 重建，不得接受调用方任意 planIn。重建后逐字段绑定 before/intended_after。
  const lpath = leasePath(maintDir, token);
  // P1-6：cutover 的三条 sidecar step intended_after.sha256 是复合升级的锚——缺/形坏/重复都 fail-closed。
  // init（ledger_initializing）没有 sidecar 家族，不做这一核。
  let sidecarShas = null;
  if (wantSub === "cutover") {
    sidecarShas = { expiry: null, pending_claims: null, policy: null };
    for (const st of j.doc.steps) {
      if (st.kind !== "sidecar") continue;
      const nm = st.id.slice("sidecar:".length).split(":")[0];
      const key = nm === "pending-claims" ? "pending_claims" : nm;
      if (!(key in sidecarShas)) return fail("sidecar_anchors_missing", "sidecar step 名不在封闭集合：" + nm);
      if (sidecarShas[key] !== null) return fail("sidecar_anchors_missing", "重复的 sidecar step：" + nm);
      sidecarShas[key] = st.intended_after?.sha256 ?? null;
    }
    if (Object.values(sidecarShas).some((v) => typeof v !== "string" || !SHA_SHAPE.test(v))) {
      return fail("sidecar_anchors_missing", "三条 sidecar step 的 intended_after.sha256 缺失或非法");
    }
  }
  const binding = commitWhileHeld(lpath, () => {
    const ld = resolveEndpointDir(endpointId, { env });
    if (!ld.ok) return ld;
    const plan = rebuildPlanFromStep({ endpointId, chain: ls.chain, token, ledgerDir: ld.dir, step: ls, sidecarShas });
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
  return cutoverPlan({ endpointId, chain, requestKey: token, operationId: token, shadowDoc: L.doc, shadowSha: L.sha256, digest, sidecarShas });
}

/** 逐字段绑定 plan.before / plan.intended_after 与 ledger step（P1-3：字段名相同、键序无关、值全等才放行）。
 *  P1-6：journal 键集含 plan_sha256（1.3 八键，进段时才有）——逐字段绑定前剥掉它，蓝图与锚按其余键全等。 */
function bindPlanToStep(plan, ls) {
  const stripPlanSha = (o) => { if (!isObj(o)) return o; const { plan_sha256, ...rest } = o; return rest; };
  const eq = (a, b) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every((k) => a[k] === b[k]); };
  if (!eq(plan.before, stripPlanSha(ls.before))) return "plan.before 与 ledger step 的 before 不一致";
  if (!eq(plan.intendedAfter, stripPlanSha(ls.intended_after))) return "plan.intended_after 与 ledger step 的 intended_after 不一致";
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

/** 幂等构造 cutover 后的账本文档（authoritative, revision+1, 追加一笔 cutover op）+ 整文件 SHA（cutover 的 WAL 蓝图）。
 *  sidecarShas（P1-6 事务 §5）：三条 sidecar 的 SHA 进 fingerprint 与 result —— 复合升级的七键封闭绑定，
 *  缺任一（或形状不对）都 bad_sidecar_shas；cutover 不再是一条孤立的账本翻转变更。 */
export function cutoverPlan({ endpointId, chain, requestKey, operationId, shadowDoc, shadowSha, digest, sidecarShas }) {
  if (!shadowDoc || shadowDoc.authority_mode !== "shadow") return { ok: false, reason: "not_shadow" };
  if (!CHAIN.includes(chain)) return { ok: false, reason: "bad_chain" };
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, reason: "bad_request_key" };
  if (typeof digest !== "string" || !SHA_SHAPE.test(digest)) return { ok: false, reason: "bad_digest" };
  if (!(isObj(sidecarShas) && keysOf(sidecarShas) === "expiry,pending_claims,policy"
    && Object.values(sidecarShas).every((v) => typeof v === "string" && SHA_SHAPE.test(v)))) return { ok: false, reason: "bad_sidecar_shas" };
  const fingerprint = fingerprintOf("authority_cutover", {
    request_key: requestKey, endpoint_id: endpointId, bijection_digest: digest, pre_cutover_ledger_sha: shadowSha,
    expiry_sha256: sidecarShas.expiry, pending_claims_sha256: sidecarShas.pending_claims, policy_sha256: sidecarShas.policy,
  });
  const doc = structuredClone(shadowDoc);
  doc.revision += 1;
  doc.authority_mode = "authoritative";
  doc.operations[operationId] = {
    op_type: "authority_cutover", terminal_kind: "authority_cutover", request_key: requestKey, fingerprint,
    result_revision: doc.revision,
    result: {
      revision_at_cutover: doc.revision, endpoint_id: endpointId, bijection_digest: digest,
      pre_cutover_ledger_sha: shadowSha, expiry_sha256: sidecarShas.expiry,
      pending_claims_sha256: sidecarShas.pending_claims, policy_sha256: sidecarShas.policy,
    },
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
  // P1-6：重放输入从蓝图 result 派生七键封闭集（与 fingerprintOf 的键一致）——复合升级的幂等重放
  // 不能只对三键，否则换 sidecar 锚的重放会被误认成同一笔。
  const cutResult = plan.doc?.operations?.[plan.operationId]?.result ?? null;
  if (!isObj(cutResult)) return { ok: false, commit: "not_committed", reason: "plan_rebuild", why: "蓝图里没有 cutover operation result" };
  const res = writeLedger({
    dir: d.dir, endpointId, gated: false, requestKey, _inject,
    replay: () => [{ opType: "authority_cutover", inputs: {
      request_key: requestKey, endpoint_id: endpointId, bijection_digest: cutResult.bijection_digest,
      pre_cutover_ledger_sha: cutResult.pre_cutover_ledger_sha, expiry_sha256: cutResult.expiry_sha256,
      pending_claims_sha256: cutResult.pending_claims_sha256, policy_sha256: cutResult.policy_sha256,
    } }],
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

/* ─────────────────────────── owner_select 迁移执行器（R51） ─────────────────────────── */

/** R51 §二：schema_upgrade 窄事务（owner-select-route.md §6/§8）。
 *  前置：fromSchema->toSchema ∈ VALID_UPGRADE_EDGES 且与 capability step 变体一致；strict/direct 当场重新盘点
 *  （legacy 与 null-B1 全零才放行，不信任调用方盘点）。效果：schema_version 翻转 + 同笔给全部 live 记录补
 *  四字段显式 null（已有值不动，tombstone/voided 不动）；重放纪律与既有一致（同 key 同 fp → replayed，
 *  同 key 异 fp → request_conflict）。 */
export function schemaUpgrade({ endpointId, capability, requestKey, fromSchema, toSchema, env = process.env, _inject = null } = {}) {
  if (!capability || capability.kind !== "schema_upgrade") return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "kind 不符或缺失" };
  const cap = _maintenanceVerifier(capability, endpointId, "schema_upgrade", env);
  if (!cap.ok) return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: cap.reason + (cap.why ? "：" + cap.why : "") };
  const edge = String(fromSchema) + "->" + String(toSchema);
  if (typeof requestKey !== "string" || !REQUEST_KEY_SHAPE.test(requestKey)) return { ok: false, commit: "not_committed", reason: "bad_request_key" };
  if (!VALID_UPGRADE_EDGES.includes(edge)) return { ok: false, commit: "not_committed", reason: "bad_upgrade_edge", why: edge };
  const stepVariant = cap.osmStep.id.slice("schema_endpoint:".length).split(":")[1];
  if (OSM_KIND_TO_UPGRADE_EDGE[cap.doc.operation_kind] !== edge || !"transition|strict|direct".split("|").includes(stepVariant)) {
    return { ok: false, commit: "not_committed", reason: "edge_variant_mismatch", why: "capability step 变体 " + stepVariant + " 与边 " + edge + " 不一致" };
  }
  const d = resolveEndpointDir(endpointId, { env });
  if (!d.ok) return badTx(d);
  const inputs = { request_key: requestKey, endpoint: endpointId, from_schema: fromSchema, to_schema: toSchema };
  let builtSha = null; // 写前算好的预期 SHA（serializeLedger 同源），读回核锚它
  const res = writeLedger({
    dir: d.dir, endpointId, gated: false, requestKey, _inject,
    replay: () => [{ opType: "schema_upgrade", inputs }],
    mutate: (currentDoc) => {
      if (currentDoc === null) return { ok: false, reason: "absent" };
      // strict/direct 当场重新盘点（§8：Codex 不以现场盘点作放行依据，实现单门内当场重盘）；transition 不盘（precheck 仅 B/direct）。
      if (toSchema === "1.1") {
        const inv = migrationInventory(currentDoc);
        if (inv.legacy_proof_count !== 0 || inv.null_b1_count !== 0) return { ok: false, reason: "precheck_failed", why: "legacy_proof_count=" + inv.legacy_proof_count + " null_b1_count=" + inv.null_b1_count };
      }
      if (currentDoc.schema_version !== fromSchema) return { ok: false, reason: "schema_moved", why: "账本 schema_version " + currentDoc.schema_version + " ≠ fromSchema " + fromSchema };
      const next = stampAndBuild(currentDoc, {
        opType: "schema_upgrade", inputs, result: { endpoint: endpointId, from_schema: fromSchema, to_schema: toSchema },
        mutateRecords: (n) => {
          n.schema_version = toSchema;
          if (toSchema === "1.1") return; // strict：四字段已存在（transition 补过），已有值不动
          for (const rec of Object.values(n.records)) {
            if (rec.kind !== "live") continue;
            for (const k of ["selection_handle", "handle_expires_at", "rebind_handle", "rebind_expires_at"]) if (!(k in rec)) rec[k] = null;
          }
        },
      });
      builtSha = sha256(serializeLedger(next));
      return { ok: true, next };
    },
  });
  if (!res.ok || typeof res.commit !== "string" || !res.commit.startsWith("committed")) return { ok: false, commit: res?.commit ?? "not_committed", reason: res?.reason ?? "written_refused", why: res?.why ?? null, ...wrNote(res) };
  if (res.idempotent) return { ok: true, commit: "replayed", revision: res.revision, result: res.result, ...wrNote(res) };
  const reread = loadLedger(d.dir, { endpointId });
  if (!reread.ok || reread.sha256 !== builtSha || reread.doc.schema_version !== toSchema) {
    return { ok: false, commit: res.commit, reason: "written_mismatch", why: "读回 SHA/schema 与预期不符", ...wrNote(res) };
  }
  return { ok: true, commit: res.commit, revision: res.revision, result: res.result, sha256: reread.sha256, ...wrNote(res) };
}

/** R51 §五：mint_selection_handles 窄事务（§8.2 mint 行两态 CAS；capability 见 _maintenanceVerifier）。 */
export function mintSelectionHandles({ endpointId, capability, plan, env = process.env, _inject = null } = {}) {
  if (!capability || capability.kind !== "mint_selection_handles") return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: "kind 不符或缺失" };
  const cap = _maintenanceVerifier(capability, endpointId, "mint_selection_handles", env);
  if (!cap.ok) return { ok: false, commit: "not_committed", reason: "maintenance_capability_required", why: cap.reason + (cap.why ? "：" + cap.why : "") };
  return { ok: false, commit: "not_committed", reason: "executor_unavailable", why: "R51 §五 未实现（capability 已核过）" };
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
      if (!isObj(f4) || typeof f4.matched_om !== "string" || !OM_SHAPE.test(f4.matched_om) || matchedFieldsBad(f4.matched_fields, f4.pending_token_state)) return { ok: false, reason: "bad_f4" };
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
          s.binding_proof = { kind: "pairing", authorized_by: authorizedBy, authorized_at: iso, matched_om: f4.matched_om, matched_fields: [...f4.matched_fields], pending_token_state: f4.pending_token_state };
          s.locator_link_proof_ref = { kind: "pairing_merge", matched_om: f4.matched_om, matched_at: iso, matched_fields: [...f4.matched_fields], by_identity: "user", pending_token_state: f4.pending_token_state };
          s.updated_at = iso; s.origin_operation_id = opId;
          n.records[a1Id] = { kind: "forwarding_tombstone", topic_agent_id: a1Id, forwards_to: b1Id, merged_at: iso, proof_ref: { kind: "pairing", om: f4.matched_om, matched_fields: [...f4.matched_fields], pending_token_state: f4.pending_token_state }, origin_operation_id: opId };
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
      if (!isObj(f4) || typeof f4.root_om !== "string" || !OM_SHAPE.test(f4.root_om) || typeof f4.matched_om !== "string" || !OM_SHAPE.test(f4.matched_om) || matchedFieldsBad(f4.matched_fields, f4.pending_token_state)) return { ok: false, reason: "bad_f4" };
      // A4 已有 root_om（曾 A3）时，F4 新 root 若与旧不一致 = 正面矛盾 → 拒（评审三 P1-5：不许覆盖旧证）。
      if (rec.aliases.root_om !== null && rec.aliases.root_om !== f4.root_om) return { ok: false, reason: "root_conflict" };
      if (rec.aliases.root_om === null && liveLocatorInUse(doc, f4.root_om)) return { ok: false, reason: "locator_exists" };
      return { ok: true, next: stampAndBuild(doc, { opType: "attach_a3", inputs, result: { affected_id: id, terminal_family: "A3" }, mutateRecords: (n, opId) => {
        const r = n.records[id];
        r.facts.binding = "active"; r.facts.anchor = "present"; r.facts.locator_link_proof = "present";
        r.aliases.root_om = f4.root_om;
        r.binding_proof = { kind: "attach", authorized_by: authorizedBy, authorized_at: iso, claim_key: claimKey };
        r.locator_link_proof_ref = { kind: "f4_anchor", matched_om: f4.matched_om, matched_at: iso, matched_fields: [...f4.matched_fields], by_identity: "user", pending_token_state: f4.pending_token_state };
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
      if (!isObj(f4) || typeof f4.root_om !== "string" || !OM_SHAPE.test(f4.root_om) || typeof f4.matched_om !== "string" || !OM_SHAPE.test(f4.matched_om) || matchedFieldsBad(f4.matched_fields, f4.pending_token_state)) return { ok: false, reason: "bad_f4" };
      if (liveLocatorInUse(doc, f4.root_om)) return { ok: false, reason: "locator_exists" };
      return { ok: true, next: stampAndBuild(doc, { opType: "anchor", inputs, result: { affected_id: id }, mutateRecords: (n, opId) => {
        const r = n.records[id];
        r.aliases.root_om = f4.root_om; r.facts.anchor = "present"; r.facts.locator_link_proof = "present";
        r.locator_link_proof_ref = { kind: "f4_anchor", matched_om: f4.matched_om, matched_at: iso, matched_fields: [...f4.matched_fields], by_identity: "user", pending_token_state: f4.pending_token_state };
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

/** rebind_session_alias（W2 再认领 Phase 1，§5.1）：B3 已 active 换会话 → **只**改当前活记录的 aliases.session_id
 *  （Aily session locator），**不动** binding_target/proof/family/lineage（Phase 2 配对写方再 retarget binding_target）。
 *  CAS：当前 aliases.session_id 必须等于 expectedOldSessionId；新 locator 被另一条 live 记录占用 → fail-closed（alias_occupied，G3 backstop）。
 *  request_key 身份 = 字面参数（id + old/new session），与状态无关；结果 = {affected_id, old_session_id, new_session_id, authorized_by, authorized_at}。 */
export function rebindSessionAlias({ endpointId, requestKey, id, expectedOldSessionId, newSessionId, authorizedBy, now = Date.now(), env = process.env, _inject } = {}) {
  const iso = isoOrNull(now); if (iso === null) return BAD_TIME; // 评审七 P1-3：NaN now 不裸抛
  const reqInputs = { request_key: requestKey, topic_agent_id: id, old_session_id: expectedOldSessionId, new_session_id: newSessionId };
  return gatedTx({
    endpointId, requestKey, env, _inject, replay: () => [{ opType: "rebind_session_alias", inputs: reqInputs }],
    mutate: (doc) => {
      if (doc === null) return { ok: false, reason: "absent" };
      if (!isId(id)) return { ok: false, reason: "bad_id" };
      if (typeof expectedOldSessionId !== "string" || !AILY_SESSION_SHAPE.test(expectedOldSessionId)) return { ok: false, reason: "bad_input", why: "expectedOldSessionId 形状不对" };
      if (typeof newSessionId !== "string" || !AILY_SESSION_SHAPE.test(newSessionId)) return { ok: false, reason: "bad_input", why: "newSessionId 形状不对" };
      const rec = doc.records[id];
      if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live" };
      // P1-5（Codex）：只认精确 B3（active+current）。B4 历史代际 binding 也是 active，会被误判活跃而重绑——
      //   这里 fail-closed（B3' 仍读 dormant→target_not_active；B4/其它非 current → target_not_current）。
      const fam = familyOf(rec.facts);
      if (fam === "B3'") return { ok: false, reason: "target_not_active" };
      if (fam !== "B3") return { ok: false, reason: "target_not_current", why: "familyOf=" + String(fam) + "（仅 B3 current 可换会话重绑，B4 历史/其它 fail-closed）" };
      const oldSessionId = rec.aliases.session_id;
      if (oldSessionId !== expectedOldSessionId) return { ok: false, reason: "cas_mismatch", why: "当前 aliases.session_id 与 expectedOldSessionId 不符" };
      if (oldSessionId === newSessionId) return { ok: false, reason: "no_change" };
      // 新 locator 被另一条 live 记录占用 → fail-closed（G3 全局唯一 backstop；此处提前给出干净 reason）。
      for (const [k, r] of Object.entries(doc.records)) {
        if (k === id || r.kind !== "live") continue;
        if (typeof r.aliases.session_id === "string" && r.aliases.session_id === newSessionId) return { ok: false, reason: "alias_occupied" };
      }
      if (typeof authorizedBy !== "string" || !AUTHORIZED_BY_SHAPE.test(authorizedBy)) return { ok: false, reason: "bad_input" };
      return { ok: true, next: stampAndBuild(doc, {
        opType: "rebind_session_alias", inputs: reqInputs,
        result: { affected_id: id, old_session_id: oldSessionId, new_session_id: newSessionId, authorized_by: authorizedBy, authorized_at: iso },
        mutateRecords: (n, opId) => {
          const r = n.records[id];
          r.aliases.session_id = newSessionId; r.updated_at = iso; r.origin_operation_id = opId;
        },
      }) };
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
