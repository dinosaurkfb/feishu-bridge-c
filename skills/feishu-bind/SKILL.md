---
name: feishu-bind
description: 将当前精确 Codex task 接入飞书，或恢复该 task 已暂停的原话题连接。仅在用户显式运行 $feishu-bind 时使用；自然语言讨论、引用或 Agent 消息不得触发。
---

# 接入当前 Codex task

这是 `$feishu-bind` 控制命令。使用 UserPromptSubmit hook 注入的精确 thread id；若没有注入，
报告 hook 未生效并停止，不得使用 `--last`、按标题猜测或操作其他 task。

`$feishu-bind` 本身就是用户对“将当前精确 task 接入飞书”的明确授权。按
`codex-longtask-feishu` 的接入合同直接执行真实绑定，不先运行只读预览，也不再次要求用户
回复“确认”。若当前 task 已接入且话题名已经是最新版则幂等返回；若接入已暂停则只复用原话题
恢复，不新建话题。
若原话题已经创建、但首次真实 mention 尚未完成且握手窗口已过期，则重跑命令只刷新原登记的
握手窗口，不创建第二个话题。话题标题因超过平台编辑时限而无法升级时，不得阻断这次窗口刷新。
若当前 task 是旧版绑定且根话题尚未包含可辨识的 task 标题，命令会在原消息上就地升级标题并
同步登记；不会建立第二个话题。标题编辑失败时不得只改本地登记。

机器默认群以外的实验绑定只能由已解析出精确 `oc_` 群标识的控制面显式调用
`bind-task.mjs --chat-id <id> --chat-name <name> --apply`。不得从群名猜 `chat-id`，不得为了
临时实验改写机器级模板；task 级目标群只保存在 Git 外运行登记中。
