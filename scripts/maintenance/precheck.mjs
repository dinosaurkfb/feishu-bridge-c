/**
 * 启动源预检（issue #81 PR C，方案稿"进门前；对当前投影逐字节 / 逐字段对账"）—— 任一条对不上就拒绝进门，什么都不动。
 *
 * 当前投影 = 机器级安装收据（PR B）。**没有收据的运行时拒绝进门**（receipt_absent）：先用普通安装器装一次含收据代码的版本
 *（--apply 末尾会记收据），再来。方案稿 v5 里"按已知 digest 走 legacy 模板"这条不再需要 —— 两条链线上都已经是带收据的版本。
 *
 * 逐项：
 *   receipt         收据 valid、有这条链、版本 == verifyRuntime 的版本、逐制品 sha 对账通过
 *   hooks           settings.json / hooks.json 里：桥拥有的条目各恰好一条；任何提到运行时根的 hook 命令都必须是桥拥有的（多一个 shell 动作 / 第二个 node → 拒）
 *   timer           plist 字节 == 投影，launchd 三态 ∈ {loaded, installed_not_loaded, absent}
 *   routes          有效默认路由的处理器在 runtime/current 之下（或没有路由表）；非默认外部处理器只记账
 *   scripts         收据引用的每个脚本：在桩清单里、是 current/scripts 下解析得到的普通文件
 *   manifest        桩清单 missing 为空
 * 威胁边界（明写）：同 UID 人工直接执行克隆或 versions/<旧版> 下的脚本不在门的覆盖内。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeDrainPlist, claudeDrainPlistPath, claudeSettingsOwnedEntries } from "../install-projection.mjs";
import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, pickClaudeNode } from "../drain-schedule.mjs";
import { compareInstalledSurface, installedSurfacePath, readInstalledSurface } from "../installed-surface.mjs";
import { codexRuntimeRoot, runtimeRoot, verifyRuntime } from "../runtime-install.mjs";
import { defaultRouteHandler } from "../inbound-routes.mjs";
import { spawnLaunchctl } from "../launchd-job.mjs";
import { loadChainTemplate, templatePath } from "../chain-template.mjs";
import { codexHooksOwnedEntries } from "../codex/hook-command.mjs";
import { LAUNCH_LABEL as CODEX_DRAIN_LABEL, expectedJob as codexExpectedJob, plistBody as codexPlistBody, plistPath as codexPlistPath } from "../codex/drain-service.mjs";
import { bridgeHome as codexBridgeHomeOf, loadCodexTemplate, templateFile as codexTemplateFile } from "../codex/state.mjs";
import { maintenanceEntryManifest } from "./maintenance-entries.mjs";
import { ORIGINAL_THREE_STATE, timerPhase } from "./timers.mjs";

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const readTextOrNull = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };

/** 一条链的固定事实（路径与投影），预检与 operation 共用。 */
export function chainFacts({ chain, home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, ".codex"), codexBridgeHome = codexBridgeHomeOf(), node = pickClaudeNode() } = {}) {
  if (chain === "claude") {
    const root = runtimeRoot(home, "claude");
    const plistFile = claudeDrainPlistPath(home);
    return {
      chain, root, current: path.join(root, "current"),
      receiptFile: installedSurfacePath({ chain: "claude", home }),
      hooksFile: path.join(home, ".claude", "settings.json"),
      routesFile: path.join(home, ".claude", "feishu-bridge", "routes.json"), routeId: "self", inboundHandler: path.join(root, "current", "scripts", "inbound.mjs"),
      timer: { label: CLAUDE_DRAIN_LAUNCH_LABEL, plistFile, wanted: claudeDrainPlist({ home, node }), expect: claudeDrainExpectedJob({ home, node }) },
      templateFile: templatePath(), extractors: {}, otherRoot: codexRuntimeRoot(codexHome),
      entryFilter: (n) => !n.startsWith("codex/"),
    };
  }
  const root = codexRuntimeRoot(codexHome);
  return {
    chain, root, current: path.join(root, "current"),
    receiptFile: installedSurfacePath({ chain: "codex", codexBridgeHome }),
    hooksFile: path.join(codexHome, "hooks.json"),
    routesFile: path.join(codexBridgeHome, "routes.json"), routeId: "codex", inboundHandler: path.join(root, "current", "scripts", "codex", "inbound.mjs"),
    timer: { label: CODEX_DRAIN_LABEL, plistFile: codexPlistPath(home), wanted: codexPlistBody({ home, codexHome }), expect: codexExpectedJob({ home, codexHome }) },
    templateFile: codexTemplateFile(codexBridgeHome), extractors: { "codex-hooks": codexHooksOwnedEntries }, otherRoot: runtimeRoot(home, "claude"),
    entryFilter: (n) => n.startsWith("codex/"),
  };
}

