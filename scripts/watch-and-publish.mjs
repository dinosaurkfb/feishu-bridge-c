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
import {
  buildDraft, claimRunPublish, deferRunToOutbox, deferralEventKeyFor, markPublished,
  publishDraft, readRunReceipt, releaseRunPublishClaim, scanRuns,
} from "./outbound.mjs";
import { composeOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import { claudeRotationBatchHook } from "./drain-outbox.mjs";
import { publishOutboxAttempt } from "./publish-attempt.mjs";
import { boundedBudgetMs } from "./eligibility-recovery.mjs";
import { postDeliveryBits } from "./publish-outcome.mjs";
import { repairCmd } from "./repair-run-claim.mjs";
import { shellQuote } from "./shell-quote.mjs";
import {
  CLAIM_KEY_SHAPE, readClaimState, readWatcherExpectEnv, recordClaimState,
} from "./claim.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { effectiveBindingId, resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { moduleRoot } from "./direct-run.mjs";
import { finalizeClaudeDialogueTurn } from "./interaction-policy-store.mjs";
import { DIALOGUE_POLICY_ID, DIALOGUE_TURN_STATUS } from "./interaction-policy.mjs";

const SELF = moduleRoot(import.meta.url, "..");

const key = process.argv[2];
if (!key) {
  console.error("usage: watch-and-publish.mjs <claim-key> [project-root]");
  process.exit(2);
}
// **key 形状先验，任何路径派生 / I/O 之前。**评审实测 key="../../escape"：
// failed 记录被写到 .runtime-data/escape.failed.json，跑出了 delivery-claims/。
if (!CLAIM_KEY_SHAPE.test(key)) {
  console.error("claim key 不是 claim key 的形状，拒绝");
  process.exit(2);
}
// **期望身份由 inbound 在起守望者时独立传入** —— claim 里的 binding / session 字段
// 彼此自证不算：两个字段一起被改，"交叉核对"就成了自证。缺了就不跑。
const expected = readWatcherExpectEnv(process.env);
if (!expected.ok) {
  console.error("缺少 inbound 传入的期望身份（FEISHU_BRIDGE_EXPECT_BINDING_ID / _CLAUDE_SESSION_ID），拒绝");
  process.exit(2);
}
const EXPECT_BINDING_ID = expected.bindingId;
const EXPECT_SESSION_ID = expected.claudeSessionId;

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
// **claim 三态：说不清就不猜。**这里的 claim 不只决定来源代际，还决定 outbox 归属
// （会话级绑定靠 claude_session_id）—— 缺席/损坏时上一版落到项目级 outbox、
// 现算当前代际，把一轮结果发到了说不清的地方。结果不发布、落 failed 记录、
// session lock 保留（runner 可能还活着，交给陈旧检测）。
const claimState = readClaimState({ claimsDir: CLAIMS, key,
  expect: { bindingId: EXPECT_BINDING_ID, claudeSessionId: EXPECT_SESSION_ID } });
if (claimState.status !== "valid") {
  const why = claimState.status === "absent" ? "claim 缺席" : "claim 读不出来：" + claimState.why;
  try {
    recordClaimState({ claimsDir: CLAIMS, key, state: "failed",
      detail: { reason: "claim_unreadable", why, observed_by: "watch-and-publish" } });
  } catch { /* 记不上不改变结论 */ }
  console.error("这一轮的 claim 说不清（" + why + "）—— 结果不发布：来源代际与 outbox 归属无从判定。session lock 保留。");
  process.exit(2);
}
const acceptedClaim = claimState.claim;
const originGenerationId = acceptedClaim.origin_channel_generation_id ?? null;
// outbox 归属用 inbound 给的期望会话（已与 claim 核对相等），不从 claim 拼路径。
const claudeSessionId = EXPECT_SESSION_ID;
const OUTBOX = path.join(ROOT, ".runtime-data", "outbound",
  claudeSessionId ? "outbox-" + claudeSessionId : "outbox");

// **项目解析与身份核对在启动期、任何终态落盘之前。**评审实测：错的 logical task
// 最终 exit 2，磁盘上却同时留下了 handed_off 与 failed —— 核对发生在副作用之后。
// 跟出站其余部分共用同一个解析：项目目录里有配置就用它，
// 没有就回落到「机器模板 + 登记表那一行」。登记表接入的项目这里没有文件可读。
/**
 * 解析当前项目并核对**实际投递目的地**与期望身份：绑定、会话、逻辑 task。
 * 期望身份只绑 claim 不够 —— 评审探针：claim 与 env 都是 old-binding、当前 mapping
 * 已是 current-binding，watcher 照发到 om_current。"独立期望身份"必须约束最后投给谁。
 * 启动期跑一次（任何终态落盘之前），终局观察到之后**再跑一次**（新鲜快照）。
 */
function resolveAndCheck(stage) {
  const resolved = resolveProject({ root: ROOT, claudeSessionId });
  if (!resolved.ok || !resolved.config) {
    return { ok: false, reason: "config_unresolved",
      why: String(resolved.reason ?? resolved.configError?.reason ?? "说不清") };
  }
  const cfg = resolved.config;
  const mapping = resolved.mapping;
  const problems = [];
  if (acceptedClaim.logical_task_key !== cfg.logical_task_key) problems.push("logical_task_key 跟这个项目对不上");
  if (effectiveBindingId(mapping) !== EXPECT_BINDING_ID) {
    problems.push("当前绑定（" + String(effectiveBindingId(mapping)) + "）跟期望（" + EXPECT_BINDING_ID + "）对不上");
  }
  const nowSession = resolved.claudeSessionId ?? mapping?.claude_session_id ?? null;
  if (nowSession !== EXPECT_SESSION_ID) problems.push("当前会话跟期望对不上");
  if (problems.length > 0) return { ok: false, reason: "binding_drift", why: stage + "：" + problems.join("；") };
  // **"身份仍匹配"和"当前允许发布"是两件事。**暂停绑定是受控的"不发布"，跟排空
  // 路径同一条规矩（mapping_not_active）—— 但它按契约只管入站和发布，不抹掉已经
  // 发生的本地终局事实：run 结果照记、Dialogue 回合照收口，只是两条发布通道都不走。
  // 评审探针：启动时 active、运行中改成暂停、再写终局 —— 只看自动发布开关的话照发；
  // 而把暂停当成拒绝直接 refuse，又会让已完成的 Dialogue 回合卡在 dispatched。
  const publishable = mapping?.status === "active";
  return { ok: true, resolved, cfg, mapping, publishable,
    pausedWhy: publishable ? null : stage + "：绑定状态 " + String(mapping?.status) };
}
/**
 * 拒绝并退出。**锁按阶段处理**：启动期 runner 可能仍存活，锁保留交陈旧检测；
 * 终局期 run 已确认结束，再留锁只会制造一把等下次请求清理的陈旧锁 —— 放掉。
 */
const refuse = (check, { terminal = false } = {}) => {
  try {
    recordClaimState({ claimsDir: CLAIMS, key, state: "failed",
      detail: { reason: check.reason, why: check.why, observed_by: "watch-and-publish",
        ...(terminal ? { run_finished: true, pending_publish: check.reason === "mapping_not_active" } : {}) } });
  } catch { /* 记不上不改变结论 */ }
  if (terminal) finishUp();
  console.error("这一轮不发布（" + check.reason + "：" + check.why + "）。" +
    (terminal ? "run 已结束，session lock 已释放。" : "session lock 保留。"));
  process.exit(2);
};
const startup = resolveAndCheck("启动期");
if (!startup.ok) refuse(startup);

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
    // **io_error 不是竞争。**评审实测：锁目录不可写时被伪装成 busy，
    // 预算走完照样进"让给持锁方"的措辞 —— 基础设施故障被说成了礼让。
    // 只有真正的 publisher_busy 才配等预算；别的原因立刻如实返回。
    if (r.reason !== "publisher_busy") return r;
    if (Date.now() >= deadline) return { ok: false, reason: "publisher_busy" };
    await sleep(Math.min(1500, Math.max(50, deadline - Date.now())));
  }
}

