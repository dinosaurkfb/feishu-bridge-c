/* 退出码叶子纯模块：owner_select 与 ledger 两个 CLI 共用，不依赖任何编排/账本模块（只依赖本文件内常量）。 */
export const OSM_FORWARD_PHASES = Object.freeze(["osm_a_upgrading", "osm_b_strictening", "osm_direct", "ledger_reopening", "reopening_incomplete"]);
export const FORWARD_PHASES = Object.freeze(["ledger_initializing", "ledger_cutting_over", "ledger_reopening"]);

/** 退出码判据（单一出处，两 CLI 消费）：
 *  0 = ok；1 = 干净拒绝（rollback 成功 / drained 等 rollback-safe 未动现场 / startup_source_unverified）；
 *  3 = 已动现场但没做完（forward-only 卡住 / 回退没做全 / reopen 没做完 / lease/surface 交不还）。
 *  `drained` 是 rollback-safe，**不进 forward 集**（OSM_FORWARD_PHASES 不含它）。 */
export function exitCodeFor({ phase = null, ok = false, reason = null, leaseRelease = null, surfaceRelease = null, rollback = null } = {}) {
  if (leaseRelease ?? surfaceRelease ?? null) return 3;
  if (ok) return 0;
  if (rollback && rollback.ok === true) return 1; // 回退清干净 → 干净拒绝
  if (rollback && rollback.ok === false) return 3; // 回退没做全：动了没做完
  if (reason === "osm_forward_failed" || reason === "osm_rollback_failed" || reason === "ledger_forward_failed" || reason === "ledger_rollback_failed") return 3;
  if (OSM_FORWARD_PHASES.includes(phase) || FORWARD_PHASES.includes(phase)) return 3; // 卡在 forward-only
  if (phase === "rollback_incomplete") return 3; // 回退删 plan 失败等
  if (reason === "reopening_incomplete") return 3; // 重开没做完
  if (reason === "startup_source_unverified") return 1; // 进门就被拒，什么都没动
  return 1;
}
