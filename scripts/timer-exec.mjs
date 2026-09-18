/**
 * launchctl / systemctl 的调用包装（PK3-L6-fix2：从 install-outbound.mjs 抽出来的**叶子模块**）。
 *
 * 为什么抽出来：这三个包装里装着两条与"真实用户控制面"有关的纪律（沙箱 HOME 不碰 launchd /
 * systemd --user、计划里的命令行不能整条 execFileSync）。它们是**可被测的纯包装**，
 * 但原先住在 install-outbound.mjs 里 —— 而那个文件是顶层脚本（import 即执行安装）。
 * 为了让用例能直接 import 它们而不用把安装器函数化（那会动到 apply/uninstall 主体）。
 *
 * 本模块只做三件事：判沙箱、调二进制、把失败原样带回来。没有副作用、不读 argv。
 */

import { execFileSync } from "node:child_process";
import os from "node:os";

import { absentJob } from "./launchd-job.mjs";
import { systemdUnitAbsent } from "./install-projection.mjs";

/**
 * **HOME 被覆盖时一律不碰 launchctl。**
 *
 * plist 文件路径跟着 `os.homedir()` 走，所以指定 HOME 就能把安装引到别处 —— 看起来像
 * 一个安全的沙箱安装。但 `launchctl bootout/bootstrap` 操作的是**真实用户的 launchd 域**，
 * 跟 HOME 一点关系都没有。于是一次"沙箱"安装会把线上那个兜底定时器卸掉，
 * 再把一个临时目录里的 plist 装进真实域 —— 临时目录一清，定时器就指向不存在的文件。
 *
 * 这不是假设：我为了测试 shell 安全性写了几条跑 `--apply` 的回归，用的正是临时 HOME，
 * 结果把线上 30 分钟兜底任务切到了临时目录。Codex 只读复核时发现的。
 *
 * `os.userInfo().homedir` 读的是密码库，不受 HOME 环境变量影响，所以能可靠区分
 * "真实安装"和"被重定向的安装"。
 */
const REAL_HOME = os.userInfo().homedir;
// PK3-L7-fix1：**调用时**求值，不在 import 时定死——套件的 HOME 隔离（installTestHomeIsolation）发生在
// 所有 ESM import 之后；import 时按真实 HOME 算出"非沙箱"会让「沙箱不碰真实 systemd」在套件里失效、
// 而外层 HOME=mktemp 起跑时又成立，用例随环境漂移。
const isSandboxed = () => os.homedir() !== REAL_HOME;

export const launchctl = (args, { tolerate = false } = {}) => {
  const injected = process.env.FEISHU_BRIDGE_LAUNCHCTL;
  if (!injected) {
    if (isSandboxed()) return { ok: false, skipped: true };
  }
  const bin = injected || "/bin/launchctl";
  try {
    execFileSync(bin, args, { stdio: "pipe", timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    // 失败要把**它说的话**带回来：卸载那一步要区分「本来就没有这个 job」与「真失败」。
    const text = String(err.stderr ?? "").trim() || String(err.message ?? err).split("\n")[0];
    if (!tolerate) console.error("  " + bin + " " + args.join(" ") + " 失败：" + text);
    return { ok: false, text, absent: absentJob(text) };
  }
};

// systemd 那一侧同一条纪律（PK3-L1）：沙箱 HOME 不碰**真实** systemd --user 实例 —— 理由与 launchctl 处
// 逐字相同：systemctl --user 操作的是当前登录用户的实例，跟 HOME 一点关系都没有。
// FEISHU_BRIDGE_SYSTEMCTL 是测试隔离点（与 FEISHU_BRIDGE_LAUNCHCTL 同一口径）。
export const systemctl = (args, { tolerate = false } = {}) => {
  // **argv 首项必须是 --user**（PK3-L6）：`systemctl enable --now foo.timer` 不带 --user 时动的是
  // **系统级**管理器 —— 那台机器上别的服务的状态会被一起改。断言留在这里，而不是靠调用点自觉。
  if (!Array.isArray(args) || args[0] !== "--user") {
    throw new Error("systemctl 包装收到的 args 首项必须是 \"--user\"，收到：" + JSON.stringify(args));
  }
  // 沙箱 HOME 默认不碰真实 systemd --user；**显式注入 FEISHU_BRIDGE_SYSTEMCTL 时例外** ——
  // 与 doctor 的 `sandboxed && !injected` 同一口径：注入点本来就是"换掉二进制"，
  // 而 linux 分支的卸载顺序只能在注入下做产品级验证（本机是 macOS）。
  const injected = process.env.FEISHU_BRIDGE_SYSTEMCTL;
  if (isSandboxed() && !injected) return { ok: false, skipped: true };
  const bin = injected || "systemctl";
  try {
    const res = execFileSync(bin, args, { stdio: "pipe", timeout: 15_000, encoding: "utf-8" });
    return { ok: true, out: res ?? "" };
  } catch (err) {
    const text = String(err.stderr ?? "").trim() || String(err.message ?? err).split("\n")[0];
    if (!tolerate) console.error("  " + bin + " " + args.join(" ") + " 失败：" + text);
    // `absent`："本来就没有这个单元" —— 干净卸载的常见形态，不箿成失败（判据与 doctor 共用一份）。
    return { ok: false, text, out: String(err.stdout ?? ""), err: String(err.stderr ?? ""), absent: systemdUnitAbsent(text) };
  }
};

/**
 * 跑计划里的一条命令。计划里的 `commands` 是**给人看的命令行**（首项是程序名，launchd 那条还带 `<uid>`
 * 占位符），直接拿去 execFileSync 会变成 `systemctl systemctl --user disable --now …` /
 * `launchctl launchctl bootout gui/<uid>/…` —— 两件都是静默失败（fix1 的卸载就是这么写的，所以那句
 * "已卸载"从来没真卸过）。执行只能走这里：去掉程序名、对每个参数做子串替换补齐真实 uid，
 * 二进制用本模块自己的包装（可以被 FEISHU_BRIDGE_LAUNCHCTL / FEISHU_BRIDGE_SYSTEMCTL 注入替换）。
 */
export const timerCmd = (argv) => {
  const [program, ...rest] = argv;
  if (program !== "launchctl" && program !== "systemctl") throw new Error("兜底定时器计划里不认识的程序：" + program);
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const args = rest.map((a) => a.replaceAll("<uid>", uid));
  return program === "launchctl" ? launchctl(args, { tolerate: true }) : systemctl(args, { tolerate: true });
};
