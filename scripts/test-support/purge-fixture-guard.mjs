/**
 * 真 purge 用例的**夹具边界守卫**（PK3-U1-fix7，fix8 收紧）。
 *
 * 为什么要它：卸载入口的删除清单会被**环境覆盖点**改变 —— `machinePurgeTargets` 读的就是这几个
 * （`CODEX_HOME` / `FEISHU_CODEX_BRIDGE_HOME` 换桥根，`FEISHU_BRIDGE_REGISTRY` / `_ROUTES` /
 * `_STATUS_PROVIDERS` / `_CHAIN_TEMPLATE` 换覆盖文件）。测试辅助过去把 `process.env` **原样**交给子进程，
 * 而开发机上这些变量常常真的指着线上数据（套件的绊线自己就设了 `FEISHU_BRIDGE_CHAIN_TEMPLATE`）——
 * 一条"真 `--purge --apply`"的用例就可能把**夹具之外**的文件删掉，而全绿只证明那次运行的环境没触发。
 *
 * 三道闸（fix8 的收紧写在后面两道里）：
 *   ① `purgeChildEnv()`：构造子进程环境时**先剔除**那一整份覆盖点（清单与产品同源：`PURGE_TARGET_ENV_KEYS`），
 *      再叠加用例显式给的 env。**`extra.HOME` 与 `home` 不一致直接抛错**（fix8 P1-1）：那会让预检按一个
 *      HOME 算、子进程按另一个 HOME 删 —— 用例写错了，不许静默覆盖。
 *   ② `purgeTargetsOutsideFixture()` 只接**最终子进程环境**（fix8 P1-1）：HOME 与覆盖点都从它取，
 *      预检与子进程**只有一份 env**，不存在"预检算 A、子进程删 B"。
 *   ③ 白名单与越界比较都按**词法 + canonical 两种路径**（fix8 P1-2，canonical 复用产品的 `canonicalPath`：
 *      最近存在祖先 realpath 再拼回剩余段）：
 *      · 显式 `CODEX_HOME` / `FEISHU_CODEX_BRIDGE_HOME` 只有在**两种写法都落在**本用例 home
 *        （或调用方用 `declaredPrivateRoots` 声明的私有临时目录）之下时才进白名单 —— 夹具内路径的父层
 *        被换成指向夹具外的符号链接时，它进不来，它派生的目标会被报成越界；
 *      · 每个删除目标同样两种写法都要落在白名单里，**任一在夹具外即越界**。
 */
import path from "node:path";

import { PURGE_TARGET_ENV_KEYS, canonicalPath, machinePurgeTargets } from "../maintenance/install-footprint.mjs";
import { INSTALLED_SURFACE_ENV } from "../installed-surface.mjs";
import { INSTALL_SURFACE_LOCK_ENV } from "../install-surface-lock.mjs";

/**
 * 安装器**写目标**覆盖点（PK3-U1-fix9，Codex 十轮 P1）：安装收据位置与安装面锁位置。它们不是 purge 目标，
 * 但 U1 的用例也会跑 `install-* --apply` / `codex/install --apply`，父环境若把它们指到真安装面，
 * 这些用例就会写到夹具外。变量名取产品自己的常量（同源），不手抄字符串。
 */
export const INSTALL_WRITE_TARGET_ENV_KEYS = Object.freeze([INSTALLED_SURFACE_ENV, INSTALL_SURFACE_LOCK_ENV]);

/** 子进程环境：剔掉全部删除目标覆盖点（继承值），置 HOME，再叠加用例显式给的 env。 */
export function purgeChildEnv({ env = process.env, home, extra = {} } = {}) {
  // fix8 P1-1：extra.HOME 与 home 不一致 = 预检与子进程会用两个不同的 HOME —— 用例写错了，当场抛。
  if (Object.hasOwn(extra, "HOME") && path.resolve(String(extra.HOME)) !== path.resolve(String(home))) {
    throw new Error("purgeChildEnv：extra.HOME（" + extra.HOME + "）与夹具 home（" + home +
      "）不一致 —— 预检与子进程必须只有一份 HOME；要换 home 就改第一个参数");
  }
  const out = { ...env };
  for (const key of [...PURGE_TARGET_ENV_KEYS, ...INSTALL_WRITE_TARGET_ENV_KEYS]) delete out[key];
  if (typeof home === "string" && home.length > 0) out.HOME = home;
  return { ...out, ...extra };
}

