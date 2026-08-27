/**
 * 资格恢复链的**共用部分：有界预算解析**。
 *
 * 恢复消费者本体（恢复标记验真、扫描、结算）是 Codex 概念 —— claims 目录、
 * codexReplyEventKey、run 复合凭据 —— 住在 scripts/codex/eligibility-recovery.mjs。
 * 它曾整个住在这里，第 5 层要它在授权前验 run 复合凭据（codex/handoff.mjs），
 * 而共用层不许反向依赖适配层（"Claude 不依赖 scripts/codex/" 守卫），
 * 所以按概念归属拆开：这里只剩两条链路都用的预算判据。
 */

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

/**
 * 通用的有界预算解析。**判据只有这一份** —— watcher 的发布等待预算
 * 与资格恢复预算共用同一套"有限安全整数、非负、封顶、不合规回落默认"。
 */
export function boundedBudgetMs(raw, { def, max }) {
  const n = typeof raw === "string" ? (/^\d{1,9}$/u.test(raw) ? Number(raw) : NaN) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return def;
  return Math.min(n, max);
}

export function eligibilityBudgetMs(raw) {
  return boundedBudgetMs(raw, {
    def: ELIGIBILITY_BUDGET_DEFAULT_MS, max: ELIGIBILITY_BUDGET_MAX_MS });
}