/** 链模板里的 agent_uid（桩用来分辨 Aily 回合）；读不出 → null（桩把任何 Aily 调用方都当 Aily 回合，一律阻断）。 */
export function chainAgentUid(facts) {
  const loaded = facts.chain === "claude" ? loadChainTemplate(facts.templateFile) : loadCodexTemplate(facts.templateFile);
  return loaded.ok && typeof loaded.template?.agent_uid === "string" && loaded.template.agent_uid.length > 0 ? loaded.template.agent_uid : null;
}

/**
 * hook 命令里的路径参数：'…' / "…" / 裸 token，绝对路径的做 realpath；~ 与 $HOME 展开；别的 $VAR 解析不了。
 * 返回 { resolved:[realpath|null 的原 token], unresolvable:[token] }。
 */
export function commandPathTokens(cmd, { home }) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/gu;
  for (const m of cmd.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3]);
  const resolved = [], unresolvable = [];
  for (const raw of tokens) {
    let t = raw;
    if (t.startsWith("~/")) t = path.join(home, t.slice(2));
    if (t.startsWith("$HOME/")) t = path.join(home, t.slice("$HOME/".length));
    if (/\$\{?[A-Za-z_]/u.test(t)) { unresolvable.push(raw); continue; }
    if (!path.isAbsolute(t)) continue;
    const real = realOrNull(t);
    resolved.push({ raw, real });
  }
  return { resolved, unresolvable };
}

/**
 * 提到这条链运行时根的 hook 命令，必须全部是桥拥有的条目。"提到"不只看字符串：命令里每个路径参数 realpath 之后
 * 落在**任一条链**的 runtime 根（current / versions/*）之下也算（评审探针：symlink 别名指向 versions/<v>，字符串里没有运行时根）；
 * 含解析不了的 $VAR 且又提到 feishu-bridge / runtime 字样的非桥命令 → 不能算已验证的启动源，同样拒。
 */
function foreignHookCommands({ chain, text, root, otherRoot, home, node }) {
  if (text === null) return { ok: false, why: "hook 文件读不出" };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, why: "hook 文件不是 JSON" }; }
  const owned = chain === "claude" ? claudeSettingsOwnedEntries(text, { home, node }) : codexHooksOwnedEntries(text);
  if (owned === null) return { ok: false, why: "hook 文件解析不出桥拥有的条目" };
  const ownedCommands = new Set();
  const ownedLists = chain === "claude" ? [owned.Stop, owned.inbound, owned.init] : [owned.Stop, owned.UserPromptSubmit];
  for (const list of ownedLists) for (const h of list ?? []) {
    if (typeof h?.command === "string") ownedCommands.add(h.command);
    for (const inner of h?.hooks ?? []) if (typeof inner?.command === "string") ownedCommands.add(inner.command);
  }
  const counts = ownedLists.map((l) => (l ?? []).length);
  if (counts.some((c) => c !== 1)) return { ok: false, why: "桥拥有的 hook 条目不是各恰好一条：" + JSON.stringify(counts) };
  const roots = [root, otherRoot].filter((r) => typeof r === "string");
  const rootReals = roots.map(realOrNull).filter((r) => r !== null);
  const underRuntime = (real) => real !== null && rootReals.some((rr) => real === rr || real.startsWith(rr + path.sep));
  const mentions = (cmd) => {
    if (roots.some((r) => cmd.includes(r)) || rootReals.some((r) => cmd.includes(r)) || cmd.includes("feishu-bridge/runtime")) return "字符串里提到运行时根";
    const t = commandPathTokens(cmd, { home });
    const hit = t.resolved.find((x) => underRuntime(x.real));
    if (hit) return "路径参数 " + hit.raw + " 解析后落在运行时之下（" + hit.real + "）";
    if (t.unresolvable.length > 0 && /feishu-bridge|runtime/u.test(cmd)) return "含解析不了的变量（" + t.unresolvable.join("、") + "）又提到 feishu-bridge / runtime，无法验证";
    return null;
  };
  const foreign = [];
  const hooks = doc?.hooks ?? {};
  for (const [event, entries] of Object.entries(hooks)) for (const entry of Array.isArray(entries) ? entries : []) for (const h of entry?.hooks ?? []) {
    const cmd = typeof h?.command === "string" ? h.command : "";
    if (ownedCommands.has(cmd)) continue;
    const why = mentions(cmd);
    if (why !== null) foreign.push(event + "：" + cmd.slice(0, 100) + "（" + why + "）");
  }
  return foreign.length === 0 ? { ok: true } : { ok: false, why: "有提到运行时但不是桥拥有的 hook 命令：" + foreign.join("；") };
}

