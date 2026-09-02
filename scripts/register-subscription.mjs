#!/usr/bin/env node
/**
 * 订阅登记（FR-2.6 单 1）：往机器级订阅控制面 store 里 增 / 停 / 恢复 / 删 一条订阅。
 *
 *   node scripts/register-subscription.mjs --store <subscriptions.json 绝对路径> --template <chain-config.json 绝对路径> \
 *     --runtime claude|codex --domain-key <项目根或业务域> --chat-id <oc_…> [--freshness-ms <N>] [--apply]
 *   node scripts/register-subscription.mjs … --pause|--resume|--remove [--apply]
 *
 * · 默认只预览；写入是改订阅控制面，**需要 owner（Frank）逐次授权**后才 --apply。
 * · 提案 A（2026-09-01 拍板）：Subscription v1 schema 不动，多群 = 同域多条订阅；
 *   新订阅的 chat_id 允许与模板不同 —— 这正是多群的意义。
 * · 订阅 id 派生与投影同一套（subscriptionControlId → stableControlId("subscription",
 *   endpoint, domain, chat, agent)），控制面对象与 legacy 投影同 id 对齐。
 * · --apply 走 store 的唯一写事务（subscription-store.mjs）：锁内重读重算 → 逐条校验 →
 *   备份 → 临时文件 + rename 原子写 → 逐字读回；维护门照 register-sender 的样子在门前。
 * · 不认领、不路由、不碰登记表：本命令只写控制面；切流另有单。
 */
import fs from "node:fs";
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";
import {
  SUBSCRIPTION_RUNTIMES, applySubscriptionChange, loadSubscriptionStore, planSubscriptionChange,
} from "./subscription-store.mjs";

export function parseRegisterSubscriptionArgs(argv) {
  const out = { store: null, template: null, runtime: null, domainKey: null, chatId: null, freshnessMs: null, instanceKey: null, subscriptionId: null, pause: false, resume: false, remove: false, apply: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (seen.has(a)) return { ok: false, reason: "duplicate_argument", argument: a };   // 受控写入口：重复参数不许"以后一个为准"
    if (a === "--apply" || a === "--pause" || a === "--resume" || a === "--remove") { seen.add(a); out[a.slice(2)] = true; continue; }
    if (["--store", "--template", "--runtime", "--domain-key", "--chat-id", "--freshness-ms", "--instance-key", "--subscription-id"].includes(a)) {
      const v = argv[i + 1];
      if (typeof v !== "string" || v.startsWith("--") || v.length === 0) return { ok: false, reason: a + "_value_required" };
      seen.add(a);
      if (a === "--store") out.store = v; else if (a === "--template") out.template = v;
      else if (a === "--runtime") out.runtime = v; else if (a === "--domain-key") out.domainKey = v;
      else if (a === "--chat-id") out.chatId = v;
      else if (a === "--instance-key") out.instanceKey = v;
      else if (a === "--subscription-id") out.subscriptionId = v;
      else {
        if (!/^\d+$/u.test(v) || Number(v) <= 0) return { ok: false, reason: "freshness_ms_shape" };
        out.freshnessMs = Number(v);
      }
      i += 1; continue;
    }
    return { ok: false, reason: "unknown_argument", argument: a };
  }
  if (!out.store || !path.isAbsolute(out.store)) return { ok: false, reason: "store_required_absolute" };
  if (!out.template || !path.isAbsolute(out.template)) return { ok: false, reason: "template_required_absolute" };
  if (!SUBSCRIPTION_RUNTIMES.includes(out.runtime)) return { ok: false, reason: "runtime_required" };
  if (!out.domainKey) return { ok: false, reason: "domain_key_required" };
  if (!out.chatId) return { ok: false, reason: "chat_id_required" };
  const actions = ["pause", "resume", "remove"].filter((k) => out[k]);
  if (actions.length > 1) return { ok: false, reason: "one_action_at_a_time", detail: actions.join(",") };
  if (out.freshnessMs !== null && actions.length) return { ok: false, reason: "freshness_only_on_add" };
  out.action = actions[0] ?? "add";
  // 寻址封闭（评审 #112 裁决）：--subscription-id 只用于寻址既有条目（add 的 id 永远重算）；
  // 与 --instance-key 互斥（一次一种寻址方式）。
  if (out.subscriptionId !== null && out.action === "add") return { ok: false, reason: "subscription_id_not_for_add" };
  if (out.subscriptionId !== null && out.instanceKey !== null) return { ok: false, reason: "one_addressing_at_a_time" };
  return { ok: true, ...out };
}

