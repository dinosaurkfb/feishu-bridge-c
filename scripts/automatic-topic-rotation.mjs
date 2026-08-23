/**
 * Topic Generation 自动轮转的运行时薄层。
 *
 * 计数与“谁取得一次轮转尝试权”都在 topic-generation.mjs 的原子状态迁移里完成；
 * 本模块只负责识别真正的业务消息，并在锁外启动既有两阶段轮转 CLI。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { recordClaudeTopicActivity } from "./topic-generation-store.mjs";
import { moduleRoot } from "./direct-run.mjs";

const BRIDGE_ROOT = moduleRoot(import.meta.url, "..");

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

const finalBusinessRecords = (batch) => (batch ?? []).filter((record) =>
  record?.kind === "reply");

/**
 * 一张出站卡片里通常只有一个 final record：飞书来源只算 Agent 回复 1 条；
 * 本地来源的配对卡片还包含用户输入，所以算 2 条。纯进展卡片不计数。
 */
export function businessActivitiesForPublishedBatch(batch, { messageId, runtime } = {}) {
  return finalBusinessRecords(batch).map((record, index) => {
    const identity = [record.event_key, record.run_id, record.id, messageId]
      .find(nonEmpty) ?? ("batch-" + index);
    const pairedLocalInput = record.kind === "reply" &&
      record.input_origin === "local" && nonEmpty(record.input_text);
    return {
      eventKey: "outbound:" + (runtime ?? "unknown") + ":" + identity,
      messageDelta: pairedLocalInput ? 2 : 1,
      generationId: record.target_channel_generation_id ?? null,
    };
  });
}

function workerEnv(env) {
  return Object.fromEntries(Object.entries(env ?? process.env).filter(([key]) =>
    !key.startsWith("AILY_CLI_") && key !== "FEISHU_BRIDGE_ROLE"));
}

export function launchAutomaticTopicRotation({
  runtime,
  root,
  threadId,
  claudeSessionId,
  home,
  bridgeRoot = BRIDGE_ROOT,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  const isCodex = runtime === "codex";
  if (!isCodex && runtime !== "claude") return { ok: false, reason: "runtime_invalid" };
  if (!nonEmpty(root)) return { ok: false, reason: "project_root_required" };
  if (isCodex && !nonEmpty(threadId)) return { ok: false, reason: "thread_id_required" };
  if (isCodex && !nonEmpty(home)) return { ok: false, reason: "bridge_home_required" };

  const script = isCodex
    ? path.join(bridgeRoot, "scripts", "codex", "feishu-rotate.mjs")
    : path.join(bridgeRoot, "scripts", "feishu-rotate.mjs");
  const args = [script, "--project", root, "--automatic", "--apply"];
  if (isCodex) args.push("--thread-id", threadId);
  if (!isCodex && nonEmpty(claudeSessionId)) args.push("--claude-session-id", claudeSessionId);

  const logFile = isCodex
    ? path.join(home, "automatic-topic-rotation.log")
    : path.join(root, ".runtime-data", "topic-generation", "automatic-rotation.log");
  let fd;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fd = fs.openSync(logFile, "a", 0o600);
    const child = spawnImpl(process.execPath, args, {
      cwd: bridgeRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: workerEnv(env),
    });
    child.unref?.();
    return { ok: true, pid: child.pid ?? null, logFile };
  } catch (err) {
    return { ok: false, reason: "automatic_rotation_launch_failed", error: String(err.message).slice(0, 300) };
  } finally {
    if (Number.isInteger(fd)) fs.closeSync(fd);
  }
}

export function recordClaudeActivityAndMaybeRotate({
  root,
  claudeSessionId,
  generationId,
  eventKey,
  messageDelta = 1,
  registryFile,
  now,
  retryMs,
  spawnImpl,
  env,
} = {}) {
  const recorded = recordClaudeTopicActivity({
    root, claudeSessionId, generationId, eventKey, messageDelta, registryFile, now, retryMs,
  });
  if (!recorded.ok || !recorded.shouldAutoRotate) return recorded;
  return {
    ...recorded,
    rotationLaunch: launchAutomaticTopicRotation({
      runtime: "claude", root, claudeSessionId, spawnImpl, env,
    }),
  };
}
