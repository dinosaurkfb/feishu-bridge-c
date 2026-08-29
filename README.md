# feishu-bridge

把飞书话题变成本机 Claude Code 或 Codex 长期任务的远程工作入口。

你可以在电脑前启动一个有完整项目上下文的 AI 任务，离开电脑后继续在手机飞书里下指令；
任务仍在原来的本机项目和长期会话中执行，受理状态与最终答复回到同一个话题。在电脑前
直接输入的本地回合，也会在回复顶部用小号灰字引用你的输入，留下完整回合记录。

```text
飞书话题里 @ 第三方智能体并下指令
  → Aily 把消息送到在线的本机
  → feishu-bridge 校验并续接唯一的 Claude/Codex 长期任务
  → 本机使用原项目、原上下文和原工具完成工作
  → 同一个智能体把最终答复发回原话题
```

它不是一个新的云端编程环境，也不是远程桌面。它解决的是：**怎样从飞书安全、准确地继续
本机已有的长期 AI 工作，而不丢上下文、不串项目、也不必守在电脑前等结果。**

## 它给用户带来什么

### 离开电脑也能继续长期任务

通勤、开会或外出时，直接在飞书话题里追加需求、纠正方向或询问结果。桥续接的是原来的
Claude/Codex 长期任务，不会另开一个缺少上下文的临时聊天。

### 一个话题群就是多项目工作台

一个飞书话题群可以同时承载多个项目或任务：每个根话题精确对应一条长期任务。你通过话题
选择工作对象，不需要每次重新说明仓库路径、背景和当前进度。同一个仓库里的多个 Codex task
也可以分别绑定。Codex 话题首行使用“项目名｜任务标题 · 稳定短码”，因此它们不仅在路由上
不会串线，在飞书列表里也能直接分辨。

### 结果主动回来，不必反复追问

任务完成后，最终答复自动回到发起指令的话题。你不需要回到终端查看，也不需要不断发送
“进展怎么样”。Claude/Codex 的最终答复、进展与风险会用 Card 2.0 卡片呈现：本机输入在最上，
以无背景的小号灰字引用，下面直接显示 Agent 回复；没有顶栏、彩色色块、分栏或底部元信息栏。
飞书会话列表直接预览本地输入或 Agent 回复的第一条有效内容。卡片只做轻量展示，不含按钮或
回调。发布失败时答复会留在本机 outbox，不会被假装成已经送达。

### 本地与移动端留下同一份完整上下文

当你在 Codex Desktop/CLI 或 Claude Code 里直接输入时，bridge 会把该轮**本地输入和 Agent
最终回复放进同一张卡片**发到绑定话题。以后只看飞书，也能知道当时问了什么、为什么会得到
这个结果。若这一轮本来就是从飞书话题发起，输入原文已经存在于话题中，结果卡片只展示回复，
不会让机器人把你的消息复读一遍。

### 飞书里的身份与本机任务保持一致

推荐使用单智能体方案：你在话题里 @ 的是谁，受理指令、发布结果的就是谁。Codex 方案从配置
层强制使用单一 M5Codex，避免同一个任务在飞书里出现两个机器人身份。

### 可控，而不是“能转发就算成功”

入站必须同时通过授权发送者、真实 mention、目标群、根话题、Aily session、消息时效和幂等
校验；任一关键配置不确定就拒绝执行。每个 claim、运行结果和发布状态都保存在 Git 之外，便于
定位失败，同时避免把本机 thread locator 或凭据提交到项目仓库。

### 适合与不适合

它适合已经在本机长期使用 Claude Code/Codex、希望从手机继续工作，或需要用一个话题群管理
多条并行任务的人。当前机器模板只授权一个明确的 Aily user id 驱动本机任务，因此它首先是
**个人可信工作入口**，不是面向陌生群成员开放的多租户机器人平台。

如果你需要的是电脑关机后仍能执行的云端 agent、普通无话题群里的模糊路由、多人分级授权，
或无需 Aily 的纯 webhook 服务，这个项目目前并不适合。

## 使用环境：Aily、第三方智能体和话题群分别做什么

这套工具跨越飞书、Aily 和本机 AI 运行时。三者缺一不可。

