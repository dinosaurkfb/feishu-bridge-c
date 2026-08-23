/**
 * 本地原子 outbox —— 任何在本机产生的关键进展都往这里追加，出站发布器负责排空。
 *
 * 存在的理由：进展不该只在 Frank 发问时才流出去。长期任务自己干完一件事、
 * 做了一个决定、撞上一个风险，Frank 应该自动收到，而不是需要先想起来去问。
 *
 * 只收五类（与需求一致）：里程碑、决定、风险、待人工拍板、下一步。
 * 完整对话、模型思维过程、工具轨迹一律不进 outbox。
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeLocalInput } from "./turn-input.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";

/**
 * `reply` 是一轮对话的**原文答复**，由 Stop 钩子从 last_assistant_message 直接取，
 * 不经任何模型判断。它和下面五类的区别是根本性的：
 *
 *   五类   = 我判断「这件事值不值得报告」，然后压成一句话
 *   reply  = 我说了什么就发什么，没有判断，也就没有判断错的可能
 *
 * 之所以要有 reply：漏发的代价（Frank 走开了，结果只躺在他看不见的终端里）
 * 远大于多发的代价（一条他已经读过的消息）。用一个会出错的判断去决定发不发，
 * 是拿便宜的错误换昂贵的错误。
 *
 * 五类随之退居二线，只服务**没有对话轮次可依附**的东西 —— 比如绑定到期体检，
 * 那是钩子生成的，不属于任何一轮回答。我不再手写它们。
 */
export const KINDS = ["reply", "milestone", "decision", "risk", "pending", "next"];

/** reply 没有标签：它不是某一类进展，它就是答复本身。 */
export const KIND_LABEL = {
  milestone: "里程碑",
  decision: "决定",
  risk: "风险",
  pending: "待你拍板",
  next: "下一步",
};

/** 单条消息的字数上限。截断会丢信息，但整条发不出去丢得更多。 */
export const MAX_REPLY_CHARS = 4000;

/** 一条进展一个文件：先完整写临时文件，再原子提交最终目录项；排空时逐条标记。 */
export function appendEvent({
  outboxDir, kind, text, source, eventKey, publishEligible = false,
  inputText, inputOrigin, targetGenerationId, runId,
}) {
  if (!KINDS.includes(kind)) {
    return { ok: false, reason: "unknown_kind", allowed: KINDS };
  }
  const body = String(text ?? "").trim();
  if (body.length === 0) return { ok: false, reason: "empty_text" };

  fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });

  // 有稳定事件键时按事件去重。Stop 钩子的正确身份是「哪条 thread 的哪一轮」，
  // 不是「正文刚好写了什么」：两轮合法答复完全相同，第二轮仍然必须发；同一轮钩子
  // 重入，则绝不能发两遍。没有事件键的旧调用方继续按内容判重，保持原行为。
  const normalizedEventKey = typeof eventKey === "string" && eventKey.trim()
    ? eventKey.trim()
    : null;
  const fingerprintInput = normalizedEventKey === null
    // 保持升级前的算法，已有 outbox 文件名继续参与去重，不制造一次性重复。
    ? kind + "\n" + body
    : "event\n" + normalizedEventKey;
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 16);
  const existing = fs.readdirSync(outboxDir).filter((f) => f.includes(fingerprint));
  if (existing.length > 0) return { ok: false, reason: "duplicate", fingerprint };

  // 稳定事件键使用确定性文件名，并通过 hard-link 的 EEXIST 取得原子写入权。
  // Stop hook 与 watcher 可能并发到达；单纯 readdir 后 rename 是 check-then-act，两个进程
  // 都可能判定“不重复”。旧调用方继续使用时间前缀，避免改变 Claude 现有文件布局。
  const id = normalizedEventKey === null ? Date.now() + "-" + fingerprint : "event-" + fingerprint;
  const file = path.join(outboxDir, id + ".json");
  const tmp = file + ".tmp." + randomUUID();
  const createdAt = new Date().toISOString();
  const localInput = kind === "reply" && inputOrigin === "local"
    ? normalizeLocalInput(inputText)
    : "";
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: "1.0",
    artifact_type: "codex_feishu_bridge_event",
    zone: "work",
    classification: "internal",
    id, kind, text: body,
    event_key: normalizedEventKey,
    source: source ?? "unknown",
    // 只允许把本机 Desktop/CLI 的人类输入和 reply 绑在一起。飞书入站原文已经存在于
    // 目标话题，不能再写进这里让机器人复读；非 reply 进展也没有可配对的人类输入。
    input_origin: localInput ? "local" : null,
    input_text: localInput || null,
    // INV-9：目标在 outbox 形成时冻结。飞书来源取受理 claim 的 origin generation；
    // 本地来源取此刻 active generation。旧事件没有该字段，发布器才回落到当前 active。
    target_channel_generation_id: typeof targetGenerationId === "string" && targetGenerationId
      ? targetGenerationId
      : null,
    run_id: typeof runId === "string" && runId ? runId : null,
    created_at: createdAt,
    // Codex 自动发布只消费显式取得发布资格的事件。升级前积压的 outbox、以及尚未经过
    // 严格终局确认的入站答复都没有这个标记，不能因为下一轮 Stop 就被顺带发出去。
    publish_eligible_at: publishEligible === true ? createdAt : null,
    published_at: null,
  }, null, 2) + "\n", { mode: 0o600 });
  if (normalizedEventKey === null) {
    fs.renameSync(tmp, file);
  } else {
    try {
      // tmp 已完整落盘；link 要么原子创建最终目录项，要么以 EEXIST 明确输掉竞态。
      fs.linkSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      if (err.code === "EEXIST") return { ok: false, reason: "duplicate", fingerprint };
      throw err;
    }
    fs.rmSync(tmp, { force: true });
  }
  return { ok: true, id, file };
}

