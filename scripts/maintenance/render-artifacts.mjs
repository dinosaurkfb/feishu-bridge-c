/**
 * 目标投影 **renderArtifacts**（issue #81 PR C 第 2 步，方案稿 §95）—— stage / commit 要把线上写成什么，只有这一份。
 *
 * 契约：输入每个制品**此刻的基线字节**（`base(path)` → { exists, sha256, bytes }，缺席也是一种明确基线），
 * 输出 [{ chain, path, kind, bytes, base:{exists,sha256}, intendedAfterSha, inReceipt }] 与两条链的**目标版本收据草稿**。
 * 渲染全部走三个安装器的投影纯函数（install-projection / codex hook-command / codex skill-content / codex drain-service），
 * 技能模板从 `templates.<chain>`（stage 后 = versions/<v>/，内容寻址不可变；预览 = 源码树）读 —— 不读线上任何东西。
 *
 * 制品集合与安装器逐一对应：
 *   claude：settings.json（桥拥有条目合并进基线）、兜底 plist、8 + 1 个技能（出站 + 入站安装器的并集）—— 全部进收据；
 *   codex ：hooks.json、8 个技能 —— 进收据；兜底 plist **只在基线存在时**写目标字节、不进收据
 *   （codex 安装器不装 plist、drain-service 才装：目标状态与原始三态一致，安装器不替人启用）。
 */
import crypto from "node:crypto";
import path from "node:path";

import { claudeDrainPlist, claudeDrainPlistPath, claudeSkillFiles, referencedRuntimeScripts, renderClaudeSettings } from "../install-projection.mjs";
import { pickClaudeNode } from "../drain-schedule.mjs";
import { codexHooksOwnedEntries, pickNode as pickCodexNode, renderCodexHooks } from "../codex/hook-command.mjs";
import { SKILLS as CODEX_SKILLS, expectedSkillContent } from "../codex/skill-content.mjs";
import { plistBody as codexPlistBody, plistPath as codexPlistPath } from "../codex/drain-service.mjs";
import { artifactSha } from "../installed-surface.mjs";
import { codexRuntimeRoot, runtimeRoot } from "../runtime-install.mjs";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const VERSION_SHAPE = /^[0-9a-f]{16}$/u;

/**
 * @param {object} p
 * @param {(file: string) => { exists: boolean, sha256: string|null, bytes: Buffer|null } | { unreadable: true, why: string }} p.base
 *   每个制品的基线读取器（调用方用 fd 绑定读实现；unreadable 不折成缺席）。
 * @param {{ claude: string, codex: string }} p.templates 技能 / 模板树的根（stage 后传 versions/<v>/，预览传源码树）。
 * @returns {{ ok:true, version, artifacts, receipts:{claude,codex} } | { ok:false, reason, path?, why? }}
 */
