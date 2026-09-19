#!/usr/bin/env node
/**
 * 一键按序卸载（PK3-U1，issue #234）。默认**只预览**，`--apply` 才动。
 *
 * 为什么要有它：三个安装器各有 `--uninstall`，但"按什么顺序卸"这件事只写在人的脑子里。
 * 顺序错了不是失败，是**留下半截状态**：先卸出站、再卸入站，中间那段时间平台事件还会进来，
 * 而落盘的线程已经没了 —— 那一批消息静默消失；反过来先停入站（止血）再动出站，
 * 最坏也只是"平台那头攒着，等下一轮"。
 *
 * 顺序（写死，见 buildSteps），每条都带一句理由：
 *   1 入站技能（Claude）      —— 先把 Aily 回合从运输层摘掉：止血
 *   2 出站（Claude）          —— hooks + 技能 + 兜底定时器 +（linux）aily daemon 服务
 *   3 Codex 链                —— hooks + 技能 + 兜底排空服务
 *   4 runtime/current         —— 两条链的「已安装」标记；versions/ 留着（内容寻址缓存，重装更快）
 *   5 `--purge` 才走：versions/ 与机器级数据（登记表 / 路由表 / 话题映射 / 回执 / 账本 / 模板 / 订阅）
 *
 * ■ 执行段是**可导入的单出口函数**（`runUninstallApply`，fix4 P1-1）
 *
 * 以前这里有一个测试注入点：一个环境变量指向任意 `.mjs`，CLI 在取锁**之前**直接 import 执行它。
 * 注释写着"只给测试用"，但那句话没有约束力 —— 任何能设环境变量的人都能让
 * uninstall 在**锁外**跑任意代码（评审探针：设上它、卸载退出 0、外部脚本写进了 marker），
 * 而"所有写入都在安装面锁内"正是这个命令的合同。做法照 PK2-I2-fix3 的先例（`renewExpiryInLock`）：
 * 锁内段抽成可导入的 `runUninstallApply({ home, env, purge, hooks })`，**CLI 不传任何 hook、
 * 也不读任何"只给测试"的环境变量**；确定性交错的用例直接 import 这个函数、把干扰写进 `hooks.beforeLock`。
 * 函数**不调 `process.exit`**：失败存成结果（`{ code, stdout, stderr }`），退出码由 CLI 那一处映射。
 * 结构上也不许回潮：`scripts/**`（除测试）里 grep 不到那个旧变量名（用例里有一条断言盯着）。
 *
 * ■ 整段编排在一把安装面锁里
 *
 * 开工前取 `<home>/.claude/feishu-bridge/install-surface.lock`（与三个安装器、维护流程共用的一把），
 * 持有到最后一个删除动作结束；子安装器通过 `FEISHU_BRIDGE_INSTALL_SURFACE_HELD` + token 继承这次持有
 * （否则它们会自重入死锁）。拿不到锁 → exit 2、零写；维护门开着 → exit 2、零写。
 * **取锁之后还要重查门、重算足迹与计划**（fix3 P1-1）：查门到取锁之间可以建门，足迹快照之后
 * 可以有人装完。"没有只有开头检查一下的窗口。"
 *
 * ■ 默认保留全部数据
 *
 * 卸载的是机制，不是历史：`registry.json`、`routes.json`、`status-providers.json`、
 * `subscriptions.json`、`chain-config.json`、`inbound/`（回执与账本）都留着 —— 重装即可继续用。
 * 要连数据一起删得显式 `--purge --yes-delete-data`。**删除边界**（fix4 P1-2）：产品自己派生的两处桥根
 * （`<home>/.claude/feishu-bridge`、`<codexHome>/feishu-bridge`）整棵删；**显式 `FEISHU_CODEX_BRIDGE_HOME`
 * 只删它下面封闭的已知条目、目录本身保留**，且它必须落在 home 或系统临时目录下 —— 否则拒绝。
 *
 * ■ settings.json 的合同是"本桥条目消失、别人的条目逐字段不变"
 *
 * 不是"回到装前字节"：重新序列化会规范化格式（缩进 / 键序），空 `{}` 夹具才恰好字节相等。
 * 卸载只摘自己的钩子与预览规则，并把**被清空**的 hooks / permissions 容器一并清掉；别人的条目一个字段都不动。
 *
 * **CLI 参数严格解析**（fix1 P2-2）：未知参数、重复参数一律 exit 2 且零写（复用 scripts/argv-options.mjs）。
 *
 * **项目里的东西不归本命令管**：`<项目>/.runtime-data/`（每个项目的 outbox / 运行痕迹）
 * 与话题历史留在飞书那头，本命令一个字节都不碰。
 *
 * 用法：
 *   node scripts/uninstall.mjs                                  # 预览：将停 / 将删 / 将保留
 *   node scripts/uninstall.mjs --apply
 *   node scripts/uninstall.mjs --purge --yes-delete-data --apply
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isDirectRun, moduleRoot } from "./direct-run.mjs";
import { parseArgvOptions } from "./argv-options.mjs";
import { CLAUDE_INBOUND_SKILL } from "./install-projection.mjs";
import { claudeBridgeRoot, codexBridgeRoot, codexHomeOf, installFootprint, machinePurgeTargets } from "./maintenance/install-footprint.mjs";
import { codexRuntimeRoot, runtimeRoot } from "./runtime-install.mjs";
import { timerPlatform } from "./drain-schedule.mjs";
import { acquireInstallSurfaceLock, INSTALL_SURFACE_HELD_ENV, INSTALL_SURFACE_HELD_TOKEN_ENV, inspectInstallSurfaceLock, installSurfaceLockPath } from "./install-surface-lock.mjs";
import { gateBlocks, gateInboundText } from "./maintenance-gate-core.mjs";

const ROOT = moduleRoot(import.meta.url, "..");

const USAGE = "用法：node scripts/uninstall.mjs [--apply] [--purge --yes-delete-data]\n" +
  "      默认只预览；--apply 才动；--purge 连机器级数据一起删（必须同时给 --yes-delete-data）。";

/** 存在性判据一律 lstat：断链的符号链接也算「在」（与 footprint 同一口径）。 */
const exists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

