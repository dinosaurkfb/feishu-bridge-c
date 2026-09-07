/**
 * 维护门的 **operation journal**（issue #81 PR C，方案稿"一本账"）。
 *
 *   · 位置：`<真实 home>/.claude/feishu-bridge/maintenance/<token>.json` + `maintenance/active`（symlink → token，同一时间只许一个）。
 *     只有测试隔离点 FEISHU_BRIDGE_MAINTENANCE_DIR 能覆盖目录。
 *   · **执行租约** `<token>.lease`：同一 operation 的 enter / exit / 续跑只许一个执行者（评审探针：等进程期间另一个 --exit 回退并清了 active，
 *     原 enter 醒来仍把 journal 写回 drained）。租约复用 registry 的锁协议，**只按持有者 pid 活性接管，不按时间**（等进程可以很久）；
 *     每次写 journal 都在租约的 reap 段内核对 token（commitWhileHeld）—— 租约被合法接管后晚到的写入 lease_lost，不落盘。
 *   · 每次更新都是**原子 + 持久**：同目录唯一临时名（O_EXCL | O_NOFOLLOW）写满 → fsync → rename → fsync 目录（只忽略"文件系统不支持目录 fsync"，EIO 之类照样失败）。
 *   · 三态读：active / journal 都是 absent（只有 ENOENT）| valid（形状逐字段受验）| unreadable（畸形不自动覆盖、不自动删）。
 *   · **形状按 step kind 封闭**（判别联合）：timer / current / stub / gate / artifact / receipt 各自的 before / intended_after / after 形状、id 形状都逐字段验；
 *     phase 与"必须已 done 的 step 集合"一致（timer_stopped 要两条 timer done，stubbed 要 stub + current 都 done，gated / drained 要 gate done）。
 *   · **每一次外部变更都是两阶段记账**：addStepPrepared（before / backup{sha256, bytes} / intended_after 落盘）→ 做变更 → markStepDone（记实际 after）。
 *     备份先写满 fsync、sha256 与长度进 journal，恢复前核验（对不上 → 该项 incomplete）。
 *   · 阶段封闭：planned → timer_stopped → stubbed → gated → drained → staged → committed → verified → reopening → done | reopening_incomplete；
 *     失败分支 rolling_back → rollback_reopening → rolled_back | rollback_incomplete。reopening / rollback_reopening 之后**不可逆**。
 *   · 终态先持久化，`active` 最后 token-CAS 清；"门已删、operation 未终结"的窗口里 --status 仍看得见。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { realUserHome } from "../maintenance-gate-core.mjs";
import { readRegularFile } from "../installed-surface.mjs";
import { acquireLockUngated, commitWhileHeld, releasePublishLock } from "../registry.mjs";
import { campaignIdFor, endpointsDigest } from "./owner-select-state.mjs";

export const MAINTENANCE_DIR_ENV = "FEISHU_BRIDGE_MAINTENANCE_DIR";
export const JOURNAL_SCHEMA = "1.2";
// M1b T4：cutover operation 从 1.3 起携带 sidecar step 与 plan_sha256 锚；1.1/1.2 冻结兼容照旧，1.2 读到 sidecar step 即 unreadable。
export const CUTOVER_JOURNAL_SCHEMA = "1.3";
export const OWNER_SELECT_JOURNAL_SCHEMA = "1.4";
// 旧 schema 1.1（无 operation_kind）：独立分支读，只作历史 journal（M1 账本接入 B-3 / 评审 P2-1）。
export const LEGACY_JOURNAL_SCHEMA = "1.1";
// M1b T4：sidecar 三件套（m1a-reconciliation.md §4.1 4e）——到期表 / 待认领表 / 交互策略条目。
export const SIDECAR_NAMES = Object.freeze(["expiry", "pending-claims", "policy"]);
// staged 私有目录规范（M1b T4 ③）：cutover 的 plan.json 与三个 sidecar blob 都落在 <token>.staged/intended/ 下，
// journal 校验器按这条规范重算 intended_blob.path 与 sidecar.backup 的位置——单一出处，别处不许再写字面量。
export const stagedDirFor = (token) => token + ".staged";
export const stagedIntendedFile = ({ dir, token, name }) => path.join(dir, stagedDirFor(token), "intended", name + ".json");
// 封闭 operation_kind（M1 账本接入 B）：新 1.2 必含；gate/install 是既有种，ledger_* 两个账本维护种（阶段/step 见 stage 2）。
export const OPERATION_KINDS = Object.freeze(["maintenance_gate", "maintenance_install", "ledger_init", "ledger_cutover", "owner_select_migration_a", "owner_select_migration_b", "owner_select_migration_direct"]);
export const PHASES = Object.freeze([
  "planned", "timer_stopped", "stubbed", "gated", "drained", "staged", "committed", "verified", "reopening", "done", "reopening_incomplete",
  "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete",
  // 账本接入（M1 B-1）：init/cutover 的不可逆前向段 + 账本 operation 的成功重开段。
  "ledger_initializing", "ledger_cutting_over", "ledger_reopening", "osm_a_upgrading", "osm_b_strictening", "osm_direct",
]);
// P1-7：阶段 × operation_kind 封闭（每 operation_kind 只许各自的阶段集；1.1 冻结为非账本阶段）。
// 1.1 历史 journal（无 operation_kind）：允许全部非账本阶段（旧 gate+install 种）。
const INSTALL_PHASES = Object.freeze(["planned", "timer_stopped", "stubbed", "gated", "drained", "staged", "committed", "verified", "reopening", "done", "reopening_incomplete", "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete"]);
// maintenance_gate（只进门+回退，不装任何东西）：禁 install 阶段（staged/committed/verified）与 install 步。
const GATE_ONLY_PHASES = Object.freeze(["planned", "timer_stopped", "stubbed", "gated", "drained", "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete"]);
const LEDGER_BASE_PHASES = Object.freeze(["planned", "timer_stopped", "stubbed", "gated", "drained", "ledger_reopening", "done", "reopening_incomplete", "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete"]);
const LEDGER_INIT_PHASES = Object.freeze([...LEDGER_BASE_PHASES, "ledger_initializing"]);
const LEDGER_CUTOVER_PHASES = Object.freeze([...LEDGER_BASE_PHASES, "ledger_cutting_over"]);
// R50 1.4：owner_select 三迁移 kind 各自 PHASES = LEDGER_BASE_PHASES + 专属 forward 段（进 FORWARD_ONLY_PHASES）。
const OSM_A_PHASES = Object.freeze([...LEDGER_BASE_PHASES, "osm_a_upgrading"]);
const OSM_B_PHASES = Object.freeze([...LEDGER_BASE_PHASES, "osm_b_strictening"]);
const OSM_DIRECT_PHASES = Object.freeze([...LEDGER_BASE_PHASES, "osm_direct"]);
export const TERMINAL_PHASES = Object.freeze(["done", "rolled_back"]);
/** 没做完的终态：门与账保留，--exit --apply 只向前重试。 */
export const INCOMPLETE_PHASES = Object.freeze(["reopening_incomplete", "rollback_incomplete"]);
/** 进了这些阶段只许向前（某条 current 已从桩指回真实 runtime，那条链已重新放行，不许再改线上制品；账本已提交亦然，B-1）。 */
export const FORWARD_ONLY_PHASES = Object.freeze(["reopening", "rollback_reopening", "ledger_initializing", "ledger_cutting_over", "ledger_reopening", "osm_a_upgrading", "osm_b_strictening", "osm_direct", ...TERMINAL_PHASES, ...INCOMPLETE_PHASES]);
export const STEP_KINDS = Object.freeze(["timer", "stub", "current", "gate", "artifact", "receipt", "staged_plan", "ledger", "sidecar", "campaign", "schema_endpoint", "mint", "precheck", "writer_state"]);
const NEW_OP_KINDS = Object.freeze(["owner_select_migration_a", "owner_select_migration_b", "owner_select_migration_direct"]);
const NEW_STEP_KINDS = Object.freeze(["campaign", "schema_endpoint", "mint", "precheck", "writer_state"]);
const ENDPOINT_SHAPE = /^endpoint_[0-9a-f]{24}$/u; // 账本 endpoint_id（layers-v2-ledger.md §2）
const SIDECAR_ID_SHAPE = new RegExp("^(?:" + SIDECAR_NAMES.join("|") + "):((?:endpoint_[0-9a-f]{24}))$");
export const TIMER_PHASES = Object.freeze(["loaded", "installed_not_loaded", "absent"]);
/** 走到某阶段时必须已 done 的 step。install 步（PR C 第 2 步）：staged 之后要求 plan 锚（staged_plan），commit 之后再要求两条 current:<chain>:install 与两条收据。 */
const ENTER_DONE = Object.freeze(["timer:claude", "timer:codex", "stub:claude", "stub:codex", "current:claude", "current:codex", "gate"]);
const STAGED_DONE = Object.freeze([...ENTER_DONE, "staged_plan"]);
const INSTALL_DONE = Object.freeze([...STAGED_DONE, "current:claude:install", "current:codex:install", "receipt:claude", "receipt:codex"]);
export const PHASE_REQUIRES = Object.freeze({
  timer_stopped: ["timer:claude", "timer:codex"],
  stubbed: ["timer:claude", "timer:codex", "stub:claude", "stub:codex", "current:claude", "current:codex"],
  gated: ENTER_DONE,
  drained: ENTER_DONE,
  staged: STAGED_DONE,
  committed: INSTALL_DONE,
  verified: INSTALL_DONE,
  reopening: INSTALL_DONE,
  done: INSTALL_DONE,
  reopening_incomplete: INSTALL_DONE,
});
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
/** current 只许指两种受控形状：正式版本 versions/<16 hex> 或维护桩 versions/maintenance-<uuid>（没有 . / .. / 多段的归一化歧义）。 */
const REL_TARGET = /^versions\/([0-9a-f]{16}|maintenance-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const errCode = (err) => String(err?.code ?? err?.message ?? err);

export function maintenanceDir(env = process.env) {
  const override = env[MAINTENANCE_DIR_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  const home = realUserHome();
  return home === null ? null : path.join(home, ".claude", "feishu-bridge", "maintenance");
}
export const journalPath = (dir, token) => path.join(dir, token + ".json");
export const activePath = (dir) => path.join(dir, "active");
export const leasePath = (dir, token) => path.join(dir, token + ".lease");

// ── 形状：按 kind 封闭的判别联合 ─────────────────────────────────────────────
const CHAIN_ID = /^(claude|codex)$/u;
function timerState(x) { return isObj(x) && keysOf(x) === "phase" && TIMER_PHASES.includes(x.phase); }
function shapeProblemFor(s) {
  const [kind, rest] = [s.kind, s.id.slice(s.kind.length + 1)];
  const idOk = s.id.startsWith(kind + ":") || s.id === kind;
  // P1-1：chain 只许 ledger step 携带（closed field），其余 kind 由 stepProblem 验 chain===null；非 ledger 仍走下面各自形状。
  if (kind === "ledger" && !CHAIN_ID.test(s.chain)) return "ledger step 的 chain 必须是 claude|codex";
  if (kind === "timer") {
    if (!idOk || !CHAIN_ID.test(rest)) return "timer 的 id 必须是 timer:<chain>";
    if (!(isObj(s.before) && keysOf(s.before) === "phase,plist" && TIMER_PHASES.includes(s.before.phase) && typeof s.before.plist === "string" && path.isAbsolute(s.before.plist))) return "timer.before 形状不对";
    if (!timerState(s.intended_after)) return "timer.intended_after 形状不对";
    if (!(s.after === null || timerState(s.after))) return "timer.after 形状不对";
    if (isObj(s.before) && s.before.phase === "loaded" && s.backup === null) return "timer 原来 loaded 必须有 plist 备份";
    return null;
  }
  if (kind === "current") {
    // enter 步 current:<chain>（原目标 → 桩）；install 步 current:<chain>:install（桩 → versions/<v>，PR C 第 2 步的 commit）
    if (!idOk || !/^(claude|codex)(:install)?$/u.test(rest)) return "current 的 id 必须是 current:<chain> 或 current:<chain>:install";
    if (!(s.before === null || (typeof s.before === "string" && REL_TARGET.test(s.before)))) return "current.before 不是 null 或 versions/<x>";
    if (!(typeof s.intended_after === "string" && REL_TARGET.test(s.intended_after))) return "current.intended_after 不是 versions/<x>";
    if (!(s.after === null || (typeof s.after === "string" && REL_TARGET.test(s.after)))) return "current.after 形状不对";
    if (s.backup !== null) return "current 不该有备份";
    return null;
  }
  if (kind === "stub") {
    if (!idOk || !CHAIN_ID.test(rest)) return "stub 的 id 必须是 stub:<chain>";
    if (s.before !== null) return "stub.before 必须是 null";
    if (!(typeof s.intended_after === "string" && /^versions\/maintenance-[0-9a-f-]{36}$/u.test(s.intended_after))) return "stub.intended_after 不是桩目标";
    if (!(s.after === null || s.after === s.intended_after)) return "stub.after 形状不对";
    if (s.backup !== null) return "stub 不该有备份";
    return null;
  }
  if (kind === "gate") {
    if (s.id !== "gate") return "gate 的 id 必须是 gate";
    if (s.before !== null) return "gate.before 必须是 null";
    const isUuid = (x) => typeof x === "string" && UUID_SHAPE.test(x);
    if (!(isObj(s.intended_after) && keysOf(s.intended_after) === "token" && isUuid(s.intended_after.token))) return "gate.intended_after 形状不对";
    const txnOk = (x) => x === null || (isObj(x) && keysOf(x) === "path,why" && typeof x.path === "string" && path.isAbsolute(x.path) && typeof x.why === "string");
    if (!(s.after === null || (isObj(s.after) && keysOf(s.after) === "token,txnUncleared" && isUuid(s.after.token) && txnOk(s.after.txnUncleared)))) return "gate.after 形状不对";
    if (s.backup !== null) return "gate 不该有备份";
    return null;
  }
  if (kind === "staged_plan") {
    // plan 锚（PR C 第 2 步）：staged/plan.json 的 sha256 + 版本进受租约保护的 journal，commit / verify 只认锚上的 plan
    if (s.id !== "staged_plan") return "staged_plan 的 id 必须是 staged_plan";
    if (s.before !== null) return "staged_plan.before 必须是 null";
    const anchor = (x) => isObj(x) && keysOf(x) === "sha256,version" && typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256) && typeof x.version === "string" && /^[0-9a-f]{16}$/u.test(x.version);
    if (!anchor(s.intended_after)) return "staged_plan.intended_after 形状不对";
    if (!(s.after === null || anchor(s.after))) return "staged_plan.after 形状不对";
    if (s.backup !== null) return "staged_plan 不该有备份";
    return null;
  }
  if (kind === "ledger") {
    // 账本 step（M1 B-2）：id = ledger:<endpoint>:init|cutover；before/intended_after/after 各按 init|cutover 封闭键集。
    const m = /^(endpoint_[0-9a-f]{24}):(init|cutover)$/u.exec(rest);
    if (!idOk || !m) return "ledger 的 id 必须是 ledger:<endpoint>:init|cutover";
    const [, ep, sub] = m;
    if (s.target !== ep) return "ledger step 的 target 必须是 endpoint_id";
    if (s.backup !== null) return "ledger step 不该有备份（账本自带 .prev）";
    // M1b T4：cutover 状态对象两代并存——1.2 冻结在 7 键；1.3 加 plan_sha256（8 键）。键集二选一，
    // 哪代强制哪种由 journalProblem 按 schema 收紧（这里 schema 无关，只认形状）。
    const keyset = sub === "cutover"
      ? ["authority_mode,bijection_digest,endpoint_id,fingerprint,ledger_sha256,operation_id,revision",
         "authority_mode,bijection_digest,endpoint_id,fingerprint,ledger_sha256,operation_id,plan_sha256,revision"]
      : ["authority_mode,endpoint_id,fingerprint,ledger_sha256,operation_id,revision"];
    const shaOrNull = (x) => x === null || (typeof x === "string" && SHA_SHAPE.test(x));
    const stateShape = (x) => isObj(x) && keyset.includes(keysOf(x)) && x.endpoint_id === ep
      && typeof x.operation_id === "string" && UUID_SHAPE.test(x.operation_id)
      && typeof x.fingerprint === "string" && SHA_SHAPE.test(x.fingerprint)
      && shaOrNull(x.ledger_sha256) && (sub !== "cutover" || shaOrNull(x.bijection_digest));
    if (!stateShape(s.before)) return "ledger.before 形状不对";
    if (!stateShape(s.intended_after)) return "ledger.intended_after 形状不对";
    if (!(s.after === null || stateShape(s.after))) return "ledger.after 形状不对";
    const isInt1 = (r) => Number.isSafeInteger(r) && r >= 1;
    if (sub === "init") {
      if (!(s.before.authority_mode === null && s.before.revision === null && s.before.ledger_sha256 === null)) return "init.before 必须是账本 absent（authority_mode/revision/sha 全 null）";
      if (!(s.intended_after.authority_mode === "shadow" && s.intended_after.revision === 1 && typeof s.intended_after.ledger_sha256 === "string")) return "init.intended_after 必须 shadow / revision=1 / 有 sha";
    } else {
      if (!(s.before.authority_mode === "shadow" && isInt1(s.before.revision) && typeof s.before.ledger_sha256 === "string" && s.before.bijection_digest === null)) return "cutover.before 必须 shadow / revision≥1 / 有 sha / bijection null";
      if (!(s.intended_after.authority_mode === "authoritative" && s.intended_after.revision === s.before.revision + 1 && typeof s.intended_after.ledger_sha256 === "string" && typeof s.intended_after.bijection_digest === "string")) return "cutover.intended_after 必须 authoritative / revision+1 / 有 sha / 有 bijection";
    }
    // 单次原子提交：after（done 时）必须逐字段等于 intended_after（B-2 恢复窗口判据同源）。
    if (s.after !== null && (keysOf(s.after) !== keysOf(s.intended_after) || Object.keys(s.after).some((k) => s.after[k] !== s.intended_after[k]))) return "ledger.after 必须逐字段等于 intended_after";
    return null;
  }
  // {exists, sha256}：存在必须有 sha，不存在必须 sha 为 null
  const fileState = (x) => isObj(x) && keysOf(x) === "exists,sha256" && typeof x.exists === "boolean" && (x.exists ? (typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256)) : x.sha256 === null);
  if (kind === "artifact" || kind === "receipt") {
    if (kind === "artifact" && (!idOk || !path.isAbsolute(rest))) return "artifact 的 id 必须是 artifact:<绝对路径>";
    if (kind === "receipt" && (!idOk || !CHAIN_ID.test(rest))) return "receipt 的 id 必须是 receipt:<chain>";
    if (!fileState(s.before) || !fileState(s.intended_after) || !(s.after === null || fileState(s.after))) return kind + " 的 before / intended_after / after 形状不对";
    if (s.before.exists && s.backup === null) return kind + " 原来存在必须有备份";
    if (!s.before.exists && s.backup !== null) return kind + " 原来不存在不该有备份";
    return null;
  }
  if (kind === "sidecar") {
    // M1b T4 ②：id = sidecar:<name>:<endpoint>；target = ledger/<endpoint>/<name>.json；
    // before/intended_after/after 是 {exists,sha256} 文件态；intended_blob 锚定 <token>.staged/intended/<name>.json 的计划字节
    // （token 段与「backup 是否在本 operation 私有目录」要 doc.token，在 journalProblem 核；这里核 step 内自洽）。
    if (!idOk) return "sidecar 的 id 必须是 sidecar:<name>:<endpoint>";
    const m = SIDECAR_ID_SHAPE.exec(rest);
    if (!m) return "sidecar 的 id 必须是 sidecar:<name>:<endpoint>";
    const [name, ep] = [rest.split(":")[0], m[1]];
    if (s.target !== "ledger/" + ep + "/" + name + ".json") return "sidecar 的 target 必须是 ledger/<endpoint>/<name>.json";
    if (!fileState(s.before) || !fileState(s.intended_after) || (s.after !== undefined && !fileState(s.after))) return "sidecar 的 before / intended_after / after 形状不对";
    if (s.intended_after.exists !== true) return "sidecar.intended_after 必须在场（cutover 权威写入的文件）";
    const blob = s.intended_blob;
    if (!(isObj(blob) && keysOf(blob) === "bytes,path,sha256" && typeof blob.path === "string" && path.isAbsolute(blob.path)
      && Number.isSafeInteger(blob.bytes) && blob.bytes >= 0 && typeof blob.sha256 === "string" && SHA_SHAPE.test(blob.sha256))) return "sidecar.intended_blob 形状不对";
    if (blob.sha256 !== s.intended_after.sha256) return "sidecar.intended_blob 的 sha 必须等于 intended_after";
    if (!blob.path.endsWith("/intended/" + name + ".json")) return "sidecar.intended_blob.path 不是 intended/<name>.json 的绝对路径";
    // 单次原子提交：done 的 after（键在）必须逐字段等于 intended_after（prepared 无 after 键，键集已分）。
    if (s.after !== undefined && (s.after.exists !== s.intended_after.exists || s.after.sha256 !== s.intended_after.sha256)) return "sidecar.after 必须逐字段等于 intended_after";
    if (s.before.exists && s.backup === null) return "sidecar 原来存在必须有备份";
    if (!s.before.exists && s.backup !== null) return "sidecar 原来不存在不该有备份";
    return null;
  }
  // ── R50 1.4：owner_select 五种新 step（§8.2 表）。target 一律内部派生（重算规范路径，不信 journal 中的路径）。──
  const CAMP_ID = /^osc_[0-9a-f]{32}$/u;
  const SCHEMA_VALUES = ["1.0", "1.1-transition", "1.1"];
  const fileBackupRule = (label) => {
    if (s.before.exists && s.backup === null) return label + " 原来存在必须有备份";
    if (!s.before.exists && s.backup !== null) return label + " 原来不存在不该有备份";
    return null;
  };
  if (kind === "campaign") {
    const m = /^(osc_[0-9a-f]{32}):(open|seal|complete)$/u.exec(rest);
    if (!idOk || !m) return "campaign 的 id 必须是 campaign:<campaign_id>:open|seal|complete";
    const [, cid, sub] = m;
    if (s.target !== "ledger/owner-select-campaign.json") return "campaign 的 target 必须是 ledger/owner-select-campaign.json";
    const campAbs = (x) => isObj(x) && keysOf(x) === "campaign_id,endpoints,endpoints_digest,exists,sha256,state"
      && typeof x.exists === "boolean"
      && (x.exists ? (typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256)) : x.sha256 === null)
      && (x.state === "absent"
          ? (!x.exists && x.campaign_id === null && x.endpoints === null && x.endpoints_digest === null)
          : (x.exists && CAMP_ID.test(x.campaign_id)
             && Array.isArray(x.endpoints) && x.endpoints.length > 0
             && x.endpoints.every((e) => typeof e === "string" && ENDPOINT_SHAPE.test(e))
             && x.endpoints.every((e, i) => i === 0 || x.endpoints[i - 1] < e)
             && x.endpoints_digest === endpointsDigest(x.endpoints)));
    if (!campAbs(s.before) || !campAbs(s.intended_after) || !(s.after === undefined || campAbs(s.after))) return "campaign.before/intended_after/after 联合形状不对";
    if (s.intended_after.state === "absent") return "campaign.intended_after 必须在场";
    if (sub === "open" && !(s.before.state === "absent" || s.before.state === "complete")) return "campaign open 的 before 必须 absent|complete";
    if (sub === "open" && s.intended_after.state !== "open") return "campaign open → intended.state=open";
    if (sub === "seal" && !(s.before.state === "open" && s.intended_after.state === "sealed")) return "campaign seal 的 before=open → intended=sealed";
    if (sub === "seal" && s.intended_after.campaign_id !== s.before.campaign_id) return "campaign seal 的 campaign_id 冻结";
    if (sub === "complete" && !(s.before.state === "sealed" && s.intended_after.state === "complete" && s.intended_after.campaign_id === s.before.campaign_id && s.intended_after.endpoints_digest === s.before.endpoints_digest)) return "campaign complete 的 before=sealed → complete、digest 冻结";
    if (s.after !== undefined && (s.after.state !== s.intended_after.state || s.after.endpoints_digest !== s.intended_after.endpoints_digest)) return "campaign.after 必须逐字段等于 intended_after";
    return fileBackupRule("campaign");
  }
  if (kind === "schema_endpoint") {
    const m = /^(endpoint_[0-9a-f]{24}):(transition|strict|direct)$/u.exec(rest);
    if (!idOk || !m) return "schema_endpoint 的 id 必须是 schema_endpoint:<ep>:transition|strict|direct";
    const [, ep, sub] = m;
    if (s.target !== "ledger/" + ep + "/ledger.json") return "schema_endpoint 的 target 必须是 ledger/<ep>/ledger.json";
    const st = (x) => isObj(x) && keysOf(x) === "ledger_sha256,revision,schema_version"
      && SCHEMA_VALUES.includes(x.schema_version) && Number.isSafeInteger(x.revision) && x.revision >= 1
      && (x.ledger_sha256 === null || (typeof x.ledger_sha256 === "string" && SHA_SHAPE.test(x.ledger_sha256)));
    if (!st(s.before) || !st(s.intended_after) || !(s.after === undefined || st(s.after))) return "schema_endpoint.before/intended_after/after 形状不对";
    const map = { transition: ["1.0", "1.1-transition"], strict: ["1.1-transition", "1.1"], direct: ["1.0", "1.1"] };
    const [from, to] = map[sub];
    if (s.before.schema_version !== from || s.intended_after.schema_version !== to) return "schema_endpoint." + sub + " 必须 " + from + "→" + to;
    if (s.intended_after.revision !== s.before.revision + 1) return "schema_endpoint 的 intended_after.revision 必须 before.revision+1";
    if (s.backup === null || s.backup_sha256 !== s.before.ledger_sha256) return "schema_endpoint 备份恒需且 backup_sha256===before.ledger_sha256";
    if (s.after !== undefined && (s.after.schema_version !== s.intended_after.schema_version || s.after.revision !== s.intended_after.revision || s.after.ledger_sha256 !== s.intended_after.ledger_sha256)) return "schema_endpoint.after 必须逐字段等于 intended_after";
    return null;
  }
  if (kind === "mint") {
    if (!idOk || !/^(endpoint_[0-9a-f]{24})$/u.test(rest)) return "mint 的 id 必须是 mint:<ep>";
    const ep = rest;
    if (s.target !== "ledger/" + ep + "/ledger.json") return "mint 的 target 必须是 ledger/<ep>/ledger.json";
    const st = (x) => isObj(x) && keysOf(x) === "ledger_sha256,null_b1_count,revision"
      && Number.isSafeInteger(x.null_b1_count) && x.null_b1_count >= 0 && Number.isSafeInteger(x.revision) && x.revision >= 1
      && (x.ledger_sha256 === null || (typeof x.ledger_sha256 === "string" && SHA_SHAPE.test(x.ledger_sha256)));
    if (!st(s.before) || !st(s.intended_after) || !(s.after === undefined || st(s.after))) return "mint.before/intended_after/after 形状不对";
    if (s.intended_after.null_b1_count !== 0 || s.intended_after.revision !== s.before.revision + 1) return "mint.intended_after 必须 null_b1_count=0 且 revision=before+1";
    const blob = s.intended_blob;
    if (!(isObj(blob) && keysOf(blob) === "bytes,path,sha256" && typeof blob.path === "string" && path.isAbsolute(blob.path) && Number.isSafeInteger(blob.bytes) && blob.bytes >= 0 && typeof blob.sha256 === "string" && SHA_SHAPE.test(blob.sha256))) return "mint.intended_blob 形状不对";
    // path 的完整重算（<token>.staged/intended/mint-<ep>.json，含 token+maintenanceDir 段级核）在 journalProblem 用 stagedBlobPathProblem 做；
    // 这里只核 blob 形状 + basename 落 intended 目录。
    if (!blob.path.endsWith("/intended/mint-" + ep + ".json")) return "mint.intended_blob.path 必须是 intended/mint-<ep>.json 的绝对路径";
    if (s.backup === null || s.backup_sha256 !== s.before.ledger_sha256) return "mint 备份恒需且 backup_sha256===before.ledger_sha256";
    return null;
  }
  if (kind === "precheck") {
    if (!idOk || !/^(endpoint_[0-9a-f]{24})$/u.test(rest)) return "precheck 的 id 必须是 precheck:<ep>";
    const ep = rest;
    if (s.target !== "ledger/" + ep + "/ledger.json") return "precheck 的 target 必须是 ledger/<ep>/ledger.json";
    const st = (x) => isObj(x) && keysOf(x) === "ledger_sha256,legacy_proof_count,null_b1_count,revision"
      && Number.isSafeInteger(x.legacy_proof_count) && x.legacy_proof_count >= 0 && Number.isSafeInteger(x.null_b1_count) && x.null_b1_count >= 0
      && Number.isSafeInteger(x.revision) && x.revision >= 1 && (x.ledger_sha256 === null || (typeof x.ledger_sha256 === "string" && SHA_SHAPE.test(x.ledger_sha256)));
    if (!st(s.before) || !st(s.intended_after) || !(s.after === undefined || st(s.after))) return "precheck.before/intended_after/after 形状不对";
    // 只读：before === intended_after === after 且两计数皆 0；三 backup 字段恒 null。
    if (!(s.intended_after.legacy_proof_count === 0 && s.intended_after.null_b1_count === 0)) return "precheck 的 intended_after 两计数必须皆 0（非 0 则本 step 不能 done）";
    if (s.after !== undefined && (s.after.legacy_proof_count !== s.intended_after.legacy_proof_count || s.after.ledger_sha256 !== s.intended_after.ledger_sha256)) return "precheck.after 必须逐字段等于 intended_after";
    if (s.backup !== null || s.backup_sha256 !== null || s.backup_bytes !== null) return "precheck 三 backup 字段恒 null";
    return null;
  }
  if (kind === "writer_state") {
    const m = /^(osc_[0-9a-f]{32}):(partial|on)$/u.exec(rest);
    if (!idOk || !m) return "writer_state 的 id 必须是 writer_state:<campaign_id>:partial|on";
    const [, wcid, sub] = m;
    if (s.target !== "ledger/owner-select-writer-state.json") return "writer_state 的 target 必须是 ledger/owner-select-writer-state.json";
    const wsAbs = (x) => isObj(x) && keysOf(x) === "campaign_id,endpoints_digest,exists,revision,sha256,state"
      && typeof x.exists === "boolean"
      && (x.exists ? (typeof x.sha256 === "string" && SHA_SHAPE.test(x.sha256)) : x.sha256 === null)
      && (x.state === "off"
          ? (!x.exists && x.campaign_id === null && x.endpoints_digest === null && x.revision === 0)
          : (x.exists && Number.isSafeInteger(x.revision) && x.revision >= 1
             && (x.state === "on" ? (typeof x.endpoints_digest === "string" && SHA_SHAPE.test(x.endpoints_digest)) : (x.endpoints_digest === null || (typeof x.endpoints_digest === "string" && SHA_SHAPE.test(x.endpoints_digest))))
             && (x.campaign_id === null ? x.state === "off" : CAMP_ID.test(x.campaign_id))));
    if (!wsAbs(s.before) || !wsAbs(s.intended_after) || !(s.after === undefined || wsAbs(s.after))) return "writer_state.before/intended_after/after 联合形状不对";
    if (sub === "partial" && !(s.before.state === "off" || s.before.state === "on")) return "writer_state partial 的 before 必须 off|on(退回)";
    if (sub === "partial" && s.intended_after.state !== "partial") return "writer_state partial → intended.state=partial";
    if (sub === "on" && s.intended_after.state !== "on") return "writer_state on → intended.state=on";
    if (s.intended_after.revision !== s.before.revision + 1) return "writer_state 的 intended_after.revision 必须 before.revision+1";
    if (s.after !== undefined && (s.after.state !== s.intended_after.state || s.after.revision !== s.intended_after.revision || s.after.endpoints_digest !== s.intended_after.endpoints_digest)) return "writer_state.after 必须逐字段等于 intended_after";
    return fileBackupRule("writer_state");
  }
  return "kind 不在受控集合里";
}
function stepProblem(s) {
  if (!isObj(s)) return "step 不是对象";
  if (!STEP_KINDS.includes(s.kind)) return "step kind 不在受控集合里";
  // M1b T4 返修 P1-2：sidecar 精确键集按 state 两态（maintenance-gate.md 阶段表）——
  // prepared = 11 键（无 after 无 chain）；done = prepared ∪ {after}。state 不是这两态 → 两套键集都不匹配即拒。
  const isNewOs = NEW_STEP_KINDS.includes(s.kind);
  const wantKeys = s.kind === "sidecar"
    ? (s.state === "done"
        ? "after,at,backup,backup_bytes,backup_sha256,before,id,intended_after,intended_blob,kind,state,target"
        : "at,backup,backup_bytes,backup_sha256,before,id,intended_after,intended_blob,kind,state,target")
    : isNewOs
      ? (s.state === "done"
          ? (s.kind === "mint" ? "after,at,backup,backup_bytes,backup_sha256,before,chain,id,intended_after,intended_blob,kind,state,target" : "after,at,backup,backup_bytes,backup_sha256,before,chain,id,intended_after,kind,state,target")
          : (s.kind === "mint" ? "at,backup,backup_bytes,backup_sha256,before,chain,id,intended_after,intended_blob,kind,state,target" : "at,backup,backup_bytes,backup_sha256,before,chain,id,intended_after,kind,state,target"))
      : "after,at,backup,backup_bytes,backup_sha256,before,chain,id,intended_after,kind,state,target";
  if (keysOf(s) !== wantKeys) return "step 字段集不对";
  if (typeof s.id !== "string" || s.id.length === 0) return "step id 不是字符串";
  if (s.kind !== "ledger" && s.kind !== "sidecar" && s.chain !== null) return "非 ledger step 不该有 chain";
  if (typeof s.target !== "string" || s.target.length === 0) return "step target 不是字符串";
  if (!(s.backup === null || (typeof s.backup === "string" && path.isAbsolute(s.backup)))) return "step backup 不是 null 或绝对路径";
  if (s.backup === null ? (s.backup_sha256 !== null || s.backup_bytes !== null) : !(typeof s.backup_sha256 === "string" && SHA_SHAPE.test(s.backup_sha256) && Number.isSafeInteger(s.backup_bytes) && s.backup_bytes >= 0)) return "备份的 sha256 / 长度与 backup 不一致";
  if (!(s.state === "prepared" || s.state === "done")) return "step state 不是 prepared / done";
  // prepared 两阶段：after 不得在场。非 sidecar 的 prepared 用 after:null 表达；sidecar prepared 合同是 after 键缺席（P1-2），
  // 由键集核管（wantKeys 不含 after）——这里豁免 sidecar，只看它 done 时 after === intended_after（shapeProblemFor）。
  if (s.state === "prepared" && s.kind !== "sidecar" && !isNewOs && s.after !== null) return "prepared 的 step 不该有 after";
  if (s.state === "done" && s.after === null) return "done 的 step 必须有 after";
  if (!isCanonicalIso(s.at)) return "step at 不是规范化 ISO 时间";
  return shapeProblemFor(s);
}
/** 阶段要求的 step id（按 operation_kind 分派，M1 账本接入 B）：ledger 阶段用 ENTER_DONE + 账本 step；其余用 PHASE_REQUIRES。 */
function requiredStepIds(doc) {
  const isLedger = (doc.schema_version === JOURNAL_SCHEMA || doc.schema_version === CUTOVER_JOURNAL_SCHEMA)
    && (doc.operation_kind === "ledger_init" || doc.operation_kind === "ledger_cutover");
  if (isLedger) {
    if (doc.phase === "ledger_initializing" || doc.phase === "ledger_cutting_over") return ENTER_DONE;
    if (doc.phase === "ledger_reopening" || doc.phase === "done" || doc.phase === "reopening_incomplete") {
      const ls = doc.steps.find((s) => s.kind === "ledger");
      const extra = ls ? [ls.id] : ["ledger:missing"];
      // M1b T4：1.3 cutover 重开族要求三条 sidecar 全 done（ENTER_DONE 集合的 sidecar 增列）。
      if (doc.schema_version === CUTOVER_JOURNAL_SCHEMA && doc.operation_kind === "ledger_cutover" && ls) {
        const ep = ls.id.split(":")[1];
        extra.push(...SIDECAR_NAMES.map((n) => "sidecar:" + n + ":" + ep));
      }
      return [...ENTER_DONE, ...extra];
    }
  }
  return PHASE_REQUIRES[doc.phase];
}
/**
 * P1-3：intended_blob.path 的段级核（替代 endsWith）——规范绝对路径（normalize 恒等、无点段、无冗余分隔符），
 * 按段精确匹配 <token>.staged / intended / <name>.json。外指目录树（/evil/<token>.staged/…）与 .. 遍历在此拒。
 * 返回 null 或问题短句（不带主语，由调用方拼）。
 */
