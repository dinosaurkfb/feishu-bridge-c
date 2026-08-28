/**
 * 出站登记表、会话归属判定、发布锁。
 *
 * 出站原来只是本项目 CLAUDE.md 里手写的一段约定 —— 只有读到那段文字的会话才会记进展，
 * 换个目录、换个会话就失效。这个模块是把它变成机制的地基：登记表决定「哪些项目接了桥」，
 * 归属判定决定「这次会话给谁干了活」，发布锁保证「同一批进展只发一次」。
 *
 * 三件事都刻意做成确定性的纯文件操作，不调模型、不碰网络。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_REGISTRY = path.join(os.homedir(), ".claude", "feishu-bridge", "registry.json");

export function registryPath() {
  return process.env.FEISHU_BRIDGE_REGISTRY || DEFAULT_REGISTRY;
}

const stripTrailingSlash = (p) => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p);

/**
 * 项目 root 的规范形式。**只有这一份定义。**
 *
 * `/project/` 和 `/project` 是同一个项目，但字符串不等。两处各写一份归一化，
 * 就会出现"前置检查说没有、运行时说有"——那正是一次漏判：登记表里是带斜杠的那条，
 * 命令解析出来是不带的，两次都认为"没记录"，于是可能先建话题再新增一条逻辑重复记录。
 */
export const normalizeRoot = (root) => (typeof root === "string" && root.length > 0
  ? stripTrailingSlash(path.resolve(root)) : null);

/**
 * 登记表里**精确**是这个项目的条目。目录包含关系不算 ——
 * 父目录 /projects 不是 /projects/A。
 *
 * **注意它只回答"是不是这个项目"，不回答"能不能路由"。**
 * `enabled: false` 的条目仍会被返回 —— 因为"有一条停用的记录"和"一条都没有"
 * 是不同的状态，前者该说"停用了"，后者才该说"没登记"。
 * 要判断能不能出站，用 routableProjectsForRoot。
 */
export function exactProjectsForRoot(projects, root) {
  const want = normalizeRoot(root);
  if (want === null) return [];
  return (projects ?? []).filter((p) => normalizeRoot(p?.root) === want);
}

/**
 * 精确是这个项目、**而且出站真的会挑到它**的条目。
 *
 * 分开这两个概念，是因为它们不一致时后果最难查：`enabled: false` 的记录被
 * loadRegistry 过滤掉（Stop 挑不到它），而 bind 会把它算成"已经接入"、
 * status 会算成 routable —— **界面明确报正常，实际不会出站**。
 * 这跟登记表缺失那次是同一种病，只是换了个入口。
 */
export function routableProjectsForRoot(projects, root) {
  return exactProjectsForRoot(projects, root).filter((p) => p?.enabled !== false);
}

/**
 * 严格读登记表：**只有"文件不存在"算空表。**
 *
 * loadRegistry() 对钩子是对的 —— 绝大多数机器根本没接桥，读不到必须安静退出。
 * 但对**要据此做判断或写入**的调用方（bind / status）不行：它把 EACCES、EISDIR
 * 一律当成 no_registry，于是"读不出来"被当成了"没有"。
 * 前者会让 bind 拿空表去覆盖一份读不出来的真表；后者会让 status 把"没查清"
 * 报成"降级"。
 *
 * 抽到这里是因为 bind 和 status 各写一份就会再次分叉 —— 那是今天已经付过一次的代价。
 */
