# 搭建指南

从零把这座桥接到一个新项目 / 新机器上。

> 💡 **Linux 新宿主机端到端安装指引**：若在全新 Linux 机器（如 omm）上通过非交互 SSH 从零部署、验收与卸载，请参考按严格执行顺序编写的 [从零到全功能验收清单（docs/from-zero-checklist.md）](docs/from-zero-checklist.md)。

**读之前先知道两件事：**

1. **有些步骤代码替代不了。**飞书侧那个智能体、群，得人工建；机器级模板得人工填。
   其余（话题、项目配置、绑定）全部自动。搭建步骤里用 🔧 标出「必须人工做」的 ——
   一共三步：建群、建智能体、填模板。
2. **每一步都有验证方法。**这条链路的失败大多是安静的 —— 装错了不会报错，
   只会在某天你发消息时没反应。所以每步做完都验一下，别攒到最后。

> **Aily 现在也叫「豆包工作伙伴」**，是同一个平台。本文沿用 Aily，因为命令行工具和
> 各处标识仍是 `aily-cli` / `AILY_CLI_*` / `agent_...`。
>
> 本文只说「入站智能体」，不写死名字 —— 你自己建的智能体叫什么都可以。
> 代码不认名字，只认配置里的 `agent_...`、`cli_...` 和 `ou_...`。

---

## 一、它是什么

把飞书话题和本机的 Claude Code 长期任务接起来，双向。**一个群里可以接多个项目**，
每个项目占一个话题，话题决定消息去哪个项目。

```
某个话题里发指令  ──→  本机对应项目的 Claude 会话收到并执行
本机直接输入一轮  ──→  顶部灰色引用输入、随后直接显示 Claude 回复
飞书发起的一轮    ──→  只发 Claude 回复，不复读话题里已有的输入
```

实际效果：你合上电脑走开，用手机继续给它下指令、看结果。

---

## 二、前置条件

### 本机

| 依赖 | 要求 | 怎么验 |
|---|---|---|
| 操作系统 | **macOS**：launchd 兜底定时器 + `~/.claude` 路径；**Linux**：systemd `--user` 兜底定时器（见下「Linux（systemd --user）」）；其它平台**能装、但没有兜底定时器**（安装器会明说未装） | `uname -s` |
| Node.js | ≥ 22 | `node -v` |
| Claude Code | 支持 Stop 钩子、`--continue`、跨会话 `SendMessage` | `claude --help \| grep continue` |
| aily-cli | 已登录，daemon 在线 | `aily-cli doctor` 应当全 OK |
| lark-cli | 装着即可 | `lark-cli --version` |
| lark-cli 的 profile | **单智能体方案下不用你配** —— 出站借用入站智能体自己的凭据（在 aily 给它的私有目录里）。只有走双智能体方案才需要自己 `lark-cli auth login` 一个 profile | — |
| 网络 | 国内需要能到 `api.anthropic.com` 的代理 | 见 README 的「代理」一节 |

### 🔧 飞书侧：一个智能体就够（推荐）

**入站**必须是一个 **claude-code-local adapter** 类型的 Aily 智能体 —— 它要在本机拉起
Claude 会话。这一个是硬性的。

**出站**只需要「一个能往群里发消息的飞书应用」，**不必是 Aily 智能体**。而最省事的
选择就是：**用入站那个智能体自己**。

它的凭据在 `~/.aily-cli/lark-cli/<agent_uid>/`（appId 在配置文件里，密钥在 macOS
钥匙串里），普通进程读得到，所以本机的出站发布器可以直接借用。这样：

- **飞书侧只用建一个智能体**，接入门槛少一半
- **话题里只有一个头像** —— 你 @ 谁、谁回你、谁给你结果，是同一个

**为什么以前是两个**：只是当初图省事，借了一个现成的应用来发消息。从「谁在说话」
的角度看，那两个身份背后本来就是同一个本地 Claude，分成两个反而拧。

**要用两个也支持**（比如你想让发布方权限更小、或者出站要复用一个已有的应用）：
第 3 步把出站三项填成另一个应用即可，代码一行不用改。

