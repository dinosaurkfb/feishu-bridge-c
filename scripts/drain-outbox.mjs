#!/usr/bin/env node
/**
 * 排空 outbox：把积累的关键进展合成一条摘要发到绑定话题，然后逐条标记已发。
 *
 * 三个调用方共用这一个函数：会话结束钩子（事件驱动，主路径）、
 * launchd 兜底定时器、以及人工。它们只读本地 outbox、只往一个已绑定的话题写，
 * 不监听飞书、不接受指令、不做任何入站动作。
 *
 * 幂等靠两层：发布锁保证同一时刻只有一个排空者，逐条 published_at 保证发过的不再发。
 * 发送成功才标记；发送失败不标记，下一轮重试。宁可重试也不能标记了却没发出去 ——
 * 那会让进展静默丢失。
 */

import fs from "node:fs";
import path from "node:path";

import {
  MAX_AUTO_PUBLISH_ATTEMPTS, auditOutbox, composeDigest, isPermanentlyRejected, listPending,
  markSent, outboxMutationBlocker, pauseKindOf, recordPublishFailure,
} from "./outbox.mjs";
import { composeOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import { PUBLISH_FAILURE, classifyPublishFailure, publishDraft } from "./outbound.mjs";
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";
import { resolveProject } from "./project-resolve.mjs";
import { resolveLarkIdentity } from "./chain-template.mjs";
import { isLockStale } from "./handoff.mjs";
import { resolveMappingOutboundGeneration } from "./topic-generation.mjs";
import { isDirectRun, moduleRoot } from "./direct-run.mjs";
import {
  businessActivitiesForPublishedBatch, recordClaudeActivityAndMaybeRotate,
} from "./automatic-topic-rotation.mjs";

/**
 * 按目标代际分组。**导出给抑制命令共用** —— 两处各写一份解析就是分叉的开始，
 * 而且实测已经分叉过：排空把旧格式记录归入当前代际，抑制命令却按原始字段过滤，
 * 于是传诊断给出的代际 id 进去，显示"待发 0 条"。
 * **提示指向的操作做不到它说的事。**
 */
export const groupByTargetGeneration = (records) => {
  const groups = new Map();
  for (const record of records) {
    const key = record.target_channel_generation_id ?? "__legacy_active__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()];
};

/**
 * outbox 按**绑定**分目录，不是按项目。
 *
 * 同一个项目里两个会话可以各绑一个话题；共用一个 outbox 的话，A 会话写的进展会被
 * B 会话的排空拿去发到 B 的话题里 —— 而且不报错，只是发错了地方。
 *
 * 项目级绑定继续用原来的 `outbox` 路径，一个字节不变。
 */
export const outboxDirOf = (root, claudeSessionId) =>
  path.join(root, ".runtime-data", "outbound",
    claudeSessionId ? "outbox-" + claudeSessionId : "outbox");

// 发布锁仍然按项目：它要挡的是「同一时刻两个排空者」，按项目串行化足够，
// 而且更保险 —— 两条线同时发布对飞书是两次独立调用，没必要并行。
const publishLockOf = (root) => path.join(root, ".runtime-data", "outbound", "publish.lock");
const sessionLockOf = (root) => path.join(root, ".runtime-data", "inbound", "session.lock");

/**
 * 有没有一次性守望者正盯着某次投递。
 *
 * 有就别自己发 —— 守望者会把「执行结果 + 本轮进展」合成一条。抢在它前面发，
 * Frank 一次指令就会收到三条消息（已受理 + 进展 + 结果），正是要避免的噪音。
 */
export function watcherActive(root) {
  const lockDir = sessionLockOf(root);
  if (!fs.existsSync(lockDir)) return false;
  return !isLockStale(lockDir);
}

/**
 * 排空一个项目的 outbox。返回结构化结果，自己不打印、不退出 ——
 * 它跑在会话结束钩子里，任何 throw 或 process.exit 都会砸到别人的会话上。
 */
const PUBLISH_ERROR_CAP = 400;

/**
 * 这次失败是**永久拒绝**还是**暂时失败**。
 *
 * 分不开的后果是实测过的：cc2cd 三条答复各含 6 个表格，飞书回
 * `ErrCode: 11310; ErrMsg: card table number over limit`。
 * 排空对失败一律"留在 outbox，下一轮重试"，于是 **68 条失败行、
 * 每 30 分钟一次、空转 12 小时**，稳定地制造噪音而没有任何一次能成功。
 *
 * ■ 两个信号，都是"认出来"的
 *
 *   · httpCode 4xx = 请求本身不被接受（408 / 429 例外：超时和限流
 *     恰恰是"现在不行、待会儿行"）
 *   · 已知的永久 ErrCode —— 卡片结构越界这一类，内容不改就永远发不出去
 *
 * ■ 但**认出来这条路本身是不可靠的**
 *
 * 实测：那次故障的 lark-cli 输出**根本没有 httpCode**，只有 `"code": 230099`，
 * 真正的 11310 埋在 `ext=` 里。我第一版只按 HTTP 状态码分类，
 * 在真实数据上会把它判成"暂时" —— **判据看着对，喂真实数据就不成立**。
 *
 * 而且错误码表永远追不齐。所以真正兜底的不是这个函数，是
 * `MAX_AUTO_PUBLISH_ATTEMPTS`：它不需要认识任何错误码。
 * 这个函数只负责"认出来的就别再等了"，**拿不准一律算暂时** ——
 * 误判成永久会让一条本该发出去的答复停下来等人，误判成暂时只是多试几次，
 * 上限还兜着。两种错的代价不对称。
 */
const TRANSIENT_HTTP = new Set([408, 429]);

/**
 * 已知的永久 ErrCode。**这张表注定是不全的** —— 它只是让认得出的那些少走几轮，
 * 真正保证"不会无限重试"的是次数上限。
 */
const PERMANENT_ERR_CODES = new Set([
  11310,   // card table number over limit —— 卡片表格数超限，内容不改就永远发不出去
]);

export function publishRetryability(detail) {
  const text = String(detail ?? "");
  const errCode = /ErrCode:\s*(\d+)/u.exec(text);
  if (errCode && PERMANENT_ERR_CODES.has(Number(errCode[1]))) {
    return { permanent: true, reason: "err_" + errCode[1] };
  }
  // `httpCode 400` 和 `"httpCode": 400` 都要认 —— 两种形态都在真实输出里见过。
  const http = /httpCode"?\s*:?\s*(\d{3})/u.exec(text);
  if (!http) return { permanent: false, reason: "no_permanent_signal" };
  const code = Number(http[1]);
  if (code >= 400 && code < 500 && !TRANSIENT_HTTP.has(code)) {
    return { permanent: true, reason: "http_" + code };
  }
  return { permanent: false, reason: "http_" + code };
}

/**
 * 错误里那些**认得出来的诊断片段** —— 截断时一个都不许丢。
 *
 * 顺序即优先级：真正说明白"为什么被拒"的是 ext 里那对 ErrCode/ErrMsg，
 * 外层的 code/httpCode 只说明"被拒了"。
 */
const DIAGNOSTIC_PATTERNS = [
  /ErrCode:\s*\d+/gu,
  /ErrMsg:\s*[^;"\n]{1,120}/gu,
  /ErrorValue:\s*[^;"\n]{1,60}/gu,
  // `httpCode 400` 和 `"httpCode": 400` 都要认 —— 两种形态在真实输出里都见过，
  // 正文承诺了会捞它们，就不能只认其中一种。
  /httpCode"?\s*:?\s*\d{3}/gu,
  /errCode"?\s*:?\s*\d+/gu,
  /"code":\s*\d+/gu,
];

/** 被省略段里带诊断码的片段，去重后按出现顺序返回。 */
function diagnosticsMissingFrom(full, kept) {
  const found = [];
  for (const re of DIAGNOSTIC_PATTERNS) {
    for (const m of String(full).matchAll(re)) {
      const piece = m[0].trim();
      if (kept.includes(piece) || found.includes(piece)) continue;
      found.push(piece);
      if (found.length >= 6) return found;   // 病态输入不许把日志撑爆
    }
  }
  return found;
}

/**
 * 长错误留头也留尾 —— **真正的错误码常常在末尾**，只留头等于把它扔了。
 *
 * 但留头留尾也不够，**这一条是付过账的**：飞书返回的是一层嵌套 JSON，
 * 真正的原因躺在 `error.message` 的中段：
 *
 *     "message": "Failed to create card content, ext=ErrCode: 11310;
 *                 ErrMsg: card table number over limit; ..."
 *
 * head 160 落在 message 值中间、tail 200 落进 log_id，**被切掉的正是那对
 * ErrCode/ErrMsg**。整份 drain.log 里 `11310` 出现 0 次 ——
 * 答案一直在返回里，一次故障绕了 12 小时只因为日志把它切了。
 *
 * 上一版注释自己就写着"上上版发现过这个症状，改法是把 400 放宽，那治不了"。
 * **同一个错误换了个入口又犯了一遍**：这回不是长度不够、也不是方向不对，
 * 是**中段**被吃了。所以现在不靠位置猜，而是把认得出来的诊断片段单独捞出来附在后面。
 */
function clipBothEnds(text) {
  const t = String(text).trim();
  if (t.length <= PUBLISH_ERROR_CAP) return t;
  const kept = t.slice(0, 160) + " …（中间省略）… " + t.slice(-200);
  const rescued = diagnosticsMissingFrom(t, kept);
  return rescued.length === 0
    ? kept
    : kept + "\n  被省略段里的诊断：" + rescued.join("; ");
}

/**
 * 从发布失败里挑出**有用的那半**。
 *
 * Node 的 execSync 错误长这样：`Command failed: <整条命令>\n<stderr>`。
 * 而这条命令带着整张卡片 JSON，光命令回显就上千字符 —— 从头截 400 字留下来的
 * 全是命令，lark-cli 真正说的话一个字都没有。
 *
 * 上上版发现过这个症状，改法是"把 400 放宽"。那治不了：问题不是**长度不够**，
 * 是**截错了方向**。
 *
 * 上一版只对"纯命令回显"留头尾，对 stderr 仍然从头截 —— 于是多行 runtime 提示
 * 加末尾错误码时，`code 230002` 照样被切掉。**同一个错误换了个入口又犯一遍。**
 * 现在头尾保留对**所有**长文本一视同仁。
 *
 * 另一处：上一版只要 message 有换行就删掉第一行。可只有 `Command failed:` 开头的
 * 那种第一行才是命令回显 —— 普通多行错误的第一行往往正是主错误。**只在确实匹配
 * 时才剥。**
 */
/**
 * **只有平台真的说过的话**才能拿来做判定。
 *
 * 这是一条安全边界，不是整洁问题。卡片 JSON 会整个进入子进程 argv，
 * 于是 Node 的 `Command failed: <整条命令>` 里**包含用户内容**。
 * 评审实测：子进程静默 exit 1、卡片正文里写着 `ErrCode: 11310`，
 * 分类器就在命令回显里搜到了它，判成 `{permanent:true, reason:"err_11310"}` ——
 * **一段正文让自己被永久停发**。
 *
 * 所以判定的输入只能是子进程的 stdout/stderr，或者命令回显**之后**那部分。
 * 拿不到可信响应就返回空串 —— 调用方据此按暂时失败处理。
 */
export function trustedPublishResponse(err) {
  const asText = (raw) => (typeof raw === "string" ? raw
    : (raw && typeof raw.toString === "function") ? raw.toString("utf-8") : "").trim();
  // **两个输出通道都可信，要合起来看。**
  //
  // 上一版只读 stderr、而且只要 stderr 非空就不再看别的。评审实测：
  // stdout 里是 `code: 230099` 这条真正的平台响应、stderr 里只有一句构建提示，
  // 于是被判成暂时失败，**给人的详情也把真错误码丢了**。
  // lark-cli 把结构化响应写在 stdout 是常态，注释当时也承诺了会读它。
  const channels = [asText(err?.stdout), asText(err?.stderr)].filter(Boolean);
  if (channels.length > 0) return channels.join("\n");
  const message = String(err?.message ?? "");
  // `Command failed: <命令>\n<真正的输出>` —— 只有换行**之后**那半是子进程说的。
  // 没有换行就意味着我们只拿到了命令回显本身，那里面全是我们自己喂进去的东西。
  if (!message.startsWith("Command failed:") || !message.includes("\n")) return "";
  return message.slice(message.indexOf("\n") + 1).trim();
}

/**
 * 给人看的失败详情。
 *
 * 跟 `trustedPublishResponse` 的区别是**用途不同**：这里拿不到可信响应时
 * 仍然把原始 message 打出来（人需要线索），但那份**绝不能拿去做判定** ——
 * 它含用户内容。判定一律走 trustedPublishResponse。
 */
export function publishErrorDetail(err) {
  const trusted = trustedPublishResponse(err);
  return clipBothEnds(trusted || String(err?.message ?? ""));
}

/**
 * 把统一守卫的结论讲成人话。**Stop 和 CLI 共用这一份措辞。**
 *
 * 它只读 blocker 的结论，**不重新判断** —— 判据只有一份。
 *
 * 「目录读不出来」和「某几条记录解释不了」要分开说：前者根本没有"N 处"可数
 * （守卫对读取失败返回 count: 0），照着模板渲染会打出"0 处说不清"，
 * 那句话既不成立也没法照着排查。
 */
export function localOutboxMessage(r) {
  const head = r.reason === "outbox_unreadable" ? "本地 outbox 读不出来"
    : r.reason === "outbox_not_a_directory" ? "本地 outbox 那个路径不是目录"
      : "本地 outbox 有 " + (r.count ?? 0) + " 处说不清" +
        ((r.files ?? []).length ? "（" + r.files.join("、") + "）" : "");
  const why = (r.details ?? []).map((d) => "\n    " + d.file + " —— " + d.why).join("");
  return head + "。\n" +
    "  **这不是发布失败，是本地记录的问题** —— 重试没用，需要人看一眼。整批都没有动。" +
    why;
}

/** 抑制命令的绝对路径：提示里给相对路径，等于让人猜当前工作目录。 */
/**
 * 这个脚本自己的路径。
 *
 * **不要从进程参数里取** —— 经符号链接执行时那给的是链接本身，
 * 提示里打出来的命令人照抄会指到别处。有一条守卫直接禁用了那个 API。
 */
export function drainCmd() {
  return path.join(moduleRoot(import.meta.url, ".."), "scripts", "drain-outbox.mjs");
}

export function suppressCmd() {
  return path.join(moduleRoot(import.meta.url, ".."), "scripts", "feishu-suppress-outbox.mjs");
}

/**
 * `publish` 是**唯一的发布注入口**。默认就是真的发。
 *
 * 加它的原因：这条失败路径此前根本没法做行为测试 —— `publishDraft` 的
 * `larkBin` 来自机器级模板（`resolveLarkIdentity`），**不是**项目 chain-config 里的
 * `lark_cli_bin`，所以给临时项目写一个假的二进制挡不住它。我为了测一条失败分支
 * 跑过一次非 dry-run 的 drainProject，**它直接打到了真实飞书 API**
 * （拿到真实错误码 99992354，所幸根消息是假的，什么都没发出去）。
 *
 * **两个口都要有。**只注入 publish 只挡住了"写"：发布失败之后还要跑身份诊断，
 * 而 classifyPublishFailure 会执行 lark-cli `im +messages-mget` 去查根消息的归属 ——
 * 那同样是一次真实的出网请求。评审用假二进制实测到了这一点：注入的发布函数抛错后，
 * 诊断进程照样被调起来。**"挡住了写"不等于"不出网"。**
 *
 * 注入口只改测试的可达性，不改生产行为：不传就是 publishDraft / classifyPublishFailure 本身。
 */
export function drainProject({
  root, claudeSessionId, dryRun = false, timeoutMs, force = false,
  // **人显式下令才会重试被永久拒绝的那些。**默认不重试 ——
  // 永久拒绝的定义就是"再等不会变好"，自动重试只是稳定地制造噪音。
  retryRejected = false,
  publish = publishDraft, diagnose = classifyPublishFailure,
} = {}) {
  const outboxDir = outboxDirOf(root, claudeSessionId);

  // 先看有没有东西可发。绝大多数会话在这一行就返回了 —— 不读配置、不碰锁。
  // **审计要在任何"空"结论之前。**
  //
  // listPending 把目录错误吞成 []、把坏 JSON 静默跳过 —— 评审实测：
  // outbox 里只有一份坏 JSON 时 drainProject 返回 {status:"empty"}；
  // outbox 路径是普通文件时也返回 empty；真实 Stop 面对这种 outbox **完全无输出**。
  // **"读不出来"被报成"没有东西可发"，是这条线上反复出现的同一个错误。**
  const preflight = outboxMutationBlocker(auditOutbox(outboxDir));
  if (preflight) return { status: "error", root, ...preflight, local: true };
  if (listPending({ outboxDir }).length === 0) return { status: "empty", root };

  // 项目文件优先，没有就回落到「机器模板 + 登记表那一行」。
  // 已接好的项目走前一条，行为不变；新接的项目目录里一个配置文件都没有。
  const resolved = resolveProject({ root, claudeSessionId });
  if (!resolved.ok) {
    // not_bound 是「有 outbox 但没接桥」—— 会被 CLI 和钩子分别报出来，不静默。
    return { status: "error", root, reason: resolved.reason, error: resolved.error ?? null };
  }
  // 发布真的需要 config（身份、profile、二进制路径），所以到这一步 configError 就是硬错。
  // 到期预警不需要 config，所以那条路径拿到 configError 也照常工作 —— 见 project-resolve.mjs。
  if (!resolved.config) {
    const ce = resolved.configError ?? {};
    const parts = [ce.error];
    if (ce.missing?.length) parts.push("缺字段：" + ce.missing.join(", "));
    if (ce.malformed?.length) parts.push("形状不对：" + ce.malformed.join(", "));
    return {
      status: "error", root,
      reason: ce.reason ?? "config_unreadable",
      error: parts.filter(Boolean).join("；") || null,
    };
  }
  const { config: cfg, mapping } = resolved;

  let failingBatch = null;
  // **在 try 之外解析。**上一版把它放在 try 里，而 catch 要用它 —— 于是任何发布失败
  // 都先撞上 ReferenceError，永远走不到诊断。身份从配置推，不认死任何 agent；
  // 发之前 publishDraft 仍会校验凭据归属。
  const id = resolveLarkIdentity(cfg);
  let failingTarget = null;
  // **发布开关要真的管住自动发布。**
  //
  // 它叫 auto_publish_on_completion，但此前只有 inbound.mjs 和 watch-and-publish.mjs
  // 读它 —— 每轮 Stop 和 30 分钟兜底都不读，而那两条恰好是 Claude 侧的主路径。
  // 于是把它设成 false 几乎什么都不改变，进展照发：**一个不生效的开关**。
  //
  // 现在默认遵守。显式人工排空要绕过就用 --force —— 绕过必须是明说的，
  // 不能靠"哪个入口调的"来隐式决定。
  if (!force && cfg.auto_publish_on_completion === false) {
    return {
      status: "skipped", root, reason: "auto_publish_disabled",
      count: listPending({ outboxDir }).length,
    };
  }

  // 绑定失效时不发：话题可能已经不再是 Frank 认可的那个。
  if (mapping.status !== "active") {
    return { status: "skipped", root, reason: "mapping_not_active", count: listPending({ outboxDir }).length };
  }

  const lockDir = publishLockOf(root);
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { status: "skipped", root, reason: lock.reason };

  try {
    // 锁内重新读一遍：刚才排队等锁的时候，别的发布者可能已经把这批发掉了。
    // **取锁之后再审计一次** —— 锁外那次和这次之间，别人可能刚写进来一个坏文件。
    //
    // **读取也放在审计之后**：上一版注释写"先审计"、实际先 listPending，
    // 空结论确实在审计之后所以不影响安全，但**注释比实现完整**这件事本身
    // 就是下一个缺陷的入口 —— 这条线上已经因此栽过。
    // **这个 outbox 现在能不能动 —— 只认统一守卫。
    //
    // 取舍是明确的：**不要静默跳过单个坏文件后把其余照发**。
    // 对"本次选择的这一批"整批 fail-closed 并点名；
    // 调度器本来就按项目隔离，一个项目坏掉不会拖住别的项目。
    //
    // **损坏的目标代际也归它管。**审计已经把"字段在、但不是可用代际"
    // 算进不可解释里了 —— 这里再单独判一次就是同一件事的第二份判据，
    // 而"两份判据"正是这条线上被反复罚过的东西。
    const blocked = outboxMutationBlocker(auditOutbox(outboxDir));
    if (blocked) return { status: "error", root, ...blocked, local: true };
    const all = listPending({ outboxDir });
    // **上次被永久拒绝的不再自动重试。**判据跟积压视图共用一份。
    // 它们仍是 pending（没发出去、也没被停发）—— 只是等人看一眼，
    // 而不是每 30 分钟再撞一次同一堵墙。停发是不可逆的，
    // 「这次发不出去」不该顺手变成「永远别发」。
    const held = all.filter(isPermanentlyRejected);
    const rejected = retryRejected ? [] : held;
    // **重试只在内存里放行，不预先改盘。**
    //
    // 上一版在这里就把标记清了 —— 而清标发生在 dry-run、构卡、真实发布**之前**：
    // 评审实测 `dryRun:true + retryRejected:true` 返回 dry_run，
    // **文件字节却已经变了、保护标记已经没了**；构卡失败或进程中断同样会把记录
    // 重新暴露给自动发布。**预演不许改盘，保护不许提前撤。**
    //
    // 标记的清除移到发布成功之后 —— 而那时 markSent 本来就要重写这条记录，
    // 所以顺手在同一次写里清掉，连额外的写都不用。
    const pending = retryRejected ? all : all.filter((r) => !isPermanentlyRejected(r));
    if (pending.length === 0) {
      // **有被拒的就不能报 empty。**报 empty 会让人以为队列干净了，
      // 而其实有内容正等着他处理 —— 一份假的「没有积压」比没有报告更坏。
      return rejected.length === 0
        ? { status: "empty", root }
        : { status: "needs_attention", root, reason: "permanently_rejected",
            count: rejected.length,
            // **成因要一路带到视图。**落了盘却不往上传，
            // 下一个进程照样只能把两种情形统称为"被飞书拒绝"——
            // 而它们的下一步不同。pauseKindOf 是那份判据的唯一读法。
            rejected: rejected.map((r) => ({
              file: path.basename(String(r._file ?? "")),
              kind: pauseKindOf(r),
              why: r.publish_rejected_reason ?? "未说明" })) };
    }

    const targetBatches = groupByTargetGeneration(pending).flatMap(([targetKey, records]) => {
      const target = resolveMappingOutboundGeneration(
        mapping,
        targetKey === "__legacy_active__" ? null : targetKey,
      );
      if (!target.ok) throw new Error("冻结的出站话题代际不可用（" + target.reason + "）");
      return outboundCardBatches(records).map((batch) => ({
        batch,
        target,
        card: composeOutboundCard(batch, {
          taskName: cfg.task_display_name,
          runtime: "claude",
        }),
      }));
    });
    const cards = targetBatches.map((item) => item.card);
    if (dryRun) {
      return {
        status: "dry_run",
        root,
        count: pending.length,
        cards,
        text: composeDigest(pending, { taskName: cfg.task_display_name }),
      };
    }

    const messageIds = [];
    for (const item of targetBatches) {
      // 记住正在发哪一个目标：失败诊断要查**这一条**的根消息，
      // 而不是 mapping.root_message_id —— 后者可能是别的代际，甚至不存在。
      failingTarget = item.target;
      // 记住正在发哪一批：永久拒绝要打在**这一批**的记录上，不是全部待发。
      failingBatch = item.batch;
      const messageId = publish({
        profile: id.profile,
        rootMessageId: item.target.rootMessageId,
        card: item.card,
        larkBin: id.bin,
        larkHome: id.configDir,
        expectedAppId: id.expectedAppId,
        timeoutMs,
      });
      for (const activity of businessActivitiesForPublishedBatch(item.batch, {
        messageId, runtime: "claude",
      })) {
        recordClaudeActivityAndMaybeRotate({
          root,
          claudeSessionId: resolved.claudeSessionId ?? mapping.claude_session_id ?? claudeSessionId,
          generationId: item.target.channelGenerationId,
          ...activity,
        });
      }
      // 发布成功了才清保护标记 —— markSent 本来就要重写这条记录，同一次写里做完。
      for (const record of item.batch) markSent(record, messageId);
      messageIds.push(messageId);
    }
    return {
      status: "published",
      root,
      count: pending.length,
      messageId: messageIds.at(-1) ?? null,
      messageIds,
    };
  } catch (err) {
    // 不标记、不吞掉：留在 outbox，下一个排空者重试。
      // **只诊断，不自动抑制。**上一版的推理是"失败 + 根消息属于另一个应用 = 永久"，
      // 那是**从相关性推因果**：瞬时的网络错误发生在跨应用根消息上，照样会触发
      // 不可逆的抑制。有损动作不能建立在推断出来的因果上 —— 要么拿到确实表示
      // 身份不兼容的平台错误码，要么由人显式下令。现在选后者。
      const diagnosis = diagnose({
        rootMessageId: failingTarget?.rootMessageId ?? null,
        expectedAppId: id?.expectedAppId,
        larkBin: id?.bin, larkHome: id?.configDir, profile: id?.profile,
      });
      // **永久拒绝要落到记录上**，否则下一轮定时排空照撞不误。
      // 锁还在手里（catch 在 try 内、finally 之前），改的是同一条记录的语义，
      // 跟抑制、资格提升共用这把锁 —— 满足统一写锁那条。
      const detail = publishErrorDetail(err);
      // **判定只喂可信响应。**detail 在拿不到可信响应时会回落到含命令回显的原始
      // message —— 那里面有卡片正文，用它判定等于让内容决定自己的命运。
      const retryability = publishRetryability(trustedPublishResponse(err));
      const marked = [];
      let pausedKind = null;
      for (const record of failingBatch ?? []) {
        try {
          // 认出来的永久错误立刻停；认不出来的靠次数上限兜底。
          const outcome = recordPublishFailure(record, {
            permanent: retryability.permanent,
            reason: retryability.reason + "：" + detail,
          });
          if (outcome.paused) {
            marked.push(path.basename(String(record._file ?? "")));
            pausedKind = outcome.kind;
          }
        } catch { /* 记不上不算失败：下一轮还会再撞一次，但不会更坏 */ }
      }
      return {
        status: "error", root, reason: "publish_failed",
        // **报"永久"要以实际打没打标为准**，不是以"认出来了吗"为准 ——
        // 撞满次数上限的那次同样是"不会再自动重试"，说成会重试就是骗人。
        // **报"永久"要以实际打没打标为准**，不是以"认出来了吗"为准 ——
        // 撞满次数上限的那次同样是"不会再自动重试"，说成会重试就是骗人。
        permanent: marked.length > 0,
        // 成因**以实际落盘的那个为准**，不在这里第二次推断。
        permanentKind: pausedKind,
        permanentReason: pausedKind === null ? null
          : (pausedKind === "platform_rejected" ? retryability.reason : "retry_exhausted"),
        markedRejected: marked,
        // 挑有用的那半：见 publishErrorDetail。**从头截固定长度会把真正的
        // 错误码切掉** —— 这条命令光命令回显就上千字符，前 400 字全是命令。
        error: detail,
        // 诊断只是**线索**，不是判决 —— 调用方拿它给人看，不拿它做有损动作。
        diagnosis: diagnosis.kind === PUBLISH_FAILURE.ROOT_OWNED_BY_OTHER_APP
          ? { kind: diagnosis.kind, ownerName: diagnosis.ownerName ?? null,
              // 带上代际：抑制命令要按代际限定范围，提示里不给它就等于让人一刀切。
              generationId: failingTarget?.generationId ?? failingTarget?.channelGenerationId ?? null,
              count: listPending({ outboxDir }).length }
          : null,
      };
  } finally {
    releasePublishLock(lockDir);
  }
}

/**
 * 把一次排空结果讲成一句话。**分支顺序是这个函数的语义，不是排版。**
 *
 * 抽出来的理由：这套 if-chain 里的**顺序本身**就是一条被评审罚过的判据 ——
 * 同一次失败可以既是永久拒绝、又带跨应用诊断，谁排前面决定人看到哪一个。
 * 内嵌在 CLI 里的话，唯一能验它的办法是真的跑一次发布（那会打到真实飞书），
 * 或者去断言源码文本（那种断言改坏了照样绿）。
 *
 * @returns {{text:string, error:boolean}|null} null = 不用说话
 */
export function describeDrainOutcome(r, { root, verbose = false } = {}) {
  if (r.status === "published") {
    return { text: "已发布 " + r.count + " 条 -> " + r.messageId, error: false };
  }
  if (r.status === "dry_run") {
    return { text: "[dry-run] 将发布 " + r.count + " 条：\n---\n" + r.text, error: false };
  }
  if (r.status === "error" && r.permanent === true) {
    // **先看实际落盘状态，诊断只是补充线索。**
    //
    // 上一版把 diagnosis 排在前面，于是同时命中两者时它仍然说"重试可能一直失败"
    // 并推荐**不可逆抑制** —— 把"已经暂停自动重试"和"可恢复的重试入口"一起藏了。
    //
    // **撞满次数和平台拒绝要分开说**：前者值得人再试一次，
    // 后者不改内容再试多少次都一样。
    return {
      error: true,
      text: (r.permanentKind === "retry_exhausted"
        ? "这一批的自动重试预算耗尽了（试满 " + MAX_AUTO_PUBLISH_ATTEMPTS + " 次），**已暂停自动重试**："
        : "飞书拒绝了这一批（" + r.permanentReason + "），**已暂停自动重试**：") + "\n" +
        "  " + r.error + "\n" +
        (r.markedRejected?.length ? "  已标记：" + r.markedRejected.join("、") + "\n" : "") +
        (r.diagnosis?.kind === "root_owned_by_other_app"
          ? "  另外：话题由另一个应用（" + (r.diagnosis.ownerName ?? "未知") + "）创建。\n" : "") +
        "  修好起因之后要重发：node " + drainCmd() + " --project " + root + " --retry-rejected --force\n" +
        "  确定不发了（不可逆）：node " + suppressCmd() + " --project " + root,
    };
  }
  if (r.status === "error" && r.diagnosis?.kind === "root_owned_by_other_app") {
    return {
      error: true,
      text: "发布失败：话题由另一个应用（" + (r.diagnosis.ownerName ?? "未知") +
        "）创建，当前身份大概率回复不进去，重试可能一直失败。\n" +
        "  要停止重试（不可逆）：node " + suppressCmd() + " --project " + root +
        " --generation " + (r.diagnosis.generationId ?? "<代际 id>") + " --apply",
    };
  }
  if (r.status === "error" && r.local === true) {
    // **本地问题要点名。**上一版落进通用分支，打出来是
    // "排空失败（outbox_unexplainable），进展留在 outbox：undefined" ——
    // 没有文件名、没有坏在哪，等于没兑现"整批拒绝并点名"。
    // 渲染只**读守卫的结论**，不重新判断（判据只有一份）。
    return { text: localOutboxMessage(r), error: true };
  }
  if (r.status === "error") {
    return { text: "排空失败（" + r.reason + "），进展留在 outbox：" + r.error, error: true };
  }
  if (r.status === "needs_attention") {
    // **有被拒的就不能沉默。**落进"outbox 为空"那条等于报了一份假的没有积压。
    return {
      error: true,
      text: r.count + " 条已暂停自动重试，等你看一眼：\n" +
        (r.rejected ?? []).map((item) => "  " + item.file + "（" +
          (item.kind === "retry_exhausted" ? "重试预算耗尽，值得再试一次"
            : item.kind === "platform_rejected" ? "平台拒绝，不改内容再试也一样"
              : "成因不明") + "）—— " + item.why).join("\n") +
        // **--force 要带上。**自动发布关掉时不带它会被开关提前挡住 ——
        // 提示指向的操作做不到它说的事，这个坑踩过不止一次。
        "\n  修好起因之后要重发：node " + drainCmd() + " --project " + root +
        " --retry-rejected --force",
    };
  }
  if (r.status === "skipped") {
    return {
      text: "暂不发布：" + r.reason + (r.count ? "（" + r.count + " 条留在 outbox）" : ""),
      error: false,
    };
  }
  return verbose ? { text: "outbox 为空", error: false } : null;
}

// ---------- CLI ----------

if (isDirectRun(import.meta.url)) {
  const arg = (n) => {
    const i = process.argv.indexOf("--" + n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const SELF_ROOT = moduleRoot(import.meta.url, "..");
  const verbose = process.argv.includes("--verbose");
  const dryRun = process.argv.includes("--dry-run");

  // --all 是兜底定时器该走的路径：登记表里的项目都排空一遍。
  // 只排本仓库会让后接进来的项目在钩子没跑到时永远没有兜底。
  let targets;
  if (process.argv.includes("--all")) {
    const { loadRegistry } = await import("./registry.mjs");
    const reg = loadRegistry();
    if (!reg.ok) {
      console.error("登记表读不了（" + reg.reason + "）：" + (reg.error ?? ""));
      process.exit(1);
    }
    // 按**绑定**枚举，不是按项目根目录。
    //
    // 会话级绑定的 outbox 是 `outbox-<uuid>/`；原来只 map(p.root) 再不带会话地排空，
    // 等于永远只看项目级那一个目录。对会话级绑定来说这不是「延迟」而是「永远发不出去」——
    // 即时发布一旦失败，兜底根本找不到那批进展。同一 root 上项目级与会话级绑定可以并存，
    // 所以这里按 (root, session) 去重，不能按 root 去重。
    const seen = new Set();
    targets = [];
    for (const project of reg.projects) {
      if (typeof project?.root !== "string" || !project.root) continue;
      const claudeSessionId = project.claude_session_id ?? null;
      const key = project.root + "\u0000" + (claudeSessionId ?? "");
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ root: project.root, claudeSessionId });
    }
    if (targets.length === 0 && verbose) console.log("登记表里没有项目");
  } else {
    targets = [{ root: arg("project") ?? SELF_ROOT, claudeSessionId: arg("session") ?? null }];
  }

  // 绕过发布开关必须明说。
  const force = process.argv.includes("--force");
  // 人显式下令才重试被永久拒绝的那些 —— 默认不重试。
  const retryRejected = process.argv.includes("--retry-rejected");
  let hadError = false;
  for (const { root, claudeSessionId } of targets) {
    const tag = targets.length > 1
      ? path.basename(root) +
        (claudeSessionId ? "/" + String(claudeSessionId).slice(0, 8) : "") + ": "
      : "";
    const r = drainProject({ root, claudeSessionId, dryRun, force, retryRejected });

    const line = describeDrainOutcome(r, { root, verbose });
    if (line) {
      (line.error ? console.error : console.log)(tag + line.text);
      if (line.error) hadError = true;
    }
  }
  if (hadError) process.exit(1);
}
