# 架构 v2 —— 话题智能体模型（群话题；逐步推导版）

> 2026-09-03。Frank 定向：基于新认知重新推导架构，目标是更简洁。本稿是**第一步**
> （实体、生命周期事实与状态投影），由 Frank 与主会话当日逐轮推导，经 Codex 多轮
> 评审返修。适用范围限定**群话题**；私聊不进此模型。现状记录仍在
> `layers-modes-permissions.md`（不动，全部步骤定稿后一次性订正）。维护约定：
> 本文件是权威源（git 管理、agent 读），飞书版是发布视图，定稿后逐次授权同步。
> **状态：第一步定稿（Codex 五轮评审放行，无 P1/P2）；§8 全部拍板项 Frank 已定
> （历史代际=a 保留能力、#123=关、F4=user 身份，2026-09-04）；M1 账本实现（文件
> 结构、锁、CAS、tombstone、事务）另行送审。**

## 0. 一句话

旧架构的复杂度大半来自**两套坐标系**：入站说 Aily 话（session_id / msg_），出站说
飞书话（om_ / chat_id），换算关系只能在"桥自己建话题"那一刻建立。v2 以**话题智能体**
为中心实体：少量**生命周期事实**落盘为权威账本（带跨字段不变量的封闭联合），用户
可见状态与通道通断都是账本的**派生投影**；配对由受验证明（显式 attach 或 F4 对账）
替代绑定码与歧义矩阵。

## 1. 复杂度根源诊断（旧架构为什么长成那样）

1. 出站唯一寻址是 reply-in-thread，需要 om_ 根消息；om_ 只有桥建话题时拿得到
   → 桥必须拥有话题（bind 建话题、rotate 建代际）。
2. 桥建话题时只有 om_，首次 @ 入站时只有 session_id，两边机器对不上账
   → 配对只能靠间接证据：绑定码、新鲜度窗口、"唯一 pending"假设
   → 歧义矩阵、码的 bearer 争议（#123）、@ 闸豁免与握手——全是对账缺口的衍生物。
3. 用户只能来桥建的话题里说话 → 未绑定上下文一律拒 → 违反 owner 原则 → 补 chat
   默认态（补丁摞补丁）。
4. 旧文档把机器级/链级的全局前提与话题级状态画进同一条"四层链路"，归属不同的
   关系混在一起。

## 2. 基石事实（已实测/已核实）

| # | 事实 | 依据 |
|---|---|---|
| F1 | 话题=session，session_id 每轮入站天然可得，跨轮稳定 | channel-locator-verdict.md |
| F2 | `aily-cli deliver --session-id` 任意时刻可投纯文本到该话题（无需活跃 Run、无需 om_） | 2026-09-03 10:35 真机实测落地 |
| F3 | 任意群拉进 agent + owner @ 即达 chat 态（off-template 只诊断不拒） | evaluateChatGates + 真机多群实测 |
| F4 | bot 消息读权限可按 chat_id+时间窗反查任一消息的 om_ 与 thread 根，实现确定性对账 | **部分就绪**：单条读（mget by om_）已通；历史读（时间窗列消息）仍 230027，疑缺「获取群组中所有消息」档或版本未发布 |
| F5 | session 只由话题内首条 @ 创建（Aily 机制），基础入向在此之前物理上无法打通 | Aily 会话模型；云端智能体对照实验 |

## 3. 第一步：话题智能体模型

### 3.1 实体与身份（可落盘）

**话题智能体 = 某个飞书群话题中的某一个第三方智能体**。它是状态的唯一载体：
同一话题里几个智能体就是几份实体；同一智能体在不同话题里是不同实体；智能体本身
只有在线与否，话题本身没有状态。

**身份与账本**：

