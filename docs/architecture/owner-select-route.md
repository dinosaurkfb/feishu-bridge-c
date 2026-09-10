# owner_select 行政选择配对：位置维的诚实来源（设计稿 v16 · Codex 放行）

> 2026-09-07 起草（v1）→ Codex 十六轮评审收敛（v2–v16）。**状态：Codex 十六轮放行——「v16 已达到
> 可直译合同标准，无新增 P1，可作为实现合同放行」。证据层级 = 文档静态封闭性核验，不代表实现或真实
> 链路已验证（实现单每步仍走行为测试 + Codex 独立复核 + 五项证据）。** 十六轮唯一非阻断 P2（§6 的
> `cleanup_pending` 非阶段名）已按权威阶段机统一为 `rollback_incomplete`。v16 并入十五轮 1 P1。此前 v7 并入六轮 5 P1 + 2 P2（均按**实测的真实账本合同**落地，非纸面猜测）：
> - P1-1 §6 产证/保留改用 result 里**按记录的封闭有序 `proof_effects`**（旧扁平 effect 表达不了
>   activate 同笔产 B3+降旧 current）；G13′（§7.2）据此逐记录判。
> - P1-2 §6 handle 事务消不可执行分支：B1 到期=既有 `void(reason=expired)`（不另立 op，避 op_type↔
>   terminal_kind 冲突）；A2 到期=独立 `clear_anchor_handle`；cancel/reissue **不核 now≥expiry**；
>   reaffirm result 按 binding_effect 拆两个无可选键的精确键集；migrate_seed(B1) 不改、handle 由
>   campaign 内 `mint_selection_handles` 补。
> - P1-3 §7.2 新增整账本不变量 **G-handle**（handle 溯源到产生 op result + endpoint 内全局唯一 +
>   因果链闭合）；A2 复用**既有** `anchor_candidate` 字段（不另造 `anchor_candidate_root`）。
> - P1-4 §8 迁移状态机拆 **operation A（old→transition+mint，撤门）+ 持久 campaign + operation B
>   （transition→strict+writer_enable）**；A/B 间新 endpoint 直接入 transition 并原子加入 campaign；
>   `writer_enable`=唯一 CAS 的机器级 `owner_select_writer_state`（四态读取器），不只审计 step。
> - P1-5 §8.1 reaffirm intent：**reaffirm_handle 即不可变 intent id**；锁序修正为
>   `outer→legacy(取完即释)→intent→ledger`（与 m1a 一致、sidecar 先于 ledger）；补 no-existing/
>   digest 双 CAS、清理事务、消费侧 sender/endpoint/chat 核验、unreadable 阻断。
> - P1-6 §6/§8 `schema_upgrade` ledger op 只终态、prepared/done 归机器级 journal step。
> - P2-1 §7.2 G15′ handle 前缀↔来源 op（**activate/anchor** 只 osh_，attach_a3 已停产不列）。
> - P2-2 §13 多候选标签来源持久（op result 序号/受验创建时间，不临时排序）。
>
> **本文档不含真实 endpoint_id/locator（占位 `<endpoint>`）。op 名以权威账本为准（实测：
> `create_b1`/`activate`/`attach_a2`/`attach_a3`/`anchor`/`rebind_session_alias`/`restore`/
> `retarget`/`void`/`migrate_seed`）。Frank 2026-09-06 已拍板采纳本模式。** （历史 v1–v6 见 git。）

## 0–2 一句话 / 问题 / 模型

（同 v4，无实质改动，压缩）配对需三维都诚实：身份（路由层核 owner）、session（Aily 天然给）、
root_om 位置（桥建 pending 自持）。旧 F4 用传输证据（bearer 码 / thread_root）推断关联，root-blind
下 thread_root 无诚实来源。owner_select 把关联改成 **owner 一次显式行政声明**——不声称平台同话题，
只记 **owner 授权的 session→root 路由关联**。**锁内栅栏**：入站 session 受验 chat_id===被选候选
chat_id、同 endpoint、handle 与候选一一映射且 eligible、owner 先验先于 handle 解析。handle 是
**非授权凭证的 opaque selector**（P2-2）：单凭它不取任何权限，授权全来自 owner 先验，且单次消费。

## 3. 证明形状（封闭；kind 版本化）

### 3.1 `binding_proof` 新支 `owner_select_v1`
```
{ kind:"owner_select_v1", authorized_by, authorized_at,
  selected_session_id, selected_root_om, selection_handle, selection_operation_id }
```
- `authorized_by`=写时核 owner（校验期只核不可变来源——P2-1）；`selected_session_id`===
  `aliases.session_id`、`selected_root_om`===`aliases.root_om`（G11′）；
- **`selection_operation_id`=产生或最近重签该 proof 的不可变来源 op id**（非当前终态 op，P1-1）；
- `selection_message_id` 落 op result、不入 proof。

### 3.2 `locator_link_proof_ref` 新形状 `owner_selected_route_v1`
```
{ kind:"owner_selected_route_v1", by_identity:"owner_authorization",
  authorized_by, authorized_at, selected_session_id, selected_root_om,
  selection_handle, selection_operation_id }
```
六字段等式**仅 binding=owner_select_v1** 时成立（§6 G13′-A）；否则 link 独立经自身来源 op 校验
（G13′-B）。

### 3.3 停产：过渡 schema 合法容旧+新；严格 schema 一律拒旧形（`legacy_pairing_shape`）。不做
按 origin/op_type 猜存量的双读。

## 4. handle 协议（两枚稳态字段 + 一枚迁移期 intent store——P1-2/P1-6）

| handle | 落盘 | 合法族（非 null / 存在） | 生成 op | 过期字段 | 失效/清理 |
| --- | --- | --- | --- | --- | --- |
| `selection_handle`（`osh_`+32hex） | live 字段 | **B1（strict 必非空；transition 可为 null 作 blocker）；A2（可空）** | `create_b1`（B1）；`mint_selection_handles`（迁移期既存 null-handle B1）；`attach_a2`（A2）（**`migrate_seed(B1)` 留 null、不签 handle**——P2-1） | `handle_expires_at`（持久规范时间） | B1→`void(reason=expired)`；A2→`clear_anchor_handle`；`reissue_selection_handle`；消费 `activate`/`anchor` |
| `rebind_handle`（`orh_`+32hex） | live 字段 | 待 rebind 的 B3 | `request_rebind` | `rebind_expires_at` | `rebind_session_alias`/`expire_rebind_handle`/`cancel_rebind` |
| `reaffirm_handle`（`rfh_`+32hex） | **sidecar** `ledger/<endpoint>/reaffirm-intents.json`（**迁移期专用**，0700/0600、fd 读、锁；同 m1a sidecar 纪律） | 待 reaffirm 的 B3/B3′/B4/A3/A4（**稳态 live schema 不含此字段**，P1-6） | `request_reaffirm`（intent store 写） | intent 内 `expires_at` | `owner_select_reaffirm`/intent 过期清理 |

**族闭合（P1-2 关键）**：

- **B1：strict 必有 osh_；transition 允许双 null 作 blocker**（八轮 P2-1，与 §8 一致）：
  `selection_handle` 到期 → 走既有 **`void(reason=expired)`**（转 voided_audit），或未到期主动
  `reissue_selection_handle`；**strict 下绝不保留 `selection_handle=null` 的 B1**（否则违族）。
- **A2 可无 handle**：允许显式"无 eligible handle"的 A2（`selection_handle=null` 合法——暂不可锚、
  投影仍 A2 降级）；`clear_anchor_handle`(A2) 清、`reissue_selection_handle`(A2) 换发新 osh_。
- **A2 handle 锚既有 `anchor_candidate` 字段（P1-2/P1-3 防改指，复用账本既有字段不另造）**：
  `attach_a2` 时该 A2 的既有 live 字段 `anchor_candidate` 即候选 root；`anchor` 的 fingerprint/
  compare **含 `expected_handle`、`expected_expires_at`、`expected_anchor_candidate`**，且最终
  `selected_root_om === anchor_candidate`——**拿合法 handle 改指任意 root 被此等式挡死**。

**跨字段联合（G11′ 逐族核——P1-2）**：B1 的 `selection_handle` 与 `handle_expires_at`：**transition 下必同时空或同时非空、strict 下必
同时非空**（九轮 P2-1，按 schema 限定）；A2 的 `selection_handle`/`handle_expires_at` **必同时空或同时非空**（非空时另需既有
`anchor_candidate` 在，才可 `anchor`）；rebind 的 `rebind_handle`/`rebind_expires_at` **必同时有
或同时无**。任一半有半无 = 损坏。

**到期比较（P2-3）**：一律"持久化规范时间字段 + **锁内当前时间**比较"，**不依赖内存 timer**。
**只有到期类事务核 `now ≥ expected_expires_at`**（B1 `void(expired)`、A2/rebind 的到期清理）；**消费 handle 的事务（`activate` 消费 B1 handle、`anchor` 消费 A2 handle、`rebind_session_alias` 消费 rebind handle）在锁内 CAS 之后还要复核 `clock() < 记录上持久化的到期字段`，等于或超过即拒（`handle_expired`）——锁外候选解析按 now 过滤不算数（#146 一轮 P1-1 回带）**；
**主动 `cancel_*`/`reissue_*` 不核时间**（可未到期做，P1-2）。清理/换发 fingerprint 一律含
`expected_handle` + `expected_expires_at`（expected-value CAS，防陈旧定时器清掉后换发的新 handle）。
**具体 TTL 数值必须在实现单开工前拍定为单一常量**（不可"字段已进 schema、有效期由各调用方自定"，
P2-2/P2-3）。
**TTL 拍定（2026-09-09，R57a/R57b 开工前）**：`selection_handle` 与 `rebind_handle` 一律用账本模块唯一常量 `OWNER_SELECT_HANDLE_TTL_MS`（30 天，R51 已落地）；reaffirm intent 的 `expires_at = issued_at + OWNER_SELECT_REAFFIRM_TTL_MS`（7 天，新常量，同模块）。不再有第三个 TTL。

**其余**：128-bit CSPRNG；endpoint 级作用域；**不进** pending-claims bearer 库；owner 先验先于
解析、不豁免任何闸；`selection_message_id` 在 fingerprint 内保重放幂等；**随机 handle 不进
fingerprint、仅进 commit 后 result**（P1-3，同 key 重放返存量）。

## 5. 候选解析规则（显式 vs 省略——P1-3）

**候选集合**固定为：同 endpoint、同受验 chat、未过期、**动作类型相符**的记录。

- **显式 `osh_`**：命中**恰一个** eligible B1 或 A2（该 handle 唯一确定其目标，**不要求候选集合
  size==1**——handle 的用途正是从多候选精确选）；`selection_basis=explicit_handle`。
- **显式 `orh_`**：命中**恰一个** eligible 待 rebind B3，**不盘点 B1**；`selection_basis=rebind`。
- **省略 handle**：才要求相应**候选集合恰一**（`unique_candidate`）；多候选 → 拒并列 handle
  引导（§13 边界）。

`unique_pending` 只作用于**省略**分支；显式 handle 分支不受它约束。

## 6. operation 联合（**增量over 基线**；权威 op 名——P1-1/P1-4）

**本表只列 owner_select 对既有账本 op 合同的增量（append）——既有 fingerprint 输入与 result 键
（chat_id/root_om/lineage_id/binding_target/topic_agent_id/claim_key 等）原样保留，基线见
`ledger` §5/§5.1（P1-1：不是完整替换，避免同 key 换既有业务输入被误判重放）。** 同 key 换任一
既有或新增输入 = request_conflict 不变。

