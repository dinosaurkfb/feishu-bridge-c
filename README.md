# feishu-bridge-cc

把飞书话题和本机的 Claude Code 长期任务接起来，双向，**一个群里可以接多个项目**。

```
飞书话题里发指令  ──→  本机对应项目的 Claude 会话收到并执行
终端里干的活      ──→  每轮回答原样发回那个项目的话题
```

**实际效果**：合上电脑走开，用手机继续下指令、看结果。不需要先问它「进展怎么样」——
它会自己说。

**接一个新项目**：在项目目录里敲 `/init`，它会问你要不要建话题（默认「是」），
你答应后再去新话题 @ 一下就完事 —— 不用建话题、不用写配置。

> 搭建步骤看 **[SETUP.md](SETUP.md)**。现场状态、已知未解和踩过的坑看 **[STATE.md](STATE.md)**。

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
  → scripts/inbound.mjs 先校验「调用我的是不是配置里那个运输 agent」
  → 取信封（只靠 daemon 注入的环境变量，不读项目配置）
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
node scripts/install-outbound.mjs --apply              # 装五样，见下
node scripts/install-outbound.mjs --uninstall --apply
```

装五样：**Stop 钩子**（每轮回答自动发回话题）、**UserPromptSubmit 钩子**（`/init` 时
问一句要不要接飞书）、**`bind-preview` 的权限白名单**、**项目登记表 + 全局技能**、
**launchd 兜底定时器**。

dry-run 默认，幂等。往 `~/.claude/settings.json` 的两个钩子数组**分别追加**
（先备份，不动已有的 —— 认脚本路径做幂等，装两遍也只有一条）。

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
skills/        两个方向各一份技能源
references/    机器级链路模板的样例（唯一需要手填的那份配置）
.runtime-data/ 身份、绑定、claim、回执、outbox 队列。禁止提交

~/.claude/feishu-bridge/
  chain-config.json   机器级链路模板（群、智能体身份、profile、授权发送者）
  registry.json       项目登记表 —— 接入产生的那一行就写在这里
```

## 设计上不肯让步的几条

- **伪造进展比不报告进展糟得多。**权限被拦、跑失败、只做了一半，一律如实说。
  `readRunOutcome` 会把「被权限拦下」判成 `blocked` 而不是 `completed`。
- **fail-closed。**配置缺失或写错一律拒绝入站，绝不当成「没有限制」。
- **发送成功才标记已发。**宁可重发也不能标记了却没发出去 —— 那会让进展静默丢失。
- **长期任务不能延长自己的授权。**续期是人工命令，`.runtime-data/` 对它写权限被显式拒绝。
- **一个只会报成功的自检，比没有自检更糟。**
