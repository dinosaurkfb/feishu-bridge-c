/**
 * 发布锁 reap 残骸的显式维护入口。
 *
 * reap 锁是改变锁归属（陈旧回收、释放）时的互斥段，只持有几毫秒；回收者恰好崩在里面才会留下残骸。
 * 热路径**不自愈**（自愈会把"判断与修改分离"的窗口递归复现），残骸表现为 acquire / release 报 reap_residue。
 * 这是破坏性 CLI：只认 --lock <路径>、--apply。未知参数、裸参数一律拒绝退出。默认只报告。
 */

import { isDirectRun } from "./direct-run.mjs";
import { clearStaleReapLock } from "./registry.mjs";

export function parseRepairPublishLockArgs(argv) {
  let lock = null;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === "--lock") {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: "lock_path_required" };
      lock = v; i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!lock) return { ok: false, reason: "lock_path_required" };
  return { ok: true, lock, apply };
}

export function describeReapLockRepair(r, { apply }) {
  if (!r.present) return "没有 reap 残骸：" + r.reapDir;
  const age = Math.round(r.ageMs / 1000) + " 秒";
  if (!r.stale) return "reap 锁还新（" + age + "），可能是活的，不动：" + r.reapDir;
  if (r.removed) return "已清除 reap 残骸（" + age + "）：" + r.reapDir;
  return (apply ? "" : "[预览] ") + "reap 残骸（" + age + "）可清除：" + r.reapDir + "\n加 --apply 执行。";
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairPublishLockArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write("用法：node repair-publish-lock.mjs --lock <发布锁路径> [--apply]（" + parsed.reason + "）\n");
    process.exit(2);
  }
  const r = clearStaleReapLock(parsed.lock, { apply: parsed.apply });
  process.stdout.write(describeReapLockRepair(r, { apply: parsed.apply }) + "\n");
  process.exit(0);
}
