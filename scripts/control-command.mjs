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
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import path from "node:path";
import { DIALOGUE_POLICY_ID, MAPPING_POLICY_ID } from "./interaction-policy.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { CLAIM_KEY_SHAPE, readClaimState, recordClaimState } from "./claim.mjs";
import { controlIntentProblem, sameControlIntent } from "./control-intent.mjs";
import { SELECTION_HANDLE_SHAPE, REBIND_HANDLE_SHAPE, REAFFIRM_HANDLE_SHAPE } from "./topic-agent-ledger.mjs";
import { ID_SHAPE } from "./shapes.mjs";

export { CONTROL_MODES, controlIntentProblem, sameControlIntent } from "./control-intent.mjs";

/** feishu-mode 的参数词 —— **唯一一份**：精确形状的正则由它生成，收边的"参数只认 …"文案也引用它。 */
export const CONTROL_MODE_WORDS = Object.freeze(["dialogue", "mapping"]);
const SHAPES = {
  claude: new RegExp("^\\/feishu-mode (" + CONTROL_MODE_WORDS.join("|") + ")$", "u"),
  codex: new RegExp("^\\$feishu-mode (" + CONTROL_MODE_WORDS.join("|") + ")$", "u"),
};
// R52a：/feishu-select 的 handle 正则**从 topic-agent-ledger 导出的 handle 形状常量生成**（单一出处；不另写一份字母表）。
// 注（PR #136 P2 / §12）："owner 先于 handle 解析"指的是业务解析层面（先核验 owner 身份与写入准入，再做 handle 寻址），不是词法层面的顺序。
const HANDLE_ALTS = Object.freeze([
  { re: SELECTION_HANDLE_SHAPE, kind: "osh" },
  { re: REBIND_HANDLE_SHAPE, kind: "orh" },
  { re: REAFFIRM_HANDLE_SHAPE, kind: "rfh" },
]);
const HANDLE_ALT = HANDLE_ALTS.map(({ re }) => re.source.replace(/^\^|\$$/gu, "")).join("|");
const SELECT_SHAPES = {
  claude: new RegExp("^\\/feishu-select(?: (" + HANDLE_ALT + "))?$", "u"),
  codex: new RegExp("^\\$feishu-select(?: (" + HANDLE_ALT + "))?$", "u"),
};
const handleKindOf = (h) => h === null ? null : (h.startsWith("osh_") ? "osh" : h.startsWith("orh_") ? "orh" : h.startsWith("rfh_") ? "rfh" : null);

/**
 * 飞书客户端会在 @ 之后 / 词与词之间塞进不换行空格（U+00A0）、全角空格（U+3000）、零宽字符（U+200B…）、
 * 全角斜杠 / 美元符；这些都**不是字**，精确匹配前先折叠掉 —— "多一个字都不算"守的是词，不是不可见字节。
 * 折叠只针对零宽字符、NBSP/全角空格、全角前缀与 ASCII 多空格（C0 控制字符与换行/制表在折叠前即拒，PR #136 一轮回带）。
 */
export function normalizeControlText(instruction) {
  if (typeof instruction !== "string") return instruction;
  return instruction
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/／/gu, "/")
    .replace(/＄/gu, "$")
    .replace(/[ \u00A0\u3000]+/gu, " ")
    .replace(/^[ \u00A0\u3000]+|[ \u00A0\u3000]+$/gu, "");
}

/** @returns {{kind:"mode", mode:string}|null} */
export function parseControlCommand(instruction, { chain } = {}) {
  if (typeof instruction !== "string") return null;
  const norm = normalizeControlText(instruction);
  const modeRe = SHAPES[chain];
  if (modeRe) { const m = modeRe.exec(norm); if (m) return { kind: "mode", mode: m[1] === "dialogue" ? DIALOGUE_POLICY_ID : MAPPING_POLICY_ID }; }
  const selRe = SELECT_SHAPES[chain];
  if (selRe) {
    const m = selRe.exec(norm);
    if (m) return { kind: "select", handle: m[1] ?? null, handle_kind: handleKindOf(m[1] ?? null) };
  }
  return null;
}

const CONSUMED_KEYS = "changed,claim_key,control,mode,recorded_at,schema_version,state";

function intentFromConsumedRecord(rec) {
  return rec?.control === "select"
    ? { control: "select", handle: rec.handle, handle_kind: rec.handle_kind }
    : { control: rec?.control, mode: rec?.mode };
}

function intentTarget(i) {
  return i?.control === "select" ? i?.handle : i?.mode;
}

/** consumed 记录（<key>.consumed.json）的封闭形状：键集恰为 CONSUMED_KEYS；坏了要进账本 problems，不能按文件名当健康。 */
export function consumedRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "不是记录对象";
  // R52a 返修一：consumed 记录按 kind 判别联合 —— mode → {control,mode}；select → {control,handle,handle_kind}。
  const wantKeys = doc.control === "select" ? "changed,claim_key,control,handle,handle_kind,recorded_at,schema_version,state" : CONSUMED_KEYS;
  if (Object.keys(doc).sort().join(",") !== wantKeys) return "字段集不对";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.state !== "consumed") return "state 不是 consumed";
  if (doc.claim_key !== key) return "claim_key 跟文件名对不上";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  const intentProblem = controlIntentProblem(intentFromConsumedRecord(doc));
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
 * 读一条 claim 对应的 consumed 记录并做受控校验。
 *
 * 与 readClaimState 同理：
 *   · absent：文件不在，正常（还没完成）；
 *   · unreadable：读不出 / 格式不对 / 校验没过，问题描述在 why 里；
 *   · mismatch：文件合法但 recorded_at / 意图与当前期望不一致（人换了文件）；
 *   · valid：内容完整合法。
 */