function stagedBlobPathProblem(blobPath, token, name, maintenanceDir) {
  if (typeof blobPath !== "string" || !blobPath.startsWith("/")) return "不是绝对路径";
  if (path.normalize(blobPath) !== blobPath) return "不是规范路径（含 . / .. / 冗余分隔符）";
  const segs = blobPath.slice(1).split("/");
  if (segs.length < 3) return "层级不够";
  if (segs[segs.length - 1] !== name + ".json") return "basename 不是 <name>.json";
  if (segs[segs.length - 2] !== "intended") return "倒数第二段不是 intended";
  if (segs[segs.length - 3] !== token + ".staged") return "staged 段不是 <token>.staged";
  // 调用方给了维护目录时强核前缀（段级）：/evil/<token>.staged/… 这类外指树在此拒。
  if (maintenanceDir !== undefined) {
    const prefixProblem = maintenanceDirSegments(maintenanceDir);
    if (prefixProblem !== null) return "维护目录" + prefixProblem;
    const base = maintenanceDir.slice(1).split("/").filter((s) => s !== "");
    if (segs.length !== base.length + 3) return "不在维护目录树下";
    for (let i = 0; i < base.length; i++) if (segs[i] !== base[i]) return "不在维护目录树下";
  }
  return null;
}

/** 维护目录自身的词法核：规范绝对路径（normalize 恒等）。TOCTOU 由 staged-plan 侧逐层 lstat 受验管。 */
function maintenanceDirSegments(maintenanceDir) {
  if (typeof maintenanceDir !== "string" || !maintenanceDir.startsWith("/") || path.normalize(maintenanceDir) !== maintenanceDir) return "不是规范绝对路径";
  return null;
}

