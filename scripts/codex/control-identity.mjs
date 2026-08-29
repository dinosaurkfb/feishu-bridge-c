/**
 * 控制命令事务的**身份判据**（Codex 侧，非 CLI 层）—— 生产入口与维护入口共用同一份。
 * 写锁内的前置条件：锁内刚读出的 task 必须仍是同一身份（logical task / thread），且此刻的 claim 仍属于它。
 */
import { readClaimState } from "../claim.mjs";

export function codexControlPrecondition({ claimsDir, key, expect }) {
  return (task) => {
    if (!task || typeof task !== "object") return false;
    if (task.logical_task_key !== expect.logicalTaskKey || task.codex_thread_id !== expect.codexThreadId) return false;
    return readClaimState({ claimsDir, key, expect }).status === "valid";
  };
}
