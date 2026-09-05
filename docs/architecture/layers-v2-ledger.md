# 架构 v2 第三步 —— 权威账本的存储与锁协议

> 2026-09-04。接 `layers-v2-session-centric.md`（第一步）与 `layers-v2-permissions.md`
> （第二步）。本步定：**账本磁盘形状、并发写串行化与带 fencing 的提交、判别联合
> 落盘、归并/tombstone 实现、迁移期权威切换、可实现的封闭事务合同。**
>
> **状态：第三步第九稿（Codex 八轮评审逐条处理，累计 P1：6/4/4/4/5/2/1/2）。两处
> 第一步建模决策 Frank 已拍板（2026-09-04「按更新推荐」，§12）；配套第一步措辞订正
> 随本步一并合并（见 layers-v2-session-centric.md §3.3/§3.5）。落地是 M1，按五项
> 证据合并。**

## 0. 一句话

账本 = 每 endpoint 一份单文件 JSON（`records`、单调 `revision`、不可覆盖的
`operations` 事务身份+结果表、端点级 `authority_mode`）。写走 `commitWhileHeld`
带 token fencing：锁外只读与取证、提交后才 deliver/回执；锁内 fd 重读→compare+整
账本校验→build→提交，结果四态封闭。读快照 fd 绑定读，载入先跑校验器（G1–G15），
任一不过则该 endpoint 整体 `ledger_corrupt`。**账本缺席/不可读一律 fail-closed、
永不回退 registry**（含 shadow 阶段）。初始化、authority 切换、retarget 都是封闭
事务（§5/§5.1）。

## 1. 设计约束（继承，不可违反）

**第一步**：① 链机器级、Git 外、不挂项目目录；② `topic_agent_id` 不复用 locator；
③ 顶层判别联合三选一；④ 配对前同话题可 B1+A1 并存；⑤ 迁移原子、不存在两个
current；⑥ tombstone 封闭、禁自指/环/悬空、幂等/冲突 fail-closed；⑦ voided_audit
不路由/投影/派生；⑧ 先验族再派生；⑨ `anchor_candidate` 永不置 anchor=present；
⑩ **生命周期事实与运行时 health 分开**。

**第二步**：账本只出事实与投影；唯一入账授权产物是 `binding_proof` 与
`locator_link_proof_ref`。

**工艺红线**：⑪ 不新造锁协议；⑫ 原子写=唯一 tmp+rename+写前 `.prev`、带 fencing；
⑬ 只有运行时经**唯一写 API** 写。

## 2. 位置与布局

```
~/.claude/feishu-bridge/ledger/<endpoint_id>/       # 目录 0700
  ledger.json     # records+revision+operations+authority_mode   文件 0600
  ledger.json.prev  ledger.lock  ledger.lock.reap
```

`<endpoint_id>` = `legacyEndpointId({runtime,agentUid})`。绝对路径、不拿 shell `~`
当协议；测试注入 `FEISHU_BRIDGE_LEDGER_DIR`。**路径校验**：`O_NOFOLLOW` 只护最后
一段，故父目录逐层 realpath 核对到受验根、拒绝同 UID 目录被替换（威胁边界入合同）。
单文件（迁移跨记录、一次 rename 即原子）。顶层：

`endpoint_id` 是 `legacyEndpointId` = `stableControlId("endpoint", runtime, agentUid)` = **不透明的
`endpoint_<24hex>`**，**链（claude/codex）无法从中还原**，故顶层另存封闭 `chain` 字段（实现落定；
维护层核验时另须证明该 opaque endpoint 确属该 chain，不只信账本自述）：

```json
{ "schema_version":"1.0", "artifact_type":"feishu_bridge_topic_agent_ledger",
  "endpoint_id":"<endpoint_24hex>", "chain":"claude"|"codex",
  "authority_mode":"shadow"|"authoritative", "revision":42,
  "operations": { "<operation_id>": <§5.1 逐 op 封闭> },
  "records": { "<topic_agent_id>": { "kind":"...", ... } } }
```

## 3. 锁与带 fencing 的提交

**外部 I/O 次序**：锁前只读与取证（F4 只读、attach 目标解析），不 deliver/回执；
锁内 `commitWhileHeld`（fd 重读→校 revision→compare+整账本校验→build→提交）；提交
后才 deliver/回执。绝不先发回执再延后写账本。

