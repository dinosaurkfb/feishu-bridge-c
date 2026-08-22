# Dialogue Participant & Planner：下一纵切契约

状态：Slice A 候选实现已位于 `feat/dialogue-participant-foundation`：公共纯函数、两份 versioned
schema、离线 simulator 与 Claude/Codex 回归已完成；没有接入 adapter 热路径、安装技能、发送飞书
消息或打开 Agent 输出自动接力。

## 1. 为什么不能直接打开 Agent 自动接力

Dialogue v1 只有一名已授权人类和当前 binding 的主持 target。当前 Subscription 仍是旧 registry
的只读 shadow 投影，而且 canonical event 的 chat locator 还可能处于 `scope_unverified`。因此把
`allow_agent_output_as_input` 直接改为 `true` 会同时缺少三项安全前提：

1. 不知道哪些 Agent 被 Owner 明确授权参与本次 Dialogue；
2. 不能把下一步唯一解析到另一条 subscription/binding/local target；
3. 没有确定性 planner 约束轮次、预算、失败和停止，正文 mention 可能形成循环。

下一版本必须先把“谁能参加”“下一步轮到谁”“投给哪个稳定目标”变成公共、可审计、模型不可改写
的控制面事实。

## 2. 交付拆分与门禁

### Slice A：Participant & Planner Foundation

可以立即开发：

- versioned 参与者授权快照；
- 不读取正文的纯函数串行 planner；
- 稳定 cycle/step/run key、逐参与者预算和失败语义；
- Claude/Codex 共用 schema、fixture 和离线 shadow simulator；
- 不修改 adapter 热路径，不写 `interaction_policy_state`，不 dispatch 第二个 Agent。

该切片使用独立的 foundation schema，不提升既有 `interaction_policy_state.schema_version=1.0`，也不向
现有 v1 state 附加 planner 状态。生产行为因此与 Dialogue v1 完全相同，
`agent_output_relay=disabled`。实时 shadow 接入属于 Slice B 的切流前准备。

### Slice B：Multi-subscription Route

只有同时满足以下门禁后才允许按单 endpoint/domain 灰度切流：

1. 自动 Topic Generation v1 已完成真实自动触发、失败重试和不重复轮转验收；
2. canonical event 已从可信来源取得并验证 chat locator，不再依赖 `scope_unverified`；
3. subscription 变更能原子更新或暂停依赖 binding 的 materialized authorization snapshot；
4. 同一事件的 legacy route 与 candidate route 在真实样本中持续一致，歧义时 fail-closed；
5. 回滚可恢复到现有精确 binding 热路径，且不会重放 run/outbox。

### Slice C：Agent Relay v1

只有 Slice A、B 均验收后才允许开启。首个生产拓扑固定为：

```text
authorized human -> host -> one peer -> host finalizer
```

它仍是串行的；不支持并行发言、多名人类授权人、动态加人或无上限循环。

## 3. 参与者授权快照

Dialogue 启动时必须冻结一个不可变 `participant_authorization_snapshot`。它只保存公共稳定 ID 和版本，
不得保存 Claude session、Codex thread、项目路径或其他 runtime locator。

概念结构：

```json
{
  "schema_version": "1.0",
  "snapshot_id": "opaque",
  "authorization_revision": 1,
  "captured_at": "ISO-8601",
  "coordinator_binding_ref": "opaque",
  "participants": [
    {
      "participant_id": "opaque",
      "kind": "human | agent",
      "roles": ["requester | host | peer | finalizer"],
      "subscription_id": "opaque-or-null",
      "binding_ref": "opaque-or-null",
      "local_target_id": "opaque-or-null",
      "allowed_origins": ["human_event | planner_relay"],
      "limits": { "max_agent_runs": 1, "resource_units_per_run": 1 }
    }
  ]
}
```

约束：

