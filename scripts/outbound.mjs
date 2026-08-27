/**
 * 出站：观察长期任务的 run 结局，产出可发布的草稿。
 *
 * 这是「完成」语义的唯一归属地。入站不判断完成，claim 层不判断完成 —— 只有这里判断。
 *
 * 最重要的一条：blocked 和 failed 都**不是**完成。把它们发布成进展就是伪造成功，
 * 而伪造成功是这个项目最不能出的错。它们要如实发布为受阻/失败。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isCanonicalIso } from "./canonical-time.mjs";
import { CLAIM_KEY_SHAPE } from "./claim.mjs";

import { assertPublishIdentity, identityErrorText } from "./chain-template.mjs";

import { execFileSync } from "node:child_process";

import { parseRunOutcome, readRunOutcome } from "./handoff.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";

const PUBLISHED_MARK = ".published.json";
export const RUN_PUBLISH_MAX_ATTEMPTS = 5;

const PRESENTATION = {
  completed: { label: "已完成", publish: true, truthful: "任务跑完且有非空产出" },
  blocked: { label: "受阻（权限）", publish: true, truthful: "工具被权限拦下，任务实际未完成" },
  failed: { label: "失败", publish: true, truthful: "任务以错误收场或产出为空" },
  running: { label: "进行中", publish: false, truthful: "还在跑，暂不发布" },
  missing: { label: "无日志", publish: false, truthful: "找不到 run 日志，需人工查证" },
  invalid: { label: "日志不合法", publish: false, truthful: "run 日志里有非法事件形状，需人工查证" },
};

/**
 * run 制品的**受验路径投影**：所有按 key 派生路径的原语在任何 I/O 之前共用它 ——
 * key 不是 claim key 的形状就没有路径可言（评审实测 key="../../secret" 读出了 runsDir 外的文件）。
 */
export function runPaths({ runsDir, key } = {}) {
  if (typeof runsDir !== "string" || runsDir.length === 0) return { ok: false, reason: "runs_dir_missing", why: "没有 runsDir" };
  if (typeof key !== "string" || !CLAIM_KEY_SHAPE.test(key)) return { ok: false, reason: "key_shape", why: "key 不是 claim key 的形状" };
  const at = (suffix) => path.join(runsDir, key + suffix);
  return { ok: true, jsonl: at(".jsonl"), receipt: at(PUBLISHED_MARK), ledger: at(".publish-failed.json"), claim: at(".publish-claim.json") };
}

/**
 * 原子落盘的**中间态**探测：`<key><suffix>.tmp.*` 在场 = 上一次写到一半（发布返回之后、
 * rename 之前停住）。评审实测：临时回执被认出后又被忽略，run 被列成待发布再发一次。
 * 有它就是"状态未闭合"，读方一律 fail-closed。目录读不出也算说不清。
 */
function inFlightSidecar({ runsDir, key, suffix }) {
  const prefix = key + suffix + ".tmp.";
  try { return { name: fs.readdirSync(runsDir).find((n) => n.startsWith(prefix)) ?? null }; }
  catch (err) { return err.code === "ENOENT" ? { name: null } : { error: String(err.code ?? err.message) }; }
}

/**
 * 发布失败的重试账 —— **严格分态**：它决定还许不许自动重试。
 *   absent     —— 没失败过
 *   valid      —— 排空写的账：键集封闭、run_id===key、attempts 安全整数≥1、at 规范、source 受控
 *   reserved   —— 预留了尝试却没闭合（reserved / delivered_unrecorded）：送达状态不确定
 *   legacy     —— watcher 写的旧形状（不带次数）—— "watcher 发过又失败"的证据，带 kind：
 *                 publish_error {at, error} / reap_lock_held {at, reason:"reap_lock_held", detail}
 *   unreadable —— 坏 JSON / 目录 / 权限 / 形状不对 —— 说不清
 */
