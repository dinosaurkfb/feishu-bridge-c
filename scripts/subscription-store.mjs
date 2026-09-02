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
 * （受验 fd 循环写满，append-only；评审 #115 二轮 P2-2 同步）：{ schema_version, at, action,
 * operation_id, subscription_id, version_after, store_bytes_sha256（写盘后整文件哈希前 16）}。**不夹带敏感值**：
 * 不写 chat_name / sender_ids 明细，id 与 action 已够对账。审计写失败不回滚 store
 * （变更已成立），结果带 auditUnwritten，CLI 据此退非零 —— 成功但要人知道，
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
  // 文件、从这个 fd 读 —— 符号链接 / FIFO / 目录 / 硬链接别名都说不清。
  let raw;
  let fd = null;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (err) {
      if (err.code === "ENOENT") return { ok: true, absent: true, subscriptions: [] };
      return { ok: false, problems: ["store_unreadable:" + (err.code === "ELOOP" ? "symlink" : String(err.code ?? err.message))] };
    }
    let st;
    try { st = fs.fstatSync(fd); } catch (err) { return { ok: false, problems: ["store_unreadable:fstat:" + String(err.code ?? err.message)] }; }
    if (!st.isFile()) return { ok: false, problems: ["store_unreadable:不是普通文件"] };
    if (st.nlink !== 1) return { ok: false, problems: ["store_unreadable:有 " + st.nlink + " 个目录项（硬链接别名）"] };
    try { raw = fs.readFileSync(fd, "utf-8"); } catch (err) { return { ok: false, problems: ["store_unreadable:" + String(err.code ?? err.message)] }; }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
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
export function subscriptionStorePath() {
  return path.join(os.homedir(), ".claude", "feishu-bridge", "subscriptions.json");
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
const SUBSCRIPTION_AUDIT_KEYS = ["schema_version", "at", "action", "operation_id", "subscription_id", "version_after", "store_bytes_sha256"];
const STORE_HASH16 = /^[0-9a-f]{16}$/u;

/**
 * 审计行的**唯一封闭校验器**（评审 #115 P1-2）。写方（追加时构造的行）与读方
 * （loadSubscriptionAudit 逐行）用同一把判据 —— 不许两份：写前自校验、读时逐行校验，
 * 各处对「什么样是一行合法审计」完全一致。
 * 封闭：精确键集（多余 / 缺失都拒）、schema "1.0"、规范 ISO 时间、action 枚举、
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
  if (has("operation_id") && (typeof event.operation_id !== "string" || !event.operation_id)) problems.push("operation_id");
  if (has("subscription_id") && (typeof event.subscription_id !== "string" || event.subscription_id.trim() === "")) problems.push("subscription_id_empty");
  if (has("store_bytes_sha256") && (typeof event.store_bytes_sha256 !== "string" || !STORE_HASH16.test(event.store_bytes_sha256))) problems.push("store_bytes_sha256");
  if (has("version_after")) {
    if (event.action === "remove") { if (event.version_after !== null) problems.push("version_after_not_null"); }
    else if (!Number.isInteger(event.version_after) || event.version_after <= 0) problems.push("version_after_not_positive");
  }
  return { ok: problems.length === 0, problems };
}

/** 写方唯一的审计行构造器：写前用 validateSubscriptionAuditEvent 自校验（同一把判据）。
 * operationId 是**操作身份**（评审 #115 二轮 P1-1）：补记去重按它判，不按 store 字节哈希——
 * add→remove→add 会让两次 add 的 store 字节完全相同，按哈希去重会把第二次变更永久弄丢。 */
export function buildSubscriptionAuditEvent({ at, action, subscriptionId, versionAfter, storeBytesSha256, operationId }) {
  return {
    schema_version: SUBSCRIPTION_AUDIT_SCHEMA_VERSION,
    at,
    action,
    operation_id: operationId,
    subscription_id: subscriptionId,
    version_after: versionAfter,
    store_bytes_sha256: storeBytesSha256,
  };
}

const SUBSCRIPTION_AUDIT_PENDING_SCHEMA = "1.0";
const SUBSCRIPTION_AUDIT_PENDING_KEYS = ["schema_version", "operation_id", "before_sha256", "after_sha256", "event", "audit_size_before", "audit_sha256_before"];

function validateAuditPending(p) {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return { ok: false, problems: ["shape_invalid"] };
  const problems = [];
  for (const k of Object.keys(p)) if (!SUBSCRIPTION_AUDIT_PENDING_KEYS.includes(k)) problems.push("extra:" + k);
  for (const k of SUBSCRIPTION_AUDIT_PENDING_KEYS) if (!Object.hasOwn(p, k)) problems.push("missing:" + k);
  const has = (k) => Object.hasOwn(p, k);
  if (has("schema_version") && p.schema_version !== SUBSCRIPTION_AUDIT_PENDING_SCHEMA) problems.push("schema_version");
  if (has("operation_id") && (typeof p.operation_id !== "string" || !p.operation_id)) problems.push("operation_id");
  if (has("after_sha256") && (typeof p.after_sha256 !== "string" || !STORE_HASH16.test(p.after_sha256))) problems.push("after_sha256");
  if (has("before_sha256") && p.before_sha256 !== null && (typeof p.before_sha256 !== "string" || !STORE_HASH16.test(p.before_sha256))) problems.push("before_sha256");
  // 评审 #115 二轮 P1-3：追加前审计的大小 / 哈希——要么都记（审计当时存在），要么都空（当时不存在）
  if (has("audit_size_before") && p.audit_size_before !== null && (!Number.isSafeInteger(p.audit_size_before) || p.audit_size_before < 0)) problems.push("audit_size_before");
  if (has("audit_sha256_before") && p.audit_sha256_before !== null && (typeof p.audit_sha256_before !== "string" || !STORE_HASH16.test(p.audit_sha256_before))) problems.push("audit_sha256_before");
  if (has("audit_size_before") && has("audit_sha256_before") && ((p.audit_size_before === null) !== (p.audit_sha256_before === null))) problems.push("audit_before_pair");
  const ev = validateSubscriptionAuditEvent(p.event);
  if (!ev.ok) problems.push("event:" + ev.problems.join(","));
  // pending.operation_id 与 event.operation_id 必须同一（操作身份一致性）
  if (!ev.ok || ev.ok) {
    if (has("operation_id") && has("event") && p.event && typeof p.event === "object" && !Array.isArray(p.event) && Object.hasOwn(p.event, "operation_id") && p.event.operation_id !== p.operation_id) problems.push("event_operation_id_mismatch");
  }
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
export function loadSubscriptionAudit({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_file_required_absolute" };
  const auditFile = file + ".audit.jsonl";
  let afd;
  try {
    afd = fs.openSync(auditFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true, events: [], problems: [] };
    return { ok: false, reason: "audit_not_regular_file", detail: err.code === "ELOOP" ? "是符号链接（别名）；请用真实路径" : "不是普通文件" };
  }
  let text;
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
    text = Buffer.concat(chunks).toString("utf-8");
  } catch (err) {
    return { ok: false, reason: "audit_unreadable", detail: String(err.code ?? err.message) };
  } finally { try { fs.closeSync(afd); } catch { /* 已关 */ } }
  const events = [];
  const problems = [];
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    let event = null;
    try { event = JSON.parse(raw); } catch { problems.push("line:" + (i + 1) + ":json_invalid"); continue; }
    const v = validateSubscriptionAuditEvent(event);
    if (!v.ok) { problems.push("line:" + (i + 1) + ":" + v.problems.join(",")); continue; }
    events.push(event);
  }
  return { ok: problems.length === 0, absent: false, events, problems };
}

/** 受验 fd 追加一行业务审计（评审 #115 P1-1）：O_NOFOLLOW|O_NONBLOCK、同 fd fstat 单硬链接、Buffer 循环写满（<=0 为 ESHORTWRITE）、fsync。失败抛错由调用方接。
 * 评审 #115 二轮 P2-1：共享导出也强制唯一校验器——打开文件之前先验事件，坏事件一个字节不落盘。 */
export function appendSubscriptionAuditLine({ file, event } = {}) {
  const v = validateSubscriptionAuditEvent(event);
  if (!v.ok) throw new Error("audit_line_invalid:" + v.problems.join(","));
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

/** sha256 整 buffer 前 16 位小写 hex。 */
function sha16(buf) { return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16); }

/** 目录 fsync（评审 #115 二轮 P1-5）：尽力而为——个别 FS 对目录 fsync 报 EINVAL 时不阻断，
 * 屏障大头由「文件 fsync → rename / link → 目录项」的顺序承担；报告如实说明这是尽力而为。 */
function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, fs.constants.O_RDONLY); } catch { return false; }
  try { fs.fsyncSync(fd); return true; } catch { return false; } finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

