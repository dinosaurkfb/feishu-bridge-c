/**
 * 把同步计划真正落到授权快照与 binding 状态上（FR-2.5 的后半段）。
 *
 * 计划器（subscription-sync.mjs）只算不写。这里负责写，而写是有损的 ——
 * 所以整段设计都围着一个问题：**怎么保证写下去的东西，还是当初算出来的那份。**
 *
 * ■ 两层防护，缺一不可
 *
 * 评审的判断是不要在"锁内重算"和"CAS"之间二选一，两层都做：
 *
 *   第一层，锁内重算。取订阅控制域的锁，锁内重读订阅、正式授权快照、相关 binding
 *   和显式迁移目标，用**同一个** planSubscriptionSync() 重新规划，再比规范化的
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
  materializeDialogueBindingAuthorization, validateDialogueBindingAuthorizationSnapshot,
} from "./dialogue-binding-authorization.mjs";
import { SYNC_ACTION, planSubscriptionSync } from "./subscription-sync.mjs";

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

export function planId(plan) {
  if (!plan || plan.ok !== true) return null;
  const entries = (plan.plans ?? []).map((p) => ({
    binding_ref: p.bindingRef ?? null,
    action: p.action ?? null,
    to: p.toSubscriptionId ?? null,
    expect: {
      subscription_id: p.expect?.subscriptionId ?? null,
      subscription_version: p.expect?.subscriptionVersion ?? null,
      authorization_revision: p.expect?.authorizationRevision ?? null,
      snapshot_id: p.expect?.snapshotId ?? null,
    },
  })).sort((a, b) => String(a.binding_ref).localeCompare(String(b.binding_ref)));
  return digest("sync_plan_", [
    "subscription-sync-plan/v1",
    JSON.stringify({ noop: plan.noop === true, entries }),
  ]);
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
});

/**
 * 第二道 CAS：这条计划依据的那份快照，现在还是不是当初那一份。
 *
 * 四个字段都要比。只比 snapshot_id 看着够（它是内容摘要），但**摘要相同不等于
 * 这条计划仍然适用** —— 订阅版本换了、授权 revision 涨了，都意味着中间发生过
 * 别的事，而这份计划是照着旧世界算的。
 */
