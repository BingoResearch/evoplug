/**
 * HOST domain types (DD-TRG-001 … DD-TRG-012, DD-CAP-001 … DD-CAP-010,
 * DD-HOST-001 … DD-HOST-110).
 *
 * HOST owns this vocabulary. Every field, literal and default follows the
 * design text; the shared primitives (`Id`, `Hash`, `VersionBinding`,
 * `SourceRef`, `ErrorEnvelope`, `JsonValue`) come from `@evoplug/core` and are
 * never redefined here.
 */

import type { Id } from "../ids.js";
import type { Hash } from "../hash.js";
import type { JsonValue } from "../json.js";
import type { SourceRef } from "../source-ref.js";
import type { VersionBinding } from "../version-binding.js";
import type {
  CapabilityStatus,
  CapabilitySubject,
  EvidenceStage,
  ExecutionEnvironmentKind,
  HostId,
  HostMode,
  HostProbeResult,
  HostVersionKind,
  UnknownFact
} from "../generated/host-vocabulary.js";

export type {
  CapabilityStatus,
  CapabilitySubject,
  EvidenceStage,
  ExecutionEnvironmentKind,
  HostId,
  HostMode,
  HostProbeResult,
  HostVersionKind,
  UnknownFact
};

/** Adapter-registered configuration space token (no path characters). */
export type ConfigSpace = string;

/** Adapter-registered construction path token (DD-CAP-002). */
export type ConstructionPath = string;

export type InputId = Id<"input">;

/* ------------------------------------------------------------------ */
/* DD-TRG-002 TriggerPolicy                                            */
/* ------------------------------------------------------------------ */

export type SignalType =
  | "repeated_correction"
  | "reproducible_error"
  | "stable_recovery"
  | "completion_claim"
  | "user_request";

export type InclusionLevel =
  | "none"
  | "constructive"
  | "context_projection"
  | "provider_payload"
  | "transport_body"
  | "unknown";

export type TaskProcessState =
  | "advancing"
  | "information_gain"
  | "stalled_candidate"
  | "regressing"
  | "baseline"
  | "waiting"
  | "blocked"
  | "paused"
  | "cancelled"
  | "collection_gap"
  | "unknown";

export interface PolicyScope {
  scope_kind: "global" | "host" | "host_mode" | "project" | "project_host" | "project_host_mode";
  host_id?: HostId;
  mode?: HostMode;
  config_space?: ConfigSpace;
  project_id?: string;
}

export interface OnlinePolicy {
  enabled: true;
  on_input: true;
  on_tool_event: "update_only";
  on_compaction: "refresh_refs";
  remote_semantics: "shadow";
  min_interval_ms: number;
  max_remote_checks_per_input: number;
  max_remote_checks_per_minute: number;
  semantic_merge_window_ms: number;
  local_fact_priority: "always_sync";
  delivery_min_inclusion: InclusionLevel;
}

export interface ProgressPolicy {
  enabled: true;
  on_input_boundary: true;
  on_stable_boundary: true;
  min_checks: 2;
  min_span_ms: number;
  window_ms: number;
  max_checks_per_window: number;
  excluded_task_states: TaskProcessState[];
  stall_opens_issue: boolean;
  step_effect_mode: "shadow";
  semantic_compare: "disabled" | "shadow";
}

export interface ReviewPolicy {
  mode: "signal_gated";
  auto: {
    enabled: boolean;
    require_stable_boundary: true;
    signal_match: "any";
    min_signals: SignalType[];
    max_open_jobs_per_task: number;
    max_auto_jobs_per_task_24h: number;
  };
  explicit: {
    enabled: true;
    allowed_when_auto_disabled: true;
    unstable_snapshot: "stage_with_gaps";
    require_grant: true;
  };
  pending: {
    defer_max_ms: number;
    on_timeout: "expire_await_explicit";
    resume_on_verified_stable: true;
  };
  signal_policy: {
    repeated_correction: { min_distinct_events: 2; window_ms: number };
    reproducible_error: { min_independent_runs: 2; same_failure_signature: true };
    stable_recovery: { verified_failure_required: true; min_consecutive_passes: 2 };
    completion_claim_max_strength: "unverified_claim";
  };
}

export interface OriginPolicy {
  evaluator_suppression: true;
  descendant_suppression: true;
  unknown_origin_auto_review: "suppress";
  unknown_origin_online_checks: "local_only";
  unknown_origin_explicit_review: "grant_required";
  registry_ttl_ms: number;
}

export interface CapabilityGatePolicy {
  profile_version: "cap-gate/1";
  subject: "product_adapter";
  allow_unverified_auto_review: false;
  allow_unverified_online_semantics: false;
  require_probe_freshness_ms: number;
}

export interface PolicyBudgetRef {
  budget_policy_ref: string;
  require_budget_for_paid_request: true;
  require_budget_for_generation: true;
}

export interface TriggerPolicy {
  schema_version: "rsi.trigger_policy/1";
  policy_id: Id<"pol">;
  policy_version: string;
  policy_hash: Hash;
  lifecycle: "active" | "superseded";
  scope: PolicyScope;
  online: OnlinePolicy;
  progress: ProgressPolicy;
  review: ReviewPolicy;
  origin: OriginPolicy;
  capabilities: CapabilityGatePolicy;
  budget: PolicyBudgetRef;
  created_at: number;
  updated_at: number;
}

export interface TriggerPolicyRef {
  policy_id: Id<"pol">;
  policy_version: string;
  policy_hash: Hash;
  scope_key: Hash;
}

/* ------------------------------------------------------------------ */
/* DD-TRG-003 … DD-TRG-005 TriggerEvent and origin                     */
/* ------------------------------------------------------------------ */

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

export type OriginKind = "human" | "host_auto" | "evaluator" | "evaluator_descendant" | "unknown";

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

export interface HostEventBindingDraft {
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
  source_seq_hint?: number;
  native_occurrence_id?: string;
  retry_of?: string;
  occurred_at?: number;
  received_at: number;
}

export interface StableEventScope {
  schema_version: "rsi.stable_event_scope/1";
  host_id: string;
  config_space: string;
  native_session_id: string;
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  scope_hash: Hash;
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
  /** Goal version the signal was detected under (DD-TRG-009). */
  goal_version?: string;
}

