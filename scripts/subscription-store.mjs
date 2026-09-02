/**
 * FR-2.6 单 1：订阅控制面落盘对象（store）+ 唯一写事务。
 *
 * 为什么要有独立存储：今天「订阅」只是投影（buildLegacySubscriptionReadModel，
 * scripts/subscription.mjs:99-190），从模板 + 登记表算出来，控制面没有
 * 「创建 / 暂停 / 删除订阅」的落盘对象。提案 A（2026-09-01 拍板；2026-09-02 评审 #112
 * 裁决修订：schema 升 1.1 加可选 instance_key，1.0 legacy 并行合法）：多群 = 同域多条订阅，
 * 同四元组多条用 instance_key 区分；本模块只做控制面存储与受控写入口，
 * 不做认领 / 路由切流 —— 热路径（inbound-route / inbound 的 selector 逻辑）不碰，
 * 生产调用方也还没把 store 接进投影（那是切流单的事）。
 *
 * 文件形状：单文件 JSON（默认 ~/.claude/feishu-bridge/subscriptions.json，由调用方传
 * 绝对路径），{ schema_version, artifact_type, subscriptions: [Subscription v1 …] }。
 * 条目就是 Subscription v1 对象本身（validateSubscription 逐条守），不加包装字段 ——
 * 这样「控制面对象与 legacy 投影同 id 对齐」（§3.3-1）之后可以直接互换。
 *
 * 读取方合并必须 fail-closed（评审 #112 定案）：文件损坏 → loadSubscriptionStore 报 problems，
 * 投影合并**拒绝整个读模型**（ok:false / control_plane_invalid，legacy 只作展示诊断附带）——
 * 退回纯 legacy 是 fail-open：暂停 / 收紧过的订阅会在文件损坏时重新开放。
 * 缺席（还没装订阅管理）与空 store 才兼容 legacy（buildLegacySubscriptionReadModel 的 controlPlane 参数）。
 *
 * 写事务完全镜像 withChainTemplateWrite（scripts/chain-template.mjs:274-322，模板唯一
 * 写事务的纪律：锁内重读重算 → 校验 → 备份 → 临时文件 + rename 原子写 → 逐字读回；
 * 锁没交还要在结果里带 lockUncleared）。不复用那个函数本身，因为它把
 * loadChainTemplate / validateChainTemplate 写死在校验位上 —— 这里存的是订阅条目，
 * 校验器是 validateSubscription。锁原语与 routes / registry / template 同一套 symlink 锁。
 *
 * FR-2.6 单 4（审计）：每次成功的变更在锁释放前向 `<store>.audit.jsonl` 追加一行
 * （受验 fd 循环写满，append-only；评审 #115 P1-1 起加 O_NOFOLLOW|O_NONBLOCK、同 fd fstat
 * 单硬链接核验，P1-2 二轮把 operation_id 纳入封闭事件形状）：{ schema_version, operation_id,
 * at, action, subscription_id, version_after, store_bytes_sha256（写盘后整文件哈希前 16）}。
 * **不夹带敏感值**：不写 chat_name / sender_ids 明细，id 与 action 已够对账。审计写失败不回滚
 * store（变更已成立），结果带 auditUnwritten，CLI 据此退非零 —— 成功但要人知道，
 * 不是静默成功。幂等（changed:false）与拒绝不写行；同一事务只写一行。
 * loadSubscriptionAudit 是只读对账入口（坏行计入 problems 不吞），本单不接展示。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquirePublishLock, commitWhileHeld, releasePublishLock } from "./registry.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
import { senderTable } from "./sender-roles.mjs";
import {
  CHAT_NAME_MAX_LENGTH, INSTANCE_KEY_SHAPE, MESSAGE_RECEIVE_EVENT, SUBSCRIPTION_ARTIFACT_TYPE,
  SUBSCRIPTION_SCHEMA_VERSION, SUBSCRIPTION_SCHEMA_VERSION_KEYED,
  legacyEndpointId, mergeControlPlaneIntoModel, stableControlId, subscriptionIdFor, validateSubscription,
} from "./subscription.mjs";

export const SUBSCRIPTION_STORE_SCHEMA_VERSION = "1.0";
export const SUBSCRIPTION_STORE_ARTIFACT_TYPE = "feishu_bridge_subscription_store";
export const SUBSCRIPTION_RUNTIMES = ["claude", "codex"];

/**
 * 订阅的控制面 id：与投影同一套派生，公式唯一实现在 subscriptionIdFor（subscription.mjs）——
 * 无 instance_key（1.0 legacy）= ("subscription", endpointId, domainId, chatId, agent_uid)；
 * 有 instance_key（1.1 keyed）追加 "instance:"+key（评审 #112 裁决：同四元组多条并存的区分位）。
 * 同一 (链, 域, 群, agent[, key]) 在两边算出同一个 id，合并时按 id 对齐。
 */
export function subscriptionControlId({ runtime, agentUid, domainKey, chatId, instanceKey = null }) {
  const endpointId = legacyEndpointId({ runtime, agentUid });
  const domainId = stableControlId("domain", runtime, domainKey);
  return subscriptionIdFor({ endpointId, domainId, chatId, agentUid, instanceKey });
}

/**
 * 读 store。fail-closed：任何说不清的地方都进 problems，调用方不许把半信半疑的
 * 条目当真。文件缺席不是问题（= 还没装订阅管理，纯 legacy 世界）。
 */
export function loadSubscriptionStore({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, problems: ["file_required_absolute"] };
  // fd 绑定读（评审 PR #112 P1）：O_NOFOLLOW|O_NONBLOCK 打开、同 fd fstat 确认普通**单硬链接**
  // 文件、从这个 fd 读 —— 符号链接 / FIFO / 目录 / 硬链接别名都说不清。受验开共用一份判据。
  const opened = openVerifiedSubscriptionFile({ file });
  if (opened.absent) return { ok: true, absent: true, subscriptions: [] };
  if (!opened.ok) return { ok: false, problems: [opened.reason] };
  let raw;
  try { raw = fs.readFileSync(opened.fd, "utf-8"); }
  catch (err) { try { fs.closeSync(opened.fd); } catch { /* 已关 */ } return { ok: false, problems: ["store_unreadable:" + String(err.code ?? err.message)] }; }
  try { fs.closeSync(opened.fd); } catch { /* 已关 */ }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { return { ok: false, problems: ["store_bad_json:" + err.message] }; }
  const problems = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problems: ["store_not_object"] };
  // 顶层封闭形状（评审 PR #112 P1）：多余的键说不清 —— 落盘对象的入口不许比写方能产出的集合大
  for (const k of Object.keys(parsed)) {
    if (!["schema_version", "artifact_type", "subscriptions"].includes(k)) problems.push("extra:" + k);
  }
  if (parsed?.schema_version !== SUBSCRIPTION_STORE_SCHEMA_VERSION) problems.push("schema_version");
  if (parsed?.artifact_type !== SUBSCRIPTION_STORE_ARTIFACT_TYPE) problems.push("artifact_type");
  if (!Array.isArray(parsed?.subscriptions)) problems.push("subscriptions");
  if (problems.length) return { ok: false, problems };
  const seen = new Set();
  const subscriptions = [];
  for (const entry of parsed.subscriptions) {
    const valid = validateSubscription(entry);
    if (!valid.ok) { problems.push("subscription:" + (entry?.subscription_id ?? "?") + ":" + valid.problems.join(",")); continue; }
    if (seen.has(entry.subscription_id)) { problems.push("duplicate:" + entry.subscription_id); continue; }
    seen.add(entry.subscription_id);
    subscriptions.push(entry);
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, absent: false, subscriptions };
}

/**
 * 生产默认 store 路径。四条展示入口（两条链 subscribe + 两条链 status）共用；
 * 有 HOME 沙箱的测试里 os.homedir() 指向沙箱，落盘位置随之走。
 */
export function subscriptionStorePath({ home = os.homedir() } = {}) {
  return path.join(home, ".claude", "feishu-bridge", "subscriptions.json");
}

/**
 * **展示层的共用合并帮手**（评审 #114 P1：四个入口曾各写一份「读 store + 合并 + 损坏退 legacy」）。
 * 输入已建好的 legacy 读取模型（用哪条链的 builder 由调用方决定），内部读生产默认 store，
 * 走 mergeControlPlaneIntoModel 同一条合并路径（含 endpoint 隔离与损坏 fail-closed）。
 * 文件缺席 = 今天：返回 { view: legacy, corrupt: null }，输出与 legacy 模型逐字节一致。
 * 损坏不崩：返回 { view: legacy, corrupt: problems }，调用方据此注明「已按 legacy 显示」。
 * 热路径（认领 / 路由）一行不碰 —— 它永远只吃原模型，不进这里。
 */
