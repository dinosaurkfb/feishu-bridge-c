// scripts/m1a/wiring.mjs
// M1a 双写接线（#R36，T3b 之后）——**封闭 per-writer 包装层**。
// 规格：m1a-reconciliation.md §5 / §5.1（writer→账本事务全映射 + request_key 逐 op 派生 +
// 外层锁无降级 + 多笔序列固定顺序/崩溃续跑 + legacy no-op 仍走 shadow 后缀）。
//
// 结构：每个 legacy 写方一个**具名**函数，内部复用 runWired 骨架：
//   outer 锁（m1a-order.lock，instance-bound）→ legacy 提交回调 → shadow 序列（固定顺序、
//   逐笔 request_key 派生表实现，账本裁定 replay/conflict）→ 释放锁。
//   outer busy → 整笔 binding_busy 拒；shadow 失败**不改变 legacy 成功语义**（回执照常，mismatch 留 doctor）。
//   M1a 逐端点原子启用（收据状态）：never_initialized → 合法 legacy-only（不取 outer、不写 shadow）；
//   已启用点任一取锁失败 → 整笔拒（skip 集为空）；收据说不清 → fail-closed。
// 崩溃续跑：request_key 一律由**持久外部 id**（消息 id / claim key / rotation operation id /
//   控制 claim key）确定性派生，故同 writer 动作重放命中账本幂等重放、跳过已提交后缀。
//
// 边界：本模块不知道具体 legacy 写方（inbound-route / topic-generation / register……）长什么样；
//   它们只经 `legacy` 回调注入自己的提交逻辑。调用方负责在提交点外包本层。
import fs from "node:fs";
import path from "node:path";

import { acquireOrderLock, requestKeyFor } from "./dual-write.mjs";
import {
  createA1, createB1, activate, anchor, attach, voidPending, unbind, restore, retarget, rebindSessionAlias,
  resolveLiveId, loadByEndpoint, familyOf,
} from "../topic-agent-ledger.mjs";
import { endpointReceipt } from "../maintenance/ledger-receipt.mjs";
import { maintenanceDir } from "../maintenance/journal.mjs";
import { legacyEndpointId } from "../subscription.mjs";
import { readSidecarStore, mutateSidecarEntry } from "../m1b/sidecar-store.mjs";

const en = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;

/* P1-2 收尾：F4 封闭四项 —— wirePromoteBinding 只**消费**认领校验处受验的 f4，不自铸。 */
const F4_FIELDS = ["chat_id", "sender", "body", "thread_root"];
const F4_NO_TOKEN_FIELDS = ["chat_id", "sender", "thread_root"];
/* P1-1-d 判别联合（Codex 裁定 d）：f4 必须在认领校验处受验，此处只消费不铸造。
   pending_token_state==="present" → binding_token_v1（完整四维）；"absent" → owner_root_no_token_v1（三维 owner-root）。
   G15 按判别联合分支精确校验，禁止通用“部分 matched_fields”与任何 unverified 占位。 */
const f4Ok = (f4, locator) =>
  f4 && typeof f4 === "object"
  && typeof f4.matched_om === "string" && f4.matched_om === locator
  && Array.isArray(f4.matched_fields)
  && (f4.pending_token_state === "present"
      ? f4.matched_fields.length === F4_FIELDS.length && f4.matched_fields.every((v, i) => v === F4_FIELDS[i])
      : f4.pending_token_state === "absent"
        ? f4.matched_fields.length === F4_NO_TOKEN_FIELDS.length && f4.matched_fields.every((v, i) => v === F4_NO_TOKEN_FIELDS[i])
        : false);

/* 逐 op request_key 派生（§5.1 通式；op_type 小写字母/数字/下划线）。 */
function rk(opType, externalRequestId, entityId) {
  return requestKeyFor({ opType, externalRequestId, entityId });
}

/* 捕获一次 shadow 提交，绝不抛出；返回 { op, result } 或 { op, ok:false, reason, why }。
 * #R37 P1-4：透传 ledger 提交的 lockUncleared / residue / path / error —— 不再当作垃圾烂抛，
 *   好让共用 unclean 投影点名「镜像不干净」的每一步；非干净提交（committed_with_residue /
 *   committed_durability_uncertain）仍 ok:true（数据确实提交了，语义不变），但保留 committed 供投影区分。 */
function capture(op, res) {
  if (!res || typeof res !== "object") return { op, ok: false, reason: "shadow_nonobject", why: "shadow 提交未返回对象" };
  if (res.ok === true) return { op, ok: true, result: res.result ?? null, idempotent: res.idempotent === true, committed: res.commit ?? null, sha256: res.sha256 ?? null, residue: res.residue ?? null, lockUncleared: res.lockUncleared ?? null, path: res.path ?? null, error: res.error ?? null };
  if (res.ok === false) return { op, ok: false, reason: res.reason ?? "shadow_rejected", why: res.why ?? null, residue: res.residue ?? null, lockUncleared: res.lockUncleared ?? null, path: res.path ?? null, error: res.error ?? null };
  return { op, ok: false, reason: "shadow_unknown" };
}

/* ── 共用 unclean 投影（#R37 P1-4）────────────────────────────────
 * 把 runWired 结果折成「镜像是否干净」+ 不干净明细，供入站 chat/promote 调用点与 5 个 CLI
 * 直写点消费：legacy 已成但 shadow 不干净 → 调用方写持久机器回执。
 * 语义：clean **不改变** wired.ok / legacy 成功语义 —— 它只是「影子是否镜像干净」的投影，
 * 覆盖四类：① shadow 步提交失败（ok:false）；② 非干净提交（committed_with_residue /
 * committed_durability_uncertain）；③ 内层（shadow 提交步）/外层（acq）锁残骸；④ release 残骸。
 *
 * PK2-W1-fix2 P1-3：**authoritative 复合的提交进度不在 shadow 步里** —— 它在 union 的 `commit`/`commits`
 * （一次步骤可能含两笔原语：认领 = create_a1 → activate，步级 capture 只留得下后一笔）。不消费它
 * 就是 K3 那把刀：create_a1 提交为 `committed_durability_uncertain`、activate clean 时，投影只看
 * shadow 步 → 报 clean、入站照成功继续。这里两类都折：`commits[]` 逐原语 + union 的 `commit` 总判。 */
export function uncleanWired(wired) {
  const steps = Array.isArray(wired?.shadow) ? wired.shadow : [];
  const failedSteps = steps.filter((s) => s && s.ok === false).map((s) => ({
    op: s.op ?? null, reason: s.reason ?? null, why: s.why ?? null,
  }));
  // #R37 P1-3：capture() 对 ok:true 步产出 committed:（res.commit ?? null），字段名是 committed 不是 commit。
  // 旧版读 s.commit 恒为 undefined → ② 类（非干净提交）永不触发；且阈值 !=="committed" 永不匹配真实值
  // （committed_clean / committed_with_residue / committed_durability_uncertain）—— 一并修正。
  const uncleanSteps = steps.filter((s) => s && s.ok === true && (
    (s.committed && s.committed !== "committed_clean") || s.residue || s.lockUncleared || s.path || s.error
  )).map((s) => ({
    op: s.op ?? null, commit: s.committed ?? "committed_clean", residue: s.residue ?? null,
    lockUncleared: s.lockUncleared ?? null, path: s.path ?? null, error: s.error ?? null,
  }));
  const rel = wired?.release;
  const releaseUnclean = rel && rel.ok !== true ? {
    reason: rel.reason ?? null, why: rel.why ?? null, path: rel.path ?? null, error: rel.error ?? null,
  } : null;
  const lockUnclean = wired && wired.ok !== true && wired.lock ? {
    reason: wired.reason ?? null, why: wired.why ?? null,
    path: wired.lockPath ?? wired.lock ?? null, error: wired.lockError ?? null,
  } : null;
  // 逐原语提交证据（authoritative 复合自报；shadow 路径没有这个字段 → 空数组，行为不变）
  const commits = (Array.isArray(wired?.commits) ? wired.commits : []).filter((c) => c && typeof c === "object").map((c) => ({
    op: c.op ?? null, commit: c.commit ?? null, idempotent: c.idempotent === true,
    residue: c.residue ?? null, lockUncleared: c.lockUncleared ?? null, path: c.path ?? null, error: c.error ?? null,
  }));
  const uncleanPrimitives = commits.filter((c) =>
    (typeof c.commit === "string" && c.commit !== "committed_clean") || c.residue || c.lockUncleared || c.path || c.error);
  // union 的总判（runAuthoritative 按同一批证据联合算出来的）也当一道闸：少带 commits 就漏不掉。
  //   `not_committed` 不算 unclean（那是"没提交"，与"提交不干净"是两件事）。
  const commitUnclean = typeof wired?.commit === "string" && wired.commit !== "not_committed" && wired.commit !== "committed_clean"
    ? wired.commit : null;
  const durabilityUncertain = uncleanSteps.some((s) => s.commit === "committed_durability_uncertain")
    || uncleanPrimitives.some((c) => c.commit === "committed_durability_uncertain");
  const residue = [...steps.filter((s) => s && s.residue).map((s) => ({ op: s.op ?? null, residue: s.residue ?? null })),
    ...uncleanPrimitives.filter((c) => c.residue).map((c) => ({ op: c.op, residue: c.residue }))];
  return {
    clean: wired?.ok === true && failedSteps.length === 0 && uncleanSteps.length === 0 && !releaseUnclean
      && uncleanPrimitives.length === 0 && commitUnclean === null,
    steps, failedSteps, uncleanSteps, residue, releaseUnclean, lockUnclean,
    durabilityUncertain,
    commit: wired?.commit ?? null, commits, uncleanPrimitives, commitUnclean,
  };
}

