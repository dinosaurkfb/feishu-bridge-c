/**
 * `eligibility_pending` 的恢复消费者 —— **最小的那一个**。
 *
 * ■ 它为什么必须跟统一写锁同一层落地
 *
 * 给资格提升加上发布锁之后，`publisher_busy` 从"理论上"变成了真实路径：
 * 提升只重试约 720ms，而竞争方（真实发布）会持锁做网络调用，默认可达 12 秒。
 * watcher 于是记下 `eligibility_pending` 就退出了 —— **那条答复再没有任何路径
 * 获得资格**，除非有人来消费这个状态。
 *
 * 留了状态没人管等于没留。所以统一写锁和这个消费者要么一起装，要么都别装。
 *
 * ■ 恢复标记是发布授权制品，必须验真
 *
 * 它决定"给哪条记录发资格"。评审构造过：标记的 claim_key 与文件名自洽，
 * 但 `event_key` 指向别人的答复 —— 于是这张标记替另一条 claim 拿到了发布资格。
 * 所以 **event_key 一律自己按 thread + 文件名里的 claim key 算**，
 * 不信标记自报的那个；命中的记录还必须唯一且 `run_id === claim_key`。
 *
 * **封闭 schema 要连取值域一起封。**只封键名的话，一个真实的 64 位 key 配上
 * `promote_failed: {}` 照样能拿到授权 —— 键集说的是"有哪些字段"，
 * 取值域说的才是"这些字段能是什么"。
 *
 * ■ 边界
 *
 * **调用它的时候不许持有发布锁。**它内部要经 markPublishEligibleByEventKey
 * 去拿那把锁；在锁内调就是自己卡死自己（那把锁不可重入）。
 *
 * ■ 什么时候才允许删掉标记
 *
 * 只有在这条事件的资格问题**已经有结论**时才删：提升成功、本来就有资格、
 * 已经发出去了、已经被永久停发 —— 这四种都不需要再有人来管。
 * 其余一律留着：说不清的标记删掉就等于把唯一的证据也丢了。
 */

import fs from "node:fs";
import path from "node:path";

import { isCanonicalIso } from "./canonical-time.mjs";
import { codexReplyEventKey, markPublishEligibleByEventKey } from "./outbox.mjs";

const SUFFIX = ".eligibility_pending.json";

/**
 * 一张恢复标记的**完整键集** —— 不多不少。
 * 就是 recordClaimState 加上 watch-run 那份 detail 实际写出来的那些。
 */
const MARKER_KEYS = [
  "claim_key", "event_key", "promote_failed", "recorded_at", "run_state", "schema_version", "state",
].sort();

/**
 * claim key 的真实形状：`claimKey()` 是 sha256 的十六进制摘要，恒为 64 位。
 * 文件名就是 key，所以这一条同时封住了文件名。
 */
const CLAIM_KEY_SHAPE = /^[0-9a-f]{64}$/u;

/** 提升失败的原因：这条链上的 reason 全是小写下划线短标识，不是自由文本。 */
const REASON_SHAPE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * 等资格的预算：默认 60 秒（竞争方持锁做真实网络发布默认可达 12 秒，留足余量），
 * 上限 10 分钟。
 *
 * **必须是有限的安全整数。**评审实测：`/^\d+$/` 放行了一个 400 位数字，
 * `Number()` 得到 `Infinity`，截止时间也成了 `Infinity` —— 锁一直繁忙时
 * 这个循环**永不结束**，watcher 外层那个四小时窗口和 session lock 释放
 * 全都执行不到。**有界等待被一个配置值变成了无限等待。**
 *
 * 不合规一律回落默认值：一个看不懂的值不该静默把恢复路径关掉（当成 0），
 * 也不该把它变成永远（Infinity）。
 */
export const ELIGIBILITY_BUDGET_DEFAULT_MS = 60_000;
export const ELIGIBILITY_BUDGET_MAX_MS = 10 * 60_000;

export function eligibilityBudgetMs(raw) {
  const n = typeof raw === "string" ? (/^\d{1,9}$/u.test(raw) ? Number(raw) : NaN) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    return ELIGIBILITY_BUDGET_DEFAULT_MS;
  }
  return Math.min(n, ELIGIBILITY_BUDGET_MAX_MS);
}

/** 同步等一小会儿 —— 这条链上的函数都是同步契约，不能改成 async。 */
function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * **一个共用的重试循环** —— 两处等待用同一份节奏与截止时间语义。
 * 各自只提供"这一次做什么"和"什么情况才值得再等"。
 */
function retryUntil({ deadline, waitMs, now, wait, attempt, retryWhen }) {
  let last = attempt();
  let attempts = 1;
  while (retryWhen(last) && now() < deadline) {
    wait(waitMs);
    last = attempt();
    attempts += 1;
  }
  return { last, attempts };
}

