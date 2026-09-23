# Codex 目标会话（target session）契约

> 状态：设计第三版，待 Codex 复评。对应架构复核候选 C1。实现前不改任何代码。
> 词汇按 `CONTEXT.md`；「只认默认账簿」这条决定记在 `docs/adr/0001-codex-home-default-only.md`。
> 二版按 Codex 一轮（P1 2 / P2 4）改：预检与启动同源、家目录不从 `$HOME` 推、拒绝类加 code、
> argv 口径写实、端到端断言换成可观察面。
> 三版按 Codex 二轮（P1 1 / P2 1）改：删掉 `--user-home` 这个生产可达的账簿覆盖口、枚举钉死序列化值。

## 为什么改

一次投递要回答四个问题：**哪个 thread、哪本账簿（codex home）、哪个 codex 程序、什么子进程环境**。
今天这四个问题在四处各答一次：`bind-task.mjs`（绑定时核实并记账簿）、`inbound.mjs`（拼 codexBin / codexHome）、
`handoff.mjs:resolveTargetCodexHome`（投递时再核一次）、`run-resume.mjs`（第二次清洗、用环境变量覆盖 CODEX_HOME）。

#266 五轮评审的四个 P1（临时别名、桥根与账簿脱钩、符号链接后接 `..` 的词法/实际落点错位、报错外泄本机路径）
全部落在「同一件事答四遍」这个形状上，不是四个独立缺陷。

## 目标形状

一个 deep module：`scripts/codex/target-session.mjs`。

```js
// 稳定枚举，机器可判定；**序列化值逐字钉死**，回执 / 日志 / 调用方都用这些字符串，不各自解释（Codex 一、二轮 P2）
export const REFUSE = Object.freeze({
  THREAD_SHAPE:       "thread_shape",
  HOME_MISSING:       "home_missing",
  HOME_TRANSIENT:     "home_transient",
  ROLLOUT_MISSING:    "rollout_missing",
  BIN_MISSING:        "bin_missing",
  BIN_TRANSIENT:      "bin_transient",
  BIN_NOT_EXECUTABLE: "bin_not_executable",
});                                             // 将来的 active writer 占用在这里加一枚（如 "target_busy"）

export class CodexTargetRefusal extends Error {} // .code（上表）/ .publicText（封闭文案，可进飞书）/ .message（带路径，只进本机）

// 唯一的核实实现。绑定时与投递前都调它，禁止第三处自行判断。
export function resolveCodexTarget({ threadId, userHome = os.userInfo().homedir, env, codexBin = "codex" })
//   → { threadId, codexHome, codexBin }
//     codexHome：realpath(3) 后的账簿实际落点
//     codexBin ：在**清洗后的 PATH** 上解析、再 realpath(3) 的绝对路径（runner 直接执行它，不再二次解析）
//   → throws CodexTargetRefusal

// 目标现场：从**同一份源环境**清洗出交给 codex 的子进程环境。
export function codexRunEnv(target, { env, claimKey, taskKey, bridgeHome })
//   → env（剥掉运输会话现场，钉死 CODEX_HOME = target.codexHome）
```

**预检与启动必须同源（Codex 一轮 P1-1）**：两个导出都显式收 `env`，模块内部只有**一份**私有清洗实现
`cleanEnv(env)`；`resolveCodexTarget` 第 5 步在 `cleanEnv(env).PATH` 上找程序，`codexRunEnv` 用同一个
`cleanEnv` 产出最终环境。理由：Aily 现场里 arg0 临时目录排在 PATH 前、稳定的 codex 在后 —— 若在未清洗的 PATH
上找，会先命中临时程序并拒绝，**所有入站投递失灵**；若两处环境不同源，则复活 #266 的「预检通过、启动失败」。

### 账簿从哪来（Codex 一轮 P1-2）

`userHome` **不由环境推导，也不由任何 CLI 参数决定**（Codex 二轮 P1）：

- 生产：默认值 `os.userInfo().homedir`（passwd 记录，**不跟随 `$HOME`**）。
  实测：改 `process.env.HOME` 后 `os.homedir()` 随之改变，`os.userInfo().homedir` 不变。
  入站 / 绑定两个入口**都不传** `userHome`，也**不接受**任何指定账簿的命令行参数。
- **真入口必须显式拒绝 `--user-home`**：`aily-inbound.mjs` 会把自身 argv 原样转交 handler
  （`scripts/inbound-dispatcher.mjs`），所以"生产不传"只是约定 —— 留着这个参数等于开了一个
  ADR-0001 明确排除的自定义账簿入口。真入口见到它就报错退出，绝不据此切换账簿。
- 测试怎么注入：① 单元层直接 import 这个 module 并传 `userHome` 形参；② 端到端层用只有测试才挂的
  启动注入（spawn 真入口时加 `--import <test-support/user-home-bootstrap.mjs>` 覆写 `os.userInfo`）。
  **产品代码里不存在对应分支**，这是它与 CLI 参数的本质区别：后者是产品 interface 的一部分，前者不是。
  （同类先例：套件已用包装 `fs.mkdirSync` / `mkdtemp` 做隔离。）

账簿 = `realpath(3)(path.join(userHome, ".codex"))`，**不读 `CODEX_HOME`**（ADR-0001）。

### 五步判据

按序判，任一条不成立即 `CodexTargetRefusal`（带 code）：

