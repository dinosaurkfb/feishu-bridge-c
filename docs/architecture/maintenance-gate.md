# 维护门（issue #81）—— 方案稿 v6

> 状态：v5 机制**已实现并有测试覆盖**（`scripts/maintenance-gate-core.mjs` +
> `scripts/maintenance/*` + `scripts/maintenance-gate.mjs` / `maintenance-install.mjs`，
> `--status` 可用，test.mjs 中 187 处相关断言）；端到端 enter→install→reopening
> 是否已在真机跑过一次，未在本稿断言。**v6（2026-09-04）新增"账本接入（M1）"一节**
> —— 把 v2 第三步的权威账本接进维护门（账本 §3/§5.2/§8 与 Codex Q1/Q2 要求）。
> **Codex 五轮评审逐条返修后放行（2026-09-04，无 P1）。**
> v1 → Codex 5 P1 → v2 → 4 P1 → v3 → 3 P1 + 2 P2 → v4 → 4 P1 + 2 P2 → v5（2026-08-30）
> → v6（2026-09-04 账本接入）。评审：Codex（架构）；拍板：Frank（切桩、丢回合、不 claim 已同意）。
> Codex 已在本机实测：**Codex CLI 0.150.1 的 UserPromptSubmit hook 返回顶层 `{"decision":"block","reason":"<非空>"}` 能阻止正文进模型**（模型 0 token，无 agent 内容、无工具调用）。协议不在公开文档里，所以**进门前按当前 Codex 版本跑一次无模型探针**，不只钉版本号。

## 要解决什么

换锁协议（或任何要求"没有旧进程在跑"的安装）时，**人工静默窗口不是门禁**：共用发布锁的调用面有 18 个，而且 Claude 三个 hook、Codex 两个 hook、launchd 兜底定时器、Aily 入站都会随时从 `runtime/current/scripts/*` 起新进程。维护门作用于**启动源**，顺序固定；任一步失败回到"没装、全恢复"；恢复不了就**留门、留账、报 rollback_incomplete**。

## 三种投影，各管一件事

| 投影 | 来源 | 用途 |
| --- | --- | --- |
| **当前投影** | **机器级安装收据**，**每条链一份、随该链的隔离点走**：Claude `<真实 home>/.claude/feishu-bridge/installed-surface.json`，Codex `<Codex 桥目录>/installed-surface.json`（PR B 实现时从"两链共用一份"改的：安装器被 HOME / CODEX_HOME 引到沙箱时收据必须跟着进沙箱，不能写真机；journal 里两份收据是**两个制品**，各自两阶段提交与回退）。每份按版本登记；含门代码的版本安装时经 journal 两阶段写入，含门代码的普通安装器 `--apply` 末尾（全部制品写完之后）也直接记（收据事务锁 `<收据>.lock` 串行化多个安装器；这把锁**不受机器门管**，维护门内部写收据也走它）：每个**桥拥有的封闭条目**的 sha —— settings.json / hooks.json 里带我们标记或指向我们路径的 hook 条目、每个技能文件整份、plist 整份 —— 与引用的脚本；**不是整文件 sha**，无关设置的变化不挡门）。版本目录 `versions/<v>/` 只放静态、与机器无关的模板 manifest。**没有收据的运行时拒绝进门**（`receipt_absent`）：先用普通安装器 `--apply` 装一次含收据代码的版本（PR C 实现时改的：v5 里"按已知 digest 走 legacy 冻结模板"那条不再需要 —— 2026-08-30 两条链线上都已是带收据的 38d07d43，legacy 模板只会是一份没人走的路径）| 进门前预检：线上 hooks / skills / plist / routes 是否与"现在应该装着的"一致 |
| **目标投影** | staged 新版本的 `renderArtifacts()`（纯函数：输入当前制品基线字节 + 路径，输出合并后的全文） | stage / commit：要写成什么 |
| **桩清单** | `maintenanceEntryManifest` = 当前投影已验引用 ∪ 目标投影引用 ∪ 固定 worker ∪ 状态入口 | 桩目录里的文件、进程盘点认的路径 |

目标版本改了 hook 正文或技能正文时，预检核的是当前投影、commit 写的是目标投影，正常升级不会被自己拒。

## 启动源预检（进门前；对当前投影逐字节 / 逐字段对账）

| 启动源 | 权威配置 | 对账 |
| --- | --- | --- |
| Claude hooks（UserPromptSubmit ×2、Stop） | `~/.claude/settings.json` | 收据 sha 相等（桥拥有的封闭条目）；桥拥有的条目各恰好一条；**任何提到运行时根的 hook 命令都必须是桥拥有的**（多一个 shell 动作、第二个 node → 拒） |
| Codex hooks（Prompt / Stop） | `~/.codex/hooks.json` 里带 `FEISHU_BRIDGE_CODEX_HOOK:` 标记的条目 | 同上（`codex/hook-command.mjs` 的投影） |
| 技能（两链） | `~/.claude/skills/<n>/…`、`~/.codex/skills/<n>/…` | 收据 sha 逐字相等（fd 绑定读：符号链接 / 管道 / 多硬链接都不算"制品还在"） |
| launchd（两链） | `launchctl list <label>` + plist | `loadedPhase` ∈ {loaded, installed_not_loaded, absent}（下文统称**原始三态**）且 plist 字节与投影相等；`loaded_other` / `orphan` / `plist_unreadable` / `unverifiable` → 不受验（预检拒了，journal 只会记到原始三态） |
| 路由表 | `~/.claude/feishu-bridge/routes.json` | 只核**有效默认路由**（`defaultRouteHandler` 判据）的 handler；非默认外部 handler（如 cc2cd）不核、只记账（窗口内一样被分发器桩挡） |
| 所有脚本路径 | — | `realpath` 后落在两条 `runtime/current/scripts/` 真实路径下，文件名在桩清单里 |

任一条对不上 → 拒绝进门 `startup_source_unverified`（点名）。

