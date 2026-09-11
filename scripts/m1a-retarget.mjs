#!/usr/bin/env node
/**
 * 显式 owner retarget（终端命令）：把一条**项目级** binding_target（`claude_session_id: null`）
 * 改成**会话级**（本机 Claude 会话 uuid）。
 *
 * 为什么只有这一个方向、只有这一个入口：R65 设计里 `null → UUID` 只留给**显式** retarget ——
 * `/feishu-select` 不能填这个字段（那是 Aily 会话，不是本地 Claude uuid），inbound 也不许替人猜一个。
 * 真机 cutover 后 14 条记录全是项目级（会话未选），要让某条工作线落回具体会话，只能由 owner
 * 在终端跑这一条命令；`--apply` 逐次授权。
 *
 * 命令：
 *   node scripts/m1a-retarget.mjs --endpoint <endpoint_id> --id <topic_agent_id> --session <uuid> [--apply]
 *
 * 行为（与 m1a-seed.mjs 同一套纪律）：
 *   · **默认预览**（零副作用）：受验读账本 → 打印记录、当前/拟改 target、同 lineage 会一起改的条数、
 *     目标会话在本机是否在场；不写任何东西，退出码 0。
 *   · `--apply`：会话不在场 → 拒（`session_absent`）；维护门开着 → 拒；取**外层排序锁**
 *     （`ledger/<ep>/m1a-order.lock`，与 m1a-seed 同一把）→ 调账本 `retarget()`
 *     （精确 CAS：`expectedOldTarget` 逐字段等；同 lineage 全部改；proof.kind=retarget）
 *     → 成功须 `committed_clean` + 锁释放干净 + **事后重读**该记录（及同 lineage）target 已等于新值。
 *   · `authorized_by` 取自已核验的机器级链模板（`frank_sender_id`），**不接受命令行传入**。
 *   · 只做 `null → UUID`：已是会话级 / 反向 / 跨项目根 一律拒（账本 op 与这里各拒一次）。
 *
 * 用法错（缺参 / 形状不对 / 参数重复 / 不认识的参数）→ 用法 + 退出码 2；其它失败 → 退出码 1。
 * 本命令不碰 `.runtime-data/`，不写 registry / active-mapping（那是 inbound 与 bind-* 的事）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { displaySafe } from "./display-safe.mjs";
import { isDirectRun } from "./direct-run.mjs";
import { gateBlocks } from "./maintenance-gate-core.mjs";
import { acquireOrderLock } from "./m1a/dual-write.mjs";
import { foldLockReleaseState } from "./maintenance/reaffirm-intents.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import { ID_SHAPE, ENDPOINT_SHAPE } from "./shapes.mjs";
import { resolveAuthorizedBy } from "./m1a-seed.mjs"; // owner 身份的**同一份**判据（seed 与这里共用，不另写一份）
import { canonKey, loadByEndpoint, retarget, retargetDirectionProblem } from "./topic-agent-ledger.mjs";

/** Claude 会话 uuid 形状（与账本 claude_session_id 同一形状；那一份没导出，这里显式定义一次）。 */
export const SESSION_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const RETARGET_USAGE = Object.freeze([
  "用法：node scripts/m1a-retarget.mjs --endpoint <endpoint_id> --id <topic_agent_id> --session <uuid> [--apply]",
  "  --endpoint  账本端点（缺省从已核验的机器级链模板派生）",
  "  --id        要改的 live 记录 id（ta_ + 32 位十六进制）",
  "  --session   目标会话的 Claude uuid（只做 项目级 → 会话级 这一个方向）",
  "  --apply     真的写账本（缺省是预览，零副作用，退出码 0）",
  "  authorized_by 取自已核验的链模板 frank_sender_id，不接受命令行传入。",
]);

const short = (v, n = 8) => (typeof v === "string" && v.length > n ? v.slice(0, n) + "…" : String(v ?? ""));

/**
 * 参数解析（纯函数）：用法错 → `{ok:false, why}`（CLI 层统一退出码 2）。
 * `--apply` 与三个带值开关都**不许重复**（重复 = 说清不了的意图，不取最后一个）。
 */
