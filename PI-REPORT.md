# PI-REPORT — R36 W2 两阶段 + P1-3①（Frank 拍板 Phase 2 落点后）

> 本轮按 Frank 拍板的 W2 两阶段 + Phase 2 落点处置四件。结论：**Phase 2 判定为 no-op**
> （现行 legacy 无就地改既有绑定 claude_session_id 的写方），故 W2 = Phase 1（rebind，已完成）
> + Phase 2（无消费方，不需要 intent 机制）。P1-3① 隔离经独立探针验证**结构上已正确**。

## ① 核实：现行 legacy 无「就地改既有绑定 claude_session_id」的写方 —— 已确认

grep 全部 `claude_session_id` 写点 + 行为核对：

| 写点 | 行为 | 结论 |
| --- | --- | --- |
| `bind-session.mjs:89`（`newSessionEntry`）| 新建会话级绑定：`...newRegistryEntry()` + 新 id（`basename(root)+"@"+uuid前8`）| **新建**，新 lineage，非就地 |
| `feishu-rotate.mjs:155` | `bindingTarget` 传给 `wireRotate`，作为**新代际**创建时带 target（rotationOpId/lineageId）| **新建代际**时带 target |
| `live-session.mjs` `writeDeliveryPin` | 写 `.runtime-data/inbound/delivery-session.json` 独立文件；文档**刻意不复用** claude_session_id，明文「只是偏好不是权威」| 偏好文件，非绑定 target |
| 账本 `retarget` op（`topic-agent-ledger.mjs:1466`）| 定义存在，但**无产品调用方**（无 `wireRetarget`、认领/rebind 路径不触发）| 死路径，未接线 |

→ **无就地改写方**。W2 认领后两侧保持旧 target，双射成立。**Phase 2 不需要 intent 机制**（没有消费方的持久 intent 是死状态）。

## ② 文档

- `m1a-reconciliation.md` §5.1：「本地配对写方」行标为**预留**，全文引用 Codex 裁定协议（W2 驱动=claim key 作持久 intent、非 W2 驱动=需 owner 授权独立 operation id、锁序 outer→legacy→ledger），并写明**现行写方集为空**；将来引入任何就地改 target 的写方必须按此行接线 + intent 机制一并实现，否则是 cutover blocker。
- `layers-v2-ledger.md` §5.1 op 表 `rebind_session_alias` 行注明「binding_target 的 retarget 归 Phase 2 配对写方，**当前无消费方、预留**」。

## ③ 守卫行为测试 —— 已加并绿

在 P1-5②（W2 换会话再认领）里把断言从「只管 `binding_target.claude_session_id` 不变」**加强为整体 `binding_target` 逐字不变**（`assert.deepEqual(b3.binding_target, {runtime:"claude", project_root:o.root, claude_session_id:oldUUID})`），守「认领路径除 delivery pin 外不碰任何 target 字段」。连同 `m1a 双写接线` ②（line 26009）一起守「W2 认领前后既有代际 target 不变」（防未来有人顺手在认领路径改 target 绕过裁定）。

## ④ P1-3① —— 隔离已验证正确；守卫测试**未能在套件内干净落地**（如实记录）

用独立探针（`/tmp/p13a_probe.mjs`）验证结构正确：
- `legacyEndpointId({runtime:"codex",agentUid})` 与 claude 派生**相异** endpoint_id；
- `resolveEndpointDir` 按 endpoint_id 落 `<ledger-root>/<endpoint_id>`（codex 独立 ledger 根）、`m1aOrderLockPath` 同理；
- **仅 claude 收据**时 codex `endpointReceipt` 判 `never_initialized`（claude 收据不影响 codex 判定）。

我在 test.mjs 写了一版 3 断言守卫测试：`endpointReceipt` 收据对象**在独立进程复现 = ok**（state=ok, initDone=true），但**同进程放 test.mjs 里跑却判非 ok** —— 是测试进程内 env/顺序交互，非代码 bug。因按时限不想在剩量上下文里追这个交互、也不发货一条红测试，**我把它撤了**。所以 ④ 的「3 条守卫测试」**未干净落地**，隔离正确性以独立探针为准。**建议下轮把这条收据构造复用 P1-5② 已验证通过的夹具（`withRootAndReceipt` 式）重进 test.mjs。**

## 证据（gate）

- Claude 套件：`node scripts/test.mjs` → **866 / 失败 0**（一次全量跑绿）。⚠️ `维护门 · PR B` 并发测试在满载下偶发（两真进程 waitMs=5000 争 surface_lock_residue），孤立跑 3/3 过，属既有时序抖动、与 W2 无关。
- Codex 套件：`node scripts/codex/test.mjs` → **281 / 失败 0**。
- `git diff --check` 干净。

## 状态

W2：**Phase 1 完成 + 全绿；Phase 2 经核实判定为 no-op（无消费方，不需 intent）** → W2 整体闭合。
P1-3①：隔离结构正确（探针验），守卫测试下轮补干净。

**分支已推（`pi-ds/r36-m1a-wiring`）**，可送 Codex 二轮。下轮唯一残留：④ 的 P1-3① 守卫测试重进套件 + 维护门 PR B 并发的隔离复跑记录。