**威胁边界（明写）**：同 UID 人工直接执行克隆或 `versions/<旧版>` 下的脚本不在门的覆盖内；hook 命令引用的**外部脚本正文**（如 `.orca` 的 `.sh`）也不在模型内 —— 预检只解析命令本身（`scripts/maintenance/command-refs.mjs`，进程盘点对 ps 命令行用同一份判据）：**每个 token 无条件**捞出其中所有绝对路径片段（整个 token、`=` / `:` / `,` 之后、内联代码串里的 `import("/x")`、附着式 `node</x`）realpath 后不得落在任一条链的运行时之下（文件不在就按目录解析）；tokenizer 保留操作符类别 —— 单管道、输入重定向 `<`、here-doc / here-string 一律"无法验证"（右侧 / 解释器可能从 stdin 读代码），`env -S <串>` / `--split-string` 递归解析，`node --input-type` / 脚本位 `-` 算从 stdin 读代码；shell 只认纯字母短选项簇（`-c` / `-lc` / `-fc`，簇里不能有 o / O）与无参长选项（`--login --norc --noprofile --posix --restricted --command`），含 `c` 的簇或 `--command` 后的内联串递归解析，其余选项形状（`-O extglob`、`-o pipefail`、`+O`、`--rcfile …`）一律"无法验证"；引号外反斜杠转义按 shell 规则处理，未闭合引号 / 尾随反斜杠 = 解析不了；变量（`$HOME` 以外）/ 命令替换 / eval / exec / source / 解释器内联代码（`node -e/-p` **含组合短选项 `-pe`**、`python -c`、`perl -ne` …，内联串里的绝对路径仍捞出来给进程盘点用）/ 相对路径 / `-r`、`--import`、`--loader` 后不是绝对路径 —— 非桥命令出现任一种一律"无法验证"拒绝。

## 机制：两层 + 一本账

### 第 1 层 · 启动挡板：`runtime/current` → 维护桩（对任何版本旧 runtime 有效）

两条链的 `current` 切到 `versions/maintenance-<token>/`；`scripts/` 下的文件 = 桩清单全集，按类别是同一份桩（都不写任何桥状态）：

| 类别 | 桩的行为 |
| --- | --- |
| Stop hook（两链）、init-hook、定时器、worker、outbound | **无输出** `exit 0`。被挡的 Stop 回合**丢弃**（at-most-once）；可见性来自 journal 与状态页的"维护窗口 N 分钟" |
| 技能引用的控制脚本（bind / rotate / mode / …） | stdout 一行"维护中"，退出码 2 |
| 本地普通 UserPromptSubmit（非 Aily 回合） | 无输出 `exit 0`，放行 |
| Aily UserPromptSubmit（两链；`AILY_CLI_CALLER_AGENT_UID` = 链模板 agent_uid；模板读不出 → 一律当 Aily 回合） | **硬阻断**：stdout `{"decision":"block","reason":"桥维护中（<reason>）：这条消息没有处理，请稍后重发"}` |
| Aily 直接入口（aily-inbound / dispatcher / inbound，两链） | 确定性 stdout `桥维护中（<reason>），这条消息没有处理，请稍后重发`，`exit 0`；不 claim、不写回执；不重放 |
| status / doctor（两链） | `维护中（<reason>，已 N 分钟，token <前 8 位>）`，退出码 2 |

`reason` 经 `displaySafe`、≤ 80 码点。桩目录带 `MAINTENANCE.json`（token / at / reason / 原 current 目标）；`verifyRuntime` 对桩返回 `{ ok:false, reason:"maintenance", gate }`。切换 = `symlink 到临时名 → rename`。

### 第 2 层 · 机器级门文件：含门代码的 runtime 在**每个写入口最前面**看门

路径由**真实用户 home**（`os.userInfo().homedir`）推导：`<真实 home>/.claude/feishu-bridge/maintenance.gate`；只有测试隔离点 `FEISHU_BRIDGE_MAINTENANCE_GATE` 能覆盖。symlink 原语，目标 = `{ schema_version, pid, at, token, reason }`。

**三态读取契约**（门、`maintenance/active`、journal 共用）：`absent` = **只有** ENOENT；`active/valid` = 形状与每个字段受验；其余一律 `unreadable`。写入口对 `unreadable` 与 `active` 同样拒；doctor / status 点名；畸形制品不自动覆盖、不自动删。

看门点：三类 hook 的 `main` 开头、`aily-inbound` / 两链 `inbound` 开头、`drain-outbox` / `codex/drain-all` 开头、守望者每轮、`outbox` 写入、chat 账本准入与记终态、所有控制 CLI 的 `--apply` 分支、`acquirePublishLock`（兜底）。

### 一本账 · operation journal

`<真实 home>/.claude/feishu-bridge/maintenance/<token>.json` + `maintenance/active` → token（同一时间只许一个；`active` 三态，`unreadable` / 指向缺席的 journal → 拒绝新 operation，人工处置）。journal 每次更新都是**原子 + 持久**（tmp → fsync → rename → fsync 目录）。

**每一次外部变更都是两阶段记账**：
1. `prepared`：先写下 `{ kind, target, before, backup, intendedAfter }`（制品：`before = { exists, sha }`、备份路径、`intendedAfter sha`；current：`before 目标`、`intendedAfter 目标`；定时器：原始三态 + plist 原字节备份；收据：before 条目 + intendedAfter 条目）并落盘；
2. 做变更；
3. `done`（记实际 after）。

**恢复规则（只看 journal 里的 prepared / done 与现场）**：
- `prepared` 且现场 == before → 没做过，跳过；
- `prepared` 或 `done` 且现场 == intendedAfter → 做过：回退方向写回 before（用备份原字节 / 原目标），前进方向保留；
- 现场既不是 before 也不是 after → `rollback_incomplete`（该项留给人，门与账保留）。

阶段：`planned → timer_stopped → stubbed → gated → drained → staged → committed → verified → reopening → done | reopening_incomplete`；失败分支 `rolling_back → rollback_reopening → rolled_back | rollback_incomplete`。`*_incomplete` = 动了但没做完（CAS 不成立、撤门后归属转换锁交不还、active 清不掉）：门与账保留，`--exit --apply` 只向前重试。`rolling_back` 里恢复 install 写入时有说不清的项 → **停在 `rolling_back`**（同样门与账保留，`--exit --apply` 重试的是恢复本身），全部干净才进不可逆的 `rollback_reopening`。journal 形状按 step kind 封闭（timer / current / stub / gate / artifact / receipt 各自的 before / intended_after / after；current 的 id 是 `current:<chain>`（enter：原目标 → 桩）或 `current:<chain>:install`（commit：桩 → versions/<v>）），phase 与"必须已 done 的 step"一致（committed 及之后要求两条 `current:<chain>:install` 与 `receipt:<chain>` 都 done）；备份先写满 fsync，sha256 与长度进账，恢复前核验。