**proof 来源 op 集** = {`activate`, `anchor`, `rebind_session_alias`, `owner_select_reaffirm`}
（**删 `attach_a3`**——P1-3：osh_ 只落 B1/A2，A1 无 handle，owner_select 的 A1 路径是
`attach_a2`(→A2 签 handle) 再 `anchor`(→A3)，不走直配 attach_a3；`create_b1`/`attach_a2` 只签
handle、不产 link proof）。

**通则**：`selection_operation_id`=产生/重签 proof 的 op map key（op id 派生自 request_key、不作
自身 fingerprint 输入）；随机 handle **只进 result、不进 fingerprint**；request_key 逐 op 可重复
派生（rebind/reaffirm 复发用**各自持久控制 id**，不复用原 claim key；reaffirm 目标未必有 claim key）。

**「授权/选择六字段」的确切名（R48 验收回带：此前只写"六字段"未逐字列出）** = §3.1 proof 的六个字段名
**原样**进 result：`authorized_by, authorized_at, selected_session_id, selected_root_om, selection_handle,
selection_operation_id`；activate / anchor / rebind_session_alias 的增量 result 都带这六个（外加
`selection_message_id`、`selection_basis`），且 result 的 `selection_operation_id` === 本 op 自己的 operations
map key；G13′-A 的"result 字段与 proof 逐字等"即这六名逐字比。`owner_select_reaffirm` 不拷六字段，用
`new_binding_proof`/`new_link_proof` 整体 canonKey 逐字比。

**每 op 的产证/保留由 result 里的封闭有序投影 `proof_effects` 表达（P1-1：不是单个全局 effect
——activate 同笔既产新 B3 又保留旧 current，扁平字段表达不了）**：

```
proof_effects:[ { topic_agent_id, binding_effect:"produced|preserved|none",
                  link_effect:"produced|preserved|none" } …有序 ]
```

**受影响集是明确的 result 字段（八轮 P1-1）**：每个相关 op 的 result 含有序字段
`affected_live_ids_after_commit` = **本 op 提交后仍为 live 且 `origin_operation_id === 本 op` 的
全部记录 id**（按 id 排序）。`proof_effects` 的 id 集 **恰等于**（不是子集）`affected_live_ids_after_commit` 中**提交后至少一面
proof 非 null 的记录集**（十轮 P1-1）；**tombstone 只进 tombstone result（`tombstoned_id` 等），
不进这两个集合**（activate 的 A1 提交后已是 tombstone，故不在集内）。G-handle/G13′ 读的就是这两个
字段。**本表列明、且提交后留下 origin 指向本 op 的 live 记录的事务，都必须带这两个字段**（十轮 P2 收窄：
`create_a1` 不在本表、`void` 提交后无 live 记录——二者不带；每 op 唯一 effect 表，取值按"本笔是否
生成了新的那一面 proof"）：
- `unbind`/`restore`：`preserved/preserved`；
- `retarget`：**按 §6 表 retarget 行的状态公式**（B1 不进；其余 binding=produced；link 按提交后
  null/非 null → none/preserved）——不再写概括值（十二轮 P1-1 消残留矛盾）；
- `attach_a3`(A4→A3 继承)：**`produced/preserved`**（本笔生成新的 attach binding proof，link 继承）；
- `attach_a2`：`produced/none`；
- `request_rebind`、`expire_rebind_handle`/`cancel_rebind`：`preserved/preserved`；
- `clear_anchor_handle`、`reissue_selection_handle`(A2)：`preserved/none`；
- `mint_selection_handles`(B1)、`reissue_selection_handle`(B1)：proof 皆 null → 在
  `affected_live_ids_after_commit` 内，**`proof_effects` 恰为空数组 `[]`**（九轮 P1-1：不写 none/none）。

**每个具体 result 键集都逐字列出 `affected_live_ids_after_commit`（不靠表外通则隐含，九轮 P1-1）；
既有 `unbind`/`restore`/`retarget`/`attach_a3` 的增量也进下表。回带 `ledger` §5.1 时同步扩这些封闭
键集——否则现行 `operationProblem` 的封闭 result 校验会把新增键判 extra。**
（§7 要求 preserved 者，这里同步扩其 result 增量——不再只在校验侧要求。）

| op | **新增** fingerprint 输入 | **新增** result 键 |
| --- | --- | --- |
| `create_b1` | （无新增；handle 随机不进 fp） | `selection_handle`, `handle_expires_at`, `affected_live_ids_after_commit:[b1_id]`, `proof_effects:[]` |
| `attach_a2` | `expected_anchor_candidate`（=既有 live 字段 `anchor_candidate`，**不另造字段**，P1-3） | `selection_handle`, `handle_expires_at`（锚到既有 `anchor_candidate`）, `affected_live_ids_after_commit:[a2_id]`, `proof_effects:[{a2_id, produced, none}]` |
| `activate` | 选择五元 `selected_session_id, selected_root_om, selection_handle, selection_message_id, selection_basis`（**增量形不收 f4**——传了 → bad_input；proof 只用 owner_select_v1 六字段，#147 一轮 P1-5 回带） | 授权/选择六字段 + `selection_message_id` + `selection_basis` + **`affected_live_ids_after_commit`**（=[surviving_id, demoted_historical_id?] 排序）+ **`proof_effects`**（surviving_id=produced/produced、demoted_historical_id=preserved/preserved；**tombstoned_id 只在 tombstone result、不进这两集**，八轮 P1-1）。**键名以账本基线为准**（`surviving_id/tombstoned_id/demoted_historical_id`，ledger §5.1）——增量只追加、不改名（R48 验收回带：此前本表写的 `demoted_current_id`/`tombstoned_a1_id` 是与基线不一致的笔误） |
| `anchor` | 选择五元 + `expected_handle, expected_expires_at, expected_anchor_candidate` | 授权/选择六字段 + `selection_message_id` + `selection_basis` + **`expected_anchor_candidate`**（result 复述 CAS 输入；shape 钉 `=== selected_root_om`，G13 钉 `=== A3 记录保留的 anchor_candidate`——`anchor` 不清该字段，PR #133 二轮 P1-3 回带） + `affected_live_ids_after_commit:[a3_id]` + `proof_effects`（a3_id=**`{binding_effect:"preserved", link_effect:"produced"}`**——binding 仍是 attach 显式授权、只补 link，七轮 P1-1） |
| `request_rebind` | `expected_b3_id, expected_current_generation, expected_old_session_id, expect_no_handle:true`（**CAS**） | `rebind_handle`, `rebind_expires_at`, `affected_live_ids_after_commit:[b3_id]`, `proof_effects:[{b3_id, preserved, preserved}]` |
| `rebind_session_alias` | `old_session_id, new_session_id, rebind_handle, expected_expires_at, selection_message_id` | `old_session_id, new_session_id, selection_handle(=orh_消费值), selected_root_om, selected_session_id(=new), authorized_by, authorized_at, tombstoned_a1_id\|null, selection_message_id, selection_basis:"rebind", affected_live_ids_after_commit:[b3_id], proof_effects:[{b3_id, binding_effect:(原 binding.kind==="owner_select_v1" ? "produced" : "preserved"), link_effect:"produced"}]`（十轮 P1-1 逐分支确定：原 binding 为 owner_select_v1 时六字段重签=produced，否则保持=preserved；link 一律重签=produced） |
| `owner_select_reaffirm`（**ledger op，消费 intent**——P1-5） | `target_id, reaffirm_handle, expected_old_proof_closure_digest, selected_session_id, selected_root_om, selection_message_id` | **按 binding_effect 分两个精确键集（P1-2，无可选键）**：produced 支 `{target_id, affected_live_ids_after_commit:[target_id], proof_effects:[{target_id, "produced", "produced"}], new_binding_proof:<owner_select_v1 全字段 §3.1>, new_link_proof:<owner_selected_route_v1 全字段 §3.2>, tombstone_remap:[{old_tomb_id, new_proof_ref:{kind:"owner_select_merge_v1", selection_operation_id, selected_root_om, selection_handle}}…按 old_tomb_id 排序], selection_message_id}`；preserved 支 `{target_id, affected_live_ids_after_commit:[target_id], proof_effects:[{target_id, "preserved", "produced"}], new_link_proof:<owner_selected_route_v1 全字段>, tombstone_remap:[同上], selection_message_id}`（无 new_binding_proof 键；十轮 P1-1 逐字段展开） |
| `clear_anchor_handle`(A2 到期/主动清；**独立 op、独立 result union**，P1-2) | `target_id, expected_handle, expected_expires_at`（CAS；到期触发时另核 now≥expected_expires_at，主动清则不核时间） | `{ cleared:["selection_handle","handle_expires_at"], affected_live_ids_after_commit:[a2_id], proof_effects:[{a2_id, preserved, none}] }`（A2→无 eligible handle 合法态；`anchor_candidate` 是独立既有字段、不在此清） |
| `reissue_selection_handle`(B1/A2) | `target_id, expected_handle\|null, expected_expires_at\|null` + **A2 另 `expected_anchor_candidate`**（CAS；**不核 now≥expiry**——换发可在未到期主动做，P1-2；候选 CAS 七轮 P1-3） | `new_handle`, `new_expires_at`, **A2 另 `anchor_candidate`**, `affected_live_ids_after_commit:[target_id]`, `proof_effects`（B1: **`[]`**；A2: `[{a2_id, preserved, none}]`） |
| `expire_rebind_handle`(到期) / `cancel_rebind`(主动) | `target_id, expected_handle, expected_expires_at`（CAS；expire 核 now≥expected_expires_at，cancel 不核时间，P1-2） | `{ cleared:["rebind_handle","rebind_expires_at"], affected_live_ids_after_commit:[b3_id], proof_effects:[{b3_id, preserved, preserved}] }` |
| 既有 `unbind`(A3/B3→A4/B3′) / `restore`(B3′→B3) | （无新增） | `affected_live_ids_after_commit:[id]`, `proof_effects:[{id, preserved, preserved}]` |
| 既有 `retarget`（单位=record 或**整 lineage**，ledger §5.1/§12-1） | （无新增） | **`affected_live_ids_after_commit === result.affected_ids`**（既有有序字段；谱系时含 B1/B3/B3′/B4 全部）；`proof_effects` 按**状态公式、不按族枚举**（十一轮 P1-1：同时覆盖 A2、无 link 与保留 link 两种 A4、全部 A3/B 族）：**B1 在 affected 内但不进 proof_effects**（双 proof 仍 null）；其余 affected 记录一律 `binding_effect:"produced"`；`link_effect` = 提交后 `locator_link_proof_ref===null` → `"none"`，非 null → `"preserved"` |
| 既有 `attach_a3`（A4→A3 继承） | （无新增） | `affected_live_ids_after_commit:[a3_id]`, `proof_effects:[{a3_id, produced, preserved}]`（新 attach binding proof、link 继承） |

**B1 handle 到期 = `void`，且 `void` 收成按 `reason` 的封闭联合（P1-2；七轮 P1-2 补 stale-timer
CAS）**：op_type↔terminal_kind 一一对应、每 op 单 result union（ledger §303），故不另立 expire op；
但现行 `void` fingerprint 只有 `b1_id, reason`，旧定时器仍可在换发后作废新 handle 对应的 B1。改为
**`void` fingerprint 按 `reason` 判别**：
- `reason=expired`：**必须额外带 `expected_handle, expected_expires_at`**，锁内核
  `now ≥ expected_expires_at ∧ expected_handle === 当前 selection_handle ∧ expected_expires_at === 当前
  handle_expires_at`（CAS——八轮 P1-2：否则同 handle 续期/异常重物化后，旧到期任务仍可作废新有效期）；
