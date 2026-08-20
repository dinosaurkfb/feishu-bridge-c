---
name: feishu-status
description: 只读查看当前精确 Codex task 的飞书接入、首次绑定与待发布状态。仅用于连接状态检查，不读取或展示敏感 locator。
---

# 查看当前 Codex task 的飞书状态

只运行 UserPromptSubmit hook 为 `$feishu-status` 注入的精确只读命令；若没有注入，报告 hook
未生效并停止。不得使用 `--last`，不得直接读取或输出 registry、thread locator、飞书消息
locator、凭据、claim 或 receipt。用简洁自然语言转述脚本 stdout，不修改任何状态。
