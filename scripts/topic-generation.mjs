/**
 * Topic Generation v1：同一逻辑 binding 下的话题代际与轮转状态机。
 *
 * 本模块只处理纯数据，不读写 registry、不调用飞书，也不认识 Claude/Codex locator。
 * 两个 runtime adapter 负责在自己的 Git 外状态文件中加锁、重读、调用这里的迁移函数，
 * 再以同目录临时文件 + rename 一次性替换整份 binding 文档。
 */

import path from "node:path";
import { stableControlId } from "./subscription.mjs";

/**
 * 这个值能不能当作代际 id 用 —— **全仓唯一的判据，住在"代际"这个概念的家里。**
 *
 * outbox 写入端、抑制核心的三态判定、两侧包装层的 expectation 检查都走它。
 * 它散在各处的时候出过一次事：核心的 expectation 检查收紧成 trim() 之后，
 * dependsOnMapping 还留在 length > 0 上，于是 `"   "` 被当成"自带明确代际"，
 * 绕过全部守卫被永久抑制。**同一个概念一处分清、另一处混回去。**
 */
export const usableGeneration = (v) => typeof v === "string" && v.trim() !== "";

/**
 * 一个 mapping 的**有效绑定身份** —— 全仓唯一投影，住在 mapping 归属层。
 * 旧 project-file 映射没有 mapping.binding_id，投影时用 `<basename>@project-files`
 * 并写进 topic_generation_state.binding_id；有状态就以状态为准。claim 写入、
 * 期望 env、watcher 复核、Dialogue 存储（含锁内重读原始记录）、控制面都从这里取 ——
 * 各自直接读可缺省的旧字段，就会有一处把合法旧映射算成空 binding（评审探针）。
 */
export function effectiveBindingId(mapping, { root = null } = {}) {
  const fromState = mapping?.topic_generation_state?.binding_id;
  if (usableGeneration(fromState)) return fromState;
  if (usableGeneration(mapping?.binding_id)) return mapping.binding_id;
  return root ? path.basename(root) + "@project-files" : null;
}

export const TOPIC_GENERATION_SCHEMA_VERSION = "1.0";
export const TOPIC_GENERATION_ARTIFACT_TYPE = "feishu_bridge_topic_generations";
// 待认领窗口：2026-08-28 起从 24 小时放长到 72 小时（Frank 定的，三倍）。已登记的 pending 沿用各自记下的
// claim_expires_at，新代际按这个默认取。
export const TOPIC_GENERATION_PENDING_MS = 72 * 60 * 60 * 1000;
// 快过期提醒的提前量：截止前 12 小时内、且还没人认领时，在待认领话题下提醒一次（明写，不藏在比较式里）。
export const TOPIC_GENERATION_CLAIM_REMINDER_LEAD_MS = 12 * 60 * 60 * 1000;
export const TOPIC_GENERATION_ACTIVITY_SCHEMA_VERSION = "1.0";
export const TOPIC_GENERATION_ACTIVITY_MODE = "business_message_v1";
// 自动轮转阈值：2026-08-28 起从 30 条放长到 50 条（Frank 定的）。已有代际沿用各自记下的 auto_rotate_threshold。
export const TOPIC_GENERATION_AUTO_ROTATE_MESSAGES = 50;
export const TOPIC_GENERATION_AUTO_ROTATE_RETRY_MS = 5 * 60 * 1000;
/**
 * PREPARING 停留多久算「上一次尝试没走完」，可以被新的轮转接管。
 * 取得比自动轮转重试间隔长，免得接管与重试互相抢同一个窗口。
 */
export const TOPIC_GENERATION_PREPARING_STALE_MS = 15 * 60 * 1000;

export const GENERATION_STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  READ_ONLY: "read-only",
  RETIRED: "retired",
});

export const ROTATION_STATUS = Object.freeze({
  PREPARING: "preparing",
  AWAITING_CLAIM: "awaiting_claim",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
});

const nonEmpty = (value) => typeof value === "string" && value.length > 0;

