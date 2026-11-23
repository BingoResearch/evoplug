import type { Hash, Id, JsonValue, SourceRef } from "@evoplug/core";
import type { JsonObject } from "./json.js";
import type {
  DirectiveStrength,
  Origin,
  RequirementOpKind,
  RequirementOpStatus,
  TaskOutcome,
} from "./domain/common.js";
import type { CorrectionKind, FeedbackKind } from "./domain/feedback.js";
import type { FactVerificationEffect, FactVerificationStatus, StateFactKind, VerifierKind, VerifierResult } from "./domain/facts.js";

/**
 * Physical row shapes for ledger-owned state rows. The generated state-row
 * types live in the schema codegen output (owned by FND baseline); these
 * aliases mirror the DDL column names and are used only to build `row_json`
 * before handing it to the shared state-row port.
 *
 * Ledger-owned schemas:
 *   rsi.requirement_op_row/1, rsi.requirement_row/1,
 *   rsi.requirement_source_row/1, rsi.requirement_head_row/1,
 *   rsi.goal_snapshot_row/1, rsi.ledger_correction_row/1,
 *   rsi.state_fact_row/1, rsi.fact_verification_row/1,
 *   rsi.feedback_row/1, rsi.unverified_constraint_row/1,
 *   rsi.success_evidence_row/1, rsi.task_outcome_row/1.
 */
export type RequirementOpStateRow = {
  readonly op_id: Id<"reqop">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly source_event_id: Id<"ev">;
  readonly actor_origin: Origin;
  readonly directive_strength: DirectiveStrength;
  readonly op: RequirementOpKind;
  readonly target_requirement_id: Id<"req"> | null;
  readonly created_requirement_id: Id<"req"> | null;
  readonly superseded_requirement_ids_json: string;
  readonly statement_ref: SourceRef | null;
  readonly scope_json: string;
  readonly acceptance_json: string;
  readonly source_quote_ref: SourceRef;
  readonly source_text_hash: Hash;
  readonly status: RequirementOpStatus;
  readonly recorded_at: number;
  readonly valid_from_event: number;
  readonly valid_to_event: number | null;
  readonly effective_input_epoch: number;
  readonly goal_version_before: string;
  readonly goal_version_after: string;
  readonly content_hash: Hash;
};

export type RequirementStateRow = {
  readonly requirement_id: Id<"req">;
  readonly revision: number;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly statement_ref: SourceRef;
  readonly statement_text_hash: Hash;
  readonly scope_json: string;
  readonly acceptance_json: string;
  readonly status: "proposed" | "active" | "superseded" | "retracted" | "rejected";
  readonly created_by_op_id: Id<"reqop">;
  readonly superseded_by_requirement_id: Id<"req"> | null;
  readonly valid_from_event: number;
  readonly valid_to_event: number | null;
  readonly effective_input_epoch: number;
  readonly content_hash: Hash;
  readonly recorded_at: number;
};

export type RequirementSourceStateRow = {
  readonly requirement_id: Id<"req">;
  readonly requirement_revision: number;
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly quote_hash: Hash;
  readonly role: "original" | "clarification" | "confirmation" | "correction";
};

export type RequirementHeadStateRow = {
  readonly requirement_id: Id<"req">;
  readonly revision: number;
  readonly status: "proposed" | "active" | "superseded" | "retracted" | "rejected";
  readonly current_goal_version: string;
  readonly updated_at: number;
  readonly row_version: number;
};

export type GoalSnapshotStateRow = {
  readonly snapshot_id: Id<"gsnap">;
  readonly task_id: Id<"task">;
  readonly source_branch_id: Id<"br">;
  readonly source_goal_version: string;
  readonly local_goal_version: string;
  readonly local_goal_revision: number;
  readonly watermark: number;
  readonly active_requirement_ids_json: string;
  readonly snapshot_hash: Hash;
  readonly created_at: number;
};

export type LedgerCorrectionStateRow = {
  readonly correction_id: Id<"lcor">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly corrected_record_id: string;
  readonly correction_kind: CorrectionKind;
  readonly original_source_event_id: Id<"ev">;
  readonly original_source_ref: SourceRef;
  readonly original_text_hash: Hash;
  readonly status: "applied" | "rejected_original_missing";
  readonly recorded_at: number;
  readonly valid_from_event: number;
  readonly replacement_op_ids_json: string;
  readonly invalidated_judgment_ids_json: string;
  readonly correction_hash: Hash;
};

