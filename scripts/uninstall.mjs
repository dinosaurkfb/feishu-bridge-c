#!/usr/bin/env node
/**
 * 一键按序卸载（PK3-U1，issue #234）。默认**只预览**，`--apply` 才动。
 *
 * 为什么要有它：三个安装器各有 `--uninstall`，但"按什么顺序卸"这件事只写在人的脑子里。
 * 顺序错了不是失败，是**留下半截状态**：先卸出站、再卸入站，中间那段时间平台事件还会进来，
 * 而落盘的线程已经没了 —— 那一批消息静默消失；反过来先停入站（止血）再动出站，
 * 最坏也只是"平台那头攒着，等下一轮"。
 *
 * 顺序（写死，见 STEPS），每条都带一句理由：
 *   1 入站技能（Claude）      —— 先把 Aily 回合从运输层摘掉：止血
 *   2 出站（Claude）          —— hooks + 技能 + 兜底定时器 +（linux）aily daemon 服务
 *   3 Codex 链                —— hooks + 技能 + 兜底排空服务
 *   4 runtime/current         —— 两条链的「已安装」标记；versions/ 留着（内容寻址缓存，重装更快）
 *   5 `--purge` 才走：versions/ 与机器级数据（登记表 / 路由表 / 话题映射 / 回执 / 账本 / 模板 / 订阅）
 *
 * **整段编排在一把安装面锁里**（fix1 P1-2）：开工前取 `<home>/.claude/feishu-bridge/install-surface.lock`
 * （与三个安装器、维护流程共用的一把），持有到最后一个删除动作结束；子安装器通过
 * `FEISHU_BRIDGE_INSTALL_SURFACE_HELD` 继承这次持有（否则它们会自重入死锁）。拿不到锁 → exit 2、零写；
 * 维护门开着 → exit 2、零写。**没有"只有开头检查一下"的窗口。**
 *
 * **默认保留全部数据。**卸载的是机制，不是历史：`registry.json`、`routes.json`、
 * `status-providers.json`、`subscriptions.json`、`chain-config.json`、`inbound/`（回执与账本）
 * 都留着 —— 重装即可继续用。要连数据一起删得显式 `--purge --yes-delete-data`。
 *
 * **settings.json 的合同是"本桥条目消失、别人的条目逐字段不变"**，不是"回到装前字节"：
 * 重新序列化会规范化格式（缩进 / 键序），空 ``{}`` 夹具才恰好字节相等。卸载只摘自己的钩子与预览规则，
 * 并把**被清空**的 hooks / permissions 容器一并清掉；别人的条目一个字段都不动。
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

import { moduleRoot } from "./direct-run.mjs";
import { parseArgvOptions } from "./argv-options.mjs";
import { CLAUDE_INBOUND_SKILL, CLAUDE_SKILLS } from "./install-projection.mjs";
import { describeFootprint, installFootprint, machinePurgeTargets } from "./maintenance/install-footprint.mjs";
import { codexRuntimeRoot, runtimeRoot } from "./runtime-install.mjs";
import { timerPlatform } from "./drain-schedule.mjs";
import { acquireInstallSurfaceLock, INSTALL_SURFACE_HELD_ENV, inspectInstallSurfaceLock, installSurfaceLockPath } from "./install-surface-lock.mjs";
import { gateBlocks, gateInboundText } from "./maintenance-gate-core.mjs";

const ROOT = moduleRoot(import.meta.url, "..");
const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");

const USAGE = "用法：node scripts/uninstall.mjs [--apply] [--purge --yes-delete-data]\n" +
  "      默认只预览；--apply 才动；--purge 连机器级数据一起删（必须同时给 --yes-delete-data）。";
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
const yesDeleteData = parsed.options["yes-delete-data"] === true;

const exists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const readText = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };
const list = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

// ---------- 现状盘点：只读，决定每一步「有东西可卸」还是「未安装，跳过」 ----------

const BRIDGE = path.join(HOME, ".claude", "feishu-bridge");
// Codex 链的桥目录只有一份派生规则（codex/state.mjs 的 bridgeHome）：这里镜像它，不另写一套。
const CODEX_BRIDGE = path.join(CODEX_HOME, "feishu-bridge");
const SKILLS_ROOT = path.join(HOME, ".claude", "skills");

/** 两链的 runtime/current（「已安装」标记）：`versions/` 不在这一步的删除范围里。 */
const RUNTIME_CURRENTS = [
  { chain: "claude", link: path.join(runtimeRoot(HOME, "claude"), "current") },
  { chain: "codex", link: path.join(codexRuntimeRoot(CODEX_HOME), "current") },
];

