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

import fs from "node:fs";
import path from "node:path";

import { loadChainTemplate, resolveLarkIdentity } from "./chain-template.mjs";
import { bindingsForRoot, currentBinding, describeStatus, setBindingStatus } from "./feishu-control.mjs";
import {
  acquirePublishLock, exactProjectsForRoot, loadRegistryStrict, normalizeRoot,
  registryPath, releasePublishLock,
} from "./registry.mjs";
import { topicGenerationLockDir } from "./topic-generation-store.mjs";
import { publishDraft, sendToChat } from "./outbound.mjs";
import { isDirectRun } from "./direct-run.mjs";
import {
  bindingToken, composeRootMessage, composeStatusMessage, idempotencyKeyFor,
  newRegistryEntry, readProjectIdentity,
} from "./bind-compose.mjs";

// ---------- CLI ----------

if (isDirectRun(import.meta.url)) {

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

/**
 * **这个 CLI 里所有登记表写入的唯一入口。**
 *
 * 两条要求合在一处：
 *
 *   · 锁内重读、校验、更新、原子写 —— 拿锁外那份快照写回去，
 *     并发的另一个 binder 就会被整体覆盖。
 *   · **锁内一律不 exit、不 die。**`process.exit()` 会跳过 finally，锁就漏了 ——
 *     这个坑我在抑制命令上踩过一次，这里又踩了一次：上一版锁内有四条 exit 路径。
 *     所以这里只返回结果，退出码和输出全部由调用方在锁释放之后处理。
 *
 * mutate(registry) 在锁内跑，返回 { ok, ... }；ok 为 true 时才写盘。
 */
function withRegistryTransaction({ regFile, root, mutate }) {
  const lockDir = topicGenerationLockDir({ source: "registry", registryFile: regFile, root });
  const lock = acquirePublishLock(lockDir);
  if (!lock.ok) return { ok: false, kind: "busy", reason: lock.reason };
  try {
    const fresh = loadRegistryStrict(regFile);
    if (!fresh.ok) {
      return { ok: false, kind: "unreadable", reason: fresh.reason + "：" + fresh.error };
    }
    const reg = { ...fresh.raw, projects: fresh.projects };
    const decided = mutate(reg);
    if (!decided.ok) return decided;
    if (decided.skipWrite) return decided;
    try {
      fs.mkdirSync(path.dirname(regFile), { recursive: true, mode: 0o700 });
      if (fs.existsSync(regFile)) fs.copyFileSync(regFile, regFile + ".prev");
      const tmp = regFile + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, regFile);
    } catch (err) {
      return { ok: false, kind: "write_failed", reason: err.message };
    }
    return { ...decided, count: reg.projects.length };
  } finally {
    releasePublishLock(lockDir);
  }
}

const loaded0 = loadRegistryStrict(regFile);
if (!loaded0.ok) {
  die("登记表" + (loaded0.reason === "bad_json" ? "不是合法 JSON"
    : loaded0.reason === "bad_shape" ? "形状不对" : "读不了") + "：" + loaded0.error,
    "没有动任何文件。先把 " + regFile + " 修好或挪走，再重跑。");
}
let registry = { ...loaded0.raw, projects: loaded0.projects };

// **歧义要在任何动作之前就拦下。**
//
// 上一版只把这条检查放进了登记事务里，而事务**之前**还有三条快速路径：
// 恢复暂停的绑定、报"已经接入"退出、进入建话题流程。它们都靠 findIndex
// 取第一条同 root 记录 —— 于是登记表里有两条时：
//
//   · 第一条完整 → 直接报"已接入"退出，歧义根本没被发现；
//   · 第一条不完整、第二条完整 → **可能先产生飞书侧动作**，之后才在事务里拒绝。
//
// 后者尤其糟：那是不可撤销的。所以这里先数，数不清就立刻停 ——
// 事务内仍会重读重判，防的是并发变化，两处不是重复而是各管一段。
// **用规范化后的 root 比。**`/project/` 和 `/project` 是同一个项目，
// 而登记表里可能是带斜杠的那条、命令解析出来是不带的 —— 字面比较两次都说"没有"，
// 于是可能先建话题、再新增一条逻辑重复的记录。
const sameRootAll = exactProjectsForRoot(registry.projects, root);
if (sameRootAll.length > 1) {
  die("登记表里有 " + sameRootAll.length + " 条同一个项目的记录，说不清该用哪一条。",
    "先人工确认并只保留一条，再重跑。什么都没做，也没有往群里发任何消息。");
}
const at = registry.projects.findIndex((p) => normalizeRoot(p?.root) === normalizeRoot(root));
const already = at >= 0 ? registry.projects[at] : null;
const legacyMapping = path.join(root, ".runtime-data", "inbound", "active-mapping.json");

