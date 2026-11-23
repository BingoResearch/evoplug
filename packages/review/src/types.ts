/**
 * REV domain records (DD-REV-010, -020, -030, -050, -071, -090, -100,
 * -110, -120).
 *
 * These are the logical records. Physical row types live in `storage.ts` and
 * keep JSON text columns as strings. Shared primitives come from
 * `@evoplug/core`; HOST-owned shapes come from `host-contracts.ts`.
 */

import type { Hash, Id, JsonValue, SourceRef, VersionBinding } from "@evoplug/core";

import type { BudgetSettlementLike } from "./budget-contracts.js";

import type { GenerationBackendRef, GenerationCapabilityBinding, HostEventBinding, HostId, HostMode, PendingWorkRef, ReviewEnqueueRequest, ReviewTriggerKind, ServiceProfileLimits, SignalType, TriggerOrigin, TriggerPolicyRef, TriggerScope } from "./host-contracts.js";

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

export interface ReviewQuotaPolicy {
  schema_version: "rsi.review_quota_policy/1";
  budget_policy_ref: string;
  budget_policy_version: "bpol/1";
  budget_policy_hash: Hash;
  purpose: "review_generate";
  max_attempts: number;
  max_input_tokens: number;
  max_output_tokens: number;
  request_max_tokens: number;
  question_max_tokens: number;
  request_margin_tokens: number;
  question_margin_tokens: number;
  max_cost_micros: number | null;
  wall_ms: number;
  reserve_ms: number;
  min_work_ms: number;
  attempt_charge_at: "claim";
  attempt_refundable: false;
  quota_policy_hash: Hash;
}

export interface ReviewOutputPolicyRef {
  schema_version: "rsi.review_output_policy_ref/1";
  output_policy_id: "rsi.review_output/default";
  owner: "rev";
  max_proposals: number;
  max_progress_events: number;
  max_output_bytes: number;
  max_output_line_bytes: number;
  max_output_lines: number;
  output_policy_hash: Hash;
}

export type ReviewOutputPolicyParams = Omit<
  ReviewOutputPolicyRef,
  "schema_version" | "output_policy_id" | "owner" | "output_policy_hash"
>;

export interface ReviewOutputPolicySource {
  load(): ReviewOutputPolicyRef;
}

export type ReviewEnqueueGate = "V9b" | "V13" | "V13e";

export interface DeferredReviewEnqueueError {
  schema_version: "rsi.deferred_review_enqueue_error/1";
  gate: ReviewEnqueueGate;
  order: number;
  error: import("@evoplug/core").ErrorEnvelope;
  recovery: "reprepare" | "none";
}

export interface ReviewExperienceCandidate {
  schema_version: "rsi.review_experience_candidate/1";
  experience_id: string;
  version: number;
  content_hash: Hash;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  type: ExperienceType;
  risk: ExperienceRisk;
  scope: ExperienceScope;
  scope_rank: 1 | 2 | 3 | 4;
  source_ref: SourceRef;
  created_at: number;
  expires_at: number | null;
  /** Appendix Q.3: human name/description visible to the generator. */
  name?: string;
  description?: string;
}

export interface ExperienceCandidateQuery {
  schema_version: "rsi.experience_candidate_query/1";
  version_binding: VersionBinding;
  host_binding: HostEventBinding;
  project_id: string | null;
  now: number;
  limit: 32;
}

export interface ExperienceCandidatePage {
  schema_version: "rsi.experience_candidate_page/1";
  query_hash: Hash;
  candidates: ReviewExperienceCandidate[];
  truncated: boolean;
}

export interface ReviewSourceBinding {
  schema_version: "rsi.review_source_binding/1";
  gate: "V9b" | "V13";
  source_kind: "evidence" | "experience";
  ref: SourceRef;
  retrievable: boolean;
  content_version: Hash | null;
  range_content_hash: Hash | null;
  source_metadata_digest: Hash;
}

export interface ReviewSourceFactQuery {
  schema_version: "rsi.review_source_fact_query/1";
  gate: "V9b" | "V13";
  refs: SourceRef[];
  deadline_at: number;
  max_bytes_per_ref: number;
}

export interface ReviewSourceFactPage {
  schema_version: "rsi.review_source_fact_page/1";
  query_hash: Hash;
  facts: ReviewSourceBinding[];
}

export interface ReviewSourceMetadataBase {
  schema_version: "rsi.review_source_metadata/1";
  ref: SourceRef;
  locator_kind: "journal" | "blob";
  content_ref: string | null;
  content_hash: Hash | null;
  byte_length: number | null;
  storage_state: "present" | "deleted" | "tombstoned" | "missing";
  producer: "rev.review_source_metadata";
}

interface ReviewSourceMetadata extends ReviewSourceMetadataBase {
  metadata_digest: Hash;
}

export interface ReviewSourceMetadataCheck {
  schema_version: "rsi.review_source_metadata_check/1";
  query_hash: Hash;
  refs: ReviewSourceMetadata[];
}