- `reason=manual|superseded`：这两键**显式 null**（各走固定分支，不核时间；**也不据此要求当前 B1 的 handle 为 null**——带 handle 的 B1 同样可被 manual/superseded 清，只有 `expired` 做持久 handle/expiry 的 CAS，#144 五轮 P1-1 回带）。
result：**1.0 / 升级边界前旧形 `{voided_id}`；边界后新形 `{voided_id, expected_handle, expected_expires_at}`**（把指纹输入固化进不可变 result，#144 四轮/五轮回带）。**整本校验器钉 reason 联合**（reason 从不可变 `voided_audit` 取）：`expired ⇔ 双键非空`、`manual|superseded ⇔ 双键 null`，不符 → `ledger_corrupt`——写入口守卫不能替代整本校验。**绝不保留 `selection_handle=null` 的 strict B1**（transition 见 §8）。

**`migrate_seed(B1)` 不改（P1-3）**：其 result 保持 `{authorized_by, authorized_at, seeded:[...]}`
（ledger §285），**seeded B1 的 `selection_handle` 初始为 null**（过渡 schema 合法）；handle 由
迁移 campaign 的 **in-gate `mint_selection_handles` op**（对既存 null-handle B1 幂等铸、把随机
handle 写进该 op 不可变 result）补齐，见 §8。

**`schema_upgrade` 是账本终态 op、不承载 prepared（P1-6）**：endpoint ledger 内 `schema_upgrade`
result = `{ endpoint, from_schema, to_schema }`（**只已提交终态**）；prepared/done 属**机器级维护
journal step**（§8），不进 ledger op result。

**`mint_selection_handles`（一笔原子复合 op，进 operations 唯一联合——七轮 P1-2；十二轮 P1-2 改为
复合：消 N 笔独立提交的崩溃前缀）**：**同一次 `withLedgerWrite` 单文件 rename 提交里为该 endpoint
全部 null-handle B1 铸 handle**（要么全发生要么没发生，**无中间态**）；fingerprint = request_key +
`{ endpoint, expected_null_b1_ids:[有序] }`（**确定性输入**：进 forward 段时盘点到的 null-B1 id 集；
随机 handle 不进 fp）；request_key ext=迁移 campaign 的持久 operation token、entity=endpoint；
compare = **`current_null_b1_ids === expected_null_b1_ids`（集合相等，十四轮：不只逐项确认 expected
仍为空——出现额外 null-B1 也整笔拒，避免漏铸）**（**整笔 CAS**：不等 → 整笔 `no_change`/`conflict`，
不部分铸、不替当前 campaign 请求报成功）；**幂等只按现行 request_key 合同**（八轮 P1-2）：同 request_key+fingerprint 才是重放（返回已存
全部 handle，崩溃重试由已落 operations 记录命中）；result = `{ endpoint, minted:[按 target_id 排序的
{ target_id, selection_handle, handle_expires_at }], affected_live_ids_after_commit:[=minted[*].target_id
有序], proof_effects:[] }`；`result_revision === before.revision + 1`。
**mint plan（十四轮 P1：提交前随机计划必须有可恢复来源——沿用已验证的 T4 staged-plan 工艺）**：
handle 仍 128-bit CSPRNG，但**只在进 forward-only 段之前生成一次并固化进不可变 plan**：
`<token>.staged/intended/mint-<ep>.json`，O_EXCL/0600 写满 → fsync → **fsync `intended/` 目录**；plan
封闭内容 = `{ plan_kind:"owner_select_mint_plan_v1", token, campaign_id, endpoint, request_key, **operation_id**（R51 补：mint op 的
key 冻结进 plan，否则 expected_ledger_sha256 无法确定性重放）,
frozen_at, handle_expires_at, **before_ledger_sha256**, expected_null_b1_ids:[有序], minted:[按 target_id
排序的 { target_id, selection_handle }], expected_ledger_sha256 }`（`minted[*].target_id` 集 ===
`expected_null_b1_ids`；**`before_ledger_sha256` 必 === mint step 的 `before.ledger_sha256`**（十五轮 P1：
把 plan 绑死到它所针对的那份 before 账本）；`expected_ledger_sha256` = 按 plan 应用到该 before 账本后
的确定性 SHA）。**首次执行与崩溃恢复都只消费
该 plan**：账本仍 === before → 按 plan 逐字重放（不重新生成 handle，最终 SHA 必等于锚定值）；账本
已 === intended → 补 done；两者皆非 → 损坏。目录 fsync 失败不得推进 forward-only；重启后只凭 journal
锚（§8.2 mint step 的 `intended_blob`）验证同一份原始 plan，进程内引用不作数。
**pre-forward 状态矩阵（十五轮 P1：覆盖"plan 已持久化、journal 尚未锚定"的窗口——此时 journal 仍
`drained`，无锚可凭）**——进 forward-only 之前在 drained 阶段先盘点 `<token>.staged/intended/mint-<ep>.json`：
- **缺席** → 正常按上文创建；
- **恰一份完整 plan 在场**，且 `token`/`campaign_id`/`endpoint`/`request_key` 与本 operation 相等、
  `before_ledger_sha256 === 当前账本 SHA`、`expected_null_b1_ids === 当前 null-B1 集`、**按 plan 对当前
  before 重演算出的 SHA === plan.expected_ledger_sha256** 全部匹配 → **复用该 plan**（不重建、不撞
  O_EXCL），其 `intended_blob` 与 prepared mint step + phase 翻转在**同一次 journal 原子提交**里写入；
- **部分存在 / 多余文件 / 读不清 / 任一身份或 SHA 不符** → **不得进入 forward-only，fail-closed**
  （门与 active 保留，待人工）；
- **drained 阶段安全退出（标准 rollback 路径）必须删除本 operation 的受验 plan**；删除失败 →
  保留 active/gate 并进入 **`rollback_incomplete`**（权威阶段机的唯一名称；十六轮 P2：`cleanup_pending`
  不是第四种阶段，若保留只能作该阶段下的诊断字段），**不得报完成**。**零集合分支（十三轮 P1）**：
`expected_null_b1_ids===[]` 时**同样落一笔** `mint_selection_handles` op——`minted:[]`、
`affected_live_ids_after_commit:[]`、`proof_effects:[]`、revision 仍 +1、request_key **正式占用**、同请求
重放返回该空结果（不存在"零提交"支；与 ledger §5.1"成功的空操作也落 op"一致）。

`request_reaffirm` **不是 ledger op**（P1-5）——它是 intent-store 的 **sidecar 写事务**（§8.1），
与消费 intent 的 ledger op `owner_select_reaffirm` 是两个事务域，分开。

## 7. 全族组合表 + 校验器

### 7.1 组合表（不在表内=损坏；产证/保留按来源 op result 的 **`proof_effects`** 判——P1-1/P1-4）

| 直接前驱 → 事务 | 本记录在 result 的角色 | binding | link | 族 | 六字段等式? |
| --- | --- | --- | --- | --- | --- |
| B1+A1 → `activate`（本记录=`b3_id`） | **产证** | → owner_select_v1 | → owner_selected_route_v1 | B3 | 是 |
| 旧 current 在同笔 `activate`（本记录=`demoted_historical_id`，基线键名） | **保留** | 保持原样 | 保持原样 | B4 | 保持 |
| A1 chat 在同笔 `activate`（本记录=`tombstoned_id`，基线键名；rebind 的同类新键叫 `tombstoned_a1_id`） | **tombstone** | — | — | tombstone | — |
| A2 → `anchor`（=`a3_id`，result `link_effect:"produced"`） | 产证 | 保持 attach | → owner_selected_route_v1 | A3 | 否 |
| A4 双证齐无重配 → A3（`attach_a3`，=`a3_id`，result `link_effect:"preserved"`——P1-4） | 继承 | → attach | 继承旧 link（其 `selection_operation_id` 指向**原产生 op**=activate/anchor/rebind/reaffirm） | A3 | 否 |
| A3/B3 → `unbind` | 保留 | 保持 | 保持 | A4/B3′ | 保持 |
| B3′ → `restore` | 保留 | 保持 | 保持 | B3 | 保持 |
| A2/A3 → `retarget` | 保留 link | → retarget | 保持 | 同族 | 否 |
| B3(owner_select_v1) → `rebind_session_alias`（=`b3_id`） | 重签 | 重签 owner_select_v1（六字段全同步、handle=orh_） | 重签 owner_selected_route_v1 | B3 | 是 |
| B3(binding≠owner_select_v1) → `rebind_session_alias` | 重签 link | 保持原 binding | 重签 owner_selected_route_v1 | B3 | 否 |
| handle-only（`request_rebind`/`expire_*`/`cancel_*`/`reissue_*`）改 origin 的记录 | **保留**（P1-1） | 保持 | 保持 | 原族 | 保持 |
| 存量 → `owner_select_reaffirm` | 重签（+关联 tombstone 同笔） | **原 binding 是 pairing/legacy → 换成 owner_select_v1；原本已是 owner_select_v1 → 同样重签六字段——两种都是 `binding_effect:"produced"`（本笔重签了 binding 字段）；`"preserved"` 只用于 binding 原样不动的支（attach / retarget / migrated），reaffirm 的目标记录不走 preserved**——pairing 绝不保留，否则 `migrationInventory` 的 legacy 计数永不归零、operation B 无法收敛（#145 一轮 P1-1 回带） | → owner_selected_route_v1 | 原族 | 是（两支都产 owner_select 族 proof；关联 tombstone 里 proof kind ∈ {pairing, owner_select_merge_v1} 的同笔 remap 为 owner_select_merge_v1，`tombstone_remap` 有序封闭点名；未知 proof kind → 整笔拒） |
| `migrate_seed(B1)` / `(B3/B3′/B4)` | 产 | null / migrated | null / migrated | B1 / — | — |
| owner_select proof 现于 A1/B1 | — | — | — | ✘ | — |

**tombstone proof_ref**：`{ kind:"owner_select_merge_v1", selection_operation_id, selected_root_om,
selection_handle }`。**G13-tomb**：op result **点名该 tombstone id**、`forwards_to===同 op 存活/
target id`、root/handle 与 result 一致、**op_type ∈ {activate, rebind_session_alias,
owner_select_reaffirm}**（P1-6 补 reaffirm）、因果 revision 与直接归并关系闭合；reaffirm 的
`tombstone_remap` 有序列表逐项核对（P1-6）。

### 7.2 校验器
- **G11′**：kind 增三新形；binding=owner_select_v1 时 selected_*===aliases.*；runtime===endpoint 链。
- **G13′（按来源 op result 的 `proof_effects` 对本记录的项判——P1-1/P1-4）**：产证 vs 继承由
  `proof_effects` 中 `topic_agent_id===本记录 id` 那一项的 `binding_effect`/`link_effect` 显式给出
  （**不靠 id 角色猜、不按 op_type 一刀切**；被 tombstone 的记录——activate 的 `tombstoned_id`、rebind 的 `tombstoned_a1_id`——走 G13-tomb）：
  - **`link_effect:"produced"`**：`selection_operation_id===origin_operation_id`、result 字段与
    proof 逐字等；`binding_effect:"produced"`（binding=owner_select_v1）时六字段等（A），否则仅
    link 经自身来源 op 校验（B）。
  - **`link_effect:"preserved"`**（demote 降 B4、unbind/restore/retarget、A4→A3 继承、handle-only
    改 origin）：`selection_operation_id` 指向的**原产生 op** 存在（op_type∈产证来源集
    activate/anchor/rebind/reaffirm）、该 op result 的 `proof_effects` 对本记录曾 `produced`、来源
    revision ≤ 当前 origin revision、proof 字段与该产生 result 一致、当前 origin 属允许保留该
    proof 的直接迁移（§7.1）。
