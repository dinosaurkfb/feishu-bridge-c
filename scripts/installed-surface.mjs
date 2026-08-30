/**
 * 机器级**安装收据**（issue #81 维护门 PR B，方案稿"当前投影"）—— 安装器每次 --apply 记下"我往线上写了什么"。
 *
 *   · 位置：**每条链一份、随该链的隔离点走**（`installedSurfacePath`）：Claude `<home>/.claude/feishu-bridge/installed-surface.json`，
 *     Codex `<Codex 桥目录>/installed-surface.json`。安装器被 HOME / CODEX_HOME 引到沙箱时收据跟着进沙箱，不写真机；
 *     维护门预检（PR C）显式传真实 home 来读。只有测试隔离点 FEISHU_BRIDGE_INSTALLED_SURFACE 能覆盖。
 *     **不写进 versions/<v>/**：收据含机器相关路径与线上制品的 sha；版本目录是内容寻址的不可变缓存，只放静态模板。
 *   · 每个制品记 { path, kind, sha256 }。settings.json / hooks.json 记的是**桥拥有的封闭条目**（我们的 hook 条目 + 预览放行规则）
 *     序列化后的 sha，不是整文件 —— 无关设置的变化不该挡门。技能文件、plist 记整文件。
 *   · **sha 只认 64 位十六进制**：`artifactSha` 算不出来（"absent" / "unparseable"）只是本次计算的结果，**不能被持久化成预期值**
 *     —— 否则一份 hooks 损坏、预期也写成 unparseable 的收据会被读成合法且对账通过（评审探针）。记收据时遇到就整次拒绝。
 *   · 三态读取：absent 只有 ENOENT；valid = 形状逐字段受验（path / scripts 唯一、时间规范化）；其余 unreadable（畸形不自动覆盖、不自动删）。
 *   · 读收据与读线上制品都是 **fd 绑定读**：O_NOFOLLOW | O_NONBLOCK 打开、同一 fd fstat 只收 nlink = 1 的普通文件、从这个 fd 读 ——
 *     符号链接到同内容外部文件、命名管道、多硬链接都不算"线上制品还在"。
 *   · 记收据走**收据事务锁** `<收据>.lock`（复用 registry 的锁协议：symlink 原语、reap 段串行化回收、提交与释放按 token 归属转换）：
 *     同一条链由多个安装器分别写（出站 / 入站），无锁的读—合并—写会丢另一侧的条目；持锁超时被接管后晚到的提交 lock_lost。
 *     这把锁**不受机器门管**：维护门内部写收据也走它。锁位置上的未知制品不回收不删（surface_lock_residue，交人工）。
 *   · 预检（PR C）拿它与线上逐项对账：`compareInstalledSurface`。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeSettingsOwnedEntries } from "./install-projection.mjs";
import { acquireLockUngated, commitWhileHeld, releasePublishLock } from "./registry.mjs";

export const INSTALLED_SURFACE_ENV = "FEISHU_BRIDGE_INSTALLED_SURFACE";
export const INSTALLED_SURFACE_SCHEMA = "1.0";
export const ARTIFACT_KINDS = Object.freeze(["claude-settings", "codex-hooks", "skill", "plist", "file"]);
export const SURFACE_LOCK_STALE_MS = 60 * 1000;
const CHAINS = ["claude", "codex"];
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
const VERSION_SHAPE = /^[0-9a-f]{16}$/u;
const SCRIPT_SHAPE = /^(codex\/)?[A-Za-z0-9_.-]+\.mjs$/u;

/**
 * 收据文件随**各链的隔离点**走（安装器可以被 HOME / CODEX_HOME 引到沙箱，收据必须跟着进沙箱，不能写真机）：
 *   claude → `<home>/.claude/feishu-bridge/installed-surface.json`；codex → `<codex 桥目录>/installed-surface.json`。
 * 维护门预检（PR C）显式传真实 home（realUserHome）来读。测试隔离点 FEISHU_BRIDGE_INSTALLED_SURFACE 覆盖一切。
 */
