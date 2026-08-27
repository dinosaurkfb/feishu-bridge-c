/**
 * FR-2.5 订阅同步的落盘控制面：resnapshot / suspend / migrate 三种动作都在这里落。
 *
 * ■ suspend（评审定案的形状）
 *   目标快照 = 沿用现有快照内容、新 revision、status=paused、受控 reason
 *   （subscription_paused 照抄；订阅撤销 / 不再覆盖 → subscription_revoked）；
 *   **同一个 operation、同一份恢复清单**里还有第二笔：经注入的 bindingControl 端口把该
 *   binding 的控制状态翻成 paused（同一个 reason）。两笔各自过 CAS（快照四字段；控制状态
 *   必须还是 active），任一笔前置不成立整批零写入；中途失败按 prepared/committed 恢复 ——
 *   不许出现"快照说 paused、控制状态还是 active"或反过来的半成品被记成成功。
 * ■ migrate
 *   目标订阅**在锁内从 world.others 重读**并重新物化（计划条目只带 id），目标订阅版本进
 *   expect（to_subscription_version）与指纹：预览之后目标变了 → plan_stale。
 * ■ 写入口（CLI）仍未开放 —— FR-2.6 多订阅歧义拒绝未经真实样本验证是另一条前置。
 *
 * 计划器（subscription-sync.mjs）只算不写。这里负责写，而写是有损的 ——
 * 所以整段设计都围着一个问题：**怎么保证写下去的东西，还是当初算出来的那份。**
 *
 * ■ 两层防护，缺一不可
 *
 * 评审的判断是不要在"锁内重算"和"CAS"之间二选一，两层都做：
 *
 *   第一层，锁内重算。取订阅控制域的锁，锁内重读订阅、正式授权快照、相关 binding
 *   和显式迁移目标，用**同一个** planSubscriptionSync() 重新规划、重新物化目标，
 *   再比规范化的
 *   plan_id。不一致就 plan_stale、**零写入**，并把新算出来的计划给人看。
 *
 *   第二层，逐条 CAS。真正写之前，再核对每一条计划里的 expect 四个字段
 *   （subscription_id / subscription_version / authorization_revision / snapshot_id）。
 *   锁内重算已经挡住了绝大多数漂移，但**锁只在本机有效**，而快照文件可能被别的
 *   路径改写；第二层是对"锁之外还有人动过"的兜底。
 *
 * 为什么不能只做其中一层：只做 CAS 会让"整体计划已经变了、但某几条恰好没变"的
 * 情况通过 —— 那样落下去的是一份**残缺的**计划。只做锁内重算则默认了
 * "锁期间没人绕过锁"，而那是个假设，不是保证。
 *
 * ■ 先构造再写
 *
 * 全部写集先构造好、验证完，再动第一个文件。中途失败不许宣称整体成功 ——
 * 这条是硬要求：一份"一半新一半旧"的授权状态，比没同步更难排查。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import {
  BINDING_AUTHORIZATION_REASON, BINDING_AUTHORIZATION_STATUS, PAUSED_REASONS,
  materializeDialogueBindingAuthorization, materializeSuspendedAuthorization,
  validateDialogueBindingAuthorizationSnapshot,
} from "./dialogue-binding-authorization.mjs";
import { SYNC_ACTION, planSubscriptionSync } from "./subscription-sync.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";

/**
 * 计划指纹。**只含影响写什么的字段**，顺序无关。
 *
 * 这份摘要要能回答一个问题：锁内重算出来的，跟当初给人看的是不是同一份。
 * 所以 binding 顺序不能影响它（重读的顺序本来就可能不同），
 * 但动作、目标、以及每条的 expect 前置条件都必须进去 ——
 * 少放一样，就会出现"指纹相同但写的东西不同"。
 *
 * 本地定义 digest：这个前缀只有本模块算、也只有本模块比，
 * 不存在两处算法分叉的风险。
 */
const digest = (prefix, parts) => prefix + crypto.createHash("sha256")
  .update(parts.join("\0")).digest("hex").slice(0, 24);

/** 参与指纹的规范形状。**plan 和恢复清单必须用同一个** —— 两处各算一份，
 *  就会出现"清单自报的 plan_id 跟它自己的内容对不上却没人发现"。 */
const canonicalItem = (it) => ({
  binding_ref: it.binding_ref ?? null,
  action: it.action ?? null,
  to: it.to ?? null,
  target_snapshot_id: it.target_snapshot_id ?? null,
  // suspend 那一笔 binding 控制状态也进指纹：写什么（paused + reason）、以什么为前置（当前状态）。
  control: it.control
    ? { expect_status: it.control.expect?.status ?? null,
        target_status: it.control.target?.status ?? null, target_reason: it.control.target?.reason ?? null }
    : null,
  expect: {
    subscription_id: it.expect?.subscription_id ?? null,
    subscription_version: it.expect?.subscription_version ?? null,
    authorization_revision: it.expect?.authorization_revision ?? null,
    snapshot_id: it.expect?.snapshot_id ?? null,
    to_subscription_version: it.expect?.to_subscription_version ?? null,
  },
});