export function readConsumedRecord({ claimsDir, key, expectedIntent = undefined, afterOpen = null }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 形状不对" };
  const r = readRecordFile(path.join(claimsDir, key + ".consumed.json"), { afterOpen });
  if (r.status !== "read") return r;
  const problem = consumedRecordProblem(r.doc, key);
  if (problem) return { status: "unreadable", why: problem };
  if (expectedIntent !== undefined && !sameControlIntent(expectedIntent, intentFromConsumedRecord(r.doc))) {
    return { status: "mismatch", why: "consumed 的意图（" + intentTarget(r.doc) + "）与 claim 的意图（" + intentTarget(expectedIntent) + "）不一致", record: r.doc };
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
  if (doc.control !== "mode" && doc.control !== "select") return "control 不是 mode/select";
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

const UNCLEAN_DETAIL_KEYS = "action,ledger,ledger_evidence,ledger_reason,legacy,plan_ref,request_key,target_id";
/** 顶层记录（recordClaimState 把 detail 铺平到顶层，结构化证据住在 doc.detail）：精确键集，多一个/少一个都拒。 */
const UNCLEAN_RECORD_KEYS = "changed,claim_key,control,detail,error,handle,handle_kind,intent_cleanup,ledger,locks,reason,recorded_at,repair_attempts,result,schema_version,state,status,why";
const UNCLEAN_ACTIONS = Object.freeze(["activate", "anchor", "rebind", "reaffirm"]);
/** legacy 只有这三种提交事实 + not_applicable（authoritative 模式与 rfh 支没有 legacy 提交，不许谎报 committed）。 */
const UNCLEAN_LEGACY_VALUES = Object.freeze(["committed", "not_committed", "unknown", "not_applicable"]);
const UNCLEAN_LEDGER_VALUES = Object.freeze(["committed", "not_committed", "unknown"]);
const SHA64_SHAPE = /^[0-9a-f]{64}$/u;
/** R57d 返修六 P2：ledger_evidence / repair_attempts 的封闭形状。 */
const LEDGER_EVIDENCE_KEYS = "commit,lock_uncleared,residue";
const EVIDENCE_COMMITS = Object.freeze(["committed_clean", "committed_with_residue", "committed_durability_uncertain", "not_committed", "unknown"]);
const REPAIR_ATTEMPT_KEYS = "at,commit,lock_uncleared,reason,residue";
const evidenceProblem = (ev) => {
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return "ledger_evidence 不是对象";
  if (Object.keys(ev).sort().join(",") !== LEDGER_EVIDENCE_KEYS) return "ledger_evidence 键集不对（须 " + LEDGER_EVIDENCE_KEYS + "）";
  if (!EVIDENCE_COMMITS.includes(ev.commit)) return "ledger_evidence.commit 不在 " + EVIDENCE_COMMITS.join("/");
  if (!Array.isArray(ev.residue) || ev.residue.some((x) => typeof x !== "string" || x.length === 0)) return "ledger_evidence.residue 不是非空字符串数组";
  if (typeof ev.lock_uncleared !== "boolean") return "ledger_evidence.lock_uncleared 不是布尔";
  return null;
};
// request_key 的两支**真实**形状（不是 64hex —— 写成 64hex 会让每条真链路的 unclean 记录都读不出，
//   repair 从此无从下手）：
//   · osh/orh：m1a/wiring 的通式派生 `m1a_<40hex>`（dual-write.requestKeyFor，同一函数写/读共用）；
//   · rfh：`osr:<target_id>:<rfh_handle>`（topic-agent-ledger.ownerSelectReaffirmRequestKey）。
const M1A_REQUEST_KEY_SHAPE = /^m1a_[0-9a-f]{40}$/u;
const RFH_REQUEST_KEY_SHAPE = /^osr:ta_[0-9a-f]{32}:rfh_[0-9a-f]{32}$/u;

export function controlCommittedUncleanRecordProblem(doc, key) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "doc 不是对象";
  // P1-5a（返修五）：顶层记录也精确键集 —— 否则一份「结构合法但谁都读不懂」的记录照样过校验。
  if (Object.keys(doc).sort().join(",") !== UNCLEAN_RECORD_KEYS) return "记录字段集不对（须 " + UNCLEAN_RECORD_KEYS + "）";
  if (doc.schema_version !== "1.0") return "schema_version 不认识";
  if (doc.claim_key !== key) return "claim_key 跟文件名对不上";
  if (doc.state !== "control-committed-unclean") return "state 不是 control-committed-unclean";
  if (!isCanonicalIso(doc.recorded_at)) return "recorded_at 不是规范时间";
  if (doc.control !== "select") return "control 不是 select";
  if (doc.handle_kind !== null && doc.handle_kind !== "osh" && doc.handle_kind !== "orh" && doc.handle_kind !== "rfh") return "handle_kind 不在 osh/orh/rfh";
  // P1-5a：持久证据的 detail 按 action 判别联合封闭 —— 键集 + 枚举值 + 形状 + 必非 null 项，缺一 → 拒读为 unreadable。
  const d = doc.detail;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return "detail 不是对象";
  if (Object.keys(d).sort().join(",") !== UNCLEAN_DETAIL_KEYS) return "detail 键集不对（须 " + UNCLEAN_DETAIL_KEYS + "）";
  if (!UNCLEAN_ACTIONS.includes(d.action)) return "detail.action 不在 activate/anchor/rebind/reaffirm";
  if (typeof d.target_id !== "string" || !ID_SHAPE.test(d.target_id)) return "detail.target_id 不是账本 id 形状（ta_<32hex>）";
  if (d.request_key !== null && (typeof d.request_key !== "string" || !(d.action === "reaffirm" ? RFH_REQUEST_KEY_SHAPE : M1A_REQUEST_KEY_SHAPE).test(d.request_key))) {
    return "detail.request_key 形状不对（osh/orh 须 m1a_<40hex>、rfh 须 osr:<target>:<rfh_>，或 null）";
  }
  if (d.plan_ref !== null && (typeof d.plan_ref !== "string" || !SHA64_SHAPE.test(d.plan_ref))) return "detail.plan_ref 不是 64hex 或 null";
  if (!UNCLEAN_LEGACY_VALUES.includes(d.legacy)) return "detail.legacy 枚举不在 committed/not_committed/unknown/not_applicable";
  if (!UNCLEAN_LEDGER_VALUES.includes(d.ledger)) return "detail.ledger 枚举不在 committed/not_committed/unknown";
  if (typeof d.ledger_reason !== "string") return "detail.ledger_reason 不是字符串";
  // 判别联合：两条 64hex 一份 plan 证据，osh/orh 三支都必非 null；rfh 支同款（重叠后取 sidecar 受验 digest +
  // ownerSelectReaffirmRequestKey 派生）；rfh 没有 legacy 提交 → legacy 必须是 not_applicable。
  if (d.request_key === null) return d.action + " 支 detail.request_key 必非 null";
  if (d.plan_ref === null) return d.action + " 支 detail.plan_ref 必非 null";
  if (d.action === "reaffirm" && d.legacy !== "not_applicable") return "reaffirm 支 detail.legacy 必须是 not_applicable（rfh 没有 legacy 提交）";
  // R57d 返修六 P2：交叉等式 —— 只封键集会放过语义自相矛盾的记录。
  //   · action ↔ handle_kind：activate/anchor↔osh、rebind↔orh、reaffirm↔rfh；
  //   · 顶层 ledger（执行器分类：clean/unclean/not_committed）↔ detail.ledger（提交事实：committed/not_committed/unknown）；
  //   · legacy 的允许组合：committed/not_committed 只属 shadow 的 activate/anchor/rebind（rfh 恒 not_applicable，上一行已核）。
  const wantKind = d.action === "reaffirm" ? "rfh" : (d.action === "rebind" ? "orh" : "osh");
  if (doc.handle_kind !== wantKind) return "action（" + d.action + "）与 handle_kind（" + String(doc.handle_kind) + "）不一致（须 " + wantKind + "）";
  if (doc.ledger === "not_committed" && d.ledger !== "not_committed") return "顶层 ledger 是 not_committed 而 detail.ledger 是 " + String(d.ledger);
  if ((doc.ledger === "clean" || doc.ledger === "unclean") && d.ledger !== "committed") return "顶层 ledger 是 " + doc.ledger + " 而 detail.ledger 是 " + String(d.ledger) + "（须 committed）";
  if (d.legacy === "committed" || d.legacy === "not_committed") {
    if (d.action === "reaffirm") return "reaffirm 支不许写 legacy=" + d.legacy;
  }
  //   · 持久化证据与修复尝试（P1-2）也必须成形。
  const evProblem = evidenceProblem(d.ledger_evidence);
  if (evProblem !== null) return evProblem;
  const attempts = doc.repair_attempts;
  if (!Array.isArray(attempts)) return "repair_attempts 不是数组";
  for (const a of attempts) {
    if (a === null || typeof a !== "object" || Array.isArray(a) || Object.keys(a).sort().join(",") !== REPAIR_ATTEMPT_KEYS) return "repair_attempts 条目键集不对（须 " + REPAIR_ATTEMPT_KEYS + "）";
    if (!isCanonicalIso(a.at)) return "repair_attempts.at 不是规范时间";
    if (typeof a.reason !== "string") return "repair_attempts.reason 不是字符串";
    const p2 = evidenceProblem({ commit: a.commit, residue: a.residue, lock_uncleared: a.lock_uncleared });
    if (p2 !== null) return "repair_attempts 条目：" + p2;
  }
  return null;
}

/**
 * unclean 记录的**唯一写面**（P1-5a）：顶层键集与 detail 位置只在这里定，两个写入点（执行器 unclean / 终态写失败）
 * 共用同一个形状 —— 不然「顶层精确键集」这条判据会在两个写入点之间分叉。
 */
export function uncleanRecordFields({ control, handle, handleKind, why, ledger, intentCleanup, locks, changed, result, evidence, attempts = null }) {
  return {
    control,
    handle: handle ?? null,
    handle_kind: handleKind ?? null,
    reason: "control_committed_unclean",
    status: "control-committed-unclean",
    error: why,
    why,
    ledger: ledger ?? null,
    intent_cleanup: intentCleanup ?? null,
    locks: locks ?? null,
    changed: changed === true,
    result: result ?? null,
    detail: evidence,
    // R57d 返修六 P1-2：修复尝试历史（**追加**，不覆盖原始证据）——顶层精确键集里的一员，起始为空数组。
    repair_attempts: Array.isArray(attempts) ? attempts : [],
  };
}
export function readControlCommittedUncleanRecord({ claimsDir, key }) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { status: "unreadable", why: "key 形状不对" };
  const r = readRecordFile(path.join(claimsDir, key + ".control-committed-unclean.json"));
  if (r.status !== "read") return r;
  const problem = controlCommittedUncleanRecordProblem(r.doc, key);
  return problem ? { status: "unreadable", why: problem } : { status: "valid", record: r.doc };
}

