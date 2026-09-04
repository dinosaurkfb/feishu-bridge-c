/**
 * B-3 每 endpoint 永久收据的聚合读取（M1 账本接入；design `docs/architecture/maintenance-gate.md` B-3）。
 *
 * 已 done 的 `ledger_init` / `ledger_cutover` operation journal 都**永久充当该 endpoint 的维护审计收据**，
 * 不删、不算 orphan —— 它们要在账本丢失后仍能证明"曾初始化 / 曾切权威"。本模块是 `topic-agent-ledger.mjs` 里
 * 最小投影 `endpointReceipt` 的**全量版**，独立可导出。
 *
 * 四态：
 *   · never_initialized：无 init 记录（可另有一份 cutover 是矛盾）—— 唯一允许新建 init 的状态。
 *   · ok：恰一份 init（可另有一至多份 cutover，只要 init 在 cutover 之前）。
 *   · duplicate_or_conflict：多份 init、多份 cutover、或 init 不在 cutover 之前 —— fail-closed。
 *   · unreadable：目录里任一 journal 读不出 —— fail-closed（R16 F3 语义保留）。
 *
 * 兼容：旧 1.1 journal（无 operation_kind）按既有种（gate/install）读，不当 unreadable，**不参与**收据索引。
 *
 * P1-2（第 4 轮）：`endpointReceipt` 与 `aggregateEndpointReceipts` 收据判据曾在聚合方向漂移 ——
 * `endpointReceipt` 有"cutover>0 但 init≠1"判据，`aggregateEndpointReceipts` 没有（cutover-only → 误判
 * never_initialized ok:true 放行，doctor ⑬ 跳过）；且"进行中 WAL + 既有终态同种并存"在 same-token 分支被
 * 提前放行成 ok_in_progress（fail-open）。这里抽出**单一判据核心** `judgeLedgerReceipt`，两个入口共用。
 */
import { JOURNAL_SCHEMA, LEGACY_JOURNAL_SCHEMA, listJournals, readJournal, TERMINAL_PHASES } from "./journal.mjs";

const LEDGER_KINDS = Object.freeze(["ledger_init", "ledger_cutover"]);
const KIND_IS_INIT = Object.freeze({ ledger_init: true, ledger_cutover: false });

/** 规范化 ISO 串按字典序即按时间序（journalProblem 已验证 started_at 是规范化 ISO）；reduce 取最小串。 */
function earliestIso(list) {
  return list.reduce((m, x) => (x.startedAt < m ? x.startedAt : m), list[0].startedAt);
}

/** 从 done ledger journal 提取 endpoint_id：唯一 ledger step 的 target。 */
function endpointOf(doc) {
  const ls = doc.steps.find((s) => s.kind === "ledger");
  if (!ls || typeof ls.target !== "string") return null;
  return ls.target;
}

/** 单一收据判据核心（endpointReceipt / aggregateEndpointReceipts 共用，P1-2 修复双方向漂移与 fail-open）。
 *  输入是**已按 endpoint 过滤**的四个集合：
 *   · init / cutover：终态（phase done）或"进行中但 ledger step 已 done（崩溃态）"的实例数组 {token, startedAt}。
 *   · inProgress：全部进行中 WAL 实例数组 {token, isInit}（未 committed 的会在里面、但不在 init/cutover 数组）。
 *   · initTokens / cutoverTokens：每个 kind 去重的**全量** token 集（终态 + 进行中）——用来判"同种冲突/有切没初始化"，
 *     不用计数（计数会漏掉"doing + 进行中同种并存"的跨集冲突，如 done init A + prepared init B）。
 * 判据只紧不松：重复 init / 重复 cutover / 有切没初始化 / 顺序矛盾 / 进行中多余 / 进行中与终态同种并存 → 全 fail-closed。
 */
