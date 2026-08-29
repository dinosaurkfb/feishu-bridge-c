/**
 * chat 账本 scratch 残骸的显式维护入口 —— **热路径不删任何东西**，残骸只在这里清。
 *
 * 账本的临时文件（`<key>.<pid>.<time>.<uuid>`，与记录同目录）正常情况下会被 rename 成正式记录；
 * 事务半途失败（写失败、提交前锁丢失、rename 失败）才会留下。它们不参与准入盘点、不影响回答，
 * doctor（第 ⑨ 项）会点名。清理在账本锁内做：只认封闭名字、普通文件、超过阈值仍在的条目；
 * 名字是唯一的（uuid），协议里没有任何写者会再用同一个名字，所以"判断 → 按路径删"之间不会有协议内的新实例。
 * 破坏性 CLI：只认 --ledger <目录>、--apply、--older-than-ms <N>；未知参数、裸参数一律拒绝退出。默认只报告。
 */

import { isDirectRun } from "./direct-run.mjs";
import { sweepScratch, TMP_RESIDUE_AGE_MS } from "./chat-ledger.mjs";

export function parseChatScratchSweepArgs(argv) {
  let ledger = null;
  let apply = false;
  let olderThanMs = TMP_RESIDUE_AGE_MS;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === "--ledger") {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: "ledger_path_required" };
      ledger = v; i += 1; continue;
    }
    if (a === "--older-than-ms") {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n < 0) return { ok: false, reason: "older_than_ms_invalid" };
      olderThanMs = n; i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!ledger) return { ok: false, reason: "ledger_path_required" };
  return { ok: true, ledger, apply, olderThanMs };
}

/** 给人看的结果：预览列候选，apply 列已清 / 没清；说不清的条目单独列，不动。 */
export function describeScratchSweep(r, { apply }) {
  const lines = [];
  if (!r.ok) {
    lines.push(r.reason === "chat_admission_busy" ? "账本锁正被持有（另一笔事务在跑），这次没动；稍后再试" : "没拿到账本锁（" + String(r.reason) + (r.why ? "：" + r.why : "") + "），这次没动");
    return lines.join("\n");
  }
  for (const p of r.problems) lines.push("说不清，不动：" + p);
  if (r.young > 0) lines.push("进位中（还新）的临时文件 " + r.young + " 个，不动");
  if (r.candidates.length === 0) lines.push("没有可清的 scratch 残骸");
  for (const c of r.candidates) {
    const age = Math.round(c.ageMs / 1000) + " 秒";
    if (c.removed) lines.push("已清（" + age + "）：" + c.name);
    else if (c.error) lines.push("没清成（" + age + "，" + c.error + "）：" + c.name);
    else lines.push((apply ? "" : "[预览] ") + "残骸（" + age + "）可清：" + c.name);
  }
  if (!apply && r.candidates.length > 0) lines.push("加 --apply 执行。");
  return lines.join("\n");
}

/** 退出码：预览一律 0（除非有说不清 / 没拿到锁）；apply 没清干净的一律非零。 */
export function sweepExitCode(r, { apply }) {
  if (!r.ok) return 1;
  if (r.problems.length > 0) return 1;
  if (!apply) return 0;
  return r.candidates.every((c) => c.removed) ? 0 : 1;
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseChatScratchSweepArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write("用法：node chat-scratch-sweep.mjs --ledger <账本目录> [--apply] [--older-than-ms <N>]（" + parsed.reason + "）\n");
    process.exit(2);
  }
  const r = sweepScratch({ ledgerDir: parsed.ledger, apply: parsed.apply, olderThanMs: parsed.olderThanMs });
  process.stdout.write(describeScratchSweep(r, { apply: parsed.apply }) + "\n");
  process.exit(sweepExitCode(r, { apply: parsed.apply }));
}
