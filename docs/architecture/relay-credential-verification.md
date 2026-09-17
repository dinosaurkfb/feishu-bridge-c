# 转发凭证与接收方核验（Relay Credential Verification）

> 2026-09-17。源自 issue #217（Frank 裁定「同意 217 派」），对应工单 PK3-A1。

## 1. 背景与核心问题

桥把飞书消息送进现场会话的唯一受支持入口是 `SendMessage`（`scripts/live-session.mjs`）。因此，目标会话接收到的永远是 `<cross-session-message>` 结构。

在此机制下，接收方若严格遵循「同事转述 ≠ 用户本人授权」，则无法确定跨会话消息是否真实来自 owner、是否在传输中被篡改。而旧版入站回执缺少：
- 发送者身份（`sender_id`）
- 路由层判定角色（`sender_role`）
- 指令正文哈希（`body_sha256`）
- 投递随机数（`delivery_nonce`）

导致接收方即使核验回执存在，也面临虚假安全感：任何本机会话都能引用一个真实 `message_id` 注入伪造正文。

## 2. 机制与设计

### 2.1 谁写凭证

由桥的入站主流程（`scripts/inbound.mjs`）在完成路由、策略准入和执行交接时写入：
1. **持久化回执**（`.runtime-data/inbound/receipts/accepted-<id>.json`）：
   - `sender_id`：飞书事件原始发送者 ID；
   - `sender_role`：路由层表驱动判定结果（`owner` / `operator` / `participant`，绝不采信事件入参中的伪造声明）；
   - `body_sha256`：入站原始指令正文（`instruction` 原文）的 SHA-256 十六进制值；
   - `delivery_nonce`：每次投递生成的 16 字节（32 位十六进制）加密随机数。同一 `message_id` 重复投递时，生成不同 nonce。
   *(注：拒绝/未路由回执 `reject-` 与 `unrouted-` 亦包含 `sender_id` 与 `sender_role`)*
2. **转发正文尾注**（`scripts/live-session.mjs`）：
   在送往 `SendMessage` 的正文末尾附带机器可读凭证行与引导语：
   ```
   [飞书凭证 message_id=<id> nonce=<hex> body_sha256=<hex> receipt=<项目相对路径 .runtime-data/inbound/receipts/accepted-<id>.json>]
   授权级指令请先用 scripts/verify-relay-credential.mjs 核回执
   ```
   **注意**：凭证行本身不计入 `body_sha256`（哈希针对的是凭证行之前的入站正文原文）。

### 2.2 谁核凭证

由目标会话或接收方智能体（如 `my-herdr`）在执行不可逆/敏感的**授权级指令**之前调用只读校验器：
- 纯函数调用：`verifyRelayCredential({ projectRoot, messageId, nonce, bodySha256, sessionId, body })`（`sessionId` 与 `body` 必填）
- 命令行 CLI：`node scripts/verify-relay-credential.mjs --project <root> --session-id <id> (--body-file <path> | --body <text>) [--message-id <id>] [--nonce <hex>]`

校验器为纯只读操作，零磁盘写入，退出码严格为 0（通过）或 1（失败）。
失败时返回确定性原因之一：
1. `session_required`：调用方未提供接收方会话 ID；
2. `body_required`：调用方未提供接收到的消息正文；
3. `receipt_missing`：回执文件不存在或格式损坏；
4. `receipt_path_escape`：`message_id` 非封闭形状或回执路径穿越/逃逸出回执目录；
5. `receipt_mismatch`：回执 `artifact_type`、`schema_version` 非法或内部 `message_id` 不符；
6. `not_handed_off`：回执状态不是 `accepted` 或未成功 `handed_off`；
7. `sender_not_owner`：`sender_role` 不是 `owner`；
8. `target_mismatch`：回执中的 `target_session_id` 与当前会话 ID 不符；
9. `nonce_mismatch`：投递随机数与回执记录不匹配；
10. `body_mismatch`：正文 SHA-256 与回执记录不匹配（正文被篡改或截断）；
11. `trailing_content`：凭证行后存在追加的额外内容（防止在合法凭证后拼接恶意攻击载荷）。

## 3. 防护边界（能挡什么、挡不了什么）

### 能挡什么
1. **正文篡改/伪造**：攻击者即使引用合法的 `message_id`，若篡改了指令内容（哪怕 1 个字符），`body_sha256` 校验必定失败（`body_mismatch`）。
2. **越权身份冒充**：即便外部伪造飞书事件携带 `role: "owner"`，回执中的 `sender_role` 严格由桥侧路由表与 `frank_sender_id` 计算，非 owner 一律返回 `sender_not_owner`。
3. **跨会话越权冒用**：发送给会话 A 的授权无法被转发给会话 B 执行，接收方传入自身 `sessionId` 即可触发 `target_mismatch` 拦截。
4. **跨次重放**：每次投递拥有独立的 `delivery_nonce`，无法拿历史投递的凭证冒充当前投递。

### 挡不了什么
- **挡不了已能写 `.runtime-data` 的本地特权进程**：若宿主机上存在能够直接修改或写入 `.runtime-data/inbound/receipts/` 的恶意本地进程，静态回执凭证无法防范同一 OS 权限域内的越权篡改。
- **挡不了接收方主动放弃校验**：校验器是防御工具，接收方必须在执行授权级指令前主动调用校验；若接收方选择盲目相信 `<cross-session-message>`，本方案不代偿。
