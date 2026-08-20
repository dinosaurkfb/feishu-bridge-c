#!/usr/bin/env node
/**
 * 把一个项目接进飞书 —— 每个项目一辈子一次。
 *
 * 接入只产生**一条新事实**：这个项目的话题是哪条根消息。
 * 群、发布身份、profile、授权发送者这些都是机器级的，装的时候配一次
 * （`~/.claude/feishu-bridge/chain-config.json`）；项目叫什么、干什么，CLAUDE.md 里就有。
 * 所以这条命令做的事是：建根话题 → 往登记表加一行。**项目目录里一个文件都不写。**
 *
 * 上一版会在每个新项目里造两个配置文件、38 个字段，其中 33 个是机器级事实的复制品。
 * 复制品越多，改一次配置要同步的地方越多，而不同步时没有任何东西会报错。
 * 收敛靠 project-resolve.mjs：读取方先看项目目录，没有就回落到机器模板 + 登记表那一行。
 *
 * 用法：
 *   node scripts/bind-project.mjs                       # 看会做什么，不发不写
 *   node scripts/bind-project.mjs --apply
 *   node scripts/bind-project.mjs --project ~/x --name "显示名" --apply
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadChainTemplate } from "./chain-template.mjs";
import { registryPath } from "./registry.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 默认给一年。次数闸已退役，有效期是入站唯一的闸（见 STATE.md）。 */
export const DEFAULT_TERM_MS = 365 * DAY_MS;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** 给人看的短码，进根消息正文。将来靠它做确定性匹配（见 composeRootMessage 的注释）。 */
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
 * 它发出去就改不了，所以里面一个字都不能是「当前进度」。出站通没通、入站通没通都是状态，
 * 状态放在它底下的回复里（后来的回复能盖掉前面的）；根消息只说这个话题是什么。
 *
 * 绑定码现在没有代码读它。留着是因为：入站事件里没有任何飞书 locator（selector.mjs 开头
 * 记着的实测结论），将来要把「第一次 @ 认领哪个待绑定」从「全机只有一份」升级成确定性匹配，
 * 唯一可用的信号就是回复时飞书自动附带的引用块 —— 那里面会带上这行字。
 * 从第一天写进去，将来升级不用迁移已经建好的话题。
 */
