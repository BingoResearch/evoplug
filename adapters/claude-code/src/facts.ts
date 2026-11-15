/**
 * Explicit unknown facts for the Claude Code adapter (DD-HOST-003,
 * DD-HOST-070, DD-HOST-100).
 *
 * Claude Code does not serialize an input origin on `UserPromptSubmit`, does
 * not expose queue depth or the consumption point of queued input, does not
 * serialize retry state for boundary events, does not expose the final raw API
 * body, and does not provide a load readback for the hook graph. Those
 * absences are reported as `UnknownFact`, never as `false`, an empty list or a
 * successful result.
 */

import type { UnknownFact } from "./contract.js";

export type ClaudeUnknownReason =
  | "claude_input_origin_absent"
  | "claude_auto_turn_not_applicable"
  | "claude_retry_state_not_serialized"
  | "claude_background_semantics_unverified"
  | "claude_queue_depth_not_serialized"
  | "claude_pending_semantics_unverified"
  | "claude_load_readback_unavailable"
  | "claude_compaction_summary_not_rewriteable"
  | "claude_delivery_inclusion_unverified"
  | "claude_no_raw_api_body"
  | "claude_strict_unsupported";

/** Stable reason codes used by this adapter. */
export const CLAUDE_UNKNOWN_REASON: {
  readonly inputOriginAbsent: "claude_input_origin_absent";
  readonly autoTurnNotApplicable: "claude_auto_turn_not_applicable";
  readonly retryStateNotSerialized: "claude_retry_state_not_serialized";
  readonly backgroundSemanticsUnverified: "claude_background_semantics_unverified";
  readonly queueDepthNotSerialized: "claude_queue_depth_not_serialized";
  readonly pendingSemanticsUnverified: "claude_pending_semantics_unverified";
  readonly loadReadbackUnavailable: "claude_load_readback_unavailable";
  readonly compactionSummaryNotRewriteable: "claude_compaction_summary_not_rewriteable";
  readonly deliveryInclusionUnverified: "claude_delivery_inclusion_unverified";
  readonly noRawApiBody: "claude_no_raw_api_body";
  readonly strictUnsupported: "claude_strict_unsupported";
} = Object.freeze({
  inputOriginAbsent: "claude_input_origin_absent",
  autoTurnNotApplicable: "claude_auto_turn_not_applicable",
  retryStateNotSerialized: "claude_retry_state_not_serialized",
  backgroundSemanticsUnverified: "claude_background_semantics_unverified",
  queueDepthNotSerialized: "claude_queue_depth_not_serialized",
  pendingSemanticsUnverified: "claude_pending_semantics_unverified",
  loadReadbackUnavailable: "claude_load_readback_unavailable",
  compactionSummaryNotRewriteable: "claude_compaction_summary_not_rewriteable",
  deliveryInclusionUnverified: "claude_delivery_inclusion_unverified",
  noRawApiBody: "claude_no_raw_api_body",
  strictUnsupported: "claude_strict_unsupported"
} as const);

/** Builds the closed `UnknownFact` value. */
export function claudeUnknown(reason_code: ClaudeUnknownReason): UnknownFact {
  return { kind: "unknown", reason_code };
}
