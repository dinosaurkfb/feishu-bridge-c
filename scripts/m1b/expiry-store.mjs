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
 *   · **缺条目 = 这份绑定没设到期**（不是故障）：入站按「不过期」处理，不拒。
 *   · store 读不出（父目录权限 / 坏 JSON / schema 不过 / 非普通文件）→ `{ok:false}`，调用方 fail-closed，
 *     **不回退 legacy**（切权威后 legacy 的 expires_at 已冻结）。
 */
import { mutateSidecarEntry, readSidecarStore } from "./sidecar-store.mjs";
import { resolveLiveId } from "../topic-agent-ledger.mjs";

export const EXPIRY_NAME = "expiry";

/** locator（root_om / session）→ 账本 live 记录的 topic_agent_id。解析器只有账本层那一份。 */
export function resolveExpiryTarget({ endpointId, locator, env = process.env } = {}) {
  const r = resolveLiveId({ endpointId, locator, env });
  return r.ok === true ? { ok: true, topicAgentId: r.id } : { ok: false, reason: r.reason, why: r.why ?? null };
}

/** 读一条到期条目：`{ok:true, present, iso}`；present:false = 没设到期（调用方按「不过期」处理）。 */
export function readExpiryEntry({ endpointId, topicAgentId, env = process.env } = {}) {
  const s = readSidecarStore({ endpointId, name: EXPIRY_NAME, env });
  if (s.ok !== true) return { ok: false, reason: "expiry_store_unreadable", why: String(s.why ?? s.reason ?? "unknown") };
  if (s.absent === true) return { ok: true, present: false, iso: null };
  const has = Object.prototype.hasOwnProperty.call(s.entries ?? {}, topicAgentId);
  return { ok: true, present: has, iso: has ? s.entries[topicAgentId] : null };
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