**执行租约**：同一 operation 的 enter / exit / 续跑只许一个执行者 —— `maintenance/<token>.lease`（registry 锁协议，**只按持有者 pid 活性接管，不按时间**，等进程可以很久），journal 每次写入都在租约 reap 段内核对 token（被接管后晚到的写入 lease_lost，不落盘）；写入还核 active 仍指向本 token、阶段前驱合法、**传入的租约路径属于本 operation**（`lease_mismatch` —— 拿别的 operation 的租约写不进）。maintenance-install 从进门到 reopening / 回退结束**连续持有同一租约**（释放再重取会留出 operation 被换掉的窗口）；stage / commit / verify / reopening 的绑定还要求**真持有租约实例**（锁原语 fencing 段核验，`lease_not_held` —— 伪造 `{ path }` 或已释放的租约在任何写之前被拒），缺租约受控返回 `lease_required` 不裸抛。

**两个不可逆的重新开放阶段**（旧 runtime 不认识机器门：一旦某条 `current` 从桩指回真实 runtime，那条链就已经重新放行，此后不许再改线上制品）：
- 成功路径 `reopening`：定时器回到**目标状态**（见下）→ 删桩目录 → token-CAS 删门 → **先把终态 `done` 持久化进 journal** → 最后一个动作 token-CAS 清 `active`；清 active 之后不再写任何 operation 状态。
- 失败路径：`rolling_back` 里先把**全部线上制品**按备份恢复到 before 并核验（此时两条 `current` 仍是桩，门仍在）→ 进入 `rollback_reopening`（不可逆）：`current` 回原目标 → 定时器回原始三态（原 plist 字节 + 原 loaded 与否）→ 删桩 → token-CAS 删门 → 持久化终态（`rolled_back`，或有 CAS 不成立项时 `rollback_incomplete`，此时**不删门、不清 active**）→ 最后 token-CAS 清 `active`。进入 `rollback_reopening` 之后不得再回到回退写操作。
- 两条路径都：崩在中间 → `--status` 报"<阶段> 未完"，`--exit` 从 journal 继续向前（每步幂等）；`active` 最后清，"门已删、operation 未终结"窗口里 `--status` 仍看得见。

**定时器的目标状态**（成功路径）：commit 已把**目标 plist** 写到位，reopening 只恢复"是否 loaded"，`bootstrap` 用的是目标 plist：Claude 兜底定时器 → 一律 loaded（安装器语义：装完就加载）；Codex 兜底排空 → 与原始三态一致（安装器不替人启用）。原始为 absent 时：Claude → loaded（目标 plist 已写）；Codex → absent。回退路径才用原 plist 字节 + 原 loaded 与否。

### 等既有进程退出

只在预检通过之后做，只认桩清单里的入口：`ps -axo pid,ppid,command`，脚本路径（realpath）落在两条 `current/scripts/`（含桩）或 `versions/<原目标>/scripts/` 下的进程，递归计入 ppid 子树，排除维护门自己与祖先。`--wait-ms`（默认 60 秒，5 秒步进）。`ps` 失败 / 解析不了 → `inventory_unverifiable` 中止；超时 → 中止并回退，报残留 pid 与命令行，**不 kill**。

### 安装：stage → 单点 commit → 核验 → reopening

`stage` / `activate` **不公开 CLI**，只是 `scripts/maintenance-install-core.mjs` 的模块 API，每步绑定 active operation（token、journal 阶段、staged version 已验、两条 `current` 此刻仍是本 token 的桩），否则拒。

1. **stage**：
   - 两条链把新版本落到 `versions/<v>/`（`applyRuntimeSync` 拆出的 `stageRuntimeVersion`，只落目录不切 current）。**`versions/<v>/` 是内容寻址的不可变缓存，不是线上状态**：current 不指它就不可达；operation 失败时**保留**（可重用），不算"改了线上"；
   - 目标投影 `renderArtifacts({ home, codexHome, codexBridgeHome, runtimeVersion:v, templates, base })`：**输入每个制品此刻的基线字节**（`base(path) → { exists, sha256, bytes }`，fd 绑定读，缺席也是一种明确基线；技能 / 模板从 `templates.<chain>` = `versions/<v>/` 读，不读线上），输出 `[{ chain, path, kind, bytes, base:{exists,sha256}, intendedAfterSha, inReceipt }]` 与两条链的**安装收据草稿**。制品集合与三个安装器逐一对应；**Codex 兜底 plist 只在基线存在时写目标字节且不进收据**（drain-service 才装它，安装器不替人启用）；
   - 全部写进 `maintenance/<token>.staged/`（`artifacts/<n>` 目标字节 + `plan.json` + 之后 commit 的 `backups/`）；
     **plan 锚**：`plan.json` 的 sha256 + 版本作为 `staged_plan` step 写进受租约保护的 journal —— commit / verify 只认锚上的那份 plan
     （plan 本身不是信任根：封闭形状受验，`file` 只许 `artifacts/<下标>`，目标路径必须 ⊆ 由投影**重算**的安装面 allowlist）；**不碰任何线上配置**。
