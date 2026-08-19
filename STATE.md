# 当前状态（2026-08-19，出站已成机制）

记忆在 `~/.claude/projects/-Users-dk-claude-projects-feishu-bridge-cc/memory/`，
本文补充记忆里放不下的现场状态。

## 已经通的

### 入站（技能，对所有 aily agent 生效）

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

- 技能部署在 `/Users/dk/skills/m5claude-inbound-router/`（aily 捆绑技能目录，
  带 `aily-cli-skill.json` 才会被发现；`readdir withFileTypes` 不跟随符号链接，必须是真实目录）
- 长期任务会话 ID 钉死在 `.runtime-data/longtask-session-id.txt`

### 出站（Stop 钩子 + 登记表 + 全局技能，对本机所有 Claude 会话生效）

```
任何会话在登记项目里干活 → node scripts/outbox.mjs --kind ... 写一条
       ↓ 会话结束
~/.claude/settings.json 的 Stop 钩子 → scripts/stop-hook.mjs
       ↓ 归属判定：cwd 在项目里 OR 会话记录原文里出现项目路径
  有守望者在盯 → 让路（它会把结果和进展合成一条）
  没有         → drainProject 合成摘要 → COO助理CC 发到绑定话题
```

- 装/卸：`node scripts/install-outbound.mjs [--apply|--uninstall --apply]`，幂等，先备份
- 登记表 `~/.claude/feishu-bridge/registry.json`，技能 `~/.claude/skills/claude-longtask-progress/`
- 钩子日志 `~/.claude/feishu-bridge/stop-hook.log`
- launchd `com.frank.feishu-bridge-cc.drain` 每 30 分钟兜底（plist 里可加 `--all` 排空全部登记项目）
- 本地合成测试 72 项，`node scripts/test.mjs`，零外部副作用

**实测过的**（2026-08-19）：

| 路径 | 结果 |
|---|---|
| 真实无头会话结束 → 钩子发布 | ✅ `om_x100b67601a83bca0ddca45aa2edc3d1`，4 条进展一次发出 |
| 守望者活着 → 让路不发 | ✅ 日志 `deferred to watcher`，outbox 原封不动 |
| 发布失败 → 如实报告 + 留在 outbox | ✅ 不伪造已送达，报错 JSON 不喷终端 |
| 未接桥的会话 | ✅ 约 45ms 退出，无输出 |
| 登记表坏/缺、空 stdin、node 缺失 | ✅ 都不崩，缺 node 会往日志留 `hook-unavailable` |

## 没做完的

1. **事件筛选仍然很粗。**只有「五类」这一层，长期任务记什么就发什么，
   噪音水平还是没验证过 —— 需要跑几天真实使用才知道 Frank 会不会被刷。
2. **「没记进展就不许收工」没做。**Stop 钩子的 `decision: "block"` + `reason`
   （reason 回灌给模型、本轮不结束）**仍未实测**，只是 schema 上看得到。
   要做的话，判据得是「这次会话在登记项目里动过文件却一条 outbox 都没记」。
3. **多项目还没真跑过。**登记表结构支持 N 个项目，但只有本项目配了
   chain-config / active-mapping，第二个项目接进来时的绑定怎么发是空白。

## 现场值

| 项 | 值 |
|---|---|
| 绑定话题 session | `session_4kvgs2vuq4j5z` |
| 飞书根消息 | `om_x100b677afd1884a8c389b5d1da41563` |
| M5Claude agent uid | `agent_4ks11dv8f0mxwbd` |
| mapping 有效期 | 见 `active-mapping.json`；**这是入站唯一的闸** |
| mapping 配额 | 已退役（`max_inbound_messages: "unlimited"`） |

有效期到期后：入站一律拒（回执「绑定关系已过期」），**出站不受影响**——
`drainProject` 只看 `status === "active"`。会变成"任务能说、Frank 不能回"。
到期前 30 天 / 7 天各自动往 outbox 记一条预警（`scripts/binding-health.mjs`），
文案不含天数，靠 outbox 指纹判重保证每档只发一次。

## 需求基线

`/Users/dk/codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

同目录另有 `claude-independent-review-20260818.md`（对 Codex 链路的独立复核）。
**注意：那份报告的根因主干已存疑** —— 它归因于 TTFT 上升越阈，但后来发现
daemon 在 21:51 重启后失去代理，`api.openai.com` 直连连不上，足以解释同一现象。
未重跑验证前不要把它当定论。
