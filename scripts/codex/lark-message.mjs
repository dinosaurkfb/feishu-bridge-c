/** Codex 绑定维护专用的飞书消息操作；不扩大 Claude/Codex 共用发布器的导出面。 */

import { execFileSync } from "node:child_process";

import { assertPublishIdentity, identityErrorText } from "../chain-template.mjs";

function preflight({ configDir, profile, expectedAppId }) {
  if (!expectedAppId) return;
  const result = assertPublishIdentity({ configDir, profile, expectedAppId });
  if (!result.ok) throw new Error(identityErrorText(result));
}

/**
 * 编辑机器人自己发送的文本消息。用于修复已经存在的 Codex 根话题标题；不会创建新话题。
 * lark-cli 目前没有对应 typed command，所以这里使用官方 PUT OpenAPI escape hatch。
 */
export function updateTextMessage({
  profile, messageId, text, larkBin, larkHome, expectedAppId, timeoutMs,
}) {
  preflight({ configDir: larkHome, profile, expectedAppId });
  if (typeof messageId !== "string" || !messageId.startsWith("om_")) {
    throw new Error("待编辑消息缺少有效的 om_ id");
  }
  if (typeof text !== "string" || text.length === 0) throw new Error("待编辑消息正文为空");

  const body = JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) });
  const out = execFileSync(
    larkBin ?? "lark-cli",
    ["api", "PUT", "/open-apis/im/v1/messages/" + messageId,
     "--as", "bot", "--data", "-", "--json"],
    {
      encoding: "utf-8",
      input: body,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
             ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
      timeout: timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(out);
  if (!parsed?.ok) throw new Error("编辑消息失败: " + JSON.stringify(parsed?.error ?? parsed).slice(0, 300));
  return parsed.data?.message_id ?? messageId;
}
