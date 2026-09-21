/**
 * 「我打算装哪个提交」这道闸（issue #257）。三个安装器共用这一份判据。
 *
 * 起因（2026-09-21 omm 真机）：装机步骤「fetch → reset --hard → 三个安装器 --apply」串在一条命令里，
 * fetch 撞上网络错误（SSL unexpected eof）失败，**后续照常执行** —— 检出停在旧提交，三个安装器把
 * **旧代码**装了一遍，每步退出码都是 0、输出也是「已完成本地安装」。靠事后比版本号才发现。
 *
 * 安装器自己察觉不了：fetch 失败时本地 `origin/main` 也是旧的，两边一致，看不出漂移。
 * 所以判据必须由**调用方显式声明**：`--expect-commit <sha>` —— 授权装机本来就指向一个明确对象
 * （「装 #257 的 PR」「装 main 的 a45371b」），这条把那个口头对象变成机器判据。
 *
 * 语义（三个安装器完全一致）：
 *   · **不给这个参数** → 一行都不打、一个判断都不做（现有装机流程不许被迫带参数）；
 *   · 给了且与来源检出的 HEAD 一致**且将要安装的那份字节就是那个提交的字节** → 计划里写一行结论，照常装；
 *   · 给了但不一致 → 写盘路径上在**任何写盘之前**拒绝（非 0、零写）；预览路径本来就零写，
 *     所以它是「报告」：照常打出计划，退出码非 0；
 *   · 来源不是 git 仓库 → 一样拒绝：**核对不出来 ≠ 核对通过**（从 runtime 里跑安装器就是这种情形）；
 *   · 参数本身不合法（缺值 / 重复 / 不是十六进制 sha）→ 用法错，两种模式都当场拒绝。
 *
 * **HEAD 对得上不等于装进去的是那个提交的内容**（fix2 P1）：runtime 从**工作树**读字节，
 * 所以改一个未提交的 .mjs 之后 `--expect-commit <HEAD>` 照样通过、装成功，而结语与 INSTALLED.json
 * 还把这份**不同的内容**标成了那个提交（"收据撒了谎"）。所以给了期望提交时要逐字节核一遍。
 *
 * **核的是“将要安装的那一份字节”，不是“再去读一次工作树”**（fix3 P1）：fix2 的内容核对自己读一次工作树，
 * 之后安装器**又读一次**才生成运行时计划（planRuntimeSync）—— 两次读取之间源码变了，计划就收下了没核对过的
 * 字节，而 apply 只核“落盘 = 计划”。现在判据吃的是调用方给的那份 **inventory**：
 *   · 出站 / Codex 链：`planRuntimeSync` 在同一次读取、同一个 buffer 上算出的 `files[].blob`（出站还用它渲染技能）；
 *   · 入站技能：安装器把每个源文件**只读一次**进内存，在那份 buffer 上算 `gitBlobHash`。
 * 于是“期望提交 → 计划/inventory → 落盘（apply 本来就核 sha256）”串成一条，中间不再有第二次未核对的读取。
 *
 * **提交身份也只取一次**（fix4 P1）：`actual` 是**计划记下的那一个**（出站/Codex = `runtimePlan.sourceCommit`；
 * 入站 = 读源文件那一刻取的同一个变量），闸与结语共用它。本模块**不再自己读 HEAD** —— 旧版闸会
 * `rev-parse` 一次、结语再读一次，于是“在 A 上生成计划 → 闸之前切到 B”会让闸按 B 放行，
 * 而收据（来自计划）记的是 A。
 *
 * **前缀语义**：接受完整 sha 或 ≥7 位前缀，按「期望值是不是检出 sha 的前缀」比 ——
 * 不拿这个前缀去仓库里 `rev-parse` 解析。于是**不存在"前缀不唯一"这个失败态**：我们没有问
 * 「仓库里哪个对象以它开头」，只问「你声明的那个提交是不是就是当前检出的这个」。git 自己的
 * 缩写默认也是 7 位，比这短就没法当判据（16^7 ≈ 2.7 亿，够用）。
 */
import { execFileSync } from "node:child_process";

import { keepsRuntimePath } from "./runtime-install.mjs";

