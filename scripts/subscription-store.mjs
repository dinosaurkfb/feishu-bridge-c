/**
 * FR-2.6 单 1：订阅控制面落盘对象（store）+ 唯一写事务。
 *
 * 为什么要有独立存储：今天「订阅」只是投影（buildLegacySubscriptionReadModel，
 * scripts/subscription.mjs:99-190），从模板 + 登记表算出来，控制面没有
 * 「创建 / 暂停 / 删除订阅」的落盘对象。提案 A（2026-09-01 拍板）：Subscription v1
 * schema 不动，多群 = 同域多条订阅；本模块只做控制面存储与受控写入口，
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
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquirePublishLock, commitWhileHeld, releasePublishLock } from "./registry.mjs";
import { senderTable } from "./sender-roles.mjs";
import {
  MESSAGE_RECEIVE_EVENT, SUBSCRIPTION_ARTIFACT_TYPE, SUBSCRIPTION_SCHEMA_VERSION,
  legacyEndpointId, stableControlId, validateSubscription,
} from "./subscription.mjs";

export const SUBSCRIPTION_STORE_SCHEMA_VERSION = "1.0";
export const SUBSCRIPTION_STORE_ARTIFACT_TYPE = "feishu_bridge_subscription_store";
export const SUBSCRIPTION_RUNTIMES = ["claude", "codex"];

/**
 * 订阅的控制面 id：与投影同一套派生（scripts/subscription.mjs:136-140 ——
 * domain_id = stableControlId("domain", runtime, domain_key)，
 * subscription_id = stableControlId("subscription", endpointId, domainId, chatId, agent_uid)）。
 * 同一 (链, 域, 群, agent) 在两边算出同一个 id，合并时按 id 对齐。
 */
export function subscriptionControlId({ runtime, agentUid, domainKey, chatId }) {
  const endpointId = legacyEndpointId({ runtime, agentUid });
  const domainId = stableControlId("domain", runtime, domainKey);
  return stableControlId("subscription", endpointId, domainId, chatId, agentUid);
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
 * 纯函数：从模板算出一条新的控制面订阅。群参数按订阅声明：chat_id 必须给
 * （允许与模板不同 —— 这正是多群的意义），新鲜度缺省继承模板。
 */
export function planSubscriptionEntry({ runtime, template, domainKey, chatId, freshnessMs } = {}) {
  if (!SUBSCRIPTION_RUNTIMES.includes(runtime)) return { ok: false, reason: "runtime_unknown" };
  // 链核对在**最底层**（评审 #112 二轮：只在 change 计划器里核，直接调用这里的仍能
  // 用 Claude 模板配 runtime:"codex" 造出归错链的条目）。
  if (template?.chain !== runtime) return { ok: false, reason: "chain_mismatch", detail: "模板 chain=" + String(template?.chain) + " ≠ runtime=" + String(runtime) };
  if (typeof domainKey !== "string" || !domainKey.trim()) return { ok: false, reason: "domain_key_required" };
  if (typeof chatId !== "string" || !chatId.trim()) return { ok: false, reason: "chat_id_required" };
  let freshness = template?.default_freshness_ms;
  if (freshnessMs != null) { // 显式给的才覆盖；null / undefined 都算没给（CLI 未传时是 null）
    if (typeof freshnessMs !== "number" || !Number.isFinite(freshnessMs) || freshnessMs <= 0) {
      return { ok: false, reason: "freshness_ms_invalid" };
    }
    freshness = freshnessMs;
  }
  const entry = {
    schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    artifact_type: SUBSCRIPTION_ARTIFACT_TYPE,
    subscription_id: subscriptionControlId({ runtime, agentUid: template.agent_uid, domainKey, chatId }),
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

/** 纯函数：算出变更后的 store。不写盘。action ∈ add|pause|resume|remove。 */
export function planSubscriptionChange({ store, runtime, template, domainKey, chatId, freshnessMs, action = "add" } = {}) {
  if (!["add", "pause", "resume", "remove"].includes(action)) return { ok: false, reason: "action_unknown" };
  if (!store || !Array.isArray(store.subscriptions)) return { ok: false, reason: "store_invalid" };
  // 链核对（评审 PR #112 P2）：Claude 模板配 runtime:"codex" 会生成一条合法但归错链的订阅 ——
  // 在唯一计划器里拒，不只靠 CLI 传对参数。
  if (template?.chain !== runtime) return { ok: false, reason: "chain_mismatch", detail: "模板 chain=" + String(template?.chain) + " ≠ runtime=" + String(runtime) };
  const id = subscriptionControlId({ runtime, agentUid: template?.agent_uid, domainKey, chatId });
  if (action === "add") {
    if (store.subscriptions.some((s) => s.subscription_id === id)) return { ok: false, reason: "subscription_exists", subscription_id: id };
    const planned = planSubscriptionEntry({ runtime, template, domainKey, chatId, freshnessMs });
    if (!planned.ok) return planned;
    return { ok: true, changed: true, store: { ...store, subscriptions: [...store.subscriptions, planned.entry] }, entry: planned.entry };
  }
  const existing = store.subscriptions.find((s) => s.subscription_id === id) ?? null;
  if (!existing) return { ok: false, reason: "subscription_not_found", subscription_id: id };
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
    const loaded = loadSubscriptionStore({ file });
    if (!loaded.ok) return (result = { ok: false, reason: "store_invalid", problems: loaded.problems }); // fail-closed：损坏的 store 不做任何写
    const planned = planSubscriptionChange({ store: { subscriptions: loaded.subscriptions }, ...change });
    if (!planned.ok) return (result = planned);
    if (!planned.changed) return (result = { ok: true, changed: false, entry: planned.entry ?? null });
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
        while (off < buf.length) off += fs.writeSync(wfd, buf, off);
        fs.fsyncSync(wfd);
      } finally { try { fs.closeSync(wfd); } catch { /* 已关 */ } }
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不在 */ }
      return (result = { ok: false, reason: "store_unwritable", detail: err.message, backup });
    }
    let commitErr = null;
    const fenced = commitWhileHeld(lockDir, () => {
      try { fs.renameSync(tmp, file); } catch (err) { commitErr = err; }
      return { done: true };
    });
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
    return (result = { ok: true, changed: true, entry: planned.entry ?? null, before: planned.before ?? null, backup });
  } finally {
    let rel;
    try { rel = releasePublishLock(lockDir); } catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
    const why = describeLockRelease(rel);
    if (why && result && typeof result === "object") result.lockUncleared = why;
  }
}

/**
 * 释放结果 → lockUncleared 文案（null = 干净交还）。**reap 残骸不许吞**（评审 #112 二轮：
 * 释放主锁成功但 .reap 残骸清不掉时，后续所有写方都会报锁不可用 —— 这必须让本次 CLI 非零并指路，
 * 不能报成功）。三态：释放失败 / 锁已不在 / reap 残骸；都带 repair 指路的原始信息。
 */
export function describeLockRelease(rel) {
  if (!rel?.ok) return String(rel?.reason) + (rel?.error ? "：" + rel.error : "");
  if (rel.reapUncleared) {
    return "reap_residue：" + String(rel.reapUncleared.path ?? "") +
      (rel.reapUncleared.error ? "：" + rel.reapUncleared.error : "") +
      "（回收段残骸不会自动恢复，请在本机用 repair-publish-lock 处理）";
  }
  if (rel.absent) return "锁已不在（被清理过）";
  return null;
}
