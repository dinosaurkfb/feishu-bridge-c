# M1a 双射对账：legacy 权威 ↔ shadow 账本（v14，自包含实现合同）

> 地位：`layers-v2-ledger.md` §8『legacy 全集双射对账』的实现合同——约束 T3a（只读对账 +
> doctor，**Codex 已放行实现**）、T3b（migrate_seed / 双写 / repair）、T4（cutover 复合事务）。
> 字段事实来源：`project-resolve.mjs` / `interaction-policy-store.mjs` / `topic-generation.mjs`
> / `codex/state.mjs` / `selector.mjs`。
> **本文件自包含**（五轮 P1-1）：不引用任何已被覆盖的历史版本；全部定稿正文在此。
> 演进：v0→v14 经 Codex 十四轮评审逐轮收闭；上游合同（layers-v2-ledger.md / maintenance-gate.md）随轮真实回带。

## 1. legacy 快照：两个封闭适配器

对账 legacy 侧**只能**经这两个适配器产生：

**`collectClaudeLegacySnapshot({ registryFile, templateFile, now })`**（`templateFile` 必填，
模板是链级权威来源之一，进每条 binding 的冻结来源集合）：
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

**有效绑定状态（六轮 P1-2 封闭公式）**：
`effective_binding_status = binding_status==="retired" ? "retired"
: (enabled===false ? "paused" : binding_status)`（retired 优先，不被 disabled 覆盖）；
§2 全文的 binding 一律读 effective_binding_status。