export const EXPECT_COMMIT_FLAG = "--expect-commit";
/** sha 前缀的最短长度（git 自己的默认缩写也是 7 位）。 */
export const MIN_EXPECT_PREFIX = 7;
// 最短位数只有一个来源：判定用的正则从上面的常量生成（原先正则里写死了 7，改常量只改得动报错文案，
//   判定纹丝不动 —— 刀测把常量放宽到 1 位，全部用例照样绿）。
const SHA_RE = new RegExp("^[0-9a-f]{" + MIN_EXPECT_PREFIX + ",40}$", "u");
const USAGE = "（用法：" + EXPECT_COMMIT_FLAG + " <完整 sha 或 ≥" + MIN_EXPECT_PREFIX + " 位前缀>）";

/**
 * 从 argv 里取这个参数。只认分离形式与 `--k=v`；**重复出现一律拒**（不许"后者覆盖"这种靠位置
 * 定结果的合同，与 argv-options.mjs 同一口径）。返回 `{ ok, expected }` 或 `{ ok:false, why }`。
 */
export function parseExpectCommit(argv = []) {
  const hits = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === EXPECT_COMMIT_FLAG) { hits.push(argv[i + 1]); i += 1; continue; }
    if (a.startsWith(EXPECT_COMMIT_FLAG + "=")) hits.push(a.slice(EXPECT_COMMIT_FLAG.length + 1));
  }
  if (hits.length === 0) return { ok: true, expected: null };
  if (hits.length > 1) {
    return { ok: false, why: EXPECT_COMMIT_FLAG + " 重复出现 —— 只认一次（两个分离形式、或分离与 --k=v 混用都算）" + USAGE };
  }
  const raw = hits[0];
  // 分离形式后面紧跟另一个参数（或就是最后一个 token）→ 缺值，不许把它当值收下。
  if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("--")) {
    return { ok: false, why: EXPECT_COMMIT_FLAG + " 缺值" + USAGE };
  }
  const value = raw.toLowerCase();
  if (!SHA_RE.test(value)) {
    return { ok: false, why: EXPECT_COMMIT_FLAG + " 的值 " + JSON.stringify(raw) + " 不是提交 sha（要 " +
      MIN_EXPECT_PREFIX + "–40 位十六进制）" };
  }
  return { ok: true, expected: value };
}

/**
 * 将要安装的**那一份字节**（inventory）与某个提交的字节逐字节核对（fix3 P1）。
 *
 * `inventory` 是调用方给的 `[{ path, blob }]`：**路径相对 sourceRoot**，blob 是 git blob 哈希。
 * 它必须来自**将要落盘的那一次读取**（出站/Codex：planRuntimeSync 的 `files[].blob`；
 * 入站：那份只读一次的源文件缓存）—— 不再另跑一趟工作树遍历。
 *
 * `scope` = 这个安装器的文件集住在哪儿（相对 sourceRoot 的前缀，至少一项）。为什么要它：`missing`
 * 不能拿整个 `scripts/` + `skills/` 去比 —— 入站安装器只拷自己那一个技能目录下的两个文件，
 * 拿全仓比会把它没打算装的 238 个 runtime 文件全说成“少了”（假不一致）。同理：**scope 之外的
 * 东西既不算多也不算少**，inventory 里有什么才算“这一趟真要装的”。
 *
 * 提交那侧：`git ls-tree -r -z <commit> -- scripts skills`（**`-z` + 按 NUL 切分**：带引号/换行的合法文件名
 * 在按行的输出里会被引号包住/含裸换行，按行解析会把它们静默跳过或解错 —— fix5 P1-1），
 * 用**同一套 keep 规则**（keepsRuntimePath，与 collectRuntimeFiles 同源）过一遍筛。只认普通文件
 * （100644 / 100755）：符号链接（120000）与 gitlink（160000）不会被 collectRuntimeFiles 收（它按 isFile()
 * 判），拿它们当"应有的文件"会造出假的不一致。
 *
 * 三类不一致都算：
 *   changed  两边都有、blob 不同（未提交的修改）
 *   added    只在 inventory 侧（未跟踪 / 被忽略但真会被拷的，例如 skills/ 下的 .DS_Store）
 *   missing  只在提交侧（工作树删了 / 没读进来）
 *
 * 读不清（inventory 形状不对 / ls-tree 失败 / **某条记录解析不了**）→ `ok:false` + `why`：
 * **核对不出来 ≠ 核对通过**（解析不了就拒，不许跳过 —— 跳过会让那个文件两边都不在，“闸说一致”而
 * 它早已从工作树消失）。
 */
