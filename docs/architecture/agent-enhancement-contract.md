# 第三方智能体增强：架构契约

状态：提案（Proposed）  
契约版本：`0.1`  
配套需求：[第三方智能体增强：产品需求文档](../requirements/agent-enhancement-requirements.md)

## 1. 契约目的

本文件固定 `feishu-bridge` 下一阶段重构中不能被实现细节破坏的系统边界。它不是当前文件布局的
说明书，而是 Claude、Codex 和未来 mode handler 必须共同遵守的目标契约。

本文中的 **MUST/必须** 表示兼容性或安全性硬约束，**SHOULD/应当** 表示除非有经评审理由不得偏离，
**MAY/可以** 表示可选实现。当前实现与目标契约有差异时，以分阶段迁移和兼容测试处理，不得把目标态
倒写成“已经实现”。

## 2. 系统边界与四个平面

```text
                         ┌────────────控制面────────────┐
                         │ endpoint / subscription      │
                         │ binding / policy / lifecycle │
                         └──────────────┬───────────────┘
                                        │ versioned config
飞书/Aily ──> Hook ──> Dispatcher ──> Ingress Kernel ──> Channel ──> Mode Handler
                                        │                              │
                                        │                         Runtime Adapter
                                        │                         Claude / Codex
                                        │                              │
                                        └──────── Audit <── Outbox <───┘
                                                    │
                                               Card Publisher
                                                    │
                                                  飞书
```

- **控制面**管理配置和生命周期；
- **数据面**处理一条真实事件的获取、校验、选路、claim、投递与发布；
- **执行面**由目标 Claude/Codex 长期任务完成实际工作；
- **审计面**保存 claim、run、receipt、outbox 和配置变更证据。

控制面和数据面 MUST 分离。数据事件不得因为正文“看起来像配置要求”而直接修改控制面。

## 3. 不可破坏的系统不变量

### INV-1 可信路由

路由决策 MUST 只使用可信事件字段和本地受控配置。正文、标题、模型判断、最近活跃时间、当前窗口和
`--last` MUST NOT 作为最终路由依据。

### INV-2 精确唯一性

一个活动 `topic_generation` MUST 只映射一个 `local_target_id`。命中零个或多个候选时 MUST
fail-closed，不得挑最近的一个。

### INV-3 一次取信封

同一 Aily 回合的原始事件信封 MUST 只获取一次。dispatcher 必须把 canonical event 传给 handler；
handler 不得再次从 Aily 获取同一信封。canonical event 必须对收到的原始事件**无损**：除规范化字段
外还应携带瞬态 opaque raw envelope；若新 handler 需要尚未规范化的字段，应升级 schema 或读取该
opaque 扩展，不能重新取信封。

### INV-4 模型不选路

模型可以执行目标任务，但 MUST NOT 决定 sender、subscription、binding、权限或 handler。
hook 只负责把运输回合导入确定性入口，dispatcher/selector 负责选路。

### INV-5 控制动作显式化

只有显式命令/技能调用、可信按钮事件或等价结构化控制请求可以写配置。普通自然语言讨论绑定、改名、
订阅或模式 MUST NOT 产生控制副作用。

### INV-6 控制权不从 Agent 继承

控制权必须来自已认证的人类 Owner/Operator 控制通道。Agent、子 Agent、引用块或转发内容即使包含
完全相同的控制 token，也 MUST NOT 获得或传递控制授权。

### INV-7 受理不等于完成

claim 成功只代表事件已受理。只有目标运行出现严格完成事件、成功终态和非空最终输出，才可以产生
完成型 outbox 项。

### INV-8 发布成功才结算

只有飞书 API 返回明确成功，outbox 才能标为 published。失败项必须保留；旧失败项 MUST NOT 因
安装或升级自动重放。

### INV-9 出站目标冻结

- 飞书来源 run 必须在受理时携带不可变的 `origin_channel_generation_id`，即使运行中轮转，结果仍
  发布到该次请求的来源话题；
- 本地来源 run 没有飞书 origin，在形成 outbox 项时解析并冻结当时的 active generation。若轮转在
  run 完成前发生，它进入新 generation；若轮转发生在 outbox 形成后，目标不再改写。