export function listPending({ outboxDir }) {
  let files;
  try {
    files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(outboxDir, f), "utf-8"));
      if (rec.published_at === null && !rec.publish_suppressed_at) {
        out.push({ ...rec, _file: path.join(outboxDir, f) });
      }
    } catch {
      /* 半截文件：下轮再说，不当失败 */
    }
  }
  return out;
}

export function markSent(rec, messageId) {
  const next = { ...rec, published_at: new Date().toISOString(), feishu_message_id: messageId ?? null };
  delete next._file;
  const tmp = rec._file + ".tmp." + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, rec._file);
}

/**
 * 在严格终局确认后，把一个既有事件提升为自动发布候选。
 *
 * Codex 入站回合的 Stop 可能先于 watcher 到达；Stop 只负责保存原文，只有 watcher 同时
 * 观察到目标 thread、turn.completed、exit 0 和非空最终输出后才调用这里。按 event key
 * 找而不是按文件名猜，重复调用幂等，已发布事件也不会被复活。
 */
export function markPublishEligibleByEventKey({ outboxDir, eventKey }) {
  if (typeof eventKey !== "string" || !eventKey.trim()) return { ok: false, reason: "no_event_key" };
  let files;
  try {
    files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { ok: false, reason: "event_not_found" };
  }
  for (const name of files) {
    const file = path.join(outboxDir, name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { continue; }
    if (rec.event_key !== eventKey) continue;
    if (rec.published_at !== null) return { ok: true, changed: false, reason: "already_published", record: rec };
    if (typeof rec.publish_eligible_at === "string" && rec.publish_eligible_at) {
      return { ok: true, changed: false, reason: "already_eligible", record: { ...rec, _file: file } };
    }
    const next = { ...rec, publish_eligible_at: new Date().toISOString() };
    const tmp = file + ".tmp." + randomUUID();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, changed: true, record: { ...next, _file: file } };
  }
  return { ok: false, reason: "event_not_found" };
}

/** 保留原始事件作审计，但把严格终局失败对应的半成品答复移出所有发布队列。 */
export function suppressPublishByEventKey({ outboxDir, eventKey, reason }) {
  if (typeof eventKey !== "string" || !eventKey.trim()) return { ok: false, reason: "no_event_key" };
  let files;
  try {
    files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { ok: false, reason: "event_not_found" };
  }
  for (const name of files) {
    const file = path.join(outboxDir, name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { continue; }
    if (rec.event_key !== eventKey) continue;
    if (rec.published_at !== null) return { ok: false, reason: "already_published" };
    if (rec.publish_suppressed_at) return { ok: true, changed: false, reason: "already_suppressed" };
    const next = {
      ...rec,
      publish_eligible_at: null,
      publish_suppressed_at: new Date().toISOString(),
      publish_suppressed_reason: String(reason ?? "strict_terminal_failure").slice(0, 200),
    };
    const tmp = file + ".tmp." + randomUUID();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, changed: true };
  }
  return { ok: false, reason: "event_not_found" };
}

/**
 * 把若干条待发内容合成一条飞书消息 —— 一条发一条会把话题刷爆。
 *
 * reply 必须原样渲染：给一段两千字的答复加上「· 」前缀和【】分组，
 * 等于把它揉烂。它不是一条进展，它就是正文。
 */
export function composeDigest(records, { taskName }) {
  const replies = records.filter((r) => r.kind === "reply");
  const rest = records.filter((r) => r.kind !== "reply");

  const parts = [];

  for (const r of replies) parts.push(r.text);

  if (rest.length > 0) {
    const byKind = new Map();
    for (const r of rest) {
      if (!byKind.has(r.kind)) byKind.set(r.kind, []);
      byKind.get(r.kind).push(r);
    }
    const lines = [taskName + " · 进展"];
    for (const kind of KINDS) {
      const items = byKind.get(kind);
      if (!items || items.length === 0) continue;
      lines.push("", "【" + KIND_LABEL[kind] + "】");
      for (const it of items) lines.push("· " + it.text);
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n———\n\n");
}

// ---------- CLI ----------

if (isDirectRun(import.meta.url)) {
  const SELF_ROOT = moduleRoot(import.meta.url, "..");
  const arg = (n) => {
    const i = process.argv.indexOf("--" + n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };

  // 会话不一定起在项目里，命令也不一定从项目里发。落点按这个顺序定：
  // 显式 --project > 登记表里包含 cwd 的项目 > 本仓库自己。
  // 定错落点比记不上更糟 —— 进展会掉进一个没人排空的目录里。
  const { loadRegistry, isUnder } = await import("./registry.mjs");
  const explicit = arg("project");
  const owning = loadRegistry().projects.find((p) => isUnder(process.cwd(), p.root));
  const ROOT = explicit ?? owning?.root ?? SELF_ROOT;
  const outboxDir = path.join(ROOT, ".runtime-data", "outbound", "outbox");

  if (process.argv.includes("--list")) {
    const pending = listPending({ outboxDir });
    console.log(path.basename(ROOT) + " 待发布 " + pending.length + " 条");
    for (const r of pending) console.log("  [" + KIND_LABEL[r.kind] + "] " + r.text.slice(0, 70));
    process.exit(0);
  }

  const r = appendEvent({
    outboxDir, kind: arg("kind"), text: arg("text"), source: arg("source") ?? "cli",
  });
  if (!r.ok) {
    console.error("未记录：" + r.reason + (r.allowed ? "（可用：" + r.allowed.join("/") + "）" : ""));
    process.exit(r.reason === "duplicate" ? 0 : 1);
  }
  console.log("已记录 " + r.id + " → " + path.basename(ROOT));
}