2. **verify staged**：`verifyRuntimeVersion({ root, version })` 两链通过；plan 过锚（sha / 版本）与封闭形状；制品路径 ⊆ 安装面 allowlist；staged 制品与收据草稿引用的脚本都在桩清单里、且在本链 `versions/<v>/scripts/` 下存在（桩清单以 `versions/<v>/` 为源码树重算，missing 为空）。commit 前再跑一遍同一组检查。
3. **commit**（门仍在；每步先绑定：active token、阶段前驱、门 active 且 token 一致、**执行租约属于本 operation**、两条 `current` 仍是本 token 的桩）：
   - 两条 `current`：各自 prepared（桩 → `versions/<v>`）→ `activateRuntimeVersion`（先验目录再切；**expectBefore 的 CAS 在安装锁内**，与 rename 同一把锁，检查与切换之间没有窗口）→ done；任一条失败 → 整次中止，由回退按恢复规则切回桩。门还开着，新 runtime 的每个写入口都看门，切过去不等于放行。**安装面的准入是锁不是检查**：三个普通安装器的 `--apply` 在看门**之前**先取机器级**安装面锁**（`<home>/.claude/feishu-bridge/install-surface.lock`，registry 锁协议、staleMs = ∞ 只按持有者 pid 活性接管、未知形状不回收；持有到本进程退出），`maintenance-gate --enter/--exit --apply` 与 `maintenance-install --apply` 在 enter 之前取**同一把**、持有到 reopening / 回退与租约释放完成 —— 门检是瞬时的，"安装器过检后门才建立"的竞态（评审探针实测）由锁互斥挡住，维护窗口内没有别的协议内安装写方（同 UID 人工直接执行克隆脚本仍在威胁边界外）；
   - 每个制品：**写前 CAS**：现场 `{exists, sha}` 必须 == stage 时的 base，否则整次中止并回退已写项（`base_changed`，点名）；通过 → prepared（原字节备份进 `<token>.staged/backups/`）→ 原子持久写 → done；
   - 两份机器级收据（每链一份）按同样两阶段记账：**一次 fd 读产生同一份快照**（合并基 = CAS 基 = 备份来源），确定性合并出 intended 字节（与 `recordInstalledSurface` 同一合并语义：版本变了整链换）→ prepared（原收据备份）→ **收据事务锁**内重读 CAS 后写入；任何锁残骸（reap 交不还 / 释放失败）都算失败、不记 done → `committed`；版本目录不写任何机器相关的东西。
4. **verify live**：`verifyRuntime` 两链 == v；线上制品 sha == after；plist 制品的 ProgramArguments == 期望 job（窗口内定时器本来就停着，装完由 reopening 决定是否 loaded）；**Codex 阻断探针（无模型）**：门还开着，起新 runtime 的 `codex/prompt-hook.mjs`（Aily 环境、门与桥目录经环境注入），必须顶层 `decision:"block"`。
5. **reopening**（不可逆）：**删门前精确复核** —— 两条 install `current` 精确等于目标版本、全部制品 / 收据精确等于 journal 的目标状态，任一不符 → `reopening_incomplete`（门、active、staged 都保留）；全部对得上才：定时器到目标状态（用**目标 plist**；Claude 一律 bootstrap，Codex 按原始三态）→ 删桩目录 → 删 `<token>.staged/` → token-CAS 删门 → 持久化 `done` → 最后 token-CAS 清 `active`。

`maintenance-install [--reason <r>] [--wait-ms N] --apply` = enter（预检 → journal → 停定时器 → 切桩 → 建门 → 等进程）→ 1–5。1–4 里任一步失败按 journal 回退到进门前（含 `versions/<v>/` 保留这一条例外）：`rolling_back` 先**逆序**恢复 install 写入（收据 → 制品 → `current:<chain>:install` 回桩，各自 CAS；说不清 → 停在 `rolling_back` 可重试），全部干净才进 `rollback_reopening`。`lease_reap_uncleared` → 立即停，什么都不再动。

## 命令面

```
node scripts/maintenance-gate.mjs --status                       # 只读：门 / active / journal / 桩 / 定时器三态，以及 reopening 未完
node scripts/maintenance-gate.mjs --enter --reason "<≤80 码点>" [--wait-ms 60000]
node scripts/maintenance-gate.mjs --exit                         # 未到 reopening：按 journal CAS 回退；已到 reopening：只向前继续
node scripts/maintenance-install.mjs [--reason "<≤80 码点>"] [--wait-ms N] [--apply]   # enter → stage → verify → commit → verify → reopening；默认只预览
```

`--enter` / `--exit` / `--apply` 都是安装类授权（Frank 逐次授权）。不提供 `--force` / `--kill`。没有 stage / commit CLI（`scripts/maintenance/maintenance-install-core.mjs` 只是模块 API，每步绑定 active operation）。退出码同 maintenance-gate：0 完成 / 预览；1 拒绝或失败但已完整回退；3 动了没做完（门与账保留）。

## 不变量（测试要盯的）

1. 预检：任一启用入口与**当前投影**（收据 / legacy 模板）对不上（多一个 shell 动作、第二个 node、指向克隆 / 旧版、launchd `loaded_other`）→ 拒绝进门，什么都没动；目标版本改了 hook 正文时预检仍通过、commit 写的是目标投影。
2. 门开着时：Aily 回合两链都被顶层 `decision:block` 挡（Codex 侧：零模型 token、无 agent message、无工具调用；Claude 侧：输出形状逐字核）；本地回合无输出放行；Stop 无输出且不写 outbox、不起守望者；入站回维护中且没有 claim；定时器脚本退；`acquirePublishLock` 返回 maintenance；控制命令报维护中。
3. 三态：门 / active / journal 为目录、畸形 payload、EACCES 时，写入口拒绝、doctor 点名、不自动删；只有 ENOENT 是 absent。
4. journal 先于任何外部变更：在 `bootout` 之后被杀 → `--status` 说清阶段与原状态，`--exit` 恢复定时器到原始三态。
5. 两阶段记账：在"写成功、done 未记"处被杀 → 恢复按"现场 == intendedAfter → 做过"处理，回退写回 before；current rename 同理。
6. stage 到 commit 之间线上制品被改 → commit 写前 CAS 拒（`base_changed`），已写项按备份回退，线上等于进门前。
7. CAS：进门后有人切走某条 `current` 或改了某个制品 → `--exit` 不覆盖，报 `rollback_incomplete`，门与账保留。
8. reopening：删门之后被杀 → `--status` 报 reopening 未完、active 仍在；`--exit` 只向前，先持久化终态再清 active；不会再回退。成功路径结束后线上 plist == 目标字节（不被改回原版），Claude 定时器 loaded；回退路径结束后 plist == 原字节、loaded 与否 == 原始三态。
8b. 失败回退：制品全部恢复并核验之后才进入 `rollback_reopening`；在 `current` 已回原目标之后被杀 → `--exit` 只向前（定时器、删桩、删门、终态、清 active），不再碰任何线上制品。
9. 等进程超时 → 什么都没装、`current` 回原目标、门没了、定时器回原始三态、桩目录与 staged 私有目录删了；`versions/<v>/` 可保留。
10. `verifyRuntime` 对桩返回 `maintenance`；status / doctor 显示维护中。
11. 桩清单 = 当前已验引用 ∪ 目标引用 ∪ 固定 worker ∪ 状态入口；沙箱安装产出的所有引用脚本 ⊆ 清单；清单每项在源码树存在。
12. stage / activate 的模块 API 在没有 active operation、token 不符、阶段不对、current 不是本 token 的桩时一律拒绝。
13. 含门代码的版本安装时经 journal 写机器级收据；下一次预检用收据里桥拥有条目的 sha 对账（settings.json 里无关设置改了不挡门）；没有收据一律拒绝进门（`receipt_absent`，先用普通安装器 `--apply` 装一次含收据代码的版本）；verify 失败回退后收据里没有目标版本的条目。
14. 终态先于清 active：在"终态已持久化、active 未清"处被杀 → `--status` 仍能看到 operation 且报已终结；`--exit` 只清 active。