**提交步骤**：从受验 fd 的 `oldBytes` 预写唯一 `prevTmp`（`O_EXCL|O_NOFOLLOW`+循环
写+fsync），预写 `ledgerTmp`（同纪律+fsync）；进 `commitWhileHeld`（核对锁 token
仍属自己）后段内两次 rename（→`.prev`、→`ledger.json`）+ fsync 目录。不用
`copyFileSync` 按路径重读写 .prev。**临时文件封闭命名**（`ledger.json.<pid>.<uuid>`、
`.prev.<pid>.<uuid>`）：无论提交成功与否，未清理的 tmp **都进结果的残骸清单**（带
路径）交 doctor 盘点——`not_committed` 下 prevTmp/ledgerTmp 清理失败同样携带路径，
不是只有 `committed_with_residue` 才报（评审六 P2）。

**提交结果封闭四态**：`not_committed`（rename 前失败/`lock_lost`/compare 拒绝，可
重试）；`committed_clean`；`committed_with_residue`（已提交；prevTmp/reap 残骸未清
**或放锁失败=lock_state_unclear**）；`committed_durability_uncertain`（已 rename
但**仅目录 fsync 失败**，已提交、不得当未提交重试）。`lock_lost`→绝不提交。`.prev`
只取证、损坏不自动提升。

**Q1**：账本锁不算改锁协议，但是新生产写面，启用前必须纳入维护门。**Q2**：账本写
过维护门（`acquirePublishLock`），门在→回"未处理，请重发"，不先发回执。锁参数：
`reapUnrecognized:false`、`acceptReapedResidue:false`；staleMs/预算见 §10。

**维护门内的初始化与切换是唯一 ungated 例外（评审三/四 P1-1）**：
`initialize_shadow` 与 `authority_cutover` 发生在门内，此时 `acquirePublishLock`
必拒。故设**唯一的维护内部路径**：绑定 active maintenance operation + gate token +
operation lease + `current` 桩状态核验通过后，**才**允许 `acquireLockUngated` 取
账本锁；提交仍走 `commitWhileHeld`。**不开放通用 ungated API**——只有这两笔受验
事务能走这条路。

## 4. 记录 schema（逐字段封闭）

**读纪律**：`O_RDONLY|O_NONBLOCK|O_NOFOLLOW`→同 fd `fstat`→只认 `nlink===1` 普通
文件→同 fd 读。写端同纪律，提交前对完整新账本重跑校验器。

### 4.1 `live`

```json
{ "kind":"live", "topic_agent_id":"ta_<稳定id>", "chat_id":"<受验群>",
  "aliases": { "session_id":"<locator|null>", "root_om":"<locator|null>" },
  "facts": { "binding":"none|pending|active|dormant", "session":"absent|present",
    "anchor":"absent|present", "locator_link_proof":"absent|present",
    "generation":"n/a|pending|current|historical" },
  "binding_target": <4.4>|null, "binding_proof": <4.4>|null,
  "locator_link_proof_ref": <4.4>|null,
  "anchor_candidate":"<未验根om_|null>", "generation_lineage_id":"<谱系id|null>",
  "origin_operation_id":"<产生本记录当前终态的 op>",
  "created_at":"<iso>", "updated_at":"<iso>" }
```

### 4.2 `forwarding_tombstone`（封闭恰五项+kind+id）

```json
{ "kind":"forwarding_tombstone", "topic_agent_id":"<被吞原id>", "forwards_to":"<存活 live id>",
  "merged_at":"<iso>",
  "proof_ref": { "kind":"pairing", "om":"<om_>", "matched_fields":["chat_id","sender","body","thread_root"] },
  "origin_operation_id":"<归并 op>" }
```

### 4.3 `voided_audit`（封闭恰五项+kind+id）

```json
{ "kind":"voided_audit", "topic_agent_id":"<原pending id>", "root_om":"<原根om_>",
  "voided_at":"<iso>", "reason":"<封闭枚举>", "origin_operation_id":"<作废 op>" }
```

### 4.4 精确本地目标与三支 proof（决策见 §12）

**`binding_target`（只表精确会话/任务，`runtime` 必与 endpoint 链一致，G11）**：

```
binding_target =
  | { runtime:"claude", project_root:"<abs>", claude_session_id:"<uuid>" }
  | { runtime:"codex",  project_root:"<abs>", codex_task_id:"<id>", codex_thread_id:"<id>" }
```

