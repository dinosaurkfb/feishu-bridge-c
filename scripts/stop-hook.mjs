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
  const { appendEvent, listPending } = await import("./outbox.mjs");
  const { checkBinding, bindingWarning } = await import("./binding-health.mjs");

  const notes = [];

  for (const project of attributed) {
    // 体检要在「outbox 空不空」之前做 —— 它有可能自己往 outbox 里加一条。
    // 同一档预警只会成功追加一次：outbox 按内容指纹判重，文案里也刻意没有天数。
    const warning = bindingWarning(checkBinding({ root: project.root }));
    if (warning) {
      const r = appendEvent({
        outboxDir: outboxDirOf(project.root),
        kind: warning.kind, text: warning.text, source: "binding-health",
      });
      if (r.ok) log(project.id + " binding warning recorded: " + warning.kind);
    }

    // 空 outbox 的项目连守望者都不用问 —— 这是最常见的情况，越早返回越好。
    if (listPending({ outboxDir: outboxDirOf(project.root) }).length === 0) continue;

    if (watcherActive(project.root)) {
      // 守望者会把执行结果和这批进展合成一条发。抢在它前面发就是把一次指令拆成三条消息。
      log(project.id + " deferred to watcher");
      continue;
    }

    const r = drainProject({ root: project.root, timeoutMs: PUBLISH_TIMEOUT_MS });
    log(project.id + " via=" + project.via.join("+") + " -> " + JSON.stringify(r));

    if (r.status === "published") {
      notes.push("飞书出站：" + project.id + " 已发布 " + r.count + " 条进展。");
    } else if (r.status === "error") {
      notes.push("飞书出站：" + project.id + " 发布失败（" + r.reason + "），进展留在 outbox，兜底定时器会重试。");
    } else if (r.status === "skipped" && r.reason === "mapping_not_active") {
      // 这条必须说出来：绑定失效时进展会无限期堆在本地，而 Frank 什么都收不到。
      notes.push("飞书出站：" + project.id + " 的话题绑定已失效，" + r.count + " 条进展发不出去，需要重签绑定。");
    }
  }

  finish(notes.join(" "));
}

main().catch((err) => {
  log("hook crashed: " + String(err?.stack ?? err).slice(0, 500));
  process.exit(0); // 桥的故障绝不外溢到别人的会话
});
