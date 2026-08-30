/**
 * 命令引用解析（issue #81 PR C）—— 预检（hook 命令）与进程盘点（ps 命令行）共用同一份判据：
 *
 *   · 先按 shell 操作符切段（; && || | & 换行 ( ) { }），再按引号 / 空白切 token；裸 token 尾部的操作符字符剥掉（`x.mjs;`）。
 *   · 路径 token：绝对路径、`~/…`、`$HOME/…` 展开后 realpath（解析不到的记 real:null）。
 *   · **无法证明安全的写法一律标 unsafe**（调用方 fail-closed）：命令替换 `$(…)` / 反引号、`$HOME` 以外的变量、eval、`sh -c` 后面没有可解析的串。
 *   · `sh|bash|zsh|dash -c '<串>'` 递归解析内联串（深度 ≤ 3）；被引用的外部脚本**正文**不在模型内（威胁边界，与"同 UID 人工执行克隆"同一条）。
 */
import fs from "node:fs";
import path from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/** 按引号 / 空白切 token；操作符（; && || | & 换行 ( ) { }）作为分隔并丢弃；裸 token 尾部的操作符字符剥掉。 */
export function tokenizeCommand(cmd) {
  const tokens = [];
  let i = 0, cur = "", inTok = false;
  const flush = () => { if (inTok) { tokens.push(cur); cur = ""; inTok = false; } };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'" || ch === "\"") {
      const q = ch; let j = i + 1;
      while (j < cmd.length && cmd[j] !== q) { if (q === "\"" && cmd[j] === "\\" && j + 1 < cmd.length) j += 1; cur += cmd[j]; j += 1; }
      inTok = true; i = j + 1; continue;
    }
    if (/\s/u.test(ch)) { flush(); i += 1; continue; }
    if (";&|(){}".includes(ch)) { flush(); i += 1; continue; }
    cur += ch; inTok = true; i += 1;
  }
  flush();
  return tokens;
}

/**
 * @returns {{ paths: { raw:string, expanded:string, real:string|null }[], unsafe: string[] }}
 */
export function analyzeCommandRefs(cmd, { home, depth = 0 } = {}) {
  const paths = [], unsafe = [];
  if (typeof cmd !== "string") return { paths, unsafe: ["命令不是字符串"] };
  if (/\$\(|`/u.test(cmd)) unsafe.push("命令替换（$( ) / 反引号）");
  const tokens = tokenizeCommand(cmd);
  for (let k = 0; k < tokens.length; k += 1) {
    const raw = tokens[k];
    if (raw === "eval") { unsafe.push("eval"); continue; }
    let t = raw;
    if (t.startsWith("~/") || t === "~") t = path.join(home ?? "", t.slice(1));
    if (t.startsWith("$HOME/") || t === "$HOME") t = path.join(home ?? "", t.slice("$HOME".length));
    if (t.startsWith("${HOME}/") || t === "${HOME}") t = path.join(home ?? "", t.slice("${HOME}".length));
    if (/\$\{?[A-Za-z_]/u.test(t)) { unsafe.push("变量 " + raw); continue; }
    if (path.isAbsolute(t)) paths.push({ raw, expanded: t, real: realOrNull(t) });
    // sh -c '<inline>'：递归解析内联串
    if (SHELLS.has(path.basename(t)) && tokens[k + 1] === "-c") {
      const inner = tokens[k + 2];
      if (typeof inner !== "string" || inner.length === 0) { unsafe.push(path.basename(t) + " -c 后面没有可解析的串"); continue; }
      if (depth >= 3) { unsafe.push("sh -c 嵌套过深"); continue; }
      const sub = analyzeCommandRefs(inner, { home, depth: depth + 1 });
      paths.push(...sub.paths); unsafe.push(...sub.unsafe);
      k += 2;
    }
  }
  return { paths, unsafe };
}

/** refs 里有没有落在任一 root（realpath）之下的路径：返回第一个命中 { raw, real } 或 null。 */
export function refsUnderRoots(refs, rootReals) {
  for (const p of refs.paths) if (p.real !== null && rootReals.some((rr) => p.real === rr || p.real.startsWith(rr + path.sep))) return p;
  return null;
}