**同一个群里跑多条链路**（比如同时接 Claude 和 Codex）：互斥靠 **mention 对象**
和**根话题**两者精确匹配 —— 各用各的智能体、各占各的话题，不会串。

正文前缀（如 `→Claude`）是**可选的第三重**，对路由而言冗余。**默认建议关掉**
（`inbound_prefix: null`），少打字。

---

## 三、搭建步骤

分两段：**装一次机器**（下面五步），然后**每个项目两下**（见第四节）。

顺序不能打乱，而且这一版才排对。上一版把机器级模板放在第 5 步、从一个已配好的项目
里派生，结果是个死循环 —— 入站要用模板里的 `agent_uid` 校验调用方，而模板要等项目
配置写完才有，可项目配置又排在「验证入站能通」之后。**机器级的东西不该由任何一个
项目产生。**

---

### 1. 🔧 建群，拿 chat_id

在飞书建一个群（或用现成的），把两边的智能体拉进去。

```bash
lark-cli im +chat-search --query "你的群名" --as bot --json
```

记下 `chat_id`（`oc_...`）。

> **不用手建话题。**每个项目的根话题由 `bind-project.mjs` 自动建 —— 包括第一个。

### 2. 🔧 建入站智能体，拿三个 id

在飞书 Aily 平台上建一个 **claude-code-local adapter** 类型的智能体（它要在本机拉起
Claude 会话）。记下三样：

- `agent_uid`（`agent_...`）—— Aily 的 agent 标识
- `transport_app_id`（`cli_...`）—— 它背后的飞书应用
- `transport_open_id`（`ou_...`）—— **必须是「这个 app 自己视角下」的 open_id**。
  open_id 按 app 隔离，从别的 app 查到的那个不能用（同一个机器人在不同 app 眼里
  是不同的 `ou_`，这里错了入站会全线不通）。

给它写指令：收到消息时执行本仓库的 `scripts/inbound.mjs`，把输出原样回复。
`skills/m5claude-inbound-router/SKILL.md` 是底稿，**把里面的绝对路径改成你的仓库位置**。
同一份也要装进本机的技能目录 —— 有安装器，别手拷：

```bash
node scripts/install-inbound.mjs           # dry-run
node scripts/install-inbound.mjs --apply
```

装到 `~/.claude/skills/`，那是 `aily-cli skill scan-local` 真正会扫的位置
（装完应当被列为 `[claude-code-local]`）。

装完自检的最后两行**各说一件事**，别把它们读混了（issue #241）：

- `aily daemon socket`：看 `~/.aily-cli/sockets/aily-cli.sock` 在不在、是不是 socket（不看 `aily-cli` 命令能不能跑）——**存在不证明进程还活着**（崩溃会留下 socket inode），要确认在不在跑用 `node scripts/doctor.mjs` 或 `aily-cli daemon status`；
- `aily 是否已发现本技能`：跑 `scan-local`，三态 —— 报到了 / 报不到（已知如此：它扫宿主 agent 目录）/
  **查不了**（探测本身失败，原因会带出来）。**「查不了」不等于 daemon 没跑** —— 非交互 ssh 下 PATH 里
  常常没有 `aily-cli`（mise shims 不在 PATH），那时前一行的 socket 判据仍然是可信的。

### 3. 🔧 写机器级链路模板

**这是本机第一件要配的事**，后面所有东西都从它来。

```bash
node scripts/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-app-id cli_xxx --transport-open-id ou_xxx \
  --outbound-agent-name 你的智能体名 \
  --outbound-app-id cli_xxx --outbound-open-id ou_xxx \
  --frank-sender-id 7621... \
  --chat-id oc_xxx --chat-name "群名" \
  --transport-agent-name 你的智能体名 --chain claude --apply
```

**单智能体（推荐）**：出站三项填成跟运输那三项一样的值。校验会确认它们真的一致，
凭据从 `<lark_cli_config_base>/<agent_uid>/` 取，话题里只出现一个头像。

**双智能体**：出站填另一个飞书应用，`--lark-cli-profile` 指向它在 `~/.lark-cli` 里的
profile 名。

不带 `--apply` 先跑一次，15 个字段应当全是 ✓。