/**
 * 这份 rotation 是否仍在占位、挡住新的轮转。
 *
 * **两个调用点必须共用它**：prepareTopicRotation 的拒绝判据，和
 * recordTopicGenerationActivity 里 shouldAutoRotate 的 rotationOpen。
 * 各写各的话会分叉 —— 实测过一次：手工路径加了 PREPARING 超时，自动路径没加，
 * 于是"手工能恢复、自动仍永久卡死"，比两边都卡还难查。
 */
const rotationBlocking = (state, now) => {
  const status = state?.rotation?.status;
  if (status === ROTATION_STATUS.AWAITING_CLAIM) return true;
  if (status !== ROTATION_STATUS.PREPARING) return false;
  const preparedAt = Date.parse(state.rotation.prepared_at ?? "");
  // 时间戳读不出来时按"仍在占位"处理：宁可挡住，也不要凭一个坏字段就允许重建话题。
  if (!Number.isFinite(preparedAt)) return true;
  return now - preparedAt < TOPIC_GENERATION_PREPARING_STALE_MS;
};
const iso = (now) => new Date(now).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

const newGenerationActivity = ({ now = Date.now(), threshold = TOPIC_GENERATION_AUTO_ROTATE_MESSAGES } = {}) => ({
  schema_version: TOPIC_GENERATION_ACTIVITY_SCHEMA_VERSION,
  count_mode: TOPIC_GENERATION_ACTIVITY_MODE,
  auto_rotate_enabled: true,
  auto_rotate_threshold: threshold,
  message_count: 0,
  counted_event_keys: [],
  started_at: iso(now),
  threshold_reached_at: null,
  last_auto_rotation_attempt_at: null,
  auto_rotation_attempts: 0,
});

const generationActivity = (generation, { now = Date.now() } = {}) => {
  const activity = generation?.activity;
  if (!activity || activity.schema_version !== TOPIC_GENERATION_ACTIVITY_SCHEMA_VERSION) {
    return newGenerationActivity({ now });
  }
  return {
    ...newGenerationActivity({ now, threshold: activity.auto_rotate_threshold }),
    ...clone(activity),
    counted_event_keys: Array.isArray(activity.counted_event_keys)
      ? [...activity.counted_event_keys]
      : [],
  };
};

export function channelGenerationId(bindingId, generation) {
  return stableControlId("channel_generation", bindingId, generation);
}

/**
 * 把尚未拥有 Topic Generation 文档的旧 binding 投影成 generation 1。
 *
 * 已绑定旧通道沿用 Mapping Policy 之前使用的 opaque id，保证升级前已受理 run 冻结的
 * origin_channel_generation_id 仍能解析到原话题；首次轮转后新代际使用正式的 binding+序号 id。
 */
export function projectLegacyTopicGeneration({
  runtime,
  bindingId,
  bindingStatus = "active",
  rootMessageId,
  sessionId,
  inboundState,
  pendingToken,
  pendingExpiresAt,
  createdAt,
  legacyChannelGenerationId,
  now = Date.now(),
} = {}) {
  if (!nonEmpty(bindingId) || !nonEmpty(rootMessageId)) {
    return { ok: false, reason: "legacy_topic_projection_incomplete" };
  }
  // 早期 project-file mapping 没有 inbound_state，但一直允许出站；迁移不能把它误判成
  // “等待首次绑定”。新登记明确写 pending，因此只有缺字段的旧格式走 active 兼容分支。
  const normalizedBindingStatus = bindingStatus === "suspended" ? "paused" : bindingStatus;
  const bound = inboundState === "bound" ||
    (inboundState === undefined && !nonEmpty(pendingToken)) ||
    (nonEmpty(sessionId) && inboundState !== GENERATION_STATUS.PENDING);
  const generationId = nonEmpty(legacyChannelGenerationId)
    ? legacyChannelGenerationId
    : bound && nonEmpty(runtime)
      ? stableControlId("channel_generation", runtime, bindingId, sessionId)
      : channelGenerationId(bindingId, 1);
  const created = nonEmpty(createdAt) ? createdAt : iso(now);
  const generation = {
    channel_generation_id: generationId,
    generation: 1,
    status: bound ? GENERATION_STATUS.ACTIVE : GENERATION_STATUS.PENDING,
    root_message_id: rootMessageId,
    session_id: bound ? (sessionId ?? null) : null,
    pending_token: bound ? null : (pendingToken ?? null),
    claim_expires_at: bound ? null : (pendingExpiresAt ?? null),
    created_at: created,
    activated_at: bound ? (createdAt ?? created) : null,
    read_only_at: null,
    retired_at: null,
    activity: newGenerationActivity({ now }),
  };
  return {
    ok: true,
    state: {
      schema_version: TOPIC_GENERATION_SCHEMA_VERSION,
      artifact_type: TOPIC_GENERATION_ARTIFACT_TYPE,
      binding_id: bindingId,
      binding_status: normalizedBindingStatus,
      active_generation_id: bound ? generationId : null,
      generations: [generation],
      rotation: null,
      updated_at: created,
    },
  };
}

