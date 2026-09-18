/**
 * 套件私有的临时目录根（PK3-T1）。
 *
 * 放在 `scripts/test-support/` 而不是 `test-harness.mjs`：后者是**共用模块**（`scripts/codex/*.mjs`
 * 直接 import 它，面被 `references/shared-surface.json` 快照盯着），往里加导出会改共用面；
 * 而这一节只服务测试面。注册器仍然用它（`currentSuiteTempRoot()`），只是不从 test-harness 再导出一次。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { humanBytes } from "./write-diagnosis.mjs";

// ── PK3-T1：套件的临时目录根 + 残留回收 ────────────────────────────────────────────────
/**
 * 本轮套件私有的 TMPDIR 根。**这一节只服务测试面**（不改产品语义：产品不读 TMPDIR 根、不认这些名字）。
 *
 * 为什么要有它：夹具到处 `mkdtemp(os.tmpdir())`，一轮全量在 omm 的 3.9G tmpfs 上留下
 * ~426MB / 1142 个目录（Mac 实测，见 PI-REPORT）。两天几轮就把 tmpfs 撑到 80%，而**盘满之后
 * `writeFileSync` 抛的是 `UNKNOWN: unknown error`** —— 看起来像用例逻辑坏了或 node 的 bug。
 *
 * 做法：把 `TMPDIR` 指到本轮私有的一棵树（名字带 pid + 随机串），
 *   · 每条用例结束时回收**该用例新造**的顶层条目（用例自己收尾，不给盘上堆着）；
 *   · 汇总时把整棵树清掉并在汇总里打印「清理残留 N 个 / M MB」，仍留下的按名列出；
 *   · 进程退出时还有一道兜底（走 process.exit 的路径也清）。
 * **只清这一棵**：不扫前缀、不按名字猜 —— 所以不可能误删别的进程 / 别的轮次的产物。
 */
let suiteTempRoot = null;   // installSuiteTempRoot() 设置；createTestHarness 通过 currentSuiteTempRoot() 读它

/** 给注册器（test-harness）读：本轮临时根；没装 → null。 */
export const currentSuiteTempRoot = () => suiteTempRoot;

/** 目录树：顶层条目数 / 文件数 / 总字节（只用于报告）。 */
function treeUsage(dir) {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (d === dir) entries += 1;
      if (e.isDirectory()) stack.push(p);
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch { /* 读不到就不计 */ }
      }
    }
  }
  return { entries, files, bytes };
}

/** 清掉这棵树；清不干净就把**还留在盘上的路径**列出来（最多 5 条，供人处置）。 */
function sweepTempRoot(root) {
  const before = treeUsage(root);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 下面按实际状态报 */ }
  const leftovers = [];
  if (fs.existsSync(root)) {
    const stack = [root];
    while (stack.length > 0 && leftovers.length < 5) {
      const d = stack.pop();
      let names = [];
      try { names = fs.readdirSync(d); } catch { leftovers.push(d); continue; }
      for (const n of names) {
        const p = path.join(d, n);
        try { (fs.lstatSync(p).isDirectory() ? stack : leftovers).push(p); } catch { leftovers.push(p); }
      }
    }
  }
  return { root, ...before, leftovers };
}

/** 汇总里那一行：清理结果 + 仍留下的名字。 */
export const formatSuiteTempReport = (r) =>
  "临时目录 : 清掉本轮残留 " + r.entries + " 个 / " + humanBytes(r.bytes) + "（" + r.files + " 个文件" +
  (r.leftovers.length === 0 ? "" : "；**仍留下 " + r.leftovers.length + " 个**：" + r.leftovers.join("、")) + "）";

