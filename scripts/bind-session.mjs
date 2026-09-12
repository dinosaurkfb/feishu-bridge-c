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
import { loadRegistryStrict, registryPath } from "./registry.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import { isDirectRun } from "./direct-run.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import { wireBind, wireBindAuthoritative, wirePauseResume, wirePauseResumeAuthoritative, m1aWriteRoute, uncleanWired, emitUncleanReceipt } from "./m1a/wiring.mjs";
import { setBindingStatus } from "./feishu-control.mjs";
import { mutateSidecarEntry, readSidecarStore } from "./m1b/sidecar-store.mjs";
import { canonKey, loadByEndpoint, resolveLiveId } from "./topic-agent-ledger.mjs";
import { validateTopicGenerationState, activeGeneration } from "./topic-generation.mjs";
import { withRegistryTransaction, loadClaudeTopicBinding } from "./topic-generation-store.mjs";
import { foldLockReleaseState } from "./maintenance/reaffirm-intents.mjs";
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
// PK2-P2-cleanup ①（Codex #200 P2-①）：启动快照不再裸 JSON.parse —— 复用 loadRegistryStrict
// （与锁内 readRowsNow 同一份判据）：只有 ENOENT 算空表；坏 JSON / 权限错 / 合法 JSON 但形状非法
//（如 projects 非数组）→ fail-closed 点名拒，不得在下面 .find() 处裸抛 TypeError。
const reg0 = loadRegistryStrict(regFile);
if (reg0.ok !== true) {
  die("[bind-session] 登记表读不出（registry_unreadable / " + String(reg0.reason ?? "unknown") + "）："
    + String(reg0.error ?? ""),
    "修好或移走 " + regFile + " 后重跑（登记表坏了不许当空表新建）");
}
const registry = { ...reg0.raw, projects: reg0.projects };   // 沿用旧名（legacy 写路径会 push 进 projects）
const already = registry.projects.find((p) => p?.claude_session_id === me.sessionId);
const endpointId = legacyEndpointId({ runtime: "claude", agentUid: template.agent_uid });
// PK2-W1：判源分派。authoritative → 复合写（账本为准，登记表降为索引行）；shadow / 未接入 → 原路径。
const writeRoute = m1aWriteRoute({ endpointId, env: process.env });

/** PK2-W3-fix4 P1-1：**会话级恢复入口** —— 在这条会话里跑本命令时，若本会话那一行是暂停态，恢复它。
 *
 * 为什么落在这里：feishu-unbind 按 `CLAUDE_CODE_SESSION_ID` 暂停的是**这条工作线的行**；而 bind-project
 * 的“恢复已暂停”支只看 `currentBinding({ root })` / `loadClaudeTopicBinding({ root })`（**项目级**行），
 * 会话级的行在它那里根本选不中 —— 会话级绑定因此只有“暂停”没有“恢复”。恢复是「在那条会话里跑一次」
 * 这件事，入口只能在本文件。判据只看本会话那一行自己的 `topic_generation_state.binding_status`
 * （`paused` = feishu-unbind 写进去的那个值），不猜别的行。 */
const selfSuspended = already?.root_message_id
  ? loadClaudeTopicBinding({ root, claudeSessionId: me.sessionId })
  : { ok: false, reason: "not_bound" };
