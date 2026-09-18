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
export const FIXTURE_BASE_CLOCKS = Object.freeze(["T0", "T0B", "T0C", "T0D", "T052", "ISO0", "ISO0B"]);

/**
 * 找出源码里的**时钟炸弹形状**（纯函数，注入源码文本，便于守卫用例逐字钉正反例）：
 *   ① 基准钟被赋成写死日期（`const T0B = Date.parse("2026-…")` / `= "2026-…"`）；
 *   ② 注入的钟指向写死日期（`clock: () => Date.parse("2026-…")`）—— 签发用固定日期、
 *      校验读真实时钟，且两者相差一个 TTL 时必炸。
 * 只认这两种形状：**不**扫普通的时间戳字面量（`created_at: "2026-…"` 之类的惰性夹具值不炸，
 * 收窄判据是为了不误报 —— 见 PI-REPORT 里"只列不改"那一节）。
 */
export function fixtureClockProblem(src) {
  const problems = [];
  const text = String(src ?? "");
  for (const name of FIXTURE_BASE_CLOCKS) {
    const re = new RegExp("(?:const|let|var)\\s+" + name + "\\s*=\\s*([^;\\n]+)", "gu");
    for (const m of text.matchAll(re)) {
      const rhs = m[1].trim();
      const literal = /^["'`]?\d{4}-\d\d-\d\dT/u.test(rhs) || /^Date\.parse\(\s*["'`]\d{4}-/u.test(rhs);
      if (literal) problems.push({ kind: "literal_base_clock", name, rhs });
    }
  }
  for (const m of text.matchAll(/clock:\s*\(\)\s*=>\s*Date\.parse\(\s*["'`]\d{4}-\d\d-\d\dT[^"'`]*["'`]\s*\)/gu)) {
    problems.push({ kind: "literal_injected_clock", snippet: m[0] });
  }
  return problems;
}

/** 守卫用例打印用的一行。 */
export const formatFixtureClockProblem = (p) =>
  p.kind === "literal_base_clock"
    ? "基准钟 " + p.name + " 被赋成写死日期：" + p.rhs + "（改成 fixtureNow() / isoAt(T0 + TTL)）"
    : "注入的钟指向写死日期：" + p.snippet + "（改成 clock: () => fixtureNow()，过期分支用相对量表达）";
