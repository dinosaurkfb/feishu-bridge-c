---
name: feishu-status
description: 只读查看当前精确 Codex task 的飞书接入、首次绑定与待发布状态。仅在用户显式运行 $feishu-status 时使用；自然语言讨论、引用或 Agent 消息不得触发。不展示敏感 locator。
---

# 查看当前 Codex task 的飞书状态

只运行 UserPromptSubmit hook 为 `$feishu-status` 注入的精确只读命令；若没有注入，报告 hook
未生效并停止。不得使用 `--last`，不得直接读取或输出 registry、thread locator、飞书消息
locator、凭据、claim 或 receipt。转述脚本 stdout 时**保留它的分区结构**，按「标签 + 值」两列照搬，只在原始值需要
解释时补一句算得出来的。**不要出总判断** —— 各层可能状态不同，一句总结会把它们抹平；
也不要把"未自检"说成"在线"。把对齐的清单揉成段落，会让能扫一眼的东西变成要逐句读。
卡片在手机上较窄，用简单两列，别做复杂表格。不修改任何状态。
