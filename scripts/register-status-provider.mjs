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
  provider_exists_with_other_settings: "这个 id 已登记，但以下字段不同；改登记要显式先注销",
  status_providers_unreadable: "登记表读不出来 —— 先修表，别覆盖它",
  status_providers_shape_unexpected: "登记表结构异常 —— 先修表，别覆盖它",
  providers_busy: "登记表正被别的进程写，稍后重试",
  script_missing: "provider 脚本不存在",
  script_not_a_file: "--script 不是普通文件",
};

/**
 * 先按 `--` 切开，**控制参数只从前半段读**。
 *
 * 原来 arg() 和 --apply 都在整个 argv 里搜，于是
 * `... -- --apply` 会真的落盘 —— 一个透传给 provider 的参数，
 * 越过了这个命令唯一的授权闸门。控制面和数据面混在一个数组里就会这样。
 */
const SPLIT_AT = process.argv.indexOf("--", 2);
const CONTROL = SPLIT_AT >= 0 ? process.argv.slice(2, SPLIT_AT) : process.argv.slice(2);
const PASSTHROUGH = SPLIT_AT >= 0 ? process.argv.slice(SPLIT_AT + 1) : [];

function arg(name) {
  const i = CONTROL.indexOf("--" + name);
  return i >= 0 ? CONTROL[i + 1] : undefined;
}

function fail(reason, detail) {
  console.error("失败（" + reason + "）：" + (REASON_TEXT[reason] ?? reason) +
    (detail ? "：" + detail : ""));
  process.exit(1);
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

/** 比较用的规范形。字段顺序不该影响"是不是同一条登记"。 */
function normalize(entry) {
  return {
    id: entry.id, protocol: entry.protocol,
    executable: entry.executable, script: entry.script,
    args: [...(entry.args ?? [])],
    allowed_kinds: [...(entry.allowed_kinds ?? [])].sort(),
    display_name: entry.display_name ?? null,
  };
}

/** 说清是哪几处不同 —— 只报字段名，不回显值（值里可能有路径和参数）。 */
function diff(a, b) {
  const x = normalize(a); const y = normalize(b);
  return Object.keys(x)
    .filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
    .join("、");
}

function main() {
  const apply = CONTROL.includes("--apply");
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
    args: PASSTHROUGH, allowed_kinds: kinds,
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

    // 先验**整表**再谈幂等：否则一张结构损坏、但恰好 id/script 相同的表
    // 会提前"成功"返回，而随后 loadStatusProviders 照样判它损坏 ——
    // 登记说成了，读取说没有，那是最难查的一类不一致。
    const whole = validateProviderRegistry(doc);
    if (!whole.ok) fail(whole.problem);

    const existing = doc.providers.find((x) => x && x.id === id);
    if (existing) {
      // 只比 script 会虚假宣称"无变化"：args、allowed_kinds、executable、
      // display_name 改了也照样报成功，而文件里还是旧值。
      const same = JSON.stringify(normalize(existing)) === JSON.stringify(normalize(entry));
      if (same) {
        console.log("\n已登记，无变化。");
        return;
      }
      if (existing.script !== script) fail("provider_exists_with_other_script", existing.script);
      fail("provider_exists_with_other_settings", diff(existing, entry));
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
