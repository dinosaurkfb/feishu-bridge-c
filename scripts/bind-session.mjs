#!/usr/bin/env node
/**
 * 把**当前这个会话**单独绑到一个飞书话题 —— 同一个项目里可以有多条工作线，各占一个话题。
 *
 * 为什么需要它：「项目 = 目录」这个假设是从写代码来的。写代码时目录确实等于工作范围，
 * 但做研究、写东西、整理资料的人，可能一个文件夹里同时开五条互不相干的线 ——
 * 目录代表不了「在忙哪件事」。Claude 这边最接近「一条工作线」的东西就是会话。
 *
 * **必须在你要绑的那个会话里跑。**它从环境变量认自己：
 *
 *   CLAUDE_CODE_SESSION_ID  这个会话的 uuid
 *   CLAUDE_PID              这个会话的进程 pid（用来交叉核对登记文件）
 *
 * 这一点跟当年那个失败方案是本质区别。当年是从外面**推断**一个 uuid 钉死，过期了没人知道；
 * 现在这个 uuid 是在那条线自己身上读出来的，而且入站找不到它时会明确拒绝，
 * 不会悄悄投给另一条线（见 inbound.mjs 的 bound_session_gone）。
 *
 * 项目级绑定仍然是默认和兜底：没有会话级绑定时，一切照旧。会话级是加法。
 *
 * 用法（在目标会话里）：
 *   node scripts/bind-session.mjs              # 看会做什么
 *   node scripts/bind-session.mjs --apply
 *   node scripts/bind-session.mjs --name "迁移这条线" --apply
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { displaySafe } from "./display-safe.mjs";
import { loadChainTemplate, resolveLarkIdentity } from "./chain-template.mjs";
import { registryPath } from "./registry.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import { isDirectRun } from "./direct-run.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import { wireBind, wireBindAuthoritative, m1aWriteRoute, uncleanWired, emitUncleanReceipt } from "./m1a/wiring.mjs";
import { mutateSidecarEntry, readSidecarStore } from "./m1b/sidecar-store.mjs";
import { loadByEndpoint, resolveLiveId } from "./topic-agent-ledger.mjs";
import { withRegistryTransaction } from "./topic-generation-store.mjs";
import { stableStringify } from "./policy-store/canonical.mjs"; // 值比对用键序无关的规范序列化（同一份，不另写）
import { legacyEndpointId } from "./subscription.mjs";
import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
  newRegistryEntry, readProjectIdentity,
} from "./bind-compose.mjs";

export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
export const PID_ENV = "CLAUDE_PID";

/**
 * 认出「我是谁」。
 *
 * 两个来源交叉核对：环境变量给的 uuid，和按 pid 找到的登记文件里的 uuid。
 * 只信环境变量的话，在一个由别的会话派生出来的子进程里也会读到值 —— 那就绑错线了。
 * 对不上就拒绝，不猜。
 */
export function identifySelf({ env = process.env, sessionsDir } = {}) {
  const sid = env[SESSION_ENV];
  const pid = env[PID_ENV];
  if (typeof sid !== "string" || !sid) {
    return { ok: false, reason: "no_session_env",
      detail: "读不到 " + SESSION_ENV + " —— 这条命令必须在一个 Claude 会话里跑" };
  }
  if (typeof pid !== "string" || !pid) {
    return { ok: false, reason: "no_pid_env", detail: "读不到 " + PID_ENV };
  }

  const dir = sessionsDir ?? path.join(os.homedir(), ".claude", "sessions");
  const file = path.join(dir, pid + ".json");
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { ok: false, reason: "no_session_record",
      detail: "按 pid 找不到会话登记文件：" + file };
  }
  if (rec.sessionId !== sid) {
    return { ok: false, reason: "session_mismatch",
      detail: "环境变量说是 " + sid.slice(0, 8) + "，登记文件说是 " +
        String(rec.sessionId).slice(0, 8) + " —— 对不上就不绑，免得绑错线" };
  }
  if (rec.kind !== "interactive") {
    return { ok: false, reason: "not_interactive",
      detail: "只有交互会话能绑（当前是 " + rec.kind + "）—— 无头会话跑完就没了" };
  }
  return { ok: true, sessionId: sid, pid: Number(pid), name: rec.name, cwd: rec.cwd };
}

