#!/usr/bin/env node
/**
 * 看看积压里到底是什么。**只读。**
 *
 * ■ 为什么需要它
 *
 * 现有命令只告诉你**有几条**（status 的"待发布答复 13 条"）。于是"要不要清掉"
 * 这个决定没法做 —— 抑制是不可逆的，而人手上只有一个数字。
 * **看不见的东西没法授权。**
 *
 * ■ 这个命令的第一条要求：宁可说不知道，也不能说错
 *
 * 它服务的是一个不可逆决定，所以**"读不出来"绝不能显示成"没有积压"**。
 * 上一版栽在这儿：直接用 listPending，而它把目录错误吞成 []、把坏 JSON 静默跳过，
 * 于是放一个坏文件进去，命令照样 exit 0 说"所有 task 的 outbox 都是空的"。
 * 现在改用 auditOutbox 的严格分类：**只有目录不存在才算空**，其余任何说不清
 * 都点名并非零退出。
 *
 * 同样地，"为什么发不出去"分成两层，各说各的：
 *   · **记录层**（这一条记录自身）：坏了 / 还没资格 / 就绪
 *   · **task 层**（身份、mapping、目标话题）：走 preflightTask
 * 上一版把两层混在一句里，于是 task 已暂停时，每条记录仍显示"等待下一次排空" ——
 * 那是编出来的原因。**混层就会编。**
 *
 * ■ 为什么清除不在这里
 *
 * 抑制已有完整实现，带着一整套守卫。再写一个"顺手清掉"的入口就是第二个
 * 不可逆实现。所以这里只把**真正可执行的**那条命令打出来，人复制过去执行。
 *
 * 而且**有损坏或读不出的记录时不给这条命令** —— 抑制对这种情况是整批拒绝的
 * （"只要有一条坏的，整批都不动"）。给一条注定被拒的命令，比不给更糟。
 *
 * 用法：
 *   node scripts/codex/feishu-outbox.mjs                    # 全部 task
 *   node scripts/codex/feishu-outbox.mjs --task-key <key>   # 只看一条
 *   node scripts/codex/feishu-outbox.mjs --thread-id <id>
 *   node scripts/codex/feishu-outbox.mjs --full             # 不截断正文
 */

import path from "node:path";

