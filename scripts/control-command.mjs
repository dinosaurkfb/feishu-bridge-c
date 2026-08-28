/**
 * 飞书正文里的**控制命令**（goal 第 3 层，2026-08-28）：路由侧直接执行，不经过模型。
 *
 * 只认封闭的精确形状（正文恰为，多一个字都不算 —— 与 CLAUDE.md 里的授权纪律同一份）：
 *   Claude：`/feishu-mode dialogue`、`/feishu-mode mapping`
 *   Codex ：`$feishu-mode dialogue`、`$feishu-mode mapping`
 * 身份不在这里验：能走到这里的正文已经过了入站的三道闸（登记发送者、真实 @、新鲜度）并拿到 claim。
 * 无参数的 `/feishu-mode`（只读查看）不在飞书侧开放：查看走状态页。
 */

import fs from "node:fs";
import path from "node:path";
import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { CLAIM_KEY_SHAPE, readClaimState, recordClaimState } from "./claim.mjs";
import { controlIntentProblem, sameControlIntent } from "./control-intent.mjs";

export { CONTROL_MODES, controlIntentProblem, sameControlIntent } from "./control-intent.mjs";

const SHAPES = {
  claude: /^\/feishu-mode (dialogue|mapping)$/u,
  codex: /^\$feishu-mode (dialogue|mapping)$/u,
};

/** @returns {{kind:"mode", mode:string}|null} */
export function parseControlCommand(instruction, { chain } = {}) {
  const re = SHAPES[chain];
  if (!re || typeof instruction !== "string") return null;
  const m = re.exec(instruction);
  if (!m) return null;
  return { kind: "mode", mode: m[1] === "dialogue" ? DIALOGUE_POLICY_ID : MAPPING_POLICY_ID };
}

const CONSUMED_KEYS = "changed,claim_key,control,mode,recorded_at,schema_version,state";

/** consumed 记录（<key>.consumed.json）的封闭形状：键集恰为 CONSUMED_KEYS；坏了要进账本 problems，不能按文件名当健康。 */
export function consumedRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (Object.keys(doc).sort().join(",") !== CONSUMED_KEYS) return "字段集不对";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.state !== "consumed") return "state 不是 consumed";
  if (doc.claim_key !== key) return "claim_key 跟文件名对不上";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  const intentProblem = controlIntentProblem({ control: doc.control, mode: doc.mode });
  if (intentProblem !== null) return intentProblem;
  if (typeof doc.changed !== "boolean") return "changed 不是布尔";
  return null;
}

/** 以 fd 绑定的方式读一份 JSON 记录：open(O_NOFOLLOW|O_NONBLOCK) → fstat 只收普通文件 → 同 fd 读。 */
function readRecordFile(file, { afterOpen = null } = {}) {
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", why: err.code === "ELOOP" ? "不是普通文件" : String(err.code ?? err.message) };
    }
    if (typeof afterOpen === "function") afterOpen(file);
    if (!fs.fstatSync(fd).isFile()) return { status: "unreadable", why: "不是普通文件" };
    try { return { status: "read", doc: JSON.parse(fs.readFileSync(fd, "utf-8")) }; }
    catch (err) { return { status: "unreadable", why: String(err.code ?? "不是 JSON") }; }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

/**
 * 读 consumed 记录：absent / valid / mismatch / unreadable。
 * 给了 expectedIntent 就逐字段核对：记录合法但意图对不上 → mismatch（不许把别的意图的结果当成这次的）。
 */
export function readConsumedRecord({ claimsDir, key, expectedIntent = undefined, afterOpen = null }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 形状不对" };
  const r = readRecordFile(path.join(claimsDir, key + ".consumed.json"), { afterOpen });
  if (r.status !== "read") return r;
  const problem = consumedRecordProblem(r.doc, key);
  if (problem) return { status: "unreadable", why: problem };
  if (expectedIntent !== undefined && !sameControlIntent(expectedIntent, { control: r.doc.control, mode: r.doc.mode })) {
    return { status: "mismatch", why: "consumed 的意图（" + r.doc.mode + "）与 claim 的意图（" + String(expectedIntent?.mode) + "）不一致", record: r.doc };
  }
  return { status: "valid", record: r.doc };
}

