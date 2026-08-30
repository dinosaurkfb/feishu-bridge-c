#!/usr/bin/env node
/**
 * 安装 Codex adapter：追加 hooks、复制七项技能、初始化 registry。
 * 默认 dry-run；不修改 hook trust，安装本身不发送飞书。
 *
 * 安装**不改订阅策略**。新绑定登记时就默认开启自动发布；历史 task 的迁移走
 * migrate-auto-publish.mjs，这里只报数。
 */

import fs from "node:fs";
import { chatReplyPathStatus } from "../chat-reply.mjs";
import os from "node:os";
import path from "node:path";
import { moduleRoot } from "../direct-run.mjs";
import { shellQuote } from "../shell-quote.mjs";
import { describeTemplateWrite, withChainTemplateWrite } from "../chain-template.mjs";
import { buildHookCommand, codexHooksOwnedEntries, renderCodexHooks, ownsHookCommand, pickNode } from "./hook-command.mjs";
import { referencedRuntimeScripts } from "../install-projection.mjs";
import { artifactSha, installedSurfacePath, recordInstalledSurface } from "../installed-surface.mjs";
import { SKILLS, expectedSkillContent } from "./skill-content.mjs";

import {
  bridgeHome, enableAutoPublishForAllTasks, registryFile,
} from "./state.mjs";
import {
  applyRuntimeSync, codexRuntimeRoot, planRuntimeSync, verifyRuntime,
} from "../runtime-install.mjs";

const ROOT = moduleRoot(import.meta.url, "../..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const HOOKS = path.join(CODEX_HOME, "hooks.json");
const apply = process.argv.includes("--apply");
const uninstall = process.argv.includes("--uninstall");


// 原来这里自带一份同样逻辑的 shellQuote。同一条策略写两遍就会漂 ——
// 这个仓库今天已经为这类重复付过一次代价（时间格式在两处各写一份，边界收紧了一处、
// 另一处没跟上）。改用共用实现。Codex 侧的钩子命令一直是正确加引号的，
// 这次是 Claude 侧向它看齐。
const node = pickNode();
const home = bridgeHome();
// **钩子只认 runtime/current，不再写安装时所在的那个克隆。**
//
// 旧写法是 path.join(ROOT, ...)，ROOT 是跑安装器时的仓库路径 —— 于是线上行为
// 取决于那个目录当时 checkout 到哪。实测过一次代价：线上钩子指向的克隆停在
// 一天前，落后 main 198 个提交，而没有任何地方会报出来。
// **根从 CODEX_HOME 推出来，不从 os.homedir() 拼。**
// CODEX_HOME 本来就是这条链的家目录覆盖点；用 os.homedir() 的话，
// 只隔离了 CODEX_HOME 的测试会真的往本机装一份运行时 —— 实测发生过。
const CHAIN = "codex";
const RUNTIME_ROOT = codexRuntimeRoot(CODEX_HOME);
const RUNTIME_CURRENT = path.join(RUNTIME_ROOT, "current");
const promptScript = path.join(RUNTIME_CURRENT, "scripts", "codex", "prompt-hook.mjs");
const stopScript = path.join(RUNTIME_CURRENT, "scripts", "codex", "stop-hook.mjs");
const log = path.join(home, "hook.log");
// 预览和落盘必须共用同一份扫描。原来这里用 loadRegistry 的**过滤视图**计数，
// 而真正的迁移读的是原始文档 —— 于是预览说"待迁移 1 个"、实际会改 3 个，
// 因为视图滤掉了 enabled:false 的 task 和 root 形状异常的记录。
const autoPublishPreview = enableAutoPublishForAllTasks({ home });
// 运行时计划要在 dry-run 打印之前算好 —— 预览必须说清将要装哪一版。
const runtimePlan = uninstall ? null : planRuntimeSync({ sourceRoot: ROOT, root: RUNTIME_ROOT });
const autoPublishMigrationCount = autoPublishPreview.ok ? autoPublishPreview.changed : null;

// hooks.json 的合并只有一份（codex/hook-command.mjs 的 renderCodexHooks）：让每个事件下恰好只剩一条我们的 hook，只动自己那一条 child。
let before = "";
try { before = fs.readFileSync(HOOKS, "utf-8"); }
catch (err) {
  if (err.code !== "ENOENT") {
    console.error("hooks.json 读不了：" + err.message);
    process.exit(1);
  }
}
const renderedHooks = renderCodexHooks({ baseText: before === "" ? null : before, promptScript, stopScript, node, home, log, uninstall });
const hooks = renderedHooks.hooks;
const promptAction = renderedHooks.actions.UserPromptSubmit;
const stopAction = renderedHooks.actions.Stop;

const skills = SKILLS;
const renderedSkill = (file, name) => expectedSkillContent({
  sourceFile: file, name, runtimeCurrent: RUNTIME_CURRENT, bridgeHome: home });

console.log("hooks       " + HOOKS);
console.log("  UserPromptSubmit → " + promptAction);
console.log("  Stop             → " + stopAction);
for (const skill of skills) {
  console.log("skill       " + path.join(CODEX_HOME, "skills", skill.name));
}
console.log("commands    $feishu-bind  $feishu-unbind  $feishu-status  $feishu-rotate  $feishu-mode（也出现在斜杠菜单）");
console.log("state       " + home + "（Git 外）");
console.log("publish     绑定 task 每轮自动发布；失败留队，历史积压不自动补发" +
  (autoPublishMigrationCount === null ? "" : "（待迁移 " + autoPublishMigrationCount + " 个 task）"));
if (!autoPublishPreview.ok) {
  // 读不出来就说读不出来，而且要在 dry-run 退出**之前**说 —— 静默省略会让
  // "没有待迁移项"和"根本没读到"在预览里长得一模一样。
  // 但**不因此恢复安装时改订阅**：读不出状态更不是替人改策略的理由。
  console.log("            待迁移状态不可读（" + autoPublishPreview.reason + "）；" +
    "可运行 scripts/codex/migrate-auto-publish.mjs 单独查看");
}
console.log("hook trust  不自动写信任；安装后由用户审阅并确认");
{
  // chat 默认态：Codex 链的 chat 也靠本机 Claude CLI 答话 —— 这是安装前置，装了不等于可用
  const cp = chatReplyPathStatus();
  console.log("chat 回复  " + (cp.available ? "claude CLI 可用（" + cp.version + "），未接入的话题 / 私聊会以零工具一次性回合回答" : "不可用（" + cp.why + "）：未接入的话题 / 私聊会明确报 chat_reply_path_unavailable，不冒充可用"));
}
if (!uninstall) {
  console.log("运行时      " + RUNTIME_ROOT +
    (runtimePlan?.ok
      ? "  → 版本 " + runtimePlan.version.slice(0, 16) +
        "（" + runtimePlan.files.length + " 个脚本，来源 " + ROOT + "）"
      : "  → 算不出计划（" + (runtimePlan?.reason ?? "unknown") + "）"));
}
// **调度器不在这条命令里。**装了但没启用是默认态，不是某个检查碰巧生效的结果。
// 评审的裁决：启用要是一条独立命令，否则仍可能误组合。
console.log("兜底排空    未启用（默认）—— 单独跑 scripts/codex/drain-service.mjs 启用");

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才安装。");
  process.exit(0);
}

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

