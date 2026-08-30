#!/usr/bin/env node
/**
 * 把入站技能装到宿主 agent 的技能目录。
 *
 * 出站早就有安装器了，入站一直靠手工拷贝 —— 这个不对称的代价是：换台机器照仓库重建，
 * 你会得到一个「文件都在、内容都对、就是不工作」的状态，而这类失败最难查。
 *
 * **装到哪：`~/.claude/skills/<技能名>/`。**这是 `aily-cli skill scan-local` 真正会扫的
 * 位置 —— 装进去之后它会被列为 `[claude-code-local]`，跟 Codex 那条链路的
 * `~/.codex/skills/` 完全对称。
 *
 * 这个默认值是**改过一次**的。原来默认装到 `~/skills/`，那是 2026-08-19 联调时
 * 「碰巧能用」的一个位置，而不是被扫描的位置 —— 当时在「技能到底从哪加载」这个问题上
 * 一天内下过三次结论、三次被推翻。后来实测确认：`~/skills/` 不在扫描范围内，
 * `~/.claude/skills/` 在。留着旧默认值等于把一个安装器变成新用户的坑。
 *
 * 一条经验（值得留着）：**判断入站是否健康，不能只看「发消息有没有回复」。**
 * 入站智能体是个被反复 resume 的持久会话，技能坏了它也可能凭上下文把命令跑出来。
 *
 * 用法：
 *   node scripts/install-inbound.mjs                    # 看看会改什么，不落盘
 *   node scripts/install-inbound.mjs --apply
 *   node scripts/install-inbound.mjs --uninstall --apply
 *   node scripts/install-inbound.mjs --dir /别的/技能根 --apply
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runtimeScript, verifyRuntime } from "./runtime-install.mjs";
import { referencedRuntimeScripts, renderClaudeSkill } from "./install-projection.mjs";
import { artifactSha, installedSurfacePath, receiptReport, recordInstalledSurface } from "./installed-surface.mjs";
import { moduleRoot } from "./direct-run.mjs";

const ROOT = moduleRoot(import.meta.url, "..");
/**
 * 技能里的脚本路径指向 **runtime**，不指向这个克隆。
 *
 * 理由跟出站安装器一致：技能是给模型看的可执行命令，指向开发克隆意味着 Frank 触发它时
 * 跑的是某条正在开发的分支。SKILL.md 源码里写 `{{BRIDGE_ROOT}}` 占位符，安装时渲染。
 */
const RUNTIME_BRIDGE_ROOT = path.dirname(path.dirname(runtimeScript("aily-inbound.mjs")));
// 与出站安装器同一套渲染（install-projection.mjs）：模板写 {{SCRIPT:x.mjs}}，由渲染器统一加 shell 引号。
// HOME 含空格时裸路径会被 shell 拆词，入站直接不可用。
const renderSkill = (text) => renderClaudeSkill(text, { home: os.homedir() });

/**
 * 将要装进去的那份文本 —— **计划、写入、装完自检必须共用它**。
 *
 * 上一版只在写入那一步渲染，比较和自检仍拿未渲染的源码去比：装对了也会永远报 update，
 * 自检还会说"写入后内容不一致"。渲染类安装器最容易在这里裂成两套真相，所以只留一个出口。
 */
const expectedContent = (f) =>
  f === "SKILL.md"
    ? renderSkill(fs.readFileSync(path.join(SRC, f), "utf-8"))
    : fs.readFileSync(path.join(SRC, f), "utf-8");
const SKILL_NAME = "m5claude-inbound-router";
const SRC = path.join(ROOT, "skills", SKILL_NAME);
const DEFAULT_SKILLS_ROOT = path.join(os.homedir(), ".claude", "skills");

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const uninstall = process.argv.includes("--uninstall");

const skillsRoot = arg("dir") ?? DEFAULT_SKILLS_ROOT;
const DST = path.join(skillsRoot, SKILL_NAME);

const problems = [];
const notes = [];

// ---------- 装之前先验源 ----------

const MANIFEST = "aily-cli-skill.json";
const files = ["SKILL.md", MANIFEST];

