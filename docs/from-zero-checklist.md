# 从零到全功能验收清单（Linux 宿主机）

本文档为 **feishu-bridge-cc / feishu-bridge-codex** 在全新 Linux 机器（如 `omm` 宿主机）上**只看文档、无需改码**，从零环境准备、部署安装、路由配置、会话绑定、收发验证、体检判定，到完整卸载再装的**端到端执行顺序清单**。

> **核心纪律**：
> 1. **非交互 SSH 前提**：所有命令均显式书写绝对路径与必要环境变量，不假设 `~/.bashrc` 或交互式 shell 隐式配置生效。
> 2. **只写已实现的行为**：未实现的功能与平台差异严格记录在「已知限制」，绝不把设计意图当作既有行为。
> 3. **单步复核**：每一步操作末尾均留有复核框，供在 `omm` 实操走通时逐项勾选确认。

---

## 0. 前置条件准备（Linux 宿主机）

### 0.1 非交互 SSH 运行特征与代理持久化
通过 `ssh host 'cmd'` 执行命令时，shell 处于非登录、非交互模式，**不会读取 `~/.bashrc`**。如果宿主机访问外网（GitHub / Anthropic / Lark API）依赖代理，通过 `.bashrc` 导出的代理变量完全无效。

**机器级持久根治方案**：配置 `~/.config/environment.d/10-proxy.conf`（systemd 用户实例拉起的进程与守护进程将统一继承）：
```ini
# ~/.config/environment.d/10-proxy.conf
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
ALL_PROXY=socks5://127.0.0.1:7890
all_proxy=socks5://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
no_proxy=localhost,127.0.0.1
```
*注：代理端口和地址按实际网关修改。*

### 0.2 Node.js 环境（≥ 22）
非交互环境下的 `PATH` 可能仅包含 `/usr/bin:/bin`。本桥解析 Node 绝对路径的内置顺序为：
`FEISHU_BRIDGE_NODE` → 原单元已装路径 → mise shim（`~/.local/share/mise/shims/node`）→ 当前 `PATH` → `/usr/local/bin/node` → `~/.local/bin/node`。

若通过 mise 管理 Node，请确保存在软链或在非交互脚本前置指定：
```bash
export FEISHU_BRIDGE_NODE="$HOME/.local/share/mise/shims/node"
# 验证版本
"$FEISHU_BRIDGE_NODE" -v  # 应输出 v22.x 或更高
```

### 0.3 aily-cli 登录与 systemd --user 服务托管
- **登录凭据**：
  ```bash
  aily-cli login --env online
  ```
  凭据将保存在 `~/.aily-cli/`。通过 `aily-cli doctor` 确认平台连接正常。
- **配置 aily daemon 用户服务**：
  避免使用 `nohup aily-cli daemon &`（脱机易丢且缺代理）。将其托管为 `systemd --user` 服务以稳定继承 `environment.d`：
  新建 `~/.config/systemd/user/aily-daemon.service`：
  ```ini
  [Unit]
  Description=Aily CLI Daemon
  After=network.target

  [Service]
  Type=simple
  ExecStart=/usr/bin/env aily-cli daemon
  Restart=on-failure
  RestartSec=5s

  [Install]
  WantedBy=default.target
  ```
  生效并启动：
  ```bash
  systemctl --user daemon-reload
  systemctl --user enable --now aily-daemon.service
  systemctl --user is-active aily-daemon.service  # 验证：应输出 active
  ```
- **开启 linger（仅在需要脱机常驻时）**：
  保证 SSH 断开注销后，用户级 systemd 守护进程与定时器持续运行。
  在多数现代发行版（如 Debian/Ubuntu，包括 omm 实测）下，polkit 策略默认允许普通用户管理自己的 linger 状态，**不需要 sudo**（rc=0，Linger=yes）：
  ```bash
  loginctl enable-linger "$USER"
  ```
  若当前环境 polkit 策略被收紧而被拒（如报错 Authorization required 或 Permission denied），再追加 `sudo` 执行：
  ```bash
  sudo loginctl enable-linger "$USER"
  ```
  - **验证**：
    ```bash
    loginctl show-user "$USER" -p Linger
    # 预期输出：Linger=yes
    ```

