/**
 * Claude / Codex 共享出站卡片。
 *
 * 一条本地回合由“你的输入 + Agent 回复”组成同一张 Card 2.0；飞书入站回合没有
 * input_text，因此只渲染回复，避免把话题里已经存在的人类消息再发送一次。
 */

import { composeDigest } from "./outbox.mjs";

const MAX_TITLE_CHARS = 80;
const MAX_SUMMARY_CHARS = 120;
const MAX_QUOTE_CHARS = 1_200;
const MAX_BODY_CHARS = 8_000;

/**
 * **一张飞书卡片里最多 5 个 markdown 表格。**
 *
 * 这不是猜的，是撞出来的：cc2cd 有三条 `/feishu-status` 回复各含 6 个表格，
 * 每一条都被飞书拒掉 —— `ErrCode: 11310; ErrMsg: card table number over limit`。
 * 两个项目 331 条 outbox 记录跑出来的分布把界线钉死在 5 和 6 之间：
 * 0/1/2 个表格的全部成功，5 个的那一条成功，6 个的三条全失败。
 *
 * **本地能算的约束不许出网去撞。**上一版 validateOutboundCard 对这三条判 ok=true，
 * 于是它们出网、被拒、然后每 30 分钟重试一次，空转了 12 小时。
 */
const MAX_CARD_TABLES = 5;

/**
 * markdown 表格的分隔行 —— `|---|---|`、`| :--- | ---: |` 都算。
 * **一张表恰好有一行分隔行**，所以数它就是数表。
 */
const TABLE_SEPARATOR = /^[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/u;

const isTableRow = (line) => line.includes("|") && line.trim() !== "";

/**
 * 找出所有表格块。返回 [{start, end}]（含首含尾的行下标）。
 *
 * 判据：一行分隔行，**上一行也得是表格行**（否则那只是一串减号，不是表）。
 */
function markdownTableBlocks(lines) {
  const blocks = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!TABLE_SEPARATOR.test(lines[i])) continue;
    if (!isTableRow(lines[i - 1])) continue;
    // 已经在上一块里了就别重复计数（连着两行分隔行的畸形输入）。
    if (blocks.length > 0 && i <= blocks[blocks.length - 1].end) continue;
    let end = i;
    while (end + 1 < lines.length && isTableRow(lines[end + 1])) end += 1;
    blocks.push({ start: i - 1, end });
  }
  return blocks;
}

/** 数出一段 markdown 里有几个表格。 */
export function countMarkdownTables(text) {
  return markdownTableBlocks(String(text ?? "").split("\n")).length;
}

/**
 * 超出上限的表格**降级成纯文本**，而不是把整条内容拦下来。
 *
 * 拦下来的话那条答复永远发不出去 —— 而它是要给手机上的人看的。
 * 降级是有损的，所以**必须说出来**：不声明的改写等于替他决定他看到什么。
 */
export function capMarkdownTables(text, limit = MAX_CARD_TABLES) {
  const lines = String(text ?? "").split("\n");
  const blocks = markdownTableBlocks(lines);
  if (blocks.length <= limit) return String(text ?? "");
  const degraded = blocks.slice(limit);
  const out = [];
  let at = 0;
  for (const block of degraded) {
    out.push(...lines.slice(at, block.start));
    for (let i = block.start; i <= block.end; i += 1) {
      if (TABLE_SEPARATOR.test(lines[i])) continue;   // 分隔行降级后没有意义
      const cells = lines[i].trim().replace(/^\||\|$/gu, "").split("|")
        .map((c) => c.trim()).filter((c) => c !== "");
      out.push(cells.join("：" ));
    }
    at = block.end + 1;
  }
  out.push(...lines.slice(at));
  return "> <font color='grey'>本条含 " + blocks.length +
    " 个表格，超出飞书单卡上限 " + limit + " 个；第 " + (limit + 1) +
    " 个起已改为纯文本。</font>\n\n" + out.join("\n");
}

const RUNTIME = {
  codex: { label: "Codex" },
  claude: { label: "Claude" },
};