export function validateTopicGenerationState(state) {
  const problems = [];
  if (state?.schema_version !== TOPIC_GENERATION_SCHEMA_VERSION) problems.push("schema_version");
  if (state?.artifact_type !== TOPIC_GENERATION_ARTIFACT_TYPE) problems.push("artifact_type");
  if (!nonEmpty(state?.binding_id)) problems.push("binding_id");
  if (!["active", "paused", "retired"].includes(state?.binding_status)) problems.push("binding_status");
  if (!Array.isArray(state?.generations) || state.generations.length === 0) {
    problems.push("generations");
    return { ok: false, problems };
  }

  const ids = new Set();
  const numbers = new Set();
  let active = 0;
  let pending = 0;
  let pendingRecord = null;
  for (const generation of state.generations) {
    if (!nonEmpty(generation?.channel_generation_id) || ids.has(generation?.channel_generation_id)) {
      problems.push("generations.channel_generation_id");
    } else ids.add(generation.channel_generation_id);
    if (!Number.isInteger(generation?.generation) || generation.generation <= 0 ||
        numbers.has(generation?.generation)) {
      problems.push("generations.generation");
    } else numbers.add(generation.generation);
    if (!Object.values(GENERATION_STATUS).includes(generation?.status)) {
      problems.push("generations.status");
    }
    if (!nonEmpty(generation?.root_message_id)) problems.push("generations.root_message_id");
    if (generation?.activity !== undefined) {
      const activity = generation.activity;
      if (activity?.schema_version !== TOPIC_GENERATION_ACTIVITY_SCHEMA_VERSION ||
          activity?.count_mode !== TOPIC_GENERATION_ACTIVITY_MODE ||
          typeof activity?.auto_rotate_enabled !== "boolean" ||
          !Number.isInteger(activity?.auto_rotate_threshold) || activity.auto_rotate_threshold <= 0 ||
          !Number.isInteger(activity?.message_count) || activity.message_count < 0 ||
          !Array.isArray(activity?.counted_event_keys) ||
          activity.counted_event_keys.some((key) => !nonEmpty(key)) ||
          !Number.isInteger(activity?.auto_rotation_attempts) || activity.auto_rotation_attempts < 0) {
        problems.push("generations.activity");
      }
    }
    if (generation?.status === GENERATION_STATUS.ACTIVE) {
      active += 1;
      // 早期 Claude 项目绑定允许“出站已接通、入站尚无 Aily session”的 active 记录。
      // session 唯一性在真正认领时强校验；读取迁移不能因此关掉既有出站。
      if (generation.pending_token !== null || generation.claim_expires_at !== null) {
        problems.push("generations.active_shape");
      }
    }
    if (generation?.status === GENERATION_STATUS.PENDING) {
      pending += 1;
      pendingRecord = generation;
      // 旧版“全机唯一 pending”记录可能没有短码或显式截止时间；读取迁移必须保留它，
      // 期限由 bound_at 兼容推导。正式 rotation pending 在下面有更严格的形状约束。
      if (generation.session_id !== null) problems.push("generations.pending_shape");
      // 提醒记录：不在场 / null 都行；在场就必须是规范时间 —— 它决定"还要不要再提醒"。
      if (generation.claim_reminder_at !== undefined && generation.claim_reminder_at !== null &&
          !Number.isFinite(Date.parse(generation.claim_reminder_at))) {
        problems.push("generations.claim_reminder_at");
      }
    }
  }
  if (active > 1) problems.push("multiple_active_generations");
  if (pending > 1) problems.push("multiple_pending_generations");
  if (state.active_generation_id === null) {
    if (active !== 0) problems.push("active_generation_id_missing");
  } else {
    const selected = state.generations.find((g) =>
      g.channel_generation_id === state.active_generation_id);
    if (!selected || selected.status !== GENERATION_STATUS.ACTIVE || active !== 1) {
      problems.push("active_generation_id");
    }
  }
  if (state.rotation !== null && typeof state.rotation !== "object") problems.push("rotation");
  if (state.rotation && (!nonEmpty(state.rotation.operation_id) ||
      !Object.values(ROTATION_STATUS).includes(state.rotation.status))) {
    problems.push("rotation");
  }
  if (state.rotation?.status === ROTATION_STATUS.PREPARING && pending !== 0) {
    problems.push("rotation_preparing_with_pending");
  }
  if (state.rotation?.status === ROTATION_STATUS.AWAITING_CLAIM &&
      (pending !== 1 || state.rotation.pending_generation_id !== pendingRecord?.channel_generation_id)) {
    problems.push("rotation_pending_generation");
  }
  if (state.rotation?.status === ROTATION_STATUS.AWAITING_CLAIM &&
      (!nonEmpty(pendingRecord?.pending_token) ||
       !Number.isFinite(Date.parse(pendingRecord?.claim_expires_at ?? "")))) {
    problems.push("rotation_pending_shape");
  }
  if (pending === 1 && active === 1 && state.rotation?.status !== ROTATION_STATUS.AWAITING_CLAIM) {
    problems.push("pending_rotation_missing");
  }
  if ([ROTATION_STATUS.COMPLETED, ROTATION_STATUS.FAILED, ROTATION_STATUS.CANCELLED,
    ROTATION_STATUS.EXPIRED].includes(state.rotation?.status) && pending !== 0) {
    problems.push("closed_rotation_with_pending");
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

export function topicGenerationStateForLegacy(record, {
  runtime,
  bindingId,
  now = Date.now(),
} = {}) {
  if (record?.topic_generation_state) {
    const state = clone(record.topic_generation_state);
    const valid = validateTopicGenerationState(state);
    return valid.ok ? { ok: true, state, projection: "stored_v1" }
      : { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  }
  const projected = projectLegacyTopicGeneration({
    runtime,
    bindingId,
    bindingStatus: record?.status ?? "active",
    rootMessageId: record?.root_message_id ?? record?.feishu_root_message_id_reference,
    sessionId: record?.session_id,
    inboundState: record?.inbound_state,
    pendingToken: record?.pending_token,
    pendingExpiresAt: record?.pending_expires_at,
    createdAt: record?.bound_at ?? record?.created_at,
    legacyChannelGenerationId: record?.channel_generation_id,
    now,
  });
  return projected.ok ? { ...projected, projection: "legacy_v1" } : projected;
}

export const activeGeneration = (state) => state?.generations?.find((generation) =>
  generation.channel_generation_id === state.active_generation_id &&
  generation.status === GENERATION_STATUS.ACTIVE) ?? null;

export const pendingGeneration = (state) => state?.generations?.find((generation) =>
  generation.status === GENERATION_STATUS.PENDING) ?? null;

/**
 * 快过期提醒该不该发：有 pending、有截止时间、进入截止前 LEAD 窗口、还没过期、还没提醒过。
 * **只算不写**；何时提醒、提醒后记下来，由各链的扫描器在自己的锁里做。
 */
export function claimReminderDue(state, { now = Date.now(), leadMs = TOPIC_GENERATION_CLAIM_REMINDER_LEAD_MS } = {}) {
  const generation = pendingGeneration(state);
  if (!generation) return { due: false, reason: "no_pending", generation: null };
  const deadline = Date.parse(generation.claim_expires_at ?? "");
  if (!Number.isFinite(deadline)) return { due: false, reason: "no_deadline", generation };
  if (now >= deadline) return { due: false, reason: "expired", generation };
  if (generation.claim_reminder_at) return { due: false, reason: "already_reminded", generation };
  if (deadline - now > leadMs) return { due: false, reason: "not_yet", generation, remainingMs: deadline - now };
  return { due: true, reason: null, generation, remainingMs: deadline - now };
}

/** 记下"已经提醒过"。同一代际只记一次；不是 pending 的代际不记（说明状态已经变了）。 */
export function markPendingClaimReminder(state, { generationId, now = Date.now() } = {}) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  const generation = pendingGeneration(state);
  if (!generation || generation.channel_generation_id !== generationId) {
    return { ok: false, reason: "pending_generation_mismatch" };
  }
  if (generation.claim_reminder_at) return { ok: true, changed: false, state };
  const next = clone(state);
  const target = next.generations.find((g) => g.channel_generation_id === generationId);
  target.claim_reminder_at = iso(now);
  next.updated_at = iso(now);
  return { ok: true, changed: true, state: next };
}

export function generationById(state, generationId) {
  if (!nonEmpty(generationId)) return null;
  return state?.generations?.find((generation) =>
    generation.channel_generation_id === generationId) ?? null;
}

export function activeGenerationForSession(state, sessionId) {
  if (!nonEmpty(sessionId) || state?.binding_status !== "active") return null;
  const generation = activeGeneration(state);
  return generation?.session_id === sessionId ? generation : null;
}

/**
 * 记录一条已经通过业务闸门、或已经成功发布到飞书的有效消息。
 *
 * eventKey 会先哈希成 opaque key 再落 Git 外状态；重复 hook、publisher 重试或相同消息的二次观察
 * 不会重复计数。只有 active generation 计数，read-only 的迟到结果不会再触发另一轮轮转。
 * 达到阈值只取得一次“可以尝试自动轮转”的本地权利；真正创建话题由 runtime adapter 在锁外完成。
 */
export function recordTopicGenerationActivity(state, {
  generationId,
  eventKey,
  messageDelta = 1,
  now = Date.now(),
  retryMs = TOPIC_GENERATION_AUTO_ROTATE_RETRY_MS,
} = {}) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  if (!nonEmpty(eventKey)) return { ok: false, reason: "activity_event_key_required" };
  if (!Number.isInteger(messageDelta) || messageDelta <= 0 || messageDelta > 2) {
    return { ok: false, reason: "activity_message_delta_invalid" };
  }
  const selectedId = nonEmpty(generationId) ? generationId : state.active_generation_id;
  const current = generationById(state, selectedId);
  if (!current || current.status !== GENERATION_STATUS.ACTIVE ||
      current.channel_generation_id !== state.active_generation_id) {
    return { ok: true, changed: false, counted: false, reason: "generation_not_active", state: clone(state) };
  }

  const next = clone(state);
  const generation = generationById(next, selectedId);
  const activity = generationActivity(generation, { now });
  const opaqueKey = stableControlId(
    "generation_activity", next.binding_id, generation.channel_generation_id, eventKey,
  );
  if (activity.counted_event_keys.includes(opaqueKey)) {
    generation.activity = activity;
    return {
      ok: true, changed: false, counted: false, reason: "activity_duplicate", state: next,
      generation, messageCount: activity.message_count, threshold: activity.auto_rotate_threshold,
      shouldAutoRotate: false,
    };
  }

  activity.counted_event_keys.push(opaqueKey);
  activity.message_count += messageDelta;
  if (activity.message_count >= activity.auto_rotate_threshold && !activity.threshold_reached_at) {
    activity.threshold_reached_at = iso(now);
  }

  const rotationOpen = rotationBlocking(next, now);
  const lastAttempt = Date.parse(activity.last_auto_rotation_attempt_at ?? "");
  const retryReady = !Number.isFinite(lastAttempt) || now - lastAttempt >= retryMs;
  const shouldAutoRotate = next.binding_status === "active" &&
    activity.auto_rotate_enabled === true &&
    activity.message_count >= activity.auto_rotate_threshold &&
    !pendingGeneration(next) && !rotationOpen && retryReady;
  if (shouldAutoRotate) {
    activity.last_auto_rotation_attempt_at = iso(now);
    activity.auto_rotation_attempts += 1;
  }
  generation.activity = activity;
  next.updated_at = iso(now);
  return {
    ok: true, changed: true, counted: true, state: next, generation,
    messageCount: activity.message_count,
    threshold: activity.auto_rotate_threshold,
    shouldAutoRotate,
    // **这次决策的权威身份。**每决定一次轮转它就 +1，冷却后的新决策是新的号。
    // 授权凭证按它做幂等：同一次决策重复签得到同一张票，新决策换号拿新票 ——
    // 否则首次消费完之后的重试会撞上墓碑，自动轮转再也起不来（评审实测到的）。
    autoRotationAttempt: activity.auto_rotation_attempts,
  };
}

export function prepareTopicRotation(state, {
  operationId,
  now = Date.now(),
} = {}) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  if (state.binding_status !== "active") return { ok: false, reason: "binding_not_active" };
  if (!activeGeneration(state)) return { ok: false, reason: "no_active_generation" };
  if (pendingGeneration(state)) return { ok: false, reason: "rotation_already_pending" };
  if (rotationBlocking(state, now)) return { ok: false, reason: "rotation_already_pending" };
  if (!nonEmpty(operationId)) return { ok: false, reason: "rotation_operation_id_required" };
  const next = clone(state);
  next.rotation = {
    operation_id: operationId,
    status: ROTATION_STATUS.PREPARING,
    prepared_at: iso(now),
    pending_generation_id: null,
  };
  next.updated_at = iso(now);
  return { ok: true, state: next, operation: next.rotation };
}

