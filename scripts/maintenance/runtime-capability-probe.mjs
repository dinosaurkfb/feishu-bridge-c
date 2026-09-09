#!/usr/bin/env node
/**
 * 过渡 runtime 能力探针（P1-3）：核已装 runtime（`versions/<v>/`）里的 journal.mjs / topic-agent-ledger.mjs
 * 是否支持 owner_select 过渡（journal 1.4 + 账本 schema 含 1.1-transition/1.1）。
 *
 * 只 import argv[2] 指向的已装版本目录内的模块（绝不 import 仓库工作树）。stdout 恰打一行 JSON：
 * `{ ok, journal_schema: OWNER_SELECT_JOURNAL_SCHEMA, ledger_schema_versions: SCHEMA_VERSIONS }`。
 * 加载异常 → 非零退出 + stderr（调用方 fail-closed）。模块缺对应导出（旧版）→ 值取 null/[]，由调用方判不符。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const versionDir = process.argv[2];
  if (typeof versionDir !== "string" || versionDir.length === 0) throw new Error("探针缺参数：<已装版本目录>");
  const j = await import(pathToFileURL(path.join(versionDir, "scripts", "maintenance", "journal.mjs")).href);
  const m = await import(pathToFileURL(path.join(versionDir, "scripts", "topic-agent-ledger.mjs")).href);
  const sv = Array.isArray(m.SCHEMA_VERSIONS) ? m.SCHEMA_VERSIONS : [];
  process.stdout.write(JSON.stringify({
    ok: true,
    journal_schema: typeof j.OWNER_SELECT_JOURNAL_SCHEMA === "string" ? j.OWNER_SELECT_JOURNAL_SCHEMA : null,
    ledger_schema_versions: sv,
  }) + "\n");
}

main().catch((e) => { process.stderr.write(String(e?.message ?? e)); process.exit(1); });
