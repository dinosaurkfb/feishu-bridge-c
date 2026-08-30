/**
 * 命令引用解析（issue #81 PR C）—— 预检（hook 命令）与进程盘点（ps 命令行）共用同一份**封闭**判据：
 *
 *   · 切 token：引号、引号外反斜杠转义（`old\ runtime`）、续行；操作符按类别记录而不是丢弃 —— `;` `&&` `||` `&` 换行 `( ) { }` 是分段，
 *     单管道 `|`、输入重定向 `<` `<<` `<<<`（含附着式 `node</x`）记进 operators；未闭合引号 / 尾随反斜杠 → problems。
 *   · 路径投影**无条件**：每个 token 都跑 harvestAbsolutePaths（token 内任意位置的绝对路径片段：`--import=/x`、`NODE_OPTIONS=--require=/x`、
 *     `import("/x")`、`node</x` 都取到），`~` / `$HOME` 展开后一并 realpath；文件本身解析不到就按目录 realpath 再拼文件名。去重。
 *   · **无法证明安全的执行形状一律标 unsafe**（调用方 fail-closed）：管道（右侧可能从 stdin 读代码）、输入重定向 / here-doc / here-string、
 *     命令替换 `$(…)` / 反引号、`$HOME` 以外的变量、eval / exec / source / `.`、解释器内联代码（node -e/-p/--eval/--print 含组合短选项 -pe；
 *     python -c、perl -e/-E、ruby -e、osascript -e、php -r、deno eval、bun -e）、node 从 stdin 读代码（`--input-type`、脚本位是 `-`）、
 *     node 的 -r / --require / --import / --loader 后面不是绝对路径、相对路径 token、shell 带参数或不认识的选项（`-O extglob`、`+O`、`--rcfile`）、
 *     shell -c / env -S 后面没有可解析的串。
 *   · 执行包装器递归（深度 ≤ 3）：shell（sh / bash / zsh / dash / ksh）纯字母短选项簇含 c 或 `--command` 之后的内联串；
 *     `env -S <串>` / `env --split-string=<串>`（env 会把串再拆一层 argv）。
 *   · 被引用的外部脚本**正文**不在模型内（威胁边界，与"同 UID 人工执行克隆"同一条）。
 */