export function mergedSubscriptionView({ legacy } = {}) {
  const store = loadSubscriptionStore({ file: subscriptionStorePath() });
  // 评审 #114 二轮 P1：legacy 投影自身失败（legacy.ok !== true —— 未绑定 / 登记表损坏 / 投影失败）时，
  // **不能用控制面单独重建模型**：合并器对 model.subscriptions.map 会裸抛。fail-closed ——
  // 保留失败投影原样（view 仍是该失败投影、reason 不变），只在 store 损坏时连带 corrupt 供展示注明；
  // store 缺席 / 合法时 corrupt 为 null。legacy 合法时走下面的合并 / 损坏-fail-closed 路径，行为不变。
  if (legacy?.ok !== true) {
    return { view: legacy, corrupt: (!store.absent && !store.ok) ? (store.problems ?? null) : null };
  }
  if (store.absent) return { view: legacy, corrupt: null };
  const merged = mergeControlPlaneIntoModel(legacy,
    store.ok ? { ok: true, subscriptions: store.subscriptions } : { ok: false, problems: store.problems });
  return merged.ok
    ? { view: merged, corrupt: null }
    : { view: merged.legacy ?? legacy, corrupt: merged.problems ?? null };
}

export const SUBSCRIPTION_AUDIT_SCHEMA_VERSION = "1.0";
const SUBSCRIPTION_AUDIT_ACTIONS = ["add", "pause", "resume", "remove"];
// 评审 #115 二轮 P1-1：operation_id 纳入审计事件封闭形状（非空字符串），去重按它（不按 after 哈希）。
const SUBSCRIPTION_AUDIT_KEYS = ["schema_version", "operation_id", "at", "action", "subscription_id", "version_after", "store_bytes_sha256"];
const STORE_HASH16 = /^[0-9a-f]{16}$/u;
// 审计内容整文件哈希（64 位小写十六进制）—— pending 记录追加前的基线，恢复时按它核前缀（P1-3）。
const AUDIT_SHA256 = /^[0-9a-f]{64}$/u;
// 空审计（从未写 / 读不齐当空）的基线哈希：sha256("")。
const EMPTY_AUDIT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// 评审 #121 二轮（收口）：operation_id 锚定为**写方唯一真实格式**（评审建议的联合形状收到极致）——
// `op-` + toISOString 的冒号点换连字符（**保留大写 T/Z**，与已落盘的旧生产格式逐字兼容）+ 8 位小写
// hex。精确锚定天然排除 locator 前缀与控制字符，且任何合法 id 满足 displaySafe(id) === id 不变量
//（doctor 回显不会被省略成不可执行的命令）。
const OPERATION_ID_RE = /^op-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/u;
const operationIdProblem = (v) =>
  typeof v !== "string" || v.trim() === "" ? "empty"
    : !OPERATION_ID_RE.test(v) ? "shape" : null;

/**
 * 审计行的**唯一封闭校验器**（评审 #115 P1-2）。写方（追加时构造的行）与读方
 * （loadSubscriptionAudit 逐行）用同一把判据 —— 不许两份：写前自校验、读时逐行校验，
 * 各处对「什么样是一行合法审计」完全一致。
 * 封闭：精确键集（多余 / 缺失都拒）、schema "1.0"、非空 operation_id、规范 ISO 时间、action 枚举、
 * 非空 subscription_id、store_bytes_sha256 为 16 位小写十六进制、version_after 与
 * action 联合约束（remove 为 null，其余为正整数）。
 */
export function validateSubscriptionAuditEvent(event) {
  const problems = [];
  if (event === null || typeof event !== "object" || Array.isArray(event)) return { ok: false, problems: ["shape_invalid"] };
  for (const k of Object.keys(event)) if (!SUBSCRIPTION_AUDIT_KEYS.includes(k)) problems.push("extra:" + k);
  for (const k of SUBSCRIPTION_AUDIT_KEYS) if (!Object.hasOwn(event, k)) problems.push("missing:" + k);
  const has = (k) => Object.hasOwn(event, k);
  if (has("schema_version") && event.schema_version !== SUBSCRIPTION_AUDIT_SCHEMA_VERSION) problems.push("schema_version");
  if (has("at") && !isCanonicalIso(event.at)) problems.push("at_not_canonical");
  if (has("action") && !SUBSCRIPTION_AUDIT_ACTIONS.includes(event.action)) problems.push("action:" + String(event.action));
  if (has("operation_id")) { const opProblem = operationIdProblem(event.operation_id); if (opProblem) problems.push(opProblem === "empty" ? "operation_id_empty" : "operation_id_shape"); }
  if (has("subscription_id") && (typeof event.subscription_id !== "string" || event.subscription_id.trim() === "")) problems.push("subscription_id_empty");
  if (has("store_bytes_sha256") && (typeof event.store_bytes_sha256 !== "string" || !STORE_HASH16.test(event.store_bytes_sha256))) problems.push("store_bytes_sha256");
  if (has("version_after")) {
    if (event.action === "remove") { if (event.version_after !== null) problems.push("version_after_not_null"); }
    else if (!Number.isInteger(event.version_after) || event.version_after <= 0) problems.push("version_after_not_positive");
  }
  return { ok: problems.length === 0, problems };
}

/** 写方唯一的审计行构造器：写前用 validateSubscriptionAuditEvent 自校验（同一把判据）。
 * operation_id 是这次变更的身份（去重键），写进事件行本身。 */
export function buildSubscriptionAuditEvent({ at, action, subscriptionId, versionAfter, storeBytesSha256, operationId }) {
  return {
    schema_version: SUBSCRIPTION_AUDIT_SCHEMA_VERSION,
    operation_id: operationId,
    at,
    action,
    subscription_id: subscriptionId,
    version_after: versionAfter,
    store_bytes_sha256: storeBytesSha256,
  };
}

const SUBSCRIPTION_AUDIT_PENDING_SCHEMA = "1.0";
// 评审 #115 二轮：pending 记录追加前的审计基线（size/hash，P1-3），并把 operation_id 与事件行一致起来。
const SUBSCRIPTION_AUDIT_PENDING_KEYS = ["schema_version", "operation_id", "before_sha256", "after_sha256", "audit_size_before", "audit_sha256_before", "event"];

function validateAuditPending(p) {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return { ok: false, problems: ["shape_invalid"] };
  const problems = [];
  for (const k of Object.keys(p)) if (!SUBSCRIPTION_AUDIT_PENDING_KEYS.includes(k)) problems.push("extra:" + k);
  for (const k of SUBSCRIPTION_AUDIT_PENDING_KEYS) if (!Object.hasOwn(p, k)) problems.push("missing:" + k);
  const has = (k) => Object.hasOwn(p, k);
  if (has("schema_version") && p.schema_version !== SUBSCRIPTION_AUDIT_PENDING_SCHEMA) problems.push("schema_version");
  if (has("operation_id")) { const opProblem = operationIdProblem(p.operation_id); if (opProblem) problems.push(opProblem === "empty" ? "operation_id" : "operation_id_shape"); }
  if (has("operation_id") && has("event") && typeof p.event === "object" && p.event !== null && !Array.isArray(p.event) && p.operation_id !== p.event.operation_id) problems.push("operation_id_mismatch");
  if (has("after_sha256") && (typeof p.after_sha256 !== "string" || !STORE_HASH16.test(p.after_sha256))) problems.push("after_sha256");
  if (has("before_sha256") && p.before_sha256 !== null && (typeof p.before_sha256 !== "string" || !STORE_HASH16.test(p.before_sha256))) problems.push("before_sha256");
  if (has("audit_size_before") && (!Number.isInteger(p.audit_size_before) || p.audit_size_before < 0)) problems.push("audit_size_before");
  if (has("audit_sha256_before") && (typeof p.audit_sha256_before !== "string" || !AUDIT_SHA256.test(p.audit_sha256_before))) problems.push("audit_sha256_before");
  const ev = validateSubscriptionAuditEvent(p.event);
  if (!ev.ok) problems.push("event:" + ev.problems.join(","));
  return { ok: problems.length === 0, problems };
}

export function validateSubscriptionAuditPending(p) {
  const v = validateAuditPending(p);
  return v;
}