| 角色 | 用户看到的东西 | 在链路中的职责 |
|---|---|---|
| 飞书话题群 | 一个开启话题能力的群组 | 承载多个项目话题；每个根话题是独立的路由和沟通边界 |
| 第三方智能体 | 群成员中的 M5Codex 或 M5Claude（见下方命名说明） | 接收真实 @mention、返回秒级受理消息，并以同一身份发布最终答复 |
| Aily（现也称「豆包工作伙伴」） | 智能体平台及本机 `aily-cli` runtime/daemon | 把飞书事件和可信事件信封交给本机 adapter；维持第三方智能体与本机的在线连接 |
| 本机 adapter | Aily 的 `codex-local` 或 `claude-code-local` 类型运行环境 | 调起对应的 Codex/Claude 能力和入站技能 |
| lark-cli | 本机上的飞书 OpenAPI 命令行客户端 | 由 bridge 调用，创建或编辑根话题，并把最终答复精确发布回原话题；当前不能由 `aily-cli` 替代 |
| feishu-bridge | 本仓库安装的脚本、hooks、skills 和 registry | 做确定性校验、话题映射、精确续接、终局判断和答复发布 |
| 长期任务 | Codex task/thread，或 Claude 项目会话 | 保留项目上下文，实际读取代码、调用工具并完成工作 |

> **关于名字**
>
> - **M5Codex / M5Claude 是本项目初始开发者给自己那两个第三方 Aily 智能体起的名字**，
>   不是平台内置的东西。你自己建智能体时叫什么都可以，全文出现这两个名字的地方，
>   换成你自己那个即可 —— 代码不认名字，只认配置里的 app id、agent uid 和 open id。
> - **Aily 现在也叫「豆包工作伙伴」。**本文沿用 Aily，因为命令行工具和各处标识仍是
>   `aily-cli`、`AILY_CLI_*`、`agent_...`。看到「豆包工作伙伴」时，指的是同一个平台。

“第三方智能体”不是远端替你重新做一遍工作的聊天机器人。它主要承担**运输与展示**：真正的
项目执行仍发生在你自己的电脑上，由已经绑定的 Claude/Codex 长期任务完成。

```text
手机/桌面飞书
  └─ 话题群中的第三方智能体（示例名 M5Codex / M5Claude，你自己命名）
       └─ Aily 平台与本机 aily-cli daemon
            └─ codex-local / claude-code-local adapter
                 └─ feishu-bridge
                      └─ 已绑定的本机长期任务与项目文件
```

### 最小部署条件

- 一台保持在线且不会在任务中途休眠的本地宿主机；当前完整链路已在 macOS 实机验证，脚本要求
  POSIX 环境，Linux 可在依赖齐全后部署，原生 Windows 尚未完成本项目的端到端验证；
- Node.js 22 或更高；
- Codex Desktop/CLI 或 Claude Code，选择其中一套运行时；
- 已登录且 daemon 在线的 `aily-cli`；
- 已安装且可使用第三方智能体飞书应用凭据的 `lark-cli`；它负责话题创建、消息编辑和最终答复
  发布，当前是完整双向链路的必需组件；
- 一个飞书话题群，以及群内一个对应运行时的 Aily 第三方智能体；
- 第三方智能体背后的飞书应用具备接收 mention、创建话题和发送消息所需权限；
- 能访问所选 AI 运行时、Aily 和飞书服务的网络环境。

宿主机不要求安装飞书桌面客户端。人可以在手机、另一台电脑或网页飞书里操作；宿主机只需
保持 `aily-cli`、所选 AI 运行时、`lark-cli` 和 bridge 在线。`aily-cli` 负责把 mention 事件送入
本机，`lark-cli` 负责 bridge 对飞书 OpenAPI 的确定性写入，两者职责不同。

本机离线、休眠或 Aily daemon 不在线时，飞书无法推进本机任务。本仓库不会把整份代码仓库
上传到飞书，但你从飞书或本机运行时提交的文本指令、受理状态和最终答复会经过飞书/Aily 链路。
本地输入同步的是 hooks 收到的文本，不会复制附件文件本体。

