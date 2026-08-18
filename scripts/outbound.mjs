/**
 * 出站：观察长期任务的 run 结局，产出可发布的草稿。
 *
 * 这是「完成」语义的唯一归属地。入站不判断完成，claim 层不判断完成 —— 只有这里判断。
 *
 * 最重要的一条：blocked 和 failed 都**不是**完成。把它们发布成进展就是伪造成功，
 * 而伪造成功是这个项目最不能出的错。它们要如实发布为受阻/失败。
 */

import fs from "node:fs";
import path from "node:path";

import { readRunOutcome } from "./handoff.mjs";

const PUBLISHED_MARK = ".published.json";

/** 每种结局怎么对 Frank 表述。措辞必须让「没干成」一眼可辨。 */
const PRESENTATION = {
  completed: { label: "已完成", publish: true, truthful: "任务跑完且有非空产出" },
  blocked: { label: "受阻（权限）", publish: true, truthful: "工具被权限拦下，任务实际未完成" },
  failed: { label: "失败", publish: true, truthful: "任务以错误收场或产出为空" },
  running: { label: "进行中", publish: false, truthful: "还在跑，暂不发布" },
  missing: { label: "无日志", publish: false, truthful: "找不到 run 日志，需人工查证" },
};

export function scanRuns({ runsDir }) {
  let files;
  try {
    files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const out = [];
  for (const f of files) {
    const key = f.replace(/\.jsonl$/, "");
    const logPath = path.join(runsDir, f);
    const outcome = readRunOutcome(logPath);
    const pres = PRESENTATION[outcome.state] ?? PRESENTATION.missing;
    const publishedAt = readPublished(runsDir, key);

    out.push({
      key,
      logPath,
      state: outcome.state,
      label: pres.label,
      shouldPublish: pres.publish && publishedAt === null,
      alreadyPublished: publishedAt !== null,
      truthful: pres.truthful,
      finalText: outcome.finalText ?? null,
      deniedTools: outcome.deniedTools ?? null,
    });
  }
  return out;
}

function readPublished(runsDir, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, key + PUBLISHED_MARK), "utf-8")).published_at;
  } catch {
    return null;
  }
}

/** 发布后落标记，防止同一个 run 被重复发布到话题里。 */
export function markPublished({ runsDir, key, messageId }) {
  const file = path.join(runsDir, key + PUBLISHED_MARK);
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    published_at: new Date().toISOString(),
    feishu_message_id: messageId ?? null,
  }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 生成发布草稿。刻意保持确定性、不调模型 —— 摘要质量交给上游，
 * 但「说的是不是实话」这件事必须由确定性代码保证。
 */
export function buildDraft(run, { taskName }) {
  const head = taskName + " · " + run.label;

  if (run.state === "completed") {
    return [head, "", truncate(run.finalText, 1200)].join("\n");
  }
  if (run.state === "blocked") {
    return [
      head, "",
      "任务**没有完成**。以下工具被权限拦下：" + (run.deniedTools ?? []).join("、"),
      "",
      "任务自述：", truncate(run.finalText, 600),
      "",
      "需要放行相应权限后重新下达指令。",
    ].join("\n");
  }
  if (run.state === "failed") {
    return [
      head, "",
      "任务以失败收场，没有可采信的产出。",
      run.finalText ? "\n错误信息：" + truncate(run.finalText, 600) : "",
    ].join("\n");
  }
  return null; // running / missing 不产出草稿
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + "\n…（已截断）";
}

// ---------- CLI：只读扫描，不发送任何东西 ----------

if (import.meta.url === "file://" + process.argv[1]) {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const runsDir = path.join(ROOT, ".runtime-data", "inbound", "runs");
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, ".runtime-data", "inbound", "chain-config.json"), "utf-8"));
  const runs = scanRuns({ runsDir });

  for (const r of runs) {
    console.log([
      r.key.slice(0, 8),
      r.state.padEnd(9),
      r.shouldPublish ? "待发布" : r.alreadyPublished ? "已发布" : "不发布",
      "| " + r.truthful,
    ].join(" "));
  }

  const pending = runs.filter((r) => r.shouldPublish);
  console.log("\n待发布 " + pending.length + " 条");
  for (const r of pending) {
    console.log("\n--- 草稿 " + r.key.slice(0, 8) + " ---");
    console.log(buildDraft(r, { taskName: cfg.task_display_name }));
  }
}
