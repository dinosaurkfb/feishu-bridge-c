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
 *   · 给了且与来源检出的 HEAD 一致 → 计划里写一行结论，照常装；
 *   · 给了但不一致 → 写盘路径上在**任何写盘之前**拒绝（非 0、零写）；预览路径本来就零写，
 *     所以它是「报告」：照常打出计划，退出码非 0；
 *   · 来源不是 git 仓库 → 一样拒绝：**核对不出来 ≠ 核对通过**（从 runtime 里跑安装器就是这种情形）；
 *   · 参数本身不合法（缺值 / 重复 / 不是十六进制 sha）→ 用法错，两种模式都当场拒绝。
 *
 * **前缀语义**：接受完整 sha 或 ≥7 位前缀，按「期望值是不是检出 sha 的前缀」比 ——
 * 不拿这个前缀去仓库里 `rev-parse` 解析。于是**不存在"前缀不唯一"这个失败态**：我们没有问
 * 「仓库里哪个对象以它开头」，只问「你声明的那个提交是不是就是当前检出的这个」。git 自己的
 * 缩写默认也是 7 位，比这短就没法当判据（16^7 ≈ 2.7 亿，够用）。
 */
import { sourceCommit } from "./runtime-install.mjs";

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
 * 核对结论。`kind` 五态：
 *   absent    没给参数 —— **一行都不打、什么都不做**（现有流程的行为一个字不变）；
 *   ok        给了且一致 —— `line` 写进计划；
 *   mismatch  给了但不一致 —— `line` 写进计划（预览用），`refusal` 是写盘路径上的拒绝句；
 *   not_repo  来源不是 git 仓库 —— 同上；
 *   bad_argv  参数本身不合法 —— `line` 为 null（连计划都不该打，两种模式都当场拒）。
 * `ok` 只表示"核对通过"（absent 也算通过：这条闸不该拦住没声明的人）。
 *
 * `actual` 可注入（用例不必造 git 仓库就能验判据）；不给就按 `sourceRoot` 现读一次 HEAD。
 */
export function expectCommitVerdict({ argv = process.argv.slice(2), sourceRoot = null, actual = undefined } = {}) {
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
  if (full.startsWith(parsed.expected)) {
    return { kind: "ok", given: true, expected: parsed.expected, actual: full, ok: true,
      line: "期望提交 : " + parsed.expected + "（" + EXPECT_COMMIT_FLAG + "）—— 与来源检出 " + full.slice(0, 12) + " 一致",
      refusal: null };
  }
  const core = "你要装 " + parsed.expected + "，但这个检出是 " + full.slice(0, 12) + "（可能是更新代码那一步失败了）";
  return { kind: "mismatch", given: true, expected: parsed.expected, actual: full, ok: false,
    line: "期望提交 : " + parsed.expected + " —— **核对不通过**：" + core, refusal: "拒绝：" + core + "。什么都没做。" };
}

/**
 * 结语那一行（issue #257 第 2 条）：肉眼复核一秒完成 —— `--apply` 装完必须一眼看到「装的是哪个提交」。
 * 来源不是 git 仓库就如实说（追不到 ≠ 编一个出来）。措辞只写一处：三个安装器的结语必须长一样。
 */
export const sourceCommitLine = ({ commit, version } = {}) =>
  "装的是提交 " + (typeof commit === "string" && commit.length > 0 ? commit.slice(0, 12) : "（来源不是 git 仓库，追不到）") +
  "，runtime 版本 " + (version ?? "（未知）");
