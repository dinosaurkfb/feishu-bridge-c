/**
 * 安装器的**投影**（issue #81 维护门 PR B）—— 三个安装器"要写成什么"的纯函数版本，只有这一份。
 *
 * 为什么抽出来：维护门要在 stage 阶段算出目标投影（不碰线上）、在 commit 阶段按受验字节写入、在预检阶段拿当前投影
 * 与线上逐字节对账（方案稿"三种投影"）。安装器原来把"算"和"写"揉在一个 CLI 脚本里，没法在不写的情况下问它"你会写成什么"。
 *
 * 契约：每个函数都是 `(输入) → 字节 / 对象`，不读线上文件（基线字节由调用方传入）、不写任何东西、不看 argv。
 * 安装器 CLI 只做：读基线 → 调这里 → 打印计划 → （apply）写入。产物必须与拆分前**逐字节一致**（测试盯着沙箱安装的产物）。
 *
 * 这一步只覆盖 Claude 链的三样东西：settings.json 的 hook 条目与预览放行规则、兜底 plist、技能文件；
 * Codex 链的 hooks.json / 技能 / plist 在 codex/hook-command.mjs、codex/skill-content.mjs、codex/drain-service.mjs 里本来就是函数。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runtimeScript } from "./runtime-install.mjs";
import { nodeCommandPrefix, shellQuote } from "./shell-quote.mjs";
import { CLAUDE_DRAIN_LAUNCH_LABEL, claudeDrainExpectedJob, installedNodeFrom, pickClaudeNode, timerKindFor, timerPlatform, resolveNodeForHooks } from "./drain-schedule.mjs";
export { timerKindFor, timerPlatform, resolveNodeForHooks };

/** 埋进命令里的显式归属标记：与脚本路径无关，换克隆、换 runtime 都认得出自己那条。 */
export const HOOK_TAG = "FEISHU_BRIDGE_HOOK:";

