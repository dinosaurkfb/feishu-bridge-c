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

import { markPublishEligibleByEventKey } from "./outbox.mjs";

const SUFFIX = ".eligibility_pending.json";

/**
 * 列出所有待恢复标记。**结构不对的也列出来**，标成 unusable ——
 * 静默跳过会让"有 3 条卡住"看起来像"一条都没有"。
 */
export function listEligibilityPending({ claimsDir }) {
  let names;
  try { names = fs.readdirSync(claimsDir).filter((f) => f.endsWith(SUFFIX)).sort(); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(claimsDir, name);
    const key = name.slice(0, -SUFFIX.length);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); }
    catch { out.push({ file, key, unusable: "读不出来" }); continue; }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      out.push({ file, key, unusable: "不是记录对象" }); continue;
    }
    // 文件名与内容必须自洽 —— 否则一张错配的标记能替另一条事件要资格。
    if (doc.claim_key !== key) { out.push({ file, key, unusable: "claim_key 跟文件名对不上" }); continue; }
    if (doc.state !== "eligibility_pending") { out.push({ file, key, unusable: "state 不是 eligibility_pending" }); continue; }
    const eventKey = doc.event_key;
    if (typeof eventKey !== "string" || !eventKey.trim()) {
      out.push({ file, key, unusable: "缺 event_key，无法定位要提升哪条" }); continue;
    }
    out.push({ file, key, eventKey });
  }
  return out;
}

/**
 * 逐条重试资格提升。**不持锁调用。**
 *
 * @returns {{recovered:object[], pending:object[], unusable:object[]}}
 */
export function recoverEligibilityPending({ claimsDir, outboxDir, publishLockDir }) {
  const recovered = [];
  const pending = [];
  const unusable = [];
  for (const item of listEligibilityPending({ claimsDir })) {
    if (item.unusable) { unusable.push(item); continue; }
    const r = markPublishEligibleByEventKey({
      outboxDir, eventKey: item.eventKey, publishLockDir });
    if (!r.ok) { pending.push({ ...item, reason: r.reason }); continue; }
    // 有结论了 —— 标记可以撤了。删不掉不算失败：下一轮会再走一遍，
    // 而重复提升是幂等的（already_eligible）。
    try { fs.unlinkSync(item.file); } catch { /* 下轮再说 */ }
    recovered.push({ ...item, reason: r.reason ?? (r.changed ? "promoted" : "unchanged") });
  }
  return { recovered, pending, unusable };
}