const CONTROL_FAILED_KEYS = "claim_key,control,error,reason,recorded_at,schema_version,state";
/** 控制命令的 failed 记录（<key>.failed.json，入站在切换失败时写）的封闭形状；它不是 run 终态。 */
export function controlFailedRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (Object.keys(doc).sort().join(",") !== CONTROL_FAILED_KEYS) return "字段集不对";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.state !== "failed") return "state 不是 failed";
  if (doc.claim_key !== key) return "claim_key 跟文件名对不上";
  if (doc.reason !== "control_failed") return "reason 不是 control_failed";
  if (doc.control !== "mode") return "control 不是 mode";
  if (typeof doc.error !== "string") return "error 不是字符串";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  return null;
}
export function readControlFailedRecord({ claimsDir, key }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 形状不对" };
  const r = readRecordFile(path.join(claimsDir, key + ".failed.json"));
  if (r.status !== "read") return r;
  const problem = controlFailedRecordProblem(r.doc, key);
  return problem ? { status: "unreadable", why: problem } : { status: "valid", record: r.doc };
}

/** 同一 key 的 consumed 临时制品（写到一半 / rename 失败留下的）：受控形状，报 consumed_in_flight；成功写出后清掉。 */
export const CONSUMED_TMP_RE = /^([0-9a-f]{64})\.consumed\.json\.tmp\.\d+\.\d+$/u;
/** 损坏的 failed 记录被隔离后的名字：受控形状，账本按 control_failed_quarantined 报，人工看完再删。 */
export const CONTROL_QUARANTINE_RE = /^([0-9a-f]{64})\.failed\.quarantined\.\d+\.\d+$/u;
/** 逐 key 的事务锁（目录，mkdir 原子）：运输层重放、首次执行、维护入口共用同一份所有权。留下没释放的由账本报 control_lock_held。 */
export const CONTROL_LOCK_RE = /^([0-9a-f]{64})\.control\.lock$/u;
const CONTROL_LOCK_SUFFIX = ".control.lock";

/**
 * 列同 key 的临时残骸与隔离制品 —— **三态**：listed（names）/ unlistable（why）。
 * 目录枚举失败不许折叠成"没有残骸"：记录本身走 fd 读得出来，不代表目录里没有别的东西。
 */
export function listControlSidecars({ claimsDir, key }) {
  let names;
  try { names = fs.readdirSync(claimsDir); }
  catch (err) { return { status: "unlistable", why: String(err.code ?? err.message) }; }
  const pick = (re) => names.filter((n) => { const m = re.exec(n); return m && m[1] === key; });
  return { status: "listed", residue: pick(CONSUMED_TMP_RE), quarantined: pick(CONTROL_QUARANTINE_RE) };
}
export function consumedResidue({ claimsDir, key }) {
  const l = listControlSidecars({ claimsDir, key });
  return l.status === "listed" ? { status: "listed", names: l.residue } : l;
}
export function quarantinedFailed({ claimsDir, key }) {
  const l = listControlSidecars({ claimsDir, key });
  return l.status === "listed" ? { status: "listed", names: l.quarantined } : l;
}
/** 清同 key 残骸：{ uncleared: 清不掉的名字, unknown: 枚举不了时的原因 }。两者都要带进受控结果，不许吞。 */
function cleanupConsumedResidue({ claimsDir, key }) {
  const l = consumedResidue({ claimsDir, key });
  if (l.status !== "listed") return { uncleared: [], unknown: l.why };
  const uncleared = [];
  for (const n of l.names) {
    try { fs.rmSync(path.join(claimsDir, n), { force: true }); } catch { /* 下面按是否仍在判断 */ }
    if (fs.existsSync(path.join(claimsDir, n))) uncleared.push(n);
  }
  return { uncleared, unknown: null };
}

