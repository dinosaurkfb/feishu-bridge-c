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
 * 不信标记自报的那个；命中的记录还必须 `run_id === claim_key`。
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

/** 同步等一小会儿 —— 这条链上的函数都是同步契约，不能改成 async。 */
function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    if (doc.schema_version !== "1.0") { bad("schema_version 不认识"); continue; }
    // 文件名与内容必须自洽 —— 否则一张错配的标记能替另一条事件要资格。
    if (doc.claim_key !== key) { bad("claim_key 跟文件名对不上"); continue; }
    if (doc.state !== "eligibility_pending") { bad("state 不是 eligibility_pending"); continue; }
    if (!isCanonicalIso(doc.recorded_at)) { bad("recorded_at 不是规范时间"); continue; }
    // 只有"这一轮确实跑完了"才谈得上发布资格。
    if (doc.run_state !== "completed") { bad("run_state 不是 completed"); continue; }
    if (typeof threadId !== "string" || !threadId) { bad("不知道属于哪条 thread，无法自己算事件键"); continue; }
    // **事件键自己算。**标记自带的那个只用来对账：对不上说明这张标记被改过。
    const eventKey = codexReplyEventKey({ threadId, claimKey: key });
    if (doc.event_key !== undefined && doc.event_key !== eventKey) {
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
    if (!r.ok) { pending.push({ ...item, reason: r.reason }); continue; }
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
 * **只在 watcher 自己刚写下标记之后用。**光靠"下一个 watcher 启动时扫一遍"不够：
 * 那要等到下一条入站消息才会发生，中间这条答复一直卡着。
 * 竞争方持锁做真实网络发布可达 12 秒，所以预算要盖得住它。
 *
 * 只对 `publisher_busy` 重试 —— 其余失败（记录不见了、身份对不上、记录损坏）
 * 不会因为多等一会儿就变好，重试只是把故障拖成沉默。
 */
export function settleEligibilityPending({
  claimsDir, outboxDir, publishLockDir, threadId,
  budgetMs = 60_000, waitMs = 1500, now = () => Date.now(), wait = waitSync,
}) {
  const deadline = now() + budgetMs;
  let last = recoverEligibilityPending({ claimsDir, outboxDir, publishLockDir, threadId });
  let attempts = 1;
  while (last.ok && last.pending.some((p) => p.reason === "publisher_busy") && now() < deadline) {
    wait(waitMs);
    last = recoverEligibilityPending({ claimsDir, outboxDir, publishLockDir, threadId });
    attempts += 1;
  }
  return { ...last, attempts };
}
