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
import { codexRuntimeRoot, runtimeRoot } from "../runtime-install.mjs";
import { SKILLS as CODEX_SKILLS } from "../codex/skill-content.mjs";
import { codexHooksOwnedEntries } from "../codex/hook-command.mjs";
import {
  bridgeHome, codexHomeOf as codexHomeOfValidated, hookLogFile, inboundCrashLogFile, inboundDir, migrationsFile,
  receiptsDir, registryFile, registryLockPath, routesFile, dispatcherLogFile, tasksDir, templateFile, threadsDir,
} from "../codex/state.mjs";
import { intentDir } from "../codex/intent.mjs";
import { installedSurfacePath } from "../installed-surface.mjs";
import { drainLogPath, plistPath as codexDrainPlistPath } from "../codex/drain-service.mjs";

/** 存在性判据一律用 lstat：**断链的符号链接（dangling symlink）也算在**（fix1 P1-1：existsSync 会漏）。 */
const defaultExists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const defaultRead = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };

/**
 * Claude 侧桥根（机器级状态）：**固定 `<home>/.claude/feishu-bridge`**，不从覆盖点派生（PK3-U1-fix2 P1-2）。
 * 之前用 `dirname(FEISHU_BRIDGE_REGISTRY)` 当整棵桥根 —— 覆盖点指到共享目录时 `--purge` 会把那个目录
 * （连它的无关兄弟文件）整棵递归删掉。覆盖只允许进 `files`（只删文件）。
 */
export const claudeBridgeRoot = ({ home = os.homedir() } = {}) => path.join(home, ".claude", "feishu-bridge");

/** Codex 的**家目录**：**受验派生只有一份**（codex/state.mjs 的 codexHomeOf，相对路径直接抛）。 */
export const codexHomeOf = ({ home = os.homedir(), env = process.env } = {}) => codexHomeOfValidated({ home, env });

/**
 * Codex 侧**状态根**（FEISHU_CODEX_BRIDGE_HOME → codexHome/feishu-bridge）：登记表 / tasks / 收据在这里。
 * **与 codexHome 分开派生**（fix2 P1-3）：拿状态根的父目录当 CODEX_HOME 是错的 —— 自定义状态根时
 * hooks.json 与 skills/ 仍然在 CODEX_HOME，runtime/current 也仍然在 `codexRuntimeRoot(codexHome)` 下，
 * 于是足迹会漏掉它们、卸载会误报「未安装，跳过」。
 * 派生复用 `bridgeHome` 那一份受验实现（fix3 P1-2）：**显式值不是绝对路径时直接抛**，
 * 不再静默忽略、转而去删默认状态根。
 */
export const codexBridgeRoot = ({ home = os.homedir(), env = process.env } = {}) =>
  bridgeHome({ ...env, CODEX_HOME: codexHomeOf({ home, env }) });

/**
 * 允许显式桥根落脚的命名空间：**home** 与**系统临时目录**（`/tmp` 在 macOS 上是 `/private/tmp` 的符号链接）。
 * 两种写法都收：夹具路径常常是 `/var/…` 而 realpath 给 `/private/var/…`，只认一种会把合法目标误拒。
 */
const namespaceRoots = (homeNorm) => {
  const out = new Set([path.resolve(homeNorm)]);
  try { out.add(fs.realpathSync(homeNorm)); } catch { /* 取不到就不加这一种写法 */ }
  for (const base of [os.tmpdir(), "/tmp"]) {
    out.add(path.resolve(base));
    try { out.add(fs.realpathSync(base)); } catch { /* 同上 */ }
  }
  return [...out];
};

/** 系统临时目录的**根本身**（`os.tmpdir()` / `/tmp` 及其真实位置）—— 显式桥根指向它们一律拒绝。 */
const tmpRoots = () => {
  const out = new Set();
  for (const base of [os.tmpdir(), "/tmp"]) {
    out.add(path.resolve(base));
    try { out.add(fs.realpathSync(base)); } catch { /* 同上 */ }
  }
  return [...out];
};

/**
 * **canonical 路径**：对最近的**存在**祖先做 realpath，再把剩下的段拼回去（目标自己可能还不存在）。
 * 断链 / 符号链接环 / 解不动 → `null`（调用方按"说不清"拒绝，fail-closed）。
 *
 * 为什么不能只 `fs.realpathSync(p)`：桥根在**首次安装前**根本不存在，那个调用直接 ENOENT ——
 * 于是"canonical 这一半"被静默跳过，边界又变回只看词法。
 */
