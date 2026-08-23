/**
 * 把桥的运行代码安装到一个**与开发克隆无关**的固定位置。
 *
 * 为什么需要它 —— 现在钩子命令里写的是某个开发克隆的绝对路径，这带来两个已经真实发生的问题：
 *
 *   1. 本机装了两份 Stop 钩子和两份 UserPromptSubmit 钩子，分别指向两个克隆。
 *      根因是安装器拿**脚本绝对路径**当幂等键（`MARKER = HOOK_SCRIPT`），
 *      第二个克隆的路径不同，于是不是覆盖而是追加。两个克隆的代码可以停在不同提交上，
 *      于是两套逻辑并发操作同一份 outbox 和同一份 Dialogue 状态 —— 发布锁只能挡住
 *      「同时发布」，挡不住「两个版本各按各的规则改状态」。
 *   2. 钩子跑的是工作树**当前 checkout** 的代码。开发时切一次分支，线上行为就跟着变。
 *      修出站延迟的那天就出现过：修复在某个分支上，切走之后线上又退回旧行为。
 *
 * 解法是让全局配置只认一个稳定路径，代码从开发克隆**复制**过来：
 *
 *   ~/.claude/feishu-bridge/runtime/
 *     versions/<version>/scripts/…    每次安装落一个不可变版本
 *     current -> versions/<version>   钩子只认这个
 *     INSTALLED.json                  当前版本、来源提交、逐文件哈希
 *
 * 用符号链接而不是原地覆盖：**切换是一次 rename，原子**。原地逐文件覆盖会留下一个
 * 半新半旧的窗口，恰好在那时结束的会话会加载到混合版本的模块 —— 那比晚发一条严重得多。
 * 保留旧版本目录还顺带给了回滚能力：把 current 指回去即可，不需要重新复制。
 *
 * 本模块只做「文件落到哪、怎么落」。谁来引用这些路径（settings、launchd、技能）
 * 由 install-outbound.mjs 负责；两者分开是为了这一半能被单测覆盖而不碰全局配置。
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 运行时根目录。刻意放在 ~/.claude/feishu-bridge 下，跟日志、登记表同源好排查。 */
export function runtimeRoot(home = os.homedir()) {
  return path.join(home, ".claude", "feishu-bridge", "runtime");
}

export const CURRENT_LINK = "current";
export const MANIFEST_NAME = "INSTALLED.json";

/** 钩子和定时器实际引用的稳定路径 —— 全局配置里只应出现这一种形状。 */
export function runtimeScript(name, home = os.homedir()) {
  return path.join(runtimeRoot(home), CURRENT_LINK, "scripts", name);
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const HASH_RE = /^[0-9a-f]{64}$/u;

/** 相对、规范、不含 `..` —— 清单里的路径会被直接拼进文件系统操作，不能是任意字符串。 */
const safeRelPath = (value) => typeof value === "string" && value.length > 0 &&
  !path.isAbsolute(value) && path.normalize(value) === value &&
  !value.split("/").includes("..");

/**
 * 由文件清单**重算**版本号。plan 与 verify 必须共用这一个函数。
 *
 * 这是让清单自证的关键。此前 verify 只校验"清单里列出的那些文件"，于是把某个条目从
 * 清单里删掉、同时删掉对应文件，verify 照样报 ok —— 线上实际已经缺文件。
 * 现在版本号由清单内容派生，改清单就会改版本号，而版本号还要等于目录名，改不动。
 *
 * 顺带把清单的形状一起钉死：路径安全且唯一、顺序规范、哈希格式合法。任何一条不满足
 * 就返回 null（= 这份清单不可信），而不是勉强算出一个数。
 */
export function versionFromFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const paths = [];
  for (const file of files) {
    if (!safeRelPath(file?.path) || !HASH_RE.test(file?.sha256 ?? "")) return null;
    paths.push(file.path);
  }
  if (new Set(paths).size !== paths.length) return null;
  const sorted = [...paths].sort();
  if (paths.some((value, i) => value !== sorted[i])) return null;
  return sha256(files.map((f) => f.path + ":" + f.sha256).join("\n")).slice(0, 16);
}

