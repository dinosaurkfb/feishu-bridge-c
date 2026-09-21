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

import { gitBlobHash, runtimeScript, sourceCommit, verifyRuntime } from "./runtime-install.mjs";
import { referencedRuntimeScripts, renderClaudeSkill } from "./install-projection.mjs";
import { artifactSha, installedSurfacePath, receiptReport, recordInstalledSurface } from "./installed-surface.mjs";
import { gateBlocks } from "./maintenance-gate-core.mjs";
import { holdInstallSurfaceLockOrExit } from "./install-surface-lock.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";
import { expectCommitVerdict, sourceCommitLine } from "./expect-commit.mjs";

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

const SKILL_NAME = "m5claude-inbound-router";
const SRC = path.join(ROOT, "skills", SKILL_NAME);
const DEFAULT_SKILLS_ROOT = path.join(os.homedir(), ".claude", "skills");

/** 技能源文件的**唯一一份读**（PK3-I257-fix3）：模块级先声明（expectedContent 是模块级 const，
 *  闭包只看得到模块作用域），CLI 段在跑之前把它填满。import 这个模块（用例 / doctor）不会因此读任何文件。 */
let sourceBytes = new Map();

/**
 * 将要装进去的那份文本 —— **计划、写入、装完自检、收据必须共用它，而且只读一次源**（PK3-I257-fix3）。
 *
 * 上一版只在写入那一步渲染，比较和自检仍拿未渲染的源码去比：装对了也会永远报 update，
 * 自检还会说"写入后内容不一致"。渲染类安装器最容易在这里裂成两套真相，所以只留一个出口。
 * fix3 P1：这个出口现在必须从 `sourceBytes`（那份**只读一次**的 buffer）渲染 —— 不许再碰磁盘，
 * 否则“提交核对过的字节”与“装进去的字节”又是两次读取。
 */
const expectedContent = (f) => {
  const buf = sourceBytes.get(f);
  if (buf === undefined || buf === null) throw new Error("源文件没读进来（该情况已被 problems 拦住）：" + f);
  const text = buf.toString("utf-8");
  return f === "SKILL.md" ? renderSkill(text) : text;
};

/**
 * 探测本身失败的原因（PK3-I241）：**不许**把"命令跑不起来"说成"daemon 没跑"。
 * 输入是 execFile 抛出来的异常，输出一句人话 —— 三类各自点名：找不到命令 / 非零退出 / 超时。
 */
export function probeFailureReason(err) {
  if (err?.code === "ENOENT") {
    return "找不到 aily-cli（ENOENT）—— 非交互 ssh 下 PATH 里常常没有它（mise shims 不在 PATH）";
  }
  if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM") return "探测超时（30 秒）";
  if (typeof err?.status === "number") {
    const tail = String(err.stderr ?? "").trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    return "退出码 " + err.status + (tail ? "：" + tail.slice(0, 160) : "");
  }
  return String(err?.code ?? err?.message ?? err);
}

/**
 * **装完自检的最后两项**（PK3-I241：可导入、单出口）。
 *
 * 为什么要有它：旧版把 `aily-cli skill scan-local` 的任何异常都折成「查不了（aily-cli 没跑起来）」——
 * 2026-09-18 在 omm 上经**非交互 ssh** 装机时 PATH 里没有 mise shims、`aily-cli` 直接 ENOENT，
 * 于是那句话把「探测命令不可用」说成了「daemon 没跑」；同一时刻 daemon 其实是 active 的、桥 doctor 密钥 ✓。
 * **两件事各有各的判据，不能互相代言：**
 *
 *   · socket 状态：看 `~/.aily-cli/sockets/aily-cli.sock` 在不在、是不是 socket（**不经 exec**、不依赖 PATH）——
 *     只陈述路径状态，**不证明 daemon 进程在跑**（崩溃会留下 socket inode）；在不在跑用 doctor 或 aily-cli daemon status；
 *   · 技能有没有被发现：跑 `scan-local`，分**三态** —— 报到了 / 报不到（已知如此）/ **查不了**
 *     （探测本身失败，原因原话带出来；这一态**不许**断言 daemon 的状态）。
 *
 * `execFile` 是**函数参数**（用例注入用）：CLI 调它不传，生产恒 `execFileSync` —— 不读任何
 * "只给测试"的环境变量（Codex 对 U1/L7 都判过：那种钩子生产可达）。
 * @returns {{ socket: string, socketState: "socket"|"not_socket"|"absent"|"unverifiable", socketPresent: boolean, scan: { state: "reported"|"not_reported"|"unavailable", why: string|null } }}
 */