const PRESENTATION = {
  reply: { label: "本轮答复" },
  milestone: { label: "里程碑" },
  decision: { label: "决定" },
  risk: { label: "风险" },
  pending: { label: "待你拍板" },
  next: { label: "下一步" },
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
function requestLines(value) {
  const lines = String(value ?? "").split(/\r?\n/gu);
  const requestAt = lines.findIndex((line) =>
    /^\s*#{1,6}\s*(?:my request|我的请求)\s*:?\s*$/iu.test(line));
  return requestAt >= 0 ? lines.slice(requestAt + 1) : lines;
}

function plainLine(rawLine) {
  return String(rawLine ?? "")
    .replace(/<\s*at\b[^>]*>.*?<\s*\/\s*at\s*>/giu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u, "")
    .replace(/[*~`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function firstPlainLine(value) {
  for (const rawLine of requestLines(value)) {
    const line = plainLine(rawLine);
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

/** 动态普通文本进入 card markdown 前不能获得 Markdown 或 mention 语义。 */
function escapeMarkdownText(value) {
  return String(value ?? "")
    .replace(/[&<>*`_~#:\[\]()]/gu, (char) => "&#" + char.codePointAt(0) + ";");
}

function quoteText(value) {
  const text = requestLines(value).map(plainLine).filter(Boolean).join("\n");
  return truncate(text, MAX_QUOTE_CHARS);
}

function renderBody(records, { taskName }) {
  // **先降级表格，再截长度。**反过来的话降级说明可能正好被截掉，
  // 于是内容改了却没人知道。
  const raw = capMarkdownTables(neutralizeCardMentions(composeDigest(records, {
    taskName: escapeMarkdownText(taskName),
  })));
  return raw.length <= MAX_BODY_CHARS
    ? raw
    : raw.slice(0, MAX_BODY_CHARS) + "\n\n…（卡片正文已截断，完整内容保留在本机 outbox）";
}

function quoteBlock(content) {
  return {
    tag: "markdown",
    element_id: "user_quote",
    content: "> <font color='grey'>" +
      escapeMarkdownText(content).replace(/\n/gu, "<br>") + "</font>",
    text_size: "notation",
    margin: "0px",
  };
}

function replyBlock(content) {
  return {
    tag: "markdown",
    element_id: "agent_reply",
    content,
    text_size: "normal",
    margin: "0px",
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
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > 2) {
    problems.push("body_block_count_out_of_range");
  }
  if (elements?.some((element) => element?.tag !== "markdown")) {
    problems.push("unexpected_visual_container");
  }
  if (elements?.at(-1)?.element_id !== "agent_reply") {
    problems.push("reply_not_last");
  }
  if (elements?.length === 2 && elements[0]?.element_id !== "user_quote") {
    problems.push("quote_not_first");
  }
  const serialized = JSON.stringify(card ?? {});
  if (/"tag":"(?:button|form|input|select_|checker|overflow)/u.test(serialized)) {
    problems.push("unexpected_interaction");
  }
  if (/"behaviors"/u.test(serialized)) problems.push("unexpected_callback");
  // **表格数量是本地就能算的约束。**算不出来就只能出网去撞，
  // 而撞回来的是 400 —— 一个不会因为重试而变好的答案。
  const tables = (Array.isArray(elements) ? elements : [])
    .reduce((n, element) => n + countMarkdownTables(element?.content), 0);
  if (tables > MAX_CARD_TABLES) problems.push("card_table_over_limit");
  return { ok: problems.length === 0, problems, tables };
}

/** Card 2.0 / default / 无顶栏与底栏 / 灰色引用 + 纯回复 / 无回调。 */
export function composeOutboundCard(records, { taskName, runtime = "codex" } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("卡片没有可发布事件");
  const runtimeInfo = RUNTIME[runtime] ?? RUNTIME.codex;
  const status = presentationFor(records);
  const title = truncate(String(taskName || runtimeInfo.label + " 长期任务")
    .replace(/\s+/gu, " "), MAX_TITLE_CHARS);
  const input = localInputOf(records);
  const quote = input ? quoteText(input) : "";
  const content = renderBody(records, { taskName: title });
  const elements = [];
  if (quote) elements.push(quoteBlock(quote));
  elements.push(replyBlock(content));

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
      padding: "12px 16px 16px 16px",
      vertical_spacing: "12px",
      elements,
    },
  };

  const validation = validateOutboundCard(card);
  if (!validation.ok) throw new Error("出站卡片结构无效：" + validation.problems.join(","));
  return card;
}