/**
 * **启动安装器 / 卸载入口**的子进程环境（PK3-I247）：就是 `purgeChildEnv`（同一份剔除清单，不另写），
 * 外加一道"用例**显式**给的写目标必须在夹具内"的断言 —— 全仓每一条 `install-* --apply` /
 * `codex/install --apply` / `uninstall --apply` 都从这里拿 env，别再手写 `{ ...process.env, … }`。
 *
 * 中间为什么是它而不是新写一个：`purgeChildEnv` 剔的正是"继承值会把写目标/删除目标带出夹具"的那一组
 * （`PURGE_TARGET_ENV_KEYS` + `INSTALL_WRITE_TARGET_ENV_KEYS`），安装器与卸载入口吃的是同一组覆盖点。
 * `home` 缺省从最终 env 的 `HOME` 取（多数用例的 env 自带 HOME）—— 预检与子进程只有一份 env。
 */
/**
 * PK3-I247-fix3（Codex 一轮 P1）：**执行边界核验**。installerChildEnv 产出的对象登记在这里；
 * 转手入口（如 linux-install.test.mjs 的 runInstaller）启动安装器 / 卸载入口前用
 * requireCleansedInstallerEnv 核验 —— 只认**同一个对象**，展开复制（{ ...env }）或原样继承（process.env）都不算。
 * 这样即使源码扫描认不出某种写法，把薄包装改回原样继承也会在运行时当场炸，而不是静默写夹具外。
 */
const CLEANSED_INSTALLER_ENVS = new WeakMap();
/**
 * PK3-I247-fix4（Codex 二轮 P1-2）：**身份不够，还要核内容**。登记的是可变对象，清洗之后把 HOME 或写目标
 * 改成夹具外的路径，只查身份就仍然放行。所以登记时按快照记下 HOME、写目标、删除目标与声明的私有根，
 * 执行边界再比一遍：**改过就拒**（越界判据在登记时已经跑过，这里只认快照）。
 */
const envSnapshot = (env) => JSON.stringify([env.HOME ?? null,
  ...PURGE_TARGET_ENV_KEYS.map((k) => env[k] ?? null), ...INSTALL_WRITE_TARGET_ENV_KEYS.map((k) => env[k] ?? null)]);
export function requireCleansedInstallerEnv(env) {
  if (env === null || typeof env !== "object" || !CLEANSED_INSTALLER_ENVS.has(env)) {
    throw new Error("安装器 / 卸载入口的子进程环境必须直接来自 installerChildEnv（执行边界核验：展开复制或原样继承都不算）");
  }
  const { snapshot, home, allowedForms, rootCanonicals } = CLEANSED_INSTALLER_ENVS.get(env);
  if (envSnapshot(env) !== snapshot) {
    throw new Error("清洗之后又改了 HOME / 写目标 / 删除目标 —— 拒绝启动安装器（认证过的环境不许再改：" + envSnapshot(env) + "）");
  }
  // PK3-I247-fix6（Codex 三轮 P1）：**文本没变不等于去向没变**。写目标路径上的某一段是 symlink 时，
  //   认证之后把它改指夹具外，环境变量一个字都没动（快照照样相等），安装器却会沿新去向写到夹具外。
  //   所以启动前按**登记时的夹具边界**（那时的 home 与声明的私有根，不是现在的 env）复核一次真实去向 ——
  //   越界判据里的 canonical 形态会 realpath 到链接的新目标。
  //   （我一度以为这是死分支删掉过，那是错的：symlink 改向正好绕过快照。）
  // PK3-I247-fix7（Codex 四轮 P1）：**允许范围也要冻结**。上一版在边界现算 realpath(home)：
  //   认证后把 home（或声明的私有根）本身移走、原路径改成指向夹具外的 symlink，允许范围和写目标一起挪出去，
  //   复核照样通过；默认写目标（没显式给、安装器按 HOME 派生的那些）更是直接跟着 HOME 去向走。
  //   所以：① 根的真实去向必须与认证时一致（变了就拒，默认写目标也就跟着被拦）；② 越界判据用冻结的允许范围。
  const movedRoots = rootCanonicals.filter(([root, canonical]) => canonicalPath(root) !== canonical);
  if (movedRoots.length > 0) {
    throw new Error("认证时的夹具根去向变了 —— 拒绝启动安装器（" +
      movedRoots.map(([root, canonical]) => root + "：认证时 " + canonical + " → 现在 " + canonicalPath(root)).join("；") + "）");
  }
  const outside = writeTargetsOutsideFixture({ env: { ...env, HOME: home }, allowedForms });
  if (outside.length > 0) {
    throw new Error("安装写目标的真实去向越出本用例夹具 —— 拒绝启动安装器（夹具：" + home + "）：" + JSON.stringify(outside));
  }
  return env;
}

