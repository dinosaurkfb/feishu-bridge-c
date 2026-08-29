# 四层关系、交互模式与权限分级 —— 现状与未决

> 2026-08-29 整理。目的：把散在 goal、评审、聊天里的"四层状态 / 多种模式 / 多级权限"收成一份能对着讨论的文档。
> **"现状"一栏写的是代码今天的行为**（main 8c5cedc + PR #93 / #94 分支），**"提议"一栏是还没拍板的**。两者分开写，不混。
> 读者：Frank（手机上看）、Codex（评审）、我自己（下一个 goal 的输入）。
>
> **2026-08-29 晚更新**：Frank 看完后回「你的建议都同意，实现复杂可提简化方案」—— §6 各行状态已改；简化方案见 §6a；goal 修订稿见 §6b；第 1 层已装（§7）。

## 1. 先说结论

- 四层各管一件事：**端点**（连没连上）、**订阅**（收得到谁的话）、**通道**（这句话进哪条会话、回哪个话题）、**策略**（进去以后按什么规矩办）。状态页按这四层分区展示，**不出总判断**。
- 今天的模式只有两种：**Mapping**（普通文本 = 跑一轮 run）和 **Dialogue**（普通文本 = 对话回合）。**没有绑定的上下文没有模式**，路由器一律拒 —— 这违反了 Frank 的原则"owner 在任何状态下的能力不应少于不装这批技能时"。提议补一个 **chat** 默认态。
- 权限已从"一个 open_id = 全部"改成 **角色 × 风险等级 × 模式**（PR #93，未合并），并把命令命名空间收边（PR #94，叠在 #93 上）。**卡点只有一个**：R1"对话"还没有执行边界 —— participant 的"对话"仍会投进能改文件的宿主。这一条要 Frank 定方案。

## 2. 四层关系模型

| 层 | 管什么 | 事实从哪来 | 可能的状态 | 今天的现状 |
|---|---|---|---|---|
| 第 1 层 运行端点连接 | Aily Agent ──online──> 本机 adapter；入站分发表把事件交给哪个处理器 | 运行时 `runtime/current` 校验；`routes.json` 默认处理器六态（在运行时内 / 无表 / 表外 / 无默认 / 默认指错 / 读不出） | 未自检 / 全部通过 / 有问题 / 没查清 | **实时自检（FR-1.4）没实现**，状态页只说"未自检"，历史入站记录只算"过去某刻工作过"。`doctor ⑦` 与状态页「入站处理器」会报分发表漂移（8/23–8/28 线上就是它指错了处理器） |
| 第 2 层 事件订阅 | Agent + 群 + 发送者 + 事件类型 ──subscribe──> 项目 / 业务域 | **平台侧**：把智能体拉进群、在群里 @ 它或私聊它，平台投 `im.message.receive`（只认这一种事件，进群 / 退群事件收不到）。**本机侧**：`feishu-subscribe` 显示的是从模板算出来的**投影**（transport open_id + 模板里那一个 chat_id + 发送者角色表），不碰平台 | 订阅活动 / 无订阅投影 | 准入只查三道闸：发送者在角色表里、真实 @、新鲜度。**不核对群 id**（envelope 的 chat_id 仍标"未核验"）。多群独立订阅增删卡在 FR-2.6（没有多群真实样本） |
| 第 3 层 精确通道绑定 | 飞书 topic / session ──bind──> 本地 task / thread / session；出站回哪个话题走同一条选择规则 | 登记表（项目级 / 会话级 binding）、claim、待认领、话题代际 | 未绑定 / 待认领 / 已绑定（active）/ 已暂停（unbind 之后）/ 已轮转（旧话题保留为历史） | bind 建话题 + 登记；rotate 建下一代话题；unbind 可恢复地暂停；pin-session 钉现场会话。**未绑定的上下文（私聊、无绑定的群话题）一律拒**，非 bind 的正文会被当成"首次认领"去匹配待认领 task，多于一个就报歧义（Frank 截图那条私聊就是这样被拒的） |
| 第 4 层 交互策略 | 通道 ──policy──> Mapping / Dialogue（需求里还有"管理"，未实现） | binding 上的策略状态（Git 外）；`/feishu-mode` 当场切换并回执 | Mapping（默认）/ Dialogue | 两条链都可从飞书切换；Dialogue 有预算（12 轮 / 2 小时 / 12 资源单位）与停止条件；**没有绑定就没有第 4 层** |
| 第 5 区 待处理事件 | 待认领、待发、过期提醒 | claim / outbox / 回执 | — | 状态页单独一区 |

