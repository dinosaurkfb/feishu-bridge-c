/**
 * 夹具基准钟（PK3-T4）—— **相对当前时间**，不是写死的日期。
 *
 * 为什么要有它：`时钟炸弹`。夹具写死 `T0 = 2026-09-11T09:00:00Z`，而被测代码里有**相对 TTL**
 * （reaffirm handle 7 天 / 稳态 handle 30 天）。写的那天一切正常 —— 到期那天，凡是"注入钟签发、
 * 真实钟校验"的用例集体变红，而且看起来跟任何代码改动都无关（2026-09-18T09:00Z 起 main 全量恒红 10 条，
 * reason 形如 reaffirm_intent_expired / intent_cleanup_unclean / selection_plan_context_missing）。
 *
 * 规矩：**基准钟只能是相对量**（`fixtureNow()`），派生的绝对时刻也只能由它算出来（`isoAt(T0 + TTL)`）。
 * 过期分支照旧用相对量表达（`T0B + TTL + 1`），所以「签发 → 校验」的相对关系不随真实日期漂移。
 */
/** 当前时间对齐到整秒（毫秒噪声会让 ISO 断言难读，也避免同一毫秒内的比较歧义）。 */
export const fixtureNow = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000) * 1000;

/** 毫秒 → 规范 ISO（夹具里派生的绝对时刻都走它）。 */
export const isoAt = (ms) => new Date(ms).toISOString();

/**
 * 基准钟名字表：这些名字一旦出现，右值就必须是相对量。
 * 为什么按名字：它们在 test.mjs 里就是"这一段的 now"，而每段都跟 `*_TTL_MS` 配对用。
 */
/**
 * 运行时不变量（PK3-T4-fix1，替代原来的源码正则扫描——正则会误报注释/字符串、漏报等价写法）：
 * 夹具的基准钟必须"就在当下"。写死一个日期再配相对 TTL，就是到期那天全红的时钟炸弹；
 * 这里在夹具**取值那一刻**断言它离 Date.now() 不超过 maxSkewMs，字面量日期会在写下当天就红。
 * 接受毫秒数或 ISO 字符串，返回毫秒数。
 */
export const FIXTURE_CLOCK_MAX_SKEW_MS = 60 * 60 * 1000;
export function assertFreshFixtureClock(value, { now = Date.now(), maxSkewMs = FIXTURE_CLOCK_MAX_SKEW_MS, label = "基准钟" } = {}) {
  const t = typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(t)) throw new Error(label + " 不是时间：" + String(value));
  const skew = now - t;
  if (skew > maxSkewMs || skew < -maxSkewMs) {
    throw new Error(label + " 离现在 " + Math.round(skew / 60000) + " 分钟（上限 " + Math.round(maxSkewMs / 60000) + " 分钟）：" +
      "夹具时钟必须是相对量（fixtureNow()）；写死日期配相对 TTL 就是时钟炸弹");
  }
  return t;
}