export function journalProblem(doc, { maintenanceDir } = {}) {
  if (!isObj(doc)) return "不是对象";
  // schema 判别（M1 账本接入 B / 评审 P2-1；M1b T4 加 1.3；R50 加 1.4）：1.2/1.3/1.4 必含 operation_kind；旧 1.1 无该字段。
  if (doc.schema_version !== JOURNAL_SCHEMA && doc.schema_version !== LEGACY_JOURNAL_SCHEMA && doc.schema_version !== CUTOVER_JOURNAL_SCHEMA && doc.schema_version !== OWNER_SELECT_JOURNAL_SCHEMA) return "schema_version 不认识";
  const is12 = doc.schema_version === JOURNAL_SCHEMA;
  const is13 = doc.schema_version === CUTOVER_JOURNAL_SCHEMA;
  const is14 = doc.schema_version === OWNER_SELECT_JOURNAL_SCHEMA;
  const fieldset = is12 || is13 || is14
    ? "notes,operation_kind,phase,reason,schema_version,started_at,steps,token,updated_at"
    : "notes,phase,reason,schema_version,started_at,steps,token,updated_at";
  if (keysOf(doc) !== fieldset) return "字段集不对";
  if ((is12 || is13 || is14) && !OPERATION_KINDS.includes(doc.operation_kind)) return "operation_kind 不在封闭集合里：" + String(doc.operation_kind);
  // R50 item 2：旧版（1.2/1.3）读新 owner_select migration kind → unreadable（fail-closed，不得静默忽略、不当 orphan 清）。
  if ((is12 || is13) && NEW_OP_KINDS.includes(doc.operation_kind)) return "1.2/1.3 读新 owner_select migration kind（unreadable）";
  // 二轮 P1-1：1.3 是 ledger_cutover 的专属判别支 —— 非 cutover 操作一律按 1.2 记账，1.3 遇到它们即不可达态 → unreadable。
  if (is13 && doc.operation_kind !== "ledger_cutover") return "1.3 是 ledger_cutover 专属判别支（" + doc.operation_kind + " 按 1.2 记账）";
  if (typeof doc.token !== "string" || !UUID_SHAPE.test(doc.token)) return "token 不是 UUID 字符串";
  if (typeof doc.reason !== "string" || [...doc.reason].length > 80) return "reason 不是 ≤ 80 码点的字符串";
  if (!isCanonicalIso(doc.started_at) || !isCanonicalIso(doc.updated_at)) return "时间不是规范化 ISO";
  // P1-7：阶段 × operation_kind 封闭（1.1 冻结为非账本阶段；ledger_init 不得进入 ledger_cutting_over，反之亦然）。
  const isLedgerKind = (is12 || is13) && (doc.operation_kind === "ledger_init" || doc.operation_kind === "ledger_cutover");
  const allowed = is14
    ? (doc.operation_kind === "owner_select_migration_a" ? OSM_A_PHASES
       : doc.operation_kind === "owner_select_migration_b" ? OSM_B_PHASES
       : doc.operation_kind === "owner_select_migration_direct" ? OSM_DIRECT_PHASES
       : LEDGER_CUTOVER_PHASES) // 1.4 读旧种：行为与 1.3 完全相同（cutover 专属，不放宽旧规则）
    : is13 ? LEDGER_CUTOVER_PHASES
    : !is12 ? INSTALL_PHASES
    : doc.operation_kind === "ledger_init" ? LEDGER_INIT_PHASES
    : doc.operation_kind === "ledger_cutover" ? LEDGER_CUTOVER_PHASES
    : doc.operation_kind === "maintenance_gate" ? GATE_ONLY_PHASES
    : INSTALL_PHASES;
  if (!allowed.includes(doc.phase)) return (is14 || is12 ? "operation_kind " + doc.operation_kind : "旧 1.1") + " 不得处于阶段 " + doc.phase;
  if (!Array.isArray(doc.steps)) return "steps 不是数组";
  // R50 item 2：旧版（1.2/1.3）含任一新 step kind → unreadable（fail-closed）。
  if ((is12 || is13) && doc.steps.some((s) => NEW_STEP_KINDS.includes(s.kind))) return "1.2/1.3 含新 owner_select step kind（unreadable）";
  const ids = new Set();
  for (const s of doc.steps) { const p = stepProblem(s); if (p !== null) return p; if (ids.has(s.id)) return "step id 重复：" + s.id; ids.add(s.id); }
  for (const s of doc.steps) if ((s.kind === "stub" || s.kind === "gate") && s.state === "done") {
    if (s.kind === "gate" && s.after.token !== doc.token) return "gate 的 token 与 operation 不一致";
    if (s.kind === "stub" && !s.intended_after.endsWith("maintenance-" + doc.token)) return "桩目标与 operation token 不一致";
  }
  // P1-2（第 5/6 轮）：非 install 的 `current:<chain>` 必须关联**同链且 done** 的本 operation 桩，
  //  且 current.intended_after === stub.intended_after === versions/maintenance-<doc.token>；
  //  三形封闭：① prepared current 指别 operation 桩 ② done current 而同链桩缺失 ③ done current.after !== intended_after，
  //  任一不成立 → journal 非法，不得进恢复——否则 ledger-operation 重开会把别的 operation 的桩当本 operation 执行。
  for (const s of doc.steps) if (s.kind === "current" && !s.id.endsWith(":install")) {
    const chain = s.id.split(":")[1];
    if (typeof chain !== "string" || chain.length === 0) continue;
    const stub = doc.steps.find((x) => x.kind === "stub" && x.id === "stub:" + chain);
    if (stub === undefined || stub.state !== "done") return "current 无同链已 done 的桩";
    const want = "maintenance-" + doc.token;
    if (!(s.intended_after ?? "").endsWith(want)) return "current 目标与 operation token 不一致";
    if (s.intended_after !== stub.intended_after) return "current 目标与桩不一致";
    if (s.state === "done" && s.after !== s.intended_after) return "current 的 after 与 intended_after 不一致";
  }
  // step 类型 × operation_kind 封闭（M1 账本接入 B，设计"ledger_* 禁 install 步 / gate·install 禁 ledger 步"；
  // M1b T4：sidecar 仅 1.3 ledger_cutover——1.2 读到 sidecar 即 unreadable，1.3 其余种拒）。
  const hasSidecar = doc.steps.some((s) => s.kind === "sidecar");
  if (is12 || is13) {
    if (is12 && hasSidecar) return "1.2 不得含 sidecar step（1.3 专属，1.2 读作 unreadable）";
    if (is13 && hasSidecar && doc.operation_kind !== "ledger_cutover") return doc.operation_kind + " 不得含 sidecar step";
    const isLedger = doc.operation_kind === "ledger_init" || doc.operation_kind === "ledger_cutover";
    // 1.2 冻结：cutover 状态对象不得带 plan_sha256（8 键是 1.3 形状；1.2 收据历史完全冻结）。
    if (is12) {
      for (const s of doc.steps) if (s.kind === "ledger" && s.id.endsWith(":cutover")
        && [s.before, s.intended_after, s.after].some((x) => x !== null && x.plan_sha256 !== undefined)) return "1.2 冻结：cutover 状态对象不得带 plan_sha256";
    }
    const ledgerSteps = doc.steps.filter((s) => s.kind === "ledger");
    if (!isLedger && ledgerSteps.length > 0) return doc.operation_kind + " 不得含 ledger step";
    if (isLedger) {
      if (doc.steps.some((s) => s.kind === "artifact" || s.kind === "receipt" || s.kind === "staged_plan" || (s.kind === "current" && s.id.endsWith(":install")))) return "账本 operation 不得含 install step";
      if (ledgerSteps.length > 1) return "账本 operation 至多一个 ledger step";
      const wantSub = doc.operation_kind === "ledger_init" ? "init" : "cutover";
      for (const s of ledgerSteps) {
        if (!s.id.endsWith(":" + wantSub)) return "ledger step 的 init/cutover 与 operation_kind 不一致";
        if (s.before.operation_id !== doc.token || s.intended_after.operation_id !== doc.token) return "ledger step 的 operation_id 与 operation token 不一致";
      }
    } else if (doc.operation_kind === "maintenance_gate") {
      // P1-7：gate 不做安装，禁 install 专属步（staged_plan / current:<chain>:install / artifact / receipt）。
      if (doc.steps.some((s) => s.kind === "artifact" || s.kind === "receipt" || s.kind === "staged_plan" || (s.kind === "current" && s.id.endsWith(":install")))) return "maintenance_gate 不得含 install step";
    }
  } else {
    // 1.1 冻结（P1-7）：旧种（gate/install）不得含账本步 / sidecar 步、不得处于账本阶段——已由上方的 phase 封闭拦截。
    if (doc.steps.some((s) => s.kind === "ledger")) return "旧 1.1 不得含 ledger step";
    if (hasSidecar) return "旧 1.1 不得含 sidecar step";
  }
  // R50 item 6：owner_select 迁移 kind 的交叉等式（三处同一）+ mint blob path 完整重算 + forward 段前禁新 step kind。
  if (is14 && NEW_OP_KINDS.includes(doc.operation_kind)) {
    const steps = doc.steps;
    const hasNew = steps.some((s) => NEW_STEP_KINDS.includes(s.kind));
    const preFwd = ["planned", "timer_stopped", "stubbed", "gated", "drained", "rolling_back", "rollback_reopening", "rolled_back", "rollback_incomplete"].includes(doc.phase);
    if (preFwd && hasNew) return "forward 段之前禁任何新 step kind";
    // ① campaign_id 三处同一派生：每笔 campaign step 的 intended_after.campaign_id === campaignIdFor(doc.token)。
    for (const s of steps) if (s.kind === "campaign" && s.intended_after.campaign_id !== campaignIdFor(doc.token)) return "campaign.campaign_id 必须 === campaignIdFor(token)（三处同一派生）";
    // ② mint intended_blob.path 完整重算（token+maintenanceDir 段级核，复用既有 stagedBlobPathProblem）。
    for (const s of steps) if (s.kind === "mint") {
      const p = stagedBlobPathProblem(s.intended_blob.path, doc.token, "mint-" + s.id.slice("mint:".length), maintenanceDir);
      if (p) return "mint.intended_blob.path：" + p;
    }
    // ③ 恰一次计数（按冻结集，§8.2）：A/direct 取 :open、B 取 :seal 的 intended_after.endpoints；每 ep 恰一条本 kind 变体。
    const pickSub = doc.operation_kind === "owner_select_migration_b" ? "seal" : "open";
    const frozen = (steps.find((s) => s.kind === "campaign" && s.id.endsWith(":" + pickSub))?.intended_after?.endpoints) ?? [];
    const cnt = (pred) => steps.filter(pred).length;
    const campSub = (sub) => cnt((s) => s.kind === "campaign" && s.id.endsWith(":" + sub));
    const writerSub = (sub) => cnt((s) => s.kind === "writer_state" && s.id.endsWith(":" + sub));
    const kind = doc.operation_kind;
    // 每个新 step 的 <ep>/<cid> 必须 ∈ frozen 集（schema_endpoint/mint/precheck 用 <ep>；writer_state 用 campaign 派生已核）。
    for (const s of steps) if (s.kind === "schema_endpoint" || s.kind === "mint" || s.kind === "precheck") {
      const ep = s.id.split(":")[1];
      if (!frozen.includes(ep)) return s.kind + " <ep=" + ep + "> 不在本 operation 冻结集";
    }
    const expect = (cond, why) => { if (!cond) return why; return null; };
    let e6 = null;
    if (kind === "owner_select_migration_a") {
      e6 = expect(campSub("open") === 1, ":open 必须恰一");
      if (!e6) e6 = expect(writerSub("partial") === 1, "writer_state:*:partial 必须恰一");
      if (!e6) for (const ep of frozen) { e6 = expect(cnt((s) => s.kind === "schema_endpoint" && s.id === "schema_endpoint:" + ep + ":transition") === 1, ep + " 的 transition 必须恰一"); if (e6) break; e6 = expect(cnt((s) => s.kind === "mint" && s.id === "mint:" + ep) === 1, ep + " 的 mint 必须恰一"); if (e6) break; }
    } else if (kind === "owner_select_migration_b") {
      e6 = expect(campSub("seal") === 1 && campSub("complete") === 1, ":seal 与 :complete 各恰一");
      if (!e6) e6 = expect(writerSub("on") === 1, "writer_state:*:on 必须恰一");
      if (!e6) for (const ep of frozen) { e6 = expect(cnt((s) => s.kind === "precheck" && s.id === "precheck:" + ep) === 1, ep + " 的 precheck 必须恰一"); if (e6) break; e6 = expect(cnt((s) => s.kind === "schema_endpoint" && s.id === "schema_endpoint:" + ep + ":strict") === 1, ep + " 的 strict 必须恰一"); if (e6) break; }
    } else {
      e6 = expect(campSub("open") === 1 && campSub("seal") === 1 && campSub("complete") === 1, ":open/:seal/:complete 各恰一");
      if (!e6) e6 = expect(writerSub("on") === 1, "writer_state:*:on 必须恰一");
      if (!e6) for (const ep of frozen) { e6 = expect(cnt((s) => s.kind === "precheck" && s.id === "precheck:" + ep) === 1, ep + " 的 precheck 必须恰一"); if (e6) break; e6 = expect(cnt((s) => s.kind === "schema_endpoint" && s.id === "schema_endpoint:" + ep + ":direct") === 1, ep + " 的 direct 必须恰一"); if (e6) break; }
    }
    if (e6) return "恰一次计数：" + e6;
    // 重开族起：全部新 step 必须 done。
    const reopen = ["ledger_reopening", "done", "reopening_incomplete"].includes(doc.phase);
    if (reopen && steps.some((s) => NEW_STEP_KINDS.includes(s.kind) && s.state !== "done")) return "重开族起全部新 step 必须 done";
    // A/direct 禁 :on、B 禁 :partial（item 4 的变体排除，此处与恰一次互证）。
    if (kind === "owner_select_migration_a" && writerSub("on") > 0) return "A 禁 writer_state:*:on";
    if (kind === "owner_select_migration_b" && writerSub("partial") > 0) return "B 禁 writer_state:*:partial";
    if (kind === "owner_select_migration_direct" && writerSub("partial") > 0) return "direct 禁 writer_state:*:partial";
  }

  // R50 item 4：禁异类 step（逐 kind 封闭）。
  if (is14 && NEW_OP_KINDS.includes(doc.operation_kind)) {
    const steps = doc.steps;
    const FORBID_COMMON = (s) => s.kind === "ledger" || s.kind === "sidecar" || s.kind === "artifact" || s.kind === "receipt" || s.kind === "staged_plan" || (s.kind === "current" && s.id.endsWith(":install"));
    if (steps.some(FORBID_COMMON)) return "new kind 禁 ledger/sidecar/artifact/receipt/staged_plan/current:*:install";
    if (doc.operation_kind === "owner_select_migration_a") {
      if (steps.some((s) => s.kind === "precheck" || (s.kind === "schema_endpoint" && /:(strict|direct)$/u.test(s.id)) || (s.kind === "writer_state" && s.id.endsWith(":on")))) return "A 禁 precheck / schema_endpoint:*:strict|direct / writer_state:*:on";
    } else if (doc.operation_kind === "owner_select_migration_b") {
      if (steps.some((s) => s.kind === "mint" || (s.kind === "campaign" && s.id.endsWith(":open")) || (s.kind === "schema_endpoint" && /:(transition|direct)$/u.test(s.id)) || (s.kind === "writer_state" && s.id.endsWith(":partial")))) return "B 禁 mint / campaign:*:open / schema_endpoint:*:transition|direct / writer_state:*:partial";
    } else {
      if (steps.some((s) => s.kind === "mint" || (s.kind === "schema_endpoint" && /:(transition|strict)$/u.test(s.id)) || (s.kind === "writer_state" && s.id.endsWith(":partial")))) return "direct 禁 mint / schema_endpoint:*:transition|strict / writer_state:*:partial";
    }
  }
  // 旧四 kind（含 is14 读旧种）禁五新 step kind；is12/is13 已在 item 2 由新 step kind 判 unreadable，这里补 1.4 读旧种。
  if ((is14 || is12 || is13) && !NEW_OP_KINDS.includes(doc.operation_kind) && doc.steps.some((s) => NEW_STEP_KINDS.includes(s.kind))) return "旧 four kind 禁五新 step kind";

  const required = requiredStepIds(doc);
  if (required) for (const id of required) { const s = doc.steps.find((x) => x.id === id); if (!s || s.state !== "done") return "阶段 " + doc.phase + " 要求 " + id + " 已 done"; }
  // 评审 P1-1：前向 ledger 阶段必须已有 ledger step（进前向态与 ledger step 落盘是 enterLedgerForward 的**一次**原子更新，
  // 拿不到 step 的 ledger_initializing/cutting_over 只可能是旧种崩溃残留，fail-closed——EXIT 不再放行恢复死窗）。
  if (isLedgerKind && (doc.phase === "ledger_initializing" || doc.phase === "ledger_cutting_over") && !doc.steps.some((s) => s.kind === "ledger")) return "前向阶段 " + doc.phase + " 必须已有 ledger step";
  // 评审 P1-4：phase × ledger step 状态封闭——进前向前的阶段（planned..drained）ledger step 必须为零；
  // 前向阶段（ledger_initializing / ledger_cutting_over）恰一条且状态仅 prepared 或 done（已 done 未推 phase 的崩溃态放行）。
  if (isLedgerKind) {
    const lsCount = doc.steps.filter((s) => s.kind === "ledger").length;
    const sidecarCount = doc.steps.filter((s) => s.kind === "sidecar").length;
    if (doc.phase === "planned" || doc.phase === "timer_stopped" || doc.phase === "stubbed" || doc.phase === "gated" || doc.phase === "drained") {
      if (lsCount !== 0) return "进前向前的阶段 " + doc.phase + " 不得含 ledger step";
      if (sidecarCount !== 0) return "进前向前的阶段 " + doc.phase + " 不得含 sidecar step";
    } else if (doc.phase === "ledger_initializing" || doc.phase === "ledger_cutting_over") {
      const ls = doc.steps.find((s) => s.kind === "ledger");
      if (lsCount !== 1 || !ls || (ls.state !== "prepared" && ls.state !== "done")) return "前向阶段 " + doc.phase + " 要求恰一条 prepared/done 的 ledger step";
      if (sidecarCount !== 0 && doc.phase === "ledger_initializing") return "ledger_initializing 不得含 sidecar step";
    } else if (doc.phase === "rolling_back" || doc.phase === "rollback_reopening" || doc.phase === "rolled_back" || doc.phase === "rollback_incomplete") {
      if (lsCount !== 0) return "回退阶段 " + doc.phase + " 不得含 ledger step";
      if (sidecarCount !== 0) return "回退阶段 " + doc.phase + " 不得含 sidecar step";
    }
  }
  // M1b T4 ② + 返修 P1-1/P1-2/P1-3：1.3 cutover 的进段原子合同与 4f、plan_sha256 合同、token 私有目录段级核。
  if (is13 && doc.operation_kind === "ledger_cutover") {
    const sidecars = doc.steps.filter((s) => s.kind === "sidecar");
    const names = sidecars.map((s) => s.id.slice("sidecar:".length).split(":")[0]).sort().join(",");
    // P1-1（maintenance-gate.md 阶段表）+ 二轮 P1-2：进入 ledger_cutting_over 起恰三条（≤drained 零条已在上分支核）；
    // 零条只合法于 drained 及更早；forward-only 后所有阶段（cutting_over/reopening/reopening_incomplete/done）一律恰三。
    if (doc.phase === "ledger_cutting_over" || doc.phase === "ledger_reopening" || doc.phase === "reopening_incomplete" || doc.phase === "done") {
      if (sidecars.length !== 3) return "进入 ledger_cutting_over 起必须恰三条 sidecar step，现在是 " + sidecars.length;
      if (names !== "expiry,pending-claims,policy") return "sidecar 三元组不全或重复：" + names;
    }
    const ls = doc.steps.find((s) => s.kind === "ledger");
    if (sidecars.length === 3) {
      const lsEp = typeof ls?.id === "string" ? ls.id.split(":")[1] : null;
      for (const s of sidecars) if (s.id.split(":")[2] !== lsEp) return "4f：sidecar 的 endpoint 与 ledger step 不一致";
      if (doc.phase === "ledger_cutting_over" && ls?.state === "done" && sidecars.some((s) => s.state !== "done")) return "ledger step 已 done 而 sidecar 未全 done";
    }
    if (ls) {
      // P1-2b（maintenance-gate.md B-2 表）：plan_sha256 属三个状态对象；cutover 合同形状 =
      // before.plan_sha256 === null（无计划锚），intended_after/after（非 null 时）= 受验 plan 原始字节 SHA。
      for (const k of ["before", "intended_after", "after"]) {
        const st = ls[k];
        if (st === null || st === undefined) continue;
        if (!("plan_sha256" in st)) return "1.3 cutover 的 " + k + " 缺 plan_sha256 字段";
      }
      if (ls.before?.plan_sha256 !== null) return "1.3 cutover 的 before.plan_sha256 必须是 null（B-2 合同）";
      if (!(typeof ls.intended_after?.plan_sha256 === "string" && SHA_SHAPE.test(ls.intended_after.plan_sha256))) return "1.3 cutover 的 intended_after.plan_sha256 必须是受验 plan 字节 SHA";
      if (ls.after !== null && ls.after !== undefined
        && (!(typeof ls.after.plan_sha256 === "string" && SHA_SHAPE.test(ls.after.plan_sha256)) || ls.after.plan_sha256 !== ls.intended_after.plan_sha256)) return "1.3 cutover 的 after.plan_sha256 必须与 intended_after 同 plan SHA";
    }
    for (const s of sidecars) {
      // P1-3：段级核替代 endsWith —— 规范绝对路径（normalize 恒等、无点段），按段精确匹配 <token>.staged / intended / <name>.json；
      // 调用方给了维护目录时再强核前缀（外指树拒）。
      const name = s.id.slice("sidecar:".length).split(":")[0];
      const pathProblem = stagedBlobPathProblem(s.intended_blob.path, doc.token, name, maintenanceDir);
      if (pathProblem !== null) return "sidecar.intended_blob.path " + pathProblem;
      if (s.backup !== null) {
        const d = path.dirname(s.backup);
        if (typeof d !== "string" || !d.startsWith("/") || path.normalize(d) !== d) return "sidecar.backup 不是规范绝对路径";
        const segs = d.slice(1).split("/");
        if (segs.length < 1 || segs[segs.length - 1] !== doc.token + ".staged") return "sidecar.backup 必须在 <token>.staged 下";
        if (maintenanceDir !== undefined) {
          const prefixProblem = maintenanceDirSegments(maintenanceDir);
          if (prefixProblem !== null) return "sidecar.backup 的维护目录" + prefixProblem;
          const base = maintenanceDir.slice(1).split("/").filter((x) => x !== "");
          if (segs.length !== base.length + 1) return "sidecar.backup 不在维护目录树下";
          for (let i = 0; i < base.length; i++) if (segs[i] !== base[i]) return "sidecar.backup 不在维护目录树下";
        }
      }
    }
  }
  if (!Array.isArray(doc.notes) || doc.notes.some((n) => typeof n !== "string")) return "notes 不是字符串数组";
  return null;
}

