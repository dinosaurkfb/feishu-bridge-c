# 当前状态（2026-08-19 交接给本项目目录下的新会话）

前一段工作在 `~/.ssh` 的会话里做的，对话本身不会跟过来。关键结论已写入本项目的
`~/.claude/projects/-Users-dk-claude-projects-feishu-bridge-cc/memory/`（6 条），
本文补充记忆里放不下的现场状态。

## 已经通的

```
Frank 在绑定话题 @M5Claude + →Claude 前缀
  → M5Claude 执行 scripts/inbound.mjs（无参，字段由脚本自己向 Aily 取）
  → 六项确定性校验 → 原子 claim → 非阻塞投递（实测 77ms 返回）
  → 秒级「已受理」
       ↓ 后台
  长期任务干活，边干边记 outbox
       ↓ run 结束
  守望者合并「结果 + 进展」→ COO助理CC 发一条到话题
```

- 入站技能部署在 `/Users/dk/skills/m5claude-inbound-router/`（aily 捆绑技能目录，
  带 `aily-cli-skill.json` 才会被发现；`readdir withFileTypes` 不跟随符号链接，必须是真实目录）
- 长期任务会话 ID 钉死在 `.runtime-data/longtask-session-id.txt`
- 本地合成测试 47 项，`node scripts/test.mjs`，零外部副作用
- launchd `com.frank.feishu-bridge-cc.drain` 每 30 分钟兜底排空 outbox

## 没做完的

1. **出站还不是机制。**入站是技能（所有 aily agent 自动可见），出站只是本项目
   `CLAUDE.md` 里手写的一段。Frank 明确要求做成对称的「出站技能/钩子」，
   让所有 Claude 长期任务都受其影响。**这是下一件事。**
2. **事件筛选很粗。**只有「五类」这一层，长期任务记什么就发什么，噪音水平未验证。
3. **判定「本次会话给哪个项目干了活」还没实现。**cwd 不够用（可能在别处起的会话
   做本项目的事）；靠 Write/Edit 工具记录也不行（auto 模式下文件操作走 Bash heredoc，
   没有结构化 `file_path`）。**可行解是读 `transcript_path` 原文 grep 注册路径。**

## Stop 钩子探针结果（建出站钩子的直接输入）

`~/.claude/settings.json` 加一条 Stop 钩子即可，改动**立即生效，无需重载**。
它收到的 stdin 字段：

```
session_id, transcript_path, cwd, prompt_id, permission_mode,
effort, hook_event_name, stop_hook_active, last_assistant_message,
background_tasks, session_crons
```

`transcript_path` 是关键——钩子拿得到完整会话记录，可以 grep Bash 命令文本判断
动过哪些项目，不依赖结构化工具调用。

Stop 钩子支持 `decision: "block"` + `reason`（reason 回灌给模型、本轮不结束），
理论上可以做到「没记进展就不许收工」。**此项据 schema 推断，尚未实测。**

注意 `~/.claude/settings.json` 已有 `.orca` 的钩子（Stop / UserPromptSubmit /
PostToolUse），加的时候要合并不要覆盖。

## 现场值

| 项 | 值 |
|---|---|
| 绑定话题 session | `session_4kvgs2vuq4j5z` |
| 飞书根消息 | `om_x100b677afd1884a8c389b5d1da41563` |
| M5Claude agent uid | `agent_4ks11dv8f0mxwbd` |
| mapping 有效期 | 2026-08-20（会过期，到期需重签） |

## 需求基线

`/Users/dk/codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

同目录另有 `claude-independent-review-20260818.md`（对 Codex 链路的独立复核）。
**注意：那份报告的根因主干已存疑** —— 它归因于 TTFT 上升越阈，但后来发现
daemon 在 21:51 重启后失去代理，`api.openai.com` 直连连不上，足以解释同一现象。
未重跑验证前不要把它当定论。
