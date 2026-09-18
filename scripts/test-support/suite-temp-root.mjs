/**
 * 套件私有的临时目录根（PK3-T1）。
 *
 * 放在 `scripts/test-support/` 而不是 `test-harness.mjs`：后者是**共用模块**（`scripts/codex/*.mjs`
 * 直接 import 它，面被 `references/shared-surface.json` 快照盯着），往里加导出会改共用面；
 * 而这一节只服务测试面。注册器仍然用它（`currentSuiteTempRoot()`），只是不从 test-harness 再导出一次。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { humanBytes } from "./write-diagnosis.mjs";

// ── PK3-T1：套件的临时目录根 + 残留回收 ────────────────────────────────────────────────
/**
 * 本轮套件私有的 TMPDIR 根。**这一节只服务测试面**（不改产品语义：产品不读 TMPDIR 根、不认这些名字）。
 *
 * 为什么要有它：夹具到处 `mkdtemp(os.tmpdir())`，一轮全量在 omm 的 3.9G tmpfs 上留下
 * ~426MB / 1142 个目录（Mac 实测，见 PI-REPORT）。两天几轮就把 tmpfs 撑到 80%，而**盘满之后
 * `writeFileSync` 抛的是 `UNKNOWN: unknown error`** —— 看起来像用例逻辑坏了或 node 的 bug。
 *
 * 做法：把 `TMPDIR` 指到本轮私有的一棵树（名字带 pid + 随机串），
 *   · 每条用例结束时回收**该用例新造**的顶层条目（用例自己收尾，不给盘上堆着）；
 *   · 汇总时把整棵树清掉并在汇总里打印「清理残留 N 个 / M MB」，仍留下的按名列出；
 *   · 进程退出时还有一道兜底（走 process.exit 的路径也清）。
 * **只清这一棵**：不扫前缀、不按名字猜 —— 所以不可能误删别的进程 / 别的轮次的产物。
 */
let suiteTempRoot = null;   // installSuiteTempRoot() 设置；createTestHarness 通过 currentSuiteTempRoot() 读它

/** 给注册器（test-harness）读：本轮临时根；没装 → null。 */
export const currentSuiteTempRoot = () => suiteTempRoot;

/** 目录树：顶层条目数 / 文件数 / 总字节（只用于报告）。 */
function treeUsage(dir) {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (d === dir) entries += 1;
      if (e.isDirectory()) stack.push(p);
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch { /* 读不到就不计 */ }
      }
    }
  }
  return { entries, files, bytes };
}

/** 清掉这棵树；清不干净就把**还留在盘上的路径**列出来（最多 5 条，供人处置）。 */
function sweepTempRoot(root) {
  const before = treeUsage(root);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 下面按实际状态报 */ }
  const leftovers = [];
  if (fs.existsSync(root)) {
    const stack = [root];
    while (stack.length > 0 && leftovers.length < 5) {
      const d = stack.pop();
      let names = [];
      try { names = fs.readdirSync(d); } catch { leftovers.push(d); continue; }
      for (const n of names) {
        const p = path.join(d, n);
        try { (fs.lstatSync(p).isDirectory() ? stack : leftovers).push(p); } catch { leftovers.push(p); }
      }
    }
  }
  return { root, ...before, leftovers };
}

/** 汇总里那一行：清理结果 + 仍留下的名字。 */
export const formatSuiteTempReport = (r) =>
  "临时目录 : 清掉本轮残留 " + r.entries + " 个 / " + humanBytes(r.bytes) + "（" + r.files + " 个文件" +
  (r.leftovers.length === 0 ? "" : "；**仍留下 " + r.leftovers.length + " 个**：" + r.leftovers.join("、")) + "）";

/**
 * 建立本轮的临时根并接管 TMPDIR。套件启动时**在第一条 test 之前**调一次（要和 installTestHomeIsolation
 * 一样早 —— 它自己也用 os.tmpdir() 造套件 HOME，落在这棵树里就被一起收走）。
 */
export function installSuiteTempRoot({ env = process.env, out = (s) => process.stdout.write(s), prefix = "feishu-suite-run" } = {}) {
  const hostTmp = os.tmpdir();   // 改之前读：这是宿主 TMPDIR
  const root = fs.realpathSync(fs.mkdtempSync(path.join(hostTmp, prefix + "-" + process.pid + "-")));
  env.TMPDIR = root;
  let swept = null;
  const api = {
    root,
    snapshot: () => { try { return new Set(fs.readdirSync(root)); } catch { return null; } },
    reclaimSince: (snap) => {
      if (snap === null) return 0;
      let n = 0;
      try {
        for (const name of fs.readdirSync(root)) {
          if (snap.has(name)) continue;
          try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); n += 1; } catch { /* 留到汇总那道兜底 */ }
        }
      } catch { /* 根没了就不再管 */ }
      return n;
    },
    sweep: () => { if (swept === null) swept = sweepTempRoot(root); return swept; },
  };
  // 兜底：任何 process.exit 路径（async 用例闸门、汇总失败、Ctrl-C 之外的显式退出）都扫一次。
  process.on("exit", () => {
    if (swept !== null) return;   // 汇总已经清过并打过报告
    const r = api.sweep();
    if (r.entries > 0 || r.leftovers.length > 0) out(formatSuiteTempReport(r) + "\n");
  });
  suiteTempRoot = api;
  return api;
}