`binding=none` ⇔ null；`∈{pending,active,dormant}` ⇔ 非 null。

**`binding_proof`（四支各自封闭；retarget 支为 A′ 而增，评审四 P1-3；migrated 支为 M1a 迁移
而增，`m1a-reconciliation.md` §3.1）**：

```
binding_proof =
  | { kind:"attach",   authorized_by, authorized_at, claim_key }
  | { kind:"pairing",  authorized_by, authorized_at, matched_om, matched_fields:[完整四项] }
  | { kind:"retarget", authorized_by, authorized_at, old_target, new_target }   // 自身即"owner 授权把 old_target 换成 new_target"的完整证明；不引用前一 proof（评审六 P1-1）。old/new 明文亦入 retarget result（§5.1），便于给定候选时核验历史
  | { kind:"migrated", authorized_by, authorized_at, migration_operation_id, legacy_source_digest }  // 迁移来源证明（不可变，不随生命周期改变）；G13-mig 判据见 §7
```

**`locator_link_proof_ref`（封闭；M1a 增 migrated 支 `{ kind:"migrated",
migration_operation_id, legacy_source_digest }`，同上）**：

```json
{ "kind":"pairing_merge"|"f4_anchor", "matched_om":"<om_>", "matched_at":"<iso>",
  "matched_fields":["chat_id","sender","body","thread_root"], "by_identity":"user" }
```

**F4 字段恰为完整有序四项**（G15，不是子集）。所有 id/locator/om_/fingerprint 正则
与长度、`reason` 枚举入实现合同。

### 4.5 逐字段族规则（双向）

- `aliases.session_id`非 null ⇔ `session=present`；`aliases.root_om`非 null ⇔ `anchor=present`。
- `binding∈{active,dormant}` ⇔ `binding_proof`非 null；`∈{none,pending}` ⇔ null。
- `locator_link_proof=present` ⇔ ref 非 null ∧ session=present ∧ anchor=present。
- `generation≠n/a` ⇔ `generation_lineage_id≠null`；且 `generation≠n/a` ⇒ `anchor=present`；
  `generation=pending` ⇔ `binding=pending`。
- `anchor_candidate`非 null 不改 anchor；`binding_target=null` ⇔ `binding=none`。

**proof kind 按来源迁移（评审三/四 P1-2/P1-4）**——kind 记的是"证明怎么来的"，
不硬绑终态；retarget 可作用于任何 active 族，其 proof **自身即完整授权、不引用前一证明**（评审六 P1-1）：

| 族 | binding_proof.kind | locator_link_proof_ref.kind（present 时）|
|---|---|---|
| B3 / B3′ / B4 | pairing / retarget / **migrated** | pairing_merge / **migrated** |
| A2 | attach **或** retarget | —（无 link）|
| A3 | attach **或** retarget | **f4_anchor 或（从 A4 合法继承的）pairing_merge 或（从 migrated A4 合法继承的）migrated**（评审四 P1-4；M1a 七轮 P2-1：(attach,migrated) 仅限继承，判据=family===A3 ∧ binding=attach ∧ origin 指向 attach_a3 且 result.affected_id===本 id ∧ G13-mig 成立）|
| A4 | attach / pairing / retarget / **migrated**（取决前态）| 保留前态 kind（含 migrated）|

（migrated 组合的完整生命周期表与"A1/A2/A3 不得以 migrated 被创建"约束见
`m1a-reconciliation.md` §3.1。）

## 5. 事务（六生命周期迁移 + 创建/种子/初始化/切换/retarget 存储事务）

全走唯一写 API `withLedgerWrite`（§3）；`initialize_shadow`/`authority_cutover`
走 §3 唯一维护内部路径。**每笔记不可覆盖的事务身份+结果**：`operations[op_id]` 逐
op 封闭（§5.1），只增不改；记录 `origin_operation_id` 指向产生其当前终态的那笔。

**创建/种子/初始化/切换/retarget**：

