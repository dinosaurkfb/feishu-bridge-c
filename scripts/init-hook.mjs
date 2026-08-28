#!/usr/bin/env node
/**
 * `/init` 完成后提示显式运行 `/feishu-bind`，但本轮绝不创建绑定。
 *
 * 为什么挂在 /init 上：接入需要一个「这是个正经项目」的声明。用环境去猜（有没有
 * CLAUDE.md、在不在某个父目录下）一定会误判 —— CLAUDE.md 在本机太多目录里都有，
 * 每个都建话题就是刷屏。而 `/init` 不是检测，**它就是 Frank 亲口说的那句声明**。
 *
 * `/init` 不是控制授权。即使模型能渲染结构化选择框，也不能借一次「是」绕开独立的
 * `/feishu-bind` 控制命令；这样 Claude 与 Codex 的控制面语义完全一致。
 *
 * 硬约束，跟 Stop 钩子同一条：**永远 exit 0，永远不抛**。
 * 这个钩子比 Stop 更热 —— 它跑在本机每一次**提交 prompt** 上。已绑定项目会在这里
 * 缓存本地人类输入，供 Stop 与回复配成同一张卡；未绑定项目仍只在 /init 时继续处理。
 */

import fs from "node:fs";
import { isDirectRun } from "./direct-run.mjs";

import {
  claudeTurnInputDir, clearTurnInput, feishuStampMessageId, findTurnRecordDirsUpward, isFeishuStampedInput, storeInboundTurn, storeTurnInput,
} from "./turn-input.mjs";

/** 只认 `/init` 本身和带参数的 `/init xxx`。别的斜杠命令一概不管。 */
export function isInitPrompt(prompt) {
  if (typeof prompt !== "string") return false;
  const p = prompt.trim();
  return p === "/init" || p.startsWith("/init ");
}

/**
 * 注入给模型的控制边界。只允许在原生初始化成功后提示下一条显式命令；不预览、
 * 不提问、不执行脚本，也不把自然语言回复升级成写入授权。
 */
export function composeAsk() {
  return [
    "[飞书桥·/init 适配] 这是 Claude Code 官方 /init，不是飞书绑定命令。",
    "",
    "先完整执行 /init 原本的 CLAUDE.md 初始化；本轮不要运行任何飞书桥脚本，也不要创建或修改绑定。",
    "不要调用 AskUserQuestion 询问是否绑定，也不要把按钮、自然语言答复或默认选项解释成控制授权。",
    "只有初始化确实成功后，才在最终回复末尾逐字提示：",
    "“项目初始化完成。如需将当前项目接入飞书，请显式运行 `/feishu-bind`。”",
    "初始化失败时不要提示。只有用户后续单独运行 `/feishu-bind`，才进入独立绑定流程。",
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
    const feishu = isFeishuStampedInput(prompt);
    const messageId = feishu ? feishuStampMessageId(prompt) : null;
    const refuse = (why) => {
      process.stderr.write("[飞书桥] 记不下这一轮的来源（" + why + "），为避免回复发错话题，本轮不执行。\n");
      process.exit(2);
    };
    // 每个获准执行的 prompt 都必须留下**自己的**记录；上一轮的记录不能活到这一轮。
    // 写记录：飞书回合记消息 id，本地回合记正文（空正文则清掉）。任一失败 → 阻止本轮。
    const writeRecord = (dir) => {
      if (feishu) {
        if (!messageId) refuse("stamp_without_message_id");
        const stored = storeInboundTurn({ dir, key: speakingSession, messageId });
        if (!stored.ok) refuse(stored.reason + (stored.error ? "：" + stored.error : ""));
        return;
      }
      const stored = storeTurnInput({ dir, key: speakingSession, text: prompt });
      if (!stored.ok) {
        const cleared = clearTurnInput({ dir, key: speakingSession });
        if (!cleared.ok) refuse((stored.error ?? stored.reason) + "；清理旧记录也失败");
      }
    };
    const registry = loadRegistry();
    let covered = [];
    if (registry.ok) {
      for (const project of registry.projects.filter((item) => isUnder(cwd, item.root))) {
        const bound = resolveProject({ root: project.root, claudeSessionId: speakingSession });
        if (bound.ok && bound.mapping?.status === "active") {
          const dir = claudeTurnInputDir(project.root, bound.claudeSessionId);
          writeRecord(dir);
          covered.push(dir);
        } else if (feishu) {
          // 飞书回合但绑定解析不了：登记不了来源，不让这一轮跑。
          refuse("binding_unresolved：" + String(bound.reason ?? bound.mapping?.status ?? "?"));
        }
      }
    } else if (feishu) {
      refuse("registry_unreadable：" + String(registry.reason ?? registry.error ?? "?"));
    }
    // 登记表读不出 / 绑定解析不了 / 项目不在登记表里：仍要把上一轮遗留的记录换成这一轮的（或清掉），
    // 否则 Stop 会拿着旧的飞书来源把本地回复发回老话题（评审探针）。
    for (const dir of findTurnRecordDirsUpward({ cwd, key: speakingSession })) {
      if (covered.includes(dir)) continue;
      writeRecord(dir);
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

  // 这里用 bridge_root 只是判断「这台机器配过桥没有」，**不拿它定位任何代码**。
  // 本钩子不执行桥的其他脚本，所以不存在入站钩子那种"从模板拼路径会落回开发克隆"的问题。
  if (typeof tpl.template.bridge_root !== "string" || !tpl.template.bridge_root) process.exit(0);

  const context = composeAsk();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  }) + "\n");
  process.exit(0);
}

if (isDirectRun(import.meta.url)) {
  // --self-test：喂一条合成 payload，把会注入的内容打出来。不读 stdin、不碰会话。
  if (process.argv.includes("--self-test")) {
    console.log(composeAsk());
    process.exit(0);
  }
  main().catch(() => process.exit(0)); // 桥的故障绝不外溢到别人的会话
}
