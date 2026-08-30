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
import { releaseSessionLockIfOwnedBy } from "./handoff.mjs";
import path from "node:path";

import {
  buildDraft, claimRunPublish, markPublished, publishDraft, publishHold, readPublishLedger, readRunReceipt,
  readRunSnapshot, releaseRunPublishClaim, runRouteSha256,
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
import { gateBlocks } from "./maintenance-gate-core.mjs";

// 维护门（issue #81）：**启动期先看一次门**，在读 claim / 记 failed / 取任何锁之前；门在或读不出就无输出退出（run、claim、锁都留着，交陈旧检测）。循环里每轮再复核。
if (gateBlocks().blocked) process.exit(0);

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

// 只放属于这一轮的锁：只回复的 run 不取锁，它的守望者不能把 owner 的锁删掉。
const finishUp = () => releaseSessionLockIfOwnedBy(LOCK, { logPath });
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
  // 维护门（issue #81）：门在或读不出 → 这一轮就退，锁交还、留诊断；run 与 outbox 都留着
  { const gate = gateBlocks(); if (gate.blocked) refuse({ reason: "maintenance_gate", why: gate.text }); }
  // **一次读取的快照**：outcome、正文、摘要全部来自同一份字节 —— 判终局用它、
  // 写终局记录用它的摘要、发布用它的正文。分三次读盘曾被评审在读与读之间换正文击穿。
  const snap = readRunSnapshot({ runsDir: RUNS, key });
  // 缺席（runner 还没写）可以继续等；**读不出来**不是等待能解决的 —— 立即受控落诊断，
  // 别拖到四小时超时再误报 watch_timeout（评审 P2）。锁保留：runner 可能仍活着。
  if (!snap.ok && snap.reason !== "missing") refuse({ reason: "run_unreadable", why: snap.why ?? snap.reason });
  const outcome = snap.ok ? { state: snap.run.state, reason: snap.run.reason } : { state: "missing" };

  if (outcome.state !== "running" && outcome.state !== "missing") {
    // **终局之后、任何终态落盘和发布之前，重新读取并核对当前绑定与配置。**
    // 启动期那份 cfg/mapping 最长会被复用四小时 —— 评审探针：运行中把
    // auto_publish_on_completion 改成 false，watcher 仍照发。暂停绑定、撤销同理。
    const fresh = resolveAndCheck("终局期");
    if (!fresh.ok) refuse(fresh, { terminal: true });
    const cfg = fresh.cfg;
    const mapping = fresh.mapping;
    const resolved = fresh.resolved;
    const run = snap.run;
    // **两个本地动作各自留痕、互不阻断**：run 终局落盘、Dialogue 收口。
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
    // **暂停时不转交、不另立账本。**run 结果留在 runs 目录保持"待发布"（回执 absent），
    // 由定时排空充当 run 通道的恢复消费者：恢复绑定后经同一把 claimRunPublish、
    // 用 claim 里冻结的原始代际发一次、落同一份回执。曾经尝试过"转成 outbox 记录 +
    // 两阶段转交回执" —— 那是在 run 通道已有的账本（claim 互斥 / 回执三态 / reap 锁）
    // 旁边又立一本，四轮评审各击穿一处（作用域、dryRun 改盘、枚举入口、失败折叠）。
    step("run 终局落盘", () => {
      // 终局记录现在也是排空恢复消费者的授权凭据：绑定它授权的确切制品（JSONL 字节摘要）
      // 与实际 outcome —— 排空侧重算比对，记录写完后换掉正文就发不出去。
      // 制品摘要来自同一份快照；路由摘要绑定这一轮**最终投给谁**（绑定、会话、来源代际、
      // 解析后的目标）—— 记录写完后改 claim 的来源代际就发不出去（评审探针 om_new）。
      const routeTarget = resolveMappingOutboundGeneration(mapping, originGenerationId);
      recordClaimState({
        claimsDir: CLAIMS, key, state: outcome.state === "completed" ? "handed_off" : "failed",
        detail: { run_state: outcome.state, observed_by: "watch-and-publish", artifact_sha256: snap.sha256,
          route_sha256: runRouteSha256({ bindingId: EXPECT_BINDING_ID, claudeSessionId: EXPECT_SESSION_ID,
            originGenerationId, rootMessageId: routeTarget.ok ? routeTarget.rootMessageId : null }),
          ...(fresh.publishable ? {} : { publish_deferred: { reason: "mapping_not_active", why: fresh.pausedWhy,
            consumer: "drain-outbox run 通道（恢复绑定后经 claimRunPublish 发一次）" } }) },
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
      console.error("绑定暂停中（" + fresh.pausedWhy + "）—— 本地终局已记录；两条发布通道都不走，" +
        "run 结果保留在 runs 目录等恢复后由定时排空经 run 通道发布。run 已结束，session lock 已释放。");
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
      // 账本投影：送达状态不确定（reserved）/ 账本说不清 / 自动预算耗尽 → watcher 也不发；
      // 自己上一次发布失败（legacy）不算 —— 维护后重跑 watcher 正是那条失败的恢复路径。
      // 唯一的例外是**精确的**接管锁残留旧账（维护清锁后重跑 watcher 的恢复路径）；
      // 自己上一次发布抛错的账也不豁免 —— 失败原因未受验，留给人看。
      const recoverable = (hold) => hold?.reason === "watcher_publish_failed" && hold.kind === "reap_lock_held";
      const held = run?.hold && !recoverable(run.hold) ? run.hold : null;
      if (held) {
        console.error("run 结果本轮不发（" + held.reason + "：" + held.why + "）—— 去话题核对后手工处理 " +
          key.slice(0, 8) + " 的发布账本。");
      }
      if (run?.eligible && !held && autoOk) {
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
          // **claim 内重读账本**：启动快照到拿到 claim 之间账本可能已变成 reserved（评审探针）。
          // 自己上一次发布失败的旧账仍是例外（维护后重跑正是恢复路径），其余 hold 一律停手。
          const freshHold = claim.ok && receipt.state === "absent" ? publishHold(readPublishLedger({ runsDir: RUNS, key })) : null;
          const ledgerBlocks = freshHold !== null && !recoverable(freshHold);
          if (claim.ok && receipt.state === "valid") {
            releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
            console.error("run 结果已由另一个 watcher 送达（回执合法），本轮不再发。");
          } else if (claim.ok && receipt.state === "unreadable") {
            // **回执说不清 ≠ 没送达。**这时发可能双发、跳过可能漏发 ——
            // fail-closed：不发、报警、留给人核对。
            releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
            console.error("run 回执损坏（" + receipt.why + "）—— **说不清送没送达，" +
              "本轮不发**。去话题核对后手工处理 " + key.slice(0, 8) + " 的回执文件。");
          } else if (claim.ok && ledgerBlocks) {
            releaseRunPublishClaim({ runsDir: RUNS, key, token: claim.token });
            console.error("run 结果本轮不发（claim 后重读账本：" + freshHold.reason + "：" + freshHold.why +
              "）—— 去话题核对后手工处理 " + key.slice(0, 8) + " 的发布账本。");
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
