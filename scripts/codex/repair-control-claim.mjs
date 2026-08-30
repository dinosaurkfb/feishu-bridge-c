/**
 * 控制命令事务的显式维护入口（Codex 侧）：与 Claude 侧同一套判据（control-command.mjs），只换定位与执行器。
 * 只认 --thread-id <id>、--key <64位hex>、--apply。身份 = { logical_task_key, codex_thread_id }，写锁内用锁内刚读出的 task 再核一遍。
 */

import { isDirectRun } from "../direct-run.mjs";
import { describeControlRepair, parseRepairControlArgs, repairExitCode } from "../repair-control-claim.mjs";
import { RESUMABLE_CONTROL_STATES, inspectControlClaim, resumeControlClaim } from "../control-command.mjs";
import { codexControlPrecondition } from "./control-identity.mjs";
import { RESUMABLE_REJECT_STATES, describeRejectRepair, inspectRejectedClaim, rejectRepairExitCode, resumeRejectedClaim } from "../reject-control.mjs";
import { bridgeHome, findRegisteredTaskForCodexThread, setTaskInteractionMode, taskPaths } from "./state.mjs";
import { gateBlocks, exitForGate } from "../maintenance-gate-core.mjs";

export { codexControlPrecondition as codexControlRepairPrecondition } from "./control-identity.mjs";

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
  if (parsed.apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）
  if (parsed.apply && (RESUMABLE_CONTROL_STATES.includes(seen.state) || seen.state === "consumed")) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, expect,
      execute: (mode) => setTaskInteractionMode({ threadId: parsed.root, mode, home,
        precondition: codexControlPrecondition({ claimsDir, key: parsed.key, expect }) }) });
  }
  // 不是控制命令的 claim 也可能是收边的拒绝（第 3 层）：同一个入口，另一套事务。
  if (seen.state === "not_control") {
    const rj = inspectRejectedClaim({ claimsDir, key: parsed.key, expect });
    if (rj.state !== "not_rejected_control") {
      const rr = parsed.apply && (RESUMABLE_REJECT_STATES.includes(rj.state) || rj.state === "rejected") ? resumeRejectedClaim({ claimsDir, key: parsed.key, expect }) : null;
      process.stdout.write(describeRejectRepair({ seen: rj, result: rr, apply: parsed.apply }) + "\n");
      process.exit(rejectRepairExitCode({ seen: rj, result: rr, apply: parsed.apply }));
    }
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
