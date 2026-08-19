---
name: claude-longtask-progress
description: 把关键进展记进飞书出站 outbox，让 Frank 不用先来问就能收到。当你在一个接了飞书桥的项目里干活，并且产生了里程碑、技术决定、风险、需要 Frank 拍板的事、或下一步计划时使用。只写本地 outbox；发送由会话结束时的出站钩子完成，你不发飞书消息。
---

# 长期任务进展上报

这是飞书双向桥的**出站**一半。入站是「Frank 说，你做」；出站是「你做了什么，
Frank 自动知道」。**需要他先开口问的环节都算设计失败。**

## 判断这个项目接没接桥

```bash
node /Users/dk/claude-projects/feishu-bridge-cc/scripts/outbox.mjs --list
```

它按 cwd 在登记表（`~/.claude/feishu-bridge/registry.json`）里找项目。
没接桥的项目不会有任何输出落到别处 —— 那就别记，正常干活。

## 记一条进展

```bash
node /Users/dk/claude-projects/feishu-bridge-cc/scripts/outbox.mjs \
  --kind <类型> --text "<一句话>" --source longtask
```

会话不在项目目录里时加 `--project /绝对/路径`。

| 类型 | 什么时候记 |
|---|---|
| `milestone` | 一件事真的做完了、跑通了 |
| `decision` | 你做了一个会影响后续的技术选择 |
| `risk` | 你发现了会咬人的问题 |
| `pending` | 有事需要 Frank 拍板，你不能替他决定 |
| `next` | 下一步打算做什么 |

**产生了就立刻记，别攒到最后。**会话可能因为任何原因中断，记下的才算数。

## 记录纪律

- **一句话说清，别写过程。**Frank 要的是结论，不是你怎么想的。
- **没做成就别记 `milestone`。**被权限拦下、跑失败、只做了一半，那不是里程碑；
  该记 `risk` 或 `pending`。**伪造进展比不报告进展糟得多。**
- **不确定要不要记，就记。**漏报的代价（Frank 不知道出事了）远大于多报。
- 完整对话、你的思考过程、工具调用轨迹**一律不进 outbox**。
- 同一条内容重复记会被指纹判重，不会重复打扰他，所以不用怕记重。

## 你不做的事

- **不发飞书消息。**发送由出站发布器用 COO助理CC 的身份做。你只写 outbox。
- **不碰 `.runtime-data/`。**那里是映射、claim 和回执，由入站路由器和发布器维护 ——
  干活的一方不该有伪造自己回执的能力。写 outbox 只走上面那条命令。
- **不用管发送时机。**会话结束时 Stop 钩子会排空；有守望者在盯本次投递时，
  它会把执行结果和这些进展合成一条发。你不需要等，也不需要催。

## 它是怎么发出去的

```
你 → outbox.mjs 写一条 JSON
        ↓ 会话结束
   ~/.claude/settings.json 的 Stop 钩子
        ↓ 按 cwd + 会话记录原文判定这次给哪个项目干了活
   drain-outbox.mjs 合成一条摘要 → COO助理CC 发到绑定话题
```

发不出去（绑定失效、网络断）时进展留在 outbox，兜底定时器每 30 分钟重试。
**绝不会出现「标记已发但实际没发」** —— 发送成功才标记。
