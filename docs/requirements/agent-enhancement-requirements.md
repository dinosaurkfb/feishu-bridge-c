# 第三方智能体增强：产品需求文档

状态：提案（Proposed）  
目标读者：产品设计者、Claude/Codex 适配开发者、评审者和部署维护者  
适用范围：`feishu-bridge` 从单话题桥接工具演进为本地第三方智能体的受控增强层

## 1. 背景与产品定位

当前 `feishu-bridge` 已经能够把飞书话题中的真实 mention 精确续接到本机 Claude Code 或
Codex 长期任务，并把最终答复发布回原话题。它解决了“离开电脑后继续本机长期任务”的问题，
但当前的绑定命令同时承担了项目订阅、话题创建、会话绑定和默认交互方式等多种职责。

随着一个项目接入多个群、一个群包含多个 Agent、一个项目存在多条长期会话，以及对讨论、带教、
项目推进等场景的需求出现，“飞书绑定”已经不能再被理解为一个布尔开关。

本次演进的产品定位是：

> 以飞书为人机协作界面，以 Aily 为运行时运输通道，以本机 Claude/Codex 为执行主体，提供可配置、
> 可审计、可扩展的第三方智能体连接、订阅、精确会话映射和交互策略。

桥仍然是底层运输内核，但用户最终获得的是一层“第三方智能体增强与控制能力”。

## 2. 目标

### 2.1 用户目标

- 一个本机 Claude/Codex 运行端点可以服务多个项目、群、话题和 Agent；
- 一个项目可以订阅多个飞书群，并为不同本地会话设置不同的话题和交互模式；
- 用户能够明确知道当前消息会进入哪个项目、哪条本地会话、采用什么策略；
- 本地输入、Agent 最终回复和飞书输入构成连贯、不过度重复的可检索记录；
- 用户可以显式暂停、恢复、轮转、迁移和撤销连接，而不依赖标题或“最近活跃会话”猜测；
- 在映射、对话和管理三类模式之间扩展时，不破坏现有确定性路由与安全边界。

### 2.2 工程目标

- Claude 与 Codex 共享运输、身份、订阅、claim、审计和出站语义；
- 运行时差异只留在 Claude/Codex adapter 中；
- 新增交互模式时以策略处理器扩展，不把所有逻辑堆进 `inbound.mjs` 或 hook；
- 控制面与数据面分离，配置变更必须来自显式控制动作；
- 所有处理都可幂等、可追踪、可失败关闭，敏感运行状态不进入 Git。

## 3. 非目标

- 不把本机桥改造成电脑离线后仍能运行的云端 Agent；
- 不通过消息正文猜测身份、路由、权限或目标会话；
- 不允许陌生群成员默认驱动本机任务；
- 不把工具日志、隐藏上下文、内部推理或敏感 locator 全量同步到飞书；
- 不在本阶段实现一个通用工作流编排平台；
- 不保证飞书与已打开的 Codex Desktop 页面实时呈现完全相同的 UI 刷新效果。

## 4. 核心概念

| 概念 | 定义 | 当前常被混称为 |
|---|---|---|
| 运行端点连接（Endpoint Connection） | 某个 Aily 第三方智能体与本机 Claude/Codex adapter 的机器级在线关系 | 安装、第一次接通 |
| 事件订阅（Subscription） | 哪些 Agent、群、发送者和事件类型可以进入哪个项目或业务域 | 项目绑定、群绑定 |
| 精确通道绑定（Channel Binding） | 一个飞书 topic/session 与一条本地 task/thread/session 的确定映射 | 话题绑定、会话绑定 |
| 交互策略（Interaction Policy） | 进入通道后的处理方式、自治程度、审批要求和出站行为 | 模式、设置 |
| 话题代际（Topic Generation） | 同一逻辑通道在话题轮转前后的版本；只有一个代际可接收新输入 | 重置话题、换话题 |
| 控制动作（Control Action） | 创建、修改、暂停或删除配置的显式操作 | bind/status/unbind 命令 |
| 数据事件（Data Event） | 经授权进入系统、需要被处理的一条飞书或本地回合事件 | 入站、出站消息 |

这些概念必须在 UI、命令、状态文件和文档中使用一致名称。特别是“项目订阅”和“精确会话绑定”
不能继续由一个含义不明的“已绑定”状态代替。

## 5. 用户与系统角色

