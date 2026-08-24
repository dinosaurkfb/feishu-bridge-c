/**
 * 抑制待发内容的**判据本身**。两条链路共用这一份。
 *
 * 抽出来的理由不是"省几行"：这段逻辑里每一条都是踩出来的，
 * 而它们的共同点是**改坏了不会当场报错，只会在某个并发时刻悄悄毁掉一批内容**：
 *
 *   · 先取代际锁再取发布锁 —— 顺序反了会死锁，只取一把挡不住轮转。
 *   · 锁内重读 mapping —— 用预览时那一份的话，旧格式记录的"属于哪一代"已经变了。
 *   · 比文件集合而不是条数 —— 等量替换（少一条旧的、多一条新的）总数不变。
 *   · 轮转过就中止，**即使一个文件都没变** —— "抑制这一代"的含义已经不是原来那个。
 *
 * Codex 侧要同样的判据。**再抄一遍是今天被反复罚过的那种错**：
 * 两处各写一份，看起来都在守，实际只有一边守住。所以两边共用这一个函数，
 * 各自只提供自己的路径和"锁内怎么重读"。
 */

import { listPending, suppressRecords } from "./outbox.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { usableGeneration } from "./topic-generation.mjs";

const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/**
 * 这个值能不能当作代际用 —— **全仓唯一的判据**。
 *
 * 两侧包装层的 expectation 检查、核心的前置条件、以及记录目标代际的三态判定
 * 都走它。上一版它只管 expectation，`dependsOnMapping` 还留在旧的 length > 0 上，
 * 于是空白目标绕过了全部守卫。**同一个概念在同一个 PR 里一处分清、另一处混回去，
 * 这是第三次了。**
 */
export { usableGeneration };

/**
 * 一条待发记录的目标代际处于哪一态。**三态，不是两态。**
 *
 * 上一版只分"有/没有"，判据还是 length > 0 —— 于是
 * `target_channel_generation_id: "   "` 被当成"自带明确代际"：不要求
 * expectation、不取代际锁、不做轮转比较，**直接被永久抑制**。评审实测复现。
 *
 * - `legacy`  ：字段缺失或 null —— 合法的旧格式，代际靠当前 mapping 现算。
 * - `frozen`  ：可用的非空代际 —— 目标已冻结，轮转不影响它。
 * - `corrupt` ：字段在，但不是可用代际 —— **损坏记录**。
 *               不许当成 legacy 去重新解释（那等于替它猜一个目标），
 *               也不许当成 frozen 放行。fail-closed。
 */
export function generationTargetState(record) {
  const raw = record?.target_channel_generation_id;
  if (raw === undefined || raw === null) return "legacy";
  return usableGeneration(raw) ? "frozen" : "corrupt";
}

/** 这批待发里有没有"代际靠 mapping 现算"的旧格式记录。 */
export const dependsOnMapping = (records) =>
  (records ?? []).some((r) => generationTargetState(r) === "legacy");

/** 这批里有没有损坏的目标代际 —— 有就一条都不许动。 */
export const corruptTargets = (records) =>
  (records ?? []).filter((r) => generationTargetState(r) === "corrupt");

/**
 * @param outboxDir        待发目录
 * @param publishLockDir   发布锁
 * @param generationLockDir 代际锁；**只在有旧格式记录时才需要**。
 *                          需要却给不出（说不清跟哪一把串行）就传 null → 明确拒绝。
 * @param pending          预览时看到的那一批
 * @param previewGenerationId 预览时的有效代际（没有就传 null）
 * @param readState        锁内调用：() => { activeGeneration, select(records) }
 * @param reason           抑制理由，写进记录
 */
