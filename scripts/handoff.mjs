/**
 * 把一条指令投递给长期任务 —— 非阻塞。
 *
 * 这是本设计与 Codex 侧 v0.8/v0.9 最大的分歧点：那边的 runner 会一直阻塞到
 * turn.completed，因为它要在运输回合里亲眼确认完成。按 2026-08-19 对齐的需求，
 * Frank 不从入站回合获知完成 —— 他从下一轮出站获知。所以这里 spawn 完就返回，
 * 完成与否由出站流程独立观察 run 日志得出。
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 同一个会话不能并发 resume，否则两轮会互相踩。用目录锁串行化。
 *
 * 关键点：投递是 detached 的，本进程退出时子进程还在跑，所以锁**不能**由本进程
 * 在退出时释放。锁的生命周期跟着 run 走，靠陈旧检测回收：
 * 持有者进程已死、或它的 run 日志已经写出终局行，锁就算过期。
 * 没有这一步，一次崩溃就会把长期任务永久锁死。
 */
export function acquireSessionLock(lockDir) {
  const attempt = () => {
    try {
      fs.mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      return { ok: true };
    } catch (err) {
      if (err.code === "EEXIST") return { ok: false, reason: "session_busy" };
      return { ok: false, reason: "io_error", error: err.message };
    }
  };

  const first = attempt();
  if (first.ok) return first;
  if (first.reason !== "session_busy") return first;

  if (isLockStale(lockDir)) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return attempt(); // 只重试一次：再失败说明有别人刚抢到，让它去
  }
  return first;
}

/**
 * 锁是否已经没人真的持有。
 *
 * 导出是因为出站也要问同一个问题：会话结束钩子必须知道「有没有守望者正在盯这次 run」，
 * 有就让给它发（它会把结果和进展合成一条），没有才自己排空。判定标准必须是同一套，
 * 两边各写一套迟早会出现「都以为对方会发」或者「两边都发」。
 */
export function isLockStale(lockDir) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
  } catch {
    return true; // 锁目录在但 owner 不可读 —— 上次是在两步之间崩的
  }

  if (owner.log_path) {
    const outcome = readRunOutcome(owner.log_path);
    if (outcome.state === "completed" || outcome.state === "failed") return true;
  }

  if (Number.isFinite(owner.pid)) {
    try {
      process.kill(owner.pid, 0); // 只探测存活，不发真信号
      return false;
    } catch {
      return true; // 进程没了
    }
  }
  return true;
}

/** 投递成功后把 run 信息补进锁，陈旧检测才有依据。 */
export function stampSessionLock(lockDir, { pid, logPath }) {
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify({ pid, log_path: logPath, at: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
}

export function releaseSessionLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

/**
 * 非阻塞投递。返回时子进程刚起来，任务远未完成 —— 这是预期行为，不是缺陷。
 */
/**
 * spawn 对「二进制不存在」是异步报错的 —— 它不抛，只在事件循环里 emit error。
 * 投递又是 detached + 立即返回，于是 claude 不在 PATH 时旧版会照样回「已受理」，
 * 而实际上什么都没启动。受理回执必须以真实存在的可执行文件为前提。
 */
function assertClaudeAvailable() {
  try {
    execFileSync("command", ["-v", "claude"], { shell: "/bin/sh", stdio: "ignore", timeout: 5000 });
  } catch {
    throw new Error("claude 不在 PATH 上，无法投递");
  }
}

export function handOff({ projectDir, instruction, runsDir, key, resumeSessionId }) {
  assertClaudeAvailable();
  fs.mkdirSync(runsDir, { recursive: true });
  const logPath = path.join(runsDir, key + ".jsonl");
  const errPath = path.join(runsDir, key + ".stderr.log");

  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(errPath, "a");

  // 默认 --continue：「这个目录里最近的那次对话」，工作在哪儿它就跟到哪儿。
  //
  // 但**会话级绑定**要的恰恰是「那一条线」，所以那种情况会传 resumeSessionId 进来，
  // 走 --resume <uuid>。这跟当年被废掉的做法不一样：当年是**推断**出一个 uuid 钉死，
  // 过期了没人知道；现在这个 uuid 是 Frank 在那个会话里亲手绑的，
  // 而且找不到时是明确拒绝，不会悄悄投给另一条线。
  //
  // 下面这段原注释保留，它解释了为什么默认不钉 uuid：
  // 会话是记录，每开一个终端就是新的一份，钉住的那份很快就不再是工作发生的地方了 ——
  // 实测钉住的那份是一堆联调残渣，而真正的项目演进在另一份里。
  // --continue 的语义是「这个目录里最近的那次对话」，工作在哪儿它就跟到哪儿。
  const child = spawn(
    "claude",
    (typeof resumeSessionId === "string" && resumeSessionId
      ? ["--resume", resumeSessionId, "-p", instruction, "--output-format", "stream-json", "--verbose"]
      : ["--continue", "-p", instruction, "--output-format", "stream-json", "--verbose"]),
    {
      cwd: projectDir, detached: true, stdio: ["ignore", out, err],
      // 标记成桥自己起的：这一轮的结果由守望者发布（它能分辨 completed/blocked/failed），
      // Stop 钩子不要再把同一段话当答复发一遍。
      env: { ...process.env, FEISHU_BRIDGE_ROLE: "run" },
    },
  );
  // unref 之后父进程可以立刻退出，子进程继续跑 —— 这正是「秒级回执」的实现基础。
  child.unref();

  return {
    mode: (typeof resumeSessionId === "string" && resumeSessionId) ? "resume" : "continue",
    resumedSessionId: resumeSessionId ?? null,
    pid: child.pid, logPath, errPath, startedAt: new Date().toISOString(),
  };
}

/**
 * 读 run 日志判断结局。**只有出站流程该调用它**，入站不许等这个结果。
 *
 * 返回 running 表示「还没写出终局行」，不代表失败。
 */
export function readRunOutcome(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch {
    return { state: "missing" };
  }
  return parseRunOutcome(raw);
}

/**
 * 按**一份已经读到的文本**判终局 —— 核验、正文、摘要必须来自同一份字节快照
 * （评审探针：第一次读到 A、盘上与第二次读到 B，摘要 B 通过、发出去的却是 A）。
 */
export function parseRunOutcome(raw) {
  let finalText = null;
  let isError = null;
  let sawResult = false;
  let denials = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 半截行：进程还在写，跳过而不是判失败
    }
    if (ev.type === "result") {
      sawResult = true;
      isError = ev.is_error === true;
      if (typeof ev.result === "string") finalText = ev.result;
      if (Array.isArray(ev.permission_denials)) denials = ev.permission_denials;
    }
  }

  if (!sawResult) return { state: "running" };
  if (isError) return { state: "failed", finalText };

  // 权限被拦的 run 会以 is_error=false + 一段「我做不了」的文本收场。
  // 那不是完成 —— 它一件事都没做成。把它判成 completed 就等于伪造成功，
  // 而伪造成功正是本项目最不能出的错。
  if (denials.length > 0) {
    return {
      state: "blocked",
      finalText,
      deniedTools: [...new Set(denials.map((d) => d.tool_name).filter(Boolean))],
    };
  }

  // 严格条件：既要 result 行，也要非空最终输出，缺一不可。
  if (!finalText || finalText.trim().length === 0) {
    return { state: "failed", reason: "empty_final_output" };
  }
  return { state: "completed", finalText };
}
