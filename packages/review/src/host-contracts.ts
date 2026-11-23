/**
 * HOST ABI projected for REV (DD-REV-002, DD-TRG-003, DD-HOST-002).
 *
 * HOST owns these shapes. They are declared here as the structural contract
 * REV consumes because `@evoplug/core` has not yet published the HOST
 * submodule; when it does, these declarations are replaced by the core
 * exports with no change to REV semantics. No wire alias, no persisted row
 * type and no second protocol is introduced here.
 */

import type { ErrorEnvelope, Hash, Id, SourceRef } from "@evoplug/core";

/**
 * HOST primitive vocabulary (DD-HOST-110, DD-REV-002).
 *
 * The canonical unions are generated into
 * `packages/core/src/generated/host-vocabulary.ts` from
 * `schemas/common/host-vocabulary.schema.json` (the `x-evoplug-vocabulary`
 * block). `@evoplug/core` keeps the HOST submodule out of its package root,
 * so REV projects the same two closed sets here. The literals below must stay
 * byte-identical to that generated vocabulary; when core publishes the HOST
 * submodule, delete these declarations and re-export the core types instead.
 */
export type HostId =
  | "pi"
  | "oh-my-pi"
  | "step-code"
  | "codex"
  | "opencode"
  | "openhands-sdk"
  | "claude-code";

export type HostMode =
  | "interactive"
  | "print"
  | "rpc"
  | "acp"
  | "sdk"
  | "sdk_stdio"
  | "exec"
  | "app-server"
  | "server"
  | "local_conversation"
  | "remote_conversation";

export type ConfigSpace = string;

export type HostResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type TriggerKind =
  | "new_input"
  | "tool_fact"
  | "compaction"
  | "task_boundary_candidate"
  | "task_stable"
  | "session_end"
  | "user_review_request"
  | "experience_trigger"
  | "config_signal";

/** The four trigger kinds a ReviewSnapshot may bind (DD-REV-010). */
export type ReviewTriggerKind = Extract<
  TriggerKind,
  "task_stable" | "user_review_request" | "experience_trigger" | "session_end"
>;

export type OriginKind = "human" | "host_auto" | "evaluator" | "evaluator_descendant" | "unknown";

export type SignalType =
  | "repeated_correction"
  | "reproducible_error"
  | "stable_recovery"
  | "completion_claim"
  | "user_request";

export type PendingKind = "delivery" | "review_defer" | "generation_resume";

export interface PendingWorkRef {
  pending_id: Id<"pen">;
  kind: PendingKind;
  state: string;
  evidence_ref: string;
}

export interface HostEventBinding {
  host_id: HostId;
  host_version: string;
  adapter_id: Id<"adp">;
  adapter_version: string;
  implementation_hash: Hash;
  mode: HostMode;
  config_space: ConfigSpace;
  host_event: string;
  native_session_id?: string;
  native_turn_id?: string;
  native_message_id?: string;
  native_event_id?: string;
  stream_id: Hash;
  source_seq?: number;
  receipt_seq: number;
  native_occurrence_id?: string;
  retry_of?: string;
  event_identity_key: Hash;
  occurred_at?: number;
  received_at: number;
}

export interface TriggerPolicyRef {
  policy_id: Id<"pol">;
  policy_version: string;
  policy_hash: Hash;
  scope_key: Hash;
}

export interface TriggerOrigin {
  kind: OriginKind;
  evidence_kind: "session_registry" | "host_field" | "input_source_label" | "invocation_context" | "none";
  evidence_ref?: string;
  registry_entry_id?: string;
  ancestor_run_id?: string;
  suppress_automatic: boolean;
}

export interface TriggerScope {
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  project_id?: string;
}

export interface VerifiedSignal {
  type: SignalType;
  strength: "verified" | "claim";
  detector_version: "sigdet/1";
  evidence_refs: string[];
  issue_ids: string[];
  requirement_ids: string[];
  detected_at: number;
}

export interface StableBoundaryEvidence {
  candidate: boolean;
  stable: boolean;
  boundary_kind: "host_stable_event" | "exit" | "user_selected" | "none";
  stable_event_ids: string[];
  source_event_ids: string[];
  stable_watermark: number;
  goal_version: string;
  pending_state: "none" | "pending" | "unknown";
  pending_work_refs: PendingWorkRef[];
  unstable_reasons: string[];
}

export interface TriggerDedupe {
  source_event_key: Hash;
  boundary_key: Hash;
  signal_digest: Hash;
  trigger_dedupe_key: Hash;
  replay_of?: string;
}

