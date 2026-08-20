# Codex 飞书桥：安装、接入与验证

Codex adapter 把一个飞书话题绑定到一个**精确 Codex task/thread**：在话题里真实
`@M5Codex` 后，正文作为用户指令进入该 task；Codex 的最终答复自动回到原话题。

仓库代码不代表某台机器已经配置完成。新机器必须依次完成：准备飞书身份、写机器级模板、
安装 hooks/skills、接入一个 task、跑一次真实端到端验证。

> Claude Code 用户请看 [SETUP.md](SETUP.md)。本页只讲 Codex，不需要安装 Claude 侧 hooks。

## 先理解两个行为

1. **绑定的是 task，不是目录。**同一个仓库里的两个 Codex task 可以分别接到两个飞书话题；
   桥不使用标题或 `--last` 猜目标。
2. **后台续接会持久化，但 Desktop 不一定实时刷新。**入站通过
   [`codex exec resume`](https://learn.chatgpt.com/docs/non-interactive-mode) 把完整用户回合写进
   原 task。若该 task 已在 Codex Desktop 中打开，页面可能不会实时显示另一个 CLI 进程的
   事件；切换 task 再返回或重新打开后，会从持久化历史中加载这次输入、执行和答复。

## 1. 前置条件

| 依赖 | 要求 | 验证方式 |
|---|---|---|
| macOS | 当前安装器写入用户级 Codex hooks | — |
| Node.js | 22 或更高 | `node -v` |
| Codex Desktop/CLI | CLI 在 `PATH` 中，Desktop 能加载用户 hooks | `codex --version` |
| aily-cli | 已登录，daemon 在线，M5Codex 能在本机调用 Codex | `aily-cli doctor` |
| lark-cli | 已安装 | `lark-cli --version` |
| 飞书群 | M5Codex 已在群中 | 在群成员列表确认 |

克隆后先跑零外部副作用的回归：

```bash
git clone https://github.com/dinosaurkfb/feishu-bridge-c.git
cd feishu-bridge-c
npm test
```

随后运行只读 doctor：

```bash
npm run doctor:codex
```

第一次运行时，模板、hooks 和 skills 显示缺失是正常的；doctor 会按顺序告诉你下一步。
它不安装、不联网，也不展示身份、群或 thread locator。

## 2. 准备机器级配置

飞书侧推荐只使用一个 M5Codex：同一个身份负责接收 mention 和发布结果。需要准备以下字段：

| 参数 | 从哪里取得 |
|---|---|
| `--agent-uid` | Aily 中 M5Codex 的 `agent_...` 标识 |
| `--transport-app-id` | M5Codex 背后的飞书应用 `cli_...` |
| `--transport-open-id` | 该应用自身视角下 M5Codex 的 `ou_...`；不能复用其他应用查到的 open_id |
| `--frank-sender-id` | 被授权用户的 **Aily user id**；不是飞书 `ou_...` |
| `--chat-id` | 目标群的 `oc_...`；可用 `lark-cli im +chat-search` 查询 |
| `--chat-name` | 给人看的群名 |

`frank_sender_id` 决定谁能驱动本机 Codex，必须逐字核对。填成另一个合法用户 ID 不会触发
格式错误，却会把授权给错人。

先 dry-run，确认所有必填项均为 `✓`，再原样加 `--apply`：

```bash
node scripts/codex/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-agent-name M5Codex \
  --transport-app-id cli_xxx \
  --transport-open-id ou_xxx \
  --frank-sender-id 0000000000000000000 \
  --chat-id oc_xxx \
  --chat-name "目标群"

# 核对无误后再执行同一条命令，并在末尾加：
# --apply
```

模板保存在 `~/.codex/feishu-bridge/chain-config.json`。它包含本机身份与路由信息，不得提交。
仓库绝对路径也会写入模板；移动仓库后必须重新生成模板并重装 hooks/skills。

## 3. 安装 Codex hooks 和技能

仍然先预览，再安装：

```bash
npm run install:codex:preview
node scripts/codex/install.mjs --apply
```

安装器会：

- 向现有 `UserPromptSubmit` 和 `Stop` 数组追加本桥命令，保留其他 hooks；
- 安装 `m5codex-inbound-router` 和 `codex-longtask-feishu`；
- 安装 `$feishu-bind`、`$feishu-unbind`、`$feishu-status` 三个 task 命令；
- 创建 Git 外的空 registry，并为已登记 task 启用每轮自动发布；
- 不发送飞书消息、不补发历史 outbox，也不代替用户确认 hook trust。

安装后重新加载 Codex。若出现 hook trust 提示，先核对命令确实指向本仓库，再确认。然后运行：

```bash
npm run doctor:codex
```

所有机器级检查应为 `✓`。

## 4. 接入一个 Codex task

在**要接入的那个 task 本身**运行：

```text
$feishu-bind
```

`$feishu-bind` 本身就是本次绑定授权：技能会直接用 M5Codex 在目标群创建话题并登记当前
精确 thread，不再要求回复第二次“确认”。不要从另一个 task 按标题代绑，也不要使用 `--last`。

新话题建立后，在该话题中真实 `@M5Codex` 一次；空正文即可完成首次 Aily session 绑定。
之后 mention 后的正文直接作为指令，不需要 `→Codex` 等关键字。

检查状态：

```text
$feishu-status
```

只有状态同时显示“task 已接入”和“飞书入站已绑定”，才算接入完成。

## 5. 做一次真实验证

在绑定话题里发送一条全新的、可安全核验的命令，例如：

```text
@M5Codex 只读查看当前分支名称，并告诉我工作树是否干净
```

验收四件事：

1. 飞书先收到“已受理”，且没有重复 claim；
2. 目标 Codex task 的持久化历史出现带 `[飞书 · …]` 来源戳的用户回合；
3. runner 观察到目标 thread、`turn.completed`、exit code 0 和非空最终输出；
4. 最终答复只回到原话题一次，发送者仍是 M5Codex。

若 Desktop 当时正打开该 task 而未立即显示第 2 项，先切换到其他 task 再返回；这属于客户端
实时刷新差异，不等于投递失败。最终仍应以 task 历史、严格 runner 终局和飞书回读三层证据验收。

## 日常命令

| 命令 | 作用 |
|---|---|
| `$feishu-bind` | 接入当前 task；暂停后再次运行会复用原话题恢复 |
| `$feishu-unbind` | 可恢复地暂停入站和自动发布；不删除话题或历史 |
| `$feishu-status` | 只读查看当前 task 的接入、绑定和待发布数量 |
| `npm run doctor:codex` | 只读检查机器级依赖和安装状态 |
| `npm test` | 运行 Claude 基线与 Codex adapter 全套本地回归 |

## 工作原理

```text
飞书真实 @M5Codex
  → Aily 调用 m5codex-inbound-router
  → sender / 群 / root / session / freshness / 幂等 / claim 校验
  → 精确 codex_thread_id + codex exec resume
  → 秒级受理；一次性 watcher 等待严格终局
  → Stop 保存原始答复，watcher 授予发布资格
  → 同一个 M5Codex 把最终答复发布到原话题
```

Codex locator、claim、receipt、run 和 outbox 全部放在
`~/.codex/feishu-bridge/`，不会写进项目工作树。目标 Codex run 会剥离 `AILY_CLI_*` 入站身份，
避免把目标 task 再次误识别成 M5Codex 路由进程。

## 排障与卸载

先运行：

```bash
npm run doctor:codex
node scripts/codex/install.mjs   # 再看一遍安装预览
```

常见状态：

- `模板不可用`：重新执行第 2 步，先 dry-run；
- `hook/skill 缺失`：重新安装，并重新加载 Codex、确认 hook trust；
- `等待首次真实 @M5Codex`：去新话题真实 mention 一次；
- `target_busy`：上一轮尚未结束，等它完成后发送一条**新消息**，不要重放旧 message id；
- 飞书有答复、Desktop 没画面：切换 task 或重新打开，读取已持久化历史；
- 自动发布失败：答复留在 task outbox，不会被标记为已发送。

只读查看历史或异常待发项：

```bash
node scripts/codex/drain-outbox.mjs --task-key <logical-task-key>
```

卸载 hooks 和技能：

```bash
node scripts/codex/install.mjs --uninstall
node scripts/codex/install.mjs --uninstall --apply
```

卸载不会删除 `~/.codex/feishu-bridge/` 中的 registry、话题映射和历史回执，便于审计或恢复。

## 已知边界

- 正在运行的 Desktop turn 不从另一个 CLI 进程强行 steer；命中活跃 lease 时会 fail-closed 为 busy；
- Desktop 对后台 CLI 追加回合不保证实时刷新，但回合会持久化到同一 task；
- Aily 外层仍可能有首语义事件计时器；本仓库无法保证模型一定在其超时前调用入站技能；
- App Server 原生 live steering 尚未纳入当前稳定路径；
- 本地测试不能替代每台机器自己的真实 M5Codex/飞书端到端验证。