| 事务 | compare | build |
|---|---|---|
| **initialize_shadow**（维护内部；评审四/五/六/七 P1）| 锁内**封闭盘点整个 endpoint 目录**：无 `ledger.json`/`.prev`/`tmp`/未知制品（**真 virgin**）∧ 机器级初始化收据无"该 endpoint 已初始化/已切权威"记录；任一不满足即拒 | **走 §5.2 WAL 三步**：revision=1 + `authority_mode=shadow` + 空 records + operations 恰含本笔 initialize_shadow（result_revision=1）；首次无 .prev；O_EXCL + fenced rename。**seed 必为后续独立事务**（评审五 P1-1）|
| **authority_cutover**（维护内部；评审四 P1-1）| =shadow ∧ **operations 中尚无 cutover**（G14）∧ 门内 legacy 全集**双射对账**通过 | `authority_mode` shadow→authoritative（与写入 cutover op **同一不可逆提交**）；**普通写 API 不得反向改回 shadow**；重放只返回原结果、不新增第二笔；切换后若 reopening 未完，门保留、只向前恢复 |
| create-A1 | locator 全局无 live（G3）；chat_id 受验 | 新 A1 |
| create-B1 | 桥建 root om_ 全局唯一；允许"同 lineage 已有 current 再加一 pending"（rotate），pending 至多一（G5）| 新 B1 |
| seed | 逐条过校验器；同 locator 仅规范投影逐字段相同才幂等，否则冲突 | 批量插入 live（M1a）|
| **retarget**（§12-1 A′，已拍板）| owner 授权 ∧ 旧 target 精确匹配 ∧ 新 target 受验 ∧ 项目边界不变 ∧ 目标记录 active；**单位见下** | active/dormant 记录改 binding_target + 写 `binding_proof.kind=retarget`（自身即完整授权）；**lineage 内 B1(pending) 只原子改 binding_target + origin_operation_id、`binding_proof` 仍为 null**（评审五 P1-2：pending 必须 proof=null）；target 不可用**不触发**（归 health）|
| **rebind_session_alias**（W2 认领现场，Frank 拍板）| 目标 live ∧ 当前族 B3/B3′/B4 ∧ binding=active ∧ expectedOldSessionId=当前 aliases.session_id（CAS）∧ newSessionId 走 AILY_SESSION_SHAPE ∧ 无 live 记录占用该 newSessionId（alias_occupied fail-closed）∧ authorizedBy 受验 | **只**改 aliases.session_id 到 newSessionId + updated_at + origin_operation_id=本笔；**不动** binding_target / binding_proof / family / lineage（binding_target 的 retarget 归 Phase 2 配对写方，**当前无消费方、预留**——见 m1a-reconciliation §5.1）|

**§5.2 初始化的 WAL 三步（评审七 P1：初始化标记与 ledger 是两个文件，不能"同笔"）**——
"已初始化"标记与 `ledger.json` 分属两文件，必须定持久化顺序与崩溃恢复，不能靠文字当
单文件事务：

1. 先持久化 `initialize_prepared { endpoint_id, op_id, fingerprint }`（机器级收据）；
2. 再提交 `revision=1` 的 ledger，其内部 initialize operation 身份必与 prepared 一致；
3. 最后把标记推进为 `initialized`。

恢复规则（封闭）：`prepared + ledger absent` → 只允许**同 op 重试**；`prepared + 身份
匹配的 revision=1 ledger` → 补记 `initialized`；`initialized + ledger absent/unreadable`
→ **ledger 丢失、禁止初始化**（报损坏）；`prepared + 不匹配 ledger` → 损坏、人工介入。

**这份初始化收据本身的存储/锁合同（评审八 P1-1，选定唯一方案、不留备选）**：它是本
步新增的权威制品，**定为维护 journal 里一条不可删除的 endpoint 初始化记录**，复用
维护门的 operation lease + durable journal 协议（不新造存储层）：

- 位置：维护 journal（机器级、不随普通清理消失）；判别联合
  `absent | prepared | initialized | unreadable`（unreadable/malformed 一律
  fail-closed，不折成 absent）。
- 读写纪律同账本：fd 绑定读、tmp+fsync+rename+目录 fsync；受**维护门的 journal 锁**
  保护，锁顺序 = 先取 journal 锁再取 ledger 锁（与 §3 唯一维护内部路径同段，避免与
  账本锁交叉死锁）。
- 该记录**永久保留、初始化完成后不得自动删除**；瘦身/迁移只能走显式维护入口。

**retarget 单位（§12-1 子决策，Frank 已拍板"整条谱系"）**：无谱系的 A2/A3
单位=该单条记录；**有谱系时单位=整条 lineage**——同笔更新该 lineage 全部 live
（B1 pending / B3 current / B3′ dormant-current / B4 historical）的 binding_target，
保持 G6；**lineage 内有 pending 时一起改**（B1 仅改 target + origin_operation_id、
proof 保持 null；active/dormant 记录写 retarget proof）。

