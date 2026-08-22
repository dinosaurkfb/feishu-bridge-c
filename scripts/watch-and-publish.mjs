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
import { listPending, markSent } from "./outbox.mjs";
import { composeOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import { readClaim, recordClaimState } from "./claim.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import {
  businessActivitiesForPublishedBatch, recordClaudeActivityAndMaybeRotate,
} from "./automatic-topic-rotation.mjs";

const SELF = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const key = process.argv[2];
if (!key) {
  console.error("usage: watch-and-publish.mjs <claim-key> [project-root]");
  process.exit(2);
}

// 项目根由调用方传进来。多绑定之后守望者可能在盯任何一个项目的 run，
// 写死本仓库会让它去读错项目的 run 日志、放错项目的锁、把结果发到错的话题里。
// 不传就退回本仓库 —— 老的调用方式仍然有效。
const ROOT = path.resolve(process.argv[3] ?? SELF);
const RT = path.join(ROOT, ".runtime-data", "inbound");
const RUNS = path.join(RT, "runs");
const CLAIMS = path.join(RT, "delivery-claims");
const LOCK = path.join(RT, "session.lock");
const PUBLISH_LOCK = path.join(ROOT, ".runtime-data", "outbound", "publish.lock");

const POLL_MS = 4000;
// 上限存在的意义是「绝不无限期占着锁」。到点就放锁并如实记为超时，
// 不发布任何东西 —— 没跑完的东西没有可发布的结论。
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;

const logPath = path.join(RUNS, key + ".jsonl");
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const finishUp = () => fs.rmSync(LOCK, { recursive: true, force: true });
const acceptedClaim = readClaim({ claimsDir: CLAIMS, key });
const originGenerationId = acceptedClaim?.origin_channel_generation_id ?? null;
const claudeSessionId = acceptedClaim?.claude_session_id ?? null;
const OUTBOX = path.join(ROOT, ".runtime-data", "outbound",
  claudeSessionId ? "outbox-" + claudeSessionId : "outbox");

const groupByTargetGeneration = (records) => {
  const groups = new Map();
  for (const record of records) {
    const target = record.target_channel_generation_id ?? "__legacy_active__";
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(record);
  }
  return [...groups.entries()];
};

/**
 * 兜底定时器可能正好在排空同一个 outbox。等它一小会儿而不是抢 ——
 * 它只需要几秒，而这边一旦抢跑，同一批进展会被发两遍。
 */
async function waitForPublishLock(tries = 10, gapMs = 1500) {
  for (let i = 0; i < tries; i += 1) {
    const r = acquirePublishLock(PUBLISH_LOCK);
    if (r.ok) return r;
    await sleep(gapMs);
  }
  return { ok: false, reason: "publisher_busy" };
}

while (true) {
  const outcome = readRunOutcome(logPath);

  if (outcome.state !== "running" && outcome.state !== "missing") {
    recordClaimState({
      claimsDir: CLAIMS, key, state: outcome.state === "completed" ? "handed_off" : "failed",
      detail: { run_state: outcome.state, observed_by: "watch-and-publish" },
    });

    // 跟出站其余部分共用同一个解析：项目目录里有配置就用它，
    // 没有就回落到「机器模板 + 登记表那一行」。登记表接入的项目这里没有文件可读。
    const resolved = resolveProject({ root: ROOT, claudeSessionId });
    if (!resolved.ok || !resolved.config) {
      throw new Error("读不到这个项目的链路配置（" + (resolved.reason ?? resolved.configError?.reason) + "）");
    }
    const cfg = resolved.config;
    const mapping = resolved.mapping;
    const run = scanRuns({ runsDir: RUNS }).find((r) => r.key === key);

    // 排空 outbox 前先拿发布锁：会话结束钩子和兜底定时器都会排空同一个 outbox。
    // 锁必须罩住 listPending→publish→markSent 整段，否则两边会各读到同一批 pending。
    const publishLock = await waitForPublishLock();
    try {
      // 本次 run 期间任务记下的进展，和这次的执行结果合并成一条发。
      // 分两条发意味着 Frank 一次指令要收三条消息（已受理 + 结果 + 进展），太吵。
      //
      // 等不到锁就只发执行结果，进展那一半让给正在排空的那一方：
      // 代价是 Frank 收到两条而不是一条，而扣着执行结果不发的代价大得多。
      const pendingOutbox = publishLock.ok ? listPending({ outboxDir: OUTBOX }) : [];

      const records = [];
      if (run?.shouldPublish) {
        const d = buildDraft(run, { taskName: cfg.task_display_name });
        if (d) records.push({
          kind: run.state === "completed" ? "reply" : "risk",
          text: d,
          source: "claude-run-watcher",
          target_channel_generation_id: originGenerationId,
          run_id: key,
          _run: true,
        });
      }
      records.push(...pendingOutbox);

      if (records.length > 0) {
        try {
          // 身份从配置推，跟主出站路径走同一个解析；发之前 publishDraft 会校验凭据归属。
          const ident = resolveLarkIdentity(cfg);
          const mids = [];
          for (const [targetKey, targetRecords] of groupByTargetGeneration(records)) {
            const target = resolveMappingOutboundGeneration(
              mapping,
              targetKey === "__legacy_active__" ? null : targetKey,
            );
            if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
            for (const batch of outboundCardBatches(targetRecords)) {
              const mid = publishDraft({
                profile: ident.profile,
                rootMessageId: target.rootMessageId,
                card: composeOutboundCard(batch, { taskName: cfg.task_display_name, runtime: "claude" }),
                larkBin: ident.bin,
                larkHome: ident.configDir,
                expectedAppId: ident.expectedAppId,
              });
              for (const activity of businessActivitiesForPublishedBatch(batch, {
                messageId: mid, runtime: "claude",
              })) {
                recordClaudeActivityAndMaybeRotate({
                  root: ROOT,
                  claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
                  generationId: target.channelGenerationId,
                  ...activity,
                });
              }
              // 每张成功后立刻标记。后续卡片失败时，已送达的回合不会在重试中重复发送。
              if (batch.some((record) => record._run === true)) {
                markPublished({ runsDir: RUNS, key, messageId: mid });
              }
              for (const record of batch.filter((item) => item._file)) markSent(record, mid);
              mids.push(mid);
            }
          }
          console.log("published " + key.slice(0, 8) + " -> " + (mids.at(-1) ?? "none") +
            " (cards=" + mids.length + ", run=" + (run?.shouldPublish ? "yes" : "no") +
            ", outbox=" + pendingOutbox.length + ")");
        } catch (err) {
          // 当前失败批次不标记；此前已经成功并逐批落标的卡片不会被下一轮重复发送。
          // 留痕给人工，但绝不伪造已送达。
          fs.writeFileSync(path.join(RUNS, key + ".publish-failed.json"),
            JSON.stringify({ at: new Date().toISOString(), error: String(err.message).slice(0, 500) }, null, 2));
          console.error("publish failed (outbox 保留待重试): " + err.message);
        }
      }
    } finally {
      if (publishLock.ok) releasePublishLock(PUBLISH_LOCK);
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
