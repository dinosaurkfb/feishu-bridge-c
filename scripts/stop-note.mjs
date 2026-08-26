/**
 * Stop 提示的措辞。**单独一个模块，是因为它不属于两条链路的契约。**
 *
 * 放回 stop-hook.mjs 导出也能用，但 stop-hook 在共用面里（Codex 侧会 import 它），
 * 把"提示怎么写"塞进去就是共用面警告的那种事：某一方的概念挤进了两方的契约。
 */

/**
 * 提示里怎么称呼一个项目。
 *
 * Stop 钩子挑项目有两条规则：cwd 在项目下，**或者项目路径出现在本会话的
 * transcript 里**。第二条意味着"在对话里聊到某个项目"就会被挂上那个项目 ——
 * 于是你在 A 里干活，却收到一句关于 B 的发布失败，而提示里没有任何东西
 * 表明 B 不是你正待着的那个。
 *
 * Frank 就是这么撞上的：本会话一直在讨论另一个项目的问题，每一轮 Stop 都跟着
 * 报一次那个项目的失败，看上去像是**这个**项目出了故障。
 *
 * 名字一直都有，缺的是"它不是当前这个"。
 */
export function projectLabel(project) {
  return project.id + (project?.via?.includes("cwd") ? "" : "（非当前项目）");
}

/**
 * 只有**确实出现在提示里**的非当前项目，才在末尾解释一次为什么。
 *
 * 上一版看的是"被归属到哪些项目"，而不是"实际报了哪些项目"。非当前项目的 outbox
 * 为空时它一条提示都不产生，但解释照样打出来 —— **一句解释挂在那儿，
 * 前面却没有任何被标记的东西**。评审用真实钩子实测到了这个孤儿提示。
 *
 * 解释放末尾说一次，而不是每条提示里都重复 —— 手机上卡片窄，
 * 每条都带一遍会把真正的结论挤下去。
 */
export function foreignHint(reported) {
  const foreign = (reported ?? []).filter((p) => !p?.via?.includes("cwd"));
  if (foreign.length === 0) return "";
  return " （标「非当前项目」的是因为本会话提到过它的路径，才被一起排空。）";
}

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

