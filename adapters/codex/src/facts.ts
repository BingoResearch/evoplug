/**
 * Explicit unknown facts for the Codex adapter (DD-HOST-003, DD-HOST-040).
 *
 * Codex does not serialize origin on `UserPromptSubmit`, background-work or
 * queue-depth fields on any observed hook payload, retry state on boundary
 * events, or the app-server durable `thread/inject_items` semantics. Those
 * absences are reported as `UnknownFact`, never as `false` or as an empty list.
 */

import type { UnknownFact } from "./contract.js";

/** Stable reason codes used by this adapter. */
export const CODEX_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "codex_input_origin_absent";
  readonly retryStateNotSerialized: "codex_retry_state_not_serialized";
  readonly noBackgroundWorkField: "codex_no_background_work_field";
  readonly noQueueField: "codex_no_queue_field";
  readonly pendingNotNative: "codex_no_native_pending_field";
  readonly appServerDurableUnknown: "codex_app_server_durable_unknown";
} = Object.freeze({
  inputOriginAbsent: "codex_input_origin_absent",
  retryStateNotSerialized: "codex_retry_state_not_serialized",
  noBackgroundWorkField: "codex_no_background_work_field",
  noQueueField: "codex_no_queue_field",
  pendingNotNative: "codex_no_native_pending_field",
  appServerDurableUnknown: "codex_app_server_durable_unknown"
} as const);

export type CodexUnknownReason =
  | "codex_input_origin_absent"
  | "codex_retry_state_not_serialized"
  | "codex_no_background_work_field"
  | "codex_no_queue_field"
  | "codex_no_native_pending_field"
  | "codex_app_server_durable_unknown";

/** Builds the closed `UnknownFact` value. */
export function codexUnknown(reason_code: CodexUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
