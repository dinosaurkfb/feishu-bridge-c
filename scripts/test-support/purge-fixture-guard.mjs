/**
 * 真 purge 用例的**夹具边界守卫**（PK3-U1-fix7）。
 *
 * 为什么要它：卸载入口的删除清单会被**环境覆盖点**改变 —— `machinePurgeTargets` 读的就是这几个
 * （`CODEX_HOME` / `FEISHU_CODEX_BRIDGE_HOME` 换桥根，`FEISHU_BRIDGE_REGISTRY` / `_ROUTES` /
 * `_STATUS_PROVIDERS` / `_CHAIN_TEMPLATE` 换覆盖文件）。测试辅助过去把 `process.env` **原样**交给子进程，
 * 而开发机上这些变量常常真的指着线上数据（套件的绊线自己就设了 `FEISHU_BRIDGE_CHAIN_TEMPLATE`）——
 * 一条"真 `--purge --apply`"的用例就可能把**夹具之外**的文件删掉，而全绿只证明那次运行的环境没触发。
 *
 * 两道闸：
 *   ① `purgeChildEnv()`：构造子进程环境时**先剔除**那一整份覆盖点（清单与产品同源：`PURGE_TARGET_ENV_KEYS`），
 *      再叠加用例显式给的 env —— 继承值再也进不去。
 *   ② `purgeTargetsOutsideFixture()`：启动删除入口**之前**，用同一份 env 与 home 调一次
 *      `machinePurgeTargets`，把每一项与"本用例的夹具"比一遍，越界的**返回出来**（调用方据此拒绝启动）。
 *      夹具 = 用例的 `home` ∪ 它**显式**传的 `CODEX_HOME` / `FEISHU_CODEX_BRIDGE_HOME`（这两个是桥根，
 *      用例有权把桥根放在自己的另一个临时目录里）。四个**文件覆盖点不享受这个待遇**：
 *      它们必须落在夹具之内 —— 指到夹具外正是这条守卫要拦的形状。
 */
import path from "node:path";

import { PURGE_TARGET_ENV_KEYS, machinePurgeTargets } from "../maintenance/install-footprint.mjs";

/** 子进程环境：剔掉全部删除目标覆盖点（继承值），再叠加用例显式给的 env。 */
export function purgeChildEnv({ env = process.env, home, extra = {} } = {}) {
  const out = { ...env };
  for (const key of PURGE_TARGET_ENV_KEYS) delete out[key];
  if (typeof home === "string" && home.length > 0) out.HOME = home;
  return { ...out, ...extra };
}

/** 本用例允许的夹具根：它的 home，加它**显式**传的两个桥根覆盖点。 */
export function fixtureRootsFor({ home, extra = {}} = {}) {
  return [home, extra.CODEX_HOME, extra.FEISHU_CODEX_BRIDGE_HOME]
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((p) => path.resolve(p));
}

/**
 * 这次 `--purge` 会删到夹具外的那些目标（空数组 = 全在界内）。
 * 受验派生抛（相对路径之类）原样往上抛 —— 那本身就是"用例的 env 不成立"。
 */
export function purgeTargetsOutsideFixture({ home, env, extra = {} } = {}) {
  const allowed = fixtureRootsFor({ home, extra });
  const targets = machinePurgeTargets({ home, env });
  const all = [...targets.roots, ...targets.entries.dirs, ...targets.entries.files, ...targets.files];
  const under = (t, base) => t === base || t.startsWith(base + path.sep);
  return all.map((p) => path.resolve(p)).filter((t) => !allowed.some((base) => under(t, base)));
}
