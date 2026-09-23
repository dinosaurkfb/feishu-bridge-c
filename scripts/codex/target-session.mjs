/**
 * 目标会话（Codex target session）：一次投递的收件人。
 *
 * 契约见 docs/implementation/codex-target-session-contract.md，决定见 docs/adr/0001-codex-home-default-only.md。
 *
 * **这里是唯一回答这四个问题的地方**：哪个 thread、哪本账簿（codex home）、哪个 codex 程序、什么子进程环境。
 * 它们此前在 bind-task / inbound / handoff / run-resume 四处各答一次 —— #266 五轮评审的四个 P1
 * （临时别名、桥根与账簿脱钩、符号链接后接 `..` 的词法/实际落点错位、报错外泄本机路径）
 * 不是四个独立缺陷，是同一个形状的四个投影。
 *
 * 投递发生在 Aily **运输会话**的回合里，`process.env` 装着那个回合的整套现场：
 *   - `CODEX_HOME` 指向它自己的临时账簿（`~/.aily-cli/session/<id>/…/codex-homes/<hash>`，回合结束即删）；
 *   - `PATH` 里是它的 arg0 临时目录（`…/tmp/arg0/codex-arg0XXXX`，同样回合结束即删），**排在稳定 codex 前面**；
 *   - `CODEX_THREAD_ID` / `CODEX_SESSION_ID` / `CODEX_CI` / `CODEX_SANDBOX*` 描述的是运输会话，不是被续接的 thread；
 *   - `HOME` 也可以被改写 —— 所以家目录取 passwd 记录，不取 `$HOME`。
 * 2026-09-22 omm 实测：续接的 thread 每条命令都报
 * `Failed to create unified exec process: No such file or directory`，现场正是上面这些。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 拒绝原因的**稳定枚举**：序列化值逐字钉死，回执 / 本机日志 / 调用方共用这些字符串，不各自解释。
 * 将来的「目标正被别的进程占用」在这里加一枚（如 `target_busy`），判法加在 rollout 核实之后、程序解析之前。
 */
export const REFUSE = Object.freeze({
  THREAD_SHAPE: "thread_shape",
  HOME_MISSING: "home_missing",
  HOME_TRANSIENT: "home_transient",
  ROLLOUT_MISSING: "rollout_missing",
  BIN_MISSING: "bin_missing",
  BIN_TRANSIENT: "bin_transient",
  BIN_NOT_EXECUTABLE: "bin_not_executable",
});

/** 对外只给封闭文案（可进飞书）；路径与 thread 号只进 `message`（本机 claim / 日志）。 */
export class CodexTargetRefusal extends Error {
  constructor(code, publicText, detail) {
    super(detail ? publicText + "：" + detail : publicText);
    this.code = code;
    this.publicText = publicText;
  }
}

const PUBLIC_TARGET_UNKNOWN = "说不清目标 Codex 会话，未投递（详情见本机日志）";
const PUBLIC_CODEX_MISSING = "本机找不到可用的 codex 程序，未投递";

const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const posixPath = (p) => String(p).replaceAll("\\", "/");
const underAilySession = (p) => /\/\.aily-cli\/session\//u.test(posixPath(p) + "/");
const isCodexArg0Dir = (segment) => /\/tmp\/arg0\/codex-arg0[^/]*\/?$/u.test(posixPath(segment));

/**
 * 实际落点：`realpath(3)`（`fs.realpathSync.native`）。
 * **不能用 JS 版 `fs.realpathSync`** —— 它先按字面 `path.resolve` 化简 `..`，
 * 于是「符号链接后接 `..`」的判定结果与实际打开的位置不是同一个地方（#266 二轮 P1，已实测两者不同）。
 */
const actualPath = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

const CALLER_CODEX_VARS = /^CODEX_(THREAD_ID|SESSION_ID|CI|SANDBOX(_[A-Z0-9_]+)?)$/u;

/**
 * **唯一的一份清洗实现**：程序解析（resolveCodexTarget 第 5 步）与最终子进程环境（codexRunEnv）都用它。
 * 两处不同源就会复活 #266 的「预检通过、实际启动失败」；而在**未清洗**的 PATH 上找程序更糟 ——
 * arg0 临时目录排在前面，会先命中临时程序并被判 `bin_transient`，**所有入站投递失灵**。
 */
const cleanEnv = (env) => {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("AILY_CLI_")) continue;
    if (CALLER_CODEX_VARS.test(name)) continue;
    if (name === "CODEX_HOME") continue;            // 账簿只由本 module 定（ADR-0001），调用方给的一律丢掉
    clean[name] = value;
  }
  if (typeof clean.PATH === "string") {
    clean.PATH = clean.PATH.split(path.delimiter).filter((seg) => !isCodexArg0Dir(seg)).join(path.delimiter);
  }
  return clean;
};

const ROLLOUT_ROOTS = ["sessions", "archived_sessions"];
const holdsRollout = (dir, suffix, depth = 0) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)) return true;
  }
  if (depth >= 3) return false;                      // sessions/YYYY/MM/DD/rollout-…
  return entries.some((e) => e.isDirectory() && holdsRollout(path.join(dir, e.name), suffix, depth + 1));
};

const resolveBin = (codexBin, cleaned) => {
  if (codexBin.includes("/")) return codexBin;
  try {
    return execFileSync("/bin/sh", ["-c", 'command -v -- "$1"', "sh", codexBin],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: cleaned }).trim();
  } catch {
    return null;
  }
};

