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

import { execFileSync } from "node:child_process";

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

/**
 * 经 COO助理CC 把草稿发布到绑定的根话题。
 *
 * 身份边界：出站只用 COO助理CC（lark-cli profile `claude`），绝不借用 M5Claude 的身份 ——
 * M5Claude 是入站运输层，让它发布进展会把两个方向的职责搅在一起。
 */
export function publishDraft({ profile, rootMessageId, text, larkBin, larkHome, timeoutMs }) {
  // 必须显式指定二进制和配置源：守望者是在 M5Claude 的清洗环境里被拉起的，
  // 那里 lark-cli 被重定向到按 agent 隔离的配置目录（只有 platform-bot），
  // 靠环境里“恰好是什么”会拿到错误的身份，实测就是这么发布失败的。
  const out = execFileSync(
    larkBin ?? "lark-cli",
    ["im", "+messages-reply", "--message-id", rootMessageId, "--as", "bot",
     "--reply-in-thread", "--text", text, "--json"],
    { encoding: "utf-8",
      // stderr 要捕获而不是继承。默认继承时 lark-cli 的报错 JSON 会直接喷进
      // 调用方的 stderr —— 出站发布器现在跑在会话结束钩子里，那等于喷到 Frank 的终端上。
      // 失败信息不会丢：execFileSync 抛出的 error 上带着 stdout/stderr。
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
             ...(larkHome ? { LARKSUITE_CLI_HOME: larkHome } : {}) },
      // 会话结束钩子会传一个更短的超时：那条路径卡住的是 Frank 的终端，
      // 不能为了发一条进展让他的会话吊在那里。发不出去就留在 outbox 等兜底定时器。
      timeout: timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  if (!parsed?.ok) throw new Error("发布失败: " + JSON.stringify(parsed?.error ?? parsed).slice(0, 300));
  return parsed.data?.message_id ?? null;
}

/**
 * 往群里发一条**新**消息，用来建立一个项目的根话题。
 *
 * 跟 publishDraft 分开而不是加个开关：那个函数只往已知话题里回复，是每天跑几十次的
 * 常规路径；这个是每个项目一辈子一次的建话题动作，而且失败方式完全不同 ——
 * 发重了会在群里留下一个撤不干净的孤儿话题。所以这里必须带幂等键，那个不需要。
 *
 * idempotencyKey 由调用方按项目绝对路径算，去重发生在**平台侧**：
 * 本地锁挡不住「消息发出去了、配置没写成」这种崩溃，平台侧幂等挡得住。
 */
export function sendToChat({ profile, chatId, text, idempotencyKey, larkBin, larkHome, timeoutMs }) {
  const args = ["im", "+messages-send", "--chat-id", chatId, "--as", "bot", "--text", text, "--json"];
  if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);

  const out = execFileSync(larkBin ?? "lark-cli", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
           ...(larkHome ? { LARKSUITE_CLI_HOME: larkHome } : {}) },
    timeout: timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  if (!parsed?.ok) throw new Error("建话题失败: " + JSON.stringify(parsed?.error ?? parsed).slice(0, 300));
  const id = parsed.data?.message_id;
  // 拿不到 message_id 就等于没有根话题，后面所有出站都发不出去。
  // 这里 fail-closed：宁可报错让人重来，也不要写一份指向 null 的绑定。
  if (typeof id !== "string" || !id.startsWith("om_")) {
    throw new Error("建话题成功但没拿到 om_ 消息 id：" + JSON.stringify(parsed.data ?? {}).slice(0, 200));
  }
  return id;
}

// ---------- CLI ----------

if (import.meta.url === "file://" + process.argv[1]) {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const RT = path.join(ROOT, ".runtime-data", "inbound");
  const runsDir = path.join(RT, "runs");
  const cfg = JSON.parse(fs.readFileSync(path.join(RT, "chain-config.json"), "utf-8"));
  const mapping = JSON.parse(fs.readFileSync(path.join(RT, "active-mapping.json"), "utf-8"));
  const doPublish = process.argv.includes("--publish");
  const only = (process.argv.find((a) => a.startsWith("--key=")) ?? "").slice(6);

  const runs = scanRuns({ runsDir }).filter((r) => !only || r.key.startsWith(only));

  for (const r of runs) {
    console.log([r.key.slice(0, 8), r.state.padEnd(9),
      r.shouldPublish ? "待发布" : r.alreadyPublished ? "已发布" : "不发布",
      "| " + r.truthful].join(" "));
  }

  const pending = runs.filter((r) => r.shouldPublish);
  if (!doPublish) {
    console.log("\n待发布 " + pending.length + " 条（加 --publish 才真的发送）");
    for (const r of pending) {
      console.log("\n--- 草稿 " + r.key.slice(0, 8) + " ---");
      console.log(buildDraft(r, { taskName: cfg.task_display_name }));
    }
  } else {
    const root = mapping.feishu_root_message_id_reference;
    if (!root) throw new Error("mapping 里没有根话题消息 ID，无法发布");
    for (const r of pending) {
      const text = buildDraft(r, { taskName: cfg.task_display_name });
      if (!text) continue;
      const mid = publishDraft({ profile: cfg.lark_cli_profile, rootMessageId: root, text,
        larkBin: cfg.lark_cli_bin, larkHome: cfg.lark_cli_home });
      markPublished({ runsDir, key: r.key, messageId: mid });
      console.log("已发布 " + r.key.slice(0, 8) + " -> " + mid);
    }
    if (pending.length === 0) console.log("没有待发布内容");
  }
}
