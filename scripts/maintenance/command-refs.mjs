/**
 * 命令引用解析（issue #81 PR C）—— 预检（hook 命令）与进程盘点（ps 命令行）共用同一份**封闭**判据：
 *
 *   · 先按 shell 操作符切段（; && || | & 换行 ( ) { }），再按引号 / 空白切 token；裸 token 尾部的操作符字符剥掉（`x.mjs;`）。
 *   · 路径：不只看"整个 token 是绝对路径"—— token 里 `=` / `:` / `,` 之后的绝对路径也算（`--import=/x`、`--require=/x`、`NODE_OPTIONS=--require=/x`、
 *     `PATH=/a:/b`），`~/…`、`$HOME/…` 展开后一并 realpath（解析不到的记 real:null）。
 *   · **无法证明安全的执行形状一律标 unsafe**（调用方 fail-closed）：命令替换 `$(…)` / 反引号、`$HOME` 以外的变量、eval / exec / source / `.`、
 *     解释器内联代码（node -e/-p/--eval/--print、python -c、perl / ruby / osascript -e、php -r …）、`-r` / `--require` / `--import` / `--loader` /
 *     `--experimental-loader` 后面不是绝对路径（相对路径或裸模块名按 cwd 解析，说不清）、相对路径 token（./ ../）、shell 的 -c 后面没有可解析的串。
 *   · shell（sh / bash / zsh / dash / ksh）任何**含 c 的短选项**（-c / -lc / -fc / -ic …）或 `--command`：下一个非选项 token 是内联命令串，递归解析（深度 ≤ 3）。
 *   · 被引用的外部脚本**正文**不在模型内（威胁边界，与"同 UID 人工执行克隆"同一条）。
 */
import fs from "node:fs";
import path from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const INLINE_CODE = { node: ["-e", "--eval", "-p", "--print"], python: ["-c"], python3: ["-c"], perl: ["-e", "-E"], ruby: ["-e"], osascript: ["-e"], php: ["-r"], deno: ["eval"], bun: ["-e"] };
const NODE_PATH_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--experimental-default-type"]);
const NODE_PATH_FLAG_PREFIX = /^(--require|--import|--loader|--experimental-loader)=(.*)$/u;
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
/** 文件本身解析不到（进程可能在跑一个已被换掉 / 删掉的脚本）→ 退一步解析它的目录：目录落在运行时之下就算。 */
const realPathOrDir = (p) => realOrNull(p) ?? (() => { const d = realOrNull(path.dirname(p)); return d === null ? null : path.join(d, path.basename(p)); })();

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

/** token 里所有像绝对路径的片段：整个 token、`=` / `:` / `,` 之后的段。 */
export function absolutePathsIn(token, { home }) {
  const out = [];
  const expand = (t) => {
    if (t === "~" || t.startsWith("~/")) return path.join(home ?? "", t.slice(1));
    if (t === "$HOME" || t.startsWith("$HOME/")) return path.join(home ?? "", t.slice("$HOME".length));
    if (t === "${HOME}" || t.startsWith("${HOME}/")) return path.join(home ?? "", t.slice("${HOME}".length));
    return t;
  };
  const whole = expand(token);
  if (path.isAbsolute(whole)) out.push({ raw: token, expanded: whole });
  for (const part of token.split(/[=:,]/u).slice(1)) {
    const e = expand(part);
    if (path.isAbsolute(e)) out.push({ raw: token, expanded: e });
  }
  return out;
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
    const base = path.basename(raw);
    if (raw === "eval" || raw === "exec" || raw === "source" || raw === ".") { unsafe.push(raw === "." ? "source（.）" : raw); continue; }
    if (/\$\{?[A-Za-z_]/u.test(raw.replace(/\$\{?HOME\}?(?=\/|$)/gu, ""))) { unsafe.push("变量 " + raw); continue; }
    if (raw.startsWith("./") || raw.startsWith("../")) { unsafe.push("相对路径 " + raw); continue; }
    for (const p of absolutePathsIn(raw, { home })) paths.push({ raw: p.raw, expanded: p.expanded, real: realPathOrDir(p.expanded) });
    // shell -c（含 -lc / -fc / --command 等）：下一个非选项 token 是内联串，递归
    if (SHELLS.has(base)) {
      let j = k + 1, hasC = false;
      while (j < tokens.length && tokens[j].startsWith("-")) { if (tokens[j] === "--command" || (/^-[A-Za-z]+$/u.test(tokens[j]) && tokens[j].includes("c"))) hasC = true; j += 1; }
      if (hasC) {
        const inner = tokens[j];
        if (typeof inner !== "string" || inner.length === 0) { unsafe.push(base + " -c 后面没有可解析的串"); continue; }
        if (depth >= 3) { unsafe.push("sh -c 嵌套过深"); continue; }
        const sub = analyzeCommandRefs(inner, { home, depth: depth + 1 });
        paths.push(...sub.paths); unsafe.push(...sub.unsafe);
        k = j;
      }
      continue;
    }
    // 解释器内联代码：不能证明它不启动运行时脚本
    const inlineFlags = INLINE_CODE[base];
    if (inlineFlags) {
      for (let j = k + 1; j < tokens.length; j += 1) {
        const t = tokens[j];
        if (inlineFlags.includes(t) || inlineFlags.some((f) => f.startsWith("--") && t.startsWith(f + "="))) { unsafe.push(base + " 内联代码（" + t + "）"); break; }
        if (base === "node" || base === "bun" || base === "deno") {
          const m = NODE_PATH_FLAG_PREFIX.exec(t);
          if (m && !path.isAbsolute(m[2]) && !m[2].startsWith("$HOME") && !m[2].startsWith("~")) { unsafe.push(base + " " + t + " 不是绝对路径"); break; }
          if (NODE_PATH_FLAGS.has(t)) {
            const arg = tokens[j + 1];
            if (typeof arg !== "string" || absolutePathsIn(arg, { home }).length === 0) { unsafe.push(base + " " + t + " 后面不是绝对路径"); break; }
          }
        }
        if (!t.startsWith("-")) break; // 到了脚本 / 正文参数，后面的不再是解释器选项
      }
    }
  }
  return { paths, unsafe };
}

/** refs 里有没有落在任一 root（realpath）之下的路径：返回第一个命中 { raw, real } 或 null。 */
export function refsUnderRoots(refs, rootReals) {
  for (const p of refs.paths) if (p.real !== null && rootReals.some((rr) => p.real === rr || p.real.startsWith(rr + path.sep))) return p;
  return null;
}
