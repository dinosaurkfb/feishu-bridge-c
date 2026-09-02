# FR-2.6 切流验证实验设计（多订阅歧义的真实样本）

- `status`: designed（待 Frank 拍板执行；实验本身不切流，只产生权威证据）
- 前置盘点：chat locator 已验证（channel-locator-verdict.md）；第二真实群已入样
  （chat 指纹 4dd91013…，M5Claude 在群）；register-subscription 已上线（#112）；
  歧义矩阵行为测试已合并（#113）。**唯一缺口**：多订阅下首次认领的
  AMBIGUOUS / 收敛路径从未被真实事件行使过（layers 文档挂起的原话）。

## 实验步骤（全部可逆，不动权威路由）

1. **登记第二条订阅**（owner 授权 `--apply` 一次）：
   `register-subscription.mjs --store <生产路径> --template <Claude chain-config> \
    --runtime claude --domain-key <本项目根> --chat-id <第二群 oc_> --chat-name <群名> --apply`
   ——落盘控制面，**不接权威投影，不影响任何现网行为**（#112 的边界）。
2. **影子对照开启**：入站 shadow（subscription_claim_shadow）已常开——多订阅模型进
   shadow 需要把控制面并进 shadow 的读模型。**这是唯一需要的代码改动**（S 级单）：
   shadowClaudeFirstClaim 的模型构造加 controlPlane（只影响 shadow 字段，权威路径零改动；
   合并 fail-closed 时 shadow 记 control_plane_invalid 不比对）。
3. **真实样本采集**（Frank 各场景 1–2 条）：
   - 第二群里 @M5Claude（存在待认领 binding 时）→ 期望 shadow：chat 证据收敛到第二群
     订阅 → 该订阅无 pending → NO_PENDING_BINDING；
   - 本群（模板群）@ + 绑定码 → 期望 shadow：收敛到模板群订阅、与 legacy 判定一致；
   - 造两份 pending（两群各一）后无码 @ → 期望 shadow：AMBIGUOUS（**核心样本**——
     歧义拒绝首次被真实事件行使）；
   - 带码 @ → 期望 shadow：精确收敛。
4. **对账与结论**：shadow receipt 的 match/route_match/disposition_match 全一致 +
   AMBIGUOUS 真实样本在案 → 写切流评估文档（哪些面可以切、灰度顺序、回退方式），
   交 Frank / Codex 定夺。**切流本体另立项，不在本实验内。**

## 风险与边界

- 步骤 1 的登记随时可 `--remove` 回退；步骤 2 的 shadow 改动不触碰
  selectPendingSubscriptionClaim 的权威调用面（有回归断言）。
- 造 pending 需要 bind 流程配合（第二群建话题）——用项目级第二 binding 或临时项目，
  实验后 unbind 清理；步骤设计确保不留孤儿 binding。
- 样本目标量：AMBIGUOUS ≥2、收敛 ≥2、跨群 ≥2；单日即可完成。

## 拆单

| 单 | 难度 | 内容 |
|---|---|---|
| C1 shadow 接控制面 | S | shadowClaudeFirstClaim 模型构造加 controlPlane + 回归断言（权威面零改动） |
| C2 实验执行手册 | — | 本文档 §3 步骤逐条执行（主会话 + Frank 配合），产出切流评估文档 |