export interface ReviewSnapshotSourcePlan {
  schema_version: "rsi.review_snapshot_source_plan/1";
  version_binding: VersionBinding;
  requirements: Array<{
    requirement_id: Id<"req">;
    version: number;
    quote_ref: SourceRef;
  }>;
  issues: Array<{
    issue_id: Id;
    issue_version: number;
    question_ref: SourceRef;
  }>;
  user_correction_refs: SourceRef[];
  verification_refs: SourceRef[];
  artifacts: Array<{
    artifact_id: string;
    version: string;
    content_hash: Hash;
    source_ref: SourceRef;
  }>;
  outcome_ref: SourceRef | null;
  stable_evidence_ref: SourceRef;
  missing_evidence_refs: SourceRef[];
  missing_requirement_ids: string[];
  evidence_refs: SourceRef[];
  source_plan_hash: Hash;
}

export interface ReviewSnapshotSourceQuery {
  schema_version: "rsi.review_snapshot_source_query/1";
  request: ReviewEnqueueRequest;
  trigger: import("./host-contracts.js").TriggerEvent;
  now: number;
}

export interface TriggerEnqueueBinding {
  schema_version: "rsi.trigger_enqueue_binding/1";
  trigger_event_id: Id<"trg">;
  trigger_kind: import("./host-contracts.js").TriggerKind;
  source_event_ref: SourceRef;
  raw_event_ref: SourceRef;
  local_input_id: Id<"input"> | null;
  host_binding: HostEventBinding;
  policy_ref: TriggerPolicyRef;
  origin: TriggerOrigin;
  request_intent: "automatic" | "explicit_review";
  scope: TriggerScope;
  identity_quality: "strong" | "weak" | "missing";
  signals: import("./host-contracts.js").VerifiedSignal[];
  boundary: import("./host-contracts.js").StableBoundaryEvidence;
  stable_evidence_ref: SourceRef | null;
  review_scope_key: Hash;
  capability_gate: import("./host-contracts.js").CapabilityGateResult[];
  dedupe: import("./host-contracts.js").TriggerDedupe;
  decision: "enqueue";
  decision_reason: import("./host-contracts.js").TriggerReasonCode;
  policy_snapshot_ref: SourceRef;
  authorization_ref: Id<"grant"> | null;
  decision_version: 1;
  decided_at: number;
  evidence_refs: string[];
}

export interface PrepareReviewEnqueueInput {
  schema_version: "rsi.prepare_review_enqueue_in/1";
  req: ReviewEnqueueRequest;
  trigger: import("./host-contracts.js").TriggerEvent;
}

type ReviewEnqueuePreflight =
  | "new"
  | "existing_request"
  | "existing_dedupe"
  | "preflight_unavailable"
  | "not_prepared";

export const PREPARED_REVIEW_ENQUEUE_BRAND: unique symbol = Symbol("evoplug.review.prepared_enqueue");

export interface PreparedReviewEnqueue {
  readonly [PREPARED_REVIEW_ENQUEUE_BRAND]: true;
  readonly schema_version: "rsi.review_enqueue_prepared/1";
  readonly request_id: string | null;
  readonly request_hash: Hash | null;
  readonly trigger_event_id: Id<"trg"> | null;
  readonly trigger_binding_hash: Hash | null;
  readonly trigger_dedupe_key: Hash | null;
  readonly preflight: ReviewEnqueuePreflight;
  readonly existing: {
    readonly request_id: string;
    readonly request_hash: Hash;
    readonly review_job_id: Id<"job"> | null;
  } | null;
  readonly source_plan: ReviewSnapshotSourcePlan | null;
  readonly experience_candidates: readonly ReviewExperienceCandidate[] | null;
  readonly experience_candidate_query_hash: Hash | null;
  readonly experience_candidates_truncated: boolean | null;
  readonly evidence_refs: readonly SourceRef[] | null;
  readonly experience_refs: readonly SourceRef[] | null;
  readonly source_bindings: readonly ReviewSourceBinding[] | null;
  readonly source_fact_queries: {
    readonly v9b: Hash;
    readonly v13: Hash;
  } | null;
  readonly egress_input: import("./egress-contracts.js").EgressApprovedSourcesInput | null;
  readonly egress_prepared: import("./egress-contracts.js").EgressApprovedSourcesPrepared | null;
  readonly deferred: readonly DeferredReviewEnqueueError[];
}