export type TriggerReasonCode =
  | "auto_enqueued"
  | "explicit_enqueued"
  | "completion_claim_only"
  | "no_verified_signal"
  | "not_boundary_candidate"
  | "stable_boundary_pending"
  | "stable_boundary_unknown"
  | "watermark_gap"
  | "capability_unknown"
  | "capability_unsupported"
  | "capability_failed"
  | "internal_origin"
  | "origin_unknown"
  | "job_live"
  | "task_job_live"
  | "replay_duplicate"
  | "auto_quota_exhausted"
  | "budget_unavailable"
  | "authorization_missing"
  | "grant_missing"
  | "policy_auto_disabled"
  | "late_event"
  | "invalid_identity"
  | "schema_rejected"
  | "explicit_stage";

export type CapabilityName =
  | "stable_boundary"
  | "online_delivery"
  | "host_budget"
  | "association"
  | "generation.service_profile"
  | "generation.create"
  | "generation.auth"
  | "generation.cancel"
  | "generation.recover"
  | "generation.output";

export interface CapabilityGateResult {
  name: CapabilityName;
  subject: "product_adapter";
  required_status: "verified";
  observed_status: "unknown" | "verified" | "unsupported" | "failed";
  evidence_stage: "none" | "static" | "loaded" | "roundtrip";
  passed: boolean;
  reason_code?: string;
}

export interface TriggerEvent {
  schema_version: "rsi.trigger_event/1";
  trigger_event_id: Id<"trg">;
  trigger_kind: TriggerKind;
  source_event_ref: SourceRef;
  raw_event_ref: SourceRef;
  local_input_id?: Id<"input">;
  host_binding: HostEventBinding;
  policy_ref: TriggerPolicyRef;
  origin: TriggerOrigin;
  request_intent: "automatic" | "explicit_review";
  scope: TriggerScope;
  identity_quality: "strong" | "weak" | "missing";
  signals: VerifiedSignal[];
  boundary: StableBoundaryEvidence;
  stable_evidence_ref?: SourceRef;
  review_scope_key: Hash;
  capability_gate: CapabilityGateResult[];
  dedupe: TriggerDedupe;
  decision: "enqueue" | "skip" | "defer" | "suppress";
  decision_reason: TriggerReasonCode;
  pending_ref?: Id<"pen">;
  review_job_id?: Id<"job">;
  enqueue_request_ref?: SourceRef;
  authorization_ref?: Id<"grant">;
  policy_snapshot_ref: SourceRef;
  decision_version: 1;
  decided_at: number;
  evidence_refs: string[];
}

export interface StableSnapshotRequest {
  mode: "stable";
  completeness: "complete";
  missing_evidence_refs: [];
}

export interface StagedSnapshotRequest {
  mode: "explicit_stage";
  completeness: "staged_with_gaps";
  missing_evidence_refs: [SourceRef, ...SourceRef[]];
}

export type ReviewSnapshotRequest = StableSnapshotRequest | StagedSnapshotRequest;

export interface ReviewEnqueueCommon {
  schema_version: "rsi.review_enqueue/1";
  request_id: string;
  trigger_event_id: Id<"trg">;
  trigger_kind: TriggerKind;
  review_scope_key: Hash;
  boundary_key: Hash;
  signal_digest: Hash;
  trigger_dedupe_key: Hash;
  stable_event_ids: string[];
  stable_watermark: number;
  goal_version: string;
  scope: TriggerScope;
  pending_state: "none" | "pending" | "unknown";
  pending_work_refs: PendingWorkRef[];
  stable: boolean;
  stable_evidence_ref: SourceRef;
  policy_ref: TriggerPolicyRef;
  origin: TriggerOrigin;
  capability_snapshot_hash: Hash;
  budget_policy_ref: string;
  supersedes_job_id?: Id<"job">;
  created_at: number;
}

export interface ReviewEnqueueAuto extends ReviewEnqueueCommon {
  review_kind: "auto";
  authorization_ref: null;
  stable: true;
  pending_state: "none";
  pending_work_refs: [];
  snapshot_request: StableSnapshotRequest;
}

export type ReviewEnqueueExplicit = ReviewEnqueueCommon & {
  review_kind: "explicit";
  authorization_ref: Id<"grant">;
} & (
    | {
        stable: true;
        pending_state: "none";
        pending_work_refs: [];
        snapshot_request: StableSnapshotRequest;
      }
    | {
        stable: false;
        pending_state: "none" | "pending" | "unknown";
        snapshot_request: StagedSnapshotRequest;
      }
  );

export type ReviewEnqueueRequest = ReviewEnqueueAuto | ReviewEnqueueExplicit;

export type ReviewEnqueueRejectionReason =
  | "job_live"
  | "replay_duplicate"
  | "budget_exhausted"
  | "capability_blocked"
  | "scope_stale";

