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
export function withInstalledSurfaceLock(file, fn, { waitMs = 5000, staleMs = SURFACE_LOCK_STALE_MS, acquire = acquireLockUngated, release = releasePublishLock } = {}) {
  const lock = file + ".lock";
  const deadline = Date.now() + waitMs;
  const residues = []; // 释放阶段（含提交段的 reap 锁）的残骸收在这里：段内做的事算数，残骸点名路径交盘点
  const withResidues = (r) => (residues.length === 0 ? r : { ...r, lockUncleared: residues[0], lockResidues: [...residues] });
  for (;;) {
    let st = null;
    try { st = fs.lstatSync(lock); }
    catch (err) { if (err?.code !== "ENOENT") return withResidues({ ok: false, reason: "surface_lock_residue", why: "锁位置 lstat 失败：" + errCode(err), path: lock }); }
    if (st !== null && !st.isSymbolicLink()) return withResidues({ ok: false, reason: "surface_lock_residue", why: "锁位置上不是本协议的 symlink（保留现场，交人工）", path: lock });
    // 取锁阶段的 I/O 异常同样受控（评审探针：陈旧回收隔离后 rmSync 抛 EIO 穿出来）
    let got;
    // 收据锁也走原语的默认 fail-closed：陈旧回收隔离后删不掉（reaped_uncleared）就不取锁、不写 —— 残骸 .reaped-<uuid> 由盘点点名。
    // （symlink 原语上这一步实际到不了：rename 成功而 unlink 失败要目录权限中途变化；不为到不了的路径留一个没人消费的选项。）
    try { got = acquire(lock, { staleMs, reapUnrecognized: false }); }
    catch (err) { return withResidues({ ok: false, reason: "io_error", why: "取锁阶段异常：" + errCode(err), path: lock }); }
    if (got?.ok) break;
    if (got?.reason === "reaped_uncleared") return withResidues({ ok: false, reason: "surface_lock_residue", why: "陈旧锁隔离后删不掉：" + String(got.error) + "（" + String(got.path) + "，只人工删）", path: String(got.path) });
    if (got?.reason === "reap_uncleared") return withResidues({ ok: false, reason: "surface_lock_residue", why: "归属转换锁交不还：" + String(got.error) + "（" + String(got.path) + "，node scripts/repair-publish-lock.mjs --lock " + lock + " --apply 能清）", path: String(got.path) });
    if (got?.reason === "lock_residue" || got?.reason === "reap_residue") return withResidues({ ok: false, reason: "surface_lock_residue", why: got.reason + "（保留现场，交人工）", path: lock });
    if (got?.reason !== "publisher_busy" && got?.reason !== "reap_busy") return withResidues({ ok: false, reason: "io_error", why: String(got?.reason) + (got?.error ? "：" + got.error : "") });
    if (Date.now() >= deadline) return withResidues({ ok: false, reason: "surface_busy" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  let out;
  try { out = { ok: true, run: fn({ commit: (g) => commitWhileHeld(lock, g) }) }; }
  finally {
    // 释放是归属转换，失败**不裸抛、不吞**：抛错 → release_threw；reap 锁交不还 → reap_uncleared；其余按它的 reason。
    try {
      const rel = release(lock);
      if (rel?.reapUncleared) residues.push({ path: rel.reapUncleared.path, reason: "reap_uncleared", error: rel.reapUncleared.error });
      // not_owner = 锁已被别人按协议合法接管（提交侧已报 lock_lost）：那把不是我的，不算我的残骸
      else if (!rel?.ok && rel?.reason !== "not_owner") residues.push({ path: lock, reason: String(rel?.reason ?? "release_failed") });
    } catch (err) { residues.push({ path: lock, reason: "release_threw", error: errCode(err) }); }
    if (out !== undefined) out = withResidues(out);
  }
  return out;
}

/** 删自己的临时文件：删掉或本来就不在 → null；删不掉 → { path, error }（残骸，要报出去、可盘点）。 */
function discardTmp(tmp) {
  try { fs.unlinkSync(tmp); return null; }
  catch (err) { return err?.code === "ENOENT" ? null : { path: tmp, error: errCode(err) }; }
}
/**
 * 同目录唯一临时名写全（O_EXCL | O_NOFOLLOW）→ fsync；rename 由调用方在 fencing 段内做。
 * 写 / fsync 失败就地清掉自己的临时文件，清不掉带 tmpResidue 回去 —— 不静默遗留。afterWrite 只给测试注入故障。
 */
function writeTmp(file, text, afterWrite = null) {
  const tmp = path.join(path.dirname(file), ".installed-surface." + process.pid + "." + crypto.randomUUID() + ".tmp");
  let fd = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, text);
    if (typeof afterWrite === "function") afterWrite(tmp);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    return { ok: true, tmp };
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
    const residue = discardTmp(tmp);
    return { ok: false, why: errCode(err), ...(residue ? { tmpResidue: residue } : {}) };
  }
}

/**
 * 记收据（安装器 --apply 末尾、全部制品写完之后调用）：锁内重读 → 这条链按 path 合并本次写的制品（同版本合并、版本变了整体换）→ 原子写。
 *   · 任一制品 sha 不是 64 位十六进制 → 整次拒绝 artifact_sha_unusable（不把 absent / unparseable 写成预期值）；
 *   · 收据 unreadable → 不覆盖 surface_unreadable，交人工；锁忙 → surface_busy。
 */
export function recordInstalledSurface({ chain, version, artifacts, scripts, file, now = Date.now(), waitMs = 5000, testHooks = {} }) {
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
    const w = writeTmp(file, JSON.stringify(next, null, 2) + "\n", testHooks.afterTmpWrite ?? null);
    if (!w.ok) return { ok: false, reason: "io_error", why: w.why, ...(w.tmpResidue ? { tmpResidue: w.tmpResidue } : {}) };
    const tmp = w.tmp;
    if (typeof testHooks.beforeCommit === "function") testHooks.beforeCommit(); // 只给测试用：在"写满临时文件"与"fencing 提交"之间插动作
    // 提交（rename）在 reap 段内核对锁仍是本实例：我持锁期间停顿超过 staleMs 被合法接管的话，这里 lock_lost，不覆盖新持有者写的
    const c = commit(() => { try { fs.renameSync(tmp, file); return null; } catch (err) { return errCode(err); } });
    const carry = c.reapUncleared ? { lockUncleared: { path: c.reapUncleared.path, reason: "reap_uncleared", error: c.reapUncleared.error } } : {};
    if (!c.ok) { const residue = discardTmp(tmp); return { ok: false, reason: c.reason === "lock_lost" ? "lock_lost" : "io_error", why: "提交前核对锁归属：" + c.reason, ...(residue ? { tmpResidue: residue } : {}), ...carry }; }
    if (c.run !== null) { const residue = discardTmp(tmp); return { ok: false, reason: "io_error", why: c.run, ...(residue ? { tmpResidue: residue } : {}), ...carry }; }
    return { ok: true, file, entry, ...carry };
  }, { waitMs, acquire: testHooks.acquire ?? acquireLockUngated, release: testHooks.release ?? releasePublishLock });
  if (!locked.ok) return locked;
  // 提交 / 释放两处的残骸都要进最终结果：只返回 locked.run 会把它丢掉（评审探针）
  const all = [...(locked.run.lockResidues ?? (locked.run.lockUncleared ? [locked.run.lockUncleared] : [])), ...(locked.lockResidues ?? [])];
  return all.length === 0 ? locked.run : { ...locked.run, lockUncleared: all[0], lockResidues: all };
}