export function readPublishLedger({ runsDir, key }) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) return { state: "unreadable", why: p.why };
  const inFlight = inFlightSidecar({ runsDir, key, suffix: ".publish-failed.json" });
  if (inFlight.error) return { state: "unreadable", why: "runs 目录读不出（" + inFlight.error + "）" };
  if (inFlight.name) return { state: "unreadable", why: "重试账写到一半（" + inFlight.name + "）—— 状态未闭合" };
  let raw;
  try { raw = fs.readFileSync(p.ledger, "utf-8"); }
  catch (err) { return err.code === "ENOENT" ? { state: "absent", attempts: 0 } : { state: "unreadable", why: String(err.code ?? err.message) }; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return { state: "unreadable", why: "不是 JSON" }; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { state: "unreadable", why: "不是记录对象" };
  if (doc.schema_version === "1.0") {
    const keys = Object.keys(doc).sort().join(",");
    if (keys !== "at,attempts,error,run_id,schema_version,source") return { state: "unreadable", why: "重试账键集不对" };
    if (doc.run_id === key && Number.isSafeInteger(doc.attempts) && doc.attempts >= 1 && isCanonicalIso(doc.at)
      && doc.source === "drain-run-channel" && (doc.error === null || typeof doc.error === "string")) {
      if (doc.error === "reserved" || (typeof doc.error === "string" && doc.error.startsWith("delivered_unrecorded"))) {
        return { state: "reserved", attempts: doc.attempts, error: doc.error };
      }
      return { state: "valid", attempts: doc.attempts, error: doc.error };
    }
    return { state: "unreadable", why: "重试账形状不对" };
  }
  // watcher 写的两种旧形状 —— **封闭联合，照写方原样，不多不少**：
  //   publish_error   {at, error}                       error 非空字符串
  //   reap_lock_held  {at, reason: "reap_lock_held", detail}   detail 字符串或 null
  // 任何别的 reason、缺 detail、detail 类型不对都不是真实写方的产物 → 说不清。
  const legacyKeys = Object.keys(doc).sort().join(",");
  if (!isCanonicalIso(doc.at)) return { state: "unreadable", why: "重试账形状不认识" };
  if (legacyKeys === "at,error" && typeof doc.error === "string" && doc.error.length > 0) {
    return { state: "legacy", kind: "publish_error", attempts: 1, error: doc.error };
  }
  if (legacyKeys === "at,detail,reason" && doc.reason === "reap_lock_held"
    && (doc.detail === null || typeof doc.detail === "string")) {
    return { state: "legacy", kind: "reap_lock_held", attempts: 1, error: "reap_lock_held" + (doc.detail ? "：" + doc.detail : "") };
  }
  return { state: "unreadable", why: "重试账形状不认识" };
}
/** 原子落账；写不进去要报出来 —— 账本更新不了就不许再自动尝试。 */
export function writePublishLedger({ runsDir, key, attempts, error }) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) return { ok: false, why: p.why };
  const tmp = p.ledger + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schema_version: "1.0", run_id: key, attempts,
      at: new Date().toISOString(), source: "drain-run-channel", error: error ?? null }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, p.ledger);
    return { ok: true };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力 */ }
    return { ok: false, why: String(err?.code ?? err?.message ?? err).slice(0, 120) };
  }
}

/**
 * 账本对"还许不许自动发"的**唯一投影** —— 排空与直发 CLI 共用（评审实测直发入口不看账本，
 * 把送达状态未知的一条列成"待发布"诱导重发）。null = 可以发。
 */
export function publishHold(ledger) {
  // **封闭的联合**：只有 absent 与预算未耗尽的 valid 才放行；任何不认识的形状都是说不清 ——
  // 新增一个状态不会默认掉进"可以发"。
  if (ledger && ledger.state === "absent" && ledger.attempts === 0) return null;
  if (ledger && ledger.state === "valid" && Number.isSafeInteger(ledger.attempts) && ledger.attempts >= 1) {
    if (ledger.attempts >= RUN_PUBLISH_MAX_ATTEMPTS) return { reason: "retry_exhausted", why: "已失败 " + ledger.attempts + " 次，自动重试预算耗尽" };
    return null;
  }
  if (ledger && ledger.state === "reserved") return { reason: "reservation_unresolved", why: "上次尝试没闭合（" + ledger.error + "）—— 送达状态不确定，先去话题核对" };
  if (ledger && ledger.state === "legacy" && (ledger.kind === "publish_error" || ledger.kind === "reap_lock_held")) {
    return { reason: "watcher_publish_failed", kind: ledger.kind, why: ledger.error };
  }
  return { reason: "ledger_unreadable", why: ledger?.why ?? ("账本状态不认识：" + String(ledger?.state)) };
}

/** 一条 run 的展示/发布判定 —— 所有读 run 的入口共用这一份。 */
function describeRun({ key, logPath, outcome, receipt, ledger }) {
  const pres = PRESENTATION[outcome.state] ?? PRESENTATION.missing;
  // 回执说不清时**两头都不许**：不发（可能双发）、也不当已发（可能漏发）。
  const eligible = pres.publish && receipt.state === "absent";
  const hold = eligible ? publishHold(ledger) : null;
  return {
    key, logPath, state: outcome.state, reason: outcome.reason ?? null, label: pres.label,
    eligible,                       // 终局且回执 absent（排空自己再按账本分类）
    hold,                           // 账本投影：非 null 时不许普通发布
    shouldPublish: eligible && hold === null,
    alreadyPublished: receipt.state === "valid",
    receiptUnreadable: receipt.state === "unreadable" ? (receipt.why ?? "说不清") : null,
    ledger, truthful: pres.truthful,
    finalText: outcome.finalText ?? null,
    deniedTools: outcome.deniedTools ?? null,
  };
}

