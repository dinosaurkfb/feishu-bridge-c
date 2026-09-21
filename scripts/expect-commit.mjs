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
 *   · 给了且与来源检出的 HEAD 一致**且工作树字节就是那个提交的字节** → 计划里写一行结论，照常装；
 *   · 给了但不一致 → 写盘路径上在**任何写盘之前**拒绝（非 0、零写）；预览路径本来就零写，
 *     所以它是「报告」：照常打出计划，退出码非 0；
 *   · 来源不是 git 仓库 → 一样拒绝：**核对不出来 ≠ 核对通过**（从 runtime 里跑安装器就是这种情形）；
 *   · 参数本身不合法（缺值 / 重复 / 不是十六进制 sha）→ 用法错，两种模式都当场拒绝。
 *
 * **HEAD 对得上不等于装进去的是那个提交的内容**（fix2 P1）：runtime 是从**工作树**读字节的，
 * 所以改一个未提交的 .mjs 之后 `--expect-commit <HEAD>` 照样通过、装成功，而结语与 INSTALLED.json
 * 还把这份**不同的内容**标成了那个提交（"收据撒了谎"）。所以给了期望提交时要逐字节核一遍：
 * 将要安装的源码（collectRuntimeFiles 实际会拷的那些）必须与那个提交的字节一致。
 *
 * **前缀语义**：接受完整 sha 或 ≥7 位前缀，按「期望值是不是检出 sha 的前缀」比 ——
 * 不拿这个前缀去仓库里 `rev-parse` 解析。于是**不存在"前缀不唯一"这个失败态**：我们没有问
 * 「仓库里哪个对象以它开头」，只问「你声明的那个提交是不是就是当前检出的这个」。git 自己的
 * 缩写默认也是 7 位，比这短就没法当判据（16^7 ≈ 2.7 亿，够用）。
 */
import { execFileSync } from "node:child_process";

import { collectRuntimeFiles, keepsRuntimePath, sourceCommit } from "./runtime-install.mjs";

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
 * 将要安装的**源码字节**与某个提交的字节逐字节核对（fix2 P1）。
 *
 * 一侧是**将要拷的那些文件**：`collectRuntimeFiles(sourceRoot)` —— 与安装器**同一个函数**，
 * 不另写一份目录遍历规则（另写一份就会漂：多出一个 skills 子目录、改一次 keep 判定，两边就不一致）。
 * 另一侧是那个提交里**同一套 keep 规则**下应有的文件：`git ls-tree -r <commit> -- scripts skills`，
 * 用 keepsRuntimePath 过一遍筛。
 *
 * 比的是 **git blob 哈希**：工作树侧一次 `git hash-object --stdin-paths` 算完（scripts/ 下两百多个
 * 文件，每个文件起一个 git 进程不可接受），提交侧 ls-tree 本来就带哈希。
 *
 * 三类不一致都算：
 *   changed  两边都有、blob 不同（未提交的修改）
 *   added    只在工作树侧（未跟踪 / 被忽略但真会被拷的，例如 skills/ 下的 .DS_Store）
 *   missing  只在提交侧（工作树删了）
 *
 * 读不清（不是仓库 / 算不出哈希 / ls-tree 失败 / 文件在两次调用之间消失了）→ `ok:false` + `why`：
 * **核对不出来 ≠ 核对通过**。
 */
