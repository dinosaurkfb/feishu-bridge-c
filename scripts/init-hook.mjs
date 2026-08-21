#!/usr/bin/env node
/**
 * `/init` 时问一句：要不要给这个项目在飞书群里建个根话题？
 *
 * 为什么挂在 /init 上：接入需要一个「这是个正经项目」的声明。用环境去猜（有没有
 * CLAUDE.md、在不在某个父目录下）一定会误判 —— CLAUDE.md 在本机太多目录里都有，
 * 每个都建话题就是刷屏。而 `/init` 不是检测，**它就是 Frank 亲口说的那句声明**。
 *
 * 为什么钩子不自己建、而是让模型去问：钩子只有 stdin/stdout 的 JSON，弹不出选择框。
 * 但它能往这一轮里注入一段上下文，而模型手上有真正的提问工具，能渲染带默认值的选项。
 * 分工是：**该确定的地方（触发）由钩子保证**，不靠模型记得；只有「问」交给模型，
 * 而问漏了的代价是零 —— Frank 补一条命令就是了。
 *
 * 硬约束，跟 Stop 钩子同一条：**永远 exit 0，永远不抛**。
 * 这个钩子比 Stop 更热 —— 它跑在本机每一次**提交 prompt** 上。已绑定项目会在这里
 * 缓存本地人类输入，供 Stop 与回复配成同一张卡；未绑定项目仍只在 /init 时继续处理。
 */

import fs from "node:fs";

import {
  claudeTurnInputDir, clearTurnInput, isFeishuStampedInput, storeTurnInput,
} from "./turn-input.mjs";

/** 只认 `/init` 本身和带参数的 `/init xxx`。别的斜杠命令一概不管。 */
export function isInitPrompt(prompt) {
  if (typeof prompt !== "string") return false;
  const p = prompt.trim();
  return p === "/init" || p.startsWith("/init ");
}

/**
 * 注入给模型的那段话。
 *
 * 刻意写死三件事：**等 CLAUDE.md 写完再问**（`/init` 之前问，项目叫什么、干什么
 * 都还不存在，建出来的话题只有一个路径）；**答否就别再问**；
 * **在 Frank 真的去新话题 @ 过之前别说入站通了**。最后一条是这个项目的老纪律，
 * 模型很容易把「接入命令跑完了」顺口说成「整条链路都好了」。
 */
export function composeAsk({ cwd, bridgeRoot, chatName }) {
  return [
    "[飞书桥] 这个目录还没有接飞书话题。",
    "",
    "**等你把 CLAUDE.md 写完之后**（不是现在），做两件事：",
    "",
    "1. 先跑这条看文案（已放行，不会弹权限；它只打印，发不了任何东西）：",
    "   `node " + bridgeRoot + "/scripts/bind-preview.mjs --project " + cwd + "`",
    "2. 把它打印的根消息原样给 Frank 看，然后问一句：",
    "   要不要在飞书群「" + (chatName ?? "（机器级配置里的那个群）") + "」里给这个项目建一个根话题？**默认「是」。**",
    "",
    "- 答是 → 跑 `node " + bridgeRoot + "/scripts/bind-project.mjs --project " + cwd + " --apply`",
    "  这条会弹权限确认 —— **那是应该的**，往群里发一条撤不掉的消息本来就该有人点头。",
    "- 答否 → 什么都不做，这一轮里也不要再问第二次。",
    "",
    "**任何一条跑不了，就把命令交给他，不要自己还原文案。**读 bind-project.mjs 的源码把",
    "根消息「逐字还原」一遍是错的：还原出来的东西看着像脚本输出，其实是你算的，",
    "差一个字他就是照着一份假预览点的头。拦下了就直说，让他自己敲 `! node …`。",
    "",
    "接入之后：出站立刻可用（本机输入与每轮回答会合成卡片自动发到那个话题）。",
    "入站还差最后一下 —— 让 Frank 去那个新话题里 @ 一下运输 agent（空消息也行），",
    "绑定就完成了。**在他真的 @ 过之前，别说入站通了。**",
  ].join("\n");
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function main() {
  const payload = readStdinJson() ?? {};
  const prompt = payload.prompt;
  const cwd = payload.cwd;
  if (typeof prompt !== "string" || !prompt.trim() || typeof cwd !== "string" || !cwd) process.exit(0);
  // 目录得真的在。resolveProject 对一个不存在的路径同样返回 not_bound
  // （没文件、登记表里也没有），单靠它会去给一个根本不存在的目录提议建话题。
  try {
    if (!fs.statSync(cwd).isDirectory()) process.exit(0);
  } catch {
    process.exit(0);
  }

  const { loadRegistry, isUnder } = await import("./registry.mjs");
  const { resolveProject } = await import("./project-resolve.mjs");
  const speakingSession = typeof payload.session_id === "string" && payload.session_id
    ? payload.session_id
    : null;

  // 桥自己起的 forwarder / run 不属于人类本机输入；活跃会话里的飞书指令没有这个环境
  // 标记，但有确定性来源戳。两者都不缓存，后者还会清掉同会话可能遗留的旧输入，避免
  // 下一次 Stop 把一条过期本地 prompt 错配给飞书回复。
  if (!process.env.FEISHU_BRIDGE_ROLE && speakingSession) {
    const registry = loadRegistry();
    if (registry.ok) {
      for (const project of registry.projects.filter((item) => isUnder(cwd, item.root))) {
        const bound = resolveProject({ root: project.root, claudeSessionId: speakingSession });
        if (!bound.ok || bound.mapping?.status !== "active") continue;
        const dir = claudeTurnInputDir(project.root, bound.claudeSessionId);
        if (isFeishuStampedInput(prompt)) {
          clearTurnInput({ dir, key: speakingSession });
        } else {
          storeTurnInput({ dir, key: speakingSession, text: prompt });
        }
      }
    }
  }

  // 常规输入只写本地回合缓存，不向模型注入桥接说明。
  if (!isInitPrompt(prompt)) process.exit(0);

  // 已经接过就闭嘴。重复问一个已经有话题的项目，比不问更烦人。
  const resolved = resolveProject({ root: cwd });
  if (resolved.ok) process.exit(0);
  if (resolved.reason !== "not_bound") process.exit(0); // 配错了不是「该接入」，别拿这个当入口

  const { loadChainTemplate } = await import("./chain-template.mjs");
  const tpl = loadChainTemplate();
  // 没有机器级模板就等于这台机器没装桥 —— 不该在这里教人怎么装，静默退出。
  if (!tpl.ok) process.exit(0);

  const bridgeRoot = tpl.template.bridge_root;
  if (typeof bridgeRoot !== "string" || !bridgeRoot) process.exit(0);

  const context = composeAsk({ cwd, bridgeRoot, chatName: tpl.template.chat_name });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  }) + "\n");
  process.exit(0);
}

if (import.meta.url === "file://" + process.argv[1]) {
  // --self-test：喂一条合成 payload，把会注入的内容打出来。不读 stdin、不碰会话。
  if (process.argv.includes("--self-test")) {
    const { loadChainTemplate } = await import("./chain-template.mjs");
    const tpl = loadChainTemplate();
    console.log(composeAsk({
      cwd: process.argv[process.argv.indexOf("--self-test") + 1] ?? process.cwd(),
      bridgeRoot: tpl.ok ? tpl.template.bridge_root : "<机器级模板还没生成>",
      chatName: tpl.ok ? tpl.template.chat_name : null,
    }));
    process.exit(0);
  }
  main().catch(() => process.exit(0)); // 桥的故障绝不外溢到别人的会话
}