### 0.4 lark-cli 安装与凭据机制
- 验证安装：
  ```bash
  lark-cli --version
  ```
- **单智能体凭据机制（Linux 特异性）**：
  推荐采用**单智能体方案**（出站直接复用入站智能体自身身份）。在 Linux 上，lark-cli 改用文件加密库（默认 `~/.local/share/lark-cli/`），而 aily-cli 将 agent 密钥放置于 `~/.aily-cli/lark-cli/<agent_uid>/data/lark-cli/`。桥在调用 lark-cli 时会自动补全环境变量 `LARKSUITE_CLI_DATA_DIR=<agent 凭据目录>/data`，无需用户手工配置 `lark-cli auth login`。

□ 在 omm 复核于 ____________________

---

## 1. 取代码（检出指定 main 哈希）

在 Linux 宿主机上克隆代码库，并显式检出经过门禁验证的指定提交（不随手使用未经测试的 HEAD）：

```bash
git clone https://github.com/dinosaurkfb/feishu-bridge-c.git
cd feishu-bridge-c

# 检出经门禁批准的固定 main 哈希（示例：70b34ff28ebf）
git checkout <指定_main_commit_hash>
```

- **验证**：
  ```bash
  git status
  # 预期输出：HEAD detached at <commit_hash>，working tree clean
  ```

- **硬核对：检出就是你要装的那个提交**（`git status` 只说明检出在某个提交上，不说明是不是**你要的**那个）：
  ```bash
  WANT=<指定_main_commit_hash>          # 完整哈希或至少 7 位前缀
  case "$(git rev-parse HEAD)" in
    "$WANT"*) echo "检出正确：$(git rev-parse --short=12 HEAD)" ;;
    *) echo "检出不是要装的提交（要 $WANT，实际 $(git rev-parse --short=12 HEAD)）—— 停下，别往下装"; false ;;
  esac
  ```

### 1.1 升级已有检出（机器上已经装过一版）

升级时最容易踩的坑：**更新代码那一步失败了，后面照样用旧代码装完，而且每一步都报成功**
（2026-09-21 omm 真机实测：`git fetch` 撞上网络错误失败，三个安装器把旧代码装了一遍，退出码全是 0）。
安装器自己察觉不了——fetch 失败时本地的 `origin/main` 也是旧的，两边看起来一致。所以**更新代码必须短路**：
任何一步失败就停，不许往下走。

```bash
cd feishu-bridge-c
WANT=<指定_main_commit_hash>
git fetch origin \
  && git checkout "$WANT" \
  && case "$(git rev-parse HEAD)" in "$WANT"*) true ;; *) false ;; esac \
  && echo "代码已到 $(git rev-parse --short=12 HEAD)，可以装" \
  || echo "更新代码没成功 —— 停下，别装（先查网络或手工核对检出）"
```

- 只有看到「代码已到 …，可以装」才进入第 3 节。
- **这台机器连不上代码仓库时**（例如 `git fetch` 报 SSL / 超时错误），可以从另一台能连上的机器用离线包中转：
  ```bash
  # 在能连上的机器上（本地已有新提交）：<旧> 是目标机器当前的提交
  git bundle create /tmp/fb.bundle <旧>..main
  scp /tmp/fb.bundle <目标机器>:/tmp/fb.bundle

  # 在目标机器上：
  git fetch /tmp/fb.bundle main:refs/remotes/origin/main && git checkout "$WANT"
  ```
  导入后照样做上面的硬核对。

□ 在 omm 复核于 ____________________

---

## 2. 机器级链路模板初始化（init-chain-template）

机器级模板必须最先配置，它承载机器唯一身份，不从任何具体项目中派生。

### 2.1 准备配置参数
| 参数项 | 参数来源与说明 | 格式示例 |
|---|---|---|
| `--agent-uid` | Aily 平台对应智能体详情页的 agent id | `agent_xxx` |
| `--transport-app-id` | 智能体背后的飞书应用 App ID | `cli_xxx` |
| `--transport-open-id` | **该 App 自身视角下**智能体的 open_id（不能复用其他应用视角查得的 open_id） | `ou_xxx` |
| `--frank-sender-id` | **Aily 平台的授权用户 user id**（纯数字字符串，非飞书 `ou_`） | `1234567890123` |
| `--chat-id` | 飞书话题群 ID（通过 `lark-cli im +chat-search` 检索） | `oc_xxx` |
| `--chat-name` | 目标群名称 | `"AI任务群"` |
| `--transport-agent-name` | 智能体在群内展示名 | `M5Claude` / `M5Codex` |

