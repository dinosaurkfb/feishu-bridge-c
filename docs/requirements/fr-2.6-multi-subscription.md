# FR-2.6 需求提案：多订阅（多群 / 群参数）

- `status`: `proposed`（调研与提案已定稿；§5 列出的拍板项**未拍板**，拍板前不开工写入口）
- `date`: 2026-09-01（调研：pi-deepseek 原型稿；抽查锚点与定稿：主会话）
- `scope`: 仅本文档。**只读代码，不改 `scripts/`，不跑任何 `--apply`，不碰 `.runtime-data/`。**
- 需求源：
  - `docs/requirements/agent-enhancement-requirements.md` §2（FR-2 项目/业务域事件订阅）、§6（四层基数）、§9 状态表 FR-2 行、§12（待决策）
  - 本仓 `register-sender` / `feishu-subscribe` / `subscription(-sync)(-apply)` / `binding*` / `inbound-route` / `subscription` / `dialogue-binding-authorization` 相关代码
  - `docs/architecture/layers-modes-permissions.md`（四层现状，§6 决策表第 6 行）
- 红线遵守：本稿只描述现状与提案，不含任何已落盘的配置改动。

---

## 0. FR-2.6 是什么

需求文档里 FR-2.6 没有独立小节，它的定义出现在 §9 状态表 FR-2 行的「目标」列：

> **开放受控多订阅管理，不改变现有单订阅默认行为**
> （`docs/requirements/agent-enhancement-requirements.md:307`）

以及 §6 的基数要求：

- 一个 endpoint 可以服务多个 subscription；
- 一个项目可以拥有多条本地 target 和多个 subscription；
- **一个群可以包含多个 Agent 和多个话题**；
- 一个本地 target 若要向多个群广播，必须通过明确的出站策略表达，不能制造入站歧义；
- 标题、项目目录和最近活跃时间只能用于展示或候选提示，不能作为最终路由主键。
  （`docs/requirements/agent-enhancement-requirements.md:96-103`）

**FR-2.6 要解决的是第 2 层（事件订阅）的基数问题**：今天「订阅」是从登记表投影出来的
只读模型，群维度写死在机器级模板里（一个 `chat_id`）。FR-2.6 的目标是开放订阅的**写入口**，
让订阅可以覆盖多个群 / 多组群参数，同时保持「只有一条订阅」时的行为与今天逐字节一致。

现状一句话：**订阅的增删写入口未开**。FR-2.5 的同步计划器与落盘控制面（resnapshot /
suspend / migrate）已经完成，卡点是「多于一条订阅时首次认领必须能拒绝歧义，该路径未经真实
样本验证」（`scripts/feishu-subscribe.mjs:22-24`、`docs/architecture/layers-modes-permissions.md:109`）。

---

## 1. 现状调研

### 1.1 「订阅」在今天的实物形态

第 2 层「事件订阅」**没有独立的控制面文件**。现状是一条链只有一份订阅投影，从两类来源算出来：

1. **机器级链路模板** `~/.claude/feishu-bridge/chain-config.json`（Claude 链；Codex 链对等）：
   运输身份、发布身份、授权发送者、**群（`chat_name` / `chat_id`）**、时效窗口，全是**链路级
   必填字段**（`scripts/chain-template.mjs:43-52` 的 `CHAIN_FIELDS` 含 `chat_name, chat_id`）。
2. **登记表** `~/.claude/feishu-bridge/registry.json`：`projects[]`，每个项目一行（含会话级绑定行），
   一行记 `root` / `root_message_id` / `session_id` / `expires_at` 等（`scripts/registry.mjs:133-138`）。

订阅投影 `buildLegacySubscriptionReadModel` 把「模板 + 登记表」合成 Subscription v1 制品
（`scripts/subscription.mjs:99-190`）：

- **每 (endpoint, domain, chat, agent) 一条订阅**，id 由这四个维度派生：
  `stableControlId("subscription", endpointId, domainId, chatId, template.agent_uid)`
  （`scripts/subscription.mjs:137-140`）。今天每条项目登记行恰好生成一条订阅。
