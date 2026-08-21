/**
 * 接入用的纯函数：项目叫什么、根消息长什么样、登记表那一行写什么。
 *
 * 单独一个模块，是为了让「预览」这件事在**代码层面**碰不到发送。
 * bind-project.mjs 会 import outbound.mjs（lark-cli、execFileSync），
 * 而 bind-preview.mjs 只 import 这个文件 —— 于是「放行预览、真发仍逐次确认」
 * 这条权限设置才是名副实归的：被放行的那个入口的依赖图里根本没有能发消息的代码，
 * 不是靠一个 --dry-run 开关自觉。开关会被参数写错绕过，依赖图不会。
 *
 * 这里所有函数都不写文件、不碰网络。读文件只有一处：readProjectIdentity 读项目自己的
 * README/CLAUDE.md。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 默认给一年。次数闸已退役，有效期是入站唯一的闸（见 STATE.md）。 */
export const DEFAULT_TERM_MS = 365 * DAY_MS;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** 给人看的短码，进根消息正文；Codex 首次绑定会从 Aily 附带的根消息引用中精确匹配它。 */
export const bindingToken = (root) => sha(root).slice(0, 6);

/** 平台侧幂等键。同一个项目路径永远算出同一个键，所以重跑不会多建一个话题。上限 50 字符。 */
export const idempotencyKeyFor = (root) => "bind-" + sha(root).slice(0, 40);

export const PURPOSE_MAX = 150;

/**
 * 取第一句。
 *
 * 中英文的断句规则不一样，必须分开处理：中文的 。！？ 后面**不跟空格**，
 * 而英文的 . 后面不跟空格时通常不是句号（`README.md`、`v1.2`、`e.g.`）。
 * 用同一条规则处理两者，要么在文件名中间把句子切断，要么整段都切不开 ——
 * 后者正是第一版的表现：「详见 README」那截尾巴照样跟着进了话题标题。
 */
export function firstSentence(s) {
  const cjk = s.search(/[。！？]/);
  const latin = s.search(/[.!?](\s|$)/);
  const ends = [cjk, latin].filter((i) => i >= 0);
  if (ends.length === 0) return s;
  return s.slice(0, Math.min(...ends) + 1);
}

/**
 * 项目叫什么、干什么 —— 从 CLAUDE.md 取，取不到就用目录名。
 *
 * **绝不为了取名字失败。** 名字糙一点无所谓（目录名本来也够认），接不进来才是问题，
 * 所以这里没有任何一条路径会抛或返回空。
 *
 * 用途取第一段的第一句：整段常常带着「详见 README」这类对话题头没用的尾巴，
 * 而第一句几乎总是那句「这个项目是干什么的」。
 */
/**
 * README 排在 CLAUDE.md 前面，是被 `/init` 教育的结果。
 *
 * `/init` 生成的 CLAUDE.md 头两行是固定模板：
 *   # CLAUDE.md
 *   This file provides guidance to Claude Code (claude.ai/code) when working with code…
 * 照着取就得到 name="CLAUDE.md"、用途是那句样板话 —— 两个都没用。
 * README 是写给人看的，它的一级标题几乎总是项目名。
 */
export const IDENTITY_FILES = ["README.md", "CLAUDE.md"];

/** 标题就是文件名本身（`# CLAUDE.md`）时它不是项目名，跳过这个文件去看下一个。 */
const isFilenameHeading = (name, file) =>
  name.toLowerCase() === file.toLowerCase() || /^(claude|readme|agents)\.md$/i.test(name);

/** `/init` 的样板首段。它出现在本机每一个 /init 过的仓库里，不是项目用途。 */
const isBoilerplate = (s) => /claude\.ai\/code|^This file provides guidance/i.test(s);

/**
 * 去掉行内 markdown。飞书的文本消息**不渲染 markdown** —— 留着 `**` 和反引号
 * 就是把一堆星号发进话题标题。
 */
function stripInlineMarkdown(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // 链接只留字面
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(（])[*_](\S(?:.*?\S)?)[*_](?=[\s)）.,，。!！?？]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