> ⚠️ **安全警告**：
> - `frank_sender_id` 是整条链路的核心访问控制闸。填成他人的 Aily user id 格式合法却会造成权限越权；必须逐字核实。
> - **不要手工传 `--bridge-root`**：脚本通过 `moduleRoot` 自动提取当前仓库绝对路径，手工传容易拼错并产生路径脱节。
> - 脚本已封堵未知选项（issue #220），传入拼写错误的参数会直接抛错退出。

### 2.2 执行模板生成
#### (A) Claude 链模板生成
```bash
# 1. 先 dry-run 预览（确认 15 项检查全为 ✓）
node scripts/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-app-id cli_xxx \
  --transport-open-id ou_xxx \
  --outbound-agent-name "M5Claude" \
  --outbound-app-id cli_xxx \
  --outbound-open-id ou_xxx \
  --frank-sender-id 123456... \
  --chat-id oc_xxx \
  --chat-name "群名" \
  --transport-agent-name "M5Claude" \
  --chain claude

# 2. 确认无误后追加 --apply 落盘
node scripts/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-app-id cli_xxx \
  --transport-open-id ou_xxx \
  --outbound-agent-name "M5Claude" \
  --outbound-app-id cli_xxx \
  --outbound-open-id ou_xxx \
  --frank-sender-id 123456... \
  --chat-id oc_xxx \
  --chat-name "群名" \
  --transport-agent-name "M5Claude" \
  --chain claude \
  --apply
```
- **预期输出**：
  `已写入 /home/<user>/.claude/feishu-bridge/chain-config.json`

#### (B) Codex 链模板生成（若需使用 Codex）
```bash
# 1. 先 dry-run 预览
node scripts/codex/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-agent-name "M5Codex" \
  --transport-app-id cli_xxx \
  --transport-open-id ou_xxx \
  --frank-sender-id 123456... \
  --chat-id oc_xxx \
  --chat-name "群名"

# 2. 确认无误后追加 --apply 落盘
node scripts/codex/init-chain-template.mjs \
  --agent-uid agent_xxx \
  --transport-agent-name "M5Codex" \
  --transport-app-id cli_xxx \
  --transport-open-id ou_xxx \
  --frank-sender-id 123456... \
  --chat-id oc_xxx \
  --chat-name "群名" \
  --apply
```
- **预期输出**：
  `已写入 /home/<user>/.codex/feishu-bridge/chain-config.json`

- **文件验证**：
  ```bash
  ls -la ~/.claude/feishu-bridge/chain-config.json  # 权限应为 0600
  ```

□ 在 omm 复核于 ____________________

---

## 3. 安装（三条 --apply 的严格顺序与执行）

### 3.1 执行顺序与架构理由
必须严格按照以下顺序执行，禁止跳步或倒序：

1. **第一步：`node scripts/install-outbound.mjs --apply`**
   - **理由**：该命令负责创建并同步 `~/.claude/feishu-bridge/runtime/current` 运行时镜像代码，并在 `~/.claude/settings.json` 中配置核心 hooks，同时为 Linux 部署 `systemd --user` 兜底排空定时器。
2. **第二步：`node scripts/install-inbound.mjs --apply`**
   - **理由**：该命令将入站技能渲染并写入 `~/.claude/skills/m5claude-inbound-router/`。技能中的命令严格指向第一步同步出来的 `runtime/current/scripts/aily-inbound.mjs`。如果先跑入站安装器，会因引用的 runtime 脚本尚不存在而拒绝安装（fail-closed）。
3. **第三步（可选）：`node scripts/codex/install.mjs --apply`**
   - **理由**：若需启用 Codex 链路，在底层共用基座就绪后，安装 Codex 运行时与专属 hooks/skills。

### 3.2 命令执行

```bash
# 1. 出站与运行时基座安装（先预览再 apply）
node scripts/install-outbound.mjs
node scripts/install-outbound.mjs --apply

# 2. 入站技能安装（先预览再 apply）
node scripts/install-inbound.mjs
node scripts/install-inbound.mjs --apply

# 3. Codex 适配层安装（按需）
node scripts/codex/install.mjs
node scripts/codex/install.mjs --apply
```