/* #R37 P1-4：CLI/入站共用 —— 当镜像不干净（shadow 步失败/非干净提交/内+外层锁残骸/release 残骸）时
 * 向 stderr 发一条机器回执（持久化交给调用方），**不改写** wired.ok / legacy 成功语义。
 * 返回投影；干净时静默（不产生回执）。 */
export function emitUncleanReceipt(kind, wired, extra = {}) {
  const unc = uncleanWired(wired);
  if (unc.clean) return unc;
  // receiptDir 是持久写面（机器回执目录），不进回执正文；其余 ctx（root/threadId/operationId…）随正文走。
  const { receiptDir, ...ctx } = extra;
  const body = {
    schema_version: "1.0", artifact_type: "feishu_bridge_m1a_unclean_receipt",
    classification: "internal", recorded_at: new Date().toISOString(), kind, ...unc, ...ctx,
  };
  if (typeof receiptDir === "string" && receiptDir.length > 0) {
    // #R37 P1-4（Frank 拍板）：持久机器回执 —— 不只 stderr；写 <receiptDir>/m1a-unclean-<ts>-<pid>.json。
    unc.receipt = persistUncleanReceipt({ receiptDir, body });
  }
  console.error(JSON.stringify(body, null, 2));
  return unc;
}

/** 持久化 unclean 机器回执：<receiptDir>/m1a-unclean-<ts>-<pid>.json（0600、tmp+rename 原子）。
 * 内容 = stderr 同款投影全量（uncleanWired + kind + 调用方 ctx）。写失败返回 {ok:false, why}，不抛（回执属尽力而为）。 */
export function persistUncleanReceipt({ receiptDir, body, now = Date.now() }) {
  try {
    fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const file = path.join(receiptDir, "m1a-unclean-" + now + "-" + process.pid + ".json");
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) };
  }
}

/* 外层排序锁骨架：legacy → shadow 序列 → 释放。
 * legacy 是权威；shadow 为镜像。已启用点任一取锁失败 → 整笔拒（skip 集为空，不降级）；
 * 仅取得 outer **后** 的 shadow 后半程失败 → 保留已成立的 legacy 结果，shadow[i] 投影失败（mismatch 留 doctor）。 */
