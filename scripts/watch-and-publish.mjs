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
import { composeOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import { claudeRotationBatchHook } from "./drain-outbox.mjs";
import { publishOutboxAttempt } from "./publish-attempt.mjs";
import { boundedBudgetMs } from "./eligibility-recovery.mjs";
import { postDeliveryBits } from "./stop-note.mjs";
import { readClaim, recordClaimState } from "./claim.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { moduleRoot } from "./direct-run.mjs";
import { finalizeClaudeDialogueTurn } from "./interaction-policy-store.mjs";
import { DIALOGUE_POLICY_ID, DIALOGUE_TURN_STATUS } from "./interaction-policy.mjs";

const SELF = moduleRoot(import.meta.url, "..");

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

/**
 * **发布等待预算**：兜底定时器可能正好在排空同一个 outbox，等它而不是抢。
 * 预算语义与资格恢复共用同一份解析（有限、非负、封顶、不合规回落默认）。
 * 默认 15s —— 盖得住竞争方持锁做真实网络发布的典型 12s。
 */
const PUBLISH_WAIT_DEFAULT_MS = 15_000;
const publishWaitMs = boundedBudgetMs(
  process.env.FEISHU_BRIDGE_PUBLISH_WAIT_MS, { def: PUBLISH_WAIT_DEFAULT_MS, max: 120_000 });

async function waitForPublishLock() {
  const deadline = Date.now() + publishWaitMs;
  for (;;) {
    const r = acquirePublishLock(PUBLISH_LOCK);
    if (r.ok) return r;
    if (Date.now() >= deadline) return { ok: false, reason: "publisher_busy" };
    await sleep(Math.min(1500, Math.max(50, deadline - Date.now())));
  }
}

while (true) {
  const outcome = readRunOutcome(logPath);

  if (outcome.state !== "running" && outcome.state !== "missing") {
    recordClaimState({
      claimsDir: CLAIMS, key, state: outcome.state === "completed" ? "handed_off" : "failed",
      detail: { run_state: outcome.state, observed_by: "watch-and-publish" },
    });
    if (acceptedClaim?.policy_id === DIALOGUE_POLICY_ID) {
      finalizeClaudeDialogueTurn({
        root: ROOT,
        claudeSessionId,
        runId: key,
        status: outcome.state === "completed"
          ? DIALOGUE_TURN_STATUS.COMPLETED
          : DIALOGUE_TURN_STATUS.FAILED,
        reason: outcome.state === "completed" ? null : (outcome.reason ?? outcome.state),
      });
    }

    // 跟出站其余部分共用同一个解析：项目目录里有配置就用它，
    // 没有就回落到「机器模板 + 登记表那一行」。登记表接入的项目这里没有文件可读。
    const resolved = resolveProject({ root: ROOT, claudeSessionId });
    if (!resolved.ok || !resolved.config) {
      throw new Error("读不到这个项目的链路配置（" + (resolved.reason ?? resolved.configError?.reason) + "）");
    }
    const cfg = resolved.config;
    const mapping = resolved.mapping;
    const run = scanRuns({ runsDir: RUNS }).find((r) => r.key === key);

    // ============ 两条发布通道（R2b1 定稿的显式语义） ============
    //
    // **run 结果是事务外的第二条通道**（第 6 层评审给的例外）：
    // 它不是 outbox 记录，有独立来源（runs 目录）和独立回执（markPublished），
    // outbox 损坏或锁被占都不该扣着执行结果不发。
    //
    // 锁语义（计划文档 R2b1 验收点，在此定稿）：
    //   · 两条通道**尽力共锁**：预算内（默认 15s，FEISHU_BRIDGE_PUBLISH_WAIT_MS
    //     可调）等同一把发布锁，拿到后 run 先发、release 后 outbox 走事务。
    //   · 预算耗尽：**run 无锁单发**（维持既有契约 —— 它有独立回执与独立的
    //     绑定账本锁，双发风险为零；扣着执行结果的代价大得多）；
    //     **outbox 永不无锁**（那半是双发风险所在），本轮让给持锁方。
    const rotationHook = claudeRotationBatchHook({
      root: ROOT,
      claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
    });
    const autoOk = cfg.auto_publish_on_completion !== false;

    // —— 通道一：run 结果 ——
    const publishLock = await waitForPublishLock();
    try {
      if (run?.shouldPublish && autoOk) {
        const draft = buildDraft(run, { taskName: cfg.task_display_name });
        if (draft) {
          const runRecord = {
            kind: run.state === "completed" ? "reply" : "risk",
            text: draft,
            source: "claude-run-watcher",
            target_channel_generation_id: originGenerationId,
            run_id: key,
          };
          if (!publishLock.ok) {
            console.error("发布锁等了 " + publishWaitMs + "ms 没等到 —— " +
              "run 结果按既有契约**无锁单发**（独立回执，零双发风险）；" +
              "outbox 那一半本轮让给持锁方。");
          }
          try {
            const ident = resolveLarkIdentity(cfg);
            const target = resolveMappingOutboundGeneration(mapping, originGenerationId);
            if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
            const mid = publishDraft({
              profile: ident.profile,
              rootMessageId: target.rootMessageId,
              card: composeOutboundCard([runRecord], { taskName: cfg.task_display_name, runtime: "claude" }),
              larkBin: ident.bin,
              larkHome: ident.configDir,
              expectedAppId: ident.expectedAppId,
            });
            // 回执先落（防重发压倒一切），轮转记账失败只记缺口不回滚。
            markPublished({ runsDir: RUNS, key, messageId: mid });
            try { rotationHook({ batch: [runRecord], target, messageId: mid }); }
            catch (hookErr) {
              console.error("run 结果已送达（" + mid + "），但轮转记账失败：" +
                String(hookErr?.message ?? hookErr).slice(0, 200));
            }
            console.log("published run " + key.slice(0, 8) + " -> " + mid);
          } catch (err) {
            // run 通道失败：留痕、不伪造送达。分类与重试保护不适用 —— 它不是 outbox 记录。
            fs.writeFileSync(path.join(RUNS, key + ".publish-failed.json"),
              JSON.stringify({ at: new Date().toISOString(),
                error: String(err.message).slice(0, 500) }, null, 2));
            console.error("run 结果发布失败: " + String(err.message).slice(0, 300));
          }
        }
      }
    } finally {
      if (publishLock.ok) releasePublishLock(PUBLISH_LOCK);
    }

    // —— 通道二：outbox（永不无锁；锁、快照、审计、选择、记账全在事务里） ——
    if (autoOk) {
      const r2 = publishOutboxAttempt({
        outboxDir: OUTBOX,
        lockDir: PUBLISH_LOCK,
        policy: "all_unpaused",
        batchCards: outboundCardBatches,
        resolveTarget: (generationKey) => resolveMappingOutboundGeneration(mapping, generationKey),
        composeCard: (batch) => composeOutboundCard(batch, {
          taskName: cfg.task_display_name, runtime: "claude",
        }),
        publishBatch: ({ target, card }) => {
          const ident = resolveLarkIdentity(cfg);
          return publishDraft({
            profile: ident.profile, rootMessageId: target.rootMessageId, card,
            larkBin: ident.bin, larkHome: ident.configDir, expectedAppId: ident.expectedAppId,
          });
        },
        onBatchPublished: rotationHook,
      });
      if (r2.status === "published") {
        console.log("published outbox " + key.slice(0, 8) + " -> " + r2.messageId +
          " (cards=" + r2.messageIds.length + ")" + postDeliveryBits(r2));
      } else if (r2.status === "skipped") {
        console.error("outbox 这一半没发（" + r2.reason + "）—— 让给持锁方，进展留在 outbox。");
      } else if (r2.status === "error" && r2.local === true) {
        console.error("本地 outbox 有问题（" + (r2.reason ?? "说不清") +
          ((r2.files ?? []).length ? "：" + r2.files.join("、") : "") +
          "）——**这一批 outbox 内容没有发送**（这不是飞书故障，重试没用）。" +
          "本轮执行结果不受影响，已按通道一处理。");
      } else if (r2.status === "error") {
        console.error("outbox 发布失败" +
          ((r2.markedRejected ?? []).length > 0
            ? "（这几条已暂停自动重试：" + r2.markedRejected.join("、") + "）"
            : "（进展保留待重试）") + ": " + (r2.error ?? r2.reason) + postDeliveryBits(r2));
      }
    }
    finishUp();
    process.exit(0);
  }

  if (Date.now() - startedAt > MAX_WAIT_MS) {
    recordClaimState({ claimsDir: CLAIMS, key, state: "failed",
      detail: { reason: "watch_timeout", waited_ms: Date.now() - startedAt } });
    if (acceptedClaim?.policy_id === DIALOGUE_POLICY_ID) {
      finalizeClaudeDialogueTurn({
        root: ROOT,
        claudeSessionId,
        runId: key,
        status: DIALOGUE_TURN_STATUS.FAILED,
        reason: "watch_timeout",
      });
    }
    finishUp();
    console.error("watch timeout for " + key);
    process.exit(1);
  }

  await sleep(POLL_MS);
}
