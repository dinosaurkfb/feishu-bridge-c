/**
 * 发布事务结果的**中性措辞**。
 *
 * 单独成模块：它属于发布结果本身，两条链路（Claude / Codex）的入口
 * 都消费 —— 放在 stop-note（Claude 提示措辞）里会让 Codex 直接 import
 * 一个自称"不属于两条链路契约"的模块（评审点名）。
 */

/**
 * 两类发布后异常的组合措辞。**同时发生就同时说** —— 单独渲染任何一类
 * 都会把另一类吞掉（评审在 published 和 partial 两个分支各抓到一次）。
 * 返回以"；"开头的追加片段；两类都没有时为空串。
 */
export function postDeliveryBits(r) {
  const bits = [];
  if ((r.deliveredUnrecorded ?? []).length > 0) {
    bits.push(r.deliveredUnrecorded.length + " 条**送达后没落标、下一轮可能重发**（先去话题核对）");
  }
  if ((r.bookkeepingFailures ?? []).length > 0) {
    bits.push(r.bookkeepingFailures.length + " 处发布后记账失败（已送达不重发，轮转账可能缺）");
  }
  return bits.length === 0 ? "" : "；" + bits.join("；");
}
