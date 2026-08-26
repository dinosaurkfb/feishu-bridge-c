# 发布路径重构：把散在四份实现里的策略收进承重接口

状态：计划，经 Codex 架构评审一轮修订（2026-08-26）。
触发条件已满足 —— A 批次（PR #61）连续五轮被打回，**每一轮的失败形状相同**：
一条策略散在多处，接了 N 个消费者漏了第 N+1 个。评审（Codex）的结论：
反复失败的主因是跨入口策略没有被代码结构收敛，其次是测试验证方法，
最后才是模型能力。本文档是对那份分析的落地方案。

## 0. 现状盘点（2026-08-26，main = 8d097f8，评审已独立核对）

**真正重复实现发布策略的是四处**，各自手工组合低层原语：

| 策略实现 | 跳过已暂停 | 失败记账 | 候选判据 | 锁内快照 |
|---|---|---|---|---|
| `drainProject`（drain-outbox.mjs） | ✓ | ✓ | listPending | ✗ |
| `watch-and-publish.mjs`（Claude watcher） | ✓ | ✓ | listPending | ✗ |
| `codex/drain-outbox.mjs`（Codex 手工排空） | **✗** | **✗** | listPending | ✗ |
| `codex/publish-eligible.mjs`（Codex 自动发布） | **✗** | **✗** | **非空字符串**（:93，即第 5 层要收敛的分叉） | ✗ |

**加粗那四个 ✗ 是现在就存在于 main 上的缺口** —— A 批次五轮返修只接通了
Claude 侧那两份实现，Codex 侧两份从没进过任何一轮的视野。这不是疏忽的偶然，
是结构的必然：每轮都靠人工找齐消费者，每次上下文都不同，漏是常态。

围绕这四份实现，另有三类东西**不许混进"策略实现"里数**：

- **触发包装**（复用上面某份实现，不另写策略）：
  Claude 侧 CLI / Stop / launchd 定时 → `drainProject`；
  Codex 侧 Stop / watch-run / drain-all → `publishEligibleTaskEvents`。
- **只读观察者**：`codex/feishu-outbox.mjs` 全景。它消费同样的判据
  （`isPermanentlyRejected` / `pauseKindOf`），但**不改接发布事务** ——
  它的义务是"展示与执行给出同一结论"，不是执行。
- **明确排除项**（直接发布、不消费 outbox，不在本重构范围）：
  `outbound.mjs --publish`（:270 起）、bind、rotate 的直发路径。
  它们各有自己的授权面；把它们卷进来会让"唯一事务"这个词失真。

低层原语（`listPending` / `markSent` / `recordPublishFailure` /
`acquirePublishLock` / `publishDraft` / `outboundCardBatches`）对所有调用方公开，
**太容易被绕过** —— 第 3 层抑制事务把写原语收私有的理由，在发布侧同样成立。

## 1. 三个承重接口

### R1 重试保护：磁盘格式不动，代码接口对象化

四个平铺字段（`publish_attempts` / `publish_rejected_at` / `publish_rejected_reason`
/ `publish_rejected_kind`）**保留现有磁盘形状**（评审认可：迁移收益不足以
承担安装时点耦合）。代码层给出**封闭联合投影**，这是唯一的读法：

```
retryProtection(rec) →
    { status: "clean" }
  | { status: "retrying", attempts }
  | { status: "paused",   attempts, at, reason, kind }
  | { status: "corrupt",  reason }
```

现有三个状态函数不够 —— 展示层今天还在直接拼 `publish_rejected_reason` 裸字段。
投影补全后，**任何消费者（含展示层）不再摸字段**。

守卫要两道，各证一半（评审指出行为测试证不了模块边界）：
- **系统级行为矩阵**证语义（见 R4）；
- **原始 token 禁用**证边界：除 outbox.mjs 外对四个字段名零出现。
  原始扫描、不解析注释 —— 跟 `process.argv[1]` 那条守卫同一形状，
  不会重演 file:// 剥注释那次假阴性。

写端唯一不变：`recordPublishFailure` / `markSent`。

### R2 唯一的 outbox 发布事务 `publishOutboxAttempt()`

新模块 `scripts/publish-attempt.mjs`。**锁内单快照**（复用第 3 层的
`readOutboxSnapshot`——抑制事务已经是"锁 → 快照 → 审计 → 动作"这个形状，
发布是它的镜像），统一负责：

