/**
 * 维护门的**入口清单**（issue #81 PR B，方案稿"桩清单"）—— 只有这一份，安装器 / 桩生成器 / 预检 / 测试都从这里取。
 *
 * 清单 = 登记的启动源与技能引用到的全部 runtime/current 脚本（从三个安装器的**投影**里解析，不手抄）
 * 放在 scripts/maintenance/：机器级维护工具本来就跨两条链（与 doctor 起 Codex 子进程同理），不算 Claude 运行时依赖 codex。
 *      ∪ 固定 worker（入站当场起的、定时器起的）∪ 状态入口（status / doctor 两链）。
 * 测试对照：沙箱里跑三个安装器 → 产出的 settings / hooks.json / skills / plist 引用的每个脚本 ⊆ 清单；清单每项在源码树里存在。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeDrainPlist, claudeHookCommands, claudeSkillFiles, referencedRuntimeScripts } from "../install-projection.mjs";
import { pickClaudeNode } from "../drain-schedule.mjs";
import { renderCodexHooks, pickNode } from "../codex/hook-command.mjs";
import { SKILLS as CODEX_SKILLS, expectedSkillContent } from "../codex/skill-content.mjs";
import { plistBody as codexDrainPlist } from "../codex/drain-service.mjs";
import { codexRuntimeRoot } from "../runtime-install.mjs";

/** 入站当场起的 worker 与定时器起的 worker：不从任何配置里引用，得钉死。 */
export const FIXED_WORKERS = Object.freeze([
  "watch-and-publish.mjs", "outbound.mjs", "drain-outbox.mjs", "aily-inbound.mjs", "inbound-dispatcher.mjs", "inbound.mjs",
  "codex/drain-all.mjs", "codex/watch-run.mjs", "codex/run-resume.mjs", "codex/drain-outbox.mjs", "codex/drain-service.mjs", "codex/aily-inbound.mjs", "codex/inbound.mjs",
]);
/** 状态入口：桩里要有，才能在窗口内说"维护中"而不是报运行时坏了。 */
export const STATUS_ENTRIES = Object.freeze(["feishu-status.mjs", "doctor.mjs", "codex/feishu-status.mjs", "codex/doctor.mjs"]);

/**
 * @returns {{ entries: string[], sources: Record<string, string[]>, missing: string[] }}
 *   entries = 去重排序的 `scripts/` 相对名；sources = 每一项由谁引用；missing = 清单里但源码树里没有的（测试盯它为空）。
 */
export function maintenanceEntryManifest({ repoRoot, home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, ".codex"), bridgeHome = path.join(codexHome, "feishu-bridge") } = {}) {
  const sources = {};
  const add = (name, by) => { (sources[name] ??= []).push(by); };
  // Claude：三条 hook、预览放行、8 + 1 个技能、兜底 plist
  const claudeNode = pickClaudeNode();
  const cmds = claudeHookCommands({ home, node: claudeNode });
  for (const [, entries] of Object.entries(cmds.entries)) for (const [, entry] of entries) for (const n of referencedRuntimeScripts(entry.hooks[0].command)) add(n, "claude-hook");
  for (const n of referencedRuntimeScripts(cmds.previewRule)) add(n, "claude-permission");
  for (const f of claudeSkillFiles({ repoRoot, home })) if (!f.missing) for (const n of referencedRuntimeScripts(f.text)) add(n, "claude-skill:" + f.skill);
  for (const n of referencedRuntimeScripts(claudeDrainPlist({ home, node: claudeNode }))) add(n, "claude-launchd");
  // Codex：两条 hook、8 个技能、兜底 plist
  const codexNode = pickNode();
  const runtimeCurrent = path.join(codexRuntimeRoot(codexHome), "current");
  const hooks = renderCodexHooks({ baseText: null, promptScript: path.join(runtimeCurrent, "scripts", "codex", "prompt-hook.mjs"), stopScript: path.join(runtimeCurrent, "scripts", "codex", "stop-hook.mjs"), node: codexNode, home: bridgeHome, log: path.join(bridgeHome, "hook.log") });
  for (const n of referencedRuntimeScripts(hooks.text)) add(n, "codex-hook");
  for (const sk of CODEX_SKILLS) for (const file of sk.files) {
    const src = path.join(repoRoot, "skills", sk.name, file);
    if (!fs.existsSync(src)) continue;
    for (const n of referencedRuntimeScripts(expectedSkillContent({ sourceFile: src, name: file, runtimeCurrent, bridgeHome }).toString("utf-8"))) add(n, "codex-skill:" + sk.name);
  }
  for (const n of referencedRuntimeScripts(codexDrainPlist({ home, node: codexNode, codexHome }))) add(n, "codex-launchd");
  for (const n of FIXED_WORKERS) add(n, "fixed-worker");
  for (const n of STATUS_ENTRIES) add(n, "status-entry");
  const entries = Object.keys(sources).sort();
  const missing = entries.filter((n) => !fs.existsSync(path.join(repoRoot, "scripts", n)));
  return { entries, sources, missing };
}
