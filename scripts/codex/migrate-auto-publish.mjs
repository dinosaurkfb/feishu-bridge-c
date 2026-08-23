#!/usr/bin/env node
/**
 * 把历史 Codex task 迁移到「完成即自动发布」。默认只预览，`--apply` 才写。
 *
 * 为什么单独成命令：这件事原来挂在安装器上，每次 `--apply` 都会把所有 task 的
 * `auto_publish_on_completion` 强改为 true。那是在改**订阅策略**，不是装基础设施 ——
 * 装一次基础设施顺手改掉每条绑定的发布行为，而且不预览、不留痕、不可选。
 *
 * 新绑定不需要它：登记时就默认开启。这里只处理升级前留下的历史 task。
 *
 * 用法：
 *   node scripts/codex/migrate-auto-publish.mjs           # 只看会改哪些
 *   node scripts/codex/migrate-auto-publish.mjs --apply
 */

import { isDirectRun } from "../direct-run.mjs";
import {
  AUTO_PUBLISH_MIGRATION_ID, bridgeHome, enableAutoPublishForAllTasks, readMigrationReceipt,
} from "./state.mjs";

function main() {
  const apply = process.argv.includes("--apply");
  const result = enableAutoPublishForAllTasks({ home: bridgeHome(), apply });

  if (!result.ok) {
    console.error("迁移失败（" + result.reason + "）" +
      (result.error ? "：" + result.error : ""));
    process.exit(1);
  }

  console.log("迁移      " + AUTO_PUBLISH_MIGRATION_ID);
  console.log("已登记    " + result.tasks + " 个 task");
  console.log("待迁移    " + result.changed + " 个");
  // 只列脱敏名称，不打 thread locator。
  for (const name of result.names ?? []) console.log("          · " + name);

  if (!apply) {
    const prior = result.receipt;
    console.log("上次执行  " + (prior
      ? prior.applied_at + "（改了 " + prior.changed + " 条）"
      : "没有回执 —— 可能从没跑过，也可能跑过但留痕失败；重跑是幂等的"));
    console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
    return;
  }

  console.log(result.changed > 0
    ? "\n已为 " + result.changed + " 个历史 task 启用自动发布。"
    : "\n没有需要迁移的 task，未改动登记表。");

  if (result.receipt === false) {
    // 登记表已经改完了。这里说成完整成功就是谎报。
    console.error("注意：登记表已更新，但迁移回执没写成（" + result.receiptError + "）。" +
      "「跑没跑过」这个问题暂时答不了；重跑是幂等的。");
    process.exit(1);
  }
  console.log("回执      " + JSON.stringify(readMigrationReceipt()));
}

if (isDirectRun(import.meta.url)) main();