## 账本接入（M1，2026-09-04；v6，Codex 首轮 4×P1/2×P2 返修）

v2 第三步的权威账本（`layers-v2-ledger.md`）是新的生产写入面，Codex（该步 Q1/Q2）
裁定：**启用前必须纳入维护门**，且 `authority_mode` 的 `shadow→authoritative`
切换**必须在门内一次提交**。本节把账本接进已有的两层 + 一本账，不新造机制。

### A. 账本写面纳入看门（普通写，门外的常态）

- 账本的常规写（入站路由器 / bind·rotate 控制入口）经 `acquirePublishLock`
  （账本 §3），**已经看门**（§第 2 层：`acquirePublishLock` 兜底返回 `maintenance`）
  ——门开着时账本写取不到锁、受控退出，回执路径回"维护中请重发"、**不先发回执再
  延后写账本**（账本 §9、Q2）。**M1a 的 shadow 写也走这条 gated 写**（评审 P2-1：
  shadow 账本照常经 gated ledger write 写入同批事实，只是**生产路由仍以 legacy
  registry 为权威**——不是"shadow 不写"）。
- 看门点清单（§第 2 层）**补上账本写入口** `withLedgerWrite` 的提交段。**doctor
  的账本读是"诊断接线"、不是看门点**（评审 P2-2：维护期间恰恰要靠它诊断 ledger /
  journal / 锁，绝不能被门挡）。
- **启动源无新增**：账本由现有 runtime/current/scripts 下的入站入口写，进程盘点与
  桩清单（realpath ⊆ `current/scripts`）已覆盖；账本数据目录 `ledger/<endpoint_id>/`
  是**数据**、不是启动源，不进桩清单、不进预检对账。§预检 / §桩清单两张表**不因
  账本而变**。

### B. 两类独立的账本维护 operation（评审 P1-1：拍死独立 operation、封闭 kind）

现有 journal 无 `operation_kind`、`PHASE_REQUIRES` 是一套固定要求，无法同时表达
"普通 enter/exit 不要 ledger step / runtime install 要 install steps / 账本 init /
cutover 各要自己的步骤"。故**引入封闭 `operation_kind`**，账本接入用两个新种、
**不塞进 maintenance-install**（放弃双实现）：

| operation_kind | 阶段序列（forward-only 段加粗）| 必需 step | terminal | success reopening |
| --- | --- | --- | --- | --- |
| `ledger_init` | …drained → **ledger_initializing** → `ledger_reopening` → done \| reopening_incomplete | `ledger:<ep>:init` | done | 见 B-4 |
| `ledger_cutover` | …drained → **ledger_cutting_over** → `ledger_reopening` → done \| reopening_incomplete | `ledger:<ep>:cutover` | done | 见 B-4 |

**关键差异（评审 P1-1）**：账本 operation **不切 runtime、不装新 plist**——它只是为了
"门内安静地写账本一笔"而临时切桩，做完把 `current` **切回原目标 runtime**、定时器
**回进门前原始三态**（不像 install 的 reopening 指向新版本、用目标 plist，也不像
rollback 记 `rolled_back`）。

**`PHASE_REQUIRES` 逐 kind 封闭（三轮 P1-2：terminal 还必须要求进门步骤全 done，
不能只凭一条 ledger step 认作 done）**——`ENTER_DONE` = {`timer:<chain>`、
`stub:<chain>`、`current:<chain>`（两链）、`gate`} 全部 `done`：

| phase | 必需且 done 的 step | 说明 |
| --- | --- | --- |
| `ledger_initializing` | `ENTER_DONE`；`ledger:<ep>:init` 可尚不存在或 `prepared`；**禁 sidecar** | forward-only 段 |
| `ledger_cutting_over` | `ENTER_DONE`；**进段原子合同（十六轮 P1）：drained → 本阶段的同一次 journal 提交里原子加入 ① `ledger:<ep>:cutover` step（`prepared`，其 before/intended 已含 `plan_sha256`）② 三条 sidecar step（全部 `prepared`）③ phase 翻转——三者缺一即该提交非法**；本阶段**全程不得缺 ledger step**；sidecar 未全 done 时 ledger step 只能 `prepared`；sidecar 全 done ∧ 按已锚 plan 二次验证通过后才允许提交账本并把 ledger step 转 `done`（done 时三条 sidecar 必已全 done），随后只可推进 `ledger_reopening` | forward-only 段（v14） |
| `ledger_reopening` | `ENTER_DONE` ∪ {`ledger:<ep>:init`\|`cutover`} 且 ledger step `done`；**（cutover）三条 sidecar 全 `done`** | 进入前必 done；B-4 逐步 |
| `done`（成功重开后）| 同 `ledger_reopening` | — |
| `reopening_incomplete`（ledger kind）| 同 `ledger_reopening`（**不**要求 install step）| 重开残步未清（含 3b 备份删除失败）：步骤 1–3/3b 失败时门**尚未撤**、撤门（4）失败时门**可能已部分撤**——都进这里 |

`--exit` 按 `operation_kind` **分派**到 ledger 的 success reopening（`ledger_reopening`），
**不复用 install 的 reopening**（三轮 P1-2 / 四轮 P1）。

