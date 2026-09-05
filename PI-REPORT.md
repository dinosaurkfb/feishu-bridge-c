# PI-REPORT — R36 W2 两阶段 + P1-3①（Frank 拍板 Phase 2 落点后；本轮补 P1-3① 本体）

> 本轮把 P1-3① **本体**（三个 codex 调用点接 outer-lock 双写）落地，并把上轮「④ 守卫测试未干净落地」
> 补齐（根因 = 收据形状不对，非代码 bug）。上一轮已闭合的 W2 Phase 1 + Phase 2 no-op 判定不变，
> 且本轮**同时把 ④ 的 3 条守卫测试在套件内干净落地**（之前只靠独立探针）。

## ① 核实：现行 legacy 无「就地改既有绑定 claude_session_id」的写方 —— 已确认（不变）

| 写点 | 行为 | 结论 |
| --- | --- | --- |
| `bind-session.mjs:89` | 新建会话级绑定（新 id / 新 lineage）| **新建**，非就地 |
| `feishu-rotate.mjs:155` | bindingTarget 传给 wireRotate，作为**新代际**创建带 target | 新建代际 |
| `live-session.mjs` `writeDeliveryPin` | 写独立偏好文件（`.runtime-data/inbound/delivery-session.json`），刻意不复用 claude_session_id | 偏好文件，非 target |
| 账本 `retarget` op | 定义存在，**无产品调用方** | 死路径 |

→ **无就地改写方**。Phase 2 = **no-op**（无消费方，不需 intent 机制）。

## ② 文档（不变）

见 `m1a-reconciliation.md` §5.1（「本地配对写方」预留 + Codex 裁定协议引用）与 `layers-v2-ledger.md` §5.1 op 表 `rebind_session_alias` 行。

## ③ W2 Phase 1 rebind + 守卫行为测试（P1-5② 整 target 逐字不变）—— 已加并绿（不变）

## ④ P1-3① **本体** —— 三个 codex 调用点接 outer-lock 双写（本轮新落地）

依赖链：`legacyEndpointId({runtime:"codex",agentUid})` 派生**相异** endpoint_id；`endpointReceipt` 按 endpoint_id
判别（codex/claude 各自独立）；`resolveEndpointDir`/`m1aOrderLockPath` 按 endpoint_id 落各自 ledger 根。

三个调用点（`scripts/codex/`）：

1. **A1 chat**（`chatTurn` 物化入口）→ `wireChatA1`：endpointId=`legacyEndpointId({runtime:"codex",agentUid})`、
   chatId=当场受验 locator（`AILY_CLI_CHANNEL_CHAT_ID || null`，同 claude，未受验→null→bad_input→拒物化）、
   sessionId=`event.session_id`、runtime="codex"、admit=admitChat 闭包。未启用端点（无收据）→ 合法 legacy-only。
2. **认领**（`promoteTask`）→ `wirePromoteBinding`：locator=`pending.generation.root_message_id`（matched_om）、
   claimKey=`claimKey(message_id, logical_task_key)`、sessionId=`event.session_id`、authorizedBy=`event.sender_id`、
   f4=认领校验处受验封闭产物（**本轮在 codex `evaluatePromotion` 加了四维真核的 chat 维校验 + f4 构建**：
   `matched_om=generation 根消息 om`、`matched_fields=[chat_id,sender,body,thread_root]`；chat 维不匹配→`chat_mismatch` 拒；
   generation 缺根消息 om→f4=null→bad_f4 fail-closed；AILY 群 env 缺失→照常放行由 shadow 记 scope_unverified）。
   首跑 B1→activate（W1）；再认领 active→rebind_session_alias（W2，不动 binding_target）。
3. **过期**（`pending_binding_expired` 分支的 `closeTaskTopicRotation`）→ `wireVoid({reason:"expired"})`：
   rotationOpId=`pending.operationId`、locator=`pending.generation.root_message_id`、reason="expired"、
   legacy=closeTaskTopicRotation 闭包；resolver 未命中→shadow fail-closed、legacy 照常过期。

