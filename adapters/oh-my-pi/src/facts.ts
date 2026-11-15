/**
 * Explicit unknown facts for the Oh My Pi adapter (DD-HOST-003, DD-HOST-020).
 *
 * OMP serializes no origin field on `input`, no `awaitingAsyncWork` field, no
 * queue field, and `agent_end.willContinue` is not serialized in every case.
 * `agent_settled` was not observed in 18.12.3. Those absences are reported as
 * `UnknownFact`, never as `false`, `0` or "no background work".
 */

import type { UnknownFact } from "./contract.js";

/** Stable reason codes used by this adapter. */
export const OMP_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "omp_input_origin_absent";
  readonly autoTurnNotSerialized: "omp_auto_turn_not_serialized";
  readonly agentEndWillContinueAbsent: "omp_agent_end_will_continue_absent";
  readonly retryStateNotSerialized: "omp_retry_state_not_serialized";
  readonly noBackgroundWorkField: "omp_no_background_work_field";
  readonly noQueueField: "omp_no_queue_field";
  readonly pendingNotNative: "omp_no_native_pending_field";
  readonly agentSettledNotObserved: "omp_agent_settled_not_observed";
  readonly handlerTimeoutNotBudget: "omp_handler_timeout_not_total_budget";
} = Object.freeze({
  inputOriginAbsent: "omp_input_origin_absent",
  autoTurnNotSerialized: "omp_auto_turn_not_serialized",
  agentEndWillContinueAbsent: "omp_agent_end_will_continue_absent",
  retryStateNotSerialized: "omp_retry_state_not_serialized",
  noBackgroundWorkField: "omp_no_background_work_field",
  noQueueField: "omp_no_queue_field",
  pendingNotNative: "omp_no_native_pending_field",
  agentSettledNotObserved: "omp_agent_settled_not_observed",
  handlerTimeoutNotBudget: "omp_handler_timeout_not_total_budget"
} as const);

export type OmpUnknownReason =
  | "omp_input_origin_absent"
  | "omp_auto_turn_not_serialized"
  | "omp_agent_end_will_continue_absent"
  | "omp_retry_state_not_serialized"
  | "omp_no_background_work_field"
  | "omp_no_queue_field"
  | "omp_no_native_pending_field"
  | "omp_agent_settled_not_observed"
  | "omp_handler_timeout_not_total_budget";

/** Builds the closed `UnknownFact` value. */
export function ompUnknown(reason_code: OmpUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
