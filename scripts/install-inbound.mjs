#!/usr/bin/env node
/**
 * 把入站技能装到 aily 的捆绑技能目录。
 *
 * 出站早就有安装器了，入站一直靠手工拷贝 —— 这个不对称的代价是：换台机器照仓库重建，
 * 你会得到一个「文件都在、内容都对、就是不工作」的状态，而这类失败最难查。
 *
 * 关于「装完了它就能被发现吗」这件事，本安装器**不做保证，也不假装做保证**：
 *
 *   已知（2026-08-19 实测）：/Users/dk/skills/m5claude-inbound-router/ 下那两个文件
 *                            确实能工作，M5Claude 当天成功执行过十余次。
 *   未知：M5Claude 究竟经由什么路径发现它。`aily-cli skill scan-local` 扫的是宿主 agent
 *         的技能目录（~/.claude/skills、~/.codex/skills），**看不到这一个**；
 *         它也不在 ~/.claude/skills 里；agent 工作目录里没有指向它的软链。
 *
 * 于是安装器只做两件诚实的事：复现那个已知可用的状态，以及把每一项能验的都验掉。
 * 验不了的那项会在输出里明说，不会被含糊成一句「安装成功」。
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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SKILL_NAME = "m5claude-inbound-router";
const SRC = path.join(ROOT, "skills", SKILL_NAME);
const DEFAULT_SKILLS_ROOT = path.join(os.homedir(), "skills");

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
 * SKILL.md 里写的是脚本的**绝对路径**。仓库一旦被移动，技能会照常被发现、
 * 照常被调用，然后在执行那一步失败 —— 而回执只会说「系统错误」。
 * 装之前就该发现这件事。
 */
if (problems.length === 0) {
  const body = fs.readFileSync(path.join(SRC, "SKILL.md"), "utf-8");
  const referenced = [...body.matchAll(/(\/[\w./-]*\/scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
  for (const p of new Set(referenced)) {
    if (!fs.existsSync(p)) problems.push("SKILL.md 引用了不存在的脚本：" + p);
    else if (!p.startsWith(ROOT + "/")) notes.push("SKILL.md 引用的脚本不在本仓库内：" + p);
  }
  if (referenced.length === 0) problems.push("SKILL.md 里找不到要执行的脚本路径");
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
  const src = fs.readFileSync(path.join(SRC, f), "utf-8");
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
for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(DST, f));

// ---------- 装完自检 ----------

console.log("\n已写入。自检：");
for (const f of files) {
  const same = fs.readFileSync(path.join(SRC, f), "utf-8") === fs.readFileSync(path.join(DST, f), "utf-8");
  console.log("  " + (same ? "✓" : "✗") + " " + f + (same ? " 与仓库一致" : " 写入后内容不一致"));
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