- **G-handle（handle 来源完整性，整账本不变量——P1-3，七轮改为可直译）**：G11′的"同时有/同时无"
  不够（换成另一形状合法值仍可能通过）。补：① 每个非空 `selection_handle`/`handle_expires_at`
  （A2 另含其锚定的 `anchor_candidate`）、`rebind_handle`/`rebind_expires_at` 必与**"最近一笔产生
  它的 op" result 逐字相等**——**"最近一笔"精确定义**：在该字段的**产生 op 集**
  （`create_b1`/`mint_selection_handles`/`attach_a2`/`request_rebind`/`reissue_selection_handle`；
  **`migrate_seed` 不产 handle、不在集内**）中，取 `result_revision` **最大**、result 的
  `affected_live_ids_after_commit` **明确含本记录**、且该字段**未被更晚的消费/清理 op**
  （activate/anchor/void/clear/expire/cancel/rebind_session_alias）覆盖者（不靠遍历序、不靠当前
  origin 猜）；② endpoint 内**所有 live handle 全局唯一**——**纯校验器只核 live**（它读不到 intent
  sidecar），**"含 intent 的跨文件唯一"移到持锁写前校验 + doctor**，不作整账本 G；③ 产 handle 的
  op 的 result_revision 必小于其消费/清理 op 的，当前 origin 的直接触及链闭合；④ 上述五个产生 op
  各自覆盖（A2 `reissue` 已带 `expected_anchor_candidate` + result `anchor_candidate`，与①一致）。
- **P2-1**：校验期只核不可变来源 result/proof，owner 性仅写时 op 内核。
- **G15′**：严格 schema 拒任何 `matched_fields`/`pending_token_state`；过渡 schema 容旧+新。
  新形字段集逐字段封闭；正则/长度/schema 版本入合同。**来源 op ↔ handle 前缀绑定（P2-1）**：
  `selection_handle` 前缀必与产生 op 相符——**activate/anchor**（attach_a3 已停产，不再列——P2-1）
  只收 `osh_`、rebind_session_alias 只收 `orh_`、owner_select_reaffirm 只收 `rfh_`；跨支即拒。

**G-handle 的反向不变量（#144 一轮 P1-3 回带）**：G-handle 不只是「非空 handle 必可追溯到产生 op」；反向也成立——若记录当前的产生 op（`origin_operation_id` / `selection_operation_id` 语义）是一个**尚未被后续消费覆盖**的 handle 产生 op（`create_b1` / `attach_a2` / `mint_selection_handles` / `reissue_selection_handle` / `request_rebind`），则 live 的 handle 与到期字段必须与该 op 的 result **逐字相等且非空**；把已铸 handle 抹成 null 而保留 op 记录 = `ledger_corrupt`。新形 `create_b1` / `attach_a2` 的 result handle/expiry 不得双 null（`migrate_seed` 除外）。
**跨 schema 重放（#144 一轮 P1-4 回带；三轮 P1 收紧）**：同 request_key 的重放判定**按既有 operation 的 `result_revision` 相对升级边界（首次离开 1.0 的 `schema_upgrade` 的 revision，与 G12 同一出处）二选一**——账本仍是 1.0、或 prior 落在边界之前 → 只接受旧 1.0 描述符；边界之后、或零升级历史的 1.1*/strict 账本 → 只接受当前描述符；**不得同时给两者**（否则边界后伪造的旧形指纹会被当幂等重放）。校验器同样钉：边界后的 `void` / `attach_a2` / `attach_a3` 必须是当前形——**判形靠不可变 result 的封闭键集（旧形 / 新形各一套），不靠从当前 live 记录回推历史指纹**（binding_target / claim_key 之类会被后续合法 retarget 改掉，回推会 fail-open；#144 四轮 P1-1 回带）；指纹只在 result 携带了全部指纹输入时重算核对（新形 result 必须携带），重建不了不得放行。attach 的 current 侧描述符含 attach_a2 与 attach_a3 两种新形，边界后二者的 result 都按 §6 新形键集写（含 `affected_live_ids_after_commit` + `proof_effects`）。首次执行只能用当前 schema 的新形。**带 owner_select 输入的调用（activate / anchor 增量形）其重放描述符必须携带完整增量载荷，不按当前 schema 抹字段**——1.0 账本下 fresh key 进 mutate 拒 `bad_input`、旧 key 同载荷不同 → `request_conflict`，不能被 1.0 旧形操作吞成 idempotent（#146 一轮 P1-2 回带）。**锁内时钟（#144 一轮 P1-5 回带）**：到期/签发/CAS 用的 now 必须在账本锁内由时钟 seam 读取，不得在取锁前预先求值。
## 8. 迁移状态机：两次维护 operation + 持久 campaign（P1-4/P1-5/P1-6）

**过渡 schema**（合法容旧形+新形）破"旧 schema 不能存新形 / 严格不能在旧形非零时启用"的循环。
**三阶段中间必须撤门、由 owner 门外 reaffirm，故不能由一个 active maintenance operation 跨越全
程（P1-4）**；拆成两次维护 operation + 一份持久 campaign：

- **operation A（门内，old→transition）**：逐 endpoint `schema_upgrade`(old→transition) ledger op
  （终态；**升版同笔给所有记录的新字段补显式 null**——缺席→null 规则固定于此）；随后**对既存
  null-handle B1 做一笔原子复合 `mint_selection_handles`**（全部 handle 写进这一笔不可变 result；十二轮
  P1-2：不再逐笔，无崩溃前缀；**十四轮 P1：handle 在进 forward 段前一次性固化进 staged mint plan、
  journal 以 `intended_blob` 锚定，执行与恢复只消费该 plan**）。
  **transition schema 明确允许 `B1 selection_handle=null ∧ handle_expires_at=null`**（作 blocker
  态、不违族——否则 A 在"升版已提交、mint 未完"的中间账本过不了整本校验，七轮 P1-4）；**strict
  才要求 B1 双非空**。A 的 forward 段完成后经 **`ledger_reopening` 撤门**（下表；**不是"done 即
  撤门"**），且 **`writer_state=partial` step 必在 reopening 前 done**（九轮 P1-3/P1-4）。
- **持久 campaign / receipt（跨窗口，非 active operation；生命周期 open→sealed→complete——七轮
  P1-4，消"固定集"与"原子加入"的矛盾）**：`campaign_id` + endpoint 集 + digest + 各 endpoint 状态
  （transition/strict、旧形计数、null-B1 计数）。**open**：operation A 建立（初始集来源=**全部有效
  初始化收据**），之后可在**机器级 campaign 锁 + WAL** 下追加 endpoint 并更新 digest；**sealed**：
  operation B **开始前**封印，此后集合不可再变；**complete**：**sealed ∧ 全 endpoint strict**（九轮 P1-2：**不含** writer_enable，否则与 on 成环）。崩溃恢复**只从 campaign 记的集合续跑、不重新枚举**。**A、B 之间新初始化的 endpoint**：直接
  初始化进 transition schema 并加入 open campaign——这跨 ledger-init 与 campaign-join **两个文件**，
  给 **prepared → committed 三态**（campaign 先记 `prepared(endpoint)`、ledger init 落地、再记
  `committed`）。**ledger init 在上游是 forward-only，prepared→账本已落后不能"回滚"**（八轮 P1-3）：
  崩在中间只能**核该 endpoint 的初始化 op / 账本身份与 prepared 项相等后向前补 `committed`**；身份
  不符 → fail-closed 待人工；不留"账本有、campaign 无"，也不伪造回滚。
- **operation B（门内，transition→strict + 启用）**：先 **seal** campaign；逐 endpoint
  `schema_upgrade`(transition→strict) ledger op（前置=该 endpoint **旧形计数为零 ∧ null-B1 计数为零**，
  逐条确认后才升 strict，七轮 P1-4）；sealed 集全 strict 后先 **`campaign_complete` step**（campaign state→complete），再**独立一步**
  `writer_enable`（前置=`campaign_complete` done ∧ digest 等，见下）。

**机器级维护 journal 封闭联合（八轮 P1-3；九轮 P1-3 嵌进维护门完整生命周期）**——三个新
`operation_kind`，**沿用 ledger 类 operation 的骨架**（`maintenance-gate.md` 账本接入节）：
`planned → timer_stopped → stubbed → gated → drained → <kind 专属 forward-only 段> → ledger_reopening
→ done | reopening_incomplete`；≤drained 可走标准 `rolling_back → rollback_reopening → rolled_back |
rollback_incomplete`（**A/direct 的 rollback 须先删本 operation 受验 mint plan，删不掉进
`rollback_incomplete`，十五轮 P1**），进入 forward 段后 forward-only。**撤门只发生在 `ledger_reopening`（B-4 逐步：
删门前精确复核 → 定时器 → 删桩 → 删 staged → token-CAS 删门 → 持久化 done → token-CAS 清 active）**，
失败进 `reopening_incomplete`（门与 active 保留，`--exit --apply` 只向前重试）；**不存在"done 即撤门"**。
lease、install-surface 锁、active 清理语义与 `ledger_init`/`ledger_cutover` **完全相同、不另立**；
`--exit` 按 `operation_kind` 分派到本 kind 的 reopening。

| operation_kind | forward-only 段（drained 之后） | 段内 step kinds | PHASE_REQUIRES |
| --- | --- | --- | --- |
| `owner_select_migration_a`（old→transition） | `osm_a_upgrading` | `campaign_open`（campaign 文件 SHA before/after，state=open）；`schema_endpoint:<ep>`（before/intended/after = schema+revision+SHA）；`mint:<ep>`（before=null-B1 计数，intended/after=0；**一笔复合、revision+1**）；`writer_state`（writer-state 文件 before/intended/after，intended=partial） | `osm_a_upgrading` ⇐ `ENTER_DONE`（段内 step 可 prepared/done，禁 sidecar）；`ledger_reopening`/`done`/`reopening_incomplete` ⇐ `ENTER_DONE` ∪ {`campaign_open`, 全部 `schema_endpoint:*`, 全部 `mint:*`, **`writer_state`**} 全 done（**writer_state=partial 必先于撤门持久化**，九轮 P1-4） |
| `owner_select_migration_b`（transition→strict + 启用） | `osm_b_strictening` | `campaign_seal`（SHA before/after，state=sealed，digest 固定）；`precheck:<ep>`（记录 旧形=0 ∧ null-B1=0）；`schema_endpoint_strict:<ep>`（before/intended/after）；`campaign_complete`（state=complete，前置=全部 strict step done）；`writer_enable`（writer-state before/intended/after，intended=on，**前置=`campaign_complete` done ∧ digest 等**） | `osm_b_strictening` ⇐ `ENTER_DONE`；重开族 ⇐ `ENTER_DONE` ∪ {`campaign_seal`, 全部 `precheck:*`, 全部 `schema_endpoint_strict:*`, `campaign_complete`, `writer_enable`} 全 done |
| `owner_select_migration_direct`（old→strict 直升；九轮 P1-3：不挂在 A 行上） | `osm_direct` | `campaign_open`；`precheck:<ep>`（旧形=0 ∧ null-B1=0，**任一非零 → 本 kind 拒进段，改走 A**）；`schema_endpoint_direct:<ep>`（old→strict before/intended/after）；`campaign_seal`；`campaign_complete`；`writer_enable`（intended=on） | 段 ⇐ `ENTER_DONE`；重开族 ⇐ `ENTER_DONE` ∪ 段内全部 step done |

