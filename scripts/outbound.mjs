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
import { randomUUID } from "node:crypto";
import { isCanonicalIso } from "./canonical-time.mjs";

import { assertPublishIdentity, identityErrorText } from "./chain-template.mjs";

import { execFileSync } from "node:child_process";

import { readRunOutcome } from "./handoff.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";

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
    const receipt = readRunReceipt({ runsDir, key });
    const publishedAt = receipt.state === "valid" ? receipt.publishedAt : null;

    out.push({
      key,
      logPath,
      state: outcome.state,
      label: pres.label,
      // 回执说不清时**两头都不许**：不发（可能双发）、也不当已发（可能漏发）。
      shouldPublish: pres.publish && receipt.state === "absent",
      alreadyPublished: receipt.state === "valid",
      receiptUnreadable: receipt.state === "unreadable"
        ? (receipt.why ?? "说不清") : null,
      truthful: pres.truthful,
      finalText: outcome.finalText ?? null,
      deniedTools: outcome.deniedTools ?? null,
    });
  }
  return out;
}

// readPublished 已被回执三态取代 —— "存在即已发"的判法把缺字段的回执
// 静默当成已送达，一条 run 结果就此永久消失（评审同款缺陷在 scanRuns 这层的分身）。

/** 发布后落标记，防止同一个 run 被重复发布到话题里。 */
/**
 * run 结果的**发布前原子 claim**。
 *
 * 回执（markPublished）写在发送**之后** —— 只有回执的话，两个并发 watcher
 * 会同时读到 shouldPublish、各发一张，评审实测真实双发。
 * claim 用 mkdir 的原子性在发送**之前**互斥；发完写回执再撤 claim。
 *
 * **协议是三步，缺一不可**：claim → **复核回执** → 发送。
 * 只有 claim 不够：A 发完释放 claim 后，晚到的 B 能拿到新 claim ——
 * 而 B 的 shouldPublish 是在 A 完成前读的（评审场景实测）。
 * claim 后复核回执才把这个窗口关上。
 *
 * **崩溃窗口仍是 at-least-once**（与全线口径一致）：发出后、写回执前崩掉，
 * claim 过期（stale）后会被接管重发。不存在"零双发"，只有"并发不双发"。
 */
export function claimRunPublish({ runsDir, key, staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const file = path.join(runsDir, key + ".publish-claim.json");
  const reapLock = file + ".reaplock";
  const token = randomUUID();
  const attempt = () => {
    try {
      // wx 单步原子创建（两步 mkdir+owner 被实测在步间抢占过）。
      fs.writeFileSync(file,
        JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), token }) + "\n",
        { flag: "wx", mode: 0o600 });
      return { ok: true, file, token };
    } catch (err) {
      if (err.code === "EEXIST") return { ok: false, reason: "claimed_by_other" };
      return { ok: false, reason: "io_error", error: String(err.message).slice(0, 200) };
    }
  };
  const readOwner = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
  };
  const isStale = (owner) => {
    // **只接管死进程**：活着的 owner 即使超龄也不抢 —— 没有 lease/heartbeat
    // 就凭年龄抢活人，会顶掉慢的合法持有者（评审点名）。
    if (owner && Number.isFinite(owner.pid)) {
      try { process.kill(owner.pid, 0); return false; } catch { return true; }
    }
    try { return now - fs.statSync(file).mtimeMs > staleMs; } catch { return false; }
  };

  const first = attempt();
  if (first.ok || first.reason !== "claimed_by_other") return first;
  const seen = readOwner();
  if (!isStale(seen)) return first;

  // ■ stale 接管：**必须串行**（评审实测三个教训堆在这一段上）
  //
  //   · "判 stale → rm → wx"：后到者的 rm 删掉先到者刚创建的新 claim，
  //     64 个接管者出了 3 个 winner。
  //   · 换成 rename 摘除：rename 按**路径**不按 inode —— 后到者照样把
  //     winner 的新 claim 重命名走，16 个里出了 5 个 winner。
  //   · 所以移除动作本身要独占：reap 锁（wx 单步）串行化接管，
  //     持锁者**重读并核对还是刚才那一代**（token 比对）才许移除。
  //     核对失败 = 有人已经接上了 —— 放手认输。
  try {
    fs.writeFileSync(reapLock,
      JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + "\n",
      { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") return { ok: false, reason: "io_error", error: String(err.message).slice(0, 200) };
    // **reap 锁不在热路径自愈。**上一版按 mtime 超时"判旧 → rm → wx"再抢 ——
    // 评审固定时序复现：内层接管者夺锁建了新 claim，外层拿着旧核对结果
    // 把它删掉再建自己的 —— 两个 ok:true。同一个反模式在低一层复发，
    // 递归不会收敛。所以：**reap 锁存在即 fail-closed**，
    // 崩溃残留（双重退化情形）交给显式维护清理，不在这里赌。
    return { ok: false, reason: "reap_lock_held",
      detail: "接管互斥锁被占（或为崩溃残留）：" + reapLock +
        " —— 若确认无接管者存活，人工删除该文件" };
  }
  try {
    const current = readOwner();
    // **代际核对**：还是我刚才判 stale 的那一代才许动手。
    if (!current || current.token !== seen?.token || !isStale(current)) {
      return { ok: false, reason: "claimed_by_other" };
    }
    fs.rmSync(file, { force: true });
    return attempt();
  } finally {
    fs.rmSync(reapLock, { force: true });
  }
}

/**
 * 回执三态。**存在 ≠ 有效送达**（评审点名：existsSync 会把空文件、坏 JSON、
 * 目录都说成"已送达"，结果被永久跳过）。
 *   absent     —— 没有回执，可以发
 *   valid      —— 结构合法（有 published_at），确实送达过
 *   unreadable —— 有东西但说不清 —— **fail-closed，别发也别当送达**，要报警
 */
export function readRunReceipt({ runsDir, key } = {}) {
  const file = path.join(runsDir, key + PUBLISHED_MARK);
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); }
  catch (err) {
    return err.code === "ENOENT" ? { state: "absent" }
      : { state: "unreadable", why: String(err.code ?? err.message) };
  }
  try {
    const doc = JSON.parse(raw);
    // published_at 必须是规范时间 —— "非空字符串"会让 {"published_at":"不是时间"}
    // 冒充合法回执，一条 run 被永久跳过（同一族判据错误的又一处）。
    if (doc && typeof doc === "object" && !Array.isArray(doc)
      && isCanonicalIso(doc.published_at)) {
      return { state: "valid", publishedAt: doc.published_at,
        messageId: doc.feishu_message_id ?? null };
    }
    return { state: "unreadable", why: "结构不合法" };
  } catch {
    return { state: "unreadable", why: "不是 JSON" };
  }
}