export interface ReviewSnapshot {
  schema_version: "rsi.review_snapshot/1";
  snapshot_id: Id<"snap">;
  snapshot_key: Hash;
  version_binding: VersionBinding;
  snapshot_scope: "stable_boundary" | "explicit_stage" | "superseded_retry";
  trigger: {
    trigger_event_id: Id<"trg">;
    trigger_kind: ReviewTriggerKind;
    origin: TriggerOrigin;
    review_kind: "auto" | "explicit";
    signal_kinds: SignalType[];
    stable_event_ids: string[];
    review_scope_key: Hash;
    boundary_key: Hash;
    signal_digest: Hash;
    trigger_dedupe_key: Hash;
    policy_ref: TriggerPolicyRef;
    policy_hash: Hash;
    capability_snapshot_hash: Hash;
  };
  host_event: {
    binding: HostEventBinding;
    source_event_ref: SourceRef;
    raw_event_ref: SourceRef;
  };
  boundary: {
    stable: boolean;
    boundary_kind: "host_stable_event" | "exit" | "user_selected" | "none";
    stable_watermark: number;
    goal_version: string;
    pending_state: "none" | "pending" | "unknown";
    pending_work_refs: PendingWorkRef[];
    completeness: "complete" | "staged_with_gaps";
    missing_evidence_refs: SourceRef[];
    stable_evidence_ref: SourceRef;
  };
  outcome_ref: SourceRef;
  requirements: Array<{
    requirement_id: Id<"req">;
    version: number;
    quote_ref: SourceRef;
  }>;
  issues: Array<{
    issue_id: Id;
    issue_version: number;
    question_ref: SourceRef;
  }>;
  user_correction_refs: SourceRef[];
  verification_refs: SourceRef[];
  artifacts: Array<{
    artifact_id: string;
    version: string;
    content_hash: Hash;
    source_ref: SourceRef;
  }>;
  evidence_refs: SourceRef[];
  experience_candidates: ReviewExperienceCandidate[];
  experience_refs: SourceRef[];
  experience_candidate_query: {
    query_hash: Hash;
    limit: 32;
    truncated: boolean;
  };
  source_bindings: ReviewSourceBinding[];
  source_fact_queries: {
    v9b: Hash;
    v13: Hash;
  };
  coverage: {
    included: Array<
      | "requirements"
      | "issues"
      | "user_corrections"
      | "verifications"
      | "artifacts"
      | "outcome"
      | "experience_candidates"
    >;
    omitted_refs: SourceRef[];
    missing_requirement_ids: string[];
    egress_policy_ref: string;
    egress_policy_version: string;
    egress_approved_refs: SourceRef[];
    egress_approved_experience_refs: SourceRef[];
    /** Appendix D: provenance, receiver and omission audit. */
    egress_audit?: import("./egress-contracts.js").EgressAudit;
  };
  policy_version: string;
  policy_snapshot_ref: SourceRef;
  authorization_ref?: Id<"grant">;
  permission_scope_ref: string;
  budget: ReviewQuotaPolicy;
  output_policy: ReviewOutputPolicyRef;
  snapshot_hash: Hash;
  created_at: number;
}

export type SnapshotStaleReason =
  | "target_changed"
  | "config_changed"
  | "source_missing"
  | "policy_unsupported"
  | "superseded";

export interface SnapshotValidity {
  valid: boolean;
  stale_reason: SnapshotStaleReason | null;
  block_reason: "egress_not_approved" | null;
}

/* ------------------------------------------------------------------ */
/* Job                                                                 */
/* ------------------------------------------------------------------ */

export type ReviewJobState =
  | "queued"
  | "blocked_no_backend"
  | "generating"
  | "proposed"
  | "stale"
  | "done"
  | "failed"
  | "cancelled";

export type ReviewJobStage =
  | "snapshot"
  | "generate"
  | "static_check"
  | "experience_match_judge"
  | "handoff"
  | "closed";

type ReviewBlockReason =
  | "no_approved_backend"
  | "capability_unknown"
  | "capability_unsupported"
  | "capability_failed"
  | "budget_unavailable"
  | "isolation_unsupported"
  | "egress_not_approved";

interface ReviewJobBackend {
  selection_ref?: SourceRef;
  backend_id?: string;
  backend_kind?: GenerationBackendRef["backend_kind"];
  capability_snapshot_hash?: Hash;
  service_profile?: {
    service_profile_id: string;
    service_profile_key: Hash;
    provider_scope: string;
    limits: ServiceProfileLimits;
    evidence_ref: SourceRef;
  };
  /** Exactly the HOST `blocked_no_backend` `missing` bindings. */
  missing_capabilities: GenerationCapabilityBinding[];
  cancellation: "verified" | "blocked";
  recovery: "verified" | "blocked";
  resume_kind?: string;
}

export interface ReviewJobAllowanceCharge {
  reservation_ids: Id<"resv">[];
  charge_ids: Id<"chg">[];
  attempts: number;
  input_tokens_charged: number | null;
  output_tokens_charged: number | null;
  cost_micros_charged: number | null;
  unknown_usage: boolean;
  overage: boolean;
}

export interface ReviewJobProviderUsage {
  usage_refs: SourceRef[];
  reported_attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  cost_status: "known" | "unknown" | "not_applicable";
  sources: Array<"provider_receipt" | "host_reported">;
}

interface ReviewJobError {
  /**
   * Envelope code when the failure came from an ErrorEnvelope. Budget
   * `limits_unknown` is a REV terminal reason, not an envelope code, so that
   * path writes `reason_code`/`stage`/`message` without inventing `code`.
   */
  code?: string;
  reason_code?: string;
  stage?: string;
  message?: string;
  attempt_id?: Id<"rat">;
  detail_ref?: SourceRef;
}

export interface ReviewJob {
  schema_version: "rsi.review_job/2";
  job_id: Id<"job">;
  request_id: string;
  task_id: Id<"task">;
  branch_id: Id<"br">;
  snapshot_id: Id<"snap">;
  snapshot_hash: Hash;
  trigger_event_id: Id<"trg">;
  trigger_kind: ReviewTriggerKind;
  review_kind: "auto" | "explicit";
  review_scope_key: Hash;
  boundary_key: Hash;
  trigger_dedupe_key: Hash;
  signal_digest: Hash;
  stable_event_ids: string[];
  stable_watermark: number;
  stable: boolean;
  stable_evidence_ref: SourceRef;
  pending_state: "none" | "pending" | "unknown";
  pending_work_refs: PendingWorkRef[];
  scope: TriggerScope;
  origin: TriggerOrigin;
  policy_ref: TriggerPolicyRef;
  policy_version: string;
  policy_hash: Hash;
  capability_snapshot_hash: Hash;
  budget_policy_ref: string;
  budget_policy_hash: Hash;
  authorization_ref?: Id<"grant">;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  state: ReviewJobState;
  stage: ReviewJobStage;
  block_reason?: ReviewBlockReason;
  backend: ReviewJobBackend;
  active_attempt_id?: Id<"rat">;
  current_fencing_token: number;
  attempt_count: number;
  proposal_ids: Id<"prop">[];
  handoff_id?: Id<"hand">;
  handoff_body_ref?: SourceRef;
  supersedes_job_id?: Id<"job">;
  superseded_by_job_id?: Id<"job">;
  supersession_depth: number;
  allowance_charge: ReviewJobAllowanceCharge;
  provider_usage: ReviewJobProviderUsage;
  last_error?: ReviewJobError;
  retry_after_at?: number;
  terminal_reason?: string;
  version: number;
  created_at: number;
  updated_at: number;
  terminal_at?: number;
}