export interface ReviewEnqueueResult {
  schema_version: "rsi.review_enqueue_result/1";
  request_id: string;
  disposition: "created" | "existing" | "rejected";
  review_job_id?: Id<"job">;
  rejection_code?: ReviewEnqueueRejectionReason;
  stored_trigger_event_id: Id<"trg">;
}

export interface GenerationCapabilityBinding {
  status: "unknown" | "verified" | "unsupported" | "failed";
  evidence_stage: "none" | "static" | "loaded" | "roundtrip";
  evidence_refs: string[];
  protocol_version?: string;
}

export interface GenerationBackendRef {
  schema_version: "rsi.generation_backend_ref/1";
  backend_id: string;
  backend_kind: "host_native_subagent" | "sdk" | "cli" | "service";
  entry_kind: "host_subagent" | "sdk_import" | "cli_spawn" | "http_service";
  entry_ref: string;
  backend_version: string;
  protocol_versions: string[];
  isolation: {
    mode: "process" | "container" | "sandbox" | "none" | "unknown";
    network: "disabled" | "restricted" | "enabled" | "unknown";
    evidence_refs: string[];
  };
  capabilities: {
    create: GenerationCapabilityBinding;
    auth: GenerationCapabilityBinding;
    cancel: GenerationCapabilityBinding;
    recover: GenerationCapabilityBinding;
    output: GenerationCapabilityBinding;
  };
  capability_snapshot_hash: Hash;
  approval_ref: string;
  verified_at?: number;
}

/** FND-owned `ServiceProfileLimits`; REV only copies it. */
export type ServiceProfileLimits = import("./budget-contracts.js").ServiceProfileLimits;

export interface ServiceProfile {
  schema_version: "rsi.service_profile/1";
  service_profile_id: string;
  service_profile_key: Hash;
  provider_scope: string;
  limits: ServiceProfileLimits;
  evidence_ref: SourceRef;
}

export type GenerationBackendSelection =
  | { state: "available"; backend: GenerationBackendRef; service_profile: ServiceProfile }
  | {
      state: "blocked_no_backend";
      reason:
        | "no_approved_backend"
        | "capability_unknown"
        | "capability_unsupported"
        | "capability_failed"
        | "budget_unavailable"
        | "isolation_unsupported";
      missing: GenerationCapabilityBinding[];
      evidence_refs: string[];
    };

export interface HostAdapterError {
  code: string;
  retryable: boolean;
  details_ref?: SourceRef;
  http_status?: number;
  provider_code?: string;
}

export interface GenerationBackendSelectRequest {
  job_id: string;
  review_scope_key: Hash;
  host_binding: HostEventBinding;
  approved_backend_ids: string[];
  required_isolation: "process" | "container" | "sandbox" | "none";
  required_network: "disabled" | "restricted" | "enabled";
  budget_policy_ref: string;
  capability_policy_ref: string;
  deadline_ms: number;
}

export interface GenerationCreateRequest {
  job_id: string;
  generation_run_id: string;
  snapshot_ref: SourceRef;
  /** Object types the frozen generator input permits this run to propose. */
  target_policy?: {
    readonly allowed_object_types: readonly ("skill" | "memory" | "instructions")[];
    /**
     * Concrete target templates derived from the host's managed roots, e.g.
     * `skills/evoplug/<name>/SKILL.md`. The same list feeds the static check,
     * so a prompt can never name a target the checker refuses.
     */
    readonly allowed_target_refs?: readonly string[];
  };
  backend: GenerationBackendRef;
  host_binding: HostEventBinding;
  workspace_ref: string;
  permission_scope_ref: string;
  budget_ref: string;
  isolation: GenerationBackendRef["isolation"];
  origin: "evaluator";
  deadline_ms: number;
  idempotency_key: string;
}

export interface GenerationCreateResult {
  state: "created" | "rejected";
  handle_ref?: string;
  host_session_ref?: string;
  child_session_ref?: string;
  isolation_evidence_refs: string[];
  started_at?: number;
  error?: HostAdapterError;
}

export interface GenerationAuthRequest {
  job_id: string;
  handle_ref: string;
  credential_ref: string;
  data_scope_ref: string;
  deadline_ms: number;
}

export interface GenerationAuthResult {
  state: "available" | "unavailable" | "unknown";
  mechanism: string;
  profile_ref: string;
  evidence_refs: string[];
}

export interface GenerationCancelRequest {
  job_id: string;
  handle_ref: string;
  reason: string;
  idempotency_key: string;
  deadline_ms: number;
}

export interface GenerationCancelResult {
  state: "cancelled" | "not_running" | "unsupported" | "unknown" | "failed";
  evidence_refs: string[];
}