- 每个实体在**权威账本**（话题智能体表）里有稳定主键 `topic_agent_id`（账本
  生成，不复用任何平台 locator）。账本是**链机器级、绑定前即可访问**的 Git 外
  状态（入站路由器维护，与现行 `.runtime-data` 同纪律但不挂在任何项目目录下
  ——未绑定的 chat 实体没有项目归属，评审 R3 措辞建议）。
- 平台 locator 是实体的**别名**，最多两个：session locator（用户路径先到）、
  root om_ locator（桥路径先到）。**一条 live 记录同时持有两个别名的唯一途径是
  配对事务**（评审 R4-P1-2）：配对前，同一物理话题可以对应**两条 live 记录并存**
  （桥的 pending 记录 + 用户 @ 产生的 chat 记录）——这不是异常，是双坐标系现实的
  真实写照；配对事务把它们归并为一。
- **账本顶层是判别联合**（评审 R4-P1-1），每条记录恰为一种：
  - `live`：必须逐字段属于 §3.3 合法事实族；
  - `forwarding_tombstone`：归并后被吞记录的留痕，封闭字段集 = {原 ID、存活 ID、
    归并时间、证明引用}。禁止自指、环与悬空目标；指向同一存活 ID 的重放**幂等**，
    指向不同 ID 为**冲突，fail-closed**；
  - `voided_audit`：作废代际的审计留痕（原 pending 的根 om_、时间、原因），
    不路由、不投影、不参与任何派生。
- **归并语义**：桥路径记录的 `topic_agent_id` 存活（它携带本地端与谱系）；chat
  记录的 ID 转为 forwarding_tombstone。两条记录已各自配对到不同实体则为冲突
  （同锁事务内 CAS，不覆盖）。实现协议（锁、文件布局）在 §6-4 另行设计。
- 所有用户可见状态、通道通断、路由决策都从账本**派生**，不另立第二事实源。
  现行实现没有这份账本（chat 只是路由回退）——建账本是迁移的第一步（§7 M1）。

**边界**：私聊不进此模型（见前提③）。飞书话题本身的创建是另一个对象上的操作，
不是本模型的原语。

### 3.2 图外前提（三条，不进状态机）

| 前提 | 归属 | 说明 |
|---|---|---|
| ① 机器在线 | 智能体全局 | 影响可达性，不改变实体状态 |
| ② 发送者在角色表 | 链全局 | 人的属性（owner / operator / participant） |
| ③ 会话表面已受验 | 链全局 | 会话 locator 的信任登记（今天只有私聊白名单 `verified_p2p_chat_ids`）——登记的是"会话"不是"人"，与②分开 |

### 3.3 生命周期事实（账本里的封闭联合）

| 变量 | 取值 | 说明 |
|---|---|---|
| `session` | absent / present | 由任何人的首条 @ 触发（F5，不由我们控制） |
| `binding` | none / pending / active / dormant | 本地端。active 必带 **binding_proof**（owner 授权的 session↔本地项目关联证明：attach 命令或配对事务的受验记录）；pending=桥建话题预定目标；dormant=unbind 留档 |
| `anchor` | absent / present(root om_) | 富卡片出站锚：桥建话题天生带；attach 路径靠 F4 反查补 |
| `locator_link_proof` | absent / present | session 与 root om_ 属于同一话题的证明（F4 对账产物，或桥路径配对事务本身）。**与 binding_proof 是两回事**：attach 无 F4 时只有 binding_proof |
| `generation` | n/a / pending / current / historical | 桥建谱系专用。pending=rotate/bind 刚建、尚未接管的新代际。**voided 不是 live 取值**——作废只存在于顶层 `voided_audit` 记录（§3.1，评审 R5-P2-1） |

**合法事实族全表（live 记录的封闭联合）**——每条 live 记录必须逐字段落在下表
某一行；不属于任何行 = 账本损坏（处置见 §3.4 损坏顺序）：

