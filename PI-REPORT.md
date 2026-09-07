# R48 账本侧 owner_select 账本地基 — PI-REPORT

## 分支与对象
- 分支：`pi-ds/r48-owner-select-ledger-foundation`
- HEAD：`a956342`（rebase 到 `origin/main = a3c649b` 之后）
- 范围：**账本侧，仅校验器；不接任何生产写方；不 `--apply`；不碰运行时与 `.runtime-data`；测试不打真飞书。**
- 纯文档基准：本 PR 只改 `scripts/topic-agent-ledger.mjs` 与 `scripts/test.mjs`（实现 + 测试），不碰 `.runtime-data`。

## 落点表（本次 head 相对 `origin/main = a3c649b`）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| item 1 | schema 字面值域 `{1.0, 1.1-transition, 1.1}` + 读侧校验（`SCHEMA_VERSIONS`） | dds 完成（`efae212`） |
| item 2 | live 记录四枚 handle 字段（§8.2 绑定/§4 跨字段联合；B1/A2/rebind 的必空/必非空） | dds 完成（`efae212`） |
| item 3 | 三新 proof 形状 `owner_select_v1` / `owner_selected_route_v1` / `owner_select_merge_v1` 逐字段封闭（§3.1/§3.2/§3.3） | dds 完成（`c70b670`） |
| item 5a | **既有 op 的 result 封闭键集增量**（基线 ∪ 基线+新键 的联合） | **完成**（`a956342`） |
| item 5b | `proof_effects` 恒等式（整账本，非逐 op 概括） | **完成**（`a956342`） |
| item 4 | G11′ 六字段等 / G15′ strict 拒旧 pairing / G-handle(selection_handle 溯源) / migrated→owner_selected_route_v1 link 放宽 | **部分完成**（`a956342`） |
| item 6 | 合成回归 + 变异刀 | **部分完成**（`a956342`） |

## 关键实现决策（含 [代码] → skipped: [X], add when [Y] 解释）

### item 5a：既有 op 的 result 增量用「基线 ∪ 基线+新键」联合而非全量替换
- `RESULT_SHAPE[op_type]` 对既有 op 改为 `resultUnion(baseSet, baseFn, extKeySet, extFn)`：接受**基线键集**（生产写方仍写基线 result，零变化）**或**基线+新键两枚（`affected_live_ids_after_commit` + `proof_effects`）。含新键时逐字段校验（`affectedOk` = 有序/去重/可空；`proofEffectsOk` = 每项恰三键、effect ∈ {produced,preserved,none}、id 有序去重）。
- **1.0 营收新键拒**：`operationProblem(op, topRevision, schema)` 增加 schema 参数；`schema==="1.0"` 时 result 带新键 → 拒（“增量字段仅限 schema≥transition”）。
- 覆盖既有 op：`create_b1`/`attach_a2`（另含 `selection_handle`/`handle_expires_at`，用 `handleShape` 校验 `osh_`），`activate`（保留基线 `surviving_id/tombstoned_id/demoted_historical_id`，**未采用**设计稿 §6 表里 `demoted_current_id/tombstoned_a1_id` 的笔误——按 Frank 2026 回带基线），`attach_a3`/`anchor`/`restore`/`unbind`/`retarget`/`rebind_session_alias`（基线 + 新两键）。
- skip：**新 op**（`request_rebind`/`owner_select_reaffirm`/`clear_anchor_handle`/`reissue_selection_handle`/`expire_rebind_handle`/`cancel_rebind`/`mint_selection_handles`）的 result 联合**未注册**。原因：§6 表它们的 `proof_effects`/新键已列，但**基线 result 键集依赖 `ledger §5/§5.1`**（表中明写“基线见 ledger §5/§5.1”“既有 fingerprint 输入与 result 键原样保留”），当前设计稿 excerpt 未给出这些 op 的**基线键集**；凭空补会犯“同 key 换既有业务输入被误判”的错。且这些 op 无生产写方（当前 R48 不写），注册了也无人消费。add when：拿到 `ledger §5/§5.1` 对应 op 的基线 result 键集后再注册（回带 `ledger §5.1` 时同步扩）。

