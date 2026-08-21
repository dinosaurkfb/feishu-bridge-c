/**
 * Claude / Codex 共享出站卡片。
 *
 * 一条本地回合由“你的输入 + Agent 回复”组成同一张 Card 2.0；飞书入站回合没有
 * input_text，因此只渲染回复，避免把话题里已经存在的人类消息再发送一次。
 */

import { composeDigest } from "./outbox.mjs";

const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 8_000;
const COLLAPSE_REPLY_AFTER_CHARS = 1_800;
const COLLAPSE_INPUT_AFTER_CHARS = 900;

const RUNTIME = {
  codex: { label: "Codex", subtitle: "Codex 长期任务 · 自动回写" },
  claude: { label: "Claude", subtitle: "Claude 长期任务 · 自动回写" },
};

const PRESENTATION = {
  reply: {
    label: "本轮答复", template: "blue", tagColor: "blue", background: "blue-50",
    accent: "blue", detail: "{runtime} 已生成本轮最终答复",
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

function presentationFor(records, runtime) {
  const kinds = new Set(records.map((record) => record?.kind));
  const kind = PRIORITY.find((candidate) => kinds.has(candidate)) ?? "reply";
  const base = PRESENTATION[kind];
  return { ...base, detail: base.detail.replace("{runtime}", runtime.label) };
}

/** Card markdown 中的原生 <at> 会真的通知用户；自动回写正文只展示它，不产生新 mention。 */
export function neutralizeCardMentions(value) {
  return String(value ?? "")
    .replace(/<\s*at\b/giu, "&#60;at")
    .replace(/<\s*\/\s*at\s*>/giu, "&#60;/at>");
}

function localInputOf(records) {
  if (records.length !== 1) return null;
  const record = records[0];
  if (record?.kind !== "reply" || record?.input_origin !== "local" ||
      typeof record?.input_text !== "string" || !record.input_text.trim()) return null;
  return neutralizeCardMentions(record.input_text.trim());
}

function renderBody(records, { taskName }) {
  const raw = neutralizeCardMentions(composeDigest(records, { taskName }));
  return raw.length <= MAX_BODY_CHARS
    ? raw
    : raw.slice(0, MAX_BODY_CHARS) + "\n\n…（卡片正文已截断，完整内容保留在本机 outbox）";
}

function shortBlock({ title, content, background, accent = "grey" }) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    margin: "0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      background_style: background,
      padding: "12px",
      vertical_spacing: "4px",
      elements: [
        {
          tag: "markdown",
          content: "**<font color='" + accent + "'>" + title + "</font>**",
          text_size: "normal",
          margin: "0px",
        },
        { tag: "markdown", content, text_size: "normal", margin: "0px" },
      ],
    }],
  };
}

function contentBlock({ title, content, background, accent, collapseAfter }) {
  if (content.length <= collapseAfter) {
    return shortBlock({ title, content, background, accent });
  }
  return {
    tag: "collapsible_panel",
    expanded: false,
    background_color: background,
    border: { color: accent === "grey" ? "grey-200" : accent + "-200", corner_radius: "8px" },
    padding: "8px 12px 12px 12px",
    margin: "0px",
    header: {
      title: { tag: "plain_text", content: title + "（展开查看）" },
      background_color: background,
      width: "fill",
      icon: { tag: "standard_icon", token: "chat_outlined", color: accent },
      icon_position: "left",
    },
    elements: [{ tag: "markdown", content, text_size: "normal", margin: "0px" }],
  };
}

function statusBlock(status, count) {
  return {
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
          content: "<font color='grey'>" + status.detail + " · 共 " + count + " 条</font>",
          text_size: "notation",
          margin: "0px",
        },
      ],
    }],
  };
}

/** reply 必须一轮一张卡；无对话轮次可依附的进展可继续合批，避免刷屏。 */
export function outboundCardBatches(records) {
  const batches = [];
  let progress = [];
  const flush = () => {
    if (progress.length > 0) batches.push(progress);
    progress = [];
  };
  for (const record of records ?? []) {
    if (record?.kind === "reply") {
      flush();
      batches.push([record]);
    } else {
      progress.push(record);
    }
  }
  flush();
  return batches;
}

export function validateOutboundCard(card) {
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

/** Card 2.0 / default / 2–3 个视觉块 / 无回调。动态数据只进入内容字段。 */
export function composeOutboundCard(records, { taskName, runtime = "codex" } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("卡片没有可发布事件");
  const runtimeInfo = RUNTIME[runtime] ?? RUNTIME.codex;
  const status = presentationFor(records, runtimeInfo);
  const title = truncate(taskName || runtimeInfo.label + " 长期任务", MAX_TITLE_CHARS);
  const input = localInputOf(records);
  const content = renderBody(records, { taskName: title });
  const detailTitle = records.some((record) => record?.kind === "reply")
    ? runtimeInfo.label + " 回复"
    : status.label + "详情";
  const elements = [statusBlock(status, records.length)];
  if (input) {
    elements.push(contentBlock({
      title: "你的输入",
      content: input,
      background: "grey-50",
      accent: "grey",
      collapseAfter: COLLAPSE_INPUT_AFTER_CHARS,
    }));
  }
  elements.push(contentBlock({
    title: detailTitle,
    content,
    background: status.background,
    accent: status.accent,
    collapseAfter: COLLAPSE_REPLY_AFTER_CHARS,
  }));

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
      subtitle: { tag: "plain_text", content: runtimeInfo.subtitle },
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
      elements,
    },
  };

  const validation = validateOutboundCard(card);
  if (!validation.ok) throw new Error("出站卡片结构无效：" + validation.problems.join(","));
  return card;
}
