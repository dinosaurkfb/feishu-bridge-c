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
import { CLAIM_KEY_SHAPE, recordClaimState } from "./claim.mjs";

export const CONTROL_MODES = [MAPPING_POLICY_ID, DIALOGUE_POLICY_ID];

/** claim 里持久化的控制意图的封闭形状：{ control: "mode", mode: mapping|dialogue }。不在场 = 不是控制命令。 */
export function controlIntentProblem(intent) {
  if (intent === undefined) return null;
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return "control 不是对象";
  if (Object.keys(intent).sort().join(",") !== "control,mode") return "control 字段集不是 {control, mode}";
  if (intent.control !== "mode") return "control 不是 mode";
  if (!CONTROL_MODES.includes(intent.mode)) return "mode 不在受控取值里";
  return null;
}

/** consumed 记录（<key>.consumed.json）的封闭形状；坏了要进账本 problems，不能按文件名当健康。 */
export function consumedRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.state !== "consumed") return "state 不是 consumed";
  if (doc.claim_key !== key) return "claim_key 跟文件名对不上";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  if (doc.control !== "mode") return "control 不是 mode";
  if (!CONTROL_MODES.includes(doc.mode)) return "mode 不在受控取值里";
  if (typeof doc.changed !== "boolean") return "changed 不是布尔";
  return null;
}

/** 读 consumed 记录：absent / valid / unreadable 三态。读之前 lstat 只收普通文件（同未路由盘点的教训）。 */
export function readConsumedRecord({ claimsDir, key }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 形状不对" };
  const file = path.join(claimsDir, key + ".consumed.json");
  let st;
  try { st = fs.lstatSync(file); }
  catch (err) { return err.code === "ENOENT" ? { status: "absent" } : { status: "unreadable", why: String(err.code ?? err.message) }; }
  if (!st.isFile()) return { status: "unreadable", why: "不是普通文件" };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (err) { return { status: "unreadable", why: String(err.code ?? "不是 JSON") }; }
  const problem = consumedRecordProblem(doc, key);
  return problem ? { status: "unreadable", why: problem } : { status: "valid", record: doc };
}

/**
 * **可恢复的控制事务**：意图已在 claim 里（三道闸之后、执行之前持久化）。
 *   · 首次：幂等执行 → 写受验 consumed。
 *   · 重放（claim 幂等命中）：consumed 完整 → 按记录重出回执，不再执行；缺席 / 坏 → 续做（再执行一次，幂等）并写 consumed。
 *   · 写 consumed 失败：动作已成、账本未闭合 —— 如实报 ledger_unwritten，下一次重放会补齐。不回滚模式（会覆盖期间的合法修改）。
 * execute(mode) 必须幂等，返回 { ok, changed, reason }。
 */
export function runControlTransaction({ claimsDir, key, intent, execute, replay = false }) {
  const problem = controlIntentProblem(intent);
  if (problem || intent === undefined) return { ok: false, reason: "control_intent_invalid", why: problem ?? "缺 control" };
  if (replay) {
    const existing = readConsumedRecord({ claimsDir, key });
    if (existing.status === "valid") return { ok: true, changed: existing.record.changed, resumed: false, replayed: true };
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
  return { ok: true, changed, resumed: replay, replayed: false };
}

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

const MODE_LABEL = {
  [DIALOGUE_POLICY_ID]: "Dialogue（单主持者·串行；默认 12 轮 / 2 小时 / 12 资源单位）",
  [MAPPING_POLICY_ID]: "Mapping（一次输入对应一次运行）",
};

/** 回执正文：说清切到了什么、是不是本来就是、这条不是指令；重放 / 续做也说清。 */
export function controlAckText({ taskName, mode, changed, replayed = false, resumed = false }) {
  const head = replayed ? "已处理过 · " : resumed ? "已补齐 · " : changed ? "已切换 · " : "模式未变 · ";
  const body = replayed
    ? "这条控制命令之前已经执行过（" + (changed ? "当时完成了切换" : "当时模式未变") + "），交互模式是 " + (MODE_LABEL[mode] ?? mode) + "。"
    : resumed
      ? "上次执行后终态没记下，这次已补齐；交互模式是 " + (MODE_LABEL[mode] ?? mode) + "。"
      : (changed ? "交互模式现在是 " : "本来就是 ") + (MODE_LABEL[mode] ?? mode) + "。";
  return [head + taskName, body, "本条是控制命令，没有被当作指令投递。"].join("\n");
}
