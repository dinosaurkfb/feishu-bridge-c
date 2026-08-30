/**
 * 维护桩（issue #81 PR C，方案稿"第 1 层 · 启动挡板"）：两条链的 `runtime/current` 在维护窗口里指向
 * `versions/maintenance-<token>/`，里面 `scripts/` = 入口清单全集，按类别是同一份**自包含**桩脚本（不 import 任何东西，不写任何桥状态）：
 *
 *   silent        Stop / init hook、定时器、worker、outbound → 无输出 exit 0（被挡的 Stop 回合丢弃，at-most-once）
 *   control       技能引用的控制脚本（bind / rotate / mode / …）→ stdout 一行"维护中"，exit 2
 *   prompt_hook   UserPromptSubmit（两链）：Aily 回合（AILY_CLI_CALLER_AGENT_UID = 链模板 agent_uid；模板读不出 → 任何 Aily 调用方都算）
 *                 → 硬阻断 stdout {"decision":"block","reason":"桥维护中（<reason>）：这条消息没有处理，请稍后重发"}；本地回合无输出 exit 0
 *   aily_inbound  Aily 直接入口（aily-inbound / dispatcher / inbound，两链）→ 确定性 stdout 一句话 exit 0；不 claim、不写回执、不重放
 *   status        status / doctor（两链）→ "维护中（<reason>，已 N 分钟，token <前 8 位>）"，exit 2
 *
 * 桩目录带 MAINTENANCE.json（token / at / reason / 原 current 目标 / entries）；verifyRuntime 对桩返回 reason:"maintenance"。
 * 不认识的名字按 control 处理（有回音、非零退出），宁可吵也不静默放行。
 */
import fs from "node:fs";
import path from "node:path";

import { normalizeGateReason } from "../maintenance-gate-core.mjs";

export const STUB_PREFIX = "maintenance-";
export const STUB_MANIFEST = "MAINTENANCE.json";
export const STUB_CATEGORIES = Object.freeze(["silent", "control", "prompt_hook", "aily_inbound", "status"]);
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SILENT = new Set(["stop-hook.mjs", "init-hook.mjs", "drain-outbox.mjs", "watch-and-publish.mjs", "outbound.mjs", "drain-all.mjs", "watch-run.mjs", "run-resume.mjs", "drain-service.mjs"]);
const AILY_INBOUND = new Set(["aily-inbound.mjs", "inbound-dispatcher.mjs", "inbound.mjs"]);
const STATUS = new Set(["feishu-status.mjs", "doctor.mjs"]);
const PROMPT_HOOK = new Set(["inbound-hook.mjs", "codex/prompt-hook.mjs"]);

export function stubCategory(name) {
  const base = name.startsWith("codex/") ? name.slice("codex/".length) : name;
  if (PROMPT_HOOK.has(name)) return "prompt_hook";
  if (STATUS.has(base)) return "status";
  if (AILY_INBOUND.has(base)) return "aily_inbound";
  if (SILENT.has(base)) return "silent";
  return "control";
}
export const stubDirName = (token) => STUB_PREFIX + token;
export const stubRelTarget = (token) => path.join("versions", stubDirName(token));
export const isStubTarget = (linkTarget) => typeof linkTarget === "string" && /^versions\/maintenance-[0-9a-f-]{36}$/u.test(linkTarget);

/** 自包含桩脚本正文。参数全部 JSON 内嵌，桩不读任何配置。 */
export function renderStubScript({ name, category = stubCategory(name), token, reason, at, agentUid = null }) {
  const p = JSON.stringify({ name, category, token, reason: normalizeGateReason(reason), at, agentUid });
  return [
    "// 飞书桥维护桩（issue #81）：维护窗口里 runtime/current 指向这里。不 import、不写任何桥状态。",
    "const P = " + p + ";",
    'const text = "桥维护中（" + P.reason + "）";',
    'if (P.category === "silent") process.exit(0);',
    'if (P.category === "prompt_hook") {',
    "  const caller = process.env.AILY_CLI_CALLER_AGENT_UID;",
    '  const aily = typeof caller === "string" && caller.length > 0 && (P.agentUid === null || caller === P.agentUid);',
    "  if (!aily) process.exit(0);",
    '  process.stdout.write(JSON.stringify({ decision: "block", reason: text + "：这条消息没有处理，请稍后重发" }) + "\\n");',
    "  process.exit(0);",
    "}",
    'if (P.category === "aily_inbound") { process.stdout.write(text + "，这条消息没有处理，请稍后重发\\n"); process.exit(0); }',
    'if (P.category === "status") {',
    "  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(P.at)) / 60000));",
    '  process.stdout.write("维护中（" + P.reason + "，已 " + minutes + " 分钟，token " + String(P.token).slice(0, 8) + "）\\n");',
    "  process.exit(2);",
    "}",
    'process.stdout.write(text + "：控制命令暂不可用，请稍后再试\\n");',
    "process.exit(2);",
    "",
  ].join("\n");
}