/**
 * 运行时需要哪些文件。
 *
 * 只有 `scripts/`：实测运行路径不读 `references/` 或仓库里任何别的资源
 *（`shared-surface.mjs` 读，但那是开发期契约工具，不在钩子路径上）。
 * 少复制一个目录就少一处「装完之后仓库变了、运行时没跟上」的不一致来源。
 */
export function collectRuntimeFiles(sourceRoot) {
  const base = path.join(sourceRoot, "scripts");
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      out.push(path.relative(sourceRoot, full));
    }
  };
  walk(base);
  return out;
}

/** 来源提交，仅用于事后追溯「线上这份代码是哪儿来的」。不是 git 仓库也不算错。 */
function sourceCommit(sourceRoot) {
  try {
    return execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"],
      // stderr 要吞掉：源码目录不是 git 仓库是完全正常的情况（比如测试临时目录），
      // 让 git 的 "not a git repository" 漏到调用者的 stderr 上纯属噪音。
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * 算出这份源码对应的版本号与逐文件哈希。纯计算，不落盘 —— 于是 dry-run 与 apply
 * 看到的是同一个版本号，不会出现「预览说要装 A、实际装了 B」。
 */
export function planRuntimeSync({ sourceRoot, home = os.homedir() } = {}) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    return { ok: false, reason: "source_root_invalid" };
  }
  // 排序后再算：版本号必须只由"哪些文件、内容是什么"决定，不受目录遍历顺序影响。
  const relPaths = collectRuntimeFiles(sourceRoot).sort();
  if (relPaths.length === 0) return { ok: false, reason: "source_empty" };

  const files = [];
  for (const rel of relPaths) {
    let content;
    try { content = fs.readFileSync(path.join(sourceRoot, rel)); }
    catch { return { ok: false, reason: "source_unreadable", file: rel }; }
    files.push({ path: rel, sha256: sha256(content) });
  }
  // 版本号由内容决定：同样的源码算出同样的版本，重复安装就是无操作。
  const version = versionFromFiles(files);
  if (!version) return { ok: false, reason: "file_list_invalid" };
  const root = runtimeRoot(home);
  const current = verifyRuntime({ home });
  return {
    ok: true,
    version,
    files,
    sourceRoot,
    sourceCommit: sourceCommit(sourceRoot),
    runtimeRoot: root,
    versionDir: path.join(root, "versions", version),
    alreadyCurrent: current.ok && current.version === version,
    previousVersion: current.version ?? null,
  };
}

/**
 * 安装锁。两个克隆同时装会让 current 与 manifest 分属不同版本 —— 那是一个谁都没见过、
 * 也没人会去查的状态。用 mkdir 的原子性做锁，失败即放弃，不等待：安装本来就该是
 * 人显式发起的一次性动作，排队等另一个安装完成没有意义。
 */
function acquireInstallLock(root) {
  const dir = path.join(root, "install.lock");
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir);
    return { ok: true, release: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 已释放 */ } } };
  } catch {
    return { ok: false, reason: "install_locked" };
  }
}