function judgeLedgerReceipt({ init = [], cutover = [], inProgress = [], initTokens = new Set(), cutoverTokens = new Set(), token = null } = {}) {
  const initDone = init.length === 1, cutoverDone = cutover.length === 1;
  const initCount = init.length, cutoverCount = cutover.length;
  const base = { initDone, cutoverDone, initCount, cutoverCount };
  // 进行中与终态"同种"并存的冲突 + 有切没初始化，都先把 initTokens/cutoverTokens 的集合大小算出来。
  const closedConflict = initTokens.size > 1 || cutoverTokens.size > 1;
  const cutNoInit = cutoverTokens.size > 0 && initTokens.size !== 1;
  const ordering = !closedConflict && !cutNoInit && init.length === 1 && cutover.length >= 1
    ? init[0].startedAt > earliestIso(cutover)
    : false; // init 不在 cutover 之前 → 矛盾（切了又初始化 / 先切后初始化）
  // 全部进行中 WAL 都要看到——多余一律 fail-closed，不挑第一份放行。
  if (inProgress.length > 1) return { ok: false, state: "in_progress_conflict", why: "同一 endpoint 有 " + inProgress.length + " 份进行中的账本 WAL（token " + inProgress.map((i) => i.token).join(", ") + "）—— fail-closed", ...base, inProgress: true, inProgressTokens: inProgress.map((i) => i.token), inProgressKinds: inProgress.map((i) => i.isInit ? "init" : "cutover") };
  if (inProgress.length === 1) {
    const ip = inProgress[0];
    // P1-2：same-token 放行之前先判"进行中与终态同种并存"（done init A + prepared init B）——不许被 ok_in_progress 抢先放行。
    if (closedConflict || cutNoInit) return { ok: false, state: "duplicate_or_conflict", why: "收据矛盾：进行中的 " + (ip.isInit ? "初始化" : "切权威") + " 与既有终态并存（init " + initTokens.size + " / cutover " + cutoverTokens.size + "）—— fail-closed", ...base };
    if (typeof token === "string" && ip.token === token) return { ok: true, state: "ok_in_progress", why: "同一 operation 正在前（same-token 恢复放行）", ...base, inProgress: true, inProgressToken: token, inProgressKind: ip.isInit ? "init" : "cutover" };
    return { ok: false, state: "in_progress_foreign", why: "存在未完成的账本 " + (ip.isInit ? "初始化" : "切权威") + " WAL（token " + ip.token + "，他 token 一律 fail-closed）", ...base, inProgress: true, inProgressToken: ip.token };
  }
  const conflict = closedConflict || cutNoInit;
  if (conflict || ordering) return { ok: false, state: "duplicate_or_conflict", why: "收据矛盾：init " + initTokens.size + " 份 / cutover " + cutoverTokens.size + " 份" + (ordering ? "（init 不在 cutover 之前）" : "") + (cutNoInit ? "（有切没初始化或重复初始化）" : ""), ...base };
  return { ok: true, state: initDone ? "ok" : "never_initialized", ...base };
}

/** 唯一目录收集器（P1-3 第 5 轮）：把目录里每份 journal 收集成按 endpoint 索引的事实。
 *  终态（phase done）+ 进行中 WAL（isInProgressWAL）**一起**收——聚合面不再先把 phase!=='done' 滤掉，
 *  因此 status / doctor ⑬ 看到的收据与写入口 endpointReceipt **同一份**，不会“写入口拒、诊断面报绿”。
 *  返回 { ok, unreadable:[{token,why}], map: endpointId -> {init,cutover,inProgress,initTokens,cutoverTokens}, why }；
 *  任一份 journal 读不出即 ok:false（fail-closed）；unreadable[i].why 与旧格式一致（含 state 与原因）。 */
function collectLedgerReceipts({ dir }) {
  const list = listJournals({ dir });
  if (!list.ok) return { ok: false, unreadable: [], map: new Map(), why: list.why ?? "维护目录读不出" };
  const map = new Map();
  const unreadable = [];
  for (const token of list.tokens) {
    const j = readJournal({ dir, token });
    if (j.state !== "valid") { unreadable.push({ token, why: "journal " + j.state + (j.why ? "：" + j.why : "") }); continue; }
    if (j.doc.schema_version !== JOURNAL_SCHEMA) continue; // 旧 1.1，按既有种读、不参与索引（评审 P2-1）
    if (!LEDGER_KINDS.includes(j.doc.operation_kind)) continue;
    const ep = endpointOf(j.doc);
    if (ep === null) continue;
    const isInit = KIND_IS_INIT[j.doc.operation_kind];
    if (!map.has(ep)) map.set(ep, { init: [], cutover: [], inProgress: [], initTokens: new Set(), cutoverTokens: new Set() });
    const e = map.get(ep);
    if (j.doc.phase === "done") {
      (isInit ? e.init : e.cutover).push({ token, startedAt: j.doc.started_at });
      (isInit ? e.initTokens : e.cutoverTokens).add(token);
    } else if (isInProgressWAL(j.doc)) {
      const ls = j.doc.steps.find((s) => s.kind === "ledger");
      const committed = ls !== undefined && ls.state === "done";
      (isInit ? e.initTokens : e.cutoverTokens).add(token); // 进行中的 token 也计入"同种冲突"的集合（防 done+prepared 同种并存）
      e.inProgress.push({ token, isInit });
      // P1-3：step 已 done 但 phase 未前进的进行中 WAL，账本事实已落盘——计入某方向的"已做"，不许当 never_initialized。
      if (committed) (isInit ? e.init : e.cutover).push({ token, startedAt: j.doc.started_at });
    }
  }
  return { ok: unreadable.length === 0, unreadable, map, why: unreadable.length > 0 ? ("目录里 " + unreadable.length + " 个 journal 读不出") : null };
}

/** 单 endpoint 收据判据（B-3，init / cutover 前置检查用）。目录里任一 journal 读不出 → fail-closed。
 *  P1-6：正在前的 ledger init/cutover WAL（phase=ledger_initializing/ledger_cutting_over 且已有 prepared ledger step）
 *  不算 never_initialized——同 token 恢复由 `token` 认为 ok_in_progress，他人 token 一律 in_progress_foreign fail-closed。
 *  P1-3（第 5 轮）：与聚合共用 collectLedgerReceipts 收集器，判据事实同一份。 */