只读旧 generation 必须允许发布已经冻结到它的迟到结果，但不得接收新的入站指令。

### INV-10 运行时隔离

Claude/Codex 特有的会话发现、续接、终局监听和 UI 刷新语义 MUST 留在 runtime adapter；公共核心
不得依赖任一运行时的 locator 格式。

### INV-11 敏感状态不进 Git

身份、完整 locator、subscription 实例、binding 实例、claim、receipt、run、outbox 和凭据 MUST
保存在 Git 之外。仓库只保存 schema、示例和代码。

### INV-12 数据面变更先做影子比对

任何会改变选路、授权、claim、目标运行或出站目标的数据面变更，MUST 先在无副作用路径同时计算
旧结果与候选结果；不一致时只记录差异，不得投递第二次。影子比对通过且经过真实样本验收后，才可
按 endpoint/项目灰度切流。

## 4. 规范化实体与标识

| 实体 | 稳定标识 | 关键字段 | 所有者 |
|---|---|---|---|
| Endpoint | `endpoint_id` | runtime、agent_uid、adapter、status、version | 机器控制面 |
| Project Domain | `domain_id` | display_name、project_root 或业务域 locator | 控制面 |
| Subscription | `subscription_id` | endpoint、domain、tenant/chat、agent、senders、events、status | 控制面 |
| Local Target | `local_target_id` | runtime、target_kind、opaque locator、domain、display title | runtime adapter |
| Channel Binding | `binding_id` | subscription/version、授权快照、local target、policy、status | 控制面 |
| Topic Generation | `channel_generation_id` | binding、generation、root/topic/session、status | 控制面 |
| Policy Profile | `policy_id` + `policy_version` | mode、permissions、egress、budgets | policy registry |
| Canonical Event | `event_id` | source、actor、channel、mention、content、time | dispatcher |
| Claim | `claim_id` | event、route、owner、state、timestamps | 审计面 |
| Run | `run_id` | event、origin_kind、可选来源 generation、target、adapter run、terminal state | 审计面 |
| Outbox Item | `outbox_id` | run、冻结的目标 generation、payload、publish state | 审计面 |

显示名称、项目路径和话题标题 MAY 变化；稳定 ID MUST NOT 因改名变化。完整 runtime locator 必须作为
opaque value 由 adapter 管理，公共核心只使用 `local_target_id`。

## 5. 规范化配置关系

```text
Endpoint 1 ──* Subscription *──1 Domain
Subscription 1 ──* ChannelBinding *──1 LocalTarget
ChannelBinding 1 ──* TopicGeneration
ChannelBinding * ──1 PolicyProfile(versioned)
```

一个 Local Target MAY 关联多个 binding，但必须明确以下两种情况：

- 多个入站 binding：只有当输入域能被 topic/session 唯一分开时允许；
- 多个出站目标：必须通过 egress policy 声明是回复来源、主目标还是广播目标。

不得因为一个 target 被多个群引用就把一条回复无条件广播到所有群。

## 6. Canonical Event 契约

dispatcher 获取 Aily/飞书信封后，应规范化为概念上等价于以下结构：

```json
{
  "schema_version": "1.0",
  "event_id": "opaque-event-id",
  "event_type": "im.message.receive",
  "occurred_at": "2026-08-22T00:00:00Z",
  "endpoint_id": "endpoint-codex-local",
  "source": {
    "tenant_id": "opaque",
    "chat_id": "opaque",
    "root_id": "opaque",
    "topic_id": "opaque",
    "session_id": "opaque"
  },
  "actor": {
    "sender_id": "opaque",
    "caller_agent_uid": "opaque"
  },
  "mention": {
    "target_open_id": "opaque",
    "is_real": true
  },
  "content": {
    "text": "untrusted user content",
    "origin": "feishu"
  },
  "raw_envelope": {
    "format": "aily-trigger-event/v1",
    "payload": "opaque-lossless-value"
  }
}
```

