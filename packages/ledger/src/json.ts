import type { JsonValue, MethodRef, VersionBinding } from "@evoplug/core";
import type { HumanAttestation, TriggerLineage } from "./domain/common.js";
import type {
  AcceptanceCriterion,
  CurrentRequirement,
  LedgerRequirementOpRow,
  LedgerRequirementRow,
  RequirementOpDraft,
  RequirementOpRecord,
  RequirementScope,
  UnverifiedConstraint,
} from "./domain/requirements.js";
import type {
  FactVerificationRecordedPayloadV2,
  StateFactDraft,
  StateFactView,
  VerifierRegistryView,
} from "./domain/facts.js";
import type {
  FeedbackRecord,
  LedgerCorrection,
  LedgerFeedbackRow,
} from "./domain/feedback.js";
import type {
  LedgerEvidenceSnapshot,
  LedgerView,
  PendingWorkItem,
  SuccessEvidence,
  TaskOutcomeRecord,
} from "./domain/outcome.js";

export type JsonObject = { [key: string]: JsonValue };

export function versionBindingJson(binding: VersionBinding): JsonObject {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
  };
}

export function methodRefJson(ref: MethodRef): JsonObject {
  return {
    schema_version: ref.schema_version,
    method_id: ref.method_id,
    method_version: ref.method_version,
    rule_version: ref.rule_version,
  };
}

export function humanAttestationJson(attestation: HumanAttestation): JsonObject {
  return {
    kind: attestation.kind,
    capability_id: attestation.capability_id,
    evidence_ref: attestation.evidence_ref,
    confirmed_at: attestation.confirmed_at,
  };
}

export function triggerLineageJson(lineage: TriggerLineage): JsonObject {
  return {
    axis: lineage.axis,
    root_event_id: lineage.root_event_id,
    depth: lineage.depth,
  };
}

export function requirementScopeJson(scope: RequirementScope): JsonObject {
  return {
    paths: [...scope.paths],
    hosts: [...scope.hosts],
    modes: [...scope.modes],
    project_ids: [...scope.project_ids],
  };
}

export function acceptanceCriterionJson(criterion: AcceptanceCriterion): JsonObject {
  switch (criterion.kind) {
    case "human_acceptance":
      return { kind: criterion.kind, source_ref: criterion.source_ref };
    case "test_pass":
      return { kind: criterion.kind, command: criterion.command, cwd: criterion.cwd };
    case "artifact_check":
      return criterion.expected_hash === undefined
        ? { kind: criterion.kind, path: criterion.path }
        : { kind: criterion.kind, path: criterion.path, expected_hash: criterion.expected_hash };
    case "external_verification":
      return {
        kind: criterion.kind,
        verifier: criterion.verifier,
        evidence_ref: criterion.evidence_ref,
      };
  }
}

export function acceptanceListJson(acceptance: readonly AcceptanceCriterion[]): JsonValue[] {
  return acceptance.map((criterion) => acceptanceCriterionJson(criterion));
}

export function requirementOpDraftJson(draft: RequirementOpDraft): JsonObject {
  return {
    schema_version: draft.schema_version,
    task_id: draft.task_id,
    branch_id: draft.branch_id,
    source_event_id: draft.source_event_id,
    actor_origin: draft.actor_origin,
    directive_strength: draft.directive_strength,
    op: draft.op,
    target_requirement_id: draft.target_requirement_id,
    superseded_requirement_ids: [...draft.superseded_requirement_ids],
    statement_text: draft.statement_text,
    scope: requirementScopeJson(draft.scope),
    acceptance: acceptanceListJson(draft.acceptance),
    source_quote_ref: draft.source_quote_ref,
    source_text_hash: draft.source_text_hash,
  };
}

export function requirementOpRecordJson(record: RequirementOpRecord): JsonObject {
  return {
    schema_version: record.schema_version,
    op_id: record.op_id,
    task_id: record.task_id,
    branch_id: record.branch_id,
    source_event_id: record.source_event_id,
    actor_origin: record.actor_origin,
    directive_strength: record.directive_strength,
    op: record.op,
    target_requirement_id: record.target_requirement_id,
    superseded_requirement_ids: [...record.superseded_requirement_ids],
    statement_text: record.statement_text,
    scope: requirementScopeJson(record.scope),
    acceptance: acceptanceListJson(record.acceptance),
    source_quote_ref: record.source_quote_ref,
    source_text_hash: record.source_text_hash,
    statement_ref: record.statement_ref,
    status: record.status,
    created_requirement_id: record.created_requirement_id,
    effective_input_epoch: record.effective_input_epoch,
    goal_version_before: record.goal_version_before,
    goal_version_after: record.goal_version_after,
    recorded_at: record.recorded_at,
    content_hash: record.content_hash,
  };
}