> ⚠️ **`frank_sender_id` 是整条链上唯一一个「填错了会静默扩大授权」的字段。**
> 它是 **Aily 平台的 user id**，不是飞书的 `ou_`。填成 `ou_` 会被形状校验挡下（全拒，
> 你立刻发现）；但**填成另一个人的 Aily user id，形状完全合法，而后果是那个人从此
> 能驱动你机器上的长期任务，且没有任何提示**。这一条只能靠抄对，代码救不了。
>
> ⚠️ **装机顺序与 bridge_root 维护**：必须**先写模板（第 3 步 init-chain-template），再跑安装器（第 4 步 install-outbound）**。`bridge_root` 由安装器维护（Codex 链装机时改写为 `runtime/current` 隔离运行时，Claude 链作为配过桥的标志），**不要手工指定 `--bridge-root`**，初始化脚本会明确拒绝该参数。

### 4. 装本机的机制

```bash
node scripts/install-outbound.mjs          # dry-run，先看会改什么
node scripts/install-outbound.mjs --apply
```

它装五样，**都只追加、改前备份**：Stop 钩子（把最终回答与同轮输入配对并自动发回话题）、
UserPromptSubmit 钩子（缓存本地文本输入，并在 `/init` 成功后提示显式运行 `/feishu-bind`）、`bind-preview` 的权限白名单、
项目登记表 + 全局技能、兜底定时器（macOS 写 LaunchAgent；Linux 写 systemd `--user` 单元，见下）。

**验证**：

```bash
node -e 'const s=require(require("os").homedir()+"/.claude/settings.json");
  console.log("Stop",s.hooks.Stop.length,"UserPromptSubmit",s.hooks.UserPromptSubmit.length)'
launchctl list | grep feishu
```

两个数组里都应当**既有你原来的钩子，也有新加的那条**。

### 5. 接第一个项目

第一个项目**和后面每个项目走完全一样的路** —— 不用手写配置，不用手建话题：

```bash
cd 你的项目目录
node <本仓库>/scripts/bind-preview.mjs    # 看文案
node <本仓库>/scripts/bind-project.mjs --apply
```

然后去新建的那个话题里 @ 一下入站智能体（空消息也行），入站绑定完成。

**这个项目目录里必须已经有过一轮 Claude 对话** —— 入站在没有可续对话时会明确拒绝
（`no_prior_session`）而不是瞎兜底。

最省事的做法是先在项目目录里敲 `/init`：它本身就是一轮对话（前置条件自动满足），
UserPromptSubmit 钩子会在初始化成功后提示你单独运行 `/feishu-bind`。`/init` 本轮不会预览、
提问或创建话题；只有后续这条显式控制命令才进入绑定流程。

### 6. 端到端验证

从飞书发一条真实指令。预期：**秒级**收到「已受理」并说明落到哪条线；活干完后回答
**原样**发回话题。

```bash
node scripts/outbox.mjs --list                     # 还有多少没发出去
tail ~/.claude/feishu-bridge/stop-hook.log         # 出站钩子每次干了什么
```

---

### Linux（systemd --user）

同一套安装器，按 `process.platform` 自动选兜底实现 —— 不用传任何参数：

- **Windows 之类其它平台**：安装继续，但兜底定时器那一行会**明说「本平台没有兜底定时器实现，未装」**，
  不会写一个永远不生效的文件、也不假装装好。
- **Linux**：写两份单元到 `~/.config/systemd/user/`（那个目录里别的东西不动）：

  ```
  ~/.config/systemd/user/feishu-bridge-cc-drain.service
  ~/.config/systemd/user/feishu-bridge-cc-drain.timer
  ```

  然后 `systemctl --user daemon-reload` + `systemctl --user enable --now feishu-bridge-cc-drain.timer`。
  语义与 macOS 的 plist 一致：跑 `drain-outbox.mjs --all`，`OnUnitActiveSec=30min`。
- **不常驻登录时**还要 `loginctl enable-linger <你的用户>`（先不带 sudo 试，被拒再 sudo）—— 安装器只**打印**这条提示，
  不执行（交给你决定）。