**journal schema → 1.4**：`operation_kind` 域增三个新 kind；**旧 runtime（≤1.3 读取器）遇 1.4 journal
= unreadable/foreign → fail-closed**（不得静默忽略、不得当 orphan 清），与既有"旧版独立兼容分支"
纪律一致。**A / direct 的进门前置（九轮 P1-3）**：当前 runtime **必已受验支持** transition/strict
schema 与 1.4 journal——即**先经普通 `maintenance_install` 装过渡版 runtime**（独立一次、需 Frank
授权的装），再进 A/direct；未装即拒进段。崩溃恢复只从 journal 记的 step 集续跑。
**「已受验支持」的客观判据（#138 一轮 P1-3 回带）**：`osmPrecheck` 只读核对 `~/.claude/feishu-bridge/runtime/current` 指向的**已装版本目录**——manifest 完整（`verifyRuntime` ok），且该目录内 `scripts/maintenance/journal.mjs` 导出 `OWNER_SELECT_JOURNAL_SCHEMA === "1.4"`、`scripts/topic-agent-ledger.mjs` 导出 `SCHEMA_VERSIONS` 含 `"1.1-transition"` 与 `"1.1"`（经**子进程探针**动态 import 已装目录内的模块：`scripts/maintenance/runtime-capability-probe.mjs` 随 runtime 一起装，编排用 `execFileSync(process.execPath, [探针, 已装目录], {timeout})` 同步等它打出一行 JSON；探针只 import 已装目录内的模块、只读、不执行任何事务；非零退出 / 超时 / 输出不合法同样拒）；读不出、缺导出、值不符 → `precheck_failed: runtime_not_transition_capable`，拒进段。核的是**已装**的那份，不是仓库工作树里的这份。**目标目录的取法（#138 二轮 P1-1 回带）**：不信维护桩清单里的 `original_current` 之类自由字段；从受验 journal 的 `current:<chain>.before` 取 **Claude 与 Codex 两条链**各自的目标，形状必须精确为 `versions/<16hex>`，两链各过 `verifyRuntimeVersion` 后再各自探针；任一链不达标即拒。

### 8.2 journal 1.4 封闭数据联合（十轮 P1-2：不是流程表，是可直译 journalProblem 合同；回带 `maintenance-gate.md`）

**总则**（与 1.2/1.3 的 ledger/sidecar step 同一工艺）：`OPERATION_KINDS` 增 {`owner_select_migration_a`,
`owner_select_migration_b`, `owner_select_migration_direct`}；`STEP_KINDS` 增 {`campaign`, `schema_endpoint`,
`mint`, `precheck`, `writer_state`}。每 step **prepared** 键集 = `{at, backup, backup_bytes, backup_sha256,
before, id, intended_after, kind, state, target, chain:null}`（**`mint` 另含 `intended_blob`**，十四轮
P1，形状同 sidecar）且 **after 缺席**；**done** = 前者 ∪ `{after}`
且 `after === intended_after`（逐字段）且 after **必来自写后受验读回**；多一键/少一键/`chain≠null` 即
`journalProblem`。**target 一律内部派生**（校验器重算规范路径，不信 journal 中的路径）；**备份规则按 kind 分**（十一轮
P1-2）：`campaign`/`writer_state`（文件态含 `exists`）同 sidecar——`before.exists===true` → backup 绝对路径
**必落本 operation 私有目录 `<token>.staged/`** + sha/bytes、`===false` → 三字段显式 null；`schema_endpoint`/
`mint`（账本必存在、状态对象无 `exists`）→ **备份恒需**，`backup_sha256 === before.ledger_sha256` 且落
**备份字节的出处（#138 一轮 P1-5 回带）**：`schema_endpoint:<ep>` 的备份 = 进段时受验读取器读到的 1.0 账本**原始字节**；`mint:<ep>` 的 before 是 schema 升级**之后**的账本，它在进段时尚不存在——其备份 = `serializeLedger(applySchemaUpgrade(before1.0Doc, {operation_id, request_key, from, to}))` 的字节（确定性：与 `schema_endpoint` 的 `intended_after` 逐字节相同，也就是执行器将要写下的那份），故 `mint.backup_sha256 === mint.before.ledger_sha256 === schema_endpoint.intended_after.ledger_sha256` 按构造成立；`campaign` / `writer_state` 的备份 = 受验读取器返回的**原始字节**（读取器必须带 `raw` 与 `revision`），`before.sha256` 就算在同一份 raw 上；文件不存在（`before.exists=false`）则无备份。**禁止**用状态投影重新 JSON 化当备份。
`<token>.staged/`；`precheck`（**只读 step**）→ **三个 backup 字段恒 null**，不因目标存在而制备份。**每 operation 的全部 step 共享同一 `campaign_id`**
（下表交叉等式），跨 campaign / 跨 endpoint 集拼接即 problem。

| step kind / id 形状 | target（派生） | before / intended_after / after 联合（值域） | 交叉等式 | 恰一次计数（按冻结集） | 允许出现的 kind |
| --- | --- | --- | --- | --- | --- |
| `campaign` / `campaign:<campaign_id>:open\|seal\|complete` | `<bridge home>/ledger/owner-select-campaign.json` | **判别联合**（十二轮 P2）：`exists===false` ⇒ `{ exists:false, sha256:null, state:"absent", campaign_id:null, endpoints:null, endpoints_digest:null }`（六键全定）；`exists===true` ⇒ `{ exists:true, sha256:<64hex>, state:"open"\|"sealed"\|"complete", campaign_id:<`"osc_"+sha256(canonKey({domain:"owner_select_campaign_v1", token})).slice(0,32)`，正则 `^osc_[0-9a-f]{32}$`；campaign 文件、journal step id、writer-state **三处同一派生、同一编码**（十三轮 P2）>, endpoints:[有序、非空、去重、每项 ENDPOINT 形状], endpoints_digest:<64hex> === sha256(canonKey(endpoints)) }`（absent 支 state 只能 absent；存在支 state 不能 absent）（**冻结集本身进 journal**，十一轮 P1-2：`endpoints_digest === sha256(canonKey(endpoints))`；校验器做"恰一次计数"时**从本 operation 自己的 campaign step 取集合**——A/direct 取 `:open`、B 取 `:seal` 的 `intended_after.endpoints`——不依赖外部文件）；**open**：before.state∈{absent,complete} → intended.state=open、intended.campaign_id=本 operation token 派生、digest=初始集摘要；**seal**：before.state=open → intended.state=sealed、campaign_id 同、digest 冻结；**complete**：before.state=sealed → intended.state=complete、digest 同 | `campaign_id` === 本 operation 全部其它 step 的 `<campaign_id>`；A/direct 的 open 派生自本 token；B 的 seal/complete 的 campaign_id === 现存 open campaign 的 id | A：恰一条 `:open`；B：恰一条 `:seal` + 恰一条 `:complete`；direct：`:open`+`:seal`+`:complete` 各恰一 | A / B / direct（各按左列） |
| `schema_endpoint` / `schema_endpoint:<ep>:transition\|strict\|direct` | `<bridge home>/ledger/<ep>/ledger.json` | `{ schema_version, revision, ledger_sha256 }`，`schema_version` **字面值绑定**（十一轮 P1-2）：old=`"1.0"`（现行 `SCHEMA_VERSION`，实测在盘）、transition=`"1.1-transition"`、strict=`"1.1"`；**transition**：`before.schema_version==="1.0"` ∧ `intended_after.schema_version==="1.1-transition"` ∧ `intended_after.revision===before.revision+1`；**strict**：`"1.1-transition"`→`"1.1"`、revision+1；**direct**：`"1.0"`→`"1.1"`、revision+1（键名统一 `schema_version`） | `<ep>` ∈ 本 campaign 集（A：open 集；B：sealed 集；direct：open 集）；账本内 `schema_upgrade` op 的 `{endpoint, from_schema, to_schema}` 与本 step 逐字等；`ledger_sha256` = after 读回 | 对 campaign 集**每 ep 恰一条**本 kind 变体（A 只 transition、B 只 strict、direct 只 direct） | A(transition) / B(strict) / direct(direct) |
| `mint` / `mint:<ep>` | 同上 ledger.json | `{ null_b1_count, revision, ledger_sha256 }`；`intended_after.null_b1_count===0`、**`intended_after.revision === before.revision + 1`**（十二轮 P1-2：一笔复合，**真正两态**——账本要么 before 要么 after，无合法前缀态，恢复矩阵按两态判）、after 读回；**`before.null_b1_count===0` 时同样落一笔空 op、revision 仍 +1**（十三轮 P1：与账本"成功的空操作也落 op 占用 request_key"纪律一致，整张表始终一套两态合同，**无只读退化支**）；**`intended_blob = { path, bytes, sha256 }`**（十四轮 P1）：`path` **必等于重算的** `<token>.staged/intended/mint-<ep>.json` 规范路径、校验时受验为**普通单硬链接 0600 文件**、`sha256` 与长度 === bytes 逐字等；`intended_after.ledger_sha256 === plan.expected_ledger_sha256`；**恢复只从该 blob 读 plan**（账本===before → 按 plan 重放；===intended → 补 done；其它 → 损坏）；plan 在 `ledger_reopening` 随 `<token>.staged/` 一并清理，清不掉 → `reopening_incomplete` | `<ep>` ∈ open 集；账本内**恰一笔** `mint_selection_handles` op 且 `result_revision === after.revision`；`result.minted.length === before.null_b1_count`；`result.minted[*].target_id` 集 **=== 该 op fingerprint 的 `expected_null_b1_ids`** === before 时刻该 endpoint 的 null-B1 id 集；request_key ext 为本 campaign token | A：对 open 集每 ep 恰一条 | **仅 A** |
| `precheck` / `precheck:<ep>` | 同上 ledger.json | `{ legacy_proof_count, null_b1_count, revision, ledger_sha256 }`；**只读核验 step**：before === intended_after === after 且两计数皆 0；任一非 0 → 本 step 不能 done → operation 不得推进（direct 则拒进段） | `<ep>` ∈ sealed 集（B）/ open 集（direct） | B/direct：每 ep 恰一条 | **仅 B / direct** |
| `writer_state` / `writer_state:<campaign_id>:partial\|on` | `<bridge home>/ledger/owner-select-writer-state.json` | **判别联合**（十二轮 P2）：`exists===false` ⇒ `{ exists:false, sha256:null, state:"off", campaign_id:null, endpoints_digest:null, revision:0 }`（缺席投影=off）；`exists===true` ⇒ `{ exists:true, sha256:<64hex>, state:"off"\|"partial"\|"on", campaign_id:（state=off ⇒ null；否则 <id> 非 null）, endpoints_digest:（state=on ⇒ <64hex> === sealed 集摘要；partial ⇒ open 集当前摘要或 null；off ⇒ null）, revision:正整数、每次写 +1 }`；**partial**：before.state∈{off,on(退回)} → intended.state=partial；**on**：before.state=partial ∧ 本 operation `campaign:*:complete` 已 done → intended.state=on、digest=sealed 集摘要 | campaign_id/digest === 本 operation campaign step 的值；`revision` 单调 +1 | A：恰一条 `:partial`；B/direct：恰一条 `:on` | A(partial) / B(on) / direct(on) |

