# 当前状态（2026-08-19，出站已成机制）

记忆在 `~/.claude/projects/-Users-dk-claude-projects-feishu-bridge-cc/memory/`，
本文补充记忆里放不下的现场状态。

## 已经通的

### 入站（技能，对所有 aily agent 生效）

```
Frank 在绑定话题 @M5Claude + →Claude 前缀
  → M5Claude 执行 scripts/inbound.mjs（无参，字段由脚本自己向 Aily 取）
  → 六项确定性校验 → 原子 claim → 路由 → 秒级「已受理」（实测 77ms）
       ↓
  ┌ 现场有活着的交互会话？
  ├ 有 → 起一个极小无头会话，用 SendMessage 把指令投进去
  │      结果由那个会话自己的 Stop 钩子发布（不用守望者、不用会话锁）
  └ 无 → claude --continue 后台起一轮 + 一次性守望者
         守望者合并「结果 + 进展」→ COO助理CC 发一条到话题
```

- **入站没有本地技能。已判决（2026-08-19）**：把 `~/skills/m5claude-inbound-router/`
  改名后从飞书发指令，**照常受理**（`msg_4kvn227q33txt`，重试 0 次）。
  那个位置从未被读取。原记载「部署在 `/Users/dk/skills/`，带 `aily-cli-skill.json`
  才会被发现」**两句都是错的**。旁证：
  - claude-code-local adapter 的技能注入只从三处取：`bundledSkillsRoot`、
    `~/.aily-cli/skills`（本机不存在）、`~/.claude`。**`~/skills/` 不在其中。**
  - 真正在工作的 Codex 链路把技能放在 `~/aily_workspaces/<agent_uid>/.agents/skills/`，
    而且**只有 `SKILL.md`，没有 `aily-cli-skill.json`**。
  - M5Claude 的 `~/aily_workspaces/agent_4ks11dv8f0mxwbd/` **整个目录是空的**，
    而 `resolveAndPinInvokeWorkspacePath` 把它钉成 M5Claude 的 workspace。
  - adapter 明确避开 project 级 `.claude/skills`，改用每次调用私有的 plugin 目录，
    内容由平台侧的 `skillRefs` 决定。
  所以：让 M5Claude 去跑 `inbound.mjs` 的指令**来自 Aily 平台侧的 agent 配置**。
  仓库里 `skills/m5claude-inbound-router/SKILL.md` 现在的定位是**平台指令的底稿**，
  改它不会生效，必须同步改平台。
- **入站的真实配置不在版本管理里，也无法被本地安装器复现。**这是目前最大的
  可重建性缺口：换台机器，出站四样能一条命令装回来，入站要人去 Aily 平台重配。
- 两条分支**必须互斥**：都走 `--continue` 会有两个进程写同一份 transcript
- `.runtime-data/longtask-session-id.txt` **已废弃，没有代码再读它**。
  钉一个会话 UUID 是错的抽象 —— 会话是记录，每开一个终端就是新的一份，
  钉住的那份很快就不再是工作发生的地方（实测钉住的是一堆联调残渣，
  11 条指令里 9 条是「数到 3」「写个 HELLO-BRIDGE.txt」）
- 投递给 `--continue` 的指令会盖上 `[飞书 · msg_xxx · 时间]` 来源戳，
  否则在终端里看不出哪条来自飞书
- 事件只取最近 2 轮（`--page-size`，单位是对话轮次），不再每次搬整个话题史

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
4. **投进现场会话的权限边界没定。**指令进了交互会话就按**那个会话的权限**跑
   （本项目是 `acceptEdits` + 一串 allowlist），而不是长期任务那份更窄的。
   回执里已记 `delivery_mode` / `target_session_id` 留痕，但要不要限制、怎么限制没定。
5. **「起长期任务会话」还不是建绑定的正式步骤。**没有它 `--continue` 无从续起，
   代码现在如实拒绝（`no_prior_session`）而不兜底 —— 但流程文档里还没写这一步。

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

- 看和续：`node scripts/binding.mjs [--renew 1y --apply]`，dry-run 默认，写前留 `.prev`
- 预警：到期前 30 天 / 7 天各往 outbox 记一条（`scripts/binding-health.mjs`）。
  文案不含天数、自带续期命令——靠 outbox 指纹判重保证每档只发一次
- 续期是**人工命令**，不自动。长期任务不该有单方面延长自己授权的能力，
  这也是 `.runtime-data/` 对它写权限被显式拒绝的原因

## 需求基线

`/Users/dk/codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

同目录另有 `claude-independent-review-20260818.md`（对 Codex 链路的独立复核）。
**注意：那份报告的根因主干已存疑** —— 它归因于 TTFT 上升越阈，但后来发现
daemon 在 21:51 重启后失去代理，`api.openai.com` 直连连不上，足以解释同一现象。
未重跑验证前不要把它当定论。