if (selfSuspended?.ok === true && selfSuspended.state?.binding_status === "paused") {
  console.log("这条工作线的接入此前被暂停，将恢复原话题（不新建）。");
  if (!apply) {
    console.log("\n[dry-run] 什么都没做。加 --apply 才真的恢复。");
    process.exit(0);
  }
  const locator = activeGeneration(selfSuspended.state)?.root_message_id ?? already.root_message_id;
  const runResume = () => setBindingStatus({ root, claudeSessionId: me.sessionId, status: "active" });
  const receiptDir = path.join(os.homedir(), ".claude", "feishu-bridge", "receipts");
  // 与 feishu-unbind 同一分派：authoritative → 账本 restore 先行（再索引）；shadow / 未接入 → 原路径。
  const wiredR = writeRoute.mode === "authoritative"
    ? wirePauseResumeAuthoritative({ endpointId, env: process.env, action: "resume", locator, publishIndex: runResume })
    : wirePauseResume({ endpointId, env: process.env, legacy: runResume });
  if (wiredR.ok !== true) {
    die("恢复中止（M1a 一致性锁：" + (wiredR.reason ?? "unknown") + (wiredR.why ? "；" + wiredR.why : "") + "）",
      "账本与索引都没改写。");
  }
  // P1-4（W3-fix4）：统一 unclean 投影（与 W1 同一份）—— release 不净也要留机器回执；
  //   prepare 就拒的那一支已经 die（什么都没写，不算 unclean）。
  const resumeUnclean = uncleanWired(wiredR);
  if (!resumeUnclean.clean) emitUncleanReceipt("cli_bind_session_resume", wiredR, { root, claudeSessionId: me.sessionId, receiptDir });
  if (wiredR.legacy?.ok !== true) {
    die("恢复没落完（停在第 " + String(wiredR.legacy?.phase ?? "?") + " 步：" + String(wiredR.legacy?.message ?? wiredR.legacy?.reason ?? "")
      + "）。账本可能已提交：**按当前 origin op 证明已提交后补索引**（同一条命令重跑，不重复记）。");
  }
  if (typeof wiredR.commit === "string" && wiredR.commit !== "committed_clean") {
    console.error("注意      这一步有提交不干净（commit=" + wiredR.commit + "）：已落机器回执，先 doctor 核对（恢复本身已完成）。");
  } else if (!resumeUnclean.clean) {
    console.error("注意      排序锁没交还干净：已落机器回执，先 doctor 核对（恢复本身已完成）。");
  }
  console.log("\n已恢复（" + (writeRoute.mode === "authoritative" ? "账本 restore 先行，再改索引" : "原路径") + "）。");
  process.exit(0);
}

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
const authoritativeBindingState = (entry, { barrier = false } = {}) => {
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
  // 只读比对（预览路径用的就是它）：不取 sidecar 锁、不 fsync、不建任何文件 —— 预览必须零写（P1-B）。
  const compare = (name, expected) => {
    const cur = readSidecarStore({ endpointId, name, env: process.env });
    if (cur.ok !== true) return { ok: false, why: name + " 读不出（" + String(cur.reason ?? "unknown") + "）" };
    const present = cur.absent === true ? null : (Object.prototype.hasOwnProperty.call(cur.entries ?? {}, ta) ? cur.entries[ta] : null);
    if (!sameSidecarValue(present, expected)) return { ok: false, why: name + " 现场值与索引行不符" };
    return { ok: true };
  };
  // 零写屏障（只在 --apply、且已在 outer 锁内）：锁内重读 + 逐字比对 + `changed:false`
  //   —— 不写一个字节，要的就是那次目录 fsync（P1-5①：上一笔可能正是死在 rename 之后的目录 fsync 上）。
  const doBarrier = (name, expected) => {
    const r = mutateSidecarEntry({ endpointId, name, key: ta, env: process.env,
      mutate: (cur) => (sameSidecarValue(cur, expected)
        ? { ok: true, changed: false }
        : { ok: false, reason: "sidecar_state_drift", why: name + " 现场值与索引行不符（锁内重读）" }) });
    return r.ok === true ? { ok: true } : { ok: false, why: name + " 没成（" + String(r.reason ?? "unknown") + "）" };
  };
  // 先**只读**比对两项；漂移 → 立即返回（一个字节都不碰：接下来要么拒、要么走补齐复合，
  //   那边的 sidecar 写自带目录 fsync，不需要这里再补屏障）。
  const bad = [compare("pending-claims", expectedClaim), compare("expiry", expectedExpiry)].find((b) => b.ok !== true);
  if (bad !== undefined) {
    return { ok: false, why: bad.why, action: active ? "reject" : "repair", active };
  }
  if (!barrier) {
    return { ok: true, action: null, active, why: (active ? "已认领" : "待认领") + "、sidecar 与索引逐字一致（只读判定）" };
  }
  // 完整时才补那次**零写目录屏障**（P1-5①：上一笔可能正是死在 rename 之后的目录 fsync 上）。
  const barrierBad = [doBarrier("pending-claims", expectedClaim), doBarrier("expiry", expectedExpiry)].find((b) => b.ok !== true);
  if (barrierBad !== undefined) {
    return { ok: false, why: barrierBad.why, action: active ? "reject" : "repair", active };
  }
  return { ok: true, action: null, active, why: (active ? "已认领" : "待认领") + "、sidecar 与索引逐字一致、屏障已重做" };
};