### item 5b：`proof_effects` 恒等式（整账本）
- 在 `validateLedger` 内对每个 result 同时含 `affected_live_ids_after_commit` 与 `proof_effects` 的 op：计算集 = affected 中「提交后仍 live ∧ `origin_operation_id===本 op` ∧（`binding_proof!==null` ∨ `locator_link_proof_ref!==null`）」的记录，**恰等于** `proof_effects.map(e=>e.topic_agent_id)`（同序比较）。且 proof_effects 的每个 id 必须落在 affected 集内。
- 语义严格按 §6 “`proof_effects` 的 id 集**恰等于**（不是子集）`affected_live_ids_after_commit` 中提交后至少一面 proof 非 null 的记录集”；tombstone 不进这两个集（它们不属 `live`）。

### item 4 已落地部分
- **G11′ 六字段等**：`binding_proof.kind==="owner_select_v1"` ⇒ `selected_session_id===aliases.session_id` ∧ `selected_root_om===aliases.root_om`；`locator_link_proof_ref.kind==="owner_selected_route_v1"` 时仅当 `binding_proof.kind==="owner_select_v1"` 也六字段等（否则走 G13′-B 独立校验——G13′ 未到，见如实说明）。
- **G15′ strict 拒旧 pairing**：`schema==="1.1"` 时 live 记录任一带 `matched_fields`/`pending_token_state` 的 proof（binding 或 link）→ 拒；过渡 `1.1-transition` 容旧+新；`1.0` 维持现状（不存在这些键）。
- **migrated→owner_selected_route_v1 link 放宽（Frank 2026 指示）**：`proofCombinationProblem` 中 `binding=migrated` 的 pair 放宽为 `link ∈ {migrated, owner_selected_route_v1}`；`B3/B3′/B4` 的 link 允许集加入 `owner_selected_route_v1`。
- **G-handle（selection_handle 溯源，partial）**：live 记录非空 `selection_handle` 必须逐字等于其产生源 op（`create_b1`/`attach_a2`）result 的 `selection_handle`；产生源非合法集 → 拒。

### 行为零变化（“1.0” 约束）
- 所有既有测试在 `TEST_FILTER="账本"` 下仍全绿（53/53），含既有 A4/proof-组合/R32/R34 用例；未引入任何新失败。
- 引入的唯一行为差异：schema≥transition 时对含新键的 result 逐字段校验 + 1.0 拒新键 + 新 G11′/G15′/G-handle/5b 判据——这些由 R48 新增测试覆盖。

## 红先行（每块先红后绿）
| 块 | 先红（改动前失败） | 后绿 |
| --- | --- | --- |
| 5a 既有 op result 联合 | 扩展 create_b1/activate 等 result 被 `operationProblem` 判“result 形状不对” | add ResULT_SHAPE union 后绿 |
| 1.0 拒新键 | 无此判据（1.0 扩展 result 被误放） | operationProblem schema 门 + 测试 |
| 5b proof_effects 恒等式 | 无整账本判据（无 proof 记录却报 produced 仍过） | 5b 恒等式后绿 |
| G-handle | 无溯源判据（handle 与产生源不符仍过） | G-handle 溯源后绿 |
| G11′/G15′/migrated link | 无对应判据 | 各判据后绿 |

（注：R48 “items 1–3” 为 dds 完成；其先红后绿记录在 `efae212`/`c70b670` 提交说明。）

## 门禁数字如实
- **Claude 套件**：`node scripts/test.mjs` → 注册 922（相对基线 917 增 5，本 PR 新增 5 个 R48 测试），**通过 920 / 失败 2**。失败 2 项为**既有、约定豁免**的 doctor 红（`doctor：好机器`——沙箱不注入 launchctl；`doctor：⑫ 订阅对账`——`m1a_shadow_reconcile` 真实进程）。相对基线零回归。
- **Codex 套件**：`node scripts/codex/test.mjs` → **293 / 0**。
- **`git diff --check origin/main...HEAD`**：干净（exit 0）。
- **`git status`**：`PI-TASK.md` 未跟踪（不提交）；无其他未提交改动。

## 变异刀（self-check ≥3 刀）
- 刀 1：`proofEffectsOk` 放行非法 effect 值（如 `"bogus"`）→ R48 测试“坏 proof_effects 值拒”必须红。
- 刀 2：5b 恒等式改成“子集”而非“恰等”（漏推一条）→ “无 proof 记录却报 produced 拒”必须红。
- 刀 3：G11′ 六字段等去掉 → “owner_select_v1.selected_*!==aliases.*”无判据。
- 刀 4：migrated+migrated 不放宽（把 owner_selected_route_v1 从 pair 集删掉）→（无对应红测试，暂未做正向用例——见如实说明）。