export type ReviewJobResult = "proposed" | "no_candidate" | "all_rejected" | "all_stale";

/* ------------------------------------------------------------------ */
/* Attempt                                                             */
/* ------------------------------------------------------------------ */

export type ReviewAttemptState =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export interface ReviewAttemptLease {
  lease_id: string;
  owner_id: string;
  fencing_token: number;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  process_ref?: { pid: number; start_token: string; pgid?: number };
}

export interface ReviewAttemptBudget {
  reservation_id?: Id<"resv">;
  attempt_charge_id?: Id<"chg">;
  state: "unclaimed" | "claimed" | "settled" | "unsettled" | "released";
  input_tokens_estimated: number;
  output_tokens_reserved: number;
  wall_ms_reserved: number;
  settlement?: BudgetSettlementLike;
}

export interface ReviewAttempt {
  schema_version: "rsi.review_attempt/1";
  attempt_id: Id<"rat">;
  attempt_key: Hash;
  job_id: Id<"job">;
  ordinal: number;
  state: ReviewAttemptState;
  backend: GenerationBackendRef;
  model_id: string;
  protocol_version: "rsi.generator_protocol/1";
  host_run: {
    generation_run_id: string;
    handle_ref?: string;
    host_session_ref?: string;
    child_session_ref?: string;
    backend_selection_ref: SourceRef;
    resume_kind?: string;
    recover_evidence_ref?: SourceRef;
  };
  isolation: {
    workspace_ref: string;
    workspace_mode: "isolated" | "none";
    workspace_probe_ref: SourceRef;
    environment_hash: Hash;
    network_decision_ref: SourceRef;
    process_group_ref?: string;
    logs_ref?: SourceRef;
    isolation_evidence_ref: SourceRef;
  };
  input_manifest_ref: SourceRef;
  input_manifest_hash: Hash;
  output_ref: SourceRef;
  budget: ReviewAttemptBudget;
  deadline_at?: number;
  lease?: ReviewAttemptLease;
  cancel: {
    requested_at?: number;
    ack_at?: number;
    mode?: "cooperative" | "terminate";
    force_killed_at?: number;
  };
  output?: {
    ref: SourceRef;
    hash: Hash;
    bytes: number;
    lines: number;
    proposal_count: number;
    schema_valid: boolean | "unknown";
    read_cursor?: string;
    accepted_at: number;
  };
  completion_evidence_ref?: SourceRef;
  allowance_charge: {
    charge_ids: Id<"chg">[];
    input_token_charges: number | null;
    output_token_charges: number | null;
    cost_charges_micros: number | null;
    overage: boolean;
  };
  provider_usage: {
    usage_refs: SourceRef[];
    input_tokens: number | null;
    output_tokens: number | null;
    cost_micros: number | null;
    cost_status: "known" | "unknown" | "not_applicable";
    source: "provider_receipt" | "host_reported" | "none";
    reported_at?: number;
  };
  generator_reported_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_micros?: number;
    ref: SourceRef;
  };
  exit?: {
    code?: number;
    signal?: string;
    at: number;
    reason: "completed" | "failed" | "cancelled" | "lease_lost" | "timeout" | "output_invalid";
  };
  last_error?: {
    code?: string;
    reason_code?: string;
    stage?: string;
    message?: string;
    line?: number;
    detail_ref?: SourceRef;
  };
  started_at?: number;
  ended_at?: number;
  row_version: number;
  created_at: number;
  updated_at: number;
}

/* ------------------------------------------------------------------ */
/* Proposal, candidate, Experience and ValidationPlan                  */
/* ------------------------------------------------------------------ */

export type ExperienceType =
  | "recovery_procedure"
  | "tool_workflow"
  | "project_constraint"
  | "user_preference"
  | "validation_check";

export type ExperienceRisk = "low" | "medium" | "high";

export interface ExperienceScope {
  level: "project" | "user" | "host" | "global";
  project_ids: string[];
  host_ids: HostId[];
  modes: string[];
  environment_fingerprints: string[];
  tool_version_ranges: Array<{ tool: string; range: string }>;
  model_families: string[];
}

export interface ExperienceExpiryPolicy {
  max_age_ms?: number;
  invalidate_on_host_version_change: boolean;
  invalidate_on_tool_version_change: boolean;
  invalidate_on_model_family_change: boolean;
}

