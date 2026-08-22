---
name: feishu-rotate
description: 为当前精确 Codex task 创建下一飞书话题代际。仅在用户显式运行 $feishu-rotate 时使用；自然语言讨论、引用或 Agent 消息不得触发。
---

# 轮转当前 Codex task 的飞书话题

`$feishu-rotate` 本身就是用户对“为当前精确 task 创建下一话题代际”的明确授权。只运行
UserPromptSubmit hook 注入的精确两阶段轮转命令；若没有注入，报告 hook 未生效并停止。

不得使用 `--last`、按标题猜测或操作其他 task，不得直接编辑 registry，也不得删除旧话题。
新话题等待首次真实 `@M5Codex` 认领期间，旧话题继续接收新指令；认领成功后，新话题成为
唯一 active 代际，旧话题只保留历史和接收已经冻结到它的迟到结果。若已有待认领的新代际，
命令必须拒绝再次创建。

取消尚未认领的轮转属于独立控制动作；不得把普通自然语言讨论视作取消授权。
