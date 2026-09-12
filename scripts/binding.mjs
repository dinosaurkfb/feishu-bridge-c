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
import { liveLineageIds, mutateExpiryEntries, readExpiryEntry, resolveExpiryTarget } from "./m1b/expiry-store.mjs"; // PK2-I2：权威到期（expiry.json）
import { decideLedgerRoute } from "./m1a/delivery-target.mjs"; // PK2-I2-fix1 P1-2：与 I1 同一份「收据 × 账本 authority_mode」矩阵
import { acquireOrderLock } from "./m1a/dual-write.mjs";
import { foldLockReleaseState } from "./maintenance/reaffirm-intents.mjs";
import { endpointReceipt } from "./maintenance/ledger-receipt.mjs";
import { maintenanceDir } from "./maintenance/journal.mjs";
import { loadByEndpoint } from "./topic-agent-ledger.mjs";
import { loadChainTemplate } from "./chain-template.mjs";
import { legacyEndpointId } from "./subscription.mjs";
import { checkBinding, WARN_DAYS } from "./binding-health.mjs";
import { projectMappingPath, resolveProject } from "./project-resolve.mjs";
import { registryPath } from "./registry.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";
import { gateBlocks, exitForGate } from "./maintenance-gate-core.mjs";

const SELF = moduleRoot(import.meta.url, "..");
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

/**
 * 续期的**锁内段**（PK2-I2-fix2 P1 + fix3 P1，可导入、CLI 只传生产实现）：
 * 取 outer m1a-order 锁 → 锁内重定位（resolveExpiryTarget）→ 重读现值 → 重读账本 → 派生 lineage
 * 与全部 live id → 一次 sidecar 事务写入 → **finally 释放并折叠释放状态**（I4-fix3 同款单出口工艺：
 * 任何失败都存成结果对象返回，绝不 process.exit 绕过 finally 留锁）。
 * `hook` 仅测试注入（CLI 不可触达；生产恒缺省 = 空操作）：在「锁已到手、重定位之前」调用，
 *   钉「锁外盘点」与「锁内重读」之间的并发窗口（W2 新建/作废 pending B1）。
 * 返回 {ok:true, lineageId, ids, changed} 或 {ok:false, stage, reason, why?, lock_state, lockUncleared?}。
 */
export function renewExpiryInLock({ endpointId, locator, iso, env = process.env, hook = null } = {}) {
  const acq = acquireOrderLock(endpointId, env);
  if (!acq.ok) {
    return { ok: false, stage: "lock", reason: acq.reason ?? "lock_failed",
      why: "取 m1a-order 锁失败（" + String(acq.reason ?? "unknown") + "）：不写（与 W1/W2 同一把锁串行）", lock_state: null };
  }
  let rel = null;
  let result = null;
  try {
    if (typeof hook === "function") hook();
    const targetNow = resolveExpiryTarget({ endpointId, locator, env });
    if (targetNow?.ok !== true) {
      result = { ok: false, stage: "relocate", reason: targetNow?.reason ?? "unknown",
        why: "锁内重定位不到账本里的这条记录（" + String(targetNow?.reason ?? "unknown") + "）：不写" };
    } else {
      const curNow = readExpiryEntry({ endpointId, topicAgentId: targetNow.topicAgentId, env });
      if (curNow.ok !== true) {
        result = { ok: false, stage: "reread", reason: curNow.reason ?? "unknown",
          why: "锁内重读权威到期现值读不出（" + String(curNow.reason ?? "unknown") + (curNow.why ? "：" + curNow.why : "") + "）：不写" };
      } else {
        const led = loadByEndpoint(endpointId, { env });
        if (!led.ok) {
          result = { ok: false, stage: "ledger", reason: led.reason ?? "unknown", why: "锁内重读账本读不出（" + String(led.reason ?? "unknown") + "）：不写" };
        } else {
          const lineageId = led.doc?.records?.[targetNow.topicAgentId]?.generation_lineage_id ?? null;
          const lin = typeof lineageId === "string"
            ? liveLineageIds({ endpointId, lineageId, loadLedger: loadByEndpoint, env })
            : { ok: false, reason: "no_lineage", why: "这条记录没有 generation_lineage_id" };
          if (!lin.ok) {
            result = { ok: false, stage: "lineage", reason: lin.reason ?? "unknown",
              why: "续期的覆盖范围说不清（" + String(lin.reason ?? "unknown") + (lin.why ? "：" + lin.why : "") + "）：不写" };
          } else {
            const values = Object.fromEntries(lin.ids.map((id) => [id, iso]));
            const w = mutateExpiryEntries({ endpointId, values, env });
            result = w.ok === true
              ? { ok: true, lineageId, ids: lin.ids, changed: w.changed === true }
              : { ok: false, stage: "write", reason: w.reason ?? "unknown",
                  why: "权威到期没写成（" + String(w.reason ?? "unknown") + (w.why ? "：" + w.why : "") + "）" + (w.committed === true ? " —— 已落盘但不干净，先 doctor" : ""),
                  committed: w.committed === true };
          }
        }
      }
    }
  } catch (err) {
    // PK2-I2-fix4 P1：hook / 锁内调用抛异常 → 结构化 renew_expiry_threw，统一经 finally →
    //   foldLockReleaseState → return；不许原异常裸穿把 lockUncleared 证据遮掉。
    result = { ok: false, stage: "threw", reason: "renew_expiry_threw",
      why: "锁内段抛异常（" + String(err?.code ?? err?.message ?? err) + "）：不写；锁已按 finally 释放折叠" };
  } finally {
    try { rel = acq.release(); } catch (err) { rel = { ok: false, reason: "release_threw", error: String(err?.code ?? err?.message ?? err) }; }
  }
  const lockState = foldLockReleaseState(rel);
  return { ...result, lock_state: lockState,
    ...(lockState !== "released" ? { lockUncleared: { lock_state: lockState, path: rel?.path ?? null, reason: rel?.reason ?? null, why: rel?.why ?? null } } : {}) };
}

