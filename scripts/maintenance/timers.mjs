/**
 * 定时器（launchd）在维护门里的停 / 恢复（issue #81 PR C）。判据复用共用层 launchd-job.mjs（`launchctl list` 解析），
 * 这里只加两条有损动作 bootout / bootstrap，并用同一个 FEISHU_BRIDGE_LAUNCHCTL 隔离点（测试换掉二进制，不碰真实 launchd）。
 *
 * 原始三态（journal 只会记到这三种）：loaded / installed_not_loaded / absent。
 * loaded_other / orphan / plist_unreadable / unverifiable / stale → 不受验，预检拒绝进门。
 */
import fs from "node:fs";

import { absentJob, loadedPhase, spawnLaunchctl } from "../launchd-job.mjs";
import { readRegularFile } from "../installed-surface.mjs";

export const ORIGINAL_THREE_STATE = Object.freeze(["loaded", "installed_not_loaded", "absent"]);
export const guiDomain = () => "gui/" + (typeof process.getuid === "function" ? process.getuid() : 0);

/**
 * 定时器现状：{ phase, plistBytes|null, why }。
 *   plist 读不出（除 ENOENT）→ plist_unreadable；没 plist → launchd 里明确没有 = absent / 查到同名 job = orphan / 查不清 = unverifiable；
 *   有 plist 但字节 ≠ 投影 → stale；否则按 loadedPhase(expect) → loaded / loaded_other / installed_not_loaded / unverifiable。
 */
export function timerPhase({ plistFile, wanted, expect, label, run = spawnLaunchctl }) {
  const r = readRegularFile(plistFile);
  if (r.status === "unreadable") return { phase: "plist_unreadable", plistBytes: null, why: r.why };
  if (r.status === "absent") {
    const p = loadedPhase(run, null, label);
    return { phase: p === "installed_not_loaded" ? "absent" : p === "unverifiable" ? "unverifiable" : "orphan", plistBytes: null, why: null };
  }
  const bytes = r.buf;
  if (typeof wanted === "string" && bytes.toString("utf-8") !== wanted) return { phase: "stale", plistBytes: bytes, why: "plist 字节与投影不一致" };
  return { phase: loadedPhase(run, expect, label), plistBytes: bytes, why: null };
}

/** bootout：本来就没有也算成功（absent:true）。 */
export function bootoutTimer({ label, domain = guiDomain(), run = spawnLaunchctl }) {
  const r = run(["bootout", domain + "/" + label]);
  if (r.ok) return { ok: true, absent: false };
  if (absentJob(r.detail)) return { ok: true, absent: true };
  return { ok: false, why: r.detail };
}

/** bootstrap：先 bootout（容忍不存在）再 bootstrap 目标 plist；之后核一次 loadedPhase(expect) 必须是 loaded。 */
export function bootstrapTimer({ label, plistFile, expect, domain = guiDomain(), run = spawnLaunchctl }) {
  try { fs.accessSync(plistFile, fs.constants.R_OK); } catch (err) { return { ok: false, why: "plist 不可读：" + String(err?.code ?? err?.message) }; }
  const out = run(["bootout", domain + "/" + label]);
  if (!out.ok && !absentJob(out.detail)) return { ok: false, why: "bootout：" + out.detail };
  const r = run(["bootstrap", domain, plistFile]);
  if (!r.ok) return { ok: false, why: "bootstrap：" + r.detail };
  const phase = loadedPhase(run, expect, label);
  return phase === "loaded" ? { ok: true } : { ok: false, why: "bootstrap 之后 launchd 里的不是这份（" + phase + "）" };
}