import { isDirectRun, moduleDir } from "../direct-run.mjs";
import { listPending, retryProtection } from "../outbox.mjs";
import { nodeCommandPrefix, shellQuote } from "../shell-quote.mjs";
import { generationTargetState } from "../suppress-outbox-core.mjs";
import { hasPublishAuthorization } from "../outbox.mjs";
import { isCanonicalIso } from "../canonical-time.mjs";
import { auditOutbox } from "./drain-service.mjs";
import { outboxMutationBlocker } from "../outbox.mjs";
import { outboxDirOf } from "../drain-outbox.mjs";
import {
  loadRegistryStrict as loadClaudeRegistryStrict, normalizeRoot,
} from "../registry.mjs";
import { preflightTask } from "./publish-eligible.mjs";
import {
  bridgeHome, loadRegistry, registryFile, resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

const OPTIONS = new Set(["thread-id", "task-key"]);
const FLAGS = new Set(["full"]);

export function parseArgs(tokens) {
  const seen = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (typeof t !== "string" || !t.startsWith("--")) {
      return { ok: false, reason: "unexpected_argument", detail: t };
    }
    const name = t.slice(2);
    if (seen.has(name)) return { ok: false, reason: "duplicate_option", detail: t };
    if (FLAGS.has(name)) { seen.set(name, true); continue; }
    if (!OPTIONS.has(name)) return { ok: false, reason: "unknown_option", detail: t };
    const value = tokens[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      return { ok: false, reason: "option_needs_value", detail: t };
    }
    seen.set(name, value);
    i += 1;
  }
  if (seen.has("thread-id") && seen.has("task-key")) {
    return { ok: false, reason: "ambiguous_selector" };
  }
  return { ok: true, seen };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 多久以前。**给相对时间** —— 人关心的是"这有多旧"。 */
export function ageText(iso, now = Date.now()) {
  // **先走规范判据。**审计会拒绝非规范 created_at，而这里如果还用
  // Date.parse，同一份报告就会一边说"解释不了"、一边给出"32 小时前"
  // 这种精确到看着可信的年龄。评审用 "Aug 25 2026" 实测复现。
  if (!isCanonicalIso(iso)) return "时间不是规范格式，读不出来";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "时间读不出来";
  const d = Math.max(0, now - ms);
  if (d < HOUR) return Math.round(d / MINUTE) + " 分钟前";
  if (d < 2 * DAY) return Math.round(d / HOUR) + " 小时前";
  return Math.round(d / DAY) + " 天前";
}

/**
 * 把要显示的文本**去掉控制序列**。
 *
 * outbox 的正文是模型生成的，而这个视图是人用来做**不可逆决定**的。
 * 评审第一轮实测：清屏序列原样进了输出 —— 一段内容可以清屏、移光标、
 * 伪造后面的提示行，让人看到的和实际存在的东西不一样。
 *
 * 第二轮又指出两个漏口，都比第一个更难想到：
 *   · 换行、回车、TAB、U+2028/U+2029 没处理 —— 换行同样能伪造后续行；
 *   · **坏文件名压根没经过净化**。而这个命令的用途恰恰是查看畸形文件，
 *     所以文件名不能当成可信输入。
 *
 * 所以判据放宽到"所有 C0/C1 + 行分隔符 + 双向文本控制符"，
 * 并且在**最终输出边界**统一过一遍（见 say/warn），
 * 而不是逐个插值点去记得调用它 —— 那种写法漏一个就前功尽弃。
 *
 * 换成可见占位符而不是删掉 —— **"这里原本有东西"本身是信息**。
 */
export function sanitizeForDisplay(text) {
  // **双向控制符用 Unicode 属性，不手数码位。**
  // 上一版手写区间漏了 U+061C（ARABIC LETTER MARK）—— 评审把它放进坏文件名，
  // 真实 CLI 的 stdout 原样带出来了。手数码位这条路的错误模式就是"漏掉的那个"，
  // 跟摘要手挑字段是同一类问题：补一个还有下一个。
  return String(text ?? "").replace(
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Bidi_Control}/gu, "\uFFFD");
}

/**
 * **输出边界。**这个文件里所有打印都走这两个 —— 直接 console.log 会漏掉净化。
 * 换行由这里加，所以格式串里不需要也不允许内嵌 \n。
 */
const say = (line = "") => console.log(sanitizeForDisplay(line));
const warn = (line = "") => console.error(sanitizeForDisplay(line));

/** 正文压成一行，默认截断 —— 一屏能看完才叫"看得见"。 */
export function oneLine(text, { full = false, width = 60 } = {}) {
  const flat = sanitizeForDisplay(text).replace(/\s+/gu, " ").trim();
  if (full || flat.length <= width) return flat || "(空)";
  return flat.slice(0, width) + "…";
}

/**
 * 这一条记录的状态。
 *
 * **"字段形状对"不等于"发得出去"。**上一版只看字段形状，于是一条冻结到
 * 已 retired（或压根不存在）的代际的记录被报成"已就绪"，而真实发布会被
 * resolveTaskOutboundGeneration 拒绝 —— 记录层说就绪、task 层说可发布，
 * **两层都对，合起来仍是一个错误的暗示**。评审原话："不能合起来暗示能发。"
 *
 * 所以这里也做一次真实的目标解析。解析器由调用方给：
 * 给不出（说不清该用哪条 task）就明说不确定，不替它猜一个结论。
 */
