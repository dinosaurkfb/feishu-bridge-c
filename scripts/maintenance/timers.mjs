/**
 * 定时器（launchd / systemd --user）在维护门里的停 / 恢复（issue #81 PR C，PK3-L3 按平台分派）。
 * 判据复用共用层 launchd-job.mjs（`launchctl list` 解析）与 install-projection.mjs（systemd 单元/show 解析），
 * 支持 FEISHU_BRIDGE_LAUNCHCTL 与 FEISHU_BRIDGE_SYSTEMCTL 隔离点（测试换掉二进制，沙箱不碰真实守护进程）。
 *
 * 原始三态（journal 只会记到这三种）：loaded / installed_not_loaded / absent。
 * loaded_other / orphan / plist_unreadable / unverifiable / stale → 不受验，预检拒绝进门。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { absentJob, loadedPhase, spawnLaunchctl } from "../launchd-job.mjs";
import { readRegularFile } from "../installed-surface.mjs";
import { systemdExecStartValue, systemdShowExecArgv, systemdUnitAbsent } from "../install-projection.mjs";

export const ORIGINAL_THREE_STATE = Object.freeze(["loaded", "installed_not_loaded", "absent"]);
export const guiDomain = () => "gui/" + (typeof process.getuid === "function" ? process.getuid() : 0);

export const SYSTEMCTL_ENV = "FEISHU_BRIDGE_SYSTEMCTL";

export const SYSTEMCTL_STATE_WORDS = new Set([
  "active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance",
  "enabled", "enabled-runtime", "disabled", "static", "indirect", "linked", "linked-runtime",
  "masked", "masked-runtime", "alias", "generated", "transient", "unknown",
]);

export function spawnSystemctl(args) {
  const bin = process.env[SYSTEMCTL_ENV] || "systemctl";
  const fullArgs = args[0] === "--user" ? args : ["--user", ...args];
  try {
    const out = execFileSync(bin, fullArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    return { ok: true, out, err: "" };
  } catch (err) {
    return { ok: false, out: String(err?.stdout ?? ""), err: String(err?.stderr ?? err?.message ?? err) };
  }
}

const say = (r) => (String(r?.out ?? "") + " " + String(r?.err ?? "")).trim();
const stateWord = (r) => {
  const word = String(r?.out ?? "").trim().split(/\s+/u)[0] ?? "";
  return SYSTEMCTL_STATE_WORDS.has(word) ? word : null;
};
const readableSystemctl = (r) => r?.ok === true || stateWord(r) !== null || systemdUnitAbsent(say(r));

export function systemctlRunner(custom) {
  if (typeof custom === "function") {
    return (args) => {
      const res = custom(args);
      if (res && (res.ok || stateWord(res) !== null || systemdUnitAbsent(say(res)))) return res;
      if (args[0] === "--user") {
        const fallback = custom(args.slice(1));
        if (fallback && (fallback.ok || stateWord(fallback) !== null || systemdUnitAbsent(say(fallback)))) {
          return fallback;
        }
      } else {
        const fallback = custom(["--user", ...args]);
        if (fallback && (fallback.ok || stateWord(fallback) !== null || systemdUnitAbsent(say(fallback)))) {
          return fallback;
        }
      }
      return res;
    };
  }
  return spawnSystemctl;
}

/**
 * 定时器现状：{ phase, plistBytes|null, why }。
 *   - kind === null（其它平台）：按 absent 处理，无兜底定时器实现。
 *   - kind === "launchd"（darwin）：原 launchd 判据保持不变。
 *   - kind === "systemd"（linux）：systemctl --user 派生五相（loaded/installed_not_loaded/absent/orphan/unverifiable）。
 */
