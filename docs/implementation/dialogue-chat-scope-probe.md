# Dialogue Chat Scope Probe（Slice B2a）

状态：候选实现位于 `feat/dialogue-chat-scope-probe`。默认随 B1 shadow 开关关闭，未安装、未把
`AILY_CLI_CHANNEL_*` 提升为可信 locator，也未切换权威路由。

## 1. 为什么先做探针

Slice B 的权威多订阅路由需要可信 `chat_id`。Aily CLI 0.1.44 的运行环境已经观测到
`AILY_CLI_CHANNEL_CHAT_ID` 与 `AILY_CLI_CHANNEL_THREAD_ID`，但当前公开 CLI 契约没有说明它们的来源、
稳定性和权限边界。仅凭“变量存在”设置 `verified=true` 会把未经证明的诊断字段升级为授权事实。

本切片先收集最小、不可逆的一致性证据：真实 Aily 回合中 channel chat locator 是否存在，以及它与当前
精确 binding 的授权快照是否一致。只有经过真实样本验证并另行形成信任决策，后续切片才可以实现
canonical chat scope promotion。

## 2. Artifact

公共 schema：`references/dialogue-chat-scope-probe-v1.schema.json`。

每条 probe 只包含：

- opaque `probe_id`、`event_ref`、`binding_ref` 与 authorization snapshot id；
- `canonical_verified`；
- `chat_locator_present`；
- `chat_scope_match`（locator 缺失时为 `null`）；
- `thread_locator_present`。

原始 chat/thread locator、sender、transport open id、binding key、Claude session、Codex thread 和项目路径
均不进入 artifact 或文件名。`probe_id` 对上述布尔内容寻址，证据被改写后校验失败。

## 3. 写入与隔离

探针复用 B1 的显式开关：

```text
FEISHU_DIALOGUE_AUTHORIZATION_SHADOW=1
```

Git 外位置：

```text
Claude: <project>/.runtime-data/inbound/dialogue-planner-shadow/scope-probes/
Codex:  <bridge-home>/tasks/<logical-task>/inbound/dialogue-planner-shadow/scope-probes/
```

同一 snapshot/event/布尔结果幂等写入同一个文件。探针构造、读取、校验或写入失败只在 B1 返回值中保留
诊断；authorization shadow 仍继续，legacy verdict、claim、dispatch 和用户回执不变。

## 4. 明确不代表什么

- `chat_scope_match=true` 只表示一次运行期观测与已知 binding scope 一致，不证明 Aily 字段来源已受信；
- 探针不会修改 Canonical Event，dispatcher 仍固定产生 `verified=false`；
- 一批全为 match 的样本不能单独满足“真实 shadow 一致性”切流门禁；
- artifact 含不可逆本机标识，仍不得视为可公开发布数据。

## 5. 后续门禁

提升到可信 chat scope 前至少需要：

1. Claude/Codex 两端真实 Aily mention 样本均稳定出现 chat locator；
2. 同一 binding 跨多轮、轮转前后均与授权快照一致；
3. 错配、缺失和并发样本保持 fail-closed；
4. 明确 Aily runtime 的字段注入来源，或用本地受控 session→scope attestation 进行独立交叉验证；
5. promotion 代码使用新的显式开关和回滚路径，不能复用探针开关直接切权威路由。

本地测试只证明 artifact、脱敏、幂等和旁路隔离，不替代上述真实链路证据。