**六种生命周期迁移**（create 不在其中）：

| 迁移 | 关键 compare | build |
|---|---|---|
| 激活 B1+A1→B3 | B1=pending∧A1=chat∧未各配对到不同实体∧F4 齐∧谱系 current 可同笔降 | B1→B3（active/current/双 proof/并入 session 别名）；A1→tombstone；旧 current→historical |
| 作废 B1→∅ | B1=pending | B1→voided_audit；A1 不动 |
| attach 无F4 A1/A4→A2/A3 | =chat/A4∧owner 授权∧bound 拒 | A1→A2（attach proof、无 anchor）；**A4 双证齐→保留 locator proof（可为 pairing_merge）进 A3、写新 attach binding_proof**；A4 全无→A2；**A4 证损坏/与当前 locator 冲突、或 F4 复核读到与旧证明正面矛盾的 root/chat→attach 失败并报证明冲突**（不只 health，评审四 P1-4）|
| attach F4 A1/A4→A3 | 同上 + F4 唯一命中∧thread root 逐字符合 | 同笔写 anchor+link_proof+双 proof |
| 锚定 A2→A3 | =A2∧本次 F4 成功 | 同笔写 anchor+link_proof |
| 恢复 B3′→B3 | =B3′∧谱系无其他 current | dormant→active、保留原双 proof |
| unbind A2/A3→A4、B3→B3′、B4→A4 | owner 终端命令 | binding→dormant；B4→A4 同笔 generation historical→n/a、清 generation_lineage_id |

**幂等/冲突**：写端按 **`request_key`（全局唯一，G12）** 查历史 op——同 key 且 fingerprint
相等→幂等返回原 result/result_revision；同 key 但 fingerprint 不等→`request_conflict`
fail-closed（详见 §5.1 重放/冲突判定）。fingerprint 规范输入含 `op_type` 域分隔且首字段为
`request_key`——否则 restore/unbind 同以 topic_agent_id 为输入会撞同一指纹（评审五 P1-5），
而 request_key 相同的两次不同载荷也才能被判成冲突而非静默追加（评审六 P1-1）。

### 5.1 operations 逐 op 规范表（评审四 P1-2；实现合同锚点）

`operations[op_id] = { op_type, terminal_kind, request_key, fingerprint, result_revision, result }`
（**`request_key` 是独立顶层字段**，评审六 P1-1）。逐 op 钉死 **fingerprint 输入字段** 与
**result 精确键集/ID 顺序/null 规则**。fingerprint = sha256(规范 JSON)，**输入首字段恒为
`op_type`（域分隔），第二字段恒为 `request_key`（外部请求身份 = 控制 claim key / message id）**
——**可重复动作（unbind↔restore、往返 retarget）靠 request_key 区分"另一次请求"与"同一请求
重放"，不能用动作参数相同代替（评审四 P1-2）**；缺席证据字段用**显式 null**（同一 op_type
只有一种输入形状，评审四 P1-4）。**请求身份必须状态无关**：fingerprint 输入只取调用方字面参数，
不取账本当前状态派生量（评审六 P1-1：否则 seed 的第二次调用 toInsert 收缩、retarget 往返的
lineage 相同，都会把合法新请求误判成旧重放）：