/** 会话级那一行 = 项目级那一行 + 会话标识。共用 newRegistryEntry，免得两处各写一份。 */
export function newSessionEntry({ root, name, purpose, token, rootMessageId, claudeSessionId, sessionName, now }) {
  return {
    ...newRegistryEntry({ root, name, purpose, token, rootMessageId, now }),
    // id 要能区分同一个项目下的多条：加会话 uuid 的前 8 位，人看得出、也够唯一。
    id: path.basename(root) + "@" + String(claudeSessionId).slice(0, 8),
    claude_session_id: claudeSessionId,
    claude_session_name: sessionName ?? null,
    note: "会话级绑定（在该会话里用 bind-session 建立）。项目级绑定仍然独立存在、互不影响。",
  };
}

/** 会话级绑定的根消息要说清它跟项目级那条的区别，否则群里两个话题长得一模一样。 */
export function composeSessionRootMessage({ name, purpose, root, token, sessionName }) {
  const base = composeRootMessage({ name, purpose, root, token });
  return base + "\n\n这个话题只对应该项目里的**一条工作线**（会话 " +
    (sessionName ?? "?") + "）。同一个项目的其他会话有各自的话题。";
}

// ---------- CLI ----------

if (isDirectRun(import.meta.url)) {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态

const die = (msg, hint) => {
  console.error(msg);
  if (hint) console.error(hint);
  process.exit(1);
};

const me = identifySelf();
if (!me.ok) die("认不出当前会话（" + me.reason + "）：" + me.detail);

const root = me.cwd;
const tpl = loadChainTemplate();
if (!tpl.ok) {
  die("机器级链路模板不可用（" + tpl.reason + "）",
    "先跑 node scripts/init-chain-template.mjs --apply");
}
const template = tpl.template;

const regFile = registryPath();
let registry = { schema_version: "1.0", projects: [] };
try {
  registry = JSON.parse(fs.readFileSync(regFile, "utf-8"));
  registry.projects ??= [];
} catch { /* 没有登记表就新建 */ }

const already = registry.projects.find((p) => p?.claude_session_id === me.sessionId);
const endpointId = legacyEndpointId({ runtime: "claude", agentUid: template.agent_uid });
// PK2-W1：判源分派。authoritative → 复合写（账本为准，登记表降为索引行）；shadow / 未接入 → 原路径。
const writeRoute = m1aWriteRoute({ endpointId, env: process.env });
/** sidecar 值的**归一 + 键序无关**比对：时间串与写侧的 `isoOf` 同一判据（规范化成 ISO），
 *  对象逐值归一（`{"claim_expires_at":null,"token":…}` 与 `{token, claim_expires_at}` 是同一份现场）。 */
const normSidecarValue = (v) => {
  if (typeof v === "string") return (!Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : v);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normSidecarValue(x)]));
  }
  return v ?? null;
};
const sameSidecarValue = (cur, expected) => stableStringify(normSidecarValue(cur), 0) === stableStringify(normSidecarValue(expected), 0);

/**
 * authoritative 下的**完整性 + 零写屏障**（P1-4 / P1-5①）。返回 `{ok, why, action}`：
 *   · 非 authoritative（shadow / 未接入）→ `{ok:true}`：行为与 main 一致（旧的那条早退）。
 *   · 账本说 **pending** → 条目必须**逐字对**：`pending-claims[ta] = {token: 索引行的 pending_token,
 *     claim_expires_at: null}`、`expiry[ta] = 索引行的 expires_at`（旧版只核"键在不在"）。
 *   · 账本说 **active**（已认领）→ `pending-claims` 里 ta **不在** + `expiry[ta]` 逐字等
 *     （旧版直接 `return true`：expiry 缺失/漂移也被误判完整）。
 *   · **完整时也重做零写屏障**（P1-5①）：调 mutateSidecarEntry 走 `changed:false` 那条路（要的就是
 *     那次目录 fsync —— 上一笔可能正是死在 rename 之后的目录 fsync 上）。屏障失败 = **不算完成**。
 *   · 不完整时的动作分两种：pending → `repair`（走同一幂等复合补齐）；active → `reject`
 *     （**绝不重跑复合** —— 那会把已认领的工作线退回待认领，也会拿索引快照覆盖 parity 侧的事实）。
 */
