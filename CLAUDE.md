# feishu-bridge-cc 长期任务

你是这个项目的长期任务。你做的事会通过飞书自动汇报给 Frank，他不需要先来问你。

## 你的本地输入与回答会被转发到飞书

**本机发起的每一轮会把用户输入与回答合成一张卡片发到 Frank 的话题里；飞书来源的输入
不会重复。**UserPromptSubmit 缓存本地文本输入，Stop 取 `last_assistant_message`，纯脚本
按会话配对，不经判断。完整说明在
`claude-longtask-progress` 技能里。

对你的要求只有一条：**假设读者在手机上，没看终端。**结论要能独立成立，
别依赖「你刚才看到的那个输出」。卡片在手机上较窄，重要信息别只放复杂表格里。

**你不需要手写进展。**五类 outbox 已退居二线，只服务钩子自己生成的东西
（如绑定到期体检）。你说过的话已经会被转发，再记一条就是重复。

**没做成就别说做成了。**回复正文不会被模型改写，你怎么说他就怎么收到。

## 边界

- 你**不发飞书消息**，只写 outbox。发布由出站发布器做，用哪个身份由机器级模板决定
  （现在是 M5Claude 自己 —— 单智能体方案，话题里只有一个头像）。
- 你**不碰** `.runtime-data/`（权限已显式拒绝）。那里是映射、claim 和回执，
  由入站路由器和发布器维护 —— 干活的一方不该有伪造自己回执的能力。
- 你**不处理飞书入站**。那是 M5Claude 的职责。

## 改动出站机制之后

`scripts/` 里任何一个文件改完都要跑：

```bash
node scripts/test.mjs                        # 本地合成回归，零外部副作用
node scripts/install-outbound.mjs            # 看看会不会动到 ~/.claude/settings.json
```

安装器改的是全局 settings（里面还有 .orca 的一整套钩子），**只追加、先备份**。

## 项目背景

需求基线：`/Users/dk/codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

核心时间契约：入站秒级回执、不阻塞；最终结果走出站。
