#!/usr/bin/env node
/**
 * 自动轮转的可控演练 —— 把「失败重试」和「不重复启动轮转 worker」跑成可读的证据。
 *
 * **这里证明不了「不会重复创建飞书根话题」。**假子进程压根没建过话题，所以演练
 * 能说的只是"冷却期内不会再起一个 worker"。真正的「同一轮只产生一个根话题」要靠
 * 幂等键在真实轮转里验，仍然挂在待验收上 —— 上一版把结论写成"不重复建话题"，
 * 是拿一个证明不了的说法当了证据。
 *
 * 为什么需要它：这两条在路线图上一直挂着「待验收」。它们的**状态机**有单元测试，
 * 但状态机对了不等于整条路走得通 —— 单元测试拿的是内存里的 state 对象，
 * 而线上走的是「登记表原子读改写 + 起子进程」。这两层之间出过事：手工路径加了
 * PREPARING 超时、自动路径没加，两边各写各的，全绿的套件没拦住。
 *
 * 为什么不能靠真实飞书验：制造一次**真实的轮转失败**要么等它自己坏，要么去动
 * 线上状态。这个演练在临时目录里用注入的 spawn 和时钟把失败造出来，
 * 代价是它**不是真实验收** —— 真实那次仍要 Frank 在飞书里确认。这里只回答
 * 「失败之后会不会重试、会不会重复建话题」，不回答「飞书那边看起来对不对」。
 *
 * 零外部副作用：临时目录、临时登记表、注入 spawn，不碰真实 HOME、不发飞书。
 *
 * 用法：node scripts/rotation-drill.mjs [--json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isDirectRun } from "./direct-run.mjs";
import { newRegistryEntry } from "./bind-compose.mjs";
import { promoteBinding } from "./inbound-route.mjs";
import {
  TOPIC_GENERATION_AUTO_ROTATE_RETRY_MS, TOPIC_GENERATION_PREPARING_STALE_MS,
  TOPIC_GENERATION_AUTO_ROTATE_MESSAGES,
} from "./topic-generation.mjs";
import { prepareClaudeTopicRotation, recordClaudeTopicActivity } from "./topic-generation-store.mjs";
import { recordClaudeActivityAndMaybeRotate } from "./automatic-topic-rotation.mjs";

const NOW = Date.parse("2026-08-23T00:00:00.000Z");

/** 造一条已接好的 Claude 绑定，代际计数停在阈值前一条。 */
function fixture({ threshold = TOPIC_GENERATION_AUTO_ROTATE_MESSAGES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotation-drill-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root, { recursive: true });
  const registryFile = path.join(dir, "registry.json");
  const entry = newRegistryEntry({
    root, name: "演练项目", purpose: null, token: "drill1",
    rootMessageId: "om_old", now: NOW,
  });
  fs.writeFileSync(registryFile, JSON.stringify({ schema_version: "1.0", projects: [entry] }));
  promoteBinding({
    root, id: entry.id, source: "registry", generationId: entry.channel_generation_id,
    sessionId: "session_old", registryFile, now: NOW + 1,
  });

  // 灌到阈值前一条：下一条就该触发轮转。
  for (let i = 1; i < threshold; i += 1) {
    const counted = recordClaudeTopicActivity({
      root, generationId: entry.channel_generation_id, eventKey: "warmup-" + i,
      registryFile, now: NOW + i,
    });
    if (!counted.ok) throw new Error("预热失败：" + counted.reason);
  }
  return { dir, root, registryFile, generationId: entry.channel_generation_id };
}

const check = (steps, name, pass, detail) => steps.push({ name, pass, detail });

/**
 * 演练一：轮转失败之后还会不会再试，以及失败后紧接着的消息会不会又建一个话题。
 */