const authoritativeBindingState = (entry) => {
  if (!entry?.root_message_id) return { ok: false, why: "这条登记行没有根话题", action: "repair" };
  if (writeRoute.mode !== "authoritative") return { ok: true, why: "非 authoritative（行为与 main 一致）", action: null };
  const resolved = resolveLiveId({ endpointId, locator: entry.root_message_id, env: process.env });
  if (!resolved.ok) return { ok: false, why: "账本里定位不到这条根话题（" + String(resolved.reason) + "）", action: "repair" };
  const led = loadByEndpoint(endpointId, { env: process.env });
  if (!led.ok) return { ok: false, why: "账本读不出（" + String(led.reason ?? "unknown") + "）", action: "repair" };
  const rec = led.doc.records[resolved.id];
  if (!rec || rec.kind !== "live") return { ok: false, why: "账本里这条记录不是 live", action: "repair" };
  const active = rec.facts?.binding === "active";
  const ta = resolved.id;
  const expectedExpiry = normSidecarValue(entry.expires_at);
  const expectedClaim = active ? null : { token: entry.pending_token ?? null, claim_expires_at: null };
  // 零写屏障 = 锁内重读 + 逐字比对 + `changed:false`（不写一个字节，只把目录 fsync 补做一次）。
  const barrier = (name, expected) => {
    const r = mutateSidecarEntry({ endpointId, name, key: ta, env: process.env,
      mutate: (cur) => (sameSidecarValue(cur, expected)
        ? { ok: true, changed: false }
        : { ok: false, reason: "sidecar_state_drift", why: name + " 现场值与索引行不符（锁内重读）" }) });
    return r.ok === true ? { ok: true } : { ok: false, why: name + " 没成（" + String(r.reason ?? "unknown") + "）" };
  };
  const bad = [barrier("pending-claims", expectedClaim), barrier("expiry", expectedExpiry)].find((b) => b.ok !== true);
  if (bad !== undefined) {
    return { ok: false, why: bad.why, action: active ? "reject" : "repair", active };
  }
  return { ok: true, why: active ? "已认领、sidecar 与索引逐字一致、屏障已重做" : "待认领、sidecar 与索引逐字一致、屏障已重做", action: null, active };
};
if (already?.root_message_id) {
  const state = authoritativeBindingState(already);
  if (state.ok) {
    console.log("这条会话已经绑过了，没有重复建话题。");
    console.log("  话题  " + already.root_message_id);
    console.log("  入站  " + (already.session_id ? "已绑定" : "待绑定（去话题里 @ 一下）"));
    process.exit(0);
  }
  if (state.action === "reject") {
    die("这条会话的绑定现场与索引行不一致（" + state.why + "）—— 已认领的工作线不会重跑绑定复合",
      "重跑会把它退回待认领并用索引快照覆盖 sidecar；先人工核对 ledger/<endpoint>/ 下的 sidecar，或等 I2/I3 切换后再修。");
  }
  console.log("这条会话的绑定不完整（" + state.why + "）—— 按同一幂等键再跑一次补齐。");
  console.log("  续用原事实：bound_at / expires_at / pending_token（含待认领代际）从既有索引行取，不重新生成。");
}

const identity = readProjectIdentity({ root });
const name = arg("name") ?? (identity.name + " · " + me.name);
const token = bindingToken(root + "#" + me.sessionId);   // 会话级用不同的种子，不跟项目级撞
const idemKey = idempotencyKeyFor(root + "#" + me.sessionId);
const rootText = composeSessionRootMessage({
  name, purpose: identity.purpose, root, token, sessionName: me.name,
});
const statusText = composeStatusMessage({ name });

console.log("会话    " + me.name + "  (" + me.sessionId.slice(0, 8) + ")");
console.log("项目    " + root);
console.log("群      " + displaySafe(template.chat_name) + "  " + template.chat_id);
console.log("\n--- 根消息 ---\n" + rootText);
console.log("\n--- 底下第一条 ---\n" + statusText);
console.log("\n只写一处：" + regFile + "（项目目录里不写任何文件）");
console.log("项目级绑定不受影响 —— 它仍然独立存在，其他会话照旧发到原话题。");

if (!apply) {
  console.log("\n[dry-run] 没有发消息，也没有写文件。加 --apply 才真的做。");
  process.exit(0);
}