export function installedSurfacePath({ chain, home = os.homedir(), codexBridgeHome = null, env = process.env } = {}) {
  const override = env[INSTALLED_SURFACE_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  if (chain === "codex") return codexBridgeHome ? path.join(codexBridgeHome, "installed-surface.json") : null;
  return path.join(home, ".claude", "feishu-bridge", "installed-surface.json");
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const errCode = (err) => String(err?.code ?? err?.message ?? err);

/**
 * fd 绑定读一个普通文件：O_RDONLY | O_NONBLOCK | O_NOFOLLOW 打开 → 同一 fd fstat 只收 nlink = 1 的普通文件 → 从这个 fd 读。
 * @returns {{ status:"absent" } | { status:"unreadable", why:string } | { status:"read", buf:Buffer }}
 */
export function readRegularFile(file) {
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err?.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", why: err?.code === "ELOOP" ? "不是普通文件（符号链接）" : "打不开：" + errCode(err) };
    }
    let st;
    try { st = fs.fstatSync(fd); } catch (err) { return { status: "unreadable", why: "fstat 失败：" + errCode(err) }; }
    if (!st.isFile()) return { status: "unreadable", why: "不是普通文件" };
    if (st.nlink !== 1) return { status: "unreadable", why: "不是单硬链接的普通文件（nlink=" + st.nlink + "）" };
    try { return { status: "read", buf: fs.readFileSync(fd) }; } catch (err) { return { status: "unreadable", why: "读失败：" + errCode(err) }; }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

/**
 * 制品的收据 sha：settings / hooks 只算桥拥有的封闭条目；其余整文件。
 * text 为 null（缺席）→ "absent"；解析不了 → "unparseable"。这两个只是**本次计算的结果**，记收据时不接受（见文件头）。
 * codex-hooks 的封闭条目提取器由调用方注入（extractors["codex-hooks"]）—— 这个共用模块不 import codex 目录（依赖单向）。
 */
export function artifactSha({ kind, text, home, node, extractors = {} }) {
  if (text === null || text === undefined) return "absent";
  const str = Buffer.isBuffer(text) ? text.toString("utf-8") : String(text);
  if (kind === "claude-settings") {
    const owned = claudeSettingsOwnedEntries(str, { home, node });
    return owned === null ? "unparseable" : sha256(JSON.stringify(owned));
  }
  if (kind === "codex-hooks") {
    const extract = extractors["codex-hooks"];
    if (typeof extract !== "function") return "unparseable";
    const owned = extract(str);
    return owned === null ? "unparseable" : sha256(JSON.stringify(owned));
  }
  return sha256(Buffer.isBuffer(text) ? text : Buffer.from(str, "utf-8"));
}

const isCanonicalIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

function artifactProblem(a) {
  if (a === null || typeof a !== "object" || Array.isArray(a)) return "制品不是对象";
  if (Object.keys(a).sort().join(",") !== "kind,path,sha256") return "制品字段集不对";
  if (typeof a.path !== "string" || !path.isAbsolute(a.path)) return "制品 path 不是绝对路径";
  if (!ARTIFACT_KINDS.includes(a.kind)) return "制品 kind 不在受控集合里";
  if (typeof a.sha256 !== "string" || !SHA_SHAPE.test(a.sha256)) return "制品 sha256 不是 64 位十六进制字符串（absent / unparseable 不能当预期值）";
  return null;
}
function chainProblem(c) {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return "链条目不是对象";
  if (Object.keys(c).sort().join(",") !== "artifacts,at,scripts,version") return "链条目字段集不对";
  if (typeof c.version !== "string" || !VERSION_SHAPE.test(c.version)) return "version 不是 16 位十六进制字符串";
  if (!isCanonicalIso(c.at)) return "at 不是规范化的 ISO 时间";
  if (!Array.isArray(c.artifacts)) return "artifacts 不是数组";
  for (const a of c.artifacts) { const p = artifactProblem(a); if (p !== null) return p; }
  if (new Set(c.artifacts.map((a) => a.path)).size !== c.artifacts.length) return "制品 path 重复";
  if (!Array.isArray(c.scripts) || c.scripts.some((s) => typeof s !== "string" || !SCRIPT_SHAPE.test(s))) return "scripts 形状不对";
  if (new Set(c.scripts).size !== c.scripts.length) return "scripts 重复";
  return null;
}
export function installedSurfaceProblem(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是对象";
  if (doc.schema_version !== INSTALLED_SURFACE_SCHEMA) return "schema_version 不认识";
  if (Object.keys(doc).sort().join(",") !== "chains,schema_version") return "字段集不对";
  if (doc.chains === null || typeof doc.chains !== "object" || Array.isArray(doc.chains)) return "chains 不是对象";
  for (const k of Object.keys(doc.chains)) {
    if (!CHAINS.includes(k)) return "chains 里有不认识的链：" + k;
    const p = chainProblem(doc.chains[k]); if (p !== null) return k + "：" + p;
  }
  return null;
}

/** 三态读收据（fd 绑定读）。 */
export function readInstalledSurface({ file } = {}) {
  if (typeof file !== "string" || file.length === 0) return { state: "unreadable", why: "收据位置说不清" };
  const r = readRegularFile(file);
  if (r.status === "absent") return { state: "absent" };
  if (r.status !== "read") return { state: "unreadable", why: r.why };
  let doc;
  try { doc = JSON.parse(r.buf.toString("utf-8")); } catch (err) { return { state: "unreadable", why: "不是 JSON：" + errCode(err) }; }
  const problem = installedSurfaceProblem(doc);
  return problem === null ? { state: "valid", doc } : { state: "unreadable", why: "形状不对：" + problem };
}

// ── 收据事务锁：复用 registry 的锁协议（symlink 原语、陈旧回收在 reap 段串行化、提交 / 释放按 token 归属转换），
// **不看机器门**（维护门内部写收据也走这里）。锁位置上不是 symlink、或 payload 不是本协议形状 → surface_lock_residue：
// 不回收、不删、交人工（热路径不能有"什么都能删"的口子）。持锁超过 SURFACE_LOCK_STALE_MS 会被合法接管：
// 晚到的旧持有者在 commit 时会因 token 对不上得到 lock_lost，写不进去。
/**
 * 在收据事务锁内跑 fn({ commit })。commit(g) 在 reap 段内核对锁仍是本实例再跑 g（fencing）。
 * @returns {{ ok:true, run:any, lockUncleared?:object } | { ok:false, reason:"surface_busy"|"surface_lock_residue"|"io_error", why?:string, path?:string }}
 */
export function withInstalledSurfaceLock(file, fn, { waitMs = 5000, staleMs = SURFACE_LOCK_STALE_MS } = {}) {
  const lock = file + ".lock";
  const deadline = Date.now() + waitMs;
  for (;;) {
    let st = null;
    try { st = fs.lstatSync(lock); }
    catch (err) { if (err?.code !== "ENOENT") return { ok: false, reason: "surface_lock_residue", why: "锁位置 lstat 失败：" + errCode(err), path: lock }; }
    if (st !== null && !st.isSymbolicLink()) return { ok: false, reason: "surface_lock_residue", why: "锁位置上不是本协议的 symlink（保留现场，交人工）", path: lock };
    const got = acquireLockUngated(lock, { staleMs, reapUnrecognized: false });
    if (got.ok) break;
    if (got.reason === "lock_residue" || got.reason === "reap_residue") return { ok: false, reason: "surface_lock_residue", why: got.reason + "（保留现场，交人工）", path: lock };
    if (got.reason !== "publisher_busy" && got.reason !== "reap_busy") return { ok: false, reason: "io_error", why: got.reason + (got.error ? "：" + got.error : "") };
    if (Date.now() >= deadline) return { ok: false, reason: "surface_busy" };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  let out;
  try { out = { ok: true, run: fn({ commit: (g) => commitWhileHeld(lock, g) }) }; }
  finally {
    const rel = releasePublishLock(lock);
    if (!rel.ok && out !== undefined) out = { ...out, lockUncleared: { path: lock, reason: rel.reason } };
  }
  return out;
}

/** 同目录唯一临时名写全（O_EXCL | O_NOFOLLOW）→ fsync；rename 由调用方在 fencing 段内做。 */
function writeTmp(file, text) {
  const tmp = path.join(path.dirname(file), ".installed-surface." + process.pid + "." + crypto.randomUUID() + ".tmp");
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return tmp;
}

/**
 * 记收据（安装器 --apply 末尾、全部制品写完之后调用）：锁内重读 → 这条链按 path 合并本次写的制品（同版本合并、版本变了整体换）→ 原子写。
 *   · 任一制品 sha 不是 64 位十六进制 → 整次拒绝 artifact_sha_unusable（不把 absent / unparseable 写成预期值）；
 *   · 收据 unreadable → 不覆盖 surface_unreadable，交人工；锁忙 → surface_busy。
 */
export function recordInstalledSurface({ chain, version, artifacts, scripts, file, now = Date.now(), waitMs = 5000, beforeCommit = null }) {
  if (!CHAINS.includes(chain)) return { ok: false, reason: "chain_unknown" };
  if (typeof file !== "string" || file.length === 0) return { ok: false, reason: "surface_path_unknown" };
  if (!Array.isArray(artifacts) || !Array.isArray(scripts)) return { ok: false, reason: "entry_shape", why: "artifacts / scripts 不是数组" };
  const bad = artifacts.find((a) => typeof a?.sha256 !== "string" || !SHA_SHAPE.test(a.sha256));
  if (bad) return { ok: false, reason: "artifact_sha_unusable", path: bad?.path, sha256: bad?.sha256 };
  if (new Set(artifacts.map((a) => a.path)).size !== artifacts.length) return { ok: false, reason: "entry_shape", why: "本次制品 path 重复" };
  // 目录在锁外先建好：让"去掉事务锁"这种变异死在并发测试上，而不是死在 ENOENT 上
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch (err) { return { ok: false, reason: "io_error", why: errCode(err) }; }
  const locked = withInstalledSurfaceLock(file, ({ commit }) => {
    const current = readInstalledSurface({ file });
    if (current.state === "unreadable") return { ok: false, reason: "surface_unreadable", why: current.why };
    const doc = current.state === "valid" ? current.doc : { schema_version: INSTALLED_SURFACE_SCHEMA, chains: {} };
    const prev = doc.chains[chain];
    const sameVersion = prev && prev.version === version;
    const keep = sameVersion ? prev.artifacts.filter((a) => !artifacts.some((b) => b.path === a.path)) : [];
    const keepScripts = sameVersion ? prev.scripts : [];
    const entry = {
      version, at: new Date(now).toISOString(),
      artifacts: [...keep, ...artifacts.map((a) => ({ path: a.path, kind: a.kind, sha256: a.sha256 }))].sort((a, b) => a.path.localeCompare(b.path)),
      scripts: [...new Set([...keepScripts, ...scripts])].sort(),
    };
    const problem = chainProblem(entry);
    if (problem !== null) return { ok: false, reason: "entry_shape", why: problem };
    const next = { schema_version: INSTALLED_SURFACE_SCHEMA, chains: { ...doc.chains, [chain]: entry } };
    let tmp;
    try { tmp = writeTmp(file, JSON.stringify(next, null, 2) + "\n"); }
    catch (err) { return { ok: false, reason: "io_error", why: errCode(err) }; }
    if (typeof beforeCommit === "function") beforeCommit(); // 只给测试用：在"写满临时文件"与"fencing 提交"之间插动作
    // 提交（rename）在 reap 段内核对锁仍是本实例：我持锁期间停顿超过 staleMs 被合法接管的话，这里 lock_lost，不覆盖新持有者写的
    const c = commit(() => { try { fs.renameSync(tmp, file); return null; } catch (err) { return errCode(err); } });
    if (!c.ok) { try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } return { ok: false, reason: c.reason === "lock_lost" ? "lock_lost" : "io_error", why: "提交前核对锁归属：" + c.reason }; }
    if (c.run !== null) { try { fs.unlinkSync(tmp); } catch { /* 留给人 */ } return { ok: false, reason: "io_error", why: c.run }; }
    return { ok: true, file, entry };
  }, { waitMs });
  return locked.ok ? locked.run : locked;
}

/**
 * 用收据对线上逐项对账（预检用）：每个制品 fd 绑定读线上字节 → 按 kind 算 sha → 与收据比。
 * 缺席 → actual "absent"；符号链接 / 管道 / 多硬链接 / 打不开 → actual "unreadable:<why>"；都算对不上。
 * @returns {{ state: "absent"|"unreadable"|"checked", ok?: boolean, mismatches?: {path, expected, actual}[], version?: string, scripts?: string[] }}
 */
export function compareInstalledSurface({ chain, file, home, node, extractors = {} } = {}) {
  const r = readInstalledSurface({ file });
  if (r.state !== "valid") return r;
  const entry = r.doc.chains[chain];
  if (!entry) return { state: "absent", why: "收据里没有这条链" };
  const mismatches = [];
  for (const a of entry.artifacts) {
    const read = readRegularFile(a.path);
    const actual = read.status === "read" ? artifactSha({ kind: a.kind, text: read.buf, home, node, extractors })
      : read.status === "absent" ? "absent" : "unreadable:" + read.why;
    if (actual !== a.sha256) mismatches.push({ path: a.path, expected: a.sha256, actual });
  }
  return { state: "checked", ok: mismatches.length === 0, mismatches, version: entry.version, scripts: entry.scripts };
}
