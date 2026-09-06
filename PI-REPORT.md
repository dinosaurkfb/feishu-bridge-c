# PI-REPORT — R36 返修单 round-2 全部收口（P1-2 / P1-4 / P1-3①② / P1-1-d / P2-1）

> 本单为 R36 返修单第二轮的**全部**收口。分支 `pi-ds/r36-m1a-wiring` 已推（相对基线 `c3c2a2d`
> 共 6 个补 commit），两套件全绿、`git diff --check` 干净、四安装器 dry-run 通过。
> 按 Frank 指定顺序逐项落地：**P1-2 CLI 五点接线 → P1-4 → P1-3①② → P1-1-d（裁定 d）→ P2-1 → 收总**。

## 提交链（分支已推，0 未提交）

| commit | 内容 |
| --- | --- |
| `e982997` | P1-2 core（Codex 裁定：`wirePauseResume`/`wireEnabledFlip` lock-only）+ P1-2b（absent-dir→`never_initialized`=合法 legacy-only）+ P1-3③（ReferenceError） |
| `3e4be3d` | P1-2 CLI 五点接线（bind-project/feishu-rotate/feishu-unbind/live-session/… ） |
| `29ea09a` | P1-4（debris 投影、restore/void/rotate 复合体） |
| `8d412b8` | P1-3①（codex 三调用点 outer-lock 双写）+ P1-3②（`wireRotateRecovery` verifyLegacy） |
| `7fc2399` | **P1-1-d（裁定 d）**：F4 判别联合——token 四项 present vs 无码 owner-root 三维 absent |
| `b9c0c3f` | **P2-1**：生产入口回归——wirePromoteBinding 无码认领→B3 取 no-token 支 |

## P1-1-d：F4 判别联合（裁定 d，不放松 F4、不伪造）

Codex 裁定 d：**ADD 第二条封闭配对支，不 relax F4**。实现用单一判别键 `pending_token_state`：

| proof | 判别支 | fields | matched_om | authorized_by |
| --- | --- | --- | --- | --- |
| 令牌认领 | `binding_token_v1`（present） | 恰四项 `[chat_id,sender,body,thread_root]` | 被引根消息 om | event.sender_id |
| 无码 owner-root | `owner_root_no_token_v1`（absent） | 恰三项 `[chat_id,sender,thread_root]`（无 body/码 维） | 同上 | 同上 |

- **六条件**（① 仅可认领 B1；② `pending_token===null`∧expiry null；③ verified owner；④ chat 匹配；⑤ 引用根消息逐字= B1 根；⑥ bind-only、正文不执行），任一失败→`f4:null` 整拒。
- **G15 按支精确校验**：`matchedFieldsBad` 以 `pending_token_state` 分支（present→四项 / absent→三项 / 缺 state / 未知 / 部分字段 / 占位→拒）。**无 legacy 宽容**（本支未发布、无生产账本；旧的"无码当四项"伪造正是此层要抓的）。
- wiring `f4Ok` 同分支；`activate`/`attachF4`/`anchor` 写 `pending_token_state`，`attachF4`/`anchor` 为 token-only（要求 `root_om`，无码三维无 root_om → `bad_f4` fail-closed，no 一致性问题）。
- 入口（claude `inbound-route.mjs` / codex `state.mjs`）按 `pending.source` 区分 token vs sole_pending 产 4/3 支。

## P2-1：生产入口回归

补实 `wirePromoteBinding` 无码认领正例（复用既有 F4B 三维 absent 夹具）：B1(pending)→create_a1→activate 归并成 B3，
配对证明取判别联合 **no-token 支**（`matched_fields` 三维 + `pending_token_state=absent`，`kind=pairing`），不伪造 body/码 维。
配合既有 P1-1-d 账本 G15 测试 + 入口单元探针（claude `evaluatePromotion` no-token→三维 / codex 同）构成全链覆盖：
入口决策 → wiring 消费 → 账本校验。

## 证据（收总 gate）

- **Claude 套件**：`node scripts/test.mjs` → **881 / 失败 0**。
- **Codex 套件**：`node scripts/codex/test.mjs` → **288 / 失败 0**。
- **contract 一致**：`references/shared-surface.json` 等该分支未动契约；f4 判别联合仅新增支、不改既有 `binding_token_v1` 形状。
- **四安装器 dry-run（均无 --apply）**：`install-outbound`、`install-inbound`、`codex/install` → `[dry-run] 什么都没写`；`maintenance-install` → `[预览] 预检通过`。
- **`git diff --check`**：干净。

## 状态

- R36 返修单 round-2 全部项：**P1-2、P1-4、P1-3①②、P1-1-d、P2-1 → 全部闭合并推**。
- W2 Phase 1 + Phase 2 no-op 判定（上一轮闭合）不变。

残留（如实记录，非本轮阻塞、非本轮引入）：
- `node scripts/doctor.mjs` → blocked，唯一 ✗ 是 **`cc2cd`（另一项目）** runs 账本 `legacy_state` 说不清——跨项目既有、与本次改动无关；其余全绿（⑬⑭ 因本分支未跑 --apply 而"无收据/无 shadow"）。
- 维护门 PR B 并发测试满载下偶发（两真进程争 surface_lock_residue），孤立跑 3/3 过，既有时序抖动、非本轮引入。

## 备注（授权边界）

分支已推、可送 Codex 放行。**未执行任何 `--apply`**（安装需 Frank 逐次授权）；doctor 为只读。
合并到 main 前仍需 Codex 附可核对证据（两套件全绿数字 + contract 一致 + 四安装器 dry-run + `git diff --check` 干净）。