if (already?.root_message_id && !apply) {
  // PK2-W1-fix4 P1-B：预览一律**只读** —— 状态判定不取 sidecar 锁、不 fsync、不建任何文件。
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
  console.log("这条会话的绑定不完整（" + state.why + "）—— 带 --apply 再跑同一条命令补齐。");
  console.log("  续用原事实：bound_at / expires_at / pending_token（含待认领代际）从既有索引行取，不重新生成。");
}
// --apply：既有行只当预览素材；「冻结行 + 完整性 + repair/reject」一律在 outer 锁内定（P1-A，见 decideInLock）。

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
// PK2-W1-fix3 P1 + fix4 P1-A：条目模板**只在 outer 锁内确定**（见 decideInLock）：
//   ① 索引行不存在 → 新模板（`indexEntry(占位)`，首跑）；② 索引行在 → **那一行本身**（冻结
//   `bound_at` / `expires_at` / `pending_token` 与代际那段）。锁外只打印预览，不下任何结论。
//   冻结的意义（fix3）：补齐不许重新 `newSessionEntry()` —— 否则同一条命令的耐久重试会暗中把授权
//   期限往后延，代际那段也会被重生成成账本里的另一条 binding。
const ROOT_PLACEHOLDER = "om_placeholder";
let indexTemplate = null;   // 锁内确定：既有行（冻结）或新模板（首跑）
let frozenRow = null;       // 锁内冻结的那一行（首跑为 null）—— 写索引前的逐字 CAS 基准

const indexEntry = (rootMessageId) => newSessionEntry({
  root, name, purpose: identity.purpose, token, rootMessageId,
  claudeSessionId: me.sessionId, sessionName: me.name,
});

/** P2：repair 依赖的冻结字段**一次性校验**（非法即拒并点名字段）。
 *  不许「缺 pending_token 就回退到新算的 token」—— 那会让索引行仍是 null、sidecar 写的是新 token，
 *  两边永久不一致；代际投影（`topic_generation_state`）是补齐时唯一的话题现场来源，同样要过校验器。 */
const frozenRowProblem = (row) => {
  if (typeof row.root_message_id !== "string" || row.root_message_id.length === 0) return "root_message_id 不是非空字符串";
  if (typeof row.bound_at !== "string" || Number.isNaN(Date.parse(row.bound_at))) return "bound_at 不是时间";
  if (typeof row.expires_at !== "string" || Number.isNaN(Date.parse(row.expires_at))) return "expires_at 不是时间";
  if (typeof row.pending_token !== "string" || row.pending_token.length === 0) return "pending_token 不是非空字符串";
  const st = validateTopicGenerationState(row.topic_generation_state);
  if (st.ok !== true) return "topic_generation_state 不过校验器（" + (st.problems ?? []).join("、") + "）";
  return null;
};