export function registerPendingTopicGeneration(state, {
  operationId,
  rootMessageId,
  pendingToken,
  claimExpiresAt,
  now = Date.now(),
} = {}) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  if (!nonEmpty(operationId) || state.rotation?.operation_id !== operationId ||
      state.rotation?.status !== ROTATION_STATUS.PREPARING) {
    return { ok: false, reason: "rotation_operation_mismatch" };
  }
  if (!nonEmpty(rootMessageId) || !nonEmpty(pendingToken)) {
    return { ok: false, reason: "pending_generation_incomplete" };
  }
  if (claimExpiresAt !== undefined && !Number.isFinite(Date.parse(claimExpiresAt))) {
    return { ok: false, reason: "pending_generation_expiry_invalid" };
  }
  if (pendingGeneration(state)) return { ok: false, reason: "rotation_already_pending" };
  const next = clone(state);
  const generationNumber = Math.max(...next.generations.map((generation) => generation.generation)) + 1;
  const generationId = channelGenerationId(next.binding_id, generationNumber);
  const expires = claimExpiresAt ?? iso(now + TOPIC_GENERATION_PENDING_MS);
  const generation = {
    channel_generation_id: generationId,
    generation: generationNumber,
    status: GENERATION_STATUS.PENDING,
    root_message_id: rootMessageId,
    session_id: null,
    pending_token: pendingToken,
    claim_expires_at: expires,
    created_at: iso(now),
    activated_at: null,
    read_only_at: null,
    retired_at: null,
    activity: newGenerationActivity({ now }),
  };
  next.generations.push(generation);
  next.rotation = {
    ...next.rotation,
    status: ROTATION_STATUS.AWAITING_CLAIM,
    pending_generation_id: generationId,
    topic_registered_at: iso(now),
  };
  next.updated_at = iso(now);
  return { ok: true, state: next, generation };
}