/**
 * 预检一条链。返回 { items:[{id, ok, why}], facts, receipt, runtime, timer, agentUid }。
 */
export function precheckChain(facts, { home = os.homedir(), node = pickClaudeNode(), launchctl = spawnLaunchctl, manifest } = {}) {
  const items = [];
  const add = (id, ok, why = null) => items.push({ id: facts.chain + ":" + id, ok, why });
  const runtime = verifyRuntime({ root: facts.root });
  add("runtime", runtime.ok === true, runtime.ok ? null : "runtime 校验不过：" + String(runtime.reason));
  // 收据
  const receipt = readInstalledSurface({ file: facts.receiptFile });
  const entry = receipt.state === "valid" ? receipt.doc.chains[facts.chain] ?? null : null;
  if (receipt.state === "absent" || (receipt.state === "valid" && entry === null)) add("receipt", false, "receipt_absent：没有这条链的安装收据（先用普通安装器 --apply 装一次含收据代码的版本）");
  else if (receipt.state === "unreadable") add("receipt", false, "receipt_unreadable：" + receipt.why);
  else if (runtime.ok && entry.version !== runtime.version) add("receipt", false, "receipt_version_mismatch：收据是 " + entry.version + "，线上是 " + runtime.version);
  else {
    const cmp = compareInstalledSurface({ chain: facts.chain, file: facts.receiptFile, home, node, extractors: facts.extractors });
    add("receipt", cmp.state === "checked" && cmp.ok === true, cmp.state !== "checked" ? "收据对账做不了：" + String(cmp.why) : cmp.ok ? null : "artifact_mismatch：" + cmp.mismatches.map((m) => m.path + "（预期 " + m.expected.slice(0, 8) + "，实际 " + String(m.actual).slice(0, 24) + "）").join("；"));
  }
  // hooks
  const hooks = foreignHookCommands({ chain: facts.chain, text: readTextOrNull(facts.hooksFile), root: facts.root, otherRoot: facts.otherRoot ?? null, home, node });
  add("hooks", hooks.ok, hooks.ok ? null : hooks.why);
  // 定时器
  const timer = timerPhase({ ...facts.timer, run: launchctl });
  add("timer", ORIGINAL_THREE_STATE.includes(timer.phase), ORIGINAL_THREE_STATE.includes(timer.phase) ? null : "定时器不在原始三态里：" + timer.phase + (timer.why ? "（" + timer.why + "）" : ""));
  // 路由
  const route = defaultRouteHandler({ file: facts.routesFile, runtimeCurrent: facts.current, expectedHandler: facts.inboundHandler, expectedRouteId: facts.routeId });
  add("routes", route.status === "runtime" || route.status === "no_routes", route.status === "runtime" || route.status === "no_routes" ? null : "默认路由：" + route.status + (route.why ? "（" + route.why + "）" : ""));
  // 脚本：收据引用的每个脚本在清单里，且是 current/scripts 下解析得到的普通文件
  if (entry !== null && manifest) {
    const currentReal = realOrNull(path.join(facts.current, "scripts"));
    const bad = [];
    for (const name of entry.scripts) {
      if (!manifest.entries.includes(name)) { bad.push(name + "（不在桩清单里）"); continue; }
      const real = realOrNull(path.join(facts.current, "scripts", ...name.split("/")));
      if (real === null || currentReal === null || !real.startsWith(currentReal + path.sep)) { bad.push(name + "（不是 current/scripts 下的真实文件）"); continue; }
      try { if (!fs.statSync(real).isFile()) bad.push(name + "（不是普通文件）"); } catch { bad.push(name + "（stat 失败）"); }
    }
    add("scripts", bad.length === 0, bad.length === 0 ? null : bad.join("；"));
  }
  return { items, facts, receipt, entry, runtime, timer, agentUid: chainAgentUid(facts) };
}

/**
 * 两条链一起预检 + 桩清单。ok = 全部项都过。
 */
export function precheckStartupSources({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, ".codex"), codexBridgeHome = codexBridgeHomeOf(), repoRoot, node = pickClaudeNode(), launchctl = spawnLaunchctl } = {}) {
  const manifest = maintenanceEntryManifest({ repoRoot, home, codexHome, bridgeHome: codexBridgeHome });
  const chains = {};
  const items = [];
  for (const chain of ["claude", "codex"]) {
    const facts = chainFacts({ chain, home, codexHome, codexBridgeHome, node });
    const r = precheckChain(facts, { home, node, launchctl, manifest });
    chains[chain] = r;
    items.push(...r.items);
  }
  items.push({ id: "manifest", ok: manifest.missing.length === 0, why: manifest.missing.length === 0 ? null : "桩清单里有源码树没有的项：" + manifest.missing.join("、") });
  return { ok: items.every((i) => i.ok), items, chains, manifest };
}
