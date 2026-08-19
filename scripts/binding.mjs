#!/usr/bin/env node
/**
 * 看和改这条绑定 —— 续期的唯一入口。
 *
 * 存在的理由：在这之前，续期的做法是手改 .runtime-data/inbound/active-mapping.json。
 * 那个文件在 gitignore 的运行时目录里，一年后没人记得它叫什么、哪个字段管什么。
 * 「到期前需要 Frank 自己想起来去查」正是本项目认定的设计失败。
 *
 * 为什么是个人工命令而不是自动续期：绑定是「这个话题里 Frank 说的话可以直接驱动一个
 * 能改代码、能跑命令的长期任务」这条授权本身。长期任务不该有单方面延长自己授权的能力，
 * 这也是 .runtime-data/ 对它写权限被显式拒绝的原因。续期得是一个有人按下的动作。
 *
 * 用法：
 *   node scripts/binding.mjs                          # 只看，不改
 *   node scripts/binding.mjs --renew 1y --apply
 *   node scripts/binding.mjs --renew 2027-08-19 --apply
 *   node scripts/binding.mjs --quota unlimited --apply
 *   node scripts/binding.mjs --quota 500 --apply
 *   node scripts/binding.mjs --note "长期绑定（非测试期）" --apply
 *   node scripts/binding.mjs --prefix none --apply      # 关掉前缀，@ 一下就够
 *   node scripts/binding.mjs --prefix "→Claude" --apply
 */

import fs from "node:fs";
import path from "node:path";

import { NO_PREFIX, UNLIMITED, isValidPrefix, isValidQuota } from "./selector.mjs";
import { checkBinding, WARN_DAYS } from "./binding-health.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MAPPING = path.join(ROOT, ".runtime-data", "inbound", "active-mapping.json");
const DAY_MS = 24 * 60 * 60 * 1000;

/** 相对写法（1y / 6m / 90d）和绝对日期都收。相对量一律从**现在**起算，不是从原到期日续。 */
export function resolveUntil(spec, now = Date.now()) {
  const rel = /^(\d+)([dmy])$/i.exec(String(spec).trim());
  if (rel) {
    const n = Number(rel[1]);
    if (n <= 0) return { ok: false, reason: "续期长度必须是正数" };
    const d = new Date(now);
    const unit = rel[2].toLowerCase();
    if (unit === "d") d.setUTCDate(d.getUTCDate() + n);
    if (unit === "m") d.setUTCMonth(d.getUTCMonth() + n);
    if (unit === "y") d.setUTCFullYear(d.getUTCFullYear() + n);
    return { ok: true, iso: d.toISOString() };
  }

  const parsed = Date.parse(spec);
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason: "看不懂「" + spec + "」。用 1y / 6m / 90d 或 2027-08-19" };
  }
  // 往回续等于当场把桥关掉。这种事必须是明确的操作，不能是手滑打错一个年份。
  if (parsed <= now) return { ok: false, reason: "新的到期时间必须在将来" };
  return { ok: true, iso: new Date(parsed).toISOString() };
}

export const NOTE_MAX = 300;

/**
 * note 是给人看的字段，没有代码读它 —— 但正因为没人校验，它最容易变成过期的谎话。
 * 只挡两种明显的手滑：空串（等于删掉说明）和以 `--` 开头
 * （`--note --apply` 会把下一个参数当成值，于是 note 变成 "--apply" 而 --apply 消失，
 * 结果是"改了个奇怪的备注，而且没落盘"）。
 */
export function validateNote(v) {
  const s = String(v ?? "");
  if (s.trim().length === 0) return { ok: false, reason: "备注不能是空的" };
  if (s.startsWith("--")) return { ok: false, reason: "备注不像备注（「" + s + "」）——是不是漏了引号？" };
  if (s.length > NOTE_MAX) return { ok: false, reason: "备注最长 " + NOTE_MAX + " 字，收到 " + s.length + " 字" };
  return { ok: true, note: s.trim() };
}

// ---------- CLI ----------

