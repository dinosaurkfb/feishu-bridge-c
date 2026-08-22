# Mapping Policy Handler 迁移

状态：候选实现完成，尚未正式安装或进行真实飞书链路验收。

对应分支：`refactor/mapping-policy-handler`。

## 1. 交付范围

本切片落实架构契约第 7.4、9.1、10、16 节，并完成分支交付表中的“现有映射模式迁移”：

- Claude 与 Codex 共用 `Mapping Policy v1`；
- dispatcher 路径用同一次获取的 Canonical Event 计算候选准入，不重新访问 Aily；
- Canonical Event 候选与现有 selector 同轮 shadow comparison，真实样本验收前旧结果仍唯一承重；
- 原子 claim 后，公共 handler 明确返回 `accepted / rejected / duplicate / busy`；
- `accepted` 只生成不含 Claude session、Codex thread 或项目路径的 `runRequest`；
- Claude/Codex adapter 使用 `runRequest` 启动原有精确目标，继续拥有 locator、探活、锁和终局观察；
- claim 与 receipt 增加 `policy_id`、`policy_version`、处置和 opaque target/generation 审计字段；
- 当前话题映射、绑定方式、受理文案、卡片 UI、outbox 和自动发布资格保持不变。

明确不包含：Dialogue/Management 模式、`$feishu-mode`、Topic Generation 持久化、多人授权、
cc2cd 迁移、全局 hooks/skills 安装、真实飞书写入或历史消息重放。

## 2. 运行边界

```text
共享 dispatcher
  -> Canonical Event v1 + 同源 legacy view
  -> Claude/Codex endpoint handler
       -> evaluateMappingAdmission()       公共、纯计算、旧/新影子比对
       -> resolve legacy mapping context   只产生 opaque ids
       -> acquireClaim()                   公共、原子 IO
       -> handleMappingPolicy()            公共、纯计算
            -> disposition
            -> runRequest（仅 accepted）
       -> runtime adapter
            ├─ Claude live / --resume
            └─ codex exec resume <exact thread>
```

公共 handler 不知道项目路径、Claude session id 或 Codex thread id。它只看：

- 规范化事件与现有 mapping 准入结果；
- claim 是否成功；
- runtime adapter 给出的 `ready / busy`；
- `localTargetId` 与受理时冻结的 `originChannelGenerationId`。

runtime adapter 仍是完整 locator 的唯一所有者。它把 `localTargetId` 对应回自己的私有登记，处理
会话探活、锁、投递、完成观察和失败 outbox；这些能力没有被搬进 policy。

## 3. Handler 与 runRequest 契约

公共输出与架构契约等价：

```js
{
  policy_id: "mapping",
  policy_version: "1.0",
  receiptText,
  claimId,
  disposition: "accepted" | "rejected" | "duplicate" | "busy",
  runRequest?: {
    runId,
    localTargetId,
    userInput,
    origin: {
      kind: "feishu",
      eventId,
      channelGenerationId
    },
    policy: {
      policy_id: "mapping",
      policy_version: "1.0"
    }
  }
}
```

`runRequest` 不包含 runtime locator。Claude/Codex adapter 分别把自己的 session/thread locator
作为私有参数交给运行器；公共 policy 只提供同一组运行时中立字段。

`origin.channelGenerationId` 在 claim 后、投递前冻结。当前尚无正式 Topic Generation 存储，
因此它由 runtime、旧 binding key 和 Aily session 生成稳定 opaque id，并标记为
`legacy_mapping_v1` 投影。后续生命周期切片可以替换投影来源，不改变 handler 或 adapter 接口。

## 4. Canonical Event 与兼容入口

在正式 dispatcher 路径中，`evaluateMappingAdmission()` 使用 Canonical Event 的 event、actor、source、
mention 与 content 字段计算候选结果。候选的真实 mention 证据来自 dispatcher 构造的
`mention.target_open_ids`，不再从正文重新判断 mention 是否真实。同一轮仍计算现有 selector，
只把 decision/reason/request 是否一致写入 Git 外审计；不写消息正文，也不发起第二次投递。

依据 INV-12，当前旧 selector 仍是唯一权威结果。候选不一致时只留证据，不改变 claim、目标运行或
出站目标；完成正式安装后的真实样本验收后，后续灰度切片才能切换权威读取路径。

直接运行旧 handler 的诊断路径没有 Canonical Event 时，仍可使用现有 Aily 事件视图；该结果会明确
标记 `evaluation_path: legacy_event_v2`。如果候选 Canonical Event 因版本偏斜或结构损坏而无效，
旧 selector 仍独立计算并继续承重；候选只记为 `canonical_invalid` 的 shadow 分歧，无权否决原本
合法的消息。

dispatcher 的 `30s` handler timeout 只是异常进程的最终兜底，不是响应预算。handler 正常路径仍
必须在完成校验、claim 和非阻塞投递后秒级返回；长期运行的完成由 hooks/watcher 独立观察。

## 5. 数据与用户行为兼容

本切片不迁移或重写 registry、mapping、claim、outbox、话题或历史消息。现有 binding 只被按只读
方式投影为公共上下文。用户仍然：

- 在原话题真实 mention；
- 收到原有受理/拒绝文案；
- 续接原来的精确 Claude 会话或 Codex task；
- 从原 outbox 和 Card 2.0 路径收到最终答复。

新增的 audit 字段只进入 Git 外 claim/receipt，不进入用户回复，也不记录消息正文或完整 locator。
运行失败仍由 adapter 记录为失败；policy 的 `accepted` 只代表该模式已经生成可执行请求，不冒充
runtime 完成。

## 6. 回滚

回滚时：

1. 两个 handler 恢复直接调用 `evaluateInbound()`；
2. 投递参数恢复读取旧 verdict；
3. 移除 `scripts/mapping-policy.mjs` 与新增测试；
4. 接受共享导出面快照的对应回退。

因为没有改写控制面数据或话题，回滚不需要数据恢复、重新绑定或重建话题，也不得自动重放历史
outbox。已写入 claim/receipt 的新审计字段可被旧版安全忽略。

## 7. 验证证据

本地自动化覆盖：

- Canonical Event 候选与旧 selector 同轮比较，一致样本被明确记录；
- 候选不一致只留审计证据，旧 selector 继续承重且不会投递第二次；
- 损坏的 Canonical Event 只记录 `canonical_invalid`，不改变旧 selector 的权威结果；
- accepted 产生统一 `runRequest`；
- rejected、duplicate、busy 不产生 `runRequest`；
- Claude/Codex 的 `runRequest` 均不携带 Aily session、logical task key 或 Codex thread locator；
- 两端现有 selector、claim、绑定、投递、outbox 与卡片回归保持通过；
- 公共导出面快照明确纳入 `mapping-policy.mjs`。

当前证据层级：本地合成/集成测试，Claude `313` 项、Codex `69` 项、公共 contract 通过。
这不能替代正式安装后的真实 mention、秒级受理、精确目标运行、严格终局和原话题回写验收。