- 人类参与者必须来自既有 binding 的 sender 授权快照，不能从正文或模型输出新增；
- Agent 参与者必须同时命中 active subscription、active binding 和唯一 opaque local target；
- 一名参与者可以承担多个角色，但首个 Relay v1 只能有一个 host、一个 peer、一个 finalizer；
- host 与 finalizer 可以是同一参与者；peer 必须与 host 不同；
- 对活动 Dialogue 的授权撤销不得静默改写快照，必须原子取消尚未 dispatch 的步骤并把 Dialogue
  标记 cancelled/authorization_revoked；
- `binding_ref` 必须由 adapter 使用稳定哈希从私有 legacy binding key 派生；现有可能包含项目名的
  `binding_id` 不得直接写入公共快照。`binding_ref -> private binding locator` 的反向解析只保存在
  Git 外 adapter 控制面；
- 派生算法固定为 SHA-256，输入依次包含版本化常量 `dialogue-binding-ref/v1`、runtime namespace、
  endpoint ID 和私有 binding key，并用 NUL 分隔；公共值使用 `binding_ref_` 加前 24 位十六进制摘要。
  Claude/Codex 不得各自改变字段顺序、前缀或截断长度；
- 配置更新只影响下一次 Dialogue，除非显式中断并重建；
- 快照及审计只能进入 Git 外控制面，Git 只保存 schema、算法和脱敏 fixture。

## 4. 确定性串行 planner

planner 是纯函数，不读取飞书、不调用模型、不解析 Agent 正文中的 mention。输入必须完全来自已校验的
Dialogue 状态、授权快照和严格终局事件：

```text
planNext(state, participantSnapshot, terminalEvent)
  -> dispatch_one(runRequest)
   | finalize(summaryRequest)
   | wait_human
   | stop(reason)
```

首个 Relay v1 的固定步骤：

1. 人类事件经 coordinator binding 唯一 claim，创建一个 `cycle_index`；
2. host 接收人类输入并产生严格终局；
3. peer 接收带来源戳的 host 最终输出；
4. host 作为 finalizer 接收 peer 最终输出并生成唯一用户可见答复；
5. planner 回到 `wait_human`，不会根据 finalizer 正文继续接力。

每一步冻结 `dialogue_id + cycle_index + step_index + participant_id + run_id`。相同 terminal event 重放
必须返回相同 disposition，不能重复 dispatch。任一时刻最多一个 active step；planner 每次最多生成
一个 runRequest。

claim 只属于原始人类事件。peer 与 finalizer 等内部 step 不创建 claim，也不伪造 message id；它们的
幂等和审计只使用冻结的 cycle/step/run key，并通过 `parent_human_claim_id` 关联原 claim。

Agent 输出只作为不可信 payload 被结构化包裹，不能携带控制 token、participant 变更、预算变更或下一
目标。正文中的 `@Agent`、`→Codex`、命令名和绑定码都不参与 planner 决策。

## 5. 预算与失败

- Dialogue v1 的 12 轮 / 12 资源默认值和 `policy_version=1.0` 保持不变；
- Relay v1 必须使用新的 `policy_version=2.0` 和独立预算字段，候选默认值为 4 个 human cycle、
  12 个 Agent run、2 小时和 12 资源单位；不得把 v1 的 `max_rounds` 静默重新解释；
- 每个 runtime run 单独增加 `agent_runs_started` 和 `resource_units_used`，每个固定 cycle 消耗
  3 个 Agent run 和至少 3 个资源单位；
- 开始 cycle 前必须确认剩余预算能覆盖完整固定计划，不能走到 peer 后才发现 finalizer 无预算；
- peer、host 或 finalizer 的 runtime 失败、观察超时或空终局使整个 Dialogue 硬失败；
- Owner 撤销 participant 授权属于受控取消，终态固定为
  `cancelled/authorization_revoked`；准入前发现快照无效则拒绝启动，运行中发现快照损坏才以
  `failed/dialogue_policy_invalid` 收口；