if (import.meta.url !== "file://" + process.argv[1]) {
  // 被 import 时只提供上面那个纯函数，不碰任何文件。
} else {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");

let mapping;
try {
  mapping = JSON.parse(fs.readFileSync(MAPPING, "utf-8"));
} catch (err) {
  console.error("读不了绑定文件：" + MAPPING);
  console.error(err.message);
  process.exit(1);
}

const now = Date.now();
const health = checkBinding({ root: ROOT, now });

// ---------- 算改动 ----------

const changes = [];

const renewSpec = arg("renew");
if (renewSpec !== undefined) {
  const r = resolveUntil(renewSpec, now);
  if (!r.ok) {
    console.error("续期失败：" + r.reason);
    process.exit(1);
  }
  changes.push(["expires_at", mapping.expires_at, r.iso]);
}

const quotaSpec = arg("quota");
if (quotaSpec !== undefined) {
  const value = quotaSpec === UNLIMITED ? UNLIMITED : Number(quotaSpec);
  // 用 selector 那条规则校验，保证工具写不出入站会判成配错的值。
  if (!isValidQuota(value)) {
    console.error("配额只能是 unlimited 或正整数，收到「" + quotaSpec + "」");
    process.exit(1);
  }
  changes.push(["max_inbound_messages", mapping.max_inbound_messages, value]);
}

// CLI 上没法直接打 JSON 的 null，用 none 表示「关掉」。同样只认这一个字面量：
// 关掉前缀是个决定，不该因为参数写歪了而发生。
const prefixSpec = arg("prefix");
if (prefixSpec !== undefined) {
  const value = prefixSpec === "none" ? NO_PREFIX : prefixSpec;
  if (!isValidPrefix(value)) {
    console.error("前缀只能是一段非空文本，或 none（表示不要前缀），收到「" + prefixSpec + "」");
    process.exit(1);
  }
  changes.push(["inbound_prefix", mapping.inbound_prefix, value]);
}

const noteSpec = arg("note");
if (noteSpec !== undefined) {
  const r = validateNote(noteSpec);
  if (!r.ok) {
    console.error("备注没改：" + r.reason);
    process.exit(1);
  }
  changes.push(["note", mapping.note, r.note]);
}

// ---------- 报告现状 ----------

const consumed = Array.isArray(mapping.consumed_message_ids) ? mapping.consumed_message_ids.length : 0;
const quotaNow = mapping.max_inbound_messages;
const daysLeft = health.expiresAt ? Math.floor((health.expiresAt - now) / DAY_MS) : null;

const STATE_TEXT = {
  ok: "正常",
  expiring: "快到期",
  expired: "已过期 —— 入站现在一律被拒",
  malformed: "expires_at 读不出日期 —— 入站会一律判过期",
  absent: "没有绑定文件",
};

console.log("绑定    " + (mapping.binding_id ?? "(无 id)"));
console.log("状态    " + (mapping.status ?? "?") + " / " + (STATE_TEXT[health.state] ?? health.state));
console.log("有效期  " + (mapping.expires_at ?? "(缺)") +
  (daysLeft === null ? "" : "   还有 " + daysLeft + " 天"));
console.log("配额    " + (quotaNow === UNLIMITED ? "不限" : quotaNow) + "   已用 " + consumed + " 条");
console.log("话题    " + (mapping.session_id ?? "?"));
console.log("根消息  " + (mapping.feishu_root_message_id_reference ?? "?"));
console.log("前缀    " + (mapping.inbound_prefix === null ? "不需要（@ 一下即可）" : JSON.stringify(mapping.inbound_prefix)));
console.log("备注    " + (mapping.note ?? "(无)"));

if (changes.length === 0) {
  console.log("\n没有要改的。续期：--renew 1y --apply（也收 6m / 90d / 2027-08-19）");
  if (health.state === "expiring" || health.state === "expired") {
    console.log("现在就该续了。");
  } else {
    console.log("到期前 " + WARN_DAYS.join(" 天和 ") + " 天会自动往飞书报一次，不用你记着。");
  }
  process.exit(0);
}

console.log("\n改动：");
for (const [field, before, after] of changes) {
  console.log("  " + field + "\n    " + JSON.stringify(before) + "\n    → " + JSON.stringify(after));
}

if (!apply) {
  console.log("\n[dry-run] 什么都没写。加 --apply 才落盘。");
  process.exit(0);
}

// ---------- 写 ----------

for (const [field, , after] of changes) mapping[field] = after;

// 留一份上一版：改错了能立刻退回去，不用去翻别的地方。
fs.copyFileSync(MAPPING, MAPPING + ".prev");

const tmp = MAPPING + ".tmp." + process.pid;
fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, MAPPING);

const after = checkBinding({ root: ROOT, now });
console.log("\n已写入。现在状态：" + (STATE_TEXT[after.state] ?? after.state));
console.log("上一版留在 " + path.basename(MAPPING) + ".prev");
console.log("入站立即生效 —— 每条消息都是现读 mapping，不缓存。");

}