function acquireControlLock({ claimsDir, key }) {
  const dir = path.join(claimsDir, key + CONTROL_LOCK_SUFFIX);
  try { fs.mkdirSync(dir, { recursive: false, mode: 0o700 }); }
  catch (err) {
    if (err.code === "EEXIST") {
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf-8")); } catch { /* 持有事实由目录承载 */ }
      return { ok: false, reason: "control_busy", why: "这一笔已有事务持有者" + (owner ? "（pid " + owner.pid + "，自 " + owner.at + "）" : "") +
        "；确认它已不在后删除 " + key + CONTROL_LOCK_SUFFIX + " 再试" };
    }
    return { ok: false, reason: "control_lock_unavailable", why: String(err.code ?? err.message) };
  }
  try { fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { /* 同上 */ }
  return { ok: true, release: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留下的由账本报 control_lock_held */ } } };
}
/** 在这一笔的事务锁内跑 fn；拿不到锁 → { ok:false, reason: control_busy | control_lock_unavailable }。 */
export function withControlLock({ claimsDir, key }, fn) {
  const lock = acquireControlLock({ claimsDir, key });
  if (!lock.ok) return { ok: false, reason: lock.reason, why: lock.why };
  try { return fn(); } finally { lock.release(); }
}

const SIDECAR_WORD = { valid: "完整", mismatch: "完整", unreadable: "损坏" };
const jointWhy = (failed, consumed) => "failed（" + SIDECAR_WORD[failed.status] + "）与 consumed（" + SIDECAR_WORD[consumed.status] + "）并存";

/**
 * **可恢复的控制事务**，整体在这一笔的事务锁内：意图已在 claim 里（三道闸之后、执行之前持久化）。
 *   · 首次：幂等执行 → 写受验 consumed → 清同 key 的临时残骸（清不掉 / 枚举不了 → residueUncleared / residueUnknown 带回，事务仍算成）。
 *     执行失败 → 在锁内写受验 failed（consumed 不在场时）→ control_failed。
 *   · 重放 / 维护恢复（replay）先在锁内把两份 sidecar 组成封闭联合：
 *       两份都在（不论好坏）→ control_conflict，不执行；
 *       consumed 完整且意图一致 → 按记录重出回执，不执行；意图不一致 → consumed_intent_mismatch；
 *       failed 受验 → control_failed_recorded：按记录重出失败回执，不执行（重发是新消息才会再试）；
 *       failed 损坏 → 先在锁内改名隔离（改不动 → failed_unquarantined，不执行）再续做；
 *       都没有 / 只有损坏的 consumed → 续做（再执行一次，幂等）并写 consumed。
 *   · 写 consumed 失败：动作已成、账本未闭合 —— 如实报 ledger_unwritten。**只有运输层对同一事件的重放，或维护入口
 *     repair-control-claim，才能补齐**；Frank 在飞书重发是新消息 = 新 claim，补不了旧账。不回滚模式（会覆盖期间的合法修改）。
 * execute(mode) 必须幂等，返回 { ok, changed, reason }。
 */
