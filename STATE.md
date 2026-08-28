# 当前状态（2026-08-20，双向都成机制）

记忆在 `~/.claude/projects/-Users-dk-claude-projects-feishu-bridge-cc/memory/`，
本文补充记忆里放不下的现场状态。

## 已经通的

### 接一个新项目：一次回答 + 一次批准 + 一个 @

```
在新项目目录里敲 /init
  → UserPromptSubmit 钩子（scripts/init-hook.mjs）注入一段上下文
  → 那个会话写完 CLAUDE.md，跑一次 bind-preview（已放行，免确认）
  → 它问：要不要在群里给这个项目建一个根话题？默认「是」
  → 你选是 → bind-project --apply（弹一次权限）→ 建话题 + 登记表加一行
  → 你去新话题 @ 一下 M5Claude（空消息也行）→ 入站绑定完成
```

**接入只产生一条新事实**：登记表里的一行（`root_message_id` / `session_id` /
`name` / `purpose` / `expires_at`）。项目目录里**不写任何配置文件**。

- 群、身份、profile、授权发送者、时效 —— 全在机器级模板
  `~/.claude/feishu-bridge/chain-config.json`，装机器时配一次（`init-chain-template.mjs`）
- 项目叫什么、干什么 —— 从 README.md / CLAUDE.md 取（一级标题 + 第一段第一句），
  取不到就用目录名，**绝不为取名字失败**
- `scripts/project-resolve.mjs` 把「从哪读」收敛成一处：项目目录里有配置就用它，
  没有就回落到「机器模板 + 登记表那一行」。**两种形式读取方分不出区别**

**为什么入站要多那一个 @**：建话题的那一刻 Aily 的 session 还不存在 ——
它是第一条消息流进来才产生的，而绑定的核心闸就是 session_id。所以绑定必然分两段。

### 入站（技能，对所有 aily agent 生效）

```
Frank 在某个项目的话题里 @M5Claude（前缀已退役）
  → M5Claude 执行 scripts/inbound.mjs（无参，字段由脚本自己向 Aily 取）
  → 取信封（只靠 daemon 注入的环境变量，不读任何项目配置 —— 所以没有死结）
  → session_id 去所有登记项目里找绑定  ← 多绑定路由
       ├ 对上了 → 那个项目
       └ 没对上 → 待绑定认领（见下）
  → 由绑定推出项目根，claim/回执/锁/runs 全挂到那个根下
  → 确定性校验 → 原子 claim → 路由 → 秒级「已受理」
       ↓
  ┌ 现场有活着的交互会话？
  ├ 有 → 起一个极小无头会话，用 SendMessage 把指令投进去
  │      结果由那个会话自己的 Stop 钩子发布
  └ 无 → claude --continue 后台起一轮 + 一次性守望者（要传项目根）
```

**待绑定认领**（`scripts/inbound-route.mjs`）—— 在「还不知道是哪个项目」时守住的闸：

1. 发送者是不是 Frank（机器模板里的 `frank_sender_id`）
2. 有没有**真实** `<at>` 运输 agent（手打「@名字」不算）
3. 消息新不新
4. 全机同时**只有一份**待绑定
5. 待绑定**不过期**（2026-08-28 起）；只有登记时写了显式截止的旧记录才会过期。多份待绑定并存时按绑定码精确匹配

**光秃秃一个 @（没有正文）是完成绑定的正常方式**，回「绑定完成」而不是
「消息里没有指令正文」。带正文的话绑完继续正常投递，不用发两条。

### 出站（Stop 钩子 + 登记表 + 全局技能，对本机所有 Claude 会话生效）

```
任何会话在登记项目里干活 → 会话结束
       ↓
~/.claude/settings.json 的 Stop 钩子 → scripts/stop-hook.mjs
       ↓ 归属判定：cwd 在项目里 OR 会话记录原文里出现项目路径
  有守望者在盯 → 让路（它会把结果和进展合成一条）
  没有         → drainProject 合成摘要 → 发布身份发到那个项目的话题
```

- 装/卸：`node scripts/install-outbound.mjs [--apply|--uninstall --apply]`，幂等，先备份
- 它装五样：Stop 钩子、UserPromptSubmit 钩子、`bind-preview` 的权限白名单、
  登记表 + 全局技能、launchd 兜底定时器
- 钩子日志 `~/.claude/feishu-bridge/stop-hook.log`
- 本地合成测试 **234 项**，`node scripts/test.mjs`，零外部副作用

### 实测过的（2026-08-20）

| 路径 | 结果 |
|---|---|
| `/init` 触发 UserPromptSubmit | ✅ payload 里 `prompt` 就是字面 `"/init"` |
| 钩子注入落进会话 | ✅ `attachment{type:"hook_additional_context"}` |
| 全流程接入 cc2cd | ✅ 预览免确认 → AskUserQuestion → `--apply` → 话题建立 |
| cc2cd 出站 | ✅ 钩子日志 `cc2cd via=cwd -> published` |
| cc2cd 入站绑定 | ✅ `绑定完成 · cc2cd`，`session_4kvtmps7bytcr` |
| 两个项目并行、各发各的话题 | ✅ 同一份钩子日志里两条互不干扰 |
| @ 错话题 | ✅ 正确路由到老项目并如实拒绝（回执会说「本话题通向：X」） |
| 单智能体出站 | ✅ 话题里 sender 是 M5Claude `cli_aaf8bee78ab89bc1`，不再有第二个头像 |
| 凭据目录指错 agent | ✅ 被 `assertPublishIdentity` 拒绝并说清原因，**一个字都没发** |
| daemon 停掉时出站 | ✅ 照发（实测停掉 daemon 后两种身份都能发）；入站同时死掉 |
| 写 `.runtime-data/` | ✅ 被项目权限规则显式拒绝，文件未创建（2026-08-19 实测） |

