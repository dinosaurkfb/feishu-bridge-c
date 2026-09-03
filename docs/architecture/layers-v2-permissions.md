# 架构 v2 第二步 —— 准入判定与权限挂载

> 2026-09-04。接 `layers-v2-session-centric.md`（第一步：话题智能体模型、连通性
> 投影）。本步回答：一条入站消息**准不准做、由谁做、做不做得成、结果怎么回**，
> 并把旧 `layers-modes-permissions.md` §5 的角色/风险/模式矩阵挂到 v2 投影上。
> 经 Codex 首轮评审（P1×4/P2×3）返修：**准入是四层判定的合取，授权只是其一**。
> **状态：第二步定稿（Codex 四轮评审放行，无 P1/P2）。§10 拍板项待 Frank。**

## 0. 一句话

准入 =「授权 ∧ 适用性 ∧ 能力 ∧ 投递」四层判定的**合取**，四层各答一个不同的
问题、互不代偿。第一步的连通性质量（降级/全通）只落在**投递**层——它不改
**授权**（谁有资格）、不改**适用性**（动作有没有目标）、不改**能力**（有没有可
验证执行路径）。正因如此，授权层里 A2 与 A3 的角色权限**可以坍缩一致**；但
「能不能做」不等于授权一层，不能只看那张三行表。

## 1. 准入四层（本步的骨架，评审 P1-1/P1-2）

一条入站消息要真正被执行，必须**四层依次全过**；任一层否决即拒，且各层否决理由
不同、回执不同：

| 层 | 判据函数 | 问题 | 输入 | 否决示例 |
|---|---|---|---|---|
| ① 授权 | `authorizePolicy` | 这个角色**有没有资格**做这一类动作 | role × context × policy × riskClass × resource_scope | participant 在 Mapping 下发 R2 → 无资格 |
| ② 适用性 | `applicability` | 这个动作在**当前上下文有没有目标/是否被收成指引** | context × action | 无绑定下 `/feishu-mode` → 无目标，收成接入指引 |
| ③ 能力 | `evaluateCapability` | 该链**有没有可验证的执行路径** | chain × action × required_capability | Codex 链非 owner 的 R1 → `no_reply_only_path`（现行 authorize.mjs 已返回） |
| ④ 投递 | `delivery_plan` | 结果**以什么通道/格式回** | 连通质量（anchor/link_proof） | 无合法 delivery_plan → 否决；有 plan 但本次发送失败 → health |

**四个判据是四个独立函数**（评审 R2-P1-2）：外层准入按顺序调用，但**第①层
`authorizePolicy` 不读 `chain`**——chain 只作用于第③层 `evaluateCapability`。
否则「同一角色的授权结论随链改变」，四层就只是文档分段、没有形成独立判据。
现行 `authorize.mjs` 把授权与 chain-能力揉在一个函数里，M2 拆成两个。

**三行授权表（§5）只回答第①层。**②③④ 各有自己的封闭表/判据。旧文档把四者缠在
「四层链路」里，v2 拆开——这才是「表更小」的正确含义：授权表小，是因为它只管
一件事，其余三件各归各表。

**能力（③）与投递（④）的界线**：第③层管「有没有已配置的结果路径」（如 Codex
链无可验证 reply_only 面 → **执行前**否决）；第④层要求**执行前必须能形成一份
合法 `delivery_plan`**（选定通道：富卡片 / deliver），形不成即否决；**已有 plan
但实际发送失败**归 health，不回溯阻止已执行的动作。即：无路径=能力否决、
无 plan=投递否决（都在执行前）；发送失败=health（执行后）。

## 2. 上下文坍缩（只作用于第①层授权）

第一步 5 个连通投影 → 授权上下文（context）与生命周期无关的**授权分类**：

