/**
 * 进程启动时刻的可信读取器（#141 四轮 P1-1）。
 *
 * 为什么不走 PATH 上的 ps：PATH 可被替换——假 ps 报一个"恰好与 started.json 一致"的启动时刻，
 * 实例核验就被整个绕过。macOS 用**固定绝对路径** /bin/ps（spawnSync 传绝对路径，子进程 env 只给
 * PATH=""，timeout 2s，maxBuffer 4KiB）；Linux 直接读 /proc/<pid>/stat 的 starttime（× clock tick
 * 加 /proc/stat 的 btime）。其它平台 → unavailable。
 *
 * 输出严格解析：形状/范围不对、非零退出、超时、异常一律 { state: "unavailable", why }——
 * 调用方（doctor ⑯）对任何 unavailable 一律记「进行中未验证」（ok:null），绝不判绿。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PS_ABSOLUTE = "/bin/ps";
const CLK_TCK = 100; // USER_HZ 用户态取不到，Linux 常见值为 100

/** macOS：/bin/ps -o lstart=（固定绝对路径，env.PATH=""）。 */
function readMacos(pid) {
  let r;
  try {
    r = spawnSync(PS_ABSOLUTE, ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8", timeout: 2000, maxBuffer: 4 * 1024,
      env: { PATH: "" },
    });
  } catch (err) {
    return { state: "unavailable", why: "ps 异常: " + String(err?.message ?? err).slice(0, 120) };
  }
  if (r.error) return { state: "unavailable", why: "ps 异常: " + String(r.error.message ?? r.error).slice(0, 120) };
  if (r.status !== 0) return { state: "unavailable", why: "ps 退出码 " + String(r.status) };
  const raw = String(r.stdout ?? "").trim();
  if (!raw) return { state: "unavailable", why: "lstart 为空" };
  const t = Date.parse(raw.replace(/\s+/gu, " "));
  if (!Number.isFinite(t)) return { state: "unavailable", why: "lstart 解析失败: " + raw.slice(0, 40) };
  return { state: "ok", startMs: t };
}

/** Linux：/proc/<pid>/stat 的 starttime（第 22 字段）× CLK_TCK + /proc/stat 的 btime。 */
function readLinux(pid, { readFileSync = fs.readFileSync } = {}) {
  let stat;
  try {
    stat = readFileSync("/proc/" + pid + "/stat", "utf-8");
  } catch (err) {
    return { state: "unavailable", why: "/proc stat 读不出: " + String(err?.code ?? err?.message ?? err).slice(0, 80) };
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return { state: "unavailable", why: "stat 形状不对（缺右括号）" };
  const fields = stat.slice(close + 2).split(" ");
  const starttime = Number(fields[19]); // fields[0] = state（第 3 字段）→ starttime（第 22 字段）= fields[19]
  if (!Number.isSafeInteger(starttime) || starttime <= 0) return { state: "unavailable", why: "starttime 形状不对" };
  let btime = null;
  try {
    const procStat = readFileSync("/proc/stat", "utf-8");
    const m = /^btime\s+(\d+)$/mu.exec(procStat);
    if (m) btime = Number(m[1]);
  } catch { /* /proc/stat 读不出：btime 保持 null */ }
  if (!Number.isSafeInteger(btime) || btime <= 0) return { state: "unavailable", why: "btime 缺席或形状不对" };
  const startMs = btime * 1000 + starttime * (1000 / CLK_TCK);
  if (!Number.isSafeInteger(startMs) || startMs <= 0) return { state: "unavailable", why: "startMs 越界" };
  return { state: "ok", startMs };
}

/**
 * 进程启动时刻。返回 { state: "ok", startMs } 或 { state: "unavailable", why }。
 * 调用方对 unavailable 一律按「无法核验实例身份」处理，绝不判绿。
 */
export function readProcessStartTime(pid, { platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unavailable", why: "pid 形状不对（须 ≥1 的安全整数）" };
  if (platform === "darwin") return readMacos(pid);
  if (platform === "linux") return readLinux(pid);
  return { state: "unavailable", why: "platform " + String(platform) + " 不支持" };
}

/** 注入工厂：doctor 接 { processStartTime } 时用注入的读取器；默认用本模块的可信实现。 */
export function defaultProcessStartTime(pid) {
  return readProcessStartTime(pid, { platform: process.platform });
}

