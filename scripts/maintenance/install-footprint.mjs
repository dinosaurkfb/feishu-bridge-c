/**
 * 装机足迹（PK3-U1 / fix1）—— 「这台机器上本桥装了什么」的**唯一判据**。
 *
 * 谁在读它：doctor 的「装机状态」与「未安装态」、scripts/uninstall.mjs 的「这一步有东西可卸吗」、
 * 以及 --purge 的机器级数据清单。三处共用一份，所以"卸干净了"与"doctor 说还有残留"结构上不可能矛盾。
 *
 * 为什么住在 maintenance/ 而不是 install-projection.mjs：足迹必须同时知道**两条链**装了什么
 * （Codex 的技能清单、Codex 兜底 drain 的 plist 都在 scripts/codex/ 下），而顶层 `scripts/*.mjs`
 * 一律不许 import codex/（方向守卫盯着）。维护层本来就是跨两链的那一层。
 *
 * **归属只认严格解析，不认文件名子串**（fix1 P1-1）：Claude 侧用 claudeSettingsOwnedEntries
 * （安装器/收据用的那一份：锚在 HOOK_TAG + basename 且整条命令形状受验），Codex 侧用
 * codexHooksOwnedEntries。外项目 `/opt/orca/scripts/stop-hook.mjs` 这种同名钩子不会被误认成我们的。
 *
 * 全程**只读**：不写、不建目录、不调控制面。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLAUDE_INBOUND_SKILL, CLAUDE_SKILLS, ailyDaemonUnitPath, claudeDrainPlistPath, claudeDrainSystemdPaths,
  claudeSettingsOwnedEntries,
} from "../install-projection.mjs";
import { timerKindFor } from "../drain-schedule.mjs";
import { SKILLS as CODEX_SKILLS } from "../codex/skill-content.mjs";
import { codexHooksOwnedEntries } from "../codex/hook-command.mjs";
import { plistPath as codexDrainPlistPath } from "../codex/drain-service.mjs";
import { registryPath } from "../registry.mjs";

/** 存在性判据一律用 lstat：**断链的符号链接（dangling symlink）也算在**（fix1 P1-1：existsSync 会漏）。 */
const defaultExists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const defaultRead = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };

/** Claude 侧桥根（机器级状态）：覆盖点 FEISHU_BRIDGE_REGISTRY 优先，其余按传进来的 home 派生。 */
export const claudeBridgeRoot = ({ home = os.homedir(), env = process.env } = {}) => {
  const reg = env.FEISHU_BRIDGE_REGISTRY;
  if (typeof reg === "string" && reg.length > 0 && path.isAbsolute(reg)) return path.dirname(reg);
  return path.join(home, ".claude", "feishu-bridge");
};

/**
 * Codex 侧桥根：覆盖点优先（FEISHU_CODEX_BRIDGE_HOME → CODEX_HOME → <home>/.codex），
 * 与 codex/state.bridgeHome 同口径，但 home 从参数取 —— 否则 doctor 的沙箱 home 会被绕过去读真机的 Codex 桥目录。
 */
export const codexBridgeRoot = ({ home = os.homedir(), env = process.env } = {}) => {
  const explicit = env.FEISHU_CODEX_BRIDGE_HOME;
  if (typeof explicit === "string" && explicit.length > 0 && path.isAbsolute(explicit)) return explicit;
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : path.join(home, ".codex");
  return path.join(codexHome, "feishu-bridge");
};

/**
 * `--purge` 的删除清单（fix1 P1-3）：**按产品派生函数取**，不手写文件名清单 ——
 * 清单会漏（实测漏过 receipts/、installed-surface.json、Codex 的 tasks/<key>/inbound 与 outbound、
 * 自定义 FEISHU_CODEX_BRIDGE_HOME 下的数据）。
 *
 * 两类目标：
 *   · roots：两链的机器级桥根目录（整棵删）—— 两链的全部机器级状态都在里面（登记表 / 模板 / 路由表 /
 *     订阅 / 回执 / 账本 / 收据 / runtime）；
 *   · files：**已知数据文件的覆盖点**（FEISHU_BRIDGE_REGISTRY / _ROUTES / _STATUS_PROVIDERS /
 *     _CHAIN_TEMPLATE 指向别处时）—— 只删那个文件本身，**绝不删它的父目录**（父目录是人给的，可能是别人的）。
 *
 * **项目里的东西不在这里**：`<项目>/.runtime-data/` 与飞书话题历史不归机器级卸载管。
 */