关键一致点：f4 的 `matched_om` = `pending.generation.root_message_id`，与 wirePromoteBinding 传入的
`locator` **同一来源**（f4Ok 要求 `matched_om===locator`），故受验产物与 binding 目标一致、不出现"自铸产物对不上"。复认领走 `rebind_session_alias`——`locator` 用认领里的 `event.message_id` 取 B1（对齐 claude 同构）。

## ⑤ P1-3① **守卫测试** —— 本轮在套件内干净落地（修正上轮"只能独立探针"）

根因修复：先前在 test.mjs 内手工构造 codex 收据太薄（非 ledger step 带 chain、done step 缺 after、
缺 stub/current/gate 安装步），`readJournal` 判它 unreadable。本轮新增 `seedInitReceipt(maintDir, ep, chain, tok)`
（与 `seedLedgerInitReceipt` **完全同构**、仅参数化 endpoint/chain/token），借 `withRootAndReceipt` 夹具在套件内种合法收据。

新增一条组合 test「P1-3①：codex 端点隔离 + 双写」（`scripts/test.mjs`），逐条断言：
- **①** 仅 claude 收据（da88，endpoint_id=EP_claude）在机级目录 → codex 端点仍 `never_initialized`（claude 收据只启用 claude）；
- **②** codex never_initialized → `wireCreateA1` **legacy-only**（无 shadow、不写 codex 账本、legacy 已跑）；
- **③** codex 收据（bb88，独立 token，endpoint_id=EPc）→ codex 端点 `ok` → **双写**到 codex 自己账本根
  （`<ledger-root>/<EPc>`）；同时 claude 端点仍 `ok`（codex 收据不串扰 claude = 隔离）——codex A1 落 codex 账本、
  claude 账本未被触碰。

## ⑥ codex 四维真核单测（`scripts/codex/test.mjs` 新增 2 条）

- `evaluatePromotion` 产出封闭 F4（matched_om="om_b"、matched_fields=标准四项）；chat 维不匹配→`chat_mismatch` 拒；
  AILY 群 env 缺失→照常放行。
- 无根消息 om → f4=null（未受验不产封闭 F4）。

## 证据（gate）

- Claude 套件：`node scripts/test.mjs` → **867 / 失败 0**（含新增 P1-3① codex 隔离+双写 test）。
- Codex 套件：`node scripts/codex/test.mjs` → **283 / 失败 0**（含新增 2 条 f4 真核 test）。
- `git diff --check` 干净。
- `node scripts/install-outbound.mjs`（dry-run，无 --apply）→ 只预览、未写盘。
- `node scripts/doctor.mjs` → 返回 blocked，**唯一 ✗ 是 `cc2cd`（另一项目）runs 账本的 legacy_state「说不清」**，
  与本文档改动无关、非本轮引入；其余全绿（含「⑬ 无 endpoint 收据」「⑭ 无 shadow」——因为本分支还没跑 --apply）。

## 状态

- **W2**：Phase 1 完成+全绿；Phase 2 判定 no-op（无消费方）→ **闭合**。
- **P1-3①**：**本体三调用点已接线** + **⑤ 守卫组合测试已落地** + **⑥ codex 真核单测已加** → **本轮闭环**。
- 分支已推（`pi-ds/r36-m1a-wiring`，本轮补 commit）+ `git diff --check` 干净。**可送 Codex 二轮**。

残留（如实记录，非本轮阻塞）：
- `维护门 · PR B` 并发测试在满载下偶发（两真进程 waitMs=5000 争 surface_lock_residue），孤立跑 3/3 过，属既有时序抖动、与 W2/P1-3① 无关。
- doctor 的 `cc2cd` ledger 说不清点：跨项目既有、非本文档引入。
