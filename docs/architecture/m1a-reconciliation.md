# M1a 双射对账：legacy 权威 ↔ shadow 账本（v5，自包含实现合同）

> 地位：`layers-v2-ledger.md` §8『legacy 全集双射对账』的实现合同——约束 T3a（只读对账 +
> doctor，**Codex 已放行实现**）、T3b（migrate_seed / 双写 / repair）、T4（cutover 复合事务）。
> 字段事实来源：`project-resolve.mjs` / `interaction-policy-store.mjs` / `topic-generation.mjs`
> / `codex/state.mjs` / `selector.mjs`。
> **本文件自包含**（五轮 P1-1）：不引用任何已被覆盖的历史版本；全部定稿正文在此。
> 演进：v0→v5 经 Codex 五轮评审（7+5+5+5+4 项 P1 逐轮收闭）。

## 1. legacy 快照：两个封闭适配器

对账 legacy 侧**只能**经这两个适配器产生：

**`collectClaudeLegacySnapshot({ registryFile, now })`**：
- 枚举 `registry.json` 的 `projects[]`（项目集合唯一来源；`enabled:false` 的项目**仍进快照**，
  见 §5.1 enabled 行）；
- 每项目：`<root>/.runtime-data/inbound/active-mapping.json` **在场即优先**（binding /
  topic_generation_state 一律取项目文件；registry 内联字段只在项目文件缺席时生效）；registry
  不产第二份绑定投影；
- **严格读取**：任一在场文件读不出 / JSON 坏 / `validateTopicGenerationState` 不过 →
  `{ ok:false, reason:"legacy_unreadable", source }`；
- **双投影**（同一 binding_id 两次）→ `{ ok:false, reason:"legacy_conflict" }`；
- **严格 target 采集**：binding_target 全字段受验（Claude 需 UUID 形态 claude_session_id；
  Codex 需逐项受验 root/task/thread）；缺任一 → 该代际列待修 `target_incomplete`，**绝不临时
  选目标或填默认值**。

**`collectCodexLegacySnapshot({ home, now })`**：只读 Codex task registry（`mappingForTask`
物化：binding_id=`<taskId>@codex-registry`、status、session_id、inbound_state、pending_token）；
chat_id 按 task 覆盖优先、模板群兜底；严格读取/双投影/严格采集同上。

**快照身份（封闭格式）**：`snapshot_identity` = 按路径字典序的
`[{ path, sha256: <64hex> | null }]`；`null` = 显式缺席，缺席路径身份 = **受验真实父目录
（realpath）+ basename**；存在的文件才对文件本身 realpath；路径唯一；清单派生自 registry
内容（registry sha 变即身份变），不做目录级枚举；fd 受验读取（readRegularFile 语义）。

**范围（D1）**：legacy 没有可枚举的持久 A 族权威，不从 legacy 迁移 A 族；reconciler 先对整份
shadow 账本跑 G1–G15，再仅对 **live B 族子集**双射；M1a 期间入站合法创建的 A 记录共存不参与。

## 2. 判别函数（有优先级、互斥、封闭）

```
0. topic_generation_state 整体校验不过（validateTopicGenerationState）→ legacy_unreadable
1. rotation.status === "preparing"                     → 全局拒（cutover_blocked:rotation_preparing）
2. 逐代际 g（命中即止）：
   a. g.status === "retired"                           → 不投影（排除）
   b. g.status === "pending":
      b1. binding=active ∧ rotation===null ∧ session===null          → B1（初次绑定）
      b2. binding=active ∧ rotation.status==="awaiting_claim"
          ∧ rotation.pending_generation_id === g.id                   → B1（轮转待认领）
      b3. 其余 pending（binding paused/retired、rotation failed/
          cancelled/expired 残留）                                    → 待修（pending_unresolvable）
   c. g.status === "active":
      c1. 无受验 session → 待修（session_missing）
      c2. binding=active → B3    c3. binding=paused → B3′
      c4. binding=retired → 待修（binding_retired_active_gen）
   d. g.status === "read-only":
      d1. 无受验 session → 待修（session_missing）
      d2. binding=active → B4
      d3. binding=paused → 待修（paused_readonly，不静默映 B4）
      d4. binding=retired → 待修
3. 未命中唯一分支 → legacy_state_unmapped（拒）
```

待修项 = `cutover_blockers` 完整输出；任一存在 → cutover 拒（doctor 只报不拒）。

## 3. 期望记录：完整账本投影