export function renderArtifacts({ home, codexHome, codexBridgeHome, runtimeVersion, templates, node = pickClaudeNode(), codexNode = pickCodexNode(), base }) {
  if (typeof runtimeVersion !== "string" || !VERSION_SHAPE.test(runtimeVersion)) return { ok: false, reason: "version_shape", why: String(runtimeVersion) };
  const claudeRoot = runtimeRoot(home, "claude");
  const codexRoot = codexRuntimeRoot(codexHome);
  const artifacts = [];
  let failure = null;
  const bad = (reason, p, why) => { failure = { ok: false, reason, path: p ?? null, why: why ?? null }; return null; };
  const baseOf = (p) => {
    const b = base(p);
    if (b?.unreadable) return bad("base_unreadable", p, b.why);
    if (typeof b?.exists !== "boolean" || (b.exists && !Buffer.isBuffer(b.bytes))) return bad("base_shape", p);
    return b;
  };
  const push = (chain, p, kind, text, b, inReceipt) => {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf-8");
    artifacts.push({ chain, path: p, kind, bytes, base: { exists: b.exists, sha256: b.exists ? b.sha256 : null }, intendedAfterSha: sha256(bytes), inReceipt });
  };

  // ── Claude：settings.json（合并基线）→ plist → 技能
  const settingsFile = path.join(home, ".claude", "settings.json");
  const sb = baseOf(settingsFile);
  if (sb === null) return failure;
  let renderedSettings;
  try { renderedSettings = renderClaudeSettings({ baseText: sb.exists ? sb.bytes.toString("utf-8") : null, home, node }); }
  catch (err) { return { ok: false, reason: "base_unparseable", path: settingsFile, why: String(err?.message ?? err) }; }
  push("claude", settingsFile, "claude-settings", renderedSettings.text, sb, true);
  const claudePlistFile = claudeDrainPlistPath(home);
  const cpb = baseOf(claudePlistFile);
  if (cpb === null) return failure;
  push("claude", claudePlistFile, "plist", claudeDrainPlist({ home, node }), cpb, true);
  for (const f of claudeSkillFiles({ repoRoot: templates.claude, home })) {
    if (f.missing) return { ok: false, reason: "skill_source_missing", path: f.src };
    const b = baseOf(f.path);
    if (b === null) return failure;
    push("claude", f.path, "skill", f.text, b, true);
  }

  // ── Codex：hooks.json（合并基线）→ plist（只在基线存在时）→ 技能
  const hooksFile = path.join(codexHome, "hooks.json");
  const hb = baseOf(hooksFile);
  if (hb === null) return failure;
  const runtimeCurrent = path.join(codexRoot, "current");
  let renderedHooks;
  try {
    renderedHooks = renderCodexHooks({
      baseText: hb.exists ? hb.bytes.toString("utf-8") : null,
      promptScript: path.join(runtimeCurrent, "scripts", "codex", "prompt-hook.mjs"),
      stopScript: path.join(runtimeCurrent, "scripts", "codex", "stop-hook.mjs"),
      node: codexNode, home: codexBridgeHome, log: path.join(codexBridgeHome, "hook.log"),
    });
  } catch (err) { return { ok: false, reason: "base_unparseable", path: hooksFile, why: String(err?.message ?? err) }; }
  push("codex", hooksFile, "codex-hooks", renderedHooks.text, hb, true);
  const codexPlistFile = codexPlistPath(home);
  const xpb = baseOf(codexPlistFile);
  if (xpb === null) return failure;
  if (xpb.exists) push("codex", codexPlistFile, "plist", codexPlistBody({ home, node: codexNode, codexHome }), xpb, false);
  for (const sk of CODEX_SKILLS) for (const name of sk.files) {
    const src = path.join(templates.codex, "skills", sk.name, name);
    let bytes;
    try { bytes = expectedSkillContent({ sourceFile: src, name, runtimeCurrent, bridgeHome: codexBridgeHome }); }
    catch { return { ok: false, reason: "skill_source_missing", path: src }; }
    const dst = path.join(codexHome, "skills", sk.name, name);
    const b = baseOf(dst);
    if (b === null) return failure;
    push("codex", dst, "skill", bytes, b, true);
  }

  // ── 收据草稿：settings / hooks 记桥拥有封闭条目的 sha，其余整文件；scripts = 制品文本引用的 runtime/current 脚本
  const receiptFor = (chain) => {
    const list = artifacts.filter((a) => a.chain === chain && a.inReceipt);
    return {
      artifacts: list.map((a) => ({ path: a.path, kind: a.kind, sha256: artifactSha({ kind: a.kind, text: a.bytes, home, node, extractors: { "codex-hooks": codexHooksOwnedEntries } }) })),
      scripts: referencedRuntimeScripts(list.map((a) => a.bytes.toString("utf-8")).join("\n")),
    };
  };
  return { ok: true, version: runtimeVersion, artifacts, receipts: { claude: receiptFor("claude"), codex: receiptFor("codex") } };
}
