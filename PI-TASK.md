# 返修单 #R37：R36 交付物 2 —— 真实写入口接线（带精确锚点）（此文件不提交）

同分支 `pi-ds/r36-m1a-wiring` 补提交（c3c2a2d 之上）。你上单如实拖延是对的——锚点该我给。
现按行给**精确提交点**，逐个接（红线文件只在提交点外包 outer+shadow 后缀，不动判定逻辑）：

## 接入锚点（file:function）

| writer 行 | 锚点 | shadow 序列 |
| --- | --- | --- |
| claim→绑定 | `inbound-route.mjs:452 promoteBinding`（绑定落盘成功后） | wireBindClaim：create_a1（若该会话 A1 未在）→ activate |
| rotate 建新代际 | `topic-generation.mjs:546 prepareTopicRotation` / `:568 registerPendingTopicGeneration`（经 interaction-policy-store 落盘成功后） | wireRotate：create_b1 |
| rotate cancel / pending 过期 | topic-generation 内 cancel/expire 写路径（沿 rotation.status 写 cancelled/expired 的落盘点） | wireVoid：void |
| binding_status 翻转（pause/resume） | `topic-generation.mjs:184` 一带 normalizedBindingStatus 的**写方调用点**（经 store mutate 落盘处） | wirePauseResume：unbind 或 restore（按方向单笔） |
| enabled 翻转 | `bind-project.mjs:182-184 reenabled` 及对应停用路径 | wireEnabledFlip：restore / unbind |
| A1 物化 | `chat-ledger.mjs:412 admitChat` 成功准入后（两链） | wireCreateA1：create_a1（session locator=Aily 会话） |
| retarget | **legacy 无此写方（v2-only）**——本行标注 N/A，不接（M1b 后原生 v2） |

## 要求

- 每个锚点：legacy 提交成功后、同一 outer 锁段内跑 shadow 后缀；shadow 失败不改变 legacy
  成功语义（回执/返回值不变），mismatch 留 doctor。
- shadow 需要 endpoint/chain：从既有绑定上下文取（chain=当前链，endpoint=legacyEndpointId）。
- **每行真入口行为测试**（假 home：legacy 落盘 + shadow 记录出现且族正确 + 双跑幂等）；
  outer busy → binding_busy；崩溃续跑注入一条；反向证明升级为真实入口层。
- PI-REPORT.md 这次要写到 worktree（上单漏了文件只留了 pane 输出）。

## 验收：红→绿；全量两套绿 + diff 干净。
