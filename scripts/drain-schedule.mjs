/**
 * Claude 侧兜底定时器的身份与期望形状 —— **只有这一份定义**。
 * 启动源按平台（PK3-L1）：darwin launchd / linux systemd --user / 其它平台没有实现；
 * 维护门（issue #81）目前只覆盖 launchd，systemd 未支持（详情见 docs/architecture/maintenance-gate.md）。
 * 安装器写 plist 用它，doctor 查 launchd 核 ProgramArguments 也用它；各写一份就会漂
 * （评审探针：同名 job 实际跑 /bin/echo，只看 label 存在就被说成"积压有人发"）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeScript } from "./runtime-install.mjs";

export const CLAUDE_DRAIN_LAUNCH_LABEL = "com.frank.feishu-bridge-cc.drain";

/**
 * 钩子和定时器的环境不保证继承交互 shell 的 PATH，所以 node 要写绝对路径。
 * 但**不能**写 process.execPath —— 它是 realpath 过的，带版本号（brew 升一次 node 就没了，
 * 而钩子的失败又是安静的）。优先取 brew 那个不带版本的稳定软链。
 */
/**
 * 给 hooks / 定时器解析 node 的**唯一**入口（PK3-L1）。
 *
 * 顺序：env.FEISHU_BRIDGE_NODE → PATH 逐段找 node → /opt/homebrew/bin/node → /usr/local/bin/node
 *       → ~/.local/bin/node；都没有 → 抛（把找过的路径全列出来）。
 *
 * **不用 process.execPath**：Stop 钩子契约里写着 Claude Code 自带的那个 node 不能当外部路径用
 * （钩子是 Claude Code 派生出来的，它的 node 不保证在别处可用）。
 * PATH 优先也是为了 mise/nvm 这类版本管理器：拿到的是 shim（切版本后 shim 路径不变，真身会变）。
 * 显式指定但不存在 → 直接抛（不静默换成别的二进制）。
 */
export function resolveNodeForHooks({
  env = process.env, exists = fs.existsSync,
  access = (candidate) => fs.accessSync(candidate, fs.constants.X_OK),
  homedir = os.homedir(), installed = null, platform = process.platform,
} = {}) {
  const tried = [];
  // 候选一律**绝对路径 + X_OK**：只 existsSync 会把目录、坏权限、相对路径（相对于 cwd，钩子跑在别的 cwd 上
  // 就换了一个文件）都算“找到了”。access 可注入（测试不必造真文件）。
  const usable = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    if (!path.isAbsolute(candidate)) { tried.push(candidate + "（不是绝对路径）"); return false; }
    if (!exists(candidate)) { tried.push(candidate); return false; }
    try { access(candidate); return true; } catch { tried.push(candidate + "（不可执行）"); return false; }
  };
  const explicit = env?.FEISHU_BRIDGE_NODE;
  if (typeof explicit === "string" && explicit.length > 0) {
    if (usable(explicit)) return explicit;
    throw new Error("FEISHU_BRIDGE_NODE 指的路径不可用（要绝对路径且可执行）：" + explicit);
  }
  const fromPath = () => {
    const out = [];
    for (const dir of String(env?.PATH ?? "").split(path.delimiter)) {
      if (dir === "" || !path.isAbsolute(dir)) continue;   // 相对段 / 空段（= cwd）不产生候选
      out.push(path.join(dir, "node"));
    }
    return out;
  };
  // 顺序（PK3-L1-fix1 P1-1）：显式 → **仍有效的已安装路径** → 平台惯用位置 → PATH → ~/.local/bin。
  // 为什么 installed 排在 PATH 前面：Mac 现网 PATH 先命中 ~/.local/bin/node（第三方装的），
  //   而三条已安装 hook 用的是 /opt/homebrew/bin/node —— 按 PATH 优先会**改写现网**，还会让
  //   doctor / 维护预检把原本正确的 job 报成“参数不符”。linux 才让 PATH shim 优先（mise 切版本后 shim 不变）。
  const candidates = [];
  if (typeof installed === "string" && installed.length > 0) candidates.push(installed);
  if (platform === "linux") {
    candidates.push(...fromPath(), "/usr/local/bin/node", path.join(homedir, ".local", "bin", "node"));
  } else {
    candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", ...fromPath(),
      path.join(homedir, ".local", "bin", "node"));
  }
  for (const candidate of candidates) if (usable(candidate)) return candidate;
  throw new Error("找不到 node（hooks / 兜底定时器都要一个绝对路径），找过：\n  " + tried.join("\n  "));
}