/** 同一 key 的 consumed 临时制品（写到一半 / rename 失败留下的）：受控形状，报 consumed_in_flight；成功写出后清掉。 */
export const CONSUMED_TMP_RE = /^([0-9a-f]{64})\.consumed\.json\.tmp\.\d+\.\d+$/u;
/** 损坏的 failed 记录被隔离后的名字：受控形状，账本按 control_failed_quarantined 报，人工看完再删。 */
export const CONTROL_QUARANTINE_RE = /^([0-9a-f]{64})\.(?:failed|rejected)\.quarantined\.\d+\.\d+$/u;
/** 逐 key 的事务锁（registry.mjs 的 symlink 锁协议，payload 即 owner { pid, at, token }）：运输层重放、首次执行、维护入口共用同一份所有权。留下没释放的由账本报 control_lock_held。 */
export const CONTROL_LOCK_RE = /^([0-9a-f]{64})\.control\.lock$/u;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * 锁家族的封闭形状（与 registry.mjs 的协议逐一对应），每一族的处置方式不同 —— 账本按族报，不给一句笼统的"删了"：
 *   lock        主锁（symlink）：正常几毫秒；持有者已死超过 staleMs 会由下一笔按协议回收 —— 不要手删
 *   reap        reap 段锁：段内几毫秒；残骸交显式维护入口 repair-publish-lock --lock <主锁路径>
 *   maint       维护锁：只能由人确认没有维护者在跑后手动删
 *   reaped      回收时 rename 走、没删成的残骸（.reaped-<uuid>）：**形状合法的 symlink** 可直接删
 *   quarantine  维护入口隔离后没删成的残骸（.reap.quarantine-<…>）：**形状合法的 symlink** 可直接删（已离开原路径、不涉归属，与 reaped 同理）
 * 别的后缀不是家族成员（按 unrecognized_entry 报）。残骸两族说"可直接删"前先过 inspectControlLockArtifact 的
 * 形态判别（与共享维护器 clearStaleReapLock 同一判据，issue #85）—— 名字像不等于协议写出来的。
 */