// M1a 逐端点原子启用（#R37 裁定补充 §5）：判据是**收据状态**（endpointReceipt），不是运行时 root_absent，
//   · never_initialized（无 done ledger_init）→ 合法 legacy-only：不取 outer、不写 shadow。
//   · 收据/账本说不清（冲突/进行中/读不出）→ fail-closed：不得写 legacy-only。
//   · state === "ok"（ledger_init done）→ 双写强制：**任一取锁失败都不得写 legacy**（错误名不能证明无并发写方）。
// 已启用点外层锁无降级（裁定：可 skip 的失败集为空）；只有**取得 outer 后**的 shadow 后半程失败，
// 才保留已成立的 legacy 结果并外显 mismatch（shadow[i] 投影失败）。
function runWired({ endpointId, env = process.env, legacy, submit, lockOnly = false, preflight = null }) {
  const recDir = maintenanceDir(env);
  // #R37 P1-4：recDir 不可派生（maintenanceDir 返回 null/空）≠ never_initialized。
  //   只有**确切 ENOENT（目录缺席）**才判 never_initialized（合法 legacy-only）；
  //   读不到收据路径就 fail-closed（整笔拒、不写 legacy），不伪造从未初始化。
  const receipt = typeof recDir === "string" && recDir.length > 0
    ? endpointReceipt(recDir, endpointId)
    : { ok: false, state: "unreadable", why: "维护目录不可派生（maintenanceDir 返回 null/空）→ 无法读收据，fail-closed（不伪造 never_initialized）" };
  if (receipt.ok === true && receipt.state === "never_initialized") {
    // M1a 未启用 → 合法 legacy-only：不取 outer、不写 shadow 后缀。
    let legacyRes;
    try { legacyRes = legacy(); }
    catch (err) { return { ok: false, commit: "not_committed", reason: "legacy_failed", why: String(err?.message ?? err), legacy: null, shadow: null, release: null }; }
    return { ok: true, legacy: legacyRes, shadow: [], release: null };
  }
  if (!receipt.ok) {
    // 收据/账本说不清 → fail-closed：不写 shadow 未镜像的 legacy。
    return { ok: false, commit: "not_committed", reason: "m1a_receipt_fail_closed", why: receipt.why ?? "M1a 收据不可读，fail-closed", legacy: null, shadow: null, release: null };
  }
  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) {
    // 双写强制下任一取锁失败（busy/maintenance/root_*/dir_*/lock_residue/reap_*/io_error）都不得写 legacy。
    // #R37 P1-4：外层取锁失败也把 acq.path/error 透出（不再只折成 lock:null），供 unclean 投影点名残骸路径。
    return { ok: false, commit: "not_committed", reason: acq.reason ?? "binding_busy", why: acq.why ?? null, lock: acq.lock ?? null, lockPath: acq.path ?? null, lockError: acq.error ?? null, legacy: null, shadow: null, release: null };
  }
  let result;
  try {
    // P1-1（#R37 返修）：已启用点取得 outer 后、legacy 前核账本现场 ——
    //   cutover 已切（authoritative）→ M1a 不得再写 legacy（ledger-only 写方属 M1b）；
    //   账本现场不可读/缺席 → 无法镜像 legacy，整笔拒；authority_mode 非 shadow → 同样拒。
    if (receipt.cutoverDone === true) {
      result = { ok: false, commit: "not_committed", reason: "m1a_mode_not_shadow", why: "已切权威（cutover done）：M1a 代码不得在切换后再写 legacy（ledger-only 写方属 M1b）", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    const ledger = loadByEndpoint(endpointId, { env });
    if (!ledger.ok) {
      result = { ok: false, commit: "not_committed", reason: "m1a_ledger_absent", why: "已启用端点账本现场不可读/缺席（" + (ledger.reason ?? "unknown") + "）：M1a 无法镜像 legacy，fail-closed", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    if (ledger.doc.authority_mode !== "shadow") {
      result = { ok: false, commit: "not_committed", reason: "m1a_mode_not_shadow", why: "账本 authority_mode=" + ledger.doc.authority_mode + "：M1a 代码不得在切换后再写 legacy", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    // #R37 P1-1②：锁内重核六件事。preflight 在取得 outer 锁、cutover/账本/权威校验通过后、legacy 前运行
    //   —— 因为 legacy() 会消费 pending（promoteBinding 把 pending 拉成 active），事后无法再重核 pending 现场。
    //   调用方（inbound.mjs 的 verify）注入重核谓词；拒 → 整笔 fail-closed（不跑 legacy、不写 shadow）。
    let pf = null;
    if (preflight) {
      pf = preflight({ endpointId, env, lock: acq.lock });
      if (!pf || pf.ok !== true) {
        result = { ok: false, commit: "not_committed", reason: pf?.reason ?? "preflight_reject", why: pf?.why ?? "锁内重核未通过", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
        return result;
      }
    }
    let legacyRes;
    try { legacyRes = legacy(); }
    catch (err) {
      result = { ok: false, commit: "not_committed", reason: "legacy_failed", why: String(err?.message ?? err), legacy: null, shadow: null, release: null };
      return result;
    }
    // legacy 明确未提交（ok:false）→ 无 legacy 结果可镜像 → 不跑 shadow 后缀（不写幽灵记录/标记）。
    // W4（P1-3③）：lock-only 行（连接暂停/恢复、enabled 翻转）不写 shadow 事务——对账兜底（doctor+repair），
    //   但 outer 锁必须取（绕过 outer 就穿了 cutover 快照窗口）；对账兜底=无双写，**不是无锁**。
    const shadow = lockOnly ? [] : (legacyRes && legacyRes.ok === false ? [] : (submit(legacyRes, pf) ?? []));
    result = { ok: true, legacy: legacyRes, shadow, release: null };
    return result;
  } finally {
    const rel = acq.release();
    if (result && typeof result === "object") result.release = rel;
  }
}

/* ── PK2-W1（M1b-W1）：切权威后的会话级绑定 + 认领（authoritative 复合写）──────────
 *
 * 背景：`runWired`（上面）对**所有** M1a 双写入口在 cutoverDone / authority_mode≠shadow 时一律拒
 * `m1a_mode_not_shadow`（影子期契约）—— 切权威后新绑定建不了。W1 只开两条**具名**复合：
 *   · `wireBindAuthoritative`  会话级绑定（建根话题 → create_b1 → 索引行 → sidecar 条目）
 *   · `wirePromoteAuthoritative` 认领（create_a1 → activate → 索引更新 → 删 pending-claims 条目）
 * 其余 wire*（rotate / void / pause / resume / retarget / chatA1 / bindClaim）**仍拒**（清单封闭）。
 *
 * 不变量（docs/architecture/m1a-reconciliation.md §4）：account 期 legacy 登记表/mapping 只是**索引**
 * （root_message_id / chat_id / claude_session_id / 认领后的 session_id、inbound_state）——
 * binding_target / token / expires_at / policy 这些**已迁事实以账本 + sidecar 为准**，索引里的同名字段
 * 是创建时快照，只供尚未切换的读方过渡（I2/I3 切完就不再被读），不由这里回写、不参与对账判定。
 *
 * 顺序固定（账本先于索引）：账本已验证提交后的索引/sidecar 失败 = `committed_unclean`，
 * **按同一 request key 确定性幂等续跑**（重跑同一条命令：话题幂等、create_b1/activate 重放命中、
 * 索引 upsert、sidecar upsert），不新开 WAL。 */

/** 写方判源（拿收据，不拿账本）：never_initialized→legacy，cutoverDone→authoritative，
 *  其余（init-only）→shadow；收据不可读 → reject（fail-closed，与 runWired 同口径）。 */
export function m1aWriteRoute({ endpointId, env = process.env }) {
  const recDir = maintenanceDir(env);
  const receipt = typeof recDir === "string" && recDir.length > 0
    ? endpointReceipt(recDir, endpointId)
    : { ok: false, state: "unreadable", why: "维护目录不可派生（maintenanceDir 返回 null/空）" };
  if (receipt.ok === true && receipt.state === "never_initialized") return { mode: "legacy", why: "未接入 M1a（无任何账本收据）", receipt };
  if (receipt.ok !== true) return { mode: "reject", why: receipt.why ?? "M1a 收据不可读，fail-closed", receipt };
  if (receipt.cutoverDone === true) return { mode: "authoritative", why: "收据已 cutover", receipt };
  return { mode: "shadow", why: "收据 init-only", receipt };
}

/** 条目值的规范化（与 sidecar renderer 同一判据：ISO → toISOString）。 */
const isoOf = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * authoritative 复合写的共用骨架：m1a-order outer 锁（与 shadow 写方**同一把**，串行）→
 * 判源（必须是 authoritative；账本读不出/模式不符 → `m1a_mode_not_shadow`/`m1a_ledger_absent`）
 * → 逐步骤跑（`steps` 顺序即提交顺序；第一个失败即停）→ 释放。
 *
 * 返回 union 与 shadow 写方同形（`ok` / `legacy` / `shadow` / `release`），另加：
 *   · `commit`：`not_committed`（账本未提交）| `committed_clean` | `committed_unclean`
 *     （账本已提交而后继失败，或任何一笔原语的提交本身不干净：residue / durability_uncertain）；
 *   · `commits`：**逐原语**的提交证据（顺序即提交顺序）。一个步骤里可能有两笔原语
 *     （认领 = create_a1 → activate），所以提交进度必须逐笔记 —— 只记"步骤成没成"会把
 *     "a1 已提交、activate 未成"那半笔误报成 `not_committed`（P1-3）。
 * `buildLegacy(steps)` 由各复合自己给 —— 它决定调用方看到的 "legacy 结果" 是什么。
 */
function runAuthoritative({ endpointId, env = process.env, steps, buildLegacy }) {
  const recDir = maintenanceDir(env);
  const receipt = typeof recDir === "string" && recDir.length > 0
    ? endpointReceipt(recDir, endpointId)
    : { ok: false, state: "unreadable", why: "维护目录不可派生" };
  if (!(receipt.ok === true && receipt.cutoverDone === true)) {
    // 封闭清单：非 authoritative 一切照 shadow 契约拒（调用方本应分派到旧路径，走到这里就是不支持）。
    return { ok: false, commit: "not_committed", reason: "m1a_mode_not_shadow", why: "W1 复合只开 authoritative（收据=" + String(receipt.state ?? "unreadable") + "）", legacy: null, shadow: null, release: null };
  }
  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) {
    return { ok: false, commit: "not_committed", reason: acq.reason ?? "binding_busy", why: acq.why ?? null, lock: acq.lock ?? null, lockPath: acq.path ?? null, lockError: acq.error ?? null, legacy: null, shadow: null, release: null };
  }
  // P1-3（返修）：早退路径也先把结果赋给 `result` —— 只有 result 非 null 才在 finally 里
  //   把释放证据折上去（旧版这几条直接 return 字面量，`release: null` 把 "锁没交还" 吞了）。
  let result = null;
  try {
    const L = loadByEndpoint(endpointId, { env });
    if (!L.ok) {
      result = { ok: false, commit: "not_committed", reason: "m1a_ledger_absent", why: "账本现场不可读/缺席（" + String(L.reason ?? "unknown") + "）：fail-closed", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    if (L.doc.authority_mode !== "authoritative") {
      result = { ok: false, commit: "not_committed", reason: "m1a_mode_not_shadow", why: "账本 authority_mode=" + String(L.doc.authority_mode) + "（W1 复合只开 authoritative）", lock: acq.lock ?? null, legacy: null, shadow: null, release: null };
      return result;
    }
    const shadow = [];
    const byOp = new Map();
    const commits = [];
    for (const st of steps) {
      let r;
      try { r = st.run({ ledgerCommitted: commits.length > 0, byOp }); }
      catch (err) { r = { ok: false, reason: st.op + "_threw", why: String(err?.code ?? err?.message ?? err) }; }
      const step = { op: st.op, ok: r?.ok === true, ...(r ?? {}) };
      shadow.push(step);
      byOp.set(st.op, step);
      // 逐原语记提交进度：步自报的 `commits`（先提交的先入）在前，步级 capture 的证据（本步最后一笔）在后。
      for (const c of (Array.isArray(step.commits) ? step.commits : [])) commits.push({ ...c });
      if (typeof step.committed === "string" && step.committed.startsWith("committed")) {
        commits.push({ op: step.op, commit: step.committed, idempotent: step.idempotent === true,
          residue: step.residue ?? null, lockUncleared: step.lockUncleared ?? null, path: step.path ?? null, error: step.error ?? null });
      }
      if (step.ok !== true) {
        result = { ok: true, authoritative: true, commit: commits.length > 0 ? "committed_unclean" : "not_committed",
          reason: step.reason ?? (st.op + "_failed"), why: step.why ?? null, commits: [...commits],
          legacy: buildLegacy({ byOp, shadow, failedOp: st.op }), shadow, release: null };
        return result;
      }
    }
    // 全绿也按**真实 commit** 联合判：committed_with_residue / committed_durability_uncertain
    //   不是 clean（与 uncleanWired 的②类同口径）—— 一律落 committed_unclean。
    const uncleanCommit = commits.some((c) => c.commit !== "committed_clean" || c.residue || c.lockUncleared || c.path || c.error);
    result = { ok: true, authoritative: true, commit: uncleanCommit ? "committed_unclean" : "committed_clean",
      commits: [...commits], legacy: buildLegacy({ byOp, shadow, failedOp: null }), shadow, release: null };
    return result;
  } finally {
    const rel = acq.release();
    if (result && typeof result === "object") result.release = rel;
  }
}

/**
 * wireBindAuthoritative —— 会话级绑定的 authoritative 复合（顺序固定）：
 *   ① createTopic（平台幂等键建根话题，与现行同）
 *   ② 账本 create_b1（rootOm / chatId / lineageId / bindingTarget —— target **必须**带 UUID 会话）
 *   ③ 索引行 upsert（调用方给 `publishIndex` 闭包：登记表事务入口里锁内重读后局部更新）
 *   ④ sidecar：`pending-claims[topic_agent_id]={token, claim_expires_at:null}` + `expiry[topic_agent_id]=expiresAt`
 * 项目级/null target 由**调用方**拒（bind-project 不动）；这里只收会话级。
 * 幂等续跑：同 `externalRequestId` 下，① 平台幂等（同 om）、② request_key 重放命中、③ upsert、④ upsert。
 */
export function wireBindAuthoritative({
  endpointId, env = process.env, externalRequestId, lineageId, chatId, bindingTarget,
  pendingToken, expiresAt, createTopic, publishIndex, now = Date.now(),
}) {
  return runAuthoritative({ endpointId, env, steps: [
    { op: "topic", run: () => {
      const t = createTopic();
      return t && t.ok === true && en(t.root_message_id) ? { ok: true, root_message_id: t.root_message_id } : { ok: false, reason: t?.reason ?? "topic_failed", why: t?.message ?? t?.why ?? "建根话题失败" };
    } },
    { op: "ledger", run: ({ byOp }) => {
      if (!en(externalRequestId) || !en(lineageId)) return { ok: false, reason: "bad_external_id", why: "externalRequestId/lineageId 必填 1..256 字符串" };
      // 清单封闭：W1 只开会话级 target（UUID）。项目级/null 仍拒（bind-project 不动）。
      const sid = bindingTarget?.claude_session_id;
      if (!(typeof sid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(sid))) {
        return { ok: false, reason: "m1a_mode_not_shadow", why: "W1 只开会话级绑定（binding_target.claude_session_id 必须是 UUID）；项目级/null target 仍拒" };
      }
      const om = byOp.get("topic")?.root_message_id ?? null;
      if (!en(om)) return { ok: false, reason: "bad_external_id", why: "根话题 om 缺失" };
      const k = rk("create_b1", "bind:" + externalRequestId, lineageId);
      if (!k.ok) return { op: "create_b1", ...k };
      const r = capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm: om, lineageId, bindingTarget, env }));
      if (r.ok !== true) return r;
      const id = r.result?.created_id ?? null;
      return { ...r, root_message_id: om, topic_agent_id: id };
    } },
    { op: "index", run: ({ byOp }) => {
      const om = byOp.get("topic")?.root_message_id ?? null;
      return publishIndex({ rootMessageId: om, endpointId, env });
    } },
    { op: "sidecars", run: ({ byOp }) => {
      const ta = byOp.get("ledger")?.topic_agent_id ?? null;
      if (!en(ta)) return { ok: false, reason: "bad_topic_agent_id", why: "账本 create_b1 未返回 topic_agent_id（无法写 sidecar 条目）" };
      const iso = isoOf(expiresAt);
      if (iso === null) return { ok: false, reason: "bad_expires_at", why: "expiresAt 不可规范化：" + JSON.stringify(expiresAt ?? null) };
      if (!en(pendingToken)) return { ok: false, reason: "bad_pending_token", why: "pendingToken 必填（pending-claims 条目的 token）" };
      const claim = mutateSidecarEntry({ endpointId, name: "pending-claims", key: ta, env,
        mutate: (cur) => (cur?.token === pendingToken && cur?.claim_expires_at === null ? { ok: true, changed: false } : { ok: true, changed: true, value: { token: pendingToken, claim_expires_at: null } }) });
      if (claim.ok !== true) return { ok: false, reason: "pending_claims_" + String(claim.reason ?? "failed"), why: claim.why ?? null };
      const exp = mutateSidecarEntry({ endpointId, name: "expiry", key: ta, env,
        mutate: (cur) => (cur === iso ? { ok: true, changed: false } : { ok: true, changed: true, value: iso }) });
      if (exp.ok !== true) return { ok: false, reason: "expiry_" + String(exp.reason ?? "failed"), why: exp.why ?? null };
      return { ok: true, topic_agent_id: ta, pending_claims: claim.changed === true, expiry: exp.changed === true };
    } },
  ], buildLegacy: ({ byOp, failedOp }) => {
    const topic = byOp.get("topic");
    const om = topic?.root_message_id ?? null;
    if (failedOp === null) return { ok: true, root_message_id: om, count: byOp.get("index")?.count ?? null, topic_agent_id: byOp.get("ledger")?.topic_agent_id ?? null };
    // 话题没建成 → 无副作用（与 shadow 路径同形）；话题已建 → 携带 phase 让调用方说清停在哪一步。
    if (failedOp === "topic") return { ok: false, phase: "send", message: byOp.get("topic")?.why ?? "建话题失败", reason: byOp.get("topic")?.reason ?? "topic_failed" };
    const phase = failedOp === "ledger" ? "ledger" : failedOp === "index" ? "registry" : "sidecar";
    return { ok: false, phase, root_message_id: om, reason: byOp.get(failedOp)?.reason ?? failedOp, message: byOp.get(failedOp)?.why ?? "（无 why）" };
  } });
}

/**
 * wirePromoteAuthoritative —— 认领（pending B1 → active）的 authoritative 复合（顺序固定）：
 *   ① 账本 create_a1 → activate（与 §5.1 同；f4 判别照旧由调用方受验）
 *   ② 删 `pending-claims` 里该 B1 的条目（幂等）—— **在索引之前**：索引一更新，legacy 现场就不再
 *      pending（inbound 的 findPendingBinding 直接挡），删失败就成了不可续跑的半笔（P1-2）
 *   ③ 索引更新（调用方给 `publishIndex` 闭包 —— 现行 promoteBinding：session_id / inbound_state …）
 * **只开 pending B1**：目标是 B3（换会话 rebind）/其它族 → 拒 `m1a_mode_not_shadow`（W2 另单）。
 */
export function wirePromoteAuthoritative({
  endpointId, env = process.env, locator, claimKey, sessionId, authorizedBy, f4 = null, verify = null,
  publishIndex, now = Date.now(),
}) {
  return runAuthoritative({ endpointId, env, steps: [
    { op: "ledger", run: ({ byOp }) => {
      if (!en(claimKey) || !en(sessionId) || !en(locator)) return { ok: false, reason: "bad_external_id", why: "claimKey/sessionId/locator 必填 1..256 字符串" };
      if (typeof verify === "function") {
        const pf = verify();
        if (!pf || pf.ok !== true) return { ok: false, reason: pf?.reason ?? "preflight_reject", why: pf?.why ?? "锁内重核未通过" };
        byOp.set("__preflight", { f4: pf.f4 ?? null });
      }
      const resolved = resolveLiveId({ endpointId, locator, env });
      if (!resolved.ok) return { op: "promote", ok: false, reason: resolved.reason, why: resolved.why ?? null };
      const b1Id = resolved.id;
      const l = loadByEndpoint(endpointId, { env });
      if (!l.ok) return { op: "promote", ok: false, reason: "ledger_unreadable", why: l.why ?? null };
      const target = l.doc.records[b1Id];
      if (!target || target.kind !== "live") return { op: "promote", ok: false, reason: "target_gone" };
      // 清单封闭：只有 pending B1 走本复合（B3 rebind / B4 / 已 active 一律拒，W2 另单）。
      // **例外：同一 request key 的确定性续跑** —— 上一次认领已把 B1 拉成 active、但后继（索引/sidecar）
      //   失败（committed_unclean），重跑同一条命令必须能补齐。判据不是"已 active"，而是
      //   "账本里已有这条 activate 请求键"（重放命中）—— 换个 claimKey 再来就是新一笔认领，仍拒。
      if (target.facts.binding !== "pending") {
        const kReplay = rk("activate", claimKey, b1Id);
        const replayed = kReplay.ok && Object.values(l.doc.operations ?? {}).some((op) => op?.request_key === kReplay.request_key);
        if (!replayed) {
          return { op: "promote", ok: false, reason: "m1a_mode_not_shadow",
            why: "认领目标 facts.binding=" + String(target.facts.binding) + "（W1 只开 pending B1 的 create_a1→activate；换会话 rebind 属 W2）" };
        }
      }
      const f4Use = (byOp.get("__preflight")?.f4 ?? null) !== null ? byOp.get("__preflight").f4 : f4;
      if (!f4Ok(f4Use, locator)) return { op: "create_a1", ok: false, reason: "bad_f4", why: "F4 必须是认领校验处受验的封闭判别联合（matched_om=locator）" };
      const chatId0 = typeof target.chat_id === "string" ? target.chat_id : null;
      if (!en(chatId0)) return { op: "create_a1", ok: false, reason: "bad_input", why: "target.chat_id 缺失" };
      const kA1 = rk("create_a1", claimKey, sessionId);
      if (!kA1.ok) return { op: "create_a1", ...kA1 };
      const a1 = capture("create_a1", createA1({ endpointId, requestKey: kA1.request_key, chatId: chatId0, sessionId, now, env }));
      if (a1.ok !== true) return a1;
      // create_a1 的提交证据单独带出（步级 capture 只会留得下 activate 那一笔）—— P1-3。
      const a1Commit = [{ op: "create_a1", commit: a1.committed ?? "committed_clean", idempotent: a1.idempotent === true,
        residue: a1.residue ?? null, lockUncleared: a1.lockUncleared ?? null, path: a1.path ?? null, error: a1.error ?? null,
        a1_id: a1.result?.created_id ?? null }];
      const kAct = rk("activate", claimKey, b1Id);
      if (!kAct.ok) return { op: "activate", ...kAct, commits: a1Commit };
      const act = capture("activate", activate({ endpointId, requestKey: kAct.request_key, b1Id, a1Id: a1.result?.created_id, f4: f4Use, authorizedBy, now, env }));
      // 失败也带上 a1 的证据："create_a1 已提交、activate 未成" 是半笔，调用方要能点名。
      if (act.ok !== true) return { ...act, op: "activate", commits: a1Commit };
      // topic_agent_id 直接取账本里那条记录自己的 id（权威事实，不重算）。
      // act 的 capture 证据（committed/idempotent/residue/lockUncleared）一并保留，不丢。
      return { ...act, ok: true, op: "activate", b1Id, a1_id: a1.result?.created_id ?? null, topic_agent_id: target.topic_agent_id ?? null, chat_id: chatId0, commits: a1Commit };
    } },
    // 顺序固定（P1-2）：账本 → **删 pending 条目** → 索引。
    //   反过来的话，索引一更新 legacy 现场就不再 pending（inbound 的 findPendingBinding 直接就挡），
    //   而删条目那一步失败时这笔就没法续跑了。删在前面：删失败 → 索引还没写 → 现场仍可认领，
    //   同一条命令重跑就能补齐（删除是条目级幂等的）。
    { op: "sidecars", run: ({ byOp }) => {
      const ta = byOp.get("ledger")?.topic_agent_id ?? null;
      if (!en(ta)) return { ok: false, reason: "bad_topic_agent_id", why: "账本未给出 topic_agent_id（无法删 pending-claims 条目）" };
      const del = mutateSidecarEntry({ endpointId, name: "pending-claims", key: ta, env,
        mutate: (cur) => (cur === null ? { ok: true, changed: false } : { ok: true, changed: true, value: null }) });
      if (del.ok !== true) return { ok: false, reason: "pending_claims_" + String(del.reason ?? "failed"), why: del.why ?? null };
      return { ok: true, deleted: del.changed === true };
    } },
    { op: "index", run: ({ byOp }) => publishIndex({ b1Id: byOp.get("ledger")?.b1Id ?? null, endpointId, env }) },
  ], buildLegacy: ({ byOp, failedOp }) => {
    if (failedOp === null) {
      const idx = byOp.get("index") ?? {};
      return { ok: true, root: idx.root ?? null, sessionId, generation: idx.generation ?? null };
    }
    const phase = failedOp === "ledger" ? "promote" : failedOp === "index" ? "registry" : "sidecar";
    return { ok: false, phase, reason: byOp.get(failedOp)?.reason ?? failedOp, message: byOp.get(failedOp)?.why ?? "（无 why）" };
  } });
}

/* ── per-writer 具名函数（§5.1 每一行一个） ─────────────────── */

/* A1 物化（chat）双写接线：把入站 chat 的 endpoint（agent_uid 派生）/oc_ chat_id / Aily
 * session_id / message_id 一并线程进 wireCreateA1，legacy 回调为 admitChat。
 * #R37：wrapper 层面即执行裁定 —— 已启用点任一取锁失败 → 整笔拒、不写 legacy；
 *   never_initialized → 合法 legacy-only；收据说不清 → fail-closed。可用性取 drop（裁定默认）。
 * 这是入站 chat 流的 A1 写入口，专供 inbound.mjs chatTurn 使用（运行时恒为 claude）。 */
export function wireChatA1({ agentUid, chatId, sessionId, messageId, env = process.env, admit, runtime = "claude", now = Date.now() }) {
  return wireCreateA1({
    endpointId: legacyEndpointId({ runtime, agentUid }), env, legacy: admit,
    chatId, sessionId, messageId, now,
  });
}

/**
 * wireCreateA1 —— 两链所有 A1 物化入口（任一受验首条 @ 的 chat 记录）→ 账本 create_a1。
 * ext=入站 message id；entity=受验 Aily session locator；key 一请求一值。
 */
export function wireCreateA1({ endpointId, env = process.env, legacy, chatId, sessionId, messageId, now = Date.now(), _inject = null }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(messageId) || !en(sessionId)) return [{ op: "create_a1", ok: false, reason: "bad_external_id", why: "messageId/sessionId 必填 1..256 字符串" }];
    const k = rk("create_a1", messageId, sessionId);
    if (!k.ok) return [{ op: "create_a1", ...k }];
    return [capture("create_a1", createA1({ endpointId, requestKey: k.request_key, chatId, sessionId, now, env, _inject }))];
  } });
}

