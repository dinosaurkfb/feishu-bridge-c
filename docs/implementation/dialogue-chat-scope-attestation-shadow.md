# Dialogue Chat Scope Attestation Shadow（Slice B2c）

状态：候选实现位于 `feat/dialogue-chat-scope-attestation-shadow`。默认无副作用、纯计算，不写任何
新的 Git 外持久化路径，不安装 hook，不改动 dispatcher/canonical event 热路径，未把 chat scope 提升
为可信 canonical 事实，也未切换权威路由。

## 1. 这个切片解决什么

B2a（`dialogue-chat-scope-probe.mjs`）为每一次真实回合记录一条脱敏的一致性观测；B2b
（`dialogue-shadow-readiness.mjs`）把所有已收集证据汇总成一份跨 binding 的只读体检报告，最高只能
返回 `manual_review_required`。但两者都没有回答一个更具体的问题：**对某一个特定 binding，我们手头
的真实观测是否已经多到、新到、稳定到足以把它的 chat scope 状态从"完全没有证据"升级为"候选已证明
一致"？**

`dialogue-chat-scope-attestation.mjs` 回答这个问题，但答案严格限定在 **shadow candidate** 范围：
`status: attested_candidate` 是一个新的、独立于 Canonical Event 的 shadow 概念，不等价于、也不会
触发 `extensions.aily_channel.verified = true`。dispatcher 仍然固定产生 `verified: false`；本模块不
读取、不修改、也不感知 dispatcher 或 hook。

## 2. 为什么不采用"hook 前置一次性本地证明"路线

在开始实现前，评估过一种更强的方案：让 UserPromptSubmit hook 在模型执行前写一次性私有 token，
dispatcher 原子消费后直接把真实 Canonical Event 的 `source.chat_id`/`verified` 置为可信。这类方案
理论上能更接近 `dialogue-chat-scope-probe.md` 第 5 节的门禁 4（"用本地受控 session→scope
attestation 进行独立交叉验证"），但它需要：

- 修改两端 hook、dispatcher 和 `canonical-event.mjs` 的热路径；
- 引入一套新的私有一次性凭据存储、TTL、原子消费和清理机制；
- 让"是否安装此候选"直接影响真实回合里 Canonical Event 的字段取值。

这与本轮任务边界冲突：本轮只允许 shadow 证据与候选计算，不得改变现有 legacy 结果，也不得安装
hook。因此本切片**明确不做**上述改动，只在既有 B2a 证据之上做进一步的纯聚合判定。这意味着本模块
只能加强 `dialogue-chat-scope-probe.md` 门禁 2（"同一 binding 跨多轮、轮转前后均与授权快照一致"）
的候选证据质量，**不能**替代门禁 4（独立证明 Aily 字段注入来源）。任何后续想要真正提升
`verified=true` 的实现，仍需要独立方案、独立评审和显式回滚路径。

## 3. 计算规则

`evaluateDialogueChatScopeAttestation({ snapshot, probes, now })` 是纯函数，输入是一个已校验的
`dialogue-binding-authorization-v1` 快照与一批候选 `dialogue-chat-scope-probe-v1` 证据。输出永远是
一个自描述的 attestation 记录，`status` 只能是 `unverified` 或 `attested_candidate`：

- 证据为空、或去重后独立事件数不足 `MIN_ATTESTATION_SAMPLES`（固定为 3，不对外开放调低）→
  `unverified` / `insufficient_evidence`；
- 任一 probe 本身 schema 校验失败，或同一 `probe_id` 出现两份内容不同的证据（观测冲突）→
  `unverified` / `evidence_invalid`。**一条坏证据会让整批判定失败，不会被过滤掉后用剩下的凑数**；
- 任一 probe 的 `binding_ref` 与传入快照不一致 → `unverified` / `binding_mismatch`；
- 任一 probe 的 `authorization_snapshot_id` 与传入快照不一致（例如快照因订阅/绑定变更被替换出新
  revision）→ `unverified` / `snapshot_mismatch`；
- 任一 probe 的 `observed_at` 晚于调用时刻 `now` → 视为损坏证据，`unverified` / `evidence_invalid`；
- 任一 probe 相对 `now` 超出**证据保留窗口** `evidence_max_age_ms` → `unverified` / `stale_evidence`；
- 任一 probe 的 `chat_locator_present !== true` → `unverified` / `locator_missing`；
- 任一 probe 的 `chat_scope_match !== true` → `unverified` / `scope_mismatch`；
- 全部通过 → `attested_candidate`，`reason: null`。

### 证据保留窗口是一条独立策略

`evidence_max_age_ms` 默认 `ATTESTATION_EVIDENCE_MAX_AGE_MS`（24 小时），可由调用方显式收紧或
放宽，但必须是正整数且不超过 `ATTESTATION_EVIDENCE_MAX_AGE_LIMIT_MS`（7 天）—— 允许调节，
不允许取消过期。判定用的窗口会原样写进制品的 `evidence_max_age_ms` 字段，否则两份状态相同、
按不同窗口算出来的 attestation 在 shadow comparison 里无法区分。

**它刻意不复用 `snapshot.freshness_ms`。**两者是不同策略，早期实现把它们接在一起是错误耦合：

