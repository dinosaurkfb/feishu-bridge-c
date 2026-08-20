# feishu-bridge

把飞书话题和本机长期 AI 任务接起来。Claude Code v2 是已完成基线；Codex adapter
复用同一套 envelope、selector、claim、outbox 和飞书发布器，但按 Codex thread 绑定。

> Claude 搭建看 **[SETUP.md](SETUP.md)**；Codex 候选适配看
> **[CODEX_SETUP.md](CODEX_SETUP.md)**。两套 runtime 共仓维护，不靠长期分支复制核心修复。

## Codex adapter

Codex 与 Claude 的关键差异已经隔离在 `scripts/codex/`：

- 单一 M5Codex 同时负责入站运输和出站发布，模板校验拒绝双身份配置；
- selector 只要求绑定话题中的真实 `@M5Codex`，mention 后正文直接作为指令；
- 一个飞书话题绑定一个精确 `codex_thread_id`，同一仓库允许多个 task；
- 禁止 `--last`，运行中的 Desktop turn 通过 hook lease fail-closed 为 busy；
- 入站用 detached `codex exec resume <精确 UUID> --json` 秒级返回；
- Stop 以 `thread + turn/claim` 事件键原样入队，相同正文的不同轮次不会互相去重；
- Codex locator、claim、receipt 和 outbox 全在 `~/.codex/feishu-bridge/`，不进入工作树；
- 当前 Stop 只入队，真实飞书发布仍由 `drain-outbox.mjs --apply` 逐次授权。
- Codex 官方 `/init` 仍只负责生成 `AGENTS.md`；hook 仅要求初始化成功后询问是否接入，
  不在 `/init` 本轮自动建飞书话题；
- 安装后提供 `$feishu-bind`、`$feishu-unbind`、`$feishu-status` 三项技能命令，
  它们也会出现在斜杠菜单中，且均只作用于当前精确 task。

本地回归：

```bash
node scripts/test.mjs          # Claude 基线 234 项
node scripts/codex/test.mjs    # Codex adapter 合成回归
node scripts/codex/install.mjs # 安装预览；默认不写
```

Codex 适配具备本地合成与隔离安装证据；具体机器是否已经安装不能从仓库推断，必须运行
安装预览并检查 `~/.codex`。真实飞书端到端验证仍需逐动作授权。

---

## Claude Code 基线

把飞书话题和本机的 Claude Code 长期任务接起来，双向，**一个群里可以接多个项目**。

```
飞书话题里发指令  ──→  本机对应项目的 Claude 会话收到并执行
终端里干的活      ──→  每轮回答原样发回那个项目的话题
```

**实际效果**：合上电脑走开，用手机继续下指令、看结果。不需要先问它「进展怎么样」——
它会自己说。

**接一个新项目**：在项目目录里敲 `/init`，它会问你要不要建话题（默认「是」），
你答应后再去新话题 @ 一下就完事 —— 不用建话题、不用写配置。

> 搭建步骤看 **[SETUP.md](SETUP.md)**。Claude 现场状态、已知未解和踩过的坑看 **[STATE.md](STATE.md)**。

---

## 两个方向都是机制，不是约定

| | 入站 | 出站 |
|---|---|---|
| 触发 | 飞书话题里 mention（前缀可选） | 每轮回答结束（兜底：每 30 分钟） |
| 载体 | 飞书智能体 + `scripts/inbound.mjs` | 用户级 Stop 钩子 + 全局技能 |
| 生效范围 | 登记表里所有已绑定的话题 | 本机**所有** Claude 会话 |
| 判定 | session→项目路由 + 绑定/话题/发送者/mention 四道闸 + 原子 claim | 登记表里的项目 + 会话归属判定 |
| 接入 | `/init` 时钩子问一句，答应就建 | 同一次接入，出站立刻可用 |

出站不依赖任何 `CLAUDE.md` 里的手写约定 —— 换目录、换会话都还在。

## 入站怎么走

```
话题里 mention 入站智能体（前缀可选）
  → scripts/inbound.mjs 取信封（只靠环境变量，不读项目配置）
  → session_id 去所有登记项目里找绑定
       ├ 对上了 → 那个项目
       └ 没对上 → 待绑定认领（新话题的第一次 @ 就是在走这条）
  → 确定性校验 → 原子 claim → 秒级「已受理」
       ├ 这个项目有活着的交互会话？ → SendMessage 投进去
       └ 没有                       → claude --continue 后台起一轮 + 守望者
```