/**
 * **一次读取的 run 快照**：outcome、正文、摘要全部来自同一份字节。
 * watcher 终局与排空发布都用它 —— 核验一份、发布另一份是评审实测击穿过的形状。
 */
export function readRunSnapshot({ runsDir, key }) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) return { ok: false, reason: p.reason, why: p.why };
  let bytes;
  try { bytes = fs.readFileSync(p.jsonl); }
  catch (err) { return { ok: false, reason: err.code === "ENOENT" ? "missing" : "unreadable", why: String(err.code ?? err.message) }; }
  const outcome = parseRunOutcome(bytes.toString("utf-8"));
  const receipt = readRunReceipt({ runsDir, key });
  const ledger = readPublishLedger({ runsDir, key });
  let modifiedAt = null;   // 制品最后写入时间：状态页算"最老一条等了多久"用；拿不到就 null，不猜
  try { modifiedAt = fs.statSync(p.jsonl).mtimeMs; } catch { /* 留 null */ }
  return { ok: true, bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
    run: { ...describeRun({ key, logPath: p.jsonl, outcome, receipt, ledger }), modifiedAt }, receipt, ledger };
}

/** 终局凭据绑定的**路由投影**摘要：绑定、会话、来源代际、解析后的目标 —— 写方与读方共用。 */
export function runRouteSha256({ bindingId, claudeSessionId, originGenerationId, rootMessageId }) {
  return createHash("sha256").update(JSON.stringify({
    binding_id: bindingId ?? null, claude_session_id: claudeSessionId ?? null,
    origin_channel_generation_id: originGenerationId ?? null, root_message_id: rootMessageId ?? null,
  })).digest("hex");
}

// runs 目录里受控的条目形状（key + 已知 sidecar；.tmp.* 是原子落盘的中间态）。
const RUN_ENTRY_RE = /^([0-9a-f]{64})\.(jsonl|published\.json|publish-failed\.json|publish-claim\.json|publish-claim\.json\.reaplock|stderr\.log|watch\.log|forward\.jsonl|forward\.stderr\.log|(?:published\.json|publish-failed\.json)\.tmp\.[^/]+)$/u;
// delivery-claims 目录里受控的条目形状。
const CLAIM_ENTRY_RE = /^([0-9a-f]{64})\.(claim|handed_off\.json|failed\.json|notes\.log)$/u;

/**
 * runs 账本的**联合盘点**：以第一次目录快照驱动，对 JSONL、终局记录、发布回执、失败账
 * 做 key 并集 —— 任何孤儿 sidecar、不可读的终局记录、**不认识的条目**都进 problems
 * （评审实测 bad.jsonl / bad.handed_off.json 直接消失）。只有 ENOENT 算空。
 */
export function inventoryRuns({ runsDir, claimsDir = null }) {
  const problems = [];
  let entries;
  try {
    const st = fs.statSync(runsDir);
    if (!st.isDirectory()) return { ok: false, reason: "runs_not_a_directory", runs: [], problems: [] };
    entries = fs.readdirSync(runsDir);   // 这份快照驱动后面的一切，不再二次读目录
  } catch (err) {
    if (err.code === "ENOENT") entries = [];
    else return { ok: false, reason: "runs_unreadable", error: String(err.code ?? err.message), runs: [], problems: [] };
  }
  const byKey = new Map();
  const note = (key, kind) => { if (!byKey.has(key)) byKey.set(key, new Set()); byKey.get(key).add(kind); };
  for (const name of entries) {
    if (name.startsWith(".")) continue;   // 系统隐藏文件（.DS_Store 之类）不是制品
    const m = RUN_ENTRY_RE.exec(name);
    if (!m) { problems.push({ key: null, reason: "unrecognized_entry", why: "runs/" + name.slice(0, 80) }); continue; }
    note(m[1], m[2]);
  }
  if (claimsDir) {
    let names = [];
    try { names = fs.readdirSync(claimsDir); }
    catch (err) { if (err.code !== "ENOENT") problems.push({ key: null, reason: "claims_unreadable", why: String(err.code ?? err.message) }); }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const m = CLAIM_ENTRY_RE.exec(name);
      if (!m) { problems.push({ key: null, reason: "unrecognized_entry", why: "delivery-claims/" + name.slice(0, 80) }); continue; }
      if (m[2] !== "handed_off.json" && m[2] !== "failed.json") continue;   // claim 目录先于 run 存在，不参与孤儿判定
      note(m[1], "terminal");
      // 盘点只验"是不是一条记录"（非数组对象）；授权语义留给 readTerminalRecord。
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(claimsDir, name), "utf-8")); }
      catch (err) { problems.push({ key: m[1], reason: "terminal_unreadable", why: name + "：" + String(err.code ?? "不是 JSON") }); continue; }
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        problems.push({ key: m[1], reason: "terminal_unreadable", why: name + "：不是记录对象" });
      }
    }
  }
  const runs = [];
  for (const [key, kinds] of byKey) {
    if (!kinds.has("jsonl")) {
      // 没有 run 制品却有它的终局记录 / 回执 / 失败账 —— 孤儿，不能消失。
      const which = [...kinds];
      if (kinds.has("terminal")) problems.push({ key, reason: "orphan_terminal_record", why: "run 制品缺席，只剩：" + which.join("、") });
      else if ([...kinds].some((k) => k.startsWith("published.json") || k.startsWith("publish-failed.json"))) {
        problems.push({ key, reason: "orphan_sidecar", why: "run 制品缺席，只剩：" + which.join("、") });
      }
      continue;
    }
    const snap = readRunSnapshot({ runsDir, key });
    if (!snap.ok) { problems.push({ key, reason: "run_unreadable", why: snap.why }); continue; }
    if (snap.run.state === "invalid") problems.push({ key, reason: "invalid_jsonl", why: snap.run.reason ?? "非法事件形状" });
    if (snap.run.receiptUnreadable) problems.push({ key, reason: "receipt_unreadable", why: snap.run.receiptUnreadable });
    runs.push(snap.run);
  }
  runs.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { ok: true, runs, problems };
}

