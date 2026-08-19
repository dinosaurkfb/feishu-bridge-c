#!/usr/bin/env node
/**
 * 一次性完成守望者：盯住一次已授权投递的 run，跑完就发布结果，然后退出。
 *
 * 这不是「持续监听飞书」—— 它不碰飞书入站、不轮询消息、不接受新指令。
 * 它只看一个本地文件，由一次已通过校验和 claim 的投递触发，有上限、会自己结束。
 * 需求里「最终结果触发下一轮出站」这一条，就是靠它闭环的。
 *
 * 它同时负责释放会话锁 —— 投递进程是 detached 的，退出时锁还得留着挡并发，
 * 只能由知道 run 何时结束的这一方来放。
 */

import fs from "node:fs";
import path from "node:path";

import { readRunOutcome } from "./handoff.mjs";
import { scanRuns, buildDraft, markPublished, publishDraft } from "./outbound.mjs";
import { listPending, markSent, composeDigest } from "./outbox.mjs";
import { recordClaimState } from "./claim.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RT = path.join(ROOT, ".runtime-data", "inbound");
const RUNS = path.join(RT, "runs");
const OUTBOX = path.join(ROOT, ".runtime-data", "outbound", "outbox");
const CLAIMS = path.join(RT, "delivery-claims");
const LOCK = path.join(RT, "session.lock");

const key = process.argv[2];
if (!key) {
  console.error("usage: watch-and-publish.mjs <claim-key>");
  process.exit(2);
}

const POLL_MS = 4000;
// 上限存在的意义是「绝不无限期占着锁」。到点就放锁并如实记为超时，
// 不发布任何东西 —— 没跑完的东西没有可发布的结论。
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;

const logPath = path.join(RUNS, key + ".jsonl");
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const finishUp = () => fs.rmSync(LOCK, { recursive: true, force: true });

while (true) {
  const outcome = readRunOutcome(logPath);

  if (outcome.state !== "running" && outcome.state !== "missing") {
    recordClaimState({
      claimsDir: CLAIMS, key, state: outcome.state === "completed" ? "handed_off" : "failed",
      detail: { run_state: outcome.state, observed_by: "watch-and-publish" },
    });

    const cfg = JSON.parse(fs.readFileSync(path.join(RT, "chain-config.json"), "utf-8"));
    const mapping = JSON.parse(fs.readFileSync(path.join(RT, "active-mapping.json"), "utf-8"));
    const run = scanRuns({ runsDir: RUNS }).find((r) => r.key === key);

    // 本次 run 期间任务记下的进展，和这次的执行结果合并成一条发。
    // 分两条发意味着 Frank 一次指令要收三条消息（已受理 + 结果 + 进展），太吵。
    const pendingOutbox = listPending({ outboxDir: OUTBOX });

    const parts = [];
    if (run?.shouldPublish) {
      const d = buildDraft(run, { taskName: cfg.task_display_name });
      if (d) parts.push(d);
    }
    if (pendingOutbox.length > 0) {
      parts.push(composeDigest(pendingOutbox, { taskName: cfg.task_display_name }));
    }

    if (parts.length > 0) {
      try {
        const mid = publishDraft({
          profile: cfg.lark_cli_profile,
          rootMessageId: mapping.feishu_root_message_id_reference,
          text: parts.join("\n\n———\n\n"),
          larkBin: cfg.lark_cli_bin,
          larkHome: cfg.lark_cli_home,
        });
        // 只有真的发出去了才标记。顺序无所谓，但两者都必须在成功之后。
        if (run?.shouldPublish) markPublished({ runsDir: RUNS, key, messageId: mid });
        for (const r of pendingOutbox) markSent(r, mid);
        console.log("published " + key.slice(0, 8) + " -> " + mid +
          " (run=" + (run?.shouldPublish ? "yes" : "no") + ", outbox=" + pendingOutbox.length + ")");
      } catch (err) {
        // 不标记任何一方：outbox 留着下轮重试，run 也还是待发布。
        // 留痕给人工，但绝不伪造已送达。
        fs.writeFileSync(path.join(RUNS, key + ".publish-failed.json"),
          JSON.stringify({ at: new Date().toISOString(), error: String(err.message).slice(0, 500) }, null, 2));
        console.error("publish failed (outbox 保留待重试): " + err.message);
      }
    }
    finishUp();
    process.exit(0);
  }

  if (Date.now() - startedAt > MAX_WAIT_MS) {
    recordClaimState({ claimsDir: CLAIMS, key, state: "failed",
      detail: { reason: "watch_timeout", waited_ms: Date.now() - startedAt } });
    finishUp();
    console.error("watch timeout for " + key);
    process.exit(1);
  }

  await sleep(POLL_MS);
}
