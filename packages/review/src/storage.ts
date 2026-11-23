/**
 * REV logical and physical storage shapes (DD-REV-150, DD-REV-150.1).
 *
 * Physical rows keep JSON text columns as strings and nullable SQL columns as
 * `null`. The DDL itself lives in `migrations/domains/review/0001_review.sql`.
 */

import { canonicalHash, canonicalJsonText, toJsonValue } from "@evoplug/core";
import type { Hash, Id, JsonValue, SourceRef, VersionBinding } from "@evoplug/core";

import { revError } from "./errors.js";
import type { HostId, HostMode, ReviewTriggerKind } from "./host-contracts.js";
import type {
  AdoptionBinding,
  CandidateKeyInput,
  Experience,
  ExperienceLifecycleEvent,
  ExperienceProjection,
  ExperienceRisk,
  ExperienceType,
  ProjectionLifecycle,
  ProjectionLifecycleReason,
  Proposal,
  ProposalCandidateRecord,
  ProposalFailureCode,
  ReviewAttempt,
  ReviewAttemptState,
  ReviewHandoff,
  ReviewJob,
  ReviewJobStage,
  ReviewJobState,
  ReviewSnapshot,
  UsageVerificationRecord,
  ValidationPlan
} from "./types.js";

export const REV_TABLES: readonly string[] = [
  "review_snapshots",
  "review_enqueue_requests",
  "review_jobs",
  "review_attempts",
  "proposal_candidates",
  "review_output_acceptances",
  "proposals",
  "review_handoffs",
  "experiences",
  "validation_plans",
  "experience_projections",
  "usage_verification_records",
  "experience_lifecycle_events"
];

export const REV_DERIVED_TABLES: readonly string[] = [
  "review_handoffs",
  "experience_projections"
];

export const REV_TYPED_ROW_SCHEMAS: readonly string[] = [
  "rsi.review_snapshot/1",
  "rsi.review_enqueue_request_row/1",
  "rsi.review_job/2",
  "rsi.review_attempt/1",
  "rsi.review_output_acceptance_row/1",
  "rsi.proposal_candidate_row/1",
  "rsi.proposal_row/2",
  "rsi.experience_row/1",
  "rsi.validation_plan_row/1",
  "rsi.usage_verification_row/1",
  "rsi.experience_lifecycle_event_row/1"
];

export function blobRef(hash: Hash, length: number): SourceRef {
  return `blob://${hash}#bytes=0-${length}`;
}

export function rowHash(rowSchema: string, row: JsonValue): Hash {
  return canonicalHash(toJsonValue({ row_schema: rowSchema, row_json: row }));
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

export function candidateKeyFrom(input: CandidateKeyInput): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.proposal_candidate_key/1",
      job_id: input.job_id,
      attempt_id: input.attempt_id,
      ordinal: input.ordinal,
      output_hash: input.output_hash,
      candidate_json_hash: input.candidate_json_hash
    })
  );
}

export function usageEvidenceHash(input: {
  loading_evidence_refs: readonly SourceRef[];
  behavior_evidence_refs: readonly SourceRef[];
  verification_binding_ref: SourceRef;
  outcome_ref: SourceRef | null;
  other_change_refs: readonly SourceRef[];
}): Hash {
  return canonicalHash(
    toJsonValue({
      loading_evidence_refs: [...input.loading_evidence_refs],
      behavior_evidence_refs: [...input.behavior_evidence_refs],
      verification_binding_ref: input.verification_binding_ref,
      outcome_ref: input.outcome_ref,
      other_change_refs: [...input.other_change_refs]
    })
  );
}

export function usageKey(input: {
  projection_id: string;
  version_binding: VersionBinding;
  experience_content_hash: Hash;
  validation_plan_hash: Hash;
  task_family_id: string;
  window_index: number;
  evidence_hash: Hash;
}): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.usage_key/1",
      projection_id: input.projection_id,
      version_binding: input.version_binding,
      experience_content_hash: input.experience_content_hash,
      validation_plan_hash: input.validation_plan_hash,
      task_family_id: input.task_family_id,
      window_index: input.window_index,
      evidence_hash: input.evidence_hash
    })
  );
}

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

