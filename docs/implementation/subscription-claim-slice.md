# Subscription 首次认领纵切：实现与迁移说明

状态：`shadow only`。本切片不接管生产路由，不安装全局技能，也不写入飞书。

## 1. 交付范围

本实现对应产品需求 FR-2、FR-3 和“订阅认领纵切”阶段，并落实架构契约 INV-1、INV-2、
INV-11、INV-12：

- 以 `references/subscription-v1.schema.json` 固化 Subscription v1；
- Claude/Codex adapter 将各自现有登记表只读投影为同一公共模型；
- 公共 selector 消费该模型，计算未绑定话题的首次认领候选；
- 现有 selector 与候选 selector 在同一事件上并行计算；
- 两者不一致时只在原有 Git 外 inbound receipt 中记录，不二次 claim、不二次投递；
- 当前旧 selector 仍是唯一执行依据，已绑定话题的日常路由完全不变。

明确不包含：Subscription 控制面写 API、已有绑定数据迁移写盘、topic/session 日常路由切流、
dispatcher 重构、多订阅开放和任何真实飞书写入。

## 2. 状态与标识边界

公共 Subscription 只保存 endpoint、domain、chat、Agent、允许发送者、事件类型、状态和时效约束。
项目路径只用于当场派生稳定 `domain_id`；Codex thread ID、Claude session ID 和项目路径不会进入公共
投影。runtime adapter 只向公共核心提供 opaque `local_target_id`。

现有登记表仍是唯一事实源：

- Claude：`~/.claude/feishu-bridge/registry.json` 或显式覆盖路径；
- Codex：`~/.codex/feishu-bridge/registry.json` 或显式 bridge home；
- shadow 结果：沿用对应任务的 Git 外 inbound receipt。

本切片不会创建 `subscriptions/`、`bindings/` 或其他新控制面目录。

## 3. 首次认领算法

候选 selector 按固定顺序筛选：endpoint → caller Agent → sender → event type → 真实 mention →
freshness → chat scope → pending binding → 引用短码/唯一候选 → 过期时间。任一步不能得到唯一结果即
fail-closed，模型不参与选路。

当前 Aily envelope 尚未把可验证的 chat locator 纳入 canonical event。为避免把未知当成已验证，候选
结果显式记录 `scope_unverified: ["chat_id"]`。这不影响 shadow 对照，但在该证据补齐前禁止切流。

`route_match` 只比较以下数据面结果：

- 一边接受、另一边拒绝；
- 两边都接受但选择了不同本地目标。

拒绝原因名称由 `reason_match` 比较。总字段 `match` 必须同时满足 `route_match` 和
`reason_match`，因此只看 `match` 不会掩盖“同为拒绝但诊断理由不同”的分歧。任何分歧都不会产生
第二次业务动作。

## 4. 迁移与回滚

当前迁移是纯读取：每次首次认领时从旧登记表即时构造内存投影，没有持久化转换步骤，因而不会改变
topic/session/thread 映射，也不会重放历史消息或 outbox。

后续切流前必须满足：

1. 从可信 canonical event 取得并校验 chat locator；
2. Claude/Codex 真实首次认领样本持续得到 shadow `match: true`；
3. 对所有 mismatch 完成归因并增加回归 fixture；
4. 以单 endpoint 或单项目灰度，保留旧读取路径。

本切片的回滚不涉及数据恢复：删除两条 inbound 的 shadow 调用和公共投影模块即可，旧 selector、旧登记
和既有绑定从未被替换。若 shadow 计算自身异常，也只能影响审计字段，不能获得 claim 或 dispatch 权。

## 5. 验证证据

自动化测试覆盖：

- 两个 runtime 对同一 schema 的只读投影；
- 同一 domain 多个本地 target 的订阅去重与精确短码选择；
- 项目路径、Codex thread、Claude session locator 不进入公共模型；
- shadow 对照无写入、无 claim、无投递；
- 一致结果和刻意构造的不一致结果；
- Codex 完整首次绑定回执携带 shadow 证据；
- Claude/Codex 原有回归与公共导出面契约。

证据层级仍为本地合成与集成测试，不等同于真实飞书链路验收。