/**
 * 在 root/versions/maintenance-<token>/ 建桩（此时不切 current；切换由 operation 记账后做）。已存在 → stub_exists（不覆盖）。
 * entries 是这条链清单里的 `scripts/` 相对名（Claude 链只放不带 codex/ 前缀的，Codex 链只放 codex/ 下的 —— 由调用方筛）。
 */
export function buildStubVersion({ root, token, reason, at = new Date().toISOString(), entries, agentUid = null, originalCurrent }) {
  if (typeof token !== "string" || !UUID_SHAPE.test(token)) return { ok: false, reason: "token_shape" };
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, reason: "entries_empty" };
  const dir = path.join(root, "versions", stubDirName(token));
  let exists = false;
  try { fs.lstatSync(dir); exists = true; } catch (err) { if (err?.code !== "ENOENT") return { ok: false, reason: "io_error", why: String(err?.code ?? err?.message) }; }
  if (exists) return { ok: false, reason: "stub_exists", dir };
  const staging = dir + ".staging-" + process.pid;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, "scripts"), { recursive: true, mode: 0o700 });
    for (const name of entries) {
      const file = path.join(staging, "scripts", ...name.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, renderStubScript({ name, token, reason, at, agentUid }), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(staging, STUB_MANIFEST), JSON.stringify({ schema_version: "1.0", token, at, reason: normalizeGateReason(reason), original_current: originalCurrent ?? null, entries: [...entries].sort() }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(staging, dir);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: "io_error", why: String(err?.code ?? err?.message ?? err) };
  }
  return { ok: true, dir, rel: stubRelTarget(token) };
}

/** 读桩清单（三态）。 */
export function readStubManifest(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, STUB_MANIFEST), "utf-8"); } catch (err) { return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: String(err?.code ?? err?.message) }; }
  let doc;
  try { doc = JSON.parse(text); } catch { return { state: "unreadable", why: "不是 JSON" }; }
  if (doc?.schema_version !== "1.0" || typeof doc.token !== "string" || !UUID_SHAPE.test(doc.token) || typeof doc.at !== "string" || typeof doc.reason !== "string" || !Array.isArray(doc.entries)) return { state: "unreadable", why: "形状不对" };
  return { state: "valid", doc };
}

/** 删桩目录：只删 token 一致、且 current 此刻不指向它的桩（调用方先切走）。 */
export function removeStubVersion({ root, token }) {
  const dir = path.join(root, "versions", stubDirName(token));
  const m = readStubManifest(dir);
  if (m.state === "absent") { try { fs.lstatSync(dir); } catch (err) { if (err?.code === "ENOENT") return { ok: true, removed: false, reason: "absent" }; } return { ok: false, removed: false, reason: "stub_unrecognized", why: "目录在但没有清单" }; }
  if (m.state === "unreadable") return { ok: false, removed: false, reason: "stub_unrecognized", why: m.why };
  if (m.doc.token !== token) return { ok: false, removed: false, reason: "not_owner" };
  let link = null;
  try { link = fs.readlinkSync(path.join(root, "current")); } catch { link = null; }
  if (link === stubRelTarget(token)) return { ok: false, removed: false, reason: "still_current" };
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { return { ok: false, removed: false, reason: "io_error", why: String(err?.code ?? err?.message) }; }
  return { ok: true, removed: true, reason: null };
}