1. 取发布锁（含重试节奏）
2. 锁内快照 + `outboxMutationBlocker` 审计闸门
3. 候选选择：**受控策略枚举，不接受任意 selector 回调** ——
   回调就是又一个能重写判据的口子（评审点名）：
   - `all_unpaused`（Claude drain / watcher / Codex drain）
   - `authorized_only`（Codex 自动发布：三态 pending ∧ 未暂停 ∧
     `hasPublishAuthorization` —— **第 5 层的判据收敛在这里结构性地发生**）
   - `explicit_retry_paused`（`--retry-rejected`：连已暂停的一起放行）
4. 按目标代际分批、构卡、逐批发布
5. 成功：`markSent`（同一次写里清保护字段）
6. 失败：可信响应 → `publishRetryability` → `recordPublishFailure`
   （只对实际失败的那一批）
7. 返回结构化结果（published / dry_run / needs_attention / error + 成因），
   渲染由 `describeDrainOutcome` 一族消费

入口只提供：**怎么解析目标代际、怎么构卡、用哪个身份、候选策略取哪个枚举值**。
四份策略实现逐个改接，低层原语随后收私有（`markSent`、`recordPublishFailure`
移出公开导出面）。

**watcher 的 run 结果是事务外的第二条通道，明说，不装进"唯一"里。**
第 6 层评审定过的契约是：run 结果不是 outbox 记录，有独立来源和回执，
outbox 损坏时仍须独立发出（整批 fail-closed 的例外）。所以边界是：
- `publishOutboxAttempt` 只管 outbox；
- run 结果由 watcher 走自己的发布 + `markPublished` 回执，顺序在 outbox 批次之前，
  outbox 批次失败不影响它（维持既有已评审语义）；
- 两条通道**尽力共锁**，互不进对方的审计闸门。
- **R2b1 已定稿并测试的等待 / 失败 / 延期语义**（验收点收口）：
  - 预算内（默认 15s，`FEISHU_BRIDGE_PUBLISH_WAIT_MS` 可调，解析与资格恢复
    共用 `boundedBudgetMs`）等同一把发布锁；拿到后 run 先发、释放后 outbox 走事务。
  - 预算耗尽：**run 单发** —— 并发互斥由**发布前原子 claim**（按 run key，
    mkdir 原子性 + stale 接管）提供，回执在发送后落（评审实测：只有回执时
    两个并发 watcher 会真实双发）。**崩溃窗口仍是 at-least-once**，
    与全线口径一致 —— 不存在"零双发"，只有"并发不双发"。
    扣着执行结果不发的代价大得多；
  - 锁的 `io_error` **不是竞争**：不进预算等待、不套"让给持锁方"的措辞，
    单独如实报告；run 通道的安全来自 claim，claim 自身 io 故障则 fail-closed；
    **outbox 永不无锁** —— 双发风险全在那半，本轮让给持锁方（延期是"让"不是"丢"，
    下一轮或兜底定时器照常补发）。
  - 真实进程回归钉住三件：锁被占时 run 独走、outbox 含 marker 的调用为 0、
    锁放开后下一轮补发。

**已知剩余风险（本轮不解决，如实写下）**：飞书网络写与本地 `markSent`
不可能构成真正的原子事务 —— "消息已发出、进程在落标前崩溃"仍可能重发。
"事务"一词指本地状态变更的一致性，**不承诺 exactly-once**。

### R3 错误信任边界对象化

`normalizePublishFailure(err) → { trusted, display }`。
`publishRetryability` 只接受这个对象（不再接受裸字符串）——
"判定只喂可信响应"从调用纪律变成类型边界。伪造攻击面（卡片正文经 argv
进命令回显）已在 A 批次修掉，这一步是把修法固化成结构。

## 2. 契约矩阵测试（R4）

现在两个测试文件共 20k 行，逐条测试各测各的入口。新增一张
**场景 × 入口**矩阵表，同一组场景对每个适用入口都跑真实进程：

场景（R2a 已落地九个，每条都是这条线上真实发生过的）：
基本发布 / 已暂停不进批次 / 暂时失败逐次累计、第 5 次转暂停 /
明确平台拒绝（ErrCode 11310）/ 卡片正文含错误码但无可信响应（伪造）/
显式重试失败仍暂停 / 显式重试成功清字段 / dry-run 零改盘 /
保护字段损坏整批拦。

矩阵行只对**四份策略实现**运行（§0 的分类）。原计划把 Stop 包装与只读全景
也列作矩阵入口、把"登记表部分损坏"列作矩阵场景 —— **修订（R2a 评审后）**：
包装与观察者不实现发布策略，硬塞进矩阵会让"入口"一词失真；
它们各有专属行为套件（Stop 经 drainProject 的渲染链、全景的 fail-closed 一族，
含登记表损坏），矩阵登记表的 direct_paths_excluded 同理管住直发路径。

