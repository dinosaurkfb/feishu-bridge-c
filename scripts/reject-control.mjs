/**
 * 近似命中收边的**拒绝事务**（goal 第 3 层；两条链共用）—— 与控制命令事务同一套形状：
 *
 *   · 拒绝的意图先以封闭投影进 claim（claim.rejected_control = { intent, word, problem, digest }，digest 是折叠后正文的 sha256）；
 *   · 终态 `<key>.rejected.json` 是封闭记录，与 claim 的投影逐字交叉核对；
 *   · 记账在 `<key>.control.lock` 内做，锁内状态对所有调用者都是权威的：
 *       记录在且一致 → replayed（按记录重出回执，不再写）；记录损坏 / 与意图不一致 → 受控拒绝并指路维护入口；
 *       记录缺席 → 写（首次），或补齐（重放 / 维护入口）；
 *   · 运输层重放同一条消息：claim 撞 duplicate，但意图能从 claim 里恢复，于是"claim 已取得、终态未写"与
 *     "终态已写、回执未写"两个窗口都能被同一条消息的重放补上 —— 而不是只得到一句"幂等命中"。
 *
 * 盘点（outbound.inventoryRuns）用 inspectRejectedClaim 把这类 claim 分成
 *   rejected（闭合）/ rejected_in_flight（claim 有投影、终态缺席）/ rejected_unreadable（终态损坏）/
 *   rejected_intent_mismatch（终态与投影不一致）/ not_rejected_control / claim_*。
 */
import fs from "node:fs";
import path from "node:path";
import { CLAIM_KEY_SHAPE, readClaimState, recordClaimState } from "./claim.mjs";
import { withControlLock } from "./control-command.mjs";
import { REJECTED_CONTROL_INTENTS, rejectedControlProblem, sameRejectedControl } from "./control-intent.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";

const REJECTED_KEYS = "claim_key,digest,intent,problem,recorded_at,schema_version,state,word";

/** `<key>.rejected.json` 的封闭形状：键集恰为 REJECTED_KEYS；坏了要进账本 problems，不能按文件名当健康。 */
export function rejectedRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (Object.keys(doc).sort().join(",") !== REJECTED_KEYS) return "字段集不对";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.state !== "rejected") return "state 不是 rejected";
  if (doc.claim_key !== key) return "claim_key 跟文件名对不上";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  return rejectedControlProblem({ intent: doc.intent, word: doc.word, problem: doc.problem, digest: doc.digest });
}

const projectionOf = (record) => ({ intent: record.intent, word: record.word, problem: record.problem, digest: record.digest });

/** 读 rejected 记录：absent / valid { record } / unreadable { why }。不跟符号链接、不当目录是文件。 */
export function readRejectedRecord({ claimsDir, key }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 不是 claim key 的形状" };
  const file = path.join(claimsDir, key + ".rejected.json");
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", why: err.code === "ELOOP" ? "不是普通文件" : String(err.code ?? err.message) };
    }
    if (!fs.fstatSync(fd).isFile()) return { status: "unreadable", why: "不是普通文件" };
    let doc;
    try { doc = JSON.parse(fs.readFileSync(fd, "utf-8")); }
    catch (err) { return { status: "unreadable", why: String(err.code ?? "不是 JSON") }; }
    const problem = rejectedRecordProblem(doc, key);
    if (problem !== null) return { status: "unreadable", why: problem };
    return { status: "valid", record: doc };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

/**
 * **锁内核心 —— 唯一一份，不导出**（它自己不取锁，公开出去就是一个能绕开锁的写原语）：生产路径（runRejectTransaction）与维护入口（resumeRejectedClaim）都走它。
 * 锁内先用同一份 expect 重读 claim：不 valid / 没有拒绝投影 → 受控拒绝；调用方带了投影的（生产路径）还要与锁内投影逐字一致，
 * 否则 claim_intent_mismatch —— **写终态永远用锁内刚读出的投影**，锁外看到的任何快照都不作数（评审探针：锁外 A、锁内已换成 B）。
 * quarantine=true（维护入口）时损坏的记录先隔离再重写；生产路径不隔离，只受控拒绝并指路。
 */
function rejectTransactionCore({ claimsDir, key, expect = {}, projection = null, replay = false, quarantine = false }) {
  const quarantined = [];
  const claim = readClaimState({ claimsDir, key, expect });
  if (claim.status !== "valid") return { ok: false, reason: "claim_" + claim.status, why: claim.why ?? null, quarantined };
  const inLock = claim.claim.rejected_control;
  if (inLock === undefined) return { ok: false, reason: "not_rejected_control", why: "锁内读到的 claim 没有拒绝投影", quarantined };
  if (projection !== null && !sameRejectedControl(projection, inLock)) {
    return { ok: false, reason: "claim_intent_mismatch", why: "锁内 claim 的投影（" + inLock.intent + " · " + inLock.word + "）与这次的（" + projection.intent + " · " + projection.word + "）不一致", quarantined };
  }
  const rec = readRejectedRecord({ claimsDir, key });
  if (rec.status === "unreadable") {
    if (!quarantine) return { ok: false, reason: "rejected_unreadable", why: rec.why, quarantined };
    const name = key + ".rejected.quarantined." + process.pid + "." + Date.now();
    try { fs.renameSync(path.join(claimsDir, key + ".rejected.json"), path.join(claimsDir, name)); }
    catch (err) { return { ok: false, reason: "rejected_unquarantined", why: String(err.code ?? err.message), quarantined }; }
    quarantined.push(name);
  } else if (rec.status === "valid") {
    if (!sameRejectedControl(inLock, projectionOf(rec.record))) {
      return { ok: false, reason: "rejected_intent_mismatch", why: "记录的意图（" + rec.record.intent + " · " + rec.record.word + "）与 claim 的（" + inLock.intent + " · " + inLock.word + "）不一致", quarantined };
    }
    return { ok: true, replayed: true, resumed: false, already: true, projection: inLock, record: rec.record, quarantined };
  }
  try { recordClaimState({ claimsDir, key, state: "rejected", detail: { ...inLock } }); }
  catch (err) { return { ok: false, reason: "ledger_unwritten", why: String(err?.code ?? err?.message ?? err), quarantined }; }
  return { ok: true, replayed: false, resumed: replay, already: false, projection: inLock, quarantined };
}