export function ledgerRequirementRowJson(row: LedgerRequirementRow): JsonObject {
  return {
    requirement_id: row.requirement_id,
    revision: row.revision,
    statement_ref: row.statement_ref,
    statement_text_hash: row.statement_text_hash,
    scope: requirementScopeJson(row.scope),
    acceptance: acceptanceListJson(row.acceptance),
    status: row.status,
    created_by_op_id: row.created_by_op_id,
    valid_from_event: row.valid_from_event,
    valid_to_event: row.valid_to_event,
    effective_input_epoch: row.effective_input_epoch,
    content_hash: row.content_hash,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    goal_version: row.goal_version,
    source_refs: [...row.source_refs],
  };
}

export function ledgerRequirementOpRowJson(row: LedgerRequirementOpRow): JsonObject {
  return {
    op_id: row.op_id,
    status: row.status,
    op: row.op,
    actor_origin: row.actor_origin,
    directive_strength: row.directive_strength,
    target_requirement_id: row.target_requirement_id,
    created_requirement_id: row.created_requirement_id,
    effective_input_epoch: row.effective_input_epoch,
    goal_version_before: row.goal_version_before,
    goal_version_after: row.goal_version_after,
    valid_from_event: row.valid_from_event,
    valid_to_event: row.valid_to_event,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    source_quote_ref: row.source_quote_ref,
    content_hash: row.content_hash,
  };
}

export function ledgerFeedbackRowJson(row: LedgerFeedbackRow): JsonObject {
  return {
    feedback_id: row.feedback_id,
    target_issue_id: row.target_issue_id,
    origin: row.origin,
    signal_kind: row.signal_kind,
    status: row.status,
    goal_version: row.goal_version,
    input_epoch: row.input_epoch,
    source_refs: [...row.source_refs],
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
  };
}

export function feedbackRecordJson(row: FeedbackRecord): JsonObject {
  return {
    schema_version: row.schema_version,
    feedback_id: row.feedback_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    source_event_id: row.source_event_id,
    kind: row.kind,
    quote_ref: row.quote_ref,
    target_issue_id: row.target_issue_id,
    status: row.status,
    goal_version: row.goal_version,
    input_epoch: row.input_epoch,
    recorded_at: row.recorded_at,
  };
}

export function unverifiedConstraintJson(row: UnverifiedConstraint): JsonObject {
  return {
    schema_version: row.schema_version,
    constraint_id: row.constraint_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    binding: versionBindingJson(row.binding),
    source_event_id: row.source_event_id,
    source_ref: row.source_ref,
    quote: row.quote,
    quote_hash: row.quote_hash,
    scope_hint: row.scope_hint === null ? null : requirementScopeJson(row.scope_hint),
    status: row.status,
    authorization: row.authorization,
    usable_for: [...row.usable_for],
    conflict_with_requirement_ids: [...row.conflict_with_requirement_ids],
    confirmed_by_event_id: row.confirmed_by_event_id,
    recorded_at_watermark: row.recorded_at_watermark,
    created_at: row.created_at,
    row_version: row.row_version,
  };
}

export function ledgerCorrectionJson(row: LedgerCorrection): JsonObject {
  return {
    schema_version: row.schema_version,
    correction_id: row.correction_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    corrected_record_id: row.corrected_record_id,
    correction_kind: row.correction_kind,
    original_source_event_id: row.original_source_event_id,
    original_source_ref: row.original_source_ref,
    original_text_hash: row.original_text_hash,
    status: row.status,
    recorded_at: row.recorded_at,
    valid_from_event: row.valid_from_event,
    replacement_op_ids: [...row.replacement_op_ids],
    invalidated_judgment_ids: [...row.invalidated_judgment_ids],
    correction_hash: row.correction_hash,
  };
}

export function currentRequirementJson(row: CurrentRequirement): JsonObject {
  return {
    requirement_id: row.requirement_id,
    revision: row.revision,
    statement_ref: row.statement_ref,
    statement_text_hash: row.statement_text_hash,
    scope: requirementScopeJson(row.scope),
    acceptance: acceptanceListJson(row.acceptance),
    status: row.status,
    source_refs: [...row.source_refs],
  };
}

export function verifierRegistryViewJson(row: VerifierRegistryView): JsonObject {
  return {
    schema_version: row.schema_version,
    fact_id: row.fact_id,
    event_id: row.event_id,
    verifier_ref: row.verifier_ref,
    verifier_id: row.verifier_id,
    verifier_kind: row.verifier_kind,
    method_ref: row.method_ref === null ? null : methodRefJson(row.method_ref),
    reservation_ids: [...row.reservation_ids],
    independent: row.independent,
    verification_binding: versionBindingJson(row.verification_binding),
    requirement_ids: [...row.requirement_ids],
    proposition_ids: [...row.proposition_ids],
    effect: row.effect,
    artifact_version: row.artifact_version,
    source_ids: [...row.source_ids],
    source_refs: [...row.source_refs],
    result: row.result,
    status: row.status,
    verified_at: row.verified_at,
    row_version: row.row_version,
  };
}