**schema_upgrade 的确定性（R52 编排前置，回带 §6/§8.2）**：`schema_endpoint` step 的 `intended_after.ledger_sha256` 必须在**进 forward 段之前**算出并冻结
（after === intended_after 逐字段），因此 `schema_upgrade` op 的 key 不能随机：`operation_id = uuid 形式化的 sha256(canonKey({ domain:"owner_select_schema_upgrade_v1", token, endpoint }))`
（前 32 hex 按 8-4-4-4-12 排、版本位置 4、变体位置 8——与 OP_ID_SHAPE 相容），升版不改任何记录的 `updated_at`（只补显式 null），
于是 `applySchemaUpgrade(beforeDoc, { operation_id, request_key, from, to })` 是纯函数，编排用它算 intended_after，执行器 `schemaUpgrade` 用同一函数产 next 并读回核等。
**request_key 派生（#138 一轮 P2 回带）**：`schema_upgrade` 的 `request_key = token + ":schema:" + endpoint_id`（与 mint 的 `request_key = token` 不同键，避免同 token 两种 op 撞 request_key 幂等）；编排与执行器同一公式，reopening 身份核验按此逐字核。
**执行器结果的记账规则（#138 一轮 P1-7 回带）**：编排把 step 记 done 的**精确条件**（#137 四轮放行口径）：`ok === true` ∧ `commit ∈ {committed_clean, replayed, already}` ∧ `residue` 为空 ∧ `lockUncleared === null` ∧ `lock_state !== "unclear"` ∧ 受验现场逐字段等于 journal `step.intended_after`；`ok:true` 单独绝不够；`committed_durability_uncertain` / `committed_with_residue` **不记 done**、operation 停在当前 phase（reason `commit_unclear`，残骸路径进 why），由 `--exit` 只向前收敛时重新读盘（原始字节 + 目录 fsync）核现场：现场 === intended_after → 记 done 续跑；否则说不清 → `reopening_incomplete`。**记 done 前的持久化屏障（#138 二轮 P1-2/P1-4 回带）**：无论首次提交还是恢复路径，记 done 之前必须：目标目录 fsync → 受验重读原始字节 → 完整投影 === intended_after → 无锁/tmp 残骸；staged 里复用既有 plan/backup 时同样要在受验 fd 上重新 fsync 文件与父目录（不能假设上一轮已落盘）；campaign/writer 备份只取受验读取器返回的同一 fd 字节，禁止路径二读。**屏障是同一个函数（#138 三轮回带）**：首次 clean 提交与所有恢复路径（含 ledger 执行器返回 `replayed` / `already` 的支、状态文件「现场已等于 intended」的支）都必须经过同一套「目录 fsync → 受验重读 → 完整投影 === intended_after → 残骸为空」函数才可记 done，不允许任何分支绕过；残骸盘点只忽略确定的 ENOENT，不得笼统跳过目录，`ledger.lock`、状态文件锁、`.reap` / `.reaped-*` 一律算残骸阻断。**残骸允许清单按「名字 + 类型 + 归属」三合一判（#138 四轮 P1 回带）**：允许判据接收 lstat 结果；state-root 下的 endpoint 项必须同时满足名字 ∈ 受验 journal 的冻结 endpoint 集、是目录、非 symlink，其余只允许两份固定状态文件且须为普通文件非 symlink；ledger 目录只允许 `ledger.json` / `ledger.json.prev` 两份普通文件。只按名字正则放行 = 缺陷（campaign 外合法形状的 endpoint 目录、同名普通文件、同名 symlink 都会被放过；维护门已 drained，此时不存在合法新增 endpoint 的理由）。
**撤门前的不可变事务身份核验（#138 一轮 P1-7 回带）**：reopening 对每个 ep 逐字核——当前账本 SHA === 该 ep 最后一个 step 的 `after.ledger_sha256`；`operations[plan.operation_id]` 存在且 `op_type === "mint_selection_handles"`、`fingerprint === fingerprintOf("mint_selection_handles", plan 派生 inputs)`、result 触及集 === `plan.expected_null_b1_ids`；`operations[ownerSelectSchemaUpgradeOpId(token, ep)]` 存在且 from/to 与 step 相符；campaign / writer_state 文件的 state 与 kind 的终态一致。任一不符 → `reopening_incomplete`，门不撤。
`mint` 同理已由 plan 冻结 `operation_id`。
**执行器与 journal step 的 CAS（PR #137 一轮回带）**：`schemaUpgrade` / `mintSelectionHandles` 在账本写锁内核 `current SHA === step.before.ledger_sha256`（不等且 ≠ intended → `before_mismatch`；
=== intended → replayed/already），读回核 `=== step.intended_after.ledger_sha256`（否则 `written_mismatch`）；intended 在进 forward 段前冻结，**绝不提交后回填**。
compare→build→账本锁→rename 全程处于**同一真实 lease 实例**的 `commitWhileHeld` 栅栏内，提交点复核 active/gate/journal/step。
**栅栏的位置与内容（#137 二轮 P1-1/建议 回带）**：提交点复核必须在 `.prev` 与 ledger **两次 rename 之前**执行（漂移时 `.prev` 也不得被覆盖）；复核重读的 prepared step 与 capability 捕获的 step 比较**完整规范投影**（canonKey 逐字等），不只核 id 与 state。**预算先于落盘（#137 二轮 P1-2）**：执行器在写 tmp 之前核 `sha256(payload) === step.intended_after.ledger_sha256`（mint 同时核 `=== plan.expected_ledger_sha256`），不等 → `intended_mismatch` 且不提交；`written_mismatch` 只指写后读回异常。外层 lease 栅栏的 `reapUncleared` 残骸必须投进结果（commit 降为 `committed_with_residue`），编排不得据此记 done。
**mint plan 身份与有效期**：TTL 唯一常量 `OWNER_SELECT_HANDLE_TTL_MS`（账本模块单一出处，编排 import），`mintPlanProblem` 核 `handle_expires_at === frozen_at + TTL`、
`campaign_id === campaignIdFor(token)`、`minted[*].selection_handle` 全局唯一，且 `applyMintPlan` 产物过 `validateLedger` 才可落 staging。

**状态链闭合（PR #135 一轮 P1-4/P1-5/P1-6 回带；"步数闭合"之外还要"状态链闭合"）**：
- 逐 endpoint：A 的 `schema_endpoint:<ep>:transition.intended_after.{revision,ledger_sha256}` **===** `mint:<ep>.before.{revision,ledger_sha256}`；
  B/direct 的 `precheck:<ep>.before.{revision,ledger_sha256}` **===** `schema_endpoint:<ep>:strict|direct.before.{revision,ledger_sha256}`。
- campaign 链：`seal.before` **逐字 ===** `open.intended_after`（direct 内；B 的 open 在前一 operation，`seal.before` 由 R52 与盘上文件核）；
  `complete.before` **逐字 ===** `seal.intended_after`；三步 `campaign_id/endpoints/endpoints_digest` 相等；本 operation 全部 `<ep>` step ⊆ 该集。
- writer_state：`partial.intended_after.{campaign_id,endpoints_digest}` **===** `open.intended_after.{campaign_id,endpoints_digest}`（**digest 非 null**，
  纠正上表"或 null"）；`on.intended_after.endpoints_digest` === `complete.intended_after.endpoints_digest`；**`:on` 的 before.state：B ⇒ `partial`；
  direct ⇒ `off`**（direct 无 partial 段，缺席投影即 off；上表"on：before.state=partial"只对 B）。
- campaign 文件不变量：`state==="complete"` ⇒ 全 member `schema_version==="1.1"` ∧ 两计数皆 0；`sealed|complete` ⇒ `pending_joins===[]`；
  `pending_joins[*]` 封闭 = `{ endpoint_id, at, init_chain ∈ {claude,codex}, init_request_key（账本 REQUEST_KEY_SHAPE）, init_operation_token（UUID）}`
  （§8 prepared→committed 恢复要核的初始化身份；与真实 init journal/账本的逐字对账在 R52 join 协议里做）。
- **准入读取器 `readOwnerSelectAdmission(env)`**（跨两文件，供 W1/W2/reaffirm 与 R52 用）：`on` ⇔ writer-state on ∧ campaign complete ∧
  同 campaign_id ∧ digest 相等 ∧ 全 member strict；`partial` ⇔ writer-state partial ∧ campaign open|sealed ∧ 同 campaign_id；任一不自洽 → `unreadable`
  （生产写方 fail-closed）；单文件读取器仍导出但**不作准入依据**。
- **写原语合同（PR #135 一轮 P1-2/P1-3；二轮 P1-2 收紧）**：两文件的写入口是**维护窄事务**（同 `initializeShadow`/`authorityCutover`
  的 capability 工艺）：调用方必须持有受验 capability——active maintenance operation token、journal 1.4 经 `journalProblem` 受验、
  `operation_kind` ∈ 三新种、phase 在 forward 段、且存在**对应的 prepared step**（`campaign:<id>:open|seal|complete` / `writer_state:<id>:partial|on`）
  其 `intended_after` 与本次写入的投影逐字相等、`before.{exists,sha256}` === 现场；缺 capability 或核不过 → `maintenance_capability_required`，
  **不导出可无 operation 直接改状态文件的通用 writer**。此外写方必先持有 `<ledger root>/owner-select-state.lock`（registry 锁协议，同一把锁盖两文件），
  锁内 compare（现场 `{exists,sha256}`）→ 序列化并**落盘前核大小 ≤ 1 MiB**、**`sha256(payload)` 必 === 对应 prepared step 的 `intended_after.sha256`**（不等 → 不落盘，
  PR #135 三轮 P1-2）→ O_EXCL 0600 临时文件 fsync → rename → fsync 目录 → 读回**原始字节**核同一 SHA；capability 的 lease 核验须在**提交栅栏内**用
  `commitWhileHeld` 证明本进程持有真实 lease 实例并重读 active/gate/journal（三轮 P1-1，非持有进程一律拒）；
  结果联合 `{ commit:"not_committed" | "committed" | "committed_durability_uncertain"（rename 已成、目录 fsync 失败）| "lock_residue" }`，
  **finalize 一次性且不抛：rename 已落地后的任何释放/清理异常都不得折叠成 not_committed**（二轮 P1-1）；tmp 写/fsync 失败尽力清理，清不掉结构化带出 `residue`；
  写前异常一律结构化返回不裸抛；根路径经唯一 `validateLedgerRoot`（祖先 symlink 拒），文件 mode **恰 0600**、普通文件、单硬链接（读写两侧同核）。

**跨 step 等式的生效时点（R50 验收裁定）**：forward 段内 step 可**整批 prepared**（与 cutover 的原子进段同一工艺）；
`writer_state:*:on` **done** ⇐ 本 operation `campaign:*:complete` 已 done（on 仅 prepared 时不核）；`writer_state` 步（partial/on）的
`intended_after.campaign_id` / `endpoints_digest` 必逐字等于本 operation campaign step 的值；恰一次计数按 **phase** 门控——进入
forward 段起即使零新 step 也按表判（`:open` 必须恰一），不以"是否出现新 step"为条件。

**禁异类 step（逐 kind 封闭）**：三个新 kind **一律禁** `ledger`/`sidecar`/`artifact`/`receipt`/`staged_plan`/
`current:*:install`；A 禁 `precheck`、`schema_endpoint:*:strict\|direct`、`writer_state:*:on`；B 禁 `mint`、
`campaign:*:open`、`schema_endpoint:*:transition\|direct`、`writer_state:*:partial`；direct 禁 `mint`、
`schema_endpoint:*:transition\|strict`、`writer_state:*:partial`。反向：`maintenance_gate`/`maintenance_install`/
`ledger_*` 四个旧 kind **禁**上述五个新 step kind。**1.4 读取纪律（PR #135 一轮 P1-1 裁定收紧）**：`schema_version===1.4` 是**三新种专属判别支**（同 1.3 之于 cutover）——
`operation_kind` ∈ 三新种，**1.4 读到旧四种 → unreadable**（旧四种只记 1.2/1.3，绝不借 1.4 绕过各自旧联合）；≤1.3 读取器遇 1.4 →
`unreadable`（fail-closed）；1.4 读取器读 1.1/1.2/1.3 走既有兼容分支；**1.1 冻结：禁五种新 step**。**按 phase 计数**：进入 forward 段起，上表"恰一次计数"逐条成立（可 prepared/done）；进入重开族起
**全部 done**；forward 段之前**禁**任何新 step kind。