### 哪些需要人工准备，哪些由工具完成

首次部署时，用户仍需手工创建或选择飞书话题群，在 Aily/飞书平台创建对应 runtime 的第三方
智能体，把它加入群，并核对应用、agent、群和授权发送者标识。仓库不会代替用户创建 Aily
账号、飞书应用或授权关系。

机器模板和 hooks/skills 安装完成后，具体项目或 Codex task 的根话题、registry 记录、消息
claim、长期任务续接与最终答复发布都由 bridge 管理。新接一条任务时不需要手写项目 locator。

## 核心使用模型

### 绑定关系

```text
一个飞书话题群
├── 话题 A  ↔  项目 A 的长期任务
├── 话题 B  ↔  项目 B 的长期任务
└── 话题 C  ↔  同一仓库里的另一条 Codex task
```

- 一个根话题只绑定一条精确长期任务；
- 一条长期任务不会同时认领多个活动话题；
- 路由依据是已登记的 topic/session/thread，不根据标题、最近打开的窗口或 `--last` 猜测；
- Codex 话题标题只用于识别：优先采用 Desktop 已有的用户可见 task 标题，并始终附带稳定短码；
  取不到标题时回退为“项目名｜任务 短码”，不会暴露完整 thread locator；
- 新话题创建后需要真实 @ 智能体一次，因为 Aily session 只有第一条消息到达时才产生；
- 多个 Codex 话题同时等待首次绑定时，bridge 从 Aily 附带的根消息引用中读取绑定短码，精确
  选择对应 task；绑定完成后改用 session 映射，标题与短码不再参与日常路由；
- 完成首次绑定后，mention 后的正文就是指令，不要求 `→Codex` 或 `→Claude` 关键字。

### 入站为什么是「hook + 分发器」两层

**hook 保证进运输层。**技能是软约束，实测会被绕过：M5Claude 最近一份会话记录里，
三次入站有两次没走技能，模型凭上下文直接把命令跑出来；还有一次它自己判了正文前缀、
拒绝了一条合法消息，而那个前缀早已退役。hook 是 Claude Code 必然执行的，模型没有
不执行的余地。Codex 使用同语义的 UserPromptSubmit hook。**每个 runtime 的 hook 和技能都指向
自己的薄 dispatcher 入口**，绝不各指一套。

**分发器保证选对路。**本机可能有多个消费者（本仓库、cc2cd……）。靠外层包内层也能跑，
但入口只能有一个（谁后装谁赢）、信封被取两遍（取信封带 4 次重试 ≤2.4s，翻倍就顶到
秒级回执的上限，且两次可能取到不同的事件）、归属逻辑住在最外层。

改成路由表之后：加一个消费者 = 在对应 runtime 的 Git 外 bridge home 路由表中加一行
`session → route`。选路只看 Canonical Event 的可信字段，模型和正文都不参与。Claude 与 Codex
共用 dispatcher 核心；各自的薄入口只提供 endpoint identity、默认 handler 和状态目录。

### 一条消息的完整生命周期

```text
1. 用户在已绑定话题真实 @M5Codex / @M5Claude
2. Aily 在本机启动第三方智能体回合，并提供事件信封
3. UserPromptSubmit hook 在模型看到正文**之前**注入「本回合只准跑分发器」
4. 分发器验调用方 agent、**只取一次**信封、构造无损 Canonical Event，再按可信字段选路
5. 公共入站核心校验身份、发送者、群、话题、session、时效并取得幂等 claim
6. 当前 Interaction Policy（Mapping 或 Dialogue）返回明确处置；受理时生成不含
   session/thread locator 的统一 `runRequest`
7. 飞书先收到“已受理”或明确拒绝原因（分发器**一个字都不加**，原样透出 handler 的话）
8. runtime adapter 续接精确长期任务，任务使用原上下文执行指令
9. hooks/watcher 确认真实终局并把最终答复写入 outbox
10. 同一个第三方智能体把答复发布回原话题；Claude/Codex 结果以只读 Card 2.0 卡片呈现
```

“已受理”只表示指令已经通过路由并交给目标任务，不等于工作已经完成。只有观察到运行时的
真实完成事件和非空最终输出，bridge 才允许把该回合作为完成结果发布。