export function timerPhase({
  kind = "launchd",
  plistFile,
  wanted,
  expect,
  label,
  run = spawnLaunchctl,
  // systemd fields:
  unit = label,
  service = null,
  serviceFile = null,
  timerFile = plistFile,
  wantedService = null,
  wantedTimer = wanted,
  home = os.homedir(),
  systemctl = null,
} = {}) {
  if (kind === null) {
    return { phase: "absent", plistBytes: null, why: null };
  }

  if (kind === "launchd") {
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

  if (kind === "systemd") {
    const sandboxed = path.resolve(home) !== path.resolve(os.userInfo().homedir);
    const systemctlInjected = typeof systemctl === "function" || Boolean(process.env[SYSTEMCTL_ENV]);
    if (sandboxed && !systemctlInjected) {
      return { phase: "unverifiable", plistBytes: null, why: "体检/维护的 home 不是当前用户的家目录（沙箱），不碰真实 systemctl --user" };
    }

    const timerRes = readRegularFile(timerFile);
    const serviceRes = serviceFile ? readRegularFile(serviceFile) : { status: "absent" };
    if (timerRes.status === "unreadable" || serviceRes.status === "unreadable") {
      return { phase: "plist_unreadable", plistBytes: null, why: (timerRes.why || serviceRes.why) };
    }

    const systemctlFn = systemctlRunner(systemctl);
    const timerUnitName = unit.endsWith(".timer") ? unit : unit + ".timer";
    const serviceUnitName = service ?? (unit.endsWith(".timer") ? unit.slice(0, -6) + ".service" : unit + ".service");

    const enabled = systemctlFn(["is-enabled", timerUnitName]);
    const active = systemctlFn(["is-active", timerUnitName]);

    if (!readableSystemctl(enabled) || !readableSystemctl(active)) {
      const errDetail = say(!readableSystemctl(enabled) ? enabled : active);
      return { phase: "unverifiable", plistBytes: null, why: "systemctl --user 查不了（" + errDetail.slice(0, 120) + "）—— 查不清，不等于没在跑" };
    }

    const hasFiles = timerRes.status === "read" || serviceRes.status === "read";
    const isEnabled = String(enabled?.out ?? "").trim() === "enabled";
    const isActive = String(active?.out ?? "").trim() === "active";

    if (!hasFiles) {
      return {
        phase: (isEnabled || isActive) ? "orphan" : "absent",
        plistBytes: null,
        why: (isEnabled || isActive) ? "磁盘上无 unit 文件，但 systemd manager 里仍有同名 timer 在跑或启用" : null,
      };
    }

    if (!isEnabled || !isActive) {
      return {
        phase: "installed_not_loaded",
        plistBytes: timerRes.status === "read" ? timerRes.buf : null,
        why: "systemd timer 未启用或未在跑",
      };
    }

    // enabled && active: verify disk files match projection
    const bothFilesValid = timerRes.status === "read" && serviceRes.status === "read";
    const timerMatches = typeof wantedTimer === "string" ? (timerRes.status === "read" && timerRes.buf.toString("utf-8") === wantedTimer) : true;
    const serviceMatches = typeof wantedService === "string" ? (serviceRes.status === "read" && serviceRes.buf.toString("utf-8") === wantedService) : true;
    if (!bothFilesValid || !timerMatches || !serviceMatches) {
      return {
        phase: "stale",
        plistBytes: timerRes.status === "read" ? timerRes.buf : null,
        why: "磁盘上的 systemd 单元与当前投影不一致",
      };
    }

    // query show ExecStart
    const show = systemctlFn(["show", serviceUnitName, "-p", "ExecStart", "--value"]);
    if (!show?.ok) {
      return {
        phase: "unverifiable",
        plistBytes: timerRes.buf,
        why: "systemctl --user show 查不了（" + say(show).slice(0, 120) + "）—— 已加载的定义核不了，查不清",
      };
    }

    const expectedArgs = expect?.args ?? [];
    const loadedArgv = systemdShowExecArgv(String(show.out ?? ""));
    const sameExec = loadedArgv !== null &&
      (loadedArgv === systemdExecStartValue(expectedArgs) || loadedArgv === expectedArgs.join(" "));
    if (!sameExec) {
      return {
        phase: "orphan",
        plistBytes: timerRes.buf,
        why: "systemd manager 里已加载的 ExecStart 与当前投影不一致",
      };
    }

    return { phase: "loaded", plistBytes: timerRes.buf, why: null };
  }

  return { phase: "unverifiable", plistBytes: null, why: "未知定时器种类：" + kind };
}

/** bootout / stop：本来就没有也算成功（absent:true）。 */
export function bootoutTimer({
  kind = "launchd",
  label,
  unit = label,
  domain = guiDomain(),
  run = spawnLaunchctl,
  systemctl = null,
} = {}) {
  if (kind === null) return { ok: true, absent: true };
  if (kind === "launchd") {
    const r = run(["bootout", domain + "/" + label]);
    if (r.ok) return { ok: true, absent: false };
    if (absentJob(r.detail)) return { ok: true, absent: true };
    return { ok: false, why: r.detail };
  }
  if (kind === "systemd") {
    const systemctlFn = systemctlRunner(systemctl);
    const timerUnitName = unit.endsWith(".timer") ? unit : unit + ".timer";
    const r = systemctlFn(["stop", timerUnitName]);
    const rText = say(r);
    if (r.ok) return { ok: true, absent: false };
    if (systemdUnitAbsent(rText)) return { ok: true, absent: true };
    return { ok: false, why: rText || ("退出码非零：" + JSON.stringify(r)) };
  }
  return { ok: false, why: "未知定时器种类：" + kind };
}

/** bootstrap / resume：先 reload 再 start/enable；之后核一次 timerPhase 必须是 loaded。 */
export function bootstrapTimer({
  kind = "launchd",
  label,
  unit = label,
  plistFile,
  timerFile = plistFile,
  serviceFile = null,
  expect,
  wanted,
  wantedService = null,
  wantedTimer = wanted,
  service = null,
  home = os.homedir(),
  domain = guiDomain(),
  run = spawnLaunchctl,
  systemctl = null,
} = {}) {
  if (kind === null) return { ok: true };
  if (kind === "launchd") {
    try { fs.accessSync(plistFile, fs.constants.R_OK); } catch (err) { return { ok: false, why: "plist 不可读：" + String(err?.code ?? err?.message) }; }
    const out = run(["bootout", domain + "/" + label]);
    if (!out.ok && !absentJob(out.detail)) return { ok: false, why: "bootout：" + out.detail };
    const r = run(["bootstrap", domain, plistFile]);
    if (!r.ok) return { ok: false, why: "bootstrap：" + r.detail };
    const phase = loadedPhase(run, expect, label);
    return phase === "loaded" ? { ok: true } : { ok: false, why: "bootstrap 之后 launchd 里的不是这份（" + phase + "）" };
  }
  if (kind === "systemd") {
    try { fs.accessSync(timerFile, fs.constants.R_OK); } catch (err) { return { ok: false, why: "timer 单元文件不可读：" + String(err?.code ?? err?.message) }; }
    if (serviceFile) {
      try { fs.accessSync(serviceFile, fs.constants.R_OK); } catch (err) { return { ok: false, why: "service 单元文件不可读：" + String(err?.code ?? err?.message) }; }
    }
    const systemctlFn = systemctlRunner(systemctl);
    const timerUnitName = unit.endsWith(".timer") ? unit : unit + ".timer";
    const reload = systemctlFn(["daemon-reload"]);
    if (!reload.ok) {
      const err = say(reload);
      return { ok: false, why: "daemon-reload 失败：" + err };
    }
    let start = systemctlFn(["enable", "--now", timerUnitName]);
    if (!start.ok && !start.out) {
      start = systemctlFn(["start", timerUnitName]);
    }
    if (!start.ok && !start.out) {
      const err = say(start);
      return { ok: false, why: "start 失败：" + err };
    }
    const cur = timerPhase({
      kind: "systemd",
      unit: timerUnitName,
      service,
      serviceFile,
      timerFile,
      wantedService,
      wantedTimer,
      expect,
      home,
      systemctl,
    });
    return cur.phase === "loaded"
      ? { ok: true }
      : { ok: false, why: "bootstrap 之后 systemd 里的不是这份（" + cur.phase + (cur.why ? "：" + cur.why : "") + "）" };
  }
  return { ok: false, why: "未知定时器种类：" + kind };
}
