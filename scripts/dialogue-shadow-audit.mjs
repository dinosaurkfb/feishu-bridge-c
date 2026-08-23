#!/usr/bin/env node
/** 只读检查 Dialogue shadow sidecar；stdout 从不包含输入目录、文件名或 opaque ref。 */

import {
  analyzeDialogueShadowEvidence, readDialogueShadowEvidence,
  renderDialogueShadowReadinessReport,
} from "./dialogue-shadow-readiness.mjs";

const args = process.argv.slice(2);
const dirs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--shadow-dir" && typeof args[i + 1] === "string") {
    dirs.push(args[i + 1]);
    i += 1;
  }
}
if (dirs.length === 0) {
  process.stderr.write("用法：node scripts/dialogue-shadow-audit.mjs --shadow-dir <absolute-path> [--json]\n");
  process.exit(2);
}
const loaded = readDialogueShadowEvidence({ shadowDirs: dirs });
if (!loaded.ok) {
  process.stderr.write("Dialogue shadow 输入无效。\n");
  process.exit(2);
}
const analyzed = analyzeDialogueShadowEvidence({
  sourceCount: loaded.evidence.source_count,
  missingSourceDirs: loaded.evidence.missing_source_dirs,
  readErrors: loaded.evidence.read_errors,
  authorizations: loaded.evidence.authorizations,
  events: loaded.evidence.events,
  probes: loaded.evidence.probes,
});
if (!analyzed.ok) {
  process.stderr.write("Dialogue shadow 报告生成失败。\n");
  process.exit(1);
}
process.stdout.write((args.includes("--json")
  ? JSON.stringify(analyzed.report, null, 2)
  : renderDialogueShadowReadinessReport(analyzed.report)) + "\n");
