// scripts/select-admission.mjs
// R52a：/feishu-select 的写入准入 —— **可注入**；默认实现接真实状态（R55，issue：准入默认实现接线）：
// readOwnerSelectAdmission（owner-select-state.mjs）按 ledger 根下 campaign / writer_state 投影
// off / partial / on / unreadable —— 缺席 = off，任何读不出/不自洽 = unreadable，两处 fail-closed 方向不变。
//
// selectReject(adm, handle_kind)：给定准入状态联合（off / partial / on / unreadable）与 handle_kind，返回拒绝
//   { reason, text } 或 null（放行）。这是"三态准入"的确定性投影，测试用假 adm 覆盖四支。
//
// R57b：rfh 支接真执行器（owner_select_reaffirm，§8.1 消费编排 consumeReaffirmIntent）。
// R57d：osh / orh / 省略 支接真执行器（§12 + §5 + §6）——select_executor_absent 路径删除；
//   osh → activate(B1) / anchor(A2)，orh → rebind_session_alias，省略 → 三候选集合并集恰一；
//   失败按 reason 封闭映射，ambiguous 回执按 §13（R57d 返修一 P1-8：opaque handle + 安全标签，上限 5）。
// R57d 返修一 P1-4：省略 handle 命中唯一 rebind 时，rebindHandle 取命中记录的 rebind_handle
//   （显式 orh 时二者相等）——原实现恒传原始 handle（省略分支恒 null）→ 必失败。

import { createHash } from "node:crypto";
import { REAFFIRM_HANDLE_SHAPE, SELECTION_HANDLE_SHAPE, REBIND_HANDLE_SHAPE, ENDPOINT_SHAPE, CHAT_SHAPE, AUTHORIZED_BY_SHAPE, OM_SHAPE, AILY_SESSION_SHAPE, loadByEndpoint } from "./topic-agent-ledger.mjs";
import { readOwnerSelectAdmission } from "./maintenance/owner-select-state.mjs";
import { consumeReaffirmIntent } from "./maintenance/reaffirm-intents.mjs";
import { canonKey } from "./maintenance/canon.mjs";
import { resolveSelectionCandidate } from "./select-resolve.mjs";
import { wireSelectActivate, wireSelectAnchor, wireSelectRebind } from "./m1a/wiring.mjs";

/**
 * 判定选择控制 outcome 的叶子纯函数（§8.1 / R57b / 与 R57d 返修一共用，不 import 维护编排）。
 * 分别给出三份结果：
 * 1. 账本提交（clean / unclean / not_committed）
 * 2. intent 清理提交（cleared / unclear）
 * 3. 两层锁释放（outer / intent 各 released / residue / unclear）
 * 只有三份都干净才 ok → consumed + 绿色文案；已提交未收净 → control-committed-unclean。
 */
import { classifySelectOutcome } from "./select-outcome.mjs";
export { classifySelectOutcome };