/** 锁内**新鲜读**整份登记表（不用启动时那份快照 —— P1-A 的起点）。
 *  PK2-W1-fix7 P1：复用 `loadRegistryStrict` ——**只有 ENOENT 算空表**；坏 JSON / 权限错 / 形状非法都是
 *  「现场说不清」，**不许静默折成空表**：折了预检就看不见任何行 → 当首跑继续建话题 + create_b1，
 *  最后才被 withRegistryTransaction 拒 —— 那正是本单要收掉的半笔（Codex #198 唯一 P1）。
 *  返回 `{ok:true, rows, missing}` 或 `{ok:false, reason, why}`（调用方自己决定怎么处置）。 */
const readRowsNow = () => {
  const r = loadRegistryStrict(regFile);
  if (r.ok !== true) {
    return { ok: false, reason: r.reason ?? "unreadable", error: r.error ?? null,
      why: "登记表读不出（" + String(r.reason ?? "unknown") + "）：" + String(r.error ?? "") };
  }
  return { ok: true, rows: r.projects ?? [], missing: r.missing === true };
};
/** 锁内新鲜读**本会话**那一行。读不出 → `{ok:false,...}` 原样透传（调用方自己决定拒还是当预览素材）。 */
const readRowNow = () => {
  const r = readRowsNow();
  if (r.ok !== true) return r;
  return { ok: true, row: r.rows.find((p) => p?.claude_session_id === me.sessionId) ?? null, missing: r.missing === true };
};

/** 索引行查找面 + 「同 root+id、异会话」冲突判据 —— **唯一一处**：锁内预检（decideInLock）与写索引
 *  的 CAS 后盾（publishIndex）共用它，免得多一份判据漂移成两套。
 *  先按本会话找，找不到再按 root+id 找；命中的行不属于本会话 → 冲突。
 *  为什么宁拒不猜：`newSessionEntry.id` 只含会话 uuid 的**前 8 位**十六进制 —— 撞上就是真的撞上，
 *  覆盖别人那一行等于把另一条工作线的索引静默抹掉。 */
const indexLookup = (rows, entry) => {
  const own = rows.findIndex((p) => p?.claude_session_id === me.sessionId);
  const at = own >= 0 ? own : rows.findIndex((p) => p?.root === entry.root && p?.id === entry.id);
  const hit = at >= 0 ? rows[at] : null;
  return { at, hit, conflict: at >= 0 && hit?.claude_session_id !== me.sessionId };
};
const conflictWhy = (entry, hit) => "索引行 id（" + String(entry.id) + "）撞上另一个会话的绑定（claude_session_id="
  + String(hit?.claude_session_id ?? "null") + "）—— 绝不覆盖：先处理那条绑定，或换一个会话";

/**
 * PK2-W1-fix4 P1-A：**冻结行在 outer 锁内确定**。整段「读既有行 → 校验冻结字段 → 判完整性 →
 *   决定 repair / reject / 已完成」都跑在 `m1a-order` 锁内（`wireBindAuthoritative` 的 prepare 槽位）：
 *   锁外那份快照只够打印预览。交错场景（另一路 promote 在本进程「读」与「写」之间把这一行改成
 *   active 并删掉待认领条目）因此落在锁之前 —— 锁内重读看得见它，判定成「已完整」→ 零写中止，
 *   既不把 active 覆盖回 pending，也不复活待认领条目。
 *   这里只读（判定用的屏障那次写入属于 --apply 的路径，符合 P1-B：预览零写）。
 * @returns {{ok:true, pendingToken:string, expiresAt:string}|{ok:false, reason:string, why:string}}
 */