**`writer_enable` 是唯一、封闭、CAS 的机器级当前状态（P1-6；七轮 P1-5 补存储合同）**：路径 =
**受验、环境派生的 machine bridge home**（与维护门同一推导：真实用户 home 派生、只有测试隔离点可
覆盖；**不把字面 `~/.claude/...` 当协议**，九轮 P2-2）下固定相对路径 `ledger/owner-select-writer-state.json`
（**机器级**、非任一 endpoint 内、两链一致；
0700/0600、fd 读、**维护门锁下 fenced CAS 写**）；封闭字段 `{ schema_version, state:"off"|"partial"|
"on", campaign_id, endpoints_digest, revision, origin_operation_id }`；**缺席投影 = off**；读不清 =
unreadable（生产写方 fail-closed）。**四态读取器**：off / partial / on / unreadable。**`writer_enable`
前置 = campaign complete（sealed ∧ 全 strict）∧ `endpoints_digest` === 该 sealed 集 digest**（写时逐
endpoint 核）；`writer_enable` step done 后 `state=on`（九轮 P1-2：complete→on **单向可达**，无跨文件
原子幻想）。`endpoints_digest` **恒为本次 sealed campaign 固定集合的摘要、封印后永不变**（十轮 P2：**不是**"全部
当前初始化 endpoint"的摘要；唯一解释）；**on 之后新初始化的 endpoint 只能直接 init 进 strict，它不属于
该 campaign、不改 digest、不需 CAS 扩展**；读取器与 doctor 只按 campaign 集解释 digest。若任何端点
（含 campaign 外新 endpoint）非 strict，`on` 必须先**退回受控 partial**（同一 CAS 纪律）再处理。恢复
矩阵三分（before/intended/其它）。**不只笼统存于某个审计 journal step**（多份历史 migration journal
无法确定当前权威值）。writer 启用 ≠ 任一 endpoint strict 提交。**三态准入语义（八轮 P1-3，消"transition 期 writer 全关"
与门外 reaffirm 的矛盾——reaffirm 本身就是 owner_select ledger 写）**：`off` = 全禁；`partial` =
**允许且仅允许：`request_reaffirm`（签发 intent 的唯一入口）、持有效 intent 的 `owner_select_reaffirm`、
intent 到期清理**；其余 W1/W2/正式 handle writer 全拒（九轮 P1-4）；`on` =
开放正式 W1/W2 writer。operation A 的 `writer_state` step 置 `partial`（**先于 reopening 撤门持久化**），operation B 的
`writer_enable` step 置 `on`。

**过渡 runtime 允许集**：读 partial-transition / partial-strict 恢复态；旧形禁新 pairing 写；
**W1/W2 writer 关到 `state===on`；`state===partial` 时只放行 `request_reaffirm` / 持有效 intent 的 `owner_select_reaffirm` / intent 清理**（否则
门外 reaffirm 无法执行）；旧 runtime 绝不读 transition/strict（fail-closed）。
**升级边界的精确定义（PR #133 二轮回带，纠正 §6/§8 此前'最近一笔'的措辞）**：新 op 与增量 result
允许出现的边界 = **按 result_revision 排序后第一笔 `from_schema==="1.0"` 的 `schema_upgrade` 的 result_revision**
（首次离开 1.0），**不是**最近一笔——两阶段合法历史 `1.0→transition`(rev k) → `mint/reaffirm`(k+1…) →
`transition→1.1`(rev m) 中，mint 位于第二笔升级之前仍合法。仍要求 ≤2 笔、to_schema 单调、末笔 to_schema===
`doc.schema_version`；"初始即 transition 后再升 strict"路径同样以第一笔为边界。
**零笔 schema_upgrade 的 1.1-transition / 1.1 账本是合法的（PR #133 三轮 Codex 裁定，不加"必含升级 op"守卫）**：
campaign 期间新 endpoint 直接初始化为 transition、writer on 后新 endpoint 直接初始化为 strict，这两类账本诚实地没有
升级历史，`upgradeBoundaryRevision=0`、全部 op 允许新形。若将来要证明初始 schema，把 `initial_schema_version` 纳入
`initialize_shadow` 的 result/fingerprint 与维护收据，而不是伪造一笔升级。

**存量范围（门外 reaffirm，§8.1）** = B3/B3′/B4/A4 携旧 pairing binding + A3 携旧 `f4_anchor` link
+ 对应 tombstone。**直升捷径的精确条件（八轮 P1-3；九轮 P1-3 独立成 kind）**：走 `owner_select_migration_direct`，其
`precheck:<ep>` 记录 **旧 proof 数量为零 ∧ null-B1 数量也为零** 才可进段（只"旧形零"不够）；任一
非零 → 本 kind 拒进段，必须走 A→(门外 reaffirm)→B；非零 contingency 由过渡 schema 保证可执行。Codex 不以我的现场盘点作放行依据——实现单门内**当场
重新盘点**。**prepared/done 属机器级 journal step、不进 ledger op result**（P1-6）。

### 8.1 reaffirm intent store（可恢复协议——P1-5）

`request_reaffirm`（**sidecar 写事务，非 ledger op**）与 `owner_select_reaffirm`（**ledger op，
消费 intent**）是两个事务域，分开。

- **文件**：`ledger/<endpoint>/reaffirm-intents.json`（**迁移期专用，迁移完删**）；封闭 schema
  `{ schema_version, entries: { <reaffirm_handle>: <entry> } }`（**键=`reaffirm_handle`**，见下）；
  0700/0600、**fd 绑定读写**、**普通 gated intent 文件锁**（reaffirm 发生在**门外**：不要求
  maintenance lease、也不开放 ungated 写面——七轮 P1-5）；大小 ≤ 256 KiB、entries ≤ 512。
- **`reaffirm_handle` 即唯一不可变 intent id（P1-5）**：`"rfh_"+32hex`，既是 handle 又是 intent
  主键与恢复用 request_key 派生源（`owner_select_reaffirm` request_key：entity=target_id、
  **ext=reaffirm_handle**）；不再另设 intent_id。
- **entry（封闭）**：`{ reaffirm_handle, target_id, target_family, authorized_owner, endpoint,
  chat_id, issued_at, expires_at, expected_old_proof_closure_digest }`。
- **`expected_old_proof_closure_digest`（P1-5；八轮 P1-4 给可直译公式并纳入 family）**=
  `sha256(canonKey({ domain:"owner_select_reaffirm_closure_v1", endpoint_id, topic_agent_id, family,
  binding_proof, locator_link_proof_ref, tombstones:[按 topic_agent_id 排序的 { topic_agent_id,
  forwards_to, proof_ref }] }))`——**family 在摘要内**：intent 签发后若发生 unbind/restore，proof 可
  不变而 family 已变，旧 intent 必失效；否则"一笔更新 live+tombstone"的 CAS 无从保证。
- **锁序（P1-5 修正，与 m1a §5.1 一致——不同时持 legacy/ledger 内锁、sidecar 先于 ledger）**：
  `outer → legacy 段（如需，取完即释放）→ intent 锁 → ledger 锁`；reaffirm **不写 legacy** 时
  直接 `outer → intent → ledger`。**消费在持 intent 锁期间完成 intent CAS + ledger commit**；
  提交后清 intent 失败靠相同 request_key 恢复。
- **控制命令签发/消费**：终端 `/feishu-reaffirm-issue <target_id>`（写 intent，签 `rfh_`）→ 桥回执
  `rfh_` → owner 在对应话题 `/feishu-select <rfh_...>` 触发 `owner_select_reaffirm`。
- **`request_reaffirm`（sidecar 写）CAS**：**no-existing-intent = 该 target 下无任何未清 intent**
  （**不是**"忽略过期项"——那会让同 target 堆积多个 intent，七轮 P1-5）；签发前在**同一 intent 锁内
  先受验清理该 target 的过期项**，再 CAS 签发；+ **expected-old-proof digest** CAS；**unreadable
  intent 一律阻断（fail-closed），不折成"无 intent"**。
- **消费侧核验（P1-5；八轮 P1-4 加 family）**：`owner_select_reaffirm` 的入站 **sender ===
  intent.authorized_owner**、**event endpoint/chat === target live 的 endpoint/chat_id**、handle===
  intent 主键、**`current_family === intent.target_family`**（family 亦在 closure digest 内，双保险）、
  digest CAS。
- **崩溃恢复矩阵**：ledger 已提交 + intent 未清 → 按 request_key **判已完成、只清 intent**（不重改
  live）；ledger 未提交 + intent 在 → 视为待消费、可安全重跑。

**`owner_select_reaffirm` ledger op**：owner 门外逐条真实动作触发；digest CAS；**一笔原子更新
live 与其关联 tombstone**（result `tombstone_remap` 有序封闭、G13-tomb 逐项核）；**不复用
migrate_repair**（合同冲突）；不批量/不后台；取不到 owner 动作**永久保留旧形**。**红线：重签永不
自动进行。**

## 9. doctor
- **⑰**（编号回带：⑯ 已被 R54「入站转发结果」占用，owner_select 对账定为 ⑰）：对 **`facts.locator_link_proof=present` 的 live 记录**，断言 kind/selected_*===aliases.*/
  按 §7.2 G13′（按来源 op `proof_effects` 判产证/保留）核来源相容 + G-handle；binding=
  owner_select_v1 另核六字段等。
- **存量计数**：严格后恒 0，非 0 block；过渡期报 opaque id+计数。
- **handle 卫生**：三 handle 与各自合法族一一映射、过期字段与存废一致、endpoint 内 handle 全局
  唯一（含 intent）、intent store 无悬挂、**无 `selection_handle=null` 的 B1**。

## 10–11. 回带清单 / 落地顺序
回带：`session-centric` §3.6/§3.3、`ledger` §4/§5/§7/§8、`m1a` §5.1 W1/W2 §3.1、doctor。
落地：① 过渡版 runtime + 机器级 campaign/`owner_select_writer_state`；② operation A（old→transition
+ `mint_selection_handles`）+ WAL/恢复；③ §4 handle（三字段，含 intent store、清理/换发事务）；
④ §6 op 联合（含 `proof_effects`）+ §7.2 校验器（G13′/G-handle）；⑤ W1 认领产 owner_select；
⑥ **W2 rebind 重写**（单列 P1）；⑦ `/feishu-select` 控制命令；⑧ operation B（transition→strict
+ `writer_enable`）；⑨ doctor ⑯；⑩ reaffirm + 清理/换发 contingency。每步全绿给数字、Codex
独立复核、五项证据合并。

**授权边界（P2-3 已纠正）**：设计与 shadow 期开发不碰硬停；但 **`schema_upgrade`（old→transition
及 transition→strict）+ writer 启用 fenced 提交是维护门内硬变更，与"装"同级，仍需 Frank 逐次
授权**，指向具体 PR+已评审 HEAD。

## 12. 用户端控制语法（解析封闭——P1-2/P2-1）

**`/feishu-select [<handle>]`**——bind-only 控制命令。**canonical 解析伪码（P2-1）**：

```
raw → 去平台引用块 → 去 @mention（canonical mention removal）→ body
assert body 匹配正则 ^/feishu-select(?: (osh_[0-9a-f]{32}|orh_[0-9a-f]{32}|rfh_[0-9a-f]{32}))?$
  （单个 ASCII 空格分隔；无首尾空白；**折叠规则与 /feishu-mode 同一份 `normalizeControlText`**：只折叠零宽/不换行空格/全角前缀
   与空白，**不做其它 Unicode 归一化**（NFKC 等）——折叠后即须恰合；拒任何控制字符/换行/尾随内容/大小写变体；R52a 回带）
不匹配 → 控制失败返回（不降回普通指令）
匹配 → 整条只执行选择：不进主会话模型、不执行余下正文；入站路由器确定性处理
       （同 /feishu-mode 纪律）；owner 先验先于 handle 解析
```
- `osh_`=首次选择（activate/anchor）、`orh_`=rebind、`rfh_`=reaffirm（§8.1）；**省略** handle 仅当
  候选集合恰一。
- **折叠与拒绝的边界（PR #136 一轮回带）**：折叠只针对零宽字符、NBSP/全角空格、全角前缀与 ASCII 多空格；**C0 控制字符与换行/制表在折叠前即拒**
  （命令词或参数里出现 → `malformed_control`，绝不落成 ordinary 进模型）。**准入联合以外的任何状态（缺席/未知/非对象）一律投影为 unreadable → 拒**。
  **执行器未接入期间**（⑦ 先于 ⑤/⑥ 落地）准入通过也**不得落 consumed**——落 `control-failed` 终态 `select_executor_absent`；**该终态与其它 failed 一样是终态：
  同一 message 的重放只回『之前已失败』，不再调用执行器；要重做必须发一条新消息**（PR #136 二轮裁定，改掉此前『重放可补做』的措辞——不给 failed→consumed 开可恢复转换）；测试注入准入只许依赖注入，**不许读环境变量**（生产不可达）。