export function applySuppressionCore({
  outboxDir, publishLockDir, generationLockDir, pending,
  previewGenerationId = null, readState, reason,
}) {
  // **损坏记录：一条都不许动，锁一把都不拿。**
  //
  // 它的目标代际字段在、但不是可用代际。当成 legacy 去重新解释等于替它猜一个
  // 目标；当成 frozen 放行则是拿一个说不清的值当"已冻结"——
  // 两条路都会不可逆地停掉一条我们其实不知道该发去哪的内容。
  // 这一批里只要有一条坏的，整批都不动：混着抑制会让人以为"那批都处理了"。
  const corrupt = corruptTargets(pending);
  if (corrupt.length > 0) {
    return { ok: false, reason: "corrupt_target_generation",
      count: corrupt.length, files: corrupt.map((r) => r?._file ?? null) };
  }
  const needsGeneration = dependsOnMapping(pending);
  // **这批里有旧格式记录 → 必须带着预览看到的代际来落盘。这条前置条件属于核心，
  // 不属于哪个 CLI。**
  //
  // 上一版把它留给调用方，两个包装层就各自现算了一个值 —— 而预览和 --apply 是
  // 两次独立运行，第二个进程算出的是轮转之后的值，前后一比总是相等。
  // **而「预览之后轮转过」恰恰只可能跨进程发生**，于是这道守卫从来没生效过。
  //
  // 包装层负责解析和显示 --expect-generation，但不许决定它可不可以不给。
  let genLock = null;
  if (needsGeneration) {
    // 有旧格式记录却说不清该跟哪一把锁串行 —— **明确拒绝**，
    // 不许退而求其次去拿一把猜出来的锁碰运气。
    // 这条排在 expectation 之前：连绑定都解析不出来时，"缺预览代际"是个
    // 派生症状，报它会盖住真正的原因。
    if (!nonEmpty(generationLockDir)) return { ok: false, reason: "binding_unresolved" };
    // 到这儿说明代际这个概念是成立的 —— 那就必须带着预览看到的那一代来。
    // 空白串也算没给。放它过去的话，它会在下面被判成 rotated
    // （from: "   "）—— 结果同样是零抑制，但报出来的原因是错的：
    // 那不是"世界变了"，那是"这个值根本不是代际"。
    if (!usableGeneration(previewGenerationId)) {
      return { ok: false, reason: "generation_expectation_required" };
    }
    const got = acquirePublishLock(generationLockDir);
    // 轮转正在进行 → 现在不是动 outbox 的时候。
    if (!got.ok) return { ok: false, reason: "rotation_busy" };
    genLock = generationLockDir;
  }
  const lock = acquirePublishLock(publishLockDir);
  if (!lock.ok) {
    if (genLock !== null) releasePublishLock(genLock);
    return { ok: false, reason: lock.reason };
  }
  try {
    // **锁内重读**，不用预览时那一份 —— 代际含义正是从它来的。
    const state = readState();
    if (!state || typeof state.select !== "function") {
      return { ok: false, reason: "state_unreadable" };
    }
    // 只有旧格式记录的归属会随轮转改变。每条都自带代际时轮转不影响任何一条 ——
    // 这时再因为轮转中止，就是在拒绝一件本来安全的事。
    if (needsGeneration && state.activeGeneration !== previewGenerationId) {
      return { ok: false, reason: "rotated",
        from: previewGenerationId, to: state.activeGeneration ?? null };
    }
    const fresh = state.select(listPending({ outboxDir }));
    // **锁内重读之后要再判一次损坏，不能只比文件名。**
    //
    // 锁外那次判的是预览快照。同一个文件的目标代际在预览之后变坏时，
    // 文件名集合一个字节没变，集合 CAS 一路放行 ——
    // 于是一条我们已经说不清该发去哪的内容被永久抑制。评审实测复现。
    //
    // 这跟"锁内重读却闭包了旧值"是同一类：接口留了重读，实现只拿它比了文件名。
    const corruptNow = corruptTargets(fresh);
    if (corruptNow.length > 0) {
      return { ok: false, reason: "corrupt_target_generation",
        count: corruptNow.length, files: corruptNow.map((r) => r?._file ?? null),
        atRecheck: true };
    }
    // **比集合，不是比数量。**只比条数挡不住等量替换：预览之后少一条旧的、
    // 多一条新的，总数没变，就会不可逆地抑制另一批内容。
    const before = new Set(pending.map((x) => x._file));
    const now = new Set(fresh.map((x) => x._file));
    const same = before.size === now.size && [...before].every((f) => now.has(f));
    if (!same) return { ok: false, reason: "drift", before: before.size, now: now.size };
    return { ok: true, done: suppressRecords(fresh, { reason }) };
  } finally {
    releasePublishLock(publishLockDir);
    if (genLock !== null) releasePublishLock(genLock);
  }
}
