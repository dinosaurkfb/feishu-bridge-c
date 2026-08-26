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
import { PUBLISH_FAILURE, classifyPublishFailure, publishDraft } from "./outbound.mjs";
import { publishOutboxAttempt } from "./publish-attempt.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { isLockStale } from "./handoff.mjs";
import { resolveMappingOutboundGeneration } from "./topic-generation.mjs";
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
  if (preflight) return { status: "error", root, ...preflight, local: true };
  if (listPending({ outboxDir }).length === 0) return { status: "empty", root };

  // 项目文件优先，没有就回落到「机器模板 + 登记表那一行」。
  // 已接好的项目走前一条，行为不变；新接的项目目录里一个配置文件都没有。
  const resolved = resolveProject({ root, claudeSessionId });
  if (!resolved.ok) {
    // not_bound 是「有 outbox 但没接桥」—— 会被 CLI 和钩子分别报出来，不静默。
    return { status: "error", root, reason: resolved.reason, error: resolved.error ?? null };
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
      count: listPending({ outboxDir }).length,
    };
  }

  // 绑定失效时不发：话题可能已经不再是 Frank 认可的那个。
  if (mapping.status !== "active") {
    return { status: "skipped", root, reason: "mapping_not_active", count: listPending({ outboxDir }).length };
  }

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
    // 记账钩子：**只记账，不否决**。轮转活动记录维持"发布之后、落标之前"的既有顺序。
    onBatchPublished: ({ batch, target, messageId }) => {
      for (const activity of businessActivitiesForPublishedBatch(batch, {
        messageId, runtime: "claude",
      })) {
        recordClaudeActivityAndMaybeRotate({
          root,
          claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
          generationId: target.channelGenerationId,
          ...activity,
        });
      }
    },
  });

  // 入口只做入口的事：补上 root、Claude 特有的措辞素材与跨应用诊断。
  if (r.status === "dry_run") {
    return {
      status: "dry_run", root, count: r.count,
      cards: r.batches.map((item) => item.card),
      text: composeDigest(r.selected, { taskName: cfg.task_display_name }),
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
      ...rest, root,
      diagnosis: diagnosis.kind === PUBLISH_FAILURE.ROOT_OWNED_BY_OTHER_APP
        ? { kind: diagnosis.kind, ownerName: diagnosis.ownerName ?? null,
            generationId: failingTarget?.generationId ?? failingTarget?.channelGenerationId ?? null,
            count: listPending({ outboxDir }).length }
        : null,
    };
  }
  return { ...r, root };
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
  if (r.status === "published") {
    // **落标失败比记账缺口重一级：消息送达了但盘上没记 —— 下一轮可能重发。**
    // 不许承诺"不会重发"，要人来核对（比如去话题里看那条在不在）。
    if ((r.deliveredUnrecorded ?? []).length > 0) {
      return {
        error: true,
        text: "已发布 " + r.count + " 条 -> " + r.messageId +
          "，**但有 " + r.deliveredUnrecorded.length + " 条送达后没落标** —— " +
          "**下一轮可能把它们重发一遍**，先去话题里核对再决定要不要手工标记：\n" +
          r.deliveredUnrecorded.map((d) => "  " + d.file + "（" + d.messageId + "）—— " + d.error).join("\n"),
      };
    }
    // **发布后的记账缺口不许沉默。**消息确实送达了（不是发布失败），
    // 但轮转活动没记上 —— 不说出来，下一次代际决策就建立在缺账上。
    if ((r.bookkeepingFailures ?? []).length > 0) {
      return {
        error: true,
        text: "已发布 " + r.count + " 条 -> " + r.messageId +
          "，**但有 " + r.bookkeepingFailures.length + " 处发布后记账失败**" +
          "（内容已送达、不会重发；轮转活动可能没记上）：\n" +
          r.bookkeepingFailures.map((b) => "  " + b.messageId + " —— " + b.error).join("\n"),
      };
    }
    return { text: "已发布 " + r.count + " 条 -> " + r.messageId, error: false };
  }
  if (r.status === "dry_run") {
    return { text: "[dry-run] 将发布 " + r.count + " 条：\n---\n" + r.text, error: false };
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
  if (hadError) process.exit(1);
}