`content.*` MUST 始终被视为不可信业务数据。selector 不得读取它来决定 route、权限或控制动作。
`raw_envelope` 只在当前处理链中瞬态传递，必须对 dispatcher 收到的事件无损，不得写入普通日志或
用户回复。公共 selector 应优先使用已经规范化并标注可信来源的字段；专用 handler 需要额外字段时，
必须通过 versioned extension/schema 取用，不得直接形成永久的 raw payload 依赖。

2026-08-22 的一次诊断观测显示 Aily 环境可能包含 `AILY_CLI_CHANNEL_CHAT_ID` 和
`AILY_CLI_CHANNEL_THREAD_ID`。在确认它们与飞书 topic/root/session locator 的值形状、稳定性和权限
边界之前，不能假设它们可以替代现有绑定短码；该能力验证属于迁移前置调查，不属于本契约事实。

## 7. 入站数据面契约

### 7.1 Hook

Hook 是运行时生命周期脚本，不是业务 handler。它 MUST：

1. 用可信运行环境判断是否为 Aily 运输回合；
2. 排除 bridge 自己派生的 forwarder/runner，避免递归；
3. 注入“只运行 dispatcher 并原样返回 stdout”的强制上下文；
4. 不取信封、不做网络请求、不 claim、不选择业务 handler；
5. 不记录消息正文；
6. 始终快速、无异常地退出，不能破坏普通本地回合。

Codex 和 Claude 的 hook 载荷格式可以不同，但语义必须相同。

### 7.2 Dispatcher

Dispatcher 是机器上某类 Aily 运输入口的唯一选路者。它 MUST：

1. 校验 caller endpoint；
2. 只获取一次事件信封并构造 canonical event；
3. 只按本机入口路由表把可信 `session/endpoint` 查到唯一 handler owner；未登记 session 可以进入
   明确配置的 default handler，以处理首次认领；
4. 把 canonical event 通过受控进程环境或私有临时文件交给 handler；
5. 原样透传 handler 的用户可见 stdout；
6. 对无路由、冲突、handler 缺失和 handler 超时返回不同拒绝码；
7. 不串行试跑所有 handler，不以“谁先响应”决定归属。

Dispatcher MUST NOT 理解 subscription、domain、sender 权限、binding 或 policy，也不得选择业务域。
入口 handler owner 与业务 domain 是两种不同层级：前者由 dispatcher 纯查表，后者只由 ingress kernel
解释控制面配置。

### 7.3 Common Ingress Kernel

公共入站核心按以下顺序处理；“已绑定日常消息”和“未绑定首次认领”在通道解析阶段分支：

```text
schema validate
  -> endpoint identity
  -> sender / real mention / source scope
  -> freshness
  -> resolve channel
       ├─ existing topic/session -> exact binding + materialized authorization snapshot
       └─ unbound/pending topic  -> unique subscription match -> pending binding claim
  -> atomic claim
  -> policy handler
```

subscription 只在首次认领和控制面变更时承重；绑定完成后的日常热路径不得为每条消息重复匹配它。
subscription 被暂停或修改时，控制面必须显式更新依赖 binding 的 materialized authorization snapshot
或暂停相关 binding。任一步失败都不得进入下一步。claim 键 SHOULD 至少包含
`event_id + route_id`；同一事件在重试时必须得到幂等结果，不得重复启动目标运行。

### 7.4 Handler 接口

模式无关的 domain handler 应提供等价接口：

```text
handle(event, resolvedContext) -> {
  receiptText,
  claimId,
  disposition: accepted | rejected | duplicate | busy,
  runRequest?
}
```

handler MUST NOT 重新获取 Aily 信封。若需要运行时执行，应生成 `runRequest` 交给 runtime adapter，
而不是直接了解 Claude/Codex locator 细节。

## 8. 通道解析与生命周期

### 8.1 解析

selector 应使用 `topic/session -> channel_generation_id -> binding_id -> local_target_id` 的稳定链路。
首次绑定阶段允许使用一次性短码，但成功认领后必须写入稳定映射，并使短码退出日常路由。

### 8.2 生命周期状态机

```text
pending --activate--> active --pause--> paused --resume--> active
                           |
                     prepare rotation
                           v
            active(old) + pending(new)
                    | claim / timeout
                    v
       active(new) + read-only(old)  /  active(old)

任一 generation：pending -> active -> read-only -> retired
```