/** 旧入口：只给 runs 列表（目录读不出就是 []）。新代码用 inventoryRuns，problems 不能丢。 */
export function scanRuns({ runsDir }) {
  return inventoryRuns({ runsDir }).runs;
}

// readPublished 已被回执三态取代 —— "存在即已发"的判法把缺字段的回执
// 静默当成已送达，一条 run 结果就此永久消失（评审同款缺陷在 scanRuns 这层的分身）。

/** 发布后落标记，防止同一个 run 被重复发布到话题里。 */
/**
 * run 结果的**发布前原子 claim**。
 *
 * 回执（markPublished）写在发送**之后** —— 只有回执的话，两个并发 watcher
 * 会同时读到 shouldPublish、各发一张，评审实测真实双发。
 * claim 用 mkdir 的原子性在发送**之前**互斥；发完写回执再撤 claim。
 *
 * **协议是三步，缺一不可**：claim → **复核回执** → 发送。
 * 只有 claim 不够：A 发完释放 claim 后，晚到的 B 能拿到新 claim ——
 * 而 B 的 shouldPublish 是在 A 完成前读的（评审场景实测）。
 * claim 后复核回执才把这个窗口关上。
 *
 * **崩溃窗口仍是 at-least-once**（与全线口径一致）：发出后、写回执前崩掉，
 * claim 过期（stale）后会被接管重发。不存在"零双发"，只有"并发不双发"。
 */
