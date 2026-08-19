# 搭建指南

从零把这座桥接到一个新项目 / 新机器上。

**读之前先知道两件事：**

1. **有些步骤代码替代不了。**飞书侧的两个智能体、话题、绑定授权，都得人工建。
   安装器只能装本机那部分。全文用 🔧 标出「必须人工做」的步骤。
2. **每一步都有验证方法。**这条链路的失败大多是安静的 —— 装错了不会报错，
   只会在某天你发消息时没反应。所以每步做完都验一下，别攒到最后。

---

## 一、它是什么

把一个飞书话题和一个本机的 Claude Code 长期任务接起来，双向：

```
你在飞书话题里发指令  ──→  本机 Claude 会话收到并执行
你的终端里在干的活    ──→  每轮回答原样发回那个话题
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
| lark-cli | 有一个专属 profile 且已授权 | `lark-cli auth status` |
| 网络 | 国内需要能到 `api.anthropic.com` 的代理 | 见 README 的「代理」一节 |

### 🔧 飞书侧：两个智能体，职责必须分开

这是最容易搞错的地方 —— **不能用同一个身份既收又发**。

| | 干什么 | 为什么必须独立 |
|---|---|---|
| **入站运输**（例：M5Claude） | 把话题里的消息转进本机。它**只做运输**，不判断、不发布 | 它是唯一能触发本机执行的入口，权限面要尽量小 |
| **出站发布**（例：COO助理CC） | 把结果和进展发回话题 | 让运输方也能发布，等于把两个方向的职责搅在一起；出问题时分不清是谁说的 |

入站那个必须是 **claude-code-local adapter** 类型的智能体（它要在本机拉起 Claude 会话）。

**如果同一个群里要跑多条链路**（比如同时接 Claude 和 Codex），互斥靠 **mention 对象**
和**根话题**两者精确匹配 —— 各用各的智能体、各占一个话题，就不会串。

正文前缀（如 `→Claude`）是**可选的第三重**。对路由而言它是冗余的：能走到前缀这一步，
消息已经过了绑定有效、话题正确、发送者正确、真实 mention 四道闸，而路由靠的是话题。
**默认建议关掉**（`inbound_prefix: null`），少打字。

---

## 三、搭建步骤

### 1. 🔧 建话题

在群里发一条消息作为**根话题**，内容说明这个话题是干什么的、要怎么用。
之后所有指令都回复在它下面。

记下它的 `message_id`（形如 `om_...`）：

```bash
lark-cli im +messages-list --chat-id <群id> --json | head
```

**验证**：话题能正常回复。

### 2. 🔧 配置入站智能体

在飞书 Aily 平台上给入站智能体写指令，告诉它：收到消息时执行本仓库的
`scripts/inbound.mjs`，并把输出原样回复。

本仓库 `skills/m5claude-inbound-router/SKILL.md` 是这段指令的底稿，可以直接照抄，
**但要把里面的绝对路径改成你的仓库位置**。

> ⚠️ 这一步的机制我们**没有完全查清**（详见 STATE.md）。技能既可能来自
> `~/skills/<技能名>/`，也可能来自平台侧配置。实践上：两处保持一致就不会出问题。

**验证**：在话题里发一条 `<mention> 测试`（若保留了前缀则加上），应当秒级收到
「已受理」或明确的拒绝原因。
**收不到任何回复**说明这一步没通 —— 不要往下走。

### 3. 装本机的出站机制

```bash
node scripts/install-outbound.mjs          # dry-run，先看会改什么
node scripts/install-outbound.mjs --apply
```

它装四样：`~/.claude/settings.json` 的 Stop 钩子（**追加**，不动已有的）、
项目登记表、全局技能、launchd 兜底定时器。幂等，可 `--uninstall`。

**验证**：

```bash
node -e 'console.log(require(require("os").homedir()+"/.claude/settings.json").hooks.Stop.length)'
launchctl list | grep feishu
```

Stop 数组里应当**既有你原来的钩子，也有新加的这条**。

### 4. 🔧 写身份配置

```bash
mkdir -p .runtime-data/inbound
cp references/chain-config.example.json .runtime-data/inbound/chain-config.json
```

按文件里的注释逐项替换。最容易错的两项：

- **`transport_open_id`** 必须是「那个 app 自己视角下」的 open_id。open_id 按 app 隔离，
  从别的 app 查到的不能用。
- **`lark_cli_bin` / `lark_cli_home`** 必须写绝对路径。发布器是在 aily agent 的
  清洗环境里被拉起的，那里 lark-cli 被重定向到按 agent 隔离的配置目录 ——
  靠环境里「恰好是什么」会拿到错误的身份。

### 5. 🔧 建绑定授权

```bash
cp references/active-mapping.example.json .runtime-data/inbound/active-mapping.json
```

`session_id` 从入站的调试输出里取：

```bash
node scripts/inbound.mjs --dry-run    # 只跑校验，不投递
```

**验证**：

```bash
node scripts/binding.mjs
```

应当打印出绑定 id、有效期、剩余天数、话题、根消息。

### 6. 🔧 起长期任务会话

**这一步不能省。**入站在没有可续对话时会明确拒绝（`no_prior_session`）而不是兜底。

在项目目录里开一个 Claude 会话，跟它说清楚它是这个项目的长期任务，让它确认。
之后这个目录就有「最近一次对话」可续了。

### 7. 端到端验证

从飞书发一条真实指令。预期：

1. **秒级**收到「已受理」，并说明落到哪条线（现场会话 / 后台起一轮）
2. 活干完后，回答**原样**发回话题

```bash
node scripts/outbox.mjs --list                    # 还有多少没发出去
tail ~/.claude/feishu-bridge/stop-hook.log        # 出站钩子每次干了什么
cat .runtime-data/inbound/receipts/accepted-*.json # 入站回执
```

---

## 四、日常使用

**从飞书**：在绑定话题里 `<mention 入站智能体> 你的指令`。
（若保留了前缀，正文要以它开头；关掉前缀用 `node scripts/binding.mjs --prefix none --apply`。）

**在终端**：正常用 Claude Code。**每轮回答会自动原样发回话题**，你不用做任何事。

**续期**：绑定有效期是入站唯一的闸，到期前 30 天和 7 天会自动提醒。

```bash
node scripts/binding.mjs --renew 1y --apply
```

---

## 五、给别人用时要改什么

| 位置 | 改什么 |
|---|---|
| `.runtime-data/inbound/*.json` | 全部身份和绑定（不在版本管理里，必须自己建） |
| `skills/*/SKILL.md` | 里面写死了本仓库的绝对路径 |
| 飞书平台侧 | 两个智能体、话题 |
| 出站 profile | `lark_cli_profile` 要与别人的链路区分开 |

`scripts/` 下的代码本身是可移植的（用 `os.homedir()` 和脚本自身位置解析）。

---

## 六、装不上时按这个顺序查

**这条链路的失败大多是安静的**，所以按依赖顺序从底往上查，别跳：

1. `aily-cli doctor` —— daemon 在不在线、凭据、网关
2. 报「Claude Code 鉴权失败」时**先别查凭据**，多半是 daemon 丢了代理：
   `sh scripts/aily-daemon-restart.sh`
3. `node scripts/inbound.mjs --dry-run` —— 六项校验哪一项没过
4. `cat .runtime-data/inbound/receipts/*.json` —— 每条消息的受理/拒绝记录，带原因
5. `node scripts/binding.mjs` —— 绑定是不是过期了
6. `tail ~/.claude/feishu-bridge/stop-hook.log` —— 出站钩子每次的结果
7. `node scripts/test.mjs` —— 156 项本地回归，零外部副作用

**一条经验**：判断入站是否健康，不能只看「发消息有没有回复」。
入站智能体是个被反复 resume 的持久会话，技能坏了它也可能凭记忆把命令跑出来。
详见 STATE.md 里那三次误判的记录。
