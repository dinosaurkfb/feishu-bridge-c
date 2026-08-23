# Dialogue Shadow Readiness Audit（Slice B2b）

状态：只读候选。它消费 B1 authorization shadow 与 B2a chat-scope probe，输出脱敏汇总；不修改
sidecar、Canonical Event、binding、claim、policy 或路由，也不 dispatch Agent。

## 1. 解决的问题

B1/B2a 的真实证据分散在 Git 外目录里。人工直接查看 JSON 会暴露 opaque 标识、遗漏损坏文件或把
“chat scope 一致”误读成“已经可以切权威路由”。本切片提供统一验证器和只读 CLI：

```bash
node scripts/dialogue-shadow-audit.mjs --shadow-dir /absolute/private/shadow/root
node scripts/dialogue-shadow-audit.mjs --shadow-dir /one --shadow-dir /two --json
```

stdout 只包含计数、固定检查名、受控原因桶与决策；不会回显输入目录、文件名、artifact id、binding ref、
session/thread/chat locator、sender 或项目名。

## 2. 自动检查

- 三类 artifact 自身校验与 JSON 可读性；
- authorization snapshot、event comparison、scope probe 的一对一关联；
- chat locator presence、chat scope 一致性和 canonical verified 状态；
- legacy/candidate route match 与 full match；
- 重复 ID、孤立 event/probe 与缺失 authorization。

若证据损坏，决策为 `invalid_evidence`；没有样本为 `insufficient_evidence`；任一自动检查失败为
`not_ready`。即使全部通过，最高也只能返回 `manual_review_required`。

## 3. 不能自动证明的门禁

当前脱敏 artifact 不携带 runtime 或 channel generation，因此报告固定保留四个未核验人工门禁：

1. `trusted_locator_source`：Aily locator 的可信注入来源或独立本地 attestation；
2. `both_runtime_coverage`：Claude 与 Codex 两端都有真实样本；
3. `generation_rotation_coverage`：同一 binding 在轮转前后持续一致；
4. `rollback_rehearsal`：灰度切流可以恢复 legacy 精确 binding 且不重放。

报告不能授权安装、设置 `verified=true`、切换权威路由或开启 Agent Relay。真实写入与切流仍需独立
评审、门禁证据和 Frank 的逐次授权。

`feat/dialogue-chat-scope-attestation-shadow`（[`dialogue-chat-scope-attestation-shadow.md`](
dialogue-chat-scope-attestation-shadow.md)）在纯 shadow 范围内对单个 binding 的 B2a 证据做进一步
聚合判定，为 `generation_rotation_coverage` 之外的跨 revision 一致性提供更严格的候选信号；它不读取
或写入本模块的证据目录，也不改变本报告的任何自动检查或人工门禁。

## 4. 证据层级与回滚

本地合成测试只能证明汇总、关联、脱敏与 fail-closed 语义。真实 readiness 必须在 B1/B2a 已显式开启的
机器上，用新的真实 mention 产生 sidecar 后运行。回滚只需移除本模块、CLI、schema 与文档；运行时热
路径和既有 sidecar 未被改写。
