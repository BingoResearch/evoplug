import { canonicalHash } from "@evoplug/core";
import type { Hash, Id, SourceRef, VersionBinding } from "@evoplug/core";
import { compareUtf8 } from "@evoplug/core";
import type { RequirementOpRecord } from "./domain/requirements.js";
import type { LedgerCorrection } from "./domain/feedback.js";
import type {
  FactVerificationRecordedPayloadV2,
  StateFactDraft,
} from "./domain/facts.js";
import type {
  LedgerEvidenceSnapshot,
  LedgerView,
  PendingWorkItem,
  SuccessEvidenceKind,
  SuccessEvidenceProducerKind,
  TaskOutcomeRecord,
} from "./domain/outcome.js";
import { uniqueSortedStrings } from "./util.js";
import {
  acceptanceListJson,
  constraintsViewJson,
  currentRequirementJson,
  feedbackRecordJson,
  ledgerCorrectionJson,
  ledgerFeedbackRowJson,
  ledgerRequirementOpRowJson,
  ledgerRequirementRowJson,
  methodRefJson,
  requirementScopeJson,
  stateFactViewJson,
  unverifiedConstraintJson,
  versionBindingJson,
  type JsonObject,
} from "./json.js";
import type { UnverifiedConstraint } from "./domain/requirements.js";

export interface SuccessEvidenceHashInput {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly kind: SuccessEvidenceKind;
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly producer_kind: SuccessEvidenceProducerKind;
  readonly covered_requirement_ids: readonly Id<"req">[];
  readonly binding: VersionBinding;
  readonly attestation_subject_hash: Hash | null;
}

/**
 * The single `/2` success-evidence preimage from DD-FND-054.4:
 * `evidence_id`, `human_attestation`, timestamps, `row_version` and
 * `evidence_hash` are excluded on purpose.
 */
export function successEvidenceHash(input: SuccessEvidenceHashInput): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.success_evidence_hash/2",
    task_id: input.task_id,
    branch_id: input.branch_id,
    kind: input.kind,
    source_event_id: input.source_event_id,
    source_ref: input.source_ref,
    producer_ref: input.producer_ref,
    producer_kind: input.producer_kind,
    covered_requirement_ids: uniqueSortedStrings(input.covered_requirement_ids),
    version_binding: versionBindingJson(input.binding),
    attestation_subject_hash: input.attestation_subject_hash,
  };
  return canonicalHash(preimage);
}

export interface TaskOutcomeHashInput {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly binding: VersionBinding;
  readonly revision: number;
  readonly outcome: TaskOutcomeRecord["outcome"];
  readonly success_evidence_refs: readonly SourceRef[];
  readonly uncovered_requirement_ids: readonly Id<"req">[];
  readonly pending_work: readonly PendingWorkItem[];
  readonly reason_code: TaskOutcomeRecord["reason_code"];
  readonly boundary_event_id: Id<"ev"> | null;
}

/** Stable order for pending-work items: kind, then ref, then reason. */
export function sortPendingWork(items: readonly PendingWorkItem[]): PendingWorkItem[] {
  return [...items].sort((a, b) => {
    const byKind = compareUtf8(a.kind, b.kind);
    if (byKind !== 0) return byKind;
    const byRef = compareUtf8(a.ref, b.ref);
    if (byRef !== 0) return byRef;
    return compareUtf8(a.reason_code, b.reason_code);
  });
}

export function taskOutcomeHash(input: TaskOutcomeHashInput): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.task_outcome_hash/2",
    task_id: input.task_id,
    branch_id: input.branch_id,
    binding: versionBindingJson(input.binding),
    revision: input.revision,
    outcome: input.outcome,
    success_evidence_refs: uniqueSortedStrings(input.success_evidence_refs),
    uncovered_requirement_ids: uniqueSortedStrings(input.uncovered_requirement_ids),
    pending_work: sortPendingWork(input.pending_work).map((item) => ({
      kind: item.kind,
      ref: item.ref,
      reason_code: item.reason_code,
    })),
    reason_code: input.reason_code,
    boundary_event_id: input.boundary_event_id,
  };
  return canonicalHash(preimage);
}

export type RequirementOpContentHashInput = Omit<
  RequirementOpRecord,
  "schema_version" | "op_id" | "recorded_at" | "content_hash"
