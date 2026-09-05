/**
 * 规范字节唯一判据（#R40 P1-5）：renderer、比较器、落盘器共用同一稳定规范化函数。
 * 普通 JSON.stringify 受键插入顺序影响 —— 同一语义的两个对象序列化字节不同，
 * 幂等写会误判 conflict/changed。这里递归排序对象键后再序列化（T4 renderer 同一判据）。
 */

const sortValue = (v) => {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortValue(v[k])]));
  }
  return v;
};

/** 递归稳定排序的 JSON 序列化 —— 语义相同的对象字节恒等。 */
export function stableStringify(value, space) {
  return JSON.stringify(sortValue(value), null, space);
}

/** policy.json 落盘/比对的唯一字节判据：稳定排序 + 固定布局 + 尾换行。 */
export const canonicalPolicyContent = (endpointId, entries) =>
  stableStringify({ schema_version: "policy-1", endpoint_id: endpointId, entries }, 2) + "\n";
