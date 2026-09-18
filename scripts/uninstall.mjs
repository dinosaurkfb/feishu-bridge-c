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
 * **默认保留全部数据。**卸载的是机制，不是历史：`registry.json`、`routes.json`、
 * `status-providers.json`、`subscriptions.json`、`chain-config.json`、`inbound/`（回执与账本）
 * 都留着 —— 重装即可继续用。要连数据一起删得显式 `--purge --yes-delete-data`。
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
import { CLAUDE_INBOUND_SKILL, CLAUDE_SKILLS, installFootprint } from "./install-projection.mjs";
import { codexRuntimeRoot, runtimeRoot } from "./runtime-install.mjs";
import { timerPlatform } from "./drain-schedule.mjs";

const ROOT = moduleRoot(import.meta.url, "..");
const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");

const apply = process.argv.includes("--apply");
const purge = process.argv.includes("--purge");
const yesDeleteData = process.argv.includes("--yes-delete-data");

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
const FOOT = installFootprint({ home: HOME, platform: timerPlatform({ home: HOME }), codexHome: CODEX_BRIDGE });
const hooksWhich = [...FOOT.present.claudeHooks];
const codexHooksWhich = [...FOOT.present.codexHooks];
const timerPresent = FOOT.present.timer;
const claudeSkillsPresent = FOOT.present.claudeSkills;
// 入站技能目录与两链技能目录（只算路径形状；"在不在"由 footprint 判 —— 一处判据）
const inboundSkillDir = path.join(SKILLS_ROOT, CLAUDE_INBOUND_SKILL.name);


/** 机器级数据（默认全留，`--purge` 才删）。项目里的 `.runtime-data/` 不在这个清单里。 */
const DATA = [
  { path: path.join(BRIDGE, "registry.json"), why: "项目登记表（绑定与话题锚点）" },
  { path: path.join(BRIDGE, "routes.json"), why: "入站路由表（话题 → 处理器）" },
  { path: path.join(BRIDGE, "status-providers.json"), why: "状态入口登记" },
  { path: path.join(BRIDGE, "subscriptions.json"), why: "订阅控制面 store" },
  { path: path.join(BRIDGE, "chain-config.json"), why: "链路模板（发送者角色 / 私聊白名单 / 凭据指针）" },
  { path: path.join(BRIDGE, "inbound"), why: "入站回执与账本（谁是 owner、哪条指令被消费过）" },
  { path: path.join(BRIDGE, "ledger"), why: "topic-agent 账本与维护收据" },
  { path: path.join(CODEX_BRIDGE, "registry.json"), why: "Codex 任务登记表" },
  { path: path.join(CODEX_BRIDGE, "chain-config.json"), why: "Codex 链路模板" },
  { path: path.join(CODEX_BRIDGE, "receipts"), why: "Codex 回执" },
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
    present: () => codexHooksWhich.length > 0 || FOOT.present.codexCurrent !== null,
    detail: () => [
      ...codexHooksWhich.map((n) => path.join(CODEX_HOME, "hooks.json") + " 里的 " + n),
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
    title: "机器级数据（登记表 / 路由表 / 话题映射 / 回执 / 账本 / 模板 / 订阅）",
    why: "--purge --yes-delete-data 才走：这些是历史与绑定，删了就没了",
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
  console.log("将保留：无 —— --purge 会删掉机器级数据与 runtime/（项目里的 .runtime-data/ 与话题历史仍不碰）");
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才真的卸。");
  process.exit(0);
}

// ---------- 执行：逐个核退出码，失败即停并说清到哪一步 ----------

console.log("\n开始按序卸载：");
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