| 角色 | 主要职责 |
|---|---|
| 所有者（Owner） | 安装运行端点、授权身份、创建或撤销订阅、决定高风险策略 |
| 操作者（Operator） | 在授权范围内向 Agent 下指令、查看状态、参与或中断对话 |
| 第三方智能体 | 在飞书中承载 mention、受理反馈、结果展示和可选交互控件 |
| Aily runtime/daemon | 将可信调用上下文和事件信封交给本机 adapter |
| Claude/Codex 长期任务 | 保留项目上下文并实际执行工作 |
| bridge 控制面 | 管理 endpoint、subscription、binding、policy 和生命周期 |
| bridge 数据面 | 确定性校验、选路、claim、投递、终局确认和发布 |

第一阶段仍可保持单一 Owner；多人协作必须在身份授权矩阵完成后再开放，不能简单把 sender 校验删掉。

## 6. 四层关系模型

```text
第 1 层：运行端点连接
Aily Agent ──online──> 本机 Claude/Codex adapter

第 2 层：事件订阅
Agent + 群/租户 + sender + event type ──subscribe──> 项目/业务域

第 3 层：精确通道绑定
飞书 topic/session ──bind──> 本地 task/thread/session

第 4 层：交互策略
通道 ──policy──> 映射 / 对话 / 管理（推进、专家、带教）
```

四层的基数要求：

- 一个 endpoint 可以服务多个 subscription；
- 一个项目可以拥有多条本地 target 和多个 subscription；
- 一个群可以包含多个 Agent 和多个话题；
- 一个飞书话题代际在任一时刻只能映射到一个精确本地 target；
- 一个本地 target 若要向多个群广播，必须通过明确的出站策略表达，不能制造入站歧义；
- 标题、项目目录和最近活跃时间只能用于展示或候选提示，不能作为最终路由主键。

## 7. 功能需求

### FR-1 运行端点连接

1. 系统应支持 Claude Code 与 Codex Desktop/CLI 两类 runtime adapter；
2. endpoint 配置应包含稳定 ID、runtime 类型、Aily Agent UID、运行状态和版本；
3. endpoint 连接只证明运输能力在线，不得自动创建项目订阅或话题绑定；
4. endpoint 自检应区分 daemon 离线、身份不匹配、adapter 不可用和 bridge 未安装；
5. 多个 consumer 共用一个 Aily daemon 时，必须由统一分发器按可信字段确定路由，不得靠安装顺序覆盖入口。

### FR-2 项目/业务域事件订阅

1. Owner 可以把一个项目订阅到一个或多个飞书群；
2. subscription 必须声明允许的 Agent、群/租户、发送者集合和事件类型；
3. 同一群中的不同 Agent 可以订阅不同项目或业务域；
4. subscription 的热路径职责是**未绑定话题的首次认领**：判断该事件有资格进入哪个域、认领哪个
   pending binding；完成认领后，日常路由直接使用 `topic/session → binding → local target`，不再
   为每条消息重复匹配 subscription；
5. subscription 变更由控制面同步到依赖它的 binding 授权快照；暂停或撤销 subscription 时，相关
   binding 必须被明确暂停或迁移，不能依靠日常热路径重新解释配置；
6. subscription 不能替代精确 task/thread 绑定；首次认领未命中唯一 subscription 时必须拒绝，
   不得询问模型选择；
7. 每个 subscription 字段必须有明确消费者和契约测试；没有任何运行代码读取的字段不得进入稳定
   schema；
8. 订阅的创建、修改、暂停和删除必须留下审计记录。

### FR-3 精确通道绑定

1. 一个活动 topic/session 必须确定性映射到一个本地 target；
2. 同一项目可以把多条长期会话分别绑定到多个话题；
3. 首次 Aily session 尚未产生时，可以使用一次性绑定短码完成认领；完成后只使用稳定 ID；
4. 日常路由不得依赖话题标题、消息正文、当前打开窗口、`--last` 或“最近活跃任务”；
5. 多个候选 target 时必须明确拒绝，并引导用户通过显式控制动作选择；
6. binding 必须支持 `active`、`paused`、`rotating`、`retired` 状态；
7. binding 需要支持暂停、恢复、轮转、迁移和可恢复撤销。

### FR-4 映射模式

映射模式将一条本地长期会话与一个飞书话题组成双向、可审计的用户可见回合记录。

必须同步：

- 人类在 Claude/Codex 本地界面提交的可见输入；
- Claude/Codex 的非空最终答复；
- 经策略允许的关键进展、风险、决定或失败回执。

不得默认同步：

- 工具调用日志、hook 内部上下文、隐藏提示、内部推理；
- 未完成的半成品输出、原始凭据、locator、claim 和 receipt；
- 飞书发起回合中已经存在于话题里的用户输入副本。

本地输入和最终答复应合并为一张轻量卡片；飞书发起回合只发布结果，避免复读原消息。

