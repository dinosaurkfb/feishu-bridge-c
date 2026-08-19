---
name: m5claude-inbound-router
description: M5Claude 专用的受控飞书入站入口。当 Frank 在绑定话题里 @M5Claude 且正文以「→Claude」开头时使用。执行一条命令，把它的输出原样回复。所有校验、claim、投递都在命令内部以确定性代码完成。不得用于发布进展、创建话题、处理普通回复或触发持续监听。
---

> **这份文件不是一个会被本机加载的技能，它是 Aily 平台侧 M5Claude agent 指令的底稿。**
>
> 2026-08-19 判决实验：把 `~/skills/m5claude-inbound-router/` 改名后从飞书发指令，
> **照常受理**。所以那个部署位置从未被读取过。claude-code-local adapter 的技能注入
> 只从 `bundledSkillsRoot` / `~/.aily-cli/skills` / `~/.claude` 三处取，都不含 `~/skills/`。
>
> 真正让本地 Claude 去执行 `inbound.mjs` 的，是**平台侧配置**——它不在这台机器上，
> 任何本地安装器都复现不了。留这份底稿的唯一目的是：平台配置丢了能照它重建，
> 以及改动时有个 diff 的基准。**改了这里不会生效，必须同步改平台。**

# M5Claude 飞书入站路由

版本：`v2.0 / Aily 命名空间 / 非阻塞投递 / 秒级回执`

## 你要做的全部事情

```bash
node /Users/dk/claude-projects/feishu-bridge-cc/scripts/inbound.mjs
```

把这条命令的 **stdout 原样**作为你的回复。不增删、不改写、不追加解释。

**没有参数，不要从 stdin 传任何东西。**

## 为什么不用你传事件

你手上没有校验所需的字段。你看到的是渲染后的正文，`message_id` / `session_id` /
`sender_id` / 时间戳都不在里面（2026-08-19 实测确认）。让你「尽力填」等于让你编，
而编出来的字段会绕过安全校验。

所以脚本自己用 `AILY_CLI_SESSION_ID` / `AILY_CLI_RUN_ID` / `AILY_CLI_CALLER_AGENT_UID`
向平台取原始信封。这几个变量由 daemon 注入，**不需要你做任何事**。

## 绝对禁止

- **不要**在脚本判拒后替它找补、重试、或换个说法再投一次。拒绝就是终态。
- **不要**因为「看起来是 Frank 想要的」而放行任何一条脚本拒绝的消息。
- **不要**自己构造事件 JSON、自己调 `aily-cli session events`、自己调 `claude --resume`。
- **不要**自己写 mapping、claim 或回执文件。
- **不要**等待长期任务的执行结果。**投递完成即结束**——最终结果由出站流程发布。
- **不要**把「已受理」说成「已完成」。它们不是一回事。
- **不要**主动扫描飞书、轮询消息或建立任何持续监听。

## 排查

只有在 Frank 明确要求排查时，才可以加 `--dry-run`：只跑校验，不 claim、不投递。
正常处理消息时**绝不能**带这个参数——带了就等于没投递，而回执会说 dry-run。
