---
name: codex-longtask-feishu
description: 仅供用户直接操作本机 Codex Desktop/CLI task 时，接入、恢复、暂停或只读检查该 task 与飞书话题的受控连接，并查看或授权发布待发答复。若当前是 Aily/M5Codex 响应飞书 mention（存在 AILY_CLI_* 运行上下文），严禁使用本技能，必须改用 m5codex-inbound-router；不得因普通项目工作自动接入或发送。
---

# Codex task 飞书桥

本技能属于 Codex task 的控制面，不属于 M5Codex 的飞书消息处理面。若当前调用来自 Aily
且正在处理真实 `@M5Codex`，立即停止本流程并使用 `m5codex-inbound-router`；尤其不得拿
M5Codex 自己的 Aily 工作区或 Codex thread 去运行绑定预览。

绑定单位是精确 Codex thread，不是项目目录；同一仓库可以有多个独立话题。不得使用
`--last`，也不得把另一个 task 的 thread id 当作当前 task。

## 接入

只有用户明确要求接入或建话题时才做。UserPromptSubmit hook 会提供当前 thread id。

先运行纯只读预览：

```bash
node {{BRIDGE_ROOT}}/scripts/codex/bind-preview.mjs --project <当前项目绝对路径> --thread-id <当前thread-id>
```

把脚本打印的根消息交给用户确认。用户针对这次建话题明确同意后，才运行：

```bash
node {{BRIDGE_ROOT}}/scripts/codex/bind-task.mjs --project <当前项目绝对路径> --thread-id <当前thread-id> --apply
```

真实命令会用同一个 M5Codex 身份建根话题并写机器级 registry。它不向项目目录写 locator。
建完后还需用户在新话题中真实 @M5Codex 一次，入站绑定才完成；在此之前不得说入站已通。
后续只需在绑定话题里真实 `@M5Codex`；mention 后正文直接作为指令，不需要关键字前缀。

若预览显示当前 task 的接入已暂停，`bind-task.mjs --apply` 只把原登记恢复为 active，复用
原话题且不调用飞书 API；不得新建第二个话题。

## 初始化后的询问

Codex 官方 `/init` 用于生成项目 `AGENTS.md`，不是绑定命令。UserPromptSubmit hook 只给该轮
补充约束：先完成原生初始化，成功后在最终答复末尾询问是否接入；不得在 `/init` 本轮自动
建话题。用户随后明确回复“接入飞书”或运行 `$feishu-bind`，才进入上面的预览和
逐次授权流程。

## 暂停与状态

`$feishu-unbind` 是对当前 task 的可恢复本地暂停授权。只运行 hook 注入的命令：

```bash
node {{BRIDGE_ROOT}}/scripts/codex/feishu-unbind.mjs --thread-id <当前thread-id> --apply
```

暂停后，飞书入站不再路由到该 task，Stop 不再入队，发布器也拒绝发送；原话题、映射、
回执和待发布答复保留。命令不得删除飞书内容或发出“已暂停”消息。再次接入会恢复原连接。

`$feishu-status` 只运行只读状态命令并转述 stdout：

```bash
node {{BRIDGE_ROOT}}/scripts/codex/feishu-status.mjs --thread-id <当前thread-id>
```

不得为了显示状态而直接输出 registry 或任何 locator。

## 答复与发布

绑定 task 的 Stop hook 会把每轮 `last_assistant_message` 原样写入本地 outbox。入队不代表
已发送。查看某个 task 的待发布正文：

```bash
node {{BRIDGE_ROOT}}/scripts/codex/drain-outbox.mjs --task-key <logical-task-key>
```

只有用户明确授权本次真实发布后，才在同一命令后加 `--apply`。发布使用 M5Codex 自己的
凭据，发送成功后才标记事件；失败保持 pending。不得安装定时排空、不得自动重放。

## 边界

- 不直接编辑 `~/.codex/feishu-bridge` 下的 registry、claim、receipt 或 outbox。
- 不把 task/thread、飞书 locator、凭据或本机状态写进 Git、文档或回复。
- 入站“已受理”不是完成；被权限拦截或执行失败必须如实表述。