for (const f of files) {
  if (!fs.existsSync(path.join(SRC, f))) problems.push("源文件缺失：" + path.join(SRC, f));
}

let manifest = null;
if (problems.length === 0) {
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(SRC, MANIFEST), "utf-8"));
  } catch (err) {
    problems.push(MANIFEST + " 不是合法 JSON：" + err.message);
  }
}

// manifest 指向的入口必须真的存在。指错了就是那种「文件都在却不工作」的失败。
if (manifest) {
  const entry = manifest?.agentLite?.entry;
  if (!entry) problems.push(MANIFEST + " 里没有 agentLite.entry");
  else if (!fs.existsSync(path.join(SRC, entry))) problems.push("manifest 的入口指向不存在的文件：" + entry);
}

/**
 * 技能被发现、被调用都不会失败，失败发生在**执行那一步**，而回执只会说「系统错误」。
 * 所以装之前就要确认它引用的脚本确实存在。
 *
 * 渲染之后再校验：源码里是 `{{BRIDGE_ROOT}}` 占位符，渲染后是 runtime 下的绝对路径。
 * 校验对象必须是**将要装进去的那份文本**，不是源码 —— 否则校验的和运行的不是同一件东西。
 */
if (apply) {
  // 光有脚本文件还不够：runtime 必须整体自校验通过，否则 current 可能指向一个
  // 半成品版本，技能装上去执行的是谁都说不清。
  const runtime = verifyRuntime();
  if (!runtime.ok) {
    problems.push("runtime 未就绪（" + (runtime.reason ??
      ("链接" + (runtime.linkOk ? "ok" : "错") + "，缺失 " + runtime.missing.length +
       "，漂移 " + runtime.drifted.length)) + "）：先跑 install-outbound.mjs --apply");
  }
}

