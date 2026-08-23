/**
 * 入站进程异常终止时对外说什么、对内留什么。
 *
 * 两条边界叠在一起，所以单独成模块给两个 adapter 共用：
 *
 *   **对外只出脱敏信息。**Aily 会把进程输出带回模型可见通道，所以 stdout/stderr 写什么
 *   等于对外发布什么。曾经直接写 `err.stack`，本机绝对路径和内部调用栈一起送了出去。
 *
 *   **不给查不到的引用码。**诊断细节要留，但日志本身也会写失败（目录不可写、
 *   环境变量指向非法路径）。上一版不看写入结果就照样输出引用码 —— 那是一份假的
 *   可查凭证，拿着它翻日志只会一无所获，比直接说"没留下诊断信息"更浪费时间。
 *
 * 共用还有第三个理由：这个仓库反复出现"只修一侧"（技能模板、shellQuote、轮转收口
 * 各犯过一次）。一份实现两边引用，就没有分叉的余地。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 引用码带 PID 与随机量。只用毫秒时间戳的话，同毫秒并发会撞出两条同名记录，
 * 对账时分不清是哪一次。
 */
export function crashReference(now = Date.now(), pid = process.pid) {
  return "inbound_" + now.toString(36) + "_" + pid.toString(36) +
    "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * 把堆栈写进本机日志，并给出该对外说的那句话。
 *
 * 返回 `logged` 而不是让调用方猜：写没写成是个事实，不该由"我们打算写"来代替。
 */
export function composeCrashReceipt({ error, logFile, now = Date.now(), pid = process.pid } = {}) {
  const ref = crashReference(now, pid);
  let logged = false;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile,
      new Date(now).toISOString() + " " + ref + "\n" +
      String(error?.stack ?? error) + "\n\n", { mode: 0o600 });
    logged = true;
  } catch { /* 下面如实说没落盘 */ }
  return {
    ref: logged ? ref : null,
    logged,
    text: "系统错误 · 入站处理异常终止" +
      (logged ? "（" + ref + "）" : "（本机诊断日志未能落盘，无可对账引用码）") + "\n" +
      "本条指令没有被投递。请勿视为已受理。\n",
  };
}