/** 待补记文件路径：<store>.audit.pending.json。 */
export function subscriptionAuditPendingPath(file) {
  return file + ".audit.pending.json";
}

/**
 * 审计 jsonl 的只读对账入口（本单只给函数 + 测试，不接展示；以后 doctor / 展示用）。
 *
 * fd 绑定读（open 一次、从 fd 读全部，不在路径上二猜）+ O_NONBLOCK + 同 fd fstat 单硬链接核验
 * （评审 #115 P1-2：loader 也守与写同款的非普通文件边界）。坏行不吞：逐行用
 * validateSubscriptionAuditEvent（与写方同一把判据），说不清的行计入 problems（带行号），
 * 好行照常返回 —— 对账时宁可冗余也不静默丢。文件缺席 = 还没变更过（absent）。
 */
/**
 * 共享审计 jsonl 解码（评审 #115 三轮 P2-1）：把「受验读取、完整行、事件封闭、operation_id 唯一」
 * 这一整组判据收成一处，loadSubscriptionAudit（对账：坏行进 problems 不吞、好行照常返回）与
 * auditBaselineState（fail-closed 基线）共用 —— 不再各写一份、更不许 loader 漏报尾巴无换行 / 重复 op id。
 *
 * 返回值对「能否读」与「内容是否干净」分开表达：
 *   - 硬读错（缺席 / 非普通文件 / 符号链接 / IO）→ { ok:false, reason, detail }
 *     或 { ok:true, absent:true, events:[], problems:[], size:0, sha256 }；
 *   - 读成功（含 integrity 问题）→ { ok:true, absent:false, events, problems, size, sha256, firstBad }
 *     firstBad = { kind, line?, op?, problems? } 是**第一个** integrity 问题，给 fail-closed 方做 detail。
 * @returns {{ ok:boolean, absent:boolean, events:object[], problems:string[], size:number, sha256:string, firstBad?:object, reason?:string, detail?:string }}
 */
function decodeAuditJsonl({ file } = {}) {
  const auditFile = file + ".audit.jsonl";
  let afd;
  try {
    afd = fs.openSync(auditFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true, events: [], problems: [], size: 0, sha256: EMPTY_AUDIT_SHA256 };
    return { ok: false, reason: "audit_not_regular_file", detail: err.code === "ELOOP" ? "是符号链接（别名）；请用真实路径" : "不是普通文件" };
  }
  let content;
  try {
    const st = fs.fstatSync(afd);
    if (!st.isFile()) return { ok: false, reason: "audit_not_regular_file", detail: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, reason: "audit_not_regular_file", detail: "有 " + st.nlink + " 个目录项（硬链接别名）" };
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(afd, buf, 0, buf.length, null);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    content = Buffer.concat(chunks);
  } catch (err) {
    return { ok: false, reason: "audit_unreadable", detail: String(err.code ?? err.message) };
  } finally { try { fs.closeSync(afd); } catch { /* 已关 */ } }
  const events = [];
  const problems = [];
  let firstBad = null;
  // 完整行：非空就必须以换行结尾（P2-1：loader 也要报，不是只 baseline 守）。
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    problems.push("tail:not_newline_terminated");
    firstBad = { kind: "tail_not_newline" };
  }
  const lines = content.toString("utf-8").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    let event = null;
    try { event = JSON.parse(raw); }
    catch { const p = "line:" + (i + 1) + ":json_invalid"; problems.push(p); if (firstBad === null) firstBad = { kind: "json_invalid", line: i + 1 }; continue; }
    const v = validateSubscriptionAuditEvent(event);
    if (!v.ok) {
      const p = "line:" + (i + 1) + ":" + v.problems.join(",");
      problems.push(p);
      if (firstBad === null) firstBad = { kind: "event_invalid", line: i + 1, problems: v.problems };
      continue;
    }
    if (seen.has(event.operation_id)) {
      const p = "duplicate_operation_id:" + event.operation_id;
      problems.push(p);
      if (firstBad === null) firstBad = { kind: "duplicate_op", op: event.operation_id };
      continue;
    }
    seen.add(event.operation_id);
    events.push(event);
  }
  return { ok: true, absent: false, events, problems, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex"), firstBad };
}

/**
 * 审计 jsonl 的只读对账入口（本单只给函数 + 测试，不接展示；以后 doctor / 展示用）。
 *
 * 共享 decodeAuditJsonl：受验读取 + 完整行 + 事件封闭 + operation_id 唯一的判据全部落在解码器里。
 * 坏行不吞：说不清的行计入 problems（带行号），好行照常返回 —— 对账时宁可冗余也不静默丢。
 * 文件缺席 = 还没变更过（absent）。返回 { ok, absent, events, problems } 保持兼容形状。
 */
export function loadSubscriptionAudit({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_file_required_absolute" };
  const d = decodeAuditJsonl({ file });
  if (!d.ok) return { ok: false, reason: d.reason, detail: d.detail };
  return { ok: d.problems.length === 0, absent: d.absent, events: d.events, problems: d.problems };
}

/** 受验 fd 追加一行（评审 #115 P1-2 二轮 P2-1）：**打开文件前先强制唯一封闭校验** —— 共享的导出品不许漏验，
 * 任意外部调用都过同一把判据。随后 O_NOFOLLOW|O_NONBLOCK、同 fd fstat 单硬链接、Buffer 循环写满
 * （<=0 为 ESHORTWRITE）、fsync。失败抛错由调用方接。 */
export function appendSubscriptionAuditLine({ file, event } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("audit_file_required_absolute");
  const v = validateSubscriptionAuditEvent(event);
  if (!v.ok) throw new Error("audit_invalid:" + v.problems.join(","));
  const auditFile = file + ".audit.jsonl";
  const line = JSON.stringify(event) + "\n";
  const afd = fs.openSync(auditFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const st = fs.fstatSync(afd);
    if (!st.isFile()) throw new Error("not_a_regular_file");
    if (st.nlink !== 1) throw new Error("multiple_links:" + st.nlink);
    const buf = Buffer.from(line, "utf-8");
    let off = 0;
    while (off < buf.length) { const n = fs.writeSync(afd, buf, off); if (n <= 0) throw new Error("ESHORTWRITE:" + n); off += n; }
    fs.fsyncSync(afd);
  } finally { try { fs.closeSync(afd); } catch { /* 已关 */ } }
}

/** 受验打开订阅 store（fd 绑定读，评审 #112 P1 纪律，与 store 内容解读解耦）：
 * O_NOFOLLOW|O_NONBLOCK 打开、同 fd fstat 必须是普通**单硬链接**文件。判定结果**封闭三态**：
 *   - { absent:true }          —— 只有 ENOENT（文件确实不存在，首次写前的状态）；
 *   - { ok:true, fd }          —— 受验读成功，调用方继续从 fd 读内容（解读/校验交给调用方）；
 *   - { ok:false, reason }     —— 其余全部（符号链接 / FIFO / 目录 / 硬链接别名 / EACCES / fstat/读错）。
 * loadSubscriptionStore 与 storeHashState 共用，保证「读不清」这一判据只有一份（评审 #115 五轮 P1）。 */
function openVerifiedSubscriptionFile({ file }) {
  let fd = null;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
  catch (err) {
    if (err.code === "ENOENT") return { absent: true };
    return { ok: false, reason: "store_unreadable:" + (err.code === "ELOOP" ? "symlink" : String(err.code ?? err.message)) };
  }
  let st;
  try { st = fs.fstatSync(fd); }
  catch (err) { try { fs.closeSync(fd); } catch { /* 已关 */ } return { ok: false, reason: "store_unreadable:fstat:" + String(err.code ?? err.message) }; }
  if (!st.isFile()) { try { fs.closeSync(fd); } catch { /* 已关 */ } return { ok: false, reason: "store_unreadable:不是普通文件" }; }
  if (st.nlink !== 1) { try { fs.closeSync(fd); } catch { /* 已关 */ } return { ok: false, reason: "store_unreadable:有 " + st.nlink + " 个目录项（硬链接别名）" }; }
  return { ok: true, fd };
}

/** 当前订阅 store 的**封闭三态**哈希判定（评审 #115 五轮 P1，修掉旧 currentStoreHash 的缺洞）：
 *   - absent      —— 只有 ENOENT（文件确实不存在），调用方按「首次写前」处理（before_sha256:null 照旧）；
 *   - valid       —— 受验读成功（O_NOFOLLOW|O_NONBLOCK + 同 fd fstat 普通单硬链接），携带 sha256 前 16 位；
 *   - unreadable  —— 其余全部（符号链接 / FIFO / 目录 / 硬链接别名 / EACCES / I/O 错），带 reason/detail，
 *      调用方必须 fail-closed；**不许把「读不清」折成 null** —— 旧实现把 ENOENT 与读不清折叠成同一个 null，
 *      当 before_sha256 也是 null（首次写待补记）时被误判成「首次写未提交」而误清 pending（评审复现场景）。
 * 返回 { state:"absent" } | { state:"valid", sha256 } | { state:"unreadable", reason, detail }。 */
export function storeHashState({ file }) {
  const opened = openVerifiedSubscriptionFile({ file });
  if (opened.absent) return { state: "absent" };
  if (!opened.ok) return { state: "unreadable", reason: opened.reason, detail: String(opened.reason) };
  const fd = opened.fd;
  let buf;
  try { buf = fs.readFileSync(fd); }
  catch (err) { try { fs.closeSync(fd); } catch { /* 已关 */ } return { state: "unreadable", reason: "store_unreadable:" + String(err.code ?? err.message), detail: String(err.code ?? err.message) }; }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  return { state: "valid", sha256: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) };
}