/** selection_context 稳定摘要计算（§8.1/R57b/R57d：不含 root，缺项显式 null）。 */
export function selectionContextDigestV1({
  endpoint = null,
  chat = null,
  session = null,
  message = null,
  sender = null,
  handle = null,
  kind = null,
} = {}) {
  const payload = canonKey({
    domain: "selection_context_v1",
    chat: chat ?? null,
    endpoint: endpoint ?? null,
    handle: handle ?? null,
    kind: kind ?? null,
    message: message ?? null,
    sender: sender ?? null,
    session: session ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** selection_context 的精确允许键集（封闭：缺一/多一都拒，P1-5）。 */
export const SELECTION_CONTEXT_KEYS = "chat,endpoint,handle,kind,message,sender,session";
const SELECTION_KIND_SHAPE = /^(osh|orh|rfh)$/u;
/** kind → handle 形状（封闭映射；kind 与 handle 前缀不一致 → 拒）。 */
const HANDLE_SHAPE_BY_KIND = Object.freeze({ osh: SELECTION_HANDLE_SHAPE, orh: REBIND_HANDLE_SHAPE, rfh: REAFFIRM_HANDLE_SHAPE });

/** 校验 claim 里的 selection_context 与 digest，fail-closed 点名缺项/形状不对（P1-5：封闭精确键集 + 各字段形状，session 必填）。 */
export function verifySelectionContext(claim) {
  if (!claim || typeof claim !== "object") {
    return { ok: false, reason: "selection_context_missing", why: "claim 为空或不是对象" };
  }
  const ctx = claim.selection_context;
  if (!ctx || typeof ctx !== "object") {
    return { ok: false, reason: "selection_context_missing", why: "缺 selection_context（旧形 claim）" };
  }
  const digest = claim.selection_context_digest_v1;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    return { ok: false, reason: "selection_context_digest_missing", why: "缺 selection_context_digest_v1（旧形 claim）" };
  }
  // P1-5：封闭精确键集——缺任一键或多出非白名单键都 fail-closed。
  if (Object.keys(ctx).sort().join(",") !== SELECTION_CONTEXT_KEYS) {
    return { ok: false, reason: "selection_context_incomplete", why: "selection_context 键集不对（须 " + SELECTION_CONTEXT_KEYS + "）" };
  }
  const missing = [];
  if (typeof ctx.endpoint !== "string" || !ENDPOINT_SHAPE.test(ctx.endpoint)) missing.push("endpoint");
  if (typeof ctx.chat !== "string" || !CHAT_SHAPE.test(ctx.chat)) missing.push("chat");
  if (typeof ctx.session !== "string" || !AILY_SESSION_SHAPE.test(ctx.session)) missing.push("session");
  if (typeof ctx.message !== "string" || !OM_SHAPE.test(ctx.message)) missing.push("message");
  if (typeof ctx.sender !== "string" || !AUTHORIZED_BY_SHAPE.test(ctx.sender)) missing.push("sender");
  if (typeof ctx.kind !== "string" || !SELECTION_KIND_SHAPE.test(ctx.kind)) missing.push("kind");
  const handleShape = typeof ctx.kind === "string" ? HANDLE_SHAPE_BY_KIND[ctx.kind] : null;
  if (typeof ctx.handle !== "string" || !(handleShape && handleShape.test(ctx.handle))) missing.push("handle");
  if (missing.length > 0) {
    return { ok: false, reason: "selection_context_incomplete", why: "selection_context 缺/形状不对：" + missing.join(", ") };
  }
  const expectedDigest = selectionContextDigestV1(ctx);
  if (digest !== expectedDigest) {
    return { ok: false, reason: "select_context_conflict", why: "selection_context_digest_v1 与内容不一致" };
  }
  return { ok: true, context: ctx };
}

/** 写入准入 —— 默认读真实状态（执行器已全量接入；准入仍 fail-closed）。 */
export function selectAdmission(env = process.env) {
  return readOwnerSelectAdmission(env);
}

/** 三态准入的确定性投影：返回 { reason, text }（拒绝）或 null（放行）。准入联合以外的任何状态（缺席/未知/非对象）一律投影为 unreadable → 拒。 */
export function selectReject(adm, handle_kind) {
  if (adm === null || typeof adm !== "object" || Array.isArray(adm)) {
    return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
  }
  if (adm.state === "unreadable") return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
  if (adm.state === "off") return { reason: "select_off", text: "选择功能未开放（迁移未开始）" };
  if (adm.state === "partial") {
    if (handle_kind !== "rfh") return { reason: "select_partial_not_rfh", text: "迁移期间只接受 rfh_ 重确认 handle" };
    return null;
  }
  if (adm.state === "on") return null;
  return { reason: "select_writer_state_unreadable", text: "选择功能状态读不清，未执行" };
}

/** 拒绝 reason → 说明文案（封闭映射；重放从记录恢复文案时同一份）。 */
export function selectRejectTextByReason(reason) {
  if (reason === "select_executor_absent") return "已收到选择，执行器尚未接入，本条未消费；执行器接入后请重新发送";
  if (reason === "select_writer_state_unreadable") return "选择功能状态读不清，未执行";
  if (reason === "select_off") return "选择功能未开放（迁移未开始）";
  if (reason === "select_partial_not_rfh" || reason === "select_not_partial") return "迁移期间只接受 rfh_ 重确认 handle";
  if (reason === "outer_lock_required") return "外层排序锁未持有，未执行";
  if (reason === "maintenance") return "维护进行中，未执行";
  // R57b：rfh 支的失败映射（全部封闭，不让裸 reason 漏给 owner）
  if (reason === "reaffirm_handle_unknown") return "重确认 handle 不存在或已被消费；要重做请在终端重新签发一条";
  if (reason === "reaffirm_intent_expired") return "重确认 handle 已过期，请在终端重新签发";
  if (reason === "sender_mismatch") return "只有签发时登记的 owner 本人才可消费这个重确认 handle";
  if (reason === "chat_mismatch") return "请在签发时对应的话题里发送这条选择";
  if (reason === "family_changed") return "目标记录在签发后变动过（暂停/恢复），请重新签发重确认";
  if (reason === "digest_cas_mismatch" || reason === "selection_mismatch") return "目标记录在签发后变动过，请重新签发重确认";
  if (reason === "reaffirm_target_missing") return "目标记录已不在账本里，请重新签发";
  if (reason === "reaffirm_intents_unreadable") return "重确认意图文件读不出（fail-closed），未执行；请人工检查";
  if (reason === "reaffirm_intents_busy") return "重确认处理忙，请稍后重发一条新消息";
  if (reason === "reaffirm_intents_unwritable") return "重确认意图写不进（fail-closed），未执行；请人工检查";
  // R57d：osh/orh/省略 支的失败映射
  if (reason === "ambiguous_selection") return "选择不唯一，请带上对应 handle 重新发送 /feishu-select";
  if (reason === "no_candidate") return "账本里没有符合条件的选择目标（可能已过期、不在该话题或已被处理）";
  if (reason === "no_a1") return "当前会话上没有待绑定的 A1 记录，无法完成绑定";
  if (reason === "cas_mismatch") return "选择与账本现场不符（记录可能已变动），请重新发起选择";
  if (reason === "handle_expired") return "这个 handle 已过期，未执行";
  if (reason === "select_endpoint_unknown") return "无法确定所属 endpoint，未执行";
  // R57d 返修一 P1-1：按 authority_mode 分派走 m1a wrapper 的新失败面
  if (reason === "select_legacy_required") return "迁移未完成（账本仍是影子），执行需要同步更新绑定登记；这一步不可用，未执行";
  if (reason === "select_legacy_failed") return "绑定登记更新失败，未执行（账本未落）；请稍后重试";
  if (reason === "select_ledger_skipped") return "选择没有落到账本（该端点账本未启用镜像），未生效";
  if (reason === "ledger_corrupt" || reason === "ledger_unreadable") return "账本读不出，未执行（fail-closed）";
  if (reason === "schema_not_11") return "账本还没升到 1.1，不能重签";
  return "控制执行失败（" + reason + "）";
}

/** rfh 成功文案（按 result 分支如实说签了什么；P2 最小披露：不泄露内部 target id）。 */
export function selectReaffirmSuccessText(result) {
  const what = result?.new_binding_proof ? "绑定与链路证明" : "链路证明";
  return "已按你的确认重签该目标的" + what + "。";
}

/** osh/orh/省略 成功文案（按 action 措辞）。 */
export function selectExecutorSuccessText(action) {
  if (action === "activate") return "已按你的选择完成绑定（activate）：绑定已生效";
  if (action === "anchor") return "已按你的选择完成锚定（anchor）：根消息锚定已生效";
  if (action === "rebind") return "已按你的选择完成换绑（rebind）：会话已切换";
  return "已按你的选择完成处理";
}

/* ── §13 多候选呈现（R57d 返修一 P1-8）────────────────────
 * 回执只含 opaque handle + 稳定安全标签：标签 = 记录已持久的 created_at 以 Asia/Shanghai 渲染成
 * MM-DD HH:mm，同一分钟并列按 topic_agent_id 字典序加后缀 ·a、·b…（只依赖持久字段，两次盘点相同，
 * 绝不由每次盘点临时排序生成）；数量上限 5（≤5 全列；>5 只列按标签序前 5 并提示还有 N 个，
 * 请带 handle 或先清理）；绝不含 locator / root_om / 精确本地目标 / 会话 id / chat_id / 记录 id；
 * 限码点数与控制字符。 */
const AMBIGUITY_CAP = 5;
const SH_LABEL_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const safeCell = (s) => String(s).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 80);
function shanghaiLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "时间未知";
  const part = {};
  for (const p of SH_LABEL_FMT.formatToParts(new Date(t))) part[p.type] = p.value;
  return part.month + "-" + part.day + " " + part.hour + ":" + part.minute;
}
const suffixLetters = (i) => { let s = "", n = i + 1; while (n > 0) { s = String.fromCharCode(97 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };

/** 歧义回执正文（§13）：candidateIds = 解析层给出的候选记录 id（封闭有序）。 */
export function selectAmbiguityReceipt(doc, candidateIds) {
  const rows = (Array.isArray(candidateIds) ? candidateIds : []).map((id) => {
    const rec = doc?.records?.[id];
    return { id, label: shanghaiLabel(rec?.created_at), handle: rec?.selection_handle ?? rec?.rebind_handle ?? null };
  }).filter((r) => typeof r.handle === "string" && r.handle.length > 0);
  rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 同一分钟（同标签）并列：按 topic_agent_id 字典序（上排同序）加后缀 ·a、·b…
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].label === rows[i].label) j += 1;
    if (j > i) for (let k = i; k <= j; k += 1) rows[k].label = rows[k].label + "·" + suffixLetters(k - i);
    i = j + 1;
  }
  const lines = rows.slice(0, AMBIGUITY_CAP).map((r) => safeCell(r.label) + " " + safeCell(r.handle));
  const tail = rows.length > AMBIGUITY_CAP ? ["（还有 " + (rows.length - AMBIGUITY_CAP) + " 个未列出，请带 handle 或先清理）"] : [];
  return ["选择不唯一（" + rows.length + " 个候选），请带对应 handle 重新发送 /feishu-select：", ...lines, ...tail].join("\n");
}

