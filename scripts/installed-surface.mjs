/**
 * 机器级**安装收据**（issue #81 维护门 PR B，方案稿"当前投影"）—— 安装器每次 --apply 记下"我往线上写了什么"。
 *
 *   · 位置：`<真实用户 home>/.claude/feishu-bridge/installed-surface.json`（两条链共用一份，按链 × 版本登记）；只有测试隔离点
 *     FEISHU_BRIDGE_INSTALLED_SURFACE 能覆盖。**不写进 versions/<v>/**：收据含机器相关路径与线上制品的 sha，
 *     同一版本在不同基线下重装会得到不同收据；版本目录是内容寻址的不可变缓存，只放静态模板。
 *   · 每个制品记 { path, kind, sha256 }。settings.json / hooks.json 记的是**桥拥有的封闭条目**（我们的 hook 条目 + 预览放行规则）
 *     序列化后的 sha，不是整文件 —— 无关设置的变化不该挡门。技能文件、plist 记整文件。
 *   · 三态读取：absent 只有 ENOENT；valid = 形状逐字段受验；其余 unreadable（畸形不自动覆盖、不自动删）。
 *   · 预检（PR C）拿它与线上逐项对账：`compareInstalledSurface`。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import os from "node:os";
import { claudeSettingsOwnedEntries } from "./install-projection.mjs";

export const INSTALLED_SURFACE_ENV = "FEISHU_BRIDGE_INSTALLED_SURFACE";
export const INSTALLED_SURFACE_SCHEMA = "1.0";
export const ARTIFACT_KINDS = Object.freeze(["claude-settings", "codex-hooks", "skill", "plist", "file"]);
const CHAINS = ["claude", "codex"];
const SHA_SHAPE = /^[0-9a-f]{64}$/u;
const VERSION_SHAPE = /^[0-9a-f]{16}$/u;

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

/**
 * 制品的收据 sha：settings / hooks 只算桥拥有的封闭条目；其余整文件。
 * text 为 null（缺席）→ sha 记 "absent"。
 * codex-hooks 的封闭条目提取器由调用方注入（extractors["codex-hooks"]）—— 这个共用模块不 import codex 目录（依赖单向）。
 */
export function artifactSha({ kind, text, home, node, extractors = {} }) {
  if (text === null || text === undefined) return "absent";
  if (kind === "claude-settings") {
    const owned = claudeSettingsOwnedEntries(text, { home, node });
    return owned === null ? "unparseable" : sha256(JSON.stringify(owned));
  }
  if (kind === "codex-hooks") {
    const extract = extractors["codex-hooks"];
    if (typeof extract !== "function") return "unparseable";
    const owned = extract(text);
    return owned === null ? "unparseable" : sha256(JSON.stringify(owned));
  }
  return sha256(Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf-8"));
}

function artifactProblem(a) {
  if (a === null || typeof a !== "object" || Array.isArray(a)) return "制品不是对象";
  if (Object.keys(a).sort().join(",") !== "kind,path,sha256") return "制品字段集不对";
  if (typeof a.path !== "string" || !path.isAbsolute(a.path)) return "制品 path 不是绝对路径";
  if (!ARTIFACT_KINDS.includes(a.kind)) return "制品 kind 不在受控集合里";
  if (!(a.sha256 === "absent" || a.sha256 === "unparseable" || SHA_SHAPE.test(String(a.sha256)))) return "制品 sha256 形状不对";
  return null;
}
function chainProblem(c) {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return "链条目不是对象";
  if (Object.keys(c).sort().join(",") !== "artifacts,at,scripts,version") return "链条目字段集不对";
  if (!VERSION_SHAPE.test(String(c.version))) return "version 形状不对";
  if (typeof c.at !== "string" || Number.isNaN(Date.parse(c.at))) return "at 不是时间";
  if (!Array.isArray(c.artifacts)) return "artifacts 不是数组";
  for (const a of c.artifacts) { const p = artifactProblem(a); if (p !== null) return p; }
  if (!Array.isArray(c.scripts) || c.scripts.some((s) => typeof s !== "string" || !/^(codex\/)?[A-Za-z0-9_.-]+\.mjs$/u.test(s))) return "scripts 形状不对";
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

/** 三态读收据。 */
export function readInstalledSurface({ file } = {}) {
  if (typeof file !== "string" || file.length === 0) return { state: "unreadable", why: "收据位置说不清" };
  let st;
  try { st = fs.lstatSync(file); }
  catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: "lstat 失败：" + String(err?.code ?? err?.message ?? err) }; }
  if (!st.isFile()) return { state: "unreadable", why: "收据位置上不是普通文件" };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (err) { return { state: "unreadable", why: "读不出或不是 JSON：" + String(err?.code ?? err?.message ?? err) }; }
  const problem = installedSurfaceProblem(doc);
  return problem === null ? { state: "valid", doc } : { state: "unreadable", why: "形状不对：" + problem };
}