/**
 * 1.2 未终结 ledger_cutover 的处置判别（M1b T4 ①，m1a-reconciliation.md §4.1）。
 * 非 1.2 cutover（含 1.3 与非账本种）→ null；已终结（done/rolled_back）→ receipt；
 * FORWARD_ONLY 非终态（含已提交）→ fail_closed（人工处置，不按 1.3 续跑）；其余（≤drained + 回退矩阵）→ safe_rollback。
 */
export function legacy12CutoverDisposition(doc) {
  if (doc?.schema_version !== JOURNAL_SCHEMA || doc?.operation_kind !== "ledger_cutover") return null;
  if (TERMINAL_PHASES.includes(doc.phase)) return { disposition: "receipt" };
  if (FORWARD_ONLY_PHASES.includes(doc.phase)) return { disposition: "fail_closed" };
  return { disposition: "safe_rollback" };
}

// ── 读 ───────────────────────────────────────────────────────────────────────
/** active 三态：只有 ENOENT 是 absent；不是 symlink / 目标不是 UUID → unreadable。 */
export function readActive({ dir } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { state: "unreadable", why: "维护目录说不清（真实用户 home 取不到）" };
  const file = activePath(dir);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: "lstat 失败：" + errCode(err) }; }
  if (!st.isSymbolicLink()) return { state: "unreadable", why: "active 位置上不是 symlink" };
  let token;
  try { token = fs.readlinkSync(file); } catch (err) { return { state: "unreadable", why: "readlink 失败：" + errCode(err) }; }
  if (!UUID_SHAPE.test(token)) return { state: "unreadable", why: "active 指向的不是 token" };
  return { state: "active", token };
}
/** journal 三态（fd 绑定读）。 */
export function readJournal({ dir, token } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { state: "unreadable", why: "维护目录说不清" };
  if (typeof token !== "string" || !UUID_SHAPE.test(token)) return { state: "unreadable", why: "token 形状不对" };
  const r = readRegularFile(journalPath(dir, token));
  if (r.status === "absent") return { state: "absent" };
  if (r.status !== "read") return { state: "unreadable", why: r.why };
  let doc;
  try { doc = JSON.parse(r.buf.toString("utf-8")); } catch (err) { return { state: "unreadable", why: "不是 JSON：" + errCode(err) }; }
  // R47 返修 P1-1：token 绑定下沉到唯一读入口 —— 文档内 token 必须与参数（文件名/active 指向）一致，
  // audit / active / plist 三个消费面统一被护，不再可能凭文件名把 B 的 journal 认成 A 的
  const problem = journalProblem(doc, { maintenanceDir: dir });
  if (problem !== null) return { state: "unreadable", why: "形状不对：" + problem };
  if (doc.token !== token) return { state: "unreadable", why: "token 与文件名/参数不符（文档内 " + String(doc.token).slice(0, 8) + " ≠ " + String(token).slice(0, 8) + "）" };
  return { state: "valid", doc };
}