- `paused`：拒绝新入站，保留映射和历史；
- `rotating` 是 binding 的短期操作状态，不是等待人类期间唯一可用的通道状态；新代际认领完成前，
  旧代际继续 active；
- `pending` 新代际默认带 24 小时 `claim_expires_at`；超时或显式取消后 fail-closed 地放弃新代际，
  旧代际保持 active；
- `read-only`：不接收新入站，但允许发布在切换前已经冻结到该代际的迟到结果；
- `retired`：不再恢复，但保留审计索引；
- 删除飞书话题不是正常解绑操作。

### 8.3 轮转事务

轮转 MUST 采用两阶段事务，不能在等待人类 mention 的数小时内一直持有文件锁：

1. 短暂获取 binding 生命周期锁，确认没有其他 pending generation，写入唯一 rotation operation id，
   然后释放锁；
2. 创建新根话题；失败时把 operation 标记 failed，旧 generation 不变；
3. 再次加锁，在同一 binding 文档中登记新 generation 为 `pending`，写入 topic locator、绑定短码和
   `claim_expires_at`（默认 24 小时），然后释放锁；
4. 旧 generation 继续 active，系统等待新话题的真实 mention/session 认领；等待过程不持锁；
5. 认领到达后再次加锁，校验 operation id、期限和 session 唯一性；
6. 在**同一份 binding 文档的一次原子替换**中，把 `active_generation_id` 指向新 generation，
   同时把新 generation 设为 active、旧 generation 设为 read-only；
7. 释放锁并记录审计事件。若到期或用户取消，则用一次原子替换把 pending generation 标为
   retired/cancelled，旧 generation 继续 active。

文件系统实现必须先在同目录写完整临时文件，再以原子 `rename` 替换 binding 文档；所有决定当前
active generation 的字段必须位于这同一份文档。等价的事务型存储可以替代，但分两次独立写新旧
状态不符合契约。任何失败都不能产生“两个都收”或“两个都不收”的中间态。

## 9. Policy Handler 契约

所有模式都实现统一生命周期：

```text
evaluate -> plan -> dispatch -> observe -> finalize
```

策略输出必须带 `policy_id` 和 `policy_version`，确保历史 run 可解释。

### 9.1 Mapping Handler

- 一次输入对应一次目标 run；
- Feishu origin 输入不在结果卡片重复；
- Local origin 输入按 turn key 与最终答复配对；
- 只发布用户可见内容；
- Feishu origin 默认回复到受理时冻结的 `origin_channel_generation_id`；
- Local origin 在形成 outbox 时解析当前 active generation 并立即冻结，不能把“没有飞书来源”的
  本地 run 伪装成有 origin 的请求。

### 9.2 Dialogue Handler

- 必须有主持者、参与者、预算、停止条件和人工中断；
- 每一轮必须有稳定 `dialogue_id/turn_index`，对重复 mention 幂等；
- Agent 之间的输出只在策略明确允许时成为下一轮输入；
- 达到任一预算或停止条件后必须终止，不得靠模型自觉结束。

### 9.3 Management Handler

- 必须声明 profile：`project_advancement`、`expert` 或 `training`；
- 必须声明 permission：`observe`、`advise`、`execute` 或 `modify`；
- 权限检查发生在生成执行动作之前和实际执行之前；
- `modify` 的授权不得从普通项目执行权限继承；
- Shadow/监督事件与普通用户指令必须使用不同事件类型和 handler。

## 10. Runtime Adapter 契约

公共执行请求：

```text
startRun({ runId, localTargetId, userInput, origin, policy })
observeRun({ runId })
cancelRun({ runId, reason })
resolveDisplayMetadata({ localTargetId })
```

### Claude adapter

Claude adapter 必须区分两类 `local_target_id`：

- **会话级 target**：绑定一条精确 Claude 会话。存在活着的该会话时投递进去；没有活动现场时，
  精确 `--resume` 已登记会话或明确拒绝，绝不改投同项目的其他会话；