### FR-5 对话模式

对话模式允许多个 Agent、子 Agent 或人类围绕一个主题进行受控协作。每个对话策略必须声明：

- 主持者/编排者；
- 参与者及各自身份；
- 轮次顺序或发言触发规则；
- 最大轮数、时间预算和资源预算；
- 停止条件、失败条件和人工中断入口；
- 并发回复、mention 环路和重复事件的处理规则；
- 最终产物的汇总者与发布目标。

系统不得仅靠 Agent 在正文中互相 mention 形成无限循环。

首个可交付纵切（Dialogue v1）确定为：**一个主持本地 target + 一名既有 binding 授权人类 + 串行
轮次**。主持 target 同时承担最终汇总；每轮必须由人类新事件启动，Agent 输出不得自动成为下一轮
输入；默认预算为 12 轮、2 小时和 12 资源单位。该纵切用于先验证 policy 生命周期、预算、终局和
人工中断，不代表 FR-5 的多 Agent/子 Agent 协作已经完成。多 Agent 自动接力、并行发言和多人授权
必须在后续版本增加独立的参与者权限、turn planner、循环检测与失败策略后才可开放。

Dialogue 下一纵切按三阶段交付：先建立不可变参与者授权快照与只计算、不 dispatch 的确定性串行
planner；再在自动 Topic Generation 真实验收、可信 chat scope 和 binding 授权快照同步均通过后，
把多 subscription 路由按 endpoint/domain 灰度切流；最后才允许一个 host、一个 peer 和 host
finalizer 的固定串行接力。任何阶段都不得从 Agent 正文 mention 动态新增参与者或选择下一目标，
也不得让同一人类事件被多个 binding 重复 claim。

foundation 必须使用独立 schema 和离线 simulator，不修改 Dialogue v1 的 state schema 或 adapter 热路径。
Relay 必须显式使用新的 policy version；其预算分别统计 human cycle、Agent run、时间和资源，不能静默
复用 v1 的“12 轮 = 12 次主持 run”语义。授权撤销统一视为受控取消，不与 runtime 硬失败混用。

### FR-6 管理模式

管理模式用于长期监督与增强，至少包含三种策略档案：

| 档案 | 目的 | 典型输出 |
|---|---|---|
| 项目推进 | 跟踪人类和 Agent 的进展、依赖、风险与交付物 | 状态摘要、催办建议、阻塞升级 |
| 专家 | 回答问题并提供关键判断 | 建议、评审意见、风险判断 |
| 带教 | 观察 Agent 表现并提出可验证的改进建议 | 能力诊断、训练计划、评估记录 |

每个管理策略必须独立配置权限等级：

1. `observe`：只读观察；
2. `advise`：形成建议但不执行；
3. `execute`：在明确范围内执行已授权动作；
4. `modify`：修改 Agent 配置、提示词或能力，必须单独授权并留下变更证据。

模式名称不能隐含权限；例如“项目推进”不自动获得发消息、改任务或改 Agent 的权限。

### FR-7 显式控制面

建议的用户控制入口：

| 动作 | 建议命令 | 作用 |
|---|---|---|
| 检查端点 | `$feishu-connect` | 安装、恢复或只读检查 endpoint |
| 管理订阅 | `$feishu-subscribe` | 配置项目、群、Agent、sender 和事件范围 |
| 绑定通道 | `$feishu-bind` | 将当前精确本地 target 绑定到话题 |
| 设置策略 | `$feishu-mode` | 查看或修改当前通道的交互策略 |
| 轮转话题 | `$feishu-rotate` | 为同一逻辑通道创建新话题代际 |
| 查看状态 | `$feishu-status` | 只读展示四层状态和待处理事件 |
| 暂停连接 | `$feishu-unbind` | 可恢复地暂停通道，不删除历史 |

控制面必须满足：

- 只有显式命令、显式技能调用、受信按钮事件或等价结构化动作才能修改配置；
- 普通业务消息中讨论“绑定、订阅、改名、连接”等概念时不得产生控制副作用；
- 不得用宽泛自然语言正则直接把普通输入升级为写操作；
- 控制授权只来自已认证的人类 Owner/Operator 控制通道；Agent、子 Agent 或转发内容即使包含完全
  相同的 `$feishu-bind` 等 token，也不得继承控制权；
- 控制动作应先解析为结构化 intent，再校验当前精确 target、权限、影响范围和幂等键；
- 一次明确的 `$feishu-bind` 可以作为该次绑定授权，无需机械地二次确认；扩大范围、迁移或高风险修改仍需独立授权。

