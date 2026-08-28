#!/usr/bin/env node
/**
 * 出站机制的入口：注册在 ~/.claude/settings.json 的 Stop 钩子。
 *
 * 这是出站与入站对称的那一半。入站是一个技能，所有 aily agent 自动可见；
 * 出站在这之前只是本项目 CLAUDE.md 里手写的一段约定 —— 读到那段文字的会话才守，
 * 换个目录、换个会话就没了。钩子挂在用户级 settings 上，本机每一个 Claude 会话结束时
 * 都会走一遍，不依赖任何会话读过什么。
 *
 * 它做三件事，都是确定性的：
 *   1. 判定这次会话给哪些登记项目干了活（cwd + 会话记录原文）；
 *   2. 有一次性守望者在盯的项目让给它发（避免同一轮发两条）；
 *   3. 其余项目就地排空 outbox。
 *
 * 硬约束：**永远 exit 0，永远不抛**。它跑在本机每一次会话结束时，
 * 崩一次就是所有会话都收到钩子报错。桥断了是桥的事，不能溅到别人的活上。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { effectiveBindingId, resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { claimKey, readClaimState } from "./claim.mjs";
import os from "node:os";
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";

import {
  claudeTurnInputDir, clearTurnInput, readTurnInput, consumeTurnRecord, readTurnRecord } from "./turn-input.mjs";

// 会话结束是同步阻塞点：Frank 的终端在等它返回。发不出去就留在 outbox，
// 兜底定时器 30 分钟内会重试 —— 宁可晚发，不可吊住会话。
const PUBLISH_TIMEOUT_MS = 12_000;

const LOG = path.join(os.homedir(), ".claude", "feishu-bridge", "stop-hook.log");
const LOG_MAX_BYTES = 1 << 20;

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(LOG).size > LOG_MAX_BYTES) fs.rmSync(LOG, { force: true });
    } catch {
      /* 没有日志文件：下一句就建出来 */
    }
    // 压成一行：错误消息里常带换行（JSON.parse 就会），多行日志没法按行读。
    const flat = String(line).replace(/\s+/g, " ").slice(0, 2000);
    fs.appendFileSync(LOG, new Date().toISOString() + " " + flat + "\n", { mode: 0o600 });
  } catch {
    /* 日志写不了不该影响出站，更不该影响会话 */
  }
}

/**
 * 从钩子的 stdin 里取出这一轮的答复正文。
 *
 * `last_assistant_message` 的形状不保证：可能是字符串，也可能是带 content 块的对象。
 * 两种都收，取不出来就返回 null —— 宁可这一轮不发，也不要把一个 "[object Object]"
 * 发到 Frank 的话题里。
 */
export function extractReply(payload, { maxChars }) {
  const raw = payload?.last_assistant_message;
  let text = null;

  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object") {
    const content = Array.isArray(raw.content) ? raw.content : raw.message?.content;
    if (Array.isArray(content)) {
      text = content.filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text).join("\n");
    } else if (typeof raw.text === "string") {
      text = raw.text;
    }
  }

  if (typeof text !== "string") return null;
  text = text.trim();
  if (text.length === 0) return null;

  // 截断会丢信息，但一条超长消息发不出去丢得更多。截了就明说。
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "\n…（本条已截断，全文在终端）";
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 钩子的唯一输出通道。systemMessage 给人看，suppressOutput 免得刷屏。 */
function finish(systemMessage) {
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage, suppressOutput: true }) + "\n");
  process.exit(0);
}