// ── 写 ───────────────────────────────────────────────────────────────────────
/** 目录 fsync 只有"文件系统不支持"才能忽略（EINVAL / ENOTSUP / EOPNOTSUPP）；EIO 之类必须失败。 */
export const dirFsyncIgnorable = (code) => code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
/** 原子 + 持久写：tmp（O_EXCL | O_NOFOLLOW）写满 → fsync → rename → fsync 目录。抛错交调用方。 */
export function writeDurable(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, ".journal." + process.pid + "." + crypto.randomUUID() + ".tmp");
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } catch (err) { try { fs.closeSync(fd); } catch { /* 已关 */ } try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, file); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } throw err; }
  let dfd = null;
  try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
  catch (err) { if (!dirFsyncIgnorable(err?.code)) throw err; }
  finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
}
/** 写备份：写满 fsync，返回 { sha256, bytes }；恢复前用 verifyBackup 核。 */
export function writeBackup(file, bytes) {
  writeDurable(file, bytes);
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
export function verifyBackup({ file, sha256, bytes }) {
  const r = readRegularFile(file);
  if (r.status !== "read") return { ok: false, why: r.status === "absent" ? "备份不在" : r.why };
  if (r.buf.length !== bytes) return { ok: false, why: "备份长度不对（" + r.buf.length + " ≠ " + bytes + "）" };
  const actual = crypto.createHash("sha256").update(r.buf).digest("hex");
  return actual === sha256 ? { ok: true, buf: r.buf } : { ok: false, why: "备份 sha256 不对" };
}

// ── 执行租约 ─────────────────────────────────────────────────────────────────
/**
 * 拿这个 operation 的执行租约：registry 锁协议，staleMs = ∞（只按持有者 pid 活性接管，等进程可以很久），未知形状不回收。
 * 拿不到 → { ok:false, reason:"operation_in_progress"（活着的执行者）| "lease_residue" | ... }。
 */
export function acquireOperationLease({ dir, token }) {
  const file = leasePath(dir, token);
  let r;
  try { r = acquireLockUngated(file, { staleMs: Number.POSITIVE_INFINITY, reapUnrecognized: false }); }
  catch (err) { return { ok: false, reason: "io_error", why: "租约原语抛错：" + errCode(err), path: file }; }
  if (r.ok) return { ok: true, path: file, token: r.token };
  if (r.reason === "publisher_busy" || r.reason === "reap_busy") return { ok: false, reason: "operation_in_progress", path: file, why: "另一个执行者正持有这个 operation 的租约" };
  return { ok: false, reason: r.reason === "lock_residue" || r.reason === "reap_residue" || r.reason === "reap_uncleared" || r.reason === "reaped_uncleared" ? "lease_residue" : "io_error", path: r.path ?? file, why: String(r.reason) + (r.error ? "：" + r.error : "") };
}
export function releaseOperationLease(lease) {
  if (!lease?.path) return { ok: false, who: "absent", why: "releaseOperationLease 没有 lease.path" };
  try {
    const r = releasePublishLock(lease.path);
    // 归属转换锁 .reap 交不还：主租约可能已删，但 .reap 残骸会让后续续跑一律 reap_residue —— 不是成功，点名真实路径
    if (r.reapUncleared) return { ok: false, why: "reap_uncleared：" + String(r.reapUncleared.error ?? ""), path: r.reapUncleared.path };
    // P1-8：释放是归属转换。租约已被接管（not_owner）或干脆不在（absent）都不是成功——调用方必须把残留带进结果。
    if (r.reason === "not_owner") return { ok: false, who: "not_owner", why: "租约已不属于本执行者（被接管）", path: lease.path };
    if (r.absent) return { ok: false, who: "absent", why: "租约不在（已被接管或从未存在）", path: lease.path };
    return r.ok ? { ok: true } : { ok: false, why: String(r.reason), path: lease.path };
  } catch (err) { return { ok: false, why: "release_threw：" + errCode(err), path: lease.path }; }
}

/**
 * 开一次 operation：先拿租约 → journal（planned）落盘 → O_EXCL 建 active。active 在 / 读不出 → 拒绝；两个人同时开只有一个赢。
 * 返回 { ok, token, lease, doc }；调用方持有 lease 到 enter 结束，最后 releaseOperationLease。
 */
export function createOperation({ dir, reason, operationKind = "maintenance_gate", token = crypto.randomUUID(), now = Date.now() } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return { ok: false, reason: "maintenance_dir_unknown", why: "真实用户 home 取不到" };
  if (!OPERATION_KINDS.includes(operationKind)) return { ok: false, reason: "bad_operation_kind", why: String(operationKind) };
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) { return { ok: false, reason: "io_error", why: errCode(err) }; }
  const active = readActive({ dir });
  if (active.state === "active") return { ok: false, reason: "operation_active", token: active.token };
  if (active.state === "unreadable") return { ok: false, reason: "active_unreadable", why: active.why, path: activePath(dir) };
  const lease = acquireOperationLease({ dir, token });
  if (!lease.ok) return { ok: false, reason: lease.reason, why: lease.why, path: lease.path };
  const at = new Date(now).toISOString();
  // M1b T4 ①：cutover operation 从 1.3 起记账（sidecar step + plan_sha256）；其余种照旧 1.2。
  const doc = { schema_version: operationKind === "ledger_cutover" ? CUTOVER_JOURNAL_SCHEMA : JOURNAL_SCHEMA, operation_kind: operationKind, token, reason, started_at: at, updated_at: at, phase: "planned", steps: [], notes: [] };
  const problem = journalProblem(doc, { maintenanceDir: dir });
  if (problem !== null) { releaseOperationLease(lease); return { ok: false, reason: "journal_shape", why: problem }; }
  try { writeDurable(journalPath(dir, token), JSON.stringify(doc, null, 2) + "\n"); } catch (err) { releaseOperationLease(lease); return { ok: false, reason: "io_error", why: "写 journal：" + errCode(err) }; }
  try { fs.symlinkSync(token, activePath(dir)); }
  catch (err) {
    releaseOperationLease(lease);
    if (err?.code === "EEXIST") { const again = readActive({ dir }); return { ok: false, reason: "operation_active", token: again.token ?? null, why: again.why }; }
    return { ok: false, reason: "io_error", why: "建 active：" + errCode(err) };
  }
  return { ok: true, token, lease, doc };
}