| 连通投影（族） | 授权上下文 | 策略 policy |
|---|---|---|
| ∅ 未物化 | —（无 live 记录，见 §4 时序） | — |
| 等配对@（B1） | unbound（普通消息落并存 A1）；配对动作见 §4 | — |
| chat（A1/A4/B3′） | **unbound** | — |
| 已绑定·降级（A2） | **bound** | Mapping / Dialogue |
| 已绑定·全通（A3/B3/B4） | **bound** | Mapping / Dialogue |

**坍缩仅在授权层**：降级（A2）与全通（A3/B3/B4）授权上下文都是 bound、策略同源，
故角色权限一致（评审确认成立）。它们的差别在第④层投递，不在授权。
context 与 policy 是**两个正交字段**（评审 P2-2）：context∈{unbound, bound}
描述生命周期，policy∈{Mapping, Dialogue, ∅}描述已绑定话题上普通文本的含义；
不再用单一 `mode` 把它们并成一维。

## 3. 授权输入（第①层，评审 P1-4/P2-3）

`authorizePolicy({ role, context, policy, riskClass, resource_scope })`——
**不含 chain**（评审 R2-P1-2：chain 归第③层 `evaluateCapability`）：

- `role`：owner / operator / participant / 未登记（前提②）；
- `context`：unbound / bound；
- `policy`：Mapping / Dialogue（仅 bound；unbound 为 ∅）；
- `riskClass`：R0 / R1 / R2 / R3 / R4（旧 §5.2 原样）；
- `resource_scope`：**判别字段**（评审 P2）——`riskClass=R0` 时必为 topic 或
  machine；`R1–R4` 时必须缺席/null（调用方不得给非 R0 塞 scope，authorizePolicy
  对此 fail-closed）。它是 R0 只读的信息边界（§7），替代上一稿把「敏感范围」塞进
  riskClass 的做法。

`chain`（Claude / Codex）只进第③层 `evaluateCapability({ chain, action,
required_capability })`，**不进授权层**。**「结果投递质量」也不是授权输入**——
它在第④层，授权判完之后才谈。

## 4. 首条受验@ 的时序与配对复合消息（评审 P1-3/P2-1）

**封闭判定优先级（P1-3；bind-only 为本稿推荐方案，待 §10 拍板）**——一条入站
消息的处理顺序固定为：

1. 首条受验@ 先**物化/取得 A1**（create，unbound）；
2. 检查是否构成 **owner 对 B1 的配对尝试**（该话题有 B1 且发送者是 owner 且受验@）；
3. **是** → 整条消息归 **R3 pairing**，执行 F4 对账；**成功或失败都不再处理正文**
   （F4 对账失败也是配对失败，回执要求重发——**不把正文降回 chat 执行**）；
4. **否** → 正文才按 A1/unbound 归类与授权（§5/§6）；
5. 同 message_id 重放**只重放配对终态**，永不补执行正文。

这条优先级同时给出时序（步 1，评审 P2-1：物化在前、所有话题一视同仁）和配对
复合消息语义（步 3，评审 P1-3：一条消息只属一个上下文）。**与现行差异**：现行
非空正文在绑定后会继续按新策略执行（inbound.mjs 附近）；v2 收紧为 bind-only
（若 §10 拍板采纳）。行为收紧，M2 实现时同步测试。

## 5. 授权交叉表（第①层，角色 × 上下文 × riskClass）

沿用旧 §5.3，「模式」维度按 §2 重述为 context+policy；**此表只回答「若动作适用
（②）、能力就绪（③），谁有资格」**：

| 上下文 × 等级 | R0 只读 | R1 对话 | R2 执行 | R3 控制 | R4 授权 |
|---|---|---|---|---|---|
| unbound | 按 R0-scope 矩阵（下） | owner / operator / participant | —（无 R2 动作适用，见 §6） | owner | owner |
| bound · Mapping | 按 R0-scope 矩阵（下） | owner | owner | owner | owner |
| bound · Dialogue | 按 R0-scope 矩阵（下） | owner / operator / participant | owner | owner | owner |

**R0-scope 封闭矩阵（context × resource_scope，评审 R2-P1-1）**——R0 的「谁」
由 scope 与上下文共同决定，不是笼统 owner/operator：

