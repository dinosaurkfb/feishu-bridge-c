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
  const relPaths = collectRuntimeFiles(sourceRoot);
  if (relPaths.length === 0) return { ok: false, reason: "source_empty" };

  const files = [];
  for (const rel of relPaths) {
    let content;
    try { content = fs.readFileSync(path.join(sourceRoot, rel)); }
    catch { return { ok: false, reason: "source_unreadable", file: rel }; }
    files.push({ path: rel, sha256: sha256(content) });
  }
  // 版本号由内容决定：同样的源码算出同样的版本，重复安装就是无操作。
  const version = sha256(files.map((f) => f.path + ":" + f.sha256).join("\n")).slice(0, 16);
  const root = runtimeRoot(home);
  const current = readRuntimeManifest({ home });
  return {
    ok: true,
    version,
    files,
    sourceRoot,
    sourceCommit: sourceCommit(sourceRoot),
    runtimeRoot: root,
    versionDir: path.join(root, "versions", version),
    alreadyCurrent: current.ok && current.manifest.version === version,
    previousVersion: current.ok ? current.manifest.version : null,
  };
}

export function readRuntimeManifest({ home = os.homedir() } = {}) {
  const file = path.join(runtimeRoot(home), MANIFEST_NAME);
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof manifest?.version !== "string" || !Array.isArray(manifest?.files)) {
      return { ok: false, reason: "manifest_invalid" };
    }
    return { ok: true, manifest };
  } catch {
    return { ok: false, reason: "manifest_absent" };
  }
}

/**
 * 落盘。顺序刻意如此：**先把整个版本目录写完整，再切 current，最后写清单。**
 *
 * 切换用 rename 覆盖一个临时符号链接，是原子操作 —— 任何时刻 `current` 要么指向旧版本、
 * 要么指向新版本，不存在指向半个目录的中间态。清单最后写，所以「清单说的版本」永远
 * 是一个已经完整落盘并已被 current 指向的版本。
 */
export function applyRuntimeSync(plan, { home = os.homedir() } = {}) {
  if (!plan?.ok) return plan ?? { ok: false, reason: "plan_missing" };
  const root = runtimeRoot(home);
  const versionDir = path.join(root, "versions", plan.version);

  try {
    for (const file of plan.files) {
      const dest = path.join(versionDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const content = fs.readFileSync(path.join(plan.sourceRoot, file.path));
      if (sha256(content) !== file.sha256) {
        // 计划到落盘之间源码变了。宁可整次失败，也不要装一份「清单与内容不符」的运行时。
        return { ok: false, reason: "source_changed_during_apply", file: file.path };
      }
      const tmp = dest + ".tmp." + process.pid;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      fs.renameSync(tmp, dest);
    }

    const link = path.join(root, CURRENT_LINK);
    const linkTmp = link + ".tmp." + process.pid;
    try { fs.unlinkSync(linkTmp); } catch { /* 上次残留 */ }
    fs.symlinkSync(path.join("versions", plan.version), linkTmp);
    fs.renameSync(linkTmp, link);

    const manifest = {
      schema_version: "1.0",
      version: plan.version,
      installed_at: new Date().toISOString(),
      source_root: plan.sourceRoot,
      source_commit: plan.sourceCommit,
      files: plan.files,
    };
    const manifestPath = path.join(root, MANIFEST_NAME);
    const manifestTmp = manifestPath + ".tmp." + process.pid;
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(manifestTmp, manifestPath);
    return { ok: true, version: plan.version, versionDir, manifest };
  } catch (err) {
    return { ok: false, reason: "apply_failed", error: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * 线上这份运行时还是不是清单说的那一份。
 *
 * 存在的理由很具体：这套东西的失败是**安静**的。有人手改了 current 下的某个脚本、
 * 或者符号链接被指到别处，出站会照跑，只是行为不再对应任何一次有记录的安装。
 * 有了逐文件哈希，「线上跑的是哪份代码」就变成一个可以回答的问题。
 */
export function verifyRuntime({ home = os.homedir() } = {}) {
  const loaded = readRuntimeManifest({ home });
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const root = runtimeRoot(home);
  const versionDir = path.join(root, "versions", loaded.manifest.version);

  let linkTarget = null;
  try { linkTarget = fs.readlinkSync(path.join(root, CURRENT_LINK)); } catch { /* 没有链接 */ }
  const linkOk = linkTarget === path.join("versions", loaded.manifest.version);

  const drifted = [];
  const missing = [];
  for (const file of loaded.manifest.files) {
    let content;
    try { content = fs.readFileSync(path.join(versionDir, file.path)); }
    catch { missing.push(file.path); continue; }
    if (sha256(content) !== file.sha256) drifted.push(file.path);
  }
  return {
    ok: linkOk && drifted.length === 0 && missing.length === 0,
    version: loaded.manifest.version,
    sourceCommit: loaded.manifest.source_commit ?? null,
    linkOk,
    linkTarget,
    drifted,
    missing,
  };
}