- 订阅的 `scope` 字段（`references/subscription-v1.schema.json:52-108`）：
  `agent_uid`、`transport_open_id`、**`chat_id`（单值字符串，必填）**、`sender_ids`、
  `event_types`（目前只有 `im.message.receive`）、可选 `sender_roles`（角色表，2026-08-29 第 1 层）。

绑定授权快照（FR-2.5 的同步对象）也以单 `chat_id` 为输入：`chat_scope_ref` 由
`deriveDialogueChatScopeRef({ endpointId, privateChatId: subscription.scope.chat_id })` 派生
（`scripts/dialogue-binding-authorization.mjs:263`、`scripts/subscription-sync.mjs:113`），
快照 schema 的 `chat_scope_ref` 是不可逆引用（`references/dialogue-binding-authorization-v1.schema.json:47`）。

### 1.2 单群假设的代码点（file:line）

「一条链路只有一个群」这个假设写死在这些地方：

| # | 位置 | 假设 | 后果 |
|---|---|---|---|
| 1 | `scripts/chain-template.mjs:49,81` | `chat_name` / `chat_id` 是链路级**必填**，形状 `oc_` | 全链只有一个群，新群没有落脚处 |
| 2 | `references/subscription-v1.schema.json:52-72` | `scope.chat_id` 是**单值字符串**，`required` 含 `chat_id` | 订阅无法表达「覆盖多个群」 |
| 3 | `scripts/subscription.mjs:63` | `validateSubscription` 要求 `scope.chat_id` 非空 | 同上，语义判据在代码层再守一遍 |
| 4 | `scripts/subscription.mjs:137-140` | 订阅身份 = (endpoint, domain, **chat**, agent) | 同域多群只能靠「多条订阅」表达，而订阅又是投影产物 |
| 5 | `scripts/subscription.mjs:258-262` | 首次认领候选按 `scope.chat_id === evidence.chat_id` 过滤；`evidence.chat_id` 缺失时只记 `scope_unverified: ["chat_id"]` 继续算 | chat 维度在 shadow 里**从未被真正核验** |
| 6 | `scripts/inbound-route.mjs:275` | 投影时 `chat_id = entry.chat_id ?? config.chat_id ?? template.chat_id` | 新项目自动继承模板那一个群 |
| 7 | `scripts/inbound-route.mjs:298` | `shadowClaudeFirstClaim` 硬编码 `chat_id: null`（envelope 未验证稳定 chat locator） | 与 #5 同源 |
| 8 | `scripts/canonical-event.mjs:84,110-114` | `source.chat_id: null`；`extensions.aily_channel.verified: false` | chat locator 只进 shadow，selector 不能把它当作授权或路由事实 |
| 9 | `scripts/bind-project.mjs:308,324` | 建根话题 `sendToChat({ chatId: template.chat_id, ... })` | 项目接入只能进模板那一个群 |
| 10 | `scripts/bind-session.mjs:155,170` | 会话级绑定同样 `chatId: template.chat_id` | 同上 |
| 11 | `scripts/feishu-rotate.mjs:111` | 轮转建新话题 `chatId: current.config.chat_id` | 同上 |
| 12 | `scripts/bind-preview.mjs:59` | 预览只显示模板群 | 同上（展示层） |
| 13 | `scripts/feishu-subscribe.mjs:78-79`、`scripts/layered-status.mjs:188-189` | 群名**只能**套给 `scope.chat_id === templateChatId` 的那条订阅，其余显示「群名不可用」 | 多订阅指向不同群时，模板群名不会错报（fail-closed），但也没有真群名可显示 |
| 14 | `scripts/dialogue-binding-authorization.mjs:263,429-431` | chat scope ref 从单 `chat_id` 派生；入站侧拿 canonical `source.chat_id` 对账 | 快照的群维度是单值；多群需要重新派生 ref |

### 1.3 已经支持「多」的部分（FR-2.6 的既有地基）

- **多项目路由**：已绑定话题按 `session_id → binding` 选项目，支持项目级 + 会话级绑定并存
  （`scripts/inbound-route.mjs:84-120`、`scripts/project-resolve.mjs:139-142`、`scripts/bind-session.mjs`）。
