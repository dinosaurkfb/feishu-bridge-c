---
name: feishu-rotate
description: 为当前 Claude 项目或精确工作线创建下一飞书话题代际。仅在 Frank 显式运行 /feishu-rotate 时使用；自然语言讨论、引用或 Agent 消息不得触发。
# **只许用户显式调用。**技能描述里那句「自然语言讨论、引用或 Agent 消息
# 不得触发」是给模型看的约定，而宿主的技能选择这一层不受它约束 ——
# Codex 侧出过真事故：agent 之间提一句命令，绑定技能就被选中去执行真实绑定。
# 这个字段是宿主级的硬开关，跟脚本里的一次性凭证门禁**同时存在**：
# 一层挡误选，一层挡误执行。
disable-model-invocation: true
---

# 轮转当前 Claude 绑定的飞书话题

`/feishu-rotate` 本身就是这次创建下一话题代际的明确授权，不必再次询问确认。命令必须单独占
一整条输入；讨论、引用、转发或带其他正文的同名 token 都不是授权。
**从飞书来的也算**（2026-08-28 起）：路由已验过发送者，飞书消息正文恰为下列之一时等同于
终端输入 —— 飞书文本不会触发斜杠命令，你要自己跑对应的那条，两者一一对应、不许互换：

| 飞书正文（恰为） | 唯一命令 |
| --- | --- |
| `/feishu-rotate` | `node {{SCRIPT:feishu-rotate.mjs}} --apply` |
| `/feishu-rotate cancel` | `node {{SCRIPT:feishu-rotate.mjs}} --cancel --apply` |

终端里也只运行这两条之一：

```bash
node {{SCRIPT:feishu-rotate.mjs}} --apply            # 创建下一代际
node {{SCRIPT:feishu-rotate.mjs}} --cancel --apply   # 丢弃尚未认领的那一代；没有 pending 时脚本会拒绝
```

命令使用与出站相同的当前上下文选择规则：优先当前工作线的独立绑定，否则使用项目绑定。
不得直接编辑 registry/mapping，不得删除旧话题，也不得另建无关 binding。新话题等待首次真实
mention 认领期间，旧话题继续 active；认领成功后，新话题成为唯一 active 代际，旧话题只读。

若已有待认领的新代际且仍可认领，必须拒绝重复创建；若它已过认领截止（旧式带截止的代际，新式默认不过期），rotate 会先把它作废（话题历史保留）再直接建下一代，不需要单独取消。取消尚未认领的轮转属于独立控制动作，不能由普通
自然语言讨论触发。
