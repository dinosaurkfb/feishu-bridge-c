# 搭建指南

从零把这座桥接到一个新项目 / 新机器上。

**读之前先知道两件事：**

1. **有些步骤代码替代不了。**飞书侧那个智能体、群，得人工建；机器级模板得人工填。
   其余（话题、项目配置、绑定）全部自动。搭建步骤里用 🔧 标出「必须人工做」的 ——
   一共三步：建群、建智能体、填模板。
2. **每一步都有验证方法。**这条链路的失败大多是安静的 —— 装错了不会报错，
   只会在某天你发消息时没反应。所以每步做完都验一下，别攒到最后。

---

## 一、它是什么

把飞书话题和本机的 Claude Code 长期任务接起来，双向。**一个群里可以接多个项目**，
每个项目占一个话题，话题决定消息去哪个项目。

```
某个话题里发指令  ──→  本机对应项目的 Claude 会话收到并执行
那个项目里干的活  ──→  每轮回答原样发回那个项目的话题
```

实际效果：你合上电脑走开，用手机继续给它下指令、看结果。

---

## 二、前置条件

### 本机

| 依赖 | 要求 | 怎么验 |
|---|---|---|
| macOS | 用到 launchd 和 `~/.claude` 路径 | — |
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

### 4. 装本机的机制

```bash
node scripts/install-outbound.mjs          # dry-run，先看会改什么
node scripts/install-outbound.mjs --apply
```

它装五样，**都只追加、改前备份**：Stop 钩子（每轮回答自动发回话题）、
UserPromptSubmit 钩子（`/init` 时问一句要不要接飞书）、`bind-preview` 的权限白名单、
项目登记表 + 全局技能、launchd 兜底定时器。

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

最省事的做法是直接在项目目录里敲 `/init`：它本身就是一轮对话（前置条件自动满足），
而且 UserPromptSubmit 钩子会顺势问你「要不要建话题」，上面两条命令都不用自己敲。
第四节讲的就是这条路。

### 6. 端到端验证

从飞书发一条真实指令。预期：**秒级**收到「已受理」并说明落到哪条线；活干完后回答
**原样**发回话题。

```bash
node scripts/outbox.mjs --list                     # 还有多少没发出去
tail ~/.claude/feishu-bridge/stop-hook.log         # 出站钩子每次干了什么
```

---

## 四、接一个新项目（两下）

机器装好之后，**接入不需要建话题、不需要写配置**。

```
在新项目目录里敲 /init
  → 钩子注入，会话跑一次预览（免确认），把根消息文案给你看
  → 它问：要不要在群里给这个项目建一个根话题？默认「是」
  → 你选「是」→ 弹一次权限确认 → 建好，出站立刻可用
  → 你去那个新话题 @ 一下入站智能体（空消息也行）→ 入站也通了
```

**一次回答 + 一次批准 + 一个 @。**

不用 `/init` 也行，手动等价物：

```bash
node scripts/bind-preview.mjs --project ~/x            # 看文案，免确认
node scripts/bind-project.mjs --project ~/x --apply    # 建话题 + 登记
```

### 为什么入站要多那一个 @

建话题的那一刻，**Aily 的 session 还不存在** —— 它是第一条消息流进来才产生的。
而绑定的核心闸就是 session_id。所以绑定必然分两段，第二段就是你 @ 的那一下。

那一下靠三道闸守着（都来自机器级配置，绑定前就能判）：发送者是不是你、
有没有**真实** `<at>`、消息新不新。再加「全机同时只有一份待绑定」和 **24 小时窗口**。
超时了重跑一次接入命令即可 —— 话题已在，平台侧幂等键保证不会重建。

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

**在终端**：正常用 Claude Code。**每轮回答会自动原样发回话题**，你不用做任何事。

**续期**：绑定有效期是入站唯一的闸，到期前 30 天和 7 天会自动提醒。

```bash
node scripts/binding.mjs                             # 看本仓库这条
node scripts/binding.mjs --project ~/x               # 看别的项目
node scripts/binding.mjs --project ~/x --renew 1y --apply
```

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