// **先装运行时，再写钩子。**顺序反了的话，钩子会有一段时间指向还不存在的路径 ——
// 那期间每一轮 Stop 都走 hook-unavailable 分支，进展静默留在本地。
if (!uninstall) {
  if (!runtimePlan?.ok) {
    console.error("运行时计划算不出来（" + (runtimePlan?.reason ?? "unknown") + "），什么都没装。");
    process.exit(1);
  }
  const synced = applyRuntimeSync(runtimePlan, { root: RUNTIME_ROOT });
  if (!synced.ok) {
    console.error("运行时装不上（" + synced.reason + "），钩子没动。");
    process.exit(1);
  }
  const checked = verifyRuntime({ root: RUNTIME_ROOT });
  if (!checked.ok) {
    console.error("运行时装完校验不过（" + (checked.reason ?? "drift") + "），钩子没动。");
    process.exit(1);
  }
  console.log("运行时    ：已装 " + runtimePlan.version.slice(0, 16) + " 并校验通过");
}

// **把模板的 bridge_root 更新到 runtime/current。**
//
// 它由 init-chain-template 写成"生成模板时那个仓库路径"，而安装器一直不碰它 ——
// 于是迁移之后留下一个从外部看不出来的漂移：hooks.json 指向 runtime/current，
// 而按 bridge_root 拼出来的命令仍指着旧克隆。钩子路径是新的、命令路径是旧的，
// Codex 跑的是迁移前的代码。
//
// **只改这一个字段**，其余原样：模板里还有群、身份、凭据位置这些东西，
// 装一次基础设施不该顺手改掉它们。
if (!uninstall) {
  const tplFile = path.join(home, "chain-config.json");
  try {
    if (!fs.existsSync(tplFile)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
    // 走模板的唯一写事务：锁内重读、只改这一个字段、校验后原子写 —— 不再无锁整表重写（评审反例：会把并发登记的角色覆盖掉）。
    let before = null;
    const wrote = withChainTemplateWrite({ file: tplFile, allowInvalidCurrent: true, mutate: (cur) => {
      if (cur === null) return { ok: false, reason: "template_unreadable" };
      if (cur.bridge_root === RUNTIME_CURRENT) return { changed: false };
      before = cur.bridge_root;
      return { template: { ...cur, bridge_root: RUNTIME_CURRENT } };
    } });
    const told = describeTemplateWrite(wrote, tplFile);
    if (told.exitCode !== 0) { console.error("模板      ：" + told.lines.join("\n            ")); const e = new Error(wrote.reason ?? "lock_uncleared"); e.code = wrote.reason ?? "lock_uncleared"; throw e; }
    if (wrote.changed) console.log("模板      ：bridge_root " + (before ?? "(无)") + " → runtime/current");
  } catch (err) {
    // 读不出来就说读不出来 —— 不许静默跳过：这个字段错了会让整条链跑旧代码。
    if (err.code !== "ENOENT") {
      console.error("模板 bridge_root 更新失败（" + (err.code ?? err.message) + "）。");
      console.error("**hooks 没动。**先把模板处理好再装 —— 它错了整条链会跑旧代码。");
      process.exit(1);
    }
  }
}

const after = renderedHooks.text;
if (after !== before) {
  if (fs.existsSync(HOOKS)) fs.copyFileSync(HOOKS, HOOKS + ".bak." + Date.now());
  writeAtomic(HOOKS, after);
}

for (const skill of skills) {
  const src = path.join(ROOT, "skills", skill.name);
  const dst = path.join(CODEX_HOME, "skills", skill.name);
  if (uninstall) {
    fs.rmSync(dst, { recursive: true, force: true });
    continue;
  }
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const name of skill.files) {
    const source = path.join(src, name);
    const target = path.join(dst, name);
    // **文件名可能带子目录**（agents/openai.yaml）—— 不先建目录就 ENOENT。
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, renderedSkill(source, name), { mode: 0o600 });
  }
}