| 族 | binding | session | anchor | link_proof | generation | 投影 |
|---|---|---|---|---|---|---|
| A1 | none | present | absent | absent | n/a | chat |
| A2 | active | present | absent | absent | n/a | 已绑定·降级 |
| A3 | active | present | present | present | n/a | 已绑定·全通 |
| A4 | dormant | present | 成对保留或全无 | 同 anchor | n/a | chat（休眠） |
| B1 | pending | absent | present | absent | pending | 等配对@ |
| B3 | active | present | present | present | current | 已绑定·全通 |
| B3′ | dormant | present | present | present | current | chat（暂停的当前代际，恢复回 B3） |
| B4 | active | present | present | present | historical | 已绑定（历史，Frank 拍板 a：保留现行能力，能下指令回原话题，不承接常规出站/不计数/不轮转） |

要点（评审 R4-P1-2 定案）：

- **没有"双 locator 而无 link_proof"的行**。桥的 pending 实体（B1）永远
  session=absent——话题里有人 @ 产生的 session 属于**另一条 A1 chat 记录**，
  两条 live 记录并存，直到配对事务证明同话题并归并。旧稿 B2/B5 因此删除；
  "session 已生未配对"不再是任何实体的状态。
- **anchor_candidate 是 live 记录 schema 里的封闭可选旁注字段**（评审 R5-P2-2：
  不是"允许任意附加字段"——schema 之外的字段仍算损坏）：未受验的根 om_ 线索
  （如作废谱系留下的旧根）只能放这里，作为 F4 重验的输入，不参与族约束与任何
  派生；**未受验候选永不写进 anchor=present**。
- 族表蕴含：generation=pending ⇔ binding=pending；current ⇒ binding∈{active,
  dormant}；historical 按 §8-1；谱系（generation≠n/a）⇒ anchor=present；
  active ⇒ binding_proof 存在；link_proof=present ⇒ session=present 且
  anchor=present；live 记录不存在 session=absent 且 binding∈{none, dormant}。
  voided 不是 live 取值——作废代际只以 `voided_audit` 记录留痕（§3.1）。

**受验事务（多字段迁移必须原子完成，只有这几笔）**：

- **激活事务**（配对归并）：B1 + A1 → B3 一笔完成：归并双别名（A1 的 ID 转
  forwarding_tombstone）、binding pending→active、generation pending→current、
  写入 binding_proof + locator_link_proof；若谱系已有旧 current，同事务将其
  current→historical——任何时刻不存在两个 current。
- **作废事务**：B1 → 记录转 voided_audit（live 实体消失；话题里若已有 A1 chat
  记录，它不受影响地继续存在）。
- **attach 事务**：A1/A4 → A2 或 A3。无 F4：→ A2，权威 anchor=absent（任何候选
  根只进 anchor_candidate）；F4 成功：→ A3，同笔原子写 anchor + link_proof。
- **锚定事务**（评审 R5-P1）：A2 → A3，同笔原子写 anchor、locator_link_proof
  及匹配证明（attach 时尝试一次，其后每次入站重试，成功即此事务）。
- **恢复事务**（评审 R5-P1）：B3′ → B3，binding dormant→active，核 current
  唯一性（谱系无其他 current），保留原有双 proof 不重签；A4 的恢复由 attach
  事务覆盖，不另立。
- **unbind 事务**：A2/A3 → A4；B3 → B3′；B4 → A4（Frank 拍板 a 后 B4=active，
  与 A2/A3 同笔覆盖，退回 chat/dormant）。

active 且 anchor=present 且 link_proof=absent 不在任何族里，合法事务也产不出它
（F4 对账与锚定同笔产出 anchor+link）；损坏时的处置顺序见 §3.4。

**运行时健康（health）独立于生命周期**：deliver 失败、Aily 断连、锚失效等是
health 信号，进状态页与 doctor，**不改变**上述事实。投影表述的"全通/降级"是
**已配置能力**的投影；实时可用性由 health 覆盖，两者分开展示。

### 3.4 通道与状态投影（全部由 §3.3 派生）

