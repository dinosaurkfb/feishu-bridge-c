#!/usr/bin/env node
/**
 * 排空 outbox：把积累的关键进展合成一条摘要发到绑定话题，然后逐条标记已发。
 *
 * 三个调用方共用这一个函数：会话结束钩子（事件驱动，主路径）、
 * launchd 兜底定时器、以及人工。它们只读本地 outbox、只往一个已绑定的话题写，
 * 不监听飞书、不接受指令、不做任何入站动作。
 *
 * 幂等靠两层：发布锁保证同一时刻只有一个排空者，逐条 published_at 保证发过的不再发。
 * 发送成功才标记；发送失败不标记，下一轮重试。宁可重试也不能标记了却没发出去 ——
 * 那会让进展静默丢失。
 */

import fs from "node:fs";
import path from "node:path";

import {
  MAX_AUTO_PUBLISH_ATTEMPTS, auditOutbox, composeDigest, listPending, outboxMutationBlocker,
} from "./outbox.mjs";
import { composeOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import {
  PUBLISH_FAILURE, buildDraft, claimRunPublish, classifyPublishFailure, inventoryRuns, markPublished,
  publishDraft, publishHold, readPublishLedger, readRunReceipt, readRunSnapshot, releaseRunPublishClaim,
  runRouteSha256, writePublishLedger,
} from "./outbound.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { readClaimState } from "./claim.mjs";
import { publishOutboxAttempt } from "./publish-attempt.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { isLockStale } from "./handoff.mjs";
import { effectiveBindingId, resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";
import {
  businessActivitiesForPublishedBatch, recordClaudeActivityAndMaybeRotate,
} from "./automatic-topic-rotation.mjs";

// groupByTargetGeneration 已移居 publish-attempt.mjs（唯一一份 —— 此前
// watcher 还私藏了一份抄写）。这里 re-export 兼容既有消费者。
export { groupByTargetGeneration } from "./publish-attempt.mjs";


/**
 * outbox 按**绑定**分目录，不是按项目。
 *
 * 同一个项目里两个会话可以各绑一个话题；共用一个 outbox 的话，A 会话写的进展会被
 * B 会话的排空拿去发到 B 的话题里 —— 而且不报错，只是发错了地方。
 *
 * 项目级绑定继续用原来的 `outbox` 路径，一个字节不变。
 */
export const outboxDirOf = (root, claudeSessionId) =>
  path.join(root, ".runtime-data", "outbound",
    claudeSessionId ? "outbox-" + claudeSessionId : "outbox");

// 发布锁仍然按项目：它要挡的是「同一时刻两个排空者」，按项目串行化足够，
// 而且更保险 —— 两条线同时发布对飞书是两次独立调用，没必要并行。
const publishLockOf = (root) => path.join(root, ".runtime-data", "outbound", "publish.lock");
const sessionLockOf = (root) => path.join(root, ".runtime-data", "inbound", "session.lock");

/**
 * 有没有一次性守望者正盯着某次投递。
 *
 * 有就别自己发 —— 守望者会把「执行结果 + 本轮进展」合成一条。抢在它前面发，
 * Frank 一次指令就会收到三条消息（已受理 + 进展 + 结果），正是要避免的噪音。
 */
export function watcherActive(root) {
  const lockDir = sessionLockOf(root);
  if (!fs.existsSync(lockDir)) return false;
  return !isLockStale(lockDir);
}



/**
 * 把统一守卫的结论讲成人话。**Stop 和 CLI 共用这一份措辞。**
 *
 * 它只读 blocker 的结论，**不重新判断** —— 判据只有一份。
 *
 * 「目录读不出来」和「某几条记录解释不了」要分开说：前者根本没有"N 处"可数
 * （守卫对读取失败返回 count: 0），照着模板渲染会打出"0 处说不清"，
 * 那句话既不成立也没法照着排查。
 */
export function localOutboxMessage(r) {
  const head = r.reason === "outbox_unreadable" ? "本地 outbox 读不出来"
    : r.reason === "outbox_not_a_directory" ? "本地 outbox 那个路径不是目录"
      : r.reason === "batching_mismatch" || r.reason === "batching_failed"
        ? "切批阶段被拦下（" + (r.detail ?? r.reason) + "）"
        : "本地 outbox 有 " + (r.count ?? 0) + " 处说不清" +
          ((r.files ?? []).length ? "（" + r.files.join("、") + "）" : "");
  const why = (r.details ?? []).map((d) => "\n    " + d.file + " —— " + d.why).join("");
  return head + "。\n" +
    "  **这不是发布失败，是本地记录的问题** —— 重试没用，需要人看一眼。整批都没有动。" +
    why;
}

/** 抑制命令的绝对路径：提示里给相对路径，等于让人猜当前工作目录。 */
/**
 * 这个脚本自己的路径。
 *
 * **不要从进程参数里取** —— 经符号链接执行时那给的是链接本身，
 * 提示里打出来的命令人照抄会指到别处。有一条守卫直接禁用了那个 API。
 */
/**
 * Claude 侧发布后的轮转记账钩子。**drain 与 watcher 共用这一份。**
 * 只记账不否决；记账函数失败不抛、返回 ok:false —— 这里转成受控抛错，
 * 让发布事务把它归进 bookkeepingFailures（发布已成，照样落标防重发）。
 */
export function claudeRotationBatchHook({ root, claudeSessionId }) {
  return ({ batch, target, messageId }) => {
    for (const activity of businessActivitiesForPublishedBatch(batch, {
      messageId, runtime: "claude",
    })) {
      const recorded = recordClaudeActivityAndMaybeRotate({
        root, claudeSessionId,
        generationId: target.channelGenerationId,
        ...activity,
      });
      if (recorded && recorded.ok === false) {
        throw new Error("轮转活动记账失败（" + (recorded.reason ?? "说不清") + "）");
      }
    }
  };
}

export function drainCmd() {
  return path.join(moduleRoot(import.meta.url, ".."), "scripts", "drain-outbox.mjs");
}

export function suppressCmd() {
  return path.join(moduleRoot(import.meta.url, ".."), "scripts", "feishu-suppress-outbox.mjs");
}

/**
 * `publish` 是**唯一的发布注入口**。默认就是真的发。
 *
 * 加它的原因：这条失败路径此前根本没法做行为测试 —— `publishDraft` 的
 * `larkBin` 来自机器级模板（`resolveLarkIdentity`），**不是**项目 chain-config 里的
 * `lark_cli_bin`，所以给临时项目写一个假的二进制挡不住它。我为了测一条失败分支
 * 跑过一次非 dry-run 的 drainProject，**它直接打到了真实飞书 API**
 * （拿到真实错误码 99992354，所幸根消息是假的，什么都没发出去）。
 *
 * **两个口都要有。**只注入 publish 只挡住了"写"：发布失败之后还要跑身份诊断，
 * 而 classifyPublishFailure 会执行 lark-cli `im +messages-mget` 去查根消息的归属 ——
 * 那同样是一次真实的出网请求。评审用假二进制实测到了这一点：注入的发布函数抛错后，
 * 诊断进程照样被调起来。**"挡住了写"不等于"不出网"。**
 *
 * 注入口只改测试的可达性，不改生产行为：不传就是 publishDraft / classifyPublishFailure 本身。
 */
export function drainProject({
  root, claudeSessionId, dryRun = false, timeoutMs, force = false,
  // **人显式下令才会重试被永久拒绝的那些。**默认不重试 ——
  // 永久拒绝的定义就是"再等不会变好"，自动重试只是稳定地制造噪音。
  retryRejected = false,
  publish = publishDraft, diagnose = classifyPublishFailure,
} = {}) {
  const outboxDir = outboxDirOf(root, claudeSessionId);

  // 先看有没有东西可发。绝大多数会话在这一行就返回了 —— 不读配置、不碰锁。
  // **审计要在任何"空"结论之前。**
  //
  // listPending 把目录错误吞成 []、把坏 JSON 静默跳过 —— 评审实测：
  // outbox 里只有一份坏 JSON 时 drainProject 返回 {status:"empty"}；
  // outbox 路径是普通文件时也返回 empty；真实 Stop 面对这种 outbox **完全无输出**。
  // **"读不出来"被报成"没有东西可发"，是这条线上反复出现的同一个错误。**
  const preflight = outboxMutationBlocker(auditOutbox(outboxDir));
  // **run 通道的恢复消费者住在这里**：watcher 在绑定暂停时不发、run 结果留在 runs 目录
  // 保持"待发布"（回执 absent）；watcher 已退出、后续 watcher 只管自己的 key，所以每轮
  // 排空要看一眼 runs —— 用 run 通道自己的账本（claim 互斥 / 回执三态）发，不另立账本。
  // **run 是事务外第二通道**：outbox 损坏不该截断它，所以 outbox 预检的结论先存着，
  // run 通道照常跑，最后两侧结果合在一起返回。runs 账本自己坏了也要作为 problems 报出来。
  const { runsDir, claimsDir, inventory, runProblems, pendingRuns, runsIdle } = runChannelContext({ root, dryRun });
  void inventory;
  const nothingToDo = pendingRuns.length === 0 && runProblems.length === 0;
  // 所有返回都带 runs 段 —— 消费方不用猜"没有这段"是没跑还是没东西。
  if (preflight && nothingToDo) return { status: "error", root, ...preflight, local: true, runs: runsIdle() };
  if (!preflight && listPending({ outboxDir }).length === 0 && nothingToDo) return { status: "empty", root, runs: runsIdle() };

  // 项目文件优先，没有就回落到「机器模板 + 登记表那一行」。
  // 已接好的项目走前一条，行为不变；新接的项目目录里一个配置文件都没有。
  const resolved = resolveProject({ root, claudeSessionId });
  if (!resolved.ok) {
    // not_bound 是「有 outbox 但没接桥」—— 会被 CLI 和钩子分别报出来，不静默。
    return { status: "error", root, reason: resolved.reason, error: resolved.error ?? null, runs: runsIdle() };
  }
  // 发布真的需要 config（身份、profile、二进制路径），所以到这一步 configError 就是硬错。
  // 到期预警不需要 config，所以那条路径拿到 configError 也照常工作 —— 见 project-resolve.mjs。
  if (!resolved.config) {
    const ce = resolved.configError ?? {};
    const parts = [ce.error];
    if (ce.missing?.length) parts.push("缺字段：" + ce.missing.join(", "));
    if (ce.malformed?.length) parts.push("形状不对：" + ce.malformed.join(", "));
    return {
      status: "error", root,
      reason: ce.reason ?? "config_unreadable",
      error: parts.filter(Boolean).join("；") || null,
      runs: runsIdle(),
    };
  }
  const { config: cfg, mapping } = resolved;

  let failingBatch = null;
  // **在 try 之外解析。**上一版把它放在 try 里，而 catch 要用它 —— 于是任何发布失败
  // 都先撞上 ReferenceError，永远走不到诊断。身份从配置推，不认死任何 agent；
  // 发之前 publishDraft 仍会校验凭据归属。
  const id = resolveLarkIdentity(cfg);
  let failingTarget = null;
  // **发布开关要真的管住自动发布。**
  //
  // 它叫 auto_publish_on_completion，但此前只有 inbound.mjs 和 watch-and-publish.mjs
  // 读它 —— 每轮 Stop 和 30 分钟兜底都不读，而那两条恰好是 Claude 侧的主路径。
  // 于是把它设成 false 几乎什么都不改变，进展照发：**一个不生效的开关**。
  //
  // 现在默认遵守。显式人工排空要绕过就用 --force —— 绕过必须是明说的，
  // 不能靠"哪个入口调的"来隐式决定。
  if (!force && cfg.auto_publish_on_completion === false) {
    return {
      status: "skipped", root, reason: "auto_publish_disabled",
      count: listPending({ outboxDir }).length, runs: runsIdle(),
    };
  }

  // 绑定失效时不发：话题可能已经不再是 Frank 认可的那个。run 结果也一并留着。
  if (mapping.status !== "active") {
    return { status: "skipped", root, reason: "mapping_not_active", count: listPending({ outboxDir }).length,
      runs: runsIdle() };
  }

  // —— run 通道：暂停期间留下的 run 结果，经 run 通道自己的账本发 ——
  const runs = drainRunResults({ root, runsDir, claimsDir, pendingRuns, problems: runProblems, mapping, cfg, id,
    dryRun, publish, timeoutMs,
    claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId });
  // outbox 预检不过：run 通道已经跑完，现在才把 outbox 的结论报出来（两侧都在）。
  if (preflight) return { status: "error", root, ...preflight, local: true, runs };
  // 只有 run 通道：给它自己的中性状态，别伪造 "published, count:0"（评审实测：
  // dry-run 打出「已发布 0 条 -> null」）。
  if (listPending({ outboxDir }).length === 0) return { status: "runs_only", root, runs };

  // **锁内的一切交给唯一发布事务。**这里只提供 Claude 侧的四样：
  // 怎么解析目标代际、怎么构卡、用哪个身份发、发完一批记什么账。
  // 锁、快照、审计、候选选择、失败记账、落标全在事务里 ——
  // 四份手写实现各漏一角的日子到此为止。
  const r = publishOutboxAttempt({
    outboxDir,
    lockDir: publishLockOf(root),
    policy: retryRejected ? "explicit_retry_paused" : "all_unpaused",
    dryRun,
    batchCards: outboundCardBatches,
    resolveTarget: (generationKey) => resolveMappingOutboundGeneration(mapping, generationKey),
    composeCard: (batch) => composeOutboundCard(batch, {
      taskName: cfg.task_display_name, runtime: "claude",
    }),
    publishBatch: ({ target, card }) => publish({
      profile: id.profile,
      rootMessageId: target.rootMessageId,
      card,
      larkBin: id.bin,
      larkHome: id.configDir,
      expectedAppId: id.expectedAppId,
      timeoutMs,
    }),
    // 记账钩子：**只记账，不否决**。实现与 watcher 共用同一份 —— 各抄一份的话
    // "检查 ok:false"这类修法就会又一次只修一处。
    onBatchPublished: claudeRotationBatchHook({
      root, claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
    }),
  });

  // 入口只做入口的事：补上 root、Claude 特有的措辞素材与跨应用诊断。
  // **run 通道的结果随所有分支一起输出** —— 只挂在某一支上，失败就会被折叠成"空"。
  if (r.status === "dry_run") {
    return {
      status: "dry_run", root, count: r.count,
      cards: r.batches.map((item) => item.card),
      text: composeDigest(r.selected, { taskName: cfg.task_display_name }),
      runs,
    };
  }
  if (r.status === "error" && r.reason === "publish_failed") {
    // 诊断只是**线索**，不是判决 —— 调用方拿它给人看，不拿它做有损动作。
    const diagnosis = diagnose({
      rootMessageId: r.failingTarget?.rootMessageId ?? null,
      expectedAppId: id?.expectedAppId,
      larkBin: id?.bin, larkHome: id?.configDir, profile: id?.profile,
    });
    const { failingTarget, ...rest } = r;
    return {
      ...rest, root, runs,
      diagnosis: diagnosis.kind === PUBLISH_FAILURE.ROOT_OWNED_BY_OTHER_APP
        ? { kind: diagnosis.kind, ownerName: diagnosis.ownerName ?? null,
            generationId: failingTarget?.generationId ?? failingTarget?.channelGenerationId ?? null,
            count: listPending({ outboxDir }).length }
        : null,
    };
  }
  return { ...r, root, runs };
}


/**
 * watcher 写下的终局记录（handed_off / failed）—— 自动恢复只认它里面**明确记载**的
 * "延期发布"。没有这条记录的历史 run、身份漂移之类的 failed 记录，一律不自动捞起，
 * 交人分类（评审实测：合法 claim + 终局制品但无 watcher 标记的历史 run，一次排空就
 * 真实发布了；安装后现有定时器会把历史 run 全部捞起）。
 */
function readTerminalRecord({ claimsDir, key }) {
  const found = [];
  for (const state of ["handed_off", "failed"]) {
    const file = path.join(claimsDir, key + "." + state + ".json");
    let raw;
    try { raw = fs.readFileSync(file, "utf-8"); }
    catch (err) { if (err.code === "ENOENT") continue; return { ok: false, reason: "terminal_unreadable", why: String(err.code ?? err.message) }; }
    found.push({ state, raw });
  }
  if (found.length === 0) return { ok: false, reason: "publish_not_authorized", why: "没有 watcher 的终局记录（历史 run）—— 待人工分类" };
  // **终态唯一**：handed_off 与 failed 同时存在说不清哪个是真的（评审探针：固定先取前者就发了）。
  if (found.length > 1) return { ok: false, reason: "terminal_ambiguous", why: "handed_off 与 failed 记录同时存在" };
  const { state, raw } = found[0];
  let doc;
  try { doc = JSON.parse(raw); } catch { return { ok: false, reason: "terminal_unreadable", why: "不是 JSON" }; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "terminal_unreadable", why: "不是记录对象" };
  if (doc.schema_version !== "1.0" || doc.claim_key !== key || doc.state !== state || !isCanonicalIso(doc.recorded_at)) {
    return { ok: false, reason: "terminal_unreadable", why: "固定字段对不上" };
  }
  if (doc.observed_by !== "watch-and-publish") return { ok: false, reason: "terminal_unreadable", why: "observed_by 不是受控 watcher" };
  const deferred = doc.publish_deferred;
  if (deferred === undefined) {
    // 没有延期记载的终局（watcher 启动/终局期 refuse 写的 failed、历史 run）：待人工分类。
    return { ok: false, reason: "publish_not_authorized", why: "终局记录里没有「因绑定暂停而延期发布」的记载 —— 待人工分类" };
  }
  // **终态语义封闭**：handed_off 只对应 completed；failed 只对应 failed|blocked。
  const allowed = state === "handed_off" ? ["completed"] : ["failed", "blocked"];
  if (!allowed.includes(doc.run_state)) return { ok: false, reason: "terminal_unreadable", why: state + " 不该对应 run_state " + String(doc.run_state) };
  if (deferred === null || typeof deferred !== "object" || Array.isArray(deferred)
    || Object.keys(deferred).sort().join(",") !== "consumer,reason,why"
    || deferred.reason !== "mapping_not_active" || typeof deferred.why !== "string" || typeof deferred.consumer !== "string") {
    return { ok: false, reason: "terminal_unreadable", why: "publish_deferred 不是受控形状" };
  }
  // 授权凭据要绑定它授权的确切制品与最终投递意图：JSONL 字节摘要 + 路由投影摘要。
  if (!/^[0-9a-f]{64}$/u.test(String(doc.artifact_sha256))) {
    return { ok: false, reason: "terminal_unbound", why: "终局记录没有绑定制品摘要（artifact_sha256）" };
  }
  if (!/^[0-9a-f]{64}$/u.test(String(doc.route_sha256))) {
    return { ok: false, reason: "terminal_unbound", why: "终局记录没有绑定路由摘要（route_sha256）" };
  }
  return { ok: true, state, runState: doc.run_state, artifactSha256: doc.artifact_sha256, routeSha256: doc.route_sha256 };
}

/**
 * run 通道的准备段 —— drainProject 与 inspectRunChannel **共用**：盘点、待处理集合、空闲形状。
 * 两边各写一遍就会分叉出第二份判据。
 */
function runChannelContext({ root, dryRun }) {
  const runsDir = path.join(root, ".runtime-data", "inbound", "runs");
  const claimsDir = path.join(root, ".runtime-data", "inbound", "delivery-claims");
  const inventory = inventoryRuns({ runsDir, claimsDir });
  const runProblems = inventory.ok ? inventory.problems
    : [{ key: null, reason: inventory.reason, why: inventory.error ?? null }];
  const pendingRuns = inventory.ok ? inventory.runs.filter((r) => r.eligible) : [];   // 账本 hold 的也进来，按 stuck 报
  const runsIdle = () => ({ pending: pendingRuns.length, published: [], skipped: [], stuck: [],
    deliveredUnrecorded: [], problems: runProblems, dryRun: dryRun === true });
  return { runsDir, claimsDir, inventory, runProblems, pendingRuns, runsIdle };
}

/**
 * **只读地看 run 通道**（FR-10 状态页用）：判据与 drainProject 是同一段代码 ——
 * 同一份盘点、同一个 drainRunResults 以 dryRun 跑一遍；不 claim、不改盘、不发布。
 *   phase  classified —— 绑定 active，stuck / problems 已按排空的判据分类；waiting 是 dry-run 将发的那批
 *          paused     —— 绑定暂停：排空不会分类 stuck，只报待处理条数与账本问题（不伪造成 0 条卡住）
 *          unresolved —— 项目 / 配置解析不出来（reason）
 *   inventoryOk false 时 runs.problems 里就是 runs_unreadable / runs_not_a_directory 那一条。
 */
/**
 * 未路由回复（Stop 说不清该回哪个话题、零入队时留下的记录）的只读盘点 —— 状态页第五区与 doctor 都从这里读。
 * 目录不存在 = 0 条；读不出来明说，不折叠成 0。
 */
export function inventoryUnroutedReplies({ root } = {}) {
  const dir = path.join(root, ".runtime-data", "outbound", "unrouted-replies");
  let names;
  // **枚举全部目录项**，不先按后缀过滤：写方的临时制品（.json.tmp.<pid>）、不认识的条目都要报出来，
  // 只有目录不存在才等于零（评审探针：三项只报一项，doctor 还说无积压）。
  try { names = fs.readdirSync(dir).sort(); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, count: 0, entries: [], problems: [], dir };
    return { ok: false, reason: "unrouted_unreadable", error: String(err.code ?? err.message), count: 0, entries: [], problems: [], dir };
  }
  const entries = [];
  const problems = [];
  const NAME = /^\d+-[^.]+-[0-9a-f]{8}\.json$/u;
  for (const n of names) {
    if (!NAME.test(n)) { problems.push({ file: n, reason: /\.tmp\./u.test(n) ? "tmp_artifact" : "unrecognized_entry" }); continue; }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")); }
    catch (err) { problems.push({ file: n, reason: err.code === "EISDIR" ? "unrecognized_entry" : "unreadable" }); continue; }
    const shapeOk = doc !== null && typeof doc === "object" && !Array.isArray(doc)
      && doc.schema_version === "1.0" && doc.artifact_type === "feishu_bridge_unrouted_reply"
      && typeof doc.reason === "string" && doc.reason.length > 0
      && typeof doc.session_id === "string" && doc.session_id.length > 0
      && typeof doc.reply_text === "string"
      && isCanonicalIso(doc.recorded_at);
    if (!shapeOk) { problems.push({ file: n, reason: "malformed" }); continue; }
    entries.push({ file: n, reason: doc.reason, why: doc.why ?? null, recordedAt: doc.recorded_at });
  }
  return { ok: true, count: entries.length, entries, problems, dir };
}

export function inspectRunChannel({ root, claudeSessionId } = {}) {
  const rc = inspectRunChannelCore({ root, claudeSessionId });
  return { ...rc, unrouted: inventoryUnroutedReplies({ root }) };
}

function inspectRunChannelCore({ root, claudeSessionId } = {}) {
  const ctx = runChannelContext({ root, dryRun: true });
  const oldestOf = (keys) => {
    const times = ctx.pendingRuns.filter((r) => keys.has(r.key)).map((r) => r.modifiedAt).filter(Number.isFinite);
    return times.length > 0 ? Math.min(...times) : null;
  };
  const resolved = resolveProject({ root, claudeSessionId });
  if (!resolved.ok) {
    return { phase: "unresolved", reason: resolved.reason, inventoryOk: ctx.inventory.ok, runs: ctx.runsIdle(),
      waiting: { count: ctx.pendingRuns.length, oldestMs: oldestOf(new Set(ctx.pendingRuns.map((r) => r.key))) } };
  }
  if (!resolved.config) {
    return { phase: "unresolved", reason: resolved.configError?.reason ?? "config_unreadable", inventoryOk: ctx.inventory.ok,
      runs: ctx.runsIdle(), waiting: { count: ctx.pendingRuns.length, oldestMs: oldestOf(new Set(ctx.pendingRuns.map((r) => r.key))) } };
  }
  const { config: cfg, mapping } = resolved;
  if (mapping.status !== "active") {
    return { phase: "paused", reason: "mapping_not_active", inventoryOk: ctx.inventory.ok, runs: ctx.runsIdle(),
      waiting: { count: ctx.pendingRuns.length, oldestMs: oldestOf(new Set(ctx.pendingRuns.map((r) => r.key))) } };
  }
  const runs = drainRunResults({
    root, runsDir: ctx.runsDir, claimsDir: ctx.claimsDir, pendingRuns: ctx.pendingRuns, problems: ctx.runProblems,
    mapping, cfg, id: resolveLarkIdentity(cfg), dryRun: true,
    publish: () => { throw new Error("inspectRunChannel 是只读的：不许发布"); },
    claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
  });
  const willPublish = new Set(runs.published.map((p) => p.key));
  return { phase: "classified", reason: null, inventoryOk: ctx.inventory.ok, runs,
    waiting: { count: willPublish.size, oldestMs: oldestOf(willPublish) } };
}

/**
 * **run 通道排空**：只消费回执 absent、已终局、且 watcher 终局记录明确记载"因绑定暂停而
 * 延期发布"的 run。每条：终局记录验真 → claim 自身验真（缺席/损坏 = stuck）→ 归属核对
 * （bindingId / claudeSessionId 由本次排空目标给出，不信 claim 自报；属于别的绑定才
 * 静默跳过）→ 目标取 claim 冻结的原始代际 → 重试预算 → claimRunPublish → claim 下重读
 * 回执 → 发 → markPublished（**单独接住**：送达但回执没落 = deliveredUnrecorded，
 * 不记失败、明确提示可能重发）→ 轮转记账 → 释放。dryRun 零副作用，只报告。
 */
function drainRunResults({ root, runsDir, claimsDir, pendingRuns, problems, mapping, cfg, id, dryRun, publish, timeoutMs, claudeSessionId }) {
  const out = { pending: pendingRuns.length, published: [], skipped: [], stuck: [],
    deliveredUnrecorded: [], problems: [...(problems ?? [])], dryRun: dryRun === true };
  const expect = { bindingId: effectiveBindingId(mapping, { root }), claudeSessionId: claudeSessionId ?? null };
  for (const listed of pendingRuns) {
    const key = listed.key;
    // **一次读取的快照**：outcome、正文、摘要、账本来自同一次读取 —— 拿新摘要给旧草稿背书是评审
    // 实测击穿过的形状。授权凭据要跟实际 outcome 与确切制品对上。
    const snap = readRunSnapshot({ runsDir, key });
    if (!snap.ok) { out.stuck.push({ key, reason: "artifact_unreadable", why: snap.why }); continue; }
    const run = snap.run;
    // watcher 发过又失败（旧形状失败账）→ **只可见、不自动重试**：那类失败原因未受验
    // （网络 / 凭据 / 话题归属），自动重试是在制造噪音，留给人判断 —— 不论终局记录写了什么。
    if (run.ledger.state === "legacy") { out.stuck.push({ key, reason: "watcher_publish_failed", why: run.ledger.error }); continue; }
    const terminal = readTerminalRecord({ claimsDir, key });
    if (!terminal.ok) { out.stuck.push({ key, reason: terminal.reason, why: terminal.why }); continue; }
    if (!run.eligible) { out.skipped.push({ key, reason: "receipt_" + snap.receipt.state, why: snap.receipt.why ?? null }); continue; }
    if (terminal.runState !== run.state) {
      out.stuck.push({ key, reason: "outcome_mismatch", why: "终局记录说 " + terminal.runState + "，实际 " + run.state }); continue;
    }
    if (snap.sha256 !== terminal.artifactSha256) {
      out.stuck.push({ key, reason: "artifact_mismatch", why: "run 制品与终局记录绑定的摘要对不上" }); continue;
    }
    // claim 自身先验：缺席 / 损坏是 stuck；合法但属于别的绑定才是正常跳过。
    const own = readClaimState({ claimsDir, key });
    if (own.status !== "valid") { out.stuck.push({ key, reason: "claim_" + own.status, why: own.why ?? null }); continue; }
    const scoped = readClaimState({ claimsDir, key, expect });
    if (scoped.status !== "valid") { out.skipped.push({ key, reason: "other_binding", why: scoped.why ?? null }); continue; }
    const origin = scoped.claim.origin_channel_generation_id;
    const target = resolveMappingOutboundGeneration(mapping, origin);
    if (!target.ok) { out.stuck.push({ key, reason: "origin_generation_unavailable", why: target.reason }); continue; }
    // 凭据绑定的是**最终投给谁**：绑定、会话、来源代际、解析后的目标 —— 记录写完后改 claim
    // 的来源代际，就发去了另一个话题（评审探针 om_new）。
    const route = runRouteSha256({ bindingId: expect.bindingId, claudeSessionId: expect.claudeSessionId,
      originGenerationId: origin, rootMessageId: target.rootMessageId });
    if (route !== terminal.routeSha256) { out.stuck.push({ key, reason: "route_mismatch", why: "最终投递路由与终局记录绑定的对不上" }); continue; }
    const text = buildDraft(run, { taskName: cfg.task_display_name });
    if (!text) { out.skipped.push({ key, reason: "no_draft" }); continue; }
    // 锁外先看账本投影（与直发 CLI 同一份判据 publishHold）；有约束力的那次在 claim 内。
    if (run.hold) { out.stuck.push({ key, reason: run.hold.reason, why: run.hold.why }); continue; }
    if (dryRun) { out.published.push({ key, dryRun: true, target: target.rootMessageId }); continue; }
    const owned = claimRunPublish({ runsDir, key });
    if (!owned.ok) {
      (owned.reason === "reap_lock_held" || owned.reason === "io_error" ? out.stuck : out.skipped)
        .push({ key, reason: owned.reason, why: owned.detail ?? owned.error ?? null });
      continue;
    }
    try {
      const receipt = readRunReceipt({ runsDir, key });
      if (receipt.state !== "absent") { out.skipped.push({ key, reason: "receipt_" + receipt.state, why: receipt.why ?? null }); continue; }
      // **账本在 claim 内重读并预留这次尝试** —— 两个并发排空锁外各读到 4，串行拿到 claim
      // 后会执行第 5、6 次；预留写不进去就不发（账本更新不了 = 不许自动尝试）。
      const ledger = readPublishLedger({ runsDir, key });
      const hold = publishHold(ledger);
      if (hold) { out.stuck.push({ key, reason: hold.reason, why: hold.why }); continue; }
      const reserved = writePublishLedger({ runsDir, key, attempts: ledger.attempts + 1, error: "reserved" });
      if (!reserved.ok) { out.stuck.push({ key, reason: "ledger_unwritable", why: reserved.why }); continue; }
      const runRecord = { kind: run.state === "completed" ? "reply" : "risk", text,
        source: "claude-run-drain", target_channel_generation_id: origin, run_id: key };
      let mid;
      try {
        mid = publish({
          profile: id.profile, rootMessageId: target.rootMessageId,
          card: composeOutboundCard([runRecord], { taskName: cfg.task_display_name, runtime: "claude" }),
          larkBin: id.bin, larkHome: id.configDir, expectedAppId: id.expectedAppId, timeoutMs,
        });
      } catch (err) {
        const error = String(err?.message ?? err).slice(0, 300);
        const wrote = writePublishLedger({ runsDir, key, attempts: ledger.attempts + 1, error });
        out.stuck.push({ key, reason: "publish_failed", why: error, attempts: ledger.attempts + 1,
          ...(wrote.ok ? {} : { ledger: "unwritable：" + wrote.why }) });
        continue;
      }
      // **过了这一行消息已经送达** —— 回执没落是另一类事故，不许记成发布失败再发一遍。
      try { markPublished({ runsDir, key, messageId: mid }); }
      catch (markErr) {
        // 账本上写明"送达未落标 + message id"：不是发布失败，但下一轮可能重发 —— 人核对时有据可查。
        const noted = writePublishLedger({ runsDir, key, attempts: ledger.attempts + 1, error: "delivered_unrecorded：" + mid });
        // 已知送达后的证据也没落盘 —— 不许隐瞒；此时盘上只剩 reserved，下一轮按"未闭合"禁止自动重试。
        if (!noted.ok) out.problems.push({ key, reason: "ledger_unwritable", why: "送达证据（" + mid + "）没落盘：" + noted.why });
        out.deliveredUnrecorded.push({ key, messageId: mid, error: String(markErr?.message ?? markErr).slice(0, 200) });
        continue;
      }
      try { fs.rmSync(path.join(runsDir, key + ".publish-failed.json"), { force: true }); } catch { /* 账本留着也无害 */ }
      try { claudeRotationBatchHook({ root, claudeSessionId })({ batch: [runRecord], target, messageId: mid }); }
      catch (hookErr) { out.stuck.push({ key, reason: "bookkeeping_failed", why: String(hookErr?.message ?? hookErr).slice(0, 200), messageId: mid }); }
      out.published.push({ key, messageId: mid, target: target.rootMessageId });
    } finally {
      // 释放失败（抛或返回 false）不许把整轮排空炸掉，也不许沉默：记成 problems。
      let released = false;
      try { released = releaseRunPublishClaim({ runsDir, key, token: owned.token }) === true; }
      catch (relErr) { out.problems.push({ key, reason: "claim_release_failed", why: String(relErr?.code ?? relErr?.message ?? relErr).slice(0, 120) }); released = true; }
      if (!released) out.problems.push({ key, reason: "claim_release_failed", why: "token 不匹配或 owner 不可读" });
    }
  }
  return out;
}

/**
 * 把一次排空结果讲成一句话。**分支顺序是这个函数的语义，不是排版。**
 *
 * 抽出来的理由：这套 if-chain 里的**顺序本身**就是一条被评审罚过的判据 ——
 * 同一次失败可以既是永久拒绝、又带跨应用诊断，谁排前面决定人看到哪一个。
 * 内嵌在 CLI 里的话，唯一能验它的办法是真的跑一次发布（那会打到真实飞书），
 * 或者去断言源码文本（那种断言改坏了照样绿）。
 *
 * @returns {{text:string, error:boolean}|null} null = 不用说话
 */
export function describeDrainOutcome(r, { root, verbose = false } = {}) {
  // 只有 run 通道时不渲染 outbox 那一段 —— 没执行的事不许陈述。
  const base = r?.status === "runs_only" ? null : describeOutboxOutcome(r, { root, verbose });
  const runs = r?.runs;
  if (!runs) return base;
  const bits = [];
  let error = base?.error === true;
  const short = (k) => (typeof k === "string" ? k.slice(0, 8) : "runs 目录");
  if (runs.published.length > 0) {
    bits.push((runs.dryRun ? "[dry-run] 将经 run 通道发布 " : "run 通道已发布 ") + runs.published.length + " 条" +
      (runs.dryRun ? "" : " -> " + runs.published.map((p) => p.messageId).join("、")));
  }
  if ((runs.deliveredUnrecorded ?? []).length > 0) {
    error = true;
    bits.push("**run 通道有 " + runs.deliveredUnrecorded.length + " 条送达后回执没落，下一轮可能重发** —— 先去话题核对：\n" +
      runs.deliveredUnrecorded.map((x) => "  " + short(x.key) + "（" + x.messageId + "）—— " + x.error).join("\n"));
  }
  if (runs.stuck.length > 0) {
    error = true;
    bits.push("**run 通道有 " + runs.stuck.length + " 条卡住，需要人看**：\n" +
      runs.stuck.map((x) => "  " + short(x.key) + " —— " + x.reason + (x.why ? "：" + x.why : "")).join("\n"));
  }
  if ((runs.problems ?? []).length > 0) {
    error = true;
    bits.push("**runs 账本说不清（" + runs.problems.length + " 处）**：\n" +
      runs.problems.map((x) => "  " + short(x.key) + " —— " + x.reason + (x.why ? "：" + x.why : "")).join("\n"));
  }
  if (verbose && runs.skipped.length > 0) {
    bits.push("run 通道跳过 " + runs.skipped.length + " 条：" +
      runs.skipped.map((x) => short(x.key) + "（" + x.reason + "）").join("、"));
  }
  if (bits.length === 0) return base ?? (verbose && r?.status === "runs_only" ? { text: "outbox 为空", error: false } : base);
  const text = (base?.text ? base.text + "\n" : "") + bits.join("\n");
  return { text, error };
}

function describeOutboxOutcome(r, { root, verbose = false } = {}) {
  // 发布后的两类异常各自成段，**同时发生就同时展示** ——
  // 上一版 if/else if 只展示落标失败，轮转账缺口跟着消失（评审点名）。
  const postDeliveryNotes = (rr) => {
    const parts = [];
    if ((rr.deliveredUnrecorded ?? []).length > 0) {
      // 落标失败比记账缺口重一级：消息送达了但盘上没记 —— 下一轮可能重发。
      parts.push("**有 " + rr.deliveredUnrecorded.length + " 条送达后没落标，" +
        "下一轮可能把它们重发一遍** —— 先去话题里核对再决定要不要手工标记：\n" +
        rr.deliveredUnrecorded.map((d) => "  " + d.file + "（" + d.messageId + "）—— " + d.error).join("\n"));
    }
    if ((rr.bookkeepingFailures ?? []).length > 0) {
      parts.push("**有 " + rr.bookkeepingFailures.length + " 处发布后记账失败**" +
        "（那部分内容已送达、不会因此重发；轮转活动可能没记上）：\n" +
        rr.bookkeepingFailures.map((b) => "  " + b.messageId + " —— " + b.error).join("\n"));
    }
    return parts;
  };
  if (r.status === "published") {
    const notes = postDeliveryNotes(r);
    if (notes.length > 0) {
      return { error: true,
        text: "已发布 " + r.count + " 条 -> " + r.messageId + "，" + notes.join("\n") };
    }
    return { text: "已发布 " + r.count + " 条 -> " + r.messageId, error: false };
  }
  if (r.status === "dry_run") {
    return { text: "[dry-run] 将发布 " + r.count + " 条：\n---\n" + r.text, error: false };
  }
  if (r.status === "error" && r.reason === "publish_failed" && (r.partial === true
    || (r.deliveredUnrecorded ?? []).length > 0 || (r.bookkeepingFailures ?? []).length > 0)) {
    // **失败前的进度要说出来**：前几批确实送达了 —— 只报失败会让人把整批重跑，
    // 或者手工把已送达的又发一遍。
    const notes = postDeliveryNotes(r);
    return {
      error: true,
      text: "这一批发到一半失败（" + r.error + "）。\n" +
        "  **失败前已送达 " + (r.messageIds ?? []).length + " 张卡片、落标 " +
        (r.publishedRecords ?? 0) + " 条** —— 已落标的不会重发。" +
        (notes.length > 0 ? "\n" + notes.join("\n") : "") +
        ((r.markedRejected ?? []).length > 0
          ? "\n  失败那一批已暂停自动重试：" + r.markedRejected.join("、") : "") +
        "\n  剩余未发的留在 outbox，下一轮照常尝试。",
    };
  }
  if (r.status === "error" && r.permanent === true) {
    // **先看实际落盘状态，诊断只是补充线索。**
    //
    // 上一版把 diagnosis 排在前面，于是同时命中两者时它仍然说"重试可能一直失败"
    // 并推荐**不可逆抑制** —— 把"已经暂停自动重试"和"可恢复的重试入口"一起藏了。
    //
    // **撞满次数和平台拒绝要分开说**：前者值得人再试一次，
    // 后者不改内容再试多少次都一样。
    return {
      error: true,
      text: (r.permanentKind === "retry_exhausted"
        ? "这一批的自动重试预算耗尽了（试满 " + MAX_AUTO_PUBLISH_ATTEMPTS + " 次），**已暂停自动重试**："
        : "飞书拒绝了这一批（" + r.permanentReason + "），**已暂停自动重试**：") + "\n" +
        "  " + r.error + "\n" +
        (r.markedRejected?.length ? "  已标记：" + r.markedRejected.join("、") + "\n" : "") +
        (r.diagnosis?.kind === "root_owned_by_other_app"
          ? "  另外：话题由另一个应用（" + (r.diagnosis.ownerName ?? "未知") + "）创建。\n" : "") +
        "  修好起因之后要重发：node " + drainCmd() + " --project " + root + " --retry-rejected --force\n" +
        "  确定不发了（不可逆）：node " + suppressCmd() + " --project " + root,
    };
  }
  if (r.status === "error" && r.diagnosis?.kind === "root_owned_by_other_app") {
    return {
      error: true,
      text: "发布失败：话题由另一个应用（" + (r.diagnosis.ownerName ?? "未知") +
        "）创建，当前身份大概率回复不进去，重试可能一直失败。\n" +
        "  要停止重试（不可逆）：node " + suppressCmd() + " --project " + root +
        " --generation " + (r.diagnosis.generationId ?? "<代际 id>") + " --apply",
    };
  }
  if (r.status === "error" && r.local === true) {
    // **本地问题要点名。**上一版落进通用分支，打出来是
    // "排空失败（outbox_unexplainable），进展留在 outbox：undefined" ——
    // 没有文件名、没有坏在哪，等于没兑现"整批拒绝并点名"。
    // 渲染只**读守卫的结论**，不重新判断（判据只有一份）。
    return { text: localOutboxMessage(r), error: true };
  }
  if (r.status === "error") {
    return { text: "排空失败（" + r.reason + "），进展留在 outbox：" + r.error, error: true };
  }
  if (r.status === "needs_attention") {
    // **有被拒的就不能沉默。**落进"outbox 为空"那条等于报了一份假的没有积压。
    return {
      error: true,
      text: r.count + " 条已暂停自动重试，等你看一眼：\n" +
        (r.rejected ?? []).map((item) => "  " + item.file + "（" +
          (item.kind === "retry_exhausted" ? "重试预算耗尽，值得再试一次"
            : item.kind === "platform_rejected" ? "平台拒绝，不改内容再试也一样"
              : "成因不明") + "）—— " + item.why).join("\n") +
        // **--force 要带上。**自动发布关掉时不带它会被开关提前挡住 ——
        // 提示指向的操作做不到它说的事，这个坑踩过不止一次。
        "\n  修好起因之后要重发：node " + drainCmd() + " --project " + root +
        " --retry-rejected --force",
    };
  }
  if (r.status === "skipped") {
    return {
      text: "暂不发布：" + r.reason + (r.count ? "（" + r.count + " 条留在 outbox）" : ""),
      error: false,
    };
  }
  return verbose ? { text: "outbox 为空", error: false } : null;
}

// ---------- CLI ----------

if (isDirectRun(import.meta.url)) {
  const arg = (n) => {
    const i = process.argv.indexOf("--" + n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const SELF_ROOT = moduleRoot(import.meta.url, "..");
  const verbose = process.argv.includes("--verbose");
  const dryRun = process.argv.includes("--dry-run");

  // --all 是兜底定时器该走的路径：登记表里的项目都排空一遍。
  // 只排本仓库会让后接进来的项目在钩子没跑到时永远没有兜底。
  let targets;
  if (process.argv.includes("--all")) {
    const { loadRegistry } = await import("./registry.mjs");
    const reg = loadRegistry();
    if (!reg.ok) {
      console.error("登记表读不了（" + reg.reason + "）：" + (reg.error ?? ""));
      process.exit(1);
    }
    // 按**绑定**枚举，不是按项目根目录。
    //
    // 会话级绑定的 outbox 是 `outbox-<uuid>/`；原来只 map(p.root) 再不带会话地排空，
    // 等于永远只看项目级那一个目录。对会话级绑定来说这不是「延迟」而是「永远发不出去」——
    // 即时发布一旦失败，兜底根本找不到那批进展。同一 root 上项目级与会话级绑定可以并存，
    // 所以这里按 (root, session) 去重，不能按 root 去重。
    const seen = new Set();
    targets = [];
    for (const project of reg.projects) {
      if (typeof project?.root !== "string" || !project.root) continue;
      const claudeSessionId = project.claude_session_id ?? null;
      const key = project.root + "\u0000" + (claudeSessionId ?? "");
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ root: project.root, claudeSessionId });
    }
    if (targets.length === 0 && verbose) console.log("登记表里没有项目");
  } else {
    targets = [{ root: arg("project") ?? SELF_ROOT, claudeSessionId: arg("session") ?? null }];
  }

  // 绕过发布开关必须明说。
  const force = process.argv.includes("--force");
  // 人显式下令才重试被永久拒绝的那些 —— 默认不重试。
  const retryRejected = process.argv.includes("--retry-rejected");
  let hadError = false;
  for (const { root, claudeSessionId } of targets) {
    const tag = targets.length > 1
      ? path.basename(root) +
        (claudeSessionId ? "/" + String(claudeSessionId).slice(0, 8) : "") + ": "
      : "";
    const r = drainProject({ root, claudeSessionId, dryRun, force, retryRejected });

    const line = describeDrainOutcome(r, { root, verbose });
    if (line) {
      (line.error ? console.error : console.log)(tag + line.text);
      if (line.error) hadError = true;
    }
  }
  // 30 分钟兜底顺带做的事：待认领话题无人认领的周期提醒（不过期；72 小时一次、之后每 7 天一次；只在 --all 这条路径上；判据在 topic-generation）。
  if (process.argv.includes("--all")) {
    const { remindClaudePendingClaims, describeReminderSweep } = await import("./claim-reminder.mjs");
    const reminded = remindClaudePendingClaims({ dryRun });
    const said = describeReminderSweep(reminded, { chain: "Claude" });
    if (said) (reminded.ok && reminded.problems.length === 0 ? console.log : console.error)(said);
    if (!reminded.ok || reminded.problems.length > 0) hadError = true;
  }
  if (hadError) process.exit(1);
}