/** 导出是为了让测试能造出**改了内容还把指纹一起改对**的清单 ——
 *  只有那种对手才能分别验证每一条结构校验。 */
export function fingerprintOf(noop, items) {
  const entries = items.map(canonicalItem)
    .sort((a, b) => String(a.binding_ref).localeCompare(String(b.binding_ref)));
  if (entries.some((e) => e.target_snapshot_id === null)) return null;
  return digest("sync_plan_", [
    "subscription-sync-plan/v3", JSON.stringify({ noop: noop === true, entries }),
  ]);
}

export function planId(plan, writes = null) {
  if (!plan || plan.ok !== true) return null;
  // **指纹必须覆盖"将要写什么"，不只是"打算做什么"。**
  // 上一版只放了动作、目标订阅 id 和旧快照前置条件 ——
  // 两份内容不同的新授权可以算出同一个指纹，那样"计划没变"就成了假话。
  if (writes === null) return null;
  const byRef = new Map(writes.map((w) => [w.entry.bindingRef, w]));
  return fingerprintOf(plan.noop, (plan.plans ?? []).map((p) => ({
    binding_ref: p.bindingRef ?? null,
    action: p.action ?? null,
    to: p.toSubscriptionId ?? null,
    target_snapshot_id: byRef.get(p.bindingRef)?.target?.snapshot_id ?? null,
    control: byRef.get(p.bindingRef)?.control ?? null,
    expect: { ...expectOf(p), to_subscription_version: byRef.get(p.bindingRef)?.toSubscriptionVersion ?? null },
  })));
}

export const APPLY_REJECT = Object.freeze({
  PLAN_STALE: "plan_stale",
  EXPECT_MISMATCH: "expect_mismatch",
  SNAPSHOT_MISSING: "snapshot_missing",
  INPUT_INVALID: "input_invalid",
  LOCK_BUSY: "control_plane_busy",
  OPERATION_IN_FLIGHT: "another_operation_unfinished",
  JOURNAL_UNREADABLE: "journal_unreadable",
  UNSUPPORTED_ACTION: "unsupported_action",
  PARTIAL_WRITE: "partial_write",
  OPERATION_REUSED: "operation_id_reused_for_other_plan",
  WORLD_UNREADABLE: "world_unreadable",
  JOURNAL_WRITE_FAILED: "journal_write_failed",
  ALREADY_SUSPENDED: "already_suspended",
  BINDING_CONTROL_PORT_MISSING: "binding_control_port_missing",
  BINDING_CONTROL_UNREADABLE: "binding_control_unreadable",
  MIGRATION_TARGET_MISSING: "migration_target_missing",
});

/**
 * 第二道 CAS：这条计划依据的那份快照，现在还是不是当初那一份。
 *
 * 四个字段都要比。只比 snapshot_id 看着够（它是内容摘要），但**摘要相同不等于
 * 这条计划仍然适用** —— 订阅版本换了、授权 revision 涨了，都意味着中间发生过
 * 别的事，而这份计划是照着旧世界算的。
 */
/**
 * 计划条目里的 expect（驼峰）→ 落盘记录里的形状（下划线）。
 *
 * **只有一处做这个转换。**两边各写一份的代价我刚付过：恢复清单存下划线、
 * 比较函数读驼峰，于是每一项都比成"对不上" —— 而它看起来像是真的漂移了。
 */
export const expectOf = (entry) => ({
  subscription_id: entry?.expect?.subscriptionId ?? entry?.expect?.subscription_id,
  subscription_version: entry?.expect?.subscriptionVersion ?? entry?.expect?.subscription_version,
  authorization_revision:
    entry?.expect?.authorizationRevision ?? entry?.expect?.authorization_revision,
  snapshot_id: entry?.expect?.snapshotId ?? entry?.expect?.snapshot_id,
});

export function verifyExpect(entry, current) {
  if (!current) return { ok: false, reason: APPLY_REJECT.SNAPSHOT_MISSING, field: null };
  const want = expectOf(entry);
  const pairs = [
    ["subscription_id", want.subscription_id, current.subscription_id],
    ["subscription_version", want.subscription_version, current.subscription_version],
    ["authorization_revision", want.authorization_revision, current.authorization_revision],
    ["snapshot_id", want.snapshot_id, current.snapshot_id],
  ];
  for (const [field, want, got] of pairs) {
    if (want === undefined || want === null || want !== got) {
      return { ok: false, reason: APPLY_REJECT.EXPECT_MISMATCH, field, want: want ?? null, got: got ?? null };
    }
  }
  return { ok: true };
}