- **项目级 target**：绑定的是项目，不是某条会话。“选择项目内最近启动且仍存活的交互会话”是这类
  target 的明确定义语义，不是精确会话失败后的 fallback；没有现场时按项目级 `--continue` 规则运行。

两类 target 必须在类型和状态中显式区分；实现不得把会话级绑定偷偷降级成项目级行为。

### Codex adapter

- 必须使用精确 thread locator 执行 resume；
- 不得使用 `--last`；
- 必须通过运行事件、exit code 和非空 final output 联合确认终局；
- Desktop 页面未即时刷新属于呈现边界，不得因此把运行改投另一 thread。

两个 adapter MUST 把 locator 封装在各自状态层，公共核心只持有 opaque `local_target_id`。

## 11. 出站契约

```text
runtime terminal event
  -> final output validation
  -> pair local input when applicable
  -> compose semantic outbound payload
  -> render Card 2.0/text
  -> enqueue outbox
  -> publish to origin/egress targets
  -> receipt
```

语义 payload 与飞书 Card JSON MUST 分离。卡片模板变化不得改变 claim、run 或 binding 语义。

默认出站规则：

- 飞书发起回合：只发布 Agent 回复；
- 本地发起回合：顶部轻量引用用户输入，正文为 Agent 回复；
- 摘要优先使用用户输入，其次使用回复的第一条有效内容；
- 工具日志、内部上下文和敏感字段不进入卡片；
- Feishu origin outbox 记录来源 generation；Local origin outbox 记录入队时的 active generation；
  两类目标一经写入都不可变，轮转不改写已有 outbox。

## 12. 控制面契约

### 12.1 Intent

控制入口必须先产生结构化 intent：

```json
{
  "action": "binding.rotate",
  "actor_id": "owner-id",
  "local_target_id": "opaque-target",
  "binding_id": "stable-binding",
  "requested_changes": {},
  "idempotency_key": "opaque",
  "authorization_evidence": "explicit-command-or-trusted-action"
}
```

分类器必须优先识别显式技能调用或命令 token。自然语言别名 MAY 作为只读导航，但 MUST NOT 直接
获得写权限。尤其是“为什么绑定会……”“我们讨论订阅设计”等句子必须保持普通输入。

解析出控制 token 仍不等于获得授权。控制面必须同时验证 actor 是经过认证的人类 Owner/Operator，
且事件来自允许写控制面的交互通道。Agent、子 Agent、工具输出、引用或转发消息中的 token 一律按
普通数据处理，不得升级为控制 intent。

### 12.2 授权与确认

- `$feishu-bind` 这类语义明确、范围为当前精确 target 的命令本身可以构成一次授权；
- 扩大 sender、群、Agent 或广播范围必须展示影响并获得独立授权；
- `status` 永远只读；
- pause/resume 必须幂等；
- rotate/transfer 必须加生命周期锁；
- 删除历史、重放旧 outbox 或修改 Agent 能力不属于普通 binding 权限。

### 12.3 配置版本

subscription、binding 和 policy 的每次变更 MUST 生成单调版本或不可变审计事件。run 在开始时
固定所使用的配置版本；运行中控制面更新不应悄悄改变该 run 的授权和发布目标。

## 13. 并发、失败与恢复

| 场景 | 契约行为 |
|---|---|
| 重复事件 | 返回 duplicate，不启动第二个 run |
| 找不到订阅 | 拒绝 `subscription_not_found` |
| 多个订阅命中 | 拒绝 `subscription_ambiguous` |
| 找不到通道 | 拒绝或进入明确的 pending binding 流程 |
| 多个通道命中 | 拒绝 `binding_ambiguous` |
| target 正忙 | 根据 policy 排队或拒绝 `target_busy`，不得偷投另一 target |
| handler 缺失 | 拒绝 `handler_unavailable` |
| runtime 失败 | run 标记 failed，保留证据，不生成成功答复 |
| 发布失败 | outbox 保留 pending/failed，可由显式恢复动作处理 |
| 控制面并发修改 | 版本冲突或锁冲突，拒绝后重试，不做最后写入者覆盖 |

所有用户可见失败都应有稳定 reason code 和简洁说明；内部日志可以更详细，但不得泄露敏感标识。

