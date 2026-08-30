/**
 * 命令引用解析（issue #81 PR C）—— 预检（hook 命令）与进程盘点（ps 命令行）共用同一份**封闭**判据：
 *
 *   · 先按 shell 操作符切段（; && || | & 换行 ( ) { }），再按引号 / 空白切 token；引号外的反斜杠转义（`old\ runtime`）按 shell 规则处理，
 *     未闭合的引号 / 尾随反斜杠 → 解析不了（unsafe）；裸 token 尾部的操作符字符剥掉（`x.mjs;`）。
 *   · 路径：不只看"整个 token 是绝对路径"—— token 里 `=` / `:` / `,` 之后的绝对路径也算（`--import=/x`、`NODE_OPTIONS=--require=/x`、`PATH=/a:/b`），
 *     `~/…`、`$HOME/…` 展开；**内联代码串里的绝对路径也捞出来**（`node -pe 'import("/x")'`）—— 预检会因内联代码 unsafe 而拒，进程盘点靠这些路径认出它。
 *     全部 realpath；文件本身解析不到（进程可能在跑已被换掉 / 删掉的脚本）就按目录 realpath 再拼文件名。
 *   · **无法证明安全的执行形状一律标 unsafe**（调用方 fail-closed）：命令替换 `$(…)` / 反引号、`$HOME` 以外的变量、eval / exec / source / `.`、
 *     解释器内联代码（node 的 -e / -p / --eval / --print，**含组合短选项 -pe / -ep**；python -c、perl -e/-E、ruby -e、osascript -e、php -r、deno eval、bun -e，
 *     同样含组合短选项）、node 的 -r / --require / --import / --loader / --experimental-loader 后面不是绝对路径、相对路径 token（./ ../）、
 *     shell 带参数的选项或不认识的长选项（`-O extglob`、`-o pipefail`、`+O`、`--rcfile …`）、shell 的 -c 后面没有可解析的串。
 *   · shell（sh / bash / zsh / dash / ksh）只认**纯字母短选项簇**（-c / -lc / -fc / -ic …，簇里不能有 o / O）与无参长选项（--login --norc --noprofile --posix --restricted --command）；
 *     含 c 的簇或 --command 之后第一个非选项 token 是内联命令串，递归解析（深度 ≤ 3）。
 *   · 被引用的外部脚本**正文**不在模型内（威胁边界，与"同 UID 人工执行克隆"同一条）。
 */
import fs from "node:fs";
import path from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_LONG_NOARG = new Set(["--login", "--norc", "--noprofile", "--posix", "--restricted", "--command"]);
/** 解释器：内联代码的短选项字母（组合簇里出现即算）与长选项。 */
const INLINE_CODE = {
  node: { letters: "ep", long: ["--eval", "--print"] }, bun: { letters: "ep", long: ["--eval", "--print"] }, deno: { letters: "", long: [], words: ["eval"] },
  python: { letters: "c", long: [] }, python3: { letters: "c", long: [] }, perl: { letters: "eE", long: [] }, ruby: { letters: "e", long: [] }, osascript: { letters: "e", long: [] }, php: { letters: "r", long: [] },
};
const NODE_PATH_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--experimental-default-type"]);
const NODE_PATH_FLAG_PREFIX = /^(--require|--import|--loader|--experimental-loader)=(.*)$/u;
const ABS_PATH_IN_TEXT = /\/(?:[^\s"'`()<>;&|,:=[\]{}]+\/)*[^\s"'`()<>;&|,:=[\]{}]+/gu;
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
/** 文件本身解析不到（进程可能在跑一个已被换掉 / 删掉的脚本）→ 退一步解析它的目录：目录落在运行时之下就算。 */
const realPathOrDir = (p) => realOrNull(p) ?? (() => { const d = realOrNull(path.dirname(p)); return d === null ? null : path.join(d, path.basename(p)); })();

/**
 * 严格切 token：引号、引号外反斜杠转义、操作符分隔。返回 { tokens, problems }（problems 非空 = 解析不了，调用方 fail-closed）。
 */
export function tokenizeCommandStrict(cmd) {
  const tokens = [], problems = [];
  let i = 0, cur = "", inTok = false;
  const flush = () => { if (inTok) { tokens.push(cur); cur = ""; inTok = false; } };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\") {
      if (i + 1 >= cmd.length) { problems.push("尾随反斜杠"); break; }
      if (cmd[i + 1] === "\n") { i += 2; continue; } // 续行
      cur += cmd[i + 1]; inTok = true; i += 2; continue;
    }
    if (ch === "'" || ch === "\"") {
      const q = ch; let j = i + 1, closed = false;
      while (j < cmd.length) {
        if (cmd[j] === q) { closed = true; break; }
        if (q === "\"" && cmd[j] === "\\" && j + 1 < cmd.length && "\"\\$`\n".includes(cmd[j + 1])) { cur += cmd[j + 1]; j += 2; continue; }
        cur += cmd[j]; j += 1;
      }
      if (!closed) { problems.push("未闭合的引号"); inTok = true; break; }
      inTok = true; i = j + 1; continue;
    }
    if (/\s/u.test(ch)) { flush(); i += 1; continue; }
    if (";&|(){}".includes(ch)) { flush(); i += 1; continue; }
    cur += ch; inTok = true; i += 1;
  }
  flush();
  return { tokens, problems };
}
export const tokenizeCommand = (cmd) => tokenizeCommandStrict(cmd).tokens;

