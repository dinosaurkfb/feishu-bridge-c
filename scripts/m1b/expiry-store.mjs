/**
 * 绑定到期（expiry）的**薄壳**（PK2-I2）—— 存储原语全在 `sidecar-store.mjs`（`name:"expiry"`）：
 * 锁内读-改-校验-原子写、fsync 失败即失败、释放折叠那一套已经在 W1 闭合，这里**不新建第二套 store/锁/schema**，
 * 只加两件领域事：① 按 locator 定位账本 live 记录（复用账本层的 `resolveLiveId`，不另写解析）；
 * ② 按 `topic_agent_id` 读/写一条到期条目。
 *
 * 条目形状由 renderer 定：`expiry-1`，`entries:{ <topic_agent_id>: <规范化 ISO> }`；键是**账本 live 记录**的
 * topic_agent_id（不是 registry id）—— 与 cutover 时固化那一份同源。
 *
 * 语义要点（写进合同，读侧按它判）：
 *   · **缺席（文件不在）/ 缺条目 = 缺失的授权事实，不是「没设到期」**（PK2-I2-fix1 P1-1）：cutover renderer
 *     要求每条 live B 都有项、W1 必写条目 —— 两条都缺席说明现场坏了。一律 `{ok:false}`，调用方 fail-closed
 *     拒收（`ledger_route_unavailable`），**绝不解释成无限放行**。要「永不过期」必须显式给值，不能用缺席表达。
 *   · store 读不出（父目录权限 / 坏 JSON / schema 不过 / 非普通文件）→ `{ok:false}`，调用方 fail-closed，
 *     **不回退 legacy**（切权威后 legacy 的 expires_at 已冻结）。
 */
import { mutateSidecarEntry, mutateSidecarEntries, readSidecarStore } from "./sidecar-store.mjs";
import { resolveLiveId } from "../topic-agent-ledger.mjs";

export const EXPIRY_NAME = "expiry";

/** locator（root_om / session）→ 账本 live 记录的 topic_agent_id。解析器只有账本层那一份。 */
export function resolveExpiryTarget({ endpointId, locator, env = process.env } = {}) {
  const r = resolveLiveId({ endpointId, locator, env });
  return r.ok === true ? { ok: true, topicAgentId: r.id } : { ok: false, reason: r.reason, why: r.why ?? null };
}

/** 读一条到期条目：`{ok:true, iso}`（iso = 规范化 ISO 串）。
 *  **缺席 / 缺条目 → `{ok:false}`**（P1-1：缺失授权事实 ≠ 永不过期；调用方按 fail-closed 拒收）。 */
export function readExpiryEntry({ endpointId, topicAgentId, env = process.env } = {}) {
  const s = readSidecarStore({ endpointId, name: EXPIRY_NAME, env });
  if (s.ok !== true) return { ok: false, reason: "expiry_store_unreadable", why: String(s.why ?? s.reason ?? "unknown") };
  if (s.absent === true) {
    return { ok: false, absent: true, reason: "expiry_store_absent",
      why: "expiry.json 缺席（cutover 之后不该缺）：缺失的授权事实不许当「没设到期」" };
  }
  if (!Object.prototype.hasOwnProperty.call(s.entries ?? {}, topicAgentId)) {
    return { ok: false, absent: true, reason: "expiry_entry_absent",
      why: "expiry.json 里没有这条 live B 的条目（cutover renderer 要求每条 live B 都有项）：缺失的授权事实不许当「没设到期」" };
  }
  return { ok: true, iso: s.entries[topicAgentId] };
}

/** 列该 lineage 全部 live B 的 topic_agent_id（续期的覆盖范围 = 整条 lineage，P1-3）。 */
export function liveLineageIds({ endpointId, lineageId, loadLedger, env = process.env } = {}) {
  // loadLedger 的签名与账本层 `loadByEndpoint(endpointId, {env})` 逐字同形（位置参数 + 选项对象）
  const l = loadLedger(endpointId, { env });
  if (l.ok !== true) return { ok: false, reason: "ledger_route_unavailable", why: "账本读不出（" + String(l.reason ?? "unknown") + "）" };
  const ids = Object.entries(l.doc?.records ?? {})
    .filter(([, r]) => r?.kind === "live" && r.generation_lineage_id === lineageId)
    .map(([id]) => id).sort();
  return ids.length === 0 ? { ok: false, reason: "lineage_empty", why: "该 lineage 没有 live 记录（" + String(lineageId) + "）" } : { ok: true, ids };
}

/**
 * 一次事务覆盖**多条**条目（P1-3：续期要盖整条 lineage）。`values` 里 `null` = 删该条目。
 * 走的是 `sidecar-store.mjs` 的多条目写法（同一把 `<file>.lock`、同一份 schema、同一份原子写），
 * 不新建第二套锁。
 */
export function mutateExpiryEntries({ endpointId, values = {}, env = process.env } = {}) {
  const r = mutateSidecarEntries({ endpointId, name: EXPIRY_NAME, values, env });
  if (r.ok !== true) {
    return { ok: false, reason: r.reason ?? "expiry_store_write_failed", why: r.why ?? null,
      committed: r.committed === true, lockUncleared: r.lockUncleared ?? null };
  }
  return { ok: true, changed: r.changed === true, entries: r.entries ?? {} };
}

/**
 * 改一条到期条目（`value:null` → 删条目，原语已支持）。写失败/读回不符/释放不干净都如实带出：
 * `{ok:false, reason, why, committed, lockUncleared}` —— 调用方不许把它当成功。
 */
export function mutateExpiryEntry({ endpointId, topicAgentId, env = process.env, mutate } = {}) {
  const r = mutateSidecarEntry({ endpointId, name: EXPIRY_NAME, key: topicAgentId, env, mutate });
  if (r.ok !== true) {
    return { ok: false, reason: r.reason ?? "expiry_store_write_failed", why: r.why ?? null,
      committed: r.committed === true, lockUncleared: r.lockUncleared ?? null };
  }
  const entries = r.entries ?? {};
  return { ok: true, changed: r.changed === true,
    iso: Object.prototype.hasOwnProperty.call(entries, topicAgentId) ? entries[topicAgentId] : null };
}