export interface Experience {
  schema_version: "rsi.experience/1";
  experience_id: string;
  version: number;
  lineage: {
    kind: "create" | "refine" | "restore";
    predecessor_version?: number;
    restored_from_version?: number;
    source_job_id: string;
    source_proposal_id: string;
    source_snapshot_id: string;
  };
  type: ExperienceType;
  title: string;
  summary: string;
  trigger: {
    description: string;
    signal_kinds: Array<
      "user_correction" | "repeated_failure" | "recovery_success" | "task_boundary" | "manual"
    >;
    task_family_ids: string[];
    tool_names: string[];
    path_patterns: string[];
    negative_triggers: string[];
  };
  scope: ExperienceScope;
  preconditions: Array<{
    precondition_id: string;
    statement: string;
    check_kind: "path_exists" | "tool_available" | "version_in_range" | "evidence_ref" | "human_confirm";
    check_params_ref?: SourceRef;
  }>;
  steps: Array<{
    step_id: string;
    action: string;
    inputs: string[];
    expected_observation: string;
    failure_branch?: string;
  }>;
  expected_effects: string[];
  completion_check: {
    kind: "test_pass" | "artifact_check" | "state_predicate" | "human_acceptance" | "external_verification" | "none";
    description: string;
  };
  failure_branches: Array<{
    condition: string;
    recovery: string;
    stop_if?: string;
  }>;
  counterexamples: Array<{
    counterexample_id: string;
    condition: string;
    observed_failure: string;
    source_ref: SourceRef;
  }>;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  body_ref: SourceRef;
  risk: ExperienceRisk;
  expiry_policy: ExperienceExpiryPolicy;
  evidence_refs: SourceRef[];
  content_hash: Hash;
  created_at: number;
  superseded_by_version?: number;
}

export interface ExperienceCandidate extends Omit<
  Experience,
  | "experience_id"
  | "version"
  | "lineage"
  | "scope"
  | "risk"
  | "validation_plan_id"
  | "validation_plan_hash"
  | "content_hash"
  | "created_at"
  | "superseded_by_version"
  | "body_ref"
> {
  type: ExperienceType;
}

export interface ValidationPlan {
  schema_version: "rsi.validation_plan/1";
  validation_plan_id: string;
  experience_id: string;
  experience_version: number;
  source_requirement_refs: Array<{
    requirement_id: string;
    version: number;
    source_ref: SourceRef;
  }>;
  expected_behavior: string;
  required_loading_evidence: Array<"written" | "discovered" | "included" | "observed">;
  verifier: {
    kind:
      | "test_pass"
      | "artifact_check"
      | "state_predicate"
      | "human_acceptance"
      | "external_verification"
      | "none";
    verifier_ref?: SourceRef;
    binding_ref?: SourceRef;
    description: string;
    independence: "independent" | "same_task_replay" | "user_confirmation" | "none";
  };
  observation_window: {
    window_ms: number;
    min_triggered_uses: number;
    max_triggered_uses: number;
    max_extensions: number;
  };
  retention_rule: {
    rule_id: string;
    kind: "deterministic_check" | "preference_confirmation" | "constraint_recheck" | "workflow_evidence";
    min_independent_passes: number;
    required_verifier_kinds: string[];
    max_age_ms: number;
  };
  stop_conditions: Array<
    "confirmed_regression" | "user_revocation" | "expiry" | "conflict" | "host_incompatible" | "budget_exceeded"
  >;
  replay: {
    requirement: "none" | "optional" | "required";
    allowed_classes: Array<"read_only" | "sandboxed_temp">;
    live_external_policy: "observe_only" | "explicit_approval";
  };
  plan_hash: Hash;
  created_at: number;
}

export interface ValidationPlanCandidate {
  schema_version: "rsi.validation_plan_candidate/1";
  expected_behavior: string;
  required_loading_evidence: Array<"written" | "discovered" | "included" | "observed">;
  verifier: {
    verifier_ref?: SourceRef;
    description: string;
  };
  observation_window: ValidationPlan["observation_window"];
  retention_rule: ValidationPlan["retention_rule"];
  stop_conditions: ValidationPlan["stop_conditions"];
  replay: ValidationPlan["replay"];
}

interface ProposalCandidateTarget {
  target_ref: string;
  host_id: HostId;
  project_id?: string;
  path_or_block: string;
  block_id?: string;
  requested_write_mode: "whole_file" | "managed_block";
}

export interface ProposalCandidate {
  schema_version: "rsi.proposal_candidate/1";
  change_kind: "create" | "update" | "disable" | "rollback";
  object_type: "skill" | "memory" | "instructions";
  target: ProposalCandidateTarget;
  expected_old_file_hash?: Hash;
  expected_old_block_hash?: Hash;
  diff_format: "unified_diff" | "managed_block_patch" | "json_merge_patch";
  diff_text: string;
  /** Optional self-report; S3c recomputes and never trusts it. */
  candidate_hash?: Hash;
  experience: ExperienceCandidate;
  validation_plan: ValidationPlanCandidate;
  evidence_refs: SourceRef[];
  refines_experience_ref?: SourceRef;
}

export type CandidateFailureStep =
  | "P0a"
  | "P0b"
  | "P0c"
  | "S0a"
  | "S0b"
  | "S0c"
  | "S1a"
  | "S1b"
  | "S2a"
  | "S2b"
  | "S3a"
  | "S3b"
  | "S3c"
  | "S4"
  | "S5"
  | "S6"
  | "S7a"
  | "S7b"
  | "S8"
  | "S9";