export function commitContentDiff({ sourceRoot, commit, inventory, scope = ["scripts", "skills"] } = {}) {
  const whyLine = (err) => String(err?.message ?? err).split("\n")[0];
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0 || typeof commit !== "string" || commit.length === 0) {
    return { ok: false, why: "核对参数不全（sourceRoot / commit）" };
  }
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((s) => typeof s !== "string" || s.length === 0)) {
    return { ok: false, why: "scope 不合法（要一串非空前缀）" };
  }
  const inScope = (p) => scope.some((s) => p === s.replace(/\/$/u, "") || p.startsWith((s.endsWith("/") ? s : s + "/")));
  if (!Array.isArray(inventory)) return { ok: false, why: "inventory 不是数组（没有可核的字节）" };
  const mine = new Map();
  for (const item of inventory) {
    const p = item?.path, blob = item?.blob;
    if (typeof p !== "string" || p.length === 0 || typeof blob !== "string" || !/^[0-9a-f]{40,64}$/u.test(blob)) {
      return { ok: false, why: "inventory 的条目形状不对（要 { path, blob(十六进制) }）：" + JSON.stringify(item?.path ?? item) };
    }
    if (mine.has(p)) return { ok: false, why: "inventory 里有重复路径：" + p };
    mine.set(p, blob);
  }

  let listing;
  try {
    // `-z`：记录按 NUL 切分、路径**原样**输出（不引号不转义）—— 含换行 / 引号 / 非 ASCII 的合法文件名
    // 只有这样才拿得到。按行读的旧写法遇到它们会跳过或解错（那两类文件会两边都不在 → 误报一致）。
    listing = execFileSync("git", ["-C", sourceRoot, "ls-tree", "-r", "-z", commit, "--", "scripts", "skills"],
      // stderr 吞掉：失败了下面对 err 自己写人话，不让 git 的英文错误漏到调用者的 stderr 上。
      { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    return { ok: false, why: "git ls-tree 读不出 " + commit.slice(0, 12) + "（" + whyLine(err) + "）" };
  }
  const records = listing.split("\0");
  if (records.length > 0 && records[records.length - 1] === "") records.pop();   // 末尾的 NUL 终止符
  const committed = new Map();
  for (const record of records) {
    // `<mode> SP <type> SP <object> TAB <path>` —— path 可能含换行，所以用 [\s\S]。
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/u.exec(record);
    if (m === null) {
      return { ok: false, why: "ls-tree 有一条记录解析不了（核对不出来 ≠ 核对通过）：" + JSON.stringify(String(record).slice(0, 120)) };
    }
    const [, mode, , sha, file] = m;
    if (mode !== "100644" && mode !== "100755") continue;
    if (!keepsRuntimePath(file)) continue;
    if (!inScope(file)) continue;
    committed.set(file, sha);
  }

  const changed = [];
  const added = [];
  const missing = [];
  for (const [p, blob] of mine) {
    if (!committed.has(p)) added.push(p);
    else if (committed.get(p) !== blob) changed.push(p);
  }
  for (const p of committed.keys()) if (!mine.has(p)) missing.push(p);
  const dirty = changed.length + added.length + missing.length;
  return {
    ok: dirty === 0, compared: mine.size,
    changed: changed.sort(), added: added.sort(), missing: missing.sort(), why: null,
  };
}

/** 至多点名 5 个不一致的路径（多了给总数）—— 与 issue #257 的口径一致。 */
export const MAX_NAMED_PATHS = 5;
export function describeContentDiff(diff) {
  const name = (arr) => arr.slice(0, MAX_NAMED_PATHS).join("、") +
    (arr.length > MAX_NAMED_PATHS ? " 等 " + arr.length + " 个" : "");
  const bits = [];
  if (diff.changed.length > 0) bits.push("改了 " + diff.changed.length + " 个（" + name(diff.changed) + "）");
  if (diff.added.length > 0) bits.push("多了 " + diff.added.length + " 个（" + name(diff.added) + "）");
  if (diff.missing.length > 0) bits.push("少了 " + diff.missing.length + " 个（" + name(diff.missing) + "）");
  return bits.join("；");
}

/**
 * **核对结论。`kind` 八态**：
 *   absent        没给参数 —— **一行都不打、什么都不做**（现有流程的行为一个字不变）；
 *   ok            给了且一致（身份对得上，且将装的那份字节与那个提交一致）—— `line` 写进计划；
 *   mismatch      给了但身份不是那个提交 —— `line` 写进计划（预览用），`refusal` 是写盘路径上的拒绝句；
 *   dirty         给了、身份对得上，但**将要安装的那份字节与那个提交不一致**（未提交的修改/多/少）——
 *                 与 mismatch **同一个处置**（--apply 零写退 2；预览照打计划、结论一行、退 2）；
 *   not_repo      调用方看了、说来源不是 git 仓库（`actual: null`）—— 同上；
 *   no_checker    有 inventory 却没给可用的核对函数（fix5 P2-1）—— 接线错，fail-closed：同上。
 *                 （旧写法在 `typeof contentDiff !== "function"` 时**直接放行**，那是 fail-open。）
 *   no_identity   调用方**根本没把提交身份传进来**（`actual` 缺省）—— 接线错，fail-closed：同上。
 *                 这条存在的理由：身份必须**只取一次**（计划记下的那个），决不能让这个函数自己
 *                 `rev-parse HEAD` 补一个 —— 那就是 fix4 那个分叉（计划说 A、闸按 B 放行）。
 *   bad_argv      参数本身不合法 —— `line` 为 null（连计划都不该打，两种模式都当场拒）。
 * `ok` 只表示"核对通过"（absent 也算通过：这条闸不该拦住没声明的人）。
 *
 *   期望提交 → 计划/inventory → 落盘（apply 本来就核「盘上字节 = 计划 sha256」）串成一条。
 * `inventory` 缺省 `null` = **这次不装任何源码字节**（卸载路径：它一个源文件都不拷），
 * 于是只核对身份那半条 —— “核对不出来 ≠ 核对通过”仍适用，但“没有字节可核”不是“核不过”。
 * `scope` 透给内容核对（缺省整个 runtime 树 `scripts` + `skills`；入站只拷固定几个文件时要**精确到那几个**，
 *   与它自己的 files 清单同源）。
 *
 * **本函数不调 git 取身份**（fix4）：`actual` 由调用方给 —— 出站/Codex 是计划里记的 `sourceCommit`，
 * 入站是读源文件的那一刻取的那一个（与结语用同一个变量）。
 */
export function expectCommitVerdict({ argv = process.argv.slice(2), sourceRoot = null, actual = undefined,
  inventory = null, scope = undefined, contentDiff = commitContentDiff } = {}) {
  const parsed = parseExpectCommit(argv);
  if (!parsed.ok) {
    return { kind: "bad_argv", given: true, expected: null, actual: null, ok: false, line: null,
      refusal: "拒绝：" + parsed.why + "。什么都没做。" };
  }
  if (parsed.expected === null) {
    return { kind: "absent", given: false, expected: null, actual: actual ?? null, ok: true, line: null, refusal: null };
  }
  if (actual === undefined) {
    const core = "调用方没把提交身份传进来（" + EXPECT_COMMIT_FLAG + " 要核的那个值）—— 接线错，核对不出来 ≠ 核对通过";
    return { kind: "no_identity", given: true, expected: parsed.expected, actual: null, ok: false,
      line: "期望提交 : " + parsed.expected + " —— **核对不出来**：" + core, refusal: "拒绝：" + core + "。什么都没做。" };
  }
  if (actual === null) {
    const core = EXPECT_COMMIT_FLAG + " 给了 " + parsed.expected + "，但来源不是 git 仓库（" + String(sourceRoot) +
      "）—— 核对不出来 ≠ 核对通过";
    return { kind: "not_repo", given: true, expected: parsed.expected, actual: null, ok: false,
      line: "期望提交 : " + parsed.expected + " —— **核对不出来**：" + core, refusal: "拒绝：" + core + "。什么都没做。" };
  }
  const full = String(actual).toLowerCase();
  if (!full.startsWith(parsed.expected)) {
    const core = "你要装 " + parsed.expected + "，但这个检出是 " + full.slice(0, 12) + "（可能是更新代码那一步失败了）";
    return { kind: "mismatch", given: true, expected: parsed.expected, actual: full, ok: false,
      line: "期望提交 : " + parsed.expected + " —— **核对不通过**：" + core, refusal: "拒绝：" + core + "。什么都没做。" };
  }
  // HEAD 对上了 —— **但装的是那次读取的字节**，所以还要核 inventory（fix3 P1）。
  //   `inventory === null` = 这次没有要装的源码字节（卸载路径）→ 只有身份那半条。
  //   有 inventory 却没有可用的核对函数 = 接线错（fix5 P2-1）：**拒绝，不许跳过** ——
  //   旧写法 `typeof contentDiff === "function"` 为假时直接放行，那是 fail-open。
  if (inventory !== null) {
    if (typeof contentDiff !== "function") {
      const core = "要核将装字节却没有核对函数（contentDiff 不是函数）—— 接线错，核对不出来 ≠ 核对通过";
      return { kind: "no_checker", given: true, expected: parsed.expected, actual: full, ok: false,
        line: "期望提交 : " + parsed.expected + " —— **核对不出来**：" + core,
        refusal: "拒绝：" + core + "。什么都没做。" };
    }
    const diff = contentDiff({ sourceRoot, commit: full, inventory, ...(scope === undefined ? {} : { scope }) });
    if (!diff.ok) {
      const why = diff.why ?? describeContentDiff(diff);
      // 「核不出来」（why 有值：inventory 形状不对 / ls-tree 解析不了）与「真的不一致」措辞要分开 ——
      // 两者处置相同（都拒绝），但把人往不同方向指。
      const core = diff.why
        ? "你要装 " + parsed.expected + "，但要核的那份字节**核不出来**（" + why + "）—— 核对不出来 ≠ 核对通过"
        : "你要装 " + parsed.expected + "，HEAD 就是它，但**将要安装的那份字节与这个提交不一致**（" + why +
          "）—— 装进去的会是改过的代码，而收据会把它记成 " + full.slice(0, 12);
      return { kind: "dirty", given: true, expected: parsed.expected, actual: full, ok: false,
        line: "期望提交 : " + parsed.expected + " —— **核对不通过**：" + core,
        refusal: "拒绝：" + core + "。什么都没做。" };
    }
  }
  return { kind: "ok", given: true, expected: parsed.expected, actual: full, ok: true,
    line: "期望提交 : " + parsed.expected + "（" + EXPECT_COMMIT_FLAG + "）—— 与来源检出 " + full.slice(0, 12) + " 一致",
    refusal: null };
}

/**
 * 结语那一行（issue #257 第 2 条）：肉眼复核一秒完成 —— `--apply` 装完必须一眼看到「装的是哪个提交」。
 * 来源不是 git 仓库就如实说（追不到 ≠ 编一个出来）。措辞只写一处：三个安装器的结语必须长一样。
 *
 * **runtime 没重装的例外**（fix5 P1-2）：版本目录是**内容寻址且不可变**的，同一份字节再装一次
 * 就是 no-op —— 目录里那份 INSTALLED.json（及其 `source_commit`）**不会**被改写。于是
 * “先以 B 装、再检出 A（只差文档）装同一份内容”会出现：本次核对的提交是 A，而收据记的还是 B。
 * 只写「装的是提交 A」会让人以为收据也是 A。所以这种时候两个都写出来，并明说没重装。
 * （`installedCommit` 是那份不可变收据记的来源提交；为空/相同就走原来那一行。）
 */
export const sourceCommitLine = ({ commit, version, installedCommit = null, noop = false } = {}) => {
  // #260：「有没有重装」由调用方**明说**（applyRuntimeSync 的 noop），不再靠「两个提交号截成 12 位后是否相同」去猜；
  //   比较一律用**完整** sha，判完再截短展示 —— 共享前 12 位的两个不同提交不许被说成同一个。
  const full = (c) => (typeof c === "string" && c.length > 0 ? c.toLowerCase() : null);
  const plannedFull = full(commit);
  const recordedFull = full(installedCommit);
  const shown = (c) => (c === null ? null : c.slice(0, 12));
  const planned = plannedFull === null ? "（来源不是 git 仓库，追不到）" : shown(plannedFull);
  const v = version ?? "（未知）";
  if (noop === true) {
    if (recordedFull === null) {
      return "本次来源提交 " + planned + "；**runtime 未重装**（版本 " + v +
        " 已是同一份内容，但其收据**没有记录来源提交**，证明不了它最初来自哪个提交）—— 将装字节与 " + planned + " 一致";
    }
    if (plannedFull === null || recordedFull !== plannedFull) {
      // 前 12 位相同而完整 sha 不同时，12 位展示会把差异藏起来 —— 那种时候两个都给完整 sha。
      const clash = plannedFull !== null && shown(recordedFull) === shown(plannedFull);
      const p = clash ? plannedFull : planned;
      const r = clash ? recordedFull : shown(recordedFull);
      return "本次来源提交 " + p + "；**runtime 未重装**（版本 " + v +
        " 已是同一份内容，其收据记的来源提交是 " + r + "）—— 将装字节与 " + p + " 一致";
    }
  }
  return "装的是提交 " + planned + "，runtime 版本 " + v;
};