两级通道：**基础运输层 T**（飞书话题 ⇄ 本机智能体）与**会话联通 L**（飞书话题 ⇄
特定本地会话，受验 binding 级），各分入/出两个方向。派生规则：

**损坏处置顺序（先验证再派生，评审 R4-P1-3）**：

1. 路由前先验证 live 记录属于 §3.3 合法事实族；
2. 不属于任何族 → `ledger_corrupt`：**不路由、不 deliver、不计算投影**（doctor
   报错，人工介入）；
3. 只有合法记录才进入下面的通道派生。

派生规则（仅对合法记录）：

- T入 = session=present
- T出 = session=present（deliver 可用）或 anchor=present（富卡片可发）
- L入 = binding=active 且 session=present
- L出 = binding=active 且（anchor=present 且 locator_link_proof=present →
  富卡片**全通**；否则 deliver **降级**）

「降级 = active ∧ ¬(anchor ∧ link_proof)」这条稳健公式**只用于状态页诊断的
纵深防御**（合法族里它等价于 A2），不赋予损坏记录任何投递能力——损坏在第 2 步
已经拦死（评审 R4-P1-3：fail-closed 与降级不得并存于同一条记录）。

「物理上有 om_ 能发」属于 T出 能力；「某个本地项目获准向这里出站」才是 L出——
两者不混（评审 R2-P1-3）。等配对@ 的根锚是 **outbound_candidate**（具备根锚、
尚未授权为项目出站），不是 L出。

| 投影 | 派生条件（族） | T入 | T出 | L入 | L出 |
|---|---|---|---|---|---|
| ∅ 未物化 | 账本无 live 记录 | — | — | — | — |
| 等配对@ | B1 | ✘ | ✔(om_) | ✘ | ✘（候选†） |
| chat | A1 / A4 / B3′ | ✔ | ✔ | ✘ | ✘ |
| 已绑定·出站降级 | A2 | ✔ | ✔ | ✔ | ◐ deliver 纯文本 |
| 已绑定·全通 | A3 / B3 / B4 | ✔ | ✔ | ✔ | ✔ 富卡片 |

† outbound_candidate：根锚在手（根消息与接通卡就是 T出 能力的证明），但项目
出站不流向这里——项目出站流向仍为 active 的旧代际实体。旧稿的"策略暂扣"概念
由此消融：**出站跟着 active binding 走**是派生规则的自然结果。代际切换发生在
激活事务。

**同一物理话题在配对前可能对应两条 live 记录**（B1 桥记录 + A1 chat 记录）——
话题里任何人 @ 产生的 session 落在 A1 上（T入 经 A1 通），B1 如实保持
session=absent。这就是"T入打开 ≠ 配对完成"的最终形状：两个事实各归各的记录，
不需要任何标志位。

```
 create(用户在话题@)             create(桥建话题)
      │                             │
      ▼                             ▼
 ┌─────────┐   配对前并存   ┌──────────────────┐
 │chat(A1) │ ◀───────────▶ │   等配对@（B1）    │
 └─────────┘   同一物理话题  └──────────────────┘
   │      │                    │           │
   │      │ bind:激活事务(归并) │      作废→voided_audit
   │      └───── B1+A1 ──▶ B3 ▼       (A1 若在,不受影响)
   │ bind:attach        ┌────────────┐
   │ 无F4→A2 / F4→A3    │已绑定·全通  │
   ▼                    │ (B3/B4/A3) │
 ┌────────────┐ F4锚定  └────────────┘
 │已绑定·降级  │ ─────────▶ A3
 │   (A2)     │ (原子写anchor+link)
 └────────────┘
 unbind：A2/A3→A4、B3→B3′（B4 随 §8-1）；投影退回 chat
 激活事务同笔：旧 current→historical（不存在两个 current）
```

要点：

- **配对触发**：owner 的任一受验 @（"owner 配对 @"，不必是话题首条消息——
  session 可能已被别人的 @ 创建在 A1 上）。
