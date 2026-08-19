#!/bin/sh
# 重启 aily daemon，并保证它拿得到本地代理。
#
# 为什么需要这个脚本：`aily-cli daemon start` 用**硬编码白名单**构造 daemon 环境
# （PATH / HOME / TMPDIR / USER / LOGNAME + AILY_CLI_*），代理变量不在其中。
# 所以 `HTTP_PROXY=... aily-cli daemon restart` 是无效的 —— 变量在启动那一步就被丢掉。
# `AILY_CLI_FORWARD_ENV` 是那个白名单的补充口：列在里面的变量才会被转发进去。
#
# 这个坑最坏的地方是它的伪装：daemon 拿不到代理 → 模型 API 请求失败 → 报文显示成
# 「Claude Code 鉴权失败，请检查 ANTHROPIC_AUTH_TOKEN / 运行 claude auth login」。
# 查凭据是白查，凭据一直是好的。而且 daemon 每次重启（升级、开机自启、崩溃拉起）
# 都会退回没有代理的状态，故障反复复发。
#
# 用法：sh scripts/aily-daemon-restart.sh

set -e

PROXY_HOST=127.0.0.1
PROXY_PORT=10808
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

say() { printf '%s\n' "$*"; }

# ---------- 1. 先确认代理真的在监听 ----------
#
# 不通就别重启：重启会中断所有正在跑的 agent 会话，而拿到一个指向死端口的代理
# 比没有代理更糟 —— 前者所有出站请求都超时。
#
# 用 nc，不用 `/dev/tcp/...` —— 那是 bash 特性，zsh 下无论端口开没开都会失败，
# 照它判断会得到「代理是死的」这种假结论（2026-08-19 因此误报过三次）。
if ! command -v nc >/dev/null 2>&1; then
  say "✗ 找不到 nc，无法探测代理端口。装一个或手工确认 ${PROXY_URL} 可用后再重启。"
  exit 1
fi

if ! nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null; then
  say "✗ ${PROXY_URL} 没在监听 —— 先把 VPN / xray 起起来，再跑这个脚本。"
  say "  现在重启只会得到一个拿着死代理的 daemon，症状会伪装成「鉴权失败」。"
  exit 1
fi
say "✓ 代理在监听：${PROXY_URL}"

# ---------- 2. 带着代理重启 ----------
#
# NO_PROXY 要含 .feishu.cn / .larksuite.com：daemon 到飞书网关直连是通的，
# 绕代理只会更慢，还可能因为节点在境外而握手失败。
export HTTP_PROXY="$PROXY_URL"
export HTTPS_PROXY="$PROXY_URL"
export NO_PROXY="localhost,127.0.0.1,::1,.cn,.feishu.cn,.larksuite.com,.aliyuncs.com"
export AILY_CLI_FORWARD_ENV="HTTP_PROXY,HTTPS_PROXY,NO_PROXY"

say "→ 重启 daemon…"
aily-cli daemon restart --yes

# ---------- 3. 自检：光看「restarted」不算数 ----------
sleep 4

# 按进程名精确匹配，不用 -f 匹配命令行子串：后者会撞上「命令行里恰好含这串字面量」
# 的进程（比如正在跑这个检查的 shell 自己）。
PID=$(pgrep -x aily-daemon | head -1 || true)

# 必须挡住空值。`ps eww` **不带 pid 参数会列出所有进程**，那样下面的计数会数到
# 别的进程的代理变量，把「没转发成功」误报成「✓ 已转发」——
# 2026-08-19 调试这个脚本时就真的被这么骗过一次。
if ! printf '%s' "$PID" | grep -qE '^[0-9]+$'; then
  say "✗ 重启后找不到 daemon 进程（pgrep -x aily-daemon 无结果）。"
  exit 1
fi

# 变量到底有没有进到 daemon 里 —— 这是这个脚本存在的全部理由，必须验。
FORWARDED=$(ps eww "$PID" 2>/dev/null | tr ' ' '\n' | grep -c '^HTTPS\?_PROXY=' || true)
if [ "$FORWARDED" -ge 2 ]; then
  say "✓ 代理变量已转发进 daemon (pid $PID)"
else
  say "✗ daemon (pid $PID) 里没有代理变量 —— 转发没生效，模型请求会报成鉴权失败。"
  say "  检查 aily-cli 版本是否还支持 AILY_CLI_FORWARD_ENV。"
  exit 1
fi

# 平台侧认不认这台机器在线，是另一回事：本地 websocket 看着连着、
# 网关那边仍可能因为心跳断了而判离线。必须问 doctor。
say "→ 复查运行状态…"
aily-cli doctor 2>&1 | grep -E "Runtime status|Gateway WS|Auth credential" || true

say ""
say "如果 Runtime status 仍是 Offline，等十几秒再跑一次 aily-cli doctor —— 心跳需要一轮才上报。"
