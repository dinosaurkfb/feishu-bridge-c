# Dialogue Policy v1：单主持者串行对话

状态：已由 PR #11 合并到 `main`（merge `0e6082c`），已正式安装到本机 Claude/Codex
两套 adapter，并完成 Codex 精确 task 的真实飞书多回合验收。

本切片实现需求 FR-5 和架构契约 9.2 的第一个可运行纵切：一名已授权人类通过一个已绑定飞书
话题，与一条精确 Claude/Codex 长期任务进行有界、串行的多轮对话。它建立 Dialogue 的公共状态、
预算、终局和人工中断契约，但**不包含多个 Agent 自动接力、Agent 输出触发下一 Agent、并行发言或
多人授权**。

## 1. 为什么它不是另一个 Mapping 名字

Mapping 的每条输入都是彼此独立的一次运行。Dialogue 则在 binding 上创建一个稳定
`dialogue_id`，随后多条人类消息共享同一个对话预算和生命周期：

```text
explicit mode switch
  -> Dialogue(active, bounded)
  -> human event / turn 1 -> exact host run -> strict terminal
  -> human event / turn 2 -> exact host run -> strict terminal
  -> ...
  -> budget / failure / human interrupt -> terminal Dialogue
```

每轮仍复用已经验证的 mention、sender、binding、Topic Generation、claim、精确 target 和 outbox
链路。Dialogue 不重新获取 Aily 信封，也不修改运行时自身的权限模型。

## 2. v1 参与者与轮次契约

| 项目 | v1 固定值 |
|---|---|
| 主持者/汇总者 | 当前 binding 的精确本地 target |
| 人类参与者 | binding 授权快照中的单一 authorized sender |
| 轮次 | `human_then_host_serial` |
| 最大并发活动回合 | 1 |
| Agent 输出作为下一轮输入 | 禁止 |
| mention 环路 | 禁止 |
| 重复事件 | 按 event id 幂等，不重复扣预算 |
| 发布目标 | 每轮受理时冻结的来源 Topic Generation |

“主持者”在 v1 同时是最终回复的汇总者。飞书中的下一轮只能由已授权人类再次真实 mention 发起；
Agent 回复、卡片摘要、转发内容和普通正文中的控制 token 都不会自行启动后续回合。

## 3. 状态与预算

[`references/interaction-policy-v1.schema.json`](../../references/interaction-policy-v1.schema.json) 固化
binding 级 `interaction_policy_state`。旧 binding 没有该字段时惰性读取为 Mapping，不做隐式升级。

Dialogue 默认预算：

- 最多 12 个已开始的人类→主持者回合；
- 最长 2 小时；
- 最多 12 个资源单位；v1 每次主持者运行固定消耗 1 个单位。

预留回合、增加轮次/资源用量和写入 `active_turn` 在同一个 Git 外 binding 锁中原子完成。时间预算
在预留下一个回合或严格终局时检查；超过截止时间后不会再启动新运行。`processed_events` 只保留最近
256 个幂等索引，避免状态无限增长。

每个活动回合冻结：`event_id`、`run_id`、`dialogue_id`、`turn_index`、opaque `local_target_id`、来源
generation 和 adapter 私有 runtime target。公共 `runRequest` 不包含 Claude session/Codex thread
locator。

## 4. 生命周期与终局

```text
Dialogue: active -> completed | failed | cancelled
Turn:     dispatched -> completed | failed | cancelled
```

硬停止条件包括：轮次预算、时间预算、资源预算、runtime 失败和人工中断。任意 runtime 失败都会将
整个 Dialogue 标记为 failed；v1 不自动重试，也不把半成品当下一轮输入。

- Codex：watcher 只有同时观察到目标 thread、`turn.completed`、exit code 0 和非空最终输出，才将
  回合标为 completed；其他严格终态和观察超时标为 failed。
- Claude 后台运行：一次性 watcher 读取 run 终态并结束回合；即使关闭自动发布，观察者仍会运行。
- Claude 活跃会话投递：只有 `active_turn.runtime_target_id` 与触发 Stop 的精确 session 相同，Stop
  hook 才能结束该回合；其他会话的 Stop 无权修改它。这条现场路径不额外启动 watcher；若会话一直
  没有 Stop，下一条通过准入的人类事件会在预留前检查 deadline，原子取消悬挂回合并以时间预算终止
  Dialogue。bridge 不会强杀仍在运行的交互会话进程。
