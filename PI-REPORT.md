# R48 账本侧 owner_select 账本地基 — PI-REPORT（v2）

## 分支与对象
- 分支：`pi-ds/r48-owner-select-ledger-foundation`
- HEAD：`0d4f17d`（rebase 到 `origin/main = a3c649b` 之后，含三笔新增提交 `c673071`/`68fad94`/`0d4f17d`）
- 范围：**账本侧，仅校验器；不接任何生产写方；不 `--apply`；不碰运行时与 `.runtime-data`；测试不打真飞书。**
- 文件触及：`scripts/topic-agent-ledger.mjs`、`scripts/test.mjs`（实现 + 测试）；纯文档不做。

## 落点表（相对 `origin/main = a3c649b`）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| item 1 | schema 字面值域 `{1.0,1.1-transition,1.1}` + 读侧校验 | dds（`efae212`） |
| item 2 | live 记录四枚 handle 字段（§8.2 绑定/§4 跨字段联合；B1/A2/rebind 必空/必非空） | dds（`efae212`） |
| item 3 | 三新 proof 形状 `owner_select_v1`/`owner_selected_route_v1`/`owner_select_merge_v1` 逐字段封闭（§3.1/§3.2/§3.3） | dds（`c70b670`） |
| item 5a | 既有 op result 增量（基线∪基线+新键联合；1.0 拒新键；activate 用基线键名） | **完成**（`a956342`） |
| item 5b | `proof_effects` 恒等式（整账本） | **完成**（`a956342`） |
| ① 新 op 注册 | 8 个新 op（`request_rebind`/`clear_anchor_handle`/`reissue_selection_handle`/`expire_rebind_handle`/`cancel_rebind`/`mint_selection_handles`/`owner_select_reaffirm`/`schema_upgrade`）进 OP_TYPES/RESULT_SHAPE/opTouchedIds/opConsistentWithRecord（**新 op 无基线，§6 键集即完整封闭集**） | **完成**（`c673071` + 拒 path 测试 `68fad94`） |
| ② G11′ 族归属 | binding=owner_select_v1 于 B3/B3′/B4/A4（A2/A3 否）；link=owner_selected_route_v1 于 B3/B3′/B4/A3/A4；A1/B1 禁 | **代码完成**（`c673071`；运行时正测试被 G13′ 依赖阻塞，见如实说明） |
| G-handle（§7.2 可得部分） | selection_handle 四源（create_b1/attach_a2/reissue/mint，各按对应 result 字段取）+ rebind_handle=request_rebind + handle_expires_at 一致性 + endpoint 内 live handle 全局唯一 | **完成**（`0d4f17d`，mint→B1 正反向测试） |
| G11′ 六字段等（binding=owner_select_v1 ⇒ selected_*===aliases.*） | 前轮 `a956342` 已落 | 完成 |
| G15′ strict(1.1) 拒 legacy pairing（matched_fields/pending_token_state） | 前轮 `a956342` 已落 | 完成 |
| migrated→owner_selected_route_v1 link 放宽（Frank 指示） | 前轮 `a956342` 已落 | 完成 |
| G13′（produced/preserved 两支，按来源 op result 的 proof_effects 中本记录项判） | **未落地** | 如实说明 |
| G15′ handle 前缀↔来源 op（activate/anchor→osh_、rebind→orh_、reaffirm→rfh_） | **未落地** | 如实说明 |
| G13-tomb（owner_select_merge_v1：op result 点名 tombstone、forwards_to 一致、op_type 集、reaffirm tombstone_remap 逐项核对） | **未落地** | 如实说明 |

## 门禁数字如实
- **Claude 套件** `node scripts/test.mjs`：注册 924（相对基线 917 增 7；本 PR 新增 7 个 R48 测试），**通过 922 / 失败 2**。失败 2 项为**既有、约定豁免**的 doctor 红（`doctor：好机器` launchctl；`doctor：⑫ 订阅对账` m1a_shadow_reconcile）。相对基线零回归。
- **Codex 套件** `node scripts/codex/test.mjs`：**293 / 0**。
- **`git diff --check origin/main...HEAD`**：干净（exit 0）。
- `git status`：`PI-TASK.md` 未跟踪（不提交）；无其他未提交改动。

## 关键实现决策
- **① 新 op 无基线**（按 Frank 指示）：`request_rebind`/`owner_select_reaffirm`/`clear_anchor_handle`/`reissue_selection_handle`/`expire_rebind_handle`/`cancel_rebind`/`mint_selection_handles`/`schema_upgrade` 是设计新增，**不存在基线 result 键集**，§6 表列出的键集即完整封闭集，直接注册进 OP_TYPES/RESULT_SHAPE/opTouchedIds/opConsistentWithRecord。「增量 over 基线」只对既有 op（create_b1/attach_a2/activate/anchor/restore/unbind/retarget/rebind_session_alias）。
- **G-handle（可得部分）**：selection_handle 产生源 {create_b1, attach_a2, reissue_selection_handle, mint_selection_handles}，各按对应 result 字段取（create_b1/attach_a2→`selection_handle`、reissue→`new_handle`、mint→`minted[*].selection_handle`）；handle_expires_at 同源取；rebind_handle 源=request_rebind（`rebind_handle`/`rebind_expires_at`）；endpoint 内所有 live selection_handle / rebind_handle 全局唯一。说明：handle-only op 改 origin ⇒ 记录当前 origin 即最近一笔产生源（简化，符合 §7.1「handle-only 改 origin」）。

