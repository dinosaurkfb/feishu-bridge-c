# 状态提供者协议 `feishu-bridge-status/v1`

`/feishu-status` 要回答一个问题：**「我有哪些东西连到了哪些飞书群和话题」**。

这个问题对使用者是一个问题，但实现上散在多个消费者手里 —— 本仓库管项目级绑定，
cc2cd 管它自己的群级绑定，将来还会有别的。让使用者先知道「每条绑定归哪个实现管」
才能查状态，等于把内部结构当成了他的负担。

这份协议让每个消费者能报出自己的连接，由 `/feishu-status` 汇总渲染。

## 为什么不挂在路由表上

最初的方案是把状态入口挂在 `routes.json` 的 route 项上。评审推翻了，两条理由都成立：

1. **路由表只知道入站运输消费者。** 纯进度发布的链路根本没有 route，挂上去它永远
   不可见；而为了被发现去造一条假 route，等于往权威路由里掺不参与路由的东西。
2. **路由表是 fail-closed 的。** 状态元数据要是住在同一份文件里，一条坏的 provider
   记录会让 `validateRoutesDoc` 拒绝整张表，**把整个飞书入站停掉**。观测能力坏了
   只该显示「状态不可用」，不该让消息停摆。

所以这是**独立文件、独立校验域**：`~/.claude/feishu-bridge/status-providers.json`。
这里出任何问题都不影响入站，有行为测试守着这条。

## 登记是一次独立授权

状态入口**会在使用者的交互会话里执行一个命令**。这跟 route 的 handler 不等价 ——
handler 在受控的入站事件之后执行，status provider 在交互会话里执行，继承的环境和
上下文都更多。所以登记不由「存在一条 route」推导出来，要显式做：

```bash
node scripts/register-status-provider.mjs \
  --id cc2cd \
  --script /abs/provider.mjs \
  --kinds transport \
  --project-root /abs/project \
  -- --binding /abs/binding.json
```

默认只预览，`--apply` 才落盘。`--replace` 改登记、`--unregister` 撤销，同样默认预览。
`--` 之后的参数原样存下，执行时逐项传递、不做展开。

`--replace` 和 `--unregister` 不能同时给 —— 歧义命令一律拒绝，不许被解释成破坏性
更强的那个。

## 执行约束

每条都对应一个具体的失手方式，不是「顺手加的」：

| 约束 | 为什么 |
|---|---|
| `execFile`，不经 shell | 参数里出现引号、分号、空格不会变成命令 |
| `executable` 与 `script` 必须是绝对、可读的普通文件 | 相对路径按 cwd 解析，同一份登记在不同目录下会跑不同脚本 |
| `args` 逐项原样传递，不做展开 | 同上 |
| 固定 cwd 到脚本所在目录 | 不让「从哪儿调用」影响结果 |
| 关 stdin | provider 不该有机会等输入把状态命令挂住 |
| 环境白名单只放 `PATH`/`HOME`/`LANG`/`TZ` | **不含 `AILY_CLI_*` 和凭据** —— provider 没有理由拿到它们 |
| 5 秒超时、64KB 输出上限 | 一个消费者卡住不该让整条 status 卡住 |
| 单个 provider 失败只影响自己那一节 | 观测能力不该是全有全无 |

**先按项目过滤，再执行。** 只管显示不管执行，等于把别的项目的脚本在当前交互会话里
跑了一遍 —— 范围要是只管显示，那它就不是范围。停用的 provider 连执行都不发生。

## provider 要输出什么

固定 JSON 到 stdout：

```json
{
  "schema_version": "feishu-bridge-status/v1",
  "provider_id": "cc2cd",
  "connections": [
    { "kind": "transport", "state": "active", "scope": "chat", "group_name": "Claude2Codex" }
  ]
}
```

**顶层和 connections 都是封闭结构**（`additionalProperties: false`）。多带一个字段
就整条拒 —— 连接项封闭而顶层不封闭，等于「多带一个字段」只是换个地方放。

| 字段 | 取值 |
|---|---|
| `kind` | `transport`（消息运输）/ `progress`（进度汇报） |
| `state` | `active` / `suspended` / `expired` / `unknown` |
| `scope` | `chat`（整个群）/ `topic`（单个话题）/ `project`（整个项目） |
| `group_name` | 人读的群名，≤60 字符 |
| `topic_name` | 可选，同上 |

`kind` 受**两层约束**：登记时由人声明 `allowed_kinds`，provider 给每条连接标注实际
`kind`，聚合方只接受声明集合内的值 —— provider 不能自己给自己发许可。

协议里没有错误通道。取不到状态时**非零退出**，聚合方会显示「状态取不到」——
这跟「没有已连接的群」是两回事，不能混。

## 不许出现的字段

`endpoint_id`、`subscription_id`、`domain_id`、`agent_uid`、`transport_open_id`、
`chat_id`、`sender_ids`、`local_target_id`、`legacy_key`、`pending_token`、
thread / session / message locator、凭据。

聚合方**绝不回显 provider 的原始 stdout**，只渲染校验过的字段。理由是「不打印
locator」是 status 对使用者的承诺，直接展示别人的输出等于把这个承诺外包给每个接入方
替自己守，那不成立。

挡不住的那部分要明说：**把 locator 塞进 `group_name`** 只能靠一道形状检查兜住
（`oc_`/`om_`/`ou_`/`session_` 之类前缀 + 6 位以上字母数字），**拦得住手滑，拦不住
有意为之**，后者只能靠登记时的信任审查。控制字符会被压平成空格。

## 现成的实现

`scripts/group-binding-status.mjs` 把一份群级绑定翻译成本协议，第一个用它的是 cc2cd。
绑定文件由消费者自己维护（各自 `.runtime-data` 下），脚本只读。

它只报群名：`chat_id`、`transport_open_id`、`thread_id`、session id、`frank_aily_id`
一个都不出 —— 聚合方那边虽然也拦，但拦截是最后一道，不是唯一一道。

状态推导 fail-closed：`status=active` 且未过期才是 `active`；已过期报 `expired`
（状态写着 active 但已经过期，报 active 就是在撒谎）；**有效期解析不出来就整条拒**，
不报一个假的正常。

## 已知缺口

- **连接的关系层判不出来。** cc2cd 的群级绑定按语义属于第 2 层事件订阅（它决定群里
  新话题进哪个域），不是第 3 层通道绑定。但当前协议只有 `kind` 和 `scope`，
  判不出一条连接是订阅、绑定还是策略。**判不出就不硬归类** —— 现在挂在
  「本项目的其他链路（尚未分层）」附录里，等协议加上受控的 `relation_type` 再并入
  对应层。
- **跨项目的诊断不在 status 里。** 「有 route 却没登记状态入口」这类问题归后续的
  `doctor` 命令：status 每天看、必须干净；doctor 出问题才跑、可以啰嗦。
