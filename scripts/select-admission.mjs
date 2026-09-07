// scripts/select-admission.mjs
// R52a：/feishu-select 的写入准入 —— **可注入**；默认实现固定返回 { state: "off" }（R50 合并前一律 fail-closed）。
// R50 合并（owner-select-state.mjs 进 main）后由 Frank 一行换成 readOwnerSelectAdmission。本模块**不 import 任何不在 main 的模块**。
//
// selectReject(adm, handle_kind)：给定准入状态联合（off / partial / on / unreadable）与 handle_kind，返回拒绝
//   { reason, text } 或 null（放行）。这是"三态准入"的确定性投影，测试用假 adm 覆盖四支。

/** 写入准入 —— 默认 fail-closed（off）。测试可通过 FEISHU_BRIDGE_TEST_SELECT_ADMISSION 注入；R50 合并后改为真读取器。 */
export function selectAdmission(env = process.env) {
  if (env?.FEISHU_BRIDGE_TEST_SELECT_ADMISSION) {
    try { return JSON.parse(env.FEISHU_BRIDGE_TEST_SELECT_ADMISSION); } catch {}
  }
  return { state: "off" };
}

/** 三态准入的确定性投影：返回 { reason, text }（拒绝）或 null（放行）。准入联合以外的任何状态（缺席/未知/非对象）一律投影为 unreadable → 拒。 */
export function selectReject(adm, handle_kind) {
  if (adm === null || typeof adm !== "object" || Array.isArray(adm)) {
    return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
  }
  if (adm.state === "unreadable") return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
  if (adm.state === "off") return { reason: "select_off", text: "选择功能未开放（迁移未开始）" };
  if (adm.state === "partial") {
    if (handle_kind !== "rfh") return { reason: "select_partial_not_rfh", text: "迁移期间只接受 rfh_ 重确认 handle" };
    return null;
  }
  if (adm.state === "on") return null;
  return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
}

/** 给定拒绝 reason 反解说明文案（重放从记录恢复文案时用）。 */
export function selectRejectTextByReason(reason) {
  if (reason === "select_writer_state_unreadable") return "选择功能状态读不清，未执行";
  if (reason === "select_off") return "选择功能未开放（迁移未开始）";
  if (reason === "select_partial_not_rfh") return "迁移期间只接受 rfh_ 重确认 handle";
  return "控制执行失败（" + reason + "）";
}
