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
  provider_exists_with_other_settings: "这个 id 已登记，但以下字段不同",
  ambiguous_mode: "--replace 和 --unregister 不能同时给；请分别执行",
  unknown_option: "不认识这个参数（拼错了？）",
  unexpected_argument: "只接受 --xxx 形式的参数",
  duplicate_option: "同一个参数给了两次",
  option_needs_value: "这个参数缺少取值",
  unregister_takes_no_config: "注销模式下这些参数无效，去掉它们再执行",
  unregister_takes_no_args: "注销模式下不接受 -- 之后的透传参数",
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

/**
 * 严格解析控制段。**白名单，不是黑名单。**
 *
 * 上一版只拒绝四个已知配置项，于是 `--unknown-option x` 和拼错的 `--kindz`
 * 都被静默忽略 —— 注销照样执行，新增照样用默认值登记。
 * "只接受这几个"和"拒绝这几个"差一个拼写错误，而破坏性操作那边差的是整个登记表。
 */
const FLAGS = new Set(["apply", "replace", "unregister"]);
const OPTIONS = new Set(["id", "script", "executable", "kinds", "display-name"]);

function parseControl(tokens) {
  const seen = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (typeof t !== "string" || !t.startsWith("--")) {
      return { ok: false, reason: "unexpected_argument" };
    }
    const name = t.slice(2);
    if (seen.has(name)) return { ok: false, reason: "duplicate_option", detail: t };
    if (FLAGS.has(name)) { seen.set(name, true); continue; }
    if (!OPTIONS.has(name)) return { ok: false, reason: "unknown_option", detail: t };
    const value = tokens[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      return { ok: false, reason: "option_needs_value", detail: t };
    }
    seen.set(name, value);
    i += 1;
  }
  return { ok: true, seen };
}

const parsed = parseControl(CONTROL);
if (!parsed.ok) {
  console.error("失败（" + parsed.reason + "）：" +
    (REASON_TEXT[parsed.reason] ?? parsed.reason) + (parsed.detail ? "：" + parsed.detail : ""));
  process.exit(1);
}

function arg(name) {
  const v = parsed.seen.get(name);
  return typeof v === "string" ? v : undefined;
}
function has(name) { return parsed.seen.has(name); }

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

/**
 * 比较用的规范形。字段顺序不该影响"是不是同一条登记"，
 * 而**语义默认值也要算进来** —— enabled 缺省是 true，漏掉它就会出现
 * "重登记一条已停用的项，报无变化，而它仍然停用"。
 */
function normalize(entry) {
  return {
    id: entry.id, protocol: entry.protocol,
    executable: entry.executable, script: entry.script,
    args: [...(entry.args ?? [])],
    allowed_kinds: [...(entry.allowed_kinds ?? [])].sort(),
    display_name: entry.display_name ?? null,
    enabled: entry.enabled !== false,
  };
}

/** 哪几处不同 —— 只报字段名，不回显值（值里有路径和参数）。 */
function differingFields(a, b) {
  const x = normalize(a); const y = normalize(b);
  return Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
}

/**
 * 算出这次登记会发生什么。**预览和落盘共用它。**
 *
 * 上一版预览在读登记表**之前**就返回了，于是"登记表损坏""配置冲突"都要等到
 * --apply 才暴露 —— 一个不读真实状态的预览，报的"没问题"不是从状态得出的，
 * 那就不是预览，是安慰。
 */
export function planRegistration({ file, entry, mode = "add", readFile = readDoc }) {
  const read = readFile(file);
  if (!read.ok) return { action: "registry_unreadable", reason: read.reason };
  const doc = read.doc ?? { schema_version: "1.0", providers: [] };
  if (!Array.isArray(doc.providers)) {
    return { action: "registry_invalid", reason: "status_providers_shape_unexpected" };
  }
  const whole = validateProviderRegistry(doc);
  if (!whole.ok) return { action: "registry_invalid", reason: whole.problem };

  const at = doc.providers.findIndex((x) => x && x.id === entry.id);
  const existing = at >= 0 ? doc.providers[at] : null;

  if (mode === "unregister") {
    return existing ? { action: "remove", doc, at } : { action: "absent", doc };
  }
  if (!existing) {
    return mode === "replace" ? { action: "absent", doc } : { action: "add", doc };
  }
  const fields = differingFields(existing, entry);
  if (fields.length === 0) return { action: "unchanged", doc };
  if (mode === "replace") return { action: "replace", doc, at, fields };
  // 换脚本单独给个理由：那是**别人的脚本来报这条链路的状态**，
  // 比"参数变了"严重得多，不该并进通用冲突里一笔带过。
  return {
    action: "conflict", doc, at, fields,
    reason: fields.includes("script")
      ? "provider_exists_with_other_script"
      : "provider_exists_with_other_settings",
  };
}

const PLAN_TEXT = {
  add: "将新增这条登记",
  unchanged: "已存在且完全相同，不会改动",
  replace: "将替换已有登记，变化字段：",
  conflict: "已存在同 id 且配置不同，变化字段：",
  remove: "将注销这条登记",
  absent: "登记表里没有这个 id",
  registry_unreadable: "登记表读不出来 —— 先修表，别覆盖它",
  registry_invalid: "登记表结构异常 —— 先修表，别覆盖它",
};

function describePlan(plan) {
  const base = PLAN_TEXT[plan.action] ?? plan.action;
  if (plan.action === "replace" || plan.action === "conflict") return base + plan.fields.join("、");
  if (plan.action === "registry_unreadable" || plan.action === "registry_invalid") {
    return base + "（" + plan.reason + "）";
  }
  return base;
}