| op_type / terminal_kind | fingerprint 输入（隐含前置 op_type, request_key）| result 键集 |
|---|---|---|
| create_a1 | chat_id, session_locator | { created_id } |
| create_b1 | chat_id, root_om, lineage_id, predetermined_target | { created_id } |
| activate | b1_id, a1_id, matched_om | { surviving_id, tombstoned_id, demoted_historical_id\|null } |
| void | b1_id, reason | { voided_id } |
| attach_a2 / attach_a3 | topic_agent_id, target, claim_key, root_om\|null, matched_om\|null（无 F4 时两者 null；F4 时填）| { affected_id, terminal_family } |
| anchor | topic_agent_id, root_om, matched_om | { affected_id } |
| restore | topic_agent_id | { affected_id } |
| unbind | topic_agent_id | { affected_id, terminal_family } |
| retarget | topic_agent_id, old_target, new_target（**只取调用方字面 id 与 old/new target；lineage 是状态派生量，只进 result/affected，不进请求身份**，评审六 P1-1）| { affected_ids:[有序], unit:"record"\|"lineage", old_target, new_target } |
| seed | candidates（**调用方给的全量候选集**，逐条 canonKey 后按串排序；不是 toInsert，评审六 P1-1）| { seeded_ids:[有序] } |
| migrate_seed（M1a）| candidates（逐条 legacy 证据元组 canonKey 排序）| { authorized_by, authorized_at, seeded:[按 id 排序的 { topic_agent_id, legacy_source_digest }] } |
| migrate_repair（M1a）| topic_agent_id, expected_projection_digest, next_projection_digest | { repaired_id, from_family, to_family, expected_projection_digest, next_projection_digest, legacy_source_digest, authorized_by, authorized_at } |
| initialize_shadow | endpoint_id, chain | { revision:1 } |
| authority_cutover | endpoint_id, bijection_digest, pre_cutover_ledger_sha, expiry_sha256, pending_claims_sha256, policy_sha256（M1a 七轮：sidecar intended SHA 入指纹，同 key 换任一 SHA=request_conflict）| { revision_at_cutover, bijection_digest, pre_cutover_ledger_sha, expiry_sha256, pending_claims_sha256, policy_sha256 } |

**重放/冲突判定（评审六 P1-1 / 七 P1-2）**：`request_key` **全局唯一**（G12），写端按 request_key 全局查——
- 无同 key 的历史 op → 正常执行；**成功的空操作也落一笔 op 占用 request_key**（seed 全存在→写 `seeded_ids:[]` 的 seed op；不存在"成功但免写"的状态式 noop）。仅**失败**（bad_input / conflict / retarget `no_change` 等）不落 op、不占用 key；
- 有同 key 且 **fingerprint 相等**（同请求重放）→ 返回原 `result` / `result_revision`，**不新增第二笔**；
- 有同 key 但 **fingerprint 不等**（同 key 换了载荷，调用方 bug）→ `request_conflict`，拒，不写。

**retarget 边界**：要求 `new_target ≠ 当前 target`（CAS 过后仍相等）→ `no_change` **拒**（失败、不落 op、不占用 request_key）——不是状态式成功 noop（评审七 P2）。

fingerprint 只用于**同一 request_key 内判等**，不作授权；`result` 保证 create→归并后仍能按
op_id 找回创建 ID / 存活 ID（评审四 P1-2）。
（`initialize_shadow`/`authority_cutover` 属维护层入口，**第 1 块生产恒拒、正文已删**，只留恒拒外壳；
其 request_key、virgin 盘点、§5.2 WAL、门内双射对账都由第 2 块维护层提供，且必须校验并使用调用方原
request_key、不 fallback，评审六 P1-1。）

**值域（评审五 P2，可直译校验器）**：`op_type` 与 `terminal_kind` 一一对应（表左列
即对应关系，两者同名）；`terminal_family` **逐 op 精确值域**（评审六 P2）：`attach_a2`→仅 A2；`attach_a3`
→仅 A3；`unbind`→仅 {A4, B3′}（不接受 B3/B4 作终态族）；其余 op 无 terminal_family。
所有 `*_ids` 数组按 **topic_agent_id 字典序**排列（确定性）；
`result_revision` 为正整数且 ≤ 顶层 `revision`；result 内可空字段（如
`demoted_historical_id`）显式写 `null`、不省略键。

## 6. tombstone / forwarding

只由归并产生；`forwards_to` 只直指 live。tombstone 无 locator：按 locator 路由直
命中已合并别名的存活 live；forwarding 仅按旧 `topic_agent_id` 查找时解引用（visited+
上限，实际恒 1）。幂等/冲突按旧 ID / operation fingerprint / 存活 proof。不物理删除。

## 7. 读路径、整账本校验、损坏处置

先整账本校验再路由：① fd 绑定读；读不清→fail-safe，不当空账本。② 跑校验器
（G1–G15）；任一不过→该 endpoint 整体 `ledger_corrupt`（停路由/deliver/投影、doctor
红）。③ 通过才在内存建别名索引（跳过 tombstone/voided），不持久化。