- **凭据位置（只在 Linux）**：lark-cli 在 Linux 上不用系统钥匙串，改用文件加密库，默认根
  `~/.local/share/lark-cli/`；而 aily 给每个 agent 写的密钥在 `<agent 凭据目录>/data/lark-cli/`。
  桥会给每个 lark-cli 调用补上 `LARKSUITE_CLI_DATA_DIR=<agent 凭据目录>/data`，让两边对上。
  `node scripts/doctor.mjs` 在 Linux 上会多查一项「⑧′ 机器人发送凭据」，把**aily 写的目录**与
  **lark-cli 找的目录**都打印出来（两边各自成功、就是没对上，是最难查的那类）。
- **node 从哪来**：hooks 与单元里的 node 是**解析**出来的（`FEISHU_BRIDGE_NODE` → PATH → 常见安装位置），
  不写死 macOS 的 `/opt/homebrew/bin/node`；版本管理器（mise/nvm）下拿到的是 shim，切版本也不会失效。

### 非交互 ssh 没有代理、也没有 PATH 之外的任何 shell 环境

在 Linux 远端宿主机（如 omm）通过 `ssh host 'cmd'` 执行安装命令或自动化脚本时，shell 处于非登录、非交互模式，**压根不会读取 `~/.bashrc`**（不仅是被常规 `.bashrc` 顶部的 `[[ $- != *i* ]] && return` 交互守卫阻断，非登录非交互 bash 默认根本不尝试 source 该文件）。

实测极易在同一问题上连续三次踩坑：
1. `git clone` 拿不到代理，直接报错 `Failed to connect to github.com:443`；
2. `aily-cli daemon` 随手在非交互终端启动，因缺代理无法与平台建连；
3. 命令中加 `source ~/.bashrc` 撞上早退判断，环境变量依然没有导入。

#### 1. 代理配置：单次显式前置或写入 environment.d（根治）
- **单次命令**：需要网络的步骤显式 export 或在命令前置代理变量：
  ```bash
  https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 git clone ...
  ```
- **机器级持久根治**：配置 `~/.config/environment.d/10-proxy.conf`（systemd 用户实例拉起的进程会统一继承该配置）：
  ```ini
  HTTP_PROXY=http://127.0.0.1:7890
  HTTPS_PROXY=http://127.0.0.1:7890
  http_proxy=http://127.0.0.1:7890
  https_proxy=http://127.0.0.1:7890
  ALL_PROXY=socks5://127.0.0.1:7890
  all_proxy=socks5://127.0.0.1:7890
  NO_PROXY=localhost,127.0.0.1
  no_proxy=localhost,127.0.0.1
  ```
  通过 shell rc 文件修代理在非交互上下文下怎么改都是补丁，写入 `environment.d` 并配合 systemd 托管服务是彻底解法。

#### 2. Node.js 路径：给出绝对路径
非交互 ssh 的 `PATH` 仅包含系统基础目录，不包含交互 shell 加载的用户级目录。需要 node 的步骤请直接给绝对路径。
本桥安装器在生成 hooks 与 systemd 单元时，已严格按 PK3-L1 顺序解析 node 路径：
- **Linux**：显式 `env.FEISHU_BRIDGE_NODE` → 原单元/服务已装路径（installed）→ mise shim（`~/.local/share/mise/shims/node`）→ 当前 `PATH` → `/usr/local/bin/node` → `~/.local/bin/node`；
- **Darwin**：显式 `env.FEISHU_BRIDGE_NODE` → 已装路径 → `/opt/homebrew/bin/node` → `/usr/local/bin/node` → 当前 `PATH` → `~/.local/bin/node`。
若以上均未找到则直接报错退出，坚决不回退版本升级易失效的 `process.execPath`。

#### 3. aily daemon 建议托管为 systemd --user 服务