`ledger_*` kind **禁 install 的 `artifact`/`receipt`/`staged_plan` step**；
`maintenance_gate`/`maintenance_install` kind **禁 `ledger` step**。

**sidecar step（M1a v8 回带，`m1a-reconciliation.md` §4.1；八轮 P1-3 封闭联合）**：
新 step kind `sidecar`，仅 `ledger_cutover` 允许（**`ledger_init` 禁 sidecar**）。
**plan 锚（十三/十四轮 P1-1）**：`plan_sha256` 是 **cutover ledger step 三个状态对象
（before/intended_after/after）的字段**（B-2 表已列四格；init 状态对象无此键）。plan.json
精确 schema = `m1a-reconciliation.md` §4.1-4e 的 m1a-cutover-plan-1。四个文件（plan.json +
三 blob）逐个 O_EXCL 写满 fsync 后**必须再 fsync `intended/` 目录**，目录 fsync 失败不得
推进 forward-only；重启后凭 journal 锚验证同一份原始 plan，进程内引用不作数：
- id = `sidecar:<name>:<ep>`（name ∈ {expiry, pending-claims, policy}）；**按 phase 计数
  （九轮 P1-4）**：`drained → ledger_cutting_over` 的阶段推进与三条 prepared sidecar step
  **同一次 journal 提交**写入；此前任何阶段 **禁 sidecar step**；进入 ledger_cutting_over 起
  **恰三条**（各自 prepared 或 done）；`ledger_reopening` 起三条**全部 done**；
- **prepared/done 两个精确键集（九轮 P1-3 / 十三轮 P1-1 扩）**：prepared =
  {at, backup, backup_bytes, backup_sha256, before, id, **intended_blob**, intended_after,
  kind, state, target} 且 **after 键缺席**；done = 前者 ∪ {after} 且 after === intended_after
  （逐字段）且 **after 必来自写后受验读回**；`intended_blob` =
  `{ path, bytes, sha256 }`——path **必等于重算的** `<token>.staged/intended/<name>` 规范路径、
  校验时受验为**普通单硬链接 0600 文件**、`sha256 === intended_after.sha256` 且长度等于
  bytes；恢复只从该 blob 读 intended 字节；
- `target` 由 endpoint+name 内部派生（`ledger/<ep>/<name>.json` 规范路径，校验器重算比对，
  不信任 journal 中任意路径）；before/intended_after/after = `{ exists, sha256 }` 联合
  （absent 显式 `{exists:false, sha256:null}`）；**cutover 三个 intended_after.exists 必为
  true**；
- 备份：before.exists=true → backup 绝对路径（**必须落在本 operation 私有目录**
  `<token>.staged/` 下）+ backup_sha256/bytes 齐；before.exists=false → **三个 backup 字段
  全 null**；恢复前受验读取备份并核长度/SHA，核不过 → 该项 incomplete（不盲写回）；
- `ledger_cutover` 的 `ledger_reopening`/`done`/`reopening_incomplete` 阶段要求 =
  ENTER_DONE ∪ {ledger step} ∪ **全部三条 sidecar steps 均 done**；恢复时
  pre_cutover_ledger_sha 与各 sidecar intended SHA **一律从首次 prepared journal 重放**，
  不得按变化后现场重算。

**schema 判别联合（九轮 P1-2 收为三支，写死枚举、各自独立分支不猜）**：
- **1.1**：无 `operation_kind`；独立旧版分支读，只作历史 journal，不参与收据索引；
- **1.2**：必含 `operation_kind ∈ {maintenance_gate, maintenance_install, ledger_init,
  ledger_cutover}`；**禁 sidecar step**（读到 sidecar 即 unreadable）；
- **1.3**：= 1.2 + `ledger_cutover` 的 sidecar step（仅此 kind 此用途）；
- **未终结的 1.2 ledger_cutover 不得直接续跑成 1.3 cutover**（十轮 P2-2 展开）：
  旧 journal 处于 forward-only **之前**（≤drained）→ 按 1.2 矩阵安全回退；
  已进 forward-only / 现场已提交 → **fail-closed 人工处置**（绝不用 1.3 语义猜测续跑）；
  之后才允许重开新 1.3 operation。

**锁面（评审 P1-1：账本 operation 也是安装面写方——它停定时器、切桩、开门、reopening）**：
`--init/--cutover --apply` 必须在**预检与 createOperation 之前**取机器级**安装面锁**
（`install-surface.lock`，registry 锁协议、staleMs=∞ 按持有者 pid 活性接管），持有到
reopening 与 operation lease 释放完成；释放失败压成退出码 3。**封闭锁顺序**：
安装面锁 → operation 租约 / active / 门 → **（ledger_cutover）三把 sidecar 文件锁逐个
取得、提交并干净释放** → 账本锁（`acquireLockUngated` 只在这条受验维护路径内允许）。
sidecar 段任一 not_owner / reap 残骸 / 释放异常 → **停在 authority cutover 之前**；每个
sidecar 写后读回核 SHA === prepared intended SHA 才算 done（九轮 P1-5）。这样普通安装器无法在 ledger operation 进门窗口改 current 或
安装面（与 v5 已解决的"过检后才建门"竞态同一把锁挡住）。

### B-1. 不可逆边界进阶段机（评审 P1-2）

`ledger_initializing` / `ledger_cutting_over` 是 **forward-only 阶段**：**任何账本
提交之前**先把它 setPhase 持久化；一旦进入，`--exit` **只能向前完成或停门待修，绝不
进 `rolling_back`**。这堵死"账本已切 authoritative / 已建 revision=1，但 journal 没
推进，`--exit` 走普通 rollback 把旧 runtime 重新开放"的窗口。崩在"账本提交成功、
`markStepDone` 未记"窗口时，先按**账本精确身份**（下 B-2）收敛，再决定 reopening；
不按 mode/revision 猜。

### B-2. ledger step 的身份状态与两个判据（评审 P1-4 / 二轮 P1-2）

`ledger` step 的 `before/intended_after/after` 按 `init | cutover` 各自**封闭键集**
（值域可直译校验器），**absent 用显式 null、单一状态源 = `step.state`**（不设嵌套
`receipt_state`）：

