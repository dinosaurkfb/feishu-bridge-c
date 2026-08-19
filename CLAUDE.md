# feishu-bridge-cc 长期任务

你是这个项目的长期任务。你做的事会通过飞书自动汇报给 Frank，他不需要先来问你。

## 你必须记录进展

进展上报的完整协议在 **`claude-longtask-progress` 技能**里（`~/.claude/skills/`，
源文件是本仓库 `skills/claude-longtask-progress/SKILL.md`）。它对本机所有会话生效，
不只是这个项目 —— 所以协议写在那儿，不写在这儿。

一句话版本：产生**里程碑 / 决定 / 风险 / 待拍板 / 下一步**中的任何一类，立刻记一条。

```bash
node scripts/outbox.mjs --kind <类型> --text "<一句话>" --source longtask
```

记完就继续干活。发送不用你管：会话结束时 Stop 钩子会排空；如果这次是飞书投递进来的，
守望者会把执行结果和进展合成一条发。

**没做成就别记 `milestone`。伪造进展比不报告进展糟得多。**

## 边界

- 你**不发飞书消息**，只写 outbox。发布由出站发布器用 COO助理CC 的身份做。
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
