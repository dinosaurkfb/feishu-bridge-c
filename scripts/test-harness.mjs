/**
 * 测试注册器 —— Claude（scripts/test.mjs）与 Codex（scripts/codex/test.mjs）两套件共用这一份。
 *
 * 由来（R59，2026-09-10 验收 R57d 发现的坑）：注册器同步调 fn() 不 await，一个
 * async 用例的断言在计数之后才跑 —— 汇总照样「通过 N / 失败 0」，AssertionError
 * 变成 unhandled rejection，只有进程退出码 1 看得出来；四方验收都只 grep 汇总行。
 *
 * 所以这里立两道闸，把 async 用例**当场响亮拒绝**（不是把注册器改成 async ——
 * 那会改变全套件的执行时序）：
 *   ① 调用前：fn 是 AsyncFunction → 点名并 exit 1（用例根本不执行）；
 *   ② 调用后：返回值是 thenable → 同样点名并 exit 1（拦「() => Promise.all(...)」这类
 *      非 async 声明却返回 promise 的写法）。
 * 任何分支带 async 用例重叠上来都会在注册那一刻红 —— 这正是想要的。
 *
 * `TEST_FILTER` —— 变异测试的**定向击杀**用（见 references/mutation-runner.mjs）。
 * 逗号分隔多个子串，测试名含任一即跑。**未设置时一个分支都不走**：全量语义是
 * 变异终检与 CI 的判据，不能被过滤器沾湿。被过滤的运行不许看起来像"全绿全量"，
 * 所以：汇总之后另起一行报命中数；"0 命中"用**退出码 2** —— 1 已被"有测试红"占了
 * （runner 把 1 读成 KILLED、把 0 读成"定向没红、升级全量"，把 2 读成"过滤器本身
 * 没挑中东西"——那是表的错，不是守卫的功劳）。
 *
 * 汇总与退出码在 printSummary 一处收口。**合同：退出码权威，汇总行是它的投影，两者不许矛盾。**
 * 打印前先形成唯一判决 verdictFailed = failed>0 || (process.exitCode??0)!==0：汇总行按判决打
 * （verdictFailed 且 failed===0 时打「通过 N / 失败 0（进程已被标记失败：exitCode=<n>）」并按失败 exit 1）。
 * 打印之后才发生的 unhandled rejection 由未处理 rejection 守卫打「汇总已作废」并 exit 1——
 * 那是合同里明说的唯一「汇总绿但 rc=1」情形。**验收除了 grep 汇总行，必须看退出码。**
 */

const isThenable = (v) => v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";

const isAsyncFunction = (fn) =>
  fn?.constructor?.name === "AsyncFunction" || Object.prototype.toString.call(fn) === "[object AsyncFunction]";

/**
 * 未处理的 rejection 兜底：Node 默认也会 exit 1，这里把原因说清 —— 多半是有人
 * 把用例写成了 async 却没从注册器那两道闸过（比如在同步用例里 fire-and-forget）。
 */
export function installUnhandledRejectionGuard() {
  process.on("unhandledRejection", (reason) => {
    console.error("\n✗ 汇总已作废（汇总后发生未处理的 rejection）——多半是 async 用例（注册器不 await，断言不会计入）：\n    " +
      String(reason?.stack ?? reason?.message ?? reason).split("\n")[0]);
    process.exit(1);
  });
}

/**
 * 造一套注册器。onFail 只管"失败怎么呈现"（两套件的呈现格式不同，留在各自那侧）：
 *   Claude —— 记进 failures 清单（汇总后统一打），TEST_TRACE=1 时当场打完整断言与栈；
 *   Codex —— 当场 console.error("FAIL …")。
 */
