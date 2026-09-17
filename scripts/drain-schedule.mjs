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
    // PK3-L2：mise shim **先于 PATH** —— mise 会重写子进程的 PATH，把 installs/<版本>/bin 插到
    //   shims 前面，扫 PATH 先命中的是版本真身（omm 实测解析到 …/installs/node/26/bin/node）。
    //   危害：mise use -g 换版本后旧线可能被清掉，hook 指向空路径；shim 不随版本变，拿到它才稳。
    //   位置：${XDG_DATA_HOME:-~/.local/share}/mise/shims/node（路径存在且可执行即用，
    //   不依赖 __MISE_SHIM / __MISE_DIFF 之类线索 —— omm 的 node 进程里有它们，但别把正确性押在别的工具的私有变量上）。
    const dataHome = typeof env?.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME : path.join(homedir, ".local", "share");
    candidates.push(path.join(dataHome, "mise", "shims", "node"),
      ...fromPath(), "/usr/local/bin/node", path.join(homedir, ".local", "bin", "node"));
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

/** launchd 里**应该**跑的东西：node + runtime/current 的 drain-outbox.mjs --all。跟 plist 同源。 */
export function claudeDrainExpectedJob({ home = os.homedir(), node = pickClaudeNode() } = {}) {
  return { node, args: [node, runtimeScript("drain-outbox.mjs", home, "claude"), "--all"] };
}
