# ADR-0001：Codex 账簿只认家目录下的 `.codex`

- 日期：2026-09-23
- 状态：已接受（Frank 拍板）
- 相关：`docs/implementation/codex-target-session-contract.md`、issue #265、PR #266

## 背景

投递要知道目标 thread 住在哪本账簿（codex home）里。codex 自己从环境变量 `CODEX_HOME` 取这个位置，
默认是 `~/.codex`。

问题出在投递发生的位置：它跑在 Aily **运输会话**的回合里，而那个回合把 `CODEX_HOME` 覆盖成了自己的
临时账簿（`~/.aily-cli/session/<id>/…/codex-homes/<hash>`，回合结束即删）。2026-09-22 omm 上
`Failed to create unified exec process: No such file or directory` 就是这么来的。

PR #266 的第一版修法是：**绑定时把目标会话自己的账簿位置记进登记表，投递时照记录找**。
它能工作，但带来三样必须一直维护的机械：记录、给旧绑定补记、校验记录有没有写坏。

## 决定

**投递与绑定一律使用 `realpath(3)(<真实家目录>/.codex)`，不读 `CODEX_HOME`；不再记录账簿位置。**
账簿里找不到目标 thread 的 rollout 即拒绝，并给封闭文案。

## 理由（当时掌握的事实）

1. **现网没有第二种用法。** Mac 与 omm 的 `CODEX_HOME` 均未设置；两机 6 + 1 条绑定全部没有 `codex_home` 字段
   （即该机制上线后零真实数据）。
2. **桌面版不构成例外。** 这台 Mac 上全部 212 份对话记录都在 `~/.codex` 下，最近 25 份里 22 份 originator 是
   `codex-tui`、3 份是 `Codex Desktop` —— 桌面版与命令行版共用同一本账簿。
3. **唯一真实存在的"自定义账簿"是运输会话的临时账簿**，而那正是必须拒绝的对象。按默认账簿解析对它天然免疫。
4. **一个 adapter 撑不起一个 seam。** 为不存在的用法保留记录机制，等于长期维护三样没人用的东西，
   而 #266 后三轮评审正是在打磨这三样。

## 后果

- 删除：`recordTaskCodexHome`、`makeTaskEntry` 的 `codexHome` 参数、登记表 `codex_home` 校验、绑定时补记分支。
- 保留：拒绝临时账簿、rollout 核实、`realpath(3)` 判定、对外封闭文案、codex 程序落点检查。
- **失去的支持面**：有人把 codex 账簿放在非默认位置时，绑定与投递都会**明确拒绝**（不是悄悄找错地方）。
- 登记表里若残留 `codex_home` 字段：读取侧忽略，`doctor` 报一行提示。

## 什么时候回来改

出现**第二个真实用法**时：某台机器上确有一个需要接入飞书、且账簿不在家目录下的 Codex 会话
（例如按项目/按身份分账簿、账簿挂到别的盘）。那时把账簿位置重新记进绑定，并按当时看到的形状设计，
不要凭想象提前建。