| 上下文 × scope | topic | machine |
|---|---|---|
| unbound | owner / operator | owner |
| bound · Mapping | **owner**（Mapping 全 owner-only，不放宽） | owner |
| bound · Dialogue | owner / operator | owner |

§7 的信息暴露裁剪，只在该角色**先通过这张矩阵**之后才生效。

角色×等级每格取值与旧表**逐格不变**；变化只是维度名（mode→context+policy）与
坍缩（降级/全通合并进 bound）。表外格子不允许。

## 6. 上下文 × action 适用性表（第②层，评审 P1-2）

授权表不表示「所有 R3 命令在任何上下文都可执行」。适用性单独一张表，answer
「这个动作在这个上下文**有没有目标**」——无目标者即使授权通过也不执行，收成
指引或拒绝：

| action（意图） | unbound | bound |
|---|---|---|
| 普通文本 | R1 对话（无 run 目标） | R1/R2 按 policy |
| `/feishu-bind`（= create 建桥话题） | 不适用：无绑定飞书话题没有本机项目目标可供现行 bind 建题所依附 → 接入指引（去终端 bind，或用 attach） | 冲突语义（§第一步 §6-2，推荐拒绝） |
| `/feishu-attach <目标>`（= bind 当前话题） | **适用**（认领当前话题到指定本机项目） | 冲突语义（推荐拒绝） |
| `/feishu-mode …` | 不适用（无绑定可切）→ 接入指引 | 适用（切策略） |
| `/feishu-rotate …` | 不适用（无代际可转）→ 接入指引 | 适用 |
| `/feishu-status` | **适用（v2 新增行为）**：读 topic-local 投影（§7）。现行 unbound 无此、走接入指引；v2 开放为新增 | 适用 |
| `/feishu-subscribe` | **适用（v2 新增行为）**：读**当前话题对应的订阅行**（过滤到本话题，topic scope，§7）；现行 unbound 走接入指引 | 适用（同） |
| `/feishu-projects` | 适用（machine scope，owner-only，§7） | 适用（同） |
| R4 授权用语（`装`/`切路由`/`写飞书`…） | **不适用**：unbound 缺受验的绑定工作上下文与待授权对象（授权指向的是某个已绑定项目里待装的 PR/待切的路由）→ 回执指路已绑定话题或终端 | **适用**（owner）：bound 下有绑定项目作为授权对象，owner 封闭授权用语生效（飞书授权等同终端授权，CLAUDE.md）；Mapping/Dialogue 都按现行 full capability 投递 |
| `/feishu-unbind` `/feishu-pin-session` | 不从飞书开放 → 拒绝指路终端 | 同 |
| malformed | 拒绝（记差在哪） | 拒绝 |

「收成接入指引」= 无目标时返回引导而非执行——归**适用性**层，不是授权层。
两类（评审 R2-P1-3，措辞统一）：

- **mode / rotate**：保持**现行**接入指引（unbound 无绑定/无代际可操作）；
- **status / subscribe**：**v2 新开放**的 topic-local 只读行为（现行 unbound 走
  指引，v2 改为读本话题投影，明确是新增、不是「逐格不变」）；
- **R4**：unbound 不适用的理由是**缺受验绑定上下文/授权对象**（不是「零工具」
  ——那属能力层③，不该在适用性层②表述）；bound·owner 适用。

## 7. R0 的 resource_scope（第①层内的信息边界，评审 P1-4）

R0 只读拆为两个 resource_scope（不改 riskClass，避免 R0 同时背「是否写状态」和
「信息敏感度」两件事）：

| scope | 读什么 | 谁 | 命令 |
|---|---|---|---|
| topic | **当前话题智能体**的投影名 + 策略；`/feishu-subscribe` 过滤到**当前话题对应的订阅行**（不出链级概况） | owner / operator | `/feishu-status`、`/feishu-subscribe`（本话题行） |
| machine | 跨话题 / 本机信息（项目清单、工作线、链级订阅概况） | **owner-only** | `/feishu-projects`、`/feishu-subscribe --chain`（若开放） |

