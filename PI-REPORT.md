# R49 doctor「真实进程」测试密闭性 — PI-REPORT

## 分支与对象
- 分支：`pi-ds/r49-doctor-test-hermeticity`
- 基准：`origin/main 96732f3`
- 范围：只改测试 fixture（`scripts/test.mjs`）；**不改任何生产代码**（doctor.mjs / maintenance/* / 账本模块均未动）；不新增 env 变量；不 `--apply`、不碰运行时与 `.runtime-data`、测试不打真飞书。
- 触及文件：`scripts/test.mjs`（29+/3-）。

## 根因（已核实，与你诊断一致）
- `maintenanceDir()`（`scripts/maintenance/journal.mjs`）在未设 `FEISHU_BRIDGE_MAINTENANCE_DIR` 时回退到 `realUserHome()`，
  而 `realUserHome()`（`scripts/maintenance-gate-core.mjs`）用 `os.userInfo().homedir`（**passwd，不跟会话 `HOME` / `CODEX_HOME` 走**）。
- 于是 doctor 测试虽把 `HOME` 指向 fake home，沙箱 doctor 仍读到**真机** `~/.claude/feishu-bridge/{maintenance,ledger,maintenance.gate}`；
  本机跑过 R46 等，真机 maintenance/ledger 已有 m1a 收据/账本（试运行 shadow 就位）→ doctor 报 `m1a_shadow_reconcile` 红，
  违反「好机器/未启用不把整体染红」前提。基线 `node scripts/test.mjs` = **917/2**（2 条医生红）。origin/main 干净 HEAD 同红：**测试密闭性缺口，非产品缺陷**。

## 落点（只改 `scripts/test.mjs` 的 `doctorMachine` fixture + 一条新测试）
1. **fake home 改到规范路径**：`fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), ...))`。
   原先用 `os.tmpdir()` = `/var/folders/...`，`/var → /private/var` 是符号链接，会让
   `validateLedgerRoot`/`inspectMaintenanceDir` 判 `root_not_canonical`（这是隔离后暴露的第二层问题）。
2. **预置并 `chmod 0700` 两条根**：`<home>/.claude/feishu-bridge/{maintenance,ledger}`。
   现存根须精确 0700，否则 `validateLedgerRoot` 判 `root_perms`（`root_perms` 检查 `(st.mode & 0o777) === 0o700`）。
3. **`run` 子进程 env 增加三个隔离点**（**都在命令前赋值**，随 `m.run` 的 spawn env 下发）：
   - `FEISHU_BRIDGE_MAINTENANCE_DIR: <home>/.../maintenance`
   - `FEISHU_BRIDGE_LEDGER_DIR: <home>/.../ledger`
   - `FEISHU_BRIDGE_MAINTENANCE_GATE: <home>/.../maintenance.gate`
   （原先 `run` env 只设了 `HOME/REGISTRY/ROUTES/STATUS_PROVIDERS/CODEX_HOME/FEISHU_CODEX_BRIDGE_HOME`，漏了这三个。）
4. **`doctorMachine` 返回值补 `maintDir/ledgerDir/gateFile`**（供新测试断言与覆盖）。

## doctor 读取路径的真实 home 回退逐一核对（均已 env 隔离，无未隔离点）
| doctor 读取 | 真实 home 回退 | 隔离 env | fixture 已设 |
| --- | --- | --- | --- |
| 维护目录（⑭ M1a、⑮ staging、⑩ gate 相关） | `maintenanceDir()`→`realUserHome()` | `FEISHU_BRIDGE_MAINTENANCE_DIR` | ✓ |
| 维护门（⑩） | `maintenanceGatePath()`→`realUserHome()` | `FEISHU_BRIDGE_MAINTENANCE_GATE` | ✓ |
| 账本根（⑭ inventory、⑮ ⑰） | `ledgerRoot()`→`realUserHome()` | `FEISHU_BRIDGE_LEDGER_DIR` | ✓ |
| Codex 子进程 home | `machineContext({home})`→`path.join(home,".codex")` | `CODEX_HOME`/`FEISHU_CODEX_BRIDGE_HOME` | ✓（已有） |
| 订阅（⑫ store/审计） | `subscriptionStorePath({home})`（**home 参数派生**，非 realUserHome） | 随 `HOME` | ✓（已有） |
| launchd（⑥ 兜底） | — | `FEISHU_BRIDGE_LAUNCHCTL`（**沙箱注入点**，好机器测试显式注入；未注入 → doctor 报 unknown/沙箱） | 测试注入 |

**结论：doctor 读取路径没有「无 env 隔离点的真实 home 回退」**。存量「坏机器/⑫ 矩阵/⑮ 等」doctor 测试虽曾读真机 m1a/ledger，但**不 assert 这些检查**（不读 m1a/staging 结论），故此前仍绿；本次 `doctorMachine` 统一隔离后它们也一并密闭。

## 反向守卫（新测试，证明隔离靠 env 不靠碰巧）
- 用 `doctorMachine()` 造 clean 沙箱；另建 `<home>/fake-maint` 放一封**缺字段的 ledger_init journal**（`{schema_version:"1.2", operation_kind:"ledger_init"}`）。
- 断言：
  - 默认（clean 维护目录）→ `m1a_shadow_reconcile.ok === true`（「无任何 shadow 账本 / 收据（未接入）」）；
  - `m.run({ FEISHU_BRIDGE_MAINTENANCE_DIR: fakeMaint })` → `m1a_shadow_reconcile.ok === false`（「init WAL 判定 fail-closed」）。
- 若隔离不靠 env，改 `FEISHU_BRIDGE_MAINTENANCE_DIR` 不该改变 m1a 结果；现在改变了 → **隔离确由 env 生效**。

## 门禁数字（如实）
- **Claude** `node scripts/test.mjs`：**920 / 0**（基线 917/2 → 两条医生红转绿 + 一条反向守卫新测试；相对基线 +1 新测试、-2 红）。若无反向守卫，为 **919/0**（即「两条红转绿、+0 新测试」）。
- **Codex** `node scripts/codex/test.mjs`：**293 / 0**。
- **`git diff --check`**：干净。
- **diff 只碰** `scripts/test.mjs`（测试 fixture + 新测试）；生产代码 0 处改动。
- `PI-TASK.md` 未提交。

## 如实说明
- **「919/0」与「920/0」**：任务验收写「919/0」，但那指「两条红转绿（+0 新测试）」。本交付按要求**额外加一条反向守卫**（+1 测试），故最终 **920/0、0 红**；若不算反向守卫则为 919/0。反向守卫是任务交付项 3 明确要求的，故未省略。
- **`os.tmpdir()` 符号链接**：`/var → /private/var` 是 macOS 常见现象；`doctorMachine` 用 `realpathSync(os.tmpdir())` 规避。这是测试 fixture 的路径选择问题，不是 doctor 模块缺陷（doctor 的 `validateLedgerRoot` 正确地拒非规范根）。
- **进程内** `runDoctor({ home })` 测试（非「真实进程」spawn）**不在** doctorMachine 家族；它用 `home` 参数派生路径，但其 m1a/topic_agent_staging 若未设 `FEISHU_BRIDGE_MAINTENANCE_DIR/LEDGER_DIR` 仍会回退 realUserHome。该测试**不 assert** m1a/staging，且属「真实进程」范围之外，故未改动（如需彻底密闭，可在该测试的 saved/restored env 同样补这三个隔离点——留给后续，非本次痛点）。
- **不新增 env**：未给生产代码加任何 env；只把 doctor **已存在**的三个 env 隔离点在测试 fixture 里设上。

## 结论
- R49 封闭了 doctor「真实进程」测试读取真机 home 的缺口：`doctorMachine` 统一把 `FEISHU_BRIDGE_MAINTENANCE_DIR/LEDGER_DIR/GATE` 指向 fake home（规范路径 + 0700），并加了反向守卫证明隔离靠 env。
- 两套套件全绿（Claude 920/0、Codex 293/0），`git diff --check` 干净，仅改 `scripts/test.mjs`。
- 请 Frank 验收；不 `--apply`、不开 PR/合并。
