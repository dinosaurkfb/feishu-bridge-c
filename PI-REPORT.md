# 票 #6 交付：私聊不再当「@ 没打」；未配对的一轮把答复单发

分支 `pi-qwen/p2p-chat`（基线 origin/main `09fe7c4`）。**未开 PR、未 merge、未 --apply、未碰真运行时。**

## 结论先说

线上两个现象都修了，两套全量套件全绿：

- Claude：`通过 739 / 失败 0`
- Codex：`Codex adapter 通过 269 / 失败 0`
- `node scripts/shared-surface.mjs` → 与快照一致（多了一个导出 `isP2pMessage`，两条链共用，已 `--update`）
- `node scripts/install-outbound.mjs` → dry-run，什么都没写
- `git diff --check` → 干净

改动落在**两条链共用的判据层**，所以 Claude / Codex 一次同时生效。

## A：私聊不再走认领评估

**没有编造 `chat_type`。** 入站事件里压根没有这个字段，依据：

- 事件视图只有五个字段 `message_id / session_id / sender_id / created_at_ms / content`（`scripts/envelope.mjs` 的 `attemptFetch`）
- Canonical v1 的 `source.chat_id` 恒为 `null`；`AILY_CLI_CHANNEL_CHAT_ID` 带 `verified:false`，源码注释明写「selector 不能把它们当作授权或路由事实」（`scripts/canonical-event.mjs:107-115`）；要不要提升它们是 `docs/implementation/dialogue-chat-scope-probe.md` 在收的证据，还没定论
- 分发层文档事实：「把智能体拉进群、在群里 @ 它**或私聊它**，平台投 `im.message.receive`」，同一行还写着「**不核对群 id**（envelope 的 chat_id 仍标未核验）」（`docs/architecture/layers-modes-permissions.md:20`）

**采用的判据**：整条消息**没有任何 `<at>` mention** = 私聊形状。群消息要 @ 才投得过来，所以零 mention 还能到本链路的只剩私聊。

实现（`scripts/inbound-route.mjs`）：

- 新增 `export function isP2pMessage(event)`（注释里带上面全部 file:line 依据）
- 新增 `PROMOTE_REJECT.P2P_NO_MENTION = "p2p_no_mention"` + 回执文案
- `evaluatePromotion`：模板 → 发送者 → **新鲜度** → 私聊 → @ 闸。私聊在 @ 闸之前早退，防重放仍排在形状判定之前
- `CHAT_FALLBACK_REASONS` 加入 `p2p_no_mention` → 私聊落进 chat 默认态重判
- `evaluateChatGates`：@ 闸只对「有 mention 的」生效（`!isP2pMessage(event) && !mentions(transport)`）

**群行为一个不变**：只要消息里出现了 mention，仍然必须 @ 到本链路运输 agent，否则照旧 `transport_not_mentioned`，且它**不**进 chat 兜底。未登记发送者、超龄消息照旧拒（角色表、新鲜度都排在形状判定之前）。

**如实记下的取舍**：判据靠的是 mention 结构，不是会话类型。所以群里一条完全没打 @ 的消息（按文档它本来投不过来）如果哪天真投过来了，会被当私聊形状落到 chat —— 仍然是三道闸 + 零工具，拿不到绑定能力，不会绑错位。另一个已知边角：手打的 `@名字`（无标签）算零 mention，同样落 chat。

## B：未配对的一轮把答复单发

`scripts/stop-hook.mjs`：`readTurnRecord` 返回 `not_found` ⇒ `turnRoute = { ok: true, kind: "unpaired" }` —— 入队一条**不带用户输入块**的答复，目标取当前代际（没有冻结 origin 可取），不留 `unrouted-replies` 诊断，不消费任何记录。

`unreadable` / `invalid_cache` / `consumed` 以及 claim 三态、`origin_unresolvable` **照旧零入队 + 留诊断**。理由是有不变量兜着：`scripts/init-hook.mjs:91-97` 对每个获准执行的 prompt 都必须写下自己的来源，飞书回合写不下就 `exit 2` 不让跑 —— 能跑到 Stop 的 `not_found` 只可能是本地会话自己起的一轮；而「写得出读不回」那几种可能正藏着一个飞书回合的来源，退回当前代际等于发错话题。

**规格没覆盖、我做了判断的一处**：Dialogue 模式下策略状态（interaction policy）读不出或不合法时，"这一轮是不是飞书驱动的"本身就说不清。这时 `not_found` **不许**当成未配对单发 —— `stop-hook.mjs:222-224` 加了 `policy_state_unreadable` 分支退回零入队 + 留诊断。对应测试：`scripts/test.mjs:18203`（断言消息已改写成「说不清就不许单发」，仍要求零入队 + 留下那一份诊断）。

未配对答复没有 eventKey（既无 claimKey 也无 captureId），走 `outbox.mjs:71-75` 的内容指纹判重 ⇒ 同一轮 Stop 重入不会重复发；代价是两轮内容完全相同的未配对答复只会发一条，这点和旧的本地无键入队行为一致。

## 测试（都是行为断言，不是形状断言）

`scripts/test.mjs`：

1. `:5208` 改写：`<at id="ou_other">` 有 mention 却没 @ 本链路 → `transport_not_mentioned` 且不进 chat 兜底；零 mention 的三种写法 → `p2p_no_mention`
2. `:5229` 新增 gate 级：`isP2pMessage` 四种输入逐一钉住；带 pending、正文里写满绑定码 + 引用块 → 仍不绑（`r.ok === false`、`r.id` 为空）；同一 pending 带上真实 @ 仍能认（群路径回归）；未登记 / 超龄排在形状之前；chat 三道闸在私聊下 role 判对、未登记仍拒、超龄仍拒、@ 别人仍拒
3. `:20055` 那条真入口测试尾部（`:20541` 起）追加（Claude 链）：登记表里放着 `inbound_state: "pending"` + `pending_token: "abc123"`，私聊发「接入项目 abc123」→ stdout 是 chat 回答、`mode: "chat"`、零工具参数，**registry 里那条仍是 pending、session_id 仍为空**；群里 @ 别人 → `已拒绝 … 没有真实 @ 本链路的运输 agent` 且不起模型；未登记的私聊 → 零权限、不起模型
4. :17970` 改掉旧断言 + 扩充：`not_found` → 入队 1 条、目标为当前代际、卡片 `input_text === null`、诊断条数不变；紧接着的正常本地回合仍成对发出；`consumed` 重入零入队且不冒充诊断；`invalid_cache` 零入队并留 `turn_record_invalid_cache`；`unreadable` 零入队

`scripts/codex/test.mjs`：`:9313` 起加真入口两条 —— Codex 链的零 mention 私聊落 chat（`回答：在吗\n— chat`）、未登记的私聊仍零权限；并把一处绝对起模型次数改成与新基线对齐。

## 只能真机再确认的一件事

`isP2pMessage` 的前提是「群消息没有 @ 就不会投给 agent」。这条写在文档里、也符合线上现象（真机私聊的 envelope 里确实没有 `<at>`，所以才会报 `transport_not_mentioned`），但我没有平台侧的投递日志可查。请 Frank 在真机私聊发一句「在吗」，然后跑 `node scripts/layered-status.mjs --json` 看 chat 计数是否 +1、话题里是否收到单发答复；这条一旦不符，判据要换成平台侧 chat_type（那需要 envelope 先带上来）。
