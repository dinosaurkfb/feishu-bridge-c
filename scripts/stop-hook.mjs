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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";

import {
  claudeTurnInputDir, clearTurnInput, readTurnInput,
} from "./turn-input.mjs";

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

  const { drainProject, watcherActive, outboxDirOf } = await import("./drain-outbox.mjs");
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

  for (const project of attributed) {
    // 先解析出**这一轮该用哪条绑定**：有会话级绑定且对得上就用它，否则回落到项目级。
    // outbox 目录必须跟着绑定走，不能跟着「说话的那个会话」走 ——
    // 只有项目级绑定时，所有会话都该写进原来那个 outbox。
    const bound = resolveProject({ root: project.root, claudeSessionId: speakingSession });
    const boundSession = bound.ok ? bound.claudeSessionId : null;
    const outboxDir = outboxDirOf(project.root, boundSession);
    const inputDir = claudeTurnInputDir(project.root, boundSession);
    // Dialogue 的现场投递没有后台 watcher；精确目标会话的 Stop 就是该回合的终局观察点。
    // 只结束 active_turn.runtime_target_id 与本会话严格相同的回合，其他会话的 Stop 不得碰它。
    if (!ownedByBridge && speakingSession && bound.ok) {
      const interaction = interactionPolicyStateForLegacy(bound.mapping, {
        bindingId: bound.mapping?.binding_id,
      });
      const activeTurn = interaction.ok ? interaction.state.dialogue?.active_turn : null;
      if (interaction.ok && interaction.state.policy_id === DIALOGUE_POLICY_ID &&
          activeTurn?.runtime_target_id === speakingSession) {
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
    if (reply && project.via.includes("cwd")) {
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
        targetGenerationId: bound.ok ? bound.mapping?.channel_generation_id : undefined,
        runId: input.ok ? input.captureId : undefined,
      });
      // 成功后保留本轮单文件缓存，直到下一次 UserPromptSubmit 原子覆写。这样 Stop hook
      // 若在同一回合重入，仍会拿到相同 capture_id 并命中事件级幂等；立即删除反而会让
      // 第二次 Stop 退回正文指纹，制造一条没有输入块的重复答复。
      if (r.ok) log(project.id + " reply queued (" + reply.length + " 字符)");
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
      if (r.ok) log(project.id + " binding warning recorded: " + warning.kind);
    }

    // 空 outbox 的项目连守望者都不用问 —— 这是最常见的情况，越早返回越好。
    if (listPending({ outboxDir }).length === 0) continue;

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

    if (r.status === "published") {
      notes.push("飞书出站：" + project.id + " 已发布 " + r.count + " 条进展。");
    } else if (r.status === "error") {
      notes.push("飞书出站：" + project.id + " 发布失败（" + r.reason + "），进展留在 outbox，兜底定时器会重试。");
    } else if (r.status === "error" && r.diagnosis?.kind === "root_owned_by_other_app") {
      // 诊断是**线索不是判决**：说清重试大概率无用，但停不停由人决定。
      // 上一版在这里直接说"已停止重试"，那是把一个自动做出的有损动作说成既成事实。
      notes.push("飞书出站：" + project.id + " 发布失败。这个话题是另一个应用（" +
        (r.diagnosis.ownerName ?? "未知") + "）建的，当前身份大概率回复不进去，" +
        "重试可能一直失败。要停止重试：feishu-suppress-outbox.mjs --project " +
        project.root + " --apply");
    } else if (r.status === "skipped" && r.reason === "mapping_not_active") {
      // 这条必须说出来：绑定失效时进展会无限期堆在本地，而 Frank 什么都收不到。
      notes.push("飞书出站：" + project.id + " 的话题绑定已失效，" + r.count + " 条进展发不出去，需要重签绑定。");
    }
  }

  finish(notes.join(" "));
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
