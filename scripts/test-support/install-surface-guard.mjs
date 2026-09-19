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
 * 为什么不整文件比对 settings.json（PK3-I244）：
 *   `~/.claude/settings.json` 也**不是"只有装机才写"**的文件 —— Claude Code 运行时会自己改写它
 *   （切模型 / effortLevel、以及"总是允许"这一类权限确认都会写）。2026-09-19 06:42:43Z 一次验收，
 *   真 settings.json 被运行时改写，卫兵把这算到了当时正在跑的用例头上（`settings.json modified`），
 *   全量红 1 条、单跑 3 次全绿 —— 与 T3-fix1 把 registry.json 移出清单是同一类问题（那次我没找同类）。
 *   所以这一个文件按**本桥拥有的条目**判：`claudeSettingsOwnedEntries`（安装收据 / 卸载足迹用的同一份
 *   提取器）的结果做规范化序列化后取 sha；model / effortLevel / permissions / theme / 别人的 hooks
 *   怎么变都不算。**读不出 / 解析不了（坏 JSON）仍是 fail-closed 的 unverifiable**，不因为"只看条目"
 *   就把读不出折成"没变"。其余 6 个文件照旧整文件比对。
 *   也**不为此放宽 mtimeNs**：本桥条目没变就不报（连 touched 也不报 —— 运行时写一次 mtime 天天会变），
 *   条目变了就报 modified。
 *   投影要碰产品提取器，**只能在比对时惰性加载**（PK3-I244-fix1）：卫兵是三条正式入口的第一条 import，
 *   顶层静态 import 产品模块会让它的依赖树在基线快照之前求值 —— 那正好会放过"import 阶段写盘的产品模块"
 *   （T3-fix2 那条反例要钉的形状）。
 *
 * 监控根只认 os.userInfo().homedir（PK3-T3-fix4：不读任何环境变量，残留变量不能改根；
 * 测试要换根只能显式传 home / files）。符号链接除目标外也比 lstat mtimeNs：同目标重建算 touched。
 *
 * 逐用例边界核验：在 harness reclaimSince 旁比对，命中时记录肇事用例名；
 * 汇总 / 退出兜底：重算比对，变了就打「安装面硬门：套件改动了本机安装面」并置退出码非 0。
 * 只报不改、不恢复。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** settings.json 的**判定身份**：投影按本桥条目算（PK3-I244）。路径形状 = `<home>/.claude/settings.json`。 */
const SETTINGS_SUFFIX = path.join(".claude", "settings.json");
const isClaudeSettingsPath = (p) => p.endsWith(SETTINGS_SUFFIX);
/** 从路径反推 home：`<home>/.claude/settings.json` —— 注入 files 的场景也成立。 */
const settingsHomeOf = (p) => path.dirname(path.dirname(p));

/**
 * 产品提取器**只能惰性加载**（PK3-I244-fix1）。
 *
 * 卫兵经 `install-surface-boot.mjs` 是三个正式入口的**第一条 import**；T3-fix2 的合同是
 * 「boot 的依赖只有卫兵与 Node 内置模块，基线快照先于一切产品模块求值」。顶层静态 import 产品模块会让
 * `install-projection.mjs` 及其整棵依赖树在快照**之前**求值 —— 那种 import 阶段写盘的产品模块就会被当成
 * 初始基线（正是 fix2 那条"假产品模块在 import 阶段写权威文件"反例要钉的形状）。
 * 所以这里第一次**比对**时才同步加载一次（`require(esm)`，Node 22+；本仓 Node 26）。
 */
const requireFromHere = createRequire(import.meta.url);
let ownedEntriesExtractor = null;
const ownedEntriesFn = () => {
  if (ownedEntriesExtractor === null) {
    ownedEntriesExtractor = requireFromHere("../install-projection.mjs").claudeSettingsOwnedEntries;
  }
  return ownedEntriesExtractor;
};

/**
 * 一个 settings.json 快照的**本桥条目投影 sha**（PK3-I244）。提取器只有一份（安装收据 / 卸载足迹用的
 * 同一份）；坏 JSON / 读不出 → 返回 null，调用方按 **unverifiable** 处置（fail-closed，不折成"没变"）。
 * 四个键固定、数组顺序有意义，原样序列化 —— 只求"两侧同法即可比"。
 */