**全局不变量**：G1 records 键===topic_agent_id；G2 顶层 endpoint_id===路径；G3 每
live locator 全局唯一（重复→corrupt，不按 updated_at 选赢家，写端亦阻止其生成）；
**G4（已退役，评审五 P1-3）** chat_id 是受验**群**、不是话题唯一键——同群可多
话题/多智能体/多代际，不按同群 live 共存数量判损坏；话题唯一性靠 G3（locator 全局
唯一），配对候选只由**完整 F4 证明**唯一确定；G5 每 lineage ≤1 current、≤1 pending；
G6 同 lineage 记录 binding_target 一致；**G7 占用者**：占用者={pending,active,B3′}，
A4 dormant 只留档不占用；同 target 多占用者只允许同一非空 lineage，A2/A3 无 lineage
故同 target 只一个，A4 与新占用者可共存但 A4 再 attach/恢复须重新参加冲突检查；
G8 §4.5 族规则（双向）；G9 tombstone 图直指存活 live、无自指/环/悬空；G10
active/dormant ⇔ binding_proof、link fact ⇔ link_proof_ref；**G11** proof kind 按
§4.5 迁移表（含 retarget）、binding_target.runtime===endpoint 链；**retarget 跨字段
不变量（评审八 P1-2）**：binding_proof.kind=retarget 时 `old_target !== new_target`
且**当前 `binding_target === binding_proof.new_target`**（授权目标必等于实际投递目标）；
**G12** operations
map key 合法、`result_revision` 正整数且 ≤ 顶层 revision、**同 op_id + op_type +
fingerprint 三者皆等**才可重放、任一异即冲突（评审六 P2，与 §5 一致）；**G13** 记录 `origin_operation_id` 必在 operations 表内且该 op 的
`result`（受影响记录集/终态）与当前记录转换相容；**当 origin 为 retarget（评审八
P1-2）**：该 op result 的 `old/new_target` 与本记录 binding_proof 逐字段相等、
`affected_ids` 含本记录；**B1（proof=null）的 origin 为 retarget 时，其
binding_target 必 === 该 op result 的 new_target**；**G14（双向，评审五 P1-4）** `authority_mode`=shadow ⇔ operations 中**无**
authority_cutover；=authoritative ⇔ **恰有一笔**有效 authority_cutover（cutover 与
mode 翻转是同一不可逆提交，禁止 shadow 已含 cutover 的状态）；**G15** `matched_fields`
恰为完整有序四项。**G13-mig（M1a，九轮 P1-1 与 m1a-reconciliation.md §5.1 同一定义）**：任一 proof 为
migrated ⇒ migration_operation_id 指向 op_type ∈ {migrate_seed, migrate_repair} 的存在 op；
proof 的 legacy_source_digest 与该 op result 中对应本记录的 digest **逐字相等**（seed 用
result.seeded 项、repair 用 result.repaired_id + result.legacy_source_digest）；**binding
migrated proof 的 authorized_by/authorized_at 与该 op result 逐字相等**；link 与 binding
引用同一 op 同一 digest；双 migrated 时二者引用分别相等。
**G13-repair**：origin 指向 migrate_repair ⇒ 现记录投影 digest 重算 === result.next、result
两投影 digest 与 fingerprint 逐字相等、repaired_id === 本记录 id。（完整合同：
`m1a-reconciliation.md` §3.1/§5.1。）禁止跨 endpoint forwarding（Q4）。

## 8. 迁移期权威：authority_mode 端点级原子切换

顶层 `authority_mode`：`shadow`（M1a）/`authoritative`（M1b）。

- **启用 ledger-aware runtime 前必须先 `initialize_shadow` 建好合法 shadow 账本**；
  **此后账本 absent/unreadable/corrupt 一律 fail-closed、停生产路由**（评审四 P2：
  shadow 阶段亦然，消除"缺席永不回退"的解释分叉），绝不回退 registry。**journal 一旦
  记有"该 endpoint 已初始化"，主文件缺席只能报损坏、不得再走 `initialize_shadow`**
  （评审六 P1-2：否则丢文件会被伪装成首次安装）。
- **M1a（shadow）**：账本旁路写同一批事实、doctor 对账；路由器读 registry（但合法
  账本是运行前置，见上）。
- **切换**：维护门内 `authority_cutover`（legacy 全集双射对账后一次提交）。
- **M1b（authoritative）**：路由器只认账本；registry 不再动态供种，新实体只由账本
  create，legacy-only 项报"迁移不完整"；兼容投影若留必为可重建缓存、不得当第二权威。
- **`/feishu-attach` 不早于 authoritative**。

逐实体权威（authoritative 后）：实体状态/路由目标/连通投影→账本；出站发布器的
claim/回执/幂等/卡片/锁→现行发布器（第一步 §4 保留）。

