/**
 * PK2-I1：authoritative 侧 interaction policy 的 v2 store（`ledger/<endpoint_id>/policy.json`）—— 领域薄壳。
 *
 * 设计 `m1a-reconciliation.md` §4 ③：authoritative → 只读写 v2 policy store，legacy 的 registry /
 * active-mapping 策略字段冻结。**存储原语、symlink 锁、fenced 提交、写后受验读回、目录 fsync 的诚实
 * 折叠、大小上限、tmp 残骸外显、逐条目 ipsp-1 与「派生自洽」**全在 `policy-store/store.mjs`
 * （#R31–#R41；锁 = 同目录 `policy.json.lock`，与写这份文件的 sidecar-writer 同一把）——
 * 本模块**不写第二套 schema / 锁 / 序列化**，只钉三件领域事实：
 *
 *   ① **subject 由受验账本记录解析**（§4③）：live 记录里 `generation_lineage_id` 非空 → kind:"lineage"、
 *      id = 该 lineage；没有（非谱系 A 记录、unbind 之后的记录）→ kind:"topic_agent"、id = 自身
 *      topic_agent_id。调用方给的「哪个 binding」只用来**按 root_om 定位 live 记录**，不作 subject 来源。
 *   ② 整域 kinds 声明 = 该 endpoint 当前 live 记录派生的 subject 集合（store 层仍逐条目核
 *      「声明 kind 与 entry.binding_id 派生出的挂载键一致」；集合外的条目 = 错挂 → 整档读不出）。
 *   ③ 缺条目 → renderer 同款默认条目（`mappingDefaultEntry`，sidecar-renderers 同一出处）。
 *
 * 读纪律（fail-closed）：读不出 / 权限不对 / 坏 JSON / 超限 / 错挂一律拒，绝不折成空；缺席如实带出
 * —— cutover 后 policy.json 不应缺席，接线层按 unreadable 同等处置。
 * 写纪律：**锁内**重读身份（P1-4：legacy 索引行只在锁外用来定位话题，身份在锁内重解析）+ 重读 store，
 * 缺席不新建；写成立而目录 fsync 未证实（`persistence:"uncertain"`）= **不干净**（不是 ok）；释放不干净
 * 一律折 `lockUncleared` 并把 ok 降级（不谎报 clean）。
 */
import fs from "node:fs";
import path from "node:path";