// ── 落盘 ──────────────────────────────────────────────────────────────────

const readJson = (file) => {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf-8")) }; }
  catch (err) {
    return err.code === "ENOENT"
      ? { ok: true, value: null }
      : { ok: false, reason: "read_failed", error: String(err.message).slice(0, 200) };
  }
};

const atomicWriteJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid + "." + Date.now() + "." +
    crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 已完成或写入前失败 */ }
  }
};

/** binding_ref 的形状。跟 dialogue-binding-authorization 里那份一致 ——
 *  它没导出，这里重述一次并有测试钉住两边不许分叉。 */
const BINDING_REF = /^binding_ref_[0-9a-f]{24}$/u;

/**
 * 快照文件路径。**不合规的 ref 直接抛，不拼路径。**
 *
 * 防的是路径穿越：一份被改过的恢复清单里写 `../../x`，拼出来就落到
 * authorizations/ 之外了。校验那一层当然也拦，但**拼路径这个动作本身
 * 就不该接受任何没验过的输入** —— 少一层依赖顺序上的假设。
 */
const snapshotFile = (shadowDir, bindingRef) => {
  if (!BINDING_REF.test(bindingRef ?? "")) {
    throw new Error("binding_ref 不合规，拒绝拼路径：" + String(bindingRef).slice(0, 60));
  }
  return path.join(shadowDir, "authorizations", bindingRef + ".json");
};
const journalFile = (shadowDir, operationId) =>
  path.join(shadowDir, "sync-operations", operationId + ".json");

export const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/u;
export const JOURNAL_STATUS = Object.freeze({ PREPARED: "prepared", COMMITTED: "committed" });

/**
 * 一次落盘的可恢复记录。
 *
 * 为什么要它：写集有多条，而进程可能死在任意一条之后。没有记录的话，
 * 重来一次要么重复执行、要么无从判断做到哪儿了 —— 两种都比不做更糟。
 *
 * prepared 先写、committed 后写：中间崩掉时记录停在 prepared，
 * **那本身就是"没做完"的证据**，而不是靠猜。
 */
export const JOURNAL_SCHEMA = "subscription-sync-operation/v3";

/**
 * **键集合必须恰好相等**，不是"没有多余的"。
 *
 * 上一版用的是"只禁止未知字段"，而**不要求允许的字段必须存在** ——
 * 最直接的绕过是删掉 `to`：`undefined` 被放行，而指纹又把"缺失"和 null 算成一样，
 * 于是攻击者**连指纹都不用重算**。恢复清单是写入授权的依据，
 * 这种宽容正是它最不该有的。
 */
const exactKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o)
  && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** suspend 落到快照上的 reason：计划器的 subscription_paused 照抄；revoked / no_longer_covered 都是"授权被收回"。 */
const SUSPEND_REASONS = Object.freeze([
  BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_PAUSED, BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_REVOKED,
]);
const snapshotReasonFor = (planReason) => planReason === "subscription_paused"
  ? BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_PAUSED : BINDING_AUTHORIZATION_REASON.SUBSCRIPTION_REVOKED;

/**
 * binding 控制状态那一笔的封闭形状：expect.status 是锁内读到的当前状态（只接受 active —— 已经不是 active
 * 的 binding 说不清是谁、为什么暂停的，不替它决定），target 是 paused + 与快照同一个 reason。
 */
export const BINDING_CONTROL_STATUS = Object.freeze({ ACTIVE: "active", PAUSED: "paused" });
const validControl = (c) => exactKeys(c, ["expect", "target"])
  && exactKeys(c.expect, ["status"]) && c.expect.status === BINDING_CONTROL_STATUS.ACTIVE
  && exactKeys(c.target, ["status", "reason"]) && c.target.status === BINDING_CONTROL_STATUS.PAUSED
  && PAUSED_REASONS.includes(c.target.reason);

/**
 * 恢复清单里的时间必须是**规范时间**，不是"Date.parse 认得的东西"。
 *
 * Date.parse 认 `Aug 25 2026`、`8/25/2026`、`2026/08/25`、`2026-08-25`……
 * 于是一份清单可以带着任意形状的时间通过校验，而清单是**崩溃之后唯一的依据**：
 * 它说 prepared 在什么时候、committed 在什么时候，重试要照着它走。
 * 时间格式不统一，两份清单就没法比较，也没法判断谁更新。
 *
 * 全仓已经有一份规范判据（canonical-time.mjs），这里跟它对齐 ——
 * 又一处"同一个概念两处各写一份"，只是这处一直没人碰。
 */
const isIsoTime = (v) => isCanonicalIso(v);