export interface PendingWorkRef {
  pending_id: Id<"pen">;
  kind: PendingKind;
  state: string;
  evidence_ref: string;
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
  | "explicit_stage"
  /** Appendix Q.2: the stable boundary was recorded; review waits for session end. */
  | "session_end_only";

export interface CapabilityGateResult {
  name: CapabilityName;
  subject: "product_adapter";
  required_status: "verified";
  observed_status: CapabilityStatus;
  evidence_stage: EvidenceStage;
  passed: boolean;
  reason_code?: string;
}

export interface TriggerEvent {
  schema_version: "rsi.trigger_event/1";
  trigger_event_id: Id<"trg">;
  trigger_kind: TriggerKind;
  source_event_ref: SourceRef;
  raw_event_ref: SourceRef;
  local_input_id?: InputId;
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

/* ------------------------------------------------------------------ */
/* Review enqueue handoff (REV-owned; type-only mirror)                */
/* ------------------------------------------------------------------ */

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

export interface ReviewEnqueueAuto extends ReviewEnqueueCommon {
  review_kind: "auto";
  authorization_ref: null;
  stable: true;
  pending_state: "none";
  pending_work_refs: [];
  snapshot_request: StableSnapshotRequest;
}

export type ReviewEnqueueExplicit = ReviewEnqueueCommon & { review_kind: "explicit"; authorization_ref: Id<"grant"> } & (
  | { stable: true; pending_state: "none"; pending_work_refs: []; snapshot_request: StableSnapshotRequest }
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

export interface PrepareReviewEnqueueInput {
  schema_version: "rsi.prepare_review_enqueue_in/1";
  req: ReviewEnqueueRequest;
  trigger: TriggerEvent;
}

/**
 * Opaque, deeply frozen, in-process value owned by REV. HOST only passes it
 * back and must never read its fields, check a brand or serialize it.
 */
export interface PreparedReviewEnqueue {
  readonly __prepared_review_enqueue: unique symbol;
}

export interface TriggerAdmissionReceipt {
  schema_version: "rsi.trigger_admission_receipt/1";
  trigger_event_id: Id<"trg">;
  outcome: "committed" | "existing";
  review: ReviewEnqueueResult | null;
  commit: { batch_hash: Hash; first_commit_seq: number; last_commit_seq: number } | null;
}

/* ------------------------------------------------------------------ */
/* DD-TRG-007 PendingRegistry                                          */
/* ------------------------------------------------------------------ */

export type PendingKind = "delivery" | "review_defer" | "generation_resume";

export interface PendingError {
  code: string;
  retryable: boolean;
  detail_ref: SourceRef;
}

export interface PendingBase {
  schema_version: "rsi.pending/1";
  pending_id: Id<"pen">;
  pending_key: Hash;
  kind: PendingKind;
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  trigger_event_id?: Id<"trg">;
  policy_ref: TriggerPolicyRef;
  created_at: number;
  updated_at: number;
  deadline_at?: number;
  attempt: number;
  evidence_refs: string[];
  last_error?: PendingError;
  origin: OriginKind;
}

type DeliveryPendingState =
  | "pending"
  | "submitted_not_verified"
  | "included"
  | "expired"
  | "superseded"
  | "rejected";

export interface DeliveryPending extends PendingBase {
  kind: "delivery";
  state: DeliveryPendingState;
  delivery_id: string;
  session_ref: string;
  boundary_event_ref: string;
  delivery_target_hash: Hash;
  content_ref: SourceRef;
  content_hash: Hash;
  nonce: string;
  wait_mode: "bounded" | "strict";
  capability_snapshot_hash: Hash;
  submitted_certainty: "true" | "false" | "unknown";
  inclusion_level: InclusionLevel;
  inclusion_evidence_ref?: string;
  no_blind_retry: true;
}

type ReviewDeferState = "waiting" | "resumed" | "expired_await_explicit" | "cancelled";

export interface ReviewDeferPending extends PendingBase {
  kind: "review_defer";
  state: ReviewDeferState;
  boundary_key: Hash;
  review_scope_key: Hash;
  stable_event_ids: string[];
  stable_watermark: number;
  goal_version: string;
  pending_work_refs: PendingWorkRef[];
  resume_requires: "verified_stable_event_or_user";
  resume_trigger_event_id?: Id<"trg">;
}

type GenerationResumeState = "queued" | "resuming" | "resumed" | "blocked_no_backend" | "expired";

export interface GenerationResumePending extends PendingBase {
  kind: "generation_resume";
  state: GenerationResumeState;
  review_job_id: Id<"job">;
  snapshot_ref: SourceRef;
  backend_selection_ref: string;
  resume_entry: "coordinator_start" | "next_input" | "manual";
  attempts: number;
  max_attempts: 3;
}

export type PendingEntry = DeliveryPending | ReviewDeferPending | GenerationResumePending;

/* ------------------------------------------------------------------ */
/* DD-TRG-008 ProgressCheckpoint                                       */
/* ------------------------------------------------------------------ */

interface RequirementVersionRef {
  requirement_id: string;
  version: string;
  state: string;
}

interface PendingObservationField {
  field: string;
  state: "none" | "present" | "unknown";
  ref?: string;
}

interface PendingObservation {
  state: "none" | "pending" | "unknown";
  fields: PendingObservationField[];
}

type StepEffectSkipReason =
  | "deterministic_sufficient"
  | "evidence_missing"
  | "not_comparable"
  | "scope_mismatch"
  | "backend_disabled"
  | "budget_blocked";

type StepEffectEscalation = "none" | "retrieval" | "semantic" | "verification";

type StepEffectStaleReason =
  | "backend_changed"
  | "method_changed"
  | "scope_changed"
  | "policy_changed"
  | "evidence_changed"
  | "attempt_superseded";

interface StepEffectCost {
  status: "observed" | "unknown";
  elapsed_ms: number;
  cpu_ms: number | null;
  read_bytes: number;
  retrieval_count: number;
  model_invocations: number;
  verifier_invocations: number;
  receipt_ref?: SourceRef;
}

export interface StepEffectShadow {
  status: "not_applicable" | "observed" | "unknown";
  evidence_refs: string[];
  skip_reason?: StepEffectSkipReason;
  escalation?: StepEffectEscalation;
  stale?: "current" | "stale";
  stale_reason?: StepEffectStaleReason;
  route_ref?: SourceRef;
  cost?: StepEffectCost;
}

export interface ProgressCheckpoint {
  schema_version: "rsi.progress_checkpoint/1";
  checkpoint_id: Id<"chk">;
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  trigger_event_id: Id<"trg">;
  checkpoint_kind: "input_boundary" | "stable_boundary";
  task_process_state: TaskProcessState;
  comparability_key: Hash;
  requirement_versions: RequirementVersionRef[];
  evidence_digest: Hash;
  artifact_digest: Hash;
  verification_digest: Hash;
  information_digest: Hash;
  new_information: {
    evidence: number;
    artifacts: number;
    verification: number;
    requirement_transitions: number;
    issue_transitions: number;
  };
  consecutive_no_info: number;
  span_from_baseline_ms: number;
  baseline_checkpoint_id?: Id<"chk">;
  previous_comparable_checkpoint_id?: Id<"chk">;
  pending_observation: PendingObservation;
  evidence_coverage: "complete" | "partial" | "gap";
  step_effect_shadow: StepEffectShadow;
  policy_ref: TriggerPolicyRef;
  created_at: number;
}

/* ------------------------------------------------------------------ */
/* DD-TRG-004 Event normalization                                      */
/* ------------------------------------------------------------------ */

/**
 * Native message kinds observed in HOST drafts and FND event drafts.
 *
 * The HOST payload union and the FND closed set (`message`, `turn`, `event`,
 * `prompt`, `other`) are both accepted here: adapters report the FND set while
 * HOST-internal draft fixtures use the payload union.
 */
export type NativeMessageKind =
  | "input.received"
  | "input.retry"
  | "agent.message"
  | "tool.call"
  | "tool.result"
  | "host.boundary"
  | "compaction.observed"
  | "subagent.started"
  | "subagent.ended"
  | "delivery.receipt"
  | "feedback.observed"
  | "host.unclassified"
  | "message"
  | "turn"
  | "event"
  | "prompt"
  | "other";

export interface NativeIds {
  session_id?: string;
  turn_id?: string;
  message_id?: string;
  event_id?: string;
  tool_call_id?: string;
  parent_tool_call_id?: string;
  injection_message_id?: string;
  persisted_message_id?: string;
}

export interface HostEventIdentity {
  schema_version: "rsi.host_event_identity/1";
  host_id: HostId;
  config_space: ConfigSpace;
  mode: HostMode;
  native_session_id: string;
  native_kind: NativeMessageKind;
  host_event: string;
  native_message_id: string | null;
  native_event_id: string | null;
  source_seq: number | null;
  occurred_at: number;
  event_identity_key: Hash;
}

export interface ActiveAdapterRegistration {
  schema_version: "rsi.active_adapter_registration/1";
  registration_hash: Hash;
  adapter_id: Id<"adp">;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  adapter_version: string;
  implementation_hash: Hash;
  descriptor_hash: Hash;
  config_spaces: ConfigSpace[];
  event_contracts: Array<{
    host_event: string;
    native_kind: NativeMessageKind;
    canonical_kinds: TriggerKind[];
    required_capabilities: CapabilityName[];
  }>;
  applied_at: number;
}

export interface RawHostEvent {
  raw_event_id: string;
  adapter_id: Id<"adp">;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  host_event: string;
  received_at: number;
  payload_ref: SourceRef;
  payload_hash: Hash;
  native_ids: NativeIds;
  adapter_context_ref?: string;
  registration: ActiveAdapterRegistration;
}

export interface RawHostEventUpload {
  schema_version: "rsi.raw_host_event_upload/1";
  raw_event_id: string;
  adapter_id: Id<"adp">;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  host_event: string;
  received_at: number;
  payload: ContentUpload;
  payload_hash: Hash;
  native_ids: NativeIds;
  adapter_context_ref?: string;
}

export interface AuthenticatedAdapterPeer {
  adapter_id: Id<"adp">;
  adapter_version: string;
  implementation_hash: Hash;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  descriptor_hash: Hash;
  registration_hash: Hash;
}

export interface ContentUpload {
  media_type: "text/plain;charset=utf-8" | "application/json" | "application/octet-stream";
  encoding: "utf8" | "base64";
  data: string;
  byte_length: number;
}

export interface StoredContent {
  content_ref: SourceRef;
  content_hash: Hash;
  byte_length: number;
}

export interface HostPayloadStorePort {
  put(
    content: ContentUpload,
    owner: { type: "host_raw_event"; id: string }
  ): Promise<import("../result.js").Result<StoredContent, import("../errors.js").ErrorEnvelope>>;
}

export interface ResolvedHostPayload {
  schema_version: "rsi.resolved_host_payload/1";
  canonical_ref: SourceRef;
  content_version: Hash;
  payload_hash: Hash;
  media_type: "text/plain;charset=utf-8" | "application/json" | "application/octet-stream";
  encoding: "utf8" | "base64";
  byte_length: number;
  bytes: Readonly<Uint8Array>;
  decoded_text?: string;
  json_value?: JsonValue;
  resolved_at: number;
}

export type NormalizedHostEventPayload =
  | { kind: "input.received"; text_ref: SourceRef; directive_strength: "explicit" | "ambiguous"; parent_native_id?: string }
  | { kind: "input.retry"; retry_of_native_event_id: string; reason_code: "host_retry" | "transport_retry" }
  | { kind: "agent.message"; text_ref: SourceRef; phase: "assistant" | "tool_preface" | "final" }
  | { kind: "tool.call"; tool_call_id: string; parent_tool_call_id?: string; tool_name: string; arguments_ref: SourceRef }
  | { kind: "tool.result"; tool_call_id: string; status: "ok" | "error" | "unknown"; text_ref: SourceRef }
  | {
      kind: "host.boundary";
      boundary: "stop" | "agent_end" | "session_end" | "error";
      host_stable_event: string;
      retry_pending: boolean | UnknownFact;
      async_work: boolean | UnknownFact;
      queue_empty: boolean | UnknownFact;
      background_refs: string[];
      exit_budget_ms?: number;
    }
  | {
      kind: "compaction.observed";
      compaction_kind: "auto" | "manual" | "host_summary";
      checkpoint_ref?: SourceRef;
      omitted_range?: { from_watermark: number; to_watermark: number };
    }
  | { kind: "subagent.started"; native_agent_id: string; relation: "child" | "sibling"; parent_native_event_id?: string }
  | { kind: "subagent.ended"; native_agent_id: string; status: "ok" | "error" | "unknown"; summary_ref?: SourceRef }
  | {
      kind: "delivery.receipt";
      delivery_id: Id<"del">;
      axis: "transport" | "inclusion" | "adoption";
      evidence_kind:
        | "hook_return_accepted"
        | "context_projection_seen"
        | "provider_payload_captured"
        | "transport_body_captured"
        | "host_confirmed"
        | "behavior_observed"
        | "independent_verifier";
      evidence_ref?: SourceRef;
      observed_at: number;
    }
  | {
      kind: "feedback.observed";
      feedback_kind: "correction" | "dissatisfaction" | "new_goal" | "acceptance";
      text_ref: SourceRef;
      target_issue_id?: Id<"issue">;
    }
  | {
      kind: "host.unclassified";
      native_type: string;
      content_ref: SourceRef;
      reason_code: "no_mapping" | "unsupported_version";
    };

export interface NormalizedHostEventDraft {
  schema_version: "rsi.normalized_host_event/1";
  host_binding: HostEventBindingDraft;
  native_kind: NativeMessageKind;
  kind_candidates: TriggerKind[];
  correlation: { parent_call_id?: string; correlation_id?: string; task_hint?: string; branch_hint?: string };
  origin_hint: OriginKind;
  input_source_label?: string;
  is_auto_turn: boolean | UnknownFact;
  payload: NormalizedHostEventPayload;
  attribution: {
    sender: "human" | "agent" | "tool" | "system" | "unknown";
    typed_user_message: boolean;
    typed_field_names: string[];
  };
  required_capabilities: CapabilityName[];
  rejections: Array<{
    code: "E_FIELD_MISSING" | "E_ENUM_UNKNOWN" | "E_IDENTITY_MISSING" | "E_ORIGIN_UNRESOLVED" | "E_VERSION_UNMAPPED";
    field: string;
    detail_ref: string;
    fatal: boolean;
  }>;
}

export interface NormalizedHostEvent extends Omit<NormalizedHostEventDraft, "host_binding"> {
  host_binding: HostEventBinding;
  normalized_id: Id<"nev">;
  raw_event_ref: SourceRef;
  payload_hash: Hash;
  identity_quality: "strong" | "weak" | "missing";
  normalized_at: number;
  event_scope?: StableEventScope;
}

export interface NormalizeHostEventInput {
  schema_version: "rsi.normalize_host_event_input/1";
  raw: RawHostEvent;
  payload: ResolvedHostPayload;
}

/** HOST local rejection record (DD-TRG-010). Not an `ErrorEnvelope`. */
export interface HostEventRejection {
  schema_version: "rsi.host_event_rejection/1";
  rejection_id: string;
  phase: "A" | "B";
  raw_event_ref: SourceRef | null;
  host_binding: HostEventBindingDraft | null;
  reason: import("./errors.js").HostEventRejectionReason;
  field: string;
  detail_ref: SourceRef | null;
  created_at: number;
}

export interface SessionScopeReadPort {
  get(input: {
    host_id: HostId;
    config_space: ConfigSpace;
    native_session_id: string;
    deadline_ms: number;
    signal?: AbortSignal;
  }): Promise<import("../result.js").Result<StableEventScope | null, import("../errors.js").ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* DD-CAP-002 … DD-CAP-004 Capability                                  */
/* ------------------------------------------------------------------ */

export interface SourcePin {
  host_version: string;
  host_version_kind: HostVersionKind;
  source_commit: string | null;
}

export interface BinaryPin {
  binary_version: string | null;
  binary_hash: Hash | null;
}

export interface ExecutionEnvironment {
  os: string;
  arch: string;
  isolation: "local" | "container" | "remote";
}

export interface CapabilityBinding {
  host_id: HostId;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  adapter_version: string;
  subject: CapabilitySubject;
  mode: HostMode;
  config_space: ConfigSpace;
  root_id: string;
  construction_path: ConstructionPath;
  execution_environment: ExecutionEnvironment;
  mapping: "exact" | "partial" | "unmapped";
  backend_id?: string;
}

export type CapabilityName =
  | "input_capture"
  | "sync_wait"
  | "source_trust"
  | "tool_id"
  | "compaction_event"
  | "request_observation"
  | "managed_object_load"
  | "online_delivery"
  | "stable_boundary"
  | "host_budget"
  | "association"
  | "human_interaction_attested"
  | "capacity_window"
  | "generation.service_profile"
  | "generation.create"
  | "generation.auth"
  | "generation.cancel"
  | "generation.recover"
  | "generation.output";

export interface CapabilityDetailsMap {
  input_capture: {
    source_fields: string[];
    raw_text_before_expansion: boolean | UnknownFact;
    input_source_label: "trusted" | "label_only" | "untrusted";
    duplicate_handling: "same_event_id" | "content_hash" | "none" | UnknownFact;
    covered_modes: HostMode[];
  };
  sync_wait: {
    boundary: string;
    handler_timeout_ms: number | UnknownFact;
    host_waits_for_handler: boolean | UnknownFact;
    timeout_behavior: "continue" | "drop_output" | "block" | UnknownFact;
    hard_block: boolean | UnknownFact;
    hard_block_evidence_ref?: string;
  };
  source_trust: {
    trust_level: "managed" | "trusted_project" | "untrusted_project" | UnknownFact;
    project_trust_gate: boolean | UnknownFact;
    config_layers: string[];
    highest_precedence: string;
  };
  tool_id: {
    call_id_field: string | UnknownFact;
    parent_call_field: string | UnknownFact;
    result_join: "direct" | "weak" | "none" | UnknownFact;
    parallel_safe: boolean | UnknownFact;
  };
  compaction_event: {
    events: string[];
    reason: "structured" | "name_only" | "none" | UnknownFact;
    summary_available: boolean | UnknownFact;
    pre_boundary: string | UnknownFact;
    post_boundary: string | UnknownFact;
    summary_replaces_history: boolean | UnknownFact;
  };
  request_observation: {
    max_level: InclusionLevel;
    mechanisms: string[];
    final_body_available: boolean | UnknownFact;
    redaction: string[];
  };
  managed_object_load: {
    reload_boundary: "next_request" | "reload" | "new_session" | "restart" | UnknownFact;
    hot_reload: boolean | UnknownFact;
    load_signal: string | UnknownFact;
    readback: "supported" | "unsupported" | UnknownFact;
  };
  online_delivery: {
    return_entry: string;
    transport: "sync" | "async" | UnknownFact;
    max_text_chars: number | UnknownFact;
    inclusion_level: InclusionLevel;
    accepted_signal: string | UnknownFact;
    can_replace_user_text: boolean | UnknownFact;
    async_first_request: boolean | UnknownFact;
    block_with_context: "supported" | "degraded" | "unknown";
  };
  stable_boundary: {
    candidate_events: string[];
    stable_events: string[];
    review_boundary_facets: Array<"task_completion" | "review_candidate" | "session_exit">;
    pending_fields: string[];
    pending_semantics: "complete" | "partial" | "unknown";
    stable_predicate_ref: string | UnknownFact;
    background_work_visible: boolean | UnknownFact;
    exit_budget_ms: number | UnknownFact;
  };
  host_budget: {
    handler_timeout_ms: number | UnknownFact;
    total_budget_ms: number | UnknownFact;
    serial_chain: boolean | UnknownFact;
    timeout_behavior: "continue" | "drop_output" | "block" | UnknownFact;
    hard_block: boolean | UnknownFact;
    hard_block_evidence_ref?: string;
    reserve_ms: number;
  };
  association: {
    message_join: "direct_id" | "stable_mapping" | "session_only" | "none" | UnknownFact;
    tool_join: "direct_id" | "stable_mapping" | "session_only" | "none" | UnknownFact;
    injection_id_preserved: boolean | UnknownFact;
    native_ids: string[];
    mapping_ref?: string;
    text_fallback: false;
  };
  human_interaction_attested: {
    proof_kinds: Array<"host_native_confirmation" | "control_plane_explicit_confirmation">;
    subject_kinds: Array<"event_key" | "subject_hash">;
    control_plane_purposes: Array<
      | "replay_approve"
      | "replay_revoke"
      | "replay_reject"
      | "replay_reconcile"
      | "egress_approve"
      | "grant_issue"
      | "grant_revoke"
      | "adapter_install"
    >;
    evidence_schema: "rsi.human_proof_evidence/1";
    max_attestation_age_ms: number;
  };
  capacity_window: {
    scope: "window_tokens";
    unit: "tokens";
    readback_method: "host_api" | "provider_metadata" | "ui_readback" | UnknownFact;
    model_scope_keys: string[];
    evidence_schema: "rsi.capacity_evidence_payload/1";
  };
  "generation.service_profile": {
    profile_schema: "rsi.service_profile/1";
    evidence_schema: "rsi.service_profile_evidence/1";
    provider_scope: string;
    profile_key: Hash;
    observed_at: number;
  };
  "generation.create": {
    entry_kind: "host_subagent" | "sdk_import" | "cli_spawn" | "http_service";
    entry_ref: string;
    backend_version: string | UnknownFact;
    protocol_versions: string[];
    isolation: {
      mode: "process" | "container" | "sandbox" | "none" | UnknownFact;
      network: "disabled" | "restricted" | "enabled" | UnknownFact;
      evidence_refs: string[];
    };
    idempotent: boolean | UnknownFact;
    max_concurrent: number | UnknownFact;
    supported_resume: boolean | UnknownFact;
  };
  "generation.auth": {
    mechanism: "host_login" | "profile_ref" | "env_ref" | "ambient" | "none" | UnknownFact;
    credential_ref_kind: "secret_ref" | "profile_ref" | "none" | UnknownFact;
    profile_ref: string | UnknownFact;
    data_scope: string | UnknownFact;
    host_login_reuse: boolean | UnknownFact;
    expiry_semantics: string | UnknownFact;
  };
  "generation.cancel": {
    method: "host_api" | "signal" | "process_kill" | "none" | UnknownFact;
    propagates_to_children: boolean | UnknownFact;
    idempotent: boolean | UnknownFact;
    cancel_window_ms: number | UnknownFact;
    post_effect: string | UnknownFact;
  };
  "generation.recover": {
    resume_kind: "reattach" | "persisted_session" | "replay_from_snapshot" | "none" | UnknownFact;
    recovery_boundary: string | UnknownFact;
    durable_state: boolean | UnknownFact;
    lost_work_semantics: string | UnknownFact;
  };
  "generation.output": {
    protocol: string | UnknownFact;
    schema_ref: string | UnknownFact;
    streaming: boolean | UnknownFact;
    max_bytes: number | UnknownFact;
    final_state_signal: string | UnknownFact;
    artifact_refs: boolean | UnknownFact;
  };
}

interface CapabilityRecordBase {
  schema_version: "rsi.capability/2";
  capability_id: Id<"cap">;
  binding: CapabilityBinding;
  binding_key: Hash;
  name: CapabilityName;
  status: CapabilityStatus;
  evidence_stage: EvidenceStage;
  evidence_refs: string[];
  probe_ref?: string;
  probe_result?: HostProbeResult;
  blocker_code?: string;
  failure_code?: string;
  checked_at: number;
  verified_at?: number;
  last_verified_at?: number;
  legacy?: {
    schema_version: "rsi.capability/1";
    status: "unknown" | "static" | "loaded" | "verified";
    details?: Record<string, string | number | boolean | null>;
  };
}

export type CapabilityRecordOf<N extends CapabilityName> = CapabilityRecordBase & {
  name: N;
  details: CapabilityDetailsMap[N];
};

export type CapabilityRecord = { [N in CapabilityName]: CapabilityRecordOf<N> }[CapabilityName];

export interface GenerationCapabilityBinding {
  name: "generation.create" | "generation.auth" | "generation.cancel" | "generation.recover" | "generation.output";
  capability_id: Id<"cap">;
  status: CapabilityStatus;
  evidence_stage: EvidenceStage;
  probe_result?: HostProbeResult;
  evidence_refs: string[];
}

export interface HostProbeAssertion {
  assertion_id: string;
  capability: CapabilityName;
  expected: string;
  observed_ref: SourceRef;
  pass: boolean | "unknown";
  failure_code?: string;
}

export interface HostProbeCapabilityResult {
  name: CapabilityName;
  proposed_status: CapabilityStatus;
  evidence_stage: EvidenceStage;
  evidence_refs: string[];
  proposed_details_ref?: SourceRef;
  failure_code?: string;
}

export type HostProbeBlockerKind =
  | "credentials_unavailable"
  | "region_blocked"
  | "provider_unavailable"
  | "host_not_installed"
  | "version_unmapped"
  | "permission_denied"
  | "fixture_unavailable"
  | "deadline_exceeded"
  | "operator_aborted"
  | "unknown_environment";

export interface HostProbeBlocker {
  kind: HostProbeBlockerKind;
  code: string;
  detail_ref: SourceRef;
  retry_allowed: boolean;
}

export interface HostProbeRecord {
  schema_version: "rsi.host_probe/2";
  probe_id: Id<"prb">;
  probe_contract_version: "host-probe/2";
  target_kind: "host" | "jev_api" | "filesystem";
  binding: CapabilityBinding;
  binding_key: Hash;
  probe_mode: "read_only" | "temp_fixture";
  fixture_ref?: SourceRef;
  probe_action: string;
  assertions: HostProbeAssertion[];
  capability_results: HostProbeCapabilityResult[];
  result: HostProbeResult;
  blocker?: HostProbeBlocker;
  expected: string;
  observed: string;
  evidence_refs: string[];
  duration_ms: number;
  checked_at: number;
}

/** DD-CAP-006 v1 read-only migration input. */
export interface LegacyCapabilityRecordV1 {
  schema_version: "rsi.capability/1";
  capability_id: Id<"cap">;
  binding: CapabilityBinding;
  binding_key: Hash;
  name: CapabilityName;
  status: "unknown" | "static" | "loaded" | "verified";
  evidence_refs: string[];
  details?: Record<string, string | number | boolean | null>;
  checked_at: number;
}

/* ------------------------------------------------------------------ */
/* DD-HOST-001 HostAdapter                                             */
/* ------------------------------------------------------------------ */

export type LoadBoundary = "next_request" | "reload" | "new_session" | "restart" | "unknown";

export interface AdapterEventContract {
  host_event: string;
  native_kind: NativeMessageKind;
  canonical_kinds: TriggerKind[];
  required_capabilities: CapabilityName[];
}

export interface RegistrationTarget {
  target_id: string;
  config_space: ConfigSpace;
  scope: "user" | "project" | "managed";
  kind: "extension" | "plugin" | "hook_config" | "sdk_package";
  load_boundary: LoadBoundary;
  marker_id: string | null;
}

export interface AdapterDescriptor {
  schema_version: "rsi.adapter_descriptor/1";
  adapter_id: Id<"adp">;
  host_id: HostId;
  adapter_version: string;
  implementation_hash: Hash;
  supported_modes: HostMode[];
  config_spaces: ConfigSpace[];
  registration_targets: RegistrationTarget[];
  event_contracts: AdapterEventContract[];
  declared_capabilities: CapabilityName[];
}

export interface RegistrationRequest {
  schema_version: "rsi.registration_request/1";
  request_id: string;
  registration_hash: Hash;
  host_id: HostId;
  adapter_id: Id<"adp">;
  adapter_version: string;
  implementation_hash: Hash;
  mode: HostMode;
  config_space: ConfigSpace;
  target_id: string;
  dry_run: boolean;
  artifact_ref: SourceRef;
  artifact_hash: Hash;
  expected_previous_hash: Hash | null;
  approval: { approval_id: Id<"iap">; approval_hash: Hash } | null;
  deadline_ms: number;
}

export type RegistrationState =
  | "intent"
  | "applying"
  | "applied"
  | "failed"
  | "unknown"
  | "superseded"
  | "detached";

export interface RegistrationResult {
  request_id: string;
  registration_hash: Hash;
  status: "planned" | "applied" | "no_change" | "conflict" | "rejected" | "failed" | "unknown";
  diff_ref?: SourceRef;
  written_hash?: Hash;
  load_boundary: LoadBoundary;
  requires_trust: boolean;
  trust_state: "ready" | "pending" | "unknown";
  conflicts: Array<{ code: import("./errors.js").RegistrationConflictCode; detail_ref: SourceRef }>;
  approval_ref: Id<"iap"> | null;
  approval_consumption_ref: SourceRef | null;
  evidence_refs: SourceRef[];
  completed_at: number;
}

export interface HostProbeRequest {
  probe_id: Id<"prb">;
  probe_contract_version: "host-probe/2";
  binding: CapabilityBinding;
  host_binding: HostEventBinding;
  /** Host runtime probes name the action; capability probes default to `read_only`. */
  probe_action?: "read_only" | "read_capacity_window" | "read_service_profile" | "confirm_control_plane" | "confirm_human_event" | "confirm_human_setup" | "confirm_candidate";
  capabilities: CapabilityName[];
  probe_mode: "read_only" | "temp_fixture";
  fixture_ref?: SourceRef;
  deadline_ms: number;
}

export interface HostHumanConfirmationRequest {
  schema_version: "rsi.host_human_confirmation_request/1";
  request_id: string;
  confirmation_id: string;
  probe_id: Id<"prb">;
  binding: CapabilityBinding;
  host_binding: HostEventBinding;
  event_identity_key: Hash;
  challenge_nonce: string;
  native_session_id: string;
  deadline_ms: number;
}

export interface HostHumanConfirmationResult {
  state: "confirmed" | "not_confirmed" | "unsupported" | "unknown";
  evidence_ref?: SourceRef;
  confirmed_at?: number;
}

export interface PendingInspectRequest {
  request_id: string;
  host_binding: HostEventBinding;
  boundary_event_ref: SourceRef;
  deadline_ms: number;
}

export interface PendingInspectResult {
  request_id: string;
  state: "none" | "pending" | "unknown";
  signals: Array<{ field: string; state: "none" | "present" | "unknown"; ref?: SourceRef }>;
  fields_observed: string[];
  fields_unknown: string[];
  evidence_refs: string[];
}

export interface HostDeliveryRequest {
  delivery_id: string;
  trigger_event_id?: Id<"trg">;
  host_binding: HostEventBinding;
  boundary_event_ref: SourceRef;
  input_epoch: number;
  goal_version: string;
  content_ref: SourceRef;
  content_hash: Hash;
  nonce: string;
  max_chars: number;
  wait_mode: "bounded" | "strict";
  idempotency_key: string;
  deadline_ms: number;
}

export interface HostDeliveryResult {
  delivery_id: string;
  submitted: "true" | "false" | "unknown";
  host_ack_ref?: SourceRef;
  inclusion: { level: InclusionLevel; evidence_ref?: SourceRef };
  degraded: boolean;
  error?: import("./errors.js").HostAdapterError;
  completed_at: number;
}

export interface LoadCheckRequest {
  request_id: string;
  object_ref: string;
  expected_hash: Hash;
  target_session_ref: string;
  load_boundary: LoadBoundary;
  deadline_ms: number;
}

export interface LoadCheckResult {
  request_id: string;
  state: "loaded" | "pending" | "not_loaded" | "unknown" | "conflict";
  observed_hash?: Hash;
  evidence_refs: string[];
  readback_ref?: SourceRef;
}

/* ------------------------------------------------------------------ */
/* DD-HOST-002 Generation                                              */
/* ------------------------------------------------------------------ */

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

/** FND-owned limits type; HOST only references it structurally. */
export interface ServiceProfileLimits {
  source: "verified_profile" | "unknown";
  profile_hash: Hash;
  request_max_tokens: number;
  question_max_tokens: number;
  max_output_tokens: number;
  rpm: number | null;
  concurrency: number | null;
  pricing:
    | { status: "known"; input_micros_per_million: number; output_micros_per_million: number; fixed_micros: number }
    | { status: "unknown" };
}

export interface ServiceProfile {
  schema_version: "rsi.service_profile/1";
  service_profile_id: string;
  service_profile_key: Hash;
  provider_scope: string;
  limits: ServiceProfileLimits;
  evidence_ref: SourceRef;
}

export interface HostServiceProfileProbeResult {
  schema_version: "rsi.service_profile_probe_result/1";
  binding_key: Hash;
  evidence_ref: SourceRef;
  evidence_hash: Hash;
  provider_scope: string;
  observed_at: number;
}

export interface HostServiceProfileProbePort {
  read(input: {
    request_id: string;
    binding: CapabilityBinding;
    backend_id: string;
    deadline_ms: number;
    signal?: AbortSignal;
  }): Promise<import("../result.js").Result<HostServiceProfileProbeResult, import("../errors.js").ErrorEnvelope>>;
}

export interface HostServiceProfileReadPort {
  select(input: {
    request_id: string;
    binding: CapabilityBinding;
    backend_id: string;
    deadline_ms: number;
    signal?: AbortSignal;
  }): Promise<import("../result.js").Result<ServiceProfile | null, import("../errors.js").ErrorEnvelope>>;
}

export interface ServiceProfileEvidence {
  schema_version: "rsi.service_profile_evidence/1";
  provider_scope: string;
  backend_id: string;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  request_max_tokens: number;
  question_max_tokens: number;
  max_output_tokens: number;
  rpm: number | null;
  concurrency: number | null;
  pricing:
    | { status: "known"; input_micros_per_million: number; output_micros_per_million: number; fixed_micros: number }
    | { status: "unknown" };
  profile_hash: Hash;
  observed_at: number;
}

export interface AdapterBackendSelection {
  state: "available" | "blocked_no_backend";
  backend?: GenerationBackendRef;
  reason?:
    | "no_approved_backend"
    | "capability_unknown"
    | "capability_unsupported"
    | "capability_failed"
    | "budget_unavailable"
    | "isolation_unsupported";
  missing?: GenerationCapabilityBinding[];
  evidence_refs?: string[];
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
    /** Concrete managed-root target templates (Appendix F.4). */
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
  /**
   * Appendix I.4: one retry carries the first parse/schema error so the prompt
   * can name the location and reason. Absent on the first run.
   */
  retry_feedback?: {
    readonly code: string;
    readonly path: string;
    readonly rule: string;
  };
}

export interface GenerationCreateResult {
  state: "created" | "rejected";
  handle_ref?: string;
  host_session_ref?: string;
  child_session_ref?: string;
  isolation_evidence_refs: string[];
  started_at?: number;
  error?: import("./errors.js").HostAdapterError;
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
    /**
     * Shared provider-facing classification, the same shape the generation
     * probe records. `code` stays the legacy CLI diagnostic; `diagnosis.code`
     * is the actionable class (auth_rejected, provider_rejected, ...).
     */
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

export interface HostGenerationAdapterPort {
  selectBackend(
    req: GenerationBackendSelectRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<AdapterBackendSelection>>;
  create(
    req: GenerationCreateRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationCreateResult>>;
  authenticate(
    req: GenerationAuthRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationAuthResult>>;
  cancel(
    req: GenerationCancelRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationCancelResult>>;
  recover(
    req: GenerationRecoverRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationRecoverResult>>;
  readOutput(
    req: GenerationOutputRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationOutputResult>>;
}

export interface HostGenerationPort {
  selectBackend(
    req: GenerationBackendSelectRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationBackendSelection>>;
  create(
    req: GenerationCreateRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationCreateResult>>;
  authenticate(
    req: GenerationAuthRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationAuthResult>>;
  cancel(
    req: GenerationCancelRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationCancelResult>>;
  recover(
    req: GenerationRecoverRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationRecoverResult>>;
  readOutput(
    req: GenerationOutputRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<GenerationOutputResult>>;
}

export interface HostAdapter {
  describe(): AdapterDescriptor;
  register(
    req: RegistrationRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<RegistrationResult>>;
  probe(
    req: HostProbeRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<HostProbeRecord>>;
  normalizeEvent(
    input: NormalizeHostEventInput
  ): import("./errors.js").HostAdapterResult<NormalizedHostEventDraft>;
  confirmHuman?(
    req: HostHumanConfirmationRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<HostHumanConfirmationResult>>;
  inspectPending(
    req: PendingInspectRequest,
    signal?: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<PendingInspectResult>>;
  deliver(
    req: HostDeliveryRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<HostDeliveryResult>>;
  checkLoad(
    req: LoadCheckRequest,
    signal: AbortSignal
  ): Promise<import("./errors.js").HostAdapterResult<LoadCheckResult>>;
  readonly generation?: HostGenerationAdapterPort;
}

/* ------------------------------------------------------------------ */
/* Human proof and install readiness                                   */
/* ------------------------------------------------------------------ */

export type HumanProofPurpose =
  | "replay_approve"
  | "replay_revoke"
  | "replay_reject"
  | "replay_reconcile"
  | "egress_approve"
  | "grant_issue"
  | "grant_revoke"
  | "adapter_install";

export type HumanProofEvidence =
  | {
      schema_version: "rsi.human_proof_evidence/1";
      capability_id: Id<"cap">;
      proof_kind: "host_native_confirmation";
      host_id: HostId;
      host_version: string;
      mode: HostMode;
      config_space: ConfigSpace;
      subject: { kind: "event_key"; event_key: Hash; native_session_id: string };
      confirmed_at: number;
      nonce: string;
    }
  | {
      schema_version: "rsi.human_proof_evidence/1";
      capability_id: Id<"cap">;
      proof_kind: "control_plane_explicit_confirmation";
      subject: { kind: "control_plane"; purpose: HumanProofPurpose; subject_hash: Hash };
      confirmed_at: number;
      nonce: string;
    }
  | {
      /**
       * First interactive confirmation that establishes the
       * `human_interaction_attested` capability itself (design 5.2). It proves
       * the host can render a native yes/no and return the answer; it names no
       * event or control-plane subject.
       */
      schema_version: "rsi.human_proof_evidence/1";
      capability_id: Id<"cap">;
      proof_kind: "capability_establishment";
      host_id: HostId;
      host_version: string;
      mode: HostMode;
      config_space: ConfigSpace;
      binding_key: Hash;
      confirmed_at: number;
      nonce: string;
    }
  | {
      /**
       * Automated-test-only proof. Only a test-mode home accepts it; the
       * verifier rejects it on every production home (design 5.4).
       */
      schema_version: "rsi.human_proof_evidence/1";
      capability_id: Id<"cap">;
      proof_kind: "test_backdoor_confirmation";
      subject: { kind: "control_plane"; purpose: HumanProofPurpose; subject_hash: Hash };
      confirmed_at: number;
      nonce: string;
    };

export type HumanProofVerdict = "verified" | "unverified" | "conflict";

/** FND-owned; HOST only implements this interface. */
export interface OriginProofPort {
  verifyHuman(input: {
    attestation: HumanAttestation;
    host_id: HostId;
    config_space: string;
    native_session_id: string;
    event_key: Hash;
  }): Promise<HumanProofVerdict>;
  verifyControlPlane(input: {
    attestation: HumanAttestation;
    subject_hash: Hash;
    purpose: HumanProofPurpose;
  }): Promise<HumanProofVerdict>;
}

/**
 * Structural shape of the FND `HumanAttestation` consumed by `OriginProofPort`.
 * FND owns the definition; HOST only reads these fields.
 */
export interface HumanAttestation {
  schema_version: "rsi.human_attestation/1";
  kind: "host_verified_interactive_user" | "control_plane_explicit_confirmation" | "test_backdoor_confirmation";
  capability_id: Id<"cap">;
  evidence_ref: SourceRef;
  confirmed_at: number;
}

export interface AdapterInstallSubject {
  schema_version: "rsi.adapter_install_subject/1";
  purpose: "adapter_install";
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  adapter_id: Id<"adp">;
  adapter_version: string;
  implementation_hash: Hash;
  target_id: string;
  artifact_hash: Hash;
  expected_previous_hash: Hash | null;
}

export interface AdapterInstallApprovalView {
  schema_version: "rsi.adapter_install_approval/1";
  approval_id: Id<"iap">;
  state: "active" | "consumed" | "revoked" | "expired";
  bootstrap_state: "preinstall_ready" | "postinstall_ready" | "blocked_no_attested_source" | "unknown";
  subject: AdapterInstallSubject;
  subject_hash: Hash;
  issued_at: number;
  expires_at: number;
  consumed_at?: number;
  consumed_registration_hash?: Hash;
  revoked_at?: number;
  approval_hash: Hash;
}

export interface HostInstallApprovalPort {
  get(input: {
    approval_id: Id<"iap">;
    expected_subject_hash: Hash;
  }): Promise<import("../result.js").Result<AdapterInstallApprovalView, import("../errors.js").ErrorEnvelope>>;
  consume(input: {
    approval_id: Id<"iap">;
    expected_approval_hash: Hash;
    registration_hash: Hash;
    request_id: string;
    idempotency_key: string;
  }): Promise<
    import("../result.js").Result<
      { approval: AdapterInstallApprovalView; consumption_ref: SourceRef },
      import("../errors.js").ErrorEnvelope
    >
  >;
}

export interface PreinstallHostContext {
  schema_version: "rsi.preinstall_host_context/1";
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  root_id: string;
  root_identity_ref: SourceRef;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  construction_path: ConstructionPath;
  execution_environment: ExecutionEnvironment;
  read_at: number;
}

export interface PreinstallHostContextPort {
  read(input: {
    host_id: HostId;
    mode: HostMode;
    config_space: ConfigSpace;
    deadline_ms: number;
    signal?: AbortSignal;
  }): Promise<import("./errors.js").HostAdapterResult<PreinstallHostContext>>;
}

export interface HostNativeControlPlanePort {
  confirmInstall(input: {
    request_id: string;
    subject_hash: Hash;
    binding_key: Hash;
    challenge_nonce: string;
    deadline_ms: number;
    signal?: AbortSignal;
  }): Promise<
    import("./errors.js").HostAdapterResult<{
      state: "confirmed" | "not_confirmed" | "unsupported" | "unknown";
      evidence_ref?: SourceRef;
      confirmed_at?: number;
    }>
  >;
}

export interface AdapterInstallReadinessView {
  active_binding: "none" | "adapter" | "unknown";
  host_contract:
    | {
        status: "verified" | "unverified" | "unknown";
        roundtrip: boolean;
        probe_passed: boolean;
        evidence_ref: SourceRef;
      }
    | null;
  product_adapter:
    | {
        active: boolean;
        adapter_version: string | null;
        implementation_hash: Hash | null;
        evidence_ref: SourceRef;
      }
    | null;
}

export interface AdapterInstallReadinessPort {
  get(input: {
    request_id: string;
    subject: AdapterInstallSubject;
    subject_hash: Hash;
  }): Promise<import("../result.js").Result<AdapterInstallReadinessView, import("../errors.js").ErrorEnvelope>>;
}

/** `VersionBinding` is re-exported for consumers that only import HOST types. */
export type { VersionBinding };
