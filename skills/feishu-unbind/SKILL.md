---
name: feishu-unbind
description: 可恢复地暂停当前精确 Codex task 的飞书接入。仅在用户明确调用或明确要求撤销当前 task 接入时使用；不删除原话题或历史。
---

# 暂停当前 Codex task 的飞书接入

`$feishu-unbind` 本身就是用户对这次可恢复本地暂停的明确授权。只运行 UserPromptSubmit hook
注入的精确暂停命令；若没有注入，报告 hook 未生效并停止。不得使用 `--last`，不得直接
编辑 registry，不得删除原飞书话题、映射、回执或待发布答复，也不得向飞书发送消息。