export function claimRunPublish({ runsDir, key, staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) return { ok: false, reason: p.reason, error: p.why };
  const file = p.claim;
  const reapLock = file + ".reaplock";
  const token = randomUUID();
  const attempt = () => {
    try {
      // wx 单步原子创建（两步 mkdir+owner 被实测在步间抢占过）。
      fs.writeFileSync(file,
        JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), token }) + "\n",
        { flag: "wx", mode: 0o600 });
      return { ok: true, file, token };
    } catch (err) {
      if (err.code === "EEXIST") return { ok: false, reason: "claimed_by_other" };
      return { ok: false, reason: "io_error", error: String(err.message).slice(0, 200) };
    }
  };
  const readOwner = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
  };
  const isStale = (owner) => {
    // **只接管死进程**：活着的 owner 即使超龄也不抢 —— 没有 lease/heartbeat
    // 就凭年龄抢活人，会顶掉慢的合法持有者（评审点名）。
    if (owner && Number.isFinite(owner.pid)) {
      try { process.kill(owner.pid, 0); return false; } catch { return true; }
    }
    try { return now - fs.statSync(file).mtimeMs > staleMs; } catch { return false; }
  };

  const first = attempt();
  if (first.ok || first.reason !== "claimed_by_other") return first;
  const seen = readOwner();
  if (!isStale(seen)) return first;

  // ■ stale 接管：**必须串行**（评审实测三个教训堆在这一段上）
  //
  //   · "判 stale → rm → wx"：后到者的 rm 删掉先到者刚创建的新 claim，
  //     64 个接管者出了 3 个 winner。
  //   · 换成 rename 摘除：rename 按**路径**不按 inode —— 后到者照样把
  //     winner 的新 claim 重命名走，16 个里出了 5 个 winner。
  //   · 所以移除动作本身要独占：reap 锁（wx 单步）串行化接管，
  //     持锁者**重读并核对还是刚才那一代**（token 比对）才许移除。
  //     核对失败 = 有人已经接上了 —— 放手认输。
  try {
    fs.writeFileSync(reapLock,
      JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + "\n",
      { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") return { ok: false, reason: "io_error", error: String(err.message).slice(0, 200) };
    // **reap 锁不在热路径自愈。**上一版按 mtime 超时"判旧 → rm → wx"再抢 ——
    // 评审固定时序复现：内层接管者夺锁建了新 claim，外层拿着旧核对结果
    // 把它删掉再建自己的 —— 两个 ok:true。同一个反模式在低一层复发，
    // 递归不会收敛。所以：**reap 锁存在即 fail-closed**，
    // 崩溃残留（双重退化情形）交给显式维护清理，不在这里赌。
    // **只指向显式维护入口，不给"人工删除"的旁路** —— 直接 rm 绕过维护互斥，
    // 两个操作者又能重现"删掉新活锁"的竞态（评审点名）。
    return { ok: false, reason: "reap_lock_held",
      detail: "接管互斥锁被占（或为崩溃残留）：" + reapLock +
        " —— 用显式维护入口 repair-run-claim.mjs 处理，不要直接删除" };
  }
  try {
    const current = readOwner();
    // **代际核对**：还是我刚才判 stale 的那一代才许动手。
    if (!current || current.token !== seen?.token || !isStale(current)) {
      return { ok: false, reason: "claimed_by_other" };
    }
    fs.rmSync(file, { force: true });
    return attempt();
  } finally {
    fs.rmSync(reapLock, { force: true });
  }
}

/**
 * 回执三态。**存在 ≠ 有效送达**（评审点名：existsSync 会把空文件、坏 JSON、
 * 目录都说成"已送达"，结果被永久跳过）。
 *   absent     —— 没有回执，可以发
 *   valid      —— 结构合法（有 published_at），确实送达过
 *   unreadable —— 有东西但说不清 —— **fail-closed，别发也别当送达**，要报警
 */
export function readRunReceipt({ runsDir, key } = {}) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) return { state: "unreadable", why: p.why };
  // 发布返回之后、rename 之前停住的临时回执 = 送过但没闭合：既不能当没送、也不能当送达。
  const inFlight = inFlightSidecar({ runsDir, key, suffix: PUBLISHED_MARK });
  if (inFlight.error) return { state: "unreadable", why: "runs 目录读不出（" + inFlight.error + "）" };
  if (inFlight.name) return { state: "unreadable", why: "回执写到一半（" + inFlight.name + "）—— 送达状态未闭合", phase: "in_flight" };
  const file = p.receipt;
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); }
  catch (err) {
    return err.code === "ENOENT" ? { state: "absent" }
      : { state: "unreadable", why: String(err.code ?? err.message) };
  }
  try {
    const doc = JSON.parse(raw);
    // published_at 必须是规范时间 —— "非空字符串"会让 {"published_at":"不是时间"}
    // 冒充合法回执，一条 run 被永久跳过（同一族判据错误的又一处）。
    if (doc && typeof doc === "object" && !Array.isArray(doc)
      && isCanonicalIso(doc.published_at)) {
      return { state: "valid", publishedAt: doc.published_at,
        messageId: doc.feishu_message_id ?? null };
    }
    return { state: "unreadable", why: "结构不合法" };
  } catch {
    return { state: "unreadable", why: "不是 JSON" };
  }
}

/**
 * **只释放自己的代际。**release 带 token：不带或对不上就不动 ——
 * 否则旧持有者能删掉接管者刚创建的新 claim（评审点名）。
 */
export function releaseRunPublishClaim({ runsDir, key, token } = {}) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) return false;
  const file = p.claim;
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (owner?.token !== token) return false;
  } catch { return false; }
  fs.rmSync(file, { force: true });
  return true;
}

export function markPublished({ runsDir, key, messageId }) {
  const p = runPaths({ runsDir, key });
  if (!p.ok) throw new Error("markPublished：" + p.why);
  const file = p.receipt;
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    published_at: new Date().toISOString(),
    feishu_message_id: messageId ?? null,
  }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 生成发布草稿。刻意保持确定性、不调模型 —— 摘要质量交给上游，
 * 但「说的是不是实话」这件事必须由确定性代码保证。
 */
export function buildDraft(run, { taskName }) {
  const head = taskName + " · " + run.label;

  if (run.state === "completed") {
    return [head, "", truncate(run.finalText, 1200)].join("\n");
  }
  if (run.state === "blocked") {
    return [
      head, "",
      "任务**没有完成**。以下工具被权限拦下：" + (run.deniedTools ?? []).join("、"),
      "",
      "任务自述：", truncate(run.finalText, 600),
      "",
      "需要放行相应权限后重新下达指令。",
    ].join("\n");
  }
  if (run.state === "failed") {
    return [
      head, "",
      "任务以失败收场，没有可采信的产出。",
      run.finalText ? "\n错误信息：" + truncate(run.finalText, 600) : "",
    ].join("\n");
  }
  return null; // running / missing 不产出草稿
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + "\n…（已截断）";
}

