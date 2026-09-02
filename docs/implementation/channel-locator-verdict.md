# chat locator 验证结论（2026-09-02 真机对照实验）

- `status`: verified-initial（初步结论；样本量与时间跨度的边界见 §4）
- 实验：PR #117 采样旁路（main c4ba44d，运行时 a7c2f0a965e975a9）+ Frank 四场景两轮发消息
  + lark-cli 消息实体对照。样本文件：`~/.claude/feishu-bridge/inbound/channel-samples.jsonl`
  （只存哈希指纹）。

## 1. 实验数据

两轮 × 三场景，指纹**逐字节复现**：

| 场景 | chat_sha16 | thread_sha16 | matches_template_chat | disposition |
|---|---|---|---|---|
| 绑定话题（两条） | 3e80dbf3… | 2c4cee25… | **true** | accepted |
| 私聊（两条） | 7051bd34… | **缺失** | false | rejected:transport_not_mentioned |
| 其他话题 @（两条） | 639b97f4… | de76cc0e… | false | chat |

对照项：本话题根消息经 `lark-cli im +messages-mget` 取出的真实 `thread_id`（omt_ 形态）
sha16 = `677d924d…`。

## 2. 结论

1. **`AILY_CLI_CHANNEL_CHAT_ID` 就是飞书 chat_id，可信**：
   - 与模板 `oc_` **逐字相等**（matches_template_chat=true 是代码级字符串比较）；
   - 三场景三值、两轮逐字节稳定、彼此可区分。
   - → 可从「诊断 hint」升级为路由判据（附 §4 边界与 fail-safe 要求）。
2. **`AILY_CLI_CHANNEL_THREAD_ID` 不是飞书 thread_id**：
   - 稳定、可区分（同话题两轮同值），但哈希与真实 omt_ 不符——它是 **Aily 命名空间
     的 thread 标识**（与「入站校验走 Aily 命名空间」的既有记录一致）。
   - → 不能用于飞书 API 寻址；作为「同话题归属」的相对判据仍可用（同值 = 同话题）。
3. **私聊有结构性签名**：chat 有值且 ≠ 模板 **且 thread 缺失**（私聊无话题结构；
   外部群话题的 thread 有值，不会命中）。
4. **私聊出站可达**：`lark-cli im +messages-send` 支持 `--chat-id`——私聊 chat_id 可信后，
   判定 + 回复的全链路都不依赖 thread。
5. **方式 1b（任意话题 @ 绑定）仍不通**：飞书 omt_ 可以从消息实体反查、`thread → 根消息 →
   +messages-reply` 两跳可回话题，但**入站拿不到 omt_**（Aily 给的是自家命名空间标识）——
   链路断在「入站 → 飞书 locator」。除非平台侧确认 Aily 可提供 omt_ 或映射 API。

## 3. 解锁的工作

- **私聊开通（#111 A 项重开）**：实验事实保持不变（§2 采样）；生产判据（#R11 起，
  PR #120 评审拍板 b 选项）是 **chat_id 逐字命中已验证白名单** `verified_p2p_chat_ids`
  （`register-p2p-chat.mjs` 登记，每次 `--add` 都是 owner 对「已线下验证为私聊」的信任声明），
  thread 缺失仅为纵深防御；回复经 +messages-send --chat-id。本文档是采样证据，
  白名单登记表是生产事实。
  > #R12 修订：本文 §3 早期写法「chat_id ≠ 模板 && thread 缺失 → 私聊」只是
  > 采样期的判据草案，生产未采用（结构性条件可被新私聊/群变体骗过）；
  > 实现按白名单正向命中落地，本节已按现状改写。
- **FR-2.6 切流前置之一达成**（chat locator 可信）；另一前置（第二真实群样本）待定。
- Topic Quick-Bind 路径 A/B 不受影响照拆单；1b 维持挂起并引用本文档 §2-5。

## 4. 边界（诚实声明）

- 样本量：每场景 n=2、单日、单机、单账号；「稳定」是初步结论，不是长期保证
  （Aily/飞书版本升级后的行为未验）。
- 因此判据升级的实现要求保留 **fail-safe**：判据要素缺失或形态异常时回落现行为
  （拒绝 + 诊断 hint），不盲信；采样旁路保留一段时间持续积累样本，直到跨版本复验后
  再摘除（摘除时同步撤本文档的 initial 标记）。
- 私聊 chat_id（7051bd34…）按账号对稳定；不同用户私聊各有 chat_id——**实验上形状与
  具体值稳定，但生产策略不依赖这个形状结论**：每个 chat_id 需先线下验证为私聊再
  逐字登记进白名单（`verified_p2p_chat_ids`），未登记的私聊按群处理（fail-safe）；
  thread 仅作纵深防御（#R11/#R12）。
  > #R12 修订：本文 §4 早期写法「判据不依赖具体值，只依赖 ≠ 模板 && thread 缺失
  > 的形状」随生产判据改白名单后失效，保留的是实验事实，不是生产依据。