| 记录字段 | 来源 |
| --- | --- |
| `topic_agent_id` | `"ta_" + sha256(canonKey({ domain:"topic_agent_legacy_v1", endpoint_id, binding_id, channel_generation_id })).slice(0,32)`；**同 id 由不同输入元组产生 → legacy_conflict** |
| `chat_id` | 适配器产出（Claude=链模板群；Codex=task 覆盖优先） |
| `aliases.root_om` | generation.root_message_id（OM_SHAPE 必过；缺 → 待修 root_om_missing） |
| `aliases.session_id` | generation 的 Aily session（≠ 本地 claude_session_id） |
| `generation_lineage_id` | effectiveBindingId（= binding_id） |
| `facts` 五元组 | §2 完整给值 |
| `binding_target` | §1 严格采集受验值 |
| `binding_proof` / `locator_link_proof_ref` | §3.1（B1 均 null） |
| `anchor_candidate` | null |
| 不进双射比较 | created_at / updated_at / origin_operation_id |

**`legacy_source_digest`（逐记录）** = `sha256(canonKey({ digest_version:"lsd-1", binding_id,
channel_generation_id, generation_status, binding_status, root_om, aily_session,
binding_target, snapshot: 相关源文件 {path,sha256} 子集 }))`。

### 3.1 迁移证明：独立不可变来源证明 + 生命周期组合表

migrated proof **不与当前终态 origin 绑定**——来源证明，永远为真。

**G13-mig**：任一 proof 为 migrated ⇒ ① migration_operation_id 指向存在的
`op_type==="migrate_seed"` op；② 该 op `result.seeded_ids` 含本记录 id；③ 双 migrated 时二者
migration_operation_id 与 legacy_source_digest 分别相等。

**键集**：binding migrated = `{ kind, authorized_by, authorized_at, migration_operation_id,
legacy_source_digest }`（authorized_by=角色表 owner，读不出 → owner_unresolvable 整批拒）；
link migrated = `{ kind, migration_operation_id, legacy_source_digest }`。

**生命周期组合表**（成对规则只在 seed 时刻）：

| 事务 | binding_proof | link | 说明 |
| --- | --- | --- | --- |
| migrate_seed（B1）| null | null | |
| migrate_seed（B3/B3′/B4）| migrated | migrated | 成对 |
| unbind / restore | 保持原样 | 保持原样 | origin 更新；A4 继承 migrated 合法 |
| retarget | → retarget | 保持原样 | (retarget, migrated) 合法 |
| A4 双证齐无 F4 重接 → A3 | → attach | 保留旧 link（含 migrated）| **(attach, migrated) A3 仅限继承**；可执行判据（五轮 P2-1）：origin 指向 attach_a3 op 且其 result.affected_id===本记录 id ∧ link 的 G13-mig ①② 成立；seed/migrate_seed **不得直接产出**该组合 |
| 重新配对 activate / attach+F4 | → pairing/attach | → pairing_merge/f4_anchor | migrated 被覆盖 |
| 新代际接管（旧 current→B4）| 保持原样 | 保持原样 | |

**允许表**：各族 binding/link 允许集 = 既有集 ∪ {migrated}；A1/A2/A3 不得以 migrated 被创建。

**migrate_seed**（gated、仅 `authority_mode==="shadow"`）：mutate 拿到本笔 opId 后构造记录与
proof（同笔闭合）；fingerprint = `{ request_key, candidates: 逐条 legacy 证据元组 canonKey
排序 }`；result = `{ seeded_ids:[有序] }`。

## 4. legacy 字段处置表（每行四选一 + M1b 合同）