/**
 * 核实并定下目标会话。**绑定时与投递前各调一次，禁止第三处自行判断。**
 *
 * `userHome` 默认 passwd 记录里的家目录：`os.homedir()` 跟随 `process.env.HOME`，而运输会话能改写它 ——
 * 只停止信任 `CODEX_HOME`、却让调用方环境决定 `$HOME/.codex`，账簿仍没脱离运输现场（已实测两者差异）。
 * **不提供任何切换账簿的命令行参数**：真入口会把 argv 原样转交 handler，"只有测试才传" 在生产同样可达。
 * 测试注入走本形参（单元层）或测试专用启动注入（端到端层），产品代码里不存在对应分支。
 */
export function resolveCodexTarget({ threadId, userHome = os.userInfo().homedir, env = process.env, codexBin = "codex" } = {}) {
  if (typeof threadId !== "string" || !THREAD_UUID.test(threadId)) {
    throw new CodexTargetRefusal(REFUSE.THREAD_SHAPE, PUBLIC_TARGET_UNKNOWN,
      "codex_thread_id 不是精确 UUID（拒绝使用名字或 --last）：" + JSON.stringify(threadId));
  }
  // **先把家目录解析成实际落点，再拼 `.codex`**：`path.join` 会先按字面化简 `..`，
  //   那样「符号链接后接 `..`」的判定又会落到字面位置，而不是真正打开的位置（#266 二轮 P1 的同一个坑）。
  const homeReal = actualPath(userHome);
  if (homeReal === null) {
    throw new CodexTargetRefusal(REFUSE.HOME_MISSING, PUBLIC_TARGET_UNKNOWN, "家目录不存在 " + userHome);
  }
  const rawHome = path.join(homeReal, ".codex");
  const codexHome = actualPath(rawHome);
  if (codexHome === null) {
    throw new CodexTargetRefusal(REFUSE.HOME_MISSING, PUBLIC_TARGET_UNKNOWN, "codex home 不存在 " + rawHome);
  }
  if (underAilySession(codexHome)) {
    throw new CodexTargetRefusal(REFUSE.HOME_TRANSIENT, PUBLIC_TARGET_UNKNOWN,
      "codex home 实际落在运输会话临时目录 " + codexHome);
  }
  const suffix = "-" + threadId.toLowerCase() + ".jsonl";
  if (!ROLLOUT_ROOTS.some((root) => holdsRollout(path.join(codexHome, root), suffix))) {
    throw new CodexTargetRefusal(REFUSE.ROLLOUT_MISSING, PUBLIC_TARGET_UNKNOWN,
      codexHome + " 下没有 thread " + threadId + " 的会话记录");
  }
  // 与 codexRunEnv 同源的清洗结果上解析程序（契约：预检与启动同源）。
  const found = resolveBin(codexBin, cleanEnv(env));
  if (found === null || !path.isAbsolute(found)) {
    throw new CodexTargetRefusal(REFUSE.BIN_MISSING, PUBLIC_CODEX_MISSING,
      "codex 不在清洗后的 PATH 上，或不是程序文件：" + JSON.stringify(found ?? codexBin));
  }
  const realBin = actualPath(found);
  if (realBin === null) {
    throw new CodexTargetRefusal(REFUSE.BIN_MISSING, PUBLIC_CODEX_MISSING, "codex 路径不存在 " + found);
  }
  for (const where of [found, realBin]) {
    if (isCodexArg0Dir(path.dirname(where)) || underAilySession(where)) {
      throw new CodexTargetRefusal(REFUSE.BIN_TRANSIENT, PUBLIC_CODEX_MISSING,
        "codex 落在运输回合的临时目录 " + where);
    }
  }
  try { fs.accessSync(realBin, fs.constants.X_OK); } catch {
    throw new CodexTargetRefusal(REFUSE.BIN_NOT_EXECUTABLE, PUBLIC_CODEX_MISSING, "codex 不可执行 " + found);
  }
  return { threadId, codexHome, codexBin: realBin };
}

/**
 * 目标现场：从**同一份源环境**清洗出交给 codex 的子进程环境，并钉死 `CODEX_HOME` = 核实过的账簿。
 * `env` 显式收，不隐式读 `process.env` —— 否则解析与启动可以悄悄用两份不同的环境。
 */
export function codexRunEnv(target, { env = process.env, claimKey, taskKey, bridgeHome } = {}) {
  if (!target || typeof target.codexHome !== "string" || !target.codexHome) {
    throw new Error("codexRunEnv 需要 resolveCodexTarget 的返回值");
  }
  return {
    ...cleanEnv(env),
    FEISHU_BRIDGE_ROLE: "codex-run",
    ...(claimKey ? { FEISHU_BRIDGE_CLAIM_KEY: claimKey } : {}),
    ...(taskKey ? { FEISHU_BRIDGE_TASK_KEY: taskKey } : {}),
    ...(bridgeHome ? { FEISHU_CODEX_BRIDGE_HOME: bridgeHome } : {}),
    CODEX_HOME: target.codexHome,
  };
}

/**
 * 真入口的守卫：**不接受任何指定账簿的参数**（ADR-0001）。
 * `aily-inbound.mjs` 把自身 argv 原样转交 handler，所以"生产不传"只是约定 —— 见到就拒，不静默忽略。
 */
export function assertNoUserHomeOverride(argv = process.argv.slice(2)) {
  const at = argv.findIndex((a) => a === "--user-home" || a.startsWith("--user-home="));
  if (at >= 0) {
    throw new CodexTargetRefusal(REFUSE.HOME_TRANSIENT, PUBLIC_TARGET_UNKNOWN,
      "不接受 --user-home：账簿只认 passwd 家目录下的 .codex（ADR-0001）");
  }
}