/**
 * 记收据（安装器 --apply 末尾调用）：把这条链的条目整体替换成本次写的（version / at / artifacts / scripts），别的链原样保留。
 * 收据 unreadable 时**不覆盖**：返回 { ok:false, reason:"surface_unreadable" }，交人工。原子写（tmp → rename）。
 */
export function recordInstalledSurface({ chain, version, artifacts, scripts, file, now = Date.now() }) {
  if (!CHAINS.includes(chain)) return { ok: false, reason: "chain_unknown" };
  if (typeof file !== "string" || file.length === 0) return { ok: false, reason: "surface_path_unknown" };
  const current = readInstalledSurface({ file });
  if (current.state === "unreadable") return { ok: false, reason: "surface_unreadable", why: current.why };
  const doc = current.state === "valid" ? current.doc : { schema_version: INSTALLED_SURFACE_SCHEMA, chains: {} };
  // 同一条链由多个安装器分别写（出站 / 入站 / Codex）：按 path 合并制品；版本变了就整体换（旧版本的收据不再作数）
  const prev = doc.chains[chain];
  const keep = prev && prev.version === version ? prev.artifacts.filter((a) => !artifacts.some((b) => b.path === a.path)) : [];
  const keepScripts = prev && prev.version === version ? prev.scripts : [];
  const entry = { version, at: new Date(now).toISOString(), artifacts: [...keep, ...artifacts.map((a) => ({ path: a.path, kind: a.kind, sha256: a.sha256 }))].sort((a, b) => a.path.localeCompare(b.path)), scripts: [...new Set([...keepScripts, ...scripts])].sort() };
  const problem = chainProblem(entry);
  if (problem !== null) return { ok: false, reason: "entry_shape", why: problem };
  const next = { schema_version: INSTALLED_SURFACE_SCHEMA, chains: { ...doc.chains, [chain]: entry } };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) { return { ok: false, reason: "io_error", why: String(err?.code ?? err?.message ?? err) }; }
  return { ok: true, file, entry };
}

/**
 * 用收据对线上逐项对账（预检用）：每个制品读线上字节 → 按 kind 算 sha → 与收据比。
 * @returns {{ state: "absent"|"unreadable"|"checked", ok?: boolean, mismatches?: {path, expected, actual}[], version?: string }}
 */
export function compareInstalledSurface({ chain, file, home, node, extractors = {} } = {}) {
  const r = readInstalledSurface({ file });
  if (r.state !== "valid") return r;
  const entry = r.doc.chains[chain];
  if (!entry) return { state: "absent", why: "收据里没有这条链" };
  const mismatches = [];
  for (const a of entry.artifacts) {
    let text = null;
    try { text = fs.readFileSync(a.path, "utf-8"); } catch (err) { if (err?.code !== "ENOENT") { mismatches.push({ path: a.path, expected: a.sha256, actual: "unreadable:" + String(err?.code ?? err?.message) }); continue; } }
    const actual = artifactSha({ kind: a.kind, text, home, node, extractors });
    if (actual !== a.sha256) mismatches.push({ path: a.path, expected: a.sha256, actual });
  }
  return { state: "checked", ok: mismatches.length === 0, mismatches, version: entry.version, scripts: entry.scripts };
}