/** Claude 链三条 hook 的命令文本 —— 与 settings 里装着的必须逐字相同。 */
export function claudeHookCommands({ home = os.homedir(), node = pickClaudeNode() } = {}) {
  const hookScript = runtimeScript("stop-hook.mjs", home, "claude");
  const initScript = runtimeScript("init-hook.mjs", home, "claude");
  const inboundScript = runtimeScript("inbound-hook.mjs", home, "claude");
  const log = path.join(home, ".claude", "feishu-bridge", "stop-hook.log");
  // 外层 if 是为了「node 或脚本不在了」时不把钩子报错弹到本机每一次会话结束上。
  // 但也绝不能真的静默：else 分支往出站日志里留一行，否则出站停摆将无从发现。
  const stop =
    `if [ -x '${node}' ] && [ -r '${hookScript}' ]; then '${node}' '${hookScript}'; ` +
    `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1; ` +
    `printf '%s hook-unavailable node=${node}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> '${log}' 2>/dev/null || :; fi` +
    ` # ${HOOK_TAG}stop-hook.mjs`;
  // /init 钩子跑在本机**每一次提交 prompt** 上，比 Stop 更热：缺 node 时它该彻底闭嘴。
  const init =
    `if [ -x '${node}' ] && [ -r '${initScript}' ]; then '${node}' '${initScript}'; ` +
    `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi` +
    ` # ${HOOK_TAG}init-hook.mjs`;
  // 入站钩子：让「任何 Aily 回合先进入运输层」成为硬约束，而不是靠模型记得调技能。
  const inbound =
    `if [ -x '${node}' ] && [ -r '${inboundScript}' ]; then '${node}' '${inboundScript}'; ` +
    `else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi` +
    ` # ${HOOK_TAG}inbound-hook.mjs`;
  return {
    entries: {
      Stop: [["stop-hook.mjs", { hooks: [{ type: "command", command: stop, timeout: 20 }] }]],
      UserPromptSubmit: [
        ["inbound-hook.mjs", { hooks: [{ type: "command", command: inbound, timeout: 10 }] }],
        ["init-hook.mjs", { hooks: [{ type: "command", command: init, timeout: 10 }] }],
      ],
    },
    previewRule: "Bash(" + nodeCommandPrefix(runtimeScript("bind-preview.mjs", home, "claude")) + ":*)",
    scripts: { stop: hookScript, init: initScript, inbound: inboundScript },
  };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const LEGACY_BODY =
  /^if \[ -x '([^']+)' \] && \[ -r '([^']+)' \]; then '([^']+)' '([^']+)'; else \{ command -p cat 2>\/dev\/null \|\| cat; \} >\/dev\/null 2>&1(.*)$/u;
/**
 * 历史遗留命令的严格识别：把安装器**当初生成的完整模板**拆开验 —— guard 检查的 node 与脚本必须和实际执行的逐字相同，
 * 尾部也必须是当初那两种形态之一。任何一处对不上就不是我们的，不碰。
 */
export const legacyOwnsHook = (command, basename) => {
  const m = LEGACY_BODY.exec(command);
  if (!m) return false;
  const [, guardNode, guardScript, runNode, runScript, tail] = m;
  if (guardNode !== runNode || guardScript !== runScript) return false;
  if (!guardScript.endsWith("/scripts/" + basename)) return false;
  if (basename === "stop-hook.mjs") {
    return new RegExp("^; printf '%s hook-unavailable node=" + escapeRe(guardNode) +
      "\\\\n' \"\\$\\(date -u \\+%Y-%m-%dT%H:%M:%SZ\\)\" >> '[^']*' 2>\\/dev\\/null \\|\\| :; fi$", "u")
      .test(tail);
  }
  return /^ \|\| :; fi$/u.test(tail);
};
/** 钩子归属判定：新装认固定的尾部标记，历史遗留按完整模板严格解析（只为迁移那一次）。 */
export const ownsHook = (hook, basename) => {
  const command = hook?.command;
  if (typeof command !== "string") return false;
  if (command.endsWith(" # " + HOOK_TAG + basename)) return true;
  return legacyOwnsHook(command, basename);
};
export const countHooks = (list, basename) => (list ?? [])
  .reduce((n, entry) => n + (entry?.hooks ?? []).filter((h) => ownsHook(h, basename)).length, 0);
/** 收编：摘掉**所有**属于自己的 hook（摘 hook 不摘 entry，整条都是我们的才删 entry），再放回恰好一条。 */
export const claimSingleHook = (list, basename, entry) => {
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const hooks = list[i]?.hooks;
    if (!Array.isArray(hooks)) continue;
    const kept = hooks.filter((h) => !ownsHook(h, basename));
    if (kept.length === hooks.length) continue;
    removed += hooks.length - kept.length;
    if (kept.length === 0) list.splice(i, 1);
    else list[i].hooks = kept;
  }
  if (entry) list.push(entry);
  return removed;
};

/** 预览放行规则的历史形态（裸路径、无引号），只为迁移那一次存在。 */
export const LEGACY_PREVIEW_RULE = /^Bash\(node (\/[^'"\s:]*\/scripts\/bind-preview\.mjs):\*\)$/u;

/**
 * settings.json 的目标全文 —— **纯函数**：输入线上基线文本（缺席传 null），输出合并后的 JSON 文本与每一项的动作。
 * 只动自己的 hook 与预览放行规则，别人的（.orca 等）原样保留、不重排。
 * @returns {{ text: string, settings: object, actions: { stop, inbound, init, perm }, counts: { stop, prompts, allow } }}
 */
export function renderClaudeSettings({ baseText, home = os.homedir(), node = pickClaudeNode(), uninstall = false } = {}) {
  const settings = baseText === null || baseText === undefined ? {} : JSON.parse(baseText);
  settings.hooks ??= {};
  const cmds = claudeHookCommands({ home, node });
  const describe = (before, removed) => uninstall
    ? (removed > 0 ? "removed" : "already-absent")
    : (before === 0 ? "installed" : before === 1 ? "updated" : "deduped");
  const actions = {};
  const stop = (settings.hooks.Stop ??= []);
  for (const [basename, entry] of cmds.entries.Stop) {
    const before = countHooks(stop, basename);
    actions.stop = describe(before, claimSingleHook(stop, basename, uninstall ? null : entry));
  }
  const prompts = (settings.hooks.UserPromptSubmit ??= []);
  for (const [basename, entry] of cmds.entries.UserPromptSubmit) {
    const before = countHooks(prompts, basename);
    actions[basename === "inbound-hook.mjs" ? "inbound" : "init"] = describe(before, claimSingleHook(prompts, basename, uninstall ? null : entry));
  }
  const permissions = (settings.permissions ??= {});
  const allow = (permissions.allow ??= []);
  const ownsPreview = (rule) => typeof rule === "string" && (rule === cmds.previewRule || LEGACY_PREVIEW_RULE.test(rule));
  const permOwned = allow.filter(ownsPreview);
  const permBefore = permOwned.length;
  const permSame = permBefore === 1 && permOwned[0] === cmds.previewRule;
  for (let i = allow.length - 1; i >= 0; i -= 1) if (ownsPreview(allow[i])) allow.splice(i, 1);
  if (!uninstall) allow.push(cmds.previewRule);
  actions.perm = uninstall
    ? (permBefore > 0 ? "removed" : "already-absent")
    : (permBefore === 0 ? "installed" : permSame ? "already-present" : permBefore === 1 ? "updated" : "deduped");
  return { text: JSON.stringify(settings, null, 2) + "\n", settings, actions, counts: { stop: stop.length, prompts: prompts.length, allow: allow.length }, previewRule: cmds.previewRule };
}

/** settings.json 里**桥拥有的封闭条目**（收据对账用）：三条 hook 的 command + 预览放行规则，与别的设置无关。 */
export function claudeSettingsOwnedEntries(text, { home = os.homedir(), node = pickClaudeNode() } = {}) {
  let settings;
  try { settings = JSON.parse(text); } catch { return null; }
  const cmds = claudeHookCommands({ home, node });
  const pick = (list, basename) => (list ?? []).flatMap((e) => (e?.hooks ?? []).filter((h) => ownsHook(h, basename)).map((h) => ({ command: h.command, timeout: h.timeout ?? null, type: h.type ?? null })));
  return {
    Stop: pick(settings?.hooks?.Stop, "stop-hook.mjs"),
    inbound: pick(settings?.hooks?.UserPromptSubmit, "inbound-hook.mjs"),
    init: pick(settings?.hooks?.UserPromptSubmit, "init-hook.mjs"),
    allow: (settings?.permissions?.allow ?? []).filter((r) => typeof r === "string" && (r === cmds.previewRule || LEGACY_PREVIEW_RULE.test(r))),
  };
}

/** Claude 兜底定时器 plist（与 doctor 核 launchd 用的 expectedJob 同源）。 */
export function claudeDrainPlist({ home = os.homedir(), node = pickClaudeNode() } = {}) {
  const job = claudeDrainExpectedJob({ home, node });
  const runtimeBridgeRoot = path.dirname(path.dirname(runtimeScript("stop-hook.mjs", home, "claude")));
  const log = path.join(home, ".claude", "feishu-bridge", "drain.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CLAUDE_DRAIN_LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${job.args.map((a) => "    <string>" + a + "</string>").join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${runtimeBridgeRoot}</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${home}</string>
  </dict>
</dict>
</plist>
`;
}
export const claudeDrainPlistPath = (home = os.homedir()) => path.join(home, "Library", "LaunchAgents", CLAUDE_DRAIN_LAUNCH_LABEL + ".plist");

// ── Linux：systemd --user 的两份单元（PK3-L1）──────────────────────────────────────────────
// 与 plist **同语义**：跑 drain-outbox.mjs --all，30 分钟一次，不对齐日历（OnUnitActiveSec）。
// 只写 ~/.config/systemd/user/ 下我们自己的两个文件；那个目录里别的东西（Omarchy 放的 .wants）不碰。
export const CLAUDE_DRAIN_SYSTEMD_UNIT = "feishu-bridge-cc-drain";
export const claudeDrainSystemdDir = (home = os.homedir()) => path.join(home, ".config", "systemd", "user");
export const claudeDrainSystemdPaths = (home = os.homedir()) => {
  const dir = claudeDrainSystemdDir(home);
  return { dir,
    service: path.join(dir, CLAUDE_DRAIN_SYSTEMD_UNIT + ".service"),
    timer: path.join(dir, CLAUDE_DRAIN_SYSTEMD_UNIT + ".timer") };
};

/** systemd 单元里的一个参数：安全字符原样，其余按 shell 引用（单元文件也会被 systemd 拆词）。 */
const systemdQuote = (arg) => (/^[A-Za-z0-9@%+=:,./_-]+$/u.test(arg) ? arg : JSON.stringify(arg));

/** 两份单元正文（与 doctor 核 systemd 用的 expectedJob 同源）。 */
export function claudeDrainSystemdUnits({ home = os.homedir(), node = pickClaudeNode() } = {}) {
  const job = claudeDrainExpectedJob({ home, node });
  const bridgeRoot = path.dirname(path.dirname(runtimeScript("stop-hook.mjs", home, "claude")));
  const log = path.join(home, ".claude", "feishu-bridge", "drain.log");
  const exec = job.args.map(systemdQuote).join(" ");
  const service = `[Unit]
Description=feishu-bridge 兜底发布（Claude 链，drain --all）
After=default.target

[Service]
Type=oneshot
WorkingDirectory=${bridgeRoot}
ExecStart=${exec}
StandardOutput=append:${log}
StandardError=append:${log}
`;
  const timer = `[Unit]
Description=feishu-bridge 兜底发布定时器（每 30 分钟）

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true
Unit=${CLAUDE_DRAIN_SYSTEMD_UNIT}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

// ── 「现有安装里那个 node」的读取（PK3-L1-fix2 P1-1）──────────────────────────────────────
// 生产入口（安装器 / doctor）原先裸调 pickClaudeNode()：`installed` 这条分支只有纯函数测试走过。
// 下面三个函数是**唯一一份**接线，装在 install-projection 里是因为归属判定（ownsHook）与定时器路径都在这儿。

const readTextOrNull = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };

/**
 * settings.json 里**我们自己的** hook 命令文本（`installedNodeFrom` 的来源②）。纯函数。
 * 只收三条桥 hook（Stop / UserPromptSubmit 两条）：别的工具的命令就算恰好含 `[ -x '…' ]` 也不是我们的。
 */
function bridgeHookCommands(text) {
  let settings = null;
  try { settings = JSON.parse(text); } catch { return []; }
  const names = ["stop-hook.mjs", "inbound-hook.mjs", "init-hook.mjs"];
  const out = [];
  for (const list of [settings?.hooks?.Stop, settings?.hooks?.UserPromptSubmit]) {
    for (const entry of list ?? []) {
      for (const hook of entry?.hooks ?? []) {
        if (typeof hook?.command !== "string") continue;
        if (names.some((n) => ownsHook(hook, n))) out.push(hook.command);
      }
    }
  }
  return out;
}

/**
 * 现有兜底定时器文件的正文（`installedNodeFrom` 的来源③）：按平台读该位置，缺席跳过。
 * read 可注入（与 drainTimerPlan 同一口径）—— 这条路径要能在测试里不碰真机文件。
 */
function existingTimerTexts({ home = os.homedir(), platform = process.platform, read = readTextOrNull } = {}) {
  const files = timerKindFor(platform) === "launchd" ? [claudeDrainPlistPath(home)]
    : timerKindFor(platform) === "systemd" ? [claudeDrainSystemdPaths(home).service, claudeDrainSystemdPaths(home).timer]
      : [];
  return files.map((f) => read(f)).filter((t) => typeof t === "string" && t.length > 0);
}

/**
 * 生产入口的**唯一一份**接线：把「现有安装里那个 node」读出来（安装收据 + settings.json 的桥 hook
 * + 现有 plist / unit），交给纯函数 `installedNodeFrom` 定优先级。
 * 收据由调用方读进来（install-projection 不 import installed-surface：那边 import 这里的 ownsHook，
 * 反过来会成环）。拿不到 → null，调用方照旧走常规顺序。
 */
export function installedClaudeNode({ home = os.homedir(), platform = process.platform, receipt = null, read = readTextOrNull } = {}) {
  return installedNodeFrom({
    receipt,
    settingsHooks: bridgeHookCommands(read(path.join(home, ".claude", "settings.json"))),
    timerExec: existingTimerTexts({ home, platform, read }),
  });
}

/** 「这个单元本来就没有」的 systemctl 说法 —— **安装侧卸载与 doctor 的 not-installed 判据共用这一份**
 * （各写一份就会漂：同一个错误串在两处得到不同结论，这仓库栽过）。只在「本来就没有」这一侧共用；
 * 「查不清」那一侧不许宽。
 * **不把 `No such file` 当判据**：连不上 manager 那句正是 `Failed to connect to bus: No such file or directory` ——
 * 它会被缩成"没装"，而那正是"查不清"要拦的（is-enabled 对缺失单元说的是
 * `Failed to get unit file state …`，那条已在下面）。 */
export const systemdUnitAbsent = (text) =>
  /(unit file .* does not exist|unit .* not loaded|could not be found|not-found|not found|failed to get unit file state)/iu.test(String(text ?? ""));

/** 单元里 ExecStart 那一行的值：与 `claudeDrainSystemdUnits` 同源（引用规则只写一处）。 */
export const systemdExecStartValue = (args) => args.map(systemdQuote).join(" ");

/**
 * `systemctl --user show <service> -p ExecStart --value` 里的 argv[] 原文（trim 过）。
 * 没有 argv[]（旧版 / 空定义）→ 退回 path=（只核 node，核不了后面的参数）。
 */
export function systemdShowExecArgv(text) {
  const s = String(text ?? "");
  const argv = /argv\[\]=([^;]*);?/u.exec(s);
  if (argv !== null) return argv[1].trim();
  const pathOnly = /(?:^|[{;\s])path=([^;]*);?/u.exec(s);
  return pathOnly === null ? null : pathOnly[1].trim();
}

/** 出站安装器装的 8 个技能：仓库源目录名 → ~/.claude/skills 目录名。 */
/**
 * 兜底定时器的**安装计划**（PK3-L1）：纯函数，平台可注入。安装器照它执行、测试照它断言。
 *
 *   darwin → launchd：写 LaunchAgent plist，`launchctl bootout/bootstrap`
 *   linux  → systemd --user：写 .service + .timer，`systemctl --user daemon-reload` + `enable --now <timer>`
 *   其它   → kind:null、unsupported：**明说本平台没有实现，未装**（不假装装好，安装继续）
 *
 * 卸载（uninstall:true）也走同一份计划，linux 是三步：`disable --now` → 删两份 unit → `daemon-reload`
 * （`commands` 在删之前、`commandsAfterRemove` 在删之后）。
 *
 * `read` 注入的是「现在盘上是什么」（返回 null = 文件不在）：只用来判 will-install / will-update / unchanged。
 */
export function drainTimerPlan({ home = os.homedir(), node = pickClaudeNode(), platform = process.platform,
  read = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
  uninstall = false } = {}) {
  const kind = timerKindFor(platform);
  if (kind === null) {
    return { kind: null, action: "unsupported", files: [], remove: [], commands: [], commandsAfterRemove: [],
      note: "本平台（" + platform + "）没有兜底定时器实现，"
        + (uninstall ? "没有东西可卸" : "未装 —— 事件驱动的发布照常，只是没有 30 分钟兜底重试") };
  }
  const actionOf = (path, text) => {
    const current = read(path);
    return current === null ? "will-install" : (current === text ? "unchanged" : "will-update");
  };
  if (kind === "launchd") {
    const path = claudeDrainPlistPath(home);
    const text = claudeDrainPlist({ home, node });
    if (uninstall) {
      return { kind, action: "will-remove", files: [], remove: [path],
        commands: [["launchctl", "bootout", "gui/<uid>/" + CLAUDE_DRAIN_LAUNCH_LABEL]], commandsAfterRemove: [], note: null };
    }
    return { kind, action: actionOf(path, text), files: [{ path, text }], remove: [],
      commands: [["launchctl", "bootout", "gui/<uid>/" + CLAUDE_DRAIN_LAUNCH_LABEL], ["launchctl", "bootstrap", "gui/<uid>", path]],
      commandsAfterRemove: [],
      note: null };
  }
  // linux / systemd --user（PK3-L1-fix1 P1-2：卸载也走同一份计划 —— 否则安装能写、卸载只删 plist，
  // 单元与已启用的 timer 会继续跑）
  const paths = claudeDrainSystemdPaths(home);
  const units = claudeDrainSystemdUnits({ home, node });
  if (uninstall) {
    // 顺序（PK3-L1-fix2 P1-2）：先 disable --now（把 timer 停下、禁掉）→ 再删两份 unit → **最后**
    // daemon-reload。旧版把 daemon-reload 排在删除之前：manager 里记住的还是删掉之前那份，删除本身
    // 也要等下一次 reload 才生效。`commandsAfterRemove` 就是为这一步存在的（删文件在两步之间）。
    return { kind, action: "will-remove", files: [], remove: [paths.service, paths.timer],
      commands: [["systemctl", "--user", "disable", "--now", CLAUDE_DRAIN_SYSTEMD_UNIT + ".timer"]],
      commandsAfterRemove: [["systemctl", "--user", "daemon-reload"]],
      note: null };
  }
  const serviceAction = actionOf(paths.service, units.service);
  const timerAction = actionOf(paths.timer, units.timer);
  const action = serviceAction === "unchanged" && timerAction === "unchanged" ? "unchanged"
    : (serviceAction === "will-update" || timerAction === "will-update") ? "will-update" : "will-install";
  return { kind, action, files: [{ path: paths.service, text: units.service }, { path: paths.timer, text: units.timer }],
    remove: [], commandsAfterRemove: [],
    commands: [["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", CLAUDE_DRAIN_SYSTEMD_UNIT + ".timer"]],
    // 没登录也想让定时器跑，需要 linger —— 那条要 sudo，安装器只打印提示，不执行。
    note: "若这台机器不常驻登录会话，兜底要生效还需 `loginctl enable-linger " + "<你的用户>" + "`（要 sudo，交 Frank 决定）" };
}

export const CLAUDE_SKILLS = Object.freeze([
  { src: "claude-longtask-progress", dst: "claude-longtask-progress" },
  { src: "claude-feishu-bind",       dst: "feishu-bind" },
  { src: "claude-feishu-status",     dst: "feishu-status" },
  { src: "claude-feishu-unbind",     dst: "feishu-unbind" },
  { src: "claude-feishu-rotate",     dst: "feishu-rotate" },
  { src: "claude-feishu-mode",       dst: "feishu-mode" },
  { src: "claude-feishu-subscribe",  dst: "feishu-subscribe" },
  { src: "claude-feishu-pin-session", dst: "feishu-pin-session" },
]);
/** 入站安装器装的运输 agent 技能。 */
export const CLAUDE_INBOUND_SKILL = Object.freeze({ name: "m5claude-inbound-router", files: ["SKILL.md", "aily-cli-skill.json"] });

/** 技能正文渲染：`{{SCRIPT:x.mjs}}` → 加了 shell 引号的 runtime/current 路径（引用是渲染器的职责，不是模板作者的记性）。 */
export function renderClaudeSkill(text, { home = os.homedir() } = {}) {
  const runtimeBridgeRoot = path.dirname(path.dirname(runtimeScript("stop-hook.mjs", home, "claude")));
  return text.replaceAll(/\{\{SCRIPT:([A-Za-z0-9_./-]+)\}\}/gu, (_, name) => shellQuote(path.join(runtimeBridgeRoot, "scripts", name)));
}
/** 8 个技能 + 入站技能的目标文件：[{ path, text, src }]；源文件缺席 → { path, missing: true }。 */
export function claudeSkillFiles({ repoRoot, home = os.homedir(), skillsRoot = path.join(home, ".claude", "skills") } = {}) {
  const out = [];
  for (const sk of CLAUDE_SKILLS) {
    const src = path.join(repoRoot, "skills", sk.src, "SKILL.md");
    const dst = path.join(skillsRoot, sk.dst, "SKILL.md");
    let raw = null;
    try { raw = fs.readFileSync(src, "utf-8"); } catch { /* 缺席 */ }
    out.push(raw === null ? { path: dst, src, missing: true, skill: sk.dst } : { path: dst, src, text: renderClaudeSkill(raw, { home }), skill: sk.dst });
  }
  for (const f of CLAUDE_INBOUND_SKILL.files) {
    const src = path.join(repoRoot, "skills", CLAUDE_INBOUND_SKILL.name, f);
    const dst = path.join(skillsRoot, CLAUDE_INBOUND_SKILL.name, f);
    let raw = null;
    try { raw = fs.readFileSync(src, "utf-8"); } catch { /* 缺席 */ }
    out.push(raw === null ? { path: dst, src, missing: true, skill: CLAUDE_INBOUND_SKILL.name } : { path: dst, src, text: f === "SKILL.md" ? renderClaudeSkill(raw, { home }) : raw, skill: CLAUDE_INBOUND_SKILL.name });
  }
  return out;
}

/** 从渲染后的制品文本里抽出引用到的 runtime/current 脚本名（桩清单 / 预检用）。 */
export function referencedRuntimeScripts(text) {
  const names = new Set();
  for (const m of String(text ?? "").matchAll(/runtime\/current\/scripts\/((?:codex\/)?[A-Za-z0-9_.-]+\.mjs)/gu)) names.add(m[1]);
  return [...names].sort();
}
