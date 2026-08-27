/**
 * Claude 侧兜底定时器（launchd）的身份与期望形状 —— **只有这一份定义**。
 * 安装器写 plist 用它，doctor 查 launchd 核 ProgramArguments 也用它；各写一份就会漂
 * （评审探针：同名 job 实际跑 /bin/echo，只看 label 存在就被说成"积压有人发"）。
 */

import fs from "node:fs";
import os from "node:os";
import { runtimeScript } from "./runtime-install.mjs";

export const CLAUDE_DRAIN_LAUNCH_LABEL = "com.frank.feishu-bridge-cc.drain";

/**
 * 钩子和定时器的环境不保证继承交互 shell 的 PATH，所以 node 要写绝对路径。
 * 但**不能**写 process.execPath —— 它是 realpath 过的，带版本号（brew 升一次 node 就没了，
 * 而钩子的失败又是安静的）。优先取 brew 那个不带版本的稳定软链。
 */
export function pickClaudeNode() {
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* 试下一个 */ }
  }
  return process.execPath;
}

/** launchd 里**应该**跑的东西：node + runtime/current 的 drain-outbox.mjs --all。跟 plist 同源。 */
export function claudeDrainExpectedJob({ home = os.homedir(), node = pickClaudeNode() } = {}) {
  return { node, args: [node, runtimeScript("drain-outbox.mjs", home, "claude"), "--all"] };
}