const LOCK_FAMILY = [
  ["lock", new RegExp("^([0-9a-f]{64})\\.control\\.lock$", "u")],
  ["reap", new RegExp("^([0-9a-f]{64})\\.control\\.lock\\.reap$", "u")],
  ["maint", new RegExp("^([0-9a-f]{64})\\.control\\.lock\\.maint$", "u")],
  ["reaped", new RegExp("^([0-9a-f]{64})\\.control\\.lock\\.reaped-" + UUID + "$", "u")],
  ["quarantine", new RegExp("^([0-9a-f]{64})\\.control\\.lock\\.reap\\.quarantine-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", "u")],
];
export function classifyControlLockEntry(name) {
  if (typeof name !== "string") return null;
  for (const [family, re] of LOCK_FAMILY) { const m = re.exec(name); if (m) return { key: m[1], family }; }
  return null;
}

/**
 * 锁家族制品的**受控形态判别**（唯一一份；与 registry.mjs 的 symlink 锁协议同一形状，issue #85）。
 * 账本盘点（outbound.mjs inventoryRuns）对 reaped / quarantine 两族用它决定文案：只有形状合法的 symlink
 * —— payload 是本协议 owner（pid 正安全整数、at 规范化 ISO、token 非空字符串，与 registry.mjs 的
 * ownerShapeOk / installed-surface.mjs inspectInstalledSurface 的 shapeOk 同一形状）—— 才是协议写出的残骸，
 * 可以给"可直接删 / repair 能清"；普通文件、目录、payload 畸形一律"先核验再处理 / 只人工处置"，绝不说"可直接删"。
 * 只有 ENOENT 算"不在"；别的 lstat 错误是 I/O 故障，按 io_error 报出来（评审探针：EACCES 曾被说成 present:false）。
 * @returns { {present:false} | {present:true, shape:"symlink_owner", owner:object} |
 *            {present:true, shape:"not_symlink"|"malformed_payload"} | {present:true, shape:"io_error", why:string} }
 */
export function inspectControlLockArtifact(fullPath) {
  let st;
  try { st = fs.lstatSync(fullPath); }
  catch (err) {
    if (err?.code === "ENOENT") return { present: false };
    return { present: true, shape: "io_error", why: String(err?.code ?? err?.message ?? err) };
  }
  if (!st.isSymbolicLink()) return { present: true, shape: "not_symlink" };
  // readlink 自己的失败也要三态（评审探针：EIO 曾被折成 malformed_payload）：并发消失 → 不在；I/O 错 → io_error；
  // 只有**读出来了**但 JSON / owner 形状不合法，才是 malformed_payload。
  let raw;
  try { raw = fs.readlinkSync(fullPath); }
  catch (err) {
    if (err?.code === "ENOENT") return { present: false };
    return { present: true, shape: "io_error", why: String(err?.code ?? err?.message ?? err) };
  }
  let owner = null;
  try { owner = JSON.parse(raw); } catch { owner = null; }
  const shapeOk = owner !== null && typeof owner === "object" && !Array.isArray(owner)
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && isCanonicalIso(owner.at)
    && typeof owner.token === "string" && owner.token.length > 0;
  return shapeOk ? { present: true, shape: "symlink_owner", owner } : { present: true, shape: "malformed_payload" };
}
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

/**
 * 逐 key 事务锁 —— **不另起一套协议**，直接用 registry.mjs 里已评审上线的 symlink 锁（#79）：
 *   · key 先过 CLAIM_KEY_SHAPE，坏 key 不派生任何路径、不跑任何回调（唯一一道闸）；
 *   · 取得：symlink 原子创建，payload 即 owner { pid, at, token } —— 没有"先建目录再写 owner"的窗口，也就没有匿名锁；
 *   · 释放：releasePublishLock 在 reap 锁里核 token 再删，与陈旧回收 / 接管串行 —— 归属转换只在那一把锁里发生，
 *     "核对 → 按路径 rm"之间不会被合法接管者替换；不是自己的实例（not_owner）、owner 读不出、锁已不在、reap 段忙，
 *     都以 lockUncleared 附在结果上，不吞；
 *   · 持有者崩掉：超过 staleMs 由下一个取锁者按同一协议回收；账本盘点时撞见锁条目就报 control_lock_held。
 */
function describeLockOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readlinkSync(lockPath));
    return owner && typeof owner === "object" ? "（pid " + owner.pid + "，自 " + owner.at + "）" : "（持有者不明）";
  } catch { return "（持有者不明）"; }
}
/**
 * 在这一笔的事务锁内跑 fn。拿不到锁 → { ok:false, reason: control_busy | control_lock_unavailable }；
 * fn 的结果原样返回，只在锁没有干净交还时追加 lockUncleared（原因）—— 事务本身可能已成，但锁的事必须说出来。
 */
export function withControlLock({ claimsDir, key }, fn) {
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { ok: false, reason: "claim_key_invalid", why: "key 形状不对" };
  if (typeof claimsDir !== "string" || !claimsDir) return { ok: false, reason: "claim_key_invalid", why: "claimsDir 缺失" };
  const lockPath = path.join(claimsDir, key + CONTROL_LOCK_SUFFIX);
  // 共享原语按阶段返回受控结果，但陈旧回收 / 释放里的文件操作本身仍可能抛（EIO 之类）：在这一层全部兜住 ——
  // 取得阶段抛 → control_lock_unavailable（回调没跑）；释放阶段抛 → lockUncleared（事务结果照常返回，不许把已完成的事务变成一个裸异常）。
  let lock;
  try { lock = acquirePublishLock(lockPath); }
  catch (err) { return { ok: false, reason: "control_lock_unavailable", why: "锁原语抛错：" + String(err?.code ?? err?.message ?? err) }; }
  if (!lock.ok) {
    if (lock.reason === "publisher_busy") {
      return { ok: false, reason: "control_busy", why: "这一笔已有事务持有者" + describeLockOwner(lockPath) + "；等它结束再试（持有者已死的锁超过 5 分钟会按同一协议回收）" };
    }
    // 含 reaped_uncleared（陈旧锁隔离后删不掉，原语默认 fail-closed 不取锁）：回调没跑、没有锁要交还，残骸路径点名交显式维护入口
    return { ok: false, reason: "control_lock_unavailable", why: String(lock.reason) + (lock.error ? "：" + lock.error : "") + (lock.path ? "（" + lock.path + "）" : "") };
  }
  let result;
  try { result = fn(); }
  finally {
    let rel;
    try { rel = releasePublishLock(lockPath); }
    catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    const why = !rel.ok ? String(rel.reason) + (rel.pid ? "（pid " + rel.pid + "）" : "") + (rel.error ? "：" + rel.error : "") : rel.absent ? "锁已不在（被清理过）" : null;
    if (why && result && typeof result === "object") result = { ...result, lockUncleared: why };
  }
  return result;
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
/**
 * intent：调用方这次解析出的意图（生产路径），锁内必须与 claim 里持久化的意图一致；传 null（维护入口）= 以锁内 claim 的意图为准。
 * expect：当前绑定 / task 的身份期望（与 claim 里写的身份字段同一算法）—— 锁内重读 claim 时核对，别的 binding / thread 的同 key claim 不许执行、不许写记录。
 */
export function runControlTransaction({ claimsDir, key, intent = null, execute, replay = false, expect = {}, contextDigest = null }) {
  // key 的闸只有一道，在 withControlLock 里：任何路径派生、任何回调之前。
  if (intent !== null) {
    const problem = controlIntentProblem(intent);
    if (problem || intent === undefined) return { ok: false, reason: "control_intent_invalid", why: problem ?? "缺 control" };
  }
  return withControlLock({ claimsDir, key }, () => runLockedTransaction({ claimsDir, key, intent, execute, replay, expect, contextDigest }));
}
function runLockedTransaction({ claimsDir, key, intent: caller, execute, replay, expect, contextDigest = null }) {
  const quarantined = [];
  // **锁内先重读 claim，身份与意图都以锁内为准**（评审 #94 第 5 轮探针：旧 binding 的同 key claim 重放能改当前模式）：
  // claim 不属于当前身份 → claim_unreadable；没有控制意图 → not_control；调用方意图与锁内不一致 → claim_intent_mismatch —— 三种都不执行、不写记录。
  const claim = readClaimState({ claimsDir, key, expect });
  if (claim.status !== "valid") return { ok: false, reason: "claim_" + claim.status, why: claim.why ?? null, quarantined };
  const intent = claim.claim.control;
  if (intent === undefined) return { ok: false, reason: "not_control", why: "锁内读到的 claim 没有控制意图", quarantined };
  if (caller !== null && !sameControlIntent(caller, intent)) {
    return { ok: false, reason: "claim_intent_mismatch", why: "锁内 claim 的意图（" + intentTarget(intent) + "）与这次的（" + intentTarget(caller) + "）不一致", quarantined };
  }
  // R57d 返修一 B 段 P1-3：同 message 的事实漂移不得被终态 claim 遮蔽 —— **终态短路之前**逐字比较
  //   selection context digest（调用方从当前事件现算，claim 里是持久化的）；不一致 → select_context_conflict，
  //   绝不回「已处理」。claim 没带 digest（旧形）不在这里拒 —— 执行器/维护入口的 verifySelectionContext 会点名。
  if (caller !== null && intent?.control === "select" && typeof contextDigest === "string" && contextDigest.length > 0) {
    const claimDigest = claim.claim?.selection_context_digest_v1;
    if (typeof claimDigest === "string" && claimDigest.length > 0 && claimDigest !== contextDigest) {
      return { ok: false, reason: "select_context_conflict", why: "当前事件上下文与 claim 持久化的 selection_context_digest_v1 不一致（同一条消息换会话/发送者重放）", quarantined };
    }
  }
  // **锁内状态对所有调用者都是权威的**：不管调用方自称首次还是重放，这一笔已经闭合（consumed / 受验 failed / 并存）就不再执行。
  // 重复投递先完成、原 claim 持有者晚到 —— 晚到者在这里按记录重出回执（replayed），而不是再切一次并覆写记录。
  const consumed = readConsumedRecord({ claimsDir, key, expectedIntent: intent });
  const failed = readControlFailedRecord({ claimsDir, key });
  if (consumed.status !== "absent" && failed.status !== "absent") return { ok: false, reason: "control_conflict", why: jointWhy(failed, consumed) };
  if (consumed.status === "valid") return { ok: true, intent, changed: consumed.record.changed, resumed: false, replayed: true, residueUncleared: [], residueUnknown: null, quarantined };
  if (consumed.status === "mismatch") return { ok: false, reason: "consumed_intent_mismatch", why: consumed.why };
  if (failed.status === "valid") return { ok: false, reason: "control_failed_recorded", why: failed.record.error, replayed: true };
  // R57d 返修一 B 段 P1-7：unclean 不是终态也不是普通 failed —— 运输层重放按记录重出「已写入但收口不干净」，
  //   **不重执行**（osh/orh 的目标已消费，重执行只会 no_candidate）；只向前收敛走维护入口 resumeControlClaim。
  const uncleanPrior = readControlCommittedUncleanRecord({ claimsDir, key });
  if (uncleanPrior.status === "valid") {
    return { ok: false, status: "control-committed-unclean", reason: "control_committed_unclean", why: uncleanPrior.record.why ?? uncleanPrior.record.error ?? "committed_unclean", replayed: true, quarantined };
  }
  if (failed.status === "unreadable") {
    const name = key + ".failed.quarantined." + process.pid + "." + Date.now();
    try { fs.renameSync(path.join(claimsDir, key + ".failed.json"), path.join(claimsDir, name)); }
    catch (err) { return { ok: false, reason: "failed_unquarantined", why: String(err.code ?? err.message) }; }
    quarantined.push(name);
  }
  // consumed 缺席或损坏、failed 不在场：执行（首次）或续做（重放）
  const done = execute(
    intent.control === "select" ? intent : intent.control === "mode" ? intent.mode : intent,
    { claim: claim.claim, claimsDir, key }
  );
  if (!done.ok) {
    if (done.status === "control-committed-unclean") {
      const why = done.why ?? done.reason ?? done.error ?? "committed_unclean";
      if (consumed.status === "absent") {
        try {
          // P1-5a：结构化持久证据（legacy / ledger / action / target_id / request_key / plan_ref / ledger_reason）。
          recordClaimState({
            claimsDir,
            key,
            state: "control-committed-unclean",
            detail: uncleanRecordFields({
              control: intent.control, handle: intent.handle, handleKind: intent.handle_kind, why,
              ledger: done.ledger, intentCleanup: done.intent_cleanup, locks: done.locks,
              changed: done.changed, result: done.result, evidence: done.detail,
            }),
          });
        } catch (err) {
          return { ok: false, status: "control-committed-unclean", reason: "control_committed_unclean", why, ledger: "unclean_unwritten：" + String(err?.code ?? err?.message ?? err), quarantined };
        }
      }
      return { ok: false, status: "control-committed-unclean", reason: "control_committed_unclean", why, text: done.text, quarantined };
    }
    const why = done.reason ?? done.error ?? "?";
    if (consumed.status === "absent") {
      try { recordClaimState({ claimsDir, key, state: "failed", detail: { reason: "control_failed", control: intent.control, error: why } }); }
      catch (err) { return { ok: false, reason: "control_failed", why, ledger: "failed_unwritten：" + String(err?.code ?? err?.message ?? err), quarantined }; }
    }
    return { ok: false, reason: "control_failed", why, text: done.text, quarantined };
  }
  const changed = done.changed !== false;
  try {
    const detail = intent.control === "select"
      ? { control: "select", handle: intent.handle, handle_kind: intent.handle_kind, changed }
      : { control: intent.control, mode: intent.mode, changed };
    recordClaimState({ claimsDir, key, state: "consumed", detail });
  } catch (err) {
    // P1-5b：select 支的 wiring 已确认 legacy+ledger 都提交（done.status === consumed），终态记录写失败
    //   不是「未执行」—— 而是 control-committed-unclean（detail.legacy/ledger=committed，why=终态记录写失败），
    //   回执按 unclean 口径，记录可被 repair 读到。
    if (intent.control === "select" && done.ok === true && done.status === "consumed") {
      const why = "终态记录写失败（legacy 与 ledger 均已提交）：" + String(err?.code ?? err?.message ?? err);
      const evidence = done.detail ?? null;
      // P1-5b（返修五）：**先把 unclean 记录写下来**（repair 才读得到）——旧码只返回一个 unclean 对象，
      //   盘上什么都没有，repair 无从下手（而 consumed 已被证明写不进）。写不成才降级为 unclean_unwritten。
      let unwritten = evidence === null ? "missing_evidence" : null;
      if (unwritten === null) {
        try {
          recordClaimState({
            claimsDir,
            key,
            state: "control-committed-unclean",
            detail: uncleanRecordFields({
              control: intent.control, handle: intent.handle, handleKind: intent.handle_kind, why,
              ledger: "committed", intentCleanup: "unclear", locks: done.locks,
              changed: done.changed, result: done.result, evidence,
            }),
          });
        } catch (err2) {
          unwritten = String(err2?.code ?? err2?.message ?? err2);
        }
      }
      return {
        ok: false,
        status: "control-committed-unclean",
        reason: "control_committed_unclean",
        why,
        detail: evidence,
        // 文案分两支：写成了才说「可由 repair 按 plan 收尾」；写不成必须说清**无法自动恢复**。
        text: unwritten === null
          ? "已写入但收口不干净（" + why + "）——unclean 记录已落盘，可由 repair 按 plan 收尾"
          : "已写入但收口不干净（" + why + "）——unclean 记录也写不成（" + unwritten + "）：无法自动恢复，请人工核对账本与该 claim 目录（不要删）",
        ledger: unwritten === null ? "committed" : "unclean_unwritten：" + unwritten,
        intent_cleanup: "unclear",
        locks: done.locks ?? null,
        quarantined,
      };
    }
    return { ok: false, reason: "ledger_unwritten", why: String(err?.code ?? err?.message ?? err), changed, resumed: replay, quarantined };
  }
  const cleaned = cleanupConsumedResidue({ claimsDir, key });
  // R57b：执行器的成功文案随终态带出（select rfh 支回执用；mode 支 done.text 恒缺省，行为不变）。
  return { ok: true, intent, changed, text: done.text ?? null, resumed: replay, replayed: false, residueUncleared: cleaned.uncleared, residueUnknown: cleaned.unknown, quarantined };
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
/**
 * R57d 对齐 P1-5：unclean 与 consumed / failed 记录共存 = 状态机自相矛盾 —— 两个读取器
 * （盘点 inspectControlClaim / 恢复 resumeControlClaim）共用这一份判据，不放行、不静默择一。
 */
function uncleanCoexistence(unclean, consumed, failed) {
  return unclean.status === "valid" && (consumed.status !== "absent" || failed.status !== "absent");
}

export function inspectControlClaim({ claimsDir, key, expect = {} }) {
  const claim = readClaimState({ claimsDir, key, expect });
  if (claim.status !== "valid") return { state: "claim_" + claim.status, why: claim.why ?? null };
  const intent = claim.claim.control;
  if (intent === undefined) return { state: "not_control" };
  const consumed = readConsumedRecord({ claimsDir, key });
  const failed = readControlFailedRecord({ claimsDir, key });
  const unclean = readControlCommittedUncleanRecord({ claimsDir, key });
  const listed = listControlSidecars({ claimsDir, key });
  const extras = listed.status === "listed"
    ? { residue: listed.residue, quarantined: listed.quarantined, listingProblem: null }
    : { residue: null, quarantined: null, listingProblem: listed.why };
  if (consumed.status !== "absent" && failed.status !== "absent") return { state: "conflict", intent, why: jointWhy(failed, consumed), ...extras };
  // R57d 对齐 P1-5：unclean 与终态记录共存也是矛盾 —— 归入 conflict（why 点名 select_state_conflict），不静默择一。
  if (uncleanCoexistence(unclean, consumed, failed)) {
    return { state: "conflict", intent, why: "select_state_conflict：unclean 与 " + (consumed.status !== "absent" ? "consumed" : "failed") + " 记录共存 —— 状态机自相矛盾，人工核对", ...extras };
  }
  if (consumed.status === "unreadable") return { state: "consumed_unreadable", intent, why: consumed.why, ...extras };
  if (consumed.status === "valid") {
    const cIntent = intentFromConsumedRecord(consumed.record);
    return sameControlIntent(intent, cIntent)
      ? { state: "consumed", intent, record: consumed.record, ...extras }
      : { state: "mismatch", intent, why: "consumed 的意图（" + intentTarget(consumed.record) + "）与 claim 的意图（" + intentTarget(intent) + "）不一致", ...extras };
  }
  if (failed.status === "valid") return { state: "failed", intent, record: failed.record, ...extras };
  if (failed.status === "unreadable") return { state: "failed_unreadable", intent, why: failed.why, ...extras };
  if (unclean.status === "valid") return { state: "control-committed-unclean", intent, record: unclean.record, ...extras };
  if (unclean.status === "unreadable") return { state: "control_committed_unclean_unreadable", intent, why: unclean.why, ...extras };
  return { state: "in_flight", intent, ...extras };
}

/** 维护入口允许续做的状态 —— 唯一一份，两条链的 CLI 都引用它。 */
export const RESUMABLE_CONTROL_STATES = Object.freeze(["in_flight", "consumed_unreadable", "failed_unreadable", "control-committed-unclean"]);
/**
 * 维护入口的恢复动作：锁外先看一眼状态（拒掉明显不该动的），真正的判定与动作都交给锁内的事务：
 *   · consumed：不执行，锁内再清一次残骸（清不掉 / 枚举不了照样带回）；
 *   · 可续做态：走 runControlTransaction(replay)，隔离、执行、记账都在锁内；锁内若发现已被别的事务补上（如 failed 受验），按锁内结果返回。
 */
export function resumeControlClaim({ claimsDir, key, execute, expect = {} }) {
  // **整段在锁内**，不带任何锁外快照：身份（expect）、控制意图、consumed / failed 联合状态都以锁内刚读出的为准。
  return withControlLock({ claimsDir, key }, () => {
    const claim = readClaimState({ claimsDir, key, expect });
    if (claim.status !== "valid") return { ok: false, reason: "claim_" + claim.status, why: claim.why ?? null };
    const intent = claim.claim.control;
    if (intent === undefined) return { ok: false, reason: "not_control", why: null };
    const consumed = readConsumedRecord({ claimsDir, key });
    const failed = readControlFailedRecord({ claimsDir, key });
    const unclean = readControlCommittedUncleanRecord({ claimsDir, key });
    const listed = listControlSidecars({ claimsDir, key });
    const quarantined = listed.status === "listed" ? listed.quarantined : [];
    if (consumed.status !== "absent" && failed.status !== "absent") return { ok: false, reason: "conflict", why: jointWhy(failed, consumed) };
    // R57d 对齐 P1-5：unclean 与终态记录共存 → select_state_conflict 不放行（判据与盘点共用一份）。
    if (uncleanCoexistence(unclean, consumed, failed)) {
      return { ok: false, reason: "select_state_conflict", why: "unclean 与 " + (consumed.status !== "absent" ? "consumed" : "failed") + " 记录共存（状态机自相矛盾），不放行，人工核对" };
    }
    if (consumed.status === "valid") {
      const cIntent = intentFromConsumedRecord(consumed.record);
      if (!sameControlIntent(intent, cIntent)) {
        return { ok: false, reason: "mismatch", why: "consumed 的意图（" + intentTarget(consumed.record) + "）与 claim 的意图（" + intentTarget(intent) + "）不一致" };
      }
      // 已闭合：只清同 key 的临时残骸 —— 也只在锁内确认 claim 仍属于当前身份、consumed 仍完整一致之后才清
      const cleaned = cleanupConsumedResidue({ claimsDir, key });
      return { ok: true, already: true, changed: consumed.record.changed, intent, residueUncleared: cleaned.uncleared, residueUnknown: cleaned.unknown, quarantined };
    }
    if (failed.status === "valid") return { ok: false, reason: "failed", why: null };
    if (unclean.status === "valid") {
      // 专用恢复路径（R57b P1-4）：重读账本核已提交 → 只做清理/释放收尾 → 转 consumed；核不出 → 保持并点名
      const tx = execute(
        intent.control === "select" ? intent : intent.control === "mode" ? intent.mode : intent,
        { claim: claim.claim, claimsDir, key, uncleanRecord: unclean.record }
      );
      if (!tx.ok) {
        // R57d 返修六 P1-2：保持 unclean 时把**最新证据**写回记录（追加 repair_attempts，不覆盖原始证据）——
        //   否则下次 repair 读到的还是旧证据，残骸清没清、清了几次都留不下痕迹。
        if (tx.ledger_evidence) {
          try {
            const prev = unclean.record;
            const attempts = Array.isArray(prev.repair_attempts) ? prev.repair_attempts : [];
            attempts.push({
              at: new Date().toISOString(),
              reason: String(tx.reason ?? "control_committed_unclean"),
              commit: tx.ledger_evidence.commit ?? "unknown",
              residue: Array.isArray(tx.ledger_evidence.residue) ? tx.ledger_evidence.residue : [],
              lock_uncleared: tx.ledger_evidence.lock_uncleared === true,
            });
            recordClaimState({ claimsDir, key, state: "control-committed-unclean",
              detail: { ...prev, detail: { ...prev.detail, ledger_evidence: tx.ledger_evidence }, repair_attempts: attempts } });
          } catch { /* 写不回不算失败：原始记录还在，下一次 repair 还会再撞一次 */ }
        }
        return { ok: false, status: tx.status ?? "control-committed-unclean", reason: tx.reason, why: tx.why, quarantined };
      }
      const changed = tx.changed !== false;
      try {
        const detail = intent.control === "select"
          ? { control: "select", handle: intent.handle, handle_kind: intent.handle_kind, changed }
          : { control: intent.control, mode: intent.mode, changed };
        recordClaimState({ claimsDir, key, state: "consumed", detail });
        try { fs.unlinkSync(path.join(claimsDir, key + ".control-committed-unclean.json")); } catch {}
      } catch (err) {
        return { ok: false, reason: "ledger_unwritten", why: String(err?.code ?? err?.message ?? err), changed, quarantined };
      }
      const cleaned = cleanupConsumedResidue({ claimsDir, key });
      return { ok: true, intent, changed, text: tx.text ?? null, resumed: true, replayed: false, residueUncleared: cleaned.uncleared, residueUnknown: cleaned.unknown, quarantined };
    }
    // consumed 缺席 / 损坏、failed 缺席 / 损坏：可续做 —— 同一把锁里跑事务核心（不再取锁）
    const tx = runLockedTransaction({ claimsDir, key, intent: null, execute, replay: true, expect });
    return tx.ok
      ? { ok: true, already: false, changed: tx.changed, intent: tx.intent, residueUncleared: tx.residueUncleared ?? [], residueUnknown: tx.residueUnknown ?? null,
        quarantined: [...quarantined, ...(tx.quarantined ?? [])] }
      : { ok: false, reason: tx.reason, why: tx.why, quarantined: tx.quarantined ?? [] };
  });
}

const MODE_LABEL = {
  [DIALOGUE_POLICY_ID]: "Dialogue（单主持者·串行；默认 12 轮 / 2 小时 / 12 资源单位）",
  [MAPPING_POLICY_ID]: "Mapping（一次输入对应一次运行）",
};

/** 回执正文：说清切到了什么、是不是本来就是、这条不是指令；重放 / 续做也说清。 */
export function controlAckText({ taskName, mode, changed, replayed = false, resumed = false, lockUncleared = null }) {
  const head = replayed ? "已处理过 · " : resumed ? "已补齐 · " : changed ? "已切换 · " : "模式未变 · ";
  const body = replayed
    ? "这条控制命令之前已经执行过（" + (changed ? "当时完成了切换" : "当时模式未变") + "）；当时目标模式是 " + (MODE_LABEL[mode] ?? mode) + "，本次没有再次切换。"
    : resumed
      ? "上次执行后终态没记下，这次已补齐；交互模式是 " + (MODE_LABEL[mode] ?? mode) + "。"
      : (changed ? "交互模式现在是 " : "本来就是 ") + (MODE_LABEL[mode] ?? mode) + "。";
  const lockNote = lockUncleared ? "注意：这一笔的事务锁没有交还（" + lockUncleared + "），之后同一笔会报 control_busy；请人工确认后删除锁目录。" : null;
  return [head + taskName, body, "本条是控制命令，没有被当作指令投递。", ...(lockNote ? [lockNote] : [])].join("\n");
}