// ── PK3-T2：本进程经 fs.mkdtemp* 越出私有根的硬门 ───────────────────────────────
//
// 第一版是「跑完扫宿主 TMPDIR 顶层、找本轮新增的 mkdtemp 目录」——Codex 一轮判定它**做不到归因**：
// 宿主 tmp 是共享命名空间，并行会话 / 旧分支 / 别的测试入口建的目录都会被算到本套件头上
// （验收时 22 条命中就是反例），而退出枚举后被并发删掉的目标还会 stat 失败而被计成命中；
// 2.19M 条 `readdir withFileTypes` 的内存也远不止当初估的 17MB，启动+退出各扫一次每套件多 40 秒。
// 改成**进程内归因**：包装 fs 的 mkdtemp*，请求的前缀落在本轮私有根之外就**当场 throw**，
// 让肇事的用例自己红、并记进 violations 供退出汇总。只判“本进程经 fs 对象调的那三个入口”，
// 不碰共享宿主命名空间、也不声张它能盖住别的写法。**盖不住的（不在本门范围内）**：
//   · 子进程里写死的 `/tmp/...` 之类（子进程不继承本进程的 fs 包装）；
//   · 不经 `fs.mkdtemp*` 的原生程序（`mktemp(1)`、C 库、别的语言）；
//   · 装包装**之前**存下的函数引用（先 `const m = fs.mkdtempSync` 再在别处调）也不生效 ——
//   那几种要靠子进程级隔离（另票），本门只管本进程这一条路。“硬编码子进程”的覆盖本单不做。

/** mkdtemp 追加的随机后缀（6 位，**不含路径分隔符**）—— 判据要按"可能生成的那个名字"算。 */
export const MKDTEMP_SENTINEL = "XXXXXX";

/**
 * 候选名（`prefix + 哨兵后缀`）的规范形：**只 realpath 它的父目录，叶子原样拼回**（PK3-T2-fix5）。
 * 哨兵那一段只是「Node 会用的那个随机名」的占位，而那个随机名**必定还不存在** —— 所以盘上
 * 有没有同名链接跟这次创建会落到哪里无关；跟着它走反而会被它骗过去（`escape-XXXXXX -> 根内`
 * 时判据说“在根内”，真实 `mkdtempSync("escape-")` 却在根外建出 `escape-<6 位>`）。
 */
function canonicalizeCandidate(p) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  return path.join(canonicalizeOr(dir, dir), base);
}

/**
 * 「这次 mkdtemp 会造出来的那个名字」在不在本轮私有根之内。五道都比：
 *   1. **按可能生成的名字算（PK3-T2-fix4）**：mkdtemp 造的是 `prefix + 6 位随机后缀`，不是 prefix 本身。
 *      不先补后缀就会两头都错：`mkdtempSync(<root>)` 生成的是 `<root>XXXXXX`（根的**兄弟**，
 *      在根外）却被放行；而 prefix 最后一段本身是 symlink 时（`mkdtempSync(<root>/jump)`）实际上
 *      造的是 `<root>/jumpXXXXXX`（根内的新目录，不穿过那个链接）却会被误拒。
 *      补一个不含分隔符的哨兵后缀就能同时定对这两头。
 *   2. `path.resolve`：相对前缀按 cwd 解析，跟 fs 自己的语义一致；
 *   3. **符号链接按 realpath 算（PK3-T2-fix3）**：要造的名字还不存在，所以逐级往上找
 *      **最近的现存祖先**做 realpath，再把剩下那几段拼回去 —— 否则 `root/jump -> 根外` 时
 *      `mkdtempSync(root/jump/leak-)` 会被放行、目录真建在根外。
 *   4. **只解祖先、不解那最后一段（PK3-T2-fix5）**：③ 里 realpath 的是 `dirname(候选名)`，
 *      `basename(候选名)` 原样拼回 —— 理由见 canonicalizeCandidate（哨兵叶子是占位，不是这次要建的目录）；
 *   5. 边界按 `path.sep` 判 —— 否则 `/tmp/root-abc` 会冒充 `/tmp/root`。
 *
 * 不管的是 TOCTOU（判完到建之间有人把目录换成链接）—— 这是测试面的守卫，不是安全边界。
 */
export const insideRoot = (prefix, root) => {
  const created = canonicalizeCandidate(path.resolve(String(prefix) + MKDTEMP_SENTINEL));   // ① + ④
  const r = canonicalizeOr(path.resolve(root), path.resolve(root));
  return created === r || created.startsWith(r + path.sep);
};