const ownedSettingsShaOf = (entry) => {
  if (entry === null || entry === undefined || entry.state !== "present" || typeof entry.rawText !== "string") return null;
  let owned = null;
  try { owned = ownedEntriesFn()(entry.rawText, { home: settingsHomeOf(entry.path) }); }
  catch { return null; }          // 连提取都跑不动（极端环境）→ 同样是"验不了"
  if (owned === null) return null;
  const parts = ["Stop", "inbound", "init", "allow"].map((k) => k + "=" + JSON.stringify(owned[k] ?? null));
  return crypto.createHash("sha256").update("claude-settings-owned:" + parts.join("\n")).digest("hex");
};

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
  // PK3-T3-fix4：默认 boot 只认 os.userInfo().homedir，不读任何环境变量——残留变量不得把三个正式入口的
  // 卫兵指向别处；测试要换根只能显式传 home / files（Codex 三轮 P1）。
  const realHome = home ?? os.userInfo().homedir;
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
    // PK3-I244：settings.json 的**判定身份**是本桥拥有的条目 —— 但快照这一步只存**原始字节与文本**：
    // 投影（要碰产品提取器）留到**比对时**做，卫兵启动阶段不加载任何产品模块（见上面 ownedEntriesFn）。
    if (isClaudeSettingsPath(p)) {
      return {
        path: p,
        state: "present",
        type: "file",
        projection: "claude-settings-owned",
        symlinkTarget: null,
        sha: crypto.createHash("sha256").update(buf).digest("hex"),   // 原始字节 sha（诊断/报告用）
        rawText: buf.toString("utf-8"),
        mtime: st.mtime.toISOString(),
        mtimeNs: st.mtimeNs,
      };
    }
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
        projection: after.projection ?? before.projection ?? null,
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
        } else if (
          // PK3-T3-fix4：同目标重建（unlink + symlink 到同一目标）与普通文件同字节重写同口径——
          // 链接本身的 lstat mtimeNs 变了就算 touched，不因目标未变而假绿（Codex 三轮 P2）。
          (before.mtimeNs !== undefined && after.mtimeNs !== undefined && before.mtimeNs !== null && after.mtimeNs !== null)
            ? before.mtimeNs !== after.mtimeNs
            : before.mtime !== after.mtime
        ) {
          diffs.push({
            path: p,
            kind: "touched",
            symlinkTarget: after.symlinkTarget,
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
        // PK3-I244：投影文件（settings.json）**在比对时**才算本桥条目 —— 基线文本与当前文本各投影一次。
        // 这一支**不比 mtime**：运行时改写 model / effort 会天天动它的 mtime，而本桥条目没变。
        if (before.projection === "claude-settings-owned" || after.projection === "claude-settings-owned") {
          const beforeOwned = ownedSettingsShaOf(before);
          const afterOwned = ownedSettingsShaOf(after);
          if (beforeOwned === null || afterOwned === null) {
            // 投影不出来（坏 JSON / 读不出）→ **unverifiable**（fail-closed），不折成"没变"
            diffs.push({
              path: p,
              kind: "unverifiable",
              projection: "claude-settings-owned",
              error: "settings_owned_unreadable（settings.json 解析不了，本桥条目取不出来）",
              beforeSha: beforeOwned,
              afterSha: afterOwned,
              beforeMtime: before.mtime,
              mtime: after.mtime,
              beforeMtimeNs: before.mtimeNs,
              mtimeNs: after.mtimeNs,
              culprit,
            });
          } else if (beforeOwned !== afterOwned) {
            diffs.push({
              path: p,
              kind: "modified",
              projection: "claude-settings-owned",
              beforeSha: beforeOwned,
              afterSha: afterOwned,
              beforeMtime: before.mtime,
              mtime: after.mtime,
              beforeMtimeNs: before.mtimeNs,
              mtimeNs: after.mtimeNs,
              culprit,
            });
          }
        } else if (before.sha !== after.sha) {
          diffs.push({
            path: p,
            kind: "modified",
            projection: null,
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
      const proj = d.projection === "claude-settings-owned" ? "本桥条目 sha: " : "sha: ";
      lines.push("  - " + d.path + "（" + proj + bSha + " → " + aSha + "，mtime: " + (d.mtime ?? "n/a") + culpritPart + "）");
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
