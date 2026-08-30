/**
 * 进程盘点（issue #81 PR C，方案稿"等既有进程退出"）：只认桩清单里的入口 —— 命令行里出现两条链 `current/scripts/`（含桩）
 * 或 `versions/<原目标>/scripts/` 真实路径的进程，递归计入 ppid 子树；排除维护门自己与它的祖先。
 * `ps` 失败 / 解析不了 → inventory_unverifiable（中止，不猜）。超时 → 报残留 pid 与命令行，**不 kill**。
 * 测试隔离点：FEISHU_BRIDGE_PS 换掉 ps 二进制；或直接注入 ps()。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const PS_ENV = "FEISHU_BRIDGE_PS";

export function defaultPs() {
  const bin = process.env[PS_ENV] || "ps";
  const r = spawnSync(bin, ["-axo", "pid,ppid,command"], { encoding: "utf-8" });
  if (r.error) return { ok: false, why: String(r.error?.code ?? r.error?.message) };
  if (r.status !== 0) return { ok: false, why: "ps 退出码 " + String(r.status) + "：" + String(r.stderr ?? "").trim().slice(0, 200) };
  return { ok: true, stdout: r.stdout ?? "" };
}

/** 解析 `ps -axo pid,ppid,command`：第一行是表头；解析不了任何一行 → null（不猜）。 */
export function parsePs(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0 || !/\bPID\b/iu.test(lines[0]) || !/\bPPID\b/iu.test(lines[0])) return null; // 没有表头就不是 ps 的输出，不猜
  const rows = [];
  for (const line of lines.slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!m) return null;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

const realDir = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * @param {{ roots: string[], ps?: () => ({ok:boolean, stdout?:string, why?:string}), selfPid?: number }} opts
 *   roots = 要盯的 `.../scripts` 目录（两链 current/scripts、versions/<原目标>/scripts）
 * @returns {{ ok:true, processes:{pid,ppid,command}[], roots:string[] } | { ok:false, reason:"inventory_unverifiable", why }}
 */
export function listBridgeProcesses({ roots, ps = defaultPs, selfPid = process.pid } = {}) {
  const wanted = [...new Set((roots ?? []).flatMap((r) => [r, realDir(r)]).filter((x) => typeof x === "string" && x.length > 0))];
  const r = ps();
  if (!r.ok) return { ok: false, reason: "inventory_unverifiable", why: r.why };
  const rows = parsePs(r.stdout);
  if (rows === null) return { ok: false, reason: "inventory_unverifiable", why: "ps 输出解析不了" };
  const byPid = new Map(rows.map((x) => [x.pid, x]));
  const excluded = new Set([selfPid]);
  for (let cur = byPid.get(selfPid); cur && cur.ppid > 0 && !excluded.has(cur.ppid); cur = byPid.get(cur.ppid)) excluded.add(cur.ppid);
  const matched = new Set();
  for (const row of rows) {
    if (excluded.has(row.pid)) continue;
    if (wanted.some((w) => row.command.includes(w + "/") || row.command.includes(w + " ") || row.command.endsWith(w))) matched.add(row.pid);
  }
  // 子树：被匹配的入口起的子进程（例如 claude -p）也算
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) if (!matched.has(row.pid) && !excluded.has(row.pid) && matched.has(row.ppid)) { matched.add(row.pid); grew = true; }
  }
  const processes = rows.filter((x) => matched.has(x.pid)).map((x) => ({ pid: x.pid, ppid: x.ppid, command: x.command.slice(0, 200) }));
  return { ok: true, processes, roots: wanted };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 等到没有桥进程，最多 waitMs（stepMs 步进）。超时 → processes_still_running（带残留清单，不 kill）。 */
export function waitForQuiet({ roots, waitMs = 60000, stepMs = 5000, ps = defaultPs, selfPid = process.pid, now = Date.now, sleep = sleepMs, onTick = null } = {}) {
  const started = now();
  for (;;) {
    const inv = listBridgeProcesses({ roots, ps, selfPid });
    if (!inv.ok) return inv;
    if (inv.processes.length === 0) return { ok: true, waitedMs: now() - started };
    if (typeof onTick === "function") onTick(inv);
    if (now() - started >= waitMs) return { ok: false, reason: "processes_still_running", processes: inv.processes, waitedMs: now() - started };
    sleep(Math.min(stepMs, Math.max(1, waitMs - (now() - started))));
  }
}
