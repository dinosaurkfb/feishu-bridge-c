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

/**
 * 读 consumed 记录：absent / valid / mismatch / unreadable。
 * open(O_NOFOLLOW|O_NONBLOCK) → fstat(fd) 只收普通文件 → 同 fd 读（两步路径访问会被中途换文件，评审探针）。
 * 给了 expectedIntent 就逐字段核对：记录合法但意图对不上 → mismatch（不许把别的意图的结果当成这次的）。
 */
export function readConsumedRecord({ claimsDir, key, expectedIntent = undefined, afterOpen = null }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 形状不对" };
  const file = path.join(claimsDir, key + ".consumed.json");
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable", why: err.code === "ELOOP" ? "不是普通文件" : String(err.code ?? err.message) };
    }
    if (typeof afterOpen === "function") afterOpen(file);
    if (!fs.fstatSync(fd).isFile()) return { status: "unreadable", why: "不是普通文件" };
    let doc;
    try { doc = JSON.parse(fs.readFileSync(fd, "utf-8")); }
    catch (err) { return { status: "unreadable", why: String(err.code ?? "不是 JSON") }; }
    const problem = consumedRecordProblem(doc, key);
    if (problem) return { status: "unreadable", why: problem };
    if (expectedIntent !== undefined && !sameControlIntent(expectedIntent, { control: doc.control, mode: doc.mode })) {
      return { status: "mismatch", why: "consumed 的意图（" + doc.mode + "）与 claim 的意图（" + String(expectedIntent?.mode) + "）不一致", record: doc };
    }
    return { status: "valid", record: doc };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

/** 同一 key 的 consumed 临时制品（写到一半 / rename 失败留下的）：受控形状，报 consumed_in_flight；成功写出后清掉。 */
export const CONSUMED_TMP_RE = /^([0-9a-f]{64})\.consumed\.json\.tmp\.\d+\.\d+$/u;
export function consumedResidue({ claimsDir, key }) {
  let names = [];
  try { names = fs.readdirSync(claimsDir); } catch { return []; }
  return names.filter((n) => { const m = CONSUMED_TMP_RE.exec(n); return m && m[1] === key; });
}
function cleanupConsumedResidue({ claimsDir, key }) {
  for (const n of consumedResidue({ claimsDir, key })) { try { fs.rmSync(path.join(claimsDir, n), { force: true }); } catch { /* 盘点会报 */ } }
}

/**
 * **可恢复的控制事务**：意图已在 claim 里（三道闸之后、执行之前持久化）。
 *   · 首次：幂等执行 → 写受验 consumed → 清同 key 的临时残骸。
 *   · 重放 / 维护恢复（replay）：consumed 完整且**意图一致** → 按记录重出回执，不再执行；意图不一致 → 拒（consumed_intent_mismatch）；
 *     缺席 / 坏 → 续做（再执行一次，幂等）并写 consumed。
 *   · 写 consumed 失败：动作已成、账本未闭合 —— 如实报 ledger_unwritten。**只有运输层对同一事件的重放，或维护入口
 *     repair-control-claim，才能补齐**；Frank 在飞书重发是新消息 = 新 claim，补不了旧账。不回滚模式（会覆盖期间的合法修改）。
 * execute(mode) 必须幂等，返回 { ok, changed, reason }。
 */
export function runControlTransaction({ claimsDir, key, intent, execute, replay = false }) {
  const problem = controlIntentProblem(intent);
  if (problem || intent === undefined) return { ok: false, reason: "control_intent_invalid", why: problem ?? "缺 control" };
  if (replay) {
    const existing = readConsumedRecord({ claimsDir, key, expectedIntent: intent });
    if (existing.status === "valid") return { ok: true, changed: existing.record.changed, resumed: false, replayed: true };
    if (existing.status === "mismatch") return { ok: false, reason: "consumed_intent_mismatch", why: existing.why };
    // 缺席或损坏：续做
  }
  const done = execute(intent.mode);
  if (!done.ok) return { ok: false, reason: "control_failed", why: done.reason ?? "?" };
  const changed = done.changed !== false;
  try {
    recordClaimState({ claimsDir, key, state: "consumed", detail: { control: intent.control, mode: intent.mode, changed } });
  } catch (err) {
    return { ok: false, reason: "ledger_unwritten", why: String(err?.code ?? err?.message ?? err), changed, resumed: replay };
  }
  cleanupConsumedResidue({ claimsDir, key });
  return { ok: true, changed, resumed: replay, replayed: false };
}

/**
 * 维护入口共用：一张 claim 的控制事务处在什么状态。
 *   · not_control：claim 里没有控制意图；claim_*：claim 读不出；
 *   · consumed：终态完整且与意图一致；mismatch；in_flight：有意图、没终态（可恢复）；failed：有 failed 记录。
 */
export function inspectControlClaim({ claimsDir, key }) {
  // 先看终态文件本身：读不出 / 不是普通文件 / 形状坏 —— 不管 claim 在不在都先报它（最具体的那个原因）。
  const raw = readConsumedRecord({ claimsDir, key });
  if (raw.status === "unreadable") return { state: "consumed_unreadable", why: raw.why };
  const claim = readClaimState({ claimsDir, key });
  if (claim.status !== "valid") return { state: "claim_" + claim.status, why: claim.why ?? null };
  const intent = claim.claim.control;
  if (intent === undefined) return { state: "not_control" };
  if (raw.status === "valid") {
    return sameControlIntent(intent, { control: raw.record.control, mode: raw.record.mode })
      ? { state: "consumed", intent, record: raw.record, residue: consumedResidue({ claimsDir, key }) }
      : { state: "mismatch", intent, why: "consumed 的意图（" + raw.record.mode + "）与 claim 的意图（" + intent.mode + "）不一致" };
  }
  if (fs.existsSync(path.join(claimsDir, key + ".failed.json"))) return { state: "failed", intent };
  return { state: "in_flight", intent, residue: consumedResidue({ claimsDir, key }) };
}

/** 维护入口的恢复动作：只对 in_flight（或终态损坏）续做；execute 由链各自注入。 */
export function resumeControlClaim({ claimsDir, key, execute }) {
  const seen = inspectControlClaim({ claimsDir, key });
  if (seen.state === "consumed") return { ok: true, already: true, changed: seen.record.changed, intent: seen.intent };
  if (seen.state !== "in_flight" && seen.state !== "consumed_unreadable") return { ok: false, reason: seen.state, why: seen.why ?? null };
  const tx = runControlTransaction({ claimsDir, key, intent: seen.intent, execute, replay: true });
  return tx.ok ? { ok: true, already: false, changed: tx.changed, intent: seen.intent } : { ok: false, reason: tx.reason, why: tx.why };
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