export function loadRegistryStrict(file = registryPath()) {
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); }
  catch (err) {
    if (err.code === "ENOENT") return { ok: true, file, projects: [], missing: true };
    return { ok: false, reason: "unreadable", file, error: err.code + ": " + err.message };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { ok: false, reason: "bad_json", file, error: err.message }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "bad_shape", file, error: "根节点不是对象" };
  }
  if (parsed.projects !== undefined && !Array.isArray(parsed.projects)) {
    return { ok: false, reason: "bad_shape", file, error: "projects 不是数组" };
  }
  return { ok: true, file, raw: parsed, projects: parsed.projects ?? [] };
}

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

  // **形状不对要跟坏 JSON 一样报出来，不能崩。**根节点是 null 时
  // `parsed.projects` 直接抛 —— 而这个函数是钩子在用的，**崩在钩子里等于
  // 整条出站无声消失**，比返回一个错误糟得多。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "bad_shape", file, error: "根节点不是对象", projects: [] };
  }
  if (parsed.projects !== undefined && !Array.isArray(parsed.projects)) {
    return { ok: false, reason: "bad_shape", file, error: "projects 不是数组", projects: [] };
  }

  const projects = [];
  for (const p of parsed.projects ?? []) {
    if (!p || typeof p.root !== "string" || p.root.length === 0) continue;
    if (p.enabled === false) continue;
    // **跟 normalizeRoot 用同一份规范化。**上一版这里只去尾斜杠，
    // 而 bind/status 走 path.resolve —— 登记成 /a/../project 时两边结论不同：
    // bind/status 说"已接入、可路由"，而 Stop 仍拿原路径匹配不到，
    // **又回到"状态显示正常、出站静默失效"**。
    const root = normalizeRoot(p.root);
    if (root === null) continue;
    // 整条带过去，不再只挑 id / root。绑定信息（root_message_id / expires_at / name）
    // 现在就住在这一行里 —— 见 project-resolve.mjs。id 和 root 仍然由这里归一化，
    // 免得每个调用方各自去处理「没写 id」和「结尾多个斜杠」。
    projects.push({ ...p, id: p.id ?? path.basename(root), root });
  }
  return { ok: true, file, projects };
}

