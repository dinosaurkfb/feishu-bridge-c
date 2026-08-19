# feishu-bridge-cc

把一个飞书话题和本机的 Claude Code 长期任务接起来，双向。

```
飞书话题里发指令  ──→  本机 Claude 会话收到并执行
终端里干的活      ──→  每轮回答原样发回那个话题
```

**实际效果**：合上电脑走开，用手机继续下指令、看结果。不需要先问它「进展怎么样」——
它会自己说。

> 搭建步骤看 **[SETUP.md](SETUP.md)**。现场状态、已知未解和踩过的坑看 **[STATE.md](STATE.md)**。

---

## 两个方向都是机制，不是约定

| | 入站 | 出站 |
|---|---|---|
| 触发 | 飞书话题里 mention + 前缀 | 每轮回答结束（兜底：每 30 分钟） |
| 载体 | 飞书智能体 + `scripts/inbound.mjs` | 用户级 Stop 钩子 + 全局技能 |
| 生效范围 | 绑定的那个话题 | 本机**所有** Claude 会话 |
| 判定 | 六项确定性校验 + 原子 claim | 登记表里的项目 + 会话归属判定 |

出站不依赖任何 `CLAUDE.md` 里的手写约定 —— 换目录、换会话都还在。

## 入站怎么走

```
话题里 mention 入站智能体 + →Claude 前缀
  → scripts/inbound.mjs：六项校验 → 原子 claim → 路由 → 秒级「已受理」
       ├ 这个项目有活着的交互会话？ → SendMessage 投进去
       └ 没有                       → claude --continue 后台起一轮 + 守望者
```

两条分支互斥。都走 `--continue` 会有两个进程写同一份会话记录。

## 出站怎么走

每轮回答结束时，Stop 钩子取 `last_assistant_message`，**原样**写进 outbox，
发布器排空后发到话题。不经模型判断。

为什么不筛：多发一条你已读过的是噪音（代价≈0），漏发一条是信息丢失（你走开了，
结果躺在看不见的终端里）。**用会出错的判断决定发不发，是拿便宜的错误换昂贵的错误。**

## 常用命令

```bash
node scripts/binding.mjs                     # 看绑定：有效期、剩余天数、话题
node scripts/binding.mjs --renew 1y --apply  # 续期
node scripts/outbox.mjs --list               # 还有多少进展没发出去
node scripts/test.mjs                        # 142 项本地回归，零外部副作用
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
scripts/       确定性脚本。selector/claim/handoff 是入站，outbox/drain/stop-hook 是出站
skills/        两个方向各一份技能源
references/    配置模板（chain-config / active-mapping）
.runtime-data/ 身份、绑定、claim、回执、outbox 队列。禁止提交
```

## 设计上不肯让步的几条

- **伪造进展比不报告进展糟得多。**权限被拦、跑失败、只做了一半，一律如实说。
  `readRunOutcome` 会把「被权限拦下」判成 `blocked` 而不是 `completed`。
- **fail-closed。**配置缺失或写错一律拒绝入站，绝不当成「没有限制」。
- **发送成功才标记已发。**宁可重发也不能标记了却没发出去 —— 那会让进展静默丢失。
- **长期任务不能延长自己的授权。**续期是人工命令，`.runtime-data/` 对它写权限被显式拒绝。
- **一个只会报成功的自检，比没有自检更糟。**