/**
 * 运行上下文：派生路径 + 现场投影 + 步骤表。两个入口共用（预览与 --apply 各建一份 ——
 * --apply 那份是在**锁内**建的，见 runUninstallApply）。
 *
 * 派生失败（环境变量里的路径不是绝对路径）不抛到栈上：返回 `{ problem }`，
 * 调用方原样打印并 exit 2 —— 人看到的应该是"哪个变量、什么值、为什么"，不是栈。
 */
function makeContext({ home, env, purge }) {
  let codexHome;
  try { codexHome = codexHomeOf({ home, env }); }
  catch (err) {
    return { problem: "拒绝：Codex 家目录派生失败（" + String(err?.message ?? err) + "）—— 环境变量里的路径必须是绝对路径。什么都没做。" };
  }
  let codexBridge;
  try { codexBridge = codexBridgeRoot({ home, env }); }
  catch (err) {
    return { problem: "拒绝：Codex 状态根派生失败（" + String(err?.message ?? err) + "）—— 环境变量里的路径必须是绝对路径。什么都没做。" };
  }
  const codexRuntime = codexRuntimeRoot(codexHome);
  const inboundSkillDir = path.join(home, ".claude", "skills", CLAUDE_INBOUND_SKILL.name);
  /** 两链的 runtime/current（「已安装」标记）：`versions/` 不在这一步的删除范围里。 */
  const runtimeCurrents = [
    { chain: "claude", link: path.join(runtimeRoot(home, "claude"), "current") },
    { chain: "codex", link: path.join(codexRuntime, "current") },
  ];
  /** `--purge` 时连 runtime/ 整棵一起删的两个目录（由产品派生函数取，不靠桥根拼路径）。 */
  const runtimeDirs = [runtimeRoot(home, "claude"), codexRuntime];
  // 子安装器继承这把锁（fix2 P1-1：光给路径不够 —— 还得给它锁里的 token）
  const stepEnv = { ...env, HOME: home };
  const runNode = (rel, args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", rel), ...args],
      { encoding: "utf-8", env: stepEnv, timeout: 300_000 });
    return { ok: r.status === 0, status: r.status, out: String(r.stdout ?? "") + String(r.stderr ?? "") };
  };

  /**
   * 现场：足迹 + `--purge` 清单。**纯读**，可以被算任意多次（fix3 P1-1：预览算一次、持锁后再算一次）。
   * 派生函数是受验的（codex/state.mjs 那份）：相对路径直接抛 → 调用方接住并 exit 2。
   */
  const sceneFor = ({ purgedRoots = [] } = {}) => {
    const targets = machinePurgeTargets({ home, env });
    // 装机足迹：判据只有一份（maintenance/install-footprint.installFootprint）—— doctor 的未安装态
    // 用的是同一份，所以"uninstall 说卸干净了、doctor 说还有残留"这种自相矛盾在结构上不可能出现。
    const foot = installFootprint({ home, env, platform: timerPlatform({ home, env }) });
    // PK3-I249：`why` 是**默认保留时**说的话（"这是什么、为什么留着"），`purgeNote` 是 `--purge` 时的处置。
    //   旧版把"—— 整棵删"写在 `why` 里，于是**不带 --purge 的预览**里每一项后面都挂着"整棵删"，
    //   读者以为它要被删。两句话分开放，各出现在它该出现的那一栏。
    const data = [
      ...targets.roots.map((p) => ({ path: p, kind: "root",
        why: "机器级桥根：登记表 / 模板 / 路由表 / 订阅 / 回执 / 账本 / 收据 / runtime（重装即可继续用）",
        purgeNote: "机器级桥根 —— 整棵删" })),
      // 显式 FEISHU_CODEX_BRIDGE_HOME（fix4 P1-2）：人给的位置只删封闭的已知子项，目录本身保留。
      ...targets.entries.dirs.map((p) => ({ path: p, kind: "entry-dir",
        why: "显式桥根下的已知子目录（tasks / receipts / intents / threads / inbound）",
        purgeNote: "显式桥根下的已知子目录 —— 整棵删（父目录保留）" })),
      ...targets.entries.files.map((p) => ({ path: p, kind: "file",
        why: "显式桥根下的已知数据文件（登记表 / 模板 / 日志 / 收据 …）",
        purgeNote: "显式桥根下的已知数据文件 —— 只删这个文件" })),
      // **覆盖点只删文件**（fix2 P1-2）：它的父目录是人给的，可能是共享目录 —— 递归删它会带走无关的兄弟文件。
      ...targets.files.map((p) => ({ path: p, kind: "file",
        why: "已知数据文件的覆盖点（登记表 / 路由表 …）",
        purgeNote: "已知数据文件的覆盖点 —— 只删这个文件，不碰它的父目录" })),
    ];
    return { purge: targets, foot, data, steps: buildSteps({ foot, data, purgedRoots }) };
  };

  /**
   * 清单形状不合格 → 一句话说清哪个变量哪个值（**任何写入前**拒绝）。
   * 只在 `--purge` 下拦：这些边界是为**删除**设的，而普通卸载一个字节都不删这些目标 ——
   * 拿它拦住普通卸载，会让一个合法但位置不常见的安装变成"卸不掉"，那比不拦更糟。
   */
  const sceneProblem = ({ purge: targets }) => {
    if (!purge || targets.problems.length === 0) return null;
    return "拒绝：删除清单里有不合格的目标（值来自环境变量）：\n" +
      targets.problems.map((p) => "  · " + p.varName + "=" + p.value + " —— " + p.why).join("\n") + "\n" +
      "  整棵删的只允许产品派生的两处桥根：<home>/.claude/feishu-bridge 与 <codexHome>/feishu-bridge；\n" +
      "  显式 FEISHU_CODEX_BRIDGE_HOME 只删其下的已知条目，且位置必须在 home 或系统临时目录下；\n" +
      "  覆盖点文件必须是绝对路径且不是危险宽根。**什么都没做。**";
  };

  /**
   * 步骤表：顺序写死，理由写在每一条上。**是函数**（fix3 P1-1）：持锁后要按重新算出来的足迹重建一遍，
   * 否则「快照之后装了新制品」会被旧快照跳过。
   *
   * `purgedRoots` 由调用方给：只有**本次确实整棵删掉的桥根**才进去（fix2 P1-4 的 lock_lost 豁免判据）。
   */
  function buildSteps({ foot, data, purgedRoots }) {
    const hooksWhich = [...foot.present.claudeHooks];
    const codexHooksWhich = [...foot.present.codexHooks];
    const timerPresent = [...foot.present.timer, ...foot.present.codexDrain];
    // PK3-I249：**按足迹字段拆链**，不做字符串过滤 —— 第 2 步只列 Claude 链自己在 ~/.claude 下的条目，
    //   Codex 的技能（~/.codex/skills/*）只在第 3 步出现（旧版把两链技能并在一起，第 2 步会重复列 8 项）。
    const claudeSkillsPresent = [...foot.present.claudeSkills];
    const STEPS = [
      {
        id: "inbound",
        title: "入站技能（Claude 链）",
        why: "先停入站：Aily 回合不再进运输层（止血）。反过来的话，平台事件会落在已经卸掉处理线程的本机上 —— 静默丢",
        present: () => exists(inboundSkillDir),
        detail: () => [inboundSkillDir],
        run: () => runNode("install-inbound.mjs", ["--uninstall", "--apply"]),
      },
      {
        id: "outbound",
        title: "出站（Claude 链）：hooks + 技能 + 兜底定时器 +（linux）aily daemon 服务",
        why: "入站停掉之后再拆出站；定时器与 daemon 服务先停再删 plist/unit（安装器自己按这个顺序做，停不下来就不删）",
        present: () => hooksWhich.length > 0 || timerPresent.length > 0 || claudeSkillsPresent.length > 0
          || foot.present.ailyUnit !== null,
        detail: () => [
          ...hooksWhich.map((n) => path.join(home, ".claude", "settings.json") + " 里的 " + n),
          ...claudeSkillsPresent,
          ...timerPresent,
          ...[foot.present.ailyUnit].filter(Boolean),
        ],
        run: () => runNode("install-outbound.mjs", ["--uninstall", "--apply"]),
      },
      {
        id: "codex",
        title: "Codex 链：hooks + 技能 + 兜底排空服务",
        why: "与 Claude 链同源机制，放在它之后 —— 两条链互不依赖，但按同一条纪律收口（服务是独立命令，卸载也走它自己的反向口）",
        present: () => codexHooksWhich.length > 0 || foot.present.codexSkills.length > 0
          || foot.present.codexDrain.length > 0 || foot.present.codexCurrent !== null,
        detail: () => [
          ...codexHooksWhich.map((n) => path.join(codexHome, "hooks.json") + " 里的 " + n),
          ...foot.present.codexSkills,
          ...foot.present.codexDrain,
          ...[foot.present.codexCurrent].filter(Boolean),
        ],
        run: () => {
          const first = runNode(path.join("codex", "install.mjs"), ["--uninstall", "--apply"]);
          if (!first.ok) return first;
          const second = runNode(path.join("codex", "drain-service.mjs"), ["--disable", "--apply"]);
          return { ok: second.ok, status: second.status, out: first.out + second.out };
        },
      },
      {
        id: "runtime-current",
        title: "runtime/current（两条链的「已安装」标记）",
        why: "最后才动它：上面每一步都要靠 current 里的脚本干活（钩子 / 定时器）；提前摘掉会让卸载自己跑不起来",
        present: () => foot.present.claudeCurrent !== null || foot.present.codexCurrent !== null,
        detail: () => [foot.present.claudeCurrent, foot.present.codexCurrent].filter(Boolean),
        // 只删 symlink：versions/ 是内容寻址缓存（重装快、可复用），删它是 --purge 的事。
        run: () => {
          const gone = [];
          for (const r of runtimeCurrents) {
            if (!exists(r.link)) continue;
            try { fs.rmSync(r.link, { force: true }); gone.push(r.link); }
            catch (err) { return { ok: false, status: 1, out: "删不掉 " + r.link + "：" + err.message }; }
          }
          return { ok: true, status: 0, out: gone.length > 0 ? "已删 " + gone.join("、") : "没有可删的" };
        },
      },
    ];

    const PURGE_STEPS = [
      {
        id: "runtime-versions",
        title: "runtime/ 整棵（含 versions/ 代码缓存）",
        why: "--purge 才删：它是代码不是数据，但留着就做不到「完全清空」",
        present: () => runtimeDirs.some((p) => exists(p)),
        detail: () => runtimeDirs.filter(exists),
        run: () => {
          // runtime/ 的路径从**产品派生函数**取（runtimeRoot / codexRuntimeRoot）：
          // 自定义 FEISHU_CODEX_BRIDGE_HOME 时 Codex 的 runtime 不在状态根下，用桥根拼路径会漏（fix2 P1-3）。
          for (const p of runtimeDirs) {
            try { fs.rmSync(p, { recursive: true, force: true }); }
            catch (err) { return { ok: false, status: 1, out: "删不掉 " + p + "：" + err.message }; }
          }
          return { ok: true, status: 0, out: "已删 runtime/（两条链）" };
        },
      },
      {
        id: "data",
        title: "机器级数据根（两链的全部机器级状态：登记表 / 路由表 / 话题映射 / 回执 / 账本 / 收据 / 模板 / 订阅）",
        why: "--purge --yes-delete-data 才走：这些是历史与绑定，删了就没了。清单从产品派生函数取（machinePurgeTargets），不是手写文件名清单 —— 手写会漏",
        present: () => data.some((d) => exists(d.path)),
        detail: () => data.filter((d) => exists(d.path)).map((d) => d.path + "（" + d.purgeNote + "）"),
        run: () => {
          const gone = [];
          for (const d of data) {
            if (!exists(d.path)) continue;
            try {
              // root / entry-dir：整棵删；file：只删那个文件（目录递归=越界）。
              // 非递归删除本身是安全的：目录不会被递归带走，符号链接只删链接。
              fs.rmSync(d.path, d.kind === "file" ? { force: true } : { recursive: true, force: true });
            } catch (err) { return { ok: false, status: 1, out: "删不掉 " + d.path + "：" + err.message }; }
            gone.push(d.path);
            // **只有真删掉了包含锁的那棵根，才允许豁免 lock_lost**（fix2 P1-4）：
            // 记在集合里的是“本次确实删成功的根”，而不是“计划要删的根”。
            if (d.kind === "root") purgedRoots.push(d.path);
          }
          return { ok: true, status: 0, out: gone.length > 0 ? "已删 " + gone.join("、") : "没有可删的" };
        },
      },
    ];
    return purge ? [...STEPS, ...PURGE_STEPS] : STEPS;
  }

  return {
    home, env, purge, stepEnv, sceneFor, sceneProblem,
  };
}