## 红先行
| 块 | 先红 | 后绿 |
| --- | --- | --- |
| 新 op 注册（①） | 旧 OP_TYPES 不含这些 op → `op_type 越界`；RESULT_SHAPE 缺项 → 形状不对 | 注册后绿（`68fad94`：reject 路径 + schema_upgrade accept） |
| G11′ 族归属（②） | 无 owner_select_v1 于 B3/B3′/B4/A4（`binding_proof.kind 与族不匹配`） | okKind 加 owner_select_v1 后绿（代码；运行时测试见如实说明） |
| G-handle（mint→B1） | 无 handle 溯源判据（超范围非产生源、字段不符仍过） | 溯源后绿（`0d4f17d`） |

## 变异刀（行为断言，≥3 刀）
- 刀 1：`proofEffectsOk` 放行非法 effect 值 → “坏 proof_effects 值拒”红。
- 刀 2：5b 恒等式放成“子集” → “无 proof 却报 produced 拒”红。
- 刀 3：G11′ 六字段等去掉 → “owner_select_v1.selected_*!==aliases.*”无判据。
- 刀 4：G-handle 产生源集合漏 mint → “mint 产 B1 handle 不一致拒”红（`0d4f17d` 正反向）。

## 如实说明（缺口 / 未做，不补规则）

### ① G13′（produced/preserved 两支）未落地 —— 阻塞于 activate/anchor 的 result 六字段确切名
§7.2 G13′-A 要求「`selection_operation_id===origin_operation_id`、**result 字段与 proof 逐字等**；`binding_effect:"produced"`（binding=owner_select_v1）时**六字段等**（A）」。这里的「六字段」指 `authorized_by, authorized_at, selected_session_id, selected_root_om, selection_handle, selection_operation_id`（从 §3.1 owner_select_v1 的 8 去 kind/by_identity 可得），但 **§6 表的 activate/anchor 行只写「授权/选择六字段」，未逐字列出这些 result 字段名**；g13′-A 要与 proof「逐字等」，就必须有这些确切字段名。**凭 §3.1 推字段名去注册 + 自洽测试，是「断言守卫效果不是样子」的典型——测试只会用我自己起的名字，真写方用别名字就被误拒**。故不注册、不实现 G13′，记为缺 Frank 枚举的字面字段名（或确认 activate/anchor result 是否其实不拷贝六字段、而是靠 proof_effects 判产证/保留）。
- 连带阻塞：⑨ owner_select 产证类（activate→b3 / anchor→a3 / rebind→b3）的**accept-path 整个账本测试**——它们需要 origin op result 携带 proof_effects 且 G13′ 判产证，因此我现在只能对**既有 op 的 union 形状**与**新 op 的 reject 形状**做「拒 path」测试，未做产证链全链路 accept 测试。

### ② G15′ handle 前缀↔来源 op 未落地 —— 依赖 ①
`selection_handle` 前缀必与产生 op 相符（activate/anchor 只 `osh_`、rebind_session_alias 只 `orh_`、owner_select_reaffirm 只 `rfh_`；跨支即拒）。这要在「产生 op 的 result 带何种 handle、何种前缀」上判，与 G13′ 同属 activate/anchor result 字段名缺口。

### ③ G13-tomb 未落地 —— 依赖 ①
`owner_select_merge_v1` tombstone 的 G13-tomb：op result 点名该 tombstone id、`forwards_to===同 op 存活/target id`、root/handle 与 result 一致、`op_type ∈ {activate, rebind_session_alias, owner_select_reaffirm}`、因果 revision 与直接归并关系闭合、reaffirm 的 `tombstone_remap` 逐项核对。依赖 activate/rebind/reaffirm result 携带对应 tombstone 与六字段名。

### ④ G11′ 族归属运行时正测试缺失 —— 依赖 ①
okKind 已把 owner_select_v1 放入 B3/B3′/B4/A4（代码对），但正测试需要一份「B3 + owner_select_v1 产证」合法账本——同样被 G13′ 依赖阻塞。G11′ 族归属的代码改动是单行、直判，但按「行为测试优先」未补全运行时证据。

### ⑤ 新 op accept-path 未覆盖
新 op（request_rebind/reissue/owner_select_reaffirm/mint 等）的**正**路径（含 affected 记录在场的整本合法）未测——受 5b 恒等式 + G13′ 依赖牵制（见①）。已测：schema_upgrade accept（无 proof_effects）+ 全部新 op 的 **reject 形状**路径。

## 结论
- 本 PR 完成：**① 8 新 op 注册**、**② G11′ 族归属代码**、**G-handle（selection_handle 四源 + rebind_handle + 全局唯一）**、5a/5b、G11′ 六字段等、G15′ strict 拒旧 pairing、migrated→owner_selected_route_v1 link 放宽、既有 op result 增量联合。
- 相对基线零回归：claude 922/2（2 约定豁免 doctor 红）、codex 293/0、`git diff --check` 干净。
- **未做（未补规则）**：G13′、G15′ 前缀↔op、G13-tomb、以及 G11′/新 op 的 runtimе accept-path 全链路——**阻塞于 §6 对 activate/anchor「授权/选择六字段」未逐字枚举，G13′-A 需其与 proof「逐字等」**。凭 §3.1 推名会造出「绿但错」校验器，故不猜。
- 请 Frank 确认 `activate`/`anchor`/`rebind_session_alias` result 的**六字段确切名**（或确认产证判据只用 proof_effects、不需 result 拷贝六字段），我据此再补 G13′/G15′ 前缀/G13-tomb 与产证链全链路测试。不 `--apply`、不开 PR/合并，由 Frank 决定。