export function verifyExpect(entry, current) {
  if (!current) return { ok: false, reason: APPLY_REJECT.SNAPSHOT_MISSING, field: null };
  const pairs = [
    ["subscription_id", entry?.expect?.subscriptionId, current.subscription_id],
    ["subscription_version", entry?.expect?.subscriptionVersion, current.subscription_version],
    ["authorization_revision", entry?.expect?.authorizationRevision, current.authorization_revision],
    ["snapshot_id", entry?.expect?.snapshotId, current.snapshot_id],
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

const snapshotFile = (shadowDir, bindingRef) =>
  path.join(shadowDir, "authorizations", bindingRef + ".json");
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
function validateJournal(j) {
  return !!j && j.schema_version === "subscription-sync-operation/v1"
    && OPERATION_ID.test(j.operation_id ?? "")
    && typeof j.plan_id === "string" && j.plan_id.length > 0
    && Object.values(JOURNAL_STATUS).includes(j.status)
    && Array.isArray(j.writes);
}

/**
 * 构造写集。**先全部造好、验完，再动第一个文件。**
 *
 * 每一条都带 target（要写成什么样），这样重试时能分辨"还没写"和"已经写过" ——
 * 见 applySubscriptionSync 里的幂等判定。
 *
 * ■ 只做 resnapshot，另两种显式拒绝
 *
 * suspend 和 migrate 要写的是"这条 binding 的授权被暂停了 / 归属换了"，
 * 而正式快照的 status/reason 是 materializer 从**订阅和 binding 的状态**推出来的，
 * 撤销时那条订阅已经不存在了 —— 没有可以拿来物化的输入。
 *
 * **我不打算为此编一个出来。**"被撤销的授权长什么样"是个契约问题，
 * 编错了会写出一份看着合法、语义错误的快照，而那种错只会在下一条消息被放行或
 * 被拒时才暴露。先让这两种动作明确失败，把问题留在台面上。
 */
export function buildWriteSet({ plan, world, shadowDir }) {
  const writes = [];
  for (const entry of plan.plans ?? []) {
    if (entry.action !== SYNC_ACTION.RESNAPSHOT) {
      return { ok: false, reason: APPLY_REJECT.UNSUPPORTED_ACTION,
        action: entry.action, bindingRef: entry.bindingRef };
    }
    const file = snapshotFile(shadowDir, entry.bindingRef);
    const loaded = readJson(file);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, bindingRef: entry.bindingRef };
    const current = loaded.value;

    const materialized = materializeDialogueBindingAuthorization({
      runtimeNamespace: world.runtimeNamespace,
      endpointId: world.next.endpoint_id,
      subscription: world.next,
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
    writes.push({ entry, file, current, target: materialized.snapshot });
  }
  return { ok: true, writes };
}

/**
 * 把计划真正写下去。**两层防护都在这里合拢。**
 *
 * readWorld 由调用方给，但**由这里在锁内调用** —— 重读必须发生在锁之内，
 * 否则"锁内重算"只是句好听的话。
 */
export function applySubscriptionSync({
  shadowDir, lockDir, operationId, expectedPlanId, readWorld,
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
    // ① 未完成的事务优先。别的 operation 还停在 prepared，说明上一次没做完 ——
    //    这时开一笔新的，等于在一份不完整的状态上再叠一层。
    const mine = journalFile(shadowDir, operationId);
    const dir = path.dirname(mine);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { /* 还没有过任何一次 */ }
    for (const f of entries) {
      if (!f.endsWith(".json") || f === path.basename(mine)) continue;
      const other = readJson(path.join(dir, f));
      if (!other.ok) return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file: f };
      if (other.value?.status === JOURNAL_STATUS.PREPARED) {
        return { ok: false, reason: APPLY_REJECT.OPERATION_IN_FLIGHT,
          operationId: other.value.operation_id ?? null };
      }
    }

    const own = readJson(mine);
    if (!own.ok) return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file: path.basename(mine) };
    if (own.value !== null && !validateJournal(own.value)) {
      return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file: path.basename(mine) };
    }
    // ② 同一个 operation 重放：已经 committed 就直接说"做过了"，一个字节都不再写。
    if (own.value?.status === JOURNAL_STATUS.COMMITTED) {
      return { ok: true, replayed: true, written: 0, operationId, planId: own.value.plan_id };
    }

    // ③ 锁内重读、重算、比指纹。
    const world = readWorld();
    const plan = planSubscriptionSync(world);
    if (!plan.ok) return { ok: false, reason: plan.reason, plan };
    const fresh = planId(plan);
    if (fresh !== expectedPlanId) {
      // 零写入，并且把新算出来的给人看 —— 只说"过期了"等于让人再猜一次。
      return { ok: false, reason: APPLY_REJECT.PLAN_STALE,
        expected: expectedPlanId, actual: fresh, plan };
    }

    // ④ 写集先构造后写。
    const built = buildWriteSet({ plan, world, shadowDir });
    if (!built.ok) return built;

    // ⑤ 第二道 CAS。**已经写成 target 的算做过**，否则重试会被自己上一次卡住。
    const pending = [];
    for (const w of built.writes) {
      if (w.current?.snapshot_id === w.target.snapshot_id) continue;  // 上一次写过了
      const cas = verifyExpect(w.entry, w.current);
      if (!cas.ok) return { ok: false, ...cas, bindingRef: w.entry.bindingRef };
      pending.push(w);
    }

    // ⑥ prepared 先落，再动文件。中间崩掉时记录停在 prepared，
    //    **那本身就是"没做完"的证据**。
    const journal = {
      schema_version: "subscription-sync-operation/v1",
      operation_id: operationId, plan_id: fresh, status: JOURNAL_STATUS.PREPARED,
      prepared_at: new Date().toISOString(), committed_at: null,
      writes: built.writes.map((w) => ({
        binding_ref: w.entry.bindingRef, snapshot_id: w.target.snapshot_id })),
    };
    atomicWriteJson(mine, journal);

    let written = 0;
    for (const w of pending) {
      try { atomicWriteJson(w.file, w.target); }
      catch (err) {
        // **不许宣称整体成功。**记录停在 prepared，重试时凭它接着做。
        return { ok: false, reason: APPLY_REJECT.PARTIAL_WRITE,
          written, total: pending.length, bindingRef: w.entry.bindingRef,
          error: String(err.message).slice(0, 200) };
      }
      written += 1;
    }

    atomicWriteJson(mine, {
      ...journal, status: JOURNAL_STATUS.COMMITTED, committed_at: new Date().toISOString() });
    return { ok: true, replayed: false, written, skipped: built.writes.length - pending.length,
      operationId, planId: fresh };
  } finally {
    releasePublishLock(lockDir);
  }
}
