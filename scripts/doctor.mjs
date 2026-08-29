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
import os from "node:os";
import path from "node:path";

import { displaySafe } from "./display-safe.mjs";
import { isDirectRun, moduleDir } from "./direct-run.mjs";
import { auditOutbox } from "./outbox.mjs";
import { inspectRunChannel, outboxDirOf } from "./drain-outbox.mjs";
import { loadRegistryStrict, registryPath } from "./registry.mjs";
import { loadRoutes, routesPath, defaultRouteHandler } from "./inbound-routes.mjs";
import { collectConnectivity, loadStatusProviders, statusProvidersPath } from "./status-providers.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { pendingGeneration } from "./topic-generation.mjs";
import { verifyRuntime, runtimeRoot } from "./runtime-install.mjs";
import { shellQuote } from "./shell-quote.mjs";
import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, pickClaudeNode } from "./drain-schedule.mjs";
import { spawnSync } from "node:child_process";
import { LAUNCHCTL_ENV, PHASE_TEXT, loadedPhase } from "./launchd-job.mjs";

/** 到期预警阈值：7 天内到期就点名。**明写**，不藏在比较式里。 */
export const EXPIRY_WARN_MS = 7 * 24 * 3600 * 1000;

const PREVIEW = {
  installOutbound: "node scripts/install-outbound.mjs（预览；确认后自行加 --apply）",
  registerProvider: "node scripts/register-status-provider.mjs --id <route id> --script <状态脚本>（预览；确认后自行加 --apply）",
  bindProject: "node scripts/bind-project.mjs（预览；确认后自行加 --apply）",
  // 这条命令控制权威路由：路径一律 shellQuote，不靠"本机路径恰好没空格"。命令与说明之间留一个空格，整段可复制、也可切出命令。
  restoreDefaultRoute: (routesFile, handler) => "node scripts/register-route.mjs --restore-default --routes " + shellQuote(routesFile) + " --handler " + shellQuote(handler) + " （预览；切权威路由，Frank 授权后自行加 --apply）",
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

  // ── ① ② 路由 ↔ 状态入口（collectConnectivity 是唯一判据：unregistered / unavailable / disabled）
  const links = collectConnectivity({ routesFile, providersFile, ...(probeProviders ? {} : { run: NOT_PROBED }) });
  const tablesUnclear = links.providersProblem !== null || links.routesProblem !== null;
  const unregistered = links.sections.filter((s) => s.state === "unregistered");
  const unavailable = links.sections.filter((s) => s.state === "unavailable" && s.reason !== "not_probed");
  add("route_without_provider", "① route 有状态入口",
    tablesUnclear ? null : unregistered.length === 0,
    tablesUnclear ? "路由表或状态入口表读不出来，查不清（" + (links.routesProblem ?? links.providersProblem) + "）"
      : unregistered.length === 0 ? "每条启用路由都有获准报告运输状态的状态入口"
      : unregistered.length + " 条路由没有状态入口：" + list(unregistered, (s) => s.id),
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

  // ── ⑦ 入站默认处理器必须就是装好的运行时（issue #88：装了 ≠ 在跑）
  {
    const runtimeCurrent = path.join(runtimeRoot(home, "claude"), "current");
    const expectedHandler = path.join(runtimeCurrent, "scripts", "inbound.mjs");
    const d = defaultRouteHandler({ file: routesFile, runtimeCurrent, expectedHandler });
    const othersText = d.others?.length ? "；另有 " + d.others.length + " 条非默认路由的处理器在运行时之外（按备注分辨）：" + list(d.others, (o) => o.id + " → " + o.handler) : "";
    add("default_route_handler", "⑦ 入站默认处理器在 runtime/current 之下",
      d.status === "runtime" || d.status === "no_routes" ? true : d.status === "unreadable" ? null : false,
      d.status === "runtime" ? "默认路由 " + d.id + " → 装好的运行时" + othersText
        : d.status === "no_routes" ? d.why + "，分发器用运行时自带的默认处理器"
        : d.status === "outside" ? "默认路由 " + d.id + " 的处理器不是装好的运行时：" + d.handler + (d.note ? "（备注：" + d.note + "）" : "") + "；" + d.why + " —— 装到 runtime/current 的代码没在处理入站" + othersText
        : d.status === "no_default" ? "没有默认路由（" + d.why + "）—— 未登记话题会被拒，不会回退运行时；需要人工给其中一条标 default（register-route 不设默认：默认路由是权威路由）"
        : "路由表读不出来，查不清（" + d.why + "）",
      d.status === "outside" ? PREVIEW.restoreDefaultRoute(routesFile, expectedHandler) : null);
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