/**
 * wireBindClaim —— bind/认领（claim→绑定：引用码、@ 配对）→ create_a1 → activate（固定顺序）。
 * ext=claim key；create_a1 entity=session locator、activate entity=B1 topic_agent_id（两笔 key 不同）。
 * 调用方须能解析出 shadow 侧 b1Id（M1a 期来自 migrate_seed/create_b1 的 B1）。
 */
export function wireBindClaim({ endpointId, env = process.env, legacy, claimKey, chatId, sessionId, b1Id, f4, authorizedBy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(claimKey) || !en(sessionId) || !en(b1Id)) return [{ op: "create_a1", ok: false, reason: "bad_external_id", why: "claimKey/sessionId/b1Id 必填 1..256 字符串" }];
    const kA1 = rk("create_a1", claimKey, sessionId);
    if (!kA1.ok) return [{ op: "create_a1", ...kA1 }];
    const a1 = capture("create_a1", createA1({ endpointId, requestKey: kA1.request_key, chatId, sessionId, now, env }));
    if (!a1.ok) return [a1]; // create_a1 失败（如 locator 撞）→ 序列必须停（activate 需 a1Id）
    const a1Id = a1.result?.created_id;
    const kAct = rk("activate", claimKey, b1Id);
    if (!kAct.ok) return [a1, { op: "activate", ...kAct }];
    return [a1, capture("activate", activate({ endpointId, requestKey: kAct.request_key, b1Id, a1Id, f4, authorizedBy, now, env }))];
  } });
}