const ident = resolveLarkIdentity(template);
const canonicalRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
const bindTarget = { runtime: "claude", project_root: canonicalRoot, claude_session_id: me.sessionId };
// ① 建根话题（幂等键）——两条路径共用一个闭包。失败 → 无任何副作用（不跑后续步骤）。
const createTopic = () => {
  try {
    return { ok: true, root_message_id: sendToChat({
      profile: ident.profile, chatId: template.chat_id, text: rootText,
      idempotencyKey: idemKey, larkBin: ident.bin, larkHome: ident.configDir,
      expectedAppId: ident.expectedAppId,
    }) };
  } catch (err) {
    return { ok: false, reason: "send_failed", message: err.message };
  }
};
const indexEntry = (rootMessageId) => newSessionEntry({
  root, name, purpose: identity.purpose, token, rootMessageId,
  claudeSessionId: me.sessionId, sessionName: me.name,
});
// authoritative 路径用**同一份**条目模版（同一个 now）：索引行里的 expires_at 必须与写进 expiry sidecar
// 的那一个逐字相同 —— 两次各自 newSessionEntry 会让两边差几毫秒。
//
// PK2-W1-fix3 P1：**repair 路径冻结既有索引行**。模板只有两个来源：
//   ① 首跑（索引行不存在）→ `indexEntry(占位)`，也就是新模板；
//   ② 补齐（索引行在，只是现场不完整 / 零写目录屏障没做成）→ **那一行本身**：
//      `bound_at` / `expires_at` / `pending_token`（进而 sidecar 的 expiry / pending-claims 值）
//      一律从既有行取，不重新生成 —— 否则同一条命令的耐久重试会**暗中把授权期限往后延**
//      （旧实现每次 `newSessionEntry()` 都按当时的 `Date.now()` 重算一年期）。
//   冻结粒度是**整行**而不是那三个字段：代际那段（`topic_generation_state` 的 `created_at` /
//   `activity`）同样是 now 派生的，重生成会把同一条工作线变成账本里的另一条 binding。
//   既有行里 `expires_at` 不成形时**不改判**：照旧往下走 → `bad_expires_at` 拒（不静默重铸一个）。
const ROOT_PLACEHOLDER = "om_placeholder";
const indexTemplate = already?.root_message_id ? structuredClone(already) : indexEntry(ROOT_PLACEHOLDER);
// 模板里那个占位根 om → 真 om。**不能只换顶层 root_message_id**：行内嵌的 topic_generation_state 是
//   **这一行自己的**投影，代际里的 root_message_id 也是同一个话题的 om。留着占位的后果是真入口上的：
//   `findPendingBinding` 读 generation.root_message_id → 认领现场指向一个**不存在**的话题
//   （evaluatePromotion 的 matched_om 与 wirePromoteAuthoritative 的 locator 都跟着它），
//   账本侧 resolveLiveId 永远 locator_absent —— 新绑定再也认领不了（真机 2026-09-11 等这单的原因）。
const retargetRoot = (node, rootMessageId) => (node !== null && typeof node === "object"
  ? Array.isArray(node)
    ? node.map((v) => retargetRoot(v, rootMessageId))
    : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "root_message_id" && v === ROOT_PLACEHOLDER ? rootMessageId : retargetRoot(v, rootMessageId)]))
  : node);