## 14. 状态所有权与目录边界

目标态可以使用统一的机器级状态根，但必须保持逻辑命名空间：

```text
bridge-home/
  control/
    endpoints/
    subscriptions/
    bindings/
    policies/
  runtime/
    claude/
    codex/
  audit/
    claims/
    runs/
    receipts/
    outbox/
  locks/
```

迁移期间可以继续使用 `~/.claude/feishu-bridge` 与 `~/.codex/feishu-bridge`，但公共 schema 和算法
必须版本化。两份安装不得同时注册为同一 endpoint/session 的默认 owner；dispatcher 路由表必须
能检测 owner 冲突并拒绝静默覆盖。

## 15. 测试契约

### 必须覆盖的公共契约测试

- canonical event 对原始事件无损、一次取信封且不把 raw envelope 写入普通日志；
- 不可信正文与控制面隔离，Agent 消息中的控制 token 不获得授权；
- subscription 和 binding 的唯一选择；
- claim 幂等与并发竞争；
- topic 改名不影响路由；
- topic 轮转的 24 小时超时、单文档原子切换、来源回复和本地回合目标冻结；
- 本地输入/回复配对及飞书输入不重复；
- control intent 不被普通讨论误触发；
- policy permission fail-closed；
- outbox 失败不误标成功、不自动重放。
- 每个数据面候选在切流前都能与旧结果做无副作用 shadow comparison。

### Runtime adapter 合同测试

同一组 adapter fixture 必须分别验证 Claude 与 Codex 的：精确 target、busy、完成、失败、取消、非空
最终输出和 locator 不泄露。公共导出面继续由 `npm run contract` 护栏监测。

### 真实链路验收

本地单元测试不替代真实端到端验收。每个阶段至少验证：真实 mention、秒级受理、精确目标运行、
严格终局、原话题发布、失败 outbox，以及同项目多会话不串线。

## 16. 迁移与兼容策略

1. versioned schema 必须与第一个真实消费者同一 PR 交付；可以先提供只读转换器，但不得合入长期
   没有消费者、无法验证语义的稳定字段；
2. 每个数据面变更都按 INV-12 做 shadow comparison：同时计算旧结果与新结果，不一致时只记录、
   不投第二次；这不是本次迁移专用步骤，而是后续数据面变更的标准门禁；
3. 映射模式先接入新 policy 接口，保持现有用户行为和卡片 UI；
4. 单个 endpoint/项目灰度切换，保留可回滚的旧读取路径；
5. 稳定后再开放多订阅、轮转和新 mode；
6. 最后清理旧字段和自然语言写操作入口。

任何迁移不得自动重放历史 outbox、重建话题或改变已绑定 topic/session/thread。

## 17. 分支与交付契约

本重构不得在一个长期巨型分支中完成。建议：

| 分支/PR | 内容 | 明确不包含 |
|---|---|---|
| `docs/agent-enhancement-architecture` | 需求、契约、README 导航 | 运行时代码和安装变更 |
| `fix/explicit-control-intents` | 结构化 intent、actor 授权与自然语言误触发修复 | 新状态模型和数据面切流 |
| `feat/subscription-claim-slice` | subscription schema、只读迁移、首次认领消费者与 shadow comparison | 已绑定日常路由切流 |
| `feat/codex-inbound-dispatcher-contract` | Codex 接入 Claude 已有 dispatcher 契约，两端迁移到无损 canonical event | 重建 Claude dispatcher、新交互模式 |
| `refactor/mapping-policy-handler` | 现有映射模式迁移 | 对话/管理功能 |
| `feat/topic-generation-lifecycle` | 轮转与生命周期 | 多人授权 |
| `feat/dialogue-policy` | 对话编排 | 管理模式 |
| `feat/management-policies` | 推进、专家、带教 | 多人授权 |
| `feat/multi-operator-authorization` | 人员授权矩阵与审计 | 其他模式重写 |

每个实现 PR 必须引用本契约的相关 invariant、列出迁移和回滚方式、同时通过 Claude/Codex 测试。
若实现确实需要修改本契约，应先用单独文档变更说明原因，再改代码。