const STATIC_STAGE: Readonly<Record<ProposalFailureCode, string>> = {
  E_PROPOSAL_DIFF_TOO_LARGE: "proposal_static_check",
  E_EXPERIENCE_TOO_LARGE: "proposal_static_check",
  E_PROPOSAL_UNTRUSTED_FIELD: "proposal_static_check",
  E_PROPOSAL_SCHEMA: "proposal_static_check",
  E_EXPERIENCE_SCHEMA: "proposal_static_check",
  E_PROPOSAL_TARGET: "proposal_static_check",
  E_PROPOSAL_OLD_HASH_MISSING: "proposal_static_check",
  E_PROPOSAL_OLD_HASH_MISMATCH: "proposal_static_check",
  E_PROPOSAL_DIFF_MISMATCH: "proposal_static_check",
  E_PROPOSAL_DIFF_APPLY: "proposal_static_check",
  E_PROPOSAL_EVIDENCE_NOT_ALLOWED: "proposal_static_check",
  E_PROPOSAL_SCOPE: "proposal_static_check",
  E_PROPOSAL_PROTECTED_FIELD: "proposal_static_check",
  E_EXPERIENCE_PLAN_SOURCE_CHANGED: "proposal_static_check",
  E_EXPERIENCE_VERIFIER_BINDING: "proposal_static_check",
  E_PROPOSAL_NO_CHANGE: "proposal_static_check",
  E_PROPOSAL_STALE_TARGET: "proposal_static_check"
};

export function proposalFailureToEnvelope(
  code: ProposalFailureCode,
  path: string,
  rule: string
): import("@evoplug/core").ErrorEnvelope {
  return revError({ code, stage: STATIC_STAGE[code], details: { kind: "field", path, rule } });
}

/* ------------------------------------------------------------------ */
/* Physical rows                                                       */
/* ------------------------------------------------------------------ */

interface ReviewSnapshotRow {
  snapshot_id: string;
  schema_version: "rsi.review_snapshot/1";
  snapshot_key: Hash;
  snapshot_hash: Hash;
  version_binding_json: string;
  snapshot_scope: ReviewSnapshot["snapshot_scope"];
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  host_id: HostId;
  config_space: string;
  mode: HostMode;
  trigger_event_id: string;
  trigger_kind: ReviewTriggerKind;
  review_kind: "auto" | "explicit";
  review_scope_key: Hash;
  boundary_key: Hash;
  signal_digest: Hash;
  trigger_dedupe_key: Hash;
  policy_version: string;
  authorization_ref: string | null;
  body_blob: SourceRef;
  created_at: number;
}

export interface ReviewEnqueueRequestRow {
  request_id: string;
  schema_version: "rsi.review_enqueue/1";
  request_hash: Hash;
  trigger_event_id: string;
  trigger_kind: ReviewTriggerKind;
  trigger_dedupe_key: Hash;
  version_binding_json: string;
  stable_evidence_ref: SourceRef;
  request_json: string;
  result_json: string;
  review_job_id: string;
  created_at: number;
}