### FR-8 话题轮转

“重置话题”应实现为同一逻辑 binding 的代际轮转，而不是删除旧话题或新建无关 binding。

- binding 必须有稳定 `binding_id`，每个话题有单调递增的 `generation`；
- 任一时刻只有一个 generation 接收新入站；
- 旧 generation 保留为只读历史；
- 轮转前已经受理的请求仍回复到其来源话题；
- 轮转后新请求只进入新话题；
- 新话题等待首次真实 mention 认领时，旧 generation 继续保持 active；pending generation 默认在
  24 小时后过期并 fail-closed，用户也可以显式取消；
- 新旧 generation 的 active/read-only 切换必须在同一份 binding 状态的单次原子写入中完成；
- 本地发起且没有飞书来源的回合，在形成 outbox 项时解析并冻结当时的 active generation；若运行
  期间已经完成轮转，则发布到新 generation；
- 轮转可以手动触发；自动轮转 v1 按当前 active generation 的有效业务消息数触发，默认阈值为
  30。人类指令与 Agent 最终回复分别计 1，本地配对回合计 2，绑定握手、系统回执与普通进展不计；
- 自动阈值只创建 pending generation，不绕过新话题的真实 mention 认领，也不回扫升级前历史；
- 后续可以扩展按年龄或累计内容量触发，但必须作为显式、版本化策略，不能靠正文正则猜测；
- 不应直接把本地上下文压缩事件等同于飞书话题轮转，两者可以关联提示，但生命周期独立。

### FR-9 出站与可见记录

1. 出站必须来源于真实完成事件和非空最终输出；
2. 本地输入与回复按 `turn_id` 或等价稳定键配对；
3. 飞书来源输入不得在结果卡片中重复；
4. 卡片摘要优先取用户输入，其次取 Agent 第一条有效回复；
5. 发布失败必须保留 outbox，不得标记成功或自动重放历史消息；
6. 广播到多个群必须由 egress policy 明确列出目标和内容级别。

### FR-10 状态与审计

`status` 至少应展示：endpoint 是否在线、subscription 命中范围、binding 当前代际、policy 名称和版本、
最近 claim/run/publish 的成功或失败状态。面向用户的输出不得泄露完整 locator、凭据或原始身份材料。

## 8. 非功能需求

### 8.1 安全

- 所有可信身份字段必须取自 Aily/飞书事件信封或本地受控配置，不能取自正文；
- 默认失败关闭；配置缺失、冲突或歧义时不得降级猜测；
- 运行状态、身份、claim、receipt、run 和 outbox 必须保存在 Git 之外；
- 数据面不得绕过 Claude/Codex 自身 sandbox、审批和权限边界；
- 多人支持必须使用人员—Agent—订阅—动作授权矩阵，并支持撤销。

### 8.2 可靠性

- 一个原始事件只获取一次，并用事件 ID 做幂等 claim；
- “已受理”与“已完成”必须分开；
- 并发事件不得竞争同一个 target 导致双写；目标繁忙时应排队或明确拒绝；
- handler 崩溃、运行时失败和发布失败必须产生不同、可诊断的终态；
- topic 改名不得影响路由。

### 8.3 可移植性与性能

- 当前完整链路以 macOS 为实机基线；架构不得依赖 macOS 专属语义，Linux 在依赖齐全后应可部署；
- 入站受理应维持秒级反馈；分发器不得为每个候选 handler 重复获取信封或串行试跑；
- hook 必须轻量、快速并始终安全退出，网络和业务处理留给 dispatcher/handler。

## 9. 当前能力与目标态