export type StateFactStateRow = {
  readonly fact_id: Id<"fact">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly kind: StateFactKind;
  readonly subject: string;
  readonly value: string;
  readonly truth_state: "claim" | "observed" | "verified" | "contradicted" | "unknown";
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly verifier_ref: SourceRef | null;
  readonly artifact_version: string | null;
  readonly observed_at: number;
  readonly stale: 0 | 1;
  readonly stale_reason: "artifact_changed" | "verifier_invalidated" | "correction" | "explicit" | null;
  readonly content_hash: Hash;
  readonly row_version: number;
};

export type FactVerificationStateRow = {
  readonly fact_id: Id<"fact">;
  readonly event_id: Id<"ev">;
  readonly verifier_ref: SourceRef;
  readonly verifier_id: string;
  readonly verifier_kind: VerifierKind;
  readonly method_ref_json: string | null;
  readonly reservation_ids_json: string;
  readonly independent: 0 | 1;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly requirement_ids_json: string;
  readonly proposition_ids_json: string;
  readonly effect: FactVerificationEffect;
  readonly artifact_version: string | null;
  readonly source_ids_json: string;
  readonly source_refs_json: string;
  readonly result: VerifierResult;
  readonly status: FactVerificationStatus;
  readonly content_hash: Hash;
  readonly verified_at: number;
  readonly row_version: number;
};

export type FeedbackStateRow = {
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
};

export type UnverifiedConstraintStateRow = {
  readonly constraint_id: Id<"uc">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly binding_json: string;
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly quote: string;
  readonly quote_hash: Hash;
  readonly scope_hint_json: string | null;
  readonly status: "unverified_constraint" | "confirmed" | "rejected";
  readonly authorization: 0;
  readonly usable_for_json: string;
  readonly conflict_with_requirement_ids_json: string;
  readonly confirmed_by_event_id: Id<"ev"> | null;
  readonly recorded_at_watermark: number;
  readonly created_at: number;
  readonly row_version: number;
};

export type SuccessEvidenceStateRow = {
  readonly evidence_id: Id<"sev">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly kind: "human_acceptance" | "test_pass" | "artifact_check" | "external_verification";
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly producer_kind: "human" | "test_runner" | "artifact_checker" | "external_verifier";
  readonly covered_requirement_ids_json: string;
  readonly version_binding_json: string;
  readonly human_attestation_json: string | null;
  readonly attestation_subject_hash: Hash | null;
  readonly verified_at: number;
  readonly recorded_at: number;
  readonly recorded_at_watermark: number;
  readonly evidence_hash: Hash;
  readonly row_version: number;
};

export type TaskOutcomeStateRow = {
  readonly outcome_id: Id<"out">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly revision: number;
  readonly outcome: TaskOutcome;
  readonly success_evidence_refs_json: string;
  readonly uncovered_requirement_ids_json: string;
  readonly pending_work_json: string;
  readonly reason_code: string;
  readonly boundary_event_id: Id<"ev"> | null;
  readonly version_binding_json: string;
  readonly decided_at: number;
  readonly outcome_hash: Hash;
};

function rowObject(value: Readonly<Record<string, JsonValue>>): JsonObject {
  return { ...value };
}

export function requirementOpRowJson(row: RequirementOpStateRow): JsonObject {
  return rowObject(row);
}

export function requirementRowJson(row: RequirementStateRow): JsonObject {
  return rowObject(row);
}

export function goalSnapshotRowJson(row: GoalSnapshotStateRow): JsonObject {
  return rowObject(row);
}

export function ledgerCorrectionRowJson(row: LedgerCorrectionStateRow): JsonObject {
  return rowObject(row);
}

export function stateFactRowJson(row: StateFactStateRow): JsonObject {
  return rowObject(row);
}

export function factVerificationRowJson(row: FactVerificationStateRow): JsonObject {
  return rowObject(row);
}

export function feedbackRowJson(row: FeedbackStateRow): JsonObject {
  return rowObject(row);
}

export function successEvidenceRowJson(row: SuccessEvidenceStateRow): JsonObject {
  return rowObject(row);
}

export function taskOutcomeRowJson(row: TaskOutcomeStateRow): JsonObject {
  return rowObject(row);
}