export function runControlTransaction({ claimsDir, key, intent, execute, replay = false }) {
  const problem = controlIntentProblem(intent);
  if (problem || intent === undefined) return { ok: false, reason: "control_intent_invalid", why: problem ?? "缺 control" };
  return withControlLock({ claimsDir, key }, () => runLockedTransaction({ claimsDir, key, intent, execute, replay }));
}
function runLockedTransaction({ claimsDir, key, intent, execute, replay }) {
  const quarantined = [];
  const consumed = readConsumedRecord({ claimsDir, key, expectedIntent: intent });
  const failed = readControlFailedRecord({ claimsDir, key });
  if (replay) {
    if (consumed.status !== "absent" && failed.status !== "absent") return { ok: false, reason: "control_conflict", why: jointWhy(failed, consumed) };
    if (consumed.status === "valid") return { ok: true, changed: consumed.record.changed, resumed: false, replayed: true, residueUncleared: [], residueUnknown: null, quarantined };
    if (consumed.status === "mismatch") return { ok: false, reason: "consumed_intent_mismatch", why: consumed.why };
    if (failed.status === "valid") return { ok: false, reason: "control_failed_recorded", why: failed.record.error, replayed: true };
    if (failed.status === "unreadable") {
      const name = key + ".failed.quarantined." + process.pid + "." + Date.now();
      try { fs.renameSync(path.join(claimsDir, key + ".failed.json"), path.join(claimsDir, name)); }
      catch (err) { return { ok: false, reason: "failed_unquarantined", why: String(err.code ?? err.message) }; }
      quarantined.push(name);
    }
    // consumed 缺席或损坏、failed 不在场：续做
  }
  const done = execute(intent.mode);
  if (!done.ok) {
    const why = done.reason ?? "?";
    if (consumed.status === "absent") {
      try { recordClaimState({ claimsDir, key, state: "failed", detail: { reason: "control_failed", control: intent.control, error: why } }); }
      catch (err) { return { ok: false, reason: "control_failed", why, ledger: "failed_unwritten：" + String(err?.code ?? err?.message ?? err), quarantined }; }
    }
    return { ok: false, reason: "control_failed", why, quarantined };
  }
  const changed = done.changed !== false;
  try {
    recordClaimState({ claimsDir, key, state: "consumed", detail: { control: intent.control, mode: intent.mode, changed } });
  } catch (err) {
    return { ok: false, reason: "ledger_unwritten", why: String(err?.code ?? err?.message ?? err), changed, resumed: replay, quarantined };
  }
  const cleaned = cleanupConsumedResidue({ claimsDir, key });
  return { ok: true, changed, resumed: replay, replayed: false, residueUncleared: cleaned.uncleared, residueUnknown: cleaned.unknown, quarantined };
}

/**
 * 维护入口共用：一张 claim 的控制事务处在什么状态（锁外的观察；真正动手时事务会在锁内重新判一遍）。
 * expect 与 readClaimState 同义（维护入口用它把 claim 绑到当前 binding/task）。
 * 两份 sidecar（consumed / failed）**先组成封闭联合再定状态**：
 *   · claim_*：claim 缺席 / 读不出 / 身份对不上；not_control：不是控制命令；
 *   · 两份都在（不论各自好坏）→ conflict：人看；
 *   · 只有 consumed：完整且一致 → consumed；意图不一致 → mismatch；损坏 → consumed_unreadable（带意图，可恢复）；
 *   · 只有 failed：受验 → failed（当时没切成，不恢复）；损坏 → failed_unreadable（可恢复，恢复前先隔离）；
 *   · 都没有 → in_flight（可恢复）。
 * residue / quarantined：同 key 的临时残骸与隔离制品；目录枚举不了时两者为 null 且 listingProblem 说明原因（不折叠成 0）。
 */
export function inspectControlClaim({ claimsDir, key, expect = {} }) {
  const claim = readClaimState({ claimsDir, key, expect });
  if (claim.status !== "valid") return { state: "claim_" + claim.status, why: claim.why ?? null };
  const intent = claim.claim.control;
  if (intent === undefined) return { state: "not_control" };
  const consumed = readConsumedRecord({ claimsDir, key });
  const failed = readControlFailedRecord({ claimsDir, key });
  const listed = listControlSidecars({ claimsDir, key });
  const extras = listed.status === "listed"
    ? { residue: listed.residue, quarantined: listed.quarantined, listingProblem: null }
    : { residue: null, quarantined: null, listingProblem: listed.why };
  if (consumed.status !== "absent" && failed.status !== "absent") return { state: "conflict", intent, why: jointWhy(failed, consumed), ...extras };
  if (consumed.status === "unreadable") return { state: "consumed_unreadable", intent, why: consumed.why, ...extras };
  if (consumed.status === "valid") {
    return sameControlIntent(intent, { control: consumed.record.control, mode: consumed.record.mode })
      ? { state: "consumed", intent, record: consumed.record, ...extras }
      : { state: "mismatch", intent, why: "consumed 的意图（" + consumed.record.mode + "）与 claim 的意图（" + intent.mode + "）不一致", ...extras };
  }
  if (failed.status === "valid") return { state: "failed", intent, record: failed.record, ...extras };
  if (failed.status === "unreadable") return { state: "failed_unreadable", intent, why: failed.why, ...extras };
  return { state: "in_flight", intent, ...extras };
}

