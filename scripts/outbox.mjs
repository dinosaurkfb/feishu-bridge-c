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

export const KINDS = ["milestone", "decision", "risk", "pending", "next"];

export const KIND_LABEL = {
  milestone: "里程碑",
  decision: "决定",
  risk: "风险",
  pending: "待你拍板",
  next: "下一步",
};

/** 一条进展一个文件：追加是原子的（写临时文件再 rename），排空时逐条标记。 */
export function appendEvent({ outboxDir, kind, text, source }) {
  if (!KINDS.includes(kind)) {
    return { ok: false, reason: "unknown_kind", allowed: KINDS };
  }
  const body = String(text ?? "").trim();
  if (body.length === 0) return { ok: false, reason: "empty_text" };

  fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });

  // 内容指纹做去重：同一条进展被重复记录不应重复打扰 Frank。
  const fingerprint = createHash("sha256").update(kind + "\n" + body).digest("hex").slice(0, 16);
  const existing = fs.readdirSync(outboxDir).filter((f) => f.includes(fingerprint));
  if (existing.length > 0) return { ok: false, reason: "duplicate", fingerprint };

  const id = Date.now() + "-" + fingerprint;
  const file = path.join(outboxDir, id + ".json");
  const tmp = file + ".tmp." + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: "1.0",
    artifact_type: "codex_feishu_bridge_event",
    zone: "work",
    classification: "internal",
    id, kind, text: body,
    source: source ?? "unknown",
    created_at: new Date().toISOString(),
    published_at: null,
  }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
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
      if (rec.published_at === null) out.push({ ...rec, _file: path.join(outboxDir, f) });
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

/** 把若干条进展合成一条飞书消息 —— 一条进展发一条会把话题刷爆。 */
export function composeDigest(records, { taskName }) {
  const byKind = new Map();
  for (const r of records) {
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
  return lines.join("\n");
}

// ---------- CLI ----------

if (import.meta.url === "file://" + process.argv[1]) {
  const SELF_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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