const expandHome = (t, home) => {
  if (t === "~" || t.startsWith("~/")) return path.join(home ?? "", t.slice(1));
  if (t === "$HOME" || t.startsWith("$HOME/")) return path.join(home ?? "", t.slice("$HOME".length));
  if (t === "${HOME}" || t.startsWith("${HOME}/")) return path.join(home ?? "", t.slice("${HOME}".length));
  return t;
};
/** token 里所有像绝对路径的片段：整个 token、`=` / `:` / `,` 之后的段。 */
export function absolutePathsIn(token, { home }) {
  const out = [];
  const whole = expandHome(token, home);
  if (path.isAbsolute(whole)) out.push({ raw: token, expanded: whole });
  for (const part of token.split(/[=:,]/u).slice(1)) {
    const e = expandHome(part, home);
    if (path.isAbsolute(e)) out.push({ raw: token, expanded: e });
  }
  return out;
}
/** 任意文本（内联代码串）里的绝对路径片段。 */
export function harvestAbsolutePaths(text) {
  return [...String(text).matchAll(ABS_PATH_IN_TEXT)].map((m) => m[0]);
}

const isShortCluster = (t) => /^-[A-Za-z]+$/u.test(t);

/**
 * @returns {{ paths: { raw:string, expanded:string, real:string|null }[], unsafe: string[] }}
 */
export function analyzeCommandRefs(cmd, { home, depth = 0 } = {}) {
  const paths = [], unsafe = [];
  const addPath = (raw, expanded) => paths.push({ raw, expanded, real: realPathOrDir(expanded) });
  if (typeof cmd !== "string") return { paths, unsafe: ["命令不是字符串"] };
  if (/\$\(|`/u.test(cmd)) unsafe.push("命令替换（$( ) / 反引号）");
  const { tokens, problems } = tokenizeCommandStrict(cmd);
  for (const p of problems) unsafe.push("解析不了（" + p + "）");
  for (let k = 0; k < tokens.length; k += 1) {
    const raw = tokens[k];
    const base = path.basename(raw);
    if (raw === "eval" || raw === "exec" || raw === "source" || raw === ".") { unsafe.push(raw === "." ? "source（.）" : raw); continue; }
    if (/\$\{?[A-Za-z_]/u.test(raw.replace(/\$\{?HOME\}?(?=\/|$)/gu, ""))) { unsafe.push("变量 " + raw); for (const h of harvestAbsolutePaths(raw)) addPath(raw, h); continue; }
    if (raw.startsWith("./") || raw.startsWith("../")) { unsafe.push("相对路径 " + raw); continue; }
    for (const p of absolutePathsIn(raw, { home })) addPath(p.raw, p.expanded);
    // shell：只认纯字母短选项簇（不含 o / O）与无参长选项；其余选项形状 unsafe；含 c 的簇 / --command 之后是内联串
    if (SHELLS.has(base)) {
      let j = k + 1, hasC = false, bad = null;
      while (j < tokens.length && (tokens[j].startsWith("-") || tokens[j].startsWith("+"))) {
        const t = tokens[j];
        if (t === "--command") hasC = true;
        else if (SHELL_LONG_NOARG.has(t)) { /* 无参 */ }
        else if (isShortCluster(t) && !/[oO]/u.test(t)) { if (t.includes("c")) hasC = true; }
        else { bad = t; break; }
        j += 1;
      }
      if (bad !== null) { unsafe.push(base + " 的选项 " + bad + " 无法证明安全"); for (const t of tokens.slice(j)) for (const h of harvestAbsolutePaths(t)) addPath(t, h); break; }
      if (hasC) {
        const inner = tokens[j];
        if (typeof inner !== "string" || inner.length === 0) { unsafe.push(base + " -c 后面没有可解析的串"); continue; }
        if (depth >= 3) { unsafe.push("sh -c 嵌套过深"); for (const h of harvestAbsolutePaths(inner)) addPath(inner, h); continue; }
        const sub = analyzeCommandRefs(inner, { home, depth: depth + 1 });
        paths.push(...sub.paths); unsafe.push(...sub.unsafe);
        k = j;
      }
      continue;
    }
    // 解释器内联代码（含组合短选项）：不能证明它不启动运行时脚本；但内联串里的绝对路径要捞出来给盘点用
    const spec = INLINE_CODE[base];
    if (spec) {
      for (let j = k + 1; j < tokens.length; j += 1) {
        const t = tokens[j];
        const inlineHit = (isShortCluster(t) && [...spec.letters].some((l) => t.slice(1).includes(l))) || spec.long.includes(t) || spec.long.some((f) => t.startsWith(f + "=")) || (spec.words ?? []).includes(t);
        if (inlineHit) {
          unsafe.push(base + " 内联代码（" + t + "）");
          for (const rest of tokens.slice(j)) for (const h of harvestAbsolutePaths(rest)) addPath(rest, h);
          break;
        }
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