- 发布失败只影响 outbox/egress，不把已经真实完成的 runtime 回合倒写成失败。

切回 Mapping 是显式人工中断：尚未结束的 Dialogue/turn 记为 cancelled，历史 claim、run、回执、
话题和已形成的 outbox 全部保留。

## 5. 控制命令

| 目的 | Codex | Claude |
|---|---|---|
| 只读查看 | `$feishu-mode` | `/feishu-mode` |
| 开启/继续当前 Dialogue | `$feishu-mode dialogue` | `/feishu-mode dialogue` |
| 回到 Mapping / 中断 Dialogue | `$feishu-mode mapping` | `/feishu-mode mapping` |

写操作只接受占据整条输入的显式命令。Codex UserPromptSubmit hook 注入精确 thread id；Claude 使用
当前项目/工作线的既有 binding 选择规则。CLI 默认为 dry-run，只有 hook/skill 生成的 `--apply` 才
写入。对一个仍 active 且预算相同的 Dialogue 重复执行 `dialogue` 是幂等的，不创建第二个对话。

`$feishu-status` / `/feishu-status` 会显示模式、Dialogue 状态、活动回合和预算用量，但不展示 locator、
claim、凭据或完整内部 ID。

## 6. 运行时状态与并发

Claude project-file binding 与 Topic Generation 共用生命周期锁；registry binding 与 Codex task 使用
各自 registry 锁。幂等 consumed id 独立保存在 sidecar，不能用入站开始时读到的旧 mapping 整份
覆盖回去，否则会抹掉刚刚原子写入的 Dialogue/Topic Generation 状态。

同一 target 忙、已有活动 Dialogue turn 或无法取得锁时均 fail-closed。claim、预留和投递仍区分：
“已取得 claim”不等于“已开始回合”，“已受理”也不等于“已完成”。

## 7. 兼容、回滚与证据

- 老 binding 无状态字段时保持 Mapping 1.0；安装不会自动创建 Dialogue、话题或 run；
- Mapping 的既有准入、卡片、来源 generation 和自动 Topic Generation 计数语义保持不变；
- 回滚代码前应先用 mode 命令切回 Mapping。已写入的未知 `interaction_policy_state` 由旧代码原样保留，
  但旧代码不会执行 Dialogue 预算；
- 合成证据覆盖公共状态机、Claude/Codex Git 外持久化、控制命令、严格 watcher、精确终局匹配、
  consumed sidecar 与两套全量回归：Claude 336/336、Codex 79/79，18 个共享模块契约一致；
- 真实链路证据覆盖显式进入 Dialogue、同一飞书话题的 3 个人类→Codex 串行回合、每轮自动回写、
  `3 / 12` 轮次与 `3 / 12` 资源计账、无悬挂活动回合，以及显式切回 Mapping；
- 真实验收不代表多 Agent 自动接力、并行发言、多人授权或自动 Topic Generation v1 已验收；
  这些能力仍需独立契约、授权和真实证据。

## 8. 2026-08-22 真实验收记录

1. 在已绑定的 Codex 精确 task 上显式执行 `$feishu-mode dialogue`；
2. 从原绑定飞书话题连续发起多条真实人类指令，完成 3 个串行回合并逐轮收到回写；
3. `$feishu-status` 回读为 Dialogue active、`3 / 12` 轮、`3 / 12` 资源单位，且没有活动回合；
4. 显式执行 `$feishu-mode mapping`，状态成功恢复 Mapping 1.0，历史话题和回合证据保留。

本记录只保留脱敏行为证据，不写入 thread、topic、claim、run 或凭据 locator。

后续 Dialogue 子版本如要加入多个 Agent，必须另行增加参与者授权、确定性 turn planner、每个 Agent
的独立预算/失败语义和循环检测；不能把 v1 的 `allow_agent_output_as_input=false` 直接改成 true。
