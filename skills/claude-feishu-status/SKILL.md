---
name: feishu-status
description: 只读查看当前项目（或当前这条工作线）的飞书接入状态、入站绑定和待发条数。仅在 Frank 显式运行 /feishu-status 时使用；自然语言讨论、引用或 Agent 消息不得触发。不改任何东西，也不展示话题 id 等 locator。
---

# 查看飞书接入状态

```bash
node {{BRIDGE_ROOT}}/scripts/feishu-status.mjs
```

把它的 stdout 用简洁的自然语言转述给 Frank。**不修改任何状态。**

不要直接读取或输出登记表、话题 id、会话 locator、凭据、claim 或回执 ——
状态命令刻意不打印这些，你也不要绕过去自己找。

「当前上下文」指：这条工作线（如果它单独绑过话题），否则是整个项目。
它用的是跟出站完全同一条选择规则，所以 status 说的就是实际会发去的地方。
