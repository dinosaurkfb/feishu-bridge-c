#!/usr/bin/env node
/**
 * 只读查看当前上下文的飞书接入状态。不改任何东西，也不打印 locator。
 *
 * 「当前上下文」= 这条工作线（如果它单独绑过），否则 = 这个项目。用的是跟出站
 * 完全同一条选择规则 —— 状态命令要是按另一套规则找，就会出现「status 说绑的是 A、
 * 实际发到 B」这种最难查的不一致。
 *
 * 用法：node scripts/feishu-status.mjs [--project ~/x]
 */

import path from "node:path";

import { bindingsForRoot, currentBinding, describeStatus } from "./feishu-control.mjs";

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const root = path.resolve(arg("project") ?? process.cwd());
const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;

const st = currentBinding({ root, claudeSessionId });
console.log(describeStatus(st, bindingsForRoot({ root })));
process.exit(0);
