# Codex adapter 搭建与验证

当前状态：候选实现。本地合成与隔离安装测试已通过。仓库不记录某一台机器的部署状态；
是否已经安装应通过安装预览和 `~/.codex` 只读检查确认。真实链路结论必须等动作级端到端
验证后再更新。

## 设计基线

- 运输和发布都是同一个 M5Codex；初始化器会把 outbound identity 从 transport identity
  构造出来，读取时再次拒绝不一致配置。
- 绑定单位是 Codex task/thread，不是项目路径。同一仓库的两个 task 必须建立两条独立话题。
- Aily `session_id` 只负责飞书话题路由；`codex_thread_id` 只负责本机 Codex 续接，两者不能混用。
- 用户明确绑定的 task 根目录可能是包含多个仓库的 workspace；runner 只跳过 Codex 的 Git
  仓库前置检查，不改变 sandbox 或 approval 权限，终局证据要求保持不变。
- 目标 Codex run 必须剥离 `AILY_CLI_*` 入站身份；hook 中 `codex-run` 角色优先于 Aily
  判断，目标 task 严禁再次调用 M5Codex 入站路由。
- 所有运行 locator 放在 `~/.codex/feishu-bridge/`，不得提交或复制到项目文档。
- 已绑定 task 的每轮最终答复自动发布；发送失败留队，升级前历史积压不自动补发。
- 飞书入站回合必须由 watcher 严格确认目标 thread、`turn.completed`、exit 0 和非空输出后发布。
- 入站 selector 只要求绑定话题中的真实 `@M5Codex`；mention 后正文直接作为指令。

## 1. 本地回归

```bash
node scripts/test.mjs
node scripts/codex/test.mjs
node scripts/codex/install.mjs
```

最后一条只是安装预览。此时不应修改 `~/.codex/hooks.json` 或 `~/.codex/skills/`。

## 2. 生成单 M5Codex 模板

先 dry-run，字段全部通过后才加 `--apply`：

```bash
node scripts/codex/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-agent-name M5Codex \
  --transport-app-id cli_xxx \
  --transport-open-id ou_xxx \
  --frank-sender-id 0000000000000000000 \
  --chat-id oc_xxx \
  --chat-name "目标群"
```

初始化器不会接受第二个 outbound identity。模板落点是
`~/.codex/feishu-bridge/chain-config.json`。

## 3. 安装 hooks、技能与命令

```bash
node scripts/codex/install.mjs
node scripts/codex/install.mjs --apply
```

安装器只向现有 `UserPromptSubmit` 和 `Stop` 数组追加自己的命令，保留其他 hook，并在改前
备份。它同时为既有 task 启用每轮自动发布，但安装动作本身不发送历史 outbox。它不会替用户
写 hook trust；首次载入时应核对命令路径后由用户确认信任。

它安装两项技能：

- `m5codex-inbound-router`：M5Codex 收到真实 mention 时执行确定性入站脚本；
- `codex-longtask-feishu`：当前 task 的接入预览、一次性建话题、自动发布与异常积压处理。

同时安装三项命令型技能到 `$CODEX_HOME/skills/`（也会出现在斜杠菜单）：

- `$feishu-bind`：接入当前 task；若曾暂停则复用原话题恢复；
- `$feishu-unbind`：可恢复地暂停当前 task，不删话题、不发飞书消息；
- `$feishu-status`：只读查看连接和待发布数量，不输出 locator。

当前 Codex 已移除旧的 `$CODEX_HOME/prompts` 自定义提示词加载；不要使用已废弃的
`/prompts:*` 形式。

## 4. 接入一个 Codex task

Codex 官方 `/init` 只生成项目 `AGENTS.md`。UserPromptSubmit hook 不截获这个职责，只要求
Codex 在初始化确实成功后询问是否接入；本轮不会自动建话题。用户随后回复“接入飞书”，
或直接运行 `$feishu-bind`，hook 才会注入当前精确 thread id。先运行只读预览：

```bash
node scripts/codex/bind-preview.mjs --project /absolute/project --thread-id <uuid>
```

确认根消息后，单独批准：

```bash
node scripts/codex/bind-task.mjs --project /absolute/project --thread-id <uuid> --apply
```

命令会用 M5Codex 建根话题并向 Git 外 registry 添加一条 task 记录。随后在新话题里真实
`@M5Codex` 一次完成 Aily session 绑定；在这一步成功前不得宣称入站已通。之后发送指令
不需要额外关键字前缀。

## 5. 暂停、恢复与状态

在目标 task 中运行 `$feishu-unbind` 会把登记状态原子切换为 `paused`。此后入站
不再路由到该 task，Stop 不再入队，发布器也拒绝发送；原飞书话题、回执及 outbox 均保留。
再次运行 `$feishu-bind` 会复用原话题恢复，不创建第二条根消息。

`$feishu-status` 只读显示当前 task 是否接入、首次 mention 是否完成及待发布数量。
三条命令都必须在目标 task 本身运行，不支持按标题或 `--last` 跨会话操作。

## 6. 答复发布

Stop hook 使用精确 thread 匹配，把本地回合答复放入 task outbox 并立即自动发布。飞书入站
回合先只入队，待 watcher 严格确认终局后自动发布。失败事件保持待发资格，后续回合会重试。

升级前遗留的 outbox 不会自动补发。查看这些历史或异常待发正文不会发送：

```bash
node scripts/codex/drain-outbox.mjs --task-key <logical-task-key>
```

针对屏幕显示的历史积压取得本次发布授权后，才运行：

```bash
node scripts/codex/drain-outbox.mjs --task-key <logical-task-key> --apply
```

发送前会校验 lark-cli 凭据确实属于配置中的 M5Codex；发送成功才标记事件。

## 真实验证顺序

每一步单独授权，且不复用旧飞书消息：

1. 安装 hooks/skills 并确认 trust；
2. 建一个测试 task 绑定；
3. 用一条全新 mention 验证秒级 accepted、唯一 claim 和精确 thread；
4. 验证目标 task 产生非空最终答复、Stop/watcher 只形成一条事件；
5. 核对自动发布的 sender 确为 M5Codex、目标为原话题并完成 readback。

## 已知边界

- 当前 Aily codex-local adapter 仍可能受外层首语义事件计时器影响；本仓库脚本无法证明
  模型一定会在计时器前调用入站技能。
- 正在运行的 Desktop turn 不从另一个 CLI 进程强行 steer；hook lease 命中时返回 busy。
- App Server 原生 live steering 仍是后续验证项，不属于当前候选的已验证能力。
- 本地测试不能替代真实 Aily/M5Codex/飞书端到端证据。
