---
name: feishu-bind
description: 将当前精确 Codex task 接入飞书，或恢复该 task 已暂停的原话题连接。仅在用户明确调用或明确要求绑定当前 task 时使用；普通项目工作不得触发。
---

# 接入当前 Codex task

这是 `$feishu-bind` 控制命令。使用 UserPromptSubmit hook 注入的精确 thread id；若没有注入，
报告 hook 未生效并停止，不得使用 `--last`、按标题猜测或操作其他 task。

`$feishu-bind` 本身就是用户对“将当前精确 task 接入飞书”的明确授权。按
`codex-longtask-feishu` 的接入合同直接执行真实绑定，不先运行只读预览，也不再次要求用户
回复“确认”。若当前 task 已接入则幂等返回；若接入已暂停则只复用原话题恢复，不新建话题。
