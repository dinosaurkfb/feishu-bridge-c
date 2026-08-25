/**
 * 一次性意图凭证 —— **把"技能被选中"和"这次操作被授权"分开。**
 *
 * ■ 为什么需要它
 *
 * 出过一次真事故：一条 agent 之间的消息里**提到**了某个 $ 命令，
 * Codex 那边的绑定技能就被选中，直接去执行真实绑定（被审批门挡住了）。
 *
 * 技能描述里明明写着"自然语言讨论、引用或 Agent 消息不得触发"，
 * UserPromptSubmit 钩子的判据也是整条输入精确匹配 ——
 * **但技能选择这一层不受那条判据约束**。description 负责路由，
 * 它回答的是"这段话像不像在说这件事"，而那跟"这次真的被授权了吗"是两个问题。
 * 这是典型的混淆代理（confused deputy）。
 *
 * ■ 三层各管什么
 *
 *   description  → 路由：把话题引到对的技能
 *   hook         → **证明原始意图**：只有原始输入是完整、独立的控制命令时才签发
 *   执行脚本     → **最终闸门**：在取锁、联网、写盘之前原子消费这张凭证
 *
 * 审批仍然是最后一道防线，但**不能承担唯一授权责任** ——
 * 那次事故里挡住绑定的是审批，而不是每条命令都会有审批。
 *
 * ■ 为什么是"原子消费"
 *
 * 消费用 rename：**同一个源路径只能被一个消费者抢到**，失败的一方拿到 ENOENT。
 *（原来写的是"同一 inode 只能 rename 一次"—— 不准确：同一 inode 可以被
 * rename 很多次，起作用的是"这个路径只存在一次"。评审用 12 个并发进程验过：
 * 恰好 1 个成功、11 个拿到 already_used。）
 * 先读后删会有窗口，两个进程可以都读到同一张凭证。
 * 消费必须发生在**任何副作用之前** —— 拿完锁再检查，锁已经被动过了。
 *
 * ■ 为什么住在 scripts/codex/
 *
 * 我一度把它上移到共用层，理由是"自动轮转由共用 launcher 发起、它要签字"——
 * **那个理由本身就是个 bug**：launcher 不该自己签，签字必须发生在做出决定
 * 的那一刻。签发挪回决策点之后，共用代码不再需要这套凭证，
 * 消费端也全在 Codex 侧。将来 Claude 真正共用这套契约时再提升。
 *
 * **home 由调用方传，没有默认值** —— 上移那一轮去掉了对 codex bridgeHome 的
 * 依赖，这个改动本身是好的，保留。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isCanonicalIso } from "../canonical-time.mjs";

/** 凭证有效期。够人看一眼命令再确认，短到跨不过一个会话。 */
export const INTENT_TTL_MS = 5 * 60 * 1000;

export const intentDir = (home) => path.join(home, "intents");

/**
 * 一次授权到底授权了**哪一次操作**。
 *
 * 上一版只绑命令族，评审用三个反例打穿了：
 *   · mode 不分 dialogue / mapping；
 *   · rotate 不分创建 / 取消；
 *   · bind 不绑 project / chat / name；
 *   · **无参数的只读 $feishu-mode 也会签出一张 mode 票，而它能被当写票消费**。
 *
 * 所以凭证绑的是"规范化之后的完整写意图"：动作 + 排序后的参数键值。
 * 参数对不上就不是同一次操作 —— 哪怕命令族一样。
 */
export function intentDigest({ action, params = {} }) {
  const norm = Object.keys(params).sort()
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => k + "=" + String(params[k]));
  return crypto.createHash("sha256")
    .update(action + "\u0000" + norm.join("\u0000")).digest("hex").slice(0, 32);
}

const idPattern = /^[0-9a-f]{32}$/u;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/**
 * 签发一张凭证。**只有钩子该调它** —— 它代表"原始输入确实是这条命令"。
 *
 * @param action   要授权的动作（bind / unbind / rotate / mode…）
 * @param threadId 精确 thread；凭证只对这一条有效
 * @param turnId   这一轮的标识；跨轮复用要被拒
 */
/**
 * 找一张**还活着**的同意图凭证：同 thread、同 turn、同精确意图，且没过期。
 *
 * 已消费的（.consumed）不算 —— 它们不该被复用，那正是"一次只授权一次"的含义。
 */
function findLiveIntent({ digest, threadId, turnId, home, now }) {
  let files;
  try { files = fs.readdirSync(intentDir(home)).filter((f) => f.endsWith(".json")); }
  catch { return null; }
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(intentDir(home), f), "utf-8")); }
    catch { continue; }
    if (rec?.digest !== digest || rec?.thread_id !== threadId) continue;
    if ((rec?.turn_id ?? null) !== (nonEmpty(turnId) ? turnId : null)) continue;
    if (!isCanonicalIso(rec?.expires_at) || now >= Date.parse(rec.expires_at)) continue;
    return { id: rec.id, record: rec };
  }
  return null;
}

export function issueIntent({
  action, threadId, turnId = null, params = {}, home, now = Date.now(),
}) {
  if (!nonEmpty(action) || !nonEmpty(threadId)) {
    return { ok: false, reason: "intent_fields_missing" };
  }
  const digest = intentDigest({ action, params });

  // **同一次输入只签一张。**
  //
  // 上一版每调一次钩子就新签一张，两张都能各自消费 ——
  // "一次输入只授权一次操作"根本不成立。评审同 prompt 连跑两次就复现了。
  // 幂等键 = thread + turn + 精确意图；已消费的不再复用（找不到就重签）。
  const existing = findLiveIntent({ digest, threadId, turnId, home, now });
  if (existing) return { ok: true, id: existing.id, record: existing.record, reused: true };

  const id = crypto.randomBytes(16).toString("hex");
  const dir = intentDir(home);
  const record = {
    schema_version: "1.0",
    id, action, thread_id: threadId, digest,
    turn_id: nonEmpty(turnId) ? turnId : null,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + INTENT_TTL_MS).toISOString(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, id + ".json");
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, reason: "intent_unwritable", error: String(err?.message ?? err).slice(0, 200) };
  }
  return { ok: true, id, record };
}

