/**
 * R57c：owner_select 候选解析（owner-select-route.md §5——纯函数，无 IO）。
 *
 * 候选集合 = 同 endpoint、同受验 chat、未过期（now 为调用方传入的锁内 clock 值）、动作类型相符：
 *   · activate → 合法族 B1（pending）且 selection_handle 非空未过期；
 *   · anchor   → 合法族 A2 且 selection_handle 非空未过期；
 *   · rebind   → 合法族 B3 且 rebind_handle 非空未过期。
 * 三分支（§5）：
 *   · 显式 osh_ → 恰一个 eligible 命中（handle 的用途就是精确选，不要求候选集合 size==1）
 *     → selection_basis:"explicit_handle"；
 *   · 显式 orh_ → 恰一个待 rebind B3，不盘点 B1 → selection_basis:"rebind"；
 *   · 省略 handle → 集合恰一 → selection_basis:"unique_candidate"；多候选 → ambiguous
 *     （§13 边界：只回 opaque id 与计数，不回 handle 值）。
 * 拒绝原因封闭：ambiguous（带 candidates）/ no_candidate / handle_kind_mismatch / bad_action /
 * bad_now / endpoint_mismatch。
 */

import { familyOf, SELECTION_HANDLE_SHAPE, REBIND_HANDLE_SHAPE } from "./topic-agent-ledger.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";

export const SELECTION_ACTIONS = Object.freeze(["activate", "anchor", "rebind"]);
export const SELECTION_BASES = Object.freeze(["explicit_handle", "unique_candidate", "rebind"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function resolveSelectionCandidate({ doc, endpointId, chatId, action, handle = null, now } = {}) {
  if (!isObj(doc) || doc.endpoint_id !== endpointId) return { ok: false, reason: "endpoint_mismatch" };
  if (!SELECTION_ACTIONS.includes(action)) return { ok: false, reason: "bad_action" };
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "bad_now" };
  if (handle !== null) {
    const shapeOk = action === "rebind" ? REBIND_HANDLE_SHAPE.test(handle) : SELECTION_HANDLE_SHAPE.test(handle);
    if (typeof handle !== "string" || !shapeOk) return { ok: false, reason: "handle_kind_mismatch" };
  }
  const wantFam = action === "activate" ? "B1" : action === "anchor" ? "A2" : "B3";
  const hField = action === "rebind" ? "rebind_handle" : "selection_handle";
  const eField = action === "rebind" ? "rebind_expires_at" : "handle_expires_at";
  const candidates = [];
  for (const rec of Object.values(doc.records ?? {})) {
    if (rec?.kind !== "live") continue;
    if (rec.chat_id !== chatId) continue; // 同受验 chat
    if (familyOf(rec.facts) !== wantFam) continue; // 动作类型相符
    const h = rec[hField] ?? null;
    if (handle !== null) { if (h !== handle) continue; }
    else if (h === null) continue; // 省略 handle：eligible = handle 在场
    const exp = rec[eField] ?? null;
    if (exp === null || !isCanonicalIso(exp)) continue;
    if (now >= Date.parse(exp)) continue; // 未过期
    candidates.push(rec.topic_agent_id);
  }
  candidates.sort();
  if (handle !== null) {
    if (candidates.length !== 1) return { ok: false, reason: "no_candidate" };
  } else {
    if (candidates.length === 0) return { ok: false, reason: "no_candidate" };
    if (candidates.length > 1) return { ok: false, reason: "ambiguous", candidates };
  }
  const id = candidates[0];
  return { ok: true, target_id: id, family: familyOf(doc.records[id].facts), selection_basis: action === "rebind" ? "rebind" : (handle !== null ? "explicit_handle" : "unique_candidate") };
}