/** 兼容别名：安装器 / doctor 一直叫它 pickClaudeNode。 */
export function pickClaudeNode(opts = {}) {
  return resolveNodeForHooks(opts);
}

// ── 「现有安装里那个 node」的读取（PK3-L1-fix2 P1-1）──────────────────────────────────────
// 我们生成的 hook 命令里 node 出现在 guard 的第一段：`[ -x '<node>' ] && [ -r '<script>' ]`。
const HOOK_GUARD = /\[ -x '([^']+)' \]/u;

/** plist 的 ProgramArguments 首项（没有这一段 → null）。 */
function plistFirstArg(text) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(String(text ?? ""));
  if (block === null) return null;
  const first = /<string>([^<]*)<\/string>/u.exec(block[1]);
  return first === null ? null : first[1];
}

/** systemd 单元里 ExecStart 的首段：裸词，或我们写的引用形式（JSON 字符串）。引号没闭合 → null。 */
function unitFirstArg(text) {
  const line = /^ExecStart=(.*)$/mu.exec(String(text ?? ""));
  if (line === null) return null;
  const value = line[1].trim();
  if (!value.startsWith('"')) return value.split(/\s+/u)[0] || null;
  let out = "";
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\") { const next = value[i + 1]; if (next === undefined) return null; out += next === "n" ? "\n" : next; i += 1; continue; }
    if (ch === '"') return out;
    out += ch;
  }
  return null;
}

/**
 * 「现有安装里那个 node」—— 生产入口接线的**纯函数**（PK3-L1-fix2 P1-1）。
 *
 * 为什么需要它：`resolveNodeForHooks` 的 `installed` 参数 fix1 就加了，但**没有生产调用方传**——
 * 本机重装保持 /opt/homebrew/bin/node 只是 Darwin 固定顺序碰巧命中。在「偏好顺序变了」的机器上
 * （先装 /usr/local/bin/node、后来才有 homebrew；或者 PATH 里的 node 换地方了），重装会把线上
 * hook / 定时器仍在用的那个 node **换掉**，而它们原本都还能跑。
 *
 * 来源按优先级：
 *   ① `receipt`：安装收据。**收据本身不记 node** —— 它的字段集是封闭的（artifacts / at / scripts / version），
 *      加字段会让已经写下的老收据变成「形状不对」，安装器从此拒绝覆盖它。所以这一层给的是另一层判据：
 *      收据里**没有 claude 链** = 线上那两个制品不是本桥装的，不许从它们的命令里认 node。
 *      收据缺席（更早的安装、收据还没引入）时，只凭制品自身的归属标记认。
 *   ② `settingsHooks`：settings.json 里**我们自己的** hook 命令，取 guard 里那一段。
 *   ③ `timerExec`：现有 plist 的 ProgramArguments 首项 / systemd 单元的 ExecStart 首段。
 *
 * 只判形状（绝对路径）；**能不能执行交给 `resolveNodeForHooks` 的 X_OK 那一关**——这里拿不到文件系统，
 * 也不该拿。都没有 → null，调用方照旧走常规顺序。
 */
export function installedNodeFrom({ receipt = null, settingsHooks = [], timerExec = [] } = {}) {
  if (receipt !== null && receipt?.chains?.claude == null) return null;
  const absolute = (p) => (typeof p === "string" && p.length > 0 && path.isAbsolute(p) ? p : null);
  for (const command of settingsHooks) {
    const m = typeof command === "string" ? HOOK_GUARD.exec(command) : null;
    const node = m === null ? null : absolute(m[1]);
    if (node !== null) return node;
  }
  for (const text of timerExec) {
    const node = absolute(plistFirstArg(text) ?? unitFirstArg(text));
    if (node !== null) return node;
  }
  return null;
}

/**
 * 兜底定时器按平台选实现（PK3-L1）：darwin → launchd，linux → systemd --user，其它 → 没有实现。
 * 返回值是**种类名或 null**，调用方据此决定写什么、以及要不要打印「本平台没有实现」。
 */