export function stateFactViewJson(row: StateFactView): JsonObject {
  return {
    schema_version: row.schema_version,
    fact_id: row.fact_id,
    binding: versionBindingJson(row.binding),
    kind: row.kind,
    subject: row.subject,
    value: row.value,
    truth_state: row.truth_state,
    stale: row.stale,
    stale_reason: row.stale_reason,
    source_ref: row.source_ref,
    producer_ref: row.producer_ref,
    verifier_ref: row.verifier_ref,
    artifact_version: row.artifact_version,
    observed_at: row.observed_at,
    verifiers: row.verifiers.map((verifier) => verifierRegistryViewJson(verifier)),
    row_version: row.row_version,
  };
}

export function stateFactDraftJson(draft: StateFactDraft): JsonObject {
  return {
    schema_version: draft.schema_version,
    binding: versionBindingJson(draft.binding),
    kind: draft.kind,
    subject: draft.subject,
    value: draft.value,
    truth_state: draft.truth_state,
    source_ref: draft.source_ref,
    producer_ref: draft.producer_ref,
    artifact_version: draft.artifact_version,
    observed_at: draft.observed_at,
  };
}

export function factVerificationV2Json(payload: FactVerificationRecordedPayloadV2): JsonObject {
  return {
    schema_version: payload.schema_version,
    fact_id: payload.fact_id,
    verification_binding: versionBindingJson(payload.verification_binding),
    verifier_ref: payload.verifier_ref,
    verifier_id: payload.verifier_id,
    verifier_kind: payload.verifier_kind,
    method_ref: methodRefJson(payload.method_ref),
    reservation_ids: [...payload.reservation_ids],
    requirement_ids: [...payload.requirement_ids],
    proposition_ids: [...payload.proposition_ids],
    effect: payload.effect,
    artifact_version: payload.artifact_version,
    source_ids: [...payload.source_ids],
    source_refs: [...payload.source_refs],
    result: payload.result,
    status: payload.status,
  };
}

export function successEvidenceJson(row: SuccessEvidence): JsonObject {
  return {
    schema_version: row.schema_version,
    evidence_id: row.evidence_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    kind: row.kind,
    source_event_id: row.source_event_id,
    source_ref: row.source_ref,
    producer_ref: row.producer_ref,
    producer_kind: row.producer_kind,
    covered_requirement_ids: [...row.covered_requirement_ids],
    binding: versionBindingJson(row.binding),
    human_attestation: row.human_attestation === null ? null : humanAttestationJson(row.human_attestation),
    attestation_subject_hash: row.attestation_subject_hash,
    verified_at: row.verified_at,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    evidence_hash: row.evidence_hash,
    row_version: row.row_version,
  };
}

export function pendingWorkJson(item: PendingWorkItem): JsonObject {
  return { kind: item.kind, ref: item.ref, reason_code: item.reason_code };
}

export function taskOutcomeRecordJson(row: TaskOutcomeRecord): JsonObject {
  return {
    schema_version: row.schema_version,
    outcome_id: row.outcome_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    binding: versionBindingJson(row.binding),
    revision: row.revision,
    outcome: row.outcome,
    success_evidence_refs: [...row.success_evidence_refs],
    uncovered_requirement_ids: [...row.uncovered_requirement_ids],
    pending_work: row.pending_work.map((item) => pendingWorkJson(item)),
    reason_code: row.reason_code,
    boundary_event_id: row.boundary_event_id,
    decided_at: row.decided_at,
    outcome_hash: row.outcome_hash,
  };
}

export function ledgerViewJson(row: LedgerView): JsonObject {
  return {
    binding: versionBindingJson(row.binding),
    requirements: row.requirements.map((requirement) => currentRequirementJson(requirement)),
    facts: row.facts.map((fact) => stateFactViewJson(fact)),
    feedback: row.feedback.map((feedback) => feedbackRecordJson(feedback)),
    corrections: row.corrections.map((correction) => ledgerCorrectionJson(correction)),
    constraints: row.constraints.map((constraint) => unverifiedConstraintJson(constraint)),
    outcome: row.outcome === null ? null : taskOutcomeRecordJson(row.outcome),
  };
}

export function ledgerEvidenceSnapshotJson(row: LedgerEvidenceSnapshot): JsonObject {
  return {
    schema_version: row.schema_version,
    binding: versionBindingJson(row.binding),
    active_requirement_ids: [...row.active_requirement_ids],
    requirements: row.requirements.map((requirement) => ledgerRequirementRowJson(requirement)),
    requirement_ops: row.requirement_ops.map((op) => ledgerRequirementOpRowJson(op)),
    feedback: row.feedback.map((feedback) => ledgerFeedbackRowJson(feedback)),
    constraints: row.constraints.map((constraint) => unverifiedConstraintJson(constraint)),
    constraints_view_hash: row.constraints_view_hash,
  };
}

export function constraintsViewJson(
  binding: VersionBinding,
  constraints: readonly UnverifiedConstraint[],
): JsonObject {
  return {
    schema_version: "rsi.constraints_view/1",
    binding: versionBindingJson(binding),
    constraints: constraints.map((constraint) => unverifiedConstraintJson(constraint)),
  };
}