/** 审计基线**三态**（评审 #115 三轮 P1-1）：absent | valid | unreadable。
 * 只有 ENOENT 投影为空（absent）；非普通文件 / I/O 错误 / 坏行 / 非法事件 / 重复 operation id /
 * 非空但不以 \n 结尾都判 unreadable（audit_baseline_unreadable / audit_baseline_invalid）。
 * 该判定必须在 **store 提交前**做：unreadable → 阻断本次变更（fail-closed），valid 才记 size/sha256
 * 供 pending 记录基线 —— 不再把「读不齐」折成空基线（旧逻辑会把换行已被截掉的审计误当空，恢复时整段截掉）。
 * 返回 { state, size?, sha256? } 或 { state:"unreadable", reason, detail }。 */
function auditBaselineState({ file }) {
  const d = decodeAuditJsonl({ file });
  if (d.absent) return { state: "absent", size: 0, sha256: EMPTY_AUDIT_SHA256 };
  // 硬读错（非普通文件 / 符号链接 / IO）→ 基线 unreadable（fail-closed）。
  if (!d.ok) return { state: "unreadable", reason: "audit_baseline_unreadable", detail: String(d.detail ?? d.reason) };
  if (d.problems.length > 0) {
    const b = d.firstBad ?? { kind: "other" };
    const detail = b.kind === "json_invalid" ? "第 " + b.line + " 行不是合法 JSON"
      : b.kind === "event_invalid" ? "第 " + b.line + " 行校验失败：" + b.problems.join(",")
      : b.kind === "duplicate_op" ? "重复 operation_id：" + b.op
      : b.kind === "tail_not_newline" ? "审计不以换行结尾（可能被拼行截断）"
      : "审计内容不干净";
    return { state: "unreadable", reason: "audit_baseline_invalid", detail };
  }
  return { state: "valid", size: d.size, sha256: d.sha256 };
}

/** fsync 目录项（评审 #115 二轮 P1-5 屏障）：打开目录 O_RDONLY、fsync、关。失败抛错由调用方接。 */
function fsyncDir(dirPath) {
  const dfd = fs.openSync(dirPath, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dfd); } finally { try { fs.closeSync(dfd); } catch { /* 已关 */ } }
}

/** 把审计内容按行解析成事件（去重扫描用）。P2-2：坏行 / 非法事件用**封闭校验器**当判据过滤，
 * 不再只靠 JSON.parse + typeof —— 与「前缀已由基线哈希背书」的前提解耦，把前提变成代码判据。 */
function parseAuditEvents(buf) {
  const events = [];
  for (const line of buf.toString("utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if (validateSubscriptionAuditEvent(ev).ok) events.push(ev); } catch { /* 跳过 */ }
  }
  return events;
}

/** 把待补记写成 <store>.audit.pending.json。评审 #115 二轮 P1-2：**不覆盖发布** —— 用
 * link 到最终路径（EEXIST 即已存在 → 冲突，绝不覆盖已存在的 pending）；写 tmp 后 fsync(tmp)、
 * link、fsyncDir（屏障，P1-5）、再删 tmp。O_NOFOLLOW 开 tmp，满写。失败返回 reason。 */
export function writeSubscriptionAuditPending({ file, pending } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_pending_required_absolute" };
  const v = validateAuditPending(pending);
  if (!v.ok) return { ok: false, reason: "audit_pending_invalid", problems: v.problems };
  const pendingPath = subscriptionAuditPendingPath(file);
  const tmp = pendingPath + ".tmp." + process.pid + "." + crypto.randomBytes(6).toString("hex");
  let wfd = null;
  try {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
    wfd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const buf = Buffer.from(JSON.stringify(pending, null, 2) + "\n", "utf-8");
    let off = 0;
    while (off < buf.length) { const n = fs.writeSync(wfd, buf, off); if (n <= 0) throw new Error("ESHORTWRITE：" + n); off += n; }
    fs.fsyncSync(wfd);
    fs.closeSync(wfd); wfd = null;
    // link 到最终路径：O_EXCL 语义（已存在即 EEXIST → 冲突，不覆盖）。link 原子、fsync 目录形成屏障。
    fs.linkSync(tmp, pendingPath);
    fsyncDir(path.dirname(pendingPath));
    fs.rmSync(tmp, { force: true });
  } catch (err) {
    try { if (wfd !== null) fs.closeSync(wfd); } catch { /* 已关 */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
    return { ok: false, reason: err.code === "EEXIST" ? "audit_pending_exists" : "audit_pending_unwritable", detail: err.message };
  }
  return { ok: true };
}

/** 读待补记。缺席 = 没有未补记的变更。评审 #115 二轮 P1-4：与审计/store 同款受验边界 ——
 * O_NOFOLLOW|O_NONBLOCK、同 fd fstat 单硬链接读，不跟随符号链接、不卡 FIFO。坏形状不吞（problems）。 */
export function loadSubscriptionAuditPending({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_pending_required_absolute" };
  const pendingPath = subscriptionAuditPendingPath(file);
  let pfd;
  try { pfd = fs.openSync(pendingPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true, pending: null, problems: [] };
    return { ok: false, reason: "audit_pending_not_regular_file", detail: err.code === "ELOOP" ? "是符号链接（别名）；请用真实路径" : "不是普通文件" };
  }
  let raw;
  try {
    const st = fs.fstatSync(pfd);
    if (!st.isFile()) return { ok: false, reason: "audit_pending_not_regular_file", detail: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, reason: "audit_pending_not_regular_file", detail: "有 " + st.nlink + " 个目录项（硬链接别名）" };
    const chunks = []; const buf = Buffer.alloc(64 * 1024);
    for (;;) { const n = fs.readSync(pfd, buf, 0, buf.length, null); if (n <= 0) break; chunks.push(Buffer.from(buf.subarray(0, n))); }
    raw = Buffer.concat(chunks).toString("utf-8");
  } catch (err) { return { ok: false, reason: "audit_pending_unreadable", detail: String(err.code ?? err.message) }; }
  finally { try { fs.closeSync(pfd); } catch { /* 已关 */ } }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: "audit_pending_unreadable", detail: "JSON 解析失败" }; }
  const v = validateAuditPending(parsed);
  if (!v.ok) return { ok: false, reason: "audit_pending_invalid", problems: v.problems };
  return { ok: true, absent: false, pending: parsed, problems: [] };
}

/** 删掉待补记（成功补记后调用）。评审 #115 二轮 P1-5：**清理结果不静默** —— 成功 { ok:true }，
 * 失败带 reason（ENOENT 忽略，其它错误如实报）。 */
export function clearSubscriptionAuditPending({ file } = {}) {
  try { fs.rmSync(subscriptionAuditPendingPath(file), { force: true }); return { ok: true }; }
  catch (err) { return { ok: false, reason: String(err.code ?? err.message) }; }
}

/** 显式处理冲突待补记（评审 #115 三轮 P1-2 的维护入口，CLI 不接线）。
 * 冲突时 pending **不改名、原地留存**作为持续 blocker（fail-closed）；只有本入口显式点名 + discard 才清除。
 * 只删与给定 operationId **完全匹配**的 pending；点名错（mismatch）/ 缺席（no_conflict）都拒。
 * discard 必须为 true 才删，否则只是确认（pending 保留）。返回 { ok, resolved?, kept? }。 */
/**
 * 待补记**只读**分类（评审 #115 三轮 P1：resolver / CLI preview 共用；不持锁、不 side effect）。
 * 返回 { ok, state, pending?, reason?, detail? }，state ∈ {
 *   no_conflict: pending 缺席；
 *   mismatch: 点名 operation_id 与 pending 不符；
 *   dropped: current == before（未提交，可清理丢弃）；
 *   replay: current == after（已提交未写审计，可补记）；
 *   conflict: current 对不上 before/after（需显式 discard）。
 * 读取失败 / pending 非法 → { ok:false, reason, detail }。 */
export function classifySubscriptionAuditPending({ file, operationId } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_pending_required_absolute" };
  if (typeof operationId !== "string" || !operationId) return { ok: false, reason: "operation_id_required" };
  const loaded = loadSubscriptionAuditPending({ file });
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail ?? (loaded.problems ? loaded.problems.join(",") : null) };
  if (loaded.absent) return { ok: true, state: "no_conflict", reason: "audit_pending_no_conflict", detail: "没有待补记" };
  const pending = loaded.pending;
  if (pending.operation_id !== operationId) return { ok: true, state: "mismatch", reason: "audit_pending_conflict_mismatch", detail: "点名 operation " + operationId + " 与待补记 op " + pending.operation_id + " 不符，拒绝" };
  // 评审 #115 五轮 P1：store 读不清（符号链接 / FIFO / 目录 / 硬链接别名 / EACCES）→ 单独一态
  // store_unreadable，**不许**折成 cur=null 套进 before/after 比较 —— 当 before_sha256 也是 null 时
  // 会被误判为「首次写未提交」而误清 pending（评审复现场景）。unreadable 一律 fail-closed、pending 留存。
  const sh = storeHashState({ file });
  if (sh.state === "unreadable") return { ok: true, state: "store_unreadable", reason: "store_unreadable", detail: sh.detail, pending };
  const cur = sh.state === "absent" ? null : sh.sha256;
  if (cur === pending.before_sha256) return { ok: true, state: "dropped", pending };
  if (cur !== pending.after_sha256) return { ok: true, state: "conflict", pending, reason: "audit_pending_conflict" };
  return { ok: true, state: "replay", pending };
}