- **推荐：让安装器自己核对「装的就是你要的那个提交」**（issue #257）。三个安装器都认 `--expect-commit <sha>`
  （完整哈希或至少 7 位前缀；`--expect-commit=<sha>` 同样可以）。给了它，安装器会在**任何写盘之前**核两件事：
  检出的提交就是它；将要安装的每个源码文件的字节都与那个提交一致（工作树里改了、多了、少了都算不一致）。
  对不上就**什么都不写**，退出码 2，并用一句话说清是哪一种（提交不对 / 工作树与提交不一致 / 核对不出来）。
  预览（不带 `--apply`）也做同样的核对，对不上时计划照打、退出码同样是 2，所以用 `&&` 串起来的步骤会停：
  ```bash
  WANT=<指定_main_commit_hash>
  node scripts/install-outbound.mjs --expect-commit "$WANT" \
    && node scripts/install-outbound.mjs --expect-commit "$WANT" --apply \
    && node scripts/install-inbound.mjs --expect-commit "$WANT" --apply \
    && node scripts/codex/install.mjs --expect-commit "$WANT" --apply    # 不启用 Codex 链就去掉这一行
  ```
  - 装完结语头一行会写「装的是提交 <前 12 位>，runtime 版本 <版本号>」。
  - 若这台机器上已经装着**同一份内容**（例如新提交只改了文档），runtime 不会重装，结语会同时写出本次核对的提交与已装收据里记的提交，并注明「runtime 未重装」——这是正常情况，不是装错了。
  - 不给 `--expect-commit` 时，安装器的行为与以前完全一样（不做这两项核对）。

- **预期关键输出**：
  - `install-outbound.mjs`：
    - `运行时   : .../.claude/feishu-bridge/runtime → 版本 ...`
    - `settings : .../.claude/settings.json → installed`
    - `兜底定时 : .../feishu-bridge-cc-drain.timer → will-install`
    - 加 `--apply` 后调用 `systemctl --user enable --now feishu-bridge-cc-drain.timer`
  - `install-inbound.mjs`：
    - `install SKILL.md`，`install aily-cli-skill.json`
    - 自检最后两行**各说一件事**（issue #241），别读混：`aily daemon socket` 看的是（只说 socket 在不在、是不是 socket；**在不证明进程活着**，确认用 doctor）
      `~/.aily-cli/sockets/aily-cli.sock`；`aily 是否已发现本技能` 看的是 `scan-local` 探测（报到了 /
      报不到 / **查不了 + 原因**）。**非交互 ssh** 下 PATH 里常常没有 `aily-cli`（mise shims 不在 PATH）——
      那时第二行会说「查不了：找不到 aily-cli（ENOENT）」，这**不等于 daemon 没跑**；第一行只报告 socket 状态（在 / 不在 / 查不清），确认 daemon 在不在跑用 `node scripts/doctor.mjs`。
  - `codex/install.mjs`：
    - `hooks ... UserPromptSubmit → installed, Stop → installed`

- **Linux systemd 单元验证**：
  ```bash
  systemctl --user is-active feishu-bridge-cc-drain.timer
  # 预期输出：active
  systemctl --user list-timers --user | grep feishu
  # 预期输出：每 30 分钟触发排空
  ```

- **装完核对：装进去的就是你要的那个提交**（安装器的「已完成本地安装」只说明装了**某个**版本）。
  运行时目录里的 `INSTALLED.json` 记着这份代码来自哪个提交（`source_commit`），拿它和第 1 节的 `WANT` 比：
  ```bash
  GOT=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.claude/feishu-bridge/runtime/current/INSTALLED.json")))["source_commit"] or "")')
  case "$GOT" in
    "$WANT"*) echo "装的是要装的提交：${GOT:0:12}" ;;
    *) echo "装进去的不是要装的提交（要 $WANT，实际 ${GOT:-说不清}）—— 回第 1.1 节查代码更新那一步" ;;
  esac
  ```
  启用了 Codex 链的，把路径换成 `~/.codex/feishu-bridge/runtime/current/INSTALLED.json` 再核一次。