/**
 * 读 → 核 active 仍是本 token → 核阶段前驱（expectPhase）→ mutate（拿到深拷贝）→ 验形状 → 在租约 reap 段内核对 token 后原子持久写。
 * 没有租约 / 租约丢了 → 不写（lease_required / lease_lost）。
 */
export function updateJournal({ dir, token, lease, expectPhase = null, mutate, now = Date.now() } = {}) {
  if (!lease?.path) return { ok: false, reason: "lease_required" };
  // 租约必须属于**这个** operation（评审探针：拿 A 的租约改 active B 的 journal 曾返回 ok）
  if (lease.path !== leasePath(dir, token)) return { ok: false, reason: "lease_mismatch", why: "租约 " + String(lease.path) + " 不属于 operation " + String(token) };
  const active = readActive({ dir });
  if (active.state !== "active" || active.token !== token) return { ok: false, reason: "active_mismatch", why: active.state === "active" ? "active 指向别的 operation：" + active.token : "active " + active.state + (active.why ? "（" + active.why + "）" : "") };
  const r = readJournal({ dir, token });
  if (r.state !== "valid") return { ok: false, reason: r.state === "absent" ? "journal_absent" : "journal_unreadable", why: r.why };
  if (expectPhase !== null && !(Array.isArray(expectPhase) ? expectPhase : [expectPhase]).includes(r.doc.phase)) return { ok: false, reason: "phase_mismatch", why: "现在是 " + r.doc.phase + "，不是预期的 " + String(expectPhase) };
  const next = mutate(structuredClone(r.doc)) ?? null;
  if (next === null) return { ok: false, reason: "mutate_returned_nothing" };
  next.updated_at = new Date(now).toISOString();
  const problem = journalProblem(next, { maintenanceDir: dir });
  if (problem !== null) return { ok: false, reason: "journal_shape", why: problem };
  const c = commitWhileHeld(lease.path, () => { try { writeDurable(journalPath(dir, token), JSON.stringify(next, null, 2) + "\n"); return null; } catch (err) { return errCode(err); } });
  if (!c.ok) return { ok: false, reason: c.reason === "lock_lost" ? "lease_lost" : "io_error", why: "租约核对：" + String(c.reason) };
  if (c.run !== null) return { ok: false, reason: "io_error", why: c.run };
  // 写已落盘，但租约的归属转换锁交不还：之后的每次写都会 reap_residue —— 立即停，不许再做外部变更（调用方保留 active / journal，退出码 3）
  if (c.reapUncleared) return { ok: false, reason: "lease_reap_uncleared", why: String(c.reapUncleared.error ?? ""), path: c.reapUncleared.path, written: true, doc: next };
  return { ok: true, doc: next };
}