if (!isDirectRun(import.meta.url)) {
  // 被 import 时只提供上面那个纯函数，不碰任何文件。
} else {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");
if (apply) { const gate = gateBlocks(); if (gate.blocked) exitForGate("cli", gate); } // 维护门（issue #81）：窗口内不改任何桥状态

// 绑定现在有两种住处：老项目在自己目录里，新接入的只在登记表里占一行。
// 两边都要能看、能续 —— 到期预警的文案指向的就是这条命令，它必须对两种都有效。
const ROOT = path.resolve(arg("project") ?? SELF);
const resolved = resolveProject({ root: ROOT });
if (!resolved.ok) {
  console.error("这个项目没有绑定：" + ROOT + "（" + resolved.reason + "）");
  if (resolved.reason === "not_bound") console.error("接入：node scripts/bind-project.mjs --project " + ROOT + " --apply");
  process.exit(1);
}
const mapping = resolved.mapping;
const FROM_REGISTRY = resolved.source === "registry";
const STORE = FROM_REGISTRY ? registryPath() : projectMappingPath(ROOT);

// PK2-I2：**续期的落点随判源换书**。authoritative → 权威 `ledger/<ep>/expiry.json`（不再碰 registry/mapping）；
//   其余（legacy / shadow / 未接入）→ 原逻辑（registry 那一行或项目 mapping 文件）。
//   判源不明（收据坏 / 维护目录读不出）→ 未知态：**不写**（fail-closed），下面按错误报。
const tplForLedger = loadChainTemplate();
const endpointForLedger = tplForLedger.ok && tplForLedger.template?.agent_uid
  ? legacyEndpointId({ runtime: "claude", agentUid: tplForLedger.template.agent_uid }) : null;
// P1-2：判源与 I1/R66 **同一份矩阵**（收据 × 账本 authority_mode）——只看收据会把"收据说 cutover、
//   账本其实还是 shadow"这类交叉不符放过去，而那条路上 legacy 已经不该再被写。
const routeReceipt = (() => {
  const dir = maintenanceDir(process.env);
  return (typeof dir === "string" && dir.length > 0 && endpointForLedger !== null)
    ? endpointReceipt(dir, endpointForLedger) : { ok: false, state: "unreadable", why: "维护目录不可派生 / 端点未知" };
})();
const routeMode = endpointForLedger === null ? "reject"
  : decideLedgerRoute({ receipt: routeReceipt, endpointId: endpointForLedger, env: process.env }).mode;
const AUTHORITATIVE = routeMode === "authoritative";
// reject / unknown：**零写退出**，绝不落回 legacy（切后写 legacy 就是把事实写进已被冻结的那本书）。
if (routeMode === "reject") {
  console.error("到期判源不可用（收据 × 账本 authority_mode 交叉核不过）：**不写任何东西**，先核对维护收据与账本。");
  console.error("  （PK2-I2-fix1 P1-2：切权威后不再回退 legacy —— 那是把事实写进已被冻结的那本书。）");
  process.exit(1);
}
// 权威落点：按这条绑定的根消息（代际优先）定位账本 live 记录 → topic_agent_id。
const expiryLocator = typeof mapping.feishu_root_message_id_reference === "string" && mapping.feishu_root_message_id_reference.length > 0
  ? mapping.feishu_root_message_id_reference : null;
const expiryTarget = (() => {
  if (!AUTHORITATIVE) return null;
  if (expiryLocator === null) return { ok: false, reason: "no_locator", why: "这条绑定没有根消息 locator，定位不到账本记录" };
  return resolveExpiryTarget({ endpointId: endpointForLedger, locator: expiryLocator, env: process.env });
})();

const now = Date.now();
const health = checkBinding({ root: ROOT, now });
// 权威现值（只读）：authoritative 下这条命令改的就是它，报告要显示它而不是冻结的 legacy 值。
const authoritativeEntry = AUTHORITATIVE && expiryTarget?.ok === true
  ? readExpiryEntry({ endpointId: endpointForLedger, topicAgentId: expiryTarget.topicAgentId, env: process.env })
  : null;

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

console.log("项目    " + ROOT);
console.log("绑定    " + (mapping.binding_id ?? "(无 id)") + "   存放在 " + (FROM_REGISTRY ? "登记表" : "项目目录"));
console.log("状态    " + (mapping.status ?? "?") + " / " + (STATE_TEXT[health.state] ?? health.state));
console.log("有效期  " + (mapping.expires_at ?? "(缺)") +
  (daysLeft === null ? "" : "   还有 " + daysLeft + " 天") +
  (AUTHORITATIVE ? "   （legacy 值已冻结，仅供参考）" : ""));
if (AUTHORITATIVE) {
  const iso = authoritativeEntry?.ok === true ? authoritativeEntry.iso : null;
  const days = iso === null ? null : Math.floor((Date.parse(iso) - now) / DAY_MS);
  console.log("权威到期  " + (authoritativeEntry?.ok === true ? (iso ?? "(未设 —— 不过期)") : "读不出（" + String(authoritativeEntry?.why ?? "unknown") + "）") +
    (days === null || iso === null ? "" : "   还有 " + days + " 天") +
    "   存放在 ledger/<endpoint>/expiry.json");
}
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

// PK2-I2：authoritative 下**只写权威 expiry.json** —— 冻结的 legacy（登记表 / 项目 mapping）一个字节都不碰，
//   也就不留 .prev（它是 legacy 文件的备份，这里没有可回退的那一份）。除 expires_at 之外的字段在
//   authoritative 下**没有权威落点**（quota / prefix / note 仍是 legacy 面）：明说拒，不悄悄写冻结文件。
if (AUTHORITATIVE) {
  const unsupported = changes.filter(([f]) => f !== "expires_at").map(([f]) => f);
  if (unsupported.length > 0) {
    console.error("权威（authoritative）下这些字段没有权威落点：" + unsupported.join(", "));
    console.error("本命令在权威期只改 expires_at（写 ledger/<endpoint>/expiry.json）；其余字段仍只在 legacy 面。");
    process.exit(1);
  }
  if (expiryTarget?.ok !== true) {
    console.error("定位不到账本里的这条记录（" + String(expiryTarget?.reason ?? "unknown") + "）：不写，先核对账本");
    process.exit(1);
  }
  const iso = changes.find(([f]) => f === "expires_at")[2];
  // P1-1：**缺条目 ≠ 没设到期** —— 续期遇缺条目（或文件缺席/读不出）一律拒零写，不凭缺席建事实。
  const curAuth = readExpiryEntry({ endpointId: endpointForLedger, topicAgentId: expiryTarget.topicAgentId, env: process.env });
  if (curAuth.ok !== true) {
    console.error("权威到期现值读不出（" + String(curAuth.reason ?? "unknown") + (curAuth.why ? "：" + curAuth.why : "") + "）：**不写**。");
    console.error("  （PK2-I2-fix1 P1-1：缺席 / 缺条目不是「没设到期」，是缺失的授权事实 —— 先核对现场。）");
    process.exit(1);
  }
  // P1-3：续期覆盖**整条 lineage**（current + 历史 B4 …）——一次 sidecar 事务、经 outer m1a-order 锁串行。
  // PK2-I2-fix2 P1：**写集合在锁内重新派生** —— 锁外读数只做预览/文案。锁内段抽成可导入的
  //   `renewExpiryInLock`（PK2-I2-fix3 P1-①：env 注入面已移除，测试走 CLI 不可触达的函数参数 hook）。
  const res = renewExpiryInLock({ endpointId: endpointForLedger, locator: expiryLocator, iso, env: process.env });
  if (res.lockUncleared) {
    console.error("outer 锁没交还干净（" + res.lockUncleared.lock_state + "）：先 doctor 再重跑（写已提交的话是幂等的）。");
    process.exit(1);
  }
  if (res.ok !== true) {
    console.error(res.why ?? "权威到期没写成（" + String(res.reason ?? "unknown") + "）。");
    process.exit(1);
  }
  const afterAuth = readExpiryEntry({ endpointId: endpointForLedger, topicAgentId: expiryTarget.topicAgentId, env: process.env });
  console.log("\n已写入 ledger/<endpoint>/expiry.json（lineage " + String(res.lineageId) + " 共 " + res.ids.length + " 条 live B：" +
    res.ids.map((id) => id.slice(0, 12) + "…").join("、") + "，" + (res.changed ? "已更新" : "本就是这个值") + "）");
  console.log("现在权威到期：" + (afterAuth.ok === true ? String(afterAuth.iso) : "读回失败"));
  console.log("legacy 的 expires_at 一个字没动（切权威后它已冻结；入站按权威这份判）。");
  process.exit(0);
}

// 留一份上一版：改错了能立刻退回去，不用去翻别的地方。
fs.copyFileSync(STORE, STORE + ".prev");

const writeAtomic = (file, obj) => {
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
};

if (FROM_REGISTRY) {
  // 登记表里那一行只存少数几个字段，改动要按名字映射回去 ——
  // 这里刻意只认显式列出的几个，别的字段（比如 inbound_prefix）在登记表形式下没有落脚处，
  // 与其悄悄写进一个没人读的键，不如明说不支持。
  const TO_ENTRY = { expires_at: "expires_at", status: "status", note: "note" };
  const unsupported = changes.filter(([f]) => !TO_ENTRY[f]).map(([f]) => f);
  if (unsupported.length) {
    console.error("登记表形式的绑定不支持改这些字段：" + unsupported.join(", "));
    console.error("（它们只在项目目录形式的 mapping 里有落脚处）");
    process.exit(1);
  }
  const reg = JSON.parse(fs.readFileSync(STORE, "utf-8"));
  const entry = (reg.projects ?? []).find((p) => p?.root === ROOT);
  if (!entry) {
    console.error("登记表里找不到 " + ROOT + " —— 它可能刚被别的进程改过，重跑一次看看。");
    process.exit(1);
  }
  for (const [field, , after] of changes) entry[TO_ENTRY[field]] = after;
  writeAtomic(STORE, reg);
} else {
  for (const [field, , after] of changes) mapping[field] = after;
  writeAtomic(STORE, mapping);
}

const after = checkBinding({ root: ROOT, now });
console.log("\n已写入 " + STORE);
console.log("现在状态：" + (STATE_TEXT[after.state] ?? after.state));
console.log("上一版留在 " + path.basename(STORE) + ".prev");
console.log("入站立即生效 —— 每条消息都是现读，不缓存。");

}
