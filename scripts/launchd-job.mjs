/**
 * launchd job 的只读探测 —— **共用层**：Codex 的兜底排空服务与 Claude 的机器级体检都用这一份判据，
 * 各写一份就会漂（同一个错误串在两处得到不同结论，这仓库栽过）。
 *
 * 只有 `launchctl list <label>`（只读）；bootout / bootstrap 那些有损动作不在这里。
 * FEISHU_BRIDGE_LAUNCHCTL 是测试隔离点：设了就换掉二进制，不碰真实 launchd。
 */

import { spawnSync } from "node:child_process";

export const LAUNCHCTL_ENV = "FEISHU_BRIDGE_LAUNCHCTL";

export function spawnLaunchctl(args) {
  const bin = process.env[LAUNCHCTL_ENV] || "launchctl";
  const r = spawnSync(bin, args, { encoding: "utf-8" });
  // stdout 要带回来 —— 核验"跑的是不是我们这份"靠的就是它。
  if (r.status === 0) return { ok: true, stdout: r.stdout ?? "" };
  return { ok: false, detail: (r.stderr || r.stdout || "status " + r.status).trim() };
}

/**
 * 从 `launchctl list <label>` 的输出里拆出 Program 与完整的 ProgramArguments。
 *
 * 拆出来才能**精确核对**。上一版只查输出里"包不包含期望脚本路径"——
 * 评审构造了一个实际运行 /bin/echo、仅把期望脚本当参数的 job，照样被判成 loaded。
 * 子串包含分不开"跑的是它"和"提到了它"。
 */
export function parseLaunchctlList(text) {
  if (typeof text !== "string") return null;
  const program = /"Program"\s*=\s*"((?:[^"\\]|\\.)*)";/u.exec(text);
  const block = /"ProgramArguments"\s*=\s*\(([\s\S]*?)\);/u.exec(text);
  if (!block) return null;
  const args = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((m) => m[1]);
  return { program: program ? program[1] : null, args };
}

/**
 * launchctl 的这条错误是不是"本来就没有这个服务"。
 *
 * **只认这一种。**上一版还认 `not.*loaded`，那能匹配上
 * "could not load"、"failed: job not loaded correctly" 之类真正的失败 ——
 * 判据放宽一点，"卸载失败"就会被当成"本来就没有"。
 */
export const absentJob = (detail) =>
  typeof detail === "string" &&
  /(could not find (the )?(specified )?service|no such (file|process)|not find service)/iu.test(detail);

/** label 必填：这是跨链共用的判据，不默认任何一条链的服务名。 */
export function loadedPhase(run = spawnLaunchctl, expect = null, label) {
  if (typeof label !== "string" || label.length === 0) throw new Error("loadedPhase 需要 label");
  // label 可选：Claude 侧机器级体检查自己的兜底定时器时也走这一份判据，不另抄一遍。
  const r = run(["list", label]);
  if (!r.ok) {
    // 明确的"没这个服务"和"我查不了"是两件事。**判据跟 absentJob 共用同一份** ——
    // 这里曾经内联了一个更宽的正则，于是同一个错误串在两处得到不同结论。
    return absentJob(r.detail) ? "installed_not_loaded" : "unverifiable";
  }
  if (expect === null) return "loaded";
  const parsed = parseLaunchctlList(r.stdout);
  // **拆不出来就说查不出来，不许当成 loaded。**
  if (parsed === null) return "unverifiable";
  const sameProgram = parsed.program === null || parsed.program === expect.node;
  const sameArgs = parsed.args.length === expect.args.length &&
    parsed.args.every((a, i) => a === expect.args[i]);
  // **同名 job 在，不等于跑的是我们刚写的那份。**
  // 先写新 plist 再 bootstrap，失败时 plist 留在原地；旧的同名 job 还在跑的话，
  // 只看 label 就会报"已加载，正在按计划跑"，而实际跑的是旧配置。
  return sameProgram && sameArgs ? "loaded" : "loaded_other";
}

export const PHASE_TEXT = {
  absent: "未启用（安装后的默认态，不是故障）",
  plist_unreadable: "**plist 读不出来 —— 不知道它是什么状态，一律当成可能在跑**",
  orphan: "**没有 plist，但 launchd 里还有同名 job 在 —— 它在按谁的配置跑说不清**",
  stale: "plist 与当前运行时对不上（要重装）",
  installed_not_loaded: "**plist 已写入但没被 launchd 加载 —— 定时器不会跑**",
  loaded: "已加载，正在按计划跑",
  loaded_other: "**同名 job 在跑，但参数不是当前这份 —— 跑的多半是旧配置**",
  unverifiable: "launchd 状态查不出来 —— 不等于没在跑",
};