| | `snapshot.freshness_ms` | `evidence_max_age_ms` |
|---|---|---|
| 判什么 | 单条入站消息的 `occurred_at` | 多条 probe 的 `observed_at` |
| 目的 | 消息处理新鲜度 / 防重放 | attestation 证据的可信保留期 |
| 默认 | 15 分钟（见 `init-chain-template.mjs`） | 24 小时 |
| 拒绝理由 | `stale_event` | `stale_evidence` |

attestation 的全部意义就是**跨多轮、跨话题轮转**积累至少 3 条互相独立的观测。挂在 15 分钟的
防重放窗口上，等于要求这 3 条挤在一刻钟内发生 —— 既攒不齐，攒齐了也会在下次评估时集体过期。
更糟的是它把两条策略焊死：有人为了收紧重放窗口去调小 `freshness_ms`，会在毫不知情的情况下
同时废掉 attestation。测试里有一条源码级断言钉住这件事：判定代码不得出现 `freshness_ms`。

### 时间输入一律规范化

`generated_at` 一律由已校验的 `nowMs` 经 `toISOString()` 产出，不透传调用方给的原值。
`now` 接受数值、`Date` 对象和可解析字符串；`Date` 走 `getTime()` 而非 `Date.parse()`
（后者经 `toString()` 会静默截掉毫秒）。超出 ECMAScript 时间值可表示范围（±8.64e15）的数值
判为 `input_invalid` 而**不是抛异常** —— 本模块承诺只有调用方错误才返回 `ok:false`，
从没承诺会抛。运行时 validator 对三个时间字段用往返相等判规范形式，比 JSON Schema 的
`format: date-time` 更严；方向是有意的：运行时永远不能接受 schema 会拒的东西。

`binding_ref` 已经把 runtime namespace、endpoint ID 和私有 binding key 一起编入派生哈希（见
`dialogue-participant-planner-contract.md` §3），因此两个不同 runtime 的证据在结构上不可能共享同一
`binding_ref`；本模块通过拒绝 `binding_ref` 不匹配的证据间接保证"跨 runtime 不一致 fail-closed"，
不需要、也没有单独携带一个 runtime 字段去重复这件事。

## 4. 输出 artifact 与脱敏边界

产出对象只包含：`schema_version`、`artifact_type`、`attestation_version`、`generated_at`、
`binding_ref`、`authorization_snapshot_id`、`status`、`reason`、`evidence_max_age_ms`、
`sample_count`、`first_observed_at`、
`last_observed_at`。不含原始 chat/thread locator、sender、session、事件正文，也不含单条 probe 的
`probe_id`/`event_ref`列表——只有计数和时间范围。`references/dialogue-chat-scope-attestation-v1.schema.json`
固化这个形状；`attested_candidate` 状态在 schema 层面强制 `reason=null` 且 `sample_count>=3`。

本模块**不写文件、不产生新的 sidecar 目录**。它是纯计算，调用方（未来可能是 B2b 审计器或人工排查
脚本）负责从既有 Git 外 shadow 目录里按 `binding_ref` 分组读取 probe 证据后调用它；本轮不实现该
调用方整合，避免把这个小切片继续放大。

## 5. 明确不代表什么

- `attested_candidate` 不是 `verified=true`，不会、也不能被任何现有代码路径读取来改变路由、claim、
  binding 或 policy；
- 它不满足 `dialogue-chat-scope-probe.md` 门禁 1（两端真实样本）、门禁 3（fail-closed 覆盖并发/
  错配/缺失场景的真实验收）、门禁 4（独立注入来源证明）或门禁 5（独立开关与回滚路径）中的任何一项
  ——那些仍然是安装后用真实样本才能满足的门禁，不是本模块的职责；
- 它不理解、也不携带 Topic Generation（`channel_generation_id`）。"跨 generation 不一致 fail-closed"
  在本模块中体现为"跨 `authorization_snapshot_id` 不一致 fail-closed"——这是当前脱敏 artifact 唯一
  可用的、和授权配置版本绑定的一致性维度，不等价于真实话题轮转前后的连续性验证；后者仍是
  `dialogue-shadow-readiness-audit.md` 里未核验的 `generation_rotation_coverage` 人工门禁；
- 一批 `attested_candidate` 结果不能单独授权安装、切流或开启 Agent Relay，仍需 Frank 的逐次授权。

## 6. 测试与回滚

`scripts/test.mjs` 新增覆盖：证据缺失/不足、单条损坏、同一 event 的冲突证据、跨 binding、跨
snapshot revision、过期、未来时间戳、locator 缺失、chat scope 不一致、以及在独立/新鲜/一致证据齐备
后正确产生 `attested_candidate`。

证据窗口与时间输入另有专门覆盖：跨越 `freshness_ms` 的多轮证据仍成立（解耦正向）、判定源码不得
出现 `freshness_ms`（解耦反向，源码级断言）、窗口边界闭区间、显式收紧生效且写入制品、非法窗口
（0/负数/小数/字符串/超上限）判为调用方错误；以及 `Date` 入参不丢毫秒、非规范可解析字符串被折算成
规范形式、越界时间值判错而不抛、validator 拒绝一切非规范 date-time。schema 一致性回归除枚举外
还比对**字段集**与证据窗口上限，防止运行时与 schema 再次各自漂移。回滚只需删除
`scripts/dialogue-chat-scope-attestation.mjs`、对应 schema 文件与测试用例；由于没有任何热路径或
持久化写入，回滚不需要清理任何运行时状态。