export function composeRootMessage({ name, purpose, root, token }) {
  const lines = ["🌉 " + name];
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
 */
export function composeStatusMessage({ name, inboundReady }) {
  const lines = ["✅ 出站已接通 —— 你能看到这条，就说明它真的通了。"];
  if (inboundReady) {
    lines.push("", "入站还差一步：在这条消息下面 @M5Claude 发一条（空的也行），绑定就完成了。");
  } else {
    lines.push(
      "",
      "⚠️ 入站（在这里 @M5Claude 给 " + name + " 下指令）还没接通。",
      "入站路由目前只认一个项目，多绑定改造没做完之前，在这个话题里 @ 是不会有反应的。",
    );
  }
  return lines.join("\n");
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

// ---------- CLI ----------

if (import.meta.url === "file://" + process.argv[1]) {

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes("--apply");

const root = path.resolve(arg("project") ?? process.cwd());

const die = (msg, hint) => {
  console.error(msg);
  if (hint) console.error(hint);
  process.exit(1);
};

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die("项目目录不存在：" + root);

const tpl = loadChainTemplate();
if (!tpl.ok) {
  if (tpl.reason === "no_template") {
    die("还没有机器级链路模板：" + tpl.file,
      "先从一个已接好的项目生成一份：\n  node scripts/init-chain-template.mjs --chat-id oc_xxx --apply");
  }
  die("链路模板不可用（" + tpl.reason + "）：" + tpl.file,
    [tpl.error, tpl.missing?.length ? "缺字段：" + tpl.missing.join(", ") : null,
     tpl.malformed?.length ? "形状不对：" + tpl.malformed.join(", ") : null].filter(Boolean).join("\n"));
}
const template = tpl.template;

// ---------- 已经接过就到此为止 ----------
// 重复建话题是这条命令唯一能造成的不可撤销的破坏。

const regFile = registryPath();
let registry = { schema_version: "1.0", projects: [] };
try {
  registry = JSON.parse(fs.readFileSync(regFile, "utf-8"));
  registry.projects ??= [];
} catch { /* 没有登记表就新建 */ }

const at = registry.projects.findIndex((p) => p?.root === root);
const already = at >= 0 ? registry.projects[at] : null;
const legacyMapping = path.join(root, ".runtime-data", "inbound", "active-mapping.json");

if (already?.root_message_id || fs.existsSync(legacyMapping)) {
  console.log(path.basename(root) + " 已经接入过了，没有重复建话题。");
  if (already?.root_message_id) {
    console.log("  根话题  " + already.root_message_id);
    console.log("  入站    " + (already.inbound_state === "bound" ? "已绑定" : "待绑定"));
  } else {
    console.log("  绑定在项目目录里（老形式）：" + legacyMapping);
  }
  console.log("看绑定详情：node scripts/binding.mjs");
  process.exit(0);
}

const identity = readProjectIdentity({ root });
const name = arg("name") ?? identity.name;
const purpose = identity.purpose;
const token = bindingToken(root);
const idemKey = idempotencyKeyFor(root);
const rootText = composeRootMessage({ name, purpose, root, token });

// 入站多绑定路由还没做，这里如实反映。做完之后改成 true，根消息不用动 ——
// 状态本来就不在根消息里。
const INBOUND_READY = false;
const statusText = composeStatusMessage({ name, inboundReady: INBOUND_READY });

console.log("项目    " + name + "  " + root);
console.log("名字来源" + "  " + (arg("name") ? "命令行 --name" : identity.source === "dirname" ? "目录名（没找到 CLAUDE.md 标题）" : identity.source));
console.log("群      " + template.chat_name + "  " + template.chat_id);
console.log("身份    " + template.outbound_agent_name + "（profile " + template.lark_cli_profile + "）");
console.log("\n--- 根消息 ---\n" + rootText);
console.log("\n--- 底下第一条 ---\n" + statusText);
console.log("\n只写一处：" + regFile + "（项目目录里不写任何文件）");

if (!apply) {
  console.log("\n[dry-run] 没有发消息，也没有写文件。加 --apply 才真的做。");
  process.exit(0);
}

// 1. 建话题。失败就什么都不写 —— 干净重来，不留半个状态。
let rootMessageId;
try {
  rootMessageId = sendToChat({
    profile: template.lark_cli_profile, chatId: template.chat_id, text: rootText,
    idempotencyKey: idemKey, larkBin: template.lark_cli_bin, larkHome: template.lark_cli_home,
  });
} catch (err) {
  die("建话题失败，没有写任何文件：" + err.message);
}
console.log("\n根话题已建立  " + rootMessageId);

// 2. 登记。到这一步话题已经在群里了，所以这里失败不能静默 ——
//    重跑会命中平台侧幂等键，不会多建一个话题。
const entry = newRegistryEntry({ root, name, purpose, token, rootMessageId });
if (at >= 0) registry.projects[at] = { ...registry.projects[at], ...entry };
else registry.projects.push(entry);

try {
  fs.mkdirSync(path.dirname(regFile), { recursive: true, mode: 0o700 });
  if (fs.existsSync(regFile)) fs.copyFileSync(regFile, regFile + ".prev");
  const tmp = regFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, regFile);
} catch (err) {
  die("话题建好了（" + rootMessageId + "）但登记没写成：" + err.message,
    "修好权限后重跑同一条命令即可，幂等键保证不会多建一个话题。");
}
console.log("已登记        " + regFile + "  （现在 " + registry.projects.length + " 个项目）");

// 3. 发状态回复。走 publishDraft，也就是出站平时走的那条路径 —— 它到了话题里，
//    出站就是真的通了，不是我说通了。
try {
  const statusId = publishDraft({
    profile: template.lark_cli_profile, rootMessageId, text: statusText,
    larkBin: template.lark_cli_bin, larkHome: template.lark_cli_home,
  });
  console.log("状态已发布    " + statusId);
} catch (err) {
  console.error("状态回复没发出去：" + err.message);
  console.error("接入本身已完成（登记写好了），只是这条验证消息没发成。");
}

console.log("\n" + name + " 已接入。项目里下一轮会话结束时，回答会自动发到这个话题。");
if (!INBOUND_READY) console.log("入站（在话题里 @M5Claude 下指令）还没接通 —— 多绑定路由改造完成后才可用。");
}