export function activatePendingTopicGeneration(state, {
  generationId,
  sessionId,
  operationId,
  now = Date.now(),
} = {}) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  const pending = pendingGeneration(state);
  if (!pending) return { ok: false, reason: "no_pending_generation" };
  if (nonEmpty(generationId) && pending.channel_generation_id !== generationId) {
    return { ok: false, reason: "pending_generation_mismatch" };
  }
  if (state.rotation && nonEmpty(operationId) && state.rotation.operation_id !== operationId) {
    return { ok: false, reason: "rotation_operation_mismatch" };
  }
  const expiry = Date.parse(pending.claim_expires_at ?? "");
  if (Number.isFinite(expiry) && now >= expiry) return { ok: false, reason: "pending_generation_expired" };
  if (!nonEmpty(sessionId)) return { ok: false, reason: "session_id_required" };

  const next = clone(state);
  const previous = activeGeneration(next);
  if (previous) {
    previous.status = GENERATION_STATUS.READ_ONLY;
    previous.read_only_at = iso(now);
  }
  const selected = generationById(next, pending.channel_generation_id);
  selected.status = GENERATION_STATUS.ACTIVE;
  selected.session_id = sessionId;
  selected.pending_token = null;
  selected.claim_expires_at = null;
  selected.activated_at = iso(now);
  selected.activity = generationActivity(selected, { now });
  next.active_generation_id = selected.channel_generation_id;
  if (next.rotation) {
    next.rotation = {
      ...next.rotation,
      status: ROTATION_STATUS.COMPLETED,
      completed_at: iso(now),
    };
  }
  next.updated_at = iso(now);
  return {
    ok: true,
    state: next,
    active: selected,
    previous: previous ?? null,
  };
}