/**
 * 列出所有待恢复标记。**结构不对的也列出来**，标成 unusable ——
 * 静默跳过会让"有 3 条卡住"看起来像"一条都没有"。
 *
 * @returns {{ok:true, items:object[]}|{ok:false, reason:"claims_unreadable"}}
 *          目录读不出来是故障，不是"一条都没有"——它俩在输出上长得一模一样，
 *          而含义相反：前者意味着可能有一批答复正卡着没人管。
 */
export function listEligibilityPending({ claimsDir, threadId }) {
  let names;
  try { names = fs.readdirSync(claimsDir).filter((f) => f.endsWith(SUFFIX)).sort(); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, items: [] };
    return { ok: false, reason: "claims_unreadable" };
  }
  const items = [];
  for (const name of names) {
    const file = path.join(claimsDir, name);
    const key = name.slice(0, -SUFFIX.length);
    const bad = (why) => items.push({ file, key, unusable: why });
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); }
    catch { bad("读不出来"); continue; }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) { bad("不是记录对象"); continue; }

    // **封闭键集**：这是发布授权制品，按真实产物要求"不多不少"。
    // 上一版只在字段存在时才对账 event_key —— 评审实测：**把 event_key 删掉，
    // 标记照样被接受、目标拿到资格、标记被撤**。只拒绝错值而放过缺字段，
    // 等于给伪造留了最省事的一条路：少写一个字段就绕过了对账。
    const keys = Object.keys(doc).sort();
    const missing = MARKER_KEYS.filter((k) => !keys.includes(k));
    if (missing.length > 0) { bad("缺字段：" + missing.join("、")); continue; }
    const extra = keys.filter((k) => !MARKER_KEYS.includes(k));
    if (extra.length > 0) { bad("多出不认识的字段：" + extra.join("、")); continue; }

    // **取值域跟键集一起验。**
    if (doc.schema_version !== "1.0") { bad("schema_version 不认识"); continue; }
    if (!CLAIM_KEY_SHAPE.test(String(key))) { bad("文件名不是 claim key 的形状"); continue; }
    // 文件名与内容必须自洽 —— 否则一张错配的标记能替另一条事件要资格。
    if (doc.claim_key !== key) { bad("claim_key 跟文件名对不上"); continue; }
    if (doc.state !== "eligibility_pending") { bad("state 不是 eligibility_pending"); continue; }
    if (!isCanonicalIso(doc.recorded_at)) { bad("recorded_at 不是规范时间"); continue; }
    // 只有"这一轮确实跑完了"才谈得上发布资格。
    if (doc.run_state !== "completed") { bad("run_state 不是 completed"); continue; }
    if (typeof doc.promote_failed !== "string" || !REASON_SHAPE.test(doc.promote_failed)) {
      bad("promote_failed 不是原因标识"); continue;
    }
    if (typeof threadId !== "string" || !threadId) { bad("不知道属于哪条 thread，无法自己算事件键"); continue; }
    // **事件键自己算。**标记自带的那个只用来对账：对不上说明这张标记被改过。
    const eventKey = codexReplyEventKey({ threadId, claimKey: key });
    if (doc.event_key !== eventKey) {
      bad("event_key 跟按 thread 与 claim 算出来的对不上"); continue;
    }
    items.push({ file, key, eventKey });
  }
  return { ok: true, items };
}

/**
 * 扫一遍，逐条重试资格提升。**不持锁调用。**
 *
 * @returns {{ok:boolean, reason?:string, recovered:object[], pending:object[], unusable:object[]}}
 */
export function recoverEligibilityPending({ claimsDir, outboxDir, publishLockDir, threadId }) {
  const listed = listEligibilityPending({ claimsDir, threadId });
  if (!listed.ok) return { ok: false, reason: listed.reason, recovered: [], pending: [], unusable: [] };
  const recovered = [];
  const pending = [];
  const unusable = [];
  for (const item of listed.items) {
    if (item.unusable) { unusable.push(item); continue; }
    const r = markPublishEligibleByEventKey({
      outboxDir, eventKey: item.eventKey, publishLockDir, requireRunId: item.key });
    // why 一路带上 —— 只报 record_unclassified 的话，人还得自己去猜是哪个字段。
    if (!r.ok) { pending.push({ ...item, reason: r.reason, ...(r.why ? { why: r.why } : {}) }); continue; }
    // 有结论了 —— 标记可以撤了。删不掉不算失败：下一轮会再走一遍，
    // 而重复提升是幂等的（already_eligible）。
    try { fs.unlinkSync(item.file); } catch { /* 下轮再说 */ }
    recovered.push({ ...item, reason: r.reason ?? (r.changed ? "promoted" : "unchanged") });
  }
  return { ok: true, recovered, pending, unusable };
}