if (problems.length === 0) {
  const body = expectedContent("SKILL.md");
  // 渲染后不该再剩任何占位符。这一条只看有没有 `{{`，不猜里面是什么。
  if (/\{\{/u.test(body)) problems.push("SKILL.md 里还有没渲染的占位符");

  // **不从渲染后的 shell 文本里反解析路径。**
  //
  // 上一版用 /(\/[\w./-]*\/scripts\/…)/ 去猜绝对路径。加了 shell 引号之后这个正则
  // 依然"能匹配"，但 HOME 含空格时它只截得到后半截，于是拿一个根本不存在的伪路径
  // 去判存在性、把安装拒掉。Codex 用临时 HOME「我的 家」实测复现：runtime 装好了，
  // install-inbound --apply 却 exit 1，报一个从没出现过的路径不存在。
  //
  // 正确做法是问模板"你声明了哪些脚本"，而不是问渲染产物"你看起来像什么路径"。
  // 声明是受控的（{{SCRIPT:name}}），路径由我们自己拼，不经过 shell 文本这一层。
  const declared = [...fs.readFileSync(path.join(SRC, "SKILL.md"), "utf-8")
    .matchAll(/\{\{SCRIPT:([A-Za-z0-9_./-]+)\}\}/gu)].map((m) => m[1]);
  if (declared.length === 0) problems.push("SKILL.md 里找不到要执行的脚本路径");
  for (const name of new Set(declared)) {
    const p = path.join(RUNTIME_BRIDGE_ROOT, "scripts", name);
    // runtime 下的脚本要等出站安装器把代码同步过去才存在。
    if (fs.existsSync(p)) continue;
    if (!apply) {
      // dry-run 阶段只提示：此刻 runtime 还没同步是完全正常的，不该因此看不到计划。
      notes.push("引用的 runtime 脚本尚未同步（先跑 install-outbound.mjs --apply）：" + p);
    } else {
      // **--apply 必须 fail-closed。**装一个指向不存在脚本的技能，比不装坏得多：
      // 它会照常被发现、照常被调用，然后在执行那一步失败，而回执只会说「系统错误」。
      problems.push("SKILL.md 引用了不存在的脚本：" + p +
        "（先跑 install-outbound.mjs --apply 把 runtime 同步好）");
    }
  }
}

// ---------- 验目标 ----------

if (!uninstall) {
  if (!fs.existsSync(skillsRoot)) {
    problems.push("技能根目录不存在：" + skillsRoot + "（用 --dir 指定别处）");
  } else {
    // 必须是真实目录。aily 那边扫描时 readdir 不跟随符号链接 ——
    // 装成软链会得到一个「看着装好了、实际不被发现」的状态。
    const st = fs.lstatSync(DST, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) problems.push("目标是符号链接，必须是真实目录：" + DST);
    else if (st && !st.isDirectory()) problems.push("目标存在但不是目录：" + DST);
  }
}

// ---------- 算改动 ----------

const changes = [];
for (const f of files) {
  const dstFile = path.join(DST, f);
  if (uninstall) {
    if (fs.existsSync(dstFile)) changes.push([f, "remove"]);
    continue;
  }
  let cur = null;
  try { cur = fs.readFileSync(dstFile, "utf-8"); } catch { /* 还没装 */ }
  const src = expectedContent(f);
  if (cur === null) changes.push([f, "install"]);
  else if (cur !== src) changes.push([f, "update"]);
}

// ---------- 报告 ----------

console.log("源      " + SRC);
console.log("目标    " + DST);
for (const [f, act] of changes) console.log("  " + act.padEnd(8) + f);
if (changes.length === 0) console.log("  （内容一致，无需改动）");
for (const n of notes) console.log("注意    " + n);

if (problems.length > 0) {
  console.error("\n装不了：");
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
  process.exit(0);
}

// ---------- 落盘 ----------

if (uninstall) {
  fs.rmSync(DST, { recursive: true, force: true });
  console.log("\n已卸载 " + DST);
  process.exit(0);
}

fs.mkdirSync(DST, { recursive: true });
for (const f of files) fs.writeFileSync(path.join(DST, f), expectedContent(f), { mode: 0o600 });
{
  // 机器级安装收据（维护门 PR B）：入站技能也是线上制品，按 path 合并进 claude 链的收据
  const installedVersion = verifyRuntime().version ?? null;
  const artifacts = files.map((f) => ({ path: path.join(DST, f), kind: "skill", sha256: artifactSha({ kind: "skill", text: expectedContent(f) }) }));
  const scripts = referencedRuntimeScripts(files.map((f) => expectedContent(f)).join("\n"));
  const receipt = installedVersion ? recordInstalledSurface({ chain: "claude", version: installedVersion, artifacts, scripts, file: installedSurfacePath({ chain: "claude", home: os.homedir() }) }) : { ok: false, reason: "runtime_version_unknown" };
  const report = receiptReport(receipt, { artifacts: artifacts.length, scripts: scripts.length });
  console.log("安装收据：" + report.text);
  if (report.failed) process.exitCode = 1;
}

// ---------- 装完自检 ----------

console.log("\n已写入。自检：");
for (const f of files) {
  const same = expectedContent(f) === fs.readFileSync(path.join(DST, f), "utf-8");
  console.log("  " + (same ? "✓" : "✗") + " " + f + (same ? " 与预期一致" : " 写入后内容不一致"));
}
console.log("  ✓ 目标是真实目录（不是软链）");

/**
 * 最后这一项是**验不了的那一项**，必须如实说。
 * scan-local 报不到本技能是已知的（它扫宿主 agent 目录），所以它报不到
 * 既不能证明装坏了，也不能证明装好了 —— 唯一的验证是真的从飞书发一条指令。
 */
let scanned = null;
try {
  const out = execFileSync("aily-cli", ["skill", "scan-local", "--json"],
    { encoding: "utf-8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  scanned = out.includes(SKILL_NAME);
} catch {
  scanned = null;
}
console.log("  · aily 是否已发现本技能：" +
  (scanned === true ? "scan-local 报到了"
    : scanned === false ? "scan-local 报不到（已知如此 —— 它扫的是宿主 agent 目录，不扫这里）"
      : "查不了（aily-cli 没跑起来）"));

console.log("\n**装好 ≠ 能用。**唯一的验证是从飞书发一条指令（@ 运输智能体），看回执。");