**适用性是登记表里的受控申报（not_applicable，带理由），不是 runner 自报** ——
runner 自报能把所有场景报成不适用而 0 行照样绿。登记表 schema（status / suite /
not_applicable 场景名）由 validatePublishRegistry 全表校验，
两个套件各自都会执行：拼错任何一个字段都是必红行，不存在静默跳过。

矩阵**先登记全部四份实现及其状态（legacy / migrated）**：
legacy 行只跑该实现今天真实满足的契约子集，R2b 每接一个就把对应行翻成
migrated 并启用完整契约 —— 这样"矩阵先于接线存在"和"主线必须全绿"同时成立，
未迁移的入口不会以红测试的形式挡住合并。
**新增实现不进矩阵就显眼** —— 这张表就是"找齐消费者"的机器化。
既有的同类测试并入矩阵，不另写第二份。

## 3. 全景完整性正式化（R5）

`collectBacklog` / `collectProjectBacklog` 统一返回
`{ complete, tasks/projects, problems }`；渲染层已有"至少 N 条（不完整）"，
把判定从渲染层上移到收集层，两个消费者共用。小改动。

## 4. 两个需要 Frank 拍板的决定点

**① 安装时点。**真机跑的 `f20aea68` 没有第 3 层、也没有 A 批次 ——
cc2cd 那类故障在真机上**仍会无限重试**。两个选项：
- 现在装 main（8d097f8）：立刻拿到 A 的修复 + 第 3 层；Codex 侧两个入口的
  缺口要等 R2。**推荐** —— 缺口在装之前也一样存在，装了只会更好。
- 等 R2 完成再装：一步到位，但事故修复窗口拉长数天。

磁盘格式已决定不动（R1），所以安装时点**不再**跟迁移耦合，两个选项都干净。

**② 第 4、5 层计划的重排。**R2 吸收了两层里"锁内字节快照"和"判据收敛"的部分。
重构后剩余工作（按评审要求写精确）：
- 第 4 层（手工发布计划与目标 CAS）→ 在事务之上加计划摘要与 `--expect-*` 参数。
  **授权对象是"预览所见文件字节集合 + 解析后目标（代际 + 根消息）"的联合摘要**，
  不只绑目标 —— 人授权的是"把这些字节发到那个话题"（形状照抄第 3 层抑制的 CAS）。
  `atRecheck` 测试补回。
- 第 5 层 → **"终局证据 → 发布授权"的完整链**：证据形状、task/thread/run/event
  绑定、唯一命中、授权落盘、重试期间的生命周期（那个凭据制品今天还不存在，
  先做二选一决定）。**R2 只负责串行化发布尝试、选择、记账，
  不替第 5 层决定谁有权获得自动发布资格** —— `authorized_only` 只消费
  `hasPublishAuthorization` 的结论，不生产它。
`outbox-review-stack-split.md` 在 R2 合并时同步改。

## 5. PR 切法与顺序

每个 R 一个 PR，一个 PR 只承载一个状态机或一个纯展示改动；
每个都走 Codex 评审 + 五项证据门禁；每条修改变异验证转红。

| PR | 内容 | 体量预估 | 依赖 |
|---|---|---|---|
| R1 | 投影对象化 + token 禁用守卫 | 小 | — |
| R3 | 可信错误对象定型（避免 R2a 先接旧字符串接口再返工） | 小 | — |
| R2a | `publish-attempt.mjs` 事务本体 + Claude drain 接入 + 矩阵登记 | **大** | R1, R3 |
| R2b1 | Claude watcher 接入（单独处理 run 结果第二通道） | 中 | R2a |
| R2b2 | Codex drain + Codex publish-eligible 接入，原语收私有 | 中 | R2b1 |
| R5 | 全景 completeness | 小 | — |

R4 刻意不放最后：矩阵跟着 R2a 一起建，R2b 的三个入口接一个进一个 ——
**矩阵先于接线存在，漏接就是红的**，而不是评审去发现。

## 6. 写进工艺要求的规则（评审分析给出，实践已验证需要）

1. 动手前列"状态写入者 / 读取者 / 自动入口 / 人工入口"清单，清单进 PR 描述。
2. 每条承诺先写能让旧实现失败的**系统级**反例，再实现。
3. 测试不许复制产品判据（本 session 三次假绿皆源于此）。
4. 连续两轮出现同类漏接：停止打补丁，先收敛承重接口。