`/feishu-subscribe` 的归属修正（评审 P1-4）：链级 transport、角色人数、多订阅
概况**不是**当前话题投影，不能挂 topic scope 给 operator。本稿采**收窄为
topic**：`/feishu-subscribe` 只展示并过滤到当前话题对应的那一条订阅行，保持
resource_scope=topic；若将来要看链级概况，另立 machine scope、owner-only 的入口。

**topic scope 的暴露边界（评审要求明确）**：operator 的 R0-topic **只看**
连通投影名与策略；**不暴露** B1 的目标项目、A4/B3′ 休眠绑定的本地路径、B4 的
历史项目身份——这些都是本机信息，归 machine scope（owner-only）。即 operator
知道「这个话题接通了、在 Mapping」，但不知道「它通向本机哪个项目」。

`/feishu-projects` 的 owner-only **由授权判据表达**（authorizePolicy 里
resource_scope=machine ⇒ owner），**不在派发处前置第二道 owner 闸**（评审
P1-4：唯一授权入口，杜绝第二份权限规则）。

## 8. 命令表增补（v2 新命令）

| 命令 | 意图类别 | riskClass / scope | 飞书可发 | 谁 | 处置 |
|---|---|---|---|---|---|
| `/feishu-projects` | readonly | R0 / machine | 是（正文恰为） | owner | 确定性枚举已装桥项目+活跃工作线，同步回执；不出 locator/路径 |
| `/feishu-attach <序号\|名>` | model_control | R3 | 是（正文恰为，封闭） | owner | unbound：秒回执→attach 事务→deliver 回报；bound：冲突语义 |

两条都从飞书开放，终端不需要（终端有更全的 bind）。均落进 §5/§6/§7 既有判据，
不新增授权语义。

## 9. 与现行实现的对齐（评审关注）

- 现行 `authorize({ role, riskClass, mode, chain })` 把授权与 chain-能力揉在一个
  函数里；v2 **拆成两个**：`authorizePolicy({ role, context, policy, riskClass,
  resource_scope })`（不含 chain）+ `evaluateCapability({ chain, action,
  required_capability })`。`mode` 拆成 `context`+`policy`，新增 `resource_scope`；
  授权对**角色×等级**逐格不变。
- 现行 authorize 已实现第③层的一部分：Codex 链无可验证 reply_only 路径时返回
  `no_reply_only_path`（authorize.mjs）。v2 把它显式归为**能力层**否决，与授权层
  分开表述——不是「participant 无资格」，是「链无执行路径」，回执不同。
- 现行 chat 路径把 status/subscribe/mode/rotate 都收成接入指引（inbound.mjs）：
  v2 归入**适用性层**（§6），但**行为不完全保持**——mode/rotate 保持指引；
  status/subscribe 在 unbound 改为**新开放**的 topic-local 只读（§6，明确的
  v2 新增行为，M2 实现）。
- 降级态（A2）R2 执行：授权照准（owner），结果投递走 deliver 纯文本——第④层的
  事，不进 authorize；runRequest 的 capability 字段之外，投递层按连通质量选通道。
- 私聊不进本模型（前提③白名单 + chat 式对话），权限沿用现行私聊路径。

## 10. 待 Frank 拍板

1. 配对复合消息选 **bind-only**（§4，推荐——最封闭）还是两阶段？
2. `/feishu-projects` 清单范围：只列已装桥项目+活跃工作线（推荐）还是本机全部？
   （与 feishu-initiated-binding.md G1 并轨）
3. operator 的 R0-topic 暴露边界按 §7（只看投影名+策略、不看本机项目身份）可以吗？
4. 命令名 `/feishu-projects`、`/feishu-attach` 沿用吗？

拍板后：第二步定稿，与第一步一并作为 M1 需求输入；第三步（绑定唯一性/冲突语义、
账本存储与锁）继续推导。