export function readProjectIdentity({ root, files = IDENTITY_FILES }) {
  const fallback = { name: path.basename(root), purpose: null, source: "dirname" };

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, f), "utf-8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    const headingAt = lines.findIndex((l) => /^#\s+\S/.test(l));
    if (headingAt < 0) continue;

    const name = stripInlineMarkdown(lines[headingAt].replace(/^#\s+/, "").trim());
    if (!name || isFilenameHeading(name, f)) continue;

    // 标题之后第一个非空段落，折行拼回一行。
    const para = [];
    for (const line of lines.slice(headingAt + 1)) {
      const t = line.trim();
      if (t.length === 0) { if (para.length) break; else continue; }
      if (/^#{1,6}\s/.test(t)) break;      // 撞上下一个标题：这一段是空的
      if (/^```/.test(t)) break;           // 代码块不是用途说明
      para.push(t);
    }
    const joined = para.join(" ").replace(/\s+/g, " ").trim();

    let purpose = null;
    if (joined && !isBoilerplate(joined)) {
      purpose = stripInlineMarkdown(firstSentence(joined)).slice(0, PURPOSE_MAX).trim();
    }

    return { name, purpose: purpose || null, source: f };
  }

  return fallback;
}

/**
 * 根消息 —— 刻意写成**不随时间失效**的。
 *
 * 正常运行不依赖后续编辑，所以里面一个字都不能是「当前进度」。出站通没通、入站通没通都是状态，
 * 状态放在它底下的回复里（后来的回复能盖掉前面的）；根消息只说这个话题是什么。
 *
 * 入站事件里没有任何飞书 locator（selector.mjs 开头记着的实测结论）。Codex 首次绑定会从
 * Aily 自动附带的根消息引用中读取这行短码，在同时存在多个 pending task 时确定性选中目标；
 * 绑定完成后仍回到 sessionID 路由。Claude 根消息也保留同一信号，不影响其既有行为。
 */
export function composeRootMessage({ name, heading = name, purpose, root, token }) {
  const lines = ["🌉 " + heading];
  if (purpose) lines.push("", purpose);
  lines.push(
    "",
    "本机项目  " + root,
    "绑定码    " + token,
    "",
    "项目里的进展和每一轮回答都会回复到本条消息下面。",
  );
  return lines.join("\n");
}

/**
 * 状态回复 —— 跟根消息分开发的那一条。
 *
 * 它本身就是一次真实的出站验证：走的是 publishDraft，也就是出站平时走的那条代码路径。
 * 换一条路径去验证，验证的就不是真正会被用到的那条。
 *
 * 这里说的是**当前状态**，所以它必须待在根消息之外 —— 根消息发出去改不了，
 * 而状态会变（入站从「差一个 @」变成「已绑定」）。后来的回复能盖掉这一条。
 *
 * 曾经有个 inboundReady 开关，false 分支写着「多绑定改造没做完」。改造做完之后
 * 那个分支就成了不可达的死代码，里面还留着一句关于本系统的假话 ——
 * **没有代码走到的文案最容易变成过期的谎言**，所以直接删掉，不留开关。
 */
export function composeStatusMessage({ name }) {
  return [
    "✅ 出站已接通 —— 你能看到这条，就说明它真的通了。",
    "",
    "入站还差最后一下：**在这条消息下面 @ 一下运输 agent**（空消息也行），绑定就完成了。",
    "建话题的这一刻平台侧的会话还不存在，它是第一条消息流进来才产生的 —— 所以绑定分两段。",
    "绑完之后，在这个话题里说话就是给 " + name + " 下指令。",
  ].join("\n");
}

/**
 * 登记表里的那一行 —— 接入产生的**全部**新状态。
 *
 * 没有 session_id：入站的多绑定路由还没做。project-resolve 合成 mapping 时把它填成 null，
 * 而 evaluateInbound 比的就是这个字段 —— null 跟任何真实 session 都不相等，
 * 所以登记表接进来的项目在入站侧天然关着，一行代码都不用加。
 */
export function newRegistryEntry({ root, name, purpose, token, rootMessageId, now = Date.now() }) {
  return {
    id: path.basename(root),
    root,
    name,
    purpose: purpose ?? null,
    root_message_id: rootMessageId,
    status: "active",
    inbound_state: "pending",
    pending_token: token,
    bound_at: new Date(now).toISOString(),
    expires_at: new Date(now + DEFAULT_TERM_MS).toISOString(),
    note: "由 bind-project 接入。续期：node scripts/binding.mjs --renew 1y --apply",
  };
}