export function endpointReceipt(dir, endpointId, { token = null } = {}) {
  const c = collectLedgerReceipts({ dir });
  if (!c.ok) return { ok: false, state: "unreadable", why: c.unreadable?.[0]?.why ?? c.why ?? "维护目录读不出", initDone: false, cutoverDone: false };
  const e = c.map.get(endpointId) ?? { init: [], cutover: [], inProgress: [], initTokens: new Set(), cutoverTokens: new Set() };
  return judgeLedgerReceipt({ init: e.init, cutover: e.cutover, inProgress: e.inProgress, initTokens: e.initTokens, cutoverTokens: e.cutoverTokens, token });
}

/** P1-6：正在前的账本 WAL——phase 进了前向段且 ledger step 已 prepared；P1-3：step 已 done 但 phase 未前进（崩溃态）也算，
 *  且 reopen 段（ledger_reopening / reopening_incomplete）带着 done ledger step（已切权威后只向前清 active）也算进行中。 */
function isInProgressWAL(doc) {
  const ls = doc.steps.find((s) => s.kind === "ledger");
  if (doc.phase === "ledger_initializing" || doc.phase === "ledger_cutting_over") return ls !== undefined && (ls.state === "prepared" || ls.state === "done");
  if (doc.phase === "ledger_reopening" || doc.phase === "reopening_incomplete") return ls !== undefined && ls.state === "done";
  return false;
}

/**
 * 全目录收据聚合（--status / doctor 用）：按 endpoint_id 建唯一索引；目录里任一 journal 读不出 → 全局 fail-closed。
 * 返回 { ok, unreadable:[{token,why}], endpoints:[{endpointId,state,initDone,cutoverDone,initCount,cutoverCount}], why }。
 */
export function aggregateEndpointReceipts({ dir } = {}) {
  const c = collectLedgerReceipts({ dir });
  const endpoints = [];
  let conflictWhy = null;
  // 聚合无 recovery token → 任一进行中 WAL 显式非绿（judge 走 in_progress_* → !ok），不许 fail-open。
  for (const [endpointId, e] of c.map) {
    const verdict = judgeLedgerReceipt({
      init: e.init, cutover: e.cutover, inProgress: e.inProgress,
      initTokens: e.initTokens, cutoverTokens: e.cutoverTokens,
    });
    const state = !verdict.ok ? "conflict" : verdict.state === "never_initialized" ? "never_initialized" : "ok";
    if (state === "conflict") conflictWhy ??= endpointId;
    endpoints.push({ endpointId, state, initDone: verdict.initDone, cutoverDone: verdict.cutoverDone, initCount: verdict.initCount, cutoverCount: verdict.cutoverCount, initTokens: e.init.map((x) => x.token), cutoverTokens: e.cutover.map((x) => x.token) });
  }
  const badUnreadable = c.unreadable.length > 0;
  return { ok: !badUnreadable && conflictWhy === null, unreadable: c.unreadable, endpoints, why: conflictWhy !== null ? ("收据矛盾：" + conflictWhy) : (badUnreadable ? c.why ?? null : null) };
}

/**
 * 未完成 init WAL（M1a v6 §7 的 "prepared" 态）：operation_kind=ledger_init 且 phase 非终态
 * （终态 = done / rolled_back）的 journal，按 endpoint 归并。rolled_back 是回退清场的归档收据，
 * **不算** prepared —— 回退后账本缺席应走 never_initialized 分支，而不是报「恢复」。
 * 任一 journal 读不出 → fail-closed（ok:false）。返回 { ok:true, prepared:[{endpointId, token, phase}] }。
 */
export function preparedLedgerInits({ dir } = {}) {
  const list = listJournals({ dir });
  if (!list.ok) return { ok: false, why: list.why ?? "维护目录读不出" };
  const prepared = [];
  for (const token of list.tokens) {
    const j = readJournal({ dir, token });
    if (j.state !== "valid") return { ok: false, why: "journal " + token.slice(0, 8) + " 读不出（" + (j.why ?? j.state) + "）—— prepared 判定 fail-closed" };
    if (j.doc.schema_version !== JOURNAL_SCHEMA) continue; // 旧 1.1 非账本种
    if (j.doc.operation_kind !== "ledger_init") continue;
    if (TERMINAL_PHASES.includes(j.doc.phase)) continue;
    const ep = endpointOf(j.doc);
    if (ep !== null) prepared.push({ endpointId: ep, token, phase: j.doc.phase });
  }
  // 同 endpoint 多笔未收口 init WAL 本身就是矛盾态（评审 P2-4）：fail-closed，不静默取末条。
  const counts = new Map();
  for (const p of prepared) counts.set(p.endpointId, (counts.get(p.endpointId) ?? 0) + 1);
  for (const [ep, n] of counts) {
    if (n > 1) return { ok: false, why: "endpoint " + ep.slice(0, 8) + "… 有 " + n + " 笔未收口 init WAL（prepared_conflict）—— 人工按 B-2 裁决" };
  }
  return { ok: true, prepared };
}