/**
 * 恢复清单必须**自己可信**。
 *
 * 上一版只验了顶层几个字段和"writes 是数组" —— 于是一份被改过的 prepared 记录
 * 可以让恢复路径：拼出 authorizations/ 之外的路径、缺 target 时抛异常、
 * 写进一份非法快照、两项写同一个文件，**或者改了 target 却保持旧 plan_id**。
 *
 * 最后那条是关键：只信清单自报的 plan_id，等于把"写什么"的决定权交给了那个文件。
 * 所以这里从清单**重算指纹**再跟它自报的对 —— 对不上就是被动过。
 *
 * schema 升到 v2：把"日志"改成"恢复清单"是不兼容的形状变化，
 * 不能让旧文件在新语义下被当成有效清单。
 */
function validateJournal(j, { operationId = null } = {}) {
  if (!exactKeys(j, ["schema_version", "operation_id", "plan_id", "noop",
    "status", "prepared_at", "committed_at", "writes"])) return false;
  if (j.schema_version !== JOURNAL_SCHEMA) return false;
  if (!OPERATION_ID.test(j.operation_id ?? "")) return false;
  // 文件名跟里面记的 operation 必须一致 —— 否则挪个文件名就能冒充另一笔事务。
  if (operationId !== null && j.operation_id !== operationId) return false;
  if (typeof j.plan_id !== "string" || j.plan_id.length === 0) return false;
  if (typeof j.noop !== "boolean") return false;
  if (!Object.values(JOURNAL_STATUS).includes(j.status)) return false;
  if (!Array.isArray(j.writes)) return false;
  // 状态和时间要自洽。prepared 却带着提交时间、committed 却没有 ——
  // 那样的记录说不清事务到底走到哪一步，而恢复正是靠它判断。
  if (!isIsoTime(j.prepared_at)) return false;
  if (j.status === JOURNAL_STATUS.PREPARED && j.committed_at !== null) return false;
  if (j.status === JOURNAL_STATUS.COMMITTED && !isIsoTime(j.committed_at)) return false;
  // **noop 与条目数是恒等关系，不是单向的。**上一版只拒绝
  // "noop=true 却带着待写项"，却接受"noop=false 却一条都没有" ——
  // 后者同样说不清：既然什么都不写，为什么不是 noop。
  if (j.noop !== (j.writes.length === 0)) return false;

  const seen = new Set();
  for (const w of j.writes) {
    // v3：多一笔 control（suspend 时 binding 控制状态），键集合仍恰好相等。
    if (!exactKeys(w, ["binding_ref", "action", "to", "expect", "target", "control"])) return false;
    // 这一条是**冗余的**：下面 target 必须是合法快照（那里卡了 ref 形状），
    // 且 target.binding_ref === binding_ref，两条合起来已经堵死。
    // 单独去掉它变异不会变红 —— 留着是多一层，不是承重的那一层。承重的是
    // snapshotFile 里那个 throw（去掉它变异立刻红）。
    if (!BINDING_REF.test(w.binding_ref ?? "")) return false;
    if (seen.has(w.binding_ref)) return false;          // 两项写同一个文件
    seen.add(w.binding_ref);
    // **清单只许执行这个落盘器真的实现了的动作。**
    // action 进了指纹，所以改动作指纹会变 —— 但会重算指纹的对手不受这个约束：
    // 写 action:"bogus" 再重算一个匹配的 plan_id，清单就通过了，
    // 然后恢复过程照样把 target 写下去。指纹管的是"有没有被改过"，
    // **管不了"改成的东西合不合法"**。
    if (!Object.values(SYNC_ACTION).includes(w.action)) return false;
    if (!exactKeys(w.expect, ["subscription_id", "subscription_version",
      "authorization_revision", "snapshot_id", "to_subscription_version"])) return false;
    if (typeof w.expect.subscription_id !== "string" || w.expect.subscription_id.length === 0) return false;
    if (typeof w.expect.snapshot_id !== "string" || w.expect.snapshot_id.length === 0) return false;
    if (!Number.isInteger(w.expect.subscription_version) || w.expect.subscription_version <= 0) return false;
    if (!Number.isInteger(w.expect.authorization_revision) ||
        w.expect.authorization_revision <= 0) return false;
    if (!validateDialogueBindingAuthorizationSnapshot(w.target).ok) return false;
    // 目标快照必须就是这一项要写的那个文件的内容。
    if (w.target.binding_ref !== w.binding_ref) return false;
    // **授权 revision 必须严格 +1，不是"往前走就行"。**
    // 正式 materializer 的合法演进就是 +1；写 `>` 的话，可以造一份 revision
    // 从 4 跳到 6 的合法快照，重算 snapshot_id、指纹和 plan_id 之后照样通过 ——
    // **而那不是这个计划能产生的写入。**"往前走"和"就是下一版"是两件事。
    if (w.target.authorization_revision !== w.expect.authorization_revision + 1) return false;
    // **按动作封闭**：每种动作允许的 to / control / 目标订阅 / 状态 各不相同，一样都不许串。
    if (w.action === SYNC_ACTION.RESNAPSHOT) {
      // resnapshot 不许换订阅（上一版曾留下"以 resnapshot 之名做隐式迁移"的后门）；不带 control。
      if (w.to !== null || w.control !== null || w.expect.to_subscription_version !== null) return false;
      if (w.target.subscription_id !== w.expect.subscription_id) return false;
      if (w.target.subscription_version < w.expect.subscription_version) return false;
    } else if (w.action === SYNC_ACTION.SUSPEND) {
      // suspend：同一条订阅、状态翻成 paused、reason 受控；**必须带 control 那一笔**（评审定案：
      // 同一 operation 内同步暂停 binding 控制状态），且 control 形状封闭。
      if (w.to !== null || w.expect.to_subscription_version !== null) return false;
      if (w.target.subscription_id !== w.expect.subscription_id) return false;
      if (w.target.status !== BINDING_AUTHORIZATION_STATUS.PAUSED) return false;
      if (!SUSPEND_REASONS.includes(w.target.reason)) return false;
      if (!validControl(w.control) || w.control.target.reason !== w.target.reason) return false;
    } else {
      // migrate：to 是目标订阅 id，目标快照必须属于它，且订阅版本等于锁内重读到的目标版本。
      if (typeof w.to !== "string" || w.to.length === 0 || w.to === w.expect.subscription_id) return false;
      if (w.control !== null) return false;
      if (w.target.subscription_id !== w.to) return false;
      if (!Number.isInteger(w.expect.to_subscription_version) || w.expect.to_subscription_version <= 0) return false;
      if (w.target.subscription_version !== w.expect.to_subscription_version) return false;
    }
  }

  // **从清单重算指纹，跟它自报的对。**
  const recomputed = fingerprintOf(j.noop, j.writes.map((w) => ({
    binding_ref: w.binding_ref, action: w.action, to: w.to ?? null,
    target_snapshot_id: w.target.snapshot_id, control: w.control, expect: w.expect,
  })));
  return recomputed !== null && recomputed === j.plan_id;
}

