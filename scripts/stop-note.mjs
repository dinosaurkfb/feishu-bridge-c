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
 * 只有确实带上了非当前项目时，才在末尾解释一次为什么。
 *
 * 解释放在末尾说一次，而不是每条提示里都重复 —— 手机上卡片窄，
 * 每条都带一遍会把真正的结论挤下去。
 */
export function foreignHint(attributed) {
  const foreign = (attributed ?? []).filter((p) => !p?.via?.includes("cwd"));
  if (foreign.length === 0) return "";
  return " （标「非当前项目」的是因为本会话提到过它的路径，才被一起排空。）";
}

