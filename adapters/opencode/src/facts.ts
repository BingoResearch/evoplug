/**
 * Explicit unknown facts for the OpenCode adapter (DD-HOST-003, DD-HOST-050).
 *
 * OpenCode exposes no origin field on `session.prompt`, no hook timeout or host
 * total budget, and no queue-depth field. `session.idle` is ephemeral and is
 * lost when the SSE stream disconnects; it never proves that pending work is
 * absent. Every absence is reported as `UnknownFact`, never as `false` or as an
 * empty list.
 */

import type { UnknownFact } from "./contract.js";

/** Stable reason codes used by this adapter. */
export const OPENCODE_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "opencode_input_origin_absent";
  readonly noBackgroundWorkField: "opencode_no_background_work_field";
  readonly noQueueField: "opencode_no_queue_field";
  readonly retryStateNotSerialized: "opencode_retry_state_not_serialized";
  readonly pendingInboxNotExposed: "opencode_pending_inbox_not_exposed";
  readonly idleEphemeral: "opencode_idle_is_ephemeral";
  readonly compactionReasonOnlyInEvent: "opencode_compaction_reason_only_in_event";
} = Object.freeze({
  inputOriginAbsent: "opencode_input_origin_absent",
  noBackgroundWorkField: "opencode_no_background_work_field",
  noQueueField: "opencode_no_queue_field",
  retryStateNotSerialized: "opencode_retry_state_not_serialized",
  pendingInboxNotExposed: "opencode_pending_inbox_not_exposed",
  idleEphemeral: "opencode_idle_is_ephemeral",
  compactionReasonOnlyInEvent: "opencode_compaction_reason_only_in_event"
} as const);

export type OpenCodeUnknownReason =
  | "opencode_input_origin_absent"
  | "opencode_no_background_work_field"
  | "opencode_no_queue_field"
  | "opencode_retry_state_not_serialized"
  | "opencode_pending_inbox_not_exposed"
  | "opencode_idle_is_ephemeral"
  | "opencode_compaction_reason_only_in_event";

/** Builds the closed `UnknownFact` value. */
export function openCodeUnknown(reason_code: OpenCodeUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