/**
 * 显式处理待补记冲突（评审 #115 三轮 P1，R7 修复 P1）：**与 apply 同一个 store 锁** —— 锁内重读 pending、
 * 验证 op id、重算 current hash，再按三态决定动作（P1 探针①：不取锁就删会射掉「pending 已发布、store
 * 未 rename」窗口里的对账信息）。分类与动作：
 *   - no_conflict（pending 缺席）/ mismatch（点名 op 不符）→ 拒，不动；
 *   - current == before（未提交）→ 丢弃 pending；
 *   - current == after（已提交未写审计）→ 走 recoverAndAppendPendingAudit 补记（复用 apply 的补记路径）；
 *   - current 对不上 before/after（真冲突）→ 仅 discard===true 才清，否则保留（fail-closed）。
 * 释放失败 / 回收残骸 → 非成功返回（describeLockRelease 出问题就翻 ok）。CLI 接线见
 * register-subscription.mjs --resolve-audit-conflict。
 * 返回 { ok, resolved?, state?, operationId?, detail?, reason?, lockUncleared? }。 */
export function resolveSubscriptionAuditConflict({ file, operationId, discard = false } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_pending_required_absolute" };
  if (typeof operationId !== "string" || !operationId) return { ok: false, reason: "operation_id_required" };
  const lockDir = file + ".lock";
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, reason: lock.reason === "publisher_busy" ? "store_busy" : lock.reason, pendingStatus: "unchanged", detail: lock.reason === "publisher_busy" ? "有写方持锁，不处理（pending 未动）" : String(lock.text ?? lock.reason) };
  let commitResidue = null;
  let result;
  try {
    const fenced = commitWhileHeld(lockDir, () => {
      const cls = classifySubscriptionAuditPending({ file, operationId });
      if (!cls.ok) return { ok: false, reason: cls.reason, detail: cls.detail };
      switch (cls.state) {
        case "no_conflict": return { ok: false, reason: "audit_pending_no_conflict", detail: "没有待补记" };
        case "mismatch": return { ok: false, reason: "audit_pending_conflict_mismatch", detail: cls.detail };
        case "dropped": {
          const clr = clearSubscriptionAuditPending({ file });
          if (!clr.ok) return { ok: false, reason: "audit_pending_clear_failed", detail: clr.reason };
          return { ok: true, resolved: true, state: "dropped", operationId, detail: "当前 store 与待补记 before 一致（未提交），已清理丢弃" };
        }
        case "replay": {
          const rec = recoverAndAppendPendingAudit({ file, pending: cls.pending });
          if (!rec.ok) return { ok: false, reason: rec.reason, detail: rec.detail };
          const clr = clearSubscriptionAuditPending({ file });
          if (!clr.ok) return { ok: false, reason: "audit_pending_clear_failed", detail: clr.reason };
          return { ok: true, resolved: true, state: "replayed", operationId, detail: "当前 store 与待补记 after 一致（已提交未写审计），已补记并清 pending" };
        }
        case "store_unreadable": // 评审 #115 五轮 P1：store 读不清 → 非成功返回、pending 留存；**不许** discard
          return { ok: false, reason: "store_unreadable", kept: true, operationId, detail: "store 路径读不清（" + (cls.detail ?? "") + "）；先修 " + file + "（去掉符号链接 / 恢复成普通单硬链接文件）再来，不许 discard" };
        default: { // conflict
          if (discard !== true) return { ok: false, reason: "audit_pending_conflict", kept: true, operationId, detail: "当前 store 与待补记 before/after 都不符（真冲突）；discard:true 才清" };
          const clr = clearSubscriptionAuditPending({ file });
          if (!clr.ok) return { ok: false, reason: "audit_pending_clear_failed", detail: clr.reason };
          return { ok: true, resolved: true, state: "conflict", operationId, detail: "当前 store 与待补记 before/after 都不符（真冲突），已按放弃处理清 pending" };
        }
      }
    });
    commitResidue = fenced?.reapUncleared ?? null;
    if (!fenced || fenced.ok === false) {
      return (result = { ok: false, reason: "audit_pending_lock_lost", detail: String(fenced?.reason ?? "commit_failed") });
    }
    result = fenced.run;
  } finally {
    let rel;
    try { rel = releasePublishLock(lockDir); } catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    const why = describeLockRelease(rel, commitResidue);
    if (why) {
      if (result && typeof result === "object") {
        result.ok = false;
        result.lockUncleared = why;
        if (!result.reason || result.reason === "audit_pending_lock_lost") result.reason = "audit_pending_lock_release_failed";
      } else {
        result = { ok: false, reason: "audit_pending_lock_release_failed", lockUncleared: why };
      }
    }
  }
  return result ?? { ok: false, reason: "audit_pending_lock_release_failed" };
}

/**
 * 进锁后的待补记重放 —— **封闭状态机**（评审 #115 二轮 P1-1/2/3/4/5，三轮 P1-2 改为持续门禁）。返回 {
 *   ok:true, action:"noop"|"dropped"|"replayed"    —— 可继续规划新变更；
 *   ok:false, reason, detail                      —— 未决，**阻断**本次新变更（fail-closed）。
 * 三态判定（P1-2）：
 *   - pending 缺席 → noop；
 *   - current == before → 未提交（丢弃 pending，proceed）；
 *   - current == after → 补记：先核验审计闭合（前缀一致才截未提交尾巴，P1-3）、按 operation_id
 *     去重（同 id 异文 / 重复 id 都 fail-closed，P1-1）、追加、确认完整事件存在、才清 pending；
 *   - 其它 → 冲突：**不改名留痕**，pending 原地留存作为持续 blocker（fail-closed，三轮 P1-2）。
 * 任何一步失败 / 清理失败都阻断并带回 reason（不静默，P1-5）。 */
