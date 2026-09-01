# 票 #6 断点留档（2026-08-31，上下文将满，自动压缩连续两次失败）

读者是**全新会话的我**。仓库 `/Users/dk/claude-projects/feishu-bridge-pi-qwen`，分支 `pi-qwen/p2p-chat`，
基线 `09fe7c4`（origin/main）。已提交并推送 WIP：`466e260`。**未开 PR、未 merge、未 --apply。**
`PI-TASK.md` 保持未跟踪。

## 现在的确切状态：套件红 5 条（`node scripts/test.mjs` → 通过 733 / 失败 5；上一轮是 6，shared-surface 快照已 --update 掉一条）

```bash
cd /Users/dk/claude-projects/feishu-bridge-pi-qwen
node scripts/test.mjs            # 支持 TEST_FILTER=<测试名子串> 定向跑，TEST_TRACE=1 打完整栈
```

## 已确认的结论（都带 file:line，别再重查）

**A：入站里没有可信的 `chat_type`，所以私聊只能反推。**
- 事件视图只有五个字段 `message_id / session_id / sender_id / created_at_ms / content`（`scripts/envelope.mjs` 的 `attemptFetch`）。
- Canonical v1 的 `source.chat_id` 恒为 `null`；`AILY_CLI_CHANNEL_CHAT_ID` 带 `verified:false`，源码注释写着「selector 不能把它们当作授权或路由事实」（`scripts/canonical-event.mjs:107-115`）。probe 文档：`docs/implementation/dialogue-chat-scope-probe.md`。
- 分发层文档事实：「把智能体拉进群、在群里 @ 它**或私聊它**，平台投 `im.message.receive`」，同一行还写着「**不核对群 id**（envelope 的 chat_id 仍标未核验）」（`docs/architecture/layers-modes-permissions.md:20`）。
- ⇒ 采用的判据：**整条消息没有任何 `<at>` mention = 私聊形状**（`isP2pMessage`，用 `scripts/selector.mjs:36 extractMentionIds`）。有 mention 就不算私聊，群闸一个不变。代价如实记：手打的 `@名字`（无标签）也算零 mention。
- 线上 P2P 的两条拒绝都来自 @ 闸（回执只有 `rejected · transport_not_mentioned` 两行，`outbound.mjs:130` 的「（未认领。原因：…）」是**已绑定**分支才加）：`scripts/inbound-route.mjs:237`（promotion）与 `:380`（chat 闸）。两条链路共用这两个函数：`scripts/inbound.mjs:206-208,212`、`scripts/codex/inbound.mjs:287`。

**B：`turn_record_not_found` 才是「没有成对输入」。**
- `scripts/turn-input.mjs:101-107` 四态分明：`not_found / unreadable / invalid_cache / consumed`。
- `scripts/init-hook.mjs:91-97`：飞书戳的回合写不下来源记录就 `exit 2` 不让跑 ⇒ 能跑到 Stop 的 `not_found` 只可能是本地会话自己起的一轮。
- `consumed` 单独保留拒发（`:139-151` 说明「同一轮重入」），未动。
- `scripts/stop-hook.mjs:303` 注释早就写着「不写输入块 = 单独一行答复」⇒ 答复单发是既有渲染形状，不用改 outbox。
- 未配对答复没有 eventKey（claimKey/captureId 都不存在）⇒ 走 `outbox.mjs:71-75` 内容指纹去重，同一轮 Stop 重入不会重复发；`targetGenerationId` 取 `bound.mapping.channel_generation_id`（当前代际，与既有「发当前代际」路径同一条表达式）。

## 已改完的代码（在 `466e260` 里）
- `scripts/inbound-route.mjs`：新增 `PROMOTE_REJECT.P2P_NO_MENTION`（值 `p2p_no_mention`）+ `PROMOTE_REJECT_TEXT` 文案 + `export function isP2pMessage(event)`（放 `PENDING_WINDOW_MS` 之后，注释含全部 file:line 依据）；`evaluatePromotion` 在 @ 闸之前插 P2P 早退；`CHAT_FALLBACK_REASONS` 加入 `P2P_NO_MENTION`；`evaluateChatGates` 的 @ 闸改成 `if (!isP2pMessage(event) && !extractMentionIds(...).includes(transport))`。
- `scripts/stop-hook.mjs`：`record.reason === "not_found"` ⇒ `turnRoute = { ok: true, kind: "unpaired" }`，其余三种照旧 `turn_record_*` 零入队 + 诊断。
- `references/shared-surface.json`：`--update`（只多一个 `isP2pMessage` 导出，两条链路共用，是有意的）。
- `scripts/test.mjs`：改写 `:5207` 那条旧测试 + 新增 `:5227` 「私聊（P2P）不进认领评估…」gate 级测试。**尚未加真入口测试。**