/**
 * **只释放自己的代际。**release 带 token：不带或对不上就不动 ——
 * 否则旧持有者能删掉接管者刚创建的新 claim（评审点名）。
 */
export function releaseRunPublishClaim({ runsDir, key, token } = {}) {
  const file = path.join(runsDir, key + ".publish-claim.json");
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (owner?.token !== token) return false;
  } catch { return false; }
  fs.rmSync(file, { force: true });
  return true;
}

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
 * 两个发送入口共用的前置校验。**发之前**确认凭据属于配置说的那个应用。
 *
 * 放在这里而不是各写一遍：只钉一个入口，另一个照样会用错的身份发出去，
 * 而已经发出去的消息是撤不干净的。
 */
export const PUBLISH_FAILURE = Object.freeze({
  TRANSIENT: "transient",
  ROOT_OWNED_BY_OTHER_APP: "root_owned_by_other_app",
});

/**
 * 发布失败之后判一次：是**这次不行**，还是**永远不行**。
 *
 * 目前只认一种永久失败：**要回复的根消息是另一个应用建的**。
 * cc2cd 就是这样 —— 它的话题建于切到单智能体方案之前，属于应用 CC；
 * 而现在的发布身份是 M5Claude。换个身份重试同一件事，结果不会变。
 *
 * **只在拿到正面证据时才判永久。**探测本身失败（网络、权限、读不到）一律按瞬时 ——
 * 抑制是有损的，宁可继续重试制造噪音，也不能把一条本可以发出去的内容悄悄扔掉。
 *
 * 探测是**只读**的（messages-mget），而且只在失败路径上跑，happy path 不受影响。
 */
export function classifyPublishFailure({
  rootMessageId, expectedAppId, larkBin, larkHome, profile, timeoutMs, exec = execFileSync,
} = {}) {
  if (!rootMessageId || !expectedAppId) return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "no_evidence" };
  let parsed;
  try {
    const out = exec(
      larkBin ?? "lark-cli",
      ["im", "+messages-mget", "--message-ids", rootMessageId, "--as", "bot", "--json"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
               ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
        timeout: timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    parsed = JSON.parse(out);
  } catch {
    return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "probe_failed" };
  }
  const sender = parsed?.data?.messages?.[0]?.sender;
  if (!parsed?.ok || sender?.id_type !== "app_id" || typeof sender?.id !== "string") {
    return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "probe_inconclusive" };
  }
  if (sender.id === expectedAppId) {
    return { kind: PUBLISH_FAILURE.TRANSIENT, reason: "same_app" };
  }
  return {
    kind: PUBLISH_FAILURE.ROOT_OWNED_BY_OTHER_APP,
    // 只出应用名，不出 app id —— 那是身份标识，状态和日志里都不该出现。
    ownerName: typeof sender.name === "string" ? sender.name.slice(0, 40) : null,
  };
}

