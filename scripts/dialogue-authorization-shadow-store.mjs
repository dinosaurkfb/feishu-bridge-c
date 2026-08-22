/**
 * Dialogue Slice B shadow sidecar。
 *
 * 只写 adapter 自己的 Git 外 shadow 目录，不取得 binding 生命周期锁；任何 I/O 失败都返回诊断，
 * 调用方必须继续执行现有 legacy 路由，不能让 shadow 结果改变真实回合。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  BINDING_AUTHORIZATION_REASON, compareDialogueBoundAuthorizationShadow,
  createDialogueBoundAuthorizationShadow, evaluateDialogueBoundAuthorization,
  materializeDialogueBindingAuthorization, validateDialogueBindingAuthorizationSnapshot,
  validateDialogueBoundAuthorizationShadow,
} from "./dialogue-binding-authorization.mjs";

export function dialogueAuthorizationShadowEnabled(env = process.env) {
  return env.FEISHU_DIALOGUE_AUTHORIZATION_SHADOW === "1";
}

const readJson = (file) => {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf-8")) }; }
  catch (err) {
    return err.code === "ENOENT"
      ? { ok: true, value: null }
      : { ok: false, reason: "shadow_read_failed", error: String(err.message).slice(0, 200) };
  }
};

const atomicWriteJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp." + process.pid + "." + Date.now() + "." +
    crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 已完成或写入前失败 */ }
  }
};

export function syncDialogueAuthorizationShadowSnapshot({
  shadowDir, authorizationInput, capturedAt = Date.now(),
} = {}) {
  if (typeof shadowDir !== "string" || !path.isAbsolute(shadowDir)) {
    return { ok: false, reason: "shadow_dir_invalid" };
  }
  const first = materializeDialogueBindingAuthorization({
    ...authorizationInput, capturedAt,
  });
  if (!first.ok) return first;
  const file = path.join(shadowDir, "authorizations", first.snapshot.binding_ref + ".json");
  const loaded = readJson(file);
  if (!loaded.ok) return loaded;
  if (loaded.value !== null && !validateDialogueBindingAuthorizationSnapshot(loaded.value).ok) {
    return { ok: false, reason: BINDING_AUTHORIZATION_REASON.INVALID_SNAPSHOT };
  }
  const materialized = materializeDialogueBindingAuthorization({
    ...authorizationInput, previousSnapshot: loaded.value, capturedAt,
  });
  if (!materialized.ok) return materialized;
  if (materialized.changed) {
    try { atomicWriteJson(file, materialized.snapshot); }
    catch (err) {
      return { ok: false, reason: "shadow_write_failed", error: String(err.message).slice(0, 200) };
    }
  }
  return { ok: true, changed: materialized.changed, snapshot: materialized.snapshot, file };
}

export function recordDialogueBoundAuthorizationShadow({
  shadowDir, authorizationInput, canonicalEvent, runtimeNamespace, expectedBindingRef,
  legacy, now = Date.now(),
} = {}) {
  try {
    const synced = syncDialogueAuthorizationShadowSnapshot({
      shadowDir, authorizationInput, capturedAt: now,
    });
    if (!synced.ok) return synced;
    const candidate = evaluateDialogueBoundAuthorization({
      snapshot: synced.snapshot, canonicalEvent, runtimeNamespace, expectedBindingRef, now,
    });
    const comparison = compareDialogueBoundAuthorizationShadow({ legacy, candidate });
    const composed = createDialogueBoundAuthorizationShadow({
      snapshot: synced.snapshot, canonicalEvent, comparison, recordedAt: now,
    });
    if (!composed.ok) return composed;
    const file = path.join(shadowDir, "events", composed.evidence.shadow_id + ".json");
    const existing = readJson(file);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return validateDialogueBoundAuthorizationShadow(existing.value).ok
        ? { ok: true, changed: false, duplicate: true, snapshot: synced.snapshot,
          candidate, comparison, evidence: existing.value, file }
        : { ok: false, reason: "shadow_evidence_invalid" };
    }
    atomicWriteJson(file, composed.evidence);
    return { ok: true, changed: true, duplicate: false, snapshot: synced.snapshot,
      candidate, comparison, evidence: composed.evidence, file };
  } catch (err) {
    return { ok: false, reason: "shadow_unavailable", error: String(err.message).slice(0, 200) };
  }
}
