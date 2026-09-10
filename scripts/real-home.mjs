/**
 * 真实用户 home 叶子（R60 返修一 P1-1）：**唯一一份** passwd 家目录读取。
 *
 * 账本根 / 维护目录 / 维护门三条机器路径的默认派生都走它 —— 会话 $HOME 可以随便改，
 * 这一份不会跟着变（历史泄漏就是从这里漏出去的）。原先 maintenance-gate-core.mjs 与
 * topic-agent-ledger.mjs 各写了一份同构实现，同一个概念两处实现必然分叉。
 *
 * 取不到就是 null（不退回 os.homedir()：那会把"权威路径说不清"折成"去会话 HOME 读"—— fail-open）。
 * 测试注入面：_inject.realUserHome —— **只走参数**，不用环境变量覆盖 passwd home
 *（env 是谁都能设的，一旦能用 env 指走 passwd home，守卫就自证作废了）。
 */
import os from "node:os";
import path from "node:path";

export function realUserHome({ _inject } = {}) {
  if (_inject && typeof _inject.realUserHome === "function") return _inject.realUserHome() ?? null;
  try { const h = os.userInfo().homedir; if (typeof h === "string" && path.isAbsolute(h)) return h; } catch { /* 说不清 */ }
  return null;
}