/** 预览也要如实反映失败：报"没问题"却在 --apply 时才炸，等于预览撒谎。 */
const PLAN_FAILS = new Set(["registry_unreadable", "registry_invalid", "conflict"]);

function main() {
  const apply = has("apply");
  const replace = has("replace");
  const unregister = has("unregister");
  // 歧义命令**不许被解释成破坏性更强的那个**。--replace --unregister 同时给出时，
  // 上一版静默选了注销 —— 那是在替人做一个他没表达的决定，跟显式授权正相反。
  if (replace && unregister) fail("ambiguous_mode");
  const mode = unregister ? "unregister" : (replace ? "replace" : "add");
  const id = arg("id");
  const script = arg("script");
  if (unregister) {
    // 注销模式下这些参数没有任何作用。静默忽略会让人以为"我顺手也更新了配置"。
    // 白名单已经挡掉未知参数；这里管的是"已知但在本模式下无意义"的那几个。
    const ignored = [...OPTIONS].filter((k) => k !== "id" && has(k));
    if (ignored.length > 0) fail("unregister_takes_no_config", ignored.join("、"));
    if (PASSTHROUGH.length > 0) fail("unregister_takes_no_args");
  }
  const executable = arg("executable") ?? process.execPath;
  const kinds = (arg("kinds") ?? "transport").split(",").map((k) => k.trim()).filter(Boolean);
  const displayName = arg("display-name");
  const file = statusProvidersPath();

  if (!id || (!script && !unregister)) {
    console.error("用法：node scripts/register-status-provider.mjs --id <id> --script <绝对路径>\n" +
      "        [--executable <绝对路径>] [--kinds transport,progress] [--display-name <名字>]\n" +
      "        [--replace] [--apply] [-- <传给 provider 的参数...>]\n" +
      "      注销：--id <id> --unregister [--apply]");
    process.exit(2);
  }

  const entry = unregister ? { id } : {
    id, protocol: PROVIDER_PROTOCOL, executable, script,
    args: PASSTHROUGH, allowed_kinds: kinds,
    ...(displayName ? { display_name: displayName } : {}),
  };

  if (!unregister) {
    // 登记命令和读取路径共用同一套规则，避免"登记时说合法、读取时又说不合法"。
    const shaped = validateProviderRegistry({ providers: [entry] });
    if (!shaped.ok) fail(shaped.problem);
    if (!fs.existsSync(script)) fail("script_missing", script);
    if (!fs.statSync(script).isFile()) fail("script_not_a_file", script);
  }

  // **先算计划再输出**：预览和落盘看的是同一份真实状态。
  const plan = planRegistration({ file, entry, mode });

  console.log("登记表    " + file);
  console.log("动作      " + (unregister ? "注销" : replace ? "替换" : "新增") + " · " + id);
  if (!unregister) {
    console.log("provider  " + id + " → " + script);
    console.log("执行      " + executable);
    console.log("参数      " + (entry.args.length > 0 ? entry.args.join(" ") : "（无）"));
    console.log("授权范围  " + kinds.join(", "));
  }
  console.log("结果      " + describePlan(plan));

  if (plan.action === "conflict") {
    console.log("\n要改这条登记，用 --replace（同样默认预览）；要撤掉它，用 --unregister。");
  }
  if (!unregister && (plan.action === "add" || plan.action === "replace")) {
    console.log("\n提醒：状态入口会在你的交互会话里执行上面这个命令。");
    console.log("      它拿不到 AILY_CLI_* 和凭据（环境白名单只放 PATH/HOME/LANG/TZ），");
    console.log("      但它仍然是一次代码执行 —— 确认这个脚本是你信任的。");
  }

  if (!apply) {
    console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
    process.exit(PLAN_FAILS.has(plan.action) ? 1 : 0);
  }
  if (PLAN_FAILS.has(plan.action)) fail(plan.reason ?? "provider_exists_with_other_settings",
    plan.fields ? plan.fields.join("、") : undefined);
  if (plan.action === "unchanged" || plan.action === "absent") {
    console.log("\n无需改动。");
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockDir = file + ".lock";
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) fail("providers_busy");
  try {
    // 取锁之后重算同一个计划：锁外那份跟要写的那份不是同一个快照。
    const fresh = planRegistration({ file, entry, mode });
    if (PLAN_FAILS.has(fresh.action)) {
      fail(fresh.reason ?? "provider_exists_with_other_settings",
        fresh.fields ? fresh.fields.join("、") : undefined);
    }
    if (fresh.action === "unchanged" || fresh.action === "absent") {
      console.log("\n无需改动。");
      return;
    }
    // 只动目标那一项，不重建文档 —— 未知顶层字段原样保留。
    if (fresh.action === "add") fresh.doc.providers.push(entry);
    else if (fresh.action === "replace") fresh.doc.providers[fresh.at] = entry;
    else if (fresh.action === "remove") fresh.doc.providers.splice(fresh.at, 1);

    const valid = validateProviderRegistry(fresh.doc);
    if (!valid.ok) fail(valid.problem);
    writeDoc(fresh.doc, file);
    console.log("\n" + (fresh.action === "remove" ? "已注销。" : "已写入。"));
  } finally {
    releasePublishLock(lockDir);
  }
}

if (isDirectRun(import.meta.url)) main();
