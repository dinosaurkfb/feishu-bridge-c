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
