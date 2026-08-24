#!/usr/bin/env node
/**
 * 机器级兜底排空 —— **逐 task 走 eligible-only 那条路，互不牵连。**
 *
 * 兜底定时器要跑的就是这个。原来 plist 里写的是 `drain-outbox.mjs --all`：
 * 那个用法**根本不存在** —— drain-outbox 要求精确 --task-key/--thread-id，
 * 拿到 --all 会打一行"找不到目标 task"然后 **exit 0**。
 * 于是定时器每 30 分钟静默空转，而外部看起来一切正常。
 * 我写 plist 时没跑过那条命令，是把"应该有"当成了"有"。
 *
 * 而且 drain-outbox 加上 --apply 会发送**全部** pending，不是 eligible-only；
 * 兜底重试只能补发已经取得发布资格的内容，不能把没资格的顺手发出去。
 * publishEligibleTaskEvents 才是符合语义的那条。
 *
 * **一个 task 失败不许影响其他 task。**兜底的价值就在于它是最后一道；
 * 一条坏记录让整轮扫描中断，等于没有兜底。
 */

import { isDirectRun } from "../direct-run.mjs";
import { publishEligibleTaskEvents } from "./publish-eligible.mjs";
import { bridgeHome, loadRegistry, registryFile } from "./state.mjs";

/**
 * 扫一遍全部登记 task。
 *
 * `publish` 可注入 —— **测试不许打到真实飞书。**这个仓库为"测试打到真机"
 * 付过代价，注入口是唯一能从结构上杜绝它的办法。
 */
export function sweepEligible({
  home = bridgeHome(),
  publish = publishEligibleTaskEvents,
} = {}) {
  const reg = loadRegistry(registryFile(home));
  if (!reg.ok) return { ok: false, reason: "registry_unreadable" };

  const results = [];
  for (const task of reg.tasks ?? []) {
    let outcome;
    try {
      outcome = publish({ task, home });
    } catch (err) {
      // **抓住并继续。**抛出来的话，后面的 task 这一轮就都没有兜底了。
      outcome = { status: "error", reason: "threw",
        error: String(err?.message ?? err).slice(0, 400) };
    }
    results.push({ key: task?.logical_task_key ?? null, ...outcome });
  }
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  return { ok: true, results, tally, errors: results.filter((r) => r.status === "error") };
}

function main() {
  const swept = sweepEligible();
  if (!swept.ok) {
    console.error("扫描失败（" + swept.reason + "）—— 一个 task 都没处理。");
    process.exit(1);
  }
  const parts = Object.entries(swept.tally).map(([k, n]) => k + " " + n);
  console.log(new Date().toISOString() + " 扫描 " + swept.results.length + " 个 task：" +
    (parts.length > 0 ? parts.join("，") : "无"));
  for (const e of swept.errors) {
    console.error("  task " + (e.key ?? "?") + " 失败：" + e.reason +
      (e.error ? "（" + e.error + "）" : ""));
  }
  // **有失败就非零退出。**launchd 的日志里全是 exit 0 的话，
  // "一直在跑"和"一直在空转"长得一模一样。
  process.exit(swept.errors.length > 0 ? 1 : 0);
}

if (isDirectRun(import.meta.url)) main();
