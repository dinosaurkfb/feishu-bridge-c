/**
 * Dialogue Slice B2：Aily channel locator 的脱敏一致性探针。
 *
 * 这个模块不把 AILY_CLI_CHANNEL_* 提升为可信事实，也不改变 canonical event。
 * 它只把“字段是否存在、chat locator 是否与当前 binding 授权快照一致”记录成布尔证据，
 * 供真实样本验证 Aily runtime 契约。原始 chat/thread locator 永不进入返回 artifact。
 */

import crypto from "node:crypto";

import { validateCanonicalEvent } from "./canonical-event.mjs";
import {
  deriveDialogueChatScopeRef, validateDialogueBindingAuthorizationSnapshot,
} from "./dialogue-binding-authorization.mjs";

export const CHAT_SCOPE_PROBE_SCHEMA_VERSION = "1.0";
export const CHAT_SCOPE_PROBE_ARTIFACT_TYPE = "feishu_bridge_dialogue_chat_scope_probe";
export const CHAT_SCOPE_PROBE_VERSION = "1.0";

const PROBE_ID_PATTERN = /^chat_scope_probe_[0-9a-f]{24}$/u;
const EVENT_REF_PATTERN = /^event_ref_[0-9a-f]{24}$/u;
const BINDING_REF_PATTERN = /^binding_ref_[0-9a-f]{24}$/u;
const SNAPSHOT_ID_PATTERN = /^binding_authorization_[0-9a-f]{24}$/u;
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const onlyKeys = (value, allowed) => value && typeof value === "object" &&
  Object.keys(value).every((key) => allowed.includes(key));
const digestRef = (prefix, parts) => prefix + crypto.createHash("sha256")
  .update(parts.join("\0"))
  .digest("hex")
  .slice(0, 24);
const iso = (value) => new Date(value).toISOString();

const probeContent = (probe) => ({
  canonical_verified: probe.canonical_verified,
  chat_locator_present: probe.chat_locator_present,
  chat_scope_match: probe.chat_scope_match,
  thread_locator_present: probe.thread_locator_present,
});

export function validateDialogueChatScopeProbe(probe) {
  if (!onlyKeys(probe, ["schema_version", "artifact_type", "probe_version", "probe_id",
    "observed_at", "event_ref", "binding_ref", "authorization_snapshot_id",
    "canonical_verified", "chat_locator_present", "chat_scope_match",
    "thread_locator_present"]) ||
      probe?.schema_version !== CHAT_SCOPE_PROBE_SCHEMA_VERSION ||
      probe?.artifact_type !== CHAT_SCOPE_PROBE_ARTIFACT_TYPE ||
      probe?.probe_version !== CHAT_SCOPE_PROBE_VERSION ||
      !PROBE_ID_PATTERN.test(probe?.probe_id ?? "") ||
      !Number.isFinite(Date.parse(probe?.observed_at ?? "")) ||
      !EVENT_REF_PATTERN.test(probe?.event_ref ?? "") ||
      !BINDING_REF_PATTERN.test(probe?.binding_ref ?? "") ||
      !SNAPSHOT_ID_PATTERN.test(probe?.authorization_snapshot_id ?? "") ||
      typeof probe?.canonical_verified !== "boolean" ||
      typeof probe?.chat_locator_present !== "boolean" ||
      typeof probe?.thread_locator_present !== "boolean" ||
      ![true, false, null].includes(probe?.chat_scope_match) ||
      (probe.chat_locator_present ? typeof probe.chat_scope_match !== "boolean" :
        probe.chat_scope_match !== null)) {
    return { ok: false, reason: "chat_scope_probe_invalid" };
  }
  const expected = digestRef("chat_scope_probe_", [
    "dialogue-chat-scope-probe/v1", probe.probe_version,
    probe.authorization_snapshot_id, probe.event_ref, JSON.stringify(probeContent(probe)),
  ]);
  return expected === probe.probe_id
    ? { ok: true }
    : { ok: false, reason: "chat_scope_probe_invalid" };
}

export function createDialogueChatScopeProbe({
  snapshot, canonicalEvent, observedAt = Date.now(),
} = {}) {
  if (!validateDialogueBindingAuthorizationSnapshot(snapshot).ok ||
      !validateCanonicalEvent(canonicalEvent).ok) {
    return { ok: false, reason: "chat_scope_probe_input_invalid" };
  }
  const observed = typeof observedAt === "number" ? iso(observedAt) : observedAt;
  if (!Number.isFinite(Date.parse(observed ?? ""))) {
    return { ok: false, reason: "chat_scope_probe_input_invalid" };
  }
  const chatId = canonicalEvent.extensions.aily_channel.chat_id;
  const chatLocatorPresent = nonEmpty(chatId);
  const derived = chatLocatorPresent
    ? deriveDialogueChatScopeRef({ endpointId: snapshot.endpoint_id, privateChatId: chatId })
    : null;
  if (chatLocatorPresent && !derived?.ok) {
    return { ok: false, reason: "chat_scope_probe_input_invalid" };
  }
  const eventRef = digestRef("event_ref_", [
    "dialogue-authorization-event-ref/v1", snapshot.endpoint_id, canonicalEvent.event_id,
  ]);
  const probe = {
    schema_version: CHAT_SCOPE_PROBE_SCHEMA_VERSION,
    artifact_type: CHAT_SCOPE_PROBE_ARTIFACT_TYPE,
    probe_version: CHAT_SCOPE_PROBE_VERSION,
    probe_id: "",
    observed_at: observed,
    event_ref: eventRef,
    binding_ref: snapshot.binding_ref,
    authorization_snapshot_id: snapshot.snapshot_id,
    canonical_verified: canonicalEvent.extensions.aily_channel.verified === true,
    chat_locator_present: chatLocatorPresent,
    chat_scope_match: chatLocatorPresent
      ? derived.chatScopeRef === snapshot.chat_scope_ref
      : null,
    thread_locator_present: nonEmpty(canonicalEvent.extensions.aily_channel.thread_id),
  };
  probe.probe_id = digestRef("chat_scope_probe_", [
    "dialogue-chat-scope-probe/v1", probe.probe_version,
    probe.authorization_snapshot_id, probe.event_ref, JSON.stringify(probeContent(probe)),
  ]);
  return validateDialogueChatScopeProbe(probe).ok
    ? { ok: true, probe }
    : { ok: false, reason: "chat_scope_probe_invalid" };
}