> **2026-09-18 起（PK3-U1）：Linux 上这件事由本桥安装器做。**`node scripts/install-outbound.mjs --apply`
> 会写 `~/.config/systemd/user/feishu-bridge-aily.service`（ExecStart 用**绝对路径**的 aily-cli，
> `daemon start --foreground`；`Restart=on-failure`；代理等环境由 systemd --user 从
> `~/.config/environment.d/*.conf` 继承）并 `enable --now`。要找 aily-cli 在不在 PATH 里，
> 也可以在链路模板里给 `aily_cli_bin`；找不到就**不写**这个单元并把话说出来。
> 要带 `--as <agent id>` / `--env online` 这类参数就用 `FEISHU_BRIDGE_AILY_DAEMON_ARGS`（dry-run 会把
> 最终 ExecStart 打出来）。**机器上已经有 aily-cli 自己生成的单元（`aily-cli-daemon-*.service`）时，
> 安装器不覆盖、报出来让你定夺。** 下面这段手工做法仍然有效（老机器 / 想自己管的时候用）。
切勿在非交互 ssh 下随手执行 `nohup aily-cli daemon &`，不仅脱机后上下文脆弱，也无法稳定继承代理。推荐将其配置为 `systemd --user` 服务（拉起时自动继承 `environment.d` 中的代理环境变量）：

新建单元文件 `~/.config/systemd/user/aily-daemon.service`（最小 unit 示例，不含敏感凭据）：
```ini
[Unit]
Description=Aily CLI Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env aily-cli daemon
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
```
生效并启动：
```bash
systemctl --user daemon-reload
systemctl --user enable --now aily-daemon.service
```
若需要非登录常驻，配合前文提到的 `loginctl enable-linger <你的用户>`（被拒再 sudo）即可。

> **同一家族的教训**：“我的终端里能跑 ≠ 任何上下文都能跑”。本桥安装器的 node 路径解析（优先寻找 mise shim，见 PK3-L1 / PR #212）、doctor 的 systemctl 检查恒带 `--user` 避免误判为系统级单元（见 issue #225 / PR #227），以及此处的非交互 ssh 代理与环境变量隔离，本质均属同一家族问题——切勿将交互式终端中的 rc 隐式环境视为通用假设。

## 四、接一个新项目（两下）

机器装好之后，**接入不需要建话题、不需要写配置**。

```
在新项目目录里敲 /init
  → 原生初始化完成后，钩子提示单独运行 /feishu-bind
  → 运行 /feishu-bind → 预览后弹一次权限确认 → 建好，出站立刻可用
  → 你去那个新话题 @ 一下入站智能体（空消息也行）→ 入站也通了
```

**一条显式命令 + 一次批准 + 一个 @。** `/init`、按钮或自然语言回复都不构成绑定授权。

不用 `/init` 也行，手动等价物：

```bash
node scripts/bind-preview.mjs --project ~/x            # 看文案，免确认
node scripts/bind-project.mjs --project ~/x --apply    # 建话题 + 登记
```

### 为什么入站要多那一个 @

建话题的那一刻，**Aily 的 session 还不存在** —— 它是第一条消息流进来才产生的。
而绑定的核心闸就是 session_id。所以绑定必然分两段，第二段就是你 @ 的那一下。

那一下靠三道闸守着（都来自机器级配置，绑定前就能判）：发送者是不是你、
有没有**真实** `<at>`、消息新不新。多份待绑定并存时按根消息引用块里的**绑定码**精确匹配。
待绑定**不过期**（2026-08-28 起）；不想要了用 `node scripts/feishu-rotate.mjs --cancel --apply` 显式取消。

### 接入产生了什么

**登记表里的一行**，仅此而已：

```
{ id, root, name, purpose, root_message_id, session_id, expires_at, ... }
```

项目目录里**不写任何配置文件**。身份、群、profile 全部来自机器级模板，
`scripts/project-resolve.mjs` 在读取时现算 —— 两种存放形式读取方分不出区别。

> 从旧版迁移过来的机器上，第一个项目可能还留着一份 `.runtime-data/inbound/*.json`。
> 它仍然有效，但**链路级字段（身份、profile、群）一律以机器模板为准** ——
> 否则会出现「新项目用新身份、老项目还用旧身份」的同机不一致，而这种不一致不报错，
> 只会让话题里冒出第二个头像。项目文件里只有项目级字段（显示名之类）还作数。

---

## 五、日常使用

**从飞书**：在**那个项目的话题里** `<mention 入站智能体> 你的指令`。
话题决定去哪个项目 —— @ 错话题会被明确告知「本话题通向：X」。
（若保留了前缀，正文要以它开头；关掉前缀用 `node scripts/binding.mjs --prefix none --apply`。）

