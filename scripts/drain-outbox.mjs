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

import { listPending, markSent, composeDigest } from "./outbox.mjs";
import { composeOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import { PUBLISH_FAILURE, classifyPublishFailure, publishDraft } from "./outbound.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { isLockStale } from "./handoff.mjs";
import { resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";
import {
  businessActivitiesForPublishedBatch, recordClaudeActivityAndMaybeRotate,
} from "./automatic-topic-rotation.mjs";

/**
 * 按目标代际分组。**导出给抑制命令共用** —— 两处各写一份解析就是分叉的开始，
 * 而且实测已经分叉过：排空把旧格式记录归入当前代际，抑制命令却按原始字段过滤，
 * 于是传诊断给出的代际 id 进去，显示"待发 0 条"。
 * **提示指向的操作做不到它说的事。**
 */
export const groupByTargetGeneration = (records) => {
  const groups = new Map();
  for (const record of records) {
    const key = record.target_channel_generation_id ?? "__legacy_active__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()];
};

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
 * 排空一个项目的 outbox。返回结构化结果，自己不打印、不退出 ——
 * 它跑在会话结束钩子里，任何 throw 或 process.exit 都会砸到别人的会话上。
 */
const PUBLISH_ERROR_CAP = 400;

/** 长错误留头也留尾 —— **真正的错误码常常在末尾**，只留头等于把它扔了。 */
function clipBothEnds(text) {
  const t = String(text).trim();
  if (t.length <= PUBLISH_ERROR_CAP) return t;
  return t.slice(0, 160) + " …（中间省略）… " + t.slice(-200);
}

/**
 * 从发布失败里挑出**有用的那半**。
 *
 * Node 的 execSync 错误长这样：`Command failed: <整条命令>\n<stderr>`。
 * 而这条命令带着整张卡片 JSON，光命令回显就上千字符 —— 从头截 400 字留下来的
 * 全是命令，lark-cli 真正说的话一个字都没有。
 *
 * 上上版发现过这个症状，改法是"把 400 放宽"。那治不了：问题不是**长度不够**，
 * 是**截错了方向**。
 *
 * 上一版只对"纯命令回显"留头尾，对 stderr 仍然从头截 —— 于是多行 runtime 提示
 * 加末尾错误码时，`code 230002` 照样被切掉。**同一个错误换了个入口又犯一遍。**
 * 现在头尾保留对**所有**长文本一视同仁。
 *
 * 另一处：上一版只要 message 有换行就删掉第一行。可只有 `Command failed:` 开头的
 * 那种第一行才是命令回显 —— 普通多行错误的第一行往往正是主错误。**只在确实匹配
 * 时才剥。**
 */
export function publishErrorDetail(err) {
  const raw = err?.stderr;
  const stderr = typeof raw === "string" ? raw
    : (raw && typeof raw.toString === "function") ? raw.toString("utf-8") : "";
  const message = String(err?.message ?? "");

  const isCommandEcho = message.startsWith("Command failed:");
  const afterCommand = isCommandEcho && message.includes("\n")
    ? message.slice(message.indexOf("\n") + 1)
    : "";

  const detail = stderr.trim() || afterCommand.trim() || message;
  return clipBothEnds(detail);
}

/** 抑制命令的绝对路径：提示里给相对路径，等于让人猜当前工作目录。 */
export function suppressCmd() {
  return path.join(moduleRoot(import.meta.url, ".."), "scripts", "feishu-suppress-outbox.mjs");
}

export function drainProject({
  root, claudeSessionId, dryRun = false, timeoutMs, force = false,
} = {}) {
  const outboxDir = outboxDirOf(root, claudeSessionId);

  // 先看有没有东西可发。绝大多数会话在这一行就返回了 —— 不读配置、不碰锁。
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

  const lockDir = publishLockOf(root);
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { status: "skipped", root, reason: lock.reason };

  try {
    // 锁内重新读一遍：刚才排队等锁的时候，别的发布者可能已经把这批发掉了。
    const pending = listPending({ outboxDir });
    if (pending.length === 0) return { status: "empty", root };

    const targetBatches = groupByTargetGeneration(pending).flatMap(([targetKey, records]) => {
      const target = resolveMappingOutboundGeneration(
        mapping,
        targetKey === "__legacy_active__" ? null : targetKey,
      );
      if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
      return outboundCardBatches(records).map((batch) => ({
        batch,
        target,
        card: composeOutboundCard(batch, {
          taskName: cfg.task_display_name,
          runtime: "claude",
        }),
      }));
    });
    const cards = targetBatches.map((item) => item.card);
    if (dryRun) {
      return {
        status: "dry_run",
        root,
        count: pending.length,
        cards,
        text: composeDigest(pending, { taskName: cfg.task_display_name }),
      };
    }

    const messageIds = [];
    for (const item of targetBatches) {
      // 记住正在发哪一个目标：失败诊断要查**这一条**的根消息，
      // 而不是 mapping.root_message_id —— 后者可能是别的代际，甚至不存在。
      failingTarget = item.target;
      const messageId = publishDraft({
        profile: id.profile,
        rootMessageId: item.target.rootMessageId,
        card: item.card,
        larkBin: id.bin,
        larkHome: id.configDir,
        expectedAppId: id.expectedAppId,
        timeoutMs,
      });
      for (const activity of businessActivitiesForPublishedBatch(item.batch, {
        messageId, runtime: "claude",
      })) {
        recordClaudeActivityAndMaybeRotate({
          root,
          claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
          generationId: item.target.channelGenerationId,
          ...activity,
        });
      }
      for (const record of item.batch) markSent(record, messageId);
      messageIds.push(messageId);
    }
    return {
      status: "published",
      root,
      count: pending.length,
      messageId: messageIds.at(-1) ?? null,
      messageIds,
    };
  } catch (err) {
    // 不标记、不吞掉：留在 outbox，下一个排空者重试。
      // **只诊断，不自动抑制。**上一版的推理是"失败 + 根消息属于另一个应用 = 永久"，
      // 那是**从相关性推因果**：瞬时的网络错误发生在跨应用根消息上，照样会触发
      // 不可逆的抑制。有损动作不能建立在推断出来的因果上 —— 要么拿到确实表示
      // 身份不兼容的平台错误码，要么由人显式下令。现在选后者。
      const diagnosis = classifyPublishFailure({
        rootMessageId: failingTarget?.rootMessageId ?? null,
        expectedAppId: id?.expectedAppId,
        larkBin: id?.bin, larkHome: id?.configDir, profile: id?.profile,
      });
      return {
        status: "error", root, reason: "publish_failed",
        // 挑有用的那半：见 publishErrorDetail。**从头截固定长度会把真正的
        // 错误码切掉** —— 这条命令光命令回显就上千字符，前 400 字全是命令。
        error: publishErrorDetail(err),
        // 诊断只是**线索**，不是判决 —— 调用方拿它给人看，不拿它做有损动作。
        diagnosis: diagnosis.kind === PUBLISH_FAILURE.ROOT_OWNED_BY_OTHER_APP
          ? { kind: diagnosis.kind, ownerName: diagnosis.ownerName ?? null,
              // 带上代际：抑制命令要按代际限定范围，提示里不给它就等于让人一刀切。
              generationId: failingTarget?.generationId ?? failingTarget?.channelGenerationId ?? null,
              count: listPending({ outboxDir }).length }
          : null,
      };
  } finally {
    releasePublishLock(lockDir);
  }
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
  let hadError = false;
  for (const { root, claudeSessionId } of targets) {
    const tag = targets.length > 1
      ? path.basename(root) +
        (claudeSessionId ? "/" + String(claudeSessionId).slice(0, 8) : "") + ": "
      : "";
    const r = drainProject({ root, claudeSessionId, dryRun, force });

    if (r.status === "published") {
      console.log(tag + "已发布 " + r.count + " 条 -> " + r.messageId);
    } else if (r.status === "dry_run") {
      console.log(tag + "[dry-run] 将发布 " + r.count + " 条：\n---\n" + r.text);
    } else if (r.status === "error" && r.diagnosis?.kind === "root_owned_by_other_app") {
      console.error(tag + "发布失败：话题由另一个应用（" + (r.diagnosis.ownerName ?? "未知") +
        "）创建，当前身份大概率回复不进去，重试可能一直失败。\n" +
        "  要停止重试（不可逆）：node " + suppressCmd() + " --project " + root +
        " --generation " + (r.diagnosis.generationId ?? "<代际 id>") + " --apply");
      hadError = true;
    } else if (r.status === "error") {
      console.error(tag + "排空失败（" + r.reason + "），进展留在 outbox：" + r.error);
      hadError = true;
    } else if (r.status === "skipped") {
      console.error(tag + "暂不发布：" + r.reason + (r.count ? "（" + r.count + " 条留在 outbox）" : ""));
    } else if (verbose) {
      console.log(tag + "outbox 为空");
    }
  }
  if (hadError) process.exit(1);
}
