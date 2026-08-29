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

/**
 * 角色条目列表的核心校验 —— **模板的 senders 与订阅制品的 scope.sender_roles 共用这一份**（评审反例：两处各写一份，宽的那份放过了
 * "owner 标成 operator / 第二个 owner / 非数字 id / note 是数字"）。
 *   ownerIds：谁是 owner 的基准（模板 = [frank_sender_id]；订阅制品 = scope.sender_ids）。
 *   ownerRequired：列表里必须逐个出现 ownerIds（订阅制品 true；模板 false —— senders 可以不写 owner，senderTable 会补）。
 * 返回 null 或一句能定位的问题。
 */
export function roleEntriesProblem(list, { ownerIds, ownerRequired = false, name = "senders" } = {}) {
  // owner 基准照单全收（旧登记 / 旧夹具里的 frank_sender_id 不一定是数字；它的形状由模板校验管）；非 owner 条目才要求数字形状。
  if (!Array.isArray(ownerIds) || ownerIds.length === 0 || ownerIds.some((id) => typeof id !== "string" || id.trim().length === 0)) return name + " 的 owner 基准不成立";
  if (!Array.isArray(list)) return name + " 不是数组";
  const owners = new Set(ownerIds);
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    const at = name + "[" + i + "]";
    if (e === null || typeof e !== "object" || Array.isArray(e)) return at + " 不是对象";
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "open_id,role" && keys !== "note,open_id,role") return at + " 字段集不对（只认 open_id / role / note）";
    if (typeof e.open_id !== "string" || !(OPEN_ID_SHAPE.test(e.open_id) || owners.has(e.open_id))) return at + ".open_id 形状不对（Aily user id 是一串数字）";
    if (!SENDER_ROLES.includes(e.role)) return at + ".role 不在 owner / operator / participant 里";
    if (e.note !== undefined && (typeof e.note !== "string" || e.note.length > 80)) return at + ".note 不是 80 字以内的字符串";
    if (seen.has(e.open_id)) return at + ".open_id 重复";
    seen.add(e.open_id);
    if (e.role === "owner" && !owners.has(e.open_id)) return at + " 标了 owner 但不是 owner 基准里的那个";
    if (e.role !== "owner" && owners.has(e.open_id)) return at + " 是 owner 基准里的 id 却标成 " + e.role;
  }
  if (ownerRequired) for (const id of owners) if (!seen.has(id)) return name + " 缺 owner 基准里的 " + "（授权基准的每个 id 都必须在表里且标 owner）";
  return null;
}

/** 校验模板里的 senders（可选）。返回 null 或一句能定位的问题。 */
export function senderRolesProblem(tpl) {
  const list = tpl?.senders;
  if (list === undefined || list === null) return null;
  return roleEntriesProblem(list, { ownerIds: [tpl?.frank_sender_id], ownerRequired: false, name: "senders" });
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