export function installerChildEnv({ env = process.env, extra = {}, home = undefined, declaredPrivateRoots = [] } = {}) {
  const targetHome = typeof home === "string" && home.length > 0 ? home : (extra.HOME ?? env.HOME);
  const childEnv = purgeChildEnv({ env, home: targetHome, extra });
  const outside = writeTargetsOutsideFixture({ env: childEnv, declaredPrivateRoots });
  if (outside.length > 0) {
    throw new Error("安装写目标越出本用例夹具 —— 拒绝启动安装器（夹具：" + targetHome + "）：" + JSON.stringify(outside));
  }
  const roots = [targetHome, ...declaredPrivateRoots];
  CLEANSED_INSTALLER_ENVS.set(childEnv, {
    snapshot: envSnapshot(childEnv),
    home: targetHome,
    // 冻结：认证这一刻各根的 canonical 去向 + 由它们算出的允许范围（边界不再现算）。
    rootCanonicals: roots.map((r) => [r, canonicalPath(r)]),
    allowedForms: [...new Set(roots.flatMap(pathForms))],
  });
  return childEnv;
}

/** 一条路径的两种写法：**词法**（原样 resolve）与 **canonical**（最近存在祖先 realpath 再拼回剩余段）。 */
const pathForms = (p) => {
  const out = new Set([path.resolve(p)]);
  const canonical = canonicalPath(p);
  if (canonical !== null) out.add(canonical);
  return [...out];
};
const under = (t, base) => t === base || t.startsWith(base + path.sep);
/** 两种写法**都**要在白名单里（任一在外 = 在外）。 */
const insideAll = (p, allowedForms) => pathForms(p).every((form) => allowedForms.some((base) => under(form, base)));

/**
 * 本用例允许的夹具根：它的 `home`，加它**显式**传的两个桥根覆盖点 ——
 * 后者只有在两种写法都落在 home（或 `declaredPrivateRoots` 声明的私有目录）之下时才收。
 * `env` 是**最终子进程环境**（`purgeChildEnv` 的产物）。
 */
export function fixtureRootsFor({ env, declaredPrivateRoots = [] } = {}) {
  const home = env?.HOME;
  if (typeof home !== "string" || home.length === 0) {
    throw new Error("purge 夹具守卫：最终子进程环境里没有 HOME —— 没法判定夹具边界（用例写错了）");
  }
  const privateForms = declaredPrivateRoots.flatMap(pathForms);
  const allowedForms = [...new Set([...pathForms(home), ...privateForms])];
  const roots = [home];
  for (const key of ["CODEX_HOME", "FEISHU_CODEX_BRIDGE_HOME"]) {
    const v = env[key];
    if (typeof v !== "string" || v.length === 0) continue;
    // 证不出来（词法或 canonical 有一个在外）就不进白名单 —— 它派生的目标会在下面被报成越界。
    if (!insideAll(v, allowedForms)) continue;
    roots.push(v);
  }
  return roots;
}

/**
 * 这次 `--purge` 会删到夹具外的那些目标（空数组 = 全在界内）。
 * 只接**最终子进程环境**（fix8 P1-1）：HOME 与覆盖点都从它取。
 * 受验派生抛（相对路径之类）原样往上抛 —— 那本身就是"用例的 env 不成立"。
 */
export function purgeTargetsOutsideFixture({ env, declaredPrivateRoots = [] } = {}) {
  const home = env?.HOME;
  const roots = fixtureRootsFor({ env, declaredPrivateRoots });
  const allowedForms = [...new Set(roots.flatMap(pathForms))];
  const targets = machinePurgeTargets({ home, env });
  const all = [...targets.roots, ...targets.entries.dirs, ...targets.entries.files, ...targets.files];
  // 目标的**两种写法**都要在夹具里；任一在外就报出来（报的是它的两种写法，便于点名真实去向）。
  return all.filter((p) => !insideAll(p, allowedForms)).map((p) => pathForms(p).join(" → "));
}

/**
 * 用例**显式**给的安装写目标（收据 / 安装面锁）越出夹具的那些（空数组 = 在界内或没给）。
 * 与删除目标同一口径：词法与 canonical 两种写法都要落在 home 或 declaredPrivateRoots 之下（PK3-U1-fix9）。
 */
export function writeTargetsOutsideFixture({ env, declaredPrivateRoots = [], allowedForms: frozenForms = null } = {}) {
  const home = env?.HOME;
  if (typeof home !== "string" || home.length === 0) {
    throw new Error("写目标守卫：最终子进程环境里没有 HOME —— 没法判定夹具边界（用例写错了）");
  }
  // frozenForms（PK3-I247-fix7）：执行边界传**认证时冻结**的允许范围 —— 现算会跟着根一起被改向挪走。
  const allowedForms = frozenForms ?? [...new Set([home, ...declaredPrivateRoots].flatMap(pathForms))];
  return INSTALL_WRITE_TARGET_ENV_KEYS
    .map((k) => [k, env[k]])
    .filter(([, v]) => typeof v === "string" && v.length > 0 && !insideAll(v, allowedForms))
    .map(([k, v]) => k + "=" + pathForms(v).join(" → "));
}