export function drillFailureRetry() {
  const steps = [];
  const { root, registryFile, generationId } = fixture();
  // 轮转子进程是 detached fire-and-forget：launch 返回 ok 只表示"起起来了"，
  // 子进程死没死在那一刻看不到。所以"失败"的可观测面**不是 launch 结果**，
  // 而是代际有没有推进 —— 这个假子进程什么都不做，正是那个失败的样子。
  const launches = [];
  const spawnImpl = () => {
    launches.push(launches.length);
    return { pid: 40000 + launches.length, unref() {} };
  };
  const activeRootMessage = () => JSON.parse(fs.readFileSync(registryFile, "utf-8"))
    .projects[0].root_message_id;
  const before = activeRootMessage();

  // 1. 跨过阈值 → 应当申请一次轮转，而子进程失败。
  const first = recordClaudeActivityAndMaybeRotate({
    root, generationId, eventKey: "cross", registryFile, now: NOW + 100, spawnImpl,
  });
  check(steps, "跨过阈值时申请轮转", first.ok === true && first.shouldAutoRotate === true,
    "shouldAutoRotate=" + first.shouldAutoRotate);
  check(steps, "子进程没干活时代际不推进",
    launches.length === 1 && activeRootMessage() === before,
    "起了 " + launches.length + " 次子进程，绑定仍指向原话题");

  // 2. 紧接着一条新消息：**不能**又去建一个话题。
  const immediate = recordClaudeActivityAndMaybeRotate({
    root, generationId, eventKey: "immediate", registryFile,
    now: NOW + 100 + 1000, spawnImpl,
  });
  check(steps, "失败后紧邻的消息不重复启动轮转 worker",
    immediate.shouldAutoRotate === false && launches.length === 1,
    "shouldAutoRotate=" + immediate.shouldAutoRotate + "，累计起子进程 " + launches.length + " 次");

  // 3. 过了冷却窗口：应当重新申请。
  const after = NOW + 100 + TOPIC_GENERATION_AUTO_ROTATE_RETRY_MS + 1000;
  const retry = recordClaudeActivityAndMaybeRotate({
    root, generationId, eventKey: "retry", registryFile, now: after, spawnImpl,
  });
  check(steps, "冷却窗口过后会重试",
    retry.shouldAutoRotate === true && launches.length === 2,
    "累计起子进程 " + launches.length + " 次");

  return { name: "失败重试与不重复启动 worker", steps };
}

/**
 * 演练二：轮转卡在 PREPARING 会不会永久堵死。
 *
 * 这条是真出过事的那个死锁：轮转登记失败后没有收口，状态停在 PREPARING，
 * 于是自动轮转被挡、手工轮转报 rotation_already_pending、过期清理又说没有待认领代际。
 */
export function drillStuckPreparing() {
  const steps = [];
  const { root, registryFile, generationId } = fixture();

  const prepared = prepareClaudeTopicRotation({
    root, registryFile, operationId: "drill-op-1", now: NOW + 200,
  });
  check(steps, "能进入 PREPARING", prepared.ok === true, prepared.reason ?? "ok");

  const blocked = prepareClaudeTopicRotation({
    root, registryFile, operationId: "drill-op-2", now: NOW + 300,
  });
  check(steps, "PREPARING 期间挡住重复轮转",
    blocked.ok === false && blocked.reason === "rotation_already_pending",
    blocked.reason ?? "（竟然通过了）");

  const stale = NOW + 200 + TOPIC_GENERATION_PREPARING_STALE_MS + 1000;
  const takeover = prepareClaudeTopicRotation({
    root, registryFile, operationId: "drill-op-3", now: stale,
  });
  check(steps, "超时之后可以接管，不永久堵死",
    takeover.ok === true, takeover.reason ?? "ok");

  return { name: "PREPARING 卡住不永久堵死", steps };
}

function main() {
  const drills = [drillFailureRetry(), drillStuckPreparing()];
  const failed = drills.flatMap((d) => d.steps).filter((s) => !s.pass);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ drills, failed: failed.length }, null, 2));
  } else {
    for (const drill of drills) {
      console.log("\n" + drill.name);
      for (const s of drill.steps) {
        console.log("  " + (s.pass ? "✅" : "❌") + " " + s.name + "　" + s.detail);
      }
    }
    console.log("\n" + (failed.length === 0
      ? "全部通过。"
      : failed.length + " 项未通过。"));
    // 说清这份证据管到哪一步，别让它被当成真实验收。
    console.log("这是**可控演练**，不是真实验收：失败是注入的，时钟是喂的，不经飞书。");
    console.log("它回答「失败之后会不会重试、冷却期内会不会再起一个 worker」。");
    console.log("它**不**回答「会不会重复创建飞书根话题」—— 假子进程没建过话题，");
    console.log("那条要靠幂等键在真实轮转里验，仍挂在待验收上。");
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

if (isDirectRun(import.meta.url)) main();
