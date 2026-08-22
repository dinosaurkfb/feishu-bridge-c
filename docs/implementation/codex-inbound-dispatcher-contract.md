# Codex 入站 Dispatcher 契约接入

状态：候选实现完成，尚未正式安装或进行真实飞书链路验收。

对应分支：`feat/codex-inbound-dispatcher-contract`。

## 1. 交付范围

本切片落实架构契约 INV-3，并完成分支交付表中“Codex dispatcher 契约接入”一项：

- Claude 与 Codex 使用同一个确定性 dispatcher 核心；
- dispatcher 对一次 Aily 回合只获取一次原始事件信封；
- 信封被规范化为版本化 Canonical Event v1；
- 被选中的原始 Aily envelope 以无损、瞬态字段随 Canonical Event 传给 handler；
- Claude/Codex 各自保留薄 endpoint wrapper 和原有业务 handler；
- handler 通过兼容适配视图继续运行现有 selector、binding、claim 和 runtime 投递逻辑；
- handler 的用户可见 stdout 与退出状态仍由 dispatcher 原样透传；
- caller 不匹配、无路由、handler 缺失、启动失败和超时保持可区分的拒绝原因。

明确不包含：新的交互模式、`$feishu-mode` 等控制命令、Subscription 写 API、现有 mapping 切流、
真实飞书写入、全局 hooks/skills 安装或历史消息重放。

## 2. 运行边界

```text
Claude UserPromptSubmit hook
  -> scripts/aily-inbound.mjs              （Claude endpoint wrapper）
       -> scripts/inbound-dispatcher.mjs   （共享 dispatcher）
            -> scripts/inbound.mjs         （Claude handler）

Codex UserPromptSubmit hook
  -> scripts/codex/aily-inbound.mjs        （Codex endpoint wrapper）
       -> scripts/inbound-dispatcher.mjs   （共享 dispatcher）
            -> scripts/codex/inbound.mjs   （Codex handler）
```

Hook 不取信封、不选业务 handler。两个 wrapper 只提供 endpoint identity、默认 handler、路由表和
Git 外日志路径。共享 dispatcher 只负责 endpoint 校验、一次取信封、Canonical Event 构造和
`session -> handler owner` 选路；它不理解 Subscription、Domain、sender 权限、binding 或 policy。

## 3. Canonical Event v1

版本化 schema 位于 `references/canonical-event-v1.schema.json`，运行时构造和校验位于
`scripts/canonical-event.mjs`。

当前稳定规范字段包括事件 ID、时间、endpoint、Aily session、actor、结构化 mention、正文和来源。
`raw_envelope.payload` 保存 dispatcher 选中的完整 Aily envelope，包含未知字段且保持原 payload 是
字符串还是对象的原始形状。该字段只通过子进程环境在当前调用链瞬态传递，不写入普通日志、回执或 Git。

诊断环境中观察到的 `AILY_CLI_CHANNEL_CHAT_ID` 与 `AILY_CLI_CHANNEL_THREAD_ID` 目前只进入
`extensions.aily_channel`，并固定标记 `verified: false`。它们不会进入 `source.chat_id/topic_id`，
也不能被 selector 当作路由或授权事实。

现有 handler 暂时通过 `legacyEventFromCanonical()` 取得原事件视图。这样可以先统一运输契约，后续
`refactor/mapping-policy-handler` 再让公共 ingress kernel 直接消费 Canonical Event，避免在一个 PR
同时改变运输、权限和业务路由。

## 4. 迁移与兼容

本切片不写新 registry，不迁移现有 topic/session/thread 映射，也不改变首次认领或已绑定日常消息的
业务 selector。路由表不存在时，两端分别回退到自己原有 handler；存在 session owner 登记时仍精确
选中唯一 owner。

迁移期 dispatcher 同时写 `FEISHU_BRIDGE_CANONICAL_EVENT` 和旧的 `FEISHU_BRIDGE_ENVELOPE`：
新 handler 优先读取无损 Canonical Event，真正实现旧继承契约的 handler 读取同一次 fetch 的旧事件
视图。dispatcher 在启动 handler 前移除 `AILY_CLI_SESSION_ID` 与 `AILY_CLI_RUN_ID`，因此不理解任一
继承契约的 handler 会明确失败，不能静默重新访问 Aily 或制造第二事实源。

cc2cd 当前的 `c2c-envelope.mjs` 不读取 Canonical Event，也不读取旧继承变量。它在迁移到上述任一
契约前不得注册为本 dispatcher 的 route；若误注册，会因缺少 Aily session fail-closed，而不是二次
取信封后看似成功。

handler 正常路径必须完成校验、claim 和非阻塞投递后秒级返回。默认 `30s` timeout 只是异常进程的
最终兜底，不是 handler 可以占用的响应预算；同步等待长期任务完成的实现不符合本契约。

合并代码不等于完成安装。正式安装前必须单独确认，并先保证已安装 hooks 指向的仓库 checkout 保持在
已验收的 `main`，候选分支应在独立 worktree 中开发和测试。

## 5. 回滚

回滚时把两端 hook/skill 入口恢复为各自原有 handler，并移除两个 endpoint wrapper、共享 dispatcher、
Canonical Event 模块及 schema 即可。因为本切片没有改写 registry、binding、claim、outbox 或话题，
不需要数据恢复，也不得自动重放失败或历史消息。

回滚后的旧 handler 仍可自己向 Aily 取信封；在新 dispatcher 下则必须消费 Canonical Event 或旧
`FEISHU_BRIDGE_ENVELOPE`，不得自行重取。旧读取兼容入口仍保留，因此回滚不会要求重建话题或重新绑定。

## 6. 验证证据

本地自动化覆盖：

- 原始 Aily envelope 未知字段与 payload 原始形状无损保留；
- 未验证 channel 变量不会升级为可信 locator；
- Canonical Event schema 边界拒绝缺失必填字段；
- handler 继承 Canonical Event 后不会再次访问 Aily；
- dispatcher 对每轮只调用一次 fetcher；
- dispatcher 双写迁移事件并剥离 child 的 Aily session/run，阻止不兼容 handler 静默重取；
- caller 不匹配时在读取 Aily 前拒绝；
- handler stdout 直通，超时与启动失败可区分；
- Codex hook 和技能都指向 Codex dispatcher wrapper；
- Claude/Codex 原有回归与公共导出面快照保持通过。

当前证据层级：本地合成/集成测试，Claude `308` 项、Codex `68` 项、公共 contract 通过。
这些结果不替代真实 mention、秒级受理、精确 task 续接、严格终局和原话题回写验收。