| 能力 | 当前 main | 本次目标 |
|---|---|---|
| Aily → 本机 endpoint | Claude/Codex 均可用，共享 dispatcher 与 Canonical Event v1 已进入 `main` | 扩大真实样本并统一 endpoint 状态展示 |
| hook 强制进入运输层 | Claude/Codex hooks 均已正式安装；dispatcher 契约已由 PR #6 合并 | 用新的真实 mention 验收秒级受理、精确续接与原话题回写 |
| 项目—群订阅 | Subscription v1、首次认领消费者和 claim 纵切已由 PR #5 合并；尚未开放多订阅写入口 | 开放受控多订阅管理，不改变现有单订阅默认行为 |
| 精确话题—会话绑定 | 稳定 binding 与 Topic Generation 兼容投影已进入 `main`，Claude/Codex 保留各自 runtime locator | 继续统一生命周期与对外状态语义 |
| 映射模式 | Mapping Policy Handler 已由 PR #7 合并并安装；旧 selector 仍唯一承重，新候选只做 shadow comparison | 真实样本一致后再灰度切换权威读取路径 |
| 话题轮转 | Topic Generation 生命周期与显式 rotate 命令已由 PR #8 合并并安装；Codex 第 2 代话题的创建、真实 mention 认领与 binding 切换已完成首次真实验收；自动轮转 v1 已合并 `main`，按每代际 30 条有效业务消息创建 pending，新代际仍需真实 mention，但正式安装与真实自动触发验收后置 | 单独安装并验收自动创建、失败重试与不重复轮转，再评估多订阅 |
| 对话模式 | Dialogue v1 已由 PR #11 合并 `main` 并完成 Codex 真实 3 回合验收；Slice A foundation 已形成公共 schema、纯函数 planner 与 simulator；Slice B1 已形成默认关闭的双 adapter binding authorization shadow 候选，但均未安装或切权威路由 | 评审/合并 Slice A/B1；多订阅权威路由必须等自动轮转 v1、可信 chat scope、授权快照同步和真实 shadow 一致性完成验收后再灰度切流，最后才开启固定串行 Agent Relay |
| 项目推进/专家/带教 | 原型仅在未合并的 `feat/agent-supervisor-shadow-mvp` 实验分支，`main` 不含相关实现 | 纳入管理策略和分级权限 |
| 多人授权 | 未实现 | 身份授权矩阵与审计归属 |
| 显式控制面 | bind/status/unbind/rotate/mode 均已作为显式命令安装；无参 mode 只读，只有整条输入中的 `dialogue` / `mapping` 才写状态，真实验收已验证异常格式不触发 | 后续模式继续沿用结构化 intent 与逐次授权 |

## 10. 验收标准

### 第一阶段：契约与控制面

- 普通消息“我们讨论一下绑定架构”不会触发任何配置写入；
- `status` 能区分 endpoint、subscription、binding 和 policy；
- 现有绑定可迁移到新状态模型且保持 topic/session/thread 映射不变；
- Claude 与 Codex 共用同一组 canonical schema 与失败码。

### 第二阶段：映射模式稳定化

- 本地输入与最终答复配对发布，飞书输入不重复；
- topic 改名不改变路由；
- topic 轮转期间，新旧请求均回复到正确来源话题；
- 同一项目的多条会话和同一群的多个 Agent 不会串线。

### 第三阶段：新模式

- 对话模式在达到预算、停止条件或人工中断时确定结束；
- 管理模式的 observe/advise/execute/modify 权限可独立验证；
- 未授权 Agent 或人员无法通过正文、转发或 mention 链获取更高权限。

## 11. 建议实施阶段

1. **文档基线**：合并本需求和架构契约；
2. **显式控制意图**：收紧写操作入口，先消除普通讨论误触发；
3. **订阅认领纵切**：subscription schema、只读迁移和首次认领消费者一起交付，并用 shadow
   comparison 对照旧路由；不合入没有消费者的稳定 schema；
4. **Codex dispatcher 契约接入**：复用 Claude 已有 dispatcher 设计，接入 Codex，并让两端迁移到
   无损 canonical event；保留各自 runtime adapter；
5. **映射模式 handler 化**：迁移现有双向桥，建立兼容回归基线；
6. **话题轮转与多订阅**：先处理生命周期，再扩大基数；
7. **对话模式**：以单独策略插件实现；
8. **管理模式**：按项目推进、专家、带教分别交付；
9. **多人授权**：最后开放，并以授权矩阵和审计为前置条件。

每个阶段应使用独立、短生命周期分支和 PR。不要把全部重构放进一个长期巨型分支。

## 12. 待决策事项

- subscription 的管理单位是“项目根目录”还是更抽象的业务域 ID；
- 一个本地 target 是否允许多个活动出站目标，若允许，默认内容级别是什么；
- 自动轮转 v1 已确定默认阈值为每代际 30 条有效业务消息，并自动创建 pending 话题；是否允许用户
  按 binding 改阈值或关闭自动轮转留待后续控制面设计。候选话题等待首次真实 mention 的认领期限
  仍默认 24 小时；
- 对话模式首个版本已确定只支持一个主持者、一名授权人类和串行轮次；多 Agent 自动接力留给后续
  版本；
- 管理模式中哪些 execute 动作可以预授权，哪些始终逐次授权；
- 多人场景的角色模型与飞书组织身份如何映射。
- 重新验证 Aily daemon 注入的 `AILY_CLI_CHANNEL_THREAD_ID` 与真实飞书 topic/root/session locator 的
  对应关系、稳定性和安全性；验证完成前继续保留绑定短码，不把一次观测固化为契约。