- **多份待绑定的精确匹配**：引用块绑定码精确选中，多份并存时拒绝歧义
  （`scripts/inbound-route.mjs:161-206`、`scripts/selector.mjs:121-131`）。
- **首次认领的歧义拒绝判据已存在**：`selectPendingSubscriptionClaim` 在 pending binding > 1 且无
  绑定码时返回 `SUBSCRIPTION_REJECT.AMBIGUOUS`（`scripts/subscription.mjs:278-279`）；token 相关
  歧义另有 `TOKEN_AMBIGUOUS` / `TOKEN_DUPLICATED`（`scripts/subscription.mjs:270,273`）。
- **「同一个群里多条订阅」的归属语义已确立**：FR-2.5 计划器按授权快照记着的 `subscription_id`
  判定归属，不按范围覆盖（`docs/requirements/agent-enhancement-requirements.md:307`）。
- **订阅变更 → binding 处置的落盘已就绪**：resnapshot / suspend / migrate 三种动作
  （`scripts/subscription-sync-apply.mjs`），迁移必须由人显式指定目标订阅并逐项校验授权覆盖
  （`scripts/subscription-sync.mjs:213-330`）。
- **出站目标按来源代际冻结**：发布目标是 binding 的 root message（`feishu_root_message_id_reference`），
  按 claim 里冻结的 `origin_channel_generation_id` 解析当前可用的根话题
  （`scripts/watch-and-publish.mjs:222-235,367-371,415`）；本地发起回合在形成 outbox 项时冻结目标代际
  （`scripts/outbox.mjs:107-108`）。**出站选择与订阅无关**，走「binding → 话题」这条规则。

### 1.4 卡点（为什么写入口至今不开）

1. **chat locator 未验证**：canonical event 的 `source.chat_id` 恒为 null、`aily_channel.verified`
   恒为 false（`scripts/canonical-event.mjs:84,112-114`），首次认领 shadow 显式记
   `scope_unverified: ["chat_id"]`（`scripts/subscription.mjs:258-262`）。在可信 chat 证据补齐之前，
   多群路由无法切流 —— 这也是 FR-2.6 被多次挂在「真实样本」上的直接原因。
2. **多订阅歧义拒绝未经真实样本验证**：`AMBIGUOUS` 判据在代码里（`scripts/subscription.mjs:278-279`），
   但从未在多于一条订阅的真实事件上被行使过（`scripts/feishu-subscribe.mjs:22-24`、
   `docs/architecture/layers-modes-permissions.md:109`）。
3. **没有独立订阅存储**：订阅是投影产物，控制面没有「创建/删除订阅」的落盘对象，增删无从谈起
   （`docs/implementation/subscription-claim-slice.md:18` 明确「Subscription 控制面写 API」不在切片内）。

---

## 2. 目标行为

### 2.1 多订阅注册（控制面写入口）

- **开放独立订阅的增删改**：订阅成为一等控制面对象，有独立的落盘位置与受控写入口
  （命令形态未定，见 §4 开放问题）。写入需 owner 逐次授权，沿用 `register-sender` 的既有纪律：
  锁内重读重算 → 校验 → 备份 → 原子写 → 逐字读回（`scripts/register-sender.mjs:66-88` 的模板事务模式，
  可复用 `withChainTemplateWrite`，`scripts/chain-template.mjs:274-322`）。
- **每条订阅声明自己的群参数**：允许的群、发送者、事件类型、新鲜度，按订阅而不是按模板。
  模板仍提供默认值；「只有一条订阅、没配过」时行为与今天逐字节一致。
- **不改变现有单订阅默认行为**：不装订阅管理命令、不建任何订阅文件的机器，投影、认领、路由、
  出站全部照旧（`buildLegacySubscriptionReadModel` 路径不动，`scripts/subscription.mjs:99-190`）。
- 订阅变更仍然通过 FR-2.5 的同步器落到依赖它的 binding 授权快照，不靠热路径重新解释配置
  （`scripts/subscription-sync.mjs:1-18`）。

