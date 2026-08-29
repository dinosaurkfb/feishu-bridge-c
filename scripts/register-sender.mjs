#!/usr/bin/env node
/**
 * 发送者角色登记（goal「入站权限分级」第 1 层）：往机器级链路模板的 `senders` 里加 / 删一个人。
 *
 *   node scripts/register-sender.mjs --template <chain-config.json 绝对路径> --open-id <数字> --role operator|participant [--note <说明>] [--apply]
 *   node scripts/register-sender.mjs --template <…> --remove --open-id <数字> [--apply]
 *
 * · 默认只预览；写入是扩大/收缩授权面，**需要 owner（Frank）逐次授权**后才 --apply。
 * · owner 不在这里登记：owner 就是 frank_sender_id，只有一个；给别人标 owner、把 frank_sender_id 标成别的角色，都拒。
 * · 改前把整份模板备份成 <file>.bak.<时间>，原子写；写完用同一份校验器（validateChainTemplate）读回来核对。
 * · 第 1 层不改 sender_ids（授权基准仍只有 owner），所以 FR-2.5 的 binding 授权快照不需要重签；
 *   第 2 层把角色接入判定时再走 subscription-sync 评估影响面 —— 预览里会写明这一点。
 */
import fs from "node:fs";
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { describeTemplateWrite, loadChainTemplate, validateChainTemplate, withChainTemplateWrite } from "./chain-template.mjs";
import { SENDER_ROLES, roleCounts, roleCountsText, senderRolesProblem, senderTable } from "./sender-roles.mjs";

export function parseRegisterSenderArgs(argv) {
  const out = { template: null, openId: null, role: null, note: null, remove: false, apply: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (seen.has(a)) return { ok: false, reason: "duplicate_argument", argument: a };   // 受控写入口：重复参数不许"以后一个为准"
    if (a === "--apply" || a === "--remove") { seen.add(a); out[a.slice(2)] = true; continue; }
    if (["--template", "--open-id", "--role", "--note"].includes(a)) {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: a + "_value_required" };
      seen.add(a);
      if (a === "--template") out.template = v; else if (a === "--open-id") out.openId = v; else if (a === "--role") out.role = v; else out.note = v;
      i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!out.template || !path.isAbsolute(out.template)) return { ok: false, reason: "template_required_absolute" };
  if (!out.openId || !/^\d+$/u.test(out.openId)) return { ok: false, reason: "open_id_shape" };
  // "登记"与"移除"是封闭联合：移除不带 role / note；登记必带合法 role
  if (out.remove) {
    if (out.role !== null || out.note !== null) return { ok: false, reason: "remove_takes_no_role" };
  } else {
    if (!out.role) return { ok: false, reason: "role_required" };
    if (out.role === "owner") return { ok: false, reason: "owner_not_registrable" };
    if (!SENDER_ROLES.includes(out.role)) return { ok: false, reason: "role_unknown" };
  }
  return { ok: true, ...out };
}

/** 纯函数：算出新模板。不写盘。 */
export function planSenderChange(template, { openId, role, note = null, remove = false }) {
  if (senderRolesProblem(template) !== null) return { ok: false, reason: "template_senders_invalid", problem: senderRolesProblem(template) };
  if (openId === template.frank_sender_id) return { ok: false, reason: "owner_immutable" };
  const current = Array.isArray(template.senders) ? template.senders : [];
  const existing = current.find((e) => e.open_id === openId) ?? null;
  let next;
  if (remove) {
    if (!existing) return { ok: false, reason: "not_registered" };
    next = current.filter((e) => e.open_id !== openId);
  } else {
    const entry = note !== null ? { open_id: openId, role, note } : { open_id: openId, role };
    if (existing && existing.role === role && (existing.note ?? null) === note) return { ok: true, changed: false, template, table: senderTable(template) };
    next = existing ? current.map((e) => (e.open_id === openId ? entry : e)) : [...current, entry];
  }
  const candidate = { ...template, senders: next };
  const problem = senderRolesProblem(candidate);
  if (problem !== null) return { ok: false, reason: "result_invalid", problem };
  const valid = validateChainTemplate(candidate);
  if (!valid.ok) return { ok: false, reason: "result_invalid", problem: JSON.stringify(valid) };
  return { ok: true, changed: true, template: candidate, table: senderTable(candidate), before: existing, after: remove ? null : next.find((e) => e.open_id === openId) };
}

/** 写盘：走 chain-template 的唯一写事务（锁内重读 → 重规划 → 校验 → 备份 → 原子写 → 逐字读回）。change 是变更意图，以锁内世界为准重算。 */
export function applySenderChange({ file, change, now = new Date() }) {
  if (!change || typeof change !== "object") return { ok: false, reason: "change_required" };
  let planned = null;
  const r = withChainTemplateWrite({ file, now, mutate: (current) => {
    if (current === null) return { ok: false, reason: "template_unreadable", detail: "模板不存在" };
    planned = planSenderChange(current, change);
    if (!planned.ok) return planned;
    if (!planned.changed) return { changed: false };
    return { template: planned.template };
  } });
  if (!r.ok) return r;
  return { ok: true, changed: r.changed, backup: r.backup ?? null, table: planned?.table ?? senderTable(r.template), before: planned?.before ?? null, after: planned?.after ?? null,
    ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRegisterSenderArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write("用法：node scripts/register-sender.mjs --template <绝对路径> --open-id <数字> --role operator|participant [--note <说明>] [--apply]\n" +
      "      node scripts/register-sender.mjs --template <绝对路径> --remove --open-id <数字> [--apply]（" + parsed.reason + "）\n");
    process.exit(2);
  }
  const loaded = loadChainTemplate(parsed.template);
  if (!loaded.ok) { process.stdout.write("模板读不出来 / 校验不过：" + loaded.reason + "\n"); process.exit(1); }
  const plan = planSenderChange(loaded.template, parsed);
  if (!plan.ok) { process.stdout.write("没有登记：" + plan.reason + (plan.problem ? "：" + plan.problem : "") + "\n"); process.exit(1); }
  process.stdout.write("模板    ：" + parsed.template + "\n");
  process.stdout.write("动作    ：" + (parsed.remove ? "移除 " + parsed.openId : (plan.before ? "改为 " : "登记 ") + parsed.openId + " → " + parsed.role) + "\n");
  process.stdout.write("角色人数：" + roleCountsText(roleCounts(plan.table)) + "（改后）\n");
  process.stdout.write("同步    ：第 1 层不改 sender_ids（授权基准仍只有 owner），binding 授权快照不需重签；非 owner 的入站在第 2 层接入前仍被拒。\n");
  if (!plan.changed) { process.stdout.write("已经是这样，没动。\n"); process.exit(0); }
  if (!parsed.apply) { process.stdout.write("\n[dry-run] 什么都没写。写入是改授权面，要 owner 逐次授权后再加 --apply。\n"); process.exit(0); }
  const done = applySenderChange({ file: parsed.template, change: parsed });
  const out = describeTemplateWrite(done, parsed.template);
  if (done.ok && done.changed) out.lines.splice(1, 0, "角色人数：" + roleCountsText(roleCounts(done.table)));
  process.stdout.write(out.lines.join("\n") + "\n");
  process.exit(out.exitCode);
}