>;

/**
 * `RequirementOpRecord.content_hash` (DD-FND-074 hash whitelist). Nullable
 * fields are written explicitly; `op_id`, timestamps, validity and the hash
 * itself are excluded.
 */
export function requirementOpContentHash(record: RequirementOpContentHashInput): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.requirement_op_hash/1",
    task_id: record.task_id,
    branch_id: record.branch_id,
    source_event_id: record.source_event_id,
    actor_origin: record.actor_origin,
    directive_strength: record.directive_strength,
    op: record.op,
    target_requirement_id: record.target_requirement_id,
    created_requirement_id: record.created_requirement_id,
    superseded_requirement_ids: uniqueSortedStrings(record.superseded_requirement_ids),
    statement_ref: record.statement_ref,
    source_text_hash: record.source_text_hash,
    scope: requirementScopeJson(record.scope),
    acceptance: acceptanceListJson(record.acceptance),
    source_quote_ref: record.source_quote_ref,
    status: record.status,
    effective_input_epoch: record.effective_input_epoch,
    goal_version_before: record.goal_version_before,
    goal_version_after: record.goal_version_after,
  };
  return canonicalHash(preimage);
}

export interface RequirementContentHashInput {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly requirement_id: Id<"req">;
  readonly revision: number;
  readonly statement_ref: SourceRef;
  readonly statement_text_hash: Hash;
  readonly scope: import("./domain/requirements.js").RequirementScope;
  readonly acceptance: readonly import("./domain/requirements.js").AcceptanceCriterion[];
  readonly status: "proposed" | "active" | "superseded" | "retracted" | "rejected";
  readonly created_by_op_id: Id<"reqop">;
  readonly valid_from_event: number;
  readonly effective_input_epoch: number;
  readonly superseded_by_requirement_id: Id<"req"> | null;
}

/**
 * Requirement revision content hash. The design fixes the column and its
 * required uniqueness but does not spell the preimage; this is the literal
 * reading: all immutable revision identity and content, excluding the update
 * timestamps.
 */
export function requirementContentHash(input: RequirementContentHashInput): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.requirement_content/1",
    task_id: input.task_id,
    branch_id: input.branch_id,
    requirement_id: input.requirement_id,
    revision: input.revision,
    statement_ref: input.statement_ref,
    statement_text_hash: input.statement_text_hash,
    scope: requirementScopeJson(input.scope),
    acceptance: acceptanceListJson(input.acceptance),
    status: input.status,
    created_by_op_id: input.created_by_op_id,
    valid_from_event: input.valid_from_event,
    effective_input_epoch: input.effective_input_epoch,
    superseded_by_requirement_id: input.superseded_by_requirement_id,
  };
  return canonicalHash(preimage);
}

/**
 * `StateFact.content_hash` uses the creating binding F, never a later
 * verification binding V. `fact_id`, aggregated truth state, verifier ref,
 * stale flags and `row_version` are excluded.
 */
export function stateFactContentHash(draft: StateFactDraft): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.state_fact_content/1",
    task_id: draft.binding.task_id,
    branch_id: draft.binding.branch_id,
    binding: versionBindingJson(draft.binding),
    kind: draft.kind,
    subject: draft.subject,
    value: draft.value,
    source_ref: draft.source_ref,
    producer_ref: draft.producer_ref,
    artifact_version: draft.artifact_version,
    observed_at: draft.observed_at,
  };
  return canonicalHash(preimage);
}

export type FactVerificationContentHashV2Input = Omit<
  FactVerificationRecordedPayloadV2,
  "content_hash"
>;

/** Current `/2` fact-verification content hash (DD-FND-074). */
export function factVerificationContentHashV2(
  payload: FactVerificationContentHashV2Input,
): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.fact_verification_content_hash/2",
    fact_id: payload.fact_id,
    verification_binding: versionBindingJson(payload.verification_binding),
    verifier_ref: payload.verifier_ref,
    verifier_id: payload.verifier_id,
    verifier_kind: payload.verifier_kind,
    method_ref: methodRefJson(payload.method_ref),
    reservation_ids: uniqueSortedStrings(payload.reservation_ids),
    requirement_ids: uniqueSortedStrings(payload.requirement_ids),
    proposition_ids: uniqueSortedStrings(payload.proposition_ids),
    effect: payload.effect,
    artifact_version: payload.artifact_version,
    source_ids: uniqueSortedStrings(payload.source_ids),
    source_refs: uniqueSortedStrings(payload.source_refs),
    result: payload.result,
    status: payload.status,
  };
  return canonicalHash(preimage);
}