export function parseRetargetArgs(argv = []) {
  const valued = { "--endpoint": "endpointId", "--id": "id", "--session": "sessionId" };
  const out = { ok: true, endpointId: null, id: null, sessionId: null, apply: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === "--apply") {
      if (seen.has("--apply")) return { ok: false, why: "参数重复：--apply" };
      seen.add("--apply");
      out.apply = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(valued, a)) {
      if (seen.has(a)) return { ok: false, why: "参数重复：" + a };
      seen.add(a);
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith("--")) return { ok: false, why: a + " 缺参数值" };
      out[valued[a]] = String(v);
      i += 1;
      continue;
    }
    return { ok: false, why: "不认识的参数：" + displaySafe(a) };
  }
  if (out.id === null) return { ok: false, why: "缺 --id <topic_agent_id>" };
  if (out.sessionId === null) return { ok: false, why: "缺 --session <uuid>" };
  if (!ID_SHAPE.test(out.id)) return { ok: false, why: "--id 形状不对（要 ta_ + 32 位十六进制）：" + displaySafe(out.id) };
  if (!SESSION_UUID_SHAPE.test(out.sessionId)) return { ok: false, why: "--session 形状不对（要会话 uuid）：" + displaySafe(out.sessionId) };
  if (out.endpointId !== null && !ENDPOINT_SHAPE.test(out.endpointId)) {
    return { ok: false, why: "--endpoint 形状不对（要 endpoint_ + 24 位十六进制）：" + displaySafe(out.endpointId) };
  }
  return out;
}

/**
 * 会话在本机在场吗 —— 只读探测 `~/.claude/projects/<slug>/<uuid>.jsonl`。
 * slug 与 `live-session.mjs` 的 `transcriptDirFor` 同一算法（项目根里的 `/` 换成 `-`）；
 * 家目录按**传入的 env** 派生（不是模块加载时的 os.homedir），沙箱里不会去读真机。
 * `probe` 可注入（测试不必依赖真 home）。
 */
