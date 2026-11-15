/**
 * Replay ledger event names, row schemas and DD-FND-097.2 row hashes.
 *
 * Every event carries a complete row snapshot: the hash preimage is exactly
 * `{row_schema, row_json}`, and insert events use `before_hash=null`. The
 * persistence layer owns the full column projection; this module never fills
 * a missing column.
 */

import { canonicalHash } from "@evoplug/core";
import type { Hash, JsonValue } from "@evoplug/core";

export const REPLAY_PLAN_RECORDED_EVENT: "replay.plan_recorded" = "replay.plan_recorded";
export const REPLAY_PLAN_TRANSITION_EVENT: "replay.plan_transition" =
  "replay.plan_transition";
export const REPLAY_APPROVAL_RECORDED_EVENT: "replay.approval_recorded" =
  "replay.approval_recorded";
export const REPLAY_APPROVAL_TRANSITION_EVENT: "replay.approval_transition" =
  "replay.approval_transition";
export const REPLAY_EXECUTION_RECORDED_EVENT: "replay.execution_recorded" =
  "replay.execution_recorded";
export const REPLAY_EXECUTION_TRANSITION_EVENT: "replay.execution_transition" =
  "replay.execution_transition";

export const REPLAY_PLAN_ROW_SCHEMA: "rsi.replay_plan_row/1" = "rsi.replay_plan_row/1";
export const REPLAY_APPROVAL_ROW_SCHEMA: "rsi.replay_approval_row/1" =
  "rsi.replay_approval_row/1";
export const REPLAY_EXECUTION_ROW_SCHEMA: "rsi.replay_execution_row/1" =
  "rsi.replay_execution_row/1";

export function computeReplayPlanRowHash(rowJson: JsonValue): Hash {
  return canonicalHash({ row_schema: REPLAY_PLAN_ROW_SCHEMA, row_json: rowJson });
}

export function computeReplayApprovalRowHash(rowJson: JsonValue): Hash {
  return canonicalHash({ row_schema: REPLAY_APPROVAL_ROW_SCHEMA, row_json: rowJson });
}

export function computeReplayExecutionRowHash(rowJson: JsonValue): Hash {
  return canonicalHash({ row_schema: REPLAY_EXECUTION_ROW_SCHEMA, row_json: rowJson });
}

/**
 * Fixed terminal frame order for a replay result:
 * `execution_transition` fsync → `plan_transition` fsync → one short SQLite
 * transaction CAS on both rows plus two `ledger_event_log` inserts.
 */
export const REPLAY_RESULT_FRAME_ORDER: readonly [
  "replay.execution_transition",
  "replay.plan_transition",
] = [REPLAY_EXECUTION_TRANSITION_EVENT, REPLAY_PLAN_TRANSITION_EVENT];

/**
 * Fixed consume frame order for `replay.execute`; no other order may be used
 * because a prefix may never contain an unconsumed approval with an execution.
 */
export const REPLAY_EXECUTE_FRAME_ORDER: readonly [
  "replay.approval_transition",
  "replay.execution_recorded",
  "replay.plan_transition",
] = [
  REPLAY_APPROVAL_TRANSITION_EVENT,
  REPLAY_EXECUTION_RECORDED_EVENT,
  REPLAY_PLAN_TRANSITION_EVENT,
];