一句话记忆：**第 2 层管"收得到谁的"，第 3 层管"进哪条会话、回哪个话题"**——它们分别描述入站规则和出站规则，但都不是"直接负责入站 / 出站"的那段代码。

## 3. 上下文状态 × 今天 / 提议

| 状态 | 第 2 层 | 第 3 层 | 第 4 层 | owner 今天能做什么 | 非 owner 今天 | 提议 |
|---|---|---|---|---|---|---|
| A 刚装桥、话题未绑定 | 订阅在 | 未绑定 | 无 | 只有正文恰为 `/feishu-bind` 才进绑定流程；其它一律拒（多待认领 task 时报歧义） | 拒 | 按 **chat** 处理：普通问答（R1），不取 claim、不跑 run；`/feishu-bind` 才进绑定 |
| 私聊 owner | 订阅在 | 私聊不绑定 | 无 | 同 A（截图里"移除项目"被当首次认领 → 歧义 → 拒） | 拒 | **chat** |
| B unbind 之后 | 订阅在 | 已暂停 | 无 | 一切拒（"退回订阅状态"= 退到零权限，只剩"让它闭嘴"） | 拒 | unbind = **退回 chat**，不是退回死状态 |
| C 已绑定 · Mapping | 订阅在 | active | Mapping | 普通文本跑一轮 run（R2）；控制命令；授权用语 | 全拒（回执说明模式 / 角色 / 缺什么权限） | 不变 |
| D 已绑定 · Dialogue | 订阅在 | active | Dialogue | 普通文本 = 对话回合（R1）；控制命令；授权用语 | operator / participant 可 R1；R0 / R3 / R4 拒 | 不变，但 R1 要有执行边界（见 §6 第 1 条） |

**Frank 的原则（2026-08-29）**：owner 在任何状态下拥有的权限和能力，都不应比不装这批技能时更少。A / 私聊 / B 三行今天都违反它。

## 4. 交互模式

| 模式 | 普通文本的含义 | 风险等级 | 谁能发普通文本 | 进入 | 退出 / 停止 | 状态 |
|---|---|---|---|---|---|---|
| Mapping | 在本地项目里跑一轮 run（改文件、跑命令），结果发回话题 | R2 执行 | 只有 owner | 绑定后的默认；`/feishu-mode mapping` | `/feishu-mode dialogue` | 已实现 |
| Dialogue | 一个对话回合，只产生一段回复（**意图如此，边界未做**） | R1 对话 | owner / operator / participant | `/feishu-mode dialogue` | 预算耗尽（12 轮 / 2 小时 / 12 单位）、run 失败、人工打断、`/feishu-mode mapping` | 已实现（预算与停止条件有测试） |
| chat（提议） | 普通问答；不取 claim、不跑 run、不动本机任何东西 | R1 对话 | owner / operator / participant | 无绑定上下文的默认（A、私聊、unbind 之后） | `/feishu-bind` 进入绑定 → Mapping | **未实现**，等 Frank 一句"改 goal，加 chat" |
| 管理（需求 FR-6） | Agent 之间 observe / advise / execute / modify | — | — | — | — | 未实现，与这套权限不是一回事 |

## 5. 权限分级

### 5.1 角色（第 1 层已实现，PR #92 已合并到 main 8c5cedc，未安装）

| 角色 | 谁 | 怎么登记 | 备注 |
|---|---|---|---|
| owner | Frank，只有一个 = 模板里的 `frank_sender_id` | 绑定时登记 | 首次认领（绑定）只认 owner |
| operator | 信任的人 | `register-sender.mjs --template … --open-id <数字> --role operator --apply`（写入要 owner 逐次授权；模板唯一写事务，带锁、备份、逐字读回） | **权限暂与 participant 相同**，角色位先留出来 |
| participant | 订阅群里 @ 了智能体的任何人 | 同上，role participant | — |
| 未登记 / Agent 转发 / 引用里的 token | — | — | 零权限（与今天一致："发送者不是授权用户"） |

