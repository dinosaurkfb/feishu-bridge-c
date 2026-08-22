#!/usr/bin/env node
/** 离线 Dialogue Relay planner simulator：只读 fixture，stdout 输出结果，无网络/控制面副作用。 */

import fs from "node:fs";
import path from "node:path";

import {
  RELAY_STEP_STATUS, advanceRelayPlan, cancelRelayPlan, createRelayPlanState, startRelayCycle,
  deriveDialogueOutputRef, validateParticipantAuthorizationSnapshot,
} from "./dialogue-participant-planner.mjs";

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const inputFile = arg("--input");
if (!inputFile) {
  console.error("用法：node scripts/simulate-dialogue-planner.mjs --input <fixture.json>");
  process.exit(2);
}

let fixture;
try {
  fixture = JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf-8"));
} catch {
  console.error("无法读取 planner fixture。");
  process.exit(2);
}

const snapshotValid = validateParticipantAuthorizationSnapshot(fixture.snapshot);
const created = snapshotValid.ok ? createRelayPlanState({
  dialogueId: fixture.dialogue_id,
  snapshot: fixture.snapshot,
  budget: fixture.budget,
  startedAt: fixture.started_at,
}) : snapshotValid;
if (!created.ok) {
  console.error(JSON.stringify(created));
  process.exit(2);
}

let state = created.state;
const results = [];
for (const event of fixture.events ?? []) {
  let result;
  if (event.type === "human") {
    result = startRelayCycle(state, {
      snapshot: fixture.snapshot,
      humanEventId: event.event_id,
      parentHumanClaimId: event.claim_id,
      originChannelGenerationId: event.origin_channel_generation_id,
      now: event.now,
    });
  } else if (event.type === "terminal") {
    const active = state.active_cycle?.steps?.[state.active_cycle.active_step_index - 1];
    const outputRef = event.derive_output_ref === true ? deriveDialogueOutputRef({
      dialogueId: state.dialogue_id,
      runId: event.run_id === "$active" || !event.run_id ? active?.run_id : event.run_id,
      terminalEventId: event.terminal_event_id,
    }).outputRef : event.output_ref;
    result = advanceRelayPlan(state, {
      snapshot: fixture.snapshot,
      runId: event.run_id === "$active" || !event.run_id ? active?.run_id : event.run_id,
      terminalEventId: event.terminal_event_id,
      status: event.status ?? RELAY_STEP_STATUS.COMPLETED,
      outputRef,
      reason: event.reason,
      now: event.now,
    });
  } else if (event.type === "cancel") {
    result = cancelRelayPlan(state, {
      snapshot: fixture.snapshot, reason: event.reason, now: event.now,
    });
  } else {
    result = { ok: false, reason: "unsupported_simulator_event" };
  }
  results.push(result);
  if (!result.ok) break;
  state = result.state;
}

process.stdout.write(JSON.stringify({ ok: results.every((result) => result.ok), results, state }, null, 2) + "\n");