/** wired 结果 → 执行器回执（R57d 返修一 P1-1：wrapper 是唯一写面；结果按 ok/legacy/shadow 首笔封闭消费）。
 * P1-7 的三份结果分类（clean/unclean/not_committed 可恢复态）归 B 段；本函数先按旧口径收敛。 */
function wiredOutcome(w, action) {
  if (!w || typeof w !== "object") return { ok: false, reason: "select_op_failed", text: selectRejectTextByReason("select_op_failed") };
  if (w.ok !== true) {
    const reason = w.reason ?? "select_op_failed";
    return { ok: false, reason, text: selectRejectTextByReason(reason) + (w.why ? "（" + w.why + "）" : "") };
  }
  if (w.legacy && w.legacy.ok === false) {
    const why = String(w.legacy.why ?? w.legacy.reason ?? "");
    return { ok: false, reason: "select_legacy_failed", text: selectRejectTextByReason("select_legacy_failed") + (why ? "（" + why + "）" : "") };
  }
  const step = Array.isArray(w.shadow) ? w.shadow[0] : null;
  if (!step) return { ok: false, reason: "select_ledger_skipped", text: selectRejectTextByReason("select_ledger_skipped") };
  if (step.ok !== true) {
    const reason = step.reason ?? "select_op_failed";
    return { ok: false, reason, text: selectRejectTextByReason(reason) + (step.why ? "（" + step.why + "）" : "") };
  }
  return { ok: true, changed: step.idempotent !== true, action, text: selectExecutorSuccessText(action) };
}