| legacy 字段 | 处置 | M1b 合同 |
| --- | --- | --- |
| `expires_at` | 迁入 sidecar | cutover 门内生成 `ledger/<ep>/expiry.json`（封闭 schema `{schema_version, entries:{<topic_agent_id>: iso}}`、registry 锁协议、0700/0600）；到期闸与续期命令读写它；cutover 前置=无过期绑定投影 active |
| `pending_token`/`claim_expires_at` | 迁入 sidecar | `ledger/<ep>/pending-claims.json`（**bearer 凭证库**：0700/0600、fd 读、锁、内容不进诊断正文只给计数与 opaque id）；M1b 后认领=核凭证+activate；**无 token 初始 B1 合法**（owner 配对 @ 可认领），非 blocker |
| rotation 过程态 + operation identity | cutover 前清零 | 自动轮转 **M2 前禁用**（M1b 授权时向 Frank 明示）；手动轮转走 v2 事务 |
| activity / 提醒 / 轮转计数 | 退役 | 消费者禁用，随 legacy 冻结 |
| `interaction_policy_state` | 抽独立 v2 policy store（**M1b 前置块**） | `ledger/<ep>/policy.json`：封闭 schema、锁、0700/0600、fd 读；**主键 = `policy_subject_id`** = `"ps_" + sha256(canonKey({ domain:"policy_subject_v1", kind:"lineage"|"topic_agent", endpoint_id, id })).slice(0,32)`——B 谱系记录 kind=lineage、id=generation_lineage_id（=legacy effectiveBindingId 同键，轮转天然共享）；非谱系 A 记录 kind=topic_agent、id=自身。**保留/脱离规则（五轮 P1-4）**：activate 归并→subject=lineage（A1 tombstone 的自身 subject 随归并终结）；B4→A4（unbind 清 lineage）→subject 切自身 id、**初始化为空**（不继承谱系状态）；A4 reattach→保持自身。/feishu-mode 与 reserve/finalize 先解析 subject 再改。切换点=cutover sidecar step |
| `status` ≠ active（非 paused 语义） | cutover 前规范化或退役 | selector 拒非 active，不得投影后放行 |
| Codex task `chat_id` 覆盖（值不变时） | 迁入 | chat_id 逐记录 |
| `inbound_state` | cutover 前清零 | drained 语义覆盖 |
| `enabled` 翻转（五轮 P1-2 定案） | **disabled 仍进快照、映为 paused 语义（B3′）**——快照/双射两侧一致；恢复 enabled=restore | 与 legacy「disabled 不路由」等价（B3′ 不路由）；不再有"disabled 不产快照"条款 |
| binding retire（五轮 P1-2）| **cutover blocker**（M1a 不映射；先由 owner 恢复或等 M1b 后走 v2 生命周期清理） | — |

处置表外字段承担路由语义 → `legacy_field_unmapped` 拒。

### 4.1 复合切换事务（T4；维护 journal step 机制）

1. 每 sidecar 一个 prepared step（`sidecar:expiry:<ep>` 等：before/intended SHA/备份落 journal）；
2. 逐个写 + fsync + 读回核 SHA → markStepDone；全部 done 才进 3；
3. **唯一提交点 = authority_cutover 账本写**；
4. 崩溃恢复逐 step 三分（before/intended/其它）；
5. **cutover op 联合（五轮 P1-4 定案，与上游账本合同一致）**：
   result = `{ revision_at_cutover, bijection_digest, pre_cutover_ledger_sha, expiry_sha256,
   pending_claims_sha256, policy_sha256 }`（**保留**上游 revision_at_cutover）；
   fingerprint 输入 = `{ request_key, endpoint_id, bijection_digest, pre_cutover_ledger_sha,
   expiry_sha256, pending_claims_sha256, policy_sha256 }`——sidecar intended SHA 进指纹，
   同 key 换任一 SHA = request_conflict 而非重放；`layers-v2-ledger.md` §5.1 cutover 行回带更新；
   最终 ledger SHA 由维护 journal ledger step after 承载；SHA 只证切换瞬间，doctor 此后只核
   sidecar schema 合法 / 锁家族干净 / 与账本自洽（键集 ⊆ live、subject 可解析），不比历史 SHA。

## 5. M1a 双写（T3b）

- **外层排序锁无降级**：§5.1 全表写方必先取 `ledger/<ep>/m1a-order.lock`（registry 锁协议），
  固定 outer → legacy 锁段 → 账本锁段（内锁不同时持有）；取不到 → 整笔 busy 拒（=binding_busy
  语义）。**无 legacy-only 路径。**
- 顺序：先 legacy 提交后 shadow；崩在中间 = legacy 权威成立、shadow 缺 = mismatch 非业务失败；
  shadow 失败不改变 legacy 成功语义，连续失败 doctor 红报。
- M1a 阶段 legacy 是唯一权威、ledger 是 shadow。

### 5.1 writer→账本事务全映射（封闭）