两条分支互斥。都走 `--continue` 会有两个进程写同一份会话记录。

**为什么新话题要多 @ 一下**：建话题的那一刻 Aily 的 session 还不存在
（它是第一条消息流进来才产生的），而绑定的核心闸就是 session_id。
所以绑定必然分两段，第二段就是你 @ 的那一下。

## 出站怎么走

每轮回答结束时，Stop 钩子取 `last_assistant_message`，**原样**写进 outbox，
发布器排空后发到话题。不经模型判断。

为什么不筛：多发一条你已读过的是噪音（代价≈0），漏发一条是信息丢失（你走开了，
结果躺在看不见的终端里）。**用会出错的判断决定发不发，是拿便宜的错误换昂贵的错误。**

## 常用命令

```bash
node scripts/bind-preview.mjs --project ~/x   # 这个项目接没接、话题在哪（免权限确认）
node scripts/bind-project.mjs --project ~/x --apply  # 接进来（建话题 + 登记一行）
node scripts/binding.mjs [--project ~/x]     # 看绑定：有效期、剩余天数、话题
node scripts/binding.mjs --renew 1y --apply  # 续期
node scripts/outbox.mjs --list               # 还有多少进展没发出去
node scripts/test.mjs                        # 234 项本地回归，零外部副作用
tail ~/.claude/feishu-bridge/stop-hook.log   # 出站钩子每次干了什么
```

## 装 / 卸

```bash
node scripts/install-outbound.mjs --apply              # Stop 钩子 + 登记表 + 技能 + launchd
node scripts/install-outbound.mjs --uninstall --apply
```

dry-run 默认，幂等。往 `~/.claude/settings.json` 的 Stop 数组**追加**（先备份，不动已有的）。

## 代理（这台机器上的两个坑）

**daemon 重启后会丢代理。**`aily-cli daemon start` 用硬编码白名单构造环境，
代理变量不在其中。症状伪装成「Claude Code 鉴权失败，请检查 ANTHROPIC_AUTH_TOKEN」
—— **查凭据是白查**。每次重启（升级、开机自启、崩溃拉起）都会复发。

```bash
sh scripts/aily-daemon-restart.sh
```

先探代理端口（不通就拒绝重启，不白中断会话），带 `AILY_CLI_FORWARD_ENV` 重启，
再验代理真的进到 daemon 里、网关认不认这台机器在线。

**git 走 https，只认 `HTTPS_PROXY`。**只设 `HTTP_PROXY` 时 `git push` 走直连、
时通时不通（75 秒超时）。已在 `~/.zshrc` 补齐，并给 github.com 配了不依赖环境变量的
git 代理。`.zshrc` 那段只在代理**真的在监听**时才导出 —— 指向死端口比没有代理更糟。

## 目录

```
scripts/
  入站   selector / envelope / claim / handoff / inbound / inbound-route
  出站   outbox / drain-outbox / outbound / stop-hook / watch-and-publish
  接入   init-hook / bind-preview / bind-project / bind-compose / chain-template
  共用   project-resolve（从哪读配置）/ registry / binding / binding-health
  codex/ 精确 thread 状态、绑定、hooks、handoff、watcher、逐次授权发布
skills/        Claude / Codex 的入站与长期任务技能源
references/    配置模板（chain-config / active-mapping）
.runtime-data/ 身份、绑定、claim、回执、outbox 队列。禁止提交

~/.claude/feishu-bridge/
  chain-config.json   机器级链路模板（群、两个身份、profile、授权发送者）
  registry.json       项目登记表 —— 接入产生的那一行就写在这里

~/.codex/feishu-bridge/
  chain-config.json   Codex 单 M5Codex 机器级模板
  registry.json       task 登记表；同一 root 可有多个精确 thread
  tasks/              task 级 claim、receipt、run 和 outbox（全部在 Git 外）
```

## 设计上不肯让步的几条

- **伪造进展比不报告进展糟得多。**权限被拦、跑失败、只做了一半，一律如实说。
  `readRunOutcome` 会把「被权限拦下」判成 `blocked` 而不是 `completed`。
- **fail-closed。**配置缺失或写错一律拒绝入站，绝不当成「没有限制」。
- **发送成功才标记已发。**宁可重发也不能标记了却没发出去 —— 那会让进展静默丢失。
- **长期任务不能延长自己的授权。**续期是人工命令，`.runtime-data/` 对它写权限被显式拒绝。
- **一个只会报成功的自检，比没有自检更糟。**
