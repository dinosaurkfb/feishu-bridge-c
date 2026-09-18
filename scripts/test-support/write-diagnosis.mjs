/**
 * 写盘失败的**翻译**（PK3-T1）—— 只给测试面用（`scripts/test-support/`）。
 *
 * 为什么需要：omm 的 TMPDIR 是 3.9G tmpfs，套件泄漏把盘撑到 80% 之后，Codex 套件 6 条红，
 * 报错全是 `Error: UNKNOWN: unknown error, write at writeFileSync …` —— **完全看不出是盘满**，
 * 像用例逻辑坏了或 node 的 bug（清掉残留重跑就 306/0）。ENOSPC 稍微好认一点，UNKNOWN 则完全认不出来。
 *
 * 这里做的事只有一件：捕获写盘失败时，把 `TMPDIR` 路径与**剩余空间**贴到错误信息上，再抛。
 * 不重试、不降级、不改任何写行为 —— 错误对象本来的 code / errno / syscall / path 原样保留
 * （有测试盯着"非盘满错误不许被改标签"）。
 *
 * 判据只认三类码：`ENOSPC` / `EDQUOT` / `UNKNOWN`。**UNKNOWN 只在剩余空间确实很低时才说"像是盘满"**
 * —— 否则只贴数字，不猜结论（盘满之外的 UNKNOWN 会因此看起来还是老样子，但至少带着 TMPDIR 与余量）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 这个错误像不像"没地方写了"。 */
export const DISK_FULL_CODES = Object.freeze(["ENOSPC", "EDQUOT", "UNKNOWN"]);

/** 低于这个余量才敢替 UNKNOWN 说"像是盘满"（64MB）。 */
export const LOW_SPACE_BYTES = 64 * 1024 * 1024;

/** 目录所在文件系统的可用字节（statfs）；读不出来 → null（不编数字）。 */
export function freeBytesOf(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export function humanBytes(n) {
  if (n === null || !Number.isFinite(n)) return "查不到";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(0) + "MB";
  return (n / 1073741824).toFixed(1) + "GB";
}

/**
 * 把一条写盘失败翻译成一句能看出原因的话（纯函数：错误对象 + 落点目录 + 余量）。
 * 认不出来的错误 → 返回 null（调用方原样抛，不许改标签）。
 */
export function writeFailureMessage(err, { target = null, dir = os.tmpdir(), free = undefined } = {}) {
  const code = String(err?.code ?? "");
  if (!DISK_FULL_CODES.includes(code)) return null;
  const at = dir ?? os.tmpdir();
  const space = free === undefined ? freeBytesOf(at) : free;
  const low = space !== null && space < LOW_SPACE_BYTES;
  const verdict = code === "ENOSPC" || code === "EDQUOT" ? "像是盘满"
    : low ? "像是盘满（UNKNOWN + 余量已很低）" : "UNKNOWN（余量不算低，未必是盘满）";
  return "写入失败：" + String(err?.message ?? err) + "（code=" + code + (target === null ? "" : "，落点 " + target) + "）" +
    "；TMPDIR=" + at + " 剩余 " + humanBytes(space) + " —— " + verdict +
    "（先清临时目录再重跑；见 node scripts/test-support/tmp-residue.mjs）";
}

/** 翻译后再抛（保留原错误的 code / errno / syscall / path，并挂 cause）。`dir`/`free` 由调用方按**写入端**给。 */
export function diagnoseWriteError(err, { target = null, dir = os.tmpdir(), free = undefined } = {}) {
  const message = writeFailureMessage(err, { target, dir, free });
  if (message === null) return err;
  const wrapped = new Error(message, { cause: err });
  for (const k of ["code", "errno", "syscall", "path", "dest"]) if (err?.[k] !== undefined) wrapped[k] = err[k];
  wrapped.writeDiagnosis = true;
  return wrapped;
}

/**
 * 把 fs 上的几个写入口包一层翻译（**只影响本进程**：产品行为一个字没改，改的是错误信息）。
 * 幂等：同一个 fs 上重复调用只包一次。
 */
/**
 * 被包的同步入口 → **哪一个参数是"写往哪里"**（余量要按写入端所在目录查，不是源）。
 *   · 单向写入口（writeFile / appendFile / mkdir）：args[0]；
 *   · 复制 / 改名（copyFile / rename / cp）：**args[1]** —— 源与目标可能在不同文件系统上，
 *     问源那侧的余量会答非所问（评审实测：`copyFileSync(src, dst)` 用了 `args[0]`）。
 */
export const WRITE_ENTRY_POINTS = Object.freeze({
  writeFileSync: 0,
  appendFileSync: 0,
  mkdirSync: 0,
  copyFileSync: 1,
  renameSync: 1,
  cpSync: 1,
});

/** 写入口的落点目录（拿不到就用 TMPDIR）。 */
const targetDirOf = (value) => (typeof value === "string" && value.length > 0 ? path.dirname(path.resolve(value)) : os.tmpdir());

/**
 * 把 fs 上的写入口包一层翻译（**只影响本进程**：产品行为一个字没改，改的是错误信息）。
 * 幂等：同一个 fsLike 上重复调用只包一次。
 * @param {{ fsLike?: object, freeOf?: (dir: string) => number|null }} opts
 *   `freeOf` 可注入（用例要造"目标目录余量低、源余量高"这种反例，真盘不会配合）。
 */
export function installWriteDiagnosis({ fsLike = fs, freeOf = freeBytesOf, env = process.env } = {}) {
  if (fsLike.__writeDiagnosisInstalled === true) return { installed: false, reason: "already" };
  const originals = new Map();
  // 只包**同步**入口：夹具与产品在这条线上都用同步写（omm 那次的报错也是 writeFileSync）。
  // **cpSync 必须单独包**：它是 Node 自己实现的目录复制，不走 fs.copyFileSync 那一跳
  // （评审探针验证过）—— 而 gate-d-* 那 72MB 的大目录复制走的正是它。
  for (const [name, targetArg] of Object.entries(WRITE_ENTRY_POINTS)) {
    const original = fsLike[name];
    if (typeof original !== "function") continue;
    originals.set(name, original);
    fsLike[name] = function diagnosed(...args) {
      try {
        return original.apply(fsLike, args);
      } catch (err) {
        const target = typeof args[targetArg] === "string" ? args[targetArg] : null;
        const dir = targetDirOf(args[targetArg]);
        throw diagnoseWriteError(err, { target, dir, free: freeOf(dir) });
      }
    };
  }
  Object.defineProperty(fsLike, "__writeDiagnosisInstalled", { value: true, enumerable: false });
  Object.defineProperty(fsLike, "__writeDiagnosisOriginals", { value: originals, enumerable: false });
  void env;
  return { installed: true, wrapped: [...originals.keys()] };
}