export function timerKindFor(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/** 这个隔离点的**名字**（唯一一份：夹具不许另写字面量）。 */
export const TIMER_PLATFORM_ENV = "FEISHU_BRIDGE_TIMER_PLATFORM";
/** 它只认这两个值（别的值在沙箱里抛，见 resolveTimerPlatform）。 */
export const TIMER_PLATFORM_VALUES = Object.freeze(["darwin", "linux"]);

/**
 * 默认提示出口：stderr（不许混进 `--json` 的 stdout），**一个进程只打一次** ——
 * `chainFacts` 在一次维护里会被调用十来次，每次都打会变成刷屏。测试可注入 warn 收走它。
 */
let timerPlatformWarned = false;
export const timerPlatformWarn = (message) => {
  if (timerPlatformWarned) return;
  timerPlatformWarned = true;
  process.stderr.write(message + "\n");
};

/**
 * 真实用户家目录（密码库，不受 HOME 环境变量影响）——**与 launchctl / systemctl 注入的沙箱判据同一套**。
 * 读不出来（极少数容器/无 passwd 条目的系统）就回落到 os.homedir()：那等于「按真 HOME 处理」，
 * 宁可不认隔离点也不把入口弄崩（fail-safe 方向：生产不会因此变宽）。
 */
const realUserHome = () => { try { return os.userInfo().homedir; } catch { return os.homedir(); } };

/**
 * 「定时器平台」的**唯一来源**（PK3-L4 / fix1）：生产恒 `process.platform`。
 *
 * `FEISHU_BRIDGE_TIMER_PLATFORM` 是**测试沙箱**隔离点，只在 `home` ≠ 真实家目录时生效 ——
 * 判据与 launchctl / systemctl 注入**同一套**（`os.userInfo().homedir` 走密码库，不受 HOME 环境变量影响）：
 * 那些注入命中时操作的本来就不是真机的域，所以沙箱是唯一说得通的场景。
 *
 * 为什么要在真 HOME 下一律忽略（Codex 一轮 P1）：这个变量改的不是「用哪个二进制」而是
 * **协议、路径与落盘对象**（launchd plist ↔ systemd 两份 unit、各一套判据）—— 残留 darwin 能让 Linux
 * 去写/查 LaunchAgents，残留 linux 能让 Mac 改走 systemd，而四个面共享同一个错值只会让错误彼此「对得上」。
 * 所以：真 HOME → 不用它、且**明说已忽略**（`warn` 默认打到 stderr，一个进程只打一次）；
 * 沙箱 → 值必须 ∈ darwin|linux，**不封闭就抛**（非法值静默折成 timerKind=null = 安静地不装定时器）。
 * 真 HOME 下的值不校验也不抛：**生产不许被这个变量弄崩**，它本来就不该被读。
 *
 * @returns {{ platform: string, injected: boolean, ignored: boolean, why: string|null }}
 */
export function resolveTimerPlatform({ env = process.env, home = os.homedir(), realHome = realUserHome(), warn = timerPlatformWarn } = {}) {
  const raw = env?.[TIMER_PLATFORM_ENV];
  if (typeof raw !== "string" || raw.length === 0) return { platform: process.platform, injected: false, ignored: false, why: null };
  if (path.resolve(home) === path.resolve(realHome)) {
    const why = "环境里的 " + TIMER_PLATFORM_ENV + "=" + JSON.stringify(raw) +
      " 已忽略：它只在测试沙箱（HOME ≠ 真家目录）下生效，生产恒 process.platform";
    if (typeof warn === "function") warn("提示：" + why);
    return { platform: process.platform, injected: false, ignored: true, why };
  }
  if (!TIMER_PLATFORM_VALUES.includes(raw)) {
    throw new Error(TIMER_PLATFORM_ENV + " 只认 " + TIMER_PLATFORM_VALUES.join(" / ") +
      "（沙箱里值不封闭 = 夹具写错了；静默回落会让它变成假绿），收到 " + JSON.stringify(raw));
  }
  return { platform: raw, injected: true, ignored: false, why: null };
}

/** 只要平台字符串的薄壳（默认值用）。 */
export const timerPlatform = (opts) => resolveTimerPlatform(opts).platform;

/** launchd 里**应该**跑的东西：node + runtime/current 的 drain-outbox.mjs --all。跟 plist 同源。 */
export function claudeDrainExpectedJob({ home = os.homedir(), node = pickClaudeNode() } = {}) {
  return { node, args: [node, runtimeScript("drain-outbox.mjs", home, "claude"), "--all"] };
}
