#!/usr/bin/env node
/**
 * 机器级体检（FR-10 / 需求 §9「doctor」）—— **只诊断不修**。
 *
 * status 只看当前项目，每天要看，必须干净；doctor 查整台机器，出问题才跑，可以啰嗦。
 * 它把「跨项目说不通」的那几件事拆出来单独报：
 *   ① 有 route 却没登记状态入口的消费者
 *   ② 状态入口指向的脚本已不在或跑不起来
 *   ③ 话题登记（路由表 sessions）指向不存在或已停用的路由
 *   ④ 状态入口表与路由表对不上（状态入口指向不存在的路由）
 *   ⑤ 绑定即将过期 / 已过期；待认领代际已过期
 *   ⑥ outbox / runs 有积压但发布器没在跑（Claude launchd 兜底 / Codex 兜底排空）
 * 外加运行时、登记表、路由表、状态入口表本身读不读得出。
 *
 * **判据只有一份**：这里只调用既有读模型（collectConnectivity、loadRegistryStrict、loadRoutes、
 * loadStatusProviders、resolveProject、auditOutbox、inventoryRuns、verifyRuntime、loadedPhase）做汇总，
 * Codex 侧那一项以子进程引用 scripts/codex/doctor.mjs 的结论，不另写判断。
 *
 * **三态**：每项 ok ∈ {true, false, null}。null = 本地查不出来，既不是通过也不是故障；
 * 汇总 ready（全 true）/ blocked（任一 false）/ incomplete（无 false、有 null），退出码 0 / 1 / 2。
 *
 * **doctor 自己的代码不写任何文件、不装、不发飞书、不给"一键修复"**：每条 fail 的 next 只能是既有
 * 显式入口的命令，且是预览形式（不带 --apply）。**只读的边界明说**：登记的状态入口脚本是外部代码，
 * 默认不执行（② 报"未探测"）；加 --probe-providers 才执行，它们的副作用属于登记入口自己的信任边界。
 * 沙箱（HOME 被覆盖）里不碰真实 launchctl —— 除非显式注入了 FEISHU_BRIDGE_LAUNCHCTL（那是测试隔离点），
 * 否则兜底定时器那一项报 unknown 并说明。
 */

import fs from "node:fs";
import { chatReplyPathStatus, chatReplyTimeoutMs } from "./chat-reply.mjs";
import { chatLoad, inspectAdmissionLocks, inspectScratch } from "./chat-ledger.mjs";
import os from "node:os";
import path from "node:path";

import { displaySafe } from "./display-safe.mjs";
import { inspectInstallSurfaceLock } from "./install-surface-lock.mjs";
import { isDirectRun, moduleDir } from "./direct-run.mjs";
import { auditOutbox } from "./outbox.mjs";
import { inspectRunChannel, outboxDirOf } from "./drain-outbox.mjs";
import { inventoryRuns } from "./outbound.mjs";
import { loadRegistryStrict, registryPath } from "./registry.mjs";
import { loadRoutes, routesPath, defaultRouteHandler } from "./inbound-routes.mjs";
import { collectConnectivity, loadStatusProviders, statusProvidersPath } from "./status-providers.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { pendingGeneration } from "./topic-generation.mjs";
import { verifyRuntime, runtimeRoot } from "./runtime-install.mjs";
import { shellQuote } from "./shell-quote.mjs";
import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, pickClaudeNode } from "./drain-schedule.mjs";
import { spawnSync } from "node:child_process";
import {
  loadByEndpoint, ledgerRootFor, ENDPOINT_SHAPE,
} from "./topic-agent-ledger.mjs";
import { aggregateEndpointReceipts, preparedLedgerInits } from "./maintenance/ledger-receipt.mjs";
import { collectClaudeLegacySnapshot, collectCodexLegacySnapshot } from "./m1a/legacy-snapshot.mjs";
import { reconcileLegacyEndpoint } from "./m1a/reconcile.mjs";
import { LAUNCHCTL_ENV, PHASE_TEXT, loadedPhase } from "./launchd-job.mjs";
import { readGate, maintenanceGatePath } from "./maintenance-gate-core.mjs";
import { inspectInstalledSurface, installedSurfacePath } from "./installed-surface.mjs";
import { inspectMaintenanceDir, maintenanceDir } from "./maintenance/journal.mjs";
import { loadSubscriptionAudit, loadSubscriptionAuditPending, loadSubscriptionStore, storeHashState, subscriptionAuditPendingPath, subscriptionStorePath } from "./subscription-store.mjs";

/** 到期预警阈值：7 天内到期就点名。**明写**，不藏在比较式里。 */
export const EXPIRY_WARN_MS = 7 * 24 * 3600 * 1000;

const PREVIEW = {
  installOutbound: "node scripts/install-outbound.mjs（预览；确认后自行加 --apply）",
  registerProvider: "node scripts/register-status-provider.mjs --id <route id> --script <状态脚本>（预览；确认后自行加 --apply）",
  bindProject: "node scripts/bind-project.mjs（预览；确认后自行加 --apply）",
  // 这条命令控制权威路由：路径一律 shellQuote，不靠"本机路径恰好没空格"。命令与说明之间留一个空格，整段可复制、也可切出命令。
  restoreDefaultRoute: (routesFile, handler, id) => "node scripts/register-route.mjs --restore-default --routes " + shellQuote(routesFile) + " --handler " + shellQuote(handler) + " --id " + shellQuote(id) + " （预览；切权威路由，Frank 授权后自行加 --apply）",
  rotate: "/feishu-rotate（在对应项目的会话里）",
  drainCodex: "node scripts/codex/drain-service.mjs --enable（预览；确认后自行加 --apply）",
  feishuOutbox: "$feishu-outbox（Codex 侧只读积压视图）/ node scripts/drain-outbox.mjs --dry-run",
};

const short = (v) => (typeof v === "string" && v.length > 8 ? v.slice(0, 8) + "…" : String(v ?? ""));
const list = (items, f) => items.map(f).map(displaySafe).join("；");

/**
 * 跑完整体检。**默认只读**：所有输入都来自既有读模型，doctor 自己不写任何文件；
 * probeProviders:true 时会执行登记的状态入口脚本，那一步进入 provider 自身的信任边界。
 * now / launchctl 注入只为测试。
 * @returns {{overall:"ready"|"blocked"|"incomplete", checks:object[], next:string[]}}
 */
