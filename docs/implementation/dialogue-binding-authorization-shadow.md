# Dialogue Binding Authorization Shadow（Slice B1）

状态：已由 PR #15 合并 `main`，默认关闭、未安装、未切换权威路由，也不会 dispatch 第二个 Agent。
后续 Slice B2a 在同一 Git 外 sidecar 增加脱敏 chat scope probe，但不会提升 canonical trust。

## 1. 目标与边界

本切片把现有 Claude/Codex 精确 binding 的授权事实只读投影为同一份 versioned artifact，并在每条
已绑定入站消息上同时计算 legacy 授权结果与 candidate 授权结果。它只回答：

> 当前 endpoint 收到的这一事件，是否被当前 subscription 与精确 binding 授权进入这个 opaque
> local target？

它不负责首次话题认领、claim、内容策略、Dialogue planner、runtime dispatch、出站发布或多订阅写入。
现有 `session_id -> exact binding` 仍是唯一承重路径，旧 selector 的最终 verdict 仍决定真实回合。

## 2. 公共 artifact

- `references/dialogue-binding-authorization-v1.schema.json`：单条 binding 的 materialized authorization
  snapshot；
- `references/dialogue-bound-authorization-shadow-v1.schema.json`：单事件 legacy/candidate 对照证据；
- `scripts/dialogue-binding-authorization.mjs`：纯投影、opaque ref、校验、候选授权与比较；
- `scripts/dialogue-authorization-shadow-store.mjs`：独立 Git 外 sidecar 的原子单文件写入。

快照只包含 `subscription_id`、`binding_ref`、`local_target_id`、participant ref、chat scope ref、状态、
版本和约束。私有 binding key、chat id、sender id、transport open id、Claude session、Codex thread 和项目
路径只在 adapter 内存中用于派生，不进入 artifact 或文件名。

授权内容不变时重复同步返回原快照；subscription/binding 状态或约束变化时 revision 单调增加并生成新
snapshot id。暂停 subscription 或 binding 会物化为 `paused`，candidate 随即 fail-closed。

## 3. 已绑定消息的授权语义

legacy selector 的最终 verdict 同时混有两类结论：

1. binding/session/sender/mention/时效授权失败；
2. 已通过授权后的内容或处置结果，例如空正文、前缀不匹配、幂等命中和配额耗尽。

Slice B1 只比较第一类。第二类即使最终不 dispatch，也记为 legacy authorization accepted；否则一条正常
的首次空 mention 会被错误解释为“binding 未授权”。内容策略仍由原 selector/Mapping/Dialogue policy
处理，不被本切片改写。

candidate 必须同时满足：

- snapshot、subscription、binding 均有效且 active；
- endpoint、event type、授权人类 participant 和真实 mention 一致；
- 事件处于 freshness window；
- expected binding ref 与快照严格一致；
- canonical event 的 chat locator 来自可信提升，并与 snapshot 的 opaque chat scope 相同。

## 4. 可信 chat scope 门禁

现行 Aily dispatcher 仍生成 `extensions.aily_channel.verified=false`，所以当前真实事件的 candidate 会明确
返回 `chat_scope_unverified`。这正是切流门禁，而不是可忽略的告警。

Canonical Event v1 现在允许未来的 `verified=true` 形状，但运行时校验要求：

- `source.chat_id` 为非空字符串；
- `extensions.aily_channel.chat_id` 与 `source.chat_id` 严格相等。

仅设置布尔值、只填其中一处或两处不一致都会使 canonical event 无效。Dispatcher 在可信 locator 来源
完成独立验证以前保持 `false`，不得用环境变量的存在冒充授权事实。

## 5. Sidecar 与 adapter 接入

只有显式设置以下机器环境开关时才运行旁路：

```text
FEISHU_DIALOGUE_AUTHORIZATION_SHADOW=1
```

其他值（包括 `true`）都视为关闭。`--dry-run` 不写 sidecar。

Git 外目录：

```text
Claude: <project>/.runtime-data/inbound/dialogue-planner-shadow/
Codex:  <bridge-home>/tasks/<logical-task>/inbound/dialogue-planner-shadow/

authorizations/<binding_ref>.json
events/<authorization_shadow_id>.json
scope-probes/<chat_scope_probe_id>.json
```

Sidecar 不取得 binding 生命周期锁，不参与 claim 或路由。目录不可写、快照损坏、投影歧义、写入竞争或
其他异常只会丢失本次 shadow 证据；adapter 捕获异常后继续执行原 verdict。该容错是 B1 旁路的明确
边界，不能被解释为授权同步已经达到生产权威级别。

## 6. 切流门禁与回滚

本切片不满足 Slice B 的最终切流条件。后续至少还要完成：

1. 自动 Topic Generation v1 的真实自动触发、失败重试与不重复轮转验收；
2. 可信 chat locator 的来源验证与真实样本；
3. subscription 生命周期与 authorization snapshot 的权威原子同步；
4. legacy/candidate 在已绑定真实样本上持续一致；
5. 单 endpoint/domain 灰度与回滚演练。

其中第 2 项先通过 [Dialogue Chat Scope Probe](dialogue-chat-scope-probe.md) 收集脱敏真实证据；probe
一致不能单独等价于可信来源验证，也不能据此设置 `verified=true`。

回滚 B1 只需关闭环境开关，或移除两条 adapter 的旁路调用；旧 binding、claim、run、outbox、话题和
历史都未被迁移或替换。Git 外 sidecar 可作为审计证据保留，不能重放为真实消息。

## 7. 本地证据

- Claude 公共测试 354/354；
- Codex adapter 测试 80/80；
- 共用面 21 个模块、195 个导出，与快照一致；
- 覆盖 opaque 化、revision 幂等/暂停、chat 未核验拒绝、可信 scope 接受、binding ref 防伪、投影
  歧义 fail-closed、sidecar 重复幂等/I/O 失败隔离、Codex dispatcher 完整握手旁路和默认关闭；
- 未做安装、真实飞书写入、权威切流或第二 Agent dispatch。

这些是本地合成与契约证据，不替代上述真实链路门禁。