export const setPhase = ({ dir, token, lease, phase, expectPhase = null, note = null, now }) => updateJournal({ dir, token, lease, expectPhase, now, mutate: (d) => { d.phase = phase; if (note !== null) d.notes.push(note); return d; } });
export const addNote = ({ dir, token, lease, note, now }) => updateJournal({ dir, token, lease, now, mutate: (d) => { d.notes.push(note); return d; } });
/** 两阶段第一步：把 before / backup{sha256,bytes} / intended_after 落盘之后才允许做外部变更。 */
export const addStepPrepared = ({ dir, token, lease, step, now = Date.now() }) => updateJournal({ dir, token, lease, now, mutate: (d) => {
  if (d.steps.some((s) => s.id === step.id)) return null;
  d.steps.push({ id: step.id, kind: step.kind, target: step.target, before: step.before ?? null, backup: step.backup ?? null, backup_sha256: step.backup_sha256 ?? null, backup_bytes: step.backup_bytes ?? null, intended_after: step.intended_after ?? null, chain: step.chain ?? null, state: "prepared", after: null, at: new Date(now).toISOString() });
  return d;
} });
/** 两阶段第二步：记实际 after。 */
export const markStepDone = ({ dir, token, lease, id, after, now = Date.now() }) => updateJournal({ dir, token, lease, now, mutate: (d) => {
  const s = d.steps.find((x) => x.id === id);
  if (!s) return null;
  s.state = "done"; s.after = after; s.at = new Date(now).toISOString();
  return d;
} });

/** sidecar step 标准化（R45 4f：11 键，无 chain 无 after；锚来自 staging，不自述）。 */
const sidecarStepOf = (ss, now) => ({ id: ss.id, kind: "sidecar", target: ss.target, before: ss.before ?? null, backup: ss.backup ?? null, backup_sha256: ss.backup_sha256 ?? null, backup_bytes: ss.backup_bytes ?? null, intended_blob: ss.intended_blob ?? null, intended_after: ss.intended_after ?? null, state: "prepared", at: new Date(now).toISOString() });
const sidecarSame = (ex, ss) => ex.kind === "sidecar" && ex.target === ss.target
  && JSON.stringify(ex.before ?? null) === JSON.stringify(ss.before ?? null)
  && JSON.stringify(ex.intended_blob ?? null) === JSON.stringify(ss.intended_blob ?? null)
  && JSON.stringify(ex.intended_after ?? null) === JSON.stringify(ss.intended_after ?? null);

/** P1-1：把 phase 推进（forward）与 ledger step 落盘合并成**一次**原子更新。
 *  原实现是 setPhase(fwd)+addNote(chain)+addStepPrepared 三步，中间崩溃会留下 「phase=fwd 但无 ledger step / 无 chain 来源」的窗口；
 *  现在 phase 与 step（含 chain）同一写落盘，窗口消失，收敛路径（phase=fwd 且有 prepared ledger step）恒能由 step 重建链。
 *  R45（4f）：cutover 的三条 sidecar step 与 ledger step **同一 mutate 原子进段**——分开写会在「进段了但 sidecar 缺席」处留下
 *  journalProblem 必拒的中间态（cutting_over 起要求恰三条 sidecar），恢复不可达。
 */
export const enterLedgerForward = ({ dir, token, lease, phase, step, sidecarSteps = [], chain, expectPhase = "drained", now = Date.now() }) => updateJournal({ dir, token, lease, expectPhase, now, mutate: (d) => {
  const existing = d.steps.find((s) => s.id === step.id);
  if (existing) {
    // 幂等：恢复再进同一 forward 不重推（否则 journalProblem 会撞「step id 重复」）；评审 P1-4：返回前必须核**阶段 + 内容**完全一致，
    // 同 id 但 phase 未同步 / content 不同都拒（return null → mutate_returned_nothing），不许把「同 id 不同物」当成功静默返回。
    if (d.phase !== phase) return null;
    const same = existing.kind === step.kind && existing.target === step.target
      && existing.chain === (chain ?? null)
      && JSON.stringify(existing.before ?? null) === JSON.stringify(step.before ?? null)
      && JSON.stringify(existing.intended_after ?? null) === JSON.stringify(step.intended_after ?? null);
    if (!same) return null;
    for (const ss of sidecarSteps) {
      const ex = d.steps.find((s) => s.id === ss.id);
      if (!ex || !sidecarSame(ex, ss)) return null;
    }
    return d;
  }
  d.phase = phase;
  d.steps.push({ id: step.id, kind: step.kind, target: step.target, before: step.before ?? null, backup: step.backup ?? null, backup_sha256: step.backup_sha256 ?? null, backup_bytes: step.backup_bytes ?? null, intended_after: step.intended_after ?? null, chain: chain ?? null, state: "prepared", after: null, at: new Date(now).toISOString() }, ...sidecarSteps.map((ss) => sidecarStepOf(ss, now)));
  return d;
} });