### 2.2 入站路由

- **已绑定话题**：不变。日常路由仍走 `session_id → binding → local target`，不为每条消息重复匹配
  订阅（需求 FR-2.4，`docs/requirements/agent-enhancement-requirements.md:125-128`）。
- **未绑定话题（首次认领）**：在多订阅下必须 fail-closed —— 命中唯一订阅才受理；命中多条或无法
  唯一确定时拒绝并回执歧义原因，**绝不询问模型选择**（需求 FR-2.6 原文，
  `docs/requirements/agent-enhancement-requirements.md:130-131`）：
  - 候选收敛到唯一 pending binding → 受理（绑定码精确匹配优先，`scripts/subscription.mjs:270-279`）；
  - 多个 pending binding 且无绑定码 → `AMBIGUOUS`；
  - 多个绑定码 / 码重复 → `TOKEN_AMBIGUOUS` / `TOKEN_DUPLICATED`；
  - chat 维度：`evidence.chat_id` 可信且命中 → 受理；不可信 → 保持 `scope_unverified`，只进 shadow，
    不切流（`scripts/subscription.mjs:258-262`）。
- **群维度核验是切流前置**：`source.chat_id` 可信（canonical event `verified: true`）之后，
  `scope_unverified` 才可能为空，多群路由才允许从 shadow 转为权威（需求
  `docs/implementation/subscription-claim-slice.md:41`：在该证据补齐前禁止切流）。

### 2.3 出站目标选择

- **单一出站目标**：不变。结果发回「来源话题」，按 claim 冻结的来源代际解析 root message
  （`scripts/watch-and-publish.mjs:367-371`）。订阅覆盖几个群不影响这条规则 —— 每条 binding
  只有一个话题。
- **多群广播**：若需求出现（一个本地 target 发到多个群），**必须**由显式 egress policy 列出目标和
  内容级别（需求 FR-9.6，`docs/requirements/agent-enhancement-requirements.md:270`），并遵守
  §6 基数约束「不能制造入站歧义」（`docs/requirements/agent-enhancement-requirements.md:102`）。
  **FR-2.6 默认不做广播**，只做「每群可独立订阅/认领」；广播留到 egress policy 那一层，避免把
  订阅模型和出站模型耦合。
- 出站身份（单智能体方案下 = 运输 agent 自己）与 `resolveLarkIdentity` 逻辑不变
  （`scripts/chain-template.mjs:150-171`）；发到哪个群由话题（root message 所在群）决定，
  不新增「按订阅挑群」的出站路径。

---

## 3. 数据模型提案（含兼容迁移）

> **2026-09-02 评审修订（PR #112 裁决）**：撤回「schema 字面完全不动」。身份完整性守卫
>（subscription_id 必须等于按公式重算的值）落地后，「同四元组多条订阅」需要显式区分位 ——
> schema 升 **1.1** 增加可选 `instance_key`（进 id 哈希：`"instance:"+key`）；1.0 legacy 条目
>（无 key、原四元组公式）继续合法，两版并行读取。迁移语义随之明确：同 id 版本前进 = resnapshot；
> 不同 id、四硬边界（endpoint/domain/agent/chat）一致且授权覆盖 = migrate。CLI 的
> pause/resume/remove 支持 `--subscription-id` / `--instance-key` 精确寻址，四元组下多条时歧义拒绝。

### 3.1 提案 A（推荐）：Subscription v1 保持单群，多群 = 同域多条订阅

- **不新增 schema**。一条订阅仍然声明一个 `scope.chat_id`（`references/subscription-v1.schema.json:67-72`）；
  「一个项目/业务域接多个群」表达为**同 `domain_id` 的多条订阅**（每条一个群），或同域订阅加
  `chat_ids` 数组（见 3.2）。
- 订阅身份保持 (endpoint, domain, chat, agent)（`scripts/subscription.mjs:137-140`），群维度自然
  成为多订阅的区分键之一；这与 FR-2.5 计划器「同一个群里本来就可以有多条订阅」的归属语义对称
  （`docs/requirements/agent-enhancement-requirements.md:307`）。