async function main() {
  const payload = readStdinJson() ?? {};

  // 钩子自己触发的二次 Stop 不再处理，避免任何形式的自激。
  if (payload.stop_hook_active === true) process.exit(0);

  const { loadRegistry, attributeSession } = await import("./registry.mjs");

  const registry = loadRegistry();
  if (!registry.ok) {
    log("registry unreadable: " + registry.reason + " " + (registry.error ?? ""));
    finish("飞书出站：登记表读不了（" + registry.reason + "），本次进展未发布。");
  }
  if (registry.projects.length === 0) process.exit(0); // 本机没接桥：静默退出

  const attributed = attributeSession({
    projects: registry.projects,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
  });
  if (attributed.length === 0) process.exit(0);

  const { drainProject, localOutboxMessage, watcherActive, outboxDirOf, suppressCmd } =
    await import("./drain-outbox.mjs");
  const { foreignHint, projectLabel } = await import("./stop-note.mjs");
  const { postDeliveryBits } = await import("./publish-outcome.mjs");
  const { resolveProject } = await import("./project-resolve.mjs");
  const { appendEvent, listPending, MAX_REPLY_CHARS } = await import("./outbox.mjs");
  const { checkBinding, bindingWarning } = await import("./binding-health.mjs");
  const { isBridgeOwnedSession } = await import("./live-session.mjs");
  const { finalizeClaudeDialogueTurn } = await import("./interaction-policy-store.mjs");
  const { recordClaimState } = await import("./claim.mjs");
  const {
    DIALOGUE_POLICY_ID, DIALOGUE_TURN_STATUS, interactionPolicyStateForLegacy,
  } = await import("./interaction-policy.mjs");

  // 桥自己起的会话不产生答复：转发那个只会说「sent」，跑活那个的结果归守望者发
  //（它能分辨 completed / blocked / failed，Stop 钩子看不出这些）。
  const ownedByBridge = isBridgeOwnedSession();

  // 这一轮是哪个 Claude 会话说的。有会话级绑定时靠它选对话题；
  // 没有会话级绑定时它不起作用，行为跟以前一样。
  const speakingSession = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const reply = ownedByBridge ? null : extractReply(payload, { maxChars: MAX_REPLY_CHARS });

  const notes = [];
  // 只有真的进了 notes 的项目才算"报过"。
  const reported = [];

  // 这一轮真给哪些项目写过东西 —— 排空的分级判断按它来，不按"被归属到哪些"。
  const wroteThisTurn = new Set();
  for (const project of attributed) {
    // 先解析出**这一轮该用哪条绑定**：有会话级绑定且对得上就用它，否则回落到项目级。
    // outbox 目录必须跟着绑定走，不能跟着「说话的那个会话」走 ——
    // 只有项目级绑定时，所有会话都该写进原来那个 outbox。
    const bound = resolveProject({ root: project.root, claudeSessionId: speakingSession });
    const boundSession = bound.ok ? bound.claudeSessionId : null;
    const outboxDir = outboxDirOf(project.root, boundSession);
    const inputDir = claudeTurnInputDir(project.root, boundSession);
    // **回复的目标代际由本轮来源决定，说不清就不入队**（goal 第 2 层，评审两轮逼出来的语义）：
    //   · 本地回合 → 当前代际；
    //   · 飞书回合 → 反查入站 claim（受控形状才认）里冻结的 origin，且它必须能在 mapping 里解析成可发布代际；
    //   · 记录缺席 / 损坏、claim 缺席 / 不合形状、origin 解析不了 → **零入队**，写一份可诊断记录。
    //     "退回当前代际"在飞书回合里不是安全回落值，而是另一个话题。
    let turnOrigin = null;
    let turnRoute = { ok: true, kind: "unknown" };
    if (!ownedByBridge && speakingSession && bound.ok) {
      const record = readTurnRecord({ dir: inputDir, key: speakingSession });
      if (!record.ok) {
        turnRoute = { ok: false, reason: "turn_record_" + record.reason };
      } else if (record.consumed) {
        // 这份记录已经授权过一次 Stop：重入 / 上一轮遗留都不许再入队。
        turnRoute = { ok: false, reason: "turn_record_consumed", messageId: record.messageId ?? null };
      } else if (record.kind === "local") {
        turnRoute = { ok: true, kind: "local" };
      } else {
        turnRoute = { ok: false, reason: "claim_unavailable", messageId: record.messageId };
        if (bound.mapping?.logical_task_key) {
          // **claim 必须是这条绑定、这个会话的**：通用形状合法但 binding / session 对不上的 claim 不算。
          const claimState = readClaimState({
            claimsDir: path.join(project.root, ".runtime-data", "inbound", "delivery-claims"),
            key: claimKey(record.messageId, bound.mapping.logical_task_key),
            expect: {
              logicalTaskKey: bound.mapping.logical_task_key,
              bindingId: effectiveBindingId(bound.mapping, { root: project.root }),
              claudeSessionId: boundSession ?? null,
            },
          });
          if (claimState.status !== "valid") {
            turnRoute = { ok: false, reason: "claim_" + claimState.status, why: claimState.why ?? null, messageId: record.messageId };
          } else {
            const origin = claimState.claim.origin_channel_generation_id ?? null;
            const target = resolveMappingOutboundGeneration(bound.mapping, origin);
            turnRoute = target.ok
              ? { ok: true, kind: "feishu", origin }
              : { ok: false, reason: "origin_unresolvable", why: target.reason, origin, messageId: record.messageId };
            if (target.ok) turnOrigin = origin;
          }
        }
      }
    }
    // Dialogue 的现场投递没有后台 watcher；精确目标会话的 Stop 就是该回合的终局观察点。
    // 只结束 active_turn.runtime_target_id 与本会话严格相同的回合，其他会话的 Stop 不得碰它。
    if (!ownedByBridge && speakingSession && bound.ok) {
      const interaction = interactionPolicyStateForLegacy(bound.mapping, {
        bindingId: effectiveBindingId(bound.mapping, { root: project.root }),
      });
      const activeTurn = interaction.ok ? interaction.state.dialogue?.active_turn : null;
      if (interaction.ok && interaction.state.policy_id === DIALOGUE_POLICY_ID &&
          activeTurn?.runtime_target_id === speakingSession) {
        // 这一回合是飞书来的：回复发回该回合受理时冻结的 origin（老话题的指令回老话题）；
        // origin 解析不了同样零入队（校验器已把 origin 形状钉住，这里再守解析）。
        const turnTarget = resolveMappingOutboundGeneration(bound.mapping, activeTurn.origin_channel_generation_id ?? null);
        turnRoute = turnTarget.ok
          ? { ok: true, kind: "dialogue", origin: activeTurn.origin_channel_generation_id }
          : { ok: false, reason: "dialogue_origin_unresolvable", why: turnTarget.reason, origin: activeTurn.origin_channel_generation_id ?? null };
        if (turnTarget.ok) turnOrigin = activeTurn.origin_channel_generation_id;
        const finalized = finalizeClaudeDialogueTurn({
          root: project.root,
          claudeSessionId: boundSession,
          runtimeTargetId: speakingSession,
          status: reply ? DIALOGUE_TURN_STATUS.COMPLETED : DIALOGUE_TURN_STATUS.FAILED,
          reason: reply ? null : "empty_final_output",
        });
        if (finalized.ok && finalized.changed !== false) {
          recordClaimState({
            claimsDir: path.join(project.root, ".runtime-data", "inbound", "delivery-claims"),
            key: activeTurn.run_id,
            state: reply ? "completed" : "failed",
            detail: {
              run_state: reply ? "completed" : "failed",
              observed_by: "claude-live-stop-hook",
              reason: reply ? null : "empty_final_output",
            },
          });
        }
        log(project.id + " dialogue finalize -> " + (finalized.ok ? "ok" : finalized.reason));
      }
    }
    // 答复只发给 **cwd 归属**的项目，不发给「会话记录里提到过路径」的那些。
    // 弱信号用来触发排空是安全的（那些内容本来就要发），但用它决定
    // 「把整段对话原文发到谁的话题里」不行 —— 一次误判就是把无关对话发给了 Frank。
    if (reply && project.via.includes("cwd") && !turnRoute.ok) {
      // 零入队 + 可诊断：完整答复留在记录里（不是预览），临时文件 + rename 原子落盘，文件名带随机段不会覆盖。
      const unrouted = path.join(project.root, ".runtime-data", "outbound", "unrouted-replies");
      try {
        fs.mkdirSync(unrouted, { recursive: true, mode: 0o700 });
        const name = Date.now() + "-" + speakingSession.slice(0, 8) + "-" + crypto.randomUUID().slice(0, 8) + ".json";
        const file = path.join(unrouted, name);
        const tmp = file + ".tmp." + process.pid;
        fs.writeFileSync(tmp, JSON.stringify({
          schema_version: "1.0", artifact_type: "feishu_bridge_unrouted_reply", reason: turnRoute.reason, why: turnRoute.why ?? null,
          message_id: turnRoute.messageId ?? null, origin_channel_generation_id: turnRoute.origin ?? null, session_id: speakingSession,
          binding_id: effectiveBindingId(bound.mapping, { root: project.root }) ?? null, recorded_at: new Date().toISOString(),
          reply_text: reply,
        }, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (err) { log(project.id + " unrouted record unwritable: " + err.message); }
      log(project.id + " reply NOT queued: " + turnRoute.reason + (turnRoute.why ? "（" + turnRoute.why + "）" : ""));
      if (turnRoute.reason !== "turn_record_consumed" && !String(turnRoute.reason).startsWith("turn_record_")) {
        consumeTurnRecord({ dir: inputDir, key: speakingSession });
      }
    } else if (reply && project.via.includes("cwd")) {
      const input = speakingSession
        ? readTurnInput({ dir: inputDir, key: speakingSession })
        : { ok: false };
      const r = appendEvent({
        outboxDir, kind: "reply", text: reply, source: "session-reply",
        eventKey: input.ok && input.captureId
          ? "claude:" + speakingSession + ":capture:" + input.captureId + ":reply"
          : undefined,
        inputText: input.ok ? input.text : undefined,
        inputOrigin: input.ok ? input.inputOrigin : undefined,
        targetGenerationId: bound.ok ? (turnOrigin ?? bound.mapping?.channel_generation_id) : undefined,
        runId: input.ok ? input.captureId : undefined,
      });
      // 成功后保留本轮单文件缓存，直到下一次 UserPromptSubmit 原子覆写。这样 Stop hook
      // 若在同一回合重入，仍会拿到相同 capture_id 并命中事件级幂等；立即删除反而会让
      // 第二次 Stop 退回正文指纹，制造一条没有输入块的重复答复。
      if (r.ok) {
        wroteThisTurn.add(project.root);
        log(project.id + " reply queued (" + reply.length + " 字符)");
      }
      // 这份来源记录已经授权过一次入队：打上消费标记，重入与下一轮都不能再用它。
      if (turnRoute.kind === "local" || turnRoute.kind === "feishu") consumeTurnRecord({ dir: inputDir, key: speakingSession });
    } else if (!reply && speakingSession && project.via.includes("cwd")) {
      clearTurnInput({ dir: inputDir, key: speakingSession });
    }

    // 体检要在「outbox 空不空」之前做 —— 它有可能自己往 outbox 里加一条。
    // 同一档预警只会成功追加一次：outbox 按内容指纹判重，文案里也刻意没有天数。
    const warning = bindingWarning(checkBinding({ root: project.root }));
    if (warning) {
      const r = appendEvent({
        outboxDir,
        kind: warning.kind, text: warning.text, source: "binding-health",
        targetGenerationId: bound.ok ? bound.mapping?.channel_generation_id : undefined,
      });
      if (r.ok) {
        // **这条也要记账。**体检预警不看 via —— 弱信号归属的项目也会被写进一条。
        // 漏记的话下面那道分级判断会把它跳过，**预警就永远发不出去**。
        wroteThisTurn.add(project.root);
        log(project.id + " binding warning recorded: " + warning.kind);
      }
    }

    // **不许在这里自己判"空"。**
    //
    // listPending 把目录错误吞成 []、把坏 JSON 静默跳过 —— 于是
    // "只有一份坏文件"的 outbox 在这里就被 continue 掉了，Stop 完全不出声。
    // 评审用**不带答复**的真实 Stop 进程复现：stdout 空、stderr 空、坏文件还在。
    //
    // 判断委托给已经修正的 drainProject：它先审计、再谈空不空。
    // 代价是常见的"真空"项目多走一次审计（一次 readdir），
    // 换掉的是"读不出来被当成没有东西可发"这一整类。

    // **弱信号归属的项目：只在这一轮真给它写过东西时才排空。**
    //
    // 两个信号的强弱本来就不一样，而上一版只在**写入**那一侧区分了
    // （appendEvent 要求 via 含 cwd），排空这一侧没分 —— 于是
    // transcript 归属带来的唯一效果，就是替**别人的项目**重试它自己的旧积压。
    //
    // 真事：我在这条会话里诊断过 cc2cd，它的路径就进了转录（119 次，只追加）。
    // 从那以后每一轮 Stop 都去排空 cc2cd —— 而我从没给它写过一个字节，
    // 它自己还有两条活会话在排。结果是每轮把同一条发布失败复述一遍。
    //
    // 弱信号存在的理由是"会话起在别处却操作了本项目，进展别卡在本地"——
    // 而"进展"只可能由本轮写入产生，写入又只在 cwd 时发生。
    // **所以这里收窄不会让任何进展卡住**：别人的积压有它自己的会话和兜底定时器。
    if (!project.via.includes("cwd") && !wroteThisTurn.has(project.root)) {
      log(project.id + " via=" + project.via.join("+") + " skipped (本轮没给它写过东西)");
      continue;
    }

    if (watcherActive(project.root)) {
      // 守望者会把执行结果和这批进展合成一条发。抢在它前面发就是把一次指令拆成三条消息。
      log(project.id + " deferred to watcher");
      continue;
    }

    // **必须传 boundSession，不能传 speakingSession。**
    //
    // 上面第一段注释已经写明"outbox 目录必须跟着绑定走"，outboxDir 也照做了；但这里
    // 一度还在传说话的会话，而 drainProject 会拿它**重算一遍目录**。项目级绑定时
    // boundSession 是 null、说话会话是一个 uuid，于是写进 outbox/、却去读
    // outbox-<uuid>/ —— 每一轮都稳定报 empty，进展只能等 30 分钟的兜底定时器。
    // 日志里那对相邻的 "reply queued (N 字符)" 与 "-> {status:empty}" 就是它。
    const r = drainProject({
      root: project.root, claudeSessionId: boundSession, timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    log(project.id + " via=" + project.via.join("+") + " -> " + JSON.stringify(r));

    const who = projectLabel(project);
    // 记下"这一轮真的报了哪些项目"。末尾那句解释要按它来算，不能按"被归属到哪些"
    // 算 —— 非当前项目没东西可报时不产生提示，解释却会孤零零挂在那儿。
    const before = notes.length;
    if (r.status === "published"
      && ((r.deliveredUnrecorded ?? []).length > 0 || (r.bookkeepingFailures ?? []).length > 0)) {
      // 两类同时发生就同时说 —— else-if 会把轮转账缺口藏在落标失败后面。
      notes.push("飞书出站：" + who + " 已发布 " + r.count + " 条，但有" +
        postDeliveryBits(r).replace(/^；/u, " ") + "。");
    } else if (r.status === "published") {
      notes.push("飞书出站：" + who + " 已发布 " + r.count + " 条进展。");
    } else if (r.status === "error" && r.partial === true) {
      // **打了一半的失败要说清两半** —— 落进"整批被拒"或"留在 outbox 会重试"
      // 都在骗人：前者藏了已送达的事实，后者暗示什么都没发出去。
      // **两类发布后异常也要组合着说**（评审实测："第一批送达但记账失败 +
      // 第二批发布失败"的组合，只提落标缺口会把轮转账缺失整个吞掉）。
      notes.push("飞书出站：" + who + " 发到一半失败：已送达 " +
        (r.messageIds ?? []).length + " 张卡片（已落标 " + (r.publishedRecords ?? 0) +
        " 条，不会重发）" + postDeliveryBits(r) + "；失败那批" +
        (r.permanent === true ? "已暂停自动重试" : "留在 outbox，兜底定时器会重试") + "。");
    } else if (r.status === "error" && r.permanent === true) {
      // **不许说"会重试"。**永久拒绝的定义就是再等不会变好；
      // 说成会重试，人就会等 —— 而它已经这样空转过 12 小时。
      notes.push("飞书出站：" + who + (r.permanentKind === "retry_exhausted"
        ? " 连着发不出去，自动重试预算已耗尽"
        : " 被飞书拒绝（" + r.permanentReason + "）") +
        "，**已暂停自动重试**，需要人看一眼。");
    } else if (r.status === "needs_attention") {
      // **不许把两种成因统称为"被飞书拒绝"。**预算耗尽值得人再试一次，
      // 平台拒绝不改内容再试也一样 —— 说混了会把人支去做错的事。
      const kinds = new Set((r.rejected ?? []).map((item) => item.kind));
      const label = kinds.size === 1 && kinds.has("retry_exhausted")
        ? "连着发不出去、重试预算已耗尽"
        : kinds.size === 1 && kinds.has("platform_rejected")
          ? "被飞书拒绝"
          : "发不出去";
      notes.push("飞书出站：" + who + " 有 " + r.count + " 条" + label +
        "，**已暂停自动重试**，等你处理。");
    } else if (r.status === "error" && r.diagnosis?.kind === "root_owned_by_other_app") {
      // 诊断是**线索不是判决**：说清重试大概率无用，但停不停由人决定。
      // 上一版在这里直接说"已停止重试"，那是把一个自动做出的有损动作说成既成事实。
      notes.push("飞书出站：" + who + " 发布失败。这个话题是另一个应用（" +
        (r.diagnosis.ownerName ?? "未知") + "）建的，当前身份大概率回复不进去，" +
        "重试可能一直失败。要停止重试：node " + suppressCmd() + " --project " +
        project.root + " --generation " + (r.diagnosis.generationId ?? "<代际 id>") + " --apply");
    } else if (r.status === "error" && r.local === true) {
      // **这不是发布失败，别让人去查飞书。**
      //
      // 本地 outbox 说不清（读不出来 / 归不了类 / 解释不了，含"目标代际是坏的"）——
      // 问题在本地那几个文件里。说成"发布失败"的话，人会去查网络、凭据、话题，
      // 而问题根本不在那边。**报错报错了地方，比不报还费时间。**
      // 也不说"兜底定时器会重试"：重试多少次都一样，它需要人来看。
      //
      // 判据只有统一守卫一份 —— 这里只负责把它的结论讲清楚。
      notes.push("飞书出站：" + who + " 的" + localOutboxMessage(r));
    } else if (r.status === "error") {
      notes.push("飞书出站：" + who + " 发布失败（" + r.reason + "），进展留在 outbox，兜底定时器会重试。");
    } else if (r.status === "skipped" && r.reason === "auto_publish_disabled") {
      // 这条必须说出来：按设置没发和发失败，下一步完全不同，
      // 而沉默会让人以为发出去了。
      notes.push("飞书出站：" + who + " 按设置未发布（自动发布已关），" +
        r.count + " 条留在 outbox。");
    } else if (r.status === "skipped" && r.reason === "mapping_not_active") {
      // 这条必须说出来：绑定失效时进展会无限期堆在本地，而 Frank 什么都收不到。
      notes.push("飞书出站：" + who + " 的话题绑定已失效，" + r.count + " 条进展发不出去，需要重签绑定。");
    }
    // run 通道（暂停期间留下的 run 结果）的结果随每种状态一起说，不许被折叠。
    const runs = r.runs;
    if (runs) {
      if (runs.published.length > 0 && !runs.dryRun) {
        notes.push("飞书出站：" + who + " 经 run 通道补发了 " + runs.published.length + " 条暂停期间的执行结果。");
      }
      if ((runs.deliveredUnrecorded ?? []).length > 0) {
        notes.push("飞书出站：" + who + " 有 " + runs.deliveredUnrecorded.length +
          " 条 run 结果送达后回执没落，**下一轮可能重发**，先去话题核对。");
      }
      if (runs.stuck.length > 0) {
        notes.push("飞书出站：" + who + " 有 " + runs.stuck.length + " 条 run 结果卡住（" +
          [...new Set(runs.stuck.map((x) => x.reason))].join("、") + "），需要人看一眼。");
      }
      if ((runs.problems ?? []).length > 0) {
        notes.push("飞书出站：" + who + " 的 runs 账本有 " + runs.problems.length + " 处说不清，需要人看一眼。");
      }
    }
    if (notes.length > before) reported.push(project);
  }

  finish(notes.join(" ") + foreignHint(reported));
}

// 只有被直接执行时才真的跑。被 import（测试要 extractReply）时绝不能执行 ——
// main() 是 async 且没人 await，测试同步跑完之后它才继续，然后一个 process.exit(0)
// 会把失败的退出码抹成成功。测试报绿而实际红，是最坏的一种坏。
if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    log("hook crashed: " + String(err?.stack ?? err).slice(0, 500));
    process.exit(0); // 桥的故障绝不外溢到别人的会话
  });
}
