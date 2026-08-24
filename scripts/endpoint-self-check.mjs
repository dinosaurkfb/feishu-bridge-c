/**
 * 端点自检（FR-1.4）—— 回答「本机这一半准备好了没有」。
 *
 * 为什么需要它：Aily 那一侧的连接是**被动**的 —— 把第三方智能体加进来它就存在，
 * 本机没有任何东西能「发起」它。所以没有 connect 这个动作，只有「本机接得住吗」。
 * 而在这之前，状态里第 1 层只能写「未自检」：不是查过说没问题，是根本没查。
 *
 * FR-1.4 要求区分四种，这四种的**下一步动作完全不同**，混成一句「不可用」等于没说：
 *
 *   bridge 未安装   → 跑安装器
 *   adapter 不可用  → lark-cli 不在或不能执行，装它
 *   daemon 离线     → aily-cli daemon start（**由人来做**）
 *   身份不匹配      → 凭据属于别的应用，重新登录或改模板
 *
 * 三条纪律：
 *
 *   · **只读。**不自动登录、不修复、不重启 —— 自检的价值在于如实报告，
 *     一个会顺手修东西的体检会让人不知道刚才到底发生了什么。
 *   · **限时。**每个探测都有超时，本机某个环节挂住不该让 status 跟着挂住。
 *   · **查不动就说查不动。**探测本身失败要跟「查过了，是坏的」分开 ——
 *     把「不知道」报成「有问题」和报成「没问题」一样有害。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { assertPublishIdentity } from "./chain-template.mjs";
import { verifyRuntime } from "./runtime-install.mjs";

/**
 * 四项检查。**分清入站与出站** —— 上一版把它们混了：
 * 用 lark-cli 在不在回答"adapter 可用吗"（lark-cli 是**出站** OpenAPI 客户端，
 * 而 README 定义的 adapter 是 Aily 的 claude-code-local 运行环境），
 * 用 assertPublishIdentity 回答"身份对吗"（那是**出站发布**身份，
 * 不是入站 transport agent / endpoint / caller）。
 *
 * 后果是语义假阳性：入站身份 A、出站身份 B 的机器，四项全过、判 ready。
 * **这个功能本来就是为了防"拿不知道冒充没事"，结果它自己犯了另一种：
 * 拿别的知道冒充这个知道。**
 */
export const ENDPOINT_CHECK = Object.freeze({
  BRIDGE: "bridge_installed",
  DAEMON: "aily_daemon_running",
  ADAPTER: "aily_adapter_available",
  INBOUND: "inbound_transport_identity",
  OUTBOUND: "outbound_publish_identity",
});

/** 本机 adapter 的类型。FR-1.4 说的 adapter 是它，不是 lark-cli。 */
export const CLAUDE_ADAPTER_TYPE = "claude-code-local";

/** 每项只有这三种结论。**unknown 不是 fail** —— 查不动和查出问题是两回事。 */
export const CHECK_RESULT = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  UNKNOWN: "unknown",
});

export const PROBE_TIMEOUT_MS = 8000;

const item = (id, result, detail, action = null) => ({ id, result, detail, action });

/** bridge 装没装：复用 verifyRuntime，只有完整校验通过才算装好。 */
function checkBridge(verify) {
  const got = verify();
  if (got.ok) return item(ENDPOINT_CHECK.BRIDGE, CHECK_RESULT.PASS, "运行时已安装并校验通过");
  if (got.reason === "current_absent") {
    return item(ENDPOINT_CHECK.BRIDGE, CHECK_RESULT.FAIL, "运行时未安装",
      "跑一次 scripts/install-outbound.mjs --apply");
  }
  // 装了但坏了 —— 跟没装不是一回事，别合并成同一句。
  return item(ENDPOINT_CHECK.BRIDGE, CHECK_RESULT.FAIL, "运行时不可用（" + got.reason + "）",
    "重装运行时；先看清是漂移还是链接异常");
}

/**
 * **出站**：lark-cli 可执行 + 凭据属于模板说的那个应用。
 *
 * 这两件事都是出站的。它们过了只说明"发得出去"，**不说明入站接得住** ——
 * 上一版拿它们当过了整条链路的证明。
 */
