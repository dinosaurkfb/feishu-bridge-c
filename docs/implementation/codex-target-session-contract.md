# Codex 目标会话（target session）契约

> 状态：设计，待 Codex 评审。对应架构复核候选 C1。实现前不改任何代码。
> 词汇按 `CONTEXT.md`；「只认默认账簿」这条决定记在 `docs/adr/0001-codex-home-default-only.md`。

## 为什么改

一次投递要回答四个问题：**哪个 thread、哪本账簿（codex home）、哪个 codex 程序、什么子进程环境**。
今天这四个问题在四处各答一次：`bind-task.mjs`（绑定时核实并记账簿）、`inbound.mjs`（拼 codexBin / codexHome）、
`handoff.mjs:resolveTargetCodexHome`（投递时再核一次）、`run-resume.mjs`（第二次清洗、用环境变量覆盖 CODEX_HOME）。

#266 五轮评审的四个 P1（临时别名、桥根与账簿脱钩、符号链接后接 `..` 的词法/实际落点错位、报错外泄本机路径）
全部落在「同一件事答四遍」这个形状上，不是四个独立缺陷。

## 目标形状

一个 deep module：`scripts/codex/target-session.mjs`。interface 三个符号，implementation 吃下全部判据。

```js
export class CodexTargetRefusal extends Error {}   // .publicText（封闭文案，可进飞书）/ .message（带路径，只进本机）

// 唯一的核实实现。绑定时与投递前都调它，禁止第三处自行判断。
export function resolveCodexTarget({ threadId, home = os.homedir(), env = process.env, codexBin = "codex" })
//   → { threadId, codexHome, codexBin }   // codexHome / codexBin 均为 realpath(3) 后的实际落点
//   → throws CodexTargetRefusal

// 目标现场：从调用方环境清洗出交给 codex 的子进程环境。
export function codexRunEnv(target, { claimKey, taskKey, bridgeHome })
//   → env（剥掉运输会话现场，钉死 CODEX_HOME = target.codexHome）
```

`resolveCodexTarget` 内部按顺序判，任一条不成立即 `CodexTargetRefusal`：

1. `threadId` 是精确 UUID（名字、`--last` 一律拒）；
2. 账簿 = `realpath(3)(<home>/.codex)`，**不读 `CODEX_HOME`**（ADR-0001）；
3. 账簿的实际落点不在 Aily 运输会话临时目录（`/.aily-cli/session/`）下；
4. 账簿的 `sessions/` 或 `archived_sessions/` 里有该 thread 的 rollout（找不到即拒，不试投——Q8）；
5. `codexBin`：名字形式经 `command -v` 解析，绝对路径直接用；本身与实际落点都不得落在 arg0 临时目录或 Aily 会话下；可执行。

**「目标现在能不能用」这一类判据只加在第 4 步之后、第 5 步之前这一处。**
（2026-09-22 omm 出现的 `thread already has an active writer` 将来若要拦，就加在这里，不另开地方。Frank 决定先不实现。）

## 时机：两次调用，一份实现

| 时机 | 调用点 | 问的问题 | 失败后果 |
|---|---|---|---|
| 绑定 | `bind-task.mjs`，**在任何飞书调用之前** | 这个 thread 现在能不能接 | 拒绝建话题（否则飞书上留下一个永远投不进去的话题） |
| 投递前 | `inbound.mjs`，**在写 runs 目录之前** | 现在还成不成立 | 拒绝投递、零文件，飞书只得到 `publicText` |

## 交接：明文参数，不走暗号

`inbound → run-resume` 这一跳的四样东西全部写进 argv：现有的 `--thread-id` / `--project` / `--claim-text` 之外，
新增 **`--codex-home`**；`run-resume` 不再读 `FEISHU_CODEX_TARGET_HOME`（该变量删除）。

`run-resume → codex` 这一跳仍用环境变量 `CODEX_HOME`：codex 没有等价命令行选项（实测 `codex exec resume --help`）。
值来自 argv，`run-resume` 不再自行推导。

## 删除清单（现网零数据，删得干净）

已核实：Mac 6 条、omm 1 条绑定**都没有** `codex_home` 字段。

- `state.mjs`：`recordTaskCodexHome` 整个函数、`makeTaskEntry` 的 `codexHome` 参数与 `codex_home` 字段、`validateRegistryDocument` 里的 `codex_home` 校验分支。
- `bind-task.mjs`：`verifiedBindingCodexHome`、缺字段补记分支（dry-run 提示 / `--apply` 写入 / 已记不改三条路径）。
- `handoff.mjs`：`resolveTargetCodexHome`、`ROLLOUT_ROOTS` / `holdsRollout`、`assertCodexAvailable`、`sanitizeCodexRunEnv`、`isTransientCodexHome` → 迁入新 module；`handOffCodex` 的 `codexHome` / `codexBin` 参数 → 换成一个 `target`。
- `inbound.mjs`：自行拼 `codexBin` / `codex_home` 的两处。
- `run-resume.mjs`：`FEISHU_CODEX_TARGET_HOME` 分支。
- 对应测试：`PK3-E265-fix2/fix3` 中针对「记录 / 补记 / 坏值」的用例。

**保留**（#266 花五轮买到的判据，一条不丢）：拒绝运输会话临时账簿、rollout 核实、判定一律按 `realpath(3)`、
对外封闭文案、codex 程序落点检查、`bind-task` 对登记表读取失败 fail-closed（#266 四轮 P1）。

**旧记录（Q7）**：登记表里若残留 `codex_home`，读取侧**忽略**、不报错；`doctor.mjs` 多报一行
「N 条绑定带着已废弃的 codex_home 字段（忽略）」。

## 测试

**新增第一条端到端真进程用例**（今天为止，投递路径的真进程用例全部止于拒绝分支，从未执行到投递）：
隔离 HOME → 在 `<HOME>/.codex` 植入目标 thread 的 rollout → 假 codex（记录 argv 与 env）→ 真入口 `aily-inbound.mjs`
→ 断言：① 飞书面 stdout 为「已受理」；② runner 真的起了并写出退出回执；③ 假 codex 拿到的 `CODEX_HOME` = 隔离 HOME 下的账簿；
④ runner argv 里有 `--codex-home` 且值相同；⑤ 假 codex 的环境里没有运输会话的 `CODEX_THREAD_ID` / `CODEX_CI` / arg0 临时目录。

沿用的行为用例：#265 的运输现场剥离（纯函数 + 真进程两条）、arg0 临时目录拒绝、符号链接与 `..` 的实际落点判定、
绑定前核实（拒绝建话题、假 lark 零调用）、登记表读取失败 fail-closed。

刀（破坏性验证）：逐条拆掉上述判据，各自应当变红；`--codex-home` 改回环境变量传递 → 端到端用例红。

## 不在本次范围

- Claude 链的同类概念（活会话）——两条链判据不同，只有一个真实用法不足以支撑共用 seam。
- 占用检测（`active writer`）——位置已留，判法待定。
- 自定义账簿支持——见 ADR-0001 的回头条件。