| 字段 | init.before | init.intended_after/after | cutover.before | cutover.intended_after/after |
| --- | --- | --- | --- | --- |
| `endpoint_id` | `<ep>` | `<ep>` | `<ep>` | `<ep>` |
| `operation_id` | 本 op | 本 op | 本 op | 本 op |
| `fingerprint` | 本 op（layers-v2-ledger.md §5.1）| 同 | 本 op | 同 |
| `authority_mode` | `null`（账本不存在）| `"shadow"` | `"shadow"` | `"authoritative"` |
| `revision` | `null` | `1` | 切换前 revision | `before.revision + 1` |
| `ledger_sha256` | `null` | 提交那一刻整文件 SHA | 切换前 SHA | 提交那一刻 SHA |
| `bijection_digest` | —（不适用）| — | `null` | 账本 §8 双射对账摘要 |
| `plan_sha256`（十四轮 P1-1：**属三个状态对象**，非 step 顶层）| —（init 不适用，无此键）| — | `null` | `<token>.staged/intended/plan.json` 受验原始字节 SHA |

**两个不同判据（二轮 P1-2：整文件 SHA 只在恢复窗口用，不能长期比）**：

- **prepared 恢复窗口**（门仍开、step=prepared、提交成功但 done 未记）：现场账本必须
  与 `intended_after` **完整逐字段、逐 SHA 相等** → 补 `markStepDone`。
- **done 永久收据**（初始化/切换早已完成，其后 M1a shadow 写 / authoritative 写会
  合法推进 revision 与整文件 SHA）：判据**不是**整文件 SHA 相等，而是「**当前账本合法，
  且其 `operations` 表含本 `operation_id` 对应的不可变 init/cutover 事务，
  `fingerprint`/`result_revision` 精确相符，当前 `revision ≥ result_revision`**」——
  **允许后续合法事务改变整文件 SHA**。doctor 的 cutover 对账同理：核**不可变事务祖先
  + `authority_mode`**，不要求当前 SHA == 切换当时 SHA。

**恢复矩阵（三轮 P1-1：按 step kind 通用 before/intended，同时覆盖 init 与 cutover）**
——`before` 投影随 kind 不同：**init.before = 账本 absent（显式 null 身份）；
cutover.before = shadow 身份（切换前的 authority_mode/revision/SHA）**：

| journal step 状态 × 账本现场 | 处置 |
| --- | --- |
| `prepared` + 现场 == **before**（init：absent；cutover：shadow before） | 尚未提交 → 执行/重试 |
| `prepared` + 现场 == **intended_after**（逐字段逐 SHA） | 已提交 → 补 `markStepDone` |
| `prepared` + 账本 absent 但 before≠absent（即 cutover 现场丢失） | **账本丢失**（fail-closed）|
| `prepared` + unreadable / 既非 before 也非 intended | 损坏、人工介入 |
| `done` + 账本 absent/unreadable | **账本丢失**（fail-closed、不重初始化，账本 §8）|
| `done` + 当前账本含精确 init/cutover 事务（"done 永久收据"判据）| 有效，允许其后存在合法事务 |

### B-3. 每 endpoint 永久收据的聚合读取协议（评审 P1-3 / 二轮 P2-2）

已 done 的 `ledger_init` **与** `ledger_cutover` operation journal **都永久充当该
endpoint 的维护审计收据**（二轮 P2-2：两者都保留、都不算 orphan），不删——它们要在
**账本丢失后仍能证明"这个 endpoint 曾初始化 / 曾切权威"**（账本丢了，其内部
`operations` 表也没了；永久标记必须在账本之外）。现有 `inspectMaintenanceDir` 把
"不被 `active` 指向的 journal"一律当 orphan——正常完成的 init/cutover 会永久染红。
故定**机器级 endpoint 收据投影**：

- **封闭枚举**维护目录下全部 journal，取 `operation_kind ∈ {ledger_init,
  ledger_cutover}` 且 terminal `done` 的，按 `endpoint_id` 建**唯一索引**（init 一份、
  cutover 至多一份）；
- 判据：**从未初始化**（无 init 记录）/ **恰一份 init（可另有一份 cutover）** /
  **重复或矛盾**（多份 init、或与"done 永久收据"判据不符）/ **某 journal 读不出**
  → 后两者一律 **fail-closed**（拒绝新 `ledger_init`/`ledger_cutover`、doctor 红）；
- **盘点区分**：`ledger_init(done)` / `ledger_cutover(done)` 的 journal 是**合法永久
  收据**、不是 orphan；`inspectMaintenanceDir` 据 `operation_kind`+terminal 区分，
  合法收据不染红。
- **schema 版本兼容（二轮 P2-1）**：journal schema 升版加 `operation_kind`（完整域
  = 现有 gate/install 的既有种 + `ledger_init` + `ledger_cutover`）；**旧 1.1
  journal 无该字段 → 按既有种（gate/install）读，不当 unreadable**——否则升级后旧
  journal 全成 unreadable、被 B-3 全局 fail-closed 卡死。

### B-4. success reopening 的封闭顺序（二轮 P1-4：账本 operation 不装新 plist）

账本 operation 的成功重新开放，**逐步封闭、每步 CAS**（与 install reopening 的
"目标态"不同——这里回**原始态**）：

1. 两条 `current` **CAS 回原目标 runtime**；
2. 定时器恢复**原 plist 字节 + 原 loaded 三态**（不是 install 的目标态）；
3. 删除**已不再被 current 引用**的桩；
3b. **删除本 operation 的受验 staged/backup 目录**（十轮 P1-3：内含 bearer claim / policy
   内容，不得永久残留；仅限 `<token>.staged/` 规范路径、逐项受验后整目录删）——删除失败 →
   `reopening_incomplete`（门与 active 保留）；status/doctor 区分 active operation 的备份
   （合法在场）与 orphan 残骸（染红点名）；
4. token-CAS 撤门；
5. 持久化 `done`；
6. 最后 token-CAS 清 `active`；
7. **释放次序：先 operation 租约，最后安装面锁**（与"安装面锁持有到租约释放完成"逐字
   一致）。

