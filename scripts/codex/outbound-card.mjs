/**
 * Codex 出站卡片：把已经通过 outbox / 严格终局资格校验的事件，确定性渲染为 Card 2.0。
 *
 * 卡片只负责呈现，不参与完成判断、路由或授权。根绑定消息仍是文本；只有 Codex 的话题回复
 * 使用这里的卡片，从而不破坏首次绑定依赖的根消息引用和六位绑定码。
 */

import { composeDigest } from "../outbox.mjs";

const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 8_000;
const COLLAPSE_AFTER_CHARS = 1_800;

const PRESENTATION = {
  reply: {
    label: "本轮答复", template: "blue", tagColor: "blue", background: "blue-50",
    accent: "blue", detail: "Codex 已生成本轮最终答复",
  },
  milestone: {
    label: "里程碑", template: "green", tagColor: "green", background: "green-50",
    accent: "green", detail: "长期任务报告了一个关键进展",
  },
  decision: {
    label: "决定", template: "blue", tagColor: "blue", background: "blue-50",
    accent: "blue", detail: "长期任务记录了一项决定",
  },
  risk: {
    label: "风险", template: "red", tagColor: "red", background: "red-50",
    accent: "red", detail: "任务未正常完成或存在需要处理的风险",
  },
  pending: {
    label: "待你拍板", template: "orange", tagColor: "orange", background: "orange-50",
    accent: "orange", detail: "长期任务正在等待人工决定",
  },
  next: {
    label: "下一步", template: "blue", tagColor: "blue", background: "blue-50",
    accent: "blue", detail: "长期任务给出了后续行动",
  },
};

const PRIORITY = ["risk", "pending", "milestone", "decision", "next", "reply"];

function truncate(value, max, suffix = "…") {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

function presentationFor(records) {
  const kinds = new Set(records.map((record) => record?.kind));
  const kind = PRIORITY.find((candidate) => kinds.has(candidate)) ?? "reply";
  return PRESENTATION[kind];
}

/** Card markdown 中的原生 <at> 会真的通知用户；自动回写正文只展示它，不产生新 mention。 */
export function neutralizeCardMentions(value) {
  return String(value ?? "")
    .replace(/<\s*at\b/giu, "&#60;at")
    .replace(/<\s*\/\s*at\s*>/giu, "&#60;/at>");
}

function renderBody(records, { taskName }) {
  const raw = neutralizeCardMentions(composeDigest(records, { taskName }));
  return raw.length <= MAX_BODY_CHARS
    ? raw
    : raw.slice(0, MAX_BODY_CHARS) + "\n\n…（卡片正文已截断，完整内容保留在本机 outbox）";
}

function bodyElement(content, status) {
  if (content.length <= COLLAPSE_AFTER_CHARS) {
    return { tag: "markdown", content, text_size: "normal", margin: "0px" };
  }
  return {
    tag: "collapsible_panel",
    expanded: false,
    background_color: "grey-50",
    border: { color: "grey-200", corner_radius: "8px" },
    padding: "8px 12px 12px 12px",
    margin: "0px",
    header: {
      title: { tag: "plain_text", content: "展开查看完整" + status.label },
      background_color: "grey-50",
      width: "fill",
      icon: { tag: "standard_icon", token: "chat_outlined", color: status.accent },
      icon_position: "left",
    },
    elements: [{ tag: "markdown", content, text_size: "normal", margin: "0px" }],
  };
}

export function validateCodexOutboundCard(card) {
  const problems = [];
  if (card?.schema !== "2.0") problems.push("schema_not_2_0");
  if (card?.config?.width_mode !== "default") problems.push("width_not_default");
  if (!card?.header?.title?.content) problems.push("missing_header_title");
  if (!card?.header?.template) problems.push("missing_header_template");
  const elements = card?.body?.elements;
  if (!Array.isArray(elements) || elements.length < 2 || elements.length > 5) {
    problems.push("body_block_count_out_of_range");
  }
  if (elements?.[0]?.tag !== "column_set" || elements?.[0]?.columns?.[0]?.tag !== "column") {
    problems.push("missing_status_container");
  }
  const serialized = JSON.stringify(card ?? {});
  if (/"tag":"(?:button|form|input|select_|checker|overflow)/u.test(serialized)) {
    problems.push("unexpected_interaction");
  }
  if (/"behaviors"/u.test(serialized)) problems.push("unexpected_callback");
  return { ok: problems.length === 0, problems };
}

/**
 * Card 2.0 / default / header + 状态 column_set + 正文 markdown（长正文折叠），无回调。
 * 结构由代码固定，动态数据只能进入 plain_text / markdown 内容字段。
 */
export function composeCodexOutboundCard(records, { taskName }) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("卡片没有可发布事件");
  const status = presentationFor(records);
  const title = truncate(taskName || "Codex 长期任务", MAX_TITLE_CHARS);
  const content = renderBody(records, { taskName: title });
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: true,
      summary: { content: truncate(title + " · " + status.label, 120) },
    },
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: "Codex 长期任务 · 自动回写" },
      template: status.template,
      icon: { tag: "standard_icon", token: "ai-common_colorful" },
      text_tag_list: [{
        tag: "text_tag",
        text: { tag: "plain_text", content: status.label },
        color: status.tagColor,
      }],
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "8px",
          margin: "0px",
          columns: [{
            tag: "column",
            width: "weighted",
            weight: 1,
            background_style: status.background,
            padding: "12px",
            vertical_spacing: "4px",
            elements: [
              {
                tag: "markdown",
                content: "**<font color='" + status.accent + "'>" + status.label + "</font>**",
                text_size: "heading-3",
                margin: "0px",
              },
              {
                tag: "markdown",
                content: "<font color='grey'>" + status.detail + " · 共 " + records.length + " 条</font>",
                text_size: "notation",
                margin: "0px",
              },
            ],
          }],
        },
        bodyElement(content, status),
      ],
    },
  };

  const validation = validateCodexOutboundCard(card);
  if (!validation.ok) throw new Error("Codex 出站卡片结构无效：" + validation.problems.join(","));
  return card;
}