import { loadByEndpoint, resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { loadPolicyStore, mutatePolicyStore, policySubjectId } from "../policy-store/store.mjs";
import { mappingDefaultEntry, readSidecarFile, validateSidecarDoc } from "./sidecar-renderers.mjs";

export const POLICY_STORE_FILE = "policy.json";
export const POLICY_STORE_LOCK_NAME = POLICY_STORE_FILE + ".lock"; // 与 sidecar-writer / store.mjs 同一把
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

/** 记录 → subject 派生输入（§4③ 两分支）。返回 null = 记录连自身 id 都缺（合法账本不该出现）。 */
export function policyKindOf(record) {
  const lineage = record?.generation_lineage_id;
  if (typeof lineage === "string" && lineage.length > 0) return { kind: "lineage", id: lineage };
  const own = record?.topic_agent_id;
  if (typeof own === "string" && own.length > 0) return { kind: "topic_agent", id: own };
  return null;
}

/** 一条 live 记录 → 它的 subject（派生失败 → null，调用方按「不可解析」处置）。 */
function subjectOfRecord(record, endpointId) {
  const k = policyKindOf(record);
  if (k === null) return null;
  try {
    return { subjectId: policySubjectId({ kind: k.kind, endpointId, id: k.id }), kind: k.kind, id: k.id, record };
  } catch { return null; }
}

/**
 * 账本现场 → `{ kinds, subjects, byRootOm, records }`：
 *   · `kinds` 整域声明（喂 store 层的逐条目派生自洽核验）；
 *   · `subjects` = `Map<subjectId, {kind,id,topicAgentId,record}>` —— **按 `{kind,id}` 去重**：
 *     同一条 lineage 下多代际 live 记录（B3 current + B4 历史代际 + 轮转中的 B1）是**合法常态**
 *     （真机 B4×11 / B3×2 / B1×1），renderer 也按同 subject 等值去重（PK2-I1-fix2 P1）；
 *   · `byRootOm` = `Map<rootOm, [{subjectId, kind, id, topicAgentId, record}]>` —— **逐记录**索引
 *     （不去重）：查询时“恰命中一条 live 记录”才是完整判据；
 *   · `records` 参与派生的 live 记录数（诊断用）。
 * 账本读不出 / 有 live 记录派不出 subject / 同一个 subject 由**不同** `{kind,id}` 派生（哈希撞或
 * 账本自相矛盾）→ fail-closed。
 */
export function livePolicySubjects({ endpointId, env = process.env } = {}) {
  const L = loadByEndpoint(endpointId, { env });
  if (!L.ok) return { ok: false, reason: "policy_store_ledger_unreadable", why: L.why ?? L.reason ?? "账本读不出" };
  const kinds = {};
  const subjects = new Map();
  const byRootOm = new Map();
  let liveCount = 0;
  for (const rec of Object.values(L.doc.records ?? {})) {
    if (rec?.kind !== "live") continue;
    liveCount += 1;
    const s = subjectOfRecord(rec, endpointId);
    if (s === null) {
      return { ok: false, reason: "policy_store_subject_unresolved", why: "live 记录 " + String(rec.topic_agent_id ?? "?") + " 派生不出 policy subject" };
    }
    const prev = subjects.get(s.subjectId);
    if (prev === undefined) {
      kinds[s.subjectId] = s.kind;
      subjects.set(s.subjectId, { kind: s.kind, id: s.id, topicAgentId: rec.topic_agent_id ?? null, record: s.record });
    } else if (prev.kind !== s.kind || prev.id !== s.id) {
      // 同一把键却来自不同 {kind,id} —— 这不是“多代际”，是自相矛盾（或哈希撞），不猜。
      return { ok: false, reason: "policy_store_subject_conflict", why: "同一个 subject 由不同 {kind,id} 派生：" + s.subjectId };
    }
    const om = rec.aliases?.root_om;
    if (typeof om === "string" && om.length > 0) {
      const hit = { subjectId: s.subjectId, kind: s.kind, id: s.id, topicAgentId: rec.topic_agent_id ?? null, record: rec };
      const list = byRootOm.get(om);
      if (list === undefined) byRootOm.set(om, [hit]);
      else list.push(hit);
    }
  }
  return { ok: true, doc: L.doc, kinds, subjects, byRootOm, records: liveCount };
}

/**
 * 按 `root_om` 在账本里定位 live 记录 → 解析出 subject（主入口）。
 * 判据：`root_om` **恰命中一条** live 记录（同一条 lineage 的多代际各有各的 root_om，不冲突）；
 * 零条 → `policy_store_subject_unresolved`；多条 → `policy_store_subject_conflict`（真冲突）。
 */
export function resolvePolicySubject({ endpointId, rootOm, env = process.env } = {}) {
  if (typeof rootOm !== "string" || rootOm.length === 0) {
    return { ok: false, reason: "policy_store_subject_unresolved", why: "root_om 缺失，无法在账本里定位 live 记录" };
  }
  const live = livePolicySubjects({ endpointId, env });
  if (!live.ok) return live;
  const hits = live.byRootOm.get(rootOm) ?? [];
  if (hits.length === 0) return { ok: false, reason: "policy_store_subject_unresolved", why: "账本里没有 root_om=" + rootOm + " 的 live 记录" };
  if (hits.length > 1) return { ok: false, reason: "policy_store_subject_conflict", why: "root_om 命中 " + hits.length + " 条 live 记录" };
  const hit = hits[0];
  return { ok: true, subjectId: hit.subjectId, kind: hit.kind, id: hit.id, topicAgentId: hit.topicAgentId, record: hit.record, rootOm, kinds: live.kinds, ledger: live.doc };
}

/**
 * 受验读整份 store。kinds 声明默认取「当前 live 记录派生的 subject 集合」（P1-4/P1-5 同一判据）；
 * 返回值形状沿用接线层的契约：`{ok:true, absent:true, entries:{}}` / `{ok:true, entries, raw}` /
 * `{ok:false, reason:"policy_store_unreadable", why}`（**任何**读不出都折成这一个拒因，细节进 why）。
 */
export function readPolicyStore({ endpointId, kinds = null, env = process.env } = {}) {
  let k = kinds;
  if (k === null) {
    const live = livePolicySubjects({ endpointId, env });
    if (!live.ok) return { ok: false, reason: "policy_store_unreadable", why: live.reason + "：" + String(live.why ?? "") };
    k = live.kinds;
  }
  const r = loadPolicyStore({ endpointId, kinds: k, env });
  if (r.ok) return r;
  return { ok: false, reason: "policy_store_unreadable", why: r.reason + (r.why ?? r.detail ? "：" + String(r.why ?? r.detail) : "") };
}

/**
 * doctor ⑱ 专用：**逐条目**视图 —— 不做整档 kinds 门（那会把「错挂的那一条」淹成「整档读不出」，
 * 而 doctor 要点名的正是那一条）。只过 sidecar schema（psid 形状 / ipsp-1 / 512 上限 / binding 查重）。
 * 接线层的读写面仍走 `readPolicyStore`（严格）。
 */
export function readPolicyStoreForAudit({ endpointId, env = process.env } = {}) {
  const d = resolveEndpointDir(endpointId, { env, mustExistRoot: false });
  if (!d.ok) return { ok: false, reason: "policy_store_unreadable", why: d.why ?? d.reason };
  const p = { ok: true, file: path.join(d.dir, POLICY_STORE_FILE) };
  let exists = true;
  try { fs.lstatSync(p.file); } catch (err) {
    if (err?.code === "ENOENT") exists = false;
    else return { ok: false, reason: "policy_store_unreadable", why: "lstat：" + String(err?.code ?? err?.message ?? err) };
  }
  if (!exists) return { ok: true, absent: true, entries: {} };
  const r = readSidecarFile({ file: p.file, endpointId, name: "policy" });
  if (!r.ok) return { ok: false, reason: "policy_store_unreadable", why: r.why ?? r.reason };
  const invalid = validateSidecarDoc(r.doc, "policy", { endpointId });
  if (invalid !== null) return { ok: false, reason: "policy_store_invalid", why: invalid };
  return { ok: true, absent: false, entries: r.doc.entries, doc: r.doc };
}

/** 单条目读取 + P1-4 交叉核验：条目必须**挂在自己的 subject 下** ——
 * `entry.binding_id` 就是该 subject 的派生输入，用它重新派生一次必须等于这个键。
 * 缺条目 → renderer 同款默认条目（binding_id 取派生输入）；错挂 → 拒（`policy_store_subject_mismatch`）。 */
export function policyEntryFor({ entries, subjectId, kind, id, endpointId } = {}) {
  const expect = typeof id === "string" && id.length > 0 ? id : null;
  const present = entries !== null && typeof entries === "object" ? entries[subjectId] : undefined;
  if (present === undefined) {
    if (expect === null) return { ok: false, reason: "policy_store_subject_unresolved", why: "store 里没有该 subject 且拿不到派生输入，合成不出默认条目" };
    return { ok: true, entry: mappingDefaultEntry(expect), synthesized: true, bindingId: expect };
  }
  const bid = present !== null && typeof present === "object" ? present.binding_id : null;
  let derived = null;
  try { derived = typeof bid === "string" ? policySubjectId({ kind, endpointId, id: bid }) : null; } catch { derived = null; }
  if (bid === null || bid !== expect || derived !== subjectId) {
    return {
      ok: false, reason: "policy_store_subject_mismatch",
      why: "条目挂错 subject（键 " + String(subjectId) + "，entry.binding_id=" + String(bid) + " 派生 " + String(derived ?? "非法") + "）",
    };
  }
  return { ok: true, entry: present, synthesized: false, bindingId: bid };
}

/** R31 写侧的「写前校验」拒因 → 接线层契约的 `policy_store_invalid`（细节进 why，不丢）。 */
const INVALID_WRITE_REASONS = new Set([
  "policy_entry_invalid", "policy_store_bad_subject", "policy_store_root_schema",
  "policy_store_too_many_entries", "policy_store_parse_failed", "policy_store_mutate_invalid",
]);

/**
 * 锁内事务式改写**单条目**（唯一写入口）。
 *
 * `identity()` 在 **policy 锁内**调用（P1-4：「锁内 mapping」必须在取 policy 锁**之后**重读）：
 * 返回 `{ok:true, subjectId, kind, id, …}`（id = 派生输入 = 条目 binding_id），失败原样透传。
 * `mutate(state, meta)` 与 `mutateClaudeInteractionPolicy` 同一返回联合（`{ok, changed, state}`）。
 * `lockRetries`：锁被占时按 25ms 退避重试（与 legacy 写路径同语义；重试会把 identity/store 整体重来）。
 *
 * 返回 union：`{ok:true, changed, committed, persistence, state, subjectId, kind}`；拒 →
 * `{ok:false, reason, why?}`。**目录 fsync 未证实**（`persistence:"uncertain"`）→
 * `policy_store_durability_uncertain`（不是 ok）；释放不干净 → `lockUncleared` 折进返回并把 ok 降级为
 * `policy_store_lock_release_failed`。busy / maintenance / 提交与读回残骸原样透传。
 */
export function mutatePolicyEntry({ endpointId, env = process.env, identity, mutate, lockRetries = 0 } = {}) {
  if (typeof identity !== "function" || typeof mutate !== "function") {
    return { ok: false, reason: "policy_store_invalid", why: "identity/mutate 必须是函数" };
  }
  // kinds 必须先于取锁算出来（store 的读走它）——它只来自账本，不来自被写的那份文件。
  const live = livePolicySubjects({ endpointId, env });
  if (!live.ok) return { ok: false, reason: "policy_store_unreadable", why: live.reason + "：" + String(live.why ?? "") };
  // 「读不出」由**读**来定性（权限/坏 JSON/超限/缺席都是同一件事：这份 store 现在不可用），
  //   不给写路径留一套自己的读失败命名；锁内那次重读才是真正决定写不写的（这里的预检只是为了
  //   把拒因说成读因，不是替代锁内重读）。
  const pre = readPolicyStore({ endpointId, kinds: live.kinds, env });
  if (!pre.ok) return { ok: false, reason: "policy_store_unreadable", why: pre.why };
  const attempt = () => {
    let ident = null;
    let written = null;
    const r = mutatePolicyStore({
      endpointId, kinds: live.kinds, env,
      mutate: (entries) => {
        // ── 以下全在 policy 锁内 ──────────────────────────────────────────────
        // ① 身份重读（P1-4）：legacy 索引行 + 账本都重读一遍，subject 只从账本记录解析。
        const got = identity();
        if (!got || got.ok !== true) return got ?? { ok: false, reason: "policy_store_subject_unresolved" };
        ident = got;
        if (live.kinds[got.subjectId] === undefined) {
          return { ok: false, reason: "policy_store_subject_undeclared",
            why: "该 subject 不属于账本 live 记录派生的集合（取锁前后账本变过？）：" + String(got.subjectId) };
        }
        // ② store 重读（锁内那份才是现场）：缺席 = 故障，**不新建**。
        const cur = readPolicyStore({ endpointId, kinds: live.kinds, env });
        if (!cur.ok) return { ok: false, reason: "policy_store_unreadable", why: cur.why };
        if (cur.absent) return { ok: false, reason: "policy_store_unreadable", why: "policy.json 缺席（cutover 之后不应缺席，不新建）" };
        // ③ 取条目（含 P1-4 的错挂核验；缺 → renderer 同款默认条目）+ 单条目 mutate。
        const picked = policyEntryFor({ entries: cur.entries, subjectId: got.subjectId, kind: got.kind, id: got.id, endpointId });
        if (!picked.ok) return picked;
        const changed = mutate(picked.entry, {
          source: "policy-store", subjectId: got.subjectId, kind: got.kind, bindingId: got.id,
          endpointId, synthesized: picked.synthesized,
          mapping: got.mapping ?? null, record: got.record ?? null,
        });
        if (!changed || typeof changed !== "object" || changed.ok !== true) {
          return changed && typeof changed === "object" && changed.ok === false
            ? changed
            : { ok: false, reason: "policy_store_invalid", why: "mutate 必须返回 {ok:true, changed?, state} 或 {ok:false, reason}" };
        }
        if (changed.changed === false) return { ok: true, entries: cur.entries, changed: false };
        if (!("state" in changed)) return { ok: false, reason: "policy_store_invalid", why: "changed:true 必须带 state" };
        // ④ 交叉不变量（与 renderer 同一条，P1-4）：条目 binding_id 必须等于派生输入。
        if (changed.state === null || typeof changed.state !== "object" || changed.state.binding_id !== got.id) {
          return { ok: false, reason: "policy_store_invalid", why: "条目 binding_id 与 subject 派生输入不一致" };
        }
        written = changed.state;
        return { ok: true, entries: { ...cur.entries, [got.subjectId]: changed.state }, changed: true };
      },
    });
    return { r, ident, written };
  };

  let out = null;
  for (let i = 0; i <= Math.max(0, lockRetries); i += 1) {
    out = attempt();
    if (out.r.ok || out.r.reason !== "policy_store_busy") break;
    if (i < lockRetries) Atomics.wait(LOCK_WAIT, 0, 0, 25);
  }
  const { r, ident, written } = out;
  const base = { subjectId: ident?.subjectId ?? null, kind: ident?.kind ?? null, ...(r.lockUncleared ? { lockUncleared: r.lockUncleared } : {}) };
  if (!r.ok) {
    // busy / maintenance / 提交与读回残骸原样透传；写前校验类折成接线层的 `policy_store_invalid`。
    const reason = INVALID_WRITE_REASONS.has(r.reason) ? "policy_store_invalid" : r.reason;
    return { ok: false, reason, why: r.why ?? r.detail ?? null, ...base };
  }
  // P1-1：**目录 fsync 未证实 = 不干净**（R31 store 如实带 persistence:"uncertain"），接线层不许当 ok。
  if (r.persistence !== undefined && r.persistence !== "fsynced") {
    return { ok: false, reason: "policy_store_durability_uncertain", why: r.dirFsyncError ?? "目录 fsync 未证实",
      committed: true, persistence: "uncertain", changed: r.changed === true, state: written, ...base };
  }
  // P1-2：释放不干净不许 ok —— 降级 + 点名（写已落盘的话 changed/committed/state 照旧带出）。
  if (r.lockUncleared) {
    return { ok: false, reason: "policy_store_lock_release_failed", why: String(r.lockUncleared.reason ?? "lock_uncleared"),
      committed: true, changed: r.changed === true, state: written, persistence: r.persistence ?? null, ...base };
  }
  return { ok: true, changed: r.changed === true, committed: r.committed === true,
    persistence: r.persistence ?? null, state: written, ...base };
}