export function isUnder(child, root) {
  // 两侧都过同一份规范化 —— 归属判断和 bind/status 的判断必须用同一个 root 契约。
  const c = normalizeRoot(child);
  const r = normalizeRoot(root);
  if (c === null || r === null) return false;
  return c === r || c.startsWith(r + "/");
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
 * 同一批 pending —— 读取与落标之间有窗口，三方都会各发一条。
 *
 * 协议（2026-08-28 重写，评审三轮探针逼出来的）：
 *   · 锁是一个 **symlink**，链接目标就是 owner（pid / at / token 的 JSON）。symlink 创建是一步原子操作，
 *     路径上有任何东西（哪怕空目录）都 EEXIST —— 没有"目录先出现、owner 后落地"的中间态，
 *     也没有 rename 能替换空目录的问题。
 *   · 每次获取带唯一 token；释放按 token 核对 —— pid 不能代表锁实例（我的锁被回收又被同 pid 的
 *     别的实例拿走时，按 pid 会误删）。
 *   · 陈旧回收**串行化**：先拿专用 reap 锁，在里面重读 owner、核对实例没变、仍然陈旧，再把锁
 *     rename 走（原子；两个回收者只有一个能成功），然后再正常取锁。原来"判陈旧 → rm → 重取"三步
 *     不互斥，两个回收者能同时成功。
 *   · 旧版 runtime（mkdir + owner.json 目录锁）与本协议**不能并行**：旧版看到 symlink 会当陈旧删掉。
 *     切换 runtime 时必须没有旧持有者（安装器切 current 之前兜底不在跑）。目录形状的旧锁这里
 *     仍能读、能按陈旧回收，只是不保证与旧进程互斥。
 */

// owner 不可读时按锁自身年龄给的宽限（真实时钟）：几秒内当活锁，超过才算残骸。
const OWNERLESS_LOCK_GRACE_MS = 10 * 1000;
// reap 锁只在回收那几毫秒里持有；超过这个年龄就是回收者崩在里面了。
const REAP_LOCK_STALE_MS = 60 * 1000;
// 本进程当前持有的锁实例：lockDir → token。释放时据此核对，调用点不用改签名。
const HELD = new Map();

function readLockOwner(lockDir) {
  let st;
  try { st = fs.lstatSync(lockDir); } catch { return { present: false, owner: null }; }
  if (st.isSymbolicLink()) {
    try { return { present: true, owner: JSON.parse(fs.readlinkSync(lockDir)), mtimeMs: st.mtimeMs }; }
    catch { return { present: true, owner: null, mtimeMs: st.mtimeMs }; }
  }
  // 旧版目录锁：owner.json 在目录里。
  try { return { present: true, owner: JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8")), mtimeMs: st.mtimeMs, legacy: true }; }
  catch { return { present: true, owner: null, mtimeMs: st.mtimeMs, legacy: true }; }
}

function ownerStale(owner, { staleMs, now }) {
  const at = Date.parse(owner?.at ?? "");
  if (Number.isFinite(at) && now - at > staleMs) return true;
  if (Number.isFinite(owner?.pid)) {
    try { process.kill(owner.pid, 0); return false; } // 只探活，不发真信号
    catch { return true; }
  }
  return true;
}

function tryLink(lockDir, payload) {
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(payload, lockDir);
    return { ok: true };
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, reason: "publisher_busy" };
    return { ok: false, reason: "io_error", error: err.message };
  }
}

export function acquirePublishLock(lockDir, { staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), token });
  const attempt = () => {
    const r = tryLink(lockDir, payload);
    if (r.ok) HELD.set(lockDir, token);
    return r.ok ? { ok: true, token } : r;
  };

  const first = attempt();
  if (first.ok || first.reason !== "publisher_busy") return first;

  const seen = readLockOwner(lockDir);
  if (!isPublishLockStale(lockDir, { staleMs, now })) return first;

  // 回收串行化：reap 锁 → 重读核对 → rename 走 → 放 reap 锁 → 再取。
  const reapDir = lockDir + ".reap";
  const reap = tryLink(reapDir, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
  if (!reap.ok) {
    if (reap.reason !== "publisher_busy") return reap;
    const r = readLockOwner(reapDir);
    if (!r.present || Date.now() - r.mtimeMs <= REAP_LOCK_STALE_MS) return first; // 别人正在回收，这轮让它
    try { fs.renameSync(reapDir, reapDir + ".dead-" + token); fs.rmSync(reapDir + ".dead-" + token, { recursive: true, force: true }); }
    catch { return first; }
    const again = tryLink(reapDir, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
    if (!again.ok) return first;
  }
  try {
    const current = readLockOwner(lockDir);
    if (!current.present) return attempt(); // 已经被别人收走了
    const sameInstance = JSON.stringify(current.owner) === JSON.stringify(seen.owner);
    if (!sameInstance || !isPublishLockStale(lockDir, { staleMs, now })) return first; // 实例变了：那是活锁
    const reaped = lockDir + ".reaped-" + token;
    try { fs.renameSync(lockDir, reaped); }
    catch { return first; } // 别人刚收走
    fs.rmSync(reaped, { recursive: true, force: true });
    return attempt(); // 只重试一次：再失败说明有别人刚抢到，让它去发
  } finally {
    fs.rmSync(reapDir, { recursive: true, force: true });
  }
}

export function isPublishLockStale(lockDir, { staleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const r = readLockOwner(lockDir);
  if (!r.present) return true; // 没锁：不算被占
  if (r.owner === null) return Date.now() - r.mtimeMs > OWNERLESS_LOCK_GRACE_MS; // 残骸还是刚建：看年龄（真实时钟）
  return ownerStale(r.owner, { staleMs, now });
}

/**
 * 释放前核对所有权：按 token —— 我的锁可能已被回收并被别人（甚至同 pid 的另一实例）拿走，
 * 那时删掉的是别人的活锁。旧版目录锁没有 token，退回按 pid 核对。
 */
export function releasePublishLock(lockDir) {
  const mine = HELD.get(lockDir) ?? null;
  const r = readLockOwner(lockDir);
  if (r.present && r.owner) {
    if (typeof r.owner.token === "string") {
      if (r.owner.token !== mine) return { ok: false, reason: "not_owner", pid: r.owner.pid };
    } else if (Number.isFinite(r.owner.pid) && r.owner.pid !== process.pid) {
      let alive = true;
      try { process.kill(r.owner.pid, 0); } catch { alive = false; }
      if (alive) return { ok: false, reason: "not_owner", pid: r.owner.pid };
    }
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
  HELD.delete(lockDir);
  return { ok: true };
}