/**
 * 构造写集。**先全部造好、验完，再动第一个文件。**
 *
 * 每一条都带 target（要写成什么样），这样重试时能分辨"还没写"和"已经写过" ——
 * 见 applySubscriptionSync 里的幂等判定。
 *
 * ■ 三种动作各自的目标怎么来
 *   resnapshot —— 变更后的订阅（world.next）+ binding 重新物化；
 *   suspend    —— 现有快照收回（materializeSuspendedAuthorization），外加 control 那一笔的 CAS 前置；
 *   migrate    —— 锁内从 world.others 重读的目标订阅 + binding 重新物化。
 * 任何一条造不出来，整批返回失败，一个文件都不动。
 */
export function buildWriteSet({ plan, world, shadowDir, bindingControl = null }) {
  const writes = [];
  for (const entry of plan.plans ?? []) {
    if (!Object.values(SYNC_ACTION).includes(entry.action)) {
      return { ok: false, reason: APPLY_REJECT.UNSUPPORTED_ACTION, action: entry.action, bindingRef: entry.bindingRef };
    }
    const file = snapshotFile(shadowDir, entry.bindingRef);
    const loaded = readJson(file);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, bindingRef: entry.bindingRef };
    const current = loaded.value;

    if (entry.action === SYNC_ACTION.SUSPEND) {
      // 收回授权：沿用现有快照内容、翻成 paused + 受控 reason（撤销时订阅已不存在，没有可物化的输入）。
      if (current === null) return { ok: false, reason: APPLY_REJECT.SNAPSHOT_MISSING, bindingRef: entry.bindingRef };
      const materialized = materializeSuspendedAuthorization({
        previousSnapshot: current, reason: snapshotReasonFor(entry.reason), capturedAt: world.now,
      });
      if (!materialized.ok) return { ok: false, reason: materialized.reason, bindingRef: entry.bindingRef };
      if (!materialized.changed) return { ok: false, reason: APPLY_REJECT.ALREADY_SUSPENDED, bindingRef: entry.bindingRef };
      // **同一 operation 内同步暂停 binding 控制状态**：锁内经端口读当前状态作 CAS 前置。
      if (!bindingControl || typeof bindingControl.read !== "function" || typeof bindingControl.write !== "function") {
        return { ok: false, reason: APPLY_REJECT.BINDING_CONTROL_PORT_MISSING, bindingRef: entry.bindingRef };
      }
      const state = readControl(bindingControl, entry.bindingRef);
      if (!state.ok) return { ok: false, reason: APPLY_REJECT.BINDING_CONTROL_UNREADABLE, bindingRef: entry.bindingRef, detail: state.detail };
      if (state.status !== BINDING_CONTROL_STATUS.ACTIVE) {
        return { ok: false, reason: APPLY_REJECT.EXPECT_MISMATCH, field: "binding_control.status",
          want: BINDING_CONTROL_STATUS.ACTIVE, got: state.status, bindingRef: entry.bindingRef };
      }
      writes.push({ entry, file, current, target: materialized.snapshot, toSubscriptionVersion: null,
        control: { expect: { status: BINDING_CONTROL_STATUS.ACTIVE },
          target: { status: BINDING_CONTROL_STATUS.PAUSED, reason: materialized.snapshot.reason } } });
      continue;
    }

    // resnapshot 用变更后的订阅；migrate 用**锁内重读到的**目标订阅（计划条目只带 id，不带内容）。
    let subscription = world.next;
    let toSubscriptionVersion = null;
    if (entry.action === SYNC_ACTION.MIGRATE) {
      subscription = (world.others ?? []).find((o) => o?.subscription_id === entry.toSubscriptionId) ?? null;
      if (!subscription) return { ok: false, reason: APPLY_REJECT.MIGRATION_TARGET_MISSING, bindingRef: entry.bindingRef, to: entry.toSubscriptionId };
      toSubscriptionVersion = subscription.version;
    }
    const materialized = materializeDialogueBindingAuthorization({
      runtimeNamespace: world.runtimeNamespace,
      endpointId: subscription?.endpoint_id,
      subscription,
      binding: world.bindings?.[entry.bindingRef],
      previousSnapshot: current,
      capturedAt: world.now,
    });
    if (!materialized.ok) {
      return { ok: false, reason: materialized.reason, bindingRef: entry.bindingRef };
    }
    if (!validateDialogueBindingAuthorizationSnapshot(materialized.snapshot).ok) {
      return { ok: false, reason: "target_snapshot_invalid", bindingRef: entry.bindingRef };
    }
    writes.push({ entry, file, current, target: materialized.snapshot, toSubscriptionVersion, control: null });
  }
  return { ok: true, writes };
}