### 5.2 风险等级（PR #93，意图联合是 PR #94 收的边）

| 等级 | 含义 | 落进来的意图 | 例子 |
|---|---|---|---|
| R0 只读 | 不动本机任何状态 | readonly：正文恰为本链 `feishu-status` / `feishu-subscribe` | `/feishu-status` |
| R1 对话 | 只产生一段回复 | ordinary × Dialogue | "这个问题你怎么看" |
| R2 执行 | 跑一轮 run | ordinary × Mapping；模式说不清也按 R2（fail-closed） | "帮我改一下代码" |
| R3 控制 | 改绑定 / 策略 | 命令命名空间里的**一切**：router_control（mode）、model_control（bind / rotate）、rejected_control（unbind / pin-session 不从飞书开放）、malformed_control（缺参、错参、多尾巴、没这个词、别链前缀） | `/feishu-mode dialogue`、`/feishu-unbind`、`/feishu-mode`、`$feishu-mode dialogue`（发到 Claude 链） |
| R4 授权类 | 逐次授权用语的封闭措辞，可带对象 | authorization | `装`、`装 8c5cedc`、`安装 PR #93`、`切路由`、`写飞书` |

归类只看"这条消息想干什么"，不看谁发的；**归类不是执行边界**——"把这份结果发到飞书"这种自由语句在 Dialogue 下就是 R1，模型收到后能不能真去写飞书，由投递层的能力边界决定（今天没有，见 §6）。

### 5.3 交叉表（Frank 2026-08-29 拍板；唯一一处 `authorize({ role, riskClass, mode })`，三道闸之后、拿 claim 之前）

| 模式 × 等级 | R0 只读 | R1 对话 | R2 执行 | R3 控制 | R4 授权类 |
|---|---|---|---|---|---|
| Mapping | owner | owner | owner | owner | owner |
| Dialogue | owner | owner / operator / participant | owner | owner | owner |
| chat（提议） | owner | owner / operator / participant | —（没有目标，"要执行请先 bind"） | owner | owner |

表里没写的格子一律不允许；拒绝必须回执"这个话题处于 X 模式；你的角色是 Y，Rn（描述） 需要 Z 权限"，不投递、不静默、不取 claim（重发是新一笔）。

### 5.4 命令表：谁、从哪、落到哪一支

| 命令 | 意图类别 | 等级 | 飞书里可发 | 终端里可用 | 谁 | 到了路由器怎么处置 |
|---|---|---|---|---|---|---|
| `/feishu-status`、`$feishu-status` | readonly | R0 | 是 | 是 | owner（Dialogue 下 operator / participant 也拒 —— 暂定） | 投给模型，由技能只读展示 |
| `/feishu-subscribe` | readonly | R0 | 是 | 是 | 同上 | 同上（只显示投影与角色人数，不出 locator） |
| `/feishu-mode dialogue` / `mapping` | router_control | R3 | 是（正文恰为） | 是 | owner | 路由器当场切换并回执，不投递；重放按 claim 幂等 |
| `/feishu-bind` | model_control | R3 | 是（正文恰为；调用本身就是授权） | 是 | owner | 投给模型执行技能（建话题 + 登记 / 恢复暂停的话题） |
| `/feishu-rotate`、`/feishu-rotate cancel` | model_control | R3 | 是 | 是 | owner | 投给模型执行技能（下一代话题 / 取消） |
| `/feishu-unbind` | rejected_control | R3 | **否** | 是 | owner | 取 claim → 记拒绝终态 → 回执"不从飞书开放，请在终端里跑" → 不投递（PR #94） |
| `/feishu-pin-session` | rejected_control | R3 | **否** | 是 | owner | 同上 |
| `/feishu-mode`（缺参）、`/feishu-mode dialog`、`/feishu-status now`、`/feishu-whatever`、别链前缀 | malformed_control | R3 | — | — | owner 才走到这一步 | 取 claim → 记拒绝终态 → 回执差在哪 → 不投递（PR #94） |
| `装` / `装 <对象>` / `安装 …` / `切路由` / `写飞书` | authorization | R4 | 是（对象必须封闭：上一条汇报里的 PR / HEAD） | 是 | owner | 投给模型，模型按 CLAUDE.md 措辞纪律判断 |
| 普通文本 | ordinary | R1 / R2 按模式 | 是 | — | 按交叉表 | Mapping：跑 run；Dialogue：对话回合；无绑定：今天拒（提议 chat） |
| `register-sender.mjs`、`--apply` 类安装、`register-route --restore-default` | —（终端脚本） | — | 否 | 是 | owner 逐次授权 | 不经路由器 |

