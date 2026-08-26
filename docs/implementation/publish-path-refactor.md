# 发布路径重构：把散在五个入口的策略收进承重接口

状态：计划。触发条件已满足 —— A 批次（PR #61）连续五轮被打回，
**每一轮的失败形状相同**：一条策略散在多处，接了 N 个消费者漏了第 N+1 个。
评审（Codex）的结论：反复失败的主因是跨入口策略没有被代码结构收敛，
其次是测试验证方法，最后才是模型能力。本文档是对那份分析的落地方案。

## 0. 现状盘点（2026-08-26，main = 8d097f8）

同一条「发布尝试」策略目前有**六个消费者**，各自手工组合低层原语：

| 入口 | 跳过已暂停 | 失败记账 | 候选判据 | 锁内快照 |
|---|---|---|---|---|
| `drain-outbox.mjs`（Claude 排空 + Stop + 定时兜底） | ✓ | ✓ | listPending | ✗ |
| `watch-and-publish.mjs`（Claude watcher） | ✓ | ✓ | listPending | ✗ |
| `codex/drain-outbox.mjs`（Codex 手工排空） | **✗** | **✗** | listPending | ✗ |
| `codex/publish-eligible.mjs`（Codex 自动发布） | **✗** | **✗** | **非空字符串**（:94，即第 5 层要收敛的分叉） | ✗ |
| `codex/feishu-outbox.mjs`（只读全景） | ✓（展示） | — | listPending | — |
| `stop-hook.mjs`（经 drainProject） | 随 drain | 随 drain | — | — |

**加粗那四个 ✗ 是现在就存在于 main 上的缺口** —— A 批次五轮返修只接通了
Claude 侧，Codex 侧两个入口从没进过任何一轮的视野。这不是疏忽的偶然，
是结构的必然：每轮都靠人工找齐消费者，找齐六次、每次上下文都不同，漏是常态。

低层原语（`listPending` / `markSent` / `recordPublishFailure` /
`acquirePublishLock` / `publishDraft` / `outboundCardBatches`）对所有入口公开，
**太容易被绕过** —— 第 3 层抑制事务把写原语收私有的理由，在发布侧同样成立。

## 1. 三个承重接口

### R1 重试保护：磁盘格式不动，代码接口收严

四个平铺字段（`publish_attempts` / `publish_rejected_at` / `publish_rejected_reason`
/ `publish_rejected_kind`）**保留现有磁盘形状**。理由：

- 封闭校验器（`retryProtectionState`，三态充要 + corrupt）已经存在且经过评审；
- 嵌套对象的收益主要是"概念原子性"，那可以由**唯一读写模块**在代码层给出；
- 磁盘格式一旦改，安装时点就跟迁移耦合（见 §4 决定点）。

要做的收严：
- 读端唯一：所有消费者只许经 `retryProtectionState` / `pauseKindOf` /
  `isPermanentlyRejected` 读，**禁止直接摸字段**（守卫：除 outbox.mjs 外
  对字段名零引用 —— 用行为测试而非源码扫描验证，扫描会被注释骗）。
- 写端唯一：`recordPublishFailure` / `markSent`，已私有化 `clearPermanentRejection`。

### R2 唯一的发布尝试事务 `publishOutboxAttempt()`

新模块 `scripts/publish-attempt.mjs`。**锁内单快照**（复用第 3 层的
`readOutboxSnapshot`——抑制事务已经是"锁 → 快照 → 审计 → 动作"这个形状，
发布是它的镜像），统一负责：

1. 取发布锁（含重试节奏）
2. 锁内快照 + `outboxMutationBlocker` 审计闸门
3. 候选选择：三态 pending ∧ 未暂停 ∧ 入口给的 selector
   （Codex 自动入口的 selector 用 `hasPublishAuthorization` ——
   **第 5 层的判据收敛在这里结构性地发生**，不再是第七次手工接线）
4. 按目标代际分批、构卡、逐批发布
5. 成功：`markSent`（同一次写里清保护字段）
6. 失败：`trustedPublishResponse` → `publishRetryability` → `recordPublishFailure`
   （只对实际失败的那一批）
7. 返回结构化结果（published / dry_run / needs_attention / error + 成因），
   渲染由 `describeDrainOutcome` 一族消费

入口只提供四样：**怎么解析目标代际、怎么构卡、用哪个身份、要不要附带本轮
run 结果**。六个消费者逐个改接，低层原语随后收私有（`markSent`、
`recordPublishFailure` 移出公开导出面）。

### R3 错误信任边界对象化

`normalizePublishFailure(err) → { trusted, display }`。
`publishRetryability` 只接受这个对象（不再接受裸字符串）——
"判定只喂可信响应"从调用纪律变成类型边界。伪造攻击面（卡片正文经 argv
进命令回显）已在 A 批次修掉，这一步是把修法固化成结构。

## 2. 契约矩阵测试（R4）

现在两个测试文件共 20k 行，逐条测试各测各的入口。新增一张
**场景 × 入口**矩阵表，同一组场景对每个适用入口都跑真实进程：

场景（每条都是这条线上真实发生过的）：
第 1..4 次暂时失败只累计 / 第 5 次转暂停 / 明确平台拒绝（ErrCode 11310）/
卡片正文含错误码但无可信响应（伪造）/ 显式重试失败仍暂停 / 显式重试成功清字段 /
dry-run 零改盘 / 保护字段损坏整批拦 / 登记表部分损坏 / 已暂停的不进批次。

入口：Claude drain / Claude watcher / Codex drain / Codex publish-eligible /
Stop 包装 / 只读全景。

**新增入口不进矩阵就显眼** —— 这张表就是"找齐消费者"的机器化。
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
重构后剩余工作显著变小：
- 第 4 层（手工发布计划与目标 CAS）→ 在事务之上加"计划摘要绑目标代际 + 根消息"
  和 `--expect-*` 参数（形状照抄第 3 层抑制的 CAS）；`atRecheck` 测试补回。
- 第 5 层 → 只剩 run 完成凭据的验真（那个制品今天还不存在，先做二选一决定）
  和 `eligibility_pending` 恢复链已做部分之外的 watcher 接线复核。
`outbox-review-stack-split.md` 在 R2 合并时同步改。

## 5. PR 切法与顺序

每个 R 一个 PR，一个 PR 只承载一个状态机或一个纯展示改动；
每个都走 Codex 评审 + 五项证据门禁；每条修改变异验证转红。

| PR | 内容 | 体量预估 | 依赖 |
|---|---|---|---|
| R1 | 读写端收严 + 零直接摸字段守卫 | 小 | — |
| R2a | `publish-attempt.mjs` 事务本体 + Claude drain 接入 | **大** | R1 |
| R2b | watcher + Codex drain + Codex publish-eligible 接入，原语收私有 | 中 | R2a |
| R4 | 契约矩阵（随 R2a/b 分批并入，不单独压轴） | 中 | R2a |
| R3 | 错误对象边界 | 小 | R2a |
| R5 | 全景 completeness | 小 | — |

R4 刻意不放最后：矩阵跟着 R2a 一起建，R2b 的三个入口接一个进一个 ——
**矩阵先于接线存在，漏接就是红的**，而不是评审去发现。

## 6. 写进工艺要求的规则（评审分析给出，实践已验证需要）

1. 动手前列"状态写入者 / 读取者 / 自动入口 / 人工入口"清单，清单进 PR 描述。
2. 每条承诺先写能让旧实现失败的**系统级**反例，再实现。
3. 测试不许复制产品判据（本 session 三次假绿皆源于此）。
4. 连续两轮出现同类漏接：停止打补丁，先收敛承重接口。