export type ProposalFailureCode =
  | "E_PROPOSAL_DIFF_TOO_LARGE"
  | "E_EXPERIENCE_TOO_LARGE"
  | "E_PROPOSAL_UNTRUSTED_FIELD"
  | "E_PROPOSAL_SCHEMA"
  | "E_EXPERIENCE_SCHEMA"
  | "E_PROPOSAL_TARGET"
  | "E_PROPOSAL_OLD_HASH_MISSING"
  | "E_PROPOSAL_OLD_HASH_MISMATCH"
  | "E_PROPOSAL_DIFF_MISMATCH"
  | "E_PROPOSAL_DIFF_APPLY"
  | "E_PROPOSAL_EVIDENCE_NOT_ALLOWED"
  | "E_PROPOSAL_SCOPE"
  | "E_PROPOSAL_PROTECTED_FIELD"
  | "E_EXPERIENCE_PLAN_SOURCE_CHANGED"
  | "E_EXPERIENCE_VERIFIER_BINDING"
  | "E_PROPOSAL_NO_CHANGE"
  | "E_PROPOSAL_STALE_TARGET";

export interface ProposalCandidateRecord {
  schema_version: "rsi.proposal_candidate_record/1";
  candidate_key: Hash;
  job_id: Id<"job">;
  attempt_id: Id<"rat">;
  ordinal: number;
  version_binding: VersionBinding;
  output_ref: SourceRef;
  output_hash: Hash;
  candidate_ref: SourceRef;
  candidate_json_hash: Hash;
  generator: ProposalGenerator;
  state: "pending" | "accepted" | "rejected" | "stale";
  failure: {
    code: ProposalFailureCode;
    step: CandidateFailureStep;
    detail_ref: SourceRef;
  } | null;
  proposal_id: Id<"prop"> | null;
  proposal_hash: Hash | null;
  experience_id: Id<"exp"> | null;
  experience_version: number | null;
  accepted_bundle_ref: SourceRef | null;
  row_version: number;
  created_at: number;
  checked_at: number | null;
}

export interface ProposalGenerator {
  backend_id: string;
  model_id: string;
  protocol_version: "rsi.generator_protocol/1";
  generator_version: string;
}

export interface ProposalTarget {
  target_ref: string;
  object_type: "skill" | "memory" | "instructions";
  host_id: HostId;
  project_id?: string;
  config_space: string;
  mode: HostMode;
  path_or_block: string;
  block_id?: string;
  ownership: "native_managed" | "rsi_managed" | "shared_handwritten";
  write_mode: "whole_file" | "managed_block";
  block_selector: string | null;
  approved_root: string;
  target_binding_ref: SourceRef;
}

interface ProposalExperience {
  experience_id: string;
  version: number;
  content_hash: Hash;
  body_ref: SourceRef;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  risk: ExperienceRisk;
  scope: ExperienceScope;
  verifier: {
    kind: ValidationPlan["verifier"]["kind"];
    independence: ValidationPlan["verifier"]["independence"];
    binding_ref?: SourceRef;
  };
  no_verifier: boolean;
}

interface ProposalNormalization {
  candidate_ref: SourceRef;
  allocation: "created" | "refined" | "restored";
  refines_experience_id?: string;
  refines_version?: number;
  risk_policy_ref: SourceRef;
  scope_source_ref: SourceRef;
  normalized_at: number;
}

export type MatchJudgeStatus =
  | "not_required"
  | "pending"
  | "accepted"
  | "degraded"
  | "rejected"
  | "unknown"
  | "reused";

export interface ProposalMatchJudge {
  status: MatchJudgeStatus;
  route_id: string | null;
  route_hash: Hash | null;
  route_class: "experience_match" | null;
  issue_id?: string;
  plan_id?: string;
  plan_hash?: Hash;
  invocation_id?: string;
  attempt_id?: string;
  envelope_id?: string;
  envelope_key?: Hash;
  request_hash?: Hash;
  dispatch_key?: Hash;
  service_profile_id?: string;
  validator_binding_id?: string;
  validator_binding_key?: Hash;
  question_bindings_digest?: Hash;
  binding_id?: string;
  validator_version?: string;
  egress_decision_ref?: SourceRef;
  template_id: "qt.experience_match";
  template_version: "1.0.0";
  template_hash: Hash;
  match_outcome?: "applicable" | "conflict" | "unknown" | "not_applicable";
}

export interface Proposal {
  schema_version: "rsi.proposal/2";
  proposal_id: string;
  proposal_hash: Hash;
  job_id: string;
  attempt_id: string;
  ordinal: number;
  question_key: string | null;
  state: "checked" | "unverified" | "proposed" | "stale" | "withdrawn" | "adopted";
  change_kind: "create" | "update" | "disable" | "rollback";
  target: ProposalTarget;
  expected_file_hash: Hash | null;
  expected_block_hash: Hash | null;
  base_ref?: SourceRef;
  create_policy: "must_not_exist" | null;
  candidate_hash: Hash;
  candidate_file_hash: Hash;
  candidate_block_hash: Hash | null;
  diff: {
    format: "unified_diff" | "managed_block_patch" | "json_merge_patch";
    ref: SourceRef;
    hash: Hash;
    applies_to_hash: Hash;
  };
  experience: ProposalExperience;
  normalization: ProposalNormalization;
  experience_type: ExperienceType;
  evidence_refs: SourceRef[];
  egress_decision_ref?: SourceRef;
  generator: ProposalGenerator;
  static_check: {
    status: "passed";
    errors: string[];
    checked_at: number;
  };
  match_judge: ProposalMatchJudge;
  handoff_id?: string;
  adoption_ref?: string;
  stale_reason?: string;
  created_at: number;
  updated_at: number;
  version: number;
}