## 5 条红：逐条该怎么收（下一步计划）

1. `test.mjs:5214`（我新写的）：`"@T 干活"` 期望 `transport_not_mentioned`，实际 `p2p_no_mention`。⇒ **我的断言错了**：手打 @ 无标签 = 零 mention = 私聊形状。把 `"@T 干活"` 从「有 mention」那组挪到「零 mention」那组，文案里点明这个取舍。
2. `test.mjs:5252`（我新写的）：私聊 + 旧消息，期望 `stale_message`，实际 `p2p_no_mention`。原因是 `evaluatePromotion` 顺序：模板 → sender → **P2P** → @ → 新鲜度（`:233-245`）。⇒ **建议把 P2P 早退挪到新鲜度判定之后**（防重放是更基本的性质，旧消息连形状都不该参与判定；chat 侧 `:382-384` 本来就 P2P 让路在 @ 闸、但新鲜度在后，两条一致）。改完这条断言即绿，别反过来弱化测试。
3. `test.mjs:18031`：`assert.equal(replies().length, 2, "没有缓存的用户输入时仍零入队（不重复投递，也不单发答复）")` + `:18032` 诊断断言。⇒ **这是要改掉旧行为的断言**，按 Frank 批准的例外改成：`replies().length === 3`、卡片含答复正文、**不含**「本轮用户输入」块、`target_generation` 为当前代际 `gen_active`、`diags()` 不再新增。同步改标题与 `:18029` 上方注释（`scripts/test.mjs:18006-18032` 那段说明写的是旧合同）。
4. `test.mjs:18176`（Dialogue 模式那条）：`AssertionError: 策略状态无效、又没有本轮来源记录 → 零入队`。⇒ **别急着改断言，先读上下文** `scripts/test.mjs:18127-18180`：这条是「control 策略不可读 + 本轮无来源记录」。要判的是：策略说不清时，是否允许一个未配对 Stop 发出去。我倾向**继续零入队**（策略说不清 = 连"该不该转发"都没依据），若如此，修法是在 stop-hook 把「策略无效」也挡在 unpaired 之前（`policyCheck.state !== "ok"` 时不走 unpaired），并在测试标题里写明这是例外 1 的边界。⚠ 这是唯一一处规格没覆盖的判断，改完要在 PI-REPORT 里写清选择与理由。
5. `test.mjs:20047`：`evaluateChatGates(ev("333","hi 没有 @")).reason === "transport_not_mentioned"`。⇒ 这是**规格明令不许变**的那条（participant 在没 @ 本链路的消息里仍被拒）。它现在红是因为该 fixture 的 content 零 mention ⇒ 落进私聊分支。修法：把 fixture 内容改成**带别人的 `<at>`**（`<at id="ou_other">别人</at> hi`），保持"participant 被 @ 闸挡住"的原意；不许把断言改成 ok。

## 还欠的交付
- A 真入口测试：Claude 链（可仿 `test.mjs:20028` 那条 `run()`，加 `mention:false` 参数造无 @ 信封）+ Codex 链（`scripts/codex/test.mjs:9295` 的 `run`）。要断言：未绑定项目带着 pending 也不被私聊绑上（registry 里 `inbound_state` 仍是 pending、`session_id` 仍空）+ 走 chat 零工具回答；群路径回归（@ 运输 agent 才 promotion、@ 别人仍拒）。
- B 回归：`unreadable` / `invalid_cache` / `consumed` / claim 三态 / `origin_unresolvable` 仍零入队（现有一部分覆盖，缺 `unreadable`、`invalid_cache` 与「不污染后续本地回合」）。
- Codex 链：`scripts/codex/test.mjs` 加至少一条（两条链路共用 `evaluatePromotion`/`evaluateChatGates`/`CHAT_FALLBACK_REASONS`，所以共用测试本身已覆盖判据；入口各一条最省）。
- 收尾门禁：`node scripts/test.mjs` 全绿、`node scripts/codex/test.mjs` 全绿、`node scripts/shared-surface.mjs` 一致、`git diff --check` 干净；commit message 中文、结尾 `Co-Authored-By: pi <noreply@pi.dev>`；push；**不开 PR**（评审交 Codex）。
- 真实机器验证只能证明「P2P 消息没有任何 `<at>` mention」；`isP2pMessage` 的可靠性最终要靠 Frank 在真机发一条私聊再跑 `node scripts/layered-status.mjs --json` 看 chat 计数。报告里如实写这点。