/** 循环写满整 buffer；writeSync <= 0 是非进展，受控失败不无限循环（评审 #112 三轮）。 */
function writeFull(fd, buf) {
  let off = 0;
  while (off < buf.length) { const n = fs.writeSync(fd, buf, off); if (n <= 0) throw new Error("ESHORTWRITE：" + n); off += n; }
}

/** 当前 store 整文件 sha256 前 16 位（受验读）。缺席 = {ok:true,absent:true}；说不清 = {ok:false}
 * （评审 #115 二轮 P1-2：缺席与说不清必须分开——说不清时状态机 fail-closed，不猜）。 */
function currentStoreHash({ file }) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true, sha: null };
    return { ok: false, detail: String(err.code ?? err.message) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return { ok: false, detail: "不是单硬链接普通文件" };
    return { ok: true, absent: false, sha: sha16(fs.readFileSync(fd)) };
  } catch (err) { return { ok: false, detail: String(err.code ?? err.message) }; }
  finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

/** 受验 fd 读审计原始字节：{ok,absent} | {ok,bytes} | {ok:false,reason,detail}
 * （O_NOFOLLOW|O_NONBLOCK + 同 fd fstat 单硬链接——与读 / 写两侧同款边界）。 */
function readAuditFileBytes({ file }) {
  const auditFile = file + ".audit.jsonl";
  let afd;
  try { afd = fs.openSync(auditFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true };
    if (err.code === "ELOOP") return { ok: false, reason: "audit_not_regular_file", detail: "是符号链接（别名）" };
    return { ok: false, reason: "audit_unreadable", detail: String(err.code ?? err.message) };
  }
  try {
    const st = fs.fstatSync(afd);
    if (!st.isFile()) return { ok: false, reason: "audit_not_regular_file", detail: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, reason: "audit_not_regular_file", detail: "有 " + st.nlink + " 个目录项（硬链接别名）" };
    return { ok: true, absent: false, bytes: fs.readFileSync(afd) };
  } catch (err) { return { ok: false, reason: "audit_unreadable", detail: String(err.code ?? err.message) }; }
  finally { try { fs.closeSync(afd); } catch { /* 已关 */ } }
}