```
0. topic_generation_state 整体校验不过（validateTopicGenerationState）→ legacy_unreadable
0b. binding 级前置（在逐代际之前）：effective_binding_status==="retired"（或全部代际 retired）
    → binding 级 blocker（binding_retired）——不逐条排除后无声通过
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

**`legacy_source_digest`（逐记录）** = `sha256(canonKey({ digest_version:"lsd-2", binding_id,
channel_generation_id, generation_status, binding_status, enabled,
effective_binding_status, root_om, aily_session, binding_target,
snapshot: 相关源文件 {path,sha256} 子集 }))`（七轮 P2-1：enabled 与有效状态显式入摘要）。
digest 不读盘：输入里的 `snapshot` 是调用方从已冻结的 snapshot_identity 里选出的子集
（`identitySubset` 按 `binding.source_identity` 逐条**纯内存**精确匹配，零文件系统调用；
逐 source 必须恰命中一项否则 fail-closed），来源变化由外层 snapshot_moved 兑底。


**family → facts 全表（封闭，六轮 P2-2）**：`facts` 五元组只取以下四组值之一，
无第五组；组内字段集固定 `{binding, session, anchor, locator_link_proof, generation}`：

| family | binding | session | anchor | locator_link_proof | generation |
| --- | --- | --- | --- | --- | --- |
| B1（初次绑定 / 轮转待认领，b1 与 b2 同表）| pending | absent | present | absent | pending |
| B3（c2）| active | present | present | present | current |
| B3′（c3，paused+active 代）| dormant | present | present | present | current |
| B4（d2）| active | present | present | present | historical |

§2 其余待修分支（b3/c1/c4/d1/d3/d4/0b）不产出记录、只产出 cutover_blockers。

### 3.1 迁移证明：独立不可变来源证明 + 生命周期组合表

migrated proof **不与当前终态 origin 绑定**——来源证明，永远为真。

**G13-mig：唯一权威定义在 §5.1（九轮 P1-1：全文只此一套判别联合，此处不复述）**。

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
| A4 双证齐无 F4 重接 → A3 | → attach | 保留旧 link（含 migrated）| **(attach, migrated) A3 仅限继承**；可执行判据（五轮 P2-1 / 六轮 P2-1 收紧）：**当前 family===A3 ∧ binding_proof.kind==="attach"** ∧ origin 指向 attach_a3 op 且其 result.affected_id===本记录 id ∧ link 的 G13-mig ①② 成立；seed/migrate_seed/migrate_repair **不得直接产出**该组合 |
| 重新配对 activate / attach+F4 | → pairing/attach | → pairing_merge/f4_anchor | migrated 被覆盖 |
| 新代际接管（旧 current→B4）| 保持原样 | 保持原样 | |

**允许表**：各族 binding/link 允许集 = 既有集 ∪ {migrated}；A1/A2/A3 不得以 migrated 被创建。

**migrate_seed**（gated、仅 `authority_mode==="shadow"`）：mutate 拿到本笔 opId 后构造记录与
proof（同笔闭合）；fingerprint = `{ request_key, candidates: 逐条 legacy 证据元组 canonKey
排序 }`；result = `{ authorized_by, authorized_at, seeded: [按 id 排序的
{ topic_agent_id, legacy_source_digest }] }`（七轮 P1-2：digest 与授权一并锚定进不可变
result，G13-mig ② 逐字核对）。

## 4. legacy 字段处置表（每行四选一 + M1b 合同）

| legacy 字段 | 处置 | M1b 合同 |
| --- | --- | --- |
| `expires_at` | 迁入 sidecar | cutover 门内生成 `ledger/<ep>/expiry.json`（封闭 schema `{schema_version, entries:{<topic_agent_id>: iso}}`、registry 锁协议、0700/0600）；到期闸与续期命令读写它；cutover 前置=无过期绑定投影 active |
| `pending_token`/`claim_expires_at` | 迁入 sidecar | `ledger/<ep>/pending-claims.json`（**bearer 凭证库**：0700/0600、fd 读、锁、内容不进诊断正文只给计数与 opaque id）；M1b 后认领=核凭证+activate；**无 token 初始 B1 合法**（owner 配对 @ 可认领），非 blocker |
| rotation 过程态 + operation identity | cutover 前清零 | 自动轮转 **M2 前禁用**（M1b 授权时向 Frank 明示）；手动轮转走 v2 事务 |
| activity / 提醒 / 轮转计数 | 退役 | 消费者禁用，随 legacy 冻结 |
| `interaction_policy_state` | 抽独立 v2 policy store（**M1b 前置块**） | `ledger/<ep>/policy.json`：封闭 schema、锁、0700/0600、fd 读；**主键 = `policy_subject_id`** = `"ps_" + sha256(canonKey({ domain:"policy_subject_v1", kind:"lineage"|"topic_agent", endpoint_id, id })).slice(0,32)`——B 谱系记录 kind=lineage、id=generation_lineage_id（=legacy effectiveBindingId 同键，轮转天然共享）；非谱系 A 记录 kind=topic_agent、id=自身。**保留/脱离规则（五轮 P1-4）**：activate 归并→subject=lineage（A1 tombstone 的自身 subject 随归并终结）；B4→A4（unbind 清 lineage）→subject 切自身 id、**初始化为空**（不继承谱系状态）；A4 reattach→保持自身。/feishu-mode 与 reserve/finalize 先解析 subject 再改。**权威切换三段（六轮 P1-3）**：
① **shadow 段**：runtime 读写 **legacy（权威）**，v2 policy store 旁路双写（同 §5 外层锁纪律：
policy 写方先取 m1a-order.lock）+ doctor policy 对账；双写失败=policy mismatch（非业务失败）；
② **cutover**：policy intended 状态作为 journal sidecar step 固定（§4.1）；
③ **authoritative**：只读写 v2 policy store，legacy policy 字段冻结。切换点=cutover 提交 |
| `status` ≠ active（非 paused 语义） | cutover 前规范化或退役 | selector 拒非 active，不得投影后放行 |
| Codex task `chat_id` 覆盖（值不变时） | 迁入 | chat_id 逐记录 |
| `inbound_state` | cutover 前清零 | drained 语义覆盖 |
| `enabled` 翻转（五轮 P1-2 定案 / 六轮公式化） | **disabled 仍进快照**，经 effective_binding_status 映为 paused（current→B3′）；恢复 enabled=restore。**disabled ∧ read-only 历史代际 → 照常落 paused_readonly 待修**（不豁免——disabled 不使双射自动成立） | 与 legacy「disabled 不路由」等价 |
| binding retire（五轮 P1-2）| **cutover blocker**（M1a 不映射；先由 owner 恢复或等 M1b 后走 v2 生命周期清理） | — |

处置表外字段承担路由语义 → `legacy_field_unmapped` 拒。

### 4.1 复合切换事务（T4；维护 journal step 机制）

1. 每 sidecar 一个 prepared step（`sidecar:expiry:<ep>` 等：before/intended SHA/备份落 journal）；
2. 逐个写 + fsync + 读回核 SHA → markStepDone；全部 done 才进 3；
3. **唯一提交点 = authority_cutover 账本写**；
4. 崩溃恢复逐 step 三分（before/intended/其它）；
4b. **sidecar step 进维护 journal 合同（六轮 P2-2）**：`sidecar` 为新 step kind，
   id=`sidecar:<name>:<ep>`、before/intended_after=内容 SHA 联合（absent 显式 null）、
   ledger_cutover 的 PHASE_REQUIRES 在 ledger_reopening/done 增列全部 sidecar steps done；
   恢复时 **pre_cutover_ledger_sha 与各 intended SHA 一律从首次 prepared journal 重放**，
   不得按变化后现场重算（maintenance-gate.md『账本接入』节同步此扩展）。
4c. **跨制品绑定核验（八轮 P1-4，authority_mode 翻转前逐项核，任一不等即停）**：
   - `pre_cutover_ledger_sha === ledger step.before.ledger_sha256`；
   - cutover 的三个 sidecar SHA 分别 === 对应 sidecar step 的 intended_after/after.sha256；
   - cutover fingerprint/result 与上述固定值逐字一致；
   - `bijection_digest` 来自**同一 pre-cutover ledger revision/snapshot** 的 reconciler 结果
     （revision 记进 prepared ledger step，提交前 CAS 复核）。
   **执行顺序（九轮 P2-1 / 十二轮 P1-2 统一）**：门内、三条 sidecar 全 done 后**重新调用
   reconciler**；只接受同一 ledger before revision/SHA 上的**完整 cutover plan 联合**
   （4e 定义；仅 {ok:true,digest} 的窄结果不足以翻转）；snapshot_moved 或 digest 改变均不得
   翻转 authority_mode。
4e. **sidecar 封闭 schema 与确定性 renderer（十二轮 P1 定稿）**：
   三个 renderer 共同输入 = **同一冻结 legacy snapshot + §3 期望集 E**；输出 = 规范字节
   `JSON.stringify(stable(doc), null, 2) + "\n"`（stable = canonKey 同源键排序递归）；
   intended 字节/SHA **只能**由 renderer 在冻结快照上产出一次。
   - **expiry-1**：`{ schema_version:"expiry-1", endpoint_id, entries:
     { <topic_agent_id>: <规范 ISO> } }`——E 中每条 live B 记录一项，值 = 其 binding 的
     expires_at **经规范化**（Date.parse→toISOString；不可解析 → legacy_unreadable）；
     空集 = `entries:{}`。
   - **pending-claims-1**：`{ schema_version:"pending-claims-1", endpoint_id, entries:
     { <B1 id>: { token: /^[0-9a-f]{6}$/ | null, claim_expires_at: 规范 ISO | null } } }`——
     仅 E 中 B1；**token===null ⇒ claim_expires_at===null**；token 形状不合 →
     legacy_unreadable；时间同上规范化。
   - **policy-1**：`{ schema_version:"policy-1", endpoint_id, entries:
     { <policy_subject_id>: <条目> } }`——条目 = **原样搬运**快照中该 binding 的
     interaction_policy_state（stable 键排序；根键集必恰为
     schema_version/binding_id/policy_id/policy_version/updated_at/dialogue 六键、并过现行
     合法性校验，超/缺键 → legacy_unreadable）；**binding_id 保留 legacy 原值**（出处字段，
     subject 只作外键）；缺席 policy 字段的 binding → Mapping 默认条目且
     **updated_at = 固定哨兵 "1970-01-01T00:00:00.000Z"**（不得取执行时钟）；
     **同 lineage 多条 B 记录投同一 subject：条目逐字相等则去重，否则
     policy_subject_conflict 拒**（不依赖覆盖顺序）。
     **条目校验唯一权威 = 封闭校验器 `interactionPolicyStateProblem`（ipsp-1）——
     现状：待落地硬前置（仓库尚无该实现，十四轮 P1-2/十五轮 P2 如实标注）**：定为
     **policy store 前置块（§9，排期 T3 后、M1b 前）的第一交付物**——六根键精确、updated_at
     规范 ISO、dialogue 为 null 或按状态机逐支封闭（active/completed/failed/cancelled ×
     active_turn/last_turn/事件字段逐键必有/可空/禁止写死）；其行为测试至少覆盖：根/嵌套
     多余键、各状态缺键、非法可空组合、非规范时间、错误 binding_id、同 subject 冲突、
     T3b 写端/T4 renderer/权威读取端**共用同一导出**的接线断言。**T4 的 policy-1 收口以该块
     落地为前置**；落地后本规格引用其确定导出与版本。
     **交叉不变量**：迁移产出的条目 kind 必为 lineage 且 `条目.binding_id === subject 派生
     输入的 lineage id`（= legacy binding_id 受验原值）；默认 Mapping 条目的 binding_id 同上。
   **两个接口分离（十二轮 P1-2）**：
   - **对账安全结果（T3a/doctor 用，§6 的联合）**：`{ ok:true, digest, snapshot_identity,
     ledger:{revision,sha256}, sidecars:{expiry:{sha256}, pending_claims:{sha256},
     policy:{sha256}} }`——**不含任何字节明文**；bytes/locator 路径/snapshot 细节不进
     doctor/CLI 输出。
   - **cutover plan（T4 私有判别联合，4c/4e/journal 消费方唯一指向）**：对账安全结果 ∪
     三个 **staged intended blob 的受验引用**——推进 ledger_cutting_over **前**，renderer
     产出的三个 intended 字节以 0600、O_EXCL、fd 绑定写入 `<token>.staged/intended/<name>`
     并 fsync，prepared step 登记受验路径+长度+SHA；**journal 不存明文**（bearer token 不进
     journal/日志）；恢复只读 staged blob（十二轮 P1-1：不得重渲染、不得凭 SHA 还原）；
     blob 写不下或读回核不过 → **不得进入 forward-only**；B-4 3b 负责删除。
     plan 任一字段缺失 → 不得 cutover。
   **plan.json 精确联合（十四轮 P1-1）= `m1a-cutover-plan-1`**：
   `{ schema_version:"m1a-cutover-plan-1", operation_token, endpoint_id, digest,
   snapshot_identity, ledger:{ revision, sha256 }, sidecars:{ expiry:{sha256},
   pending_claims:{sha256}, policy:{sha256} } }`（恰此键集；无字节明文）。
   **交叉等式（校验器逐条核，任一不等拒）**：① operation_token/endpoint_id === 当前
   operation 的 token/endpoint；② 三个 sidecars.sha256 分别 === 对应 step 的
   intended_blob.sha256 === intended_after.sha256；③ ledger{revision,sha256} === 首次
   reconciler 结果；④ digest 与 snapshot_identity === 首次 reconciler 结果；⑤ journal 的
   plan_sha256 === 受验读取的 manifest 原始字节 SHA。
   **plan 锚与崩溃恢复（十三轮 P1-1 / 十六轮 P2 持久链）**：`<token>.staged/` 与 `intended/`
   若为新建，**逐层 0700 创建并 fsync 各自父目录**；四文件逐个 O_EXCL 写满 fsync、再 fsync
   `intended/` 目录——**全部屏障成功后**才允许写进段原子 journal 提交（见 gate 阶段表）；其
   SHA 锚进 cutover ledger step 状态对象的 `plan_sha256`——重启后一切引用凭 journal 锚复核，
   进程内状态不作数。
   **崩在 blob 写后、阶段提交前（journal 仍 drained）**：同 operation 重试先验 manifest+四文件
   （逐一受验 SHA），全符 → **复用**（不重 O_EXCL、不生成第二份 plan）；部分在场/不符 → 拒并
   要求安全退出；**安全退出（回退路径）必须删除 staged/intended 目录**——**删除失败：
   journal 保持 `drained`、记 `cleanup_pending` 诊断（非 terminal），保留门与 active、
   退出码 3；后续 `--exit` 必先重试清理，清理成功后才进入普通安全回退**（十四/十六轮 P2）；
   非 active operation 的该目录 = 敏感残骸，doctor 点名（不自动清）。
   **门内第二次 reconciler 调用 = 按已锚 plan 验证**（同快照同 revision 重验四件相等），
   **不得重新 staging、不得产出另一份 plan**。
4e-2. **三份 sidecar 权威文件的读取端 validator 合同（十三轮 P2）**：根键集精确 =
   `{schema_version, endpoint_id, entries}` 三键（各自 schema_version 串如上）；entries 数量
   上限 512、单文件字节上限 1 MiB（超限 → 对应 sidecar_unreadable fail-closed）；读取端一律
   fd 绑定读（O_NOFOLLOW、普通文件、单硬链接、0600；目录 0700），任一不符 fail-closed；
   条目值域如 4e 各 schema 所列。
4f. **endpoint 交叉绑定不变量（十一轮 P1-2 取 b：只用可复核事实，不引用 result/瞬时
   intent）**：账本顶层 `endpoint_id`、cutover **fingerprint 输入的 endpoint_id**、ledger
   step 的 endpoint（id/target）、三条 sidecar 的 id `<ep>` 与重算 target ——**五源必全部
   相等**（校验器逐项比对，任一不等 → journal 非法）；cutover result 不加 endpoint 字段。
4d. **sidecar 的维护窄写路径（八轮 P1-5）**：三个 sidecar 在门内的写**不走** gated（会被门挡）
   也**不开通用 ungated API**——各定义一个维护窄 writer：绑定 operation token + lease + gate +
   journal prepared step（与账本 capability 同一纪律：读实文件核验后才写），fenced commit；
   锁序 = 安装面锁 → lease/active/gate → **sidecar 文件锁 → 账本锁**（sidecar 先于账本，
   与 §4.1 顺序 2→3 一致）。
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
| 两链所有 A1 物化入口（任一受验首条 @ 的 chat 记录——不由 Dialogue policy 限定，八轮 P2-2） | create_a1 | ext=入站 message id；**entity=受验 Aily session locator**（预先确定，非随机 ta id） |
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
**清单封闭**：表外 legacy 写方影响投影 = 设计缺口，先补表再上线；**实现测试须反向证明表内
所有 legacy 写入口都先取得 m1a-order.lock**（八轮 P2-2）。

**migrate_repair = 重新受验迁移（六轮 P1-1 定案，取 b）**（gated、shadow-only、owner 逐次
授权）：语义 = "按当前 legacy 证据重新迁移这一条记录"——**连同 proof 一起更新**：
facts/aliases/target 改到与 legacy 投影一致，migrated 双 proof 以本笔 repair op 重签
（migration_operation_id = 本 repair opId、legacy_source_digest = 当前证据重算）。
**适用范围 = 精确两支判别联合（八轮 P1-1 定稿，全文以此为准）**：
- **B1 → B1**：proof 始终全 null（repair 只对齐 facts/aliases/target）；
- **{B3, B3′, B4} 双 migrated → {B3, B3′, B4}**：双 proof 由本 repair op 重签，且
  `result.from_family` / `result.to_family` 必分别等于执行前/后实际族；
- **其余一律拒 `repair_scope`**：A4（即使双 migrated——只能走 attach）、任一真实生命周期
  proof（pairing/attach/retarget/f4）、以及任何表外组合。

fingerprint = `{ request_key, topic_agent_id, expected_projection_digest,
next_projection_digest }`；CAS：现投影 digest ≠ expected → repair_cas_mismatch；
result = `{ repaired_id, from_family, to_family, expected_projection_digest,
next_projection_digest, legacy_source_digest, authorized_by, authorized_at }`；
**G13-mig（唯一权威定义，九轮 P1-1）**：任一 proof 为 migrated ⇒
migration_operation_id 指向 op_type ∈ {migrate_seed, migrate_repair} 的存在 op；
migrate_seed：`result.seeded` 含 `{topic_agent_id:本 id, legacy_source_digest}` 且与 proof
digest 逐字相等；migrate_repair：`result.repaired_id===本 id` 且 `result.legacy_source_digest`
与 proof 逐字相等；**binding migrated proof 的 authorized_by/authorized_at 必与对应 op
result 逐字相等**；link 与 binding 的 migrated proof 引用**同一 op 与同一 digest**；
**G13-repair**：origin 指向 repair ⇒ ① 现投影 digest 重算===result.next；② result 两投影
digest 与 fingerprint 逐字相等；③ repaired_id===本记录 id。

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

**结果联合（封闭，逐支字段固定，八轮 P2-1）**：

**结果联合（封闭；此为 T3a/doctor 的对账安全接口，成功支携带 §4.1-4e 的安全字段集，
不含字节明文）**：`{ ok:true, digest, snapshot_identity, ledger:{revision,sha256},
sidecars:{expiry:{sha256},pending_claims:{sha256},policy:{sha256}} }` |
`{ ok:null, reason:"snapshot_moved", why }` |
`{ ok:false, reason, why, mismatches:[{ code, topic_agent_id|null, field|null, detail }] }`；
**T4 只认 §4.1-4e 的 cutover plan 判别联合**（本联合的窄成功支不足以 cutover）。

- `{ ok:true, digest, cutover_blockers, snapshot_identity }` —— 双射成立；cutover_blockers
  可非空（如 0b binding_retired），任一存在则 cutover 拒但 doctor 报确定性红（cutover_blocked）；
- `{ ok:null, reason:"snapshot_moved", why }` —— inconclusive；cutover 视同不通过重试；
  doctor 整体 incomplete、**不得生成或复用 readiness/cutover 凭据**；
结果**判别联合**（复评 P2-1/P2-3：每支只带该支的键，精确键集如下，不统一塞 mismatches:[]）：

- `ok:true` → `{ ok, digest, cutover_blockers, snapshot_identity }`。
- `ok:null`（snapshot_moved，S1/L1 已取得）→ `{ ok:null, reason:"snapshot_moved", why }`。
- S1 取得后的失败 → `{ ok:false, reason:"bijection_mismatch", mismatches, cutover_blockers, snapshot_identity }`
  （mismatches 是全清单，元素 `{code, topic_agent_id|null, field|null, detail}`，
  code ∈ extra_in_legacy | extra_in_shadow | field_mismatch）。
- S1 取得前的失败（不携带 snapshot_identity / mismatches，不伪造身份）：
  - `ledger_<载入失败码>` → `{ ok:false, reason, why }`（why 仅供日志，不进 doctor 正文）；
  - `not_shadow` / `chain_mismatch` → `{ ok:false, reason }`；
  - `legacy_unreadable` → `{ ok:false, reason, source, why }`（source 是**封闭来源域**：
    args | chain-template | codex-registry | codex-task-state | project-mapping | registry |
    snapshot-identity | topic-generation-state；出界值在出口折 `invalid-source`，
    不许带索引/野值穿过结果联合的 JSON 边界进 doctor 正文）；
  - `legacy_unreconcilable` → `{ ok:false, reason, source, why, cutover_blockers, global:"rotation_preparing" }`。


## 7. doctor 输出纪律

问题码 + opaque id/字段名/哈希；**不得原样输出 locator/session/thread/项目路径**；上限
10 条 + "另 N 条"；完整清单由维护写入口（T3b）随 op 落 0600 制品，doctor 纯体检
**零写入**（与全局体检纪律一致：一个字节都不改），只给正文摘要。
**shadow 账本 absent 按初始化收据分支（六轮 P1-4，与账本规格 WAL/永久收据一致）**：
- 收据 never_initialized ∧ ledger absent → 未初始化，跳过（不红）；
- 收据 prepared（未完成 init WAL）→ 按 B-2 恢复矩阵报告（只允许同 token 恢复）；
- 收据 initialized/cutover ∧ ledger absent/unreadable → **ledger_missing 红**、禁止重初始化；
- 收据 unreadable/conflict → fail-closed 红。

## 8. owner 待修流程

终端命令：owner 逐次授权、preview/apply、精确对象 id、expected-before CAS、operation 审计
留痕；`session_missing` 只能由真实 owner 配对（@ + F4）补绑，终端不得直接填 session。

## 9. 排期影响

- **新前置块 = v2 policy store 抽取**（§4；T3 之后、M1b 之前；含读写方迁移与 cutover step 接线）；
- cutover 复合事务（§4.1）扩展 R16 编排——归 T4/M1b；
- T3a（§1/§2/§3 投影/§6/§7）已开 #R19 实现；T3b（§3.1/§5）与 T4（§4.1）以本 v14 为合同。