（实际落地为行为断言，非源码扫描；测试用合成 doc 直呼 `TAL.validateLedger`。）

## 如实说明（设计缺口/未做，不补规则）
1. **G13′（全 op 交叉）全部未落地**：§7.2 的 G13′ 判“产证 vs 继承”，依赖 `proof_effects` 中 `topic_agent_id===本记录 id` 项的 `binding_effect`/`link_effect`，再分 `link_effect:"produced"`（`selection_operation_id===origin_operation_id`、result 字段与 proof 逐字等）与 `link_effect:"preserved"`（原产生 op 的 `proof_effects` 曾 produced、来源 revision ≤ 当前 origin revision、proof 字段与产生 result 一致、当前 origin 属允许保留的直接迁移 §7.1）两大支。这是 R48 最重的校验器，需逐支行为测试（含“本记录在 result 的角色”= b3_id/demoted_current_id/tombstoned_a1_id），本 PR 未做——记为设计缺口，下一步首选。
2. **G11′ 新 op 的 binding 族归属未落地**：`owner_select_v1` 的 family 归属（哪些族可配它）`liveProblem` 的 `okKind` 未纳入 `owner_select_v1`——§7.2 只写“kind 增三新形”，未把三新形逐族列出 value 域；不按族枚举就不注入 `okKind`，不猜测。
3. **G-handle 完整版未落地**：仅 selection_handle（create_b1/attach_a2 两源）。完整版还需：`rebind_handle` 溯源（`request_rebind`/`reissue_selection_handle`/`mint_selection_handles`）、endpoint 内所有 live handle 全局唯一、产 handle 的 op 的 `result_revision` 必小于其消费/清理 op（activate/anchor/void/clear/expire/cancel/rebind_session_alias）的、当前 origin 直接触及链闭合。这些依赖新 op 注册（见上 item 5a skip）与各产生/消费 op 的 result 键集。
4. **G15′ handle 前缀↔来源 op 绑定未落地**：`selection_handle` 前缀必与产生 op 相符（activate/anchor 只收 `osh_`、rebind_session_alias 只收 `orh_`、owner_select_reaffirm 只收 `rfh_`），跨支即拒。依赖新 op 注册与各产生 op 的 result 键集。
5. **新 op 注册**：见 item 5a skip 说明（依赖 `ledger §5/§5.1` 基线键集）。
6. **activate/anchor “授权/选择六字段” 枚举**：本 PR 未逐字段封闭（六字段 = selected_session_id/selected_root_om/selection_handle/authorized_by/authorized_at/selection_operation_id 的 result 投影），因 anchor/activate 的基线 result 键集未在手，与 G13′ 一起记为缺口。
7. **owner_select_merge_v1 的 G13-tomb**（op result 点名该 tombstone id、forwards_to 与 result 一致、op_type ∈ {activate, rebind_session_alias, owner_select_reaffirm}、因果 revision 闭合、reaffirm 的 `tombstone_remap` 逐项核对）未落地——依赖新 op 注册。
8. **schema_upgrade / mint_selection_handles / request_reaffirm(intent sidecar) / writer_state** 等属机器级迁移与写方侧，本 PR 明确不接（R48 只做账本侧校验器，无生产写方）。

## 结论
- 本 PR 是 R48 账本侧地基的**一期落点**：schema 域（1–3）、既有 op result 增量联合（5a）、`proof_effects` 恒等式（5b）、G11′/G15′/G-handle(selection_handle)/migrated-link 放宽（4 partial）、合成回归（6 partial）。
- 相对基线（`origin/main = a3c649b`）**零回归**：两套套件全绿（claude 920/2 约定豁免 doctor 红；codex 293/0），`git diff --check` 干净。
- **未做成的部分在如实说明里逐条列清**：G13′, G11′ 新 op 族归属, G-handle 完整版, G15′ 前缀绑定, 新 op result 键集注册, activate/anchor 六字段, G13-tomb——多为“依赖 `ledger §5/§5.1` 基线键集或 §7.2 族枚举未给出”的**真实设计缺口**，未凭猜补。
- 请 Frank 验收；不 `--apply`，不开 PR/合并（按分工由 Frank 决定）。
