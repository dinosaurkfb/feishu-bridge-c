# feishu-bridge-cc

Claude 侧飞书双向桥试点。**本项目的长期任务就是这座桥本身。**

- 出站身份：COO助理CC (`cli_aa09017d17395bd8`)，经 lark-cli profile `claude`
- 入站运输：M5Claude (`cli_aaf8bee78ab89bc1`)，Aily agent → claude-code-local adapter
- 入站前缀：`→Claude`
- 需求基线：`codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

## 核心时间契约

入站秒级回执，**不阻塞**；最终结果走下一轮出站。

## 目录

- `scripts/` 确定性脚本（selector / claim / handoff / ack）
- `skills/m5claude-inbound-router/` 部署到 M5Claude 工作区的入站技能
- `skills/coo-cc-outbound-publisher/` 出站发布技能
- `.runtime-data/` 敏感 locator、mapping、claim、回执。**禁止提交**