export function inboundPostInstallProbe({ home = os.homedir(), execFile = execFileSync, log = console.log, skillName = SKILL_NAME } = {}) {
  const socket = path.join(home, ".aily-cli", "sockets", "aily-cli.sock");
  // PK3-I241-fix1（Codex 一轮 P1）：socket 文件在 ≠ daemon 在跑（可能是崩溃残留的 inode，也可能只是个同名普通文件）。
  // 这里**只陈述事实**：是不是 socket、在不在；"在不在跑"要么真连一次 socket、要么问受验的 manager —— 那是 doctor 的事。
  // PK3-I241-fix2（Codex 二轮 P1）：**只有 ENOENT 才是"不在"**。ENOTDIR（sockets 是个普通文件）、EACCES 等是
  // "查不清"—— 折成"不在"就会劝人去启动一个可能正在跑的 daemon。
  let socketState = "absent";   // "socket" | "not_socket" | "absent" | "unverifiable"
  let socketWhy = null;
  try { socketState = fs.lstatSync(socket).isSocket() ? "socket" : "not_socket"; }
  catch (err) {
    if (err?.code === "ENOENT") socketState = "absent";
    else { socketState = "unverifiable"; socketWhy = String(err?.code ?? err?.message ?? err); }
  }
  log("  · aily daemon socket：" + (socketState === "socket"
    ? "在（" + socket + "）—— 存在不证明进程还活着；要确认在不在跑：node scripts/doctor.mjs（systemd 判据）或 aily-cli daemon status"
    : socketState === "not_socket"
      ? "同名文件在但不是 socket（" + socket + "）—— 多半是残留，不当作在跑"
      : socketState === "unverifiable"
        ? "查不清（" + socketWhy + "：" + socket + "）—— 不等于不在；确认用 node scripts/doctor.mjs 或 aily-cli daemon status"
        : "不在（" + socket + "）—— 启动：aily-cli daemon start"));

  let scan;
  try {
    const out = execFile("aily-cli", ["skill", "scan-local", "--json"],
      { encoding: "utf-8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    scan = { state: String(out).includes(skillName) ? "reported" : "not_reported", why: null };
  } catch (err) {
    scan = { state: "unavailable", why: probeFailureReason(err) };
  }
  /**
   * 最后这一项是**验不了的那一项**，必须如实说。
   * scan-local 报不到本技能是已知的（它扫宿主 agent 目录），所以它报不到
   * 既不能证明装坏了，也不能证明装好了 —— 唯一的验证是真的从飞书发一条指令。
   */
  log("  · aily 是否已发现本技能：" + (
    scan.state === "reported" ? "scan-local 报到了"
      : scan.state === "not_reported" ? "scan-local 报不到（已知如此 —— 它扫的是宿主 agent 目录，不扫这里）"
        : "查不了：" + scan.why + "（**这是探测本身的问题，不是 daemon 的状态** —— 上面那一行只报 socket 状态）"));
  return { socket, socketState, socketWhy, socketPresent: socketState === "socket", scan };
}

if (!isDirectRun(import.meta.url)) {
  // 被 import 时只提供上面那个纯函数（+ 原因映射），不跑安装、不碰任何文件。
} else {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const uninstall = process.argv.includes("--uninstall");

// ---------- 装之前先验源 ----------
//
// **每个源文件只读一次**（PK3-I257-fix3 P1）：读进内存 → 在这份 buffer 上算 git blob（提交核对）
// → 就用它渲染/落盘/自检/记收据。旧版 `expectedContent` 每次调用都重读一遍源文件（计划、对比、
// 写入、收据、自检共五次），于是“核对的字节”与“装进去的字节”是两次读取，中间有窗口。
// 源文件不在 → 记 null（下面照旧报“源文件缺失”，而 inventory 少一项也就会被提交核对点名“少了”）。
const MANIFEST = "aily-cli-skill.json";
const files = ["SKILL.md", MANIFEST];
for (const f of files) {
  try { sourceBytes.set(f, fs.readFileSync(path.join(SRC, f))); }
  catch { sourceBytes.set(f, null); }
}

// ---------- 「我打算装哪个提交」的闸（PK3-I257）—— 与另两个安装器同一份判据，放在**任何写盘之前**
// （技能 / 收据 / 安装面锁都算）。判据吃的是**上面那份只读一次的 buffer**（fix3 P1）；
// 卸载路径不拷任何源文件 → 只核 HEAD 那半条。
const sourceInventory = uninstall ? null : files
  .filter((f) => sourceBytes.get(f) !== null)
  .map((f) => ({ path: path.relative(ROOT, path.join(SRC, f)), blob: gitBlobHash(sourceBytes.get(f)) }));
const GATE = expectCommitVerdict({ argv: process.argv.slice(2), sourceRoot: ROOT, inventory: sourceInventory,
  // 入站只拷自己那一个技能目录下的文件 —— 不告诉核对这一条，它会把整仓的 runtime 文件说成"少了"。
  scope: [path.relative(ROOT, SRC)] });
if (GATE.kind === "bad_argv" || (apply && GATE.refusal !== null)) {
  console.error(GATE.refusal);
  process.exit(2);
}
if (GATE.line !== null) console.log(GATE.line);

const skillsRoot = arg("dir") ?? DEFAULT_SKILLS_ROOT;
const DST = path.join(skillsRoot, SKILL_NAME);

const problems = [];
const notes = [];

for (const f of files) {
  if (sourceBytes.get(f) === null) problems.push("源文件缺失：" + path.join(SRC, f));
}

let manifest = null;
if (problems.length === 0) {
  try {
    manifest = JSON.parse(sourceBytes.get(MANIFEST).toString("utf-8"));
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
  const declared = [...sourceBytes.get("SKILL.md").toString("utf-8")
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
    // **不存在 = 正常首次安装，不是"装不了"**（issue #254 同一类判据）：全新机器上
    // `~/.claude/skills` 还没被建（Claude Code / aily 都没跑过）—— 而落盘那一步的
    // `mkdirSync(DST, { recursive: true })` 本来就会把技能根一并建出来。
    // 旧版把它当故障 exit 1，于是全新机器上**预览**（安装文档里的第一步）就跑不过去：
    // `node scripts/install-inbound.mjs` → 「装不了：技能根目录不存在」，退 1。
    // 不静默略过：写进计划（notes 会打成「注意」一行）。
    notes.push("技能根目录不存在，将新建：" + skillsRoot);
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

// 安装面锁 + 维护门（issue #81）：先取安装面锁（与维护流程共用一把，持有到本进程退出），**再**看门 ——
// 门检是瞬时的，锁才是原子准入（评审探针：过检后门才建立，安装器照写不误）。
// 放在 problems 之前：维护窗口里 runtime 指着桩，"runtime 未就绪"只是门的副作用，权威的答案是"维护中"。
if (apply) {
  holdInstallSurfaceLockOrExit();
  const g = gateBlocks();
  if (g.blocked) { console.error("维护门：" + g.text + " —— 安装被拒，什么都没写。"); process.exit(2); }
}

if (problems.length > 0) {
  console.error("\n装不了：");
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
  // PK3-I257：预览不写盘，所以它不「拒绝」而是**报告** —— 计划已打完（含上面那行结论），但核对不通过
  // 必须反映在退出码上。
  process.exit(GATE.ok ? 0 : 2);
}

// ---------- 落盘 ----------

if (uninstall) {
  fs.rmSync(DST, { recursive: true, force: true });
  console.log("\n已卸载 " + DST);
  process.exit(0);
}

fs.mkdirSync(DST, { recursive: true });
for (const f of files) fs.writeFileSync(path.join(DST, f), expectedContent(f), { mode: 0o600 });
const installedVersion = verifyRuntime().version ?? null;
{
  // 机器级安装收据（维护门 PR B）：入站技能也是线上制品，按 path 合并进 claude 链的收据
  const artifacts = files.map((f) => ({ path: path.join(DST, f), kind: "skill", sha256: artifactSha({ kind: "skill", text: expectedContent(f) }) }));
  const scripts = referencedRuntimeScripts(files.map((f) => expectedContent(f)).join("\n"));
  const receipt = installedVersion ? recordInstalledSurface({ chain: "claude", version: installedVersion, artifacts, scripts, file: installedSurfacePath({ chain: "claude", home: os.homedir() }) }) : { ok: false, reason: "runtime_version_unknown" };
  const report = receiptReport(receipt, { artifacts: artifacts.length, scripts: scripts.length });
  console.log("安装收据：" + report.text);
  if (report.failed) process.exitCode = 1;
}

// ---------- 装完自检 ----------

console.log("\n已写入。自检：");
// PK3-I257 第 2 条：结语头一行写清「装的是哪个提交」（与另两个安装器同一句话）。
console.log(sourceCommitLine({ commit: sourceCommit(ROOT), version: installedVersion }));
for (const f of files) {
  const same = expectedContent(f) === fs.readFileSync(path.join(DST, f), "utf-8");
  console.log("  " + (same ? "✓" : "✗") + " " + f + (same ? " 与预期一致" : " 写入后内容不一致"));
}
console.log("  ✓ 目标是真实目录（不是软链）");

// 最后两项**各有各的判据**（PK3-I241）：socket 那一行只报 socket 状态（不经 exec，不证明进程在跑），
// 「是否已发现本技能」三态分开 —— 探测本身失败只说自己失败，不代言 daemon 的状态。
inboundPostInstallProbe({ home: os.homedir() });

console.log("\n**装好 ≠ 能用。**唯一的验证是从飞书发一条指令（@ 运输智能体），看回执。");
}