import fs from "node:fs";
import path from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_LONG_NOARG = new Set(["--login", "--norc", "--noprofile", "--posix", "--restricted", "--command"]);
const INLINE_CODE = {
  node: { letters: "ep", long: ["--eval", "--print"] }, bun: { letters: "ep", long: ["--eval", "--print"] }, deno: { letters: "", long: [], words: ["eval"] },
  python: { letters: "c", long: [] }, python3: { letters: "c", long: [] }, perl: { letters: "eE", long: [] }, ruby: { letters: "e", long: [] }, osascript: { letters: "e", long: [] }, php: { letters: "r", long: [] },
};
const NODE_PATH_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--experimental-default-type"]);
const NODE_PATH_FLAG_PREFIX = /^(--require|--import|--loader|--experimental-loader)=(.*)$/u;
const NODE_STDIN = /^(--input-type(=.*)?|--stdin|-)$/u;
const ABS_PATH_IN_TEXT = /\/(?:[^\s"'`()<>;&|,:=[\]{}]+\/)*[^\s"'`()<>;&|,:=[\]{}]+/gu;
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
/** 文件本身解析不到（进程可能在跑一个已被换掉 / 删掉的脚本）→ 退一步解析它的目录：目录落在运行时之下就算。 */
const realPathOrDir = (p) => realOrNull(p) ?? (() => { const d = realOrNull(path.dirname(p)); return d === null ? null : path.join(d, path.basename(p)); })();

/**
 * 严格切 token。返回 { tokens, operators, problems }：operators 记录出现过的类别（pipe / input_redirect / heredoc / herestring），
 * problems 非空 = 解析不了。分段操作符与重定向符号都当分隔（`node</x` 切成 "node" 与 "/x"）。
 */
export function tokenizeCommandStrict(cmd) {
  const tokens = [], problems = [], operators = [];
  let i = 0, cur = "", inTok = false;
  const flush = () => { if (inTok) { tokens.push(cur); cur = ""; inTok = false; } };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\") {
      if (i + 1 >= cmd.length) { problems.push("尾随反斜杠"); break; }
      if (cmd[i + 1] === "\n") { i += 2; continue; }
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
    if (ch === "<") {
      flush();
      if (cmd.startsWith("<<<", i)) { operators.push("herestring"); i += 3; continue; }
      if (cmd.startsWith("<<", i)) { operators.push("heredoc"); i += 2; continue; }
      operators.push("input_redirect"); i += 1; continue;
    }
    if (ch === "|") {
      flush();
      if (cmd[i + 1] === "|") { i += 2; continue; }
      operators.push("pipe"); i += 1; continue;
    }
    if (/\s/u.test(ch)) { flush(); i += 1; continue; }
    if (";&(){}".includes(ch)) { flush(); i += 1; continue; }
    cur += ch; inTok = true; i += 1;
  }
  flush();
  return { tokens, operators, problems };
}
export const tokenizeCommand = (cmd) => tokenizeCommandStrict(cmd).tokens;

const expandHome = (t, home) => {
  if (t === "~" || t.startsWith("~/")) return path.join(home ?? "", t.slice(1));
  if (t === "$HOME" || t.startsWith("$HOME/")) return path.join(home ?? "", t.slice("$HOME".length));
  if (t === "${HOME}" || t.startsWith("${HOME}/")) return path.join(home ?? "", t.slice("${HOME}".length));
  return t;
};
/** 整个 token 是不是绝对路径（含 ~ / $HOME 前缀展开）。token 内嵌的路径片段由 harvestAbsolutePaths 无条件捞，这里不再重复切 = / : / ,。 */
export function absolutePathsIn(token, { home }) {
  const whole = expandHome(token, home);
  return path.isAbsolute(whole) ? [{ raw: token, expanded: whole }] : [];
}
/** 任意文本里的绝对路径片段。 */
export function harvestAbsolutePaths(text) {
  return [...String(text).matchAll(ABS_PATH_IN_TEXT)].map((m) => m[0]);
}

const isShortCluster = (t) => /^-[A-Za-z]+$/u.test(t);

/**
 * @returns {{ paths: { raw:string, expanded:string, real:string|null }[], unsafe: string[] }}
 */
export function analyzeCommandRefs(cmd, { home, depth = 0 } = {}) {
  const paths = [], unsafe = [], seen = new Set();
  const addPath = (raw, expanded) => { if (seen.has(expanded)) return; seen.add(expanded); paths.push({ raw, expanded, real: realPathOrDir(expanded) }); };
  if (typeof cmd !== "string") return { paths, unsafe: ["命令不是字符串"] };
  if (/\$\(|`/u.test(cmd)) unsafe.push("命令替换（$( ) / 反引号）");
  const { tokens, operators, problems } = tokenizeCommandStrict(cmd);
  for (const p of problems) unsafe.push("解析不了（" + p + "）");
  for (const op of new Set(operators)) unsafe.push({ pipe: "管道（右侧可能从 stdin 读代码）", input_redirect: "输入重定向", heredoc: "here-doc", herestring: "here-string" }[op]);
  // 路径投影无条件：每个 token 都捞（内嵌、内联代码串、附着式都取到）
  for (const raw of tokens) {
    for (const p of absolutePathsIn(raw, { home })) addPath(p.raw, p.expanded);
    // 先展开 ~ / $HOME 再捞（否则 $HOME/c.mjs 会多出一个假的 /c.mjs）；含别的变量的 token 只标 unsafe，不捞（展开后是什么说不清）
    if (!/\$\{?[A-Za-z_]/u.test(raw.replace(/\$\{?HOME\}?(?=\/|$)/gu, ""))) for (const h of harvestAbsolutePaths(expandHome(raw, home).replace(/\$\{?HOME\}?(?=\/|$)/gu, home ?? ""))) addPath(raw, h);
  }
  const recurse = (inner, what) => {
    if (typeof inner !== "string" || inner.length === 0) { unsafe.push(what + " 后面没有可解析的串"); return; }
    if (depth >= 3) { unsafe.push(what + " 嵌套过深"); return; }
    const sub = analyzeCommandRefs(inner, { home, depth: depth + 1 });
    for (const p of sub.paths) addPath(p.raw, p.expanded);
    unsafe.push(...sub.unsafe);
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const raw = tokens[k];
    const base = path.basename(raw);
    if (raw === "eval" || raw === "exec" || raw === "source" || raw === ".") { unsafe.push(raw === "." ? "source（.）" : raw); continue; }
    if (/\$\{?[A-Za-z_]/u.test(raw.replace(/\$\{?HOME\}?(?=\/|$)/gu, ""))) { unsafe.push("变量 " + raw); continue; }
    if (raw.startsWith("./") || raw.startsWith("../")) { unsafe.push("相对路径 " + raw); continue; }
    // env：-S / --split-string 把串再拆一层 argv → 递归；-u / -C 吃一个参数；VAR=x 跳过
    if (base === "env") {
      let j = k + 1;
      while (j < tokens.length) {
        const t = tokens[j];
        if (t === "-S" || t === "--split-string") { recurse(tokens[j + 1], "env -S"); j += 2; continue; }
        if (t.startsWith("-S") && t.length > 2) { recurse(t.slice(2), "env -S"); j += 1; continue; }
        if (t.startsWith("--split-string=")) { recurse(t.slice("--split-string=".length), "env -S"); j += 1; continue; }
        if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") { j += 2; continue; }
        if (t.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(t)) { j += 1; continue; }
        break;
      }
      continue;
    }
    // shell：只认纯字母短选项簇（不含 o / O）与无参长选项；其余 unsafe；含 c 的簇 / --command 之后是内联串
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
      if (bad !== null) { unsafe.push(base + " 的选项 " + bad + " 无法证明安全"); break; }
      if (hasC) { recurse(tokens[j], base + " -c"); k = j; }
      continue;
    }
    // 解释器内联代码（含组合短选项）/ 从 stdin 读代码：不能证明它不启动运行时脚本
    const spec = INLINE_CODE[base];
    if (spec) {
      for (let j = k + 1; j < tokens.length; j += 1) {
        const t = tokens[j];
        const inlineHit = (isShortCluster(t) && [...spec.letters].some((l) => t.slice(1).includes(l))) || spec.long.includes(t) || spec.long.some((f) => t.startsWith(f + "=")) || (spec.words ?? []).includes(t);
        if (inlineHit) { unsafe.push(base + " 内联代码（" + t + "）"); break; }
        if (base === "node" || base === "bun" || base === "deno") {
          if (NODE_STDIN.test(t)) { unsafe.push(base + " 从 stdin 读代码（" + t + "）"); break; }
          const m = NODE_PATH_FLAG_PREFIX.exec(t);
          if (m && !path.isAbsolute(m[2]) && !m[2].startsWith("$HOME") && !m[2].startsWith("~")) { unsafe.push(base + " " + t + " 不是绝对路径"); break; }
          if (NODE_PATH_FLAGS.has(t)) {
            const arg = tokens[j + 1];
            if (typeof arg !== "string" || absolutePathsIn(arg, { home }).length === 0) { unsafe.push(base + " " + t + " 后面不是绝对路径"); break; }
          }
        }
        if (!t.startsWith("-")) break;
      }
      if (base === "node" && k === tokens.length - 1 && (operators.includes("pipe") || operators.includes("input_redirect"))) unsafe.push("node 没有脚本参数，代码只能来自 stdin");
    }
  }
  return { paths, unsafe: [...new Set(unsafe)] };
}

/** refs 里有没有落在任一 root（realpath）之下的路径：返回第一个命中 { raw, real } 或 null。 */
export function refsUnderRoots(refs, rootReals) {
  for (const p of refs.paths) if (p.real !== null && rootReals.some((rr) => p.real === rr || p.real.startsWith(rr + path.sep))) return p;
  return null;
}