□ 在 omm 复核于 ____________________

---

## 4. 路由表首建（--init-default）与外部处理器登记

### 4.1 首建陷阱背景（issue #222）
多消费者路由体系下，当路由表中存在条目但**没有标记 `default: true`** 时，未登记话题将一律拒绝受理（避免消息落入非预期处理器）。如果新机直接登记外部处理器（如 `cc2cd`），会导致机器陷入“有路由但无默认路由”的故障状态。

**正确顺序**：新机部署后 → 先执行 `--init-default` 首建本链默认路由 → 再登记外部处理器。

### 4.2 执行首建（`--routes` 必填绝对路径）
两条链路的路由表独立分开，必须显式给出绝对路径，杜绝环境变量兜底造成的串扰。

#### (A) Claude 链默认路由首建
```bash
# 预览
node scripts/register-route.mjs \
  --init-default \
  --routes "$HOME/.claude/feishu-bridge/routes.json" \
  --id self \
  --handler "$HOME/.claude/feishu-bridge/runtime/current/scripts/inbound.mjs" \
  --note "Claude 链默认入站处理器"

# 确认后落盘
node scripts/register-route.mjs \
  --init-default \
  --routes "$HOME/.claude/feishu-bridge/routes.json" \
  --id self \
  --handler "$HOME/.claude/feishu-bridge/runtime/current/scripts/inbound.mjs" \
  --note "Claude 链默认入站处理器" \
  --apply
```
- **预期输出**：
  `已写入：self → .../scripts/inbound.mjs（default: true）`

#### (B) Codex 链默认路由首建（若使用 Codex）
```bash
node scripts/register-route.mjs \
  --init-default \
  --routes "$HOME/.codex/feishu-bridge/routes.json" \
  --id codex \
  --handler "$HOME/.codex/feishu-bridge/runtime/current/scripts/codex/inbound.mjs" \
  --note "Codex 链默认入站处理器" \
  --apply
```

### 4.3 登记外部处理器（可选）
当且仅当默认路由播种完成后，方可接入外部处理器（如 `cc2cd`）：
```bash
node scripts/register-route.mjs \
  --id cc2cd \
  --handler "/path/to/cc2cd/inbound.mjs" \
  --note "cc2cd 外部处理器" \
  --apply
```

- **验证**：
  ```bash
  cat ~/.claude/feishu-bridge/routes.json
  # 验证 JSON 中 routes 包含 {"id":"self", "default":true, ...}
  ```

□ 在 omm 复核于 ____________________

---

## 5. 项目/任务接入与首次会话绑定

### 5.1 Claude 链接入
1. **前置条件**：目标项目工作目录内必须已经存在至少一轮 Claude 会话（可进入目录执行一次 `claude` 并完成 `/init`）。
2. **执行绑定命令**：
   ```bash
   cd /path/to/your-project
   node /path/to/feishu-bridge-c/scripts/bind-preview.mjs
   node /path/to/feishu-bridge-c/scripts/bind-project.mjs --apply
   ```
   *（或在 Claude Code 会话内直接输入 `/feishu-bind`）。*
   执行成功后，飞书群内会自动创建以该项目命名的新根话题，并在根卡片中附带 6 位稳定绑定短码。

3. **关键人工步骤（首次 @ 智能体）**：
   前往飞书群内刚创建的新话题，**真实 @ 一次入站智能体**（正文为空即可）。
   - **机制说明**：Aily 的 `session_id` 只有在首条飞书消息传入时由平台生成。因此绑定分为“建话题登记”与“首条消息认领 session”两步。首次 @ 带有根卡片引用，桥提取其中的短码完成最终绑定。

4. **验证**：
   ```bash
   node /path/to/feishu-bridge-c/scripts/binding.mjs --project /path/to/your-project
   # 状态应显示 bound，session_id 已落盘
   ```

### 5.2 Codex 链接入（若使用 Codex）
1. 在宿主机 Codex Desktop/CLI 对应的具体 task 内执行：
   ```text
   $feishu-bind
   ```
2. 飞书群内创建对应的新话题。
3. **关键人工步骤**：前往该话题，**真实 @ 一次 M5Codex**（空正文即可）。
4. 在 task 内运行 `$feishu-status`，验证状态显示“task 已接入”且“飞书入站已绑定”。

