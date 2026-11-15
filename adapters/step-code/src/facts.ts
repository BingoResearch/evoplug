/**
 * Explicit unknown facts for the Step Code adapter (DD-HOST-003, DD-HOST-030,
 * DD-HOST-100).
 *
 * The Step Code host section records no origin field on `input`, no background
 * work field, no queue field, no serialized retry state and no native pending
 * state. The one contract-derived exception is `agent_settled`: its payload is
 * still fieldless, while its emitter contract proves the main agent loop has
 * drained retry, compaction recovery and queued continuation. That derivation
 * is documented in `normalize.ts` and covers the main loop only. The stdio
 * surface additionally does not consume `UserPromptSubmit.additionalContext`
 * and does not drive a continuation from a `Stop` block. Each absence is
 * reported as an `UnknownFact` or as an explicit boundary constant, never as
 * `false`, an empty list or a fabricated success.
 */

import type { UnknownFact } from "./contract.js";

/** Stable reason codes used by this adapter. */
export const STEP_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "step_input_origin_absent";
  readonly agentEndWillRetryAbsent: "step_agent_end_will_retry_absent";
  readonly retryStateNotSerialized: "step_retry_state_not_serialized";
  readonly noBackgroundWorkField: "step_no_background_work_field";
  readonly noQueueField: "step_no_queue_field";
  readonly pendingNotNative: "step_no_native_pending_field";
  readonly stdioAdditionalContextNotConsumed: "step_stdio_additional_context_not_consumed";
  readonly stdioStopNotContinuation: "step_stdio_stop_not_continuation";
  readonly stdioCapabilitiesUnverified: "step_stdio_capabilities_unverified";
} = Object.freeze({
  inputOriginAbsent: "step_input_origin_absent",
  agentEndWillRetryAbsent: "step_agent_end_will_retry_absent",
  retryStateNotSerialized: "step_retry_state_not_serialized",
  noBackgroundWorkField: "step_no_background_work_field",
  noQueueField: "step_no_queue_field",
  pendingNotNative: "step_no_native_pending_field",
  stdioAdditionalContextNotConsumed: "step_stdio_additional_context_not_consumed",
  stdioStopNotContinuation: "step_stdio_stop_not_continuation",
  stdioCapabilitiesUnverified: "step_stdio_capabilities_unverified"
} as const);

export type StepUnknownReason =
  | "step_input_origin_absent"
  | "step_agent_end_will_retry_absent"
  | "step_retry_state_not_serialized"
  | "step_no_background_work_field"
  | "step_no_queue_field"
  | "step_no_native_pending_field"
  | "step_stdio_additional_context_not_consumed"
  | "step_stdio_stop_not_continuation"
  | "step_stdio_capabilities_unverified";

/** Builds the closed `UnknownFact` value. */
export function stepUnknown(reason_code: StepUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
