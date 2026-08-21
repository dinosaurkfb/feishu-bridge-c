/**
 * Claude / Codex 共享出站卡片。
 *
 * 一条本地回合由“你的输入 + Agent 回复”组成同一张 Card 2.0；飞书入站回合没有
 * input_text，因此只渲染回复，避免把话题里已经存在的人类消息再发送一次。
 */

import { composeDigest } from "./outbox.mjs";

const MAX_TITLE_CHARS = 80;
const MAX_SUMMARY_CHARS = 120;
const MAX_BODY_CHARS = 8_000;
const COLLAPSE_REPLY_AFTER_CHARS = 1_800;
const COLLAPSE_INPUT_AFTER_CHARS = 900;

const RUNTIME = {
  codex: { label: "Codex" },
  claude: { label: "Claude" },
};

const PRESENTATION = {
  reply: {
    label: "本轮答复", background: "blue-50", accent: "blue",
  },
  milestone: {
    label: "里程碑", background: "green-50", accent: "green",
  },
  decision: {
    label: "决定", background: "blue-50", accent: "blue",
  },
  risk: {
    label: "风险", background: "red-50", accent: "red",
  },
  pending: {
    label: "待你拍板", background: "orange-50", accent: "orange",
  },
  next: {
    label: "下一步", background: "blue-50", accent: "blue",
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
  return { ...PRESENTATION[kind], kind };
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
  return record.input_text.trim();
}

/** 飞书会话列表不解析卡片正文；summary 必须自行提供一条可读的纯文本预览。 */
function firstPlainLine(value) {
  const lines = String(value ?? "").split(/\r?\n/gu);
  const requestAt = lines.findIndex((line) =>
    /^\s*#{1,6}\s*(?:my request|我的请求)\s*:?\s*$/iu.test(line));
  const candidates = requestAt >= 0 ? lines.slice(requestAt + 1) : lines;
  for (const rawLine of candidates) {
    const line = rawLine
      .replace(/<\s*at\b[^>]*>.*?<\s*\/\s*at\s*>/giu, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/<[^>]+>/gu, "")
      .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s*/u, "")
      .replace(/[*_~`]+/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (line) return line;
  }
  return "";
}

function conversationSummary(records, { input, status, title }) {
  if (input) {
    const local = firstPlainLine(input);
    if (local) return truncate(local, MAX_SUMMARY_CHARS);
  }
  const primary = records.find((record) => record?.kind === status.kind) ?? records[0];
  const detail = firstPlainLine(primary?.text);
  if (detail) {
    const summary = status.kind === "reply" ? detail : status.label + "：" + detail;
    return truncate(summary, MAX_SUMMARY_CHARS);
  }
  return truncate(title + " · " + status.label, MAX_SUMMARY_CHARS);
}

/** 动态任务名进入 metadata markdown 前先降为单行普通文本，不能获得 Markdown 语义。 */
function escapeMetadataText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[&<>*`_~#\[\]()]/gu, (char) => "&#" + char.codePointAt(0) + ";");
}

function renderBody(records, { taskName }) {
  const raw = neutralizeCardMentions(composeDigest(records, { taskName }));
  return raw.length <= MAX_BODY_CHARS
    ? raw
    : raw.slice(0, MAX_BODY_CHARS) + "\n\n…（卡片正文已截断，完整内容保留在本机 outbox）";
}

function shortBlock({ title, content, background, accent = "grey", elementId }) {
  return {
    tag: "column_set",
    element_id: elementId,
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

function contentBlock({ title, content, background, accent, collapseAfter, elementId }) {
  if (content.length <= collapseAfter) {
    return shortBlock({ title, content, background, accent, elementId });
  }
  return {
    tag: "collapsible_panel",
    element_id: elementId,
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

/** 精确任务名和运行时保留在最底部，不与会话列表摘要争夺注意力。 */
function metadataBlock({ title, runtime }) {
  return {
    tag: "column_set",
    element_id: "bridge_meta",
    flex_mode: "none",
    horizontal_spacing: "8px",
    margin: "0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      background_style: "grey-50",
      padding: "8px 12px",
      vertical_spacing: "0px",
      elements: [{
        tag: "markdown",
        icon: { tag: "standard_icon", token: "ai-common_colorful" },
        content: "**" + escapeMetadataText(title) + "** · " +
          "<font color='grey'>" + runtime.label + "</font>",
        text_size: "notation",
        margin: "0px",
      }],
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
  if (!card?.config?.summary?.content) problems.push("missing_conversation_summary");
  if (card?.header !== undefined) problems.push("unexpected_top_header");
  const elements = card?.body?.elements;
  if (!Array.isArray(elements) || elements.length < 2 || elements.length > 5) {
    problems.push("body_block_count_out_of_range");
  }
  if (elements?.at(-1)?.element_id !== "bridge_meta") {
    problems.push("metadata_not_last");
  }
  const serialized = JSON.stringify(card ?? {});
  if (/"tag":"(?:button|form|input|select_|checker|overflow)/u.test(serialized)) {
    problems.push("unexpected_interaction");
  }
  if (/"behaviors"/u.test(serialized)) problems.push("unexpected_callback");
  return { ok: problems.length === 0, problems };
}

/** Card 2.0 / default / 无顶栏 / 2–3 个视觉块 / 无回调。 */
export function composeOutboundCard(records, { taskName, runtime = "codex" } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("卡片没有可发布事件");
  const runtimeInfo = RUNTIME[runtime] ?? RUNTIME.codex;
  const status = presentationFor(records);
  const title = truncate(taskName || runtimeInfo.label + " 长期任务", MAX_TITLE_CHARS);
  const input = localInputOf(records);
  const content = renderBody(records, { taskName: title });
  const detailTitle = records.some((record) => record?.kind === "reply")
    ? runtimeInfo.label + " 回复"
    : status.label + "详情";
  const elements = [];
  if (input) {
    elements.push(contentBlock({
      title: "你的输入",
      content: neutralizeCardMentions(input),
      background: "grey-50",
      accent: "grey",
      collapseAfter: COLLAPSE_INPUT_AFTER_CHARS,
      elementId: "user_input",
    }));
  }
  elements.push(contentBlock({
    title: detailTitle,
    content,
    background: status.background,
    accent: status.accent,
    collapseAfter: COLLAPSE_REPLY_AFTER_CHARS,
    elementId: "agent_reply",
  }));
  elements.push(metadataBlock({
    title,
    runtime: runtimeInfo,
  }));

  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: true,
      summary: { content: conversationSummary(records, { input, status, title }) },
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