export function closePendingTopicGeneration(state, {
  operationId,
  reason = ROTATION_STATUS.CANCELLED,
  now = Date.now(),
} = {}) {
  const allowed = new Set([ROTATION_STATUS.CANCELLED, ROTATION_STATUS.EXPIRED]);
  if (!allowed.has(reason)) return { ok: false, reason: "invalid_rotation_close_reason" };
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  const pending = pendingGeneration(state);
  if (!pending) return { ok: false, reason: "no_pending_generation" };
  if (nonEmpty(operationId) && state.rotation?.operation_id !== operationId) {
    return { ok: false, reason: "rotation_operation_mismatch" };
  }
  if (reason === ROTATION_STATUS.EXPIRED) {
    const expiry = Date.parse(pending.claim_expires_at ?? "");
    if (!Number.isFinite(expiry) || now < expiry) return { ok: false, reason: "pending_generation_not_expired" };
  }
  const next = clone(state);
  const selected = generationById(next, pending.channel_generation_id);
  selected.status = GENERATION_STATUS.RETIRED;
  selected.retired_at = iso(now);
  selected.retired_reason = reason;
  next.rotation = {
    ...(next.rotation ?? {}),
    status: reason,
    closed_at: iso(now),
  };
  next.updated_at = iso(now);
  return { ok: true, state: next, generation: selected };
}

