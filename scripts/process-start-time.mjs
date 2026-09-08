/**
 * 进程启动时刻的可信读取器（#141 四轮 P1-1；五轮 P1-1/P2-3）。
 *
 * 为什么不走 PATH 上的 ps：PATH 可被替换——假 ps 报一个"恰好与 started.json 一致"的启动时刻，
 * 实例核验就被整个绕过。macOS 用**固定绝对路径** /bin/ps（spawnSync 传绝对路径，子进程 env 只给
 * PATH=""，timeout 2s，maxBuffer 4KiB）；Linux 直接读 /proc/<pid>/stat 的 starttime，tick 频率
 * CLK_TCK **受验读取**（五轮 P1-1：绝不猜 100）——优先 /proc/self/auxv 的 AT_CLKTCK，兜底
 * /usr/bin/getconf CLK_TCK（固定绝对路径、PATH 清空、2s 超时）；两者都取不到 → unavailable。
 * 其它平台 → unavailable。
 *
 * 输出严格解析：形状/范围不对、非零退出、超时、异常一律 { state: "unavailable", why }——
 * 调用方（doctor ⑯）对任何 unavailable 一律记「进行中未验证」（ok:null），绝不判绿。
 * 测试密闭（五轮 P2-3）：spawnSync / readFileSync 都可注入，沙箱不需要真的有 /bin/ps、/proc。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const PS_ABSOLUTE = "/bin/ps";
const GETCONF_ABSOLUTE = "/usr/bin/getconf";
const AT_CLKTCK = 17; // auxv key：clock tick 频率（getconf CLK_TCK 的内核侧来源）
const CLK_TCK_SANE = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 100000;

/** macOS：/bin/ps -o lstart=（固定绝对路径，env.PATH=""）。 */
function readMacos(pid, { spawnSync: spawn = spawnSync } = {}) {
  let r;
  try {
    r = spawn(PS_ABSOLUTE, ["-o", "lstart=", "-p", String(pid)], {
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

/** /proc/self/auxv 的 AT_CLKTCK（受验读取）：按本机字节序解析 64 位（8 字节项回退 32 位），取不到/形状不对 → null。 */
function clktckFromAuxv(readFile) {
  let buf = null;
  try { buf = readFile("/proc/self/auxv"); } catch { return null; }
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const be = os.endianness() === "BE";
  const rd = (b, o) => {
    try {
      const v = be ? b.readBigUInt64BE(o) : b.readBigUInt64LE(o);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
    } catch { return null; }
  };
  const stride = buf.length % 16 === 0 ? 16 : 8; // 64 位机器 auxv 项 16 字节；32 位 8 字节
  if (stride === 8) {
    for (let off = 0; off + 8 <= buf.length; off += 8) {
      const type = buf.readUInt32LE(off), val = buf.readUInt32LE(off + 4);
      if (type === AT_CLKTCK) return CLK_TCK_SANE(val) ? val : null;
    }
    return null;
  }
  for (let off = 0; off + 16 <= buf.length; off += 16) {
    const type = rd(buf, off);
    if (type !== AT_CLKTCK) continue;
    const val = rd(buf, off + 8);
    return CLK_TCK_SANE(val) ? val : null;
  }
  return null;
}

/** /usr/bin/getconf CLK_TCK（固定绝对路径、PATH 清空、2s 超时）；不可用/输出不整数 → null。 */
function clktckFromGetconf(spawn) {
  let r = null;
  try { r = spawn(GETCONF_ABSOLUTE, ["CLK_TCK"], { encoding: "utf-8", timeout: 2000, maxBuffer: 1024, env: { PATH: "" } }); }
  catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  const n = Number(String(r.stdout ?? "").trim());
  return CLK_TCK_SANE(n) ? n : null;
}

/** Linux：/proc/<pid>/stat 的 starttime（第 22 字段）× CLK_TCK（受验读取）+ /proc/stat 的 btime。 */
function readLinux(pid, { readFileSync: readFile = fs.readFileSync, spawnSync: spawn = spawnSync } = {}) {
  // 五轮 P1-1：CLK_TCK 绝不猜 100——auxv 优先、getconf 兜底，皆取不到 → unavailable（调用方记未验证）。
  const clktck = clktckFromAuxv(readFile) ?? clktckFromGetconf(spawn);
  if (!CLK_TCK_SANE(clktck)) return { state: "unavailable", why: "CLK_TCK 取不到（auxv 无 AT_CLKTCK 且 getconf 不可用）" };
  let stat;
  try {
    stat = readFile("/proc/" + pid + "/stat", "utf-8");
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
    const procStat = readFile("/proc/stat", "utf-8");
    const m = /^btime\s+(\d+)$/mu.exec(procStat);
    if (m) btime = Number(m[1]);
  } catch { /* /proc/stat 读不出：btime 保持 null */ }
  if (!Number.isSafeInteger(btime) || btime <= 0) return { state: "unavailable", why: "btime 缺席或形状不对" };
  const startMs = btime * 1000 + starttime * (1000 / clktck);
  if (!Number.isSafeInteger(startMs) || startMs <= 0) return { state: "unavailable", why: "startMs 越界" };
  return { state: "ok", startMs };
}

/**
 * 进程启动时刻。返回 { state: "ok", startMs } 或 { state: "unavailable", why }。
 * 调用方对 unavailable 一律按「无法核验实例身份」处理，绝不判绿。
 * 注入面（五轮 P2-3）：{ readFileSync, spawnSync }——测试密闭，不依赖真机 /bin/ps、/proc、getconf。
 */
export function readProcessStartTime(pid, { platform = process.platform, readFileSync: readFile = fs.readFileSync, spawnSync: spawn = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unavailable", why: "pid 形状不对（须 ≥1 的安全整数）" };
  if (platform === "darwin") return readMacos(pid, { spawnSync: spawn });
  if (platform === "linux") return readLinux(pid, { readFileSync: readFile, spawnSync: spawn });
  return { state: "unavailable", why: "platform " + String(platform) + " 不支持" };
}

/** 注入工厂：doctor 接 { processStartTime } 时用注入的读取器；默认用本模块的可信实现。 */
export function defaultProcessStartTime(pid) {
  return readProcessStartTime(pid, { platform: process.platform });
}