/**
 * wirePromoteBinding —— 认领→绑定（promoteBinding：引用码/@ 配对把 pending 拉成 active）。
 * shadow 由 resolver 按 locator 命中目标，按其事实分叉：
 *   W1（B1 仍 pending）→ create_a1 → activate（标准四项配对证明 + 64hex claimKey）；
 *   W2（B3 已 active 换会话，再认领）→ rebind_session_alias（**只**改 aliases.session_id 到新 Aily 会话
 *     locator；binding_target 的 claude_session_id 归 Phase 2 配对写方 retarget，认领现场不铸临时 UUID）。
 * locator = 被认领代际的根消息 om（= matched_om）；claimKey = claim.mjs 64hex key（调用方用
 *   claimKey(messageId, logicalTaskKey) 派生）。W2 的 new aliases.session_id = sessionId（认领现场受验的
 *   新 Aily 会话 locator）；expectedOldSessionId = 当前 B3 的 aliases.session_id（CAS）。
 * 目标状态与 locator 对不上（如无 shadow 记录）/读不出）→ fail-closed，不猜。 */
export function wirePromoteBinding({
  endpointId, env = process.env, legacy, locator, claimKey, sessionId, authorizedBy,
  f4 = null, verify = null, now = Date.now(),
}) {
  return runWired({ endpointId, env, legacy, preflight: verify, submit: (legacyRes, pf) => {
    if (!en(claimKey) || !en(sessionId) || !en(locator)) return [{ op: "promote", ok: false, reason: "bad_external_id", why: "claimKey/sessionId/locator 必填 1..256 字符串" }];
    const resolved = resolveLiveId({ endpointId, locator, env });
    if (!resolved.ok) return [{ op: "promote", ok: false, reason: resolved.reason, why: resolved.why ?? null }];
    const b1Id = resolved.id;
    const l = loadByEndpoint(endpointId, { env });
    if (!l.ok) return [{ op: "promote", ok: false, reason: "ledger_unreadable", why: l.why ?? null }];
    const target = l.doc.records[b1Id];
    if (!target || target.kind !== "live") return [{ op: "promote", ok: false, reason: "target_gone" }];
    if (target.facts.binding === "active") {
      // P1-5（Codex）：W2 只认精确 B3（active+current）。B4（历史代际，binding 也是 active）误被判活跃而重绑——
      //   这里 fail-closed（不路由成 rebind，也不降级成 activate），family 不对 → target_not_current。
      if (familyOf(target.facts) !== "B3") return [{ op: "promote", ok: false, reason: "target_not_current", why: "familyOf=" + String(familyOf(target.facts)) + "（仅 B3 current 可换会话重绑，B4 历史/其它 fail-closed）" }];
      // W2 再认领（B3 已 active 换会话）→ rebind_session_alias：**只**改 aliases.session_id（换到新 Aily 会话
      // locator），不动 binding_target/proof/family/lineage。newSessionId = 认领现场受验的新会话 locator
      // （sessionId，非临时随机）；expectedOldSessionId = 当前 B3 的 aliases.session_id（CAS）。
      if (!en(sessionId)) return [{ op: "rebind_session_alias", ok: false, reason: "bad_external_id", why: "sessionId 必填（新 Aily 会话 locator）" }];
      const k = rk("rebind_session_alias", claimKey, b1Id);
      if (!k.ok) return [{ op: "rebind_session_alias", ...k }];
      // R57a 返修二 P1-2：handle 事务不传数值 now——到期/TTL 由锁内 clock() 读取
      return [capture("rebind_session_alias", rebindSessionAlias({ endpointId, requestKey: k.request_key, id: b1Id, expectedOldSessionId: target.aliases.session_id, expectedRootOm: target.aliases.root_om, newSessionId: sessionId, authorizedBy, env }))];
    }
    if (target.facts.binding !== "pending") return [{ op: "promote", ok: false, reason: "target_not_pending_or_active", why: "target.facts.binding=" + String(target.facts.binding) }];
    // W1 引用码认领（B1 仍 pending）→ create_a1 → activate。P1-2 收尾：**只消费**认领校验处受验的
    // 封闭 f4（matched_om===locator 且 matched_fields=标准四项）；拿不到受验产物/不符 → 该笔 shadow 拒
    // （不写配对证明、不自铸）。任意 locator/owner 字符串不得 activate 出四项证明。
    // #R37 P1-1②：锁内重核给出 f4（verify.ok→pf.f4）时全权替代调用侧 f4（锁内结论优先）。
    const f4Use = (pf && pf.ok === true && pf.f4 != null) ? pf.f4 : f4;
    if (!f4Ok(f4Use, locator)) return [{ op: "promote", ok: false, reason: "bad_f4", why: "F4 必须是认领校验处受验的封闭判别联合（matched_om=locator 且 token 四项或 no-token 三项），wirePromoteBinding 只消费不铸造" }];
    const chatId = typeof target.chat_id === "string" ? target.chat_id : null;
    if (!en(chatId)) return [{ op: "create_a1", ok: false, reason: "bad_input", why: "target.chat_id 缺失" }];
    const kA1 = rk("create_a1", claimKey, sessionId);
    if (!kA1.ok) return [{ op: "create_a1", ...kA1 }];
    const a1 = capture("create_a1", createA1({ endpointId, requestKey: kA1.request_key, chatId, sessionId, now, env }));
    if (!a1.ok) return [a1]; // create_a1 失败（如 locator 撞）→ 序列停（activate 需 a1Id）
    const kAct = rk("activate", claimKey, b1Id);
    if (!kAct.ok) return [a1, { op: "activate", ...kAct }];
    return [a1, capture("activate", activate({ endpointId, requestKey: kAct.request_key, b1Id, a1Id: a1.result?.created_id, f4: f4Use, authorizedBy, now, env }))];
  } });
}