export function describeRecordState(record, { resolveTarget = null } = {}) {
  if (generationTargetState(record) === "corrupt") {
    return { code: "corrupt", text: "目标代际不可用（本地记录坏了，重试没用）" };
  }
  // **资格和目标是两个维度，不许一个挡住另一个。**
  //
  // 上一版先返回 not_eligible，再谈目标 —— 于是一条"冻结到已经不存在的代际、
  // 而且没有发布资格"的历史积压只显示"尚未取得发布资格"，
  // 听起来像"等等就好"，实际是**永远发不出去**。
  // 恰恰是最该被看见的那一类被藏得最深：它正是人要决定清不清的那种。
  // 所以先解析目标，target_gone 优先于资格。
  // **授权判据只有一份。**
  //
  // 上一版这里又写了一遍"非空字符串" —— 于是对
  // publish_eligible_at:"not-a-canonical-time"，审计说"解释不了"、
  // 查看器却说"记录本身已就绪"：**同一个 CLI 给出两个相反的结论。**
  // **授权是三态，不是布尔。**
  //
  // 上一版把它压回布尔之后，目标失效那条分支又用 hasEligibility === false
  // 输出"还没取得发布资格" —— **畸形授权在那里退化成了尚未授权**；
  // 目标解析抛错时更是把授权损坏完全藏起来。评审实测复现。
  // 三态跟目标状态**组合渲染**，不许在任何一条分支上再压成布尔。
  //   granted   ：规范时间，真的取得了授权
  //   malformed ：字段在但不是规范时间 —— 需要人看
  //   pending   ：null / 缺失 —— 等等就好
  const rawAuth = record?.publish_eligible_at;
  const auth = hasPublishAuthorization(record) ? "granted"
    : (rawAuth === undefined || rawAuth === null) ? "pending" : "malformed";
  const hasEligibility = auth === "granted";
  const malformedAuth = auth === "malformed";
  // 授权那一维的说法，拼进每一条结论里 —— 不许因为目标那边有事就吞掉它。
  const authNote = auth === "granted" ? ""
    : auth === "malformed" ? "；**发布资格字段是坏的，需要人看一眼**"
      : "；这条也还没取得发布资格";

  if (typeof resolveTarget !== "function") {
    if (malformedAuth) {
      return { code: "auth_malformed",
        text: "发布资格字段是坏的（不是规范时间）—— 需要人看一眼；" +
          "目标话题是否仍有效，这里判不出来" };
    }
    return hasEligibility
      ? { code: "unknown_target", text: "记录本身没问题；目标话题是否仍有效，这里判不出来" }
      : { code: "not_eligible", text: "尚未取得发布资格（目标话题是否仍有效，这里判不出来）" };
  }
  let target;
  try { target = resolveTarget(record?.target_channel_generation_id ?? null); }
  catch (err) {
    // **抛错也不许把授权损坏藏起来。**
    return { code: malformedAuth ? "auth_malformed" : "unknown_target",
      text: "目标话题解析不出来（" + String(err?.message ?? err).slice(0, 60) + "）" + authNote };
  }
  if (!target?.ok) {
    // **目标没了就是没了**，有没有资格都改变不了这个事实 —— 先说这个。
    // 但授权那一维要照说：上一版在这里把三态压回布尔，
    // 于是"畸形授权 + 目标失效"被渲染成了"还没取得发布资格"。
    return { code: "target_gone",
      text: "目标话题代际已经不可用（" + (target?.reason ?? "说不清") + "）—— 永远发不出去" +
        authNote };
  }
  if (malformedAuth) {
    return { code: "auth_malformed",
      text: "发布资格字段是坏的（不是规范时间）—— **这不是「还没轮到它」，是需要人看一眼**" };
  }
  if (!hasEligibility) {
    return { code: "not_eligible", text: "尚未取得发布资格（目标话题还在）" };
  }
  return { code: "ready", text: "记录本身已就绪，目标话题也还在" };
}

/** task 那一层能不能发。**说不出所以然就把原始 reason 摆出来，不翻译成猜测。** */
export function describeTaskPublishability({ task, home }) {
  let pre;
  try { pre = preflightTask({ task, home }); }
  catch (err) {
    return { ok: false,
      text: "这个 task 能否发布查不出来（" +
        sanitizeForDisplay(String(err?.message ?? err)).slice(0, 80) + "）" };
  }
  if (pre?.ok) return { ok: true, text: "task 可发布" };
  const known = {
    auto_publish_disabled: "这个 task 没有开启自动发布",
    mapping_not_active: "绑定当前不是 active（暂停或已解绑）",
    lark_cli_unset: "没有配置 lark-cli",
  };
  return {
    ok: false,
    // 认得的就说人话；认不得的**原样给 reason**，不编。
    text: known[pre?.reason] ?? ("task 暂不可发布（" + (pre?.reason ?? "说不清") + "）"),
  };
}

