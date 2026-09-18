#!/usr/bin/env node
/**
 * 临时目录残留盘点（PK3-T1，**只读**）。
 *
 * 为什么有它：套件往 TMPDIR 泄漏时，omm 的 3.9G tmpfs 两天就撑到 80%，而盘满之后
 * `writeFileSync` 抛的是 `UNKNOWN: unknown error` —— 看不出是盘满（`write-diagnosis.mjs` 负责把
 * 那句话翻译清楚，这个脚本负责告诉人**是谁在占**）。
 *
 * 用法：
 *   node scripts/test-support/tmp-residue.mjs                 # 按前缀聚合：目录数 / 文件数 / 占用
 *   node scripts/test-support/tmp-residue.mjs --top 30        # 多列几个前缀
 *   node scripts/test-support/tmp-residue.mjs --older-than 24 # 只看 24 小时以前创建的（= 陈年残留）
 *   node scripts/test-support/tmp-residue.mjs --dir /tmp      # 换一个 TMPDIR
 *
 * **不删任何东西**（清理是人的决定：这些目录里可能有正在跑的测试 / 别的工具的状态）。
 * 套件自己那条路是 `test-harness.installSuiteTempRoot()`：本轮私有的一棵树，退出时整棵清掉。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" ? args[i + 1] : dflt;
};
const top = Number(argOf("--top", "20"));
const dir = argOf("--dir", os.tmpdir());
const olderThanH = argOf("--older-than", null);
const cutoff = olderThanH === null ? null : Date.now() - Number(olderThanH) * 3600 * 1000;

/** 桶名：去掉 mkdtemp 的 `-<随机串>` 尾巴（保留前面全部段，便于看出是哪个夹具）。 */
const bucketOf = (name) => {
  const m = /^(.*)-\S{6,}$/u.exec(name);
  return m === null ? name : m[1];
};

const usageOf = (target) => {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length > 0) {
    const d = stack.pop();
    let stats = [];
    try { stats = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const st of stats) {
      const p = path.join(d, st.name);
      if (st.isDirectory()) { entries += 1; stack.push(p); }
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch { /* 读不到就不计 */ }
      }
    }
  }
  return { entries, files, bytes };
};

let names = [];
try { names = fs.readdirSync(dir); } catch (err) { console.error("读不出 " + dir + "：" + String(err?.message ?? err)); process.exit(1); }
const buckets = new Map();
let skipped = 0;
for (const name of names) {
  const p = path.join(dir, name);
  let st;
  try { st = fs.lstatSync(p); } catch { skipped += 1; continue; }
  if (!st.isDirectory()) continue;
  if (cutoff !== null && st.mtimeMs >= cutoff) continue;
  const u = usageOf(p);
  const key = bucketOf(name);
  const acc = buckets.get(key) ?? { dirs: 0, files: 0, bytes: 0 };
  buckets.set(key, { dirs: acc.dirs + 1, files: acc.files + u.files, bytes: acc.bytes + u.bytes });
}
const rows = [...buckets.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const total = rows.reduce((acc, [, v]) => ({ dirs: acc.dirs + v.dirs, files: acc.files + v.files, bytes: acc.bytes + v.bytes }), { dirs: 0, files: 0, bytes: 0 });
const mb = (n) => (n / 1048576).toFixed(1) + "MB";
console.log("TMPDIR=" + dir + (cutoff === null ? "" : "（只看 " + olderThanH + " 小时以前创建的）"));
console.log("目录总数 " + total.dirs + " / 文件 " + total.files + " / 占用 " + mb(total.bytes));
if (skipped > 0) console.log("（有 " + skipped + " 个条目读不到，已跳过）");
for (const [k, v] of rows.slice(0, top)) {
  console.log("  " + String(v.dirs).padStart(6) + " 个 " + mb(v.bytes).padStart(10) + "  " + k);
}
console.log("\n只盘点，不删。清理由人决定（或由套件的 installSuiteTempRoot 在退出时清本轮那棵树）。");