**在终端**：正常用 Claude Code。每个本地回合的**输入和最终回答会合成一张 Card 2.0**发回
话题；输入在顶部以小号灰字引用，下面直接显示回答。若输入原本来自该飞书话题，卡片只发回答，
不把你的原消息重复一遍。超出卡片正文上限的完整事件仍保存在本机 outbox/run 记录中。

**控制命令**：`/feishu-bind` 接入或恢复，`/feishu-unbind` 可恢复地暂停，`/feishu-status` 只读
查看状态，`/feishu-rotate` 为同一 binding 创建下一话题代际，`/feishu-mode` 只读查看当前策略，
`/feishu-mode dialogue` 与 `/feishu-mode mapping` 显式切换交互模式。Dialogue v1 只支持一名授权人类
与一个主持会话的串行多轮对话，默认 12 轮 / 2 小时 / 12 资源单位；Agent 回复不会自动触发下一轮。
轮转的新话题在首次真实 mention
前保持 pending，旧话题继续 active；认领成功后新话题 active、旧话题 read-only。待认领**不过期**
（2026-08-28 起；只有旧登记写了显式截止的才会过期）：等满 72 小时无人认领会在该话题下提醒一次，之后每 7 天再提醒一次；
显式取消是唯一的取消入口：`node scripts/feishu-rotate.mjs --cancel --apply`，不会删除话题历史。

**续期**：绑定有效期是入站唯一的闸，到期前 30 天和 7 天会自动提醒。

```bash
node scripts/binding.mjs                             # 看本仓库这条
node scripts/binding.mjs --project ~/x               # 看别的项目
node scripts/binding.mjs --project ~/x --renew 1y --apply
```

---

## 五点五、卸载（一键按序）

```bash
node scripts/uninstall.mjs                     # 预览：将停 / 将删 / 将保留（默认不动任何东西）
node scripts/uninstall.mjs --apply             # 真的卸
node scripts/uninstall.mjs --purge --yes-delete-data --apply   # 连机器级数据一起删
```

**顺序是写死的，别改成别的顺序**（顺序错了不报错，只留下半截状态）：

| # | 卸什么 | 为什么在这个位置 |
|---|---|---|
| 1 | 入站技能（Claude 链） | 先停入站 = 止血：Aily 回合不再进运输层。反过来的话，平台事件会落在已经卸掉处理线程的本机上，静默丢 |
| 2 | 出站（Claude 链）：hooks + 技能 + 兜底定时器 +（linux）aily daemon 服务 | 入站停掉之后再拆出站；定时器/服务**先停再删** plist/unit（停不下来就不删 —— 删了就是把还在跑的定时器变孤儿） |
| 3 | Codex 链：hooks + 技能 + 兜底排空服务 | 同源机制，放在 Claude 链之后 |
| 4 | `runtime/current`（两条链的「已安装」标记） | 最后才动：上面每一步都要靠 current 里的脚本干活，提前摘掉会让卸载自己跑不起来 |
| 5 | `--purge` 才走：`versions/` 与机器级数据 | 破坏性动作，要 `--purge --yes-delete-data` 两个一起给（只写 `--purge` 会被拒） |

**默认保留数据**（卸载的是机制，不是历史）：`registry.json`、`routes.json`、`status-providers.json`、
`subscriptions.json`、`chain-config.json`、`inbound/`（回执与账本）、`ledger/`。`versions/`（代码缓存）
也留着 —— 重装更快。**项目里的 `.runtime-data/` 与话题历史，本命令一个字节都不碰**（那不属于机器级卸载）。

**锁**：一键卸载在开工前取 `<home>/.claude/feishu-bridge/install-surface.lock`（与三个安装器、维护流程
共用的一把），**持有到最后一个删除动作结束**；拿不到（别的安装 / 维护在跑）或维护门开着 → exit 2、零写。
子安装器继承这次持有（`FEISHU_BRIDGE_INSTALL_SURFACE_HELD`），所以中间没有"无锁窗口"。

