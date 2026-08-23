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
import { pathToFileURL } from "node:url";

export function isDirectRun(importMetaUrl) {
  const invoked = process.argv[1];
  if (typeof invoked !== "string" || invoked.length === 0) return false;
  try {
    return pathToFileURL(fs.realpathSync(invoked)).href === importMetaUrl;
  } catch {
    return false;
  }
}