export interface GenerationRecoverRequest {
  job_id: string;
  handle_ref: string;
  snapshot_ref: SourceRef;
  resume_kind: string;
  deadline_ms: number;
}

export interface GenerationRecoverResult {
  state: "recovered" | "not_recoverable" | "unknown" | "failed";
  new_handle_ref?: string;
  recovered_events_ref?: SourceRef;
  evidence_refs: string[];
}

export interface GenerationOutputRequest {
  job_id: string;
  handle_ref: string;
  cursor?: string;
  max_bytes: number;
  deadline_ms: number;
}

export interface GenerationOutputResult {
  state: "chunk" | "complete" | "unknown" | "failed";
  output_ref: SourceRef;
  schema_valid: boolean | "unknown";
  next_cursor?: string;
  /** Named CLI or protocol failure, never raw output from a candidate. */
  failure?: {
    readonly code: string;
    readonly detail: string;
    readonly stderr_tail: string;
    /** Shared provider-facing classification recorded by the probe path. */
    readonly diagnosis?: {
      readonly code:
        | "auth_rejected"
        | "provider_rejected"
        | "process_exit_nonzero"
        | "output_unparseable"
        | "protocol_mismatch";
      readonly detail: string;
      readonly provider_status?: number;
      readonly provider_code?: string;
      readonly exit_code?: number;
    };
  };
}

/** HOST generation port (DD-HOST-002). */
export interface HostGenerationPort {
  selectBackend(
    req: GenerationBackendSelectRequest,
    signal: AbortSignal
  ): Promise<HostResult<GenerationBackendSelection, HostAdapterError>>;
  create(
    req: GenerationCreateRequest,
    signal: AbortSignal
  ): Promise<HostResult<GenerationCreateResult, HostAdapterError>>;
  authenticate(
    req: GenerationAuthRequest,
    signal: AbortSignal
  ): Promise<HostResult<GenerationAuthResult, HostAdapterError>>;
  cancel(
    req: GenerationCancelRequest,
    signal: AbortSignal
  ): Promise<HostResult<GenerationCancelResult, HostAdapterError>>;
  recover(
    req: GenerationRecoverRequest,
    signal: AbortSignal
  ): Promise<HostResult<GenerationRecoverResult, HostAdapterError>>;
  readOutput(
    req: GenerationOutputRequest,
    signal: AbortSignal
  ): Promise<HostResult<GenerationOutputResult, HostAdapterError>>;
}

/** HOST lifecycle version facts, read inside the FND synchronous stage. */
interface HostVersionFacts {
  host_version: string;
  tool_versions: Record<string, string>;
  model_family: string;
  facts_hash: Hash;
  evidence_ref: SourceRef;
}

export interface HostVersionFactsPort {
  readInTransaction(tx: unknown, binding: HostEventBinding): HostResult<HostVersionFacts, ErrorEnvelope>;
}

/** FND-owned write adoption view, projected for the T7/T8 admission. */
export interface WriteAdoptionView {
  intent: {
    write_id: Id<"wi">;
    object_type: "skill" | "memory" | "instructions";
    action: "create" | "update" | "disable" | "rollback";
    candidate_id: Id<"prop">;
    candidate_hash: Hash;
    expected_file_hash: Hash | null;
    expected_block_hash: Hash | null;
    write_mode: "whole_file" | "managed_block";
    target_path: string;
    approved_root: string;
    target_ownership: "native_managed" | "rsi_managed" | "shared_handwritten";
    block_selector: string | null;
    config_space_id: string;
    grant_id: Id<"grant">;
    binding: {
      task_id: Id<"task">;
      branch_id: Id<"br">;
      input_epoch: number;
      goal_version: string;
      config_version: string;
      watermark: number;
    };
    state: string;
  };
  result: {
    write_id: Id<"wi">;
    attempt: number;
    state: string;
    path: string;
    new_file_hash: Hash;
    new_block_hash: Hash | null;
    snapshot_id: string;
    readback_verified: boolean;
  };
  grant: AuthorizationGrantView;
}

export interface AuthorizationGrantView {
  grant_id: Id<"grant">;
  grant_hash: Hash;
  object_type: "skill" | "memory" | "instructions" | "config";
  actions: readonly string[];
  mode: "once" | "standing";
  scope: {
    project_ids?: readonly string[];
    host_ids?: readonly string[];
    config_spaces?: readonly string[];
    paths?: readonly string[];
    block_ids?: readonly string[];
    object_ids?: readonly string[];
  };
  revoked_at?: number;
  expires_at?: number;
  candidate_id?: Id<"prop">;
  candidate_hash?: Hash;
}
