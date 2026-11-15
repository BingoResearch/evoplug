/**
 * Explicit unknown facts for the OpenHands SDK adapter (DD-HOST-003,
 * DD-HOST-060, DD-HOST-100).
 *
 * OpenHands 1.56.0 exposes six conversation hooks and no final request-body
 * hook, no compaction hook and no background-work field. `Stop` fires only for
 * `FINISHED`, so its absence proves nothing about pending work. The injected
 * `message_id` belongs to the unpersisted E0 event while the persisted event is
 * a new E1 id, so message association stays unknown. Each of those absences is
 * reported as `UnknownFact`, never as `false`, `0` or "no pending work".
 */

import type { UnknownFact } from "./contract.js";

/** Stable reason codes used by this adapter. */
export const OPENHANDS_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "openhands_input_origin_absent";
  readonly autoTurnNotSerialized: "openhands_auto_turn_not_serialized";
  readonly messageIdNotPreserved: "openhands_message_id_not_preserved";
  readonly associationJoinUnknown: "openhands_association_join_unknown";
  readonly retryStateNotSerialized: "openhands_retry_state_not_serialized";
  readonly noBackgroundWorkField: "openhands_no_background_work_field";
  readonly noQueueField: "openhands_no_queue_field";
  readonly stopOnlyFinished: "openhands_stop_only_finished";
  readonly noCompactionHook: "openhands_no_compaction_hook";
  readonly handlerTimeoutNotBudget: "openhands_handler_timeout_not_total_budget";
  readonly pendingNotNative: "openhands_no_native_pending_field";
  readonly finalBodyUnavailable: "openhands_final_body_unavailable";
  readonly blockWithContextUnverified: "openhands_block_with_context_unverified";
  readonly taskSubagentNotHook: "openhands_task_subagent_not_hook";
} = Object.freeze({
  inputOriginAbsent: "openhands_input_origin_absent",
  autoTurnNotSerialized: "openhands_auto_turn_not_serialized",
  messageIdNotPreserved: "openhands_message_id_not_preserved",
  associationJoinUnknown: "openhands_association_join_unknown",
  retryStateNotSerialized: "openhands_retry_state_not_serialized",
  noBackgroundWorkField: "openhands_no_background_work_field",
  noQueueField: "openhands_no_queue_field",
  stopOnlyFinished: "openhands_stop_only_finished",
  noCompactionHook: "openhands_no_compaction_hook",
  handlerTimeoutNotBudget: "openhands_handler_timeout_not_total_budget",
  pendingNotNative: "openhands_no_native_pending_field",
  finalBodyUnavailable: "openhands_final_body_unavailable",
  blockWithContextUnverified: "openhands_block_with_context_unverified",
  taskSubagentNotHook: "openhands_task_subagent_not_hook"
} as const);

export type OpenhandsUnknownReason =
  | "openhands_input_origin_absent"
  | "openhands_auto_turn_not_serialized"
  | "openhands_message_id_not_preserved"
  | "openhands_association_join_unknown"
  | "openhands_retry_state_not_serialized"
  | "openhands_no_background_work_field"
  | "openhands_no_queue_field"
  | "openhands_stop_only_finished"
  | "openhands_no_compaction_hook"
  | "openhands_handler_timeout_not_total_budget"
  | "openhands_no_native_pending_field"
  | "openhands_final_body_unavailable"
  | "openhands_block_with_context_unverified"
  | "openhands_task_subagent_not_hook";

/** Builds the closed `UnknownFact` value. */
export function openhandsUnknown(reason_code: OpenhandsUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
