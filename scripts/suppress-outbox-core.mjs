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

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { auditOutbox, listPending, outboxMutationBlocker } from "./outbox.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { generationTargetState, usableGeneration } from "./topic-generation.mjs";

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

// **判据住在 topic-generation.mjs**（usableGeneration 的隔壁）——
// 审计和抑制核心都要用它；留在这里的话审计就够不着，
// 于是"统一守卫"会漏掉损坏代际。这里只转出。
export { generationTargetState };


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
/**
 * 把一批已经取出来的待发记录标成**永久失败**，停止重试。
 *
 * 为什么要有它：有一类发布失败重试再多次也不会变 —— 比如话题是另一个应用建的，
 * 当前身份回复不进去。那种情况下每 30 分钟重试一次只是稳定地制造噪音，
 * 而每轮 Stop 都会说一句"兜底定时器会重试"，那句话是假的。
 *
 * **但判定"永久"这件事由人做，不由代码做。**曾经试过自动判：诊断到"根消息属于
 * 另一个应用"就抑制。那是**从相关性推因果** —— 一次瞬时的网络错误恰好发生在
 * 跨应用根消息上，照样会触发不可逆的抑制。有损动作不能建立在推断出来的因果上。
 *
 * 所以排空只诊断并报告，这个函数只被显式的 feishu-suppress-outbox 命令调用。
 *
 * ■ 为什么它住在这里，而且不导出
 *
 * 它是**无条件的写原语**：给它一批记录，它就把它们永久停掉。
 * 放在 outbox.mjs 公开导出时，统一守卫拒绝的记录**直接调它就能停掉** ——
 * 守卫写在调用方那一侧，永远是"记得调的人才受约束"。
 *
 * 现在它是本模块私有的：外面唯一能走的路是 applySuppressionCore，
 * 而那条路上审计、摘要、锁一个都跳不过去。
 */
function suppressSnapshots(snapshots, { reason }) {
  let changed = 0;
  const failed = [];
  for (const snap of snapshots) {
    const file = snap.file;
    if (typeof file !== "string") { failed.push({ file: null, reason: "no_file_ref" }); continue; }
    let current;
    // **不重读盘。**用的就是算摘要时那一份字节 ——
    // "算摘要读一次、写回再读一次"之间的窗口里，别的写方能改掉这条记录的语义，
    // 而摘要已经核对过了。读一次、之后全用这一份，窗口才真的没有。
    try { current = JSON.parse(snap.raw.toString("utf-8")); } catch {
      // **不可逆操作不能静默漏项。**读不出来就是没停成，必须进 failed ——
      // 否则调用方会以为整批都停了，而漏掉的那条继续每 30 分钟重试。
      failed.push({ file, reason: "unreadable" });
      continue;
    }
    // 已发出/已抑制不算漏项：目标状态已经达到。
    if (current.published_at !== null || current.publish_suppressed_at) continue;
    const next = {
      ...current,
      publish_eligible_at: null,
      publish_suppressed_at: new Date().toISOString(),
      publish_suppressed_reason: String(reason ?? "permanent_publish_failure").slice(0, 200),
    };
    try {
      const tmp = file + ".tmp." + randomUUID();
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
      changed += 1;
    } catch (err) {
      // **不许半写后抛。**上一版第二条不可写时直接抛出去：前面几条已经被永久抑制，
      // 调用方却只收到一个异常 —— 它不知道自己已经改掉了多少东西。
      // 返回结构化的部分失败，让调用方能如实报"停了几条、几条没停成"。
      failed.push({ file, reason: String(err.code ?? err.message).slice(0, 60) });
    }
  }
  return { ok: failed.length === 0, changed, failed };
}

/**
 * 这一批的**稳定摘要**。预览打印它，`--apply` 必须原样带回来。
 *
 * ■ 为什么不能在 apply 时现算
 *
 * 预览和 --apply 是两次独立运行。在 apply 时现算，第二个进程算出的是
 * "现在"的值，跟自己一比总是相等 —— **而"预览之后世界变了"恰恰只可能
 * 跨进程发生**，于是守卫只覆盖进程内窗口，等于没有。
 * 这条线上同一个错误犯过三次（previewGenerationId、previewFiles、以及
 * 以为已经修好的那次），所以摘要的值只能来自人手里那份预览输出。
 *
 * ■ 为什么绑原始字节，而不是挑几个字段
 *
 * 手挑字段的错误模式是**"想不到的那个字段"**：曾经挑了
 * id/kind/created_at/目标代际/正文，漏了 publish_eligible_at ——
 * 把它从 null 改成合法时间之后**摘要一模一样**，旧摘要照样落盘，
 * 抑制了一条语义已经变了的记录。补一个还有下一个。
 *
 * 绑**整个文件的字节**：任何字段的任何改动都会让摘要变掉，不需要有人预先想全。
 * 文件名用 basename —— 摘要不能因为临时目录不同而变。
 */