/**
 * **`--apply` 的执行段（可导入、单出口）**：取锁 → 锁内重查维护门 → 锁内重算现场与计划 → 按序执行 →
 * 释放锁并折叠释放状态 → 返回 `{ code, stdout, stderr }`。
 *
 * `hooks` 只给用例用（**CLI 不可触达**）：`hooks.beforeLock()` 在「取锁之前」跑，用来确定性地复现
 * 「查门之后建门」与「足迹快照之后装了新制品」两个交错窗口 —— 不靠 sleep 竞速。
 * 生产路径（CLI）不传 hooks，也没有任何环境变量能把它塞进来。
 *
 * 不调 process.exit：调用方拿 code 自己退（导入它的用例才不会被退出码掀掉测试进程）。
 * 锁的释放走 finally 并在这里算成结论 —— 不是 process 的 exit 钩子（那样失败/异常路径上
 * "锁交还不还"这句会晚于所有输出，且导入方跟着一起被挂钩子）。
 */
export function runUninstallApply({ home = os.homedir(), env = process.env, purge = false, hooks = {} } = {}) {
  const stdout = [];
  const stderr = [];
  const finish = (code, purgedRoots = []) => ({
    code,
    stdout: stdout.length > 0 ? stdout.join("\n") + "\n" : "",
    stderr: stderr.length > 0 ? stderr.join("\n") + "\n" : "",
    purgedRoots,
  });

  const ctx = makeContext({ home, env, purge });
  if (ctx.problem !== undefined) { stderr.push(ctx.problem); return finish(2); }

  // 测试注入点：**只能从函数参数来**（CLI 不传、不读任何环境变量）。
  if (typeof hooks.beforeLock === "function") hooks.beforeLock();

  const surface = acquireInstallSurfaceLock({ home, env });
  if (!surface.ok) {
    stderr.push("拒绝：安装面锁拿不到（" + surface.reason + "：" + String(surface.why) + "，" + surface.path + "）—— 什么都没有做。" +
      (surface.reason === "surface_install_busy" ? "等它结束再卸。" : ""));
    return finish(2);
  }
  // 子安装器继承这把锁（fix2 P1-1：核 owner pid + token）。
  ctx.stepEnv[INSTALL_SURFACE_HELD_ENV] = surface.path;
  ctx.stepEnv[INSTALL_SURFACE_HELD_TOKEN_ENV] = surface.token;

  const purgedRoots = [];
  let code = 0;
  try {
    // **锁内重查维护门**（fix3 P1-1）：门是"窗口内不许写安装面"的裁决，取锁前的检查只是礼貌。
    const gate = gateBlocks({ env });
    if (gate.blocked) {
      stderr.push("拒绝：维护门开着（" + gateInboundText(gate) + "）—— 锁内复核发现的（查门到取锁之间的窗口已经关掉）；" +
        "什么都没有做。");
      code = 2;
    } else {
      // **锁内重算**（fix3 P1-1）：足迹与删除清单都按此刻的盘重新算 —— 预览那份只给人看。
      let scene = null;
      try { scene = ctx.sceneFor({ purgedRoots }); }
      catch (err) {
        stderr.push("拒绝：根路径派生失败（" + String(err?.message ?? err) + "）—— 什么都没做。");
        code = 2;
      }
      if (scene !== null) {
        const problem = ctx.sceneProblem(scene);
        if (problem !== null) { stderr.push(problem); code = 2; }
        else {
          // 步骤表用的是**上面这一份锁内现场**（不再算第三遍：两次计算之间盘再变，就又会分叉）。
          const steps = scene.steps;
          stdout.push("开始按序卸载（已持安装面锁 " + surface.path + "）：");
          for (const [i, s] of steps.entries()) {
            if (!s.present()) { stdout.push("  " + (i + 1) + ". " + s.title + "：未安装，跳过"); continue; }
            stdout.push("  " + (i + 1) + ". " + s.title + " …");
            const r = s.run();
            const tail = String(r.out ?? "").trim().split("\n").filter(Boolean).slice(-2).join(" / ");
            if (!r.ok) {
              stderr.push("\n失败：第 " + (i + 1) + " 步（" + s.title + "）退出码 " + r.status + "。\n" +
                String(r.out ?? "").trim() + "\n" +
                "  **停在这里**：后面每一步都不再执行（半截状态比没卸干净更难查）。\n" +
                "  先看上面那步说了什么；修好之后重跑 `node scripts/uninstall.mjs" +
                (purge ? " --purge --yes-delete-data" : "") + " --apply`。");
              code = 1;
              break;
            }
            stdout.push("     ok" + (tail ? "：" + tail : ""));
          }
          if (code === 0) {
            stdout.push("\n卸载完成。验证：`node scripts/doctor.mjs` 应报「未安装」（无 ✗）。" +
              (purge ? "" : "\n数据都留着；要连数据一起删：`node scripts/uninstall.mjs --purge --yes-delete-data --apply`。"));
          }
        }
      }
    }
  } catch (err) {
    // 执行段抛了就如实报（并让 finally 照常释放锁）—— 不许拿异常掀掉锁的归属。
    stderr.push("卸载执行段抛异常（" + String(err?.code ?? err?.message ?? err) + "）：停在这里，锁按下一条结论释放。");
    code = 1;
  } finally {
    // 锁就住在 `<桥根>/install-surface.lock`，而 `--purge` 的最后一个动作正是把那个桥根整棵删掉 ——
    // 于是"交不还"在这一条路径上是**预期的**（删了就是交不还）。
    // **豁免必须窄到“本次 purge 确实删掉了包含锁的那棵根”**（fix2 P1-4）：前置安装器失败、purge 没跑时
    // 那条真的 lock_lost 不许被吞（本次写段的独占性没人核了）。所以看 purgedRoots，不看"计划要删"。
    const rel = surface.release();
    if (!rel.ok) {
      const lockLost = String(rel.why ?? "").startsWith("lock_lost");
      const deletedWithRoot = lockLost && String(rel.path ?? "") !== "" &&
        purgedRoots.some((r) => String(rel.path).startsWith(r + path.sep));
      if (deletedWithRoot) {
        stderr.push("安装面锁随 --purge 的桥根一起删掉了（" + String(rel.path) + "）—— 这是 --purge 的预期结果，不算交还不还。");
      } else {
        stderr.push("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）。");
        code = 3;
      }
    }
  }
  return finish(code, purgedRoots);
}

