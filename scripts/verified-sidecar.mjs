/**
 * 受验 sidecar 读写 —— **真叶子**（只 import node 内置 + canon 摘要，不反向依赖任何上层）。
 *
 * 这套机制原先只住在 selection-plan.mjs（R57b 返修五/六/九/十）。R58 返修二 P1-1 要求
 * 转发失败回执（outbox.mjs 的 `<key>.forward-failed.outbox.json`）复用**同一套**受验读取
 * 与受验恢复，不另造第二份。所以机制搬到这里，参数化「文件名规则 / 大小上限 / 封闭校验器 /
 * key 形状 / 人话标签」；调用方（selection-plan.mjs、outbox.mjs）只剩一层薄适配，
 * 并在各自注释里指回本模块。**没有第二份实现**：改了这里，两边一起变。
 *
 * 纪律（与 R57b 返修九/十逐字一致）：
 *   ① 盘点封闭：tmp 名严格 `<前缀><正整数 pid>.<v4 uuid>`；非此形状不算候选（既不点名也不删）。
 *   ② 受验读：O_RDONLY|O_NOFOLLOW|O_NONBLOCK 打开 → 同 fd fstat 核 普通文件 / 单硬链接 /
 *      0600 / 大小上限（可带盘点快照做 open 后 inode 绑定复核）→ 读满 → JSON → 封闭校验。
 *   ③ 受验恢复：只在持锁入口显式调用。充要条件 = 唯一候选 && final 存在 && 同 dev+ino &&
 *      final nlink===2 && 候选自身 nlink===2 && open 后 inode 复核 && 候选内容过封闭校验
 *      → unlink → fsync 目录。其余（无候选/多候选/异常/异形/异 inode/final 缺席）一律
 *      fail-closed 报 residue，**不动任何文件**。
 *   ④ 纯读取不删任何文件：遇任何精确候选 → residue fail-closed，交持锁入口恢复。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sha256 } from "./maintenance/canon.mjs";

const errCode = (err) => String(err?.code ?? err?.message ?? err);

/** 封闭 tmp 尾巴（不含前缀）：<正整数 pid>.<v4 uuid>。uuid 严格按 crypto.randomUUID() 形状。 */
export const SIDECAR_TMP_TAIL_RE = /^([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

const statSame = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;

/** 本次写临时文件的规范名（封闭形状，调用方与恢复器共用这一份）。 */
export const sidecarTmpName = (key, fileName) => "." + fileName + ".tmp." + process.pid + "." + crypto.randomUUID();

/**
 * 造一套受验 sidecar 原语（读 / 盘点 / 恢复 / 低层受验读）。
 *
 * @param {object} cfg
 * @param {string} cfg.label           人话标签（进 problem 文案）
 * @param {(key:string)=>string} cfg.fileNameOf   key → 文件名
 * @param {number} cfg.maxBytes         大小上限
 * @param {(value:any,key:string)=>string|null} cfg.problemOf  封闭校验器
 * @param {RegExp} cfg.keyShape         key 形状
 * @param {string} cfg.dirMissingReason 目录缺失时的 reason 名（各调用方自己的词）
 * @param {string|null} cfg.problemReason 读回遇封闭校验不过时的 reason 名（null = 不给 reason）
 * @param {string} [cfg.keyProblem]    key 形状不符的文案（默认「key 形状不对」）
 */
export function createVerifiedSidecar({ label, fileNameOf, maxBytes, problemOf, keyShape, dirMissingReason, problemReason = null, keyProblem = "key 形状不对" }) {
  const filePath = (dir, key) => path.join(dir, fileNameOf(key));
  const tmpPrefixOf = (key) => "." + fileNameOf(key) + ".tmp.";
  const tmpPathFor = (dir, key) => path.join(dir, sidecarTmpName(key, fileNameOf(key)));

  const validateKey = (key) => (typeof key === "string" && keyShape.test(key) ? null : keyProblem);
  const isTmpName = (key, name) => {
    if (typeof name !== "string") return false;
    const prefix = tmpPrefixOf(key);
    if (!name.startsWith(prefix)) return false;
    return SIDECAR_TMP_TAIL_RE.test(name.slice(prefix.length));
  };

  /** 低层读原始字节（不走单硬链接守卫）：O_NOFOLLOW|O_NONBLOCK、普通文件、0600、大小上限。
   *  传 expectedStat 时做「open 后 inode 绑定复核」：open+fstat 的 dev/ino 必须与盘点快照一致。 */
  function readBytesNoNlink(file, expectedStat) {
    let fd = null;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (err) {
      if (err?.code === "ENOENT") return { ok: true, absent: true };
      return { ok: false, kind: "unreadable", problem: "open 失败: " + errCode(err) };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, kind: "unreadable", problem: "不是普通文件" };
      if ((st.mode & 0o777) !== 0o600) return { ok: false, kind: "unreadable", problem: "mode 不是 0600: " + (st.mode & 0o777).toString(8) };
      if (st.size > maxBytes) return { ok: false, kind: "unreadable", problem: "超过大小上限（" + st.size + " > " + maxBytes + "）" };
      if (expectedStat && !statSame(st, expectedStat)) return { ok: false, kind: "unreadable", problem: "open 后 inode 与盘点快照不一致（可能被替换）" };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) return { ok: false, kind: "unreadable", problem: "读不满文件（" + off + "/" + st.size + "）" };
        off += n;
      }
      return { ok: true, buf, st };
    } catch (err) {
      return { ok: false, kind: "unreadable", problem: errCode(err) };
    } finally {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  }

  /**
   * 盘点：目录里名字严格匹配精确 tmp 形状的候选。盘点期间不 unlink。
   * readdir / lstat 的非 ENOENT 异常、异形（非普通文件 / 非 0600）→ 整体非绿。
   * @param {object} _inject 可选：{ readdir } 钩子在测试注入 readdir EIO。
   */
  function scanTmpCandidates({ dir, key, _inject }) {
    let names;
    try {
      names = typeof _inject?.readdir === "function" ? _inject.readdir() : fs.readdirSync(dir);
    } catch (err) {
      // 只有 ENOENT 折缺席（目录还不存在 = 无候选）；非 ENOENT（如注入的 EIO）→ residue fail-closed。
      if (err?.code === "ENOENT") return { ok: true, entries: [] };
      return { ok: false, residue: [], why: "readdir 失败: " + errCode(err) };
    }
    const entries = [];
    for (const name of names) {
      if (!isTmpName(key, name)) continue;
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        return { ok: false, residue: entries.map((e) => e.path).concat([p]), why: "lstat tmp 失败: " + errCode(err) };
      }
      if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
        return { ok: false, residue: entries.map((e) => e.path).concat([p]), why: "tmp 形状异常（非普通文件或非 0600）：" + path.basename(p) };
      }
      entries.push({ name, path: p, st });
    }
    return { ok: true, entries };
  }

  /**
   * 受验恢复：只在持锁入口显式调用。见模块头 ③。
   * 返回 { ok:true, recovered:path|null, residue:null } / { ok:false, reason, residue:[...], why }。
   */
  function recoverTmp({ dir, key, _inject = null } = {}) {
    if (typeof dir !== "string" || dir.length === 0) return { ok: false, reason: dirMissingReason, why: "目录缺失" };
    const kv = validateKey(key);
    if (kv !== null) return { ok: false, reason: "key_shape", why: kv };
    const scan = scanTmpCandidates({ dir, key, _inject });
    if (!scan.ok) return { ok: false, reason: "residue", residue: scan.residue, why: scan.why };
    if (scan.entries.length === 0) return { ok: true, recovered: null, residue: null };
    if (scan.entries.length > 1) return { ok: false, reason: "residue", residue: scan.entries.map((e) => e.path), why: "多于一个精确 tmp 候选（规则 1：不自动清）" };
    const cand = scan.entries[0];
    const final = filePath(dir, key);
    let finalSt;
    try { finalSt = fs.lstatSync(final); } catch (err) {
      if (err?.code === "ENOENT") return { ok: false, reason: "residue", residue: [cand.path], why: "final 缺席但精确候选在场（规则 3，非「无窗口」）" };
      return { ok: false, reason: "residue", residue: [cand.path], why: "lstat final 失败: " + errCode(err) };
    }
    if (finalSt.nlink !== 2) return { ok: false, reason: "residue", residue: [cand.path], why: "final nlink 不是 2（当前 " + finalSt.nlink + "，非「link 后未 unlink」态）" };
    if (!statSame(cand.st, finalSt)) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 与 final 不同 dev+ino（异 inode）" };
    if (cand.st.nlink !== 2) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp nlink 不是 2（当前 " + cand.st.nlink + "）" };
    // open 后 inode 绑定复核（规则 2）：防 open 后文件被替换的 TOCTOU。
    const rb = readBytesNoNlink(cand.path, cand.st);
    if (!rb.ok) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 受验读回失败: " + rb.problem };
    let value = null;
    try { value = JSON.parse(rb.buf.toString("utf-8")); } catch { return { ok: false, reason: "residue", residue: [cand.path], why: "tmp JSON 解析失败" }; }
    if (problemOf(value, key) !== null) return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 不是合法 " + label };
    try {
      fs.unlinkSync(cand.path);
    } catch (err) {
      return { ok: false, reason: "residue", residue: [cand.path], why: "unlink tmp 失败: " + errCode(err) };
    }
    try {
      let dfd = null;
      try { dfd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dfd); }
      finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* 已关 */ } } }
    } catch (err) {
      return { ok: false, reason: "residue", residue: [cand.path], why: "tmp 已清但目录 fsync 失败: " + errCode(err) };
    }
    return { ok: true, recovered: cand.path, residue: null };
  }

  /**
   * 受验读回：fd 绑定、O_NOFOLLOW|O_NONBLOCK、普通文件、单硬链接、0600、大小上限、JSON 封闭校验。
   * 返回 { ok:true, value, sha256, bytes } / { ok:true, absent:true } / { ok:false, problem, reason?, residue? }。
   * 规则 ④：**不删任何文件**；遇任何精确 tmp 候选 → residue fail-closed。
   */
  function read({ dir, key, _inject = null }) {
    if (typeof dir !== "string" || dir.length === 0) return { ok: false, kind: "unreadable", problem: "目录缺失" };
    const kv = validateKey(key);
    if (kv !== null) return { ok: false, kind: "unreadable", problem: kv };
    const scan = scanTmpCandidates({ dir, key, _inject });
    // 盘点本身失败（readdir EIO / ENOTDIR / lstat 异常）与「盘出了残骸」是两回事：前者是读不了
    //（kind:unreadable），后者才是 kind:residue。判据在结构上分，不靠文案正则。
    // reason 仍保留 "residue"：那是 selection-plan 既有的对外契约（R57b 返修九的断言逐字卡着它）。
    if (!scan.ok) return { ok: false, kind: "unreadable", reason: "residue", problem: scan.why, residue: scan.residue };
    if (scan.entries.length > 0) {
      return { ok: false, kind: "residue", reason: "residue", problem: label + " tmp 残骸待人工（受验读不自动清）", residue: scan.entries.map((e) => e.path) };
    }
    const file = filePath(dir, key);
    let fd = null;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (err) {
      if (err?.code === "ENOENT") return { ok: true, absent: true };
      return { ok: false, kind: "unreadable", problem: "open 失败: " + errCode(err) };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, kind: "unreadable", problem: "不是普通文件" };
      if (st.nlink !== 1) return { ok: false, kind: "unreadable", problem: "硬链接数不为 1" };
      if ((st.mode & 0o777) !== 0o600) return { ok: false, kind: "unreadable", problem: "mode 不是 0600: " + (st.mode & 0o777).toString(8) };
      if (st.size > maxBytes) return { ok: false, kind: "unreadable", problem: "超过大小上限（" + st.size + " > " + maxBytes + "）" };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) return { ok: false, kind: "unreadable", problem: "读不满文件（" + off + "/" + st.size + "）" };
        off += n;
      }
      let value = null;
      try { value = JSON.parse(buf.toString("utf-8")); } catch (err) { return { ok: false, kind: "invalid", problem: "JSON 解析失败: " + errCode(err) }; }
      const p = problemOf(value, key);
      if (p !== null) {
        // reason 保留（selection-plan 的 selection_plan_key_mismatch 是既有对外契约），kind 是新加的通用分档。
        return problemReason === null ? { ok: false, kind: "invalid", problem: p } : { ok: false, kind: "invalid", problem: p, reason: problemReason };
      }
      return { ok: true, value, sha256: sha256(buf), bytes: buf.length };
    } catch (err) {
      return { ok: false, kind: "unreadable", problem: errCode(err) };
    } finally {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  }

  return { label, fileNameOf, maxBytes, filePath, tmpPrefixOf, tmpPathFor, validateKey, isTmpName, readBytesNoNlink, scanTmpCandidates, recoverTmp, read };
}
