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

const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/** 这批待发里有没有"代际靠 mapping 现算"的旧格式记录。 */
export const dependsOnMapping = (records) =>
  (records ?? []).some((r) => !nonEmpty(r?.target_channel_generation_id));

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
  const needsGeneration = dependsOnMapping(pending);
  let genLock = null;
  if (needsGeneration) {
    // 有旧格式记录却说不清该跟哪一把锁串行 —— **明确拒绝**，
    // 不许退而求其次去拿一把猜出来的锁碰运气。
    if (!nonEmpty(generationLockDir)) return { ok: false, reason: "binding_unresolved" };
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
    if (needsGeneration && previewGenerationId !== null &&
        state.activeGeneration !== previewGenerationId) {
      return { ok: false, reason: "rotated",
        from: previewGenerationId, to: state.activeGeneration ?? null };
    }
    const fresh = state.select(listPending({ outboxDir }));
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