/**
 * 原子消费一张凭证。**在任何副作用之前调它。**
 *
 * 返回 ok 才允许继续。**每一种拒绝都要能分辨** ——
 * "没给凭证"和"凭证过期"要人做的事不一样。
 */
export function consumeIntent({
  id, action, threadId, turnId = null, params = {}, home, now = Date.now(),
}) {
  if (!nonEmpty(id)) return { ok: false, reason: "intent_missing" };
  // **格式先验。**id 会被拼进路径，不能是任意字符串。
  if (!idPattern.test(id)) return { ok: false, reason: "intent_id_malformed" };

  const file = path.join(intentDir(home), id + ".json");
  const consumed = file + ".consumed";

  // **先 rename 再读。**读完再 rename 的话，两个进程可以都读到同一张。
  try {
    fs.renameSync(file, consumed);
  } catch (err) {
    if (err.code === "ENOENT") {
      // 从没有过，或已经被消费掉了 —— 两种都不许放行。
      return { ok: false, reason: fs.existsSync(consumed) ? "intent_already_used" : "intent_not_found" };
    }
    return { ok: false, reason: "intent_unreadable", error: String(err?.message ?? err).slice(0, 200) };
  }

  let record;
  try { record = JSON.parse(fs.readFileSync(consumed, "utf-8")); }
  catch { return { ok: false, reason: "intent_corrupt" }; }

  // 消费掉了才校验内容 —— **对不上也不还回去**，一张被误用的凭证不该还能再试一次。
  if (record?.action !== action) return { ok: false, reason: "intent_action_mismatch" };
  // **参数也要对上。**只比命令族的话，一张 mode 票能切 dialogue 也能切 mapping，
  // 一张 rotate 票能创建也能取消 —— 那不是"授权了这次操作"，
  // 是"授权了这一类操作"。
  if (record?.digest !== intentDigest({ action, params })) {
    return { ok: false, reason: "intent_params_mismatch" };
  }
  if (record?.thread_id !== threadId) return { ok: false, reason: "intent_thread_mismatch" };
  if (nonEmpty(turnId) && nonEmpty(record?.turn_id) && record.turn_id !== turnId) {
    return { ok: false, reason: "intent_turn_mismatch" };
  }
  if (!isCanonicalIso(record?.expires_at)) return { ok: false, reason: "intent_corrupt" };
  if (now >= Date.parse(record.expires_at)) return { ok: false, reason: "intent_expired" };
  return { ok: true, record };
}

/** 拒绝时给人看的话。**原因不同，该做的事不同。** */
export const INTENT_REJECT_TEXT = {
  intent_missing:
    "这条命令要求一次性意图凭证，而它没有被提供。\n" +
    "  **凭证只由 UserPromptSubmit 钩子在你亲自输入完整命令时签发** ——\n" +
    "  agent 之间转述、引用、正文夹带都不会有。请单独输入那条命令。",
  intent_id_malformed: "凭证 id 格式不对，拒绝执行。",
  intent_not_found: "凭证不存在（可能来自另一轮，或从未签发）。请重新输入那条命令。",
  intent_already_used: "这张凭证已经用过了。**一次输入只授权一次操作**，请重新输入。",
  intent_expired: "凭证已过期。请重新输入那条命令。",
  intent_action_mismatch: "凭证授权的不是这个动作，拒绝执行。",
  intent_params_mismatch:
    "凭证授权的不是这一次操作（参数对不上），拒绝执行。\n" +
    "  **一次输入只授权那一次操作** —— 换了参数就得重新输入命令。",
  intent_thread_mismatch: "凭证属于另一条 thread，拒绝执行。",
  intent_turn_mismatch: "凭证来自另一轮对话，拒绝执行。",
  intent_corrupt: "凭证内容读不出来，拒绝执行。",
  intent_unreadable: "凭证无法访问，拒绝执行。",
};

export const intentRejectText = (reason) =>
  INTENT_REJECT_TEXT[reason] ?? ("凭证校验失败（" + reason + "），拒绝执行。");


/**
 * 有副作用的控制脚本的**统一门禁**。
 *
 * **必须在取锁、联网、写盘之前调。**拿完锁再检查，锁已经被动过了 ——
 * 这个仓库刚为"报错报对了、事情办坏了"付过两次代价（停用先删 plist、
 * 启用先 bootout）。
 *
 * 只在 apply 时要求：预览天然无副作用，要凭证只会逼人先跑一次带凭证的预览，
 * 反而把凭证消费在没用的地方。
 */
export function requireIntent({
  apply, action, threadId, params = {}, argv = process.argv,
  home, now = Date.now(),
}) {
  if (!apply) return { ok: true, skipped: "dry-run" };
  const at = argv.indexOf("--intent");
  const id = at >= 0 ? argv[at + 1] : undefined;
  const r = consumeIntent({ id, action, threadId, params, home, now });
  if (r.ok) return r;
  return { ok: false, reason: r.reason, text: intentRejectText(r.reason) };
}