export function failTopicRotation(state, {
  operationId,
  reason = "topic_creation_failed",
  now = Date.now(),
} = {}) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  if (!state.rotation || state.rotation.operation_id !== operationId ||
      state.rotation.status !== ROTATION_STATUS.PREPARING) {
    return { ok: false, reason: "rotation_operation_mismatch" };
  }
  const next = clone(state);
  next.rotation = {
    ...next.rotation,
    status: ROTATION_STATUS.FAILED,
    failure_reason: String(reason).slice(0, 200),
    failed_at: iso(now),
  };
  next.updated_at = iso(now);
  return { ok: true, state: next };
}

/** 把正式状态投影回旧字段；迁移期间旧读取方继续只看到唯一 active generation。 */
export function materializeLegacyTopicFields(record, state) {
  const valid = validateTopicGenerationState(state);
  if (!valid.ok) return { ok: false, reason: "topic_generation_state_invalid", problems: valid.problems };
  const active = activeGeneration(state);
  const pending = pendingGeneration(state);
  const selected = active ?? pending;
  if (!selected) return { ok: false, reason: "no_routable_generation" };
  const next = {
    ...record,
    status: state.binding_status,
    root_message_id: selected.root_message_id,
    session_id: active?.session_id ?? null,
    inbound_state: active ? "bound" : "pending",
    pending_token: active ? null : (pending?.pending_token ?? null),
    pending_expires_at: active ? null : (pending?.claim_expires_at ?? null),
    channel_generation_id: active?.channel_generation_id ?? pending?.channel_generation_id,
    topic_generation_state: clone(state),
  };
  return { ok: true, record: next };
}