export function worktreeContentDiff({ sourceRoot, commit } = {}) {
  const git = (args, { input } = {}) => execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf-8", timeout: 30_000,
    // stderr 吞掉：失败了下面对 err 自己写人话，不让 git 的英文错误漏到调用者的 stderr 上。
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
  });
  const whyLine = (err) => String(err?.message ?? err).split("\n")[0];
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0 || typeof commit !== "string" || commit.length === 0) {
    return { ok: false, why: "核对参数不全（sourceRoot / commit）" };
  }
  const mine = collectRuntimeFiles(sourceRoot);
  let prefix;
  try { prefix = git(["rev-parse", "--show-prefix"]).trim(); }
  catch (err) { return { ok: false, why: "git 读不出仓库边界（" + whyLine(err) + "）" }; }
  let hashed;
  try {
    // 路径按**仓库根**解析（不是 cwd），所以补上 prefix —— sourceRoot 是仓库子目录时才不会解错；
    // 报出来的仍是 collectRuntimeFiles 那份**相对 sourceRoot**的路径，两侧路径字面量因此可比。
    hashed = git(["hash-object", "--stdin-paths"], { input: mine.map((p) => prefix + p).join("\n") + "\n" })
      .split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  } catch (err) {
    return { ok: false, why: "工作树算不出 blob 哈希（" + whyLine(err) + "）—— 算不出来就不当核对通过" };
  }
  if (hashed.length !== mine.length) {
    return { ok: false, why: "hash-object 的返回行数与文件数对不上（" + hashed.length + " vs " + mine.length + "）" };
  }
  const worktree = new Map(mine.map((p, i) => [p, hashed[i]]));

  let listing;
  try {
    // core.quotePath=false：路径里有非 ASCII 时默认会被转义并加引号，那样两边路径字面量永远对不上。
    listing = git(["-c", "core.quotePath=false", "ls-tree", "-r", commit, "--", "scripts", "skills"]);
  } catch (err) {
    return { ok: false, why: "git ls-tree 读不出 " + commit.slice(0, 12) + "（" + whyLine(err) + "）" };
  }
  const committed = new Map();
  for (const line of listing.split("\n")) {
    if (line.length === 0) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/u.exec(line);
    if (m === null) continue;
    const [, mode, , sha, file] = m;
    // 只认**普通文件**（100644 / 100755）：符号链接（120000）与 gitlink（160000）不会被
    // collectRuntimeFiles 收（它按 isFile() 判），拿它们当"应有的文件"会造出假的不一致。
    if (mode !== "100644" && mode !== "100755") continue;
    if (!keepsRuntimePath(file)) continue;
    committed.set(file, sha);
  }

  const changed = [];
  const added = [];
  const missing = [];
  for (const [p, sha] of worktree) {
    if (!committed.has(p)) added.push(p);
    else if (committed.get(p) !== sha) changed.push(p);
  }
  for (const p of committed.keys()) if (!worktree.has(p)) missing.push(p);
  const dirty = changed.length + added.length + missing.length;
  return {
    ok: dirty === 0, compared: worktree.size,
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
 * 核对结论。`kind` 六态：
 *   absent        没给参数 —— **一行都不打、什么都不做**（现有流程的行为一个字不变）；
 *   ok            给了且一致（HEAD 对得上，且工作树字节与那个提交一致）—— `line` 写进计划；
 *   mismatch      给了但 HEAD 不是那个提交 —— `line` 写进计划（预览用），`refusal` 是写盘路径上的拒绝句；
 *   dirty         给了、HEAD 对得上，但**工作树与那个提交的字节不一致**（未提交的修改/多/少）——
 *                 与 mismatch **同一个处置**（--apply 零写退 2；预览照打计划、结论一行、退 2）；
 *   not_repo      来源不是 git 仓库 —— 同上；
 *   bad_argv      参数本身不合法 —— `line` 为 null（连计划都不该打，两种模式都当场拒）。
 * `ok` 只表示"核对通过"（absent 也算通过：这条闸不该拦住没声明的人）。
 *
 * `actual` / `contentDiff` 可注入（用例不必造 git 仓库就能验判据）；不给 actual 就按 `sourceRoot`
 * 现读一次 HEAD，给了 `sourceRoot` 就**连着核工作树内容**（不给 sourceRoot = 纯 HEAD 判据）。
 */
export function expectCommitVerdict({ argv = process.argv.slice(2), sourceRoot = null, actual = undefined,
  contentDiff = worktreeContentDiff } = {}) {
  const parsed = parseExpectCommit(argv);
  if (!parsed.ok) {
    return { kind: "bad_argv", given: true, expected: null, actual: null, ok: false, line: null,
      refusal: "拒绝：" + parsed.why + "。什么都没做。" };
  }
  if (parsed.expected === null) {
    return { kind: "absent", given: false, expected: null, actual: actual ?? null, ok: true, line: null, refusal: null };
  }
  const sha = actual === undefined ? sourceCommit(sourceRoot) : actual;
  if (sha === null || sha === undefined) {
    const core = EXPECT_COMMIT_FLAG + " 给了 " + parsed.expected + "，但来源不是 git 仓库（" + String(sourceRoot) +
      "）—— 核对不出来 ≠ 核对通过";
    return { kind: "not_repo", given: true, expected: parsed.expected, actual: null, ok: false,
      line: "期望提交 : " + parsed.expected + " —— **核对不出来**：" + core, refusal: "拒绝：" + core + "。什么都没做。" };
  }
  const full = String(sha).toLowerCase();
  if (!full.startsWith(parsed.expected)) {
    const core = "你要装 " + parsed.expected + "，但这个检出是 " + full.slice(0, 12) + "（可能是更新代码那一步失败了）";
    return { kind: "mismatch", given: true, expected: parsed.expected, actual: full, ok: false,
      line: "期望提交 : " + parsed.expected + " —— **核对不通过**：" + core, refusal: "拒绝：" + core + "。什么都没做。" };
  }
  // HEAD 对上了 —— **但装的是工作树的字节**，所以还要核内容（fix2 P1）。sourceRoot 没给 = 纯 HEAD 判据
  //   （用例注入 actual 时走这条，不必造仓库）。
  if (sourceRoot !== null && typeof contentDiff === "function") {
    const diff = contentDiff({ sourceRoot, commit: full });
    if (!diff.ok) {
      const why = diff.why ?? describeContentDiff(diff);
      const core = "你要装 " + parsed.expected + "，HEAD 就是它，但**工作树与这个提交的字节不一致**（" + why +
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
 */
export const sourceCommitLine = ({ commit, version } = {}) =>
  "装的是提交 " + (typeof commit === "string" && commit.length > 0 ? commit.slice(0, 12) : "（来源不是 git 仓库，追不到）") +
  "，runtime 版本 " + (version ?? "（未知）");