/**
 * 执行选择控制命令（在控制事务锁内跑）。
 * R52a（PR #136）：准入不过 → failed 终态；R57b：rfh 支接 owner_select_reaffirm；
 * R57d：osh / orh / 省略 支接真执行器——§8.1 消费侧核验（chat 过滤在解析器、endpoint 由受验
 * 账本自证、sender 的 owner 闸由入站路由 R3/R4 先行）+ §6 增量形输入：
 *   选择五元 = { selected_session_id: 受验事件 session, selected_root_om: 命中记录现场
 *   （B1.root_om / A2.anchor_candidate，P1-5），selection_handle: 命中 handle,
 *   selection_message_id: 事件 message id, selection_basis: 解析结果 }；
 *   anchor 另带 expected 三件（取自命中记录）；rebind 带 expected_expires_at；
 *   request_key 由 m1a/wiring.mjs 按 §5.1 通式从事件 message id + 目标 id 逐 op 派生
 *   （同 message 重放 → ledger 幂等 + 事务层判已完成）。
 * select_executor_absent 路径已删除（执行器全量接入）。注入面：selectAdmissionFn / consumeReaffirm。
 */
export function executeSelectControl(intent, {
  selectAdmissionFn = selectAdmission,
  consumeReaffirm = consumeReaffirmIntent,
  senderId = null, chatId = null, endpointId = null, messageId = null,
  eventSessionId = null,
  mappingUpdate = null,
  now = undefined, clock = () => Date.now(), env = process.env, _inject = undefined,
  claimsDir = undefined, key = undefined,
} = {}) {
  const adm = selectAdmissionFn(env);
  const ej = selectReject(adm, intent?.handle_kind);
  if (ej) return { ok: false, reason: ej.reason, text: ej.text };
  const nowMs = Number.isFinite(now) ? now : clock();
  if (intent?.handle_kind === "rfh") {
    if (typeof intent.handle !== "string" || !REAFFIRM_HANDLE_SHAPE.test(intent.handle)) {
      return { ok: false, status: "failed", reason: "reaffirm_handle_unknown", text: selectRejectTextByReason("reaffirm_handle_unknown") };
    }
    // R57b 返修七 P1-1：执行器只是透传 claimsDir/key；强制校验收口在 mutation 层（consumeReaffirmIntentInner）——
    //   否者公开的 consumeReaffirmIntent 可直接省略上下文越过 plan 后提交账本。
    const res = consumeReaffirm({ endpointId, reaffirmHandle: intent.handle, sender: senderId, chatId, selectionMessageId: messageId, selectAdmissionFn, now, env, _inject, claimsDir, key });
    if (res.status === "control-committed-unclean") {
      return {
        ok: false,
        status: "control-committed-unclean",
        reason: "control_committed_unclean",
        text: "已写入但收口不干净（" + (res.why ?? "账本已写入但未收净，请联系管理员修复") + "）",
        ledger: res.ledger,
        intent_cleanup: res.intent_cleanup,
        locks: res.locks,
        result: res.result,
        why: res.why,
      };
    }
    if (!res.ok) {
      return { ok: false, status: "failed", reason: res.reason ?? "reaffirm_failed", text: selectRejectTextByReason(res.reason ?? "reaffirm_failed") };
    }
    return { ok: true, status: "consumed", changed: res.idempotent === true ? false : true, action: "reaffirm", text: selectReaffirmSuccessText(res.result) };
  }

  // ── R57d：osh / orh / 省略 ──
  const kind = intent?.handle_kind ?? null;
  const handle = intent?.handle ?? null;
  if (kind === "osh" && (typeof handle !== "string" || !SELECTION_HANDLE_SHAPE.test(handle))) {
    return { ok: false, reason: "no_candidate", text: selectRejectTextByReason("no_candidate") };
  }
  if (kind === "orh" && (typeof handle !== "string" || !REBIND_HANDLE_SHAPE.test(handle))) {
    return { ok: false, reason: "no_candidate", text: selectRejectTextByReason("no_candidate") };
  }
  // R57d 返修一 P2：endpoint 守卫——只认受验形状（非字符串/空串/形状不符一律 select_endpoint_unknown，不进账本读）。
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) {
    return { ok: false, reason: "select_endpoint_unknown", text: selectRejectTextByReason("select_endpoint_unknown") };
  }
  const L = loadByEndpoint(endpointId, { env });
  if (!L.ok) {
    // R57d 返修一 P2：granular 直接、封闭的 reason 分派——
    //   absent = 该 endpoint 还没有账本（准入 on 但从未建账/无候选）→ no_candidate，不是 fail-closed；
    //   corrupt（坏 JSON/校验不过）→ ledger_corrupt；unreadable 及其它说不清的 granular → fail-closed ledger_unreadable。
    const reason = L.granular === "absent" ? "no_candidate" : L.granular === "corrupt" ? "ledger_corrupt" : "ledger_unreadable";
    return { ok: false, reason, text: selectRejectTextByReason(reason) };
  }
  const doc = L.doc;

  // 候选解析（§5）：osh → activate(B1) 再 anchor(A2)；orh → rebind；省略 → 三候选集合并集恰一
  let res = null, action = null;
  if (kind === "osh") {
    res = resolveSelectionCandidate({ doc, endpointId, chatId, action: "activate", handle, eventSessionId, now: nowMs });
    if (res.ok) { action = "activate"; }
    else {
      const r2 = resolveSelectionCandidate({ doc, endpointId, chatId, action: "anchor", handle, now: nowMs });
      if (r2.ok) { res = r2; action = "anchor"; }
    }
  } else if (kind === "orh") {
    res = resolveSelectionCandidate({ doc, endpointId, chatId, action: "rebind", handle, now: nowMs });
    if (res.ok) action = "rebind";
  } else {
    const tries = [
      ["activate", resolveSelectionCandidate({ doc, endpointId, chatId, action: "activate", handle: null, eventSessionId, now: nowMs })],
      ["anchor", resolveSelectionCandidate({ doc, endpointId, chatId, action: "anchor", handle: null, now: nowMs })],
      ["rebind", resolveSelectionCandidate({ doc, endpointId, chatId, action: "rebind", handle: null, now: nowMs })],
    ];
    const hits = tries.filter(([, r]) => r.ok);
    const ambs = tries.filter(([, r]) => r.reason === "ambiguous");
    if (hits.length === 1 && ambs.length === 0) { res = hits[0][1]; action = hits[0][0]; }
    else if (ambs.length > 0) res = ambs[0][1];
    else if (hits.length > 1) res = { ok: false, reason: "ambiguous", candidates: hits.flatMap(([, r]) => [r.target_id]) };
    else res = { ok: false, reason: "no_candidate" };
  }
  if (!res.ok) {
    if (res.reason === "ambiguous") {
      // R57d 返修一 P1-8（§13）：只列 opaque handle + 稳定安全标签，上限 5；不回记录 id
      return { ok: false, reason: "ambiguous_selection", text: selectAmbiguityReceipt(doc, res.candidates ?? []) };
    }
    return { ok: false, status: "failed", reason: res.reason, text: selectRejectTextByReason(res.reason) };
  }
  const target = doc.records[res.target_id];
  // R57d 返修一 P1-1：按账本 authority_mode 分派走 m1a/wiring.mjs 的三个具名 wrapper（唯一写面；
  //   shadow 期不碰 activate/anchor/rebindSessionAlias 直调，不给第二个入口）。mappingUpdate 是
  //   activate/rebind 的 legacy 提交回调（更新 mapping）；shadow 期缺席 → wrapper 拒 select_legacy_required。
  const legacy = typeof mappingUpdate === "function"
    ? () => mappingUpdate({ action, endpointId, targetId: res.target_id, chatId, eventSessionId, senderId, messageId })
    : null;
  let w;
  if (action === "activate") {
    // R57d 返修一 P1-5（§12 ⑤）：root = 命中 B1 的 aliases.root_om（selected_root_om 与之 CAS）；
    //   session = 受验入站事件 session。不收 transport 根（eventRootOm 已删，不声称验过 thread_root）。
    w = wireSelectActivate({ endpointId, env, legacy, messageId, b1Id: res.target_id, chatId, eventSessionId, authorizedBy: senderId, selectedRootOm: target.aliases.root_om, selectionHandle: handle ?? target.selection_handle, selectionBasis: res.selection_basis, clock });
  } else if (action === "anchor") {
    // P1-5：root = A2 的 anchor_candidate；session = 事件 session（不再自填目标旧 session——那会让 CAS 变得恒真）
    w = wireSelectAnchor({ endpointId, env, messageId, id: res.target_id, authorizedBy: senderId, selectedSessionId: eventSessionId, selectedRootOm: target.anchor_candidate, selectionHandle: handle ?? target.selection_handle, expectedExpiresAt: target.handle_expires_at, expectedAnchorCandidate: target.anchor_candidate, selectionBasis: res.selection_basis, clock });
  } else {
    w = wireSelectRebind({ endpointId, env, legacy, messageId, id: res.target_id, expectedOldSessionId: target.aliases.session_id, newSessionId: eventSessionId, authorizedBy: senderId, rebindHandle: handle ?? target.rebind_handle, expectedExpiresAt: target.rebind_expires_at, clock });
  }
  return wiredOutcome(w, action);
}