- **消费者穷举**：control 联合每加一种 kind，`inbound`（两链）、`repair-control-claim`（两链）、consumed/failed 记录读写、预览文案
  都必须按 kind 穷举，不得默认按 mode。
- **执行支接入后的执行纪律（#147 一轮回带，R57d）**：① **按账本 `authority_mode` 封闭分派**——`shadow` 期 osh/orh 的 activate / anchor / rebind 必须走 M1a 复合双写（`m1a-order.lock` → legacy 提交回调 → 账本），`authoritative` 才可 ledger-only，其它值拒；owner_select writer on ≠ 账本已 authoritative。② **执行层消费受验 owner capability**：`/feishu-select` 是 R3 control；capability 由本次 R3 owner 放行后铸成、绑定本次选择上下文，**不持久化**（不收裸 sender id、不认通用 full）；control claim 持久化的是选择上下文（endpoint / chat / 事件 session / 事件 message / sender / handle+kind）与执行前解析出的 immutable selection plan（action / target_id / basis / 实际 handle / CAS 字段），repair 续做前重读 claim、重核角色 / endpoint / chat 后**重新铸** capability。③ **同 message 的事实漂移不得被终态 claim 遮蔽**：claim 记 `selection_context_digest_v1 = sha256(domain 前缀 + canonKey({endpoint, chat, session, message, sender, handle, kind}))`——**不含 root**、缺项显式 null；终态短路前逐字比较，不一致 → `select_context_conflict` 而非「之前已处理」。④ **不干净提交不落普通 consumed，也不落普通 failed**：只有账本提交 `committed_clean | replayed | already`、intent/claim 清理 cleared、两层锁释放 released 三份都干净才回「已生效」；任一不干净（`committed_durability_uncertain` / `committed_with_residue` / 锁或清理残骸）→ **可恢复状态 `control-committed-unclean`**（不是终态、不是普通 failed——落 failed 会让同 claim 永不再执行、封死恢复矩阵；收据与文案外显「已写入但收口不干净」；`repair-control-claim` 有专门收尾路径：重读账本核已提交 → 只做清理/释放 → 转 consumed，核不出则保持并点名）；判定抽叶子纯函数分别给出三份结果，口径同维护编排的 stepCommitCheck 但不依赖该模块。⑤ **owner_select 的 root / session 来源**：root = 命中 B1 的 `aliases.root_om` / A2 的 `anchor_candidate`（与 `selected_root_om` CAS），session = 受验入站事件 session；证明是 owner 的行政选择（owner_select_v1 六字段），**增量形不收 F4、不声称 transport 验过 thread_root**。⑥ activate 族的候选 eligibility 含「事件 session/chat 上存在可归并 A1」（解析层纳入、锁内复核），到期在锁内复核（§4）。⑦ 歧义回执按 §13：**上限 5**（≤5 全列；>5 按标签序列前 5 并提示还有 N 个）的 opaque handle + 安全标签，不回记录 id。
- **执行支补充（#147 三轮回带）**：⑧ **shadow 期的 rebind**：存在与所选 B3 / rebind intent **精确绑定的新代际 pending W2 身份**时，复用既有 legacy writer（Claude `promoteBinding` / Codex `promoteTask`）→ `rebind_session_alias` 复合双写；不存在时才拒（fail-closed），不得把任意 orh_ 冒充 W2；legacy 回调找不到目标（如 Codex 按 projectRoot 找不到 task）一律拒、绝不回退到「当前 task」。⑨ **capability 只由入站路由的 R3 成功分支铸造并显式传入**，铸造函数不在别处调用；执行器收不到 → 拒；repair 重核角色 / endpoint / chat 后才重新铸造；写层校验含 endpoint / chat / session / message / sender / handle / kind 全部字段。⑩ **claim 的判别联合由 `claim.control` 决定**（不给调用方布尔开关）：省略 handle → handle / kind 同为 null；显式 osh / orh / rfh → 两者必在场、前缀匹配且逐字等于 control；rfh 永远不走省略支。⑪ **selection plan 先可靠落盘，再写 legacy / ledger**：用 `selection-plan.mjs` 同一套写原语（O_EXCL tmp（`.<key>.selection-plan.json.tmp.<pid>.<uuid>`，命名封闭）→ fsync 文件 → **no-replace 发布 `linkSync(tmp, final)`**（EEXIST → 受验全符复用 / 冲突，绝不 rename 覆盖）→ unlink tmp → fsync 目录 → 受验读回（单硬链接守卫），失败按阶段折叠 residue / durability_uncertain）；完整 plan 可复用，部分 / 冲突 / 不可读 → fail-closed。**link 后 unlink 前崩溃的恢复（#145 九轮）**：先全量盘点严格匹配命名的候选，盘点完成前不 unlink；唯一候选 + 与 final 同 dev/inode + final nlink==2 + 打开后 fstat 复核一致才恢复（unlink tmp → fsync 目录）；异常（非 ENOENT）、异形、异 inode、多候选、final 缺席而候选在场 → 整体非绿并原样带出 residue 路径 / 错误码（EEXIST 支重读亦然，不得折成 conflict）；恢复只在持锁入口（写入口 / repair），纯读取不删文件。⑫ **legacy 已提交、账本未提交 = 部分提交**，落 `control-committed-unclean`（记录 legacy 已成功），不得落普通 failed；repair 逐字核 plan / fingerprint / target / selection_message_id / CAS 找唯一 op 并清查 outer / ledger 残骸；unclean 与 consumed / failed 共存 → 冲突。
- **执行支补充（#147 四轮回带）**：⑬ **W2 精确绑定 = root 与旧 session 同时 CAS**：两链在最新 legacy 现场核 `active.root === rootOm` **且** `active.session_id === expectedOldSessionId`，都对上才激活 pending 新代际；任一不符 → 结构化拒（reason 区分 root / session，why 点名两边值）；promote* 只 CAS pending generation / rotation 不算绑定。⑭ **select 支的 repair 不得 fail-open**：必须拿到完整受验角色表（frank_sender_id + senders）、chat、以及由当前 chain / agent_uid 派生的 endpoint 并与 claim 的 selection_context 交叉核验，任一读不出或不符 → 拒且不铸 capability（非 select 支的 repair 维持原行为）。⑮ **unclean 记录必须带结构化 detail**：legacy / ledger 各自的提交状态（committed / not_committed / unknown）+ action / target_id / request_key / plan 引用 + ledger 拒因，校验器封闭 detail 联合（缺一读为 unreadable）；repair 按 detail 分支：ledger 已提交 → 只清残骸转 consumed；**ledger 未提交而 legacy 已提交** → 在 outer 锁内按冻结 plan **前向补 ledger**（同一 request_key / CAS，幂等；补不上保持 unclean 点名），或有可证明安全的 legacy CAS 回滚才回滚；不重执行选择。⑯ **三份结果的最终分类在事务层看见终态 sidecar 写入 / 清理结果之后才做**：consumed 记录写失败 = 已提交但收口不干净（unclean，detail 标明 legacy / ledger 已提交），不得回「未执行」；intent_cleanup 取真实清理结果而不是常量。
- **执行支补充（#147 六轮回带）**：⑰ **selection plan 的 basis 联合按 kind / action 封闭**：activate / anchor 认 `explicit_handle | unique_candidate`，rebind 只认 `rebind`；不存在的字面量（如 `resolved`）不得出现在校验器里——校验器接受的集合必须与解析器实际产出的集合逐字一致，否则合法路径不可达。⑱ **plan 写入前置无条件**：执行器像 rfh 的 mutation 层一样无条件要求受验 claimsDir / key（CLAIM_KEY_SHAPE）/ claim，缺失即 `selection_plan_context_missing`，不得调 legacy / ledger（wire 调用数 0）。⑲ **前向恢复的闭合判据**：plan↔账本 op 的比对用同一份预期 fingerprint / result 投影（basis、target、selection_message_id、全部 cas、消费的 handle），已有 op 与补写后的 op 都逐字核；只在账本原语返回 clean / idempotent、且无 residue / lockUncleared 时才转 consumed，`committed_durability_uncertain` / `committed_with_residue` / 锁残骸各自点名保持 unclean。
- **执行支补充（#147 十四轮回带，R57d 返修十三）**：⑳ **残骸清理与耐久受验的威胁边界与部署前置**：同 UID 并发恶意替换目录不在威胁模型内（账本与 claims 目录为 0700 属本用户，能做到这一点的对手可直接改账本）；账本侧残骸清理原语（`clearLedgerResidue`）保证的是：删除前受验绑定 + 绑定后最窄窗口 + 事后 inode 检测（`fstat(fd).nlink === 0`），检测到越界即 fail-closed 且点名（记 `foreign_unlink` 并报 `ok: false`），但进程内无法撤销已发生的越界删除。**部署前置**：`claimsDir` 及其整条祖先链必须是规范绝对路径且无 symlink（`realpath(d) === d`；真机已核：`~/.claude/feishu-bridge/{ledger,maintenance}` 与项目 `.runtime-data` 均 canonical），任何一级为 symlink 则判定 `not_canonical` 且拒（错误文案带出 realpath 以便定位）。
- `request_rebind` 触发：终端 `/feishu-rebind`（走脚本）签发 `orh_` 并回执；`request_reaffirm`：
  终端 `/feishu-reaffirm-issue`（§8.1）签发 `rfh_`。

## 13. 多候选呈现边界（现在定下——P2-2）
多候选回执列表**只对已过 owner 先验的回合产出**；**数量有上限**（超限提示收窄）；**只含 opaque
handle + 稳定安全标签**。**标签来源必须持久（P2-2）**——**单一算法：只用已受验、已持久的 record `created_at`（同刻并列以
`topic_agent_id` 字典序定序），投影为安全标签**（渲染算法拍定于 #147 一轮回带：`created_at` 以 `Asia/Shanghai` 渲染为 `MM-DD HH:mm`，同一分钟并列按 `topic_agent_id` 字典序加后缀 `·a`、`·b`…；数量上限 5）（owner 能对应到已见接通卡；八轮 P2-2：不另加未落
合同的 ordinal 字段、不留第二数据源），**绝不由每次盘点临时排序生成**
（否则 owner 重试时标签漂移）；**绝不含** locator / root_om / 精确本地目标 / 会话 id / chat_id；
**限码点数与控制字符**。reply_only 回合边界照旧。

## 14. 开放子决策（复审时确认）
- 具体 TTL 时长（`handle_expires_at`/`rebind_expires_at`/reaffirm intent `expires_at`）——留实现单，
  但比较语义已定（§4：持久规范时间 + 锁内比较 + expected-value CAS）；**开工前拍定为单一常量**。

## 15. 复审对照（v16 · Codex 十六轮放行）

十五轮 1 P1（pre-anchor 崩溃窗口）已由 §6 四支 pre-forward 状态矩阵 + plan `before_ledger_sha256`/
`token` 绑定 + §8 rollback 先删 plan 闭合，十六轮核验通过。十六轮唯一 P2（`cleanup_pending` 非阶段名）
已统一为 `rollback_incomplete`。**十六轮 P1 计数：7/6/6/6/6/5/5/4/4/2/2/2/1/1/1/0。**

**rollout（三个 migration operation + writer_enable）是维护门内硬变更、与"装"同级，仍需 Frank 逐次
授权**（§11）；装过渡版 runtime 本身是一次独立的装。