interface ReviewJobRow {
  job_id: string;
  request_id: string;
  task_id: string;
  branch_id: string;
  snapshot_id: string;
  snapshot_hash: Hash;
  trigger_event_id: string;
  trigger_kind: ReviewTriggerKind;
  review_kind: "auto" | "explicit";
  review_scope_key: Hash;
  boundary_key: Hash;
  trigger_dedupe_key: Hash;
  signal_digest: Hash;
  stable_event_ids_json: string;
  stable_watermark: number;
  stable: 0 | 1;
  stable_evidence_ref: SourceRef;
  pending_state: "none" | "pending" | "unknown";
  pending_work_refs_json: string;
  scope_json: string;
  origin_json: string;
  policy_ref: string;
  policy_version: string;
  policy_hash: Hash;
  capability_snapshot_hash: Hash;
  budget_policy_ref: string;
  budget_policy_hash: Hash;
  authorization_ref: string | null;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  state: ReviewJobState;
  stage: ReviewJobStage;
  block_reason: ReviewJob["block_reason"] | null;
  backend_json: string;
  active_attempt_id: string | null;
  current_fencing_token: number;
  attempt_count: number;
  proposal_ids_json: string;
  handoff_id: string | null;
  handoff_body_ref: SourceRef | null;
  supersedes_job_id: string | null;
  superseded_by_job_id: string | null;
  supersession_depth: number;
  allowance_charge_json: string;
  provider_usage_json: string;
  last_error_json: string | null;
  retry_after_at: number | null;
  terminal_reason: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

interface ReviewAttemptRow {
  attempt_id: string;
  attempt_key: Hash;
  job_id: string;
  ordinal: number;
  state: ReviewAttemptState;
  backend_json: string;
  model_id: string;
  protocol_version: "rsi.generator_protocol/1";
  host_run_json: string;
  isolation_json: string;
  input_manifest_ref: SourceRef;
  input_manifest_hash: Hash;
  output_ref: SourceRef;
  output_hash: Hash | null;
  budget_json: string;
  deadline_at: number | null;
  lease_json: string | null;
  cancel_json: string;
  output_json: string | null;
  completion_evidence_ref: SourceRef | null;
  allowance_charge_json: string;
  provider_usage_json: string;
  generator_reported_usage_json: string | null;
  exit_json: string | null;
  last_error_json: string | null;
  started_at: number | null;
  ended_at: number | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

interface ProposalCandidateRow {
  candidate_key: Hash;
  job_id: string;
  attempt_id: string;
  ordinal: number;
  version_binding_json: string;
  output_ref: SourceRef;
  output_hash: Hash;
  candidate_ref: SourceRef;
  candidate_json_hash: Hash;
  generator_json: string;
  state: ProposalCandidateRecord["state"];
  failure_code: ProposalFailureCode | null;
  failure_step: import("./types.js").CandidateFailureStep | null;
  diagnostic_ref: SourceRef | null;
  proposal_id: string | null;
  proposal_hash: Hash | null;
  experience_id: string | null;
  experience_version: number | null;
  accepted_bundle_ref: SourceRef | null;
  row_version: number;
  created_at: number;
  checked_at: number | null;
}

interface ProposalRow {
  proposal_id: string;
  proposal_hash: Hash;
  job_id: string;
  attempt_id: string;
  ordinal: number;
  question_key: string | null;
  state: Proposal["state"];
  change_kind: Proposal["change_kind"];
  expected_file_hash: Hash | null;
  expected_block_hash: Hash | null;
  base_ref: SourceRef | null;
  create_policy: "must_not_exist" | null;
  candidate_hash: Hash;
  candidate_file_hash: Hash;
  candidate_block_hash: Hash | null;
  experience_type: ExperienceType;
  handoff_id: string | null;
  adoption_ref: string | null;
  stale_reason: string | null;
  created_at: number;
  updated_at: number;
  version: number;
  target_json: string;
  diff_json: string;
  experience_json: string;
  normalization_json: string;
  evidence_refs_json: string;
  egress_decision_ref: SourceRef | null;
  generator_json: string;
  static_check_json: string;
  match_judge_json: string;
}

interface ReviewHandoffRow {
  handoff_id: string;
  schema_version: "rsi.review_handoff/2";
  job_id: string;
  snapshot_id: string;
  snapshot_hash: Hash;
  policy_version: string;
  stage_results_json: string;
  proposals_json: string;
  job_result: ReviewHandoff["job_result"];
  handoff_hash: Hash;
  body_blob: SourceRef;
  created_at: number;
}

interface UsageVerificationRecordRow {
  usage_id: string;
  schema_version: "rsi.usage_verification/1";
  usage_key: Hash;
  projection_id: string;
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  version_binding_json: string;
  task_family_id: string;
  trigger_result: UsageVerificationRecord["trigger_result"];
  loading_json: string;
  behavior_json: string;
  verification_json: string;
  outcome_ref: SourceRef | null;
  other_change_refs_json: string;
  attribution: UsageVerificationRecord["attribution"];
  result: UsageVerificationRecord["result"];
  evidence_hash: Hash;
  causal_supported: 0;
  observed_at: number;
  window_index: number;
}

interface ExperienceLifecycleEventRow {
  event_id: string;
  schema_version: "rsi.experience_lifecycle_event/1";
  projection_id: string;
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  adoption_binding_hash: Hash;
  sequence: number;
  from_lifecycle: ProjectionLifecycle | null;
  to_lifecycle: ProjectionLifecycle;
  reason: ProjectionLifecycleReason;
  trigger_kind: ExperienceLifecycleEvent["trigger"]["kind"];
  trigger_ref: SourceRef | null;
  trigger_usage_ids_json: string;
  write_id: string;
  version_binding_json: string;
  projection_before_hash: Hash | null;
  projection_after_hash: Hash;
  projection_after_json: string;
  row_version_before: number;
  row_version_after: number;
  recorded_at: number;
  event_hash: Hash;
  event_blob: SourceRef;
}

interface ExperienceRow {
  experience_id: string;
  version: number;
  type: ExperienceType;
  title: string;
  summary: string;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  body_ref: SourceRef;
  risk: ExperienceRisk;
  content_hash: Hash;
  created_at: number;
  superseded_by_version: number | null;
  lineage_json: string;
  trigger_json: string;
  scope_json: string;
  preconditions_json: string;
  steps_json: string;
  expected_effects_json: string;
  completion_check_json: string;
  failure_branches_json: string;
  counterexamples_json: string;
  expiry_policy_json: string;
  evidence_refs_json: string;
}

export type ExperienceJournalRow = ExperienceRow;

export interface ExperienceProjectionRow {
  projection_id: string;
  schema_version: "rsi.experience_projection/2";
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  host_id: HostId;
  config_space: string;
  mode: HostMode;
  object_type: "skill" | "memory" | "instructions";
  path_or_block: string;
  block_id: string | null;
  write_id: Id<"wi">;
  adoption_binding_json: string;
  adoption_binding_hash: Hash;
  lifecycle: ProjectionLifecycle;
  lifecycle_reason: ProjectionLifecycleReason;
  checked_at: number;
  write_json: string;
  loading_evidence_json: string;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  verifier_json: string;
  no_verifier: 0 | 1;
  retention_rule_id: string;
  retention_json: string;
  baseline_json: string | null;
  usage_record_ids_json: string;
  restored_from_projection_id: string | null;
  superseded_by_projection_id: string | null;
  last_lifecycle_event_id: string;
  causal_supported: 0;
  row_version: number;
  created_at: number;
  updated_at: number;
}

export interface ReviewOutputAcceptanceRow {
  attempt_id: string;
  job_id: string;
  output_ref: SourceRef;
  output_hash: Hash;
  candidate_count: number;
  attempt_version_before: number;
  attempt_version_after: number;
  job_version_before: number;
  job_version_after: number;
  job_stage_after: "static_check";
  fencing_token: number;
  accepted_at: number;
  row_version: 1;
}

interface ValidationPlanRow {
  validation_plan_id: string;
  experience_id: string;
  experience_version: number;
  expected_behavior: string;
  plan_hash: Hash;
  created_at: number;
  source_requirement_refs_json: string;
  required_loading_evidence_json: string;
  verifier_json: string;
  observation_window_json: string;
  retention_rule_json: string;
  stop_conditions_json: string;
  replay_json: string;
}

/* ------------------------------------------------------------------ */
/* Row mappers                                                         */
/* ------------------------------------------------------------------ */

export function experienceRowFromExperience(experience: Experience): ExperienceRow {
  return {
    experience_id: experience.experience_id,
    version: experience.version,
    type: experience.type,
    title: experience.title,
    summary: experience.summary,
    validation_plan_id: experience.validation_plan_id,
    validation_plan_hash: experience.validation_plan_hash,
    body_ref: experience.body_ref,
    risk: experience.risk,
    content_hash: experience.content_hash,
    created_at: experience.created_at,
    superseded_by_version: experience.superseded_by_version ?? null,
    lineage_json: canonicalJsonText(toJsonValue(experience.lineage)),
    trigger_json: canonicalJsonText(toJsonValue(experience.trigger)),
    scope_json: canonicalJsonText(toJsonValue(experience.scope)),
    preconditions_json: canonicalJsonText(toJsonValue(experience.preconditions)),
    steps_json: canonicalJsonText(toJsonValue(experience.steps)),
    expected_effects_json: canonicalJsonText(toJsonValue(experience.expected_effects)),
    completion_check_json: canonicalJsonText(toJsonValue(experience.completion_check)),
    failure_branches_json: canonicalJsonText(toJsonValue(experience.failure_branches)),
    counterexamples_json: canonicalJsonText(toJsonValue(experience.counterexamples)),
    expiry_policy_json: canonicalJsonText(toJsonValue(experience.expiry_policy)),
    evidence_refs_json: canonicalJsonText(toJsonValue(experience.evidence_refs))
  };
}

export function projectionRowFromProjection(projection: ExperienceProjection): ExperienceProjectionRow {
  return {
    projection_id: projection.projection_id,
    schema_version: projection.schema_version,
    experience_id: projection.experience_id,
    experience_version: projection.experience_version,
    experience_content_hash: projection.experience_content_hash,
    host_id: projection.host_id,
    config_space: projection.config_space,
    mode: projection.mode,
    object_type: projection.object_type,
    path_or_block: projection.path_or_block,
    block_id: projection.block_id,
    write_id: projection.adoption_binding.write_id,
    adoption_binding_json: canonicalJsonText(toJsonValue(projection.adoption_binding)),
    adoption_binding_hash: projection.adoption_binding.binding_hash,
    lifecycle: projection.lifecycle,
    lifecycle_reason: projection.lifecycle_reason,
    checked_at: projection.checked_at,
    write_json: canonicalJsonText(toJsonValue(projection.write)),
    loading_evidence_json: canonicalJsonText(toJsonValue(projection.loading_evidence)),
    validation_plan_id: projection.validation_plan_id,
    validation_plan_hash: projection.validation_plan_hash,
    verifier_json: canonicalJsonText(toJsonValue(projection.verifier)),
    no_verifier: projection.no_verifier ? 1 : 0,
    retention_rule_id: projection.retention_rule_id,
    retention_json: canonicalJsonText(toJsonValue(projection.retention)),
    baseline_json: projection.baseline === null ? null : canonicalJsonText(toJsonValue(projection.baseline)),
    usage_record_ids_json: canonicalJsonText(toJsonValue(projection.usage_record_ids)),
    restored_from_projection_id: projection.restored_from_projection_id,
    superseded_by_projection_id: projection.superseded_by_projection_id,
    last_lifecycle_event_id: projection.last_lifecycle_event_id,
    causal_supported: 0,
    row_version: projection.row_version,
    created_at: projection.created_at,
    updated_at: projection.updated_at
  };
}

export function projectionFromRow(row: ExperienceProjectionRow): ExperienceProjection {
  const adoptionBinding = JSON.parse(row.adoption_binding_json) as AdoptionBinding;
  const baseline = row.baseline_json === null ? null : JSON.parse(row.baseline_json) as ExperienceProjection["baseline"];
  return {
    schema_version: row.schema_version,
    projection_id: row.projection_id,
    experience_id: row.experience_id,
    experience_version: row.experience_version,
    experience_content_hash: row.experience_content_hash,
    host_id: row.host_id,
    config_space: row.config_space,
    mode: row.mode,
    object_type: row.object_type,
    path_or_block: row.path_or_block,
    block_id: row.block_id,
    adoption_binding: adoptionBinding,
    lifecycle: row.lifecycle,
    lifecycle_reason: row.lifecycle_reason,
    checked_at: row.checked_at,
    write: JSON.parse(row.write_json) as ExperienceProjection["write"],
    loading_evidence: JSON.parse(row.loading_evidence_json) as ExperienceProjection["loading_evidence"],
    validation_plan_id: row.validation_plan_id,
    validation_plan_hash: row.validation_plan_hash,
    verifier: JSON.parse(row.verifier_json) as ExperienceProjection["verifier"],
    no_verifier: row.no_verifier === 1,
    retention_rule_id: row.retention_rule_id,
    retention: JSON.parse(row.retention_json) as ExperienceProjection["retention"],
    baseline,
    usage_record_ids: JSON.parse(row.usage_record_ids_json) as string[],
    restored_from_projection_id: row.restored_from_projection_id,
    superseded_by_projection_id: row.superseded_by_projection_id,
    last_lifecycle_event_id: row.last_lifecycle_event_id,
    causal_supported: false,
    row_version: row.row_version,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function lifecycleEventRowFromEvent(event: ExperienceLifecycleEvent, eventBlob: SourceRef): ExperienceLifecycleEventRow {
  return {
    event_id: event.event_id,
    schema_version: event.schema_version,
    projection_id: event.projection_id,
    experience_id: event.experience_id,
    experience_version: event.experience_version,
    experience_content_hash: event.experience_content_hash,
    adoption_binding_hash: event.adoption_binding_hash,
    sequence: event.sequence,
    from_lifecycle: event.from_lifecycle,
    to_lifecycle: event.to_lifecycle,
    reason: event.reason,
    trigger_kind: event.trigger.kind,
    trigger_ref: event.trigger.ref,
    trigger_usage_ids_json: canonicalJsonText(toJsonValue(event.trigger.usage_ids)),
    write_id: event.write_id,
    version_binding_json: canonicalJsonText(toJsonValue(event.version_binding)),
    projection_before_hash: event.projection_before_hash,
    projection_after_hash: event.projection_after_hash,
    projection_after_json: canonicalJsonText(toJsonValue(event.projection_after)),
    row_version_before: event.row_version_before,
    row_version_after: event.row_version_after,
    recorded_at: event.recorded_at,
    event_hash: event.event_hash,
    event_blob: eventBlob
  };
}

export function candidateRowFromRecord(
  record: ProposalCandidateRecord
): ProposalCandidateRow {
  return {
    candidate_key: record.candidate_key,
    job_id: record.job_id,
    attempt_id: record.attempt_id,
    ordinal: record.ordinal,
    version_binding_json: canonicalJsonText(toJsonValue(record.version_binding)),
    output_ref: record.output_ref,
    output_hash: record.output_hash,
    candidate_ref: record.candidate_ref,
    candidate_json_hash: record.candidate_json_hash,
    generator_json: canonicalJsonText(toJsonValue(record.generator)),
    state: record.state,
    failure_code: record.failure === null ? null : record.failure.code,
    failure_step: record.failure === null ? null : record.failure.step,
    diagnostic_ref: record.failure === null ? null : record.failure.detail_ref,
    proposal_id: record.proposal_id,
    proposal_hash: record.proposal_hash,
    experience_id: record.experience_id,
    experience_version: record.experience_version,
    accepted_bundle_ref: record.accepted_bundle_ref,
    row_version: record.row_version,
    created_at: record.created_at,
    checked_at: record.checked_at
  };
}

export function validationPlanRowFromPlan(plan: ValidationPlan): ValidationPlanRow {
  return {
    validation_plan_id: plan.validation_plan_id,
    experience_id: plan.experience_id,
    experience_version: plan.experience_version,
    expected_behavior: plan.expected_behavior,
    plan_hash: plan.plan_hash,
    created_at: plan.created_at,
    source_requirement_refs_json: canonicalJsonText(toJsonValue(plan.source_requirement_refs)),
    required_loading_evidence_json: canonicalJsonText(toJsonValue(plan.required_loading_evidence)),
    verifier_json: canonicalJsonText(toJsonValue(plan.verifier)),
    observation_window_json: canonicalJsonText(toJsonValue(plan.observation_window)),
    retention_rule_json: canonicalJsonText(toJsonValue(plan.retention_rule)),
    stop_conditions_json: canonicalJsonText(toJsonValue(plan.stop_conditions)),
    replay_json: canonicalJsonText(toJsonValue(plan.replay))
  };
}

export function acceptanceRowFromParts(input: {
  attempt: ReviewAttempt;
  job: ReviewJob;
  output_ref: SourceRef;
  output_hash: Hash;
  candidate_count: number;
  accepted_at: number;
}): ReviewOutputAcceptanceRow {
  return {
    attempt_id: input.attempt.attempt_id,
    job_id: input.job.job_id,
    output_ref: input.output_ref,
    output_hash: input.output_hash,
    candidate_count: input.candidate_count,
    attempt_version_before: input.attempt.row_version,
    attempt_version_after: input.attempt.row_version + 1,
    job_version_before: input.job.version,
    job_version_after: input.job.version + 1,
    job_stage_after: "static_check",
    fencing_token: input.job.current_fencing_token,
    accepted_at: input.accepted_at,
    row_version: 1
  };
}

/** `body_blob` holds the complete ReviewHandoff JCS including instance IDs. */
export function handoffRowFromHandoff(handoff: ReviewHandoff, body: SourceRef): ReviewHandoffRow {
  return {
    handoff_id: handoff.handoff_id,
    schema_version: handoff.schema_version,
    job_id: handoff.job_id,
    snapshot_id: handoff.snapshot_id,
    snapshot_hash: handoff.snapshot_hash,
    policy_version: handoff.policy_version,
    stage_results_json: canonicalJsonText(toJsonValue(handoff.stage_results)),
    proposals_json: canonicalJsonText(toJsonValue(handoff.proposals)),
    job_result: handoff.job_result,
    handoff_hash: handoff.handoff_hash,
    body_blob: body,
    created_at: handoff.created_at
  };
}

export function snapshotRowFromSnapshot(snapshot: ReviewSnapshot, body_blob: SourceRef): ReviewSnapshotRow {
  return {
    snapshot_id: snapshot.snapshot_id,
    schema_version: snapshot.schema_version,
    snapshot_key: snapshot.snapshot_key,
    snapshot_hash: snapshot.snapshot_hash,
    version_binding_json: canonicalJsonText(toJsonValue(snapshot.version_binding)),
    snapshot_scope: snapshot.snapshot_scope,
    task_id: snapshot.version_binding.task_id,
    branch_id: snapshot.version_binding.branch_id,
    input_epoch: snapshot.version_binding.input_epoch,
    goal_version: snapshot.version_binding.goal_version,
    config_version: snapshot.version_binding.config_version,
    watermark: snapshot.version_binding.watermark,
    host_id: snapshot.host_event.binding.host_id,
    config_space: snapshot.host_event.binding.config_space,
    mode: snapshot.host_event.binding.mode,
    trigger_event_id: snapshot.trigger.trigger_event_id,
    trigger_kind: snapshot.trigger.trigger_kind,
    review_kind: snapshot.trigger.review_kind,
    review_scope_key: snapshot.trigger.review_scope_key,
    boundary_key: snapshot.trigger.boundary_key,
    signal_digest: snapshot.trigger.signal_digest,
    trigger_dedupe_key: snapshot.trigger.trigger_dedupe_key,
    policy_version: snapshot.policy_version,
    authorization_ref: snapshot.authorization_ref ?? null,
    body_blob,
    created_at: snapshot.created_at
  };
}

export function jobRowFromJob(job: ReviewJob): ReviewJobRow {
  return {
    job_id: job.job_id,
    request_id: job.request_id,
    task_id: job.task_id,
    branch_id: job.branch_id,
    snapshot_id: job.snapshot_id,
    snapshot_hash: job.snapshot_hash,
    trigger_event_id: job.trigger_event_id,
    trigger_kind: job.trigger_kind,
    review_kind: job.review_kind,
    review_scope_key: job.review_scope_key,
    boundary_key: job.boundary_key,
    trigger_dedupe_key: job.trigger_dedupe_key,
    signal_digest: job.signal_digest,
    stable_event_ids_json: canonicalJsonText(toJsonValue(job.stable_event_ids)),
    stable_watermark: job.stable_watermark,
    stable: job.stable ? 1 : 0,
    stable_evidence_ref: job.stable_evidence_ref,
    pending_state: job.pending_state,
    pending_work_refs_json: canonicalJsonText(toJsonValue(job.pending_work_refs)),
    scope_json: canonicalJsonText(toJsonValue(job.scope)),
    origin_json: canonicalJsonText(toJsonValue(job.origin)),
    policy_ref: canonicalJsonText(toJsonValue(job.policy_ref)),
    policy_version: job.policy_version,
    policy_hash: job.policy_hash,
    capability_snapshot_hash: job.capability_snapshot_hash,
    budget_policy_ref: job.budget_policy_ref,
    budget_policy_hash: job.budget_policy_hash,
    authorization_ref: job.authorization_ref ?? null,
    input_epoch: job.input_epoch,
    goal_version: job.goal_version,
    config_version: job.config_version,
    state: job.state,
    stage: job.stage,
    block_reason: job.block_reason ?? null,
    backend_json: canonicalJsonText(toJsonValue(job.backend)),
    active_attempt_id: job.active_attempt_id ?? null,
    current_fencing_token: job.current_fencing_token,
    attempt_count: job.attempt_count,
    proposal_ids_json: canonicalJsonText(toJsonValue(job.proposal_ids)),
    handoff_id: job.handoff_id ?? null,
    handoff_body_ref: job.handoff_body_ref ?? null,
    supersedes_job_id: job.supersedes_job_id ?? null,
    superseded_by_job_id: job.superseded_by_job_id ?? null,
    supersession_depth: job.supersession_depth,
    allowance_charge_json: canonicalJsonText(toJsonValue(job.allowance_charge)),
    provider_usage_json: canonicalJsonText(toJsonValue(job.provider_usage)),
    last_error_json: job.last_error === undefined ? null : canonicalJsonText(toJsonValue(job.last_error)),
    retry_after_at: job.retry_after_at ?? null,
    terminal_reason: job.terminal_reason ?? null,
    version: job.version,
    created_at: job.created_at,
    updated_at: job.updated_at,
    terminal_at: job.terminal_at ?? null
  };
}

export function attemptRowFromAttempt(attempt: ReviewAttempt): ReviewAttemptRow {
  return {
    attempt_id: attempt.attempt_id,
    attempt_key: attempt.attempt_key,
    job_id: attempt.job_id,
    ordinal: attempt.ordinal,
    state: attempt.state,
    backend_json: canonicalJsonText(toJsonValue(attempt.backend)),
    model_id: attempt.model_id,
    protocol_version: attempt.protocol_version,
    host_run_json: canonicalJsonText(toJsonValue(attempt.host_run)),
    isolation_json: canonicalJsonText(toJsonValue(attempt.isolation)),
    input_manifest_ref: attempt.input_manifest_ref,
    input_manifest_hash: attempt.input_manifest_hash,
    output_ref: attempt.output_ref,
    output_hash: attempt.output?.hash ?? null,
    budget_json: canonicalJsonText(toJsonValue(attempt.budget)),
    deadline_at: attempt.deadline_at ?? null,
    lease_json: attempt.lease === undefined ? null : canonicalJsonText(toJsonValue(attempt.lease)),
    cancel_json: canonicalJsonText(toJsonValue(attempt.cancel)),
    output_json: attempt.output === undefined ? null : canonicalJsonText(toJsonValue(attempt.output)),
    completion_evidence_ref: attempt.completion_evidence_ref ?? null,
    allowance_charge_json: canonicalJsonText(toJsonValue(attempt.allowance_charge)),
    provider_usage_json: canonicalJsonText(toJsonValue(attempt.provider_usage)),
    generator_reported_usage_json:
      attempt.generator_reported_usage === undefined
        ? null
        : canonicalJsonText(toJsonValue(attempt.generator_reported_usage)),
    exit_json: attempt.exit === undefined ? null : canonicalJsonText(toJsonValue(attempt.exit)),
    last_error_json: attempt.last_error === undefined ? null : canonicalJsonText(toJsonValue(attempt.last_error)),
    started_at: attempt.started_at ?? null,
    ended_at: attempt.ended_at ?? null,
    row_version: attempt.row_version,
    created_at: attempt.created_at,
    updated_at: attempt.updated_at
  };
}

export function proposalRowFromProposal(proposal: Proposal): ProposalRow {
  return {
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    job_id: proposal.job_id,
    attempt_id: proposal.attempt_id,
    ordinal: proposal.ordinal,
    question_key: proposal.question_key,
    state: proposal.state,
    change_kind: proposal.change_kind,
    expected_file_hash: proposal.expected_file_hash,
    expected_block_hash: proposal.expected_block_hash,
    base_ref: proposal.base_ref ?? null,
    create_policy: proposal.create_policy,
    candidate_hash: proposal.candidate_hash,
    candidate_file_hash: proposal.candidate_file_hash,
    candidate_block_hash: proposal.candidate_block_hash,
    experience_type: proposal.experience_type,
    handoff_id: proposal.handoff_id ?? null,
    adoption_ref: proposal.adoption_ref ?? null,
    stale_reason: proposal.stale_reason ?? null,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    version: proposal.version,
    target_json: canonicalJsonText(toJsonValue(proposal.target)),
    diff_json: canonicalJsonText(toJsonValue(proposal.diff)),
    experience_json: canonicalJsonText(toJsonValue(proposal.experience)),
    normalization_json: canonicalJsonText(toJsonValue(proposal.normalization)),
    evidence_refs_json: canonicalJsonText(toJsonValue(proposal.evidence_refs)),
    egress_decision_ref: proposal.egress_decision_ref ?? null,
    generator_json: canonicalJsonText(toJsonValue(proposal.generator)),
    static_check_json: canonicalJsonText(toJsonValue(proposal.static_check)),
    match_judge_json: canonicalJsonText(toJsonValue(proposal.match_judge))
  };
}

export function usageRowFromRecord(record: UsageVerificationRecord): UsageVerificationRecordRow {
  return {
    usage_id: record.usage_id,
    schema_version: record.schema_version,
    usage_key: record.usage_key,
    projection_id: record.projection_id,
    experience_id: record.experience_id,
    experience_version: record.experience_version,
    experience_content_hash: record.experience_content_hash,
    validation_plan_id: record.validation_plan_id,
    validation_plan_hash: record.validation_plan_hash,
    version_binding_json: canonicalJsonText(toJsonValue(record.version_binding)),
    task_family_id: record.task_family_id,
    trigger_result: record.trigger_result,
    loading_json: canonicalJsonText(toJsonValue(record.loading)),
    behavior_json: canonicalJsonText(toJsonValue(record.behavior)),
    verification_json: canonicalJsonText(toJsonValue(record.verification)),
    outcome_ref: record.outcome_ref ?? null,
    other_change_refs_json: canonicalJsonText(toJsonValue(record.other_change_refs)),
    attribution: record.attribution,
    result: record.result,
    evidence_hash: record.evidence_hash,
    causal_supported: 0,
    observed_at: record.observed_at,
    window_index: record.window_index
  };
}