## 重要发现：绑定码能靠引用块回来

2026-08-20 实测：Frank 回复根消息时，飞书自动附带的**引用块里有根消息全文**，
绑定码 `d85488` 原样出现在 M5Claude 收到的正文里（`selector.mjs` 的 `normalizeBody`
现在正在剥的就是这个块）。

「认领哪个待绑定」已经从「全机只有一份」升级成**确定性匹配**：`inbound-route.mjs` 按引用块里的
绑定码精确选择（多份待绑定并存时），只有一份时直接命中。绑定码从第一天就写进了根消息，
所以升级没有迁移已建好的话题。待绑定不过期（2026-08-28 起）靠的就是这个。

## 没做完的

1. **事件筛选仍然很粗。**噪音水平还是没验证过 —— 需要跑几天真实使用。
2. **「没记进展就不许收工」没做。**Stop 钩子的 `decision: "block"` 仍未实测。
4. **投进现场会话的权限边界没定。**指令进了交互会话就按**那个会话的权限**跑
   （本项目是 `acceptEdits` + 一串 allowlist），而不是长期任务那份更窄的。
   接入变容易之后，能被手机驱动的从一个项目变成了所有项目。回执里已记
   `delivery_mode` / `target_session_id` 留痕，但要不要限制、怎么限制没定。
5. **「起长期任务会话」还不是接入流程的一步。**没有它 `--continue` 无从续起，
   代码如实拒绝（`no_prior_session`）而不兜底。`/init` 之后天然有一份可续的对话，
   所以走 `/init` 那条路的项目不受影响。

## 现场值

| 项 | 值 |
|---|---|
| 群 | `Frank智能体们` `oc_7ce1dfcf36a34232eab1e0cdc0484333` |
| 机器级模板 | `~/.claude/feishu-bridge/chain-config.json`（15 个必填 + 2 个可选） |
| 出站身份 | **单智能体**：就是 M5Claude 自己，凭据在 `~/.aily-cli/lark-cli/<agent_uid>/` |
| 登记表 | `~/.claude/feishu-bridge/registry.json` |
| M5Claude agent uid | `agent_4ks11dv8f0mxwbd` |
| feishu-bridge-cc | 话题 `om_x100b677afd1884a8c389b5d1da41563`，session `session_4kvgs2vuq4j5z`，配置在项目目录 |
| cc2cd | 话题 `om_x100b6752536a3480c36bff6c21ab423`，session `session_4kvtmps7bytcr`，只在登记表 |
| 正文前缀 | 已退役（`inbound_prefix: null`）。@ 一下即可 |
| 配额 | 已退役（`"unlimited"`）。**有效期是入站唯一的闸** |

有效期到期后：入站一律拒（回执「绑定关系已过期」），**出站不受影响** ——
会变成「任务能说、Frank 不能回」。

- 看和续：`node scripts/binding.mjs [--project ~/x] [--renew 1y --apply]`，
  dry-run 默认，写前留 `.prev`。两种存放形式都支持
- 预警：到期前 30 天 / 7 天各往 outbox 记一条。文案不含天数、自带续期命令 ——
  靠 outbox 指纹判重保证每档只发一次
- 续期是**人工命令**，不自动。长期任务不该有单方面延长自己授权的能力

## 踩过的坑（别再踩）

- **入站技能装在 `~/.claude/skills/m5claude-inbound-router/`**，`aily-cli skill scan-local`
  会把它列为 `[claude-code-local]`。`~/skills/` **不是**被扫描的位置。
  2026-08-19 在这个问题上一天内下过三次结论、三次被推翻 —— 别再凭单次观测判断。
- **判断入站是否健康不能只看「发消息有没有回复」。**入站智能体是个被反复 resume
  的持久会话，技能坏了它也可能凭上下文把命令跑出来。
- **`chain-config.json` 里曾留着陈旧的 `inbound_prefix: "→Claude"`**（没有代码读它），
  差点让 M5Claude 挡下一条合法消息。已删。**没有代码读的字段最容易变成过期的谎话。**
- **auto 模式的分类器会拦下从别的目录跑的陌生脚本**，包括零副作用的 dry-run。
  这就是 `bind-preview.mjs` 单独存在并进白名单的原因 —— 它「发不了消息」是
  依赖图上的事实（有测试盯着），不是一个自觉遵守的 `--dry-run` 开关。
- **模型拿不到预览时会去读源码「逐字还原」文案。**还原出来的东西看着像脚本输出，
  差一个字人就是照着假预览点的头。注入的话里已写死禁止这么做。

## 需求基线

`/Users/dk/codex-projects/agents-arch/pilots/project-management/handoffs/claude-requirements-alignment-20260819.md`

同目录另有 `claude-independent-review-20260818.md`（对 Codex 链路的独立复核）。
**注意：那份报告的根因主干已存疑** —— 它归因于 TTFT 上升越阈，但后来发现
daemon 在 21:51 重启后失去代理，`api.openai.com` 直连连不上，足以解释同一现象。
未重跑验证前不要把它当定论。