function checkOutbound(bin, identity, access, assertFn) {
  if (typeof bin !== "string" || !bin) {
    return item(ENDPOINT_CHECK.OUTBOUND, CHECK_RESULT.UNKNOWN, "模板里没有 lark_cli_bin");
  }
  try { access(bin); } catch {
    return item(ENDPOINT_CHECK.OUTBOUND, CHECK_RESULT.FAIL, "lark-cli 不在或不能执行",
      "确认 " + bin + " 存在且有执行权限");
  }
  if (!identity?.expectedAppId) {
    return item(ENDPOINT_CHECK.OUTBOUND, CHECK_RESULT.UNKNOWN, "lark-cli 可执行，但模板没声明期望的应用");
  }
  let got;
  try {
    got = assertFn({ configDir: identity.configDir, profile: identity.profile,
      expectedAppId: identity.expectedAppId });
  } catch {
    return item(ENDPOINT_CHECK.OUTBOUND, CHECK_RESULT.UNKNOWN, "查不动出站凭据归属");
  }
  return got?.ok
    ? item(ENDPOINT_CHECK.OUTBOUND, CHECK_RESULT.PASS, "lark-cli 可执行，凭据属于配置说的那个应用")
    : item(ENDPOINT_CHECK.OUTBOUND, CHECK_RESULT.FAIL,
      "出站身份不匹配（" + (got?.reason ?? "unknown") + "）",
      "重新登录该 profile，或把模板改成实际在用的应用");
}

/**
 * daemon 在不在。**用 --json**。
 *
 * 上一版跑不带 --json 的 `daemon status`，非零退出一律落到"探测失败"（unknown）。
 * 于是 daemon **真的离线**时报的是"查不动" —— 而 aily-cli 明确会给出
 * DAEMON_UNREACHABLE。**离线是查出来的结论，必须是 fail**；
 * 把它报成 unknown，等于让人以为"可能没事"。
 *
 * 非零退出时错误对象上带着 stdout/stderr，JSON 往往就在里面 —— 不看它就等于
 * 把一个明确的答案当成了没答案。
 */
function checkDaemon(bin, exec) {
  const cmd = typeof bin === "string" && bin ? bin : "aily-cli";
  let raw = null;
  try {
    raw = String(exec(cmd, ["daemon", "status", "--json"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: PROBE_TIMEOUT_MS,
    }));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.FAIL, "找不到 aily-cli（" + cmd + "）",
        "确认 aily-cli 已安装，或在模板里写明 aily_cli_bin");
    }
    if (err?.code === "ETIMEDOUT") {
      return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.UNKNOWN, "查不动（超时）");
    }
    raw = String(err?.stdout ?? "") + String(err?.stderr ?? "");
  }
  const parsed = parseJson(raw);
  if (parsed === null) {
    return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.UNKNOWN, "看不懂 daemon status 的输出");
  }
  if (parsed.ok === true && parsed.data?.running === true) {
    return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.PASS, "daemon 在跑");
  }
  const code = parsed.error?.code ?? parsed.code ?? null;
  if (code === "DAEMON_UNREACHABLE" || parsed.data?.running === false) {
    return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.FAIL, "daemon 没在跑" + (code ? "（" + code + "）" : ""),
      "由你运行 aily-cli daemon start —— 自检不替你启动");
  }
  return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.UNKNOWN,
    "daemon 状态说不清" + (code ? "（" + code + "）" : ""));
}

/** 从可能混着别的输出的文本里取出第一段 JSON。取不到就返回 null，不猜。 */
function parseJson(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 往下试 */ }
  const at = t.search(/[[{]/u);
  if (at < 0) return null;
  try { return JSON.parse(t.slice(at)); } catch { return null; }
}

/**
 * **本机 adapter**：Aily 的 claude-code-local 运行环境在不在、探得到吗。
 *
 * 上一版拿 lark-cli 在不在回答这个问题 —— 但 lark-cli 是**出站** OpenAPI 客户端，
 * README 定义的 adapter 是这个。两者都过不能互相证明：
 * 出站发得出去，不代表 Aily 调得起本机的 Claude。
 *
 * 「登记了」和「探得到」也是两件事：adapter list 里有这一条只说明注册过，
 * runtimeProbe.available 才是"现在能用"。
 */
function checkAdapter(bin, exec, adapterType) {
  const cmd = typeof bin === "string" && bin ? bin : "aily-cli";
  let raw = null;
  try {
    raw = String(exec(cmd, ["adapter", "list", "--json"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: PROBE_TIMEOUT_MS,
    }));
  } catch (err) {
    if (err?.code === "ETIMEDOUT") {
      return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.UNKNOWN, "查不动（超时）");
    }
    raw = String(err?.stdout ?? "") + String(err?.stderr ?? "");
  }
  const parsed = parseJson(raw);
  const list = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.data?.adapters) ? parsed.data.adapters
      : Array.isArray(parsed?.data) ? parsed.data : null;
  if (list === null) {
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.UNKNOWN, "看不懂 adapter list 的输出");
  }
  const hit = list.find((a) => a?.adapter === adapterType || a?.runtime?.type === adapterType);
  if (!hit) {
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.FAIL, adapterType + " 没有登记",
      "在 Aily 里注册本机 adapter");
  }
  const probe = hit.runtimeProbe;
  if (probe?.available === true) {
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.PASS, adapterType + " 已登记且探测可用");
  }
  if (probe?.available === false) {
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.FAIL,
      adapterType + " 已登记但探测不可用" + (probe.reason ? "（" + probe.reason + "）" : ""),
      "确认对应的本机 CLI 可执行");
  }
  // 登记了但没有探测结论 —— 不能当成可用。
  return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.UNKNOWN,
    adapterType + " 已登记，但没有探测结论");
}

