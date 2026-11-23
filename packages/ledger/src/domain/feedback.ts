import type { Hash, Id, SourceRef } from "@evoplug/core";
import type { Origin } from "./common.js";

export type FeedbackKind = "correction" | "dissatisfaction" | "new_goal" | "acceptance";

export interface FeedbackRecord {
  readonly schema_version: "rsi.feedback/2";
  readonly feedback_id: Id<"fb">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly source_event_id: Id<"ev">;
  readonly kind: FeedbackKind;
  readonly quote_ref: SourceRef;
  readonly target_issue_id: Id<"issue"> | null;
  readonly status: "recorded" | "needs_evidence";
  readonly goal_version: string;
  readonly input_epoch: number;
  readonly recorded_at: number;
}

export interface LedgerFeedbackRow {
  readonly feedback_id: Id<"fb">;
  readonly target_issue_id: Id<"issue"> | null;
  readonly origin: Origin;
  readonly signal_kind: FeedbackKind;
  readonly status: "recorded" | "needs_evidence";
  readonly goal_version: string;
  readonly input_epoch: number;
  /** Contains `quote_ref` only. */
  readonly source_refs: SourceRef[];
  readonly recorded_at: number;
  readonly recorded_at_watermark: number;
}

export interface FeedbackDraft {
  readonly schema_version: "rsi.feedback_draft/1";
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly source_event_id: Id<"ev">;
  readonly kind: FeedbackKind;
  readonly quote_ref: SourceRef;
  readonly target_issue_id: Id<"issue"> | null;
  readonly status: "recorded" | "needs_evidence";
  readonly goal_version: string;
  readonly input_epoch: number;
}

export type CorrectionKind = "missed_extraction" | "wrong_extraction" | "wrong_link";

export interface LedgerCorrection {
  readonly schema_version: "rsi.ledger_correction/2";
  readonly correction_id: Id<"lcor">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  /** Full ID of the corrected Requirement/Fact/Judgment. */
  readonly corrected_record_id: string;
  readonly correction_kind: CorrectionKind;
  readonly original_source_event_id: Id<"ev">;
  readonly original_source_ref: SourceRef;
  readonly original_text_hash: Hash;
  /**
   * `applied` only means the correction record was validated; it never
   * authorizes the replacement ops.
   */
  readonly status: "applied" | "rejected_original_missing";
  readonly recorded_at: number;
  readonly valid_from_event: number;
  readonly replacement_op_ids: Id<"reqop">[];
  readonly invalidated_judgment_ids: string[];
  readonly correction_hash: Hash;
}

export interface LedgerCorrectionDraft {
  readonly schema_version: "rsi.ledger_correction_draft/1";
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly corrected_record_id: string;
  readonly correction_kind: CorrectionKind;
  readonly original_source_event_id: Id<"ev">;
  readonly original_source_ref: SourceRef;
  readonly original_text_hash: Hash;
  readonly valid_from_event: number;
  readonly replacement_op_ids: readonly Id<"reqop">[];
  readonly invalidated_judgment_ids: readonly string[];
}