**settings.json 的合同**：本桥的钩子条目与预览放行规则消失，**别人的条目逐字段不变**。
不承诺"回到装前字节"——重新序列化会规范化格式（缩进 / 键序），只有原本是空 `{}` 的情形才恰好字节相等。

**`--purge` 的删除边界**（2026-09-19，PK3-U1-fix4）：
- **产品自己派生的两处桥根整棵删**：`<home>/.claude/feishu-bridge`、`<codexHome>/feishu-bridge`。
- **显式 `FEISHU_CODEX_BRIDGE_HOME`（人给的位置）只删它下面的封闭已知条目**（登记表 / 模板 / 路由表 /
  回执 / 账本 / 收据 / tasks / intents / threads / 日志 / 锁），**目录本身保留** —— 那可能是共享目录，
  里面还可能有别人的文件。
- 显式桥根必须落在 home 或系统临时目录下；指到 `/etc` 这类系统目录会被拒绝（exit 2、零写，并点名变量与值）。
- 覆盖点环境变量（`FEISHU_BRIDGE_REGISTRY` 等）只删那个文件，**绝不删它的父目录**。

**卸后怎么验**：

```bash
node scripts/doctor.mjs
```

应看到「装机状态：未安装」与「结论：未安装 —— 本机没装本桥（…）。这不是故障。」，
**一条 ✗ 都没有**（未安装的机器上，运行时/默认处理器那些项是"不适用"，不是故障）。
若还有残留，doctor 会把在的项逐条列出来（那就是没卸干净）。

**再装注意**：数据都在，重装就是 `node scripts/install-outbound.mjs --apply` +
`node scripts/install-inbound.mjs --apply`（Codex 链再跑 `node scripts/codex/install.mjs --apply`）；
如果之前用过 `--purge`，链路模板与绑定没了，要按第三节重新配、重新接项目。

---

## 六、给别人用时要改什么

| 位置 | 改什么 |
|---|---|
| `~/.claude/feishu-bridge/chain-config.json` | 机器级链路模板：智能体、profile、群 id、授权发送者。**唯一必须手配的东西** |
| `skills/*/SKILL.md` | 里面写死了本仓库的绝对路径 |
| `.claude/settings.json` | `allow` 里有两条写死 `/Users/dk/...` 的便利规则，换机器要改（改不改都不影响安全）。`deny` 那两条**不要动** —— 它们挡住长期任务改写自己的回执和绑定 |
| 飞书平台侧 | 一个 claude-code-local 智能体（话题由 bind-project 自动建） |
| 出站 profile | 单智能体下是 `platform-bot`；双智能体下要与别人的链路区分开 |

`scripts/` 下的代码本身是可移植的（用 `os.homedir()` 和脚本自身位置解析）。

---

## 七、装不上时按这个顺序查

**这条链路的失败大多是安静的**，所以按依赖顺序从底往上查，别跳：

1. `aily-cli doctor` —— daemon 在不在线、凭据、网关
2. 报「Claude Code 鉴权失败」时**先别查凭据**，多半是 daemon 丢了代理：
   `sh scripts/aily-daemon-restart.sh`
3. `node scripts/inbound.mjs --dry-run` —— 路由到哪个项目、六项校验哪一项没过
4. `cat .runtime-data/inbound/receipts/*.json` —— 每条消息的受理/拒绝记录，带原因
5. `node scripts/binding.mjs` —— 绑定是不是过期了
6. `tail ~/.claude/feishu-bridge/stop-hook.log` —— 出站钩子每次的结果
7. `node scripts/bind-preview.mjs --project ~/x` —— 这个项目接没接、话题在哪
8. 出站报「凭据目录属于另一个应用」→ `agent_uid` 指错了 agent，**没有发出任何消息**
9. 出站报「读不到出站凭据目录」→ aily-cli 被卸载或清理过。注意**这不影响入站**，
   所以症状会是「它突然不说话了」，而你发指令还有回应
10. `node scripts/test.mjs` —— 234 项本地回归，零外部副作用

**一条经验**：判断入站是否健康，不能只看「发消息有没有回复」。
入站智能体是个被反复 resume 的持久会话，技能坏了它也可能凭记忆把命令跑出来。
详见 STATE.md 里那三次误判的记录。
