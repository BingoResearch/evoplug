import type { ErrorEnvelope, Id, Result } from "@evoplug/core";
import type { FeedbackDraft, FeedbackKind, FeedbackRecord, LedgerFeedbackRow } from "../domain/feedback.js";
import type { FeedbackStateRow } from "../rows.js";
import type { Origin } from "../domain/common.js";
import { ledgerOk, schemaError } from "../errors.js";
import { isSourceRef } from "../source-ref.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "../util.js";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  "correction",
  "dissatisfaction",
  "new_goal",
  "acceptance",
];

export const FEEDBACK_STATUSES: readonly FeedbackRecord["status"][] = [
  "recorded",
  "needs_evidence",
];

export interface FeedbackBuildContext {
  readonly feedback_id: Id<"fb">;
  /** Origin of the committed source event, never caller-supplied. */
  readonly origin: Origin;
  readonly recorded_at: number;
  /** `event_log.watermark` of the source event. */
  readonly source_event_watermark: number;
}

export interface FeedbackPlan {
  readonly record: FeedbackRecord;
  readonly row: FeedbackStateRow;
  readonly ledger_row: LedgerFeedbackRow;
}

/**
 * Feedback keeps only the source and quote evidence; it never creates a
 * RequirementOp. `new_goal` is a candidate that must go through a proposed
 * requirement and a human confirmation.
 */
export function buildFeedbackRecord(
  draft: FeedbackDraft,
  context: FeedbackBuildContext,
): Result<FeedbackPlan, ErrorEnvelope> {
  if (draft.schema_version !== "rsi.feedback_draft/1") {
    return schemaError<FeedbackPlan>("schema_version", "rsi.feedback_draft/1");
  }
  if (!FEEDBACK_KINDS.includes(draft.kind)) {
    return schemaError<FeedbackPlan>("kind", "closed_enum");
  }
  if (!FEEDBACK_STATUSES.includes(draft.status)) {
    return schemaError<FeedbackPlan>("status", "recorded_or_needs_evidence");
  }
  if (!isSourceRef(draft.quote_ref)) {
    return schemaError<FeedbackPlan>("quote_ref", "source_ref_format");
  }
  if (draft.goal_version.length === 0) {
    return schemaError<FeedbackPlan>("goal_version", "non_empty");
  }
  if (!isPositiveSafeInteger(draft.input_epoch)) {
    return schemaError<FeedbackPlan>("input_epoch", "positive_safe_integer");
  }
  if (!isNonNegativeSafeInteger(context.recorded_at)) {
    return schemaError<FeedbackPlan>("recorded_at", "non_negative_safe_integer");
  }
  if (!isNonNegativeSafeInteger(context.source_event_watermark)) {
    return schemaError<FeedbackPlan>("recorded_at_watermark", "non_negative_safe_integer");
  }

  const record: FeedbackRecord = {
    schema_version: "rsi.feedback/2",
    feedback_id: context.feedback_id,
    task_id: draft.task_id,
    branch_id: draft.branch_id,
    source_event_id: draft.source_event_id,
    kind: draft.kind,
    quote_ref: draft.quote_ref,
    target_issue_id: draft.target_issue_id,
    status: draft.status,
    goal_version: draft.goal_version,
    input_epoch: draft.input_epoch,
    recorded_at: context.recorded_at,
  };

  const row: FeedbackStateRow = {
    feedback_id: record.feedback_id,
    task_id: record.task_id,
    branch_id: record.branch_id,
    source_event_id: record.source_event_id,
    kind: record.kind,
    quote_ref: record.quote_ref,
    target_issue_id: record.target_issue_id,
    status: record.status,
    goal_version: record.goal_version,
    input_epoch: record.input_epoch,
    recorded_at: record.recorded_at,
  };

  const ledgerRow: LedgerFeedbackRow = {
    feedback_id: record.feedback_id,
    target_issue_id: record.target_issue_id,
    origin: context.origin,
    signal_kind: record.kind,
    status: record.status,
    goal_version: record.goal_version,
    input_epoch: record.input_epoch,
    source_refs: [record.quote_ref],
    recorded_at: record.recorded_at,
    recorded_at_watermark: context.source_event_watermark,
  };

  return ledgerOk({ record, row, ledger_row: ledgerRow });
}