/**
 * 逐级往上找最近的**现存**祖先，realpath 它，再把剩下的名字拼回去。
 * 全都 exists 不了（连根目录都不存在）时返回 null，由调用方回退到字面路径。
 */
function canonicalizeOr(p, fallback) {
  const tail = [];
  let cur = p;
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail); } catch { /* 不存在：往上退一级 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return fallback;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

/** 调用栈顶一帧（跳过包装自己那几层），throw 的消息里要能直接指出是谁干的。 */
function blamelessFrame() {
  const lines = String(new Error().stack ?? "").split("\n").slice(1);
  const frame = lines.find((l) => !l.includes("suite-temp-root.mjs"));
  return frame ? frame.trim() : "（取不到调用帧）";
}

/**
 * 把 fs 的 mkdtemp 家族换成“越界即 throw”的版本。**只在 installSuiteTempRoot 里装、只影响测试面**。
 * 三个都装：sync / callback / promises —— 夹具用哪个都躲不过（仓里主要用 sync，但 promises 也有）。
 *
 * **包装不依赖用例顺序（PK3-T2-fix2）**：属性定义成**访问器** ——
 *   · 读到的永远是我们的包装（谁把 `fs.mkdtempSync` 赋回原函数也拿不到它）；
 *   · 赋值不会被丢掉，而是当成“内层实现”存进 state（用例真想 stub 也照旧生效），
 *     同时记一条 `guard_reassigned` violation —— 包装是被谁、从哪一行抹掉的要看得见；
 *   · `ensure()` 用来重装（例如有人 `delete` 掉了属性）：发现包装不在就重新装上，记 `guard_missing`。
 * 逐用例边界（harness 的 reclaim）与退出硬门都会调 `ensure()`，所以单条用例改坏包装不会传染给后面。
 *
 * 返回 { wrapped, ensure, restore }：`ensure` 给逐用例边界/退出硬门调（重装），`restore` 给要自己
 * 装卸的用例用（用完全还原；还原后属性是普通值，下一次 ensure 会把陷阱装回去）。
 */
export function installMkdtempGuard({ root, violations }) {
  const originals = {
    mkdtempSync: fs.mkdtempSync,
    mkdtemp: fs.mkdtemp,
    promisesMkdtemp: fs.promises?.mkdtemp,
  };
  // 内层实现：默认是装的时候那几个；有人赋值就换成他们给的那个（活引用，不是快照）
  const inner = { mkdtempSync: originals.mkdtempSync, mkdtemp: originals.mkdtemp, promisesMkdtemp: originals.promisesMkdtemp };
  const guard = (prefix) => {
    if (insideRoot(prefix, root)) return;
    // 记的与报的都是**可能生成的那个名字**（prefix + 哨兵后缀）：那才是这套判据的对象。
    const target = path.resolve(String(prefix) + MKDTEMP_SENTINEL);
    const canonical = canonicalizeCandidate(target);   // 与判据同一个对象（fix5：叶子不跟链接走）
    const v = { prefix: String(prefix), target, canonical, root, frame: blamelessFrame() };
    violations.push(v);
    throw new Error("临时目录硬门：mkdtemp 的前缀不在本轮私有根内 —— 这个临时目录会落在宿主 tmp 上、本轮收不回来\n" +
      "  前缀：" + v.prefix + "\n  会生成：" + v.target +
      (canonical === target ? "" : "（解链接后：" + canonical + " —— 前缀里某一级是指向根外的符号链接）") +
      "\n  本轮私有根：" + root + "\n  调用处：" + v.frame);
  };
  const wrapped = {
    mkdtempSync: function guardedMkdtempSync(prefix, ...rest) {
      guard(prefix);
      return inner.mkdtempSync.call(fs, prefix, ...rest);
    },
    mkdtemp: function guardedMkdtemp(prefix, ...rest) {
      // 越界在**调用当时**就抛（同步地），不移交给 callback —— 这样肇事处不会被裹进异步栈里。
      guard(prefix);
      return inner.mkdtemp.call(fs, prefix, ...rest);
    },
    promisesMkdtemp: typeof originals.promisesMkdtemp === "function"
      ? function guardedPromisesMkdtemp(prefix, ...rest) {
        guard(prefix);
        return inner.promisesMkdtemp.call(fs.promises, prefix, ...rest);
      }
      : null,
  };

  /** 谁把包装换掉了：记下来（带是哪一行干的），值本身仍当内层实现用。 */
  const onAssign = (what, value) => {
    inner[what] = value;
    violations.push({ kind: "guard_reassigned", what, to: typeof value === "function" ? String(value.name || "anonymous") : typeof value, frame: blamelessFrame(), prefix: null, target: null, root });
  };
  const defineGuard = (holder, name, key) => {
    if (key === "promisesMkdtemp" && wrapped[key] === null) return;
    Object.defineProperty(holder, name, {
      configurable: true,
      enumerable: true,
      get: () => wrapped[key],
      set: (v) => {
        // 把“我们自己的包装”赋回来是无操作：真按内层实现用会无限递归（保存→赋值→还原那种写法）。
        if (v === wrapped[key]) return;
        onAssign(key, v);
      },
    });
  };
  const installAll = () => {
    defineGuard(fs, "mkdtempSync", "mkdtempSync");
    defineGuard(fs, "mkdtemp", "mkdtemp");
    if (typeof originals.promisesMkdtemp === "function") defineGuard(fs.promises, "mkdtemp", "promisesMkdtemp");
  };
  installAll();

  const present = () =>
    fs.mkdtempSync === wrapped.mkdtempSync &&
    fs.mkdtemp === wrapped.mkdtemp &&
    (typeof originals.promisesMkdtemp !== "function" || fs.promises.mkdtemp === wrapped.promisesMkdtemp);
  /** 访问器本身还在不在（值对、但陷阱被拆掉的情况：有别人用 defineProperty 写了固定值）。 */
  const armed = () =>
    typeof Object.getOwnPropertyDescriptor(fs, "mkdtempSync")?.get === "function" &&
    typeof Object.getOwnPropertyDescriptor(fs, "mkdtemp")?.get === "function" &&
    (typeof originals.promisesMkdtemp !== "function" || typeof Object.getOwnPropertyDescriptor(fs.promises, "mkdtemp")?.get === "function");

  return {
    wrapped,
    /**
     * 逐用例边界与退出硬门都调：包装不在了（被 delete / 被 defineProperty 写固定值）就
     * 重装，并记一条 —— 值还在、只是陷阱被拆的话只重装不记（那是装卸用例的正常残留）。
     */
    ensure: () => {
      const valuesOk = present();
      const trapOk = armed();
      if (valuesOk && trapOk) return false;
      if (!valuesOk) violations.push({ kind: "guard_missing", what: "mkdtemp*", frame: blamelessFrame(), prefix: null, target: null, root });
      installAll();
      return true;
    },
    restore: () => {
      Object.defineProperty(fs, "mkdtempSync", { configurable: true, enumerable: true, writable: true, value: originals.mkdtempSync });
      Object.defineProperty(fs, "mkdtemp", { configurable: true, enumerable: true, writable: true, value: originals.mkdtemp });
      if (typeof originals.promisesMkdtemp === "function") {
        Object.defineProperty(fs.promises, "mkdtemp", { configurable: true, enumerable: true, writable: true, value: originals.promisesMkdtemp });
      }
    },
  };
}

/**
 * 硬门（PK3-T2-fix1/fix3）：只核**自己**——(a) 本轮私有根已删，(b) violations 为空。
 * 不扫宿主 tmp、不数别人造的目录：那是共享命名空间，归因不了的东西不该当判据。
 * 纯函数，参数注入。
 */
export function auditOwnTempRoot({ root, violations = [], rootExists = null } = {}) {
  const stillThere = rootExists === null ? fs.existsSync(root) : rootExists;
  return { ok: !stillThere && violations.length === 0, ownRootPresent: stillThere, root, violations };
}

/** 硬门那一行（违规时多行）。**通过行的措辞只说它真盖住的那一条路**（PK3-T2-fix3 P2）。 */
export function formatTempRootGate(a) {
  if (a.ok) return "临时目录硬门：本进程经 fs.mkdtemp* 的调用都在私有根内、私有根已删";
  const lines = ["临时目录硬门：本轮有临时目录落在私有根之外（或私有根没收干净）"];
  if (a.ownRootPresent) lines.push("  · 本轮私有根还在：" + a.root);
  for (const v of a.violations.slice(0, 20)) {
    if (v.kind === "guard_reassigned") {
      lines.push("  · 包装被重新赋值：" + v.what + " ← " + v.to + "；" + v.frame);
    } else if (v.kind === "guard_missing") {
      lines.push("  · 包装被删掉过（已在 " + v.frame + " 附近发现并重装）");
    } else {
      lines.push("  · 越界 mkdtemp：前缀 " + v.prefix + " → " + v.target + (v.canonical && v.canonical !== v.target ? "（解链接后 " + v.canonical + "）" : "") + "；调用处 " + v.frame);
    }
  }
  if (a.violations.length > 20) lines.push("  · （还有 " + (a.violations.length - 20) + " 条未列出）");
  return lines.join("\n");
}


/**
 * 建立本轮的临时根并接管 TMPDIR。套件启动时**在第一条 test 之前**调一次（要和 installTestHomeIsolation
 * 一样早 —— 它自己也用 os.tmpdir() 造套件 HOME，落在这棵树里就被一起收走）。
 */
export function installSuiteTempRoot({ env = process.env, out = (s) => process.stdout.write(s), prefix = "feishu-suite-run" } = {}) {
  const hostTmp = os.tmpdir();   // 改之前读：这是宿主 TMPDIR（只为了给消息里的人看，不再扫它）
  const root = fs.realpathSync(fs.mkdtempSync(path.join(hostTmp, prefix + "-" + process.pid + "-")));
  env.TMPDIR = root;
  const violations = [];
  // 进程内归因（PK3-T2-fix1）：装了之后，任何“前缀不在私有根里”的 mkdtemp 当场 throw。
  // fix2：这一份是**访问器**，所以“包装被别的用例换回原函数”不会再把它抹掉（换回去的值被当内层实现）。
  const guard = installMkdtempGuard({ root, violations });
  let swept = null;
  const api = {
    root,
    hostTmp,
    violations,
    /** 逐用例边界与退出硬门都调：包装不在就重装 + 记一条（顺序依赖的根因就在这里被拦住）。 */
    ensure: () => guard.ensure(),
    snapshot: () => { try { return new Set(fs.readdirSync(root)); } catch { return null; } },
    reclaimSince: (snap) => {
      if (snap === null) return 0;
      let n = 0;
      try {
        for (const name of fs.readdirSync(root)) {
          if (snap.has(name)) continue;
          try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); n += 1; } catch { /* 留到汇总那道兜底 */ }
        }
      } catch { /* 根没了就不再管 */ }
      return n;
    },
    sweep: () => { if (swept === null) swept = sweepTempRoot(root); return swept; },
  };
  // 兜底：任何 process.exit 路径（async 用例闸门、汇总失败、Ctrl-C 之外的显式退出）都扫一次，
  // 然后在同一处过硬门（PK3-T2-fix1/fix3）：私有根已删 + 本进程经 fs.mkdtemp* 的调用没有越界的。
  // 放在 exit 里是因为它要盖住所有退出路径（包括 flush 后直接 exit 的那些）。
  process.on("exit", () => {
    if (swept === null) {   // 汇总已经清过并打过报告
      const r = api.sweep();
      if (r.entries > 0 || r.leftovers.length > 0) out(formatSuiteTempReport(r) + "\n");
    }
    // 退出前先 ensure：包装被 delete 掉了也要在硬门之前重装（否则硬门自己看到的就是“没包装”）。
    api.ensure();
    const gate = auditOwnTempRoot({ root, violations });
    out(formatTempRootGate(gate) + "\n");
    // 已非 0 的退出码保留（别把"本来就红了"盖成 1 或 0）：
    if (!gate.ok && !process.exitCode) process.exitCode = 1;
  });
  suiteTempRoot = api;
  return api;
}
