---
name: feishu-mode
description: 查看或显式切换当前精确 Codex task 的 Mapping/Dialogue 交互模式。仅在用户显式运行 $feishu-mode、$feishu-mode dialogue 或 $feishu-mode mapping 时使用；自然语言讨论、引用或 Agent 消息不得触发。
---

# 设置当前 Codex task 的飞书交互模式

只执行 UserPromptSubmit hook 为本轮注入的精确命令。**从飞书来的 `$feishu-mode dialogue` / `$feishu-mode mapping`
不经过模型**：入站路由器在验过发送者、真实 @ 和 claim 之后当场切换并回执（2026-08-28 起）。不得使用 `--last`，不得直接编辑 registry，
不得从普通自然语言推断模式变更。无参数 `$feishu-mode` 只读查看；`dialogue` 和 `mapping` 是两种
唯一合法写操作。

Dialogue v1 是单主持者、单授权人、串行回合，默认 12 轮、2 小时、12 资源单位；Agent 输出不会
自动成为下一轮输入。切回 Mapping 会人工中止尚未结束的 Dialogue 后续编排，但不删除历史话题、
claim、run 或已产生的答复。
