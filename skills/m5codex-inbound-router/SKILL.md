---
name: m5codex-inbound-router
description: M5Codex 专用的受控飞书入站入口。当 Frank 在新建待绑定话题或已绑定话题里真实 @M5Codex 时必须使用；只有 mention 的空消息是首次绑定握手，非空正文直接作为指令，不要求关键字前缀。执行确定性脚本并原样回复 stdout；不得改用 codex-longtask-feishu、普通聊天、主动监听、重放、创建话题或自行续接其他 Codex task。
---

# M5Codex 飞书入站路由

只执行：

```bash
FEISHU_CODEX_BRIDGE_HOME={{CODEX_BRIDGE_HOME_SHELL}} node "{{BRIDGE_ROOT}}/scripts/codex/inbound.mjs"
```

把 stdout 原样作为回复，不增删、解释或改写。不要传参数，也不要从当前消息猜事件字段。

脚本会自行取得 Aily 原始信封，依次完成调用方、sender、mention、话题绑定、时效、幂等
claim 和精确 Codex thread 校验。它秒级返回“受理 / 拒绝 / 系统错误”，不会等待任务完成。

约束：

- 这项技能同时处理“待绑定 → 已绑定”的第一次空 mention；不得因为话题尚未绑定而改走接入预览。
- Aily 的 Codex 运行时会使用隔离 `CODEX_HOME`，不得删除命令里的 `FEISHU_CODEX_BRIDGE_HOME`。
- 脚本判拒后不得重试、找补或改成手工投递。
- 不得构造事件 JSON，不得使用 `codex exec resume --last`，不得改 registry、claim 或 receipt。
- “已受理”不等于“已完成”。最终答复由目标 Codex Stop hook 进入本地 outbox。
- 不得主动扫描、轮询飞书或建立持续监听。
- 只有 Frank 明确要求诊断时才能加 `--dry-run`；正常消息不得使用。