// ③ 索引行 upsert（authoritative 路径）：**锁内重读当前文件再局部更新**（不许拿锁外那份快照写回 ——
//   两笔并发 bind 被 outer 串行后，后一笔仍会用陈旧快照盖掉前一笔）。同会话已有行 → 就地覆盖（幂等重跑）。
const publishIndex = ({ rootMessageId }) => {
  const entry = { ...retargetRoot(indexTemplate, rootMessageId), root_message_id: rootMessageId };
  const done = withRegistryTransaction({ regFile, root, mutate: (reg) => {
    const rows = reg.projects;
    const at = rows.findIndex((p) => p?.claude_session_id === me.sessionId || (p?.root === entry.root && p?.id === entry.id));
    if (at >= 0) rows[at] = { ...rows[at], ...entry };
    else rows.push(entry);
    return { ok: true, changed: true };
  } });
  if (!done.ok) return { ok: false, reason: done.reason ?? "registry_unwritable", why: done.error ?? null };
  return { ok: true, count: done.count ?? null };
};
// PK2-W1：判源分派 —— authoritative 走复合（账本先于索引），shadow / 未接入走原路径（一字未改）。
const wired = writeRoute.mode === "authoritative"
  ? wireBindAuthoritative({
      endpointId, env: process.env, externalRequestId: idemKey,
      // lineage 取**会话级**：`basename@<完整会话 UUID>@registry`（P2-2）。
      //   旧形 basename@<sid8>@registry 只用 UUID 前 8 位十六进制 —— 两条会话前缀撞上就是同一条
      //   lineage，而账本一条 lineage 只许一条 live B1（第二条 create_b1 直接 lineage_pending_exists）。
      //   选**完整 UUID**而不是摘要：不引哈希、id 直接对得上那条会话（长度仍受 LINEAGE_SHAPE 128 限）。
      //   与 legacy 快照的 registry 分支（entry.id + "@registry"）不再是同一算法 —— 那只适用于切换前
      //   已存在的旧行，切后新建的以账本这条 lineage 为准。
      lineageId: path.basename(root) + "@" + me.sessionId + "@registry", chatId: template.chat_id, bindingTarget: bindTarget,
      // 待认领值取模版（首跑=新铸；补齐=既有索引行冻结值）——sidecar 两侧据此 changed:false，不重写。
      pendingToken: indexTemplate.pending_token ?? token, expiresAt: indexTemplate.expires_at,
      createTopic, publishIndex,
    })
  : wireBind({
      endpointId,
      env: process.env,
      externalRequestId: idemKey,
      lineageId: path.basename(root) + "@project-files",
      chatId: template.chat_id,
      bindingTarget: bindTarget,
      legacy: () => {
        // ① 建根话题 → ② 登记（entry push + 原子写）。失败 → 话题已在群里，phase=registry（幂等键保重跑不重建）。
        const t = createTopic();
        if (!t.ok) return { ok: false, phase: "send", message: t.message };
        const entry = indexEntry(t.root_message_id);
        registry.projects.push(entry);
        try {
          fs.mkdirSync(path.dirname(regFile), { recursive: true, mode: 0o700 });
          if (fs.existsSync(regFile)) fs.copyFileSync(regFile, regFile + ".prev");
          const tmp = regFile + ".tmp." + process.pid;
          fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
          fs.renameSync(tmp, regFile);
        } catch (err) {
          return { ok: false, phase: "registry", root_message_id: t.root_message_id, message: err.message };
        }
        return { ok: true, root_message_id: t.root_message_id, count: registry.projects.length };
      },
    });
// PK2-W1：unclean 回执**先写** —— 账本已提交而后继失败时，后面那两条 die 分支会 exit；
//   回执不能只长在成功路径上（"不能只靠 doctor 点名"）。
const bindUnclean = uncleanWired(wired);
if (!bindUnclean.clean) emitUncleanReceipt("cli_bind_session", wired, { root, claudeSessionId: me.sessionId, receiptDir: path.join(os.homedir(), ".claude", "feishu-bridge", "receipts") });
if (!wired.ok) {
  // 已启用端点任一取锁/账本/收据异常 → 整笔拒、不写 legacy、不建话题（fail-closed）。
  die("绑定失败（M1a 一致性锁：" + (wired.reason ?? "unknown") + (wired.why ? "；" + wired.why : "") + "）",
    "没有建话题，也没有写登记表。稍后再试一次。");
}
const lr = wired.legacy;
if (!lr.ok) {
  if (lr.phase === "send") die("建话题失败，没有写任何文件：" + lr.message);
  die("话题建好了（" + lr.root_message_id + "）但绑定没落完（停在第 " + String(lr.phase) + " 步：" + lr.message + "）",
    "按同一幂等键重跑这一条命令即可补齐：话题不会重建、账本也不会多记一条。");
}
const rootMessageId = lr.root_message_id;
console.log("\n根话题已建立  " + rootMessageId);
console.log("已登记        " + regFile + "  （现在 " + (lr.count ?? "?") + " 条绑定）");


try {
  const statusId = publishDraft({
    profile: ident.profile, rootMessageId, text: statusText,
    larkBin: ident.bin, larkHome: ident.configDir, expectedAppId: ident.expectedAppId,
  });
  console.log("状态已发布    " + statusId);
} catch (err) {
  console.error("状态回复没发出去：" + err.message);
  console.error("绑定本身已完成，只是这条验证消息没发成。");
}

console.log("\n这条会话已单独接入。本机输入与每轮回答会合成卡片发到新话题，不再进项目那个。");
console.log("入站还差最后一下：去新话题 @ 一下运输 agent（空消息也行）。");
}