/**
 * wireAttach —— 显式 attach（终端）→ 账本 attach（内部按当前族拆 attach_a2|attach_a3，一笔 key）。
 * ext=控制 claim key（终端命令 claim 机制既有、持久）；entity=目标 id。
 */
export function wireAttach({ endpointId, env = process.env, legacy, claimKey, id, bindingTarget, authorizedBy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(claimKey) || !en(id)) return [{ op: "attach", ok: false, reason: "bad_external_id", why: "claimKey/id 必填 1..256 字符串" }];
    const k = rk("attach", claimKey, id);
    if (!k.ok) return [{ op: "attach", ...k }];
    // R57a 返修二 P1-2：attach 不传数值 now（handle TTL 走锁内 clock()）
    return [capture("attach", attach({ endpointId, requestKey: k.request_key, id, bindingTarget, claimKey, authorizedBy, env }))];
  } });
}

/**
 * rotateCompositeSubmit —— P1-4（#R37 返修 ①②③）旋转复合体的 shadow 序列：
 *   void(过期的旧 B1, reason=expired) → create_b1(新建代际)，同一笔外锁内两 op。
 * 两个 op 从**同一个** rotation operation id 派生**不同** request_key
 *   （ext=rotationOpId 相同；op_type=void/create_b1、entity=旧 B1 id / lineage id 相异），
 *   逐 op 幂等重放（账本 writeLedger 按 request_key 去重：replay→committed_clean,idempotent）。
 * ② 每 op 各自独立有效：void 失败（旧 B1 缺席/已作废）**不阻断** create_b1；create_b1 失败也不撤销 void。
 * 仅在 legacyRes.supersededRootOm 命中到仍 live 的旧 B1 时才算 void 落账；否则 void 投影 fail-closed 保留在结果里。
 * @returns 影子序列（每项 capture 结果：{op, ok, ...}）
 */
function rotateCompositeSubmit({ endpointId, env, legacyRes, rotationOpId, lineageId, chatId, rootOm = null, bindingTarget, now }) {
  const om = (legacyRes && typeof legacyRes === "object" && legacyRes.root_message_id) ? legacyRes.root_message_id : rootOm;
  if (!en(rotationOpId) || !en(lineageId) || !en(om)) return [{ op: "create_b1", ok: false, reason: "bad_external_id", why: "rotationOpId/lineageId/rootOm 必填 1..256 字符串" }];
  const ops = [];
  const supersededOm = (legacyRes && typeof legacyRes === "object" && legacyRes.supersededRootOm) ? legacyRes.supersededRootOm : null;
  if (en(supersededOm)) {
    const resolved = resolveLiveId({ endpointId, locator: supersededOm, env });
    if (resolved.ok) {
      const kv = rk("void", rotationOpId, resolved.id);
      // R57a 返修二 P1-2：void 不传数值 now（到期核走锁内 clock()）
      ops.push(kv.ok ? capture("void", voidPending({ endpointId, requestKey: kv.request_key, b1Id: resolved.id, reason: "expired", env })) : { op: "void", ...kv });
    } else {
      // 旧 B1 在 shadow 缺席（legacy-only / 已作废 / 读不出）→ void fail-closed 投影，但不阻断 create_b1。
      ops.push({ op: "void", ok: false, reason: resolved.reason, why: resolved.why ?? null });
    }
  }
  const k = rk("create_b1", rotationOpId, lineageId);
  if (!k.ok) { ops.push({ op: "create_b1", ...k }); return ops; }
  // R57a 返修二 P1-2：create_b1 不传数值 now（handle TTL 由锁内 clock() 读取）
  ops.push(capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm: om, lineageId, bindingTarget, env })));
  return ops;
}

/**
 * wireRotate —— rotate（建新代际）→ 账本复合体 [void(过期旧 B1) → create_b1(新代际)]（P1-4）。
 * 一笔外锁内两 op；两 op 从同一 persistent rotation operation id 派生不同 request_key；
 * rootOm 二选一：优先从 legacyRes.root_message_id 取（轮转的 topic 根消息在 legacy 闭包里由
 *   sendToChat 创建，锁必须在它之前取——W3），缺省才回退到静态 rootOm 参数。
 * legacyRes.supersededRootOm（可选）= 被作废旧代际根消息 om —— 调用方 legacy 闭包把
 *   prepareClaudeTopicRotation({supersedeExpired:true}).superseded.root_message_id 线程过来。 */
export function wireRotate({ endpointId, env = process.env, legacy, rotationOpId, lineageId, chatId, rootOm = null, bindingTarget, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => rotateCompositeSubmit({ endpointId, env, legacyRes, rotationOpId, lineageId, chatId, rootOm, bindingTarget, now }) });
}