/** 清 active：token-CAS。绝不清别人的；unreadable 不动。 */
export function clearActive({ dir, token } = {}) {
  const a = readActive({ dir });
  if (a.state === "absent") return { ok: true, cleared: false, reason: "absent" };
  if (a.state === "unreadable") return { ok: false, cleared: false, reason: "active_unreadable", why: a.why };
  if (a.token !== token) return { ok: false, cleared: false, reason: "not_owner", token: a.token };
  try { fs.unlinkSync(activePath(dir)); } catch (err) { return err?.code === "ENOENT" ? { ok: true, cleared: false, reason: "absent" } : { ok: false, cleared: false, reason: "io_error", why: errCode(err) }; }
  return { ok: true, cleared: true, reason: null };
}

/** 目录里的全部 journal（只按封闭名字 <uuid>.json 认）。 */
export function listJournals({ dir } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { return { ok: err?.code === "ENOENT", tokens: [], why: err?.code === "ENOENT" ? null : errCode(err) }; }
  return { ok: true, tokens: names.filter((n) => /^[0-9a-f-]{36}\.json$/u.test(n) && UUID_SHAPE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort() };
}

/**
 * 维护目录盘点（只读，给 --status / doctor）：孤立 journal（active 没指向它 —— 例如两个 enter 竞争 active 的输家）、非 active 的租约与租约锁家族残骸、
 * 写 journal 的临时文件、非 active 的 plist 备份。只报告，不清理（能证明是输家的才该按受控协议清，这里不猜）。
 *
 * 例外（M1 账本接入 B-3）：`ledger_init(done)` / `ledger_cutover(done)` 的 journal 是**合法永久收据**、不是 orphan，不染红。
 */
export function isLedgerReceipt(doc) {
  // 二轮 P2-1：1.3 done 收据与 1.2 同为合法永久收据（1.3 + 非 cutover 已被 journalProblem 判别支拦死，能走到这里的 1.3 必是 cutover）。
  return (doc?.schema_version === JOURNAL_SCHEMA || doc?.schema_version === CUTOVER_JOURNAL_SCHEMA)
    && (doc.operation_kind === "ledger_init" || doc.operation_kind === "ledger_cutover")
    && doc.phase === "done";
}
/**
 * R47 三分类（doctor ⑩）：residues 只剩真异常/说不清（block）；audits=已终结 operation 的合法审计存档；cleanables=可证明已终结的 plist 备份（可清理，不 block）。
 * 判据逐字段不看文件名：journal 必须 readJournal 认可（schema/字段集/阶段×kind 封闭）且 phase ∈ TERMINAL_PHASES 且无 active 指向 → 审计；
 * plist 备份须对上同 token 的已终结 journal 才算可清理，对不上（in-flight/读不出/缺席）保守当残骸。active 指向的 journal 缺失/坏 = 状态指针悬空，也是真异常。
 * 只报告，不清理（能证明是输家的才该按受控协议清，这里不猜）。
 */
export function inspectMaintenanceDir({ dir } = {}) {
  const residues = [], audits = [], cleanables = [];
  if (typeof dir !== "string" || dir.length === 0) return { inventory: "unknown", residues, audits, cleanables };
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return err?.code === "ENOENT" ? { inventory: "ok", residues, audits, cleanables } : { inventory: "unreadable", residues: [{ path: dir, kind: "inventory", detail: "目录读不出：" + errCode(err) }], audits, cleanables } }
  const active = readActive({ dir });
  // R47 返修 P1-2：active 指针自身读不出（指向非 token / 不是 symlink / readlink 失败）不得折成「没开 active」的干净态
  if (active.state === "unreadable") residues.push({ path: activePath(dir), kind: "active_unreadable", detail: "active 指针读不出（" + String(active.why) + "）—— 每个新 operation 都会被它挡住，只人工处置" });
  const activeToken = active.state === "active" ? active.token : null;
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    if (n === "active") continue;
    let m;
    if ((m = /^([0-9a-f-]{36})\.json$/u.exec(n)) && UUID_SHAPE.test(m[1])) {
      if (m[1] !== activeToken) {
        const j = readJournal({ dir, token: m[1] });
        if (j.state === "valid" && TERMINAL_PHASES.includes(j.doc.phase)) audits.push({ path: full, token: m[1], operation_kind: j.doc.operation_kind, phase: j.doc.phase, started_at: j.doc.started_at });
        else if (j.state === "valid") residues.push({ path: full, kind: "orphan_journal", detail: "没有 active 指向的 in-flight journal（阶段 " + j.doc.phase + "，" + j.doc.started_at + "）—— 竞争输家或中断残留，只人工处置" });
        else residues.push({ path: full, kind: "orphan_journal", detail: "没有 active 指向且读不出的 journal（" + String(j.why) + "）—— 只人工处置" });
      }
      continue;
    }
    if ((m = /^([0-9a-f-]{36})\.lease$/u.exec(n)) && UUID_SHAPE.test(m[1])) { const h = leaseHolder({ dir, token: m[1] }); if (m[1] !== activeToken) residues.push({ path: full, kind: "stale_lease", detail: "非 active operation 的租约" + (h.alive ? "（持有者 pid " + h.pid + " 仍在）" : "（持有者已不在）") + " —— 只人工处置" }); else if (h.present && !h.unreadable && !h.alive) residues.push({ path: full, kind: "dead_lease", detail: "active operation 的租约持有者 pid " + h.pid + " 已不在 —— 下一个执行者会接管" }); continue; }
    if (/^[0-9a-f-]{36}\.lease\.(reap|maint)$/u.test(n) || /^[0-9a-f-]{36}\.lease\.reaped-/u.test(n) || /^[0-9a-f-]{36}\.lease\.reap\.quarantine-/u.test(n)) { residues.push({ path: full, kind: "lease_lock_residue", detail: "租约锁家族残骸 —— node scripts/repair-publish-lock.mjs --lock " + path.join(dir, n.split(".lease")[0] + ".lease") + " 能清（.reap / 隔离），其余只人工处置" }); continue; }
    if (/^\.journal\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(n)) { residues.push({ path: full, kind: "tmp", detail: "写 journal 的临时文件残骸 —— 人工删即可" }); continue; }
    if ((m = /^([0-9a-f-]{36})\.(claude|codex)\.plist$/u.exec(n)) && UUID_SHAPE.test(m[1])) {
      if (m[1] !== activeToken) {
        // R47 返修 P1-3：可清理必须逐字段核 backup 关联，任一不符就不当可清理、按未知残骸标问题：
        // ① journal token 与文件名一致（readJournal 已绑定下沉）；② journal 里有对应 timer:<chain> step；
        // ③ step.backup 精确等于本文件；④ 文件是受验普通文件（readRegularFile 拒 symlink、核单硬链接）且 SHA/长度与 step 记录一致
        const j = readJournal({ dir, token: m[1] });
        if (j.state === "valid" && TERMINAL_PHASES.includes(j.doc.phase)) {
          // R47 返修 P1-3：已终结 journal 还须逐字段核 backup 关联，任一不符就不当可清理、按未知残骸标问题：
          // ② journal 里有对应 timer:<chain> step；③ step.backup 精确等于本文件；
          // ④ 文件是受验普通文件（readRegularFile 拒 symlink、核单硬链接）且 SHA/长度与 step 记录一致。
          // ① journal token 与文件名一致由 readJournal 的 token 绑定下沉护住（不符 → 走下面的 valid=false 支）。
          const chain = m[2];
          const timer = j.doc.steps.find((s) => s.kind === "timer" && s.id === "timer:" + chain) ?? null;
          const v = timer ? verifyBackup({ file: full, sha256: timer.backup_sha256, bytes: timer.backup_bytes }) : null;
          if (timer && timer.backup === full && v?.ok === true) cleanables.push({ path: full, kind: "stale_backup", token: m[1], detail: "已终结 operation（" + j.doc.operation_kind + "/" + j.doc.phase + "）的 plist 定时器备份（受验对上 timer:" + chain + "）—— 可清理（人工删即可）" });
          else {
            const why = !timer ? "journal 里没有 timer:" + chain + " step"
              : timer.backup !== full ? "timer step 的 backup 不是本文件（" + String(timer.backup).slice(0, 64) + "）"
              : "备份字节受验不过（" + String(v?.why) + "）";
            residues.push({ path: full, kind: "unknown", detail: "plist 备份对不上 backup 关联（" + why + "）—— 只人工处置" });
          }
        } else residues.push({ path: full, kind: "stale_backup", detail: "非 active operation 的 plist 备份，对账不上已终结 operation（" + (j.state === "valid" ? "阶段 " + j.doc.phase : String(j.why)) + "）—— 只人工处置" });
      }
      continue;
    }
    if ((m = /^([0-9a-f-]{36})\.staged$/u.exec(n)) && UUID_SHAPE.test(m[1])) { if (m[1] !== activeToken) residues.push({ path: full, kind: "stale_staged", detail: "非 active operation 的 staged 目录（目标制品与备份）—— 只人工处置" }); continue; }
    residues.push({ path: full, kind: "unknown", detail: "维护目录里不认识的文件 —— 只人工处置" });
  }
  // R47 返修 P1-2：active 指向的 journal 三态分别处理 —— 缺失/读不出=指针悬空；已终结（终态先落、指针未清）
  // = 也是异常，指路维护门 --exit --apply（与状态页同款）；在跑（非终态）才是正常
  if (activeToken !== null) {
    const j = readJournal({ dir, token: activeToken });
    if (j.state !== "valid") residues.push({ path: journalPath(dir, activeToken), kind: "active_journal_missing", detail: "active 指向的 journal 缺失或读不出（" + String(j.why ?? "缺席") + "）—— 状态指针悬空，只人工处置" });
    else if (TERMINAL_PHASES.includes(j.doc.phase)) residues.push({ path: activePath(dir), kind: "terminal_active_not_cleared", detail: "operation 已终结（" + j.doc.operation_kind + "/" + j.doc.phase + "）而 active 仍指向它 —— 跑 node scripts/maintenance-gate.mjs --exit --apply 只清 active" });
  }
  return { inventory: "ok", residues, audits, cleanables };
}

/** 租约持有者（只读，给 --status）：{ present, pid, alive } */
export function leaseHolder({ dir, token }) {
  const file = leasePath(dir, token);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { return err?.code === "ENOENT" ? { present: false } : { present: true, unreadable: true, why: errCode(err) }; }
  if (!st.isSymbolicLink()) return { present: true, unreadable: true, why: "不是 symlink" };
  let owner = null;
  try { owner = JSON.parse(fs.readlinkSync(file)); } catch { owner = null; }
  if (!owner || !Number.isSafeInteger(owner.pid)) return { present: true, unreadable: true, why: "payload 畸形" };
  let alive = true;
  try { process.kill(owner.pid, 0); } catch { alive = false; }
  return { present: true, pid: owner.pid, alive, at: owner.at ?? null };
}
