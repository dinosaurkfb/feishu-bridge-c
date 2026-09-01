# 维护门（issue #81）—— 方案稿 v5

> 状态：方案，未实现。v1 → Codex 5 P1 → v2 → 4 P1 → v3 → 3 P1 + 2 P2 → v4 → 4 P1 + 2 P2 → v5（2026-08-30）。评审：Codex（架构）；拍板：Frank（切桩、丢回合、不 claim 已同意）。
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

**执行租约**：同一 operation 的 enter / exit / 续跑只许一个执行者 —— `maintenance/<token>.lease`（registry 锁协议，**只按持有者 pid 活性接管，不按时间**，等进程可以很久），journal 每次写入都在租约 reap 段内核对 token（被接管后晚到的写入 lease_lost，不落盘）；写入还核 active 仍指向本 token、阶段前驱合法、**传入的租约路径属于本 operation**（`lease_mismatch` —— 拿别的 operation 的租约写不进）。maintenance-install 从进门到 reopening / 回退结束**连续持有同一租约**（释放再重取会留出 operation 被换掉的窗口）。

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
   - 两条 `current`：各自 prepared（桩 → `versions/<v>`）→ `activateRuntimeVersion`（先验目录再切；**expectBefore 的 CAS 在安装锁内**，与 rename 同一把锁，检查与切换之间没有窗口）→ done；任一条失败 → 整次中止，由回退按恢复规则切回桩。门还开着，新 runtime 的每个写入口都看门，切过去不等于放行；**三个普通安装器的 `--apply` 也看门**（方案稿"所有控制 CLI 的 `--apply` 分支"看门点），维护窗口内没有别的安装写方；
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

## 不做的 / 明说的代价

- 不停 Aily daemon（服务本机全部 agent，重启要带代理环境）。
- 被挡的 Stop 回合**丢**（at-most-once）；窗口内的飞书消息回"维护中"，用户重发，系统不重放。
- 不改锁协议本身；这份门是为下一次改锁协议准备的。