/** 锁外预览：读模板 + 读 store，算出将要发生什么。不写盘。 */
export function previewSubscriptionChange({ change }) {
  const loaded = loadChainTemplate(change.template);
  if (!loaded.ok) return { ok: false, reason: "template_unreadable", detail: loaded.reason };
  const template = loaded.template;
  const store = loadSubscriptionStore({ file: change.store });
  if (!store.ok) return { ok: false, reason: "store_invalid", problems: store.problems };
  const planned = planSubscriptionChange({ store: { subscriptions: store.subscriptions }, runtime: change.runtime, template,
    domainKey: change.domainKey, chatId: change.chatId, freshnessMs: change.freshnessMs, action: change.action,
    instanceKey: change.instanceKey, subscriptionId: change.subscriptionId });
  return { ok: true, template, planned, absent: store.absent };
}

/** 写事务结果的人话（镜像 register-sender / describeTemplateWrite 的结构）。 */
export function describeStoreWrite(r, file) {
  const lines = [];
  const detail = (x) => (x.detail ? "：" + (typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail)) : "") +
    (x.error ? "：" + x.error : "") + (x.problems ? "：" + x.problems.join(",") : "");
  let exitCode = 0;
  if (!r || typeof r !== "object") { lines.push("没有写成：结果说不清"); exitCode = 1; }
  else if (!r.ok) { lines.push("没有写成：" + r.reason + detail(r)); exitCode = 1; }
  else if (!r.changed) lines.push("锁内重读后已经是这样，没动。");
  else lines.push("已写入（锁内重读重算后）。" + (r.backup ? "备份：" + r.backup : "首次创建，无备份"));
  if (r && r.lockUncleared) {
    lines.push("注意：订阅写锁没有交还（" + r.lockUncleared + "）；之后所有订阅写方都会报 store_busy，请人工确认没有写方在跑后处理 " + file + ".lock");
    exitCode = 1;
  }
  return { lines, exitCode };
}

if (isDirectRun(import.meta.url)) {
  const parsed = parseRegisterSubscriptionArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write("用法：node scripts/register-subscription.mjs --store <绝对路径> --template <绝对路径> --runtime claude|codex \\\n" +
      "        --domain-key <项目根或业务域> --chat-id <oc_…> [--freshness-ms <N>] [--apply]\n" +
      "      node scripts/register-subscription.mjs … --pause|--resume|--remove [--apply]（" + parsed.reason + (parsed.detail ? "：" + parsed.detail : "") + "）\n");
    process.exit(2);
  }
  const preview = previewSubscriptionChange({ change: parsed });
  if (!preview.ok) {
    process.stdout.write("没有登记：" + preview.reason + (preview.detail ? "：" + preview.detail : "") +
      (preview.problems ? "：" + preview.problems.join(",") : "") + "\n");
    process.exit(1);
  }
  const { planned } = preview;
  const actionText = { add: "新增", pause: "暂停", resume: "恢复", remove: "删除" }[parsed.action];
  process.stdout.write("订阅 store：" + parsed.store + (preview.absent ? "（还不存在，--apply 时创建）" : "") + "\n");
  process.stdout.write("链        ：" + parsed.runtime + "（agent " + preview.template.agent_uid + "）\n");
  process.stdout.write("域        ：" + parsed.domainKey + "\n");
  if (!planned.ok) {
    process.stdout.write("没有登记：" + planned.reason + (planned.problems ? "：" + planned.problems.join(",") : "") + "\n");
    process.exit(1);
  }
  const entry = planned.entry ?? planned.before ?? null;
  process.stdout.write("动作      ：" + actionText + " 订阅 " + (entry?.subscription_id ?? planned.subscription_id ?? "?") + "\n");
  if (entry?.scope) {
    process.stdout.write("范围      ：chat " + entry.scope.chat_id + " · transport " + entry.scope.transport_open_id +
      " · 发送者 " + entry.scope.sender_ids.join(",") + " · " + entry.scope.event_types.join(",") + "\n");
    process.stdout.write("时效      ：" + entry.constraints.freshness_ms + " ms · 状态 " + entry.status + " · v" + entry.version + "\n");
  }
  if (!planned.changed) { process.stdout.write("已经是这样，没动。\n"); process.exit(0); }
  if (!parsed.apply) { process.stdout.write("\n[dry-run] 什么都没写。写入是改订阅控制面，要 owner 逐次授权后再加 --apply。\n"); process.exit(0); }
  { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门
  const done = applySubscriptionChange({
    file: parsed.store,
    change: { action: parsed.action, runtime: parsed.runtime, template: preview.template, domainKey: parsed.domainKey, chatId: parsed.chatId, freshnessMs: parsed.freshnessMs, instanceKey: parsed.instanceKey, subscriptionId: parsed.subscriptionId },
  });
  const out = describeStoreWrite(done, parsed.store);
  process.stdout.write(out.lines.join("\n") + "\n");
  if (out.exitCode === 0) {
    process.stdout.write("注意：store 尚未接入权威投影与切流 —— 这次落盘暂不改变生产认领 / 路由（接入是切流单的事）。\n");
  }
  process.exit(out.exitCode);
}