function resolvePendingSubscriptionAudit({ file, now }) {
  const loaded = loadSubscriptionAuditPending({ file });
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail ?? (loaded.problems ? loaded.problems.join(",") : null) };
  if (loaded.absent) return { ok: true, action: "noop" };
  const pending = loaded.pending;
  // 评审 #115 五轮 P1：store 读不清（符号链接 / FIFO / 目录 / 硬链接别名 / EACCES）→ 阻断本次变更，
  // pending 留存。**不许**折成 cur=null —— 旧逻辑把 ENOENT 与读不清折叠成同一个 null，当 before_sha256
  // 也是 null（首次写待补记）时被误判成「首次写未提交」而误清 pending。
  const sh = storeHashState({ file });
  if (sh.state === "unreadable") return { ok: false, reason: "store_unreadable", detail: sh.detail, pendingStatus: "unchanged" };
  const cur = sh.state === "absent" ? null : sh.sha256;
  if (cur === pending.before_sha256) {
    const clr = clearSubscriptionAuditPending({ file });
    if (!clr.ok) return { ok: false, reason: "audit_pending_clear_failed", detail: clr.reason };
    return { ok: true, action: "dropped" };
  }
  if (cur !== pending.after_sha256) {
    // 评审 #115 三轮 P1-2：冲突**不改名**，pending 原地留存作为持续 blocker（fail-closed）。
    // 后续每次 apply 都在状态机入口再次撞上它并阻断，直到显式维护入口点名处理。
    return { ok: false, reason: "audit_pending_conflict", detail: "当前 store 与待补记的 before/after 都对不上（pending op=" + pending.operation_id + "）；该 pending 会持续阻断后续写入，请用 register-subscription.mjs --resolve-audit-conflict <operation_id> --store <绝对路径> --apply 显式处理" };
  }
  const rec = recoverAndAppendPendingAudit({ file, pending });
  if (!rec.ok) return { ok: false, reason: rec.reason, detail: rec.detail };
  const clr = clearSubscriptionAuditPending({ file });
  if (!clr.ok) return { ok: false, reason: "audit_pending_clear_failed", detail: clr.reason };
  return { ok: true, action: "replayed" };
}

/** current==after 的补记主体：按 pending 记录的基线核前缀、截未提交尾巴（P1-1：只在「基线 valid
 * 且内容以基线为前缀」时截；基线为空时审计也必须为空，否则外部写入 → 冲突）、按 operation_id 去重、
 * append + fsyncDir（P1-3 屏障）、复核后清 pending。返回 { ok, reason?, detail? }。 */