/**
 * 装机足迹：判据只有一份（install-projection.installFootprint）—— doctor 的未安装态用的是同一份，
 * 所以"uninstall 说卸干净了、doctor 说还有残留"这种自相矛盾在结构上就不可能出现。
 */
// 注意：**不**给 codexSkills（Codex 的技能清单住在 scripts/codex/，底座不许反向依赖它 —— 有守卫盯着）。
// 少列那一项不影响判断：Codex 那边的"在不在"由钩子与 runtime/current 决定，而**删**由 codex 安装器自己负责。
const FOOT = installFootprint({ home: HOME, platform: timerPlatform({ home: HOME }) });
const hooksWhich = [...FOOT.present.claudeHooks];
const codexHooksWhich = [...FOOT.present.codexHooks];
const timerPresent = [...FOOT.present.timer, ...FOOT.present.codexDrain];
const claudeSkillsPresent = [...FOOT.present.claudeSkills, ...FOOT.present.codexSkills];
const PURGE = machinePurgeTargets({ home: HOME });
// 入站技能目录与两链技能目录（只算路径形状；"在不在"由 footprint 判 —— 一处判据）
const inboundSkillDir = path.join(SKILLS_ROOT, CLAUDE_INBOUND_SKILL.name);


/**
 * 机器级数据（默认全留，`--purge` 才删）。清单**从产品自己的派生函数取**（fix1 P1-3）：
 *   · roots：两链的机器级桥根目录（整棵删）—— 登记表 / 模板 / 路由表 / 订阅 / 回执 / 账本 / 收据 / runtime 都在里面；
 *   · files：已知数据文件的覆盖点（FEISHU_BRIDGE_REGISTRY / _ROUTES / _STATUS_PROVIDERS / _CHAIN_TEMPLATE
 *     指向别处时）—— 只删那个文件本身，绝不删它的父目录。
 * 手写文件名清单会漏（实测漏过 Claude 的 receipts/、两链 installed-surface.json、Codex 的
 * tasks/<key>/inbound 与 outbound），所以这里不写清单。
 * 项目里的 `<项目>/.runtime-data/` 与飞书话题历史**不在这里**（不归机器级卸载管）。
 */
const DATA = [
  ...PURGE.roots.map((p) => ({ path: p, why: "机器级桥根（登记表 / 模板 / 路由 / 订阅 / 回执 / 账本 / 收据 / runtime）" })),
  ...PURGE.files.map((p) => ({ path: p, why: "已知数据文件的覆盖点（只删这个文件）" })),
];

// ---------- 步骤表：顺序写死，理由写在每一条上 ----------

