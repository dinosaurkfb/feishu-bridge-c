---
name: feishu-bind
description: 将当前精确 Codex task 接入飞书，或恢复该 task 已暂停的原话题连接。仅在用户明确调用或明确要求绑定当前 task 时使用；普通项目工作不得触发。
---

# 接入当前 Codex task

这是 `$feishu-bind` 控制命令。使用 UserPromptSubmit hook 注入的精确 thread id；若没有注入，
报告 hook 未生效并停止，不得使用 `--last`、按标题猜测或操作其他 task。

按 `codex-longtask-feishu` 的接入合同执行只读预览。新接入只有在用户针对预览明确确认后
才能真实创建飞书话题；恢复已暂停的连接只复用原话题，不创建或发送飞书消息。