/**
 * wireRotateRecovery —— P1-4 ④（#R37 返修）续跑恢复：legacy 已有新 pending、但 shadow 只写了 void、
 *   create_b1 缺失。**shadow-only、无 legacy 业务副作用**（prepare/sendToChat/register 由首次 run 完成，本次只补镜像）。
 *   前提：void 已提交（这就是本恢复被调用的判定），故**只补缺失的 create_b1**、不重发 void（重发反而因目标已
 *   作废而 resolv 不到）。ext 沿用首次 run 的 rotation operation id，故 create_b1 幂等：已提交——重放命中，
 *   缺失——才真落账。不许被「已有 pending」预检挡掉；调用方检测到缺失时路由到本函数而非重复创建。
 *   #R37 P1-3②：补影像前在同一个 outer 锁内重核 legacy 现场（pending/operation-id/root），避免对已变的现场写错影像。
 *   verifyLegacy（可选闭包）在同一个 outer 锁内、create_b1 前跑：返回 { ok:true, root_message_id } 才延续；
 *   返回 { ok:false, reason, why } 则整笔拒、不写 create_b1（不略影像）。未传时回退到旧的 stub。 */
export function wireRotateRecovery({ endpointId, env = process.env, rotationOpId, lineageId, chatId, rootOm, bindingTarget, verifyLegacy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy: () => (verifyLegacy ? verifyLegacy() : { ok: true, root_message_id: rootOm }), submit: (legacyRes) => {
    if (!legacyRes || legacyRes.ok !== true) return [{ op: "create_b1", ok: false, reason: "legacy_verify_failed", why: legacyRes?.why ?? "补 create_b1 前 legacy 现场复核未通过" }];
    const k = rk("create_b1", rotationOpId, lineageId);
    if (!k.ok) return [{ op: "create_b1", ...k }];
    // R57a 返修二 P1-2：不传数值 now（TTL 走锁内 clock()）
    return [capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm, lineageId, bindingTarget, env }))];
  } });
}

/**
 * wireVoid —— rotate cancel / pending 过期 → 账本 void。
 * ext=rotation operation id；目标由 resolver 按 locator（被作废代际根消息 om）命中。
 * reason 用封闭枚举映射：cancel→"manual"、过期→"expired"（不扩枚举）。resolver 未命中 → 无 B1 可 void，
 *   该笔 shadow fail-closed（locator_absent 等），legacy 照常完成（轮转本来就可能 legacy-only、无 B1）。 */
export function wireVoid({ endpointId, env = process.env, legacy, rotationOpId, locator, reason, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(rotationOpId) || !en(locator)) return [{ op: "void", ok: false, reason: "bad_external_id", why: "rotationOpId/locator 必填 1..256 字符串" }];
    const resolved = resolveLiveId({ endpointId, locator, env });
    if (!resolved.ok) return [{ op: "void", ok: false, reason: resolved.reason, why: resolved.why ?? null }];
    const id = resolved.id;
    const k = rk("void", rotationOpId, id);
    if (!k.ok) return [{ op: "void", ...k }];
    // R57a 返修二 P1-2：void 不传数值 now（到期核走锁内 clock()）
    return [capture("void", voidPending({ endpointId, requestKey: k.request_key, b1Id: id, reason, env }))];
  } });
}

/**
 * wirePauseResume —— 连接暂停/恢复（binding_status paused/active 翻转的写方；非 /feishu-mode）。
 * pause=mode"pause"→unbind（只动 current B3）；resume=mode"resume"→restore。历史 B4 由账本 self 拒。
 * ext=该次终端命令的**持久控制 claim key / 命令审计 id**（禁止临时随机）；entity=目标 id。
 */
/**
 * wirePauseResume —— 连接暂停/恢复 = W4 对账兜底行。
 * #R37 返修（P1-2）：W4 行裁定 = **只取 m1a-order outer 锁、零 shadow 事务**。
 *  lock-only 签名 {endpointId, env, legacy}：不要 controlClaimKey / ledger id（那是事务参数）；
 *  没有事务就没有 request_key。取锁 → legacy → 交锁，完。对账兜底=无双写，但不是无锁
 *  （绕过 outer 就穿了 cutover 快照窗口）。
 */
export function wirePauseResume({ endpointId, env = process.env, legacy }) {
  return runWired({ endpointId, env, legacy, lockOnly: true });
}

/**
 * wireEnabledFlip —— `enabled` 翻转（§4 行）→ 语义与 pause/resume 同构（unbind↔disabled、
 * restore↔enabled）——同样 W4 对账兜底行：只取 outer 锁、零 shadow。
 */
export function wireEnabledFlip({ endpointId, env = process.env, legacy }) {
  return wirePauseResume({ endpointId, env, legacy });
}

/**
 * wireRetarget —— retarget（owner 终端）→ 账本 retarget（per-record/per-lineage，CAS 锁内精确）。
 * ext=同上持久控制 claim key；entity=目标 id；expectedOldTarget=new?——新旧 target 由调用方给（CAS 由账本裁决）。
 */
export function wireRetarget({ endpointId, env = process.env, legacy, controlClaimKey, id, expectedOldTarget, newTarget, authorizedBy, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(controlClaimKey) || !en(id)) return [{ op: "retarget", ok: false, reason: "bad_external_id", why: "controlClaimKey/id 必填 1..256 字符串" }];
    const k = rk("retarget", controlClaimKey, id);
    if (!k.ok) return [{ op: "retarget", ...k }];
    return [capture("retarget", retarget({ endpointId, requestKey: k.request_key, id, expectedOldTarget, newTarget, authorizedBy, now, env }))];
  } });
}

/**
 * wireBind —— 初始绑定的双写（Frank 拍板，P1-2）。
 * 交易序列（outer 锁内）：① re-read receipt+ledger ② 重核 exact target ③ legacy 用既有 idempotency-key
 *   建根话题 + B1 登记 ④ shadow create_b1 ⑤ status ⑥ 释放 outer。
 * legacy 必须返回 { root_message_id }（受验根话题 om），供 create_b1 的 rootOm；lineageId 由调用方给
 *   （claude basename(root)+"@project-files" / codex logicalTaskKey+"@codex-registry"，均来自既有算法，非自铸）。
 * request_key：ext="bind:"+externalRequestId；entity=generation_lineage_id（= lineageId）。
 * target_incomplete（enabled 端点无受验会话）由调用方**进 wireBind 前**整笔拒，本函数不消费不完整 target。
 */
export function wireBind({ endpointId, env = process.env, legacy, externalRequestId, lineageId, chatId, bindingTarget, now = Date.now() }) {
  return runWired({ endpointId, env, legacy, submit: (legacyRes) => {
    if (!en(externalRequestId) || !en(lineageId)) {
      return [{ op: "create_b1", ok: false, reason: "bad_external_id", why: "externalRequestId/lineageId 必填 1..256 字符串" }];
    }
    const om = (legacyRes && typeof legacyRes === "object" && legacyRes.root_message_id) ? legacyRes.root_message_id : null;
    if (!en(om)) return [{ op: "create_b1", ok: false, reason: "bad_external_id", why: "legacy 未返回受验 root_message_id" }];
    const k = rk("create_b1", "bind:" + externalRequestId, lineageId);
    if (!k.ok) return [{ op: "create_b1", ...k }];
    // R57a 返修二 P1-2：create_b1 不传数值 now（TTL 走锁内 clock()）
    return [capture("create_b1", createB1({ endpointId, requestKey: k.request_key, chatId, rootOm: om, lineageId, bindingTarget, env }))];
  } });
}

/* ── R57d 返修一 P1-1：owner_select 执行器的三个具名 wrapper（owner-select-route.md §12 ①）──
 * 按账本 authority_mode 封闭分派：authoritative → ledger-only（无 legacy、无 outer 锁——没有
 * legacy 提交就没有排序对象，账本事务自带文件锁）；shadow → runWired 复合双写（m1a-order.lock →
 * legacy 提交回调 → 账本 op）；其它值 → 拒 fail-closed。owner_select writer on ≠ 账本 authoritative。
 * 执行器没有第二个入口：outer 锁只由 runWired 取，本组 wrapper 是 select 执行的唯一写面。
 * anchor 没有 legacy mapping 权威事实可更新 → legacy 显式 no-op（outer 排序保留、不伪造 mapping 写）；
 * activate / rebind 的 legacy 回调更新 mapping —— 由调用方注入，shadow 期缺席 → 拒（不做无 legacy
 * 的半笔双写）。request_key 按 §5.1 通式从持久外部 id（事件 message id）+ 目标 id 逐 op 派生。 */