/**
 * 一直扫到没有 `publisher_busy` 为止，或者预算用完。
 *
 * 只对 `publisher_busy` 重试 —— 其余失败（记录不见了、身份对不上、记录损坏）
 * 不会因为多等一会儿就变好，重试只是把故障拖成沉默。
 */
export function settleEligibilityPending({
  claimsDir, outboxDir, publishLockDir, threadId,
  budgetMs = ELIGIBILITY_BUDGET_DEFAULT_MS, waitMs = 1500,
  now = () => Date.now(), wait = waitSync,
}) {
  const { last, attempts } = retryUntil({
    deadline: now() + eligibilityBudgetMs(budgetMs), waitMs, now, wait,
    attempt: () => recoverEligibilityPending({ claimsDir, outboxDir, publishLockDir, threadId }),
    retryWhen: (r) => r.ok && r.pending.some((x) => x.reason === "publisher_busy"),
  });
  return { ...last, attempts };
}

/**
 * 从一次扫描的结果里取出**某一条 claim 现在到底怎么样了**。
 *
 * watcher 原来只认 `recovered` —— 复查时若变成 event_not_found、
 * record_unclassified 或 claims_unreadable，它仍然照最初那个
 * `publisher_busy` 去报告。**报出来的原因不是真的原因，比不报还费时间。**
 */
export function eligibilityOutcomeFor(settle, key) {
  if (!settle.ok) return { ok: false, reason: settle.reason };
  const done = settle.recovered.find((r) => r.key === key);
  if (done) return { ok: true, reason: done.reason };
  const stuck = settle.pending.find((r) => r.key === key);
  if (stuck) return { ok: false, reason: stuck.reason, ...(stuck.why ? { why: stuck.why } : {}) };
  const broken = settle.unusable.find((r) => r.key === key);
  if (broken) return { ok: false, reason: "marker_unusable", why: broken.unusable };
  // 标记不在了 —— **但这是有歧义的**：可能是另一个进程先恢复成功并撤了标记。
  // 光凭"本次扫描没看到"就报失败，会让这一轮不发布、不写 completed、
  // 也不收口 Dialogue。真正的答案只能去问目标记录本身，见 settleOwnEligibility。
  return { ok: false, reason: "marker_missing" };
}

/**
 * **这一轮自己那条 claim 的资格，最终到底怎么样了。**
 *
 * 每一轮：扫一遍 → 翻译成"我这条"的结论 → 若标记不在了，**在锁下按当前
 * event/run 复核目标记录**（已 eligible / published / suppressed 都算成功，
 * 还待发就现在提上去）。
 *
 * **复核跟扫描共用同一个截止时间。**评审实测：复核只调一次
 * `markPublishEligibleByEventKey`（内部固定重试约 720ms），
 * 传 5 秒预算、锁 1.2 秒后释放，它仍在 625ms 时返回 `publisher_busy`。
 * 而这正是真实竞态本身 —— 别的恢复器撤标之后，发布器随即持锁去发。
 * 答复可能已经在发了，watcher 却不写 completed、不收口 Dialogue。
 */
export function settleOwnEligibility({
  claimsDir, outboxDir, publishLockDir, threadId, claimKey,
  budgetMs = ELIGIBILITY_BUDGET_DEFAULT_MS, waitMs = 1500,
  now = () => Date.now(), wait = waitSync,
}) {
  const once = () => {
    const sweep = recoverEligibilityPending({ claimsDir, outboxDir, publishLockDir, threadId });
    const outcome = eligibilityOutcomeFor(sweep, claimKey);
    if (outcome.reason !== "marker_missing") return outcome;
    const recheck = markPublishEligibleByEventKey({
      outboxDir, eventKey: codexReplyEventKey({ threadId, claimKey }),
      publishLockDir, requireRunId: claimKey,
    });
    if (recheck.ok) {
      return { ok: true, reason: recheck.reason ?? (recheck.changed ? "promoted" : "unchanged") };
    }
    // **why 要原样传出去。**丢掉的话，一条畸形 publish_eligible_at 最终只会
    // 显示 record_unclassified，而底层其实已经知道是哪个字段出的问题。
    return { ok: false, reason: recheck.reason ?? "marker_missing",
      ...(recheck.why ? { why: recheck.why } : {}) };
  };
  const { last } = retryUntil({
    deadline: now() + eligibilityBudgetMs(budgetMs), waitMs, now, wait,
    attempt: once,
    // 只有"锁被别人占着"值得再等。
    retryWhen: (r) => !r.ok && r.reason === "publisher_busy",
  });
  return last;
}