export type LedgerCorrectionHashInput = Omit<LedgerCorrection, "correction_hash">;

export function ledgerCorrectionHash(correction: LedgerCorrectionHashInput): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.ledger_correction_hash/2",
    task_id: correction.task_id,
    branch_id: correction.branch_id,
    corrected_record_id: correction.corrected_record_id,
    correction_kind: correction.correction_kind,
    original_source_event_id: correction.original_source_event_id,
    original_source_ref: correction.original_source_ref,
    original_text_hash: correction.original_text_hash,
    status: correction.status,
    valid_from_event: correction.valid_from_event,
    replacement_op_ids: uniqueSortedStrings(correction.replacement_op_ids),
    invalidated_judgment_ids: uniqueSortedStrings(correction.invalidated_judgment_ids),
  };
  return canonicalHash(preimage);
}

export function constraintsViewHash(
  binding: VersionBinding,
  constraints: readonly UnverifiedConstraint[],
): Hash {
  return canonicalHash(constraintsViewJson(binding, constraints));
}

/** Evidence-snapshot `view_hash`; excludes the hash itself. */
export function evidenceSnapshotViewHash(
  snapshot: Omit<LedgerEvidenceSnapshot, "view_hash">,
): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.ledger_evidence_snapshot/1",
    binding: versionBindingJson(snapshot.binding),
    active_requirement_ids: uniqueSortedStrings(snapshot.active_requirement_ids),
    requirements: snapshot.requirements.map((row) => ledgerRequirementRowJson(row)),
    requirement_ops: snapshot.requirement_ops.map((row) => ledgerRequirementOpRowJson(row)),
    feedback: snapshot.feedback.map((row) => ledgerFeedbackRowJson(row)),
    constraints: snapshot.constraints.map((row) => unverifiedConstraintJson(row)),
    constraints_view_hash: snapshot.constraints_view_hash,
  };
  return canonicalHash(preimage);
}

/**
 * `LedgerView.view_hash`. The design lists binding, stably sorted
 * requirements/facts/feedback/corrections/constraints and the outcome hash;
 * the envelope schema version is not specified there, so this uses
 * `rsi.ledger_view/1` and excludes `view_hash` itself.
 */
export function ledgerViewHash(view: Omit<LedgerView, "view_hash">): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.ledger_view/1",
    binding: versionBindingJson(view.binding),
    requirements: view.requirements.map((row) => currentRequirementJson(row)),
    facts: view.facts.map((row) => stateFactViewJson(row)),
    feedback: view.feedback.map((row) => feedbackRecordJson(row)),
    corrections: view.corrections.map((row) => ledgerCorrectionJson(row)),
    constraints: view.constraints.map((row) => unverifiedConstraintJson(row)),
    outcome: view.outcome === null ? null : view.outcome.outcome_hash,
  };
  return canonicalHash(preimage);
}

export interface GoalSnapshotHashInput {
  readonly task_id: Id<"task">;
  readonly source_branch_id: Id<"br">;
  readonly source_goal_version: string;
  readonly local_goal_version: string;
  readonly local_goal_revision: number;
  readonly watermark: number;
  readonly active_requirement_ids: readonly Id<"req">[];
}

/**
 * Goal-snapshot identity. The design requires a `snapshot_hash` column but
 * does not spell the preimage in this range; this is the literal reading over
 * the immutable snapshot fields.
 */
export function goalSnapshotHash(input: GoalSnapshotHashInput): Hash {
  const preimage: JsonObject = {
    schema_version: "rsi.goal_snapshot/1",
    task_id: input.task_id,
    source_branch_id: input.source_branch_id,
    source_goal_version: input.source_goal_version,
    local_goal_version: input.local_goal_version,
    local_goal_revision: input.local_goal_revision,
    watermark: input.watermark,
    active_requirement_ids: uniqueSortedStrings(input.active_requirement_ids),
  };
  return canonicalHash(preimage);
}