while (true) {
  const outcome = readRunOutcome(logPath);

  if (outcome.state !== "running" && outcome.state !== "missing") {
    // **终局之后、任何终态落盘和发布之前，重新读取并核对当前绑定与配置。**
    // 启动期那份 cfg/mapping 最长会被复用四小时 —— 评审探针：运行中把
    // auto_publish_on_completion 改成 false，watcher 仍照发。暂停绑定、撤销同理。
    const fresh = resolveAndCheck("终局期");
    if (!fresh.ok) refuse(fresh, { terminal: true });
    const cfg = fresh.cfg;
    const mapping = fresh.mapping;
    const resolved = fresh.resolved;
    const run = scanRuns({ runsDir: RUNS }).find((r) => r.key === key);
    // **暂停时的持久恢复闭环**：run 结果安全转成一条 outbox 记录 —— 冻结到 claim 的
    // 原始代际、按 event key 去重、run_id 带上；恢复绑定后由既有排空路径恰好发一次
    // （outbox 事务对 mapping_not_active 本来就是 skip）。只留 .jsonl 只证明字节没删：
    // 后续 watcher 只处理自己的 key、定时排空只扫 outbox、桥接 run 的 Stop 又不入队 ——
    // 没有这一步，恢复后它永远不会自动发出去（评审探针）。
    // **三个本地动作各自留痕、互不阻断**：转入 outbox、run 终局落盘、Dialogue 收口。
    // 任何一个失败都不能拦住其余两个；锁在最后放；有失败就非零退出并点名哪一段没完成
    // （评审探针：outbox 不可写时直接抛 —— run 状态没记、Dialogue 悬挂、锁也没放）。
    const terminalFailures = [];
    const step = (label, fn) => {
      try {
        const r = fn();
        if (r && r.ok === false) { terminalFailures.push(label + "（" + (r.reason ?? "说不清") + "）"); return r; }
        return r ?? { ok: true };
      } catch (err) {
        terminalFailures.push(label + "（" + String(err?.message ?? err).slice(0, 200) + "）");
        return { ok: false, reason: "threw" };
      }
    };
    let deferred = null;
    if (!fresh.publishable && run?.shouldPublish) {
      step("run 结果转入 outbox", () => {
        // 唯一实现在 outbound.mjs（与定时排空的恢复消费者共用）：claim → preparing →
        // 写/核对 outbox → committed。失败时 phase 说明现场停在哪一步。
        const r = deferRunToOutbox({ runsDir: RUNS, outboxDir: OUTBOX, run,
          taskName: cfg.task_display_name, originGenerationId });
        deferred = { reason: "mapping_not_active", why: fresh.pausedWhy,
          outbox_event_key: deferralEventKeyFor(key), queued: r.ok === true,
          ...(r.ok ? {} : { append: r.reason, phase: r.phase ?? null }) };
        return r;
      });
    }
    step("run 终局落盘", () => {
      recordClaimState({
        claimsDir: CLAIMS, key, state: outcome.state === "completed" ? "handed_off" : "failed",
        detail: { run_state: outcome.state, observed_by: "watch-and-publish",
          ...(fresh.publishable ? {} : { publish_deferred: deferred ??
            { reason: "mapping_not_active", why: fresh.pausedWhy, queued: false } }) },
      });
      return { ok: true };
    });
    if (acceptedClaim?.policy_id === DIALOGUE_POLICY_ID) {
      step("Dialogue 收口", () => finalizeClaudeDialogueTurn({
        root: ROOT,
        claudeSessionId,
        runId: key,
        status: outcome.state === "completed"
          ? DIALOGUE_TURN_STATUS.COMPLETED
          : DIALOGUE_TURN_STATUS.FAILED,
        reason: outcome.state === "completed" ? null : (outcome.reason ?? outcome.state),
      }));
    }
    const reportTerminalFailures = () => {
      if (terminalFailures.length === 0) return 0;
      console.error("**以下环节没完成**：" + terminalFailures.join("；") + " —— 其余环节已各自完成。");
      return 1;
    };

    if (!fresh.publishable) {
      console.error("绑定暂停中（" + fresh.pausedWhy + "）—— 本地终局已记录" +
        (deferred?.queued ? "，run 结果已转入 outbox（" + deferred.outbox_event_key + "）等恢复后发布" : "") +
        "；两条发布通道都不走。run 已结束，session lock 已释放。");
      const code = reportTerminalFailures();
      finishUp();
      process.exit(code);
    }

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
      if (run?.receiptUnreadable) {
        // 上游（scanRuns）已按三态把 shouldPublish 关掉 —— 但**必须报警**，
        // 静默跳过就是"损坏回执被当成已送达"的旧病换个位置复发。
        console.error("run 回执损坏（" + run.receiptUnreadable + "）—— **说不清送没送达，" +
          "本轮不发**。去话题核对后手工处理 " + key.slice(0, 8) + " 的回执文件。");
      }
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
          if (!publishLock.ok && publishLock.reason === "publisher_busy") {
            console.error("发布锁等了 " + publishWaitMs + "ms 没等到 —— " +
              "run 结果按既有契约单发（**发布前 claim 互斥并发双发**；" +
              "崩溃窗口仍是 at-least-once，与全线口径一致）；" +
              "outbox 那一半本轮让给持锁方。");
          } else if (!publishLock.ok) {
            // **基础设施故障不是礼让。**说成"让给持锁方"会把人支去等一个不存在的对手。
            console.error("发布锁基础设施故障（" + publishLock.reason +
              (publishLock.error ? "：" + publishLock.error : "") +
              "）—— 这不是竞争。run 结果仍尝试经 claim 单发（claim 在 runs 目录，" +
              "与锁不同盘符时还有机会成功）。");
          }
          // **发布前原子 claim** —— 回执在发送之后，光靠它挡不住两个并发 watcher
          // 同时读到 shouldPublish 各发一张（评审实测真实双发）。
          const claim = claimRunPublish({ runsDir: RUNS, key });
          // **claim 后复核回执** —— shouldPublish 是并发对手完成之前读的，
          // 对手发完释放 claim 后这里能拿到新 claim；回执才是持久的真相。
          const receipt = claim.ok ? readRunReceipt({ runsDir: RUNS, key }) : null;
          if (claim.ok && receipt.state === "valid") {
            releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
            console.error("run 结果已由另一个 watcher 送达（回执合法），本轮不再发。");
          } else if (claim.ok && receipt.state === "deferred") {
            // 所有权已转交 outbox —— 这里再发就是双发。
            releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
            console.error(receipt.phase === "committed"
              ? "run 结果已转交 outbox（" + receipt.eventKey + "），本轮不再走 run 通道。"
              : "run 结果转交中（未提交，" + receipt.eventKey + "）—— 所有权在转交侧，本轮不走 run 通道；由定时排空补齐。");
          } else if (claim.ok && receipt.state === "unreadable") {
            // **回执说不清 ≠ 没送达。**这时发可能双发、跳过可能漏发 ——
            // fail-closed：不发、报警、留给人核对。
            releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
            console.error("run 回执损坏（" + receipt.why + "）—— **说不清送没送达，" +
              "本轮不发**。去话题核对后手工处理 " + key.slice(0, 8) + " 的回执文件。");
          } else if (!claim.ok && claim.reason === "reap_lock_held") {
            // **恢复信息不许在包装层被吞掉**（评审实测：detail 里有锁路径和
            // 处置提示，这里原来只打一句泛化话 —— run 永久停发却无路可走）。
            fs.writeFileSync(path.join(RUNS, key + ".publish-failed.json"),
              JSON.stringify({ at: new Date().toISOString(), reason: "reap_lock_held",
                detail: claim.detail ?? null }, null, 2));
            // 提示的命令**默认预览**（不带 --apply —— 说"默认预览"却给带
            // --apply 的命令，等于教人跳过预览）；路径过 shellQuote；
            // 带 --key 只清这一条 run 的残留，别一杆子扫全项目。
            console.error("run 结果本轮不发：接管互斥锁残留。\n  " +
              (claim.detail ?? "") + "\n  显式维护（先预览，确认后自行加 --apply）：\n  node " +
              shellQuote(repairCmd()) + " --project " + shellQuote(ROOT) + " --key " + key);
          } else if (!claim.ok) {
            console.error("run 结果本轮不发：" + (claim.reason === "claimed_by_other"
              ? "另一个 watcher 正在发同一条 run（claim 互斥）"
              : "claim 基础设施故障（" + claim.reason + "）—— fail-closed，不无保护地发"));
          } else {
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
              releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
              try { rotationHook({ batch: [runRecord], target, messageId: mid }); }
              catch (hookErr) {
                console.error("run 结果已送达（" + mid + "），但轮转记账失败：" +
                  String(hookErr?.message ?? hookErr).slice(0, 200));
              }
              console.log("published run " + key.slice(0, 8) + " -> " + mid);
            } catch (err) {
              // 失败要撤 claim（别把重试路径也锁死）；留痕、不伪造送达。
              releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
              fs.writeFileSync(path.join(RUNS, key + ".publish-failed.json"),
                JSON.stringify({ at: new Date().toISOString(),
                  error: String(err.message).slice(0, 500) }, null, 2));
              console.error("run 结果发布失败: " + String(err.message).slice(0, 300));
            }
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
      } else if (r2.status === "skipped" && r2.reason === "publisher_busy") {
        console.error("outbox 这一半没发（publisher_busy）—— 让给持锁方，进展留在 outbox。");
      } else if (r2.status === "skipped") {
        console.error("outbox 这一半没发：发布锁基础设施故障（" + r2.reason +
          "）—— **这不是竞争，重试前先修锁目录**。进展留在 outbox。");
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
    const code = reportTerminalFailures();
    finishUp();
    process.exit(code);
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