function recoverAndAppendPendingAudit({ file, pending }) {
  const auditFile = file + ".audit.jsonl";
  const targetSize = pending.audit_size_before;
  const targetSha = pending.audit_sha256_before;
  let afd = null;
  try { afd = fs.openSync(auditFile, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) {
    if (err.code === "ENOENT") { afd = null; }
    else return { ok: false, reason: "audit_replay_failed", detail: "audit_not_regular_file:" + (err.code === "EISDIR" ? "是目录" : err.code) };
  }
  let committed = Buffer.alloc(0);
  try {
    if (afd !== null) {
      const st = fs.fstatSync(afd);
      if (!st.isFile()) return { ok: false, reason: "audit_replay_failed", detail: "audit_not_regular_file" };
      if (st.nlink !== 1) return { ok: false, reason: "audit_replay_failed", detail: "multiple_links:" + st.nlink };
      const chunks = []; const buf = Buffer.alloc(64 * 1024);
      for (;;) { const n = fs.readSync(afd, buf, 0, buf.length, null); if (n <= 0) break; chunks.push(Buffer.from(buf.subarray(0, n))); }
      const content = Buffer.concat(chunks);
      if (targetSize === 0) {
        // 基线为缺席/空：恢复要求审计也为空。非空 = 外部写入（换行截断 / 他者 append 等）→ **冲突不截**（P1-1）。
        if (content.length !== 0) return { ok: false, reason: "audit_pending_conflict", detail: "待补记基线为空但审计有内容（外部写入），不覆盖" };
      } else {
        if (content.length < targetSize) return { ok: false, reason: "audit_pending_conflict", detail: "审计文件比基线还短（前缀不一致）" };
        committed = content.subarray(0, targetSize);
        if (crypto.createHash("sha256").update(committed).digest("hex") !== targetSha) return { ok: false, reason: "audit_pending_conflict", detail: "审计前缀哈希与基线不符" };
        if (content.length > targetSize) { fs.ftruncateSync(afd, targetSize); fs.fsyncSync(afd); } // 只在基线 valid 且内容以基线为前缀时才截（P1-1）
      }
    } else {
      if (targetSize !== 0) return { ok: false, reason: "audit_pending_conflict", detail: "审计缺席但基线非空（审计被外部删/移）" };
    }
  } catch (err) { return { ok: false, reason: "audit_replay_failed", detail: String(err.code ?? err.message) }; }
  finally { try { fs.closeSync(afd); } catch { /* 已关 */ } }
  const found = parseAuditEvents(committed).filter((e) => e.operation_id === pending.event.operation_id);
  if (found.length === 1) {
    if (JSON.stringify(found[0]) !== JSON.stringify(pending.event)) return { ok: false, reason: "audit_pending_conflict", detail: "同 operation_id 但内容不一致（同 id 异文，fail-closed）" };
    return { ok: true, committed: true };
  }
  if (found.length > 1) return { ok: false, reason: "audit_pending_conflict", detail: "审计中出现重复 operation_id（fail-closed）" };
  try {
    appendSubscriptionAuditLine({ file, event: pending.event });
    fsyncDir(path.dirname(auditFile)); // 评审 #115 三轮 P1-3：补记 append 成功先 fsync 父目录，再复核/清 pending。
  } catch (err) { return { ok: false, reason: "audit_replay_failed", detail: "audit_append_failed:" + String(err.code ?? err.message) }; }
  const verify = loadSubscriptionAudit({ file });
  if (!verify.ok || !verify.events.some((e) => e.operation_id === pending.event.operation_id && JSON.stringify(e) === JSON.stringify(pending.event))) {
    return { ok: false, reason: "audit_replay_failed", detail: "补记后确认不到该 operation 的完整事件" };
  }
  return { ok: true, committed: false };
}

/**
 * 纯函数：从模板算出一条新的控制面订阅。群参数按订阅声明：chat_id 必须给
 * （允许与模板不同 —— 这正是多群的意义），新鲜度缺省继承模板。
 */
export function planSubscriptionEntry({ runtime, template, domainKey, chatId, freshnessMs, instanceKey = null, chatName = null } = {}) {
  if (!SUBSCRIPTION_RUNTIMES.includes(runtime)) return { ok: false, reason: "runtime_unknown" };
  // 链核对在**最底层**（评审 #112 二轮：只在 change 计划器里核，直接调用这里的仍能
  // 用 Claude 模板配 runtime:"codex" 造出归错链的条目）。
  if (template?.chain !== runtime) return { ok: false, reason: "chain_mismatch", detail: "模板 chain=" + String(template?.chain) + " ≠ runtime=" + String(runtime) };
  if (typeof domainKey !== "string" || !domainKey.trim()) return { ok: false, reason: "domain_key_required" };
  if (typeof chatId !== "string" || !chatId.trim()) return { ok: false, reason: "chat_id_required" };
  if (instanceKey != null && (typeof instanceKey !== "string" || !INSTANCE_KEY_SHAPE.test(instanceKey))) {
    return { ok: false, reason: "instance_key_shape" };
  }
  // chat_name（FR-2.6 单 3）：给了就必须合法；这里的早拒带专用 reason，validateSubscription 是写盘前的第二道。
  if (chatName != null && (typeof chatName !== "string" ||
      // 长度按码点，不是 UTF-16 单位（与 validateSubscription、JSON Schema maxLength 同判）。
      Array.from(chatName).length > CHAT_NAME_MAX_LENGTH || !chatName.trim())) {
    return { ok: false, reason: "chat_name_invalid" };
  }
  let freshness = template?.default_freshness_ms;
  if (freshnessMs != null) { // 显式给的才覆盖；null / undefined 都算没给（CLI 未传时是 null）
    if (typeof freshnessMs !== "number" || !Number.isFinite(freshnessMs) || freshnessMs <= 0) {
      return { ok: false, reason: "freshness_ms_invalid" };
    }
    freshness = freshnessMs;
  }
  const entry = {
    // 版本按「有无 1.1 字段」定（FR-2.6 单 3）：instance_key 或 chat_name 任一在 → 1.1；
    // 两个都不在 → 照旧 1.0，id 与 legacy 一致。1.0 封闭形状不认识 chat_name，不能带。
    schema_version: (instanceKey == null && chatName == null)
      ? SUBSCRIPTION_SCHEMA_VERSION : SUBSCRIPTION_SCHEMA_VERSION_KEYED,
    artifact_type: SUBSCRIPTION_ARTIFACT_TYPE,
    subscription_id: subscriptionControlId({ runtime, agentUid: template.agent_uid, domainKey, chatId, instanceKey }),
    ...(instanceKey == null ? {} : { instance_key: instanceKey }),
    ...(chatName == null ? {} : { chat_name: chatName }),
    version: 1,
    endpoint_id: legacyEndpointId({ runtime, agentUid: template.agent_uid }),
    domain_id: stableControlId("domain", runtime, domainKey),
    status: "active",
    scope: {
      agent_uid: template.agent_uid,
      transport_open_id: template.transport_open_id,
      chat_id: chatId,
      sender_ids: [template.frank_sender_id],
      // 角色表与投影同一份判据（senderTable）：模板没配 senders 就不带，旧制品照样合法。
      ...(senderTable(template) !== null ? { sender_roles: senderTable(template) } : {}),
      event_types: [MESSAGE_RECEIVE_EVENT],
    },
    constraints: { freshness_ms: freshness },
  };
  const valid = validateSubscription(entry);
  if (!valid.ok) return { ok: false, reason: "entry_invalid", problems: valid.problems };
  return { ok: true, entry };
}

/**
 * 纯函数：算出变更后的 store。不写盘。action ∈ add|pause|resume|remove。
 *
 * 寻址（评审 #112 裁决）：同四元组可能多条（keyed），pause/resume/remove 不能只凭
 * domain + chat 定位 —— subscriptionId 精确寻址优先；否则四元组 + instanceKey 重算 id；
 * 都没给时四元组下恰一条才认，多条歧义拒绝（列出候选 id 让人挑）。
 */
export function planSubscriptionChange({ store, runtime, template, domainKey, chatId, freshnessMs, action = "add", instanceKey = null, subscriptionId = null, chatName = null } = {}) {
  if (!["add", "pause", "resume", "remove"].includes(action)) return { ok: false, reason: "action_unknown" };
  if (!store || !Array.isArray(store.subscriptions)) return { ok: false, reason: "store_invalid" };
  // 链核对（评审 PR #112 P2）：Claude 模板配 runtime:"codex" 会生成一条合法但归错链的订阅 ——
  // 在唯一计划器里拒，不只靠 CLI 传对参数。
  if (template?.chain !== runtime) return { ok: false, reason: "chain_mismatch", detail: "模板 chain=" + String(template?.chain) + " ≠ runtime=" + String(runtime) };
  if (action === "add") {
    const id = subscriptionControlId({ runtime, agentUid: template?.agent_uid, domainKey, chatId, instanceKey });
    if (store.subscriptions.some((s) => s.subscription_id === id)) return { ok: false, reason: "subscription_exists", subscription_id: id };
    const planned = planSubscriptionEntry({ runtime, template, domainKey, chatId, freshnessMs, instanceKey, chatName });
    if (!planned.ok) return planned;
    return { ok: true, changed: true, store: { ...store, subscriptions: [...store.subscriptions, planned.entry] }, entry: planned.entry };
  }
  let existing = null;
  if (subscriptionId != null) {
    existing = store.subscriptions.find((s) => s.subscription_id === subscriptionId) ?? null;
    if (!existing) return { ok: false, reason: "subscription_not_found", subscription_id: subscriptionId };
    // 精确寻址不豁免上下文（评审 #112 四轮）：拿着 Codex 订阅的 id 配 Claude 模板照样能改 ——
    // 查到条目后仍核对它属于当前 runtime / template / domainKey / chatId，任一不符零变更。
    if (existing.endpoint_id !== legacyEndpointId({ runtime, agentUid: template?.agent_uid }) ||
        existing.domain_id !== stableControlId("domain", runtime, domainKey) ||
        existing.scope?.agent_uid !== template?.agent_uid ||
        existing.scope?.chat_id !== chatId ||
        existing.scope?.transport_open_id !== template?.transport_open_id) {
      return { ok: false, reason: "subscription_context_mismatch", subscription_id: subscriptionId };
    }
  } else if (instanceKey != null) {
    const id = subscriptionControlId({ runtime, agentUid: template?.agent_uid, domainKey, chatId, instanceKey });
    existing = store.subscriptions.find((s) => s.subscription_id === id) ?? null;
    if (!existing) return { ok: false, reason: "subscription_not_found", subscription_id: id };
  } else {
    // 四元组寻址：命中同四元组的全部条目（legacy 的 + keyed 的）——恰一条才动，多条必须点名
    const quad = store.subscriptions.filter((s) =>
      s.endpoint_id === legacyEndpointId({ runtime, agentUid: template?.agent_uid }) &&
      s.domain_id === stableControlId("domain", runtime, domainKey) &&
      s.scope?.chat_id === chatId);
    if (!quad.length) {
      return { ok: false, reason: "subscription_not_found",
        subscription_id: subscriptionControlId({ runtime, agentUid: template?.agent_uid, domainKey, chatId }) };
    }
    if (quad.length > 1) {
      return { ok: false, reason: "subscription_ambiguous",
        candidates: quad.map((s) => s.subscription_id + (s.instance_key ? "（key=" + s.instance_key + "）" : "（legacy）")) };
    }
    existing = quad[0];
  }
  const id = existing.subscription_id;
  if (action === "remove") {
    return { ok: true, changed: true, store: { ...store, subscriptions: store.subscriptions.filter((s) => s.subscription_id !== id) }, before: existing };
  }
  const status = action === "pause" ? "paused" : "active";
  if (existing.status === status) return { ok: true, changed: false, store, entry: existing };
  // 内容变更 → 版本前进（§3.3-3）：FR-2.5 同步计划器靠版本号发现订阅变了。
  const entry = { ...existing, status, version: existing.version + 1 };
  const valid = validateSubscription(entry);
  if (!valid.ok) return { ok: false, reason: "entry_invalid", problems: valid.problems };
  return {
    ok: true, changed: true,
    store: { ...store, subscriptions: store.subscriptions.map((s) => (s.subscription_id === id ? entry : s)) },
    entry, before: existing,
  };
}

/**
 * store 的唯一写事务 —— 镜像 withChainTemplateWrite 的每一步（scripts/chain-template.mjs:274-322）：
 * 只认普通文件（缺席可）、symlink / 硬链接拒绝；<file>.lock symlink 锁内重读 → 重规划 →
 * 逐条校验 → 备份 → 临时文件 + rename 原子写 → 逐字读回；锁没交还带 lockUncleared。
 * change 是变更意图，以锁内世界为准重算（先到的写方赢，后到的按新现状重新判定）。
 */
export function applySubscriptionChange({ file, change, now = new Date() } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "store_required_absolute" };
  if (!change || typeof change !== "object") return { ok: false, reason: "change_required" };
  let commitResidue = null; // 提交段 commitWhileHeld 带回的 .reap 残骸，与释放段统一投影（评审 #112 三轮）
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { ok: false, reason: "store_not_regular_file", detail: st.isSymbolicLink() ? "是符号链接（别名）；请用真实路径" : "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, reason: "store_has_multiple_links", detail: "这个文件有 " + st.nlink + " 个目录项（硬链接别名）；先去掉别名再写" };
  } catch (err) { if (err.code !== "ENOENT") return { ok: false, reason: "store_unreadable", detail: String(err.code ?? err.message) }; }
  const lockDir = file + ".lock";
  let lock;
  try { lock = acquirePublishLock(lockDir); }
  catch (err) { return { ok: false, reason: "store_lock_unavailable", detail: "锁原语抛错：" + String(err?.code ?? err?.message ?? err) }; }
  if (!lock.ok) {
    return lock.reason === "publisher_busy"
      ? { ok: false, reason: "store_busy", detail: "另一个写方持有 " + lockDir }
      : { ok: false, reason: "store_lock_unavailable", detail: String(lock.reason) + (lock.error ? "：" + lock.error : "") };
  }
  let result;
  try {
    // 评审 #115 P1-3：进锁后、加载 store 前先补记上一次「store 已提交、审计未写」的 pending。
    // 放在 changed/no-op 分叉**之前** —— 幂等 no-op 也要先看 pending（评审标记的早退漏洞）。
    let resolvedNote = null;
    {
      const resolved = resolvePendingSubscriptionAudit({ file, now });
      if (!resolved.ok) {
        // 评审 #115 二轮 P1-2/P1-4：待补记未决（冲突 / 不是普通文件 / 清不掉）→ 阻断本次新变更，fail-closed。
        return (result = { ok: false, reason: resolved.reason, detail: resolved.detail ?? null });
      }
      if (resolved.action !== "noop") resolvedNote = resolved.action;
    }
    const loaded = loadSubscriptionStore({ file });
    if (!loaded.ok) return (result = { ok: false, reason: "store_invalid", problems: loaded.problems }); // fail-closed：损坏的 store 不做任何写
    const planned = planSubscriptionChange({ store: { subscriptions: loaded.subscriptions }, ...change });
    if (!planned.ok) return (result = planned);
    if (!planned.changed) return (result = { ok: true, changed: false, entry: planned.entry ?? null, ...(resolvedNote ? { auditPendingResolved: resolvedNote } : {}) });
    const body = JSON.stringify({ schema_version: SUBSCRIPTION_STORE_SCHEMA_VERSION, artifact_type: SUBSCRIPTION_STORE_ARTIFACT_TYPE, subscriptions: planned.store.subscriptions }, null, 2) + "\n";
    let backup = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file)) {
        backup = file + ".bak." + now.toISOString().replace(/[:.]/gu, "-");
        fs.copyFileSync(file, backup);
      }
    } catch (err) { return (result = { ok: false, reason: "backup_failed", detail: err.message }); }
    // 唯一临时名 + O_EXCL|O_NOFOLLOW + fsync；rename 放进 commitWhileHeld —— 锁被换 / 丢
    // 就不提交（评审 PR #112 P1：固定 tmp 名可被预置 symlink 把外部文件写穿；rename 前
    // 失去锁的旧写方不许覆盖新写方的成果）。
    const tmp = file + ".tmp." + process.pid + "." + crypto.randomBytes(6).toString("hex");
    try {
      const wfd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const buf = Buffer.from(body, "utf-8");
        let off = 0;
        while (off < buf.length) {
          const n = fs.writeSync(wfd, buf, off);
          // writeSync 返回 0 不是错误码但也不是进展 —— 当短写受控失败，不许无限循环（评审 #112 三轮）
          if (n <= 0) throw new Error("ESHORTWRITE：writeSync 返回 " + n);
          off += n;
        }
        fs.fsyncSync(wfd);
      } finally { try { fs.closeSync(wfd); } catch { /* 已关 */ } }
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
      return (result = { ok: false, reason: "store_unwritable", detail: err.message, backup });
    }
    // 评审 #115 五轮 P1：提交前生成 beforeSha 也用封闭三态 —— unreadable → **阻断提交**（不产生
    // before 语义含糊的 pending：读不清别当成「首次写」）；absent → before_sha256:null 照旧。
    const beforeSh = storeHashState({ file });
    if (beforeSh.state === "unreadable") {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
      return (result = { ok: false, reason: "store_unreadable", detail: beforeSh.detail, backup });
    }
    const beforeSha = beforeSh.state === "absent" ? null : beforeSh.sha256;
    const afterSha = crypto.createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex").slice(0, 16);
    const operationId = "op-" + now.toISOString().replace(/[:.]/gu, "-") + "-" + crypto.randomBytes(4).toString("hex");
    const auditEvent = buildSubscriptionAuditEvent({
      operationId,
      at: now.toISOString(),
      action: change.action,
      subscriptionId: planned.entry?.subscription_id ?? planned.before?.subscription_id ?? null,
      versionAfter: planned.entry?.version ?? null,
      storeBytesSha256: afterSha,
    });
    const evCheck = validateSubscriptionAuditEvent(auditEvent);
    if (!evCheck.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ } return (result = { ok: false, reason: "audit_invalid", problems: evCheck.problems, backup }); }
    // 评审 #115 P1-3：rename **前**把预期审计事件落成 pending —— 若「store 已提交、审计未写」，崩溃后可在下次 apply 补记。
    // 写不下 pending 就不提交 store（fail-closed：不落到不可恢复的中间态）。
    const preAudit = auditBaselineState({ file });
    // 评审 #115 三轮 P1-1：审计基线 unreadable（非普通文件 / 坏行 / 非法事件 / 重复 op id / 缺换行）→
    // 在 store 提交**之前**阻断（fail-closed），不产生可被「恢复即截」的 pending。valid 才记 size/hash。
    if (preAudit.state === "unreadable") {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
      return (result = { ok: false, reason: preAudit.reason, detail: preAudit.detail, backup });
    }
    const pendWrite = writeSubscriptionAuditPending({
      file,
      pending: {
        schema_version: SUBSCRIPTION_AUDIT_PENDING_SCHEMA,
        operation_id: operationId,
        before_sha256: beforeSha,
        after_sha256: afterSha,
        audit_size_before: preAudit.size,
        audit_sha256_before: preAudit.sha256,
        event: auditEvent,
      },
    });
    if (!pendWrite.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ } return (result = { ok: false, reason: "audit_pending_unwritable", detail: pendWrite.detail, backup }); }
    let commitErr = null;
    const fenced = commitWhileHeld(lockDir, () => {
      try { fs.renameSync(tmp, file); } catch (err) { commitErr = err; }
      return { done: true };
    });
    commitResidue = fenced?.reapUncleared ?? null;
    // fenced：锁被换 / 丢 → { ok:false, reason:"lock_lost" }（不提交）；成功 → fn 的返回值
    if (!fenced || fenced.ok === false) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
      return (result = { ok: false, reason: "store_commit_refused", detail: String(fenced?.reason ?? "commit_failed"), backup });
    }
    if (commitErr) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
      return (result = { ok: false, reason: "store_unwritable", detail: commitErr.message, backup });
    }
    let back;
    try { back = fs.readFileSync(file, "utf-8"); } catch (err) { return (result = { ok: false, reason: "readback_failed", detail: err.message, backup }); }
    if (back !== body) return (result = { ok: false, reason: "readback_mismatch", backup });
    result = { ok: true, changed: true, entry: planned.entry ?? null, before: planned.before ?? null, backup, ...(resolvedNote ? { auditPendingResolved: resolvedNote } : {}) };
    // FR-2.6 单 4 + 评审 #115 P1-1/P1-3：审计在 rename + 读回校验之后、释放锁之前追加。
    // 受验 fd 追加（O_NOFOLLOW|O_NONBLOCK + 同 fd fstat 单硬链接 + Buffer 循环写满 + fsync）；
    // 写方与读方共用 validateSubscriptionAuditEvent 同一把判据（P1-2）。
    // 失败不回滚 store（变更已成立）：auditUnwritten 带原因，pending 留存供下次补记，CLI 退非零让人来对账。
    try {
      appendSubscriptionAuditLine({ file, event: auditEvent });
      // 评审 #115 二轮 P1-5：append 后 fsync 目录（首次建 audit 也要在清 pending 前持久化目录项）。
      fsyncDir(path.dirname(subscriptionAuditPendingPath(file)));
    } catch (err) {
      // 审计行没写成 / 目录项没持久化（屏障未过）→ pending **留存**供下次补记，CLI 退非零让人来对账。
      result.auditUnwritten = "audit_append_failed:" + String(err.code ?? err.message);
    }
    // append 成功才清 pending；清理结果不静默（评审 #115 二轮 P1-5）。
    if (!result.auditUnwritten) {
      const clr = clearSubscriptionAuditPending({ file });
      if (!clr.ok) result.auditUnwritten = "audit_pending_clear_failed:" + clr.reason;
    }
    return result;
  } finally {
    let rel;
    try { rel = releasePublishLock(lockDir); } catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    const why = describeLockRelease(rel, commitResidue);
    if (why && result && typeof result === "object") result.lockUncleared = why;
  }
}