## 6. 未决事项（要 Frank 定）

| # | 问题 | 选项 | 我的建议 | Codex 意见 | 状态 |
|---|---|---|---|---|---|
| 1 | **R1 没有执行边界**：三条投递路径（现场转发 → 现场会话、`claude --resume -p`、`codex exec resume`）都是全能力，participant 的"对话"会进到能改文件的宿主 | **A** 非 owner 的 R1 走"只回复"路径（runRequest 带 `capability: reply_only`；Claude 起 `claude -p --resume <会话> --fork-session --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'`，不碰现场会话；结果照旧发回话题）；**B** 边界做完前把 Dialogue 的 R1 改回 owner-only（表里一行数据），先合 | A | 选 A；B 只作 A 完成前的临时闭门状态，且不能宣称第 2 层收口 | **Frank 同意 A**；实现走 §6a 简化版 |
| 1a | A 里 Claude 的 R1 是零工具还是放只读工具（Read / Grep / Glob） | 零工具 / 只读工具 | 零工具先做 | 零工具：只读工具也扩大本机信息可见范围 | **同意零工具** |
| 1b | participant 能不能看到 owner 现场会话的既有上下文 | 能（从会话分叉）/ 不能（独立记录、受限投影） | 不能 | 不能；participant 回合留在飞书、审计与独立 transcript 里，不回灌 owner 会话 | **同意不能** |
| 1c | Codex 链怎么办：`-c sandbox_mode=read-only` 只是 shell 沙箱（不写盘不联网，仍能跑只读命令），没有可验证的零工具面 | 先按 B / 另起无工具的独立响应入口 | Codex 链先 B | 只读沙箱不算 R1 | **同意 Codex 链先 B** |
| 2 | **chat 默认态**：无绑定上下文（A、私聊、unbind 之后）不再拒，按普通问答处理；unbind = 退回 chat；私聊不再走待认领匹配 | 加 / 不加 | 加（改 goal 成四层） | 未评审 | **同意加**；goal 修订稿见 §6b |
| 3 | 保留项第 5 条：暂停（unbind）改单向 —— 只关入站、出站照发 | 改 / 不改 | 若加 chat，此条自然定：unbind = 退回 chat，出站汇报作为 chat 的一个开关（默认继续发） | — | **同意随 chat 定** |
| 4 | R0 在 Dialogue 下只给 owner（operator / participant 连 `/feishu-status` 都拒） | 开 / 不开 | 可开给 operator（它本来就是「信任的人」的角色位） | — | **同意开给 operator**（交叉表 R0 加 operator，随 chat 那次改） |
| 5 | 装不装：第 1 层 main 8c5cedc（PR #92，已合并、已评审） | 装 / 不装 | 装（只加角色表与登记入口，只有 owner 时行为不变） | 已放行 | **已装**（Frank「装 8c5cedc」，运行时 942c01acbdbcf86d，两条链） |
| 6 | FR-2.6 多群独立订阅：没有真实多群样本，`subscribe` 写入口不开 | 找一个真实分发群做样本 / 继续不开 | 等有第二个群再做 | — | 挂起 |

### 6a. R1 执行边界的简化方案（方案 A 简化版）

完整版 A 要分叉会话、管 participant 的独立 transcript、处理现场会话与分叉的并存 —— 三块都不小。既然 1b 已定「participant 不看 owner 上下文」，最简单的确定性边界是：