- **为什么推荐**：改动面最小 —— schema、validateSubscription、chat scope ref 派生全部不动；
  首次认领的多群逻辑只多一个「chat 维度过滤 + 歧义拒绝」的组合，判据已存在
  （`scripts/subscription.mjs:258-279`）。
- **代价**：群参数（如每个群不同的发送者集合）需要每条订阅各自声明；「一个群的参数变」只改一条
  订阅，反而更清晰。

### 3.2 提案 B：Subscription v2，`scope.chat_id` → `scope.chat_ids`（数组）

- 若产品要求「一条订阅跨多个群共享同一组发送者/事件/新鲜度」，则把 `chat_id` 升级为 `chat_ids`
  数组（`uniqueItems`、`minItems: 1`），并相应把订阅身份、`validateSubscription`
  （`scripts/subscription.mjs:63`）、首次认领过滤（`scripts/subscription.mjs:258-259`）、
  chat scope ref 派生（`scripts/dialogue-binding-authorization.mjs:263`）改成集合语义。
- **不推荐先行**：改动面大（schema + 身份 + ref 派生 + 同步器），而「一条订阅多个群共享全部参数」
  是否真实需要尚未有样本；且 chat scope ref 单值语义（`chat_scope_ref`）在 v1 快照里已固化，
  v2 需要新快照 schema 或 ref 组合规则，迁移成本高。
- 若走 B，建议 v2 新增 `schema_version: "2.0"`，旧 v1 制品仍被读取方接受（沿用 `sender_roles`
  的先例：旧制品不带新字段仍接受，`scripts/subscription.mjs:69-72` 与
  `references/subscription-v1.schema.json:74-108` 的 sender_roles 是 optional）。

### 3.3 兼容迁移（两种提案共用）

1. **投影路径不动**：`buildLegacySubscriptionReadModel`（`scripts/subscription.mjs:99-190`）继续作为
   只读投影，新建订阅只从控制面落盘对象读，两者按 `subscription_id` 不冲突
   （投影 id 是 (endpoint, domain, chat, agent) 的哈希，控制面新建订阅沿用同一派生规则即可对齐）。
2. **新增字段一律 optional + 有默认**：任何新字段（如 `chat_ids`）沿用 `sender_roles` 的入场方式 ——
   schema 里 optional，`validateSubscription` 里「缺 = 回退单 chat_id」；已落盘旧制品不被判为不完整。
3. **binding 授权快照随订阅变更 resnapshot**：订阅的群参数变更 = 内容变更 → 版本前进 →
   FR-2.5 计划器算出受影响 binding 该 resnapshot / suspend / migrate（`scripts/subscription-sync.mjs:213-330`）；
   迁移仍必须由人显式指定目标订阅，逐项校验授权覆盖（endpoint/domain/agent/群/运输身份/发送者/
   事件类型/新鲜度，差一样不迁）。
4. **审计**：订阅创建/修改/暂停/删除留下审计记录（需求 FR-2.8，
   `docs/requirements/agent-enhancement-requirements.md:148`）—— 复用订阅同步的 operation/revision
   机制（`scripts/subscription-sync-apply.mjs` 的 prepared/重试语义）。

---

## 4. 开放问题清单（归属分层见 §5：四条拍板项、四条工程项、两条外部依赖）