/**
 * @returns {{ok:true, tasks:Array}|{ok:false, reason:string}}
 * 每个 task 带 `readable`：false 表示 outbox 读不全，**这时候的条数不可信**。
 */
/**
 * 项目级绑定的积压。
 *
 * 它们不在 Codex 登记表里 —— 那张表管的是 task。项目级绑定登记在 Claude 那张
 * registry 里，outbox 路径由 outboxDirOf 决定（会话级绑定是 `outbox-<uuid>/`）。
 * **判据共用**：路径用 outboxDirOf、审计用 auditOutbox，不在这里另写一份。
 *
 * @returns {{ok:true, scanned:true, projects:object[]}|{ok:false, reason:string}}
 *          读不出登记表是**故障**，不是"没有项目" —— 这两件事在输出上长得一样，
 *          含义却相反。
 */
export function collectProjectBacklog() {
  // **用严格读取器。**宽松那个把 EISDIR / EACCES 一律变成"成功的空表"——
  // 评审实测：登记表路径是目录时返回 {ok:true, projects:[]}，
  // 于是"读不出来"又一次显示成了"没有积压"。它还会过滤停用条目，
  // 而停用绑定的 outbox 里照样可能躺着发不出去的内容，正是要给人看的。
  const reg = loadClaudeRegistryStrict();
  if (!reg.ok) return { ok: false, scanned: false, reason: reg.reason ?? "registry_unreadable", projects: [] };
  const seen = new Set();
  const projects = [];
  // **坏的登记项不许静默跳过。**
  //
  // 评审实测：登记表是 {"projects":[{"root":42}]} 时，上一版 `continue` 掉它，
  // 返回 {ok:true, projects:[]} —— **真实 CLI 随后声称项目级视野为空**。
  // 严格读取器只验根节点和 projects 是不是数组，成员形状得在这一层验。
  //
  // 这跟"读不出登记表"是同一条规矩：说不清有哪些项目，就不能说没有积压。
  const bad = [];
  const entries = Array.isArray(reg.projects) ? reg.projects : [];
  for (const [i, project] of entries.entries()) {
    const at = "projects[" + i + "]";
    if (project === null || typeof project !== "object" || Array.isArray(project)) {
      bad.push({ at, why: "不是登记项对象" }); continue;
    }
    const root = project.root;
    // root 要是 trim 后非空的绝对路径 —— 相对路径解析出来是哪儿取决于当前工作目录，
    // 那意味着同一张表在不同进程里指向不同地方。
    if (typeof root !== "string" || root.trim().length === 0) {
      bad.push({ at, why: "root 不是非空字符串" }); continue;
    }
    if (!path.isAbsolute(root)) { bad.push({ at, why: "root 不是绝对路径" }); continue; }
    // **去重之前先规范化。**评审实测：`/project` 和 `/project/` 被当成两个项目，
    // 同一条 outbox 记录被统计、展示两次 —— 人看到的条数是假的。
    // 规范化用共用那份，不在这里另写一套（"root 的规范形式只有这一份定义"）。
    const normalized = normalizeRoot(root);
    const sid = project.claude_session_id;
    if (sid !== undefined && sid !== null
      && (typeof sid !== "string" || sid.trim().length === 0)) {
      bad.push({ at, why: "claude_session_id 形状不对" }); continue;
    }
    const claudeSessionId = sid ?? null;
    const key = normalized + "\u0000" + (claudeSessionId ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    const outboxDir = outboxDirOf(normalized, claudeSessionId);
    const audit = auditOutbox(outboxDir);
    const entry = {
      name: sanitizeForDisplay(path.basename(normalized)) +
        (claudeSessionId ? "/" + sanitizeForDisplay(String(claudeSessionId).slice(0, 8)) : ""),
      root: normalized,
      readable: audit.ok === true,
      unreadableReason: audit.ok === true ? null : (audit.reason ?? "说不清"),
      unclassified: audit.ok === true ? (audit.unclassified ?? []) : [],
      unexplainable: audit.ok === true ? (audit.unexplainable ?? []) : [],
      blocked: outboxMutationBlocker(audit),
      records: [],
    };
    if (entry.readable) {
      for (const r of listPending({ outboxDir })) {
        entry.records.push({
          file: path.basename(r._file ?? ""),
          kind: sanitizeForDisplay(r.kind ?? "?"),
          createdAt: r.created_at ?? null,
          text: r.text ?? "",
          // 被永久拒绝过的要单独说 —— 它不会再自动重试，是在等人。
          // 读法只有投影这一份：状态、成因、原因一次取全，不再拼裸字段。
          ...(() => {
            const rp = retryProtection(r);
            return {
              rejected: rp.status === "paused",
              rejectedKind: rp.status === "paused" ? rp.kind : null,
              rejectedWhy: rp.status === "paused" ? sanitizeForDisplay(rp.reason) : null,
            };
          })(),
        });
      }
    }
    if (!entry.readable || entry.unclassified.length > 0
      || entry.unexplainable.length > 0 || entry.records.length > 0) {
      projects.push(entry);
    }
  }
  // **有坏项就整体报不完整**，不许拿一份残缺的全景去支撑"没有积压"这个结论。
  if (bad.length > 0) {
    return { ok: false, scanned: false, reason: "registry_entry_malformed",
      bad, projects };
  }
  // **completeness 是收集层的结论，不是渲染层的现算**（R5）。
  // 判定散在渲染层的话，第二个消费者又得自己算一遍 —— 算漏的那个
  // 就会把残缺视野当完整视野报（"积压 0 条"那类假精确）。
  const problems = [];
  for (const entry of projects) {
    if (!entry.readable) problems.push({ at: entry.name, why: "outbox 读不出来（" + entry.unreadableReason + "）" });
    for (const u of entry.unclassified ?? []) problems.push({ at: entry.name + "/" + u.file, why: u.why });
    for (const u of entry.unexplainable ?? []) problems.push({ at: entry.name + "/" + u.file, why: u.why });
  }
  return { ok: true, scanned: true, projects, complete: problems.length === 0, problems };
}

export function collectBacklog({ home = bridgeHome(), threadId = null, taskKey = null } = {}) {
  const reg = loadRegistry(registryFile(home));
  // **原样透传受控 reason/detail。**上一版一律改写成 registry_unreadable ——
  // 登记表那层刚做出来的精确诊断（结构坏了、第几条坏了）到不了用户手上，
  // 他看到的只有"读不出登记表"。
  if (!reg.ok) {
    return { ok: false, reason: reg.reason ?? "registry_unreadable",
      detail: reg.detail ? sanitizeForDisplay(reg.detail) : null };
  }
  const all = reg.tasks ?? [];
  const selected = all.filter((t) =>
    (threadId === null || t.codex_thread_id === threadId) &&
    (taskKey === null || t.logical_task_key === taskKey));
  // **点名要一条却没找到，是错误，不是"没有积压"。**
  if ((threadId !== null || taskKey !== null) && selected.length === 0) {
    return { ok: false, reason: "task_not_found" };
  }

  // **项目级绑定也在视野里。**
  //
  // 上一版只遍历 Codex 登记表里的 task，而项目级绑定的 outbox 在
  // `<项目>/.runtime-data/outbound/outbox/` —— **压根没往那儿看**。
  // cc2cd 当时有 3 条积压，这个命令说"没有积压"。
  // 它不是读不出来，是没看；而措辞让人以为看全了。
  //
  // 这跟这个文件开头写的设计目标正好相反：**"读不出来"绝不能显示成"没有积压"**。
  // 现在再加一句：**"没看"更不能**。
  //
  // 点名了 thread/task 时不扫项目级：那次问的是"这一条 task 怎么样"。
  const projects = (threadId === null && taskKey === null)
    ? collectProjectBacklog()
    : { ok: true, scanned: false, projects: [] };

  const tasks = [];
  for (const task of selected) {
    const outboxDir = taskPaths(task, home).outbox;
    const audit = auditOutbox(outboxDir);
    const entry = {
      name: sanitizeForDisplay(task.task_display_name ?? task.logical_task_key ?? "(未命名)"),
      taskKey: task.logical_task_key ?? null,
      readable: audit.ok === true,
      unreadableReason: audit.ok === true ? null : (audit.reason ?? "说不清"),
      unclassified: audit.ok === true ? (audit.unclassified ?? []) : [],
      // **解释不了的记录也要显示，也要挡住处置命令。**
      // 上一版只存了 unclassified，于是这类记录既看不见、还照样给出抑制命令 ——
      // 而抑制会拒绝它们。查看器和真实入口必须给出同一个结论。
      unexplainable: audit.ok === true ? (audit.unexplainable ?? []) : [],
      blocked: outboxMutationBlocker(audit),
      taskState: describeTaskPublishability({ task, home }),
      records: [],
    };
    if (entry.readable) {
      // **逐记录真解析一次目标代际** —— 只验字段形状会漏掉"冻结到已 retired 的代际"。
      const resolveTarget = (key) => resolveTaskOutboundGeneration(
        task, key === null || key === undefined ? null : key);
      for (const r of listPending({ outboxDir })) {
        const state = describeRecordState(r, { resolveTarget });
        entry.records.push({
          file: path.basename(r._file ?? ""),
          kind: sanitizeForDisplay(r.kind ?? "?"),
          createdAt: r.created_at ?? null,
          text: r.text ?? "",
          state: state.code,
          why: state.text,
        });
      }
    }
    // 读不出来的、有说不清文件的、有待发记录的 —— 三者任一都要出现在报告里。
    if (!entry.readable || entry.unclassified.length > 0
      || (entry.unexplainable ?? []).length > 0 || entry.records.length > 0) {
      tasks.push(entry);
    }
  }
  // 两半的 completeness 聚合成一份结论 —— 消费者只读它，不再自己算。
  const problems = [];
  for (const t of tasks) {
    if (!t.readable) problems.push({ at: t.name, why: "outbox 读不出来（" + t.unreadableReason + "）" });
    for (const u of t.unclassified ?? []) problems.push({ at: t.name + "/" + u.file, why: u.why });
    for (const u of t.unexplainable ?? []) problems.push({ at: t.name + "/" + u.file, why: u.why });
  }
  if (projects.ok && projects.scanned) problems.push(...(projects.problems ?? []));
  const complete = problems.length === 0 && projects.ok !== false;
  return { ok: true, tasks, projects, complete, problems };
}

/**
 * 抑制命令 —— **只在真的能跑通时才给**。
 * 有损坏或说不清的记录时返回 null：抑制对那种情况是整批拒绝的。
 */
export function suppressCommandFor(entry) {
  // **跟真实入口同一个判据。**查看器说"可以跑这条"，抑制却拒绝 ——
  // 那就是给了一条注定被拒的命令。
  if (entry.blocked) return null;
  if (!entry.readable || entry.unclassified.length > 0) return null;
  if ((entry.unexplainable ?? []).length > 0) return null;
  if (entry.records.some((r) => r.state === "corrupt")) return null;
  if (entry.records.length === 0 || !entry.taskKey) return null;
  return nodeCommandPrefix(path.join(moduleDir(import.meta.url), "suppress-outbox.mjs")) +
    " --task-key " + shellQuote(entry.taskKey) + " --all-generations";
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    warn("失败（" + parsed.reason + "）" + (parsed.detail ? "：" + parsed.detail : ""));
    process.exit(1);
  }
  const full = parsed.seen.get("full") === true;
  const got = collectBacklog({
    home: bridgeHome(),
    threadId: parsed.seen.get("thread-id") ?? null,
    taskKey: parsed.seen.get("task-key") ?? null,
  });
  if (!got.ok) {
    warn(got.reason === "task_not_found"
      ? "没有这个 task —— **不是「没有积压」，是点名的那一条不存在。**"
      : got.reason === "registry_malformed"
        ? "登记表结构不对" + (got.detail ? "（" + got.detail + "）" : "") +
          " —— **这不是「没有积压」**，先看一眼那张表。"
        : "读不出登记表（" + got.reason + "）。");
    process.exit(1);
  }
  let trouble = false;
  const proj = got.projects ?? { ok: true, scanned: false, projects: [] };
  // **读不出项目登记表就不许说"没有积压"。**这跟"读不出 task 登记表"是同一条规矩，
  // 上一版漏了后半边视野，于是连这条规矩也一起漏了。
  if (proj.ok === false) {
    warn("项目级绑定的登记表说不清（" + proj.reason + "）—— " +
      "**这不是「没有积压」**，项目级那半边视野现在是瞎的。");
    for (const b of proj.bad ?? []) warn("  " + b.at + " —— " + b.why);
    process.exit(1);
  }

  if (got.tasks.length === 0 && proj.projects.length === 0) {
    // **措辞必须跟实际视野一致。**上一版说"所有 task 的 outbox 都读得通且都是空的"，
    // 字面没错，但读的人会当成"没有任何积压" —— 而项目级绑定压根没被看过。
    say(proj.scanned
      ? "没有积压 —— task 级和项目级绑定的 outbox 都读得通，且都是空的。"
      : "这一条 task 没有积压。**这次只看了点名的那一条**，没有扫项目级绑定。");
    process.exit(0);
  }

  // **项目级跟 task 级共用同一套渲染结构。**
  //
  // 上一版这里是我另写的一份：只看 unclassified、只报数量。于是
  //   · 审计给的 unexplainable 和 blocked 结论被丢掉 —— 一条损坏记录
  //     只显示成"待发 1 条"，没有文件名、没有原因、没有阻断提示；
  //   · 项目级积压**只看得见数量、看不见内容** ——
  //     而这个命令开头承诺的就是"积压里到底是什么"。
  //
  // 同一件事写两份，第二份总会少点什么。这条线上已经因此栽过很多次。
  const projectSections = [];
  let projectTotal = 0;
  let projectComplete = true;
  for (const entry of proj.projects) {
    const lines = [];
    lines.push("【项目 " + entry.name + "】");
    if (!entry.readable) {
      trouble = true;
      projectComplete = false;
      lines.push("  **outbox 读不出来（" + entry.unreadableReason + "）—— 这里的条数不可信。**");
      projectSections.push(lines);
      continue;
    }
    if ((entry.unclassified ?? []).length > 0) {
      trouble = true;
      projectComplete = false;
      lines.push("  **有 " + entry.unclassified.length + " 个文件归不了类，整体不可信：**");
      for (const u of entry.unclassified) lines.push("    " + u.file + " —— " + u.why);
    }
    if ((entry.unexplainable ?? []).length > 0) {
      trouble = true;
      projectComplete = false;
      lines.push("  **有 " + entry.unexplainable.length + " 条记录解释不了，不能对它们动手：**");
      for (const u of entry.unexplainable) lines.push("    " + u.file + " —— " + u.why);
    }
    projectTotal += entry.records.length;
    lines.push("  待发 " + entry.records.length + " 条");
    for (const [i, r] of entry.records.entries()) {
      const pause = r.rejected
        ? "（" + (r.rejectedKind === "retry_exhausted" ? "已暂停：重试预算耗尽，值得再试一次"
          : r.rejectedKind === "platform_rejected" ? "已暂停：平台拒绝，不改内容再试也一样"
            : "已暂停：成因不明") + "）"
        : "";
      lines.push("  " + String(i + 1).padStart(2) + ". [" + r.kind + "] " +
        ageText(r.createdAt) + pause);
      lines.push("      " + oneLine(r.text, { full }));
      if (r.rejected) lines.push("      " + r.rejectedWhy);
    }
    if (entry.blocked) {
      lines.push("  这个项目的 outbox 有说不清的内容，**抑制会整批拒绝** ——");
      lines.push("  先确认上面点名的文件是什么。");
    }
    projectSections.push(lines);
  }

  const readable = got.tasks.filter((t) => t.readable && t.unclassified.length === 0);
  // **总数要含项目级，而且视野不完整时不许给一个看似精确的数。**
  //
  // 上一版只累加 got.tasks —— 同一次输出里先说"项目 X：待发 1 条"、
  // 紧接着说"积压 0 条"，自己跟自己矛盾。改完之后还剩另一半：
  // 有一个文件归不了类时，仍然无条件累加已解析的那些，
  // 于是"1 个文件归不了类"和"积压 0 条"同时出现 ——
  // **一个精确的数字暗示着「我全看清了」，而那不成立。**
  const taskTotal = readable.reduce((n, t) => n + t.records.length, 0);
  const total = taskTotal + projectTotal;
  // completeness 读收集层的结论 —— 这里现算就是第二份判据（R5 上移）。
  const complete = got.complete === true;
  void projectComplete;
  // **这里曾经内嵌过一个 \n** —— 而输出边界的规则正是我自己在同一个文件里定的：
  // 格式串不许带换行。净化器把它换成了 U+FFFD，真实输出首行成了"积压 1 条。<?>"。
  // 空行单独发一次。
  say(complete
    ? "积压 " + total + " 条。"
    : "**至少**积压 " + total + " 条（有读不全的，见下 —— 这个数不完整）。");
  say("");
  for (const lines of projectSections) {
    for (const line of lines) say(line);
    say("");
  }

  for (const t of got.tasks) {
    say("【" + t.name + "】" + (t.taskKey ? t.taskKey : ""));
    say("  " + t.taskState.text);
    if (!t.readable) {
      trouble = true;
      say("  **outbox 读不出来（" + t.unreadableReason + "）—— 这里的条数不可信。**");
      say("");
      continue;
    }
    if (t.unclassified.length > 0) {
      trouble = true;
      say("  **有 " + t.unclassified.length + " 个文件归不了类，整体不可信：**");
      for (const u of t.unclassified) say("    " + u.file + " —— " + u.why);
    }
    if ((t.unexplainable ?? []).length > 0) {
      trouble = true;
      say("  **有 " + t.unexplainable.length + " 条记录解释不了，不能对它们动手：**");
      for (const u of t.unexplainable) say("    " + u.file + " —— " + u.why);
    }
    say("  待发 " + t.records.length + " 条");
    for (const [i, r] of t.records.entries()) {
      say("  " + String(i + 1).padStart(2) + ". [" + r.kind + "] " +
        ageText(r.createdAt) + " · " + r.why);
      say("      " + oneLine(r.text, { full }));
    }
    const cmd = suppressCommandFor(t);
    if (cmd) {
      say("  要停止重试这个 task 的这些内容（**不可逆**）：");
      say("    " + cmd);
      say("    先不加 --apply 看预览；预览会打出落盘该带的 --expect-digest");
      say("    （必要时还有 --expect-generation），照抄上去再加 --apply。");
    } else if (t.blocked) {
      // 已经在上面点过名了，这里只说清没有出路。
      say("  这个 task 的 outbox 有说不清的内容，**抑制会整批拒绝** ——");
      say("  先确认上面点名的文件是什么。");
    } else if (t.records.some((r) => r.state === "corrupt")) {
      trouble = true;
      // **不给注定被拒的命令。**抑制要求整批可归类，有一条坏的就整批不动。
      say("  这个 task 里有损坏记录，**抑制命令会整批拒绝** —— 现在没有自动处置路径，");
      say("  请把上面点名的文件交给维护者。");
    }
    say("");
  }
  process.exit(trouble ? 1 : 0);
}

if (isDirectRun(import.meta.url)) main();
