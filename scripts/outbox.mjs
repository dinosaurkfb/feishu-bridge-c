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
import { generationTargetState, usableGeneration } from "./topic-generation.mjs";
import { isCanonicalIso } from "./canonical-time.mjs";
// registry 不反向依赖 outbox —— 没有环。
import { acquirePublishLock, releasePublishLock } from "./registry.mjs";

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
    // **判据跟核心共用。**这里本来就把 "" 映射成 null（没有冻结目标），
    // 只是漏了纯空白 —— 空白串是 truthy，于是被原样写进去，成了一条
    // "目标字段在、但不是代际"的损坏记录：抑制那侧会把它当成自带明确代际，
    // 绕过全部守卫。写不出损坏记录，下游就不用去猜该怎么解释它。
    target_channel_generation_id: usableGeneration(targetGenerationId)
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

/**
 * **自动重试的次数上限。**
 *
 * 光靠"认出永久错误码"不够，而且这一点是实测出来的：cc2cd 那次故障里，
 * lark-cli 输出**根本没有 httpCode**，只有 `"code": 230099`。
 * 错误码表永远追不齐：下一个没见过的限制码又会转起来。
 * 所以次数上限是**兜底判据**，它不需要认识任何错误码。
 * 12 小时 / 每 30 分钟 = 24 次，现在最多 5 次。
 */
export const MAX_AUTO_PUBLISH_ATTEMPTS = 5;

/**
 * 暂停自动重试的两种成因。**受控取值，别处不许自造字符串。**
 *
 *   platform_rejected —— 平台明确说了这样发不出去；不改内容再试多少次都一样
 *   retry_exhausted   —— 只是自动重试预算用完了；值得人再试一次
 *
 * 两者都表现为"已暂停自动重试"，但**下一步不同**，说混了会把人支去做错的事。
 * 所以它必须**落盘**：只在返回值里带着的话，进程一结束，
 * Stop 和积压视图就只能把两者统称为"被飞书拒绝"。
 */
export const PAUSE_KINDS = Object.freeze(["platform_rejected", "retry_exhausted"]);

// **校验不依赖导出值。**评审实测：导出数组可变时，进程内 push 一个编造的
// kind 就能让原本 corrupt 的记录变成合法 paused —— 封闭联合被运行时扩宽。
// 冻结挡住改写，私有集合保证就算导出面被换掉，判据也不动。
const PAUSE_KIND_SET = new Set(PAUSE_KINDS);

/**
 * 一条记录的**重试保护投影** —— 唯一的读法，返回封闭联合：
 *
 *     { status: "clean" }
 *   | { status: "retrying", attempts }
 *   | { status: "paused",   attempts, at, reason, kind }
 *   | { status: "corrupt",  reason }
 *
 * ■ 为什么是对象不是状态字符串
 *
 * 上一版只有状态函数（retryProtectionState → 字符串），于是展示层
 * 还得**自己去拼裸字段**取 reason —— 评审点名：那就是"每个读者都重新
 * 解释状态"，正是这条线上反复漏接的根。投影把每个状态携带的数据一并给全，
 * **任何消费者（含展示层）不再摸字段**。磁盘上仍是四个平铺字段，
 * 格式不变（零迁移）；对象化只发生在代码层。
 *
 * ■ 合法形状（充要，其余一律 corrupt 并说清为什么）
 *
 *   clean    —— 四个字段都不在（绝大多数记录）
 *   retrying —— 只有 attempts，1 <= attempts < 上限
 *   paused   —— attempts（≥1）+ at + reason + kind 四件齐全且各自合法；
 *               kind=retry_exhausted 还要求 attempts 已到上限
 *
 * **"封闭"的意思就是没有第五种合法形状。**评审三次收紧到这里：
 * 先是完全不验，然后 attempts:0 与"有 at/reason 没 attempts"被放行，
 * 最后 attempts:999 仍算 retrying、attempts:1+retry_exhausted 自相矛盾也过 ——
 * **审计放行的集合不该比生产能产出的集合更大**，次数和状态必须互相印证。
 */