整段在 `ledger_reopening` 阶段（进入前 ledger step 必 `done`）；`--exit` 按
`operation_kind` 分派到这里，不复用 install。**失败封闭（三轮 P1-3 / 四轮）**：
- 步骤 1–3 **任一失败**（current 说不清 / 原 plist 备份核不过 / 定时器恢复失败 /
  桩删不掉）→ **保留门与 active、不执行 4–6**，进 ledger 的 `reopening_incomplete`
  （门、active 保留；**ledger_init 无 staged 制品；ledger_cutover 有受验 staged 目录
  （intended/plan.json + bearer/policy blob + backups）** `<token>.staged/`，其删除步见下），
  该链留给人、
  `--exit` 只向前重试；
- 撤门（4）异常或 `.txn` 交不还 → 同样 `reopening_incomplete`（门可能已部分撤，
  active 保留）；
- **门撤后 `done`（5）未写下**：恢复**只继续终态收口**，**不再拿当前账本 SHA 重判
  ledger 提交**——此时正常写可能已恢复并推进 SHA（用"done 永久收据"的不可变事务
  判据，不用整文件 SHA）；`done` 写不下 → **不得清 active**；
- **清 active（6）/ 释放（7）分开看**：active 仍由本 operation 持有 → 可 `--exit`
  续跑；若**终态已落、active 已清**，只是租约 / 安装面锁释放失败 → **operation 已
  完成、命令退 3**，由 status/doctor 点名锁残骸，**不存在可 `--exit` 续跑的 active
  operation**。

任一 `current` 说不清时，不恢复**该链**定时器、不删**同链**桩、不撤门。

### C. 编排与命令面

- **M1a（种子 + shadow 对账）不进门**：shadow 账本照常经 gated ledger write 写入
  （A 节），生产路由仍以 legacy registry 为权威（账本 §8）；doctor 旁路对账。
  **只有 `ledger_init`（首建 shadow 账本）与 `ledger_cutover`（切权威）两个 operation
  进门**。
- 二者是**独立 operation**（B 节；`--enter/--exit --apply` 同安装类授权），与 runtime
  安装正交、回退面更清。
- **doctor 增账本对账**（诊断接线、非看门点）：endpoint 收据投影（B-3）唯一且一致；
  cutover 对账核**账本 operations 表里的不可变 cutover 事务祖先 + `authority_mode`**
  （B-2"done 永久收据"判据，**不**要求当前 SHA == 切换当时 SHA，账本 G14）；账本自身
  G1–G15。

命令面新增：

```
node scripts/maintenance-ledger.mjs --status
node scripts/maintenance-ledger.mjs --init   --endpoint <id> [--wait-ms N] --apply   # ledger_init
node scripts/maintenance-ledger.mjs --cutover --endpoint <id> [--wait-ms N] --apply   # ledger_cutover
```

（沿用 maintenance-gate 的租约/门/journal/退出码；`--apply` 逐次授权；无 `--force`/`--kill`。）

### D. 账本接入的新增不变量（测试要盯）

- L1 门开着时账本常规写（含 M1a shadow 写）取不到锁（`maintenance`）、回执回"维护中"、
  **账本零写入**；门关掉后重发能正常写。
- L2 **prepared 恢复**：写账本成功、`markStepDone` 未记处被杀 → 恢复按**完整身份**
  （含 `ledger_sha256`）判"现场 == intended_after → 做过"补 done；同 mode/revision 的
  错误内容**不**被误当完成。
- L2b **done 永久收据（二轮 P1-2）**：init/cutover 完成后 M1a shadow 写 / authoritative
  写合法推进 revision 与整文件 SHA → 收据判据用"当前账本含本 operation_id 的不可变
  事务、fingerprint/result_revision 相符、revision≥它"，**不**因整文件 SHA 变了而报矛盾。
- L3 WAL 恢复矩阵（B-2 表）逐格成立；`done + 账本 absent/unreadable` **不**重初始化
  （账本 §8 fail-closed、绝不回退 registry）。
- L4 forward-only：进入 `ledger_initializing`/`ledger_cutting_over` 后 `--exit`
  **绝不进 rolling_back**，只向前或停门待修；cutover 后普通写改不回 shadow、重放不新增
  第二笔（账本 G14）。
- L5 operation_kind 封闭：`ledger_*` operation 不要 install 的 artifact/receipt/
  staged_plan step；enter/install 不要 ledger step；旧 1.1 journal 无 operation_kind
  按既有种读、不 unreadable（二轮 P2-1）。
- L5b **安装面锁（二轮 P1-1 / 十一轮 P2 同步）**：`--init/--cutover --apply` 在预检/
  createOperation 前取 install-surface.lock、持有到 reopening + 租约释放；锁序 = 安装面锁 →
  租约/门 → **（cutover）三把 sidecar 文件锁逐取逐交清释放** → 账本锁；sidecar 段任一
  not_owner/reap 残骸/释放异常停在 cutover 前；普通安装器在 ledger operation 进门窗口改不了
  current / 安装面。
- L5c **reopening 顺序与失败封闭（二轮 P1-4 / 四轮 / 十一轮 P2 同步）**：成功重开按 B-4
  顺序（current 先回原目标 → 定时器回**原始三态** → 删无引用桩 → **3b 删除受验
  staged/backup 目录** → 撤门 → done → 清 active → 先租约后安装面锁）；**逐类失败各测一条**
  ——current 说不清 / 定时器恢复失败 / 桩删不掉 / **3b 备份删不掉**（步骤 1–3/3b，门不撤、
  进 ledger `reopening_incomplete`）、撤门失败（门部分撤、同 incomplete）、`done` 写不下
  （不清 active）、终态已落仅释放失败（operation 完成、退 3、无可续跑 active）。
- L6 endpoint 收据聚合：`ledger_init(done)` 与 `ledger_cutover(done)` 的 journal 都是
  合法永久收据、不被盘点当 orphan、不染红；同 endpoint 重复/矛盾/某 journal 读不出
  → fail-closed。
- L7 账本数据目录不在桩清单/预检；接入账本未改变 §预检 / §桩清单两张表判据；doctor
  账本读不被门阻断。

## 不做的 / 明说的代价

- 不停 Aily daemon（服务本机全部 agent，重启要带代理环境）。
- 被挡的 Stop 回合**丢**（at-most-once）；窗口内的飞书消息回"维护中"，用户重发，系统不重放。
- 不改锁协议本身；这份门是为下一次改锁协议准备的。