/** 把待补记**不覆盖发布**为 <store>.audit.pending.json（评审 #115 二轮 P1-2）：
 * tmp 唯一名（O_EXCL|O_NOFOLLOW）写满 + fsync → link 到正式路径（目标已存在即 EEXIST，
 * 对符号链接 / 目录同样 EEXIST——rename 会静默覆盖，正是实测丢审计的入口）→ unlink tmp
 * → fsync 父目录（P1-5 屏障：pending 的目录项先于 store 的 rename 落盘）。 */
export function writeSubscriptionAuditPending({ file, pending } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_pending_required_absolute" };
  const v = validateAuditPending(pending);
  if (!v.ok) return { ok: false, reason: "audit_pending_invalid", problems: v.problems };
  const pendingPath = subscriptionAuditPendingPath(file);
  const tmp = pendingPath + ".tmp." + process.pid + "." + crypto.randomBytes(6).toString("hex");
  try {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
    const wfd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      writeFull(wfd, Buffer.from(JSON.stringify(pending, null, 2) + "\n", "utf-8"));
      fs.fsyncSync(wfd);
    } finally { try { fs.closeSync(wfd); } catch { /* 已关 */ } }
    fs.linkSync(tmp, pendingPath);
    fs.unlinkSync(tmp);
    fsyncDir(path.dirname(pendingPath));
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
    return { ok: false, reason: err.code === "EEXIST" ? "audit_pending_conflict" : "audit_pending_unwritable", detail: err.message };
  }
  return { ok: true };
}