if (!uninstall) {
  // 机器级安装收据（维护门 PR B）：hooks.json 只记桥拥有的封闭条目（提取器 codexHooksOwnedEntries），技能整文件
  const installedVersion = verifyRuntime({ root: RUNTIME_ROOT }).version ?? null;
  const extractors = { "codex-hooks": codexHooksOwnedEntries };
  const skillArtifacts = []; const skillTexts = [];
  for (const skill of skills) for (const name of skill.files) {
    const text = renderedSkill(path.join(ROOT, "skills", skill.name, name), name);
    skillArtifacts.push({ path: path.join(CODEX_HOME, "skills", skill.name, name), kind: "skill", sha256: artifactSha({ kind: "skill", text }) });
    skillTexts.push(text.toString("utf-8"));
  }
  const artifacts = [{ path: HOOKS, kind: "codex-hooks", sha256: artifactSha({ kind: "codex-hooks", text: after, extractors }) }, ...skillArtifacts];
  const scripts = referencedRuntimeScripts([after, ...skillTexts].join("\n"));
  const receipt = installedVersion ? recordInstalledSurface({ chain: "codex", version: installedVersion, artifacts, scripts, file: installedSurfacePath({ chain: "codex", codexBridgeHome: home }) }) : { ok: false, reason: "runtime_version_unknown" };
  console.log("安装收据    " + (receipt.ok ? "已记（" + artifacts.length + " 个制品，" + scripts.length + " 个脚本）" : "**没记下**（" + receipt.reason + (receipt.why ? "：" + receipt.why : "") + "）"));
}
if (!uninstall && !fs.existsSync(registryFile(home))) {
  writeAtomic(registryFile(home), JSON.stringify({ schema_version: "1.0", runtime: "codex", tasks: [] }, null, 2) + "\n");
}
if (!uninstall) {
  // task 尚未路由成功时的脱敏错误回执使用这个目录；提前创建，避免首个错误路径才 mkdir。
  fs.mkdirSync(path.join(home, "receipts"), { recursive: true, mode: 0o700 });
  // **安装不再改订阅策略。**原来这里会把所有已登记 task 的 auto_publish_on_completion
  // 强改为 true —— 装一次基础设施，顺手把每条绑定的发布行为改掉，不预览、不留痕、不可选。
  // 新绑定登记时就默认开启，不依赖这一步；历史 task 走显式的 migrate-auto-publish.mjs。
  if (autoPublishPreview.ok && autoPublishPreview.changed > 0) {
    console.log("自动发布  有 " + autoPublishPreview.changed + " 个历史 task 尚未启用；" +
      "要迁移请显式运行 scripts/codex/migrate-auto-publish.mjs --apply");
  }
}
console.log("\n已完成本地安装。下一次 Codex 载入 hook 时会要求信任；请核对命令后再确认。");