const writeAtomic = (file, content) => {
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/**
 * 落盘，作为一次**事务**。
 *
 * 顺序：加锁 → 写 staging 目录 → manifest 写进版本目录内部 → 整体校验 →
 * 原子改名为不可变版本目录 → 切 current（唯一提交点）→ 最后才更新根 manifest 指针。
 *
 * 为什么不能只靠"符号链接切换是原子的"：那句话本身没错，但**整个安装不是一个事务**。
 * 上一版就栽在这里 —— Codex 用故障注入复现出 current 已指向新版本、根 manifest 仍是旧版本
 * 的状态，而此时 settings 早已指向 runtime/current，新代码已经生效且无从回滚。
 *
 * 现在版本目录是内容寻址且**不可变**：已经存在且自校验通过就直接复用，绝不原地覆盖
 *（原地覆盖一个内容寻址的目录本身就是矛盾的）。真正的提交点只有 current 那一次 rename；
 * 它之前的任何失败都不会改变线上正在跑的那份代码。
 */
export function applyRuntimeSync(plan, { home = os.homedir() } = {}) {
  if (!plan?.ok) return plan ?? { ok: false, reason: "plan_missing" };
  const root = runtimeRoot(home);
  const versionDir = path.join(root, "versions", plan.version);

  const lock = acquireInstallLock(root);
  if (!lock.ok) return lock;
  try {
    // 已是当前版本且自校验通过 → 真正的 no-op，不去动线上正在被加载的文件。
    const already = verifyRuntime({ home });
    if (already.ok && already.version === plan.version) {
      return { ok: true, version: plan.version, versionDir, noop: true };
    }

    // 版本目录内容寻址、不可变。"存在但校验不过"只能整体换掉，不能原地补写；
    // 而 rename 覆盖不了非空目录，所以先把坏的隔离出去再说。
    if (!verifyVersionDir(versionDir, plan.files).ok) {
      if (fs.existsSync(versionDir)) {
        const quarantine = path.join(root, "versions",
          ".corrupt-" + plan.version + "." + Date.now());
        try { fs.renameSync(versionDir, quarantine); }
        catch { return { ok: false, reason: "corrupt_version_dir_stuck", version: plan.version }; }
      }

      const staging = path.join(root, "versions", ".staging-" + plan.version + "." + process.pid);
      fs.rmSync(staging, { recursive: true, force: true });
      for (const file of plan.files) {
        const dest = path.join(staging, file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        const content = fs.readFileSync(path.join(plan.sourceRoot, file.path));
        if (sha256(content) !== file.sha256) {
          fs.rmSync(staging, { recursive: true, force: true });
          // 计划到落盘之间源码变了（切了分支、跑了 git checkout）。宁可整次失败，
          // 也不要装一份"清单与内容不符"的运行时。
          return { ok: false, reason: "source_changed_during_apply", file: file.path };
        }
        writeAtomic(dest, content);
      }
      // manifest 放在版本目录**内部**：一个版本完整与否，不依赖任何外部文件就能回答。
      writeAtomic(path.join(staging, MANIFEST_NAME), JSON.stringify({
        schema_version: "1.0",
        version: plan.version,
        installed_at: new Date().toISOString(),
        source_root: plan.sourceRoot,
        source_commit: plan.sourceCommit,
        files: plan.files,
      }, null, 2) + "\n");

      const staged = verifyVersionDir(staging, plan.files, { checkDirName: false });
      if (!staged.ok) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: "staging_verify_failed", detail: staged };
      }
      try {
        fs.renameSync(staging, versionDir);
      } catch {
        // 竞态：另一个安装刚把同一个版本改名过去了。内容寻址，那份和我们这份一样，
        // 下面那道闸会替我们确认这件事。
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }

    // **切 current 之前的最后一道闸。**三方必须逐字一致：目录里那份清单说的版本、
    // 目录名本身、本次计划的版本。任何一处对不上都说明这不是我们要提交的东西 ——
    // 宁可什么都不做，线上仍跑着旧版本，那是安全的。
    const ready = verifyVersionDir(versionDir, plan.files);
    if (!ready.ok || ready.manifest?.version !== plan.version ||
        path.basename(versionDir) !== plan.version) {
      return { ok: false, reason: "version_not_committable", version: plan.version };
    }

    // 唯一的提交点。此前任何失败，线上跑的都还是旧版本。
    const link = path.join(root, CURRENT_LINK);
    const linkTmp = link + ".tmp." + process.pid;
    try { fs.unlinkSync(linkTmp); } catch { /* 上次残留 */ }
    fs.symlinkSync(path.join("versions", plan.version), linkTmp);
    fs.renameSync(linkTmp, link);

    // 到这里就**提交完了**。刻意不再往根目录写一份"当前指向谁"的指针：
    // 它没有消费者，却凭空多出一份可能与 current 不一致的真相，还要为它单独处理
    // "写失败算不算安装失败"。current 这个符号链接本身就是唯一的、原子的答案。
    return { ok: true, version: plan.version, versionDir };
  } catch (err) {
    return { ok: false, reason: "apply_failed", error: String(err?.message ?? err).slice(0, 200) };
  } finally {
    lock.release();
  }
}

/**
 * 一个版本目录是不是完整、且它自己的清单可信。
 *
 * "可信"是重点：清单不能只被当成一份待核对的列表，它本身也要被核对。做法是从清单
 * 重算版本号，要求等于清单声明的 version，也等于目录名 —— 于是删条目、改哈希、
 * 换顺序都会让版本号对不上，改不动。
 */
function verifyVersionDir(dir, expectedFiles, { checkDirName = true } = {}) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf-8")); }
  catch { return { ok: false, reason: "manifest_absent" }; }
  const files = Array.isArray(manifest?.files) ? manifest.files : null;
  if (!files) return { ok: false, reason: "manifest_invalid" };

  const recomputed = versionFromFiles(files);
  if (!recomputed) return { ok: false, reason: "file_list_invalid", manifest };
  if (recomputed !== manifest.version) {
    return { ok: false, reason: "manifest_version_mismatch", manifest };
  }
  // staging 目录还没提升，名字是 .staging-<version>.<pid>，这一条只对已提升的版本目录成立。
  if (checkDirName && recomputed !== path.basename(dir)) {
    return { ok: false, reason: "version_dir_name_mismatch", manifest };
  }
  if (expectedFiles && recomputed !== versionFromFiles(expectedFiles)) {
    return { ok: false, reason: "plan_version_mismatch", manifest };
  }

  const drifted = [];
  const missing = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(dir, file.path)); }
    catch { missing.push(file.path); continue; }
    if (sha256(content) !== file.sha256) drifted.push(file.path);
  }
  return { ok: drifted.length === 0 && missing.length === 0, drifted, missing, manifest };
}