## 9. 崩溃与并发正确性

原子性（单文件 + `commitWhileHeld` 内 rename）；fencing（token 核对才提交，旧写者
恢复 `lock_lost` 不覆盖）；已提交不谎报未提交（目录 fsync 失败=durability_uncertain、
放锁失败=with_residue，均已提交）；串行（symlink 锁 + reap 串行化）；不变量守恒
（G5 在 build 校验、整账本校验在建索引前）；幂等（不可覆盖 operations + 存活 proof）；
初始化/切换/retarget 均封闭事务（§5/§5.1）；维护门覆盖（写过门，初始化/切换走唯一
维护内部路径）。

## 10. P2 处置（含具体常量）

- 路径/权限：目录 0700、文件 0600；绝对路径 + 逐层 realpath 校验；同 UID 替换威胁
  边界入合同。
- 锁：`reapUnrecognized:false`、`acceptReapedResidue:false`；**`staleMs=30_000`**；
  **取锁总预算 `2_000ms` 由外层有限重试实现**（含 reap 等待，不得默默变无限等锁，
  评审四 P2），reap 等待 `200ms`。
- **operations 保留策略（评审四 P1-2，取"永不自动删"）**：operations **永不按
  '无 origin 引用'自动归档**（旧消息仍可能按 op_id 重放，删了就失幂等判据）；触顶
  只能显式扩容/迁移 schema（走维护入口），进受控"需维护"态。live/tombstone/voided
  的容量上限同前：文件 ≤ 1 MiB、live ≤ 512、operations ≤ 4096、matched_fields 固定
  4、reason ≤ 200 码点、各 id/locator 按正则上限。
  （备选：定义封闭重放有效期，超期请求必在 freshness/claim 层先被拒，之后才可删对应
  operation——本稿不采，除非评审要求。）

## 11. 落地顺序（M1）

1. 账本原语（fd 绑定读、校验器 G1–G15、`withLedgerWrite`+四态提交+operations 表
   §5.1）+ 纯合成回归：六迁移 + 创建/种子/初始化/切换/retarget 事务 compare 正反、
   tombstone 环/悬空/幂等/冲突、G3 重复 locator→corrupt、崩溃点、operations 重放
   （同/异 fingerprint）、G13 origin 相容、G14 cutover 一致、initialize ENOENT 严格。
2. 维护门接账本写面 + 唯一维护内部路径（initialize/cutover）。
3. M1a（shadow）：先 initialize_shadow、再种子 + shadow 对账 + doctor。
4. 维护门内 authority_cutover → M1b；`/feishu-attach` 此后开放。每笔行为测试（符号
   链接执行、含空格 HOME、真 shell 三场景）。
5. doctor 账本对账：族合法、tombstone 图、current 唯一、别名一一对应、operations
   完整且 origin/cutover 相容、两权威一致（M1a）/ 切换双射（M1b）。

## 12. 两处第一步建模决策（Frank 2026-09-04「按更新推荐」已拍板）

1. **binding_target 只精确 + 显式 retarget（A′）——已拍板。**
   - 绑定只认精确会话；改绑由 **owner 显式授权的 retarget 事务**完成（**不**"只剩
     一个就自动漂移"）；目标不可用先归 health。
   - 子决策：谱系内有 pending 时 retarget **一起改整条谱系**（B1 只改 target、proof
     保持 null）——已定，写入 §4.4/§5/G6。
   - **回带第一步 §3.5**：bind 原语措辞从"session↔本地**项目**"细化为"session↔
     **精确本地目标**"，并加 retarget 一句（见配套第一步订正）。

2. **A4 带旧 anchor/link 无 F4 重新 attach——已拍板（采 Codex 案）。**
   双证齐→保留 locator proof（可为继承的 pairing_merge）进 A3；全无→A2；证损坏/
   与当前 locator 冲突、或 F4 复核读到正面矛盾→attach 失败报冲突（不只 health）。
   理由：locator link proof 是"session 与 root 同话题"的历史事实，unbind/休眠/轮转
   不推翻它；"根暂时发不通"才是 health。
   - **回带第一步 §3.3**：attach 事务补一句 A4 带证据重接的处置（见配套第一步订正）。

---

前两步是本步输入；本步只落存储与锁。§12 两处 Frank 已拍板；Codex 复审放行后，
编码属 M1，按五项证据合并。