## 选择运行时并开始安装

Claude Code 与 Codex 共用 envelope、selector、claim、outbox 和飞书发布器，但会话模型、hooks
和续接方式不同。请只执行自己所用运行时的安装指南。

| 运行时 | 飞书智能体 | 绑定单位 | 新用户入口 |
|---|---|---|---|
| Codex Desktop/CLI | Aily `codex-local` 第三方智能体，本文示例名 M5Codex | 精确 Codex task/thread | **[CODEX_SETUP.md](CODEX_SETUP.md)** |
| Claude Code | Aily `claude-code-local` 第三方智能体，本文示例名 M5Claude | 项目（默认），或项目里的某一条会话 | **[SETUP.md](SETUP.md)** |

### Codex 快速路线

```bash
git clone https://github.com/dinosaurkfb/feishu-bridge-c.git
cd feishu-bridge-c
npm test
npm run doctor:codex
npm run install:codex:preview
```

随后按 [CODEX_SETUP.md](CODEX_SETUP.md) 填写机器级模板并安装 hooks/skills。在需要接入的
Codex task 中运行：

```text
$feishu-bind
```

`$feishu-bind` 本身就是本次绑定授权，bridge 会直接创建话题并登记**当前精确 task**，不再
要求回复第二次“确认”。根话题首行会同时展示项目名、Codex task 标题和稳定短码；同一仓库
里的多个长期 task 不会再显示成同一个标题。去新话题真实 `@M5Codex` 一次完成首次 Aily
session 绑定。日常还可以使用：

| 命令 | Codex | Claude | 作用 |
|---|---|---|---|
| status | `$feishu-status` | `/feishu-status` | 只读查看接入、入站绑定和待发状态 |
| unbind | `$feishu-unbind` | `/feishu-unbind` | 可恢复地暂停，不删话题、映射或历史 |
| 发送者角色（第 2 层） | `node scripts/register-sender.mjs --template <该链 chain-config.json> --open-id <数字> --role operator\|participant [--apply]` | 同左 | 往链路模板的 `senders` 登记 / 移除一个人（owner 只有一个，就是 `frank_sender_id`，不在这里登记）；默认预览，写入要 owner 逐次授权；`--remove` 移除。第 1 层只登记与显示（`/feishu-subscribe`、状态页第 2 层「发送者角色」只出数量），入站判定仍只放 owner，角色 × 风险 × 模式的判定是第 2 层 |
| bind | `$feishu-bind` | `/feishu-bind` | 首次接入，或恢复已暂停的原话题连接 |
| rotate | `$feishu-rotate` | `/feishu-rotate` | 为同一 binding 创建下一话题代际；旧话题保留为历史（仍可下指令，回复回原话题） |
| mode（飞书侧） | 正文恰为 `$feishu-mode dialogue` / `mapping` | 正文恰为 `/feishu-mode dialogue` / `mapping` | 入站路由器当场切换交互模式并回执，不投递给会话（2026-08-28 起）。"恰为"按词算：不可见字符、不换行/全角空格、全角斜杠先折叠，多一个字仍走普通路径 |
| mode | `$feishu-mode [dialogue\|mapping]` | `/feishu-mode [dialogue\|mapping]` | 无参数只读查看；显式切换当前 binding 的交互策略 |

