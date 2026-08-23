/**
 * 制品里时间字段的唯一书写形式，以及把任意输入折算成它的工具。
 *
 * 为什么单独成模块：同一条策略先后在 shadow readiness 与 chat scope attestation 两处需要，
 * 而这类"两边各写一遍"正是本仓库刚付出代价修掉的那类缺陷 —— 一处收紧、另一处没跟上，
 * 制品就会在边界上与 JSON Schema 分歧。策略只写一遍，schema 的 `pattern` 直接引用
 * `CANONICAL_TIME_PATTERN`，两边就不可能各自漂移。
 *
 * 边界按 **RFC3339 四位年份**卡，不是 ECMAScript 的 ±8.64e15。两者的差别是一处真实缺陷的
 * 来源：`new Date(2.6e14).toISOString()` 产出 `+010209-01-27T06:13:20.000Z`，六位年份，
 * 能被 `Date.parse` 往返却不是合法 RFC3339，schema 不收。只按 ±8.64e15 放行，
 * 运行时就会产出自己 schema 校验不过的制品。
 */

/** UTC、毫秒、`Z` 结尾。制品 schema 的 `pattern` 必须逐字引用它。 */
export const CANONICAL_TIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

const TIME_RE = new RegExp(CANONICAL_TIME_PATTERN, "u");

export const MIN_CANONICAL_MS = -62167219200000;  // 0000-01-01T00:00:00.000Z
export const MAX_CANONICAL_MS = 253402300799999;  // 9999-12-31T23:59:59.999Z

/**
 * 把 number / Date / 字符串折算成毫秒。
 *
 * Date 分支不能少：`Date.parse(dateObject)` 会先 `toString()`，而那个格式**没有毫秒**，
 * 于是一个 Date 入参会被静默截断到整秒（…123 → …000）。
 */
export const toCanonicalMs = (value) => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(value ?? "");
};

/** 能不能安全写成规范形式。越界的既包括让 `toISOString()` 抛的，也包括会产出六位年份的。 */
export const isCanonicalMs = (ms) =>
  Number.isFinite(ms) && ms >= MIN_CANONICAL_MS && ms <= MAX_CANONICAL_MS;

/** 只在 `isCanonicalMs` 为真时调用；否则那是一次抛异常，不是一个判定。 */
export const canonicalIso = (ms) => new Date(ms).toISOString();

/**
 * 是不是规范形式：先过正则，再要求 `toISOString()` 往返相等。
 *
 * 两道都要。正则挡形状不对的（`+08:00` 偏移、六位年份、缺毫秒）；往返相等挡形状对、
 * 但日期不存在的（`2026-02-30T00:00:00.000Z` 正则过得了，往返回来却不是原串）。
 */
export const isCanonicalIso = (value) =>
  typeof value === "string" && TIME_RE.test(value) &&
  isCanonicalMs(Date.parse(value)) && canonicalIso(Date.parse(value)) === value;