/** 读待补记。缺席 = 没有未补记的变更。坏形状不吞（problems）。
 * 评审 #115 二轮 P1-4：与 audit / store 同款 fd 边界——O_NOFOLLOW（符号链接 ELOOP 拒）+
 * O_NONBLOCK（FIFO 打开即回）+ 同 fd fstat 单硬链接核验，不跟随不挂死。 */
export function loadSubscriptionAuditPending({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "audit_pending_required_absolute" };
  const pendingPath = subscriptionAuditPendingPath(file);
  let pfd;
  try { pfd = fs.openSync(pendingPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, absent: true, pending: null, problems: [] };
    return { ok: false, reason: "audit_pending_not_regular_file", detail: err.code === "ELOOP" ? "是符号链接（别名）" : String(err.code ?? err.message) };
  }
  let raw;
  try {
    const st = fs.fstatSync(pfd);
    if (!st.isFile()) return { ok: false, reason: "audit_pending_not_regular_file", detail: "不是普通文件" };
    if (st.nlink !== 1) return { ok: false, reason: "audit_pending_not_regular_file", detail: "有 " + st.nlink + " 个目录项（硬链接别名）" };
    raw = fs.readFileSync(pfd, "utf-8");
  } catch (err) { return { ok: false, reason: "audit_pending_unreadable", detail: String(err.code ?? err.message) }; }
  finally { try { fs.closeSync(pfd); } catch { /* 已关 */ } }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { return { ok: false, reason: "audit_pending_unreadable", detail: err.message }; }
  const v = validateAuditPending(parsed);
  if (!v.ok) return { ok: false, reason: "audit_pending_invalid", problems: v.problems };
  return { ok: true, absent: false, pending: parsed, problems: [] };
}

/** 删掉待补记（成功补记后调用）。评审 #115 二轮 P1-5：失败必须带出去（error 字符串），不许静默。 */
export function clearSubscriptionAuditPending({ file } = {}) {
  try { fs.rmSync(subscriptionAuditPendingPath(file), { force: true }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.code ?? err.message) }; }
}

/** 待补记判定为 stale：改名留痕为 <store>.audit.pending.stale.<ts>，不删不吞。返回是否改名成功。 */
export function staleSubscriptionAuditPending({ file, now = new Date() } = {}) {
  const pendingPath = subscriptionAuditPendingPath(file);
  const stalePath = pendingPath + ".stale." + now.toISOString().replace(/[:.]/gu, "-");
  try { fs.renameSync(pendingPath, stalePath); return { ok: true, stalePath }; }
  catch (err) { return { ok: false, error: String(err.code ?? err.message) }; }
}

/**
 * 进锁后的待补记结算（评审 #115 二轮 P1-2：**封闭状态机**）。任何分支说不清都阻断——
 * 返回 { blocked: { reason, detail?, problems? } } 时调用方必须拒绝本次变更（非零退出）；
 * 否则返回 { recovered: true }（事务已提交、审计已补记并清 pending）、
 * { discarded: { path } }（before 命中 = 事务根本没提交，pending 是残渣，留痕丢弃、变更照常）
 * 或 {}（无 pending，干净）。
 *
 * 三态判定（before/after 真正参与）：
 *   cur == before（含双方都是 null = store 当时缺席）→ 事务未提交 → 留痕丢弃，本次变更照常；
 *   cur == after → 事务已提交 → 补记（前缀核验 + 截未提交尾 + 整体闭合 + operation id 恰一条
 *     且逐字一致）→ 清 pending；任何一步说不清 → 阻断；
 *   其余（含 store 哈希说不出）→ 冲突 → fail-closed：留痕 + 阻断，不许「留 stale 后继续写」。
 * pending 读不清（形状 / 权限 / 符号链接 / FIFO）→ 阻断，pending 原地留守（证据不毁）。
 */