/** 分派前提：账本 authority_mode 三值读取（absent → no_candidate；corrupt → ledger_corrupt；其余 → ledger_unreadable）。 */
function selectAuthorityMode({ endpointId, env }) {
  const L = loadByEndpoint(endpointId, { env });
  if (!L.ok) {
    const reason = L.granular === "absent" ? "no_candidate" : L.granular === "corrupt" ? "ledger_corrupt" : "ledger_unreadable";
    return { ok: false, reason, why: L.why ?? null };
  }
  const mode = L.doc?.authority_mode;
  if (mode !== "shadow" && mode !== "authoritative") return { ok: false, reason: "ledger_unreadable", why: "authority_mode=" + String(mode) + " 越界（fail-closed）" };
  return { ok: true, mode };
}

/** authoritative 支的 ledger-only 结果：单笔 capture 原样投影（legacy 恒 null、无 outer 锁）。 */
function selectLedgerOnly(step) {
  return step.ok === true
    ? { ok: true, ledgerOnly: true, legacy: null, shadow: [step], release: null }
    : { ok: false, commit: "not_committed", ledgerOnly: true, reason: step.reason ?? "select_op_failed", why: step.why ?? null, legacy: null, shadow: [step], release: null };
}

/** shadow 支的前置拒（activate / rebind 必须带 legacy 提交回调；缺席 → 不做无 legacy 的半笔双写）。 */
const selectLegacyMissing = () => ({ ok: false, commit: "not_committed", reason: "select_legacy_required", why: "shadow 期该动作必须带 legacy 提交回调（更新 mapping）；缺席 → 拒", legacy: null, shadow: null, release: null });

/** R57d 返修一 B 段 P1-2：受验 owner capability 的封闭校验（写层的内层闸）。
 * 只认 kind=owner_select_control_v1、绑定本次选择上下文的 capability —— 不认通用 full、不收裸 sender；
 * 任一字段与本次执行不符 → select_capability_invalid。 */
function verifySelectCapability(capability, want) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability) || capability.kind !== "owner_select_control_v1") {
    return { ok: false, reason: "select_capability_required", why: "缺绑定本次选择上下文的受验 owner capability（不认通用 full、不收裸 sender）" };
  }
  const mismatch = [];
  // R57d 返修三 P1-2：写层校验含 endpoint / chat / session / message / sender / handle / kind 全部字段；
  //   want 中 undefined 的字段（该 wrapper 不掌握）不伪核。
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined) continue;
    if ((capability[k] ?? null) !== (v ?? null)) mismatch.push(k);
  }
  if (mismatch.length > 0) return { ok: false, reason: "select_capability_invalid", why: "capability 与本次选择上下文不一致（" + mismatch.join(",") + "）" };
  return { ok: true };
}

const selectCapFail = (v) => ({ ok: false, commit: "not_committed", reason: v.reason, why: v.why, legacy: null, shadow: null, release: null });

/** wireSelectActivate —— owner_select activate（B1+A1 归并）的双写分派。
 * A1 复核在 preflight（outer 锁内、legacy 提交之前，R57d 返修二 P1-6）：缺 → no_a1 整笔拒，
 * 不再出现「legacy 已提交、shadow no_a1」的半笔。 */
export function wireSelectActivate({ endpointId, env = process.env, legacy = null, capability, requestedHandle, messageId, _inject = undefined, b1Id, chatId, eventSessionId, authorizedBy, selectedRootOm, selectionHandle, selectionBasis, clock = () => Date.now() }) {
  const vcap = verifySelectCapability(capability, { endpoint: endpointId, chat: chatId, session: eventSessionId, message: messageId, sender: authorizedBy, handle: requestedHandle, handleKind: requestedHandle === null ? null : "osh" });
  if (!vcap.ok) return selectCapFail(vcap);
  const mode = selectAuthorityMode({ endpointId, env });
  if (!mode.ok) return { ok: false, commit: "not_committed", reason: mode.reason, why: mode.why, legacy: null, shadow: null, release: null };
  // preflight 在 outer 锁内、legacy 之前跑（runWired 的 preflight 槽位）：复核事件会话/chat 上仍存在可归并 A1（§12 ⑥）。
  const preflight = () => {
    const l = loadByEndpoint(endpointId, { env });
    if (!l.ok) return { ok: false, reason: "ledger_unreadable", why: l.why ?? null };
    const a1 = Object.values(l.doc.records).find((x) => x?.kind === "live" && familyOf(x.facts) === "A1" && x.chat_id === chatId && x.aliases.session_id === eventSessionId);
    if (!a1) return { ok: false, reason: "no_a1", why: "preflight 复核：事件会话/chat 上无可归并 A1（§12 ⑥）" };
    return { ok: true, a1Id: a1.topic_agent_id };
  };
  const submit = (_legacyRes, pf) => {
    const k = rk("activate", messageId, b1Id);
    if (!k.ok) return [{ op: "activate", ...k }];
    return [capture("activate", activate({ endpointId, requestKey: k.request_key, b1Id, a1Id: pf.a1Id, authorizedBy, selectedSessionId: eventSessionId, selectedRootOm, selectionHandle, selectionMessageId: messageId, selectionBasis, clock, env, _inject }))];
  };
  if (mode.mode === "authoritative") {
    const pf = preflight();
    if (!pf.ok) return { ok: false, commit: "not_committed", reason: pf.reason, why: pf.why, legacy: null, shadow: [{ op: "activate", ok: false, reason: pf.reason, why: pf.why }], release: null };
    return selectLedgerOnly(submit(null, pf)[0]);
  }
  if (typeof legacy !== "function") return selectLegacyMissing();
  return runWired({ endpointId, env, legacy, preflight, submit });
}

/** wireSelectAnchor —— owner_select anchor（A2 → A3 补链路证明）的双写分派。
 * legacy 恒为显式 no-op：anchor 没有 legacy mapping 权威事实可更新，不伪造 mapping 写；outer 排序照走。 */
export function wireSelectAnchor({ endpointId, env = process.env, capability, requestedHandle, chatId, messageId, _inject = undefined, id, authorizedBy, selectedSessionId, selectedRootOm, selectionHandle, expectedExpiresAt, expectedAnchorCandidate, selectionBasis, clock = () => Date.now() }) {
  const vcap = verifySelectCapability(capability, { endpoint: endpointId, chat: chatId, session: selectedSessionId, message: messageId, sender: authorizedBy, handle: requestedHandle, handleKind: requestedHandle === null ? null : "osh" });
  if (!vcap.ok) return selectCapFail(vcap);
  const mode = selectAuthorityMode({ endpointId, env });
  if (!mode.ok) return { ok: false, commit: "not_committed", reason: mode.reason, why: mode.why, legacy: null, shadow: null, release: null };
  const submit = () => {
    const k = rk("anchor", messageId, id);
    if (!k.ok) return [{ op: "anchor", ...k }];
    return [capture("anchor", anchor({ endpointId, requestKey: k.request_key, id, authorizedBy, selectedSessionId, selectedRootOm, selectionHandle, expectedExpiresAt, expectedAnchorCandidate, selectionMessageId: messageId, selectionBasis, clock, env, _inject }))];
  };
  if (mode.mode === "authoritative") return selectLedgerOnly(submit()[0]);
  return runWired({ endpointId, env, legacy: () => ({ ok: true, noop: true, why: "anchor 无 legacy mapping 权威事实（§12 ①：显式 no-op，不伪造 mapping 写）" }), submit });
}

/** wireSelectRebind —— owner_select rebind_session_alias（B3 换绑事件会话）的双写分派。 */
export function wireSelectRebind({ endpointId, env = process.env, legacy = null, capability, requestedHandle, chatId, messageId, _inject = undefined, id, expectedOldSessionId, expectedRootOm, newSessionId, authorizedBy, rebindHandle, expectedExpiresAt, clock = () => Date.now() }) {
  const vcap = verifySelectCapability(capability, { endpoint: endpointId, chat: chatId, session: newSessionId, message: messageId, sender: authorizedBy, handle: requestedHandle, handleKind: requestedHandle === null ? null : "orh" });
  if (!vcap.ok) return selectCapFail(vcap);
  const mode = selectAuthorityMode({ endpointId, env });
  if (!mode.ok) return { ok: false, commit: "not_committed", reason: mode.reason, why: mode.why, legacy: null, shadow: null, release: null };
  const submit = () => {
    const k = rk("rebind_session_alias", messageId, id);
    if (!k.ok) return [{ op: "rebind_session_alias", ...k }];
    return [capture("rebind_session_alias", rebindSessionAlias({ endpointId, requestKey: k.request_key, id, expectedOldSessionId, expectedRootOm, newSessionId, authorizedBy, rebindHandle, expectedExpiresAt, selectionMessageId: messageId, clock, env, _inject }))];
  };
  if (mode.mode === "authoritative") return selectLedgerOnly(submit()[0]);
  if (typeof legacy !== "function") return selectLegacyMissing();
  return runWired({ endpointId, env, legacy, submit });
}