export function createTestHarness({ onFail = () => {} } = {}) {
  let passed = 0;
  let failed = 0;
  let registered = 0;   // 注册进来的条数（含被过滤掉的）—— 汇总里的"总 M"
  let executed = 0;     // 命中并真的跑的 —— "命中 N"
  const failures = [];
  const TEST_FILTER = (process.env.TEST_FILTER ?? "").split(",")
    .map((s) => s.trim()).filter((s) => s.length > 0);

  /**
   * 汇总打印之后就封条。之后任何 test() 调用立刻响亮失败。
   *
   * 防的是一个真实发生过、而且**报绿**的失败：把新测试追加到文件末尾，
   * 而汇总与 process.exit 在更靠前的位置 —— 那几条要么根本不执行，要么执行了
   * 但结果已经不计入统计。2026-08-23 一次追加三条，套件照报 393 通过。
   * 用运行期封条而不是"扫描源码"，因为这里断言的是效果，不是形状。
   */
  let summarySealed = false;

  function test(name, fn) {
    if (summarySealed) {
      console.error("\n✗ 测试「" + name + "」写在汇总之后 —— 它的结果不会计入统计。");
      console.error("  把它移到汇总行之前。");
      process.exit(1);
    }
    // ① 调用前：async 声明直接拒绝（用例根本不执行）。
    if (isAsyncFunction(fn)) {
      console.error("\n✗ 测试「" + name + "」是 async——注册器不 await，断言不会计入；改成同步（顶层 await import）");
      process.exit(1);
    }
    registered += 1;
    // 没命中的**不调用 fn()**：被跳过的测试不许留下副作用（夹具会往真 tmp 写东西）。
    if (TEST_FILTER.length > 0 && !TEST_FILTER.some((needle) => name.includes(needle))) return;
    executed += 1;
    let r;
    try {
      r = fn();
    } catch (err) {
      failed += 1;
      onFail(name, err, failures);
      return;
    }
    // ② 调用后：thenable 返回值同样拒绝 —— 断言此刻已经不在计数窗口里了。
    if (isThenable(r)) {
      console.error("\n✗ 测试「" + name + "」是 async——注册器不 await，断言不会计入；改成同步（顶层 await import）");
      process.exit(1);
    }
    passed += 1;
  }

  /** 汇总打印前的封条。套件尾部显式调用 —— 两套件各有一条"没有 test() 写在汇总之后"的结构检查锚在这一行。 */
  function sealSummary() {
    summarySealed = true;
  }

  /**
   * 汇总 → 断言退出码一致 → 按约定退出。逻辑只有这一份；两套件只是汇总行的
   * 措辞与失败清单的呈现不同（suiteLabel / printFailures 两个参数表达，不改行为）。
   */
  function printSummary({ suiteLabel = "", printFailures = false } = {}) {
    // 合同：退出码权威，汇总行是它的投影，两者不许矛盾。打印前先形成唯一最终判决。
    const exitNow = process.exitCode ?? 0;
    const verdictFailed = failed > 0 || exitNow !== 0;
    const failedLine = verdictFailed && failed === 0
      ? "0（进程已被标记失败：exitCode=" + exitNow + "）"
      : String(failed);
    console.log((suiteLabel === "" ? "\n" : suiteLabel + " ") +
      "通过 " + passed + " / 失败 " + failedLine + (suiteLabel === "" ? "\n" : ""));
    if (TEST_FILTER.length > 0) {
      console.log("TEST_FILTER 命中 " + executed + " / 总 " + registered
        + "（子串：" + TEST_FILTER.join(" | ") + "）—— 这不是全量，不许当全量绿");
    }
    process.exitCode = verdictFailed ? 1 : process.exitCode;
    // 汇总绿但进程被标记失败：退出码权威，按失败 exit 1（合同允许的唯一「汇总绿但 rc=1」是打印后的未处理 rejection，由守卫负责）。
    if (verdictFailed && failed === 0) process.exit(1);
    if (failed > 0) {
      if (printFailures) for (const f of failures) console.log("  ✗ " + f);
      process.exit(1);
    }
    // 0 命中走退出码 2（1 已被"有测试红"占给 mutation runner）：
    // 跑了 0 项不等于全绿，退出码 2 只说这一件事。
    if (TEST_FILTER.length > 0 && executed === 0) {
      console.log("  ✗ 一个测试名都没命中 —— 跑了 0 项不等于全绿（退出码 2 只说这一件事）");
      process.exit(2);
    }
  }

  return { test, sealSummary, printSummary, TEST_FILTER, failures };
}
