/**
 * 控制命令事务的显式维护入口（Codex 侧）：与 Claude 侧同一套判据（control-command.mjs），只换定位与执行器。
 * 只认 --thread-id <id>、--key <64位hex>、--apply。身份 = { logical_task_key, codex_thread_id }，写锁内用锁内刚读出的 task 再核一遍。
 */

import { isDirectRun } from "../direct-run.mjs";
import { describeControlRepair, parseRepairControlArgs, repairExitCode } from "../repair-control-claim.mjs";
import { RESUMABLE_CONTROL_STATES, inspectControlClaim, resumeControlClaim } from "../control-command.mjs";
import { readClaimState } from "../claim.mjs";
import { bridgeHome, findRegisteredTaskForCodexThread, setTaskInteractionMode, taskPaths } from "./state.mjs";

/** 写锁内的前置条件：锁内刚读出的 task 必须仍是同一身份，且此刻的 claim 仍属于它。 */
export function codexControlRepairPrecondition({ claimsDir, key, expect }) {
  return (task) => {
    if (!task || typeof task !== "object") return false;
    if (task.logical_task_key !== expect.logicalTaskKey || task.codex_thread_id !== expect.codexThreadId) return false;
    return readClaimState({ claimsDir, key, expect }).status === "valid";
  };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairControlArgs(process.argv.slice(2), { target: "--thread-id" });
  if (!parsed.ok) { process.stderr.write("用法：node codex/repair-control-claim.mjs --thread-id <id> --key <64位hex> [--apply]（" + parsed.reason + "）\n"); process.exit(2); }
  const home = bridgeHome();
  const found = findRegisteredTaskForCodexThread({ threadId: parsed.root, home });
  if (!found.ok) { process.stdout.write("找不到这个 thread 的 task（" + found.reason + "）\n"); process.exit(1); }
  const claimsDir = taskPaths(found.task, home).claims;
  const expect = { logicalTaskKey: found.task.logical_task_key, codexThreadId: parsed.root };
  const seen = inspectControlClaim({ claimsDir, key: parsed.key, expect });
  let result = null;
  if (parsed.apply && (RESUMABLE_CONTROL_STATES.includes(seen.state) || seen.state === "consumed")) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, expect,
      execute: (mode) => setTaskInteractionMode({ threadId: parsed.root, mode, home,
        precondition: codexControlRepairPrecondition({ claimsDir, key: parsed.key, expect }) }) });
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