/**
 * 给运行时 mapping 附上正式代际读模型。只在内存中投影，不写回旧文件。
 * 首次迁移前仍保持原 root/session 行为；一旦状态持久化，读取方自动跟随 active generation。
 */
export function applyTopicGenerationToMapping(mapping, {
  runtime,
  bindingId = mapping?.binding_id,
  now = Date.now(),
} = {}) {
  const loaded = topicGenerationStateForLegacy(mapping, { runtime, bindingId, now });
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  const active = activeGeneration(state);
  const pending = pendingGeneration(state);
  const selected = active ?? pending;
  if (!selected) return { ok: false, reason: "no_routable_generation" };
  return {
    ok: true,
    projection: loaded.projection,
    state,
    mapping: {
      ...mapping,
      status: state.binding_status,
      session_id: active?.session_id ?? null,
      inbound_state: active ? "bound" : "pending",
      pending_token: active ? null : (pending?.pending_token ?? null),
      pending_expires_at: active ? null : (pending?.claim_expires_at ?? null),
      channel_generation_id: active?.channel_generation_id ?? pending?.channel_generation_id,
      feishu_root_message_id_reference: selected.root_message_id,
      topic_generation_state: state,
    },
  };
}

/** read-only 代际仍可接收轮转前已经冻结到它的迟到结果；retired 则 fail-closed。 */
export function resolveOutboundGeneration(state, generationId) {
  const generation = generationById(state, generationId);
  const initialPending = generation?.status === GENERATION_STATUS.PENDING &&
    state?.active_generation_id === null && state?.generations?.length === 1;
  if (!generation || (!initialPending && ![GENERATION_STATUS.ACTIVE, GENERATION_STATUS.READ_ONLY]
    .includes(generation.status))) {
    return { ok: false, reason: "outbound_generation_unavailable" };
  }
  return {
    ok: true,
    channelGenerationId: generation.channel_generation_id,
    rootMessageId: generation.root_message_id,
    status: generation.status,
  };
}

export function resolveMappingOutboundGeneration(mapping, generationId) {
  const state = mapping?.topic_generation_state;
  const selected = generationId ?? mapping?.channel_generation_id;
  if (state) return resolveOutboundGeneration(state, selected);
  if (nonEmpty(mapping?.feishu_root_message_id_reference) &&
      (!nonEmpty(generationId) || generationId === mapping?.channel_generation_id)) {
    return {
      ok: true,
      channelGenerationId: selected ?? null,
      rootMessageId: mapping.feishu_root_message_id_reference,
      status: "active",
    };
  }
  return { ok: false, reason: "outbound_generation_unavailable" };
}

/**
 * 一条待发记录的目标代际处于哪一态。**三态，不是两态。**
 *
 * - `legacy`  ：字段缺失或 null —— 合法的旧格式，代际靠当前 mapping 现算。
 * - `frozen`  ：可用的非空代际 —— 目标已冻结，轮转不影响它。
 * - `corrupt` ：字段在，但不是可用代际 —— **损坏记录**。fail-closed。
 *
 * **它住在这里而不是抑制核心**：审计要用它，抑制核心也要用它。
 * 放在 usableGeneration 隔壁，两边从同一处拿 —— 评审实测过上一版的后果：
 * 完整记录只要把目标代际写成纯空白，auditOutbox 仍报干净、blocker 返回 null，
 * **查看器之所以拦住是因为它自己又查了一次 —— "唯一守卫"实际上是两份判据。**
 */
export function generationTargetState(record) {
  const raw = record?.target_channel_generation_id;
  if (raw === undefined || raw === null) return "legacy";
  return usableGeneration(raw) ? "frozen" : "corrupt";
}
