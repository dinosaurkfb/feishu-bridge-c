# Topic Generation 生命周期实现

状态：候选实现，分支 `feat/topic-generation-lifecycle`。本切片实现需求 FR-8 与架构契约 8.2、8.3、
INV-9；不开放多订阅、多人授权或新的 Dialogue/Management policy。

## 1. 目标与边界

“换一个新话题继续”不是删除旧话题，也不是创建另一条无关 binding。稳定对象仍是原
`binding_id`，飞书话题只是它的单调递增代际：

```text
binding
  ├─ generation 1  active -> read-only
  └─ generation 2  pending -> active
```

任一时刻最多一个 active、最多一个 pending。pending 等待首次真实 mention 时，旧 active 继续
接收入站；切换后旧代际不再接收新指令，但仍可接收轮转前已经冻结到它的迟到结果。

完整 locator、session、短码和运行状态只写入现有 Git 外 registry/mapping，不进入仓库文档。

## 2. 状态文档

[`references/topic-generation-v1.schema.json`](../../references/topic-generation-v1.schema.json) 固化结构，
`scripts/topic-generation.mjs` 定义 runtime-neutral 的 `topic_generation_state` 与跨字段不变量：

| 字段 | 含义 |
|---|---|
| `binding_id` | 跨代际稳定的逻辑 binding |
| `binding_status` | `active`、`paused` 或 `retired` |
| `active_generation_id` | 当前唯一 active 代际；首次认领前可为空 |
| `generations[]` | 单调序号、状态、topic/session locator 与生命周期时间 |
| `rotation` | 唯一轮转 operation、阶段与 pending generation 引用 |

代际状态为 `pending -> active -> read-only -> retired`；轮转 operation 为
`preparing -> awaiting_claim -> completed`，失败、取消和过期分别落到 `failed`、`cancelled`、
`expired`。校验器拒绝重复编号、重复 id、多个 active、多个 pending 以及 active 指针不一致。

## 3. 两阶段轮转事务

`$feishu-rotate`（Claude 为 `/feishu-rotate`）执行以下流程：

1. 在生命周期锁内确认 binding active、存在唯一 active 且没有 pending，写入唯一 operation id；
2. 释放锁后调用飞书创建新根话题；创建失败时重新加锁把 operation 标为 failed，旧代际不变；
3. 创建成功后重新加锁，把新根 locator、短码和 24 小时 `claim_expires_at` 登记为 pending；
4. 等待新话题中的真实 mention，等待期间不持锁，旧代际继续 active；
5. 认领时重新加锁并校验 generation、operation、期限和 session 唯一性；
6. 在同一 binding 文档的一次临时文件 + `rename` 替换中，将新代际设 active、旧代际设 read-only；
7. 超时后的下一次认领尝试或显式 `--cancel --apply` 会原子退休 pending，旧 active 不变。

话题创建成功但本地 phase 2 写入失败时，不猜测或自动重建：旧代际继续 active，外部新话题作为
可对账的孤立证据保留，由人工检查后重试或关闭。

## 4. 兼容迁移

旧 binding 在读取时投影为 generation 1。已经完成首次绑定的记录沿用 Mapping Policy 旧版生成的
opaque generation id，保证升级前 run 冻结的 `origin_channel_generation_id` 仍能解析；新代际才使用
正式的 `binding_id + generation` 稳定 id。

持久化轮转状态时，同时物化旧读取方依赖的 `root_message_id/session_id/inbound_state`：

- pending 阶段旧字段仍指向旧 active；
- 认领完成后旧字段一次切换到新 active；
- project-file 继续使用既有 `feishu_root_message_id_reference`；
- registry 原文中的未知顶层字段原样保留，不用规范化对象覆盖整份文档；
- 早期 Claude“出站已接通、入站尚无 Aily session”的 active 记录继续可读，不能因迁移关掉出站；
- 旧 `suspended` 读取为正式 `paused`。

因此升级不要求一次性迁移所有历史 binding，也不会在安装时创建或修改任何飞书话题。

## 5. 出站目标冻结

每个 outbox 事件新增不可变的 `target_channel_generation_id`：

- 飞书来源 run 在 claim 后冻结受理它的 origin generation；
- 本地来源 run 在形成 outbox 时冻结当时的 active generation；
- publisher 按冻结代际分组，active 与 read-only 均可解析，retired fail-closed；
- 轮转不改写已经存在的 outbox 目标；旧格式无该字段时才为兼容回落到当前代际。

这保证轮转前受理的请求仍回旧话题，轮转完成后形成的新本地结果进入新话题。

旧 outbox 没有 `target_channel_generation_id`，publisher 会用内部组键 `__legacy_active__` 把它们
归为一组，并在**发布时**解析当前 active。由于历史记录没有足够证据反推出形成时的话题，这个
兼容回落无法承诺原代际：如果升级时仍有旧 pending outbox，随后又先完成一次轮转，这些旧条目
会进入新 active，而不是升级前的话题。安装不会自动补发历史积压；首次轮转前应先用 status 检查
待发数量，并按既有逐次授权流程处理或保留。新版本形成的每条 outbox 都带冻结字段，不再有此歧义。

## 6. Runtime adapter 与命令

| 能力 | Claude | Codex |
|---|---|---|
| Git 外状态适配 | `topic-generation-store.mjs` | `codex/state.mjs` |
| 创建/取消轮转 | `feishu-rotate.mjs` | `codex/feishu-rotate.mjs` |
| 用户命令 | `/feishu-rotate` | `$feishu-rotate` |
| 首次认领切换 | `inbound-route.mjs` | `codex/state.mjs` |
| 状态展示 | `/feishu-status` | `$feishu-status` |

`status` 只展示代际序号、pending 截止时间和只读历史数量，不打印 generation id、话题 locator、
session locator、凭据、claim 或 receipt。

## 7. 验证与回滚

候选必须通过：

- 公共状态机、24 小时过期、取消和旧映射投影测试；
- Claude registry/project-file 原子持久化与未知字段保留测试；
- Codex 精确 task 轮转、取消 CLI 与状态输出测试；
- 新旧 outbox 目标分别发布到正确根话题的合成测试；
- 全量 `npm test`、共享导出面 `npm run contract` 与 `git diff --check`。

安装与真实话题轮转是独立授权动作。本分支合并本身不改 `~/.claude`、`~/.codex` 或飞书状态。
回滚代码时保留 Git 外 registry 和话题历史；旧读取方继续使用已物化的唯一 active 字段。若已经完成
轮转，不应通过改代码把 read-only 旧话题重新冒充 active，应使用后续受控迁移完成反向轮转。
