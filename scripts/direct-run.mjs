/**
 * 「这个模块是被直接执行的，还是被 import 的？」
 *
 * 原来各文件各写一遍 `import.meta.url === "file://" + process.argv[1]`。它在开发克隆里
 * 一直成立，装到 runtime 之后**全部失效** —— 因为钩子走的是符号链接
 * `runtime/current/scripts/x.mjs`，而 `import.meta.url` 给的是解析过符号链接的真实路径
 * `runtime/versions/<版本>/scripts/x.mjs`，`process.argv[1]` 给的是调用时那个。两者不等，
 * 于是 main() 从不执行，脚本静默 exit 0：出站入站钩子同时变成空转，且不留任何日志。
 *
 * 2026-08-23 切到 runtime 当天就是这么断的。所以判据必须两边都取真实路径再比。
 * 顺带把 `"file://" + path` 这种手工拼串也换掉 —— 路径里有空格或非 ASCII 时它拼不对。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function isDirectRun(importMetaUrl) {
  const invoked = process.argv[1];
  if (typeof invoked !== "string" || invoked.length === 0) return false;
  try {
    return pathToFileURL(fs.realpathSync(invoked)).href === importMetaUrl;
  } catch {
    return false;
  }
}

/**
 * 模块自己所在的目录。**别用 `new URL(import.meta.url).pathname`。**
 *
 * 那个属性给的是 URL 里的路径分量，仍是百分号编码的：目录名含空格或中文时会拿到
 * `/…/%E5%B8%A6%20%E7%A9%BA%E6%A0%BC`，拿去读文件直接 ENOENT。实测过。
 * Frank 现在的路径全是 ASCII 所以一直没爆，但 runtime 装在 `~/.claude/...` 下、
 * 而 home 目录名是用户可控的 —— 这是颗定时炸弹，不是理论问题。
 *
 * `fileURLToPath` 会正确解码，并且在 Windows 上也给出合法路径。
 */
export function moduleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/** 模块所在目录往上若干层，用来定位仓库根。 */
export function moduleRoot(importMetaUrl, ...up) {
  return path.resolve(moduleDir(importMetaUrl), ...up);
}