export function suppressionDigest({ outboxDir = null, files = [], records = [] } = {}) {
  const nameOf = (r) => path.basename(String(r?._file ?? ""));
  const snapshots = records.map((r) => {
    const name = nameOf(r);
    const file = r?._file ?? (outboxDir ? path.join(outboxDir, name) : null);
    let raw;
    try { raw = fs.readFileSync(file); }
    catch {
      // 读不出来 → 一个**不可能跟真实内容相撞**的标记，让摘要必然变化。
      // 真正的拦截在审计那一层（读不出来的文件根本走不到这儿）。
      raw = Buffer.from("\u0000unreadable\u0000" + name);
    }
    return { name, file, raw };
  });
  return digestOfSnapshots(files, snapshots);
}

/**
 * 摘要的**唯一算法**。锁内那次读到的字节直接喂给它，不再为算摘要重读一遍 ——
 * "算摘要读一次、写回再读一次"之间的窗口正是要防的地方。
 */
function digestOfSnapshots(files, snapshots) {
  const h = createHash("sha256");
  h.update("v1\nfiles\n");
  for (const f of [...files].sort()) h.update(String(f) + "\n");
  h.update("records\n");
  for (const snap of [...snapshots].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    h.update(snap.name + "\u0000");
    h.update(createHash("sha256").update(snap.raw).digest("hex"));
    h.update("\n");
  }
  return "sup-" + h.digest("hex").slice(0, 24);
}

/** 摘要的形状。**在拿锁之前就要验** —— 纯空白不是"没给"，但也不是有效值。 */
const DIGEST_SHAPE = /^sup-[0-9a-f]{24}$/u;

export function applySuppressionCore({
  outboxDir, publishLockDir, generationLockDir, pending,
  // 预览打印、由人原样带回来的摘要。**必填** —— 跟 previewGenerationId 同一条
  // 道理：在这里现算就只覆盖进程内窗口，而要防的事只发生在两次运行之间。
  previewDigest = null,
  previewGenerationId = null, readState, reason,
}) {
  // **说不清就一条都不动，锁一把都不拿。**
  //
  // 这里用的是**跟锁内同一个守卫**，不是第二份判据 ——
  // 同一个函数在两个时点各跑一次：这一次省掉"明显不该动时还去拿两把锁"，
  // 锁内那一次才是有约束力的那道（它看的是"此刻"的目录状态）。
  //
  // 目标代际"字段在、但不是可用代际"也归它：当成 legacy 去重新解释等于替它
  // 猜一个目标；当成 frozen 放行则是拿一个说不清的值当"已冻结"——
  // 两条路都会不可逆地停掉一条我们其实不知道该发去哪的内容。
  // 这一批里只要有一条说不清，整批都不动：混着抑制会让人以为"那批都处理了"。
  const early = outboxMutationBlocker(auditOutbox(outboxDir));
  if (early) return { ok: false, ...early };
  const needsGeneration = dependsOnMapping(pending);
  // **代际那条前置先判**：它更具体（只在有旧格式记录时才需要），
  // 让摘要那条盖住它的话，人看到的是"去补摘要"，补完才发现真正缺的是代际。
  // 两条都在拿锁之前 —— **缺前提不是并发问题，别报成取锁失败**。
  if (needsGeneration) {
    if (!nonEmpty(generationLockDir)) return { ok: false, reason: "binding_unresolved" };
    if (!usableGeneration(previewGenerationId)) {
      return { ok: false, reason: "generation_expectation_required" };
    }
  }
  // 验的是**形状**，不是"非空"：纯空白 "   " 长度是 3，只查 length 会让它
  // 一路穿过去开始取锁，最后报 publisher_busy —— 缺前提被报成并发问题。
  if (typeof previewDigest !== "string" || !DIGEST_SHAPE.test(previewDigest)) {
    return { ok: false, reason: "digest_expectation_required" };
  }
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
    // **这个 outbox 现在能不能动 —— 只认统一守卫。**
    // 判据跟只读视图共用一份；这里再自己判一次就是第二份判据。
    const blocked = outboxMutationBlocker(auditOutbox(outboxDir));
    if (blocked) return { ok: false, ...blocked };

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

    // **锁内只读这一次盘**：摘要核对和写回用同一份字节，中间不留窗口。
    const snapshots = [];
    for (const r of fresh) {
      const file = r?._file;
      if (typeof file !== "string") return { ok: false, reason: "outbox_unreadable", files: [] };
      try { snapshots.push({ name: path.basename(file), file, raw: fs.readFileSync(file) }); }
      catch { return { ok: false, reason: "outbox_unreadable", files: [path.basename(file)] }; }
    }
    // 锁内重算，跟人带回来的那份比。**这一步才是真正的跨进程 CAS** ——
    // 文件集合、每条的字节只要有一点跟预览时不同就中止，
    // 包括"预览之后新进来一条"这种待发集合比较看不出来的情况。
    const nowDigest = digestOfSnapshots(auditOutbox(outboxDir).files, snapshots);
    if (nowDigest !== previewDigest) {
      return { ok: false, reason: "digest_mismatch",
        expected: previewDigest, actual: nowDigest };
    }
    return { ok: true, done: suppressSnapshots(snapshots, { reason }) };
  } finally {
    releasePublishLock(publishLockDir);
    if (genLock !== null) releasePublishLock(genLock);
  }
}
