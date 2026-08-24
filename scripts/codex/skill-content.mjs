/**
 * Codex 技能的**清单与期望内容 —— 只有这一份**。
 *
 * 之前清单在安装器和 doctor 各写一份，渲染只在安装器里，doctor 只查文件存在。
 * 评审实测：安装之后把 feishu-status/SKILL.md 换成陈旧内容，
 * doctor 仍报 `{"name":"Codex skills","ok":true,"detail":"7 项均已安装"}`。
 * **"文件在"不等于"装对了"** —— runtime 换了、路径改了，旧内容照样"存在"。
 */

import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "../shell-quote.mjs";

export const SKILLS = [
  { name: "m5codex-inbound-router", files: ["SKILL.md", "aily-cli-skill.json"] },
  { name: "codex-longtask-feishu", files: ["SKILL.md"] },
  { name: "feishu-bind", files: ["SKILL.md"] },
  { name: "feishu-unbind", files: ["SKILL.md"] },
  { name: "feishu-status", files: ["SKILL.md"] },
  { name: "feishu-rotate", files: ["SKILL.md"] },
  { name: "feishu-mode", files: ["SKILL.md"] },
];

export const SKILL_NAMES = SKILLS.map((s) => s.name);

/**
 * 一个技能文件**应该**是什么内容。
 *
 * {{SCRIPT:x.mjs}} 由渲染器负责加 shell 引号 —— 引用是渲染器的职责，
 * 不是模板作者的记性。模板里原来写的是 node "{{BRIDGE_ROOT}}/scripts/…"，
 * 双引号挡得住空格但挡不住 `$`、反引号和反斜杠；单引号才是 POSIX 里唯一完全字面的。
 */
export function expectedSkillContent({ sourceFile, name, runtimeCurrent, bridgeHome }) {
  const raw = fs.readFileSync(sourceFile);
  if (name !== "SKILL.md") return raw;                       // 非模板文件原样拷
  return Buffer.from(raw.toString("utf-8")
    .replaceAll(/\{\{SCRIPT:([A-Za-z0-9_./-]+)\}\}/gu,
      (_, script) => shellQuote(path.join(runtimeCurrent, "scripts", script)))
    .replaceAll("{{BRIDGE_ROOT}}", runtimeCurrent)
    .replaceAll("{{CODEX_BRIDGE_HOME_SHELL}}", shellQuote(bridgeHome)), "utf-8");
}

/**
 * 装出来的东西跟期望**逐字节**一致吗。
 *
 * 返回每一项的差异原因，不是一个布尔 —— "哪一个技能的哪一个文件不对"
 * 才是能拿去修的信息。
 */
export function auditSkills({ repoRoot, codexHome, runtimeCurrent, bridgeHome }) {
  const problems = [];
  for (const skill of SKILLS) {
    for (const file of skill.files) {
      const installed = path.join(codexHome, "skills", skill.name, file);
      let actual;
      try { actual = fs.readFileSync(installed); }
      catch { problems.push({ skill: skill.name, file, why: "缺失" }); continue; }
      let want;
      try {
        want = expectedSkillContent({
          sourceFile: path.join(repoRoot, "skills", skill.name, file),
          name: file, runtimeCurrent, bridgeHome,
        });
      } catch {
        // 源文件读不出来 → 说不清期望是什么，**不能当成通过**。
        problems.push({ skill: skill.name, file, why: "源模板读不出来，无法判断" });
        continue;
      }
      if (!actual.equals(want)) problems.push({ skill: skill.name, file, why: "内容与期望不符" });
    }
  }
  return { ok: problems.length === 0, problems };
}
