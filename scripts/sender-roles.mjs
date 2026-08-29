/**
 * 发送者角色表（goal「入站权限分级」第 1 层，2026-08-29）—— **唯一一份判据，两条链共用。**
 *
 * 机器级链路模板可选字段 `senders: [{ open_id, role, note? }]`：
 *   · role ∈ owner | operator | participant；
 *   · owner **只有一个**，就是 `frank_sender_id` —— `senders` 里可以不写它（自动补上），写了必须一致；
 *     别的 open_id 不能标 owner，frank_sender_id 也不能标成别的角色；
 *   · open_id 形状与 frank_sender_id 相同（Aily user id：一串数字），不重复。
 * 未登记的 open_id、Agent 转发、引用里的 token：角色为 null = 零权限（与今天一致）。
 *
 * 第 1 层只做"表 + 显示 + 受控登记"：入站闸门仍只放 owner（sender_ids 仍只有 owner），
 * 角色 × 风险 × 模式的判定是第 2 层的事 —— 所以表里只有 owner 时，行为与今天完全一致。
 */

export const SENDER_ROLES = Object.freeze(["owner", "operator", "participant"]);
const OPEN_ID_SHAPE = /^\d+$/u;

/** 校验模板里的 senders（可选）。返回 null 或一句能定位的问题。 */
export function senderRolesProblem(tpl) {
  const owner = tpl?.frank_sender_id;
  const list = tpl?.senders;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return "senders 不是数组";
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    const at = "senders[" + i + "]";
    if (e === null || typeof e !== "object" || Array.isArray(e)) return at + " 不是对象";
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "open_id,role" && keys !== "note,open_id,role") return at + " 字段集不对（只认 open_id / role / note）";
    if (typeof e.open_id !== "string" || !OPEN_ID_SHAPE.test(e.open_id)) return at + ".open_id 形状不对（Aily user id 是一串数字）";
    if (!SENDER_ROLES.includes(e.role)) return at + ".role 不在 owner / operator / participant 里";
    if (e.note !== undefined && (typeof e.note !== "string" || e.note.length > 80)) return at + ".note 不是 80 字以内的字符串";
    if (seen.has(e.open_id)) return at + ".open_id 重复";
    seen.add(e.open_id);
    if (e.role === "owner" && e.open_id !== owner) return at + " 标了 owner 但不是 frank_sender_id";
    if (e.role !== "owner" && e.open_id === owner) return at + " 是 frank_sender_id 却标成 " + e.role;
  }
  return null;
}

/** 角色表：owner 永远在第一位，来自 frank_sender_id；其余按模板顺序。校验不过 → null（不猜）。 */
export function senderTable(tpl) {
  if (typeof tpl?.frank_sender_id !== "string" || !OPEN_ID_SHAPE.test(tpl.frank_sender_id)) return null;
  if (senderRolesProblem(tpl) !== null) return null;
  const rest = (tpl.senders ?? []).filter((e) => e.open_id !== tpl.frank_sender_id)
    .map((e) => (e.note !== undefined ? { open_id: e.open_id, role: e.role, note: e.note } : { open_id: e.open_id, role: e.role }));
  return [{ open_id: tpl.frank_sender_id, role: "owner" }, ...rest];
}

/** 某个发送者的角色；不在表里 → null（零权限）。 */
export function senderRole(tpl, senderId) {
  const table = senderTable(tpl);
  if (table === null || typeof senderId !== "string") return null;
  return table.find((e) => e.open_id === senderId)?.role ?? null;
}

/** 只出数量、不出身份：{ owner, operator, participant }。 */
export function roleCounts(table) {
  const counts = { owner: 0, operator: 0, participant: 0 };
  for (const e of table ?? []) if (e && SENDER_ROLES.includes(e.role)) counts[e.role] += 1;
  return counts;
}
export function roleCountsText(counts) {
  return "owner " + counts.owner + " · operator " + counts.operator + " · participant " + counts.participant;
}
