# feishu-bridge

把飞书话题变成本机 Claude Code 或 Codex 长期任务的远程工作入口。

你可以在电脑前启动一个有完整项目上下文的 AI 任务，离开电脑后继续在手机飞书里下指令；
任务仍在原来的本机项目和长期会话中执行，受理状态与最终答复回到同一个话题。

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
也可以分别绑定，不会因为目录相同而混在一起。

### 结果主动回来，不必反复追问

任务完成后，最终答复自动回到发起指令的话题。你不需要回到终端查看，也不需要不断发送
“进展怎么样”。发布失败时答复会留在本机 outbox，不会被假装成已经送达。

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
| 第三方智能体 | 群成员中的 M5Codex 或 M5Claude | 接收真实 @mention、返回秒级受理消息，并以同一身份发布最终答复 |
| Aily | 智能体平台及本机 `aily-cli` runtime/daemon | 把飞书事件和可信事件信封交给本机 adapter；维持第三方智能体与本机的在线连接 |
| 本机 adapter | Aily 的 `codex-local` 或 `claude-code-local` 类型运行环境 | 调起对应的 Codex/Claude 能力和入站技能 |
| feishu-bridge | 本仓库安装的脚本、hooks、skills 和 registry | 做确定性校验、话题映射、精确续接、终局判断和答复发布 |
| 长期任务 | Codex task/thread，或 Claude 项目会话 | 保留项目上下文，实际读取代码、调用工具并完成工作 |

“第三方智能体”不是远端替你重新做一遍工作的聊天机器人。它主要承担**运输与展示**：真正的
项目执行仍发生在你自己的电脑上，由已经绑定的 Claude/Codex 长期任务完成。

```text
手机/桌面飞书
  └─ 话题群中的 M5Codex 或 M5Claude（第三方智能体）
       └─ Aily 平台与本机 aily-cli daemon
            └─ codex-local / claude-code-local adapter
                 └─ feishu-bridge
                      └─ 已绑定的本机长期任务与项目文件
```

### 最小部署条件

- 一台保持在线且不会在任务中途休眠的 macOS 电脑；
- Node.js 22 或更高；
- Codex Desktop/CLI 或 Claude Code，选择其中一套运行时；
- 已登录且 daemon 在线的 `aily-cli`；
- 已安装的 `lark-cli`；
- 一个飞书话题群，以及群内一个对应运行时的 Aily 第三方智能体；
- 第三方智能体背后的飞书应用具备接收 mention、创建话题和发送消息所需权限；
- 能访问所选 AI 运行时、Aily 和飞书服务的网络环境。

本机离线、休眠或 Aily daemon 不在线时，飞书无法推进本机任务。本仓库不会把整份代码仓库
上传到飞书，但你发送的指令、受理状态和最终答复会经过飞书/Aily 链路。

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
- 新话题创建后需要真实 @ 智能体一次，因为 Aily session 只有第一条消息到达时才产生；
- 完成首次绑定后，mention 后的正文就是指令，不要求 `→Codex` 或 `→Claude` 关键字。

### 一条消息的完整生命周期

```text
1. 用户在已绑定话题真实 @M5Codex / @M5Claude
2. Aily 在本机启动第三方智能体回合，并提供事件信封
3. bridge 校验身份、发送者、群、话题、session、时效和幂等 claim
4. 飞书先收到“已受理”或明确拒绝原因
5. bridge 续接精确长期任务，任务使用原上下文执行指令
6. hooks/watcher 确认真实终局并把最终答复写入 outbox
7. 同一个第三方智能体把答复发布回原话题
```

“已受理”只表示指令已经通过路由并交给目标任务，不等于工作已经完成。只有观察到运行时的
真实完成事件和非空最终输出，bridge 才允许把该回合作为完成结果发布。

## 选择运行时并开始安装

Claude Code 与 Codex 共用 envelope、selector、claim、outbox 和飞书发布器，但会话模型、hooks
和续接方式不同。请只执行自己所用运行时的安装指南。

| 运行时 | 飞书智能体 | 绑定单位 | 新用户入口 |
|---|---|---|---|
| Codex Desktop/CLI | Aily `codex-local` 第三方智能体，文档中称 M5Codex | 精确 Codex task/thread | **[CODEX_SETUP.md](CODEX_SETUP.md)** |
| Claude Code | Aily `claude-code-local` 第三方智能体，文档中称 M5Claude | 项目及其可续接 Claude 会话 | **[SETUP.md](SETUP.md)** |

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
要求回复第二次“确认”。去新话题真实 `@M5Codex` 一次完成首次 Aily session 绑定。日常还可以使用：

| 命令 | 作用 |
|---|---|
| `$feishu-status` | 只读查看当前 task 的接入、入站绑定和待发布状态 |
| `$feishu-unbind` | 可恢复地暂停当前 task，不删除话题、映射或历史 |
| `$feishu-bind` | 首次接入，或恢复已经暂停的原话题连接 |

Codex 入站通过 `codex exec resume <精确 thread>` 向原 task 追加完整用户回合。回合会持久化，
但已经打开的 Codex Desktop 页面不保证实时绘制另一个 CLI 进程追加的事件；切换 task 再返回
或重新打开后，会从持久历史中显示。这是客户端刷新边界，不是投递到了另一条任务。

### Claude Code 快速路线

Claude 机器级环境安装完成后，在目标项目目录运行 `/init`。hook 会询问是否把该项目接到飞书；
确认后自动创建根话题，再去话题真实 `@M5Claude` 一次完成首次 Aily session 绑定。

也可以使用等价的手动流程：

```bash
node scripts/bind-preview.mjs --project ~/your-project
node scripts/bind-project.mjs --project ~/your-project --apply
```

完整的飞书/Aily 准备、机器模板、安装、验证和排障步骤见 [SETUP.md](SETUP.md)，当前运行状态
与历史问题见 [STATE.md](STATE.md)。

## 日常使用

安装与首次绑定只做一次。之后的使用方式对两套 runtime 基本一致：

1. 打开对应项目的飞书话题；
2. 真实 @ 该 runtime 的第三方智能体，mention 后直接写指令；
3. 先看秒级受理或拒绝说明；
4. 继续做别的事，等待最终答复自动回到原话题；
5. 在电脑前正常使用 Claude/Codex 时，每轮答复也会同步到绑定话题。

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
npm test                         # Claude 234 项 + Codex adapter 回归
npm run test:claude              # 只运行 Claude 基线
npm run test:codex               # 只运行 Codex adapter
npm run doctor:codex             # Codex 机器级只读自检；不写配置、不联网
npm run install:codex:preview    # 预览 Codex 安装会修改什么
```

测试和 doctor 只证明代码与本机组件状态，不会创建话题、发送飞书消息，也不能替代一次真实
`@M5Codex` / `@M5Claude` 的端到端验收。

## 文档导航

| 你想做什么 | 文档 |
|---|---|
| 从零安装 Codex 飞书桥 | [CODEX_SETUP.md](CODEX_SETUP.md) |
| 从零安装 Claude Code 飞书桥 | [SETUP.md](SETUP.md) |
| 查看 Claude 当前运行状态与历史问题 | [STATE.md](STATE.md) |
| 理解机器级配置字段 | [references/chain-config.example.json](references/chain-config.example.json) |