/* ------------------------------------------------------------------ */
/* Handoff                                                             */
/* ------------------------------------------------------------------ */

export interface ReviewHandoffStageResult {
  stage: "snapshot" | "generate" | "static_check" | "experience_match_judge" | "handoff";
  status: "ok" | "degraded" | "failed" | "skipped";
  reason_code?: string;
  detail_ref?: SourceRef;
}

interface ReviewHandoffJudge {
  issue_id: string;
  plan_id: string;
  plan_hash: Hash;
  service_profile_id: string;
  validator_binding_id: string;
  validator_binding_key?: Hash;
  question_bindings_digest?: Hash;
  binding_id?: string;
  template_id: "qt.experience_match";
  template_version: "1.0.0";
  template_hash: Hash;
  invocation_id?: string;
  attempt_id?: string;
  envelope_id?: string;
  envelope_key?: Hash;
  request_hash?: Hash;
  dispatch_key?: Hash;
  validator_version?: string;
  match_outcome?: "applicable" | "conflict" | "unknown" | "not_applicable";
  egress_decision_ref?: SourceRef;
}

export interface ReviewHandoffProposal {
  proposal_id: string;
  proposal_hash: Hash;
  question_key: string | null;
  route_id: string | null;
  route_hash: Hash | null;
  route_class: "experience_match" | null;
  candidate_hash: Hash;
  candidate_file_hash: Hash;
  candidate_block_hash: Hash | null;
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  validation_plan_hash: Hash;
  decision: "proceed" | "unverified";
  reason_code?: string;
  auto_adopt_eligible: boolean;
  risk: ExperienceRisk;
  scope_level: ExperienceScope["level"];
  no_verifier: boolean;
  verifier: {
    kind: ValidationPlan["verifier"]["kind"];
    independence: ValidationPlan["verifier"]["independence"];
    binding_ref?: SourceRef;
  };
  egress_decision_ref?: SourceRef;
  judge?: ReviewHandoffJudge;
}

export interface ReviewHandoff {
  schema_version: "rsi.review_handoff/2";
  handoff_id: string;
  job_id: string;
  snapshot_id: string;
  snapshot_hash: Hash;
  policy_version: string;
  stage_results: ReviewHandoffStageResult[];
  proposals: ReviewHandoffProposal[];
  job_result: ReviewJobResult;
  handoff_hash: Hash;
  created_at: number;
}

export interface ReviewHandoffClosePayload {
  handoff_id: string;
  handoff_hash: Hash;
  proposal_id: string;
  proposal_hash: Hash;
  plan_id: string;
  plan_hash: Hash;
  question_key: string;
  decision: "proceed" | "unverified";
  review_match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  snapshot_id: string;
  snapshot_hash: Hash;
}

export interface ReviewHandoffCloseView {
  handoff_id: string;
  issue_id: string;
  job_state: "pending" | "done";
  job_result: ReviewJobResult | null;
  binding: VersionBinding | null;
  snapshot_id: string | null;
  snapshot_hash: Hash | null;
  proposal_id: string | null;
  proposal_hash: Hash | null;
  plan_id: string | null;
  plan_hash: Hash | null;
  question_key: string | null;
  decision: "proceed" | "unverified" | null;
  review_match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  source_refs: SourceRef[];
  recorded_at_watermark: number | null;
  close_payload: ReviewHandoffClosePayload | null;
  close_payload_hash: Hash | null;
}

/* ------------------------------------------------------------------ */
/* Projection, lifecycle and usage                                     */
/* ------------------------------------------------------------------ */

export interface AdoptionBinding {
  schema_version: "rsi.experience_adoption_binding/1";
  write_id: Id<"wi">;
  write_attempt: number;
  write_result_ref: SourceRef;
  grant_id: Id<"grant">;
  grant_hash: Hash;
  proposal_id: Id<"prop">;
  proposal_hash: Hash;
  candidate_hash: Hash;
  target: {
    host_id: HostId;
    config_space: string;
    mode: HostMode;
    object_type: "skill" | "memory" | "instructions";
    path_or_block: string;
    block_id: string | null;
    ownership: "native_managed" | "rsi_managed" | "shared_handwritten";
    write_mode: "whole_file" | "managed_block";
    approved_root: string;
    target_binding_ref: SourceRef;
  };
  version_binding: VersionBinding;
  adopted_at: number;
  binding_hash: Hash;
}

export type ProjectionLifecycle = "checked" | "trial" | "retained" | "disabled" | "revoked";

/**
 * Runtime mirror of the lifecycle values for callers that need the closed set
 * without importing the type. Kept in sync with ProjectionLifecycle.
 */
export const ExperiencePhase: Readonly<Record<string, ProjectionLifecycle>> = {
  checked: "checked",
  trial: "trial",
  retained: "retained",
  disabled: "disabled",
  revoked: "revoked"
};

export type ProjectionLifecycleReason =
  | "adopted"
  | "trial_started"
  | "retention_rule_met"
  | "confirmed_regression"
  | "expired"
  | "superseded"
  | "user_revoked"
  | "authorization_revoked"
  | "host_incompatible"
  | "window_extended"
  | "rollback";