/** 经端口读 binding 控制状态；端口抛错或形状不对都算读不出，不猜。 */
function readControl(port, bindingRef) {
  try {
    const got = port.read(bindingRef);
    if (!got || typeof got !== "object" || !Object.values(BINDING_CONTROL_STATUS).includes(got.status)) {
      return { ok: false, detail: "binding 控制状态形状不受控" };
    }
    return { ok: true, status: got.status };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * 把计划真正写下去。**两层防护都在这里合拢。**
 *
 * readWorld 由调用方给，但**由这里在锁内调用** —— 重读必须发生在锁之内，
 * 否则"锁内重算"只是句好听的话。
 */
/** 只有"文件不存在"算空。**读不出来跟没有是两件事**，其余一律拒绝。 */
function readJournalStrict(file, operationId = null) {
  const got = readJson(file);
  if (!got.ok) return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file };
  if (got.value === null) return { ok: true, journal: null };
  if (!validateJournal(got.value, { operationId })) {
    return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file };
  }
  return { ok: true, journal: got.value };
}

/**
 * 一条待写项现在处于三种状态里的哪一种。
 *
 * 恢复的全部依据就是这个判断：**要么还是原样（没写过），要么已经是目标（写过了）**。
 * 第三种 —— 既不是原值也不是目标值 —— 说明中间有别人动过，
 * 这时候接着写就是拿一份过期的计划去覆盖别人的结果。
 */
function itemState(current, item) {
  // **盘上那份必须先是一份合法快照。**上一版只比 snapshot_id：
  // 盘上只要有 `{"snapshot_id":"目标 id"}` 这么一个残片，就会被判成"已写入"，
  // 然后事务被标记 committed —— **而目标快照的内容根本不存在**。
  // 那等于把一次没做完的事务记成做完了，而恢复清单正是靠这个状态判断该不该重做。
  if (current === null || current === undefined) {
    // 文件还不存在：只有当这条本来就没写过时才算 pending，其余交给 CAS 判。
    return verifyExpect({ expect: item.expect }, current).ok ? "pending" : "diverged";
  }
  if (!validateDialogueBindingAuthorizationSnapshot(current).ok) return "diverged";
  if (current.snapshot_id === item.target.snapshot_id) return "applied";
  return verifyExpect({ expect: item.expect }, current).ok ? "pending" : "diverged";
}