/**
 * 两个发送入口共用的前置校验。**发之前**确认凭据属于配置说的那个应用。
 *
 * 放在这里而不是各写一遍：只钉一个入口，另一个照样会用错的身份发出去，
 * 而已经发出去的消息是撤不干净的。
 */
export const PUBLISH_FAILURE = Object.freeze({
  TRANSIENT: "transient",
  ROOT_OWNED_BY_OTHER_APP: "root_owned_by_other_app",
});

/**
 * 发布失败之后判一次：是**这次不行**，还是**永远不行**。
 *
 * 目前只认一种永久失败：**要回复的根消息是另一个应用建的**。
 * cc2cd 就是这样 —— 它的话题建于切到单智能体方案之前，属于应用 CC；
 * 而现在的发布身份是 M5Claude。换个身份重试同一件事，结果不会变。
 *
 * **只在拿到正面证据时才判永久。**探测本身失败（网络、权限、读不到）一律按瞬时 ——
 * 抑制是有损的，宁可继续重试制造噪音，也不能把一条本可以发出去的内容悄悄扔掉。
 *
 * 探测是**只读**的（messages-mget），而且只在失败路径上跑，happy path 不受影响。
 */
export function classifyPublishFailure({
  rootMessageId, expectedAppId, larkBin, larkHome, profile, timeoutMs, exec = execFileSync,
} = {}) {
  if (!rootMessageId || !expectedAppId) return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "no_evidence" };
  let parsed;
  try {
    const out = exec(
      larkBin ?? "lark-cli",
      ["im", "+messages-mget", "--message-ids", rootMessageId, "--as", "bot", "--json"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
               ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
        timeout: timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    parsed = JSON.parse(out);
  } catch {
    return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "probe_failed" };
  }
  const sender = parsed?.data?.messages?.[0]?.sender;
  if (!parsed?.ok || sender?.id_type !== "app_id" || typeof sender?.id !== "string") {
    return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "probe_inconclusive" };
  }
  if (sender.id === expectedAppId) {
    return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "same_app" };
  }
  return {
    kind: PUBLISH_FAILURE.ROOT_OWNED_BY_OTHER_APP,
    // 只出应用名，不出 app id —— 那是身份标识，状态和日志里都不该出现。
    ownerName: typeof sender.name === "string" ? sender.name.slice(0, 40) : null,
  };
}

function preflight({ configDir, profile, expectedAppId }) {
  // 没给 expectedAppId 就是调用方没打算校验（老配置、测试）—— 不强求；但给了就必须过。
  if (!expectedAppId) return;
  const r = assertPublishIdentity({ configDir, profile, expectedAppId });
  if (!r.ok) throw new Error(identityErrorText(r));
}

/**
 * 把草稿发布到绑定的根话题。
 *
 * 用谁的身份由配置决定（见 chain-template 的 resolveLarkIdentity），代码不认死任何一个：
 * 单智能体方案下就是运输那个 agent 自己，双智能体方案下是一个独立的发布身份。
 * 无论哪种，发之前都会校验「手上这份凭据确实属于配置说的那个应用」。
 */