| # | 问题 | 现状锚点 | 影响 |
|---|---|---|---|
| 1 | **chat locator 何时可信**：canonical event `source.chat_id` 何时能由 dispatcher 验证并置 `verified: true`？ | `scripts/canonical-event.mjs:54-58,112-114`；需求 §12 末条（`docs/requirements/agent-enhancement-requirements.md:369-372`：Aily daemon 注入的 `AILY_CLI_CHANNEL_THREAD_ID` 与真实飞书 topic/root/session locator 的对应关系待重新验证） | 多群路由切流的硬前置；不解决则 FR-2.6 只能停在「控制面建订阅 + shadow 对照」 |
| 2 | **多订阅真实样本从哪来**：需要第二个真实群做首次认领的多订阅样本（`docs/architecture/layers-modes-permissions.md:109` 已挂起）；没有样本，AMBIGUOUS 路径不许切流 | `scripts/subscription.mjs:278-279` | FR-2.6 验收的前置；也决定「先开写入口 + shadow」还是「先等样本」 |
| 3 | **订阅管理单位**：是「项目根目录」还是抽象业务域 ID（需求 §12 第 1 条）？今天 domain_id 由项目根当场派生（`scripts/subscription.mjs:136`） | 需求 §12 | 决定控制面命令的入参形态 |
| 4 | **一条订阅一个群还是多群共享参数**：提案 A（同域多条订阅）vs 提案 B（chat_ids 数组）；需要产品样本判断「共享参数」是否真实需求 | §3.1 / §3.2 | schema 与迁移成本的分叉点 |
| 5 | **订阅写入口的命令形态**：`register-subscription.mjs`？沿用 `register-sender.mjs` 的预览/`--apply` 两段式与锁内事务？是否从飞书开放（封闭措辞，owner 逐次授权）？ | `scripts/register-sender.mjs:9-15,66-88` | 控制面工程量与授权面 |
| 6 | **多群时群名显示**：模板只有一个 `chat_name`；多群订阅的群名从哪来（平台侧拉群名 / 控制面登记时录入 / 保持「群名不可用」）？ | `scripts/feishu-subscribe.mjs:78-79,105` | 状态页与订阅命令的展示正确性 |
| 7 | **与另一条链（cc2cd / Codex 链）的群关系**：两条链的群参数各自独立，还是共享模板；多群后共群风险（§7.2「根话题各自独立」）是否仍成立 | `scripts/chain-template.mjs:43-52`（链路级模板按链一份） | 安全边界 |
| 8 | **广播是否进本 FR**：FR-2.6 默认不做（§2.3）；若 Frank 要「一个本地 target 发多个群」，需独立 egress policy（FR-9.6） | `docs/requirements/agent-enhancement-requirements.md:102,270` | 范围控制 |
| 9 | **订阅与角色表的组合**：`sender_roles` 是链路级（模板）还是订阅级（scope）？多群各自不同发送者集合时，角色表要不要按订阅声明 | `scripts/sender-roles.mjs:14-16`；`references/subscription-v1.schema.json:74-108` | 权限模型复杂度 |
| 10 | **订阅 vs 私聊**：私聊（无 chat_id 维度）在订阅模型里怎么表达？今天私聊走 chat 默认态（`scripts/inbound.mjs:176`、`docs/architecture/layers-modes-permissions.md:32`） | `scripts/inbound-route.mjs:365-385`（`evaluateChatGates`） | 订阅 scope 的边界定义 |

---

## 5. 待拍板清单（owner 逐项拍板；括号里是主会话的推荐）

§4 的十条开放问题按归属分三层。**只有这四条需要 Frank 拍板**，其余是工程判断或外部依赖：

1. **提案 A 还是 B**（§4-#4）——推荐 **A**（同域多条订阅）：改动面最小、歧义判据已存在；
   「一条订阅跨多群共享参数」尚无真实样本，且 `chat_scope_ref` 单值语义已在 v1 快照固化，
   B 的迁移成本高。即便日后改走 B，A 的第一步（控制面 + shadow）两案共用。
   *（拍板时的理由含「schema 字面不动」；2026-09-02 评审 #112 裁决修订为 schema 升 1.1
   加可选 `instance_key`、1.0 并行合法 —— 见 §3.1 修订框。A 的核心「一条订阅一个群、
   多群 = 多条订阅」不变。）*
2. **订阅管理单位**（§4-#3）——推荐**维持项目根目录派生 domain_id**（现状
   `scripts/subscription.mjs:136`），抽象业务域 ID 等多群真实样本出现后再议。
3. **写入口是否从飞书开放**（§4-#5 后半）——推荐**不开放**：订阅写与 `register-sender`
   同级（改授权面），沿用「写操作只在终端、owner 逐次授权」的既有纪律。
