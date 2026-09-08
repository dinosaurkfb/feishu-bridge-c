/**
 * 规范化 JSON 键序与摘要叶子模块（无环基石）
 * 专供维护模块与账本模块复用，零上层依赖。
 */
import crypto from "node:crypto";

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 规范化（键排序递归）后 JSON —— 用于目标/证明的稳定比较（评审 G6/G7：不能用键序敏感的 JSON.stringify）。 */
export const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : isObj(v)
    ? Object.keys(v).sort().reduce((o, k) => {
        o[k] = stable(v[k]);
        return o;
      }, {})
    : v;

export const canonKey = (v) => JSON.stringify(stable(v));

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
