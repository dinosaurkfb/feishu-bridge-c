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
/**
 * 每种动作的参数**长什么样 —— 只有这一份**。
 *
 * 签发端和消费端各拼各的，拼出来必然不一样：
 *   · bind：钩子签的是空参数，脚本消费 { project }；
 *   · rotate:auto：签发端加了 generation，消费端只校验 project。
 * 两处都"看起来对"，合起来是 intent_params_mismatch —— **真实入口全线卡死**，
 * 而单测各自签各自的票，两边都绿。评审用行为探针打穿的。
 *
 * 所以参数只在这里构造。**加字段就要两端同时生效**，没有第二个地方能漏。
 */
export const intentParamsFor = {
  // chatName 也要进摘要：评审实测群名 A/B 的摘要完全相同 ——
  // 一张"绑到 A 群"的票能拿去绑到 B 群，而群名是**发给人看的那个名字**。
  bind: ({ project, chat = null, name = null, chatName = null }) =>
    ({ project, chat, name, chatName }),
  unbind: () => ({}),
  mode: ({ mode }) => ({ mode }),
  rotate: ({ op }) => ({ op }),
  // **attempt 是这次决策的身份。**只按 (project, generation) 的话，
  // 同一代际的**重试**会撞上前一次的墓碑（评审实测 intent_already_used）——
  // 首次启动成功、消费掉，冷却之后的新决策就再也签不出票。
  // 同一次决策幂等靠 attempt 相同；新决策换 attempt，拿到新票。
  "rotate:auto": ({ project, generation = null, attempt = null }) =>
    ({ project, generation, attempt }),
};

/** 按动作构造参数；未知动作直接炸 —— 静默给个空对象等于关掉这道校验。 */
export function buildIntentParams(action, input = {}) {
  const build = intentParamsFor[action];
  if (typeof build !== "function") throw new Error("未知的意图动作：" + String(action));
  return build(input);
}

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
 * 签发账本：**一个 (thread, turn, 意图) 只对应一个槽位，用目录名占位。**
 *
 * 上一版是"先查再随机创建"—— 中间有窗口，评审用 32 个并发签发进程实测跑出
 * **4 张不同的活票**。而且消费之后同一 turn 同一意图还能再签一张，
 * "一次输入只授权一次"仍然不成立（我那条测试甚至明确期待重签，是写错了）。
 *
 * 现在：mkdir 那个槽位 —— **同一个名字只可能被一个进程建成功**，
 * 失败的一方去读已经写好的那张票。消费时在槽位里留一块墓碑（consumed），
 * 之后任何重签都被墓碑挡住。
 *
 * 三条语义因此成立：
 *   消费前重复签发 → 同一张票；
 *   消费后再签     → **拒绝**，不是发新的；
 *   并发签发       → 只产生一个授权。
 */
const slotDir = (home, key) => path.join(intentDir(home), "slots", key);

const slotKey = ({ digest, threadId, turnId }) =>
  crypto.createHash("sha256")
    .update([digest, threadId, turnId ?? ""].join("\u0000"))
    .digest("hex").slice(0, 32);

export function issueIntent({
  action, threadId, turnId = null, params = {}, home, now = Date.now(),
}) {
  if (!nonEmpty(action) || !nonEmpty(threadId)) {
    return { ok: false, reason: "intent_fields_missing" };
  }
  const digest = intentDigest({ action, params });

  // **抢槽位。**mkdir 是原子的：同一个名字只可能被一个进程建成功。
  const key = slotKey({ digest, threadId, turnId });
  const slot = slotDir(home, key);
  // **父目录先建好，槽位本身必须非 recursive 地建。**
  //
  // recursive: true 在目录已存在时**不报 EEXIST** —— 于是每个进程都以为自己
  // 抢到了槽位，各自去签一张。实测 32 个并发跑出 2 张（比"先查再建"的 4 张好，
  // 但仍然不对）。互斥全靠 EEXIST，而 recursive 把它吞了。
  let won = false;
  try { fs.mkdirSync(path.dirname(slot), { recursive: true, mode: 0o700 }); }
  catch (err) {
    return { ok: false, reason: "intent_unwritable", error: String(err?.message ?? err).slice(0, 200) };
  }
  try {
    fs.mkdirSync(slot, { mode: 0o700 });   // 不加 recursive：已存在就要抛 EEXIST
    won = true;
  } catch (err) {
    if (err.code !== "EEXIST") {
      return { ok: false, reason: "intent_unwritable", error: String(err?.message ?? err).slice(0, 200) };
    }
  }
  // 没抢到的一方要等赢家把 id 写完 —— 否则会读到一个还空着的槽位。
  if (!won) {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(slot, "id")); i += 1) {
      if (fs.existsSync(path.join(slot, "consumed"))) break;
      try { fs.readdirSync(slot); } catch { /* 忙等一小会儿 */ }
    }
  }
  // **墓碑优先于一切。**这一次输入已经授权过一次了，不再发第二张。
  if (fs.existsSync(path.join(slot, "consumed"))) {
    return { ok: false, reason: "intent_already_used" };
  }
  if (!won || fs.existsSync(path.join(slot, "id"))) {
    // 没抢到，或抢到了但别人已经写好 —— 读那一张，不新建。
    try {
      const existingId = fs.readFileSync(path.join(slot, "id"), "utf-8").trim();
      const rec = JSON.parse(fs.readFileSync(path.join(intentDir(home), existingId + ".json"), "utf-8"));
      if (isCanonicalIso(rec?.expires_at) && now < Date.parse(rec.expires_at)) {
        return { ok: true, id: existingId, record: rec, reused: true };
      }
      // 过期了：同一次输入的授权窗口已经关了，不续签。
      return { ok: false, reason: "intent_expired" };
    } catch {
      return { ok: false, reason: "intent_unreadable" };
    }
  }

  const id = crypto.randomBytes(16).toString("hex");
  const dir = intentDir(home);
  const record = {
    schema_version: "1.0",
    id, action, thread_id: threadId, digest, slot_key: key,
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
    // 槽位里记下这张票的 id —— 后来者据此读到同一张。
    fs.writeFileSync(path.join(slot, "id"), id, { mode: 0o600 });
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

  // **立墓碑。**没有它的话，同一次输入消费完还能再签一张 ——
  // "一次输入只授权一次"就只是句话。墓碑立在槽位里，重签第一眼就撞上它。
  // 立不上也继续：票已经被 rename 掉了，这一次的授权是有效的；
  // 但要留痕，否则"墓碑没立上"和"从没立过"分不开。
  if (nonEmpty(record?.slot_key)) {
    try {
      fs.mkdirSync(slotDir(home, record.slot_key), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(slotDir(home, record.slot_key), "consumed"),
        new Date(now).toISOString(), { mode: 0o600 });
    } catch { /* 见上：不阻断本次，但下面会报出来 */ }
  }

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
  intent_unreadable:
    "凭证读不到，拒绝执行。最常见的两个原因：凭证还没初始化过（没有凭证文件）；" +
    "这个会话在沙箱里、HOME 被重定向，凭证路径落在了隔离环境里。\n" +
    "  下一步：在真实环境跑一次绑定预览，核对凭证路径是否对得上。",
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