function settleSubscriptionAuditPending({ file, now }) {
  const loaded = loadSubscriptionAuditPending({ file });
  if (!loaded.ok) return { blocked: { reason: "audit_pending_" + loaded.reason, detail: loaded.detail ?? null, problems: loaded.problems ?? null } };
  if (loaded.absent) return {};
  const p = loaded.pending;
  const cur = currentStoreHash({ file });
  if (!cur.ok) return { blocked: { reason: "store_hash_unavailable", detail: cur.detail } };
  if (cur.sha === p.before_sha256) {
    const aside = staleSubscriptionAuditPending({ file, now });
    if (!aside.ok) return { blocked: { reason: "audit_pending_stale_refused", detail: aside.error } };
    return { discarded: { path: aside.stalePath } };
  }
  if (cur.sha !== p.after_sha256) {
    const aside = staleSubscriptionAuditPending({ file, now });
    if (!aside.ok) return { blocked: { reason: "audit_pending_stale_refused", detail: aside.error } };
    return { blocked: { reason: "audit_pending_conflict", detail: "store 哈希 " + cur.sha + " 既不是 pending 的 before " + p.before_sha256 + " 也不是 after " + p.after_sha256 + "；pending 已改名留痕 " + aside.stalePath } };
  }
  return recoverSubscriptionAuditPending({ file, pending: p });
}

/**
 * 已提交分支的补记（评审 #115 二轮 P1-1/P1-3）。pending 记录了追加前审计的大小 / 哈希：
 * 前缀核验通过才有资格截掉未提交尾巴（崩溃半行 / 已写整行的重放残留），再补记本 op 的
 * 完整行；补完做整体闭合核验（逐行封闭校验）+ operation id 恰一条且与 pending.event
 * 逐字一致，才清 pending——截断的尾巴不许被永久坐实，同 id 异文 / 重复 id fail-closed。
 */
function recoverSubscriptionAuditPending({ file, pending }) {
  const pendingLine = JSON.stringify(pending.event) + "\n";
  const auditState = readAuditFileBytes({ file });
  if (!auditState.ok) return { blocked: { reason: auditState.reason, detail: auditState.detail } };
  if (auditState.absent) {
    if (pending.audit_size_before !== null) return { blocked: { reason: "audit_shrunk", detail: "pending 记录追加前审计有 " + pending.audit_size_before + " 字节，现在整个不在了" } };
    let cfd;
    try { cfd = fs.openSync(file + ".audit.jsonl", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600); }
    catch (err) { return { blocked: { reason: "audit_unwritable", detail: String(err.code ?? err.message) } }; }
    try { writeFull(cfd, Buffer.from(pendingLine, "utf-8")); fs.fsyncSync(cfd); }
    finally { try { fs.closeSync(cfd); } catch { /* 已关 */ } }
    // P1-5：首次建审计，目录项要在清 pending 前持久化（fsync 父目录）
    fsyncDir(path.dirname(file));
    return verifyAndClearPending({ file, pending });
  }
  const bytes = auditState.bytes;
  const prefixLen = pending.audit_size_before ?? 0;
  if (pending.audit_size_before !== null) {
    if (bytes.length < prefixLen) return { blocked: { reason: "audit_shrunk", detail: "审计现在 " + bytes.length + " 字节，短于 pending 记录的 " + prefixLen } };
    if (sha16(bytes.subarray(0, prefixLen)) !== pending.audit_sha256_before) return { blocked: { reason: "audit_prefix_mismatch", detail: "追加前缀对不上 pending 记录的哈希——审计在 pending 之外被动过" } };
  }
  // 尾巴（前缀之后的字节）默认视为未提交、可截；唯独「完整可解析且是别的 operation_id」的行
  // 属于说不清的证据，fail-closed 不敢截（P1-1 同 id 意识在这里提前拦一次）。
  const tailText = bytes.subarray(prefixLen).toString("utf-8");
  if (tailText !== "") {
    for (const raw of tailText.split("\n")) {
      if (raw.trim() === "") continue;
      let ev = null;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev && typeof ev === "object" && !Array.isArray(ev) && ev.operation_id !== undefined && ev.operation_id !== pending.operation_id) {
        return { blocked: { reason: "audit_tail_unexplained", detail: "尾巴里有别的 operation_id 的完整行，不敢截：" + String(ev.operation_id) } };
      }
    }
  }
  // 同一 fd 上复验前缀 + 截尾 + 补写（不做路径二猜；O_RDWR 无 O_APPEND，显式 offset 写）
  const auditFile = file + ".audit.jsonl";
  let wfd;
  try { wfd = fs.openSync(auditFile, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) { return { blocked: { reason: "audit_unwritable", detail: String(err.code ?? err.message) } }; }
  try {
    const st = fs.fstatSync(wfd);
    if (!st.isFile()) return { blocked: { reason: "audit_not_regular_file", detail: "不是普通文件" } };
    if (st.nlink !== 1) return { blocked: { reason: "audit_not_regular_file", detail: "有 " + st.nlink + " 个目录项（硬链接别名）" } };
    const fresh = fs.readFileSync(wfd);
    if (pending.audit_size_before !== null && (fresh.length < prefixLen || sha16(fresh.subarray(0, prefixLen)) !== pending.audit_sha256_before)) {
      return { blocked: { reason: "audit_prefix_mismatch", detail: "写前复验前缀对不上" } };
    }
    if (fresh.length > prefixLen) fs.ftruncateSync(wfd, prefixLen);
    const buf = Buffer.from(pendingLine, "utf-8");
    const n = fs.writeSync(wfd, buf, 0, buf.length, prefixLen);
    if (n !== buf.length) return { blocked: { reason: "audit_reshort_write", detail: "补记只写出 " + n + "/" + buf.length + " 字节" } };
    fs.fsyncSync(wfd);
  } finally { try { fs.closeSync(wfd); } catch { /* 已关 */ } }
  return verifyAndClearPending({ file, pending });
}