export function canonicalPath(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...[...rest].reverse()); }
    catch (err) {
      if (err?.code !== "ENOENT") return null;                     // 权限 / 环等：说不清
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (st !== undefined && st.isSymbolicLink()) return null;    // 断链：真实去向说不清
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** 一个位置的**两种写法**（原样 + realpath）：`/var/…` 与 `/private/var/…` 这类差异不能漏判。 */
const pathForms = (p) => {
  const out = new Set([path.resolve(p)]);
  try { out.add(fs.realpathSync(p)); } catch { /* 不存在就这一种写法 */ }
  return out;
};
/** 待判路径只比**它自己写出来的那条**：它的真实去向由 canonical 那一趟负责（两趟各管一件事）。 */
const candidateForms = (q) => new Set([path.resolve(q)]);

/**
 * **单条路径的禁区判据**（PK3-U1-fix3 的判据抽成一份；fix6 起 lexical 与 canonical 各调一次）：
 * 这条路径本身是不是"不许删的位置"。返回 null = 可以，否则一句为什么。
 * 覆盖：文件系统根 / home 与 home 下的父层（`.claude`、`.codex`）/ 任何桥根的严格祖先。
 *
 * **不许只查一条路径**：`<home>/bridge-link -> <home>` 的词法看着无害（它在 home 里、也不等于 home），
 * canonical 却是 home 本身 —— 只查词法就会把 home 当桥根，随后删掉 `home/tasks/` 这类无关数据
 * （Codex 六轮探针：真跑 --purge --yes-delete-data --apply 退出 0 并删了 `<home>/tasks/keep.txt`）。
 */
const forbiddenPurgePath = (q, { homeNorm, rootsNorm, fsRoot }) => {
  // **两种写法都要认**：macOS 上 `os.tmpdir()` 给 `/var/…` 而 realpath 给 `/private/var/…`，
  // 只比一种写法会让"canonical 就是 home 自己"这种情况漏判（Codex 六轮探针正是这么绕过去的）。
  const qs = candidateForms(q);
  const differs = (forms) => [...qs].some((x) => forms.has(x));
  if (qs.has(fsRoot)) return "是文件系统根 —— 递归删它等于删整台机器";
  if (differs(pathForms(homeNorm)) || differs(pathForms(path.join(homeNorm, ".claude"))) ||
      differs(pathForms(path.join(homeNorm, ".codex")))) {
    return "是 home 或 home 下的父层（桥根在它下面，删它会带走无关内容）";
  }
  for (const r of rootsNorm) {
    for (const x of qs) {
      for (const y of pathForms(r)) {
        if (y !== x && y.startsWith(x + path.sep)) return "是某个桥根的父目录（只允许桥根本身及其下）";
      }
    }
  }
  return null;
};

/**
 * 显式桥根（`FEISHU_CODEX_BRIDGE_HOME`）的**强边界**（PK3-U1-fix5 P1-1）：词法路径**且** canonical 路径
 * 都必须落在允许的命名空间里，且都不是"根本身"。返回 null = 通过，否则返回一句为什么。
 *
 * 旧版是"任一安全即通过"（some）—— 于是 `<home>/bridge-link -> /etc` 只用词法那一条就过了，
 * 随后删 `bridge-link/tasks` 会沿父链删到 `/etc/tasks`（只读探针实测）。现在两条都要过：
 * 词法在 home 外与 canonical 在 home 外**都拒**。
 *
 * `os.tmpdir()` / `/tmp` / `/private/tmp` 的**根本身**一律拒绝，其下的子目录允许 —— 判据是"能不能证明
 * 这是本桥专用的位置"：一个目录里的子目录可以只属于本桥，而临时目录根本身是所有进程共用的，删它就等于
 * 删别人还在用的东西（测试夹具正是"临时目录下的子目录"，所以不能把 tmp 整片禁掉）。
 */
export function explicitBridgeRootProblem(candidate, homeNorm, { roots = [] } = {}) {
  const lexical = path.resolve(candidate);
  const canonical = canonicalPath(candidate);
  const bases = namespaceRoots(homeNorm);
  const under = (q) => bases.some((b) => q === b || q.startsWith(b + path.sep));
  if (!under(lexical)) return "词法路径不在 home 也不在系统临时目录下";
  if (canonical === null) return "路径解析不出真实去向（断链 / 符号链接环）—— 说不清就不动";
  if (!under(canonical)) {
    return "canonical 路径 " + canonical + " 在 home 与系统临时目录之外（词法在 " + lexical +
      "，指向 home 外的符号链接会把删除带出去）";
  }
  if (tmpRoots().some((t) => lexical === t || canonical === t)) {
    return "是系统临时目录根本身（其下的子目录可以，根部不行 —— 那是所有进程共用的位置）";
  }
  // **父层 / 祖先禁区对两条路径都要查**（PK3-U1-fix6 P1-1）：判据只有一份（forbiddenPurgePath），
  // 各调一次 —— 不许"词法看着没问题就放行"。canonical 可能就是 home 自己（symlink 指回 home）。
  const ctx = {
    homeNorm: path.resolve(homeNorm),
    rootsNorm: roots.map((r) => path.resolve(r)),
    fsRoot: path.parse(path.resolve(homeNorm)).root,
  };
  for (const q of [lexical, canonical]) {
    const why = forbiddenPurgePath(q, ctx);
    if (why === null) continue;
    // 报"哪一条路径"时把 canonical 一并说出来：`<home>/bridge-link -> <home>` 触发的是**canonical**那一半，
    // 只说词法路径会让人以为判据看错了地方。
    return (q === canonical
      ? "canonical 路径 " + canonical
      : "词法路径 " + lexical + (canonical !== lexical ? "（canonical 是 " + canonical + "）" : "")) +
      " " + why + "（符号链接会把删除带到那里）";
  }
  return null;
}

/**
 * `--purge` 删除目标的**形状校验**（fix3 P1-2，fail-closed）：任何写入前必须过。
 * 只允许三类桥根及其下（`<home>/.claude/feishu-bridge` / `<codexHome>/feishu-bridge` / 显式
 * `FEISHU_CODEX_BRIDGE_HOME`）；覆盖点文件必须是绝对路径。拒绝：非绝对、文件系统根、`<home>` 本身、
 * `<home>/.claude` 与 `<home>/.codex` 这类父层，以及**任何桥根的严格祖先**（`/` 与 home 都属于这一类）。
 * **fix4 P1-2 新增 / fix5 P1-1 收紧**：标了 `boundary:"explicit-bridge-root"` 的候选（就是显式
 * `FEISHU_CODEX_BRIDGE_HOME`）还要过**强边界**：词法**且** canonical 都在 home / 临时目录下、不是 tmp 根
 * 本身 —— 见 explicitBridgeRootProblem 里的理由。
 */
export function purgeTargetProblems({ candidates = [], roots = [], home = os.homedir() } = {}) {
  const problems = [];
  const homeNorm = path.resolve(home);
  const fsRoot = path.parse(homeNorm).root;
  const rootsNorm = roots.map((r) => path.resolve(r));
  for (const c of candidates) {
    const v = c?.path;
    if (typeof v !== "string" || v.length === 0) continue;
    const push = (why) => problems.push({ varName: c.varName ?? "（派生）", value: v, why });
    if (!path.isAbsolute(v)) { push("不是绝对路径（相对路径会被静默当成别的东西）"); continue; }
    const n = path.resolve(v);
    const forbidden = forbiddenPurgePath(n, { homeNorm, rootsNorm, fsRoot });
    if (forbidden !== null) { push(forbidden); continue; }
    if (c.boundary === "explicit-bridge-root") {
      const boundary = explicitBridgeRootProblem(v, homeNorm, { roots });
      if (boundary !== null) {
        push(boundary + " —— 显式桥根必须能证明是本桥专用的位置（双确认授权的是删桥数据，不是删环境变量指到的任何地方）；" +
          "要卸它请把它指回 home 下，或手工处置");
        continue;
      }
    }
  }
  return problems;
}

/**
 * 显式 `FEISHU_CODEX_BRIDGE_HOME` 下的**封闭已知条目**（PK3-U1-fix4 P1-2）：`--purge` 不再整棵递归删那个目录，
 * 只删这些条目 —— 每个名字都从**写它的那个模块**的派生函数取（不在这里手写文件名，也不看目录里有什么）。
 *
 * 父目录（也就是人给的那个位置）**保留**，即使已经空了：那是他的目录，不是本桥建的，
 * 一个卸载命令没有理由替他删掉它（而且“空目录”与“共享目录里的一个子目录”从外面看是一样的）。
 *
 * 不在这里的：`runtime/`（它在 `codexRuntimeRoot(codexHome)` 下，与状态根无关，由 uninstall 的 runtime 步删）、
 * 覆盖点（`FEISHU_BRIDGE_REGISTRY` 这类环境变量指到别处时只删文件，单独一类）。
 */
export function codexBridgeKnownEntries({ codexBridgeHome } = {}) {
  const root = codexBridgeHome;
  const files = [
    registryFile(root), templateFile(root), hookLogFile(root), migrationsFile(root),
    routesFile(root), dispatcherLogFile(root), inboundCrashLogFile(root), drainLogPath(root),
    registryLockPath(root),
    // 登记表的 .prev 备份：mutateRegistryDocument 每写一次就留一份，内容就是上一版登记表 —— 它也是登记表数据。
    registryFile(root) + ".prev",
    // 安装收据的**规范位置**（不跟随 FEISHU_BRIDGE_INSTALLED_SURFACE 覆盖点：与其它覆盖点同一口径，
    // 传空 env 拿默认位置）。
    installedSurfacePath({ chain: "codex", codexBridgeHome: root, env: {} }),
  ].filter((p) => typeof p === "string" && p.length > 0);
  const dirs = [tasksDir(root), receiptsDir(root), intentDir(root), threadsDir(root), inboundDir(root)];
  return { files: [...new Set(files)], dirs: [...new Set(dirs)] };
}

/**
 * `--purge` 的删除清单（fix1 P1-3）：**按产品派生函数取**，不手写文件名清单 ——
 * 清单会漏（实测漏过 receipts/、installed-surface.json、Codex 的 tasks/<key>/inbound 与 outbound、
 * 自定义 FEISHU_CODEX_BRIDGE_HOME 下的数据）。
 *
 * 三类目标：
 *   · roots：**产品自己派生**的机器级桥根目录（整棵删）—— `<home>/.claude/feishu-bridge` 与
 *     `<codexHome>/feishu-bridge`。它们的位置与名字都由产品定义，可以整棵删。
 *   · entries：**显式 `FEISHU_CODEX_BRIDGE_HOME`**（人给的位置）下的封闭已知子项（逐个删，父目录保留）——
 *     fix4 P1-2：整棵递归删一个人给的位置，就是把“环境变量指到哪儿”变成“递归删哪儿”（实测 `/private/tmp`、
 *     `/etc` 都能通过旧校验），而双确认授权的是删**桥数据**，不是删那个目录。
 *   · files：**已知数据文件的覆盖点**（FEISHU_BRIDGE_REGISTRY / _ROUTES / _STATUS_PROVIDERS /
 *     _CHAIN_TEMPLATE 指向别处时）—— 只删那个文件本身，**绝不删它的父目录**（父目录是人给的，可能是别人的）。
 *
 * **项目里的东西不在这里**：`<项目>/.runtime-data/` 与飞书话题历史不归机器级卸载管。
 */
export function machinePurgeTargets({ home = os.homedir(), env = process.env } = {}) {
  const codexHome = codexHomeOf({ home, env });        // 受验：相对路径直接抛
  const claudeRoot = claudeBridgeRoot({ home });
  const codexRoot = codexBridgeRoot({ home, env });    // 受验：FEISHU_CODEX_BRIDGE_HOME 相对直接抛
  const explicitBridge = typeof env.FEISHU_CODEX_BRIDGE_HOME === "string" && env.FEISHU_CODEX_BRIDGE_HOME.length > 0;
  // 整棵递归删的只有产品派生的那两处；显式的那份改走 entries（fix4 P1-2）。
  const roots = explicitBridge ? [claudeRoot] : [...new Set([claudeRoot, codexRoot])];
  const entries = explicitBridge
    ? codexBridgeKnownEntries({ codexBridgeHome: codexRoot })
    : { files: [], dirs: [] };
  const candidates = [
    { path: claudeRoot, varName: "HOME（.claude/feishu-bridge）" },
    // 显式桥根要额外过“在用户命名空间里”那道（boundary）—— 派生根不需要：它的位置是产品定的。
    explicitBridge
      ? { path: codexRoot, varName: "FEISHU_CODEX_BRIDGE_HOME", boundary: "explicit-bridge-root" }
      : { path: codexRoot, varName: "CODEX_HOME" },
  ];
  const files = [];
  for (const key of ["FEISHU_BRIDGE_REGISTRY", "FEISHU_BRIDGE_ROUTES", "FEISHU_BRIDGE_STATUS_PROVIDERS", "FEISHU_BRIDGE_CHAIN_TEMPLATE"]) {
    const v = env[key];
    if (typeof v !== "string" || v.length === 0) continue;
    // 覆盖点正好落在桥根里 → 已经被整棵删覆盖了，不重复列（但**形状校验仍然要过**）
    if (!roots.some((r) => v === r || v.startsWith(r + path.sep))) files.push(v);
    candidates.push({ path: v, varName: key });
  }
  return { roots, entries, files, problems: purgeTargetProblems({ candidates, roots, home }) };
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
  const codexHome = codexHomeOf({ home, env });

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
  // **runtime 不看状态根**（fix2 P1-3）：它由 codexRuntimeRoot(codexHome) 派生，与 FEISHU_CODEX_BRIDGE_HOME 无关。
  const codexCurrent = path.join(codexRuntimeRoot(codexHome), "current");

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
    // 定时器 / Codex drain plist **不看钩子在不在了**（fix2 P2-2）：它们指向的 runtime/current 不在时
    // 本身就是会出事的状态（每 30 分钟跑一次不存在的脚本），不该因为“钩子也被删了/从未装钩子”就说不是半装。
    timer: timerPaths.length > 0 && present.claudeCurrent === null,
    codex: codexHookNames.length > 0 && present.codexCurrent === null,
    codexDrain: codexDrain.length > 0 && present.codexCurrent === null,
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
