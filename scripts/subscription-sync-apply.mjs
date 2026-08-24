/**
 * resnapshot 的落盘地基（FR-2.5 后半段的**第一块**，不是全部）。
 *
 * **写清楚它不是什么**：这里只处理 resnapshot。suspend / migrate 返回
 * unsupported_action —— "被撤销的授权长什么样"是个契约问题，评审已经定了形状
 * （新 revision、status=paused、新增受控原因 subscription_revoked、
 * 同一 operation 内同步暂停 binding 控制状态），但还没实现。
 * 在那之前，**不许把这个模块说成"FR-2.5 落盘链路已完成"**。
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

export function planId(plan, writes = null) {
  if (!plan || plan.ok !== true) return null;
  // **指纹必须覆盖"将要写什么"，不只是"打算做什么"。**
  // 上一版只放了动作、目标订阅 id 和旧快照前置条件 ——
  // 两份内容不同的新授权可以算出同一个指纹，那样"计划没变"就成了假话。
  // 所以物化出来的目标快照 id 也要进去；给不出 writes 时返回 null，
  // 不许拿一份只描述意图的指纹去当"将写什么"的凭据。
  if (writes === null) return null;
  const byRef = new Map(writes.map((w) => [w.entry.bindingRef, w.target.snapshot_id]));
  const entries = (plan.plans ?? []).map((p) => ({
    binding_ref: p.bindingRef ?? null,
    action: p.action ?? null,
    to: p.toSubscriptionId ?? null,
    target_snapshot_id: byRef.get(p.bindingRef) ?? null,
    expect: {
      subscription_id: p.expect?.subscriptionId ?? null,
      subscription_version: p.expect?.subscriptionVersion ?? null,
      authorization_revision: p.expect?.authorizationRevision ?? null,
      snapshot_id: p.expect?.snapshotId ?? null,
    },
  })).sort((a, b) => String(a.binding_ref).localeCompare(String(b.binding_ref)));
  if (entries.some((e) => e.target_snapshot_id === null)) return null;
  return digest("sync_plan_", [
    "subscription-sync-plan/v2",
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
  OPERATION_REUSED: "operation_id_reused_for_other_plan",
  WORLD_UNREADABLE: "world_unreadable",
  JOURNAL_WRITE_FAILED: "journal_write_failed",
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
/** 只有"文件不存在"算空。**读不出来跟没有是两件事**，其余一律拒绝。 */
function readJournalStrict(file) {
  const got = readJson(file);
  if (!got.ok) return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file };
  if (got.value === null) return { ok: true, journal: null };
  if (!validateJournal(got.value)) return { ok: false, reason: APPLY_REJECT.JOURNAL_UNREADABLE, file };
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
  if (current?.snapshot_id === item.target.snapshot_id) return "applied";
  const cas = verifyExpect({ expect: item.expect }, current);
  return cas.ok ? "pending" : "diverged";
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
      const other = readJournalStrict(path.join(dir, f));
      if (!other.ok) return other;
      if (other.journal?.status === JOURNAL_STATUS.PREPARED) {
        return { ok: false, reason: APPLY_REJECT.OPERATION_IN_FLIGHT,
          operationId: other.journal.operation_id };
      }
    }

    const own = readJournalStrict(mine);
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
      return finish({ shadowDir, mine, journal: own.journal, resumed: true });
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
    const built = buildWriteSet({ plan, world, shadowDir });
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
        expect: {
          subscription_id: w.entry.expect.subscriptionId,
          subscription_version: w.entry.expect.subscriptionVersion,
          authorization_revision: w.entry.expect.authorizationRevision,
          snapshot_id: w.entry.expect.snapshotId,
        },
        target: w.target,
      });
    }

    const journal = {
      schema_version: "subscription-sync-operation/v1",
      operation_id: operationId, plan_id: fresh, status: JOURNAL_STATUS.PREPARED,
      prepared_at: new Date().toISOString(), committed_at: null, writes: items,
    };
    try { atomicWriteJson(mine, journal); }
    catch (err) {
      return { ok: false, reason: APPLY_REJECT.JOURNAL_WRITE_FAILED,
        stage: "prepared", error: String(err.message).slice(0, 200) };
    }
    return finish({ shadowDir, mine, journal, resumed: false });
  } finally {
    releasePublishLock(lockDir);
  }
}

/** 按恢复清单把剩下的写完并提交。新的一笔和重试走同一段。 */
function finish({ shadowDir, mine, journal, resumed }) {
  let written = 0;
  let skipped = 0;
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