- **升级迁移**：A2 → A3 = F4 反查成功原子补上 anchor + link_proof（attach 时
  尝试一次，其后每次入站再试，成功即升级；无后台轮询）。
- **策略旋钮独立**：Mapping⇄Dialogue 挂在 binding=active 上（`/feishu-mode`
  切换、Dialogue 预算耗尽回 Mapping），与 anchor 无关，降级态照常可用。

### 3.5 原语（三个）

| 原语 | 定义 | 入口 |
|---|---|---|
| **create** | 实体在账本物化，必带一个别名 | 用户首次 @（带 session locator）／桥建话题（带 root om_ locator + pending 本地端） |
| **bind** | 建立 binding_proof（owner 授权的 session↔本地项目关联），binding→active；锚与 link_proof 可暂缺，补齐是独立小步 | attach（显式）／owner 配对 @ + F4 对账（隐式，同时产出 link_proof 并归并别名）——同一操作的两个入口，都只认 owner |
| **unbind** | binding→dormant（持久留档），投影退回 chat | 终端命令 |

镜像结构：用户主导 = create 带 session 别名、bind 建关联（锚后补）；桥主导 =
create 带 om_ 别名与 pending、bind 由 owner 配对 @ 完成（关联与 link_proof 同时
产出）。rotate = create 新代际（generation=pending）+ 配对事务接管（不变量 6）。

**首次 @ 的存在必要性（机制级）**：session 只能由话题内首条 @ 创造（F5）——
"等配对@"不是设计选择，是 Aily 给的。F4 消灭的是它的**仪式**（码、歧义矩阵、
豁免），把配对降为零仪式事件。

**命令名实梳理**（概念层结论，改名后议）：现有 `/feishu-bind` 干的是 create
（建话题 + 预约隐式 bind）；真正叫 bind 的动作是 attach。

### 3.6 F4 封闭配对协议

隐式配对（owner 配对 @ → 对账）必须全部满足，任一不满足则**不迁移**（fail-closed：B1 保持 pending、A1 chat 记录照常存在，回执说明）：

1. 入站 chat_id 与 pending 记录的 chat_id 逐字相等（受验群）；
2. 发送者是 owner（角色表）；
3. F4 反查：按 chat_id + 入站时间窗 + 发送者 + 正文逐字匹配，**唯一命中**
   （零命中、多命中、读不清都不迁移；多命中时引导 owner 重发一条含一次性
   nonce 的消息再查——nonce 只用于反查消歧，不是 bearer）；
4. 命中消息的 thread root om_ 与 pending 记录的 root om_ 逐字相等；
5. 匹配证明（命中消息 om_、时间、比对字段）持久化为 binding_proof +
   locator_link_proof，随归并事务落账本。

## 4. 机制退役/保留清单（含退役顺序门槛）

**退役顺序（一律按此推进，不跳步）**：F4 真机闭环 → 停止签发新绑定码 → 双读
兼容存量 pending → 存量清空或迁移 → 删除码与歧义矩阵代码。

| 机制 | v2 处置 | 前置 |
|---|---|---|
| 绑定码 | 退役 | F4 闭环 + 上述顺序 |
| 认领歧义矩阵 | 退役（对账一一对应，歧义源头消失） | 同上 |
| A1 引用式绑定 | 作废（被 attach 替代） | 同上 |
| B1 回复即认领 + @ 闸码豁免 + 握手（#123 在审） | **关闭不合**（评审同意）。关闭 ≠ 删除线上既有码路径——线上路径按顺序退役 | Frank 点头即关 |
| 待认领 pending 状态机 | 瘦身为 §3.3 事实变量 | 账本上线（M1） |
| 「已暂停」特殊状态 | 合并进 chat **投影**；dormant binding 仍是账本里的封闭持久状态 | 账本上线 |
| 「旧代际只读」 | **待 Frank 拍板**（§8-1），本稿不裁决 | — |
| 等配对@ 状态 | 保留（F5 机制级必要） | — |
| 话题代际轮转 | 保留；切换点已由不变量 6 表达（配对事务接管） | — |
| off-template 诊断 | 语义反转：attach 的正常入口 | — |
| 私聊白名单 | 保留为前提③ | — |
| chat 默认态 / 权限矩阵 / reply_only 边界 | 原样保留（挂载方式第二步推导） | — |
| 现行出站发布器（锁/回执/幂等/卡片） | 原样保留为权威出站 | — |