// 暂停过的绑定：**复用原话题恢复**，绝不新建。
// 新建等于把话题里已有的历史对话变成孤儿，而且群里会多出一个长得一样的话题。
const suspended = currentBinding({ root });
if (suspended.ok && suspended.suspended) {
  console.log(path.basename(root) + " 的接入此前被暂停，将**恢复原话题**（不新建）。");
  console.log("  待发 " + suspended.pending + " 条，恢复后会一并发出。");
  if (!apply) {
    console.log("\n[dry-run] 什么都没做。加 --apply 才真的恢复。");
    process.exit(0);
  }
  const r = setBindingStatus({ root, status: "active" });
  if (!r.ok) {
    console.error("恢复失败（" + r.reason + "）" + (r.error ? "：" + r.error : ""));
    process.exit(1);
  }
  console.log("\n已恢复。改动写在 " + r.store);
  console.log(describeStatus(currentBinding({ root }), bindingsForRoot({ root })));
  process.exit(0);
}

// 已经登记过：确实接入了，什么都不用做。
if (already?.root_message_id) {
  console.log(path.basename(root) + " 已经接入过了，没有重复建话题。");
  console.log("  根话题  " + already.root_message_id);
  console.log("  入站    " + (already.inbound_state === "bound" ? "已绑定" : "待绑定"));
  console.log("看绑定详情：node scripts/binding.mjs");
  process.exit(0);
}

// **有 mapping 但没登记 —— 这不是"已接入"，这是坏的。**
//
// 上一版把这两种情况合成一条：看到项目目录里有 mapping 就报"已经接入过了"然后退出。
// 但**出站路由看的是登记表** —— Stop 钩子用 attributeSession(registry.projects, ...)
// 挑项目，挑不到就**静默退出**，一句日志都不写。于是这个项目的每一轮答复
// 根本没进过出站流程，而这条命令还告诉你"已经接入过了"。
//
// **一条让人以为修好了的成功提示，比报错更难查。**实际是从"话题里十几个小时没动静"
// 才发现的，而那之前每次跑这条命令都说没问题。
//
// 补登记就行，不新建话题：mapping 里那个根消息就是现成的目标。
if (fs.existsSync(legacyMapping)) {
  let mapping = null;
  try { mapping = JSON.parse(fs.readFileSync(legacyMapping, "utf-8")); } catch { /* 下面报 */ }
  const rootId = mapping?.feishu_root_message_id_reference ?? mapping?.root_message_id ?? null;
  if (!rootId) {
    console.error(path.basename(root) + " 的项目内绑定读不出根话题，没法补登记。");
    console.error("  文件：" + legacyMapping);
    process.exit(1);
  }
  console.log(path.basename(root) + " 的绑定在项目目录里，但**登记表里没有它**。");
  console.log("  后果   出站按登记表挑项目，挑不到就静默跳过 —— 答复发不出去，也不报错。");
  console.log("  根话题 " + rootId + "（复用，不新建）");
  if (!apply) {
    console.log("\n[dry-run] 什么都没写。加 --apply 补登记。");
    process.exit(0);
  }
  const done = withRegistryTransaction({ regFile, root, mutate: (reg) => {
    // 同一个 root 出现多条 → 说不清该改哪一条。
    const sameRoot = reg.projects.map((p, i) => ({ p, i })).filter((x) => normalizeRoot(x.p?.root) === normalizeRoot(root));
    if (sameRoot.length > 1) return { ok: false, kind: "ambiguous", count: sameRoot.length };
    // 锁内重读后可能已经被别人补上了 —— 那就什么都不用做。
    if (sameRoot.length === 1 && sameRoot[0].p.root_message_id) {
      return { ok: true, kind: "already", skipWrite: true };
    }
    const adopted = newRegistryEntry({
      root, name: arg("name") ?? readProjectIdentity({ root }).name,
      purpose: arg("purpose") ?? null, token: bindingToken(root), rootMessageId: rootId,
    });
    // **有同 root 的残缺条目就地修，不再 push 一条** —— 那会制造重复归属。
    if (sameRoot.length === 1) reg.projects[sameRoot[0].i] = { ...sameRoot[0].p, ...adopted };
    else reg.projects.push(adopted);
    return { ok: true, kind: "adopted" };
  } });

  // **退出码和输出全部在锁释放之后。**
  if (!done.ok) {
    if (done.kind === "busy") die("登记表正忙（" + done.reason + "），没有动它。稍后再试。");
    if (done.kind === "unreadable") die(done.reason, "没有动任何文件。");
    if (done.kind === "ambiguous") {
      die("登记表里有 " + done.count + " 条同一个项目的记录，说不清该改哪一条。",
        "先人工确认并只保留一条，再重跑。没有动任何文件。");
    }
    die("补登记没写成：" + done.reason);
  }
  if (done.kind === "already") {
    console.log("\n锁内重读发现它已经登记好了（可能是另一个进程刚补的），没有重复写。");
    process.exit(0);
  }
  console.log("\n已补登记      " + regFile + "  （现在 " + done.count + " 个项目）");
  console.log("没有建新话题，也没有往群里发任何消息。下一轮会话结束时答复会走出站。");
  process.exit(0);
}