export interface ExperienceProjection {
  schema_version: "rsi.experience_projection/2";
  projection_id: string;
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  host_id: HostId;
  config_space: string;
  mode: HostMode;
  object_type: "skill" | "memory" | "instructions";
  path_or_block: string;
  block_id: string | null;
  adoption_binding: AdoptionBinding;
  lifecycle: ProjectionLifecycle;
  lifecycle_reason: ProjectionLifecycleReason;
  checked_at: number;
  write: {
    write_id?: string;
    write_state?: string;
    candidate_hash?: Hash;
    written_file_hash?: Hash;
    written_block_hash?: Hash;
    adoption_ref?: string;
    grant_id?: string;
    written_at?: number;
  };
  loading_evidence: {
    written: "unknown" | "claimed" | "constructive" | "verified";
    discovered: "unknown" | "claimed" | "constructive" | "verified";
    included: "unknown" | "context_projection" | "provider_payload" | "transport_body" | "verified";
    observed: "unknown" | "claimed" | "verified";
    evidence_refs: SourceRef[];
    last_checked_at?: number;
  };
  validation_plan_id: string;
  validation_plan_hash: Hash;
  verifier: {
    kind: ValidationPlan["verifier"]["kind"];
    independence: ValidationPlan["verifier"]["independence"];
    binding_ref?: SourceRef;
  };
  no_verifier: boolean;
  retention_rule_id: string;
  retention: {
    window_started_at?: number;
    window_end_at?: number;
    window_extensions: number;
    independent_passes: number;
    failed_observations: number;
    not_exercised_count: number;
    last_evaluated_at?: number;
    retained_at?: number;
    review_after_at?: number;
  };
  baseline: {
    host_version: string;
    tool_versions: Record<string, string>;
    model_family: string;
    captured_at: number;
  } | null;
  usage_record_ids: string[];
  restored_from_projection_id: string | null;
  superseded_by_projection_id: string | null;
  last_lifecycle_event_id: string;
  causal_supported: false;
  row_version: number;
  created_at: number;
  updated_at: number;
}

export type LifecycleTriggerKind =
  | "adoption"
  | "begin_trial"
  | "retention_evaluated"
  | "usage_verification"
  | "user_action"
  | "expiry"
  | "supersede"
  | "host_change"
  | "authorization_change"
  | "window_extension"
  | "rollback";

export interface ExperienceLifecycleEvent {
  schema_version: "rsi.experience_lifecycle_event/1";
  event_id: Id<"lif">;
  projection_id: string;
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  adoption_binding_hash: Hash;
  sequence: number;
  from_lifecycle: ProjectionLifecycle | null;
  to_lifecycle: ProjectionLifecycle;
  reason: ProjectionLifecycleReason;
  trigger: {
    kind: LifecycleTriggerKind;
    ref: SourceRef | null;
    usage_ids: string[];
  };
  write_id: Id<"wi">;
  version_binding: VersionBinding;
  projection_before_hash: Hash | null;
  projection_after_hash: Hash;
  projection_after: ExperienceProjection;
  row_version_before: number;
  row_version_after: number;
  recorded_at: number;
  event_hash: Hash;
}

export type LoadingStageState = "unknown" | "claimed" | "constructive" | "verified";
export type LoadingIncludedState =
  | "unknown"
  | "context_projection"
  | "provider_payload"
  | "transport_body"
  | "verified";

export interface UsageVerificationRecord {
  schema_version: "rsi.usage_verification/1";
  usage_id: string;
  usage_key: Hash;
  projection_id: string;
  experience_id: string;
  experience_version: number;
  experience_content_hash: Hash;
  validation_plan_id: string;
  validation_plan_hash: Hash;
  version_binding: VersionBinding;
  task_family_id: string;
  trigger_result: "triggered" | "not_triggered" | "unknown";
  loading: {
    written: LoadingStageState;
    discovered: LoadingStageState;
    included: LoadingIncludedState;
    observed: "unknown" | "claimed" | "verified";
    evidence_refs: SourceRef[];
  };
  behavior: {
    evidence_refs: SourceRef[];
    summary: string;
  };
  verification: {
    kind: ValidationPlan["verifier"]["kind"];
    independence: ValidationPlan["verifier"]["independence"];
    status: "passed" | "failed" | "not_available" | "not_applicable";
    verifier_ref?: SourceRef;
    binding_ref: SourceRef;
    validation_plan_hash: Hash;
    version_binding: VersionBinding;
  };
  outcome_ref?: SourceRef;
  other_change_refs: SourceRef[];
  attribution: "not_claimed" | "confounded" | "isolated_replay" | "controlled_trial";
  result: "positive_evidence" | "negative_evidence" | "counterexample" | "inconclusive" | "not_exercised";
  evidence_hash: Hash;
  causal_supported: false;
  observed_at: number;
  window_index: number;
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

/** A JSON object with no `undefined` members, ready for JCS hashing. */
export type JsonRecord = { [key: string]: JsonValue };

export interface CandidateKeyInput {
  job_id: Id<"job">;
  attempt_id: Id<"rat">;
  ordinal: number;
  output_hash: Hash;
  candidate_json_hash: Hash;
}

export type ReviewEnqueueRequestRecord = ReviewEnqueueRequest;