function preflight({ configDir, profile, expectedAppId }) {
  // 没给 expectedAppId 就是调用方没打算校验（老配置、测试）—— 不强求；但给了就必须过。
  if (!expectedAppId) return;
  const r = assertPublishIdentity({ configDir, profile, expectedAppId });
  if (!r.ok) throw new Error(identityErrorText(r));
}

/**
 * 把草稿发布到绑定的根话题。
 *
 * 用谁的身份由配置决定（见 chain-template 的 resolveLarkIdentity），代码不认死任何一个：
 * 单智能体方案下就是运输那个 agent 自己，双智能体方案下是一个独立的发布身份。
 * 无论哪种，发之前都会校验「手上这份凭据确实属于配置说的那个应用」。
 */
export function publishDraft({
  profile, rootMessageId, text, card, larkBin, larkHome, expectedAppId, timeoutMs,
}) {
  preflight({ configDir: larkHome, profile, expectedAppId });

  const hasText = typeof text === "string" && text.length > 0;
  const hasCard = card !== null && typeof card === "object" && !Array.isArray(card);
  if (hasText === hasCard) {
    throw new Error("发布内容必须且只能提供 text 或 card 其中一个");
  }

  const contentArgs = hasCard
    ? ["--msg-type", "interactive", "--content", JSON.stringify(card)]
    : ["--text", text];

  // 必须显式指定二进制和配置目录：守望者是在 M5Claude 的清洗环境里被拉起的，
  // 那里 lark-cli 被重定向到按 agent 隔离的配置目录（只有 platform-bot），
  // 靠环境里“恰好是什么”会拿到错误的身份，实测就是这么发布失败的。
  //
  // 变量名是 LARKSUITE_CLI_CONFIG_DIR。**曾经写的是 LARKSUITE_CLI_HOME，那个变量
  // 在 lark-cli 里根本不存在**（2026-08-20 在二进制里数过：0 次），所以这道保护
  // 一直在空转 —— 出站之所以没出事，只是因为终端里的默认配置目录恰好就是对的。
  // 一个不存在的环境变量不会报错，只会安静地什么都不做。
  const out = execFileSync(
    larkBin ?? "lark-cli",
    ["im", "+messages-reply", "--message-id", rootMessageId, "--as", "bot",
     "--reply-in-thread", ...contentArgs, "--json"],
    { encoding: "utf-8",
      // stderr 要捕获而不是继承。默认继承时 lark-cli 的报错 JSON 会直接喷进
      // 调用方的 stderr —— 出站发布器现在跑在会话结束钩子里，那等于喷到 Frank 的终端上。
      // 失败信息不会丢：execFileSync 抛出的 error 上带着 stdout/stderr。
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
             ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
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
export function sendToChat({ profile, chatId, text, idempotencyKey, larkBin, larkHome, expectedAppId, timeoutMs }) {
  preflight({ configDir: larkHome, profile, expectedAppId });

  const args = ["im", "+messages-send", "--chat-id", chatId, "--as", "bot", "--text", text, "--json"];
  if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);

  const out = execFileSync(larkBin ?? "lark-cli", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LARKSUITE_CLI_PROFILE: profile,
           ...(larkHome ? { LARKSUITE_CLI_CONFIG_DIR: larkHome } : {}) },
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

if (isDirectRun(import.meta.url)) {
  const ROOT = moduleRoot(import.meta.url, "..");
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
    const { composeOutboundCard } = await import("./outbound-card.mjs");
    for (const r of pending) {
      const text = buildDraft(r, { taskName: cfg.task_display_name });
      if (!text) continue;
      const mid = publishDraft({
        profile: cfg.lark_cli_profile,
        rootMessageId: root,
        card: composeOutboundCard([{
          kind: r.state === "completed" ? "reply" : "risk",
          text,
        }], { taskName: cfg.task_display_name, runtime: "claude" }),
        larkBin: cfg.lark_cli_bin, larkHome: cfg.lark_cli_home });
      markPublished({ runsDir, key: r.key, messageId: mid });
      console.log("已发布 " + r.key.slice(0, 8) + " -> " + mid);
    }
    if (pending.length === 0) console.log("没有待发布内容");
  }
}