- 首个版本不跳过失败参与者、不自动换人、不重试；
- deadline 到达后不再 dispatch 新 step，迟到终局只用于关闭匹配 run，不得开启下一步；
- 人工切回 Mapping 取消 active step，保留已完成 step 的审计事实。

## 6. 路由所有权

- coordinator binding 是一次 Dialogue 的唯一状态所有者和唯一人类事件 claim owner；
- 其他参与者的 binding 只提供授权和 runtime target，不得再次认领原人类事件；
- internal relay 使用冻结的 `participant_id -> binding_ref -> local_target_id`，不通过飞书标题、正文 mention、
  最近活跃会话或模型选择目标；
- 每个 agent run 的发布目标默认是 coordinator 当前 cycle 冻结的来源 generation；中间步骤不得直接向
  用户发布，只有 host finalizer 产生该 cycle 的用户可见答复；
- 若未来允许中间进展发布，必须作为独立 egress policy，不得借 planner 副作用实现。

## 7. 控制面

现有 `$feishu-mode dialogue` 继续只创建 Dialogue v1，不得因安装新代码自动升级为多 Agent。
Participant 配置、启用 Relay 和中断 Relay 必须使用新的结构化控制 intent；命令名和参数在实现 PR
前单独确定。普通自然语言、Agent 回复、飞书卡片内容和引用命令均不得触发配置写入。

现有 v1 校验器对 `turn_order` 和 `allow_agent_output_as_input=false` 的硬检查继续充当升级闸门。
Slice C 必须显式引入 `policy_version=2.0`，新代码同时读取 v1/v2；只有显式 Relay 控制动作才能创建
v2。回滚到不认识 v2 的旧代码前，必须先用 v2-capable 控制面切回 Mapping，不能直接覆盖安装；
Slice C 的安装器/卸载器必须检测活动 v2 state，并在未完成该转换时机械拒绝降级。

任何真实 participant 配置、模式启用、飞书写入或安装仍需对应动作的明确授权。

## 8. 测试与验收

Slice A 必须覆盖：

- 快照 schema、唯一角色、授权撤销、locator 不泄露；
- 固定三步计划、单 active step、稳定 key、重复终局幂等；
- 完整 cycle 预算预检、deadline、失败和人工取消；
- Agent 正文 mention/命令不能改变计划；
- Claude/Codex 共用模块契约一致；
- 离线 simulator 不产生 dispatch、飞书写入、outbox 或 binding/state 写入。

Slice B 的实时 shadow 证据必须写入独立 Git 外 `dialogue-planner-shadow/` sidecar，不取得 binding
生命周期锁；sidecar 写入失败只能丢失 shadow 证据，不得改变真实回合结论。Slice B 还必须覆盖
subscription 歧义、chat scope、binding 授权快照同步、代际轮转与回滚。Slice C 才做
真实双 Agent 串行验收：精确目标、三个 Agent step、只有一个最终用户答复、预算正确、重复事件不重复
运行、失败时停止且不串线。

本地与 shadow 证据不能替代 Slice B/C 的真实链路验收。

## 9. Slice A 候选实现证据

- `scripts/dialogue-participant-planner.mjs` 实现 opaque binding/participant/output ref、不可变快照校验、
  固定 `host -> peer -> host finalizer` 纯函数 planner、完整 cycle 预算预检、重复事件幂等、deadline、
  output ref 真实性校验、runtime hard failure 与授权撤销 cancellation；
- `references/dialogue-participant-snapshot-v1.schema.json` 与
  `references/dialogue-relay-plan-v1.schema.json` 固化公共 artifact；
- `scripts/simulate-dialogue-planner.mjs` 只读 fixture 并把候选状态写到 stdout，不访问网络或控制面；
- 生产脚本没有 import foundation 模块；当前只有两套测试和离线 simulator 引用它；
- Claude 346/346、Codex 80/80 通过；共享导出面扩展为 19 个模块并更新快照；
- 证据层级仍是本地合成/契约测试，不等于 Slice B 路由或 Slice C Agent Relay 已实现、安装或验收。
