/**
 * Explicit unknown facts for the Pi adapter (DD-HOST-003, DD-HOST-010).
 *
 * Pi exposes no origin field on `input`, no background-work field, no queue
 * field and no serialized retry state. Those absences are reported as
 * `UnknownFact`, never as `false` or as an empty list.
 */

import type { UnknownFact } from "./contract.js";

/** Stable reason codes used by this adapter. */
export const PI_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "pi_input_origin_absent";
  readonly agentEndWillRetryAbsent: "pi_agent_end_will_retry_absent";
  readonly retryStateNotSerialized: "pi_retry_state_not_serialized";
  readonly noBackgroundWorkField: "pi_no_background_work_field";
  readonly noQueueField: "pi_no_queue_field";
  readonly pendingNotNative: "pi_no_native_pending_field";
} = Object.freeze({
  inputOriginAbsent: "pi_input_origin_absent",
  agentEndWillRetryAbsent: "pi_agent_end_will_retry_absent",
  retryStateNotSerialized: "pi_retry_state_not_serialized",
  noBackgroundWorkField: "pi_no_background_work_field",
  noQueueField: "pi_no_queue_field",
  pendingNotNative: "pi_no_native_pending_field"
} as const);

export type PiUnknownReason =
  | "pi_input_origin_absent"
  | "pi_agent_end_will_retry_absent"
  | "pi_retry_state_not_serialized"
  | "pi_no_background_work_field"
  | "pi_no_queue_field"
  | "pi_no_native_pending_field";

/** Builds the closed `UnknownFact` value. */
export function piUnknown(reason_code: PiUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