/**
 * 生产路径的拒绝事务：调用方带着这次解析出的投影进来，锁内与 claim 的投影核对后按记录决定写不写。
 * @returns {{ ok: true, replayed: boolean, resumed: boolean, record?: object } | { ok: false, reason: string, why: string }}
 *   reason ∈ rejected_intent_invalid | control_busy | control_lock_unavailable | claim_key_invalid | claim_absent | claim_unreadable |
 *            not_rejected_control | claim_intent_mismatch | rejected_unreadable | rejected_intent_mismatch | ledger_unwritten
 */
export function runRejectTransaction({ claimsDir, key, projection, replay = false, expect = {} }) {
  const problem = rejectedControlProblem(projection);
  if (projection === undefined || projection === null || problem !== null) return { ok: false, reason: "rejected_intent_invalid", why: problem ?? "缺 rejected_control" };
  return withControlLock({ claimsDir, key }, () => rejectTransactionCore({ claimsDir, key, expect, projection, replay, quarantine: false }));
}

/** 一张 claim 的拒绝事务处在什么状态（锁外观察，只用来展示；动手时核心在锁内重判）。 */
export function inspectRejectedClaim({ claimsDir, key, expect = {} }) {
  const claim = readClaimState({ claimsDir, key, expect });
  if (claim.status !== "valid") return { state: "claim_" + claim.status, why: claim.why ?? null };
  const projection = claim.claim.rejected_control;
  if (projection === undefined) return { state: "not_rejected_control" };
  const rec = readRejectedRecord({ claimsDir, key });
  if (rec.status === "unreadable") return { state: "rejected_unreadable", projection, why: rec.why };
  if (rec.status === "valid") {
    return sameRejectedControl(projection, projectionOf(rec.record))
      ? { state: "rejected", projection, record: rec.record }
      : { state: "rejected_intent_mismatch", projection, why: "终态的意图（" + rec.record.intent + " · " + rec.record.word + "）与 claim 的（" + projection.intent + " · " + projection.word + "）不一致" };
  }
  return { state: "rejected_in_flight", projection };
}

/** 维护入口允许续做的状态 —— 唯一一份，两条链的 CLI 都引用它。损坏的记录先隔离再按锁内 claim 的投影重写。 */
export const RESUMABLE_REJECT_STATES = Object.freeze(["rejected_in_flight", "rejected_unreadable"]);

/**
 * 维护入口的恢复：**整段在锁内**，不带任何锁外快照 —— 状态判定、隔离、写终态都以锁内刚读出的 claim 为准。
 * 已闭合 → already；记录与投影不一致 → 不隔离、不写（人看）。
 */
export function resumeRejectedClaim({ claimsDir, key, expect = {} }) {
  return withControlLock({ claimsDir, key }, () => rejectTransactionCore({ claimsDir, key, expect, projection: null, replay: true, quarantine: true }));
}

/** 维护入口的人读文案（两条链共用）。 */
export function describeRejectRepair({ seen, result, apply }) {
  if (result) {
    const held = result.quarantined?.length ? "；损坏的 rejected 记录已隔离为 " + result.quarantined.join("、") + "，人工查看后删除" : "";
    const lock = result.lockUncleared ? "；事务锁没有交还（" + result.lockUncleared + "），之后同一笔会报 control_busy，请人工确认后删除锁目录" : "";
    if (!result.ok) return "没有恢复（" + result.reason + (result.why ? "：" + result.why : "") + "）" + held + lock;
    return (result.already ? "这笔已闭合，无需恢复" : "已补齐拒绝终态（" + result.projection.intent + " · " + result.projection.word + "）") + held + lock;
  }
  const head = {
    rejected: "已闭合（拒绝：" + (seen.projection?.intent ?? "?") + " · " + (seen.projection?.word ?? "?") + "），无需恢复",
    rejected_in_flight: "拒绝已认领但终态未记下（" + (seen.projection?.intent ?? "?") + " · " + (seen.projection?.word ?? "?") + "）—— 同一条消息的运输层重放会补齐，或在这里续做",
    rejected_unreadable: "拒绝终态记录损坏（" + (seen.projection?.intent ?? "?") + " · " + (seen.projection?.word ?? "?") + "）：" + (seen.why ?? ""),
    rejected_intent_mismatch: "拒绝终态与 claim 的意图不一致：" + (seen.why ?? "") + " —— 请人工查看",
  }[seen.state] ?? ("说不清：" + seen.state + (seen.why ? "：" + seen.why : ""));
  return (apply ? "" : "[预览] ") + head + (RESUMABLE_REJECT_STATES.includes(seen.state) && !apply ? "\n加 --apply 续做。" : "");
}

export function rejectRepairExitCode({ seen, result, apply }) {
  if (result) return result.ok && !result.lockUncleared ? 0 : 1;
  if (!apply) return 0;
  return seen.state === "rejected" ? 0 : 1;
}

export { REJECTED_CONTROL_INTENTS };
