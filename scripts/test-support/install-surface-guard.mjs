/**
 * PK3-T3：套件级安装面卫兵（issue #233）。
 *
 * 启动时（installTestHomeIsolation 之前，用 os.userInfo().homedir 而非 HOME 取真实家目录）
 * 快照真实 ~/.claude/feishu-bridge 权威文件与 settings / Codex 模板的 sha256：
 *   1. ~/.claude/feishu-bridge/chain-config.json
 *   2. ~/.claude/feishu-bridge/registry.json
 *   3. ~/.claude/feishu-bridge/routes.json
 *   4. ~/.claude/feishu-bridge/status-providers.json
 *   5. ~/.claude/feishu-bridge/subscriptions.json
 *   6. ~/.claude/feishu-bridge/runtime/current（符号链接目标）
 *   7. ~/.claude/settings.json
 *   8. ~/.codex/feishu-bridge/chain-config.json
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

export function resolveAuthoritativePaths({ home = os.userInfo().homedir, files = null } = {}) {
  if (Array.isArray(files)) {
    return files.map((f) => path.resolve(f));
  }
  return DEFAULT_AUTHORITATIVE_FILES.map((rel) => path.join(home, rel));
}

export function snapshotFile(filepath) {
  const p = path.resolve(filepath);
  try {
    const st = fs.lstatSync(p);
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
    if (before.state === "absent" && after.state === "present") {
      diffs.push({
        path: p,
        kind: "added",
        beforeSha: null,
        afterSha: after.sha,
        mtime: after.mtime,
        culprit,
      });
    } else if (before.state === "present" && after.state === "absent") {
      diffs.push({
        path: p,
        kind: "removed",
        beforeSha: before.sha,
        afterSha: null,
        mtime: null,
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
          culprit,
        });
      } else if (before.type === "file" && after.type === "file") {
        if (before.sha !== after.sha) {
          diffs.push({
            path: p,
            kind: "modified",
            beforeSha: before.sha,
            afterSha: after.sha,
            mtime: after.mtime,
            culprit,
          });
        }
      }
    }
  }
  for (const [p, after] of current.entries()) {
    if (!baseline.has(p) && after.state === "present") {
      diffs.push({
        path: p,
        kind: "added",
        beforeSha: null,
        afterSha: after.sha,
        mtime: after.mtime,
        culprit: culprits.get(p) ?? null,
      });
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
  const realHome = home ?? os.userInfo().homedir;
  const targetPaths = resolveAuthoritativePaths({ home: realHome, files });
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
