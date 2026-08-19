# feishu-bridge-cc

Claude 侧飞书双向桥试点。**本项目的长期任务就是这座桥本身。**

- 出站身份：COO助理CC (`cli_aa09017d17395bd8`)，经 lark-cli profile `claude`
- 入站运输：M5Claude (`cli_aaf8bee78ab89bc1`)，Aily agent → claude-code-local adapter
- 入站前缀：`→Claude`
- 需求基线：`codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

## 核心时间契约

入站秒级回执，**不阻塞**；最终结果走下一轮出站。

## 两个方向都是机制，不是约定

| | 入站 | 出站 |
|---|---|---|
| 载体 | aily 捆绑技能 `m5claude-inbound-router` | 用户级 Stop 钩子 + 全局技能 `claude-longtask-progress` |
| 生效范围 | 所有 aily agent | 本机所有 Claude 会话 |
| 触发 | Frank 在绑定话题 @M5Claude + `→Claude` 前缀 | 会话结束（兜底：launchd 每 30 分钟） |
| 判定对象 | 六项确定性校验 + 原子 claim | 登记表里的项目 + 会话归属判定 |

出站不再依赖某个 `CLAUDE.md` 里的手写约定 —— 换目录、换会话都还在。

## 装出站

```bash
node scripts/install-outbound.mjs          # dry-run，看看会改什么
node scripts/install-outbound.mjs --apply
```

它做三件事：往 `~/.claude/settings.json` 的 Stop 数组**追加**一条（先备份，
不动 .orca 那套）、把本项目写进 `~/.claude/feishu-bridge/registry.json`、
把进展技能拷进 `~/.claude/skills/`。幂等，可 `--uninstall`。

## 目录

- `scripts/` 确定性脚本（selector / claim / handoff / outbox / drain / stop-hook）
- `skills/m5claude-inbound-router/` 部署到 M5Claude 工作区的入站技能
- `skills/claude-longtask-progress/` 部署到 `~/.claude/skills/` 的出站进展技能
- `.runtime-data/` 敏感 locator、mapping、claim、回执。**禁止提交**

## 自检

```bash
node scripts/test.mjs                       # 本地合成回归，零外部副作用
node scripts/outbox.mjs --list              # 还有多少进展没发出去
node scripts/drain-outbox.mjs --all --dry-run
tail ~/.claude/feishu-bridge/stop-hook.log  # 出站钩子每次干了什么
```