/**
 * 一台机器的控制面在哪 —— **所有路径与子进程环境都从同一份 home 派生**。
 * 环境变量覆盖点（FEISHU_BRIDGE_*、CODEX_HOME）仍然优先：那是既有的隔离契约。
 */
export function machineContext({ home = os.homedir() } = {}) {
  const bridge = path.join(home, ".claude", "feishu-bridge");
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  return {
    home,
    registryFile: process.env.FEISHU_BRIDGE_REGISTRY || path.join(bridge, "registry.json"),
    routesFile: process.env.FEISHU_BRIDGE_ROUTES || path.join(bridge, "routes.json"),
    providersFile: process.env.FEISHU_BRIDGE_STATUS_PROVIDERS || path.join(bridge, "status-providers.json"),
    codexEnv: { ...process.env, HOME: home, CODEX_HOME: codexHome,
      FEISHU_CODEX_BRIDGE_HOME: process.env.FEISHU_CODEX_BRIDGE_HOME || path.join(codexHome, "feishu-bridge") },
  };
}

/** 默认不执行状态入口脚本时给 collectConnectivity 的替身：统一报"未探测"。 */
const NOT_PROBED = () => ({ ok: false, reason: "not_probed" });

export function runDoctor({
  now = Date.now(),
  home = os.homedir(),
  registryFile = undefined,
  routesFile = undefined,
  providersFile = undefined,
  launchctl = undefined,
  // **默认不执行状态入口脚本**：它们是外部代码，可能写盘 —— 只有显式要求才跑，副作用属于登记入口自己的信任边界。
  probeProviders = false,
} = {}) {
  const ctx = machineContext({ home });
  registryFile = registryFile ?? ctx.registryFile;
  routesFile = routesFile ?? ctx.routesFile;
  providersFile = providersFile ?? ctx.providersFile;
  const checks = [];
  const add = (id, name, ok, detail, next = null) => checks.push({ id, name, ok, detail: displaySafe(detail), next });

  // ── 运行时
  const runtime = verifyRuntime({ home, chain: "claude" });
  add("runtime", "Claude 运行时", runtime.ok === true,
    runtime.ok ? "current 指向 " + short(runtime.version) + "，清单与内容一致"
      : "校验不过（" + (runtime.reason ?? "drift") + "）",
    runtime.ok ? null : PREVIEW.installOutbound);

  // ── 三张表本身
  const registry = loadRegistryStrict(registryFile);
  add("registry", "项目登记表", registry.ok,
    registry.ok ? "已登记 " + (registry.projects ?? []).length + " 个项目" : "读不出来（" + (registry.reason ?? "说不清") + "）",
    registry.ok ? null : PREVIEW.installOutbound);
  const routes = loadRoutes(routesFile);
  add("routes", "路由表", routes.ok,
    routes.ok ? (routes.reason === "no_routes" ? "没有路由表（还没登记过入站路由）" : routes.routes.length + " 条启用路由，" + Object.keys(routes.sessions).length + " 条话题登记")
      : "读不出来（" + (routes.reason ?? "说不清") + (routes.problem ? "：" + routes.problem : "") + "）",
    null);
  const providers = loadStatusProviders(providersFile);
  add("providers", "状态入口表", providers.ok,
    providers.ok ? (providers.providers ?? []).length + " 个状态入口" : "读不出来（" + (providers.reason ?? "说不清") + (providers.problem ? "：" + providers.problem : "") + "）",
    null);

  // ── self 路由的判据派生（① 的特判与 ⑦ 共用，只写一处）：有效默认路由恰为 self 且
  // handler 实指本桥 runtime/current 的 inbound —— defaultRouteHandler 的现成判据。
  const runtimeCurrent = path.join(runtimeRoot(home, "claude"), "current");
  const expectedHandler = path.join(runtimeCurrent, "scripts", "inbound.mjs");
  const defaultSelf = defaultRouteHandler({ file: routesFile, runtimeCurrent, expectedHandler, expectedRouteId: "self" });

  // ── ① ② 路由 ↔ 状态入口（collectConnectivity 是唯一判据：unregistered / unavailable / disabled）
  const links = collectConnectivity({ routesFile, providersFile, ...(probeProviders ? {} : { run: NOT_PROBED }) });
  const tablesUnclear = links.providersProblem !== null || links.routesProblem !== null;
  const unregisteredAll = links.sections.filter((s) => s.state === "unregistered");
  // self 是本桥自己的入站路由：它的状态由本桥自身（feishu-status / doctor）提供，要求它再登记
  // 一个外部状态入口是让桥给自己当外人。判据**不许**是"routeId 叫 self 就放过"——用上面
  // defaultRouteHandler 的现成结论（默认路由恰为 self 且 handler 实指 runtime/current 的
  // inbound）才豁免；名叫 self 但 handler 指向别处的照旧 ✗。
  const selfExempt = defaultSelf.status === "runtime" && unregisteredAll.some((s) => s.id === "self");
  const unregistered = unregisteredAll.filter((s) => !(selfExempt && s.id === "self"));
  const unavailable = links.sections.filter((s) => s.state === "unavailable" && s.reason !== "not_probed");
  add("route_without_provider", "① route 有状态入口",
    tablesUnclear ? null : unregistered.length === 0,
    tablesUnclear ? "路由表或状态入口表读不出来，查不清（" + (links.routesProblem ?? links.providersProblem) + "）"
      : unregistered.length === 0 ? "每条启用路由都有获准报告运输状态的状态入口" +
        (selfExempt ? "（self 是本桥自身的入站路由，状态由本桥自身提供，不另要求登记外部状态入口）" : "")
      : unregistered.length + " 条路由没有状态入口：" + list(unregistered, (s) => s.id) +
        (selfExempt ? "；self 是本桥自身的入站路由（状态由本桥自身提供），不计入" : ""),
    unregistered.length > 0 ? PREVIEW.registerProvider : null);
  add("provider_runs", "② 状态入口能跑",
    tablesUnclear ? null : !probeProviders ? null : unavailable.length === 0,
    tablesUnclear ? "查不清（表读不出来）"
      : !probeProviders ? "未探测（默认不执行状态入口脚本；加 --probe-providers 才执行，其副作用属于登记入口自己的信任边界）"
      : unavailable.length === 0 ? "登记的状态入口都跑得起来（停用的不算）"
      : unavailable.length + " 个状态入口跑不起来：" + list(unavailable, (s) => s.id + "（" + (s.reason ?? "说不清") + "）"),
    unavailable.length > 0 ? PREVIEW.registerProvider : null);

  // ── ③ 话题登记指向不存在或已停用的路由
  if (routes.ok) {
    const routeIds = new Set(routes.routes.map((r) => r.id));
    const orphans = Object.entries(routes.sessions).filter(([, owner]) => !routeIds.has(owner));
    add("session_route_missing", "③ 话题登记指向的路由存在且启用", orphans.length === 0,
      orphans.length === 0 ? Object.keys(routes.sessions).length + " 条话题登记都指向启用的路由"
        : orphans.length + " 条话题登记指向不存在或已停用的路由：" + list(orphans, ([sid, owner]) => short(sid) + " → " + owner),
      orphans.length > 0 ? PREVIEW.bindProject : null);
  } else {
    add("session_route_missing", "③ 话题登记指向的路由存在且启用", null, "路由表读不出来，查不清", null);
  }

  // ── ④ 状态入口指向不存在的路由
  if (routes.ok && providers.ok) {
    const routeIds = new Set(routes.routes.map((r) => r.id));
    const dangling = (providers.providers ?? []).filter((p) => !routeIds.has(p.id));
    add("provider_without_route", "④ 状态入口表与路由表对得上", dangling.length === 0,
      dangling.length === 0 ? "每个状态入口的 id 都对应一条启用路由"
        : dangling.length + " 个状态入口指向不存在或已停用的路由：" + list(dangling, (p) => p.id),
      dangling.length > 0 ? PREVIEW.registerProvider : null);
  } else {
    add("provider_without_route", "④ 状态入口表与路由表对得上", null, "两张表有一张读不出来，查不清", null);
  }

  // ── ⑦ 入站默认处理器必须就是装好的运行时（issue #88：装了 ≠ 在跑）——判据派生在 ① 前共用
  {
    const d = defaultSelf;
    const othersText = d.others?.length ? "；另有 " + d.others.length + " 条非默认路由的处理器在运行时之外（按备注分辨）：" + list(d.others, (o) => o.id + " → " + o.handler) : "";
    add("default_route_handler", "⑦ 入站默认处理器在 runtime/current 之下",
      d.status === "runtime" || d.status === "no_routes" ? true : d.status === "unreadable" ? null : false,
      d.status === "runtime" ? "默认路由 " + d.id + " → 装好的运行时" + othersText
        : d.status === "no_routes" ? d.why + "，分发器用运行时自带的默认处理器"
        : d.status === "outside" ? "默认路由 " + d.id + " 的处理器不是装好的运行时：" + d.handler + (d.note ? "（备注：" + d.note + "）" : "") + "；" + d.why + " —— 装到 runtime/current 的代码没在处理入站" + othersText
        : d.status === "no_default" ? "没有默认路由（" + d.why + "）—— 未登记话题会被拒，不会回退运行时；需要人工给其中一条标 default（register-route 不设默认：默认路由是权威路由）"
        : d.status === "wrong_default" ? d.why + " —— 不自动改（那是把别人的话题改判）；请人工把 default 标回 self" + othersText
        : "路由表读不出来，查不清（" + d.why + "）",
      d.status === "outside" ? PREVIEW.restoreDefaultRoute(routesFile, expectedHandler, "self") : null);
  }

  // ── ⑤ ⑥ 逐项目：绑定到期、outbox / runs 积压
  const projects = registry.ok ? (registry.projects ?? []) : [];
  const expiring = [];
  const expired = [];
  const pendingExpired = [];
  const unclear = [];
  let backlog = 0;
  let backlogProblems = 0;
  const backlogWhere = [];
  for (const p of projects) {
    const root = p?.root;
    const name = displaySafe(path.basename(String(root ?? "?")));
    const claudeSessionId = p?.claude_session_id ?? null;
    if (typeof root !== "string" || !path.isAbsolute(root)) { unclear.push(name + "（root 不是绝对路径）"); continue; }
    const resolved = resolveProject({ root, claudeSessionId, registryFile });
    if (!resolved.ok) { unclear.push(name + "（" + resolved.reason + "）"); }
    else if (resolved.mapping?.status === "invalid") {
      // 解析层已经判 invalid（话题代际状态解释不了）：不能从局部可读的日期推出"在有效期内"。
      unclear.push(name + "（解析层判 invalid：" + String(resolved.mapping.topic_generation_error ?? "说不清") + "）");
    } else {
      const m = resolved.mapping;
      const exp = Date.parse(m?.expires_at ?? "");
      if (Number.isFinite(exp)) {
        if (exp <= now) expired.push(name);
        else if (exp - now <= EXPIRY_WARN_MS) expiring.push(name + "（" + Math.ceil((exp - now) / 86400000) + " 天）");
      } else unclear.push(name + "（expires_at 不是时间）");
      const pending = pendingGeneration(m?.topic_generation_state ?? null);
      const claimExp = Date.parse(pending?.claim_expires_at ?? "");
      if (pending && Number.isFinite(claimExp) && claimExp <= now) pendingExpired.push(name);
    }
    const audit = auditOutbox(outboxDirOf(root, claudeSessionId));
    if (!audit.ok) { backlogProblems += 1; backlogWhere.push(name + "（outbox " + audit.reason + "）"); }
    else {
      if (audit.pending > 0) { backlog += audit.pending; backlogWhere.push(name + "（outbox " + audit.pending + " 条）"); }
      const bad = (audit.unclassified?.length ?? 0) + (audit.unexplainable?.length ?? 0);
      if (bad > 0) { backlogProblems += bad; backlogWhere.push(name + "（outbox 说不清 " + bad + " 处）"); }
    }
    // run 通道：与状态页同一份结论（inspectRunChannel，只读 dryRun）—— 将发的算积压，卡住 / 账本问题算说不清。
    const rc = inspectRunChannel({ root, claudeSessionId });
    // 未路由回复：Stop 零入队留下的记录，每条都是"有回复没发出去"，算说不清、要人看。
    if (rc.unrouted?.ok === false) { backlogProblems += 1; backlogWhere.push(name + "（未路由回复读不出）"); }
    else {
      const urCount = rc.unrouted?.count ?? 0;
      const urBad = rc.unrouted?.problems?.length ?? 0;
      if (urCount > 0) { backlogProblems += urCount; backlogWhere.push(name + "（未路由回复 " + urCount + " 条）"); }
      if (urBad > 0) { backlogProblems += urBad; backlogWhere.push(name + "（未路由目录说不清 " + urBad + " 处）"); }
    }
    if (rc.inventoryOk === false) {
      backlogProblems += 1;
      backlogWhere.push(name + "（runs 账本读不出：" + (rc.runs.problems?.[0]?.reason ?? "说不清") + "）");
    } else {
      if (rc.waiting.count > 0) { backlog += rc.waiting.count; backlogWhere.push(name + "（run 通道待发 " + rc.waiting.count + " 条" + (rc.phase === "paused" ? "，绑定暂停中" : "") + "）"); }
      const stuck = rc.runs.stuck ?? [];
      if (stuck.length > 0) { backlogProblems += stuck.length; backlogWhere.push(name + "（run 卡住 " + stuck.length + " 条：" + [...new Set(stuck.map((x) => x.reason))].join("、") + "）"); }
      const problems = rc.runs.problems ?? [];
      if (problems.length > 0) { backlogProblems += problems.length; backlogWhere.push(name + "（runs 账本说不清 " + problems.length + " 处：" + [...new Set(problems.map((x) => x.reason))].join("、") + "）"); }
      // issue #98：已知旧形记录是 info 不是问题 —— 显示数量但**不进 backlogProblems**（⑥ 不因此变红）。
      // rc.runs 走 drainRunResults，透不出 notices，只能另盘一次；路径与 drain-outbox.mjs 的
      // runChannelContext 同一组（本单边界不许改那边）——那边若改路径这里要同改，漂移的最坏后果
      // 只是这条 info 显示缺位，不影响红绿。
      const ledgerNotices = inventoryRuns({
        runsDir: path.join(root, ".runtime-data", "inbound", "runs"),
        claimsDir: path.join(root, ".runtime-data", "inbound", "delivery-claims"),
      }).notices ?? [];
      if (ledgerNotices.length > 0) backlogWhere.push(name + "（runs 账本已知旧形记录 " + ledgerNotices.length + " 条：" + [...new Set(ledgerNotices.map((x) => x.reason))].join("、") + "，不算问题）");
    }
  }
  const expiryOk = !registry.ok ? null : (expired.length + expiring.length + pendingExpired.length === 0 ? (unclear.length === 0 ? true : null) : false);
  add("binding_expiry", "⑤ 绑定未到期（阈值 7 天）", expiryOk,
    !registry.ok ? "登记表读不出来，查不清"
      : [expired.length ? "已过期：" + expired.join("、") : null,
        expiring.length ? "即将到期：" + expiring.join("、") : null,
        pendingExpired.length ? "待认领代际已过期：" + pendingExpired.join("、") : null,
        unclear.length ? "查不清：" + unclear.join("、") : null,
      ].filter(Boolean).join("；") || (projects.length + " 个项目的绑定都在有效期内"),
    expired.length + expiring.length ? PREVIEW.bindProject : pendingExpired.length ? PREVIEW.rotate : null);

  // 发布器在不在跑：Claude launchd 兜底（沙箱里不碰真 launchctl，除非显式注入）
  // **隔离态看的是这次体检的 home**（machineContext），不是进程的环境 HOME —— runDoctor({home}) 传隔离目录时
  // 也不许去探测当前机器的 launchd（评审探针记录到了真实 launchctl 调用）。
  const sandboxed = path.resolve(ctx.home) !== path.resolve(os.userInfo().homedir);
  const injected = typeof launchctl === "function" || Boolean(process.env[LAUNCHCTL_ENV]);
  let claudePhase = "unverifiable";
  let claudePhaseWhy = null;
  if (sandboxed && !injected) { claudePhaseWhy = "体检的 home 不是当前用户的家目录（沙箱），不碰真实 launchctl"; }
  else {
    // 核**完整 ProgramArguments**，不只看同名 job 在不在（评审探针：同名 job 跑 /bin/echo 也曾被说成在发）。
    try { claudePhase = loadedPhase(launchctl, claudeDrainExpectedJob({ home, node: pickClaudeNode() }), CLAUDE_DRAIN_LAUNCH_LABEL); }
    catch (err) { claudePhaseWhy = String(err?.message ?? err).slice(0, 120); }
  }
  const publisherRunning = claudePhase === "loaded" ? true
    : (claudePhase === "installed_not_loaded" || claudePhase === "loaded_other") ? false : null;
  const publisherText = claudePhaseWhy ? "兜底定时器状态查不清（" + claudePhaseWhy + "）"
    : "兜底定时器 " + (PHASE_TEXT[claudePhase] ?? claudePhase);
  const backlogText = (backlog > 0 ? "积压 " + backlog + " 条" : "无积压") +
    (backlogProblems > 0 ? "，账本说不清 " + backlogProblems + " 处" : "") +
    (backlogWhere.length ? "：" + backlogWhere.join("、") : "");
  const backlogOk = !registry.ok ? null
    : backlogProblems > 0 ? false
    : backlog === 0 ? true
    : publisherRunning === true ? true
    : publisherRunning === false ? false
    : null;
  add("backlog_vs_publisher", "⑥ 积压有人发（Claude 侧）", backlogOk,
    (!registry.ok ? "登记表读不出来，查不清" : backlogText) + "；" + publisherText,
    backlogOk === false ? (backlogProblems > 0 ? PREVIEW.feishuOutbox : PREVIEW.installOutbound) : null);

  // Codex 侧：**引用**既有的 scripts/codex/doctor.mjs（子进程，--json），不重写它的判据。
  // Claude 侧代码不依赖 scripts/codex/（依赖单向），所以只能这样引用。沙箱里同样不碰真 launchctl。
  if (sandboxed && !injected) {
    add("codex_drain", "⑥ 积压有人发（Codex 侧）", null, "体检的 home 不是当前用户的家目录（沙箱），不碰真实 launchctl；Codex 侧查不清", null);
  } else {
    const codexDoctor = path.join(moduleDir(import.meta.url), "codex", "doctor.mjs");
    const r = spawnSync(process.execPath, [codexDoctor, "--json"], { encoding: "utf-8", timeout: 60_000, env: ctx.codexEnv });
    let codexReport = null;
    try { codexReport = JSON.parse(r.stdout ?? ""); } catch { /* 下面按读不出报 */ }
    const drain = codexReport?.checks?.find?.((c) => c.name === "兜底排空") ?? null;
    if (!drain) {
      add("codex_drain", "⑥ 积压有人发（Codex 侧）", null,
        "Codex 侧体检没有给出兜底排空的结论（" + (r.error ? String(r.error.message).slice(0, 80) : "输出读不出") + "）", null);
    } else {
      add("codex_drain", "⑥ 积压有人发（Codex 侧）", drain.ok === true ? true : drain.ok === false ? false : null,
        "Codex 侧体检说：" + String(drain.detail ?? ""), drain.ok === false ? PREVIEW.drainCodex : null);
    }
  }

  // ⑧ chat 回复路径：两条链的 chat 默认态都靠本机 claude CLI 答话；沙箱里也查（它不碰任何状态）
  {
    const cp = chatReplyPathStatus();
    add("chat_reply_path", "⑧ chat 回复路径（两条链共用本机 claude CLI）", cp.available, cp.available ? "claude CLI 可用（" + cp.version + "）" : "不可用：" + cp.why + " —— 未接入的话题 / 私聊会报 chat_reply_path_unavailable", null);
  }

  // ⑨ chat 账本：两条链各一份机器级账本；说不清的条目（读不出 / 形状不对 / 认不出）在这里点名 —— 入口拒绝 chat 时指的就是这一项；
  //    准入盘点看不到的也在这里盘：scratch（年轻的 = 进位中、老的 = 残骸可直接删、形状不对 = 说不清）与锁族
  //    （reap 段锁复用锁协议自己的投影：在途不算问题，超阈值 / 形状说不清才算；maint 残留只挡维护入口；主锁久持 = 有问题）
  {
    const codexBridgeHome = ctx.codexEnv.FEISHU_CODEX_BRIDGE_HOME || path.join(ctx.codexEnv.CODEX_HOME, "feishu-bridge");
    const ledgers = [["Claude", path.join(ctx.home, ".claude", "feishu-bridge", "inbound", "chat-claims")], ["Codex", path.join(codexBridgeHome, "inbound", "chat-claims")]];
    const parts = []; const problems = []; const notes = [];
    for (const [chain, dir] of ledgers) {
      const load = chatLoad({ ledgerDir: dir, senderId: null, now, budgetMs: chatReplyTimeoutMs() });
      const scratch = inspectScratch({ ledgerDir: dir, now });
      parts.push(chain + " 正在答 " + load.running + " 条" + (scratch.inflight > 0 ? "（进位中 " + scratch.inflight + " 个临时文件，不算问题）" : ""));
      for (const why of load.why) problems.push(chain + "：" + why);
      for (const why of scratch.problems) problems.push(chain + "：" + why);
      const locks = inspectAdmissionLocks({ ledgerDir: dir, now });
      for (const why of locks.problems) problems.push(chain + "：" + why);
      for (const note of locks.notes) notes.push(chain + "：" + note);
    }
    const tail = notes.length > 0 ? "；" + notes.join("；") : "";
    add("chat_ledger", "⑨ chat 账本（两条链）", problems.length === 0, problems.length === 0 ? parts.join("、") + "；没有说不清的条目" + tail : parts.join("、") + "；说不清 " + problems.length + " 处：" + problems.slice(0, 3).join("；") + tail, null);
  }

  // ⑩ 维护门（issue #81）：三态 —— 没开 = 正常；开着 = 维护中（点名原因与时长，超过 10 分钟单独点名）；读不出 = 按维护中处理、只人工处置。
  // 附安装面锁（PR C 第 2 步）：持有者与锁家族残骸只读盘点 —— 残骸会挡后续安装 / 维护，不能只有写方碰壁时才看见。
  {
    const g = readGate({ now });
    const mdir = inspectMaintenanceDir({ dir: maintenanceDir() });
    const sl = inspectInstallSurfaceLock({ home });
    const slText = sl.holder.state === "held" ? "；安装面锁 pid " + sl.holder.pid + (sl.holder.alive ? "（在跑）" : "（已不在，下一个写方接管）") : sl.holder.state === "unknown" ? "；安装面锁说不清（" + sl.holder.why + "）" + sl.path : "";
    const slRes = sl.residues.length > 0 ? "；安装面锁残骸 " + sl.residues.length + " 处：" + sl.residues.slice(0, 3).map((r) => r.path + "（" + r.detail + "）").join("、") : "";
    const mres = (mdir.inventory === "unreadable" ? "；维护目录读不出：" + mdir.residues.map((r) => r.detail).join("；") : mdir.residues.length > 0 ? "；维护目录残骸 " + mdir.residues.length + " 处：" + mdir.residues.slice(0, 3).map((r) => r.path + "（" + r.detail + "）").join("、") : "") + slText + slRes;
    if (g.state === "absent") add("maintenance_gate", "⑩ 维护门", mres === "" || (mres === slText && sl.holder.state === "held"), "没开" + mres, null);
    else if (g.state === "active") add("maintenance_gate", "⑩ 维护门", false, "开着：" + g.payload.reason + "（已 " + Math.floor(g.ageMs / 60000) + " 分钟，token " + String(g.payload.token).slice(0, 8) + "）" + (g.ageMs > 10 * 60 * 1000 ? " —— 超过 10 分钟，多半是维护中断；维护门 CLI（--status / --exit）随后续 PR 提供，此刻请人工核对 " + maintenanceGatePath() : ""), null);
    else if (g.state === "transitioning") add("maintenance_gate", "⑩ 维护门", false, "正在切换（" + g.why + "）—— 入口都按维护中处理；几毫秒的事，再跑一次仍在就是段里崩了或释放失败，转换锁在 " + maintenanceGatePath() + ".txn", null);
    else add("maintenance_gate", "⑩ 维护门", false, "读不出（" + g.why + "）—— 入口都按维护中处理；畸形制品不自动删，请人工核对 " + (g.detail ?? maintenanceGatePath()), null);
  }

  // ⑪ 安装收据（Claude 链，维护门 PR B）：三态 + 锁 / 临时文件残骸盘点。没有收据不算病（旧运行时没记）；读不出与残骸只人工处置
  {
    const file = installedSurfacePath({ chain: "claude", home });
    const r = inspectInstalledSurface({ file, now });
    const residueText = r.residues.length === 0 ? "" : "；残骸 " + r.residues.length + " 处：" + r.residues.slice(0, 3).map((x) => x.path + "（" + x.detail + "）").join("、") + (r.residues.length > 3 ? "…" : "");
    const entry = r.state === "valid" ? r.doc.chains.claude : null;
    const body = r.state === "absent" ? "没有（旧运行时没记；装含收据代码的版本后出现）"
      : r.state === "valid" ? (entry ? "有：版本 " + entry.version + "，" + entry.artifacts.length + " 个制品，" + entry.at : "有，但没有 Claude 链的条目")
      : "读不出（" + r.why + "）—— 畸形不自动删，请人工核对 " + file;
    add("installed_surface", "⑪ 安装收据", r.state !== "unreadable" && r.residues.length === 0, body + residueText, null);
  }

  // ⑫ 订阅控制面 store 与审计对账（FR-2.6 单 4）：store / 审计 / 待补记都只读判三态，再对账
  // 「审计末条的 store_bytes_sha256 vs 当前 store 实际哈希」—— 最后一次审计之后 store 被绕过
  // 写入或审计缺笔，这里点名。**未启用只在 store 与审计都不在时成立**；审计制品存在而 store 缺席
  // 是「对不上」不是「未启用」→ 红；store 在而审计缺席 → null（提示，不把别的检查染红）。
  // 全只读，不算 store 里的敏感值（chat_id / sender 明细不出现 —— 审计行本来就只有哈希）。
  // store 路径可显示；回显 operation_id 的 next 先过形状校验（P1-2），再 displaySafe 双保险。
  {
    const file = subscriptionStorePath({ home });
    const store = loadSubscriptionStore({ file });
    const audit = loadSubscriptionAudit({ file });
    const pending = loadSubscriptionAuditPending({ file });
    const hash = storeHashState({ file });
    const statuses = (s) => (store.subscriptions ?? []).filter((x) => x.status === s).length;
    const statusText = store.ok
      ? store.subscriptions.length + " 条订阅（active " + statuses("active") + "，paused " + statuses("paused") + "）"
      : null;
    let ok, detail, next = null;
    if (store.ok === false) {
      ok = false;
      detail = "订阅 store 读不出来（" + (store.problems ?? []).slice(0, 3).join("；") + "）—— 受验读失败，订阅控制面对账说不清（fail-closed，不臆断订阅是开是关），请人工核对 " + file;
    } else if (pending.ok === false) {
      ok = false;
      detail = "待补记读不出来（" + ((pending.problems ?? []).slice(0, 2).join("；") || pending.detail || pending.reason || "说不清") + "）—— 它持续阻断后续写入，请人工核对 " + subscriptionAuditPendingPath(file);
    } else if (!pending.absent && pending.pending) {
      ok = false;
      const op = displaySafe(pending.pending.operation_id);
      detail = "有待补记（op " + short(op) + "）—— 上次变更的审计没写成，会持续阻断后续写入；对账先看它";
      next = "node scripts/register-subscription.mjs --resolve-audit-conflict " + shellQuote(op) + " --store " + shellQuote(file) + " （预览；确认后自行加 --apply）";
    } else if (audit.ok === false) {
      ok = false;
      detail = "订阅审计读不出来（" + ((audit.problems ?? []).slice(0, 2).join("；") || audit.detail || audit.reason || "说不清") + "）—— 对账靠它，读不出只能按说不清处理，请人工核对 " + file + ".audit.jsonl";
    } else if (store.absent && audit.absent) {
      ok = true;
      detail = "未启用订阅控制面（store 与审计都不在）";
    } else if (store.absent) {
      // 审计制品存在（哪怕为空）而 store 缺席 —— 不是「都不在」，不能判未启用；对账对不上 → 红。
      ok = false;
      const auditNote = audit.events.length > 0 ? "有 " + audit.events.length + " 条记录" : "存在但为空";
      detail = "订阅审计" + auditNote + "而 store 缺席（store 被删或路径漂移），对账对不上，请人工核对 " + file;
    } else if (audit.absent || audit.events.length === 0) {
      ok = null;
      detail = statusText + "；审计缺席/为空（无写入记录，无法对账）—— store 在而审计不在，说明从没变更过或审计被清，先手动核对 " + file + ".audit.jsonl";
    } else {
      const last = audit.events[audit.events.length - 1];
      if (hash.state !== "valid" || last.store_bytes_sha256 !== hash.sha256) {
        ok = false;
        detail = "最后一次审计后 store 被绕过写入或审计缺笔（审计记 " + (hash.state === "valid" ? short(last.store_bytes_sha256) : "?") + "，实际 " + (hash.state === "valid" ? short(hash.sha256) : "读不清") + "）—— 重跑 register-subscription --apply 补记/对账，或人工核 " + file;
      } else {
        ok = true;
        detail = statusText + "；审计 " + audit.events.length + " 行，末条 " + last.action + " @ " + String(last.at).slice(0, 10) + "；对账一致（" + short(last.store_bytes_sha256) + "）";
      }
    }
    add("subscription_audit", "⑫ 订阅控制面 store 与审计对账", ok, detail, next);
  }

  // ⑬ 账本维护对账（B-3）：每个 endpoint 的永久收据投影唯一且一致；cutover 收据在账本里有不可变事务祖先（operations[token]）
  // + authority_mode=authoritative + revision>=result_revision（**不比较当前 SHA**，账本自身合法性 loadLedger 即含 G1–G15）。
  // 没有收据的 endpoint（never_initialized）不算病；收据读不出 / 重复 / 矛盾 → fail-closed 染红；init 有收据却写不出账本 → 染红。
  {
    const dir = maintenanceDir();
    if (dir === null) {
      add("ledger_receipt", "⑬ 账本维护收据", null, "家目录查不出来，收据目录未知", null);
    } else {
      const agg = aggregateEndpointReceipts({ dir });
      if (!agg.ok) {
        const body = agg.unreadable.length > 0
          ? "目录 " + dir + " 里 " + agg.unreadable.length + " 个 journal 读不出（如 " + agg.unreadable[0].token.slice(0, 8) + "：" + agg.unreadable[0].why + "）—— 收据 fail-closed，请人工核对"
          : "收据矛盾：" + agg.why + " —— 重复 / 顺序不符，请人工核对 " + dir;
        add("ledger_receipt", "⑬ 账本维护收据", false, body, null);
      } else {
        const problems = [];
        const parts = [];
        for (const ep of agg.endpoints) {
          if (ep.state === "never_initialized") continue; // 未接入账本，不算病
          const L = loadByEndpoint(ep.endpointId);
          if (L.ok === false) {
            problems.push(ep.endpointId + "：" + (L.reason === "absent" ? "有收据但账本丢了（ledger 不存在）—— 收据能证明曾初始化，但路由目录无证" : "账本读不出（G1–G15 有疑）：" + (L.why ?? L.reason)));
            continue;
          }
          const doc = L.doc;
          if (ep.cutoverDone) {
            for (const tok of ep.cutoverTokens) {
              const op = doc.operations[tok];
              if (!op || op.op_type !== "authority_cutover") { problems.push(ep.endpointId + "：cutover 收据 " + tok.slice(0, 8) + " 在账本 operations 表里没有不可变事务祖先"); continue; }
              if (doc.authority_mode !== "authoritative") { problems.push(ep.endpointId + "：切过权威但账本 authority_mode=" + doc.authority_mode + "（应为 authoritative）"); break; }
              if (doc.revision < op.result_revision) { problems.push(ep.endpointId + "：账本 revision=" + doc.revision + " 落后于 cutover 收据 result_revision=" + op.result_revision); break; }
            }
          } else if (doc.authority_mode !== "shadow") {
            problems.push(ep.endpointId + "：只有 init 收据但账本 authority_mode=" + doc.authority_mode + "（应为 shadow，或该补 cutover）");
          }
          parts.push(ep.endpointId + "=" + ep.state + (ep.initDone ? "（init" + ep.initCount + "）" : "") + (ep.cutoverDone ? "（cutover" + ep.cutoverCount + "）" : ""));
        }
        const body = parts.length === 0 ? "没有 endpoint 收据（接入账本后出现）"
          : parts.join("、") + "；" + (problems.length === 0 ? "对得上" : "说不清 " + problems.length + " 处：" + problems.slice(0, 3).join("；"));
        add("ledger_receipt", "⑬ 账本维护收据", problems.length === 0, body, null);
      }
    }
  }

  // ⑭ M1a 影子对账（规格 docs/architecture/m1a-reconciliation.md v6 §7）：旁路跑只读 reconciler。
  // 账本缺席不再一律跳过 —— 按初始化收据分支：never_initialized+缺席 → 跳过；init WAL 未完成（prepared）
  // → 按 B-2 恢复矩阵报告（只许同 token 恢复）；有初始化收据但账本缺席/读不出 → ledger_missing 红（禁重初始化）。
  // 输出纪律：问题码 + opaque id / 哈希前缀 / 计数；绝不原样输出 locator/session/thread/项目路径。
  {
    const dir = maintenanceDir();
    if (dir === null) {
      add("m1a_shadow_reconcile", "⑭ M1a 影子对账", null, "家目录查不出来，收据目录未知", null);
    } else {
      const agg = aggregateEndpointReceipts({ dir });
      if (!agg.ok) {
        add("m1a_shadow_reconcile", "⑭ M1a 影子对账", false,
          "收据 fail-closed（" + (agg.unreadable.length > 0 ? agg.unreadable.length + " 个 journal 读不出，如 " + agg.unreadable[0].token.slice(0, 8) : agg.why) + "）", null);
      } else {
        const prep = preparedLedgerInits({ dir });
        if (!prep.ok) {
          add("m1a_shadow_reconcile", "⑭ M1a 影子对账", false, "init WAL 判定 fail-closed（" + prep.why + "）", null);
        } else {
          const findings = [];
          const parts = [];
          const preparedBy = new Map(prep.prepared.map((p) => [p.endpointId, p]));
          const receiptBy = new Map(agg.endpoints.map((e) => [e.endpointId, e]));
          // endpoint 全集 = 有收据 ∪ 有 prepared WAL ∪ 账本目录（账本在场无收据也是矛盾态）。
          const ledgerDirs = [];
          const root = ledgerRootFor();
          let rootUnreadable = null;
          if (root !== null) {
            try {
              for (const de of fs.readdirSync(root, { withFileTypes: true })) {
                // 封闭枚举（复评 P1-4）：endpoint 名下的非真目录（文件/symlink）不算缺席也不算未接入；
                // 陌生名字同样不静默。名字本身是 opaque id，只戴帽展示。
                if (ENDPOINT_SHAPE.test(de.name)) {
                  if (de.isDirectory()) ledgerDirs.push(de.name);
                  else rootUnreadable ??= "endpoint 名下有非目录制品（" + de.name.slice(0, 12) + "…）";
                } else if (de.name !== "receipts") {
                  rootUnreadable ??= "账本根有未登记条目（" + de.name.slice(0, 12) + "…）";
                }
              }
            } catch (err) {
              // 只有 ENOENT 折空（= 无任何账本）；I/O / 权限 / 形状错不能假装"未接入"（评审 P1-3）。
              if (err?.code !== "ENOENT") rootUnreadable = err?.code ?? String(err?.message ?? err).slice(0, 40);
            }
          }
          if (rootUnreadable !== null) {
            findings.push({ endpoint: null, ok: false, code: "ledger_inventory_unreadable",
              detail: "ledger_inventory_unreadable：账本根盘点读不出（" + rootUnreadable + "）—— 无法盘点 shadow 账本，禁止当成未接入" });
          }
          const endpoints = [...new Set([...receiptBy.keys(), ...preparedBy.keys(), ...ledgerDirs])].sort();
          for (const ep of endpoints) {
            const receipt = receiptBy.get(ep) ?? null;
            const prepJ = preparedBy.get(ep) ?? null;
            const L = loadByEndpoint(ep);
            if (prepJ !== null) {
              findings.push({ endpoint: ep, ok: false, code: "init_wal_prepared",
                detail: "初始化 WAL 未完成（token " + prepJ.token.slice(0, 8) + "，phase " + prepJ.phase + "）—— 按 B-2 恢复矩阵只允许同 token 恢复，禁止重初始化" });
              continue;
            }
            if (L.ok === false) {
              // 只出封闭的 L.reason（复评 P1-3）：校验器 why 原文可能带重复 locator 明文（session/root om_）。
              if (receipt?.state === "ok" || receipt?.cutoverDone) {
                findings.push({ endpoint: ep, ok: false, code: "ledger_missing",
                  detail: (L.reason === "absent" ? "有初始化收据但账本缺席" : "有初始化收据但账本读不出（" + L.reason + "）") + " —— 禁止重初始化，需人工恢复" });
              } else if (receipt === null) {
                findings.push({ endpoint: ep, ok: false, code: "ledger_without_receipt",
                  detail: "账本" + (L.reason === "absent" ? "目录在但读不出内容" : "读不出") + "且无初始化收据 —— 无法证明来历" });
              }
              // receipt never_initialized + 账本读不出：按 ledger_missing 同义（有迹象但无收据时已由上一支接住）。
              else {
                findings.push({ endpoint: ep, ok: false, code: "ledger_missing",
                  detail: "无完成收据且账本读不出（" + L.reason + "）—— 不得重初始化" });
              }
              continue;
            }
            if (receipt === null || receipt.state !== "ok") {
              // 账本读得出但无完成 init 收据（或有 prepared 已在上面接住）。
              findings.push({ endpoint: ep, ok: false, code: "ledger_without_receipt",
                detail: "账本在场但无完成初始化收据 —— 无法证明来历" });
              continue;
            }
            // 收据 ok ∧ 账本可读 ∧ 已切权威 → M1a 影子对账不适用（评审 P1-5）：切权威后账本合法
            // 演进、legacy 冻结，双射只会永久误红；只确认权威态，不跑对账。
            if (receipt.cutoverDone) {
              parts.push(ep + "=cutover 已收口（M1a 影子对账不适用）");
              continue;
            }
            // 收据 ok ∧ 账本可读 → 旁路对账（严格只读）。
            const chain = L.doc.chain;
            const collectLegacy = chain === "claude"
              ? () => collectClaudeLegacySnapshot({
                  registryFile: ctx.registryFile,
                  templateFile: path.join(ctx.home, ".claude", "feishu-bridge", "chain-config.json"),
                })
              : () => collectCodexLegacySnapshot({ home: ctx.codexEnv.FEISHU_CODEX_BRIDGE_HOME });
            const r = reconcileLegacyEndpoint({ endpointId: ep, chain, collectLegacy, loadLedgerFn: () => loadByEndpoint(ep) });
            if (r.ok === true) {
              // 对账一致但 cutover 受阻是**确定的红**，不是"一致（待修）"（评审 P1-4）。
              if (r.cutover_blockers.length > 0) {
                findings.push({ endpoint: ep, ok: false, code: "cutover_blocked",
                  detail: "cutover_blocked：对账一致但 cutover_blockers=" + r.cutover_blockers.length
                    + "（" + r.cutover_blockers.slice(0, 3).map((b) => b.code).join("、") + "）—— 任一 blocker 则 cutover 拒" });
              } else {
                parts.push(ep + "=一致");
              }
            } else if (r.ok === null) {
              findings.push({ endpoint: ep, ok: null, code: r.reason,
                detail: "对账不可判（snapshot_moved）—— 下轮体检再看" });
            } else {
              const bits = [];
              if (r.reason === "bijection_mismatch") {
                bits.push("双射不成立：legacy 多 " + r.mismatches.filter((m) => m.code === "extra_in_legacy").length
                  + " / shadow 多 " + r.mismatches.filter((m) => m.code === "extra_in_shadow").length
                  + " / 字段不等 " + r.mismatches.filter((m) => m.code === "field_mismatch").length);
                for (const m of r.mismatches.slice(0, 5)) {
                  bits.push(m.code + "（ta:" + m.topic_agent_id.slice(0, 8) + "…" + (m.field ? "，" + m.field : "") + "）");
                }
              } else {
                // 不透适配器/reconciler 的 why 原文（评审 P1-6：legacy why 可能携带项目名/task key 等非
                // opaque 身份）；只出问题码 + 来源域（封闭枚举）。
                bits.push(r.reason + (r.source ? "（" + r.source + "）" : ""));
              }
              if (r.cutover_blockers.length > 0) {
                bits.push("待修 " + r.cutover_blockers.length + "：" + r.cutover_blockers.slice(0, 3).map((b) => b.code).join("、"));
              }
              findings.push({ endpoint: ep, ok: false, code: r.reason, detail: bits.join("；") });
            }
          }
          const okAll = findings.some((f) => f.ok === false) ? false
            : findings.some((f) => f.ok === null) ? null : true;
          const shown = findings.slice(0, 10).map((f) => f.endpoint + "：" + f.detail);
          const overflow = findings.length > 10 ? "；另 " + (findings.length - 10) + " 条（完整清单由维护写入口随 op 落盘，体检零写入）" : "";
          const body = (endpoints.length === 0 ? "无任何 shadow 账本 / 收据（未接入）"
            : (parts.length > 0 ? parts.join("、") + "；" : "")
              + (findings.length === 0 ? "对账一致" : findings.length + " 处说不清：" + shown.join("；")) + overflow);
          add("m1a_shadow_reconcile", "⑭ M1a 影子对账", okAll, body, null);
        }
      }
    }
  }

  // ── 汇总：任一 false → blocked；无 false 有 null → incomplete；全 true → ready
  const overall = checks.some((c) => c.ok === false) ? "blocked"
    : checks.some((c) => c.ok === null) ? "incomplete" : "ready";
  const next = [...new Set(checks.filter((c) => c.ok !== true && c.next).map((c) => c.next))];
  return { overall, checks, next };
}

