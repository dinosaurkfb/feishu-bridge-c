/**
 * 控制命令事务的显式维护入口（Codex 侧）：与 Claude 侧同一套判据（control-command.mjs），只换定位与执行器。
 * 只认 --thread-id <id>、--key <64位hex>、--apply。
 */

import { isDirectRun } from "../direct-run.mjs";
import { describeControlRepair, parseRepairControlArgs, repairExitCode } from "../repair-control-claim.mjs";
import { inspectControlClaim, resumeControlClaim } from "../control-command.mjs";
import { bridgeHome, findRegisteredTaskForCodexThread, setTaskInteractionMode, taskPaths } from "./state.mjs";

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairControlArgs(process.argv.slice(2), { target: "--thread-id" });
  if (!parsed.ok) { process.stderr.write("用法：node codex/repair-control-claim.mjs --thread-id <id> --key <64位hex> [--apply]（" + parsed.reason + "）\n"); process.exit(2); }
  const home = bridgeHome();
  const found = findRegisteredTaskForCodexThread({ threadId: parsed.root, home });
  if (!found.ok) { process.stdout.write("找不到这个 thread 的 task（" + found.reason + "）\n"); process.exit(1); }
  const claimsDir = taskPaths(found.task, home).claims;
  const seen = inspectControlClaim({ claimsDir, key: parsed.key });
  let result = null;
  if (parsed.apply && (seen.state === "in_flight" || seen.state === "consumed_unreadable")) {
    result = resumeControlClaim({ claimsDir, key: parsed.key, execute: (mode) => setTaskInteractionMode({ threadId: parsed.root, mode, home }) });
  }
  process.stdout.write(describeControlRepair({ seen, result, apply: parsed.apply }) + "\n");
  process.exit(repairExitCode({ seen, result, apply: parsed.apply }));
}
