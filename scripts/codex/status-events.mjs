/**
 * Codex 侧 `$feishu-status` 第五区「待处理事件」的行 —— **只转述，不判断**。
 *
 * 判据只有一份：outbox 那一半来自 collectBacklog（auditOutbox / describeRecordState /
 * retryProtection / describeTaskPublishability，与 `$feishu-outbox` 同源）；发布资格那一半来自
 * listEligibilityPending（与恢复消费者同源）。两者都是只读，不 claim、不改盘、不发布。
 * 读不出来 / 没绑定 各自明写，不折叠成 0；输出只给文件名与 key 前 8 位，why 一律过 displaySafe。
 */

import { displaySafe } from "../display-safe.mjs";
import { collectBacklog } from "./feishu-outbox.mjs";
import { listEligibilityPending } from "./eligibility-recovery.mjs";
import { taskPaths } from "./state.mjs";
import { verifyCodexRunCredential } from "./handoff.mjs";

const WHY_MAX = 120;
const clip = (text) => {
  const safe = displaySafe(text);
  const points = Array.from(safe);
  return points.length > WHY_MAX ? points.slice(0, WHY_MAX).join("") + "…（已截断）" : safe;
};
const shortKey = (key) => (typeof key === "string" && key.length > 0 ? key.slice(0, 8) : "--------");

/** 需要人看的记录状态：不是"等等就好"，是等人。 */
const ATTENTION = new Set(["auth_malformed", "target_gone", "corrupt", "unknown_target"]);

export function codexPendingEventRows({ home, threadId, task } = {}) {
  if (!task) return [["出站记录", "不适用（尚未绑定）"]];
  const rows = [];

  // ── outbox 那一半
  const backlog = collectBacklog({ home, threadId });
  if (!backlog.ok) {
    rows.push(["出站记录", "说不清（" + displaySafe(backlog.reason ?? "读不出来") + "）"]);
  } else {
    const entry = backlog.tasks[0] ?? null;
    if (entry && !entry.readable) {
      rows.push(["出站记录", "说不清（" + displaySafe(entry.unreadableReason ?? "读不出来") + "）"]);
    } else {
      const records = entry?.records ?? [];
      const rejected = records.filter((r) => r.rejected);
      const attention = records.filter((r) => !r.rejected && (ATTENTION.has(r.state) || r.protectionCorrupt));
      const ready = records.filter((r) => !r.rejected && !r.protectionCorrupt && r.state === "ready");
      const waiting = records.filter((r) => !r.rejected && !r.protectionCorrupt && r.state === "not_eligible");
      rows.push(["就绪待发", ready.length + " 条"]);
      rows.push(["等发布资格", waiting.length + " 条"]);
      if (rejected.length > 0) {
        rows.push(["已暂停重试", rejected.length + " 条（被永久拒绝，等人处理）"]);
        for (const r of rejected) rows.push(["  " + clip(r.file), (r.rejectedKind ?? "paused") + (r.rejectedWhy ? "：" + clip(r.rejectedWhy) : "")]);
      }
      if (attention.length > 0) {
        rows.push(["需要人看", attention.length + " 条"]);
        for (const r of attention) rows.push(["  " + clip(r.file), (r.protectionCorrupt ? "retry_protection_corrupt" : r.state) + "：" + clip(r.why)]);
      }
      const problems = [...(entry?.unclassified ?? []), ...(entry?.unexplainable ?? [])];
      rows.push(["outbox 账本", problems.length ? "说不清 " + problems.length + " 处" : "无异常"]);
      for (const p of problems) rows.push(["  " + clip(p.file), clip(p.why)]);
      if (entry?.taskState && entry.taskState.ok === false) rows.push(["task 可发布", clip(entry.taskState.text)]);
    }
  }

  // ── 发布资格那一半（等资格提升的标记）。标记里的 run_state=completed 是自报 ——
  // 与恢复消费者同一道门：经 verifyCodexRunCredential 核验过才说"run 已完成"，否则只说"待核验"。
  const paths = taskPaths(task, home);
  const eligibility = listEligibilityPending({ claimsDir: paths.claims, threadId });
  if (!eligibility.ok) {
    rows.push(["资格标记", "说不清（" + displaySafe(eligibility.reason ?? "读不出来") + "）"]);
  } else {
    const verified = [];
    const unverified = [];
    for (const i of eligibility.items.filter((x) => !x.unusable)) {
      const credential = verifyCodexRunCredential({ runsDir: paths.runs, claimKey: i.key, expectedThreadId: threadId });
      if (credential.state === "completed") verified.push(i);
      else unverified.push({ ...i, why: credential.state === "running" ? "退出回执缺席"
        : (credential.reason ?? "说不清") + (credential.why ? "：" + credential.why : "") });
    }
    const unusable = eligibility.items.filter((i) => i.unusable);
    rows.push(["等资格恢复", verified.length + " 条" + (verified.length ? "（run 已完成、凭据已核验，发布资格待提升）" : "")]);
    if (unverified.length > 0) {
      rows.push(["资格待核验", unverified.length + " 条（有标记，终局凭据未核验通过）"]);
      for (const i of unverified) rows.push(["  " + shortKey(i.key), clip(i.why)]);
    }
    if (unusable.length > 0) {
      rows.push(["资格标记", "说不清 " + unusable.length + " 处"]);
      for (const i of unusable) rows.push(["  " + shortKey(i.key), clip(i.unusable)]);
    }
  }
  return rows;
}
