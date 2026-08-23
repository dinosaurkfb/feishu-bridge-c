---
name: feishu-mode
description: 查看或显式切换当前 Claude 项目/工作线的 Mapping/Dialogue 交互模式。仅在 Frank 显式运行 /feishu-mode、/feishu-mode dialogue 或 /feishu-mode mapping 时使用；自然语言讨论、引用或 Agent 消息不得触发。
---

# 设置当前 Claude binding 的飞书交互模式

命令必须单独占据整条输入，只允许三种形式：

```bash
node {{SCRIPT:feishu-mode.mjs}}
node {{SCRIPT:feishu-mode.mjs}} --mode dialogue --apply
node {{SCRIPT:feishu-mode.mjs}} --mode mapping --apply
```

无参数只读查看。Dialogue v1 是单主持者、单授权人、串行回合，默认 12 轮、2 小时、12 资源单位；
Agent 输出不会自动成为下一轮输入。切回 Mapping 会人工中止尚未结束的 Dialogue 后续编排，但不
删除历史话题、claim、run 或已产生的答复。不得直接编辑 registry/mapping，也不得把自然语言讨论
升级成模式切换授权。