/**
 * 线上这份运行时还是不是它自己清单说的那一份。
 *
 * 存在的理由很具体：这套东西的失败是**安静**的。有人手改了 current 下的某个脚本、
 * 或者符号链接被指到别处，出站会照跑，只是行为不再对应任何一次有记录的安装。
 * 有了逐文件哈希，「线上跑的是哪份代码」就变成一个可以回答的问题。
 *
 * 真相取自 current 指向的那个版本目录内部的清单，不取根目录那份指针 —— 后者只是便利，
 * 而且它可能比 current 落后一步（切链接与写指针之间失败过）。
 */
export function verifyRuntime({ home = os.homedir() } = {}) {
  const root = runtimeRoot(home);
  let linkTarget = null;
  try { linkTarget = fs.readlinkSync(path.join(root, CURRENT_LINK)); } catch {
    return { ok: false, reason: "current_absent", linkOk: false, drifted: [], missing: [] };
  }
  const versionDir = path.join(root, linkTarget);
  const checked = verifyVersionDir(versionDir, null);
  if (!checked.manifest) {
    return { ok: false, reason: checked.reason, linkOk: false, drifted: [], missing: [] };
  }
  const version = checked.manifest.version;
  // 链接必须指向它自己声称的那个版本目录 —— 否则就是有人手工把 current 指歪了。
  const linkOk = linkTarget === path.join("versions", version);
  return {
    ok: linkOk && checked.ok,
    // 失败原因要传出去。这套东西的失败本来就安静，再吞掉原因就只剩"坏了"两个字，
    // 而"清单被改过"和"某个文件被手改"需要的处置完全不同。
    reason: checked.ok ? (linkOk ? null : "current_link_mismatch") : checked.reason,
    version,
    sourceCommit: checked.manifest.source_commit ?? null,
    linkOk,
    linkTarget,
    drifted: checked.drifted ?? [],
    missing: checked.missing ?? [],
  };
}