| 项 | 简化版 | 代价 | 以后可加 |
|---|---|---|---|
| 非 owner 的 R1（Claude 链） | 起一个**零工具、无历史**的一次性回合：`claude -p "<正文>" --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'`，工作目录仍是项目根（模型知道是哪个项目，但没有工具就读不了文件）；结果走现有 hand-off 守望者发回话题 | participant 的每条消息互相没有记忆（第二句不知道第一句） | 给每个话题 × 发送者一条独立的 participant 会话（`--resume`，仍零工具），就有连续对话 |
| 现场会话 | 完全不碰：不转发、不分叉 | 你在终端里看不到 participant 说了什么（飞书话题里看得到） | 出站卡片里标「participant 回合」 |
| runRequest | 带 `capability: reply_only` 或 `full`，投递层只看这个字段；owner 的一切照旧 full | — | — |
| Codex 链 | R1 改回 owner-only（表里一行）；participant 在 Codex 话题里的对话被拒并回执 | Codex 话题暂时没有 participant 对话 | Codex CLI 出现可验证的零工具面再开 |
| 测试 | 假 `claude` 二进制逐字断言参数（有 `--tools ""`、无 `--resume` / `--continue`）；真入口断言 participant 的 R1 不再起 forwarder | — | — |

实现量：一个新启动器（约 40 行）+ runRequest 一个字段 + 交叉表 Codex 行一处 + 两条链测试。**不需要**改会话文件、锁协议或安装器。

### 6b. goal 修订稿（chat 默认态 + R1 边界，接在原三层之后）

- 第 4 层 R1 边界：runRequest 带 capability；非 owner 的 R1 走零工具一次性回合（§6a）；Codex 链 R1 owner-only；R0 开给 operator；判据仍只有一份、每条新判据有变异转红、两条链行为一致。
- 第 5 层 chat 默认态：无绑定上下文（刚装桥、私聊、unbind 之后）不再拒 —— ordinary 按 chat 处理（零工具一次性回合，owner 也一样，因为没有目标会话可投）；`/feishu-bind` 才进绑定流程；unbind = 退回 chat；私聊不再走待认领匹配；交叉表加 chat 行；状态页第 4 层显示 chat。
- 判据：owner 在任何上下文至少能得到 chat 回复（Frank 的原则）；已绑定话题的行为与今天一致；文档同步（FR-4 / FR-7、contract、README 命令表、这份文档）；每层收口停一下问装不装。

## 7. 实现状态一览

| 层 / 件 | 分支 / PR | HEAD | 评审 | 合并 | 安装 |
|---|---|---|---|---|---|
| 第 1 层 角色表 | PR #92 `feat/sender-roles` | main 8c5cedc | 五轮，放行 | 已合并 | **已装** 942c01acbdbcf86d（两条链，2026-08-29） |
| 第 2 层 风险 × 角色 × 模式 | PR #93 `feat/authorize-layer` | cfa55f0 | 两轮；P1-2 / P2 已返修，P1-1（R1 边界）按 §6a 做 | 未合并 | — |
| 第 3 层 近似命中收边 | PR #94 `feat/malformed-control`（base 是 #93 的分支） | a1b0b69 → 第 4 轮返修中 | 三轮：意图联合、拒绝事务可恢复、盘点四态、维护入口已认可；锁内核心唯一 + CLAUDE.md subscribe 措辞在第 4 轮 | 未合并 | — |
| chat 默认态 | — | — | — | — | Frank 同意，goal 修订稿见 §6b |

## 8. 名词对照（防止同名异义）

| 词 | 在这份文档里的意思 | 不是 |
|---|---|---|
| 订阅 | 第 2 层：平台把哪个群 / 私聊的事件投给智能体；本机只有一份投影 | 不是本机主动向平台"订阅"某个群的动作（没有这种代码） |
| 绑定 | 第 3 层：一个飞书话题 ↔ 一条本地会话 / 线程 | 不是"加了角色表"或"装了桥" |
| 模式 | 第 4 层：已绑定通道上的策略（Mapping / Dialogue） | 不是权限；权限是角色 × 等级 × 模式三者一起决定 |
| 控制命令 | 路由器当场执行、不经模型的精确形状（今天只有 `feishu-mode`） | bind / rotate 是投给模型的技能，不是路由器执行 |
| 授权 | R4：owner 用封闭措辞对上一条汇报里的对象点头 | 引用、转发、一大段话里顺带提到的字不算 |