/**
 * 盘点（只读，不修）：收据三态 + 锁家族残骸 + 写收据的临时文件残骸。doctor ⑪ 与显式维护入口用。
 *   · 锁家族按**封闭名字**识别，处置方式各不相同：主锁 `<收据>.lock`（持有者不在 / 超时 → 下次记收据按协议回收 / 接管）、
 *     `.lock.reap`（reap 锁残骸 → repair-publish-lock --lock 清）、`.lock.maint`（维护锁残骸 → 不自动恢复，人工确认后手动删）、
 *     `.lock.reaped-<uuid>`（陈旧回收隔离后删不掉的旧实例 → 已离开原路径，人工删）、`.lock.reap.quarantine-<uuid>`（reap 残骸隔离后删不掉 → repair-publish-lock）；
 *     不是 symlink / payload 畸形 / 名字像但不合形状 → unknown，只人工处置。
 *   · 目录读不出（除 ENOENT）→ inventory:"unreadable" 并作为一条残骸点名目录 —— 不能折成"没有残骸"（评审探针：EIO 下 doctor 假绿）。
 * @returns {{ state, why?, doc?, inventory:"ok"|"unreadable"|"unknown", residues: { path, kind, detail }[] }}
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TMP_SHAPE = /^\.installed-surface\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
export function inspectInstalledSurface({ file, now = Date.now() } = {}) {
  const r = readInstalledSurface({ file });
  const residues = [];
  if (typeof file !== "string" || file.length === 0) return { ...r, inventory: "unknown", residues };
  const dir = path.dirname(file), lockName = path.basename(file) + ".lock", lockPath = path.join(dir, lockName);
  const repairHint = "node scripts/repair-publish-lock.mjs --lock " + lockPath + " --apply 能清";
  const family = {
    lock: { dead: (o) => "持有者 pid " + o.pid + " 已不在 —— 下次记收据时按协议回收", stale: (o, sec) => "持有者 pid " + o.pid + " 仍在但已超时 " + sec + " 秒 —— 下次记收据时按协议接管（它晚到的提交会 lock_lost）" },
    reap: { dead: (o) => "reap 锁残骸（回收者 pid " + o.pid + " 崩在段里）—— 记收据会 reap_residue 拒绝；" + repairHint, stale: (o, sec) => "reap 锁被 pid " + o.pid + " 持有已 " + sec + " 秒（段只有几毫秒）—— 记收据会 reap_residue 拒绝；" + repairHint },
    maint: { dead: (o) => "维护锁残骸（维护者 pid " + o.pid + " 已不在）—— 只挡维护入口（maintenance_busy），不自动恢复；人工确认没有维护者在跑后手动删", stale: (o, sec) => "维护锁被 pid " + o.pid + " 持有已 " + sec + " 秒 —— 只挡维护入口，不自动恢复；人工确认后手动删" },
  };
  const lockInfo = (name, kind) => {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch (err) { if (err?.code !== "ENOENT") residues.push({ path: p, kind, detail: "lstat 失败：" + errCode(err) + " —— 只人工处置" }); return; }
    if (!st.isSymbolicLink()) { residues.push({ path: p, kind: "unknown", detail: kind + " 位置上不是本协议的 symlink —— 只人工处置" }); return; }
    let owner = null;
    try { owner = JSON.parse(fs.readlinkSync(p)); } catch { owner = null; }
    const shapeOk = owner !== null && typeof owner === "object" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && isCanonicalIso(owner.at) && typeof owner.token === "string" && owner.token.length > 0;
    if (!shapeOk) { residues.push({ path: p, kind: "unknown", detail: kind + " 的 payload 畸形 —— 只人工处置" }); return; }
    let alive = true;
    try { process.kill(owner.pid, 0); } catch { alive = false; }
    const sec = Math.floor((now - Date.parse(owner.at)) / 1000);
    if (!alive) residues.push({ path: p, kind, detail: family[kind].dead(owner) });
    else if (now - Date.parse(owner.at) > SURFACE_LOCK_STALE_MS) residues.push({ path: p, kind, detail: family[kind].stale(owner, sec) });
  };
  lockInfo(lockName, "lock"); lockInfo(lockName + ".reap", "reap"); lockInfo(lockName + ".maint", "maint");
  let names;
  try { names = fs.readdirSync(dir); }
  catch (err) {
    if (err?.code === "ENOENT") names = [];
    else { residues.push({ path: dir, kind: "inventory", detail: "目录盘点失败：" + errCode(err) + " —— 残骸情况说不清，请人工核对" }); return { ...r, inventory: "unreadable", residues }; }
  }
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    if (n === lockName || n === lockName + ".reap" || n === lockName + ".maint") continue;
    if (n.startsWith(lockName + ".reaped-")) {
      const ok = UUID_SHAPE.test(n.slice(lockName.length + ".reaped-".length));
      residues.push(ok ? { path: full, kind: "reaped", detail: "陈旧回收隔离后删不掉的旧锁实例 —— 已离开原路径、不涉及归属，人工删即可" } : { path: full, kind: "unknown", detail: "像 .reaped-<uuid> 但不合形状 —— 不认识的制品，只人工处置" });
      continue;
    }
    if (n.startsWith(lockName + ".reap.quarantine-")) {
      const ok = UUID_SHAPE.test(n.slice(lockName.length + ".reap.quarantine-".length));
      residues.push(ok ? { path: full, kind: "reap-quarantine", detail: "reap 锁残骸隔离后删不掉 —— " + repairHint } : { path: full, kind: "unknown", detail: "像 .reap.quarantine-<uuid> 但不合形状 —— 不认识的制品，只人工处置" });
      continue;
    }
    if (n.startsWith(lockName)) { residues.push({ path: full, kind: "unknown", detail: "锁家族里不认识的制品 —— 只人工处置" }); continue; }
    if (n.startsWith(".installed-surface.")) residues.push(TMP_SHAPE.test(n) ? { path: full, kind: "tmp", detail: "写收据的临时文件残骸（写满与提交之间崩了、或删不掉）—— 人工删即可" } : { path: full, kind: "unknown", detail: "像写收据的临时文件但不合形状 —— 只人工处置" });
  }
  return { ...r, inventory: "ok", residues };
}

/**
 * 安装器汇报收据结果的唯一口径：{ text, failed }。有残骸（锁交不还 / 临时文件删不掉）或没记下 → failed，安装器据此非零退出并点名路径。
 */
export function receiptReport(receipt, { artifacts = 0, scripts = 0 } = {}) {
  const residues = [];
  for (const l of receipt?.lockResidues ?? (receipt?.lockUncleared ? [receipt.lockUncleared] : [])) residues.push("锁残骸 " + l.path + "（" + l.reason + (l.error ? "：" + l.error : "") + "）");
  if (receipt?.tmpResidue) residues.push("临时文件残骸 " + receipt.tmpResidue.path + "（" + receipt.tmpResidue.error + "）");
  if (receipt?.ok && residues.length === 0) return { text: "已记（" + artifacts + " 个制品，" + scripts + " 个脚本）", failed: false };
  if (receipt?.ok) return { text: "已记（" + artifacts + " 个制品，" + scripts + " 个脚本），**但留下了残骸**：" + residues.join("；") + " —— 请人工处置（doctor ⑪ 能看到）", failed: true };
  return { text: "**没记下**（" + String(receipt?.reason) + (receipt?.why ? "：" + receipt.why : "") + (receipt?.path ? "，" + receipt.path : "") + "）" + (residues.length > 0 ? "；残骸：" + residues.join("；") : "") + " —— 维护门预检会拿不到当前投影，请人工处置", failed: true };
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