/**
 * 把计划真正写下去。**两层防护都在这里合拢。**
 *
 * readWorld 由调用方给，但**由这里在锁内调用** —— 重读必须发生在锁之内，
 * 否则"锁内重算"只是句好听的话。
 *
 * ■ 重试为什么不能重新规划
 *
 * 上一版的重试路径是"再规划一次、再比指纹、已等于目标的跳过"。那条路**走不到**：
 * 部分写入之后重新规划会看到自己写出的新状态，指纹先变，于是在 plan_stale 就返回了，
 * 后面那句"已等于目标就跳过"永远没机会执行。
 *
 * 所以 prepared 记录不是日志，是**恢复清单**：每一项存下原始 expect 和目标快照 id。
 * 同一个 operation 重试时以清单为准，不再规划。
 */
export function applySubscriptionSync({
  shadowDir, lockDir, operationId, expectedPlanId, readWorld, bindingControl = null,
} = {}) {
  if (typeof shadowDir !== "string" || !path.isAbsolute(shadowDir) ||
      typeof lockDir !== "string" || !path.isAbsolute(lockDir) ||
      !OPERATION_ID.test(operationId ?? "") ||
      typeof expectedPlanId !== "string" || expectedPlanId.length === 0 ||
      typeof readWorld !== "function") {
    return { ok: false, reason: APPLY_REJECT.INPUT_INVALID };
  }

  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: APPLY_REJECT.LOCK_BUSY, detail: lock.reason };
  try {
    const mine = journalFile(shadowDir, operationId);
    const dir = path.dirname(mine);

    // ① 别人的未完成事务优先。目录读不出来也要拒 —— 只有"还没有过任何一次"算空。
    let names = [];
    try { names = fs.readdirSync(dir); }
    catch (err) {
      if (err.code !== "ENOENT") return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, dir };
    }
    for (const f of names) {
      if (!f.endsWith(".json") || f === path.basename(mine)) continue;
      const other = readJournalStrict(path.join(dir, f), f.replace(/\.json$/u, ""));
      if (!other.ok) return other;
      if (other.journal?.status === JOURNAL_STATUS.PREPARED) {
        return { ok: false, reason: APPLY_REJECT.OPERATION_IN_FLIGHT,
          operationId: other.journal.operation_id };
      }
    }

    const own = readJournalStrict(mine, operationId);
    if (!own.ok) return own;

    // ② 同一个 operation 已提交。**要核对是不是同一份计划** ——
    //    复用 operation id 去跑另一份计划，报"已经做过了"就是骗人。
    if (own.journal?.status === JOURNAL_STATUS.COMMITTED) {
      if (own.journal.plan_id !== expectedPlanId) {
        return { ok: false, reason: APPLY_REJECT.OPERATION_REUSED,
          operationId, committedPlanId: own.journal.plan_id, expected: expectedPlanId };
      }
      return { ok: true, replayed: true, written: 0, operationId, planId: own.journal.plan_id };
    }

    // ③ 同一个 operation 停在 prepared：按恢复清单接着做，**不重新规划**。
    if (own.journal?.status === JOURNAL_STATUS.PREPARED) {
      if (own.journal.plan_id !== expectedPlanId) {
        return { ok: false, reason: APPLY_REJECT.OPERATION_REUSED,
          operationId, committedPlanId: own.journal.plan_id, expected: expectedPlanId };
      }
      return finish({ shadowDir, mine, journal: own.journal, resumed: true, bindingControl });
    }

    // ④ 新的一笔：锁内重读、重算、物化目标、比指纹。
    let world;
    try { world = readWorld(); }
    catch (err) {
      return { ok: false, reason: APPLY_REJECT.WORLD_UNREADABLE,
        error: String(err.message).slice(0, 200) };
    }
    const plan = planSubscriptionSync(world);
    if (!plan.ok) return { ok: false, reason: plan.reason, plan };
    const built = buildWriteSet({ plan, world, shadowDir, bindingControl });
    if (!built.ok) return built;
    const fresh = planId(plan, built.writes);
    if (fresh !== expectedPlanId) {
      // 零写入，并且把新算出来的给人看 —— 只说"过期了"等于让人再猜一次。
      return { ok: false, reason: APPLY_REJECT.PLAN_STALE,
        expected: expectedPlanId, actual: fresh, plan };
    }

    // ⑤ 逐条 CAS，全过了才落 prepared。
    const items = [];
    for (const w of built.writes) {
      const state = itemState(w.current, { expect: w.entry.expect, target: w.target });
      if (state === "diverged") {
        const cas = verifyExpect(w.entry, w.current);
        return { ok: false, ...cas, bindingRef: w.entry.bindingRef };
      }
      items.push({
        binding_ref: w.entry.bindingRef,
        action: w.entry.action,
        to: w.entry.toSubscriptionId ?? null,
        expect: { ...expectOf(w.entry), to_subscription_version: w.toSubscriptionVersion ?? null },
        target: w.target,
        control: w.control ?? null,
      });
    }

    const journal = {
      schema_version: JOURNAL_SCHEMA,
      operation_id: operationId, plan_id: fresh, noop: plan.noop === true,
      status: JOURNAL_STATUS.PREPARED,
      prepared_at: new Date().toISOString(), committed_at: null, writes: items,
    };
    // **自己产出的清单也要过同一道校验。**产出端和校验端分叉时，
    // 坏清单会一路写到盘上，等重试时才炸 —— 那时已经动过文件了。
    if (!validateJournal(journal, { operationId })) {
      return { ok: false, reason: APPLY_REJECT.JOURNAL_WRITE_FAILED, stage: "manifest_invalid" };
    }
    try { atomicWriteJson(mine, journal); }
    catch (err) {
      return { ok: false, reason: APPLY_REJECT.JOURNAL_WRITE_FAILED,
        stage: "prepared", error: String(err.message).slice(0, 200) };
    }
    return finish({ shadowDir, mine, journal, resumed: false, bindingControl });
  } finally {
    releasePublishLock(lockDir);
  }
}

