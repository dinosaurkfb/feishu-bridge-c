/**
 * R57b 返修六 P2：形状常量叶子模块（无上层依赖）。
 *   把 selection-plan 与账本模块共用的形状常量下沉到这里——selection-plan 不反向依赖大账本模块，
 *   是真叶子；topic-agent-ledger 从这里 import 并 re-export（保持既有导出面不变）。
 *
 *   ID_SHAPE / SELECTION_HANDLE_SHAPE / REBIND_HANDLE_SHAPE / REAFFIRM_HANDLE_SHAPE 为账本与
 *   selection-plan 共用；CLAIM_KEY_SHAPE 为 control claim 主键形状（64hex，from claim.mjs）。
 *   同一形状只住一处，其余模块不再各写一份。
 */

/** 目标 id：ta_ + 32hex。 */
export const ID_SHAPE = /^ta_[0-9a-f]{32}$/u;
/** 选择 handle：osh_ + 32hex。 */
export const SELECTION_HANDLE_SHAPE = /^osh_[0-9a-f]{32}$/u;
/** rebind handle：orh_ + 32hex。 */
export const REBIND_HANDLE_SHAPE = /^orh_[0-9a-f]{32}$/u;
/** reaffirm handle：rfh_ + 32hex。 */
export const REAFFIRM_HANDLE_SHAPE = /^rfh_[0-9a-f]{32}$/u;
/** control claim 主键：64hex（与 control claim 用同一形状常量，防路径型 key 越界）。 */
export const CLAIM_KEY_SHAPE = /^[0-9a-f]{64}$/u;