## 5. 出站双通道分工（固定，不是竞争关系）

| 通道 | 用途 | 寻址 | 格式 | 工程属性 |
|---|---|---|---|---|
| bot 消息接口（权威） | 全通态的一切正式出站：进展卡、回执、建话题、轮转 | om_ 锚 | 卡片/富文本 | 消息 ID 回执、幂等、对账、锁 |
| deliver（辅助） | ①绑定引导回报（attach 结果）②降级态出站 ③私聊异步通知 | session_id | 纯文本 | 仅 accepted，无对账 |

deliver 纪律：调用点只在入站路由器流程内，每条逐字对应一条 owner 入站消息；
测试注入口不打真飞书；投递记录进回执域供 doctor 对账。三类用途各是独立的自动
写入授权对象，逐条要 Frank 点头。

## 6. 后续推导步骤（未开始）

1. 权限矩阵挂载：谁（角色）在哪个投影下能做什么（风险等级）。
2. 绑定唯一性与冲突语义：同项目多话题 attach、与 FR-2.6 多订阅控制面的关系。
3. 命令面整理：`/feishu-projects`、`/feishu-attach` 最终形状
   （feishu-initiated-binding.md 为输入）。
4. 账本的存储与锁协议设计（含归并事务、tombstone/forwarding 的实现协议）。
5. 旧文档订正与飞书版同步。

## 7. 迁移路径

M0 关 #123 → M1 建权威账本 + attach + deliver 回报（运行态=已绑定·降级；现行
机制全程在线）→ M2 F4 历史读就绪：封闭配对协议 + 锚定上线 → M3 按 §4 顺序退役
（负 diff）→ M4 文档收口。步步可逆。

## 8. 拍板项

1. **历史代际能力 —— 已拍板 a（Frank 2026-09-04）**：historical 实体保留现行能力，
   即 B4 = binding=active（能下指令、回复冻结回来源话题），只是不承接常规出站、
   不计数、不参与轮转。§3.3 族表 B4 行按此定稿（active，不改 dormant）；B4 的
   unbind 与其余已绑定态一致（A2/A3/B3 那笔 unbind 事务覆盖 B4，退回 chat/dormant）。
2. **#123 关闭 —— 已拍板关（Frank 2026-09-04）**：目标架构即将退役 bearer 捷径，
   评审同意无必要合入；关闭 ≠ 删除线上既有码路径（线上按 §4 顺序退役）。
3. 同项目多话题 attach 冲突语义 —— **已拍板拒绝**（Frank 2026-09-04「按推荐」）：
   bound 上下文的 attach 一律拒，回执说明已绑定；不换绑、不并存。
4. deliver 三类用途授权：Frank 已确认 **① attach 回报** 的设计方向（2026-09-04）；
   **真正上线仍走 `--apply` 安装闸**（指向具体 PR+HEAD），届时对封闭对象单独确认
   ——现在无 deliver 代码在跑，方向获批不产生任何即时自动写入。②③ 未授权。
5. F4 读权限：**已定走 user 身份**（Frank 2026-09-04），user token 权限已齐
   （`im:message.group_msg:get_as_user`，实测通）；bot 变体读群历史 230027 待查
   数据范围，非阻塞，M2 前可选补齐。**运维约束**：user token 定期过期
   （refresh 约 7 天到期需重新授权），M2 加到期提醒。