export function renderDoctor(report) {
  const lines = ["飞书桥 · 机器级体检（只读，不修）", ""];
  for (const c of report.checks) {
    const mark = c.ok === true ? "✓ " : c.ok === false ? "✗ " : "? ";
    lines.push(mark + c.name + "：" + c.detail);
  }
  lines.push("");
  lines.push(report.overall === "ready" ? "结论：ready —— 没有发现跨项目说不通的地方。"
    : report.overall === "blocked" ? "结论：blocked —— 上面标 ✗ 的是真故障，需要人处理。"
    : "结论：incomplete —— 没有发现故障，但标 ? 的本地查不出来。");
  if (report.next.length > 0) {
    lines.push("", "下一步（都是预览形式，改动要你自己确认）：");
    report.next.forEach((n, i) => lines.push((i + 1) + ". " + n));
  }
  return lines.join("\n");
}

export const DOCTOR_EXIT = Object.freeze({ ready: 0, blocked: 1, incomplete: 2 });

if (isDirectRun(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--json" && a !== "--probe-providers");
  if (unknown.length > 0) {
    console.error("参数不对：" + unknown.join(" ") + " —— 只接受 --json 与 --probe-providers。体检只读，没有别的开关。");
    process.exit(1);
  }
  const report = runDoctor({ probeProviders: args.includes("--probe-providers") });
  if (args.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else console.log(renderDoctor(report));
  process.exit(DOCTOR_EXIT[report.overall]);
}
