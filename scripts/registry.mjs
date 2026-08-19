/**
 * 出站登记表、会话归属判定、发布锁。
 *
 * 出站原来只是本项目 CLAUDE.md 里手写的一段约定 —— 只有读到那段文字的会话才会记进展，
 * 换个目录、换个会话就失效。这个模块是把它变成机制的地基：登记表决定「哪些项目接了桥」，
 * 归属判定决定「这次会话给谁干了活」，发布锁保证「同一批进展只发一次」。
 *
 * 三件事都刻意做成确定性的纯文件操作，不调模型、不碰网络。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_REGISTRY = path.join(os.homedir(), ".claude", "feishu-bridge", "registry.json");

export function registryPath() {
  return process.env.FEISHU_BRIDGE_REGISTRY || DEFAULT_REGISTRY;
}

const stripTrailingSlash = (p) => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p);

/**
 * 读登记表。读不到不是错误 —— 绝大多数机器/会话根本没接桥，
 * 那种情况必须安静返回空表，让钩子立刻退出。
 */
export function loadRegistry(file = registryPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { ok: true, reason: "no_registry", file, projects: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 表坏了要说出来。静默当成空表会让整条出站链路无声消失。
    return { ok: false, reason: "bad_json", file, error: err.message, projects: [] };
  }

  const projects = [];
  for (const p of parsed.projects ?? []) {
    if (!p || typeof p.root !== "string" || p.root.length === 0) continue;
    if (p.enabled === false) continue;
    const root = stripTrailingSlash(p.root);
    projects.push({ id: p.id ?? path.basename(root), root });
  }
  return { ok: true, file, projects };
}

export function isUnder(child, root) {
  if (typeof child !== "string" || child.length === 0) return false;
  const c = stripTrailingSlash(child);
  return c === root || c.startsWith(root + "/");
}

/**
 * 在文件里找任一字符串，分块读 + 重叠，避免把整份会话记录读进内存。
 *
 * 会话记录可以到几十 MB，而钩子跑在每一次会话结束时 —— 这里的开销是全机器共担的。
 */
export function fileContainsAny(filePath, needles, { chunkSize = 1 << 20 } = {}) {
  const wanted = needles.filter((n) => typeof n === "string" && n.length > 0);
  if (wanted.length === 0) return [];

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }

  const overlap = Math.max(...wanted.map((n) => n.length)) - 1;
  const found = new Set();
  const buf = Buffer.alloc(chunkSize);
  let carry = "";

  try {
    while (found.size < wanted.length) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      const hay = carry + buf.toString("utf-8", 0, n);
      for (const needle of wanted) {
        if (!found.has(needle) && hay.includes(needle)) found.add(needle);
      }
      carry = overlap > 0 ? hay.slice(-overlap) : "";
    }
  } catch {
    /* 读到一半出错：按已找到的算，宁可少归属也不崩在钩子里 */
  } finally {
    fs.closeSync(fd);
  }

  return [...found];
}

/**
 * 判定这次会话给哪些登记项目干了活。
 *
 * 两个信号：
 *   cwd        —— 会话起在项目里，强信号；
 *   transcript —— 会话记录原文里出现过项目路径，弱信号。
 *
 * 为什么要弱信号：会话可能起在别处却操作了本项目（Frank 的常态）。
 * 为什么用原文 grep 而不是结构化工具调用：auto 模式下文件操作走 Bash heredoc，
 * 拿不到 file_path 字段，只有原文里那串路径是稳定可见的。
 *
 * 误判方向是刻意选的：宁可多归属。多归属最坏的后果是把本来就该发的进展**提早**发出去
 * （兜底定时器 30 分钟内也会发），漏归属的后果是进展卡在本地，Frank 永远不知道。
 */
export function attributeSession({ projects, cwd, transcriptPath }) {
  const byRoot = new Map();
  const mark = (project, via) => {
    if (!byRoot.has(project.root)) byRoot.set(project.root, { ...project, via: [] });
    const e = byRoot.get(project.root);
    if (!e.via.includes(via)) e.via.push(via);
  };

  for (const p of projects) {
    if (isUnder(cwd, p.root)) mark(p, "cwd");
  }

  const unmatched = projects.filter((p) => !byRoot.has(p.root));
  if (transcriptPath && unmatched.length > 0) {
    const hits = new Set(fileContainsAny(transcriptPath, unmatched.map((p) => p.root)));
    for (const p of unmatched) {
      if (hits.has(p.root)) mark(p, "transcript");
    }
  }

  return [...byRoot.values()];
}

// ---------- 发布锁 ----------

/**
 * 发布锁：同一个项目的 outbox 同一时刻只许一个发布者排空。
 *
 * 没有它就有真实的重复打扰：会话结束钩子、兜底定时器、一次性守望者可能同时看到
 * 同一批 pending —— listPending 和 markSent 之间有窗口，三方都会各发一条。
 *
 * 和 claim 一样用 mkdir 拿原子性；陈旧回收靠 pid 存活 + 墙钟上限，
 * 发布者崩在锁里不能把出站永久堵死。
 */
export function acquirePublishLock(lockDir, { staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const attempt = () => {
    try {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
      fs.mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }, null, 2) + "\n",
        { mode: 0o600 },
      );
      return { ok: true };
    } catch (err) {
      if (err.code === "EEXIST") return { ok: false, reason: "publisher_busy" };
      return { ok: false, reason: "io_error", error: err.message };
    }
  };

  const first = attempt();
  if (first.ok || first.reason !== "publisher_busy") return first;

  if (isPublishLockStale(lockDir, { staleMs, now })) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return attempt(); // 只重试一次：再失败说明有别人刚抢到，让它去发
  }
  return first;
}

export function isPublishLockStale(lockDir, { staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
  } catch {
    return true; // 锁在但 owner 不可读 —— 上次崩在两步之间
  }

  const at = Date.parse(owner.at ?? "");
  if (Number.isFinite(at) && now - at > staleMs) return true;

  if (Number.isFinite(owner.pid)) {
    try {
      process.kill(owner.pid, 0); // 只探活，不发真信号
      return false;
    } catch {
      return true;
    }
  }
  return true;
}

export function releasePublishLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}
