# 领域词汇

这个仓库把飞书话题和本机的 Claude / Codex 会话接起来。下面是代码、提交信息、评审里**已经在用**的说法，
写在这里是为了让同一个概念只有一个名字。新增术语时连同它的判据一起写，别只写名词。

## 两条链

- **Claude 链**：本机 Claude Code 会话 ↔ 飞书话题。出站靠 Stop 钩子把一轮问答写进 outbox。
- **Codex 链**：本机 Codex 会话 ↔ 飞书话题。入站经 Aily 运输会话送进来，投递给一个精确的 Codex thread。

## 入站

- **运输会话（transport session）**：Aily 为处理一条飞书消息而起的那个 Codex 回合。它只负责把消息送进来。
  它的现场（`CODEX_HOME`、`CODEX_THREAD_ID`、`CODEX_CI`、PATH 里的 arg0 临时目录）**不得泄漏给目标会话** ——
  那些目录随回合结束被清掉。
- **claim**：一条飞书消息的受理凭据。秒级写下，保证同一条消息不被重复执行。
- **投递（handoff）**：把指令交给目标会话去执行。经 `run-resume` 起 `codex exec resume`，不阻塞入站回执。

## 目标会话（Codex target session）

一次投递的收件人，由四样东西共同确定，缺一不可：

- **thread**：精确 UUID，不接受名字或"最近一个"。
- **账簿（codex home）**：codex 存放对话记录的目录。**本项目只认用户家目录下的 `.codex`**（见 ADR-0001）；
  家目录取 passwd 记录（`os.userInfo().homedir`），**不跟随 `$HOME`** —— 运输会话能改写 `$HOME`。
  判定一律按 `realpath(3)` 的实际落点，不按字面路径。桌面版（ChatGPT.app 内置的 codex）与命令行版共用同一本。
- **codex 程序**：本身与实际落点都不得在临时目录里。
- **子进程环境**：从调用方环境清洗掉运输会话现场之后的结果。

判据只实现一份（`scripts/codex/target-session.mjs`），绑定时与投递前各调一次。

## 绑定与话题

- **绑定（binding）**：一个本机会话 ↔ 一个飞书话题的对应关系。Codex 侧记在 `registry.json` 的 task 条目里。
- **话题代际（topic generation）**：同一条绑定在轮转后换到新话题，旧话题冻结；"发到哪个话题"按代际解析。
- **outbox**：待发消息队列。发布器（drain）按身份模板发出，失败留队。

## 安装

- **安装面（install surface）**：一次安装会动到的那组权威文件（settings、钩子、技能、运行时、定时器）。
- **运行时（runtime）**：`runtime/current` 指向 `versions/<hash>`；**把仓里的代码变成"正在跑"的唯一入口是
  安装器的 `--apply`**。
- **维护门（maintenance gate）**：窗口内禁止改动桥状态的闸。