□ 在 omm 复核于 ____________________

---

## 6. 端到端收发验证

### 6.1 验证操作
在飞书已绑定话题中发送一条测试指令：
```text
@M5Claude 请查看当前 git 分支并说明状态
```

### 6.2 预期行为与卡片特征
1. **秒级受理**：飞书话题内立刻收到纯文本回执：`已受理，进入长期任务：...`。
2. **后台执行**：宿主机后台 Claude 会话续接原项目上下文执行指令。
3. **结果回发**：任务完成后，最终答复以只读 Card 2.0 格式发回原话题。
   - **飞书发起的回合**：卡片内仅展示 Agent 回复，不会复读用户在飞书已打出的输入。
   - **本地终端发起的回合**：卡片顶部呈现灰色小字引用本地输入，下方展示回复。

### 6.3 失败排查日志路径
若发消息后无响应，依次检查：
```bash
# 1. 检查待发与积压事件
node scripts/outbox.mjs --list

# 2. 检查出站 Stop 钩子执行日志
tail -n 50 ~/.claude/feishu-bridge/stop-hook.log

# 3. 检查入站受理/拒绝回执
cat ~/.claude/feishu-bridge/receipts/*.json 2>/dev/null || cat .runtime-data/inbound/receipts/*.json 2>/dev/null
```

□ 在 omm 复核于 ____________________

---

## 7. 整体体检判定（doctor）

执行只读体检命令，检查整机健康状态：
```bash
node scripts/doctor.mjs
```
若接入了 Codex 链：
```bash
npm run doctor:codex
```

### 7.1 输出符号含义与判据
| 符号 | 状态含义 | 处理方式 |
|---|---|---|
| `✓` | 正常通过 | 核心组件健康就绪 |
| `?` | 未探测 / 允许的三态中间态 | **已知正常项，不代表系统故障**（详见下文） |
| `✗` | 明确故障 | **阻断项**，必须按提示命令排查修复 |

### 7.2 Linux 环境下的已知 `?` 项说明
- **`⑧′ 机器人发送凭据（lark-cli 密钥）`**：在 Linux 上必须为 **`✓`**。如果为 `✗`，说明 aily 未生成密钥或 `LARKSUITE_CLI_DATA_DIR` 配置缺失。
- **`⑥ 积压有人发（Codex 侧）`**：新装后默认显示为 **`?`**（「未启用（安装后的默认态，不是故障）」）。Codex 链兜底定时器在 Linux 上基于 `systemd --user` 实现，属于可选启用项；安装后默认未启用，日常由 task 正常触发发布。若需启用 30 分钟兜底排空，执行 `node scripts/codex/drain-service.mjs --enable --apply`（**要求能解析到一个不带版本号的 node**：mise shim 或 `FEISHU_BRIDGE_NODE`；解不出来会拒绝启用，不会退回当前进程的 node），启用后该项将变为 **`✓`**；停用执行 `node scripts/codex/drain-service.mjs --disable --apply`。单元里的 node 后来被清掉时，这一项会报 stale 并点出那个路径。
- **`hook 信任（Codex 侧）`**：显示为 **`?`**。Codex 的 hook 安全确认需人工在交互界面核准，命令行无法代劳。

除上述已知 `?` 外，其余项在正式投入使用前均应为 `✓`。

□ 在 omm 复核于 ____________________

---

## 8. 卸载、卸后验证与重装

### 8.1 卸载执行顺序（一键入口，PK3-U1 起）

```bash
node scripts/uninstall.mjs                     # 预览：将停 / 将删 / 将保留（默认不动任何东西）
node scripts/uninstall.mjs --apply             # 按固定顺序卸三条链
node scripts/uninstall.mjs --purge --yes-delete-data --apply   # 连机器级数据一起删（要两个参数）

# 只想单独卸某一条链时，仍可分别跑（顺序同理）：
#   node scripts/install-inbound.mjs  --uninstall --apply
#   node scripts/install-outbound.mjs --uninstall --apply
#   node scripts/codex/install.mjs    --uninstall --apply
```