/** 按恢复清单把剩下的写完并提交。新的一笔和重试走同一段。 */
function finish({ shadowDir, mine, journal, resumed, bindingControl }) {
  let written = 0;
  let skipped = 0;
  // **恢复时端口也必须在**：清单里有 control 那一笔而端口缺席，写一半就停在 prepared —— 不许把它当没有。
  if (journal.writes.some((w) => w.control) &&
      (!bindingControl || typeof bindingControl.read !== "function" || typeof bindingControl.write !== "function")) {
    return { ok: false, reason: APPLY_REJECT.BINDING_CONTROL_PORT_MISSING, written, total: journal.writes.length };
  }
  for (const item of journal.writes) {
    const file = snapshotFile(shadowDir, item.binding_ref);
    const loaded = readJson(file);
    if (!loaded.ok) {
      return { ok: false, reason: APPLY_REJECT.PARTIAL_WRITE, written,
        total: journal.writes.length, bindingRef: item.binding_ref, detail: loaded.reason };
    }
    const state = itemState(loaded.value, item);
    if (state === "applied") { skipped += 1; continue; }
    if (state === "diverged") {
      // **第三种状态一律拒。**既不是原值也不是目标值，说明中间有别人动过；
      // 接着写就是拿一份过期的计划去覆盖别人的结果。
      return { ok: false, reason: APPLY_REJECT.EXPECT_MISMATCH,
        bindingRef: item.binding_ref, written, total: journal.writes.length };
    }
    try { atomicWriteJson(file, item.target); }
    catch (err) {
      // 不许宣称整体成功。记录停在 prepared，重试时凭它接着做。
      return { ok: false, reason: APPLY_REJECT.PARTIAL_WRITE, written,
        total: journal.writes.length, bindingRef: item.binding_ref,
        error: String(err.message).slice(0, 200) };
    }
    written += 1;
  }
  // **第二笔：binding 控制状态**（只有 suspend 有）。与快照那一笔在同一份清单、同一次 finish 里 ——
  // 快照写了、这里失败 → PARTIAL_WRITE、清单停在 prepared，重试从这里接着做；两笔都到位才提交。
  for (const item of journal.writes) {
    if (!item.control) continue;
    const state = readControl(bindingControl, item.binding_ref);
    if (!state.ok) {
      return { ok: false, reason: APPLY_REJECT.BINDING_CONTROL_UNREADABLE, written,
        total: journal.writes.length, bindingRef: item.binding_ref, detail: state.detail };
    }
    if (state.status === item.control.target.status) { skipped += 1; continue; }
    if (state.status !== item.control.expect.status) {
      return { ok: false, reason: APPLY_REJECT.EXPECT_MISMATCH, field: "binding_control.status",
        want: item.control.expect.status, got: state.status, bindingRef: item.binding_ref,
        written, total: journal.writes.length };
    }
    try { bindingControl.write(item.binding_ref, { ...item.control.target }); }
    catch (err) {
      return { ok: false, reason: APPLY_REJECT.PARTIAL_WRITE, written,
        total: journal.writes.length, bindingRef: item.binding_ref, stage: "binding_control",
        error: String(err?.message ?? err).slice(0, 200) };
    }
    written += 1;
  }
  try {
    atomicWriteJson(mine, {
      ...journal, status: JOURNAL_STATUS.COMMITTED, committed_at: new Date().toISOString() });
  } catch (err) {
    // **数据写完了但收尾记录没写成 —— 这不是成功。**记录仍停在 prepared，
    // 下次重试会把每一项看成 applied 再提交一次；报成功会让人以为事务已经闭合。
    return { ok: false, reason: APPLY_REJECT.JOURNAL_WRITE_FAILED, stage: "committed",
      written, total: journal.writes.length, error: String(err.message).slice(0, 200) };
  }
  return { ok: true, replayed: false, resumed, written, skipped,
    operationId: journal.operation_id, planId: journal.plan_id };
}