1. `threadId` 是精确 UUID（名字、`--last` 一律拒）→ `THREAD_SHAPE`；
2. 账簿存在 → `HOME_MISSING`；
3. 账簿实际落点不在 Aily 运输会话临时目录（`/.aily-cli/session/`）下 → `HOME_TRANSIENT`；
4. 账簿的 `sessions/` 或 `archived_sessions/` 里有该 thread 的 rollout → 否则 `ROLLOUT_MISSING`
   （找不到即拒，不试投；理由见 Q8：codex 自己也是从这本账簿找，试投只是把同一个失败推后）；
5. codex 程序：在清洗后的 PATH 上解析（绝对路径则直接用）→ `BIN_MISSING`；本身与 realpath 落点都不在
   arg0 临时目录或 Aily 会话下 → `BIN_TRANSIENT`；可执行 → `BIN_NOT_EXECUTABLE`。

**「目标现在能不能用」这一类判据只加在第 4 步之后、第 5 步之前这一处。**
（2026-09-22 omm 出现的 `thread already has an active writer` 将来若要拦，就加在这里、加一枚 code，不另开地方。
Frank 决定先不实现。）

## 时机：两次调用，一份实现

| 时机 | 调用点 | 问的问题 | 失败后果 |
|---|---|---|---|
| 绑定 | `bind-task.mjs`，**在任何飞书调用之前** | 这个 thread 现在能不能接 | 拒绝建话题（否则飞书上留下一个永远投不进去的话题） |
| 投递前 | `inbound.mjs`，**在写 runs 目录之前** | 现在还成不成立 | 拒绝投递、零文件，飞书只得到 `publicText` |

## 交接口径（Codex 一轮 P2-2：按现有协议写实）

`inbound → run-resume` 这一跳分三类，不含糊：

- **目标字段（argv）**：`--thread-id`、`--codex-home`（新增）、`--codex-bin`（值 = resolver 解析后的绝对路径）。
- **运行元数据（argv，现有）**：`--project`、`--instruction-file`、`--log`、`--stderr`、`--last-message`、
  `--exit-receipt`、`--claim-key`。
- **子进程环境**：`codexRunEnv` 的结果，经 `spawn(…, { env })` 传递 —— 环境本来就不走 argv，第一版说「四样全写进 argv」不准确。

`FEISHU_CODEX_TARGET_HOME` 删除；`run-resume` 不再读它、也不再自行推导账簿或按 PATH 二次解析程序。

`run-resume → codex` 这一跳仍用环境变量 `CODEX_HOME`：codex 没有等价命令行选项（实测 `codex exec resume --help`）。

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

**旧记录（Q7）**：登记表里若残留 `codex_home`，读取侧**忽略**、不报错；**其它未知顶层字段同样不许丢**
（就地改那一条，不拿视图重建整表）；`doctor.mjs` 多报一行「N 条绑定带着已废弃的 codex_home 字段（忽略）」。

## 测试

**新增第一条端到端真进程用例**（今天为止，投递路径的真进程用例全部止于拒绝分支，从未执行到投递）：
隔离 HOME + 测试专用启动注入（`--import test-support/user-home-bootstrap.mjs` 覆写 `os.userInfo`，产品代码无此分支）
→ 在 `<注入的 home>/.codex` 植入目标 thread 的 rollout → 假 codex（记录自己的 argv 与 env）
→ 真入口 `aily-inbound.mjs` → 断言：

1. 飞书面 stdout 为「已受理」，且不含本机路径与 thread 号；
2. runner 真的起了，退出回执是**合法终态**（不是「文件存在」而已）；
3. 假 codex 拿到的 `CODEX_HOME` = 注入的 home 下的账簿实际落点（**不是真实家目录下那本**）；
4. 假 codex 拿到的 thread 参数 = 绑定里那个精确 UUID；
5. **实际被执行的程序** = resolver 解析出的那个绝对路径（假 codex 自报 `argv[0]` / 自身路径）；
6. runner 进程的 argv 里有 `--codex-home` 与 `--codex-bin`，值与上面一致
   （argv 在 handoff→runner 这个可观察 seam 上断言：假 codex 看不见父进程的 argv，第一版那条断言证明不了传递方式）；
7. runner 环境与假 codex 环境里**都没有** `FEISHU_CODEX_TARGET_HOME`，也没有运输会话的
   `CODEX_THREAD_ID` / `CODEX_CI` / arg0 临时目录。

沿用的行为用例：#265 的运输现场剥离（纯函数 + 真进程两条）、符号链接与 `..` 的实际落点判定、
绑定前核实（拒绝建话题、假 lark 零调用）、登记表读取失败 fail-closed。

**刀单**（逐条拆掉应当变红）：

- 第 5 步改用未清洗的 PATH → **正例**：arg0 临时目录在前、稳定 codex 在后时仍应投递成功；
- `codexRunEnv` 改成隐式读 `process.env`（源环境与 `process.env` 不同的用例）；
- 恢复 `FEISHU_CODEX_TARGET_HOME` 旧暗号；
- 不传 `--codex-home`；
- runner 拿到 `--codex-bin` 后仍按 PATH 二次解析；
- `userHome` 改回 `os.homedir()`（`$HOME` 被改写的用例）；
- **真入口带 `--user-home` 必须被拒**：既不得切换账簿，也不得当成未知参数静默忽略（Codex 二轮 P1）；
- 五步判据各自的拒绝分支与 code。

## 不在本次范围

- Claude 链的同类概念（活会话）——两条链判据不同，只有一个真实用法不足以支撑共用 seam。
- 占用检测（`active writer`）——位置与 code 槽位已留，判法待定。
- 自定义账簿支持——见 ADR-0001 的回头条件。
