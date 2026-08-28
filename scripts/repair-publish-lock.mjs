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

/** 隔离残留那几行：有就列，清了标"已清"。 */
function describeQuarantine(r) {
  const q = r.quarantine ?? [];
  if (q.length === 0) return [];
  return q.map((e) => {
    const age = Math.round(e.ageMs / 1000) + " 秒";
    if (e.removed) return "已清隔离残留（" + age + "）：" + e.path;
    if (e.error) return "隔离残留删不掉（" + e.error + "）：" + e.path;
    if (!e.recognized) return "隔离路径上有不认识的东西，不动，请人工查看：" + e.path;
    return (e.ageMs > 60000 ? "隔离残留可清（" + age + "）：" : "隔离残留还新（" + age + "），不动：") + e.path;
  });
}

export function describeReapLockRepair(r, { apply }) {
  const lines = [];
  const age = Number.isFinite(r.ageMs) ? Math.round(r.ageMs / 1000) + " 秒" : "?";
  if (r.reason === "io_error") lines.push("维护未完成 —— I/O 错误（阶段 " + (r.phase ?? "?") + "：" + (r.error ?? "io_error") + "）：" + (r.path ?? (r.phase === "maintenance_lock" ? r.maintDir : r.reapDir)));
  else if (r.reason === "unrecognized_artifact") lines.push("reap 路径上的东西不是本协议的残骸（目录 / 普通文件 / 畸形 symlink），不动，请人工查看：" + r.reapDir);
  else if (r.reason === "maintenance_busy") lines.push("另一个维护者正在处理（维护锁在）：" + r.maintDir + "\n若确认没有维护者在跑，手动删除该维护锁后重试。");
  else if (r.reason === "instance_changed" || r.reason === "already_cleared") lines.push("残骸在处理期间已变化或已被清除，未动：" + r.reapDir);
  else if (r.reason === "quarantine_unremoved") lines.push("残骸已移到隔离路径但删不掉（" + (r.error ?? "?") + "），原路径已空：" + r.quarantinePath + "\n再跑一次本命令会盘点并清理它。");
  else if (!r.present) lines.push("没有 reap 残骸：" + r.reapDir);
  else if (!r.stale) lines.push("reap 锁还新（" + age + "），可能是活的，不动：" + r.reapDir);
  else if (r.removed) lines.push("已清除 reap 残骸（" + age + "）：" + r.reapDir);
  else lines.push((apply ? "" : "[预览] ") + "reap 残骸（" + age + "）可清除：" + r.reapDir + "\n加 --apply 执行。");
  lines.push(...describeQuarantine(r));
  return lines.join("\n");
}

/** 退出码：只有"确实没有 / 已清 / 预览"是 0；--apply 没做完的一律非零（评审：未完成也退 0 会被脚本当成功）。 */
export function repairExitCode(r, { apply }) {
  if (r.reason === "io_error" || r.reason === "unrecognized_artifact" || r.reason === "maintenance_busy"
    || r.reason === "quarantine_unremoved" || r.reason === "instance_changed") return 1;
  if ((r.quarantine ?? []).some((e) => e.error || (!e.recognized))) return 1;
  if (!apply) return 0;
  if (r.removed || !r.present || r.reason === "already_cleared") return 0;
  return 1; // apply 了但还新，没做
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRepairPublishLockArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write("用法：node repair-publish-lock.mjs --lock <发布锁路径> [--apply]（" + parsed.reason + "）\n");
    process.exit(2);
  }
  const r = clearStaleReapLock(parsed.lock, { apply: parsed.apply });
  process.stdout.write(describeReapLockRepair(r, { apply: parsed.apply }) + "\n");
  process.exit(repairExitCode(r, { apply: parsed.apply }));
}
