/**
 * PK3-T3：套件级安装面卫兵（issue #233）。
 *
 * 启动时（installTestHomeIsolation 之前，用 os.userInfo().homedir 而非 HOME 取真实家目录）
 * 快照真实 ~/.claude/feishu-bridge 权威文件与 settings / Codex 模板的 sha256 与 mtime（共 7 个文件）：
 *   1. ~/.claude/feishu-bridge/chain-config.json
 *   2. ~/.claude/feishu-bridge/routes.json
 *   3. ~/.claude/feishu-bridge/status-providers.json
 *   4. ~/.claude/feishu-bridge/subscriptions.json
 *   5. ~/.claude/feishu-bridge/runtime/current（符号链接目标）
 *   6. ~/.claude/settings.json
 *   7. ~/.codex/feishu-bridge/chain-config.json
 *
 * 为什么不包含 registry.json（7 个而非 8 个）：
 *   registry.json 是活账本（出站发布器 / stop hook 每发一条消息就改写 message_count 与
 *   最后发布时间）。开发机跑测试套件的同时，线上桥服务也在并发运行；若把活账本纳入安装面
 *   快照，线上桥正常处理消息时的账本写入就会被误判为测试用例"写穿安装面"（曾发生过线上
 *   回复触发账本更新，导致无辜用例被误报拦截）。安装面卫兵只守护**装机才写**
 *   的静态权威配置与钩子；活账本的自洽性由 doctor 的账本自洽项管。
 *
 * 逐用例边界核验：在 harness reclaimSince 旁比对，命中时记录肇事用例名；
 * 汇总 / 退出兜底：重算比对，变了就打「安装面硬门：套件改动了本机安装面」并置退出码非 0。
 * 只报不改、不恢复。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PK3-T3-fix1：registry.json **不在**清单里——它是活账本（出站发布器 / stop hook 每发一条就改 message_count），
// 开发机上套件跑着的同时线上桥也在跑，2026-09-18 11:41Z 一次验收就把我自己回复被发布时的账本更新算到了
// 「矩阵[claude-drain·migrated]」头上。安装面卫兵只守**装机才写**的文件；活账本的污染由 doctor 的账本自洽项管。
export const DEFAULT_AUTHORITATIVE_FILES = Object.freeze([
  path.join(".claude", "feishu-bridge", "chain-config.json"),
  path.join(".claude", "feishu-bridge", "routes.json"),
  path.join(".claude", "feishu-bridge", "status-providers.json"),
  path.join(".claude", "feishu-bridge", "subscriptions.json"),
  path.join(".claude", "feishu-bridge", "runtime", "current"),
  path.join(".claude", "settings.json"),
  path.join(".codex", "feishu-bridge", "chain-config.json"),
]);

export function resolveAuthoritativePaths({ home = null, files = null } = {}) {
  if (Array.isArray(files)) {
    return files.map((f) => path.resolve(f));
  }
  const realHome = home ?? (process.env.FEISHU_BRIDGE_SURFACE_GUARD_HOME || os.userInfo().homedir);
  return DEFAULT_AUTHORITATIVE_FILES.map((rel) => path.join(realHome, rel));
}

export function snapshotFile(filepath) {
  const p = path.resolve(filepath);
  try {
    const st = fs.lstatSync(p, { bigint: true });
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(p);
      } catch (err) {
        target = "<unreadable: " + (err?.code ?? err?.message ?? err) + ">";
      }
      const sha = crypto.createHash("sha256").update("symlink:" + target).digest("hex");
      return {
        path: p,
        state: "present",
        type: "symlink",
        symlinkTarget: target,
        sha,
        mtime: st.mtime.toISOString(),
        mtimeNs: st.mtimeNs,
      };
    }
    if (st.isDirectory()) {
      return {
        path: p,
        state: "present",
        type: "dir",
        symlinkTarget: null,
        sha: null,
        mtime: st.mtime.toISOString(),
        mtimeNs: st.mtimeNs,
      };
    }
    const buf = fs.readFileSync(p);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    return {
      path: p,
      state: "present",
      type: "file",
      symlinkTarget: null,
      sha,
      mtime: st.mtime.toISOString(),
      mtimeNs: st.mtimeNs,
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        path: p,
        state: "absent",
        type: "absent",
        symlinkTarget: null,
        sha: null,
        mtime: null,
        mtimeNs: null,
      };
    }
    return {
      path: p,
      state: "error",
      type: "error",
      error: String(err?.code ?? err?.message ?? err),
      symlinkTarget: null,
      sha: null,
      mtime: null,
      mtimeNs: null,
    };
  }
}

export function takeSurfaceSnapshot(filePaths) {
  const snap = new Map();
  for (const f of filePaths) {
    snap.set(f, snapshotFile(f));
  }
  return snap;
}

export function diffSurfaceSnapshots(baseline, current, { culprits = new Map() } = {}) {
  const diffs = [];
  for (const [p, before] of baseline.entries()) {
    const after = current.get(p) ?? snapshotFile(p);
    const culprit = culprits.get(p) ?? null;
    if (before.state === "error" || after.state === "error") {
      diffs.push({
        path: p,
        kind: "unverifiable",
        error: after.error || before.error || "unreadable",
        beforeSha: before?.sha ?? null,
        afterSha: after?.sha ?? null,
        beforeMtime: before?.mtime ?? null,
        mtime: after?.mtime ?? null,
        beforeMtimeNs: before?.mtimeNs ?? null,
        mtimeNs: after?.mtimeNs ?? null,
        culprit,
      });
    } else if (before.state === "absent" && after.state === "present") {
      diffs.push({
        path: p,
        kind: "added",
        beforeSha: null,
        afterSha: after.sha,
        mtime: after.mtime,
        mtimeNs: after.mtimeNs,
        culprit,
      });
    } else if (before.state === "present" && after.state === "absent") {
      diffs.push({
        path: p,
        kind: "removed",
        beforeSha: before.sha,
        afterSha: null,
        mtime: null,
        mtimeNs: null,
        culprit,
      });
    } else if (before.state === "present" && after.state === "present") {
      if (before.type === "symlink" && after.type === "symlink") {
        if (before.symlinkTarget !== after.symlinkTarget || before.sha !== after.sha) {
          diffs.push({
            path: p,
            kind: "symlink_modified",
            beforeTarget: before.symlinkTarget,
            afterTarget: after.symlinkTarget,
            beforeSha: before.sha,
            afterSha: after.sha,
            mtime: after.mtime,
            mtimeNs: after.mtimeNs,
            culprit,
          });
        }
      } else if (before.type !== after.type) {
        diffs.push({
          path: p,
          kind: "type_changed",
          beforeType: before.type,
          afterType: after.type,
          beforeSha: before.sha,
          afterSha: after.sha,
          mtime: after.mtime,
          mtimeNs: after.mtimeNs,
          culprit,
        });
      } else if (before.type === "file" && after.type === "file") {
        if (before.sha !== after.sha) {
          diffs.push({
            path: p,
            kind: "modified",
            beforeSha: before.sha,
            afterSha: after.sha,
            beforeMtime: before.mtime,
            mtime: after.mtime,
            beforeMtimeNs: before.mtimeNs,
            mtimeNs: after.mtimeNs,
            culprit,
          });
        } else if (
          (before.mtimeNs !== undefined && after.mtimeNs !== undefined && before.mtimeNs !== null && after.mtimeNs !== null)
            ? before.mtimeNs !== after.mtimeNs
            : before.mtime !== after.mtime
        ) {
          diffs.push({
            path: p,
            kind: "touched",
            sha: after.sha,
            beforeSha: before.sha,
            afterSha: after.sha,
            beforeMtime: before.mtime,
            mtime: after.mtime,
            beforeMtimeNs: before.mtimeNs,
            mtimeNs: after.mtimeNs,
            culprit,
          });
        }
      }
    }
  }
  for (const [p, after] of current.entries()) {
    if (!baseline.has(p)) {
      const culprit = culprits.get(p) ?? null;
      if (after.state === "error") {
        diffs.push({
          path: p,
          kind: "unverifiable",
          error: after.error || "unreadable",
          beforeSha: null,
          afterSha: null,
          beforeMtime: null,
          mtime: null,
          beforeMtimeNs: null,
          mtimeNs: null,
          culprit,
        });
      } else if (after.state === "present") {
        diffs.push({
          path: p,
          kind: "added",
          beforeSha: null,
          afterSha: after.sha,
          mtime: after.mtime,
          mtimeNs: after.mtimeNs,
          culprit,
        });
      }
    }
  }
  return {
    changed: diffs.length > 0,
    diffs,
    baseline,
    current,
  };
}

export function formatErrorReport({ diffs = [] } = {}) {
  const lines = ["安装面硬门：套件改动了本机安装面"];
  for (const d of diffs) {
    const culpritPart = d.culprit ? "；肇事用例：「" + d.culprit + "」" : "";
    if (d.kind === "modified") {
      const bSha = d.beforeSha ? d.beforeSha.slice(0, 12) : "n/a";
      const aSha = d.afterSha ? d.afterSha.slice(0, 12) : "n/a";
      lines.push("  - " + d.path + "（sha: " + bSha + " → " + aSha + "，mtime: " + (d.mtime ?? "n/a") + culpritPart + "）");
    } else if (d.kind === "touched") {
      const sha = d.afterSha ? d.afterSha.slice(0, 12) : (d.beforeSha ? d.beforeSha.slice(0, 12) : "n/a");
      const nsPart = d.beforeMtimeNs !== undefined && d.mtimeNs !== undefined && d.beforeMtimeNs !== d.mtimeNs
        ? "，mtimeNs: " + d.beforeMtimeNs + " → " + d.mtimeNs
        : "";
      lines.push("  - " + d.path + "（sha 未变（" + sha + "）但 mtime 被改动: " + (d.beforeMtime ?? "n/a") + " → " + (d.mtime ?? "n/a") + nsPart + culpritPart + "）");
    } else if (d.kind === "unverifiable") {
      lines.push("  - " + d.path + "（读取出错无法验证: " + (d.error ?? "unknown") + culpritPart + "）");
    } else if (d.kind === "symlink_modified") {
      const bSha = d.beforeSha ? d.beforeSha.slice(0, 12) : "n/a";
      const aSha = d.afterSha ? d.afterSha.slice(0, 12) : "n/a";
      lines.push("  - " + d.path + "（链接目标: " + d.beforeTarget + " → " + d.afterTarget + "，sha: " + bSha + " → " + aSha + "，mtime: " + (d.mtime ?? "n/a") + culpritPart + "）");
    } else if (d.kind === "added") {
      const aSha = d.afterSha ? d.afterSha.slice(0, 12) : "n/a";
      lines.push("  - " + d.path + "（新增，sha: " + aSha + "，mtime: " + (d.mtime ?? "n/a") + culpritPart + "）");
    } else if (d.kind === "removed") {
      const bSha = d.beforeSha ? d.beforeSha.slice(0, 12) : "n/a";
      lines.push("  - " + d.path + "（消失，原 sha: " + bSha + culpritPart + "）");
    } else {
      lines.push("  - " + d.path + "（类型变化: " + d.beforeType + " → " + d.afterType + culpritPart + "）");
    }
  }
  return lines.join("\n");
}

export function formatPassReport({ current } = {}) {
  const list = current ? [...current.values()] : [];
  const mainTpl = list.find((e) =>
    e.path.endsWith(path.join(".claude", "feishu-bridge", "chain-config.json"))
  );
  let tplDetail = "";
  if (mainTpl) {
    tplDetail = mainTpl.sha
      ? "chain-config.json sha: " + mainTpl.sha.slice(0, 12)
      : "chain-config.json: absent";
  } else if (list.length > 0) {
    const first = list[0];
    tplDetail = path.basename(first.path) + " sha: " + (first.sha ? first.sha.slice(0, 12) : "absent");
  }
  return "安装面卫兵 : " + list.length + " 个权威文件与启动时一致" + (tplDetail ? "（" + tplDetail + "）" : "");
}

let activeSurfaceGuard = null;
export const currentSurfaceGuard = () => activeSurfaceGuard;

export function installSurfaceGuard({
  home = null,
  files = null,
  out = (s) => process.stdout.write(s),
  outErr = (s) => process.stderr.write(s),
  registerExitHook = true,
} = {}) {
  // PK3-T3-fix2：若已安装默认卫兵且未传入自定义 files/home，复用已有单例避免重复快照与 exit 钩子
  if (activeSurfaceGuard && files === null && home === null && registerExitHook) {
    return activeSurfaceGuard;
  }
  const targetPaths = resolveAuthoritativePaths({ home, files });
  const baseline = takeSurfaceSnapshot(targetPaths);
  let lastSnapshot = baseline;
  const culprits = new Map();
  let reported = false;

  let exitHandler = null;

  const api = {
    baseline,
    targetPaths,
    culprits,
    isReported: () => reported,
    markReported: () => { reported = true; },
    check: () => {
      const current = takeSurfaceSnapshot(targetPaths);
      return diffSurfaceSnapshots(baseline, current, { culprits });
    },
    checkBoundary: (testName) => {
      const current = takeSurfaceSnapshot(targetPaths);
      const diffRes = diffSurfaceSnapshots(lastSnapshot, current);
      lastSnapshot = current;
      if (!diffRes.changed) return null;
      const parts = [];
      for (const d of diffRes.diffs) {
        if (!culprits.has(d.path)) {
          culprits.set(d.path, testName);
        }
        parts.push(path.basename(d.path) + " " + d.kind);
      }
      return "安装面硬门：用例「" + testName + "」改动了本机安装面（" + parts.join("、") + "）";
    },
    formatErrorReport,
    formatPassReport,
    uninstall: () => {
      if (exitHandler) {
        process.removeListener("exit", exitHandler);
        exitHandler = null;
      }
      if (activeSurfaceGuard === api) {
        activeSurfaceGuard = prevGuard;
      }
    },
  };

  if (registerExitHook) {
    exitHandler = () => {
      if (reported) return;
      reported = true;
      const res = api.check();
      if (res.changed) {
        outErr(api.formatErrorReport(res) + "\n");
        process.exitCode = process.exitCode || 1;
      } else {
        out(api.formatPassReport(res) + "\n");
      }
    };
    process.on("exit", exitHandler);
  }

  const prevGuard = activeSurfaceGuard;
  activeSurfaceGuard = api;
  return api;
}