export function retryProtection(rec) {
  const attempts = rec?.publish_attempts;
  const at = rec?.publish_rejected_at;
  const reason = rec?.publish_rejected_reason;
  const kind = rec?.publish_rejected_kind;
  const present = [attempts, at, reason, kind].map((v) => v !== undefined);

  if (!present.some(Boolean)) return { status: "clean" };
  // attempts 是这台状态机的地基：任何非 clean 形状都必须有它，而且至少 1 次
  // （0 次意味着"从没试过却已经在重试状态"，生产写不出来）。
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    return { status: "corrupt", reason: "publish_attempts 不是正整数" };
  }
  if (present[1] === false && present[2] === false && present[3] === false) {
    // retrying 必须还在预算内 —— 试满了还说在重试，就是自相矛盾。
    return attempts < MAX_AUTO_PUBLISH_ATTEMPTS
      ? { status: "retrying", attempts }
      : { status: "corrupt", reason: "attempts 已到上限却没有暂停记录" };
  }
  // 剩下的只能是 paused —— 要求另外三个**全部**在场且合法。
  if (!isCanonicalIso(at)) return { status: "corrupt", reason: "publish_rejected_at 不是规范时间" };
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { status: "corrupt", reason: "publish_rejected_reason 缺失或为空" };
  }
  if (!PAUSE_KIND_SET.has(kind)) {
    return { status: "corrupt", reason: "publish_rejected_kind 不在受控取值里" };
  }
  // 成因也要跟次数对得上：**预算耗尽**只可能发生在试满之后。
  if (kind === "retry_exhausted" && attempts < MAX_AUTO_PUBLISH_ATTEMPTS) {
    return { status: "corrupt", reason: "说预算耗尽但次数没到上限，自相矛盾" };
  }
  return { status: "paused", attempts, at, reason, kind };
}

/** 兼容投影：只要状态名。**实现只有 retryProtection 那一份。** */
export const retryProtectionState = (rec) => retryProtection(rec).status;

/**
 * 这条记录**已经暂停自动重试**了吗。
 *
 * 判据只有这一份：排空的选择、watcher 的选择、积压视图都走它。
 * **它不改变三态。**记录仍然是 pending（没发出去、也没被停发）——
 * 停发是不可逆的，而「这次发不出去」不该顺手变成「永远别发」。
 */
export const isPermanentlyRejected = (rec) => retryProtection(rec).status === "paused";

/** 暂停的成因。没暂停就是 null。 */
export const pauseKindOf = (rec) => {
  const rp = retryProtection(rec);
  return rp.status === "paused" ? rp.kind : null;
};

const rewrite = (rec, mutate) => {
  const next = { ...rec };
  mutate(next);
  delete next._file;
  delete next._raw;
  const tmp = rec._file + ".tmp." + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, rec._file);
  return next;
};

/**
 * 记一次发布失败，并决定**这条要不要停止自动重试**。
 *
 * **必须在持有发布锁时调用** —— 它改的是同一条记录的语义，
 * 跟抑制、资格提升共用那把锁。
 *
 * @returns {{paused:boolean, attempts:number, kind:string|null, reason:string|null}}
 */
export function recordPublishFailure(rec, { permanent = false, reason = "未说明" } = {}) {
  const prior = Number.isSafeInteger(rec?.publish_attempts) && rec.publish_attempts > 0
    ? rec.publish_attempts : 0;
  const attempts = prior + 1;
  // **阈值只有一个,不给调用方覆盖。**
  //
  // 上一版公开接受 maxAttempts,而读取端固定按全局上限校验 ——
  // 评审实测 `maxAttempts: 1` 写出的记录，读取端立刻判 corrupt、审计报说不清：
  // **写入端能合法产出读取端认为损坏的状态**。
  // 没有任何生产调用方需要覆盖它，那就别留这个口子。
  const exhausted = attempts >= MAX_AUTO_PUBLISH_ATTEMPTS;
  if (!permanent && !exhausted) {
    rewrite(rec, (next) => {
      next.publish_attempts = attempts;
      // 回到 retrying 就必须把 paused 那三件一起撤干净，否则形状不自洽。
      delete next.publish_rejected_at;
      delete next.publish_rejected_reason;
      delete next.publish_rejected_kind;
    });
    return { paused: false, attempts, kind: null, reason: null };
  }
  const kind = permanent ? "platform_rejected" : "retry_exhausted";
  const why = (permanent
    ? "平台拒绝（" + String(reason) + "）"
    : "自动重试预算耗尽：试了 " + attempts + " 次都没成（" + String(reason) + "）")
    .slice(0, 400) || "未说明";
  rewrite(rec, (next) => {
    next.publish_attempts = attempts;
    next.publish_rejected_at = new Date().toISOString();
    next.publish_rejected_reason = why;
    next.publish_rejected_kind = kind;
  });
  return { paused: true, attempts, kind, reason: why };
}