// ---------- CLI ----------

if (!isDirectRun(import.meta.url)) {
  // 被 import 时只提供上面那个函数（用例的确定性交错），不跑 CLI、不碰任何文件。
} else {
  const parsed = parseArgvOptions(process.argv.slice(2), {
    booleanFlags: new Set(["--apply", "--purge", "--yes-delete-data"]), valueFlags: new Set(),
  });
  if (!parsed.ok) {
    // 破坏性 CLI 不留"未知/重复参数被忽略"的口子（fix1 P2-2）：解析不过就 exit 2、零写。
    console.error("拒绝：" + parsed.message + "\n" + USAGE);
    process.exit(2);
  }
  const apply = parsed.options.apply === true;
  const purge = parsed.options.purge === true;
  if (purge && parsed.options["yes-delete-data"] !== true) {
    console.error("拒绝：--purge 会连数据一起删（登记表 / 路由表 / 话题映射 / 回执 / 账本 / 模板 / 订阅）。\n" +
      "      要真的删，两个都写上：node scripts/uninstall.mjs --purge --yes-delete-data --apply\n" +
      "      （现在什么都没做。）");
    process.exit(2);
  }
  const HOME = os.homedir();

  // ---------- 预览（只读、锁外）----------
  // 拒绝要发生在任何写入之前：清单形状不合格（或派生函数抛：相对路径）就先 exit 2。
  // --apply 会在**锁内重算一遍**，所以这里的快照只用于"给人看"，不用来执行。
  const ctx = makeContext({ home: HOME, env: process.env, purge });
  if (ctx.problem !== undefined) { console.error(ctx.problem); process.exit(2); }
  let scene = null;
  try { scene = ctx.sceneFor(); }
  catch (err) {
    console.error("拒绝：根路径派生失败（" + String(err?.message ?? err) + "）—— 环境变量里的路径必须是绝对路径。什么都没做。");
    process.exit(2);
  }
  {
    const problem = ctx.sceneProblem(scene);
    if (problem !== null) { console.error(problem); process.exit(2); }
  }

  console.log("本桥卸载" + (apply ? "（--apply：真的动）" : "（预览，什么都没动）") +
    (purge ? "  ·  --purge（连数据一起删）" : ""));
  console.log("HOME     " + HOME);
  {
    // 只读投影：--apply 时才真的取锁；这里先让人看到"现在能不能拿"。
    const lockPath = installSurfaceLockPath({ home: HOME });
    const lockNow = inspectInstallSurfaceLock({ home: HOME }).holder;
    console.log("安装面锁 " + lockPath + " → " +
      (lockNow.state === "absent" ? "空闲" : lockNow.state === "held" ? "被占（pid " + lockNow.pid + (lockNow.alive ? " 活着" : " 已死") + "）" : "说不清（" + String(lockNow.why ?? "") + "）") +
      "；维护门：" + (gateBlocks().blocked ? "开着（--apply 会被拒）" : "没开"));
  }
  console.log("");
  for (const [i, s] of scene.steps.entries()) {
    const present = s.present();
    console.log((i + 1) + ". " + s.title + "  → " + (present ? "将停 / 将删" : "未安装，跳过"));
    console.log("   为什么在这个位置：" + s.why);
    for (const d of present ? s.detail() : []) console.log("   · " + d);
  }
  console.log("");
  if (!purge) {
    const kept = scene.data.filter((d) => exists(d.path));
    // PK3-I249：每一项只说"这是什么、为什么默认留着"；"--purge 时会怎么删"另起一句（旧版把它挂在每一项后面，
    //   看起来像"这些要被删"）。
    console.log("将保留（默认不删）：");
    for (const d of kept) console.log("  · " + d.path + "（" + d.why + "）");
    if (kept.length === 0) console.log("  · （没有机器级数据文件）");
    console.log("  · <项目>/.runtime-data/ 与话题历史：**本命令不碰**（项目里的东西不归机器级卸载管）");
    console.log("加 --purge --yes-delete-data 时：上面这些会被删 —— 产品派生的两个桥根整棵删；");
    console.log("  显式 FEISHU_CODEX_BRIDGE_HOME 下只删已知条目（目录本身保留）；覆盖点只删那个文件。");
  } else {
    console.log("将保留：**机器级的状态与代码全删**（产品派生的两个桥根整棵删；显式 FEISHU_CODEX_BRIDGE_HOME");
    console.log("         只删其下已知条目、目录本身保留；覆盖点只删那个文件）。");
    console.log("         **不碰**：<项目>/.runtime-data/（每个项目的 outbox / 运行痕迹）与飞书那头的话题历史 —— 那不属于机器级卸载。");
  }

  if (!apply) {
    console.log("\n[dry-run] 什么都没写。加 --apply 才真的卸。");
    process.exit(0);
  }

  // ---------- 执行：可导入的单出口函数（fix4 P1-1：CLI 不传 hook、不读任何测试变量） ----------
  const result = runUninstallApply({ home: HOME, env: process.env, purge });
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exit(result.code);
}