export function machinePurgeTargets({ home = os.homedir(), env = process.env } = {}) {
  const roots = [...new Set([claudeBridgeRoot({ home, env }), codexBridgeRoot({ home, env })])];
  const rootsSet = new Set(roots);
  const files = [];
  for (const key of ["FEISHU_BRIDGE_REGISTRY", "FEISHU_BRIDGE_ROUTES", "FEISHU_BRIDGE_STATUS_PROVIDERS", "FEISHU_BRIDGE_CHAIN_TEMPLATE"]) {
    const v = env[key];
    if (typeof v !== "string" || v.length === 0 || !path.isAbsolute(v)) continue;
    // 覆盖点正好落在桥根里 → 已经被整棵删覆盖了，不重复列
    if (roots.some((r) => v === r || v.startsWith(r + path.sep))) continue;
    files.push(v);
  }
  return { roots, files };
}

/**
 * 装机足迹盘点（纯读）。
 * @returns {{
 *   kind: "launchd"|"systemd"|null,
 *   present: object, residue: Array<{area,what}>, orphans: object,
 *   clean: boolean, installed: boolean, partial: boolean, claudeComplete: boolean, codexComplete: boolean,
 *   retainedNote: string,
 * }}
 */
export function installFootprint({ home = os.homedir(), env = process.env, platform = process.platform,
  exists = defaultExists, read = defaultRead } = {}) {
  const kind = timerKindFor(platform);
  const codexRoot = codexBridgeRoot({ home, env });
  const codexHome = path.dirname(codexRoot);

  // ── Claude 侧：钩子按**严格归属**认领（不认子串）
  const settingsText = read(path.join(home, ".claude", "settings.json"));
  const owned = settingsText === null ? null : claudeSettingsOwnedEntries(settingsText, { home });
  const claudeHooks = [];
  if (owned !== null) {
    if ((owned.Stop ?? []).length > 0) claudeHooks.push("stop-hook.mjs");
    if ((owned.inbound ?? []).length > 0) claudeHooks.push("inbound-hook.mjs");
    if ((owned.init ?? []).length > 0) claudeHooks.push("init-hook.mjs");
  }
  const claudeSkillPaths = [...CLAUDE_SKILLS.map((sk) => path.join(home, ".claude", "skills", sk.dst)),
    path.join(home, ".claude", "skills", CLAUDE_INBOUND_SKILL.name)].filter(exists);
  const timerPaths = (kind === "launchd" ? [claudeDrainPlistPath(home)]
    : kind === "systemd" ? [claudeDrainSystemdPaths(home).service, claudeDrainSystemdPaths(home).timer]
      : []).filter(exists);
  const ailyPath = kind === "systemd" ? ailyDaemonUnitPath(home) : null;
  const ailyUnit = ailyPath !== null && exists(ailyPath) ? ailyPath : null;
  const claudeCurrent = path.join(home, ".claude", "feishu-bridge", "runtime", "current");

  // ── Codex 侧：钩子同样按严格归属；技能用 adapter 自己的清单；drain plist 也纳入（fix1 P1-1）
  const codexHooksText = read(path.join(codexHome, "hooks.json"));
  const codexOwned = codexHooksText === null ? null : codexHooksOwnedEntries(codexHooksText);
  const codexHookNames = [];
  if (codexOwned !== null) {
    if ((codexOwned.UserPromptSubmit ?? []).length > 0) codexHookNames.push("prompt-hook.mjs");
    if ((codexOwned.Stop ?? []).length > 0) codexHookNames.push("stop-hook.mjs");
  }
  const codexSkillPaths = CODEX_SKILLS.map((sk) => path.join(codexHome, "skills", sk.name)).filter(exists);
  const codexDrain = kind === "launchd" ? [codexDrainPlistPath(home)].filter(exists) : [];
  const codexCurrent = path.join(codexRoot, "runtime", "current");

  const present = {
    claudeHooks, claudeSkills: claudeSkillPaths, timer: timerPaths, ailyUnit,
    claudeCurrent: exists(claudeCurrent) ? claudeCurrent : null,
    codexHooks: codexHookNames, codexSkills: codexSkillPaths, codexDrain,
    codexCurrent: exists(codexCurrent) ? codexCurrent : null,
  };
  const residue = [
    ...claudeHooks.map((n) => ({ area: "claude-hook", what: n })),
    ...claudeSkillPaths.map((p) => ({ area: "claude-skill", what: p })),
    ...timerPaths.map((p) => ({ area: "timer", what: p })),
    ...(ailyUnit ? [{ area: "aily-unit", what: ailyUnit }] : []),
    ...(present.claudeCurrent ? [{ area: "runtime-current", what: present.claudeCurrent }] : []),
    ...codexHookNames.map((n) => ({ area: "codex-hook", what: n })),
    ...codexSkillPaths.map((p) => ({ area: "codex-skill", what: p })),
    ...codexDrain.map((p) => ({ area: "codex-drain", what: p })),
    ...(present.codexCurrent ? [{ area: "codex-runtime-current", what: present.codexCurrent }] : []),
  ];

  // 成套 = 这一链的"已装"标记（钩子 + runtime/current）都在。平台没有定时器实现的机器不因此判残留。
  const claudeComplete = claudeHooks.length > 0 && present.claudeCurrent !== null;
  const codexComplete = codexHookNames.length > 0 && present.codexCurrent !== null;
  // **"半装"只判会出事的地方**：这一链**装过**（钩子在），而它指向的 runtime/current 已经不在了 ——
  // 那才是真残留（每个 Stop / 每 30 分钟都会去跑一个不存在的脚本，且不报错）。
  // 「只有 runtime 没钩子」「只有一份别人的 / 遗留的 plist 而这一链从没装过」这类**不成套但不会出事**的
  // 状态不算故障 —— 它们仍然会出现在 residue 清单里（人有得看），但不判 ✗。
  const orphans = {
    hooks: claudeHooks.length > 0 && present.claudeCurrent === null,
    timer: claudeHooks.length > 0 && timerPaths.length > 0 && present.claudeCurrent === null,
    codex: codexHookNames.length > 0 && present.codexCurrent === null,
    codexDrain: codexHookNames.length > 0 && codexDrain.length > 0 && present.codexCurrent === null,
  };
  return {
    kind, present, residue, orphans,
    clean: residue.length === 0,
    claudeComplete, codexComplete,
    installed: claudeComplete || codexComplete,
    partial: orphans.hooks || orphans.timer || orphans.codex || orphans.codexDrain,
    retainedNote: "保留的数据（卸载默认不删）：registry.json / routes.json / status-providers.json / subscriptions.json / chain-config.json / inbound/ 回执与账本",
  };
}

/** 足迹的一句话（doctor 与 uninstall 输出共用口径）。 */
export const describeFootprint = (foot) => {
  if (foot.clean) return "未安装（三处 hooks / 两链技能 / 定时器 / runtime/current 都不在）";
  const bits = [];
  if (foot.present.claudeHooks.length > 0) bits.push("claude hooks " + foot.present.claudeHooks.length);
  if (foot.present.codexHooks.length > 0) bits.push("codex hooks " + foot.present.codexHooks.length);
  if (foot.present.claudeSkills.length + foot.present.codexSkills.length > 0) bits.push("技能 " + (foot.present.claudeSkills.length + foot.present.codexSkills.length));
  if (foot.present.timer.length > 0) bits.push("定时器 " + foot.present.timer.length);
  if (foot.present.codexDrain.length > 0) bits.push("codex drain " + foot.present.codexDrain.length);
  if (foot.present.ailyUnit) bits.push("aily 单元");
  if (foot.present.claudeCurrent) bits.push("claude current");
  if (foot.present.codexCurrent) bits.push("codex current");
  return (foot.installed ? "已安装" : "不成套") + "：" + bits.join(" / ");
};
