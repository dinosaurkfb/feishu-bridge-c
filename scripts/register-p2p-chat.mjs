#!/usr/bin/env node
/**
 * 已验证私聊 chat 白名单登记（#R11 P1-1，Frank 拍板 b 选项）：往机器级链路模板的
 * `verified_p2p_chat_ids` 里加 / 删一个 chat id。登记表是判定「私聊」的正向依据——
 * 没有它，`isPrivateChatTurn` 恒 false，私聊按群处理（拒绝 + hint），这是 fail-safe。
 *
 *   node scripts/register-p2p-chat.mjs --template <chain-config.json 绝对路径> --add <oc_…>
 *   node scripts/register-p2p-chat.mjs --template <…> --remove <oc_…>
 *
 * · 默认只预览；写入是扩大私聊豁免面，**需要 owner（Frank）逐次授权**后才 --apply。
 * · 改前把整份模板备份成 <file>.bak.<时间>，原子写；写完用同一份校验器（validateChainTemplate）
 *   读回来核对。
 * · 登记群 chat_id 拒（它是群不是私聊）；重复 add / 未登记 remove 都清晰拒绝。
 * · 仅此一项改变白名单；不改 sender_ids，binding 授权快照不需重签。
 */
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { describeTemplateWrite, loadChainTemplate, validateChainTemplate, withChainTemplateWrite } from "./chain-template.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";

const OC_RE = /^oc_[A-Za-z0-9_]+$/u;

export function p2pIdsProblem(template) {
  if (template?.verified_p2p_chat_ids === undefined) return null; // 缺省合法（= 没登记任何私聊放行）
  const list = template.verified_p2p_chat_ids;
  if (!Array.isArray(list)) return "verified_p2p_chat_ids 必须是数组";
  if (new Set(list).size !== list.length) return "verified_p2p_chat_ids 有重复";
  for (const x of list) {
    if (typeof x !== "string" || x.length === 0) return "verified_p2p_chat_ids 含非字符串或空串";
    if (!OC_RE.test(x)) return "verified_p2p_chat_ids 含非 oc_ 形状：" + x;
  }
  return null;
}

export function parseRegisterP2pArgs(argv) {
  const out = { template: null, chatId: null, remove: false, apply: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (seen.has(a)) return { ok: false, reason: "duplicate_argument", argument: a };
    if (a === "--apply") { seen.add(a); out.apply = true; continue; }
    if (["--template", "--add", "--remove"].includes(a)) {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: a + "_value_required" };
      seen.add(a);
      if (a === "--template") out.template = v;
      else { out.chatId = v; out.remove = a === "--remove"; }
      i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!out.template || !path.isAbsolute(out.template)) return { ok: false, reason: "template_required_absolute" };
  if (!out.chatId || !OC_RE.test(out.chatId)) return { ok: false, reason: "chat_id_shape_oc" };
  // 登记（--add）与移除（--remove）是封闭联合：互斥。
  if (seen.has("--add") && seen.has("--remove")) return { ok: false, reason: "add_remove_mutually_exclusive" };
  return { ok: true, ...out };
}

/** 纯函数：算出新模板。不写盘。 */
export function planP2pChange(template, { chatId, remove = false }) {
  const problem = p2pIdsProblem(template);
  if (problem !== null) return { ok: false, reason: "template_p2p_invalid", problem };
  if (chatId === template.chat_id) return { ok: false, reason: "group_chat_not_private", problem: "登记群不是私聊" };
  const current = Array.isArray(template.verified_p2p_chat_ids) ? template.verified_p2p_chat_ids : [];
  const has = current.includes(chatId);
  let next;
  if (remove) {
    if (!has) return { ok: false, reason: "not_registered" };
    next = current.filter((c) => c !== chatId);
  } else {
    if (has) return { ok: false, reason: "already_registered" };
    next = [...current, chatId];
  }
  const candidate = { ...template, verified_p2p_chat_ids: next };
  const valid = validateChainTemplate(candidate);
  if (!valid.ok) return { ok: false, reason: "result_invalid", problem: JSON.stringify(valid) };
  return { ok: true, changed: true, template: candidate, count: next.length, registered: remove ? null : chatId, removed: remove ? chatId : null };
}

/** 写盘：走 chain-template 的唯一写事务（锁内重读 → 重规划 → 校验 → 备份 → 原子写 → 逐字读回）。 */
export function applyP2pChange({ file, change, now = new Date() }) {
  if (!change || typeof change !== "object") return { ok: false, reason: "change_required" };
  let planned = null;
  const r = withChainTemplateWrite({ file, now, mutate: (current) => {
    if (current === null) return { ok: false, reason: "template_unreadable", detail: "模板不存在" };
    planned = planP2pChange(current, change);
    if (!planned.ok) return planned;
    return { template: planned.template };
  } });
  if (!r.ok) return r;
  return { ok: true, changed: r.changed, backup: r.backup ?? null, count: planned?.count ?? null,
    registered: planned?.registered ?? null, removed: planned?.removed ?? null,
    ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRegisterP2pArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write("用法：node scripts/register-p2p-chat.mjs --template <绝对路径> --add <oc_…> [--apply]\n" +
      "      node scripts/register-p2p-chat.mjs --template <绝对路径> --remove <oc_…> [--apply]（" + parsed.reason + "）\n");
    process.exit(2);
  }
  const loaded = loadChainTemplate(parsed.template);
  if (!loaded.ok) { process.stdout.write("模板读不出来 / 校验不过：" + loaded.reason + "\n"); process.exit(1); }
  const plan = planP2pChange(loaded.template, parsed);
  if (!plan.ok) { process.stdout.write("没有登记：" + plan.reason + (plan.problem ? "：" + plan.problem : "") + "\n"); process.exit(1); }
  process.stdout.write("模板    ：" + parsed.template + "\n");
  process.stdout.write("动作    ：" + (parsed.remove ? "移除 " + parsed.chatId : "登记 " + parsed.chatId) + "\n");
  process.stdout.write("白名单  ：" + plan.count + " 个（改后）\n");
  process.stdout.write("效果    ：改 `verified_p2p_chat_ids` 白名单；`isPrivateChatTurn` 只有命中才放行私聊（thread 纵深防御），未命中按群处理（拒绝 + hint）。\n");
  if (!parsed.apply) { process.stdout.write("\n[dry-run] 什么都没写。写入是扩大私聊豁免面，要 owner 逐次授权后再加 --apply。\n"); process.exit(0); }
  { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门
  const done = applyP2pChange({ file: parsed.template, change: parsed });
  const out = describeTemplateWrite(done, parsed.template);
  if (done.ok && done.changed) out.lines.splice(1, 0, "白名单  ：" + done.count + " 个（改后）");
  process.stdout.write(out.lines.join("\n") + "\n");
  process.exit(out.exitCode);
}