export function sessionTranscriptPath({ projectRoot, sessionId, env = process.env } = {}) {
  const home = env.HOME ?? os.homedir();
  return path.join(home, ".claude", "projects", String(projectRoot).replace(/\//gu, "-"), sessionId + ".jsonl");
}

export function sessionPresent({ projectRoot, sessionId, env = process.env, probe = null } = {}) {
  const file = sessionTranscriptPath({ projectRoot, sessionId, env });
  if (typeof probe === "function") return { present: probe(file) === true, file };
  try { return { present: fs.statSync(file).isFile(), file }; } catch { return { present: false, file }; }
}

const targetLine = (t) => t === null || t === undefined
  ? "（没有 target）"
  : "runtime=" + String(t.runtime) + "  project_root=" + String(t.project_root)
    + "  claude_session_id=" + (t.claude_session_id === null ? "null（项目级）" : String(t.claude_session_id));

/** 纯格式化层（CLI 与用例共用）：成功/预览各一条到几行；失败首行是 `res.status ?? res.reason` + `res.why` 原文。 */
export function formatRetargetResult(res) {
  if (res.ok === true && res.mode === "preview") {
    return [
      "[m1a-retarget] 预览（零副作用）：端点 " + res.endpointId,
      "  记录        " + short(res.id, 12) + "  chat " + short(res.chat_id) + "  root_om " + short(res.root_om),
      "  当前 target " + targetLine(res.oldTarget),
      "  拟改后      " + targetLine(res.newTarget),
      "  同 lineage  " + res.affectedIds.length + " 条会一起改"
        + (res.lineage === null ? "（无 lineage：只改这一条）" : "（lineage " + short(res.lineage, 12) + "）"),
      "  会话在场    " + (res.sessionPresent
        ? "是（" + res.sessionFile + "）"
        : "**否**（" + res.sessionFile + "）—— --apply 会拒 session_absent"),
      "  执行：node scripts/m1a-retarget.mjs --endpoint " + res.endpointId + " --id " + res.id
        + " --session " + String(res.newTarget?.claude_session_id ?? "") + " --apply",
    ];
  }
  if (res.ok === true) {
    return [
      "[m1a-retarget] 已改（端点 " + res.endpointId + "，记录 " + short(res.id, 12) + "，"
        + res.affectedIds.length + " 条同 lineage，revision " + String(res.revision) + "，commit " + String(res.commit) + "）",
    ];
  }
  const lines = ["[m1a-retarget] " + String(res.status ?? res.reason) + "：" + String(res.why ?? "")];
  const structural = {};
  for (const k of ["commit", "lock_state", "residue", "gate"]) {
    if (res[k] !== undefined) structural[k] = res[k];
  }
  if (Object.keys(structural).length > 0) lines.push("结构字段: " + JSON.stringify(structural));
  return lines;
}

/**
 * 核心（可注入、可进程内调用）：
 *   · 预览：零写入，返回读到的现场（含拟改后 target 与会话在场结论）。
 *   · --apply：会话不在场 / 维护门 / 取锁失败 → 拒（都不写）；否则 retarget() + 事后重读 + 折锁释放。
 * `_inject.beforeRetarget` 在**取到锁之后、调 op 之前**执行（测试用它把「旁路改账本」放进
 *   “我读到→我写” 那个窗口里，CAS 正是为它存在的；真子进程跑两次不会产生 cas_mismatch ——
 *   第二次读会看到改动，那是另一件事）。
 * `_inject.probeSession` 取代真实在场探测；`_inject.requestKey` 钉 op 的请求身份。
 */
export function retargetEndpoint({
  endpointId, id, sessionId, apply = false, env = process.env, now = Date.now(), _inject = null,
} = {}) {
  if (typeof endpointId !== "string" || !ENDPOINT_SHAPE.test(endpointId)) return { ok: false, reason: "bad_endpoint", why: "endpointId 缺失或形状不对" };
  if (typeof id !== "string" || !ID_SHAPE.test(id)) return { ok: false, reason: "bad_id", why: "--id 缺失或形状不对" };
  if (typeof sessionId !== "string" || !SESSION_UUID_SHAPE.test(sessionId)) return { ok: false, reason: "bad_session", why: "--session 缺失或形状不对" };

  const authRes = resolveAuthorizedBy(undefined, "claude", env);
  if (!authRes.ok) return { ok: false, reason: authRes.reason, why: authRes.why };

  const L = loadByEndpoint(endpointId, { env });
  if (L.ok !== true) {
    return { ok: false, reason: "ledger_unreadable", why: "账本读不出（" + String(L.reason ?? "unknown") + (L.why ? "：" + L.why : "") + "）" };
  }
  const rec = L.doc?.records?.[id];
  if (!rec || rec.kind !== "live") return { ok: false, reason: "not_live", why: "账本里没有这条 live 记录：" + displaySafe(id) };
  const oldTarget = rec.binding_target ?? null;
  if (oldTarget === null) {
    return { ok: false, reason: "no_target", why: "这条记录没有 binding_target（facts.binding=" + String(rec.facts?.binding) + "）—— 没有可 retarget 的对象" };
  }
  if (oldTarget.runtime !== "claude") {
    return { ok: false, reason: "not_claude", why: "本命令的会话在场探测只认 Claude 链（runtime=" + String(oldTarget.runtime) + "）" };
  }
  if (oldTarget.claude_session_id !== null) {
    return { ok: false, reason: "already_session_level", why: "这条记录已经是会话级（claude_session_id=" + short(oldTarget.claude_session_id) + "）—— 本命令只做 项目级 → 会话级" };
  }
  const newTarget = { ...oldTarget, claude_session_id: sessionId };
  // 方向拒的判据只有账本那一份（retargetDirectionProblem）——这里早拒一次只为说人话，不另立判据。
  const dirProblem = retargetDirectionProblem(oldTarget, newTarget);
  if (dirProblem !== null) return { ok: false, reason: "bad_direction", why: dirProblem };

  const lineage = rec.generation_lineage_id ?? null;
  // 与 retarget op 内**同一算法**（同 lineage 全部 live 记录一起改）——预览报的就是它将要改的那一批。
  const affectedIds = (lineage === null
    ? [id]
    : Object.keys(L.doc.records ?? {}).filter((k) => L.doc.records[k].kind === "live" && L.doc.records[k].generation_lineage_id === lineage)).sort();
  const probe = sessionPresent({ projectRoot: oldTarget.project_root, sessionId, env, probe: _inject?.probeSession ?? null });
  const base = {
    endpointId, id, oldTarget, newTarget, lineage, affectedIds,
    chat_id: rec.chat_id ?? null, root_om: rec.aliases?.root_om ?? null,
    sessionPresent: probe.present, sessionFile: probe.file,
  };

  if (!apply) return { ok: true, mode: "preview", ...base };
  if (!probe.present) {
    return { ok: false, reason: "session_absent", why: "目标会话在本机不在场（" + probe.file + "）—— 先在那条会话里跑起来再 retarget", ...base };
  }
  const gate = gateBlocks({ env });
  if (gate.blocked) return { ok: false, reason: "maintenance", gate: gate.state, why: "维护门开着（" + String(gate.text ?? gate.state) + "）：窗口内不写账本", ...base };

  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) {
    return { ok: false, reason: acq.reason ?? "lock_failed", path: acq.path ?? acq.lock ?? null,
      why: acq.why ?? acq.error ?? "取 m1a-order 锁失败（另一个写方正持锁 / 锁残骸）", ...base };
  }
  let released = null;
  const releaseOuter = () => { if (released === null) released = acq.release(); return released; };
  try {
    if (typeof _inject?.beforeRetarget === "function") _inject.beforeRetarget();
    const requestKey = typeof _inject?.requestKey === "string" ? _inject.requestKey : crypto.randomUUID();
    // expectedOldTarget = 本次运行开头受验读到的 target（CAS：读到→写到 之间被人旁路改过 → cas_mismatch）。
    const res = retarget({ endpointId, requestKey, id, expectedOldTarget: oldTarget, newTarget, authorizedBy: authRes.authorizedBy, now, env });
    let post = null;
    if (res.ok === true) {
      const L2 = loadByEndpoint(endpointId, { env });
      if (L2.ok !== true) post = { ok: false, why: "事后重读账本读不出（" + String(L2.reason ?? "unknown") + "）" };
      else {
        const bad = affectedIds.filter((k) => canonKey(L2.doc?.records?.[k]?.binding_target ?? null) !== canonKey(newTarget));
        post = bad.length === 0
          ? { ok: true, revision: L2.doc.revision, ops: Object.values(L2.doc.operations ?? {}).filter((op) => op?.op_type === "retarget" && op?.request_key === requestKey).length }
          : { ok: false, why: "事后重读仍不等的记录：" + bad.map((k) => short(k, 12)).join("、") };
      }
    }
    const rel = releaseOuter();
    const lockState = foldLockReleaseState(rel);
    const wrote = res.ok === true;
    const clean = wrote && res.commit === "committed_clean" && post?.ok === true && lockState === "released";
    if (!clean) {
      const residue = [
        ...(Array.isArray(res.residue) ? res.residue : (res.residue ? [res.residue] : [])),
        ...(rel?.reapUncleared?.path ? [rel.reapUncleared.path] : (rel?.reason === "reap_uncleared" && rel?.path ? [rel.path] : [])),
      ];
      const why = wrote
        ? "已写但收口不干净（commit=" + String(res.commit) + "/lock=" + lockState
          + (post && post.ok !== true ? "/post:" + post.why : "") + "）：不要重跑 apply，先 doctor"
        : String(res.why ?? "retarget 未提交") + (lockState !== "released" ? "；另：排序锁释放不干净（" + lockState + "）" : "");
      return { ok: false, status: wrote ? "retarget_unclean" : (res.reason ?? "retarget_failed"), reason: wrote ? "retarget_unclean" : (res.reason ?? "retarget_failed"),
        commit: res.commit ?? "not_committed", lock_state: lockState, residue, why, ...base };
    }
    return { ok: true, mode: "apply", status: "retargeted", commit: res.commit, lock_state: lockState,
      revision: post.revision, op_count: post.ops, ...base };
  } finally {
    releaseOuter(); // 幂等：成功路径已经折过它，这里只兜异常出口
  }
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRetargetArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("[m1a-retarget] 用法错误：" + parsed.why);
    for (const l of RETARGET_USAGE) console.error(l);
    process.exit(2);
  }
  let endpointId = parsed.endpointId;
  if (endpointId === null) {
    const tpl = loadChainTemplate();
    if (tpl.ok && tpl.template?.agent_uid) endpointId = legacyEndpointId({ runtime: "claude", agentUid: tpl.template.agent_uid });
  }
  if (!endpointId) {
    console.error("[m1a-retarget] 错误：必须指定 --endpoint <endpoint_id> 或配置机器级链路模板");
    process.exit(1);
  }
  const res = retargetEndpoint({ endpointId, id: parsed.id, sessionId: parsed.sessionId, apply: parsed.apply });
  if (res.ok === true) {
    for (const line of formatRetargetResult(res)) console.log(line);
    process.exit(0);
  }
  for (const line of formatRetargetResult(res)) console.error(line);
  process.exit(1);
}