4. **广播是否进本 FR**（§4-#8）——推荐**不进**：留给 egress policy（FR-9.6），
   本 FR 只做「每群可独立订阅/认领」。

工程自决项（不占拍板）：#6 群名在控制面登记时录入（保持 fail-closed 的「群名不可用」为回退）；
#7 两条链模板照旧各一份；#9 角色表跟提案 A 按订阅声明；#10 私聊不进订阅模型（私聊走 chat
默认态，是订阅 scope 的边界外）。外部依赖项：#1 chat locator 验证、#2 第二个真实群的样本 ——
两者都是**切流**的前置，不是**开工**的前置。

## 6. 实现拆单（按提案 A；拍板后进队列）

依赖关系：单 1 → 单 2 可并行于单 3；单 4 依赖单 1。切流（多群路由转权威）额外依赖
外部项 #1/#2，不在本批单内。

| 单 | 难度 | 内容 | 验收要点 |
|---|---|---|---|
| 1. 订阅控制面落盘 + 写入口 | M | 独立落盘对象 + `register-subscription.mjs`（预览/`--apply` 两段式、锁内事务、备份、原子写、逐字读回，复用 `withChainTemplateWrite` 纪律）；新建订阅沿用投影同一套 id 派生规则 | 不装不建文件的机器投影逐字节不变；写入口 dry-run 零副作用；owner 逐次授权 |
| 2. 多订阅歧义矩阵行为测试 | S–M | 首次认领在多订阅下的组合覆盖：chat 命中唯一/多条/不可信、绑定码精确/重复/未知、pending 多条无码 → AMBIGUOUS（判据已存在 `scripts/subscription.mjs:258-279`，缺的是多订阅输入下的行为测试） | 每个拒绝原因至少一条正向 + 一条反向；shadow 记录 `scope_unverified` 的路径有断言 |
| 3. 群名登记与展示 | S | 控制面订阅可录入 `chat_name`；`feishu-subscribe` / `layered-status` 优先显示登记名，缺失回退「群名不可用」 | 模板群名不错报的 fail-closed 行为保持（`scripts/feishu-subscribe.mjs:78-79`） |
| 4. 订阅审计记录 | S | 创建/修改/暂停/删除留审计（FR-2.8），复用订阅同步的 operation/revision 语义 | 每种写操作产生一条可核对记录；重试不重复记 |

---

## 附录 A：本稿引用的关键文件

| 文件 | 角色 |
|---|---|
| `docs/requirements/agent-enhancement-requirements.md` | 需求源（FR-2 / §6 / §9 / §12） |
| `docs/architecture/layers-modes-permissions.md` | 四层现状与 FR-2.6 挂起决策（§6 第 6 行） |
| `docs/implementation/subscription-claim-slice.md` | 首次认领切片的实现与切流前置 |
| `references/subscription-v1.schema.json` | Subscription v1 schema |
| `references/dialogue-binding-authorization-v1.schema.json` | binding 授权快照 schema |
| `scripts/subscription.mjs` | 订阅只读模型 + 首次认领候选 selector |
| `scripts/subscription-sync.mjs` / `subscription-sync-apply.mjs` | FR-2.5 同步计划器 / 落盘控制面 |
| `scripts/inbound-route.mjs` | 入站路由：投影、认领、promote |
| `scripts/inbound.mjs` | 入站主路径 |
| `scripts/canonical-event.mjs` | Canonical Event v1（chat locator 验证状态） |
| `scripts/chain-template.mjs` | 机器级链路模板（单群字段） |
| `scripts/registry.mjs` / `project-resolve.mjs` | 登记表与项目解析 |
| `scripts/register-sender.mjs` / `sender-roles.mjs` | 受控登记先例（写入口纪律） |
| `scripts/dialogue-binding-authorization.mjs` | 授权快照物化（chat scope ref） |
| `scripts/bind-project.mjs` / `bind-session.mjs` / `feishu-rotate.mjs` | 建话题/轮转的群选择 |
| `scripts/watch-and-publish.mjs` / `outbox.mjs` | 出站目标选择（按来源代际冻结） |