export function publishDraft({
  profile, rootMessageId, text, card, larkBin, larkHome, expectedAppId, timeoutMs,
}) {
  preflight({ configDir: larkHome, profile, expectedAppId });

  const hasText = typeof text === "string" && text.length > 0;
  const hasCard = card !== null && typeof card === "object" && !Array.isArray(card);
  if (hasText === hasCard) {
    throw new Error("发布内容必须且只能提供 text 或 card 其中一个");
  }

  const contentArgs = hasCard
    ? ["--msg-type", "interactive", "--content", JSON.stringify(card)]
    : ["--text", text];

  // 必须显式指定二进制和配置目录：守望者是在 M5Claude 的清洗环境里被拉起的，
  // 那里 lark-cli 被重定向到按 agent 隔离的配置目录（只有 platform-bot），
  // 靠环境里“恰好是什么”会拿到错误的身份，实测就是这么发布失败的。
  //
  // 变量名是 LARKSUITE_CLI_CONFIG_DIR。**曾经写的是 LARKSUITE_CLI_HOME，那个变量
  // 在 lark-cli 里根本不存在**（2026-08-20 在二进制里数过：0 次），所以这道保护
  // 一直在空转 —— 出站之所以没出事，只是因为终端里的默认配置目录恰好就是对的。
  // 一个不存在的环境变量不会报错，只会安静地什么都不做。
  const out = execFileSync(
    larkBin ?? "lark-cli",
    ["im", "+messages-reply", "--message-id", rootMessageId, "--as", "bot",
     "--reply-in-thread", ...contentArgs, "--json"],
    { encoding: "utf-8",
      // stderr 要捕获而不是继承。默认继承时 lark-cli 的报错 JSON 会直接喷进
      // 调用方的 stderr —— 出站发布器现在跑在会话结束钩子里，那等于喷到 Frank 的终端上。
      // 失败信息不会丢：execFileSync 抛出的 error 上带着 stdout/stderr。
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
             ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
      // 会话结束钩子会传一个更短的超时：那条路径卡住的是 Frank 的终端，
      // 不能为了发一条进展让他的会话吊在那里。发不出去就留在 outbox 等兜底定时器。
      timeout: timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  if (!parsed?.ok) throw new Error("发布失败: " + JSON.stringify(parsed?.error ?? parsed).slice(0, 300));
  return parsed.data?.message_id ?? null;
}

/**
 * 往群里发一条**新**消息，用来建立一个项目的根话题。
 *
 * 跟 publishDraft 分开而不是加个开关：那个函数只往已知话题里回复，是每天跑几十次的
 * 常规路径；这个是每个项目一辈子一次的建话题动作，而且失败方式完全不同 ——
 * 发重了会在群里留下一个撤不干净的孤儿话题。所以这里必须带幂等键，那个不需要。
 *
 * idempotencyKey 由调用方按项目绝对路径算，去重发生在**平台侧**：
 * 本地锁挡不住「消息发出去了、配置没写成」这种崩溃，平台侧幂等挡得住。
 */
export function sendToChat({ profile, chatId, text, idempotencyKey, larkBin, larkHome, expectedAppId, timeoutMs }) {
  preflight({ configDir: larkHome, profile, expectedAppId });

  const args = ["im", "+messages-send", "--chat-id", chatId, "--as", "bot", "--text", text, "--json"];
  if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);

  const out = execFileSync(larkBin ?? "lark-cli", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
           ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
    timeout: timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  if (!parsed?.ok) throw new Error("建话题失败: " + JSON.stringify(parsed?.error ?? parsed).slice(0, 300));
  const id = parsed.data?.message_id;
  // 拿不到 message_id 就等于没有根话题，后面所有出站都发不出去。
  // 这里 fail-closed：宁可报错让人重来，也不要写一份指向 null 的绑定。
  if (typeof id !== "string" || !id.startsWith("om_")) {
    throw new Error("建话题成功但没拿到 om_ 消息 id：" + JSON.stringify(parsed.data ?? {}).slice(0, 200));
  }
  return id;
}

// ---------- CLI ----------

/**
 * 直发 CLI 的参数：**严格白名单**。它会真的发消息 —— 未知 / 重复 / 缺值 / 位置参数一律拒绝
 * （评审探针：`--root /x --publish` 写成空格形式时静默回落到仓库自身并真实发布）。
 * 发布模式要求 --root 显式、绝对，且 --key 必须是精确的完整 key。
 */
export function parseDirectPublishArgs(tokens) {
  const seen = new Map();
  for (const t of tokens) {
    if (typeof t !== "string" || !t.startsWith("--")) return { ok: false, reason: "unexpected_argument", detail: t };
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
    const value = eq >= 0 ? t.slice(eq + 1) : true;
    if (seen.has(name)) return { ok: false, reason: "duplicate_option", detail: t };
    if (name === "publish") { if (value !== true) return { ok: false, reason: "option_takes_no_value", detail: t }; }
    else if (name === "root" || name === "key") {
      if (value === true || value === "") return { ok: false, reason: "option_needs_value", detail: t };
    } else return { ok: false, reason: "unknown_option", detail: t };
    seen.set(name, value);
  }
  const publish = seen.get("publish") === true;
  const root = seen.get("root") ?? null;
  const key = seen.get("key") ?? null;
  if (root !== null && !path.isAbsolute(root)) return { ok: false, reason: "root_not_absolute", detail: root };
  if (key !== null && publish && !CLAIM_KEY_SHAPE.test(key)) return { ok: false, reason: "key_not_exact", detail: key };
  if (publish && root === null) return { ok: false, reason: "root_required_for_publish" };
  return { ok: true, publish, root, key };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseDirectPublishArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("参数不对（" + parsed.reason + (parsed.detail ? "：" + parsed.detail : "") +
      "）—— 白名单：--root=<绝对路径> --key=<key> --publish；发布模式必须给 --root，--key 须是完整 key。");
    process.exit(2);
  }
  const ROOT = parsed.root ?? moduleRoot(import.meta.url, "..");
  const RT = path.join(ROOT, ".runtime-data", "inbound");
  const runsDir = path.join(RT, "runs");
  const cfg = JSON.parse(fs.readFileSync(path.join(RT, "chain-config.json"), "utf-8"));
  const mapping = JSON.parse(fs.readFileSync(path.join(RT, "active-mapping.json"), "utf-8"));
  const doPublish = parsed.publish;
  const only = parsed.key ?? "";

  // 与排空同一份盘点与账本投影：账本说不清 / 送达状态不确定的一条不许被列成"待发布"。
  const inv = inventoryRuns({ runsDir, claimsDir: path.join(RT, "delivery-claims") });
  if (!inv.ok) { console.error("runs 账本说不清（" + inv.reason + (inv.error ? "：" + inv.error : "") + "）—— 没有发送。"); process.exit(1); }
  for (const p of inv.problems) console.error("说不清 " + (p.key ? p.key.slice(0, 8) : "--------") + " " + p.reason + (p.why ? "：" + p.why : ""));
  const runs = inv.runs.filter((r) => !only || (doPublish ? r.key === only : r.key.startsWith(only)));

  for (const r of runs) {
    console.log([r.key.slice(0, 8), r.state.padEnd(9),
      r.shouldPublish ? "待发布" : r.hold ? "待人工（" + r.hold.reason + "）" : r.alreadyPublished ? "已发布"
        : r.receiptUnreadable ? "说不清（" + r.receiptUnreadable + "）" : "不发布",
      "| " + r.truthful].join(" "));
  }

  const pending = runs.filter((r) => r.shouldPublish);
  // 普通 --publish 不许覆盖账本或说不清的回执：送达状态未闭合的内容重发要走显式的人工核对，不在这里。
  const held = runs.filter((r) => r.hold || r.receiptUnreadable);
  if (doPublish && held.length > 0) {
    console.error("拒绝发布 " + held.map((r) => r.key.slice(0, 8) + "（" +
      (r.hold ? r.hold.reason + "：" + r.hold.why : "回执说不清：" + r.receiptUnreadable) + "）").join("、") +
      " —— 先去话题核对送达状态；这个入口不提供覆盖。");
    process.exitCode = 1;
  }
  if (!doPublish) {
    console.log("\n待发布 " + pending.length + " 条（加 --publish 才真的发送）");
    for (const r of pending) {
      console.log("\n--- 草稿 " + r.key.slice(0, 8) + " ---");
      console.log(buildDraft(r, { taskName: cfg.task_display_name }));
    }
  } else {
    // 项目文件映射的字段名是 root_message_id；登记表投影出来的是 feishu_root_message_id_reference。
    const root = mapping.feishu_root_message_id_reference ?? mapping.root_message_id;
    if (!root) throw new Error("mapping 里没有根话题消息 ID，无法发布");
    const { composeOutboundCard } = await import("./outbound-card.mjs");
    for (const r of pending) {
      const text = buildDraft(r, { taskName: cfg.task_display_name });
      if (!text) continue;
      // **发布前 claim、claim 后重读回执、最后才发** —— 跟 run 通道、转交共用同一笔所有权。
      const claim = claimRunPublish({ runsDir, key: r.key });
      if (!claim.ok) { console.error("跳过 " + r.key.slice(0, 8) + "：所有权被占（" + claim.reason + "）" + (claim.detail ? " " + claim.detail : "")); continue; }
      try {
        const receipt = readRunReceipt({ runsDir, key: r.key });
        if (receipt.state !== "absent") {
          console.error("跳过 " + r.key.slice(0, 8) + "：claim 后重读回执为 " + receipt.state + (receipt.phase ? "（" + receipt.phase + "）" : "") + " —— 不发");
          continue;
        }
        // **claim 内重读账本**：启动扫描到拿到 claim 之间账本可能已变成 reserved（评审探针）——
        // 有约束力的判断只认 claim 之内的新鲜快照，与排空同一形状。
        const hold = publishHold(readPublishLedger({ runsDir, key: r.key }));
        if (hold) {
          console.error("跳过 " + r.key.slice(0, 8) + "：claim 后重读账本 " + hold.reason + "（" + hold.why + "）—— 不发");
          process.exitCode = 1;
          continue;
        }
        const mid = publishDraft({
          profile: cfg.lark_cli_profile,
          rootMessageId: root,
          card: composeOutboundCard([{
            kind: r.state === "completed" ? "reply" : "risk",
            text,
          }], { taskName: cfg.task_display_name, runtime: "claude" }),
          larkBin: cfg.lark_cli_bin, larkHome: cfg.lark_cli_home });
        markPublished({ runsDir, key: r.key, messageId: mid });
        console.log("已发布 " + r.key.slice(0, 8) + " -> " + mid);
      } finally {
        releaseRunPublishClaim({ runsDir, key: r.key, token: claim.token });
      }
    }
    if (pending.length === 0) console.log("没有待发布内容");
  }
}