| legacy 写方（实际入口） | 账本事务 | request_key 派生（五轮 P1-3：逐 op 全定义） |
| --- | --- | --- |
| 入站建 Dialogue 会话记录（inbound-route R1 路径） | create_a1 | ext=入站 message id；**entity=受验 Aily session locator**（预先确定，非随机 ta id） |
| bind/认领（claim→绑定：引用码、@ 配对） | create_a1 → activate（固定顺序） | 同一 claim：ext=claim key；create_a1 entity=session locator、activate entity=B1 topic_agent_id——两笔 key 确定性派生且不同 |
| 显式 attach（终端） | attach | ext=控制 claim key（终端命令 claim 机制既有、持久）；entity=目标 id |
| rotate（建新代际） | create_b1 | ext=rotation operation id（topic-generation 既有、持久）；entity=lineage id |
| rotate cancel / pending 过期 | void | 同上 |
| 连接暂停/恢复（binding_status paused/active 翻转的写方——topic-generation state 写入口；五轮 P2-2 更正：非 /feishu-mode，mode 属 policy 域） | unbind / restore（只动 current B3；历史 B4 不动） | ext=该次终端命令的**持久控制 claim key / 命令审计 id**（禁止临时随机）；entity=目标 id |
| retarget（owner 终端） | retarget | 同上 |
| `enabled` 翻转 | unbind / restore（§4 行） | 同上 |
| 到期/续期 | expiry sidecar 写 | 不进账本 |
| policy mode / reserve-finalize | policy store 写 | 不进账本 |
| 迁移种子/修复（维护工具） | migrate_seed / migrate_repair | ext=维护 operation token（持久）；entity=endpoint / 目标 id |
| 项目文件接管 registry（值不变） | 无事务（双射中性） | — |
| 模板群 / chat_id 覆盖变更 | 维护事件，M1a 期间 = cutover blocker | — |

**通式**：`request_key = "m1a_" + sha256(canonKey({ domain:"m1a-rk-1", external_request_id,
op_type, entity_id })).slice(0,40)`；每行的 ext/entity 如上表——**无外部消息的动作一律用持久
控制 claim / operation id，禁止临时随机 fallback**。多笔序列固定顺序、崩溃续跑逐笔重派生 key
命中重放跳过执行缺失后缀；legacy 重试 no-op 仍走完 shadow 序列。

**migrate_repair**（gated、shadow-only、owner 逐次授权）：fingerprint =
`{ request_key, topic_agent_id, expected_projection_digest, next_projection_digest }`；
CAS：现投影 digest ≠ expected → repair_cas_mismatch；**只改 facts/aliases/target、绝不改
proof**（需 proof 变化走真实生命周期事务）；result = `{ repaired_id, from_family, to_family,
expected_projection_digest, next_projection_digest }`；**G13-repair**：origin 指向 repair ⇒
① 现投影 digest 重算===result.next；② result 两 digest 与 fingerprint 逐字相等；
③ repaired_id===本记录 id。

## 6. reconciler 判据与 digest（T3a 已放行）

```
C = { projection_version:"m1a-2", endpoint_id, chain,
      records: [ 按 topic_agent_id 字典序的
        { topic_agent_id, chat_id, aliases:{session_id, root_om},
          facts:{binding, session, anchor, locator_link_proof, generation},
          generation_lineage_id, binding_target } ] }
digestE = sha256(canonKey(C_from_legacy));  digestS = sha256(canonKey(C_from_shadow))
ok ⇔ digestE === digestS ∧ 逐项双射成立（配对键 = topic_agent_id）
```

proof 不进 C（引用完整性 = G13-mig/G13-repair 独立判据）。mismatch 全清单
（E 多 / S 多 / 逐字段不等）。**快照一致性**：投影前后各取一次 §1 snapshot_identity + 账本
revision，不一致 → `{ ok:null, reason:"snapshot_moved" }`（inconclusive；cutover 视同不通过
重试；doctor 整体 incomplete、**不得生成或复用 readiness/cutover 凭据**）。

**结果联合（封闭）**：`{ ok:true, digest }` | `{ ok:null, reason:"snapshot_moved", why }` |
`{ ok:false, reason, why, mismatches:[{ code, topic_agent_id|null, field|null, detail }] }`。

## 7. doctor 输出纪律

问题码 + opaque id/字段名/哈希；**不得原样输出 locator/session/thread/项目路径**；上限
10 条 + "另 N 条"；完整清单进 0600 机器级诊断制品。shadow 账本 absent → 如实"尚未初始化，
跳过"（不红）。

## 8. owner 待修流程

终端命令：owner 逐次授权、preview/apply、精确对象 id、expected-before CAS、operation 审计
留痕；`session_missing` 只能由真实 owner 配对（@ + F4）补绑，终端不得直接填 session。

## 9. 排期影响

- **新前置块 = v2 policy store 抽取**（§4；T3 之后、M1b 之前；含读写方迁移与 cutover step 接线）；
- cutover 复合事务（§4.1）扩展 R16 编排——归 T4/M1b；
- T3a（§1/§2/§3 投影/§6/§7）已开 #R19 实现；T3b（§3.1/§5）与 T4（§4.1）以本 v5 为合同。
