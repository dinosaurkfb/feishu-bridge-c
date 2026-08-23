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

export const ENDPOINT_CHECK = Object.freeze({
  BRIDGE: "bridge_installed",
  ADAPTER: "adapter_available",
  DAEMON: "daemon_running",
  IDENTITY: "identity_matches",
});

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

/** adapter 在不在：lark-cli 得存在且可执行。 */
function checkAdapter(bin, access) {
  if (typeof bin !== "string" || !bin) {
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.UNKNOWN, "模板里没有 lark_cli_bin");
  }
  try {
    access(bin);
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.PASS, "lark-cli 可执行");
  } catch {
    return item(ENDPOINT_CHECK.ADAPTER, CHECK_RESULT.FAIL, "lark-cli 不在或不能执行",
      "确认 " + bin + " 存在且有执行权限");
  }
}

/**
 * daemon 在不在。
 *
 * **退出码为 0 不足以判定在跑** —— 实测 `daemon status` 在 daemon 停着时同样退 0，
 * 所以看输出里怎么说。看不懂就报 unknown，不猜。
 */
function checkDaemon(bin, exec) {
  // 模板没声明就按 PATH 找 —— aily_cli_bin 是可选字段，
  // 加进必填会让所有已经生成好的模板立刻变成"不完整"而全线拒绝。
  const cmd = typeof bin === "string" && bin ? bin : "aily-cli";
  let out;
  try {
    out = String(exec(cmd, ["daemon", "status"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: PROBE_TIMEOUT_MS,
    }));
  } catch (err) {
    // "二进制不在"是查出来的结论，"超时/别的错"是没查成 —— 两者不能合并。
    if (err?.code === "ENOENT") {
      return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.FAIL, "找不到 aily-cli（" + cmd + "）",
        "确认 aily-cli 已安装，或在模板里写明 aily_cli_bin");
    }
    return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.UNKNOWN,
      "查不动（" + (err?.code === "ETIMEDOUT" ? "超时" : "探测失败") + "）");
  }
  if (/not running|stopped|no daemon/iu.test(out)) {
    return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.FAIL, "daemon 没在跑",
      "由你运行 aily-cli daemon start —— 自检不替你启动");
  }
  if (/running/iu.test(out)) return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.PASS, "daemon 在跑");
  return item(ENDPOINT_CHECK.DAEMON, CHECK_RESULT.UNKNOWN, "看不懂 daemon status 的输出");
}

/** 凭据属不属于模板说的那个应用。复用发布前那道校验，两处判断不能分叉。 */
function checkIdentity(identity, assertFn) {
  if (!identity?.expectedAppId) {
    return item(ENDPOINT_CHECK.IDENTITY, CHECK_RESULT.UNKNOWN, "模板没声明期望的应用");
  }
  let got;
  try {
    got = assertFn({
      configDir: identity.configDir, profile: identity.profile,
      expectedAppId: identity.expectedAppId,
    });
  } catch {
    return item(ENDPOINT_CHECK.IDENTITY, CHECK_RESULT.UNKNOWN, "查不动凭据归属");
  }
  if (got?.ok) return item(ENDPOINT_CHECK.IDENTITY, CHECK_RESULT.PASS, "凭据属于配置说的那个应用");
  return item(ENDPOINT_CHECK.IDENTITY, CHECK_RESULT.FAIL,
    "身份不匹配（" + (got?.reason ?? "unknown") + "）",
    "重新登录该 profile，或把模板改成实际在用的应用");
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
} = {}) {
  const checks = [
    checkBridge(verify),
    checkAdapter(template?.lark_cli_bin, access),
    checkDaemon(template?.aily_cli_bin, exec),
    checkIdentity(identity, assertFn),
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
  [ENDPOINT_CHECK.ADAPTER]: "adapter",
  [ENDPOINT_CHECK.DAEMON]: "daemon",
  [ENDPOINT_CHECK.IDENTITY]: "身份",
};

export function renderEndpointCheck(report) {
  return report.checks.map((c) =>
    RESULT_MARK[c.result] + " " + (CHECK_LABEL[c.id] ?? c.id) + "　" + c.detail +
    (c.action ? "\n     → " + c.action : "")).join("\n");
}