顺序写死在 `scripts/uninstall.mjs` 里（**别自己改成别的顺序**）：入站技能（止血）→ 出站 hooks/技能/
兜底定时器/（linux）aily daemon 服务 → Codex 链 → `runtime/current` → `--purge` 才动 `versions/` 与数据。
底层仍然是三个安装器各自的 `--uninstall`，一键入口只是把它们按序串起来并逐个核退出码
（失败即停、报在第几步）。想单独卸某一条链，仍可直接跑那条链的 `--uninstall --apply`。

### 8.1.1 互斥与合同（PK3-U1-fix1）
- 一键卸载**整段在安装面锁里**（`<home>/.claude/feishu-bridge/install-surface.lock`，与安装器/维护流程共用）：
  拿不到锁或维护门开着 → exit 2、零写；子安装器继承父进程的持有（`FEISHU_BRIDGE_INSTALL_SURFACE_HELD`）。
- `settings.json` 的合同是「本桥条目消失 + 别人条目逐字段不变」，**不是**"回到装前字节"（重新序列化会规范化格式）。
- `--purge` 的清单来自产品派生函数（两链桥根 + 已知数据文件的覆盖点），不手写文件名清单。
- **删除边界**（PK3-U1-fix4）：产品派生的两处桥根（`<home>/.claude/feishu-bridge`、`<codexHome>/feishu-bridge`）
  整棵删；**显式 `FEISHU_CODEX_BRIDGE_HOME` 只删其下的封闭已知条目、目录本身保留**，且它必须在 home 或系统
  临时目录下（指到 `/etc` 这类位置直接 exit 2 零写）。覆盖点环境变量只删那个文件，不碰它的父目录。

### 8.2 卸载保留项（设计约束）
卸载命令严格只移除非侵入性 hooks、技能目录与定时器，**绝不清理以下权威配置**：
- `chain-config.json`（机器级链路模板）
- `registry.json`（已登记项目的绑定信息，避免会话与话题历史变成孤儿）
- `routes.json`（路由表配置）
- ledger 账本与历史日志数据

### 8.3 卸后验证
```bash
# 1. 确认三份 systemd --user 单元都已停止并注销
#    （Claude 兜底定时器 / Codex 兜底定时器 / aily daemon 服务）
systemctl --user is-active feishu-bridge-cc-drain.timer      # 应显示 inactive 或 not-found
systemctl --user is-active feishu-bridge-codex-drain.timer   # 应显示 inactive 或 not-found
systemctl --user is-active feishu-bridge-aily.service        # 同上
systemctl --user list-unit-files | grep feishu-bridge        # 应输出为空

# 2. 运行 doctor：应报「装机状态：未安装」且**一条 ✗ 都没有**
node scripts/doctor.mjs
```

doctor 的判据（`install_state`）与卸载入口**共用一份**（`install-projection.installFootprint`），
所以"卸干净了"与"doctor 说还有残留"不会互相矛盾；若还有残留，doctor 会把在的项逐条列出来。

### 8.4 再次安装验证
在未删除保留配置的前提下，只需原样重新执行 **第 3 节 安装** 的三条 `--apply` 命令，整条链路即可无缝恢复全功能工作。

□ 在 omm 复核于 ____________________

---

## 9. 已知限制与运行边界

1. **外部处理器话题不自动回复**：
   通过 `routes.json` 路由转交给外部系统（如 `cc2cd`）的话题，其后续回复完全由外部处理程序接管；本桥分发器不会越权向该话题回发卡片。
2. **aily daemon 服务化（PK3-U1 起由安装器接管）**：
   `node scripts/install-outbound.mjs --apply` 在 Linux 上会写
   `~/.config/systemd/user/feishu-bridge-aily.service`（绝对路径 ExecStart、`Restart=on-failure`、
   HOME/PATH 最小补齐，代理等其余环境从 `environment.d` 继承）并 `enable --now`；卸载反向。
   机器上已有 `aily-cli` 自己生成的单元（`aily-cli-daemon-*.service`）时**不覆盖**，会报出来让人定夺。
   非登录常驻仍需 `loginctl enable-linger <用户>`（要 sudo，安装器只提示）。前置步骤 0 的手工做法
   仍然有效（想自己管的时候用）。
3. **单授权人类边界**：
   当前架构授权单一 `frank_sender_id`，非授权用户的 @mention 会被拒绝，暂不适用于开放式多租户团队协作。

□ 在 omm 复核于 ____________________