const stepEnv = { ...process.env, HOME };
const runNode = (rel, args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", rel), ...args],
    { encoding: "utf-8", env: stepEnv, timeout: 300_000 });
  return { ok: r.status === 0, status: r.status, out: String(r.stdout ?? "") + String(r.stderr ?? "") };
};

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
      || FOOT.present.ailyUnit !== null,
    detail: () => [
      ...hooksWhich.map((n) => path.join(HOME, ".claude", "settings.json") + " 里的 " + n),
      ...claudeSkillsPresent,
      ...timerPresent,
      ...[FOOT.present.ailyUnit].filter(Boolean),
    ],
    run: () => runNode("install-outbound.mjs", ["--uninstall", "--apply"]),
  },
  {
    id: "codex",
    title: "Codex 链：hooks + 技能 + 兜底排空服务",
    why: "与 Claude 链同源机制，放在它之后 —— 两条链互不依赖，但按同一条纪律收口（服务是独立命令，卸载也走它自己的反向口）",
    present: () => codexHooksWhich.length > 0 || FOOT.present.codexSkills.length > 0
      || FOOT.present.codexDrain.length > 0 || FOOT.present.codexCurrent !== null,
    detail: () => [
      ...codexHooksWhich.map((n) => path.join(CODEX_HOME, "hooks.json") + " 里的 " + n),
      ...FOOT.present.codexSkills,
      ...FOOT.present.codexDrain,
      ...[FOOT.present.codexCurrent].filter(Boolean),
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
    present: () => FOOT.present.claudeCurrent !== null || FOOT.present.codexCurrent !== null,
    detail: () => [FOOT.present.claudeCurrent, FOOT.present.codexCurrent].filter(Boolean),
    // 只删 symlink：versions/ 是内容寻址缓存（重装快、可复用），删它是 --purge 的事。
    run: () => {
      const gone = [];
      for (const r of RUNTIME_CURRENTS) {
        if (!exists(r.link)) continue;
        try { fs.rmSync(r.link, { force: true }); gone.push(r.link); } catch (err) { return { ok: false, status: 1, out: "删不掉 " + r.link + "：" + err.message }; }
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
    present: () => exists(path.join(BRIDGE, "runtime")) || exists(path.join(CODEX_BRIDGE, "runtime")),
    detail: () => [path.join(BRIDGE, "runtime"), path.join(CODEX_BRIDGE, "runtime")].filter(exists),
    run: () => {
      for (const p of [path.join(BRIDGE, "runtime"), path.join(CODEX_BRIDGE, "runtime")]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (err) { return { ok: false, status: 1, out: "删不掉 " + p + "：" + err.message }; }
      }
      return { ok: true, status: 0, out: "已删 runtime/（两条链）" };
    },
  },
  {
    id: "data",
    title: "机器级数据根（两链的全部机器级状态：登记表 / 路由表 / 话题映射 / 回执 / 账本 / 收据 / 模板 / 订阅）",
    why: "--purge --yes-delete-data 才走：这些是历史与绑定，删了就没了。清单从产品派生函数取（machinePurgeTargets），不是手写文件名清单 —— 手写会漏",
    present: () => DATA.some((d) => exists(d.path)),
    detail: () => DATA.filter((d) => exists(d.path)).map((d) => d.path + "（" + d.why + "）"),
    run: () => {
      const gone = [];
      for (const d of DATA) {
        if (!exists(d.path)) continue;
        try { fs.rmSync(d.path, { recursive: true, force: true }); gone.push(d.path); } catch (err) { return { ok: false, status: 1, out: "删不掉 " + d.path + "：" + err.message }; }
      }
      return { ok: true, status: 0, out: gone.length > 0 ? "已删 " + gone.join("、") : "没有可删的" };
    },
  },
];

// ---------- 参数校验：破坏性动作要两次点头 ----------

if (purge && !yesDeleteData) {
  console.error("拒绝：--purge 会连数据一起删（登记表 / 路由表 / 话题映射 / 回执 / 账本 / 模板 / 订阅）。\n" +
    "      要真的删，两个都写上：node scripts/uninstall.mjs --purge --yes-delete-data --apply\n" +
    "      （现在什么都没做。）");
  process.exit(2);
}

const steps = purge ? [...STEPS, ...PURGE_STEPS] : STEPS;

// ---------- 预览 ----------

console.log("本桥卸载" + (apply ? "（--apply：真的动）" : "（预览，什么都没动）") +
  (purge ? "  ·  --purge（连数据一起删）" : ""));
console.log("HOME     " + HOME);
{
  // 只读投影：--apply 时才真的取锁；这里先让人看到"现在能不能拿"（拿不到就零写拒绝，不是"检查一下就过"）。
  const lockPath = installSurfaceLockPath({ home: HOME });
  const lockNow = inspectInstallSurfaceLock({ home: HOME }).holder;
  console.log("安装面锁 " + lockPath + " → " +
    (lockNow.state === "absent" ? "空闲" : lockNow.state === "held" ? "被占（pid " + lockNow.pid + (lockNow.alive ? " 活着" : " 已死") + "）" : "说不清（" + String(lockNow.why ?? "") + "）") +
    "；维护门：" + (gateBlocks().blocked ? "开着（--apply 会被拒）" : "没开"));
}
console.log("");
for (const [i, s] of steps.entries()) {
  const present = s.present();
  console.log((i + 1) + ". " + s.title + "  → " + (present ? "将停 / 将删" : "未安装，跳过"));
  console.log("   为什么在这个位置：" + s.why);
  for (const d of present ? s.detail() : []) console.log("   · " + d);
}
console.log("");
if (!purge) {
  const kept = DATA.filter((d) => exists(d.path));
  console.log("将保留（默认不删）：");
  for (const d of kept) console.log("  · " + d.path + "（" + d.why + "）");
  if (kept.length === 0) console.log("  · （没有机器级数据文件）");
  console.log("  · <项目>/.runtime-data/ 与话题历史：**本命令不碰**（项目里的东西不归机器级卸载管）");
} else {
  console.log("将保留：**机器级的状态与代码全删**（上面列出的两个桥根 + 覆盖点文件）。");
  console.log("         **不碰**：<项目>/.runtime-data/（每个项目的 outbox / 运行痕迹）与飞书那头的话题历史 —— 那不属于机器级卸载。");
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才真的卸。");
  process.exit(0);
}

// ---------- 执行：全程锁 + 维护门，然后逐个核退出码，失败即停并说清到哪一步 ----------

// fix1 P1-2：**整段编排**在一把受验的安装面锁里（不是"开头检查一下"）——
// 子安装器各自还会取锁，所以把"父进程已持有"这件事通过环境变量交给它们（否则自重入死锁）。
const gate = gateBlocks();
if (gate.blocked) {
  console.error("拒绝：维护门开着（" + gateInboundText(gate) + "）—— 卸载会在维护窗口里写安装面，什么都没有做。");
  process.exit(2);
}
const surface = acquireInstallSurfaceLock({ home: HOME });
if (!surface.ok) {
  console.error("拒绝：安装面锁拿不到（" + surface.reason + "：" + String(surface.why) + "，" + surface.path + "）—— 什么都没有做。" +
    (surface.reason === "surface_install_busy" ? "等它结束再卸。" : ""));
  process.exit(2);
}
// 锁就住在 `<桥根>/install-surface.lock`，而 `--purge` 的最后一个动作正是把那个桥根整棵删掉 ——
// 于是"交不还"在这一条路径上是**预期的**（删了就是交不还）。受控放行只限这一种：purge 且锁在自己删掉的根里，
// 别的 lock_lost / 残骸一律照旧非零（那是真丢了独占性，不是这次删的）。
const PURGED_ROOTS = purge ? PURGE.roots : [];
process.on("exit", () => {
  const rel = surface.release();
  if (rel.ok) return;
  const deletedWithRoot = purge && String(rel.path).startsWith("lock_lost") === false
    && PURGED_ROOTS.some((r) => String(rel.path ?? "").startsWith(r + path.sep))
    && String(rel.why ?? "").startsWith("lock_lost");
  if (deletedWithRoot) {
    console.error("安装面锁随 --purge 的桥根一起删掉了（" + String(rel.path) + "）—— 这是 --purge 的预期结果，不算交还不还。");
    return;
  }
  console.error("安装面锁交不还（" + String(rel.why) + "，" + String(rel.path) + "）。");
  process.exitCode = 3;
});
stepEnv[INSTALL_SURFACE_HELD_ENV] = surface.path;

console.log("\n开始按序卸载（已持安装面锁 " + surface.path + "）：");
for (const [i, s] of steps.entries()) {
  if (!s.present()) { console.log("  " + (i + 1) + ". " + s.title + "：未安装，跳过"); continue; }
  console.log("  " + (i + 1) + ". " + s.title + " …");
  const r = s.run();
  const tail = String(r.out ?? "").trim().split("\n").filter(Boolean).slice(-2).join(" / ");
  if (!r.ok) {
    console.error("\n失败：第 " + (i + 1) + " 步（" + s.title + "）退出码 " + r.status + "。\n" +
      String(r.out ?? "").trim() + "\n" +
      "  **停在这里**：后面每一步都不再执行（半截状态比没卸干净更难查）。\n" +
      "  先看上面那步说了什么；修好之后重跑 `node scripts/uninstall.mjs" +
      (purge ? " --purge --yes-delete-data" : "") + " --apply`。");
    process.exit(1);
  }
  console.log("     ok" + (tail ? "：" + tail : ""));
}
console.log("\n卸载完成。验证：`node scripts/doctor.mjs` 应报「未安装」（无 ✗）。" +
  (purge ? "" : "\n数据都留着；要连数据一起删：`node scripts/uninstall.mjs --purge --yes-delete-data --apply`。"));