const identity = readProjectIdentity({ root });
const name = arg("name") ?? identity.name;
const purpose = identity.purpose;
const token = bindingToken(root);
const idemKey = idempotencyKeyFor(root);
const rootText = composeRootMessage({ name, purpose, root, token });

const statusText = composeStatusMessage({ name });

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
  const id = resolveLarkIdentity(template);
  rootMessageId = sendToChat({
    profile: id.profile, chatId: template.chat_id, text: rootText,
    idempotencyKey: idemKey, larkBin: id.bin, larkHome: id.configDir,
    expectedAppId: id.expectedAppId,
  });
} catch (err) {
  die("建话题失败，没有写任何文件：" + err.message);
}
console.log("\n根话题已建立  " + rootMessageId);

// 2. 登记。到这一步话题已经在群里了，所以这里失败不能静默 ——
//    重跑会命中平台侧幂等键，不会多建一个话题。
// **走跟补登记同一个事务入口。**上一版这里拿最初读到的那份 registry 直接整体写回，
// 跟补登记并发时仍会互相覆盖 —— 那样"登记表控制锁"就只是名义上的。
// 建话题可以在锁外靠平台幂等键，但拿到根消息之后必须进同一笔登记事务。
const registered = withRegistryTransaction({ regFile, root, mutate: (reg) => {
  const sameRoot = reg.projects.map((p, i) => ({ p, i })).filter((x) => normalizeRoot(x.p?.root) === normalizeRoot(root));
  if (sameRoot.length > 1) return { ok: false, kind: "ambiguous", count: sameRoot.length };
  const entry = newRegistryEntry({ root, name, purpose, token, rootMessageId });
  if (sameRoot.length === 1) reg.projects[sameRoot[0].i] = { ...sameRoot[0].p, ...entry };
  else reg.projects.push(entry);
  return { ok: true, kind: "registered" };
} });
if (!registered.ok) {
  const why = registered.kind === "ambiguous"
    ? "登记表里有 " + registered.count + " 条同一个项目的记录，说不清该改哪一条"
    : registered.reason;
  die("话题建好了（" + rootMessageId + "）但登记没写成：" + why,
    "修好之后重跑同一条命令即可，幂等键保证不会多建一个话题。");
}
console.log("已登记        " + regFile + "  （现在 " + registered.count + " 个项目）");

// 3. 发状态回复。走 publishDraft，也就是出站平时走的那条路径 —— 它到了话题里，
//    出站就是真的通了，不是我说通了。
try {
  const id2 = resolveLarkIdentity(template);
  const statusId = publishDraft({
    profile: id2.profile, rootMessageId, text: statusText,
    larkBin: id2.bin, larkHome: id2.configDir, expectedAppId: id2.expectedAppId,
  });
  console.log("状态已发布    " + statusId);
} catch (err) {
  console.error("状态回复没发出去：" + err.message);
  console.error("接入本身已完成（登记写好了），只是这条验证消息没发成。");
}

console.log("\n" + name + " 已接入。项目里下一轮会话结束时，回答会自动发到这个话题。");
console.log("入站还差最后一下：去那个话题里 @ 一下运输 agent（空消息也行），绑定就完成了。");
}