const decideInLock = () => {
  const rowsRead = readRowsNow();
  // P1（fix7）：锁内预检**看不见现场**时不许往前走 —— 旧版把坏 JSON/权限错/非法形状静默折成空表，
  //   于是判定成「首跑」、建话题与 create_b1 都落盘，最后才被 withRegistryTransaction 拒（留下半笔：
  //   话题 + 账本 B1，重跑又撞同一张说不清的表）。零写拒绝，理由点名 registry_unreadable。
  if (rowsRead.ok !== true) {
    return { ok: false, reason: "registry_unreadable",
      why: rowsRead.why + " —— 锁内预检不能在读不出登记表的情况下判冲突/首跑（零写：话题 / 账本 / sidecar 一个字节都没写）" };
  }
  const rowsNow = rowsRead.rows;
  const rowNow = rowsNow.find((p) => p?.claude_session_id === me.sessionId) ?? null;
  const firstRun = rowNow === null || !rowNow.root_message_id;
  // PK2-W1-fix6 P1：**异会话 root+id 冲突在锁内 prepare 阶段零写拒绝**。
  //   旧顺序（① 建话题 → ② create_b1 → ③ publishIndex 才发现撞行）的问题不是"发现得晚"，是
  //   **永久卡住**：话题已经进群、账本 B1 已经提交，而重跑还是撞同一行（publishIndex 每次都拒），
  //   于是第二条既不能产生、回退也补不齐。判据与 publishIndex 共用 `indexLookup`（一处，不漂移）。
  //   注意这条判定只看"本会话有没有行"：既有我自己那行 → `indexLookup` 命中 own → 不算冲突
  //   （与 publishIndex 的查找面逐字同口径）。
  const candidate = firstRun ? indexEntry(ROOT_PLACEHOLDER) : rowNow;
  const hit = indexLookup(rowsNow, candidate);
  if (hit.conflict) {
    return { ok: false, reason: "registry_index_conflict",
      why: conflictWhy(candidate, hit.hit) + "（锁内预检：话题 / 账本 / sidecar 一个字节都没写）" };
  }
  if (firstRun) {
    indexTemplate = candidate;                      // 首跑：新模板（now 也在锁内取）
    frozenRow = null;
    return { ok: true, pendingToken: indexTemplate.pending_token, expiresAt: indexTemplate.expires_at };
  }
  const state = authoritativeBindingState(rowNow, { barrier: true });
  if (state.ok === true) return { ok: false, reason: "already_bound", why: state.why };
  if (state.action === "reject") return { ok: false, reason: "binding_state_reject", why: state.why };
  // P2：**只有真要补齐（repair）时**才校验冻结字段 —— 已认领的行 `pending_token` 为 null 是合法的
  //   （token 已被消费），那时既不用它也不改它。非法即拒并点名字段，绝不回退到新算的 token。
  const bad = frozenRowProblem(rowNow);
  if (bad !== null) {
    return { ok: false, reason: "bad_frozen_row",
      why: "既有索引行的冻结字段非法（" + bad + "）—— 拒：不覆盖也不重铸（先人工核对这一行）" };
  }
  console.log("这条会话的绑定不完整（" + state.why + "）—— 按同一幂等键再跑一次补齐。");
  console.log("  续用原事实：bound_at / expires_at / pending_token（含待认领代际）从既有索引行取，不重新生成。");
  frozenRow = rowNow;                               // 补齐路径：冻结这一行
  indexTemplate = rowNow;
  return { ok: true, pendingToken: rowNow.pending_token, expiresAt: rowNow.expires_at };
};

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
// ③ 索引行 upsert（authoritative 路径）：**锁内重读 + 对冻结行逐字 CAS** 才允许覆盖。
//   withRegistryTransaction 自己的锁内重读只保证"读的是最新一版"，不保证"这一行还是我冻结的那一行"——
//   PK2-W1-fix4 P1-A：谁在两拍之间改了这一行（另一路写方/旁路），一律 `cas_mismatch` 拒，不覆盖别人的事实。
const publishIndex = ({ rootMessageId }) => {
  if (indexTemplate === null) {
    return { ok: false, reason: "no_index_template", why: "索引模板还没在锁内确定（prepare 没跑）—— 拒，不写" };
  }
  const entry = { ...retargetRoot(indexTemplate, rootMessageId), root_message_id: rootMessageId };
  const done = withRegistryTransaction({ regFile, root, mutate: (reg) => {
    const rows = reg.projects;
    // PK2-W1-fix5 P1：查找面 + 冲突判据在 `indexLookup`（与锁内预检同一处）——
    //   **命中的不是本会话那一行 → 拒，绝不覆盖**（旧版这条路上会把另一个会话的索引行整行盖掉，
    //   那条工作线静默丢索引）。fix6 起这道闸是**CAS 后盾**：正常路径在锁内预检就拒了，
    //   走到这里说明"预检之后、写之前"有人插了行 —— 照旧拒，不覆盖。
    const { at, hit, conflict } = indexLookup(rows, entry);
    if (conflict) return { ok: false, reason: "registry_index_conflict", why: conflictWhy(entry, hit) };
    if (frozenRow === null) {
      // 首跑：锁内读说"我没有行"，写时却看见**我自己**的行（at>=0 且就是本会话）→ 有人在这两拍之间插了行，不覆盖。
      if (at >= 0) {
        return { ok: false, reason: "cas_mismatch", why: "锁内没有该会话的索引行，写索引时却出现了 —— 不覆盖" };
      }
    } else if (at < 0 || canonKey(rows[at]) !== canonKey(frozenRow)) {
      return { ok: false, reason: "cas_mismatch", why: "索引行在「锁内冻结」与「写索引」之间被改过 —— 不覆盖（先核对再重跑）" };
    }
    if (at >= 0) rows[at] = { ...rows[at], ...entry };
    else rows.push(entry);
    return { ok: true, changed: true };
  } });
  if (!done.ok) return { ok: false, reason: done.reason ?? "registry_unwritable", why: done.why ?? done.error ?? null };
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
      // 待认领值 / 到期值 / 冻结行都由**锁内回调**给（首跑=新铸；补齐=既有行冻结值）——
      // sidecar 两侧据此 changed:false，不重写；锁外那份快照只用于预览（P1-A）。
      prepare: decideInLock,
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
// PK2-W1-fix4 P1-A：锁内判定「已完整」→ 复合**零写**中止（reason=already_bound）——按「已绑过」收口。
//   锁没交还干净时不许报成功（与其它路径同一纪律）；这里也**不发 unclean 回执**（它不是失败）。
if (writeRoute.mode === "authoritative" && wired.reason === "already_bound") {
  const lockState = foldLockReleaseState(wired.release);
  if (lockState !== "released") {
    emitUncleanReceipt("cli_bind_session", wired, { root, claudeSessionId: me.sessionId,
      receiptDir: path.join(os.homedir(), ".claude", "feishu-bridge", "receipts") });
    die("这条会话的绑定已完整，但排序锁没交还干净（" + lockState + "）—— 先 doctor",
      "不要重跑 apply；锁残骸要人工核对。");
  }
  const rowNowBound = readRowNow().row ?? null;
  console.log("这条会话已经绑过了，没有重复建话题。");
  console.log("  话题  " + String(rowNowBound?.root_message_id ?? already?.root_message_id ?? "?"));
  console.log("  入站  " + (rowNowBound?.session_id ? "已绑定" : "待绑定（去话题里 @ 一下）"));
  process.exit(0);
}
// 锁内判定「已认领但现场漂移」→ 拒（与预览路径同一段措辞：绝不重跑复合把已认领的退回待认领）。
if (writeRoute.mode === "authoritative" && wired.reason === "binding_state_reject") {
  die("这条会话的绑定现场与索引行不一致（" + String(wired.why ?? "") + "）—— 已认领的工作线不会重跑绑定复合",
    "重跑会把它退回待认领并用索引快照覆盖 sidecar；先人工核对 ledger/<endpoint>/ 下的 sidecar。");
}
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