/** 维护入口允许续做的状态 —— 唯一一份，两条链的 CLI 都引用它。 */
export const RESUMABLE_CONTROL_STATES = Object.freeze(["in_flight", "consumed_unreadable", "failed_unreadable"]);
/**
 * 维护入口的恢复动作：锁外先看一眼状态（拒掉明显不该动的），真正的判定与动作都交给锁内的事务：
 *   · consumed：不执行，锁内再清一次残骸（清不掉 / 枚举不了照样带回）；
 *   · 可续做态：走 runControlTransaction(replay)，隔离、执行、记账都在锁内；锁内若发现已被别的事务补上（如 failed 受验），按锁内结果返回。
 */
export function resumeControlClaim({ claimsDir, key, execute, expect = {} }) {
  const seen = inspectControlClaim({ claimsDir, key, expect });
  if (seen.state === "consumed") {
    const locked = withControlLock({ claimsDir, key }, () => cleanupConsumedResidue({ claimsDir, key }));
    if (locked.ok === false) return { ok: false, reason: locked.reason, why: locked.why };
    return { ok: true, already: true, changed: seen.record.changed, intent: seen.intent, residueUncleared: locked.uncleared, residueUnknown: locked.unknown, quarantined: seen.quarantined ?? [] };
  }
  if (!RESUMABLE_CONTROL_STATES.includes(seen.state)) return { ok: false, reason: seen.state, why: seen.why ?? null };
  const tx = runControlTransaction({ claimsDir, key, intent: seen.intent, execute, replay: true });
  return tx.ok
    ? { ok: true, already: false, changed: tx.changed, intent: seen.intent, residueUncleared: tx.residueUncleared ?? [], residueUnknown: tx.residueUnknown ?? null, quarantined: [...(seen.quarantined ?? []), ...(tx.quarantined ?? [])] }
    : { ok: false, reason: tx.reason, why: tx.why, quarantined: tx.quarantined ?? [] };
}

const MODE_LABEL = {
  [DIALOGUE_POLICY_ID]: "Dialogue（单主持者·串行；默认 12 轮 / 2 小时 / 12 资源单位）",
  [MAPPING_POLICY_ID]: "Mapping（一次输入对应一次运行）",
};

/** 回执正文：说清切到了什么、是不是本来就是、这条不是指令；重放 / 续做也说清。 */
export function controlAckText({ taskName, mode, changed, replayed = false, resumed = false }) {
  const head = replayed ? "已处理过 · " : resumed ? "已补齐 · " : changed ? "已切换 · " : "模式未变 · ";
  const body = replayed
    ? "这条控制命令之前已经执行过（" + (changed ? "当时完成了切换" : "当时模式未变") + "）；当时目标模式是 " + (MODE_LABEL[mode] ?? mode) + "，本次没有再次切换。"
    : resumed
      ? "上次执行后终态没记下，这次已补齐；交互模式是 " + (MODE_LABEL[mode] ?? mode) + "。"
      : (changed ? "交互模式现在是 " : "本来就是 ") + (MODE_LABEL[mode] ?? mode) + "。";
  return [head + taskName, body, "本条是控制命令，没有被当作指令投递。"].join("\n");
}