飞书侧的模式切换是一笔**可恢复的控制事务**：意图随 claim 持久化 → 幂等执行 → 写 `<key>.consumed.json`
（封闭形状；切换失败则写 `<key>.failed.json`，同样封闭，**不是 run 终态**）。账本盘点会报
`consumed_unreadable` / `consumed_in_flight` / `consumed_intent_mismatch` / `control_failed_unreadable` / `control_conflict`
（failed 与 consumed 并存）。同一事件的运输层重放按记录重出回执；飞书重发是新消息，补不了旧账 —— 补账走维护入口
`node scripts/repair-control-claim.mjs --project <root> --key <key> [--apply]`
（Codex 侧 `node scripts/codex/repair-control-claim.mjs --thread-id <id> --key <key> [--apply]`）：
只接受属于当前绑定 / task 的 claim（Claude 侧按 claim 的会话定位选项目级或会话级绑定；身份在写锁内用锁内刚读出的记录重新推导后复核），
只对 in_flight / 终态损坏 / 失败记录损坏三种态续做；两份终态并存（不论好坏）一律 conflict 交人看；恢复损坏的 failed 前先把它改名隔离成
`<key>.failed.quarantined.<pid>.<ts>`（账本报 `control_failed_quarantined`，人看完再删）；临时残骸清不掉、或目录枚举不了（说不清）时退出 1，第二次运行也一样。
每一笔的执行 / 重放 / 维护恢复都在同一把逐 key 事务锁（`<key>.control.lock`，复用 registry.mjs 已上线的 symlink 锁协议：payload 即 owner，释放在 reap 锁里核 token，与陈旧回收串行）里判定与动手，隔离改名也在锁内；
锁内状态对所有调用者权威（晚到的首次调用者撞见已闭合的记录只重出回执，不再执行）；释放不是自己的实例不删、reap 段忙 / owner 读不出 / 锁已不在都不吞 —— 以 lockUncleared 进入结果（维护入口退出 1，两条链成功与失败回执都写明）；
运输层重放遇到受验的 failed 按记录重出失败回执、不再执行（要再切就重新发一条）；两份终态并存 → control_conflict，不执行。
锁原语里的文件操作抛错在 withControlLock 这层兜住：取得阶段 → control_lock_unavailable（回调没跑），释放阶段 → lockUncleared。
**装了 ≠ 在跑（issue #88）**：入站由机器级路由表 `~/.claude/feishu-bridge/routes.json`（Codex 链 `~/.codex/feishu-bridge/routes.json`）的默认路由决定，
表非空时分发器不会回退运行时自带的处理器。`doctor` 第 ⑦ 项与状态页第 1 层「入站处理器」都按 `defaultRouteHandler` 六态报
（runtime / no_routes ✓；outside / no_default / wrong_default ✗；unreadable 说不清）；判定只认能解析成普通文件的 realpath，且要与该链预期的 inbound handler 对账（缺失文件、指向外部的符号链接、同目录别的文件都不算）；
默认路由的 id 也要对（Claude `self` / Codex `codex`）：别的路由被标成默认是独立状态 `wrong_default`，不给自动恢复；
改回用 `node scripts/register-route.mjs --restore-default --routes <该链的 routes.json> --handler <runtime/current 下的 inbound.mjs> --id <self|codex> [--apply]`
（切权威路由，Frank 逐次授权；先备份整张表，只动默认那条）。
账本按封闭形状分族盘点锁家族：主锁 control_lock_held（不要手删，协议会回收）、reap 段锁 control_reap_lock（残骸交 repair-publish-lock）、
维护锁 control_maint_lock（人确认后手删）、.reaped-<uuid> / .reap.quarantine-<…> 残骸（可直接删）；别的后缀是 unrecognized_entry。

两边命令同名。差别只在绑定单位：Codex 绑一个精确 task，Claude 默认绑项目、
也可以用 `bind-session` 让某一条会话单独占一个话题。

