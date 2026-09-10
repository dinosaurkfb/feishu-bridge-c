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

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isThenable = (v) => v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";

const isAsyncFunction = (fn) =>
  fn?.constructor?.name === "AsyncFunction" || Object.prototype.toString.call(fn) === "[object AsyncFunction]";

/**
 * **套件级不变量**（R60 返修一 P1-2）：由 installTestHomeIsolation 装进来，注册器在每个用例之后核。
 * 边界是**环境**：机器路径 env 是套件绊线（不是"原来没设才设"），用例要么别动，要么 finally 恢复。
 *   envDrift() → null | 问题短句   （用例改了 env 且没恢复）
 *   restore()  → 把 env 恢复成套件默认值（点名之后也要恢复，否则污染后面的用例）
 *   treeProblem() → null | 问题短句（汇总前核绊线目录树与套件开始时一致）
 */
let suiteInvariants = null;
export function setSuiteInvariants(inv) { const prev = suiteInvariants; suiteInvariants = inv; return prev; }

/** 绊线目录树漂移判定：比对路径、类型、大小、mode 与小文件内容 sha */
export function treeDriftProblem(before, after) {
  const norm = (item) => {
    if (typeof item === "string") return { path: item };
    return item;
  };
  const bList = (before ?? []).map(norm);
  const aList = (after ?? []).map(norm);
  const bMap = new Map(bList.map((x) => [x.path, x]));
  const aMap = new Map(aList.map((x) => [x.path, x]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const [p, aItem] of aMap.entries()) {
    const bItem = bMap.get(p);
    if (!bItem) {
      added.push(p);
    } else {
      // R60 返修二 P2：比对「路径 + 类型 + 大小 + mode（+ 小文件内容 sha）」
      const typeMismatch = aItem.type !== undefined && bItem.type !== undefined && aItem.type !== bItem.type;
      const sizeMismatch = aItem.size !== undefined && bItem.size !== undefined && aItem.size !== bItem.size;
      const modeMismatch = aItem.mode !== undefined && bItem.mode !== undefined && aItem.mode !== bItem.mode;
      const shaMismatch = aItem.sha !== null && bItem.sha !== null && aItem.sha !== undefined && bItem.sha !== undefined && aItem.sha !== bItem.sha;
      if (typeMismatch || sizeMismatch || modeMismatch || shaMismatch) {
        modified.push(p);
      }
    }
  }
  for (const p of bMap.keys()) {
    if (!aMap.has(p)) removed.push(p);
  }

  if (added.length === 0 && removed.length === 0 && modified.length === 0) return null;
  const parts = [];
  if (added.length > 0) parts.push("新增 " + added.slice(0, 5).join("、"));
  if (removed.length > 0) parts.push("消失 " + removed.slice(0, 5).join("、"));
  if (modified.length > 0) parts.push("变更 " + modified.slice(0, 5).join("、"));
  return "套件绊线目录树与套件开始时不一致（" + parts.join("；") + "）";
}

/**
 * 未处理的 rejection 兜底：Node 默认也会 exit 1，这里把原因说清 —— 多半是有人
 * 把用例写成了 async 却没从注册器那两道闸过（比如在同步用例里 fire-and-forget）。
 */
/**
 * R60：套件级 HOME 隔离 + 真家目录桥配置树写守卫 + 账本根 tripwire。
 *
 * 事实：真机 ~/.claude/feishu-bridge/ledger/ 下出现过测试夹具形状的 endpoint 空目录 ——
 * 账本根由 topic-agent-ledger 的 ledgerRoot 解析：**优先 FEISHU_BRIDGE_LEDGER_DIR，
 * 否则 os.userInfo().homedir（passwd 家目录，绕过 $HOME）**——所以仅移 HOME 护不住账本根，
 * 没带 env 的用例就会把账本根写进真 HOME。
 *
 * 做法（三件套，套件启动时、第一条 test 之前调一次）：
 *   ① 把 process.env.HOME 指到套件私有的 mkdtemp —— 子进程继承、进程内 HOME 派生全部落到临时目录；
 *      原值在改之前记下（不用 os.homedir()——它随 $HOME 走，改后就不是原值了）。
 *   ② 给 FEISHU_BRIDGE_LEDGER_DIR / FEISHU_CODEX_BRIDGE_HOME 设**套件级默认值**（tripwire，
 *      套件 HOME 下的私有目录）：没用例级隔离的账本调用全部落到这里，而不是真家目录；
 *      用例自己设置并恢复的照常生效（恢复模式是「保存了就回写」，回到 tripwire）。
 *   ③ 包装 fs.mkdirSync：落在「原 HOME」桥配置树里的建目录当场抛（真家不可写）；
 *      落在 tripwire 里的建目录也抛，并带**当前用例名** —— 泄漏源当场红、当场点名。
 *
 * 返回 realHome() / suiteHome() 给行为钉用例用（故意把 HOME 指回真家目录调建根原语 → 被拒）。
 */
let activeTestName = null;
export function installTestHomeIsolation({ env = process.env, passwdHome = null, registerInvariants = true } = {}) {
  const originalEnvHome = env.HOME || ""; // 原值：改 HOME 之前记下
  // R60 返修一 P1-1：passwd home（os.userInfo().homedir）**也**要守 —— 账本根解析绕过 $HOME 走这条信息源。
  //   可注入：反向探针一律用双临时 home 夹具，绝不拿真 passwd home 做实验。
  const pwHome = passwdHome ?? os.userInfo().homedir;
  const suiteHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-suite-home-")));
  env.HOME = suiteHome;
  const rawMkdir = fs.mkdirSync;
  // 机器路径 env：**无条件**指向套件绊线（R60 返修一 P1-2）。旧版"原来没设才设"——
  // ambient 一旦指到真家目录就整条绕过守卫；而且 mkdirSync 包装既不覆盖子进程也不覆盖
  // symlinkSync/openSync/writeFileSync，真正能当边界的是**环境**。
  // 用例要自定义就自己 mkdtemp 并在 finally 恢复（注册器每测后核这三件事）。
  const tripwire = {
    ledger: path.join(suiteHome, "tripwire-ledger"),
    maintenance: path.join(suiteHome, "tripwire-maintenance"),
    // FEISHU_BRIDGE_MAINTENANCE_GATE 是**文件路径**（gate symlink 本身），不是目录 —— 放进维护目录里。
    gate: path.join(suiteHome, "tripwire-maintenance", "maintenance.gate"),
    codexHome: path.join(suiteHome, "tripwire-codex-bridge"),
    installedSurface: path.join(suiteHome, "tripwire-installed-surface.json"),
    installSurfaceLock: path.join(suiteHome, "tripwire-install-surface.lock"),
  };
  rawMkdir(tripwire.ledger, { recursive: true, mode: 0o700 });
  rawMkdir(tripwire.maintenance, { recursive: true, mode: 0o700 });
  rawMkdir(tripwire.codexHome, { recursive: true, mode: 0o700 });

  // R60 返修三 P1：三个绊线根（ledger / maintenance / codex bridge home）本身纳入不可变基线
  // 安装守卫时记录各根的 lstat 身份（非 symlink 的普通目录、mode、dev+ino、realpath）
  const tripwireRoots = [tripwire.ledger, tripwire.maintenance, tripwire.codexHome];
  const inspectRootIdentity = (root) => {
    let st;
    try {
      st = fs.lstatSync(root);
    } catch (err) {
      if (err?.code === "ENOENT") return { ok: false, root, problem: "绊线根缺席（被删）：" + root };
      return { ok: false, root, problem: "绊线根 lstat 异常（" + String(err?.code ?? err?.message ?? err) + "）：" + root };
    }
    if (st.isSymbolicLink()) return { ok: false, root, problem: "绊线根被换成 symlink：" + root };
    if (!st.isDirectory()) return { ok: false, root, problem: "绊线根不是普通目录：" + root };
    let real;
    try {
      real = fs.realpathSync(root);
    } catch (err) {
      return { ok: false, root, problem: "绊线根 realpath 异常（" + String(err?.code ?? err?.message ?? err) + "）：" + root };
    }
    return {
      ok: true,
      root,
      type: "dir",
      mode: st.mode & 0o7777,
      dev: st.dev,
      ino: st.ino,
      real,
    };
  };

  const rootBaselines = new Map();
  for (const r of tripwireRoots) {
    const info = inspectRootIdentity(r);
    if (!info.ok) throw new Error("无法初始化绊线根基线：" + info.problem);
    rootBaselines.set(r, info);
  }

  const verifyRootIdentity = (root) => {
    const base = rootBaselines.get(root);
    if (!base) return "未知绊线根：" + root;
    let st;
    try {
      st = fs.lstatSync(root);
    } catch (err) {
      if (err?.code === "ENOENT") return "绊线根缺席（被删）：" + root;
      return "绊线根 lstat 异常（" + String(err?.code ?? err?.message ?? err) + "）：" + root;
    }
    if (st.isSymbolicLink()) return "绊线根被换成 symlink：" + root;
    if (!st.isDirectory()) return "绊线根不是普通目录：" + root;
    if (st.dev !== base.dev || st.ino !== base.ino) {
      return "绊线根 dev/ino 发生变化（原 " + base.dev + ":" + base.ino + "，现 " + st.dev + ":" + st.ino + "）：" + root;
    }
    const currentMode = st.mode & 0o7777;
    if (currentMode !== base.mode) {
      return "绊线根 mode 发生变化（原 0" + base.mode.toString(8) + "，现 0" + currentMode.toString(8) + "）：" + root;
    }
    let real;
    try {
      real = fs.realpathSync(root);
    } catch (err) {
      return "绊线根 realpath 异常（" + String(err?.code ?? err?.message ?? err) + "）：" + root;
    }
    if (real !== base.real) {
      return "绊线根 realpath 发生变化（原 " + base.real + "，现 " + real + "）：" + root;
    }
    return null;
  };

  const checkAllRoots = () => {
    const problems = [];
    for (const r of tripwireRoots) {
      const p = verifyRootIdentity(r);
      if (p) problems.push(p);
    }
    return problems.length > 0 ? problems.join("；") : null;
  };
  // 无条件覆盖的是**绕过 $HOME 的那四条**：账本根 / 维护目录 / 门 / Codex 桥根 —— 它们的默认派生都走
  //   os.userInfo().homedir（passwd home），只移 $HOME 护不住。安装面（FEISHU_BRIDGE_INSTALLED_SURFACE /
  //   ..._INSTALL_SURFACE_LOCK）**不**在这里无条件覆盖：它是"这台机器上装着什么"的**事实**，测试要靠它
  //   与当前 runtime 自洽（无条件指到一个不存在的绊线会让 30+ 条安装器/启动源用例把"事实缺席"当成故障）；
  //   它的默认派生走 HOME/realUserHome 两者，$HOME 已移到套件私有目录 + passwd home 进 guardedRoots，
  //   所以真家目录那条路仍然关着。用例要自定义就自己 mkdtemp 并在 finally 恢复（注册器会核）。
  const machineEnv = Object.freeze({
    FEISHU_BRIDGE_LEDGER_DIR: tripwire.ledger,
    FEISHU_BRIDGE_MAINTENANCE_DIR: tripwire.maintenance,
    FEISHU_BRIDGE_MAINTENANCE_GATE: tripwire.gate,
    FEISHU_CODEX_BRIDGE_HOME: tripwire.codexHome,
  });
  for (const [name, value] of Object.entries(machineEnv)) env[name] = value;
  const guardedRoots = [
    originalEnvHome && path.join(originalEnvHome, ".claude", "feishu-bridge"),
    originalEnvHome && path.join(originalEnvHome, ".codex", "feishu-bridge"),
    pwHome && path.join(pwHome, ".claude", "feishu-bridge"),
    pwHome && path.join(pwHome, ".codex", "feishu-bridge"),
    path.join(suiteHome, ".claude", "feishu-bridge"),
    path.join(suiteHome, ".codex", "feishu-bridge"),
  ].filter(Boolean);
  // **进程内诊断**（不是安全证明）：它只覆盖本进程直接调 fs.mkdirSync 的那条路 ——
  //   不覆盖子进程，也不覆盖 symlinkSync / openSync / writeFileSync。边界是上面那组 env。
  fs.mkdirSync = (p, opts) => {
    const abs = path.resolve(String(p ?? ""));
    const hit = guardedRoots.find((root) => abs === root || abs.startsWith(root + path.sep));
    if (hit) {
      throw new Error("test-home-isolation：测试试图在「" + hit + "」下建目录（" + abs + "）——" +
        "真家目录的桥配置树不许被测试写（R60 泄漏）。隔离做法：每测 mkdtemp 当 HOME，或显式 FEISHU_BRIDGE_LEDGER_DIR / FEISHU_BRIDGE_MAINTENANCE_DIR。");
    }
    const trip = [tripwire.ledger, tripwire.maintenance, tripwire.codexHome]
      .find((root) => abs === root || abs.startsWith(root + path.sep));
    if (trip) {
      // tripwire 里只有「套件根目录本身」的初建是合法的（上面那几次）；此后任何建目录都是泄漏。
      if (abs !== trip) {
        throw new Error("test-home-isolation：用例「" + (activeTestName ?? "?") + "」往绊线（" + trip +
          "）下建目录（" + abs + "）—— 该用例没做隔离（R60 泄漏源）。隔离做法：显式 FEISHU_BRIDGE_LEDGER_DIR 指向用例自己的 mkdtemp。");
      }
    }
    return rawMkdir(p, opts);
  };
  // 绊线树快照（汇总前核）：只盘绊线根，不盘套件 HOME 全体（临时产物本就该在套件 HOME 下）
  // R60 返修二 P2：快照包含路径、类型、大小、mode 与小文件 sha 内容
  // R60 返修三 P1：快照前先核根身份；根身份不符时绝不遍历其子项（fail-closed）
  const snapshotTree = () => {
    const roots = tripwireRoots;
    const out = [];
    const walk = (d) => {
      let names = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const n of names) {
        const full = path.join(d, n);
        let st = null;
        try { st = fs.lstatSync(full); } catch { continue; }
        const item = {
          path: path.relative(suiteHome, full),
          type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
          size: st.size,
          mode: st.mode & 0o7777,
          sha: null,
        };
        if (st.isFile() && st.size <= 1024 * 1024) {
          try {
            item.sha = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
          } catch {
            item.sha = null;
          }
        }
        out.push(item);
        if (st.isDirectory()) walk(full);
      }
    };
    for (const r of roots) {
      const prob = verifyRootIdentity(r);
      if (prob) {
        out.push({
          path: path.relative(suiteHome, r),
          type: "corrupted_root",
          problem: prob,
        });
        continue;
      }
      walk(r);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };
  const before = snapshotTree();
  const rawRm = fs.rmSync;
  // 清绊线（套件自己的 scratch）：每条用例之后把上一轮留下的制品清掉 —— 否则下一条用例看到的是
  // 别人的 maintenance 收据 / ledger 记录（那会让 67 条真入口用例级联失败），而 suite 的语义是
  // 「绊线默认值是干净的」。现场先点名再清（诊断不丢）。
  // R60 返修三 P1：清理前先核根身份；根身份不符时绝不遍历或清理其子项（零删除）
  const cleanTree = () => {
    for (const root of tripwireRoots) {
      const prob = verifyRootIdentity(root);
      if (prob) {
        continue; // 根身份不符时跳过：绝不遍历或删除
      }
      let names = [];
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const n of names) {
        try { rawRm(path.join(root, n), { recursive: true, force: true }); } catch { /* 清不掉就留给 treeProblem 点名 */ }
      }
    }
  };
  if (registerInvariants) {
    setSuiteInvariants({
      envDrift: () => {
        // R60 返修二 P1-2b：HOME === suiteHome 纳入每测不变量。
        // 注释：Node.js 在 POSIX 环境下 os.homedir() 随 process.env.HOME 走（并非只在启动时采样一次），
        // 故 HOME 漂移会导致进程内所有基于 os.homedir() 的派生路径一同漂移。
        const all = { HOME: suiteHome, ...machineEnv };
        const drifted = Object.entries(all).filter(([name, value]) => env[name] !== value);
        if (drifted.length === 0) return null;
        return "改了套件机器路径 env/HOME 且没恢复：" + drifted.map(([name, value]) => name + "=" + String(env[name]) + "（应为 " + value + "）").join("、");
      },
      restore: () => {
        env.HOME = suiteHome;
        for (const [name, value] of Object.entries(machineEnv)) env[name] = value;
      },
      treeProblem: () => {
        const rootProb = checkAllRoots();
        if (rootProb) return "套件绊线根身份被破坏（" + rootProb + "）";
        return treeDriftProblem(before, snapshotTree());
      },
      cleanTree,
    });
  }
  return {
    realHome: () => originalEnvHome,
    suiteHome: () => suiteHome,
    passwdHome: () => pwHome,
    machineEnv: () => machineEnv,
    tripwire: () => tripwire,
    checkRoots: () => checkAllRoots(),
    verifyRoot: (r) => verifyRootIdentity(r),
    cleanTree: () => cleanTree(),
    snapshotTree: () => snapshotTree(),
  };
}

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
export function createTestHarness({ onFail = () => {}, filter = null } = {}) {
  let passed = 0;
  let failed = 0;
  let registered = 0;   // 注册进来的条数（含被过滤掉的）—— 汇总里的"总 M"
  let executed = 0;     // 命中并真的跑的 —— "命中 N"
  const failures = [];
  const failedEnvDrift = [];
  // R60 返修二 P1-2c：支持显式传 filter（如 filter: [] 关闭过滤），不被外部 process.env.TEST_FILTER 污染内层用例
  const TEST_FILTER = filter !== null
    ? (Array.isArray(filter) ? filter : String(filter).split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
    : (process.env.TEST_FILTER ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

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
    // R60：tripwire 守卫要点名泄漏源 —— 记录当前正在跑的用例名（finally 清掉，异步逃逸的不背）。
    activeTestName = name;
    let r;
    let threw = false;
    let testErr = null;
    try {
      r = fn();
    } catch (err) {
      threw = true;
      testErr = err;
    } finally {
      activeTestName = null;
      // R60 返修二 P1-2a：核验、恢复、cleanTree 覆盖成功与抛错两路，放进 finally
      const drift = suiteInvariants && typeof suiteInvariants.envDrift === "function" ? suiteInvariants.envDrift() : null;
      const treeHit = suiteInvariants && typeof suiteInvariants.treeProblem === "function" ? suiteInvariants.treeProblem() : null;
      const invariantProblem = drift ?? treeHit;
      if (invariantProblem) {
        failedEnvDrift.push(name);
        if (suiteInvariants && typeof suiteInvariants.restore === "function") suiteInvariants.restore();
        if (suiteInvariants && typeof suiteInvariants.cleanTree === "function") suiteInvariants.cleanTree(); // 先点名再清：不让它级联污染后面的用例
      } else {
        if (suiteInvariants && typeof suiteInvariants.cleanTree === "function") suiteInvariants.cleanTree();
      }

      if (threw) {
        failed += 1;
        const errToReport = invariantProblem
          ? new Error(String(testErr?.message ?? testErr) + "；且套件环境边界被破坏（R60 P1-2）：" + invariantProblem + "；隔离做法：用例自己 mkdtemp 指过去、finally 恢复/清理")
          : testErr;
        onFail(name, errToReport, failures);
      } else {
        // ② 调用后：thenable 返回值同样拒绝 —— 断言此刻已经不在计数窗口里了。
        if (isThenable(r)) {
          console.error("\n✗ 测试「" + name + "」是 async——注册器不 await，断言不会计入；改成同步（顶层 await import）");
          process.exit(1);
        }
        if (invariantProblem) {
          failed += 1;
          onFail(name, new Error("套件环境边界被破坏（R60 P1-2）：" + invariantProblem + "；隔离做法：用例自己 mkdtemp 指过去、finally 恢复/清理"), failures);
        } else {
          passed += 1;
        }
      }
    }
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
    // R60 返修一 P1-2：汇总前核绊线目录树与套件开始时一致（有新增制品 → 点名并标记失败）。
    const treeProblem = suiteInvariants && typeof suiteInvariants.treeProblem === "function" ? suiteInvariants.treeProblem() : null;
    if (treeProblem) {
      console.error("\n✗ " + treeProblem + " —— 有测试往绊线里写了东西（R60 泄漏源），点名不了具体用例就整批停在这里");
      process.exitCode = 1;
    }
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

  return { test, sealSummary, printSummary, TEST_FILTER, failures, failedEnvDrift };
}