/**
 * 释放结果 → lockUncleared 文案（null = 干净交还）。**reap 残骸不许吞**（评审 #112 二轮：
 * 释放主锁成功但 .reap 残骸清不掉时，后续所有写方都会报锁不可用 —— 这必须让本次 CLI 非零并指路，
 * 不能报成功）。三态：释放失败 / 锁已不在 / reap 残骸；都带 repair 指路的原始信息。
 */
export function describeLockRelease(rel, commitResidue = null) {
  const residueText = (r) => "reap_residue：" + String(r.path ?? "") +
    (r.error ? "：" + r.error : "") + "（回收段残骸不会自动恢复，请在本机用 repair-publish-lock 处理）";
  if (!rel?.ok) {
    return String(rel?.reason) + (rel?.error ? "：" + rel.error : "") +
      (commitResidue ? "；另有提交段 " + residueText(commitResidue) : "");
  }
  // 提交段与释放段的残骸统一投影（评审 #112 三轮：提交段的 fenced.reapUncleared 曾被丢弃，
  // 只剩一句 release_busy，路径 / EIO / repair 指引全丢）
  const residue = rel.reapUncleared ?? commitResidue;
  if (residue) return residueText(residue);
  if (rel.absent) return "锁已不在（被清理过）";
  return null;
}