export function markSent(rec, messageId) {
  const next = { ...rec, published_at: new Date().toISOString(), feishu_message_id: messageId ?? null };
  delete next._file;
  delete next._raw;
  // **发出去了，重试保护就没有意义了 —— 在同一次写里清掉。**
  //
  // 显式重试曾经在发布**之前**清标：dry-run 也会改盘，构卡失败或进程中断
  // 会把记录重新暴露给自动发布。保护要留到确实不需要为止，而不是提前撤。
  delete next.publish_rejected_at;
  delete next.publish_rejected_reason;
  delete next.publish_rejected_kind;
  delete next.publish_attempts;
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
/**
 * 取发布锁，**取不到就短暂重试**。
 *
 * 这些临界区都很短（读一个文件、写回去），争用几乎总是瞬时的。
 * 一次拿不到就放弃，会把"稍等一下就好"变成"这条记录永远改不动"。
 * 但重试是**有界**的：拿不到就得让调用方知道。
 */
function acquirePublishLockWithRetry(dir, { attempts = 6, waitMs = 120 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = acquirePublishLock(dir);
    if (last.ok) return last;
    if (i < attempts - 1) {
      // 同步等一小会儿 —— 这些函数都是同步契约，不能改成 async。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  return last;
}

/**
 * Codex 一轮答复的事件键 —— **只有这一份公式**。
 *
 * 恢复消费者不能信标记自报的 event_key：一张 claim_key 与文件名自洽、
 * 但 event_key 指向别人答复的标记，就能替另一条 claim 授予发布资格。
 * 所以它按 thread + 文件名里的 claim key 自己算一遍。
 * 算的人多了公式就会分叉，因此 watcher、Stop 钩子、恢复器共用这个函数。
 */
export function codexReplyEventKey({ threadId, claimKey }) {
  return "codex:" + threadId + ":claim:" + claimKey + ":reply";
}

/**
 * 给一条事件授予自动发布资格。
 *
 * @param requireRunId 非空时，命中的那条记录必须 `run_id === requireRunId`。
 *        恢复消费者必须传 —— 它处理的是"标记说该给谁资格"，
 *        而标记是发布授权制品，得验真。
 */
export function markPublishEligibleByEventKey({
  outboxDir, eventKey, publishLockDir, requireRunId = null,
}) {
  if (typeof eventKey !== "string" || !eventKey.trim()) return { ok: false, reason: "no_event_key" };
  // **改同一条记录的语义，就得跟抑制拿同一把锁。**
  //
  // 抑制在锁内读一份字节快照、核对摘要、然后写回。如果这里不取锁，
  // 就能在"快照读完、写回之前"改掉同一条记录 —— 抑制照样成功，
  // **并发写入的新内容被旧快照覆盖，然后那条记录被永久抑制**。
  // 摘要只保护到"预览 → 锁内快照"，保护不了"快照 → 写回"。
  //
  // 锁是必需参数：说不清跟谁串行就不许改，别留一个"忘了传"的入口。
  if (typeof publishLockDir !== "string" || !publishLockDir) {
    return { ok: false, reason: "publish_lock_required" };
  }
  const lock = acquirePublishLockWithRetry(publishLockDir);
  if (!lock.ok) return { ok: false, reason: "publisher_busy", detail: lock.reason };
  try {
    return markEligibleLocked({ outboxDir, eventKey, requireRunId });
  } finally {
    releasePublishLock(publishLockDir);
  }
}

/** 锁内那一段。**只在持有发布锁时调用。** */
function markEligibleLocked({ outboxDir, eventKey, requireRunId = null }) {
  let files;
  try {
    files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { ok: false, reason: "event_not_found" };
  }
  // **先把命中全找出来，再判断。**找到第一条就返回的话，"同一个事件键有两条记录"
  // 这种损坏永远看不见 —— 而资格是发布授权，模棱两可时必须拦住。
  const hits = [];
  for (const name of files) {
    const file = path.join(outboxDir, name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { continue; }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
    if (rec.event_key !== eventKey) continue;
    hits.push({ file, rec });
  }
  if (hits.length === 0) return { ok: false, reason: "event_not_found" };
  if (hits.length > 1) return { ok: false, reason: "event_key_ambiguous", count: hits.length };
  const { file, rec } = hits[0];
  // 标记自报的身份不算数：要求这条记录确实属于那个 claim。
  if (requireRunId !== null && rec.run_id !== requireRunId) {
    return { ok: false, reason: "run_id_mismatch" };
  }

  // **三态判据跟审计、抑制共用同一份。**
  //
  // 这里本来自己判"published_at 非 null 就是已发布"、"publish_suppressed_at 非空
  // 就是已停发"——比共用判据松：published_at 放 false、publish_suppressed_at 放
  // "abc"，都会被当成"已经有结论"，于是恢复器撤掉标记，那条答复再没人管。
  // 损坏就该说损坏。
  const verdict = classifyOutboxRecord(rec);
  if (verdict.unclassified) {
    return { ok: false, reason: "record_unclassified", why: verdict.why };
  }
  if (verdict.state === "published") {
    return { ok: true, changed: false, reason: "already_published", record: rec };
  }
  // **停发是终局，资格提升不许再碰它。**
  // 它不会因此被发出去（发布筛选认停发），但那是靠下游**另一份判据**兜住的；
  // 判据一变，人永久停掉的东西就复活了。
  // 返回 ok 是因为"已经有结论"——让恢复器撤掉标记，不要永远重试。
  if (verdict.state === "suppressed") {
    return { ok: true, changed: false, reason: "already_suppressed", record: rec };
  }
  // **"已经有资格"要用唯一那份授权判据。**
  //
  // 上一版是"非空字符串就算数"，跟 hasPublishAuthorization 分叉：
  // 评审把值设成 not-a-canonical-time，恢复器返回 already_eligible 并撤掉标记，
  // 而发布器判它**未获授权** —— 于是"一轮已完成、却再也没有恢复路径"。
  // 一份畸形的值同时是"够了，别管了"和"不算数，别发"，唯一的恢复证据被销毁。
  if (rec.publish_eligible_at !== undefined && rec.publish_eligible_at !== null) {
    if (!hasPublishAuthorization(rec)) {
      return { ok: false, reason: "record_unclassified", why: "publish_eligible_at 不是规范时间" };
    }
    return { ok: true, changed: false, reason: "already_eligible", record: { ...rec, _file: file } };
  }
  const next = { ...rec, publish_eligible_at: new Date().toISOString() };
  const tmp = file + ".tmp." + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true, changed: true, record: { ...next, _file: file } };
}

/** 保留原始事件作审计，但把严格终局失败对应的半成品答复移出所有发布队列。 */
export function suppressPublishByEventKey({ outboxDir, eventKey, reason, publishLockDir }) {
  if (typeof eventKey !== "string" || !eventKey.trim()) return { ok: false, reason: "no_event_key" };
  // **改同一条记录的语义，就得跟抑制拿同一把锁。**
  //
  // 抑制在锁内读一份字节快照、核对摘要、然后写回。如果这里不取锁，
  // 就能在"快照读完、写回之前"改掉同一条记录 —— 抑制照样成功，
  // **并发写入的新内容被旧快照覆盖，然后那条记录被永久抑制**。
  // 摘要只保护到"预览 → 锁内快照"，保护不了"快照 → 写回"。
  //
  // 锁是必需参数：说不清跟谁串行就不许改，别留一个"忘了传"的入口。
  if (typeof publishLockDir !== "string" || !publishLockDir) {
    return { ok: false, reason: "publish_lock_required" };
  }
  const lock = acquirePublishLockWithRetry(publishLockDir);
  if (!lock.ok) return { ok: false, reason: "publisher_busy", detail: lock.reason };
  try {
    return suppressByEventKeyLocked({ outboxDir, eventKey, reason });
  } finally {
    releasePublishLock(publishLockDir);
  }
}

/** 锁内那一段。**只在持有发布锁时调用。** */
function suppressByEventKeyLocked({ outboxDir, eventKey, reason }) {
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

/**
 * 这条记录**取得了自动发布授权**吗。
 *
 * `publish_eligible_at` 是授权字段，不是普通时间戳：它一旦为真，
 * Stop、watcher、兜底调度器都会把这条内容发到飞书。
 *
 * 上一版的筛选是"非空字符串就算数" —— 评审实测把它设成
 * `not-a-canonical-time`，审计照样 ok:true，**自动发布真的调了发布器**。
 * 一个畸形的值被当成了人的授权。
 *
 * **判据只有这一份**：筛选、审计、锁内快照都走它。
 */
export const hasPublishAuthorization = (rec) => isCanonicalIso(rec?.publish_eligible_at);

export function explainabilityGaps(rec) {
  const gaps = [];
  // **trim 后非空**，不是"长度大于 0"。生产入口生成的 id 不可能是纯空白，
  // 而 id:"   " 在上一版能通过 —— 于是一条谁也认不出来的记录被成功抑制。
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  if (!str(rec?.id)) gaps.push("id");
  // **判据要跟生产入口对齐。**上一版只要求"非空字符串"，于是
  // kind:"not-a-kind" 被判为正常并成功抑制 —— 而 appendEvent 根本造不出这种记录。
  // 评审实测复现。**审计放行的集合不该比生产能产出的集合更大**：
  // 多出来的那部分谁也说不清是怎么来的，而抑制是不可逆的。
  if (!KINDS.includes(rec?.kind)) gaps.push("kind");
  // 同理：appendEvent 要求正文 trim 后非空（empty_text 会被拒），审计也要求同一条。
  if (typeof rec?.text !== "string" || rec.text.trim().length === 0) gaps.push("text");
  if (!isCanonicalIso(rec?.created_at)) gaps.push("created_at");
  // **授权字段只接受 null 或规范时间。**别的值一律说不清 ——
  // 而"说不清的授权"会被下游当成真的授权。
  const auth = rec?.publish_eligible_at;
  if (auth !== undefined && auth !== null && !isCanonicalIso(auth)) {
    gaps.push("publish_eligible_at");
  }
  // **目标代际也要在这一层看见。**
  //
  // 上一版没验它：一条字段齐全的记录只要把 target_channel_generation_id
  // 写成纯空白，审计就报干净、统一守卫返回 null。查看器之所以能拦住，
  // 是因为它**自己又查了一次** —— 所谓"唯一守卫"实际上是两份判据，
  // 而这正是这条线上反复被罚的那件事。
  // 抑制核心的 corruptTargets 保留作纵深防御，但判定从这里开始。
  if (generationTargetState(rec) === "corrupt") gaps.push("target_channel_generation_id");

  // **重试保护那几个字段也要在这一层看见，而且要验成一台封闭状态机。**
  //
  // 评审两次指出这里不够封闭：先是三个字段完全不验 —— 把它们改成
  // "five" / "not-a-time" / 一个对象，auditOutbox 仍报 ok:true，
  // **一条已暂停的记录靠写坏自己的保护字段就重新进入了自动发布队列**；
  // 然后是 `attempts: 0`、"有 at/reason 却没 attempts" 仍被放行，
  // 而生产写入端根本产不出这两种形状。
  // **审计放行的集合不该比生产能产出的集合更大。**
  // 名字点的是**整台状态机**而不是某一个字段 —— 坏的是形状，
  // 说成"publish_attempts 有问题"会把人支去只看那一个字段。
  if (retryProtectionState(rec) === "corrupt") gaps.push("publish_retry_protection");

  return gaps;
}

/**
 * **这个 outbox 现在能不能动？** 不可逆入口只认这一项。
 *
 * 上一轮的毛病就是"核心接了、消费方没接"：unexplainable 在核心里生成了，
 * 两侧 CLI 的预览和查看器都还只看 unclassified —— 于是预览 exit 0 说可以加
 * --apply，落盘时才被拒。**预览和执行给出相反结论**，这是同一个坑的第二次。
 *
 * 所以把"能不能动"收成一个函数：新增一类阻断因素时，所有入口自动跟上，
 * 而不是等哪个消费方漏接了被评审逮到。
 *
 * @returns null 表示可以动；否则是该报的原因（含 count/files）。
 */

export function outboxMutationBlocker(audit) {
  if (!audit || audit.ok !== true) {
    return { reason: audit?.reason ?? "outbox_unreadable", count: 0, files: [] };
  }
  for (const [key, reason] of [
    ["unclassified", "outbox_unclassified"],
    ["unexplainable", "outbox_unexplainable"],
  ]) {
    const hits = audit[key] ?? [];
    if (hits.length > 0) {
      return { reason, count: hits.length, files: hits.map((u) => u.file), details: hits };
    }
  }
  return null;
}

/**
 * 一条记录处于三态里的哪一态 —— **判据只有这一份**。
 *
 *   suppressed：publish_suppressed_at 是规范时间
 *   pending   ：published_at === null
 *   published ：published_at 是规范时间
 * 三样都不是 → 说不清，拦住。
 *
 * **三态必须互斥。**曾经只要 publish_suppressed_at 非空就判 suppressed，
 * 不管 published_at 是什么 —— 一条"既发过又被停过"的自相矛盾记录被静默接受。
 * 停发的前提就是它还没发出去。
 *
 * **严格校验字段类型，不能只看"有没有这个键"。**评审实测：published_at
 * 放 false / 0 / {} / "" 时都曾被当成"已发布"静默跳过 ——
 * 一批损坏记录就这样被永久藏起来。
 */
export function classifyOutboxRecord(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    return { unclassified: true, why: "不是记录对象" };
  }
  const sup = rec.publish_suppressed_at;
  if (sup !== undefined && sup !== null) {
    // 复用规范时间校验，不自己判"非空字符串" —— 纯空白、"abc"、"2026-13-45"
    // 都能通过"非空"，却都不是时间。判据松一点，损坏记录就又被藏起来。
    if (!isCanonicalIso(sup)) {
      return { unclassified: true, why: "publish_suppressed_at 不是规范时间" };
    }
    if (rec.published_at !== null) {
      return { unclassified: true, why: "既标了已发布又标了已停发，状态自相矛盾" };
    }
    return { state: "suppressed" };
  }
  if (!("published_at" in rec)) {
    return { unclassified: true, why: "缺 published_at，无法归类" };
  }
  const pub = rec.published_at;
  if (pub === null) return { state: "pending" };
  if (isCanonicalIso(pub)) return { state: "published" };
  return { unclassified: true, why: "published_at 既不是 null 也不是规范时间" };
}

/**
 * **一次读盘，之后全用这一份。**
 *
 * ■ 为什么必须只读一次
 *
 * 抑制预览曾经读两遍：渲染正文一遍、算摘要一遍。评审在两次读之间做同名替换 ——
 * **人看到的是 A，拿到的摘要绑的是 B**，随后他"合法地"永久抑制了 B。
 * 摘要能防住"预览之后变化"，却防不住"渲染和摘要看的不是同一份"。
 *
 * 同理，锁内也只读一次：审计、选择、摘要、写回全用这一份字节，
 * 中间不留任何"再读一次"的窗口。
 *
 * ■ 边界
 *
 * 它只负责 readdir / read / parse / classify，**不接 selector 回调** ——
 * 代际选择仍归调用方的 readState().select。把选择并进来会让这个函数
 * 依赖调用方的回调，那是另一件事。
 *
 * @returns {{ok:true, files:string[], records:object[], audit:object}|{ok:false, reason:string}}
 *          records 里每条带 `_file`（绝对路径）和 `_raw`（原始字节）。
 */
export function readOutboxSnapshot(outboxDir) {
  let names;
  try {
    const st = fs.statSync(outboxDir);
    if (!st.isDirectory()) return { ok: false, reason: "outbox_not_a_directory" };
    names = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: true, files: [], records: [],
        audit: { ok: true, pending: 0, unclassified: [], unexplainable: [], files: [] } };
    }
    return { ok: false, reason: "outbox_unreadable" };
  }
  const unclassified = [];
  const unexplainable = [];
  const records = [];
  let pending = 0;
  for (const name of names) {
    const file = path.join(outboxDir, name);
    let raw;
    try { raw = fs.readFileSync(file); }
    catch { unclassified.push({ file: name, why: "读不出来" }); continue; }
    let rec;
    try { rec = JSON.parse(raw.toString("utf-8")); }
    catch { unclassified.push({ file: name, why: "读不出来" }); continue; }
    const verdict = classifyOutboxRecord(rec);
    if (verdict.unclassified) { unclassified.push({ file: name, why: verdict.why }); continue; }
    const gaps = explainabilityGaps(rec);
    if (gaps.length > 0) {
      unexplainable.push({ file: name, why: "缺少解释这条记录所必需的字段：" + gaps.join("、") });
    }
    if (verdict.state === "pending") {
      pending += 1;
      records.push({ ...rec, _file: file, _raw: raw });
    }
  }
  return {
    ok: true,
    files: [...names],
    records,
    audit: { ok: true, pending, unclassified, unexplainable, files: [...names] },
  };
}

export function auditOutbox(outboxDir) {
  let files;
  try {
    const st = fs.statSync(outboxDir);
    if (!st.isDirectory()) return { ok: false, reason: "outbox_not_a_directory" };
    files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    // 不存在 = 还没发过东西，合法的空。其他错误（权限等）说不清，拦住。
    if (err.code === "ENOENT") {
      return { ok: true, pending: 0, unclassified: [], unexplainable: [], files: [] };
    }
    return { ok: false, reason: "outbox_unreadable" };
  }
  let pending = 0;
  const unclassified = [];
  const unexplainable = [];
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(outboxDir, f), "utf-8")); }
    catch { unclassified.push({ file: f, why: "读不出来" }); continue; }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      unclassified.push({ file: f, why: "不是记录对象" }); continue;
    }
    // **能不能归三态，和能不能解释这条记录，是两回事。**
    //
    // 上一版只验对象类型和发布三态，于是
    // `{"published_at":null,"target_channel_generation_id":"gen-1"}`
    // 得到 pending:1、unclassified:[] —— 一条没有 id、没有 kind、没有正文、
    // 没有时间的文件被判成合法待发，然后被**永久抑制**。
    // 抑制是不可逆的：连"这是什么"都说不出来的东西，不能替它做这个决定。
    //
    // 这里要的不是"字段齐全"，而是**足以解释它**：是什么、什么时候、哪一类。
    // 真实历史记录（含升级前那批）这四样都有，收紧不会误伤。
    const missing = explainabilityGaps(rec);
    // **分开报，不并进 unclassified。**
    // "三态判不出来"和"这条记录解释不了"是两个问题：前者是不知道它处于
    // 什么状态，后者是知道状态但不知道它是什么。混成一个字段，读的人
    // 就会把两种完全不同的处置方式当成一种 —— 这仓库为"字段名让人误读"
    // 罚过一次了。归类照常进行；能不能对它动手，由调用方按这个字段决定。
    if (missing.length > 0) {
      unexplainable.push({ file: f, why: "缺少解释这条记录所必需的字段：" + missing.join("、") });
    }
    // 三态判据跟快照读取共用一份 —— 两处各写一遍就会分叉。
    const verdict = classifyOutboxRecord(rec);
    if (verdict.unclassified) { unclassified.push({ file: f, why: verdict.why }); continue; }
    if (verdict.state === "pending") pending += 1;
  }
  // **files 是这个目录里全部 JSON 的文件名**，不只是待发那些。
  // 抑制的 CAS 要用它：只比"待发集合"的话，一个坏 JSON 对 CAS 完全不可见 ——
  // 预览到落盘之间冒出来一个，集合前后一模一样，一路放行。评审实测复现。
  return { ok: true, pending, unclassified, unexplainable, files: [...files] };
}