/** 补记后的收口（评审 #115 二轮 P1-1/P1-3）：审计整体闭合（逐行封闭校验）+ 本 op 恰一条
 * 且与 pending.event 逐字一致，才清 pending；清理失败也阻断（P1-5 不静默）。 */
function verifyAndClearPending({ file, pending }) {
  const audit = loadSubscriptionAudit({ file });
  if (!audit.ok) return { blocked: { reason: "audit_not_closed", detail: null, problems: audit.problems } };
  const matches = audit.events.filter((e) => e.operation_id === pending.operation_id);
  if (matches.length === 0) return { blocked: { reason: "audit_operation_missing", detail: "补记后审计里找不到 " + pending.operation_id } };
  if (matches.length > 1) return { blocked: { reason: "audit_operation_id_duplicate", detail: "同一 operation_id 有 " + matches.length + " 行，fail-closed" } };
  if (JSON.stringify(matches[0]) !== JSON.stringify(pending.event)) return { blocked: { reason: "audit_operation_id_conflict", detail: "审计里已有同 operation_id 的事件与 pending 不逐字一致（同 id 异文）" } };
  const cleared = clearSubscriptionAuditPending({ file });
  if (!cleared.ok) return { blocked: { reason: "audit_pending_unclearable", detail: cleared.error } };
  return { recovered: true };
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
    // 评审 #115 二轮 P1-2：进锁后、加载 store 前先结算 pending——封闭状态机，任何说不清
    // （读不清 / 补记失败 / 清理失败 / stale 落标失败 / 三态冲突）都在规划新变更**之前**阻断。
    // 放在 changed/no-op 分叉**之前** —— 幂等 no-op 也要先结算（评审标记的早退漏洞）。
    const settle = settleSubscriptionAuditPending({ file, now });
    if (settle.blocked) return (result = { ok: false, reason: "audit_pending_blocked", detail: settle.blocked.reason, detailText: settle.blocked.detail ?? null, problems: settle.blocked.problems ?? null });
    const settleFlags = () => ({
      ...(settle.recovered ? { auditRecovered: true } : {}),
      ...(settle.discarded ? { auditPendingDiscarded: settle.discarded } : {}),
    });
    const loaded = loadSubscriptionStore({ file });
    if (!loaded.ok) return (result = { ok: false, reason: "store_invalid", problems: loaded.problems }); // fail-closed：损坏的 store 不做任何写
    const planned = planSubscriptionChange({ store: { subscriptions: loaded.subscriptions }, ...change });
    if (!planned.ok) return (result = planned);
    if (!planned.changed) return (result = { ok: true, changed: false, entry: planned.entry ?? null, ...settleFlags() });
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
    const storeState = currentStoreHash({ file }); // { ok, absent, sha }（评审 #115 二轮：缺席与说不清分开）
    const beforeSha = storeState.ok ? (storeState.absent ? null : storeState.sha) : null;
    const afterSha = crypto.createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex").slice(0, 16);
    // operation_id = 操作身份（P1-1）：进事件、进 pending，补记去重按它
    const operationId = "op-" + now.toISOString().replace(/[:.]/gu, "-") + "-" + crypto.randomBytes(8).toString("hex");
    const auditEvent = buildSubscriptionAuditEvent({
      at: now.toISOString(),
      action: change.action,
      subscriptionId: planned.entry?.subscription_id ?? planned.before?.subscription_id ?? null,
      versionAfter: planned.entry?.version ?? null,
      storeBytesSha256: afterSha,
      operationId,
    });
    const evCheck = validateSubscriptionAuditEvent(auditEvent);
    if (!evCheck.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ } return (result = { ok: false, reason: "audit_invalid", problems: evCheck.problems, backup }); }
    // 评审 #115 P1-3：rename **前**把预期审计事件落成 pending —— 若「store 已提交、审计未写」，崩溃后可在下次 apply 补记。
    // 写不下 pending 就不提交 store（fail-closed：不落到不可恢复的中间态）。
    // P1-3：pending 记录**追加前**审计的大小 / 哈希（状态机截尾判据）；审计说不清 → null（无前缀约束，恢复时扫描兜底）
    const auditBefore = readAuditFileBytes({ file });
    const auditSizeBefore = auditBefore.ok && !auditBefore.absent ? auditBefore.bytes.length : null;
    const auditShaBefore = auditBefore.ok && !auditBefore.absent ? sha16(auditBefore.bytes) : null;
    const pendWrite = writeSubscriptionAuditPending({
      file,
      pending: {
        schema_version: SUBSCRIPTION_AUDIT_PENDING_SCHEMA,
        operation_id: operationId,
        before_sha256: beforeSha,
        after_sha256: afterSha,
        event: auditEvent,
        audit_size_before: auditSizeBefore,
        audit_sha256_before: auditShaBefore,
      },
    });
    // P1-2：pending 已存在（audit_pending_conflict）= 上一笔未结算，绝不覆盖——变更就地中止
    if (!pendWrite.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ } return (result = { ok: false, reason: "audit_pending_unwritable", detail: pendWrite.reason + "：" + (pendWrite.detail ?? ""), problems: pendWrite.problems ?? null, backup }); }
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
    result = { ok: true, changed: true, entry: planned.entry ?? null, before: planned.before ?? null, backup, ...settleFlags() };
    // FR-2.6 单 4 + 评审 #115 P1-1/P1-3：审计在 rename + 读回校验之后、释放锁之前追加。
    // 受验 fd 追加（O_NOFOLLOW|O_NONBLOCK + 同 fd fstat 单硬链接 + Buffer 循环写满 + fsync）；
    // 写方与读方共用 validateSubscriptionAuditEvent 同一把判据（P1-2）。
    // 失败不回滚 store（变更已成立）：auditUnwritten 带原因，pending 留存供下次补记，CLI 退非零让人来对账。
    try {
      appendSubscriptionAuditLine({ file, event: auditEvent });
    } catch (err) {
      result.auditUnwritten = "audit_append_failed:" + String(err.code ?? err.message);
      return result; // pending 留守（rename 前已写）——下次 apply 状态机按 before/after/前缀结算
    }
    // P1-5：清理失败不静默——带出去让 CLI 非零；下次 apply 状态机会按前缀收敛（尾巴恰为本行 → 戡掉重写）
    const cleared = clearSubscriptionAuditPending({ file });
    if (!cleared.ok) result.auditPendingUncleared = cleared.error;
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
