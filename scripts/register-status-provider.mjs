#!/usr/bin/env node
/**
 * 登记一个状态提供者。默认只预览，`--apply` 才写。
 *
 * 为什么要有它：状态入口是**一次独立授权** —— 它会在 Frank 的交互会话里执行
 * 一个命令。没有受控入口，接入方只能手改 JSON，而那正是 #32 已经解决过一遍的
 * 问题：无锁的读改写会丢更新、非原子写会截断整张表、重建文档会丢未知字段。
 * 同一个坑不该因为换了个文件就再踩一次。
 *
 * 用法：
 *   node scripts/register-status-provider.mjs --id cc2cd \
 *     --script /abs/provider.mjs --kinds transport -- --binding /abs/binding.json
 *   ...同上 --apply
 *
 * `--` 之后的都是传给 provider 的参数，原样存下，执行时逐项传递、不做展开。
 */

import fs from "node:fs";
import path from "node:path";

import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { isDirectRun } from "./direct-run.mjs";
import {
  PROVIDER_KINDS, PROVIDER_PROTOCOL, statusProvidersPath, validateProviderRegistry,
} from "./status-providers.mjs";

const REASON_TEXT = {
  provider_id_invalid: "--id 只能是小写字母数字、下划线和连字符，且以字母数字开头",
  executable_not_absolute: "--executable 必须是绝对路径",
  script_not_absolute: "--script 必须是绝对路径",
  allowed_kinds_invalid: "--kinds 只能是 " + PROVIDER_KINDS.join(" / "),
  provider_id_duplicated: "登记表里已经有同名 provider",
  provider_exists_with_other_script: "这个 id 已经指向别的脚本",
  status_providers_unreadable: "登记表读不出来 —— 先修表，别覆盖它",
  status_providers_shape_unexpected: "登记表结构异常 —— 先修表，别覆盖它",
  providers_busy: "登记表正被别的进程写，稍后重试",
  script_missing: "provider 脚本不存在",
  script_not_a_file: "--script 不是普通文件",
};

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(reason, detail) {
  console.error("失败（" + reason + "）：" + (REASON_TEXT[reason] ?? reason) +
    (detail ? "：" + detail : ""));
  process.exit(1);
}

/** `--` 之后的一切都是 provider 的参数。分隔符本身不进去。 */
function passthroughArgs() {
  const at = process.argv.indexOf("--", 2);
  return at >= 0 ? process.argv.slice(at + 1) : [];
}

function readDoc(file) {
  try { return { ok: true, doc: JSON.parse(fs.readFileSync(file, "utf-8")) }; }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, doc: null };
    return { ok: false, reason: "status_providers_unreadable" };
  }
}

/** 原子写。写到一半被打断会让整张表截断。 */
function writeDoc(doc, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function main() {
  const apply = process.argv.includes("--apply");
  const id = arg("id");
  const script = arg("script");
  const executable = arg("executable") ?? process.execPath;
  const kinds = (arg("kinds") ?? "transport").split(",").map((k) => k.trim()).filter(Boolean);
  const displayName = arg("display-name");
  const file = statusProvidersPath();

  if (!id || !script) {
    console.error("用法：node scripts/register-status-provider.mjs --id <id> --script <绝对路径> " +
      "[--executable <绝对路径>] [--kinds transport,progress] [--display-name <名字>] " +
      "[--apply] [-- <传给 provider 的参数...>]");
    process.exit(2);
  }

  const entry = {
    id, protocol: PROVIDER_PROTOCOL, executable, script,
    args: passthroughArgs(), allowed_kinds: kinds,
    ...(displayName ? { display_name: displayName } : {}),
  };

  // 先用真正的校验器过一遍：登记命令和读取路径必须共用同一套规则，
  // 否则会出现"登记时说合法、读取时又说不合法"。
  const shaped = validateProviderRegistry({ providers: [entry] });
  if (!shaped.ok) fail(shaped.problem);
  if (!fs.existsSync(script)) fail("script_missing", script);
  if (!fs.statSync(script).isFile()) fail("script_not_a_file", script);

  console.log("登记表    " + file);
  console.log("provider  " + id + " → " + script);
  console.log("执行      " + executable);
  console.log("参数      " + (entry.args.length > 0 ? entry.args.join(" ") : "（无）"));
  console.log("授权范围  " + kinds.join(", "));
  console.log("\n提醒：状态入口会在你的交互会话里执行上面这个命令。");
  console.log("      它拿不到 AILY_CLI_* 和凭据（环境白名单只放 PATH/HOME/LANG/TZ），");
  console.log("      但它仍然是一次代码执行 —— 确认这个脚本是你信任的。");

  if (!apply) {
    console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockDir = file + ".lock";
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) fail("providers_busy");
  try {
    // 取锁之后重读：锁外读到的那份跟要写的那份不是同一个快照。
    const read = readDoc(file);
    if (!read.ok) fail(read.reason);
    const doc = read.doc ?? { schema_version: "1.0", providers: [] };
    if (!Array.isArray(doc.providers)) fail("status_providers_shape_unexpected");

    const existing = doc.providers.find((p) => p && p.id === id);
    if (existing) {
      // 同 id 换脚本 = 悄悄改判由谁来报这条链路的状态。跟路由表那条同理。
      if (existing.script !== script) fail("provider_exists_with_other_script", existing.script);
      console.log("\n已登记，无变化。");
      return;
    }
    // 只往 providers 里加一项，不重建文档 —— 未知顶层字段原样保留。
    doc.providers.push(entry);
    const valid = validateProviderRegistry(doc);
    if (!valid.ok) fail(valid.problem);
    writeDoc(doc, file);
    console.log("\n已登记。");
  } finally {
    releasePublishLock(lockDir);
  }
}

if (isDirectRun(import.meta.url)) main();
