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

## 安装

两个方向各有一个安装器，都是 dry-run 默认、幂等、可 `--uninstall`：

```bash
node scripts/install-outbound.mjs --apply   # Stop 钩子 + 登记表 + 全局技能 + launchd 兜底
node scripts/install-inbound.mjs  --apply   # 入站技能装到 ~/skills/
```

出站那个往 `~/.claude/settings.json` 的 Stop 数组**追加**一条（先备份，不动 .orca 那套）。

入站那个装完会自检文件一致性、目标是真实目录（软链会让扫描不跟随）、
以及 `SKILL.md` 里引用的脚本路径确实存在。但它**不保证技能已被发现**——
`aily-cli skill scan-local` 扫的是宿主 agent 目录（`~/.claude/skills`、`~/.codex/skills`），
看不到 `~/skills/` 这一个。**唯一的验证是从飞书真发一条 `→Claude` 指令看回执。**

技能实际是被 materialize 进一次性的 plugin 目录再调用的
（`aily-cli-invocation:<技能名>`，用完即删），所以事后在磁盘上翻不到痕迹。
要确认它有没有真被调用，看 M5Claude 自己的会话记录：
`~/.claude/projects/-Users-dk-aily-workspaces-agent-<uid>/`。

## 目录

- `scripts/` 确定性脚本（selector / claim / handoff / outbox / drain / stop-hook）
- `skills/m5claude-inbound-router/` 部署到 M5Claude 工作区的入站技能
- `skills/claude-longtask-progress/` 部署到 `~/.claude/skills/` 的出站进展技能
- `.runtime-data/` 敏感 locator、mapping、claim、回执。**禁止提交**

## 绑定续期

绑定有个到期日，那是入站**唯一**的闸（配额闸已退役）。到期后入站一律拒，
但出站照发——会变成"任务能说、你不能回"。

```bash
node scripts/binding.mjs                    # 看：到期日、还剩几天、配额、话题
node scripts/binding.mjs --renew 1y --apply # 续（也收 6m / 90d / 2027-08-19）
```

到期前 30 天和 7 天会各自动往飞书报一次，不用记着。预警文案里带续期命令。

## 代理（这台机器上的两个坑）

**daemon 重启后会丢代理。**`aily-cli daemon start` 用硬编码白名单构造环境，
代理变量不在其中，所以 `HTTP_PROXY=... aily-cli daemon restart` 无效。
症状伪装成「Claude Code 鉴权失败，请检查 ANTHROPIC_AUTH_TOKEN」——**查凭据是白查**。
每次重启（升级、开机自启、崩溃拉起）都会复发。用：

```bash
sh scripts/aily-daemon-restart.sh
```

它先探代理端口（不通就拒绝重启，不白折腾），带 `AILY_CLI_FORWARD_ENV` 重启，
再验代理变量真的进到 daemon 里、以及网关认不认这台机器在线。

**git 走 https，只认 `HTTPS_PROXY`。**只设 `HTTP_PROXY` 时 `git push` 会走直连、
时通时不通（表现为 75 秒超时）。已在 `~/.zshrc` 里补齐两个变量，并给 github.com
配了不依赖环境变量的 git 代理：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:10808
```

`~/.zshrc` 那段只在代理**真的在监听**时才导出——指向死端口比没有代理更糟。

## 自检

```bash
node scripts/test.mjs                       # 本地合成回归，零外部副作用
node scripts/outbox.mjs --list              # 还有多少进展没发出去
node scripts/drain-outbox.mjs --all --dry-run
tail ~/.claude/feishu-bridge/stop-hook.log  # 出站钩子每次干了什么
```