/**
 * **入站**：transport agent / Aily endpoint / caller 身份对不对。
 *
 * **本机没有可信的入站身份事实来源。**AILY_CLI_CALLER_AGENT_UID 只在真实入站回合的
 * 环境里出现，status 跑的时候拿不到；模板里写的是**期望值**，不是观测值。
 *
 * 所以这一项**只能是 unknown**，除非将来有一条正面验证入站身份的途径。
 * 拿出站身份顶替是上一版的做法，那让入站身份 A、出站身份 B 的机器判成了 ready。
 *
 * 历史证据（最近一次成功入站）由展示层单独给出，**不参与这一项的判定** ——
 * 那是"过去某刻对过"，不是"现在对"。
 */
function checkInbound(template) {
  const declared = typeof template?.agent_uid === "string" && template.agent_uid.length > 0;
  return item(ENDPOINT_CHECK.INBOUND, CHECK_RESULT.UNKNOWN,
    declared
      ? "无法本机验证（模板声明了 transport agent，但那是期望值不是观测值）"
      : "无法本机验证，且模板没有声明 transport agent",
    declared ? null : "在链路模板里补上 agent_uid");
}

/**
 * 跑一遍自检。**顺序是从根到梢**：bridge 没装，后面几项查了也没意义。
 * 但**不早退** —— 一次说清全部四项，比让人修一个跑一次强。
 */
export function checkEndpoint({
  template, identity,
  verify = () => verifyRuntime(),
  access = (bin) => fs.accessSync(bin, fs.constants.X_OK),
  exec = execFileSync,
  assertFn = assertPublishIdentity,
  adapterType = CLAUDE_ADAPTER_TYPE,
} = {}) {
  const checks = [
    checkBridge(verify),
    checkDaemon(template?.aily_cli_bin, exec),
    checkAdapter(template?.aily_cli_bin, exec, adapterType),
    checkInbound(template),
    checkOutbound(template?.lark_cli_bin, identity, access, assertFn),
  ];
  const failed = checks.filter((c) => c.result === CHECK_RESULT.FAIL);
  const unknown = checks.filter((c) => c.result === CHECK_RESULT.UNKNOWN);
  return {
    checks,
    // 三态汇总：全过才是 ready，有 fail 就是 blocked，
    // 只有 unknown 说明**没查清**——不许把它算成 ready。
    verdict: failed.length > 0 ? "blocked" : unknown.length > 0 ? "incomplete" : "ready",
    failed: failed.map((c) => c.id),
    unknown: unknown.map((c) => c.id),
  };
}

const RESULT_MARK = { pass: "✅", fail: "❌", unknown: "❔" };
const CHECK_LABEL = {
  [ENDPOINT_CHECK.BRIDGE]: "运行时",
  [ENDPOINT_CHECK.DAEMON]: "Aily daemon",
  [ENDPOINT_CHECK.ADAPTER]: "本机 adapter",
  [ENDPOINT_CHECK.INBOUND]: "入站身份",
  [ENDPOINT_CHECK.OUTBOUND]: "出站身份",
};

export function renderEndpointCheck(report) {
  return report.checks.map((c) =>
    RESULT_MARK[c.result] + " " + (CHECK_LABEL[c.id] ?? c.id) + "　" + c.detail +
    (c.action ? "\n     → " + c.action : "")).join("\n");
}