本版本实际安装上表五项。`bind` 仍是把当前精确本地 target 接入一个话题的兼容入口：首次
接入时，它同时物化现有单群配置下的订阅授权快照，但不等同于未来可独立管理的 Subscription。
架构路线图中的 `$feishu-connect` 已确认**不做**（Aily 侧的连接是被动的，本机没有「发起」这个动作；
本机那一半归端点自检）。`/feishu-subscribe` / `$feishu-subscribe` **两条链都可用，只读**。
写入口的现状：发送者角色表可以登记（`register-sender.mjs`，写入需 owner 逐次授权）；独立订阅的增删仍不开放，
原因只有 FR-2.6（多订阅时首次认领的歧义拒绝未经真实样本验证）—— FR-2.5 的授权快照同步链路已经完成。
不能把需求文档里的建议命令误认为当前可用能力。详见
[Agent 增强需求](docs/requirements/agent-enhancement-requirements.md#fr-7-显式控制面)。

`mode` 默认只读。显式切到 `dialogue` 后，同一 binding 的后续人类消息共享一个有界 Dialogue：
v1 只支持一名授权人类和当前精确本地 task 这个主持者，严格串行，默认最多 12 轮、2 小时、
12 个资源单位。Agent 回复不会自动变成下一轮输入，也不会形成 mention 循环。切回 `mapping` 会
人工中止尚未结束的 Dialogue，但保留历史。详见
[Dialogue Policy v1](docs/implementation/dialogue-policy-v1.md)。

下一阶段的多 Agent Dialogue 仍处于未安装候选：Slice A 提供确定性串行 planner，Slice B1 仅在显式
开关下旁路比较现有 binding 授权并写 Git 外证据，Slice B2a 只收集 Aily channel locator 的脱敏一致性
探针；在可信 chat locator、自动轮转与授权同步验收前不会切流或启动第二个 Agent。实现与门禁见
[Dialogue Binding Authorization Shadow](docs/implementation/dialogue-binding-authorization-shadow.md) ·
[Chat Scope Probe](docs/implementation/dialogue-chat-scope-probe.md)。

运行 `rotate` 后，bridge 先创建一个 `pending` 新话题。首次真实 mention 完成认领前，旧话题仍是
唯一 active；认领成功时，新旧状态在同一份 Git 外 binding 文档的一次原子替换中切换，新话题
成为 active，旧话题成为 read-only。轮转前已经受理的飞书请求仍回复原话题；本地回合在形成
outbox 时冻结当时的 active 代际。待认领**不过期**（2026-08-28 起）：等满 72 小时无人认领在该话题下提醒一次，之后每 7 天再提醒一次，也可用对应 rotate CLI 的
`--cancel --apply` 显式取消；两者都不会删除话题历史。实现契约见
[Topic Generation 生命周期](docs/implementation/topic-generation-lifecycle.md)。

每个 active 代际还独立统计有效业务消息：已受理的人类指令和已送达的 Agent 最终回复各计 1，
本地“输入 + 回复”配对卡计 2；绑定握手、系统回执和普通进展不计。默认累计到 50 条时自动创建
下一代 pending 话题，但不会自动切换；仍需在新话题真实 mention 一次，旧话题才变为 read-only。
旧 binding 从升级后的首次新业务事件起计，不回扫历史，安装本身不会触发轮转。

Codex 入站通过 `codex exec resume <精确 thread>` 向原 task 追加完整用户回合。回合会持久化，
但已经打开的 Codex Desktop 页面不保证实时绘制另一个 CLI 进程追加的事件；切换 task 再返回
或重新打开后，会从持久历史中显示。这是客户端刷新边界，不是投递到了另一条任务。

Claude/Codex 卡片只用于绑定完成后的回合记录和结果回复。首次建话题的根消息及接入状态继续
使用文本，因为首次 Aily 绑定要从根消息引用中读取六位短码；卡片不会改变话题 ID、session
映射、入站规则、outbox 或自动发布资格。本机发起的回合显示“你的输入 + Agent 回复”，飞书
发起的回合只显示回复；本机输入以顶部灰色引用呈现，Agent 回复保持单一正文区。超出卡片正文
上限的内容会截断，完整事件仍保存在本机 outbox/run 记录中。

### Claude Code 快速路线

Claude 机器级环境安装完成后，在目标项目目录运行 `/init`。hook 会先让原生初始化完整完成，
然后提示你显式运行 `/feishu-bind`；`/init` 本身、按钮选择或自然语言回答都不会创建绑定。
运行 `/feishu-bind` 后会创建根话题，再去话题真实 `@M5Claude` 一次完成首次 Aily session 绑定。

也可以使用等价的手动流程：

```bash
node scripts/bind-preview.mjs --project ~/your-project
node scripts/bind-project.mjs --project ~/your-project --apply
```

**同一个项目里的多条工作线**：默认一个项目一个话题，项目里所有会话共用。若某条线要
单独占一个话题（非纯代码的工作里很常见：一条查资料、一条写稿、一条整理数据），
在**那条线自己的会话里**跑 `node scripts/bind-session.mjs --apply`。

项目级绑定是默认和兜底，会话级是加法 —— 没单独绑过的会话行为一字不变。绑定的会话
关掉之后，入站会用 `claude --resume` 精确续起那条线；连记录都没有才如实拒绝，
**绝不把指令投给另一条你没指定的线**。

完整的飞书/Aily 准备、机器模板、安装、验证和排障步骤见 [SETUP.md](SETUP.md)，当前运行状态
与历史问题见 [STATE.md](STATE.md)。

## 日常使用

安装与首次绑定只做一次。之后的使用方式对两套 runtime 基本一致：

1. 打开对应项目的飞书话题；
2. 真实 @ 该 runtime 的第三方智能体，mention 后直接写指令；
3. 先看秒级受理或拒绝说明；
4. 继续做别的事，等待最终答复自动回到原话题；
5. 在电脑前正常使用 Claude/Codex 时，本地输入与该轮最终回复会合并成一张卡片同步到绑定话题。

适合的场景包括：离开工位后继续代码任务、让长时间测试完成后主动通知、在多个项目间按话题
切换、从手机补充需求，以及把某条长期任务的过程集中留在一个可检索的话题里。

## 安全、可靠性与明确边界

- **真实 mention 才是指令。**手打“@M5Codex”文本不构成 mention，摘要消息也不会触发入站。
- **授权发送者是强边界。**机器模板中的 Aily user id 决定谁能驱动本机任务，必须逐字核对。
- **精确路由。**Codex 禁止 `--last`；Claude 也不会只按目录或标题猜活动会话。
- **fail-closed。**配置缺失、身份冲突、话题不匹配、消息过期或目标繁忙时明确拒绝，不降级猜测。
- **受理不冒充完成。**只有目标运行真实完成且产生非空最终输出，才发布完成答复。
- **发送成功才标记已发。**失败答复留在 outbox；历史积压不会因升级自动补发。
- **敏感状态不进 Git。**身份、locator、claim、receipt、run 和 outbox 保存在用户目录或
  `.runtime-data/`，均被排除提交。
- **不主动监听、不自动重放。**用户的真实 mention 启动一次入站；失败消息需要发送一条新指令，
  除非用户明确授权人工恢复历史 outbox。
- **本机权限仍然有效。**bridge 不绕过 Claude/Codex 的 sandbox、审批或 hook trust；它只是把
  一条经过校验的用户消息交给目标任务。

当前稳定路径依赖在线本机与 Aily。Codex 正在运行的 Desktop turn 命中活动 lease 时会返回 busy，
不会从另一个 CLI 进程强行 steer；Aily 外层还可能有首语义事件超时。每台新机器都必须做一次
真实飞书端到端验证，本地测试全绿不能替代这一步。

## 实现结构

```text
scripts/
  envelope / selector / claim   Aily 信封、确定性选择器与原子认领
  mapping-policy               公共 Mapping Policy 与 runtime-neutral runRequest
  interaction-policy           公共 Mapping/Dialogue 状态、预算、终局与 runRequest
  inbound / inbound-route       Claude 入站与项目路由
  outbox / outbound             可靠答复队列与飞书发布
  bind-* / registry / binding   话题创建、登记和生命周期
  codex/                        Codex 精确 task 状态、hooks、续接、watcher 与控制命令

skills/
  M5Claude / M5Codex 入站技能，以及 Codex task 控制技能的安装源

references/
  机器级链路模板示例；真实身份与 locator 不放在仓库里

~/.claude/feishu-bridge/
  Claude 机器级模板、项目 registry、日志和出站状态

~/.codex/feishu-bridge/
  Codex 单 M5Codex 模板、精确 task registry、claim、receipt、run 和 outbox
```

两套 runtime 共用确定性核心，但各自维护运行时相关的会话发现与续接：

- Claude 优先把消息投递给项目内活着的交互会话；没有现场时才后台 `--continue`；
- Codex 使用精确 thread id 执行 `codex exec resume`，并通过严格 watcher 判断后台回合终局；
- 两套安装入口、用户状态目录和技能彼此独立，新用户不要把两份安装步骤混着执行。

## 开发与验证

```bash
npm test                         # Claude 336 项 + Codex adapter 79 项回归
npm run test:claude              # 只运行 Claude 基线
npm run test:codex               # 只运行 Codex adapter
npm run doctor:codex             # Codex 机器级只读自检；不写配置、不联网
npm run install:codex:preview    # 预览 Codex 安装会修改什么
```

测试和 doctor 只证明代码与本机组件状态，不会创建话题、发送飞书消息，也不能替代一次真实
`@M5Codex` / `@M5Claude` 的端到端验收。

## 两条链路的共用边界

`scripts/` 是底座，`scripts/codex/` 是 Codex 适配层。依赖是**单向**的：适配层从底座
import 当前快照列出的共用模块，底座不反向依赖它（有测试守着方向）。

这意味着快照里的模块是真正的接触面 —— 任何一方改它，都可能悄悄改掉另一方依赖的东西。
所以有三层护栏，从便宜到贵：

| 护栏 | 抓什么 | 成本 |
|---|---|---|
| `npm run contract` | 共用模块的**导出面**变了（多了、少了、改名） | 机械，覆盖快照中的全部模块 |
| 行为契约测试 | 共用模块的**语义**变了（判重算法、文件命名、字段默认值） | 人工，只覆盖想得到的 |
| `npm test` 同时跑两套 | 一方真的弄坏了另一方 | 已经是默认行为 |

`npm run contract` 失败**不代表改错了**。它代表共用面变了而没人过目 —— 确认这次
扩大/缩小是有意的之后，跑 `npm run contract:accept` 认下来，快照的 diff 会进评审。

**最值得停下来看的是「导出变多」**：它通常意味着某一方把自己的概念塞进了共用代码。
比如 `markPublishEligibleByEventKey` 是纯 Codex 概念，现在住在共用的 `outbox.mjs` 里 ——
这不一定错，但应该是个有人点头的决定，而不是一次悄悄的增生。

> 顺带一条更根本的：**最好的契约是不需要契约。**运行时特有的概念应该待在自己的
> 适配层里，共用模块只放两边真正共有的东西。护栏是给「确实共有」的那部分用的，
> 不是用来托管一方的私货。

## 文档导航

| 你想做什么 | 文档 |
|---|---|
| 理解下一阶段的产品目标、模式和验收标准 | [第三方智能体增强：产品需求文档](docs/requirements/agent-enhancement-requirements.md) |
| 评审重构边界、实体模型、路由和生命周期 | [第三方智能体增强：架构契约](docs/architecture/agent-enhancement-contract.md) |
| 评审现有映射模式如何迁移到公共 Policy Handler | [Mapping Policy Handler 迁移](docs/implementation/mapping-policy-handler.md) |
| 理解话题轮转、代际切换与待认领（不过期、按周期提醒） | [Topic Generation 生命周期](docs/implementation/topic-generation-lifecycle.md) |
| 理解 Dialogue v1 的串行轮次、预算与停止契约 | [Dialogue Policy v1](docs/implementation/dialogue-policy-v1.md) |
| 理解多 Agent Dialogue 的参与者授权、串行 planner 与切流门禁 | [Dialogue Participant & Planner 契约](docs/implementation/dialogue-participant-planner-contract.md) |
| 只读汇总 Dialogue shadow 真实证据与未满足门禁 | [Dialogue Shadow Readiness Audit](docs/implementation/dialogue-shadow-readiness-audit.md) |
| 从零安装 Codex 飞书桥 | [CODEX_SETUP.md](CODEX_SETUP.md) |
| 从零安装 Claude Code 飞书桥 | [SETUP.md](SETUP.md) |
| 查看 Claude 当前运行状态与历史问题 | [STATE.md](STATE.md) |
| 理解机器级配置字段 | [references/chain-config.example.json](references/chain-config.example.json) |

## TODO

1. **支持多个人类员工与多个 Agent 协作。**允许多个经过授权的人类员工在同一个飞书话题群中，
   共同管理同一个 Agent，或分别管理不同 Agent。实现时需要补齐人员级身份绑定、用户—Agent—话题
   授权矩阵、并发指令冲突处理、操作审计归属和权限撤销机制，不能继续沿用当前单一授权发送者模型。
